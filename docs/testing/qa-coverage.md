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
