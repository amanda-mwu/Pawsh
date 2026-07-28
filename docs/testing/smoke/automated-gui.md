# Automated GUI smoke

The Playwright suite answers whether a salon can complete Pawsh's essential
browser workflows. It intentionally does not replace the domain or PostgreSQL
suites.

## Coverage

Eleven isolated Chromium journeys cover authentication/session restoration,
business configuration, owner-managed access, CRM/search, customer-pet
filtering, scheduling overlap/adjacency/blocked time, operations and pet safety,
checkout and manual payment reversal, cross-tenant denial, responsive
operational layouts, accessibility semantics, and loose performance regression
budgets.

Each test creates a unique tenant and mutable records. Dates derive from
`QA_ANCHOR_DATE` or the next Monday in `America/Los_Angeles`. Tests run with zero
retries. Failed runs retain trace, screenshot, video, console-error, and HTTP 5xx
evidence.

## Commands and environments

- `npm run test:smoke`: tagged Chromium smoke.
- `npm run test:e2e`: all configured browser projects.
- `npm run validate:qa`: backend/CI validation followed by browser smoke.

Set `PAWSH_E2E_BASE_URL` to reuse the suite against staging. Otherwise Playwright
starts the local server. Set `PAWSH_E2E_CROSS_BROWSER=true` for Chromium,
Firefox, and WebKit release checks. Credentials are created by isolated fixtures;
the persistent manual QA tenant is never used.

Automated viewport emulation is responsive-web evidence only. It is not physical
iOS or Android validation.
