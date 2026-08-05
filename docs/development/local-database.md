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

Open `http://127.0.0.1:3000`. `db:seed` creates synthetic `.example`/`.test`
data with a fixed logical anchor. Generated UUIDs and password hashes may differ
without changing the logical fixture. Override the local seed password through
`PAWSH_LOCAL_SEED_PASSWORD`.

`npm run db:reset` drops and recreates only the `public` schema, then reapplies
migrations. It refuses production mode, remote hosts, and any database other
than `pawsh` or `pawsh_dev`. The target is printed before destruction. Back up
local work you intend to retain.

The development filesystem document directory is `.pawsh-documents`. The HTTP
scanner endpoint remains required in development; if no approved local scanner
is available, supporting uploads fail closed while structured rabies and other
non-document workflows remain usable. Never select the deterministic test
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
commands. `docker compose down` preserves the named database volume;
`docker compose down -v` intentionally destroys it.

Parity means the application contract and test results agree, not that native
and container filesystems or networking are identical. CI remains authoritative
for disposable container validation.

## Browser validation

After starting Pawsh, run `npm run test:smoke` for the focused Chromium flow or
`npm run test:e2e` for the complete configured matrix. Mutable browser tests
require a disposable database and `PAWSH_E2E_MODE=disposable`; never point them
at a database containing data you need.
