# Node.js 22 and 24 compatibility

## Classification

**Node.js 22/24 Runtime Compatibility Valid** on tested candidate
`85bdcbbf286245dc4732d603987c9e9ef83f4577`.

Official application support is Node.js 22.x and 24.x with npm 11. Node 24 is
the recommended local and canonical browser runtime. Final classification
requires all exact-SHA matrix and browser jobs to pass.

## Inspection and decision

- The application is ESM with TypeScript `NodeNext`; it does not use CommonJS
  globals or Node-24-only APIs.
- Crypto usage relies on stable `node:crypto` hashing, HMAC, random bytes,
  authenticated encryption, and UUID APIs available in both majors.
- Filesystem promises, process signals, child-process lifecycle handling,
  `fetch`, `Intl`/ICU, and timer `unref()` are supported by both majors.
- `@node-rs/argon2` is the only native runtime dependency of note; `npm ci`,
  authentication tests, and PostgreSQL integration exercise its installed
  binary on both Node versions.
- Playwright server ownership uses `process.execPath` and explicit signal-based
  shutdown, avoiding npm-wrapper lifecycle differences on Windows.
- No Dockerfile, Compose file, Volta configuration, or devcontainer currently
  pins another Node version. Existing `.node-version` and `.nvmrc` retain the
  canonical value `24`.

The minimal non-redundant CI design matrices static and PostgreSQL runtime
validation across exactly Node 22 and 24. Node 24 runs every existing browser,
security, cross-browser, responsive, and backup job. Node 22 adds Chromium smoke
to exercise the same server/browser boundary without duplicating the full
Playwright workload.

## Storage and origin safeguards

The reported development crash is the intentional guard in
`createDocumentStorage`: `DOCUMENT_STORAGE_ADAPTER=memory` throws unless
`NODE_ENV=test`. Development uses the filesystem adapter; production requires
S3. CI explicitly proves development-memory rejection, disposable test-memory
success, and real development server startup with filesystem storage on both
Node versions.

The canonical browser origin is `http://127.0.0.1:3000`. Playwright derives
`APP_ORIGIN` from its base URL when not explicitly supplied. `localhost` and
`127.0.0.1` must not be mixed because Pawsh's CORS and mutation-origin controls
compare the exact origin.

## Validation evidence

There is no independent formatting script. Required evidence for both Node
majors is npm 11 installation, `npm ci`, runtime guard, lint, typecheck, unit
tests, production build, migrations, PostgreSQL tests, storage safeguard tests,
and development startup. Node 22 also runs Chromium smoke; Node 24 runs the full
browser suite.

- Baseline SHA: `9710b1d68a0018fd477d0c3c65177eb2594d949a`
- Node 22 local static results: Node 22.23.2, clean `npm ci`, runtime guard,
  lint, typecheck, 30 unit/domain tests, and production build passed; the
  lockfile SHA-256 was unchanged.
- Node 24 local static results: Node 24.18.0, clean `npm ci`, runtime guard,
  lint, typecheck, 30 unit/domain tests, production build, and production
  dependency audit passed; the lockfile SHA-256 was unchanged.
- Node 22 CI results: static validation, PostgreSQL runtime/integration,
  development filesystem startup, test-only memory safeguard, and Chromium
  smoke passed.
- Node 24 CI results: static validation, PostgreSQL runtime/integration,
  development filesystem startup, test-only memory safeguard, full Chromium
  smoke/regression/security/cross-browser coverage, Firefox/WebKit compatibility,
  iPhone security, responsive profiles, and backup/restore passed.
- Playwright results: all browser and responsive jobs passed with retries set to
  zero. A date-dependent lifecycle fixture exposed by the first candidate was
  corrected to use explicit business wall time; the replacement regression job
  passed.
- Exact candidate CI run: [GitHub Actions 30845525388](https://github.com/amanda-mwu/Pawsh/actions/runs/30845525388),
  16 of 16 jobs passed.
- Final evidence-documentation descendant: exact-SHA rerun is required and is
  reported in the release closure report, avoiding a self-referential SHA edit.
