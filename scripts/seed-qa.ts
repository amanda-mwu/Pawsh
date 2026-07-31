import postgres from "postgres";
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
const allPermissions = [
  "calendar.view","appointments.view","appointments.create","appointments.edit","appointments.cancel",
  "appointments.override_conflict",
  "customers.view","customers.edit","pets.view","pets.edit","pets.care.view","pets.care.edit",
  "operations.check_in","operations.perform_service","operations.complete","checkout.perform",
  "payments.view","discounts.apply","services.manage","team.manage","reports.view","settings.manage"
];
const managerPermissions = allPermissions.filter((permission) => permission !== "settings.manage");
const receptionistPermissions = [
  "calendar.view","appointments.view","appointments.create","appointments.edit","appointments.cancel",
  "customers.view","customers.edit","pets.view","pets.edit","pets.care.view",
  "operations.check_in","checkout.perform","payments.view"
];
const groomerPermissions = [
  "calendar.view","appointments.view","customers.view","pets.view","pets.care.view",
  "operations.check_in","operations.perform_service","operations.complete"
];

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
      insert into businesses(name,currency,tax_rate_basis_points,reminder_lead_minutes)
      values ('Pawsh QA Grooming','USD',825,1440) returning id
    `;
  } else {
    await tx`update businesses set currency='USD',tax_rate_basis_points=825,reminder_lead_minutes=1440,status='active' where id=${business.id}`;
  }
  const businessId = business!.id;
  const [ownerMembership] = await tx<{ id: string }[]>`
    insert into business_memberships(business_id,user_id,is_owner,permissions,status)
    values (${businessId},${ownerId},true,${allPermissions},'active')
    on conflict (business_id,user_id) do update set is_owner=true,permissions=excluded.permissions,status='active'
    returning id
  `;
  let [location] = await tx<{ id: string }[]>`select id from locations where business_id=${businessId} and active limit 1`;
  if (!location) {
    [location] = await tx<{ id: string }[]>`
      insert into locations(business_id,name,address,timezone)
      values (${businessId},'Pawsh QA Salon','123 Test Avenue, Pasadena, CA 91101','America/Los_Angeles')
      returning id
    `;
  } else {
    await tx`update locations set name='Pawsh QA Salon',address='123 Test Avenue, Pasadena, CA 91101',timezone='America/Los_Angeles' where id=${location.id}`;
  }
  await tx`delete from business_hours where business_id=${businessId}`;
  for (const [weekday,start,end] of [[1,"08:00","18:00"],[2,"08:00","18:00"],[3,"08:00","18:00"],[4,"08:00","18:00"],[5,"08:00","18:00"],[6,"09:00","16:00"]] as const) {
    await tx`insert into business_hours(business_id,location_id,weekday,start_time,end_time) values (${businessId},${location!.id},${weekday},${start},${end})`;
  }

  const memberDefinitions = [
    ["manager@pawsh-test.example",managerPermissions],
    ["reception@pawsh-test.example",receptionistPermissions],
    ["grace@pawsh-test.example",groomerPermissions],
    ["gabriel@pawsh-test.example",groomerPermissions]
  ] as const;
  const memberships = new Map<string,string>();
  memberships.set("owner@pawsh-test.example",ownerMembership!.id);
  for (const [email,permissions] of memberDefinitions) {
    const userId = await ensureUser(email);
    const [membership] = await tx<{ id: string }[]>`
      insert into business_memberships(business_id,user_id,permissions,status)
      values (${businessId},${userId},${permissions as unknown as string[]},'active')
      on conflict (business_id,user_id) do update set permissions=excluded.permissions,status='active'
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
  const graceId = await ensureEmployee("Grace Groomer","grace@pawsh-test.example",[1,2,3,4,5],["Full Groom","Bath & Brush","Nail Trim","De-shedding"],"08:00","16:00");
  const gabrielId = await ensureEmployee("Gabriel Groomer","gabriel@pawsh-test.example",[2,3,4,5,6],["Full Groom","Bath & Brush","Nail Trim","Puppy Groom"],"09:00","17:00");

  const customerDefinitions = [
    ["Emma","Johnson","626-555-0101","emma.johnson@pawsh-test.example"],
    ["Daniel","Martinez","626-555-0102","daniel.martinez@pawsh-test.example"],
    ["Sophia","Chen","626-555-0103","sophia.chen@pawsh-test.example"],
    ["Michael","Williams","626-555-0199","michael.search@pawsh-test.example"],
    ["Avery","Thompson","626-555-0105","avery.archive@pawsh-test.example"]
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
    ["avery.archive@pawsh-test.example","Daisy","Beagle","2018-03-14",496,"Female",null,null,null,null,null]
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
  await tx`delete from blocked_times where business_id=${businessId} and reason like 'QA seed:%'`;
  const anchor = new Date(process.env.QA_ANCHOR_DATE ?? Date.now());
  const daysUntilMonday = (8 - anchor.getUTCDay()) % 7 || 7;
  const monday = new Date(Date.UTC(anchor.getUTCFullYear(),anchor.getUTCMonth(),anchor.getUTCDate()+daysUntilMonday,19,30));
  await tx`insert into blocked_times(business_id,employee_id,start_at,end_at,reason,created_by) values (${businessId},${graceId},${monday},${new Date(monday.getTime()+30*60_000)},'QA seed: Lunch',${ownerId})`;
  const gabrielBlock = new Date(monday.getTime()+26.5*60*60_000);
  await tx`insert into blocked_times(business_id,employee_id,start_at,end_at,reason,created_by) values (${businessId},${gabrielId},${gabrielBlock},${new Date(gabrielBlock.getTime()+30*60_000)},'QA seed: Personal',${ownerId})`;
  const [historical] = await tx<{ id: string }[]>`
    select id from appointments where business_id=${businessId} and notes='QA seed: Legacy historical snapshot' limit 1
  `;
  if (!historical) {
    const historicalStart = new Date(monday.getTime()-7*24*60*60_000);
    const [appointment] = await tx<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,status,notes,created_by,updated_by)
      values (${businessId},${location!.id},${customers.get("avery.archive@pawsh-test.example")!},
        ${pets.get("avery.archive@pawsh-test.example:Daisy")!},${gabrielId},${historicalStart},
        ${new Date(historicalStart.getTime()+75*60_000)},'completed','QA seed: Legacy historical snapshot',${ownerId},${ownerId})
      returning id
    `;
    await tx`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment!.id},${services.get("Legacy Groom")!},'Legacy Groom',75,7000)
    `;
  }
});

await sql.end();
console.log("Pawsh manual QA seed complete");
