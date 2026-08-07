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
- `npm run qa:resume` retries the first failed stage from the last compatible
  run and continues only after it passes. It requires the same SHA, Node/test
  environment fingerprint, and complete prior cleanup.

Stages run in dependency order and stop at the first failure, timeout, or
cleanup failure. Later stages are reported as `blocked`, with the prerequisite
that blocked them. A quick-mode omission is not a pass or a release approval.
Each child has a bounded stage timeout and owned process cleanup. Browser
stages reuse the Playwright lifecycle guard; external servers and databases are
never terminated by the cascade. `PAWSH_QA_STAGE_TIMEOUT_MS` can set a bounded
test/local diagnostic timeout for every command (1 second to 1 hour).

The local smoke stage uses one worker only. This is a narrow resource-isolation
measure: ten local workers reproducibly starved navigation against the single
disposable Pawsh server/database, while the same 11-test Chromium smoke set
passes with one worker. The global Playwright worker configuration is unchanged.

All repository-owned mutable browser stages receive an explicit disposable
environment: `NODE_ENV=test`, `PAWSH_E2E_MODE=disposable`, loopback
`DATABASE_URL`, memory document storage, deterministic scanning, a local
`APP_ORIGIN`, and a validation-only session secret. The Playwright fixture guard
remains unchanged and still rejects direct mutable runs without disposable mode.
The child environment is assembled centrally and never mutates the parent
process.

The orchestrator records a small atomic state file at `.pawsh-qa/last-run.json`.
It contains only the SHA, mode, stage outcome, cleanup status, safe environment
fingerprint, and orchestrator version; it contains no credentials or logs. A
same-SHA unresolved failure prevents an accidental direct `qa:full` run. Use
`qa:resume` to retry the failed stage, or `qa:full -- --restart` to explicitly
start a fresh full run. Release-candidate mode always performs its complete
cascade.

The environment stage requires a loopback `DATABASE_URL`, a supported installed
Node runtime, and no production target. Node 22 is reported as unavailable when
it is not installed; the cascade does not use an unbounded temporary `npx`
runtime download. Full mode treats Firefox as required. A Firefox launch
failure is preserved as an environment/browser result and blocks later browser
stages; it is not silently converted into a Pawsh assertion result.

Passing local QA is evidence for developer use only. It does not replace
hosted exact-SHA CI, managed-scanner staging, physical-device checks, human
accessibility review, Security approval, or launch approval.
