# Proposed decision: limited-pilot rabies policy

- **Status:** Proposed; non-effective
- **Approvers:** Product, Security, Privacy/Legal as applicable, launch approver
- **Existing authority:** `SEC-DOC-001`, ADR-005, and current validation require
  managed-scanner staging evidence while uploads remain available.

## Requested decision

> Authorized staff may enter and manually verify structured rabies information.
> Supporting PDFs are optional. A supporting file that has not passed an approved
> scanning process remains unavailable for normal download and cannot
> independently establish verified rabies status.

Product must confirm appointment-start-date evaluation and inclusive expiration.
Privacy/Legal must confirm the communication rule for rabies notices. Security
and the launch approver must separately decide whether a future mode disabling
all uploads could narrow the managed-scanner gate. No exception exists today.

Approval would keep manual operations usable during scanner outage while files
remain fail-closed. It would not rewrite ADR history or close `SEC-DOC-001`.
