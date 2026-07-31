# QA coverage registry

The authoritative validation target is the current repository `HEAD`. Resolve it
with `git rev-parse HEAD`; a classification is current only when the required CI
jobs pass for that exact SHA. GitHub Actions run links are retained in release
validation records and the final closure report rather than hard-coded here,
because any registry edit creates a new SHA.

| Classification | Required CI job | Browser/profile | Tags | Known limitations |
| --- | --- | --- | --- | --- |
| MVP Runtime Valid | Backend and PostgreSQL runtime | PostgreSQL 17 / Node runtime | Database and runtime suites | Does not validate deployed infrastructure |
| Automated GUI Smoke Valid | Browser / chromium-smoke | Desktop Chromium | `@smoke` | Primary browser only |
| Browser Security Smoke Valid | Browser / chromium-smoke | Desktop Chromium | `@smoke` security scenarios | Superseded for authentication/browser-security authority by the expanded classification below |
| Automated Cross-Browser Core Valid | Browser / `*-cross-browser` | Desktop Chromium, Firefox, WebKit | `@cross-browser` | Deliberately small compatibility subset |
| Automated Responsive Interface Valid — Playwright Device-Profile Emulation | Responsive / device project | iPhone WebKit, Android Chromium, iPad WebKit profiles | `@responsive`, with reserved `@mobile-core` / `@tablet-core` mappings | Physical-device behavior remains unvalidated |
| Automated Authentication & Browser Security Valid — Password-Only | Backend and PostgreSQL runtime; Browser / chromium-security; Browser / iphone-security | Backend integration, desktop Chromium, iPhone WebKit profile | `@security-desktop`, `@security-permission-parity` | Eight-code-point minimum is an explicit MVP decision; MFA/passkeys, staging, manual UX, and physical-device behavior remain unvalidated; authentication throttling is process-local for the single-instance MVP runtime |
| Critical Regression D1 — Booking/Scheduling Valid | Backend and PostgreSQL runtime; Browser / chromium-regression | PostgreSQL integration and desktop Chromium | Database scheduling regression; `@regression-booking` | Does not establish D2 appointment lifecycle, D3 customer/pet history, D4 checkout/error-path, timezone-edge, performance, staging, manual UX, or physical-device validity |
| Critical Regression D2 — Appointment Lifecycle Valid | Backend and PostgreSQL runtime; Browser / chromium-regression | PostgreSQL integration and desktop Chromium | Database lifecycle/concurrency regression; `@regression-lifecycle` | Does not establish D3 customer/pet history, D4 checkout/stale-state/error-path, dedicated lifecycle timestamps, performance, staging, manual UX, or physical-device validity |

| Critical Regression D3 — Customer/Pet History Valid | Backend and PostgreSQL runtime; Browser / chromium-regression | PostgreSQL integration and desktop Chromium | Database CRM/history regression; `@regression-crm-history` | Detailed service-history projection, pet-specific history, service-time safety snapshots, hard delete, customer optimistic concurrency, D4 checkout/error paths, performance gating, staging, manual UX, and physical-device behavior remain unvalidated |
| D3.1 — Pet Care Authorization Terminology Migration Valid | Backend and PostgreSQL runtime; all inherited browser/security jobs | PostgreSQL 17 and inherited browser profiles | Database permission-migration and D3 CRM/history suites | Renames authorization/audit vocabulary only; pet documents, D4, staging, and Controlled Pilot readiness remain unvalidated |
| Pet Care Document Management Valid — Rabies Vaccination PDF | Backend and PostgreSQL runtime; Browser / chromium-regression; inherited security/browser jobs | PostgreSQL integration, deterministic private-storage adapter, desktop Chromium | Database document regression; `@regression-pet-documents` | Deployed bucket/IAM/recovery, malware scanning, OCR, images, inline viewing, range requests, removal, reminders, booking enforcement, generalized documents, staging, and physical-device behavior remain unvalidated |
| Critical Regression D4 — Checkout/Stale-State/Error Paths Valid | Backend and PostgreSQL runtime; Browser / chromium-regression; inherited security/browser jobs | PostgreSQL integration and desktop Chromium | Database checkout regression; `@regression-checkout` | Refunds, invoice corrections/voiding, write-offs, receipt reissue mutations, and external processor mutations are absent; `ARCH-001` remains open |
| Automated Critical Regression Valid | Backend and PostgreSQL runtime; Browser / chromium-regression; all inherited CI jobs | PostgreSQL and inherited browser/device profiles | `@regression-booking`, `@regression-lifecycle`, `@regression-crm-history`, `@regression-pet-documents`, `@regression-checkout` | Accessibility, calendar/time edges, mandatory pilot findings, staging, manual UX, and physical devices remain separate gates |
| Calendar & Time Integrity Valid | Backend and PostgreSQL runtime; Browser / chromium-regression; all inherited CI jobs | Node 24 ICU, PostgreSQL 17, desktop Chromium including alternate browser timezone context | Domain/database time regression; `@regression-calendar-time` | Single active location and no cross-midnight appointments are controlled-pilot limitations; future ICU/tzdata changes may change derived historical rendering; staging/manual/physical-device time-picker validation remains separate |

## Batch C security closure

| Closure | Authority established |
| --- | --- |
| C0 — architecture audit | Authentication route/control inventory, cookie and session semantics, CSRF/origin design, fixation considerations, password policy, and deferred capabilities are recorded in `docs/architecture/authentication-security.md` |
| C1 — password and credential controls | Shared server-authoritative policy, Unicode code-point and byte limits, deterministic whole-password blocking, explicit Argon2id parameters, form semantics, and reset-token invalidation |
| C2 — abuse and telemetry | Generic authentication responses, bounded account/network throttling, deterministic clock-based coverage, pseudonymous security telemetry, and secret redaction |
| C3 — stale authority | Server-side session revocation, stale-permission denial with no side effect, browser-context tenant isolation, responsive permission parity, and safe client reconciliation |

## Responsive tag mapping

| Tag | iPhone WebKit | Android Chromium | iPad WebKit |
| --- | --- | --- | --- |
| `@responsive` | Yes | Yes | Yes |
| `@mobile-core` | Yes | Yes | No |
| `@tablet-core` | No | No | Yes |
