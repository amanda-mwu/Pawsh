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
