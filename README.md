# Pawsh

Pawsh is a multi-tenant grooming-salon operations MVP covering business setup, customers and pets, scheduling, service execution, checkout, manual payment records, engagement intents, reporting, and audit history.

## Local development

Prerequisites: Node.js 22+ and PostgreSQL 17+.

1. Copy `.env.example` to `.env` and replace the session secret.
2. Start PostgreSQL with `docker compose up -d postgres`, or provide another PostgreSQL database.
3. Run `npm install`.
4. Run `npm run db:migrate`.
5. Run `npm run dev`.
6. Open `http://127.0.0.1:3000`.

Run `npm run validate` for lint, type checks, unit tests, and the production build. With `DATABASE_URL` set to an isolated test database, run `npm run test:db` for database invariants.

Never use production credentials or a production database for tests.

Production startup requires an SMTP host and sender address. Appointment and password-reset messages use the SMTP adapter; local development safely records only message metadata when SMTP is not configured.
