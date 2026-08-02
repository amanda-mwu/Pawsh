# Windows Chromium origin and teardown validation

## Classification and root cause

This was test/development infrastructure, not a production authentication or
CSRF defect. Three independent problems were exposed:

- The documented Chromium command selected a nonexistent `chromium` project;
  the configuration called the primary project `chromium-desktop`.
- Local Playwright used `http://127.0.0.1:3000`, while the application default
  origin was `http://localhost:3000`. Because Pawsh correctly compares mutation
  origins exactly, browser login received `403 Request origin is not allowed`.
- On this Windows host, Playwright completed successful browser/context cleanup
  but did not terminate its managed web-server lifecycle. A verbose run reached
  `browser.close` successfully and then remained active. The same test passed
  and exited in 1.6 seconds when the app server was owned externally.

The Chromium run also found a real accessibility regression: the desktop Sign
out target rendered 31px high instead of the required 44px minimum.

## Fix

`http://127.0.0.1:3000` is the canonical local test origin. Playwright derives
`APP_ORIGIN` from its base URL when it is not explicitly supplied. The primary
project is named `chromium`, and the npm browser commands use
`scripts/run-playwright.mjs`. That runner owns the local app child process,
waits for `/health`, passes the same base URL and origin to the app and tests,
and terminates the child deterministically after Playwright exits.

CSRF behavior was not weakened. Credentialed CORS and state-changing request
checks still accept only the exact configured `APP_ORIGIN`. Session cookies
remain host-only, `HttpOnly`, `SameSite=Lax`, non-Secure in test/development,
and Secure in production. The canonical database flow now exercises a valid
same-origin mutation in addition to its existing hostile-origin rejection.

The Sign out control now has a 44px minimum target on desktop and responsive
layouts. The migration runner also records every successfully executed file,
and the canonical outbox test drains bounded worker batches so CI's intentional
second database pass is isolated from earlier queued events.

## Local evidence

Environment: Windows, Node 24.11.1, npm 11.6.2, PostgreSQL 17 container on an
isolated local validation database.

- Targeted headed responsive spec before the accessibility fix: 3 passed,
  1 failed (`Sign out` height 31px), final exit code 1.
- Targeted auth/navigation/logout test after the fix: 1 passed, exit code 0.
- Responsive spec with `--repeat-each=5`: 20 passed, exit code 0.
- Full `chromium` project: 50 passed, exit code 0.
- Chromium `@smoke`: 11 passed, exit code 0.
- Matched `http://localhost:3000` comparison: 1 passed, exit code 0.
- `npm run validate:ci`: 87/87 full Vitest tests followed by 60/60 database
  tests, plus lint, typecheck, migration, and build; exit code 0.
- `npm audit`: zero known vulnerabilities.

Firefox, WebKit, device-emulation, and physical-device validation are not part
of this Chromium-only closure record.
