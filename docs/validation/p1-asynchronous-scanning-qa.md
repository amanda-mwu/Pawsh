# P1 asynchronous scanning QA evidence

Classification: P1 QA Incomplete until exact-SHA CI, ten-run qualification, and human Security review complete.

Originating runtime artifact: `62330228d6fd20e20d75c4847649cec919e9eb99`

Originating evidence SHA: `9e92f0ba15b64f998ca6f3aa2510cf838e0019f5`

## Implemented candidate scope

- Bounded authorized pending/recent document status and reload reconciliation
- Duplicate-upload suppression while scanning or retrying
- Separate P1 Playwright configuration and single Chromium project
- Loopback HTTP scanner stub with private authenticated control interface
- Exact run/scenario/document/digest/size/version release binding
- Safe deterministic fixture manifest and checksum verification
- RFC 8785 canonicalization utility with rejection tests for invalid inputs
- Allowlisted execution evidence exporter
- One additive CI job using the normal background worker and filesystem storage

Inherited Playwright configuration, projects, commands, scanner-inline behavior, and browser jobs are unchanged.

## Materiality

Runtime-material:

- `src/http/routes.ts`: safe status projection
- `public/app.js`: reload reconciliation and pending/failure presentation

Test/tooling-only:

- P1 scanner stub and control CLI
- P1 Playwright configuration and test
- Fixture manifest and verifier
- Canonicalization and evidence utilities
- Additive CI job

Documentation/evidence-only:

- P1 testing, validation, and human-review records

## Current evidence

- Fixture verification: PASS, four safe synthetic fixtures
- TypeScript: PASS
- Lint: PASS
- Unit tests: PASS
- Build: PASS
- P1 project mapping: PASS, one test in one file
- PostgreSQL integration/browser execution: NOT COMPLETE locally; exact-SHA CI required
- Ten-run qualification: NOT COMPLETE
- Human Security approval: NOT COMPLETE

## Open boundaries

- `SEC-DB-001`: schema-owner runtime/RLS dependency remains open and is not disguised as a P1 pass.
- `SEC-DOC-001`: managed-scanner staging validation remains Must Fix Before Controlled Pilot.
- No staging, pilot, or Controlled Pilot Ready classification is implied.
