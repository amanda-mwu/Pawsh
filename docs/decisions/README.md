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
| [ADR-010](ADR-010-rabies-supporting-attachments.md) | Rabies supporting attachments for MVP | Accepted for MVP; supersedes the runtime portions of ADR-005 |
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
  Accepting a record does not build it, and a status of Accepted on an unbuilt
  record misreports the repository to everyone who reads it afterwards.
