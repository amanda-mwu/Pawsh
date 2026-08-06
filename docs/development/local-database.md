# Local database development

Native PostgreSQL 17 is Pawsh's preferred daily development database. Docker
PostgreSQL 17 remains an optional parity profile. Both use the same migrations,
SQL behavior, application configuration, and `DATABASE_URL`; application code
does not detect the operating system or database deployment method.

## Contract

- PostgreSQL major 17, UTF-8, `C` collation/character classification, and UTC
  database sessions
- extensions `pgcrypto` and `btree_gist`
- migrations in lexical order under `migrations/`
- application/business time calculated from stored IANA business timezones
- no production data, credentials, or database dumps in local development

PostgreSQL's default transaction isolation remains `read committed`; Pawsh adds
explicit transactions, row locks, advisory locks, exclusion constraints,
optimistic versions, composite tenant foreign keys, and RLS where required.

## Windows native setup

Install PostgreSQL 17 using the official Windows installer and include `psql`.
Run the following as the local PostgreSQL administrator, substituting a random
local-only password:

```sql
create role pawsh_local login password 'replace-local-password';
create database pawsh_dev owner pawsh_local
  encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0;
alter database pawsh_dev set timezone to 'UTC';
```

Copy `.env.example` to `.env`, put the same password in `DATABASE_URL`, and do
not commit `.env`. If PostgreSQL is not on `PATH`, add its `bin` directory for
the current shell before using `psql` or backup tools.

## macOS native setup

Install and start PostgreSQL 17 using the official packages or Homebrew:

```sh
brew install postgresql@17
brew services start postgresql@17
```

Use `psql postgres` to execute the same role/database SQL shown above, then copy
`.env.example` to `.env` and set the local-only password.

## Daily commands

```sh
npm install
npm run db:health
npm run db:migrate
npm run db:verify
npm run db:seed
npm run dev
```

Use `NODE_ENV=development` for this interactive workflow. Startup reports each
boot stage, PostgreSQL readiness, the public `APP_ORIGIN`, the separate bound
listener address, and elapsed startup time. A delayed database connection emits
`Still waiting for PostgreSQL` without terminating startup. `GET /health`
remains the authoritative database-backed readiness probe.

Run `npm run dev:browser` to start the development server. The helper opens the
system default browser exactly once only after its newly spawned Pawsh child
emits its first `[READY]` event and a subsequent `/health` request completes
with HTTP 200. The deadline is 60 seconds. A stale Pawsh listener cannot satisfy
the child lifecycle condition; child exit, configuration failure, port conflict,
or timeout is reported with the last safe lifecycle state and does not open a
browser. Press Ctrl+C to stop the development child: POSIX forwards the signal
to Pawsh's logged graceful shutdown, while Windows terminates the complete
command-process tree so npm/tsx cannot remain orphaned. The application shutdown
ordering itself is unchanged. Use `NODE_ENV=test` only for automated tests; it
intentionally suppresses normal runtime logs and selects deterministic test
behavior.

The helper is supported on Windows, macOS, and Linux. Windows starts the fixed
`npm run dev` command through `ComSpec` (falling back to `cmd.exe`) because
direct `.cmd` spawning is not portable across supported Node releases. The
server child is never detached. A process-spawn failure exits immediately with
a safe platform/category diagnostic, without polling readiness or opening a
browser. An interactive Ctrl+C is forwarded to stop the development process
tree; the browser does not open after shutdown begins.

Automated startup validation asserts graceful SIGTERM lifecycle output on
POSIX runners. Windows CI verifies startup and port release because terminating
a detached child process cannot faithfully synthesize an interactive console
Ctrl+C; manual Windows Ctrl+C remains part of developer/runtime validation.

### Startup lifecycle and troubleshooting

Development startup emits this deterministic sequence before listening:

1. Configuration loading and validation
2. PostgreSQL readiness
3. `createApp begin` and Fastify instance creation
4. Individual Helmet, CORS, authentication-cookie, rate-limit, multipart, and
   static-file plugin registrations
5. Document-storage construction
6. Document-scanner construction
7. Authentication and API-route registration
8. Background-worker registration
9. `createApp complete`
10. HTTP listener startup and `[READY] Pawsh listening`

Every awaited plugin registration has paired `begin` and `complete` messages.
After three seconds, an unfinished awaited operation emits `Still waiting for`
with its component and elapsed time; this diagnostic does not cancel, retry, or
otherwise alter initialization. A safe component failure reports the component,
operation, and elapsed startup time without printing connection strings,
credentials, tokens, or storage/scanner secrets, then rethrows to the server
entry point.

If startup appears paused, the final lifecycle line identifies the operation in
progress. These detailed component diagnostics are enabled only for
`NODE_ENV=development`; they do not change test determinism, `/health`, scanner
availability policy, migration ownership, worker behavior, or production
architecture.

Open `http://127.0.0.1:3000`. `db:seed` creates synthetic `.example`/`.test`
data with a fixed logical anchor. Generated UUIDs and password hashes may differ
without changing the logical fixture. Override the local seed password through
`PAWSH_LOCAL_SEED_PASSWORD`.

`npm run db:reset` drops and recreates only the `public` schema, then reapplies
migrations. It refuses production mode, remote hosts, and any database other
than `pawsh` or `pawsh_dev`. The target is printed before destruction. Back up
local work you intend to retain.

The development filesystem document directory is `.pawsh-documents`. The HTTP
scanner adapter and endpoint configuration remain required in development.
`http://127.0.0.1:4319/scan` is an example endpoint only: Pawsh does not bundle
or start a scanner service at that address. Network availability is not probed
during startup, so a configured offline scanner does not delay `[READY]`,
`/health`, login, CRM, scheduling, invoicing, reporting, or other non-document
workflows. Supporting uploads still fail closed asynchronously when scanning
cannot complete. Testing document uploads requires an actual approved scanner
service. Startup diagnostics state only that the HTTP adapter is configured and
never print the endpoint or credentials. Never select the deterministic test
adapter in a normal development or production process.

## Optional Docker parity

Docker Desktop is not required for daily development. When available:

```sh
docker compose up -d postgres
```

The parity service publishes PostgreSQL at `127.0.0.1:55432`, because port
`54322` is reserved by another local project. For this profile use:

```text
DATABASE_URL=postgres://pawsh:pawsh-local-only@127.0.0.1:55432/pawsh?options=-c%20TimeZone%3DUTC
```

Then run the same health, migration, verification, seed, runtime, and browser
commands. Override the host port with `POSTGRES_PORT` and update `DATABASE_URL`
to match. The container uses `restart: unless-stopped`; Docker Desktop restart
therefore restarts PostgreSQL while preserving the named volume. A deliberate
`docker compose down` preserves the named database volume;
`docker compose down -v` intentionally destroys it.

Parity means the application contract and test results agree, not that native
and container filesystems or networking are identical. CI remains authoritative
for disposable container validation.

## Browser validation

After starting Pawsh, run `npm run test:smoke` for the focused Chromium flow or
`npm run test:e2e` for the complete configured matrix. Mutable browser tests
require a disposable database and `PAWSH_E2E_MODE=disposable`; never point them
at a database containing data you need.
