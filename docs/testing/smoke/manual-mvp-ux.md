# Manual MVP UX workflow

Run this package locally and on staging with the guarded manual QA tenant. The
tester should receive the outcome below, not click-by-click coaching. Record
each task as **PASS**, **FRICTION**, or **BLOCKED**, plus elapsed time and every
moment of uncertainty such as “Did that save?” or “Which pet is this?”

## Core tasks

1. **Receptionist booking:** “Emma Johnson calls to schedule Charlie for a Full
   Groom with Grace next Monday morning.” The tester should find Emma and
   Charlie, see only Emma's pets, understand service/employee choices, handle a
   conflict, save, and relocate the appointment without help. Target: 90 seconds.
2. **Groomer:** “Rocky has arrived. Review what you need to know, start the
   appointment, add a service note, and complete the groom.” The handling warning
   must be hard to miss, context and state clear, and finance/admin distractions
   absent. Targets: check-in 20 seconds, start 15, complete 20.
3. **Checkout:** “Charlie is complete. Apply a $5 authorized discount, add a $15
   tip, take cash payment, and provide a receipt.” At 8.25% tax the total is
   $101.60. Amounts, progress, paid state, duplicate protection, and receipt must
   be clear. Target: 90 seconds.
4. **Owner access:** “Allow Riley to take payments, but do not allow reports or
   business settings.” Labels must be business-friendly, customizable, and
   clearly separate protected ownership. Target: 60 seconds.

Also time customer search (20 seconds) and customer-plus-pet creation (2
minutes).

## Daily and multi-user scenarios

Run the 08:45–10:40 salon sequence: Riley logs in and checks Charlie in; Grace
starts service; Daniel asks to move Rocky earlier; Emma books Charlie's next
visit; Rocky arrives with a handling warning; Charlie completes and Riley checks
out; Olivia changes Riley's access.

With Owner, Receptionist, and Groomer in separate browsers, verify permission
removal is authoritative on the next protected request, simultaneous slot
attempts leave one valid booking, stale appointment edits do not silently
overwrite, two checkout tabs cannot duplicate payment, employee deactivation
with future work is safe, and customer archival preserves history.

## Recovery, devices, and accessibility

Double-click appointment/state/payment mutations; refresh during appointment
edit and checkout; use Back after completion/payment; act from a stale page; and
simulate a safe API failure. Outcomes must not duplicate or corrupt data, and
retry guidance must be understandable.

Check current Chrome and Edge at 1920×1080 and 1366×768, a 768×1024 tablet, and
physical iPhone/Android browsers for login, calendar, appointment detail, safety,
service flow, and checkout. Verify keyboard order/focus, labels, error
association, dialog focus, non-color-only safety/status, and 200% zoom.

## Evaluation and defects

Evaluate discoverability, clarity, context, feedback, recovery, efficiency,
consistency, and trust.

- UX-P0: core workflow impossible or safety data inaccessible; launch blocked.
- UX-P1: serious wrong-record, safety, financial, or permission risk; launch
  blocked.
- UX-P2: meaningful friction with a workaround; review before broad pilot.
- UX-P3: low-risk polish.

Manual UX becomes **Valid** only after a human records execution evidence.
Physical-device and staging results must never be inferred from emulation or
documentation readiness.
