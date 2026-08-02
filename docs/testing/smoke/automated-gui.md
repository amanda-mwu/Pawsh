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

Batch A adds four deliberately small `@cross-browser` journeys for desktop
Chromium, Firefox, and WebKit: browser-cookie session lifecycle, booking
persistence, customer/pet scoping, and prepared checkout receipt presentation.
Chromium remains the deep browser and continues to run all 11 `@smoke` journeys.
The application stylesheet explicitly preserves the HTML `[hidden]` invariant so
auth and authenticated surfaces cannot overlap while session state settles.

Batch B adds four shared `@responsive` journeys on the `iphone-webkit`,
`android-chromium`, and `ipad-webkit` Playwright device profiles. They validate
auth/navigation/logout, customer-pet scoping, concrete booking persistence, and
objective layout/control reachability. This is browser device-profile emulation,
not physical-device evidence.

## Commands and environments

- `npm run test:smoke`: tagged `chromium` smoke.
- `npm run test:cross-browser`: the compatibility subset on all three desktop
  projects.
- `npm run test:responsive`: shared responsive coverage across configured
  desktop and device-profile projects; use an explicit responsive project for a
  single profile.
- `npm run test:e2e`: all configured browser projects.
- `npm run validate:qa`: backend/CI validation followed by browser smoke.

Mutable fixtures require the explicit `PAWSH_E2E_MODE=disposable` execution
mode. This prevents a base URL from being treated as proof that destructive setup
is safe. Playwright starts the local server unless `PAWSH_E2E_BASE_URL` is
supplied. Credentials are created by isolated fixtures; the persistent manual QA
tenant is never used.

The npm browser commands use `scripts/run-playwright.mjs` so the local server is
owned and terminated deterministically on Windows as well as Unix. For direct
`npx playwright test` debugging, start the server separately and set
`PAWSH_E2E_BASE_URL` to its origin.

CI runs static validation, backend/runtime validation, Chromium smoke, each
browser compatibility subset, three responsive device profiles, and
backup/restore as separate jobs. Every mutable browser job receives its own
PostgreSQL 17 service and runtime. Browser install, startup, test, and total job
timings are recorded by GitHub Actions; no hard timing gate is imposed.

Automated viewport emulation is responsive-web evidence only. It is not physical
iOS or Android validation.
