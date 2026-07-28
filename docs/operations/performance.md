# Performance budgets

MVP server targets under normal pilot load:

- Seven-day calendar, up to 500 appointments: p95 under 1 second.
- Customer or pet search, up to 10,000 active records: p95 under 500 milliseconds.
- Appointment creation: p95 under 1 second, excluding network latency.
- Checkout and manual payment recording: p95 under 1 second.
- Initial application shell on a typical broadband connection: usable within 2.5 seconds.

These are service objectives, not claims of measured production performance. Calendar, customer lookup, appointment, invoice, and outbox access paths are indexed. Add caching only after production measurements identify a bottleneck.
