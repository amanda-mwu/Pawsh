import { readFile, readdir } from "node:fs/promises";
import { parse } from "pgsql-parser";
import { describe, expect, it } from "vitest";

/**
 * Reads a migration with its line endings normalised.
 *
 * Git checks this repository out with CRLF on Windows, so an assertion that spans a line break
 * matches on Linux and macOS and fails on a Windows runner - which is exactly the kind of defect
 * the cross-platform matrix exists to catch, and no reason to restrict these assertions to a
 * single line each.
 */
async function readMigration(file: string): Promise<string> {
  return (await readFile(`migrations/${file}`, "utf8")).replaceAll("\r\n", "\n");
}

describe("database migrations", () => {
  it("parses as PostgreSQL SQL", async () => {
    const migrations = (await readdir("migrations")).filter((file) => file.endsWith(".sql")).sort();
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    for (const migration of migrations) {
      const source = await readMigration(migration);
      const tree = await parse(source);
      expect(tree.stmts?.length ?? 0, migration).toBeGreaterThan(0);
    }
  });

  it("contains release-critical constraints", async () => {
    const source = await readMigration("0001_initial.sql");
    expect(source).toContain("employee_appointment_no_overlap");
    expect(source).toContain("prevent_last_owner_loss");
    expect(source).toContain("create policy tenant_isolation");
    expect(source).toContain("one_active_invoice_per_appointment");
    const scheduling = await readMigration("0002_scheduling_conflict_overrides.sql");
    expect(scheduling).toContain("employee_appointment_conflict_guard");
    expect(scheduling).toContain("pg_advisory_xact_lock");
    expect(scheduling).toContain("app.scheduling_conflict_override_appointment_id");
    const petVersions = await readMigration("0003_pet_versions.sql");
    expect(petVersions).toContain("add column version integer not null default 1");
    expect(petVersions).toContain("pet_version_positive");
    const petCare = await readMigration("0004_pet_care_permissions.sql");
    expect(petCare).toContain("update business_memberships");
    expect(petCare).toContain("update membership_invitations");
    expect(petCare).toContain("pets.care.view");
    expect(petCare).toContain("pets.care.edit");
    const petDocuments = await readMigration("0005_pet_documents.sql");
    expect(petDocuments).toContain("one_current_pet_document");
    expect(petDocuments).toContain("pet_document_lifecycle_guard");
    expect(petDocuments).toContain("foreign key (business_id,pet_id) references pets(business_id,id)");
    expect(petDocuments).toContain("create policy tenant_isolation on pet_documents");
    expect(petDocuments).toContain("create policy tenant_isolation on pet_document_requests");
    const malwareProtection = await readMigration("0009_document_malware_protection.sql");
    expect(malwareProtection).toContain("create table pet_document_scan_attempts");
    expect(malwareProtection).toContain("pet_document_scan_attempts_immutable");
    expect(malwareProtection).toContain("state in ('pending','pending_scan','rejected','current','superseded')");
    const rabiesCompliance = await readMigration("0010_rabies_appointment_compliance.sql");
    expect(rabiesCompliance).toContain("pet_rabies_verification_consistency");
    expect(rabiesCompliance).toContain("unique_notification_material_recipient");
    expect(rabiesCompliance).toContain("0010_rabies_appointment_compliance");
    expect(malwareProtection).toContain("create policy tenant_isolation on pet_document_scan_attempts");
    const attachmentMvp = await readMigration("0011_rabies_attachment_mvp.sql");
    expect(attachmentMvp).toContain("old.state='pending' and new.state not in ('pending','current','pending_scan')");
    const pricingCatalog = await readMigration("0012_service_pricing_and_breed_catalog.sql");
    expect(pricingCatalog).toContain("create table service_price_tiers");
    expect(pricingCatalog).toContain("create table business_breeds");
    expect(pricingCatalog).toContain("pricing_class_snapshot");
    const workspaceAccess = await readMigration("0014_workspace_access_requests.sql");
    expect(workspaceAccess).toContain("create table workspace_access_requests");
    expect(workspaceAccess).toContain("one_pending_workspace_access_request");
    expect(workspaceAccess).toContain("create policy tenant_isolation on workspace_access_requests");
    const multiGroomer = await readMigration("0015_multi_groomer_booking.sql");
    expect(multiGroomer).toContain("create table appointment_employees");
    expect(multiGroomer).toContain("appointment_employee_conflict_guard");
    expect(multiGroomer).toContain("one_active_normalized_service_name");
    expect(multiGroomer).toContain("'Ear Cleaning'");
    expect(multiGroomer).toContain("'Ear Plucking'");
    const sessionLocations = await readMigration("0018_session_location_selection.sql");
    expect(sessionLocations).toContain("drop index if exists one_active_location_per_business");
    expect(sessionLocations).toContain("alter table sessions add column location_id uuid");
    expect(sessionLocations).toContain("sessions_location_within_business");
    expect(sessionLocations).toContain("references locations(business_id,id)");
    const clientProfile = await readMigration("0019_client_notes_and_preferences.sql");
    expect(clientProfile).toContain("create table customer_notes");
    expect(clientProfile).toContain("foreign key (business_id, customer_id) references customers(business_id, id)");
    expect(clientProfile).toContain("create policy tenant_isolation on customer_notes");
    expect(clientProfile).toContain("customer_note_legacy_mirror");
    expect(clientProfile).toContain("customer_booking_frequency_weeks_range");
    expect(clientProfile).toContain("add column marketing_sms_allowed boolean not null default true");
    const clientAgreements = await readMigration("0020_client_agreements.sql");
    expect(clientAgreements).toContain("create table agreement_templates");
    expect(clientAgreements).toContain("create table customer_agreements");
    expect(clientAgreements).toContain("customer_agreement_state_consistency");
    expect(clientAgreements).toContain("foreign key (business_id, customer_id) references customers(business_id, id)");
    expect(clientAgreements).toContain("foreign key (business_id, agreement_template_id) references agreement_templates(business_id, id)");
    expect(clientAgreements).toContain("create policy tenant_isolation on agreement_templates");
    expect(clientAgreements).toContain("create policy tenant_isolation on customer_agreements");
    expect(clientAgreements).toContain("one_open_agreement_notification");
    // Sending reuses the email-only outbox; the channel enum stays untouched.
    expect(clientAgreements).not.toContain("channel in ('email','sms')");

    // The legacy breed cleanup is an explicit allow-list with a price guard. Both properties are
    // asserted here because losing either turns a reviewed cleanup into a silent repricing.
    const legacyBreeds = await readMigration("0031_resolve_safe_legacy_breeds.sql");
    expect(legacyBreeds).toContain("'yorkie', 'dog', 'yorkshire terrier'");
    expect(legacyBreeds).toContain("'STANDARD'");
    // Neither fold may be added without a product decision: both move EXTRA_FLOOF -> STANDARD.
    expect(legacyBreeds).not.toContain("'sheep dog', 'dog', 'old english sheepdog'");
    expect(legacyBreeds).not.toContain("'irish water dog', 'dog', 'irish water spaniel'");
    // The consolidation migration retires two names and reclasses one, and must refuse to run
    // where any pet references them rather than silently repricing that salon's book.
    const consolidation = await readMigration("0032_consolidate_water_spaniel_and_retire_sheep_dog.sql");
    expect(consolidation).toContain("raise exception");
    expect(consolidation).toContain("would be repriced");
    expect(consolidation).toContain("'EXTRA_FLOOF'");
    expect(consolidation).toContain("'SAFE_EXACT_ALIAS'");
    // "Sheep Dog" is retired, never repointed: no alias row may be created for it.
    expect(consolidation).not.toContain("'sheep dog', 'SAFE_EXACT_ALIAS'");
    expect(consolidation).not.toContain("old english sheepdog',");
    expect(clientAgreements).not.toContain("alter column channel");

    // Business-owned breeds share the `breeds` table with the curated taxonomy, so the
    // properties that keep the two partitions apart are release-critical. Each of these, lost,
    // turns a business's own addition into something that reaches other tenants.
    const businessBreeds = await readMigration("0033_business_owned_breeds.sql");
    // The shared taxonomy keeps the uniqueness it had; added names are scoped per business.
    expect(businessBreeds).toContain("create unique index breed_shared_name on breeds (pet_type_id, normalized_name)\n  where business_id is null");
    expect(businessBreeds).toContain("create unique index breed_business_name on breeds (business_id, pet_type_id, normalized_name)\n  where business_id is not null");
    // The 0001 tenant_isolation loop is a one-time do-block; this table carries its own policies.
    expect(businessBreeds).toContain("alter table breeds enable row level security");
    expect(businessBreeds).toContain("create policy shared_taxonomy_read on breeds");
    expect(businessBreeds).toContain("create policy tenant_isolation on breeds");
    // A shared breed and a business breed may never share a name; a pet may never reference
    // another account's breed. Neither is expressible as a unique index or a foreign key.
    expect(businessBreeds).toContain("breed_name_scope_guard");
    expect(businessBreeds).toContain("pet_breed_tenant_guard");
    expect(businessBreeds).toContain("a pet cannot reference a breed owned by another business");
    // Pets are never cascaded: dropping a pet's breed_id would silently reprice it to STANDARD.
    expect(businessBreeds).not.toContain("references breeds(pet_type_id, id) on delete cascade");

    // Square Terminal. Each of these, lost, turns a payment integration into a way to charge a
    // card twice, to keep a credential the merchant revoked, or to reach another salon's device.
    const square = await readMigration("0036_square_terminal_integration.sql");
    // The structural guarantee against double-posting under webhook retries.
    expect(square).toContain(
      "create unique index payment_provider_reference\n  on payments (business_id, provider, provider_payment_id) where provider is not null"
    );
    // A provider with no reference sits outside that index, so it must not be representable.
    expect(square).toContain("payment_provider_identity");
    // Credentials are business-scoped and never per location.
    expect(square).toContain("business_id uuid not null unique references businesses(id)");
    // A revoked or disconnected connection holds no tokens at all.
    expect(square).toContain("square_connection_token_presence");
    // A revocation event carries a merchant and nothing else, so the lookup must not assume one
    // merchant maps to one business.
    expect(square).toContain("create index square_connection_merchant");
    expect(square).not.toContain("create unique index square_connection_merchant");
    // Tenant-qualified foreign keys: a checkout cannot reach another business's invoice, device
    // or payment.
    expect(square).toContain("foreign key (business_id, invoice_id) references invoices(business_id, id)");
    expect(square).toContain("foreign key (business_id, device_id) references square_devices(business_id, id)");
    expect(square).toContain("foreign key (business_id, payment_id) references payments(business_id, id)");
    expect(square).toContain("foreign key (business_id, location_id) references locations(business_id, id)");
    // A device cannot claim to be paired without the device id and the moment it happened.
    expect(square).toContain("square_device_pairing_consistency");
    // The webhook inbox dedupes in the database, and its policy admits the rows that arrive
    // before a tenant is known.
    expect(square).toContain("event_id text not null unique");
    expect(square).toContain("create policy tenant_isolation on square_webhook_events");
    // The inbox is gated on the CONTEXT, not on the column. An unconditional "or business_id is
    // null" arm would let any salon's session read every unresolved row - other merchants' ids,
    // device codes and raw payloads - so that exact shape must never come back.
    expect(square).not.toContain("using (business_id is null or business_id =");
    // Admitted only when there is no tenant context at all - the receiver and the drain.
    expect(square).toContain("nullif(current_setting('app.business_id', true), '') is null");
    expect(square).toContain("or business_id = nullif(current_setting('app.business_id', true), '')::uuid");
    // There is no second ledger: payments is the ledger.
    expect(square).not.toContain("create table square_payments");
    // The chosen Square location lives on the device row; the list is fetched live.
    expect(square).not.toContain("create table square_locations");

    const refunds = await readMigration("0038_payment_refunds.sql");
    // A refund is its own row. A negative payment is unrepresentable and must stay that way, and
    // widening `payment_status` would break the void route's `sum(amount_minor) where
    // status='recorded'` arithmetic and every report that trusts it.
    expect(refunds).toContain("create table payment_refunds");
    expect(refunds).toContain("amount_minor integer not null check (amount_minor > 0)");
    expect(refunds).not.toContain("alter type payment_status");
    // Tenant-qualified foreign keys on both sides: a refund cannot reach another business's
    // payment or invoice. `payments_business_scoped_key` from 0036 is what makes the first one
    // expressible at all.
    expect(refunds).toContain("foreign key (business_id, payment_id) references payments(business_id, id)");
    expect(refunds).toContain("foreign key (business_id, invoice_id) references invoices(business_id, id)");
    // Two rows claiming one Square refund are two rows counting the same money twice.
    expect(refunds).toContain(
      "create unique index payment_refund_provider_reference\n"
      + "  on payment_refunds (business_id, provider, provider_refund_id) where provider is not null"
    );
    // A key is one request, so re-deriving it must find the row that already holds it.
    expect(refunds).toContain("create unique index payment_refund_idempotency_per_business");
    // Two concurrent refunds of one payment must not both believe they are attempt two, which is
    // the one way two different requests could derive the same key.
    expect(refunds).toContain("unique (business_id, payment_id, attempt)");
    // Square's Refunds API caps the key at 45 characters; Terminal allows 64 and this is not that.
    expect(refunds).toContain("idempotency_key text not null check (char_length(idempotency_key) between 1 and 45)");
    // A completed refund must carry its provider reference; the rows allowed to name a provider
    // without one are those that have not been given one yet or never will be.
    expect(refunds).toContain("payment_refund_provider_identity");
    expect(refunds).toContain("status in ('pending', 'failed')");
    // Settled exactly when completed, and the tip can never be more of a refund than the refund is.
    expect(refunds).toContain("payment_refund_settlement_time");
    expect(refunds).toContain("payment_refund_tip_within_amount");
    // The invoice's own money does not move. Nothing here alters a total, a tip or a balance.
    expect(refunds).not.toContain("alter table invoices");
    expect(refunds).not.toContain("update invoices");
    // An invoice whose money went back is not a paid invoice.
    expect(refunds).toContain("alter type invoice_status add value if not exists 'partially_refunded'");
    expect(refunds).toContain("alter type invoice_status add value if not exists 'refunded'");
    // Refunding is replay-protected like every other financial operation.
    expect(refunds).toContain("'payment.refund'");
    expect(refunds).toContain("create policy tenant_isolation on payment_refunds");

    // 0039 closes the recovery gaps. Each of these, lost, puts money back in a place nobody is
    // looking: a payment resolved into the wrong salon's ledger, a checkout nothing ever revisits,
    // or an event retried until the end of time.
    const recovery = await readMigration("0039_square_recovery_and_dead_letters.sql");
    // The two identities an event resolves a tenant through must be unique across the WHOLE table,
    // because the lookups that use them have no business id to filter by - resolving the business
    // is what they are for. Per-business uniqueness let two rows in different salons hold one
    // Square id and made the resolution arbitrary.
    expect(recovery).toContain(
      "create unique index square_checkout_identifier\n"
      + "  on square_terminal_checkouts (square_checkout_id) where square_checkout_id is not null"
    );
    expect(recovery).toContain(
      "create unique index payment_refund_identifier\n"
      + "  on payment_refunds (provider, provider_refund_id) where provider_refund_id is not null"
    );
    // The weaker per-business indexes are replaced, not kept alongside.
    expect(recovery).toContain("drop index square_checkout_identifier_per_business");
    expect(recovery).toContain("drop index payment_refund_provider_reference");
    // Tightening a unique index cannot assume the data already satisfies it: pre-existing
    // duplicates must stop the migration rather than have one of them silently win.
    expect(recovery).toContain("raise exception");
    expect(recovery).toContain("Resolve these by hand before applying 0039");
    // The sweep's claim schedule, and the partial indexes it claims through.
    expect(recovery).toContain("create index square_checkout_sweep_due");
    expect(recovery).toContain("create index payment_refund_sweep_due");
    // A refund finally has the state a checkout has had since 0036, and it cannot be reached
    // without the document that says what a person is being asked to look at.
    expect(recovery).toContain("check (status in ('pending', 'completed', 'failed', 'needs_review'))");
    expect(recovery).toContain("payment_refund_review_document");
    // An event that cannot be processed comes to rest instead of retrying forever, and rest means
    // carrying `processed_at` so the drain stops claiming it.
    expect(recovery).toContain("'dead_letter'");
    expect(recovery).toContain(
      "check ((status in ('processed', 'parked', 'dead_letter')) = (processed_at is not null))"
    );
    // Retention is NOT added, and must not be added without a replay window: `event_id` being
    // unique is the only thing refusing a replayed notification.
    expect(recovery).not.toContain("delete from square_webhook_events");

    // 0040 adds exactly two staff fields. What it must NOT add is as load-bearing as what it
    // does: each of the absences below is a product decision that a later migration adding the
    // column would quietly reverse.
    const staffFields = await readMigration("0040_staff_profile_fields.sql");
    // The colour slot is optional - null keeps the hash-derived colour every existing workspace
    // already sees - and its range is the durable outer bound, not the ten colours the palette
    // shipped with. Pinning it to the palette would need a second migration to add one colour;
    // the palette's real size is enforced by the API against `groomerPaletteSize`.
    expect(staffFields).toContain("add column color_slot smallint");
    expect(staffFields).toContain("check (color_slot is null or color_slot between 0 and 15)");
    // A colour is a label, not an identity: two groomers may share one.
    expect(staffFields).not.toContain("unique index employee_color_slot");
    // The staff phone is stored the way every other phone in this schema is stored - the typed
    // text plus a digits-only normalisation - so there is one convention and not two.
    expect(staffFields).toContain("add column phone text");
    expect(staffFields).toContain("add column normalized_phone text");
    expect(staffFields).toContain("employee_phone_normalization");
    // `display_name` stays the one name a groomer has; it is read in ~25 places.
    expect(staffFields).not.toContain("add column first_name");
    expect(staffFields).not.toContain("add column last_name");
    // The Staff screen's Email is the LINKED ACCOUNT's, reached through `membership_id`. A
    // column here would be a second copy of `users.email` with no sync path, and the eight
    // attribution joins would keep using the membership while the card showed something else.
    expect(staffFields).not.toContain("add column email");
    // `active` is the only activation concept and 0027's availability tables are the only owner
    // of when a groomer is bookable. A second toggle would be a rule with two answers.
    expect(staffFields).not.toContain("enable_booking");
    // `employees` is covered by the 0001 `tenant_isolation` do-block; this migration only adds
    // columns, so declaring a policy here would duplicate one that already exists.
    expect(staffFields).not.toContain("create policy tenant_isolation on employees");

    const roles = await readMigration("0041_roles.sql");
    expect(roles).toContain("create table roles");
    // THE COMPOSITE FOREIGN KEYS ARE THE POINT OF 0041. A plain `role_id uuid references
    // roles(id)` would accept a membership in one business pointing at another business's role,
    // and nothing else would catch it: the `tenant_isolation` policies do not enforce anything
    // while Pawsh connects as the table owner with no FORCE ROW LEVEL SECURITY (see 0033). A
    // constraint, unlike a policy, does apply to the owner - so this is the whole defence.
    expect(roles).toContain("foreign key (business_id, role_id) references roles (business_id, id)");
    expect(roles).toContain("unique (business_id, id)");
    // `restrict`, never `set null`: nulling the column would silently fall a member back onto the
    // transitional column and then, once that is dropped, onto nothing at all.
    expect(roles).toContain("on delete restrict");
    expect(roles).not.toContain("on delete set null");
    expect(roles).not.toContain("on delete cascade");
    // One role name per business, compared case-insensitively.
    expect(roles).toContain("create unique index roles_unique_name_per_business");
    expect(roles).toContain("on roles (business_id, lower(name))");
    // `roles` is created here, so like 0027 and 0033 it must declare its own policy: the bulk
    // loop in 0001 ran once and cannot cover a table that did not exist yet.
    expect(roles).toContain("create policy tenant_isolation on roles");
    // The three shipped preset names, and the name the empty set gets.
    expect(roles).toContain("'Groomer'");
    expect(roles).toContain("'Receptionist'");
    expect(roles).toContain("'Manager'");
    expect(roles).toContain("'No access'");
    expect(roles).toContain("Custom access ");
    // NO ADMIN OR OWNER ROLE. Owner authority is `is_owner` plus the `protect_last_owner` trigger
    // from 0001, and `can()` short-circuits on it. A role shadowing it would be a second way to
    // express one thing and would fight `prevent_last_owner_loss` the moment it was unassigned.
    expect(roles).not.toContain("'Admin'");
    expect(roles).not.toContain("'Owner'");
    // The old columns stay populated so this phase is revertible by reverting code alone. A drop
    // here would make the migration one-way on the riskiest change in the authorization path.
    expect(roles).not.toContain("drop column permissions");
    expect(roles).not.toContain("alter table business_memberships drop column");

    const retire = await readMigration("0042_retire_membership_permissions.sql");
    // The invariants that replace the dropped columns. Without these, "a non-owner with no role"
    // stays representable, and that state resolves to the EMPTY SET - a person silently locked out
    // by a code path that simply forgot. A check constraint, unlike a row policy, applies to the
    // table owner Pawsh connects as, so this one actually holds.
    expect(retire).toContain("membership_role_matches_ownership");
    expect(retire).toContain("check ((is_owner and role_id is null) or (not is_owner and role_id is not null))");
    expect(retire).toContain("live_invitation_requires_role");
    // The straggler conversion has to come BEFORE the columns are dropped, or the permission sets
    // it reads are already gone. Any membership that reached 0042 without a role - a legacy
    // invitation accepted after 0041 - is converted rather than silently emptied.
    expect(retire.indexOf("create temporary table straggler"))
      .toBeLessThan(retire.indexOf("drop column permissions"));
    expect(retire).toContain("alter table business_memberships drop column permissions");
    expect(retire).toContain("alter table membership_invitations drop column permissions");

    const addressBound = await readMigration("0046_business_address_bound.sql");
    // Character for character the bound `customer_addresses.address` has carried since 0025. The
    // salon's address is not a different kind of address from a client's, and the day the two
    // disagree is the day somebody argues for structured columns on one of them.
    expect(addressBound).toContain("location_address_bounded");
    expect(addressBound).toContain("check (char_length(btrim(address)) between 1 and 500)");
    const clientAddresses = await readMigration("0025_client_addresses_and_contacts.sql");
    expect(clientAddresses).toContain("check (char_length(btrim(address)) between 1 and 500)");
    // Adding a bound over existing rows fails the DEPLOY, not the request. This one is safe only
    // because nothing has ever written the column, so it must not quietly start rewriting data.
    expect(addressBound).not.toContain("update locations");
    expect(addressBound).not.toContain("not null");

    const preferences = await readMigration("0047_business_preferences.sql");
    // Every enum value spelled here is a wire value and a stored value with no mapping layer
    // between them, so the check constraints ARE the contract. A tuple in `@pawsh/domain` that
    // drifts from one of these produces a request the schema accepts and the database refuses.
    expect(preferences).toContain("check (business_type in ('mobile', 'salon', 'hybrid'))");
    expect(preferences).toContain("check (date_format in ('MM/DD/YYYY', 'DD/MM/YYYY'))");
    expect(preferences).toContain("check (hour_format in ('12', '24'))");
    expect(preferences).toContain("check (weight_unit in ('lb', 'kg'))");
    expect(preferences).toContain("check (appointment_lock in ('enabled', 'disabled'))");
    expect(preferences)
      .toContain("check (coupon_stacking in ('single', 'amount_first', 'percentage_first'))");
    // Null is the value "All", so the count must stay NULLABLE. A `not null` here would force a
    // sentinel integer to mean "all of them".
    expect(preferences).toContain("add column upcoming_appointment_count integer,");
    expect(preferences).toContain("upcoming_appointment_count between 1 and 20");
    // The same bound `customers.booking_frequency_weeks` carries in 0019, because this is the
    // default that seeds that column. A default outside its range saves and then fails on use.
    const clientPreferences = await readMigration("0019_client_notes_and_preferences.sql");
    expect(clientPreferences).toContain("booking_frequency_weeks between 1 and 104");
    expect(preferences).toContain("default_service_frequency_weeks between 1 and 104");
    // The four link columns take the address bound, so blank cannot become a third way of saying
    // "not recorded" alongside null and absent.
    for (const column of ["website", "social_facebook", "social_google", "social_yelp"]) {
      expect(preferences, column)
        .toContain(`check (${column} is null or char_length(btrim(${column})) between 1 and 500)`);
    }
    // Every not-null column added over a populated table carries a default, or the deploy fails.
    // The defaults are what existing workspaces already behave as - see the note in the migration.
    for (const declaration of [
      "add column business_type text not null default 'salon'",
      "add column date_format text not null default 'MM/DD/YYYY'",
      "add column hour_format text not null default '12'",
      "add column weight_unit text not null default 'lb'",
      "add column appointment_lock text not null default 'disabled'",
      "add column coupon_stacking text not null default 'single'"
    ]) {
      expect(preferences, declaration).toContain(declaration);
    }
    // Columns on `businesses`, not a `business_settings` side table: the three preferences this
    // screen already saves live there, and a 1:1 table would cost a join, a bootstrap path and a
    // policy at every call site. If this ever starts failing the storage decision was revisited.
    expect(preferences).toContain("alter table businesses");
    expect(preferences).not.toContain("create table business_settings");

    // 0048 is the Coupon & Discount schema. What it must NOT do is as load-bearing as what it
    // does, and each absence below is a decision a later migration could quietly reverse.
    const discounts = await readMigration("0048_discounts_and_coupons.sql");
    expect(discounts).toContain("create table discounts");
    expect(discounts).toContain("create table coupons");
    expect(discounts).toContain("create table coupon_redemptions");
    expect(discounts).toContain("create table invoice_discounts");

    // THE DEFAULT DESCRIBES TODAY. One `discount_minor` column is one discount, so any other
    // default would be this migration silently widening what checkout permits for every existing
    // salon. The stacking rule sits on `businesses` beside `currency` and `tax_rate_basis_points`,
    // NOT on `locations`, because that is where money-shaped configuration already lives and
    // because checkout already joins `businesses` for the tax rate.
    expect(discounts).toContain("alter table businesses");
    expect(discounts).toContain("add column discount_stacking_mode text not null default 'one_per_appointment'");
    expect(discounts).toContain("check (discount_stacking_mode in ('one_per_appointment', 'amount_first', 'percentage_first'))");
    expect(discounts).not.toContain("alter table locations");

    // The composite foreign keys, which are the defence that actually holds: the `tenant_isolation`
    // policies do not enforce anything while Pawsh connects as the table owner with no FORCE ROW
    // LEVEL SECURITY (see 0033 and 0041), but a constraint applies to the owner too. Without these
    // a redemption in one business could point at another business's coupon.
    expect(discounts).toContain("foreign key (business_id, coupon_id) references coupons (business_id, id)");
    expect(discounts).toContain("foreign key (business_id, invoice_id) references invoices (business_id, id)");
    expect(discounts).toContain("foreign key (business_id, customer_id) references customers (business_id, id)");
    expect(discounts).toContain("foreign key (business_id, discount_id) references discounts (business_id, id)");
    expect((discounts.match(/unique \(business_id, id\)/g) ?? []).length).toBe(4);

    // ONE INVOICE CONSUMES ONE COUPON ONCE. The checkout locks the coupon row before counting, so
    // this is the structural backstop for the day that lock is lost or bypassed.
    expect(discounts).toContain("unique (business_id, coupon_id, invoice_id)");

    // THE TWO INDEX RULES, AND THEY ARE OPPOSITES. A discount name is released when the discount
    // retires - only staff ever saw it - so its unique index is PARTIAL on `active`. A coupon code
    // was printed and handed to a customer, so it stays claimed for the life of the business and
    // its index is NOT partial: a redeemed code must never be re-issued meaning something else.
    expect(discounts).toContain("create unique index discount_name_per_business on discounts (business_id, lower(btrim(name)))\n  where active");
    expect(discounts).toContain("create unique index coupon_code_per_business on coupons (business_id, upper(btrim(code)));");
    expect(discounts).not.toContain("create unique index coupon_code_per_business on coupons (business_id, upper(btrim(code)))\n  where active");

    // Case-insensitive and business-scoped, both of them.
    expect(discounts).toContain("upper(btrim(code))");
    expect(discounts).toContain("lower(btrim(name))");

    // The value pairing: exactly one of the two columns is set, and `kind` decides which. Without
    // it a row could carry both and the fold would silently pick one.
    expect(discounts).toContain("discount_value_matches_kind");
    expect(discounts).toContain("coupon_value_matches_kind");

    // `apply_scope` IS RECORDED FOR PERCENTAGES TOO. It changes no arithmetic there - 10% of a
    // bill is 10% of that bill however many pets it covers - and there is deliberately no CHECK
    // forbidding the combination, because that constraint would exist only to police a form.
    expect(discounts).toContain("apply_scope text not null default 'per_appointment'");
    expect(discounts).not.toContain("kind = 'percentage' and apply_scope");

    // NO DENORMALIZED COUNTER. `redeemed_count` would be a second source of truth for a number
    // `count(*)` over `coupon_redemptions` already answers, and keeping it honest would need the
    // same row lock the cap check takes anyway.
    // Matched as a COLUMN DECLARATION, not as the word: the header comment above says why the
    // counter is absent, and an assertion that banned the word would ban explaining the decision.
    expect(discounts).not.toMatch(/^\s*redeemed_count /m);
    // NO HARD DELETE. `active = false` is what a delete means here, because `invoice_discounts`
    // and `coupon_redemptions` reference these rows from historical invoices.
    expect(discounts).not.toContain("on delete cascade");
    expect(discounts).not.toContain("drop table");

    // THE BACKFILL IS WHAT MAKES "the breakdown sums to discount_minor" A TOTAL INVARIANT rather
    // than "total since 0048". It copies `discount_type` VERBATIM INCLUDING ITS NULLS - the client
    // renders a plain "Discount" for a null snapshot, which is what it renders today - and it
    // carries no status filter, because an invariant with an exception is not an invariant.
    expect(discounts).toContain("insert into invoice_discounts");
    expect(discounts).toContain("select business_id, id, 1, 'manual', discount_type, 'amount'");
    expect(discounts).toContain("where discount_minor > 0");
    expect(discounts).not.toContain("coalesce(discount_type,");
    expect(discounts).not.toContain("and status <> 'void'");
    // And it VERIFIES itself rather than trusting the insert: any invoice whose breakdown fails to
    // sum to its `discount_minor` aborts the migration.
    expect(discounts).toContain("raise exception");
    expect(discounts).toContain("does not sum to discount_minor");

    // RLS IS DECLARED IN 0048 ITSELF. 0034 shipped five tables without it and 0035 existed solely
    // to repair that; the bulk loop in 0001 cannot cover a table that did not exist yet.
    expect(discounts).toContain("create policy tenant_isolation on %I");
    expect(discounts).toContain("enable row level security");
    expect(discounts).toContain("'discounts', 'coupons', 'coupon_redemptions', 'invoice_discounts'");
    expect(discounts).toContain("0048_discounts_and_coupons");

    // 0049 promotes check-in and check-out from a client-side derivation over `audit_events` to
    // stored columns. Every assertion below is a decision that a later migration could reverse
    // without noticing what it was for.
    const lifecycle = await readMigration("0049_appointment_lifecycle_times.sql");
    expect(lifecycle).toContain("add column checked_in_at timestamptz");
    expect(lifecycle).toContain("add column checked_out_at timestamptz");
    // NULLABLE, NO DEFAULT. "Not checked in" is null, exactly as 0023 established for partial
    // client records - not an invented instant, and not `now()`.
    expect(lifecycle).toContain(
      "add column checked_in_at timestamptz,\n  add column checked_out_at timestamptz;"
    );

    // THE CONSTRAINT ONLY HAS AN OPINION WHEN BOTH ARE PRESENT, because a visit in progress has
    // a check-in and no check-out, and equality is admitted because a same-minute correction is
    // a real entry.
    expect(lifecycle).toContain("appointment_times_ordered");
    expect(lifecycle).toContain(
      "check (checked_out_at is null or checked_in_at is null or checked_out_at >= checked_in_at)"
    );

    // THE BACKFILL IS WHAT KEEPS THIS FROM BEING A VISIBLE REGRESSION. Without it every
    // appointment that shows a duration today would go blank, with nothing to distinguish that
    // from the data never having been recorded.
    expect(lifecycle).toContain("update appointments a");
    expect(lifecycle).toContain("select distinct on (resource_id) resource_id, business_id, created_at");
    expect(lifecycle).toContain("where action = 'appointment.checked_in'");
    expect(lifecycle).toContain("where action = 'appointment.completed'");
    // SCOPED BY BUSINESS as well as by id. `audit_events.resource_id` is an untyped uuid with no
    // foreign key, so this equality is the only thing keeping one salon's event off another
    // salon's appointment.
    expect((lifecycle.match(/event\.business_id = a\.business_id/g) ?? []).length).toBe(2);
    // And it VERIFIES itself before the constraint is asked to, so a failure names the problem.
    expect(lifecycle).toContain("raise exception");
    expect(lifecycle).toContain("check-out before its check-in");

    // A CANCELLATION IS NOT A CHECK-OUT. The client derivation treats `appointment.cancelled` and
    // `appointment.no_show` as ends of a visit; a cancelled visit did not end, it never began, so
    // neither action is read by the backfill and those rows stay "not recorded".
    expect(lifecycle).not.toContain("'appointment.cancelled'");
    expect(lifecycle).not.toContain("'appointment.no_show'");

    // NO SECOND TRANSITION LOG. `audit_events` already is Pawsh's transition log and `record()`
    // its only writer; a table here would be the two-sources-of-truth failure this schema keeps
    // warning about. And `end_at` is the SCHEDULE - deriving it from these would retroactively
    // widen the interval `employee_appointment_no_overlap` excludes on.
    expect(lifecycle).not.toMatch(/create table/);
    expect(lifecycle).not.toMatch(/set +end_at/);
    // NO INDEX. Nothing filters or sorts on either column; the calendar projection reads them
    // through `a.*` on rows already selected by `(business_id, start_at)`.
    expect(lifecycle).not.toContain("create index");
    expect(lifecycle).toContain("0049_appointment_lifecycle_times");

    // 0050 is the client credit ledger. Every assertion below is a decision whose reversal would
    // be silent: the schema would still apply, the routes would still compile, and money would be
    // wrong.
    const credit = await readMigration("0050_client_credit.sql");

    // THE BALANCE IS A SUM AND NOTHING ELSE. A stored counter on `customers` is the second source
    // of truth 0048 already refused for `coupons.redeemed_count`, and it is refused again here.
    expect(credit).not.toMatch(/alter table customers/);
    // The name appears in the header only, as the thing being refused - never as a column.
    expect(credit).not.toMatch(/credit_minor\s+(integer|bigint|numeric)/);

    // SIGNED, WHICH DIVERGES FROM THE NON-NEGATIVE CONVENTION EVERY OTHER MONEY COLUMN FOLLOWS.
    // The divergence is what buys the property: `sum(amount_minor)` IS the balance. Two
    // non-negative columns would make the balance a subtraction of two sums that no constraint
    // could relate to each other. A later migration "correcting" this to `>= 0` would silently
    // make every redemption add to the balance it was meant to spend.
    expect(credit).toContain("amount_minor integer not null check (amount_minor <> 0)");
    expect(credit).not.toContain("amount_minor integer not null check (amount_minor >= 0)");

    // The sign is tied to the kind, in the shape of 0048's `discount_value_matches_kind`, so a
    // redemption that ADDS credit is not representable at all.
    expect(credit).toContain("credit_entry_sign_matches_kind");
    expect(credit).toContain("(kind = 'grant' and amount_minor > 0)");
    expect(credit).toContain("or (kind = 'redemption' and amount_minor < 0)");
    expect(credit).toContain("or (kind = 'redemption_reversal' and amount_minor > 0)");
    // `adjustment` is the ONE kind admitting both signs, which is the whole reason it is a kind
    // separate from `grant`.
    expect(credit).toContain("or (kind = 'adjustment' and amount_minor <> 0)");

    // Which reference is set is decided by the kind, the `invoice_discount_source_reference` shape.
    expect(credit).toContain("credit_entry_source_reference");
    expect(credit).toContain("foreign key (business_id, payment_id) references payments (business_id, id)");
    expect(credit).toContain("foreign key (business_id, customer_id) references customers (business_id, id)");
    expect(credit).toContain("unique (business_id, id)");

    // A REASON IS REQUIRED FOR BOTH STAFF KINDS. The deduction is the case that earns it: taking
    // credit off an account is more contestable than giving it, and this row is where a dispute
    // lands. A later migration relaxing this to grants only would remove the record from exactly
    // the entry that needs one.
    expect(credit).toContain("credit_entry_reason_required");
    expect(credit).toContain("(kind in ('grant', 'adjustment')");

    // IMMUTABLE, following `pet_document_scan_attempts_immutable` in 0009. Update AND delete: a
    // ledger whose rows can be edited is a table with extra steps, and the balance is the sum of
    // what happened.
    expect(credit).toContain("before update or delete on customer_credit_entries");
    expect(credit).toContain("customer credit entries are immutable");

    // The two structural backstops, both keyed on `payment_id`. One payment produces at most one
    // redemption and at most one reversal, which is what stops a retried void crediting a balance
    // twice.
    expect(credit).toContain(
      "create unique index customer_credit_redemption_per_payment\n"
      + "  on customer_credit_entries (business_id, payment_id) where kind = 'redemption';"
    );
    expect(credit).toContain(
      "create unique index customer_credit_reversal_per_payment\n"
      + "  on customer_credit_entries (business_id, payment_id) where kind = 'redemption_reversal';"
    );

    // AND THE HEADER SAYS SO HONESTLY. Neither index prevents overdraft, because no index can
    // enforce an aggregate - so 0048's "this is what holds if that lock is ever lost" sentence is
    // NOT repeated here. The lock is the only guarantee, and the migration says that rather than
    // implying a backstop that does not exist. This assertion exists so nobody later pastes the
    // reassuring sentence in.
    expect(credit).toContain("NEITHER INDEX PREVENTS OVERDRAFT, AND NO INDEX CAN");
    expect(credit).not.toContain("This is what holds if that lock is ever lost");

    // `client_credit` IS ITS OWN SETTLEMENT TYPE AND NOT A KIND OF `other`, so it gets its own row
    // in the payment-method report and its own reversal rule.
    expect(credit).toContain(
      "check (method in ('cash', 'external_card', 'check', 'other', 'client_credit'))"
    );
    // ...and `payment_methods.settlement_type` from 0034 is deliberately NOT widened, so a salon
    // cannot configure a method that settles from a balance without debiting the ledger.
    expect(credit).not.toMatch(/alter table payment_methods/);

    // EASY TO MISS AND IT FAILS AT RUNTIME, NOT AT BUILD. `claimFinancialRequest` inserts the
    // operation as text, so an un-widened check surfaces as a 500 on the first grant.
    expect(credit).toContain("financial_idempotency_requests_operation_check");
    expect(credit).toContain("'credit.adjust'");
    // The four that already existed are still admitted; the widening is additive.
    for (const operation of [
      "'checkout.create-invoice'", "'payment.record'", "'payment.void'", "'payment.refund'"
    ]) {
      expect(credit, operation).toContain(operation);
    }

    // RLS declared here, for the reason 0048 restated: the bulk loop in 0001 cannot cover a table
    // that did not exist yet.
    expect(credit).toContain("alter table customer_credit_entries enable row level security");
    expect(credit).toContain("create policy tenant_isolation on customer_credit_entries");

    // NO GIFT CARDS. They need `invoices.appointment_id` to become nullable, which is a change to
    // the core financial model and an explicit non-goal. Nothing here touches it.
    // Both names appear in the header, as the things being deferred. Neither appears as DDL.
    expect(credit).not.toMatch(/alter table invoices/);
    expect(credit).not.toMatch(/create table gift/i);
    // NO EXPIRY. Expiring credit is taking money back on a timer, and nobody decided that.
    expect(credit).not.toMatch(/expires_at\s+(timestamptz|date)/);

    expect(credit).toContain("0050_client_credit");
  });
});
