# QA coverage registry

The authoritative validation target is the current repository `HEAD`. Resolve it
with `git rev-parse HEAD`; a classification is current only when the required CI
jobs pass for that exact SHA. GitHub Actions run links are retained in release
validation records and the final closure report rather than hard-coded here,
because any registry edit creates a new SHA.

| Classification | Required CI job | Browser/profile | Tags | Known limitations |
| --- | --- | --- | --- | --- |
| MVP Runtime Valid | Backend and PostgreSQL runtime | PostgreSQL 17 / Node runtime | Database and runtime suites | Does not validate deployed infrastructure |
| Automated GUI Smoke Valid | Browser / chromium-smoke | Desktop Chromium | `@smoke` | Primary browser only |
| Browser Security Smoke Valid | Browser / chromium-smoke | Desktop Chromium | `@smoke` security scenarios | Expanded stale-session and permission coverage pending |
| Automated Cross-Browser Core Valid | Browser / `*-cross-browser` | Desktop Chromium, Firefox, WebKit | `@cross-browser` | Deliberately small compatibility subset |
| Automated Responsive Interface Valid — Playwright Device-Profile Emulation | Responsive / device project | iPhone WebKit, Android Chromium, iPad WebKit profiles | `@responsive`, with reserved `@mobile-core` / `@tablet-core` mappings | Physical-device behavior remains unvalidated |

## Responsive tag mapping

| Tag | iPhone WebKit | Android Chromium | iPad WebKit |
| --- | --- | --- | --- |
| `@responsive` | Yes | Yes | Yes |
| `@mobile-core` | Yes | Yes | No |
| `@tablet-core` | No | No | Yes |
