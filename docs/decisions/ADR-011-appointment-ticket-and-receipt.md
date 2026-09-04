# ADR-011: The appointment Ticket and the receipt

Status: Amended 2026-09-03. The unification of the Ticket and the receipt
recorded here is overruled by Product; it describes a product Pawsh does not
have. The client-credit decisions, the receipt's server authority, and a
narrowed Single Money Statement invariant stand. The overruled record is
retained below in full, unedited, because the way it went wrong is worth
reading.

## The decision

A Ticket is a printable work sheet. It states nothing financial: no prices, no
subtotal, no discount, no tax, no tip, no total, no payments, no balance, no
credit. It carries the salon identity block, the appointment reference, the
date, the client, a Services table of Pet, Breed, Groomer, Service and
Duration, a Notes table of Item and Latest Note whose rows are the pet note,
the client note and the appointment note, and a Print action.

The receipt is a separate document, reached through Check Out, and stays what
it already was.

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
re-formats an invoice figure. The receipt has three hosts, not four: the
settled Check Out panel, the receipt modal, and the print root. Those three
must agree character for character for every money test id on them — subtotal,
each discount step and the discount total, tax, tip, total, balance, refunded,
and every payment row — and the browser assertion stays a comparison between
hosts rather than a golden file, so it fails when they drift and not when the
design changes. `checkoutEstimate` remains the only client-side money
derivation, and it survives only because it is confined to the pre-invoice
build mode, where there is nothing yet to disagree with.

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
  to mislead. It serves the receipt's own printed header. The Ticket takes its
  identity block from `state.me.business`, which `GET /api/me` already returns
  whole with the active location's address.
- The Ticket is read-only. `PATCH /api/appointments/:id/operations` accepts
  `checked_in` and `in_service` only, so an editor on the Ticket would be a
  textarea whose save the server answers with 404. Whether a groomer may
  correct a note after the pet has gone home, and whether they may once the
  customer has been charged for it, is a real product question and is still not
  answered here.
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
