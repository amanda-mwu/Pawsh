# Proposed decision: limited-pilot rabies policy

- **Status:** Proposed; non-effective
- **Approvers:** Product, Security, Privacy/Legal as applicable, launch approver
- **Existing authority:** `SEC-DOC-001` is **open** and blocking for the
  controlled pilot while uploads remain available. It closes on staging evidence
  for the current attachment control, as release governance requires, plus an
  explicit recorded closure. ADR-010 accepts the residual risk of the
  replacement architecture and supersedes ADR-005's runtime design, which is
  **not** required; neither act closes the finding, because a superseded design
  is not a closed finding and an accepted risk is not one either. The finding is
  open against the control that replaced the scanner.

## Requested decision

> Authorized staff may enter and manually verify structured rabies information.
> Supporting PDFs are optional. A supporting file that has not passed an approved
> scanning process remains unavailable for normal download and cannot
> independently establish verified rabies status.

Product must confirm appointment-start-date evaluation and inclusive expiration.
Privacy/Legal must confirm the communication rule for rabies notices. Security
and the launch approver must separately decide whether a future mode disabling
all uploads could narrow the attachment-safety gate. No exception exists today.

Approval would keep manual operations usable during scanner outage while files
remain fail-closed. It would not rewrite ADR history or close `SEC-DOC-001`,
which only staging evidence plus an explicit recorded closure can do.
