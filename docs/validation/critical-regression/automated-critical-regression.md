# Automated Critical Regression Closure

## Classification

**Automated Critical Regression Valid**.

This classification requires one exact current HEAD to retain:

- D1 — Booking/Scheduling Valid
- D2 — Appointment Lifecycle Valid
- D3 — Customer/Pet History Valid
- D3.1 — Pet Care Authorization Terminology Migration Valid
- D3.2 — Pet Care Document Management Valid — Rabies Vaccination PDF
- D4 — Checkout/Stale-State/Error Paths Valid

The required PostgreSQL, migration, backup/restore, static, dependency, Chromium
regression/smoke/security/cross-browser, Firefox/WebKit cross-browser, iPhone
security, and iPhone/Android/iPad responsive jobs must pass for the exact same
SHA. The final Codex report records that SHA and run because this commit cannot
embed its own hash.

This classification does not establish accessibility, calendar/time-edge,
pilot-performance, staging, manual-UX, physical-device, or Controlled Pilot
validity. `ARCH-001`, `SEC-DOC-001`, and `GOV-001` remain mandatory pre-pilot
work.
