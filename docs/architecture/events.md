# Events and engagement

Meaningful business operations write durable outbox events atomically with the source change. Processing creates unique notification intents. Delivery workers use the intent ID as a stable idempotency key and record every attempt.

This provides effectively-once behavior; external delivery is not claimed to be mathematically exactly once. Provider failure never rolls back an appointment. Appointment cancellation suppresses pending reminders and creates a cancellation intent.
