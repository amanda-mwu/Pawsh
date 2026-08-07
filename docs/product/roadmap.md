# Pawsh product roadmap

## MVP attachment security supersession

ADR-010 supersedes earlier roadmap language that treated managed malware
scanning, quarantine, retries, or scanner operations as MVP or controlled-pilot
runtime requirements. MVP uses the Rabies Attachment Minimum Safety controls;
managed scanning is deferred post-MVP. The older sections below are retained as
historical planning context and must be read through ADR-010.

## Authority and lifecycle

This is Pawsh's single authoritative customer-value roadmap. It governs product
scope, sequencing, dependencies, approval status, and initiative-specific risk.
It does not supersede accepted ADRs, validation evidence, security findings, or
release gates. `SEC-DOC-001`, `SEC-DB-001`, the Master Release Gate, and other
validated findings retain their existing authority. General platform risks stay
in [Scale readiness](../architecture/scale-readiness.md).

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
- **Manual discount** means one permission-gated aggregate invoice discount, not
  coupon support.

Repository evidence confirms server-owned invoice calculations, a discount cap
at subtotal, rabies-only document typing, tenant-timezone-aware bounded reports,
durable notification intents and delivery attempts, and an appointment-completed
outbox event. It also confirms the absence of a coupon domain, general document
manager, configurable recipient router, week-start preference, immutable
customer-facing discount metadata, and feedback automation.

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

Controlled-pilot security requirement (MVP)
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
authoritative. `SEC-DOC-001` remains a controlled-pilot blocker until managed
scanner staging validation closes it through existing governance. General
document management is a separate post-pilot domain.

## Roadmap summary

| Capability | Release phase | Priority | Approval | Customer/pilot evidence | Pilot treatment |
|---|---|---:|---|---|---|
| Manual invoice discount | MVP | P1 | Existing capability | Repository behavior only | Permission-gated workaround |
| Rabies PDF upload | MVP | P1 | Existing capability | Repository behavior only | Specialized workflow |
| Managed document scanning | Controlled Pilot | P0/P1 per existing authority | Existing gate | Existing security evidence | Must remain blocking |
| Receipt discount label | Controlled-pilot candidate or Post-Pilot | P2 | Not approved; Product approval required | No confirmed pilot blocker in repository evidence | Explicit scope approval required |
| Reporting week start | Controlled-pilot candidate or Post-Pilot | P2 | Not approved; Product approval required | No confirmed pilot blocker in repository evidence | Evidence and scope approval required |
| Coupon domain | Post-Pilot | P2 | Not approved; Product and financial design approval required | No confirmed pilot blocker in repository evidence | Manual discount workaround |
| General documents | Post-Pilot | P2 | Not approved; Product and Security approval required | No confirmed pilot blocker in repository evidence | Rabies workflow remains |
| Notification routing | Post-Pilot | P2 | Not approved; Product approval required | No confirmed pilot blocker in repository evidence | Narrow approved exception only |
| Feedback automation | Post-Pilot | P3 | Not approved; Product and Privacy/Legal approval required | No confirmed pilot blocker in repository evidence | Manual communication |
| OCR and marketing automation | Growth | P3 | Not approved | No confirmed pilot blocker in repository evidence | Deferred |
| Advanced organizational governance | Enterprise | Deferred | Not approved | Not established | Separately approved |

Conditional candidates do not enter the release candidate or become current
release blockers without explicit scope-change approval.

## Dependencies

```text
Receipt discount metadata
        ↓
Coupon domain and booking integration

Notification event registry
        ↓
Notification routing
        ↓
Feedback automation

Document-domain ADR
        ↓
Independently scoped document capabilities

Reporting week-start preference ── independent

Managed document scanning ── existing controlled-pilot security gate,
                             not a post-pilot document dependency
```

## Customer workflow initiatives

### Manual invoice discount

- **Foundation/gap:** checkout stores one aggregate discount, permission-gates
  application, and calculates totals on the server; no coupon domain exists.
- **Disposition:** MVP, P1, Existing capability. Pilot promotional workaround.
- **Scope/non-goals:** retain one server-authoritative discount; no coupons,
  stacking, campaigns, or browser-authoritative pricing.
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
- **Non-goals/decisions:** no coupons, multiple discounts, stacking, or campaigns.
  Product must decide the default label, staff entry, history, and code display.
- **Planning:** negligible growth and no live coupon lookup; snapshot immutability,
  output escaping, channel-consistency tests, accessible mobile rendering.
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

### Coupon domain and booking integration

- **Foundation/gap:** manual discounts and money rules exist; catalog,
  eligibility, usage, appointment references, concurrency-safe consumption, and
  immutable coupon snapshots do not.
- **Disposition:** Post-Pilot, P2, Not approved. Manual discount is the workaround;
  receipt metadata and an approved financial ADR are dependencies.
- **Future scope:** administration, dates, fixed/percentage rules, eligibility,
  limits, advisory appointment reference, transactional checkout revalidation,
  snapshotting, concurrency, reopening, voids, and reversals.
- **Non-goals:** stacking, campaigns, personalized generation, and online-booking
  coupons without separate approval.
- **Recommended, not approved:** booking selection is advisory; checkout
  revalidates; invalid coupons stop checkout and never silently become manual;
  first release permits one coupon or discount per invoice.
- **Planning:** retained financial configuration and usage require audit, export,
  and offboarding policy; bounded administration, tenant indexes, narrow locks,
  uniqueness, and idempotency prevent cross-tenant use, double consumption,
  replay, rounding drift, and negative totals.
- **Proposed release evidence:** `Coupon Domain Valid --
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
  marketing automation, broader promotions, loyalty, and analytics. Coupons are
  the nearer Post-Pilot initiative; reminders are not marketing. OCR requires
  confidence, provenance, governance, safe fallback, and low correction burden.
- **Enterprise, Deferred, Not approved:** organizational administration, formal
  assurance, compliance expansion, enterprise integrations, and policy controls.
  Foundational and pre-pilot deployment security do not move here.

## Proposed ADR backlog

These proposals are not accepted ADRs and have no accepted ADR number.

| Proposal | Decisions required | Dependencies | Approving functions | Status | Implementation blocked? |
|---|---|---|---|---|---|
| Coupon and invoice-discount authority | Authority, snapshots, rounding, eligibility, consumption, reopening, voids, reversals, stacking | Receipt inventory | Product, Engineering, Security | Backlog | Yes |
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
| Coupon double/cross-tenant use, rounding drift, races, silent invalidation | Incorrect financial effect | Tenant context, integer money, replay protection | Transactional checks, narrow locks, uniqueness, snapshots, audit | Product, financial design, Security | Financial integrity | Stop coupons; reconcile invoices and usage |
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
