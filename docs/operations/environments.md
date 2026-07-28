# Environments

Local development uses `.env` and an isolated PostgreSQL database. Staging and production require injected secrets and managed PostgreSQL; credentials must never be committed.

Required configuration:

- `DATABASE_URL`
- `SESSION_SECRET` with at least 32 random characters
- `APP_ORIGIN`
- `PORT`
- `NODE_ENV`
- `SMTP_HOST`, `SMTP_PORT`, and `EMAIL_FROM` in production
- `SMTP_USER` and `SMTP_PASS` when the selected relay requires authentication

Production must terminate TLS, use a non-owner PostgreSQL application role so row policies apply, restrict database network access, and inject secrets through the deployment environment. Pawsh uses the SMTP adapter whenever `SMTP_HOST` is configured; development without SMTP uses a metadata-only logging adapter.

Changing `SESSION_SECRET` revokes session-cookie trust and prevents decryption of already queued password-reset messages. Drain or cancel those short-lived intents before rotating it.

Supported browsers are the current and previous major versions of Chrome, Edge, Firefox, and Safari. Critical client workflows use native labeled controls, keyboard-operable actions, visible focus, text status labels, and readable errors.
