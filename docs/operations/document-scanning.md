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

Managed scanning remains a post-MVP deployment-hardening candidate. Its
removal leaves residual risk that an allowed PDF may contain undetected
malicious content; expanding attachment types or scope requires a new security
decision.
