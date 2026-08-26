import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { hashPassword } from "../../src/security/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test",
  DOCUMENT_STORAGE_ADAPTER: "memory",
  PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "client-agreements-test-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:3000",
  SMTP_PORT: 587,
  SMTP_SECURE: false
};
const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

interface AgreementItem {
  agreementId: string | null;
  templateId: string;
  name: string;
  body: string;
  required: boolean;
  active: boolean;
  templateVersion: number;
  status: "not_sent" | "sent" | "signed";
  sentAt: string | null;
  sendCount: number;
  lastSentChannel: string | null;
  signedAt: string | null;
  signedName: string | null;
  signatureMethod: string | null;
  signatureNote: string | null;
  signedTemplateVersion: number | null;
  recordedByName: string | null;
  lastSend: { channel: string; deliveryStatus: string } | null;
}

interface AgreementPanel {
  customerId: string;
  items: AgreementItem[];
  summary: {
    total: number;
    requiredTotal: number;
    signedTotal: number;
    unsignedRequiredTotal: number;
    unsignedRequiredTemplateIds: string[];
    needsAttention: boolean;
  };
  delivery: {
    supportedChannels: string[];
    channels: { channel: string; available: boolean; reason: string; detail: string | null; destination: string | null }[];
  };
  customerArchived: boolean;
}

describeDatabase("client agreements", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();
  const origin = config.APP_ORIGIN;
  const ownerEmail = `agreements-owner-${suffix}@example.test`;
  const ownerPassword = "correct horse client agreements battery";

  let ownerCookie: string;
  let viewerCookie: string;
  let editorCookie: string;
  let strangerCookie: string;
  let settingsOnlyCookie: string;
  let otherOwnerCookie: string;

  let businessId: string;
  let otherBusinessId: string;
  let customerId: string;
  let quietCustomerId: string;
  let archivedCustomerId: string;
  let otherCustomerId: string;

  let requiredTemplateId: string;
  let optionalTemplateId: string;
  let otherTemplateId: string;

  const createMember = async (label: string, memberPermissions: string[]) => {
    const email = `${label}-${suffix}@example.test`;
    const password = `correct horse ${label} battery`;
    const [user] = await db<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,display_name)
      values (${email},${email},${await hashPassword(password)},${label}) returning id
    `;
    await db`
      insert into business_memberships(business_id,user_id,permissions)
      values (${businessId},${user!.id},${memberPermissions})
    `;
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
    expect(login.statusCode).toBe(200);
    return cookie(login);
  };

  const createCustomer = async (payload: Record<string, unknown>, sessionCookie = ownerCookie) => {
    const created = await app.inject({
      method: "POST", url: "/api/customers", headers: { cookie: sessionCookie, origin }, payload
    });
    expect(created.statusCode).toBe(201);
    return created.json().id as string;
  };

  const createTemplate = async (
    payload: Record<string, unknown>, sessionCookie = ownerCookie
  ) => {
    const created = await app.inject({
      method: "POST", url: "/api/agreement-templates", headers: { cookie: sessionCookie, origin }, payload
    });
    expect(created.statusCode).toBe(201);
    return created.json();
  };

  const panel = async (customer = customerId, sessionCookie = ownerCookie) => {
    const response = await app.inject({
      method: "GET", url: `/api/customers/${customer}/agreements`, headers: { cookie: sessionCookie }
    });
    expect(response.statusCode).toBe(200);
    return response.json() as AgreementPanel;
  };

  const itemFor = (result: AgreementPanel, templateId: string) =>
    result.items.find((item) => item.templateId === templateId)!;

  const send = async (
    templateIds: string[],
    options: { customer?: string; cookie?: string; channel?: string } = {}
  ) => app.inject({
    method: "POST",
    url: `/api/customers/${options.customer ?? customerId}/agreements/send`,
    headers: { cookie: options.cookie ?? ownerCookie, origin },
    payload: { templateIds, ...(options.channel ? { channel: options.channel } : {}) }
  });

  const sign = async (
    templateId: string,
    payload: Record<string, unknown> = { signedName: "Robin Vale" },
    options: { customer?: string; cookie?: string } = {}
  ) => app.inject({
    method: "POST",
    url: `/api/customers/${options.customer ?? customerId}/agreements/${templateId}/signature`,
    headers: { cookie: options.cookie ?? ownerCookie, origin },
    payload
  });

  const agreementIntents = async (customer: string, templateId: string) =>
    db<{ id: string; status: string; channel: string; destination: string | null }[]>`
      select id,status,channel,destination from notification_intents
      where business_id=${businessId} and customer_id=${customer}
        and agreement_template_id=${templateId}
      order by created_at,id
    `;

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: { email: ownerEmail, password: ownerPassword, businessName: "Agreement Salon" }
    });
    expect(signup.statusCode).toBe(201);
    ownerCookie = cookie(signup);
    businessId = signup.json().businessId;

    customerId = await createCustomer({
      firstName: "Robin", lastName: "Vale", email: `robin-${suffix}@example.test`
    });
    quietCustomerId = await createCustomer({ firstName: "Quinn", lastName: "Quiet" });
    archivedCustomerId = await createCustomer({
      firstName: "Ash", lastName: "Archived", email: `ash-${suffix}@example.test`
    });
    const archived = await app.inject({
      method: "POST", url: `/api/customers/${archivedCustomerId}/archive`,
      headers: { cookie: ownerCookie, origin }
    });
    expect(archived.statusCode).toBe(204);

    viewerCookie = await createMember("agreement-viewer", ["customers.view"]);
    editorCookie = await createMember("agreement-editor", ["customers.view", "customers.edit"]);
    strangerCookie = await createMember("agreement-stranger", ["calendar.view"]);
    settingsOnlyCookie = await createMember("agreement-settings", ["settings.manage"]);

    requiredTemplateId = (await createTemplate({
      name: "Cancellation Policy",
      body: "Cancellations inside 24 hours are charged in full.",
      required: true
    })).id;
    optionalTemplateId = (await createTemplate({
      name: "Photo Release",
      body: "We may photograph your pet for our gallery.",
      required: false
    })).id;

    const other = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `agreements-other-${suffix}@example.test`,
        password: "correct horse other agreements battery", businessName: "Other Agreement Salon"
      }
    });
    expect(other.statusCode).toBe(201);
    otherOwnerCookie = cookie(other);
    otherBusinessId = other.json().businessId;
    otherCustomerId = await createCustomer(
      { firstName: "Not", lastName: "Yours", email: `not-yours-${suffix}@example.test` },
      otherOwnerCookie
    );
    otherTemplateId = (await createTemplate(
      { name: "Matted Pet Release Form", body: "Matting may require a short cut.", required: true },
      otherOwnerCookie
    )).id;
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  describe("templates", () => {
    it("lists the business's own live templates only", async () => {
      const response = await app.inject({
        method: "GET", url: "/api/agreement-templates", headers: { cookie: ownerCookie }
      });
      expect(response.statusCode).toBe(200);
      const templates = response.json() as { id: string; name: string; required: boolean; signedCount: number }[];
      expect(templates.map((template) => template.id).sort())
        .toEqual([requiredTemplateId, optionalTemplateId].sort());
      // A neighbouring salon's document is never visible here.
      expect(templates.some((template) => template.id === otherTemplateId)).toBe(false);
      expect(templates.find((template) => template.id === requiredTemplateId)!.required).toBe(true);
      expect(templates.every((template) => Number.isInteger(template.signedCount))).toBe(true);
    });

    it("lets a settings manager author templates and a client viewer read them", async () => {
      const readable = await app.inject({
        method: "GET", url: "/api/agreement-templates", headers: { cookie: viewerCookie }
      });
      expect(readable.statusCode).toBe(200);
      const alsoReadable = await app.inject({
        method: "GET", url: "/api/agreement-templates", headers: { cookie: settingsOnlyCookie }
      });
      expect(alsoReadable.statusCode).toBe(200);
      const refused = await app.inject({
        method: "GET", url: "/api/agreement-templates", headers: { cookie: strangerCookie }
      });
      expect(refused.statusCode).toBe(403);
      // Client access alone does not permit authoring.
      const authoring = await app.inject({
        method: "POST", url: "/api/agreement-templates",
        headers: { cookie: editorCookie, origin },
        payload: { name: "Unauthorized", body: "No." }
      });
      expect(authoring.statusCode).toBe(403);
    });

    it("rejects a duplicate live template name and frees the name once archived", async () => {
      const duplicate = await app.inject({
        method: "POST", url: "/api/agreement-templates", headers: { cookie: ownerCookie, origin },
        payload: { name: "  cancellation policy  ", body: "Duplicate." }
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().code).toBe("AGREEMENT_TEMPLATE_DUPLICATE");

      const temporary = await createTemplate({ name: "Seasonal Notice", body: "Holiday hours." });
      const archived = await app.inject({
        method: "DELETE", url: `/api/agreement-templates/${temporary.id}`,
        headers: { cookie: ownerCookie, origin }
      });
      expect(archived.statusCode).toBe(204);
      const reused = await app.inject({
        method: "POST", url: "/api/agreement-templates", headers: { cookie: ownerCookie, origin },
        payload: { name: "Seasonal Notice", body: "New holiday hours." }
      });
      expect(reused.statusCode).toBe(201);
      await app.inject({
        method: "DELETE", url: `/api/agreement-templates/${reused.json().id}`,
        headers: { cookie: ownerCookie, origin }
      });
      // Archiving something already archived is not a second archive.
      const again = await app.inject({
        method: "DELETE", url: `/api/agreement-templates/${temporary.id}`,
        headers: { cookie: ownerCookie, origin }
      });
      expect(again.statusCode).toBe(404);
    });

    it("bumps the version only when the agreed content changes", async () => {
      const template = await createTemplate({ name: "Versioned Notice", body: "First revision." });
      expect(template.version).toBe(1);
      const archivedOnly = await app.inject({
        method: "PATCH", url: `/api/agreement-templates/${template.id}`,
        headers: { cookie: ownerCookie, origin }, payload: { active: false }
      });
      expect(archivedOnly.statusCode).toBe(200);
      expect(archivedOnly.json().version).toBe(1);
      const rewritten = await app.inject({
        method: "PATCH", url: `/api/agreement-templates/${template.id}`,
        headers: { cookie: ownerCookie, origin }, payload: { body: "Second revision.", active: true }
      });
      expect(rewritten.statusCode).toBe(200);
      expect(rewritten.json().version).toBe(2);
      const empty = await app.inject({
        method: "PATCH", url: `/api/agreement-templates/${template.id}`,
        headers: { cookie: ownerCookie, origin }, payload: {}
      });
      expect(empty.statusCode).toBe(400);
      await app.inject({
        method: "DELETE", url: `/api/agreement-templates/${template.id}`,
        headers: { cookie: ownerCookie, origin }
      });
    });
  });

  describe("resolved state and the warning banner", () => {
    it("reports every live template as not_sent before anything happens", async () => {
      const result = await panel();
      expect(result.customerId).toBe(customerId);
      expect(result.customerArchived).toBe(false);
      expect(itemFor(result, requiredTemplateId)).toMatchObject({
        status: "not_sent", agreementId: null, sentAt: null, signedAt: null,
        sendCount: 0, required: true, active: true, lastSend: null
      });
      expect(itemFor(result, optionalTemplateId).required).toBe(false);
    });

    it("raises the banner only for unsigned required agreements", async () => {
      const before = await panel();
      expect(before.summary).toMatchObject({
        requiredTotal: 1, unsignedRequiredTotal: 1, needsAttention: true
      });
      expect(before.summary.unsignedRequiredTemplateIds).toEqual([requiredTemplateId]);

      // Signing the optional document changes nothing about the banner.
      expect((await sign(optionalTemplateId, { signedName: "Robin Vale" })).statusCode).toBe(200);
      const stillWarned = await panel();
      expect(stillWarned.summary.needsAttention).toBe(true);
      expect(stillWarned.summary.signedTotal).toBe(1);

      expect((await sign(requiredTemplateId, { signedName: "Robin Vale" })).statusCode).toBe(200);
      const cleared = await panel();
      expect(cleared.summary).toMatchObject({
        requiredTotal: 1, unsignedRequiredTotal: 0, signedTotal: 2, needsAttention: false
      });
      expect(cleared.summary.unsignedRequiredTemplateIds).toEqual([]);
    });

    it("counts a client with no state at all as needing attention", async () => {
      const result = await panel(quietCustomerId);
      expect(result.summary.needsAttention).toBe(true);
      expect(result.summary.unsignedRequiredTotal).toBe(1);
      expect(Number.isInteger(result.summary.unsignedRequiredTotal)).toBe(true);
    });
  });

  describe("recording a signature", () => {
    it("records name, time, actor and the revision that was signed", async () => {
      const result = await panel();
      const signed = itemFor(result, requiredTemplateId);
      expect(signed).toMatchObject({
        status: "signed", signedName: "Robin Vale", signatureMethod: "staff_recorded",
        signedTemplateVersion: 1
      });
      expect(signed.agreementId).not.toBeNull();
      expect(typeof signed.signedAt).toBe("string");
      // The actor resolves to a renderable name rather than a bare id.
      expect(signed.recordedByName).toBe(ownerEmail.split("@")[0]);
    });

    it("refuses to silently overwrite an existing signature", async () => {
      const again = await sign(requiredTemplateId, { signedName: "Someone Else" });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("AGREEMENT_ALREADY_SIGNED");
      expect(itemFor(await panel(), requiredTemplateId).signedName).toBe("Robin Vale");
    });

    it("accepts a backdated signature but never a postdated one", async () => {
      const target = await createTemplate({ name: "Backdated Notice", body: "Paper form." });
      const backdated = new Date(Date.now() - 86_400_000).toISOString();
      const accepted = await sign(target.id, { signedName: "Robin Vale", signedAt: backdated, note: "Paper form at the counter" });
      expect(accepted.statusCode).toBe(200);
      expect(new Date(accepted.json().signedAt).getTime()).toBe(Date.parse(backdated));
      expect(accepted.json().signatureNote).toBe("Paper form at the counter");

      const future = await createTemplate({ name: "Future Notice", body: "Not yet." });
      const refused = await sign(future.id, {
        signedName: "Robin Vale", signedAt: new Date(Date.now() + 86_400_000).toISOString()
      });
      expect(refused.statusCode).toBe(400);
    });

    it("clears a signature recorded in error, falling back to the prior state", async () => {
      const neverSent = await createTemplate({ name: "Never Sent Notice", body: "Counter only." });
      expect((await sign(neverSent.id)).statusCode).toBe(200);
      const cleared = await app.inject({
        method: "DELETE", url: `/api/customers/${customerId}/agreements/${neverSent.id}/signature`,
        headers: { cookie: ownerCookie, origin }
      });
      expect(cleared.statusCode).toBe(204);
      // Never sent, so it falls all the way back to "not sent" and the row is gone.
      expect(itemFor(await panel(), neverSent.id)).toMatchObject({ status: "not_sent", agreementId: null });
      const [remaining] = await db<{ count: number }[]>`
        select count(*)::int count from customer_agreements
        where business_id=${businessId} and agreement_template_id=${neverSent.id}
      `;
      expect(remaining!.count).toBe(0);
      const missing = await app.inject({
        method: "DELETE", url: `/api/customers/${customerId}/agreements/${neverSent.id}/signature`,
        headers: { cookie: ownerCookie, origin }
      });
      expect(missing.statusCode).toBe(404);
      await app.inject({
        method: "DELETE", url: `/api/agreement-templates/${neverSent.id}`,
        headers: { cookie: ownerCookie, origin }
      });
    });

    it("requires client edit permission", async () => {
      const target = await createTemplate({ name: "Permission Notice", body: "Gate check." });
      expect((await sign(target.id, { signedName: "X" }, { cookie: viewerCookie })).statusCode).toBe(403);
      expect((await sign(target.id, { signedName: "X" }, { cookie: strangerCookie })).statusCode).toBe(403);
      expect((await sign(target.id, { signedName: "X" }, { cookie: editorCookie })).statusCode).toBe(200);
      await app.inject({
        method: "DELETE", url: `/api/agreement-templates/${target.id}`,
        headers: { cookie: ownerCookie, origin }
      });
    });
  });

  describe("sending", () => {
    it("queues one email notification intent per agreement", async () => {
      const target = await createTemplate({ name: "Sendable Notice", body: "Please confirm." });
      const response = await send([target.id]);
      expect(response.statusCode).toBe(200);
      const result = response.json();
      expect(result.channel).toBe("email");
      expect(result.queued).toBe(1);
      expect(result.results).toEqual([{ templateId: target.id, outcome: "queued" }]);

      const intents = await agreementIntents(customerId, target.id);
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({ status: "pending", channel: "email" });
      expect(intents[0]!.destination).toBe(`robin-${suffix}@example.test`);

      const item = result.items.find((entry: AgreementItem) => entry.templateId === target.id) as AgreementItem;
      expect(item).toMatchObject({ status: "sent", sendCount: 1, lastSentChannel: "email", signedAt: null });
      expect(item.lastSend).toMatchObject({ channel: "email", deliveryStatus: "pending" });
    });

    it("is idempotent while an earlier send is still undelivered", async () => {
      const target = await createTemplate({ name: "Idempotent Notice", body: "Please confirm." });
      expect((await send([target.id])).json().results[0].outcome).toBe("queued");
      const repeat = await send([target.id]);
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json().results).toEqual([{ templateId: target.id, outcome: "already_queued" }]);
      expect(repeat.json().queued).toBe(0);

      expect(await agreementIntents(customerId, target.id)).toHaveLength(1);
      const item = itemFor(await panel(), target.id);
      // The repeat did not inflate the send counter either.
      expect(item.sendCount).toBe(1);

      // Once the earlier message reaches a terminal state a later send is a real nudge.
      await db`
        update notification_intents set status='sent',updated_at=now()
        where business_id=${businessId} and customer_id=${customerId}
          and agreement_template_id=${target.id}
      `;
      const nudge = await send([target.id]);
      expect(nudge.json().results).toEqual([{ templateId: target.id, outcome: "queued" }]);
      expect(await agreementIntents(customerId, target.id)).toHaveLength(2);
      expect(itemFor(await panel(), target.id).sendCount).toBe(2);
    });

    it("skips agreements that are already signed or archived, and unknown ids", async () => {
      const signedTarget = await createTemplate({ name: "Already Signed Notice", body: "Done." });
      expect((await sign(signedTarget.id)).statusCode).toBe(200);
      const archivedTarget = await createTemplate({ name: "Archived Notice", body: "Retired." });
      await app.inject({
        method: "DELETE", url: `/api/agreement-templates/${archivedTarget.id}`,
        headers: { cookie: ownerCookie, origin }
      });
      const unknown = crypto.randomUUID();

      const response = await send([signedTarget.id, archivedTarget.id, unknown, otherTemplateId]);
      expect(response.statusCode).toBe(200);
      expect(response.json().queued).toBe(0);
      expect(response.json().results).toEqual([
        { templateId: signedTarget.id, outcome: "skipped_signed" },
        { templateId: archivedTarget.id, outcome: "skipped_archived" },
        { templateId: unknown, outcome: "not_found" },
        // Another salon's document is indistinguishable from one that does not exist.
        { templateId: otherTemplateId, outcome: "not_found" }
      ]);
      expect(await agreementIntents(customerId, archivedTarget.id)).toHaveLength(0);
    });

    it("cancels an undelivered request when the signature is recorded", async () => {
      const target = await createTemplate({ name: "Cancelled On Sign Notice", body: "Confirm please." });
      expect((await send([target.id])).json().queued).toBe(1);
      expect((await sign(target.id)).statusCode).toBe(200);
      const intents = await agreementIntents(customerId, target.id);
      expect(intents.map((intent) => intent.status)).toEqual(["cancelled"]);
    });

    it("falls back to sent, not to not_sent, when a signature on a sent agreement is cleared", async () => {
      const target = await createTemplate({ name: "Sent Then Signed Notice", body: "Confirm please." });
      expect((await send([target.id])).json().queued).toBe(1);
      expect((await sign(target.id)).statusCode).toBe(200);
      const cleared = await app.inject({
        method: "DELETE", url: `/api/customers/${customerId}/agreements/${target.id}/signature`,
        headers: { cookie: ownerCookie, origin }
      });
      expect(cleared.statusCode).toBe(204);
      expect(itemFor(await panel(), target.id)).toMatchObject({
        status: "sent", sendCount: 1, signedAt: null, signedName: null, signatureMethod: null,
        signedTemplateVersion: null, recordedByName: null
      });
    });

    it("refuses SMS with an explicit reason instead of pretending to support it", async () => {
      const target = await createTemplate({ name: "SMS Notice", body: "Confirm please." });
      const response = await send([target.id], { channel: "sms" });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "AGREEMENT_CHANNEL_UNSUPPORTED", channel: "sms", supportedChannels: ["email"]
      });
      expect(await agreementIntents(customerId, target.id)).toHaveLength(0);

      // The panel says the same thing up front so the UI can disable the option honestly.
      const sms = (await panel()).delivery.channels.find((entry) => entry.channel === "sms")!;
      expect(sms).toMatchObject({ available: false, reason: "channel_unsupported" });
      expect(sms.detail).toContain("no SMS");
      expect((await panel()).delivery.supportedChannels).toEqual(["email"]);

      // The schema-level guarantee behind that answer.
      const [check] = await db<{ definition: string }[]>`
        select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid='notification_intents'::regclass and conname='notification_intents_channel_check'
      `;
      expect(check!.definition).toContain("'email'");
    });

    it("refuses to send to a client who cannot receive email", async () => {
      const target = await createTemplate({ name: "Undeliverable Notice", body: "Confirm please." });
      const noAddress = await send([target.id], { customer: quietCustomerId });
      expect(noAddress.statusCode).toBe(409);
      expect(noAddress.json()).toMatchObject({
        code: "AGREEMENT_UNDELIVERABLE", reason: "no_email_address"
      });

      const optedOut = await createCustomer({
        firstName: "Opt", lastName: "Out", email: `opt-out-${suffix}@example.test`, emailAllowed: false
      });
      expect((await send([target.id], { customer: optedOut })).json().reason).toBe("email_declined");

      const blocked = await createCustomer({
        firstName: "Block", lastName: "Messages", email: `blocked-${suffix}@example.test`
      });
      const preferences = await app.inject({
        method: "PATCH", url: `/api/customers/${blocked}/preferences`,
        headers: { cookie: ownerCookie, origin }, payload: { blockMessages: true }
      });
      expect(preferences.statusCode).toBe(200);
      expect((await send([target.id], { customer: blocked })).json().reason).toBe("messages_blocked");
      expect((await panel(blocked)).delivery.channels[0]).toMatchObject({
        channel: "email", available: false, reason: "messages_blocked", destination: null
      });
      expect(await agreementIntents(quietCustomerId, target.id)).toHaveLength(0);
    });

    it("requires client edit permission", async () => {
      const target = await createTemplate({ name: "Send Permission Notice", body: "Confirm please." });
      expect((await send([target.id], { cookie: viewerCookie })).statusCode).toBe(403);
      expect((await send([target.id], { cookie: strangerCookie })).statusCode).toBe(403);
      expect((await send([target.id], { cookie: editorCookie })).statusCode).toBe(200);
    });
  });

  describe("archived clients and archived templates", () => {
    it("keeps an archived client's agreements readable but frozen", async () => {
      const result = await panel(archivedCustomerId);
      expect(result.customerArchived).toBe(true);
      expect(result.items.length).toBeGreaterThan(0);
      expect((await sign(requiredTemplateId, { signedName: "Ash" }, { customer: archivedCustomerId })).statusCode).toBe(404);
      const sendResponse = await send([requiredTemplateId], { customer: archivedCustomerId });
      expect(sendResponse.statusCode).toBe(404);
      expect(await agreementIntents(archivedCustomerId, requiredTemplateId)).toHaveLength(0);
    });

    it("refuses a signature against an archived template but keeps existing state visible", async () => {
      const target = await createTemplate({ name: "Retired Policy", body: "Old text.", required: true });
      expect((await sign(target.id)).statusCode).toBe(200);
      const archived = await app.inject({
        method: "DELETE", url: `/api/agreement-templates/${target.id}`,
        headers: { cookie: ownerCookie, origin }
      });
      expect(archived.statusCode).toBe(204);

      const refused = await sign(target.id, { signedName: "Robin Vale" }, { customer: quietCustomerId });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe("AGREEMENT_TEMPLATE_ARCHIVED");

      // History survives archiving for the client who has state...
      const withHistory = await panel();
      expect(itemFor(withHistory, target.id)).toMatchObject({ status: "signed", active: false });
      // ...but an archived required document never raises the banner again.
      expect(withHistory.summary.unsignedRequiredTemplateIds).not.toContain(target.id);
      // ...and it disappears entirely for a client who never had state against it.
      expect((await panel(quietCustomerId)).items.some((item) => item.templateId === target.id)).toBe(false);
    });

    it("cancels undelivered requests when a template is archived", async () => {
      const target = await createTemplate({ name: "Archive Cancels Notice", body: "Confirm please." });
      expect((await send([target.id])).json().queued).toBe(1);
      await app.inject({
        method: "DELETE", url: `/api/agreement-templates/${target.id}`,
        headers: { cookie: ownerCookie, origin }
      });
      expect((await agreementIntents(customerId, target.id)).map((intent) => intent.status))
        .toEqual(["cancelled"]);
    });
  });

  describe("tenant isolation", () => {
    it("hides another business's client and templates from every agreement route", async () => {
      const read = await app.inject({
        method: "GET", url: `/api/customers/${otherCustomerId}/agreements`,
        headers: { cookie: ownerCookie }
      });
      expect(read.statusCode).toBe(404);
      const readBack = await app.inject({
        method: "GET", url: `/api/customers/${customerId}/agreements`,
        headers: { cookie: otherOwnerCookie }
      });
      expect(readBack.statusCode).toBe(404);
    });

    it("rejects signing across the tenant boundary in both directions", async () => {
      // Our client, their document.
      const foreignTemplate = await sign(otherTemplateId, { signedName: "Robin Vale" });
      expect(foreignTemplate.statusCode).toBe(404);
      // Their client, our session.
      const foreignCustomer = await sign(
        requiredTemplateId, { signedName: "Robin Vale" }, { customer: otherCustomerId }
      );
      expect(foreignCustomer.statusCode).toBe(404);
      // Their client, their document, our session.
      const bothForeign = await sign(
        otherTemplateId, { signedName: "Robin Vale" }, { customer: otherCustomerId }
      );
      expect(bothForeign.statusCode).toBe(404);
      const [leaked] = await db<{ count: number }[]>`
        select count(*)::int count from customer_agreements
        where agreement_template_id=${otherTemplateId} and business_id=${businessId}
      `;
      expect(leaked!.count).toBe(0);
    });

    it("rejects sending across the tenant boundary", async () => {
      const foreignCustomer = await send([requiredTemplateId], { customer: otherCustomerId });
      expect(foreignCustomer.statusCode).toBe(404);
      const [intents] = await db<{ count: number }[]>`
        select count(*)::int count from notification_intents
        where customer_id=${otherCustomerId} and agreement_template_id is not null
      `;
      expect(intents!.count).toBe(0);
    });

    it("rejects managing another business's template", async () => {
      const update = await app.inject({
        method: "PATCH", url: `/api/agreement-templates/${otherTemplateId}`,
        headers: { cookie: ownerCookie, origin }, payload: { required: false }
      });
      expect(update.statusCode).toBe(404);
      const archive = await app.inject({
        method: "DELETE", url: `/api/agreement-templates/${otherTemplateId}`,
        headers: { cookie: ownerCookie, origin }
      });
      expect(archive.statusCode).toBe(404);
      const [unchanged] = await db<{ required: boolean; active: boolean }[]>`
        select required,active from agreement_templates
        where business_id=${otherBusinessId} and id=${otherTemplateId}
      `;
      expect(unchanged).toMatchObject({ required: true, active: true });
    });

    it("makes a cross-tenant agreement row impossible at the schema level", async () => {
      // The composite foreign keys, not application code, are the last line of defence.
      await expect(db`
        insert into customer_agreements
          (business_id,customer_id,agreement_template_id,status,signed_at,signed_name,
           signature_method,signed_template_version,signed_by_membership_id)
        values (${businessId},${customerId},${otherTemplateId},'signed',now(),'Robin Vale',
          'staff_recorded',1,(select id from business_memberships where business_id=${businessId} limit 1))
      `).rejects.toThrow();
      await expect(db`
        insert into customer_agreements
          (business_id,customer_id,agreement_template_id,status,sent_at,send_count)
        values (${businessId},${otherCustomerId},${requiredTemplateId},'sent',now(),1)
      `).rejects.toThrow();
      await expect(db`
        insert into notification_intents
          (business_id,customer_id,agreement_template_id,notification_type,
           scheduled_occurrence,channel,destination)
        values (${businessId},${customerId},${otherTemplateId},'agreement_signature_request',
          now(),'email','leak@example.test')
      `).rejects.toThrow();
    });

    it("keeps unsigned state from leaking across businesses in the banner query", async () => {
      const ours = await panel();
      const theirs = await app.inject({
        method: "GET", url: `/api/customers/${otherCustomerId}/agreements`,
        headers: { cookie: otherOwnerCookie }
      });
      expect(theirs.statusCode).toBe(200);
      const theirPanel = theirs.json() as AgreementPanel;
      expect(theirPanel.items.map((item) => item.templateId)).toEqual([otherTemplateId]);
      expect(theirPanel.summary).toMatchObject({
        requiredTotal: 1, unsignedRequiredTotal: 1, needsAttention: true
      });
      // Our salon's signatures never satisfy their required document, and vice versa.
      expect(ours.items.some((item) => item.templateId === otherTemplateId)).toBe(false);
    });
  });

  describe("schema invariants", () => {
    it("refuses a signed row without provenance and an unsigned row carrying it", async () => {
      await expect(db`
        insert into customer_agreements (business_id,customer_id,agreement_template_id,status,signed_at)
        values (${businessId},${quietCustomerId},${optionalTemplateId},'signed',now())
      `).rejects.toThrow();
      await expect(db`
        insert into customer_agreements
          (business_id,customer_id,agreement_template_id,status,sent_at,signed_name)
        values (${businessId},${quietCustomerId},${optionalTemplateId},'sent',now(),'Ghost')
      `).rejects.toThrow();
      await expect(db`
        insert into customer_agreements (business_id,customer_id,agreement_template_id,status)
        values (${businessId},${quietCustomerId},${optionalTemplateId},'not_sent')
      `).rejects.toThrow();
    });

    it("keeps row-level security enabled on both agreement tables", async () => {
      const rows = await db<{ relname: string; relrowsecurity: boolean; policies: number }[]>`
        select class.relname,class.relrowsecurity,
          (select count(*)::int from pg_policy policy where policy.polrelid=class.oid) as policies
        from pg_class class
        where class.relname in ('agreement_templates','customer_agreements')
        order by class.relname
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.policies, row.relname).toBeGreaterThan(0);
      }
    });
  });
});
