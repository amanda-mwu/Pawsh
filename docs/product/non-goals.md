# MVP non-goals

The Pawsh MVP intentionally excludes customer self-booking and portals, native
mobile applications, live or stored-card payment processing, deposits, packages,
memberships, gift cards, inventory, payroll, commissions, marketing campaigns,
multi-location operations, routing, franchises, public APIs, advanced analytics,
forecasting, schedule optimization, and AI features.

Client credit is not a gift card and does not make one a goal. Credit is a
balance the salon grants and the customer spends at the till; a gift card is
credit that is bought, so it needs an invoice of its own, and
`invoices.appointment_id` is `not null` today. Credit is recorded as a payment
rather than a discount, and it neither expires nor appears as a settlement
method staff may configure freely. Selling credit, expiring it, and offering it
as a configurable payment method remain excluded.

The schema remains location-aware and the application uses provider adapters and
domain events where those choices keep later expansion practical. These extension
points do not authorize building deferred workflows into the MVP.

The [product roadmap](roadmap.md) records post-pilot sequencing and conditional
pilot candidates. A roadmap entry is not approval to expand the current release
candidate; explicit scope-change approval and existing release gates remain
authoritative.
