# ADR-001: Modular monolith

Status: Accepted

Pawsh begins as a TypeScript modular monolith with a PostgreSQL system of record. Domain code is separated by business responsibility, while one deployable process keeps transactions and operations simple. Cross-domain asynchronous effects use a transactional outbox.

Microservices are deferred until measured operational or team constraints justify extraction.
