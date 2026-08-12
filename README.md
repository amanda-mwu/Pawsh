# Pawsh

Pawsh is a multi-tenant grooming-salon operations MVP covering business setup, customers and pets, scheduling, service execution, checkout, manual payment records, engagement intents, reporting, and audit history.

## Local development

Prerequisites: Node.js 22.x or 24.x, npm 11, and PostgreSQL 17. Node 24 is
the recommended local runtime and is pinned by `.node-version` and `.nvmrc`.

1. Install native PostgreSQL 17 (preferred) and create the local role/database,
   following [local database development](docs/development/local-database.md).
2. Copy `.env.example` to `.env`, replace the local database password, and
   replace the session secret.
3. Run `npm install`.
4. Run `npm run db:health`, `npm run db:migrate`, and `npm run db:verify`.
5. Run `npm run dev`.
6. Pawsh opens `APP_ORIGIN` in the system default browser after it is ready.

`npm run dev` is the interactive development runtime and should use
`NODE_ENV=development`. It reports configuration, PostgreSQL readiness, service
registration, the bound listener, `APP_ORIGIN`, startup duration, and graceful
shutdown. It observes its exact `dev:server` child's first `[READY]` lifecycle
event and opens the system default browser only after a subsequent `GET /health`
completes with HTTP 200. Its 60-second readiness deadline prevents a stale
process on the same port from causing an early browser launch; child exit,
configuration failure, or timeout is reported without opening a browser.
Use `npm run dev:server` for server-only CI, debugging, IDE, remote, or headless
workflows. `npm run dev:browser` remains an alias-equivalent compatibility
command. `NODE_ENV=test` remains reserved for deterministic automation.

If startup does not reach `[READY]`, the final `[BOOT]` component identifies the
unfinished Fastify plugin, storage/scanner construction, route registration, or
worker registration step. See the local database guide's startup lifecycle for
the complete expected sequence and safe troubleshooting behavior.

Docker Desktop is not required. `docker compose up -d postgres` remains an
optional PostgreSQL 17 parity profile on host port `55432`.
Set `POSTGRES_PORT` before `docker compose up -d postgres` to select another
loopback host port. The service retains its named volume and uses
`restart: unless-stopped` so it returns after Docker Desktop restarts.

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
$env:DOCUMENT_SCANNER_ADAPTER = "http"
$env:DOCUMENT_SCANNER_ENDPOINT = "http://127.0.0.1:4319/scan"
$env:APP_ORIGIN = "http://127.0.0.1:3000"
npm run db:migrate
npm run dev
```

The scanner URL above is an example local endpoint; Pawsh does not create or
start a scanner service there. A configured but offline scanner does not block
startup, `/health`, or non-document workflows. Upload testing requires an
actual approved scanner service, and unavailable scans continue to fail closed
asynchronously. Startup logs only that the HTTP adapter is configured, never
the scanner endpoint or credentials.

Do not set `DOCUMENT_STORAGE_ADAPTER=memory` in development. Memory storage is
intentionally test-only; the resulting startup failure is an environment
mismatch, not evidence of Node 24 incompatibility.

For isolated Chromium validation against the same canonical origin:

```powershell
$env:NODE_ENV = "test"
$env:DOCUMENT_STORAGE_ADAPTER = "memory"
$env:DOCUMENT_SCANNER_ADAPTER = "deterministic"
$env:PAWSH_E2E_MODE = "disposable"
$env:APP_ORIGIN = "http://127.0.0.1:3000"
$env:DATABASE_URL = "postgres://pawsh:pawsh-local-only@127.0.0.1:55432/pawsh?options=-c%20TimeZone%3DUTC"
npm run db:migrate
node scripts/run-playwright.mjs --project=chromium --grep "@smoke|@cross-browser"
node scripts/run-playwright.mjs --project=chromium-security
node scripts/run-playwright.mjs --project=chromium-regression
```

If `PAWSH_E2E_BASE_URL` is supplied, its origin must exactly equal
`APP_ORIGIN`; `localhost` and `127.0.0.1` are distinct origins.

Production startup requires an SMTP host and sender address. Appointment and password-reset messages use the SMTP adapter; local development safely records only message metadata when SMTP is not configured.
