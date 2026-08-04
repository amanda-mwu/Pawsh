# P1 human Security review protocol

Administrative status: not approved. A named human Security approver must review the exact tested runtime artifact.

## Reviewer checks

1. Record commit SHA, runtime build digest, migration version, CI run, P1 job result, fixture manifest, and evidence digest.
2. Confirm scanner and control listeners bind only to loopback and require distinct run-scoped credentials.
3. Run the clean pending/reload scenario and verify that upload remains unavailable until worker promotion.
4. Review repository/database evidence for one clean attempt, one promotion, one success audit, and one expiration update.
5. Exercise malicious, malformed, unavailable, and timeout outcomes using safe simulations and verify fail-closed behavior.
6. Confirm a failed replacement preserves the last-known-good document and expiration.
7. Verify permission revocation and cross-tenant status/download denial.
8. Review artifacts for credentials, storage paths, provider URLs, scanner secrets, raw PDF bytes, or cross-tenant data.
9. Destroy the disposable environment and confirm no run-owned processes, storage, or credential files remain.

The reviewer does not edit database state, directly promote documents, use active malware, or use production/staging data.

## Scanner control

The control sequence is `arm`, `await-held`, `status`, then `release` or `fail`. Every terminal action must match run ID, scenario ID, control version, observed document ID, digest, and size. Timeout means the scan request remains unanswered past Pawsh's deadline; it is not a scanner response.

## Findings requiring review

- `UX-DOC-003` — confirmed and remediated in this candidate: pending state was not rediscoverable after reload.
- `SEC-DB-001` — confirmed and open: the application uses the schema owner and therefore does not obtain the intended RLS defense in depth. Classification requires Engineering, Security, and launch-approver agreement.
- `SEC-DOC-001` — open, Must Fix Before Controlled Pilot: managed scanner efficacy and deployed integration await P4 staging.

## Decision record

Record `PASS`, `PASS WITH CONDITIONS`, or `FAIL`, reviewer name, review date, exact artifact, evidence references, residual risks, conditions, and next review. Repository automation cannot supply human approval.
