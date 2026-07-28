# Events and engagement

Meaningful business operations write durable outbox events atomically with the source change. Processing creates unique notification intents. Delivery workers use the intent ID as a stable idempotency key and record every attempt.

This provides effectively-once behavior; external delivery is not claimed to be mathematically exactly once. Provider failure never rolls back an appointment. Appointment cancellation suppresses pending reminders and creates a cancellation intent.

Workers atomically claim outbox and notification rows with `FOR UPDATE SKIP LOCKED` before external work. Stale sending claims become retryable after ten minutes and reuse the stable notification ID as the provider idempotency identity.

Production email is delivered through the SMTP adapter. Password-reset message
bodies are encrypted at rest with AES-256-GCM using a fresh 96-bit nonce and a
128-bit authentication tag. The Base64URL payload is serialized as
`nonce || tag || ciphertext`; decoding requires canonical serialization and any
authenticated-byte change is rejected. The database stores only a hash of the
reset token itself.
