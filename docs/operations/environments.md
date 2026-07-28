# Environments

Local development uses `.env` and an isolated PostgreSQL database. Staging and production require injected secrets and managed PostgreSQL; credentials must never be committed.

Required configuration:

- `DATABASE_URL`
- `SESSION_SECRET` with at least 32 random characters
- `APP_ORIGIN`
- `PORT`
- `NODE_ENV`

Production must terminate TLS, restrict database network access, rotate secrets, and replace the logging email adapter with an approved provider adapter.

Supported browsers are the current and previous major versions of Chrome, Edge, Firefox, and Safari. Critical client workflows use native labeled controls, keyboard-operable actions, visible focus, text status labels, and readable errors.
