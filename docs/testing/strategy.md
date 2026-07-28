# Testing strategy

Pawsh prioritizes tenant boundaries and business invariants over exhaustive trivial CRUD tests.

- Unit tests cover appointment transitions, interval semantics, permissions, and integer-money calculations.
- Migration syntax tests parse every PostgreSQL statement.
- Database tests require an isolated PostgreSQL database and exercise final-owner and scheduling exclusion constraints.
- The database-backed canonical test executes signup through receipt, concurrent scheduling, invitation permissions, outbox idempotency, and cross-tenant denial.
- Static client validation enforces recommended HTML and WCAG-oriented structural rules.
- CI migrates a fresh PostgreSQL service before running the complete validation suite.
- CI performs a real PostgreSQL dump into a new database, restores it, and reruns the database suite against the restored copy.
- The canonical runtime smoke flow creates a business, operational records, appointment, completed service, invoice, payment, and receipt while also testing denial cases.

Skipped database tests are not a pass. Validation records must state when the PostgreSQL runtime was unavailable.

## Validation commands

- Local code validation: `npm run validate` runs lint, type checking, all
  deterministic tests available in the environment, and the production build.
- Local runtime validation: with `DATABASE_URL` pointing to an isolated
  PostgreSQL 17 database, `npm run validate:runtime` applies migrations and runs
  the database/runtime suite.
- CI parity: `npm run validate:ci` applies migrations, runs code validation, and
  reruns the database suite. GitHub Actions executes this after `npm ci` and the
  dependency audit, then rehearses dump/restore separately.
- Release validation: the exact target commit must have a green required GitHub
  Actions run. Evidence from a different SHA does not classify the target.

Node 24 and npm 11 are the supported local and CI majors. `.node-version`,
`.nvmrc`, package engines, and the workflow share this policy.

`npm ci` installs the tracked `.githooks/pre-push` hook through the repository
prepare script. The hook runs `npm run validate` and rejects ordinary pushes when
code validation fails. Runtime validation remains a separate release requirement
because a local PostgreSQL service is not universally available.
