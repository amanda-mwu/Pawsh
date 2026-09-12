# Appointment surface — human QA findings, 11 September 2026

Findings from the human QA pass on `eeb9256` (the appointment workflow seam). Each item records
what was observed, whether it reproduces, and the cause where one was established. Nothing here is
fixed; this is the queue for the next seam.

The environment was `pawsh_qa` on port 3000. Reproduction was done by driving the real surface in a
browser against that data, so "reproduces" below means observed, not inferred.

**One thing to know before reading section A.** The QA walk checked Charlie 12:30 in at step 11, then
continued making section A observations against it. Charlie was `checked_in` by then, not
`scheduled`, which explains one of the two A-findings outright. Fixture statuses at the end of the
pass: Charlie 12:30 `checked_in`, Boba 15:30 `cancelled`, Rocky 10:45 `completed`.

## The one defect that explains the most

**A disabled control can win the footer's dominant slot, and then the footer reads as though the real
action is missing.**

`primarySlot` ranks checkout → check-in → complete → invoice → ticket → close. Ready for Pickup is
deliberately never primary, because on a checked-in visit the money outranks it. But a role without
`checkout.perform` has no money action, so nothing claims the slot and it falls through to `close` —
which makes **Save** primary. Save ships disabled until the note is dirty. So Grace opening a
checked-in visit gets a disabled blue Save as the loudest thing on screen, with Ready for Pickup
beside it in the quieter tinted rank.

Observed, as Grace, on Bruno 08:00:

```
lead=[appointment-ready, appointment-save[DISABLED][PRIMARY]]   utility=[appointment-ticket]
```

Ready for Pickup **is** rendered and **is** enabled. The reported symptom — "only options is to
save, no ready for pick up and no take payment button seen" — is this hierarchy inversion. Take
Payment is correctly absent: a Groomer holds no `checkout.perform`.

The same shape produces the Daisy finding: `lead=[appointment-invoice[DISABLED][PRIMARY]]`, a
disabled Invoice as the dominant control because Grace holds no `payments.view`.

Two rules fall out of this and neither is in the code yet:

- **A disabled control must never hold the dominant slot.** If the ranking lands on one, the slot
  passes to the next actionable control.
- **Ready for Pickup should take the slot when there is no money action**, rather than being
  permanently outranked by a rule written for the case where money exists.

## A. Scheduled appointment — Charlie 12:30

| # | Finding | Status |
|---|---|---|
| A1 | Cannot add or edit the **duration** of a service | Confirmed — not built. `appointment_services.duration_minutes_snapshot` is written from the catalog and there is no route that edits it. Note this is the *scheduling* duration, which sets `end_at`; ADR-013 covers billable time, which is a different number. Editing scheduled duration is its own decision. |
| A2 | No pencil beside the groomer name | **Does not reproduce on a scheduled visit** — pencil present. It is absent on `checked_in`, which is what was being looked at. `moveOffered` is `scheduled`-only and the server agrees: `POST /schedule` refuses any other status. The real question is a product one: should the groomer or time be correctable after check-in? |
| A3 | The pencil icon is inverted | Confirmed. The glyph's contrast against the new `.icon-action` background needs the same treatment the colour-picker tick got. |
| A4 | Rabies bubble in Adjust services is large, off-centre and strange; minimise it | Confirmed. `safetyContext()` is interpolated into the shared modal and was never laid out for it. |
| A5 | Pet info — behaviour, rabies, hair length — wraps badly and is not readable | Confirmed. Same block, same cause. |

## C. Checked-in footer — Bruno 08:00

| # | Finding | Status |
|---|---|---|
| C1 | Cannot edit the service note; the only option is to add a note | **Functionally works, visually fails.** The textarea is present and editable (`svcBox=true`), and Save wakes when it differs from the stored value. What is missing is any affordance saying so: the Appointment note block has a named **Add**/**Edit** button on its heading, the Service note block has a bare heading and a box that does not read as a field. QA saw the one labelled control and concluded it was the only one. The two notes behave in opposite ways inside one card. |

## D. Grace — Bruno 08:00 and Daisy 09:00

| # | Finding | Status |
|---|---|---|
| D1 | No Ready for Pickup, no Take Payment | Ready for Pickup is present and enabled — see the dominant-slot defect above. Take Payment absent is correct. |
| D2 | Cannot click Invoice on Daisy | Reproduces, and is currently by design: Invoice is drawn disabled with a title naming `payments.view`, which the Groomer preset does not hold. **Product decision needed:** should a groomer be able to read the invoice for a visit they performed? |
| D3 | A groomer should see the client record beside the appointment | Reproduces. The rail states "Client records are not part of this role." The Groomer preset holds no `customers.view`. **Product decision needed** — this is a permission-preset change, which the last seam was explicitly told not to make. |

## E. In-service — Luna 09:30

| # | Finding | Status |
|---|---|---|
| E1 | Complete is blue but there is no Save | **Save is present**, disabled until the note changes: `lead=[appointment-save[DISABLED], appointment-complete[PRIMARY]]`. A disabled control with no stated reason reads as absent. Either say why it is asleep, or only draw it once there is something to save. |
| E2 | A completed and paid visit should still offer Ask for Review, View Invoice and Save | View Invoice is offered. **Ask for Review does not exist** — there is no messaging capability in Pawsh, and the standing rule is to draw an unbuilt control disabled with a reason rather than omit it. Save on a completed visit would need the service-note window widened past `in_service`, which the `/operations` route currently enforces. Both are product decisions. |

## H. Print

| # | Finding | Status |
|---|---|---|
| H1 | There should still be a print button top right, beside the confirmed/unconfirmed toggle | This reverses part of the last seam: the header print icon was removed as a duplicate of the footer's Ticket button, because both ran the same closure under the same `runOnce` key. The request is for it back, in a specific place. Restoring it means accepting two routes to one document, or giving the header control a different job. |
| H2 | The footer Print should open the Ticket preview with its own Print and Close | Already true — the control is labelled **Print Ticket** and opens exactly that. |

## J. Terminal states

| # | Finding | Status |
|---|---|---|
| J1 | No way to reopen a cancelled appointment | A cancelled appointment **does open and read** (`lead=[]`, `utility=[Print Ticket, Close]`), so access is not the problem. What does not exist is any way to **un-cancel** it: `canTransition` gives `cancelled` and `no_show` no outgoing edges at all, deliberately. Restoring a called-off visit is a new capability and a lifecycle decision. |

## K. Density

| # | Finding | Status |
|---|---|---|
| K1 | The appointment view is good; the **calendar** buttons are too bulky | Confirmed as scope not yet touched. The last two seams were explicitly scoped away from the calendar. The likely cause is the same one found on the appointment footer: `.compact` sets padding and font-size but never `min-height`, so every `.compact` control is full height. It appears on about 112 controls across the calendar, Check Out, the Invoice, the Ticket and Settings, which is why it was left alone rather than changed globally. |

## Suggested order for the next seam

1. The dominant-slot defect — one ranking change, explains D1 and D2's symptom and is the most
   misleading thing on the surface.
2. The Service note affordance (C1) and the asleep-Save legibility (E1) — both are "the control is
   there and says nothing".
3. The pencil glyph contrast (A3) and the safety-context layout (A4, A5).
4. `.compact` and the calendar's control density (K1) — one decision, wide blast radius.
5. The product decisions, which need answers before they can be built: groomer access to the client
   record and to invoices (D2, D3), correcting groomer or time after check-in (A2), editing scheduled
   service duration (A1), restoring a cancelled visit (J1), the header print control (H1), and Ask
   for Review (E2).
