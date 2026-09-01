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
  });
});
