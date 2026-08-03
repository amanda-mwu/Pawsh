# Cross-platform runtime compatibility

## Classification

Current preserved classification:

> Node.js 22/24 Runtime Compatibility Valid — Ubuntu CI Scope

Candidate only until exact-SHA closure:

> Cross-Platform Runtime Compatibility Valid — GitHub-hosted Ubuntu x64,
> Windows x64, and macOS [runner-recorded architecture] CI Scope

## Inspection findings and decisions

- Pawsh is an ESM/TypeScript NodeNext modular monolith. Package scripts delegate
  to Node and contain no `export`, `source`, `rm`, `cp`, `mv`, `grep`, `sed`, or
  `awk` implementation assumptions. Windows scripts are exercised through
  PowerShell and cmd, and macOS through zsh.
- Package engines remain Node `>=22 <25` and npm `>=11 <12`. The package range
  technically contains Node 23; executable policy accepts stable Node majors 22
  and 24 only and stable npm major 11 only.
- Runtime policy is a pure tested function. Node 22.0.0 and 24.0.0 are accepted.
  The optional `.env` bootstrap uses `process.loadEnvFile()` because Node's
  `--env-file-if-exists` flag was not added until 22.9.0; this avoids an
  accidental patched-version floor. Prereleases and malformed versions are
  rejected.
- Official Node 22-to-24 migration guidance identifies OpenSSL 3.5, stricter
  argument validation, fetch/stream behavior, Windows path fixes, and native
  addon toolchain changes. Pawsh uses Node-API prebuilt Argon2, child-process
  argument arrays, authenticated AES-GCM, standard fetch, and targeted platform
  filesystem/process checks.
- Native/prebuilt inventory: `@node-rs/argon2` selects a platform Node-API
  binary and is exercised on every lane; `pgsql-parser`/`libpg-query` is
  exercised by migration syntax tests; Playwright supplies platform browser
  binaries; esbuild has a development postinstall; fsevents is an optional macOS
  development watcher. Lifecycle scripts stay enabled.
- Durable scheduling, finance, and replay hashes use one SHA-256 canonical
  helper. Cross-platform fixtures normalize line endings and remove IDs,
  execution timestamps, correlations, and other variable metadata before audit
  and outbox logical comparisons. Random passwords, UUIDs, salts, tokens, IVs,
  and ciphertext are tested for structure/interoperability, not equality.
- No domain branch depends on the operating system. Durable business results,
  authorization, tenant isolation, scheduling, financial calculations,
  transaction/outbox/audit semantics, and API contracts must be equivalent.
- PostgreSQL is real and versioned on every supported runner: service container
  on Ubuntu, Chocolatey on Windows, Homebrew on macOS. Database and isolation
  identifiers include the workflow run and lane.
- Runner image, architecture, Windows long-path policy, OS, Node/npm,
  PostgreSQL, ICU, OpenSSL, Playwright, timezone, commit, and run ID are captured
  rather than inferred.

## Required matrix

| Stable job/check | Scope |
| --- | --- |
| Runtime Compatibility — Ubuntu Node 22 | Static/unit, dependency trees, PostgreSQL integration/concurrency/idempotency, startup/shutdown, Argon2, fixtures, Chromium smoke |
| Runtime Compatibility — Ubuntu Node 24 | Same compatibility contract; full inherited browser evidence remains canonical CI |
| Runtime Compatibility — Windows Node 22 | Static/unit, dependency trees, PowerShell/cmd, PostgreSQL integration/concurrency/idempotency, startup/shutdown, Argon2, fixtures, Chromium smoke |
| Runtime Compatibility — Windows Node 24 | Node 22 scope plus spaces/Unicode repository and storage paths, runner-aware long paths, exclusive locks, traversal/reserved names, cleanup and port release |
| Runtime Compatibility — macOS Node 24 | Static/unit, dependency trees, zsh, PostgreSQL integration, startup/shutdown, Argon2, fixtures, Chromium and reduced WebKit smoke |
| Runtime Compatibility — UTC Canonicalization | Fixed scheduling/date-only/DST/money/replay fixtures under `TZ=UTC` |
| Cross-Platform Runtime Compatibility — Required Matrix | Requires every group and six identical normalized fixture artifacts |

No required job uses `continue-on-error` or Playwright retries. Pull-request
runs cancel obsolete executions for the same branch. Main exact-SHA runs use the
commit SHA as their concurrency group and remain available as evidence.

## Filesystem, process, configuration, and artifacts

Filesystem validation covers spaces, Unicode, combined names, safe path joining,
traversal rejection, Windows reserved names, CRLF/LF normalization, temporary
cleanup, exclusive Windows locks, and runner-aware long paths. Windows records
`LongPathsEnabled`; no claim is made about every Windows installation. Startup
selects a free loopback port, bounds readiness to 20 seconds and shutdown to 10,
releases the port, and removes filesystem storage.

Explicit environment values override `.env`; duplicate file keys use Node's
last-value rule. `APP_ORIGIN` accepts a root slash and canonicalizes to an exact
origin. Credentials, queries, fragments, non-root paths, wildcard hosts,
malformed values, and unsupported protocols fail; production HTTP fails.
Loopback host spellings remain distinct.

Text artifacts are scanned for credential-bearing database URLs,
authorization/cookie values, configured secrets, and private keys. Retention is
seven days. Browser evidence uses disposable synthetic tenants only; no
production/staging data or real Pet Care, document, customer, or payment content
is permitted.

## Governance and diagnostics

Provisional cost before evidence: roughly 70–130 billed runner-minutes and
20–45 minutes wall time, dominated by Windows PostgreSQL and browser setup.
Expected evidence storage is 25–100 MB/run, with failure traces the main
variable. Exact-run evidence replaces these estimates.

Branch protection must require
`Cross-Platform Runtime Compatibility — Required Matrix` after merge while
retaining canonical CI requirements. Generated matrix names are evidence, not
the sole protection contract. Branch-protection state is inspected at closure;
missing protection is an explicit operational follow-up/blocker.

Weekly diagnostics record dependency age and can later add latency, memory,
event-loop, pool, and index observations. Owner roles: runtime/toolchain,
Windows filesystem/process, canonicalization, and browser/UX—Engineering/QA;
PostgreSQL and CI—Engineering/Operations; security/configuration—
Security/Engineering; diagnostics/performance—Engineering.

Runner image, Node/npm patch, PostgreSQL patch, Playwright/browser, ICU, and
OpenSSL drift is recorded. Material updates trigger the required matrix. A new
failure is a new finding, not proof earlier timestamped evidence was false.

## Evidence pending exact-SHA execution

- Final HEAD: pending
- Commits and workflow run: pending
- Per-job versions/statuses and architecture: pending
- Artifact references/redaction: pending
- Measured runtime/cost: pending
- Branch-protection status: pending
- Findings: pending

## Explicit limitations

- GitHub-hosted runner images and recorded architectures only.
- No arbitrary Linux distribution, Windows edition, or filesystem claim.
- No Intel/Apple Silicon dual-macOS claim unless both are tested.
- No real Safari or physical-device claim.
- No staging or production OS/infrastructure claim.
- No horizontal scaling, clustering, Kubernetes, HA, multi-region, disaster
  recovery, comprehensive load, CDN, OCR, analytics, or enterprise claim.
