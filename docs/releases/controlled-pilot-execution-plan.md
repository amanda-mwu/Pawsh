# Controlled-pilot execution plan and gate matrix

Pawsh is in controlled-pilot hardening. This matrix inventories evidence; it
does not replace the Master Release Gate or authorize launch.

| Gate | Requirement/evidence authority | Missing evidence | Technical status | Human/external requirement | Blocking |
|---|---|---|---|---|---|
| BASE-AUTO | Critical regression validation | Final exact-SHA CI | Open -- automatable | None | Yes |
| CAL-TIME | Calendar/time integrity | Final exact-SHA evidence | Open -- automatable | None | Yes |
| REPLAY | Scheduling/financial replay | Final exact-SHA evidence | Open -- automatable | None | Yes |
| RABIES | Compliance contract and suites | Manual workflow evidence | Technical evidence in progress | Product/Privacy decision, manual UX | Yes for this scope |
| P1-APP | ADR-005/P1 scanner contract | Final exact-SHA regression | Automated evidence ready after green CI | Security review | Yes |
| SEC-DOC-001 | Managed scanner in staging | Real integration, alerts, harmless test | Open -- external infrastructure | Security/Ops | Yes |
| SEC-DB-001 | Schema-owner/RLS finding | Approved disposition | Open -- human approval | Engineering/Security/launch approver | Existing authority decides |
| P2-A11Y | WCAG pilot workflows | Manual AT matrix and final automation | Open -- human execution | Accessibility approver | Yes |
| P3-PERF | Pre-staging characterization | Approved envelope and run | Open -- approval then automatable | Product approval | P5 controls launch |
| P4-STAGE | Infrastructure/security/restore/alerts | Production-like evidence | Open -- external infrastructure | Operations/Security | Yes |
| P5-PERF | Staging load/degradation/recovery | Real topology and thresholds | Open -- external infrastructure | Operations/Product | Yes |
| P6-MANUAL | Versioned workflows | Execution evidence | Open -- human execution | QA | Yes |
| P7-DEVICE | Real device/Safari matrix | Physical evidence | Open -- human execution | QA | Yes |
| BACKUP | Backup/restore/migrations | Final SHA and staging restore | Open -- automatable plus staging | Operations at P4 | Yes |
| OPS | Monitoring/runbooks/suspension | Owners and alert delivery tests | Open -- human/external | Operations/launch approver | Yes |
| GOV | Pilot envelope and launch decision | Approver, thresholds, approvals | Open -- human approval | Product/Security/Ops/Privacy | Yes |

No gate is superseded by a recommendation.

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
