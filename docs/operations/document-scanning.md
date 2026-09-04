# Document scanning operations (retired for MVP)

The managed document scanner, quarantine queue, retries, dead letters, and
scanner monitoring were superseded for MVP by [ADR-010](../decisions/ADR-010-rabies-supporting-attachments.md).

New rabies supporting attachments use authenticated same-tenant authorization,
Pet Care permissions, a 10 MiB PDF-only allowlist, PDF signature/EOF sanity
checks, generated private storage keys, audit records, and authorized
attachment downloads with `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff`.

Historical scanner rows and unsafe states are retained for audit compatibility.
Pending, rejected, quarantined, retry, and dead-letter documents are not
promoted or downloadable. Only explicitly approved historical current records
remain available. No runtime health, worker, or release gate depends on those
historical rows.

ADR-005's managed scanner is superseded and is not required. Rebuilding it is
not what this document asks for.

**Its removal leaves residual risk that an allowed PDF may contain undetected
malicious content, and that risk is tracked as `SEC-DOC-001`, which is OPEN and
blocking for the controlled pilot.** Retiring the scanner design did not close
the finding — a superseded implementation design is not a closed security
finding — and ADR-010 is not closure evidence for it. `SEC-DOC-001` closes on
staging evidence for the current attachment control, as release governance
requires, plus an explicit recorded closure by Security and the launch approver.
See [the finding register](../architecture/scale-readiness.md).

Expanding attachment types or scope requires a new security decision.
