# P1 asynchronous document-scanning QA

Status: implementation candidate; automated CI and human Security approval pending.

This additive suite exercises the development runtime with filesystem storage, the HTTP scanner adapter, and the normal in-process background worker. It is deliberately absent from `playwright.config.ts` and inherited browser commands.

## Boundary

- Configuration: `playwright.p1.config.ts`
- Project: `p1-document-scanning-chromium`
- Tests: `tests/e2e/p1-document-scanning/`
- Scanner scan interface: loopback port 4319
- Scanner control interface: loopback port 4320 with a separate run-scoped secret
- CI gate: `Document Scanning / P1 Asynchronous Security QA`
- Retries: zero; workers: one

The scanner stub decides only a deterministic simulated verdict. It does not inspect malware and does not prove scanner efficacy. `SEC-DOC-001` remains open for managed-scanner staging validation.

## Pending/recent status contract

`GET /api/pets/:petId/documents` now includes at most five non-completed requests created during the preceding seven days. Results are newest-first and require `pets.care.view`. The projection contains a request ID, document type, operation, safe filename, safe status, timestamps, and whether another upload is permitted. It excludes storage identity, provider URLs, scanner metadata, signatures, and raw failure details.

Pending and retryable requests suppress the upload control. Reloading the document dialog rediscovers the request and resumes bounded polling. Completed requests disappear from activity and are represented by the normal current/history projection.

## Safe fixtures

Run `npm run qa:p1:fixtures`. The committed manifest records checksums and declares that no active malware is present. A harmless PDF digest maps to the simulated malicious result; timeout and availability behavior are scanner controls, not special files.

## Isolated mapping

Set `PAWSH_E2E_MODE=disposable`, `PAWSH_E2E_BASE_URL`, and `PAWSH_P1_RUN_ID`, then run:

```text
npx playwright test --config=playwright.p1.config.ts --project=p1-document-scanning-chromium --list
```

Only the P1 directory may be listed.

## Known database-role limitation

The P1 job uses a fresh job-local PostgreSQL service but retains the existing schema-owner application identity. `SEC-DB-001` records that Pawsh currently depends on owner RLS bypass: authentication and multiple runtime/worker queries execute before or outside tenant-scoped transactions, and migrations do not establish runtime-role grants. This suite does not claim non-owner role validation. Engineering, Security, and the launch approver must classify the finding before controlled pilot.

## Qualification

Initial closure requires ten sequential fresh CI environments, with 10/10 passes, no retries, and no leaked process or storage state. This evidence must come from the final candidate SHA. Do not substitute ten executions against one mutable database. The normal exact-SHA P1 job remains required after qualification.

Trigger `.github/workflows/p1-qualification.yml` manually on the exact candidate SHA. Its matrix is restricted to one active iteration, so all ten fresh hosted environments execute sequentially. Any iteration failure stops qualification; do not rerun a failed qualification and present it as zero-retry evidence.
