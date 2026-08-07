# Local cascading QA

Pawsh provides bounded local QA modes through `scripts/run-qa.mjs`:

- `npm run qa:quick` checks the environment, static validation, critical
  lifecycle regressions, PostgreSQL/migrations, startup health, Chromium
  preflight, and the tagged Chromium smoke.
- `npm run qa:standard` adds targeted regressions and the complete backend test
  suite.
- `npm run qa:full` adds primary Chromium E2E, Firefox/WebKit expansion, and
  locally executable release checks.
- `npm run qa:release-candidate` runs the same complete local sequence without
  reducing coverage; hosted exact-SHA validation is still required.

Stages run in dependency order and stop at the first failure, timeout, or
cleanup failure. Later stages are reported as `blocked`, with the prerequisite
that blocked them. A quick-mode omission is not a pass or a release approval.
Each child has a bounded stage timeout and owned process cleanup. Browser
stages reuse the Playwright lifecycle guard; external servers and databases are
never terminated by the cascade. `PAWSH_QA_STAGE_TIMEOUT_MS` can set a bounded
test/local diagnostic timeout for every command (1 second to 1 hour).

The environment stage requires a loopback `DATABASE_URL`, a supported installed
Node runtime, and no production target. Node 22 is reported as unavailable when
it is not installed; the cascade does not use an unbounded temporary `npx`
runtime download. Full mode treats Firefox as required. A Firefox launch
failure is preserved as an environment/browser result and blocks later browser
stages; it is not silently converted into a Pawsh assertion result.

Passing local QA is evidence for developer use only. It does not replace
hosted exact-SHA CI, managed-scanner staging, physical-device checks, human
accessibility review, Security approval, or launch approval.
