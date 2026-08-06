# Pawsh Codex operating instructions

## Documentation-only CI policy

Validation must be proportional to the final diff.

This policy applies when the final diff contains only documentation or other
non-executable files, including Markdown, ADRs, roadmaps, plans, design and
architecture documents, release notes, README files, and comments that cannot
affect runtime behavior.

It does not apply when any final change includes application code, tests,
migrations, package or lock files, workflow files, executable or runtime
configuration, generated artifacts, security-policy enforcement, release-gate
logic, deployment configuration, infrastructure code, or Dockerfiles.

### Proportionate local validation

For a documentation-only change:

1. Record the current branch and exact starting HEAD, and confirm the worktree
   and index are clean.
2. Make the documentation changes.
3. Verify the complete final diff is documentation-only.
4. Run `git diff --check`.
5. Verify all new internal links and referenced repository paths exist.
6. Run repository-provided documentation or policy checks when available.
7. Run lint or type checking only when repository policy requires it for
   documentation changes or the documentation affects typed or generated
   artifacts.
8. Commit and push once local validation passes, then record the exact final
   HEAD.

Do not introduce a documentation toolchain solely to validate a documentation
change.

### Proportionate CI validation

For documentation-only work:

- Inspect GitHub Actions for the exact final SHA.
- Wait for applicable required checks to complete.
- Do not require arbitrary repeated polling cycles or repeatedly rerun unchanged
  checks.
- If a documentation-related check fails, inspect it, correct the documentation,
  push the correction once, and validate the new exact SHA.
- If an unrelated repository-wide check fails because of a pre-existing issue or
  CI infrastructure, inspect enough evidence to classify it and report it
  separately. Do not enter a repeated fix-and-rerun loop unless the documentation
  change caused the failure.
- Never rely on an earlier green SHA or report success while applicable checks
  for the final SHA remain pending or failing.

### Full CI escalation

Use the normal full engineering validation and exact-SHA CI closure process when
the final diff contains any executable change, including application code,
tests, migrations, package or lock files, workflows, Dockerfiles, deployment or
runtime configuration, infrastructure, generated artifacts, security-policy
changes, or release-gate logic.

Documentation-only changes receive documentation-level validation. Executable
changes receive full engineering validation. Do not apply runtime validation to
a Markdown-only diff merely because runtime checks exist elsewhere in the
repository.

## Cross-platform CI proportionality

For executable beta-development changes, preserve validation on every currently
supported Ubuntu/Node runtime. Require the full supported operating-system
matrix when behavior is platform-sensitive, classification is unknown or mixed,
workflows or dependencies change, or a trusted reviewer forces full coverage.
Paths are conservative signals; behavioral risk may only increase coverage.

Beta release-candidate promotion requires the complete supported matrix for the
exact candidate SHA regardless of classification. Scheduled full-matrix runs
supplement but never replace release-candidate evidence. A skipped conditional
platform job means **Not required under beta impact policy**, never passed.

Use `Cross-Platform Runtime Compatibility — Required Matrix` as the stable
engineering summary. Hosted-runner failures before checkout permit at most one
immediate and one later same-SHA retry and never justify empty commits or
unrelated changes. Alternative evidence requires external authorization from
Engineering/QA, Operations when applicable, and the launch approver; Codex and
CI cannot self-approve it.

`PAWSH_FORCE_FULL_MATRIX` is the increase-only rollback control. Missing,
malformed, or `true` values force full coverage; only the trusted repository
value `false` enables proportionate beta-development selection. See
`docs/testing/cross-platform-ci-policy.md`.
