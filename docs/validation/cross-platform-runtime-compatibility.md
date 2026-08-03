# Cross-platform runtime compatibility

## Classification

Current preserved classification:

> Node.js 22/24 Runtime Compatibility Valid — Ubuntu CI Scope

Engineering candidate; classification remains blocked by branch protection:

> Cross-Platform Runtime Compatibility Valid — GitHub-hosted Ubuntu x64,
> Windows x64, and macOS arm64 CI Scope

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
  on Ubuntu, the GitHub Windows runner's documented PostgreSQL 17 service, and Homebrew on macOS. Database and isolation
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

Green evidence run 30857253141 consumed about 20 job-minutes across the required
matrix and 5 minutes 38 seconds wall time. Its six retained evidence artifacts
total about 1.8 MB. Windows no longer downloads PostgreSQL because the recorded
GitHub-hosted image provides PostgreSQL 17.10.

Branch protection must require
`Cross-Platform Runtime Compatibility — Required Matrix` after merge while
retaining canonical CI requirements. Generated matrix names are evidence, not
the sole protection contract. The authenticated protection API returned HTTP
403 because this private repository's current GitHub plan does not enable
branch protection. This is an operational closure blocker; upgrade the plan or
make the repository public, then require the stable aggregate check.

Weekly diagnostics record dependency age and can later add latency, memory,
event-loop, pool, and index observations. Owner roles: runtime/toolchain,
Windows filesystem/process, canonicalization, and browser/UX—Engineering/QA;
PostgreSQL and CI—Engineering/Operations; security/configuration—
Security/Engineering; diagnostics/performance—Engineering.

Runner image, Node/npm patch, PostgreSQL patch, Playwright/browser, ICU, and
OpenSSL drift is recorded. Material updates trigger the required matrix. A new
failure is a new finding, not proof earlier timestamped evidence was false.

## Exact-SHA engineering evidence

Green implementation candidate:

- SHA: `81b7da7f9579fce9a1554c344bd945841a8affda`
- Cross-platform run: `30857253141` — all six lanes and stable aggregate passed
- Canonical CI run: `30857253152` — passed
- Normalized fixture SHA-256 on all six lanes:
  `83361fc6da18cdd8e4b764ece19e6f8a3eb94c72442577a7baef36a27f14aacd`
- Unit/static/build baseline: 73 unit tests passed; database and browser suites
  ran in their required lanes with retries set to zero
- Artifact redaction: passed in every lane; retention expires after seven days
- Windows long paths: enabled on the recorded runner; a 329-character path and
  exclusive locked-file cleanup passed

Recorded toolchain:

| Lane | Runner image | Architecture | Node/npm | PostgreSQL | ICU/OpenSSL | Browser |
| --- | --- | --- | --- | --- | --- | --- |
| Ubuntu Node 22 | `ubuntu24` `20260720.247.2` | x64 | 22.23.1 / 11.6.0 | server 17; client 16.14 | 78.2 / 3.5.7 | Chromium 151.0.7922.34 |
| Ubuntu Node 24 | `ubuntu24` `20260720.247.2` | x64 | 24.18.0 / 11.6.0 | server 17; client 16.14 | 78.3 / 3.5.7 | Chromium 151.0.7922.34; full configured matrix |
| Windows Node 22 | `win25-vs2026` `20260728.188.1` | x64 | 22.23.1 / 11.6.0 | 17.10 | 78.2 / 3.5.7 | Chromium 151.0.7922.34 |
| Windows Node 24 | `win25-vs2026` `20260728.188.1` | x64 | 24.18.0 / 11.6.0 | 17.10 | 78.3 / 3.5.7 | Chromium 151.0.7922.34 |
| macOS Node 24 | `macos26` `20260728.0273.1` | arm64 | 24.18.0 / 11.6.0 | 17.10 Homebrew | 78.3 / 3.5.7 | Chromium 151.0.7922.34; reduced WebKit |
| UTC focused | `ubuntu24` `20260720.247.2` | x64 | 24.18.0 / 11.6.0 | not required | 78.3 / 3.5.7 | not required |

All lanes used Playwright 1.62.1. The canonical timezone was
`America/Los_Angeles`; the focused comparison used `UTC`. The evidence-recording
descendant adds explicit PostgreSQL server-version capture and must pass a new
exact-SHA run before final reporting.

Confirmed findings resolved during execution:

- Repository-local Playwright browser installation was made consistent.
- Windows now starts its exact documented PostgreSQL 17 service instead of
  reinstalling an already-provisioned server.
- Disposable macOS database test authority matches the canonical RLS test lane.
- Browser version discovery is headless and bounded on Windows.
- PostgreSQL client and tested server versions are recorded separately.

Remaining operational blocker: stable branch protection cannot be enabled on
the current private-repository GitHub plan. Until that changes, preserve the
Ubuntu-scope classification even when engineering matrix evidence is green.

## Explicit limitations

- GitHub-hosted runner images and recorded architectures only.
- No arbitrary Linux distribution, Windows edition, or filesystem claim.
- No Intel/Apple Silicon dual-macOS claim unless both are tested.
- No real Safari or physical-device claim.
- No staging or production OS/infrastructure claim.
- No horizontal scaling, clustering, Kubernetes, HA, multi-region, disaster
  recovery, comprehensive load, CDN, OCR, analytics, or enterprise claim.
