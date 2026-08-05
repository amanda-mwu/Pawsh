# Controlled-pilot execution plan and gate matrix

Pawsh is in controlled-pilot hardening. This matrix inventories evidence; it
does not replace the Master Release Gate or authorize launch.

| Gate | Requirement/evidence authority | Missing evidence | Technical status | Human/external requirement | Blocking |
|---|---|---|---|---|---|
| BASE-AUTO | Critical regression validation | None technical | Complete -- automated evidence sufficient | None | No technical blocker |
| CAL-TIME | Calendar/time integrity | None technical | Complete -- automated evidence sufficient | None | No technical blocker |
| REPLAY | Scheduling/financial replay | None technical | Complete -- automated evidence sufficient | None | No technical blocker |
| RABIES | Compliance contract and suites | Manual workflow evidence | Complete -- technical evidence ready, human approval pending | Product/Privacy decision, manual UX | Yes for human approval |
| P1-APP | ADR-005/P1 scanner contract | Formal decision | Complete -- technical evidence ready, human approval pending | Security review | Yes |
| SEC-DOC-001 | Managed scanner in staging | Real integration, alerts, harmless test | Open -- external infrastructure | Security/Ops | Yes |
| SEC-DB-001 | Schema-owner/RLS finding | Approved disposition | Open -- human approval | Engineering/Security/launch approver | Existing authority decides |
| P2-A11Y | WCAG pilot workflows | Manual AT matrix and final automation | Open -- human execution | Accessibility approver | Yes |
| P3-PERF | Pre-staging characterization | Approved envelope and run | Open -- approval then automatable | Product approval | P5 controls launch |
| P4-STAGE | Infrastructure/security/restore/alerts | Production-like evidence | Open -- external infrastructure | Operations/Security | Yes |
| P5-PERF | Staging load/degradation/recovery | Real topology and thresholds | Open -- external infrastructure | Operations/Product | Yes |
| P6-MANUAL | Versioned workflows | Execution evidence | Open -- human execution | QA | Yes |
| P7-DEVICE | Real device/Safari matrix | Physical evidence | Open -- human execution | QA | Yes |
| BACKUP | Backup/restore/migrations | Staging restore | Complete -- automated evidence sufficient locally/CI | Operations at P4 | Yes at staging gate |
| OPS | Monitoring/runbooks/suspension | Owners and alert delivery tests | Open -- human/external | Operations/launch approver | Yes |
| GOV | Pilot envelope and launch decision | Approver, thresholds, approvals | Open -- human approval | Product/Security/Ops/Privacy | Yes |

No gate is superseded by a recommendation.

## Automated evidence closure

Executable SHA `2207573173206635fbf27e85127d9c737fb86d37` passed the complete
[CI run](https://github.com/amanda-mwu/Pawsh/actions/runs/31025733364) and
[cross-platform runtime run](https://github.com/amanda-mwu/Pawsh/actions/runs/31025732921)
on 2026-08-05. Evidence includes Node 22/24 PostgreSQL runtime, migrations,
backup/restore, unit and API integration, tenant and authorization regression,
scheduling/replay, invoice/payment, outbox, scanner contract, Chromium/Firefox/
WebKit, responsive emulation, security projects, accessibility automation, and
the new rabies-compliance browser scenario. This does not satisfy physical-device,
manual assistive-technology, managed-scanner staging, operational-alert, or
formal approval gates.

## Human handoff checklists

For every check record preconditions, action, expected result, evidence, pass or
fail, severity, notes, role/device/AT versions, release SHA, and whether it was
completed without developer assistance.

### Manual UX

As receptionist, groomer, and owner/admin: create customer/pet; enter and verify
rabies without PDF; book beyond expiration; inspect customer queue/staff warning;
renew and observe resolution; reschedule valid-to-invalid and back; optionally
upload PDF and prove pending is not verified; check in, service, checkout, manual
payment, receipt, reports, and employee-access changes.

### Physical devices

On iPhone Safari, Android Chrome, and tablet Safari/Chrome verify touch, keyboard,
rotation, manual entry, warning visibility, rescheduling, and receipt. Record
keyboard obstruction, unreachable control, unsafe reflow, or targets below 44px.

### Accessibility

Verify keyboard-only completion, screen-reader labels/status, focus order and
restoration, associated errors, modal behavior, 200% zoom, 400% reflow, and
non-color warning comprehension.

### Security and launch

Review tenant denial, verification authority/actor, audit, timezone evaluation,
material uniqueness, staff identity, suppression, quarantine/download denial,
scanner evidence and limitation, proposed policy, and residual risks. The launch
packet must separate technical gates, human work, approvals, and infrastructure,
including `SEC-DOC-001`, `SEC-DB-001`, staging, accessibility, device QA,
monitoring, recovery, thresholds, and this non-effective proposal. Codex does not
make the launch decision.
