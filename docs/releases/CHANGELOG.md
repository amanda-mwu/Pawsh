# Changelog

## 0.1.3

### Added

- Isolated Playwright browser smoke, guarded manual QA data, and the manual UX
  validation package.

### Changed

- Operational GUI safety, permissions, customer-pet booking, mutation feedback,
  stale-state protection, and manual payment correction were hardened.

### Validation

- Thirty-two backend tests, 50 consecutive auth lifecycle executions, 11
  Chromium GUI/security smoke tests, PostgreSQL runtime validation, production
  build, dependency audit, and dump/restore verification pass.

## 0.1.2

### Fixed

- Made authenticated-encryption tamper checks deterministic and rejected
  malformed or non-canonical encrypted payloads.
- Aligned local and CI runtime versions and added a repository-managed pre-push
  validation guard.

### Validation

- Thirty-two automated tests, 50 repeated secret-suite executions, PostgreSQL
  runtime validation, production build, and backup/restore rehearsal pass.

## 0.1.1

### Fixed

- Expanded database regression coverage for exclusive notification claims,
  secure reset-message persistence, and isolated platform-support sessions.
- Added an index for eligible notification delivery claims.

### Validation

- Thirty automated tests, PostgreSQL runtime suites, critical-read latency
  budgets, production build, and backup/restore rehearsal pass.

## 0.1.0

### Added

- Multi-tenant salon foundation, owner permissions, membership lifecycle, CRM,
  pet safety data, services, employees, scheduling, operations, checkout,
  receipts, manual payment corrections, engagement delivery, dashboard/reports,
  support controls, audit history, and responsive web client.

### Changed

- Production email uses an SMTP adapter; password-reset message bodies are
  encrypted at rest and delivery workers use retry-safe atomic claiming.
- Scheduling, commerce, owner protection, and tenant isolation are enforced by
  application rules plus PostgreSQL constraints or policies.

### Validation

- Lint, types, unit/static tests, PostgreSQL migration and integration suites,
  canonical smoke flow, scheduling concurrency, tenant isolation, production
  build, and PostgreSQL dump/restore rehearsal pass.
