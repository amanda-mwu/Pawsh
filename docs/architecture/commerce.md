# Commerce

Checkout is available for completed appointments with at least one service. It
creates at most one non-void invoice whose explicitly positioned items copy
appointment-service snapshots. The server applies discount before configured
tax, rounds tax to the nearest minor unit, then adds tip. A zero-total invoice
is immediately paid without a synthetic payment.

Manual payments represent money collected outside Pawsh. One settlement
satisfies an invoice and may be tendered in several components, so an invoice
may carry several payment rows; invoice-row serialization prevents their
aggregate from exceeding the balance, and a component composed against a balance
that has since moved is refused rather than merged. `externalReference` is descriptive metadata, not a
processor transaction identity. Voiding changes the internal payment record,
preserves its history, and does not claim an external refund.

Invoice creation, payment recording, and payment voiding each require a UUID
`Idempotency-Key`. The tenant, operation, key claim, mutation, audit, applicable
outbox event, and sanitized result commit atomically in PostgreSQL. Completed
replay requires current authorization. Identities expire after 30 days;
booking/rescheduling replay protection remains the separate open `ARCH-001`.

Committed invoice intent is immutable. A different request key with the same
resolved snapshot/tax/discount/tip intent returns the invoice; incompatible
intent returns `INVOICE_ALREADY_EXISTS`. Invoice correction, invoice void mutation, write-off, receipt reissue mutation,
and payment-processor mutation are absent from the MVP.

Refunds are partial, and the boundary is the processor. A payment taken through
the Square Terminal can be refunded against the payment it came from, in whole or
in part. **A payment with no processor behind it - cash, cheque, a manually keyed
external card, or client credit - cannot be refunded**: the refund path is a
provider refund and refuses `payment_not_refundable` without one. This is a
deliberate MVP limitation and a post-pilot item, not an oversight, and it is
consistent with the MVP commitment, which is manual payment recording and
*reversal* rather than refund.

**A void is not a substitute for a refund.** A void asserts that the record was
wrong and that Pawsh never held the money: it returns the amount to the invoice
balance, so the invoice reads as owing again and appears in outstanding figures,
and it withdraws the Receipt because no settlement completed. A refund asserts
the opposite - that the record was right and the money went back - and
deliberately leaves the balance alone. Using a void to represent money handed
back at the counter therefore records a debt the customer does not owe, and the
product must not instruct it. The one place money genuinely moves on a void is
client credit, where the redemption is reversed onto the customer's balance;
that is a compensating ledger entry for a record being unmade, not a refund of a
settlement that stood.
