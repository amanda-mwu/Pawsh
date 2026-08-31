/**
 * Directory volume for manual QA.
 *
 * The canonical QA tenant holds six recognisable clients, which is the right size for reading a
 * profile but too small to exercise anything the directory does at scale: paging, the page-size
 * choice, alphabetical and visit-based sorting, and the popup notes that greet whoever opens a
 * client. This adds a bounded, clearly-labelled block of extra clients to the same tenant and can
 * take them back out again.
 *
 * Every row it writes is identifiable: emails are `directory-###@pawsh-test.example`, notes are
 * prefixed `QA directory:`, and appointment notes carry the same prefix. Nothing here touches the
 * canonical six, and the safeguards match `seed-qa.ts` — this refuses to run against production or
 * against a database whose URL does not carry the explicit QA marker.
 */
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
const marker = process.env.PAWSH_QA_DATABASE_MARKER;

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

const remove = process.env.PAWSH_QA_DIRECTORY_REMOVE === "true";
const requested = Number(process.env.PAWSH_QA_DIRECTORY_CLIENTS ?? 45);
if (!Number.isInteger(requested) || requested < 1 || requested > 400) {
  throw new Error("PAWSH_QA_DIRECTORY_CLIENTS must be a whole number between 1 and 400");
}

// Names are paired by index rather than drawn at random so a re-run reproduces exactly the same
// directory: a QA note that says "Kara Ibarra is on page 3" stays true tomorrow. Both indices are
// rotated once per block of fifty, so asking for more clients than there are names still produces
// distinct people rather than a second copy of the first fifty.
const firstNames = [
  "Alice","Brandon","Camille","Derek","Elena","Felix","Gina","Hector","Imani","Jonah",
  "Kara","Liam","Maya","Noah","Olivia","Priya","Quinn","Rosa","Sean","Tessa",
  "Uma","Victor","Wanda","Xavier","Yuki","Zane","Adrian","Bianca","Caleb","Dahlia",
  "Elliot","Farah","Gabriel","Harper","Isaac","Jasmine","Kenji","Lucia","Marcus","Nadia",
  "Owen","Paige","Rafael","Sienna","Tobias","Vera","Warren","Yara","Zoe","Anika"
] as const;
const lastNames = [
  "Alvarez","Bennett","Castillo","Delgado","Ellison","Foster","Gallagher","Huang","Ibarra","Jensen",
  "Kowalski","Lombardi","Mercer","Nakamura","Okafor","Petrov","Quintero","Reyes","Sandoval","Tanaka",
  "Ueda","Vargas","Whitfield","Xiong","Yamada","Zielinski","Ashford","Brennan","Calderon","Donnelly",
  "Eriksen","Fitzgerald","Gutierrez","Halvorsen","Ivanov","Jimenez","Kaplan","Larkin","Moreau","Novak",
  "Ortega","Pham","Rivas","Sorensen","Thibault","Underwood","Vasquez","Weaver","Yates","Zamora"
] as const;
const petNames = [
  "Ziggy","Nala","Cooper","Willow","Moose","Pepper","Tucker","Juno","Bandit","Clover",
  "Otis","Sable","Rufus","Hazel","Gus","Marlow","Pixie","Barkley","Suki","Fig"
] as const;
const dogBreeds = [
  "Golden Retriever","Poodle","Beagle","Shih Tzu","Yorkshire Terrier","Australian Shepherd",
  "Border Collie","Havanese","Maltese","Cavalier King Charles Spaniel","Bichon Frise",
  "Labradoodle","Goldendoodle","Cocker Spaniel","Miniature Schnauzer"
] as const;
const catBreeds = ["Domestic Shorthair","Maine Coon","Siamese","Ragdoll","Persian"] as const;
// Deliberately outside the canonical taxonomy: one pet per block records a breed the salon typed
// itself, which is the path a real directory always ends up exercising.
const unlistedBreed = "Sardinian Shepherd Mix";
const coatColors = ["Black","Cream","Chocolate","Silver","Apricot","Brindle","Tricolour","White"] as const;
const shampoos = ["Oatmeal","Hypoallergenic","Medicated","Tearless puppy",null] as const;
const groomingPreferences = [
  "Half-inch body, feathering left long on the tail.",
  "Teddy-bear face, sanitary trim, no shave.",
  "De-shed and blow-out only; scissors on the feet.",
  "Short summer cut, ears rounded.",
  null
] as const;
const behaviourNotes = [
  "Settles once the dryer is off; hates the high setting.",
  "Nervous about paw handling — go slowly on the back feet.",
  "Very food motivated, will work for a treat between stages.",
  null,null
] as const;
const medicalNotes = [
  "Mild hip stiffness; keep standing time short.",
  "Sensitive skin, no fragranced product.",
  null,null,null
] as const;
const safetyAlerts = [
  "Muzzle required for nail trims.",
  "Has snapped at the clipper around the muzzle.",
  null,null,null,null
] as const;
const healthIssueSets: (string[] | null)[] = [
  ["arthritis","obesity"],
  [],
  null,
  ["fleas_ticks_mites"],
  null,
  ["heart_condition"]
];
const vets = [
  ["Arroyo Animal Hospital","626-555-0300","118 Foothill Blvd, Arcadia CA"],
  ["Foothill Veterinary Clinic","626-555-0311","44 Sierra Madre Blvd, Pasadena CA"],
  ["Sierra Madre Pet Care","626-555-0322","9 Baldwin Ave, Sierra Madre CA"]
] as const;
const day = 24 * 60 * 60 * 1000;
const dateOnly = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);
// Four shapes of client, cycled, so filters and empty states all have something to show:
// a plain active client, one with two pets, one with no pet at all, and an archived one.
const shapes = ["standard","multipet","petless","archived"] as const;

const sql = postgres(databaseUrl, { transform: postgres.camel });
const label = (index: number) => String(index + 1).padStart(3, "0");
const emailFor = (index: number) => `directory-${label(index)}@pawsh-test.example`;

console.log(`QA directory target: ${target.hostname}${target.pathname} (${process.env.NODE_ENV ?? "development"})`);

const summary = await sql.begin(async (tx) => {
  const [business] = await tx<{ id: string }[]>`
    select id from businesses where name='Pawsh QA Grooming' limit 1
  `;
  if (!business) {
    throw new Error("Pawsh QA Grooming is not seeded yet — run `npm run db:seed` first");
  }
  const businessId = business.id;
  const directoryEmails = tx`normalized_email like 'directory-%@pawsh-test.example'`;

  if (remove) {
    const doomed = await tx<{ id: string }[]>`
      select id from customers where business_id=${businessId} and ${directoryEmails}
    `;
    if (!doomed.length) return { removed: 0, kept: 0 };
    const ids = doomed.map((customer) => customer.id);
    const [blocking] = await tx<{ count: number }[]>`
      select count(*)::int count from appointments
      where business_id=${businessId} and customer_id in ${tx(ids)}
    `;
    // Appointments are removed with the clients that own them, but only ones this script wrote:
    // anything else means a person has been working in here and deleting it would lose their work.
    const [foreign] = await tx<{ count: number }[]>`
      select count(*)::int count from appointments
      where business_id=${businessId} and customer_id in ${tx(ids)}
        and (notes is null or notes not like 'QA directory:%')
    `;
    if ((foreign?.count ?? 0) > 0) {
      throw new Error(
        `Refusing to remove: ${foreign!.count} appointment(s) on these clients were not created by this seed`
      );
    }
    await tx`delete from appointment_services where business_id=${businessId}
      and appointment_id in (select id from appointments where business_id=${businessId} and customer_id in ${tx(ids)})`;
    await tx`delete from appointment_employees where business_id=${businessId}
      and appointment_id in (select id from appointments where business_id=${businessId} and customer_id in ${tx(ids)})`;
    await tx`delete from appointments where business_id=${businessId} and customer_id in ${tx(ids)}`;
    await tx`delete from pets where business_id=${businessId} and customer_id in ${tx(ids)}`;
    await tx`delete from customers where business_id=${businessId} and id in ${tx(ids)}`;
    return { removed: ids.length, appointments: blocking?.count ?? 0 };
  }

  const [owner] = await tx<{ userId: string }[]>`
    select user_id from business_memberships
    where business_id=${businessId} and is_owner order by created_at limit 1
  `;
  if (!owner) throw new Error("The QA tenant has no owner membership");
  const ownerId = owner.userId;
  const [location] = await tx<{ id: string; timezone: string }[]>`
    select id,timezone from locations where business_id=${businessId} and active order by created_at limit 1
  `;
  if (!location) throw new Error("The QA tenant has no active location");
  const employees = await tx<{ id: string }[]>`
    select id from employees where business_id=${businessId} and active order by display_name
  `;
  const services = await tx<{ id: string; name: string; baseDurationMinutes: number; basePriceMinor: number }[]>`
    select id,name,base_duration_minutes,base_price_minor from services
    where business_id=${businessId} and active order by name
  `;
  if (!employees.length || !services.length) {
    throw new Error("The QA tenant needs at least one active employee and service — run `npm run db:seed` first");
  }
  const [ownerMembership] = await tx<{ id: string }[]>`
    select id from business_memberships where business_id=${businessId} and is_owner order by created_at limit 1
  `;
  // Breeds are resolved against the canonical taxonomy rather than written as free text, so a
  // seeded pet is the same shape as one a salon creates: pet type, breed id, and the denormalised
  // name the directory reads. A name the taxonomy does not carry becomes an explicit
  // `breed_other`, which is how the product records a breed nobody has catalogued.
  const petTypes = await tx<{ id: string; name: string }[]>`select id,name from pet_types`;
  const typeIdFor = (name: string) => petTypes.find((type) => type.name.toLowerCase() === name)?.id ?? null;
  const dogTypeId = typeIdFor("dog");
  const catTypeId = typeIdFor("cat");
  const canonicalBreeds = await tx<{ id: string; name: string; petTypeId: string }[]>`
    select id,name,pet_type_id from breeds where business_id is null and active
  `;
  const breedKey = (petTypeId: string | null, name: string) => `${petTypeId ?? ""}:${name.toLowerCase()}`;
  const breedIds = new Map(canonicalBreeds.map((breed) => [breedKey(breed.petTypeId, breed.name), breed.id]));
  const resolveBreed = (petTypeId: string | null, name: string) => {
    const id = breedIds.get(breedKey(petTypeId, name)) ?? null;
    return id ? { breedId: id, breed: name, breedOther: null } : { breedId: null, breed: name, breedOther: name };
  };
  /**
   * Four rabies states, cycled: verified at the desk, owner-reported and current, expired, and
   * nothing on file. The table refuses a verified record that does not also carry the method, the
   * timestamp and the membership that checked it, so a tenant with no owner membership to name
   * records the same dates as owner-reported rather than claiming a verification that never
   * happened.
   */
  const rabiesFor = (seed: number) => {
    const blank = { method: null, verifiedAt: null, membership: null, reference: null };
    switch (seed % 4) {
      case 0:
        return ownerMembership
          ? { status: "staff_verified", vaccinated: dateOnly(-300), expires: dateOnly(430),
              method: "document_review", verifiedAt: new Date(), membership: ownerMembership.id,
              reference: `QA-${label(seed)}` }
          : { status: "unverified", vaccinated: dateOnly(-300), expires: dateOnly(430), ...blank };
      case 1:
        return { status: "unverified", vaccinated: dateOnly(-700), expires: dateOnly(25), ...blank };
      case 2:
        return { status: "unverified", vaccinated: dateOnly(-1100), expires: dateOnly(-40), ...blank };
      default:
        return { status: "not_provided", vaccinated: null, expires: null, ...blank };
    }
  };

  const created: string[] = [];
  const customerIds: string[] = [];
  // Rabies state cycles on the pet's position in the whole run rather than on its per-client
  // seed: the client shapes stride by three, which skipped one of the four states entirely and
  // left the directory with no expired vaccination to look at.
  let petOrdinal = 0;
  for (let index = 0; index < requested; index++) {
    const block = Math.floor(index / firstNames.length);
    const first = firstNames[(index + block * 13) % firstNames.length]!;
    const last = lastNames[(index * 7 + 3 + block) % lastNames.length]!;
    const shape = shapes[index % shapes.length]!;
    const email = emailFor(index);
    const phone = `626-556-${label(index)}1`;
    const normalizedPhone = phone.replace(/\D/g, "");
    const archivedAt = shape === "archived" ? new Date() : null;
    let [customer] = await tx<{ id: string }[]>`
      select id from customers where business_id=${businessId} and normalized_email=${email} limit 1
    `;
    if (!customer) {
      [customer] = await tx<{ id: string }[]>`
        insert into customers(business_id,first_name,last_name,phone,normalized_phone,email,normalized_email,
          preferred_contact_method,archived_at,created_by,updated_by)
        values (${businessId},${first},${last},${phone},${normalizedPhone},${email},${email},
          'email',${archivedAt},${ownerId},${ownerId}) returning id
      `;
      created.push(email);
    } else {
      await tx`update customers set first_name=${first},last_name=${last},phone=${phone},
        normalized_phone=${normalizedPhone},archived_at=${archivedAt},updated_by=${ownerId}
        where id=${customer.id}`;
    }
    const customerId = customer!.id;
    customerIds.push(customerId);

    const petCount = shape === "petless" ? 0 : shape === "multipet" ? 2 : 1;
    for (let petIndex = 0; petIndex < petCount; petIndex++) {
      const seed = index * 3 + petIndex;
      const name = petNames[seed % petNames.length]!;
      // Every ninth pet is a cat and every eleventh carries an uncatalogued breed, so the pet type
      // switch and the unlisted-breed path are both represented without hunting for them.
      const isCat = Boolean(catTypeId) && seed % 9 === 4;
      const petTypeId = isCat ? catTypeId : dogTypeId;
      const breedName = seed % 11 === 7
        ? unlistedBreed
        : isCat
          ? catBreeds[seed % catBreeds.length]!
          : dogBreeds[seed % dogBreeds.length]!;
      const selection = resolveBreed(petTypeId, breedName);
      const female = seed % 2 === 0;
      // A pet with no date of birth records an approximate age instead; both are real states in
      // the product and the profile renders them differently.
      const hasBirthday = seed % 5 !== 3;
      const rabies = rabiesFor(petOrdinal++);
      const profile = {
        species: isCat ? "cat" : "dog",
        petTypeId,
        ...selection,
        dateOfBirth: hasBirthday ? dateOnly(-(400 + (seed * 97) % 3600)) : null,
        approximateAgeYears: hasBirthday ? null : 1 + (seed % 12),
        approximateAgeMonths: hasBirthday ? null : seed % 12,
        weightOunces: 160 + ((seed * 37) % 1200),
        sex: female ? "Female" : "Male",
        fixedStatus: seed % 7 === 5 ? "intact" : female ? "spayed" : "neutered",
        hairLength: isCat
          ? (seed % 2 === 0 ? "Cat Short Hair" : "Cat Long Hair")
          : (seed % 3 === 0 ? "Smooth Single Coat" : "All Other Coats"),
        coatColor: coatColors[seed % coatColors.length]!,
        coatNotes: seed % 4 === 0 ? "Mats behind the ears if the brushing slips." : null,
        groomingPreferences: groomingPreferences[seed % groomingPreferences.length] ?? null,
        behaviorNotes: behaviourNotes[seed % behaviourNotes.length] ?? null,
        medicalNotes: medicalNotes[seed % medicalNotes.length] ?? null,
        safetyAlerts: safetyAlerts[seed % safetyAlerts.length] ?? null,
        preferredShampoo: shampoos[seed % shampoos.length] ?? null,
        healthIssues: healthIssueSets[seed % healthIssueSets.length] ?? null,
        emergencyContact: seed % 3 === 0 ? `${first} ${last} — ${phone}` : null,
        vaccinationNotes: rabies.status === "not_provided" ? "Owner is sending the certificate." : null,
        photoPermission: seed % 6 === 5 ? false : seed % 3 === 1 ? null : true,
        vet: vets[seed % vets.length]!
      };
      const [existing] = await tx<{ id: string }[]>`
        select id from pets where business_id=${businessId} and customer_id=${customerId} and name=${name} limit 1
      `;
      const petId = existing?.id ?? (await tx<{ id: string }[]>`
        insert into pets(business_id,customer_id,name,species,created_by,updated_by)
        values (${businessId},${customerId},${name},${profile.species},${ownerId},${ownerId}) returning id
      `)[0]!.id;
      await tx`
        update pets set archived_at=null,species=${profile.species},pet_type_id=${profile.petTypeId},
          breed_id=${profile.breedId},breed=${profile.breed},breed_other=${profile.breedOther},
          date_of_birth=${profile.dateOfBirth},approximate_age_years=${profile.approximateAgeYears},
          approximate_age_months=${profile.approximateAgeMonths},weight_ounces=${profile.weightOunces},
          sex=${profile.sex},fixed_status=${profile.fixedStatus},hair_length=${profile.hairLength},
          coat_color=${profile.coatColor},coat_notes=${profile.coatNotes},
          grooming_preferences=${profile.groomingPreferences},behavior_notes=${profile.behaviorNotes},
          medical_notes=${profile.medicalNotes},safety_alerts=${profile.safetyAlerts},
          preferred_shampoo=${profile.preferredShampoo},health_issues=${profile.healthIssues},
          emergency_contact=${profile.emergencyContact},vet_name=${profile.vet[0]},
          vet_phone=${profile.vet[1]},vet_address=${profile.vet[2]},
          photo_permission=${profile.photoPermission},vaccination_notes=${profile.vaccinationNotes},
          rabies_vaccination_date=${rabies.vaccinated},vaccination_expires_on=${rabies.expires},
          rabies_verification_status=${rabies.status},rabies_verification_method=${rabies.method},
          rabies_verified_at=${rabies.verifiedAt},rabies_verified_by_membership_id=${rabies.membership},
          rabies_certificate_reference=${rabies.reference},updated_by=${ownerId},updated_at=now()
        where id=${petId}
      `;
      // Rabies is not written here: the table refuses the name because rabies lives on the pet
      // itself, with its own verification trail. This list is the other vaccines a salon records,
      // and none of them carries a document because no file was ever uploaded.
      await tx`delete from pet_vaccinations where business_id=${businessId} and pet_id=${petId}
        and notes like 'QA directory:%'`;
      if (seed % 3 !== 1) {
        await tx`
          insert into pet_vaccinations(business_id,pet_id,vaccine,expires_on,notes,created_by,updated_by)
          values (${businessId},${petId},${isCat ? "FVRCP" : "Bordetella"},${dateOnly(200 - (seed % 5) * 90)},
            'QA directory: owner-reported',${ownerId},${ownerId})
        `;
      }
      if (seed % 4 === 0) {
        await tx`
          insert into pet_vaccinations(business_id,pet_id,vaccine,expires_on,notes,created_by,updated_by)
          values (${businessId},${petId},${isCat ? "FeLV" : "DHPP"},${dateOnly(320)},
            'QA directory: owner-reported',${ownerId},${ownerId})
        `;
      }
      await tx`delete from pet_notes where business_id=${businessId} and pet_id=${petId}
        and body like 'QA directory:%'`;
      if (seed % 3 !== 2) {
        await tx`
          insert into pet_notes(business_id,pet_id,body,pinned,created_by)
          values (${businessId},${petId},
            ${`QA directory: ${name} is booked with the quiet dryer; the ${profile.hairLength.toLowerCase()} takes the extra time.`},
            ${seed % 6 === 0},${ownerId})
        `;
      }
    }

    // Notes every fourth client, half of them flagged to pop up, so the popup dialog can be found
    // on more than one page of the directory and the single/multiple wording both get exercised.
    if (index % 4 === 0) {
      const popup = index % 8 === 0;
      const body = popup
        ? `QA directory: popup check — ${first} pays at pickup, do not invoice ahead.`
        : `QA directory: standing note — ${first} prefers the first appointment of the day.`;
      const [note] = await tx<{ id: string }[]>`
        select id from customer_notes where business_id=${businessId} and customer_id=${customerId}
          and body like 'QA directory:%' limit 1
      `;
      if (!note) {
        await tx`
          insert into customer_notes(business_id,customer_id,body,pinned,created_by)
          values (${businessId},${customerId},${body},${popup},${ownerId})
        `;
      } else {
        await tx`update customer_notes set body=${body},pinned=${popup},updated_at=now() where id=${note.id}`;
      }
      if (index % 8 === 0) {
        const second = `QA directory: second popup — confirm ${first}'s parking instructions.`;
        const [extra] = await tx<{ id: string }[]>`
          select id from customer_notes where business_id=${businessId} and customer_id=${customerId}
            and body like 'QA directory: second popup%' limit 1
        `;
        if (!extra && index % 16 === 0) {
          await tx`
            insert into customer_notes(business_id,customer_id,body,pinned,created_by)
            values (${businessId},${customerId},${second},true,${ownerId})
          `;
        }
      }
    }
  }

  // Visits for every third client so "Last visit", "Next appt." and their sort orders have real
  // values to order by rather than a column of dashes. Slots are spread one per hour across
  // distinct days and alternated between groomers, which keeps the no-double-booking constraint
  // satisfied without having to reason about the tenant's existing calendar.
  const dayStart = (offsetDays: number, hour: number) => {
    const when = new Date();
    when.setUTCHours(0, 0, 0, 0);
    when.setUTCDate(when.getUTCDate() + offsetDays);
    when.setUTCHours(hour, 0, 0, 0);
    return when;
  };
  let slot = 0;
  let appointments = 0;
  for (let index = 0; index < requested; index += 3) {
    const customerId = customerIds[index];
    if (!customerId) continue;
    const [pet] = await tx<{ id: string }[]>`
      select id from pets where business_id=${businessId} and customer_id=${customerId}
        and archived_at is null order by name limit 1
    `;
    if (!pet) continue;
    const employee = employees[slot % employees.length]!;
    const service = services[slot % services.length]!;
    const past = slot % 2 === 0;
    const start = past
      ? dayStart(-14 - Math.floor(slot / 6), 16 + (slot % 6))
      : dayStart(3 + Math.floor(slot / 6), 16 + (slot % 6));
    const end = new Date(start.getTime() + service.baseDurationMinutes * 60_000);
    const notes = `QA directory: ${past ? "past" : "upcoming"} visit`;
    const [existing] = await tx<{ id: string }[]>`
      select id from appointments where business_id=${businessId} and customer_id=${customerId}
        and notes=${notes} limit 1
    `;
    slot++;
    if (existing) continue;
    const [appointment] = await tx<{ id: string }[]>`
      insert into appointments(business_id,location_id,customer_id,pet_id,employee_id,start_at,end_at,
        scheduling_timezone,scheduled_local_start,scheduled_utc_offset_minutes,status,notes,created_by,updated_by)
      values (${businessId},${location.id},${customerId},${pet.id},${employee.id},${start},${end},
        ${location.timezone},${start}::timestamptz at time zone ${location.timezone},
        extract(epoch from ((${start}::timestamptz at time zone ${location.timezone})
          -(${start}::timestamptz at time zone 'UTC')))/60,
        ${past ? "completed" : "scheduled"},${notes},${ownerId},${ownerId})
      on conflict do nothing returning id
    `;
    if (!appointment) continue;
    await tx`
      insert into appointment_services(business_id,appointment_id,service_id,service_name_snapshot,
        duration_minutes_snapshot,price_minor_snapshot)
      values (${businessId},${appointment.id},${service.id},${service.name},
        ${service.baseDurationMinutes},${service.basePriceMinor})
    `;
    await tx`
      insert into appointment_employees(business_id,appointment_id,employee_id)
      values (${businessId},${appointment.id},${employee.id})
    `;
    appointments++;
  }

  const [total] = await tx<{ count: number }[]>`
    select count(*)::int count from customers where business_id=${businessId} and ${directoryEmails}
  `;
  const [popups] = await tx<{ count: number }[]>`
    select count(*)::int count from customer_notes
    where business_id=${businessId} and pinned and body like 'QA directory:%'
  `;
  return { created: created.length, total: total?.count ?? 0, appointments, popups: popups?.count ?? 0 };
});

await sql.end();
if (remove) {
  console.log(`Pawsh QA directory removed: ${summary.removed} client(s)`);
} else {
  console.log(
    `Pawsh QA directory seed complete: ${summary.total} directory clients `
    + `(${summary.created} new), ${summary.appointments} appointment(s), ${summary.popups} popup note(s)`
  );
  console.log("Remove them again with: npm run db:seed-directory -- --remove");
}
