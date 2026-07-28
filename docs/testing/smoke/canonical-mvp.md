# Canonical MVP smoke flow

1. Sign up an Owner and create the business/location.
2. Add an employee and service.
3. Add a customer and pet with a safety alert.
4. Create an appointment and verify it appears in the calendar.
5. Verify an overlapping appointment is rejected and an adjacent appointment is accepted.
6. Check in, start service, record notes, and complete.
7. Create the invoice, record an external payment, and retrieve the receipt/history.
8. Verify invalid state transitions, cross-tenant identifiers, and missing permissions are rejected.
9. Verify audit and outbox records exist and notification retries do not create duplicate intents.
10. Sign out and verify the session no longer authorizes requests.
