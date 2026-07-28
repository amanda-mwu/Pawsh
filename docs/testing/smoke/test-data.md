# QA test data

## Automated data

Every Playwright test creates a tenant named `PW Smoke <run-id>` with unique
accounts and records. Stable prerequisites include Grace Groomer, Full Groom,
Emma/Charlie, Daniel/Rocky, and Sophia/Mochi/Boba. Transactional appointments,
invoices, and payments are test-created and never shared across tests.

`QA_ANCHOR_DATE` accepts `YYYY-MM-DD`; when absent, tests derive the next Monday.
Browser and business time use `America/Los_Angeles`.

## Manual QA tenant

`npm run seed:qa` provisions the recognizable `Pawsh QA Grooming` tenant for
local or staging human QA. It seeds location/settings, Olivia Owner, Marcus
Manager, Riley Reception, Grace and Gabriel Groomer, services, canonical
customers/pets, safety data, working hours, blocked time, and one historical
inactive-service snapshot. It does not seed active invoices, payments, or the
automated smoke flow.

The seed is idempotent and refuses to run unless all safeguards pass:

- `PAWSH_ALLOW_QA_SEED=true`;
- `NODE_ENV` is not `production`;
- `DATABASE_URL` contains the explicit `PAWSH_QA_DATABASE_MARKER`;
- the target is not a known production host/name;
- `PAWSH_QA_PASSWORD` is supplied at runtime and has at least 12 characters.

The script prints the target before mutation. No password or production
credential is committed. A production QA tenant must be provisioned through
normal product workflows.
