# Checkout specification

Only a completed appointment can enter checkout. Pawsh creates at most one active
invoice for the appointment and copies appointment service snapshots into invoice
items. Retrying checkout returns the existing invoice.

All authoritative money uses integer minor units and is calculated server-side:

`total = subtotal - discount + tax + tip`

Tax uses the business-configured basis-point rate and integer rounding. A discount
requires the discount permission and records its type and actor. A positive manual
payment cannot exceed the remaining balance.

Manual payments record money collected outside Pawsh as cash, external card,
check, or other. An incorrect record is corrected with an audited void/reversal;
Pawsh does not label that action a refund. Invoice state follows its balance:
`open`, `partially_paid`, or `paid`. One settlement satisfies an invoice and may
use several tender components, so `partially_paid` is the intermediate state
while the remaining components are still being taken. It is retained for
compatibility and history and is not offered as a way to end a checkout. Operational appointment state remains
independent from invoice and payment state.
