# Testing strategy

Pawsh prioritizes tenant boundaries and business invariants over exhaustive trivial CRUD tests.

- Unit tests cover appointment transitions, interval semantics, permissions, and integer-money calculations.
- Migration syntax tests parse every PostgreSQL statement.
- Database tests require an isolated PostgreSQL database and exercise final-owner
  protection plus serialized, override-aware scheduling conflict enforcement.
- The database-backed canonical test executes signup through receipt, concurrent scheduling, invitation permissions, outbox idempotency, and cross-tenant denial.
- Static client validation enforces recommended HTML and WCAG-oriented structural rules.
- CI uses fresh PostgreSQL services for backend validation, backup/restore, and
  each mutable browser job.
- CI performs a real PostgreSQL dump into a new database, restores it, and
  compares the restored public-table inventory and row counts with the source.
  Mutation-oriented database tests run against the migrated test database before
  the rehearsal, not against its already-populated restored copy.
- The canonical runtime smoke flow creates a business, operational records, appointment, completed service, invoice, payment, and receipt while also testing denial cases.
- Playwright Chromium smoke exercises 11 isolated browser journeys, including
  direct authenticated security assertions, responsive viewports, accessibility
  semantics, and generous performance-regression budgets. Tests use unique
  tenants and mutable records per test and run with zero retries.
- Four explicitly tagged `@cross-browser` journeys run on the
  `chromium-desktop`, `firefox-desktop`, and `webkit-desktop` projects. Project
  filters prevent the deep Chromium suite from expanding onto Firefox/WebKit.

Skipped database tests are not a pass. Validation records must state when the PostgreSQL runtime was unavailable.

## Validation commands

- Local code validation: `npm run validate` runs lint, type checking, all
  deterministic tests available in the environment, and the production build.
- Local runtime validation: with `DATABASE_URL` pointing to an isolated
  PostgreSQL 17 database, `npm run validate:runtime` applies migrations and runs
  the database/runtime suite.
- CI parity: `npm run validate:ci` applies migrations, runs code validation, and
  reruns the database suite.
- GUI smoke: `npm run test:smoke` runs the tagged Chromium suite;
  `npm run test:cross-browser` runs the small desktop compatibility subset;
  `npm run test:e2e` runs every configured Playwright project.
- QA release validation: `npm run validate:qa` runs CI parity followed by GUI
  smoke against the configured `PAWSH_E2E_BASE_URL`, or starts Pawsh locally.
  GitHub Actions installs Chromium, runs this browser smoke, and preserves
  failure traces/screenshots before rehearsing database dump/restore.
- Release validation: the exact target commit must have a green required GitHub
  Actions run. Evidence from a different SHA does not classify the target.

Node 24 and npm 11 are the supported local and CI majors. `.node-version`,
`.nvmrc`, package engines, and the workflow share this policy.

`npm ci` installs the tracked `.githooks/pre-push` hook through the repository
prepare script. The hook runs `npm run validate` and rejects ordinary pushes when
code validation fails. Runtime validation remains a separate release requirement
because a local PostgreSQL service is not universally available.
