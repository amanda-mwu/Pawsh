# Mobile clients

Pawsh runs on the desktop web, iOS, and Android from one backend, one database, and one set of
domain rules.

```
Pawsh backend (Fastify) + PostgreSQL
        │
        ├── Pawsh web      public/            desktop and responsive browser
        ├── Pawsh iOS      apps/mobile/       Expo / React Native
        └── Pawsh Android  apps/mobile/       the same source
        
        shared by all three: packages/domain (@pawsh/domain)
```

There is one mobile codebase, not one per platform, and no mobile-specific backend.

## Why Expo and React Native

The domain layer is already TypeScript, so a React Native client can import it unchanged; that is
the entire reason this is cheap. Note what is *not* shared: the web frontend is vanilla JavaScript
in `public/app.js` with no build step and no React, so there are no components to reuse. The shared
surface is deliberately **logic and vocabulary, not rendering** — which is the right boundary
anyway, since a web table and a native list should not be the same component.

Expo supplies the pieces that are painful to assemble by hand and dangerous to get wrong:
Keychain/Keystore-backed credential storage, a maintained navigation stack, and a bundler that
targets both platforms from one dependency tree.

## Repository layout

```
packages/domain/     @pawsh/domain — shared rules, vocabulary, wire types. Zero dependencies.
apps/mobile/         the Expo app. Its own package.json and package-lock.json.
src/                 the backend. Imports @pawsh/domain.
public/              the web app. Does not import it yet — see "Web adoption" below.
```

The root `package.json` declares `"workspaces": ["packages/*"]` — **`apps/*` is excluded on
purpose**. npm hoists every workspace member into the root `node_modules`, so including the app
would install the React Native toolchain on every `npm ci`: on each Fast CI push, on both Node
versions in full validation, in all eight browser jobs, in all three responsive jobs, and in every
cross-platform job. The app therefore carries its own lockfile and installs only when something
actually validates it. `@pawsh/domain` has zero dependencies, so keeping *it* in the root graph
costs nothing.

## What is shared, and what is deliberately not

`@pawsh/domain` compiles to `dist` and is consumed through its package name. Its `tsconfig.json`
sets `"types": []`, so Node globals are not even in scope — a `node:` import fails to compile
rather than failing later at bundle time on a developer's phone.

**Shared:** the appointment status tuple and transition machine, permissions and `can()`, invoice
arithmetic, pricing classes and weight tiers, rabies evaluation, pet-care field lists and
redaction, the dog-breed catalog, the display label tables, the enums that previously existed only
in SQL, presentation rules (badge precedence, which actions an appointment offers), and the API
wire types.

**Not shared, and why:**

| Module | Stays server-side because |
| --- | --- |
| `src/domain/time.ts` | Built entirely on `Intl.DateTimeFormat` and `formatToParts`. React Native's Hermes engine ships a reduced ICU whose named-timezone support is not dependable, and a groomer shown 9:00 for a 10:00 appointment is a worse failure than any amount of inelegance. Wall-time resolution is already server-authoritative; the app renders `scheduledLocalStart` as given. |
| `src/domain/canonical.ts` | `node:crypto`. |
| `src/domain/catalog-seed.ts`, `service-pricing.ts` | Need a database connection. |
| `src/domain/images.ts` | Uses `TextDecoder("ascii")`, which React Native does not reliably provide. Movable once that is replaced; it has no mobile consumer yet. |

### Label tables are canonical here now

Appointment status labels, rabies labels, health-issue labels, permission labels, and currency
formatting previously existed **only** in `public/app.js`. A second client would have become a
second hand-typed copy. They now live in `packages/domain/src/labels.ts`, typed as total `Record`s
over their domain tuples, so adding a status without a label fails the build rather than shipping
a blank badge. `enums.ts` does the same for invoice status, payment status, payment method,
pricing mode, and service category, which had no TypeScript representation at all.

### Web adoption is deferred, not abandoned

`public/app.js` still carries its own copies. It currently imports nothing, so the first import is
not a refactor — it introduces a module-loading strategy to a page that has none, alongside its own
Playwright and `html-validate` surface. That belongs in its own pass, and the first bite should be
data (labels and constants) rather than behaviour. Until then the tables here are canonical and the
web copies are the ones that must follow.

One discrepancy found while transcribing them: the web app has **two disagreeing definitions of
"rabies needs attention"** — its detail panel warns on four states, its calendar card on two. A pet
whose record is `expired` is flagged when you open the appointment but not on the card scanned
while walking the floor. `rabiesNeedsAttention` takes the wider set; the web card should be
corrected to match.

## Authentication

Native clients use the **same sessions as the web**, over a different transport.

The session token was already ideal for this: 32 random bytes, stored only as a SHA-256 hash, with
user, tenant, and permissions re-read from the database on every request. Nothing is packed into
the cookie, so the cookie was only ever a carrier.

- `POST /api/auth/login` with `x-pawsh-client: native` returns `{ ok: true, token }` and sets **no**
  cookie. Without the header the response is byte-identical to before.
- Every request sends `Authorization: Bearer <token>`; `sessionToken()` in `src/http/context.ts`
  prefers the header and falls back to the cookie.
- There is deliberately **no endpoint that exchanges a cookie for a token**. That would turn any
  same-origin XSS into a stealable 14-day credential and defeat `httpOnly`.
- The token lives in `expo-secure-store` (Keychain / Android Keystore), never AsyncStorage.
- Sessions last 14 days with no refresh, so a `401` is terminal: clear and re-authenticate.

Tenant isolation and permissions are unchanged and remain server-enforced. The app hides controls
the user lacks permission for, but that is presentation — the server checks every one again.

### Related security debt, not introduced by this work

Tenant isolation rests on application-level `where business_id = …` predicates. RLS policies exist
but are **inert**: no table uses `FORCE ROW LEVEL SECURITY` and the application connects as the
table owner, which PostgreSQL exempts from its own policies. Adding a non-owner application role
and forcing RLS would convert every one of those predicates from a chance to forget into a
database-enforced invariant. Separately, `trustProxy` is unset, so behind a load balancer every
client shares one rate-limit bucket. Both are independent of mobile and worth their own work.

## Continuous integration

`scripts/ci-change-classifier.mjs` distinguishes `mobile_app` (`apps/**`) from `shared_package`
(`packages/**`) and emits `mobile` and `server` flags:

- a **mobile-only** change skips server lint, typecheck, unit tests, and build;
- a **shared-package** change runs both, because the server consumes it too;
- anything mixed or unrecognised runs everything.

Mobile typecheck and tests run as extra steps in the *existing* Fast CI job — a second job would
pay for another checkout and another install to save thirty seconds of work. Full validation adds a
Linux-only job that runs `expo-doctor` and bundles for both platforms.

**No native builds run automatically.** `expo prebuild`, Gradle, Xcode, EAS, and any macOS runner
stay manual. `expo export` catches broken imports, missing assets, and Metro resolution failures —
most of what a native build would catch — at Linux-runner cost. There is no schedule, per the
standing policy that an unchanged commit is not re-validated on a timer.

## Scope

**In this release:** authentication, workspace and location context, Today, a day-list calendar,
appointment detail, the check-in → start service → complete sequence, operational notes,
read-only customer profiles, and pet profiles with notes and safety information.

**Deliberately absent — not stubbed:** photo capture and upload, checkout and payment capture,
push delivery, customer messaging, and every configuration or administration screen. A control
that opens "coming soon" costs trust each time it is tapped.

Administration stays web-first by design: advanced reports, business settings, employee permission
management, large data tables, and the service catalog are desk work, and mirroring them on a phone
doubles the surface area for no workflow gain.

`apps/mobile/src/notifications/index.ts` is an integration boundary with no runtime wiring. The
backend has no device-token table or registration endpoint, so a push token acquired today would
have nowhere to go; the module documents exactly what the backend needs.

## What has and has not been verified

Development happened on Windows, which has no iOS toolchain and had no Android SDK or Java
installed, so the honest status is:

| | Status |
| --- | --- |
| Typecheck, lint, unit and component tests | **Validated** — 134 mobile tests |
| Bundling for iOS and Android | **Validated** — `expo export` succeeds for both |
| Backend contract | **Validated** against the real server by the database suite |
| Rendering on a simulator or device | **Not verified** |
| Layout, safe-area behaviour, Dynamic Type, haptics | **Not verified** |
| Behaviour against a live server from a device | **Not verified** |

`expo export` proves every module resolves and bundles for both targets. It does not prove the app
looks right. Human QA on real hardware is required before any release.

## App-store prerequisites

None of this is done, and no credentials or certificates exist.

- **Identifiers** — an iOS bundle identifier and an Android application ID, set in `app.config.ts`.
- **Signing** — an Apple Developer account with distribution certificate and provisioning profile;
  an Android upload keystore. Store the keystore and its password in a secret manager, never in the
  repository.
- **Assets** — app icon, adaptive icon, and splash screen at the required densities.
- **Permissions** — camera and photo-library usage descriptions once photo capture ships, and a
  notification permission prompt once push ships. Both stores reject vague purpose strings.
- **Privacy** — Apple privacy-nutrition answers and a Google Play data-safety form. The app handles
  customer contact details and pet medical information, so both must be declared accurately.
- **Store listing** — screenshots at required device sizes, description, category, support URL, and
  reachable terms and privacy-policy links.
- **Production configuration** — `EXPO_PUBLIC_PAWSH_API_URL` pointing at the production origin over
  HTTPS. Nothing under `extra` may contain a secret; it all ships inside the bundle.
