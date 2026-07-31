# D3.1 — Pet Care Authorization Terminology Migration

## Classification

D3.1 — Pet Care Authorization Terminology Migration Valid.

This closure extends D3 without rewriting its historical evidence. It does not
validate pet document management, D4, or Controlled Pilot readiness.

## Canonical authorization contract

Active authorization uses only:

- `pets.care.view` for protected Pet Care visibility;
- `pets.edit` plus `pets.care.edit` for protected Pet Care mutation.

The protected set remains `safetyAlerts`, `medicalNotes`, `behaviorNotes`,
`emergencyContact`, `veterinarian`, `vaccinationNotes`, and
`vaccinationExpiresOn`. Concrete field and product phrases such as “Safety
alert” retain their specific meaning.

The active API route is `PUT /api/pets/:id/care`. Permission definitions,
presets, invitations, membership updates, QA seeds, fixtures, frontend checks,
redaction, and direct API authorization use the canonical identifiers. An old
identifier in an invitation or permission-update request receives the existing
schema-validation response, HTTP 400; no input alias or silent canonicalization
exists.

## Persisted permission migration

Migration `0004_pet_care_permissions.sql` canonicalizes both
`business_memberships.permissions` and unaccepted or retained
`membership_invitations.permissions`. For each array it substitutes the two old
identifiers, preserves unrelated entries, removes duplicates, and retains the
first occurrence’s deterministic ordering. It does not update membership
status, timestamps, or unrelated columns.

The PostgreSQL test covers old view, old edit, both, each mixed old/new form,
all old/new forms, neither, unrelated permissions, and active, invited, and
disabled memberships. It computes the expected canonical set for every
membership and compares it to the actual migrated array. Invitations receive
the same verification. Running the migration twice produces the same result,
and the final count of persisted old identifiers is zero.

A fresh migration replay may encounter the historical names in pre-0004 data,
but its final active authorization state contains only `pets.care.*`.

## Audit continuity

Historical immutable rows retain machine event `pet.safety.update`. The audit
reader returns those rows unchanged. New protected mutations emit
`pet.care.update`, with the existing changed-field-only, non-sensitive payload
and exact cardinality. Historical event recognition is read-only and grants no
authorization compatibility.

## Security and regression evidence

D3 coverage proves:

- without `pets.care.view`, protected values remain redacted;
- `pets.edit` alone cannot change protected fields;
- `pets.edit` plus `pets.care.edit` can perform the versioned care update;
- stale version rejection, hidden-field preservation, tenant isolation,
  financial-history projection, and truthful care-audit behavior remain intact;
- owner authority and all unrelated permissions remain unchanged.

Repository search finds old authorization strings only in migration logic,
explicit rejection/migration tests, and historical documentation. Active code,
presets, fixtures, seeds, and current architecture records do not depend on
them.

## Implementation evidence

Implementation commits:

- `de57af0a3bc7a20e42e3e1e84b5521ae1029e15f`
- `a8e447d61edee9d8bd326f989442c2bd6a2eb146`

Implementation CI
[30647022631](https://github.com/amanda-mwu/Pawsh/actions/runs/30647022631)
passed all 13 required jobs. PostgreSQL applied migration 0004 and passed 42
tests across seven files in 6.36 seconds. Chromium regression passed the full
D1–D3 suite, and every inherited smoke, security, cross-browser, responsive,
static, runtime, migration, and backup/restore job passed.

The authoritative closure is the clean documentation-containing final HEAD
reported in the final report and proven by its own full CI run. Its SHA is not
embedded because doing so would create a different SHA.

## Remaining scope

Pet documents, D4 checkout/stale/error paths, Automated Critical Regression,
accessibility, time edges, pilot performance, staging, manual UX, physical
devices, and Controlled Pilot readiness remain open.
