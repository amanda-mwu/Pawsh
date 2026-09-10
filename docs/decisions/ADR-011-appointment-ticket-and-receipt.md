# ADR-011: The appointment Ticket, the invoice and the receipt

Status: Amended 2026-09-09, over the amendment of 2026-09-08.

The 2026-09-03 amendment overruled the unification of the Ticket and the
receipt; that stands. The 2026-09-08 amendment settled the naming and gating
question the 2026-09-03 text explicitly left open, and in settling it superseded
the rule the product had been running: that a financial page is called Invoice
until something is paid and Receipt afterwards; that stands too. The 2026-09-09
amendment settles what a Receipt is about when an invoice was satisfied by more
than one tender, which the 2026-09-08 text deliberately left open. All earlier
records are retained below, marked rather than rewritten.

## The rule, as of 2026-09-09

> Payment changes an Invoice's settlement state, not its document identity. A
> paid Invoice remains an Invoice. Ticket remains an operational work document.
> Pawsh has one completed settlement per Invoice for MVP; that settlement may
> contain multiple tender components. A Receipt is evidence of that completed
> settlement.

The invariant in full:

- **One Invoice per appointment.** Unchanged, and already enforced by
  `one_active_invoice_per_appointment`.
- **One completed settlement per Invoice.** The checkout event that satisfies
  the invoice happens once.
- **A settlement may use multiple tender components.** $92.01 on a card is one
  settlement of one component. $40 of client credit and $52.01 on a card is one
  settlement of two. $20 in cash and $72.01 on a card is one settlement of two.

### Multiple payment rows are components, and are not constrained

A tender component is a row in `payments`, so a settlement composed of two
instruments is two rows. What this amendment changes is not the data but the
claim the documents make about it: those rows are components of one settlement
and are never presented to the customer as independent checkout events.

**No constraint is placed on the number of payment rows per invoice**, and this
amendment carries no migration: no uniqueness constraint on
`payments(invoice_id)`, no receipt table, no enum rebuild. The approved
invariant is representable in the schema that already exists.

The reason no constraint was added belongs in the record, because the shorter
rule is tempting and wrong. A client's credit balance is almost never exactly
the invoice total, so one payment row per invoice would either strand every
credit smaller than a groom or force credit through the discount path, which
under-collects tax. Split tender at the counter would go with it, and it has no
name in the codebase to search for - it is the emergent consequence of Check Out
reopening while a balance stands, so a constraint would have removed it
silently. One settlement is the product rule. One row is not.

### Deliberate partial payment is not an MVP workflow

Normal checkout satisfies the invoice completely. An operator cannot
intentionally collect $40 against a $100 invoice and finish checkout with $60
outstanding. An outstanding balance is an intermediate state inside one
settlement - the remainder still to be tendered - and never a terminal checkout
outcome.

The `partially_paid` enum value is retained for compatibility, for history and
for that intermediate state. It is not rebuilt out of the type, and it is not
offered as a way to end a checkout.

### The Receipt states the tender composition of one settlement

`Payment 1 of 2` and `Payment 2 of 2` are **withdrawn**. They presented one
settlement as two customer events. In their place the Receipt identifies each
tender component with its method, its amount, when it was received where that
applies, and the provider, provider payment id and external reference **only
when the row actually carries them**. The absent-processor rule from 2026-09-08
stands unchanged: nothing is fabricated to fill a gap.

**The aggregate line reads "Total settled", not "Total paid".** A settlement
that includes client credit collected less money than it settled, and an
aggregate calling that sum "paid" claims money changed hands that did not. The
Invoice still shows `Paid` as its settlement status, which is a statement about
the obligation rather than about a till.

**Refunds keep their attribution to the tender component they came from.** A
refund is against a payment, and a Receipt that flattens refunds into a single
aggregate line loses which instrument the money went back to. Where the
rendering cannot truthfully make that association, the projection is what gets
fixed; reconciliation arithmetic is not invented to cover it.

### Reaffirmed rather than changed

- **Client credit is a payment and never a discount.** `calculateInvoice` taxes
  `subtotal - discount`, so routing credit through the discount path
  under-collects tax on every redemption, permanently, on real money. The rule
  under "What else stands" below is unchanged, and is restated here because a
  rule phrased "one settlement" invites exactly that mistake. Credit consumes
  only the amount needed and any remainder stays on the client's balance; credit
  is never stranded merely because it cannot cover the whole invoice.
- **A refund leaves the invoice balance unchanged.** Deliberate, and not touched
  by this amendment.
- **The Ticket is untouched, again.** It carries no money, gains no settlement
  meaning, and is never the implementation behind Print Receipt.

### The Receipt is reachable from history, not only from the live checkout

The 2026-09-08 record scoped the two print controls to the Check Out footer,
which left the Receipt reachable only during the session that took the payment.
It is now also on the Invoice document dialog: `invoice-print-invoice` in every
state, and `invoice-print-receipt` only on a completed settlement — **absent
rather than disabled**, because an unsettled invoice has no Receipt to disable.
A settled visit reopened from a client's transaction history weeks later can
therefore reprint both documents. The history row itself still reads `Invoice`
and opens the Invoice, which is unchanged from 2026-09-08.

One property follows from this and is stated deliberately rather than left to be
discovered: **the Receipt is reconstructed from live state and is never
persisted.** Reprinting a settled visit's Receipt later can differ from the paper
printed on the day — a subsequent refund adds a line, and a void of the only
component withdraws the document. The Receipt is a claim about the settlement as
it now stands; the Invoice is the history host and prints in every state,
voided components included.

### Settlement integrity: a component composed against a moved balance

A settlement's components are recorded one at a time against a balance the
previous component moved, so the request carries `expectedBalanceMinor` and the
route holds the invoice row with `for update` while it decides. That check was
previously reachable **only when the tender exceeded the balance**, so two
operators working from the same stale figure could each record a component that
happened to fit, and neither was warned.

The staleness check is now independent of the amount: a component whose expected
balance no longer matches the locked balance is refused with 409
`STALE_FINANCIAL_STATE` whether its amount is under, equal to or over that stale
figure, and the response carries the current `balanceMinor` so the surface can
correct itself in place rather than stranding the operator on a figure that has
moved. A *fresh* over-tender is a different fault — the operator's own number is
too big, not a race — and keeps its 400 `PAYMENT_EXCEEDS_CURRENT_BALANCE`. The
losing racer is refused, never merged: there is no last-write-wins path into a
settlement.

### What the Receipt says about a component that collected no money

A client-credit component carries its own sentence — that it was settled from
the client's account balance and no money was collected — beneath its amount.
The aggregate line already refuses to call the total "paid"; this says the same
thing at the component that makes it true, so a Receipt showing credit is
truthful line by line and not merely in its total.

## The rule, as of 2026-09-08

> Payment changes an Invoice's settlement state, not its document identity. A
> paid Invoice remains an Invoice. A Receipt is separate evidence of a recorded
> payment. Ticket remains an operational work document and is never used as
> Receipt.

### What this supersedes

The client had ONE printable financial page and gave it two names. It was headed
`Invoice #1042` while nothing had been paid and `Receipt #1042` from the first
payment onward, and the Check Out footer offered exactly one print control:
Print Receipt once paid, Print Invoice until then. Two things were wrong with
that, and they are separate faults.

- **A paid Invoice was retitled.** The same document a client was handed as a
  bill came back after settlement as "Receipt", claiming to evidence a payment
  it does not describe — it describes the obligation. Nothing about the artifact
  changed; only the balance did.
- **The bill became unprintable.** Because the two controls were alternatives, a
  single payment against a $101.60 invoice removed the operator's only way to
  print that invoice — at exactly the moment a client is most likely to ask for
  it. A partially paid invoice still owes money and still has a bill.

  **Note, 2026-09-09:** the conclusion stands - the Invoice is printable in
  every state, permanently. The premise is restated: an invoice with a balance
  outstanding is mid settlement rather than deliberately part-paid, because
  finishing a checkout with money outstanding is no longer an MVP workflow.

### What replaces it

- **Two renderers, two titles.** `receiptBodyMarkup` is the Invoice's body, and
  it is titled `Invoice #N` in every settlement state by `invoiceDocumentTitle`.
  `paymentReceiptMarkup` is the Receipt, titled `Receipt #N` by
  `paymentReceiptTitle`. Neither renderer asks what has been paid in order to
  decide which document it is; the caller decides, because the caller is the
  control the operator pressed. There is no longer a function that names a
  financial page from its payments.
- **Print Invoice in every state; Print Receipt beside it.** The two Check Out
  controls are built by two independent conditions — the Invoice's asks only
  whether an invoice exists, the Receipt's asks whether anything has been paid —
  so unpaid shows `[Print Invoice]` and paid or partially paid shows
  `[Print Invoice] [Print Receipt]`. They are never alternatives.

  **Amended 2026-09-09: the independence stands; the Receipt's condition
  tightens.** Two controls built by two independent conditions, never
  alternatives, is the part that matters and it is unchanged. But a Receipt
  evidences a *completed* settlement, so the Receipt's condition is no longer
  "anything has been paid": an invoice still carrying a balance is mid
  settlement and has no Receipt yet.
- **A Receipt requires a recorded payment, and that is now enforced twice.**
  *(Amended 2026-09-09: two gates, each asked twice. `receiptHasPayment` refuses
  an invoice with no recorded component — including the zero-total invoice,
  which is created `paid` with no payment row at all — and
  `receiptBalanceOutstanding` refuses one that is still mid settlement. Both are
  asked to offer the control and asked again at the renderer, and neither is
  derivable from the other.)*
  `receiptHasPayment` decides whether the button exists, and
  `printPaymentReceipt` asks it again before drawing anything, so no route
  produces a document claiming a payment nobody made. A voided payment settled
  nothing and is not on the Receipt at all; the void is a correction and
  corrections are history, which is on the Invoice.
- **The Receipt states the payments and nothing that belongs to the bill.**
  Salon identity header, the client, then one block per recorded payment
  carrying Pawsh's own payment reference, the method, the amount, when it was
  received, and the processor's provider, payment id and reference **only when
  the row actually has them**. A cash or manually keyed card payment has no
  processor fields, and those lines are then absent rather than empty: a label
  with nothing after it still implies a card processor was involved. Beyond the
  payments it states Total paid always, Refunded only when money has gone back,
  and the balance only while something is still owed. It states no subtotal,
  discount, tax, tip or invoice total, because those are the Invoice's.

  **Amended 2026-09-09 in two places.** "One block per recorded payment,"
  numbered as a series, is withdrawn: the blocks are the tender components of
  one settlement and are presented as its composition. "Total paid always"
  becomes **Total settled**, because an aggregate including client credit that
  says "paid" claims money was collected that never was. Everything else in this
  bullet - the absent-processor rule in both directions, and the exclusion of
  subtotal, discount, tax, tip and invoice total - stands unchanged.
- **The Receipt is numbered by the invoice it evidences.** Pawsh has no receipt
  series and no column for one, so `Receipt #N` carries the invoice number.
  Inventing an identifier nothing reconciles against would be worse than sharing
  one.
- **The client's transaction history opens the Invoice.** The row's control read
  "Receipt" once anything had been paid and opened the retitled page; it reads
  "Invoice" in every status now, and the terminal capture dialog's own control
  says "View invoice" for the same reason.
- **The Ticket is untouched by all of this.** It is not the implementation
  behind Print Receipt, it gains no payment identity and no settlement meaning,
  and a paid appointment does not turn a work sheet into a financial document.
  `printPaymentReceipt` renders `paymentReceiptMarkup` and nothing else.

### Left open

**Settled 2026-09-09. The paragraph below is the 2026-09-08 text, retained.**
The question it declines to take is answered by the amendment above: a Receipt
is about the **settlement**, not about a payment, so there is nothing for an
operator to choose between. A settlement's several tenders are its components,
not a series. The numbered blocks this paragraph authorises are withdrawn, and
its premise that "Pawsh takes partial payments" is superseded by the rule that
deliberate partial payment is not an MVP workflow.

**Which payment a Receipt is about when there are several.** An invoice can
carry more than one payment — Pawsh takes partial payments — and there is one
Print Receipt control, which does not ask. The document therefore evidences a
clearly defined set: every recorded payment against that invoice, each kept as
its own numbered block with its own reference, amount, method and time. No
payment is fused into another and no row on it is a sum pretending to be a
settlement. Whether an operator should instead be able to print a receipt for
one chosen payment is a product decision and is deliberately not taken here.

### Where it is held

**Added 2026-09-09.** `tests/ui/payment-receipt.test.ts` was rewritten to
execute the client's own functions against a recording document stub rather than
grep its source: the four behaviours that had been pinned by whitespace-exact
source literals — a paymentless invoice producing no Receipt, a settled invoice
still offering Print Invoice, Print Receipt standing beside it as an independent
control, and Print Receipt never rendering the Ticket — are now each proven to
fail under a real mutation of `public/app.js`. The same file holds split tender
as one Receipt of several components, the absence of any `Payment N of M`
wording, credit counting toward Total settled without a claim that money was
collected, refund attribution inside the component it reversed, and the reprint
of both documents from transaction history.
`tests/database/checkout-regression.test.ts` holds the settlement-integrity
half: a stale expected balance refused under, equal to and over, a fresh one
accepted, and two concurrent components resolving to one recorded row and one
409. `tests/e2e/checkout-surface.spec.ts` holds the surface's refusal to read as
a finished checkout while money is still owed.

The 2026-09-08 record, unchanged:

`tests/ui/payment-receipt.test.ts` holds the renderer's truthfulness rules
against fixtures, including the absent-processor case in both directions.
`tests/e2e/invoice-receipt-identity.spec.ts` walks the settlement ladder in a
browser. `tests/database/tender-amount-and-receipt.test.ts` holds the payload
half — that the nullable processor columns come back null for a manual payment
and verbatim when they carry something.

## Three documents, and they are three

**A Ticket is not an Invoice. A Ticket is not a Receipt. An Invoice is not a
Receipt.** They are three artifacts with three different subjects, and every
error this record has had to be amended for came from collapsing two of them
into one.

- A **Ticket** is the shop's work sheet for one visit: who the pet is, who is
  working on it, what was booked, and what has been written down about it. Its
  subject is the work.
- An **Invoice** is the statement of what is owed for that visit: the line
  items, the discounts in applied order, tax, tip, the total and the balance.
  Its subject is the debt.
- A **Receipt** is the acknowledgement that money changed hands. Its subject is
  the payment.

Two rules follow from that and are the practical content of this distinction:

- **A Ticket can exist without an Invoice, and in any appointment state.** The
  work sheet for a visit that has not happened yet is the ordinary case. It is
  composed from the appointment alone, and nothing about it waits on checkout.
- **A Receipt requires a recorded payment.** An invoice with a full balance
  outstanding has produced no receipt, because nothing has been received. An
  invoice is raised by checkout; a receipt is earned by a payment.

  **Superseded 2026-09-08: the gap named here is closed, and the way it was
  first closed was itself wrong.** *(Amended 2026-09-09: closed in one half
  only. The client history button no longer says "Receipt" on every invoice
  row. The endpoint half stands open — `GET /api/invoices/:id/receipt` still
  carries that name while serving both financial documents, and is cited under
  its wrong name throughout this record. It is a naming debt, not a behavioural
  one, and it is not fixed here.)* The paragraph below is the 2026-09-03 text.
  Its description of the defect is accurate and its deferral is what the
  2026-09-08 amendment above takes up. The intermediate fix — one page renamed
  from Invoice to Receipt by its payments — is superseded: a paid Invoice
  remains an Invoice, and the Receipt is a separate document.

  **The surfaces do not enforce this yet, and that is a known gap rather than a
  contradiction of the rule.** The endpoint is named `/receipt` but returns the
  invoice's money statement whether or not a payment exists, and the client
  history panel at `public/app.js:2921` offers a "Receipt" button on every
  invoice row regardless of its status. Closing the gap is a naming and gating
  question — which surfaces may say the word *receipt*, and on what condition —
  and it is deliberately not settled in this amendment, which fixes what the
  record says rather than what the client draws.

What keeps the three from disagreeing is not that they are one document. It is
that they draw every money figure from **one shared financial authority** on the
server. The Ticket states no money at all, so it is outside that rule entirely.
The Invoice and the Receipt both state money, and neither re-derives it: both
render what `GET /api/invoices/:id/receipt` returned for that invoice, through
one renderer. Separate documents that share one authority cannot disagree; that
is what makes three documents safe, and it is what the overruled record below
mistook for an argument that there could only be one.

## The decision

A Ticket is a printable work sheet. It states nothing financial: no prices, no
subtotal, no discount, no tax, no tip, no total, no payments, no balance, no
credit. It carries the salon identity block, the appointment reference, the
date, the client, a Services table of Pet, Breed, Groomer, Service and
Duration, a Notes table of Item and Latest Note whose rows are the pet note,
the client note and the appointment note, and a Print action.

The invoice's money statement is a separate document, reached through Check Out,
and stays what it already was.

Three consequences follow directly and are the practical content of this
amendment:

- A Ticket is available for any appointment in any state, including a future
  `scheduled` one. The earlier restriction to `completed` was a consequence of
  the money section and goes with it. A work sheet for a visit that has not
  happened yet is the ordinary case, not an edge case.
- The Ticket needs no payment-permission handling and no third money state. It
  states nothing an operator could be unauthorized to read, so there is no
  withheld-money presentation to design and no split read to permission.
- The Ticket needs no receipt payload. It is composed from the appointment
  alone, plus the salon identity block.

## What the reasoning got wrong

The retained record is internally coherent. Given a Ticket that states money,
its argument is right: two documents that both state a client's money will
eventually disagree, the disagreement will be found by a customer rather than
by a test, and the way to make disagreement impossible is one money statement
with several hosts rather than several statements. That reasoning is sound and
it is not what failed.

What failed is the premise. The record asserts "There is one document" and
never establishes that the Ticket is a document that states money. Everything
after that sentence follows validly from it, which is exactly why nothing
downstream caught the error: a chain of good inferences does not test its own
first premise, and the more carefully the chain is built the more convincing
the conclusion looks. The record produced a defensible architecture for a
product that does not exist.

Two specific moves put the false premise there.

It inferred the artifact from the data. `appointmentCalendarRows` returns
service prices and `services_subtotal_minor`, so the record reasoned about what
the Ticket must do with those figures. Data being reachable from a surface is
not evidence that the surface states it. The uninvoiced-Ticket paragraph is the
tell: it works hard to decide what the money section should say when there is
no invoice, a question that arises only once a money section has been assumed.

And it took the word for the thing. In much salon and POS software a "ticket"
is the open sale, so the record read Pawsh's Ticket as a bill. A name shared
with other products is not evidence about this one.

The check that would have caught it was cheap and was skipped: describe what
the artifact contains, in the terms a user would use, and confirm that
description against the design before reasoning about its architecture. The
reference designs that settle this existed and were not consulted. Where a
record is about a printable document, the contents of that document are a fact
to be verified, not a thing to be derived.

## The surviving invariant

Single Money Statement narrows; it does not lapse. It loses a host it never
actually had, and nothing else.

Every money value the product shows about an invoice is a value that
`GET /api/invoices/:id/receipt` returned for that invoice, rendered by one call
to `receiptBodyMarkup`, and no surface re-derives, re-sums, re-orders or
re-formats an invoice figure.

What has hosts is **the invoice's money statement**, not "the receipt" — the
distinction matters, because the receipt is one of the documents that hosts the
statement rather than the thing being hosted. The statement has three hosts: the
settled Check Out panel, the receipt modal, and the print root.

**Amended 2026-09-08.** The count is unchanged and so are the three hosts; what
changed is which artifacts they are. All three are the INVOICE's: the settled
Check Out panel, the dialog that `showInvoiceDocument` opens, and the print root
that Print Invoice appends. The Receipt is **not** a fourth host and never
became one — it states no subtotal, discount, tax, tip or invoice total, so
there is no invoice figure on it to drift. The sentence above that calls the
receipt "one of the documents that hosts the statement" describes the
single-page arrangement that no longer exists.

Those three must
agree character for character for every money test id on them — subtotal, each
discount step and the discount total, tax, tip, total, balance, refunded, and
every payment row — and the browser assertion stays a comparison between hosts
rather than a golden file, so it fails when they drift and not when the design
changes.

The invariant is about **invoice** figures, and that boundary has to be stated
because the browser derives money elsewhere and always has. `checkoutEstimate`
is not the only client-side money derivation; the earlier claim that it was is
false. At least two others exist today and are legitimate:

- `appointmentPresentation` at `public/app.js:512` sets `totalPriceMinor` by
  summing the appointment's own `appointment_services` price snapshots, and it
  is rendered in the calendar hover and the detail header.
- The month cell at `public/app.js:608` sums those same snapshots across a day
  into a `revenue` figure.

Neither violates this invariant, because neither states an invoice figure. They
state the value of the booked work, which is a fact about the appointment and
exists before any invoice does — the same fact the Ticket deliberately declines
to print, precisely so that a work sheet is never mistaken for a bill.
`checkoutEstimate` is the third, and it is the one that comes closest to the
line: it mirrors `calculateInvoice` and so predicts an invoice figure, which is
why it is confined to the pre-invoice build mode where there is nothing yet to
disagree with. The rule is therefore not "one client-side money derivation" but
**no client-side derivation of a figure an invoice already carries**.

The database half is unchanged. `tests/database/single-money-statement.test.ts`
asserts, over every invoice built through the real routes, that
`sum(invoice_discounts.applied_minor)` equals `invoices.discount_minor`, that
the sum of payments still `recorded` equals `total_minor - balance_minor`, and
that every `client_credit` payment has exactly one `customer_credit_entries`
row of kind `redemption` whose `amount_minor` is that payment's amount negated,
with exactly one `redemption_reversal` after a void. The partial unique index
in 0050 makes that last one at most one; the test is what makes it exactly one.

The Ticket dropping out of the invariant is not licence for the three receipt
hosts to drift. It was removed because it states no money, which is the only
reason a surface is ever outside this rule.

## What else stands

- Money authority stays on the server in `GET /api/invoices/:id/receipt`.
  There is no `GET /api/appointments/:id/ticket`, no ticket table, no stored,
  PDF-rendered or emailed ticket, and no new module under `src/documents/`.
  The Ticket is composed in the browser from reads the surface stack already
  performs, and it now needs only the appointment one.
- Client credit is a payment and never a discount, because `calculateInvoice`
  taxes `subtotal - discount` and routing credit through the discount path
  would under-collect tax on every redemption, permanently, on real money.
  `client_credit` appears in `receipt.payments`, reduces the balance, and never
  appears among `receipt.discounts`. `PAYMENT_METHOD_LABELS` mirrors
  `paymentMethodLabels` so a customer-facing document never prints
  "client credit" raw. The credit balance and the ledger are facts about the
  client's account rather than about this visit, and `creditRemainingMinor` on
  the payment response is what the checkout screen says after spending it.
  None of this reaches the Ticket, now for the simple reason that no money
  does.
- The receipt payload's salon identity block stands, `locations.address`
  included: the three preconditions the stale comment named — `address` in
  `businessSettingsSchema`, a route that writes it, a form input — are all met,
  so the address joins the header and the comment is corrected rather than left
  to mislead. It serves the printed header of both financial documents — the
  Invoice and, since 2026-09-08, the Receipt — through one `salonIdentityMarkup`
  call each, differing only in test id. The Ticket takes its identity block from
  `state.me.business`, which `GET /api/me` already returns whole with the active
  location's address.
- The Ticket is read-only, and it is read-only by choice rather than by
  necessity. The reason first recorded here has since expired: the record said
  an editor on the Ticket would be a textarea whose save the server answers with
  404, because `PATCH /api/appointments/:id/operations` accepts `checked_in` and
  `in_service` only. That endpoint still does, but it is no longer the only way
  to write the note. `PATCH /api/appointments/:id`, gated on `appointments.edit`,
  now writes `appointments.notes` **in every status, including after the money**,
  and its own doc comment states the case: a completed, invoiced, paid visit
  whose note is misspelled must be correctable without cancelling and rebooking.
  So the product question this record left open — whether a groomer may correct
  a note after the pet has gone home, and whether they may once the customer has
  been charged — **is answered, and the answer is yes.** The write touches
  nothing financial: it sets `notes` and the three bookkeeping columns, reads no
  invoice, payment or credit entry, re-snapshots nothing and recalculates
  nothing. The Ticket stays a read-only print artifact because printing is what
  it is for, not because the server would refuse the save.
- The customer-facing artifact this product sends is the appointment report
  card, which carries the pet's photos and the groomer's note to the owner. The
  Ticket is the shop's own copy of the work and does not duplicate it.

## The overruled record, retained

Everything below is the original text as accepted, unedited. It is kept because
the error in it is not visible in a summary of it: the argument reads as strong
because it is strong, and only its premise is false.

A grooming ticket is the working record of one visit. It opens when the pet
arrives and it accumulates while the pet is in the shop: who the pet is and how
it must be handled, who is working on it, what was booked, when it came in and
when it left, and what the groomer wrote down. Pawsh already holds every one of
those on the appointment. `appointmentCalendarRows` returns the pet's safety
alerts, behaviour notes, medical notes, grooming preferences and coat notes, the
rabies status for the appointment date, the assigned groomers, the immutable
`appointment_services` snapshots with their durations and prices,
`operational_notes`, the stored check-in and check-out stamps, and
`services_subtotal_minor`. A receipt holds none of it. The receipt is the
closing statement of one bill: an invoice number, the line items, the discount
steps in applied order, tax, tip, total, balance, the payment records, and
whatever refunds have gone back. It cannot exist before checkout, because
`invoices` is written by checkout. The ticket exists from arrival and survives a
visit that is completed and never invoiced.

There is one document. The Ticket is the visit, and the receipt is the Ticket's
money section rather than a document beside it. A completed visit that has been
invoiced has exactly one money statement, and every surface that shows money
shows that statement: the settled Check Out panel, the receipt modal, the Ticket
and the print output are four hosts for one body, not four documents. The two
presentations differ only in which sections are drawn, the full Ticket for the
shop and the money section alone for a customer who wants a bill, and never in
what any figure says.

Money authority stays on the server in `GET /api/invoices/:id/receipt`, which is
already the only projection that composes `invoices`, `invoice_items`,
`invoice_discounts`, `payments` and `payment_refunds` into one presented answer.
There is no `GET /api/appointments/:id/ticket`. The moment a second endpoint
selects from `invoices` the second document exists, whatever any client does
with it. Visit authority stays in `GET /api/appointments/:id`. The Ticket is
composed in the browser from those two reads, which the surface stack has
already performed: level 1 holds the appointment and level 2 holds `co.receipt`.
The two reads are separately permissioned, so an operator who may run a checkout
but may not read payment history is refused the money half by the endpoint
rather than by a client that declines to draw it, which is the split
`/api/dashboard` already makes for the same reason.

No module is added under `src/documents/`. That directory is the residue of the
pet-document storage domain; it held `scan-worker.ts` until the rabies
simplification emptied it, and putting a printable-document renderer there would
collide with the one domain in this repository that already owns the word
document. Nothing here needs a new server module at all. `invoice-settlement.ts`
and `client-credit.ts` exist because two writers could otherwise disagree about
a number; the Ticket has one reader and no writer.

`receiptBodyMarkup` is the client's single money renderer and it stays that. It
already carries the one-body-two-hosts rule; the Ticket is the third host and
the print root is the fourth. The ticket markup function is therefore given the
appointment and the receipt payload and is deliberately not given the invoice:
it renders the visit sections itself and delegates the whole money region to
`receiptBodyMarkup(receipt)` verbatim. A ticket that reads `invoice.totalMinor`
is the defect this decision exists to prevent, and refusing the invoice as a
parameter is what makes that hard to write by accident rather than merely
discouraged. The one client-side money derivation that survives is
`checkoutEstimate`, and it survives only because it runs where there is nothing
to disagree with: it is confined to the pre-invoice build mode and its output
never reaches the Ticket.

Client credit reaches the Ticket as a payment row and as nothing else. Migration
0050 settles this: credit is a payment and not a discount, because
`calculateInvoice` taxes `subtotal - discount` and routing credit through the
discount path would under-collect tax on every redemption, permanently, on real
money. So `client_credit` appears in `receipt.payments` beside cash and card, it
reduces the balance, and it never appears among `receipt.discounts`. The one
client change it needs is a name. `receiptBodyMarkup` renders
`payment.method.replace("_"," ")`, which would print "client credit" on a
document a customer reads, so the browser gains a `PAYMENT_METHOD_LABELS` mirror
of `paymentMethodLabels`, in the same shape and for the same stated reason
`INVOICE_STATUS_LABELS` is already a mirror of `invoiceStatusLabels`. The credit
balance and the ledger are not on the Ticket. They are facts about the client's
account rather than about this visit's bill, and `creditRemainingMinor` on the
payment response is what the checkout screen says after spending it.

A completed appointment with no invoice gets a Ticket with no money section. It
shows the salon header, the client and pet, the groomers, the lifecycle stamps,
the service snapshots at their snapshot prices, and the service note, and it
says "Not invoiced" where the totals would be, which is the sentence the
appointment billing chip already uses because unbilled and unpaid are different
facts about a visit. It states no total, no tax and no balance, because those
are the server's and do not exist yet; the sum of the service snapshots is a
line of work and the Ticket must not present it as a bill. The service note is
read-only there for the same reason it is read-only on Check Out:
`PATCH /api/appointments/:id/operations` accepts `checked_in` and `in_service`
only, and the Ticket is reached at `completed`. Widening that endpoint is a real
product question, whether a groomer may still correct a note after the pet has
gone home and whether they may still do so once the customer has been charged
for it, and it is deliberately not answered here. Until it is, an editor on the
Ticket would be a textarea whose save the server answers with 404.

The receipt payload needs one widening and one correction, and both are about
the salon's own identity at the top of a printed document. The endpoint already
selects the business name, phone and email for a header no client draws yet, and
the Ticket draws it. The comment beside that query excluding `locations.address`
on the grounds that nothing in the product writes it is now stale: the Business
settings workspace added `address` to `businessSettingsSchema`, its route writes
`locations.address`, and the form carries the input, so all three preconditions
that comment named are met. The address joins the header and the comment is
corrected rather than left to mislead the next reader. The uninvoiced Ticket
takes the same four fields from `state.me.business`, which `GET /api/me` already
returns whole together with the active location's address. Both readings are the
same `businesses` row, so they cannot disagree today; one client helper resolves
them so that a later change cannot make them.

The invariant is Single Money Statement: every money value the product shows
about an invoice is a value that `GET /api/invoices/:id/receipt` returned for
that invoice, rendered by one call to `receiptBodyMarkup`, and no surface
re-derives, re-sums, re-orders or re-formats an invoice figure. The browser
assertion is that one invoice rendered into the settled Check Out panel, the
receipt modal, the Ticket and the print root yields identical text for every
money test id on it, covering subtotal, each discount step and the discount
total, tax, tip, total, balance, refunded, and every payment row. It is a
comparison between hosts rather than a golden file, so it fails when the four
drift and not when the design changes. The database assertion is the other half
and belongs beside the existing settlement tests: for every invoice,
`sum(invoice_discounts.applied_minor)` equals `invoices.discount_minor`, the sum
of payments still `recorded` equals `total_minor - balance_minor`, and every
`client_credit` payment has exactly one `customer_credit_entries` row of kind
`redemption` whose `amount_minor` is that payment's amount negated. The partial
unique index in 0050 already makes that last one at most one; the test asserts
that it is exactly one and that the sign is right, which is what stops a Ticket
showing a credit payment the client's ledger never recorded.

Deferred and not built here: a ticket endpoint, a ticket table, a stored or
PDF-rendered ticket, an emailed ticket, and any editing of the service note from
the Ticket. The customer-facing artifact this product already sends is the
appointment report card, which carries the pet's photos and the groomer's note
to the owner; the Ticket is the shop's copy of the visit and does not duplicate
it. A Ticket is offered only for a completed appointment, because before
completion the working record is the Check Out and detail surfaces themselves.
