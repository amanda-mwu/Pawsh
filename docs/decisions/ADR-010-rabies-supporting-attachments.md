# ADR-010: Rabies supporting attachments for MVP

Status: Accepted for MVP; supersedes the runtime portions of ADR-005.

Structured rabies data, explicit staff verification, and appointment-date
evaluation remain the compliance authority. An uploaded file is optional
supporting evidence and never verifies rabies status or changes verification.

MVP uploads are authenticated, tenant- and permission-authorized, limited to
PDF, bounded to 10 MiB, checked for PDF signature/EOF sanity, assigned an
immutable generated storage key, stored privately, and returned only through
authorized attachment downloads with `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff`. Files are not rendered or executed.

The asynchronous scanner, quarantine queue, retries, dead letters, scanner
health monitoring, and managed scanner configuration are deferred post-MVP.
The application does not instantiate or enqueue scanner work. Historical
scanner-era rows remain for audit compatibility; pending, rejected,
quarantined, retry, and dead-letter files are not promoted or made available.
Only previously approved current/superseded clean records remain retrievable.

Residual risk: a permitted PDF may contain malicious content not detected by
these controls. This risk is accepted for the narrow MVP attachment scope and
must be revisited before expanding document support or deployment hardening.
