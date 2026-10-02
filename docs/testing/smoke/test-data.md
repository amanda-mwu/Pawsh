# QA test data

## Automated data

Every Playwright test creates a tenant named `PW Smoke <run-id>` with unique
accounts and records. Stable prerequisites include Grace Groomer, Full Groom,
Emma/Charlie, Daniel/Rocky, and Sophia/Mochi/Boba. Transactional appointments,
invoices, and payments are test-created and never shared across tests.

`QA_ANCHOR_DATE` accepts `YYYY-MM-DD`, and the manual QA seed also accepts a full
instant, which it resolves to a civil date in the location's timezone. When
absent, tests derive the next Monday and the manual seed uses today. Browser and
business time use `America/Los_Angeles`.

## Manual QA tenant

`npm run seed:qa` builds the recognizable `Pawsh QA Grooming` tenant for human
visual QA: one deterministic day on which every state a reviewer has to look at
is already on the calendar. It runs once, against an empty, freshly migrated
database, and refuses (writing nothing) if the tenant already exists — drop and
recreate the database to reseed. It seeds no Square connection, device, or
terminal state, and no discounts or coupons.

It writes in two layers. Settings an owner would type in — the business,
accounts, location, opening hours and groomer rotas — are written directly, and
the business is provisioned by `provisionBusinessCatalog`, the same path a real
signup runs, so built-in roles, tax rate (8.25%) and payment methods are the
product's own. Everything with a lifecycle or money — catalog curation, clients,
pets, credit grants, blocks, bookings, transitions, the service note, checkout
and payments — goes through the application's real routes, driven in-process as
the owner. No appointment, invoice, payment or credit row is hand-written.

Staff: Olivia Owner (owner), Marcus Manager, Riley Reception, Grace Groomer and
Gabriel Groomer, each holding the built-in role of that name. The salon
(`America/Los_Angeles`) is open 08:00–18:00 and both groomers work 08:00–17:00
on all seven days, so the calendar opens on today with both lanes populated.

Active catalog, exactly six (other provisioned services are deactivated):
Bath $45/45 min, Full Groom $65/90 min, Nail Trim $15/15 min, De-shedding
$40/60 min, Teeth Brushing $12/10 min, Ear Cleaning $10/20 min. Grace performs
Bath, Full Groom, Nail Trim and Teeth Brushing; Gabriel performs all six.

Clients and pets (all dogs):

- Sophia Chen — Rocky, Mochi. Phone, email and postal address (for contact
  permission QA); $150.00 client credit.
- Avery Thompson — Daisy, Charlie. $60.00 granted; Charlie's visit spends
  $20.00, leaving $40.00.
- Emma Johnson — Luna. No credit.
- Noah Williams — Boba, with a safety alert and staff-verified, current rabies.

The day (today in the salon's timezone, or `QA_ANCHOR_DATE` when set):

| Groomer | Time | Pet | Services | State |
|---|---|---|---|---|
| Grace | 09:00 | Rocky | Full Groom | scheduled, no service note |
| Grace | 10:30 | Mochi | Bath + Nail Trim | checked in, service note written |
| Grace | 12:00–12:30 | — | Block Time "Lunch" | — |
| Grace | 13:00 | Daisy | Full Groom + Teeth Brushing | completed, invoice $83.35 open and unpaid |
| Grace | 15:00 | Charlie | Bath | completed, $48.71 settled: $20.00 client credit + $28.71 cash on one invoice |
| Gabriel | 09:30 | Luna | Full Groom | in service |
| Gabriel | 11:00 | Boba | Bath + Nail Trim | scheduled |
| Gabriel | 12:30–13:15 | — | Block Time "Lunch" | — |
| Gabriel | 14:00 | Rocky | De-shedding | scheduled |
| Gabriel | 14:30 | Mochi | Ear Cleaning | scheduled, overlaps 14:00 (booked with the conflict override and a reason) |
| Gabriel | 15:30 | Luna | Nail Trim | cancelled, with a reason |
| Grace | tomorrow 10:00 | Rocky | Bath | scheduled, note "Future check-in test" |

Daisy is left for Take Payment, void and repay; Rocky, Boba and Mochi stay
actionable. The seed prints the resolved day and every visit's id, time,
groomer and state.

It refuses to run unless all safeguards pass:

- `PAWSH_ALLOW_QA_SEED=true`;
- `NODE_ENV` is not `production`;
- `DATABASE_URL` contains the explicit `PAWSH_QA_DATABASE_MARKER`;
- the target is not a known production host/name;
- `PAWSH_QA_PASSWORD` is supplied at runtime and has at least 12 characters.

The script prints the target before mutation. No password or production
credential is committed. A production QA tenant must be provisioned through
normal product workflows.

## Directory volume

Four clients read well but cannot exercise the directory itself. `npm run
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
