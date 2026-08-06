# Cross-platform CI policy

## Enforcement levels

Pawsh uses **proportionate validation for beta development; full exact-SHA
validation for beta release candidates and platform-sensitive changes**.

Executable beta-development SHAs retain every currently supported Ubuntu/Node
runtime and applicable PostgreSQL, migration, browser, security, backup/restore,
build, lint, typecheck, and test gates. Windows and macOS depend on credible
platform impact. Release-candidate promotion always requires the supported
matrix: Ubuntu Node 22/24, Windows Node 22/24, macOS Node 24, and UTC
canonicalization. macOS Node 22 is not currently claimed; adding it requires a
separate cost, maintenance, and compatibility-value decision.

Manual `workflow_dispatch` inputs select beta release-candidate validation or
force the full matrix. A nightly schedule (`08:23 UTC`) also forces the full
matrix during controlled-pilot hardening. Revisit weekly cadence after runner
reliability and compatibility history stabilize. Scheduled runs validate the
current `main` tip, not every intervening SHA, and never replace exact-SHA
release-candidate evidence.

## Classification and rollback

`scripts/classify-ci-change.mjs` invokes Git without a shell and parses
`git diff --name-status -z`. Pull requests compare the target merge base to the
head; pushes compare exact event `before` and `after` SHAs. Missing/all-zero
SHAs, unavailable history, failed Git operations, malformed controls, and
unknown paths force full coverage.

Classes are `documentation_only`, `ordinary_executable`,
`database_or_migration`, `browser_or_ui`, `platform_sensitive`,
`workflow_or_ci`, `dependency_change`, and `unknown_or_mixed`. Documentation is
governed by `AGENTS.md`. Workflow/action paths, dependencies and lockfiles,
scripts/tools, startup/bootstrap, processes, shells, browser launch, filesystem
and paths, environment propagation, native setup, service control, and
PostgreSQL provisioning force full coverage. Bounded Node source inspection is
an additional conservative signal; raw filenames never enter expressions.

`PAWSH_FORCE_FULL_MATRIX` is the increase-only rollback switch. Missing,
malformed, or `true` forces full coverage. After owners approve proportionate
beta use, set the trusted repository variable to exactly `false`. Removing it
restores always-full behavior without code changes. Manual dispatch may only
increase coverage.

## Aggregate, outages, and governance

The stable `Cross-Platform Runtime Compatibility — Required Matrix` job always
runs. It reports groups as **Required and passed**, **Not required under beta
impact policy**, **Required but infrastructure blocked**, or **Required and
failed**. The blocked label is used only when GitHub reports that unsuccessful
jobs had no steps, and it still leaves the aggregate failed. An authorized
alternative-evidence disposition is administrative, not a hosted pass; ordinary
CI does not recognize or self-authorize it.

For pre-execution failures, record SHA, run/job IDs, OS and runner image/version,
timestamp, stage, and error. Confirm repository execution never began. Permit
one immediate retry and optionally one later fresh-runner retry, then stop; do
not create empty commits or unrelated Pawsh changes.

Disposition evidence records enforcement level, classification, failed job,
alternative evidence, residual risk, approvers, timestamp, and follow-up.
Engineering/QA, Operations for infrastructure, and the launch approver must
accept it in protected release evidence or another established approval system.
A file in the same untrusted change cannot approve itself, and historical jobs
remain blocked rather than being relabeled passed.

Classification uses argument arrays, null-delimited paths, bounded reads, fixed
output tokens, least-privileged `contents: read`, and no `pull_request_target`.
Unknown input increases coverage. Summaries contain trusted enums/reasons, not
source content or filenames. No automated approval recognition is implemented.

The current GitHub plan does not enforce branch protection for this private
repository. Engineering policy intends the stable aggregate to become the
required compatibility authority when administrative rules are available; this
is not represented as current enforcement. If classification skips required
work, remove or set `PAWSH_FORCE_FULL_MATRIX=true`, retain the aggregate name,
record the defect, and repair classification before enabling selection again.

SHA `a89c8f8f715279c32f24333e6600f01505eb29b9` remains **Exact-SHA Validation
Partial — Node 24 Runner Provisioning Blocked** under its historical policy. Its
platform-sensitive change required Windows under either policy; only a hosted
pass or separately authorized disposition can close it.

## Cost and open items

Ordinary non-platform beta changes avoid Windows, macOS, and UTC jobs while
retaining Ubuntu 22/24. This reduces runner use and unrelated queue blockers;
exact savings depend on change mix and are not assumed. Classification is one
short Ubuntu checkout/Node step. Nightly full runs cost one complete matrix per
day and provide timely drift detection.

Open administrative items are approval/storage authority for alternative
evidence, branch-protection consolidation, the nightly-to-weekly transition,
and any future macOS Node 22 support decision.
