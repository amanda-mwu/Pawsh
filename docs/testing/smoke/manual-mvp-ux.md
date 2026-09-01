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
# Rabies expiration and breed autocomplete

- Enter only a rabies expiration date, save, reload, and verify persistence.
- Create appointments before, on, and after expiration; verify only the after-expiration appointment warns.
- Verify customer and staff notices, renew beyond the appointment, and verify the warning resolves.
- Attach a PDF and confirm the attachment does not modify expiration or compliance state.
- Create and edit a pet using partial, keyboard-only, touch, Mixed Breed, Unknown, and Other selections.
- Save and reload a selected breed; retain an existing non-catalog breed without alteration.

# Services tier pricing and tenant breed catalog

- Confirm Services is a primary navigation destination and there is no second service editor in Salon.
- As an owner, review and edit the Bath + Brush and Groom + Style six-tier pricing matrices; verify an ordinary staff member can use but cannot mutate pricing.
- Book a 45 lb Boxer for Bath + Brush and verify Smooth Single, 41–60 lb, and $75 are shown before saving.
- Book a 45 lb Goldendoodle for Groom + Style and verify Extra Floof, 41–60 lb, and $145 are shown before saving.
- Use an unknown breed and verify Standard pricing; remove weight and verify pricing remains unresolved with the explicit weight-required message.
- Change pet or service before finalization and verify the preview recalculates; edit current pricing after checkout and verify the historical invoice and receipt do not change.
- In Salon, open Salon sections and select Breed catalog. Confirm `/salon/breeds` loads with Salon as the only active primary navigation item, including after refresh.
- Open Settings and confirm workspace access and global business settings are administrative, while Profile & account remains in the user identity menu.
- Confirm Reports and Overview contain no Breed Catalog entry, and `/reports/breeds` redirects to `/salon/breeds` without displaying the Reports shell.
- In Breed Catalog, add, rename, reclassify, deactivate, and reactivate a breed; verify inactive breeds disappear from new autocomplete choices while historical pet values remain visible.
- Exercise breed autocomplete with keyboard and touch at mobile width, including Mixed Breed, Unknown, Other, and an existing non-catalog value.

# Operational directory and weekly calendar

- Open Services directly from primary navigation, edit an existing duration and tier cell, and confirm booking still resolves the server price and existing snapshots remain unchanged.
- With the 500-customer scale fixture, search by customer, pet, phone, email, and breed; page forward/back; sort by customer, last visit, and next appointment; and filter active/upcoming records.
- Open a customer row and confirm contact details, compact pets, rabies/safety information, and on-demand history remain distinct and usable.
- Verify the customer table remains dense on desktop and collapses secondary columns into a row-to-detail workflow on phone and tablet widths.
- In Calendar, switch between Week and Day, use Today, previous/next period, previous/next month, and a month date; confirm the selected date and navigation remain synchronized.
- Verify Week remains date-oriented and Day shows a left time axis with one horizontally scrollable column per active groomer.
- Verify configured business hours, empty slots, closed periods, sticky headers/time labels, duration-scaled appointments, overlaps, visibly bounded lifecycle controls, and groomer filtering.
- Confirm deficient rabies information appears as the compact, non-interactive `Rabies needed` warning.
- Click a Week slot and confirm the booking form receives its local date/time. Click a Day slot and confirm it also receives the groomer from that column, including exposed empty space beside a visual appointment; open and move an appointment by clicking its visible card controls.

# Tax and payments, and the Square Terminal integration

This feature splits into a part a tester can exercise on a local machine and a part
that cannot exist without a Square account. Record the first part as **PASS**,
**FRICTION**, or **BLOCKED** as usual. Record every item in the second part as
**BLOCKED — Square Sandbox required**, and never as PASS or FAIL: an unconfigured
Pawsh cannot produce the state those flows operate on, so there is nothing to judge.

## Reachable now, with no Square credentials

- Open Settings and then Tax & payments. Confirm the workspace opens on Method and
  that Tax and Card processors are reachable, that each tab states which scope it
  changes, and that a tab with nothing in it explains what belongs there rather than
  showing an empty frame. Confirm no copy anywhere on the screen claims Pawsh has no
  processor connection, no OAuth flow, or no credential store.
- On Method, create a payment method, edit it, reorder it against its neighbours,
  disable and re-enable it, and delete one that allows deletion. Confirm a built-in
  method offers editing but neither renaming nor deletion, that the list order and
  enabled state survive a reload, that no duplicate or ghost row appears after a
  failed or repeated save, and that a rejected value explains what to do instead.
- On Tax, create and edit a rate, then put a different rate in force. Confirm exactly
  one rate is ever in force, that the rate in force cannot be deleted while it holds
  that position, and that correcting the rate in force is described as a different act
  from correcting one standing by. Open Business settings and confirm the tax field
  there is read-only, points at this workspace, and shows the same number.
- On Card processors, configure processing fees and default tip presets for a
  processor and confirm both survive a reload.
- Check tip arithmetic against a worked example: on a checkout whose services subtotal
  is $100.00 with a $5.00 authorized discount, a 20% preset must offer $19.00, because
  presets are taken from the services subtotal after the discount and never from the
  taxed total. Confirm the preset amount shown matches the amount that lands on the
  invoice.
- Take a checkout to completion with a salon-configured method that is not a card
  terminal. Confirm the checkout opens once, that double-clicking or repeatedly
  activating Complete neither opens a second checkout nor rebuilds the open one
  underneath a tester who is already typing into it, and that the finished or failed
  state says plainly which it is. This is the reachable half of the duplicate-activation
  protection.
- With a dialog open, end the session by the usual local means and then trigger any
  authenticated action. Confirm every open dialog closes, the login screen is reachable
  and operable rather than sitting behind a modal, and nothing keeps polling in the
  background afterwards.
- Name a payment method or tax rate with a double quote in it, such as `Dog "Premium"`.
  Confirm the name renders exactly as typed everywhere it appears, that the row's
  buttons keep working, and that nothing in the page gains an attribute or behaviour the
  name should not have been able to give it.
- Open the Square surface on Card processors with no Square credentials configured.
  Confirm the screen says Square is unavailable and names the configuration that is
  missing, that it offers no Connect or Pair control that looks usable, that nothing
  crashes or returns a raw error, and that no token, secret, or key appears anywhere on
  screen or in the browser console.

## Blocked until a Square sandbox account exists

Each of these needs a real Square connection before any of its state can exist. Record
them as **BLOCKED — Square Sandbox required**.

- The terminal drawer's device controls — Get a code, Check pairing, Pair again, and
  Remove. The drawer only lists Square devices for a connected processor, so with no
  connection the controls never render and there is nothing to operate.
- The capture dialog's close and Escape guard during a live payment. That dialog opens
  only from a terminal checkout that has actually started.
- The OAuth connect, callback, and scheduled token refresh.
- Terminal device pairing, including the pairing code and its expiry.
- A real Terminal checkout, its tip, and its receipt.
- Refunds against a provider-backed payment, including the tip-last split.
- The needs-review state as produced by real Square responses rather than by a fixture.
- The recovery sweep judged against actual Square state.
- Webhook delivery, redelivery, and signature verification from Square's own signer.
- Square's real idempotency and retry behaviour, including whether a replayed request
  returns the original result and for how long.
