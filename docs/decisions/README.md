# Decision records

The architecture decision records for Pawsh. One row per record, with the status
line each record carries at its own head. Where the two ever disagree, the record
itself is authoritative and this table is the stale copy.

| Record | Subject | Status |
|---|---|---|
| [ADR-001](ADR-001-modular-monolith.md) | Modular monolith | Accepted |
| [ADR-002](ADR-002-tenant-and-authorization-model.md) | Tenant and authorization model | Accepted; the per-membership permission array is superseded by 0041/0042 |
| [ADR-003](ADR-003-scheduling-and-commerce-invariants.md) | Scheduling and commerce invariants | Accepted |
| [ADR-004](ADR-004-pet-care-document-storage.md) | Pet Care document storage and request recovery | Accepted for D3.2 implementation |
| [ADR-005](ADR-005-document-malware-protection.md) | Fail-closed Pet Care document malware scanning | Superseded by ADR-010 for MVP; retained as historical security evidence |
| [ADR-010](ADR-010-rabies-supporting-attachments.md) | Rabies supporting attachments for MVP | Accepted for MVP; supersedes the runtime portions of ADR-005. Its acceptance of the residual malware risk is **not** a closure of `SEC-DOC-001` — see below |
| [ADR-011](ADR-011-appointment-ticket-and-receipt.md) | The appointment Ticket, the invoice and the receipt | Amended 2026-09-03; the unification of the Ticket and the receipt is overruled by Product, and the overruled record is retained in full below the amendment |
| [ADR-012](ADR-012-appointment-detail-footer-capabilities.md) | Ready for Pickup, the waiting list, appointment confirmation, and Contact | Proposed; not built |

Alongside the numbered records:

| Document | Subject | Status |
|---|---|---|
| [proposed-rabies-limited-pilot-policy](proposed-rabies-limited-pilot-policy.md) | Limited-pilot rabies policy | Proposed; non-effective |

## There is no ADR-006, ADR-007, ADR-008 or ADR-009

They were never written. They are not lost, not moved, not archived elsewhere and
not held in a branch: `git log --all --diff-filter=AD` over those four numbers
returns nothing, so no such file has ever existed in this repository's history.
The sequence simply skips from 005 to 010. Why those four numbers were left
unused is not recorded anywhere, and nothing in the repository establishes it.

This paragraph exists so that the next reader who notices the gap can stop here
instead of searching for four documents that were never created.

## An accepted ADR is not a closed security finding

ADR-010 records that the residual malware risk of its attachment model "is
accepted for the narrow MVP attachment scope". That sentence stands unedited and
describes a decision that was really made. It is an **architectural decision
statement, not a governance closure event**, and it must not be read as one.

The distinction generalises beyond this record and is why it is written here
rather than only in the finding:

- An **ADR** records what the team chose to build and what it chose to live
  with. Accepting a risk in an ADR means the architecture was selected with that
  risk in view.
- A **security finding** is closed by release governance — named approvers,
  against named evidence, recorded as a closure. Nothing an ADR says performs
  that act.

Applied to this case: ADR-010 accepts the residual risk of the replacement
architecture and supersedes ADR-005's runtime design. It does not itself close
`SEC-DOC-001`. `SEC-DOC-001` remains open until the required staging evidence is
produced and explicit governance closure occurs. The authoritative status of the
finding is in
[Scale readiness](../architecture/scale-readiness.md), never in an ADR.

Neither ADR-005 nor ADR-010 is edited to record this. Amending an accepted or
superseded record to track a later governance ruling would destroy the thing
those records exist to preserve.

## Conventions

- A record's status line is the first thing after its title.
- The statuses in use are **Accepted** (optionally narrowed to a phase, as in
  "Accepted for MVP"), **Proposed**, **Superseded by** another record, and
  **Amended**, which is used when a record's conclusion is overruled but its
  reasoning is worth keeping.
- An amended or superseded record keeps its original text. ADR-005 keeps it by
  reference and ADR-011 keeps it inline; neither is edited in place, because a
  decision record that is rewritten to match the present cannot show how the
  product got here.
- A record numbered but unbuilt is **Proposed**, whatever its own text once said.
- A record may accept a risk. It may not close a finding. Where a record's
  acceptance and a finding's status appear to conflict, the finding register
  governs the finding and the record governs the architecture; neither overrides
  the other, because they answer different questions.
  Accepting a record does not build it, and a status of Accepted on an unbuilt
  record misreports the repository to everyone who reads it afterwards.
