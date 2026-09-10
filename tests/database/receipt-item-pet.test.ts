import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

/**
 * WHICH PET EACH RECEIPT LINE IS FOR.
 *
 * The Receipt itemises the purchase and names the pet "where applicable". Nothing on
 * `invoice_items` knows a pet: the row carries a description, a quantity, two money columns, a
 * line position and `source_appointment_service_id`, and the description is the service name
 * snapshot alone. So the pet has to be read through the source link, and these tests pin the
 * three things that makes true and the two things it must not do.
 *
 * WHAT IT MAKES TRUE. A line produced by a service names that service's pet. A line with no
 * source names none - `null`, not an empty string, because a blank label on paper is worse than
 * no label. And the pet a line names follows the LINE'S OWN source service rather than the
 * invoice's appointment, which is the only difference between reading it this way and reading
 * `appointments.pet_id` off the join the endpoint already had.
 *
 * WHAT IT MUST NOT DO. It must not reach another salon's rows, and it must not move a number.
 * The money assertion is written as a whole-row comparison against the table rather than as a
 * list of figures, so a future line that changes an amount fails here even if nobody thinks to
 * add an expectation for it.
 */

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const config: Config = {
  NODE_ENV: "test", DOCUMENT_STORAGE_ADAPTER: "memory", PORT: 3000,
  DATABASE_URL: databaseUrl ?? "postgres://unavailable",
  SESSION_SECRET: "receipt-item-pet-secret-at-least-32-characters",
  APP_ORIGIN: "http://localhost:3000", SMTP_PORT: 587, SMTP_SECURE: false
};

const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;

type Item = {
  id: string; description: string; amountMinor: number; linePosition: number;
  sourceAppointmentServiceId: string | null; petName: string | null;
};

describeDatabase("the pet on a receipt line", () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof createApp>>;
  const suffix = crypto.randomUUID();

  /** One salon, two clients, one pet each. Barfi is the default; Mochi is the discriminator. */
  const salon = {
    cookie: "", businessId: "", locationId: "", employeeId: "", serviceId: "",
    barfiOwner: "", barfi: "", mochiOwner: "", mochi: ""
  };
  /** A second salon, entirely separate, used only to prove it cannot be reached. */
  const other = { cookie: "", businessId: "", locationId: "", employeeId: "", serviceId: "", customerId: "", petId: "" };
  let day = 1;

  const key = () => crypto.randomUUID();

  /**
   * A completed appointment carrying one `appointment_services` row per name, in order. Written
   * directly because the point of these tests is the read, and each visit takes its own day so
   * the `employee_appointment_no_overlap` exclusion never has an opinion about it.
   */
  async function completedAppointment(
    customerId: string, petId: string, names: string[]
  ): Promise<{ appointmentId: string; serviceRowIds: string[] }> {
    const start = `2036-03-${String(day).padStart(2, "0")}T16:00:00.000Z`;
    const end = `2036-03-${String(day).padStart(2, "0")}T18:00:00.000Z`;
    day += 1;
    const [appointment] = await db<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select ${salon.businessId},${salon.locationId},${customerId},${petId},${salon.employeeId},
        ${start}::timestamptz,${end}::timestamptz,'America/Los_Angeles',
        ${start}::timestamptz at time zone 'America/Los_Angeles',-420,'completed',user_id,user_id
      from business_memberships where business_id=${salon.businessId} and is_owner returning id
    `;
    const serviceRowIds: string[] = [];
    for (const [index, name] of names.entries()) {
      const [row] = await db<{ id: string }[]>`
        insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
          duration_minutes_snapshot,price_minor_snapshot,line_position)
        values (${salon.businessId},${appointment!.id},${salon.serviceId},${name},60,
          ${(index + 1) * 1000},${index + 1})
        returning id
      `;
      serviceRowIds.push(row!.id);
    }
    return { appointmentId: appointment!.id, serviceRowIds };
  }

  async function checkout(appointmentId: string, tipMinor = 0) {
    const created = await app.inject({
      method: "POST", url: `/api/appointments/${appointmentId}/checkout`,
      headers: { cookie: salon.cookie, "idempotency-key": key() },
      payload: { discountMinor: 0, discountType: null, tipMinor }
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json() as { id: string; totalMinor: number; balanceMinor: number };
  }

  const receipt = (invoiceId: string, as = salon.cookie) =>
    app.inject({ method: "GET", url: `/api/invoices/${invoiceId}/receipt`, headers: { cookie: as } });

  const items = async (invoiceId: string) =>
    (await receipt(invoiceId)).json().items as Item[];

  beforeAll(async () => {
    db = createDatabase(config);
    app = await createApp(config, db, { runWorker: false, serveStatic: false });
    await app.ready();

    const signup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `pet-line-owner-${suffix}@example.test`,
        password: "correct horse receipt battery", businessName: "Pet Line Salon"
      }
    });
    expect(signup.statusCode, signup.body).toBe(201);
    salon.cookie = cookie(signup);
    ({ businessId: salon.businessId, locationId: salon.locationId } = signup.json());

    /** Every fixture is created through the API and every creation is checked, so a fixture that
     * fails to exist fails here rather than as an undefined bind parameter three tests later. */
    const post = async (url: string, payload: Record<string, unknown>, as = salon.cookie) => {
      const response = await app.inject({ method: "POST", url, headers: { cookie: as }, payload });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(201);
      return response.json().id as string;
    };
    salon.serviceId = await post("/api/services", {
      name: "Full Groom", baseDurationMinutes: 60, basePriceMinor: 10000
    });
    salon.employeeId = await post("/api/employees", {
      displayName: "Line Groomer", serviceIds: [salon.serviceId]
    });
    salon.barfiOwner = await post("/api/customers", {
      firstName: "Barfi", lastName: "Household", phone: "555-0170"
    });
    salon.barfi = await post("/api/pets", {
      customerId: salon.barfiOwner, name: "Barfi", species: "dog", breed: "Poodle"
    });
    salon.mochiOwner = await post("/api/customers", {
      firstName: "Mochi", lastName: "Household", phone: "555-0171"
    });
    salon.mochi = await post("/api/pets", {
      customerId: salon.mochiOwner, name: "Mochi", species: "dog", breed: "Poodle"
    });

    const otherSignup = await app.inject({
      method: "POST", url: "/api/auth/signup",
      payload: {
        email: `pet-line-other-${suffix}@example.test`,
        password: "correct horse other battery", businessName: "Other Salon"
      }
    });
    expect(otherSignup.statusCode, otherSignup.body).toBe(201);
    other.cookie = cookie(otherSignup);
    ({ businessId: other.businessId, locationId: other.locationId } = otherSignup.json());
    other.serviceId = await post("/api/services", {
      name: "Other Groom", baseDurationMinutes: 60, basePriceMinor: 9000
    }, other.cookie);
    other.employeeId = await post("/api/employees", {
      displayName: "Other Groomer", serviceIds: [other.serviceId]
    }, other.cookie);
    other.customerId = await post("/api/customers", {
      firstName: "Other", lastName: "Client", phone: "555-0172"
    }, other.cookie);
    other.petId = await post("/api/pets", {
      customerId: other.customerId, name: "Somebody Else's Dog", species: "dog", breed: "Poodle"
    }, other.cookie);
  }, 30_000);

  afterAll(async () => { await app.close(); await db.end(); });

  it("names the pet of the service that produced each line", async () => {
    const visit = await completedAppointment(salon.barfiOwner, salon.barfi, ["Full Groom", "Nail Trim"]);
    const invoice = await checkout(visit.appointmentId);

    const lines = await items(invoice.id);
    expect(lines).toHaveLength(2);
    // In line order, and each line still describing its own service. The pet is an ADDITION to
    // the description rather than a replacement for it, which is what lets the Receipt render
    // "Full Groom (for Barfi)" without the backend deciding how that sentence reads.
    expect(lines.map((line) => line.description)).toEqual(["Full Groom", "Nail Trim"]);
    expect(lines.map((line) => line.petName)).toEqual(["Barfi", "Barfi"]);
    // Each line names its source, so the pet above is demonstrably reached through the link
    // rather than through the invoice's own appointment.
    expect(lines.map((line) => line.sourceAppointmentServiceId)).toEqual(visit.serviceRowIds);
  });

  it("names no pet on a line that came from no service", async () => {
    const visit = await completedAppointment(salon.barfiOwner, salon.barfi, ["Full Groom"]);
    const invoice = await checkout(visit.appointmentId);
    // A line with no source: what a manual charge is, and what a line whose service has since
    // been replaced becomes. `invoice_items.source_appointment_service_id` is nullable and the
    // 0052 constraint is MATCH SIMPLE, so this is an ordinary row rather than a broken one.
    await db`
      insert into invoice_items(business_id,invoice_id,description,quantity,unit_price_minor,
        amount_minor,source_appointment_service_id,line_position)
      values (${salon.businessId},${invoice.id},'Flea shampoo',1,600,600,null,2)
    `;

    const lines = await items(invoice.id);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ description: "Full Groom", petName: "Barfi" });
    // NULL, NOT "". The Receipt decides whether to draw the pet by whether it is there, and an
    // empty string is there - it would print an empty parenthesis for a line that never had a pet.
    expect(lines[1]!.petName).toBeNull();
    expect(lines[1]!.petName).not.toBe("");
    expect(lines[1]!.sourceAppointmentServiceId).toBeNull();
  });

  it("follows the line's own source service, not the invoice's appointment", async () => {
    // THE DISCRIMINATOR. Both visits are in one salon; one is Barfi's and one is Mochi's. The
    // invoice belongs to Barfi's appointment, and one of its lines is repointed at a service row
    // on Mochi's. Read off `appointments.pet_id` through the invoice - the join the endpoint
    // already had - both lines would say Barfi. Read through the line's own source, they say what
    // is true of each line.
    const barfiVisit = await completedAppointment(salon.barfiOwner, salon.barfi, ["Full Groom", "Nail Trim"]);
    const mochiVisit = await completedAppointment(salon.mochiOwner, salon.mochi, ["Full Groom"]);
    const invoice = await checkout(barfiVisit.appointmentId);

    await db`
      update invoice_items set source_appointment_service_id=${mochiVisit.serviceRowIds[0]!}
      where business_id=${salon.businessId} and invoice_id=${invoice.id} and line_position=2
    `;

    const lines = await items(invoice.id);
    expect(lines.map((line) => line.petName)).toEqual(["Barfi", "Mochi"]);
    // And the invoice is still Barfi's appointment's invoice, so the two really are being read
    // from different places.
    const [appointment] = await db<{ petId: string }[]>`
      select a.pet_id from invoices i join appointments a
        on a.business_id=i.business_id and a.id=i.appointment_id
      where i.business_id=${salon.businessId} and i.id=${invoice.id}
    `;
    expect(appointment!.petId).toBe(salon.barfi);
  });

  it("cannot reach another salon's appointment service, appointment or pet", async () => {
    const visit = await completedAppointment(salon.barfiOwner, salon.barfi, ["Full Groom"]);
    const invoice = await checkout(visit.appointmentId);
    const [otherAppointment] = await db<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,created_by,updated_by)
      select ${other.businessId},${other.locationId},${other.customerId},${other.petId},${other.employeeId},
        '2036-05-04T16:00:00.000Z'::timestamptz,'2036-05-04T17:00:00.000Z'::timestamptz,'America/Los_Angeles',
        '2036-05-04T16:00:00.000Z'::timestamptz at time zone 'America/Los_Angeles',-420,'completed',user_id,user_id
      from business_memberships where business_id=${other.businessId} and is_owner returning id
    `;
    const [otherService] = await db<{ id: string }[]>`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot,line_position)
      values (${other.businessId},${otherAppointment!.id},${other.serviceId},'Other Groom',60,9000,1)
      returning id
    `;

    // THE EDGE THE JOIN WALKS CANNOT CROSS A TENANT IN THE FIRST PLACE. 0052 replaced
    // `references appointment_services(id)` with the composite, so a line in this salon pointing
    // at another salon's service row is not a row the database will accept.
    await expect(db`
      update invoice_items set source_appointment_service_id=${otherService!.id}
      where business_id=${salon.businessId} and invoice_id=${invoice.id} and line_position=1
    `).rejects.toThrow(/invoice_item_source_service_tenant/);

    // And the projection is anchored on the caller's business, so even the invoice id is not a
    // handle: asked for with the other salon's id, the same query returns nothing at all.
    const foreign = await db<{ id: string }[]>`
      select ii.id, p.name as pet_name
        from invoice_items ii
          left join appointment_services asvc
            on asvc.business_id=ii.business_id and asvc.id=ii.source_appointment_service_id
          left join appointments a on a.business_id=asvc.business_id and a.id=asvc.appointment_id
          left join pets p
            on p.business_id=a.business_id and p.customer_id=a.customer_id and p.id=a.pet_id
        where ii.business_id=${other.businessId} and ii.invoice_id=${invoice.id}
    `;
    expect(foreign).toHaveLength(0);

    // The endpoint agrees, which is the boundary an operator actually meets. `payments.view` is
    // untouched by any of this - the other salon's owner holds it and is still refused.
    const refused = await receipt(invoice.id, other.cookie);
    expect(refused.statusCode).toBe(404);
    expect((await items(invoice.id)).map((line) => line.petName)).toEqual(["Barfi"]);
  });

  it("adds the pet and moves no money", async () => {
    const visit = await completedAppointment(salon.barfiOwner, salon.barfi, ["Full Groom", "Nail Trim"]);
    const invoice = await checkout(visit.appointmentId, 1250);
    const paid = await app.inject({
      method: "POST", url: `/api/invoices/${invoice.id}/payments`,
      headers: { cookie: salon.cookie, "idempotency-key": key() },
      payload: {
        amountMinor: invoice.balanceMinor, expectedBalanceMinor: invoice.balanceMinor,
        method: "cash", externalReference: null
      }
    });
    expect(paid.statusCode, paid.body).toBe(201);

    // THE WHOLE ROW, NOT A LIST OF FIGURES. The receipt's items must be the table's rows with one
    // descriptive field added and nothing else touched - so this compares them wholesale, and a
    // future change that quietly recomputed an amount, dropped a column or duplicated a row
    // through the join fails here without anybody having predicted which figure would move.
    const stored = await db<Record<string, unknown>[]>`
      select * from invoice_items
      where business_id=${salon.businessId} and invoice_id=${invoice.id}
      order by line_position,id
    `;
    const lines = await items(invoice.id);
    expect(lines).toHaveLength(stored.length);
    const withoutPet = lines.map((line) => {
      const copy: Record<string, unknown> = { ...line };
      delete copy.petName;
      return copy;
    });
    expect(withoutPet).toEqual(stored.map((row) => JSON.parse(JSON.stringify(row))));
    expect(lines.map((line) => line.petName)).toEqual(["Barfi", "Barfi"]);

    // And the rest of the payload is what it was: the totals the invoice row holds, the payment
    // as recorded, and no refunds or discounts invented by a read.
    const body = (await receipt(invoice.id)).json();
    const [row] = await db<Record<string, unknown>[]>`
      select subtotal_minor,discount_minor,tax_minor,tip_minor,total_minor,balance_minor,status
      from invoices where business_id=${salon.businessId} and id=${invoice.id}
    `;
    expect(body.invoice).toMatchObject(JSON.parse(JSON.stringify(row)));
    expect(lines.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(body.invoice.subtotalMinor);
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].amountMinor).toBe(invoice.balanceMinor);
    expect(body.refunds).toEqual([]);
    expect(body.refundedMinor).toBe(0);
    expect(body.discounts).toEqual([]);
  });
});
