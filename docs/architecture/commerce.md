# Commerce

Checkout is available for completed appointments with at least one service. It
creates at most one non-void invoice whose explicitly positioned items copy
appointment-service snapshots. The server applies discount before configured
tax, rounds tax to the nearest minor unit, then adds tip. A zero-total invoice
is immediately paid without a synthetic payment.

Manual payments represent money collected outside Pawsh. Multiple partial
payments are allowed, but invoice-row serialization prevents their aggregate
from exceeding the balance. `externalReference` is descriptive metadata, not a
processor transaction identity. Voiding changes the internal payment record,
preserves its history, and does not claim an external refund.

Invoice creation, payment recording, and payment voiding each require a UUID
`Idempotency-Key`. The tenant, operation, key claim, mutation, audit, applicable
outbox event, and sanitized result commit atomically in PostgreSQL. Completed
replay requires current authorization. Identities expire after 30 days;
booking/rescheduling replay protection remains the separate open `ARCH-001`.

Committed invoice intent is immutable. A different request key with the same
resolved snapshot/tax/discount/tip intent returns the invoice; incompatible
intent returns `INVOICE_ALREADY_EXISTS`. Refunds, invoice correction, invoice
void mutation, write-off, receipt reissue mutation, and payment-processor
mutation are absent from the MVP.
