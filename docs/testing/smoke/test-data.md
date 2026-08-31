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

## Directory volume

Six clients read well but cannot exercise the directory itself. `npm run
db:seed-directory` adds a bounded block of extra clients to the same
`Pawsh QA Grooming` tenant so paging, the 10/20/50/100 page-size choice, the
status filter, the visit-based sorts, and popup notes all have something to work
on. It shares every safeguard of `npm run db:seed` and refuses to run unless the
canonical tenant already exists.

`PAWSH_QA_DIRECTORY_CLIENTS` sets the block size (default 45, maximum 400). The
clients cycle through four shapes — a plain active client, one with two pets, one
with no pet, and an archived one — so roughly a quarter land in the inactive
filter. Every fourth client carries a note and every eighth is flagged as a
popup note; every third client with a pet gets one past or upcoming visit so the
last-visit and next-appointment columns and their sort orders are not a column of
dashes.

Each pet is a complete profile rather than a name and a breed: pet type, a
canonical breed from the taxonomy (with roughly one in eleven recording an
uncatalogued `breed_other` instead), hair length, coat colour, fixed status,
weight, a birthday or an approximate age, coat, grooming, behaviour, medical and
safety notes, health issues, an emergency contact and a vet. Rabies cycles
through all four states a pet can be in — staff-verified and current,
owner-reported and current, expired, and nothing on file — and non-rabies
vaccinations are recorded separately, because the vaccinations table refuses the
name "Rabies": rabies lives on the pet with its own verification trail. Most pets
also carry a pet note, some pinned. No photos or documents are attached, because
no file was ever uploaded.

Everything it writes is identifiable: emails are
`directory-###@pawsh-test.example`, and notes and appointment notes are prefixed
`QA directory:`. The seed is idempotent, and
`npm run db:seed-directory -- --remove` takes the block back out again. Removal
refuses if any appointment on those clients was not written by the seed, so
work done by hand during QA is never silently deleted.
