# P1 asynchronous scanning QA evidence (retired for MVP)

Historical evidence only. ADR-010 replaces this scanner gate for MVP.

Classification: P1 QA Incomplete pending human Security review. Automated implementation evidence is valid.

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
- Tested runtime SHA: `0076315d397e7de701d6ab3de800da344779adeb`
- Runtime build digest: `sha256:8484e03692ac1ca31db27cd45edae5bd561813680fec4266fbe067ca5f639bd0`
- Migration version: `0009_document_malware_protection`
- Exact-SHA CI: PASS, run `30938614687`
- P1 asynchronous browser job: PASS, zero retries
- Inherited CI jobs: PASS
- Cross-platform required matrix: PASS, run `30938619624`
- Ten-run sequential qualification: PASS 10/10, zero failed iterations and zero retries, run `30938632409`
- Qualification environments: ten fresh hosted runners, PostgreSQL services, app/scanner processes, and storage namespaces
- Human Security approval: NOT COMPLETE

The documentation commit containing this record is evidence-only. The tested runtime SHA and digest above remain the runtime artifact under review; final evidence-descendant SHA is captured by Git/CI closure rather than folded into the runtime claim.

## Open boundaries

- `SEC-DB-001`: schema-owner runtime/RLS dependency remains open and is not disguised as a P1 pass.
- `SEC-DOC-001`: **open**, Must Fix Before Controlled Pilot. ADR-010 superseded ADR-005's runtime scanning design and did not close the finding; a superseded implementation design is not a closed security finding, and the superseded scanner is not required. Closure needs staging evidence for the current attachment control, as release governance requires, plus an explicit recorded closure. See [the finding register](../architecture/scale-readiness.md).
- No staging, pilot, or Controlled Pilot Ready classification is implied.
