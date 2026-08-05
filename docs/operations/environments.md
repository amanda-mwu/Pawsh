# Environments

Local development preferably uses native PostgreSQL 17 and `.env`; the optional
Docker parity profile publishes PostgreSQL 17 on port `55432`. CI uses fresh
PostgreSQL 17 service containers. Staging and production require injected
secrets and managed PostgreSQL 17; credentials must never be committed. See
[local database development](../development/local-database.md).

Required configuration:

- `DATABASE_URL`
- `SESSION_SECRET` with at least 32 random characters
- `APP_ORIGIN`
- `PORT`
- `NODE_ENV`
- `SMTP_HOST`, `SMTP_PORT`, and `EMAIL_FROM` in production
- `SMTP_USER` and `SMTP_PASS` when the selected relay requires authentication
- `DOCUMENT_STORAGE_ADAPTER`; production requires `s3`
- `DOCUMENT_STORAGE_BUCKET` and `DOCUMENT_STORAGE_REGION` for S3
- optional `DOCUMENT_STORAGE_ENDPOINT` for a compatible private service
- optional paired `DOCUMENT_STORAGE_ACCESS_KEY_ID` / `DOCUMENT_STORAGE_SECRET_ACCESS_KEY`; workload credentials are preferred

Production must terminate TLS, use a non-owner PostgreSQL application role so row policies apply, restrict database network access, and inject secrets through the deployment environment. Pawsh uses the SMTP adapter whenever `SMTP_HOST` is configured; development without SMTP uses a metadata-only logging adapter.

`DATABASE_URL` is the only database-selection mechanism. Migration, runtime,
test, and operational processes may receive different least-privilege credentials
through that variable, but application code never branches on native, Docker,
managed, operating-system, local, CI, staging, or production database topology.

Changing `SESSION_SECRET` revokes session-cookie trust and prevents decryption of already queued password-reset messages. Drain or cancel those short-lived intents before rotating it.

Development may explicitly select `filesystem` with `DOCUMENT_STORAGE_PATH`.
Tests use the isolated `memory` adapter. Production fails startup rather than
falling back to either non-production adapter.

Supported browsers are the current and previous major versions of Chrome, Edge, Firefox, and Safari. Critical client workflows use native labeled controls, keyboard-operable actions, visible focus, text status labels, and readable errors.

## Cross-platform CI environment

Cross-platform claims apply only to the exact GitHub-hosted runner image and
architecture recorded by the compatibility workflow. Ubuntu uses a PostgreSQL
17 service container, Windows starts the GitHub-hosted runner's documented
`postgresql-x64-17` service, and macOS uses Homebrew `postgresql@17`. These are disposable
synthetic test environments, not staging or production deployment designs.

Node's native `--env-file` loader is the only implicit file-loading mechanism.
Explicit process environment values take precedence over `.env`; repeated keys
inside one `.env` use Node's last-value behavior. Names are canonical uppercase
and no two supported names differ only by case.

`APP_ORIGIN` is normalized to a URL origin. A root slash is accepted; non-root
paths, credentials, queries, fragments, wildcards, malformed URLs, and
non-HTTP(S) schemes are rejected. HTTP is limited to development/test and
production requires HTTPS. `localhost`, `127.0.0.1`, and `[::1]` are distinct.
Browser base URL and `APP_ORIGIN` must resolve to the same exact origin.

Compatibility artifacts contain synthetic evidence only and are retained for
seven days. Textual redaction rejects authorization/cookie material, private
keys, configured secret names, and credential-bearing PostgreSQL URLs before
normal evidence upload. GitHub repository access controls govern access. Fork
pull requests receive no repository secrets and must use synthetic fixtures.
