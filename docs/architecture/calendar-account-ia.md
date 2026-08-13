# Calendar and account information architecture

The global application header owns the authenticated user control. Its menu
links to the canonical Profile & Account surface, focuses the existing secure
password-change form, and signs out through the existing session-revocation
endpoint. Pawsh does not currently implement referral invitations, so “Invite
a friend” is a disabled roadmap affordance rather than a workspace invitation.
Workspace membership continues to use the explicitly named administrative
invitation and access-request flows.

Multi-location switching remains deferred. Pawsh currently enforces one active
location per business and does not have a server-authorized location-selection
context. The disabled menu affordance must not become client-side switching;
the architecture gate in `multi-location-decision.md` remains authoritative.

Calendar navigation has two independent dimensions:

- `displayMode`: `agenda` or `calendar`
- `calendarView`: `day`, `week`, or `month`

Agenda is a chronological projection of the same bounded, tenant-authorized
appointment range. Calendar subviews share selected date, groomer filter,
business hours, appointment transformation, and booking operations. The main
toolbar owns period navigation; there is no persistent mini month navigator.

Selecting an appointment loads the existing authorized customer-history API
and presents customer, pet, and appointment context together. Full customer
profile and existing appointment operations remain separate shared workflows;
the calendar does not introduce a second customer or appointment data model.

## Appointment presentation

Agenda, Week, Day, Month hover details, and calendar accessibility labels use a
single browser-side appointment presentation model derived from the bounded
appointment response. The response includes the pet breed alongside its
existing snapshot, staffing, status, and safety fields. No card or hover action
performs a data request. Calendar blocks remain sized by the authoritative
appointment start/end interval and progressively reveal content as duration
allows; Agenda groups the same models into dense date sections. Clicking any
representation continues through the authorized customer-context workflow.
