# Architecture

Pawsh is a TypeScript modular monolith served by Fastify with PostgreSQL as its authoritative system of record. A static responsive client consumes tenant- and permission-aware JSON endpoints.

The modules are identity/tenancy, CRM, catalog, scheduling, operations, commerce, engagement, reporting, and administration. Important business changes write audit and outbox records in the same transaction. A background worker converts appointment events into notification intents and sends them through a provider adapter.

The production deployment requires one application process, PostgreSQL, encrypted transport, managed secrets, a backup facility, and an email provider implementation. The development email adapter records provider-safe diagnostic metadata without sending customer data.

See the [product roadmap](../product/roadmap.md) for Pawsh's lifecycle stage,
customer-value sequencing, approval status, and the boundary between controlled
pilot and later initiatives. It does not supersede architecture decisions,
validation evidence, security findings, or release gates.
