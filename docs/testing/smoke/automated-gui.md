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

The wrapper has bounded lifecycle protection. Its default deadline is selected
by invocation profile (smoke 5 minutes, targeted projects 10 minutes, and the
full browser matrix 15 minutes). `PAWSH_PLAYWRIGHT_WRAPPER_TIMEOUT_MS` may
override a profile for local diagnostics, within the validated 1-second to
1-hour range. The deadline covers server startup, readiness, Playwright, and
cleanup; it is separate from Playwright's browser launch/test timeouts.

The wrapper forwards Playwright output live while retaining only bounded,
redacted tails for timeout diagnostics. It owns only processes it spawned. On
Windows it terminates the owned process tree with `taskkill /T /F`; on Unix it
uses a dedicated process group with bounded graceful and forceful termination.
An external `PAWSH_E2E_BASE_URL` server is never terminated and its port is not
reported as wrapper-owned. A successful or failed Playwright result is returned
before the wrapper deadline when possible; a hung invocation exits nonzero with
a watchdog diagnostic and port-release status. Forced machine or runner
termination can still prevent cleanup.

CI runs static and backend/runtime validation on Node 22 and Node 24. It runs a
light Chromium smoke on Node 22, while Node 24 runs the full Chromium suite, each
browser compatibility subset, three responsive device profiles, and
backup/restore as separate jobs. Every mutable browser job receives its own
PostgreSQL 17 service and runtime. Browser install, startup, test, and total job
timings are recorded by GitHub Actions; no hard timing gate is imposed.

Automated viewport emulation is responsive-web evidence only. It is not physical
iOS or Android validation.
