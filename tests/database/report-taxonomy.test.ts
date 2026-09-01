import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { permissionGroups, unenforcedPermissions } from "@pawsh/domain";
import { createRole } from "../support/roles.js";

/**
 * The report and dashboard taxonomy: enforced where it has teeth, honest where it does not.
 *
 * WITHHOLDING IS ASSERTED AS AN ABSENT KEY IN THE JSON, never as a hidden panel. A figure the
 * server sends and the browser declines to draw has not been withheld from anybody - it is sitting
 * in the network tab, readable by exactly the person it was meant to be kept from. So every
 * negative assertion is `not.toHaveProperty`, and each one is paired with a positive case proving
 * the key really does appear when the permission is held - otherwise the test would pass just as
 * well against an endpoint that had quietly stopped returning that field at all.
 *
 * The other half is the part that is easy to fake. A permission with no feature behind it must
 * gate NOTHING. Pawsh has no payroll, no time clock, no product catalogue and no commission model,
 * and those switches exist so they are already granted to the right people on the day those
 * features land. A role holding none of them must receive an identical payload, or the catalog's
 * `enforced: false` is a claim nobody checked.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "report-taxonomy-test-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};
const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

const everyReportKey = [
  "totals", "revenue", "employees", "paymentMethods", "salesItems", "paymentStatus"
];

describeDatabase("report and dashboard taxonomy", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  const ownerEmail = `taxonomy-owner-${suffix}@example.test`;
  let ownerCookie: string, businessId: string;
  let seq = 0;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();
    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: ownerEmail, password: "correct horse taxonomy own", businessName: `Taxonomy ${suffix}` }
    });
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;
    // One employee, so the per-groomer rows are not an empty list. A vacuous loop would let the
    // tip-withholding assertion below pass without ever inspecting a row.
    await db`
      insert into employees (business_id, display_name) values (${businessId}, ${`Groomer ${suffix}`})
    `;
  });

  afterAll(async () => { await app.close(); await db.end(); });

  /** A member session holding exactly `permissions` and nothing else. */
  async function sessionWith(permissions: readonly string[]): Promise<string> {
    seq += 1;
    const email = `taxonomy-${seq}-${suffix}@example.test`;
    const roleId = await createRole(app, ownerCookie, `Taxonomy ${seq} ${suffix}`, permissions);
    const invitation = await app.inject({
      method: "POST", url: "/api/members/invitations", headers: { cookie: ownerCookie },
      payload: { email, roleId }
    });
    const token = new URL(invitation.json().acceptancePath, "http://localhost").searchParams.get("invite");
    return cookie(await app.inject({
      method: "POST", url: "/api/auth/invitations/accept",
      payload: { token, password: "correct horse taxonomy member" }
    }));
  }

  const reports = async (sessionCookie: string) =>
    await app.inject({ method: "GET", url: "/api/reports", headers: { cookie: sessionCookie } });
  const dashboard = async (sessionCookie: string) =>
    await app.inject({ method: "GET", url: "/api/dashboard", headers: { cookie: sessionCookie } });

  it("splits the dashboard off reports.view onto dashboard.view", async () => {
    // Holding the reports master is no longer enough to reach the dashboard...
    const reportsOnly = await sessionWith(["reports.view"]);
    expect((await dashboard(reportsOnly)).statusCode).toBe(403);
    expect((await reports(reportsOnly)).statusCode).toBe(200);
    // ...and holding the dashboard master is no longer enough to reach reports.
    const dashboardOnly = await sessionWith(["dashboard.view", "dashboard.summary"]);
    expect((await dashboard(dashboardOnly)).statusCode).toBe(200);
    expect((await reports(dashboardOnly)).statusCode).toBe(403);
  });

  it("omits every gated figure from the dashboard, and returns them when granted", async () => {
    const bare = await sessionWith(["dashboard.view"]);
    const withheld = (await dashboard(bare)).json();
    for (const key of ["todaysAppointments", "upcomingAppointments", "completedToday",
      "todaysSalesMinor", "todaysRefundedMinor", "outstandingMinor"]) {
      expect(withheld, key).not.toHaveProperty(key);
    }

    const summaryOnly = (await dashboard(await sessionWith(["dashboard.view", "dashboard.summary"]))).json();
    expect(summaryOnly).toHaveProperty("todaysAppointments");
    // Counting appointments is not seeing money.
    expect(summaryOnly).not.toHaveProperty("todaysSalesMinor");
    expect(summaryOnly).not.toHaveProperty("outstandingMinor");

    const revenueOnly = (await dashboard(await sessionWith(["dashboard.view", "dashboard.revenue"]))).json();
    expect(revenueOnly).toHaveProperty("todaysSalesMinor");
    // Refunds travel with revenue: releasing "collected" while withholding "given back" would
    // report a figure this endpoint's own comment calls misleading.
    expect(revenueOnly).toHaveProperty("todaysRefundedMinor");
    expect(revenueOnly).not.toHaveProperty("outstandingMinor");

    const statusOnly = (await dashboard(await sessionWith(["dashboard.view", "dashboard.payment_status"]))).json();
    expect(statusOnly).toHaveProperty("outstandingMinor");
    expect(statusOnly).not.toHaveProperty("todaysSalesMinor");
  });

  it("omits every gated section from the report, and returns them when granted", async () => {
    const bare = (await reports(await sessionWith(["reports.view"]))).json();
    for (const key of everyReportKey) expect(bare, key).not.toHaveProperty(key);
    // The caller is still through the door, and ungated content still arrives.
    expect(bare).toHaveProperty("localDate");
    expect(bare).toHaveProperty("services");

    const full = (await reports(await sessionWith([
      "reports.view", "dashboard.summary", "dashboard.revenue", "dashboard.revenue_by_staff",
      "dashboard.tips_by_staff", "dashboard.sales_items", "dashboard.payment_status",
      "dashboard.sales_by_method"
    ]))).json();
    for (const key of everyReportKey) expect(full, key).toHaveProperty(key);
  });

  it("lets either the Dashboard or the Sales permission release shared data", async () => {
    // Per-groomer money answers a Dashboard question and a Sales question, and the same rows
    // answer both. Requiring both would deny a role that had been given the honest half.
    for (const permission of ["dashboard.revenue_by_staff", "sales.by_staff"]) {
      const payload = (await reports(await sessionWith(["reports.view", permission]))).json();
      expect(payload, permission).toHaveProperty("employees");
    }
    for (const permission of ["dashboard.sales_by_method", "sales.by_payment_method"]) {
      const payload = (await reports(await sessionWith(["reports.view", permission]))).json();
      expect(payload, permission).toHaveProperty("paymentMethods");
    }
  });

  it("treats tips by staff as its own switch inside the staff rows", async () => {
    const withoutTips = (await reports(await sessionWith(
      ["reports.view", "dashboard.revenue_by_staff"]
    ))).json();
    expect(withoutTips.employees.length).toBeGreaterThan(0);
    for (const row of withoutTips.employees) {
      expect(row).toHaveProperty("revenueMinor");
      // Who earned what is a different question from who was tipped what.
      expect(row).not.toHaveProperty("tipMinor");
    }
    const withTips = (await reports(await sessionWith(
      ["reports.view", "dashboard.revenue_by_staff", "dashboard.tips_by_staff"]
    ))).json();
    for (const row of withTips.employees) expect(row).toHaveProperty("tipMinor");
  });

  it("lets no unenforced permission change a single byte of either payload", async () => {
    const base = ["reports.view", "dashboard.view", "dashboard.summary", "dashboard.revenue",
      "dashboard.revenue_by_staff", "dashboard.tips_by_staff", "dashboard.sales_items",
      "dashboard.payment_status", "dashboard.sales_by_method"];
    const withoutInert = await sessionWith(base);
    const withInert = await sessionWith([...base, ...unenforcedPermissions]);
    expect((await reports(withInert)).json()).toEqual((await reports(withoutInert)).json());
    expect((await dashboard(withInert)).json()).toEqual((await dashboard(withoutInert)).json());
  });

  it("publishes the taxonomy in the catalog with honest enforcement flags", async () => {
    const catalog = (await app.inject({
      method: "GET", url: "/api/permissions", headers: { cookie: ownerCookie }
    })).json();
    const groups = Object.fromEntries(
      catalog.groups.map((group: { id: string }) => [group.id, group])
    );
    expect(groups.dashboard.masterKey).toBe("dashboard.view");
    // Payroll and Sales hang off the REPORT master, not the dashboard one.
    expect(groups.payroll.masterKey).toBe("reports.view");
    expect(groups.sales.masterKey).toBe("reports.view");
    expect(groups.dashboard.permissions.map((entry: { label: string }) => entry.label))
      .toContain("Commission by staff");

    const flags = new Map<string, boolean>();
    for (const group of catalog.groups) {
      for (const entry of group.permissions) flags.set(entry.key, entry.enforced);
    }
    // Every permission the domain calls inert is reported inert, and nothing else is.
    for (const [key, enforced] of flags) {
      expect(enforced, key).toBe(!unenforcedPermissions.has(key as never));
    }
    expect(flags.get("dashboard.commission_by_staff")).toBe(false);
    expect(flags.get("payroll.report")).toBe(false);
    expect(flags.get("sales.by_payment_method")).toBe(true);
    expect(flags.get("sales.by_staff")).toBe(true);
  });

  it("keeps the owner seeing everything", async () => {
    // Owners hold the whole tuple by construction, so the taxonomy must be invisible to them.
    const payload = (await reports(ownerCookie)).json();
    for (const key of everyReportKey) expect(payload, key).toHaveProperty(key);
    expect((await dashboard(ownerCookie)).json()).toHaveProperty("todaysSalesMinor");
    // And the catalog covers the whole taxonomy, so nothing is grantable the editor cannot show.
    const catalogued = permissionGroups.flatMap((group) => group.permissions);
    expect(catalogued).toContain("payroll.special_service_rates");
    expect(catalogued).toContain("sales.by_client");
  });
});
