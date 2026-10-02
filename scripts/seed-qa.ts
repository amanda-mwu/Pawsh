import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { builtInRoles } from "@pawsh/domain";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import { provisionBusinessCatalog } from "../src/domain/catalog-seed.js";
import { hashPassword, validateNewPassword } from "../src/security/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
const marker = process.env.PAWSH_QA_DATABASE_MARKER;
const password = process.env.PAWSH_QA_PASSWORD;

if (process.env.PAWSH_ALLOW_QA_SEED !== "true") {
  throw new Error("QA seed requires PAWSH_ALLOW_QA_SEED=true");
}
if (process.env.NODE_ENV === "production") throw new Error("QA seed is disabled in production");
if (!databaseUrl || !marker || marker.length < 3 || !databaseUrl.toLowerCase().includes(marker.toLowerCase())) {
  throw new Error("DATABASE_URL must contain the explicit PAWSH_QA_DATABASE_MARKER");
}
const target = new URL(databaseUrl);
if (/(^|[.-])(prod|production)([.-]|$)/i.test(target.hostname) || /prod(uction)?/i.test(target.pathname)) {
  throw new Error("QA seed refuses production-like database targets");
}
if (!password) throw new Error("PAWSH_QA_PASSWORD must be supplied securely");
await validateNewPassword(password);

console.log(`QA seed target: ${target.hostname}${target.pathname} (${process.env.NODE_ENV ?? "development"})`);

/**
 * A DETERMINISTIC HUMAN VISUAL QA DATASET.
 *
 * One salon, two groomers, four households and one day - today, in the salon's own timezone -
 * laid out so every state a reviewer has to look at sits on the calendar the moment it opens:
 * scheduled, checked in, in service, finished and unpaid, finished and settled by two tenders,
 * cancelled, two overlapping visits, and a block on each groomer. One booking sits tomorrow so a
 * future-dated Check In can be confirmed.
 *
 * Two layers, deliberately:
 *
 *   1. SETTINGS-SCREEN FACTS are written directly in one transaction: the business, its accounts,
 *      the location, opening hours and each groomer's rota. Those are what an owner types into
 *      Settings, and the business itself is provisioned by `provisionBusinessCatalog`, the same
 *      authority a real signup runs, so roles, tax, payment methods and the default catalog are
 *      the product's own.
 *
 *   2. EVERYTHING WITH A LIFECYCLE OR MONEY goes through the application's real routes, driven
 *      in-process as the owner: the catalog curation, clients, pets, credit grants, blocks,
 *      bookings, transitions, the service note, checkout and payments. No appointment, invoice,
 *      payment or ledger row is written by hand, so what QA sees is what the product produces.
 *
 * It expects an EMPTY, freshly migrated database and refuses to touch one that already holds the
 * QA tenant rather than writing half a second copy beside it.
 */

const businessName = "Pawsh QA Grooming";
const ownerEmail = "owner@pawsh-test.example";

/**
 * Open every day of the week, and both groomers in every day the salon is, so the calendar opens
 * on today with both lanes populated whatever day the seed is run. Weekday 0 is Sunday, matching
 * `business_hours.weekday` and `employee_working_hours.weekday`.
 */
const allWeekdays = [0, 1, 2, 3, 4, 5, 6] as const;
const salonHours = { start: "08:00", end: "18:00" } as const;
const groomerHours = { start: "08:00", end: "17:00" } as const;

/**
 * The QA staff, named by the BUILT-IN ROLE each one holds. The roles come from the same
 * provisioning path a real signup uses; this map only says who holds which.
 */
const builtInRoleNames = new Set(builtInRoles.map((role) => role.name));
const memberDefinitions = [
  ["manager@pawsh-test.example", "Manager", "Marcus Manager"],
  ["reception@pawsh-test.example", "Receptionist", "Riley Reception"],
  ["grace@pawsh-test.example", "Groomer", "Grace Groomer"],
  ["gabriel@pawsh-test.example", "Groomer", "Gabriel Groomer"]
] as const;
for (const [, roleName] of memberDefinitions) {
  if (!builtInRoleNames.has(roleName)) throw new Error(`QA seed names an unknown built-in role: ${roleName}`);
}

/** The curated catalog: exactly these six stay active, each with its own price and duration. */
const catalog = [
  { name: "Bath", category: "DOG_BASE", durationMinutes: 45, priceMinor: 4500 },
  { name: "Full Groom", category: "DOG_BASE", durationMinutes: 90, priceMinor: 6500 },
  { name: "Nail Trim", category: "A_LA_CARTE", durationMinutes: 15, priceMinor: 1500 },
  { name: "De-shedding", category: "A_LA_CARTE", durationMinutes: 60, priceMinor: 4000 },
  { name: "Teeth Brushing", category: "A_LA_CARTE", durationMinutes: 10, priceMinor: 1200 },
  { name: "Ear Cleaning", category: "A_LA_CARTE", durationMinutes: 20, priceMinor: 1000 }
] as const;
type ServiceName = (typeof catalog)[number]["name"];
const graceServices: ServiceName[] = ["Bath", "Full Groom", "Nail Trim", "Teeth Brushing"];
const gabrielServices: ServiceName[] = catalog.map((service) => service.name);

/** Civil-date arithmetic on `YYYY-MM-DD` text; `Date.UTC` is only a calendar calculator here. */
const dateTextPattern = /^\d{4}-\d{2}-\d{2}$/;
function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const sql = postgres(databaseUrl, { transform: postgres.camel });
const passwordHash = await hashPassword(password);

/* ---------------------------------------------------------------------------------------------
 * Layer 1: the settings an owner types in.
 * ------------------------------------------------------------------------------------------- */
const setup = await sql.begin(async (tx) => {
  const [existing] = await tx<{ id: string }[]>`select id from businesses where name=${businessName} limit 1`;
  if (existing) {
    throw new Error(`QA seed refuses: "${businessName}" already exists in this database. `
      + "The scenario is written once into an empty, freshly migrated database; drop and recreate it to reseed.");
  }
  async function ensureUser(email: string, displayName: string): Promise<string> {
    const [user] = await tx<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,email_verified_at,display_name)
      values (${email},${email},${passwordHash},now(),${displayName})
      on conflict (normalized_email) do update
        set email=excluded.email,password_hash=excluded.password_hash,display_name=excluded.display_name
      returning id
    `;
    return user!.id;
  }
  const ownerId = await ensureUser(ownerEmail, "Olivia Owner");
  const [business] = await tx<{ id: string }[]>`
    insert into businesses(name,currency,tax_rate_basis_points,reminder_lead_minutes)
    values (${businessName},'USD',825,1440) returning id
  `;
  const businessId = business!.id;
  await tx`select set_config('app.business_id',${businessId},true)`;
  await provisionBusinessCatalog(tx, businessId);
  const roleIds = new Map(
    (await tx<{ id: string; name: string }[]>`
      select id,name from roles where business_id=${businessId} and built_in
    `).map((role) => [role.name, role.id])
  );
  // An owner holds no role: owner authority is `is_owner`.
  await tx`
    insert into business_memberships(business_id,user_id,is_owner,role_id,status)
    values (${businessId},${ownerId},true,null,'active')
  `;
  const [location] = await tx<{ id: string; timezone: string }[]>`
    insert into locations(business_id,name,address,timezone)
    values (${businessId},'Pawsh QA Salon','123 Test Avenue, Pasadena, CA 91101','America/Los_Angeles')
    returning id,timezone
  `;
  for (const weekday of allWeekdays) {
    await tx`
      insert into business_hours(business_id,location_id,weekday,start_time,end_time)
      values (${businessId},${location!.id},${weekday},${salonHours.start},${salonHours.end})
    `;
  }
  const employees = new Map<string, string>();
  for (const [email, roleName, displayName] of memberDefinitions) {
    const roleId = roleIds.get(roleName);
    if (!roleId) throw new Error(`QA seed could not find the built-in role ${roleName}`);
    const userId = await ensureUser(email, displayName);
    const [membership] = await tx<{ id: string }[]>`
      insert into business_memberships(business_id,user_id,role_id,status)
      values (${businessId},${userId},${roleId},'active') returning id
    `;
    if (roleName !== "Groomer") continue;
    const [employee] = await tx<{ id: string }[]>`
      insert into employees(business_id,membership_id,display_name)
      values (${businessId},${membership!.id},${displayName}) returning id
    `;
    for (const weekday of allWeekdays) {
      await tx`
        insert into employee_working_hours(business_id,employee_id,weekday,start_time,end_time)
        values (${businessId},${employee!.id},${weekday},${groomerHours.start},${groomerHours.end})
      `;
    }
    employees.set(displayName, employee!.id);
  }

  /**
   * The scenario day. `QA_ANCHOR_DATE` may pin it - a civil date, or an instant resolved to the
   * location's own date (what `npm run db:seed` passes) - and otherwise it is today in the salon's
   * timezone, which is what the calendar opens on.
   */
  const anchorInput = process.env.QA_ANCHOR_DATE?.trim() || null;
  const anchorIsCivilDate = anchorInput !== null && dateTextPattern.test(anchorInput);
  if (anchorInput && !anchorIsCivilDate && Number.isNaN(Date.parse(anchorInput))) {
    throw new Error("QA_ANCHOR_DATE must be a civil date (YYYY-MM-DD) or a parsable instant");
  }
  const anchorInstant = anchorInput && !anchorIsCivilDate ? new Date(anchorInput) : null;
  const [clock] = await tx<{ localToday: string; localAnchor: string | null }[]>`
    select to_char((now() at time zone ${location!.timezone})::date,'YYYY-MM-DD') as local_today,
      to_char((${anchorInstant}::timestamptz at time zone ${location!.timezone})::date,'YYYY-MM-DD')
        as local_anchor
  `;
  const day = anchorIsCivilDate ? anchorInput! : clock!.localAnchor ?? clock!.localToday;
  return {
    businessId, locationId: location!.id, timezone: location!.timezone, day,
    graceId: employees.get("Grace Groomer")!, gabrielId: employees.get("Gabriel Groomer")!
  };
});
await sql.end();

/* ---------------------------------------------------------------------------------------------
 * Layer 2: everything else, through the product's own routes, as the owner.
 * ------------------------------------------------------------------------------------------- */
const appOrigin = "http://localhost:3000";
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl,
  SESSION_SECRET: randomBytes(32).toString("hex"),
  APP_ORIGIN: appOrigin, SMTP_PORT: 587, SMTP_SECURE: false
};
const db = createDatabase(config);
const app = await createApp(config, db, { runWorker: false, serveStatic: false });
await app.ready();

let sessionCookie = "";
type Json = Record<string, unknown>;
async function call<T = Json>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown): Promise<T> {
  const response = await app.inject({
    method, url,
    headers: { cookie: sessionCookie, origin: appOrigin, "idempotency-key": randomUUID() },
    ...(payload === undefined ? {} : { payload: payload as Json })
  });
  if (response.statusCode >= 300) {
    throw new Error(`QA seed: ${method} ${url} answered ${response.statusCode}: ${response.body}`);
  }
  return (response.body ? response.json() : {}) as T;
}

const summary: string[] = [];
try {
  const login = await app.inject({
    method: "POST", url: "/api/auth/login", headers: { origin: appOrigin },
    payload: { email: ownerEmail, password }
  });
  if (login.statusCode !== 200) throw new Error(`QA seed could not sign in as the owner: ${login.body}`);
  sessionCookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;

  // --- The catalog, curated the way an owner would in Settings. ------------------------------
  // Provisioned services whose names match are reused and repriced; the rest are created; every
  // other provisioned service is deactivated, so the active catalog is exactly these six.
  const provisioned = await call<{ id: string; name: string; active: boolean }[]>("GET", "/api/services");
  const services = new Map<ServiceName, string>();
  for (const service of catalog) {
    const body = {
      name: service.name, description: null, baseDurationMinutes: service.durationMinutes,
      basePriceMinor: service.priceMinor, category: service.category, pricingMode: "FIXED",
      priceConfirmationRequired: false, active: true
    };
    const match = provisioned.find((row) => row.name.toLowerCase() === service.name.toLowerCase());
    const saved = match
      ? await call<{ id: string }>("PUT", `/api/services/${match.id}`, body)
      : await call<{ id: string }>("POST", "/api/services", body);
    services.set(service.name, saved.id);
  }
  const keep = new Set(services.values());
  for (const row of provisioned) {
    if (row.active && !keep.has(row.id)) await call("DELETE", `/api/services/${row.id}`);
  }
  const serviceIds = (names: ServiceName[]): string[] => names.map((name) => services.get(name)!);
  await call("PUT", `/api/employees/${setup.graceId}`, { serviceIds: serviceIds(graceServices) });
  await call("PUT", `/api/employees/${setup.gabrielId}`, { serviceIds: serviceIds(gabrielServices) });

  // --- Clients and pets. ----------------------------------------------------------------------
  async function client(body: Json): Promise<string> {
    return (await call<{ id: string }>("POST", "/api/customers", body)).id;
  }
  async function pet(body: Json): Promise<string> {
    return (await call<{ id: string }>("POST", "/api/pets", { species: "dog", ...body })).id;
  }
  const sophia = await client({
    firstName: "Sophia", lastName: "Chen", phone: "(626) 555-0143",
    email: "sophia.chen@pawsh-test.example",
    address: "418 Linden Court, Pasadena, CA 91106", preferredContactMethod: "phone"
  });
  const avery = await client({
    firstName: "Avery", lastName: "Thompson", phone: "(626) 555-0172",
    email: "avery.thompson@pawsh-test.example", preferredContactMethod: "email"
  });
  const emma = await client({
    firstName: "Emma", lastName: "Johnson", phone: "(626) 555-0118",
    email: "emma.johnson@pawsh-test.example", preferredContactMethod: "email"
  });
  const noah = await client({
    firstName: "Noah", lastName: "Williams", phone: "(626) 555-0164",
    email: "noah.williams@pawsh-test.example", preferredContactMethod: "phone"
  });
  const rocky = await pet({
    customerId: sophia, name: "Rocky", breed: "Australian Shepherd", dateOfBirth: "2020-05-18",
    weightOunces: 832, sex: "Male", coatNotes: "Thick double coat; heavy undercoat in the trousers.",
    groomingPreferences: "Tidy all over, feathering kept natural."
  });
  const mochi = await pet({
    customerId: sophia, name: "Mochi", breed: "Shih Tzu", dateOfBirth: "2022-01-10",
    weightOunces: 208, sex: "Female", groomingPreferences: "Short teddy-bear cut, round face."
  });
  const daisy = await pet({
    customerId: avery, name: "Daisy", breed: "Cocker Spaniel", dateOfBirth: "2019-03-14",
    weightOunces: 400, sex: "Female", groomingPreferences: "Clean feet and ears; skirt left long."
  });
  const charlie = await pet({
    customerId: avery, name: "Charlie", breed: "Cavalier King Charles Spaniel",
    dateOfBirth: "2021-08-02", weightOunces: 256, sex: "Male", behaviorNotes: "Calm; loves the dryer."
  });
  const luna = await pet({
    customerId: emma, name: "Luna", breed: "Goldendoodle", dateOfBirth: "2021-06-12",
    weightOunces: 720, sex: "Female", coatNotes: "Mats behind the ears.",
    groomingPreferences: "Half-inch body, rounded head."
  });
  const rabiesGiven = addDays(setup.day, -120);
  const boba = await pet({
    customerId: noah, name: "Boba", breed: "Pomeranian", dateOfBirth: "2020-11-05",
    weightOunces: 112, sex: "Male", groomingPreferences: "Scissor trim only; never shave the coat.",
    safetyAlerts: "Snaps when his back feet are handled. Two-person hold for nails; muzzle on hand.",
    rabiesVaccinationDate: rabiesGiven, vaccinationExpiresOn: addDays(rabiesGiven, 365 * 3),
    rabiesCertificateReference: "RAB-QA-30417", rabiesVerificationStatus: "staff_verified",
    rabiesVerificationMethod: "document_review", rabiesVerificationDate: addDays(rabiesGiven, 2)
  });

  // --- Client credit, granted through the ledger. ---------------------------------------------
  await call("POST", `/api/customers/${sophia}/credit`,
    { kind: "grant", amountMinor: 15000, reason: "Gift certificate redeemed onto account" });
  await call("POST", `/api/customers/${avery}/credit`,
    { kind: "grant", amountMinor: 6000, reason: "Prepaid bath package" });

  // --- Blocks first, so no booking can land in them. -----------------------------------------
  const location = await (async () => {
    const reader = postgres(databaseUrl, { transform: postgres.camel });
    const [row] = await reader<{ version: number }[]>`select version from locations where id=${setup.locationId}`;
    await reader.end();
    return row!;
  })();
  const at = (date: string, time: string): string => `${date}T${time}`;
  async function block(employeeId: string, start: string, end: string, reason: string): Promise<void> {
    await call("POST", "/api/blocked-times", {
      employeeId, locationId: setup.locationId, localStart: at(setup.day, start),
      localEnd: at(setup.day, end), expectedLocationVersion: location.version, reason
    });
  }
  await block(setup.graceId, "12:00", "12:30", "Lunch");
  await block(setup.gabrielId, "12:30", "13:15", "Lunch");

  // --- Bookings. --------------------------------------------------------------------------------
  interface Visit { id: string; date: string; time: string; groomer: string; pet: string; services: string }
  const visits: Visit[] = [];
  async function book(options: {
    date?: string; time: string; groomer: "Grace" | "Gabriel"; customerId: string;
    petId: string; petName: string; services: ServiceName[]; notes?: string; overlap?: boolean;
  }): Promise<string> {
    const date = options.date ?? setup.day;
    const created = await call<{ id: string }>("POST", "/api/appointments", {
      locationId: setup.locationId, customerId: options.customerId, petId: options.petId,
      employeeId: options.groomer === "Grace" ? setup.graceId : setup.gabrielId,
      localStart: at(date, options.time), expectedLocationVersion: location.version,
      serviceIds: serviceIds(options.services), notes: options.notes ?? null,
      ...(options.overlap
        ? { overrideConflict: true, overrideReason: "Ear clean squeezed in during the de-shed dry time" }
        : {})
    });
    const id = created.id;
    visits.push({ id, date, time: options.time, groomer: options.groomer, pet: options.petName,
      services: options.services.join(" + ") });
    return id;
  }
  async function move(id: string, status: string, reason?: string): Promise<void> {
    await call("POST", `/api/appointments/${id}/transition`, { status, ...(reason ? { reason } : {}) });
  }

  // Grace.
  await book({ time: "09:00", groomer: "Grace", customerId: sophia, petId: rocky, petName: "Rocky",
    services: ["Full Groom"], notes: "Owner will text when she is ten minutes away." });
  const mochiVisit = await book({ time: "10:30", groomer: "Grace", customerId: sophia, petId: mochi,
    petName: "Mochi", services: ["Bath", "Nail Trim"] });
  const daisyVisit = await book({ time: "13:00", groomer: "Grace", customerId: avery, petId: daisy,
    petName: "Daisy", services: ["Full Groom", "Teeth Brushing"] });
  const charlieVisit = await book({ time: "15:00", groomer: "Grace", customerId: avery,
    petId: charlie, petName: "Charlie", services: ["Bath"] });
  // Gabriel.
  const lunaVisit = await book({ time: "09:30", groomer: "Gabriel", customerId: emma, petId: luna,
    petName: "Luna", services: ["Full Groom"] });
  await book({ time: "11:00", groomer: "Gabriel", customerId: noah, petId: boba, petName: "Boba",
    services: ["Bath", "Nail Trim"], notes: "First visit. Read the safety alert before nails." });
  await book({ time: "14:00", groomer: "Gabriel", customerId: sophia, petId: rocky, petName: "Rocky",
    services: ["De-shedding"], notes: "Seasonal blow-out; Grace does not de-shed." });
  await book({ time: "14:30", groomer: "Gabriel", customerId: sophia, petId: mochi, petName: "Mochi",
    services: ["Ear Cleaning"], overlap: true });
  const cancelledVisit = await book({ time: "15:30", groomer: "Gabriel", customerId: emma,
    petId: luna, petName: "Luna", services: ["Nail Trim"] });
  // Tomorrow.
  await book({ date: addDays(setup.day, 1), time: "10:00", groomer: "Grace", customerId: sophia,
    petId: rocky, petName: "Rocky", services: ["Bath"], notes: "Future check-in test" });

  // --- Lifecycle. -------------------------------------------------------------------------------
  await move(mochiVisit, "checked_in");
  await call("PATCH", `/api/appointments/${mochiVisit}/operations`, {
    operationalNotes: "Light matting behind both ears - brushed out, no shave needed. Nails were long."
  });
  await move(lunaVisit, "checked_in");
  await move(lunaVisit, "in_service");
  for (const id of [daisyVisit, charlieVisit]) {
    await move(id, "checked_in");
    await move(id, "completed");
  }
  await move(cancelledVisit, "cancelled", "Emma called: the vet trimmed Luna's nails this morning.");

  // --- Money. -----------------------------------------------------------------------------------
  // Daisy: invoiced and left unpaid, for Take Payment / void / repay during QA.
  const daisyInvoice = await call<{ id: string; totalMinor: number }>("POST",
    `/api/appointments/${daisyVisit}/checkout`, { discountMinor: 0, tipMinor: 0, appliedDiscountIds: [] });
  // Charlie: one invoice settled by $20 of client credit and the remainder in cash.
  const charlieInvoice = await call<{ id: string; totalMinor: number }>("POST",
    `/api/appointments/${charlieVisit}/checkout`, { discountMinor: 0, tipMinor: 0, appliedDiscountIds: [] });
  const creditPart = 2000;
  await call("POST", `/api/invoices/${charlieInvoice.id}/payments`,
    { amountMinor: creditPart, expectedBalanceMinor: charlieInvoice.totalMinor, method: "client_credit" });
  await call("POST", `/api/invoices/${charlieInvoice.id}/payments`, {
    amountMinor: charlieInvoice.totalMinor - creditPart,
    expectedBalanceMinor: charlieInvoice.totalMinor - creditPart, method: "cash"
  });

  // --- What was written, read back from the product. ---------------------------------------
  const money = (minor: number): string => `$${(minor / 100).toFixed(2)}`;
  summary.push(`Scenario day: ${setup.day} (${setup.timezone})   tomorrow: ${addDays(setup.day, 1)}`);
  for (const visit of visits) {
    const { status } = await call<{ status: string }>("GET", `/api/appointments/${visit.id}`);
    summary.push(`  ${visit.date} ${visit.time}  ${visit.groomer.padEnd(8)}${status.padEnd(11)}`
      + `${visit.pet.padEnd(8)}${visit.services.padEnd(29)}${visit.id}`);
  }
  summary.push("  Blocks: Grace 12:00-12:30, Gabriel 12:30-13:15");
  summary.push(`  Daisy invoice ${daisyInvoice.id}: ${money(daisyInvoice.totalMinor)} open`);
  summary.push(`  Charlie invoice ${charlieInvoice.id}: ${money(charlieInvoice.totalMinor)} = `
    + `${money(creditPart)} client credit + ${money(charlieInvoice.totalMinor - creditPart)} cash`);
  for (const [name, id] of [["Sophia Chen", sophia], ["Avery Thompson", avery], ["Emma Johnson", emma], ["Noah Williams", noah]] as const) {
    const credit = await call<{ balanceMinor: number }>("GET", `/api/customers/${id}/credit`);
    summary.push(`  Credit ${name}: ${money(credit.balanceMinor)}`);
  }
} finally {
  await app.close();
  await db.end();
}

console.log("Pawsh manual QA seed complete");
for (const line of summary) console.log(line);
