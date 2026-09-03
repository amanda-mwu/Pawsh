import postgres from "postgres";
import {
  applyDiscounts, builtInRoles, calculateInvoice,
  type DiscountApplyScope, type DiscountKind, type DiscountLine
} from "@pawsh/domain";
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

const sql = postgres(databaseUrl, { transform: postgres.camel });
const passwordHash = await hashPassword(password);

/**
 * The salon's opening hours, and the ONE place they are written.
 *
 * Everything the seed schedules is placed inside these windows, so the two facts cannot drift
 * apart the way they would if the appointment layout carried its own copy of them. Weekday 0 is
 * Sunday, matching `business_hours.weekday` and `employee_working_hours.weekday`; Sunday is
 * absent because the salon is shut.
 */
const businessHourDefinitions = [
  [1, "08:00", "18:00"], [2, "08:00", "18:00"], [3, "08:00", "18:00"],
  [4, "08:00", "18:00"], [5, "08:00", "18:00"], [6, "09:00", "16:00"]
] as const;
const openWeekdays = new Set<number>(businessHourDefinitions.map(([weekday]) => weekday));

/**
 * The two groomers' rotas, also written once. Grace is off on Saturday and Gabriel on Monday, so
 * there are days on which only one of them is in - which is why the appointment layout below
 * resolves a LANE DAY per groomer rather than assuming both are working the same date.
 */
const graceShift = { weekdays: [1, 2, 3, 4, 5], start: "08:00", end: "16:00" } as const;
const gabrielShift = { weekdays: [2, 3, 4, 5, 6], start: "09:00", end: "17:00" } as const;
function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number) as [number, number];
  return hours * 60 + minutes;
}

/**
 * CIVIL DATE ARITHMETIC, deliberately kept away from instants.
 *
 * A QA calendar is laid out in the salon's own wall-clock terms - "today at 09:00" - and the only
 * safe way to say that is to carry the civil date as `YYYY-MM-DD` text, do the arithmetic on it,
 * and let PostgreSQL convert `<date> <time>` to an instant in the location's timezone. Building a
 * UTC `Date` and hoping it lands on the intended local hour is what produced the seed's original
 * hard-coded 19:30Z, and it silently moves by an hour twice a year.
 *
 * `Date.UTC` is used purely as a proleptic-Gregorian calculator here; no timezone is involved on
 * either side of it.
 */
const dateTextPattern = /^\d{4}-\d{2}-\d{2}$/;
function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function weekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}
/** The first date on or after `from` that the salon is open AND the given rota covers. */
function nextWorkingDay(from: string, rota: readonly number[]): string {
  let candidate = from;
  for (let step = 0; step < 14; step += 1) {
    const weekday = weekdayOf(candidate);
    if (openWeekdays.has(weekday) && rota.includes(weekday)) return candidate;
    candidate = addDays(candidate, 1);
  }
  throw new Error(`QA seed could not find a working day within a fortnight of ${from}`);
}

/**
 * The QA staff, named by the BUILT-IN ROLE each one holds.
 *
 * This file used to carry four hand-written permission arrays and write them onto
 * `business_memberships.permissions` - a column migration 0042 dropped, which is why the seed had
 * stopped running at all. It is not repaired by moving those arrays onto a role: a QA workspace
 * whose Manager holds a set no real workspace has is a workspace where nothing observed about
 * permissions is evidence about the product. So the roles come from the same provisioning path a
 * real signup uses, and this map only says who holds which.
 */
const builtInRoleNames = new Set(builtInRoles.map((role) => role.name));
const memberDefinitions = [
  ["manager@pawsh-test.example", "Manager"],
  ["reception@pawsh-test.example", "Receptionist"],
  ["grace@pawsh-test.example", "Groomer"],
  ["gabriel@pawsh-test.example", "Groomer"]
] as const;
for (const [, roleName] of memberDefinitions) {
  // A name Pawsh no longer ships would seed a member with no role at all, which
  // `membership_role_matches_ownership` refuses - loudly here rather than mid-transaction.
  if (!builtInRoleNames.has(roleName)) throw new Error(`QA seed names an unknown built-in role: ${roleName}`);
}

/**
 * Filled inside the transaction and printed after it commits, so nothing is reported that was
 * subsequently rolled back. The seed places its workspace on a date it RESOLVES rather than on
 * one the reviewer can assume, so where to look is part of the output.
 */
const summary: string[] = [];

await sql.begin(async (tx) => {
  async function ensureUser(email: string): Promise<string> {
    const [user] = await tx<{ id: string }[]>`
      insert into users(email,normalized_email,password_hash,email_verified_at)
      values (${email},${email},${passwordHash},now())
      on conflict (normalized_email) do update set email=excluded.email,password_hash=excluded.password_hash
      returning id
    `;
    return user!.id;
  }
  const ownerId = await ensureUser("owner@pawsh-test.example");
  let [business] = await tx<{ id: string }[]>`select id from businesses where name='Pawsh QA Grooming' limit 1`;
  if (!business) {
    [business] = await tx<{ id: string }[]>`
      insert into businesses(name,currency,tax_rate_basis_points,reminder_lead_minutes,discount_stacking_mode)
      values ('Pawsh QA Grooming','USD',825,1440,'amount_first') returning id
    `;
  } else {
    // `amount_first` rather than the schema default `one_per_appointment`, which is the mode that
    // REFUSES a second discount outright. A QA workspace that cannot put two discounts on one bill
    // cannot show the compounding - a fixed amount off, then a percentage of what is left - which
    // is the whole reason the stacking mode is a setting.
    await tx`update businesses set currency='USD',tax_rate_basis_points=825,reminder_lead_minutes=1440,status='active',discount_stacking_mode='amount_first' where id=${business.id}`;
  }
  const businessId = business!.id;
  await tx`select set_config('app.business_id',${businessId},true)`;
  // The SAME provisioning authority a real signup runs, rather than a seed-only reconstruction of
  // it. It is what gives this workspace its service catalog, its tax rate, its payment methods and
  // its built-in roles, and it is idempotent, so re-seeding an existing QA business adds nothing.
  await provisionBusinessCatalog(tx, businessId);
  const roleIds = new Map(
    (await tx<{ id: string; name: string }[]>`
      select id,name from roles where business_id=${businessId} and built_in
    `).map((role) => [role.name, role.id])
  );
  // An owner holds no role - `membership_role_matches_ownership` requires `role_id` to be null for
  // one - because owner authority is `is_owner` and resolves to the whole tuple.
  const [ownerMembership] = await tx<{ id: string }[]>`
    insert into business_memberships(business_id,user_id,is_owner,role_id,status)
    values (${businessId},${ownerId},true,null,'active')
    on conflict (business_id,user_id) do update set is_owner=true,role_id=null,status='active'
    returning id
  `;
  let [location] = await tx<{ id: string; timezone:string }[]>`select id,timezone from locations where business_id=${businessId} and active limit 1`;
  if (!location) {
    [location] = await tx<{ id: string; timezone:string }[]>`
      insert into locations(business_id,name,address,timezone)
      values (${businessId},'Pawsh QA Salon','123 Test Avenue, Pasadena, CA 91101','America/Los_Angeles')
      returning id,timezone
    `;
  } else {
    await tx`update locations set name='Pawsh QA Salon',address='123 Test Avenue, Pasadena, CA 91101',timezone='America/Los_Angeles' where id=${location.id}`;
  }
  await tx`delete from business_hours where business_id=${businessId}`;
  for (const [weekday,start,end] of businessHourDefinitions) {
    await tx`insert into business_hours(business_id,location_id,weekday,start_time,end_time) values (${businessId},${location!.id},${weekday},${start},${end})`;
  }

  const memberships = new Map<string,string>();
  memberships.set("owner@pawsh-test.example",ownerMembership!.id);
  for (const [email,roleName] of memberDefinitions) {
    const roleId = roleIds.get(roleName);
    if (!roleId) throw new Error(`QA seed could not find the built-in role ${roleName}`);
    const userId = await ensureUser(email);
    const [membership] = await tx<{ id: string }[]>`
      insert into business_memberships(business_id,user_id,role_id,status)
      values (${businessId},${userId},${roleId},'active')
      on conflict (business_id,user_id) do update set role_id=excluded.role_id,status='active'
      returning id
    `;
    memberships.set(email,membership!.id);
  }

  const serviceDefinitions = [
    ["Full Groom",90,8500,true],["Bath & Brush",60,5500,true],["Nail Trim",20,2000,true],
    ["De-shedding",30,3000,true],["Puppy Groom",60,6000,true],["Legacy Groom",75,7000,false]
  ] as const;
  const services = new Map<string,string>();
  for (const [name,duration,price,active] of serviceDefinitions) {
    let [service] = await tx<{ id: string }[]>`select id from services where business_id=${businessId} and name=${name} limit 1`;
    if (!service) {
      [service] = await tx<{ id: string }[]>`
        insert into services(business_id,name,base_duration_minutes,base_price_minor,active)
        values (${businessId},${name},${duration},${price},${active}) returning id
      `;
    } else {
      await tx`update services set base_duration_minutes=${duration},base_price_minor=${price},active=${active} where id=${service.id}`;
    }
    services.set(name,service!.id);
  }

  async function ensureEmployee(name: string, email: string, days: number[], serviceNames: string[], start: string, end: string): Promise<string> {
    let [employee] = await tx<{ id: string }[]>`select id from employees where business_id=${businessId} and display_name=${name} limit 1`;
    if (!employee) {
      [employee] = await tx<{ id: string }[]>`
        insert into employees(business_id,membership_id,display_name)
        values (${businessId},${memberships.get(email)!},${name}) returning id
      `;
    } else {
      await tx`update employees set membership_id=${memberships.get(email)!},active=true where id=${employee.id}`;
    }
    await tx`delete from employee_working_hours where employee_id=${employee!.id}`;
    for (const day of days) {
      await tx`insert into employee_working_hours(business_id,employee_id,weekday,start_time,end_time) values (${businessId},${employee!.id},${day},${start},${end})`;
    }
    await tx`delete from employee_services where employee_id=${employee!.id}`;
    for (const serviceName of serviceNames) {
      await tx`insert into employee_services(business_id,employee_id,service_id) values (${businessId},${employee!.id},${services.get(serviceName)!})`;
    }
    return employee!.id;
  }
  const graceId = await ensureEmployee("Grace Groomer","grace@pawsh-test.example",[...graceShift.weekdays],["Full Groom","Bath & Brush","Nail Trim","De-shedding"],graceShift.start,graceShift.end);
  const gabrielId = await ensureEmployee("Gabriel Groomer","gabriel@pawsh-test.example",[...gabrielShift.weekdays],["Full Groom","Bath & Brush","Nail Trim","Puppy Groom"],gabrielShift.start,gabrielShift.end);

  const customerDefinitions = [
    ["Emma","Johnson","626-555-0101","emma.johnson@pawsh-test.example"],
    ["Daniel","Martinez","626-555-0102","daniel.martinez@pawsh-test.example"],
    ["Sophia","Chen","626-555-0103","sophia.chen@pawsh-test.example"],
    ["Michael","Williams","626-555-0199","michael.search@pawsh-test.example"],
    ["Avery","Thompson","626-555-0105","avery.archive@pawsh-test.example"],
    /**
     * The sixth household, and the only one with NO INVOICE HISTORY of its own.
     *
     * It exists because the day's layout needs seven pets on the books at once and the canonical
     * five households own six between them, but it earns its place twice over: a client who has
     * never been invoiced is the only client a `new_clients_only` coupon can be tested against,
     * and one household with two pets on the same groomer is what makes back-to-back sibling
     * bookings look like a real morning rather than a fixture.
     */
    ["Elias","Okonkwo","626-555-0106","elias.okonkwo@pawsh-test.example"]
  ] as const;
  const customers = new Map<string,string>();
  for (const [first,last,phone,email] of customerDefinitions) {
    let [customer] = await tx<{ id: string }[]>`select id from customers where business_id=${businessId} and normalized_email=${email} limit 1`;
    if (!customer) {
      [customer] = await tx<{ id: string }[]>`
        insert into customers(business_id,first_name,last_name,phone,normalized_phone,email,normalized_email,preferred_contact_method,created_by,updated_by)
        values (${businessId},${first},${last},${phone},${phone.replace(/\D/g,"")},${email},${email},'email',${ownerId},${ownerId}) returning id
      `;
    } else {
      await tx`update customers set archived_at=null,first_name=${first},last_name=${last},phone=${phone},normalized_phone=${phone.replace(/\D/g,"")} where id=${customer.id}`;
    }
    customers.set(email,customer!.id);
  }
  const petDefinitions = [
    ["emma.johnson@pawsh-test.example","Charlie","Golden Retriever","2021-04-15",1152,"Male","Long double coat","Medium trim; feathering kept natural.","Friendly and calm.",null,null],
    ["daniel.martinez@pawsh-test.example","Rocky","German Shepherd","2019-08-20",1360,"Male",null,"De-shedding","Nervous around paws.","Mild hip stiffness.","May snap during nail handling."],
    ["sophia.chen@pawsh-test.example","Mochi","Shih Tzu","2022-01-10",208,"Female",null,"Short teddy-bear cut.","Calm.",null,null],
    ["sophia.chen@pawsh-test.example","Boba","Pomeranian","2020-11-05",160,"Male",null,"Scissor trim only.",null,null,"Do not shave coat."],
    ["michael.search@pawsh-test.example","Luna","Labradoodle","2021-06-12",768,"Female","Matting prone.","Half-inch body length.",null,null,null],
    ["avery.archive@pawsh-test.example","Daisy","Beagle","2018-03-14",496,"Female",null,null,null,null,null],
    ["elias.okonkwo@pawsh-test.example","Bruno","Standard Poodle","2020-09-08",720,"Male","Dense curly coat; clips down cleanly.","Half-inch body, clean face and feet.","Steady on the table.",null,null],
    ["elias.okonkwo@pawsh-test.example","Poppy","Cavalier King Charles Spaniel","2023-02-19",224,"Female",null,"Feathering left long; feet tidied only.","Wriggles once the dryer starts.",null,null]
  ] as const;
  const pets = new Map<string,string>();
  for (const [email,name,breed,dob,weight,sex,coat,preference,behavior,medical,safety] of petDefinitions) {
    const customerId = customers.get(email)!;
    let [pet] = await tx<{ id: string }[]>`select id from pets where business_id=${businessId} and customer_id=${customerId} and name=${name} limit 1`;
    if (!pet) {
      [pet] = await tx<{ id: string }[]>`
        insert into pets(business_id,customer_id,name,species,breed,date_of_birth,weight_ounces,sex,coat_notes,grooming_preferences,behavior_notes,medical_notes,safety_alerts,created_by,updated_by)
        values (${businessId},${customerId},${name},'dog',${breed},${dob},${weight},${sex},${coat},${preference},${behavior},${medical},${safety},${ownerId},${ownerId}) returning id
      `;
    } else {
      await tx`update pets set archived_at=null,breed=${breed},date_of_birth=${dob},weight_ounces=${weight},sex=${sex},coat_notes=${coat},grooming_preferences=${preference},behavior_notes=${behavior},medical_notes=${medical},safety_alerts=${safety} where id=${pet.id}`;
    }
    pets.set(`${email}:${name}`,pet!.id);
  }
  /**
   * ------------------------------------------------------------------------------------------
   * THE TRANSACTIONAL WORKSPACE: a day somebody can actually walk.
   * ------------------------------------------------------------------------------------------
   *
   * This used to be two blocked times and ONE appointment, derived as `next Monday - 7 days` and
   * hard-coded `completed`. That is a QA calendar with nothing on it to check in, nothing in
   * service and nothing to check out, and because the offset was negative no amount of reseeding
   * ever produced a workable day - the single row was in the past by construction.
   *
   * Two rules replace it, and both are structural rather than conventions to remember:
   *
   *   1. EVERY DATE IS DERIVED FROM THE MOMENT THE SEED RUNS, in the location's own timezone, and
   *      every time of day is checked against the hours written above before anything is written.
   *      Civil dates stay `YYYY-MM-DD` text and PostgreSQL converts them to instants, so a slot
   *      means 09:00 in Pasadena in March and in July alike.
   *
   *   2. A ROW IS FOUND AGAIN BY ITS NOTE, so a re-run repositions what is already there instead
   *      of stacking a second copy beside it.
   */
  /**
   * `QA_ANCHOR_DATE` accepts a CIVIL DATE (`YYYY-MM-DD`), which is what the testing docs promise
   * and what the Playwright helpers pass, and also a full instant, which is what
   * `scripts/seed-local.mjs` has always passed. An instant is not a date until a timezone is
   * chosen, so it is resolved to the LOCATION'S local date rather than to UTC's - the same frame
   * everything else below is laid out in.
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
  const anchorDate = anchorIsCivilDate ? anchorInput! : clock!.localAnchor ?? clock!.localToday;
  /** Today, unless the salon is shut today, in which case the next day it opens. */
  const focusDate = nextWorkingDay(anchorDate, [...openWeekdays]);

  /**
   * A LANE PER GROOMER, because the two rotas do not coincide every day. Tuesday to Friday both
   * are in and both lanes land on `focusDate`; on a Monday Gabriel is off and on a Saturday Grace
   * is, and that groomer's lane moves to the next date they actually work rather than the seed
   * booking somebody outside their own hours to keep a tidy layout.
   *
   * Whichever lane lands on `focusDate` is the PRIMARY one and carries the fuller day: the paid
   * visit, the check-in, the first walk-through booking and the drag-conflict pair. At least one
   * lane always does, because `focusDate` is a day the salon is open and no open day is missing
   * from both rotas.
   */
  const grace = { id: graceId, name: "Grace Groomer", shift: graceShift,
    day: nextWorkingDay(focusDate, graceShift.weekdays) };
  const gabriel = { id: gabrielId, name: "Gabriel Groomer", shift: gabrielShift,
    day: nextWorkingDay(focusDate, gabrielShift.weekdays) };
  const primary = grace.day === focusDate ? grace : gabriel;
  const secondary = primary === grace ? gabriel : grace;
  const laneStaff = {
    primary, secondary, primaryLastWeek: primary, primaryNextWeek: primary,
    secondaryNextWeek: secondary
  } as const;
  const laneDates = {
    primary: primary.day,
    secondary: secondary.day,
    primaryLastWeek: addDays(primary.day, -7),
    primaryNextWeek: addDays(primary.day, 7),
    secondaryNextWeek: addDays(secondary.day, 7)
  } as const;

  /*
   * Placed in the gaps the appointment layout leaves, on the lane day rather than on a fixed
   * weekday, so a block never lands on top of a visit the seed booked itself.
   *
   * KEYED ON THE REASON RATHER THAN DELETED AND REWRITTEN. The seed used to clear every
   * `QA seed:%` block and insert two fresh ones, which meant two rows with new ids and a new
   * `created_at` on every run - a re-run that reported itself as idempotent while replacing rows.
   * The reason is the natural key here, so the two blocks are found, moved if they need moving,
   * and otherwise left completely alone.
   *
   * A LOCAL WALL-CLOCK LITERAL IS WRITTEN `(${...}::text)::timestamp`, HERE AND EVERYWHERE BELOW,
   * AND THE `::text` IS LOAD-BEARING. `postgres.js` chooses its serializer from the type the
   * SERVER infers for each placeholder: write `${"2026-09-02 09:00:00"}::timestamp` and the server
   * reports `timestamp`, at which point the driver puts the string through its own date handling
   * and what arrives has been shifted by the offset of whatever timezone the machine running the
   * seed is in - a 09:00 appointment landing at 16:00 because the laptop is in Los Angeles.
   * Casting from `text` pins the parameter to `text`, so the literal reaches PostgreSQL verbatim
   * and is parsed there, which is the only place that knows this is a naive local time and not an
   * instant. Do not "simplify" the double cast away.
   */
  const blockDefinitions = [
    [primary.id, laneDates.primary, "12:00", "12:30", "QA seed: Lunch"],
    [secondary.id, laneDates.secondary, "15:00", "15:30", "QA seed: Personal"]
  ] as const;
  // Anything the seed used to write and no longer plans, and any second copy of a reason left by
  // an older run, so the pair cannot accumulate.
  await tx`
    delete from blocked_times where business_id=${businessId} and reason like 'QA seed:%'
      and (reason <> all(${blockDefinitions.map(([,,,,reason]) => reason)}::text[])
        or id <> (select keep.id from blocked_times keep
          where keep.business_id=blocked_times.business_id and keep.reason=blocked_times.reason
          order by keep.created_at, keep.id limit 1))
  `;
  for (const [employeeId,day,start,end,reason] of blockDefinitions) {
    const localStart = `${day} ${start}:00`;
    const localEnd = `${day} ${end}:00`;
    const [existing] = await tx<{ id: string }[]>`
      select id from blocked_times where business_id=${businessId} and reason=${reason} limit 1
    `;
    if (existing) {
      await tx`
        update blocked_times set employee_id=${employeeId}, location_id=${location!.id},
          start_at=((${localStart}::text)::timestamp at time zone ${location!.timezone}),
          end_at=((${localEnd}::text)::timestamp at time zone ${location!.timezone}),
          scheduling_timezone=${location!.timezone},
          scheduled_local_start=(${localStart}::text)::timestamp,
          scheduled_local_end=(${localEnd}::text)::timestamp
        where id=${existing.id}
          and (employee_id,location_id,scheduling_timezone,scheduled_local_start,scheduled_local_end)
            is distinct from (${employeeId}::uuid,${location!.id}::uuid,${location!.timezone}::text,
              (${localStart}::text)::timestamp,(${localEnd}::text)::timestamp)
      `;
    } else {
      await tx`
        insert into blocked_times(business_id,employee_id,location_id,start_at,end_at,
          scheduling_timezone,scheduled_local_start,scheduled_local_end,reason,created_by)
        values (${businessId},${employeeId},${location!.id},
          ((${localStart}::text)::timestamp at time zone ${location!.timezone}),
          ((${localEnd}::text)::timestamp at time zone ${location!.timezone}),
          ${location!.timezone},(${localStart}::text)::timestamp,(${localEnd}::text)::timestamp,
          ${reason},${ownerId})
      `;
    }
  }

  type Lane = keyof typeof laneDates;
  interface PlannedAppointment {
    /** The note. It is what a reviewer reads on the calendar AND the key the row is found by. */
    marker: string;
    lane: Lane;
    /** Local wall-clock start, `HH:MM`. The duration comes from the service. */
    localTime: string;
    service: string;
    customer: string;
    pet: string;
    status: "scheduled" | "checked_in" | "in_service" | "completed";
    /** Set on the ONE row the seed invoices itself; see the placement resolver below. */
    seedInvoices?: boolean;
  }
  /**
   * The day, written out rather than generated.
   *
   * Eleven visits across two groomers is a plausible small salon; a randomised fixture of eighty
   * would exercise the same code and make the calendar and every report unreadable. The statuses
   * are chosen so the affordances that depend on them all differ visibly on one screen, and the
   * `scheduled` rows are what was missing entirely before.
   */
  const plan: readonly PlannedAppointment[] = [
    // --- The primary lane, on the day the reviewer lands on. ----------------------------------
    { marker: "QA seed: Paid visit with two discounts stacked", lane: "primary", localTime: "09:00",
      service: "Full Groom", customer: "avery.archive@pawsh-test.example", pet: "Daisy",
      status: "completed", seedInvoices: true },
    { marker: "QA seed: Checked in at the front desk", lane: "primary", localTime: "10:45",
      service: "Bath & Brush", customer: "daniel.martinez@pawsh-test.example", pet: "Rocky",
      status: "checked_in" },
    { marker: "QA seed: Booking to walk through to a discounted checkout", lane: "primary",
      localTime: "12:30", service: "Full Groom", customer: "emma.johnson@pawsh-test.example",
      pet: "Charlie", status: "scheduled" },
    // The drag-conflict pair. They CANNOT be seeded overlapping - `employee_appointment_no_overlap`
    // and the two conflict triggers refuse that outright - so they sit an hour apart on one
    // groomer, which is the arrangement that makes dragging either onto the other raise it.
    { marker: "QA seed: Drag-conflict pair, earlier", lane: "primary", localTime: "14:15",
      service: "Bath & Brush", customer: "sophia.chen@pawsh-test.example", pet: "Mochi",
      status: "scheduled" },
    { marker: "QA seed: Drag-conflict pair, later", lane: "primary", localTime: "15:30",
      service: "Nail Trim", customer: "sophia.chen@pawsh-test.example", pet: "Boba",
      status: "scheduled" },
    // --- The secondary lane. ------------------------------------------------------------------
    { marker: "QA seed: In service now", lane: "secondary", localTime: "09:30",
      service: "Full Groom", customer: "michael.search@pawsh-test.example", pet: "Luna",
      status: "in_service" },
    { marker: "QA seed: Second booking to walk through", lane: "secondary", localTime: "11:15",
      service: "Bath & Brush", customer: "elias.okonkwo@pawsh-test.example", pet: "Bruno",
      status: "scheduled" },
    // A visit already at the checkout step, so the discount picker and the coupon box can be
    // reached in one click as well as at the end of the four-step walk.
    { marker: "QA seed: Finished, waiting on checkout", lane: "secondary", localTime: "13:00",
      service: "Full Groom", customer: "elias.okonkwo@pawsh-test.example", pet: "Poppy",
      status: "completed" },
    // --- Next week, so the directory's next-appointment column is not a row of dashes. ---------
    { marker: "QA seed: Next week's booking for Charlie", lane: "primaryNextWeek",
      localTime: "10:00", service: "Full Groom", customer: "emma.johnson@pawsh-test.example",
      pet: "Charlie", status: "scheduled" },
    { marker: "QA seed: Next week's booking for Luna", lane: "secondaryNextWeek",
      localTime: "14:00", service: "Bath & Brush", customer: "michael.search@pawsh-test.example",
      pet: "Luna", status: "scheduled" },
    // --- Last week. The original seed's one row, kept, and now re-anchored on every run so it
    //     stays LAST WEEK instead of drifting further into the past the longer QA goes on.
    { marker: "QA seed: Legacy historical snapshot", lane: "primaryLastWeek", localTime: "13:00",
      service: "Legacy Groom", customer: "avery.archive@pawsh-test.example", pet: "Daisy",
      status: "completed" }
  ];

  /**
   * THE LAYOUT CHECKS ITSELF BEFORE ANYTHING IS WRITTEN.
   *
   * Every slot is verified to fall on a day the salon is open, on a day the assigned groomer
   * works, inside both of those windows, and clear of every other slot on that groomer that day.
   * A future edit that nudges a time past closing, or that lands two visits on one groomer, fails
   * here with the row named rather than three statements later inside a trigger.
   */
  const serviceCatalog = new Map<string, { duration: number; price: number }>(
    serviceDefinitions.map(([name,duration,price]) => [name, { duration, price }])
  );
  const salonHours = new Map<number, { start: string; end: string }>(
    businessHourDefinitions.map(([weekday,start,end]) => [weekday, { start, end }])
  );
  const laneBookings = new Map<string, { start: number; end: number; marker: string }[]>();
  for (const entry of plan) {
    const day = laneDates[entry.lane];
    const lane = laneStaff[entry.lane];
    const service = serviceCatalog.get(entry.service);
    if (!service) throw new Error(`QA seed plans an unknown service: ${entry.service}`);
    const weekday = weekdayOf(day);
    const salon = salonHours.get(weekday);
    if (!salon) throw new Error(`QA seed plans "${entry.marker}" on ${day}, when the salon is shut`);
    if (!(lane.shift.weekdays as readonly number[]).includes(weekday)) {
      throw new Error(`QA seed plans "${entry.marker}" on ${day}, when ${lane.name} is not in`);
    }
    const start = minutesOf(entry.localTime);
    const end = start + service.duration;
    const opens = Math.max(minutesOf(salon.start), minutesOf(lane.shift.start));
    const closes = Math.min(minutesOf(salon.end), minutesOf(lane.shift.end));
    if (start < opens || end > closes) {
      throw new Error(`QA seed plans "${entry.marker}" outside ${lane.name}'s hours on ${day}`);
    }
    // Applied to COMPLETED rows too, not only to the three statuses the conflict guard reads: two
    // finished visits stacked on one groomer would pass every trigger and still be unreadable.
    const key = `${lane.id}:${day}`;
    const booked = laneBookings.get(key) ?? [];
    for (const other of booked) {
      if (start < other.end && other.start < end) {
        throw new Error(`QA seed plans "${entry.marker}" over "${other.marker}" on ${day}`);
      }
    }
    booked.push({ start, end, marker: entry.marker });
    laneBookings.set(key, booked);
  }

  /**
   * FINDING EACH ROW AGAIN, and deciding whether it still belongs to the seed.
   *
   * A row that has acquired a NON-VOID INVOICE has stopped being the seed's. Somebody checked it
   * out during QA and it now carries a receipt, probably a payment, possibly a redeemed coupon.
   * Resetting it to `scheduled` underneath that invoice would manufacture a state the product
   * cannot reach, and deleting the invoice to make room would destroy real QA work along with
   * whatever a payment or a refund references. So the seed stops recognising it, leaves it exactly
   * where QA left it - it is legitimate history now - and books a fresh appointment for the slot.
   *
   * The single exception is the row the seed invoices ITSELF, which would otherwise be re-created
   * on every run; it is matched on the note alone.
   */
  interface Placement {
    entry: PlannedAppointment;
    id: string | null;
    day: string;
    employeeId: string;
    localStart: string;
    duration: number;
    price: number;
    customerId: string;
    petId: string;
    settled: boolean;
  }
  const placements: Placement[] = [];
  for (const entry of plan) {
    const day = laneDates[entry.lane];
    const service = serviceCatalog.get(entry.service)!;
    const placement: Placement = {
      entry, id: null, day, employeeId: laneStaff[entry.lane].id,
      localStart: `${day} ${entry.localTime}:00`,
      duration: service.duration, price: service.price,
      customerId: customers.get(entry.customer)!,
      petId: pets.get(`${entry.customer}:${entry.pet}`)!,
      settled: false
    };
    const [found] = await tx<{
      id: string; status: string; employeeId: string; customerId: string; petId: string;
      schedulingTimezone: string; localStart: string; durationMinutes: number;
      startConsistent: boolean;
    }[]>`
      select a.id, a.status, a.employee_id, a.customer_id, a.pet_id, a.scheduling_timezone,
        to_char(a.scheduled_local_start,'YYYY-MM-DD HH24:MI:SS') as local_start,
        (extract(epoch from (a.end_at - a.start_at))/60)::int as duration_minutes,
        (a.start_at = (a.scheduled_local_start at time zone a.scheduling_timezone)) as start_consistent
      from appointments a
      where a.business_id=${businessId} and a.notes=${entry.marker}
        and (${entry.seedInvoices ?? false}::boolean or not exists (
          select 1 from invoices i
          where i.business_id=a.business_id and i.appointment_id=a.id and i.status<>'void'))
      order by a.created_at, a.id
      limit 1
    `;
    if (found) {
      placement.id = found.id;
      // What "already correct" means, spelled out: a re-run that finds all of this true writes
      // nothing at all for this row, which is what makes a second run a genuine no-op rather than
      // a rewrite that happens to land on the same values.
      placement.settled = found.status === entry.status
        && found.employeeId === placement.employeeId
        && found.customerId === placement.customerId
        && found.petId === placement.petId
        && found.schedulingTimezone === location!.timezone
        && found.localStart === placement.localStart
        && found.durationMinutes === placement.duration
        && found.startConsistent;
    }
    placements.push(placement);
  }

  /**
   * NEUTRALISE, THEN REPOSITION, THEN RESTORE.
   *
   * `employee_appointment_conflict_guard` and `assigned_employee_schedule_conflict_guard` both
   * fire on `scheduled`, `checked_in` and `in_service`, so a reseed that moved a day's worth of
   * rows one at a time would collide with the very rows it was on its way to move - the seed
   * refusing its own layout. `cancelled` is exempt from both guards, so every row that has to move
   * is parked there first, positioned while it is parked, and given its real status only once
   * everything is where it belongs. Rows already in position are left alone entirely.
   */
  const moving = placements.filter((placement) => !placement.settled);
  const parked = moving.map((placement) => placement.id).filter((id): id is string => id !== null);
  if (parked.length) {
    await tx`
      update appointments set status='cancelled'
      where business_id=${businessId} and id = any(${parked}::uuid[]) and status<>'cancelled'
    `;
  }
  for (const placement of moving) {
    const { localStart, duration } = placement;
    const timezone = location!.timezone;
    if (placement.id) {
      await tx`
        update appointments set
          location_id=${location!.id}, customer_id=${placement.customerId}, pet_id=${placement.petId},
          employee_id=${placement.employeeId},
          start_at=((${localStart}::text)::timestamp at time zone ${timezone}),
          end_at=((${localStart}::text)::timestamp at time zone ${timezone}) + make_interval(mins => ${duration}::int),
          scheduling_timezone=${timezone},
          scheduled_local_start=(${localStart}::text)::timestamp,
          scheduled_utc_offset_minutes=extract(epoch from ((${localStart}::text)::timestamp
            - (((${localStart}::text)::timestamp at time zone ${timezone}) at time zone 'UTC')))/60,
          updated_by=${ownerId}
        where business_id=${businessId} and id=${placement.id}
      `;
    } else {
      // Created `cancelled` and promoted below with the rest, so the guards have nothing to object
      // to while the other rows are still in motion.
      const [created] = await tx<{ id: string }[]>`
        insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,
          end_at,scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,
          notes,created_by,updated_by)
        values (${businessId},${location!.id},${placement.customerId},${placement.petId},
          ${placement.employeeId},
          ((${localStart}::text)::timestamp at time zone ${timezone}),
          ((${localStart}::text)::timestamp at time zone ${timezone}) + make_interval(mins => ${duration}::int),
          ${timezone},(${localStart}::text)::timestamp,
          extract(epoch from ((${localStart}::text)::timestamp
            - (((${localStart}::text)::timestamp at time zone ${timezone}) at time zone 'UTC')))/60,
          'cancelled',${placement.entry.marker},${ownerId},${ownerId})
        returning id
      `;
      placement.id = created!.id;
    }
    /**
     * `appointment_employees` IS THE ATTRIBUTION, not a mirror of the employee_id column on
     * `appointments` (unquoted here on purpose: the permission-catalog guard reads a backticked
     * dotted identifier as a permission grant, so a column name written that way fails the build): the
     * reports and the dashboard read staff from here and from nowhere else, so a row repositioned
     * onto the other groomer without this would be credited to the wrong person on every screen
     * that counts. `one_groomer_per_appointment` allows exactly one row per appointment, which is
     * why the wrong one is removed before the right one is added.
     */
    await tx`
      delete from appointment_employees
      where business_id=${businessId} and appointment_id=${placement.id}
        and employee_id<>${placement.employeeId}
    `;
    await tx`
      insert into appointment_employees(business_id,appointment_id,employee_id)
      values (${businessId},${placement.id},${placement.employeeId})
      on conflict do nothing
    `;
    const serviceId = services.get(placement.entry.service)!;
    await tx`
      delete from appointment_services
      where business_id=${businessId} and appointment_id=${placement.id} and service_id<>${serviceId}
    `;
    const [existingService] = await tx<{ id: string }[]>`
      select id from appointment_services
      where business_id=${businessId} and appointment_id=${placement.id} and service_id=${serviceId}
      limit 1
    `;
    if (existingService) {
      await tx`
        update appointment_services set service_name_snapshot=${placement.entry.service},
          duration_minutes_snapshot=${placement.duration}, price_minor_snapshot=${placement.price}
        where id=${existingService.id}
          and (service_name_snapshot,duration_minutes_snapshot,price_minor_snapshot)
            is distinct from (${placement.entry.service},${placement.duration}::int,${placement.price}::int)
      `;
    } else {
      await tx`
        insert into appointment_services(business_id,appointment_id,service_id,
          service_name_snapshot,duration_minutes_snapshot,price_minor_snapshot)
        values (${businessId},${placement.id},${serviceId},${placement.entry.service},
          ${placement.duration},${placement.price})
      `;
    }
  }
  for (const placement of moving) {
    await tx`
      update appointments set status=${placement.entry.status}
      where business_id=${businessId} and id=${placement.id} and status<>${placement.entry.status}
    `;
  }

  /**
   * ------------------------------------------------------------------------------------------
   * The Coupon & Discount catalog, so the checkout picker and the coupon box have something to
   * offer the first time they are opened.
   * ------------------------------------------------------------------------------------------
   *
   * A retired discount is included deliberately: it must appear in Settings and must NOT appear in
   * the checkout picker, and a workspace with only live rows cannot show that difference.
   */
  const discountDefinitions = [
    ["Senior pet discount", "amount", 1000, null, "per_appointment", true],
    ["Loyal client 10%", "percentage", null, 1000, "per_appointment", true],
    ["Multi-pet, $5 a pet", "amount", 500, null, "per_pet", true],
    ["Grand opening 20%", "percentage", null, 2000, "per_appointment", false]
  ] as const;
  const discounts = new Map<string,string>();
  for (const [name,kind,amountMinor,rateBasisPoints,applyScope,active] of discountDefinitions) {
    // Matched the way `discount_name_per_business` indexes it. That index is PARTIAL on `active`,
    // so this lookup cannot be, or the retired row would be re-inserted on every run.
    let [row] = await tx<{ id: string }[]>`
      select id from discounts
      where business_id=${businessId} and lower(btrim(name))=${name.toLowerCase()} limit 1
    `;
    if (!row) {
      [row] = await tx<{ id: string }[]>`
        insert into discounts(business_id,name,kind,amount_minor,rate_basis_points,apply_scope,
          active,created_by)
        values (${businessId},${name},${kind},${amountMinor},${rateBasisPoints},${applyScope},
          ${active},${ownerId})
        returning id
      `;
    } else {
      await tx`
        update discounts set name=${name},kind=${kind},amount_minor=${amountMinor},
          rate_basis_points=${rateBasisPoints},apply_scope=${applyScope},active=${active}
        where id=${row.id}
          and (name,kind,amount_minor,rate_basis_points,apply_scope,active) is distinct from
            (${name},${kind},${amountMinor}::int,${rateBasisPoints}::int,${applyScope},${active}::boolean)
      `;
    }
    discounts.set(name,row!.id);
  }

  /**
   * The codes. Their DATE RANGES ARE RELATIVE to the same anchor as the calendar, so the coupon
   * meant to be live is live on the day QA happens and the one meant to be expired stays expired -
   * the two states the coupon box has to be able to show.
   *
   * `WELCOME15` carries the pair of limitations worth exercising together: a window, and caps both
   * overall and per client. Coupon rules are evaluated against the APPOINTMENT'S local date rather
   * than against checkout time, so a window anchored on `focusDate` is the one the seeded day
   * falls inside.
   */
  const couponDefinitions = [
    { code: "WELCOME15", name: "Welcome 15%", kind: "percentage" as const, amountMinor: null,
      rateBasisPoints: 1500, applyScope: "per_appointment" as const,
      startsOn: addDays(focusDate,-14), endsOn: addDays(focusDate,30),
      newClientsOnly: false, maxRedemptions: 25, maxRedemptionsPerClient: 1, active: true },
    { code: "SPRING10", name: "Spring $10 off", kind: "amount" as const, amountMinor: 1000,
      rateBasisPoints: null, applyScope: "per_appointment" as const,
      startsOn: addDays(focusDate,-60), endsOn: addDays(focusDate,-3),
      newClientsOnly: false, maxRedemptions: null, maxRedemptionsPerClient: null, active: true },
    { code: "NEWCLIENT20", name: "New client 20%", kind: "percentage" as const, amountMinor: null,
      rateBasisPoints: 2000, applyScope: "per_appointment" as const,
      startsOn: null, endsOn: null,
      newClientsOnly: true, maxRedemptions: null, maxRedemptionsPerClient: 1, active: true }
  ];
  const coupons = new Map<string,string>();
  for (const coupon of couponDefinitions) {
    // Matched the way `coupon_code_per_business` indexes it: case-insensitive, and NOT partial on
    // `active`, because a code stays claimed for the life of the business.
    let [row] = await tx<{ id: string }[]>`
      select id from coupons where business_id=${businessId} and upper(btrim(code))=${coupon.code} limit 1
    `;
    if (!row) {
      [row] = await tx<{ id: string }[]>`
        insert into coupons(business_id,code,name,kind,amount_minor,rate_basis_points,apply_scope,
          starts_on,ends_on,new_clients_only,max_redemptions,max_redemptions_per_client,active,
          created_by)
        values (${businessId},${coupon.code},${coupon.name},${coupon.kind},${coupon.amountMinor},
          ${coupon.rateBasisPoints},${coupon.applyScope},${coupon.startsOn},${coupon.endsOn},
          ${coupon.newClientsOnly},${coupon.maxRedemptions},${coupon.maxRedemptionsPerClient},
          ${coupon.active},${ownerId})
        returning id
      `;
    } else {
      await tx`
        update coupons set name=${coupon.name},kind=${coupon.kind},amount_minor=${coupon.amountMinor},
          rate_basis_points=${coupon.rateBasisPoints},apply_scope=${coupon.applyScope},
          starts_on=${coupon.startsOn},ends_on=${coupon.endsOn},
          new_clients_only=${coupon.newClientsOnly},max_redemptions=${coupon.maxRedemptions},
          max_redemptions_per_client=${coupon.maxRedemptionsPerClient},active=${coupon.active}
        where id=${row.id}
          and (name,kind,amount_minor,rate_basis_points,apply_scope,starts_on,ends_on,
               new_clients_only,max_redemptions,max_redemptions_per_client,active)
            is distinct from
            (${coupon.name},${coupon.kind},${coupon.amountMinor}::int,${coupon.rateBasisPoints}::int,
             ${coupon.applyScope},${coupon.startsOn}::date,${coupon.endsOn}::date,
             ${coupon.newClientsOnly}::boolean,${coupon.maxRedemptions}::int,
             ${coupon.maxRedemptionsPerClient}::int,${coupon.active}::boolean)
      `;
    }
    coupons.set(coupon.code,row!.id);
  }

  /**
   * ------------------------------------------------------------------------------------------
   * One receipt that already exists.
   * ------------------------------------------------------------------------------------------
   *
   * Without this the receipt and payment surfaces are empty until somebody performs a checkout,
   * which is the very thing they are there to help review. It is a real stacked bill - a fixed
   * amount off, then a percentage of what remained - so the compounding `amount_first` permits is
   * legible on a receipt before anybody has clicked anything.
   *
   * The totals come from `applyDiscounts` and `calculateInvoice`, THE SAME TWO FUNCTIONS THE
   * CHECKOUT ROUTE CALLS, rather than from arithmetic done here: a seeded receipt whose numbers
   * were reconstructed by hand would be evidence about the seed and not about the product.
   *
   * It is written once. Re-running finds the invoice and leaves the whole chain - the breakdown,
   * the redemption and the payment - untouched.
   */
  const invoiced = placements.find((placement) => placement.entry.seedInvoices)!;
  const [alreadyInvoiced] = await tx<{ id: string }[]>`
    select id from invoices
    where business_id=${businessId} and appointment_id=${invoiced.id} and status<>'void' limit 1
  `;
  if (!alreadyInvoiced) {
    const [rate] = await tx<{ taxRateBasisPoints: number }[]>`
      select tax_rate_basis_points from businesses where id=${businessId}
    `;
    const breakdown = [
      { source: "discount" as const, discountId: discounts.get("Senior pet discount")!,
        couponId: null as string | null, nameSnapshot: "Senior pet discount",
        kind: "amount" as DiscountKind, amountMinor: 1000 as number | null,
        rateBasisPoints: null as number | null,
        applyScope: "per_appointment" as DiscountApplyScope, units: 1 },
      { source: "coupon" as const, discountId: null as string | null,
        couponId: coupons.get("WELCOME15")!, nameSnapshot: "Welcome 15%",
        kind: "percentage" as DiscountKind, amountMinor: null as number | null,
        rateBasisPoints: 1500 as number | null,
        applyScope: "per_appointment" as DiscountApplyScope, units: 1 }
    ];
    const application = applyDiscounts({
      subtotal: invoiced.price,
      lines: breakdown.map((line): DiscountLine => ({
        kind: line.kind, amountMinor: line.amountMinor,
        rateBasisPoints: line.rateBasisPoints, units: line.units
      })),
      stackingMode: "amount_first"
    });
    const totals = calculateInvoice({
      lineAmounts: [invoiced.price], discount: application.discountMinor,
      taxRateBasisPoints: rate!.taxRateBasisPoints, tip: 1000
    });
    const [invoice] = await tx<{ id: string }[]>`
      insert into invoices(business_id,appointment_id,customer_id,status,subtotal_minor,
        discount_minor,tax_minor,tip_minor,total_minor,balance_minor,discount_type,discount_actor,
        calculation_version,tax_rate_basis_points)
      values (${businessId},${invoiced.id},${invoiced.customerId},'paid',${totals.subtotal},
        ${totals.discount},${totals.tax},${totals.tip},${totals.total},0,null,${ownerId},1,
        ${rate!.taxRateBasisPoints})
      returning id
    `;
    const [invoicedService] = await tx<{ id: string }[]>`
      select id from appointment_services
      where business_id=${businessId} and appointment_id=${invoiced.id} limit 1
    `;
    await tx`
      insert into invoice_items(business_id,invoice_id,description,quantity,unit_price_minor,
        amount_minor,source_appointment_service_id,line_position)
      values (${businessId},${invoice!.id},${invoiced.entry.service},1,${invoiced.price},
        ${invoiced.price},${invoicedService!.id},1)
    `;
    // IN APPLIED ORDER, and `applied_minor` is what each line actually took off rather than what
    // the catalog row says it is worth - so `sum(applied_minor) = discount_minor` holds here
    // exactly as 0046 requires it to for every invoice in the table.
    for (const [position,step] of application.applied.entries()) {
      const line = breakdown[step.index]!;
      await tx`
        insert into invoice_discounts(business_id,invoice_id,line_position,source,discount_id,
          coupon_id,name_snapshot,kind_snapshot,amount_minor_snapshot,rate_basis_points_snapshot,
          apply_scope_snapshot,units_snapshot,applied_minor)
        values (${businessId},${invoice!.id},${position + 1},${line.source},${line.discountId},
          ${line.couponId},${line.nameSnapshot},${line.kind},${line.amountMinor},
          ${line.rateBasisPoints},${line.applyScope},${line.units},${step.appliedMinor})
      `;
      if (line.source === "coupon" && line.couponId) {
        await tx`
          insert into coupon_redemptions(business_id,coupon_id,invoice_id,customer_id,amount_minor,
            redeemed_by)
          values (${businessId},${line.couponId},${invoice!.id},${invoiced.customerId},
            ${step.appliedMinor},${ownerId})
        `;
      }
    }
    // `external_card` is a card keyed into somebody else's terminal: `provider` and
    // `provider_payment_id` stay null, and no Square connection, device or terminal checkout is
    // fabricated anywhere in this seed. That surface stays empty because it genuinely is.
    await tx`
      insert into payments(business_id,invoice_id,amount_minor,method,recorded_by)
      values (${businessId},${invoice!.id},${totals.total},'external_card',${ownerId})
    `;
  }

  // What was written, and where to find it. A reviewer opening the calendar needs to know which
  // day the workspace was built around, which is not always today - see the lane note above.
  summary.push(`Focus day: ${focusDate}`);
  summary.push(`${primary.name} lane: ${primary.day}    ${secondary.name} lane: ${secondary.day}`);
  for (const placement of placements) {
    const groomer = laneStaff[placement.entry.lane].name.split(" ")[0]!;
    summary.push(`  ${placement.localStart.slice(0,16)}  ${placement.entry.status.padEnd(11)}`
      + `${groomer.padEnd(9)}${placement.entry.marker}`);
  }
});

await sql.end();
console.log("Pawsh manual QA seed complete");
for (const line of summary) console.log(line);
