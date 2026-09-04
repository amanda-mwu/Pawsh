# ADR-012: Ready for Pickup, the waiting list, appointment confirmation, and Contact

Status: **Proposed; not built.** Nothing in this record exists.
`ready_for_pickup` does not appear in the `appointment_status` enum or anywhere
in `src/`, `public/` or `tests/`; there is no waitlist table, route or client
surface; there is no confirmation field and no Contact send path. The record
describes the work in full and the work has not started.

The status was previously "Accepted", which readers took as a statement about
the repository and which the repository does not support. It is corrected to
describe what is true. The design below is not withdrawn and no decision in it is
reopened by this line; whether Product has agreed the design is a separate
question from whether the design is built, and only the second is settled here.

It **would** amend the lifecycle recorded in
`docs/architecture/appointment-lifecycle.md` and the workflow recorded in
`docs/specifications/appointment-workflow.md`. Neither has been amended. An
earlier version of this line said both "are updated"; they were not, and neither
mentions Ready for Pickup, the waiting list or this record at all. They describe
the lifecycle the product actually has, which is the correct thing for them to
describe while this record is unbuilt, and they are to be amended by the change
that implements it rather than ahead of it.

**The migration numbers named in this record are not reserved and several are
already taken.** This record names `0051`, `0052`, `0054` and `0055`. Both of the
first two have since been written by unrelated work: `0051` is
`0051_local_wall_clock_integrity.sql`, the repair that derives the denormalised
local wall clock from the instant it belongs to, and `0052` is
`0052_tenant_qualified_foreign_keys.sql`. Neither has anything to do with Ready
for Pickup. `0054` and `0055` are unallocated as this is written and carry no
claim, which is not the same as being held. Migration numbers in this
repository are allocated when a migration file is written, in the order files are
written, and a record cannot hold one open in advance — which is precisely how
the collision below happened. Every migration filename in the body of this record
is therefore to be read as *"a migration, whose number is assigned when it is
written"*, and the numbers are retained only because the surrounding prose refers
to them by name. **The two-file split of the enum change is a real constraint and
survives the renumbering**: the file that runs `alter type … add value` must be a
different file, and therefore a different transaction, from the first file that
uses the new label. That is a property of the pair, not of the numbers 0051 and
0052.

Four capabilities arrive from one reference surface: the appointment detail
footer. Three are new product, one is a new client-messaging feature, and a
fifth thing — the rule by which a control that does not apply is presented — is
the spine that holds them together. It is decided first, because each of the
four would otherwise grow its own copy of it.

## 0. The action-state contract, which is decided first

**A control that exists is always drawn. When it does not apply it is drawn
disabled, carrying a sentence that says why. It is never hidden, and the client
never composes that sentence.**

The client cannot be the author of that rule. `permissionForTransition` in
`packages/domain/src/permissions.ts` already says so in its own doc comment —
"a client that guesses from the current status instead will hide an action the
caller is allowed to take, or offer one the server will refuse" — and then the
web client guesses anyway, in `derive()` at `public/app.js:12244`, which
recomputes `readOnly`, `move`, `adjustServices`, `checkout`, `cancel`, `ticket`
and `editNote` from status and permission strings. That matrix is a second
rulebook. It has been survivable with seven controls and one lifecycle. It does
not survive nine footer controls, eight Contact items and four new features,
because each new rule would have to be written twice and the two copies would
disagree the first time only one of them was updated.

So `GET /api/appointments/:id` gains an `actions` object, and every entry in it
has exactly one shape:

```
{ available: boolean, reason: string | null }
```

`reason` is non-null exactly when `available` is false. The client renders every
control unconditionally, sets `disabled` from `available`, and puts `reason` in
the tooltip and in the accessible description. It composes no reason of its own
and derives no availability of its own.

The entries are `cancel`, `void`, `waitlist`, `contact` (which nests one entry
per menu item), `bookAgain`, `readyForPickup`, `checkIn`, `checkOut`, `confirm`
and `ticket`.

Three consequences, stated so they are not rediscovered:

- **It is computed by a pure domain function**, `appointmentFooterActions()`,
  placed beside `appointmentPrimaryActions` in
  `packages/domain/src/presentation.ts`. It takes the appointment row, the
  caller's permissions and a small facts object, and returns the tree. It
  performs no I/O, so it is unit-testable over the whole cross product of status
  and permission, and the mobile client gets the same answers for free.
- **It is attached to the single-appointment response only, never to the
  calendar list.** `appointmentCalendarRows` at `src/http/routes.ts:591` serves
  a day of the calendar; computing ten action states per row would be paid on
  every calendar paint to answer a question only the open detail modal asks.
  `GET /api/appointments/:id` at `:8279` uses the same projection and is the one
  place the tree is attached.
- **The server still checks.** The tree decides what is drawn. Every route goes
  on validating its own preconditions exactly as it does today. A disabled
  button is a courtesy; the 400, 403 and 409 are the authorization.

`GET /api/appointments/:id` needs two facts the shared projection does not
carry, and they are added to that route alone:

- `hasVoidablePayment` — `exists (select 1 from payments where business_id=…
  and invoice_id=inv.id and status='recorded' and provider is null)`.
  `provider is null` is not an optimisation: `POST /api/payments/:id/void`
  refuses a provider payment outright with `PAYMENT_REQUIRES_REFUND`, so a
  provider payment is not voidable and counting it would light a button the
  server would refuse.
- `confirmRequestSentCount` — how many `appointment_confirm_request` intents for
  this appointment have reached `sent`. Contact's second chase-up needs it.

## 1. Ready for Pickup

**It is a new `appointment_status` enum value, `ready_for_pickup`, sitting
between `in_service` and `completed`. It is not a flag beside the status.**

The alternative was a `ready_for_pickup_at` column on an appointment that stays
`in_service`, and it is rejected because a dog cannot be both being groomed and
waiting to be collected. That is a state, not an attribute of a state, and
encoding it beside the status would put the lifecycle in two columns — the
two-sources-of-truth failure this schema's comments refuse over and over, most
recently in 0049 and 0050. A flag would need its own route, its own permission,
its own audit verb and its own invented rules about what happens to it on
cancel, on completion and on reschedule: a parallel half-lifecycle built to
avoid touching an enum. The enum change is wide but mechanical, and three total
`Record<AppointmentStatus, …>` maps turn most of it into compile errors that
enumerate the work rather than leaving it to be found in QA.

### What `completed` now means, which is the decision that makes the rest easy

`completed` already meant more than "the groomer finished". Migration 0049
stamps `checked_out_at` on the transition to `completed` and refuses to stamp it
on `cancelled` or `no_show`, on the stated grounds that those visits never
ended. So `completed` has always been the moment the visit ended — the pet went
home. What the product could not express was the gap between the groomer
finishing and the owner arriving, and `ready_for_pickup` is exactly that gap.

Because `completed` keeps its meaning, **the financial surface does not move at
all**. `POST /api/appointments/:id/checkout` goes on refusing anything that is
not `completed` with `STALE_FINANCIAL_STATE`, the checkout specification is
unchanged, and no report that counts `status='completed'` changes what it
counts. Checkout is not reachable from `ready_for_pickup`, and that is correct
rather than a limitation: taking money is the act of handing the pet back, and
the two happen together at the front desk.

### It does not reserve the groomer's time

`ready_for_pickup` is **not** added to the reserving set. The predicate lives in
three PL/pgSQL functions — `enforce_employee_schedule_conflict` in
`migrations/0002_scheduling_conflict_overrides.sql:18,31`,
`enforce_appointment_employee_conflict` and
`enforce_assigned_employee_schedule_conflict` in
`migrations/0015_multi_groomer_booking.sql:24,29,43,49` — and in the application
mirror `findSchedulingConflicts` at `src/http/routes.ts:1125`. The 0001
exclusion constraint named in those errors was dropped by 0002 and is not live;
the triggers are the rule.

The reservation predicate protects a groomer's *working* time. A dog in a crate
waiting for its owner is not occupying a groomer, and the whole operational
point of the state is that the groomer has moved on to the next dog. If it
reserved, a salon that marks dogs ready promptly would find its groomers'
calendars blocked by dogs that left an hour ago and were never checked out,
because collection is a front-desk act that lags the work. That is the failure
mode, and it is worse than the one it would avoid.

No existing row carries the new value, so neither choice changes any current
behaviour on the day it ships. The difference is entirely about what happens
afterwards, which is why it is decided here rather than discovered.

### The transitions, and the one that is deliberately kept

- `in_service` → `ready_for_pickup` — new.
- `ready_for_pickup` → `completed` — new.
- `in_service` → `completed` — **kept, unchanged.**

Keeping the direct edge is the point. `ready_for_pickup` is an **optional
waypoint**, not a mandatory hop. A salon whose owners wait in the shop should
never be forced through it, and removing the direct edge would rewrite every
existing workflow, the Groomer preset's daily path, and
`tests/e2e/fixtures/tenant.ts:151` for no product gain.

There is no edge into `cancelled` or `no_show` from `ready_for_pickup`: the pet
is physically in the shop, and a visit that has been performed cannot become one
that never happened. There is no edge back to `in_service`. A groomer who spots
a missed patch after marking a dog ready is a real case, and it is deliberately
not solved with a backward edge — this state machine has none, "reopen is absent
and deferred" is the standing rule, and the first backward edge would be a
precedent rather than a fix. It is deferred with that reason.

### Permission: `operations.perform_service`, reused

No new permission. The transition is gated on `operations.perform_service` — the
same key that gates starting the work — because the person who may start
grooming a dog is the person who says the grooming is finished, and no salon has
a reason to split those. `permissionForTransition` already shares one key
between two targets (`cancelled` and `no_show` both take `appointments.cancel`),
so the shape is precedented. A new key would need a taxonomy entry, a
`permissionGroups` placement, and a migration granting it to every existing role
or the workflow would silently break on upgrade — all to express a distinction
nobody has asked for.

`permissionForTransition` must gain an **explicit branch** all the same, because
its final `return "appointments.cancel"` is a fallthrough: without a branch,
marking a dog ready for pickup would be silently gated on cancel permission. The
server's duplicate of that chain at `src/http/routes.ts:9228` must gain the same
branch in the same change. That the two are duplicated is a pre-existing defect
and is noted, not fixed here.

### Audit, events, and time

- Audit action `appointment.ready_for_pickup`, written by `record()` in the
  transition transaction like every other one, `before`/`after` carrying the
  status pair.
- **No outbox event, and no analytics event.** This follows the standing
  no-show precedent verbatim: a domain event is added when a concrete downstream
  contract exists, and today nothing consumes one. The obvious consumer — "tell
  the owner their dog is ready" — is Contact's Send Pickup Message, which is a
  staff-initiated send, not an automatic one. When automatic pickup notification
  is decided, the event is added then, with a consumer.
- **No `ready_at` column.** Nothing reads it. The audit event records when it
  happened, and 0049's argument for a column — that scanning `audit_events` does
  not generalise to a projection — does not apply until a projection or a report
  wants the collection wait. When one does, the column is added with that reader
  named.

### The migration is two files, and this is not optional

`alter type … add value` may run inside a transaction block in PostgreSQL 17,
but **the new value may not be used in the same transaction that added it**.
`scripts/apply-migrations.ts:36` applies each file in one `sql.unsafe(migration)`
call, so one file is one transaction and a later file is a later transaction.

- `…_appointment_ready_for_pickup.sql` — `alter type appointment_status add
  value 'ready_for_pickup' before 'completed'` and nothing else. `before
  'completed'` puts the label in lifecycle order, which affects only `order by
  status` and `min`/`max`; nothing sorts on it today, and getting it right is
  free now and awkward later.
- `…_ready_for_pickup_scheduling.sql` — the immediately following number —
  `create or replace` for the three trigger functions, with the new label
  omitted from all six `status in (…)` predicates and a comment saying it is
  omitted deliberately.

The numbers are assigned when the files are written. What matters is that they
are two consecutive files in that order, not which integers they get.

A PL/pgSQL body is parsed lazily, so the two *could* be one file. They are not,
because the cost of being wrong about that is a migration that fails in
production, and the cost of being right about it is one extra file.

The second of the two files also carries a correction. The comment at
`migrations/0049_appointment_lifecycle_times.sql:110` asserts that `completed` is
reachable only from `in_service`. That is no longer true. 0049 has run and must
not be edited, so the correction is recorded in that second file, where the next
reader of the lifecycle will find it. The `appointment_times_ordered` check constraint is
unaffected and stays as it is.

## 2. To WaitingList

**A waitlist entry is a record of unmet demand. It holds no time, no groomer and
no reservation. Sending an appointment to the waiting list cancels the
appointment and creates the entry, atomically, in one route.**

The alternative was a `waitlisted` appointment status, and it is rejected for a
concrete reason rather than a stylistic one: a waitlisted appointment would
still carry `start_at` and `end_at`, which is a claim on a time it no longer
holds. It would render on the calendar at that time, sit in the
`appointment_calendar` index, and count as upcoming. Making
`appointments.start_at` nullable to avoid that is a change to the core
scheduling model of exactly the character 0050 refused when it declined to make
`invoices.appointment_id` nullable for gift cards. Appointments are Pawsh's
reservation object, and every invariant they carry — `check (start_at < end_at)`,
the three conflict triggers, `scheduled_local_start`, the lifecycle machine —
exists because they hold time. A want is not a reservation.

It also avoids a second `alter type … add value` in the same release as the
first, which would double the blast radius through every map the enum touches.

### Cancelling is the honest thing to do

The route performs an ordinary cancellation: status `cancelled`, audit
`appointment.cancelled`, outbox `AppointmentCancelled`, rabies intents
suppressed — all the existing machinery, unchanged, because all of it is
correct. The salon no longer holds that time for that client, and saying so is
true. The cancellation `reason` names the waiting list, and a second audit event
`waitlist.entry_created` records the entry against the new resource.

A consequence, stated rather than discovered: `AppointmentCancelled` already
queues an `appointment_cancellation` email, so the client is told their
appointment was cancelled. That is accurate but bare. It is not papered over
with a suppression flag; the salon follows it with a Contact message, and a
dedicated waiting-list template is deferred until a salon asks for one.

### The table

A migration `…_appointment_waitlist.sql`, whose number is assigned when it is
written, in the shape 0048 and 0050 established:

```sql
create table appointment_waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id),
  location_id uuid not null,
  customer_id uuid not null,
  pet_id uuid not null,

  -- NOT NULL, DELIBERATELY. Every entry this change ships comes from an
  -- appointment being sent to the list, and the services wanted are read
  -- through it -- `appointment_services` rows survive a cancellation. The
  -- phone-call entry ("they want any Saturday in March") is a real and
  -- probably larger feature, and it is NOT anticipated here with a nullable
  -- column nothing writes: that is the invitation 0050 refused when it
  -- declined a nullable `expires_at`. When it arrives it relaxes this column
  -- and adds a requested-services child table, in one honest migration.
  source_appointment_id uuid not null,

  desired_from date,
  desired_to date,
  note text check (note is null or char_length(btrim(note)) <= 500),

  status text not null default 'waiting'
    check (status in ('waiting', 'booked', 'expired', 'removed')),
  booked_appointment_id uuid,
  resolved_at timestamptz,

  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (business_id, id),
  foreign key (business_id, location_id) references locations (business_id, id),
  foreign key (business_id, customer_id) references customers (business_id, id),
  foreign key (business_id, customer_id, pet_id)
    references pets (business_id, customer_id, id),
  foreign key (business_id, source_appointment_id)
    references appointments (business_id, id),
  foreign key (business_id, booked_appointment_id)
    references appointments (business_id, id),

  check (desired_to is null or desired_from is null or desired_to >= desired_from),

  -- A booked entry names the appointment that satisfied it, and an entry that
  -- is not booked names none. Written as a biconditional so neither half can
  -- drift from the other.
  constraint waitlist_booked_names_appointment check (
    (status = 'booked') = (booked_appointment_id is not null)
  ),
  constraint waitlist_resolved_has_time check (
    (status = 'waiting') = (resolved_at is null)
  )
);

-- ONE OPEN ENTRY PER SOURCE APPOINTMENT. A double-clicked "To WaitingList" must
-- not cancel once and enqueue twice. Partial on the open state so a removed or
-- expired entry does not block a later one, in the shape 0020 used for
-- `one_open_agreement_notification`.
create unique index waitlist_open_entry_per_appointment
  on appointment_waitlist_entries (business_id, source_appointment_id)
  where status = 'waiting';

create index waitlist_open_queue
  on appointment_waitlist_entries (business_id, status, created_at)
  where status = 'waiting';

alter table appointment_waitlist_entries enable row level security;
create policy tenant_isolation on appointment_waitlist_entries
using (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
with check (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
```

As 0048 and 0050 both state: the RLS policy enforces nothing while Pawsh
connects as the table owner without `FORCE ROW LEVEL SECURITY`. The composite
foreign keys are the defence that actually holds.

### Routes and permission

- `POST /api/appointments/:id/waitlist` — cancel and enqueue, one transaction.
  Requires `appointments.cancel` **and** `waitlist.manage`.
- `GET /api/waitlist` — the queue, filtered by status. Requires
  `appointments.view`.
- `PATCH /api/waitlist/:id` — edit the note and window, or set `removed` /
  `expired`. Requires `waitlist.manage`.
- Booking off the list is **not a new route**. The existing appointment-create
  route gains an optional `waitlistEntryId`; when present, the entry moves to
  `booked` with `booked_appointment_id` set inside the same transaction that
  creates the appointment. A second route would allow a window in which the
  appointment exists while the entry still said `waiting`.

One new permission, `waitlist.manage`, in the `appointment` group. Reading is
gated on `appointments.view` rather than a second key: a salon that lets someone
see the calendar has no reason to hide the waiting list from them, and a second
key doubles the migration surface for no distinction anyone has asked for. The
migration grants `waitlist.manage` to every role already holding
`appointments.cancel`, which is 0045's pattern and means no workspace loses a
capability on upgrade. It does **not** go in `unenforcedPermissions` — it bites
on arrival, and listing an enforced key there would tell an owner a switch does
nothing while it is refusing their staff.

### The reference's future-only restriction is right, and it is not the whole rule

The real predicate is `status = 'scheduled' AND start_at > now()`. The status
half matters more than the time half: the dog must not have arrived, because
sending a checked-in pet to a waiting list is not a thing that can happen. The
time half matters too, because a `scheduled` appointment whose start has passed
is an unresolved no-show — cancelling it retroactively is a records correction
rather than a scheduling act, and there is no demand left to record because the
date has gone.

### Who is notified when a slot opens: nobody, on purpose

There is no matching engine and no automatic notification. A slot opening,
finding the entries that fit it, ranking them and telling the client needs
matching rules, client consent, and an inbound path for the answer — none of
which exist. The shipped feature is a queue a human works, and that is the
version that is genuinely useful rather than the fullest one. Automatic matching
is deferred and needs a decision record of its own.

## 3. Confirmed / Un-confirmed

**A nullable `confirmed_at timestamptz` and a nullable `confirmed_by uuid`. Not
a boolean, not an enum.**

`confirmed_at is null` is unconfirmed; a value is confirmed, and it says when.
"When did they confirm?" is the exact question a salon needs when a client says
they never did, and a boolean cannot answer it. This is 0049's rule applied
again: nullable, no default, because an appointment nobody has confirmed has no
confirmation time and `null` is what that is. A two-valued enum is a boolean with
extra syntax and loses the timestamp as well.

`confirmed_by` names the staff member who recorded it. Un-confirming sets both
back to `null`; the fact that it was ever confirmed survives in `audit_events`,
which is the same division of labour 0049 wrote down — the column says what is
true now and is editable, the log says whose hands have been on it and is
append-only.

**No `confirmation_source` column.** There is exactly one source today, a staff
member. A column whose every row would read `'staff'` is a column nothing reads,
and when a client-answered path exists it adds the column with a
`default 'staff'` backfill in one line.

### Route and permission

`PATCH /api/appointments/:id/confirmation`, body
`{ confirmed: boolean, version?: number }`, returning the full calendar row —
following `PATCH /api/appointments/:id/times` at `src/http/routes.ts:9325` in
every respect, so a detail screen re-renders from the projection it opened with
rather than merging two shapes.

Gated on `appointments.edit`, and the reasoning is `PATCH /times`'s own,
verbatim: the `operations.*` keys authorize *performing* something, and
recording that a client confirmed is amending a record, not performing a step of
the visit. Audit actions `appointment.confirmed` and `appointment.unconfirmed`,
`before`/`after` carrying `confirmedAt`.

### It gates nothing, and that is a decision

Confirmation is informational. It does not gate check-in, service, completion,
checkout or anything else. Gating check-in on it would put a blocker on the
busiest path in the product and refuse a dog standing in the shop because nobody
answered the phone; gating anything financial would be worse. It is a front-desk
planning signal — *who have we reached about tomorrow* — and its value is that it
is cheap and never in the way.

### A reschedule clears it

`PATCH /api/appointments/:id/schedule` sets `confirmed_at` and `confirmed_by`
back to `null` and audits the clearing. A client confirmed a time, not an
appointment; carrying the confirmation across a move would have the product
assert that someone agreed to a time they were never told about. A services
change does **not** clear it — attendance was confirmed, not a service list.

### Engagement: left compatible, not wired

The engagement layer is strictly outbound and single-channel. There is no
inbound path anywhere in Pawsh: no tokenised client link, no reply handler, no
public route keyed by a customer, and no RLS story for an anonymous actor —
every engagement table's policy depends on `app.business_id` set by `setTenant`.
Client agreements are the worked precedent and they resolve the same way, with
the email asking the client to confirm with the salon and a staff member
recording the answer; the code says so twice, at `src/http/routes.ts:1017` and
`:6172`.

So confirmation is recorded by staff today. The column is the same column a
future inbound path would write, and the only additions that path needs are a
`notification_type` for the ask and a branch in `processOutbox` — both additive.

**A naming collision that must not be walked into:** `appointment_confirmation`
is an existing `notification_type` and it means the opposite of this feature. It
is the outbound "we have booked you" email sent at `now()` on
`AppointmentCreated` (`src/engagement/worker.ts:191`), with subject "Pawsh
appointment confirmation". The confirmation-request messages take the new names
`appointment_confirm_request` and `appointment_confirm_request_2`, and nothing in
this feature reuses the word for the old meaning.

## 4. Contact

**Contact is a templated client-messaging feature, it is the largest of the
four, and it ships in three stages. Six of the eight menu items ship now as
code-defined outbound email. Two do not ship at all and are drawn greyed with an
honest reason.**

### What Pawsh can actually send

`notification_intents` (0001, extended by 0010 and 0020) is already a
general-purpose outbound-message table: business, appointment, customer,
free-text `notification_type`, channel, destination, AES-256-GCM-sealed
`encrypted_body`, status, provider reference, attempt count, with
`notification_delivery_attempts` beside it. It is not rabies-specific; only some
of its `notification_type` values are. Delivery is `deliverNotifications` in
`src/engagement/worker.ts`, driven by a 15-second interval in `src/app.ts:219`,
over nodemailer SMTP in production and a logging adapter without `SMTP_HOST`.

Email is the only channel — `check (channel in ('email'))` — and there is no SMS
transport, no credentials and no cost model. `channel` accepts `"sms"` in three
request schemas *solely so the handler can refuse it by name*, which is the
existing and correct treatment and is reused unchanged.

### The six are code-defined, and there is no template table

A stored `message_templates` row implies an editor, placeholder syntax,
placeholder validation, per-salon customisation, and a migration path when a
placeholder is renamed. That is a feature in its own right, and the product has
already recorded that it is a later one: `settings.auto_messages` sits in the
taxonomy today as an unenforced promise. Every message Pawsh sends now is
code-defined — the subject line is a ternary at `src/engagement/worker.ts:330` —
and these six are fixed transactional messages with fixed variables.

So the six are functions. Each composes a plain-text body and a subject at
enqueue time, seals the body into `encrypted_body` through the mechanism that
already exists, and the delivery path is untouched except for six new subject
cases. **Contact needs no templating engine and no template table.**
`settings.auto_messages` is the key that graduates on the day these become
salon-editable.

### The stages, stated plainly

**Stage 1, ships with this record.** Items 1, 2, 4, 5, 6, 7, over email:

| # | Item | `notification_type` | Note |
| --- | --- | --- | --- |
| 1 | Send ETA Message | `appointment_eta` | Composed from `end_at`; the request may carry an override time. |
| 2 | Send Pickup Message | `appointment_pickup` | The companion to Ready for Pickup. |
| 4 | Send New Appointment Message | `appointment_confirmation` | **Reuses the existing type.** This message already exists and is auto-sent on `AppointmentCreated`; item 4 is a manual re-send, and `POST /api/reminders/:id/send` is the precedent for one. |
| 5 | Send Rescheduled Appointment Message | `appointment_rescheduled` | New. Today a reschedule re-times the reminder and announces nothing. |
| 6 | Send Unconfirm Appointment Message | `appointment_confirm_request` | The ask. Not `appointment_confirmation`, which is taken and means the opposite. |
| 7 | Send Second Unconfirm Appointment Message | `appointment_confirm_request_2` | A separate type so the history distinguishes the first chase from the second. |

**Stage 2, not now: Send Bill Link.** This is not a template. A bill link is a
URL a client opens *without logging in*, which means a token table with a hashing
scheme, a public route namespace, rate limiting for an anonymous caller, an
expiry policy, and an RLS story for a request that carries no `app.business_id` —
none of which exist, and which together put an invoice on the public internet
behind a token. That is a security surface Pawsh has never had and it needs its
own decision record and a security review.

**Stage 3, not now: Send Two-way Message.** Two-way means inbound, and inbound is
a capability class rather than an extension: an inbound transport (reply parsing,
or an SMS provider and its webhook), a conversation and message model, thread
state, read state, and assignment. The Messages workspace at
`public/index.html:89` is a shell — it says "Messaging is not enabled for this
workspace", there is no `/api/messages` route and no message table in any
migration — and it should go on saying so.

### What is recorded when a message is sent

The `notification_intents` row is the message; the
`notification_delivery_attempts` rows are the delivery evidence, carrying attempt
number, outcome, provider reference and error. Together they are the answer to
"nobody told me".

They do not record **who pressed the button** — `notification_intents` has no
actor column. That is the question a dispute actually turns on, so the send route
additionally writes an audit event `message.sent`, resource type `appointment`,
whose `after` carries the notification type and the intent id. `record()` stamps
the actor, so this needs no schema change and no new column.

### One migration, for one index and one permission

A migration `…_client_messaging.sql`, whose number is assigned when it is
written:

```sql
-- A double-clicked menu item must not send a client two identical emails.
-- Partial on the in-flight states only, so a legitimate resend after delivery
-- is still allowed -- which it must be, because resending a pickup message is
-- an ordinary thing to do. Copied from `one_open_agreement_notification` in
-- 0020, which solves exactly this problem for agreement requests.
create unique index one_open_appointment_message
  on notification_intents (business_id, appointment_id, notification_type)
  where appointment_id is not null and status in ('pending', 'sending');
```

plus the grant of the new permission. `notification_type` has no check
constraint, so the six new values need no migration at all.

One new permission, `messages.send`, placed in the existing `messaging` group
beside `messages.view`, granted to every role already holding `appointments.edit`.
It is **enforced on arrival** and therefore must not be added to
`unenforcedPermissions`. `messages.view` stays unenforced: it gates the message
centre, which is still a shell.

## 5. The footer, control by control

`available: false` always carries a reason. Permission failures are checked first
and their reason is returned without disclosing anything the caller may not see.

| Control | Available when | Greyed reason otherwise |
| --- | --- | --- |
| **Cancel** | `scheduled`, with `appointments.cancel` | terminal: "This appointment is already {cancelled / completed / a no-show}." · in-shop: "The pet has already arrived. Complete the visit instead." |
| **Void** | see below | see below |
| **To WaitingList** | `scheduled` and `start_at > now()`, with `appointments.cancel` + `waitlist.manage` | past start: "This appointment's time has already passed." · not scheduled: "Only a booked appointment can go on the waiting list." |
| **Contact** | always; each of the eight carries its own state | — |
| **Book Again** | always, with `appointments.create` | "You do not have permission to book appointments." |
| **Ready to Pickup** | `in_service`, with `operations.perform_service` | `scheduled`: "The pet has not arrived yet." · `checked_in`: "The groom has not started yet." · `ready_for_pickup`: "This pet is already marked ready." · terminal: "The visit has ended." |
| **Check in** | `scheduled`, with `operations.check_in` | already in shop: "This pet was checked in at {time}." · terminal: "The visit has ended." |
| **Check out** | `completed`, no live invoice, with `checkout.perform` | `ready_for_pickup`: "Complete the visit first — check out records the pet going home." · earlier: "The groom is not finished yet." · invoiced: "This visit has already been checked out." |
| **Confirmed toggle** | `scheduled` and `start_at > now()`, with `appointments.edit` | past or terminal: "Confirmation only applies to an appointment that has not happened yet." |
| **Ticket** | always | — |

### Void, which was the open question

The footer's Void is **not an appointment action**. It voids a payment, and an
appointment may have none, one, or several. It maps onto
`POST /api/payments/:id/void` — the audited "Void record" control gated on
`checkout.perform` — and nothing new is built for it. The button opens the
visit's payments and voids the chosen one; where exactly one voidable payment
exists it may act directly behind a confirmation.

Its states, in precedence order:

1. Caller lacks `checkout.perform` → *"You do not have permission to void a
   payment."*
2. Caller lacks `payments.view` → *"Void needs permission to see this visit's
   payments."* **This case is checked before the three below, deliberately.**
   Every reason underneath discloses whether money was taken and how, and a
   reason string is as much a disclosure as a payload. A caller who may not read
   payments is told they may not read payments, and nothing else.
3. No invoice → *"This visit has not been checked out, so there is no payment to
   void."*
4. Invoice exists, no payment in `recorded` → *"No payment has been recorded on
   this visit."*
5. Every recorded payment carries a `provider` → *"This payment was taken on a
   card terminal, so it cannot be voided. Refund it instead."* The server already
   refuses this case with `PAYMENT_REQUIRES_REFUND`, and this reason is that
   refusal's own wording, so the greyed button and the 409 say the same thing.
6. Otherwise available.

### Contact's eight

| Item | Available when | Greyed reason otherwise |
| --- | --- | --- |
| 1. ETA | `checked_in` or `in_service` | `scheduled`: "The pet has not arrived yet." · `ready_for_pickup`: "The groom is finished — send the pickup message instead." · terminal: "The visit has ended." |
| 2. Pickup | `in_service` or `ready_for_pickup` | before: "The groomer has not finished yet." · after: "The pet has already been collected." |
| 3. Two-way | **never** | "Two-way messaging is not available in Pawsh yet." |
| 4. New Appointment | `scheduled` and `start_at > now()` | "This appointment has already happened." / "This appointment was cancelled." |
| 5. Rescheduled | `scheduled` and `start_at > now()` | as item 4 |
| 6. Unconfirm | `scheduled`, `start_at > now()`, `confirmed_at is null` | confirmed: "This client has already confirmed." · otherwise as item 4 |
| 7. Second Unconfirm | as item 6, **and** at least one `appointment_confirm_request` has reached `sent` | "Send the first confirmation request first." |
| 8. Bill Link | **never** | "Bill links are not available in Pawsh yet." |

Items 3 and 8 are drawn, disabled and honest, which is the rule this record
opened with. They are not wired to a route that would 404, and they are not
hidden.

Item 5 is deliberately **not** gated on proof that the appointment was in fact
rescheduled. Requiring the server to establish that would add a subquery to
answer a judgement the operator pressing the menu item has already made. The
tradeoff is that the message can be sent about an appointment that never moved;
it is accepted, and stated here so it is a decision rather than an oversight.

Every item is additionally greyed for a caller without `messages.send` —
*"You do not have permission to send client messages."* — and for a customer with
no email address on file: *"This client has no email address on file."* That last
one is not hypothetical: partial client records have been supported since 0023,
and a salon will meet it.

## Validation

- **Domain.** `appointmentFooterActions()` is exercised over the full cross
  product of status × permission set × facts object, asserting that `reason` is
  non-null exactly when `available` is false, and that no reason string is ever
  produced by the client. The transition matrix test in
  `tests/domain/appointments.test.ts` already iterates
  `appointmentStatuses × appointmentStatuses`; adding the value expands it, and
  every new pair must be false except the two named here.
  `tests/domain/domain-labels.test.ts` asserts `appointmentStatusBadges` has
  exactly the domain's keys, so the badge is a compile-and-test gate rather than
  a thing to remember.
- **Migration.** A test asserts that the `alter type` file contains the `alter
  type` and nothing that uses the new label, and that the scheduling file that
  follows it contains no `alter type`. The split is the correctness property and
  it should fail loudly if the files are merged. The test must locate the two
  files by name rather than by number, because the numbers are whatever is free
  when the migration is written.
- **Database, under concurrency.** Two simultaneous "To WaitingList" calls on one
  appointment produce one entry and one cancellation;
  `waitlist_open_entry_per_appointment` is the guarantee and the test is what
  proves it holds. Two simultaneous sends of one Contact item produce one
  `notification_intents` row, guarded by `one_open_appointment_message`.
- **Scheduling.** A `ready_for_pickup` appointment does not block a booking over
  its interval, and an `in_service` one still does — asserted through the real
  routes against all three trigger functions, not against
  `findSchedulingConflicts` alone, because the trigger and the application mirror
  are two copies of one predicate and the test must prove they agree.
- **Financial.** Checkout is refused from `ready_for_pickup` with
  `STALE_FINANCIAL_STATE`, and the Single Money Statement assertions in
  `tests/database/single-money-statement.test.ts` continue to pass unchanged —
  which is the evidence that this record moved no money.
- **Confirmation.** Rescheduling a confirmed appointment clears `confirmed_at`
  and writes the clearing to the audit trail; changing its services does not.
- **Regression.** `tests/e2e/fixtures/tenant.ts:151` drives
  `["checked_in","in_service","completed"]` to reach checkout. It must keep
  working untouched, because that is the proof that `ready_for_pickup` is
  optional rather than mandatory. A separate fixture drives the four-hop path.
- **Human QA.** The footer in every appointment state, with a Manager, a
  Receptionist and a Groomer, confirming that every control is present in all
  three and that each disabled one explains itself.

## Deferred, and not built here

- A backward edge out of `ready_for_pickup`, and reopening any terminal state.
- A `ready_at` column, until a projection or report reads it.
- An outbox or analytics event for `ready_for_pickup`, until a consumer exists.
- Waitlist entries with no source appointment, a requested-services child table,
  automatic slot matching, and any automatic notification when a slot opens.
- A `confirmation_source` column, and any client-facing confirmation path.
- Send Bill Link, and every part of a public unauthenticated client surface.
- Send Two-way Message, inbound messaging of any kind, and SMS.
- Salon-editable message templates; `settings.auto_messages` remains the key that
  graduates when they arrive.
- Splitting the duplicated transition-permission chain between
  `packages/domain/src/permissions.ts:554` and `src/http/routes.ts:9228`. It is a
  real defect, it is noted, and fixing it inside a change that adds a status
  would hide the fix inside the risk.

## A risk to hold, stated once

Two of Contact's eight items are new capability classes wearing the clothes of
buttons. Two-way is an inbound-messaging product, and Bill Link is a public
unauthenticated client surface — the first thing in Pawsh that would put a
customer's bill on the open internet. Neither is a template and neither belongs
inside this record's scope; both need their own decision, and Bill Link needs a
security review before a line of it is written. They ship greyed with honest
reasons, which is the rule Product set and which costs nothing.

The rest is sound. Ready for Pickup is a wide but mechanical change whose risk is
concentrated in three PL/pgSQL predicates and one enum migration that must be
split. The waiting list is a clean new table. Confirmation is two columns.
