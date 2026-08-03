# Pet Care document scanning operations

## Contract and ownership

Engineering owns the worker and queue. Security owns scanner policy and dead-letter review. Normal users cannot list or download `pending_scan` or `rejected` documents. Operators must not directly change scan rows or promote documents with SQL.

The initial pilot policy is three attempts with 15/30/60-second exponential boundaries, a five-minute queue-age warning, and immediate warning on rejection or dead letter. A dead letter must be acknowledged by Engineering within the approved pilot support window. The upload UI reports a pending scan for up to 60 seconds and then tells the user to check again; the durable request-status endpoint remains authoritative.

## Signals and response

- `document_scan_queue_unhealthy`: inspect pending count, oldest age, scanner availability, worker health, and dead letters.
- `document_scan_result`: inspect retry/rejection counts and correlated application logs.
- `OBJECT_IDENTITY_MISMATCH`: stop promotion, preserve evidence, investigate storage integrity.
- `MALWARE_SIMULATED` or provider malicious verdict: retain the rejected object privately, deny user access, and follow the approved security review procedure.
- `SCAN_DEAD_LETTER`: verify provider health and credentials, preserve the last-known-good record, communicate that the replacement did not take effect, and resolve under the incident severity policy.

No scanner failure permits promotion. Do not manually mark a request complete, rewrite an attempt, expose a quarantine object URL, or delete the last-known-good record.

## Retention and reconciliation

Rejected and dead-letter objects are retained through the controlled pilot unless Security approves a shorter incident-safe period. This is intentionally conservative and must be revisited before GA. Existing reconciliation removes only abandoned pre-scan `pending` uploads; it must not remove queued `pending_scan` objects. Request identities retain the existing seven-day terminal-request policy. Scan attempts remain part of the document security audit record.

## Staging closure

P4 must validate the real adapter, least-privilege access, harmless malicious test, signature/version reporting, timeouts, provider outages, queue alerts, dead-letter response, object privacy, and recovery. Repository evidence does not close `SEC-DOC-001`.
