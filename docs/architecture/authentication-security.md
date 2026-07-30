# Authentication and browser security

This document records the Batch C0 audit of the authentication and browser
security architecture. It is a description of the current implementation and
the decisions that constrain Batch C. A control is not classified as validated
until its corresponding automated tests and exact-HEAD CI closure pass.

## MVP policy decisions

- Pawsh is password-only for the MVP. MFA, passkeys, and TOTP are deferred.
- The product minimum is 8 Unicode code points. Batch C must not raise it.
- Password-setting flows must accept at least 64 Unicode code points. The
  application maximum will be 256 Unicode code points, with a separate bounded
  UTF-8 byte limit before expensive hashing.
- Spaces, symbols, and Unicode are allowed. There are no character-class
  composition requirements and no periodic password expiration.
- Passwords are never silently truncated.
- Common, compromised, trivial, repeated, and Pawsh-specific whole-password
  values are rejected through a deterministic provider abstraction. Passwords
  are not rejected merely because they contain a dictionary, person, family,
  or pet-name substring.
- CI does not call a live breach-password service. Any future production
  provider must use a privacy-preserving protocol with an explicit timeout and
  availability policy.
- Existing password verification semantics must remain compatible. Unicode
  normalization will not be introduced without a versioned legacy
  verification and rehash design.
- Password change and MFA are not current product features and are deferred
  rather than invented by Batch C.

The 8-code-point minimum is an explicit MVP product decision and a known
limitation of the final password-only classification.

## Route and control matrix

| Flow | Route/control | Current state | Batch C disposition |
| --- | --- | --- | --- |
| Signup | `POST /api/auth/signup` | Existing; creates a user, owner membership, location, fresh session, and audit event | Harden with the shared password policy and explicit hash parameters |
| Login | `POST /api/auth/login` | Existing; generic invalid-credential response and fresh session token | Verify enumeration behavior; add account and network abuse controls |
| Logout | `POST /api/auth/logout` | Existing; authenticated request revokes the current server session and clears the cookie | Existing Batch A/B coverage remains authoritative; use only as a prerequisite |
| Reset request | `POST /api/auth/password-reset/request` | Existing; generic accepted response, invalidates older tokens, stores only a token hash, and queues an encrypted email body; returns a development token outside production | Harden provider boundaries, leakage controls, throttling, and test-only token exposure |
| Reset completion | `POST /api/auth/password-reset/confirm` | Existing; validates an unused unexpired token, replaces the hash, consumes that token, and revokes active sessions | Apply shared policy; invalidate all outstanding tokens; verify concurrency and revocation |
| Invitation creation | `POST /api/members/invitations` | Existing; owner-only, hashed one-week token, audited | Preserve and verify token/session behavior |
| Invitation acceptance | `POST /api/auth/invitations/accept` | Existing; creates a new user or verifies an existing password, creates membership and fresh session | Apply policy only when a new password is being set; existing-user verification remains login semantics |
| Password change | None | Missing | Explicitly deferred for the MVP |
| Session introspection | `GET /api/me` | Existing; re-resolves active session, user, business, and membership on every request | Preserve as the browser authority boundary |
| Permission mutation | `PATCH /api/members/:id/permissions` | Existing; owner-only and audited | Add stale-client/two-context regression |
| Membership removal | `DELETE /api/members/:id` | Existing; owner-only, prevents last-owner removal, revokes the removed user's sessions | Preserve existing ownership coverage |
| Ownership transfer | `POST /api/business/transfer-ownership` | Existing and owner-only | Verify through existing authorization architecture; no new browser matrix |
| User disable/revoke | `POST /api/admin/users/:id/disable` | Existing platform-administrator control; disables the user and revokes sessions | Use an authoritative revocation mechanism for the stale-browser scenario |
| Protected business APIs | Route-specific authentication and permission prehandlers | Existing; session, active user, membership, business, tenant selection, and permission are evaluated server-side | Add representative revoked-session, stale-permission, and tenant browser integration coverage |
| Platform support | Platform authentication prehandler and `/api/admin/*` | Existing; requires active platform administrator and current session | Preserve; broad platform administration expansion is outside Batch C |
| MFA/passkeys | None | Missing | Deferred; record as a future owner/admin security capability |

## Session security audit

### Cookies and storage

The `pawsh_session` cookie is scoped to `/`, is `HttpOnly`, uses
`SameSite=Lax`, has a 14-day `Max-Age`, and is `Secure` in production. Logout
clears the cookie at the matching `/` path. The browser client does not store
authentication or session tokens in `localStorage` or `sessionStorage`.

The database stores a SHA-256 digest of a random 32-byte base64url token rather
than the bearer token. Authentication queries require an unrevoked,
unexpired session plus an active user, membership, and business. There is a
14-day absolute expiry and no separate idle timeout. Batch C records that
behavior rather than introducing an unreviewed idle-expiry policy.

Every signup, login, and invitation acceptance issues a new random session
token; no pre-authentication application session identifier is reused.
Password reset currently revokes every active user session. Permission checks
are resolved from the database on every protected request.

### Request integrity

Credentialed CORS is restricted to `APP_ORIGIN`. State-changing requests with
an `Origin` header are rejected when it differs from `APP_ORIGIN`. Requests
that omit `Origin` are currently accepted, so the origin hook and
`SameSite=Lax` cookie together do not constitute a complete independently
verified CSRF design. Batch C must:

1. classify which legitimate clients can omit `Origin`;
2. fail closed for browser mutation requests without an allowed origin, or add
   an explicit CSRF mechanism if non-browser clients require that path; and
3. add targeted request-integrity tests without treating CORS as authorization.

### Client reconciliation

The client refreshes `/api/me` during bootstrap, navigation, and visibility
changes. A failed `/api/me` bootstrap exposes only the authentication surface.
Generic API failures do not currently distinguish `401` from other errors, so
a protected action rejected after server-side revocation may leave stale UI
until another bootstrap occurs. C3 must make unauthorized responses reconcile
to one coherent unauthenticated state while preserving `403` permission
feedback without granting authority.

## Password and recovery audit

The current password-setting schemas use Zod `.min(12).max(200)`, which counts
JavaScript UTF-16 code units and conflicts with the explicit 8-code-point MVP
policy. The HTML password input also has `minlength="12"` and always declares
`autocomplete="new-password"`, including login mode. These are C1 gaps.

Passwords are stored using `@node-rs/argon2`, but routes currently rely on
library defaults. C1 must document and make the chosen Argon2id parameters
explicit, retain unique salts and the encoded hash format, and bound input
before hashing. There is no password truncation in the current route code.

Reset and invitation bearer tokens are generated with 32 random bytes and only
SHA-256 token digests are stored in their respective database tables. Reset
messages are encrypted at rest in notification intents. The reset token is
embedded in a query-string URL; C1 must add a reset-page referrer policy and
prove that token-bearing URLs and secret material are not logged. The
non-production reset response currently exposes `developmentToken`; C1 must
restrict any direct token-return mechanism to an explicit test boundary rather
than all non-production deployments.

## Abuse, enumeration, and telemetry audit

Login returns the same `401` message for a missing, disabled, or
wrong-password account. Reset requests return the same accepted response for
known and unknown email addresses, apart from internal work and the current
non-production development token.

The application retains a global Fastify limit of 120 requests per minute
outside tests and adds an in-process authentication protector keyed separately
by pseudonymous account and network references. Five failures for one account,
or 50 failures from one network source, in a 15-minute window begin bounded
exponential backoff at one second, capped at 60 seconds.
A successful login clears the account counter but does not let one valid
credential clear network abuse. Missing and disabled users perform the same
Argon2 verification work as a wrong password. Reset requests use the same
account/network mechanism and return the same accepted response before the
limit regardless of account existence.

Fastify's direct `request.ip` is authoritative because Pawsh does not currently
enable proxy trust. Deployment behind a reverse proxy must define trusted
proxy boundaries before forwarded addresses may affect security controls.
The in-memory limiter is appropriate to the single-instance MVP; a
multi-instance deployment requires a shared atomic store before classification
can be carried forward.

Business audit events are tenant-scoped and remain separate from
pre-authentication security telemetry. Authentication telemetry is emitted as
structured operational log events with HMAC-derived 24-hex account and network
references. It records event type and pseudonymous references only. Production
operations retain these events for 30 days with access limited to operators;
the application itself does not create an unbounded telemetry table.
Passwords, password-derived material, reset URLs/tokens, session tokens,
cookies, authorization headers, raw email addresses, and raw IP addresses are
not event fields. Logger redaction also covers credential and token request
fields as defense in depth.

## Authorization and tenant coverage

Current authentication reloads membership permissions on every request.
Server-side route prehandlers enforce named permissions, and database tenant
context plus row policies provide defense in depth. Existing Chromium smoke
already proves a representative permission denial/grant and a cross-tenant
customer, pet, appointment, and invoice matrix.

C3 therefore adds only genuinely new browser risks:

- authoritative session revocation while a browser retains stale UI;
- permission revocation using simultaneous owner and employee contexts,
  including `403`, no side effect, and client reconciliation;
- one representative browser-cookie tenant-boundary attempt selected after
  reviewing the existing matrix; and
- desktop Chromium versus one narrow iPhone WebKit permission-visibility
  parity check.

The responsive application uses one semantic navigation DOM rather than
separate desktop and mobile action trees, so a three-device permission matrix
would be redundant.

## Deferred capabilities and limitations

- Authenticated password change is deferred.
- MFA, WebAuthn/passkeys, and TOTP are deferred.
- Idle session timeout is not introduced in Batch C without a separate product
  decision; the current absolute expiry remains 14 days.
- A live breached-password provider is not required for the MVP or CI.
- Broad platform-support, device, staging, and manual security validation remain
  outside Batch C.
