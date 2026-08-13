# Calendar and navigation ownership

Pawsh uses a compact primary navigation rail for daily destinations: Dashboard,
Calendar, Clients, Messages, Reminders, Sales & Expense, Product, Report, and
Settings. Services and Salon remain available as operational destinations below
a visual divider because neither capability has another safe owner.

Messages and Product are navigation-readiness placeholders. Reminders explains
the existing automated reminder boundary without exposing an unsupported inbox.
Sales & Expense preserves existing checkout/report access and does not imply an
expense ledger.

The Calendar shell owns one selected date, one view (`month`, `week`, or `day`),
and one selected-groomer set. All views use the same appointment state,
authorization projection, appointment card, action popover, business hours, and
booking modal:

- Month loads only its 42 visible cells using requests that respect the existing
  31-day API bound and shows at most three compact summaries per day.
- Week shows seven days divided into lanes for the selected active groomers.
- Day shows the time axis and one column per selected active groomer.

The groomer selection is a browser-local display preference, namespaced by
workspace. Saved identifiers are always intersected with the current
server-authorized active employee list. It never grants employee or appointment
access. Empty selection is valid and produces an explicit empty state.

Messaging, expense tracking, and inventory remain deferred product domains. No
schema, API, delivery, accounting, or inventory behavior was introduced for
their placeholders.
