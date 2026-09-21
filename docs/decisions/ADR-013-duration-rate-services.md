# ADR-013: Billing a service by the time it actually took

Status: **Proposed; awaiting approval. Nothing in this record exists.**
`DURATION_RATE` does not appear in `service_pricing_mode_check`, in
`pricingModes` in `packages/domain/src/enums.ts`, or in `resolveTierPrice`.
There is no `services.rate_minor`, no `services.billing_interval_minutes`, and
no billable-time column anywhere on `appointment_services`. No migration has
been written and no route has been changed. The owner has asked for the design
and nothing else, and this record is the design.

The migration number used below is `0057`. **It is not reserved, and it has
since been taken**: `0058_groomer_overlap_authority.sql` is now the highest file
in `migrations/`, so the next free number as this is read is `0059`. Migration
numbers in this repository are allocated when a file is written, in the order
files are written, and ADR-012 records what happens to a record that assumes
otherwise. Read `0057` throughout as "the next free number at the time the
migration is actually written".

## The problem, stated once

Some services are not priced by what they are. They are priced by how long they
took.

De-shedding is the example this record uses throughout, because it is the one
that exists. `src/domain/catalog-seed.ts` seeds it as:

```
{key:"shed-less",name:"Shed-Less",category:"DOG_ADDON",mode:"WEIGHT_TIER",base:2000,
 prices:{TIER_1:2000,TIER_2:2000,TIER_3:3000,TIER_4:3000,TIER_5:3000,TIER_6:3000}}
```

Twenty dollars for a small dog, thirty for a large one, and that is the whole
model. It is a reasonable guess and it is only a guess: the undercoat on one
forty-pound dog comes out in twenty minutes and on the next one takes an hour,
and the salon charges a flat thirty dollars for both. The tier is standing in
for time because time is the thing the salon actually sells and the schema has
no way to say so.

**The current model cannot express this, and no amount of route work makes it
able to.** Every resolved price in Pawsh comes out of `resolveTierPrice` in
`packages/domain/src/pricing.ts`, which takes a pricing mode, a base price, a
coat class and a weight, and returns one of six answers. None of its inputs is a
duration and none of its branches multiplies anything. Below it,
`appointment_services` records a `price_minor_snapshot` and nothing that would
let a reader reconstruct where that number came from if it were not a lookup.
This is a schema-shaped gap, so it takes a schema change to close.

What follows answers the fifteen questions the owner asked, one heading each.

---

## 1. Why two new tables are necessary rather than one

**Neither. The recommendation adds no new tables at all.** It adds two columns
to `services` and three to `appointment_services`, both of which already exist,
and that is the whole of the schema change. The question's framing does not
apply to the design, and rather than invent tables to fit the question, this
section explains why there are none to invent.

A new table earns its place when it holds rows that do not correspond
one-to-one with rows in an existing table. `service_price_tiers` is the right
shape for exactly that reason: one service has up to eighteen tier rows, so the
tiers cannot live on `services`. Duration-rate pricing has no such fan-out. A
service that bills by time has **one** rate and **one** interval, which are
attributes of the service in precisely the way `base_price_minor` already is. An
appointment line that was billed by time has **one** recorded duration, which is
an attribute of that line in precisely the way `duration_minutes_snapshot`
already is. A separate table for either would be a table with a unique
constraint on the foreign key it joins by — a one-to-one join maintained by
hand, which is a column with extra steps and a nullable outer join at every
read.

There is a real argument for a third home, and it is worth stating so the owner
can see it was considered rather than missed. `PUT /api/appointments/:id/services`
does `delete from appointment_services where business_id=… and appointment_id=…`
and then re-inserts the whole list (`src/http/routes.ts`; the comment above the
delete explains why 0054's position constraint is safe there). A recorded
duration living on `appointment_services` is therefore destroyed by an operator
editing the service list. A side table keyed by
`(business_id, appointment_id, service_id)` would survive that delete.

**It would survive it by being wrong.** The row it preserved would be a
recorded duration for a line that no longer exists, or worse, one that silently
re-attaches to a different line the operator has since added. The failure is not
that the data is fragile; it is that a service-list edit and a recorded billable
time are two edits that must not happen in either order without somebody
deciding what they mean together. That decision is question 10, and the answer
there is a route rule, not a second table.

## 2. Exact purpose of each proposed column

On `services` — **configuration**, set in Settings, mutable:

| Column | Purpose |
|---|---|
| `rate_minor` | The money charged for one billing interval, in the workspace's minor units, exactly as every other money column in this schema is stated. For a de-shed at fifteen dollars per quarter hour, `1500`. |
| `billing_interval_minutes` | The length of one billing interval. For the same de-shed, `15`. Together with `rate_minor` this is the whole of the price book entry: everything else is arithmetic. |

On `appointment_services` — **snapshot**, written when the operator records the
time, then immutable:

| Column | Purpose |
|---|---|
| `billable_minutes_snapshot` | The time the operator says this service actually took, in whole minutes. This is the only new input a human supplies. |
| `rate_minor_snapshot` | The `services.rate_minor` in force at the moment the time was recorded. |
| `billing_interval_minutes_snapshot` | The `services.billing_interval_minutes` in force at that same moment. |

The two snapshot copies of the configuration are not redundancy for its own
sake. They are what makes the existing `price_minor_snapshot` on the same row
**self-explaining**: a reader with the row in front of them can see the number,
see the three inputs it came from, and check the arithmetic without joining to
`services` and without the answer changing because a salon raised its rate in
March. This is the same reason `service_name_snapshot` exists beside
`service_id`, and it is the same reason 0012 added `pricing_class_snapshot`,
`weight_tier_snapshot` and `resolution_source_snapshot` rather than
recomputing them.

`resolution_source_snapshot` needs no new value declared — it is an unconstrained
`text` column — and the route writes `duration_rate` into it, beside the
`fixed`, `weight_tier` and `breed_default` that `resolveTierPrice` already
produces. That is how a reader tells, at a glance, which kind of line they are
looking at.

## 3. What is configuration versus appointment-time snapshot

The line is the same one the rest of this schema already draws, and it is drawn
by asking **which reading must survive a Settings change**.

`services.rate_minor` and `services.billing_interval_minutes` are configuration.
A salon that decides de-shedding is now eighteen dollars a quarter hour changes
them, and every appointment priced from that moment prices at eighteen.

The three `_snapshot` columns are what happened. A de-shed billed last Tuesday at
fifteen dollars a quarter hour was billed at fifteen dollars a quarter hour
forever, and no Settings change may reach back and alter that reading. This is
not a preference; it is the property that makes a receipt worth printing. If the
rate were read through the foreign key at render time, re-opening a March
invoice in April would show April's prices over March's line items, and the
invoice total — which is stored — would disagree with the lines that are
supposed to add up to it.

The rule generalises to one sentence: **the price book is a current fact, and an
appointment line is a historical one.** Every column on `appointment_services`
ending in `_snapshot` is there because somebody already found this out.

## 4. How billable units are represented

**They are not stored.** The row stores the minutes, the interval and the rate;
the number of units is `ceil(minutes / interval)`, derived wherever it is needed
and never written down.

This is deliberate and it is the point at which this design is most likely to be
argued with, so the reasoning is worth setting out. A stored `units` column
would be a fourth number on a row that already has three inputs and one output,
and a fourth number is a fourth thing that can disagree with the other three. A
row saying `47 minutes, 15-minute interval, 3 units` is corrupt, and it is
corrupt in a way that no constraint catches unless the constraint re-derives the
units — at which point the column is doing no work the derivation was not
already doing.

The product surface does present units to the operator: "47 min — 4 × $15.00 —
$60.00" is what a de-shed line should read on the ticket and on the receipt.
That string is composed at render time from the three stored numbers, in the
same way the invoice's item descriptions are, and it cannot drift from them
because there is nothing separate for it to drift from.

## 5. Per minute, a fixed interval, or a generic quantity

**Recommendation: a configurable interval in whole minutes, defaulting to 15.**

The three options are not three options. Per-minute billing is
`billing_interval_minutes = 1`, and a configurable interval therefore *contains*
per-minute rather than competing with it. That collapses the first two into one
representation at no cost, and it means a salon that genuinely bills by the
minute needs no schema change to do it — it sets the interval to one and the
rate to the per-minute price.

The trade-offs, stated plainly:

- **Per minute only.** Simplest arithmetic, no ceiling, no rounding question at
  all. Rejected as the *only* model because it is not how these salons price:
  they quote "fifteen dollars a quarter hour", and forcing that into "one dollar
  a minute" both misstates the offer and hands the operator a number that
  changes every sixty seconds. It also makes every stopwatch imprecision a price
  difference, which is a conversation at the counter.
- **A fixed interval chosen by the product (say, always 15).** Removes a
  configuration column. Rejected because the product does not know what the
  salon charges by, and a hard-coded quarter hour becomes a schema change the
  first time a salon bills a bath by the half hour.
- **A generic quantity with no unit.** Rejected outright, and this is the
  strongest of the three rejections. A quantity with no declared unit cannot be
  validated, cannot be captioned, and cannot be checked against anything — the
  database would be storing a number whose meaning lives only in whichever route
  last wrote it. It is also indistinguishable, on inspection, from the
  `invoice_items.quantity` workaround rejected below, and for the same reason.

The interval is constrained to `between 1 and 60`. A billing interval longer
than an hour is not a thing this product has, and a bound that is generous but
finite is cheaper than discovering later that somebody typed `1500` into the
minutes field and produced a service that bills once per day.

**A minimum billable duration is deliberately not part of this design**, and that
is flagged rather than hidden: a real salon quite plausibly wants "de-shedding
starts at half an hour however fast it goes". Adding `minimum_billable_minutes`
later is another additive column and another clause in the same check, so
leaving it out now costs nothing and does not foreclose it. Whether the pilot
needs it is a product question, not a schema one.

## 6. How the server computes rate × billable quantity

The expression, in full, as it would be written:

```ts
// Integer arithmetic end to end. `billableMinutes` and `billingIntervalMinutes`
// are both positive integers, so this is exactly ceil(minutes / interval) with
// no division of anything that is not an integer at any point.
const units = Math.floor(
  (billableMinutes + billingIntervalMinutes - 1) / billingIntervalMinutes
);
const priceMinor = units * rateMinor;
```

`Math.ceil(billableMinutes / billingIntervalMinutes)` produces the same answer
for every value this product will ever see, and it is not what should be
written. The integer form is preferred because it is the *same expression the
database check evaluates*, and a reviewer comparing the two should not have to
reason about whether floating-point division and `ceil` agree with integer
division at the boundaries. They do. The point is that nobody should have to
check.

Worked on the running example. Shed-Less configured at `rate_minor = 1500`,
`billing_interval_minutes = 15`. The groomer records that the de-shed took 47
minutes:

```
units      = floor((47 + 15 - 1) / 15) = floor(61 / 15) = 4
priceMinor = 4 * 1500                  = 6000
```

`$60.00`, written to `price_minor_snapshot` alongside `47`, `1500` and `15`.
These values were evaluated against the local database rather than reasoned
about — 1, 14 and 15 minutes all bill one unit; 16 and 30 bill two; 45 bills
three; 46, 47 and 60 bill four.

Nothing downstream changes. `POST /api/appointments/:id/checkout` reads
`price_minor_snapshot` and writes it into `invoice_items.amount_minor`, and it
neither knows nor needs to know how that number was arrived at. **That is the
single most valuable property of this design**: the money path is untouched.

## 7. How rounding works

There is no rounding. There is a ceiling, it happens in exactly one place, and
every number involved is an integer.

**Where.** The ceiling is applied to *units*, before any multiplication:
`ceil(minutes / interval)`, then `× rate`. It is never applied to money. A
partial interval is billed as a whole interval — 47 minutes is four quarter
hours — which is how the salon quotes the service in the first place, and the
resulting amount is an exact integer multiple of `rate_minor` with no fractional
currency to dispose of anywhere.

**Why the stored amount cannot disagree with its own inputs.** Because the
database refuses to store one that does. The check on `appointment_services`
re-derives the amount from the three snapshot columns and compares it to
`price_minor_snapshot`:

```sql
price_minor_snapshot =
  ((billable_minutes_snapshot + billing_interval_minutes_snapshot - 1)
     / billing_interval_minutes_snapshot) * rate_minor_snapshot
```

PostgreSQL's `/` on two `integer` operands is integer division truncating toward
zero, and both operands here are positive, so this is floor division and the
whole expression is an exact ceiling. **No `numeric`, no floating point, no
`round`, no `ceil()` function, and therefore no question about a rounding mode
anywhere.**

The practical consequence is worth stating for the reader who has met this class
of bug before: there is no code path — not a route, not a script, not a
migration, not somebody at a `psql` prompt — that can leave a duration-rate line
whose amount does not follow from its inputs. The constraint was exercised both
ways against the local database in a rolled-back transaction: a row stating
`47 / 15 / 1500 / 6000` is accepted, and changing that row's amount to `5500`
while leaving the inputs alone is refused with a check violation. An amount
somebody typed cannot masquerade as an amount that was computed, which is the
whole reason this is a constraint and not a unit test.

## 8. How the final charge is snapshotted immutably

In three layers, of which only the third is new.

**The row.** `price_minor_snapshot` is already the charge, already snapshotted,
and already what checkout bills. The three new columns join it on the same row,
written in the same statement, inside the same transaction. There is no window
in which the amount exists without its inputs or the inputs without the amount,
because the check constraint rejects both halves of that state.

**The invoice.** `POST /api/appointments/:id/checkout` copies
`service_name_snapshot` and `price_minor_snapshot` into `invoice_items` as
`description`, `unit_price_minor` and `amount_minor`. From that moment the
invoice holds its own copy, and question 11 covers what that buys.

**The refusal.** `PUT /api/appointments/:id/services` already throws
`Services cannot change after checkout begins` when a non-void invoice exists
for the appointment, and the new route must carry the identical refusal. That is
a route guard, and route guards are exactly what this schema's comments keep
warning about relying on alone — so the recommendation is to back it with a
trigger that refuses to update any of the three snapshot columns once a non-void
invoice exists for the appointment. The lookup is free: 0001's
`one_active_invoice_per_appointment` is a unique index on
`invoices (appointment_id) where status <> 'void'`, which is precisely the
predicate the trigger asks.

The trigger is shown in the DDL below and is **separable** from the columns. If
the owner would rather ship the columns first and the trigger in its own change,
nothing in the design depends on the order.

## 9. Why `duration_minutes_snapshot` remains untouched

Because `duration_minutes_snapshot` is not a duration. It is a piece of the
**schedule**, and reusing it as the billable quantity breaks three things that
are already load-bearing.

It is worth being concrete about the mechanism, because the column's name
actively invites the mistake. In both write paths — `POST /api/appointments` and
`PUT /api/appointments/:id/services` — the handler does this:

```ts
const minutes = catalog.reduce((sum, service) => sum + service.durationMinutes, 0);
const endAt = new Date(appointment.startAt.getTime() + minutes * 60_000);
```

`duration_minutes_snapshot` **is** `appointments.end_at`. Writing a real
observed time into it moves the end of the appointment. Three specific failures
follow.

**The overlap constraint.** 0001 declares `employee_appointment_no_overlap` as
an exclusion constraint over `tstzrange(start_at, end_at, '[)')` per business
and employee, active while the status is `scheduled`, `checked_in` or
`in_service`. Recording that a de-shed took 47 minutes where the schedule
allowed 30 would widen that range by 17 minutes. If the groomer's next
appointment starts on the hour, the write is **refused by the exclusion
constraint** — and the operator is told that recording how long a dog took
conflicts with a different dog's booking, which is a true statement about the
constraint and an incomprehensible one about the salon.

**The midnight guard.** Both handlers then check
`localDateForInstant(endAt, tz) !== localDateForInstant(startAt, tz)` and throw
`Appointments may not cross local midnight during the controlled pilot`. A long
last-of-the-day de-shed recorded honestly would push `end_at` past local
midnight and be refused for a reason that has nothing to do with anything the
operator did.

**And 0049 already settled this exact question.** The comment at the head of
`migrations/0049_appointment_lifecycle_times.sql` decided, for
`checked_in_at`/`checked_out_at`, that actual time and scheduled time are
different things and must stay in different columns. Its words:

> `end_at` IS NOT DERIVED FROM THESE AND NEVER MAY BE. `start_at`/`end_at` are
> THE SCHEDULE - the interval the business committed a groomer to - and these
> two columns are WHAT ACTUALLY HAPPENED. They are routinely different and the
> difference is the point. Conflating them would also break
> `employee_appointment_no_overlap` from 0001 […]: a check-out recorded late
> would retroactively widen a booked interval into a colleague's and start
> rejecting writes to appointments nobody touched.

That is the same ruling, one level down. 0049 separated actual time from
scheduled time for the **visit**; this record separates them for the **service
line**. `billable_minutes_snapshot` is the per-service sibling of
`checked_out_at − checked_in_at`, and `duration_minutes_snapshot` stays exactly
what it has always been: how long the salon set aside.

One consequence should be stated so nobody is surprised by it. The two numbers
will routinely differ on a duration-rate line — the schedule says 30 and the
billing says 47 — and **that is correct, not a data-quality problem.** A report
that treats them as the same number was already wrong before this change; it
just had no way to notice.

## 10. How edits after service completion behave

The window in which billable minutes may be recorded or corrected is defined by
two conditions, both already expressed elsewhere in the product:

1. the appointment is `checked_in`, `in_service` or `completed`; and
2. no non-void invoice exists for it.

The first is not the same list `PUT /services` uses, and the difference is
deliberate. That route allows `scheduled` and this one does not, because a
service that has not started has no elapsed time to record and offering the
field would invite a guess. The upper end reaches `completed` because
`canEnterCheckout` admits both `checked_in` and `completed`, and the checkout
handler never writes `appointments.status` — so a visit can sit in `completed`
for as long as it takes the front desk to get to it, and that gap is exactly
when somebody corrects a mistyped 4 to a 47.

The second condition is the real boundary. **An invoice, not a status, is what
closes the record.** Once checkout has run, the amount has been copied into
`invoice_items` and possibly settled, and a correction is a credit or a void —
never a rewrite. Both the route and the trigger enforce this.

Within the window, a correction is an ordinary update: the route recomputes the
amount from the corrected minutes and writes all four columns together, and the
check constraint guarantees they still agree. It records an audit event through
`record()`, as `PUT /services` does, so the correction is visible even though the
column holds only the current value — the distinction 0049 drew between a log and
a column applies here unchanged.

**One case is a genuine open decision and is flagged rather than assumed.** What
should `PUT /api/appointments/:id/services` do when billable minutes are already
recorded on the appointment and the operator edits the service list? That route
deletes every row and re-inserts, so as written it silently discards the recorded
time. The recommendation is to **refuse** — a `409` telling the operator to clear
the recorded time first — because a silent loss of a number somebody measured is
worse than an extra step, and because "preserve by matching on `service_id`" is
not well defined when the same service appears twice on one appointment. The
owner should confirm that, because it is a product-visible restriction and not
purely a schema matter.

## 11. How invoice and history stay immutable

Nothing about invoice immutability changes, because nothing needs to. This
section exists to show that the new columns do not quietly open a door.

`invoice_items` carries its own `description`, `unit_price_minor` and
`amount_minor`, copied at checkout from the appointment line. They are copies,
not references: no read of an invoice touches `appointment_services` for money,
so no later edit to an appointment line can move an invoice total. `invoices`
additionally carries the 0006 constraint
`total_minor = subtotal_minor - discount_minor + tax_minor + tip_minor`, which
is checked on every write, so an invoice whose parts stopped adding up could not
be stored even if something tried.

A duration-rate line adds one number to what the invoice preserves and takes
nothing away. The line reads `Shed-Less — 47 min — 4 × $15.00 — $60.00`, with
the `$60.00` being `amount_minor` exactly as it is today and the rest composed
from the snapshot columns on the appointment line it came from. The one point
worth naming: **that descriptive text is composed from the snapshots, not from
`services`**, for the same reason given in question 3. A salon that raises its
de-shed rate must not find last month's receipts re-captioned.

## 12. How existing fixed-price services remain unchanged

By not touching them, at every level.

- **In the schema.** All five columns are nullable with no default and no
  backfill. Every existing `services` row keeps `pricing_mode` as it is and gets
  `null` in both new columns; every existing `appointment_services` row gets
  `null` in all three. The shape constraints are written so that all-null is the
  satisfied state, which was confirmed against the local database: all 7,059
  `appointment_services` rows there satisfy the new constraint on the day it is
  added.
- **In the resolver.** `resolveTierPrice` gains a branch for `DURATION_RATE` and
  no existing branch is edited. The `FIXED`, `SERVICE_TYPE_FIXED`, `TIERED`,
  `WEIGHT_TIER`, `QUOTE_REQUIRED` and `RANGE` paths return exactly what they
  return today.
- **In the catalog.** `shed-less` **stays `WEIGHT_TIER`**, with `base: 2000` and
  all six tier rows intact. The migration converts nothing. A salon that wants
  de-shedding billed by time changes it in Settings, as a decision about its own
  price book, and that change applies to appointments priced afterwards and to
  nothing already recorded.

That last point is the one to hold on to. **This record proposes a capability,
not a repricing.** A workspace that never opens Settings after the migration
runs bills exactly what it billed the day before, and no existing appointment,
invoice or receipt reads differently.

## 13. How `appointments.service_price_edit` should gate the route

The new route — the one that records billable minutes and resolves the amount —
is gated on `appointments.service_price_edit`, and **no role changes ship with
it**. The permission already exists in `packages/domain/src/permissions.ts`, was
granted by `migrations/0045_permission_taxonomy.sql`, and has never gated
anything; it currently sits in `unenforcedPermissions`, which is what makes the
permission editor render it as "Not yet available in Pawsh". Its own label
already describes the gap: *"Override a service's price on one appointment.
Pawsh resolves every price from the price book today."*

Enforcing it means deleting one string from `unenforcedPermissions` and adding
one `requirePermission` call. There is no migration, no grant and no revocation,
which is precisely the graduation path 0045's comment lays out and which
`calendar.blocks_create` and `calendar.blocks_edit` have already walked.

**One correction to the framing, because it matters.** The permission is not
assigned to every role in every workspace. 0045 granted it relationally, to every
role that already held all 46 base permissions — "every role that could already
do everything" — and the same comment states outright that "Groomer and
Receptionist hold neither the full set nor anything close to it, so they are
untouched and gain nothing." The local database bears this out exactly: across
10,828 workspaces, every Manager holds the key and **not one Groomer and not one
Receptionist does**.

So the accurate statement is: *every full-access role in every workspace already
holds it, and no groomer anywhere does.* Nothing is revoked from anyone by
enforcing it — a Groomer cannot lose access to a capability that does not exist
yet. But it means that on the day this ships, **the person who performed the
de-shed cannot record how long it took.** The groomer measures the time and a
manager keys it in.

**This is a genuine open decision for the owner and is not resolved here.** The
two defensible answers are:

- *Keep it as designed.* Recording billable minutes is setting a price, the
  permission is named for setting a price, and salons that do not want groomers
  moving money keep that property for free.
- *Add the key to the `groomer` preset, and to existing Groomer roles in the same
  migration.* Recording elapsed time is closer to `operations.perform_service`
  than to pricing, and the operator who knows the answer is the one holding the
  brush.

These have different migrations and different product meanings, and the choice is
the owner's. If the second is chosen it is a grant rather than a revocation,
which is the safe direction, but it is still a role change and would need the
same treatment 0055 gave the Receptionist's blocked-time keys.

## 14. Migration and backfill behaviour

One migration, `0057_duration_rate_services.sql`, matching every other file in
`migrations/`: a single `begin` … `commit`, ending with its own
`insert into schema_migrations(version)`.

**There is no backfill.** No row is read and no row is written. Every statement
is `alter table … add column` or `add constraint`, plus the one
`drop constraint`/`add constraint` pair that widens the pricing-mode list.

Two properties are worth calling out because they decide how the migration
behaves on a real database:

- **Every new column is nullable with no default**, so PostgreSQL rewrites no
  table and the `add column` statements are catalog-only.
- **Every new constraint is satisfied by the all-null state.** PostgreSQL still
  validates each one against existing rows, which is a scan of `services` and of
  `appointment_services` — 7,059 rows locally, and a table that grows with
  appointment volume rather than with anything unbounded. The lock is
  `ACCESS EXCLUSIVE` for the duration, which at this size is brief. Should
  `appointment_services` ever be large enough for that to matter, the check on it
  can be added `not valid` and validated separately; that is a change to the
  migration's mechanics and not to its meaning, and it is not proposed now
  because the table does not warrant it.

The pricing-mode constraint is replaced rather than extended because a `CHECK`
with an `in` list cannot be widened in place. Dropping and re-adding it inside
the transaction leaves no window in which the table is unconstrained.

Replay from empty is unaffected: the file adds columns to tables 0001 and 0012
already created, and depends on nothing between.

## 15. Rollback and risk considerations

**This repository is forward-only. There are no down-migrations, there is no
`down` directory, and `scripts/migrate.ts` applies files in order and records
them in `schema_migrations` with no mechanism to reverse one.** Any statement
about rolling this back means writing a *new, higher-numbered* migration that
undoes it, and that is a different act from reverting a commit.

What that new migration could and could not do:

- **Before any workspace has used the feature** — no service set to
  `DURATION_RATE`, no `appointment_services` row with a non-null
  `billable_minutes_snapshot` — it can drop the five columns and restore the
  narrower constraint cleanly and lose nothing. This is the honest rollback
  window, and it is the argument for shipping the schema and the route in
  separate changes.
- **After any workspace has used it**, it cannot. Dropping
  `billable_minutes_snapshot` destroys the record of how a real charge was
  arrived at, on rows that are already on invoices customers have paid. A
  reversal at that point is a product decision about historical records, not a
  schema cleanup, and it would properly leave the columns in place and stop
  writing to them.

The residual risks, stated as risks rather than as things that have been solved:

- **The `PUT /services` interaction (question 10) is unresolved.** Until it is,
  an operator can lose a recorded duration by editing the service list. This is
  the highest-priority item on the list and it is a route decision.
- **The immutability trigger is a route guard's backstop, not a complete
  boundary.** It stops updates to the three columns once an invoice exists. It
  does not stop a delete, and deliberately so: the appointment cascade and the
  service-list replace both need to delete, and an invoice is protected by its
  own copies of the description and the amount regardless.
- **`price_minor_snapshot` has two authors.** On a duration-rate line it is
  written by the new route; on every other line by the existing two. The check
  constraint makes a wrong value unstorable rather than merely unlikely, which is
  why this is a note and not a blocker.
- **Reporting that groups by `duration_minutes_snapshot` will understate
  duration-rate work**, because the scheduled minutes and the billed minutes now
  genuinely differ. No existing report is known to do this; it is listed because
  the divergence is new and a future report could walk into it.
- **A minimum billable duration is absent** (question 5). If the pilot needs one,
  it is an additive column and another clause in the same check — not a redesign.

---

## Explicitly rejected

Each of these was ruled out by the owner. They are recorded with the reason, so
that the next reader who thinks of one can see it was considered.

**Client-side arbitrary price overrides — rejected.** Letting the browser post a
final amount would make the client the author of a price, which no other price in
Pawsh is. It also makes the amount unverifiable by construction: a number that
arrived from outside cannot be checked against inputs it does not carry, and the
database would be reduced to storing whatever it was told. The whole value of
this design is that the amount follows from three stored numbers; an override
path is the one change that would throw that away.

**`duration_minutes_snapshot` as the billable quantity — rejected.** Fully
answered in question 9: that column *is* `appointments.end_at`, so writing an
observed time into it moves the appointment's end, trips
`employee_appointment_no_overlap`, can trip the local-midnight guard, and
contradicts the ruling 0049 already made about actual time versus scheduled time.

**`invoice_items.quantity` as a hidden workaround — rejected.** It would appear
to fit — set `quantity` to the units, `unit_price_minor` to the rate — and it is
wrong in three ways at once. It puts the record of *how a service was priced* in
the **invoice** rather than on the appointment line, so the appointment that
generated it could no longer explain itself. It is unvalidated: `invoice_items`
has no constraint tying `amount_minor` to `quantity × unit_price_minor` — the
table's only checks are `quantity > 0`, `unit_price_minor >= 0`,
`amount_minor >= 0` and `line_position > 0` — so a wrong product would store
silently. And it overloads a column whose current meaning is "how many of this
thing": every row in the local database carries `quantity = 1`, and the receipt
renders it as a count of items, not as a count of quarter hours.

**Parsing the service note — rejected.** `operational_notes` is free text a human
wrote for another human. Deriving money from it makes a typo a pricing error,
makes a wording change a silent repricing, and puts the salon's revenue behind a
regular expression. It is the opposite of the direction the rest of this schema
has consistently moved: 0012's successors replaced a name-based price lookup with
an ID-based one specifically because matching on human-entered text had already
mispriced thousands of pets.

**Free-text dollar entry as the primary model — rejected as the primary model.**
"Let the operator type $60" is simple and it discards the reason for the whole
feature: a typed amount records *what was charged* and not *why*, so nothing can
audit it, no report can distinguish a long de-shed from a short one billed
generously, and the salon cannot answer "are we charging our own rate?" about its
own book. Note the scope of the rejection — this is a ruling about the *primary*
model. The `QUOTE_REQUIRED` mode already exists for services whose price is
genuinely a judgement, and nothing here changes it.

---

## The DDL, illustrative and **not applied**

**None of this has been run against any database except inside a transaction that
was rolled back, and no migration file exists.** It is shown so the owner can see
the shape of what is being proposed and how small it is. The filename it would
take is `migrations/0057_duration_rate_services.sql`, subject to the renumbering
note at the head of this record.

```sql
begin;

-- ---------------------------------------------------------------------------
-- DURATION_RATE: a service priced by how long it took.
--
-- Two configuration columns and a widened mode list. `rate_minor` is money per
-- interval in the workspace's minor units, like every other money column here;
-- `billing_interval_minutes` is the interval that rate buys. Per-minute billing
-- is this model with the interval set to 1, which is why there is no separate
-- mode for it.
--
-- THE SHAPE CONSTRAINT IS A BICONDITIONAL, not two null checks. A DURATION_RATE
-- service without a rate cannot be priced at all, and a FIXED service carrying
-- a stray rate is a row whose mode and configuration disagree - the reader
-- cannot tell which one is the mistake, so neither is allowed to exist.
-- ---------------------------------------------------------------------------
alter table services
  drop constraint service_pricing_mode_check,
  add constraint service_pricing_mode_check
    check (pricing_mode in ('FIXED','TIERED','WEIGHT_TIER','SERVICE_TYPE_FIXED',
                            'QUOTE_REQUIRED','RANGE','DURATION_RATE')),
  add column rate_minor integer,
  add column billing_interval_minutes integer,
  add constraint service_duration_rate_shape check (
    case when pricing_mode = 'DURATION_RATE'
      then rate_minor is not null and billing_interval_minutes is not null
      else rate_minor is null and billing_interval_minutes is null
    end
  ),
  add constraint service_rate_non_negative
    check (rate_minor is null or rate_minor >= 0),
  add constraint service_billing_interval_bounds
    check (billing_interval_minutes is null or billing_interval_minutes between 1 and 60);

-- ---------------------------------------------------------------------------
-- The appointment-time snapshot, beside the ones 0001 and 0012 already wrote.
--
-- `billable_minutes_snapshot` IS NOT `duration_minutes_snapshot` AND MUST NEVER
-- BE FOLDED INTO IT. That column is the SCHEDULE: both write paths sum it and
-- set `appointments.end_at` from the total, so a real observed time written
-- there would widen the booked interval, and 0001's
-- `employee_appointment_no_overlap` exclusion constraint would start refusing
-- writes to appointments nobody touched. 0049 settled exactly this question one
-- level up, for `checked_in_at`/`checked_out_at`, and its reasoning is quoted in
-- ADR-013. This column is the per-service sibling of those two.
--
-- THE RATE AND INTERVAL ARE COPIED, not read through `service_id`. A salon that
-- raises its de-shed rate in March must not reprice February's receipts, which
-- is the same reason `service_name_snapshot` exists beside the foreign key.
--
-- THE AGREEMENT CHECK IS THE POINT OF THE WHOLE DESIGN. It re-derives the
-- amount from the three inputs, so no route, script or psql session can store a
-- duration-rate line whose money does not follow from its own inputs. Integer
-- division on two positive integers truncates toward zero, so
-- `(m + i - 1) / i` is an exact ceiling with no numeric, no floating point and
-- no rounding mode to argue about. The ceiling is applied to UNITS and never to
-- money: a partial interval bills as a whole interval, which is how the salon
-- quotes the service, and the amount is always an exact multiple of the rate.
--
-- ALL THREE NULL IS THE SATISFIED STATE, so every row already in the table
-- passes and there is no backfill.
-- ---------------------------------------------------------------------------
alter table appointment_services
  add column billable_minutes_snapshot integer,
  add column rate_minor_snapshot integer,
  add column billing_interval_minutes_snapshot integer,
  add constraint appointment_service_duration_rate_shape check (
    case when billable_minutes_snapshot is null
      then rate_minor_snapshot is null and billing_interval_minutes_snapshot is null
      else billable_minutes_snapshot > 0
       and rate_minor_snapshot is not null and rate_minor_snapshot >= 0
       and billing_interval_minutes_snapshot between 1 and 60
       and price_minor_snapshot =
         ((billable_minutes_snapshot + billing_interval_minutes_snapshot - 1)
            / billing_interval_minutes_snapshot) * rate_minor_snapshot
    end
  );

-- ---------------------------------------------------------------------------
-- SEPARABLE. This trigger backs the route guard and can ship in its own change
-- without altering anything above.
--
-- `PUT /api/appointments/:id/services` already refuses once a non-void invoice
-- exists, and the new route carries the same refusal. This is what makes that
-- refusal a property of the data rather than of two handlers remembering.
--
-- UPDATE ONLY, and only these three columns. Deletes are left alone
-- deliberately: the appointment cascade and the service-list replace both need
-- to delete, and an invoice is protected by its own copies of the description
-- and the amount regardless of what happens to the line it came from.
--
-- THE LOOKUP IS FREE. 0001's `one_active_invoice_per_appointment` is a unique
-- index on `invoices (appointment_id) where status <> 'void'`, which is exactly
-- the predicate below.
-- ---------------------------------------------------------------------------
create or replace function appointment_service_duration_rate_is_immutable()
returns trigger language plpgsql as $$
begin
  if new.billable_minutes_snapshot is distinct from old.billable_minutes_snapshot
     or new.rate_minor_snapshot is distinct from old.rate_minor_snapshot
     or new.billing_interval_minutes_snapshot is distinct from old.billing_interval_minutes_snapshot
  then
    if exists (
      select 1 from invoices
      where business_id = old.business_id
        and appointment_id = old.appointment_id
        and status <> 'void'
    ) then
      raise exception 'recorded billable time cannot change once the appointment has an invoice';
    end if;
  end if;
  return new;
end $$;

create trigger appointment_service_duration_rate_immutable
  before update on appointment_services
  for each row execute function appointment_service_duration_rate_is_immutable();

insert into schema_migrations(version) values ('0057_duration_rate_services');
commit;
```

### What was checked, and how

The statements above were applied to the local development database inside a
transaction that was rolled back, and the rollback was confirmed afterwards by
querying `information_schema.columns`, `pg_trigger` and `pg_constraint` — none of
the five columns, the trigger or the new constraints is present. **Nothing is
applied anywhere.** What the exercise established:

- every statement is valid PostgreSQL against the schema as it stands at
  `0056_blocked_time_mutation_metadata`;
- all 7,059 existing `appointment_services` rows satisfy the new check on the day
  it is added, with no backfill;
- the ceiling arithmetic is exact at the boundaries — 1, 14 and 15 minutes bill
  one unit, 16 and 30 bill two, 45 bills three, and 46, 47 and 60 bill four, at
  `$15.00` per quarter hour;
- a row stating `47 minutes / 15-minute interval / $15.00 / $60.00` is accepted,
  and changing that row's amount to `$55.00` while leaving the inputs untouched
  is **refused**;
- a service set to `DURATION_RATE` without a rate is **refused**.

## Open decisions for the owner

Three things in this record are presented as choices rather than
recommendations, and none should be read as settled:

1. **Who may record billable minutes** (question 13). As designed, managers can
   and groomers cannot, which puts the capability one desk away from the person
   who measured the time.
2. **What a service-list edit does to a recorded duration** (question 10). The
   recommendation is to refuse the edit; the alternative is to preserve what can
   be matched, which is not well defined when a service repeats on one
   appointment.
3. **Whether a minimum billable duration is needed for the pilot** (question 5).
   Left out, additive if wanted.

## Consequences

- A salon can price de-shedding by the time it takes, which is how it is actually
  sold, and the receipt can say so.
- Every duration-rate amount in the database follows from three numbers stored
  beside it, and the database refuses to hold one that does not.
- The money path is untouched. `POST /api/appointments/:id/checkout` reads
  `price_minor_snapshot` as it always has and does not know this feature exists.
- Nothing existing reprices. No seeded service changes mode, no historical row is
  rewritten, and a workspace that ignores the feature bills exactly what it
  billed before.
- A permission that has gated nothing since 0045 starts gating something, without
  a grant, a revocation or a role migration.
- The scheduled duration and the billed duration become genuinely different
  numbers on some lines, and anything that treated them as one was already wrong.
