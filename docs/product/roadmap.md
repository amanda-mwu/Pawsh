# Pawsh product roadmap

## MVP attachment security supersession

ADR-010 supersedes earlier roadmap language that treated ADR-005's managed
malware scanning, quarantine, retries, or scanner operations as MVP or
controlled-pilot **runtime requirements**. That runtime design is superseded and
is not to be rebuilt. MVP uses the Rabies Attachment Minimum Safety controls. The
older sections below are retained as historical planning context and must be read
through ADR-010.

**This supersedes an implementation, not a finding.** `SEC-DOC-001` is **open**
and remains a controlled-pilot blocker. A superseded implementation design is not
a closed security finding: the residual risk the finding names survived the
architectural replacement that removed its original control, so the finding is
open against the control that replaced it. **ADR-010 is not closure evidence for
it.** `SEC-DOC-001` closes only on staging evidence for the current attachment
control, as the applicable release-governance process requires, plus an explicit
recorded closure by Security and the launch approver. The authoritative entry is
in [Scale readiness](../architecture/scale-readiness.md).

## Authority and lifecycle

This is Pawsh's single authoritative customer-value roadmap. It governs product
scope, sequencing, dependencies, approval status, and initiative-specific risk.
It does not supersede accepted ADRs, validation evidence, security findings, or
release gates. `SEC-DOC-001`, `SEC-DB-001`, the Master Release Gate, and other
validated findings keep the authority recorded for each in
[Scale readiness](../architecture/scale-readiness.md), which is where their
current status is settled rather than here. For `SEC-DOC-001` specifically, that
authority currently requires: the finding is **open**, it blocks the controlled
pilot, ADR-010's supersession of ADR-005's runtime design did not close it and is
not closure evidence for it, and it closes only on staging evidence for the
current attachment control plus an explicit recorded closure. General platform
risks stay in the same document.

Pawsh has completed the working-product stage and is currently in
controlled-pilot hardening. Customer-value prioritization governs future feature
selection, but it does not remove or defer existing pre-pilot security, recovery,
accessibility, integrity, staging, or operational gates.

New customer-facing capabilities may enter the controlled-pilot release
candidate only through explicit scope-change approval supported by customer or
pilot evidence. Otherwise, they remain post-pilot. No such evidence or approval
is recorded for the conditional candidates below.

> Deliver the smallest usable product first. Apply the security, integrity, and
> recovery controls required for the environment before exposing it to
> customers. Add broader product capabilities after the controlled pilot.

## Planning vocabulary

Release phase (MVP, Controlled Pilot, Post-Pilot, Growth, or Enterprise) and
business priority (P0, P1, P2, P3, or Deferred) are independent. Business
priorities do not rename Pawsh's P1-P8 validation phases. Repository inspection
establishes implementation facts, not customer demand or Product, Security, or
Privacy decisions. A recommendation is unapproved unless explicitly stated.

## Current MVP

The MVP supports a single-location grooming business through authentication and
sessions; tenant businesses; memberships, permissions, and employees; services
and availability; customers and pets; conflict-safe scheduling and calendar use;
check-in, service execution, and completion; invoicing; manual or offline payment
recording and reversal; receipts; transactional appointment reminders; dashboard
and bounded basic reporting; audit history; the specialized rabies-PDF workflow;
health checks and migrations; backup and recovery documentation; and a responsive
web client.

- **Payments** means recording supported manual or offline payment methods, not
  live online payment processing.
- **Customer reminders** means transactional appointment reminders, not
  marketing automation.
- **Document upload** means the rabies-PDF workflow, not generic attachments.
- **Manual discount** means the permission-gated amount an operator keys in at
  checkout. It is no longer the only discount Pawsh has: a configured discount
  catalogue and a coupon domain shipped in migration 0048, and a manual amount is
  now one of three sources that can produce an invoice discount line.

Repository evidence confirms server-owned invoice calculations, a discount cap
at subtotal, rabies-only document typing, tenant-timezone-aware bounded reports,
durable notification intents and delivery attempts, and an appointment-completed
outbox event. It also confirms the absence of a general document manager, a
configurable recipient router, a week-start preference, and feedback automation.

**A coupon domain now exists.** An earlier version of this section recorded its
absence; migration 0048 built it and it is described under
[Coupons and configured discounts](#coupons-and-configured-discounts) below.
Customer-facing discount metadata is no longer absent either: `invoice_discounts`
snapshots a name per line.

## Security by lifecycle

1. **Foundational security -- MVP:** tenant isolation, authentication,
   authorization, permissions, financial integrity, auditability, migration and
   backup correctness, and secure password handling.
2. **Deployment and operational security -- before controlled pilot:** restore
   validation, Rabies Attachment Minimum Safety, accessibility gates, monitoring,
   recovery, and operational readiness required by the approved MVP scope.
3. **Scale and compliance hardening -- GA/Growth:** controls for broader scale,
   data classes, compliance, and retention automation.
4. **Enterprise governance and assurance -- Enterprise:** formal assurance,
   enterprise administration, policy controls, and integrations.

Foundational and deployment security never move to Enterprise by implication.

## Document safety boundary

```text
MVP business capability
└── Rabies PDF upload and authorized clean download

MVP minimum safety
├── Tenant isolation and permission enforcement
├── PDF-only, size, and multipart limits
├── Safe filenames and randomized immutable object identity
└── Authorized download

Controlled-pilot security requirement (MVP) -- SEC-DOC-001, open
├── Staging evidence for the CURRENT attachment control
└── An explicit recorded closure by Security and the launch approver

  Superseded by ADR-010 and NOT required (historical, do not rebuild)
  ├── Fail-closed quarantine and application scanning contract
  ├── Managed-scanner integration
  ├── Timeout and outage handling
  ├── Queue monitoring
  └── Scanner operational evidence

Post-pilot or GA hardening
├── Rescanning after signature updates
├── More advanced document analysis
├── Expanded retention automation
└── Additional file types
```

Current PDF header, MIME, size, and trailer checks are shallow and are not
malware detection. External persistent uploads create a pre-pilot security
obligation. Existing document-malware ADR and validation evidence remain
authoritative. `SEC-DOC-001` is **open** and remains a controlled-pilot blocker.
Rebuilding ADR-005's superseded managed scanner is **not** what closes it; it
closes on staging evidence for the current attachment control, as release
governance requires, plus an explicit recorded closure. General document
management is a separate post-pilot domain.

## Roadmap summary

| Capability | Release phase | Priority | Approval | Customer/pilot evidence | Pilot treatment |
|---|---|---:|---|---|---|
| Manual invoice discount | MVP | P1 | Existing capability | Repository behavior only | Permission-gated workaround |
| Rabies PDF upload | MVP | P1 | Existing capability | Repository behavior only | Specialized workflow |
| Attachment malware risk (`SEC-DOC-001`) | Controlled Pilot | P0/P1 | Open finding; ADR-005's scanner design is superseded and not required | Staging evidence for the current attachment control, plus an explicit recorded closure | Must remain blocking |
| Receipt discount label | Controlled-pilot candidate or Post-Pilot | P2 | Not approved; Product approval required | No confirmed pilot blocker in repository evidence | Explicit scope approval required |
| Reporting week start | Controlled-pilot candidate or Post-Pilot | P2 | Not approved; Product approval required | No confirmed pilot blocker in repository evidence | Evidence and scope approval required |
| Client credit | Controlled-pilot candidate or Post-Pilot | P2 | Implemented; Product scope confirmation required for pilot entry | No confirmed pilot blocker in repository evidence | Explicit scope approval required |
| Coupons and configured discounts | Shipped | P1 | Existing capability | Repository behavior only | Shipped; pilot scope confirmation required for owner-facing enablement |
| Coupons at booking time | Post-Pilot | P2 | Not approved; Product approval required | No confirmed pilot blocker in repository evidence | Coupon is entered at checkout |
| General documents | Post-Pilot | P2 | Not approved; Product and Security approval required | No confirmed pilot blocker in repository evidence | Rabies workflow remains |
| Notification routing | Post-Pilot | P2 | Not approved; Product approval required | No confirmed pilot blocker in repository evidence | Narrow approved exception only |
| Feedback automation | Post-Pilot | P3 | Not approved; Product and Privacy/Legal approval required | No confirmed pilot blocker in repository evidence | Manual communication |
| OCR and marketing automation | Growth | P3 | Not approved | No confirmed pilot blocker in repository evidence | Deferred |
| Advanced organizational governance | Enterprise | Deferred | Not approved | Not established | Separately approved |

Conditional candidates do not enter the release candidate or become current
release blockers without explicit scope-change approval.

## Dependencies

```text
Coupons and configured discounts ── shipped. It did NOT wait on receipt discount
                 metadata: `invoice_discounts` carries its own immutable
                 per-line name snapshot, which is the part the receipt needed.

Coupons at booking time ── depends on the shipped coupon domain

Notification event registry
        ↓
Notification routing
        ↓
Feedback automation

Document-domain ADR
        ↓
Independently scoped document capabilities

Reporting week-start preference ── independent

Client credit ── independent of the coupon domain. Credit settles an invoice as
                 a payment; a discount changes what is owed. They land on
                 opposite sides of the tax line and share no authority.

Attachment malware risk (SEC-DOC-001) ── open controlled-pilot security gate,
                 not a post-pilot document dependency. ADR-005's scanner design
                 is superseded and is not the thing that closes it.
```

## Customer workflow initiatives

### Manual invoice discount

- **Foundation/gap:** none remaining for the manual amount itself. Checkout
  permission-gates application and calculates totals on the server.
- **Disposition:** MVP, P1, Existing capability.
- **Scope/non-goals:** money stays server-authoritative and never
  browser-authoritative. Coupons and stacking are no longer non-goals — both
  shipped in 0048, and a manual amount is now one discount line among several,
  counted against the stacking rule like any other. Campaigns remain a non-goal.
- **Controls:** tenant authorization, integer money, audit, replay protection,
  and invoice history remain authoritative. No Master Release Gate change.

### Receipt discount label

- **Foundation/gap:** invoices store `discount_minor` and free-form
  `discount_type`; receipts show a generic Discount line, not an immutable
  customer-facing name or code.
- **Disposition:** Controlled-pilot candidate or Post-Pilot, P2, Not approved.
  No repository evidence confirms a pilot blocker. Product and launch-approver
  scope approval are required for pilot entry.
- **Candidate scope:** one bounded, escaped, immutable label per invoice,
  historical fallback, and consistency across representations that exist. The
  discount amount remains authoritative.
- **Non-goals/decisions:** campaigns. Coupons, multiple discounts and stacking
  are no longer non-goals here — 0048 shipped all three, and `invoice_discounts`
  already snapshots a per-line name, which is much of what this initiative was
  for. What remains is the label on a *manual* discount line, which has no
  configured row to take a name from. Product must decide the default label,
  staff entry, history, and code display.
- **Planning:** negligible growth; snapshot immutability, output escaping,
  channel-consistency tests, accessible mobile rendering.
- **Proposed release evidence:** `Receipt Discount Metadata Valid --
  CI/PostgreSQL/Browser`. No current gate change.

### Reporting week-start preference

- **Foundation/gap:** reports use bounded half-open business-timezone ranges but
  have no Sunday/Monday preference or complete weekly-view inventory.
- **Disposition:** Controlled-pilot candidate or Post-Pilot, P2, Not approved.
  Product approval and customer/pilot evidence are required.
- **Candidate scope:** Sunday/Monday, preserved existing behavior, shared period
  helper, explicit range labels, and dashboard/report/export inventory.
- **Non-goals/decisions:** no fiscal, payroll, arbitrary periods, or advanced
  analytics. Current and new defaults, locale, and affected views are pending;
  Monday is not approved by inference.
- **Planning:** calculate UTC bounds once; retain indexed range predicates and
  bounded queries; avoid repeated setting reads. Test DST, month/year boundaries,
  tenant isolation, consistent labels, keyboard use, and responsive display.
- **Proposed release evidence:** `Reporting Period Preference Valid --
  CI/PostgreSQL/Browser`. No current gate change.

### Client credit

- **Foundation/gap:** migration 0050 adds `customer_credit_entries`, a signed
  single-column ledger whose sum is the balance, with immutable rows, a grant
  and adjust route behind `customers.credit_edit`, and redemption at checkout
  behind `checkout.perform` alone. There is no stored balance column, no expiry,
  and no sold or purchased credit.
- **Disposition:** Controlled-pilot candidate or Post-Pilot, P2. Implemented; no
  repository evidence confirms a pilot blocker, and Product scope confirmation
  is required for pilot entry. The product boundaries are recorded in the header
  of `migrations/0050_client_credit.sql` and in ADR-011.
- **Scope:** one balance per client per business, granted or adjusted by staff,
  spent at checkout as a `client_credit` payment that reduces the invoice
  balance. Overdraft is refused under a customer row lock re-read inside the
  payment transaction. Voiding a credit payment writes a compensating reversal
  entry; a mistaken entry is corrected by a compensating adjustment that names
  the row it corrects, never by an edit or a delete.
- **Non-goals/decisions:** no gift cards or any purchased credit, which would
  need an invoice of its own while `invoices.appointment_id` is `not null`; no
  expiry, ageing, or sweeping of a balance; no configurable "store credit"
  settlement method staff may pick freely, because that would let a redemption
  be recorded without a ledger entry; no credit as a discount, which would
  shrink the taxable base and under-collect tax on every redemption. Product
  must decide whether a balance survives client offboarding and what a future
  invoice-void route owes a redemption it cancels.
- **Planning:** the balance is a sum over one client's entries and is bounded by
  how much credit history one client accumulates; the running balance is
  computed by the server on every ledger page so no client forms a second
  opinion. Lock order is invoice then customer everywhere, so the two-lock
  payment path cannot deadlock against the single-lock grant path. Tests must
  race two real redemptions against one balance, prove the reversal on void, and
  prove that a redemption and its payment agree.
- **Proposed release evidence:** `Client Credit Valid --
  CI/PostgreSQL/Browser/Financial Integrity`. No current gate change.

### Coupons and configured discounts

**Shipped in migration 0048.** This section previously recorded the domain as
Post-Pilot and unapproved. It is built. What follows describes what exists, and
is deliberately limited to that.

- **Disposition:** Shipped, P1, Existing capability. It entered without the
  financial-design ADR this roadmap named as a precondition; that ADR was never
  written, and its absence is recorded below rather than treated as closed.
- **Schema:** `discounts` (a per-business catalogue: name, `amount` or
  `percentage`, a `per_appointment` or `per_pet` scope, an `active` flag, and a
  unique active name per business); `coupons` (a case-insensitively unique code
  per business, plus name, kind, value, scope, `starts_on`/`ends_on`, permitted
  `weekdays`, `new_clients_only`, `max_redemptions`,
  `max_redemptions_per_client`, `active`); `coupon_redemptions` (unique per
  business, coupon and invoice); `invoice_discounts` (ordered lines carrying a
  `manual`/`discount`/`coupon` source and an immutable name, kind and value
  snapshot per line); and `businesses.discount_stacking_mode`.
- **Administration:** `GET/POST/PUT/DELETE /api/settings/discounts` and
  `POST/PUT/DELETE /api/settings/coupons`, behind `settings.discounts`, with a
  Coupons and discounts settings workspace in the client.
- **Eligibility, evaluated at checkout inside the transaction:** the coupon must
  exist and be active; the appointment's own local civil date must fall inside
  `starts_on`/`ends_on` and on a permitted weekday; `new_clients_only` requires
  no prior non-void invoice for that client; and both redemption caps are
  counted. Each refusal carries its own code -- `COUPON_NOT_FOUND`,
  `COUPON_INACTIVE`, `COUPON_NOT_STARTED`, `COUPON_EXPIRED`,
  `COUPON_WRONG_WEEKDAY`, `COUPON_NEW_CLIENTS_ONLY`, `COUPON_FULLY_REDEEMED`,
  `COUPON_CLIENT_LIMIT_REACHED`.
- **Concurrency:** the coupon row is taken with `select ... for update` before
  the caps are counted, so two checkouts racing a coupon's last redemption
  serialize and the second is refused rather than both reading the same
  pre-redemption count.
- **Stacking:** `businesses.discount_stacking_mode` is a real, enforced setting.
  `one_per_appointment` refuses a second discount line outright with
  `MULTIPLE_DISCOUNTS_NOT_ALLOWED`, counting a keyed manual amount as one of
  them; `amount_first` and `percentage_first` order the fold, and the order
  changes the total because a percentage taken after an amount is a percentage
  of a smaller number.
- **Validation in place:** `tests/database/discounts-coupons.test.ts`,
  `tests/domain/money.test.ts`, `tests/e2e/discounts.spec.ts`, and the
  `invoice_discounts` half of `tests/database/single-money-statement.test.ts`.

**Known limitations, stated rather than implied:**

- **One coupon per checkout.** Checkout accepts a single `couponCode`. Stacking
  combines that one coupon with configured discounts and a manual amount; it
  does not combine two coupons.
- **A redemption cannot be given back.** There is no route that voids an
  invoice, so a redemption is consumed permanently. This is recorded in the
  checkout code and in the header of migration 0048, and it is the most
  significant open item in this domain.
- **No booking-time coupon entry.** A coupon is typed in at checkout. The
  advisory appointment reference this roadmap once scoped is not built, and is
  tracked separately below.
- **No financial-design ADR.** The proposal remains in the ADR backlog.
- **A duplicate stacking column is being retired.** `businesses.coupon_stacking`
  arrived from a parallel branch in migration 0047 and encoded the same
  three-valued rule in a different vocabulary, read by no money code. Product has
  ruled: **`discount_stacking_mode` is canonical and `coupon_stacking` is
  obsolete.** Retirement is in progress — the inert Business-screen control is
  removed and stacking is managed on the Coupons and discounts screen, which
  moves the setting from the `settings.manage` permission to
  `settings.discounts`. No bill changes, because no money code ever read the
  retired column.

### Coupons at booking time

- **Foundation/gap:** the coupon domain exists and is entered at checkout. There
  is no advisory coupon selection on the booking form.
- **Disposition:** Post-Pilot, P2, Not approved. Product approval and
  customer/pilot evidence are required.
- **Candidate scope:** booking selection is advisory only; checkout revalidates
  every eligibility condition against the appointment's own date; an invalid
  coupon stops checkout and never silently becomes a manual amount.
- **Non-goals:** campaigns, personalized generation, and online-booking coupons
  without separate approval.
- **Proposed release evidence:** `Coupon Booking Integration Valid --
  CI/PostgreSQL/Browser/Financial Integrity`. No current gate change.

### General document management

- **Foundation/gap:** secure storage and malware scanning serve one rabies
  compliance type; there is no approved generic category, quota, deletion, or
  retention contract.
- **Disposition:** Post-Pilot, P2, Not approved. Product, Security, and a proposed
  document-domain ADR are required. Rabies remains MVP Core.
- **Decomposition:** compliance documents, pet attachments, appointment
  acknowledgements, photos, veterinary records, multi-select, and new MIME types
  are independent. No undifferentiated lifecycle and no OCR in this initiative.
- **Decisions:** ownership, cardinality, MIME/size/batch limits, quotas, retention,
  legal hold, deletion, expiration, versions, scanning, download audit, export,
  offboarding, and data classification.
- **Planning:** bounded paginated endpoints, quotas, asynchronous per-file work,
  and backpressure control storage/noisy-neighbor risk. Files remain tenant-scoped
  and unavailable until clean. Future UX needs per-file state, partial failure,
  reload recovery, accessible status, and 44px controls.
- **Proposed release evidence:** `Pet Document Domain Valid --
  CI/PostgreSQL/Browser/Security Review`. No current gate change.

### Internal notification routing

- **Foundation/gap:** outbox events, intents, attempts, employees, and memberships
  exist; declarative recipient rules and durable resolution evidence do not.
- **Disposition:** Post-Pilot, P2, Not approved. Existing deterministic behavior is
  the pilot treatment. A narrow exception needs external blocker evidence and
  explicit scope approval.
- **Future scope:** stable event registry, declarative rules, active same-tenant
  resolution at intent creation, resolved-recipient snapshots, deduplication,
  bounded fanout, and administration UI.
- **Non-goals/decisions:** no arbitrary expressions, notification-only role
  system, or online-booking events before that domain exists. Product must decide
  event/rule catalogs, authority, deactivation, required events, and defaults.
- **Planning:** indexed bounded expansion avoids N+1 reads and fanout/retry storms;
  snapshots make delivery reproducible. Controls must prevent foreign recipients,
  duplicate intents, disabled-user delivery, injection, and backlog loss. UI must
  explain recipients, empty routing, audience, and permission failures.
- **Proposed release evidence:** `Internal Notification Routing Valid --
  CI/PostgreSQL/Browser/Delivery Evidence`. No current gate change.

### Feedback automation

- **Foundation/gap:** completion events and retryable delivery primitives exist;
  feedback settings, consent, delay, link policy, and idempotency do not.
- **Disposition:** Post-Pilot, P3, Not approved. Product and Privacy/Legal approval
  are required. Manual communication is the pilot workaround.
- **Proposed, not approved:** email only, public review link, disabled by default,
  business opt-in, durable delay, inspectable failure, and no internal survey.
  One request per appointment/channel and no automatic recompletion resend are
  recommendations, not contracts.
- **Decisions/non-goals:** classification, consent, sender, delay, link ownership,
  templates, reopening/refund behavior, retention, suppression, unsubscribe, and
  resend policy remain open. No SMS, campaigns, analytics, or incentivized review.
- **Planning:** indexed scheduled intents, deterministic idempotency, asynchronous
  delivery, backoff, backlog monitoring, and visible failure protect latency and
  reliability. Link validation, escaping, consent evidence, and suppression
  prevent duplicate outreach, spam, injection, and privacy harm.
- **Proposed release evidence:** `Feedback Automation Valid --
  CI/PostgreSQL/Browser/Privacy Review`. No current gate change.

### Growth and Enterprise

- **Growth, P3, Not approved:** OCR, AI-assisted document intelligence,
  marketing automation, broader promotions, loyalty, and analytics. Coupons have
  shipped and are not in this band; broader promotions and campaigns built on top
  of them are. Reminders are not marketing. OCR requires
  confidence, provenance, governance, safe fallback, and low correction burden.
- **Enterprise, Deferred, Not approved:** organizational administration, formal
  assurance, compliance expansion, enterprise integrations, and policy controls.
  Foundational and pre-pilot deployment security do not move here.

## Proposed ADR backlog

These proposals are not accepted ADRs and have no accepted ADR number.

| Proposal | Decisions required | Dependencies | Approving functions | Status | Implementation blocked? |
|---|---|---|---|---|---|
| Coupon and invoice-discount authority | Reopening, voids and reversals of a redemption; the canonical stacking column and its vocabulary. Authority, snapshots, rounding, eligibility, consumption and stacking order are no longer open -- 0048 decided and built them | Shipped coupon domain | Product, Engineering, Security | Backlog; the domain shipped without it | No -- the domain is built. Outstanding for redemption reversal and the duplicate stacking column |
| Document classification and retention | Domain classes, ownership, MIME, quotas, retention, deletion, legal hold, export, scanning | Existing document ADRs | Product, Engineering, Security, Privacy/Legal as applicable | Backlog | Yes |
| Notification-recipient resolution | Events, rules, timing, authority, dedupe, deactivation, required recipients | Outbox/intent contract | Product, Engineering, Security, Operations | Backlog | Yes |
| Feedback consent and durable scheduling | Classification, consent, scheduling, idempotency, links, templates, suppression, retention | Notification contract | Product, Engineering, Privacy/Legal, Security, Operations | Backlog | Yes |
| Reporting-period calculation | Defaults, locale, views, boundaries, compatibility | Report inventory | Product, Engineering | Backlog | Yes |

## Initiative-specific risks

General risks remain in [Scale readiness](../architecture/scale-readiness.md).

| Risk | Impact | Existing control | Additional control | Approval dependency | Release gate | Recovery |
|---|---|---|---|---|---|---|
| Receipt history mutation, injection, or inconsistent channels | Misleading financial history or unsafe output | Invoice snapshots and escaping convention | Immutable bounded label and channel tests | Product, Security | Financial integrity/security | Disable editable labels; restore renderer; verify snapshots |
| Wrong reporting boundaries or changed grouping | Reports disagree or misstate periods | Timezone-aware bounded helpers | Approved defaults, shared helper, inventory, boundary tests | Product | Reporting correctness; financial gate if applicable | Revert setting use; regenerate explicit ranges |
| Credit overdraft, double redemption, or a ledger that disagrees with an invoice | Money spent twice, or a balance no entry accounts for | Customer row lock, signed single-column ledger, immutable entries, per-payment partial unique indexes | Balance re-read under the lock, reversal on void, concurrent-redemption race test, one money statement per invoice | Product, financial design, Security | Financial integrity | Stop credit redemption; reconcile entries against payments; correct by compensating adjustment |
| Coupon double/cross-tenant use, rounding drift, races, silent invalidation | Incorrect financial effect | Shipped: tenant context, integer money, replay protection, a `for update` row lock on the coupon before the caps are counted, `unique (business_id, coupon_id, invoice_id)` on redemptions, per-line immutable snapshots in `invoice_discounts`, and a `coupon.redeem` audit event | A redemption reversal path, which does not exist -- there is no invoice void route, so a redemption cannot be given back | Product, financial design, Security | Financial integrity | Deactivate the coupon; reconcile invoices and redemptions by hand, since no automated reversal exists |
| Document quarantine bypass, retention ambiguity, growth, or exposure | Malware/privacy incident or failed offboarding | Quarantine, authorization, immutable identity | Domain policy, scanning, quotas, audit, export/deletion contract | Product, Security, Privacy/Legal as applicable | Existing malware/tenant gates | Revoke, quarantine, preserve evidence, incident runbook |
| Notification cross-tenant injection, fanout, duplicates, or deactivated delivery | Disclosure, duplicate messages, missed work | Tenant outbox and intent uniqueness | Scoped resolution, snapshots, limits, dedupe, deactivation policy | Product, Security, Operations | Tenant and duplicate-message gates | Disable rules; cancel intents; reconstruct evidence |
| Feedback consent failure, duplicate outreach, spam, unsafe links/templates | Privacy, trust, deliverability harm | Durable intent and attempts | Approved consent, validation, idempotency, suppression evidence | Product, Privacy/Legal, Security, Operations | Privacy/duplicate-message gates | Disable automation; cancel pending work; remediate |

## Master Release Gate preservation

This roadmap does not modify the Master Release Gate. Existing authority remains
blocking for tenant isolation, financial integrity, data loss, restore, migration
correctness, malware quarantine and managed scanning, duplicate payment or
financial effect, prohibited duplicate customer communication, required
accessibility, staging, operational, and security evidence failures.

Conditional features do not become current blockers or enter the release
candidate without explicit approval. Recommendations cannot close or reclassify
findings.

## Evidence and approval rules

Each decision must distinguish: (1) repository evidence, (2) customer/pilot
evidence, (3) Product decision, (4) Security decision, (5) Privacy/Legal decision,
and (6) final scope disposition. Until external evidence is recorded, use **No
confirmed pilot blocker in repository evidence**. Implementation must not
silently settle an approval item.
