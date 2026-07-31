# D4 — Checkout, Stale State, and Error Paths

## Classification

**Critical Regression D4 — Checkout/Stale-State/Error Paths Valid**.

The final report records the exact documentation SHA and CI run because a
commit cannot contain its own hash.

## Capability matrix

| Capability | Implemented | UI | Pilot | Permission | Audit | Outbox | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Invoice creation and snapshots | Yes | Yes | Yes | `checkout.perform` | `invoice.create` | `InvoiceCreated` | Validated |
| Discount / type / configured tax / tip | Yes | Yes | Yes | `checkout.perform`; `discounts.apply` for discount | Invoice audit | Invoice event | Validated |
| Manual and partial payment | Yes | Yes | Yes | `checkout.perform` | `payment.record` | `PaymentRecorded` | Validated |
| Manual payment void | Yes | Yes | Yes | `checkout.perform` | `payment.void` | N/A | Validated |
| Receipt retrieval | Yes | Yes | Yes | `payments.view` | N/A | N/A | Validated |
| Refund, correction, write-off | No | No | No | N/A | N/A | N/A | Deferred |
| Invoice void/reissue/provider mutation | No | No | No | N/A | N/A | N/A | Deferred |

## Financial contract

Checkout requires a completed appointment and at least one immutable appointment
service snapshot. Invoice line positions are explicit. Discount precedes tax;
tax is `round(taxable subtotal × basis points / 10,000)`; tip follows tax. All
money is integer minor units. A zero-total invoice is immediately `paid`.

At most one non-void invoice exists per appointment. Invoice void is schema-only
and has no MVP mutation. The resolved invoice-intent fingerprint covers service
snapshot identity/value, customer/appointment, discount and type, applied tax
rate/result, tip, total, and calculation version 1. A compatible different-key
request ensures the invoice exists; incompatible intent returns 409
`INVOICE_ALREADY_EXISTS` without changing it.

Manual payments may be partial and `externalReference` is descriptive metadata.
Invoice-row locking permits independent payments that fit the remaining balance
and rejects a race-induced excess with 409 `STALE_FINANCIAL_STATE`. A fresh
excess returns 400 `PAYMENT_EXCEEDS_CURRENT_BALANCE`. Voiding preserves the
original record, changes effective paid amount once, and emits no outbox event.

## Idempotency and failures

`ARCH-007` is resolved for `checkout.create-invoice`, `payment.record`, and
`payment.void`. Each requires a UUID header and uses unique
`business + operation + key`. The client hash is operation-specific; initiating
actor is retained but excluded from uniqueness. Another currently authorized
tenant actor may replay the sanitized result without changing attribution.

The request claim, mutation, audit, applicable outbox/analytics, and completed
result reference commit in one transaction. Failure before commit removes every
effect and claim. Failure after commit is recovered with the same key and does
not repeat the financial effect. Completed records retain for 30 days. There is
no separately committed abandoned `in_progress` state in this internal-only
model. Replays reauthenticate and require current operation permission.

The browser distinguishes invoice creation from payment and receipt reads. An
invoice may remain valid and unpaid; a payment rejection does not undo it; and
a receipt failure after payment reports payment success and retries only the
read. UI request keys remain available after uncertain transport failure.

## Integrity, ordering, and history

Database checks enforce component totals and balance bounds. Composite foreign
keys enforce payment/invoice tenant ownership; the partial invoice index enforces
one non-void invoice. Transactions enforce effective-paid aggregation and
single void. `DB-003` was reviewed and not confirmed as an unresolved finding.

Receipt items order by `line_position ASC, id ASC`; payments order by
`recorded_at ASC, id ASC`. Voided payments remain visible. Audit/outbox counts
are scoped by business, resource, and action/event. Worker failure after commit
does not undo financial state.

## Browser and validation

`@regression-checkout` maps exactly four focused Chromium scenarios with retries
zero: primary totals/payment/void; incompatible invoice and pending UI;
two-context stale payment; and committed payment with receipt-read recovery.
Lower layers own replay matrices, true concurrent payments/voids, rollback,
response loss, authorization, tenant isolation, zero/no-service edges, and
deterministic ordering.

Candidate diagnostic evidence is emitted as `D4_FINANCIAL_DIAGNOSTICS` from CI
PostgreSQL/API injection, separately timing invoice, replay, payment, receipt,
and void operations. It is diagnostic rather than a hard performance gate.

## Findings and closure

- `ARCH-007`: resolved in D4.
- `ARCH-001`: remains Must Fix Before Controlled Pilot; D4 does not implement
  booking/rescheduling replay keys.
- No `DB-003`, `UX-004`, `LAT-004`, `SEC-004`, or `ARCH-008` remains confirmed.
- Baseline: `2be8d0239b3d88ea083babaca7e682b904347b0a`.
- Implementation candidate: `5ed86232ebaea396c10e456187969d3020e48af9`.
- Exact final SHA/run and job results: final Codex report.

## Limitations

Refunds, invoice correction/void mutation, write-offs, receipt reissue mutation,
and external processor mutations are absent. Accessibility, calendar/time edges,
`ARCH-001`, `SEC-DOC-001`, pilot-envelope approval, performance smoke, staging,
manual UX, and physical-device QA remain separate gates.
