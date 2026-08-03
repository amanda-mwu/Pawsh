# Pawsh

Pawsh is a multi-tenant grooming-salon operations MVP covering business setup, customers and pets, scheduling, service execution, checkout, manual payment records, engagement intents, reporting, and audit history.

## Local development

Prerequisites: Node.js 22.x or 24.x, npm 11, and PostgreSQL 17+. Node 24 is
the recommended local runtime and is pinned by `.node-version` and `.nvmrc`.

1. Copy `.env.example` to `.env` and replace the session secret.
2. Start PostgreSQL with `docker compose up -d postgres`, or provide another PostgreSQL database.
3. Run `npm install`.
4. Run `npm run db:migrate`.
5. Run `npm run dev`.
6. Open `http://127.0.0.1:3000`.

Run `npm run validate` for lint, type checks, unit tests, and the production build. With `DATABASE_URL` set to an isolated test database, run `npm run test:db` for database invariants.

Never use production credentials or a production database for tests.

### Windows PowerShell runtime commands

Using nvm-windows, validate either supported runtime explicitly:

```powershell
nvm use 22
npm install --global npm@11.6.0
npm ci
npm run validate

nvm use 24
npm install --global npm@11.6.0
npm ci
npm run validate
```

For a development browser runtime, use filesystem storage and keep the browser
origin identical to `APP_ORIGIN`:

```powershell
$env:NODE_ENV = "development"
$env:DOCUMENT_STORAGE_ADAPTER = "filesystem"
$env:DOCUMENT_STORAGE_PATH = ".pawsh-documents"
$env:APP_ORIGIN = "http://127.0.0.1:3000"
npm run db:migrate
npm run dev
```

Do not set `DOCUMENT_STORAGE_ADAPTER=memory` in development. Memory storage is
intentionally test-only; the resulting startup failure is an environment
mismatch, not evidence of Node 24 incompatibility.

For isolated Chromium validation against the same canonical origin:

```powershell
$env:NODE_ENV = "test"
$env:DOCUMENT_STORAGE_ADAPTER = "memory"
$env:PAWSH_E2E_MODE = "disposable"
$env:APP_ORIGIN = "http://127.0.0.1:3000"
$env:DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:54322/postgres"
npm run db:migrate
node scripts/run-playwright.mjs --project=chromium --grep "@smoke|@cross-browser"
node scripts/run-playwright.mjs --project=chromium-security
node scripts/run-playwright.mjs --project=chromium-regression
```

If `PAWSH_E2E_BASE_URL` is supplied, its origin must exactly equal
`APP_ORIGIN`; `localhost` and `127.0.0.1` are distinct origins.

Production startup requires an SMTP host and sender address. Appointment and password-reset messages use the SMTP adapter; local development safely records only message metadata when SMTP is not configured.
