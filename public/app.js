// The one thing this file does NOT re-implement. `money.js` is served beside it and holds the
// browser's copy of the domain's `formatMinor`, so the web has a single definition of how an
// amount of money is written down and a test can load exactly the code the browser runs.
import { formatMinor, currencySymbolFor } from "./money.js";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const inviteToken = new URLSearchParams(location.search).get("invite");
const resetToken = new URLSearchParams(location.search).get("reset");
/**
 * Everything this session has fetched, in one object.
 *
 * BUILT BY A FACTORY, so that ending a session can put it back the way it started. A hand-written
 * list of fields to clear falls behind the next field somebody adds, and almost every field here
 * holds rows belonging to one business - clients, pets, the breed catalog, the calendar's month.
 */
function emptyState() {
  return { me: null, customers: [], customerDirectory:{items:[],total:0,page:1,pageSize:20}, pets: [], dogBreeds: [], petTypes: [], breedsByType:{}, employees: [], services: [], appointments: [], businessHours:[], calendar:{selectedDate:null,weekStart:null,month:null,monthAppointments:[],selectedGroomerIds:null,pendingGroomerIds:null,filterInitialized:false,displayMode:"calendar",view:"week",bookingPreset:null,bookingGroomerId:null,bookingCustomerId:null,bookingPetId:null,opened:false,preferences:null}, clientProfile:null,clientProfileReturnView:"customers", messageClientId:null, reportMode:"charts",reminders:{type:"appointment_reminder",items:[],supported:true}, members: [], accessRequests:[], workspaces:[], locations: [], reports: null, login: false };
}
const state = emptyState();
const pendingActions = new Set();
/* ---------------------------------------------------------------------------
   BUSINESS-SCOPED CACHES, AND THE ONE PLACE THAT EMPTIES THEM.

   A browser tab outlives a session. Sign out at the front desk, sign in as a different salon, and
   every module singleton registered below is still holding the previous salon's rows - so
   `ensureCheckoutPaymentOptions` short-circuits on a cache it filled for somebody else and the new
   operator is shown another business's payment methods and discounts. THAT IS TENANT DATA
   EXPOSURE, not a stale screen. The only reason it was survivable elsewhere is that switching
   workspace through the profile picker does a full `location.reload()` and therefore throws the
   whole heap away; signing out and signing back in never leaves the page.

   Each cache is declared through `tenantCache`, which keeps its BUILDER rather than a copy of its
   fields. Resetting rebuilds from that builder, so a field added to a cache tomorrow is cleared
   without anybody remembering to add it to a list - which is the failure mode this replaces.

   Register here only what belongs to ONE BUSINESS. Application constants, DOM handles, one-time
   listener guards and preferences already keyed by account and business id stay out: clearing
   those either costs the operator something they were right to keep, or double-binds a listener.
   --------------------------------------------------------------------------- */
const tenantCaches = [];
function tenantCache(build) {
  const cache = build();
  tenantCaches.push({ cache, build });
  return cache;
}
/**
 * Forgets everything the previous session fetched, before the next one renders.
 *
 * Called from `settleUnauthenticated` (sign-out, a 401, any session that ended) and from the top
 * of `bootstrap` (sign-in, and every re-entry into the authenticated shell). Two call sites rather
 * than one because the two events are not the same: a session can end without another beginning,
 * and - through an invitation accepted in a tab that was already signed in - another can begin
 * without the first having visibly ended.
 *
 * `state.login` SURVIVES. It is which half of the auth form is on screen, not tenant data, and
 * resetting it would flip somebody who just signed out back to "Create your salon".
 */
function resetTenantState() {
  // Before `terminalCapture` is rebuilt, or the handle to the running poll goes with it and the
  // poll goes on 401ing against a session that has ended.
  stopTerminalCapturePoll();
  const login = state.login;
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, emptyState(), { login });
  for (const entry of tenantCaches) {
    for (const key of Object.keys(entry.cache)) delete entry.cache[key];
    Object.assign(entry.cache, entry.build());
  }
  // The three that are not registered plain objects. `businessState` goes through the Business
  // workspace's own reset rather than a builder, because that function is already the authority on
  // what an untouched Business screen looks like.
  resetBusinessWorkspace();
  petCoatColors = [];
  dismissedAgreementBanners.clear();
}
let customerSearchSequence = 0;
let calendarDetailOrigin = null;

// A navigation or reload aborts every request still in flight. Firefox and WebKit report the
// resulting rejection as a page error ("NetworkError when attempting to fetch resource" /
// "TypeError: Load failed") while Chromium stays silent, which is why it only ever failed the
// cross-browser jobs. Firefox does not dispatch `unhandledrejection` during teardown, so the
// rejection can only be intercepted where the request is made.
let unloading = false;
for (const event of ["pagehide","beforeunload"]) globalThis.addEventListener(event,()=>{unloading=true;});
function isAbortedRequest(reason) {
  if (!reason) return false;
  if (reason.name === "AbortError") return true;
  return /load failed|failed to fetch|networkerror when attempting to fetch/i.test(String(reason.message||reason));
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !(options.body instanceof FormData)) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers
  }).catch((error) => {
    // A request the document abandoned on its way out has no result and no meaningful error, so it
    // simply never completes. That leaves its callers suspended for the instant the document still
    // exists, which keeps the rejection from escaping the loads that are deliberately not awaited.
    // A failure outside teardown still propagates to the caller untouched.
    if (unloading && isAbortedRequest(error)) return new Promise(() => {});
    throw error;
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) settleUnauthenticated();
    if (response.status === 403) await reconcilePermissions();
    const error = new Error(result.error || "Something went wrong");
    error.status = response.status;
    error.data = result;
    throw error;
  }
  return result;
}

function settleUnauthenticated() {
  // A rejected sign-in is a 401 as well, and it arrives here on its way to the error message. Only
  // a session that actually ended empties the form: a wrong password has to leave the address the
  // person just typed in place, or correcting it would mean retyping both fields.
  const sessionEnded=state.me!==null||!$("#app-view").hidden;
  // EVERY BUSINESS-SCOPED CACHE, not just `state.me`. See `resetTenantState`: signing out and
  // signing in again is the one route between two businesses that does not reload the page, so
  // anything this session fetched has to be dropped here or the next session inherits it.
  resetTenantState();
  closeLocationMenu();
  $("#app-view").hidden=true;
  $("#auth-view").hidden=false;
  // Every open dialog, not just #modal. A dialog opened with showModal() makes the rest of the
  // document inert, so a terminal capture still on screen when the session lapses sits on top of
  // the login form and blocks it outright - and its poll would go on 401ing every couple of
  // seconds behind it. Closing them all is also what keeps a new sign-in from landing behind a
  // dialog belonging to the session that just ended. close() is called directly rather than
  // through the capture dialog's own guard: this is teardown, and there is nobody to ask. The
  // terminal poll behind such a dialog was already stopped by `resetTenantState` above.
  $$("dialog").forEach((dialog) => { if (dialog.open) dialog.close(); });
  // The appointment stack's bookkeeping goes with its dialogs. Closing them directly leaves the
  // levels behind, and the next sign-in would find a stack claiming to be open over an empty
  // screen - and the first Escape would try to pop a level whose dialog is already shut.
  appointmentStack.levels.length=0;
  clientSummaryRail=null;
  receiptHost=null;
  if (sessionEnded) resetAuthForm();
}

/**
 * Returns the sign-in screen to the state a stranger should find it in.
 *
 * A salon's front desk is a shared machine, so the address the last person signed in with must not
 * be sitting in the box for whoever walks up next. The markup asks the browser not to offer it
 * back (`autocomplete="off"` on the email and salon-name fields); this covers the other half,
 * because every route back to sign-in - the account menu, a lapsed session, a 401 reconciled
 * mid-request - swaps the view rather than loading a page, so the fields keep whatever they last
 * held. It hangs off settleUnauthenticated for that reason, rather than off the button.
 */
function resetAuthForm() {
  const form=$("#auth-form");
  form.reset();
  // reset() restores each field's default, which is empty here, but a value the browser filled in
  // is not reliably a default it gives back. Blanking them outright is what was actually asked for,
  // and it covers the salon-name field signup uses as well as the two credentials.
  $$("#auth-form input").forEach((input)=>{input.value="";});
  $("#auth-error").textContent="";
  // Focus has to move whether or not it saves a click: it was last on something inside the shell
  // that is now hidden, and leaving it there strands keyboard and screen-reader users. The first
  // field still on offer is both the safe landing place and the one they are about to type into -
  // the email field in every case except the invitation and reset screens, where it is hidden.
  $$("#auth-form input").find((input)=>!input.closest("label").hidden)?.focus();
}

async function reconcilePermissions() {
  const response=await fetch("/api/me",{credentials:"include"});
  if (response.status===401) return settleUnauthenticated();
  if (!response.ok) return;
  state.me=await response.json();
  applyPermissions();
  renderAppointments();
}

/**
 * How a client is named on screen when the record is only partly filled in.
 *
 * An enquiry taken over the phone may have a number and nothing else. The database stores that
 * as null rather than a placeholder, so the fallback lives here, in the one place that decides
 * how absence reads. `${first} ${last}` interpolation would have produced "undefined undefined".
 */
function clientName(record, fallback = "Not set") {
  if (!record) return fallback;
  const name = [record.firstName, record.lastName].filter(Boolean).join(" ").trim();
  return name || fallback;
}

/** The same, for a pet whose name was never given. */
function petName(record, fallback = "Unnamed pet") {
  const name = String(record?.name ?? record?.petName ?? "").trim();
  return name || fallback;
}

// The currency this workspace bills in, read once so every formatter agrees on the fallback.
function businessCurrency(){return state.me?.business?.currency||"USD";}
/**
 * An integer minor-unit amount, written the way this workspace spells money.
 *
 * DELEGATES TO THE DOMAIN'S POLICY rather than restating it. `formatMinor` pins two fraction
 * digits; left to itself `Intl` follows CLDR's display convention and rounds fifteen supported
 * currencies to whole units, which is how the same invoice came to read "COP 100" in the browser
 * and "COP 99.99" on the phone. See `public/money.js` for the whole of it.
 *
 * Presentation only. The value handed in is the exact integer the server sent and nothing here
 * rounds, totals or otherwise touches it.
 */
function money(value = 0) {
  return formatMinor(value, businessCurrency());
}
// Money that carries a direction. The sign is rendered as a prefix rather than handed to
// Intl.NumberFormat, whose negative form is a hyphen in en-US and parentheses elsewhere - a
// ledger has to read the same way in every currency the workspace can be set to.
// U+2212 MINUS SIGN, matching the checkout disclosure's `−${money(...)}` summary value.
function signedMoney(minor){return `${Number(minor)<0?"−":"+"}${money(Math.abs(Number(minor)))}`;}
// Invoice statuses, in the operator's words. Mirrors `invoiceStatusLabels` in
// packages/domain/src/enums.ts, which is the source of truth; this is the browser's copy because
// app.js is served as a plain module with no bundler and cannot import from the workspace package.
//
// `partially_refunded` and `refunded` replace `paid` and only `paid`. An invoice that still owes
// money never reaches either - it stays open or partially paid - so nothing here has to reason
// about a refunded invoice that is also collectable.
const INVOICE_STATUS_LABELS={draft:"Draft",open:"Open",partially_paid:"Partially paid",paid:"Paid",partially_refunded:"Partly refunded",refunded:"Refunded",void:"Void"};
function invoiceStatusLabel(status){return INVOICE_STATUS_LABELS[status]||String(status||"").replaceAll("_"," ");}
// Payment methods, in the operator's words. Mirrors `paymentMethodLabels` in
// packages/domain/src/enums.ts, which is the source of truth; this is the browser's copy for the
// same reason INVOICE_STATUS_LABELS is one. Without it a receipt prints the raw column, which
// reads as lowercase `client credit` on the one method that has no configured row to name it.
const PAYMENT_METHOD_LABELS={cash:"Cash",external_card:"Card",check:"Check",other:"Other",client_credit:"Client credit"};
function paymentMethodLabel(method){return PAYMENT_METHOD_LABELS[method]||String(method||"").replaceAll("_"," ");}
// Money that went back. Neither paid nor unpaid: calling it Paid hides the most important thing
// that happened to the visit, and calling it Unpaid sends somebody to chase money the customer
// already returned.
function invoiceRefunded(status){return status==="refunded"||status==="partially_refunded";}
/* ---------------------------------------------------------------------------
   TICKET, INVOICE, PAYMENT, RECEIPT - FOUR DOCUMENTS, AND ONLY ONE OF THEM IS EVIDENCE.

     Ticket   the CRM document for the visit: who, which pet, which services, what to do.
     Invoice  a financial obligation. It exists the moment the visit is billed and it can owe
              money for as long as nobody pays it.
     Payment  a settlement against an invoice.
     Receipt  EVIDENCE OF A RECORDED PAYMENT.

   The printable financial page was titled `Receipt #1042` and its button offered from the moment
   an invoice existed, so a client could be handed "Receipt #1042 / Balance $135.60 / No payment
   recorded". That artifact is an Invoice, and calling it a Receipt is a claim about money that
   nobody made.

   The two predicates below are the ONE definition of which document is on screen, asked in the two
   forms the client has it available: off the receipt payload, which carries the payment rows, and
   off an invoice status alone, which is all a history row has. THE MONEY STATEMENT ITSELF IS
   SHARED - `receiptBodyMarkup` renders both - because shared financial authority is required.
   Shared document IDENTITY is not, and that is what these decide.
   --------------------------------------------------------------------------- */
// A payment is 'recorded' or 'voided' (`payment_status`, migrations/0001_initial.sql). A voided
// record settled nothing, so an invoice whose only payment was voided is an Invoice again. A
// refunded payment is still a recorded settlement - the money moved twice, and the receipt shows
// both movements - so a refund does not take the Receipt away.
function receiptHasPayment(receipt){
  return (receipt?.payments||[]).some(payment=>payment.status==="recorded");
}
// The same question of a row that carries only `invoices.status`. `open` and `draft` are the two
// that owe everything and have collected nothing; a void invoice never collected either.
const INVOICE_STATUSES_WITH_PAYMENT=new Set(["partially_paid","paid","partially_refunded","refunded"]);
function invoiceStatusHasPayment(status){return INVOICE_STATUSES_WITH_PAYMENT.has(String(status||""));}
// What the printable financial page is called, and it is never "Receipt" without a payment behind
// it. The number is the invoice number in both cases: an Invoice and the Receipt that eventually
// evidences it are the same obligation, and renumbering them would break every reconciliation.
function financialDocumentTitle(receipt){
  return `${receiptHasPayment(receipt)?"Receipt":"Invoice"} #${receipt.invoice.invoiceNumber}`;
}
function toast(message) {
  $("#toast").textContent = message; $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 2200);
}

// Loads fired from click handlers are deliberately not awaited, so a rejection has nowhere to go and
// escapes as an unhandled rejection. Route those through runDetached so the failure reaches the user
// as a toast instead.
function runDetached(task){Promise.resolve().then(task).catch(error=>toast(error.message));}
function escape(value = "") {
  const el = document.createElement("span"); el.textContent = value; return el.innerHTML;
}
// `escape()` serializes a text node, and a text node keeps its quotes: correct between tags, wrong
// inside a quoted attribute, where a `"` in tenant-typed text closes the attribute early and turns
// whatever follows into markup. Anything interpolated into an attribute value goes through this.
// The output stays safe between tags too, because a browser decodes these entities back to the
// characters they stand for when it parses the text.
function escapeAttr(value = "") {
  return escape(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function normalizeBreedFilter(value){return String(value).trim().toLowerCase().replace(/[\s\-_]+/g," ").replace(/[^a-z0-9 ]/g,"");}
function allowed(permission) {
  return Boolean(state.me?.isOwner || state.me?.permissions?.includes(permission));
}
// The Dashboard nav button had no gate at all while the data behind it was gated on reports.view,
// so a member without that permission opened a dashboard of four zeroes. The gate is `dashboard.view`,
// which only exists once the roles backend is serving this workspace - and until then no role can
// grant it, so applying it early would hide Dashboard from every member instead of the right ones.
// `/api/me` carrying a `role` field is the signal that the roles backend has landed.
function rolesBackendPresent(){return Boolean(state.me)&&"role" in state.me;}
// activateView refuses a view whose nav button is hidden, so a landing view this session may not
// open would leave the shell blank. Dashboard is the default landing and is now gated, so there
// has to be somewhere else to land: the first destination this session actually has.
function firstPermittedView(){
  return $$("#primary-navigation [data-view]").find(button=>!button.hidden)?.dataset.view||null;
}
/**
 * The dashboard's one gate, consulted by the nav button AND by the prefetch that fills it.
 *
 * `GET /api/dashboard` requires `dashboard.view` - migration 0043 split it off `reports.view`
 * deliberately, so a receptionist can see the day's takings without being given the reports. The
 * prefetch asked for `reports.view` instead, which handed exactly that role a visible Dashboard
 * button over an empty screen. A VISIBLE DESTINATION HAS TO BE A LOADABLE ONE, and the way to
 * guarantee that is for one predicate to decide both - never by widening the permission until the
 * mismatch stops showing.
 */
function canViewDashboard(){return rolesBackendPresent()?allowed("dashboard.view"):true;}
function applyDashboardNavGate(){
  const dashboard=$('[data-testid="nav-dashboard"]');
  if(!dashboard)return;
  if(rolesBackendPresent())dashboard.dataset.permission="dashboard.view";
  else{delete dashboard.dataset.permission;dashboard.hidden=false;}
}
function applyPermissions() {
  applyDashboardNavGate();
  $$("[data-permission]").forEach((element) => {
    const permitted=allowed(element.dataset.permission);
    if(!permitted||!element.classList.contains("view"))element.hidden=!permitted;
  });
  $$("[data-any-permission]").forEach((element) => {
    element.hidden = !element.dataset.anyPermission.split(",").some(allowed);
  });
  syncNewActionAvailability();
}
function accountAccessLabel(){return state.me?.isOwner?"Owner":"Workspace member";}
function renderAccountIdentity(){
  if(!state.me?.account)return;
  const name=state.me.account.displayName||state.me.account.email;
  $("#account-name").textContent=name;
  $("#account-role").textContent=`${accountAccessLabel()} · ${state.me.business.name}`;
  $("#account-avatar").textContent=Array.from(name.trim())[0]?.toUpperCase()||"P";
  $("#profile-form").elements.displayName.value=state.me.account.displayName;
  $("#profile-form").elements.email.value=state.me.account.email;
  $("#profile-workspace").textContent=state.me.business.name;
  $("#profile-role").textContent=accountAccessLabel();
  const switcher=$("#workspace-switcher"),workspaceSelect=$("#profile-workspace-select");
  switcher.hidden=state.workspaces.length<2;
  workspaceSelect.innerHTML=state.workspaces.map(workspace=>`<option value="${workspace.id}" ${workspace.current?"selected":""}>${escape(workspace.name)}</option>`).join("");
}
async function runOnce(key, operation) {
  if (pendingActions.has(key)) return;
  pendingActions.add(key);
  try { return await operation(); }
  finally { pendingActions.delete(key); }
}

async function financialMutation(path,operation,payload) {
  const identity=`pawsh-financial:${operation}:${path}:${JSON.stringify(payload)}`;
  const key=globalThis.sessionStorage.getItem(identity)||globalThis.crypto.randomUUID();
  globalThis.sessionStorage.setItem(identity,key);
  const result=await api(path,{method:"POST",headers:{"Idempotency-Key":key},body:JSON.stringify(payload)});
  globalThis.sessionStorage.removeItem(identity);
  return result;
}

// Settings, plus the one deep link that outlives the page it used to open. A legacy
// /salon/breeds-style URL selects Pet Options and opens the breed drawer on the first pet type,
// which is where that page's contents now live. Read the path BEFORE rendering:
// renderSettingsCategory rewrites it to /settings/pet-options.
function openSettingsForPath({history="replace"}={}){
  const breedDeepLink=legacyBreedPaths.has(location.pathname);
  renderSettingsCategory(settingsPathCategory(),{history});
  if(breedDeepLink)runDetached(async()=>{
    await loadPetTypes();
    const first=state.petTypes[0];
    if(first)await openBreedDrawer(first.id);
  });
}
async function bootstrap() {
  // BEFORE THE FIRST READ, not after it. This is the door every sign-in comes through, so a
  // session that replaces another - a different salon on the same shared machine - must not find
  // the previous one's clients, breeds, discounts or payment methods still cached behind it.
  resetTenantState();
  try {
    state.me = await api("/api/me");
    $("#salon-name")?.replaceChildren(state.me.business.name);
    renderAccountIdentity();
    applyPermissions();
    await refresh();
    $("#auth-view").hidden = true; $("#app-view").hidden = false;
    const initialView=viewForPath(location.pathname);if(initialView==="client-profile"){const customerId=location.pathname.match(/^\/clients\/([^/]+)$/)?.[1];if(customerId)await openClientProfile(customerId);else activateView("customers",{history:"replace"});}else{if(!activateView(initialView,{history:"replace"})){const fallback=firstPermittedView();if(fallback)activateView(fallback,{history:"replace"});}if(initialView==="admin-settings")openSettingsForPath({history:"replace"});}
  } catch { $("#auth-view").hidden = false; $("#app-view").hidden = true; }
}

async function refresh() {
  const allowed = new Set(state.me.permissions);
  const owner = state.me.isOwner;
  const safe = (permission) => owner || allowed.has(permission);
  const requests = [
    canViewDashboard() ? api("/api/dashboard") : {},
    safe("customers.view") ? api("/api/customers?paged=true&page=1&pageSize=20") : {items:[],total:0,page:1,pageSize:20},
    state.pets,
    api("/api/employees"), api("/api/services"),
    safe("appointments.view") ? api(`/api/appointments?localDate=${businessDate()}&days=8`) : [],
    safe("team.manage") ? api("/api/members") : [],
    safe("reports.view") ? api("/api/reports") : null,
    safe("pets.view") && !state.dogBreeds.length ? api("/api/dog-breeds") : state.dogBreeds,
    // The pet types breeds hang off. A breed belongs to exactly one type and the server refuses
    // one that does not match the pet's, so the editor has to know the taxonomy to scope by.
    safe("pets.view") && !state.petTypes.length ? api("/api/pet-types") : state.petTypes,
    safe("team.manage") ? api("/api/workspace-access-requests") : [],
    api("/api/workspaces"),
    loadLocations()
  ];
  const [dashboard, customerDirectory, pets, employees, services, appointments, members, reports, dogBreeds, petTypes, accessRequests, workspaces, locations] = await Promise.all(requests);
  Object.assign(state, { customerDirectory,customers:customerDirectory.items||[], pets, employees, services, appointments, members, reports, dogBreeds, petTypes, accessRequests, workspaces, locations });
  renderAccountIdentity();
  renderLocationSwitcher();
  reconcileGroomerFilter();
  if(!state.calendar.selectedDate){state.calendar.selectedDate=state.appointments[0]?appointmentLocalValue(state.appointments[0]).slice(0,10):businessDate();state.calendar.weekStart=weekStart(state.calendar.selectedDate);state.calendar.month=state.calendar.selectedDate.slice(0,7);}
  $("#today").textContent = new Intl.DateTimeFormat([], {timeZone:schedulingZone(),weekday:"long",month:"short",day:"numeric"}).format(new Date());
  applyPermissions();
  renderDashboard(dashboard); renderCustomersEnhanced(); renderRoles(); renderServices(); renderAppointments(); renderReports();
}

function schedulingZone(){return state.me?.business?.timezone||"UTC";}
// --- Dates and times in the shape the workspace chose ----------------------
//
// WHY THIS EXISTS. Every date and clock time this client drew went through `Intl.DateTimeFormat([])`
// - the empty locale list, meaning "whatever this browser is set to". Two operators sitting at the
// same front desk on differently-configured laptops read the same appointment as 09/02 and 02/09,
// and `Settings -> Business -> Date format` changed nothing at all. A preference that changes
// nothing is worse than no preference: the operator has been told the product does something it
// does not.
//
// WHY THE PATTERN IS ASSEMBLED RATHER THAN DELEGATED TO A LOCALE. The shortcut is to pass "en-GB"
// for DD/MM and "en-US" for MM/DD and let ICU lay it out. That couples the salon's choice to two
// locales' worth of unrelated decisions - separators, month names, whether a comma precedes the
// time, the space before PM - none of which the operator picked. So `Intl` is used ONLY to resolve
// an instant into numeric parts in the right time zone, which is real calendar arithmetic and the
// one thing it must be trusted for, and the layout happens here. This mirrors
// `src/domain/date-format.ts` deliberately: the server renders the report-card page, the
// report-card email and the appointment and rabies bodies, and one workspace must read the same
// in an email as it does on screen.
//
// A CALENDAR DATE IS NOT AN INSTANT. `vaccination_expires_on` and the scheduling `localDate` are
// `YYYY-MM-DD` strings. The old code anchored them at noon UTC purely to survive being formatted;
// `formatPrefLocalDate` reorders the three fields and goes nowhere near a time zone.
const PREF_WEEKDAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const PREF_SHORT_WEEKDAYS=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
function prefDateFormat(){return state.me?.business?.dateFormat==="DD/MM/YYYY"?"DD/MM/YYYY":"MM/DD/YYYY";}
function prefHourFormat(){return String(state.me?.business?.hourFormat)==="24"?"24":"12";}
function prefPad(value,width=2){return String(value).padStart(width,"0");}
// `weekday:"short"` is asked for as a name and mapped back to an index because `Intl` has no
// numeric weekday part; the English short names are the ones "en-US" is guaranteed to emit.
function prefParts(instant,zone){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:zone||schedulingZone(),calendar:"gregory",
    numberingSystem:"latn",hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",weekday:"short"}).formatToParts(instant);
  const value=type=>parts.find(part=>part.type===type)?.value||"";
  return {year:Number(value("year")),month:Number(value("month")),day:Number(value("day")),
    hour:Number(value("hour"))%24,minute:Number(value("minute")),
    weekday:Math.max(0,PREF_SHORT_WEEKDAYS.indexOf(value("weekday")))};
}
function prefLayOutDate(parts){
  const month=prefPad(parts.month),day=prefPad(parts.day),year=prefPad(parts.year,4);
  return prefDateFormat()==="DD/MM/YYYY"?`${day}/${month}/${year}`:`${month}/${day}/${year}`;
}
// Midnight and noon are the two the modulo gets wrong on its own: 0 and 12 both map to 12, and
// the meridiem does the distinguishing.
function prefLayOutTime(parts){
  const minute=prefPad(parts.minute);
  if(prefHourFormat()==="24")return `${prefPad(parts.hour)}:${minute}`;
  const hour=parts.hour%12===0?12:parts.hour%12;
  return `${hour}:${minute} ${parts.hour<12?"AM":"PM"}`;
}
/** "09/02/2026" / "02/09/2026". */
function formatPrefDate(instant,zone){return prefLayOutDate(prefParts(instant,zone));}
/** "3:30 PM" / "15:30". */
function formatPrefTime(instant,zone){return prefLayOutTime(prefParts(instant,zone));}
/** A wall clock with no instant behind it, for the calendar's time axis. */
function formatPrefClock(hour,minute){return prefLayOutTime({hour,minute});}
/** "09/02/2026 3:30 PM" - the numeric stamp, where a weekday would be noise. */
function formatPrefDateAndTime(instant,zone){
  const parts=prefParts(instant,zone);
  return `${prefLayOutDate(parts)} ${prefLayOutTime(parts)}`;
}
/** "Wednesday, 09/02/2026 at 3:30 PM" - the same line `formatPreferredDateTime` sends by email. */
function formatPrefDateTime(instant,zone){
  const parts=prefParts(instant,zone);
  return `${PREF_WEEKDAYS[parts.weekday]}, ${prefLayOutDate(parts)} at ${prefLayOutTime(parts)}`;
}
/** "Wed 3:30 PM". */
function formatPrefWeekdayTime(instant,zone){
  const parts=prefParts(instant,zone);
  return `${PREF_SHORT_WEEKDAYS[parts.weekday]} ${prefLayOutTime(parts)}`;
}
/** A `YYYY-MM-DD` reordered, without going near a time zone. */
function formatPrefLocalDate(localDate){
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(localDate??"").slice(0,10));
  if(!match)return String(localDate??"");
  const [,year,month,day]=match;
  return prefDateFormat()==="DD/MM/YYYY"?`${day}/${month}/${year}`:`${month}/${day}/${year}`;
}
/** "Wednesday, 09/02/2026" for a calendar date the operator is looking at. */
function formatPrefLocalWeekdayDate(localDate){
  const day=String(localDate??"").slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return formatPrefLocalDate(localDate);
  return `${PREF_WEEKDAYS[dateAt(day).getUTCDay()]}, ${formatPrefLocalDate(day)}`;
}
function wallParts(value=new Date()){
  return new Intl.DateTimeFormat("en-CA",{timeZone:schedulingZone(),hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).formatToParts(value);
}
function wallValue(value=new Date()){
  const p=wallParts(value),v=t=>p.find(x=>x.type===t).value;
  return `${v("year")}-${v("month")}-${v("day")}T${v("hour")==="24"?"00":v("hour")}:${v("minute")}`;
}
function businessDate(value=new Date()){return wallValue(value).slice(0,10);}
function dateAt(value){return new Date(`${value}T12:00:00Z`);}
function dateShift(value,days){const date=dateAt(value);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);}
function calendarPreferenceKey(){return `pawsh:calendar-preferences:${state.me?.account?.id||state.me?.account?.email||"anonymous"}:${state.me?.business?.id||"none"}`;}
function calendarPreferences(){if(state.calendar.preferences)return state.calendar.preferences;const defaults={visibleStart:null,visibleEnd:null,firstDay:"sunday",density:"comfortable",detail:"compact"};try{const saved=JSON.parse(globalThis.localStorage.getItem(calendarPreferenceKey())||"null");state.calendar.preferences={...defaults,...saved};}catch{state.calendar.preferences=defaults;}return state.calendar.preferences;}
function weekStart(value){const date=dateAt(value),first=calendarPreferences().firstDay==="monday"?1:0,offset=(date.getUTCDay()-first+7)%7;return dateShift(value,-offset);}
function appointmentLocalValue(item){const parts=new Intl.DateTimeFormat("en-CA",{timeZone:item.schedulingTimezone||schedulingZone(),hourCycle:"h23",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).formatToParts(new Date(item.startAt)),value=type=>parts.find(part=>part.type===type).value;return `${value("year")}-${value("month")}-${value("day")}T${value("hour")==="24"?"00":value("hour")}:${value("minute")}`;}
function schedulingTime(item){
  return formatPrefTime(new Date(item.startAt),item.schedulingTimezone||schedulingZone());
}
function disambiguationField(value=""){
  return `<label class="wide">Repeated-time occurrence<select name="disambiguation"><option value="" ${!value?"selected":""}>Automatic when unique</option><option value="earlier" ${value==="earlier"?"selected":""}>First occurrence</option><option value="later" ${value==="later"?"selected":""}>Second occurrence</option></select></label>`;
}

function renderDashboard(data) {
  const metrics = [
    ["Today's bookings", data.todaysAppointments || 0],
    ["Completed today", data.completedToday || 0],
    ["Today's sales", money(data.todaysSalesMinor)],
    ["Outstanding", money(data.outstandingMinor)]
  ];
  $("#metrics").innerHTML = metrics.map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join("");
}

function safetyContext(item) {
  const rabiesLabels={valid_for_appointment:"Valid for appointment",expires_before_appointment:"Expires before appointment",expired:"Expired",unverified:"Unverified",not_provided:"Not provided"};
  const rabies=item.rabiesAppointmentStatus?`<span class="rabies-status rabies-${escape(item.rabiesAppointmentStatus)}" role="status" data-testid="rabies-appointment-status"><strong>Rabies:</strong> ${escape(rabiesLabels[item.rabiesAppointmentStatus]||item.rabiesAppointmentStatus)}${item.vaccinationExpiresOn?` · Expires ${formatPrefLocalDate(item.vaccinationExpiresOn)}`:""}${item.rabiesAppointmentStatus==="expires_before_appointment"?` · Appointment ${formatPrefLocalDate(item.scheduledLocalStart)} · Update required`:""}${item.rabiesCustomerNotificationStatus&&item.rabiesCustomerNotificationStatus!=="not_required"?` · Customer notice ${escape(item.rabiesCustomerNotificationStatus)}`:""}</span>`:"";
  const rabiesNeeded=["expires_before_appointment","expired","unverified","not_provided"].includes(item.rabiesAppointmentStatus);
  const compactRabies=rabiesNeeded?`<span class="rabies-status rabies-needed" role="status" data-testid="rabies-appointment-status"><strong>Rabies needed</strong></span>`:"";
  // Only the safety alert is an alarm. Behaviour, medical, and grooming notes are things the
  // groomer needs to have read, and colouring all four red made none of them stand out — the
  // one line that means "this dog may bite" looked exactly like a note about coat length.
  const careDetails = [
    item.safetyAlerts ? `<p class="care-note care-alarm"><strong>Safety alert:</strong> ${escape(item.safetyAlerts)}</p>` : "",
    item.behaviorNotes ? `<p class="care-note"><strong>Behavior:</strong> ${escape(item.behaviorNotes)}</p>` : "",
    item.medicalNotes ? `<p class="care-note"><strong>Medical:</strong> ${escape(item.medicalNotes)}</p>` : "",
    item.groomingPreferences ? `<p class="care-note"><strong>Grooming:</strong> ${escape(item.groomingPreferences)}</p>` : ""
  ].filter(Boolean);
  if(!compactRabies&&!rabies&&!careDetails.length)return "";
  // The box itself is flagged only when it carries the alarm, so a card with nothing but a
  // grooming preference no longer reads as a warning at a glance.
  const flagged=item.safetyAlerts?" has-alarm":"";
  return `${compactRabies||rabies}${careDetails.length?`<div class="safety-context${flagged}" role="note" aria-label="Pet safety and care information" data-testid="safety-context">${careDetails.join("")}</div>`:""}`;
}
function appointmentHtml(item) {
  const time = schedulingTime(item);
  const customer = `${clientName(item)}`;
  const conflictOverride=item.conflictOverridden?`<small class="conflict-override" data-testid="conflict-override">Intentional overlap</small>`:"";
  return `<article class="appointment" data-testid="appointment" data-appointment-id="${item.id}"><time>${time}</time><div><span class="pet">${escape(petName({petName:item.petName}))}</span><small>${escape(customer)} · ${escape(item.employeeName)}</small>${conflictOverride}${safetyContext(item)}</div><div class="appointment-actions"><span class="badge ${item.status}">${item.status.replace("_"," ")}</span>${calendarAction(item)}</div></article>`;
}
function renderAppointments() {
  renderCalendar();
  const today = businessDate();
  const todays = state.appointments.filter((item) => appointmentLocalValue(item).slice(0,10) === today);
  $("#today-list").innerHTML = todays.length ? todays.map(appointmentHtml).join("") : "No appointments today.";
  bindCalendarInteractions($("#today-list"));
  // runDetached, because advanceAppointment is async and the completed branch now reaches the
  // network before it opens anything. A rejection dropped here would surface as an unhandled
  // rejection with nothing said to the operator.
  $$(".appointment-action").forEach((button) => button.addEventListener("click", () => runDetached(() => advanceAppointment(button.dataset.id, button.dataset.status, button))));
  $$(".terminal-action").forEach(button=>button.addEventListener("click",()=>terminalAppointment(button.dataset.id,button.dataset.status)));
  $$(".move-action").forEach(button=>button.addEventListener("click",()=>moveAppointment(button.dataset.id)));
  $$(".service-action").forEach(button=>button.addEventListener("click",()=>adjustServices(button.dataset.id)));
}
function calendarHours(){
  const values=state.businessHours.flatMap(period=>[String(period.startTime).slice(0,5),String(period.endTime).slice(0,5)]).map(value=>Number(value.slice(0,2))*60+Number(value.slice(3,5)));
  const derived=values.length?[Math.floor(Math.min(...values)/30)*30,Math.ceil(Math.max(...values)/30)*30]:[8*60,19*60],preferences=calendarPreferences(),start=preferences.visibleStart===null?derived[0]:Number(preferences.visibleStart),end=preferences.visibleEnd===null?derived[1]:Number(preferences.visibleEnd);return start<end?[start,end]:derived;
}
function timeLabel(minutes){return formatPrefClock(Math.floor(minutes/60),minutes%60);}
function currentBusinessMinutes(){const parts=wallParts(),value=name=>Number(parts.find(part=>part.type===name)?.value||0);return value("hour")*60+value("minute");}
// Week and day cards are ~140px wide, so the header strip prints a compact range that states the
// meridiem once, at the end ("8:00–9:35 AM", "10:00–1:00 PM"). Anything shorter than twelve hours
// is fully determined by its end, and the grid row already fixes the half of the day; a range long
// enough to be ambiguous keeps both. The full range still drives the accessible name, the hover
// preview and the appointment detail dialog.
function compactTimeRange(start,end,zone){
  const startText=formatPrefTime(start,zone),endText=formatPrefTime(end,zone);
  // A 24-hour clock carries no meridiem, so there is nothing to state once and nothing to strip.
  if(prefHourFormat()==="24")return `${startText}–${endText}`;
  const startPeriod=startText.slice(-2),ambiguous=end-start>=12*60*60*1000;
  return !ambiguous?`${startText.replace(startPeriod,"").trim()}–${endText}`:`${startText}–${endText}`;
}
// DOG_ADDON and A_LA_CARTE are the catalog's add-on families; every other category is a base
// groom or bath. The card prints one base service in ink and greys the add-ons back, so a booking
// reads as "what is being done" plus "what was added". Snapshots keep only the service id, so the
// category is resolved against the loaded catalog; when it is unknown the longest service leads.
const ADD_ON_SERVICE_CATEGORIES=new Set(["DOG_ADDON","A_LA_CARTE"]);
function appointmentServiceSplit(model){
  const categories=new Map(state.services.map(service=>[service.id,service.category]));
  const entries=model.serviceSnapshots.map((service,index)=>({index,name:service.name,duration:Number(service.durationMinutes)||0,addOn:ADD_ON_SERVICE_CATEGORIES.has(categories.get(service.serviceId)||"")}));
  if(!entries.length)return {primary:"",addOns:[]};
  const primary=[...entries].sort((a,b)=>Number(a.addOn)-Number(b.addOn)||b.duration-a.duration||a.index-b.index)[0];
  return {primary:primary.name,addOns:entries.filter(entry=>entry!==primary).map(entry=>entry.name)};
}
// Pawsh has no appointment confirmation flag and /api/appointments carries no invoice, so the card
// badge reports the one state the API can actually back: the appointment lifecycle. An unknown
// status renders no badge rather than asserting something the data does not support.
const APPOINTMENT_BADGES={scheduled:["SCH","Scheduled"],checked_in:["CHK","Checked in"],in_service:["SVC","In service"],completed:["CMP","Completed"],cancelled:["CAN","Cancelled"],no_show:["NOS","No show"]};
function appointmentBadge(item){
  // Once an appointment has been checked out its payment state is the signal a
  // salon acts on, so it takes the badge. Before that there is no invoice and the
  // lifecycle status is shown instead. Confirmed/unconfirmed has no data source yet.
  const invoiceStatus=item&&item.invoiceStatus;
  if(invoiceStatus){
    // Named one at a time rather than defaulted, so a refunded invoice cannot fall through into
    // "Unpaid" - which would put a groomer's calendar card in front of somebody as money to chase.
    if(invoiceStatus==="paid")return {code:"PAI",label:"Paid",variant:"paid"};
    if(invoiceStatus==="refunded")return {code:"REF",label:"Refunded",variant:"refunded"};
    if(invoiceStatus==="partially_refunded")return {code:"PRF",label:"Partly refunded",variant:"partially-refunded"};
    return {code:"UNP",label:"Unpaid",variant:"unpaid"};
  }
  const badge=APPOINTMENT_BADGES[item&&item.status];
  return badge?{code:badge[0],label:badge[1],variant:item.status}:null;
}
// Pet care notes plus the appointment's own note. Empty means the card renders no notes button at
// all: a button that opens an empty panel is worse than no button.
function appointmentNoteEntries(item){
  return [["Safety alert",item.safetyAlerts],["Behavior",item.behaviorNotes],["Medical",item.medicalNotes],["Grooming preferences",item.groomingPreferences],["Coat notes",item.coatNotes],["Appointment note",item.notes]].filter(([,value])=>typeof value==="string"&&value.trim().length>0);
}
function appointmentPresentation(item){
  const start=new Date(item.startAt),end=new Date(item.endAt),zone=item.schedulingTimezone||schedulingZone(),formatTime=value=>formatPrefTime(value,zone),serviceSnapshots=item.services||[],services=serviceSnapshots.map(service=>service.name),groomers=(item.groomers||[]).map(groomer=>groomer.displayName),prices=serviceSnapshots.map(service=>service.priceMinor).filter(value=>value!==null&&value!==undefined);
  return {id:item.id,date:appointmentLocalValue(item).slice(0,10),dateLabel:new Intl.DateTimeFormat([],{weekday:"long",month:"long",day:"numeric",timeZone:zone}).format(start),timeRange:`${formatTime(start)}–${formatTime(end)}`,timeRangeCompact:compactTimeRange(start,end,zone),petName:item.petName,breed:item.breed||"",customerName:`${clientName(item)}`,services,serviceSnapshots,groomer:groomers[0]||item.employeeName,status:item.status.replace("_"," "),conflictOverridden:Boolean(item.conflictOverridden),rabiesNeeded:["not_provided","expires_before_appointment"].includes(item.rabiesAppointmentStatus),warning:item.safetyAlerts||item.behaviorNotes||item.medicalNotes||item.groomingPreferences||item.coatNotes||"",durationMinutes:Math.max(1,Math.round((end-start)/60000)),totalPriceMinor:prices.length===serviceSnapshots.length?prices.reduce((sum,value)=>sum+Number(value),0):null};
}
function appointmentAccessibleName(model){return `${model.timeRange}, ${model.petName}${model.breed?`, ${model.breed}`:""}, ${model.customerName}, ${model.services.join(", ")}, ${model.status}`;}
function appointmentHoverDetails(model){return `<div><span>Status</span><strong>${escape(model.status)}</strong></div><p><strong>${escape(model.dateLabel)}</strong><br>${escape(model.timeRange)}</p><dl><div><dt>Client</dt><dd>${escape(model.customerName)}</dd></div><div><dt>Pet</dt><dd>${escape(petName({petName:model.petName}))}${model.breed?` · ${escape(model.breed)}`:""}</dd></div><div><dt>Services</dt><dd>${model.services.map(escape).join("<br>")}</dd></div><div><dt>Groomer</dt><dd>${escape(model.groomer)}</dd></div></dl><p class="hover-summary"><strong>${model.durationMinutes} min${model.totalPriceMinor!==null?` · ${money(model.totalPriceMinor)}`:""}</strong></p>`;}
function calendarAction(item){
  const definition={scheduled:["Check in","operations.check_in"],checked_in:["Start service","operations.perform_service"],in_service:["Complete","operations.complete"],completed:["Checkout","checkout.perform"]}[item.status];
  const controls=[`<button type="button" role="menuitem" class="calendar-action view-appointment-action" data-id="${item.id}">View / Edit</button>`];
  if(definition&&allowed(definition[1]))controls.unshift(`<button role="menuitem" data-testid="appointment-${item.status}" class="calendar-action appointment-action" data-id="${item.id}" data-status="${item.status}">${definition[0]}</button>`);
  if(item.status==="scheduled"&&appointmentMoveAllowed())controls.push(`<button type="button" role="menuitem" class="calendar-action move-action" data-id="${item.id}">Move</button>`);
  // In the slot Move vacated, and only there. A disabled Move button would say the capability is
  // merely switched off without saying by what or where, which is the half-answer this replaces.
  else if(item.status==="scheduled")controls.push(appointmentLockNoteMarkup("appointment-lock-note"));
  if(item.status==="scheduled"&&allowed("appointments.cancel")){controls.push(`<button type="button" role="menuitem" class="calendar-action terminal-action destructive" data-id="${item.id}" data-status="cancelled">Cancel appointment</button>`);controls.push(`<button type="button" role="menuitem" class="calendar-action terminal-action" data-id="${item.id}" data-status="no_show">No show</button>`);}
  if(["checked_in","in_service"].includes(item.status)&&allowed("appointments.edit"))controls.push(`<button type="button" role="menuitem" class="calendar-action service-action" data-id="${item.id}">Adjust services</button>`);
  return `<div class="calendar-actions-menu"><button type="button" class="calendar-action-trigger" aria-label="Appointment actions for ${escape(petName({petName:item.petName}))}" aria-haspopup="menu" aria-expanded="false" data-appointment-menu="${item.id}">&#8943;</button><div class="calendar-action-popover" role="menu" hidden>${controls.join("")}</div></div>`;
}
// The hash fallback. The modulus stays at five whatever the palette grows to: widening it would
// recolour roughly half the groomers in every workspace that has never opened Settings → Staff,
// and would not fix anything, because ten hashed slots still collide at ten staff.
function groomerSlot(id){if(!id)return"";let hash=0;const key=String(id);for(let index=0;index<key.length;index++)hash=(hash*31+key.charCodeAt(index))>>>0;return hash%5;}
// Slot order is the token order in styles.css. Never a hex in the UI: an operator picks Plum.
const groomerSlotNames=["Violet","Steel blue","Teal","Amber","Olive","Plum","Bark","Indigo","Clay","Petrol"];
// How many colours exist. The database's check is deliberately wider (0-15) as the durable outer
// bound, so a slot stored while the palette was larger falls back to the hash rather than asking
// for a token that is not there.
const groomerPaletteSize=groomerSlotNames.length;
// Explicit choice wins; an employee who has never been given one keeps the colour the hash has
// always given them, so no existing calendar changes on deploy.
function groomerColorSlot(employeeId){
  if(!employeeId)return "";
  const stored=state.employees.find(item=>item.id===employeeId)?.colorSlot;
  return Number.isInteger(stored)&&stored>=0&&stored<groomerPaletteSize?stored:groomerSlot(employeeId);
}
// Card anatomy: a white header strip (compact time, notes button, status badge, safety flags)
// above the groomer-tinted body (pet + breed, base service, greyed add-ons, client). The strip is
// kept shallow on purpose so a 30-minute card still shows the pet name underneath it.
function appointmentCard(item,{day=false,style="",groomerId="",overlap=false}={}){
  const model=appointmentPresentation(item),density=model.durationMinutes<=30?"short":model.durationMinutes<90?"medium":"long";
  // Only a scheduled appointment can be rescheduled, and only with appointments.edit, which is the
  // same gate the Move action carries. Everything else renders exactly as before.
  const draggable=item.status==="scheduled"&&calendarDragAvailable();
  const split=appointmentServiceSplit(model),addOnLimit=density==="long"?3:density==="medium"?2:1,addOns=split.addOns.slice(0,addOnLimit),extra=split.addOns.length-addOns.length;
  const badge=appointmentBadge(item),notes=appointmentNoteEntries(item);
  const alerted=Boolean(item.safetyAlerts&&String(item.safetyAlerts).trim());
  const notesButton=notes.length?`<button type="button" class="appointment-notes-trigger" data-appointment-notes="${item.id}" data-testid="appointment-notes-trigger" ${alerted?'data-alert="true" ':""}aria-haspopup="dialog" aria-label="${alerted?"Safety alert and notes":"Notes"} for ${escape(petName({petName:model.petName}))}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 12.5h6"/><path d="M10 16.5h4"/></svg></button>`:"";
  // .appointment-status stays as the machine-readable full status the calendar suite reads; the
  // visible badge is a separate element so the assertion and the design never fight each other.
  const badges=`<span class="appointment-badges"><small class="appointment-status" aria-hidden="true">${escape(model.status)}</small>${badge?`<span class="appointment-badge badge-${escape(badge.variant)}" role="img" aria-label="${escape(badge.label)}">${badge.code}</span>`:""}${model.rabiesNeeded?`<small class="card-warning" aria-label="Rabies needed">!</small>`:""}</span>`;
  const head=`<div class="appointment-head"><time class="appointment-time">${escape(model.timeRangeCompact)}</time>${notesButton}${badges}</div>`;
  const services=`<span class="appointment-services">${split.primary?`<span class="service-primary">${escape(split.primary)}</span>`:""}${addOns.map(name=>`<span class="service-addon">${escape(name)}</span>`).join("")}${extra>0?`<small>+${extra} more</small>`:""}</span>`;
  const body=`<button type="button" class="calendar-open" data-calendar-appointment="${item.id}" aria-label="${escape(appointmentAccessibleName(model))}"><span class="appointment-identity"><strong class="appointment-pet">${escape(petName({petName:model.petName}))}</strong>${model.breed?`<span class="appointment-breed">${escape(model.breed)}</span>`:""}</span>${services}${model.conflictOverridden?`<small class="conflict-override" data-testid="conflict-override">Intentional overlap</small>`:""}<span class="appointment-client">${escape(model.customerName)}</span></button>`;
  return `<article class="${day?"day-appointment ":""}week-appointment appointment-block density-${density} status-${escape(item.status)} ${overlap?"overlap":""}" data-appointment-id="${item.id}" ${draggable?'data-draggable="true" ':""}${groomerId?`data-groomer-id="${groomerId}" data-groomer-slot="${groomerColorSlot(groomerId)}"`:""} style="${style}">${head}${body}<div class="sr-only appointment-accessible-safety">${safetyContext(item)}</div><div class="appointment-quick-actions">${calendarAction(item)}</div></article>`;
}
function activeGroomers(){return state.employees.filter(employee=>employee.active).sort((a,b)=>a.displayName.localeCompare(b.displayName));}
function selectedGroomers(){const selected=state.calendar.selectedGroomerIds;return activeGroomers().filter(employee=>selected===null||selected.has(employee.id));}
function filteredAppointments(items=state.appointments){const selected=state.calendar.selectedGroomerIds;if(selected===null)return items;return items.filter(item=>(item.groomers||[]).some(groomer=>selected.has(groomer.id)));}
function reconcileGroomerFilter(){
  const groomers=activeGroomers(),authorized=new Set(groomers.map(item=>item.id));
  if(!state.calendar.filterInitialized){try{const saved=JSON.parse(globalThis.localStorage.getItem(`pawsh:groomer-filter:${state.me.business.id}`)||"null");if(Array.isArray(saved))state.calendar.selectedGroomerIds=new Set(saved);}catch{state.calendar.selectedGroomerIds=null;}state.calendar.filterInitialized=true;}
  if(state.calendar.selectedGroomerIds!==null)state.calendar.selectedGroomerIds=new Set([...state.calendar.selectedGroomerIds].filter(id=>authorized.has(id)));
  state.calendar.pendingGroomerIds=state.calendar.selectedGroomerIds===null?new Set(authorized):new Set(state.calendar.selectedGroomerIds);
  renderGroomerFilter();
}
function renderGroomerFilter(){
  const groomers=activeGroomers(),selected=state.calendar.pendingGroomerIds??new Set(groomers.map(item=>item.id));
  $("#groomer-filter-options").innerHTML=groomers.map(item=>`<label data-groomer-slot="${groomerColorSlot(item.id)}"><input type="checkbox" value="${item.id}" ${selected.has(item.id)?"checked":""}> ${escape(item.displayName)}</label>`).join("")||"<p>No active groomers.</p>";
  // The trigger always carries the count, including when nothing is filtered out. "All groomers"
  // read as a state rather than a number, so the one case where you most want to know how many
  // columns you are looking at was the case that would not tell you.
  const applied=state.calendar.selectedGroomerIds,count=applied===null?groomers.length:applied.size;
  $("#groomer-filter-trigger").firstChild.textContent=`${count} groomer${count===1?"":"s"} `;
  $("#groomer-filter-trigger").setAttribute("aria-label",
    count===groomers.length
      ? `Filter calendar by groomer. All ${count} groomers shown.`
      : `Filter calendar by groomer. ${count} of ${groomers.length} groomers shown.`);
}
function renderCalendar(){if(state.calendar.displayMode==="agenda")renderAgendaCalendar();else if(state.calendar.view==="month")renderMonthCalendar();else if(state.calendar.view==="day")renderDayCalendar();else renderWeekCalendar();}
function renderAgendaCalendar(){
  const target=$("#calendar-list"),items=filteredAppointments().slice().sort((a,b)=>new Date(a.startAt)-new Date(b.startAt));
  const groups=items.reduce((map,item)=>{const date=appointmentPresentation(item).date,mapItems=map.get(date)||[];mapItems.push(item);map.set(date,mapItems);return map;},new Map());target.className="calendar-agenda";target.style.removeProperty("min-width");target.style.removeProperty("--groomer-count");target.innerHTML=items.length?[...groups].map(([date,group])=>`<section class="agenda-day"><h3>${escape(formatPrefLocalWeekdayDate(date))}</h3>${group.map(item=>{const model=appointmentPresentation(item);return `<article class="agenda-entry" data-appointment-id="${item.id}"><time datetime="${escape(item.startAt)}">${escape(model.timeRange)}</time><button type="button" class="agenda-appointment" data-calendar-appointment="${item.id}" aria-label="${escape(appointmentAccessibleName(model))}"><strong>${escape(petName({petName:model.petName}))}${model.breed?` <span>(${escape(model.breed)})</span>`:""}</strong><span>${escape(model.customerName)}</span><span>${model.services.map(escape).join(", ")}</span><small>${escape(model.groomer)}</small></button><div class="agenda-indicators"><span class="appointment-status">${escape(model.status)}</span>${model.rabiesNeeded?`<span class="rabies-needed">Rabies needed</span>`:""}${model.warning?`<span class="agenda-warning">⚠ ${escape(model.warning)}</span>`:""}</div></article>`;}).join("")}</section>`).join(""):"<p class=\"empty\">No appointments in this period.</p>";
  const days=state.calendar.view==="day"?1:state.calendar.view==="month"?42:7,start=state.calendar.view==="day"?state.calendar.selectedDate:state.calendar.view==="month"?dateShift(`${state.calendar.month}-01`,-dateAt(`${state.calendar.month}-01`).getUTCDay()):state.calendar.weekStart,end=dateShift(start,days-1);$("#calendar-range").textContent=days===1?formatPrefLocalWeekdayDate(start):`${new Intl.DateTimeFormat([],{month:"short",day:"numeric"}).format(dateAt(start))} – ${new Intl.DateTimeFormat([],{month:"short",day:"numeric",year:"numeric"}).format(dateAt(end))}`;bindCalendarInteractions(target);
}
// Month cells are a fixed height so all six week rows stay uniform; MONTH_EVENT_LIMIT is the
// number of 21px pills that fit under the header line, with the "+N more" link occupying the
// reserved strip at the bottom. Keep it in step with .calendar-month-day min-height in styles.css.
const MONTH_EVENT_LIMIT=12;
// Cancelled and no-show bookings still occupy the day but earn nothing, so they render neutral
// grey, stay out of the revenue and pet totals, and sort behind the live bookings. The seed
// interleaves a cancellation beside almost every booking, so leaving them in time order pushed
// half of the day's real work behind the "+N more" link.
function monthNeutralStatus(item){return ["cancelled","no_show"].includes(item.status);}
function renderMonthCalendar(){
  const target=$("#calendar-list");if(!target||!state.calendar.month)return;
  const first=`${state.calendar.month}-01`,start=weekStart(first),days=Array.from({length:42},(_,index)=>dateShift(start,index)),today=businessDate(),visible=filteredAppointments(state.calendar.monthAppointments.length?state.calendar.monthAppointments:state.appointments);
  target.className="calendar-month-view";target.setAttribute("aria-label","Monthly appointment schedule");target.style.removeProperty("--groomer-count");target.style.removeProperty("min-width");
  const headings=(calendarPreferences().firstDay==="monday"?["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]).map(day=>`<div class="calendar-month-weekday">${day}</div>`).join("");
  const cells=days.map(day=>{const items=visible.filter(item=>appointmentLocalValue(item).slice(0,10)===day).sort((a,b)=>new Date(a.startAt)-new Date(b.startAt)),outside=day.slice(0,7)!==state.calendar.month,periods=state.businessHours.filter(item=>Number(item.weekday)===dateAt(day).getUTCDay()),closed=state.businessHours.length>0&&!periods.length,booked=items.filter(item=>!monthNeutralStatus(item)),revenue=booked.reduce((total,item)=>total+(item.services||[]).reduce((sum,service)=>sum+Number(service.priceMinor||0),0),0),ordered=[...booked,...items.filter(monthNeutralStatus)],shown=ordered.slice(0,MONTH_EVENT_LIMIT),dayLabel=formatPrefLocalWeekdayDate(day);return `<div class="calendar-month-day ${outside?"outside":""} ${closed?"closed":""} ${day===today?"today":""} ${day===state.calendar.selectedDate?"selected":""}" data-month-cell="${day}"><div class="month-day-head">${booked.length?`<span class="month-day-total"><span class="month-day-money">(${escape(money(revenue))}, </span>${booked.length} pet${booked.length===1?"":"s"}<span class="month-day-money">)</span></span>`:`<span class="month-day-total"></span>`}<button type="button" class="calendar-month-add" data-month-book-date="${day}" aria-label="Create appointment on ${escape(dayLabel)}">+</button><button type="button" class="calendar-month-date" data-month-open-date="${day}" aria-label="Open ${escape(dayLabel)} in day view">${Number(day.slice(8,10))}</button></div><div class="calendar-month-events">${shown.map(item=>{const model=appointmentPresentation(item),neutral=monthNeutralStatus(item),slot=neutral?"":groomerColorSlot((item.groomers||[])[0]?.id||item.employeeId);return `<span class="month-appointment-wrap ${neutral?"neutral":""}" data-appointment-id="${item.id}" ${slot===""?"":`data-groomer-slot="${slot}"`}><button type="button" class="calendar-month-event" data-calendar-appointment="${item.id}" aria-label="${escape(appointmentAccessibleName(model))}"><time>${escape(schedulingTime(item))}</time><span class="month-event-name">${escape(model.customerName)}</span></button></span>`;}).join("")}</div>${ordered.length>MONTH_EVENT_LIMIT?`<button type="button" class="calendar-month-more" data-month-open-date="${day}">+${ordered.length-MONTH_EVENT_LIMIT} more</button>`:""}</div>`;}).join("");
  target.innerHTML=headings+cells;$("#calendar-range").textContent=new Intl.DateTimeFormat([],{month:"long",year:"numeric"}).format(dateAt(first));
  $$('[data-month-open-date]').forEach(button=>button.addEventListener("click",()=>{state.calendar.view="day";updateCalendarViewControls();selectCalendarDate(button.dataset.monthOpenDate);}));
  $$('[data-month-book-date]').forEach(button=>button.addEventListener("click",()=>{state.calendar.bookingPreset=`${button.dataset.monthBookDate}T09:00`;state.calendar.bookingGroomerId=null;actions["new-appointment"]();}));bindCalendarInteractions();
}
const WEEK_LANE_WIDTH=160;
function renderWeekCalendar(){
  const target=$("#calendar-list");if(!target||!state.calendar.weekStart)return;
  const groomers=selectedGroomers();if(!groomers.length){target.className="calendar-empty-groomers";target.innerHTML="<p><strong>No groomers selected.</strong><br>Choose groomers to display.</p>";return;}
  const days=Array.from({length:7},(_,index)=>dateShift(state.calendar.weekStart,index)),laneCount=days.length*groomers.length;target.className="week-grid week-groomer-grid";target.setAttribute("aria-label","Weekly appointment schedule by groomer");target.style.setProperty("--week-lanes",laneCount);
  // Every groomer of every day gets its own lane, so the grid is only readable once each lane has a
  // real floor. WEEK_LANE_WIDTH matches the minmax() floor in styles.css; the resulting width is
  // absorbed by .week-scroll, which is marked data-allow-horizontal-scroll.
  target.style.minWidth=`${64+laneCount*WEEK_LANE_WIDTH}px`;const [start,end]=calendarHours();const slots=(end-start)/30;
  const header=`<div class="week-corner" style="grid-column:1;grid-row:1/span 2">Time</div>${days.map((day,index)=>`<button type="button" class="week-day-head ${day===state.calendar.selectedDate?"selected":""}" data-calendar-date="${day}" style="grid-column:${index*groomers.length+2}/span ${groomers.length};grid-row:1"><strong>${new Intl.DateTimeFormat([],{weekday:"short"}).format(dateAt(day))}</strong> ${new Intl.DateTimeFormat([],{month:"short",day:"numeric"}).format(dateAt(day))}</button>`).join("")}${days.flatMap((day,dayIndex)=>groomers.map((groomer,groomerIndex)=>`<div class="week-groomer-head ${groomerIndex===0?"week-day-start":""}" data-groomer-slot="${groomerColorSlot(groomer.id)}" style="grid-column:${dayIndex*groomers.length+groomerIndex+2};grid-row:2" title="${escape(groomer.displayName)}">${escape(groomer.displayName)}</div>`)).join("")}`;
  let cells="";
  for(let slot=0;slot<slots;slot++){const minutes=start+slot*30,row=slot+3;cells+=`<div class="week-time" style="grid-column:1;grid-row:${row}">${timeLabel(minutes)}</div>`;for(let dayIndex=0;dayIndex<7;dayIndex++){const day=days[dayIndex],periods=state.businessHours.filter(item=>Number(item.weekday)===dateAt(day).getUTCDay()),open=!periods.length&&!state.businessHours.length||periods.some(period=>{const from=Number(String(period.startTime).slice(0,2))*60+Number(String(period.startTime).slice(3,5)),to=Number(String(period.endTime).slice(0,2))*60+Number(String(period.endTime).slice(3,5));return minutes>=from&&minutes<to;});for(let groomerIndex=0;groomerIndex<groomers.length;groomerIndex++){const groomer=groomers[groomerIndex],preset=`${day}T${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;cells+=`<button type="button" aria-label="${day}, ${timeLabel(minutes)}, ${escape(groomer.displayName)}, ${open?"create appointment":"closed"}" class="week-slot ${groomerIndex===0?"week-day-start ":""}${open?"":"closed"}" ${open?`data-slot="${preset}" data-slot-groomer="${groomer.id}"`:"disabled"} style="grid-column:${dayIndex*groomers.length+groomerIndex+2};grid-row:${row}"></button>`;}}}
  const visible=filteredAppointments();const placed=[];
  const appointments=visible.flatMap(item=>{const local=appointmentLocalValue(item),day=local.slice(0,10),dayIndex=days.indexOf(day);if(dayIndex<0)return [];const minutes=Number(local.slice(11,13))*60+Number(local.slice(14,16)),duration=Math.max(30,Math.round((new Date(item.endAt)-new Date(item.startAt))/60000)),row=Math.floor((minutes-start)/30)+3;if(row<3||row>slots+2)return [];return (item.groomers||[]).map(assigned=>{const groomerIndex=groomers.findIndex(groomer=>groomer.id===assigned.id);if(groomerIndex<0)return "";const lane=`${day}:${assigned.id}`,overlap=placed.some(other=>other.lane===lane&&minutes<other.end&&minutes+duration>other.start);placed.push({lane,start:minutes,end:minutes+duration});return appointmentCard(item,{day:true,groomerId:assigned.id,overlap,style:`grid-column:${dayIndex*groomers.length+groomerIndex+2};grid-row:${row}/span ${Math.max(1,Math.ceil(duration/30))}`});});}).join("");
  const now=currentBusinessMinutes(),todayIndex=days.indexOf(businessDate()),nowRow=Math.floor((now-start)/30)+3,currentLine=todayIndex>=0&&now>=start&&now<end?`<div class="calendar-now-line" role="status" aria-label="Current business time" style="grid-column:${todayIndex*groomers.length+2}/span ${groomers.length};grid-row:${nowRow}"></div>`:"";target.innerHTML=header+cells+appointments+currentLine;
  $("#calendar-range").textContent=`${new Intl.DateTimeFormat([],{month:"short",day:"numeric"}).format(dateAt(days[0]))} – ${new Intl.DateTimeFormat([],{month:"short",day:"numeric",year:"numeric"}).format(dateAt(days[6]))}`;
  $$('[data-calendar-date]').forEach(button=>button.addEventListener("click",()=>runDetached(()=>selectCalendarDate(button.dataset.calendarDate))));
  bindCalendarInteractions();
}
function renderDayCalendar(){
  const target=$("#calendar-list");if(!target||!state.calendar.selectedDate)return;
  const groomers=selectedGroomers();
  const [start,end]=calendarHours(),slots=(end-start)/30,columns=Math.max(1,groomers.length);
  target.className="day-grid";target.setAttribute("aria-label","Daily appointment schedule by groomer");target.style.setProperty("--groomer-count",columns);target.style.minWidth=`${64+columns*190}px`;
  if(!groomers.length){target.className="calendar-empty-groomers";target.innerHTML="<p><strong>No groomers selected.</strong><br>Choose groomers to display.</p>";$("#calendar-range").textContent=formatPrefLocalWeekdayDate(state.calendar.selectedDate);return;}
  let content=`<div class="day-corner" style="grid-column:1;grid-row:1">Time</div>${groomers.map((groomer,index)=>`<div class="day-groomer" data-groomer-slot="${groomerColorSlot(groomer.id)}" style="grid-column:${index+2};grid-row:1">${escape(groomer.displayName)}</div>`).join("")}`;
  for(let slot=0;slot<slots;slot++){const minutes=start+slot*30,row=slot+2,periods=state.businessHours.filter(item=>Number(item.weekday)===dateAt(state.calendar.selectedDate).getUTCDay()),open=!periods.length&&!state.businessHours.length||periods.some(period=>{const from=Number(String(period.startTime).slice(0,2))*60+Number(String(period.startTime).slice(3,5)),to=Number(String(period.endTime).slice(0,2))*60+Number(String(period.endTime).slice(3,5));return minutes>=from&&minutes<to;});content+=`<div class="day-time" style="grid-column:1;grid-row:${row}">${timeLabel(minutes)}</div>`;for(let index=0;index<groomers.length;index++){const groomer=groomers[index],preset=`${state.calendar.selectedDate}T${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;content+=`<button type="button" class="day-slot ${open?"":"closed"}" ${open?`data-slot="${preset}" data-slot-groomer="${groomer.id}"`:`disabled`} style="grid-column:${index+2};grid-row:${row}" aria-label="${escape(state.calendar.selectedDate)}, ${timeLabel(minutes)}, ${escape(groomer.displayName)}, ${open?"create appointment":"closed"}"></button>`;}}
  for(const item of filteredAppointments().filter(appointment=>appointmentLocalValue(appointment).slice(0,10)===state.calendar.selectedDate)){const local=appointmentLocalValue(item),minutes=Number(local.slice(11,13))*60+Number(local.slice(14,16)),duration=Math.max(30,Math.round((new Date(item.endAt)-new Date(item.startAt))/60000)),row=Math.floor((minutes-start)/30)+2;if(row<2||row>slots+1)continue;for(const assigned of item.groomers||[]){const column=groomers.findIndex(groomer=>groomer.id===assigned.id);if(column<0)continue;content+=appointmentCard(item,{day:true,groomerId:assigned.id,style:`grid-column:${column+2};grid-row:${row}/span ${Math.max(1,Math.ceil(duration/30))}`});}}
  const now=currentBusinessMinutes(),nowRow=Math.floor((now-start)/30)+2;if(state.calendar.selectedDate===businessDate()&&now>=start&&now<end)content+=`<div class="calendar-now-line" role="status" aria-label="Current business time" style="grid-column:2/-1;grid-row:${nowRow}"></div>`;target.innerHTML=content;$("#calendar-range").textContent=formatPrefLocalWeekdayDate(state.calendar.selectedDate);bindCalendarInteractions();
}
// The slot menu shares the popover styling but is anchored to the pointer rather than parked
// beside a trigger, so it has no expanded sibling to reset. Guarding on the attribute keeps this
// from writing aria-expanded onto whatever element happens to precede a floating popover.
function closeCalendarMenus({restoreFocus=false}={}){$$(".calendar-action-popover:not([hidden])").forEach(popover=>{popover.hidden=true;const trigger=popover.previousElementSibling;if(!trigger?.hasAttribute("aria-expanded"))return;trigger.setAttribute("aria-expanded","false");if(restoreFocus)trigger.focus();});}
function bindCalendarInteractions(root=document){bindAppointmentLockNote(root);const find=selector=>[...root.querySelectorAll(selector)];find('[data-slot]').forEach(button=>button.addEventListener("click",event=>{event.stopPropagation();openSlotMenu(button);}));find('[data-calendar-appointment]').forEach(button=>button.addEventListener("click",event=>{event.stopPropagation();closeCalendarMenus();openCalendarAppointment(button.dataset.calendarAppointment,event.currentTarget);}));find('[data-appointment-notes]').forEach(button=>button.addEventListener("click",event=>{event.stopPropagation();openAppointmentNotes(button.dataset.appointmentNotes,event.currentTarget);}));find('[data-appointment-menu]').forEach(trigger=>trigger.addEventListener("click",event=>{event.stopPropagation();const popover=trigger.nextElementSibling,opening=popover.hidden;closeCalendarMenus();popover.hidden=!opening;trigger.setAttribute("aria-expanded",String(opening));if(opening)popover.querySelector("button")?.focus();}));find('.calendar-action-popover').forEach(popover=>popover.addEventListener("keydown",event=>{if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;event.preventDefault();const items=[...popover.querySelectorAll('[role="menuitem"]')],index=items.indexOf(document.activeElement),next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;items[next]?.focus();}));find('.view-appointment-action').forEach(button=>button.addEventListener("click",event=>{closeCalendarMenus();openCalendarAppointment(button.dataset.id,event.currentTarget);}));}
// Small notes dialog. Reuses the shared <dialog>, so Escape closes it and focus returns to the
// card button through the existing #modal close handler.
function openAppointmentNotes(id,origin=null){
  const item=calendarAppointmentById(id);if(!item)return;
  const entries=appointmentNoteEntries(item);if(!entries.length)return;
  calendarDetailOrigin=origin||document.activeElement;closeCalendarMenus();hideCalendarHover();
  const model=appointmentPresentation(item);
  openModal(`Notes · ${model.petName}`,`<div class="appointment-notes-panel" data-testid="appointment-notes"><p class="appointment-notes-meta">${escape(model.timeRange)} · ${escape(model.customerName)}</p><dl>${entries.map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl></div>`,null,{cancelLabel:"Close"});
  const close=$("#modal .modal-head .close");close.setAttribute("aria-label","Close notes");close.focus();
}
function calendarAppointmentById(id){return state.appointments.find(appointment=>appointment.id===id)||state.calendar.monthAppointments.find(appointment=>appointment.id===id);}
// The other direction: a row the server has just handed back, written into the caches the calendar
// draws from. The week and the month hold separate arrays and an appointment can be in both, so
// both are corrected. renderAppointments() is guarded the way every other out-of-band redraw of
// the grid in this file is - a workspace that has not opened the calendar has nothing to redraw.
function applyCalendarAppointment(row){
  for(const list of [state.appointments,state.calendar.monthAppointments]){
    const index=list.findIndex(entry=>entry.id===row.id);
    if(index>=0)list[index]=row;
  }
  try{renderAppointments();}catch{/* the calendar is not mounted; nothing to redraw */}
}
function appointmentHost(target){return target.closest?.("[data-appointment-id]");}
// == Calendar drag-to-move ==
// Pointer events, not HTML5 drag-and-drop: the grid needs a movement threshold (so a press that
// never travels still opens the appointment), pointer capture (so a slot underneath cannot steal
// the stream mid-drag) and elementsFromPoint (so a slot already covered by another card stays a
// legal target and the server gets to answer with the conflict). A drop is never applied
// optimistically - the request goes first and the calendar reloads from what the server did.
const CALENDAR_DRAG_THRESHOLD=5,CALENDAR_DRAG_EDGE=48,CALENDAR_DRAG_SPEED=16;
let calendarDrag=null;
/**
 * Whether a MOVE is on offer at all.
 *
 * A move is a change to WHEN an appointment starts or WHO is assigned to it, and nothing else.
 * Two gates govern it and they stack as an AND, because they answer different questions: the
 * permission answers WHO may move an appointment, and `appointmentLock` answers WHETHER anyone may
 * right now. Neither replaces the other.
 *
 * THERE IS NO OWNER BYPASS, deliberately. The lock is a policy switch rather than a permission, the
 * owner is the person holding the switch, and the server has no exemption either - so a client-side
 * one would draw an owner a drag that snaps back with no explanation.
 *
 * ONLY MOVING IS GATED. Editing services, price, notes and status stay available under the lock, and
 * so does booking a new appointment. None of those is a move.
 */
function appointmentsLocked(){return state.me?.business?.appointmentLock==="enabled";}
function appointmentMoveAllowed(){return allowed("appointments.edit")&&!appointmentsLocked();}
// Drag is a fine-pointer affordance on top of that. On touch the same move is one tap away through
// the card menu's Move action, and an accidental drag across a working schedule is expensive to
// undo, so coarse pointers keep the menu path only.
function calendarDragAvailable(){return appointmentMoveAllowed()&&globalThis.matchMedia("(hover: hover) and (pointer: fine)").matches;}
const APPOINTMENT_LOCK_MESSAGE="Appointments are locked from being moved. A manager can unlock this in Settings \u2192 Business.";
/**
 * Why the Move affordance is not there - drawn for exactly one of the two reasons.
 *
 * Without `appointments.edit`, moving appointments is not this person's job and an explanation
 * would be noise about a capability they never had. Under the lock it is the opposite: somebody who
 * could drag a card yesterday is looking at a calendar whose appointments have silently stopped
 * dragging, and the sentence is the whole of the answer.
 *
 * It goes where Move was rather than into a banner over the calendar. The question is asked at the
 * card - the operator opens its menu looking for Move - so that is where it is answered, and no
 * persistent chrome is spent on a state most workspaces are never in.
 *
 * The pointer at Settings is drawn only for somebody holding `settings.manage`. Anyone else is being
 * told to ask a manager, which the sentence already says; a link they would be refused at is worse
 * than no link.
 */
function appointmentLockNoteMarkup(testId){
  if(!appointmentsLocked()||!allowed("appointments.edit"))return "";
  return `<p class="appointment-lock-note" data-testid="${testId}">${escape(APPOINTMENT_LOCK_MESSAGE)}`
    +(allowed("settings.manage")
      ?` <button type="button" class="text-button" data-appointment-lock-settings>Open Settings</button>`:"")
    +`</p>`;
}
function bindAppointmentLockNote(root=document){
  root.querySelectorAll("[data-appointment-lock-settings]").forEach(button=>button.addEventListener("click",event=>{
    event.stopPropagation();
    runDetached(async()=>{
      closeCalendarMenus();$("#modal")?.close();
      await showView("admin-settings");
      renderSettingsCategory("business",{history:"push"});
    });
  }));
}
function appointmentMoveRefused(error){
  // Matched on `code`, never on the message text.
  return error.status===409&&error.data?.code==="APPOINTMENT_MOVE_LOCKED";
}
/**
 * A refusal is also the news that this tab's copy of the lock is stale.
 *
 * Hiding the affordance is not enforcement, and the two ways past it - a second tab, or a manager
 * flipping the switch mid-drag - both leave a calendar still drawing a drag the server will refuse.
 * Re-reading `/api/me` and redrawing is what makes the affordance disappear, so the operator is told
 * once rather than discovering it again on the next card.
 */
async function reconcileAppointmentLock(){
  try{state.me=await api("/api/me");}catch{/* the refusal already carried the message */}
  try{renderAppointments();}catch{/* the calendar is not mounted; nothing to redraw */}
}
function calendarDragCard(target){
  if(!target?.closest)return null;
  // The overflow menu and the notes button are small, deliberate targets, so a press there is only
  // ever a click. The rest of the card can begin a drag, but only after the pointer has actually
  // travelled, which leaves a plain click free to reach the open-detail button underneath.
  if(target.closest(".appointment-quick-actions")||target.closest(".appointment-notes-trigger"))return null;
  return target.closest('.appointment-block[data-draggable="true"]');
}
function calendarDropSlot(x,y){
  for(const element of document.elementsFromPoint(x,y)){const slot=element.closest?.("[data-slot]");if(slot)return slot;}
  return null;
}
function highlightDropSlot(slot){
  if(!calendarDrag||calendarDrag.slot===slot)return;
  calendarDrag.slot?.classList.remove("drag-over");
  calendarDrag.slot=slot;
  slot?.classList.add("drag-over");
}
// The card lives inside the scrolling grid, so the offset that keeps it under the cursor is the
// pointer travel plus however far the grid has scrolled underneath it since the drag began.
function positionDraggedCard(){
  const drag=calendarDrag;if(!drag?.active)return;
  const scrollX=drag.container?drag.container.scrollLeft-drag.fromScrollLeft:0,scrollY=drag.container?drag.container.scrollTop-drag.fromScrollTop:0;
  drag.card.style.transform=`translate(${drag.x-drag.fromX+scrollX}px, ${drag.y-drag.fromY+scrollY}px)`;
}
// A week holds seven days times every groomer, so the target lane is regularly outside the viewport
// when the drag starts. Holding near an edge scrolls the grid instead of forcing a drop and retry.
function calendarDragFrame(){
  const drag=calendarDrag;
  if(!drag?.active)return;
  const container=drag.container;
  if(container){
    const rect=container.getBoundingClientRect(),step=(near,far)=>near<CALENDAR_DRAG_EDGE?-CALENDAR_DRAG_SPEED:far<CALENDAR_DRAG_EDGE?CALENDAR_DRAG_SPEED:0;
    const moveX=step(drag.x-rect.left,rect.right-drag.x),moveY=step(drag.y-rect.top,rect.bottom-drag.y);
    if(moveX||moveY){container.scrollBy(moveX,moveY);positionDraggedCard();highlightDropSlot(calendarDropSlot(drag.x,drag.y));}
  }
  drag.frame=globalThis.requestAnimationFrame(calendarDragFrame);
}
function beginCalendarDrag(){
  const drag=calendarDrag;
  drag.active=true;
  drag.container=drag.card.closest(".week-scroll");
  drag.fromScrollLeft=drag.container?.scrollLeft||0;
  drag.fromScrollTop=drag.container?.scrollTop||0;
  closeCalendarMenus();hideCalendarHover();
  try{drag.card.setPointerCapture(drag.pointerId);}catch{/* capture is an optimisation, not a requirement */}
  drag.card.classList.add("dragging");
  document.body.classList.add("calendar-dragging");
  drag.frame=globalThis.requestAnimationFrame(calendarDragFrame);
}
// The click that follows a completed drag would otherwise reach the open-detail button, so it is
// swallowed for the one task the browser dispatches it in. A press that never became a drag never
// reaches here, which is what keeps slot creation and open-detail clicks intact.
function swallowNextClick(){
  const swallow=event=>{event.stopPropagation();event.preventDefault();};
  document.addEventListener("click",swallow,true);
  setTimeout(()=>document.removeEventListener("click",swallow,true),0);
}
function endCalendarDrag(commit){
  const drag=calendarDrag;if(!drag)return;
  calendarDrag=null;
  if(drag.frame)globalThis.cancelAnimationFrame(drag.frame);
  if(!drag.active)return;
  if(drag.card.hasPointerCapture?.(drag.pointerId))drag.card.releasePointerCapture(drag.pointerId);
  drag.card.classList.remove("dragging");
  drag.card.style.removeProperty("transform");
  document.body.classList.remove("calendar-dragging");
  drag.slot?.classList.remove("drag-over");
  swallowNextClick();
  const slot=commit?drag.slot:null;
  if(!slot||slot.dataset.slot===drag.fromSlot&&slot.dataset.slotGroomer===drag.fromGroomer)return;
  runDetached(()=>dropAppointment(drag.id,slot.dataset.slot,slot.dataset.slotGroomer));
}
document.addEventListener("pointerdown",event=>{
  if(calendarDrag)endCalendarDrag(false);
  if(event.pointerType!=="mouse"||event.button!==0||!event.isPrimary)return;
  const card=calendarDragCard(event.target);if(!card||!calendarDragAvailable())return;
  const item=calendarAppointmentById(card.dataset.appointmentId);if(!item||item.status!=="scheduled")return;
  calendarDrag={card,id:item.id,pointerId:event.pointerId,fromX:event.clientX,fromY:event.clientY,x:event.clientX,y:event.clientY,fromSlot:appointmentLocalValue(item),fromGroomer:card.dataset.groomerId||"",active:false,slot:null,container:null,frame:0};
});
document.addEventListener("pointermove",event=>{
  const drag=calendarDrag;if(!drag||event.pointerId!==drag.pointerId)return;
  drag.x=event.clientX;drag.y=event.clientY;
  if(!drag.active){
    if(Math.abs(drag.x-drag.fromX)<CALENDAR_DRAG_THRESHOLD&&Math.abs(drag.y-drag.fromY)<CALENDAR_DRAG_THRESHOLD)return;
    beginCalendarDrag();
  }
  positionDraggedCard();
  highlightDropSlot(calendarDropSlot(drag.x,drag.y));
});
document.addEventListener("pointerup",event=>{if(calendarDrag&&event.pointerId===calendarDrag.pointerId)endCalendarDrag(true);});
document.addEventListener("pointercancel",event=>{if(calendarDrag&&event.pointerId===calendarDrag.pointerId)endCalendarDrag(false);});
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&calendarDrag)endCalendarDrag(false);});
function dropSlotLabel(localStart,employeeId){
  const minutes=Number(localStart.slice(11,13))*60+Number(localStart.slice(14,16)),groomer=state.employees.find(item=>item.id===employeeId)?.displayName;
  return `${new Intl.DateTimeFormat([],{weekday:"short",month:"short",day:"numeric"}).format(dateAt(localStart.slice(0,10)))}, ${timeLabel(minutes)}${groomer?` with ${groomer}`:""}`;
}
async function dropAppointment(id,localStart,employeeId){
  const appointment=calendarAppointmentById(id);if(!appointment)return;
  return runOnce(`schedule-drop:${id}`,async()=>{
    const payload={employeeId,localStart,expectedLocationVersion:state.me.business.locationVersion,version:appointment.version};
    try{
      await schedulingMutation(`/api/appointments/${id}/schedule`,payload,"Reschedule");
      await refresh();
      toast(`${appointment.petName} moved to ${dropSlotLabel(localStart,employeeId)}`);
    }catch(error){
      if(error.status===403)await reconcilePermissions();
      // A lock refuses the OPERATION, not the slot, so there is nothing for the Move dialog to
      // correct - opening it would offer to retype a time that will be refused again. The server's
      // own sentence is shown, because it is written to be read by an operator.
      if(appointmentMoveRefused(error)){toast(error.message);await reconcileAppointmentLock();return;}
      await openMoveRejection(error,id,{localStart,employeeId});
    }
  });
}
// Nothing moved on the way out, so a rejection has nothing to roll back - the card is still in its
// own slot. The reason is handed to the Move dialog opened on the target the drop aimed at, so an
// overridable conflict keeps its existing "Move anyway" affordance, an availability refusal is read
// where the time can be corrected, and the product keeps one conflict path rather than two.
async function openMoveRejection(error,id,preset){
  if(!error.retryConflictOverride)await refresh().catch(failure=>toast(failure.message));
  if(!state.appointments.some(item=>item.id===id)){toast(error.message);return;}
  moveAppointment(id,preset);
  if(error.retryConflictOverride)renderConflictOverride(error);
  else $("#modal-error").textContent=error.message;
}
function showCalendarHover(host){if(!globalThis.matchMedia("(hover: hover) and (pointer: fine)").matches)return;const item=calendarAppointmentById(host?.dataset.appointmentId);if(!item)return;const preview=$("#calendar-hover-preview"),model=appointmentPresentation(item),rect=host.getBoundingClientRect(),width=Math.min(280,globalThis.innerWidth-24);preview.innerHTML=appointmentHoverDetails(model);preview.style.width=`${width}px`;preview.hidden=false;const height=preview.offsetHeight,leftSpace=rect.left-12,rightSpace=globalThis.innerWidth-rect.right-12,left=rightSpace>=width?rect.right+8:leftSpace>=width?rect.left-width-8:Math.max(12,Math.min(rect.left,globalThis.innerWidth-width-12)),top=rect.bottom+height+12<=globalThis.innerHeight?rect.bottom+8:Math.max(12,rect.top-height-8);preview.style.left=`${left}px`;preview.style.top=`${top}px`;preview.dataset.hoverAppointmentId=item.id;}
function hideCalendarHover(){const preview=$("#calendar-hover-preview");preview.hidden=true;preview.removeAttribute("data-hover-appointment-id");}
document.addEventListener("pointerover",event=>{const host=appointmentHost(event.target);if(host&&!host.contains(event.relatedTarget))showCalendarHover(host);});
document.addEventListener("pointerout",event=>{const host=appointmentHost(event.target);if(host&&!host.contains(event.relatedTarget))hideCalendarHover();});
document.addEventListener("focusin",event=>{const host=appointmentHost(event.target);if(host)showCalendarHover(host);});
document.addEventListener("focusout",event=>{const host=appointmentHost(event.target);if(host&&!host.contains(event.relatedTarget))hideCalendarHover();});
async function loadAppointmentRange(start,days){const chunks=[],selected=state.calendar.selectedGroomerIds,employeeQuery=selected===null?"":`&employeeIds=${encodeURIComponent([...selected].join(","))}`;if(selected!==null&&!selected.size)return [];for(let offset=0;offset<days;offset+=31){const size=Math.min(31,days-offset);chunks.push(api(`/api/appointments?localDate=${dateShift(start,offset)}&days=${size}${employeeQuery}`));}return (await Promise.all(chunks)).flat();}
async function loadCalendarWeek(start=state.calendar.weekStart){
  state.calendar.weekStart=start;let rangeStart=start,days=7;if(state.calendar.view==="day"){rangeStart=state.calendar.selectedDate;days=1;}else if(state.calendar.view==="month"){rangeStart=weekStart(`${state.calendar.month}-01`);days=42;}const [appointments,hours]=await Promise.all([loadAppointmentRange(rangeStart,days),state.businessHours.length?state.businessHours:api("/api/business/working-hours")]);state.appointments=appointments;state.businessHours=hours;if(state.calendar.view==="month")state.calendar.monthAppointments=appointments;if(!state.calendar.monthAppointments.length&&state.calendar.view!=="month")await loadCalendarMonth(state.calendar.month,false);renderAppointments();
}
async function openCalendarView(){await loadCalendarWeek();if(!state.calendar.opened&&!state.appointments.length&&state.calendar.selectedGroomerIds===null){const upcoming=await api(`/api/appointments?localDate=${businessDate()}&days=31`);if(upcoming.length){const date=appointmentLocalValue(upcoming[0]).slice(0,10);state.calendar.opened=true;return selectCalendarDate(date);}}state.calendar.opened=true;}
async function loadCalendarMonth(month=state.calendar.month){const start=weekStart(`${month}-01`),appointments=await loadAppointmentRange(start,42);state.calendar.monthAppointments=appointments;return appointments;}
async function selectCalendarDate(date){const changedMonth=state.calendar.month!==date.slice(0,7);state.calendar.selectedDate=date;state.calendar.weekStart=weekStart(date);state.calendar.month=date.slice(0,7);if(changedMonth)await loadCalendarMonth(state.calendar.month,false);await loadCalendarWeek();}
function adjustServices(id) {
  const appointment=state.appointments.find(item=>item.id===id);
  openModal("Adjust appointment services",safetyContext(appointment)+bookingServiceCheckboxes(appointment.services.map(service=>service.serviceId)),form=>api(`/api/appointments/${id}/services`,{method:"PUT",body:JSON.stringify({serviceIds:form.getAll("serviceIds"),version:appointment.version})}));
}
function moveAppointment(id,preset={}) {
  const appointment=state.appointments.find(item=>item.id===id);
  // A preset is the slot a drag aimed at. Prefilling the dialog with it means a refused drop is
  // corrected where it was attempted instead of making the user find the target again.
  const local=preset.localStart||appointmentLocalValue(appointment);
  const assigned=preset.employeeId?[preset.employeeId]:(appointment.groomers||[]).map(item=>item.id);
  openModal("Move appointment",groomerCheckboxes(assigned,(appointment.services||[]).map(service=>service.serviceId))+field("startAt","Start time","datetime-local",`required value="${escape(local)}"`)+disambiguationField(appointment.scheduledDisambiguation||""),form=>schedulingMutation(`/api/appointments/${id}/schedule`,{employeeId:form.get("employeeId"),localStart:form.get("startAt"),disambiguation:form.get("disambiguation")||undefined,expectedLocationVersion:state.me.business.locationVersion,version:appointment.version},"Reschedule"));
}
async function terminalAppointment(id,status) {
  if(!confirm(status==="cancelled"?"Cancel this appointment?":"Mark this appointment as a no-show?"))return;
  const appointment=state.appointments.find(item=>item.id===id);
  return runOnce(`transition:${id}`,async()=>{
    try{await api(`/api/appointments/${id}/transition`,{method:"POST",body:JSON.stringify({status,version:appointment.version})});toast(`Appointment ${status.replace("_"," ")}`);await refresh();}catch(error){toast(error.message);if([400,409].includes(error.status))await refresh();}
  });
}
async function advanceAppointment(id, status, actionButton) {
  // Guarded like every other transition. `checkout()` is async and makes two reads before it can
  // open anything, and this is the one branch that returns before the runOnce below - so without a
  // key of its own a second click inside that window runs the whole of checkout() again: the
  // salon's payment configuration is read twice, and the modal is rebuilt and rebound underneath
  // whoever is already typing into it. showModal() on an already-modal dialog is a no-op rather
  // than a throw, so nothing reports any of this; it is silent, and the second render wins.
  if (status === "completed") return runOnce(`checkout:${id}`,()=>checkout(id));
  const appointment=state.appointments.find(item=>item.id===id);
  const next = {scheduled:"checked_in",checked_in:"in_service",in_service:"completed"}[status];
  if (status === "scheduled" || status === "checked_in") {
    return openModal(status === "scheduled" ? "Check in appointment" : "Start service",
      safetyContext(appointment)+(status === "checked_in" ? field("operationalNotes","Service note","text","",true) : ""),
      async (form) => {
        try {
          if (status === "checked_in") {
            const updated=await api(`/api/appointments/${id}/operations`,{method:"PATCH",body:JSON.stringify({operationalNotes:form.get("operationalNotes")||null,version:appointment.version})});
            appointment.version=updated.version;
          }
          await api(`/api/appointments/${id}/transition`,{method:"POST",body:JSON.stringify({status:next,version:appointment.version})});
        } catch (error) {
          if([400,409].includes(error.status)){error.reconcileLifecycle=true;}
          throw error;
        }
      });
  }
  if (status === "in_service" && !confirm("Mark this grooming appointment complete?")) return;
  return runOnce(`transition:${id}`,async()=>{
    if(actionButton){actionButton.disabled=true;actionButton.setAttribute("aria-busy","true");}
    try { await api(`/api/appointments/${id}/transition`,{method:"POST",body:JSON.stringify({status:next,version:appointment.version})}); toast(`Appointment ${next.replace("_"," ")}`); await refresh(); }
    catch (error) { toast(error.message); if([400,409].includes(error.status))await refresh(); }
    finally{if(actionButton?.isConnected){actionButton.disabled=false;actionButton.removeAttribute("aria-busy");}}
  });
}
/**
 * Check Out - level 2 of the appointment stack.
 *
 * A RE-LAY-OUT, NOT A REWRITE. The picker, the one-per-appointment rule, the running total, the
 * tip presets, the terminal withdrawal, the idempotency keys and the INVOICE_ALREADY_EXISTS
 * sentence are the same code the shared dialog ran; they take a host now instead of assuming
 * `#modal-fields`.
 *
 * THE MODAL IS GONE RATHER THAN KEPT ALONGSIDE. Two entry points creating one invoice would be
 * two validation surfaces and two ways past `runOnce("checkout:<id>")`, and the note on
 * advanceAppointment() already explains what a second concurrent render of this screen costs.
 *
 * Reached from the calendar it is the only level open, so closing returns to the calendar; reached
 * from the appointment detail it is level 2 and closing returns to the detail. The stack handles
 * both without a branch here.
 *
 * The payment method list is the salon's, not a fixed four. `payments.method` is still the closed
 * set of settlement types the ledger can tell apart, so the radios offer the methods staff
 * actually configured and the chosen one is mapped back to its settlement type on the way out.
 */

// What this screen is for right now. `build` has no invoice yet, so discounts and the tip are
// live; `collect` has one, so they are frozen and only the payment moves; `settled` owes nothing.
function checkoutMode(co){
  if(!co.receipt)return "build";
  return Number(co.receipt.invoice.balanceMinor)>0?"collect":"settled";
}

/**
 * What the bill will come to, as the browser can compute it before the invoice exists.
 *
 * MIRRORS calculateInvoice() AND NOTHING ELSE: taxable subtotal, then one rounding step at
 * `round(taxable * rate / 10000)`, then plus the tip. The same deliberate mirror `foldDiscounts`
 * already is, and for the same reason - the operator has to see what they are about to charge
 * before they charge it. It is an ESTIMATE: the server recomputes every figure from the
 * appointment's own snapshots and its answer is the one the invoice carries.
 *
 * A COUPON IS NOT IN IT. What a coupon takes off is resolved against the coupon row at checkout
 * and may be refused outright, so the browser does not know the figure and does not invent one.
 */
function checkoutEstimate(host,base,tipMinor){
  if(base===null)return null;
  const fold=foldDiscounts(base,checkoutDiscountLines(host),checkoutStackingMode());
  const rate=Number(state.me?.business?.taxRateBasisPoints)||0;
  const taxMinor=Math.round(fold.total*rate/10000);
  return {subtotalMinor:fold.subtotal,discountMinor:fold.discountMinor,taxableMinor:fold.total,
    taxMinor,tipMinor,totalMinor:fold.total+taxMinor+tipMinor};
}

// Checked in, checked out and duration. The stored columns are the record; the audit trail is the
// fallback for a visit that predates them, which is why the derivation note is only said when a
// shown value actually came from the feed.
function appointmentLifecycleValues(item,activity){
  const derived=appointmentLifecycleTimes(activity?.items||[]);
  const checkedIn=item?.checkedInAt||derived.checkedIn;
  const finished=item?.checkedOutAt||derived.finished;
  const minutes=checkedIn&&finished
    ? Math.max(0,Math.round((new Date(finished)-new Date(checkedIn))/60000))
    : null;
  const stored=Boolean(item?.checkedInAt&&item?.checkedOutAt);
  return {checkedIn,finished,minutes,stored};
}

// A .print-root appended to <body>, which the print stylesheet is the only thing that shows -
// the one printing mechanism the product has.
//
// IT NAMES ITSELF FROM THE PAYMENTS ON IT. The body is the same money statement either way; the
// heading is the part that makes a claim, and on an invoice nobody has paid it has to say Invoice.
function printFinancialDocument(receipt){
  const root=document.createElement("section");
  root.className="print-root";
  root.innerHTML=`<h1>${escape(financialDocumentTitle(receipt))}</h1>${receiptBodyMarkup(receipt)}`;
  document.body.append(root);
  globalThis.print();
  setTimeout(()=>root.remove(),1000);
}

function checkoutDisclosureMarkup(id,label,body,open){
  return `<details class="checkout-disclosure" data-checkout-disclosure="${id}"${open?" open":""}>`
    +`<summary><span>${escape(label)}</span><strong data-disclosure-value=""></strong></summary>`
    +`<div class="checkout-disclosure-body">${body}</div></details>`;
}

function checkoutBillMarkup(co){
  const {appointment:item,receipt}=co;
  const model=appointmentPresentation(item);
  const {checkedIn,finished,minutes,stored}=appointmentLifecycleValues(item,null);
  const invoice=receipt?.invoice||null;
  const frozen=Boolean(invoice);

  const services=model.serviceSnapshots.map(service=>
    `<div class="appointment-service-row" data-testid="checkout-service-row">`
      +`<span><strong>${escape(service.name)}</strong><small>${Number(service.durationMinutes)} min</small></span>`
      +`<strong>${service.priceMinor===null||service.priceMinor===undefined?"Price unavailable":money(service.priceMinor)}</strong>`
    +`</div>`).join("");

  // Absent, not disabled. `PUT /api/appointments/:id/services` refuses any status past in-service
  // and refuses outright once an invoice exists, so an edit affordance here could never do
  // anything but produce a refusal.
  const grants=checkoutGrantsDiscount();
  const options=checkoutDiscountOptions();
  const picker=options===null?""
    :options.length
      ?`<fieldset class="checkout-discounts" data-testid="checkout-discounts"><legend>Discounts</legend>`
        +options.map(option=>`<label class="checkout-discount">`
          +`<input type="checkbox" name="appliedDiscountId" value="${escapeAttr(option.id)}"`
          +` data-checkout-discount="${escapeAttr(option.id)}" data-testid="checkout-discount">`
          +`<span><strong>${escape(option.name)}</strong><small>${escape(discountValueText(option))}`
          // A percentage's apply scope changes no arithmetic, so it is not read back here either.
          +(option.kind==="percentage"?"":` · ${escape(discountApplyScopeLabel(option.applyScope))}`)
          +`</small></span></label>`).join("")
        +`</fieldset>`
      // `[]` IS AN EMPTY STATE, not an absent one: this operator may apply a discount and the
      // salon has configured none, which is worth saying to somebody who expected one.
      : `<p class="wide fine" data-testid="checkout-discount-empty">No discount is set up in Settings &rarr; Coupons &amp; discounts.</p>`;
  const oneOnly=picker&&checkoutStackingMode()==="one_per_appointment"
    ? `<p class="wide fine" data-testid="checkout-one-only">This salon applies one coupon or discount per appointment.</p>`
    : "";

  const money_=frozen
    // Every figure the server actually charged, from the invoice it wrote. Nothing is re-derived
    // once there is an authoritative answer.
    ? `<div class="checkout-line"><span>Subtotal</span><strong data-testid="checkout-subtotal">${money(invoice.subtotalMinor)}</strong></div>`
      +(invoice.discountMinor?`<div class="checkout-line"><span>Discount</span><strong>-${money(invoice.discountMinor)}</strong></div>`:"")
      +`<div class="checkout-line"><span>Tax</span><strong data-testid="checkout-tax">${money(invoice.taxMinor)}</strong></div>`
      +(invoice.tipMinor?`<div class="checkout-line"><span>Tip</span><strong>${money(invoice.tipMinor)}</strong></div>`:"")
      +`<div class="checkout-line is-total"><span>Total</span><strong>${money(invoice.totalMinor)}</strong></div>`
    : `<div class="checkout-line"><span>Subtotal</span><strong data-testid="checkout-subtotal">…</strong></div>`
      +`<div class="checkout-line" data-checkout-discount-line hidden><span>Discount</span><strong data-testid="checkout-discount-line">…</strong></div>`
      +`<div class="checkout-line"><span>Tax</span><strong data-testid="checkout-tax">…</strong></div>`
      +`<div class="checkout-line is-total"><span>Total</span><strong data-testid="checkout-total">…</strong></div>`;

  const disclosures=frozen
    // The invoice fixed all of this. Showing live editors over frozen figures would invite an
    // edit whose only possible outcome is a fingerprint mismatch on a second checkout write.
    ? `<p class="fine" data-testid="checkout-frozen">Invoice ${escape(invoice.invoiceNumber)} is already raised, so the services, discounts and tip are fixed. Only the payment is still open.</p>`
    : (grants?checkoutDisclosureMarkup("discount","+ Set discount",
        field("discount","Amount ($)","number",'min="0" step=".01" value="0"'),false):"")
      +checkoutDisclosureMarkup("coupon","+ Apply coupon or discount",
        picker+oneOnly
        +field("couponCode","Coupon code","text",
          'maxlength="40" autocomplete="off" spellcheck="false" autocapitalize="characters" class="coupon-code-input" placeholder="Optional"')
        // Filled as selections are made: with compounding the arithmetic is not obvious, and this
        // is where the operator can see what the customer will be charged before committing.
        +`<p class="wide checkout-running-total" role="status" aria-live="polite" data-testid="checkout-discount-total"></p>`,
        false)
      +checkoutDisclosureMarkup("tip","+ Add tip",checkoutTipFieldsMarkup(co),false);

  const lifecycle=`<div class="appointment-lifecycle" data-testid="checkout-lifecycle">`
    +`<span data-testid="lifecycle-in">Checked in: <strong${checkedIn?"":` class="is-unrecorded"`}>${escape(checkedIn?activityStamp(checkedIn):"not recorded")}</strong></span>`
    +`<span data-testid="lifecycle-out">Checked out: <strong${finished?"":` class="is-unrecorded"`}>${escape(finished?activityStamp(finished):"not recorded")}</strong></span>`
    +`<span data-testid="lifecycle-duration">Duration: <strong${minutes===null?` class="is-unrecorded"`:""}>${escape(lifecycleDurationLabel(minutes))}</strong></span>`
    +(stored?"":`<span class="fine lifecycle-note" data-testid="lifecycle-note">Times are read from the appointment's recorded activity.</span>`)
    +`</div>`;

  // The note the groomer left, beside the money it is being charged for. READ-ONLY: the only
  // endpoint that writes it, PATCH /api/appointments/:id/operations, accepts `checked_in` and
  // `in_service` only, and checkout is always entered at `completed` - so an editor here would be
  // a textarea whose save the server answers with 404.
  const note=item.operationalNotes
    ? `<div class="checkout-block"><h3>Service note</h3><p data-testid="checkout-service-note">${escape(item.operationalNotes)}</p></div>`
    : "";

  return `<div class="checkout-bill">`
    +`<div class="checkout-block"><h3>Client</h3>`
      +`<p><strong>${escape(model.customerName)}</strong></p>`
      +`<p>${escape(petName({petName:model.petName}))}${model.breed?` · ${escape(model.breed)}`:""}</p>`
      +`<p class="fine">${escape(model.dateLabel)} · ${escape(model.timeRange)} · ${escape(model.groomer)}</p></div>`
    +lifecycle
    +`<div class="checkout-block"><h3>Services</h3>${services}${money_}</div>`
    +(disclosures?`<div class="checkout-adjustments">${disclosures}</div>`:"")
    +note
  +`</div>`;
}

function checkoutTipFieldsMarkup(co){
  const presets=checkoutTipPercents();
  const row=presets.length
    ? `<div class="wide taxpay-tips" role="group" aria-label="Tip presets">`
      +presets.map(percent=>`<button type="button" class="secondary compact taxpay-tip-preset" data-taxpay-tip="${percent}" aria-pressed="false"${co.base===null?` disabled aria-disabled="true" title="${escapeAttr(TAXPAY_TIP_BASE_MISSING)}"`:""}>${percent}%</button>`).join("")
      +`<button type="button" class="secondary compact taxpay-tip-preset" data-taxpay-tip="none" aria-pressed="true">None</button></div>`
    : "";
  return row+field("tip","Tip ($)","number",'min="0" step=".01" value="0"');
}

function checkoutMethodMarkup(co){
  const methodOptions=co.choices.map(choice=>[choice.value,choice.label]);
  // A card terminal is a capture route rather than a settlement type: it is offered beside the
  // salon's methods because that is the one decision the operator is making, and choosing it hands
  // the tip to hardware that asks the customer directly.
  if(co.terminals.length)methodOptions.push([CHECKOUT_TERMINAL_METHOD,"Card terminal"]);
  // Last, and NEVER the default. `index===0` still checks the first salon method: spending a
  // client's balance is a decision, and a checkout that pre-selected it would drain accounts by
  // inattention. Absent at null (no client named, or the read failed) and absent at zero, because
  // an inert radio for a balance there is nothing to spend is furniture.
  const offersCredit=checkoutOffersCredit(co);
  if(offersCredit)methodOptions.push([CHECKOUT_CREDIT_METHOD,"Client credit"]);
  if(!methodOptions.length){
    return `<label class="wide">Method<select data-testid="field-method" name="method"><option value="" disabled selected>No payment method is enabled</option></select></label>`;
  }
  // Two to six read faster as chips at a counter than as a menu that has to be opened to be read.
  // Past that the chips stop being scannable and the select is the better control. The threshold
  // moves by one only when credit is offered, so adding the option cannot be what costs credit its
  // availability sub-label.
  const chipLimit=offersCredit?7:6;
  if(methodOptions.length>chipLimit){
    // The figure survives the control change: a <select> option carries no sub-label, so it is
    // folded into the option text and repeated under the control.
    const options=methodOptions.map(([value,label])=>value===CHECKOUT_CREDIT_METHOD
      ?[value,`${label} — ${money(co.creditAvailableMinor)} available`]
      :[value,label]);
    return select("method","Method",options,true,options[0][0])
      +(offersCredit?`<p class="fine" data-testid="checkout-credit-available">Client credit: ${money(co.creditAvailableMinor)} available.</p>`:"");
  }
  const single=co.terminals.length===1?co.terminals[0]:null;
  return `<fieldset class="checkout-methods" data-testid="field-method"><legend>Method</legend>`
    +methodOptions.map(([value,label],index)=>`<label class="checkout-method">`
      +`<input type="radio" name="method" value="${escapeAttr(value)}" data-testid="checkout-method"${index===0?" checked":""}>`
      +`<span>${escape(label)}`
      // One paired terminal is not a decision, so it is named rather than offered as a choice.
      +(single&&value===CHECKOUT_TERMINAL_METHOD?`<small data-testid="checkout-terminal-name">${escape(single.label)}</small>`:"")
      // Inside the radio's own label, so it is part of the accessible name: "Client credit $45.00
      // available".
      +(value===CHECKOUT_CREDIT_METHOD?`<small data-testid="checkout-credit-available">${money(co.creditAvailableMinor)} available</small>`:"")
      +`</span></label>`).join("")
    +`</fieldset>`;
}

function checkoutMoneyMarkup(co){
  if(checkoutMode(co)==="settled"){
    return `<div class="checkout-money checkout-settled">${receiptBodyMarkup(co.receipt)}</div>`;
  }
  // Only when there is a choice to make.
  const device=co.terminals.length>1
    ? `<label class="wide" data-checkout-device>Terminal<select data-testid="field-device" name="deviceId">`
      +co.terminals.map(entry=>`<option value="${escapeAttr(entry.id)}">${escape(entry.label)}</option>`).join("")
      +`</select></label>`
    : "";
  return `<div class="checkout-money">`
    +`<label class="checkout-pay" data-checkout-pay>Pay`
      +`<input data-testid="field-pay" name="pay" type="number" inputmode="decimal" step="0.01" min="0" required>`
    +`</label>`
    // Hidden until the amount actually exceeds the balance, and then labelled with the figure.
    // A permanently visible checkbox that is inert almost every time is furniture.
    +`<label class="checkout-remainder" data-testid="checkout-remainder" hidden>`
      +`<input type="checkbox" name="remainderToTip" data-testid="checkout-remainder-toggle">`
      +`<span data-remainder-label>Apply the remainder to tip</span>`
    +`</label>`
    +`<p class="fine" data-testid="checkout-coupon-pay-note" hidden>A coupon is priced when you check out, so this takes the full balance.</p>`
    +checkoutMethodMarkup(co)
    // Revealed only while credit is the chosen method, so it can afford to be tinted - the same
    // discipline `.checkout-remainder` follows. Nothing else about the ledger belongs on this
    // surface: who granted it, when and why sit behind `payments.view`, which the cashier standing
    // here may not hold.
    +(checkoutOffersCredit(co)
      ? `<p class="checkout-credit-note" data-testid="checkout-credit-note" hidden>${money(co.creditAvailableMinor)} on account. This settles the invoice from the client's balance — no money is collected.</p>`
      : "")
    +device
  +`</div>`;
}

function checkoutSurfaceMarkup(co){
  const mode=checkoutMode(co);
  const reference=String(co.appointment.id).slice(0,8);
  const receipt=co.receipt;
  const foot=`<footer class="surface-foot">`
    +`<p class="checkout-balance" role="status" aria-live="polite" data-testid="checkout-balance"></p>`
    +`<div class="surface-foot-actions">`
      // A RECEIPT ONLY ONCE SOMETHING HAS BEEN PAID. Before that the same page is an Invoice and
      // says so, under its own test id, so that "no Print Receipt on an unpaid invoice" is a
      // thing a test can assert rather than a label somebody has to read.
      +(receipt?(receiptHasPayment(receipt)
        ? `<button type="button" class="secondary compact" data-testid="checkout-print-receipt">Print Receipt</button>`
        : `<button type="button" class="secondary compact" data-testid="checkout-print-invoice">Print Invoice</button>`):"")
      // EVERY MODE, matching the appointment surface's own Ticket button and the header icon. The
      // Ticket is a work sheet that carries no money, so gating it on a settled bill was gating a
      // CRM document on a payment - the same conflation this screen's Print Receipt button had.
      // The old note here warned that stacking level 3 over an unfinished checkout is a trap
      // because level 2 holds a dirty guard; that guard fires when the CHECKOUT level is popped,
      // which is after the Ticket above it has already closed, and `confirm()` is a browser-level
      // dialog in any case.
      +`<button type="button" class="secondary compact" data-testid="checkout-ticket">Ticket</button>`
      +(mode==="settled"
        // Never "Take payment" on a zero balance. Returning to a screen still offering it is a
        // route to a double charge, whatever the reference does.
        ? `<button type="button" class="primary compact" data-testid="checkout-done">Done</button>`
        : `<button type="button" class="primary compact" data-testid="checkout-submit">Take payment</button>`)
    +`</div></footer>`;
  return `<div class="surface-shell" data-testid="checkout">`
    +`<header class="surface-head"><div class="surface-head-text">`
      +`<p class="appointment-reference" data-testid="checkout-reference">Check Out · #${escape(reference)}</p>`
      +`<h2 id="appointment-checkout-title">${escape(clientName(co.appointment))}</h2>`
      +`<p class="surface-subhead">${escape(appointmentPresentation(co.appointment).dateLabel)}</p>`
    +`</div>`
    +`<button type="button" class="surface-close" data-surface-close aria-label="Close check out">&#215;</button></header>`
    +`<div class="surface-body checkout-body">${checkoutBillMarkup(co)}${checkoutMoneyMarkup(co)}</div>`
    +`<p class="error" id="checkout-error" role="alert" data-testid="checkout-error"></p>`
    +foot
  +`</div>`;
}

async function checkout(id) {
  await ensureCheckoutPaymentOptions();
  await ensureCheckoutTerminal();
  let appointment=calendarAppointmentById(id);
  if(!appointment){try{appointment=await api(`/api/appointments/${id}`);}catch(error){toast(error.message);return;}}
  if(!appointment)return;

  const dialog=$("#appointment-checkout");
  const source=document.activeElement;
  const co={
    appointment,receipt:null,awaitingReceipt:null,
    choices:checkoutMethodChoices(),
    terminals:checkoutTerminal.data?.available?checkoutTerminal.data.devices:[],
    // Never guessed. Without the server's figure a percentage would be an invented one, so the
    // presets stand down and say why instead.
    base:null,
    // What THIS client has on account. Read below, and deliberately not from the shared cache.
    creditAvailableMinor:null
  };
  /**
   * The credit balance, read per customer on every open.
   *
   * NOT FROM `checkoutOptions.data`, AND NEVER WRITTEN BACK INTO IT. That cache is filled once, for
   * the whole session, by a request that names no customer - it holds the salon's methods, tip
   * presets, discounts and stacking mode, none of which are about anybody. `creditAvailableMinor`
   * is per-customer, so reusing the cache would show one client's balance while checking out
   * another, and populating it would poison every later checkout in the session.
   *
   * A failed read leaves it null and the option simply does not appear, matching this endpoint's
   * existing silence about a configuration it could not read.
   */
  if(appointment.customerId){
    try{
      const scoped=await api(`/api/checkout/payment-options?customerId=${encodeURIComponent(appointment.customerId)}`);
      co.creditAvailableMinor=typeof scoped?.creditAvailableMinor==="number"?scoped.creditAvailableMinor:null;
    }catch{co.creditAvailableMinor=null;}
  }
  const readBase=()=>{
    const subtotal=Number(co.appointment.servicesSubtotalMinor);
    co.base=Number.isFinite(subtotal)&&subtotal>=0?subtotal:null;
  };
  readBase();

  // True when the receipt on screen is the current one. A read that FAILED leaves whatever was
  // last known in place rather than reverting the screen to "no invoice", which would offer to
  // raise a second one.
  const loadReceipt=async()=>{
    const invoiceId=co.appointment.invoiceId;
    if(!invoiceId){co.receipt=null;return true;}
    try{co.receipt=await api(`/api/invoices/${invoiceId}/receipt`);return true;}
    catch{return false;}
  };
  if(!await loadReceipt()){toast("The invoice for this appointment could not be read.");return;}

  const level={
    id:"appointment-checkout",dialog,restoreFocus:source,
    // A checkout that never happened must not leave the screen underneath claiming otherwise, and
    // the level beneath - the appointment detail, when there is one - redraws itself.
    onClose(){
      receiptHost=null;
      runDetached(async()=>{
        if(state.me)await refresh();
        await appointmentStack.levels.at(-1)?.reload?.();
      });
    }
  };

  let baseline="";
  let host=null,submit=null,payField=null,tipField=null,couponField=null,manualField=null,remainder=null;

  const signature=()=>JSON.stringify({
    pay:payField?.value??"",tip:tipField?.value??"",coupon:couponField?.value??"",
    discount:manualField?.value??"",
    picked:host?[...host.querySelectorAll("[data-checkout-discount]:checked")].map(input=>input.value):[],
    remainder:Boolean(remainder?.checked)
  });
  // CHANGED, not "has been focused". Opening a disclosure, tabbing through the form or reading the
  // bill costs nothing to abandon, and a confirm on the way out of those would train the operator
  // to dismiss it without reading.
  level.guard=async()=>{
    if(checkoutMode(co)==="settled"||signature()===baseline)return true;
    return confirm("Leave this checkout? Nothing has been charged and the amounts you entered will be lost.");
  };

  const readMethod=()=>{
    const radios=[...(host?.querySelectorAll('input[name="method"]')||[])];
    if(radios.length)return radios.find(radio=>radio.checked)?.value||"";
    return String(host?.querySelector('[data-testid="field-method"]')?.value||"");
  };
  const couponValue=()=>String(couponField?.value||"").trim().toUpperCase();
  const tipMinor=()=>Math.round(Number(tipField?.value||0)*100);
  const payMinor=()=>{
    const raw=payField?.value;
    if(raw===undefined||raw==="")return null;
    const value=Math.round(Number(raw)*100);
    return Number.isFinite(value)&&value>=0?value:null;
  };
  const dueMinor=()=>checkoutMode(co)==="collect"
    ? Number(co.receipt.invoice.balanceMinor)
    : (checkoutEstimate(host,co.base,tipMinor())?.totalMinor??null);

  const setError=message=>{const target=dialog.querySelector("#checkout-error");if(target)target.textContent=message||"";};

  // Every figure on the screen that moves when a control moves.
  const syncMoney=()=>{
    if(!host)return;
    const mode=checkoutMode(co);
    if(mode==="settled"){
      const balance=dialog.querySelector('[data-testid="checkout-balance"]');
      if(balance)balance.textContent=`Balance ${money(co.receipt.invoice.balanceMinor)}`;
      return;
    }
    const coupon=couponValue();
    const estimate=mode==="build"?checkoutEstimate(host,co.base,tipMinor()):null;
    const due=dueMinor();

    if(mode==="build"){
      const cell=(testid,value)=>{const node=dialog.querySelector(`[data-testid="${testid}"]`);if(node)node.textContent=value;};
      cell("checkout-subtotal",estimate?money(estimate.subtotalMinor):"—");
      cell("checkout-tax",estimate?money(estimate.taxMinor):"—");
      cell("checkout-total",estimate?money(estimate.totalMinor):"—");
      const discountRow=dialog.querySelector("[data-checkout-discount-line]");
      if(discountRow){
        discountRow.hidden=!estimate?.discountMinor;
        const value=discountRow.querySelector("strong");
        if(value&&estimate)value.textContent=`-${money(estimate.discountMinor)}`;
      }
    }

    // A coupon lowers the balance by an amount only the server knows, so a part payment measured
    // against this screen's figure could exceed the real one. The amount field is withdrawn and
    // the full balance is taken - which is what this screen has always done.
    const payRow=dialog.querySelector("[data-checkout-pay]");
    const couponNote=dialog.querySelector('[data-testid="checkout-coupon-pay-note"]');
    const couponBlocks=Boolean(coupon)&&mode==="build";
    if(payRow)payRow.hidden=couponBlocks;
    if(couponNote)couponNote.hidden=!couponBlocks;
    if(payField)payField.required=!couponBlocks;

    // Revealed only while credit is the chosen method, and toggled with the `hidden` property
    // rather than a style, so it obeys the same `[hidden]{display:none!important}` rule everything
    // else on this surface does.
    const onCredit=readMethod()===CHECKOUT_CREDIT_METHOD;
    const creditNote=dialog.querySelector('[data-testid="checkout-credit-note"]');
    if(creditNote)creditNote.hidden=!onCredit;

    // Pre-filled with what is owed, and only once there is a figure to pre-fill it with. `base`
    // null means the server sent no subtotal, and a guess in this field would be a guess about
    // money: it stays empty and required instead.
    //
    // A part payment from credit is legitimate - the redemption is keyed on the PAYMENT, not the
    // invoice, precisely so several payments may settle one - so a balance smaller than the bill
    // pre-fills to the balance and the rest is taken another way.
    const prefill=onCredit&&checkoutOffersCredit(co)&&due!==null
      ? Math.min(due,co.creditAvailableMinor)
      : due;
    if(payField&&prefill!==null&&!payField.dataset.touched)payField.value=(prefill/100).toFixed(2);

    const pay=payMinor();
    const over=due!==null&&pay!==null?pay-due:0;
    if(remainder){
      // Pre-invoice only. `claimTerminalCheckout` refuses to start against an invoice whose tip is
      // non-zero and `postReconciledPayment` raises the tip under `tip_minor = 0`, so a
      // post-invoice tip raise either blocks the terminal for that invoice or collides with that
      // fence. The remainder folds into `tipMinor` at invoice creation or not at all.
      const offer=mode==="build"&&!couponBlocks&&over>0;
      const row=remainder.closest("[data-testid='checkout-remainder']");
      if(row)row.hidden=!offer;
      if(!offer)remainder.checked=false;
      const label=row?.querySelector("[data-remainder-label]");
      if(label&&offer)label.textContent=`Apply ${money(over)} remainder to tip`;
    }

    const balance=dialog.querySelector('[data-testid="checkout-balance"]');
    if(balance){
      const parts=[];
      if(due===null)parts.push("Balance is not available");
      else parts.push(`Balance ${money(due)}`);
      if(couponBlocks)parts.push("the coupon comes off when you check out");
      else if(due!==null&&pay!==null&&pay<due)parts.push(`${money(due-pay)} will remain`);
      // What is left ON ACCOUNT afterwards, which is a different figure from what is left owed.
      // This line is already role="status" aria-live="polite", so it is announced when the method
      // changes.
      if(onCredit&&checkoutOffersCredit(co)&&pay!==null&&pay<=co.creditAvailableMinor){
        parts.push(`${money(co.creditAvailableMinor-pay)} credit will remain`);
      }
      balance.textContent=parts.join(" · ");
    }
  };

  const draw=()=>{
    dialog.innerHTML=checkoutSurfaceMarkup(co);
    host=dialog.querySelector(".surface-shell");
    submit=dialog.querySelector('[data-testid="checkout-submit"]');
    payField=dialog.querySelector('[data-testid="field-pay"]');
    tipField=dialog.querySelector('[data-testid="field-tip"]');
    couponField=dialog.querySelector('[data-testid="field-couponCode"]');
    manualField=dialog.querySelector('[data-testid="field-discount"]');
    remainder=dialog.querySelector('[data-testid="checkout-remainder-toggle"]');
    bind();
    syncMoney();
    baseline=signature();
  };

  const redrawSettled=async()=>{
    await loadReceipt();
    draw();
  };

  // The one thing the button does while a payment is recorded but its receipt has not been read.
  const retryReceipt=async()=>{
    if(!await loadReceipt()){
      setError("Payment recorded successfully. Receipt is temporarily unavailable.");
      return;
    }
    co.awaitingReceipt=null;
    draw();
  };

  const bind=()=>{
    dialog.querySelector("[data-surface-close]")?.addEventListener("click",()=>runDetached(()=>popStackLevel()));
    dialog.querySelector('[data-testid="checkout-done"]')?.addEventListener("click",()=>runDetached(()=>popStackLevel()));
    // One handler, both labels: which document gets printed is decided inside
    // `printFinancialDocument`, off the payments, so the two buttons cannot disagree with the page.
    dialog.querySelectorAll('[data-testid="checkout-print-receipt"],[data-testid="checkout-print-invoice"]')
      .forEach(button=>button.addEventListener("click",()=>{
        if(co.receipt)printFinancialDocument(co.receipt);
      }));
    // NO RECEIPT IS HANDED UP. The Ticket is a work sheet and carries no money at all, so the
    // receipt this surface is holding is not its business; the bill stays here, on the screen that
    // took the payment.
    dialog.querySelector('[data-testid="checkout-ticket"]')?.addEventListener("click",()=>runDetached(()=>
      runOnce(`ticket:${co.appointment.id}`,()=>openTicket(co.appointment))));
    if(checkoutMode(co)==="settled"){
      bindReceiptActions(dialog,co.receipt);
      return;
    }
    // Open a disclosure that already carries a value, and name the value in its own summary, so a
    // collapsed adjustment is never a hidden one.
    const syncDisclosures=()=>{
      const set=(id,text)=>{
        const details=dialog.querySelector(`[data-checkout-disclosure="${id}"]`);
        if(!details)return;
        const value=details.querySelector("[data-disclosure-value]");
        if(value)value.textContent=text||"";
        if(text&&!details.open)details.open=true;
      };
      const manual=Math.round(Number(manualField?.value||0)*100);
      set("discount",manual>0?`−${money(manual)}`:"");
      const picked=[...(host?.querySelectorAll("[data-checkout-discount]:checked")||[])].length;
      const coupon=couponValue();
      set("coupon",[picked?`${picked} selected`:"",coupon].filter(Boolean).join(" · "));
      set("tip",tipMinor()>0?money(tipMinor()):"");
    };
    const changed=()=>{syncDisclosures();syncMoney();};

    bindCheckoutDiscounts(co.base,host,changed);
    bindCheckoutTips(co.base,host);
    tipField?.addEventListener("input",changed);
    payField?.addEventListener("input",()=>{payField.dataset.touched="1";syncMoney();});
    remainder?.addEventListener("change",syncMoney);
    // The tip presets write into the field without dispatching, so the summary and the balance are
    // brought along by the same click rather than waiting for the next keystroke.
    dialog.querySelectorAll("[data-taxpay-tip]").forEach(button=>button.addEventListener("click",changed));
    bindCheckoutCapture({
      host,submit,submitLabel:"Take payment",
      // Where the amount was, not where the tip was: the tip controls live inside a collapsed
      // disclosure on this screen, and a note put in there would never be seen.
      noteAnchor:dialog.querySelector('[data-testid="field-method"]'),
      // The amount leaves with the tip: the terminal derives both from the invoice and asks the
      // customer directly, so two places to enter the same number would be one too many.
      extra:[dialog.querySelector("[data-checkout-pay]"),dialog.querySelector('[data-testid="checkout-remainder"]')],
      note:"Amount and tip are taken on the terminal.",
      onChange:syncMoney
    });
    syncDisclosures();
    submit?.addEventListener("click",()=>runDetached(submitCheckout));
  };

  const submitCheckout=async()=>{
    if(!submit||submit.disabled)return;
    setError("");
    if(co.awaitingReceipt){
      submit.disabled=true;
      try{await retryReceipt();}finally{if(submit.isConnected)submit.disabled=false;}
      return;
    }
    const mode=checkoutMode(co);
    const onTerminal=readMethod()===CHECKOUT_TERMINAL_METHOD;
    // The credit sentinel is tolerated exactly as the terminal one is: neither names a configured
    // `payment_methods` row, so neither has a `choice` to look up.
    const onCredit=readMethod()===CHECKOUT_CREDIT_METHOD;
    const choice=onTerminal||onCredit?null:co.choices.find(item=>String(item.value)===String(readMethod()));
    if(!onTerminal&&!onCredit&&!choice){
      setError(co.choices.length
        ?"Choose a payment method."
        :"No payment method is enabled. Enable one in Settings → Tax & payments.");
      return;
    }
    const coupon=couponValue();
    const due=dueMinor();
    const pay=payMinor();
    const usesAmount=!onTerminal&&!(mode==="build"&&coupon);
    if(usesAmount){
      if(pay===null||pay<=0){setError("Enter the amount to take.");return;}
      if(due!==null&&pay>due&&!(mode==="build"&&remainder?.checked)){
        setError(mode==="build"
          ? `That is ${money(pay-due)} more than the balance. Tick the remainder box to put it in the tip, or lower the amount.`
          : `Payment exceeds invoice balance by ${money(pay-due)}.`);
        return;
      }
      // Refused here rather than discovered as a 409, which would have raised the invoice first on
      // a build. The server re-reads the balance under a row lock and its answer still wins.
      if(onCredit&&pay!==null&&pay>Number(co.creditAvailableMinor??0)){
        setError(`That is more than the ${money(co.creditAvailableMinor??0)} this client has on account. `
          +`Lower the amount, or take the rest another way.`);
        return;
      }
    }
    const original=submit.textContent;
    submit.disabled=true;submit.textContent="Working…";
    let raised=false;
    try{
      let invoice=co.receipt?.invoice||null;
      if(mode==="build"){
        const manualMinor=checkoutGrantsDiscount()?Math.round(Number(manualField?.value||0)*100):0;
        const remainderMinor=usesAmount&&remainder?.checked&&due!==null&&pay!==null?Math.max(0,pay-due):0;
        const invoicePayload={
          discountMinor:manualMinor,
          discountType:manualMinor>0?"manual":null,
          couponCode:coupon||null,
          // IDS ONLY, NEVER AN AMOUNT. The server looks every one of these up and recomputes what
          // it takes off, in the order the picker offers them - the salon's own order, which the
          // server uses to break ties within a stacking rank.
          appliedDiscountIds:[...host.querySelectorAll("[data-checkout-discount]:checked")].map(input=>input.value),
          // Zero, always, for a terminal capture: the tip is raised onto the invoice afterwards by
          // exactly what the customer chose on the device, and a guess here would have to be undone.
          tipMinor:onTerminal?0:tipMinor()+remainderMinor
        };
        try{invoice=await financialMutation(`/api/appointments/${id}/checkout`,`checkout.create-invoice`,invoicePayload);}
        catch(error){
          if(error.data?.code==="INVOICE_ALREADY_EXISTS"&&error.data.invoice){
            error.message=`${error.message}. Authoritative total: ${money(error.data.invoice.totalMinor)}.`;
          }
          throw error;
        }
        raised=true;
      }
      if(onTerminal){
        if(Number(invoice.balanceMinor)<=0){await redrawSettled();return;}
        const deviceId=String(dialog.querySelector('[data-testid="field-device"]')?.value||"");
        const device=co.terminals.find(entry=>entry.id===deviceId)||co.terminals[0];
        if(!device)throw new Error("No terminal is paired. Pair one in Settings → Tax & payments.");
        let started;
        try{
          // Keyed on the invoice, which is what stays stable across the retry this failure invites.
          // A client-generated Idempotency-Key would be inert: the route dedupes on the checkout
          // row it claims before calling Square, not on a header.
          started=await runOnce(`terminal-start:${invoice.id}`,()=>api(`/api/invoices/${invoice.id}/terminal-checkouts`,
            {method:"POST",body:JSON.stringify({deviceId:device.id})}));
          // `runOnce` resolves to nothing when an identical start is already in flight. That is a
          // double-press rather than an outcome.
          if(!started){toast("Already sending to the terminal");return;}
        }catch(error){
          error.message=`Invoice created; the terminal did not start. ${error.message}`;
          throw error;
        }
        co.appointment.invoiceId=invoice.id;
        await loadReceipt();draw();
        toast("Sent to the terminal");
        // A status dialog over Check Out, not a level of the stack: it is watching one request,
        // and Escape on it must answer to its own guard rather than dismissing the bill beneath.
        $("#terminal-capture").addEventListener("close",()=>runDetached(async()=>{
          if(!appointmentStack.levels.includes(level))return;
          co.appointment=calendarAppointmentById(id)||co.appointment;
          readBase();await loadReceipt();draw();
        }),{once:true});
        openTerminalCapture(started,device.label);
        return;
      }
      if(Number(invoice.balanceMinor)>0){
        // A coupon, or a "pay it all" that the server priced slightly differently, both mean the
        // authoritative balance rather than this screen's figure. A part payment is the operator's
        // own number and is sent as typed.
        const full=!usesAmount||pay===null||due===null||pay>=due;
        const amountMinor=full?Number(invoice.balanceMinor):pay;
        try{
          const payment=await financialMutation(`/api/invoices/${invoice.id}/payments`,`payment.record`,{
            amountMinor,expectedBalanceMinor:Number(invoice.balanceMinor),
            // `client_credit` directly: there is no configured method row for it, so there is no
            // settlement type to read off a choice that does not exist.
            method:onCredit?"client_credit":choice.settlementType
          });
          // What is LEFT on the account, from the payment's own response, so the screen neither
          // guesses nor re-requests the options endpoint. Null on that field means the payment was
          // not credit, and `co` is left alone.
          if(typeof payment?.creditRemainingMinor==="number")co.creditAvailableMinor=payment.creditRemainingMinor;
        }catch(error){
          // A race: somebody spent the balance while this screen was open. The route's own stated
          // intent is to offer what is actually there, so the figure it sends back is taken.
          if(error.status===409&&error.data?.code==="CREDIT_BALANCE_INSUFFICIENT"
            &&typeof error.data.creditAvailableMinor==="number"){
            co.creditAvailableMinor=error.data.creditAvailableMinor;
          }
          // Only when this submit is what raised the invoice. Against one that was already there
          // the sentence would be inventing an event, and the server's own words are the whole
          // story: the balance moved under this screen.
          if(mode==="build")error.message=`Invoice created; payment remains pending. ${error.message}`;
          throw error;
        }
      }
      co.appointment.invoiceId=invoice.id;
      if(state.me)await refresh();
      co.appointment=calendarAppointmentById(id)||co.appointment;
      readBase();
      if(!await loadReceipt()){
        // The money is recorded; only the read of it failed. The surface keeps the invoice it just
        // paid and the button becomes a retry of that read - it can never take a second payment.
        co.awaitingReceipt=invoice.id;
        setError("Payment recorded successfully. Receipt is temporarily unavailable.");
        return;
      }
      co.awaitingReceipt=null;
      draw();
      toast(checkoutMode(co)==="settled"?"Payment recorded":"Part payment recorded");
    }catch(error){
      setError(error.message);
      // A REFUSAL IS NOT A REASON TO REDRAW. An expired coupon, a method nobody chose, an amount
      // over the balance - none of them moved the bill, and redrawing would collapse the
      // disclosures and throw away what the operator typed, which is exactly what the shared
      // dialog was careful not to do. Only a failure that happened after the invoice existed can
      // have left this screen describing something that is no longer true.
      if(raised||mode!=="build"){
        const message=error.message;
        await loadReceipt();
        draw();setError(message);
      }
    }finally{
      const live=dialog.querySelector('[data-testid="checkout-submit"]');
      if(live===submit&&submit.isConnected){submit.disabled=false;submit.textContent=original;}
    }
  };

  draw();
  // A void or a refund taken from a settled Check Out redraws it in place rather than closing the
  // surface and stacking a modal copy of the same receipt on top of it.
  receiptHost=receipt=>{
    if(!appointmentStack.levels.includes(level))return false;
    co.receipt=receipt;draw();return true;
  };
  pushStackLevel(level);
}

function bindCheckoutCapture({host=$("#modal-fields"),submit=$('[data-testid="modal-submit"]'),
  extra=[],note:noteText="Tip is taken on the terminal",noteAnchor=null,submitLabel="Save",onChange=null}={}){
  if(!host)return;
  // The method control is a <select> in the shared dialog and a radio group on the Check Out
  // surface. Both carry `field-method`; only the read and the listener differ.
  const methodHost=host.querySelector('[data-testid="field-method"]');if(!methodHost)return;
  const radios=[...host.querySelectorAll('input[name="method"]')];
  const readMethod=()=>radios.length?(radios.find(radio=>radio.checked)?.value||""):String(methodHost.value);
  const presets=host.querySelector(".taxpay-tips");
  const tipField=host.querySelector('[data-testid="field-tip"]')?.closest("label");
  const device=host.querySelector("[data-checkout-device]");
  // Each withdrawn element keeps its own place through its own comment anchor, so restoring puts
  // every one of them back where it was rather than all of them in one pile.
  const parked=[presets,tipField,...extra].filter(Boolean).map(element=>{
    const anchor=document.createComment("checkout-withdrawn");
    element.before(anchor);
    return {element,anchor};
  });
  const note=document.createElement("p");
  note.className="wide fine checkout-terminal-note";
  note.setAttribute("data-testid","checkout-terminal-note");
  note.textContent=noteText;
  // Where the note lands when the controls it replaces are gone. The shared dialog puts it where
  // the tip controls were; Check Out cannot, because its tip controls live inside a collapsed
  // disclosure and a note injected in there would be invisible - so the caller names a place.
  const notePlace=noteAnchor||parked[0]?.anchor||null;
  // A named anchor is an element the note goes BEFORE; the fallback is the comment left where the
  // first withdrawn control stood, which it goes after.
  const placeNote=()=>{
    if(!notePlace||note.isConnected)return;
    if(noteAnchor)notePlace.before(note);else notePlace.after(note);
  };
  const deviceAnchor=document.createComment("checkout-device");
  device?.before(deviceAnchor);
  device?.remove();
  const apply=()=>{
    const onTerminal=readMethod()===CHECKOUT_TERMINAL_METHOD;
    if(onTerminal){
      parked.forEach(({element})=>element.remove());
      placeNote();
      if(device&&!device.isConnected)deviceAnchor.after(device);
    }else{
      note.remove();device?.remove();
      // Restored in reverse, because each one is put back immediately after its own anchor and
      // the anchors sit in source order.
      [...parked].reverse().forEach(({element,anchor})=>{if(!element.isConnected)anchor.after(element);});
    }
    // "Save" is what every other dialog does. This one hands a request to a card reader that is
    // about to ask a customer for money, and the button should say so before it is pressed.
    if(submit)submit.textContent=onTerminal?"Send to terminal":submitLabel;
    onChange?.(onTerminal);
  };
  if(radios.length)radios.forEach(radio=>radio.addEventListener("change",apply));
  else methodHost.addEventListener("change",apply);
  apply();
}
function bindCheckoutTips(base,host=$("#modal-fields")){
  if(!host)return;
  const tipInput=host.querySelector('[data-testid="field-tip"]');
  // Absent for anybody without `discounts.apply`, and the presets still have to work for them.
  // Requiring it here is what used to make the tip buttons inert on exactly the sessions that
  // most need them.
  const discountInput=host.querySelector('[data-testid="field-discount"]');
  const buttons=[...host.querySelectorAll("[data-taxpay-tip]")];
  if(!tipInput||!buttons.length)return;
  // What the visit charges for the work, less every discount the browser can see — the taxable
  // subtotal the invoice is built from. The service prices are never re-summed here: the server
  // already owns that total and sends it with the appointment, and a second opinion about it is a
  // bug waiting.
  const baseMinor=()=>checkoutDiscountedBase(host,base);
  const amountFor=percent=>Math.round(baseMinor()*Number(percent)/100);
  let active="none";
  const sync=()=>buttons.forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.taxpayTip===active)));
  buttons.forEach(button=>button.addEventListener("click",()=>{
    active=button.dataset.taxpayTip;
    tipInput.value=active==="none"?"0":(amountFor(active)/100).toFixed(2);
    sync();
  }));
  // A typed amount is the operator's own, so no preset claims it — unless they cleared it, which
  // is what "None" means.
  tipInput.addEventListener("input",()=>{
    active=Math.round(Number(tipInput.value||0)*100)===0?"none":null;sync();
  });
  // A discount moves the base a percentage is taken of, so a chosen preset follows it — whether
  // it was typed into the manual field or picked out of the catalogue.
  const followBase=()=>{
    if(active&&active!=="none"&&base!==null)tipInput.value=(amountFor(active)/100).toFixed(2);
    sync();
  };
  discountInput?.addEventListener("input",followBase);
  host.querySelectorAll("[data-checkout-discount]").forEach(input=>
    input.addEventListener("change",followBase));
  // Uppercased as focus leaves, so what is on screen is the code that will be sent.
  const couponInput=host.querySelector('[data-testid="field-couponCode"]');
  couponInput?.addEventListener("change",()=>{couponInput.value=couponInput.value.trim().toUpperCase();});
  sync();
}
/**
 * Every discount the browser can see on this bill, as `foldDiscounts` lines.
 *
 * THE COUPON IS NOT AMONG THEM. What it takes off is resolved by the server against the coupon
 * row - it may be a percentage of a number that is not final yet, and it may be refused outright -
 * so the browser does not know the figure, and inventing one would put a total on screen that the
 * invoice then contradicts.
 */
function checkoutDiscountLines(host){
  const lines=[];
  const manual=host.querySelector('[data-testid="field-discount"]');
  const manualMinor=manual&&!manual.disabled?Math.round(Number(manual.value||0)*100):0;
  // First, matching the order the server folds them in: the manual amount, then the configured
  // rows. Within a stacking rank that order is the tie-break, so the two have to agree.
  if(manualMinor>0)lines.push({kind:"amount",amountMinor:manualMinor});
  const options=checkoutDiscountOptions()||[];
  host.querySelectorAll("[data-checkout-discount]:checked").forEach(input=>{
    const option=options.find(item=>item.id===input.dataset.checkoutDiscount);
    if(option)lines.push({kind:option.kind,amountMinor:option.amountMinor,rateBasisPoints:option.rateBasisPoints});
  });
  return lines;
}
/** The taxable subtotal as the browser can compute it. Zero when the server sent no subtotal. */
function checkoutDiscountedBase(host,base){
  if(base===null)return 0;
  return foldDiscounts(base,checkoutDiscountLines(host),checkoutStackingMode()).total;
}
/**
 * Stops the operator at one when the salon allows one.
 *
 * The manual amount, each picked row AND a typed coupon code all count as one of them - that is
 * what `resolveCheckoutDiscounts` counts, so anything looser here leaves a
 * MULTIPLE_DISCOUNTS_NOT_ALLOWED refusal reachable at the end of a checkout.
 *
 * DISABLED, NOT HIDDEN, and only what is empty: whatever carries the selection stays live, so
 * clearing it is the obvious way back and no control the operator has already filled in goes grey
 * underneath them.
 */
function applyCheckoutDiscountLimit(host){
  if(checkoutStackingMode()!=="one_per_appointment")return;
  const options=[...host.querySelectorAll("[data-checkout-discount]")];
  const manual=host.querySelector('[data-testid="field-discount"]');
  const coupon=host.querySelector('[data-testid="field-couponCode"]');
  const manualSet=Boolean(manual&&Math.round(Number(manual.value||0)*100)>0);
  const couponSet=Boolean(coupon&&coupon.value.trim());
  const taken=options.filter(input=>input.checked).length+(manualSet?1:0)+(couponSet?1:0);
  options.forEach(input=>{input.disabled=taken>0&&!input.checked;});
  if(manual)manual.disabled=taken>0&&!manualSet;
  if(coupon)coupon.disabled=taken>0&&!couponSet;
}
/**
 * The picker, the one-per rule and the running total.
 *
 * The total is only ever about what the BROWSER can price: the manual amount and the picked rows.
 * A coupon in the box is named beside it rather than folded into it, because saying nothing at all
 * would let the figure read as the final one.
 */
function bindCheckoutDiscounts(base,host=$("#modal-fields"),onChange=null){
  if(!host)return;
  const total=host.querySelector('[data-testid="checkout-discount-total"]');
  const coupon=host.querySelector('[data-testid="field-couponCode"]');
  const manual=host.querySelector('[data-testid="field-discount"]');
  const options=[...host.querySelectorAll("[data-checkout-discount]")];
  const refresh=()=>{
    applyCheckoutDiscountLimit(host);
    if(!total)return;
    const fold=base===null?null:foldDiscounts(base,checkoutDiscountLines(host),checkoutStackingMode());
    // Nothing taken off, nothing to say. A permanent "$85.00 = $85.00" would be a line about the
    // product rather than about this visit.
    if(!fold||!fold.discountMinor){total.textContent="";return;}
    const sentence=`${money(fold.subtotal)} − ${money(fold.discountMinor)} = ${money(fold.total)} before tax`;
    total.textContent=coupon?.value.trim()
      ? `${sentence}. The coupon comes off on top when you check out.`
      : sentence;
  };
  const changed=()=>{refresh();onChange?.();};
  options.forEach(input=>input.addEventListener("change",changed));
  manual?.addEventListener("input",changed);
  coupon?.addEventListener("input",changed);
  refresh();
}
// The refunds already asked for against one payment, newest last.
//
// Read off the receipt rather than fetched per payment: the receipt already carries them, and a
// request per row would make opening a receipt cost one call per payment on it.
function receiptRefundsFor(receipt,paymentId){
  return (receipt.refunds||[]).filter(refund=>refund.paymentId===paymentId);
}

// What is left to refund on a payment, as the receipt can see it.
//
// Pending refunds count against it. They have moved no money yet, but the money is spoken for, and
// offering it again would invite a second refund of the same funds - which the server would refuse,
// but only after the operator had typed an amount and pressed a button expecting it to work.
function receiptRefundableMinor(receipt,payment){
  const committed=receiptRefundsFor(receipt,payment.id)
    .filter(refund=>refund.status!=="failed")
    .reduce((sum,refund)=>sum+Number(refund.amountMinor||0),0);
  return Math.max(0,Number(payment.amountMinor||0)-committed);
}

// One refund, as a line under the payment it came out of.
//
// NOTHING HERE SAYS "REFUNDED" UNTIL THE SERVER SAYS `settled`, which it only does once the
// retrieved Square refund reported COMPLETED. A pending refund says it is waiting and offers the
// same "check with the processor" recovery the terminal capture offers, because the webhook that
// would have settled it can be missed.
function receiptRefundRow(refund){
  const detail=refund.failed&&refund.failureReason?escape(refund.failureReason)
    :refund.inFlight?"Waiting for the card processor to confirm."
    :refund.reason?escape(refund.reason)
    :"";
  const tip=refund.tipRefundedMinor
    ? ` · ${money(refund.tipRefundedMinor)} of this came out of the tip`
    :"";
  const when=refund.settledAt||refund.createdAt;
  const action=refund.inFlight&&allowed("checkout.perform")
    ? `<button type="button" class="text-button refund-refresh" data-refund-id="${refund.id}">Check refund</button>`
    :"";
  return `<div class="receipt-refund is-${escape(refund.status)}" data-testid="receipt-refund" data-refund-status="${escape(refund.status)}">`
    +`<span><strong>${escape(refund.label)}</strong>`
    +`<small>${escape(formatPrefDate(new Date(when)))}${tip}</small>`
    +(detail?`<small class="fine">${detail}</small>`:"")
    +`</span>`
    // A minus sign, because this is money leaving. Only a settled refund is shown as an amount
    // that has moved; a pending one is shown in brackets so nobody reads it as done.
    +`<strong class="receipt-refund-amount">${refund.settled?`-${money(refund.amountMinor)}`:`(${money(refund.amountMinor)})`}</strong>`
    +action
    +`</div>`;
}

/**
 * The receipt itself: items, the discount breakdown, the totals, and every payment record with
 * whatever correction it still allows.
 *
 * ONE BODY, TWO HOSTS. The modal shows it, and so does a settled Check Out - because a settled
 * checkout IS the receipt, and rendering a second, thinner version of it beside the real one is
 * how the two drift. `bindReceiptActions` binds whichever copy is on screen.
 *
 * THE BODY IS SHARED; THE DOCUMENT'S NAME IS NOT. This is the money statement of an invoice, and
 * an invoice with nothing paid against it has one too - "No payment recorded" below is exactly
 * that case. What the page is CALLED is decided by `financialDocumentTitle`, off the payments, and
 * never here.
 */
function receiptBodyMarkup(receipt) {
  const invoice=receipt.invoice;
  // A payment taken on a terminal is named as one. "External card" is the settlement type the
  // ledger records, and it is what a manually keyed card payment says too; on a receipt somebody
  // reads at a counter, the difference between the two is the difference between money Pawsh can
  // point at in a card processor and money it cannot.
  //
  // THE ACTION ON A PAYMENT DEPENDS ON WHETHER PAWSH TOOK THE MONEY. A terminal payment offers
  // Refund and never Void, because voiding it would delete the record while the customer's card
  // stayed charged - and the server refuses it now, so offering the button would only be a way to
  // reach an error. Everything else offers Void, which is still the right correction for a
  // mis-keyed cash, cheque or external-card record: Pawsh never moved that money and cannot.
  const payments=receipt.payments.map(payment=>{
    const refundable=receiptRefundableMinor(receipt,payment);
    // Nothing left to refund has two different causes and they must not share a sentence. If a
    // refund is still in flight the money is only spoken for, not returned, and "Fully refunded"
    // would be a claim the row directly below it contradicts - so that case says nothing here and
    // lets the refund row speak for itself.
    const inFlight=receiptRefundsFor(receipt,payment.id).some(refund=>refund.status==="pending");
    const action=payment.status!=="recorded"||!allowed("checkout.perform")?""
      :payment.provider
        ?(refundable>0
          ? `<button type="button" class="text-button refund-payment" data-payment-id="${payment.id}" data-testid="refund-payment">Refund</button>`
          : inFlight
            ? ""
            : `<span class="fine" data-testid="refund-exhausted">Fully refunded</span>`)
        // A credit payment has no provider, so it falls here - which is right: voiding is exactly
        // how a mis-applied credit payment is undone, and the void route writes the
        // `redemption_reversal` that puts the money back on the client's balance. The method
        // travels on the button so the confirmation can say what will actually happen.
        :`<button type="button" class="text-button void-payment" data-payment-id="${payment.id}" data-payment-provider="" data-payment-method="${escapeAttr(payment.method)}">Void record</button>`;
    return `<div><span>${escape(payment.provider==="square"?"card terminal":paymentMethodLabel(payment.method))} · ${escape(payment.status)}</span><strong>${money(payment.amountMinor)}</strong>${action}</div>`
      +receiptRefundsFor(receipt,payment.id).map(receiptRefundRow).join("");
  }).join("");
/**
 * What one line of the receipt's discount breakdown is called.
 *
 * `nameSnapshot` IS NULLABLE, and it can also be the literal `"manual"` - the token the checkout
 * dialog has always sent as `discountType` - so neither of those reaches the reader. Both render
 * as "Discount", which is exactly what every receipt said before there was a breakdown to show.
 * A legacy invoice whose `discount_type` was a real label keeps it, because the 0048 backfill
 * carried that column through verbatim and inventing a name here would rewrite what those
 * receipts say.
 */
function receiptDiscountName(row){
  const name=String(row.nameSnapshot||"").trim();
  return name&&name!=="manual"?name:"Discount";
}
/**
 * What came off this bill, and why, IN APPLIED ORDER.
 *
 * The order is what makes the compounding legible - the second line took its percentage off what
 * the first line left - so it is rendered as the server sent it and never re-sorted.
 *
 * An invoice with no rows at all is one from before the breakdown existed, or one that took
 * nothing off, and it renders the single line this receipt has always rendered.
 */
function receiptDiscountLines(receipt,invoice){
  const rows=Array.isArray(receipt.discounts)?receipt.discounts:[];
  if(!rows.length){
    return `<div data-testid="receipt-discount"><span>Discount</span><strong>-${money(invoice.discountMinor)}</strong></div>`;
  }
  // Indented, and only when a sum follows them: two lines both reading "Discount" - one a step,
  // one the total - is the one way this breakdown can be misread.
  const step=rows.length>1?` class="receipt-discount-step"`:"";
  const lines=rows.map(row=>`<div${step} data-testid="receipt-discount"><span>${escape(receiptDiscountName(row))}`
    // The rate is worth repeating on a percentage line: "-$8.00" alone does not say that it was
    // 10% of what was left, which is the whole reason two lines can produce two different totals.
    +(row.kindSnapshot==="percentage"?` <small class="receipt-discount-rate">${escape(taxPayPercent(row.rateBasisPointsSnapshot))}%</small>`:"")
    +`</span><strong>-${money(row.appliedMinor)}</strong></div>`).join("");
  // The sum, only when there is more than one thing to add up. `invoice_discounts` sums to
  // `discount_minor` exactly, so this is the same number the tax underneath was taken after.
  return lines+(rows.length>1
    ?`<div data-testid="receipt-discount-total"><span>Total discount</span><strong>-${money(invoice.discountMinor)}</strong></div>`
    :"");
}
  // Shown only when there is one. A permanent "Refunded $0.00" row would read as a fact about the
  // visit rather than about the product, on every receipt a salon ever prints.
  const refundedLine=receipt.refundedMinor
    ? `<div class="receipt-refunded" data-testid="receipt-refunded"><span>Refunded</span><strong>-${money(receipt.refundedMinor)}</strong></div>`
    :"";
  return `<div class="wide receipt" data-testid="receipt"><p><strong>${escape(invoice.businessName)}</strong></p><p>${escape(clientName(invoice))}</p>${receipt.items.map(item=>`<div><span>${escape(item.description)}</span><strong>${money(item.amountMinor)}</strong></div>`).join("")}<div><span>Subtotal</span><strong>${money(invoice.subtotalMinor)}</strong></div>${receiptDiscountLines(receipt,invoice)}<div><span>Tax</span><strong>${money(invoice.taxMinor)}</strong></div><div><span>Tip</span><strong>${money(invoice.tipMinor)}</strong></div><div class="receipt-total"><span>Total</span><strong>${money(invoice.totalMinor)}</strong></div><div><span>Balance</span><strong>${money(invoice.balanceMinor)}</strong></div>${refundedLine}<h4>Payment records</h4>${payments||"<p>No payment recorded.</p>"}</div>`;
}

// Scoped to the copy of the receipt that was just rendered, for the same reason the client summary
// column's bindings are: the modal's copy and a settled Check Out's copy can both be in the DOM.
function bindReceiptActions(root,receipt){
  const invoice=receipt.invoice;
  root.querySelectorAll(".void-payment").forEach(button=>button.addEventListener("click",()=>
    voidPayment(button.dataset.paymentId,invoice.id,button.dataset.paymentProvider,
      button.dataset.paymentMethod,
      // The amount comes off the receipt this binding was scoped to rather than off a fifth data
      // attribute: the sentence a credit void has to say names the money going back.
      Number(receipt.payments.find(payment=>payment.id===button.dataset.paymentId)?.amountMinor??0))));
  root.querySelectorAll(".refund-payment").forEach(button=>button.addEventListener("click",()=>runDetached(()=>openRefundDialog(
    invoice.id,receipt.payments.find(payment=>payment.id===button.dataset.paymentId)))));
  root.querySelectorAll(".refund-refresh").forEach(button=>button.addEventListener("click",()=>runDetached(()=>
    refreshRefund(button.dataset.refundId,invoice.id))));
}

// The same page in a dialog, titled by the same rule. An unpaid invoice opened from a client's
// transaction history is headed "Invoice #1042", not "Receipt #1042".
function showFinancialDocument(receipt){
  openModal(financialDocumentTitle(receipt),receiptBodyMarkup(receipt),async()=>{});
  bindReceiptActions($("#modal-fields"),receipt);
}

// Re-reads the receipt and shows it again, which is how every refund outcome comes back to the
// operator: the row it produced is on the receipt, whatever that row says.
//
// The 50ms hand-off is the same one the rest of this file uses when one dialog replaces another;
// closing and reopening `#modal` in the same tick leaves the browser without a frame to run the
// close transition in.
let receiptHost=null;
async function reopenReceipt(invoiceId,message){
  const receipt=await api(`/api/invoices/${invoiceId}/receipt`);
  if(receiptHost?.(receipt)){
    if(message)toast(message);
    if(state.me)runDetached(()=>refresh());
    return;
  }
  $("#modal").close();
  if(message)toast(message);
  setTimeout(()=>showFinancialDocument(receipt),50);
  if(state.me)runDetached(()=>refresh());
}

/**
 * The sentence shown before a refund is confirmed, which is where the tip rule becomes visible.
 *
 * THE TIP IS REFUNDED LAST, and the operator has to be told that before they press the button
 * rather than discover it on the receipt afterwards. Square hands Pawsh one amount and does not
 * split it, so this split is a decision Pawsh makes: the service amount absorbs a refund first,
 * the tip is only reached once the service portion is exhausted, and a full refund returns the tip
 * in full. Splitting proportionally would take part of a groomer's earned gratuity on the first
 * dollar refunded, for a service complaint that was not theirs.
 *
 * The rule itself is not reimplemented here. The server sends `serviceRemainingMinor` - how much
 * of the service amount is still unrefunded - and the tip portion is whatever a refund exceeds it
 * by. The server recomputes the authoritative split under a lock when the refund is claimed; this
 * is only what the operator is shown.
 */
function refundTipSentence(refundState,amountMinor){
  if(!Number.isFinite(amountMinor)||amountMinor<=0)return "Enter an amount to refund.";
  if(amountMinor>refundState.refundableMinor){
    return `Only ${money(refundState.refundableMinor)} is left to refund on this payment.`;
  }
  if(!refundState.paymentTipMinor)return `Refunding ${money(amountMinor)}.`;
  const tipMinor=Math.max(0,amountMinor-refundState.serviceRemainingMinor);
  if(tipMinor<=0){
    return `Refunding ${money(amountMinor)} — the ${money(refundState.paymentTipMinor)} tip is not included.`;
  }
  if(tipMinor>=amountMinor){
    return `Refunding ${money(amountMinor)} — all of it comes out of the ${money(refundState.paymentTipMinor)} tip.`;
  }
  return `Refunding ${money(amountMinor)} — ${money(tipMinor)} of this comes out of the ${money(refundState.paymentTipMinor)} tip.`;
}

/**
 * Asks for an amount and a reason, shows what the refund would do, and sends it.
 *
 * The refundable figure is re-read from the server rather than taken off the open receipt, so a
 * refund somebody else issued while this receipt was on screen is accounted for before the
 * operator types anything. It is sent back as `expectedRefundableMinor` so the server can tell
 * "this operator asked for too much" from "this screen was out of date" and say the right sentence
 * for each.
 */
async function openRefundDialog(invoiceId,payment){
  if(!payment)return;
  let refundState;
  try{refundState=await api(`/api/payments/${payment.id}/refunds`);}
  catch(error){toast(error.message);return;}
  if(!refundState.refundable||refundState.refundableMinor<=0){
    toast("There is nothing left to refund on this payment.");
    return;
  }
  const maxAmount=(refundState.refundableMinor/100).toFixed(2);
  openStackedDialog({
    title:"Refund this payment",
    // Defaulted to the whole remaining amount, because a full refund is what a salon is doing
    // almost every time it opens this. A partial one is a deliberate edit rather than the norm.
    body:`<p>This payment was taken on a card terminal. Refunding it sends the money back to the `
      +`customer's card.</p>`
      +`<div class="refund-fields">`
      +`<label>Amount<input type="number" name="refundAmount" data-testid="field-refundAmount" `
      +`inputmode="decimal" step="0.01" min="0.01" max="${maxAmount}" value="${maxAmount}" required></label>`
      +`<label>Reason (optional)<input type="text" name="refundReason" `
      +`data-testid="field-refundReason" maxlength="192" placeholder="Groom cut short"></label>`
      +`</div>`
      +`<p class="fine" data-testid="refund-tip-line" role="status" aria-live="polite">`
      +`${escape(refundTipSentence(refundState,refundState.refundableMinor))}</p>`
      +`<p class="fine">${money(refundState.refundableMinor)} of ${money(refundState.paymentAmountMinor)} is still refundable.</p>`
      +`<p class="error" role="alert"></p>`,
    confirmLabel:"Refund",
    dismissLabel:"Cancel",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      const amountMinor=Math.round(Number(host.querySelector('[name="refundAmount"]').value)*100);
      if(!Number.isFinite(amountMinor)||amountMinor<=0){
        error.textContent="Enter an amount to refund.";return false;
      }
      if(amountMinor>refundState.refundableMinor){
        error.textContent=`Only ${money(refundState.refundableMinor)} is left to refund on this payment.`;
        return false;
      }
      const reason=host.querySelector('[name="refundReason"]').value.trim();
      try{
        const refund=await runOnce(`refund:${payment.id}`,()=>financialMutation(
          `/api/payments/${payment.id}/refunds`,"payment.refund",
          {amountMinor,expectedRefundableMinor:refundState.refundableMinor,reason:reason||null}));
        // `runOnce` returns nothing when the same refund is already in flight, which is a
        // double-tap rather than an outcome. Leave the dialog exactly as it is.
        if(!refund)return false;
        // A refund is never announced as done on the strength of having been sent. `settled` is
        // set only where the retrieved Square refund reported COMPLETED.
        const message=refund.settled
          ? `Refunded ${money(refund.amountMinor)} to the customer's card`
          : "Refund sent. Pawsh will confirm it with the card processor.";
        setTimeout(()=>runDetached(()=>reopenReceipt(invoiceId,message)),0);
        return true;
      }catch(problem){
        // A refund row that exists but could not be confirmed is not a validation failure - it is
        // a state the receipt has to show. Closing and re-rendering puts it in front of the
        // operator; leaving them in this dialog would offer them a second refund of money that may
        // already be on its way back.
        if(problem.data&&problem.data.refund){
          setTimeout(()=>runDetached(()=>reopenReceipt(invoiceId,problem.message)),0);
          return true;
        }
        error.textContent=problem.message;
        return false;
      }
    }
  });
  const host=$("#stacked-dialog-body");
  const amountField=host.querySelector('[name="refundAmount"]');
  const tipLine=host.querySelector('[data-testid="refund-tip-line"]');
  amountField.addEventListener("input",()=>{
    tipLine.textContent=refundTipSentence(refundState,Math.round(Number(amountField.value)*100));
  });
  amountField.focus();
  amountField.select();
}

/**
 * Re-reads one refund from Square and applies whatever it says now.
 *
 * The recovery path for the notification that never arrived, and the same code the background
 * worker runs - so pressing this cannot reach an outcome the worker could not have reached on its
 * own. It also finishes a refund whose request to Square got no answer, because the server re-sends
 * the stored idempotency key and Square returns the refund it already made rather than a second one.
 */
async function refreshRefund(refundId,invoiceId){
  await runOnce(`refund-refresh:${refundId}`,async()=>{
    try{
      const refund=await api(`/api/payment-refunds/${refundId}/refresh`,{method:"POST"});
      await reopenReceipt(invoiceId,refund.settled
        ? `Refunded ${money(refund.amountMinor)} to the customer's card`
        : refund.failed
          ? "The refund did not go through. Nothing was returned to the customer."
          : "Still waiting on the card processor.");
    }catch(error){
      if(error.data&&error.data.refund){await reopenReceipt(invoiceId,error.message);return;}
      toast(error.message);
    }
  });
}

async function voidPayment(paymentId,invoiceId,provider,method,amountMinor=0) {
  const reason=prompt("Reason for voiding this payment record:");
  if(!reason)return;
  // A credit payment is the one case where voiding DOES move money - back onto the client's
  // balance, as a `redemption_reversal` written in the void's own transaction - so the sentence
  // says so rather than reassuring the operator that nothing was refunded.
  const onCredit=method==="client_credit";
  // Voiding is a Pawsh bookkeeping act and has never moved money. It is now offered only for
  // payments Pawsh did not take through a processor - cash, a cheque, "other", a card keyed by
  // hand into somebody else's terminal - which is exactly the case it is right for: the salon
  // mis-typed a number and is correcting its own book. A terminal payment is refunded instead,
  // and the server refuses to void one, so the `provider` branch here is a belt-and-braces
  // warning for a button the receipt no longer renders.
  const warning=provider
    ? "This payment was taken on a card terminal, so it has to be refunded rather than voided."
    : onCredit
      ? `Void this credit payment? The ${money(amountMinor)} goes back to this client's credit balance.`
      : "Void this Pawsh payment record? This does not refund external funds.";
  if(provider){toast(warning);return;}
  if(!confirm(warning))return;
  await runOnce(`void:${paymentId}`,async()=>{
    try{
      await financialMutation(`/api/payments/${paymentId}/void`,`payment.void`,{reason});
      await reopenReceipt(invoiceId,onCredit
        ?`Payment record voided; ${money(amountMinor)} returned to the client's credit balance.`
        :"Payment record voided; no external refund was issued");
    }catch(error){toast(error.message);}
  });
}

let clientRowMenusBound=false;
function closeClientRowMenus(){
  $$("#customer-grid .row-menu[open]").forEach(menu=>{menu.open=false;menu.querySelector("summary")?.setAttribute("aria-expanded","false");});
}
function bindClientRowMenus(){
  if(clientRowMenusBound)return;clientRowMenusBound=true;
  document.addEventListener("click",event=>{if(!event.target.closest?.(".row-menu"))closeClientRowMenus();});
  document.addEventListener("keydown",event=>{if(event.key==="Escape")closeClientRowMenus();});
  globalThis.addEventListener("resize",closeClientRowMenus);
  $(".directory-table-wrap")?.addEventListener("scroll",()=>{
    $$("#customer-grid .row-menu[open]").forEach(menu=>{
      const trigger=menu.querySelector("summary"),box=trigger?.getBoundingClientRect();
      if(!box||box.bottom<0||box.top>globalThis.innerHeight){menu.open=false;trigger?.setAttribute("aria-expanded","false");return;}
      placeClientRowMenu(menu);
    });
  });
}
function placeClientRowMenu(menu){
  const trigger=menu.querySelector("summary"),list=menu.querySelector(".row-menu-list");
  if(!trigger||!list)return;
  const box=trigger.getBoundingClientRect(),width=list.offsetWidth,height=list.offsetHeight;
  list.style.left=`${Math.round(Math.max(8,Math.min(box.right-width,globalThis.innerWidth-width-8)))}px`;
  list.style.top=`${Math.round(box.bottom+6+height>globalThis.innerHeight-8?Math.max(8,box.top-6-height):box.bottom+6)}px`;
}
function renderCustomersEnhanced() {
  const directory=state.customerDirectory,
    formatDate=value=>value?formatPrefDate(new Date(value)):"—",
    attr=value=>escape(value).replaceAll('"',"&quot;"),
    cell=(value,className)=>{const text=value||"—",tooltip=text==="—"?"":` title="${attr(text)}"`;return `<td class="${className}"${tooltip}>${escape(text)}</td>`;};
  $("#customer-grid").innerHTML=directory.items.length?directory.items.map(customer=>{
    const pets=customer.pets||[],shown=pets.slice(0,2),extra=pets.length-shown.length,
      label=pet=>pet.name?`${pet.name}${pet.breed?` (${pet.breed})`:""}`:(pet.breed||"Unnamed pet"),
      name=`${clientName(customer)}`,
      petText=pets.length?shown.map(label).join(", ")+(extra>0?` +${extra}`:""):"No active pets",
      petTitle=pets.length?pets.map(label).join(", "):"No active pets",
      alerted=pets.filter(pet=>pet.safetyAlerts),
      isNew=!customer.lastVisit&&!customer.nextAppointment,
      petActions=pets.map(pet=>`<p class="row-menu-label">${escape(petName(pet))}</p>${allowed("pets.edit")?`<button type="button" class="row-menu-item row-pet-action" data-customer-id="${customer.id}" data-id="${pet.id}" data-action-name="profile">Pet profile</button>`:""}${allowed("pets.care.view")&&allowed("pets.care.edit")?`<button type="button" class="row-menu-item row-pet-action" data-customer-id="${customer.id}" data-id="${pet.id}" data-action-name="care">Pet care</button>`:""}${allowed("pets.care.view")?`<button type="button" class="row-menu-item row-pet-action" data-customer-id="${customer.id}" data-id="${pet.id}" data-action-name="documents">Documents</button>`:""}`).join("");
    return `<tr class="directory-row customer-card" tabindex="0" data-testid="customer-card" data-customer-id="${customer.id}" aria-label="Open ${attr(name)}">`
      +`<td class="clients-name"><button type="button" class="text-button customer-detail" data-id="${customer.id}">${escape(name)}</button>${isNew?`<span class="client-chip">New</span>`:""}</td>`
      +`<td class="clients-pets" title="${attr(petTitle)}">${escape(petText)}${alerted.length?`<span class="pet-alert"><span aria-hidden="true">!</span><span class="visually-hidden">Safety alert on ${escape(alerted.map(pet=>petName(pet)).join(", "))}</span></span>`:""}</td>`
      +cell(customer.preferredEmployeeName,"clients-groomer")
      +cell(customer.phone,"clients-phone")
      +cell(customer.email,"clients-email")
      +cell(formatDate(customer.lastVisit),"clients-date")
      +cell(formatDate(customer.nextAppointment),"clients-date")
      +`<td class="clients-status"><span class="status-dot ${customer.archivedAt?"inactive":""}">${customer.archivedAt?"Inactive":"Active"}</span></td>`
      +`<td class="clients-actions"><details class="row-menu"><summary class="row-menu-trigger" aria-expanded="false" data-testid="client-row-actions" aria-label="Actions for ${attr(name)}"><span aria-hidden="true">⋯</span></summary><div class="row-menu-list" role="group" aria-label="Actions for ${attr(name)}"><button type="button" class="row-menu-item customer-detail" data-testid="client-profile-action" data-id="${customer.id}">Client profile</button><button type="button" class="row-menu-item customer-history" data-testid="client-appointment-history" data-id="${customer.id}">Appointment history</button>${petActions}</div></details></td></tr>`;
  }).join(""):`<tr><td colspan="9" class="empty">No customers match these filters.</td></tr>`;
  renderCustomerPager();
  $$(".customer-detail").forEach(button=>button.addEventListener("click",()=>openClientProfile(button.dataset.id,{returnView:"customers"})));$$(".customer-history").forEach(button=>button.addEventListener("click",()=>showCustomerHistory(button.dataset.id)));
  $$(".directory-row").forEach(row=>{row.addEventListener("click",event=>{if(!event.target.closest("button,a,input,select,summary,details"))openClientProfile(row.dataset.customerId,{returnView:"customers"});});row.addEventListener("keydown",event=>{if(event.target===row&&(event.key==="Enter"||event.key===" ")){event.preventDefault();openClientProfile(row.dataset.customerId,{returnView:"customers"});}});});
  $$(".row-pet-action").forEach(button=>button.addEventListener("click",async()=>{const data=await api(`/api/customers/${button.dataset.customerId}/history`);state.pets=[...state.pets.filter(pet=>pet.customerId!==button.dataset.customerId),...data.pets];if(button.dataset.actionName==="profile")editPet(button.dataset.id);else if(button.dataset.actionName==="care")editPetCare(button.dataset.id);else showPetDocuments(button.dataset.id);}));
  $$("#customer-grid .row-menu-item").forEach(button=>button.addEventListener("click",closeClientRowMenus));
  $$("#customer-grid .row-menu").forEach(menu=>menu.addEventListener("toggle",()=>{
    menu.querySelector("summary")?.setAttribute("aria-expanded",menu.open?"true":"false");
    if(!menu.open)return;
    $$("#customer-grid .row-menu[open]").forEach(other=>{if(other!==menu){other.open=false;other.querySelector("summary")?.setAttribute("aria-expanded","false");}});
    placeClientRowMenu(menu);
  }));
  bindClientRowMenus();
}
const CUSTOMER_PAGE_SIZES=[10,20,50,100];
function customerPageSize(){const chosen=Number($("#customer-page-size")?.value);return CUSTOMER_PAGE_SIZES.includes(chosen)?chosen:20;}
function customerDirectoryParams(page){return new URLSearchParams({paged:"true",page:String(page),pageSize:String(customerPageSize()),q:$("#customer-search").value,status:$("#customer-status").value,upcoming:$("#customer-upcoming").value,sort:$("#customer-sort").value});}
/**
 * The page numbers worth drawing: the ends, the current page and its neighbours, and a gap
 * marker for everything skipped. A 700-client directory is 35 pages, and a row of 35 buttons
 * is not navigation.
 */
function pagerWindow(page,pages){
  const wanted=new Set([1,pages,page,page-1,page+1]);
  if(page<=4)for(let number=2;number<=5;number++)wanted.add(number);
  if(page>=pages-3)for(let number=pages-4;number<pages;number++)wanted.add(number);
  const numbers=[...wanted].filter(number=>number>=1&&number<=pages).sort((first,second)=>first-second);
  const cells=[];let previous=0;
  for(const number of numbers){if(previous&&number-previous>1)cells.push(null);cells.push(number);previous=number;}
  return cells;
}
/**
 * The pager shell: two arrows around a span the page numbers go in, as a real `<nav>`.
 *
 * Written once and used by everything that pages. The client directory carried this markup inline
 * in `index.html`, and the settings tables that page would have had to fork it - two copies of the
 * same arrows, free to drift in their labels, their icons and their landmark.
 */
function pagerNavMarkup({idPrefix,label,inner=""}){
  return `<nav class="pager" aria-label="${escapeAttr(label)}">`
    +`<button type="button" class="pager-arrow" id="${idPrefix}-prev" aria-label="Previous page"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button>`
    +`<span class="pager-pages" id="${idPrefix}-pages">${inner}</span>`
    +`<button type="button" class="pager-arrow" id="${idPrefix}-next" aria-label="Next page"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button></nav>`;
}
// The numbers themselves, given the attribute whose value the caller's click handler reads.
function pagerPageButtons(page,pages,attribute){
  return pagerWindow(page,pages).map(number=>number===null
    ?`<span class="pager-gap" aria-hidden="true">…</span>`
    :`<button type="button" class="pager-page${number===page?" current":""}" ${attribute}="${number}"${number===page?` aria-current="page"`:""} aria-label="Page ${number}">${number}</button>`).join("");
}
// Filled in place, at module load, before anything binds to the buttons inside. A slot rather than
// literal markup is what keeps `index.html` from holding a second copy of the shell above.
$$("[data-pager-slot]").forEach(slot=>{
  slot.outerHTML=pagerNavMarkup({idPrefix:slot.dataset.pagerSlot,label:slot.dataset.pagerLabel});
});
function renderCustomerPager(){
  const directory=state.customerDirectory;
  const pages=Math.max(1,Math.ceil(directory.total/directory.pageSize));
  const page=Math.min(Math.max(1,directory.page),pages);
  const first=directory.total?(page-1)*directory.pageSize+1:0;
  const last=Math.min(page*directory.pageSize,directory.total);
  // The count reads as a range rather than a page number: "which clients am I looking at" is
  // the question a directory answers, and the page number is only how you got here.
  $("#customer-page-status").textContent=directory.total
    ?`${first}–${last} of ${directory.total} client${directory.total===1?"":"s"}`
    :"No clients";
  $("#customer-pages").innerHTML=pagerPageButtons(page,pages,"data-customer-page");
  $$("[data-customer-page]").forEach(button=>button.addEventListener("click",()=>
    runDetached(()=>loadCustomerDirectory(Number(button.dataset.customerPage)))));
  $("#customer-prev").disabled=page<=1;$("#customer-next").disabled=page>=pages;
}
async function loadCustomerDirectory(page=1){const result=await api(`/api/customers?${customerDirectoryParams(page)}`);state.customerDirectory=result;state.customers=result.items;renderCustomersEnhanced();}
function pricingMatrix(service){
  if(service.pricingMode!=="TIERED")return "";
  const classes=["SMOOTH_SINGLE","STANDARD","EXTRA_FLOOF"];const tiers=weightTierList();
  return `<div class="pricing-scroll"><table class="pricing-matrix"><caption>${escape(service.name)} pricing tiers</caption><thead><tr><th scope="col">Pricing class</th>${tiers.map(tier=>`<th scope="col">${escape(tier.label)}</th>`).join("")}</tr></thead><tbody>${classes.map(pricingClass=>`<tr><th scope="row">${escape(pricingClass.replaceAll("_"," "))}</th>${tiers.map(tier=>`<td>${money(service.priceTiers.find(price=>price.pricingClass===pricingClass&&price.weightTierCode===tier.code)?.priceMinor??0)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
// The catalog opens on the work a salon does every day. DOG_BASE leads, the add-ons that
// hang off it follow, then à la carte, cat, and anything general; a category the server
// adds later sorts in after those, alphabetically, so the order never depends on the order
// rows happen to arrive in.
const serviceCategoryOrder=["DOG_BASE","DOG_ADDON","A_LA_CARTE","CAT","GENERAL"];
// Which sections are collapsed is a view preference, like the calendar ones above: per
// account, per business, local to the browser, and never part of the catalog data.
// The catalog page and the booking picker collapse independently. They show the same
// categories for different reasons — maintaining the price book versus choosing today's
// work — so a section closed while editing prices should not be closed while booking.
function serviceSectionKey(scope){return `pawsh:service-sections:${scope}:${state.me?.account?.id||state.me?.account?.email||"anonymous"}:${state.me?.business?.id||"none"}`;}
const serviceSectionStores=new Map();
function serviceSectionStorage(scope="catalog"){
  const key=serviceSectionKey(scope);
  const serviceSectionStore=serviceSectionStores.get(scope);
  if(serviceSectionStore?.key===key)return serviceSectionStore;
  let saved={};
  try{const parsed=JSON.parse(globalThis.localStorage.getItem(key)||"null");if(parsed&&typeof parsed==="object")saved=parsed;}
  catch{saved={};}
  // `revealed` holds the sections a filter opened. It is deliberately memory-only: a search
  // that surfaced a section keeps it open for the rest of the visit - clearing the search
  // must not slam shut the thing the user was just reading - but the next load starts from
  // the stored preference again.
  const created={key,saved,revealed:new Set()};
  serviceSectionStores.set(scope,created);
  return created;
}
// `fallback` is what an account that has never touched this section should see. It defaults to
// the core grooming section, but a salon whose catalog has no DOG_BASE at all would then open
// to nothing but headers, so callers pass the leading section instead.
function serviceSectionOpen(category,scope="catalog",fallback=category==="DOG_BASE"){
  const store=serviceSectionStorage(scope);
  if(store.revealed.has(category))return true;
  return typeof store.saved[category]==="boolean"?store.saved[category]:fallback;
}
function saveServiceSection(category,open,scope="catalog"){
  const store=serviceSectionStorage(scope);
  store.saved[category]=open;
  if(open)store.revealed.add(category);else store.revealed.delete(category);
  try{globalThis.localStorage.setItem(store.key,JSON.stringify(store.saved));}
  catch{/* private browsing or a full quota: the section still toggles, it just is not remembered */}
}
function renderServices(){
  const target=$("#service-list");if(!target)return;
  const query=($("#service-search")?.value||"").trim().toLowerCase(),category=$("#service-category-filter")?.value||"all",status=$("#service-status-filter")?.value||"active",
    attr=value=>escape(value).replaceAll('"',"&quot;"),
    labels={DOG_BASE:"Main services",DOG_ADDON:"Dog add-ons",A_LA_CARTE:"À la carte",CAT:"Cat services",GENERAL:"General"},
    // Any narrowing of the catalog - text, category or status - expands every section that
    // survives it. A match hidden inside a collapsed section reads to the user as no match.
    filtering=Boolean(query)||category!=="all"||status!=="active";
  const filtered=state.services.filter(service=>(!query||`${service.name} ${service.description||""}`.toLowerCase().includes(query))&&(category==="all"||service.category===category)&&(status==="all"||status==="active"&&service.active||status==="archived"&&!service.active));
  const groups=[...new Set(filtered.map(service=>service.category))].sort((left,right)=>{
    const rank=value=>{const index=serviceCategoryOrder.indexOf(value);return index<0?serviceCategoryOrder.length:index;};
    return rank(left)-rank(right)||left.localeCompare(right);
  });
  target.innerHTML=groups.map(group=>{
    const services=filtered.filter(service=>service.category===group),open=filtering||serviceSectionOpen(group);
    if(filtering)serviceSectionStorage().revealed.add(group);
    const rows=services.map(service=>{const price=service.pricingMode==="FIXED"?money(service.basePriceMinor):service.pricingMode==="RANGE"?`${money(service.basePriceMinor)}–${money(service.rangeMaxMinor)}`:`From ${money(service.basePriceMinor)} · tiered`;return `<article class="service-row ${service.active?"":"archived"}"><div class="service-row-main"><h4>${escape(service.name)}</h4><p>${escape(service.description||"No description")}</p><span class="service-state">${service.active?"Active · Bookable":"Archived · Not bookable"}</span></div><div class="service-row-facts"><strong>${price}</strong><span>${service.baseDurationMinutes>0?`${service.baseDurationMinutes} min`:"Duration required"}</span></div>${allowed("services.manage")?`<div class="service-row-actions"><button type="button" class="secondary compact edit-service" data-id="${service.id}" aria-label="Edit ${escape(service.name)}">Edit</button>${service.active?`<button type="button" class="text-button deactivate-service" data-id="${service.id}" aria-label="Archive ${escape(service.name)}">Archive</button>`:""}</div>`:""}${pricingMatrix(service)}</article>`}).join("");
    return `<section class="service-category"><details class="service-section" data-category="${attr(group)}" data-rendered-open="${open?"true":"false"}"${open?" open":""}><summary class="service-section-summary" aria-expanded="${open?"true":"false"}"><span class="service-section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg></span><span class="service-section-title">${escape(labels[group]||group.replaceAll("_"," "))}</span><small>${services.length} ${services.length===1?"service":"services"}</small></summary><div class="service-section-body">${rows}</div></details></section>`;
  }).join("")||`<p class="empty">No services match these filters.</p>`;
  $$("#service-list .service-section").forEach(section=>{
    const summary=section.querySelector("summary");
    section.addEventListener("toggle",()=>{
      summary?.setAttribute("aria-expanded",section.open?"true":"false");
      // Chromium fires toggle for a <details open> that innerHTML just parsed, so the event
      // alone cannot tell a person opening a section from the markup this render wrote. Only
      // a state that differs from what was rendered came from the user; without this guard a
      // section a search had revealed saved itself as the stored preference.
      const rendered=section.dataset.renderedOpen==="true";
      section.dataset.renderedOpen=section.open?"true":"false";
      if(section.open===rendered)return;
      // A filtered view is transient, so what a search opened never becomes the preference.
      if(!filtering)saveServiceSection(section.dataset.category,section.open);
    });
  });
  $$(".edit-service").forEach(button=>button.addEventListener("click",()=>editService(button.dataset.id)));$$(".deactivate-service").forEach(button=>button.addEventListener("click",()=>deactivate("services",button.dataset.id)));
}
function renderReportGroomers(){
  const select=$("#report-groomers");if(!select)return;
  const chosen=new Set(state.reports?.employeeIds??[...select.selectedOptions].map(option=>option.value));
  select.innerHTML=state.employees.filter(employee=>employee.active).map(employee=>`<option value="${employee.id}" ${chosen.has(employee.id)?"selected":""}>${escape(employee.displayName)}</option>`).join("");
}
function reportQuery(){
  const params=new URLSearchParams();
  const start=$("#report-start")?.value,days=$("#report-days")?.value;
  if(start)params.set("localDate",start);
  if(days)params.set("days",days);
  const groomers=[...($("#report-groomers")?.selectedOptions??[])].map(option=>option.value).filter(Boolean);
  if(groomers.length)params.set("employeeIds",groomers.join(","));
  return params;
}
// == reports charts ==========================================================
// Pawsh has no bundler and no chart library, so a bar is a plain element whose only runtime
// style is its own length. Two rules hold everywhere below: every bar prints its label and
// its exact value as text, so the reading survives colour-blindness, 400% zoom and a screen
// reader with the graphics ignored; and a figure the server cannot supply gets an explicit
// empty state instead of a zero-height bar, because a zero bar is a claim ("this person
// earned nothing") that Pawsh is not entitled to make.
const reportAttr=value=>escape(value).replaceAll('"',"&quot;");
const reportMethodLabels={cash:"Cash",external_card:"External card",check:"Check",card:"Card",other:"Other"};
function reportMethodLabel(method){
  const key=String(method??"");
  return reportMethodLabels[key]||(key?key.replaceAll("_"," ").replace(/^./,letter=>letter.toUpperCase()):"Unrecorded");
}
function reportBarLength(value,max){return max>0?Math.max(0,Math.min(100,Math.round(Number(value)/max*1000)/10)):0;}
function reportEmpty(message){return `<p class="empty chart-empty">${escape(message)}</p>`;}
function reportNote(message){return message?`<p class="chart-note">${escape(message)}</p>`:"";}
// Vertical bars read top to bottom as plot, value, label, note, while the DOM order is the
// reverse of that (label first) so the accessible reading is "Net, $1,690.00" rather than a
// value arriving before the thing it measures. Grid areas keep the two orders independent.
function reportVerticalBars(rows,{empty,note}={}){
  const values=rows.map(row=>Number(row.value)||0),max=Math.max(0,...values);
  if(!rows.length||max<=0)return reportEmpty(empty||"Nothing to chart in this range.");
  return reportNote(note)+`<ol class="chart chart-vertical">${rows.map((row,index)=>
    `<li class="vbar"${row.tone?` data-tone="${reportAttr(row.tone)}"`:""}>`
    +`<span class="vbar-label">${escape(row.label)}</span>`
    +`<span class="vbar-value">${escape(row.display)}</span>`
    +(row.note?`<span class="vbar-note">${escape(row.note)}</span>`:"")
    +`<span class="vbar-track" aria-hidden="true"><span class="vbar-fill" style="height:${reportBarLength(values[index],max)}%"></span></span>`
    +`</li>`).join("")}</ol>`;
}
// Horizontal bars carry the groomer identity slot, so a groomer is the same colour here as
// on the calendar. A row with no slot - the Unassigned bucket - falls back to the muted tone.
function reportHorizontalBars(rows,{empty,note}={}){
  const values=rows.map(row=>Number(row.value)||0),max=Math.max(0,...values);
  if(!rows.length||max<=0)return reportEmpty(empty||"Nothing to chart in this range.");
  return reportNote(note)+`<ol class="chart chart-horizontal">${rows.map((row,index)=>
    `<li class="hbar"${row.slot===null||row.slot===undefined||row.slot===""?"":` data-groomer-slot="${reportAttr(row.slot)}"`}${row.tone?` data-tone="${reportAttr(row.tone)}"`:""}>`
    +`<span class="hbar-label" title="${reportAttr(row.label)}">${escape(row.label)}</span>`
    +`<span class="hbar-track" aria-hidden="true"><span class="hbar-fill" style="width:${reportBarLength(values[index],max)}%"></span></span>`
    +`<span class="hbar-value">${escape(row.display)}</span>`
    +`</li>`).join("")}</ol>`;
}
// One row per groomer, largest first, plus the server's unattributed bucket when it holds
// anything. Without that bucket the bars quietly fail to sum to the business total, and the
// gap looks like a rounding error rather than the appointments-without-a-groomer that it is.
function reportStaffRows(employees,field,unattributedMinor){
  const rows=employees.map(employee=>{
    const value=Number(employee[field]||0);
    return {label:employee.displayName,value,display:money(value),slot:groomerColorSlot(employee.id)};
  });
  const unattributed=Number(unattributedMinor||0);
  if(unattributed>0)rows.push({label:"Unassigned",value:unattributed,display:money(unattributed),slot:null,tone:"unassigned"});
  return rows.sort((left,right)=>right.value-left.value);
}
function reportUnassignedNote(unattributedMinor){
  return Number(unattributedMinor||0)>0?"Unassigned is money on invoices whose appointment has no groomer on record. It is shown so the bars add up to the business total.":"";
}
function renderReportCharts(){
  const totals=state.reports.totals??{},employees=state.reports.employees??[],
    amount=value=>Number(value||0),
    bar=(label,value,extra={})=>({label,value:amount(value),display:money(amount(value)),...extra});
  $("#report-summary").innerHTML=[
    ["Completed appointments",String(amount(totals.completedAppointments))],
    ["Total pets",String(amount(totals.totalPets))],
    ["Services performed",String(amount(totals.servicesPerformed))],
    ["Earned revenue",money(amount(totals.paidRevenueMinor))],
    ["Expected revenue",money(amount(totals.expectedRevenueMinor))]
  ].map(([label,value])=>`<div class="metric"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join("");
  $("#report-revenue-chart").innerHTML=reportVerticalBars([
    bar("Net",totals.netMinor),bar("Tax",totals.taxMinor),bar("Sales",totals.salesMinor),
    bar("Tips",totals.tipMinor),bar("Total",totals.billedRevenueMinor,{tone:"total"})
  ],{empty:"No invoiced revenue in this range."});
  $("#report-staff-revenue").innerHTML=reportHorizontalBars(
    reportStaffRows(employees,"revenueMinor",totals.unattributedRevenueMinor),
    {empty:"No attributed revenue in this range.",note:reportUnassignedNote(totals.unattributedRevenueMinor)});
  // Commission is null, not zero: Pawsh has no commission model, so there is no figure to
  // draw. Zero-height bars under five names would read as "nobody earned any commission".
  const commission=employees.filter(employee=>employee.commissionMinor!==null&&employee.commissionMinor!==undefined);
  $("#report-staff-commission").innerHTML=commission.length
    ?reportHorizontalBars(commission.map(employee=>({label:employee.displayName,value:amount(employee.commissionMinor),display:money(amount(employee.commissionMinor)),slot:groomerColorSlot(employee.id)})).sort((left,right)=>right.value-left.value),{empty:"No commission in this range."})
    :reportEmpty("Not tracked yet. Pawsh has no commission model, so there is no commission to report - this is not $0 earned.");
  $("#report-staff-tips").innerHTML=reportHorizontalBars(
    reportStaffRows(employees,"tipMinor",totals.unattributedTipMinor),
    {empty:"No tips in this range.",note:reportUnassignedNote(totals.unattributedTipMinor)});
  const salesItems=state.reports.salesItems??{};
  $("#report-sales-items").innerHTML=reportVerticalBars([
    bar("Services",salesItems.servicesMinor),bar("Products",salesItems.productsMinor),
    bar("Tax",salesItems.taxMinor),bar("Tips",salesItems.tipMinor)
  ],{empty:"No sales in this range.",note:amount(salesItems.productsMinor)===0?"Products is a true zero: Pawsh does not sell retail items yet.":""});
  const paymentStatus=state.reports.paymentStatus??{};
  $("#report-payment-status").innerHTML=reportVerticalBars([
    bar("Paid",paymentStatus.paidMinor,{tone:"paid"}),bar("Outstanding",paymentStatus.outstandingMinor,{tone:"outstanding"})
  ],{empty:"Nothing billed in this range."});
  const methods=(state.reports.paymentMethods??[]).map(row=>bar(reportMethodLabel(row.method),row.amountMinor,{note:`${amount(row.count)} ${amount(row.count)===1?"payment":"payments"}`})).sort((left,right)=>right.value-left.value);
  $("#report-payment-methods").innerHTML=reportVerticalBars(methods,{empty:"No payments recorded in this range."});
}
function renderReportTables(){
  const totals=state.reports.totals??{},amount=value=>Number(value||0),
    // Each revenue row is a DATE - the business-local day the invoice was cut - which arrives
    // as UTC midnight. Formatting it in the viewer's zone slides it a day backwards west of
    // UTC, so it is read back in UTC to land on the day the server actually meant.
    dayFormat={format:value=>formatPrefDate(value,"UTC")};
  // The metric rows stay one-to-one with the Summary card, in the same order: Charts and
  // Report are two readings of one server payload and must never disagree.
  $("#report-table-body").innerHTML=[
    ["Completed appointments","Completed appointments whose <em>start</em> falls in range, counted once each.",String(amount(totals.completedAppointments))],
    ["Total pets","Distinct pets seen on those completed appointments.",String(amount(totals.totalPets))],
    ["Services performed","Historical service snapshots on those completed appointments.",String(amount(totals.servicesPerformed))],
    ["Earned revenue","Invoice total less current balance, for invoices <em>created</em> in range. Counted once per invoice.",money(amount(totals.paidRevenueMinor))],
    ["Expected revenue","Balance still owed on those same invoices. Billed, not yet collected.",money(amount(totals.expectedRevenueMinor))]
  ].map(([metric,definition,value])=>`<tr><td>${escape(metric)}</td><td>${definition}</td><td>${escape(value)}</td></tr>`).join("");
  const employees=state.reports.employees??[],
    commissionCell=employee=>employee.commissionMinor===null||employee.commissionMinor===undefined?`<td class="report-not-tracked">Not tracked</td>`:`<td>${escape(money(amount(employee.commissionMinor)))}</td>`;
  const staffRows=employees.map(employee=>`<tr><td>${escape(employee.displayName)}</td><td>${amount(employee.appointmentCount)}</td><td>${escape(money(amount(employee.revenueMinor)))}</td><td>${escape(money(amount(employee.tipMinor)))}</td>${commissionCell(employee)}</tr>`);
  if(amount(totals.unattributedRevenueMinor)>0||amount(totals.unattributedTipMinor)>0)
    staffRows.push(`<tr class="report-unassigned-row"><td>Unassigned</td><td>—</td><td>${escape(money(amount(totals.unattributedRevenueMinor)))}</td><td>${escape(money(amount(totals.unattributedTipMinor)))}</td><td class="report-not-tracked">—</td></tr>`);
  $("#report-staff-table-body").innerHTML=staffRows.join("")||`<tr><td colspan="5" class="empty">No completed appointments.</td></tr>`;
  $("#report-services-table-body").innerHTML=(state.reports.services??[]).map(row=>`<tr><td>${escape(row.service)}</td><td>${amount(row.performed)}</td></tr>`).join("")||`<tr><td colspan="2" class="empty">No services completed.</td></tr>`;
  $("#report-daily-table-body").innerHTML=(state.reports.revenue??[]).map(row=>`<tr><td>${escape(dayFormat.format(new Date(row.date)))}</td><td>${escape(money(amount(row.revenueMinor)))}</td></tr>`).join("")||`<tr><td colspan="2" class="empty">No paid revenue yet.</td></tr>`;
}
function renderReports() {
  if (!state.reports) return;
  // Business totals come from the server so Charts and Report can never disagree. The groomer
  // rows below are attribution only and are never summed to produce a business total.
  $("#report-start").value=state.reports.localDate;$("#report-days").value=String(state.reports.days);
  renderReportGroomers();
  renderReportCharts();
  renderReportTables();
  $("#report-charts").hidden=state.reportMode!=="charts";$("#report-table").hidden=state.reportMode!=="table";$("#report-charts-mode").setAttribute("aria-pressed",String(state.reportMode==="charts"));$("#report-table-mode").setAttribute("aria-pressed",String(state.reportMode==="table"));
}

// An employee with rows in employee_services is only set up for those, and the server refuses the
// assignment at booking, service-change and groomer-change time. So every groomer picker takes the
// services in play and renders the rest as disabled options carrying the reason - disabled rather
// than absent, because a groomer who is simply missing reads as a data problem.
function groomerServiceGap(employee,serviceIds) {
  if(!employee.serviceIds?.length)return [];
  return serviceIds.filter(serviceId=>!employee.serviceIds.includes(serviceId));
}
function groomerPickerOptions(serviceIds=[]) {
  return state.employees.filter(employee=>employee.active).map(employee=>{
    const gap=groomerServiceGap(employee,serviceIds)
      .map(serviceId=>state.services.find(service=>service.id===serviceId)?.name).filter(Boolean);
    return [employee.id,gap.length?`${employee.displayName} - not set up for ${gap.join(", ")}`:employee.displayName,gap.length>0];
  });
}
function groomerCheckboxes(selected=[],serviceIds=[]) {
  return select("employeeId","Groomer",groomerPickerOptions(serviceIds),true,selected[0]||"");
}
// The booking picker uses the catalog's own category order and collapsing, so core grooming
// leads and the long tail of add-ons and cat services stays folded away. Before this the
// groups came out in whatever order the rows arrived in, which routinely pushed the services
// booked most often below a screenful of ones booked rarely.
function bookingServiceCheckboxes(selected=[]) {
  const labels={DOG_BASE:"Core grooming",DOG_ADDON:"Add-ons",A_LA_CARTE:"Care & finishing",CAT:"Cat",GENERAL:"Other"};
  const active=state.services.filter(service=>service.active);
  const groups=[...new Set(active.map(service=>service.category))].sort((left,right)=>{
    const rank=value=>{const index=serviceCategoryOrder.indexOf(value);return index<0?serviceCategoryOrder.length:index;};
    return rank(left)-rank(right)||left.localeCompare(right);
  });
  const sections=groups.map((category,index)=>{
    const services=active.filter(service=>service.category===category);
    // A section holding an already-ticked service opens regardless of the stored preference:
    // a selection the operator cannot see is worse than a section they have to fold again.
    const open=services.some(service=>selected.includes(service.id))
      ||serviceSectionOpen(category,"booking",index===0);
    const chosen=services.filter(service=>selected.includes(service.id)).length;
    const options=services.map(service=>`<label><input type="checkbox" name="serviceIds" value="${service.id}" ${selected.includes(service.id)?"checked":""}> <span>${escape(service.name)}<small>${money(service.basePriceMinor)} · ${service.baseDurationMinutes} min</small></span></label>`).join("");
    return `<section class="booking-service-category"><details class="service-section" data-category="${escape(category)}" data-rendered-open="${open?"true":"false"}"${open?" open":""}>`
      +`<summary class="service-section-summary" aria-expanded="${open?"true":"false"}">`
      +`<span class="service-section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg></span>`
      +`<span class="service-section-title">${escape(labels[category]||category.replaceAll("_"," "))}</span>`
      +`<small data-section-count>${chosen?`${chosen} of ${services.length} selected`:`${services.length} ${services.length===1?"service":"services"}`}</small>`
      +`</summary><div class="service-section-body compact-options">${options}</div></details></section>`;
  }).join("");
  return `<fieldset id="appointment-service-options" class="wide service-options"><legend>Services</legend>${sections||"<p>Add a service first.</p>"}</fieldset>`;
}
// Keeps the summary counts truthful as boxes are ticked, and remembers what the operator
// folded. Re-reads the DOM rather than tracking state because `applyBookingDefaults` also
// checks boxes directly.
function syncBookingServiceCount(section) {
  const inputs=[...section.querySelectorAll('input[name="serviceIds"]')];
  const chosen=inputs.filter(input=>input.checked).length;
  const count=section.querySelector("[data-section-count]");
  if(count)count.textContent=chosen
    ?`${chosen} of ${inputs.length} selected`
    :`${inputs.length} ${inputs.length===1?"service":"services"}`;
}
function syncBookingServiceCounts() {
  bqa("#appointment-service-options .service-section").forEach(syncBookingServiceCount);
}
function bindBookingServiceSections() {
  const syncCount=syncBookingServiceCount;
  bqa("#appointment-service-options .service-section").forEach(section=>{
    const summary=section.querySelector("summary");
    section.addEventListener("toggle",()=>{
      summary?.setAttribute("aria-expanded",section.open?"true":"false");
      // Chromium fires toggle for a `<details open>` that innerHTML just parsed, so only a
      // state differing from what was rendered came from the operator.
      const rendered=section.dataset.renderedOpen==="true";
      section.dataset.renderedOpen=section.open?"true":"false";
      if(section.open===rendered)return;
      saveServiceSection(section.dataset.category,section.open,"booking");
    });
    section.querySelectorAll('input[name="serviceIds"]').forEach(input=>
      input.addEventListener("change",()=>syncCount(section)));
    syncCount(section);
  });
}
// Opens whichever sections hold a ticked service. Called after defaults land, because the
// markup was rendered before the pet's last paid visit was known.
function revealCheckedBookingServices() {
  bqa("#appointment-service-options .service-section").forEach(section=>{
    if(section.open||!section.querySelector('input[name="serviceIds"]:checked'))return;
    section.dataset.renderedOpen="true";
    section.open=true;
    section.querySelector("summary")?.setAttribute("aria-expanded","true");
  });
}
function editService(id) {
  const service=state.services.find(item=>item.id===id);
  const tierFields=service.pricingMode==="TIERED"?`<fieldset class="wide"><legend>Pricing matrix</legend><div class="pricing-scroll"><table class="pricing-matrix"><thead><tr><th scope="col">Class</th>${weightTierList().map(tier=>`<th scope="col">${escape(tier.label)}</th>`).join("")}</tr></thead><tbody>${["SMOOTH_SINGLE","STANDARD","EXTRA_FLOOF"].map(pricingClass=>`<tr><th scope="row">${escape(pricingClass.replaceAll("_"," "))}</th>${weightTierList().map(tier=>{const price=service.priceTiers.find(item=>item.pricingClass===pricingClass&&item.weightTierCode===tier.code);return `<td><label><span class="sr-only">${escape(pricingClass)} ${escape(tier.label)} price</span><input name="tier:${pricingClass}:${tier.code}" type="number" min="0" step=".01" value="${Number(price?.priceMinor??0)/100}"></label></td>`;}).join("")}</tr>`).join("")}</tbody></table></div></fieldset>`:"";
  openModal("Edit service",field("name","Service name","text",`required value="${escape(service.name)}"`)+field("baseDurationMinutes","Duration (minutes)","number",`required min="1" value="${service.baseDurationMinutes}"`)+field("basePrice","Base/fixed price ($)","number",`required min="0" step=".01" value="${Number(service.basePriceMinor)/100}`)+field("description","Description","text",`value="${escape(service.description||"")}"`,true)+`<label><input name="active" type="checkbox" ${service.active?"checked":""}> Active</label>`+tierFields,async form=>{const values=Object.fromEntries(form);await api(`/api/services/${id}`,{method:"PUT",body:JSON.stringify({name:values.name,description:values.description||null,baseDurationMinutes:Number(values.baseDurationMinutes),basePriceMinor:Math.round(Number(values.basePrice)*100),category:service.category,pricingMode:service.pricingMode,rangeMaxMinor:service.rangeMaxMinor,priceConfirmationRequired:service.priceConfirmationRequired,active:form.has("active")})});const prices=[...form.entries()].filter(([name])=>name.startsWith("tier:")).map(([name,value])=>{const [,pricingClass,weightTierCode]=name.split(":");return {pricingClass,weightTierCode,priceMinor:Math.round(Number(value)*100)};});if(prices.length)await api(`/api/services/${id}/pricing`,{method:"PUT",body:JSON.stringify({prices})});});
}
const breedClasses=[["SMOOTH_SINGLE","Smooth Single"],["STANDARD","Standard"],["EXTRA_FLOOF","Extra Floof"]];
function breedClassOptions(value){return breedClasses.map(([key,label])=>`<option value="${key}" ${key===value?"selected":""}>${label}</option>`).join("");}
async function loadPetTypes(){
  if(!state.petTypes.length)state.petTypes=await api("/api/pet-types");
  return state.petTypes;
}
// Settings -> Pet Options -> Pet Type -> Breeds is the only breed-management surface, so every
// write re-reads that one drawer rather than a second catalog's copy of the same rows.
//
// Only the field being changed is sent. The server merges an omitted field with what is stored,
// so setting a pricing class cannot pin `active` away from the shared Pawsh default, and
// sending both as null deletes the override row entirely.
async function putBreedSettings(id,body){
  await api(`/api/breeds/${id}/settings`,{method:"PUT",body:JSON.stringify(body)});
  await refreshBreedDrawer();
}
async function toggleBreed(id,active){await putBreedSettings(id,{active});toast(active?"Breed reactivated":"Breed deactivated");}
async function resetBreed(id){await putBreedSettings(id,{pricingClass:null,active:null});toast("Pawsh default restored");}
async function deactivate(type,id) {
  if(!confirm(`Deactivate this ${type==="services"?"service":"team member"}?`))return;
  try{await api(`/api/${type}/${id}`,{method:"DELETE"});toast("Deactivated");await refresh();}catch(error){toast(error.message);}
}
// ---------------------------------------------------------------------------
// Client editor
//
// Basic details, addresses, and contacts in one panel, each saving on its own. A client is
// rarely one address and one phone number: there is the house and the second home, the owner
// and the partner and the dog walker who actually does the pick-up.
// ---------------------------------------------------------------------------
const clientEditState=tenantCache(()=>({customerId:null,customer:null,addresses:[],contacts:[],automatedMessagesSupported:false}));

function clientBasicSectionMarkup(customer){
  const contactOptions=["email","phone","none"].map(value=>
    `<option value="${value}" ${customer.preferredContactMethod===value?"selected":""}>${value}</option>`).join("");
  return `<form class="pet-profile-section" data-client-section="basic">`
    +`<h4>Basic info</h4>`
    +`<div class="pet-field-grid">`
      +field("firstName","First name","text",`value="${escape(customer.firstName||"")}"`)
      +field("lastName","Last name","text",`value="${escape(customer.lastName||"")}"`)
      +field("email","Email","email",`value="${escape(customer.email||"")}"`)
      // The client's own number stays here. Contacts below are the other people who might be
      // rung about this dog, and a partial record created from a phone call has nowhere else
      // to put the number it was given.
      +field("phone","Phone","tel",`value="${escape(customer.phone||"")}"`)
      +`<label>Preferred contact<select data-testid="field-preferredContactMethod" name="preferredContactMethod">${contactOptions}</select></label>`
      +`<label class="pet-check"><input data-testid="field-emailAllowed" name="emailAllowed" type="checkbox" ${customer.emailAllowed?"checked":""}> Email allowed</label>`
    +`</div>`
    +`<div class="pet-section-actions"><button type="submit" class="primary compact" data-testid="client-basic-save">Save</button></div>`
    +`</form>`;
}

function clientAddressesSectionMarkup(){
  const items=clientEditState.addresses;
  return `<section class="pet-profile-section">`
    +`<div class="pet-section-head"><h4>Addresses</h4><button type="button" class="text-button" data-testid="client-address-add">Add</button></div>`
    +(items.length
      ? `<div class="pet-table-wrap" data-allow-horizontal-scroll><table class="pet-table" data-testid="client-addresses">`
        +`<thead><tr><th scope="col">Primary</th><th scope="col">Address</th><th scope="col">Label</th><th scope="col">Action</th></tr></thead><tbody>`
        +items.map(item=>`<tr>`
          +`<td><input type="radio" name="primaryAddress" data-client-address-primary="${escape(item.id)}" ${item.isPrimary?"checked":""} aria-label="Make ${escape(item.address)} the primary address"></td>`
          +`<td>${escape(item.address)}</td><td>${escape(item.label||"—")}</td>`
          +`<td><button type="button" class="text-button" data-client-address-edit="${escape(item.id)}">Edit</button>`
          +`<button type="button" class="text-button destructive" data-client-address-delete="${escape(item.id)}">Delete</button></td></tr>`).join("")
        +`</tbody></table></div>`
      : `<p class="pet-empty">No address on file.</p>`)
    +`</section>`;
}

function clientContactsSectionMarkup(){
  const items=clientEditState.contacts;
  return `<section class="pet-profile-section">`
    +`<div class="pet-section-head"><h4>Contacts (${escape(String(items.length))})</h4>`
      +`<button type="button" class="text-button" data-testid="client-contact-add">Add</button></div>`
    +(items.length
      ? `<div class="pet-table-wrap" data-allow-horizontal-scroll><table class="pet-table" data-testid="client-contacts">`
        +`<thead><tr><th scope="col">Primary</th><th scope="col">Name</th><th scope="col">Receive auto msg</th>`
        +`<th scope="col">Phone number</th><th scope="col">Title</th><th scope="col">Action</th></tr></thead><tbody>`
        +items.map(item=>`<tr>`
          +`<td><input type="radio" name="primaryContact" data-client-contact-primary="${escape(item.id)}" ${item.isPrimary?"checked":""} aria-label="Make ${escape(item.name)} the primary contact"></td>`
          +`<td>${escape(item.name)}</td>`
          +`<td><input type="checkbox" data-client-contact-auto="${escape(item.id)}" ${item.receivesAutomatedMessages?"checked":""} aria-label="${escape(item.name)} receives automated messages"></td>`
          +`<td>${escape(item.phone)}</td><td>${escape(item.title||"—")}</td>`
          +`<td><button type="button" class="text-button" data-client-contact-edit="${escape(item.id)}">Edit</button>`
          +`<button type="button" class="text-button destructive" data-client-contact-delete="${escape(item.id)}">Delete</button></td></tr>`).join("")
        +`</tbody></table></div>`
      : `<p class="pet-empty">No contacts on file.</p>`)
    // Recorded now so the salon is not asked again once something reads it. Nothing does today,
    // and saying so here is cheaper than a support conversation about messages nobody sent.
    +`<p class="pet-section-note">Receive auto msg is recorded but not acted on: Pawsh sends email,`
    +` and a contact here carries a phone number rather than an address.</p>`
    +`</section>`;
}

function renderClientEdit(){
  const customer=clientEditState.customer;if(!customer)return;
  $("#client-edit-title").textContent=`${clientName(customer)} · Edit client`;
  $("#client-edit-body").innerHTML=
    clientBasicSectionMarkup(customer)
    +clientAddressesSectionMarkup()
    +clientContactsSectionMarkup();
  bindClientEdit();
}

async function reloadClientEdit({sections=["customer","addresses","contacts"]}={}){
  const id=clientEditState.customerId;if(!id)return;
  const wants=new Set(sections);
  const [history,addresses,contacts]=await Promise.all([
    wants.has("customer")?api(`/api/customers/${id}/history`).catch(()=>null):Promise.resolve(null),
    wants.has("addresses")?api(`/api/customers/${id}/addresses`).catch(()=>null):Promise.resolve(null),
    wants.has("contacts")?api(`/api/customers/${id}/contacts`).catch(()=>null):Promise.resolve(null)
  ]);
  if(clientEditState.customerId!==id)return;
  if(history)clientEditState.customer=history.customer;
  if(addresses)clientEditState.addresses=addresses.items||[];
  if(contacts){
    clientEditState.contacts=contacts.items||[];
    clientEditState.automatedMessagesSupported=Boolean(contacts.automatedMessagesSupported);
  }
  renderClientEdit();
}

function openClientAddressEditor(existing){
  openStackedDialog({
    title:existing?"Edit address":"Add address",
    body:`<label class="stacked-field">Address<textarea name="address" rows="3" maxlength="500">${escape(existing?.address||"")}</textarea></label>`
      +`<label class="stacked-field">Label<input name="label" maxlength="60" placeholder="Home, work, summer" value="${escape(existing?.label||"")}"></label>`,
    dismissLabel:"Cancel",confirmLabel:existing?"Save":"Add",
    onConfirm:async body=>{
      const address=String(body.querySelector('[name="address"]').value||"").trim();
      if(!address){toast("Enter the address first.");return false;}
      const label=String(body.querySelector('[name="label"]').value||"").trim()||null;
      const path=`/api/customers/${clientEditState.customerId}/addresses`;
      if(existing)await api(`${path}/${existing.id}`,{method:"PATCH",body:JSON.stringify({address,label})});
      else await api(path,{method:"POST",body:JSON.stringify({address,label})});
      await reloadClientEdit({sections:["addresses","customer"]});
      return true;
    }
  });
}

function openClientContactEditor(existing){
  openStackedDialog({
    title:existing?"Edit contact":"Add contact",
    body:`<label class="stacked-field">Name<input name="name" maxlength="120" value="${escape(existing?.name||"")}"></label>`
      +`<label class="stacked-field">Phone<input name="phone" type="tel" maxlength="40" value="${escape(existing?.phone||"")}"></label>`
      +`<label class="stacked-field">Title<input name="title" maxlength="80" placeholder="Owner, partner, dog walker" value="${escape(existing?.title||"")}"></label>`
      +`<label class="stacked-check"><input type="checkbox" name="receivesAutomatedMessages" ${existing?(existing.receivesAutomatedMessages?"checked":""):"checked"}> Receive automated messages</label>`
      +`<p class="fine">Nothing sends to contacts yet: Pawsh has no SMS transport, and this record carries a phone number rather than an email address.</p>`,
    dismissLabel:"Cancel",confirmLabel:"OK",
    onConfirm:async body=>{
      const name=String(body.querySelector('[name="name"]').value||"").trim();
      const phone=String(body.querySelector('[name="phone"]').value||"").trim();
      if(!name||!phone){toast("A contact needs a name and a phone number.");return false;}
      const payload={
        name,phone,
        title:String(body.querySelector('[name="title"]').value||"").trim()||null,
        receivesAutomatedMessages:body.querySelector('[name="receivesAutomatedMessages"]').checked
      };
      const path=`/api/customers/${clientEditState.customerId}/contacts`;
      if(existing)await api(`${path}/${existing.id}`,{method:"PATCH",body:JSON.stringify(payload)});
      else await api(path,{method:"POST",body:JSON.stringify(payload)});
      await reloadClientEdit({sections:["contacts"]});
      return true;
    }
  });
}

function bindClientEdit(){
  const root=$("#client-edit-body");
  const id=clientEditState.customerId;
  const run=async(work)=>{try{await work();}catch(error){toast(error.message);}};

  root.querySelector('[data-client-section="basic"]')?.addEventListener("submit",async event=>{
    event.preventDefault();
    const form=event.currentTarget,values=Object.fromEntries(new FormData(form));
    const button=form.querySelector('button[type="submit"]');
    button.disabled=true;
    await run(async()=>{
      await api(`/api/customers/${id}`,{method:"PUT",body:JSON.stringify({
        ...values,emailAllowed:form.querySelector('[name="emailAllowed"]').checked
      })});
      await reloadClientEdit({sections:["customer"]});
      // The directory row and any open profile both show this name.
      await refresh();
      if(state.clientProfile?.data.customer.id===id)await reloadClientProfile();
      toast("Client saved");
    });
    button.disabled=false;
  });

  root.querySelector('[data-testid="client-address-add"]')?.addEventListener("click",()=>openClientAddressEditor(null));
  root.querySelectorAll("[data-client-address-edit]").forEach(button=>button.addEventListener("click",()=>
    openClientAddressEditor(clientEditState.addresses.find(item=>item.id===button.dataset.clientAddressEdit))));
  root.querySelectorAll("[data-client-address-delete]").forEach(button=>button.addEventListener("click",()=>run(async()=>{
    if(!confirm("Delete this address?"))return;
    await api(`/api/customers/${id}/addresses/${button.dataset.clientAddressDelete}`,{method:"DELETE"});
    await reloadClientEdit({sections:["addresses","customer"]});
  })));
  root.querySelectorAll("[data-client-address-primary]").forEach(input=>input.addEventListener("change",()=>run(async()=>{
    await api(`/api/customers/${id}/addresses/${input.dataset.clientAddressPrimary}`,
      {method:"PATCH",body:JSON.stringify({isPrimary:true})});
    await reloadClientEdit({sections:["addresses","customer"]});
  })));

  root.querySelector('[data-testid="client-contact-add"]')?.addEventListener("click",()=>openClientContactEditor(null));
  root.querySelectorAll("[data-client-contact-edit]").forEach(button=>button.addEventListener("click",()=>
    openClientContactEditor(clientEditState.contacts.find(item=>item.id===button.dataset.clientContactEdit))));
  root.querySelectorAll("[data-client-contact-delete]").forEach(button=>button.addEventListener("click",()=>run(async()=>{
    if(!confirm("Delete this contact?"))return;
    await api(`/api/customers/${id}/contacts/${button.dataset.clientContactDelete}`,{method:"DELETE"});
    await reloadClientEdit({sections:["contacts"]});
  })));
  root.querySelectorAll("[data-client-contact-primary]").forEach(input=>input.addEventListener("change",()=>run(async()=>{
    await api(`/api/customers/${id}/contacts/${input.dataset.clientContactPrimary}`,
      {method:"PATCH",body:JSON.stringify({isPrimary:true})});
    await reloadClientEdit({sections:["contacts"]});
  })));
  root.querySelectorAll("[data-client-contact-auto]").forEach(input=>input.addEventListener("change",()=>run(async()=>{
    await api(`/api/customers/${id}/contacts/${input.dataset.clientContactAuto}`,
      {method:"PATCH",body:JSON.stringify({receivesAutomatedMessages:input.checked})});
    await reloadClientEdit({sections:["contacts"]});
  })));
}

function bindClientEditDialog(){
  const dialog=$("#client-edit-dialog");
  dialog.querySelectorAll(".close").forEach(button=>button.addEventListener("click",()=>dialog.close()));
  dialog.addEventListener("close",()=>{$("#stacked-dialog").close();});
  dialog.querySelector('[data-testid="client-archive"]')?.addEventListener("click",async()=>{
    const customer=clientEditState.customer;if(!customer)return;
    if(!confirm(`Archive ${clientName(customer)}? History is kept and new bookings are blocked.`))return;
    try{
      await api(`/api/customers/${customer.id}/archive`,{method:"POST"});
      dialog.close();
      toast("Client archived");
      await refresh();
      showView("customers");
    }catch(error){toast(error.message);}
  });
}
bindClientEditDialog();

async function editCustomer(id){
  clientEditState.customerId=id;
  clientEditState.customer=null;
  clientEditState.addresses=[];clientEditState.contacts=[];
  const dialog=$("#client-edit-dialog");
  // Opened empty and rendered once the record is in hand. Painting from the cached copy first
  // and re-rendering when the load lands would wipe anything typed in between.
  $("#client-edit-title").textContent="Client";
  $("#client-edit-body").innerHTML=`<p class="pet-empty">Loading client…</p>`;
  if(!dialog.open)dialog.showModal();
  await reloadClientEdit();
  if(!clientEditState.customer){
    $("#client-edit-body").innerHTML=`<p class="pet-empty">This client could not be loaded.</p>`;
  }
}
async function showCustomerHistory(id) {
  try{
    const historyData=await api(`/api/customers/${id}/history`);
    // The profile projection splits appointments into what is still ahead and what is settled.
    // This summary reads both, newest first, because it is a single "what has happened" list.
    const combined=[...(historyData.upcoming?.items||[]),...(historyData.history?.items||[])]
      .sort((left,right)=>new Date(right.startAt)-new Date(left.startAt));
    const appointments=combined.map(item=>`<div><span>${escape(formatPrefDate(new Date(item.startAt),item.schedulingTimezone||schedulingZone()))} / ${escape(petName({petName:item.petName}))}</span><strong>${escape(item.status.replace("_"," "))}</strong></div>`).join("")||"<p>No appointments yet.</p>";
    const invoices=historyData.invoices.map(item=>`<div><span>Invoice ${escape(item.invoiceNumber)}</span><span><strong>${money(item.totalMinor)} / ${escape(invoiceStatusLabel(item.status))}</strong><button type="button" class="text-button history-receipt" data-invoice-id="${item.id}">${invoiceStatusHasPayment(item.status)?"Receipt":"Invoice"}</button></span></div>`).join("")||`<p>${allowed("payments.view")?"No invoices yet.":"Financial history requires payment access."}</p>`;
    const petDocuments=allowed("pets.care.view")?historyData.pets.map(pet=>`<div><span>${escape(petName(pet))}${pet.archivedAt?" (archived)":""}</span><button type="button" class="text-button history-pet-documents" data-pet-id="${pet.id}">Documents</button></div>`).join(""):"";
    openModal(`${clientName(historyData.customer)} history`,`<div class="wide history-list">${petDocuments?`<h4>Pet Care documents</h4>${petDocuments}`:""}<h4>Appointments</h4>${appointments}<h4>Transactions</h4>${invoices}</div>`,async()=>{});
    $$(".history-pet-documents").forEach(button=>button.addEventListener("click",()=>showPetDocuments(button.dataset.petId)));
    $$(".history-receipt").forEach(button=>button.addEventListener("click",async()=>{
      const receipt=await api(`/api/invoices/${button.dataset.invoiceId}/receipt`);
      $("#modal").close();setTimeout(()=>showFinancialDocument(receipt),50);
    }));
  }catch(error){toast(error.message);}
}

async function showArchivedCareRecords(){
  try{
    const records=await api("/api/customers/archived");
    const rows=records.map(record=>`<div><span>${escape(clientName(record))} / ${escape(petName({petName:record.petName}))}${record.petArchivedAt?" (pet archived)":""}</span><button type="button" class="text-button archived-pet-documents" data-pet-id="${record.petId}">Documents</button></div>`).join("");
    openModal("Archived Pet Care records",`<div class="wide history-list">${rows||"<p>No archived Pet Care records.</p>"}</div>`,async()=>{});
    $$(".archived-pet-documents").forEach(button=>button.addEventListener("click",()=>showPetDocuments(button.dataset.petId,true)));
  }catch(error){toast(error.message);}
}

async function showPetDocuments(petId,historicalOnly=false){
  try{
    const data=await api(`/api/pets/${petId}/documents`);
    const current=data.current;
    const activeRequest=null;
    const previous=data.previous.map(item=>`<div><span>${escape(item.filename)}<small>${item.expiresOn?`Expires ${formatPrefLocalDate(item.expiresOn)}`:"Expiration date not recorded"}</small></span><button type="button" class="text-button download-pet-document" data-id="${item.id}">Download</button></div>`).join("");
    const expired=current?.expiresOn&&new Date(`${current.expiresOn}T23:59:59`)<new Date();
    const currentView=current?`<section class="wide document-current" data-testid="rabies-current"><p><strong>${escape(current.filename)}</strong></p><p>${current.expiresOn?`${expired?"Rabies vaccination expired — ":"Expires "}${formatPrefLocalDate(current.expiresOn)}`:"Expiration date not recorded"}</p><button type="button" class="text-button download-pet-document" data-id="${current.id}">Download</button></section>`:`<p class="wide empty">No rabies vaccination record uploaded</p>`;
    const activityView="";
    const upload=!activeRequest&&!historicalOnly&&allowed("pets.edit")&&allowed("pets.care.edit")?`<fieldset class="wide"><legend>${current?"Replace":"Upload"} Supporting Rabies Document</legend><label>PDF<input data-testid="field-rabiesPdf" name="rabiesPdf" type="file" accept="application/pdf" required></label><label>Document date<input name="documentDate" type="date"></label><p>Optional supporting evidence only. Uploading does not change rabies expiration or compliance.</p></fieldset>`:"";
    openModal("Rabies Vaccination Record",currentView+activityView+upload+(previous?`<details class="wide"><summary>Previous records</summary><div class="history-list" data-testid="previous-rabies-records">${previous}</div></details>`:""),async(form)=>{
      if(!form.get("rabiesPdf"))return;
      const requestId=globalThis.crypto.randomUUID();
      const operation=current?"replace":"upload";
      const metadata={uploadRequestId:requestId,expectedCurrentDocumentId:current?.id||null,
        ...(current?{expectedCurrentDocumentVersion:current.version}:{}),
        documentDate:form.get("documentDate")||null,
        expiration:{intent:"preserve"}};
      const uploadForm=new FormData();uploadForm.append("metadata",JSON.stringify(metadata));uploadForm.append("file",form.get("rabiesPdf"));
      try{
        const result=await api(`/api/pets/${petId}/documents/rabies`,{method:"POST",body:uploadForm});
        return result;
      }
      catch(error){
        if(error instanceof TypeError){
          $("#modal-error").textContent="Checking upload status…";
          const status=await api(`/api/pets/${petId}/document-requests/${requestId}?operation=${operation}`);
          if(status.state==="completed")return status.result;
        }
        if(error.status===409) setTimeout(()=>showPetDocuments(petId),50);
        throw error;
      }
    });
    $$(".download-pet-document").forEach(button=>button.addEventListener("click",()=>downloadPetDocument(button.dataset.id)));
  }catch(error){toast(error.message);}
}

async function downloadPetDocument(id){
  const response=await fetch(`/api/pet-documents/${id}/download`,{credentials:"include"});
  if(!response.ok){const result=await response.json().catch(()=>({}));toast(result.error||"Document unavailable");return;}
  const blob=await response.blob();const url=globalThis.URL.createObjectURL(blob);const link=document.createElement("a");
  link.href=url;link.download="rabies-vaccination.pdf";link.click();setTimeout(()=>globalThis.URL.revokeObjectURL(url),1000);
}
function editPet(id) {
  let pet=state.pets.find(item=>item.id===id);
  openModal("Edit pet profile",petProfileFields(pet),async(form)=>{
    try{
      return await api(`/api/pets/${id}`,{method:"PUT",body:JSON.stringify({
        customerId:pet.customerId,
        name:form.get("name"),
        species:form.get("species"),
        ...breedPayload(form),
        dateOfBirth:form.get("dateOfBirth")||null,
        approximateAge:form.get("approximateAge")||null,
        weightOunces:ouncesFromWeight(form.get("weightPounds")),
        sex:form.get("sex")||null,
        coatNotes:form.get("coatNotes")||null,
        groomingPreferences:form.get("groomingPreferences")||null,
        photoPermission:form.has("photoPermission"),
        version:pet.version
      })});
    }catch(error){
      if(error.status===409){
        const latestPets=await api(`/api/pets?customerId=${pet.customerId}`,{cache:"no-store"});
        state.pets=[...state.pets.filter(item=>item.customerId!==pet.customerId),...latestPets];
        pet=state.pets.find(item=>item.id===id);
        $("#modal-fields").innerHTML=petProfileFields(pet);
        setupBreedAutocomplete();
      }
      markBreedRefusal(error);
      throw error;
    }
  });
  setupBreedAutocomplete();
}

function petProfileFields(pet){
  return field("name","Pet name","text",`value="${escape(pet.name||"")}"`)+
    petTypeField(pet.species)+
    breedField(pet)+
    field("dateOfBirth","Date of birth","date",`value="${pet.dateOfBirth?String(pet.dateOfBirth).slice(0,10):""}"`)+
    field("approximateAge","Approximate age","text",`value="${escape(pet.approximateAge||"")}"`)+
    field("weightPounds",weightFieldLabel(),"number",`${weightInputAttrs()} value="${weightInputValue(pet.weightOunces)}"`)+
    field("sex","Sex","text",`value="${escape(pet.sex||"")}"`)+
    field("coatNotes","Coat notes","text",`value="${escape(pet.coatNotes||"")}"`,true)+
    field("groomingPreferences","Grooming preferences","text",`value="${escape(pet.groomingPreferences||"")}"`,true)+
    `<label><input data-testid="field-photoPermission" name="photoPermission" type="checkbox" ${pet.photoPermission?"checked":""}> Photo permission</label>`;
}

function petCareFields(pet){
  const expiration=pet.vaccinationExpiresOn?String(pet.vaccinationExpiresOn).slice(0,10):null;
  const nextDate=pet.nextAppointmentLocalStart?String(pet.nextAppointmentLocalStart).slice(0,10):null;
  const display=date=>formatPrefLocalDate(date);
  const warning=!expiration?"Rabies expiration date not provided."
    :expiration<businessDate()?`Rabies vaccination expired on ${display(expiration)}.`
    :nextDate&&expiration<nextDate?`Rabies expires ${display(expiration)} and will not be current for the appointment on ${display(nextDate)}.`
    :`Rabies vaccination is current${nextDate?" for the next appointment":""}.`;
  return field("safetyAlerts","Safety alerts","text",`value="${escape(pet.safetyAlerts||"")}"`,true)+
    field("behaviorNotes","Behavior notes","text",`value="${escape(pet.behaviorNotes||"")}"`,true)+
    field("medicalNotes","Medical notes","text",`value="${escape(pet.medicalNotes||"")}"`,true)+
    field("emergencyContact","Emergency contact","text",`value="${escape(pet.emergencyContact||"")}"`,true)+
    `<fieldset class="wide"><legend>Rabies Information</legend>`+
    field("vaccinationExpiresOn","Expiration date","date",`value="${pet.vaccinationExpiresOn?String(pet.vaccinationExpiresOn).slice(0,10):""}"`)+
    `<p class="wide rabies-profile-status" role="status" data-testid="rabies-profile-status">${escape(warning)}</p>`+
    `<p class="wide">Supporting rabies document (optional). Uploading evidence does not change the expiration date or compliance state.</p></fieldset>`;
}

function editPetCare(id){
  let pet=state.pets.find(item=>item.id===id);
  openModal("Edit Pet Care",petCareFields(pet),async(form)=>{
    try{
      return await api(`/api/pets/${id}/care`,{method:"PUT",body:JSON.stringify({
        safetyAlerts:form.get("safetyAlerts")||null,
        behaviorNotes:form.get("behaviorNotes")||null,
        medicalNotes:form.get("medicalNotes")||null,
        emergencyContact:form.get("emergencyContact")||null,
        vaccinationExpiresOn:form.get("vaccinationExpiresOn")||null,
        version:pet.version
      })});
    }catch(error){
      if(error.status===409){
        const latest=await api(`/api/customers/${pet.customerId}/history`,{cache:"no-store"});
        state.pets=[...state.pets.filter(item=>item.customerId!==pet.customerId),...latest.pets];
        pet=state.pets.find(item=>item.id===id);
        $("#modal-fields").innerHTML=petCareFields(pet);
      }
      throw error;
    }
  });
}

function field(name, label, type = "text", extra = "", wide = false) {
  return `<label class="${wide ? "wide" : ""}">${label}<input data-testid="field-${name}" name="${name}" type="${type}" ${extra}></label>`;
}
// ── Pet type and breed taxonomy ───────────────────────────────────────────────────────────────
// Breeds are canonical and keyed by pet type: the server accepts a breed id, a deliberate
// "Other" with free text, or text it can itself resolve, and refuses anything else. The editor
// therefore resolves the pet type first and scopes every breed lookup to it, so it can never
// offer a breed the server would then refuse.
function petTypeNames(){return state.petTypes.length?state.petTypes.map(type=>type.name):PET_TYPES;}
// --- Weights, in the unit the workspace reads ------------------------------
//
// WHY THE TIER CAPTIONS ARE NO LONGER WRITTEN HERE. The six price bands were defined in OUNCES
// and chosen in pounds - 320, 640, 960, 1280 and 1600 oz are 20, 40, 60, 80 and 100 lb - and this
// file used to restate their captions twice by hand, once in the pricing matrix and once in the
// service editor, neither of them anywhere near the bounds they describe. `/api/me` now publishes
// `weightTiers` derived from the same boundaries `resolveWeightTier` compares against, so a
// caption and its band cannot drift apart because there is only one of them.
//
// WHY THE PET WEIGHTS MOVED WITH THEM. A workspace on kilograms that converted only the captions
// would show a 19.1 kg dog in a column headed "21-40 lb", and the operator could not tell whether
// the tier, the weight or the price was wrong. The domain module says so in as many words. So
// every place this client prints a pet weight, and both places it reads one back off a form, go
// through the same unit.
//
// `pets.weight_ounces` does not move. The unit is a PRESENTATION setting: it decides what an
// operator reads, never what the database holds and never which tier a pet lands in. A workspace
// can switch it twice a day and no price changes.
const WEIGHT_OUNCES_PER={lb:16,kg:1000/28.349523125};
// The pound bands as they have always read, so a client whose `/api/me` predates 0047 - or whose
// session was restored from a cached payload - captions its pricing columns rather than blanking
// six table headers.
const WEIGHT_TIER_FALLBACK=[
  {code:"TIER_1",label:"1–20 lb"},{code:"TIER_2",label:"21–40 lb"},{code:"TIER_3",label:"41–60 lb"},
  {code:"TIER_4",label:"61–80 lb"},{code:"TIER_5",label:"81–100 lb"},{code:"TIER_6",label:"100+ lb"}
];
function workspaceWeightUnit(){
  const unit=state.me?.weightUnit||state.me?.business?.weightUnit;
  return unit==="kg"?"kg":"lb";
}
/** The served bands, matched on `code` and never on label text. */
function weightTierList(){
  const served=state.me?.weightTiers;
  return Array.isArray(served)&&served.length?served:WEIGHT_TIER_FALLBACK;
}
function weightFromOunces(ounces){
  if(ounces===null||ounces===undefined||ounces==="")return null;
  const value=Number(ounces);
  return Number.isFinite(value)?value/WEIGHT_OUNCES_PER[workspaceWeightUnit()]:null;
}
/** The inverse, for a number an operator typed. Whole ounces, because that is the column. */
function ouncesFromWeight(value){
  const entered=String(value??"").trim();
  if(!entered)return null;
  const number=Number(entered);
  if(!Number.isFinite(number)||number<0)return null;
  return Math.round(number*WEIGHT_OUNCES_PER[workspaceWeightUnit()]);
}
// Three decimals, then the trailing zeros dropped: enough that a kilogram value round-trips
// through `ouncesFromWeight` to the same ounce, without printing 9.0718474 into a form field.
function weightInputValue(ounces){
  const value=weightFromOunces(ounces);
  return value===null?"":String(Number(value.toFixed(3)));
}
/** "42 lb", "3.5 lb", "19.1 kg". A trailing `.0` is trimmed. */
function formatPetWeight(ounces){
  const value=weightFromOunces(ounces);
  if(value===null)return null;
  const text=value.toFixed(1);
  return (text.includes(".")?text.replace(/\.?0+$/,""):text)+" "+workspaceWeightUnit();
}
function weightFieldLabel(){return "Weight ("+workspaceWeightUnit()+")";}
// One ounce, expressed in the display unit, is the finest the column can hold.
function weightInputAttrs(){
  return workspaceWeightUnit()==="kg"?`min="0.03" step="0.01"`:`min="0.0625" step="0.0625"`;
}
function petTypeIdFor(species){
  const wanted=normalizeBreedFilter(species??"");
  if(!wanted)return null;
  return state.petTypes.find(type=>type.search===wanted||normalizeBreedFilter(type.name)===wanted)?.id||null;
}
/** Loaded rows for a type, or null while they are still unknown - the two read differently. */
function breedsForType(petTypeId){
  if(!petTypeId)return [];
  // The dog catalog already arrives with the session, so the commonest editor opens warm.
  if(!state.breedsByType[petTypeId]&&state.dogBreeds.length&&petTypeId===petTypeIdFor("dog")){
    state.breedsByType[petTypeId]=state.dogBreeds;
  }
  return state.breedsByType[petTypeId]||null;
}
async function loadBreedsForType(petTypeId){
  if(!petTypeId||breedsForType(petTypeId))return;
  state.breedsByType[petTypeId]=await api(`/api/pet-types/${petTypeId}/breeds`);
}
/** The pet type picker. Values stay the type's name because `species` is what pets store. */
function petTypeField(value=""){
  const names=petTypeNames();
  const current=value||names[0]||"";
  // A species the taxonomy does not list is kept rather than silently rewritten to Dog.
  const options=current&&!names.some(name=>normalizeBreedFilter(name)===normalizeBreedFilter(current))
    ? [...names,current] : names;
  return `<label>Pet type<select data-testid="field-species" name="species" required>`
    +options.map(name=>`<option value="${escape(name)}" ${normalizeBreedFilter(name)===normalizeBreedFilter(current)?"selected":""}>${escape(name)}</option>`).join("")
    +`</select></label>`;
}
function breedField(pet={}) {
  const other=Boolean(pet.breedOther);
  return `<label class="breed-combobox">Breed`
    +`<input data-testid="field-breed" name="breed" type="text" value="${escape(other?"Other":(pet.breed||""))}" autocomplete="off" aria-label="Breed" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="breed-options" aria-activedescendant="">`
    +`<input type="hidden" data-testid="field-breedId" name="breedId" value="${escape(pet.breedId||"")}">`
    +`<span class="breed-options" id="breed-options" role="listbox" aria-label="Breed suggestions" hidden></span></label>`
    +`<p class="breed-hint" id="breed-hint" data-testid="breed-hint" role="status" hidden></p>`
    +`<label class="breed-other-field" data-testid="breed-other-field" ${other?"":"hidden"}>Breed or mix description`
    +`<input data-testid="field-breedOther" name="breedOther" type="text" maxlength="120" autocomplete="off" aria-label="Breed or mix description" value="${escape(pet.breedOther||"")}" ${other?"required":"disabled"}></label>`;
}
function setupBreedAutocomplete() {
  const input=$('[name="breed"]'),list=$("#breed-options");if(!input||!list)return;
  const hint=$("#breed-hint"),otherField=$(".breed-other-field"),otherInput=$('[name="breedOther"]');
  const form=input.closest("form");
  const idField=form?.querySelector('[name="breedId"]')||$('[name="breedId"]');
  const speciesField=form?.querySelector('[name="species"]');
  let options=[],active=-1,otherMode=Boolean(otherInput&&!otherInput.disabled);
  let petTypeId=petTypeIdFor(speciesField?speciesField.value:"dog");
  const alive=()=>document.contains(input);
  const setHint=text=>{if(!hint)return;hint.textContent=text||"";hint.hidden=!text;};
  const close=()=>{list.hidden=true;input.setAttribute("aria-expanded","false");input.setAttribute("aria-activedescendant","");active=-1;};
  const ensureBreeds=()=>{loadBreedsForType(petTypeId).then(()=>{if(alive()&&!list.hidden)render();}).catch(()=>{});};
  // Leaving Other has to take its free text with it: a description left behind would be
  // resubmitted and would quietly outrank the catalog breed the user just chose.
  const leaveOther=()=>{
    if(!otherMode)return;
    otherMode=false;
    if(otherField)otherField.hidden=true;
    if(otherInput){otherInput.required=false;otherInput.disabled=true;otherInput.value="";}
  };
  const enterOther=()=>{
    // Only text that matched nothing in the catalog is carried across. A canonical name never
    // is: that is how a real breed would silently become an unlisted one.
    const carried=otherMode?otherInput?.value:(options.length===1&&!idField?.value?input.value.trim():"");
    otherMode=true;
    input.value="Other";
    input.removeAttribute("aria-invalid");
    if(idField)idField.value="";
    if(otherField)otherField.hidden=false;
    if(otherInput){otherInput.disabled=false;otherInput.required=true;otherInput.value=carried||"";}
    close();
    setHint("Recorded as Other. Describe the breed or mix below.");
    otherInput?.focus();
  };
  const choose=index=>{
    const option=options[index];if(!option)return;
    if(option.kind==="other")return enterOther();
    leaveOther();
    input.value=option.breed.name;
    input.removeAttribute("aria-invalid");
    if(idField)idField.value=option.breed.id;
    close();setHint("");
    input.dispatchEvent(new globalThis.Event("change",{bubbles:true}));
  };
  const render=()=>{
    const query=otherMode?"":normalizeBreedFilter(input.value);
    const catalog=breedsForType(petTypeId);
    const matches=query&&catalog?catalog.filter(item=>item.active&&item.search.includes(query)).sort((a,b)=>Number(!a.search.startsWith(query))-Number(!b.search.startsWith(query))||a.name.localeCompare(b.name)).slice(0,12):[];
    // Other is always the last option, so the way out of the catalog is reachable by keyboard
    // whether or not the query matched anything.
    options=[...matches.map(breed=>({kind:"breed",breed})),{kind:"other"}];
    // Nothing is preselected when only Other is offered, so Enter still submits the form
    // rather than committing the user to an Other they did not ask for.
    active=matches.length?0:-1;
    list.innerHTML=options.map((option,index)=>option.kind==="other"
      ? `<button type="button" id="breed-option-${index}" class="breed-option-other" role="option" aria-selected="${index===active}" data-index="${index}" data-testid="breed-option-other">Other</button>`
      : `<button type="button" id="breed-option-${index}" role="option" aria-selected="${index===active}" data-index="${index}">${escape(option.breed.name)}</button>`).join("");
    list.hidden=false;input.setAttribute("aria-expanded","true");
    input.setAttribute("aria-activedescendant",active>=0?`breed-option-${active}`:"");
    setHint(!petTypeId?"No breed catalog for this pet type. Choose Other to describe the breed."
      :!catalog?"Loading breeds…"
      :query&&!matches.length?"No matching breeds. Choose Other to record an unlisted or mixed breed."
      :"");
  };
  const move=direction=>{
    if(!options.length)return;
    active=((active+direction)%options.length+options.length)%options.length;
    list.querySelectorAll('[role="option"]').forEach((option,index)=>option.setAttribute("aria-selected",String(index===active)));
    input.setAttribute("aria-activedescendant",`breed-option-${active}`);
    list.querySelector(`#breed-option-${active}`)?.scrollIntoView({block:"nearest"});
  };
  input.addEventListener("input",()=>{
    // Typing invalidates a catalog selection: the id must not outlive the name it stood for.
    if(idField)idField.value="";
    input.removeAttribute("aria-invalid");
    leaveOther();
    render();
  });
  input.addEventListener("focus",()=>{if(input.value&&!otherMode)render();});
  input.addEventListener("keydown",event=>{
    // Opening the list also lands on an option when nothing was preselected, so Other is one
    // keypress away on the query that has no matches - which is when it is needed.
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();const step=event.key==="ArrowDown"?1:-1;if(list.hidden){render();if(active<0)move(step);}else move(step);}
    else if(event.key==="Enter"&&!list.hidden&&active>=0){event.preventDefault();choose(active);}
    else if(event.key==="Escape"){event.preventDefault();close();}
  });
  list.addEventListener("pointerdown",event=>{const option=event.target.closest("[data-index]");if(option){event.preventDefault();choose(Number(option.dataset.index));}});
  input.addEventListener("blur",()=>setTimeout(()=>{if(alive())close();},100));
  speciesField?.addEventListener("change",()=>{
    const nextTypeId=petTypeIdFor(speciesField.value);
    if(nextTypeId===petTypeId)return;
    petTypeId=nextTypeId;
    close();
    // A canonical breed belongs to one pet type, so changing the type releases the selection
    // instead of saving a breed that contradicts it. Legacy free text is left untouched: it
    // carries no id, and the server passes unchanged text through so unrelated edits still save.
    if(idField?.value){
      idField.value="";input.value="";
      setHint("Pet type changed. Choose a breed for the new type, or select Other.");
    }else setHint("");
    ensureBreeds();
  });
  ensureBreeds();
}
/**
 * Says which of the server's three breed inputs the form meant, and nothing more - the server
 * decides what a breed is. A deliberate Other wins, then a catalog id, then plain text the
 * server may still match or grandfather. An untouched legacy breed leaves here as text with no
 * id and no `breedOther`, which is exactly what lets the server pass it through unchanged.
 */
function breedPayload(form){
  const petTypeId=petTypeIdFor(form.get("species"));
  const description=String(form.get("breedOther")||"").trim();
  if(description)return {petTypeId,breedId:null,breed:description,breedOther:description};
  const breedId=String(form.get("breedId")||"").trim();
  const breed=String(form.get("breed")||"").trim();
  // An id the salon has since switched off would be refused outright, and refusing it here
  // would block a weight edit on a pet nobody was touching the breed of. Sending the stored
  // text instead lets the server resolve it or pass it through, which is what it already does
  // for a breed that predates the taxonomy.
  const catalog=breedsForType(petTypeId);
  const selectable=!breedId||!catalog||catalog.some(item=>item.id===breedId&&item.active);
  return {petTypeId,breedId:selectable?breedId||null:null,breed:breed||null,breedOther:null};
}
/** A refused breed is a field problem, so it is reported on the field and not only in the form. */
function markBreedRefusal(error){
  if(!["BREED_NOT_IN_CATALOG","PET_TYPE_NOT_FOUND"].includes(error?.data?.code))return;
  const input=$('[name="breed"]'),hint=$("#breed-hint");
  if(!input)return;
  // Focus first: it reopens the suggestions, and the refusal has to be the message left standing.
  input.focus();
  input.setAttribute("aria-invalid","true");
  if(hint){hint.textContent=error.message;hint.hidden=false;}
}
function select(name, label, options, wide = false, selectedValue = "", required = true) {
  return `<label class="${wide ? "wide" : ""}">${label}<select data-testid="field-${name}" name="${name}" ${required?"required":""}><option value="">Choose…</option>${options.map(([v,l,disabled]) => `<option value="${v}" ${disabled?"disabled":""} ${String(v)===String(selectedValue)?"selected":""}>${escape(l)}</option>`).join("")}</select></label>`;
}
function openModal(title, fields, submit, options={}) {
  $("#modal-title").textContent = title; $("#modal-fields").innerHTML = fields; $("#modal-error").textContent = "";
  const cancelButton=$("#modal .modal-actions .close"),submitButton=$("[data-testid=\"modal-submit\"]");
  cancelButton.textContent=options.cancelLabel||"Cancel";submitButton.hidden=!submit;submitButton.textContent=options.submitLabel||"Save";
  $("#modal-form").onsubmit = async (event) => {
    event.preventDefault(); $("#modal-error").textContent = "";
    if(!submit)return;
    const form=event.currentTarget;const button=form.querySelector('[type="submit"]');const original=button.textContent;
    button.disabled=true;button.textContent="Saving…";form.setAttribute("aria-busy","true");
    try {
      // A submit may return a function to run after the dialog closes, or {afterClose,message}
      // when the honest sentence is not "<title> saved". Starting a terminal payment saves
      // nothing yet, and saying it did would be the first of several small lies.
      const outcome=await submit(new FormData(form));
      // The object form is recognised only by the presence of `afterClose`, so a submit that
      // simply returns the server's reply - which may carry any field at all, `message` included -
      // cannot accidentally rewrite what this dialog says it did.
      const descriptor=outcome&&typeof outcome==="object"&&"afterClose" in outcome?outcome:null;
      const afterClose=typeof outcome==="function"?outcome:descriptor?.afterClose;
      const message=descriptor?.message||`${title} saved`;
      if(state.me)await refresh(); $("#modal").close(); toast(message);
      if(typeof afterClose==="function")runDetached(afterClose);
    }
    catch (error) {
      if(error.retryConflictOverride) renderConflictOverride(error);
      else {
        $("#modal-error").textContent = error.message;
        // The message is the server's, verbatim. The re-read behind it is what stops the calendar
        // still offering Move on every other card once this dialog closes.
        if(appointmentMoveRefused(error))await reconcileAppointmentLock();
        if(error.reconcileLifecycle||error.reconcileFinancial)await refresh().catch(failure=>toast(failure.message));
      }
    }
    finally{button.disabled=false;button.textContent=original;form.removeAttribute("aria-busy");}
  };
  $("#modal").showModal();
}

function schedulingMutation(path,payload,operationLabel){
  const identity=`pawsh-scheduling:${path}:${JSON.stringify(payload)}`;
  const key=globalThis.sessionStorage.getItem(identity)||globalThis.crypto.randomUUID();
  globalThis.sessionStorage.setItem(identity,key);
  return api(path,{method:path.includes("/schedule")?"PATCH":"POST",headers:{"Idempotency-Key":key},body:JSON.stringify(payload)}).then(result=>{
    globalThis.sessionStorage.removeItem(identity);
    return result;
  }).catch(error=>{
    if(error.status)globalThis.sessionStorage.removeItem(identity);
    if(error.status===409&&error.data?.code==="SCHEDULING_CONFLICT"&&error.data.canOverride){
      error.operationLabel=operationLabel;
      error.proposedEmployee=state.employees.find(item=>item.id===payload.employeeId)?.displayName||"Selected employee";
      error.proposedStart=payload.localStart.replace("T"," ");
      error.retryConflictOverride=()=>schedulingMutation(path,{...payload,overrideConflict:true},operationLabel);
    }
    throw error;
  });
}

// The booking workspace and the shared dialog both raise overlap conflicts, so the override
// prompt is told which error region to draw into and which dialog to close on success.
function renderConflictOverride(error,{container=$("#modal-error"),dialog=$("#modal"),afterClose=null}={}){
  container.textContent="";
  const conflicts=error.data.conflicts||[];
  const proposed=error.proposedStart;
  const locationConflictTimes=conflicts.map(item=>`${formatPrefDateAndTime(new Date(item.startsAt))} to ${formatPrefTime(new Date(item.endsAt))}`).join(", ");
  const message=document.createElement("span");
  message.textContent=`${error.proposedEmployee} already has an overlapping appointment. ${error.operationLabel} at ${proposed} will overlap ${locationConflictTimes}.`;
  const button=document.createElement("button");
  button.type="button";
  button.className="secondary";
  button.dataset.testid="confirm-conflict-override";
  button.textContent=error.operationLabel==="Reschedule"?"Move anyway":"Book anyway";
  button.addEventListener("click",async()=>{
    button.disabled=true;
    try{
      await error.retryConflictOverride();
      await refresh();
      dialog.close();
      toast(`${error.operationLabel} saved with intentional overlap`);
      if(afterClose)runDetached(afterClose);
    }catch(retryError){
      if(retryError.status===403)await reconcilePermissions();
      container.textContent=retryError.message;
    }finally{button.disabled=false;}
  });
  container.append(message,button);
}

/* ---------------------------------------------------------------------------
   Create Appointment workspace.

   Booking used to be the same narrow field list every other dialog uses, which meant
   the person taking the call could not see who they were booking for. This opens a
   two-pane workspace instead: the client on the left, the appointment on the right.
   The order deliberately mirrors how the call goes — find the client, deal with any
   vaccination problem before committing to a date, then pick the pet and the work.
   --------------------------------------------------------------------------- */
const bookingScope = () => $("#booking-dialog");
const bq = (selector) => bookingScope().querySelector(selector);
const bqa = (selector) => [...bookingScope().querySelectorAll(selector)];

function resetBookingState({preset=null,groomerId=null,customerId=null,petId=null}={}) {
  state.booking={preset,groomerId,customerId,petId,client:null,agreements:null,
    defaults:null,vaccinationPrompted:false,clientQuery:""};
}
resetBookingState();

function bookingLocalDate() {
  return String(bq('[name="startAt"]')?.value||state.booking.preset||"").slice(0,10)||null;
}
function bookingClientPets() {
  return (state.booking.client?.pets||[]).filter((pet)=>!pet.archivedAt);
}
function bookingSelectedPet() {
  return bookingClientPets().find((pet)=>pet.id===state.booking.petId)||null;
}

// An empty slot can become either an appointment or blocked time. Both are the same
// gesture on the same empty space, so the slot offers both rather than assuming one.
function closeSlotMenu() {
  const menu=$("#slot-menu");
  if(menu&&!menu.hidden){menu.hidden=true;delete menu.dataset.slot;delete menu.dataset.slotGroomer;}
}
function openSlotMenu(slot) {
  const menu=$("#slot-menu");
  closeCalendarMenus();
  menu.dataset.slot=slot.dataset.slot;
  menu.dataset.slotGroomer=slot.dataset.slotGroomer||"";
  menu.hidden=false;
  const anchor=slot.getBoundingClientRect(),size=menu.getBoundingClientRect();
  const left=Math.max(8,Math.min(anchor.left,globalThis.innerWidth-size.width-8));
  const below=anchor.bottom+4;
  const top=below+size.height>globalThis.innerHeight-8
    ? Math.max(8,anchor.top-size.height-4) : below;
  menu.style.left=`${left}px`;menu.style.top=`${top}px`;
  menu.querySelector("button")?.focus();
}

function renderBookingClientPane() {
  const pane=$("#booking-client");
  if(!state.booking.client){
    const query=state.booking.clientQuery.trim().toLowerCase();
    const matches=state.customers.filter((customer)=>!query
      ||`${clientName(customer)} ${customer.email??""} ${customer.phone??""}`
        .toLowerCase().includes(query)).slice(0,50);
    pane.innerHTML=`<div class="booking-client-search">
      <label class="wide">Client<input type="search" data-testid="booking-client-search" autocomplete="off"
        placeholder="Click to select client"></label>
      <div class="booking-client-results" data-testid="booking-client-results">${
        matches.length
          ? matches.map((customer)=>`<button type="button" data-booking-client="${customer.id}">${
            escape(`${clientName(customer)}`)
          }<small>${escape(customer.phone||customer.email||"No contact on file")}</small></button>`).join("")
          : `<p class="booking-client-empty">No client matches that search.</p>`
      }</div></div>`;
    const search=pane.querySelector('[data-testid="booking-client-search"]');
    // Assigned rather than rendered into the attribute: escape() leaves quotes intact, and the
    // query is whatever the user typed.
    search.value=state.booking.clientQuery;
    // The search sits inside the booking form, so Enter would otherwise submit an appointment
    // that has no pet or services yet.
    search.addEventListener("keydown",event=>{if(event.key==="Enter")event.preventDefault();});
    search.addEventListener("input",()=>{
      state.booking.clientQuery=search.value;
      const caret=search.selectionStart;
      renderBookingClientPane();
      const next=$("#booking-client").querySelector('[data-testid="booking-client-search"]');
      next.focus();next.setSelectionRange(caret,caret);
    });
    pane.querySelectorAll("[data-booking-client]").forEach((button)=>
      button.addEventListener("click",()=>selectBookingClient(button.dataset.bookingClient)));
    return;
  }
  const client=state.booking.client.customer;
  const unsigned=(state.booking.agreements?.items||[]).filter((item)=>item.required&&item.status!=="signed");
  const notes=(state.booking.client.notes||[]).slice(0,3);
  pane.innerHTML=
    `<button type="button" class="booking-client-back" data-testid="booking-client-back">&lt;Select another client</button>`+
    (unsigned.length
      ? `<div class="booking-client-banner" data-testid="booking-client-agreement-banner">Client has ${unsigned.length} unsigned required agreement${unsigned.length===1?"":"s"}</div>`
      : "")+
    `<p class="booking-client-identity" data-testid="booking-client-name">${escape(`${clientName(client)}`)}</p>`+
    `<div class="booking-client-contact">`+
      (client.phone?`<span>${escape(client.phone)}</span>`:"")+
      (client.email?`<span>${escape(client.email)}</span>`:"")+
      `<span>Preferred staff: ${escape(client.preferredEmployeeName||"Not set")}</span>`+
    `</div>`+
    `<div class="booking-client-section"><h5>Notes</h5>${
      notes.length
        ? notes.map((note)=>`<p class="booking-client-note">${escape(note.body)}<small>${escape(note.authorName||"Unknown author")}</small></p>`).join("")
        : `<p class="booking-client-note booking-client-empty">No notes on this client.</p>`
    }</div>`+
    `<div class="booking-client-section"><h5>Pets</h5>${
      bookingClientPets().length
        ? bookingClientPets().map((pet)=>`<p class="booking-client-note">${escape(petName(pet))}<small>${escape(pet.breed||pet.species||"")}</small></p>`).join("")
        : `<p class="booking-client-note booking-client-empty">No active pets on this client.</p>`
    }</div>`;
  pane.querySelector('[data-testid="booking-client-back"]').addEventListener("click",()=>{
    state.booking.client=null;state.booking.agreements=null;state.booking.petId=null;
    state.booking.defaults=null;state.booking.vaccinationPrompted=false;
    renderBookingClientPane();renderBookingDetailPane();
  });
}

async function selectBookingClient(customerId) {
  state.booking.customerId=customerId;
  const [client,agreements]=await Promise.all([
    api(`/api/customers/${customerId}/history`),
    api(`/api/customers/${customerId}/agreements`).catch(()=>null)
  ]);
  if(state.booking.customerId!==customerId)return;
  state.booking.client=client;state.booking.agreements=agreements;
  const pets=bookingClientPets();
  state.booking.petId=pets.length===1?pets[0].id:null;
  state.booking.vaccinationPrompted=false;
  renderBookingClientPane();renderBookingDetailPane();
  promptBookingVaccination();
  if(state.booking.petId)await applyBookingDefaults();
}

function bookingPetRow() {
  const pet=bookingSelectedPet();
  return pet
    ? `<span class="booking-pet-name" data-testid="booking-pet-name">${escape(petName(pet))}</span>`
      +`<button type="button" class="secondary compact" data-testid="booking-add-pet">Change pet</button>`
    : `<span class="booking-pet-empty">No pet selected for this appointment.</span>`
      +`<button type="button" class="secondary compact" data-testid="booking-add-pet">+ Add pet</button>`;
}

// Says where the pre-ticked services came from. A pet with no paid visit gets nothing
// ticked and is told so, rather than an empty selection being passed off as a default.
function bookingDefaultsNote() {
  const defaults=state.booking.defaults;
  if(!bookingSelectedPet())return "Choose a pet to load its usual services.";
  if(!defaults)return "Loading this pet's usual services…";
  if(defaults.serviceSource==="last_paid_visit"){
    const when=defaults.lastPaidVisitAt
      ? ` on ${formatPrefDate(new Date(defaults.lastPaidVisitAt))}`
      : "";
    return `Services carried over from this pet's last paid visit${when}.`;
  }
  if(defaults.serviceSource==="last_paid_visit_unavailable")
    return "This pet's last paid visit used services that are no longer active, so nothing was pre-selected.";
  return "This pet has no paid visit yet, so no services were pre-selected.";
}

function bookingDefaultGroomerId() {
  return state.booking.groomerId
    ||state.booking.defaults?.groomers?.[0]?.id
    ||state.booking.client?.customer?.preferredEmployeeId
    ||"";
}

function renderBookingDetailPane() {
  const detail=$("#booking-detail");
  if(!state.booking.client){
    detail.innerHTML=`<div class="booking-empty" data-testid="booking-detail-empty">Select a client to build the appointment.</div>`;
    return;
  }
  detail.innerHTML=
    `<div class="booking-field-row">`+
      select("employeeId","Groomer",state.employees.filter((employee)=>employee.active)
        .map((employee)=>[employee.id,employee.displayName]),false,bookingDefaultGroomerId())+
      field("startAt","Start time","datetime-local",`required value="${escape(state.booking.preset||"")}"`)+
    `</div>`+
    `<div class="booking-pet" data-testid="booking-pet-row">${bookingPetRow()}</div>`+
    `<input type="hidden" name="petId" value="${escape(state.booking.petId||"")}">`+
    `<p class="booking-defaults-note" data-testid="booking-defaults-note">${escape(bookingDefaultsNote())}</p>`+
    bookingServiceCheckboxes((state.booking.defaults?.services||[]).map((service)=>service.id))+
    disambiguationField()+
    `<div class="pricing-preview" role="status" aria-live="polite" data-testid="booking-price-status">Choose a pet and service to calculate pricing.</div>`+
    `<p role="status" aria-live="polite" data-testid="booking-rabies-status">Choose a pet and appointment time to evaluate rabies information.</p>`+
    field("notes","Appointment note","text","",true);
  bindBookingDetail();
  updateBookingRabiesPreview();updateBookingPricePreview();
}

function bindBookingPetControl() {
  bq('[data-testid="booking-add-pet"]')?.addEventListener("click",openBookingPetPicker);
}

function bindBookingDetail() {
  bindBookingPetControl();
  bq('[name="startAt"]')?.addEventListener("change",()=>{
    state.booking.preset=bq('[name="startAt"]').value;
    state.booking.vaccinationPrompted=false;
    updateBookingRabiesPreview();promptBookingVaccination();
  });
  bqa('input[name="serviceIds"]').forEach((input)=>
    input.addEventListener("change",()=>{syncBookingGroomerOptions();updateBookingPricePreview();}));
  bindBookingServiceSections();
  syncBookingGroomerOptions();
}

// Keeps the groomer list honest as the service selection changes. A groomer who stops being
// offerable loses the selection rather than keeping it out of sight: the server would refuse it.
function syncBookingGroomerOptions() {
  const groomer=bq('[name="employeeId"]');if(!groomer)return;
  const current=groomer.value;
  const options=groomerPickerOptions(bqa('input[name="serviceIds"]:checked').map((input)=>input.value));
  groomer.innerHTML=`<option value="">Choose…</option>`+options.map(([value,label,disabled])=>
    `<option value="${value}" ${disabled?"disabled":""}>${escape(label)}</option>`).join("");
  groomer.value=options.some(([value,,disabled])=>value===current&&!disabled)?current:"";
}

let bookingPriceSequence=0;
async function updateBookingPricePreview() {
  const status=bq('[data-testid="booking-price-status"]');if(!status)return;
  const sequence=++bookingPriceSequence;
  const serviceIds=bqa('input[name="serviceIds"]:checked').map((input)=>input.value);
  if(!state.booking.petId||!serviceIds.length){
    status.textContent="Choose a pet and service to calculate pricing.";return;
  }
  status.textContent="Calculating authoritative price…";
  try{
    const prices=await api("/api/pricing/resolve",{method:"POST",
      body:JSON.stringify({petId:state.booking.petId,serviceIds})});
    if(sequence!==bookingPriceSequence)return;
    const resolved=prices.filter((price)=>price.status==="resolved");
    const summary=resolved.length===prices.length
      ? `<p class="booking-service-summary"><strong>${prices.length} service${prices.length===1?"":"s"} · ${resolved.reduce((sum,price)=>sum+Number(price.durationMinutes),0)} min · ${money(resolved.reduce((sum,price)=>sum+Number(price.priceMinor),0))}</strong></p>`
      : "";
    status.innerHTML=prices.map((price)=>price.status==="resolved"
      ? `<p><strong>${escape(price.name)}</strong> · ${money(price.priceMinor)} · ${price.durationMinutes} min${price.weightTierLabel?` · ${escape(price.weightTierLabel)}`:""}</p>`
      : `<p><strong>${escape(price.name)}</strong><br>${price.status==="weight_required"?"Weight required to determine pricing.":price.status==="quote_required"?"Quote required.":"Admin price confirmation required."}</p>`
    ).join("")+summary;
  }catch(error){if(sequence===bookingPriceSequence)status.textContent=error.message;}
}

function updateBookingRabiesPreview() {
  const status=bq('[data-testid="booking-rabies-status"]');if(!status)return;
  if(!allowed("pets.care.view")){
    status.textContent="Rabies information is not visible with your permissions.";return;
  }
  const pet=bookingSelectedPet(),date=bookingLocalDate();
  if(!pet||!date){
    status.textContent="Choose a pet and appointment time to evaluate rabies information.";return;
  }
  const expiration=pet.vaccinationExpiresOn?String(pet.vaccinationExpiresOn).slice(0,10):null;
  const verdict=!expiration?"Not provided"
    :expiration<date?"Expires before appointment — updated rabies information is required"
    :"Valid for appointment";
  status.textContent=`Rabies: ${verdict}${expiration?`. Expiration ${expiration}. Appointment ${date}.`:""}`;
}

async function applyBookingDefaults() {
  const petId=state.booking.petId;if(!petId)return;
  state.booking.defaults=null;
  const note=bq('[data-testid="booking-defaults-note"]');
  if(note)note.textContent=bookingDefaultsNote();
  let defaults;
  try{defaults=await api(`/api/pets/${petId}/booking-defaults`);}
  catch(error){if(note)note.textContent=error.message;return;}
  if(state.booking.petId!==petId)return;
  state.booking.defaults=defaults;
  const currentNote=bq('[data-testid="booking-defaults-note"]');
  if(currentNote)currentNote.textContent=bookingDefaultsNote();
  const groomer=bq('[name="employeeId"]');
  if(groomer&&!state.booking.groomerId&&defaults.groomers?.[0])groomer.value=defaults.groomers[0].id;
  const selected=new Set((defaults.services||[]).map((service)=>service.id));
  bqa('input[name="serviceIds"]').forEach((input)=>{input.checked=selected.has(input.value);});
  syncBookingServiceCounts();
  revealCheckedBookingServices();
  syncBookingGroomerOptions();
  updateBookingPricePreview();
}

function openStackedDialog({title,body,confirmLabel,dismissLabel,onConfirm,onDismiss}) {
  const dialog=$("#stacked-dialog");
  $("#stacked-dialog-title").textContent=title;
  $("#stacked-dialog-body").innerHTML=body;
  const confirm=$('[data-testid="stacked-dialog-confirm"]');
  const dismiss=$('[data-testid="stacked-dialog-dismiss"]');
  confirm.hidden=!confirmLabel;confirm.textContent=confirmLabel||"";
  dismiss.textContent=dismissLabel||"Cancel";
  confirm.onclick=async()=>{
    confirm.disabled=true;
    try{if(await onConfirm?.($("#stacked-dialog-body"))!==false)dialog.close();}
    catch(error){toast(error.message);}
    finally{confirm.disabled=false;}
  };
  dismiss.onclick=()=>{dialog.close();onDismiss?.();};
  dialog.showModal();
  return dialog;
}

// Pets whose rabies record has already lapsed by the date being booked. Staff without
// pet-care visibility see nothing here because the expiration is redacted for them, so
// there is no half-informed warning for them to act on.
function bookingLapsedPets() {
  if(!allowed("pets.care.view"))return [];
  const date=bookingLocalDate();if(!date)return [];
  return bookingClientPets().filter((pet)=>{
    const expiration=pet.vaccinationExpiresOn?String(pet.vaccinationExpiresOn).slice(0,10):null;
    return expiration!==null&&expiration<date;
  });
}

function promptBookingVaccination() {
  if(state.booking.vaccinationPrompted)return;
  const lapsed=bookingLapsedPets(),date=bookingLocalDate();
  if(!lapsed.length||!date)return;
  state.booking.vaccinationPrompted=true;
  openStackedDialog({
    title:"Required vaccine",
    body:`<p data-testid="booking-vaccination-pets">Updated vaccination records needed for: ${
      escape(lapsed.map((pet)=>pet.name).join(", "))}</p>`
      +`<p class="fine">Rabies information on file expires before ${escape(date)}.</p>`,
    dismissLabel:"Not Now",
    confirmLabel:allowed("appointments.create")?"Send Reminder":"",
    onConfirm:async()=>{
      const outcomes=await Promise.allSettled(lapsed.map((pet)=>
        api(`/api/pets/${pet.id}/vaccination-reminder`,{method:"POST",
          body:JSON.stringify({appointmentLocalDate:date,channel:"email"})})));
      const failed=outcomes.filter((outcome)=>outcome.status==="rejected");
      // Reporting the first refusal verbatim keeps an undeliverable client — no address,
      // opted out, messages blocked — from being reported as a message that went out.
      toast(failed.length
        ? `${outcomes.length-failed.length} of ${outcomes.length} reminders queued. ${failed[0].reason.message}`
        : `Vaccination reminder queued for ${lapsed.map((pet)=>pet.name).join(", ")}.`);
    }
  });
}

function openBookingPetPicker() {
  const pets=bookingClientPets();
  if(!pets.length){toast("This client has no active pets. Add a pet first.");return;}
  openStackedDialog({
    title:"Select pet for appointment",
    body:`<div class="stacked-dialog-options" data-testid="booking-pet-options">${
      pets.map((pet)=>`<label><input type="radio" name="bookingPet" value="${pet.id}" ${
        pet.id===state.booking.petId?"checked":""}> <span>${escape(petName(pet))}</span></label>`).join("")
    }</div>`,
    dismissLabel:"Cancel",
    confirmLabel:"OK",
    onConfirm:(body)=>{
      const chosen=body.querySelector('input[name="bookingPet"]:checked');
      if(!chosen){toast("Choose a pet to continue.");return false;}
      applyBookingPet(chosen.value);
      return true;
    }
  });
}

function applyBookingPet(petId) {
  state.booking.petId=petId;
  bq('[name="petId"]').value=petId;
  bq('[data-testid="booking-pet-row"]').innerHTML=bookingPetRow();
  bindBookingPetControl();
  updateBookingRabiesPreview();
  return applyBookingDefaults();
}

function openBookingDialog(options={}) {
  return runOnce("open:booking-dialog",async()=>{
    const [customers,pets,employees,services]=await Promise.all([
      api("/api/customers"),api("/api/pets"),api("/api/employees"),api("/api/services")
    ]);
    Object.assign(state,{customers,pets,employees,services});
    resetBookingState(options);
    $("#booking-error").textContent="";
    renderBookingClientPane();renderBookingDetailPane();
    bookingScope().showModal();
    if(options.customerId)await selectBookingClient(options.customerId);
    if(options.petId&&bookingClientPets().some((pet)=>pet.id===options.petId))await applyBookingPet(options.petId);
    bq('[data-testid="booking-client-search"]')?.focus();
  });
}

const actions = {
  "new-customer": () => openModal("New customer",
    field("firstName","First name","text","")+field("lastName","Last name","text","")+field("email","Email","email")+field("phone","Phone","tel")+field("notes","Notes","text","",true)
    +`<p class="wide fine">Enough to find them again is enough to save: a name, a phone number, or an email. Take what an enquiry gives you and fill the rest in later.</p>`,
    (form) => api("/api/customers",{method:"POST",body:JSON.stringify(Object.fromEntries(form))})),
  "new-pet": () => { openModal("New pet",
    select("customerId","Customer",state.customers.map(c=>[c.id,`${clientName(c)}`]),true)+field("name","Pet name","text","")+petTypeField()+breedField()+field("weightPounds",weightFieldLabel(),"number",weightInputAttrs())+field("groomingPreferences","Grooming preferences","text","",true)+(allowed("pets.care.edit")?field("behaviorNotes","Behavior notes","text","",true)+field("safetyAlerts","Safety alert","text","",true)+field("medicalNotes","Medical notes","text","",true):""),
    async (form) => {
      const values=Object.fromEntries(form);
      values.weightOunces=ouncesFromWeight(values.weightPounds);
      delete values.weightPounds;
      try{return await api("/api/pets",{method:"POST",body:JSON.stringify({...values,...breedPayload(form)})});}
      catch(error){markBreedRefusal(error);throw error;}
    }); setupBreedAutocomplete(); },
  "new-service": () => openModal("New service",
    field("name","Service name","text","required")+field("baseDurationMinutes","Duration (minutes)","number",'required min="1"')+field("basePrice","Fixed price ($)","number",'required min="0" step=".01"')+select("category","Category",[["GENERAL","General"],["DOG_ADDON","Dog add-on"],["A_LA_CARTE","À la carte"],["CAT","Cat"]],true,"GENERAL")+field("description","Description","text","",true),
    (form) => { const o=Object.fromEntries(form); o.baseDurationMinutes=Number(o.baseDurationMinutes); o.basePriceMinor=Math.round(Number(o.basePrice)*100);o.pricingMode="FIXED";o.active=true;delete o.basePrice; return api("/api/services",{method:"POST",body:JSON.stringify(o)}); }),
  // An invitation carries a ROLE and nothing else. The flattened-preset shape this used to accept
  // was retired with the per-member permission column and now returns 400, so there is no older
  // path worth keeping: an invitation that does not name a role is not something the server can
  // store, and a salon with no roles yet has to make one before it can hand anybody access.
  "invite-member": async () => {
    let roles=[];
    try{
      const result=await api("/api/roles");
      roles=(result?.roles||[]).filter(role=>role.enabled!==false);
    }catch(error){toast(error.message);return;}
    if(!roles.length){
      toast("Add a role first. An invitation has to say what the person is being given.");
      return;
    }
    openModal("Invite workspace member",
      field("email","Email","email","required",true)
      +`<label class="wide">Role<select data-testid="field-roleId" name="roleId" required>${roles.map(role=>`<option value="${escapeAttr(role.id)}">${escape(role.name)}</option>`).join("")}</select></label>`,
      async(form)=>{
      const values=Object.fromEntries(form);
      const result=await api("/api/members/invitations",{method:"POST",
        body:JSON.stringify({email:values.email,roleId:values.roleId})});
      let copied=false;
      if(result?.acceptancePath&&navigator.clipboard){
        try{await navigator.clipboard.writeText(`${location.origin}${result.acceptancePath}`);copied=true;}catch{copied=false;}
      }
      if(rolesState.roles)await loadRoleInvitations();
      return {afterClose:null,message:copied?"Secure invitation link copied":"Invitation queued"};
    });
  },
  // Settings -> Business is the workspace both retired dialogs became. This entry stays only as
  // the Salon view's route into it: data-action="business-hours" on two controls there opens
  // Settings on the hours tab rather than a dialog. The dialogs themselves are gone - one wrote a
  // hardcoded Mon-Fri 09:00-17:00 over the location's real hours, and the other sent no phone or
  // email, which the merge handler now preserves but the old whole-object write cleared.
  "business-hours": () => runDetached(async () => {
    closeSetupMenus();
    await showView("admin-settings");
    renderSettingsCategory("business",{history:"push",tab:"hours"});
  }),
  // Every entry point into booking — the slot menu, the month view's add button, the New menu,
  // and "book again" from a client — funnels through the same workspace. The calendar's preset
  // fields are read once and cleared, so a preset left over from one entry point cannot leak
  // into the next opening.
  "new-appointment": () => {
    const options={
      preset:state.calendar.bookingPreset,groomerId:state.calendar.bookingGroomerId,
      customerId:state.calendar.bookingCustomerId,petId:state.calendar.bookingPetId
    };
    state.calendar.bookingPreset=null;state.calendar.bookingGroomerId=null;
    state.calendar.bookingCustomerId=null;state.calendar.bookingPetId=null;
    return openBookingDialog(options);
  },
  // Blocking accepts the slot it was opened from so the Block choice on an empty slot lands on
  // that slot rather than making someone retype the time they just clicked.
  "blocked-time": ({preset=null,groomerId=null}={}) => openModal("Block team time",
    select("employeeId","Team member",state.employees.filter(item=>item.active).map(item=>[item.id,item.displayName]),false,groomerId||"")+
    field("startAt","Start","datetime-local",`required value="${escape(preset||"")}"`)+
    field("endAt","End","datetime-local","required")+
    field("reason","Reason","text","required",true),
    form=>api("/api/blocked-times",{method:"POST",body:JSON.stringify({employeeId:form.get("employeeId"),locationId:state.me.business.locationId,localStart:form.get("startAt"),localEnd:form.get("endAt"),expectedLocationVersion:state.me.business.locationVersion,reason:form.get("reason")})}))
};

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("#auth-error").textContent = "";
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api(resetToken ? "/api/auth/password-reset/confirm" : inviteToken ? "/api/auth/invitations/accept" : state.login ? "/api/auth/login" : "/api/auth/signup", {
      method: "POST", body: JSON.stringify(resetToken ? {token:resetToken,password:data.password} : inviteToken ? {token:inviteToken,password:data.password} : data)
    });
    if (inviteToken || resetToken) history.replaceState({}, "", "/");
    if (resetToken) { location.href="/"; return; }
    await bootstrap();
  } catch (error) { $("#auth-error").textContent = error.message; }
});
$("#toggle-auth").addEventListener("click", () => {
  state.login = !state.login; $("#business-field").hidden = state.login; $("#business-field input").required = !state.login;
  $("#auth-form input[name=password]").autocomplete=state.login?"current-password":"new-password";
  $("#auth-title").textContent = state.login ? "Welcome back" : "Create your salon";
  $("#auth-subtitle").textContent = state.login ? "Sign in to continue your day." : "Set up your workspace in under a minute.";
  $("#auth-form button").textContent = state.login ? "Sign in" : "Create workspace";
  $("#toggle-auth").textContent = state.login ? "New to Pawsh? Create a workspace" : "Already have an account? Sign in";
});
$("#forgot-password").addEventListener("click",()=>{
  openModal("Reset password",field("email","Account email","email","required",true),async(form)=>{
    await api("/api/auth/password-reset/request",{method:"POST",body:JSON.stringify({email:form.get("email")})});
    toast("If the account exists, a reset email is on its way");
  });
});
$("#request-access").addEventListener("click",()=>{
  openModal("Request workspace access",field("requesterName","Your name","text","required maxlength=120")+field("requesterEmail","Email address","email","required maxlength=320")+field("workspaceName","Workspace / salon name","text","required maxlength=120")+field("workspaceAdminEmail","Workspace administrator email","email","required maxlength=320")+field("message","Optional message","text","maxlength=1000",true),async form=>{
    await api("/api/workspace-access-requests",{method:"POST",body:JSON.stringify(Object.fromEntries(form))});
    return ()=>toast("Your request was submitted for administrator review");
  });
});
$("#logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout",{method:"POST"}); }
  catch(error) {
    // Logout is intentionally idempotent: an already-ended session is the
    // requested outcome. Every other server or application failure still
    // surfaces as an uncaught page error for operators and smoke tests.
    if(error.message!=="Authentication required")throw error;
  }
  finally {
    closeAccountMenu();
    settleUnauthenticated();
  }
});
const accountTrigger=$("#account-trigger"),accountMenu=$("#account-menu");
function closeAccountMenu({restoreFocus=false}={}){accountMenu.hidden=true;accountTrigger.setAttribute("aria-expanded","false");if(restoreFocus)accountTrigger.focus();}
function openAccountMenu(){closeNewActionMenu();closeLocationMenu();accountMenu.hidden=false;accountTrigger.setAttribute("aria-expanded","true");}
accountTrigger.addEventListener("click",()=>accountMenu.hidden?openAccountMenu():closeAccountMenu());
accountTrigger.addEventListener("keydown",event=>{if(["ArrowDown","ArrowUp"].includes(event.key)){event.preventDefault();openAccountMenu();const items=[...accountMenu.querySelectorAll("[role=menuitem]:not(:disabled)")];items[event.key==="ArrowDown"?0:items.length-1]?.focus();}});
accountMenu.addEventListener("keydown",event=>{const items=[...accountMenu.querySelectorAll("[role=menuitem]:not(:disabled)")],index=items.indexOf(document.activeElement);if(event.key==="Escape"){event.preventDefault();closeAccountMenu({restoreFocus:true});}else if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;items[next]?.focus();}});
$("#account-change-password").addEventListener("click",()=>{closeAccountMenu();showView("profile-account");setTimeout(()=>$("#password-form input[name=currentPassword]")?.focus(),50);});
document.addEventListener("click",event=>{if(!accountMenu.hidden&&!$(".account-control").contains(event.target))closeAccountMenu();});
document.addEventListener("click",event=>{if(!event.target.closest(".calendar-actions-menu")&&!event.target.closest("#slot-menu"))closeCalendarMenus();});
$("#slot-menu").addEventListener("click",event=>{
  const action=event.target.closest("[data-slot-action]");if(!action)return;
  const menu=$("#slot-menu"),preset=menu.dataset.slot||null,groomerId=menu.dataset.slotGroomer||null;
  closeSlotMenu();
  if(action.dataset.slotAction==="add")openBookingDialog({preset,groomerId});
  else actions["blocked-time"]({preset,groomerId});
});
bookingScope().querySelectorAll(".close").forEach(button=>
  button.addEventListener("click",()=>bookingScope().close()));
// Emptying the panes on close matters beyond tidiness: the workspace is built from the same
// field helpers the shared dialog uses, so a closed-but-populated booking form leaves a second
// element carrying test ids and ids like `startAt` and `appointment-service-options` in the
// document, and the next dialog's lookups become ambiguous.
bookingScope().addEventListener("close",()=>{
  $("#stacked-dialog").close();
  resetBookingState();
  $("#booking-client").innerHTML="";
  $("#booking-detail").innerHTML="";
  $("#booking-error").textContent="";
});

$("#booking-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const form=event.currentTarget,error=$("#booking-error");
  error.textContent="";
  const data=new FormData(form),values=Object.fromEntries(data),serviceIds=data.getAll("serviceIds");
  // The pet is chosen through a sub-dialog rather than a required control, so the form cannot
  // rely on native validation to catch a missing one.
  if(!values.petId){error.textContent="Choose a pet for this appointment.";return;}
  if(!serviceIds.length){error.textContent="Choose at least one service.";return;}
  const button=bq('[data-testid="booking-submit"]'),original=button.textContent;
  button.disabled=true;button.textContent="Booking…";form.setAttribute("aria-busy","true");
  const landOnDate=()=>selectCalendarDate(String(values.startAt).slice(0,10));
  try{
    await schedulingMutation("/api/appointments",{
      locationId:state.me.business.locationId,customerId:state.booking.customerId,
      petId:values.petId,employeeId:values.employeeId,serviceIds,
      localStart:values.startAt,disambiguation:values.disambiguation||undefined,
      expectedLocationVersion:state.me.business.locationVersion,notes:values.notes||null
    },"Booking");
    await refresh();
    bookingScope().close();
    toast("Appointment booked");
    runDetached(landOnDate);
  }catch(problem){
    if(problem.retryConflictOverride)
      renderConflictOverride(problem,{container:error,dialog:bookingScope(),afterClose:landOnDate});
    else{
      error.textContent=problem.message;
      if(problem.reconcileLifecycle||problem.reconcileFinancial)
        await refresh().catch(failure=>toast(failure.message));
    }
  }finally{button.disabled=false;button.textContent=original;form.removeAttribute("aria-busy");}
});
// Location switcher. business.locationId, locationVersion and timezone are read by every scheduling
// write (booking, blocked time, and business settings' expectedLocationVersion), so the shop in play
// belongs in the header rather than behind a menu, and a switch has to land in state before anything
// else can be saved against the location the user just left.
const locationControl=$("#location-control"),locationTrigger=$("#location-switcher"),locationMenu=$("#location-menu");
function activeViewId(){return $$(".view").find(section=>!section.hidden)?.id||"dashboard";}
function multiLocation(){return Number(state.me?.business?.locationCount||0)>1;}
// A single-shop workspace must not see the control at all, so the list is only fetched once /api/me
// says there is something to switch between. A deployment without the endpoints reports no count and
// never asks; a request that fails anyway leaves the list empty, which renderLocationSwitcher treats
// exactly like having one shop.
async function loadLocations(){
  if(!multiLocation())return [];
  try{const result=await api("/api/locations");return Array.isArray(result)?result:[];}
  catch{return [];}
}
function locationOptions(){return [...locationMenu.querySelectorAll(".location-option:not(:disabled)")];}
// Phones fold the header pill away, so dismissing the menu there has to hand focus back to the
// account button that opened it rather than to a control that is not rendered.
function locationReturnFocus(){return locationTrigger.offsetParent?locationTrigger:accountTrigger;}
function closeLocationMenu({restoreFocus=false}={}){if(!locationMenu||locationMenu.hidden)return;locationMenu.hidden=true;locationTrigger.setAttribute("aria-expanded","false");if(restoreFocus)locationReturnFocus().focus();}
function openLocationMenu({focus="none"}={}){if(!locationControl||locationControl.hidden)return;closeAccountMenu();closeNewActionMenu();locationMenu.hidden=false;locationTrigger.setAttribute("aria-expanded","true");const items=locationOptions();if(focus==="first")(items.find(item=>item.getAttribute("aria-checked")==="true")||items[0])?.focus();if(focus==="last")items.at(-1)?.focus();}
function locationOptionMarkup(entry,current){
  const badge=current?`<span class="location-option-current">Current</span>`:"";
  const address=entry.address?`<span class="location-option-address">${escape(entry.address)}</span>`:"";
  return `<button type="button" role="menuitemradio" aria-checked="${current}" class="location-option" data-testid="location-option" data-location-id="${escape(entry.id)}"><span class="location-option-mark" aria-hidden="true">✓</span><span class="location-option-text"><span class="location-option-name"><span class="location-option-title">${escape(entry.name)}</span>${badge}</span>${address}</span></button>`;
}
function renderLocationSwitcher(){
  if(!locationControl)return;
  const business=state.me?.business,available=multiLocation()&&state.locations.length>1,accountItem=$("#account-switch-location");
  // The account menu keeps its placeholder until the capability is real, so the entry that opens the
  // switcher only exists for a workspace that has somewhere to switch to.
  if(accountItem){
    accountItem.disabled=!available;
    accountItem.setAttribute("aria-disabled",String(!available));
    accountItem.querySelector("small")?.toggleAttribute("hidden",available);
    if(available)accountItem.removeAttribute("title");
    else accountItem.title="Pawsh currently supports one active salon location";
  }
  if(!available){closeLocationMenu();locationControl.hidden=true;locationMenu.replaceChildren();return;}
  locationControl.hidden=false;
  $("#location-current-name").textContent=business.locationName||"Location";
  locationTrigger.setAttribute("aria-label",`Location: ${business.locationName||"unknown"}. Switch location`);
  locationMenu.innerHTML=state.locations.map(entry=>locationOptionMarkup(entry,entry.id===business.locationId)).join("")||`<p class="location-menu-empty">No other active locations</p>`;
}
async function switchLocation(locationId){
  if(!locationId)return;
  if(locationId===state.me?.business?.locationId){closeLocationMenu({restoreFocus:true});return;}
  closeLocationMenu({restoreFocus:true});
  locationTrigger.disabled=true;locationTrigger.setAttribute("aria-busy","true");
  try{
    const result=await api("/api/me/location",{method:"POST",body:JSON.stringify({locationId})});
    // Identity first: a stale locationId or locationVersion reaching the next booking or settings
    // save would write against the location the user just left.
    state.me=await api("/api/me");
    state.calendar.opened=false;state.calendar.monthAppointments=[];state.businessHours=[];resetAvailabilityLocationData();
    applyPermissions();
    const switchedTo=result?.locationName||state.me.business.locationName;
    // Fired at the exact moment the misconception forms. Three of the four Availability tabs are
    // workspace-wide, so an operator watching a grid of hours change location has to be told that
    // the grid did not.
    toast(availabilityWorkspaceTabOpen()
      ? `Switched to ${switchedTo}. Default working hours are workspace-wide and did not change.`
      : `Switched to ${switchedTo}`);
    await refresh();
    await showView(activeViewId(),{history:"none"});
  }catch(error){
    // A dropped request has no status and reaches here as a raw "Failed to fetch", which tells the
    // user nothing about what did or did not happen to the location they picked.
    toast(error.status===404?"That location is no longer available":error.status?error.message:"Could not switch location. Check your connection and try again.");
    if(error.status===404)runDetached(async()=>{state.locations=await loadLocations();renderLocationSwitcher();});
  }finally{
    locationTrigger.disabled=false;locationTrigger.removeAttribute("aria-busy");
  }
}
locationTrigger.addEventListener("click",()=>locationMenu.hidden?openLocationMenu():closeLocationMenu({restoreFocus:true}));
locationTrigger.addEventListener("keydown",event=>{if(["ArrowDown","ArrowUp"].includes(event.key)){event.preventDefault();openLocationMenu({focus:event.key==="ArrowDown"?"first":"last"});}});
locationMenu.addEventListener("keydown",event=>{const items=locationOptions(),index=items.indexOf(document.activeElement);if(event.key==="Escape"){event.preventDefault();closeLocationMenu({restoreFocus:true});}else if(event.key==="Tab"){closeLocationMenu();}else if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;items[next]?.focus();}});
locationMenu.addEventListener("click",event=>{const option=event.target.closest?.(".location-option");if(!option)return;runDetached(()=>switchLocation(option.dataset.locationId));});
// The account entry opens the menu on its own click, which then keeps bubbling to this listener, so
// the entry counts as inside the control for the purpose of dismissing it.
document.addEventListener("click",event=>{if(!locationMenu.hidden&&!locationControl.contains(event.target)&&!event.target.closest?.("#account-switch-location"))closeLocationMenu();});
$("#account-switch-location").addEventListener("click",event=>{if(event.currentTarget.disabled)return;closeAccountMenu();openLocationMenu({focus:"first"});});
const newActionTrigger=$("#new-action-trigger"),newActionMenu=$("#new-action-menu");
newActionTrigger.querySelector('[aria-hidden="true"]')?.remove();
function newActionItems(){return [...newActionMenu.querySelectorAll('[role="menuitem"]:not(:disabled)')];}
function syncNewActionAvailability(){if(!newActionMenu)return;const availability={"new-appointment":allowed("appointments.create"),"quick-existing":allowed("appointments.create"),"blocked-time":allowed("appointments.edit")};for(const [action,enabled] of Object.entries(availability)){const item=newActionMenu.querySelector(`[data-new-action="${action}"]`);if(!item)continue;item.disabled=!enabled;item.setAttribute("aria-disabled",String(!enabled));if(!enabled)item.title="You do not have permission for this action";else item.removeAttribute("title");}}
function closeNewActionMenu({restoreFocus=false}={}){if(!newActionMenu)return;newActionMenu.hidden=true;newActionTrigger.setAttribute("aria-expanded","false");if(restoreFocus)newActionTrigger.focus();}
function openNewActionMenu({focus="none"}={}){closeAccountMenu();closeLocationMenu();syncNewActionAvailability();newActionMenu.hidden=false;newActionTrigger.setAttribute("aria-expanded","true");const items=newActionItems();if(focus==="first")items[0]?.focus();if(focus==="last")items.at(-1)?.focus();}
newActionTrigger.addEventListener("click",()=>newActionMenu.hidden?openNewActionMenu():closeNewActionMenu({restoreFocus:true}));
newActionTrigger.addEventListener("keydown",event=>{if(["ArrowDown","ArrowUp"].includes(event.key)){event.preventDefault();openNewActionMenu({focus:event.key==="ArrowDown"?"first":"last"});}});
newActionMenu.addEventListener("keydown",event=>{const items=newActionItems(),index=items.indexOf(document.activeElement);if(event.key==="Escape"){event.preventDefault();closeNewActionMenu({restoreFocus:true});}else if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;items[next]?.focus();}});
newActionMenu.addEventListener("click",async event=>{const item=event.target.closest?.("[data-new-action]");if(!item||item.disabled)return;const action=item.dataset.newAction;closeNewActionMenu();if(action==="quick-existing"){await actions["new-appointment"]();setTimeout(()=>$('[data-testid="booking-client-search"]')?.focus(),0);}else await actions[action]?.();});
document.addEventListener("click",event=>{if(!newActionMenu.hidden&&!$(".new-action-control").contains(event.target))closeNewActionMenu();});
document.addEventListener("keydown",event=>{if(event.key==="Escape"){if(!newActionMenu.hidden){event.preventDefault();closeNewActionMenu({restoreFocus:true});}else if(locationMenu&&!locationMenu.hidden){event.preventDefault();closeLocationMenu({restoreFocus:true});}else if(!accountMenu.hidden){event.preventDefault();closeAccountMenu({restoreFocus:true});}else if($(".calendar-action-popover:not([hidden])")){event.preventDefault();closeCalendarMenus({restoreFocus:true});}}});
$("#profile-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,error=$("#profile-error"),button=form.querySelector("button[type=submit]");error.textContent="";button.disabled=true;try{await api("/api/me",{method:"PATCH",body:JSON.stringify({displayName:new FormData(form).get("displayName")})});state.me=await api("/api/me");renderAccountIdentity();toast("Profile updated");}catch(problem){error.textContent=problem.message;}finally{button.disabled=false;}});
$("#profile-cancel").addEventListener("click",()=>{renderAccountIdentity();$("#profile-error").textContent="";});
$("#profile-workspace-select").addEventListener("change",async event=>{try{await api("/api/workspaces/select",{method:"POST",body:JSON.stringify({businessId:event.target.value})});location.reload();}catch(error){toast(error.message);renderAccountIdentity();}});
$("#password-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,values=Object.fromEntries(new FormData(form)),error=$("#password-error"),button=form.querySelector("button[type=submit]");error.textContent="";if(values.newPassword!==values.confirmPassword){error.textContent="New passwords do not match";form.elements.confirmPassword.focus();return;}button.disabled=true;try{await api("/api/me/password",{method:"POST",body:JSON.stringify({currentPassword:values.currentPassword,newPassword:values.newPassword})});form.reset();toast("Password changed; other sessions signed out");}catch(problem){error.textContent=problem.message;}finally{button.disabled=false;}});
const settingsCategories=[
  ["account","Account","canonical"],["staff","Staff","canonical"],["business","Business","functional"],["availability","Availability","canonical"],["appointment-schedule","Appointment schedule","placeholder"],["locations","Locations","placeholder"],["permissions","Roles & permissions","functional"],["services","Services","canonical"],["payroll","Payroll","placeholder"],["pet-options","Pet options","canonical"],["tax-payments","Tax & payments","functional"],["discounts","Coupons & discounts","functional"],["automated-messages","Automated messages","functional"],["sms-auto-reply","SMS auto-reply","placeholder"],["agreements","Agreements","placeholder"],["online-booking","Online booking","placeholder"],["intake-form","Intake form","placeholder"],["client-portal","Client portal","placeholder"],["loyalty","Loyalty program","placeholder"],["reviews","Review booster","placeholder"],["report-cards","Report card","placeholder"],["integrations","Integrations","placeholder"]
];
const settingsDescriptions={"appointment-schedule":"Configurable appointment policy is not yet available. Calendar display preferences remain under the Calendar gear.",locations:"Pawsh currently supports one active scheduling location per workspace. Multi-location management requires the approved location architecture.",payroll:"Payroll, commissions, and pay runs are not yet available in Pawsh.","sms-auto-reply":"Pawsh does not currently provide an SMS auto-reply integration.",agreements:"Agreement and waiver template management is not yet available.","online-booking":"Public online-booking configuration is not yet available.","intake-form":"A configurable intake-form builder is not yet available.","client-portal":"Pawsh does not currently provide a client portal.",loyalty:"A points or rewards program is not yet available.",reviews:"Automated external review requests are not yet available.","report-cards":"Configurable grooming report cards are not yet available.",integrations:"No external integrations are currently configured."};
function settingsPathCategory(){if(legacyBreedPaths.has(location.pathname))return "pet-options";const match=location.pathname.match(/^\/settings\/([^/]+)$/);return settingsCategories.some(([id])=>id===match?.[1])?match[1]:"account";}
// Pet Options is the pet-configuration workspace. Pet Type is its first section and the parent
// of the breed catalog; the remaining sections are recorded on the pet record today and are not
// yet salon-configurable, so they are listed honestly rather than omitted or faked.
const petOptionSections=[
  ["pet-type","Pet Type"],["behavior","Behavior"],["pet-hair","Pet Hair"],["weight-range","Weight Range"],
  ["fixed","Fixed"],["vaccine","Vaccine"],["coat-color","Coat color"],["pet-tags","Pet tags"]
];
const petOptionNotes={
  behavior:"Behaviour and safety notes are written on each pet record. A salon-managed list of behaviour flags is not available yet.",
  "pet-hair":"Hair length is recorded on the pet record. A salon-managed list of hair lengths is not available yet.",
  "weight-range":"Weight ranges drive tiered service pricing and are set in the Pawsh price book, not here. Editing the range boundaries is not available yet.",
  fixed:"Spayed, neutered and intact are recorded on the pet record. A salon-managed list is not available yet.",
  vaccine:"Vaccination records, rabies compliance and reminders are managed on each pet. A salon-managed list of vaccine types is not available yet.",
  "coat-color":"Coat colour is free text on the pet record, and the suggestions come from what this salon has already entered. A managed list is not available yet.",
  "pet-tags":"Pet tags are not available yet."
};
const petOptionsState={section:"pet-type"};
function petTypeRows(){
  if(!state.petTypes.length)return `<tr><td colspan="2" class="empty">Loading pet types…</td></tr>`;
  return state.petTypes.map(type=>`<tr data-pet-type-row="${type.id}"><td><strong>${escape(type.name)}</strong></td><td class="pet-type-actions"><button type="button" class="text-button pet-type-breeds" data-pet-type-id="${type.id}">Breeds</button><button type="button" class="text-button danger" disabled aria-disabled="true" title="Pet types are shared Pawsh taxonomy. Removing one is not available yet.">Delete</button></td></tr>`).join("");
}
function petOptionsBody(){
  if(petOptionsState.section!=="pet-type"){
    const [,label]=petOptionSections.find(([key])=>key===petOptionsState.section)||["",""];
    return `<article class="settings-panel settings-placeholder" data-testid="settings-placeholder"><p class="eyebrow">Not available yet</p><h3>${escape(label)}</h3><p>${escape(petOptionNotes[petOptionsState.section]||"")}</p></article>`;
  }
  return `<div class="pet-type-panel"><table class="pet-type-table" data-testid="pet-type-table"><thead><tr><th scope="col">Pet Type</th><th scope="col">Actions</th></tr></thead><tbody id="pet-type-body">${petTypeRows()}</tbody></table><div class="pet-type-foot"><button type="button" class="primary compact" disabled aria-disabled="true" title="Pet types are shared Pawsh taxonomy, so every salon sees the same list. Adding one is not available yet.">+ Add</button></div><p class="fine settings-note">Dog and Cat are shared Pawsh taxonomy, so every business sees the same pet types and the same breed names. Your pricing class, availability, and any breed you add apply across every location on this account.</p></div>`;
}
// Settings -> Pet Options -> Pet Type -> Breeds. This drawer is the authoritative breed
// management surface: it lists the breeds of one pet type and carries every control that acts
// on them - pricing class, availability, rename, delete, and adding one of this account's own.
//
// There is deliberately no second catalog page. Two surfaces over one row set means two caches
// that disagree and two sets of controls that drift apart, which is what the standalone Salon
// Breed Catalog had become.
//
// Everything here is scoped to the BUSINESS - the customer account - not to the location the
// session happens to be working at, so a breed added here is available at every location that
// account operates.
const breedDrawerState=tenantCache(()=>({petTypeId:null,breeds:[],query:"",showInactive:false}));
function breedDrawerRow(breed){
  // Only a breed this account created can be renamed or removed. A shared Pawsh breed is the
  // same row for every tenant, so offering a pencil there would promise something the server
  // must refuse. Pricing class and availability ARE offered on both: those are stored per
  // business in `business_breed_settings` and change nothing for anyone else.
  const rename=breed.businessOwned
    ?`<button type="button" class="icon-button breed-rename" data-breed-id="${breed.id}" aria-label="Rename ${escape(breed.name)}" title="Rename"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="M14 6l4 4"/></svg></button>`
    :"";
  const remove=breed.businessOwned
    ?`<button type="button" class="icon-button danger breed-delete" data-breed-id="${breed.id}" aria-label="Delete ${escape(breed.name)}" title="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg></button>`
    :"";
  const reset=breed.customized
    ?`<button type="button" class="text-button breed-reset" data-breed-id="${breed.id}" title="Reset to the Pawsh default">Reset</button>`
    :"";
  const owner=breed.businessOwned?`<span class="breed-flag">Added by you</span>`:"";
  return `<li data-breed-id="${breed.id}" ${breed.businessOwned?'data-business-owned="true"':""} class="${breed.active?"":"is-inactive"}">`
    +`<span class="breed-row-name">${escape(breed.name)}${owner}</span>`
    +`<label class="breed-row-class"><span class="sr-only">Pricing class for ${escape(breed.name)}</span>`
    +`<select class="breed-class-select" data-breed-id="${breed.id}">${breedClassOptions(breed.defaultPricingClass)}</select></label>`
    +`<button type="button" class="breed-status-toggle ${breed.active?"":"inactive"}" data-breed-id="${breed.id}" aria-pressed="${breed.active}" title="${breed.active?"Offered when adding a pet":"Not offered when adding a pet"}">${breed.active?"Active":"Inactive"}</button>`
    +`<span class="breed-row-actions">${reset}${rename}${remove}</span></li>`;
}
function renderBreedDrawerList(){
  const list=$("#breed-drawer-list");if(!list)return;
  const query=normalizeBreedFilter(breedDrawerState.query);
  const visible=breedDrawerState.breeds.filter(breed=>breedDrawerState.showInactive||breed.active);
  const shown=visible.filter(breed=>!query||breed.search.includes(query));
  list.innerHTML=shown.length?shown.map(breedDrawerRow).join("")
    :`<li class="empty">${query?"No breeds match that search.":"No breeds to show."}</li>`;
  const hidden=breedDrawerState.breeds.length-visible.length;
  $("#breed-drawer-status").textContent=`${shown.length} breed${shown.length===1?"":"s"}`
    +(hidden&&!query?` · ${hidden} inactive hidden`:"");

  list.querySelectorAll(".breed-class-select").forEach(select=>select.addEventListener("change",()=>runDetached(async()=>{
    try{
      await putBreedSettings(select.dataset.breedId,{pricingClass:select.value});
      toast("Pricing class updated");
    }catch(error){
      // Put the row back to what the server still holds rather than leaving the select showing
      // a value that was never saved.
      toast(error.message);await refreshBreedDrawer();
    }
  })));
  list.querySelectorAll(".breed-status-toggle").forEach(button=>button.addEventListener("click",()=>runDetached(async()=>{
    const breed=breedDrawerState.breeds.find(item=>item.id===button.dataset.breedId);
    try{await toggleBreed(button.dataset.breedId,!breed.active);}
    catch(error){toast(error.message);await refreshBreedDrawer();}
  })));
  list.querySelectorAll(".breed-reset").forEach(button=>button.addEventListener("click",()=>runDetached(async()=>{
    try{await resetBreed(button.dataset.breedId);}
    catch(error){toast(error.message);await refreshBreedDrawer();}
  })));
  list.querySelectorAll(".breed-rename").forEach(button=>button.addEventListener("click",()=>
    promptBreedName("Rename breed",breedDrawerState.breeds.find(b=>b.id===button.dataset.breedId)?.name??"",async name=>{
      await api(`/api/breeds/${button.dataset.breedId}`,{method:"PATCH",body:JSON.stringify({name})});
      await refreshBreedDrawer();toast("Breed renamed");
    })));
  list.querySelectorAll(".breed-delete").forEach(button=>button.addEventListener("click",()=>{
    const breed=breedDrawerState.breeds.find(b=>b.id===button.dataset.breedId);
    openStackedDialog({title:`Delete ${breed?.name??"this breed"}?`,
      body:"<p>It stops being offered when adding or editing a pet, at every location.</p>",
      confirmLabel:"Delete",dismissLabel:"Cancel",
      onConfirm:async()=>{
        try{
          await api(`/api/breeds/${button.dataset.breedId}`,{method:"DELETE"});
        }catch(error){
          // The server refuses while pets still reference the breed rather than repricing them.
          $("#stacked-dialog-body").innerHTML=`<p class="error">${escape(error.message)}</p>`;return false;
        }
        await refreshBreedDrawer();toast("Breed deleted");return true;
      }});
  }));
}
async function refreshBreedDrawer(){
  if(!breedDrawerState.petTypeId)return;
  breedDrawerState.breeds=await api(`/api/pet-types/${breedDrawerState.petTypeId}/breeds`);
  state.breedsByType[breedDrawerState.petTypeId]=breedDrawerState.breeds;
  // The pet editor opens warm from `dogBreeds`, so a breed added or renamed here has to land
  // there too or the editor keeps offering the stale list until the next sign-in.
  if(breedDrawerState.petTypeId===petTypeIdFor("dog"))state.dogBreeds=breedDrawerState.breeds;
  renderBreedDrawerList();
}
// A single-field prompt, matching the "Add Pet Breed" dialog: a name, Cancel, OK.
function promptBreedName(title,value,commit){
  openModal(title,`<label class="wide">Breed name<input data-testid="breed-name-input" name="breedName" type="text" required maxlength="120" value="${escape(value)}"></label>`,
    async form=>{const name=String(form.get("breedName")||"").trim();if(!name)throw new Error("Enter a breed name.");await commit(name);},
    {submitLabel:"OK"});
}
async function openBreedDrawer(petTypeId){
  const drawer=$("#breed-drawer");if(!drawer)return;
  breedDrawerState.petTypeId=petTypeId;breedDrawerState.query="";breedDrawerState.showInactive=false;
  const search=$("#breed-drawer-search");if(search)search.value="";
  const showInactive=$("#breed-drawer-show-inactive");if(showInactive)showInactive.checked=false;
  await loadPetTypes();
  const type=state.petTypes.find(item=>item.id===petTypeId);
  $("#breed-drawer-title").textContent=type?`Breeds for ${type.name}`:"Breeds";
  if(!drawer.open)drawer.showModal();
  await refreshBreedDrawer();
}
function closeBreedDrawer(){
  const drawer=$("#breed-drawer");
  if(drawer?.open)drawer.close();
}
function setupBreedDrawer(){
  const drawer=$("#breed-drawer");if(!drawer)return;
  drawer.querySelector("[data-testid='breed-drawer-close']")?.addEventListener("click",closeBreedDrawer);
  $("#breed-add")?.addEventListener("click",()=>promptBreedName("Add Pet Breed","",async name=>{
    await api(`/api/pet-types/${breedDrawerState.petTypeId}/breeds`,{method:"POST",body:JSON.stringify({name})});
    await refreshBreedDrawer();toast("Breed added");
  }));
  // Clicking the backdrop dismisses it: the click lands on the dialog itself, never on its panel.
  drawer.addEventListener("click",event=>{if(event.target===drawer)closeBreedDrawer();});
  // Escape already closes a native dialog; returning focus keeps the Pet Type list usable.
  drawer.addEventListener("close",()=>{if($("#pet-options-workspace"))renderPetOptions();});
  $("#breed-drawer-search")?.addEventListener("input",event=>{
    breedDrawerState.query=event.target.value;renderBreedDrawerList();
  });
  $("#breed-drawer-show-inactive")?.addEventListener("change",event=>{
    breedDrawerState.showInactive=event.target.checked;renderBreedDrawerList();
  });
}
function renderPetOptions(){
  const host=$("#pet-options-workspace");if(!host)return;
  host.innerHTML=`<nav class="pet-options-nav" aria-label="Pet options sections">${petOptionSections.map(([key,label])=>`<button type="button" data-pet-option-section="${key}" class="${key===petOptionsState.section?"active":""}" ${key===petOptionsState.section?'aria-current="page"':""}>${escape(label)}</button>`).join("")}</nav><div class="pet-options-body">${petOptionsBody()}</div>`;
  host.querySelectorAll("[data-pet-option-section]").forEach(button=>button.addEventListener("click",()=>{
    petOptionsState.section=button.dataset.petOptionSection;renderPetOptions();
  }));
  host.querySelectorAll(".pet-type-breeds").forEach(button=>button.addEventListener("click",()=>{
    runDetached(()=>openBreedDrawer(button.dataset.petTypeId));
  }));
  if(!state.petTypes.length)runDetached(async()=>{await loadPetTypes();renderPetOptions();});
}
function settingsLink(title,description,label,target){return `<article class="settings-panel"><h3>${escape(title)}</h3><p>${escape(description)}</p><button type="button" class="primary compact settings-canonical-link" data-target="${target}">${escape(label)}</button></article>`;}
function settingsPlaceholder(id,title){return `<article class="settings-panel settings-placeholder" data-testid="settings-placeholder"><p class="eyebrow">Coming soon</p><h3>${escape(title)}</h3><p>${escape(settingsDescriptions[id]||"This capability is not yet available in Pawsh.")}</p></article>`;}
function bindSettingsGoto(root){
  root.querySelectorAll(".settings-canonical-link").forEach(button=>button.addEventListener("click",()=>showView(button.dataset.target)));
  root.querySelectorAll("[data-settings-goto]").forEach(button=>button.addEventListener("click",()=>
    renderSettingsCategory(button.dataset.settingsGoto,{history:"push"})));
}
// ---------------------------------------------------------------------------
// Settings → Staff
//
// A roster rail beside one person's record. The rail is a vertical tablist and the record is its
// tabpanel, because the rail's only job is to swap what the one adjacent panel shows.
//
// The record form owns the fields that belong to the person - name, phone, linked account,
// calendar colour - and saves them as a merge, sending only what changed. Absence is not the same
// as an explicit value on PUT /api/employees/:id, which is what stops a rename from clearing the
// account link and the service restriction. The two operational controls act on their own: Active
// is a state transition, and Available services is a list edited in a drawer.
// ---------------------------------------------------------------------------
const staffState=tenantCache(()=>({selectedId:null,draft:null,activeError:null,unavailableOpen:false,drawer:null}));
// Reactivating is refusable: revoking a member disables the membership rather than deleting it,
// and deactivating an employee does not let go of it, so link → deactivate → revoke → reactivate
// would otherwise hand a revoked account back its attribution. The server refuses that with one
// code carrying the account status, because the remedy differs per status and "restore their
// access" is wrong advice for an invitation nobody ever accepted.
const staffAccountInactiveCode="EMPLOYEE_ACCOUNT_INACTIVE";

// Active first, then inactive, each alphabetically - the same order the server returns, restated
// because a saved row arrives back before the roster is refetched.
function staffRoster(){
  return [...state.employees].sort((left,right)=>
    Number(right.active)-Number(left.active)||left.displayName.localeCompare(right.displayName));
}
function staffDraftRecord(){
  return {id:"draft",draft:true,displayName:"",phone:"",membershipId:null,colorSlot:null,serviceIds:[],active:true};
}
function staffRecord(){
  if(staffState.selectedId==="draft")return staffState.draft;
  return state.employees.find(employee=>employee.id===staffState.selectedId)||null;
}
function staffEnsureSelection(){
  if(staffState.selectedId==="draft"&&staffState.draft)return;
  staffState.draft=null;
  if(state.employees.some(employee=>employee.id===staffState.selectedId))return;
  const roster=staffRoster();
  staffState.selectedId=roster[0]?.id||null;
}
// Grapheme-safe, matching petAvatarMarkup: Array.from, never [0].
function staffInitial(name){return Array.from(String(name||"").trim())[0]?.toUpperCase()||"?";}
function staffManages(){return allowed("team.manage");}
// The picker needs the workspace accounts, which arrive with refresh() alongside the roster. An
// empty list for a session that may read them means the call did not land - every workspace has
// at least its owner - so the select goes read-only rather than offering "No linked account" as
// though it were the whole truth.
function staffMembersLoaded(){return Array.isArray(state.members)&&state.members.length>0;}

// The role is the salon's own word for what this account can do, and it is set in exactly one
// place - Settings → Roles & permissions - so it is reported here and changed there. Ownership is
// not a role anybody assigns, so it still outranks whatever role the membership carries. A server
// that does not report a role on the membership yet falls back to the words that were available
// before roles existed rather than claiming the person has none.
function staffRoleLine(employee){
  if(!employee.membershipId)return "No linked account";
  if(!staffManages())return "Linked to a workspace account";
  if(!employee.accountEmail)return "Linked account not found";
  const member=(state.members||[]).find(item=>item.id===employee.membershipId);
  const role=employee.accountIsOwner?"Owner":member?.role?.name||member?.roleName||"Workspace member";
  const line=`${role} · ${employee.accountEmail}`;
  return employee.accountStatus&&employee.accountStatus!=="active"?`${line} · access ${employee.accountStatus}`:line;
}
function staffServicesSummary(serviceIds){
  if(!serviceIds.length)return "All services. Nothing is restricted, so this person can be booked for any service in the catalogue.";
  const total=state.services.filter(service=>service.active).length;
  return `${serviceIds.length} of ${total} services. Only these can be booked with this person.`;
}
function staffColourName(slot){return groomerSlotNames[slot]||"";}

function staffCardMarkup(employee,selected){
  // Inactive staff never reach the calendar, so the card carries no slot and --g falls back.
  const slot=employee.active?groomerColorSlot(employee.id):"";
  const chips=(employee.accountIsOwner?`<span class="staff-chip is-owner">Owner</span>`:"")
    +(employee.active?"":`<span class="staff-chip is-inactive">Inactive</span>`);
  return `<button type="button" role="tab" class="staff-card${selected?" is-selected":""}${employee.active?"":" is-inactive"}"`
    +` id="staff-tab-${escapeAttr(employee.id)}" aria-controls="staff-detail" aria-selected="${selected}" tabindex="${selected?0:-1}"`
    +` data-staff-id="${escapeAttr(employee.id)}"${slot===""?"":` data-groomer-slot="${slot}"`} data-testid="staff-card">`
    +`<span class="staff-avatar" aria-hidden="true">${escape(staffInitial(employee.displayName))}</span>`
    +`<span class="staff-card-text"><span class="staff-card-name">${escape(employee.displayName)}</span>`
    +(chips?`<span class="staff-card-meta">${chips}</span>`:"")
    +`</span></button>`;
}
function staffRailMarkup(roster){
  const inactive=roster.filter(employee=>!employee.active).length;
  const draft=staffState.draft
    ? `<button type="button" role="tab" class="staff-card is-selected" id="staff-tab-draft" aria-controls="staff-detail"`
      +` aria-selected="true" tabindex="0" data-staff-id="draft" data-testid="staff-card">`
      +`<span class="staff-avatar" aria-hidden="true">?</span>`
      +`<span class="staff-card-text"><span class="staff-card-name">New staff member</span></span></button>`
    : "";
  const cards=roster.map(employee=>staffCardMarkup(employee,employee.id===staffState.selectedId)).join("");
  return `<div class="staff-rail">`
    +(staffManages()?`<button type="button" class="primary compact staff-rail-add" data-testid="staff-add">+ Add staff</button>`:"")
    +(roster.length?`<p class="staff-rail-count">${roster.length} staff${inactive?` · ${inactive} inactive`:""}</p>`:"")
    +(roster.length||draft
      ? `<div class="staff-list" role="tablist" aria-orientation="vertical" aria-label="Staff">${draft}${cards}</div>`
      : `<p class="empty">No staff yet.</p>`)
    +`</div>`;
}
function staffEmptyPanelMarkup(){
  return `<article class="settings-panel" data-testid="staff-detail"><h3>No staff yet</h3>`
    +`<p>Add the people who groom. A staff member appears as a calendar column, can be assigned appointments, and gets their own colour. Pawsh can book an appointment without one, so nothing is broken until you do.</p>`
    +(staffManages()?`<button type="button" class="primary compact" data-testid="staff-add">+ Add staff</button>`:"")
    +`</article>`;
}
function staffDetailHeadMarkup(record){
  const name=record.draft?"New staff member":record.displayName;
  const slot=record.draft||!record.active?"":groomerColorSlot(record.id);
  return `<div class="staff-detail-head">`
    +`<span class="staff-avatar staff-avatar-lg"${slot===""?"":` data-groomer-slot="${slot}"`} aria-hidden="true">${escape(staffInitial(name))}</span>`
    +`<div><p class="eyebrow">Staff</p><h3>${escape(name)}</h3>`
    +`<p class="staff-detail-role">${escape(record.draft?"No linked account":staffRoleLine(record))}</p>`
    // Read-only on purpose: two screens that both write the role is how the two drift apart.
    +(record.draft||!record.membershipId||!staffManages()?"":`<p class="staff-detail-role-link"><button type="button" class="text-button staff-availability-link" data-settings-goto="permissions" data-testid="staff-role-link">Change this in Roles &amp; permissions</button></p>`)
    +`</div>`
    +(record.draft||record.active?"":`<span class="staff-chip is-inactive">Inactive</span>`)
    +`</div>`;
}
function staffMembershipMarkup(record){
  const hint=`<span class="field-hint">The workspace login this person signs in with. Report cards, agreements, rabies verifications, photos and notes they record are attributed to this account, and the mobile app uses it to know whose day to show.</span>`;
  if(!staffMembersLoaded()){
    return `<label class="staff-field-wide">Linked account`
      +`<select name="membershipId" data-testid="staff-membership" disabled><option>Workspace accounts unavailable</option></select>`
      +`<span class="field-hint">Workspace accounts could not be loaded. Saving keeps the current link.</span></label>`;
  }
  const options=state.members.map(member=>{
    const claimed=member.employeeId&&member.employeeId!==record.id;
    const suffix=claimed?` — linked to ${member.employeeDisplayName}`
      :member.isOwner?" — Owner"
        :member.status&&member.status!=="active"?` — ${member.status}`:"";
    return `<option value="${escapeAttr(member.id)}" ${claimed?"disabled":""} ${member.id===record.membershipId?"selected":""}>${escape(`${member.email}${suffix}`)}</option>`;
  }).join("");
  return `<label class="staff-field-wide">Linked account`
    +`<select name="membershipId" data-testid="staff-membership">`
    +`<option value="" ${record.membershipId?"":"selected"}>No linked account</option>${options}</select>${hint}</label>`;
}
function staffColoursMarkup(record){
  // Automatic is required: without it there is no way back to unset, and the pane would report a
  // stored colour where none is stored - which is every employee in every workspace today.
  const hashed=record.draft?"":groomerSlot(record.id);
  const chosen=Number.isInteger(record.colorSlot)?String(record.colorSlot):"";
  const autoName=hashed===""?"Automatic":`Automatic, currently ${staffColourName(hashed)}`;
  const swatches=groomerSlotNames.map((name,slot)=>
    `<label class="staff-swatch"><input type="radio" name="colorSlot" value="${slot}" ${chosen===String(slot)?"checked":""}>`
    +`<span class="staff-swatch-dot" data-groomer-slot="${slot}" aria-hidden="true"></span>`
    +`<span class="visually-hidden">${escape(name)}</span></label>`).join("");
  return `<fieldset class="staff-colours"><legend>Calendar colour</legend>`
    +`<p class="field-hint">Colours this person's appointment blocks, calendar column and report bars. Ten are available; above ten, two people share one.</p>`
    +`<div class="staff-swatches">`
    +`<label class="staff-swatch is-auto"><input type="radio" name="colorSlot" value="" ${chosen===""?"checked":""}>`
    +`<span class="staff-swatch-dot"${hashed===""?"":` data-groomer-slot="${hashed}"`} aria-hidden="true"></span>`
    +`<span class="visually-hidden">${escape(autoName)}</span><span class="staff-swatch-auto" aria-hidden="true">Auto</span></label>`
    +swatches+`</div>`
    +`<p class="staff-swatch-current" data-testid="staff-colour-current" aria-live="polite">${escape(staffColourLine(chosen,hashed))}</p>`
    +`</fieldset>`;
}
function staffColourLine(chosen,hashed){
  if(chosen!=="")return `Selected: ${staffColourName(Number(chosen))}`;
  return hashed===""?"Selected: Automatic":`Selected: Automatic (${staffColourName(hashed)})`;
}
function staffFormMarkup(record){
  return `<form class="staff-form" data-testid="staff-form"><div class="staff-field-grid">`
    +`<label>Name <input name="displayName" type="text" required maxlength="120" value="${escapeAttr(record.displayName||"")}" data-testid="staff-name"></label>`
    +`<label>Phone <span class="staff-optional">Optional</span>`
    +`<input name="phone" type="tel" inputmode="tel" maxlength="40" autocomplete="off" value="${escapeAttr(record.phone||"")}" data-testid="staff-phone">`
    +`<span class="field-hint">Kept on the record so the salon can reach this person. Pawsh never calls or texts it, and it is never shown to a client.</span></label>`
    +staffMembershipMarkup(record)
    +`</div>`
    +staffColoursMarkup(record)
    +`<div class="staff-form-foot"><p class="error" data-testid="staff-error"></p>`
    +(record.draft?`<button type="button" class="secondary compact" data-testid="staff-cancel">Cancel</button>`:"")
    +`<button type="submit" class="primary compact" data-testid="staff-save" disabled>${record.draft?"Create staff member":"Save"}</button></div></form>`;
}
// The refusal lives in the row rather than a toast: the cause is on another screen, and a
// two-clause explanation naming a remedy is longer than a toast survives. The guard is evaluated
// against the post-merge state, so unlinking and reactivating is one request rather than two
// saves - which is why the remedy the copy names is also a button beside it.
function staffActiveRefusalMarkup(refusal){
  const account=refusal.accountEmail?`<strong>${escape(refusal.accountEmail)}</strong>`:"the linked workspace account";
  const copy={
    disabled:`Cannot reactivate: ${account}'s workspace access was revoked. Clear the linked account above, or invite them again from Settings → Roles & permissions.`,
    account_disabled:`Cannot reactivate: the account ${account} has been disabled. Clear the linked account above to reactivate this person without a login.`,
    invited:`Cannot reactivate: ${account} has not accepted their invitation yet. Clear the linked account above, or cancel and re-send the invitation in Settings → Roles & permissions.`,
    removed:`Cannot reactivate: the linked workspace account no longer exists. Clear the linked account above to reactivate this person without a login.`
  }[refusal.accountStatus]
    ||`Cannot reactivate: ${account} is no longer active. Clear the linked account above to reactivate this person without a login.`;
  return `<span class="pref-hint is-refusal" data-testid="staff-active-refusal">${copy} `
    +`<button type="button" class="text-button staff-availability-link" data-testid="staff-unlink-reactivate">Unlink and reactivate</button>.</span>`;
}
function staffSchedulingMarkup(record){
  const restricted=record.serviceIds.length>0;
  const hint=staffState.activeError
    ?staffActiveRefusalMarkup(staffState.activeError)
    :`<span class="pref-hint">Appears on the calendar and can be assigned appointments. <button type="button" class="text-button staff-availability-link" data-settings-goto="availability">Set when they work in Availability</button>.</span>`;
  return `<section class="staff-section"><h4>Scheduling</h4>`
    +(record.draft?"":`<label class="pref-row"><span class="pref-text"><span class="pref-name">Active</span>${hint}</span>`
      +`<input type="checkbox" role="switch" class="pref-toggle" data-testid="staff-active" ${record.active?"checked":""}></label>`)
    +`<div class="pref-row"><span class="pref-text"><span class="pref-name">Available services</span>`
    +`<span class="pref-hint" data-testid="staff-services-summary">${escape(staffServicesSummary(record.serviceIds))}</span></span>`
    +`<span class="staff-services-value">${restricted?`<span class="staff-chip is-restricted">Restricted</span>`:""}`
    +`<button type="button" class="secondary compact" data-testid="staff-services-edit">Edit</button></span></div></section>`;
}
// Grouped, closed, and at the bottom. In Pawsh these four share exactly one property - they do not
// exist - and that, not their subject matter, is what an operator needs to learn. Interleaved among
// the live controls they would train the eye to skim past anything disabled, which is how someone
// misses that Available services is real. `fieldset disabled` makes them genuinely inert rather
// than focusable and useless; the summary sits outside it so the group still opens by keyboard.
function staffUnavailableMarkup(){
  const rows=[
    ["Enable online booking","Public online-booking configuration is not yet available in Pawsh, so there is nothing for a groomer to be opted into. Every appointment is booked by the salon.","switch"],
    ["Decline online requests from new clients","There is no online request queue to filter. This depends on online booking.","switch"],
    ["Start and end addresses","Pawsh schedules one salon location per workspace and does not route travel between appointments, so a groomer has no start or end address to record.","button"],
    ["Mobile app notifications","The Pawsh mobile app signs a groomer in and shows their day. It has no notification settings yet.","button"]
  ];
  return `<details class="staff-unavailable" data-testid="staff-unavailable"${staffState.unavailableOpen?" open":""}>`
    +`<summary><span class="staff-unavailable-title">Not available yet</span><span class="staff-chip">${rows.length}</span></summary>`
    +`<p class="staff-unavailable-intro">Pawsh does not have these capabilities, so there is nothing here to switch on. They are listed rather than hidden so it is clear they were not overlooked.</p>`
    +`<fieldset disabled><legend class="visually-hidden">Capabilities not available in Pawsh</legend>`
    +rows.map(([name,reason,control])=>`<div class="pref-row"><span class="pref-text"><span class="pref-name">${escape(name)}</span>`
      +`<span class="pref-hint">${escape(reason)}</span></span>`
      +(control==="switch"?`<input type="checkbox" role="switch" class="pref-toggle">`:`<button type="button" class="secondary compact">Manage</button>`)
      +`</div>`).join("")
    +`</fieldset></details>`;
}
// Without team.manage the roster still renders - the calendar needs these names - but the record is
// a set of facts. The switches and the unbuilt group are omitted rather than disabled: a disabled
// control implies "you could turn this on", and the honest message is that it is not yours. The API
// withholds phone and the account email from this session entirely, so those rows render only when
// the keys actually arrive.
function staffFactsMarkup(record){
  const slot=groomerColorSlot(record.id);
  const colour=Number.isInteger(record.colorSlot)
    ? staffColourName(record.colorSlot)
    : `${staffColourName(slot)} (automatic)`;
  const facts=[["Name",escape(record.displayName)]];
  if("phone" in record)facts.push(["Phone",escape(record.phone||"Not recorded")]);
  facts.push(["Linked account",escape(staffRoleLine(record))]);
  facts.push(["Calendar colour",`<span class="staff-swatch-dot" data-groomer-slot="${slot}" aria-hidden="true"></span>${escape(colour)}`]);
  facts.push(["Available services",escape(staffServicesSummary(record.serviceIds))]);
  return `<p class="fine staff-permission-note">Editing staff needs the Team permission.</p>`
    +`<dl class="account-facts staff-facts">${facts.map(([term,value])=>`<div><dt>${escape(term)}</dt><dd>${value}</dd></div>`).join("")}</dl>`;
}
function staffDetailMarkup(record){
  const labelledBy=record.draft?"staff-tab-draft":`staff-tab-${escapeAttr(record.id)}`;
  const body=staffManages()
    ? staffFormMarkup(record)+staffSchedulingMarkup(record)+(record.draft?"":staffUnavailableMarkup())
    : staffFactsMarkup(record);
  return `<div class="staff-panel" role="tabpanel" id="staff-detail" aria-labelledby="${labelledBy}" tabindex="-1" data-testid="staff-detail">`
    +staffDetailHeadMarkup(record)+body+`</div>`;
}
function staffMarkup(){
  const roster=staffRoster(),record=staffRecord();
  return `<div class="staff-workspace">${staffRailMarkup(roster)}${record?staffDetailMarkup(record):staffEmptyPanelMarkup()}</div>`;
}

// renderSettingsCategory replaces the whole settings pane on every nav click, so this re-reads
// module state rather than assuming anything about what is currently on screen. A save re-renders
// too, so focus is put back where it was; the guard is that it only moves focus at all when focus
// was already inside this screen, which keeps the shell's own content.focus() on first paint.
function renderStaff({restoreFocus=true}={}){
  const root=$("#staff-root");if(!root)return;
  const wanted=restoreFocus?staffFocusKey(root):null;
  staffEnsureSelection();
  root.innerHTML=staffMarkup();
  bindStaff(root);
  if(wanted)root.querySelector(wanted)?.focus();
}
function staffFocusKey(root){
  const active=document.activeElement;
  if(!active||!root.contains(active))return null;
  if(active.dataset?.staffId)return `[data-staff-id="${active.dataset.staffId}"]`;
  if(active.name)return `[name="${active.name}"]`;
  if(active.dataset?.testid)return `[data-testid="${active.dataset.testid}"]`;
  return null;
}
function bindStaff(root){
  bindSettingsGoto(root);
  root.querySelectorAll('[data-testid="staff-add"]').forEach(button=>button.addEventListener("click",addStaffDraft));
  bindStaffRoster(root);
  bindStaffForm(root);
  root.querySelector('[data-testid="staff-active"]')?.addEventListener("change",event=>{
    const record=staffRecord();if(!record||record.draft)return;
    runDetached(()=>setStaffActive(record,event.target.checked,{toggle:event.target}));
  });
  root.querySelector('[data-testid="staff-unlink-reactivate"]')?.addEventListener("click",()=>{
    const record=staffRecord();if(!record||record.draft)return;
    runDetached(()=>setStaffActive(record,true,{unlink:true}));
  });
  root.querySelector('[data-testid="staff-services-edit"]')?.addEventListener("click",openStaffServices);
  root.querySelector('[data-testid="staff-unavailable"]')?.addEventListener("toggle",event=>{
    staffState.unavailableOpen=event.target.open;
  });
}
// Arrow keys move focus and nothing else. The panel holds a half-typed record, so arrowing through
// the roster must not tear it down; Enter and Space are what commit. Same shape as newActionMenu.
function bindStaffRoster(root){
  const list=root.querySelector(".staff-list");if(!list)return;
  const cards=()=>[...list.querySelectorAll(".staff-card")];
  list.addEventListener("keydown",event=>{
    const items=cards(),index=items.indexOf(document.activeElement);
    if(index<0)return;
    if(event.key==="Enter"||event.key===" "||event.key==="Spacebar"){
      event.preventDefault();selectStaff(items[index].dataset.staffId);return;
    }
    if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
    event.preventDefault();
    const next=event.key==="Home"?0:event.key==="End"?items.length-1
      :(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;
    items[next]?.focus();
  });
  cards().forEach(card=>card.addEventListener("click",()=>selectStaff(card.dataset.staffId)));
}
function bindStaffForm(root){
  const form=root.querySelector(".staff-form");if(!form)return;
  const sync=()=>{
    form.querySelector('[data-testid="staff-save"]').disabled=!staffFormDirty(form);
    const values=staffFormValues(form),record=staffRecord();
    const line=form.querySelector('[data-testid="staff-colour-current"]');
    if(line)line.textContent=staffColourLine(values.colorSlot,!record||record.draft?"":groomerSlot(record.id));
  };
  form.addEventListener("input",sync);
  form.addEventListener("change",sync);
  form.addEventListener("submit",event=>{event.preventDefault();runDetached(()=>saveStaffRecord(form));});
  form.querySelector('[data-testid="staff-cancel"]')?.addEventListener("click",()=>{
    staffState.draft=null;staffState.selectedId=null;renderStaff({restoreFocus:false});
  });
}
function staffFormValues(form){
  const membership=form.elements.membershipId;
  return {
    displayName:form.elements.displayName.value.trim(),
    phone:form.elements.phone.value.trim(),
    membershipId:membership&&!membership.disabled?membership.value:null,
    colorSlot:form.querySelector('input[name="colorSlot"]:checked')?.value??""
  };
}
// Only what changed. An omitted field leaves what is stored alone, so a rename cannot clear the
// account link or the service restriction; an explicit null unlinks, and an explicit "" clears the
// number. A membership select that could not be populated sends nothing at all.
function staffFormChanges(record,values){
  const changes={};
  if(values.displayName!==record.displayName)changes.displayName=values.displayName;
  if(values.phone!==(record.phone||""))changes.phone=values.phone;
  if(values.membershipId!==null&&values.membershipId!==(record.membershipId||""))changes.membershipId=values.membershipId||null;
  const stored=Number.isInteger(record.colorSlot)?String(record.colorSlot):"";
  if(values.colorSlot!==stored)changes.colorSlot=values.colorSlot===""?null:Number(values.colorSlot);
  return changes;
}
function staffFormDirty(form){
  const record=staffRecord();if(!record)return false;
  const values=staffFormValues(form);
  if(record.draft)return Boolean(values.displayName);
  return Object.keys(staffFormChanges(record,values)).length>0;
}
async function saveStaffRecord(form){
  const record=staffRecord();if(!record)return;
  const values=staffFormValues(form);
  const error=form.querySelector('[data-testid="staff-error"]');
  const submit=form.querySelector('[data-testid="staff-save"]');
  error.textContent="";
  if(!values.displayName){error.textContent="Enter a name.";form.elements.displayName.focus();return;}
  submit.disabled=true;
  try{
    if(record.draft){
      const body={displayName:values.displayName,serviceIds:record.serviceIds};
      if(values.membershipId)body.membershipId=values.membershipId;
      if(values.colorSlot!=="")body.colorSlot=Number(values.colorSlot);
      if(values.phone)body.phone=values.phone;
      const created=await api("/api/employees",{method:"POST",body:JSON.stringify(body)});
      staffState.draft=null;staffState.selectedId=created.id;
      await refresh();toast("Staff member added");
    }else{
      const changes=staffFormChanges(record,values);
      if(Object.keys(changes).length)await api(`/api/employees/${record.id}`,{method:"PUT",body:JSON.stringify(changes)});
      await refresh();toast("Staff member saved");
    }
    staffState.activeError=null;renderStaff({restoreFocus:false});
  }catch(failure){
    // Entered values stay put and the message lands beside the button, because a toast is gone
    // before a validation refusal has been read.
    submit.disabled=false;error.textContent=failure.message;
    const code=failure.data?.code;
    const invalid=code==="MEMBERSHIP_NOT_LINKABLE"||code==="MEMBERSHIP_ALREADY_LINKED"
      ?form.elements.membershipId:form.elements.displayName;
    invalid?.focus();
  }
}
function selectStaff(id,{focus=true}={}){
  if(id===staffState.selectedId)return;
  const form=$("#staff-root .staff-form");
  if(form&&staffFormDirty(form)){
    const record=staffRecord();
    openStackedDialog({title:"Discard unsaved changes?",
      body:`<p>Changes to ${escape(record?.draft?"the new staff member":record?.displayName||"this staff member")} have not been saved.</p>`,
      confirmLabel:"Discard",dismissLabel:"Keep editing",
      onConfirm:()=>{commitStaffSelection(id,focus);}});
    return;
  }
  commitStaffSelection(id,focus);
}
function commitStaffSelection(id,focus){
  if(id!=="draft")staffState.draft=null;
  staffState.selectedId=id;staffState.activeError=null;
  renderStaff({restoreFocus:false});
  if(!focus)return;
  if(id==="draft"){$("#staff-root [name=\"displayName\"]")?.focus();return;}
  // Stacked below a scrolling roster, the panel would otherwise scroll away from the tab that
  // still holds focus.
  const panel=$('#staff-root [data-testid="staff-detail"]');
  if(globalThis.matchMedia("(max-width:760px)").matches&&panel){
    panel.focus();
    panel.scrollIntoView({block:"start",
      behavior:globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
    return;
  }
  $(`#staff-root [data-staff-id="${id}"]`)?.focus();
}
// A draft row rather than a modal: this screen exists to remove the second staff editor, and a
// modal would put one back.
function addStaffDraft(){
  if(staffState.selectedId==="draft")return;
  staffState.draft=staffDraftRecord();
  selectStaff("draft");
}
// The switch never rests in a state the server did not accept: every path that does not end in a
// successful write puts it back, including Escape and the backdrop, which bypass the dismiss
// button. A success re-renders instead, so the restored toggle is gone by the time close fires.
async function setStaffActive(employee,wanted,{unlink=false,toggle=null}={}){
  staffState.activeError=null;
  const revert=()=>{if(toggle?.isConnected){toggle.checked=employee.active;toggle.disabled=false;}};
  if(!wanted){
    const dialog=openStackedDialog({title:`Deactivate ${employee.displayName}?`,
      body:"<p>They stop appearing on the calendar and cannot be assigned new appointments. Appointments already booked are unchanged.</p>",
      confirmLabel:"Deactivate",dismissLabel:"Cancel",
      onConfirm:async()=>{
        await api(`/api/employees/${employee.id}`,{method:"DELETE"});
        await refresh();renderStaff({restoreFocus:false});toast(`${employee.displayName} deactivated`);
      }});
    dialog.addEventListener("close",revert,{once:true});
    return;
  }
  if(toggle)toggle.disabled=true;
  try{
    await api(`/api/employees/${employee.id}`,{method:"PUT",
      body:JSON.stringify(unlink?{active:true,membershipId:null}:{active:true})});
    await refresh();renderStaff({restoreFocus:false});
    toast(unlink?`${employee.displayName} reactivated without a linked account`:`${employee.displayName} reactivated`);
  }catch(error){
    // A refusal the server registered names a cause on another screen, so it replaces the row's own
    // hint where it can be read. A transport failure keeps the ordinary error line and its retry.
    if(error.data?.code===staffAccountInactiveCode){
      staffState.activeError={accountStatus:error.data.accountStatus,accountEmail:error.data.accountEmail};
      renderStaff({restoreFocus:false});return;
    }
    revert();
    const line=$('#staff-root [data-testid="staff-error"]');
    if(line)line.textContent=error.message;else toast(error.message);
  }
}

// --- Available services drawer -------------------------------------------
// An empty set is "no restriction", never "restricted to nothing", so the drawer asks the question
// as a rule rather than a count and refuses to save a restriction with nothing in it.
function staffServiceGroupsMarkup(record){
  const chosen=staffState.drawer.serviceIds;
  const labels={DOG_BASE:"Main services",DOG_ADDON:"Dog add-ons",A_LA_CARTE:"À la carte",CAT:"Cat services",GENERAL:"General"};
  const catalogue=state.services.filter(service=>service.active||record.serviceIds.includes(service.id));
  const groups=[...new Set(catalogue.map(service=>service.category))].sort((left,right)=>{
    const rank=value=>{const index=serviceCategoryOrder.indexOf(value);return index<0?serviceCategoryOrder.length:index;};
    return rank(left)-rank(right)||left.localeCompare(right);
  });
  return groups.map(category=>{
    const options=catalogue.filter(service=>service.category===category).map(service=>
      `<label><input type="checkbox" name="staffServiceIds" value="${escapeAttr(service.id)}" ${chosen.has(service.id)?"checked":""}>`
      +`<span>${escape(service.name)}${service.active?"":`<span class="staff-chip">Archived</span>`}</span></label>`).join("");
    return `<section class="staff-services-group"><h4>${escape(labels[category]||category.replaceAll("_"," "))}</h4>`
      +`<div class="compact-options">${options}</div></section>`;
  }).join("")||`<p class="empty">Add a service first.</p>`;
}
function staffServicesBodyMarkup(record){
  const mode=staffState.drawer.mode;
  return `<p class="staff-services-intro">Everyone is bookable for the whole catalogue unless they are restricted here. A restriction is enforced when a service is assigned: Pawsh refuses to book, add or move a service onto someone who is not set up for it.</p>`
    +`<fieldset class="staff-services-mode"><legend>Booking rule</legend>`
    +`<label><input type="radio" name="staffServiceMode" value="all" ${mode==="all"?"checked":""}> No restriction — bookable for any service</label>`
    +`<label><input type="radio" name="staffServiceMode" value="restrict" ${mode==="restrict"?"checked":""}> Restrict to selected services</label>`
    +`</fieldset>`
    +`<div data-staff-service-catalogue ${mode==="restrict"?"":"hidden"}>${staffServiceGroupsMarkup(record)}</div>`
    +`<p class="error staff-services-error" data-testid="staff-services-refusal"></p>`;
}
function openStaffServices(){
  const record=staffRecord();if(!record)return;
  staffState.drawer={id:record.id,mode:record.serviceIds.length?"restrict":"all",serviceIds:new Set(record.serviceIds)};
  const drawer=$("#staff-services-drawer");
  drawer.querySelector("#staff-services-title").textContent=record.draft?"New staff member":record.displayName;
  $("#staff-services-body").innerHTML=staffServicesBodyMarkup(record);
  bindStaffServicesBody();
  syncStaffServicesDrawer();
  if(!drawer.open)drawer.showModal();
  drawer.querySelector(".drawer-head .close")?.focus();
}
function bindStaffServicesBody(){
  const body=$("#staff-services-body");
  body.querySelectorAll('input[name="staffServiceMode"]').forEach(input=>input.addEventListener("change",()=>{
    staffState.drawer.mode=input.value;syncStaffServicesDrawer();
  }));
  body.querySelectorAll('input[name="staffServiceIds"]').forEach(input=>input.addEventListener("change",()=>{
    if(input.checked)staffState.drawer.serviceIds.add(input.value);
    else staffState.drawer.serviceIds.delete(input.value);
    syncStaffServicesDrawer();
  }));
}
function syncStaffServicesDrawer(){
  const draft=staffState.drawer;if(!draft)return;
  const restrict=draft.mode==="restrict",empty=restrict&&!draft.serviceIds.size;
  $("#staff-services-body [data-staff-service-catalogue]").hidden=!restrict;
  $('[data-testid="staff-services-refusal"]').textContent=empty
    ?"Choose at least one service, or switch to No restriction.":"";
  $('[data-testid="staff-services-save"]').disabled=empty;
}
async function saveStaffServices(){
  const draft=staffState.drawer,record=staffRecord();
  if(!draft||!record)return;
  const serviceIds=draft.mode==="restrict"?[...draft.serviceIds]:[];
  if(draft.mode==="restrict"&&!serviceIds.length)return;
  const drawer=$("#staff-services-drawer");
  if(record.draft){
    record.serviceIds=serviceIds;drawer.close();renderStaff({restoreFocus:false});return;
  }
  const save=$('[data-testid="staff-services-save"]');save.disabled=true;
  try{
    await api(`/api/employees/${record.id}`,{method:"PUT",body:JSON.stringify({serviceIds})});
    await refresh();drawer.close();renderStaff({restoreFocus:false});
    toast(serviceIds.length?"Available services saved":"Service restriction cleared");
  }catch(error){
    save.disabled=false;
    $('[data-testid="staff-services-refusal"]').textContent=error.message;
  }
}
function setupStaffServicesDrawer(){
  const drawer=$("#staff-services-drawer");if(!drawer)return;
  const close=()=>drawer.close();
  drawer.querySelector('[data-testid="staff-services-close"]')?.addEventListener("click",close);
  drawer.querySelector('[data-testid="staff-services-cancel"]')?.addEventListener("click",close);
  drawer.querySelector('[data-testid="staff-services-save"]')?.addEventListener("click",()=>runDetached(saveStaffServices));
  // Clicking the backdrop dismisses it: the click lands on the dialog itself, never on its panel.
  drawer.addEventListener("click",event=>{if(event.target===drawer)close();});
  drawer.addEventListener("close",()=>{staffState.drawer=null;});
}
// ---------------------------------------------------------------------------
// Settings → Availability
//
// Four tabs over two different scopes, which is the whole difficulty of this screen. A groomer's
// default hours belong to the workspace and follow that person to every salon; a closed day belongs
// to one location. Most groomers work at both, so an operator editing hours while the header reads
// "Riverside" has to be told — in the tab bar, in a strip under it, and again in the toast when they
// switch — that the grid in front of them is not Riverside's.
// ---------------------------------------------------------------------------
const AVAILABILITY_WEEKDAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const AVAILABILITY_WEEKDAYS_SHORT=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const AVAILABILITY_TABS=[
  ["default","Default working hours","workspace"],
  ["week","Schedule by week","workspace"],
  ["calendar","Working calendar","workspace"],
  ["closed","Closed","location"]
];
const AVAILABILITY_PLACEHOLDERS={
  week:"Setting a groomer's hours for one specific week is not yet available. Default working hours apply to every week, and a one-off change is still made on the appointment itself.",
  calendar:"A month-at-a-glance view of who is working is not yet available. Default working hours are the source of truth for now, and the Calendar shows what is actually booked."
};
const availabilityState=tenantCache(()=>({tab:"default",hours:null,overrides:null,hoursError:null,hoursLoading:false,closures:null,closuresError:null,closuresLoading:false,closureLocationId:null,month:null,focusCell:null,focusDate:null,restoreFocus:false}));
let availabilityEditorTeardown=null;
// Seven columns of times do not survive a phone, so below this width the same data renders as a
// stacked per-groomer list and the editor becomes the shared dialog. The query is read at render
// time, so rotating the device is enough to change template.
const availabilityCompact=globalThis.matchMedia?globalThis.matchMedia("(max-width:619px)"):null;
availabilityCompact?.addEventListener("change",()=>{if($("#availability-root"))renderAvailability();});

function availabilityClock(value){const [hour,minute]=String(value||"").split(":");return timeLabel(Number(hour)*60+Number(minute));}
function availabilityLocationName(){return state.me?.business?.locationName||"this location";}
function availabilityLocationId(){return state.me?.business?.locationId||null;}
function availabilityMonth(){return availabilityState.month||businessDate().slice(0,7);}
function availabilityMonthShift(month,step){const [year,index]=month.split("-").map(Number),date=new Date(Date.UTC(year,index-1+step,1));return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}`;}
function availabilityMonthLength(month){const [year,index]=month.split("-").map(Number);return new Date(Date.UTC(year,index,0)).getUTCDate();}
function availabilityMonthLabel(month){return new Intl.DateTimeFormat([],{month:"long",year:"numeric",timeZone:"UTC"}).format(dateAt(`${month}-01`));}
function availabilityDateValue(month,day){return `${month}-${String(day).padStart(2,"0")}`;}
// "Saturday 14 March 2026" rather than a bare date: the switch's accessible name has to say which
// day it closes, or aria-checked is describing nothing anybody can identify.
function availabilityDateLabel(localDate){
  const date=dateAt(localDate);
  const weekday=new Intl.DateTimeFormat([],{weekday:"long",timeZone:"UTC"}).format(date);
  const month=new Intl.DateTimeFormat([],{month:"long",timeZone:"UTC"}).format(date);
  return `${weekday} ${Number(localDate.slice(8,10))} ${month} ${localDate.slice(0,4)}`;
}
function availabilityGroomers(){return (availabilityState.hours||[]).filter(employee=>employee.active);}
function availabilityEmployee(employeeId){return (availabilityState.hours||[]).find(employee=>employee.id===employeeId)||null;}
function availabilityDay(employee,weekday){return (employee?.days||[]).find(day=>Number(day.weekday)===Number(weekday))||null;}
function availabilityOverrideCount(employeeId,weekday){return Number(availabilityState.overrides?.get(`${employeeId}:${weekday}`)||0);}
function availabilityOverrideText(count){return `${count} appointment${count===1?"":"s"} booked outside these hours.`;}
function availabilityCellAt(employeeId,weekday){
  return $$("#availability-root [data-availability-cell]").find(cell=>cell.dataset.employeeId===employeeId&&Number(cell.dataset.weekday)===Number(weekday))||null;
}

async function loadAvailabilityHours(){
  availabilityState.hoursLoading=true;availabilityState.hoursError=null;
  try{
    // The counts are decoration on a grid that is useful without them, so a failure there is not
    // allowed to take the hours down with it.
    const [hours,counts]=await Promise.all([
      api("/api/availability/working-hours"),
      api("/api/availability/override-counts").catch(()=>[])
    ]);
    availabilityState.hours=Array.isArray(hours?.employees)?hours.employees:[];
    availabilityState.overrides=new Map((Array.isArray(counts)?counts:[]).map(entry=>[`${entry.employeeId}:${Number(entry.weekday)}`,Number(entry.count)]));
  }catch(error){availabilityState.hoursError=error;}
  finally{availabilityState.hoursLoading=false;}
}
async function loadAvailabilityClosures(){
  const locationId=availabilityLocationId(),month=availabilityMonth();
  if(!locationId){availabilityState.closuresError=new Error("This workspace has no active location.");return;}
  availabilityState.closuresLoading=true;availabilityState.closuresError=null;
  try{
    const to=availabilityDateValue(month,availabilityMonthLength(month));
    const result=await api(`/api/locations/${encodeURIComponent(locationId)}/closure-days?from=${month}-01&to=${to}`);
    // The response is sparse: a quiet, open day is simply absent, so absence has to read as "open,
    // nothing booked" rather than as data that failed to arrive.
    availabilityState.closures=new Map((result?.days||[]).map(day=>[day.localDate,{closed:Boolean(day.closed),reason:day.reason||null,booked:Number(day.bookedAppointments||0)}]));
    availabilityState.closureLocationId=locationId;
  }catch(error){availabilityState.closuresError=error;}
  finally{availabilityState.closuresLoading=false;}
}
// Every entry point runs through here, so a nav click, a tab change, a month step and a location
// switch all decide what to fetch by one rule: what this tab needs and does not already hold.
function ensureAvailabilityData(){
  if(!allowed("calendar.view"))return;
  if(availabilityState.tab==="closed"){
    if(availabilityState.closuresLoading||availabilityState.closuresError)return;
    if(availabilityState.closures&&availabilityState.closureLocationId===availabilityLocationId())return;
    runDetached(async()=>{await loadAvailabilityClosures();renderAvailability();});
    return;
  }
  if(availabilityState.tab!=="default"||availabilityState.hours||availabilityState.hoursLoading||availabilityState.hoursError)return;
  runDetached(async()=>{await loadAvailabilityHours();renderAvailability();});
}
// The location switcher invalidates the location-scoped half. Working hours survive it deliberately:
// they are workspace data, and refetching them would imply, wrongly, that they had changed.
function resetAvailabilityLocationData(){
  availabilityState.closures=null;availabilityState.closuresError=null;availabilityState.closureLocationId=null;availabilityState.month=null;
}
function availabilityWorkspaceTabOpen(){return Boolean($("#availability-root"))&&availabilityState.tab!=="closed";}

function availabilityTabsMarkup(){
  const location=availabilityLocationName();
  // One tablist so the arrow keys cross the divider, split into two labelled groups so the divider
  // falls exactly where the scope changes. The groups are presentational, which keeps the tabs
  // owned by the tablist rather than by a generic container.
  const group=(scope,eyebrow)=>`<div class="availability-tab-group availability-tab-group-${scope}" role="presentation">`
    +`<p class="eyebrow availability-tab-eyebrow" aria-hidden="true">${escape(eyebrow)}</p>`
    +`<div class="availability-tab-row" role="presentation">`
    +AVAILABILITY_TABS.filter(([,,tabScope])=>tabScope===scope).map(([id,label])=>{
      const active=availabilityState.tab===id;
      // Visible label first, so that speaking the name and clicking the control stay the same
      // instruction (WCAG 2.5.3); the scope rides along behind it.
      const name=`${label}, ${scope==="workspace"?"workspace-wide":`${location} only`}`;
      return `<button type="button" role="tab" id="availability-tab-${id}" class="availability-tab${active?" active":""}" data-availability-tab="${id}" data-testid="availability-tab-${id}" aria-selected="${active}" aria-controls="availability-panel" aria-label="${escape(name)}" tabindex="${active?0:-1}">${escape(label)}</button>`;
    }).join("")
    +`</div></div>`;
  return `<div class="availability-tabs" role="tablist" aria-label="Availability" data-testid="availability-tabs">`
    +group("workspace","Workspace · All locations")
    +group("location",`${location} only`)
    +`</div>`;
}
function availabilityScopeMarkup(){
  if(availabilityState.tab==="closed"){
    return `<p class="availability-scope is-location" id="availability-scope-note" data-testid="availability-scope-strip"><strong>${escape(availabilityLocationName())} only.</strong> Closed days apply to bookings at this location and nowhere else.</p>`;
  }
  return `<p class="availability-scope is-workspace" id="availability-scope-note" data-testid="availability-scope-strip"><strong>Workspace-wide.</strong> These hours follow each groomer to every Pawsh location.</p>`;
}

// Seven columns of times only fit if they are written the way the calendar writes them, so the
// visible range reuses the same compaction. The spoken form below stays unabbreviated.
function availabilityRange(startTime,endTime){
  const at=value=>{const [hour,minute]=String(value||"").split(":");return new Date(2020,0,1,Number(hour),Number(minute));};
  return compactTimeRange(at(startTime),at(endTime));
}
function availabilityCellState(employee,weekday){
  const day=availabilityDay(employee,weekday),count=availabilityOverrideCount(employee.id,weekday);
  const range=day?availabilityRange(day.startTime,day.endTime):"Off";
  const spoken=day?`${availabilityClock(day.startTime)} to ${availabilityClock(day.endTime)}`:"Off";
  return {day,count,range,name:`${employee.displayName}, ${AVAILABILITY_WEEKDAYS[weekday]}, ${spoken}.${count?` ${availabilityOverrideText(count)}`:""}`};
}
// Information, not a fault: a groomer marked off on Saturday with four Saturday bookings is the most
// useful thing this grid can say, so the marker renders on Off cells too.
function availabilityOverrideMarkup(count){
  return count?`<span class="availability-override" aria-hidden="true"><span class="availability-override-dot"></span>${count} booked outside</span>`:"";
}
function availabilityRovingCell(groomers){
  const wanted=availabilityState.focusCell;
  const valid=wanted&&groomers.some(employee=>employee.id===wanted.employeeId);
  return valid?`${wanted.employeeId}:${wanted.weekday}`:groomers[0]?`${groomers[0].id}:0`:null;
}
function availabilityGridMarkup(editable){
  const groomers=availabilityGroomers(),roving=availabilityRovingCell(groomers);
  return `<div class="availability-grid-wrap" data-allow-horizontal-scroll>`
    +`<table class="availability-grid"${editable?' role="grid"':""} aria-label="Default working hours by groomer and weekday" aria-describedby="availability-scope-note availability-limit-note" data-testid="availability-grid">`
    +`<thead><tr><th scope="col" class="availability-grid-corner">Groomer</th>${AVAILABILITY_WEEKDAYS.map((day,index)=>`<th scope="col"><abbr title="${escape(day)}">${AVAILABILITY_WEEKDAYS_SHORT[index]}</abbr></th>`).join("")}</tr></thead><tbody>`
    +groomers.map(employee=>`<tr><th scope="row" class="availability-groomer" data-groomer-slot="${groomerColorSlot(employee.id)}">${escape(employee.displayName)}</th>`
      +AVAILABILITY_WEEKDAYS.map((unused,weekday)=>{
        const cell=availabilityCellState(employee,weekday);
        const body=`<span class="availability-range">${escape(cell.range)}</span>`
          // Stated once in the panel note and reached through aria-describedby on the grid. Repeating
          // one constant across thirty-five cells is noise for anybody listening to it.
          +(cell.day?`<span class="availability-limit" aria-hidden="true">1 at a time</span>`:"")
          +availabilityOverrideMarkup(cell.count);
        const shared=`class="availability-cell${cell.day?" is-working":" is-off"}${cell.count?" has-override":""}" data-availability-cell data-employee-id="${escape(employee.id)}" data-weekday="${weekday}" aria-label="${escape(cell.name)}"`;
        return editable
          ?`<td role="gridcell" ${shared} tabindex="${`${employee.id}:${weekday}`===roving?0:-1}">${body}</td>`
          :`<td ${shared}>${body}</td>`;
      }).join("")+`</tr>`).join("")
    +`</tbody></table></div>`;
}
function availabilityStackMarkup(editable){
  return `<div class="availability-stack" data-testid="availability-stack">`
    +availabilityGroomers().map(employee=>`<section class="availability-stack-groomer">`
      +`<h4 data-groomer-slot="${groomerColorSlot(employee.id)}">${escape(employee.displayName)}</h4><ul>`
      +AVAILABILITY_WEEKDAYS.map((label,weekday)=>{
        const cell=availabilityCellState(employee,weekday);
        const body=`<span class="availability-stack-day">${escape(label)}</span><span class="availability-range">${escape(cell.range)}</span>`+availabilityOverrideMarkup(cell.count);
        const shared=`class="availability-stack-row${cell.day?" is-working":" is-off"}${cell.count?" has-override":""}" data-availability-cell data-employee-id="${escape(employee.id)}" data-weekday="${weekday}" aria-label="${escape(cell.name)}"`;
        return `<li>${editable?`<button type="button" ${shared}>${body}</button>`:`<div ${shared}>${body}</div>`}</li>`;
      }).join("")+`</ul></section>`).join("")
    +`</div>`;
}
// The real table shell with skeleton bars rather than a spinner, so arriving data does not move the
// columns the operator has already started reading.
function availabilitySkeletonMarkup(){
  return `<div class="availability-grid-wrap" data-allow-horizontal-scroll>`
    +`<table class="availability-grid is-skeleton" aria-busy="true" aria-label="Default working hours, loading">`
    +`<thead><tr><th scope="col" class="availability-grid-corner">Groomer</th>${AVAILABILITY_WEEKDAYS.map((day,index)=>`<th scope="col"><abbr title="${escape(day)}">${AVAILABILITY_WEEKDAYS_SHORT[index]}</abbr></th>`).join("")}</tr></thead><tbody>`
    +[0,1,2,3].map(()=>`<tr><th scope="row" class="availability-groomer"><span class="availability-skeleton-bar"></span></th>${AVAILABILITY_WEEKDAYS.map(()=>`<td><span class="availability-skeleton-bar"></span></td>`).join("")}</tr>`).join("")
    +`</tbody></table></div>`;
}
function availabilityErrorMarkup(kind,error){
  const message=error?.status===403?"You do not have permission to view this."
    :error?.status===404?"That location is no longer available."
    :error?.status?error.message
    :"Could not load availability. Check your connection and try again.";
  return `<div class="availability-error" data-testid="availability-error"><h4>This could not load</h4><p>${escape(message)}</p>`
    +`<button type="button" class="secondary compact" data-availability-retry="${kind}">Try again</button></div>`;
}
function availabilityDefaultMarkup(){
  if(!allowed("calendar.view"))return `<p class="availability-note">Viewing working hours needs the Calendar permission.</p>`;
  if(availabilityState.hoursError)return availabilityErrorMarkup("hours",availabilityState.hoursError);
  if(!availabilityState.hours)return `<p class="availability-note" id="availability-limit-note">Each groomer takes one appointment at a time.</p>`+availabilitySkeletonMarkup();
  const editable=allowed("team.manage"),groomers=availabilityGroomers();
  if(!groomers.length){
    return `<div class="empty-workspace"><span class="empty-icon" aria-hidden="true">◎</span><h3>No groomers yet</h3>`
      +`<p>Default working hours describe the people who groom. Add a groomer under Staff and their week appears here.</p>`
      +`<button type="button" class="secondary compact" data-settings-goto="staff">Open Staff</button></div>`;
  }
  // Nobody having set hours yet is not an empty state. The grid is the answer, every cell reads Off,
  // and the note says what Pawsh actually does with that — which is not "refuse every booking".
  const unset=groomers.every(employee=>!(employee.days||[]).length);
  return `<p class="availability-note" id="availability-limit-note">Each groomer takes one appointment at a time.${editable?" Choose a day to change it.":""}</p>`
    +(unset?`<p class="availability-note is-quiet">No default hours are set yet. Every day reads Off, and until hours are set Pawsh does not restrict when these groomers can be booked.</p>`:"")
    +(editable?"":`<p class="availability-note is-quiet">Changing working hours needs the Team permission.</p>`)
    +(availabilityCompact?.matches?availabilityStackMarkup(editable):availabilityGridMarkup(editable));
}
function availabilityClosedMarkup(){
  const location=availabilityLocationName(),month=availabilityMonth();
  const head=`<div class="availability-closed-head"><h3>${escape(location)}</h3>`
    +`<p class="availability-closed-rule">A closed day turns down every booking at ${escape(location)} — an override reason will not get past it.</p></div>`;
  if(!allowed("calendar.view"))return head+`<p class="availability-note">Viewing closed days needs the Calendar permission.</p>`;
  const nav=`<div class="calendar-date-nav availability-month-nav">`
    +`<button type="button" class="secondary compact" data-availability-month="-1" aria-label="Previous month">←</button>`
    +`<strong data-testid="availability-month">${escape(availabilityMonthLabel(month))}</strong>`
    +`<button type="button" class="secondary compact" data-availability-month="1" aria-label="Next month">→</button></div>`;
  if(availabilityState.closuresError)return head+nav+availabilityErrorMarkup("closures",availabilityState.closuresError);
  if(!availabilityState.closures)return head+nav+`<p class="availability-note is-quiet" aria-busy="true">Loading closed days…</p>`;
  const editable=allowed("settings.manage"),today=businessDate(),length=availabilityMonthLength(month),lead=dateAt(`${month}-01`).getUTCDay();
  const roving=availabilityState.focusDate&&availabilityState.focusDate.startsWith(`${month}-`)
    ?availabilityState.focusDate
    :availabilityDateValue(month,today.startsWith(`${month}-`)?Number(today.slice(8,10)):1);
  const cells=[];
  for(let index=0;index<lead;index++)cells.push(`<td class="availability-day-blank"></td>`);
  for(let day=1;day<=length;day++){
    const localDate=availabilityDateValue(month,day),entry=availabilityState.closures.get(localDate);
    const closed=Boolean(entry?.closed),past=localDate<today,label=availabilityDateLabel(localDate),tab=localDate===roving?0:-1;
    // Solid ink and the word "Closed": the state never rests on hue alone, and it is deliberately not
    // danger red — closing a day is a decision the operator made, not a fault to be corrected.
    const body=`<span class="availability-day-number">${day}</span>${closed?`<span class="availability-day-state">Closed</span>`:""}`;
    // A past day cannot be closed any more, but dropping it would put a hole in the arrow path, so it
    // stays reachable and simply stops being a switch.
    cells.push(`<td role="gridcell" class="availability-day-cell${closed?" is-closed":""}${past?" is-past":""}">`
      +(past||!editable
        ?`<span class="availability-day" tabindex="${tab}" data-availability-day="${localDate}" data-availability-static>${body}<span class="visually-hidden">${escape(label)}${closed?", closed":""}${past?", past day":""}</span></span>`
        :`<button type="button" class="availability-day" role="switch" aria-checked="${closed}" tabindex="${tab}" data-availability-day="${localDate}" aria-label="Closed on ${escape(label)}">${body}</button>`)
      +`</td>`);
  }
  while(cells.length%7)cells.push(`<td class="availability-day-blank"></td>`);
  const rows=[];
  for(let index=0;index<cells.length;index+=7)rows.push(`<tr>${cells.slice(index,index+7).join("")}</tr>`);
  return head+nav
    +`<div class="availability-closed-grid-wrap" data-allow-horizontal-scroll>`
    +`<table class="availability-closed-grid" role="grid" aria-label="Closed days at ${escape(location)}, ${escape(availabilityMonthLabel(month))}" data-testid="availability-closed-grid">`
    +`<thead><tr>${AVAILABILITY_WEEKDAYS.map((day,index)=>`<th scope="col"><abbr title="${escape(day)}">${AVAILABILITY_WEEKDAYS_SHORT[index]}</abbr></th>`).join("")}</tr></thead>`
    +`<tbody>${rows.join("")}</tbody></table></div>`
    +(editable?"":`<p class="availability-note is-quiet">Changing closed days needs the Settings permission.</p>`);
}
function availabilityMarkup(){
  const placeholder=Boolean(AVAILABILITY_PLACEHOLDERS[availabilityState.tab]);
  const body=placeholder
    ?`<p class="eyebrow">Coming soon</p><h3>${escape(AVAILABILITY_TABS.find(([id])=>id===availabilityState.tab)[1])}</h3><p>${escape(AVAILABILITY_PLACEHOLDERS[availabilityState.tab])}</p>`
    :availabilityState.tab==="closed"?availabilityClosedMarkup():availabilityDefaultMarkup();
  return availabilityTabsMarkup()+availabilityScopeMarkup()
    +`<article class="settings-panel availability-panel${placeholder?" settings-placeholder":""}" id="availability-panel" role="tabpanel" aria-labelledby="availability-tab-${availabilityState.tab}"${placeholder?' tabindex="0" data-testid="settings-placeholder"':""}>`
    +body+`</article>`;
}

// renderSettingsCategory replaces the whole settings pane on every nav click, so this re-reads module
// state rather than assuming anything about what is currently on screen.
function renderAvailability(){
  const root=$("#availability-root");if(!root)return;
  closeAvailabilityEditor();
  root.innerHTML=availabilityMarkup();
  bindAvailability(root);
  if(!availabilityState.restoreFocus)return;
  const target=availabilityState.tab==="closed"
    ?root.querySelector(`[data-availability-day="${availabilityState.focusDate}"]`)
    :root.querySelector("[data-availability-cell][tabindex='0']");
  if(!target)return;
  availabilityState.restoreFocus=false;target.focus();
}
function selectAvailabilityTab(tab,{focus=true}={}){
  if(availabilityState.tab===tab)return;
  availabilityState.tab=tab;
  renderAvailability();
  if(focus)$(`#availability-tab-${tab}`)?.focus();
  ensureAvailabilityData();
}
function shiftAvailabilityMonth(step,{focusDay=null}={}){
  const month=availabilityMonthShift(availabilityMonth(),step);
  availabilityState.month=month;availabilityState.closures=null;availabilityState.closuresError=null;
  if(focusDay){
    availabilityState.focusDate=availabilityDateValue(month,Math.min(focusDay,availabilityMonthLength(month)));
    availabilityState.restoreFocus=true;
  }
  renderAvailability();ensureAvailabilityData();
}
function bindAvailability(root){
  // Arrow keys move focus across the divider without activating. Activation on focus would fire four
  // loads for one pass along the bar, so Enter and Space are what commit.
  root.querySelector('[role="tablist"]')?.addEventListener("keydown",event=>{
    const buttons=[...root.querySelectorAll("[data-availability-tab]")],index=buttons.indexOf(document.activeElement);
    if(index<0)return;
    if(event.key==="Enter"||event.key===" "||event.key==="Spacebar"){event.preventDefault();selectAvailabilityTab(buttons[index].dataset.availabilityTab);return;}
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();
    const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
    buttons[next]?.focus();
  });
  root.querySelectorAll("[data-availability-tab]").forEach(button=>button.addEventListener("click",()=>selectAvailabilityTab(button.dataset.availabilityTab,{focus:false})));
  root.querySelectorAll("[data-availability-retry]").forEach(button=>button.addEventListener("click",()=>{
    if(button.dataset.availabilityRetry==="hours"){availabilityState.hours=null;availabilityState.hoursError=null;}
    else{availabilityState.closures=null;availabilityState.closuresError=null;}
    renderAvailability();ensureAvailabilityData();
  }));
  bindSettingsGoto(root);
  root.querySelectorAll("[data-availability-month]").forEach(button=>button.addEventListener("click",()=>shiftAvailabilityMonth(Number(button.dataset.availabilityMonth))));
  bindAvailabilityHours(root);
  bindAvailabilityClosures(root);
}

// --- Tab 1 editing -------------------------------------------------------
function bindAvailabilityHours(root){
  if(!allowed("team.manage"))return;
  root.querySelectorAll("[data-availability-cell]").forEach(cell=>cell.addEventListener("click",event=>{
    event.stopPropagation();openAvailabilityEditor(cell);
  }));
  const grid=root.querySelector('.availability-grid[role="grid"]');
  grid?.addEventListener("keydown",event=>{
    const cell=event.target.closest?.("[data-availability-cell]");
    if(!cell||event.target!==cell)return;
    if(["Enter","F2"," ","Spacebar"].includes(event.key)){event.preventDefault();openAvailabilityEditor(cell);return;}
    // Delete does not save. It opens the same editor with Off already chosen, because a week that
    // clears itself on a keystroke is a week nobody can be sure they meant to clear.
    if(["Delete","Backspace"].includes(event.key)){event.preventDefault();openAvailabilityEditor(cell,{off:true});return;}
    if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key))return;
    event.preventDefault();
    const cells=[...grid.querySelectorAll("[data-availability-cell]")],index=cells.indexOf(cell),column=index%7;
    const target=event.key==="Home"?index-column
      :event.key==="End"?index-column+6
      :event.key==="ArrowLeft"?(column?index-1:index)
      :event.key==="ArrowRight"?(column<6?index+1:index)
      :event.key==="ArrowUp"?index-7:index+7;
    const next=cells[target];if(!next||next===cell)return;
    cells.forEach(item=>item.setAttribute("tabindex","-1"));
    next.setAttribute("tabindex","0");
    availabilityState.focusCell={employeeId:next.dataset.employeeId,weekday:Number(next.dataset.weekday)};
    next.focus();
  });
}
function availabilityEditorModel(cell,{off=false}={}){
  const employee=availabilityEmployee(cell.dataset.employeeId);if(!employee)return null;
  const weekday=Number(cell.dataset.weekday),day=availabilityDay(employee,weekday);
  return {employee,weekday,mode:off||!day?"off":"working",startTime:day?.startTime||"09:00",endTime:day?.endTime||"17:00"};
}
// The chip row is what earns the grid: the endpoint replaces the whole week in one call, so Monday to
// Friday nine to five is one request rather than five.
function availabilityEditorMarkup(model,{wide=false}={}){
  const cls=wide?" wide":"";
  return `<p class="availability-editor-head${cls}">${escape(model.employee.displayName)} · ${escape(AVAILABILITY_WEEKDAYS[model.weekday])}</p>`
    +`<div class="availability-mode${cls}" role="group" aria-label="Working or off">`
    +["working","off"].map(mode=>`<button type="button" data-availability-mode="${mode}" data-testid="availability-mode-${mode}" aria-pressed="${model.mode===mode}">${mode==="working"?"Working":"Off"}</button>`).join("")
    +`</div>`
    +`<div class="availability-times${cls}"${model.mode==="off"?" hidden":""}>`
    +`<label>Starts<input type="time" data-testid="availability-start" data-availability-start value="${escape(model.startTime)}"></label>`
    +`<label>Ends<input type="time" data-testid="availability-end" data-availability-end value="${escape(model.endTime)}"></label></div>`
    +`<fieldset class="availability-apply${cls}"><legend>Also apply to</legend>`
    +AVAILABILITY_WEEKDAYS.map((label,weekday)=>`<label class="availability-chip"><input type="checkbox" data-availability-day="${weekday}" ${weekday===model.weekday?"checked disabled":""}><span aria-hidden="true">${AVAILABILITY_WEEKDAYS_SHORT[weekday]}</span><span class="visually-hidden">${escape(label)}</span></label>`).join("")
    +`</fieldset>`
    // Clearing the last day does not block the groomer: the API reads an empty week as "no
    // restriction". Saying so here is the difference between an intended change and a surprise.
    +`<p class="availability-clear-note${cls}" data-availability-clear-note hidden>With no days set, Pawsh stops restricting when ${escape(model.employee.displayName)} can be booked.</p>`;
}
function availabilityEditorRead(scope,model){
  const days=new Set([model.weekday]);
  scope.querySelectorAll("[data-availability-day]").forEach(box=>{if(box.checked)days.add(Number(box.dataset.availabilityDay));});
  return {
    employee:model.employee,weekday:model.weekday,days,
    mode:scope.querySelector('[data-availability-mode][aria-pressed="true"]')?.dataset.availabilityMode||"off",
    startTime:scope.querySelector("[data-availability-start]")?.value||"",
    endTime:scope.querySelector("[data-availability-end]")?.value||""
  };
}
function availabilityRebuildWeek(employee,input){
  const week=new Map((employee.days||[]).map(day=>[Number(day.weekday),{weekday:Number(day.weekday),startTime:day.startTime,endTime:day.endTime}]));
  for(const weekday of input.days){
    if(input.mode==="off")week.delete(weekday);
    else week.set(weekday,{weekday,startTime:input.startTime,endTime:input.endTime});
  }
  return [...week.values()].sort((left,right)=>left.weekday-right.weekday);
}
function availabilityValidate(input){
  if(input.mode==="off")return null;
  if(!input.startTime||!input.endTime)return "Enter both a start and an end time.";
  if(input.startTime>=input.endTime)return "The end time must be later than the start time.";
  return null;
}
function availabilitySaveMessage(error){
  if(error.status===403)return "You do not have permission to change working hours.";
  if(error.status===404)return "That groomer is no longer in this workspace.";
  if(error.status===409)return "These hours were changed somewhere else. Close this and open the day again.";
  if(error.status)return error.message;
  // The same phrasing as the location switcher, because it is the same failure and the operator has
  // already learned what it means there.
  return "Could not save working hours. Check your connection and try again.";
}
async function saveAvailabilityWeek(input){
  const problem=availabilityValidate(input);
  if(problem)throw new Error(problem);
  const employee=input.employee,path=`/api/employees/${encodeURIComponent(employee.id)}/working-hours`;
  // appointmentLimit is deliberately never sent: Pawsh's database enforces one appointment per
  // groomer at a time, and the endpoint refuses any other value.
  await api(path,{method:"PUT",body:JSON.stringify({hours:availabilityRebuildWeek(employee,input)})});
  // A destructive whole-week replace with no concurrency token, so what was sent is not evidence of
  // what is stored. Re-reading is the only thing standing between two managers and a week neither of
  // them saved.
  const stored=await api(path);
  employee.days=(Array.isArray(stored)?stored:[]).map(day=>({weekday:Number(day.weekday),startTime:day.startTime,endTime:day.endTime,appointmentLimit:1}));
}
function availabilityAfterSave(input){
  availabilityState.focusCell={employeeId:input.employee.id,weekday:input.weekday};
  availabilityState.restoreFocus=true;
  renderAvailability();
  const cell=availabilityCellAt(input.employee.id,input.weekday);
  if(cell){cell.classList.add("is-saved");setTimeout(()=>cell.classList.remove("is-saved"),1200);}
  toast(`${input.employee.displayName}'s working hours saved.`);
}
function availabilityBindEditorControls(scope,model,{onSave,onCancel}){
  const times=scope.querySelector(".availability-times"),clearNote=scope.querySelector("[data-availability-clear-note]");
  const sync=()=>{
    const input=availabilityEditorRead(scope,model);
    times.hidden=input.mode==="off";
    clearNote.hidden=input.mode!=="off"||availabilityRebuildWeek(model.employee,input).length>0;
  };
  scope.querySelectorAll("[data-availability-mode]").forEach(button=>button.addEventListener("click",()=>{
    scope.querySelectorAll("[data-availability-mode]").forEach(other=>other.setAttribute("aria-pressed",String(other===button)));
    sync();
    if(button.dataset.availabilityMode==="working")scope.querySelector("[data-availability-start]")?.focus();
  }));
  scope.querySelectorAll("[data-availability-day]").forEach(box=>box.addEventListener("change",sync));
  scope.querySelectorAll('input[type="time"]').forEach(input=>input.addEventListener("keydown",event=>{
    if(event.key!=="Enter")return;
    event.preventDefault();onSave();
  }));
  scope.querySelector("[data-availability-cancel]")?.addEventListener("click",onCancel);
  scope.querySelector("[data-availability-save]")?.addEventListener("click",onSave);
  sync();
}
// The grid scrolls inside its own container, so an absolutely positioned popover would be clipped by
// it. Fixed coordinates recomputed against the cell keep the editor anchored and whole.
function positionAvailabilityEditor(popover,cell){
  const rect=cell.getBoundingClientRect(),width=popover.offsetWidth,height=popover.offsetHeight;
  const left=Math.max(8,Math.min(rect.left,globalThis.innerWidth-width-8));
  const below=rect.bottom+4;
  popover.style.left=`${Math.round(left)}px`;
  popover.style.top=`${Math.round(below+height>globalThis.innerHeight-8?Math.max(8,rect.top-height-4):below)}px`;
}
function closeAvailabilityEditor({restoreFocus=false}={}){
  availabilityEditorTeardown?.();
  availabilityEditorTeardown=null;
  const popover=$("#availability-root .availability-editor");if(!popover)return;
  const cell=popover.closest("[data-availability-cell]");
  popover.remove();
  if(restoreFocus)cell?.focus();
}
function openAvailabilityEditor(cell,{off=false}={}){
  const model=availabilityEditorModel(cell,{off});if(!model)return;
  if(availabilityCompact?.matches)return openAvailabilityDialog(model);
  closeAvailabilityEditor();
  const popover=document.createElement("div");
  popover.className="availability-editor";
  popover.dataset.testid="availability-editor";
  popover.innerHTML=availabilityEditorMarkup(model)
    +`<p class="error" data-availability-error role="alert"></p>`
    +`<div class="availability-editor-actions"><button type="button" class="secondary compact" data-availability-cancel>Cancel</button>`
    +`<button type="button" class="primary compact" data-testid="availability-save" data-availability-save>Save</button></div>`;
  cell.append(popover);
  positionAvailabilityEditor(popover,cell);
  const error=popover.querySelector("[data-availability-error]");
  const save=async()=>{
    const input=availabilityEditorRead(popover,model),button=popover.querySelector("[data-availability-save]");
    const problem=availabilityValidate(input);
    error.textContent="";
    if(problem){error.textContent=problem;return;}
    // Disabled and aria-busy, but the label stays put: a button that renames itself mid-save moves
    // the very thing the operator is looking at.
    button.disabled=true;button.setAttribute("aria-busy","true");
    try{
      await saveAvailabilityWeek(input);
      closeAvailabilityEditor();
      availabilityAfterSave(input);
    }catch(failure){
      // The editor stays open with every value intact, because retyping a week in order to retry a
      // failure is the real cost of closing it.
      error.textContent=availabilitySaveMessage(failure);
      button.disabled=false;button.removeAttribute("aria-busy");
    }
  };
  availabilityBindEditorControls(popover,model,{onSave:()=>runDetached(save),onCancel:()=>closeAvailabilityEditor({restoreFocus:true})});
  popover.addEventListener("keydown",event=>{
    if(event.key==="Escape"){event.preventDefault();event.stopPropagation();closeAvailabilityEditor({restoreFocus:true});return;}
    if(event.key!=="Tab")return;
    const focusable=[...popover.querySelectorAll("button:not(:disabled),input:not(:disabled)")];
    if(!focusable.length)return;
    const first=focusable[0],last=focusable.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  });
  popover.addEventListener("click",event=>event.stopPropagation());
  const reposition=()=>positionAvailabilityEditor(popover,cell);
  const dismiss=event=>{if(!popover.contains(event.target))closeAvailabilityEditor();};
  const scroller=cell.closest(".availability-grid-wrap");
  globalThis.addEventListener("resize",reposition);
  scroller?.addEventListener("scroll",reposition);
  document.addEventListener("click",dismiss);
  availabilityEditorTeardown=()=>{
    globalThis.removeEventListener("resize",reposition);
    scroller?.removeEventListener("scroll",reposition);
    document.removeEventListener("click",dismiss);
  };
  (model.mode==="off"?popover.querySelector("[data-availability-mode]"):popover.querySelector("[data-availability-start]"))?.focus();
}
// Below the grid breakpoint the same model, the same save and the same copy go into the shared
// dialog. Only the container changes.
function openAvailabilityDialog(model){
  openModal("Working hours",availabilityEditorMarkup(model,{wide:true}),async()=>{
    const input=availabilityEditorRead($("#modal-fields"),model);
    await saveAvailabilityWeek(input);
    return ()=>availabilityAfterSave(input);
  },{submitLabel:"Save"});
  availabilityBindEditorControls($("#modal-fields"),model,{
    onSave:()=>$("#modal-form").requestSubmit(),
    onCancel:()=>$("#modal").close()
  });
}

// --- Tab 4 closures ------------------------------------------------------
function availabilityClosureMessage(error){
  if(error.status===403)return "You do not have permission to change closed days.";
  if(error.status===404)return "That location is no longer available.";
  if(error.status)return error.message;
  return "Could not update closed days. Check your connection and try again.";
}
function bindAvailabilityClosures(root){
  const grid=root.querySelector(".availability-closed-grid");if(!grid)return;
  grid.querySelectorAll("[data-availability-day]:not([data-availability-static])").forEach(day=>{
    day.addEventListener("click",()=>runDetached(()=>toggleAvailabilityClosure(day.dataset.availabilityDay)));
  });
  grid.addEventListener("keydown",event=>{
    const day=event.target.closest?.("[data-availability-day]");if(!day)return;
    const localDate=day.dataset.availabilityDay;
    if(event.key==="Enter"||event.key===" "||event.key==="Spacebar"){
      if(day.hasAttribute("data-availability-static"))return;
      event.preventDefault();runDetached(()=>toggleAvailabilityClosure(localDate));return;
    }
    if(["PageUp","PageDown"].includes(event.key)){
      event.preventDefault();shiftAvailabilityMonth(event.key==="PageUp"?-1:1,{focusDay:Number(localDate.slice(8,10))});return;
    }
    if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key))return;
    event.preventDefault();
    const days=[...grid.querySelectorAll("[data-availability-day]")],index=days.indexOf(day);
    const column=(dateAt(`${availabilityMonth()}-01`).getUTCDay()+index)%7;
    const target=event.key==="Home"?index-column
      :event.key==="End"?index-column+6
      :event.key==="ArrowLeft"?index-1
      :event.key==="ArrowRight"?index+1
      :event.key==="ArrowUp"?index-7:index+7;
    const next=days[Math.max(0,Math.min(days.length-1,target))];if(!next||next===day)return;
    days.forEach(item=>item.setAttribute("tabindex","-1"));
    next.setAttribute("tabindex","0");
    availabilityState.focusDate=next.dataset.availabilityDay;
    next.focus();
  });
}
async function toggleAvailabilityClosure(localDate){
  if(!allowed("settings.manage"))return;
  const entry=availabilityState.closures?.get(localDate)||{closed:false,reason:null,booked:0};
  // Re-opening never asks. Closing over live bookings does, and it is still allowed: Pawsh does not
  // quietly strand an appointment, and it does not quietly overrule the operator either.
  if(!entry.closed&&entry.booked>0){
    const count=entry.booked;
    openModal("Close the salon",
      `<p class="wide">${count} appointment${count===1?" is":"s are"} already booked on ${escape(availabilityDateLabel(localDate))}. Closing the salon does not cancel ${count===1?"it":"them"} — you will need to move or cancel each one.</p>`,
      async()=>{const message=await applyAvailabilityClosure(localDate,true,{announce:false});return ()=>toast(message);},
      {submitLabel:"Close the salon",cancelLabel:"Keep it open"});
    return;
  }
  await applyAvailabilityClosure(localDate,!entry.closed);
}
async function applyAvailabilityClosure(localDate,closed,{announce=true}={}){
  const closures=availabilityState.closures,locationId=availabilityLocationId();
  if(!closures||!locationId)return null;
  const month=availabilityMonth(),previous=closures.get(localDate)||{closed:false,reason:null,booked:0};
  closures.set(localDate,{...previous,closed});
  availabilityState.focusDate=localDate;availabilityState.restoreFocus=true;
  renderAvailability();
  const closedDates=[...closures].filter(([date,entry])=>entry.closed&&date.startsWith(`${month}-`)).map(([date])=>date).sort();
  try{
    const result=await api(`/api/locations/${encodeURIComponent(locationId)}/closure-days`,{method:"PUT",body:JSON.stringify({month,closedDates})});
    // The save bumps the location's optimistic-concurrency token. Leaving the stale one in state
    // would fail the operator's very next booking with STALE_LOCATION_SETTINGS and no visible cause.
    const version=Number(result?.locationVersion);
    if(state.me?.business&&Number.isFinite(version))state.me.business.locationVersion=version;
    // The server normalises and echoes the month back, so the grid reconciles against what was
    // stored rather than against what this screen happened to send.
    const saved=new Set(result?.closedDates||closedDates);
    for(const [date,value] of closures)if(date.startsWith(`${month}-`))closures.set(date,{...value,closed:saved.has(date)});
    for(const date of saved)if(!closures.has(date))closures.set(date,{closed:true,reason:null,booked:0});
    availabilityState.restoreFocus=true;
    renderAvailability();
    const message=`${availabilityLocationName()} is ${closed?"closed":"open"} on ${availabilityDateLabel(localDate)}.`;
    if(announce)toast(message);
    return message;
  }catch(error){
    closures.set(localDate,previous);
    availabilityState.restoreFocus=true;
    renderAvailability();
    if(!announce)throw new Error(availabilityClosureMessage(error));
    toast(availabilityClosureMessage(error));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settings → Tax & payments
//
// Three tabs over one payload. Every write answers with that same whole-screen read, so there is
// one parser and one render path: a save applies what the server returned rather than patching
// the copy this page happens to be holding. That matters most on the tax tab, where putting a
// rate in force moves three things at once — the rate standing down, the rate taking over, and
// the number invoices snapshot.
//
// What this screen connects is Square, and only Square. Every other processor recorded here is a
// note about how the salon takes payment: there is no OAuth flow, no credential store and no
// tokenization behind those rows, so they carry no connection status, no Connect button and no
// disabled placeholder for one. A control for a state the server has no concept of still asserts
// the concept exists and is merely pending. Square is the exception because it is the one row
// that has somewhere to connect to, and its panel says so rather than implying the rest could.
// ---------------------------------------------------------------------------
const TAXPAY_TABS=[["method","Method"],["tax","Tax"],["processors","Card processors"]];
// Mirrors the column default on `card_processors`, so the tips dialog opens on the values a new
// processor was created with even if the payload ever arrives without them.
const TAXPAY_FALLBACK_TIPS=[15,18,20];
// What the payment method select offered before it was configurable. Reading the configured
// methods needs settings.manage, which somebody taking payment may not have, so that refusal
// falls back to the four settlement types the ledger records rather than to an empty select.
const CHECKOUT_FALLBACK_METHODS=[["cash","Cash"],["external_card","External card"],["check","Check"],["other","Other"]];
// The value the payment-method select carries for "take this on the card terminal". Not a
// settlement type and not a payment method id - it names a capture route, and the server decides
// what the resulting payment settles as.
const CHECKOUT_TERMINAL_METHOD="terminal-capture";
// The sentinel for "settle this from what the client already has on account". A sentinel beside
// the terminal's rather than a configured method id, because there is no `payment_methods` row for
// credit and `payment_methods.settlement_type` is deliberately not widened to admit one - so the
// payment body sends `client_credit` directly and `choice.settlementType` has nothing to read.
const CHECKOUT_CREDIT_METHOD="client-credit";
/**
 * Whether this checkout may offer credit.
 *
 * THREE CAUSES, ONE OUTCOME, AND THEY ARE NOT COLLAPSED. `null` means no client was named or the
 * read failed; `0` means this client has nothing. All three produce no option - there is nothing
 * to offer in any of them - but the null is the same silence `ensureCheckoutPaymentOptions` keeps
 * about a configuration it was not allowed to read, and it is not a claim that the balance is zero.
 */
function checkoutOffersCredit(co){
  return typeof co.creditAvailableMinor==="number"&&co.creditAvailableMinor>0;
}
const TAXPAY_TIP_BASE_MISSING="The visit total has not loaded, so a percentage cannot be worked out. Enter the tip amount instead.";
const taxPayState=tenantCache(()=>({tab:"method",data:null,error:null,loading:false,restoreFocus:null,feesProcessorId:null,terminalProcessorId:null}));
// Checkout's own, narrower read. `/api/settings/tax-payments` is gated on settings.manage and
// stays that way; a cashier holds checkout.perform instead, so the method list and the tip
// presets come from an endpoint scoped to that and carrying nothing else.
const checkoutOptions=tenantCache(()=>({data:null,unavailable:false}));
let terminalDrawerOrigin=null;
const PENCIL_ICON=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="M14 6l4 4"/></svg>`;
const TRASH_ICON=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>`;
const ARROW_UP_ICON=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;
const ARROW_DOWN_ICON=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>`;

function taxPayMethods(){return taxPayState.data?.paymentMethods||[];}
function taxPayRates(){return taxPayState.data?.taxRates||[];}
function taxPayProcessors(){return taxPayState.data?.cardProcessors||[];}
function taxPayProcessor(id){return taxPayProcessors().find(processor=>processor.id===id)||null;}
function taxPayDefaultProcessor(){const list=taxPayProcessors();return list.find(processor=>processor.isDefault)||list[0]||null;}
function taxPaySettlementTypes(){return taxPayState.data?.settlementTypes||[];}
function taxPaySettlementLabel(value){return taxPaySettlementTypes().find(type=>type.value===value)?.label||String(value||"");}
function taxPayProviderLabel(value){return (taxPayState.data?.cardProcessorProviders||[]).find(provider=>provider.value===value)?.label||String(value||"");}
// Basis points read back as the percent an operator typed, without the trailing zeros that make
// 8.00% look like a different number from 8%.
function taxPayPercent(basisPoints){return (Number(basisPoints||0)/100).toFixed(2).replace(/\.?0+$/,"")||"0";}

async function loadTaxPayments(){
  taxPayState.loading=true;taxPayState.error=null;
  try{taxPayState.data=await api("/api/settings/tax-payments");}
  catch(error){taxPayState.error=error;}
  finally{taxPayState.loading=false;}
}
function ensureTaxPaymentsData(){
  if(!allowed("settings.manage"))return;
  if(taxPayState.data||taxPayState.loading||taxPayState.error)return;
  runDetached(async()=>{await loadTaxPayments();renderTaxPayments();});
}
/**
 * The single parser every write goes through.
 *
 * The rate in force is mirrored onto `businesses.tax_rate_basis_points` in the same transaction,
 * and that column is what Business settings and every new invoice read. Applying it here keeps
 * the session's copy from showing the rate that was standing a moment ago.
 */
function applyTaxPayments(payload){
  if(!payload||!Array.isArray(payload.paymentMethods))return payload;
  taxPayState.data=payload;taxPayState.error=null;
  // Enabling a method, reordering the list or changing a processor's tips all change what
  // checkout should offer, so the cashier-facing copy is dropped rather than left to go stale.
  checkoutOptions.data=null;checkoutOptions.unavailable=false;
  checkoutTerminal.data=null;checkoutTerminal.unavailable=false;
  const basisPoints=Number(payload.taxRateBasisPoints);
  if(state.me?.business&&Number.isFinite(basisPoints))state.me.business.taxRateBasisPoints=basisPoints;
  return payload;
}
async function taxPayWrite(path,options){return applyTaxPayments(await api(path,options));}
// Writes made straight from a control rather than from a dialog. A refusal is the server's answer
// to something the operator can see, so it is announced and the screen is re-read: the toggle or
// radio that moved has to go back to what the server actually holds.
function taxPayAction(key,path,options,message,{rerender=true}={}){
  return runOnce(key,async()=>{
    try{
      await taxPayWrite(path,options);
      if(rerender)renderTaxPayments();
      if(message)toast(message);
    }catch(error){
      toast(error.message);
      await loadTaxPayments();renderTaxPayments();
    }
  });
}

function taxPayTabsMarkup(){
  return `<div class="settings-tabs" role="tablist" aria-label="Tax and payments" data-testid="taxpay-tabs">`
    +TAXPAY_TABS.map(([id,label])=>{
      const active=taxPayState.tab===id;
      return `<button type="button" role="tab" id="taxpay-tab-${id}" class="settings-tab${active?" active":""}" data-taxpay-tab="${id}" data-testid="taxpay-tab-${id}" aria-selected="${active}" aria-controls="taxpay-panel" tabindex="${active?0:-1}">${escape(label)}</button>`;
    }).join("")
    +`</div>`;
}
function taxPayErrorMarkup(){
  const error=taxPayState.error;
  const message=error?.status===403?"You do not have permission to view this."
    :error?.status?error.message
    :"Could not load tax and payment settings. Check your connection and try again.";
  return `<div class="availability-error" data-testid="taxpay-error"><h4>This could not load</h4><p>${escape(message)}</p>`
    +`<button type="button" class="secondary compact" data-taxpay-retry>Try again</button></div>`;
}
function taxPayLoadingRow(columns){return `<tr><td class="empty" colspan="${columns}">Loading…</td></tr>`;}
function taxPayTableMarkup(testid,head,body){
  return `<div class="taxpay-table-wrap" data-allow-horizontal-scroll>`
    +`<table class="taxpay-table" data-testid="${testid}">${head}<tbody>${body}</tbody></table></div>`;
}
function taxPayFootMarkup(attribute,label,testid){
  return `<div class="taxpay-foot"><button type="button" class="primary compact" ${attribute} data-testid="${testid}">${escape(label)}</button></div>`;
}

// --- Tab 1: Method -------------------------------------------------------
// Position moves through two arrows rather than a drag. The only drag in Pawsh is the calendar,
// where a pointer-only affordance is backed by a menu action; a drag here would have no keyboard
// equivalent at all, and the list is short enough that a step at a time is faster anyway.
function taxPayMethodRow(method,index,total){
  const name=escape(method.name);
  // The same name again, safe to put inside a quoted attribute. A salon types this.
  const nameAttr=escapeAttr(method.name);
  const type=escape(taxPaySettlementLabel(method.settlementType));
  const arrow=(direction,label,icon,blocked)=>`<button type="button" class="icon-button" data-taxpay-move="${direction}" data-taxpay-method="${method.id}" aria-label="Move ${nameAttr} ${label}" title="Move ${label}"${blocked?` disabled aria-disabled="true"`:""}>${icon}</button>`;
  // A built-in method is editable, just not renamable or retypable. The processor it settles
  // through is exactly what the Processor column is for, and Card is the row that most needs to
  // say it. Deletion stays off: recorded payments display through these four.
  const edit=`<button type="button" class="icon-button" data-taxpay-method-edit="${method.id}" aria-label="Edit ${nameAttr}" title="Edit">${PENCIL_ICON}</button>`;
  const actions=method.builtIn?edit
    :edit+`<button type="button" class="icon-button danger" data-taxpay-method-delete="${method.id}" aria-label="Delete ${nameAttr}" title="Delete">${TRASH_ICON}</button>`;
  return `<tr data-taxpay-method-row="${method.id}">`
    +`<td><span class="taxpay-order">${arrow("up","up",ARROW_UP_ICON,index===0)}${arrow("down","down",ARROW_DOWN_ICON,index===total-1)}</span></td>`
    +`<td><span class="taxpay-name"><strong>${name}</strong>${method.builtIn?`<small>Built-in</small>`:""}<small class="taxpay-inline-type">${type}</small></span></td>`
    +`<td class="taxpay-col-type">${type}</td>`
    +`<td class="taxpay-col-processor">${method.processorLabel?escape(method.processorLabel):"—"}</td>`
    +`<td><label class="taxpay-switch"><span class="visually-hidden">Enable ${name}</span><input type="checkbox" role="switch" class="pref-toggle" data-taxpay-method-enabled="${method.id}"${method.enabled?" checked":""}></label></td>`
    +`<td><span class="taxpay-actions">${actions}</span></td></tr>`;
}
function taxPayMethodMarkup(){
  if(taxPayState.error)return taxPayErrorMarkup();
  const note=`<p class="fine settings-note">Every method records as one of the four settlement types the ledger can tell apart. The name is what staff pick at checkout; the settlement type is what reporting counts. Enabled methods appear at checkout in this order.</p>`;
  const methods=taxPayMethods();
  if(taxPayState.data&&!methods.length){
    return `<div class="taxpay-empty" data-testid="taxpay-method-empty"><p>No payment method is recorded. Add the ones staff pick at checkout.</p>`
      +`<button type="button" class="primary compact" data-taxpay-method-add data-testid="taxpay-method-add">+ Add method</button></div>`+note;
  }
  const head=`<thead><tr><th scope="col">Order</th><th scope="col">Method</th>`
    +`<th scope="col" class="taxpay-col-type">Records as</th><th scope="col" class="taxpay-col-processor">Processor</th>`
    +`<th scope="col">Enabled</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>`;
  const body=taxPayState.data?methods.map((method,index)=>taxPayMethodRow(method,index,methods.length)).join(""):taxPayLoadingRow(6);
  return taxPayTableMarkup("taxpay-method-table",head,body)
    +taxPayFootMarkup("data-taxpay-method-add","+ Add method","taxpay-method-add")+note;
}

// --- Tab 2: Tax ----------------------------------------------------------
// "In force" is a radio group, not a switch per row: exactly one is the native semantic, and it
// is the same rule the partial unique index on `tax_rates` enforces. A checkbox would let the
// screen express two rates in force, or none, neither of which the server will store.
function taxPayRateRow(rate){
  const name=escape(rate.name);
  const nameAttr=escapeAttr(rate.name);
  // Editing is offered on every rate, the one in force included. Without it a typo in the live
  // rate would be unfixable here: it cannot be deleted, and a replacement cannot take its name.
  const edit=`<button type="button" class="icon-button" data-taxpay-rate-edit="${rate.id}" aria-label="Edit ${nameAttr}" title="Edit">${PENCIL_ICON}</button>`;
  const remove=rate.isDefault
    ?`<button type="button" class="icon-button danger" disabled aria-disabled="true" aria-label="Delete ${nameAttr}" title="The rate in force cannot be deleted. Put another rate in force first.">${TRASH_ICON}</button>`
    :`<button type="button" class="icon-button danger" data-taxpay-rate-delete="${rate.id}" aria-label="Delete ${nameAttr}" title="Delete">${TRASH_ICON}</button>`;
  return `<tr data-taxpay-rate-row="${rate.id}"${rate.isDefault?' class="is-inforce"':""}>`
    +`<td><strong>${name}</strong></td>`
    +`<td class="taxpay-rate">${escape(taxPayPercent(rate.rateBasisPoints))}%</td>`
    +`<td><label class="taxpay-inforce"><input type="radio" name="taxpay-inforce" value="${rate.id}" data-taxpay-inforce="${rate.id}"${rate.isDefault?" checked":""}>`
    +`<span class="visually-hidden">Charge ${name} on new invoices</span>`
    +(rate.isDefault?`<span class="taxpay-inforce-mark" aria-hidden="true">In force</span>`:"")
    +`</label></td>`
    +`<td><span class="taxpay-actions">${edit}${remove}</span></td></tr>`;
}
function taxPayTaxMarkup(){
  if(taxPayState.error)return taxPayErrorMarkup();
  const note=`<p class="fine settings-note">Changing which rate is in force applies to invoices created from then on. Invoices already created keep the rate they were charged at.</p>`;
  const rates=taxPayRates();
  if(taxPayState.data&&!rates.length){
    return `<div class="taxpay-empty" data-testid="taxpay-rate-empty"><p>No tax rate is recorded. Add the rate this salon charges so invoices can say what they charged and why.</p>`
      +`<button type="button" class="primary compact" data-taxpay-rate-add data-testid="taxpay-rate-add">+ Add rate</button></div>`+note;
  }
  const head=`<thead><tr><th scope="col">Rate</th><th scope="col">Rate %</th><th scope="col">In force</th>`
    +`<th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>`;
  const body=taxPayState.data?rates.map(taxPayRateRow).join(""):taxPayLoadingRow(4);
  return taxPayTableMarkup("taxpay-rate-table",head,body)
    +taxPayFootMarkup("data-taxpay-rate-add","+ Add rate","taxpay-rate-add")+note;
}

// --- Tab 3: Card processors ----------------------------------------------
function taxPayProcessorRow(processor){
  const label=escape(taxPayProviderLabel(processor.provider));
  const labelAttr=escapeAttr(taxPayProviderLabel(processor.provider));
  const action=(attribute,text)=>`<button type="button" class="secondary compact" data-taxpay-${attribute}="${processor.id}" aria-label="${escapeAttr(text)} for ${labelAttr}">${escape(text)}</button>`;
  const remove=`<button type="button" class="icon-button danger" data-taxpay-processor-delete="${processor.id}" aria-label="Delete ${labelAttr}" title="Delete">${TRASH_ICON}</button>`;
  return `<li class="taxpay-processor" data-taxpay-processor-row="${processor.id}">`
    +`<span class="taxpay-processor-name">${label}${processor.isDefault?`<span class="taxpay-default-mark">Default</span>`:""}</span>`
    +`<label class="taxpay-location">Location label`
    // Free text, never a selector. Pawsh does not talk to the provider, so it cannot enumerate
    // the locations that provider knows about; offering a list would imply it had asked.
    +`<input type="text" maxlength="80" autocomplete="off" placeholder="Front desk" value="${escapeAttr(processor.locationLabel||"")}" data-taxpay-location="${processor.id}"></label>`
    +`<span class="taxpay-processor-actions">${action("terminals","Terminal setting")}${action("fees","Processing fees")}${action("tips","Default tips")}${remove}</span>`
    +`</li>`;
}
function taxPayProcessorMarkup(){
  if(taxPayState.error)return taxPayErrorMarkup();
  if(!taxPayState.data)return `<p class="availability-note is-quiet" aria-busy="true">Loading card processors…</p>`;
  const processors=taxPayProcessors();
  if(!processors.length){
    return `<div class="taxpay-empty" data-testid="taxpay-processor-empty"><p>No card processor recorded. Add the one your salon uses so receipts and reporting can name it.</p>`
      +`<button type="button" class="primary compact" data-taxpay-processor-add data-testid="taxpay-processor-add">+ Add processor</button></div>`
      +squareConnectionMarkup();
  }
  const current=taxPayDefaultProcessor();
  // The choice is over the processors this salon has recorded, named from the closed provider set.
  // Offering a provider with no row behind it would make this control a hidden create.
  const chooser=`<label class="taxpay-default-processor">Default processor`
    +`<select data-taxpay-default-processor data-testid="taxpay-default-processor">`
    +processors.map(processor=>`<option value="${processor.id}"${processor.id===current?.id?" selected":""}>${escape(taxPayProviderLabel(processor.provider))}</option>`).join("")
    +`</select></label>`
    +`<p class="fine">The processor an external-card payment is assumed to settle through, for receipts and reporting.</p>`;
  return chooser
    +`<ul class="taxpay-processor-list">${processors.map(taxPayProcessorRow).join("")}</ul>`
    +taxPayFootMarkup("data-taxpay-processor-add","+ Add processor","taxpay-processor-add")
    // Square is the one processor Pawsh can actually talk to, so its state sits under the list
    // rather than inside a row: connecting is an account-level act, and the terminals it produces
    // are live sessions rather than inventory.
    +squareConnectionMarkup();
}

function taxPayMarkup(){
  if(!allowed("settings.manage")){
    return `<article class="settings-panel taxpay-panel" id="taxpay-panel"><p>Managing tax and payment settings needs the Settings permission.</p></article>`;
  }
  const body=taxPayState.tab==="tax"?taxPayTaxMarkup()
    :taxPayState.tab==="processors"?taxPayProcessorMarkup()
    :taxPayMethodMarkup();
  return taxPayTabsMarkup()
    // One line of provenance, in ordinary muted type. A banner, an icon or a tint would make the
    // absence of an integration look like a warning about one.
    // Written when this screen was configuration only, and it stopped being true on the day the
    // Square panel below it shipped: Pawsh starts, reconciles and refunds card payments on a
    // connected Square terminal. It stays honest about the other three, which are a note for
    // receipts and reporting and nothing Pawsh can talk to.
    +(taxPayState.tab==="processors"?`<p class="taxpay-provenance" data-testid="taxpay-provenance">This records how your salon takes card payments. Pawsh takes them itself only on a connected Square terminal; the rest are recorded so receipts and reporting can name them.</p>`:"")
    +`<article class="settings-panel taxpay-panel" id="taxpay-panel" role="tabpanel" aria-labelledby="taxpay-tab-${taxPayState.tab}">${body}</article>`;
}
// renderSettingsCategory replaces the whole settings pane on every nav click, so this re-reads
// module state rather than assuming anything about what is currently on screen.
function renderTaxPayments(){
  const root=$("#taxpay-root");if(!root)return;
  root.innerHTML=taxPayMarkup();
  bindTaxPayments(root);
  if(taxPayState.tab==="processors")ensureSquareState();
  const wanted=taxPayState.restoreFocus;taxPayState.restoreFocus=null;
  if(!wanted)return;
  const target=root.querySelector(wanted);
  if(target)target.focus();
}
function selectTaxPayTab(tab,{focus=true}={}){
  if(taxPayState.tab===tab)return;
  taxPayState.tab=tab;renderTaxPayments();
  if(focus)$(`#taxpay-tab-${tab}`)?.focus();
}
function taxPayMoveMethod(id,direction){
  const ids=taxPayMethods().map(method=>method.id);
  const index=ids.indexOf(id),target=index+direction;
  if(index<0||target<0||target>=ids.length)return;
  [ids[index],ids[target]]=[ids[target],ids[index]];
  // The arrow that was pressed may become the disabled end-of-list one, so the fallback is this
  // row's other arrow: a keyboard reorder must not drop focus back to the document.
  taxPayState.restoreFocus=`[data-taxpay-move][data-taxpay-method="${id}"]:not([disabled])`;
  return taxPayAction("taxpay:order","/api/settings/payment-methods/order",
    {method:"PUT",body:JSON.stringify({ids})},"Checkout order updated");
}
function taxPayConfirmDelete({title,body,confirmLabel,path,message}){
  openStackedDialog({title,body:`${body}<p class="error" role="alert"></p>`,confirmLabel,dismissLabel:"Cancel",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      try{await taxPayWrite(path,{method:"DELETE"});}
      catch(problem){error.textContent=problem.message;return false;}
      renderTaxPayments();toast(message);return true;
    }});
}
function bindTaxPayments(root){
  // Arrows move focus, Enter and Space commit. Activating on focus would fetch nothing here, but
  // it would still swap the panel out from under someone simply passing along the bar.
  root.querySelector('[role="tablist"]')?.addEventListener("keydown",event=>{
    const buttons=[...root.querySelectorAll("[data-taxpay-tab]")],index=buttons.indexOf(document.activeElement);
    if(index<0)return;
    if(event.key==="Enter"||event.key===" "||event.key==="Spacebar"){event.preventDefault();selectTaxPayTab(buttons[index].dataset.taxpayTab);return;}
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();
    const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
    buttons[next]?.focus();
  });
  root.querySelectorAll("[data-taxpay-tab]").forEach(button=>button.addEventListener("click",()=>selectTaxPayTab(button.dataset.taxpayTab,{focus:false})));
  root.querySelector("[data-taxpay-retry]")?.addEventListener("click",()=>{
    taxPayState.error=null;taxPayState.data=null;renderTaxPayments();ensureTaxPaymentsData();
  });
  root.querySelectorAll("[data-taxpay-move]").forEach(button=>button.addEventListener("click",()=>{
    runDetached(()=>taxPayMoveMethod(button.dataset.taxpayMethod,button.dataset.taxpayMove==="up"?-1:1));
  }));
  root.querySelectorAll("[data-taxpay-method-enabled]").forEach(input=>input.addEventListener("change",()=>{
    const id=input.dataset.taxpayMethodEnabled,enabled=input.checked;
    runDetached(()=>taxPayAction(`taxpay:method:${id}`,`/api/settings/payment-methods/${id}`,
      {method:"PATCH",body:JSON.stringify({enabled})},enabled?"Method offered at checkout":"Method hidden at checkout"));
  }));
  root.querySelectorAll("[data-taxpay-method-add]").forEach(button=>button.addEventListener("click",()=>openTaxPayMethodEditor(null)));
  root.querySelectorAll("[data-taxpay-method-edit]").forEach(button=>button.addEventListener("click",()=>openTaxPayMethodEditor(button.dataset.taxpayMethodEdit)));
  root.querySelectorAll("[data-taxpay-method-delete]").forEach(button=>button.addEventListener("click",()=>{
    const method=taxPayMethods().find(item=>item.id===button.dataset.taxpayMethodDelete);
    taxPayConfirmDelete({title:`Delete ${method?.name??"this method"}?`,
      body:"<p>It stops being offered at checkout. Payments already recorded keep the settlement type they were taken as.</p>",
      confirmLabel:"Delete",path:`/api/settings/payment-methods/${button.dataset.taxpayMethodDelete}`,message:"Payment method deleted"});
  }));
  root.querySelectorAll("[data-taxpay-inforce]").forEach(input=>input.addEventListener("change",()=>{
    if(!input.checked)return;
    const id=input.dataset.taxpayInforce;
    runDetached(()=>taxPayAction(`taxpay:rate:${id}`,`/api/settings/tax-rates/${id}`,
      {method:"PATCH",body:JSON.stringify({isDefault:true})},"Rate in force updated"));
  }));
  root.querySelectorAll("[data-taxpay-rate-add]").forEach(button=>button.addEventListener("click",()=>openTaxPayRateEditor(null)));
  root.querySelectorAll("[data-taxpay-rate-edit]").forEach(button=>button.addEventListener("click",()=>openTaxPayRateEditor(button.dataset.taxpayRateEdit)));
  root.querySelectorAll("[data-taxpay-rate-delete]").forEach(button=>button.addEventListener("click",()=>{
    const rate=taxPayRates().find(item=>item.id===button.dataset.taxpayRateDelete);
    taxPayConfirmDelete({title:`Delete ${rate?.name??"this rate"}?`,
      body:"<p>Invoices already created keep the rate they were charged at.</p>",
      confirmLabel:"Delete",path:`/api/settings/tax-rates/${button.dataset.taxpayRateDelete}`,message:"Tax rate deleted"});
  }));
  root.querySelectorAll("[data-taxpay-processor-add]").forEach(button=>button.addEventListener("click",openTaxPayProcessorEditor));
  root.querySelectorAll("[data-taxpay-processor-delete]").forEach(button=>button.addEventListener("click",()=>{
    const processor=taxPayProcessor(button.dataset.taxpayProcessorDelete);
    const provider=taxPayProviderLabel(processor?.provider);
    // Deleting the default is allowed: the server hands the default to the processor recorded
    // first rather than refusing, so the copy says what will happen instead of warning it cannot.
    const successor=processor?.isDefault&&taxPayProcessors().length>1
      ?"<p>Another recorded processor becomes the default.</p>":"";
    taxPayConfirmDelete({title:`Delete ${provider}?`,
      body:`<p>The processing fees and terminals recorded under it go too. No payment was ever taken through this record, so nothing already in the ledger changes.</p>${successor}`,
      confirmLabel:"Delete",path:`/api/settings/card-processors/${button.dataset.taxpayProcessorDelete}`,
      message:"Card processor deleted"});
  }));
  root.querySelector("[data-taxpay-default-processor]")?.addEventListener("change",event=>{
    const id=event.target.value;
    taxPayState.restoreFocus="[data-taxpay-default-processor]";
    runDetached(()=>taxPayAction(`taxpay:processor:${id}`,`/api/settings/card-processors/${id}`,
      {method:"PATCH",body:JSON.stringify({isDefault:true})},"Default processor updated"));
  });
  // Saved on commit, and deliberately without a re-render: change fires as focus leaves, so
  // redrawing the list here would pull the ground out from under whatever was tabbed to next.
  root.querySelectorAll("[data-taxpay-location]").forEach(input=>input.addEventListener("change",()=>{
    const id=input.dataset.taxpayLocation;
    runDetached(()=>taxPayAction(`taxpay:processor:${id}`,`/api/settings/card-processors/${id}`,
      {method:"PATCH",body:JSON.stringify({locationLabel:input.value.trim()||null})},"Processor location saved",{rerender:false}));
  }));
  root.querySelectorAll("[data-taxpay-terminals]").forEach(button=>button.addEventListener("click",event=>
    openTerminalDrawer(button.dataset.taxpayTerminals,event.currentTarget)));
  root.querySelectorAll("[data-taxpay-fees]").forEach(button=>button.addEventListener("click",()=>openTaxPayFees(button.dataset.taxpayFees)));
  root.querySelectorAll("[data-taxpay-tips]").forEach(button=>button.addEventListener("click",()=>openTaxPayTips(button.dataset.taxpayTips)));
  bindSquare(root);
}

// --- Editors -------------------------------------------------------------
function openTaxPayMethodEditor(methodId){
  const method=methodId?taxPayMethods().find(item=>item.id===methodId):null;
  const types=taxPaySettlementTypes().map(type=>[type.value,type.label]);
  // A built-in method IS one of the four settlement types, and recorded payments display through
  // it, so its name and type are read-only text rather than inputs that look editable and fail.
  const identity=method?.builtIn
    ?`<p class="wide fine"><strong>${escape(method.name)}</strong> records as <strong>${escape(taxPaySettlementLabel(method.settlementType))}</strong>. A built-in method's name and settlement type are fixed, because payments already recorded display through them.</p>`
    :field("name","Method name","text",`required maxlength="80" value="${escapeAttr(method?.name||"")}"`)
      +select("settlementType","Records as",types,false,method?.settlementType||"");
  openModal(method?"Edit payment method":"New payment method",
    identity+field("processorLabel","Processor (optional)","text",`maxlength="60" value="${escapeAttr(method?.processorLabel||"")}"`,true),
    async form=>{
      const values=Object.fromEntries(form);
      const processorLabel=String(values.processorLabel||"").trim()||null;
      const payload=method?.builtIn?{processorLabel}
        :{name:String(values.name||"").trim(),settlementType:String(values.settlementType||""),processorLabel};
      await taxPayWrite(method?`/api/settings/payment-methods/${method.id}`:"/api/settings/payment-methods",
        method?{method:"PATCH",body:JSON.stringify(payload)}
          :{method:"POST",body:JSON.stringify({...payload,enabled:true})});
      return ()=>renderTaxPayments();
    });
}
function openTaxPayRateEditor(rateId){
  const rate=rateId?taxPayRates().find(item=>item.id===rateId):null;
  // Percent in, basis points out — the same convention as the tax field in Business settings,
  // because it is ultimately the same number.
  openModal(rate?"Edit tax rate":"New tax rate",
    field("name","Rate name","text",`required maxlength="80" value="${escapeAttr(rate?.name||"")}"`)
    +field("rate","Rate (%)","number",`required min="0" max="100" step=".01" value="${rate?escape(taxPayPercent(rate.rateBasisPoints)):"0"}"`)
    // Correcting the rate in force moves the number invoices snapshot, which is a different act
    // from correcting one that is standing by, and the operator is told which one they are doing.
    +(rate?.isDefault?`<p class="wide fine">This is the rate in force, so a new percentage is what invoices created from then on will charge. Invoices already created keep the rate they were charged at.</p>`:""),
    async form=>{
      const payload={
        name:String(form.get("name")||"").trim(),
        rateBasisPoints:Math.round(Number(form.get("rate")||0)*100)
      };
      await taxPayWrite(rate?`/api/settings/tax-rates/${rate.id}`:"/api/settings/tax-rates",
        {method:rate?"PATCH":"POST",body:JSON.stringify(payload)});
      return ()=>renderTaxPayments();
    });
}
function openTaxPayProcessorEditor(){
  const providers=(taxPayState.data?.cardProcessorProviders||[]).map(provider=>[provider.value,provider.label]);
  openModal("New card processor",
    select("provider","Processor",providers,false,"")
    +field("locationLabel","Location label (optional)","text",'maxlength="80"')
    +`<p class="wide fine">Recording a processor does not connect Pawsh to it. Nothing here is a key, a token or a pairing code.</p>`,
    async form=>{
      await taxPayWrite("/api/settings/card-processors",{method:"POST",body:JSON.stringify({
        provider:String(form.get("provider")||""),
        locationLabel:String(form.get("locationLabel")||"").trim()||null
      })});
      return ()=>renderTaxPayments();
    });
}

// --- Processing fees -----------------------------------------------------
// The shared dialog with its Save hidden: a fee is added or removed the moment it is asked for,
// so there is nothing left for a Save button to commit.
function taxPayFeesBody(processorId){
  const processor=taxPayProcessor(processorId);
  const fees=processor?.fees||[];
  const note=`<p class="fine settings-note">Recorded for your reference. Pawsh does not calculate or deduct processing fees, and they do not change what a client is charged.</p>`;
  const foot=`<div class="taxpay-foot"><button type="button" class="primary compact" data-taxpay-fee-add data-testid="taxpay-fee-add">+ Add fee</button></div>`;
  if(!fees.length){
    return `<div class="wide"><div class="taxpay-empty" data-testid="taxpay-fee-empty"><p>No processing fee recorded for ${escape(taxPayProviderLabel(processor?.provider))}.</p></div>${foot}${note}</div>`;
  }
  const head=`<thead><tr><th scope="col">Fee</th><th scope="col">Rate %</th><th scope="col">Flat</th>`
    +`<th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>`;
  const body=fees.map(fee=>`<tr><td><strong>${escape(fee.name)}</strong></td>`
    +`<td class="taxpay-rate">${escape(taxPayPercent(fee.rateBasisPoints))}%</td>`
    +`<td class="taxpay-rate">${escape(money(fee.centAmountMinor))}</td>`
    +`<td><span class="taxpay-actions"><button type="button" class="icon-button danger" data-taxpay-fee-delete="${fee.id}" aria-label="Delete ${escapeAttr(fee.name)}" title="Delete">${TRASH_ICON}</button></span></td></tr>`).join("");
  return `<div class="wide">${taxPayTableMarkup("taxpay-fee-table",head,body)}${foot}${note}</div>`;
}
function renderTaxPayFees(){
  const host=$("#modal-fields");
  if(!host||!taxPayState.feesProcessorId)return;
  host.innerHTML=taxPayFeesBody(taxPayState.feesProcessorId);
  bindTaxPayFees(host);
}
function bindTaxPayFees(host){
  const processorId=taxPayState.feesProcessorId;
  host.querySelector("[data-taxpay-fee-add]")?.addEventListener("click",()=>{
    openStackedDialog({title:"Add processing fee",
      body:`<label>Fee name<input type="text" name="feeName" maxlength="60" required></label>`
        +`<label>Rate (%)<input type="number" name="feeRate" min="0" max="100" step=".01" value="0"></label>`
        +`<label>Flat amount ($)<input type="number" name="feeFlat" min="0" step=".01" value="0"></label>`
        +`<p class="error" role="alert"></p>`,
      confirmLabel:"Add fee",dismissLabel:"Cancel",
      onConfirm:async body=>{
        const error=body.querySelector(".error");error.textContent="";
        const name=String(body.querySelector('[name="feeName"]').value||"").trim();
        if(!name){error.textContent="Enter a fee name.";return false;}
        try{
          await taxPayWrite(`/api/settings/card-processors/${processorId}/fees`,{method:"POST",body:JSON.stringify({
            name,
            rateBasisPoints:Math.round(Number(body.querySelector('[name="feeRate"]').value||0)*100),
            centAmountMinor:Math.round(Number(body.querySelector('[name="feeFlat"]').value||0)*100)
          })});
        }catch(problem){error.textContent=problem.message;return false;}
        renderTaxPayFees();renderTaxPayments();toast("Processing fee added");return true;
      }});
  });
  host.querySelectorAll("[data-taxpay-fee-delete]").forEach(button=>button.addEventListener("click",()=>{
    runDetached(async()=>{
      try{
        await taxPayWrite(`/api/settings/card-processors/${processorId}/fees/${button.dataset.taxpayFeeDelete}`,{method:"DELETE"});
        renderTaxPayFees();renderTaxPayments();toast("Processing fee removed");
      }catch(error){$("#modal-error").textContent=error.message;}
    });
  }));
}
function openTaxPayFees(processorId){
  const processor=taxPayProcessor(processorId);if(!processor)return;
  taxPayState.feesProcessorId=processorId;
  openModal(`Processing fees — ${taxPayProviderLabel(processor.provider)}`,taxPayFeesBody(processorId),null,{cancelLabel:"Done"});
  bindTaxPayFees($("#modal-fields"));
}

// --- Default tips --------------------------------------------------------
// Written out rather than built with select(), which injects a required "Choose…" empty option.
// A tip preset always has a value, so there is no unset state for that option to represent.
function taxPayTipSelect(index,value){
  const options=Array.from({length:101},(_,percent)=>`<option value="${percent}"${percent===Number(value)?" selected":""}>${percent}%</option>`).join("");
  return `<label>Tip option ${index+1}<select data-testid="field-tip-preset-${index+1}" name="tip${index+1}">${options}</select></label>`;
}
function openTaxPayTips(processorId){
  const processor=taxPayProcessor(processorId);if(!processor)return;
  const tips=Array.isArray(processor.tipPercents)&&processor.tipPercents.length===3?processor.tipPercents:TAXPAY_FALLBACK_TIPS;
  openModal(`Default tips — ${taxPayProviderLabel(processor.provider)}`,
    tips.map((value,index)=>taxPayTipSelect(index,value)).join("")
    +`<p class="wide fine settings-note">These three presets appear at checkout. Staff can still enter any amount.</p>`,
    async form=>{
      await taxPayWrite(`/api/settings/card-processors/${processorId}`,{method:"PATCH",body:JSON.stringify({
        tipPercents:[0,1,2].map(index=>Number(form.get(`tip${index+1}`)||0))
      })});
      return ()=>renderTaxPayments();
    });
}

// --- Terminal drawer -----------------------------------------------------
// An inventory list of the machines on the counter, so staff can tell them apart. Adding one
// pairs nothing: there is no session to open and nothing to send.
/** True when this drawer is for a Square processor that is actually connected. */
function terminalDrawerIsSquare(){
  return taxPayProcessor(taxPayState.terminalProcessorId)?.provider==="square"&&squareConnected();
}
function terminalDrawerBody(){
  const processor=taxPayProcessor(taxPayState.terminalProcessorId);
  // A paired Square device and an inventory row describe the same machine, and showing both would
  // ask a salon to keep two lists of one counter in step by hand. Where Pawsh can see the real
  // pairing, that is the list; the inventory table stays for the three processors it cannot.
  if(terminalDrawerIsSquare()){
    return squareDeviceListMarkup()
      +`<p class="fine settings-note">These are the terminals Pawsh is paired with. Add and pair them under Card processors.</p>`;
  }
  const terminals=processor?.terminals||[];
  // Square reaches this branch whenever it is not connected, and telling a salon that Pawsh does
  // not pair with a terminal is the opposite of what is true for the one processor it does pair
  // with. The sentence names the reason they are looking at an inventory list instead.
  const note=processor?.provider==="square"
    ?`<p class="fine settings-note">Pawsh is not connected to Square, so it cannot show the terminals it is paired with. Connect Square under Card processors. Terminals recorded here only help staff tell devices apart.</p>`
    :`<p class="fine settings-note">Terminals are recorded so staff can tell devices apart. Pawsh does not pair with, or send anything to, a terminal.</p>`;
  if(!terminals.length){
    return `<div class="taxpay-empty" data-testid="taxpay-terminal-empty"><p>No terminal recorded. Add the machines on your counter so staff can tell them apart.</p></div>${note}`;
  }
  const head=`<thead><tr><th scope="col">Terminal</th><th scope="col">Location</th><th scope="col">Device code</th>`
    +`<th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>`;
  const body=terminals.map(terminal=>`<tr><td><strong>${escape(terminal.name)}</strong></td>`
    +`<td>${terminal.locationLabel?escape(terminal.locationLabel):"—"}</td>`
    +`<td>${terminal.deviceCode?escape(terminal.deviceCode):"—"}</td>`
    +`<td><span class="taxpay-actions"><button type="button" class="icon-button danger" data-taxpay-terminal-delete="${terminal.id}" aria-label="Delete ${escapeAttr(terminal.name)}" title="Delete">${TRASH_ICON}</button></span></td></tr>`).join("");
  return taxPayTableMarkup("taxpay-terminal-table",head,body)+note;
}
function renderTerminalDrawer(){
  if(!taxPayState.terminalProcessorId)return;
  const processor=taxPayProcessor(taxPayState.terminalProcessorId);
  // The drawer's accessible name says whose terminals these are; with several processors
  // recorded, "Terminal setting" on its own names nothing anybody can identify.
  $("#terminal-drawer-title").textContent=processor?`Terminal setting — ${taxPayProviderLabel(processor.provider)}`:"Terminal setting";
  $("#terminal-drawer-body").innerHTML=terminalDrawerBody();
  // Render and bind stay together, which is the one thing this drawer was not doing. The Square
  // branch of `terminalDrawerBody()` emits the same device rows the Card processors tab does, and
  // those controls are bound by `bindSquare` - which only ever ran against `#taxpay-root`, a
  // different tree from this top-level dialog, leaving every button in here inert. `bindSquare`
  // reaches for its targets optionally, so calling it on a root that has none is a no-op and the
  // two branches cannot drift apart again.
  bindSquare($("#terminal-drawer-body"));
  // "+ Add terminal" here writes an inventory row, which is not what adding a Square terminal
  // means. Rather than have one button do two different things, it stands down and the Square
  // panel keeps the only control that pairs anything.
  const add=$("#terminal-add");if(add)add.hidden=terminalDrawerIsSquare();
}
function openTerminalDrawer(processorId,origin){
  const drawer=$("#terminal-drawer");if(!drawer||!taxPayProcessor(processorId))return;
  taxPayState.terminalProcessorId=processorId;
  terminalDrawerOrigin=origin||document.activeElement;
  $("#terminal-drawer-status").textContent="";
  renderTerminalDrawer();
  if(!drawer.open)drawer.showModal();
  drawer.querySelector(".drawer-head .close")?.focus();
}
function openTerminalEditor(){
  const processorId=taxPayState.terminalProcessorId;if(!processorId)return;
  openModal("Add terminal",
    field("name","Terminal name","text",'required maxlength="80"')
    +field("locationLabel","Location (optional)","text",'maxlength="80"')
    +field("deviceCode","Device code (optional)","text",'maxlength="40"',true),
    async form=>{
      await taxPayWrite(`/api/settings/card-processors/${processorId}/terminals`,{method:"POST",body:JSON.stringify({
        name:String(form.get("name")||"").trim(),
        locationLabel:String(form.get("locationLabel")||"").trim()||null,
        deviceCode:String(form.get("deviceCode")||"").trim()||null
      })});
      return ()=>{
        renderTerminalDrawer();renderTaxPayments();
        $("#terminal-drawer-status").textContent="Terminal added.";
      };
    });
}
function setupTerminalDrawer(){
  const drawer=$("#terminal-drawer");if(!drawer)return;
  // app.js binds every `.close` in the document to `#modal.close()` at load. This drawer's own
  // close is bound here rather than left to that, which would dismiss the wrong dialog.
  drawer.querySelector(".drawer-head .close")?.addEventListener("click",()=>drawer.close());
  // Clicking the backdrop dismisses it: the click lands on the dialog itself, never on its panel.
  drawer.addEventListener("click",event=>{if(event.target===drawer)drawer.close();});
  drawer.addEventListener("close",()=>{
    // Adding a terminal re-renders the list behind the drawer, so the button that opened it is
    // usually a detached node by the time this runs. The row is found again by processor id, and
    // the captured element is only the fallback for a list that is no longer on screen at all.
    const processorId=taxPayState.terminalProcessorId;
    taxPayState.terminalProcessorId=null;
    $("#terminal-drawer-status").textContent="";
    const target=$(`[data-taxpay-terminals="${processorId}"]`)
      ||(terminalDrawerOrigin?.isConnected?terminalDrawerOrigin:null);
    terminalDrawerOrigin=null;
    target?.focus();
  });
  $("#terminal-add")?.addEventListener("click",openTerminalEditor);
  $("#terminal-drawer-body").addEventListener("click",event=>{
    const button=event.target.closest?.("[data-taxpay-terminal-delete]");
    if(!button)return;
    const processorId=taxPayState.terminalProcessorId;
    runDetached(async()=>{
      try{
        await taxPayWrite(`/api/settings/card-processors/${processorId}/terminals/${button.dataset.taxpayTerminalDelete}`,{method:"DELETE"});
        renderTerminalDrawer();renderTaxPayments();
        $("#terminal-drawer-status").textContent="Terminal removed.";
      }catch(error){$("#terminal-drawer-status").textContent=error.message;}
    });
  });
}

// --- Square terminals ----------------------------------------------------
/**
 * The Square half of Tax & payments, and the capture modal at checkout.
 *
 * WHAT SALON STAFF SEE HAS NO SQUARE IN IT. The owner connected Square, so the settings panel says
 * so plainly. The groomer at the counter chooses "Card terminal", watches a device they named
 * themselves, and is never shown a merchant id, a checkout id or the word Square.
 *
 * NOTHING SAYS PAID BEFORE THE PAYMENT IS REAL. The server computes `settled`, and only a
 * reconciled Square Payment produces it. This file renders a total, a tip figure and a receipt
 * button from that flag alone - there is no client-side optimism and no local guess at a tip,
 * because the tip is a number the customer chooses on the hardware and nobody here knows it until
 * the payment has been read back.
 *
 * THE MODAL WATCHES OUR OWN ROW, NOT SQUARE. Webhooks are the production mechanism. The poll below
 * reads a local endpoint that makes no outbound call, so an open modal costs a database read every
 * couple of seconds and nothing at Square. Reaching Square is recovery, and it happens only when a
 * person presses the button that says so.
 */
const squareState=tenantCache(()=>({data:null,loading:false,error:null,locations:null}));
// Checkout's own narrow read of which terminals it may use, cached like the payment options and
// dropped whenever settings change so a terminal paired in another tab shows up.
const checkoutTerminal=tenantCache(()=>({data:null,unavailable:false}));
const terminalCapture=tenantCache(()=>({checkoutId:null,invoiceId:null,deviceLabel:"",data:null,timer:null,polls:0}));
// Roughly five minutes of two-and-a-half-second polls. A customer who has not tapped by then is
// not going to be rescued by another poll, and the modal says so rather than spinning forever.
const TERMINAL_CAPTURE_MAX_POLLS=120;
const TERMINAL_CAPTURE_INTERVAL_MS=2500;

function squareConnection(){return squareState.data?.connection||null;}
function squareConnected(){return squareConnection()?.status==="connected";}
function squareDevices(){return squareState.data?.devices||[];}

async function loadSquareState(){
  squareState.loading=true;squareState.error=null;
  try{squareState.data=await api("/api/integrations/square");}
  catch(error){squareState.error=error;}
  finally{squareState.loading=false;}
}
function ensureSquareState(){
  if(!allowed("settings.manage"))return;
  if(squareState.data||squareState.loading||squareState.error)return;
  runDetached(async()=>{await loadSquareState();renderTaxPayments();});
}
async function reloadSquareState(){
  await loadSquareState();
  // A terminal paired or removed changes what checkout may offer.
  checkoutTerminal.data=null;checkoutTerminal.unavailable=false;
  renderTaxPayments();
  if(taxPayState.terminalProcessorId)renderTerminalDrawer();
}

/** How long a pairing code has left, in the words a person would use. */
function squarePairWindow(pairBy){
  if(!pairBy)return "";
  const remaining=new Date(pairBy).getTime()-Date.now();
  if(!Number.isFinite(remaining)||remaining<=0)return "";
  const minutes=Math.ceil(remaining/60000);
  return minutes<=1?"Expires in under a minute":`Expires in about ${minutes} minutes`;
}
function squareLocationName(locationId){
  return (state.locations||[]).find(location=>location.id===locationId)?.name||"";
}

function squareDeviceRow(device){
  const label=escape(device.label);
  const labelAttr=escapeAttr(device.label);
  const place=squareLocationName(device.locationId);
  const status=device.pairingStatus;
  const pill=status==="paired"?`<span class="square-pill is-paired">Paired</span>`
    :status==="unpaired"?`<span class="square-pill is-waiting">Waiting to pair</span>`
    :`<span class="square-pill is-expired">Code expired</span>`;
  // The code is shown only while it can still be typed in. The server withholds it once `pair_by`
  // has passed, so there is nothing here to render for a dead code and nothing to mislabel.
  const code=device.pairingCode
    ? `<p class="square-code" data-testid="square-code-${device.id}"><span class="sr-only">Pairing code </span>`
      +`<strong>${escape(device.pairingCode)}</strong>`
      +`<span class="fine">${escape(squarePairWindow(device.pairBy))}</span></p>`
    : "";
  const hint=status==="paired"?`Ready to take payments.`
    :status==="unpaired"?`Type this code into the terminal.`
    :`Get a new code to pair this terminal.`;
  // One detail cell, not two. A row that emits a code and a hint as separate grid children wraps
  // its own actions onto a third line the moment the code is present, which is exactly the row a
  // salon is looking at while somebody waits at the terminal.
  const detail=`<span class="square-device-detail">${code}<span class="fine">${hint}</span></span>`;
  const actions=[
    status==="paired"
      ? `<button type="button" class="secondary compact" data-square-code="${device.id}">Pair again</button>`
      : `<button type="button" class="secondary compact" data-square-code="${device.id}">Get a code</button>`,
    status==="unpaired"
      ? `<button type="button" class="secondary compact" data-square-check="${device.id}">Check pairing</button>`
      : "",
    `<button type="button" class="icon-button danger" data-square-remove="${device.id}" aria-label="Remove ${labelAttr}" title="Remove">${TRASH_ICON}</button>`
  ].join("");
  return `<li class="square-device" data-square-device="${device.id}">`
    +`<span class="square-device-name"><strong>${label}</strong>${place?`<span class="fine">${escape(place)}</span>`:""}</span>`
    +pill+detail
    +`<span class="square-device-actions">${actions}</span></li>`;
}

function squareDeviceListMarkup(){
  const devices=squareDevices();
  if(!devices.length){
    return `<div class="taxpay-empty" data-testid="square-device-empty">`
      +`<p>No terminal paired yet. Add the machine on your counter, then type the code it gives you into the terminal.</p></div>`;
  }
  return `<ul class="square-device-list" data-testid="square-device-list">${devices.map(squareDeviceRow).join("")}</ul>`;
}

/**
 * The connection block on the Card processors tab.
 *
 * Unconfigured says the reason the server gave and offers no button. A connect button that leads
 * nowhere is worse than no button: it makes a deployment problem look like something the salon
 * did wrong.
 */
function squareConnectionMarkup(){
  if(squareState.error){
    return `<section class="square-panel" data-testid="square-panel"><h4>Square terminals</h4>`
      +`<p class="fine">${escape(squareState.error.status===403?"You do not have permission to view this.":squareState.error.message)}</p></section>`;
  }
  if(!squareState.data){
    return `<section class="square-panel" data-testid="square-panel"><h4>Square terminals</h4>`
      +`<p class="availability-note is-quiet" aria-busy="true">Loading…</p></section>`;
  }
  if(!squareState.data.configured){
    return `<section class="square-panel" data-testid="square-panel"><h4>Square terminals</h4>`
      +`<p class="fine" data-testid="square-unconfigured">${escape(squareState.data.reason||"Square is not available on this deployment.")}</p></section>`;
  }
  const connection=squareConnection();
  const head=`<div class="square-head"><h4>Square terminals</h4>`
    +(connection?.status==="connected"?`<span class="square-pill is-paired" data-testid="square-status">Connected</span>`
      :connection?.status==="revoked"?`<span class="square-pill is-expired" data-testid="square-status">Access withdrawn</span>`
      :`<span class="square-pill is-waiting" data-testid="square-status">Not connected</span>`)
    +`</div>`;
  if(!connection||connection.status!=="connected"){
    const reason=connection?.status==="revoked"
      ? `<p class="fine">Square withdrew this connection, so terminals cannot take payments until you connect again.</p>`
      : `<p class="fine">Connect Square to take card payments on a Square terminal. Pawsh never sees or stores a card number.</p>`;
    return `<section class="square-panel" data-testid="square-panel">${head}${reason}`
      +`<div class="square-actions"><button type="button" class="primary compact" data-square-connect data-testid="square-connect">`
      +`${connection?.status==="revoked"?"Reconnect Square":"Connect Square"}</button></div></section>`;
  }
  return `<section class="square-panel" data-testid="square-panel">${head}`
    +`<p class="fine">Merchant ${escape(connection.merchantId)} · ${escape(connection.environment)}</p>`
    +squareDeviceListMarkup()
    +`<div class="square-actions">`
    +`<button type="button" class="primary compact" data-square-device-add data-testid="square-device-add">+ Add terminal</button>`
    +`<button type="button" class="text-button destructive" data-square-disconnect data-testid="square-disconnect">Disconnect Square</button>`
    +`</div></section>`;
}

function bindSquare(root){
  root.querySelector("[data-square-connect]")?.addEventListener("click",()=>runDetached(async()=>{
    const started=await api("/api/integrations/square/connect",{method:"POST"});
    // A full navigation, not a popup: Square's consent screen is the merchant's own login and
    // must be seen in the address bar it belongs to.
    globalThis.location.assign(started.authorizeUrl);
  }));
  root.querySelector("[data-square-disconnect]")?.addEventListener("click",()=>{
    openStackedDialog({
      title:"Disconnect Square?",
      body:"<p>Terminals stop taking payments immediately. Payments already recorded are unchanged.</p>",
      confirmLabel:"Disconnect",
      onConfirm:async()=>{
        try{await api("/api/integrations/square/disconnect",{method:"POST"});await reloadSquareState();toast("Square disconnected");}
        catch(error){toast(error.message);return false;}
      }
    });
  });
  root.querySelector("[data-square-device-add]")?.addEventListener("click",openSquareDeviceEditor);
  root.querySelectorAll("[data-square-code]").forEach(button=>button.addEventListener("click",()=>{
    const device=squareDevices().find(entry=>entry.id===button.dataset.squareCode);
    const issue=async()=>{
      try{
        await api(`/api/integrations/square/devices/${button.dataset.squareCode}/code`,{method:"POST"});
        await reloadSquareState();toast("Pairing code ready");
      }catch(error){toast(error.message);return false;}
    };
    // Re-pairing replaces the pairing, so the terminal stops working until the new code is typed
    // in. That is a thing to be told before it happens, not after.
    if(device?.pairingStatus==="paired"){
      openStackedDialog({
        title:`Pair ${device.label} again?`,
        body:"<p>This terminal stops taking payments until somebody types the new code into it.</p>",
        confirmLabel:"Get a new code",onConfirm:issue
      });
      return;
    }
    runDetached(issue);
  }));
  root.querySelectorAll("[data-square-check]").forEach(button=>button.addEventListener("click",()=>runDetached(async()=>{
    try{
      const device=await api(`/api/integrations/square/devices/${button.dataset.squareCheck}/refresh`,{method:"POST"});
      await reloadSquareState();
      toast(device.pairingStatus==="paired"?"Terminal paired":"Still waiting for the code to be typed in");
    }catch(error){toast(error.message);}
  })));
  root.querySelectorAll("[data-square-remove]").forEach(button=>button.addEventListener("click",()=>{
    const device=squareDevices().find(entry=>entry.id===button.dataset.squareRemove);
    openStackedDialog({
      title:`Remove ${device?.label??"this terminal"}?`,
      body:"<p>It stops being offered at checkout. Payments already taken on it are unchanged.</p>",
      confirmLabel:"Remove",
      onConfirm:async()=>{
        try{
          await api(`/api/integrations/square/devices/${button.dataset.squareRemove}`,{method:"DELETE"});
          await reloadSquareState();toast("Terminal removed");
        }catch(error){toast(error.message);return false;}
      }
    });
  }));
}

/**
 * Naming a terminal.
 *
 * The Square location list is fetched live every time this opens, and never cached: a stale copy
 * of somebody else's locations offers a place that has closed or hides one that opened this
 * morning, and the salon cannot tell which.
 */
function openSquareDeviceEditor(){
  runDetached(async()=>{
    let listing;
    try{listing=await api("/api/integrations/square/locations");}
    catch(error){toast(error.message);return;}
    const usable=listing.locations.filter(location=>location.usable);
    if(!usable.length){
      openStackedDialog({
        title:"No usable Square location",
        body:`<p>None of the locations on this Square account settles in ${escape(listing.currency)}, which is what this salon invoices in.</p>`,
        dismissLabel:"Close"
      });
      return;
    }
    const places=(state.locations||[]).map(location=>[location.id,location.name]);
    openModal("Add terminal",
      field("label","Terminal name","text",'required maxlength="80" placeholder="Front desk"')
      +(places.length>1?select("locationId","Salon location",places,false,state.me?.locationId||""):"")
      +select("squareLocationId","Square location",usable.map(location=>[location.id,location.name||location.id]),true),
      async form=>{
        await api("/api/integrations/square/devices",{method:"POST",body:JSON.stringify({
          label:String(form.get("label")||"").trim(),
          locationId:String(form.get("locationId")||places[0]?.[0]||""),
          squareLocationId:String(form.get("squareLocationId")||"")
        })});
        return {message:"Terminal added",afterClose:()=>runDetached(reloadSquareState)};
      });
  });
}

// --- Taking a payment on a terminal --------------------------------------

async function ensureCheckoutTerminal(){
  if(checkoutTerminal.data||checkoutTerminal.unavailable)return;
  try{checkoutTerminal.data=await api("/api/checkout/terminal");}
  catch{checkoutTerminal.unavailable=true;}
}

function stopTerminalCapturePoll(){
  if(terminalCapture.timer)globalThis.clearTimeout(terminalCapture.timer);
  terminalCapture.timer=null;
}

/**
 * Watches our own row while the customer is at the terminal.
 *
 * A local read with no outbound call, so this costs a database query and nothing at Square. The
 * webhook drain is what moves the row; this is what notices. It stops the moment the checkout is
 * no longer in flight, and gives up with an honest "unknown" rather than polling forever.
 */
function scheduleTerminalCapturePoll(){
  stopTerminalCapturePoll();
  if(!terminalCapture.checkoutId)return;
  if(terminalCapture.polls>=TERMINAL_CAPTURE_MAX_POLLS)return;
  terminalCapture.timer=globalThis.setTimeout(()=>{
    runDetached(async()=>{
      if(!terminalCapture.checkoutId)return;
      terminalCapture.polls+=1;
      try{
        terminalCapture.data=await api(`/api/square/terminal-checkouts/${terminalCapture.checkoutId}`);
      }catch{
        // A read that failed is not an outcome. The screen keeps whatever it last knew.
        scheduleTerminalCapturePoll();return;
      }
      renderTerminalCapture();
      if(terminalCapture.data?.inFlight)scheduleTerminalCapturePoll();
    });
  },TERMINAL_CAPTURE_INTERVAL_MS);
}

function terminalCaptureBody(){
  const data=terminalCapture.data;
  if(!data)return `<p class="availability-note is-quiet" aria-busy="true">Sending to the terminal…</p>`;
  const exhausted=!data.inFlight?false:terminalCapture.polls>=TERMINAL_CAPTURE_MAX_POLLS;
  const label=exhausted?"Unknown":data.label;
  const tone=data.settled?"is-paid":data.needsReview?"is-review"
    :data.inFlight&&!exhausted?"is-waiting":"is-stopped";
  const lines=[];
  if(data.settled){
    // The only place a total and a tip appear, and only once a real payment produced them.
    lines.push(`<div class="square-capture-line"><span>Tip</span><strong data-testid="terminal-capture-tip">${money(data.tipMinor||0)}</strong></div>`);
    lines.push(`<div class="square-capture-line is-total"><span>Paid</span><strong data-testid="terminal-capture-paid">${money(data.paidTotalMinor||0)}</strong></div>`);
  }else{
    lines.push(`<div class="square-capture-line is-total"><span>Amount due</span><strong data-testid="terminal-capture-amount">${money(data.amountMinor)}</strong></div>`);
  }
  const explain=data.settled?`<p class="fine">Paid on the terminal, including the tip the customer chose.</p>`
    :data.needsReview?`<p class="fine" data-testid="terminal-capture-review">The terminal reported something that does not match this invoice, so nothing has been recorded. A manager needs to check this before taking payment again.</p>`
    :exhausted?`<p class="fine">Pawsh has not heard back. Check the terminal, then use Check the terminal below.</p>`
    :data.status==="failed"?`<p class="fine">${escape(data.lastError||"The payment did not go through. Nothing was charged.")}</p>`
    :data.status==="canceled"?`<p class="fine">Nothing was charged. You can start again or take payment another way.</p>`
    :`<p class="fine">Ask the customer to tap, insert or swipe. The terminal asks them for the tip.</p>`;
  return `<p class="square-capture-status ${tone}" data-testid="terminal-capture-status">${escape(label)}</p>`
    +`<p class="square-capture-device" data-testid="terminal-capture-device">${escape(terminalCapture.deviceLabel)}</p>`
    +lines.join("")
    +explain;
}

function renderTerminalCapture(){
  const dialog=$("#terminal-capture");if(!dialog)return;
  $("#terminal-capture-body").innerHTML=terminalCaptureBody();
  const data=terminalCapture.data;
  // The dialog's own name moves with the outcome. Leaving it on "Taking payment" after the money
  // has landed is the kind of small stale label that makes an operator doubt the screen.
  $("#terminal-capture-title").textContent=data?.settled?"Payment taken"
    :data?.needsReview?"Needs review"
    :data&&!data.inFlight?"Payment stopped"
    :"Taking payment";
  const cancel=$("[data-testid=\"terminal-capture-cancel\"]");
  const receipt=$("[data-testid=\"terminal-capture-receipt\"]");
  const refresh=$("[data-testid=\"terminal-capture-refresh\"]");
  cancel.hidden=!data?.inFlight;
  receipt.hidden=!data?.settled;
  refresh.hidden=Boolean(data?.settled);
}

/** Opens the capture modal for a checkout that has just been started, or reopened for review. */
function openTerminalCapture(checkout,deviceLabel){
  const dialog=$("#terminal-capture");if(!dialog)return;
  terminalCapture.checkoutId=checkout.id;
  terminalCapture.invoiceId=checkout.invoiceId;
  terminalCapture.deviceLabel=deviceLabel||"";
  terminalCapture.data=checkout;
  terminalCapture.polls=0;
  renderTerminalCapture();
  if(!dialog.open)dialog.showModal();
  dialog.querySelector(".drawer-head .close")?.focus();
  if(checkout.inFlight)scheduleTerminalCapturePoll();
}

/**
 * What this dialog would cost to close right now, or null when it costs nothing.
 *
 * There is exactly one way into this modal - the checkout that started the payment - so whatever
 * is on screen here is not recoverable once it is gone. That is fine for a settled or cancelled
 * payment, whose outcome is on the receipt and on the invoice. It is not fine while the customer
 * is still at the terminal, and it is not fine for `needs review`, whose instruction to stop and
 * fetch a manager exists nowhere else in the product.
 */
function terminalCaptureCloseWarning(){
  const data=terminalCapture.data;
  if(data?.needsReview)return "This payment needs a manager's review, and this is the only screen that shows it. Close it anyway?";
  if(data?.inFlight)return "The customer may still be paying on the terminal. Pawsh stops watching it if you close this, and this is the only screen that shows it. Close it anyway?";
  return null;
}
/** True when the dialog may close: either nothing is at stake, or the operator said to close it. */
function confirmTerminalCaptureClose(){
  const warning=terminalCaptureCloseWarning();
  return !warning||confirm(warning);
}
function setupTerminalCapture(){
  const dialog=$("#terminal-capture");if(!dialog)return;
  // Every route out of this dialog that is not "Cancel payment" goes through the same question.
  // Cancel payment is the way to actually stop a live charge - it asks the terminal and reconciles
  // - so it is deliberately not guarded here; closing is the one that loses the payment silently.
  const requestClose=()=>{if(confirmTerminalCaptureClose())dialog.close();};
  dialog.querySelector(".drawer-head .close")?.addEventListener("click",requestClose);
  $("[data-testid=\"terminal-capture-close\"]")?.addEventListener("click",requestClose);
  // Escape reaches a <dialog> without touching either button, and it is the likeliest way this
  // gets dismissed by accident. `cancel` is the only event that can still refuse it.
  dialog.addEventListener("cancel",event=>{if(!confirmTerminalCaptureClose())event.preventDefault();});
  dialog.addEventListener("close",()=>{
    stopTerminalCapturePoll();
    terminalCapture.checkoutId=null;terminalCapture.data=null;
    // Not after a session ended: settleUnauthenticated closes this dialog on its way out, and a
    // refresh from here would only be one more 401 against a session that is already gone.
    if(state.me)runDetached(()=>refresh());
  });
  // Recovery, and only when a person asks: this is the one control here that reaches Square.
  $("[data-testid=\"terminal-capture-refresh\"]")?.addEventListener("click",()=>runDetached(async()=>{
    if(!terminalCapture.checkoutId)return;
    try{
      terminalCapture.data=await api(`/api/square/terminal-checkouts/${terminalCapture.checkoutId}/refresh`,{method:"POST"});
      terminalCapture.polls=0;
    }catch(error){
      if(error.data?.checkout)terminalCapture.data=error.data.checkout;
      toast(error.message);
    }
    renderTerminalCapture();
    if(terminalCapture.data?.inFlight)scheduleTerminalCapturePoll();
  }));
  $("[data-testid=\"terminal-capture-cancel\"]")?.addEventListener("click",()=>runDetached(async()=>{
    if(!terminalCapture.checkoutId)return;
    stopTerminalCapturePoll();
    try{
      // Cancelling is a request, not a result: the server asks the terminal, reconciles, and
      // reports whatever actually happened - which may be that the card already went through.
      terminalCapture.data=await api(`/api/square/terminal-checkouts/${terminalCapture.checkoutId}/cancel`,{method:"POST"});
    }catch(error){toast(error.message);}
    renderTerminalCapture();
    if(terminalCapture.data?.inFlight)scheduleTerminalCapturePoll();
  }));
  $("[data-testid=\"terminal-capture-receipt\"]")?.addEventListener("click",()=>runDetached(async()=>{
    const invoiceId=terminalCapture.invoiceId;if(!invoiceId)return;
    const receipt=await api(`/api/invoices/${invoiceId}/receipt`);
    dialog.close();
    setTimeout(()=>showFinancialDocument(receipt),50);
  }));
}

// --- Checkout ------------------------------------------------------------
/**
 * Checkout reads the same settings, quietly.
 *
 * The only endpoint that names the configured payment methods requires settings.manage, which
 * somebody taking payment may not hold. A refusal is therefore not an error to show: checkout
 * keeps the four settlement types it offered before this screen existed, and says nothing about
 * a configuration it was not allowed to read.
 */
async function ensureCheckoutPaymentOptions(){
  if(checkoutOptions.data||checkoutOptions.unavailable)return;
  try{checkoutOptions.data=await api("/api/checkout/payment-options");}
  catch{checkoutOptions.unavailable=true;}
}
function checkoutMethodChoices(){
  const methods=checkoutOptions.data?.paymentMethods;
  // The fallback is for a read that genuinely broke - offline, or an account without
  // checkout.perform - not for ordinary staff, who now have their own door to this list. It
  // keeps the four settlement types the select offered before any of it was configurable, so a
  // failure costs the operator the salon's labels rather than the ability to take payment.
  if(!Array.isArray(methods))return CHECKOUT_FALLBACK_METHODS.map(([value,label])=>({value,label,settlementType:value}));
  return methods.map(method=>({value:method.id,label:method.name,settlementType:method.settlementType}));
}
/**
 * The configured discounts this operator may apply, or null.
 *
 * THREE STATES, AND THE NULL IS THE PERMISSION. `null` means the server withheld the rows because
 * this operator cannot apply one; `[]` means they can and the salon has configured none. The same
 * idiom `tipPercents` uses, and collapsing them would tell a cashier the salon had no discounts
 * when in fact they had no permission.
 */
function checkoutDiscountOptions(){
  const discounts=checkoutOptions.data?.discounts;
  return Array.isArray(discounts)?discounts:null;
}
/**
 * Whether this operator may grant money off at all.
 *
 * Read off `discounts === null` rather than off the session's own permission list, so the picker,
 * the manual field and the write the server will accept cannot disagree. There is no
 * `canApplyDiscounts` flag to read: it would be a pure function of this and two representations of
 * one fact drift.
 *
 * A read that FAILED tells us nothing either way, so that one case falls back to the session's own
 * copy - the same fallback `checkoutMethodChoices` makes, for the same reason: a broken read should
 * cost the operator the salon's configuration, not the ability to do their job.
 */
function checkoutGrantsDiscount(){
  if(!checkoutOptions.data)return allowed("discounts.apply");
  return checkoutDiscountOptions()!==null;
}
// Never null, because it is a policy enum rather than configuration worth withholding, and the
// picker needs it before the operator has chosen anything.
function checkoutStackingMode(){
  return checkoutOptions.data?.stackingMode||"one_per_appointment";
}
function checkoutTipPercents(){
  // null is the server saying this salon has recorded no card processor, which is not three
  // zeroes and not "ask again": there are no configured presets, so none are offered and the
  // preset row does not render at all. A processor always carries exactly three.
  const tips=checkoutOptions.data?.tipPercents;
  return Array.isArray(tips)?tips.map(Number):[];
}
// ---------------------------------------------------------------------------
// Settings → Coupons & discounts
//
// Three tabs over ONE read. `GET /api/settings/discounts` returns the whole screen — the
// discounts, the coupons, the stacking rule and the three closed sets — and every write answers
// with the same shape, so a write is never reconciled into a fragment of state. That is the Tax
// & payments contract, for the same reason: changing the stacking rule changes what every row on
// the screen is allowed to do, so a reply that named only the row the caller touched would be
// telling half the truth.
//
// THE READ AND EVERY WRITE ARE GATED ON `settings.discounts` ALONE. There is no separate view
// key, so the ensure below does not pre-check the permission the way Tax & payments does: the
// server's 403 is what the screen renders, which keeps "you cannot see this" a fact the server
// stated rather than one the client guessed from its own copy of a role.
//
// PER PET IS STRUCTURALLY INERT and the screen says so in the server's words. `appointments.pet_id`
// is a single column, so per-pet and per-appointment produce identical money; the choice is stored
// because it is a statement of intent, and `perPetMultiplier.reason` is how the operator is told
// what it is worth today. Nothing here says "coming soon" — that would promise a roadmap item.
// ---------------------------------------------------------------------------

// Plural, because each tab is a collection. The reference's singular "Discount"/"Coupon" reads as
// a form label — the name of the thing being edited — and these are lists of them.
const DISCOUNT_TABS=[["discount","Discounts"],["coupon","Coupons"],["stacking","Multiple coupons & discounts"]];
// One page of rows. The pager renders only above this, because a pager over a single page is a
// control that answers a question nobody asked.
const DISCOUNTS_PAGE_SIZE=25;
// No I, L, O, 0 or 1. A client reads this off a printed card or hears it over the phone, and the
// ambiguous glyphs are the entire failure mode — a code that cannot be transcribed is a coupon
// that cannot be redeemed.
const COUPON_CODE_ALPHABET="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const COUPON_CODE_LENGTH=8;
// The worked example on the stacking tab. $20 and 10% are chosen deliberately: $10 and 10% give
// $90 whichever order they fold in, which demonstrates nothing about a setting whose whole point
// is that the order changes the total.
const STACKING_EXAMPLE={subtotalMinor:10000,amountMinor:2000,rateBasisPoints:1000};
const STACKING_CASE_NAMES={
  one_per_appointment:"One per appointment",
  amount_first:"Amounts first",
  percentage_first:"Percentages first"
};
// The screen's own words for the three modes. The server names the closed SET — a mode it grows
// later appears here labelled by the server rather than being silently dropped — but "Stack, fixed
// amounts first" does not tell an operator what it will do to a bill, and this control is one a
// salon owner sets once and has to understand from the sentence alone.
const STACKING_OPTION_LABELS={
  one_per_appointment:"One coupon or discount per appointment",
  amount_first:"Apply amounts first, then percentages",
  percentage_first:"Apply percentages first, then amounts"
};
const DISCOUNT_HINT_ORDINARY="Comes off the appointment's subtotal, before tax.";
const DISCOUNT_HINT_FREE="This makes the appointment free.";

const discountsState=tenantCache(()=>({
  tab:"discount",data:null,error:null,loading:false,restoreFocus:null,
  discountPage:1,couponPage:1,editor:null
}));

async function loadDiscounts(){
  discountsState.loading=true;discountsState.error=null;
  try{discountsState.data=await api("/api/settings/discounts");}
  catch(error){discountsState.error=error;}
  finally{discountsState.loading=false;}
}
function ensureDiscountsData(){
  if(discountsState.data||discountsState.loading||discountsState.error)return;
  runDetached(async()=>{await loadDiscounts();renderDiscounts();});
}
function applyDiscountsPayload(payload){
  if(!payload||!Array.isArray(payload.discounts))return payload;
  discountsState.data=payload;discountsState.error=null;
  // Adding, retiring or retuning a discount - and changing the stacking rule - all change what the
  // checkout picker should offer and how many of them it may accept, so the cashier-facing copy is
  // dropped rather than left to go stale. Same reason `applyTaxPayments` drops it.
  checkoutOptions.data=null;checkoutOptions.unavailable=false;
  return payload;
}
async function discountsWrite(path,options){return applyDiscountsPayload(await api(path,options));}
// A write made straight from a control rather than from a dialog. A refusal is the server's answer
// to something the operator can see, so it is announced and the screen re-read: the switch or
// dropdown that moved has to go back to what the server actually holds.
function discountsControlWrite(key,path,options,message){
  return runOnce(key,async()=>{
    try{await discountsWrite(path,options);renderDiscounts();if(message)toast(message);}
    catch(error){toast(error.message);await loadDiscounts();renderDiscounts();}
  });
}

// Everything the screen can change is gated on `settings.discounts`, exactly as the routes are,
// so this is the same test the server will make. It is a named function rather than the call
// inlined at a dozen sites because the read-only rendering below is a real branch the day a
// view-without-edit key exists, and only this line would move.
function discountsEditable(){return allowed("settings.discounts");}
function discountList(){return discountsState.data?.discounts||[];}
function couponList(){return discountsState.data?.coupons||[];}
// The server names the closed set on the settings read. Checkout does not make that read, so the
// fallback has to be presentable rather than a raw enum: sentence-cased, it renders the same
// "Per appointment" the server's own label says, and the two cannot look like different things.
function discountApplyScopeLabel(value){
  const named=(discountsState.data?.applyScopes||[]).find(scope=>scope.value===value)?.label;
  if(named)return named;
  const words=String(value||"").replaceAll("_"," ");
  return words?words[0].toUpperCase()+words.slice(1):"";
}
function discountStackingMode(){return discountsState.data?.stackingMode||"one_per_appointment";}
function discountPerPetReason(){
  const block=discountsState.data?.perPetMultiplier;
  return block&&block.supported===false?String(block.reason||""):"";
}
/**
 * The currency's own symbol, taken from the formatter rather than assumed.
 *
 * The value field's suffix has to move with the mode — currency for an amount, `%` for a
 * percentage — and a hard-coded `$` would be wrong for every salon that is not billing in dollars
 * while `money()` beside it was right.
 */
function currencySymbol(){
  return currencySymbolFor(businessCurrency());
}
function discountValueText(row){
  return row.kind==="percentage"?`${taxPayPercent(row.rateBasisPoints)}%`:money(row.amountMinor);
}
// The value as the editor's own field wants it: dollars for an amount, percent for a percentage.
function discountValueInput(row){
  if(!row)return "";
  return row.kind==="percentage"?taxPayPercent(row.rateBasisPoints)
    :(Number(row.amountMinor||0)/100).toFixed(2);
}

// --- Shell ---------------------------------------------------------------
function discountsTabsMarkup(){
  return `<div class="settings-tabs" role="tablist" aria-label="Coupons and discounts" data-testid="discounts-tabs">`
    +DISCOUNT_TABS.map(([id,label])=>{
      const active=discountsState.tab===id;
      return `<button type="button" role="tab" id="discounts-tab-${id}" class="settings-tab${active?" active":""}" data-discounts-tab="${id}" data-testid="discounts-tab-${id}" aria-selected="${active}" aria-controls="discounts-panel" tabindex="${active?0:-1}">${escape(label)}</button>`;
    }).join("")
    +`</div>`;
}
function discountsErrorMarkup(){
  const error=discountsState.error;
  const message=error?.status===403?"You do not have permission to view this."
    :error?.status?error.message
    :"Could not load coupons and discounts. Check your connection and try again.";
  return `<div class="availability-error" data-testid="discounts-error"><h4>This could not load</h4><p>${escape(message)}</p>`
    +`<button type="button" class="secondary compact" data-discounts-retry data-testid="discounts-retry">Try again</button></div>`;
}
// Said once, at the top, rather than as a tooltip on each of the controls that are missing. A
// screen that has quietly dropped its Add button and its row menus owes the reader one sentence
// saying why.
function discountsReadOnlyNote(){
  return discountsEditable()?""
    :`<p class="fine settings-note" data-testid="discounts-read-only">You can see what this salon offers. Changing it needs the Settings permission.</p>`;
}
function discountsPanelHead(kind,heading,blurb){
  // Above the table, never in a `.taxpay-foot`. These tables paginate, and a foot button lands
  // under the pager where nobody looks for the thing that adds a row.
  const add=discountsEditable()
    ?`<button type="button" class="primary compact" data-${kind}-add data-testid="${kind}-add">+ Add ${kind}</button>`:"";
  return `<div class="panel-head"><div><h4>${escape(heading)}</h4><p class="fine">${escape(blurb)}</p></div>${add}</div>`;
}
function discountsPageSlice(rows,kind){
  const pages=Math.max(1,Math.ceil(rows.length/DISCOUNTS_PAGE_SIZE));
  const page=Math.min(Math.max(1,kind==="coupon"?discountsState.couponPage:discountsState.discountPage),pages);
  return {page,pages,visible:rows.slice((page-1)*DISCOUNTS_PAGE_SIZE,page*DISCOUNTS_PAGE_SIZE)};
}
function discountsPagerMarkup(kind,total,page,pages){
  if(total<=DISCOUNTS_PAGE_SIZE)return "";
  const first=(page-1)*DISCOUNTS_PAGE_SIZE+1,last=Math.min(page*DISCOUNTS_PAGE_SIZE,total);
  const noun=kind==="coupon"?"coupon":"discount";
  return `<div class="directory-pagination">`
    +`<span role="status">${first}–${last} of ${total} ${noun}${total===1?"":"s"}</span>`
    +pagerNavMarkup({idPrefix:`${kind}-pager`,label:`${kind==="coupon"?"Coupon":"Discount"} pages`,
      inner:pagerPageButtons(page,pages,`data-${kind}-page`)})
    +`</div>`;
}
// The switch is rendered for a reader who cannot throw it, disabled and titled, rather than
// omitted: whether a discount is live is a fact about the salon, and a row that simply did not say
// would be hiding it. The row MENUS are omitted instead, because every item in one mutates.
function discountsActiveCell(kind,row,name){
  const locked=discountsEditable()?"":"Changing this needs the Settings permission.";
  return `<td><label class="taxpay-switch"><span class="visually-hidden">Active: ${escape(name)}</span>`
    +`<input type="checkbox" role="switch" class="pref-toggle" data-${kind}-enabled="${escapeAttr(row.id)}" data-testid="${kind}-enabled"`
    +`${row.active!==false?" checked":""}${locked?` disabled aria-disabled="true" title="${escapeAttr(locked)}"`:""}></label></td>`;
}
function discountsRowMenuMarkup(kind,id,name){
  if(!discountsEditable())return "";
  const nameAttr=escapeAttr(name);
  const item=(action,label)=>`<button type="button" class="row-menu-item" data-${kind}-${action}="${escapeAttr(id)}" data-testid="${kind}-${action}">${label}</button>`;
  return `<details class="row-menu roles-menu"><summary class="row-menu-trigger" aria-expanded="false" data-testid="${kind}-row-actions" aria-label="Actions for ${nameAttr}"><span aria-hidden="true">⋯</span></summary>`
    +`<div class="row-menu-list" role="group" aria-label="Actions for ${nameAttr}">`
    +item("edit","Edit")+item("duplicate","Duplicate")+item("delete","Delete")
    +`</div></details>`;
}

// --- Tab 1: Discounts ----------------------------------------------------
const DISCOUNT_EMPTY_COPY="No discount is set up. A discount is a standing reduction staff can apply at checkout: a percentage or a fixed amount, off the appointment or off each pet.";
function discountTableRow(row){
  const value=discountValueText(row);
  // A PERCENTAGE SHOWS NO SECOND LINE. "Per appointment" under "10%" is a fact that changes no
  // arithmetic — 10% of the bill is 10% of the bill however many pets it covers — so reading it
  // back would be telling the operator something that is not true of the money.
  const scope=row.kind==="percentage"?"":`<small>${escape(discountApplyScopeLabel(row.applyScope))}</small>`;
  return `<tr data-testid="discount-row" data-discount-row="${escapeAttr(row.id)}" data-discount-name="${escapeAttr(row.name)}">`
    +`<td><span class="taxpay-name"><strong>${escape(row.name)}</strong>`
    +`<small class="taxpay-inline-type">${escape(value)}</small></span></td>`
    +`<td><span class="taxpay-name"><strong>${escape(value)}</strong>${scope}</span></td>`
    +discountsActiveCell("discount",row,row.name)
    +`<td class="roles-actions">${discountsRowMenuMarkup("discount",row.id,row.name)}</td></tr>`;
}
function discountTabMarkup(){
  if(discountsState.error)return discountsErrorMarkup();
  const head=discountsPanelHead("discount","Discounts","A standing reduction staff can apply at checkout.");
  const rows=discountList();
  // The distinction between a discount and a coupon is stated nowhere else in the product, so the
  // empty state is where a salon owner finds out which of the two they came here to make.
  if(discountsState.data&&!rows.length){
    return head+`<div class="taxpay-empty" data-testid="discount-empty"><p>${escape(DISCOUNT_EMPTY_COPY)}</p></div>`;
  }
  const columns=`<thead><tr><th scope="col">Name</th><th scope="col">Discount</th>`
    +`<th scope="col">Active</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>`;
  const {page,pages,visible}=discountsPageSlice(rows,"discount");
  // Loading is a row INSIDE the rendered table, so the headers are on screen from the first frame
  // and the panel does not change height when the rows arrive.
  const body=discountsState.data?visible.map(discountTableRow).join(""):taxPayLoadingRow(4);
  return head+taxPayTableMarkup("discount-table",columns,body)
    +discountsPagerMarkup("discount",rows.length,page,pages);
}

// --- Tab 2: Coupons ------------------------------------------------------
const COUPON_EMPTY_COPY="No coupon is set up. A coupon is a code a client gives you at checkout. Unlike a discount it can expire, run out, or be restricted to new clients.";
/**
 * A civil date in the column's own shorthand: `1 Jan`, and `1 Jan 2027` when the year is not this
 * one. Parsed as UTC and formatted as UTC, because `starts_on` and `ends_on` are civil dates the
 * server compares as civil dates — letting the browser's zone touch them is how a coupon starts a
 * day early in California.
 */
function couponShortDate(value){
  const text=String(value||"").slice(0,10);
  const parts=text.split("-").map(Number);
  if(parts.length!==3||parts.some(part=>!Number.isFinite(part)))return text;
  const sameYear=parts[0]===new Date().getFullYear();
  return new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",day:"numeric",month:"short",
    ...(sameYear?{}:{year:"numeric"})}).format(new Date(Date.UTC(parts[0],parts[1]-1,parts[2])));
}
/**
 * The day set as one token, or nothing at all.
 *
 * Seven days is not a restriction, so it produces no token rather than a token saying every day.
 * A run of FOUR or more contracts to a range; three stays spelled out, because `Mon–Wed` saves one
 * character over `Mon, Tue, Wed` and costs the reader a rule to apply.
 */
function couponWeekdayToken(weekdays){
  if(!Array.isArray(weekdays)||!weekdays.length||weekdays.length>=7)return "";
  const days=[...new Set(weekdays.map(Number))].filter(day=>day>=0&&day<=6).sort((first,second)=>first-second);
  if(!days.length)return "";
  const key=days.join(",");
  if(key==="1,2,3,4,5")return "Weekdays";
  if(key==="0,6")return "Weekends";
  const contiguous=days.every((day,index)=>index===0||day===days[index-1]+1);
  if(contiguous&&days.length>=4)return `${AVAILABILITY_WEEKDAYS_SHORT[days[0]]}–${AVAILABILITY_WEEKDAYS_SHORT[days[days.length-1]]}`;
  return days.map(day=>AVAILABILITY_WEEKDAYS_SHORT[day]).join(", ");
}
/**
 * Every limitation on a coupon, as short tokens in one fixed order.
 *
 * Tokens rather than prose, and no `+2` overflow count: an overflow would put part of a row's
 * truth inside a `title` attribute to buy vertical space this table is not short of.
 */
function couponLimitTokens(coupon){
  const tokens=[];
  const start=coupon.startsOn,end=coupon.endsOn;
  if(start&&end)tokens.push(`${couponShortDate(start)} – ${couponShortDate(end)}`);
  else if(start)tokens.push(`From ${couponShortDate(start)}`);
  else if(end)tokens.push(`Until ${couponShortDate(end)}`);
  if(coupon.maxRedemptionsPerClient)tokens.push(`${coupon.maxRedemptionsPerClient} per client`);
  if(coupon.maxRedemptions)tokens.push(`${coupon.maxRedemptions} total`);
  if(coupon.newClientsOnly)tokens.push("New clients");
  const days=couponWeekdayToken(coupon.weekdays);
  if(days)tokens.push(days);
  return tokens;
}
function couponLimitsCell(coupon){
  const tokens=couponLimitTokens(coupon);
  if(!tokens.length){
    return `<td data-testid="coupon-limits-cell"><span aria-hidden="true">—</span>`
      +`<span class="visually-hidden">No limitations</span></td>`;
  }
  return `<td data-testid="coupon-limits-cell"><span class="coupon-limits-cell">`
    +tokens.map(token=>`<span class="staff-chip">${escape(token)}</span>`).join("")+`</span></td>`;
}
// The name the receipt will use. `nameSnapshot` is `coupon.name ?? coupon.code` on the server, so
// an unnamed coupon is called by its code here too rather than by a placeholder the invoice will
// then contradict.
function couponDisplayName(coupon){return coupon.name||coupon.code;}
function couponTableRow(coupon){
  const name=couponDisplayName(coupon);
  const value=discountValueText(coupon);
  const code=escape(coupon.code);
  const redeemed=Number(coupon.redeemedCount)||0;
  return `<tr data-testid="coupon-row" data-coupon-row="${escapeAttr(coupon.id)}" data-coupon-code="${escapeAttr(coupon.code)}">`
    +`<td><span class="taxpay-name"><strong>${escape(name)}</strong>`
    +`<small class="taxpay-inline-type">${code} · ${escape(value)}${redeemed?` · ${redeemed} redeemed`:""}</small></span></td>`
    +`<td class="coupon-col-code"><span class="coupon-code">${code}</span></td>`
    +`<td class="coupon-col-discount"><span class="taxpay-name"><strong>${escape(value)}</strong>`
    +(coupon.kind==="percentage"?"":`<small>${escape(discountApplyScopeLabel(coupon.applyScope))}</small>`)
    +`</span></td>`
    +`<td class="coupon-col-redeemed">${redeemed}</td>`
    +couponLimitsCell(coupon)
    +discountsActiveCell("coupon",coupon,name)
    +`<td class="roles-actions">${discountsRowMenuMarkup("coupon",coupon.id,name)}</td></tr>`;
}
function couponTabMarkup(){
  if(discountsState.error)return discountsErrorMarkup();
  const head=discountsPanelHead("coupon","Coupons","A code a client gives you at checkout.");
  const rows=couponList();
  if(discountsState.data&&!rows.length){
    return head+`<div class="taxpay-empty" data-testid="coupon-empty"><p>${escape(COUPON_EMPTY_COPY)}</p></div>`;
  }
  // "Redeemed", not "Redeemed count": the column IS a count, and saying so twice is a header that
  // describes its own datatype.
  const columns=`<thead><tr><th scope="col">Name</th><th scope="col" class="coupon-col-code">Code</th>`
    +`<th scope="col" class="coupon-col-discount">Discount</th>`
    +`<th scope="col" class="coupon-col-redeemed">Redeemed</th>`
    +`<th scope="col">Limitations</th>`
    +`<th scope="col">Active</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>`;
  const {page,pages,visible}=discountsPageSlice(rows,"coupon");
  const body=discountsState.data?visible.map(couponTableRow).join(""):taxPayLoadingRow(7);
  return head+taxPayTableMarkup("coupon-table",columns,body)
    +discountsPagerMarkup("coupon",rows.length,page,pages);
}

// --- Tab 3: Multiple coupons & discounts ---------------------------------
/**
 * The example fold, compounding off the running base exactly as `applyDiscounts` does on the
 * server. Derived rather than written down, so the illustration cannot drift away from the
 * arithmetic it is illustrating.
 */
/**
 * Where a line sits in the fold, given the salon's stacking rule.
 *
 * `one_per_appointment` gives everything one rank, so the sort is a no-op and the operator's own
 * order stands - which is all that is needed, because at most one line can be there.
 */
function stackingRank(kind,mode){
  if(mode==="amount_first")return kind==="amount"?0:1;
  if(mode==="percentage_first")return kind==="percentage"?0:1;
  return 0;
}
/**
 * Applies discount lines to a subtotal, compounding each off what the previous ones left.
 *
 * MIRRORS `applyDiscounts` in packages/domain/src/money.ts, which is the authority - the server
 * recomputes every amount and this never sends one. It exists so the browser can SHOW the
 * arithmetic before the operator commits to it: $100 with $20 and 10% is $72 or $70 depending on
 * a setting, and a running total that disagreed with the invoice would be worse than none.
 *
 * The two callers are the stacking tab's worked example and the checkout picker, and they share
 * this rather than each carrying their own copy of a rule that can change.
 *
 * `Array.prototype.sort` is stable, so lines of equal rank keep the order they were given - the
 * same tie-break the server takes from `appliedDiscountIds`.
 */
function foldDiscounts(subtotalMinor,lines,stackingMode){
  const subtotal=Math.max(0,Number(subtotalMinor)||0);
  const ranked=lines.map((line,index)=>({line,index}))
    .sort((first,second)=>stackingRank(first.line.kind,stackingMode)-stackingRank(second.line.kind,stackingMode));
  let base=subtotal;
  const applied=[];
  for(const {line,index} of ranked){
    // A fixed amount larger than what is left CLAMPS; it is not an error. A percentage is a share
    // of what remains and so can never pass it. Both are why `discountMinor <= subtotal` holds by
    // construction here exactly as it does on the server.
    const taken=line.kind==="amount"
      ?Math.min(base,Math.max(0,Number(line.amountMinor)||0)*(Number(line.units)||1))
      :Math.round(base*(Number(line.rateBasisPoints)||0)/10000);
    base-=taken;
    applied.push({index,kind:line.kind,appliedMinor:taken,remainingMinor:base});
  }
  // The DIFFERENCE the fold made, never a separate sum of rounded steps, so no drift between the
  // steps shown and the total shown is representable.
  return {subtotal,discountMinor:subtotal-base,total:base,applied};
}
// The worked example's two lines, as the fold wants them.
function stackingExampleLines(){
  return [{kind:"amount",amountMinor:STACKING_EXAMPLE.amountMinor},
    {kind:"percentage",rateBasisPoints:STACKING_EXAMPLE.rateBasisPoints}];
}
function stackingCaseDetail(mode){
  const amount=money(STACKING_EXAMPLE.amountMinor);
  const percent=`${taxPayPercent(STACKING_EXAMPLE.rateBasisPoints)}%`;
  const subtotal=STACKING_EXAMPLE.subtotalMinor;
  const [amountLine,percentLine]=stackingExampleLines();
  if(mode==="one_per_appointment"){
    return {steps:"Staff apply one only",
      result:`${money(foldDiscounts(subtotal,[amountLine],mode).total)} or `
        +`${money(foldDiscounts(subtotal,[percentLine],mode).total)}`};
  }
  // The ORDER is the fold's, not this function's: passing both lines and letting `stackingRank`
  // sort them is what makes the example a demonstration of the rule rather than a restatement of
  // it that could disagree.
  const fold=foldDiscounts(subtotal,stackingExampleLines(),mode);
  const [first,second]=fold.applied;
  const opening=first.kind==="amount"
    ?`${money(subtotal)} − ${amount} = ${money(first.remainingMinor)}`
    :`${percent} off = ${money(first.remainingMinor)}`;
  return {steps:`${opening}, then ${second.kind==="amount"?`− ${amount}`:`${percent} off`}`,
    result:money(fold.total)};
}
/**
 * All three outcomes at once, with the chosen one marked.
 *
 * One naked dropdown cannot answer "what will my customer be charged", and showing only the
 * selected case would confirm a choice rather than help somebody make one — the operator is
 * deciding between three, so all three are on screen with their totals.
 */
function stackingExampleMarkup(current){
  const modes=(discountsState.data?.stackingModes||[]).map(mode=>mode.value)
    .filter(value=>STACKING_CASE_NAMES[value]);
  return `<div class="stacking-example" data-testid="stacking-example">`
    +`<p class="stacking-example-head"><strong>On a ${escape(money(STACKING_EXAMPLE.subtotalMinor))} appointment `
    +`with a ${escape(money(STACKING_EXAMPLE.amountMinor))} discount and a `
    +`${escape(taxPayPercent(STACKING_EXAMPLE.rateBasisPoints))}% discount</strong></p>`
    +modes.map(mode=>{
      const selected=mode===current,detail=stackingCaseDetail(mode);
      // Marked in words as well as in treatment: "Selected" survives a screen where the tint and
      // the rule are not distinguishable.
      return `<div class="stacking-case${selected?" is-selected":""}"${selected?` aria-current="true"`:""} data-stacking-case="${mode}">`
        +`<span class="stacking-case-name">${escape(STACKING_CASE_NAMES[mode])}`
        +(selected?`<span class="stacking-case-mark">Selected</span>`:"")+`</span>`
        +`<span class="stacking-case-steps">${escape(detail.steps)}</span>`
        +`<strong class="stacking-case-total">${escape(detail.result)}</strong></div>`;
    }).join("")
    +`</div>`;
}
function stackingTabMarkup(){
  if(discountsState.error)return discountsErrorMarkup();
  if(!discountsState.data)return `<p class="availability-note is-quiet" aria-busy="true">Loading…</p>`;
  const current=discountStackingMode();
  const options=(discountsState.data.stackingModes||[]).map(mode=>
    `<option value="${escapeAttr(mode.value)}"${mode.value===current?" selected":""}>`
    +`${escape(STACKING_OPTION_LABELS[mode.value]||mode.label)}</option>`).join("");
  return `<p>When more than one coupon or discount lands on the same appointment, this decides the order they come off in. `
    +`The order changes the total, because a percentage taken after an amount is a percentage of a smaller number.</p>`
    +`<label class="stacking-mode">Multiple coupons &amp; discounts`
    +`<select data-stacking-select data-testid="stacking-select"${discountsEditable()?"":` disabled aria-disabled="true" title="${escapeAttr("Changing this needs the Settings permission.")}"`}>${options}</select></label>`
    +stackingExampleMarkup(current)
    +`<p class="fine settings-note">This applies to appointments checked out from now on. Invoices already created keep the total they were charged.</p>`;
}

// --- Render --------------------------------------------------------------
function discountsMarkup(){
  const body=discountsState.tab==="coupon"?couponTabMarkup()
    :discountsState.tab==="stacking"?stackingTabMarkup()
    :discountTabMarkup();
  return discountsTabsMarkup()
    +`<article class="settings-panel discounts-panel" id="discounts-panel" role="tabpanel" aria-labelledby="discounts-tab-${discountsState.tab}">`
    +discountsReadOnlyNote()+body+`</article>`;
}
// renderSettingsCategory replaces the whole settings pane on every nav click, so this re-reads
// module state rather than assuming anything about what is currently on screen. A write re-renders
// too, which is also how a refused switch goes back to what the server holds; `restoreFocus` is
// what stops that from dropping focus to the document.
function renderDiscounts(){
  const root=$("#discounts-root");if(!root)return;
  root.innerHTML=discountsMarkup();
  bindDiscounts(root);
  const wanted=discountsState.restoreFocus;discountsState.restoreFocus=null;
  if(wanted)root.querySelector(wanted)?.focus();
}
function selectDiscountsTab(tab,{focus=true}={}){
  if(discountsState.tab===tab)return;
  discountsState.tab=tab;renderDiscounts();
  if(focus)$(`#discounts-tab-${tab}`)?.focus();
}
function selectDiscountsPage(kind,page){
  const rows=kind==="coupon"?couponList():discountList();
  const pages=Math.max(1,Math.ceil(rows.length/DISCOUNTS_PAGE_SIZE));
  const wanted=Math.min(Math.max(1,page),pages);
  if(kind==="coupon")discountsState.couponPage=wanted;else discountsState.discountPage=wanted;
  // The arrow that was pressed may become the disabled end-of-list one, so focus goes to the page
  // button that is now current rather than back to the document.
  discountsState.restoreFocus=`[data-${kind}-page="${wanted}"]`;
  renderDiscounts();
}

// --- The shared value controls -------------------------------------------
/**
 * Mode, value and apply scope — one implementation, used by the discount dialog and the coupon
 * drawer alike, because they are the same three decisions about the same three columns.
 *
 * The SUFFIX AND THE CONSTRAINTS MOVE WITH THE MODE, and the value field's own label moves with
 * them: `Amount` with a currency symbol, `Percentage` with a `%` and a ceiling of 100. The suffix
 * is `aria-hidden` and the label is not, so the swap is announced rather than silently repainted.
 *
 * A typed value SURVIVES the switch and 150 becomes INVALID rather than being clamped to 100.
 * Clamping edits a number the operator typed without telling them; a validation message asks them
 * to decide what they meant.
 */
function discountValueControls(prefix,row){
  const kind=row?.kind==="percentage"?"percentage":"amount";
  const scope=row?.applyScope==="per_pet"?"per_pet":"per_appointment";
  const percentage=kind==="percentage";
  const chip=(name,value,checked,label,testid)=>`<label class="availability-chip">`
    +`<input type="radio" name="${name}" value="${value}"${checked?" checked":""} data-testid="${testid}">`
    +`<span>${escape(label)}</span></label>`;
  const reason=discountPerPetReason();
  return `<div class="wide discount-controls" data-discount-controls="${prefix}">`
    +`<fieldset class="discount-choice"><legend>Discount type</legend>`
    +chip("kind","amount",!percentage,"Fixed amount",`${prefix}-mode-amount`)
    +chip("kind","percentage",percentage,"Percentage",`${prefix}-mode-percentage`)
    +`</fieldset>`
    +`<label class="discount-value"><span data-discount-value-label>${percentage?"Percentage":"Amount"}</span>`
    +`<span class="field-affix">`
    +`<input type="number" name="value" data-testid="field-value" required min="0.01" step="0.01"`
    +`${percentage?' max="100"':""} value="${escapeAttr(discountValueInput(row))}">`
    +`<span class="field-affix-unit" aria-hidden="true" data-discount-value-unit>${escape(percentage?"%":currencySymbol())}</span>`
    +`</span></label>`
    +`<p class="field-hint" data-discount-hint>${escape(DISCOUNT_HINT_ORDINARY)}</p>`
    +`<fieldset class="discount-choice"><legend>Comes off</legend>`
    +chip("applyScope","per_appointment",scope!=="per_pet","Per appointment",`${prefix}-apply-appointment`)
    +chip("applyScope","per_pet",scope==="per_pet","Per pet",`${prefix}-apply-pet`)
    +`</fieldset>`
    // The control ships and the screen states what it is worth today, in the server's own words.
    // Not "coming soon": that would name a roadmap item nobody has committed to.
    +(reason?`<p class="fine" data-testid="${prefix}-per-pet-note">${escape(reason)}</p>`:"")
    +`</div>`;
}
function bindDiscountValueControls(host){
  const container=host?.querySelector("[data-discount-controls]");if(!container)return;
  const modes=[...container.querySelectorAll('[name="kind"]')];
  const input=container.querySelector('[data-testid="field-value"]');
  const label=container.querySelector("[data-discount-value-label]");
  const unit=container.querySelector("[data-discount-value-unit]");
  const hint=container.querySelector("[data-discount-hint]");
  if(!modes.length||!input)return;
  const apply=()=>{
    const percentage=modes.find(mode=>mode.checked)?.value==="percentage";
    if(label)label.textContent=percentage?"Percentage":"Amount";
    if(unit)unit.textContent=percentage?"%":currencySymbol();
    if(percentage)input.setAttribute("max","100");else input.removeAttribute("max");
    if(hint)hint.textContent=percentage&&Number(input.value||0)>=100?DISCOUNT_HINT_FREE:DISCOUNT_HINT_ORDINARY;
  };
  modes.forEach(mode=>mode.addEventListener("change",apply));
  input.addEventListener("input",apply);
  apply();
}
/**
 * The kind and its value, as the write schema wants them.
 *
 * Exactly one of `amountMinor` and `rateBasisPoints` is sent. The schema refuses both rather than
 * silently ignoring one — an operator who sent both does not know which they would get — so the
 * unused half is omitted rather than nulled.
 */
function discountValuePayload(values){
  const kind=String(values.get("kind")||"amount")==="percentage"?"percentage":"amount";
  const value=Number(values.get("value")||0);
  const applyScope=String(values.get("applyScope")||"per_appointment");
  return kind==="percentage"
    ?{kind,rateBasisPoints:Math.round(value*100),applyScope}
    :{kind,amountMinor:Math.round(value*100),applyScope};
}

// --- Discount editor -----------------------------------------------------
/**
 * Add and Edit are one dialog, and Edit exists deliberately.
 *
 * The reference offers Delete only. Without Edit a typo in a live discount is unfixable here —
 * the same reason `openTaxPayRateEditor` offers it on the rate in force — and delete-and-recreate
 * severs the link every invoice that applied it holds back to the row that produced it.
 */
function openDiscountEditor(discountId,{duplicate=false}={}){
  const row=discountId?discountList().find(item=>item.id===discountId):null;
  const editing=Boolean(row)&&!duplicate;
  const name=duplicate&&row?`${row.name} copy`:editing?row.name:"";
  openModal(editing?"Edit discount":"Add discount",
    // The placeholder is the reference's own, spelled correctly.
    field("name","Name","text",
      `required maxlength="80" placeholder="Old Friend Discount" value="${escapeAttr(name)}"`,true)
    +discountValueControls("discount",duplicate||editing?row:null),
    async form=>{
      const payload={name:String(form.get("name")||"").trim(),...discountValuePayload(form),
        // A full replacement, not a patch: the kind and its value are one decision. Editing keeps
        // whatever the row's switch says; a new or duplicated discount starts live.
        active:editing?row.active!==false:true};
      await discountsWrite(editing?`/api/settings/discounts/${row.id}`:"/api/settings/discounts",
        {method:editing?"PUT":"POST",body:JSON.stringify(payload)});
      return {afterClose:()=>renderDiscounts(),
        message:editing?`${payload.name} saved`:`${payload.name} added`};
    },{submitLabel:editing?"Save":"Add discount"});
  // No dirty guard. `#modal` has none today and this form is a name and a number; adding one here
  // would make this dialog behave unlike every other one in the product.
  bindDiscountValueControls($("#modal-fields"));
}
function confirmDeleteDiscount(row){
  openStackedDialog({
    title:`Delete ${row.name}?`,
    body:`<p>It stops being offered at checkout. Invoices that already applied it keep the amount they took off, and go on naming it.</p>`
      +`<p class="error" role="alert"></p>`,
    confirmLabel:"Delete",dismissLabel:"Cancel",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      try{await api(`/api/settings/discounts/${encodeURIComponent(row.id)}`,{method:"DELETE"});}
      catch(problem){error.textContent=problem.message;return false;}
      // 204 and no body, so the screen is re-read rather than patched.
      await loadDiscounts();renderDiscounts();toast(`${row.name} deleted`);return true;
    }
  });
}
function confirmDeleteCoupon(coupon){
  const name=couponDisplayName(coupon);
  const redeemed=Number(coupon.redeemedCount)||0;
  openStackedDialog({
    title:`Delete ${name}?`,
    body:`<p>The code stops working at checkout.${redeemed?` ${redeemed===1?"One redemption":`${redeemed} redemptions`} already recorded stay exactly as they were charged.`:""}</p>`
      // The code is claimed forever, redeemed or not. A code that was handed out must never come
      // back meaning something else, and somebody who deletes expecting to re-use it should find
      // that out here rather than from a refusal on the way back in.
      +`<p class="fine">${escape(coupon.code)} cannot be issued again, even under a new coupon.</p>`
      +`<p class="error" role="alert"></p>`,
    confirmLabel:"Delete",dismissLabel:"Cancel",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      try{await api(`/api/settings/coupons/${encodeURIComponent(coupon.id)}`,{method:"DELETE"});}
      catch(problem){error.textContent=problem.message;return false;}
      await loadDiscounts();renderDiscounts();toast(`${name} deleted`);return true;
    }
  });
}

// --- Coupon editor drawer ------------------------------------------------
/**
 * Eight characters a person can read aloud.
 *
 * Five attempts against the codes already loaded, and then the fifth is used anyway: the server
 * owns real uniqueness — the index is not partial on `active`, so even a retired code is still
 * claimed — and a client that kept trying would only be guessing at a set it cannot see.
 */
function generateCouponCode(){
  const taken=new Set(couponList().map(coupon=>String(coupon.code||"").toUpperCase()));
  let code="";
  for(let attempt=0;attempt<5;attempt++){
    const values=new Uint32Array(COUPON_CODE_LENGTH);
    globalThis.crypto.getRandomValues(values);
    code=[...values].map(value=>COUPON_CODE_ALPHABET[value%COUPON_CODE_ALPHABET.length]).join("");
    if(!taken.has(code))return code;
  }
  return code;
}
/**
 * One limitation row: the switch that turns it on, and the fields it turns on.
 *
 * The fields go in a `<fieldset disabled>` rather than being tracked input by input. `disabled`
 * propagates natively — every descendant is announced unavailable, leaves the tab order, and is
 * excluded from `FormData` — which is four correct behaviours from one attribute, and it is what
 * makes "unchecked means unset" true of the payload without a line of code saying so.
 *
 * DISABLED, NEVER HIDDEN. Hiding makes the drawer jump under the pointer and leaves nothing on
 * screen saying what checking the box is going to ask for.
 */
function couponLimitRow({key,label,hint,on,legend,inputs}){
  return `<div class="coupon-limit-row" data-coupon-limit-row="${key}">`
    +`<label class="coupon-limit-switch"><input type="checkbox" class="pref-toggle" role="switch"`
    +` data-coupon-limit="${key}" data-testid="coupon-limit-${key}"${on?" checked":""}>`
    +`<span class="coupon-limit-label">${escape(label)}${hint?`<small>${escape(hint)}</small>`:""}</span></label>`
    +(inputs?`<fieldset class="coupon-limit-inputs" id="coupon-limit-${key}-fields"${on?"":" disabled"}>`
      +`<legend class="visually-hidden">${escape(legend)}</legend>${inputs}</fieldset>`
      +`<p class="error coupon-limit-error" data-coupon-limit-error="${key}" role="alert"></p>`:"")
    +`</div>`;
}
function couponEditorBodyMarkup(coupon){
  const dateInput=(name,label,value)=>`<label class="coupon-limit-field">${escape(label)}`
    +`<input type="date" name="${name}" data-testid="field-${name}" value="${escapeAttr(value||"")}"></label>`;
  const countInput=(name,label,value)=>`<label class="coupon-limit-field">${escape(label)}`
    +`<input type="number" name="${name}" data-testid="field-${name}" required min="1" step="1"`
    +` value="${escapeAttr(value?String(value):"1")}"></label>`;
  const days=Array.isArray(coupon?.weekdays)?coupon.weekdays.map(Number):[];
  // Seven pill checkboxes, not a multi-select. `.availability-chip` is already keyboard-native,
  // already the product's vocabulary for choosing days, and already tested.
  const dayChips=`<div class="coupon-limit-days" role="group" aria-label="Days this coupon can be redeemed">`
    +AVAILABILITY_WEEKDAYS.map((label,weekday)=>`<label class="availability-chip">`
      +`<input type="checkbox" name="weekday" value="${weekday}" data-testid="coupon-day-${weekday}"`
      +`${days.includes(weekday)?" checked":""}>`
      +`<span aria-hidden="true">${AVAILABILITY_WEEKDAYS_SHORT[weekday]}</span>`
      +`<span class="visually-hidden">${escape(label)}</span></label>`).join("")
    +`</div>`;
  return `<label>Name`
    +`<input type="text" name="name" data-testid="field-name" maxlength="80" placeholder="Spring cleaning"`
    +` value="${escapeAttr(coupon?.name||"")}">`
    +`<small class="field-hint">Optional. Without one the code is what the receipt calls it.</small></label>`
    // Fully editable, because a salon may have printed SPRING26 before Pawsh ever saw it. Uppercase
    // on display and on submit, so the code stored is the code on the card.
    +`<label>Code`
    +`<span class="field-affix">`
    +`<input type="text" name="code" data-testid="field-code" required maxlength="40"`
    +` pattern="[A-Za-z0-9]{4,20}" autocomplete="off" spellcheck="false" autocapitalize="characters"`
    +` class="coupon-code-input" value="${escapeAttr(coupon?.code||"")}">`
    // The verb IS the warning: `Regenerate` says a code is already there, which is cheaper and
    // clearer than a confirm for something one more press undoes.
    +`<button type="button" class="secondary compact field-affix-action" data-coupon-generate data-testid="coupon-generate">`
    +`${coupon?.code?"Regenerate":"Generate"}</button></span>`
    +`<small class="field-hint">4–20 letters and numbers. Generated codes leave out I, L, O, 0 and 1, which are the characters a client misreads.</small></label>`
    +discountValueControls("coupon",coupon)
    +`<fieldset class="coupon-limit-group"><legend>When it can be redeemed</legend>`
    +couponLimitRow({key:"dates",label:"Only between two dates",
      on:Boolean(coupon?.startsOn||coupon?.endsOn),legend:"Redemption dates",
      inputs:dateInput("startsOn","From",coupon?.startsOn)+dateInput("endsOn","Until",coupon?.endsOn)})
    +couponLimitRow({key:"days",label:"Only on certain days",
      on:Array.isArray(coupon?.weekdays)&&coupon.weekdays.length>0,legend:"Days of the week",
      inputs:dayChips})
    +`</fieldset>`
    +`<fieldset class="coupon-limit-group"><legend>How many times</legend>`
    +couponLimitRow({key:"per-client",label:"Limit per client",
      on:Boolean(coupon?.maxRedemptionsPerClient),legend:"Redemptions per client",
      inputs:countInput("maxRedemptionsPerClient","Times each client may redeem it",coupon?.maxRedemptionsPerClient)})
    +couponLimitRow({key:"total",label:"Limit in total",
      on:Boolean(coupon?.maxRedemptions),legend:"Redemptions in total",
      inputs:countInput("maxRedemptions","Times it may be redeemed at all",coupon?.maxRedemptions)})
    // No gated inputs: the switch IS the setting, so it carries the name the payload uses.
    +couponLimitRow({key:"new-clients",label:"New clients only",
      hint:"Refused for anybody this salon has invoiced before.",on:Boolean(coupon?.newClientsOnly)})
    +`</fieldset>`
    +`<p class="coupon-limit-summary" data-testid="coupon-limit-summary" role="status" aria-live="polite"></p>`;
}
// The new-clients switch is the only limit whose checkbox is itself the value, so it is the only
// one that has to reach the payload by name.
function couponNewClientsInput(form){return form?.querySelector('[data-coupon-limit="new-clients"]');}
function couponLimitFieldset(form,key){return form?.querySelector(`#coupon-limit-${key}-fields`);}
/**
 * The limits as they stand in the form right now, in the same shape a row has, so the summary and
 * the table's tokens are built by one function and can never word the same coupon differently.
 */
function couponEditorLimits(form){
  const enabled=key=>!couponLimitFieldset(form,key)?.disabled;
  const value=name=>{
    const input=form.querySelector(`[name="${name}"]`);
    return input&&!input.disabled?input.value:"";
  };
  const days=enabled("days")
    ?[...form.querySelectorAll('[name="weekday"]:checked')].map(input=>Number(input.value))
    :[];
  return {
    startsOn:enabled("dates")?value("startsOn")||null:null,
    endsOn:enabled("dates")?value("endsOn")||null:null,
    weekdays:days.length?days:null,
    maxRedemptionsPerClient:enabled("per-client")?Number(value("maxRedemptionsPerClient"))||null:null,
    maxRedemptions:enabled("total")?Number(value("maxRedemptions"))||null:null,
    newClientsOnly:Boolean(couponNewClientsInput(form)?.checked)
  };
}
function renderCouponLimitSummary(form){
  const target=form?.querySelector("[data-testid=\"coupon-limit-summary\"]");if(!target)return;
  const tokens=couponLimitTokens(couponEditorLimits(form));
  if(tokens.length){target.textContent=`Limits: ${tokens.join(" · ")}`;return;}
  // A switch thrown but not yet filled in is not an unlimited coupon. Saying it was, while the
  // switch above is visibly on, would be the summary contradicting the screen it summarises - and
  // that combination is refused on save, so it is a state the operator is passing through.
  const pending=[...form.querySelectorAll("[data-coupon-limit]")].some(toggle=>toggle.checked);
  // An unlimited coupon SAYS SO. A blank line where the limits would be reads as a summary that
  // has not loaded rather than as a coupon anyone can redeem.
  target.textContent=pending?"Limits: not set yet."
    :"No limitations. Anyone can redeem this, any number of times.";
}
// The form as one string, so "has anything changed" is a comparison rather than a field-by-field
// audit. A disabled fieldset contributes nothing, which is exactly right: turning a limit on and
// off again leaves the drawer clean.
function couponEditorSnapshot(form){
  if(!form)return "";
  const entries=[...new FormData(form).entries()].map(([key,value])=>`${key}=${value}`);
  entries.push(`newClientsOnly=${Boolean(couponNewClientsInput(form)?.checked)}`);
  return entries.join("&");
}
function couponEditorDirty(){
  const form=$("#coupon-editor-form");
  if(!form||!discountsState.editor)return false;
  return couponEditorSnapshot(form)!==discountsState.editor.snapshot;
}
function couponEditorError(message){
  const target=$("#coupon-editor-error");if(target)target.textContent=message||"";
}
function couponLimitError(key,message){
  const target=$(`[data-coupon-limit-error="${key}"]`);
  if(target)target.textContent=message||"";
}
function clearCouponLimitErrors(){
  $$("#coupon-editor .coupon-limit-error").forEach(node=>{node.textContent="";});
}
function openCouponEditor(couponId,{duplicate=false}={}){
  const existing=couponId?couponList().find(item=>item.id===couponId):null;
  const editing=Boolean(existing)&&!duplicate;
  const drawer=$("#coupon-editor");if(!drawer)return;
  // A duplicate copies everything the coupon says EXCEPT the code, which can never be reused —
  // so the one field it cannot carry over is the one that opens empty and ready to generate.
  const seed=existing?{...existing,...(duplicate?{code:"",id:null}:{})}:null;
  discountsState.editor={couponId:editing?existing.id:null,active:existing?existing.active!==false:true,snapshot:""};
  $("#coupon-editor-title").textContent=editing?couponDisplayName(existing):"New coupon";
  couponEditorError("");
  const form=$("#coupon-editor-form");
  form.innerHTML=couponEditorBodyMarkup(seed);
  $('[data-testid="coupon-editor-save"]').textContent=editing?"Save":"Add coupon";
  bindCouponEditor(form);
  drawer.showModal();
  discountsState.editor.snapshot=couponEditorSnapshot(form);
  renderCouponLimitSummary(form);
  // The NAME input, not the drawer. This body is a form to fill, which is a different thing from
  // the role editor's body — a list to read — so the focus lands where typing starts.
  form.querySelector('[data-testid="field-name"]')?.focus();
}
function bindCouponEditor(form){
  bindDiscountValueControls(form);
  const summary=()=>renderCouponLimitSummary(form);
  form.querySelectorAll("[data-coupon-limit]").forEach(toggle=>toggle.addEventListener("change",()=>{
    const key=toggle.dataset.couponLimit;
    const fields=couponLimitFieldset(form,key);
    if(fields){
      fields.disabled=!toggle.checked;
      // On check the values are left exactly as they were and focus moves inside, so the switch
      // hands over to the thing it just turned on. On uncheck NOTHING IS CLEARED: an operator who
      // unchecks to look at the total is not asking to lose the dates they typed.
      if(toggle.checked)fields.querySelector("input,select,textarea")?.focus();
      else couponLimitError(key,"");
    }
    summary();
  }));
  // `input` as well as `change`: the summary is live, so it has to follow a number as it is typed
  // rather than waiting for focus to leave the field it describes.
  form.querySelectorAll('[name="weekday"],[name="startsOn"],[name="endsOn"],[name="maxRedemptions"],[name="maxRedemptionsPerClient"]')
    .forEach(input=>{input.addEventListener("change",summary);input.addEventListener("input",summary);});
  const code=form.querySelector('[data-testid="field-code"]');
  const generate=form.querySelector("[data-coupon-generate]");
  const label=()=>{if(generate)generate.textContent=code?.value?"Regenerate":"Generate";};
  code?.addEventListener("input",label);
  generate?.addEventListener("click",()=>{
    if(!code)return;
    code.value=generateCouponCode();
    label();code.focus();
  });
  // Uppercase on the way out of the field as well as on submit, so what is on screen is what the
  // customer will be handed.
  code?.addEventListener("change",()=>{code.value=code.value.trim().toUpperCase();});
  form.addEventListener("submit",event=>{event.preventDefault();runDetached(saveCouponEditor);});
}
async function saveCouponEditor(){
  const form=$("#coupon-editor-form");if(!form||!discountsState.editor)return;
  const editor=discountsState.editor;
  couponEditorError("");clearCouponLimitErrors();
  const values=new FormData(form);
  const limits=couponEditorLimits(form);
  // Cross-field refusals go in the row's OWN error node, beside the fields they are about, rather
  // than in the footer where the reader has to work out which of five rows is meant.
  const datesOn=!couponLimitFieldset(form,"dates")?.disabled;
  if(datesOn&&!limits.startsOn&&!limits.endsOn){
    couponLimitError("dates","Give a start date, an end date, or both.");return;
  }
  if(limits.startsOn&&limits.endsOn&&limits.startsOn>limits.endsOn){
    couponLimitError("dates","The end date cannot be before the start date.");return;
  }
  if(!couponLimitFieldset(form,"days")?.disabled&&!limits.weekdays){
    couponLimitError("days","Choose at least one day, or turn this off.");return;
  }
  const payload={
    code:String(values.get("code")||"").trim().toUpperCase(),
    name:String(values.get("name")||"").trim()||null,
    ...discountValuePayload(values),
    ...limits,
    active:editor.active
  };
  const save=$('[data-testid="coupon-editor-save"]');
  const original=save.textContent;
  save.disabled=true;save.textContent="Saving…";
  try{
    await discountsWrite(editor.couponId?`/api/settings/coupons/${encodeURIComponent(editor.couponId)}`:"/api/settings/coupons",
      {method:editor.couponId?"PUT":"POST",body:JSON.stringify(payload)});
  }catch(error){
    couponEditorError(error.message);
    // Both code refusals land on the field that has to change, with the text selected so the next
    // keystroke replaces it. COUPON_CODE_RETIRED is the one that would otherwise be a dead end: it
    // collides with a soft-deleted coupon that is not on this screen, so "already exists" would
    // send the operator hunting a row that is not there.
    if(error.data?.code==="COUPON_CODE_TAKEN"||error.data?.code==="COUPON_CODE_RETIRED"){
      const code=form.querySelector('[data-testid="field-code"]');
      code?.focus();code?.select();
    }
    return;
  }finally{save.disabled=false;save.textContent=original;}
  editor.snapshot=couponEditorSnapshot(form);
  $("#coupon-editor").close();
  renderDiscounts();
  toast(`${payload.name||payload.code} ${editor.couponId?"saved":"added"}`);
}
function setupCouponEditorDrawer(){
  const drawer=$("#coupon-editor");if(!drawer)return;
  const close=()=>{
    if(!couponEditorDirty()){drawer.close();return;}
    openStackedDialog({
      title:"Discard unsaved changes?",
      body:`<p>Nothing has been sent to the server yet, so closing now leaves this coupon exactly as it was.</p>`,
      confirmLabel:"Discard",dismissLabel:"Keep editing",
      onConfirm:()=>{drawer.close();}
    });
  };
  drawer.querySelector('[data-testid="coupon-editor-close"]')?.addEventListener("click",close);
  drawer.querySelector('[data-testid="coupon-editor-cancel"]')?.addEventListener("click",close);
  // Escape reaches the dialog as a cancelable `cancel`, which is the only place unsaved work can
  // still be defended. The backdrop click is the dialog itself and never its panel.
  drawer.addEventListener("cancel",event=>{
    if(!couponEditorDirty())return;
    event.preventDefault();close();
  });
  drawer.addEventListener("click",event=>{if(event.target===drawer)close();});
  drawer.addEventListener("close",()=>{discountsState.editor=null;});
}

// --- Writes made straight from a row -------------------------------------
// Every write is a FULL REPLACEMENT, so flipping one switch sends the row back as it stands with
// that one field moved. A partial patch cannot express the kind/value pairing the schema enforces.
function discountWriteBody(row,overrides){
  return {name:row.name,kind:row.kind,
    ...(row.kind==="percentage"?{rateBasisPoints:row.rateBasisPoints}:{amountMinor:row.amountMinor}),
    applyScope:row.applyScope,active:row.active!==false,...overrides};
}
function couponWriteBody(coupon,overrides){
  return {code:coupon.code,name:coupon.name||null,kind:coupon.kind,
    ...(coupon.kind==="percentage"?{rateBasisPoints:coupon.rateBasisPoints}:{amountMinor:coupon.amountMinor}),
    applyScope:coupon.applyScope,startsOn:coupon.startsOn||null,endsOn:coupon.endsOn||null,
    weekdays:Array.isArray(coupon.weekdays)&&coupon.weekdays.length?coupon.weekdays:null,
    newClientsOnly:Boolean(coupon.newClientsOnly),
    maxRedemptions:coupon.maxRedemptions??null,
    maxRedemptionsPerClient:coupon.maxRedemptionsPerClient??null,
    active:coupon.active!==false,...overrides};
}

// --- Binding -------------------------------------------------------------
function bindDiscounts(root){
  bindRolesMenuDismissal();
  // Arrows move focus, Enter and Space commit, matching Tax & payments and Roles. Activating on
  // focus would swap the panel out from under somebody simply passing along the bar.
  root.querySelector('[role="tablist"]')?.addEventListener("keydown",event=>{
    const buttons=[...root.querySelectorAll("[data-discounts-tab]")],index=buttons.indexOf(document.activeElement);
    if(index<0)return;
    if(event.key==="Enter"||event.key===" "||event.key==="Spacebar"){event.preventDefault();selectDiscountsTab(buttons[index].dataset.discountsTab);return;}
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();
    const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
    buttons[next]?.focus();
  });
  root.querySelectorAll("[data-discounts-tab]").forEach(button=>button.addEventListener("click",()=>
    selectDiscountsTab(button.dataset.discountsTab,{focus:false})));
  root.querySelector("[data-discounts-retry]")?.addEventListener("click",()=>{
    discountsState.error=null;discountsState.data=null;renderDiscounts();ensureDiscountsData();
  });
  ["discount","coupon"].forEach(kind=>{
    root.querySelectorAll(`[data-${kind}-page]`).forEach(button=>button.addEventListener("click",()=>
      selectDiscountsPage(kind,Number(button.dataset[`${kind}Page`]))));
    const rows=kind==="coupon"?couponList():discountList();
    const {page,pages}=discountsPageSlice(rows,kind);
    const previous=root.querySelector(`#${kind}-pager-prev`),next=root.querySelector(`#${kind}-pager-next`);
    if(previous){previous.disabled=page<=1;previous.addEventListener("click",()=>selectDiscountsPage(kind,page-1));}
    if(next){next.disabled=page>=pages;next.addEventListener("click",()=>selectDiscountsPage(kind,page+1));}
  });
  const discount=id=>discountList().find(item=>item.id===id);
  const coupon=id=>couponList().find(item=>item.id===id);
  root.querySelector("[data-discount-add]")?.addEventListener("click",()=>openDiscountEditor(null));
  root.querySelector("[data-coupon-add]")?.addEventListener("click",()=>openCouponEditor(null));
  root.querySelectorAll("[data-discount-edit]").forEach(button=>button.addEventListener("click",()=>
    openDiscountEditor(button.dataset.discountEdit)));
  root.querySelectorAll("[data-discount-duplicate]").forEach(button=>button.addEventListener("click",()=>
    openDiscountEditor(button.dataset.discountDuplicate,{duplicate:true})));
  root.querySelectorAll("[data-discount-delete]").forEach(button=>button.addEventListener("click",()=>{
    const row=discount(button.dataset.discountDelete);if(row)confirmDeleteDiscount(row);
  }));
  root.querySelectorAll("[data-coupon-edit]").forEach(button=>button.addEventListener("click",()=>
    openCouponEditor(button.dataset.couponEdit)));
  root.querySelectorAll("[data-coupon-duplicate]").forEach(button=>button.addEventListener("click",()=>
    openCouponEditor(button.dataset.couponDuplicate,{duplicate:true})));
  root.querySelectorAll("[data-coupon-delete]").forEach(button=>button.addEventListener("click",()=>{
    const row=coupon(button.dataset.couponDelete);if(row)confirmDeleteCoupon(row);
  }));
  root.querySelectorAll("[data-discount-enabled]").forEach(input=>input.addEventListener("change",()=>{
    const id=input.dataset.discountEnabled,row=discount(id);if(!row)return;
    const active=input.checked;
    discountsState.restoreFocus=`[data-discount-enabled="${id}"]`;
    runDetached(()=>discountsControlWrite(`discount:${id}`,`/api/settings/discounts/${encodeURIComponent(id)}`,
      {method:"PUT",body:JSON.stringify(discountWriteBody(row,{active}))},
      active?`${row.name} can be applied at checkout`:`${row.name} hidden from checkout`));
  }));
  root.querySelectorAll("[data-coupon-enabled]").forEach(input=>input.addEventListener("change",()=>{
    const id=input.dataset.couponEnabled,row=coupon(id);if(!row)return;
    const active=input.checked,name=couponDisplayName(row);
    discountsState.restoreFocus=`[data-coupon-enabled="${id}"]`;
    runDetached(()=>discountsControlWrite(`coupon:${id}`,`/api/settings/coupons/${encodeURIComponent(id)}`,
      {method:"PUT",body:JSON.stringify(couponWriteBody(row,{active}))},
      active?`${name} can be redeemed` :`${name} can no longer be redeemed`));
  }));
  root.querySelector("[data-stacking-select]")?.addEventListener("change",event=>{
    const stackingMode=event.target.value;
    discountsState.restoreFocus="[data-stacking-select]";
    runDetached(()=>discountsControlWrite("discounts:stacking","/api/settings/discount-stacking",
      {method:"PUT",body:JSON.stringify({stackingMode})},"Stacking rule updated"));
  });
  // The row menus reuse the client directory's `.row-menu` exactly as Roles does, so they need
  // only the usual close-the-others.
  root.querySelectorAll(".roles-menu").forEach(menu=>menu.addEventListener("toggle",()=>{
    menu.querySelector("summary")?.setAttribute("aria-expanded",String(menu.open));
    if(!menu.open)return;
    root.querySelectorAll(".roles-menu[open]").forEach(other=>{if(other!==menu)closeRolesMenu(other);});
  }));
  root.querySelectorAll(".roles-menu .row-menu-item").forEach(button=>
    button.addEventListener("click",closeRolesMenus));
}

// ---------------------------------------------------------------------------
// Settings → Roles & permissions
//
// A role is a named set of permissions the salon assigns to people. The workspace is a table of
// roles over a list of the people holding them, and each role row opens TWO editors rather than
// one: "Access Control" carries what the reference calls Report & Dashboard - the two masters and
// the three groups they gate - and "Permissions" carries everything else.
//
// Both write the SAME `permissions` array on the role, which is why they share one drawer element
// and can never be open at once. One editor at a time is what makes `version` a sufficient
// concurrency check rather than a race between two halves of the same screen.
//
// The editor holds the role's WHOLE permission set in `selected`, not the subset its sheet can
// see, and every save sends that whole set. A filter, a folded group and a master switched off all
// change what is on screen; none of them change what is saved. Reading the payload off the
// rendered rows instead would silently drop every permission the operator had filtered away.
// ---------------------------------------------------------------------------

// Which catalog groups belong to the Access Control sheet. Split by group id because that is the
// only stable name the contract gives a group, and a group id this list does not know falls
// through to Permissions - so a group added later is editable somewhere rather than unreachable.
const ROLE_ACCESS_GROUP_IDS = new Set(["dashboard", "payroll", "sales"]);

const ROLE_TABS = [["roles", "Roles"], ["login-control", "Login Control (only for web)"]];
const MEMBER_STATUS_LABELS = { active: "Active", invited: "Invited", disabled: "Removed", suspended: "Suspended", revoked: "Removed" };

const rolesState = tenantCache(() => ({
  tab: "roles", roles: null, catalog: null, loading: false, error: null,
  invitations: [], invitationsUnavailable: false, editor: null, restoreFocus: null
}));

function rolesManaged(){return allowed("team.manage");}
function roleCatalogGroups(){return Array.isArray(rolesState.catalog?.groups)?rolesState.catalog.groups:[];}
// Both halves have to be there. The role list without the catalog is a table of names with no way
// to say what any of them mean, which is worse than saying the screen is not ready.
function rolesReady(){return Array.isArray(rolesState.roles)&&roleCatalogGroups().length>0;}
function roleCatalogPermission(key){
  for(const group of roleCatalogGroups()){
    const row=(group.permissions||[]).find(permission=>permission.key===key);
    if(row)return row;
  }
  return null;
}
// The catalog names its own masters - it lists `reports.view` and `dashboard.view` in a Reporting
// group as well as naming them masters - so the label comes from the server like every other one.
// Restating them here would be a second source of truth for the same words.
function roleMasterLabel(key){return roleCatalogPermission(key)?.label||key;}
// Which sheet a group is edited on.
function roleGroupSurface(group){return ROLE_ACCESS_GROUP_IDS.has(group.id)?"access":"permissions";}
// Every masterKey ONE SHEET presents. A master is presented once PER SHEET - never twice on the
// same sheet, as a master switch and again as an ordinary row, which would be two switches for one
// key sitting where they can be seen disagreeing.
//
// Per sheet, not per catalog, and the difference is the whole point. `dashboard.view` and
// `reports.view` are each a listed row of their own Permissions group AND the masterKey of an
// Access Control group, so they are MEANT to appear on both sheets: the reference names "Access
// Dashboard" and "Access Report" in both places, and an owner hunting for either finds it wherever
// they thought to look. That is safe because both sheets read the same `editor.selected` and only
// one is open at a time, so the two renderings cannot hold different values - the thing a single
// catalog-wide check was there to prevent never arises across sheets. Applying it across sheets
// anyway is what used to make an entire group render as nothing at all.
function roleMasterKeys(surface){
  const keys=new Set();
  for(const group of roleCatalogGroups()){
    if(group.masterKey&&roleGroupSurface(group)===surface)keys.add(group.masterKey);
  }
  return keys;
}
/**
 * A group's own rows: everything it lists, minus any key that is ANOTHER group's master on the
 * same sheet.
 *
 * A group's OWN master stays among its rows, and that is how the Permissions sheet reaches its
 * masters at all: it renders no master switches of its own - `roleEditorMastersMarkup` is an
 * Access Control affordance, where one master gates several groups and so belongs above all of
 * them - so `settings.manage`, `dashboard.view` and `reports.view` are each reachable only as the
 * listed row of the group they master. Excluding them left three permissions no owner could grant
 * anywhere on the screen, and left Report as a group with nothing in it.
 */
function roleGroupRows(group){
  const masters=roleMasterKeys(roleGroupSurface(group));
  return (group.permissions||[]).filter(permission=>
    permission.key===group.masterKey||!masters.has(permission.key));
}
// Whether the group renders its own master among its rows, rather than being gated by one shown
// above it. True on the Permissions sheet, false on Access Control.
function roleGroupOwnsMaster(group){
  return Boolean(group.masterKey)
    &&roleGroupRows(group).some(permission=>permission.key===group.masterKey);
}
// The catalog's own word for a permission shipped ahead of the feature it will gate.
function roleUnenforced(permission){return permission.enforced===false;}
// A group is UNBUILT when it has rows and EVERY one of them gates nothing yet. A percentage
// threshold would be a lie waiting to happen: one enforced row is enough that the heading may not
// say the group does nothing, however small a fraction it is. Computed from the group's WHOLE row
// set and never from the filtered one, so a search can never change what a group IS.
function roleGroupUnbuilt(group){
  const rows=roleGroupRows(group);
  return rows.length>0&&rows.every(roleUnenforced);
}
function roleGroupUnenforcedCount(group){return roleGroupRows(group).filter(roleUnenforced).length;}
function roleGroupNoteId(group){return `role-note-${group.id}`;}
function roleSurfaceGroups(surface){
  return roleCatalogGroups().filter(group=>
    roleGroupSurface(group)===surface
    // A group whose every row is a master shown elsewhere has nothing of its own left to say.
    &&(Boolean(group.masterKey)||roleGroupRows(group).length>0));
}
// Every key one sheet can reach, masters included, so a per-sheet count on the role row means the
// same thing as the switches inside it.
function roleSurfaceKeys(surface){
  const keys=new Set();
  for(const group of roleSurfaceGroups(surface)){
    if(group.masterKey)keys.add(group.masterKey);
    for(const permission of roleGroupRows(group))keys.add(permission.key);
  }
  return keys;
}
function roleSurfaceCount(role,surface){
  const keys=roleSurfaceKeys(surface);
  let granted=0;
  for(const key of role.permissions||[])if(keys.has(key))granted+=1;
  return {granted,total:keys.size};
}
// THERE IS NO OWNER ROLE, deliberately: ownership is `is_owner` plus a database trigger, not a
// permission set, so the server returns real roles only and never one called Owner. The pinned
// row is synthesized here from the memberships that actually carry ownership. Inferring it from a
// role's NAME instead would hand the pin - and the cannot-be-edited treatment - to any custom role
// a salon happened to call "Owner".
function ownerMemberships(){return (state.members||[]).filter(member=>member.isOwner);}
// The server already orders these `built_in desc, lower(name)`, which is the order this table wants.
function rolesOrdered(){return [...(rolesState.roles||[])];}
// Roles somebody can actually be given. A disabled role resolves to the empty set on the server, so
// assigning one would be handing somebody nothing while telling them they had been given a job.
function roleAssignable(){return rolesOrdered().filter(role=>role.enabled!==false);}
// Every role write - create, rename, duplicate, delete, enable, permissions - and every membership
// write is Owner-only on the server, on top of team.manage. A manager reads this screen and does
// not edit it, so the controls say so rather than issuing requests that come back 403.
function rolesEditable(){return Boolean(state.me?.isOwner);}
/**
 * Whether this operator may APPROVE a workspace access request. Owner only.
 *
 * Approving admits an account AT A ROLE OF THE APPROVER'S CHOOSING, which is precisely the
 * escalation every other membership write is Owner-only to prevent - a manager who could approve
 * could approve somebody into a role holding more than the manager does. The server enforces
 * `isOwner` on the approve route now, on top of `team.manage`, so a button offered to anybody else
 * is a button that comes back 403.
 *
 * REJECTING IS DELIBERATELY NOT NARROWED, and stays on `team.manage` with the panel itself.
 * Refusing a request grants nothing, so a manager can still clear the queue; the panel goes on
 * listing what is pending for them, because a request they can see and decline is more useful than
 * one hidden from them entirely.
 *
 * Expressed as `state.me?.isOwner`, the same way `rolesEditable` above expresses it, rather than as
 * a permission: ownership is not something a role can grant.
 */
function accessRequestApprovable(){return Boolean(state.me?.isOwner);}

async function loadRoles(){
  rolesState.loading=true;rolesState.error=null;
  try{
    const [roles,catalog]=await Promise.all([api("/api/roles"),api("/api/permissions")]);
    rolesState.roles=Array.isArray(roles?.roles)?roles.roles:[];
    rolesState.catalog=catalog;
  }catch(error){rolesState.error=error;}
  finally{rolesState.loading=false;}
}
// Pending invitations are a separate read and a separate dependency. A server that does not answer
// this yet still gets the rest of the People list rather than an error across the whole screen -
// the invitation rows simply are not there to show, which is exactly what is true.
async function loadRoleInvitations(){
  try{
    const result=await api("/api/members/invitations");
    rolesState.invitations=Array.isArray(result?.invitations)?result.invitations:Array.isArray(result)?result:[];
    rolesState.invitationsUnavailable=false;
  }catch{rolesState.invitations=[];rolesState.invitationsUnavailable=true;}
}
function ensureRolesData(){
  if(!rolesManaged())return;
  if(rolesState.roles||rolesState.loading||rolesState.error)return;
  runDetached(async()=>{await loadRoles();if(rolesReady())await loadRoleInvitations();renderRoles();});
}
// Writes made straight from a control rather than from a dialog, in the shape Tax & payments uses:
// a refusal is announced and the screen is re-read, so the switch that moved goes back to whatever
// the server actually holds instead of keeping the value the click gave it.
function roleMutation(key,operation,message){
  return runOnce(key,async()=>{
    try{
      await operation();
      await loadRoles();renderRoles();
      if(message)toast(message);
    }catch(error){
      toast(error.message);
      await loadRoles();renderRoles();
    }
  });
}

// --- The workspace -------------------------------------------------------
function rolesTabsMarkup(){
  return `<div class="settings-tabs" role="tablist" aria-label="Roles and permissions" data-testid="roles-tabs">`
    +ROLE_TABS.map(([id,label])=>{
      const active=rolesState.tab===id;
      return `<button type="button" role="tab" id="roles-tab-${id}" class="settings-tab${active?" active":""}" data-roles-tab="${id}" data-testid="roles-tab-${id}" aria-selected="${active}" aria-controls="roles-panel" tabindex="${active?0:-1}">${escape(label)}</button>`;
    }).join("")+`</div>`;
}
// Listed, not hidden, and honest about why it is empty. Pawsh has no sign-in restriction of any
// kind, so a tab of switches here would claim a control the product does not have.
function rolesLoginControlMarkup(){
  return `<article class="settings-panel settings-placeholder" data-testid="roles-login-control">`
    +`<p class="eyebrow">Not available yet</p><h3>Login Control (only for web)</h3>`
    +`<p>Pawsh does not yet restrict where, when, or from which device a workspace account can sign in. There is no address allow-list, no device approval and no sign-in schedule, so nothing configured here would take effect. It is listed rather than hidden so it is clear the capability was not overlooked.</p></article>`;
}
function rolesUnavailableMarkup(){
  return `<article class="settings-panel settings-placeholder" data-testid="roles-unavailable">`
    +`<p class="eyebrow">Not available yet</p><h3>Roles</h3>`
    +`<p>This workspace's server does not serve the roles catalogue yet, so there is nothing to list. Everyone's existing access is unchanged in the meantime, and invitations still work.</p></article>`;
}
function rolesErrorMarkup(){
  const error=rolesState.error;
  // A 404 is the one failure that is not a fault: the roles API lands in phases, and a workspace
  // whose server does not serve it yet should read as "not here yet" rather than as a broken
  // screen. Anything else is reported as itself.
  if(error?.status===404||error?.status===501)return rolesUnavailableMarkup();
  const message=error?.status===403?"You do not have permission to view this."
    :error?.status?error.message
    :"Could not load roles and permissions. Check your connection and try again.";
  return `<div class="availability-error" data-testid="roles-error"><h4>This could not load</h4><p>${escape(message)}</p>`
    +`<button type="button" class="secondary compact" data-roles-retry data-testid="roles-retry">Try again</button></div>`;
}
function roleSurfaceCell(role,surface,label,testid){
  const {granted,total}=roleSurfaceCount(role,surface);
  return `<td class="roles-col-surface"><button type="button" class="text-button" data-role-open="${escapeAttr(role.id)}" data-role-surface="${surface}" data-testid="${testid}"`
    +` aria-label="${escapeAttr(`${label} for ${role.name}`)}">${escape(label)}</button>`
    +`<small class="roles-count">${granted} of ${total}</small></td>`;
}
// The column header is not a label, so every switch names its own role. `Enable` alone would leave
// a screen reader on the eighth row with no idea which role it is about to turn off.
// A built-in role's IDENTITY is fixed - it cannot be renamed or deleted - but it is not permanently
// on. Switching it off is the supported way to retire one the salon does not use, and re-enabling
// brings back the same canonical role rather than a copy of it. The only lock left here is the
// Owner-only one the server enforces.
function roleEnabledCell(role){
  const locked=rolesEditable()?"":"Only an Owner can turn a role on or off.";
  return `<td><label class="roles-switch"><span class="visually-hidden">Enable ${escape(role.name)} role</span>`
    +`<input type="checkbox" role="switch" class="pref-toggle" data-role-enabled="${escapeAttr(role.id)}" data-testid="role-enabled"`
    +`${role.enabled!==false?" checked":""}`
    +`${locked?` disabled aria-disabled="true" title="${escapeAttr(locked)}"`:""}></label></td>`;
}
// A built-in role is a Pawsh system template: its name is its identity, so rename and delete are
// omitted rather than shown disabled - a disabled item invites somebody to hunt for the permission
// that would enable it, and there is none. Retiring one is what the Enable switch is for.
function roleMenuMarkup(role){
  // Every item in it is Owner-only on the server, so a manager gets no menu rather than a menu of
  // requests that come back 403.
  if(!rolesEditable())return "";
  const nameAttr=escapeAttr(role.name);
  const items=[];
  if(!role.builtIn)items.push(`<button type="button" class="row-menu-item" data-role-rename="${escapeAttr(role.id)}" data-testid="role-rename">Rename</button>`);
  items.push(`<button type="button" class="row-menu-item" data-role-duplicate="${escapeAttr(role.id)}" data-testid="role-duplicate">Duplicate</button>`);
  if(!role.builtIn)items.push(`<button type="button" class="row-menu-item" data-role-delete="${escapeAttr(role.id)}" data-testid="role-delete">Delete</button>`);
  return `<details class="row-menu roles-menu"><summary class="row-menu-trigger" aria-expanded="false" data-testid="role-row-actions" aria-label="Actions for ${nameAttr}"><span aria-hidden="true">⋯</span></summary>`
    +`<div class="row-menu-list" role="group" aria-label="Actions for ${nameAttr}">${items.join("")}</div></details>`;
}
function roleRow(role){
  const assigned=Number(role.assignedCount)||0;
  return `<tr data-testid="role-row" data-role-row="${escapeAttr(role.id)}" data-role-name="${escapeAttr(role.name)}">`
    +`<td><span class="roles-name"><strong>${escape(role.name)}</strong>${role.builtIn?`<small>Built-in</small>`:""}`
    // The switch alone carries this state as a shape and a colour. A disabled role grants nothing
    // to everyone holding it, which is too consequential to leave to either.
    +(role.enabled===false?`<small class="roles-off" data-testid="role-disabled-mark">Disabled</small>`:"")
    +(role.description?`<small class="roles-description">${escape(role.description)}</small>`:"")+`</span></td>`
    +`<td class="roles-col-assigned" data-testid="role-assigned">${assigned}</td>`
    +roleEnabledCell(role)
    +roleSurfaceCell(role,"access","Access Control","role-open-access")
    +roleSurfaceCell(role,"permissions","Permissions","role-open-permissions")
    +`<td class="roles-actions">${roleMenuMarkup(role)}</td></tr>`;
}
// Pinned, and not a role: it carries no permission set to open, nothing to rename, and no switch
// to throw. `Assigned` counts the memberships that actually hold `is_owner`, which is the only
// place this fact lives.
function ownerRowMarkup(){
  const count=ownerMemberships().length;
  return `<tr data-testid="role-row" data-role-row="owner" data-role-name="Owner" class="is-owner">`
    +`<td><span class="roles-name"><strong>Owner</strong><small>Built-in</small>`
    +`<small class="roles-description">Ownership is not a role. It cannot be granted, edited or switched off &mdash; only transferred.</small></span></td>`
    +`<td class="roles-col-assigned" data-testid="role-assigned">${count}</td>`
    +`<td><label class="roles-switch"><span class="visually-hidden">Enable Owner role</span>`
    +`<input type="checkbox" role="switch" class="pref-toggle" data-testid="role-enabled" checked disabled aria-disabled="true"`
    +` title="Ownership is always on. It is transferred, not switched off."></label></td>`
    +`<td class="roles-col-surface"><span class="roles-full">Full access</span></td>`
    +`<td class="roles-col-surface"><span class="roles-full">Full access</span></td>`
    +`<td class="roles-actions"></td></tr>`;
}
function rolesTableMarkup(){
  const head=`<thead><tr><th scope="col">Role</th><th scope="col" class="roles-col-assigned">Assigned</th>`
    +`<th scope="col">Enabled</th><th scope="col" class="roles-col-surface">Report &amp; Dashboard</th>`
    +`<th scope="col" class="roles-col-surface">Permissions</th>`
    +`<th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>`;
  const roles=rolesOrdered();
  // A workspace that has never invited anybody has no roles at all - an owner takes none - so the
  // empty row says what is missing rather than reporting the table as broken.
  const body=ownerRowMarkup()+(roles.length?roles.map(roleRow).join("")
    :`<tr><td class="empty" colspan="6">No role yet. Anybody but you needs one before they can be invited.</td></tr>`);
  return `<div class="taxpay-table-wrap" data-allow-horizontal-scroll>`
    +`<table class="taxpay-table roles-table" data-testid="roles-table">${head}<tbody>${body}</tbody></table></div>`
    +(rolesEditable()?`<div class="taxpay-foot"><button type="button" class="primary compact" data-role-add data-testid="role-add">+ Add role</button></div>`:"");
}

// --- People --------------------------------------------------------------
function roleNameForMember(member){
  if(member.isOwner)return "Owner";
  return member.role?.name||member.roleName||"No role";
}
function memberStatusLabel(status){
  const value=String(status||"active");
  return MEMBER_STATUS_LABELS[value]||value.replaceAll("_"," ");
}
function memberDisplayName(member){return member.employeeDisplayName||member.email;}
// `GET /api/members` returns revoked memberships too, and the old list rendered every one of them
// as though it were live - so somebody removed months ago still read as staff with access.
function rolePersonRow(member){
  const owner=Boolean(member.isOwner);
  const status=String(member.status||"active");
  const name=memberDisplayName(member);
  const nameAttr=escapeAttr(name);
  const items=[];
  const live=status!=="disabled"&&status!=="revoked";
  // Transferring, reassigning and removing are all Owner-only on the server.
  if(rolesEditable()){
    if(owner&&member.id===state.me?.membershipId)items.push(`<button type="button" class="row-menu-item" data-member-transfer data-testid="member-transfer">Transfer ownership</button>`);
    else if(!owner&&live){
      items.push(`<button type="button" class="row-menu-item" data-member-role="${escapeAttr(member.id)}" data-testid="member-change-role">Change role</button>`);
      items.push(`<button type="button" class="row-menu-item" data-member-remove="${escapeAttr(member.id)}" data-testid="member-remove">Remove access</button>`);
    }
  }
  const menu=items.length?`<details class="row-menu roles-menu"><summary class="row-menu-trigger" aria-expanded="false" data-testid="member-row-actions" aria-label="Actions for ${nameAttr}"><span aria-hidden="true">⋯</span></summary>`
    +`<div class="row-menu-list" role="group" aria-label="Actions for ${nameAttr}">${items.join("")}</div></details>`:"";
  return `<tr data-testid="member-row" data-member-row="${escapeAttr(member.id)}">`
    +`<td><span class="roles-name"><strong>${escape(name)}</strong>`
    +(member.employeeDisplayName?`<small>${escape(member.email)}</small>`:"")+`</span></td>`
    +`<td data-testid="member-role">${escape(roleNameForMember(member))}</td>`
    +`<td><span class="status-dot${status==="active"?"":" inactive"}" data-testid="member-status">${escape(memberStatusLabel(status))}</span></td>`
    +`<td class="roles-actions">${menu}</td></tr>`;
}
function roleInvitationRow(invitation){
  const email=String(invitation.email||"");
  const role=invitation.role?.name||invitation.roleName||"No role";
  const sent=invitation.createdAt?formatPrefDate(new Date(invitation.createdAt)):"";
  return `<tr data-testid="invitation-row" data-invitation-row="${escapeAttr(invitation.id)}">`
    +`<td><span class="roles-name"><strong>${escape(email)}</strong>${sent?`<small>Invited ${escape(sent)}</small>`:""}</span></td>`
    +`<td>${escape(role)}</td>`
    +`<td><span class="status-dot inactive">Invitation pending</span></td>`
    +`<td class="roles-actions">${rolesEditable()?`<button type="button" class="text-button danger" data-invitation-cancel="${escapeAttr(invitation.id)}" data-testid="invitation-cancel" aria-label="${escapeAttr(`Cancel the invitation to ${email}`)}">Cancel</button>`:""}</td></tr>`;
}
function rolesPeopleMarkup(){
  const members=Array.isArray(state.members)?state.members:[];
  const head=`<thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Status</th>`
    +`<th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>`;
  const rows=members.map(rolePersonRow).join("")+rolesState.invitations.map(roleInvitationRow).join("");
  const body=rows||`<tr><td class="empty" colspan="4">Only you have workspace access.</td></tr>`;
  return `<div class="panel-head"><div><h4>People</h4><p class="fine">Who holds which role, and who has been invited but has not signed in yet.</p></div>`
    +(rolesEditable()?`<button type="button" class="secondary compact" data-roles-invite data-testid="roles-invite">+ Invite</button>`:"")+`</div>`
    +`<div class="taxpay-table-wrap" data-allow-horizontal-scroll>`
    +`<table class="taxpay-table roles-people-table" data-testid="roles-people-table">${head}<tbody>${body}</tbody></table></div>`
    +(rolesState.invitationsUnavailable?`<p class="fine settings-note" data-testid="roles-invitations-unavailable">Pending invitations cannot be listed on this server yet, so anybody invited appears here only once they have signed in.</p>`:"");
}
function rolesAccessRequestsMarkup(){
  const requests=(state.accessRequests||[]).filter(request=>request.status==="pending");
  const approvable=accessRequestApprovable();
  const rows=requests.map(request=>`<div data-testid="access-request-row" data-access-request="${escapeAttr(request.id)}">`
    +`<span><strong>${escape(request.requesterName)}</strong><small>${escape(request.requesterEmail)} · ${escape(formatPrefDate(new Date(request.createdAt)))}</small></span>`
    +`<span>`
    // Absent rather than disabled, the precedent the Invite button and every role write on this
    // screen already set: a disabled Approve would say the capability is merely switched off,
    // when what is true is that it belongs to the Owner.
    +(approvable?`<button type="button" class="text-button" data-access-approve="${escapeAttr(request.id)}" data-testid="access-request-approve">Approve</button> `:"")
    +`<button type="button" class="text-button danger" data-access-reject="${escapeAttr(request.id)}" data-testid="access-request-reject">Reject</button></span></div>`).join("");
  // Said once, under the list, rather than on every row. A manager reading this needs to know who
  // to ask, not to be told the same thing four times.
  const ownerNote=!approvable&&requests.length
    ? `<p class="fine settings-note" data-testid="access-request-owner-only">Only an Owner can approve a request. You can reject one.</p>`
    : "";
  return `<h4>Pending access requests</h4><div class="simple-list" data-testid="roles-access-requests">${rows||`<p class="empty">No pending requests.</p>`}</div>${ownerNote}`;
}
function rolesPanelBodyMarkup(){
  if(rolesState.error)return rolesErrorMarkup();
  if(rolesState.loading&&!rolesState.roles)return `<p class="roles-loading" data-testid="roles-loading">Loading roles…</p>`;
  if(!rolesReady())return rolesUnavailableMarkup()+rolesAccessRequestsMarkup();
  return rolesTableMarkup()
    +`<p class="fine settings-note">A role is what somebody can do; ownership is separate and is transferred rather than granted. Turning a role off leaves it assigned and stops it granting anything.</p>`
    +`<section class="roles-people">${rolesPeopleMarkup()}</section>`
    +`<section class="roles-requests">${rolesAccessRequestsMarkup()}</section>`;
}
function rolesMarkup(){
  return rolesTabsMarkup()
    +`<article class="settings-panel roles-panel" id="roles-panel" role="tabpanel" aria-labelledby="roles-tab-${rolesState.tab}">`
    +(rolesState.tab==="login-control"?rolesLoginControlMarkup():rolesPanelBodyMarkup())
    +`</article>`;
}
// renderSettingsCategory replaces the whole settings pane on every nav click, so this re-reads
// module state rather than assuming anything about what is currently on screen. A write re-renders
// too, which is also how a refused switch goes back to what the server holds; `restoreFocus` is
// what stops that from dropping focus to the document.
function renderRoles(){
  const root=$("#roles-root");if(!root)return;
  root.innerHTML=rolesMarkup();
  bindRoles(root);
  const wanted=rolesState.restoreFocus;rolesState.restoreFocus=null;
  if(wanted)root.querySelector(wanted)?.focus();
}
function selectRolesTab(tab,{focus=true}={}){
  if(rolesState.tab===tab)return;
  rolesState.tab=tab;renderRoles();
  if(focus)$(`#roles-tab-${tab}`)?.focus();
}

// --- Role writes ---------------------------------------------------------
// The salon's own words for what the people holding this role are about to lose. "Loses 12
// permissions" is a number nobody can act on; `topPermissionLabels` is the list of things they
// will stop being able to do.
// The labels are VERBATIM from the reference and mixed-case by design - "View calendar" beside
// "Access Clients Tab" beside "Check Out Appointments" - so the sentence accommodates them rather
// than the reverse. Lowercasing a label's first character was right while every label was sentence
// case, and became wrong the day the taxonomy landed: it rendered "access Clients Tab" and "check
// Out Appointments", broken English in a confirmation dialog. Naming them as a LIST after a colon
// lets each one keep the exact casing of the switch the owner saw in the editor.
function roleLabelList(role){
  return (role.topPermissionLabels||[]).map(label=>String(label).trim()).filter(Boolean);
}
function roleLossSentence(role){
  const labels=roleLabelList(role);
  if(!labels.length)return "They keep their account and lose everything this role grants.";
  return `They will lose: ${labels.join(", ")}.`;
}
function roleEnabledSelector(role){return `[data-role-row="${role.id}"] [data-role-enabled]`;}
function toggleRoleEnabled(role,enabled){
  const patch=()=>api(`/api/roles/${encodeURIComponent(role.id)}`,{method:"PATCH",
    body:JSON.stringify({version:role.version,enabled})});
  const commit=()=>{
    rolesState.restoreFocus=roleEnabledSelector(role);
    return roleMutation(`role:enabled:${role.id}`,patch,enabled?`${role.name} turned on`:`${role.name} turned off`);
  };
  const assigned=Number(role.assignedCount)||0;
  if(enabled||!assigned)return commit();
  let committed=false;
  const dialog=openStackedDialog({
    title:`Turn off ${role.name}?`,
    body:`<p data-testid="role-disable-impact">${assigned===1?"One person has":`${assigned} people have`} the ${escape(role.name)} role. ${escape(roleLossSentence(role))}</p>`
      +`<p class="fine">Their accounts stay, and nothing is deleted. Turning the role back on restores exactly what it grants.</p>`,
    confirmLabel:"Turn it off",dismissLabel:"Cancel",
    onConfirm:async()=>{committed=true;await commit();}
  });
  // The click already flipped the switch, and Cancel, Escape and the backdrop all end here.
  // Re-rendering from state is the only revert that is also right when the PATCH was refused.
  dialog.addEventListener("close",()=>{
    if(committed)return;
    rolesState.restoreFocus=roleEnabledSelector(role);
    renderRoles();
  },{once:true});
}
// A role with no permissions cannot do anything, so the copy source defaults to the role most
// people already hold rather than to nothing. Starting empty stays available and says what it is.
function openRoleCreate({copyFromRoleId=null,name=""}={}){
  const assignable=roleAssignable();
  const preferred=copyFromRoleId
    ||[...assignable].sort((left,right)=>(Number(right.assignedCount)||0)-(Number(left.assignedCount)||0))[0]?.id
    ||"";
  const options=rolesOrdered().map(role=>
    `<option value="${escapeAttr(role.id)}"${role.id===preferred?" selected":""}>${escape(role.name)}</option>`).join("");
  openModal("Add role",
    field("name","Role name","text",`required maxlength="80" value="${escapeAttr(name)}"`,true)
    +field("description","Description","text",`maxlength="500"`,true)
    +`<label class="wide">Copy permissions from`
    +`<select data-testid="field-copyFromRoleId" name="copyFromRoleId"><option value="">Start with no permissions</option>${options}</select>`
    +`<small class="field-hint">A role that grants nothing cannot be used, so a new role normally starts from the nearest existing one and is trimmed.</small></label>`,
    async form=>{
      const values=Object.fromEntries(form);
      await api("/api/roles",{method:"POST",body:JSON.stringify({
        name:values.name,
        description:values.description||undefined,
        copyFromRoleId:values.copyFromRoleId||undefined
      })});
      await loadRoles();
      return {afterClose:null,message:`${values.name} created`};
    },{submitLabel:"Create role"});
}
function openRoleRename(role){
  openModal("Rename role",
    field("name","Role name","text",`required maxlength="80" value="${escapeAttr(role.name)}"`,true)
    +field("description","Description","text",`maxlength="500" value="${escapeAttr(role.description||"")}"`,true),
    async form=>{
      const values=Object.fromEntries(form);
      try{
        await api(`/api/roles/${encodeURIComponent(role.id)}`,{method:"PATCH",body:JSON.stringify({
          version:role.version,name:values.name,description:values.description||null
        })});
      }catch(error){
        // 409 carries three different refusals here: a built-in role's name is immutable
        // (ROLE_BUILT_IN_NAME_IMMUTABLE), the name is taken, or somebody else saved first. The
        // server words each one, so its sentence is what reaches the operator rather than a guess
        // made from the status alone. Reloading behind the dialog means a retry carries the
        // current version, and a row that turned out to be built-in stops offering Rename.
        if(error.status===409){await loadRoles();renderRoles();}
        throw error;
      }
      await loadRoles();
      return {afterClose:null,message:`${values.name} saved`};
    });
}
function confirmDeleteRole(role){
  openStackedDialog({
    title:`Delete ${role.name}?`,
    body:`<p>It stops being offered when somebody is given access. Nothing anyone has already done under it changes.</p>`
      +`<p class="error" role="alert"></p>`,
    confirmLabel:"Delete",dismissLabel:"Cancel",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      try{await api(`/api/roles/${encodeURIComponent(role.id)}`,{method:"DELETE"});}
      catch(problem){
        // A built-in role refuses deletion outright (ROLE_BUILT_IN_UNDELETABLE) and says so in the
        // server's own words. The uncoded 409 is the in-use case, which arrives with counts worth
        // repeating: "still in use" is not actionable, "2 people and 1 invitation" is.
        const assigned=Number(problem.data?.assignedCount)||0,invited=Number(problem.data?.pendingInvitationCount)||0;
        const held=[assigned?`${assigned} ${assigned===1?"person holds":"people hold"} it`:"",
          invited?`${invited} ${invited===1?"invitation is":"invitations are"} waiting on it`:""].filter(Boolean).join(" and ");
        error.textContent=problem.status!==409?problem.message
          :problem.data?.code?problem.message
          :held?`${role.name} cannot be deleted yet: ${held}. Move them to another role first.`
          :problem.message;
        if(problem.status===409){await loadRoles();renderRoles();}
        return false;
      }
      await loadRoles();renderRoles();toast(`${role.name} deleted`);return true;
    }
  });
}

// --- The two editors -----------------------------------------------------

/**
 * How many rows a sheet may carry before it opens folded.
 *
 * Access Control holds 23 over three groups and is a list somebody reads; the Permissions sheet
 * holds 78 over eleven, most of them carrying a sentence of hint, and is a page somebody scrolls
 * past. Folding turns the second back into the first: eleven headings, each already carrying its
 * own "6 of 27", so the fold still says where a role's grants actually are, and the filter forces
 * open whatever it matched.
 *
 * The test is on the SHEET'S SIZE, not on the sheet's name, so a sheet that grows past this later
 * folds on its own instead of waiting for somebody to remember this decision.
 */
const ROLE_SHEET_FOLD_THRESHOLD = 40;
function roleInitialCollapsed(surface){
  const groups=roleSurfaceGroups(surface);
  const rows=groups.reduce((sum,group)=>sum+roleGroupRows(group).length,0);
  const folded=rows>ROLE_SHEET_FOLD_THRESHOLD?groups.map(group=>group.id):[];
  // Folded, not hidden. Nothing in a wholly unbuilt group is actionable today, and an owner
  // reading what a role can do should not walk fourteen switches over features that do not exist
  // to reach the ones that do. The header still reports `n of m`, so a pre-granted group says so
  // without being opened. This is a union with the size rule above, not a replacement: on Access
  // Control, which is small enough to open expanded, it folds Payroll and nothing else.
  return new Set([...folded,...groups.filter(roleGroupUnbuilt).map(group=>group.id)]);
}
function openRoleEditor(roleId,surface){
  const role=(rolesState.roles||[]).find(item=>item.id===roleId);
  if(!role)return;
  rolesState.editor={
    roleId:role.id,roleName:role.name,surface,version:role.version,
    selected:new Set(role.permissions||[]),baseline:new Set(role.permissions||[]),
    filter:"",collapsed:roleInitialCollapsed(surface),
    // Off on arrival, always. These switches exist so a salon can record who should hold a
    // capability BEFORE it ships; a sheet that hid them by default would quietly undo the decision
    // that put them here.
    hideUnbuilt:false,
    saving:false,error:null,conflict:false
  };
  renderRoleEditor();
  const drawer=$("#role-editor");
  if(!drawer.open)drawer.showModal();
  drawer.querySelector(".drawer-head .close")?.focus();
}
function roleEditorRows(group){
  const editor=rolesState.editor;
  const filter=editor.filter.trim().toLowerCase();
  let rows=roleGroupRows(group);
  // Before the text filter, deliberately: the group tools, the bulk write and the summary count
  // all read this one set, so "All" can never grant a row the sheet is not showing.
  if(editor.hideUnbuilt)rows=rows.filter(permission=>!roleUnenforced(permission));
  if(!filter)return rows;
  return rows.filter(permission=>
    `${permission.label||""} ${permission.hint||""} ${permission.key||""}`.toLowerCase().includes(filter));
}
function roleEditorMasterOff(group){
  return Boolean(group.masterKey)&&!rolesState.editor.selected.has(group.masterKey);
}
function roleEditorMasterKeys(){
  const keys=[];
  for(const group of roleSurfaceGroups(rolesState.editor.surface)){
    if(group.masterKey&&!keys.includes(group.masterKey))keys.push(group.masterKey);
  }
  return keys;
}
function roleEditorMastersMarkup(){
  const editor=rolesState.editor;
  const keys=roleEditorMasterKeys();
  if(!keys.length)return "";
  const groups=roleSurfaceGroups(editor.surface);
  return `<div class="role-masters" data-testid="role-masters">`+keys.map(key=>{
    const checked=editor.selected.has(key);
    const gated=groups.filter(group=>group.masterKey===key).map(group=>group.label);
    const plural=gated.length>1;
    const hint=checked
      ?`On. ${gated.join(" and ")} ${plural?"are":"is"} in effect for this role.`
      :`Off. ${gated.join(" and ")} keep${plural?"":"s"} ${plural?"their":"its"} values below but ${plural?"are":"is"} not in effect for this role.`;
    return `<label class="pref-row role-master-row"><span class="pref-text">`
      +`<span class="pref-name">${escape(roleMasterLabel(key))}</span>`
      // Both masters shipped here are enforced today, so this renders nothing. It is here so that a
      // master that ever ships ahead of its feature says so in the same words as every other row,
      // rather than being the one switch on the screen that quietly overstates itself.
      +(roleCatalogPermission(key)?.enforced===false
        ?`<span class="pref-unenforced">Not yet available in Pawsh</span>`:"")
      +`<span class="pref-hint">${escape(hint)}</span></span>`
      +`<input type="checkbox" role="switch" class="pref-toggle" data-role-master="${escapeAttr(key)}" data-testid="role-master"${checked?" checked":""}${rolesEditable()?"":` disabled aria-disabled="true" title="Only an Owner can change what a role grants."`}></label>`;
  }).join("")+`</div>`;
}
function roleEditorRowMarkup(permission,off,{badge:showBadge=true,noteId=null,master=false}={}){
  const editor=rolesState.editor;
  const locked=off||!rolesEditable();
  const checked=editor.selected.has(permission.key);
  const unbuilt=roleUnenforced(permission);
  const hints=[];
  // A master that lives among its own rows behaves unlike its neighbours - it decides whether they
  // apply - and nothing about the row would otherwise say so.
  if(master)hints.push("Turns this whole group on. The rows below keep their values while it is off.");
  if(permission.hint)hints.push(escape(permission.hint));
  // The BADGE stays inside the label, so it stays inside the switch's ACCESSIBLE NAME: "Void a
  // payment, Not yet available in Pawsh" is the fact a screen-reader user needs at the instant of
  // focus, and it is four words. The SENTENCE has moved out to the group note. It was identical on
  // every unbuilt row, and because `.pref-row` is the label, every copy was being read out IN FULL
  // as part of the switch's name, after a badge that had just said the same thing.
  return `<label class="pref-row role-permission-row${off?" is-off":""}${master?" is-group-master":""}" data-testid="role-permission-row"`
    +` data-role-permission-row="${escapeAttr(permission.key)}"${unbuilt?` data-role-unenforced="true"`:""}${master?' data-role-group-master="true"':""}>`
    +`<span class="pref-text"><span class="pref-name">${escape(permission.label||permission.key)}</span>`
    +(unbuilt&&showBadge?`<span class="pref-unenforced">Not yet available in Pawsh</span>`:"")
    +(hints.length?`<span class="pref-hint">${hints.join(" ")}</span>`:"")+`</span>`
    +`<input type="checkbox" role="switch" class="pref-toggle" data-role-permission="${escapeAttr(permission.key)}"`
    +`${checked?" checked":""}`
    // Only where the badge was dropped, so the fact is never announced twice on one control. And
    // never `aria-disabled`: these switches are operable, and that is the entire point of them.
    +`${unbuilt&&!showBadge&&noteId?` aria-describedby="${noteId}"`:""}`
    +`${locked?` disabled aria-disabled="true" title="${off?"Turn the master switch above on to change this.":"Only an Owner can change what a role grants."}"`:""}></label>`;
}
function roleEditorGroupMarkup(group){
  const editor=rolesState.editor;
  const filtering=editor.filter.trim().length>0;
  // Both narrow the sheet, and both break the group note's one precondition - see below.
  const narrowing=filtering||editor.hideUnbuilt;
  const rows=roleEditorRows(group);
  if(narrowing&&!rows.length)return "";
  const off=roleEditorMasterOff(group);
  const all=roleGroupRows(group);
  const granted=all.filter(permission=>editor.selected.has(permission.key)).length;
  // A match folded inside a collapsed group is the one way this screen can lie: it reads as "no
  // results" while the row somebody searched for sits one fold away. A filter therefore forces
  // every matching group open, whatever the master says and whatever was folded earlier.
  // A master switched off folds the group it gates away - UNLESS the group is where that master
  // lives, because folding it would hide the only switch that can turn it back on.
  const owns=roleGroupOwnsMaster(group);
  const open=filtering?true:(off&&!owns)?false:!editor.collapsed.has(group.id);
  // "Off" rather than "0 of 9". The rows keep their values while the master is down, and a zero
  // would claim they had been cleared.
  const count=off?"Off":`${granted} of ${all.length}`;
  const unbuiltGroup=roleGroupUnbuilt(group);
  const unbuiltCount=roleGroupUnenforcedCount(group);
  // ONE STATEMENT PER ROW-IN-CONTEXT. The note speaks for the whole group, so it is only truthful
  // while the whole group is on screen: a filter shows rows out of their group, and hiding removes
  // the very rows it describes. In both cases the note stands down and the per-row badge comes
  // back, so a filtered match is never left unmarked.
  const showNote=!narrowing&&unbuiltCount>0;
  const groupSpeaks=showNote&&unbuiltGroup;   // the summary is saying it for every row
  const noteId=roleGroupNoteId(group);
  const note=showNote?`<p class="role-group-note" id="${noteId}" data-testid="role-group-note">`
    +(unbuiltGroup
      ? `<strong>Pawsh has not built this yet.</strong> None of these switches gates anything today, so leaving one on restricts nobody and turning one off protects nothing. What is set here is saved, and takes effect the day the feature ships.`
      : `<strong>${unbuiltCount} of these ${all.length} are marked “Not yet available in Pawsh”.</strong> Those gate nothing today; what is set for them is saved and takes effect the day the feature ships. The rest are in effect now.`)
    +`</p>`:"";
  const bulk=filtering?["All matching","None matching"]:editor.hideUnbuilt?["All available","None available"]:["All","None"];
  return `<details class="role-group${off?" is-off":""}${unbuiltGroup?" is-unbuilt":""}" data-testid="role-group" data-role-group-panel="${escapeAttr(group.id)}"${unbuiltGroup?` data-role-group-unbuilt="true"`:""}${open?" open":""}>`
    // The badge lives in the `<summary>`, which `<details>` renders whether open or shut, so a
    // folded unbuilt group still announces the fact - which the note alone could never do.
    +`<summary class="role-group-summary"><span class="role-group-heading">`
    +`<span class="role-group-name">${escape(group.label)}</span>`
    +(unbuiltGroup?`<span class="pref-unenforced role-group-unenforced" data-testid="role-group-unenforced">Not yet available in Pawsh</span>`:"")
    +`</span><span class="role-group-count" data-testid="role-group-count">${escape(count)}</span></summary>`
    +note
    +`<div class="role-group-tools">`
    +`<button type="button" class="text-button" data-role-bulk="all" data-role-group="${escapeAttr(group.id)}"${off||!rolesEditable()?" disabled":""}>${bulk[0]}</button>`
    +`<button type="button" class="text-button" data-role-bulk="none" data-role-group="${escapeAttr(group.id)}"${off||!rolesEditable()?" disabled":""}>${bulk[1]}</button></div>`
    +`<div class="role-group-rows">${rows.map(permission=>
      // The master itself is never dimmed by its own off state; every other row in the group is.
      roleEditorRowMarkup(permission,off&&permission.key!==group.masterKey,
        {badge:!groupSpeaks,noteId,master:permission.key===group.masterKey})
    ).join("")}</div></details>`;
}
function roleEditorUnbuiltCount(surface){
  return roleSurfaceGroups(surface).reduce((sum,group)=>sum+roleGroupUnenforcedCount(group),0);
}
function roleEditorFilterSummary(){
  const editor=rolesState.editor;
  const groups=roleSurfaceGroups(editor.surface);
  const term=editor.filter.trim();
  const total=groups.reduce((sum,group)=>sum+roleGroupRows(group).length,0);
  if(!term&&!editor.hideUnbuilt)return `${total} permission${total===1?"":"s"}`;
  const shown=groups.reduce((sum,group)=>sum+roleEditorRows(group).length,0);
  // Hiding says what it took away, in the same breath as what is left. A count that only reported
  // what remained would read as though the sheet had shrunk rather than been narrowed.
  if(!term)return `${shown} of ${total} permissions · ${roleEditorUnbuiltCount(editor.surface)} not built yet, hidden`;
  return shown?`${shown} of ${total} permissions shown`:`No permission matches “${term}”`;
}
/**
 * The groups that vanish entirely while the hide switch is on.
 *
 * Hiding must not make a group DISAPPEAR without saying so - an owner would otherwise conclude the
 * taxonomy has no Cash Drawer at all, and that what a role was set to for it had been discarded.
 * The rows go; the fact that they exist does not.
 */
function roleEditorHiddenNoteMarkup(){
  const editor=rolesState.editor;
  if(!editor.hideUnbuilt)return "";
  const hidden=roleSurfaceGroups(editor.surface).filter(roleGroupUnbuilt).map(group=>group.label);
  if(!hidden.length)return "";
  const many=hidden.length>1;
  const listed=many?`${hidden.slice(0,-1).join(", ")} and ${hidden.at(-1)}`:hidden[0];
  return `<p class="role-hidden-note" data-testid="role-hidden-note">${escape(listed)} `
    +`${many?"are":"is"} not listed while this is on — Pawsh has not built ${many?"them":"it"} yet. `
    +`What this role is set to for ${many?"them":"it"} is unchanged and still saved.</p>`;
}
function roleEditorDirtyCount(){
  const editor=rolesState.editor;
  let count=0;
  for(const key of editor.selected)if(!editor.baseline.has(key))count+=1;
  for(const key of editor.baseline)if(!editor.selected.has(key))count+=1;
  return count;
}
function roleEditorToolsMarkup(){
  const editor=rolesState.editor;
  const unbuilt=roleEditorUnbuiltCount(editor.surface);
  return `<label class="role-filter"><span class="visually-hidden">Filter permissions</span>`
    +`<input type="search" id="role-filter-input" data-testid="role-filter" placeholder="Filter permissions" autocomplete="off" value="${escapeAttr(editor.filter)}"></label>`
    +`<span class="role-filter-count" data-testid="role-filter-count" aria-live="polite">${escape(roleEditorFilterSummary())}</span>`
    // A CHECKBOX, deliberately not a `.pref-toggle`. Every switch on this sheet grants something to
    // a role; a switch here would be the one that does not, sitting directly above seventy-eight
    // that do. And the label says HIDE rather than "show only", because on a screen whose whole job
    // is not to overstate what has been restricted, the verb that admits something is being taken
    // off screen is the honest one.
    +(unbuilt?`<label class="role-hide-unbuilt"><input type="checkbox" id="role-hide-unbuilt" data-testid="role-hide-unbuilt"${editor.hideUnbuilt?" checked":""}>`
      +`<span>Hide what Pawsh has not built yet <small>(${unbuilt})</small></span></label>`:"");
}
function roleEditorBodyMarkup(){
  const editor=rolesState.editor;
  if(editor.conflict)return `<div class="availability-error" data-testid="role-editor-conflict"><h4>Somebody else changed this role</h4>`
    +`<p>${escape(editor.roleName)} was saved by someone else while this was open, so saving now would quietly undo their change. Reload it to start again from what the server holds. The changes made here are not kept.</p>`
    +`<button type="button" class="secondary compact" data-role-editor-reload data-testid="role-editor-reload">Reload the role</button></div>`;
  const rendered=roleSurfaceGroups(editor.surface).map(roleEditorGroupMarkup).join("");
  return (rolesEditable()?"":`<p class="fine roles-readonly" data-testid="role-editor-readonly">Only an Owner can change what a role grants. This is what it grants today.</p>`)
    +(editor.surface==="access"?roleEditorMastersMarkup():"")
    +(rendered||`<p class="roles-empty" data-testid="role-editor-empty">No permission matches this filter.</p>`)
    +roleEditorHiddenNoteMarkup();
}
function renderRoleEditorBody(){
  const body=$("#role-editor-body");if(!body)return;
  body.innerHTML=roleEditorBodyMarkup();
  bindRoleEditorBody(body);
}
// Counts only. Re-rendering the body on every switch would take focus off the switch that was
// just pressed, so the two live regions and the group headings are updated in place instead.
function updateRoleEditorCounts(){
  const editor=rolesState.editor;if(!editor)return;
  for(const group of roleSurfaceGroups(editor.surface)){
    const panel=$(`#role-editor-body [data-role-group-panel="${group.id}"] [data-testid="role-group-count"]`);
    if(!panel)continue;
    const all=roleGroupRows(group);
    panel.textContent=roleEditorMasterOff(group)
      ?"Off"
      :`${all.filter(permission=>editor.selected.has(permission.key)).length} of ${all.length}`;
  }
  const filterCount=$('[data-testid="role-filter-count"]');
  if(filterCount)filterCount.textContent=roleEditorFilterSummary();
  const dirty=roleEditorDirtyCount();
  const dirtyNode=$("#role-editor-dirty");
  if(dirtyNode)dirtyNode.textContent=dirty?`${dirty} change${dirty===1?"":"s"} not saved`:"No changes";
  const save=$('[data-testid="role-editor-save"]');
  if(save)save.disabled=editor.conflict||editor.saving||dirty===0;
}
function renderRoleEditor(){
  const editor=rolesState.editor;if(!editor)return;
  const drawer=$("#role-editor");if(!drawer)return;
  $("#role-editor-eyebrow").textContent=editor.surface==="access"?"Access Control":"Permissions";
  $("#role-editor-title").textContent=editor.roleName;
  const tools=$("#role-editor-tools");
  tools.hidden=editor.conflict;
  tools.innerHTML=editor.conflict?"":roleEditorToolsMarkup();
  if(!editor.conflict)bindRoleEditorTools(tools);
  renderRoleEditorBody();
  $("#role-editor-error").textContent=editor.error||"";
  const save=$('[data-testid="role-editor-save"]');
  save.hidden=!rolesEditable();
  save.textContent=editor.saving?"Saving…":"Save";
  updateRoleEditorCounts();
}
function bindRoleEditorTools(tools){
  const input=tools.querySelector("#role-filter-input");
  if(input)input.addEventListener("input",()=>{
    rolesState.editor.filter=input.value;
    renderRoleEditorBody();
    updateRoleEditorCounts();
  });
  const hide=tools.querySelector("#role-hide-unbuilt");
  // The BODY only, never the tools - re-rendering the tools would pull focus off the checkbox that
  // was just pressed, which is the same reason the filter input redraws the body and not itself.
  // `updateRoleEditorCounts` rewrites `role-filter-count`, which is already `aria-live="polite"`,
  // so the change is announced without a second live region.
  if(hide)hide.addEventListener("change",()=>{
    rolesState.editor.hideUnbuilt=hide.checked;
    renderRoleEditorBody();
    updateRoleEditorCounts();
  });
}
function bindRoleEditorBody(body){
  body.querySelectorAll("[data-role-permission]").forEach(input=>input.addEventListener("change",()=>{
    const key=input.dataset.rolePermission;
    if(input.checked)rolesState.editor.selected.add(key);else rolesState.editor.selected.delete(key);
    // An ordinary row changes nothing but its own value, so the counts are updated in place and
    // focus stays on the switch. A row that is ALSO its group's master decides whether every other
    // row in that group applies, so the group has to be redrawn - and focus put back by hand.
    if(roleSurfaceGroups(rolesState.editor.surface).some(group=>group.masterKey===key)){
      renderRoleEditorBody();updateRoleEditorCounts();
      $(`#role-editor-body [data-role-permission="${key}"]`)?.focus();
      return;
    }
    updateRoleEditorCounts();
  }));
  body.querySelectorAll("[data-role-master]").forEach(input=>input.addEventListener("change",()=>{
    const key=input.dataset.roleMaster;
    if(input.checked)rolesState.editor.selected.add(key);else rolesState.editor.selected.delete(key);
    // Every group this master gates changes state at once, so the body is redrawn and focus put
    // back on the switch that did it.
    renderRoleEditorBody();updateRoleEditorCounts();
    $(`#role-editor-body [data-role-master="${key}"]`)?.focus();
  }));
  body.querySelectorAll("[data-role-bulk]").forEach(button=>button.addEventListener("click",()=>{
    const group=roleCatalogGroups().find(item=>item.id===button.dataset.roleGroup);
    if(!group)return;
    const on=button.dataset.roleBulk==="all";
    // The rows the filter is showing, taken from the catalog rather than from the DOM - so this
    // stays a state operation even though it is scoped to what is on screen.
    for(const permission of roleEditorRows(group)){
      if(on)rolesState.editor.selected.add(permission.key);else rolesState.editor.selected.delete(permission.key);
    }
    renderRoleEditorBody();updateRoleEditorCounts();
    // "None" over a group that holds its own master turns that master off, which disables the very
    // button that was just pressed. Focus then has to land somewhere deliberate - the group's own
    // heading - rather than falling back to <body> and losing the operator's place entirely.
    const pressed=$(`#role-editor-body [data-role-bulk="${button.dataset.roleBulk}"][data-role-group="${group.id}"]`);
    (pressed&&!pressed.disabled?pressed
      :$(`#role-editor-body [data-role-group-panel="${group.id}"] > summary`))?.focus();
  }));
  body.querySelectorAll("[data-role-group-panel]").forEach(details=>details.addEventListener("toggle",()=>{
    const id=details.dataset.roleGroupPanel;
    if(details.open)rolesState.editor.collapsed.delete(id);else rolesState.editor.collapsed.add(id);
  }));
  body.querySelector("[data-role-editor-reload]")?.addEventListener("click",()=>{
    const {roleId,surface}=rolesState.editor;
    openRoleEditor(roleId,surface);
  });
}
async function saveRoleEditor(){
  const editor=rolesState.editor;
  if(!editor||editor.saving||editor.conflict||!rolesEditable()||!roleEditorDirtyCount())return;
  editor.saving=true;editor.error=null;renderRoleEditor();
  try{
    await api(`/api/roles/${encodeURIComponent(editor.roleId)}`,{method:"PATCH",body:JSON.stringify({
      version:editor.version,
      // The whole set, always. Two sheets write this one array and a filter hides rows from the
      // screen, so a payload assembled from what is rendered would drop everything else the role
      // holds.
      permissions:[...editor.selected]
    })});
    editor.saving=false;
    await loadRoles();
    $("#role-editor").close();
    renderRoles();
    toast(`${editor.roleName} saved`);
  }catch(error){
    editor.saving=false;
    // A CODED 409 is a refusal of the change itself, not a concurrency conflict, so it is reported
    // as what it is. The editor never sends `name`, so neither built-in code should reach here -
    // but a stale page is exactly the thing that would, and mislabelling it "somebody else changed
    // this role" would send the operator to reload something that will refuse again.
    if(error.status===409&&!error.data?.code){editor.conflict=true;await loadRoles();renderRoles();}
    else editor.error=error.message;
    renderRoleEditor();
  }
}
function setupRoleEditorDrawer(){
  const drawer=$("#role-editor");if(!drawer)return;
  const close=()=>{
    if(!roleEditorDirtyCount()||rolesState.editor?.conflict){drawer.close();return;}
    openStackedDialog({
      title:"Discard unsaved changes?",
      body:`<p>Nothing has been sent to the server yet, so closing now leaves the role exactly as it was.</p>`,
      confirmLabel:"Discard",dismissLabel:"Keep editing",
      onConfirm:()=>{drawer.close();}
    });
  };
  drawer.querySelector('[data-testid="role-editor-close"]')?.addEventListener("click",close);
  drawer.querySelector('[data-testid="role-editor-cancel"]')?.addEventListener("click",close);
  drawer.querySelector('[data-testid="role-editor-save"]')?.addEventListener("click",()=>runDetached(saveRoleEditor));
  // Escape reaches the dialog as a cancelable `cancel`, which is the only place unsaved work can
  // still be defended. The backdrop click is the dialog itself and never its panel.
  drawer.addEventListener("cancel",event=>{
    if(!rolesState.editor||!roleEditorDirtyCount()||rolesState.editor.conflict)return;
    event.preventDefault();close();
  });
  drawer.addEventListener("click",event=>{if(event.target===drawer)close();});
  drawer.addEventListener("close",()=>{rolesState.editor=null;});
}

// --- People writes -------------------------------------------------------
function openMemberRolePicker(member){
  const roles=roleAssignable();
  if(!roles.length){toast("There is no role to assign yet. Add one first.");return;}
  const current=member.role?.id||member.roleId||"";
  openStackedDialog({
    title:`Role for ${memberDisplayName(member)}`,
    body:`<p>What this person can do is whatever their role grants. Changing it takes effect the next time they load a screen.</p>`
      +`<div class="stacked-dialog-options" data-testid="member-role-options">${roles.map((role,index)=>
        `<label><input type="radio" name="memberRole" value="${escapeAttr(role.id)}"${role.id===current||(!current&&index===0)?" checked":""}> <span>${escape(role.name)}${role.description?`<small>${escape(role.description)}</small>`:""}</span></label>`).join("")}</div>`
      +`<p class="error" role="alert"></p>`,
    confirmLabel:"Save role",dismissLabel:"Cancel",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      const chosen=host.querySelector('input[name="memberRole"]:checked');
      if(!chosen){error.textContent="Choose a role to continue.";return false;}
      try{await api(`/api/members/${encodeURIComponent(member.id)}/role`,{method:"PATCH",body:JSON.stringify({roleId:chosen.value})});}
      catch(problem){error.textContent=problem.message;return false;}
      await refresh();
      if(rolesState.roles)await loadRoles();
      renderRoles();
      toast(`${memberDisplayName(member)} moved`);
      return true;
    }
  });
}
async function removeMember(id){
  const member=(state.members||[]).find(item=>item.id===id);
  const name=member?memberDisplayName(member):"this member";
  openStackedDialog({
    title:`Remove ${name}?`,
    body:`<p>They stop being able to sign in to this workspace. Everything they recorded stays, and stays attributed to them.</p>`
      +`<p class="error" role="alert"></p>`,
    confirmLabel:"Remove access",dismissLabel:"Cancel",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      try{await api(`/api/members/${encodeURIComponent(id)}`,{method:"DELETE"});}
      catch(problem){error.textContent=problem.message;return false;}
      await refresh();toast("Member access removed");return true;
    }
  });
}
function cancelInvitation(invitation){
  openStackedDialog({
    title:`Cancel the invitation to ${invitation.email}?`,
    body:`<p>The link they were sent stops working. Inviting them again issues a new one.</p><p class="error" role="alert"></p>`,
    confirmLabel:"Cancel invitation",dismissLabel:"Keep it",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      try{await api(`/api/members/invitations/${encodeURIComponent(invitation.id)}`,{method:"DELETE"});}
      catch(problem){error.textContent=problem.message;return false;}
      await loadRoleInvitations();renderRoles();toast("Invitation cancelled");return true;
    }
  });
}
// Ownership was a checkbox at the bottom of a 22-checkbox grid, where the most destructive act in
// the product sat one stray click from a save. It is its own two-step action now: choose the
// person, then confirm what it costs, with the consequence spelled out rather than implied.
function openOwnershipTransfer(){
  const candidates=(state.members||[]).filter(member=>!member.isOwner&&String(member.status||"active")==="active");
  if(!candidates.length){toast("Nobody else has active workspace access, so there is nobody to transfer ownership to.");return;}
  openStackedDialog({
    title:"Transfer ownership",
    body:`<p>Ownership is the one thing a role cannot grant: the Owner can do everything, cannot be locked out, and is the only account that can pass it on. Choose who receives it.</p>`
      +`<div class="stacked-dialog-options" data-testid="ownership-candidates">${candidates.map((member,index)=>
        `<label><input type="radio" name="ownershipCandidate" value="${escapeAttr(member.id)}"${index===0?" checked":""}> <span>${escape(memberDisplayName(member))}<small>${escape(member.email)}</small></span></label>`).join("")}</div>`,
    confirmLabel:"Continue",dismissLabel:"Cancel",
    onConfirm:host=>{
      const chosen=host.querySelector('input[name="ownershipCandidate"]:checked');
      if(!chosen)return false;
      const member=candidates.find(candidate=>candidate.id===chosen.value);
      // Both steps use the one stacked dialog, and showModal() throws on a dialog already open,
      // so the second waits for the first to finish closing - the same hand-off the shared modal
      // uses everywhere else.
      setTimeout(()=>confirmOwnershipTransfer(member),50);
      return true;
    }
  });
}
// What one role would leave the outgoing owner holding, in the salon's own words.
// The same builder's twin, with the same mis-casing for the same reason - see `roleLossSentence`.
function roleKeepSentence(role){
  const labels=roleLabelList(role);
  if(!labels.length)return "Grants nothing at all. You would keep an account and no access.";
  return `Lets you: ${labels.join(", ")}.`;
}
function confirmOwnershipTransfer(member){
  if(!member)return;
  const name=memberDisplayName(member);
  const roles=roleAssignable();
  // Ownership is not a role, so it cannot simply be handed over: the outgoing owner has to land
  // somewhere, and the server refuses the transfer outright without a role for them. Better to say
  // that here than to let the confirm 404.
  if(!roles.length){toast("Add a role first. Ownership cannot be transferred until there is one for you to keep.");return;}
  openStackedDialog({
    title:`Make ${name} the owner?`,
    body:`<p data-testid="ownership-consequence"><strong>${escape(name)}</strong> (${escape(member.email)}) becomes the Owner of this workspace. Your account stops being the Owner, and from then on only they can transfer it — including back to you.</p>`
      +`<p>Ownership is not a role, so yours cannot be handed over with it. Choose what you will hold once you are no longer the Owner.</p>`
      +`<div class="stacked-dialog-options" data-testid="ownership-outgoing-roles">${roles.map((role,index)=>
        `<label><input type="radio" name="outgoingOwnerRole" value="${escapeAttr(role.id)}"${index===0?" checked":""}> <span>${escape(role.name)}<small>${escape(roleKeepSentence(role))}</small></span></label>`).join("")}</div>`
      +`<p class="error" role="alert"></p>`,
    confirmLabel:"Transfer ownership",dismissLabel:"Cancel",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      const chosen=host.querySelector('input[name="outgoingOwnerRole"]:checked');
      if(!chosen){error.textContent="Choose the role you will keep.";return false;}
      try{
        await api("/api/business/transfer-ownership",{method:"POST",body:JSON.stringify({
          membershipId:member.id,outgoingOwnerRoleId:chosen.value})});
        state.me=await api("/api/me");
      }catch(problem){error.textContent=problem.message;return false;}
      // Ownership has just left this session, so what this screen may show has changed with it.
      // Dropping the cache and re-rendering the category re-evaluates the team.manage gate rather
      // than leaving a table of controls this account can no longer use.
      rolesState.roles=null;rolesState.catalog=null;rolesState.error=null;
      applyPermissions();
      await refresh();
      renderSettingsCategory("permissions",{history:"none"});
      toast(`${name} is now the owner`);
      return true;
    }
  });
}
// Approving grants access, so it has to say what access. The old flow approved into whatever the
// server chose and told nobody.
function openAccessRequestApproval(request){
  const roles=roleAssignable();
  if(!roles.length){toast("There is no role to approve them into yet. Add one first.");return;}
  openStackedDialog({
    title:`Approve ${request.requesterName}?`,
    body:`<p>${escape(request.requesterEmail)} gets a secure setup link and the role chosen here.</p>`
      +`<div class="stacked-dialog-options" data-testid="access-request-roles">${roles.map((role,index)=>
        `<label><input type="radio" name="accessRequestRole" value="${escapeAttr(role.id)}"${index===0?" checked":""}> <span>${escape(role.name)}</span></label>`).join("")}</div>`
      +`<p class="error" role="alert"></p>`,
    confirmLabel:"Approve",dismissLabel:"Cancel",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      const chosen=host.querySelector('input[name="accessRequestRole"]:checked');
      if(!chosen){error.textContent="Choose a role to continue.";return false;}
      let result;
      try{result=await api(`/api/workspace-access-requests/${encodeURIComponent(request.id)}/approve`,{method:"POST",body:JSON.stringify({roleId:chosen.value})});}
      catch(problem){error.textContent=problem.message;return false;}
      let copied=false;
      if(result?.acceptancePath&&navigator.clipboard){
        try{await navigator.clipboard.writeText(`${location.origin}${result.acceptancePath}`);copied=true;}catch{copied=false;}
      }
      await refresh();
      if(rolesState.roles)await loadRoles();
      await loadRoleInvitations();
      renderRoles();
      toast(copied?"Approved; secure setup link copied":"Approved; the requester invitation was queued");
      return true;
    }
  });
}
function confirmRejectAccessRequest(request){
  openStackedDialog({
    title:`Reject ${request.requesterName}?`,
    body:`<p>They get no access and no link. They can request access again.</p><p class="error" role="alert"></p>`,
    confirmLabel:"Reject",dismissLabel:"Cancel",
    onConfirm:async host=>{
      const error=host.querySelector(".error");error.textContent="";
      try{await api(`/api/workspace-access-requests/${encodeURIComponent(request.id)}/reject`,{method:"POST"});}
      catch(problem){error.textContent=problem.message;return false;}
      await refresh();renderRoles();toast("Access request rejected");return true;
    }
  });
}

function closeRolesMenu(menu){menu.open=false;menu.querySelector("summary")?.setAttribute("aria-expanded","false");}
// `.roles-menu` is the settings workspaces' shared row menu - Roles opened it, Coupons & discounts
// reuses it - so the dismissal is scoped to the class rather than to one root. Scoping it to
// `#roles-root` would have left the discounts menus with no way to close but a second click on
// their own trigger.
function closeRolesMenus(){$$(".roles-menu[open]").forEach(closeRolesMenu);}
// Bound once on the document, not on the root: the workspace is rebuilt on every write, and a
// listener per render would stack up. Escape has to reach these too - a menu that only closes by
// clicking elsewhere is a keyboard trap in everything but name.
let rolesMenusBound=false;
function bindRolesMenuDismissal(){
  if(rolesMenusBound)return;rolesMenusBound=true;
  document.addEventListener("click",event=>{if(!event.target.closest?.(".roles-menu"))closeRolesMenus();});
  document.addEventListener("keydown",event=>{
    if(event.key!=="Escape")return;
    const open=$(".roles-menu[open]");
    if(!open)return;
    event.preventDefault();
    const trigger=open.querySelector("summary");
    closeRolesMenu(open);trigger?.focus();
  });
}
// --- Binding -------------------------------------------------------------
function bindRoles(root){
  bindRolesMenuDismissal();
  // Arrows move focus, Enter and Space commit, matching the Tax & payments tablist. Activating on
  // focus would swap the panel out from under somebody simply passing along the bar.
  root.querySelector('[role="tablist"]')?.addEventListener("keydown",event=>{
    const buttons=[...root.querySelectorAll("[data-roles-tab]")],index=buttons.indexOf(document.activeElement);
    if(index<0)return;
    if(event.key==="Enter"||event.key===" "||event.key==="Spacebar"){event.preventDefault();selectRolesTab(buttons[index].dataset.rolesTab);return;}
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();
    const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
    buttons[next]?.focus();
  });
  root.querySelectorAll("[data-roles-tab]").forEach(button=>button.addEventListener("click",()=>selectRolesTab(button.dataset.rolesTab,{focus:false})));
  root.querySelector("[data-roles-retry]")?.addEventListener("click",()=>{
    rolesState.error=null;rolesState.roles=null;rolesState.catalog=null;renderRoles();ensureRolesData();
  });
  const role=id=>(rolesState.roles||[]).find(item=>item.id===id);
  root.querySelectorAll("[data-role-open]").forEach(button=>button.addEventListener("click",()=>
    openRoleEditor(button.dataset.roleOpen,button.dataset.roleSurface)));
  root.querySelectorAll("[data-role-enabled]").forEach(input=>input.addEventListener("change",()=>{
    const target=role(input.dataset.roleEnabled);
    if(target)toggleRoleEnabled(target,input.checked);
  }));
  root.querySelector("[data-role-add]")?.addEventListener("click",()=>openRoleCreate());
  root.querySelectorAll("[data-role-rename]").forEach(button=>button.addEventListener("click",()=>{
    const target=role(button.dataset.roleRename);if(target)openRoleRename(target);
  }));
  root.querySelectorAll("[data-role-duplicate]").forEach(button=>button.addEventListener("click",()=>{
    const target=role(button.dataset.roleDuplicate);
    if(target)openRoleCreate({copyFromRoleId:target.id,name:`${target.name} copy`});
  }));
  root.querySelectorAll("[data-role-delete]").forEach(button=>button.addEventListener("click",()=>{
    const target=role(button.dataset.roleDelete);if(target)confirmDeleteRole(target);
  }));
  root.querySelector("[data-roles-invite]")?.addEventListener("click",()=>runDetached(()=>actions["invite-member"]()));
  root.querySelectorAll("[data-member-role]").forEach(button=>button.addEventListener("click",()=>{
    const member=(state.members||[]).find(item=>item.id===button.dataset.memberRole);
    if(member)openMemberRolePicker(member);
  }));
  root.querySelectorAll("[data-member-remove]").forEach(button=>button.addEventListener("click",()=>
    runDetached(()=>removeMember(button.dataset.memberRemove))));
  root.querySelector("[data-member-transfer]")?.addEventListener("click",openOwnershipTransfer);
  root.querySelectorAll("[data-invitation-cancel]").forEach(button=>button.addEventListener("click",()=>{
    const invitation=rolesState.invitations.find(item=>item.id===button.dataset.invitationCancel);
    if(invitation)cancelInvitation(invitation);
  }));
  const accessRequest=id=>(state.accessRequests||[]).find(item=>item.id===id);
  root.querySelectorAll("[data-access-approve]").forEach(button=>button.addEventListener("click",()=>{
    const request=accessRequest(button.dataset.accessApprove);if(request)openAccessRequestApproval(request);
  }));
  root.querySelectorAll("[data-access-reject]").forEach(button=>button.addEventListener("click",()=>{
    const request=accessRequest(button.dataset.accessReject);if(request)confirmRejectAccessRequest(request);
  }));
  // The row menus reuse the client directory's `.row-menu`, whose list is positioned absolutely
  // here rather than fixed, so it needs no placement pass - only the usual close-the-others.
  root.querySelectorAll(".roles-menu").forEach(menu=>menu.addEventListener("toggle",()=>{
    menu.querySelector("summary")?.setAttribute("aria-expanded",String(menu.open));
    if(!menu.open)return;
    root.querySelectorAll(".roles-menu[open]").forEach(other=>{if(other!==menu)closeRolesMenu(other);});
  }));
  root.querySelectorAll(".roles-menu .row-menu-item").forEach(button=>button.addEventListener("click",closeRolesMenus));
}

// ---------------------------------------------------------------------------
// Settings → Business
//
// Five tabs over one panel, on the Tax & payments pattern: `.settings-tabs`, a single
// `#business-panel` tabpanel, module state, `render*` + `ensure*Data`. Two of the tabs are
// working surfaces and three state their own absence in sentences.
//
// Both working surfaces exist to close the same class of bug, which is why nothing here renders
// a value it has not read and nothing here sends a field the operator did not touch:
//
//   - The retired hours dialog drew a hardcoded Mon-Fri 09:00-17:00 without ever calling
//     GET /api/business/working-hours, and the PUT is a delete-then-insert over the whole
//     location. Opening it and pressing Save replaced a real week with a fabricated one. So the
//     grid here renders NOTHING until the read resolves, and says so while it waits.
//   - `businessSettingsSchema` is a MERGE, not a whole-object write: an omitted field keeps the
//     stored value and an explicit null clears it. The payload below therefore carries `phone`,
//     `email`, `address` and `currency` only when the operator actually moved them. `currency`
//     matters most - a workspace holding a code from before the supported list existed can still
//     rename itself, because an untouched picker sends nothing to be held to that list.
// ---------------------------------------------------------------------------
const BUSINESS_TABS=[
  ["info","Info"],["number","Pawsh Number"],["domain","Domain"],
  ["hours","Business Hours"],["billing","Business Billing"]
];
// Sunday first, matching `business_hours.weekday` and the calendar's `dateAt(day).getUTCDay()`.
const BUSINESS_WEEKDAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const businessState={
  tab:"info",draft:null,fieldErrors:{},submitted:false,saving:false,status:"",error:null,stale:false,
  // The two picker filters are view state, not draft state: narrowing a list of 132 codes is not
  // an unsaved change and must never make the Save button light up.
  filters:{currency:"",timezone:""},
  hours:null,hoursDraft:null,hoursBaseline:null,hoursError:null,hoursLoading:false,
  hoursSubmitted:false,hoursSaving:false,hoursStatus:"",hoursSaveError:""
};

function businessRecord(){return state.me?.business||{};}

// The six enum vocabularies, in the order Amanda's reference lists them. The values are the
// server's tuples verbatim; the labels are the operator's words. `hourFormat` is the STRING "12" /
// "24", not a number - it is stored as text and the schema compares it as text.
const BUSINESS_TYPES=[["mobile","Mobile"],["salon","Salon"],["hybrid","Hybrid (mobile + salon)"]];
const BUSINESS_DATE_FORMATS=[["MM/DD/YYYY","MM/DD/YYYY"],["DD/MM/YYYY","DD/MM/YYYY"]];
const BUSINESS_HOUR_FORMATS=[["12","12 Hours"],["24","24 Hours"]];
const BUSINESS_WEIGHT_UNITS=[["lb","Lb"],["kg","Kg"]];
const BUSINESS_APPOINTMENT_LOCKS=[["enabled","Enable Lock"],["disabled","Disable Lock"]];
// `couponStacking` USED TO BE HERE, and it is deliberately not any more. Two columns carried the
// same three-valued rule: `discount_stacking_mode`, which every discount calculation reads and
// which really does decide whether two discounts come to $72 or $70, and `coupon_stacking`, which
// had no money consumers at all - the route that wrote it read it back only to name it in the
// audit entry. The screen rendered the second one under "How to apply multiple coupons" beside a
// note saying the choice would take effect when coupons shipped. Coupons shipped. An operator who
// set this control changed nothing about any bill and was told it worked.
//
// THE SURVIVING CONTROL IS THE DISCOUNTS SCREEN'S, which writes `discount_stacking_mode` through
// `PUT /api/settings/discount-stacking`. Exactly one control in the product may represent this
// rule, and it is the one attached to the authority that governs the money. That also moves the
// permission: stacking is `settings.discounts` now, not `settings.manage`.
// `null` is the value **All**, not "unset", so the select carries `All` as a literal. The schema
// takes it case-insensitively and returns it as null, which is why the option's value can be
// posted straight through without a second representation to keep in step.
const BUSINESS_UPCOMING_COUNTS=[["All","All"],...Array.from({length:20},(unused,index)=>
  [String(index+1),`${index+1} appointment${index?"s":""}`])];

const BUSINESS_ENUM_FIELDS=[
  ["businessType",BUSINESS_TYPES],["dateFormat",BUSINESS_DATE_FORMATS],
  ["hourFormat",BUSINESS_HOUR_FORMATS],["weightUnit",BUSINESS_WEIGHT_UNITS],
  ["appointmentLock",BUSINESS_APPOINTMENT_LOCKS]
];
// Every nullable free-text column, in one list, because the merge rule treats them identically:
// omitted preserves, blank clears, a value stores.
const BUSINESS_TEXT_FIELDS=[
  "phone","email","address","website","socialFacebook","socialGoogle","socialYelp"
];
const BUSINESS_URL_FIELDS=[
  ["website","Website"],["socialFacebook","Facebook"],["socialGoogle","Google"],["socialYelp","Yelp"]
];

/** The saved record as the form's own strings, so "dirty" is one comparison rather than twenty. */
function businessStoredValues(){
  const record=businessRecord();
  const text=key=>String(record[key]??"");
  const values={
    name:text("name"),timezone:text("timezone"),
    currency:text("currency").toUpperCase(),
    reminderHours:String(Number(record.reminderLeadMinutes??0)/60),
    // `String(null)` is the literal "null", so All is mapped explicitly rather than coerced.
    upcomingAppointmentCount:record.upcomingAppointmentCount===null||record.upcomingAppointmentCount===undefined
      ?"All":String(record.upcomingAppointmentCount),
    defaultServiceFrequencyWeeks:record.defaultServiceFrequencyWeeks===null||record.defaultServiceFrequencyWeeks===undefined
      ?"":String(record.defaultServiceFrequencyWeeks)
  };
  for(const key of BUSINESS_TEXT_FIELDS)values[key]=text(key);
  // The six columns are `not null` behind check constraints, so a stored value is always in its
  // tuple. A row that somehow sat outside one falls back to the tuple's first entry rather than
  // rendering a select with nothing selected and silently posting whatever the browser picked.
  for(const [key,options] of BUSINESS_ENUM_FIELDS){
    const stored=text(key);
    values[key]=options.some(([value])=>value===stored)?stored:options[0][0];
  }
  return values;
}
function businessDraft(){
  if(!businessState.draft)businessState.draft=businessStoredValues();
  return businessState.draft;
}
function businessInfoDirty(){
  const draft=businessDraft(),stored=businessStoredValues();
  return Object.keys(stored).some(key=>draft[key]!==stored[key]);
}
// The lead time is a whole-hours control and `reminder_lead_minutes` is minutes. A stored value
// that is not a whole number of hours cannot be expressed here, so an UNTOUCHED field round-trips
// the stored minutes rather than being validated against a granularity it never claimed - which
// is also what stops such a workspace from being unable to save its own name.
function businessReminderTouched(){return businessDraft().reminderHours!==businessStoredValues().reminderHours;}

/**
 * What the currency picker may offer, answered by the server.
 *
 * `/api/me` reports `supportedCurrencies` - 132 codes, already sorted - from the same domain tuple
 * `businessSettingsSchema` validates against, so the picker and the server derive from one
 * declaration and no list is restated here. The stored value is appended when the list does not
 * carry it: a workspace on a legacy code must be able to see what it is set to, and the payload
 * simply omits an untouched picker.
 */
function businessCurrencyOptions(){
  const supported=Array.isArray(state.me?.supportedCurrencies)
    ?state.me.supportedCurrencies.map(code=>String(code).toUpperCase()):[];
  const stored=businessStoredValues().currency;
  const list=supported.length?[...supported]:(stored?[stored]:["USD"]);
  if(stored&&!list.includes(stored))list.push(stored);
  return list;
}
// Through `formatMinor`, because this line is a PROMISE ABOUT HOW PRICES WILL READ and had to be
// made by the formatter that will read them. Formatting 1234.56 independently claimed "COP 1,235"
// for a workspace whose invoices go on saying "COP 1,234.56".
function businessCurrencySample(code){
  return `Prices read ${formatMinor(123456,code)}.`;
}
function businessTimeZoneList(){
  try{return typeof Intl.supportedValuesOf==="function"?Intl.supportedValuesOf("timeZone"):[];}
  catch{return [];}
}
function businessTimeZoneOptions(value){
  const zones=businessTimeZoneList();
  if(!zones.length)return null;
  // A zone this runtime does not list is kept as an option rather than silently rewritten by the
  // next save - the same rule the pet species select follows.
  return !value||zones.includes(value)?zones:[...zones,value].sort();
}
// An identifier nobody can verify is worth nothing, so the hint says what time it is there now -
// on the workspace's own clock, so a salon on 24 Hours is not told "3:42 PM".
function businessTimeZoneNow(zone){
  if(!zone)return "Choose the timezone this salon's appointment times are read in.";
  try{return `It is ${formatPrefTime(new Date(),zone)} in ${zone} right now.`;}
  catch{return `Pawsh cannot read the current time in ${zone}. It is saved exactly as written.`;}
}

/**
 * A FILTER OVER A NATIVE SELECT, not a custom combobox.
 *
 * 132 currencies and roughly 420 zones both need narrowing, and Amanda's reference shows a filter
 * affordance on each. Keeping the `<select>` keeps its keyboard behaviour, its mobile wheel picker,
 * its form value and its accessible name for free; a `role="listbox"` with `aria-activedescendant`
 * would have to reimplement all four to arrive back where it started, and would be the second
 * combobox idiom in a codebase that already has one.
 *
 * The count line is `role="status"` so narrowing 132 codes to 3 is audible, not only visible.
 */
const BUSINESS_PICKERS={
  currency:{plural:"currencies"},
  timezone:{plural:"timezones",grouped:true}
};
function businessPickerSource(key){
  return key==="currency"?businessCurrencyOptions():(businessTimeZoneOptions(businessDraft().timezone)||[]);
}
function businessPickerMatches(key,query){
  const all=businessPickerSource(key),needle=String(query||"").trim().toLowerCase();
  if(!needle)return {options:all,total:all.length,filtered:false};
  const selected=businessDraft()[key];
  const matched=all.filter(value=>value.toLowerCase().includes(needle));
  // The selected value never leaves the list. A filter that hid it would leave the select
  // reporting whichever option the browser fell back to, and the next save would store that.
  if(selected&&!matched.includes(selected))matched.unshift(selected);
  return {options:matched,total:all.length,filtered:true};
}
function businessPickerOptionsMarkup(key,options,selected){
  const render=value=>`<option value="${escapeAttr(value)}"${value===selected?" selected":""}>${escape(value)}</option>`;
  if(!BUSINESS_PICKERS[key].grouped)return options.map(render).join("");
  const groups=new Map();
  for(const value of options){
    const region=value.includes("/")?value.slice(0,value.indexOf("/")):"Other";
    if(!groups.has(region))groups.set(region,[]);
    groups.get(region).push(value);
  }
  return [...groups].map(([region,items])=>`<optgroup label="${escapeAttr(region)}">`
    +items.map(render).join("")+`</optgroup>`).join("");
}
function businessPickerCountText(key,result){
  const {plural}=BUSINESS_PICKERS[key];
  return result.filtered
    ?`${result.options.length} of ${result.total} ${plural} shown.`
    :`${result.total} ${plural}.`;
}
function businessPickerMarkup(key,testId){
  const draft=businessDraft(),config=BUSINESS_PICKERS[key];
  const query=businessState.filters[key]||"";
  const result=businessPickerMatches(key,query);
  return `<span class="business-picker" data-business-picker="${key}">`
    +`<input type="search" class="business-picker-filter" data-business-filter="${key}"`
    +` data-testid="${testId}-filter" autocomplete="off" spellcheck="false"`
    +` placeholder="Filter ${escapeAttr(config.plural)}" aria-label="Filter ${escapeAttr(config.plural)}"`
    +` aria-controls="business-${key}-select" value="${escapeAttr(query)}">`
    +`<select id="business-${key}-select" name="${key}" data-business-field="${key}"`
    +` data-testid="${testId}"${businessInvalidAttrs(key)}>`
    +businessPickerOptionsMarkup(key,result.options,draft[key])
    +`</select>`
    +`<span class="field-hint business-picker-count" role="status" data-testid="${testId}-count">`
    +`${escape(businessPickerCountText(key,result))}</span>`
    +`</span>`;
}

function businessTabsMarkup(){
  return `<div class="settings-tabs" role="tablist" aria-label="Business" data-testid="business-tabs">`
    +BUSINESS_TABS.map(([id,label])=>{
      const active=businessState.tab===id;
      return `<button type="button" role="tab" id="business-tab-${id}" class="settings-tab${active?" active":""}"`
        +` data-business-tab="${id}" data-testid="business-tab-${id}" aria-selected="${active}"`
        +` aria-controls="business-panel" tabindex="${active?0:-1}">${escape(label)}</button>`;
    }).join("")
    +`</div>`;
}
function businessPanelMarkup(body,{focusable=false}={}){
  return `<div id="business-panel" role="tabpanel" class="business-panel"`
    +` aria-labelledby="business-tab-${businessState.tab}" data-testid="business-panel"`
    +`${focusable?` tabindex="0"`:""}>${body}</div>`;
}

// --- The three unavailable tabs ------------------------------------------
// Static prose, and deliberately nothing else. A disabled input, a greyed select, an empty table
// or a skeleton would each assert the capability exists and is merely pending. The eyebrow is
// `Not available` rather than `Coming soon` for the same reason - these are standing deferrals,
// not a delivery date Pawsh is withholding.
const BUSINESS_UNAVAILABLE={
  number:{
    title:"Pawsh Number",
    body:[
      "Pawsh does not provide phone numbers. There is no telephony behind it — no number to rent, no calls to route, and no inbox for two-way SMS — so there is nothing here to claim or configure.",
      "The number clients call is your own line, recorded on Info so staff can find it. Nothing a client sends to it by text reaches Pawsh. The one message Pawsh sends on its own is the appointment reminder, and its timing is set by the reminder lead time on Info."
    ],
    pointer:["automated-messages","Open Automated messages"]
  },
  domain:{
    title:"Domain",
    body:[
      "Pawsh has no public client surface, so there is no address to point a domain at. Online booking, intake forms and agreement signing are all deferred, which means there is no page a client could open — a custom domain here would resolve to nothing.",
      "Every appointment is booked by the salon. Pawsh is reached at the address your staff sign in on, and that address is not configurable per salon."
    ],
    pointer:null
  },
  billing:{
    title:"Business Billing",
    body:[
      "Pawsh does not charge for itself from inside the product. There is no card on file, no plan and no invoice history here, because Pawsh stores no card-not-present payment credentials of its own — recurring billing against a stored card is deliberately not something it does. What this workspace is charged is arranged directly, outside Pawsh.",
      "Taking payment from clients is a different thing and is real: payment methods, tax rates and card processors are configured under Tax & payments."
    ],
    pointer:["tax-payments","Open Tax &amp; payments"]
  }
};
function businessUnavailableMarkup(tab){
  const entry=BUSINESS_UNAVAILABLE[tab];
  return `<article class="settings-panel settings-placeholder business-unavailable" data-testid="business-unavailable">`
    +`<p class="eyebrow">Not available</p><h3>${escape(entry.title)}</h3>`
    +entry.body.map(paragraph=>`<p>${escape(paragraph)}</p>`).join("")
    +(entry.pointer?`<p class="business-unavailable-elsewhere">`
      +`<button type="button" class="text-button" data-settings-goto="${entry.pointer[0]}">${entry.pointer[1]}</button></p>`:"")
    +`</article>`;
}

// --- Info ----------------------------------------------------------------
function businessFieldErrorMarkup(name){
  const message=businessState.fieldErrors[name];
  return `<p class="error business-field-error" id="business-error-${name}" data-testid="business-field-error-${name}" role="alert">${message?escape(message):""}</p>`;
}
function businessInvalidAttrs(name){
  return businessState.fieldErrors[name]?` aria-invalid="true" aria-describedby="business-error-${name}"`:"";
}
// Mark the exception, not the rule: the two required fields carry `required` and no adornment, and
// every optional field carries the visible chip. This is the Staff form's convention.
const BUSINESS_OPTIONAL=`<span class="staff-optional">Optional</span>`;

/**
 * A settings row whose behaviour Pawsh has not built.
 *
 * The voice is the three unavailable tabs': what Pawsh does not have, stated flatly, then what the
 * control does anyway. No date, no "coming soon", no apology. A control that stores a preference
 * for a capability that does not exist is defensible; one that lets the operator believe the
 * capability exists is not, and the difference is entirely in this sentence.
 */
function businessPendingNote(testId,text){
  return `<span class="field-hint business-pending-note" data-testid="${testId}">${escape(text)}</span>`;
}
/** One `<select>` over a fixed vocabulary, with the form's one hint placement. */
function businessSelectField(key,label,options,{testId,hint="",note="",required=false}={}){
  const draft=businessDraft();
  return `<label>${escape(label)}`
    +`<select name="${key}" data-business-field="${key}" data-testid="${testId}"`
    +`${required?" required":""}${businessInvalidAttrs(key)}>`
    +options.map(([value,text])=>`<option value="${escapeAttr(value)}"${draft[key]===value?" selected":""}>${escape(text)}</option>`).join("")
    +`</select>`
    +(hint?`<span class="field-hint">${escape(hint)}</span>`:"")
    +note
    +businessFieldErrorMarkup(key)
    +`</label>`;
}
/** One free-text control. `optional` renders the chip; `hint` is the sentence beneath it. */
function businessTextField(key,label,{type="text",testId,hint="",maxlength=255,optional=true,extra=""}={}){
  const draft=businessDraft();
  return `<label>${escape(label)}${optional?` ${BUSINESS_OPTIONAL}`:""}`
    +`<input type="${type}" name="${key}" data-business-field="${key}" data-testid="${testId}"`
    +` maxlength="${maxlength}" autocomplete="off"${extra} value="${escapeAttr(draft[key])}"${businessInvalidAttrs(key)}>`
    +(hint?`<span class="field-hint">${escape(hint)}</span>`:"")
    +businessFieldErrorMarkup(key)
    +`</label>`;
}

function businessInfoStatusText(){
  if(businessState.saving)return "Saving…";
  // Field errors carry an invalid submit, so the foot stays quiet: one message per problem.
  if(Object.keys(businessState.fieldErrors).length)return "";
  if(businessInfoDirty())return "Unsaved changes.";
  return businessState.status;
}
function businessInfoMarkup(){
  const draft=businessDraft();
  const zoneOptions=businessTimeZoneOptions(draft.timezone);
  const timezoneControl=zoneOptions
    ?businessPickerMarkup("timezone","business-timezone")
    // A picker that cannot be populated is worse than the field it replaced, so the free-text
    // input stays as the fallback rather than shipping an empty select - and with no filter over
    // it, because there is nothing to filter.
    :`<input type="text" name="timezone" data-business-field="timezone" data-testid="business-timezone" maxlength="80" autocomplete="off" value="${escapeAttr(draft.timezone)}"${businessInvalidAttrs("timezone")}>`;
  const foot=`<div class="business-form-foot">`
    +`<p class="business-form-status" role="status" data-testid="business-status">${escape(businessInfoStatusText())}</p>`
    +`<p class="error" role="alert" data-testid="business-error">${businessState.error?escape(businessState.error):""}</p>`
    +(businessState.stale?`<button type="button" class="secondary compact" data-business-reload data-testid="business-reload">Reload saved values</button>`:"")
    +`<button type="submit" class="primary compact" data-testid="business-save"${businessInfoDirty()&&!businessState.saving?"":" disabled"}>${businessState.saving?"Saving…":"Save changes"}</button>`
    +`</div>`;
  return `<form class="business-form" data-business-form${businessState.saving?` aria-busy="true"`:""} novalidate>`
    +`<section class="settings-panel">`
      +`<h3>Business info</h3>`
      +`<p class="panel-note">What this salon is called, how the salon itself is reached, and how it operates. None of it is shown to clients — Pawsh has no client-facing surface.</p>`
      +`<div class="business-field-grid">`
        +`<label>Salon name`
          +`<input type="text" name="name" data-business-field="name" data-testid="business-name" required minlength="2" maxlength="120" autocomplete="off" value="${escapeAttr(draft.name)}"${businessInvalidAttrs("name")}>`
          +`<span class="field-hint">Appears in the header, on invoices and on receipts.</span>`
          +businessFieldErrorMarkup("name")
        +`</label>`
        +businessTextField("phone","Phone",{type:"tel",testId:"business-phone",maxlength:40,
          extra:` inputmode="tel"`,
          hint:"Kept so staff can reach the salon. Pawsh never calls or texts it."})
        +businessTextField("website","Website",{type:"url",testId:"business-website",maxlength:500,
          extra:` inputmode="url"`,
          hint:"A bare address is stored with https:// in front of it. Web links only."})
        +businessTextField("email","Email",{type:"email",testId:"business-email",maxlength:320,
          hint:"Where salon correspondence goes. Not a login — sign-in emails are on each person's account."})
        // A textarea rather than an input: 500 characters scroll out of sight in a single line,
        // and an operator cannot proof-read what they cannot see.
        +`<label class="business-field-wide">Address ${BUSINESS_OPTIONAL}`
          +`<textarea name="address" rows="2" data-business-field="address" data-testid="business-address" maxlength="500"${businessInvalidAttrs("address")}>${escape(draft.address)}</textarea>`
          +`<span class="field-hint">One free-text line, written however this salon writes it. Pawsh does not parse or geocode it.</span>`
          +businessFieldErrorMarkup("address")
        +`</label>`
        // Required and non-emptyable: the column is `not null`, so there is no state in which the
        // operator is choosing "none", and a blank option would offer one.
        +businessSelectField("businessType","Business type",BUSINESS_TYPES,{
          testId:"business-type",required:true,
          hint:"Whether this salon travels to the pet, works from a fixed address, or does both."})
      +`</div>`
    +`</section>`
    +`<section class="settings-panel">`
      +`<h3>Preferences</h3>`
      +`<p class="panel-note">How Pawsh reads times, money and weights for this location. Every one of these changes what is on screen, not what is stored.</p>`
      +`<div class="business-field-grid">`
        +`<label>Currency${businessPickerMarkup("currency","business-currency")}`
          +`<span class="field-hint" data-testid="business-currency-sample">${escape(businessCurrencySample(draft.currency))}</span>`
          +businessFieldErrorMarkup("currency")
        +`</label>`
        +businessSelectField("dateFormat","Date format",BUSINESS_DATE_FORMATS,{
          testId:"business-date-format",
          hint:"The order every date is written in, on screen and in the mail Pawsh sends."})
        +businessSelectField("hourFormat","Hour format",BUSINESS_HOUR_FORMATS,{
          testId:"business-hour-format",
          hint:"Whether times read 3:30 PM or 15:30."})
        +businessSelectField("weightUnit","Weight unit",BUSINESS_WEIGHT_UNITS,{
          testId:"business-weight-unit",
          hint:"Pet weights and the pricing tier captions both move to this unit. No price and no tier changes."})
        // A real setting with real enforcement, so it carries an ordinary hint rather than the
        // caveat treatment the two inert preferences below and above it use.
        +businessSelectField("appointmentLock","Lock date/time for appointments",BUSINESS_APPOINTMENT_LOCKS,{
          testId:"business-appointment-lock",
          hint:"Enable Lock stops appointments being moved: nobody can change when one starts or who is assigned to it, and drag-to-reschedule leaves the calendar. Everything else stays editable, new appointments can still be booked, and the lock applies to owners too."})
        +`<label>Timezone${timezoneControl}`
          +`<span class="field-hint" data-testid="business-timezone-now">${escape(businessTimeZoneNow(draft.timezone))}</span>`
          +businessFieldErrorMarkup("timezone")
        +`</label>`
        +businessSelectField("upcomingAppointmentCount","Upcoming appointment count",BUSINESS_UPCOMING_COUNTS,{
          testId:"business-upcoming-count",
          hint:"How many appointments are shown in the sent-out upcoming link.",
          note:businessPendingNote("business-note-upcoming-count",
            "Pawsh has no send-out link — there is no public page a client could open. The count is stored now and takes effect when there is one.")})
        // The number-plus-unit idiom the reminder lead time already uses, so two quantities on the
        // same card are not two different shapes.
        +`<label>Default service frequency ${BUSINESS_OPTIONAL}`
          +`<span class="pref-frequency">`
            +`<input type="number" name="defaultServiceFrequencyWeeks" data-business-field="defaultServiceFrequencyWeeks" data-testid="business-service-frequency" min="1" max="104" step="1" value="${escapeAttr(draft.defaultServiceFrequencyWeeks)}"${businessInvalidAttrs("defaultServiceFrequencyWeeks")}>`
            +`<span class="pref-unit">Weeks</span>`
          +`</span>`
          +`<span class="field-hint">The default service frequency for all clients. It seeds a new client's booking frequency; clients already on the books are never rewritten.</span>`
          +businessFieldErrorMarkup("defaultServiceFrequencyWeeks")
        +`</label>`
        +`<label>Reminder lead time`
          +`<span class="pref-frequency">`
            +`<input type="number" name="reminderHours" data-business-field="reminderHours" data-testid="business-reminder-hours" min="0" max="720" step="1" value="${escapeAttr(draft.reminderHours)}"${businessInvalidAttrs("reminderHours")}>`
            +`<span class="pref-unit">hours before the appointment</span>`
          +`</span>`
          +`<span class="field-hint">How far ahead the reminder outbox queues an appointment reminder. Set it to 0 to stop queuing them.</span>`
          +businessFieldErrorMarkup("reminderHours")
        +`</label>`
        // A mirrored value, not a control. `readonly` renders as a disabled input and the eye
        // learns to skip it, which is the opposite of the point: this is what invoices charge.
        +`<div class="business-readonly">`
          +`<span class="business-readonly-label">Tax rate</span>`
          +`<span class="business-readonly-value" data-testid="business-tax-rate">${escape(taxPayPercent(businessRecord().taxRateBasisPoints))}%</span>`
          +`<p class="field-hint">The rate in force is chosen in Tax &amp; payments and is what new invoices charge. It is shown here because it is a business-wide number, not because it is set here. `
            +`<button type="button" class="text-button" data-settings-goto="tax-payments">Open Tax &amp; payments</button></p>`
        +`</div>`
      +`</div>`
    +`</section>`
    +`<section class="settings-panel">`
      +`<h3>Social media</h3>`
      +`<p class="panel-note">Where this salon is listed. Pawsh records the addresses and does nothing else with them — it does not post, read reviews, or check that a page is still there.</p>`
      +`<div class="business-field-grid">`
        +businessTextField("socialFacebook","Facebook",{type:"url",testId:"business-social-facebook",maxlength:500,
          extra:` inputmode="url"`,hint:"The salon's page, not a personal profile."})
        +businessTextField("socialGoogle","Google",{type:"url",testId:"business-social-google",maxlength:500,
          extra:` inputmode="url"`,hint:"The Business Profile listing clients find in search and on maps."})
        +businessTextField("socialYelp","Yelp",{type:"url",testId:"business-social-yelp",maxlength:500,
          extra:` inputmode="url"`,hint:"The salon's Yelp page."})
      +`</div>`
    +`</section>`
    +foot
    +`</form>`;
}

const BUSINESS_EMAIL_PATTERN=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUSINESS_SCHEME_PATTERN=/^([a-z][a-z0-9+.-]*):/i;
/**
 * The four link fields, refused for the reason the server refuses them.
 *
 * These are rendered as links, so a `javascript:` or `data:` value is a stored-XSS bound rather
 * than untidiness, and the schema 400s on it. The client refuses the same set - not a looser one -
 * so the operator is told at the field rather than by a server message in the foot. A bare host is
 * allowed through untouched: the server prefixes `https://` and returns what it stored.
 */
function businessUrlError(value){
  const text=String(value||"").trim();
  if(!text)return null;
  if(text.length>500)return "That address is longer than the 500 characters Pawsh stores.";
  const scheme=BUSINESS_SCHEME_PATTERN.exec(text);
  if(scheme&&!["http","https"].includes(scheme[1].toLowerCase()))
    return "Pawsh stores web addresses only. Start it with https:// or leave the scheme off entirely.";
  return null;
}
// On submit only, never on keystroke. On failure nothing is sent, every invalid field is marked,
// and focus moves to the first one.
function businessValidateInfo(){
  const draft=businessDraft(),errors={};
  if(draft.name.trim().length<2)errors.name="A salon name is needed — it is what appears on every invoice.";
  const email=draft.email.trim();
  if(email&&!BUSINESS_EMAIL_PATTERN.test(email))errors.email="That is not an email address Pawsh can send to.";
  if(!draft.timezone.trim())errors.timezone="A timezone is needed — appointment times are read in it.";
  // The select has no blank option and the column is `not null`, so this can only fire for a value
  // that reached the draft some other way. It is checked rather than assumed because the field is
  // optional in the request schema - the server would accept the omission, not the emptiness.
  if(!draft.businessType.trim())errors.businessType="Choose whether this salon is mobile, fixed, or both.";
  for(const [key] of BUSINESS_URL_FIELDS){
    const message=businessUrlError(draft[key]);
    if(message)errors[key]=message;
  }
  const weeks=draft.defaultServiceFrequencyWeeks.trim();
  if(weeks&&(!Number.isInteger(Number(weeks))||Number(weeks)<1||Number(weeks)>104)){
    errors.defaultServiceFrequencyWeeks="Enter a whole number of weeks, from 1 to 104.";
  }
  if(businessReminderTouched()){
    const hours=Number(draft.reminderHours);
    if(!draft.reminderHours.trim()||!Number.isInteger(hours)||hours<0||hours>720){
      errors.reminderHours="Enter a whole number of hours, from 0 to 720.";
    }
  }
  return errors;
}
/**
 * The payload, built against a MERGE schema.
 *
 * `name`, `timezone`, `taxRateBasisPoints`, `reminderLeadMinutes` and `locationVersion` are
 * required and always sent. Everything else is sent ONLY when this form moved it, which is what
 * makes a rename incapable of clearing a contact detail and what keeps a workspace holding a
 * legacy currency code from being refused by a picker it never operated.
 *
 * Three rules the schema enforces and this function has to respect:
 *   - the six enums have NO null. Sending one is a 400, so an untouched select sends nothing.
 *   - `upcomingAppointmentCount` is the one field where null IS a value. Omitted preserves; `All`
 *     or null sets All; 1-20 sets a number. It refuses a NUMERIC STRING, so the select's value is
 *     coerced here rather than posted as it comes off the DOM.
 *   - the nullable text fields clear on null or "", which is why an untouched one must be absent.
 *
 * The tax rate is round-tripped from `state.me.business` unchanged, so `mirrorBusinessTaxRate`
 * writes back the rate Tax & payments already has in force.
 */
function businessSettingsPayload(){
  const draft=businessDraft(),stored=businessStoredValues(),record=businessRecord();
  const payload={
    name:draft.name.trim(),
    timezone:draft.timezone.trim(),
    taxRateBasisPoints:Number(record.taxRateBasisPoints??0),
    reminderLeadMinutes:businessReminderTouched()
      ?Math.round(Number(draft.reminderHours)*60)
      :Number(record.reminderLeadMinutes??0),
    locationVersion:Number(record.locationVersion)
  };
  // Blank means cleared, and it is sent as null rather than "": the schema maps a blank string to
  // null anyway, and `location_address_bounded` refuses a whitespace-only address outright.
  for(const key of BUSINESS_TEXT_FIELDS){
    if(draft[key].trim()===stored[key].trim())continue;
    payload[key]=draft[key].trim()||null;
  }
  if(draft.currency!==stored.currency)payload.currency=draft.currency;
  for(const [key] of BUSINESS_ENUM_FIELDS){
    if(draft[key]!==stored[key])payload[key]=draft[key];
  }
  if(draft.upcomingAppointmentCount!==stored.upcomingAppointmentCount){
    payload.upcomingAppointmentCount=draft.upcomingAppointmentCount==="All"
      ?"All":Number(draft.upcomingAppointmentCount);
  }
  if(draft.defaultServiceFrequencyWeeks!==stored.defaultServiceFrequencyWeeks){
    const weeks=draft.defaultServiceFrequencyWeeks.trim();
    payload.defaultServiceFrequencyWeeks=weeks?Number(weeks):null;
  }
  return payload;
}

function businessSubmitInfo(){
  businessState.submitted=true;
  businessState.error=null;businessState.stale=false;
  const errors=businessValidateInfo();
  businessState.fieldErrors=errors;
  if(Object.keys(errors).length){
    businessState.status="";
    renderBusiness();
    $(`#business-root [data-business-field="${Object.keys(errors)[0]}"]`)?.focus();
    return;
  }
  const next=businessDraft().timezone.trim(),current=String(businessRecord().timezone??"");
  // Unconditional, unlike the retired dialog's `state.appointments.some(...)` gate: that array
  // holds only the calendar range currently in memory, so an operator who went straight to
  // Settings got no confirmation at all. A confirmation that disappears based on what happens to
  // be cached is worse than none.
  if(next!==current){
    openStackedDialog({
      title:"Change this location's timezone?",
      body:`<p>New and rescheduled appointments will be interpreted in <strong>${escape(next)}</strong> instead of <strong>${escape(current)}</strong>. Appointments already on the calendar keep the exact instant they were booked for, so their displayed times will move.</p>`,
      confirmLabel:"Change timezone",
      dismissLabel:`Keep ${current}`,
      onConfirm:()=>{runDetached(businessSaveInfo);return true;},
      onDismiss:()=>$(`#business-root [data-business-field="timezone"]`)?.focus()
    });
    return;
  }
  runDetached(businessSaveInfo);
}
/**
 * Put the currency picker back to what the server actually holds, after a refusal.
 *
 * The stored code is re-read rather than parsed out of the refusal's message. The message is
 * prose written for the operator and will be reworded; `businesses.currency` is a fact, and
 * `/api/me` is where this form reads it from every other time. Only the picker is reset - the
 * rest of the draft is the operator's unsaved typing, and the STALE branch's rule holds here too:
 * nothing typed is discarded without them asking for it.
 *
 * A failed re-read is not worth surfacing over the refusal that caused it. `state.me` still holds
 * the record this form was drawn from, and the save wrote NOTHING, so the currency in it is still
 * the stored one - which makes falling through to it correct rather than merely tolerable.
 */
async function businessRestoreStoredCurrency(){
  try{
    state.me=await api("/api/me");
    renderAccountIdentity();
  }catch{/* keep the record already in hand; the refused save changed nothing behind it */}
  businessDraft().currency=businessStoredValues().currency;
}
async function businessSaveInfo(){
  if(businessState.saving)return;
  businessState.saving=true;businessState.error=null;businessState.status="";
  let currencyRefused=false;
  renderBusiness();
  try{
    await api("/api/business/settings",{method:"PUT",body:JSON.stringify(businessSettingsPayload())});
    // Re-read rather than trusting the reply: the save bumped `locations.version`, and the next
    // booking or blocked time sends it as `expectedLocationVersion`.
    state.me=await api("/api/me");
    renderAccountIdentity();
    // The calendar is already in the DOM and every time on it was laid out under the OLD hour
    // format. Re-rendering it here is what makes "24 Hours" visible without the operator having
    // to guess that leaving Settings is part of the change. Guarded because a workspace that has
    // not opened the calendar this session has nothing there to redraw.
    try{renderAppointments();}catch{/* the calendar is not mounted; nothing to restate */}
    businessState.draft=null;businessState.fieldErrors={};businessState.submitted=false;
    businessState.status="Business settings saved.";
    toast("Business settings saved");
  }catch(error){
    // BRANCHED ON THE CODE, NOT THE STATUS. This route answers 409 for two unrelated things - a
    // `locationVersion` that has moved on, and a currency the workspace's financial history has
    // pinned - and they need opposite handling. A branch on the status alone would tell an
    // operator whose currency was refused to reload and try again, which would refuse again.
    const code=error.status===409?error.data?.code:null;
    if(code==="STALE_LOCATION_SETTINGS"){
      // Nothing the operator typed is discarded without them pressing the button below.
      businessState.stale=true;
      businessState.error="Business settings were changed somewhere else while this form was open. Reload the saved values and make the change again.";
    }else if(code==="CURRENCY_LOCKED_BY_FINANCIAL_HISTORY"){
      // THE SERVER'S OWN SENTENCE. It names the currency the history is recorded in and says why
      // the change is refused, and the rule that produced it lives on the server, so nothing here
      // restates it - not the list of tables, not the threshold, and not a guess made before the
      // save about whether this workspace is locked. The picker stays enabled: a greyed control
      // with no explanation is the thing this refusal exists to replace.
      businessState.error=error.message;
      // The screen was claiming a currency the workspace is not on. Putting the picker back is
      // what stops the next save resending it, and what stops the sample line beneath it
      // promising prices in a currency no invoice will ever be written in.
      await businessRestoreStoredCurrency();
      // The refusal is ABOUT the currency, but the write was refused WHOLE: the rename or the tax
      // rate posted in the same payload went nowhere either. The foot's "Unsaved changes." says
      // as much, and this says it in words, because an operator who reads only the server's
      // sentence would otherwise leave believing the rest of the form had landed.
      if(businessInfoDirty()){
        businessState.error+=" Nothing else on this form was saved either — those changes are still here, unsent.";
      }
      currencyRefused=true;
    }else{
      businessState.error=error.message;
    }
  }finally{
    businessState.saving=false;
    renderBusiness();
    // Back to the button that was pressed - except after the currency refusal, where putting the
    // picker back can leave the form clean and therefore disable that button. Focus would then
    // fall to <body>, away from both the control that moved under the operator and the reason it
    // moved, so it goes to the picker instead.
    (currencyRefused
      ?$(`#business-root [data-business-field="currency"]`)
      :$(`#business-root [data-testid="business-save"]`))?.focus();
  }
}
async function businessReloadSaved(){
  state.me=await api("/api/me");
  renderAccountIdentity();
  businessState.draft=null;businessState.fieldErrors={};businessState.submitted=false;
  businessState.stale=false;businessState.error=null;businessState.status="Saved values reloaded.";
  renderBusiness();
}

// --- Business Hours ------------------------------------------------------
function businessHoursDraftFrom(hours){
  const byDay=new Map();
  for(const period of hours||[]){
    const day=Number(period.weekday);
    if(!Number.isInteger(day)||day<0||day>6)continue;
    if(!byDay.has(day))byDay.set(day,[]);
    byDay.get(day).push({start:String(period.startTime??"").slice(0,5),end:String(period.endTime??"").slice(0,5)});
  }
  const draft={};
  for(let day=0;day<7;day+=1){
    const periods=(byDay.get(day)||[]).slice().sort((a,b)=>a.start.localeCompare(b.start));
    draft[day]={
      open:periods.length>0,start:periods[0]?.start||"",end:periods[0]?.end||"",
      // A weekday carrying more than one saved period cannot be expressed by one from/to pair, so
      // the row goes read-only and the save passes its periods through untouched. A single-range
      // editor over it would read the first period and silently delete the rest.
      multi:periods.length>1,periods,touched:false
    };
  }
  return draft;
}
function businessHoursRowDirty(day){
  const row=businessState.hoursDraft?.[day],base=businessState.hoursBaseline?.[day];
  if(!row||!base||row.multi)return false;
  return row.open!==base.open||(row.open&&(row.start!==base.start||row.end!==base.end));
}
function businessHoursDirtyCount(){
  if(!businessState.hoursDraft)return 0;
  return [0,1,2,3,4,5,6].filter(businessHoursRowDirty).length;
}
function businessHoursRowError(day){
  const row=businessState.hoursDraft?.[day];
  if(!row||row.multi||!row.open)return null;
  const name=BUSINESS_WEEKDAYS[day];
  if(!row.start||!row.end)return `${name} is open, so it needs an opening and a closing time.`;
  // `workingHoursSchema` refines startTime < endTime and the column is a bare `time`, so an
  // overnight salon genuinely cannot be expressed. Saying so beats a message nobody can act on.
  if(row.end<=row.start)return `${name} must close after it opens. Hours cannot run past midnight.`;
  return null;
}
function businessHoursShownError(day){
  const row=businessState.hoursDraft?.[day];
  if(!row)return null;
  if(!businessState.hoursSubmitted&&!row.touched)return null;
  return businessHoursRowError(day);
}
function businessHoursInvalidDays(){
  if(!businessState.hoursDraft)return [];
  return [0,1,2,3,4,5,6].filter(day=>businessHoursRowError(day));
}
// A day switched on that has never had hours is suggested from the week around it rather than
// snapped to a constant. Nothing is written until Save, so a suggestion is safe here.
function businessHoursSuggestion(){
  const counts=new Map();
  for(let day=0;day<7;day+=1){
    const row=businessState.hoursDraft[day];
    if(!row.open||row.multi||!row.start||!row.end)continue;
    const key=`${row.start}|${row.end}`;
    counts.set(key,(counts.get(key)||0)+1);
  }
  let best=null,seen=0;
  for(const [key,count] of counts)if(count>seen){best=key;seen=count;}
  const [start,end]=best?best.split("|"):["09:00","17:00"];
  return {start,end};
}
function businessMultiNote(count){
  return `${count===2?"Two":count} periods — editing here would remove one.`;
}
function businessHoursTimesMarkup(day,editable){
  const row=businessState.hoursDraft[day],name=BUSINESS_WEEKDAYS[day];
  if(row.multi){
    return `<span class="business-hours-times is-readonly" data-testid="business-hours-multi-${day}">`
      +`<span class="business-hours-state">${escape(row.periods.map(period=>`${period.start}–${period.end}`).join(", "))}</span>`
      +`<span class="business-hours-multi">${escape(businessMultiNote(row.periods.length))}</span></span>`;
  }
  // The state is a word, never the switch's position or hue alone - and never a disabled input,
  // which would assert a closed day has hours that merely cannot be reached.
  if(!row.open){
    return `<span class="business-hours-times is-closed">`
      +`<span class="business-hours-state" data-testid="business-hours-state-${day}">Closed</span></span>`;
  }
  if(!editable){
    return `<span class="business-hours-times">`
      +`<span class="business-hours-state" data-testid="business-hours-state-${day}">${escape(`${row.start}–${row.end}`)}</span></span>`;
  }
  const invalid=businessHoursShownError(day)?` aria-invalid="true"`:"";
  // No `step`: `step="900"` would refuse a stored `09:05` that already exists in the database,
  // and the default already renders as HH:MM with no seconds.
  return `<span class="business-hours-times">`
    +`<label class="visually-hidden" for="business-hours-start-${day}">${escape(name)} opens at</label>`
    +`<input type="time" id="business-hours-start-${day}" data-business-start="${day}" data-testid="business-hours-start-${day}" value="${escapeAttr(row.start)}"${invalid}>`
    +`<span class="business-hours-dash" aria-hidden="true">–</span>`
    +`<label class="visually-hidden" for="business-hours-end-${day}">${escape(name)} closes at</label>`
    +`<input type="time" id="business-hours-end-${day}" data-business-end="${day}" data-testid="business-hours-end-${day}" value="${escapeAttr(row.end)}"${invalid}>`
    +`</span>`;
}
function businessHoursToggleMarkup(day,editable){
  const row=businessState.hoursDraft[day],name=BUSINESS_WEEKDAYS[day];
  // A switch on a read-only row would offer to turn off a day whose second period it cannot
  // redraw, so those rows say the state in a word instead.
  if(row.multi||!editable){
    return `<span class="business-hours-toggle"><span class="business-hours-state">${row.open?"Open":"Closed"}</span></span>`;
  }
  // The accessible name is an `aria-label` rather than a wrapping label: the row holds three
  // controls, and a wrapping label would claim clicks meant for the time inputs.
  return `<span class="business-hours-toggle">`
    +`<input type="checkbox" role="switch" class="pref-toggle" data-business-day="${day}"`
    +` data-testid="business-hours-open-${day}" aria-label="Open on ${escapeAttr(name)}"${row.open?" checked":""}>`
    +`</span>`;
}
function businessHoursRowMarkup(day,editable){
  const error=businessHoursShownError(day);
  const classes=["business-hours-row"];
  if(businessHoursRowDirty(day))classes.push("is-dirty");
  if(error)classes.push("is-invalid");
  return `<div class="${classes.join(" ")}" data-weekday="${day}">`
    +`<span class="business-hours-day">${escape(BUSINESS_WEEKDAYS[day])}</span>`
    +businessHoursToggleMarkup(day,editable)
    +businessHoursTimesMarkup(day,editable)
    +(error?`<p class="error" role="alert" data-testid="business-hours-row-error-${day}">${escape(error)}</p>`:"")
    +`</div>`;
}
function businessHoursScopeMarkup(){
  const name=escape(availabilityLocationName());
  // Zero saved rows is not an empty week. The calendar treats it as open at all times
  // (`!periods.length && !state.businessHours.length`), so seven off switches with no note would
  // tell the operator the exact opposite of how the product behaves.
  const unconfigured=(businessState.hours||[]).length===0;
  return `<p class="availability-scope is-location" data-testid="business-hours-scope">`
    +(unconfigured
      ?`No business hours are saved for <strong>${name}</strong>. Until some are, the calendar treats every slot on every day as open. Saving here replaces that.`
      :`These are the hours saved for <strong>${name}</strong>. The calendar shades slots outside them as closed.`)
    +`</p>`;
}
function businessHoursLoadingMarkup(){
  // Nothing is rendered before the read resolves. Never `09:00`, never `17:00`, never a checked
  // switch, until the GET answers - the fabricated week is the bug this screen exists to replace.
  return `<section class="settings-panel business-hours-skeleton" aria-busy="true" data-testid="business-hours-loading">`
    +`<h3>Business hours</h3><p class="panel-note">Reading the hours saved for this location…</p>`
    +`<div class="business-hours-list">`
    +BUSINESS_WEEKDAYS.map(name=>`<div class="business-hours-row">`
      +`<span class="business-hours-day">${escape(name)}</span>`
      +`<span class="business-hours-toggle"><span class="business-skeleton-bar"></span></span>`
      +`<span class="business-hours-times"><span class="business-skeleton-bar"></span></span></div>`).join("")
    +`</div></section>`;
}
function businessHoursErrorMarkup(){
  const error=businessState.hoursError;
  const message=error?.status===403?"You do not have permission to view this."
    :"Pawsh could not read the hours saved for this location, so it is not showing any. Nothing has changed.";
  // No editable grid is rendered in this state at all: a form over unknown data that saves a
  // destructive whole-week replace is the original bug wearing a better error message.
  return `<div class="availability-error" data-testid="business-hours-error"><h4>These could not load</h4>`
    +`<p>${escape(message)}</p>`
    +`<button type="button" class="secondary compact" data-business-hours-retry>Try again</button></div>`;
}
function businessHoursStatusText(){
  if(businessState.hoursSaving)return "Saving…";
  const invalid=businessState.hoursSubmitted?businessHoursInvalidDays().length:0;
  if(invalid)return `Fix ${invalid} day${invalid===1?"":"s"} before saving.`;
  const dirty=businessHoursDirtyCount();
  if(dirty)return `${dirty} day${dirty===1?"":"s"} changed.`;
  return businessState.hoursStatus;
}
function businessHoursMarkup(){
  if(businessState.hoursError)return businessHoursErrorMarkup();
  if(!businessState.hoursDraft)return businessHoursLoadingMarkup();
  // Settings is gated on settings.manage, so anyone here can write. The branch is kept for
  // consistency with the closed-days grid, and uses `.availability-note` rather than its quiet
  // variant because `--placeholder` fails AA for body text.
  const editable=allowed("settings.manage");
  const rows=`<div class="business-hours-list" data-testid="business-hours-list">`
    +[0,1,2,3,4,5,6].map(day=>businessHoursRowMarkup(day,editable)).join("")+`</div>`;
  const panel=`<section class="settings-panel">`
    +`<h3>Business hours</h3>`
    +`<p class="panel-note">The opening times scheduling reads for this location. One opening period per day.</p>`
    +(editable?"":`<p class="availability-note">Changing business hours needs the Settings permission.</p>`)
    +rows+`</section>`;
  if(!editable)return businessHoursScopeMarkup()+panel;
  const foot=`<div class="business-form-foot">`
    +`<p class="business-form-status" role="status" data-testid="business-hours-status">${escape(businessHoursStatusText())}</p>`
    +`<p class="error" data-testid="business-hours-save-error">${businessState.hoursSaveError?escape(businessState.hoursSaveError):""}</p>`
    +`<button type="submit" class="primary compact" data-testid="business-hours-save"${businessHoursDirtyCount()&&!businessState.hoursSaving?"":" disabled"}>${businessState.hoursSaving?"Saving…":"Save hours"}</button>`
    +`</div>`;
  return businessHoursScopeMarkup()
    +`<form class="business-form" data-business-hours-form${businessState.hoursSaving?` aria-busy="true"`:""} novalidate>${panel}${foot}</form>`;
}

async function loadBusinessHours(){
  businessState.hoursLoading=true;businessState.hoursError=null;
  try{
    const hours=await api("/api/business/working-hours");
    businessState.hours=Array.isArray(hours)?hours:[];
    // The calendar's copy comes from the same read, so the two cannot disagree about which slots
    // are shaded closed.
    state.businessHours=businessState.hours;
    businessState.hoursDraft=businessHoursDraftFrom(businessState.hours);
    businessState.hoursBaseline=businessHoursDraftFrom(businessState.hours);
    businessState.hoursSubmitted=false;businessState.hoursSaveError="";
  }catch(error){businessState.hoursError=error;}
  finally{businessState.hoursLoading=false;}
}
function businessHoursPayload(){
  const hours=[];
  for(let day=0;day<7;day+=1){
    const row=businessState.hoursDraft[day];
    // The PUT is `delete … insert` over the whole location, so the payload carries all seven
    // days' state every time. Building it from changed rows would delete every unchanged day.
    if(row.multi){
      for(const period of row.periods)hours.push({weekday:day,startTime:period.start,endTime:period.end});
      continue;
    }
    if(row.open)hours.push({weekday:day,startTime:row.start,endTime:row.end});
  }
  return {hours};
}
// The server names the day and the reason in both refusals, so its sentence is the one shown. The
// duplicate case is only reachable through a read-only multi-period row, and the client adds why.
function businessHoursServerMessage(error){
  if(error.data?.code==="DUPLICATE_WORKING_HOURS_DAY"){
    return `${error.message} Pawsh stores one opening period per day, so a day that already holds two cannot be saved from here.`;
  }
  return error.message;
}
function businessSubmitHours(){
  businessState.hoursSubmitted=true;businessState.hoursSaveError="";
  const invalid=businessHoursInvalidDays();
  if(invalid.length){
    renderBusiness();
    const day=invalid[0],row=businessState.hoursDraft[day];
    $(`#business-hours-${row.start&&row.end?"end":"start"}-${day}`)?.focus();
    return;
  }
  runDetached(businessSaveHours);
}
async function businessSaveHours(){
  if(businessState.hoursSaving)return;
  businessState.hoursSaving=true;businessState.hoursSaveError="";businessState.hoursStatus="";
  renderBusiness();
  try{
    await api("/api/business/working-hours",{method:"PUT",body:JSON.stringify(businessHoursPayload())});
    // Two reads, both load-bearing. `loadBusinessHours` refreshes the grid AND the calendar's own
    // copy; `/api/me` carries the `locations.version` the PUT bumped but does not return, and
    // without it the operator's very next booking or blocked time fails STALE_LOCATION_SETTINGS
    // with no cause on screen - the hazard `applyAvailabilityClosure` already documents.
    await loadBusinessHours();
    state.me=await api("/api/me");
    businessState.hoursStatus="Business hours saved.";
    toast("Business hours saved");
  }catch(error){
    businessState.hoursSaveError=businessHoursServerMessage(error);
  }finally{
    businessState.hoursSaving=false;
    renderBusiness();
    $(`#business-root [data-testid="business-hours-save"]`)?.focus();
  }
}

// --- Shell ---------------------------------------------------------------
function businessMarkup(){
  if(businessState.tab==="info")return businessTabsMarkup()+businessPanelMarkup(businessInfoMarkup());
  if(businessState.tab==="hours")return businessTabsMarkup()+businessPanelMarkup(businessHoursMarkup());
  // `tabindex="0"` only where the panel holds nothing focusable, which is the condition
  // `availabilityMarkup` already applies it under. The two working tabs must not carry it.
  return businessTabsMarkup()+businessPanelMarkup(businessUnavailableMarkup(businessState.tab),{focusable:true});
}
function renderBusiness(){
  const root=$("#business-root");if(!root)return;
  root.innerHTML=businessMarkup();
  bindBusiness(root);
}
function selectBusinessTab(tab,{focus=true}={}){
  if(businessState.tab===tab)return;
  businessState.tab=tab;
  renderBusiness();
  if(focus)$(`#business-tab-${tab}`)?.focus();
  ensureBusinessData();
}
function ensureBusinessData(){
  if(businessState.tab!=="hours")return;
  if(businessState.hoursDraft||businessState.hoursLoading||businessState.hoursError)return;
  runDetached(async()=>{await loadBusinessHours();renderBusiness();});
}
// Entering the category rebuilds from server truth. A draft left behind by a previous visit would
// re-render as though it had been saved, and the URL makes no claim about the tab.
function resetBusinessWorkspace(tab){
  businessState.tab=BUSINESS_TABS.some(([id])=>id===tab)?tab:"info";
  businessState.draft=null;businessState.fieldErrors={};businessState.submitted=false;
  businessState.saving=false;businessState.status="";businessState.error=null;businessState.stale=false;
  businessState.filters={currency:"",timezone:""};
  businessState.hours=null;businessState.hoursDraft=null;businessState.hoursBaseline=null;
  businessState.hoursError=null;businessState.hoursLoading=false;businessState.hoursSubmitted=false;
  businessState.hoursSaving=false;businessState.hoursStatus="";businessState.hoursSaveError="";
}

function businessSyncInfoFoot(root){
  const save=root.querySelector(`[data-testid="business-save"]`);
  const status=root.querySelector(`[data-testid="business-status"]`);
  if(save)save.disabled=!businessInfoDirty()||businessState.saving;
  if(status)status.textContent=businessInfoStatusText();
}
function businessSyncHoursFoot(root){
  const save=root.querySelector(`[data-testid="business-hours-save"]`);
  const status=root.querySelector(`[data-testid="business-hours-status"]`);
  if(save)save.disabled=!businessHoursDirtyCount()||businessState.hoursSaving;
  if(status)status.textContent=businessHoursStatusText();
}
// One row, swapped in place. Re-rendering the panel would move focus off the switch or the time
// input the operator just used.
function businessRefreshHoursRow(day,root){
  const rowEl=root.querySelector(`.business-hours-row[data-weekday="${day}"]`);
  if(!rowEl)return;
  rowEl.querySelector(".business-hours-times")?.remove();
  rowEl.querySelector(".error")?.remove();
  const error=businessHoursShownError(day);
  rowEl.insertAdjacentHTML("beforeend",businessHoursTimesMarkup(day,true)
    +(error?`<p class="error" role="alert" data-testid="business-hours-row-error-${day}">${escape(error)}</p>`:""));
  rowEl.classList.toggle("is-dirty",businessHoursRowDirty(day));
  rowEl.classList.toggle("is-invalid",Boolean(error));
  businessBindHoursRow(rowEl,root);
  businessSyncHoursFoot(root);
}
function businessBindHoursRow(rowEl,root){
  rowEl.querySelectorAll("[data-business-start],[data-business-end]").forEach(input=>{
    const edge=input.dataset.businessStart===undefined?"end":"start";
    const day=Number(input.dataset.businessStart??input.dataset.businessEnd);
    const apply=()=>{
      const row=businessState.hoursDraft[day];
      if(row[edge]===input.value&&row.touched)return;
      row[edge]=input.value;row.touched=true;
      const refocus=document.activeElement===input;
      businessRefreshHoursRow(day,root);
      if(refocus)root.querySelector(`#business-hours-${edge}-${day}`)?.focus();
    };
    input.addEventListener("change",apply);
    input.addEventListener("blur",apply);
  });
}
function bindBusiness(root){
  // Arrows move focus, Enter and Space commit. Activating on focus would swap the panel out from
  // under somebody simply passing along the bar.
  root.querySelector(`[role="tablist"]`)?.addEventListener("keydown",event=>{
    const buttons=[...root.querySelectorAll("[data-business-tab]")],index=buttons.indexOf(document.activeElement);
    if(index<0)return;
    if(event.key==="Enter"||event.key===" "||event.key==="Spacebar"){event.preventDefault();selectBusinessTab(buttons[index].dataset.businessTab);return;}
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();
    const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowRight"?1:-1)+buttons.length)%buttons.length;
    buttons[next]?.focus();
  });
  root.querySelectorAll("[data-business-tab]").forEach(button=>button.addEventListener("click",()=>
    selectBusinessTab(button.dataset.businessTab,{focus:false})));
  bindSettingsGoto(root);

  // Info. These write to the draft and touch only the button and the status line: a full
  // re-render on keystroke would destroy the caret.
  root.querySelectorAll("[data-business-field]").forEach(control=>{
    const key=control.dataset.businessField;
    const apply=()=>{
      businessDraft()[key]=key==="currency"?String(control.value).toUpperCase():control.value;
      if(key==="timezone"){
        const hint=root.querySelector(`[data-testid="business-timezone-now"]`);
        if(hint)hint.textContent=businessTimeZoneNow(control.value.trim());
      }
      if(key==="currency"){
        const hint=root.querySelector(`[data-testid="business-currency-sample"]`);
        if(hint)hint.textContent=businessCurrencySample(businessDraft().currency);
      }
      businessSyncInfoFoot(root);
    };
    control.addEventListener("input",apply);
    control.addEventListener("change",apply);
  });
  // Narrowing a picker rebuilds ONLY that select's options. The selected value is reassigned
  // explicitly afterwards because replacing a select's children resets it to the first option,
  // and the operator did not choose that one.
  root.querySelectorAll("[data-business-filter]").forEach(input=>{
    const key=input.dataset.businessFilter;
    input.addEventListener("input",()=>{
      businessState.filters[key]=input.value;
      const wrap=root.querySelector(`[data-business-picker="${key}"]`),select=wrap?.querySelector("select");
      if(!wrap||!select)return;
      const result=businessPickerMatches(key,input.value);
      select.innerHTML=businessPickerOptionsMarkup(key,result.options,businessDraft()[key]);
      select.value=businessDraft()[key];
      const count=wrap.querySelector(".business-picker-count");
      if(count)count.textContent=businessPickerCountText(key,result);
    });
  });
  root.querySelector("[data-business-form]")?.addEventListener("submit",event=>{
    event.preventDefault();businessSubmitInfo();
  });
  root.querySelector("[data-business-reload]")?.addEventListener("click",()=>runDetached(businessReloadSaved));

  // Hours.
  root.querySelector("[data-business-hours-retry]")?.addEventListener("click",()=>{
    businessState.hoursError=null;businessState.hours=null;businessState.hoursDraft=null;
    renderBusiness();ensureBusinessData();
  });
  root.querySelectorAll("[data-business-day]").forEach(input=>input.addEventListener("change",()=>{
    const day=Number(input.dataset.businessDay),row=businessState.hoursDraft[day];
    row.open=input.checked;
    // The row's times are kept while it is closed, so switching back on restores what was there
    // rather than snapping to a default.
    if(row.open&&(!row.start||!row.end)){
      const suggestion=businessHoursSuggestion();
      row.start=row.start||suggestion.start;row.end=row.end||suggestion.end;
    }
    businessRefreshHoursRow(day,root);
  }));
  root.querySelectorAll(".business-hours-row").forEach(rowEl=>businessBindHoursRow(rowEl,root));
  root.querySelector("[data-business-hours-form]")?.addEventListener("submit",event=>{
    event.preventDefault();businessSubmitHours();
  });
}

// `tab` is how the Salon view's two Business-hours entry points land on the right tab. The URL
// stays `/settings/business` on every tab: `settingsPathCategory` matches `^/settings/([^/]+)$`,
// so a second path segment would fail that regex and silently land the operator on Account.
function renderSettingsCategory(category=settingsPathCategory(),{history="replace",tab=null}={}){const definition=settingsCategories.find(([id])=>id===category)||settingsCategories[0],[id,title]=definition,nav=$("#settings-navigation"),content=$("#settings-content");if(!nav||!content)return;nav.innerHTML=settingsCategories.map(([key,label])=>`<button type="button" data-settings-category="${key}" class="${key===id?"active":""}" ${key===id?'aria-current="page"':""}>${escape(label)}</button>`).join("");let html="";if(id==="account")html=settingsLink("Account","Personal identity and password security remain in your canonical account workspace.","Manage profile & security","profile-account");else if(id==="staff")html=`<div id="staff-root" class="staff-root"></div>`;else if(id==="business")html=`<div id="business-root" class="business-root"></div>`;else if(id==="availability")html=`<div id="availability-root" class="availability-root"></div>`;else if(id==="permissions")html=allowed("team.manage")?`<div id="roles-root" class="roles-root"></div>`:settingsPlaceholder(id,title);else if(id==="services")html=settingsLink("Services","Service names, pricing, durations, and availability have one canonical workspace.","Open Services","services");else if(id==="pet-options")html=`<div id="pet-options-workspace" class="pet-options-workspace"></div>`;else if(id==="tax-payments")html=`<div id="taxpay-root" class="taxpay-root"></div>`;else if(id==="discounts")html=`<div id="discounts-root" class="discounts-root"></div>`;else if(id==="automated-messages")html=`<article class="settings-panel"><h3>Automated messages</h3><p>Pawsh’s durable reminder/outbox flow uses the configured reminder lead time. Template and channel management are deferred.</p><button type="button" class="primary compact" data-settings-goto="business">Open Business settings</button></article>`;else html=settingsPlaceholder(id,title);content.innerHTML=`<div class="settings-content-head"><p class="eyebrow">Settings</p><h2>${escape(title)}</h2></div>${html}`;nav.querySelectorAll("[data-settings-category]").forEach(button=>button.addEventListener("click",()=>renderSettingsCategory(button.dataset.settingsCategory,{history:"push"})));bindSettingsGoto(content);if(id==="permissions"){renderRoles();ensureRolesData();}if(id==="staff")renderStaff();if(id==="pet-options")renderPetOptions();if(id==="availability"){renderAvailability();ensureAvailabilityData();}if(id==="tax-payments"){renderTaxPayments();ensureTaxPaymentsData();}if(id==="discounts"){renderDiscounts();ensureDiscountsData();}if(id==="business"){resetBusinessWorkspace(tab);renderBusiness();ensureBusinessData();}if(history!=="none")globalThis.history[history==="push"?"pushState":"replaceState"]({view:"admin-settings",settingsCategory:id},"",`/settings/${id}`);content.focus({preventScroll:true});}

async function openClientProfile(customerId,{petId=null,appointmentId=null,returnView=null}={}){
  if(returnView)state.clientProfileReturnView=returnView;
  const previous=state.clientProfile?.data.customer.id===customerId?state.clientProfile:null;
  const [data,notes,agreements]=await Promise.all([api(`/api/customers/${customerId}/history`),loadClientNotes(customerId),loadClientAgreements(customerId)]);
  // The history window resets with the profile: the response carries the opening preview, so a
  // page the operator had stepped to for a different client would show rows that are not loaded.
  state.clientProfile={data,notes,agreements,notesExpanded:previous?.notesExpanded||false,tab:previous?.tab||"pets",petId:petId||data.pets[0]?.id||null,appointmentId,historyView:{page:1,pageSize:HISTORY_INITIAL_ROWS},historyLoading:false};
  state.pets=[...state.pets.filter(pet=>pet.customerId!==customerId),...data.pets];activateView("client-profile");renderClientProfile();
  showClientPopupNotes();
}
// ---------------------------------------------------------------------------
// Pet profile
//
// One scrollable panel holding everything a salon keeps about a pet: identity and coat, an
// authored note thread, photographs over time, structured medical information, vaccinations,
// and the vet. Each section saves independently, because somebody correcting a weight should
// not have to re-confirm the medical record to do it.
// ---------------------------------------------------------------------------
const PET_HEALTH_ISSUES=[
  ["diabetes_mellitus","Diabetes mellitus"],["heart_condition","Heart condition"],
  ["distemper","Distemper"],["blind","Blind"],["epilepsy","Epilepsy"],
  ["arthritis","Arthritis"],["fleas_ticks_mites","Fleas, ticks & mites"],["deaf","Deaf"],
  ["obesity","Obesity"],["cancer","Cancer"]
];
// The salon's own vocabulary rather than a generic one: hair length drives which grooming
// service applies, and the cat entries exist because a cat is not a short-haired dog.
const PET_HAIR_LENGTHS=["Smooth Single Coat","All Other Coats","Cat Short Hair","Cat Long Hair"];
const PET_TYPES=["Dog","Cat"];
const PET_GENDERS=["Male","Female"];
// Spayed and neutered also carry the sex, which a plain "fixed: yes" would lose.
const PET_FIXED_STATUSES=[["spayed","Spayed (female)"],["neutered","Neutered (male)"],["intact","Intact"]];
let petCoatColors=[];

const petProfileState=tenantCache(()=>({petId:null,pet:null,notes:[],photos:null,vaccinations:null,failed:false}));

function petAvatarMarkup(pet,photos){
  const avatarId=photos?.avatarPhotoId||null;
  if(avatarId){
    return `<img class="pet-avatar-image" src="/api/pet-photos/${encodeURIComponent(avatarId)}/content" alt="${escape(petName(pet))}">`;
  }
  return `<span class="pet-avatar" aria-hidden="true">${escape(Array.from(petName(pet,"?"))[0]?.toUpperCase()||"?")}</span>`;
}

function petIdentitySectionMarkup(pet,photos){
  const editable=allowed("pets.edit");
  // Every one of these opens blank when nothing has been recorded, so an unanswered question
  // never renders as though somebody answered it.
  const choice=(name,label,options,value,blank="Not set")=>`<label>${escape(label)}`
    +`<select data-testid="field-${name}" name="${name}">`
    +`<option value="" ${value===null||value===undefined||value===""?"selected":""}>${escape(blank)}</option>`
    +options.map(option=>{
      const [optionValue,optionLabel]=Array.isArray(option)?option:[option,option];
      return `<option value="${escape(optionValue)}" ${String(value ?? "").toLowerCase()===String(optionValue).toLowerCase()?"selected":""}>${escape(optionLabel)}</option>`;
    }).join("")
    +`</select></label>`;
  // A species the catalog does not list is kept rather than silently rewritten to Dog.
  const typeNames=petTypeNames();
  const speciesOptions=typeNames.some(type=>type.toLowerCase()===String(pet.species||"").toLowerCase())
    ? typeNames : [...typeNames,pet.species].filter(Boolean);
  const years=Array.from({length:31},(unused,index)=>[String(index),`${index} ${index===1?"year":"years"}`]);
  const months=Array.from({length:12},(unused,index)=>[String(index),`${index} ${index===1?"month":"months"}`]);
  return `<form class="pet-profile-section pet-identity" data-pet-section="identity">`
    +`<div class="pet-identity-head">${petAvatarMarkup(pet,photos)}`
      +`<div><p class="eyebrow">Pet profile</p><h4>${escape(petName(pet))}</h4>`
      +(pet.deceasedAt?`<p class="pet-deceased-flag" data-testid="pet-deceased-flag">Recorded as having passed away</p>`:"")
      +`</div></div>`
    +`<div class="pet-field-grid">`
      +field("name","Pet name","text",`value="${escape(pet.name||"")}"`)
      +choice("species","Type",speciesOptions,pet.species,"Not set")
      +breedField(pet)
      +`<label class="pet-check"><input data-testid="field-mixedBreed" name="mixedBreed" type="checkbox" ${pet.mixedBreed?"checked":""}> Mixed breed</label>`
      +choice("hairLength","Hair length",PET_HAIR_LENGTHS,pet.hairLength)
      +choice("sex","Gender",PET_GENDERS,pet.sex)
      +field("weightPounds",weightFieldLabel(),"number",`${weightInputAttrs()} value="${weightInputValue(pet.weightOunces)}"`)
      +field("dateOfBirth","Birthday","date",`value="${pet.dateOfBirth?String(pet.dateOfBirth).slice(0,10):""}"`)
      +choice("approximateAgeYears","Age (years)",years,pet.approximateAgeYears===null||pet.approximateAgeYears===undefined?"":String(pet.approximateAgeYears),"Year")
      +choice("approximateAgeMonths","Age (months)",months,pet.approximateAgeMonths===null||pet.approximateAgeMonths===undefined?"":String(pet.approximateAgeMonths),"Month")
      +choice("fixedStatus","Fixed",PET_FIXED_STATUSES,pet.fixedStatus)
      // A free field with suggestions rather than a managed list: a colour becomes a suggestion
      // the moment somebody first types it.
      +`<label>Coat colour<input data-testid="field-coatColor" name="coatColor" list="pet-coat-colors" maxlength="60" value="${escape(pet.coatColor||"")}">`
        +`<datalist id="pet-coat-colors">${petCoatColors.map(colour=>`<option value="${escape(colour)}"></option>`).join("")}</datalist></label>`
      +field("preferredShampoo","Preferred shampoo","text",`value="${escape(pet.preferredShampoo||"")}"`,true)
      +field("coatNotes","Coat notes","text",`value="${escape(pet.coatNotes||"")}"`,true)
    +`</div>`
    +(editable?`<div class="pet-section-actions"><button type="submit" class="primary compact" data-testid="pet-identity-save">Save</button></div>`:"")
    +`</form>`;
}

function petNotesSectionMarkup(){
  const notes=petProfileState.notes;
  return `<section class="pet-profile-section">`
    +`<div class="pet-section-head"><h4>Notes</h4>${allowed("pets.edit")?`<button type="button" class="text-button" data-testid="pet-note-add">Add</button>`:""}</div>`
    +(notes.length
      // Authorship and time are the point of the thread: an instruction nobody can be asked
      // about is not much use six months later.
      ? `<ul class="pet-note-list" data-testid="pet-notes">${notes.map(note=>`<li class="pet-note${note.pinned?" pinned":""}">`
        +`<p>${escape(note.body)}</p>`
        +`<small>${escape(reportCardStamp(note.createdAt)||"")} by ${escape(note.authorName||"an unknown account")}${note.pinned?" · pinned":""}</small>`
        +(allowed("pets.edit")?`<div class="pet-note-actions">`
          +`<button type="button" class="text-button" data-pet-note-pin="${escape(note.id)}">${note.pinned?"Unpin":"Pin"}</button>`
          +`<button type="button" class="text-button destructive" data-pet-note-delete="${escape(note.id)}">Delete</button></div>`:"")
        +`</li>`).join("")}</ul>`
      : `<p class="pet-empty">No notes on this pet.</p>`)
    +`</section>`;
}

function petPhotosSectionMarkup(){
  const photos=petProfileState.photos;
  if(!photos)return `<section class="pet-profile-section"><h4>Photos</h4><p class="pet-empty">Loading photos…</p></section>`;
  const canEdit=photos.canEdit;
  return `<section class="pet-profile-section">`
    +`<div class="pet-section-head"><h4>Photos</h4><span class="pet-section-note">Any photo can be the profile picture.</span></div>`
    +`<div class="photo-strip" data-testid="pet-photos">`
      +(canEdit?`<button type="button" class="photo-add" data-testid="pet-photo-add" aria-label="Add a photo of this pet"><span aria-hidden="true">+</span><small>Add</small></button>`:"")
      +photos.items.map(photo=>{
        const ratio=photo.width&&photo.height?`${photo.width} / ${photo.height}`:"1 / 1";
        const isAvatar=photos.avatarPhotoId===photo.id;
        return `<figure class="photo-tile${isAvatar?" is-avatar":""}" style="aspect-ratio:${ratio}">`
          +`<img src="/api/pet-photos/${encodeURIComponent(photo.id)}/content" alt="${escape(photo.originalFilename)}" loading="lazy">`
          +(canEdit?`<button type="button" class="photo-remove" data-pet-photo-remove="${escape(photo.id)}" aria-label="Remove ${escape(photo.originalFilename)}">×</button>`:"")
          +(canEdit&&!isAvatar?`<button type="button" class="photo-avatar-set" data-pet-avatar="${escape(photo.id)}">Use as photo</button>`:"")
          +(isAvatar?`<figcaption class="photo-avatar-flag">Profile photo</figcaption>`:"")
          +`</figure>`;
      }).join("")
      +(!photos.items.length&&!canEdit?`<p class="pet-empty">No photos of this pet.</p>`:"")
    +`</div></section>`;
}

function petMedicalSectionMarkup(pet){
  if(!allowed("pets.care.view")){
    return `<section class="pet-profile-section"><h4>Medical info</h4>`
      +`<p class="pet-empty">Medical information needs the Pet Care permission.</p></section>`;
  }
  const selected=new Set(pet.healthIssues||[]);
  // Null and [] are different facts: nobody asked, versus asked and nothing to report.
  const asked=Array.isArray(pet.healthIssues);
  const editable=allowed("pets.care.edit");
  return `<form class="pet-profile-section" data-pet-section="medical">`
    +`<div class="pet-section-head"><h4>Medical info</h4>`
      +`<span class="pet-section-note">${asked?(selected.size?"":"Recorded as nothing to report."):"Not asked yet."}</span></div>`
    +`<fieldset class="pet-health-issues"><legend>Health issues</legend><div class="compact-options">`
      +PET_HEALTH_ISSUES.map(([value,label])=>`<label><input type="checkbox" name="healthIssues" value="${value}" ${selected.has(value)?"checked":""} ${editable?"":"disabled"}> <span>${escape(label)}</span></label>`).join("")
    +`</div></fieldset>`
    // Rabies is recorded once, where it drives eligibility and notifications. A second tick box
    // here would be an unverified answer to the same question.
    +`<p class="pet-section-note">Rabies is not listed here: it is recorded in Vaccination records, where its expiry drives booking eligibility.</p>`
    +field("medicalNotes","Medical comments","text",`value="${escape(pet.medicalNotes||"")}" ${editable?"":"disabled"}`,true)
    +(editable?`<div class="pet-section-actions"><button type="submit" class="primary compact" data-testid="pet-medical-save">Save</button></div>`:"")
    +`</form>`;
}

function petVaccinationsSectionMarkup(){
  if(!allowed("pets.care.view")){
    return `<section class="pet-profile-section"><h4>Vaccination records</h4>`
      +`<p class="pet-empty">Vaccination records need the Pet Care permission.</p></section>`;
  }
  const data=petProfileState.vaccinations;
  if(!data)return `<section class="pet-profile-section"><h4>Vaccination records</h4><p class="pet-empty">Loading records…</p></section>`;
  const stamp=value=>value?formatPrefLocalDate(value):"—";
  const rabiesDocument=data.rabies.documentId
    ? `<a href="/api/pet-documents/${encodeURIComponent(data.rabies.documentId)}/download?disposition=inline" target="_blank" rel="noopener">View document</a>`
    : "—";
  // Rabies is listed with the rest but is stored on the pet's care record; editing it opens the
  // same dialog, which knows to write it where booking eligibility reads from.
  const rows=`<tr data-testid="pet-vaccination-rabies"><td>Rabies</td><td>${escape(stamp(data.rabies.expiresOn))}</td><td>${rabiesDocument}</td>`
    +`<td>${data.canEdit?`<button type="button" class="text-button" data-testid="pet-rabies-edit">Edit</button>`:"—"}</td></tr>`
    +data.items.map(item=>`<tr>`
      +`<td>${escape(item.vaccine)}</td><td>${escape(stamp(item.expiresOn))}</td>`
      +`<td>${item.hasDocument
        ? `<a href="/api/pet-vaccinations/${encodeURIComponent(item.id)}/document" target="_blank" rel="noopener">View document</a>`
        : "—"}</td>`
      +`<td>${data.canEdit?`<button type="button" class="text-button" data-pet-vaccination-edit="${escape(item.id)}">Edit</button>`
        +`<button type="button" class="text-button destructive" data-pet-vaccination-delete="${escape(item.id)}">Delete</button>`:"—"}</td></tr>`).join("");
  return `<section class="pet-profile-section">`
    +`<div class="pet-section-head"><h4>Vaccination records</h4>${data.canEdit?`<button type="button" class="text-button" data-testid="pet-vaccination-add">Add</button>`:""}</div>`
    +`<div class="pet-table-wrap" data-allow-horizontal-scroll><table class="pet-table" data-testid="pet-vaccinations">`
    +`<thead><tr><th scope="col">Vaccine</th><th scope="col">Expires on</th><th scope="col">Document</th><th scope="col">Action</th></tr></thead>`
    +`<tbody>${rows}</tbody></table></div></section>`;
}

function petVetSectionMarkup(pet){
  if(!allowed("pets.care.view")){
    return `<section class="pet-profile-section"><h4>Vet info</h4>`
      +`<p class="pet-empty">Vet details need the Pet Care permission.</p></section>`;
  }
  const editable=allowed("pets.care.edit");
  const attr=editable?"":"disabled";
  return `<form class="pet-profile-section" data-pet-section="vet">`
    +`<h4>Vet info</h4>`
    +`<div class="pet-field-grid">`
      +field("vetName","Vet name","text",`value="${escape(pet.vetName||"")}" ${attr}`)
      +field("vetPhone","Vet phone","tel",`value="${escape(pet.vetPhone||"")}" ${attr}`)
      +field("vetContactName","Contact name","text",`value="${escape(pet.vetContactName||"")}" ${attr}`)
      +field("vetContactPhone","Contact phone","tel",`value="${escape(pet.vetContactPhone||"")}" ${attr}`)
      +field("vetAddress","Address","text",`value="${escape(pet.vetAddress||"")}" ${attr}`,true)
    +`</div>`
    +(editable?`<div class="pet-section-actions"><button type="submit" class="primary compact" data-testid="pet-vet-save">Save</button></div>`:"")
    +`</form>`;
}

// Present and named, so the concept is documented, but not faked. Per-pet overrides would have
// to take part in price resolution, checkout, and reporting, and a section that looked editable
// while changing nothing would be worse than one that says where price actually comes from.
function petPricingSectionMarkup(){
  return `<section class="pet-profile-section pet-pricing-placeholder" data-testid="pet-pricing">`
    +`<h4>Customized price and duration</h4>`
    +`<p class="pet-empty">Not available. Pawsh resolves a service's price and duration from the`
    +` catalog and the pet's weight tier, and there is no per-pet override. This section is named`
    +` here so the idea is on the record; enabling it would mean price resolution, checkout, and`
    +` reporting all learning about overrides.</p></section>`;
}

function renderPetProfile(){
  const pet=petProfileState.pet;if(!pet)return;
  $("#pet-profile-title").textContent=`${petName(pet)} · Pet profile`;
  $("#pet-profile-body").innerHTML=
    petIdentitySectionMarkup(pet,petProfileState.photos)
    +petNotesSectionMarkup()
    +petPhotosSectionMarkup()
    +petMedicalSectionMarkup(pet)
    +petVaccinationsSectionMarkup()
    +petVetSectionMarkup(pet)
    +petPricingSectionMarkup();
  bindPetProfile();
}

async function reloadPetProfile({sections=["pet","notes","photos","vaccinations"]}={}){
  const id=petProfileState.petId;if(!id)return;
  const wants=new Set(sections);
  if(!petCoatColors.length){
    petCoatColors=await api("/api/pets/coat-colors").then(result=>result.items||[]).catch(()=>[]);
  }
  const [pet,notes,photos,vaccinations]=await Promise.all([
    wants.has("pet")||!petProfileState.pet
      ? api(`/api/pets/${id}`).catch(()=>null) : Promise.resolve(petProfileState.pet),
    wants.has("notes")?api(`/api/pets/${id}/notes`).then(result=>result.items).catch(()=>[]):Promise.resolve(petProfileState.notes),
    wants.has("photos")?api(`/api/pets/${id}/photos`).catch(()=>null):Promise.resolve(petProfileState.photos),
    wants.has("vaccinations")&&allowed("pets.care.view")
      ? api(`/api/pets/${id}/vaccinations`).catch(()=>null)
      : Promise.resolve(petProfileState.vaccinations)
  ]);
  if(petProfileState.petId!==id)return;
  if(pet)petProfileState.pet=pet;
  petProfileState.notes=notes||[];
  petProfileState.photos=photos;
  petProfileState.vaccinations=vaccinations;
  renderPetProfile();
}

// Kept as a name because three call sites read as "the weight off the form"; the arithmetic is
// the workspace unit's, not the pound it was written for.
function petPoundsToOunces(value){return ouncesFromWeight(value);}

async function savePetIdentity(form){
  const data=new FormData(form);
  const values=Object.fromEntries(data);
  const pet=petProfileState.pet;
  const updated=await api(`/api/pets/${pet.id}`,{method:"PUT",body:JSON.stringify({
    customerId:pet.customerId,
    name:values.name||null,species:values.species,...breedPayload(data),
    dateOfBirth:values.dateOfBirth||null,approximateAge:pet.approximateAge??null,
    weightOunces:petPoundsToOunces(values.weightPounds),
    sex:values.sex||null,coatNotes:values.coatNotes||null,
    groomingPreferences:pet.groomingPreferences??null,photoPermission:pet.photoPermission??null,
    mixedBreed:form.querySelector('[name="mixedBreed"]').checked,
    hairLength:values.hairLength||null,
    coatColor:values.coatColor||null,fixedStatus:values.fixedStatus||null,
    preferredShampoo:values.preferredShampoo||null,
    approximateAgeYears:values.approximateAgeYears===""?null:Number(values.approximateAgeYears),
    approximateAgeMonths:values.approximateAgeMonths===""?null:Number(values.approximateAgeMonths),
    version:pet.version
  })});
  petProfileState.pet=updated;
  renderPetProfile();
  toast("Pet saved");
}

async function savePetCareSection(form,section){
  const values=Object.fromEntries(new FormData(form));
  const pet=petProfileState.pet;
  const payload=section==="medical"
    ? {
      // A submitted medical form always records an answer, so "nothing ticked" becomes an
      // explicit empty list rather than leaving the question unasked.
      healthIssues:[...new FormData(form).getAll("healthIssues")].map(String),
      medicalNotes:values.medicalNotes||null
    }
    : {
      vetName:values.vetName||null,vetPhone:values.vetPhone||null,
      vetContactName:values.vetContactName||null,vetContactPhone:values.vetContactPhone||null,
      vetAddress:values.vetAddress||null
    };
  await api(`/api/pets/${pet.id}/care`,{method:"PUT",body:JSON.stringify({...payload,version:pet.version})});
  await reloadPetProfile({sections:["pet"]});
  toast(section==="medical"?"Medical info saved":"Vet info saved");
}

function openPetNoteEditor(){
  openStackedDialog({
    title:"Add a note",
    body:`<label class="stacked-field">Note<textarea name="body" rows="5" maxlength="5000" placeholder="Grooming instructions, temperament, anything the next groomer should know."></textarea></label>`
      +`<label class="stacked-check"><input type="checkbox" name="pinned"> Pin to the top of the thread</label>`,
    dismissLabel:"Cancel",confirmLabel:"Add",
    onConfirm:async body=>{
      const text=String(body.querySelector('[name="body"]').value||"").trim();
      if(!text){toast("Enter the note first.");return false;}
      await api(`/api/pets/${petProfileState.petId}/notes`,{method:"POST",
        body:JSON.stringify({body:text,pinned:body.querySelector('[name="pinned"]').checked})});
      await reloadPetProfile({sections:["notes"]});
      return true;
    }
  });
}

// The vaccines a salon records. Rabies leads because it is the one that decides whether an
// appointment can go ahead; the rest are here so the list is useful rather than exhaustive.
const PET_VACCINES=["Rabies","Bordetella","DHPP","Leptospirosis","Canine Influenza","Lyme","FVRCP","Feline Leukemia"];

/**
 * One dialog for every vaccine, including rabies.
 *
 * Rabies does not become a row in `pet_vaccinations`: it is written to the pet's care record,
 * where the expiry drives appointment eligibility and customer notices, and its certificate goes
 * to the rabies document. Everything else is an ordinary record with its own attachment. The
 * operator sees one form either way; what differs is where the answer is kept, and that matters
 * because there can only be one answer to "is this dog covered?".
 */
function openPetVaccinationEditor(existing){
  const known=existing?.vaccine&&!PET_VACCINES.includes(existing.vaccine)
    ? [...PET_VACCINES,existing.vaccine] : PET_VACCINES;
  const selected=existing?.vaccine||"Rabies";
  openStackedDialog({
    title:"Vaccine record",
    body:`<label class="stacked-field">Vaccine<select name="vaccine">`
      +known.map(value=>`<option value="${escape(value)}" ${value===selected?"selected":""}>${escape(value)}</option>`).join("")
      +`<option value="__other">Other…</option></select></label>`
      +`<label class="stacked-field" data-vaccine-other hidden>Vaccine name<input name="vaccineOther" maxlength="80"></label>`
      +`<label class="stacked-field">Expires on<input name="expiresOn" type="date" value="${existing?.expiresOn?String(existing.expiresOn).slice(0,10):""}"></label>`
      +`<label class="stacked-field">Document<input name="document" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>`
      +`<p class="fine">One PDF or image. Rabies is stored on the pet's care record, where its expiry decides whether an appointment can go ahead.</p>`,
    dismissLabel:"Cancel",confirmLabel:"OK",
    onConfirm:async body=>{
      const select=body.querySelector('[name="vaccine"]');
      const other=body.querySelector('[name="vaccineOther"]');
      const vaccine=select.value==="__other"?String(other.value||"").trim():select.value;
      const expiresOn=String(body.querySelector('[name="expiresOn"]').value||"");
      // Both are required: a vaccine with no expiry cannot answer the only question anybody
      // asks of it.
      if(!vaccine){toast("Choose or name the vaccine.");return false;}
      if(!expiresOn){toast("Enter the expiry date.");return false;}
      const file=body.querySelector('[name="document"]').files?.[0]||null;
      if(vaccine.trim().toLowerCase()==="rabies"){
        await savePetRabiesVaccination(expiresOn,file);
      }else{
        const path=`/api/pets/${petProfileState.petId}/vaccinations`;
        const saved=existing
          ? await api(`/api/pet-vaccinations/${existing.id}`,{method:"PATCH",
            body:JSON.stringify({vaccine,expiresOn,version:existing.version})}).then(()=>existing)
          : await api(path,{method:"POST",body:JSON.stringify({vaccine,expiresOn})});
        if(file){
          const upload=new FormData();
          upload.append("file",file,file.name||"vaccination");
          await api(`/api/pet-vaccinations/${saved.id}/document`,{method:"POST",body:upload});
        }
      }
      await reloadPetProfile({sections:["vaccinations","pet"]});
      return true;
    }
  });
  const select=$('#stacked-dialog [name="vaccine"]');
  const otherField=$("#stacked-dialog [data-vaccine-other]");
  const syncOther=()=>{otherField.hidden=select.value!=="__other";};
  select.addEventListener("change",syncOther);
  syncOther();
}

/**
 * Rabies goes to the two places that already own it: the expiry onto the pet's care record, and
 * the certificate into the rabies document. Writing it as a free record instead would leave two
 * dates and no way to say which one booking should believe.
 */
async function savePetRabiesVaccination(expiresOn,file){
  const pet=petProfileState.pet;
  await api(`/api/pets/${pet.id}/care`,{method:"PUT",
    body:JSON.stringify({vaccinationExpiresOn:expiresOn,version:pet.version})});
  if(!file)return;
  const current=petProfileState.vaccinations?.rabies?.documentId||null;
  const upload=new FormData();
  upload.append("metadata",JSON.stringify({
    uploadRequestId:globalThis.crypto.randomUUID(),
    expectedCurrentDocumentId:current,
    ...(current?{expectedCurrentDocumentVersion:1}:{}),
    expiration:{intent:"preserve"}
  }));
  upload.append("file",file,file.name||"rabies");
  await api(`/api/pets/${pet.id}/documents/rabies`,{method:"POST",body:upload});
}

function bindPetProfile(){
  const root=$("#pet-profile-body");
  root.querySelectorAll("[data-pet-section]").forEach(form=>form.addEventListener("submit",async event=>{
    event.preventDefault();
    const button=form.querySelector('button[type="submit"]');
    if(button)button.disabled=true;
    try{
      if(form.dataset.petSection==="identity")await savePetIdentity(form);
      else await savePetCareSection(form,form.dataset.petSection);
    }catch(error){markBreedRefusal(error);toast(error.message);}
    finally{if(button)button.disabled=false;}
  }));
  setupBreedAutocomplete();

  root.querySelector('[data-testid="pet-note-add"]')?.addEventListener("click",openPetNoteEditor);
  root.querySelectorAll("[data-pet-note-pin]").forEach(button=>button.addEventListener("click",async()=>{
    const note=petProfileState.notes.find(item=>item.id===button.dataset.petNotePin);
    try{
      await api(`/api/pets/${petProfileState.petId}/notes/${note.id}`,{method:"PATCH",
        body:JSON.stringify({pinned:!note.pinned})});
      await reloadPetProfile({sections:["notes"]});
    }catch(error){toast(error.message);}
  }));
  root.querySelectorAll("[data-pet-note-delete]").forEach(button=>button.addEventListener("click",async()=>{
    if(!confirm("Delete this note?"))return;
    try{
      await api(`/api/pets/${petProfileState.petId}/notes/${button.dataset.petNoteDelete}`,{method:"DELETE"});
      await reloadPetProfile({sections:["notes"]});
    }catch(error){toast(error.message);}
  }));

  root.querySelector('[data-testid="pet-photo-add"]')?.addEventListener("click",()=>{
    const input=document.createElement("input");
    input.type="file";input.accept=PHOTO_ACCEPT;
    input.addEventListener("change",async()=>{
      const file=input.files?.[0];if(!file)return;
      const body=new FormData();
      body.append("metadata",JSON.stringify({uploadRequestId:globalThis.crypto.randomUUID(),useAsAvatar:false}));
      body.append("file",file,file.name||"photo");
      try{
        await api(`/api/pets/${petProfileState.petId}/photos`,{method:"POST",body});
        await reloadPetProfile({sections:["photos"]});
      }catch(error){toast(error.message);}
    },{once:true});
    input.click();
  });
  root.querySelectorAll("[data-pet-photo-remove]").forEach(button=>button.addEventListener("click",async()=>{
    if(!confirm("Remove this photo?"))return;
    try{
      await api(`/api/pet-photos/${button.dataset.petPhotoRemove}`,{method:"DELETE"});
      await reloadPetProfile({sections:["photos"]});
    }catch(error){toast(error.message);}
  }));
  root.querySelectorAll("[data-pet-avatar]").forEach(button=>button.addEventListener("click",async()=>{
    try{
      await api(`/api/pets/${petProfileState.petId}/avatar`,{method:"PATCH",
        body:JSON.stringify({photoId:button.dataset.petAvatar})});
      await reloadPetProfile({sections:["photos"]});
      toast("Profile photo updated");
    }catch(error){toast(error.message);}
  }));

  root.querySelector('[data-testid="pet-vaccination-add"]')?.addEventListener("click",()=>openPetVaccinationEditor(null));
  root.querySelectorAll("[data-pet-vaccination-edit]").forEach(button=>button.addEventListener("click",()=>{
    openPetVaccinationEditor(petProfileState.vaccinations.items.find(item=>item.id===button.dataset.petVaccinationEdit));
  }));
  root.querySelectorAll("[data-pet-vaccination-delete]").forEach(button=>button.addEventListener("click",async()=>{
    if(!confirm("Delete this vaccination record?"))return;
    try{
      await api(`/api/pet-vaccinations/${button.dataset.petVaccinationDelete}`,{method:"DELETE"});
      await reloadPetProfile({sections:["vaccinations"]});
    }catch(error){toast(error.message);}
  }));
  root.querySelector('[data-testid="pet-rabies-edit"]')?.addEventListener("click",()=>
    openPetVaccinationEditor({vaccine:"Rabies",expiresOn:petProfileState.vaccinations?.rabies?.expiresOn||null}));
}

// The panel's footer actions. Both are about the pet's standing rather than any one section,
// so they live beside Close rather than inside a form.
function bindPetProfileDialog(){
  const dialog=$("#pet-profile-dialog");
  dialog.querySelectorAll(".close").forEach(button=>
    button.addEventListener("click",()=>dialog.close()));
  dialog.addEventListener("close",()=>{$("#stacked-dialog").close();});
  dialog.querySelector('[data-testid="pet-deceased"]')?.addEventListener("click",async()=>{
    const pet=petProfileState.pet;if(!pet)return;
    const marking=!pet.deceasedAt;
    if(marking&&!confirm(`Record ${petName(pet)} as having passed away? The record stays so past visits and invoices remain explainable.`))return;
    try{
      await api(`/api/pets/${pet.id}/deceased`,{method:"POST",body:JSON.stringify({deceased:marking})});
      await reloadPetProfile({sections:["pet"]});
      toast(marking?"Recorded as passed away":"Marking removed");
    }catch(error){toast(error.message);}
  });
  dialog.querySelector('[data-testid="pet-archive"]')?.addEventListener("click",async()=>{
    const pet=petProfileState.pet;if(!pet)return;
    if(!confirm(`Archive ${petName(pet)}? History is kept and the pet stops appearing for booking.`))return;
    try{
      await api(`/api/pets/${pet.id}/archive`,{method:"POST"});
      dialog.close();
      toast("Pet archived");
      await refresh();
      if(state.clientProfile)await reloadClientProfile();
    }catch(error){toast(error.message);}
  });
}
bindPetProfileDialog();

async function openPetProfile(petId){
  petProfileState.petId=petId;
  petProfileState.pet=null;
  petProfileState.notes=[];petProfileState.photos=null;petProfileState.vaccinations=null;
  const dialog=$("#pet-profile-dialog");
  // Rendered once, after the record arrives, for the same reason the client editor is: a first
  // paint from the cached copy would be replaced mid-edit and take any typing with it.
  $("#pet-profile-title").textContent="Pet";
  $("#pet-profile-body").innerHTML=`<p class="pet-empty">Loading pet…</p>`;
  if(!dialog.open)dialog.showModal();
  await reloadPetProfile();
  if(!petProfileState.pet){
    $("#pet-profile-body").innerHTML=`<p class="pet-empty">This pet could not be loaded.</p>`;
  }
}
function openPreferredGroomer(){const {customer}=state.clientProfile.data,active=state.employees.filter(employee=>employee.active);openModal("Set preferred groomer",`<label class="wide">Preferred groomer<select name="employeeId"><option value="">Not set</option>${active.map(employee=>`<option value="${employee.id}" ${customer.preferredEmployeeId===employee.id?"selected":""}>${escape(employee.displayName)}</option>`).join("")}</select></label>`,async form=>{await api(`/api/customers/${customer.id}/preferred-groomer`,{method:"PATCH",body:JSON.stringify({employeeId:form.get("employeeId")||null})});const data=await api(`/api/customers/${customer.id}/history`);state.clientProfile.data=data;renderClientProfile();},{cancelLabel:"Cancel",submitLabel:"Save"});}
// History opens at two rows and grows three at a time, with arrows stepping through pages of
// whatever size it has grown to. A client with years of visits would otherwise push the rest of
// the profile off the screen, and the two most recent grooms are what anyone actually reads.
const HISTORY_INITIAL_ROWS=2;
const HISTORY_ROW_STEP=3;
function historyView(){
  const view=state.clientProfile?.historyView;
  return view||{page:1,pageSize:HISTORY_INITIAL_ROWS};
}
function historyPageCount(){
  const total=Number(state.clientProfile?.data?.history?.total||0);
  return Math.max(1,Math.ceil(total/historyView().pageSize));
}
// The profile projection is bounded, and every change of page or page size re-reads rather than
// slicing what is already loaded, so the rows on screen always match the server's ordering.
async function loadClientHistoryPage({page,pageSize}){
  const profile=state.clientProfile;if(!profile)return;
  const customerId=profile.data.customer.id;
  profile.historyLoading=true;renderClientProfile();
  try{
    const next=await api(`/api/customers/${customerId}/appointments?page=${page}&pageSize=${pageSize}&direction=past`);
    if(state.clientProfile?.data.customer.id!==customerId)return;
    // A deletion elsewhere can leave the requested page past the end. Step back rather than
    // showing an empty table under a non-zero count.
    if(!next.items.length&&page>1&&next.total>0){
      return loadClientHistoryPage({page:Math.max(1,Math.ceil(next.total/pageSize)),pageSize});
    }
    profile.data.history={items:next.items,total:next.total};
    profile.historyView={page,pageSize};
  }catch(error){toast(error.message);}
  finally{
    if(state.clientProfile?.data.customer.id===customerId){
      state.clientProfile.historyLoading=false;renderClientProfile();
    }
  }
}
function loadMoreClientHistory(){
  const profile=state.clientProfile;if(!profile)return Promise.resolve();
  const {page,pageSize}=historyView();
  const total=Number(profile.data?.history?.total||0);
  const nextSize=Math.min(total||pageSize+HISTORY_ROW_STEP,pageSize+HISTORY_ROW_STEP);
  const loaded=profile.data?.history?.items?.length||0;
  // The opening preview runs ahead of the visible window, so the first growth usually needs no
  // request at all — widen the window over rows already in hand.
  if(page===1&&loaded>=Math.min(nextSize,total)){
    profile.historyView={page,pageSize:nextSize};
    renderClientProfile();
    return Promise.resolve();
  }
  // Growing the page keeps the first row on screen where it was, so "load more" reads as more
  // rows appended rather than the list jumping to a different slice.
  const firstRow=(page-1)*pageSize;
  return loadClientHistoryPage({page:Math.floor(firstRow/nextSize)+1,pageSize:nextSize});
}
function stepClientHistory(delta){
  const {page,pageSize}=historyView();
  const next=Math.min(historyPageCount(),Math.max(1,page+delta));
  if(next===page)return Promise.resolve();
  return loadClientHistoryPage({page:next,pageSize});
}
// ---------------------------------------------------------------------------
// Client profile
// ---------------------------------------------------------------------------
const CLIENT_NOTE_PAGE_SIZE=50;
const clientAttr=value=>escape(value).replaceAll('"',"&quot;");
// A note thread failing must not cost the operator the rest of the profile, so the load resolves
// to a rendered failure state instead of rejecting the profile open.
async function loadClientNotes(customerId){
  try{
    const result=await api(`/api/customers/${customerId}/notes?page=1&pageSize=${CLIENT_NOTE_PAGE_SIZE}`);
    return {items:result.items||[],total:Number(result.total)||0,failed:false};
  }catch(error){return {items:[],total:0,failed:true,message:error.message};}
}
/**
 * A popup note is the salon flagging something to be read before anybody acts on this client, so
 * it is shown when the profile opens rather than left to be found in the thread. It fires on an
 * open only: reloading after an edit must not throw the dialog back in the operator's face.
 */
function showClientPopupNotes(){
  const profile=state.clientProfile;if(!profile)return;
  const popups=(profile.notes.items||[]).filter(note=>note.pinned);
  if(!popups.length)return;
  openModal(popups.length===1?"Popup note":`Popup notes (${popups.length})`,
    `<div class="wide popup-notes" data-testid="client-popup-notes">`
    +popups.map(note=>`<article class="popup-note"><p class="popup-note-body">${escape(note.body)}</p>`
      +`<p class="note-meta">${escape(noteStamp(note.createdAt))} by ${escape(note.authorName||"Unknown")}</p></article>`).join("")
    +`</div>`,
    null,{cancelLabel:"OK"});
}
async function reloadClientProfile(){
  const profile=state.clientProfile;if(!profile)return;
  const customerId=profile.data.customer.id;
  const [data,notes,agreements]=await Promise.all([api(`/api/customers/${customerId}/history`),loadClientNotes(customerId),loadClientAgreements(customerId)]);
  profile.data=data;profile.notes=notes;profile.agreements=agreements;
  state.pets=[...state.pets.filter(pet=>pet.customerId!==customerId),...data.pets];
  renderClientProfile();
}
// `Monday, June 1, 2026 12:58 PM` in the operator's locale. Notes carry a wall-clock authorship
// stamp rather than a scheduling instant, so they use the browser zone the author was in.
function noteStamp(value){
  const when=new Date(value);
  return formatPrefDateTime(when);
}
function clientNoteMarkup(note,editable){
  const menu=editable?`<details class="row-menu note-menu"><summary class="row-menu-trigger" aria-expanded="false" aria-label="Actions for note by ${clientAttr(note.authorName)}"><span aria-hidden="true">⋯</span></summary><div class="row-menu-list" role="group" aria-label="Actions for note by ${clientAttr(note.authorName)}"><button type="button" class="row-menu-item note-edit" data-note-id="${clientAttr(note.id)}">Edit</button><button type="button" class="row-menu-item note-pin" data-note-id="${clientAttr(note.id)}">${note.pinned?"Stop showing as popup":"Show as popup note"}</button><button type="button" class="row-menu-item note-delete" data-note-id="${clientAttr(note.id)}">Delete</button></div></details>`:"";
  // A popup note is the one the salon wants read before anybody acts on this client: it sorts to
  // the top of the thread, carries the alert mark, and opens with the profile.
  const marker=note.pinned
    ?`<span class="note-popup-flag" role="img" aria-label="Popup note" title="Shown as a popup when this client opens"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.4v.2"/></svg></span> `
    :"";
  return `<article class="client-note${note.pinned?" pinned":""}"><div class="note-body">${marker}${escape(note.body)}</div><p class="note-meta">${escape(noteStamp(note.createdAt))} by ${escape(note.authorName||"Unknown")}${note.updatedAt&&note.updatedAt!==note.createdAt?" · edited":""}</p>${menu}</article>`;
}
function clientNotesMarkup(profile){
  const notes=profile.notes,editable=allowed("customers.edit");
  if(notes.failed)return `<div class="note-failure"><p>Notes could not be loaded.</p><button type="button" class="secondary compact notes-retry">Retry</button></div>`;
  if(!notes.items.length)return `<p class="note-empty">No notes yet.</p>`;
  // Pinned notes already sort first server-side, so the collapsed thread always shows the note the
  // salon flagged as the one to read.
  const shown=profile.notesExpanded?notes.items:notes.items.slice(0,1);
  const hidden=notes.items.length-shown.length;
  const loadedShort=notes.total>notes.items.length?`<p class="note-truncated">Showing the ${notes.items.length} most recent of ${notes.total} notes.</p>`:"";
  const toggle=notes.items.length>1?`<button type="button" class="note-toggle">${profile.notesExpanded?"hide":`see more (${hidden})`}</button>`:"";
  return `${shown.map(note=>clientNoteMarkup(note,editable)).join("")}${toggle}${profile.notesExpanded?loadedShort:""}`;
}
function clientNoteFields(note){
  return `<label class="wide">Note<textarea name="body" required maxlength="5000" rows="6">${escape(note?.body||"")}</textarea></label>`
    +`<label class="inline-check"><input type="checkbox" name="pinned"${note?.pinned?" checked":""}> Show as popup note</label>`
    +`<p class="field-hint wide">A popup note opens with this client's profile and sorts to the top of the thread.</p>`;
}
function addClientNote(){
  const profile=state.clientProfile;if(!profile)return;
  openModal("Client note",clientNoteFields(null),async form=>{
    const value=String(form.get("body")||"").trim();
    if(!value)throw new Error("A note needs some text");
    await api(`/api/customers/${profile.data.customer.id}/notes`,{method:"POST",body:JSON.stringify({body:value,pinned:form.get("pinned")==="on"})});
    return ()=>reloadClientProfile();
  },{cancelLabel:"Cancel",submitLabel:"Add note"});
}
function editClientNote(noteId){
  const profile=state.clientProfile,note=profile?.notes.items.find(item=>item.id===noteId);if(!note)return;
  openModal("Client note",clientNoteFields(note),async form=>{
    const value=String(form.get("body")||"").trim();
    if(!value)throw new Error("A note needs some text");
    await api(`/api/customers/${profile.data.customer.id}/notes/${noteId}`,{method:"PATCH",body:JSON.stringify({body:value,pinned:form.get("pinned")==="on"})});
    return ()=>reloadClientProfile();
  },{cancelLabel:"Cancel",submitLabel:"Save note"});
}
async function toggleClientNotePin(noteId){
  const profile=state.clientProfile,note=profile?.notes.items.find(item=>item.id===noteId);if(!note)return;
  try{
    await api(`/api/customers/${profile.data.customer.id}/notes/${noteId}`,{method:"PATCH",body:JSON.stringify({pinned:!note.pinned})});
    await reloadClientProfile();toast(note.pinned?"Note no longer pops up":"Note will pop up with this profile");
  }catch(error){toast(error.message);}
}
async function deleteClientNote(noteId){
  const profile=state.clientProfile;if(!profile)return;
  if(!confirm("Delete this note? It cannot be recovered."))return;
  try{
    // Fastify rejects a DELETE that carries a body, so this request deliberately sends neither a
    // body nor a content-type: api() only sets the header when a body is supplied.
    await api(`/api/customers/${profile.data.customer.id}/notes/${noteId}`,{method:"DELETE"});
    await reloadClientProfile();toast("Note deleted");
  }catch(error){toast(error.message);}
}
let noteMenusBound=false;
function closeNoteMenus(){$$(".note-menu[open]").forEach(menu=>{menu.open=false;menu.querySelector("summary")?.setAttribute("aria-expanded","false");});}
function bindNoteMenus(){
  if(noteMenusBound)return;noteMenusBound=true;
  document.addEventListener("click",event=>{if(!event.target.closest?.(".note-menu"))closeNoteMenus();});
  document.addEventListener("keydown",event=>{if(event.key==="Escape")closeNoteMenus();});
}

// Preferences. Four of these switches are stored but nothing in Pawsh reads them yet — there is no
// SMS channel, no online booking surface and nothing that generates rebook reminders — so they are
// labelled as saved-only rather than presented as controls that take effect.
const CLIENT_PREFERENCE_SWITCHES=[
  ["blockMessages","Block messages",false,false],
  ["blockOnlineBooking","Block online booking",false,false],
  ["marketingSmsAllowed","Opt out of marketing SMS",true,false],
  ["emailAllowed","Opt out of marketing email",true,true]
];
async function saveClientPreference(patch,label){
  const profile=state.clientProfile;if(!profile)return;
  try{
    const updated=await api(`/api/customers/${profile.data.customer.id}/preferences`,{method:"PATCH",body:JSON.stringify(patch)});
    Object.assign(profile.data.customer,updated);
    toast(`${label} saved`);
  }catch(error){toast(error.message);}
  renderClientProfile();
}
async function archiveClientFromProfile(){
  const profile=state.clientProfile;if(!profile)return;
  if(!confirm("Mark this client inactive? Their operational and financial history is kept, and Pawsh has no reactivation flow yet."))return;
  try{
    await api(`/api/customers/${profile.data.customer.id}/archive`,{method:"POST"});
    toast("Client marked inactive");await reloadClientProfile();
  }catch(error){toast(error.message);}
}
function clientPreferenceMarkup(customer){
  const editable=allowed("customers.edit")&&!customer.archivedAt;
  const disabled=editable?"":" disabled";
  const unenforced=`<span class="pref-unenforced">Saved, not enforced</span>`;
  const switches=CLIENT_PREFERENCE_SWITCHES.map(([key,label,inverted,enforced])=>{
    const stored=Boolean(customer[key]),checked=inverted?!stored:stored;
    return `<label class="pref-row"><span class="pref-text"><span class="pref-name">${escape(label)}</span>${enforced?"":unenforced}</span><input type="checkbox" role="switch" class="pref-toggle" data-pref-switch="${key}"${checked?" checked":""}${disabled}></label>`;
  }).join("");
  const frequency=customer.bookingFrequencyWeeks==null?"":String(customer.bookingFrequencyWeeks);
  return `<p class="pref-intro">Pawsh stores every preference below, but only the marketing-email opt-out and the inactive flag change what the system does today. The rest are recorded for the salon and marked accordingly.</p>`
    +`<div class="pref-row pref-row-frequency"><span class="pref-text"><span class="pref-name">Booking frequency</span>${unenforced}</span><span class="pref-frequency"><label class="visually-hidden" for="pref-booking-frequency">Booking frequency in weeks</label><input id="pref-booking-frequency" type="number" min="1" max="104" step="1" inputmode="numeric" value="${clientAttr(frequency)}" placeholder="—"${disabled}><span class="pref-unit">Weeks</span></span></div>`
    +switches
    +`<div class="pref-row pref-row-status"><span class="pref-text"><span class="pref-name">Client status</span><span class="pref-hint">${customer.archivedAt?`Inactive since ${escape(formatPrefDate(new Date(customer.archivedAt)))}. Pawsh has no reactivation flow yet.`:"History is kept. Pawsh has no reactivation flow yet, so this is one-way."}</span></span>${customer.archivedAt?`<span class="status-dot inactive">Inactive</span>`:`<button type="button" class="secondary compact pref-archive"${allowed("customers.edit")?"":" disabled"}>Mark inactive</button>`}</div>`
    +(customer.archivedAt?`<p class="pref-hint">Preferences cannot be changed while the client is inactive.</p>`:"");
}

// Pets. `Fixed` from the reference has no column in Pawsh, so the fourth fact is rabies status,
// which the salon does record and does act on.
function petFactCells(pet){
  const care=allowed("pets.care.view"),locked="Requires Pet Care access";
  const rabies=pet.vaccinationExpiresOn
    ? `Expires ${formatPrefLocalDate(pet.vaccinationExpiresOn)}`
    : (care?"Not recorded":locked);
  return [["Behavior",care?(pet.behaviorNotes||"Not recorded"):locked],["Rabies",rabies],["Hair length",pet.coatNotes||"Not recorded"],["Gender",pet.sex||"Not recorded"]]
    .map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("");
}
// Pawsh has no per-pet note thread; these are the pet-care fields, stamped with the pet record's
// own last-updated time. `updatedBy` is a user id the client cannot resolve to a name, so no
// authorship is claimed.
function petNotesMarkup(pet){
  const entries=[["safety alert",pet.safetyAlerts],["medical",pet.medicalNotes],["grooming",pet.groomingPreferences]]
    .filter(([,value])=>typeof value==="string"&&value.trim().length>0);
  if(!entries.length)return "";
  return `<div class="pet-card-notes">${entries.map(([label,value])=>`<p class="pet-note${label==="safety alert"?" alert":""}"><span class="note-pinned">[${escape(label)}]</span> ${escape(value)}</p>`).join("")}<p class="note-meta">Pet record updated ${escape(noteStamp(pet.updatedAt))}</p></div>`;
}
function petCardMarkup(pet){
  const weight=formatPetWeight(pet.weightOunces);
  const detail=[pet.breed||pet.species||"Pet",weight].filter(Boolean).join(" - ");
  return `<article class="pet-card"><div class="pet-card-head">${pet.avatarPhotoId?`<img class="pet-avatar-image pet-card-avatar" src="/api/pet-photos/${encodeURIComponent(pet.avatarPhotoId)}/content" alt="">`:`<span class="pet-avatar" aria-hidden="true">${escape(Array.from(pet.name||"P")[0]?.toUpperCase()||"P")}</span>`}<button type="button" class="pet-card-name" data-pet-profile="${clientAttr(pet.id)}"><strong>${escape(petName(pet))}</strong> <span>(${escape(detail)})</span></button></div><dl class="pet-fact-grid">${petFactCells(pet)}</dl>${petNotesMarkup(pet)}</article>`;
}

// History table. Duration reads `1 h 30 mins`, matching how the salon quotes an appointment.
function appointmentDurationLabel(item){
  const minutes=Math.max(1,Math.round((new Date(item.endAt)-new Date(item.startAt))/60000));
  const hours=Math.floor(minutes/60),rest=minutes%60,parts=[];
  if(hours)parts.push(`${hours} h`);
  if(rest||!hours)parts.push(`${rest} min${rest===1?"":"s"}`);
  return parts.join(" ");
}
// `/api/customers/:id/history` carries no invoice for an appointment, so payment state can only be
// shown for appointments the calendar window has already loaded with `invoiceStatus`. The lifecycle
// badge is always present; the payment chip is additive, and its absence means "not known here"
// rather than "unpaid".
function appointmentPaymentIndex(){
  return new Map(state.appointments.filter(item=>item.invoiceStatus).map(item=>[item.id,item]));
}
function historyRowMarkup(item,{pets,payments,selectedId}){
  const zone=item.schedulingTimezone||schedulingZone(),start=new Date(item.startAt);
  const services=item.services||[],groomers=item.groomers||[];
  const prices=services.map(service=>service.priceMinor).filter(value=>value!==null&&value!==undefined);
  const total=services.length&&prices.length===services.length?money(prices.reduce((sum,value)=>sum+Number(value),0)):"—";
  const pet=pets.find(entry=>entry.id===item.petId);
  const paid=payments.get(item.id);
  const paymentStatus=paid?paid.invoiceStatus:null;
  const payment=!paid?""
    :invoiceRefunded(paymentStatus)?`<span class="history-chip chip-refunded">${escape(invoiceStatusLabel(paymentStatus))}</span>`
    :`<span class="history-chip chip-${paymentStatus==="paid"?"paid":"unpaid"}">${paymentStatus==="paid"?"Paid":`Unpaid ${money(paid.invoiceBalanceMinor||0)}`}</span>`;
  return `<tr class="history-row${item.id===selectedId?" active":""}">`
    +`<td class="history-id"><button type="button" class="text-button" data-profile-appointment="${clientAttr(item.id)}" aria-haspopup="dialog" aria-label="Open appointment #${escape(String(item.id).slice(0,8))}">#${escape(String(item.id).slice(0,8))}</button></td>`
    +`<td class="history-status"><span class="history-chip chip-${clientAttr(item.status)}">${escape(item.status.replace("_"," "))}</span>${payment}</td>`
    +`<td class="history-date">${escape(formatPrefDate(start,zone))}<span>${escape(formatPrefWeekdayTime(start,zone))}</span></td>`
    +`<td class="history-pets"><strong>${escape(item.petName||"—")}</strong>${pet?.breed?`<span>(${escape(pet.breed)})</span>`:""}</td>`
    +`<td class="history-items">${services.length?`Services: ${escape(services.map(service=>service.name).join(", "))}`:"<span class=\"muted-cell\">No services recorded</span>"}</td>`
    +`<td class="history-total">${total}</td>`
    +`<td class="history-duration">${escape(appointmentDurationLabel(item))}</td>`
    +`<td class="history-groomer">${escape(groomers.length?groomers.map(groomer=>groomer.displayName).join(", "):item.employeeName||"—")}</td>`
    +`</tr>`;
}

// ---------------------------------------------------------------------------
// Client agreements
// ---------------------------------------------------------------------------
// Pawsh has no client-facing signing page and no e-signature. `signatureMethod` is always
// `staff_recorded`, so every surface here says a staff member typed the name and names who
// recorded it, rather than implying the client signed something online.
//
// Delivery is equally literal: `delivery.channels` is the only authority on what can be sent. The
// reference layout offers "By SMS", so the option is rendered — permanently disabled, carrying the
// server's own `detail` as its reason — instead of being hidden or, worse, made pressable. Email is
// enabled only while the server reports it available, so Send is never a guaranteed 409.

// A dismissed banner stays dismissed for the tab's lifetime, per client, so a profile re-render or
// a return visit in the same session does not resurrect a notice the operator already read.
const dismissedAgreementBanners=new Set();
const AGREEMENT_SEND_OUTCOMES={queued:"queued",already_queued:"already queued",skipped_signed:"already signed",skipped_archived:"template archived",not_found:"template missing"};

// A failing agreements load must not cost the operator the rest of the profile, so this resolves to
// a rendered failure state instead of rejecting the profile open.
async function loadClientAgreements(customerId){
  try{
    const result=await api(`/api/customers/${customerId}/agreements`);
    return {items:result.items||[],summary:result.summary||null,delivery:result.delivery||null,customerArchived:Boolean(result.customerArchived),failed:false};
  }catch(error){return {items:[],summary:null,delivery:null,customerArchived:false,failed:true,message:error.message};}
}
function agreementChannel(agreements,channel){return agreements?.delivery?.channels?.find(entry=>entry.channel===channel)||null;}
function agreementStamp(value){
  const when=new Date(value);
  return formatPrefDateAndTime(when);
}
// Signing and sending are both `customers.edit`, and the server refuses either against an archived
// client, so the controls are withheld rather than offered and then rejected.
function agreementsEditable(agreements){return allowed("customers.edit")&&!agreements?.customerArchived;}

function agreementStateMarkup(item){
  if(item.status==="signed"){
    const detail=[item.signedName?`signed by ${item.signedName}`:null,item.recordedByName?`recorded by ${item.recordedByName}`:null].filter(Boolean).join(" · ");
    return `<p class="agreement-state signed">Signed ${escape(agreementStamp(item.signedAt))}</p>`
      +(detail?`<p class="agreement-audit">${escape(detail)}${item.signedTemplateVersion?` · version ${escape(String(item.signedTemplateVersion))}`:""}</p>`:"")
      +(item.signatureNote?`<p class="agreement-audit">${escape(`“${item.signatureNote}”`)}</p>`:"");
  }
  const sent=item.sentAt?`<p class="agreement-audit">Emailed ${escape(agreementStamp(item.sentAt))}${item.sendCount>1?` · sent ${escape(String(item.sendCount))} times`:""}</p>`:"";
  return `<p class="agreement-state unsigned">not signed</p>${sent}`;
}
function agreementRowMarkup(item,editable){
  const action=item.status==="signed"
    ? (editable?`<button type="button" class="text-button agreement-correct" data-agreement-template="${clientAttr(item.templateId)}">Correct</button>`:"")
    : (editable?`<button type="button" class="primary compact agreement-sign" data-agreement-template="${clientAttr(item.templateId)}">Sign Agreement</button>`:"");
  // The name is a button, not a heading. Staff are asked to attest to a document they have to
  // be able to read first, and the document was previously only reachable from inside the
  // signing dialog — after the decision to sign had effectively been made.
  return `<li class="agreement-row">`
    +`<div class="agreement-row-main"><p class="agreement-name">`
      +`<button type="button" class="agreement-name-open" data-agreement-template="${clientAttr(item.templateId)}" aria-label="Open ${clientAttr(item.name)}">`
      +`<span class="agreement-name-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg></span>`
      +`<span class="agreement-name-label">${escape(item.name)}</span></button>`
      +`${item.required?` <span class="agreement-tag">Required</span>`:""}${item.active?"":` <span class="agreement-tag archived">Archived</span>`}</p>`
      +`${agreementStateMarkup(item)}</div>`
    +`<div class="agreement-row-action">${action}</div></li>`;
}

// The agreement itself: what it says, whether it was sent, and what was recorded against it.
// Screenshot-equivalent of a "sent history" popup, except the history and the document are one
// dialog rather than two, because there is only ever one send record per template per client.
function openAgreementDetail(customerId,templateId){
  const agreements=state.clientProfile?.agreements;
  const item=agreements?.items.find(entry=>entry.templateId===templateId);
  if(!item)return;
  const editable=agreementsEditable(agreements);
  const status=item.status==="signed"
    ? `<p class="agreement-detail-status signed">Signed ${escape(agreementStamp(item.signedAt))}</p>`
      +`<p class="agreement-audit">${escape([
        item.signedName?`Signed by ${item.signedName}`:null,
        item.recordedByName?`recorded by ${item.recordedByName}`:null,
        item.signedTemplateVersion?`version ${item.signedTemplateVersion}`:null
      ].filter(Boolean).join(" · ")||"No signature detail was recorded.")}</p>`
      +(item.signatureNote?`<p class="agreement-audit">${escape(`“${item.signatureNote}”`)}</p>`:"")
    : `<p class="agreement-detail-status unsigned">Not signed</p>`;
  const sent=item.sentAt
    ? `<p class="agreement-audit">Emailed ${escape(agreementStamp(item.sentAt))}${item.sendCount>1?` · sent ${escape(String(item.sendCount))} times`:""}${item.lastSentChannel?` · by ${escape(item.lastSentChannel)}`:""}</p>`
    : `<p class="agreement-audit">Never sent to this client.</p>`;
  // The signed version is a snapshot. Saying so here is the point of showing the text at all:
  // the document below is the current wording, which may not be the wording that was agreed to.
  const drift=item.status==="signed"&&item.signedTemplateVersion&&item.templateVersion
    &&String(item.signedTemplateVersion)!==String(item.templateVersion)
    ? `<p class="agreement-detail-drift">This document has been edited since it was signed. The signature records version ${escape(String(item.signedTemplateVersion))}; the text below is version ${escape(String(item.templateVersion))}.</p>`
    : "";
  const fields=`<div class="wide agreement-detail">`
    +`<div class="agreement-detail-head">${status}${sent}</div>`
    +drift
    +`<div class="agreement-detail-body"><p>${escape(item.body||"This agreement has no text.")}</p></div>`
    +`<p class="agreement-detail-foot">Pawsh has no client signing page. A signature here is recorded by salon staff from a paper or in-person signature.</p>`
    +`</div>`;
  openModal(item.name,fields,null,{cancelLabel:"Close"});
  if(!editable)return;
  // The action belongs beside Close rather than in the body: having read the document, the
  // next thing the operator wants is to act on it without reopening the row.
  const actions=$("#modal .modal-actions");
  const act=document.createElement("button");
  act.type="button";
  act.className=item.status==="signed"?"secondary":"primary";
  act.dataset.testid="agreement-detail-action";
  act.textContent=item.status==="signed"?"Correct signature":"Sign Agreement";
  act.addEventListener("click",()=>{
    $("#modal").close();
    if(item.status==="signed")openAgreementCorrection(customerId,templateId);
    else openAgreementSignature(customerId,templateId);
  });
  actions.append(act);
  $("#modal").addEventListener("close",()=>act.remove(),{once:true});
}
function clientAgreementsMarkup(agreements){
  if(!agreements)return `<p class="note-empty">Loading agreements…</p>`;
  if(agreements.failed)return `<div class="note-failure"><p>Agreements could not be loaded.</p><button type="button" class="secondary compact agreements-retry">Retry</button></div>`;
  if(!agreements.items.length)return `<p class="note-empty">No agreement templates are set up for this salon yet.</p>`;
  return `<ul class="agreement-list">${agreements.items.map(item=>agreementRowMarkup(item,agreementsEditable(agreements))).join("")}</ul>`;
}
function clientAgreementsPanelMarkup(agreements){
  const summary=agreements&&!agreements.failed?agreements.summary:null;
  const count=summary?` (${escape(String(summary.signedTotal))} of ${escape(String(summary.total))} signed)`:"";
  const sendable=agreements&&!agreements.failed&&agreements.items.some(item=>item.active&&item.status!=="signed");
  const send=agreementsEditable(agreements)&&sendable?`<button type="button" class="secondary compact agreements-send">Send to client</button>`:"";
  return `<section class="agreements-panel"><div class="panel-head"><div><p class="eyebrow">Client agreements</p><h3>Agreements${count}</h3></div>${send}</div>`
    +clientAgreementsMarkup(agreements)
    +(agreements&&!agreements.failed&&agreements.items.length?`<p class="agreement-foot">Signatures here are recorded by salon staff from a paper or in-person signature. Pawsh has no client signing page.</p>`:"")
    +`</section>`;
}
function agreementBannerMarkup(agreements,customerId){
  if(!agreements||agreements.failed||!agreements.summary?.needsAttention||dismissedAgreementBanners.has(customerId))return "";
  const count=Number(agreements.summary.unsignedRequiredTotal)||0;
  const label=`Client has unsigned agreement${count===1?"":"(s)"}`;
  return `<div class="agreement-banner"><button type="button" class="agreement-banner-open"><span class="agreement-banner-icon" aria-hidden="true">!</span>${escape(label)}</button>`
    +`<button type="button" class="agreement-banner-dismiss" aria-label="Dismiss unsigned agreement notice">×</button></div>`;
}

// `openModal` always toasts `<title> saved`, which is wrong for "sent" and for "recorded". The
// after-close hook runs in the same tick, before a paint, so re-announcing there is what the
// operator actually reads.
function announceAgreement(message){return()=>toast(message);}
async function refreshClientAgreements(customerId,next=null){
  const profile=state.clientProfile;
  if(!profile||profile.data.customer.id!==customerId)return;
  profile.agreements=next||await loadClientAgreements(customerId);
  renderClientProfile();
}

function agreementDeliveryNoteMarkup(agreements){
  const email=agreementChannel(agreements,"email");
  if(!agreements.customerArchived&&email?.available)return `<p class="agreement-delivery-ok">Will be emailed to ${escape(email.destination||"the address on file")}.</p>`;
  const reason=agreements.customerArchived
    ? "This client is inactive. Agreements cannot be sent until the client is reactivated."
    : email?.detail||"This client cannot be emailed.";
  return `<p class="agreement-delivery-blocked" role="status">${escape(reason)}</p>`;
}
function agreementSendRowMarkup(item,preselected,deliverable){
  const id=`agreement-send-${item.templateId}`;
  const blocked=item.status==="signed"?"Already signed":item.active?"":"Template archived";
  return `<tr><td class="agreement-send-select"><input type="checkbox" id="${clientAttr(id)}" name="templateIds" value="${clientAttr(item.templateId)}"${blocked?" disabled":""}${!blocked&&deliverable&&preselected.has(item.templateId)?" checked":""}></td>`
    +`<td><label class="agreement-send-label" for="${clientAttr(id)}">${escape(item.name)}</label>`
    // A requirement that is already met is not an alarm, so the danger colour is reserved for the
    // rows that still owe the salon a signature.
    +(item.required?`<span class="agreement-required${blocked?" met":""}">Required</span>`:"")
    +(blocked?`<span class="agreement-send-blocked">${escape(blocked)}</span>`:"")
    +`</td></tr>`;
}
function openAgreementSend(customerId,{preselect=[]}={}){
  const agreements=state.clientProfile?.agreements;
  if(!agreements||agreements.failed||!agreements.items.length)return;
  const email=agreementChannel(agreements,"email"),sms=agreementChannel(agreements,"sms");
  const deliverable=Boolean(email?.available)&&!agreements.customerArchived;
  const preselected=new Set(preselect);
  const rows=agreements.items.map(item=>agreementSendRowMarkup(item,preselected,deliverable)).join("");
  const fields=`<div class="wide agreement-send">`
    +`<p class="agreement-send-intro">This emails the agreement text for the client to read. It does not collect a signature — Pawsh has no signing page, so a returned signature is still recorded here by staff.</p>`
    +`<div class="agreement-send-table-wrap" data-allow-horizontal-scroll><table class="agreement-send-table"><thead><tr><th scope="col">Select</th><th scope="col">Agreement Name</th></tr></thead><tbody>${rows}</tbody></table></div>`
    +`<fieldset class="agreement-channels"><legend>Send agreement</legend>`
    +`<label class="agreement-channel"><input type="radio" name="channel" value="sms" disabled><span>By SMS</span></label>`
    +`<p class="agreement-channel-reason">${escape(sms?.detail||"Pawsh has no SMS delivery.")}</p>`
    +`<label class="agreement-channel"><input type="radio" name="channel" value="email"${deliverable?" checked":" disabled"}><span>By Email</span></label>`
    +agreementDeliveryNoteMarkup(agreements)
    +`</fieldset></div>`;
  openModal("Send Agreements to client",fields,async form=>{
    const templateIds=form.getAll("templateIds").map(String);
    if(!templateIds.length)throw new Error("Choose at least one agreement to send");
    const result=await api(`/api/customers/${customerId}/agreements/send`,{method:"POST",body:JSON.stringify({templateIds,channel:"email"})});
    await refreshClientAgreements(customerId,{items:result.items||[],summary:result.summary||null,delivery:result.delivery||agreements.delivery,customerArchived:agreements.customerArchived,failed:false});
    const skipped=(result.results||[]).filter(entry=>entry.outcome!=="queued");
    const detail=skipped.length?` · ${skipped.map(entry=>AGREEMENT_SEND_OUTCOMES[entry.outcome]||entry.outcome).join(", ")}`:"";
    return announceAgreement(`${result.queued} agreement${result.queued===1?"":"s"} queued by email${detail}`);
  },{cancelLabel:"Cancel",submitLabel:"Send"});
  const submit=$('[data-testid="modal-submit"]');
  // Send stays unreachable while the server reports this client undeliverable, and while nothing is
  // ticked, so the button never promises a request the server has already said it would refuse.
  const syncSubmit=()=>{submit.disabled=!deliverable||!$$('#modal input[name="templateIds"]:checked').length;};
  $$('#modal input[name="templateIds"]').forEach(input=>input.addEventListener("change",syncSubmit));
  syncSubmit();
  // The submit button is shared by every dialog and `openModal` does not reset its disabled state,
  // so a Send left disabled would arrive disabled in the next dialog the operator opened.
  $("#modal").addEventListener("close",()=>{submit.disabled=false;},{once:true});
}

function openAgreementSignature(customerId,templateId){
  const profile=state.clientProfile;
  const item=profile?.agreements?.items.find(entry=>entry.templateId===templateId);
  if(!item)return;
  const customer=profile.data.customer;
  // `datetime-local` speaks wall clock, so the default and the ceiling are the operator's own now,
  // shifted out of UTC. The server rejects anything more than a minute ahead of real time.
  const now=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
  const fields=`<div class="wide agreement-signature">`
    +`<p class="agreement-signature-intro">You are recording a signature the client already gave on paper or in person. Pawsh does not collect electronic signatures, and the record is stored under your name as the staff member who entered it.</p>`
    +`<details class="agreement-signature-text"><summary>${escape(item.name)} — read the agreement text</summary><p>${escape(item.body||"This agreement has no text.")}</p></details>`
    +`<label class="wide">Name the client signed<input name="signedName" type="text" maxlength="120" required autocomplete="off" value="${clientAttr(`${clientName(customer)}`.trim())}"></label>`
    +`<label class="wide">Date signed<input name="signedAt" type="datetime-local" max="${clientAttr(now)}" value="${clientAttr(now)}"></label>`
    +`<label class="wide">Note (optional)<textarea name="note" maxlength="500" placeholder="Where or how the signature was collected"></textarea></label>`
    +`</div>`;
  openModal("Record a signed agreement",fields,async form=>{
    const signedName=String(form.get("signedName")||"").trim();
    if(!signedName)throw new Error("Enter the name the client signed");
    const signedAt=String(form.get("signedAt")||"").trim(),note=String(form.get("note")||"").trim();
    const payload={signedName};
    if(signedAt)payload.signedAt=new Date(signedAt).toISOString();
    if(note)payload.note=note;
    await api(`/api/customers/${customerId}/agreements/${templateId}/signature`,{method:"POST",body:JSON.stringify(payload)});
    await refreshClientAgreements(customerId);
    return announceAgreement(`${item.name} recorded as signed`);
  },{cancelLabel:"Cancel",submitLabel:"Record signature"});
  $('#modal input[name="signedName"]')?.focus();
}

// A staff-recorded signature can land against the wrong client or the wrong template, so the record
// can be cleared. It is a correction, not an edit, and the dialog says exactly that.
function openAgreementCorrection(customerId,templateId){
  const item=state.clientProfile?.agreements?.items.find(entry=>entry.templateId===templateId);
  if(!item)return;
  const fields=`<div class="wide agreement-correction">`
    +`<p>Remove the recorded signature for <strong>${escape(item.name)}</strong>?</p>`
    +`<p class="agreement-audit">Recorded ${escape(agreementStamp(item.signedAt))}${item.signedName?` as signed by ${escape(item.signedName)}`:""}${item.recordedByName?`, by ${escape(item.recordedByName)}`:""}.</p>`
    +`<p>The agreement goes back to unsigned. Use this only to correct a mistaken entry.</p></div>`;
  openModal("Remove recorded signature",fields,async()=>{
    await api(`/api/customers/${customerId}/agreements/${templateId}/signature`,{method:"DELETE"});
    await refreshClientAgreements(customerId);
    return announceAgreement(`Signature removed from ${item.name}`);
  },{cancelLabel:"Cancel",submitLabel:"Remove signature"});
}

// Scoped to the host the banner and panel were rendered into, for the same reason
// bindClientSummary() is: more than one copy of the client column can be in the DOM at once.
function bindClientAgreements(customerId,root=document){
  const agreements=state.clientProfile?.agreements;
  const one=selector=>root.querySelector(selector);
  const every=selector=>[...root.querySelectorAll(selector)];
  one(".agreements-retry")?.addEventListener("click",()=>runDetached(()=>refreshClientAgreements(customerId)));
  one(".agreements-send")?.addEventListener("click",()=>openAgreementSend(customerId));
  one(".agreement-banner-open")?.addEventListener("click",()=>openAgreementSend(customerId,{preselect:agreements?.summary?.unsignedRequiredTemplateIds||[]}));
  one(".agreement-banner-dismiss")?.addEventListener("click",()=>{dismissedAgreementBanners.add(customerId);renderClientProfile();});
  every(".agreement-name-open").forEach(button=>button.addEventListener("click",()=>openAgreementDetail(customerId,button.dataset.agreementTemplate)));
  every(".agreement-sign").forEach(button=>button.addEventListener("click",()=>openAgreementSignature(customerId,button.dataset.agreementTemplate)));
  every(".agreement-correct").forEach(button=>button.addEventListener("click",()=>openAgreementCorrection(customerId,button.dataset.agreementTemplate)));
}

/**
 * The figures the profile opens with.
 *
 * Total is what has been invoiced, split into what was paid and what is still owed, so the two
 * tiles reconcile rather than being separate numbers a reader has to trust. Unclosed is called
 * out because it is neither: work that was done and never billed. There is no retail tile —
 * Pawsh sells no retail, and a zero would read as a fact about the client instead of a fact
 * about the product.
 */
function clientSalesSummaryMarkup(data){
  const summary=data.summary;
  if(!summary){
    return `<div class="profile-summary" data-testid="client-summary">`
      +`<article class="summary-tile"><p class="summary-label">Appointments</p><p class="summary-figure">${escape(String(data.appointmentTotal??0))}</p>`
      +`<p class="summary-detail">Sales figures need the payments permission.</p></article></div>`;
  }
  const counts=summary.statusCounts||{};
  // Absent, not zeroed, for a viewer without `payments.view`: `summary` is null for them and the
  // fallback above already returned, so nothing credit-shaped is reachable from here.
  const credit=summary.credit;
  const line=(label,value,tone="")=>`<span class="${tone}">${escape(label)}: ${escape(String(value))}</span>`;
  return `<div class="profile-summary" data-testid="client-summary">`
    +`<article class="summary-tile"><p class="summary-label">Total</p>`
      +`<p class="summary-figure" data-testid="summary-total">${money(summary.invoicedMinor)}</p>`
      // `Paid` is what this client was charged and settled; it is NOT reduced by refunds, because
      // the invoice balance does not move when money goes back and quietly redefining it would
      // change every figure this tile has ever shown. What went back is its own line, and it only
      // appears once there is one - a permanent "Refunded: $0.00" would read as a fact about the
      // client rather than about the product.
      +`<p class="summary-detail">${line("Paid",money(summary.paidMinor))}${summary.refundedMinor?line("Refunded",money(summary.refundedMinor)):""}${line("Invoices",summary.invoiceCount)}</p></article>`
    +`<article class="summary-tile"><p class="summary-label">Outstanding</p>`
      +`<p class="summary-figure${summary.outstandingMinor?" owing":""}" data-testid="summary-outstanding">${money(summary.outstandingMinor)}</p>`
      +`<p class="summary-detail">${line("Unclosed appointments",summary.unclosedTotal,summary.unclosedTotal?"owing":"")}</p></article>`
    // Third, so the three money tiles group together and Appointments stays last - which is the
    // order the phone stack inherits. It renders at $0.00 like Outstanding does, because a tile is
    // a standing question about the client rather than a fact about one event.
    //
    // NEVER `.owing`. Credit is money the salon already owes this client, which is a normal state
    // of an account rather than a debt somebody is chasing, and red would read as a problem.
    //
    // "Added" is grants AND adjustments net, not grants alone, and "Used" is redemptions net of
    // reversals - which is what makes Added − Used = Balance true on screen. Naming it "Granted"
    // would be a claim about grants that the number does not support. The netting is explained
    // once, in the ledger drawer's totals strip, where somebody is actually reconciling.
    +(credit
      ? `<article class="summary-tile" data-testid="client-credit-tile"><p class="summary-label">Credit</p>`
        +`<p class="summary-figure${credit.balanceMinor>0?" credit":""}" data-testid="summary-credit">${money(credit.balanceMinor)}</p>`
        +`<p class="summary-detail">${line("Added",money(credit.grantedMinor))}${line("Used",money(credit.usedMinor))}</p>`
        +`<p class="summary-tile-action"><button type="button" class="text-button" aria-haspopup="dialog" data-testid="open-credit-ledger">`
        +`${credit.entryTotal>0?`Credit ledger (${escape(String(credit.entryTotal))})`:"Credit ledger"}</button></p></article>`
      : "")
    +`<article class="summary-tile"><p class="summary-label">Appointments</p>`
      +`<p class="summary-figure" data-testid="summary-appointments">${escape(String(summary.appointmentTotal))}</p>`
      +`<p class="summary-detail">${line("Completed",counts.completed)}${line("Scheduled",counts.scheduled)}`
      +`${line("Cancelled",counts.cancelled,counts.cancelled?"owing":"")}${line("No show",counts.noShow,counts.noShow?"owing":"")}</p></article>`
    +`</div>`;
}

/* ---------------------------------------------------------------------------
   Client credit: the ledger drawer and the grant/adjust dialog.

   AN APPEND-ONLY LEDGER, AND THE INTERFACE SAYS SO BY WHAT IT DOES NOT OFFER. The table refuses
   `update` and `delete` at a trigger, so there is no pencil, no bin and no overflow menu on a row
   anywhere below. The only correction affordance in the whole feature is "Correct this entry",
   which opens the grant/adjust dialog pre-set to write a NEW compensating adjustment.

   `balanceAfterMinor` IS THE SERVER'S NUMBER and is rendered, never accumulated here. The window
   function runs over the client's whole ledger before the page is taken, so page three's running
   balances are the same figures page one would have shown - which a browser adding up the rows it
   was sent could not reproduce.

   `canEdit` OFF `GET /api/customers/:id/credit` IS THE ONLY FLAG CONSULTED for the write
   affordances. `customers.credit_edit` does not override `payments.view` on the server, so
   `allowed("customers.credit_edit")` could offer a button whose write is refused.
   --------------------------------------------------------------------------- */
const CREDIT_LEDGER_PAGE_SIZE=50;
const creditLedger=tenantCache(()=>({customerId:null,customerName:"",summary:null,entries:[],kinds:null,canEdit:false,
  page:1,pendingPage:1,pageSize:CREDIT_LEDGER_PAGE_SIZE,total:0,paging:false,failed:false,restoreFocus:null}));

// The server's own copy of the database check constraint, named by `entryKinds` on the summary
// read. Not hard-coded here: a fifth kind must not be able to exist in the table and render as raw
// column text on screen.
function creditKindLabel(kind){
  const found=(creditLedger.kinds||[]).find(entry=>entry.value===kind);
  return found?found.label:String(kind||"").replaceAll("_"," ");
}
// The `+` and `−` glyphs are unreliably announced, so every signed amount carries the direction as
// words as well. `.visually-hidden` is the class the main stylesheet defines and the one this file
// uses throughout; `.sr-only` is defined too, in `pricing.css` (linked from `index.html`), so both
// hide correctly. Keeping to one of them here is consistency, not a workaround - and neither rule
// may be deleted on the belief that nothing uses it.
function creditAmountMarkup(minor){
  const add=Number(minor)>=0;
  return `<strong class="credit-amount ${add?"is-add":"is-take"}">${escape(signedMoney(minor))}`
    +`<span class="visually-hidden"> ${add?"added to the balance":"taken off the balance"}</span></strong>`;
}
function creditInvoicePhrase(entry){
  return entry.invoiceNumber?`invoice ${entry.invoiceNumber}`:"an invoice";
}
/**
 * One ledger line.
 *
 * A PAIR IS TWO ROWS, NEVER ONE. A reversal and its redemption, or a correction and the entry it
 * corrects, each keep their own row and their own amount - the money really did move both times -
 * and the relationship is carried by the left border plus a back-reference sentence, following the
 * receipt-refund block. Rows are rendered in the order the server sent them and are never
 * re-sorted, merged or collapsed.
 *
 * `pairId` is NOT what decides the border: it is the payment id on every redemption, reversed or
 * not, so a plain redemption would otherwise be drawn as half of a pair that does not exist. The
 * relationship fields are what say there is a partner.
 */
function creditEntryMarkup(entry,onPage){
  const paired=Boolean(entry.reversedAt||entry.reversesEntryId||entry.correctedAt||entry.correctsEntryId);
  const chips=(entry.reversedAt?`<span class="credit-chip" data-testid="credit-chip-reversed">Returned</span>`:"")
    +(entry.correctedAt?`<span class="credit-chip" data-testid="credit-chip-corrected">Corrected</span>`:"");
  const meta=[formatPrefDateAndTime(new Date(entry.createdAt)),entry.createdByName||null,
    `Balance after ${money(entry.balanceAfterMinor)}`];
  if(entry.reversedAt)meta.push(`Returned on ${formatPrefDateAndTime(new Date(entry.reversedAt))}`);
  if(entry.correctedAt)meta.push(`Corrected on ${formatPrefDateAndTime(new Date(entry.correctedAt))}`);
  // A grant and an adjustment always carry a reason - the schema requires one in both directions.
  // A redemption explains itself through the invoice it settled, and a reversal names what it gave
  // back rather than repeating the invoice line.
  const detail=entry.kind==="redemption_reversal"
    ? `<p class="credit-entry-reason">Returns the credit applied to ${escape(creditInvoicePhrase(entry))}.</p>`
    : entry.kind==="redemption"
      ? `<p class="credit-entry-reason">${escape(entry.invoiceNumber?`Invoice ${entry.invoiceNumber}`:"An invoice")}</p>`
      : entry.reason?`<p class="credit-entry-reason">${escape(entry.reason)}</p>`:"";
  // Named only when the corrected entry is on the page being rendered. A second request to resolve
  // one sentence is not worth it, and the shorter form is honest.
  const target=entry.correctsEntryId?onPage.get(entry.correctsEntryId):null;
  const correction=entry.correctsEntryId
    ? `<p class="credit-entry-reason">${target
        ? escape(`Corrects ${creditKindLabel(target.kind)} ${signedMoney(target.amountMinor)} of ${formatPrefDate(new Date(target.createdAt))}.`)
        : "Corrects an earlier entry on this ledger."}</p>`
    : "";
  // A redemption is corrected by voiding its payment - the migration says so in as many words - so
  // the row says where that lives rather than offering a second door to it from the profile.
  const action=!creditLedger.canEdit?""
    :entry.correctedAt?""
    :(entry.kind==="grant"||entry.kind==="adjustment")
      ? `<p class="credit-entry-action"><button type="button" class="text-button" aria-haspopup="dialog" data-testid="credit-correct-entry" data-credit-entry-id="${escapeAttr(entry.id)}">Correct this entry</button></p>`
      : entry.kind==="redemption"&&!entry.reversedAt
        ? `<p class="fine">${escape(entry.invoiceNumber
            ?`To undo this, void the payment on invoice ${entry.invoiceNumber}.`
            :"To undo this, void the payment it settled.")}</p>`
        : "";
  return `<li class="credit-entry${paired?" is-paired":""}" data-testid="credit-entry" data-credit-kind="${escapeAttr(entry.kind)}"`
    +(paired&&entry.pairId?` data-credit-pair="${escapeAttr(entry.pairId)}"`:"")+`>`
    +`<div class="credit-entry-line"><span class="credit-entry-kind">${escape(creditKindLabel(entry.kind))}${chips}</span>`
    +creditAmountMarkup(entry.amountMinor)+`</div>`
    +detail+correction
    +`<p class="credit-entry-meta">${escape(meta.filter(Boolean).join(" · "))}</p>`
    +action
    +`</li>`;
}
function creditLedgerBodyMarkup(){
  if(creditLedger.failed){
    return `<p class="note-empty">This client's credit ledger could not be read. `
      +`<button type="button" class="text-button" data-testid="credit-ledger-retry">Try again</button></p>`;
  }
  if(!creditLedger.summary)return `<p class="note-empty">Loading credit ledger…</p>`;
  const {balanceMinor,grantedMinor,usedMinor}=creditLedger.summary;
  const totals=`<dl class="credit-totals" data-testid="credit-totals">`
    +`<div><dt>Balance</dt><dd class="credit-total-figure" data-testid="credit-total-balance">${money(balanceMinor)}</dd></div>`
    +`<div><dt>Added</dt><dd data-testid="credit-total-added">${money(grantedMinor)}</dd></div>`
    +`<div><dt>Used</dt><dd data-testid="credit-total-used">${money(usedMinor)}</dd></div></dl>`
    // Where the netting is explained, once, in the place an operator is reconciling. Static copy:
    // it does not appear or disappear with the data.
    +`<p class="fine credit-totals-note">Added is grants and adjustments together. Used is credit applied to invoices, less anything returned from a voided payment. Added − Used = Balance.</p>`;
  if(!creditLedger.entries.length&&!creditLedger.total){
    return totals+`<p class="note-empty" data-testid="credit-ledger-empty">No credit has been added or spent for this client.</p>`;
  }
  const onPage=new Map(creditLedger.entries.map(entry=>[entry.id,entry]));
  const pages=Math.max(1,Math.ceil(creditLedger.total/creditLedger.pageSize));
  const page=Math.min(Math.max(1,creditLedger.page),pages);
  return totals
    +`<ul class="credit-entries">${creditLedger.entries.map(entry=>creditEntryMarkup(entry,onPage)).join("")}</ul>`
    // At the bottom of the body rather than in the foot, which is already carrying three things at
    // 560px.
    +(creditLedger.total>creditLedger.pageSize
      ? pagerNavMarkup({idPrefix:"credit-ledger",label:"Credit ledger pages",
          inner:pagerPageButtons(page,pages,"data-credit-page")})
      : "");
}
function creditLedgerCountText(){
  // The page being fetched, not the one still on screen: this line is the announcement for paging,
  // and naming the page the operator is leaving would be the one thing it must not say.
  if(creditLedger.paging)return `Loading page ${creditLedger.pendingPage||creditLedger.page}…`;
  if(!creditLedger.summary)return "";
  if(!creditLedger.total)return "No entries";
  const first=(creditLedger.page-1)*creditLedger.pageSize+1;
  const last=Math.min(first+creditLedger.entries.length-1,creditLedger.total);
  return `Showing ${first}–${last} of ${creditLedger.total} entries`;
}
function creditLedgerError(message){
  const target=$("#credit-ledger-error");if(target)target.textContent=message||"";
}
function renderCreditLedger(){
  const body=$("#credit-ledger-body");if(!body)return;
  body.innerHTML=creditLedgerBodyMarkup();
  const count=$("#credit-ledger-count");
  if(count)count.textContent=creditLedgerCountText();
  // Absent when this operator may not write, never disabled: a control that cannot be used is
  // furniture, and the server's 403 remains the rule either way.
  const slot=$("#credit-ledger-add-slot");
  if(slot){
    slot.innerHTML=creditLedger.canEdit&&creditLedger.summary&&!creditLedger.failed
      ? `<button type="button" class="primary compact" aria-haspopup="dialog" data-testid="credit-add">Add credit</button>`
      : "";
    slot.querySelector('[data-testid="credit-add"]')?.addEventListener("click",()=>openCreditEntryDialog());
  }
  body.querySelector('[data-testid="credit-ledger-retry"]')?.addEventListener("click",()=>
    runDetached(()=>loadCreditLedgerSummary()));
  body.querySelectorAll('[data-testid="credit-correct-entry"]').forEach(button=>
    button.addEventListener("click",()=>openCreditEntryDialog({
      correcting:creditLedger.entries.find(entry=>entry.id===button.dataset.creditEntryId)||null
    })));
  const pages=Math.max(1,Math.ceil(creditLedger.total/creditLedger.pageSize));
  const page=Math.min(Math.max(1,creditLedger.page),pages);
  const prev=body.querySelector("#credit-ledger-prev"),next=body.querySelector("#credit-ledger-next");
  if(prev){prev.disabled=creditLedger.paging||page<=1;prev.addEventListener("click",()=>runDetached(()=>loadCreditLedgerPage(page-1)));}
  if(next){next.disabled=creditLedger.paging||page>=pages;next.addEventListener("click",()=>runDetached(()=>loadCreditLedgerPage(page+1)));}
  body.querySelectorAll("[data-credit-page]").forEach(button=>{
    button.disabled=creditLedger.paging;
    button.addEventListener("click",()=>runDetached(()=>loadCreditLedgerPage(Number(button.dataset.creditPage))));
  });
}
/**
 * The summary read, which is also the only place the client asks the server whether this operator
 * may write. It carries the totals, the opening slice, the kind labels and `canEdit`.
 */
async function loadCreditLedgerSummary(){
  const customerId=creditLedger.customerId;if(!customerId)return;
  creditLedger.failed=false;creditLedgerError("");
  let summary;
  try{summary=await api(`/api/customers/${encodeURIComponent(customerId)}/credit`);}
  catch{
    if(creditLedger.customerId!==customerId)return;
    creditLedger.summary=null;creditLedger.entries=[];creditLedger.failed=true;creditLedger.paging=false;
    renderCreditLedger();return;
  }
  if(creditLedger.customerId!==customerId)return;
  creditLedger.summary={balanceMinor:Number(summary.balanceMinor||0),
    grantedMinor:Number(summary.grantedMinor||0),usedMinor:Number(summary.usedMinor||0)};
  creditLedger.kinds=Array.isArray(summary.entryKinds)?summary.entryKinds:null;
  creditLedger.canEdit=Boolean(summary.canEdit);
  creditLedger.entries=Array.isArray(summary.entries)?summary.entries:[];
  creditLedger.total=Number(summary.entryTotal||0);
  creditLedger.page=1;creditLedger.pendingPage=1;creditLedger.paging=false;
  renderCreditLedger();
  // The opening slice is the profile preview's ten rows, so page one is requested at the ledger's
  // own page size immediately and REPLACES them rather than appending to them.
  if(creditLedger.total>creditLedger.entries.length)await loadCreditLedgerPage(1);
}
async function loadCreditLedgerPage(page){
  const customerId=creditLedger.customerId;if(!customerId)return;
  creditLedger.pendingPage=page;creditLedger.paging=true;creditLedgerError("");renderCreditLedger();
  let result;
  try{
    result=await api(`/api/customers/${encodeURIComponent(customerId)}/credit/entries`
      +`?page=${encodeURIComponent(page)}&pageSize=${creditLedger.pageSize}`);
  }catch(error){
    if(creditLedger.customerId!==customerId)return;
    // The page that worked stays on screen and the pager re-enables where it is: a read that failed
    // is not a reason to empty a ledger somebody is reconciling against.
    creditLedger.pendingPage=creditLedger.page;creditLedger.paging=false;renderCreditLedger();creditLedgerError(error.message);return;
  }
  if(creditLedger.customerId!==customerId)return;
  creditLedger.entries=Array.isArray(result.items)?result.items:[];
  creditLedger.total=Number(result.total||0);
  creditLedger.page=Number(result.page||page);
  creditLedger.pendingPage=creditLedger.page;
  creditLedger.pageSize=Number(result.pageSize||creditLedger.pageSize);
  creditLedger.paging=false;
  renderCreditLedger();
}
async function openCreditLedger(customerId,customerName,trigger){
  const dialog=$("#credit-ledger");if(!dialog)return;
  Object.assign(creditLedger,{customerId,customerName:customerName||"",summary:null,entries:[],kinds:null,
    canEdit:false,page:1,pendingPage:1,pageSize:CREDIT_LEDGER_PAGE_SIZE,total:0,paging:false,failed:false,
    restoreFocus:trigger||null});
  // The client is the heading; the eyebrow stays literal so it can be.
  $("#credit-ledger-title").textContent=customerName||"Credit ledger";
  creditLedgerError("");
  renderCreditLedger();
  if(!dialog.open)dialog.showModal();
  dialog.querySelector('[data-testid="credit-ledger-close"]')?.focus();
  await loadCreditLedgerSummary();
}
function setupCreditLedgerDrawer(){
  const dialog=$("#credit-ledger");if(!dialog)return;
  const close=()=>dialog.close();
  dialog.querySelector('[data-testid="credit-ledger-close"]')?.addEventListener("click",close);
  dialog.querySelector('[data-testid="credit-ledger-dismiss"]')?.addEventListener("click",close);
  dialog.addEventListener("click",event=>{if(event.target===dialog)close();});
  dialog.addEventListener("close",()=>{
    // The profile may have been redrawn behind this drawer by a grant, which detaches the button
    // that opened it - so the restore falls back to whatever is standing in its place.
    const stored=creditLedger.restoreFocus;
    const target=stored?.isConnected?stored:$('[data-testid="open-credit-ledger"]');
    creditLedger.customerId=null;creditLedger.restoreFocus=null;
    target?.focus?.();
  });
}
/**
 * Granting credit, adjusting a balance, and correcting an entry - all three in the shared dialog.
 *
 * OPENED ONLY FROM INSIDE THE LEDGER DRAWER, never from the profile tile. The server refuses a
 * grant from anyone who cannot read the balance, on the stated ground that granting against a
 * number you could not check is worse than not granting at all; the interface makes the same
 * argument physically by putting the balance and the ledger on screen behind the dialog.
 */
function openCreditEntryDialog({correcting=null}={}){
  if(!creditLedger.customerId||!creditLedger.canEdit)return;
  const customerId=creditLedger.customerId,name=creditLedger.customerName||"this client";
  const title=correcting?"Correct an entry":"Add credit";
  const kindControl=correcting
    ? `<p class="wide credit-correcting" data-testid="credit-correcting">Adjustment correcting `
      +`<strong>${escape(`${creditKindLabel(correcting.kind)} ${signedMoney(correcting.amountMinor)}`)}</strong>`
      +` of ${escape(formatPrefDate(new Date(correcting.createdAt)))}.</p>`
    : `<fieldset class="wide compact-options credit-kind" data-testid="credit-kind"><legend>What is happening</legend>`
      +`<label><input type="radio" name="kind" value="grant" checked data-testid="credit-kind-grant">`
      +`<span>Add credit<small>Give this client money to spend at the till.</small></span></label>`
      +`<label><input type="radio" name="kind" value="adjustment" data-testid="credit-kind-adjustment">`
      +`<span>Adjust balance<small>Correct what is on the account, in either direction.</small></span></label></fieldset>`;
  // A SIGNED NUMBER INPUT IS REFUSED DELIBERATELY: typing 20 where -20 was meant hands a client
  // money, and the only fix for that is another entry. The direction is a separate, unmissable
  // choice and the amount is always positive. A grant has one direction and the schema enforces it,
  // so the control is absent there rather than pre-set.
  const fields=kindControl
    +`<div class="wide credit-direction" role="group" aria-label="Direction" data-testid="credit-direction"${correcting?"":" hidden"}>`
      +`<button type="button" data-credit-direction="add" aria-pressed="true">Add to balance</button>`
      +`<button type="button" data-credit-direction="take" aria-pressed="false">Take off balance</button></div>`
    +`<label class="wide">Amount ($)`
      +`<input data-testid="field-amountMinor" name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" required></label>`
    +`<p class="wide fine credit-preview" data-testid="credit-preview" role="status"></p>`
    +`<label class="wide">Reason<textarea data-testid="field-reason" name="reason" maxlength="500" required></textarea></label>`
    +`<p class="wide fine credit-reason-help" data-testid="credit-reason-help"><span data-credit-reason-sentence></span>`
      +` <span class="credit-reason-count" data-testid="credit-reason-count">0/500</span></p>`;

  const host=()=>$("#modal-fields");
  const readKind=()=>correcting?"adjustment"
    :String(host()?.querySelector('input[name="kind"]:checked')?.value||"grant");
  const readDirection=()=>String(host()?.querySelector('[data-credit-direction][aria-pressed="true"]')?.dataset.creditDirection||"add");
  const readCents=()=>{
    const value=Math.round(Number(host()?.querySelector('[data-testid="field-amountMinor"]')?.value||0)*100);
    return Number.isFinite(value)?value:0;
  };
  const readAmountMinor=()=>{
    const cents=readCents();
    return readKind()==="adjustment"&&readDirection()==="take"?-cents:cents;
  };
  const balanceMinor=()=>Number(creditLedger.summary?.balanceMinor??0);
  const overdraws=()=>balanceMinor()+readAmountMinor()<0;
  const overdrawSentence=()=>`Balance after this: ${signedMoney(balanceMinor()+readAmountMinor())} — more than this client has.`;

  const submit=async()=>{
    const kind=readKind(),amountMinor=readAmountMinor();
    const reason=String(host()?.querySelector('[data-testid="field-reason"]')?.value||"").trim();
    if(!readCents())throw new Error("Enter an amount.");
    // The server refuses a blank reason too; this only saves the round trip and the keystrokes.
    if(!reason)throw new Error("Enter a reason.");
    if(overdraws())throw new Error(overdrawSentence());
    // Only for a deduction. Giving money is the recoverable direction, and a confirm on every grant
    // would train the operator to dismiss the one that matters.
    if(amountMinor<0&&!confirm(`Take ${money(Math.abs(amountMinor))} off ${name}'s credit balance? `
      +`This cannot be edited or undone — a mistake is fixed by adding a matching entry. `
      +`The balance will be ${money(balanceMinor()+amountMinor)}.`)){
      // Refusing the confirmation must leave the dialog exactly as it was, and throwing is the only
      // way back out of openModal's submit without closing it. The message is empty, so #modal-error
      // stays blank rather than reporting a refusal the operator just made on purpose.
      throw new Error("");
    }
    try{
      await financialMutation(`/api/customers/${encodeURIComponent(customerId)}/credit`,"credit.adjust",{
        kind,amountMinor,reason,...(correcting?{correctsEntryId:correcting.id}:{})
      });
    }catch(error){
      if(error.status===409&&error.data?.code==="CREDIT_BALANCE_INSUFFICIENT"
        &&typeof error.data.balanceMinor==="number"){
        error.message=`${error.message} The balance is ${money(error.data.balanceMinor)}.`;
        creditApplyKnownBalance(error.data.balanceMinor);
      }
      // The entry being corrected is not on this client, so what is behind the dialog is wrong.
      if(error.status===404&&error.data?.code==="CREDIT_ENTRY_NOT_FOUND")runDetached(()=>loadCreditLedgerSummary());
      throw error;
    }
    // The default toast would say "Add credit saved", which is not what happened when the operator
    // took money off. `afterClose` re-reads BOTH: the tile's three figures move, and every running
    // balance below the new row on the ledger has changed too.
    return {afterClose:reloadCreditAndProfile,
      message:amountMinor>0?`${money(amountMinor)} added to ${name}'s credit`
                           :`${money(Math.abs(amountMinor))} taken off ${name}'s credit`};
  };

  openModal(title,fields,submit,{submitLabel:correcting?"Save correction":"Add credit"});
  bindCreditEntryDialog({correcting,readKind,readDirection,readAmountMinor,balanceMinor,
    overdraws,overdrawSentence});
}
function bindCreditEntryDialog({correcting,readKind,readDirection,readAmountMinor,
  balanceMinor,overdraws,overdrawSentence}){
  const host=$("#modal-fields");if(!host)return;
  const amount=host.querySelector('[data-testid="field-amountMinor"]');
  const reason=host.querySelector('[data-testid="field-reason"]');
  const preview=host.querySelector('[data-testid="credit-preview"]');
  const counter=host.querySelector('[data-testid="credit-reason-count"]');
  const sentence=host.querySelector("[data-credit-reason-sentence]");
  const direction=host.querySelector('[data-testid="credit-direction"]');
  const sync=()=>{
    const kind=readKind(),take=kind==="adjustment"&&readDirection()==="take";
    if(direction)direction.hidden=kind!=="adjustment";
    const after=balanceMinor()+readAmountMinor();
    const over=overdraws();
    if(preview){
      preview.textContent=over?overdrawSentence():`Balance after this: ${money(after)}`;
      preview.classList.toggle("is-over",over);
    }
    if(amount)amount.setAttribute("aria-invalid",over?"true":"false");
    // The helper hardens with the direction: a deduction takes money off a client's account and is
    // the more contestable half, so it asks for more than a note to self.
    if(sentence)sentence.textContent=take
      ?"Required. A deduction takes money off this client's account, so say why."
      :"Required. This is the record a dispute lands on.";
    if(counter){
      const length=String(reason?.value||"").length;
      counter.textContent=`${length}/500`;
      counter.classList.toggle("is-full",length>=500);
    }
    const button=$('[data-testid="modal-submit"]');
    if(button)button.textContent=correcting?"Save correction"
      :kind==="grant"?"Add credit":take?"Take off balance":"Add to balance";
  };
  host.querySelectorAll('input[name="kind"]').forEach(input=>input.addEventListener("change",sync));
  host.querySelectorAll("[data-credit-direction]").forEach(button=>button.addEventListener("click",()=>{
    host.querySelectorAll("[data-credit-direction]").forEach(other=>
      other.setAttribute("aria-pressed",String(other===button)));
    sync();
  }));
  amount?.addEventListener("input",sync);
  reason?.addEventListener("input",sync);
  sync();
}
/**
 * What the screen is corrected to when a 409 proves it stale.
 *
 * The balance moves at once because it is the number the server just contradicted. Added and Used
 * are not in the refusal, so they - and therefore the identity the tile and the totals strip both
 * assert - are brought back into agreement by a re-read rather than by arithmetic here.
 */
function creditApplyKnownBalance(balanceMinor){
  if(creditLedger.summary)creditLedger.summary.balanceMinor=Number(balanceMinor);
  const profile=state.clientProfile;
  const credit=profile?.data?.summary?.credit;
  if(credit&&profile.data.customer.id===creditLedger.customerId){
    credit.balanceMinor=Number(balanceMinor);
    renderClientProfile();
  }
  renderCreditLedger();
  runDetached(()=>loadCreditLedgerSummary());
}
async function reloadCreditAndProfile(){
  const customerId=creditLedger.customerId;
  await loadCreditLedgerSummary();
  if(state.clientProfile?.data?.customer?.id===customerId)await reloadClientProfile();
}

function clientPetsPanelMarkup(profile){
  const {data}=profile,customer=data.customer;
  return (allowed("pets.edit")&&!customer.archivedAt?`<div class="panel-actions"><button type="button" class="secondary compact profile-add-pet">+ Pet</button></div>`:"")
    +`${data.pets.map(petCardMarkup).join("")||`<p class="note-empty">No pets yet.</p>`}`;
}

/**
 * One appointment as a row in the Messages rail, reviving the narrow-column `.profile-appointment-row`
 * grid the profile stopped using when its history became a table.
 *
 * Price and the payment chip are deliberately absent. The chip comes from appointmentPaymentIndex(),
 * which only knows appointments the loaded calendar window covers, and in Messages `state.appointments`
 * is usually empty — a chip that never appears reads as "unpaid, unknown" rather than "not asked".
 */
function clientContextAppointmentRow(item,{upcoming}){
  const zone=item.schedulingTimezone||schedulingZone(),start=new Date(item.startAt);
  const services=(item.services||[]).map(service=>service.name).filter(Boolean);
  const groomers=(item.groomers||[]).map(groomer=>groomer.displayName).filter(Boolean);
  // The weekday/month/day half stays on the browser's locale, as every other short date in this
  // client does; the clock half is a time, so it reads in the workspace's 12/24-hour setting.
  const when=`${new Intl.DateTimeFormat([],{weekday:"short",month:"short",day:"numeric",timeZone:zone}).format(start)} · ${formatPrefTime(start,zone)}`;
  const meta=[item.petName,groomers.join(", ")||item.employeeName].filter(Boolean).join(" · ");
  // Every upcoming appointment is scheduled, so a "scheduled" chip on every upcoming row is
  // decoration. An upcoming row that has already moved on is the fact worth showing, and history
  // always carries its outcome.
  const chip=upcoming&&item.status==="scheduled"?"":`<span class="history-chip chip-${clientAttr(item.status)}">${escape(item.status.replace("_"," "))}</span>`;
  return `<button type="button" class="profile-appointment-row" data-testid="client-appointment-row" data-profile-appointment="${clientAttr(item.id)}" aria-haspopup="dialog" aria-label="Open appointment #${escape(String(item.id).slice(0,8))}">`
    +`<span class="history-when">${escape(when)}</span>`
    +(meta?`<span class="history-meta">${escape(meta)}</span>`:"")
    +(services.length?`<span class="history-services">${escape(services.join(", "))}</span>`:"")
    +`<span class="appt-state">${chip}</span></button>`;
}

function clientContextAppointmentSection({id,title,items,total,upcoming,emptyText}){
  const shown=items.length;
  return `<div class="profile-section-head"><h3>${escape(title)} (${escape(String(total))})</h3></div>`
    +(shown
      ? `<div class="profile-appointment-list" data-testid="client-${id}-list">${items.map(item=>clientContextAppointmentRow(item,{upcoming})).join("")}</div>`
      : `<p class="note-empty" data-testid="client-${id}-empty">${escape(emptyText)}</p>`)
    // Truncation is computed per half from this payload's own totals. `appointmentsTruncated` is a
    // single boolean OR-ing both halves, so it cannot say which one is short — and with a 25-row
    // upcoming cap against a 5-row history preview it is nearly always the history. The rail does
    // not page: that would be a second copy of the profile's paging on a surface whose job is
    // context, so the honest count hands off to the profile that can page.
    +(total>shown
      ? `<div class="history-more" data-testid="client-${id}-more"><span>Showing ${escape(String(shown))} of ${escape(String(total))} ${escape(upcoming?"upcoming":"past")}</span>`
        +`<button type="button" class="secondary compact open-context-profile">Open full profile</button></div>`
      : "");
}

/**
 * Upcoming and history stacked, with no sub-toggle. Both halves are already in the payload,
 * upcoming is typically 0–2 and the history preview caps at 5, so this is about seven rows in a
 * scrolling rail. A toggle would hide loaded data behind a click and put a third level of chrome
 * inside a 298px column; stacking also shows both empty states at once, which is the more useful
 * fact. Counts come from the payload `total`, never from `items.length`.
 */
function clientAppointmentsPanelMarkup(profile){
  const {data}=profile;
  const upcoming=data.upcoming?.items||[],history=data.history?.items||[];
  return clientContextAppointmentSection({id:"upcoming",title:"Upcoming",items:upcoming,
      total:Number(data.upcoming?.total??upcoming.length),upcoming:true,
      emptyText:"No upcoming appointments for this client."})
    +clientContextAppointmentSection({id:"past",title:"History",items:history,
      total:Number(data.history?.total??history.length),upcoming:false,
      emptyText:"No past appointments recorded for this client."});
}

/**
 * Card on file. Pawsh stores no card token, no saved card and no Square customer link, so the tab
 * answers the operator's mid-thread question — "can I charge this client's card on file?" — rather
 * than only declining it. Nothing here may imply a card could be stored: no "Add card" button,
 * disabled or otherwise, and no empty card slot. It states a product fact rather than a financial
 * fact about this client, so it is not permission-gated.
 */
function clientCardsPanelMarkup(){
  return `<div class="context-placeholder" data-testid="client-cards-placeholder">`
    +`<p class="eyebrow">Not available yet</p><h4>Card on file</h4>`
    +`<p>Pawsh does not store card details for a client. There is no saved card, no card token and nowhere to add one, so nothing here can be charged.</p>`
    +`<p>Payments are taken at checkout on a Square Terminal with the card present. Square holds the card data; Pawsh records only the completed payment.</p></div>`;
}

// One registry, two callers, no fork: the profile and the Messages rail select from the same tab
// definitions rather than each carrying its own strip.
const CLIENT_TABS={
  pets:["Pets",profile=>clientPetsPanelMarkup(profile)],
  preference:["Preference",profile=>clientPreferenceMarkup(profile.data.customer)],
  appointments:["Appointments",profile=>clientAppointmentsPanelMarkup(profile)],
  cards:["Cards",()=>clientCardsPanelMarkup()]
};
const PROFILE_CLIENT_TABS=["pets","preference"];
const CONTEXT_CLIENT_TABS=["pets","appointments","cards"];

/**
 * The client summary column: identity, contact, notes and a tab strip drawn from `tabs`. It is the
 * left column of the client profile and the right column of Messages, because an operator
 * reading a conversation needs the same card as one reading the profile — one markup, one set
 * of bindings, no second version of the client to keep in step. The two surfaces show different
 * tabs: Preferences belong to the full profile, Appointments and Cards to the rail beside a thread.
 */
function clientSummaryMarkup(profile,{back=true,tabs=PROFILE_CLIENT_TABS}={}){
  const {data}=profile,customer=data.customer;
  // Resolved for this render only and never written back to `profile.tab`. One field spans both
  // surfaces, so persisting the fallback would strip the rail of its tab the instant the profile —
  // which has no Appointments or Cards — drew the same record.
  const tab=tabs.includes(profile.tab)?profile.tab:tabs[0];
  return `<section class="client-profile-left">`
    +(back?`<button type="button" class="text-button client-profile-back">← Back</button>`:"")
    +(customer.archivedAt?`<p class="profile-banner">This client is marked inactive. History is kept and new bookings are blocked.</p>`:"")
    +agreementBannerMarkup(profile.agreements,customer.id)
    +`<div class="client-identity"><span class="client-avatar" aria-hidden="true">${escape(Array.from(clientName(customer,"?"))[0]?.toUpperCase()||"?")}</span><div><p class="eyebrow">Basic Info</p><h2>${escape(clientName(customer))}</h2></div>${allowed("customers.edit")?`<button type="button" class="secondary compact client-edit">Edit</button>`:""}</div>`
    +`<dl class="profile-facts"><div><dt>Phone</dt><dd>${escape(customer.phone||"Not provided")}</dd></div><div><dt>Email</dt><dd>${escape(customer.email||"Not provided")}</dd></div><div><dt>Preferred groomer</dt><dd><button type="button" class="text-button preferred-groomer"${allowed("customers.edit")?"":" disabled"}>${escape(customer.preferredEmployeeName||"Not set")}</button></dd></div><div><dt>Client since</dt><dd>${escape(formatPrefDate(new Date(customer.createdAt)))}</dd></div></dl>`
    +`<div class="profile-section-head"><h3>Notes</h3>${allowed("customers.edit")&&!customer.archivedAt?`<button type="button" class="text-button note-add">Add</button>`:""}</div>`
    +`<div class="client-notes">${clientNotesMarkup(profile)}</div>`
    +`<div class="profile-tabs" role="tablist" aria-label="Client detail" data-testid="client-tabs">`
    +tabs.map(id=>`<button type="button" role="tab" id="client-tab-${id}" data-testid="client-tab-${id}" aria-controls="client-panel-${id}" aria-selected="${tab===id}" tabindex="${tab===id?0:-1}" data-client-tab="${id}">${escape(CLIENT_TABS[id][0])}</button>`).join("")
    +`</div>`
    // Every panel in `tabs` is emitted with the inactive ones hidden, so each tab's `aria-controls`
    // resolves to an element that is genuinely in the document.
    +tabs.map(id=>`<div class="profile-panel" role="tabpanel" id="client-panel-${id}" data-testid="client-panel-${id}" aria-labelledby="client-tab-${id}" tabindex="0"${tab===id?"":" hidden"}>${CLIENT_TABS[id][1](profile)}</div>`).join("")
    +`</section>`;
}

// Bindings for the summary column, wherever it is rendered. Every handler re-renders through
// renderClientProfile(), which redraws whichever surface is currently showing the column.
//
// SCOPED TO THE HOST IT WAS JUST RENDERED INTO, not to the document. There are now three
// possible hosts and more than one of them can hold markup at the same time — the profile keeps
// its last render while Messages is on screen, and the appointment surface adds a third copy
// above both — so a document-wide `$(".note-add")` binds whichever host happens to sit earliest
// in the DOM rather than the one the operator is looking at.
function bindClientSummary(profile,root=document){
  const customer=profile.data.customer;
  const one=selector=>root.querySelector(selector);
  const every=selector=>[...root.querySelectorAll(selector)];
  bindNoteMenus();
  bindClientAgreements(customer.id,root);

  one(".client-profile-back")?.addEventListener("click",()=>showView(state.clientProfileReturnView||"customers"));
  one(".client-edit")?.addEventListener("click",()=>editCustomer(customer.id));
  one(".preferred-groomer")?.addEventListener("click",openPreferredGroomer);
  one(".note-add")?.addEventListener("click",addClientNote);
  one(".notes-retry")?.addEventListener("click",()=>runDetached(reloadClientProfile));
  one(".note-toggle")?.addEventListener("click",()=>{profile.notesExpanded=!profile.notesExpanded;renderClientProfile();});
  every(".note-edit").forEach(button=>button.addEventListener("click",()=>{closeNoteMenus();editClientNote(button.dataset.noteId);}));
  every(".note-pin").forEach(button=>button.addEventListener("click",()=>{closeNoteMenus();runDetached(()=>toggleClientNotePin(button.dataset.noteId));}));
  every(".note-delete").forEach(button=>button.addEventListener("click",()=>{closeNoteMenus();runDetached(()=>deleteClientNote(button.dataset.noteId));}));
  every(".note-menu").forEach(menu=>menu.addEventListener("toggle",()=>{
    menu.querySelector("summary")?.setAttribute("aria-expanded",String(menu.open));
    if(menu.open)every(".note-menu[open]").forEach(other=>{if(other!==menu){other.open=false;other.querySelector("summary")?.setAttribute("aria-expanded","false");}});
  }));

  // The appointment id opens the same detail surface the calendar opens, so one visit reads the
  // same way from either side. Bound here rather than in renderClientProfile(), which returns
  // early in Messages: the profile's history table and the rail's rows are never both in the DOM,
  // so one binding covers both. The return view falls back to the current view because
  // `state.clientProfileReturnView` is never set when the rail is the entry point.
  //
  // Clicked from the rail INSIDE an open detail surface, this replaces that surface rather than
  // stacking a second appointment on top of itself; openCalendarAppointment() decides that from
  // what is already open, so the rail does not have to know which host it is in.
  every('[data-profile-appointment]').forEach(button=>button.addEventListener("click",event=>
    runDetached(()=>openCalendarAppointment(button.dataset.profileAppointment,event.currentTarget,
      {returnView:state.clientProfileReturnView||document.body.dataset.view||"customers"}))));

  const tabs=every("[data-client-tab]");
  const selectTab=(next,{focus=false}={})=>{profile.tab=next;renderClientProfile();if(focus)root.querySelector(`[data-client-tab="${next}"]`)?.focus();};
  tabs.forEach(button=>{
    // Selecting re-renders the column and destroys the clicked button, so focus must be restored
    // explicitly or it falls to <body>.
    button.addEventListener("click",()=>selectTab(button.dataset.clientTab,{focus:true}));
    button.addEventListener("keydown",event=>{
      if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
      event.preventDefault();
      const index=tabs.indexOf(button);
      const next=event.key==="Home"?0:event.key==="End"?tabs.length-1:(index+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
      selectTab(tabs[next].dataset.clientTab,{focus:true});
    });
  });

  one(".profile-add-pet")?.addEventListener("click",()=>{
    actions["new-pet"]();
    const select=$('#modal select[name="customerId"]');
    if(select)select.value=customer.id;
    $("#modal").addEventListener("close",()=>runDetached(reloadClientProfile),{once:true});
  });
  one(".pref-archive")?.addEventListener("click",()=>runDetached(archiveClientFromProfile));
  every("[data-pref-switch]").forEach(input=>input.addEventListener("change",()=>{
    const key=input.dataset.prefSwitch;
    const definition=CLIENT_PREFERENCE_SWITCHES.find(([id])=>id===key);
    if(!definition)return;
    const [,label,inverted]=definition;
    runDetached(()=>saveClientPreference({[key]:inverted?!input.checked:input.checked},label));
  }));
  const frequency=one("#pref-booking-frequency");
  frequency?.addEventListener("change",()=>{
    const raw=frequency.value.trim();
    if(!raw)return runDetached(()=>saveClientPreference({bookingFrequencyWeeks:null},"Booking frequency"));
    const weeks=Number(raw);
    if(!Number.isInteger(weeks)||weeks<1||weeks>104){toast("Booking frequency must be a whole number of weeks between 1 and 104");renderClientProfile();return;}
    runDetached(()=>saveClientPreference({bookingFrequencyWeeks:weeks},"Booking frequency"));
  });
}

/**
 * Where the client summary column currently lives, when it is living somewhere other than the
 * full profile.
 *
 * A REGISTRY RATHER THAN A THIRD BRANCH. renderClientProfile() used to test
 * `body.dataset.view==="messages"` and otherwise write to `#client-profile-content`; the
 * appointment surface is a third host, and a third branch is how a fourth gets written. Whoever
 * opens a surface that owns the column registers it, and every handler in bindClientSummary()
 * redraws through the one lookup. Messages needs no registration: it is the implicit host
 * whenever it is the visible view.
 *
 * `returnView` travels with the host because "where the column is" and "where leaving it goes
 * back to" are two halves of the same fact.
 */
let clientSummaryRail=null;
function clientSummaryHost(){
  const explicit=clientSummaryRail?.host();
  if(explicit?.isConnected)return explicit;
  if(document.body.dataset.view==="messages")return $("#message-client-context");
  return null;
}
function clientSummaryReturnView(){
  if(clientSummaryRail?.host()?.isConnected)return clientSummaryRail.returnView;
  return "messages";
}

/**
 * The column on its own, in whichever host holds it. Selecting a conversation loads the client
 * the same way the profile does, because the pane beside the thread — and the rail beside an
 * appointment — is the profile's own summary column rather than a second, thinner copy of the
 * client. `state.clientProfile` is the one record all three surfaces read.
 */
function renderClientSummaryPane(){
  const profile=state.clientProfile,host=clientSummaryHost();
  if(!profile||!host)return;
  host.innerHTML=clientSummaryMarkup(profile,{back:false,tabs:CONTEXT_CLIENT_TABS})
    +`<div class="context-actions"><button type="button" class="secondary compact open-context-profile">Open full profile</button></div>`;
  bindClientSummary(profile,host);
  // The Appointments panel's truncation strips carry this button too, so every one is bound.
  // Opening the profile is navigation AWAY, so any appointment surface standing above it is
  // dismissed first rather than being left holding a client the operator has moved on from.
  host.querySelectorAll(".open-context-profile").forEach(button=>button.addEventListener("click",()=>{
    const returnView=clientSummaryReturnView();
    runDetached(async()=>{
      if(await closeAppointmentStack()===false)return;
      return openClientProfile(profile.data.customer.id,{returnView});
    });
  }));
}

function renderClientProfile(){
  // The summary column is shared with Messages and with the appointment surface, so a note, tab
  // or pet change made in either must redraw that host rather than the profile view standing
  // hidden behind it.
  if(clientSummaryHost())return renderClientSummaryPane();
  const profile=state.clientProfile;if(!profile)return;
  const {data}=profile,customer=data.customer;
  const pet=data.pets.find(item=>item.id===profile.petId)||data.pets[0];
  // The table carries a Pets column and the counts are client-scoped, so neither list is
  // narrowed to the selected pet: the headings, the tables and the paging all agree.
  const upcoming=data.upcoming?.items||[];
  const history=data.history?.items||[];
  const payments=appointmentPaymentIndex();
  const name=`${clientName(customer)}`;
  const view=historyView(),historyTotal=Number(data.history?.total||0);
  // The profile arrives with a few rows beyond the opening window so growing it costs no round
  // trip. Only the first page can hold that surplus; every other page came from a targeted
  // request and is already exactly the window.
  const historyRows=view.page===1?history.slice(0,view.pageSize):history;
  const shown=view.pageSize*(view.page-1)+historyRows.length;

  const left=clientSummaryMarkup(profile);

  const appointmentTable=(rows,caption)=>`<div class="history-table-wrap" data-allow-horizontal-scroll><table class="history-table"><caption class="visually-hidden">${escape(caption)}</caption><thead><tr><th scope="col">ID</th><th scope="col">Status</th><th scope="col">Date</th><th scope="col">Pets</th><th scope="col">Items</th><th scope="col">Total Sales</th><th scope="col">Duration</th><th scope="col">Groomer</th></tr></thead><tbody>${rows.map(item=>historyRowMarkup(item,{pets:data.pets,payments,selectedId:profile.appointmentId})).join("")}</tbody></table></div>`;

  const right=`<section class="client-profile-right">`
    +clientSalesSummaryMarkup(data)
    +`<div class="panel-head"><div><p class="eyebrow">Appointments</p><h3>Upcoming (${escape(String(data.upcoming?.total??upcoming.length))})</h3></div><button type="button" class="primary compact profile-book-new">Book New</button></div>`
    +(upcoming.length
      ? appointmentTable(upcoming,`Upcoming appointments for ${name}`)
      : `<p class="note-empty">No upcoming appointments for this client.</p>`)
    +`<div class="panel-head history-head"><h3>History (${escape(String(historyTotal))})</h3>${
      historyTotal>view.pageSize
        ? `<div class="history-pager"><button type="button" class="history-step" data-history-step="-1" aria-label="Newer appointments"${view.page<=1?" disabled":""}>‹</button>`
          +`<span data-testid="history-page">Page ${escape(String(view.page))} of ${escape(String(historyPageCount()))}</span>`
          +`<button type="button" class="history-step" data-history-step="1" aria-label="Older appointments"${view.page>=historyPageCount()?" disabled":""}>›</button></div>`
        : ""
    }</div>`
    +(historyRows.length
      ? appointmentTable(historyRows,`Appointment history for ${name}`)
      : `<p class="note-empty">No past appointments recorded for this client.</p>`)
    +(historyTotal>view.pageSize
      ? `<div class="history-more"><span data-testid="history-shown">Showing ${escape(String(Math.min(shown,historyTotal)))} of ${escape(String(historyTotal))}</span>`
        +(view.pageSize<historyTotal
          ? `<button type="button" class="secondary compact history-view-all"${profile.historyLoading?" disabled":""}>Load ${escape(String(Math.min(HISTORY_ROW_STEP,historyTotal-view.pageSize)))} more</button>`
          : "")
        +`</div>`
      : "")
    +(allowed("payments.view")&&data.invoices.length?`<section class="profile-invoices"><h4>Invoices</h4>${data.invoices.slice(0,20).map(invoice=>`<div><span>${escape(invoice.invoiceNumber)} · ${escape(formatPrefDate(new Date(invoice.createdAt)))}</span><strong>${money(invoice.totalMinor)} · ${escape(invoiceStatusLabel(invoice.status))}</strong></div>`).join("")}</section>`:"")
    +clientAgreementsPanelMarkup(profile.agreements)
    +`</section>`;

  const content=$("#client-profile-content");
  content.innerHTML=left+right;
  content.querySelector(".profile-book-new").addEventListener("click",()=>{state.calendar.bookingCustomerId=customer.id;state.calendar.bookingPetId=pet?.id||null;actions["new-appointment"]();});
  // The tile offers no write of its own: whether this operator may add credit is a question only
  // the drawer's own read answers, so the button opens the ledger and nothing else.
  content.querySelector('[data-testid="open-credit-ledger"]')?.addEventListener("click",event=>
    runDetached(()=>openCreditLedger(customer.id,clientName(customer),event.currentTarget)));
  content.querySelector(".history-view-all")?.addEventListener("click",()=>runDetached(loadMoreClientHistory));
  content.querySelectorAll(".history-step").forEach(button=>button.addEventListener("click",()=>
    runDetached(()=>stepClientHistory(Number(button.dataset.historyStep)))));
  // `[data-profile-appointment]` rows are bound in bindClientSummary(), which every host reaches.
  bindClientSummary(profile,content);
}
// ---------------------------------------------------------------------------
// Appointment photos
//
// Before-and-after shots of the pet, grouped by phase. The tiles render straight from
// `/api/appointment-photos/:id/content`, which is same-origin and cookie-authenticated, so
// nothing here needs a signed URL or a second credential path.
// ---------------------------------------------------------------------------
const PHOTO_ACCEPT="image/jpeg,image/png,image/webp";

function photoTileMarkup(photo,canEdit){
  // The intrinsic size is published so the strip reserves the right box before the bytes
  // arrive; without it a set of photos reflows the dialog as each one loads.
  const ratio=photo.width&&photo.height?`${photo.width} / ${photo.height}`:"4 / 3";
  return `<figure class="photo-tile" style="aspect-ratio:${ratio}" data-photo-id="${escape(photo.id)}">`
    +`<img src="/api/appointment-photos/${encodeURIComponent(photo.id)}/content" alt="${escape(photo.originalFilename)}" loading="lazy"${photo.width?` width="${Number(photo.width)}"`:""}${photo.height?` height="${Number(photo.height)}"`:""}>`
    +(canEdit?`<button type="button" class="photo-remove" data-photo-remove="${escape(photo.id)}" aria-label="Remove ${escape(photo.originalFilename)}">×</button>`:"")
    +`</figure>`;
}

function photoPhaseMarkup(pet,phase,label,canEdit,limit){
  const photos=pet[phase]||[];
  const full=photos.length>=limit;
  return `<div class="photo-phase"><p class="photo-phase-label">${escape(label)}</p><div class="photo-strip">`
    +(canEdit
      ? `<button type="button" class="photo-add" data-photo-pet="${escape(pet.petId)}" data-photo-phase="${escape(phase)}"${full?" disabled":""} aria-label="Add ${escape(label.toLowerCase())} photo for ${escape(petName({petName:pet.petName}))}">`
        +`<span aria-hidden="true">+</span><small>${full?"Limit reached":"Add"}</small></button>`
      : "")
    +photos.map(photo=>photoTileMarkup(photo,canEdit)).join("")
    +(!photos.length&&!canEdit?`<p class="photo-empty">No ${escape(label.toLowerCase())} photos.</p>`:"")
    +`</div></div>`;
}

function appointmentPhotosMarkup(state){
  if(state.failed)return `<p class="photo-empty">Photos could not be loaded.</p>`;
  if(!state.data)return `<p class="photo-empty">Loading photos…</p>`;
  const {pets,canEdit,maxPerPhase}=state.data;
  if(!pets?.length)return `<p class="photo-empty">No pet is attached to this appointment.</p>`;
  return pets.map(pet=>{
    const count=(pet.before?.length||0)+(pet.after?.length||0);
    return `<details class="photo-pet" data-photo-pet-section="${escape(pet.petId)}" open>`
      +`<summary><span class="service-section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg></span>`
      +`<span>${escape(petName({petName:pet.petName}))}</span><small>${count}</small></summary>`
      +`<div class="photo-pet-body">`
        +photoPhaseMarkup(pet,"before","Before",canEdit,maxPerPhase)
        +photoPhaseMarkup(pet,"after","After",canEdit,maxPerPhase)
      +`</div></details>`;
  }).join("");
}

async function uploadAppointmentPhoto(appointmentId,petId,phase,file){
  const body=new FormData();
  // Metadata must be the first part: the route reads it before it will touch the file, so a
  // request that streams bytes ahead of its own description is refused rather than buffered.
  body.append("metadata",JSON.stringify({petId,phase,uploadRequestId:globalThis.crypto.randomUUID()}));
  body.append("file",file,file.name||"photo");
  return api(`/api/appointments/${appointmentId}/photos`,{method:"POST",body});
}

function bindAppointmentPhotos(dialog,appointmentId,photos,rerender){
  const container=dialog.querySelector('[data-testid="appointment-photos"]');
  if(!container)return;
  const reload=async()=>{
    try{photos.data=await api(`/api/appointments/${appointmentId}/photos`);photos.failed=false;}
    catch{photos.failed=true;}
    rerender();
  };
  container.querySelectorAll(".photo-add").forEach(button=>button.addEventListener("click",()=>{
    const input=document.createElement("input");
    input.type="file";input.accept=PHOTO_ACCEPT;
    input.addEventListener("change",async()=>{
      const file=input.files?.[0];if(!file)return;
      button.disabled=true;
      try{
        await uploadAppointmentPhoto(appointmentId,button.dataset.photoPet,button.dataset.photoPhase,file);
        await reload();
      }catch(error){toast(error.message);button.disabled=false;}
    },{once:true});
    input.click();
  }));
  container.querySelectorAll(".photo-remove").forEach(button=>button.addEventListener("click",async()=>{
    if(!confirm("Remove this photo?"))return;
    button.disabled=true;
    try{await api(`/api/appointment-photos/${button.dataset.photoRemove}`,{method:"DELETE"});await reload();}
    catch(error){toast(error.message);button.disabled=false;}
  }));
}
// ---------------------------------------------------------------------------
// Report cards
//
// A short write-up of the visit, previewed in its own window. The preview is a staff view:
// it needs the same session as the rest of Pawsh, and there is no link to hand a client.
// ---------------------------------------------------------------------------
function reportCardStamp(value){
  if(!value)return null;
  const when=new Date(value);
  return formatPrefDateAndTime(when);
}

function reportCardActionsMarkup(card,canEdit,canSend){
  const action=(key,label,icon,enabled)=>enabled
    ? `<button type="button" class="report-card-action" data-report-card-action="${key}" data-report-card="${escape(card.id)}" title="${escape(label)}" aria-label="${escape(label)}">${icon}</button>`
    : "";
  return `<div class="report-card-actions">`
    +action("preview","Preview report card",`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,true)
    +action("edit","Edit report card",`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z"/></svg>`,canEdit)
    +action("delete","Delete report card",`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>`,canEdit)
    +action("send","Send report card",`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 3 10l7 3 3 7Z"/></svg>`,canSend)
    +`</div>`;
}

function appointmentReportCardsMarkup(state){
  if(state.failed)return `<p class="report-card-empty">Report cards could not be loaded.</p>`;
  if(!state.data)return `<p class="report-card-empty">Loading report cards…</p>`;
  const {items,canEdit,canSend}=state.data;
  if(!items.length){
    return `<p class="report-card-empty">No report card for this visit yet.</p>`;
  }
  return `<div class="report-card-table-wrap" data-allow-horizontal-scroll><table class="report-card-table">`
    +`<thead><tr><th scope="col">Date</th><th scope="col">Pet</th><th scope="col">Client</th>`
    +`<th scope="col">Last edited</th><th scope="col">Last sent</th><th scope="col">Actions</th></tr></thead><tbody>`
    +items.map(card=>`<tr>`
      +`<td>${escape(formatPrefLocalDate(card.appointmentDate))}</td>`
      +`<td>${escape(petName({petName:card.petName}))}</td>`
      +`<td>${escape(card.customerName)}</td>`
      +`<td>${escape(reportCardStamp(card.lastEditedAt)||"—")}<small>${escape(card.lastEditedBy||"")}</small></td>`
      // A card that has never been sent says so rather than showing a blank cell that could be
      // read either way.
      +`<td>${card.lastSentAt?escape(reportCardStamp(card.lastSentAt)):`<span class="report-card-unsent">Not sent</span>`}</td>`
      +`<td>${reportCardActionsMarkup(card,canEdit,canSend)}</td></tr>`).join("")
    +`</tbody></table></div>`;
}

function openReportCardPreview(cardId){
  // A named window so repeated previews reuse one tab instead of piling up.
  globalThis.open(`/api/report-cards/${encodeURIComponent(cardId)}/preview`,"pawsh-report-card","noopener");
}

// The appointment detail already occupies the shared dialog, so the editor and the send
// confirmation stack on top of it instead of replacing it. Calling openModal here would throw:
// showModal() on an already-open dialog is an error, and the operator would lose the detail
// they were working in.
function openReportCardEditor(card,{appointmentId,petId,onSaved}){
  const existing=Boolean(card);
  openStackedDialog({
    title:existing?"Edit report card":"New report card",
    body:`<label class="stacked-field">Note for the client`
      +`<textarea name="note" maxlength="4000" rows="6" placeholder="How the visit went, anything the client should know.">${escape(card?.note||"")}</textarea></label>`
      +`<p class="fine">The visit, services, groomer, and photos are read from the appointment when the card is shown, so they stay correct without being copied in here.</p>`,
    dismissLabel:"Cancel",
    confirmLabel:existing?"Save":"Create",
    onConfirm:async body=>{
      const note=String(body.querySelector('[name="note"]').value||"").trim()||null;
      if(existing)await api(`/api/report-cards/${card.id}`,{method:"PATCH",body:JSON.stringify({note,version:card.version})});
      else await api(`/api/appointments/${appointmentId}/report-cards`,{method:"POST",body:JSON.stringify({petId,note})});
      toast(existing?"Report card saved":"Report card created");
      runDetached(onSaved);
    }
  });
}

function openReportCardSend(card,onSent){
  openStackedDialog({
    title:"Send report card",
    body:`<p>Email ${escape(petName({petName:card.petName}))}'s report card to ${escape(card.customerName)}?</p>`
      // Said before the send, not discovered after it.
      +`<p class="fine">The message carries the visit, the services, and your note. It does not carry the photos: Pawsh sends plain email and has no client-facing page to link to, so the message tells the client the photos are held on their record at the salon.</p>`
      +(card.sendCount?`<p class="fine">Already sent ${escape(String(card.sendCount))} time${card.sendCount===1?"":"s"}, most recently ${escape(reportCardStamp(card.lastSentAt))}.</p>`:""),
    dismissLabel:"Cancel",
    confirmLabel:"Send",
    onConfirm:async()=>{
      const result=await api(`/api/report-cards/${card.id}/send`,{method:"POST",body:JSON.stringify({channel:"email"})});
      toast(`Report card queued by email to ${result.destination}`);
      runDetached(onSent);
    }
  });
}

function bindAppointmentReportCards(dialog,appointmentId,cards,rerender){
  const container=dialog.querySelector('[data-testid="appointment-report-cards"]');
  if(!container)return;
  const reload=async()=>{
    try{cards.data=await api(`/api/appointments/${appointmentId}/report-cards`);cards.failed=false;}
    catch{cards.failed=true;}
    rerender();
  };
  const byId=id=>(cards.data?.items||[]).find(card=>card.id===id);
  container.querySelectorAll("[data-report-card-action]").forEach(button=>button.addEventListener("click",async()=>{
    const card=byId(button.dataset.reportCard);if(!card)return;
    const action=button.dataset.reportCardAction;
    if(action==="preview")return openReportCardPreview(card.id);
    if(action==="edit")return openReportCardEditor(card,{onSaved:reload});
    if(action==="send")return openReportCardSend(card,reload);
    if(!confirm(`Delete ${card.petName}'s report card?${card.sendCount?" It has already been sent to the client." : ""}`))return;
    button.disabled=true;
    try{await api(`/api/report-cards/${card.id}`,{method:"DELETE"});await reload();}
    catch(error){toast(error.message);button.disabled=false;}
  }));
  // Add sits in the section header beside the heading, not inside the table container, so it is
  // looked up from the dialog rather than from `container`.
  dialog.querySelector("[data-report-card-add]")?.addEventListener("click",event=>{
    openReportCardEditor(null,{
      appointmentId,petId:event.currentTarget.dataset.reportCardAdd,onSaved:reload
    });
  });
}
// Phrasing for the audit feed. Every line names what happened, who recorded it, and when,
// because an activity log whose entries cannot be attributed is not evidence of anything.
const APPOINTMENT_ACTIVITY_LABELS={
  "appointment.create":"Appointment created",
  "appointment.move":"Appointment rescheduled",
  "appointment.services.update":"Services changed",
  "appointment.conflict_override":"Overlap booked deliberately",
  "appointment.checked_in":"Checked in",
  "appointment.in_service":"Service started",
  "appointment.completed":"Marked completed",
  "appointment.cancelled":"Appointment cancelled",
  "appointment.no_show":"Marked no show",
  "invoice.create":"Checked out and invoiced",
  "payment.record":"Payment recorded",
  "payment.void":"Payment record voided"
};
function activityStamp(value){
  const when=new Date(value);
  return formatPrefDateAndTime(when);
}
function appointmentActivityLine(entry){
  const label=APPOINTMENT_ACTIVITY_LABELS[entry.action]||entry.action.replaceAll("."," ").replaceAll("_"," ");
  const parts=[label];
  if(entry.action==="payment.record"&&entry.amountMinor!==null)parts.push(`${money(entry.amountMinor)}${entry.method?` by ${entry.method}`:""}`);
  if(entry.action==="invoice.create"&&entry.totalMinor!==null)parts.push(money(entry.totalMinor));
  if(entry.action==="appointment.move"&&entry.fromStartAt&&entry.toStartAt)parts.push(`${activityStamp(entry.fromStartAt)} → ${activityStamp(entry.toStartAt)}`);
  return `${parts.join(" · ")} by ${entry.actorName||"an unknown account"} at ${activityStamp(entry.createdAt)}${entry.reason?` — ${entry.reason}`:""}`;
}
// Pawsh stores no dedicated check-in or check-out timestamp; the QA registry records that as an
// open gap. The audit trail does hold the moment each transition was recorded, so the times are
// derived from it and labelled as recorded events rather than presented as stored fields.
function appointmentLifecycleTimes(activity){
  const at=action=>activity.find(entry=>entry.action===action)?.createdAt||null;
  const checkedIn=at("appointment.checked_in");
  const finished=at("appointment.completed")||at("appointment.cancelled")||at("appointment.no_show");
  const minutes=checkedIn&&finished
    ? Math.max(0,Math.round((new Date(finished)-new Date(checkedIn))/60000))
    : null;
  return {checkedIn,finished,minutes};
}
function appointmentActivityMarkup(state){
  if(state.failed)return `<p class="activity-empty">Appointment activity could not be loaded.</p>`;
  if(!state.items)return `<p class="activity-empty">Loading activity…</p>`;
  if(!state.items.length)return `<p class="activity-empty">No recorded activity for this appointment.</p>`;
  return `<ol class="activity-feed">${state.items.map(entry=>
    `<li>${escape(appointmentActivityLine(entry))}</li>`).join("")}</ol>`;
}

// ---------------------------------------------------------------------------
// The appointment surface stack
//
// Three dedicated full-screen <dialog> elements - detail, checkout, ticket - opened with
// showModal(). The top layer, the backdrop, inertness of everything beneath, Escape-to-topmost
// and focus containment are the browser's; none of it is re-implemented here.
//
// NOT ROUTED VIEWS. Dismissing a route re-renders the calendar, which loses the horizontal
// scroll offset revealCalendarDate() exists to restore and the groomer filter the operator
// applied. A front desk opens and closes this surface dozens of times a day, and routing would
// also make a half-finished checkout deep-linkable.
//
// NOT THE SHARED #modal, which already hosts this surface's own children (Move, Adjust services)
// and throws on showModal() while open. NOT openStackedDialog either: that is a single fixed
// element, so it cannot be level 2 and level 3 at the same time.
//
// ONE HISTORY ENTRY PER LEVEL. `popstate` reconciles the open stack DOWN to the entry's depth -
// it closes levels and never opens them - so Back and the Android back gesture dismiss exactly
// one level, and a reload at any depth lands on the view beneath with the stack closed.
// ---------------------------------------------------------------------------
const APPOINTMENT_STACK_IDS=["appointment-detail","appointment-checkout","appointment-ticket"];
const appointmentStack={levels:[]};
// history.back() calls this module made itself. The resulting popstate is already accounted for,
// and without this the last level's own dismissal would fall through to the view router and
// re-render the calendar the operator is about to be handed back.
let appointmentStackBacks=0;

function appointmentStackState(){return {apptStack:appointmentStack.levels.map(level=>level.id)};}

/**
 * Focus, handed back to the control that opened the stack - or to whatever has replaced it.
 *
 * `restoreFocus` is the ELEMENT that was clicked, and the calendar underneath is redrawn whole by
 * anything that refreshes it: returning to the tab does it, and so does a permission
 * reconciliation. The card that opened the surface is a detached node by then, `focus()` on it is
 * a silent no-op, and the operator is dropped at the top of the document with the calendar they
 * were working scrolled somewhere behind them. Every other `restoreFocus` in this file is a
 * selector for exactly this reason, so a detached card is resolved again by the appointment id it
 * carries - preferring the same kind of control, because the week grid, the month cell and the
 * agenda each draw one for the same visit.
 */
function focusStackReturn(target){
  if(!target?.focus)return;
  if(target.isConnected){target.focus();return;}
  const appointmentId=target.dataset?.calendarAppointment;
  if(!appointmentId)return;
  const replacements=$$(`[data-calendar-appointment="${appointmentId}"]`);
  (replacements.find(node=>node.className===target.className)||replacements[0])?.focus();
}

/**
 * `path` is accepted and ignored today. Level 1 is expected to gain a real URL once an
 * appointment is addressable; taking the parameter now means that lands as a call-site change
 * rather than a rework of this primitive.
 */
function pushStackLevel(level,{path=null}={}){
  appointmentStack.levels.push(level);
  level.dialog.showModal();
  level.dialog.querySelector("[data-surface-close]")?.focus();
  globalThis.history.pushState(appointmentStackState(),"",path||location.pathname);
}

async function popStackLevel({viaHistory=false}={}){
  const level=appointmentStack.levels.at(-1);
  if(!level)return;
  // A level may refuse to close - an unsaved capture in a later stage. Nothing registers a guard
  // in stage 1; the seam is here so adding one later does not mean reopening this.
  if(await level.guard?.()===false)return false;
  appointmentStack.levels.pop();
  level.dialog.close();
  level.onClose?.();
  const beneath=appointmentStack.levels.at(-1)?.dialog.querySelector("[data-surface-close]");
  if(beneath)beneath.focus();
  else focusStackReturn(level.restoreFocus);
  if(!viaHistory){appointmentStackBacks++;globalThis.history.back();}
  return true;
}

// Every level, in order, refusals respected. Leaving the surface entirely - opening the client
// profile, booking again - goes through this rather than closing one level and navigating out
// from under the rest.
async function closeAppointmentStack(){
  while(appointmentStack.levels.length)if(await popStackLevel()===false)return false;
  return true;
}

// True when the popstate belonged to the stack and the view router must stand down.
function reconcileAppointmentStack(entry){
  if(appointmentStackBacks>0){appointmentStackBacks--;return true;}
  if(!appointmentStack.levels.length)return false;
  const target=Array.isArray(entry?.apptStack)?entry.apptStack.length:0;
  if(appointmentStack.levels.length<=target)return true;
  runDetached(async()=>{
    while(appointmentStack.levels.length>target){
      if(await popStackLevel({viaHistory:true})===false){
        // A level refused. The entry it owns is put back rather than leaving the URL a step ahead
        // of what is on screen.
        globalThis.history.pushState(appointmentStackState(),"",location.pathname);
        return;
      }
    }
  });
  return true;
}

for(const id of APPOINTMENT_STACK_IDS){
  // Escape closes the topmost dialog natively, which would leave the stack and the history depth
  // disagreeing with the screen. It is routed through the one dismissal every other close uses.
  $(`#${id}`)?.addEventListener("cancel",event=>{event.preventDefault();runDetached(()=>popStackLevel());});
}

// The rail is a <details> so a phone can collapse it below the main column. A wide viewport
// forces it open and hides its summary in CSS, and only script can set `open`, so the breakpoint
// is mirrored here rather than being decided in two places that could drift.
// The exact complement of the stylesheet's `@media(max-width:900px)`, written as a negation so
// the two cannot disagree at the boundary itself - `(min-width:900px)` and `(max-width:900px)`
// are both true at exactly 900, which left the rail forced open inside a collapsed disclosure.
const APPOINTMENT_RAIL_QUERY=globalThis.matchMedia("not all and (max-width:900px)");
// The operator's own toggle, for as long as the width it was made at holds. Null means "take the
// breakpoint's default": open as a column, closed as a disclosure under the work, because a phone
// at a counter was opened for times, service and money rather than to reread a client record.
let appointmentRailOpen=null;
function syncAppointmentRail(){
  const rail=$("#appointment-detail .surface-rail");
  if(rail)rail.open=appointmentRailOpen??APPOINTMENT_RAIL_QUERY.matches;
}
// Crossing the breakpoint changes what the rail IS, so the choice made on the other side of it
// is not carried over.
APPOINTMENT_RAIL_QUERY.addEventListener("change",()=>{appointmentRailOpen=null;syncAppointmentRail();});

// The invoice state is the honest paid badge: an appointment with no invoice is unbilled rather
// than unpaid, and the two read very differently to whoever is looking at the row.
function appointmentBillingChip(item){
  if(!item.invoiceStatus)return {label:"Not invoiced",tone:"muted"};
  if(item.invoiceStatus==="paid")return {label:"Paid",tone:"paid"};
  // A refunded invoice owes nothing, so it never carries a "due" figure and never wears the
  // owing colour. It reads as information, because that is what it is.
  if(invoiceRefunded(item.invoiceStatus))return {label:invoiceStatusLabel(item.invoiceStatus),tone:"refunded"};
  return {label:`${invoiceStatusLabel(item.invoiceStatus)}${item.invoiceBalanceMinor?` · ${money(item.invoiceBalanceMinor)} due`:""}`,tone:"owing"};
}

// Minutes as an operator says them. Under an hour is the raw count; an hour and over is split,
// because "75 min" makes the reader do the division every single time.
function lifecycleDurationLabel(minutes){
  if(minutes===null)return "not recorded";
  if(minutes<60)return `${minutes} min`;
  const hours=Math.floor(minutes/60),rest=minutes%60;
  return rest?`${hours} h ${rest} m`:`${hours} h`;
}

/**
 * Checked in, checked out and duration, derived from the audit trail by
 * appointmentLifecycleTimes().
 *
 * `editable` IS THE SEAM FOR STORED TIMES and is false everywhere today. While these values are
 * derived there is nothing an edit could write to, so no pencil is drawn: an affordance opening a
 * form that cannot save is worse than no affordance. When the stored checked_in_at/checked_out_at
 * columns land the flag flips, an edit dialog joins it, and the derivation note below - which is
 * only true while the values ARE derived - stops being emitted.
 */
function appointmentLifecycleMarkup(activity,{editable=false}={}){
  // A value that is not there is set back in weight rather than wearing the ink of a recorded
  // one, so the strip reads at a glance as two facts and a gap.
  const cell=(testid,label,value,recorded=true)=>
    `<span data-testid="${testid}">${escape(label)}: `
      +`<strong${recorded?"":` class="is-unrecorded"`}>${escape(value)}</strong></span>`;
  if(!activity.items){
    return cell("lifecycle-in","Checked in","…",false)+cell("lifecycle-out","Checked out","…",false)
      +cell("lifecycle-duration","Duration","…",false);
  }
  const {checkedIn,finished,minutes}=appointmentLifecycleTimes(activity.items);
  const missing=!checkedIn||!finished||minutes===null;
  return cell("lifecycle-in","Checked in",checkedIn?activityStamp(checkedIn):"not recorded",Boolean(checkedIn))
    +cell("lifecycle-out","Checked out",finished?activityStamp(finished):"not recorded",Boolean(finished))
    +cell("lifecycle-duration","Duration",lifecycleDurationLabel(minutes),minutes!==null)
    // Said once, and only when something is actually absent: two blanks beside a filled value
    // otherwise read as an editable field nobody got round to rather than as derived and absent.
    +(missing&&!editable
      ? `<span class="fine lifecycle-note" data-testid="lifecycle-note">Times are read from the appointment's recorded activity.</span>`
      : "");
}

// Printing is the one mechanism the product has: a .print-root appended to <body>, which the
// print stylesheet is the only thing that shows. No second window and no separate page.
function printAppointment(item){
  const root=document.createElement("section");
  root.className="print-root";
  root.innerHTML=`<h1>Pawsh appointment</h1>${printableAgenda([item])}`;
  document.body.append(root);
  globalThis.print();
  setTimeout(()=>root.remove(),1000);
}

/**
 * Two notes, two audiences, two write rules, so they are not presented as one field.
 *
 * `notes` IS THE APPOINTMENT NOTE - what the client asked for when the visit was booked, and the
 * typo somebody notices four weeks later. `PATCH /api/appointments/:id` writes it under
 * `appointments.edit` with NO status and NO invoice precondition, because a completed, invoiced,
 * fully paid visit whose note misspells the dog's name has to be correctable in place rather than
 * by cancelling and rebooking. So the editor below is offered in every status, and it is a
 * DISCLOSURE rather than a standing textarea: this surface is read far more often than it is
 * written, and a note that is usually right should read as text.
 *
 * `operationalNotes` IS THE SERVICE NOTE, written while the dog is on the table.
 * `PATCH /api/appointments/:id/operations` accepts it only while the appointment is checked in or
 * in service, under `operations.perform_service`. Outside that window a textarea would be a
 * control whose save the server refuses, so it is not drawn - and it keeps the footer Save it has
 * always had. Two saves that can be on screen at once must not be ambiguous about what they
 * write, which is why the appointment note carries its own Save inside its own part of the block
 * and never borrows the footer's.
 */
function appointmentRecordNoteMarkup(surface){
  const {item,permissions:can,note}=surface;
  const head=`<div class="work-block-head"><h3>Appointment note</h3>`
    +(can.editAppointmentNote&&!note.open
      ? `<button type="button" class="secondary compact" data-testid="appointment-note-edit">`
        +`${item.notes?"Edit":"Add"}</button>`
      : "")
    +`</div>`;
  if(!note.open){
    return head+(item.notes
      ? `<p data-testid="appointment-booking-note">${escape(item.notes)}</p>`
      : `<p class="note-empty">No appointment note.</p>`);
  }
  // The value the operator is holding, not the value on the row: a redraw underneath a half-typed
  // correction - a closing modal, a reload after a transition - must not retype the field.
  const draft=note.draft??item.notes??"";
  // `note.conflict` is the row as it stands NOW, re-read after the server refused the version this
  // editor opened with. NOTHING IS MERGED: the operator is shown what is saved while still holding
  // what they typed, and chooses between the two.
  const conflict=note.conflict
    ? `<div class="appointment-note-conflict" data-testid="appointment-note-conflict" role="alert">`
      +`<p><strong>This note was changed somewhere else.</strong> Nothing you typed has been saved.</p>`
      +`<p class="fine">Saved now:</p>`
      +(note.conflict.notes
        ? `<blockquote data-testid="appointment-note-conflict-current">${escape(note.conflict.notes)}</blockquote>`
        : `<p class="note-empty" data-testid="appointment-note-conflict-current">No appointment note.</p>`)
      +`<div class="appointment-note-actions">`
        +`<button type="button" class="primary compact" data-testid="appointment-note-conflict-keep">Keep my version</button>`
        +`<button type="button" class="secondary compact" data-testid="appointment-note-conflict-take">Use the saved note</button>`
      +`</div></div>`
    : "";
  const error=note.error
    ? `<p class="error" data-testid="appointment-note-error" role="alert">${escape(note.error)}</p>`
    : "";
  return head
    +`<label class="surface-note-field"><span class="visually-hidden">Appointment note</span>`
      +`<textarea data-testid="appointment-note-record-input" name="appointmentNotes" rows="4"`
      +` maxlength="5000" placeholder="What the client asked for, and anything the front desk needs to remember."`
      +`${note.saving?" disabled":""}>${escape(draft)}</textarea></label>`
    +conflict+error
    // While a refusal is on screen the plain Save is WITHDRAWN, not repeated: "Keep my version"
    // inside the panel is the same write, and two buttons that do one thing is exactly the
    // ambiguity a conflict is the worst moment to introduce.
    +`<div class="appointment-note-actions">`
      +(note.conflict
        ? ""
        : `<button type="button" class="primary compact" data-testid="appointment-note-save"${note.saving?" disabled":""}>Save</button>`)
      +`<button type="button" class="secondary compact" data-testid="appointment-note-cancel"${note.saving?" disabled":""}>Cancel</button>`
    +`</div>`;
}

function appointmentNotesBlockMarkup(surface){
  const {item,permissions:can}=surface;
  const service=can.editNote
    ? `<label class="surface-note-field"><span class="visually-hidden">Service note</span>`
      +`<textarea data-testid="appointment-note-input" name="operationalNotes" rows="4" maxlength="10000"`
      +` placeholder="What happened during this visit.">${escape(item.operationalNotes||"")}</textarea></label>`
    : item.operationalNotes
      ? `<p data-testid="appointment-service-note">${escape(item.operationalNotes)}</p>`
      : `<p class="note-empty">No service note.</p>`;
  return `<div class="work-block appointment-note" data-testid="appointment-note">`
    +`<div class="appointment-note-part" data-testid="appointment-record-note">`
      +appointmentRecordNoteMarkup(surface)+`</div>`
    +`<div class="appointment-note-part">`
      +`<div class="work-block-head"><h3>Service note</h3></div>${service}</div>`
  +`</div>`;
}

function appointmentSurfaceMarkup(surface){
  const {item,model,activity,photos,cards,permissions:can}=surface;
  const billing=appointmentBillingChip(item);
  // A UUID is not a counter, so this is presented as a reference rather than an invented number.
  const reference=String(item.id).slice(0,8);
  const serviceRows=model.serviceSnapshots.map(service=>
    `<div class="appointment-service-row" data-testid="appointment-service-row">`
      +`<span><strong>${escape(service.name)}</strong><small>${Number(service.durationMinutes)} min</small></span>`
      +`<strong>${service.priceMinor===null||service.priceMinor===undefined?"Price unavailable":money(service.priceMinor)}</strong>`
    +`</div>`).join("");

  const head=`<header class="surface-head">`
    +`<div class="surface-head-text">`
      +`<p class="appointment-reference" data-testid="appointment-reference">Appointment #${escape(reference)}`
        +` <span class="appointment-billing ${billing.tone}" data-testid="appointment-billing">${escape(billing.label)}</span>`
        +` <span class="appointment-status" data-testid="appointment-status">${escape(model.status)}</span></p>`
      +`<h2 id="appointment-detail-title">${escape(model.dateLabel)}</h2>`
      +`<p class="surface-subhead">${escape(model.timeRange)} · scheduled ${model.durationMinutes} min</p>`
    +`</div>`
    // The Ticket's own entry point, and the reason it is an icon rather than a footer button: the
    // work sheet is printed from every appointment at any stage, so it sits with the surface's
    // chrome rather than among the controls that act on the visit. `.header-icon-button` is the
    // product's existing icon button, so it already carries the 44px touch target on a coarse
    // pointer and the stroke conventions every other icon in the app is drawn with.
    +`<div class="surface-head-actions">`
      +`<button type="button" class="header-icon-button" data-testid="appointment-ticket-print"`
        +` aria-label="Print ticket" title="Print ticket">`
        +`<svg viewBox="0 0 24 24" aria-hidden="true">`
          +`<path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/>`
          +`<path d="M7 14h10v7H7zM9 17h6M9 19h4"/></svg></button>`
      +`<button type="button" class="surface-close" data-surface-close aria-label="Close appointment details">&#215;</button>`
    +`</div>`
  +`</header>`;

  // The rail is clientSummaryMarkup() verbatim, written in after open by
  // renderClientSummaryPane(). It is a <details> so the phone layout can collapse it.
  const rail=`<details class="surface-rail" data-testid="appointment-client-rail" open>`
    +`<summary class="surface-rail-toggle">`
      +`<span class="service-section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg></span>`
      +`<span>Client</span></summary>`
    +`<div class="surface-rail-body"><p class="note-empty">Loading client…</p></div>`
  +`</details>`;

  const work=`<section class="appointment-work">`
    +`<div class="work-block"><div class="work-block-head"><h3>Groomer</h3>`
      +(can.move
        ? `<button type="button" class="icon-action" data-testid="appointment-groomer-edit" aria-label="Change groomer or time">&#9998;</button>`
        : "")
      +`</div><p data-testid="appointment-groomer">${escape(model.groomer)}</p>`
      +appointmentLockNoteMarkup("appointment-detail-lock-note")+`</div>`
    +`<div class="work-block"><div class="work-block-head"><h3>Pet</h3></div>`
      +`<p><strong>${escape(petName({petName:model.petName}))}</strong>${model.breed?` · ${escape(model.breed)}`:""}</p>`
      +(model.rabiesNeeded?`<p class="rabies-needed">Rabies needed</p>`:"")
      +(model.warning?`<p class="detail-warning">${escape(model.warning)}</p>`:"")
    +`</div>`
    +`<div class="work-block appointment-services-block"><div class="work-block-head"><h3>Services</h3>`
      +(can.adjustServices
        ? `<button type="button" class="secondary compact" data-testid="appointment-adjust-services">Adjust services</button>`
        : "")
      +`</div>${serviceRows}`
      +`<div class="appointment-service-total"><span>Total</span><strong>${model.durationMinutes} min${
        model.totalPriceMinor!==null?` · ${money(model.totalPriceMinor)}`:""}</strong></div>`
    +`</div>`
    // Discounts and coupons are decided at checkout and recorded on the invoice - Pawsh has
    // nowhere else to apply one - so the row says where they live rather than offering a second
    // button into the same dialog Take Payment already opens.
    +`<div class="work-block appointment-discount-row" data-testid="appointment-discount-row">`
      +`<div class="work-block-head"><h3>Coupons &amp; discounts</h3></div>`
      +`<p>${item.invoiceStatus
        ? "Recorded on this appointment's invoice."
        : "Applied at checkout, on the invoice this appointment is billed with."}</p>`
    +`</div>`
    +appointmentNotesBlockMarkup(surface)
    +`<details class="appointment-activity" data-testid="appointment-activity"><summary>`
      +`<span class="service-section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg></span>`
      +`<span>Appointment Activities</span><small data-activity-count>${
        activity.failed?"unavailable":activity.items?`(${activity.items.length})`:"…"}</small></summary>`
      +`<div class="appointment-activity-body">${appointmentActivityMarkup(activity)}</div></details>`
    +`<section class="appointment-photos"><h4>Photos</h4>`
      +`<div data-testid="appointment-photos">${appointmentPhotosMarkup(photos)}</div></section>`
    +`<section class="appointment-report-cards"><div class="report-card-head"><h4>Report Card</h4>`
      +`<span data-testid="report-card-add-slot"></span></div>`
      +`<div data-testid="appointment-report-cards">${appointmentReportCardsMarkup(cards)}</div></section>`
  +`</section>`;

  const body=`<div class="surface-body">${rail}<div class="surface-main">`
    +`<div class="appointment-lifecycle" data-testid="appointment-lifecycle">${appointmentLifecycleMarkup(activity)}</div>`
    +work
  +`</div></div>`;

  const print=`<button type="button" class="secondary compact" data-testid="appointment-print">Print</button>`;
  // Level 3, AND IT IS OFFERED IN EVERY STATE - the same rule the header's print icon has always
  // applied. What changes with the state is only which control gets the primary slot: on a
  // completed visit CLOSE GIVES UP THE PRIMARY SLOT, because opening the Ticket is what the
  // operator came for and dismissal is not, while on a cancelled or no-show visit there is nothing
  // to come for and Close keeps it.
  const ticket=`<button type="button" class="${can.readOnly&&can.ticketPrimary?"primary":"secondary"} compact" data-testid="appointment-ticket">Ticket</button>`;
  const foot=can.readOnly
    // Nothing on this appointment can move any more, so the footer offers the things that still
    // mean something rather than a row of controls the server would refuse.
    ? `<footer class="surface-foot"><div class="surface-foot-actions"></div>`
      +`<div class="surface-foot-actions">${print}`
      +`<button type="button" class="${can.ticketPrimary?"secondary":"primary"} compact" data-testid="appointment-close">Close</button>`
      +ticket+`</div></footer>`
    : `<footer class="surface-foot"><div class="surface-foot-actions">`
        +(can.cancel?`<button type="button" class="secondary compact destructive" data-testid="appointment-cancel">Cancel</button>`:"")
        +(can.cancel?`<button type="button" class="secondary compact" data-testid="appointment-no-show">No-show</button>`:"")
        +(can.bookAgain?`<button type="button" class="secondary compact" data-testid="appointment-book-again">Book Again</button>`:"")
      +`</div><div class="surface-foot-actions">${print}${ticket}`
        // Billing the visit stays the primary action while it is still unbilled; the Ticket is
        // available beside it.
        +(can.checkout?`<button type="button" class="primary compact" data-testid="appointment-take-payment">Take Payment</button>`:"")
        +(can.editNote?`<button type="button" class="primary compact" data-testid="appointment-save">Save</button>`:"")
      +`</div></footer>`;

  return `<div class="surface-shell" data-testid="appointment-detail">${head}${body}${foot}</div>`;
}

/**
 * The appointment detail surface: level 1 of the stack.
 *
 * There is no `replace` argument. Opening an appointment while a detail surface is already open -
 * which is what clicking a row in the surface's own client rail does - REDRAWS the open surface
 * rather than stacking a second one on itself, so the history depth stays at one and the operator
 * never sees the calendar flash between two appointments.
 */
async function openCalendarAppointment(id,origin=null,{returnView="calendar"}={}){
  // Client history reaches back past any calendar window the operator has loaded, so a visit the
  // calendar has never held is refetched in the same projection rather than being unopenable from
  // a profile.
  const source=origin||document.activeElement;
  let item=calendarAppointmentById(id);
  if(!item){try{item=await api(`/api/appointments/${id}`);}catch(error){toast(error.message);return;}}
  if(!item)return;
  hideCalendarHover();closeCalendarMenus();

  const dialog=$("#appointment-detail");
  const open=appointmentStack.levels.at(-1);
  const replacing=open?.id==="appointment-detail";
  const surface={
    item,model:appointmentPresentation(item),
    activity:{items:null,failed:false},photos:{data:null,failed:false},cards:{data:null,failed:false},
    client:{loaded:false,failed:false},permissions:null,
    // The appointment note's editor, held on the surface rather than in the DOM so a redraw
    // underneath it - a closing modal, a reload after a transition - restores what the operator
    // was typing instead of retyping the field from the row. `baseVersion` is the version of the
    // row THIS EDITOR OPENED WITH and is what every save sends: refreshing `surface.item` while
    // somebody is mid-correction must not quietly re-aim the write at a newer row.
    note:{open:false,draft:null,baseVersion:null,conflict:null,error:null,saving:false}
  };
  const level=replacing?open:{
    id:"appointment-detail",dialog,restoreFocus:source,
    onClose(){
      clientSummaryRail=null;
      // The host this rail stood in for gets its own redraw back, so a note added in the dialog
      // is already on the screen underneath when the dialog goes.
      if(["messages","client-profile"].includes(document.body.dataset.view))renderClientProfile();
    }
  };
  level.surface=surface;
  // How a level above asks this one to redraw when it has changed something - a checkout that
  // raised an invoice, most obviously. The stack calls it without knowing what it is.
  level.reload=()=>reload();
  // A later level of the stack does not make this one stale; being replaced by another
  // appointment, or closed altogether, does.
  const stale=()=>level.surface!==surface||!appointmentStack.levels.includes(level);

  // Recomputed on every draw, because a transition, a reschedule or a checkout changes all of it.
  const derive=()=>{
    const status=surface.item.status,invoiced=Boolean(surface.item.invoiceStatus);
    return {
      readOnly:["cancelled","no_show"].includes(status)||(status==="completed"&&invoiced),
      move:status==="scheduled"&&appointmentMoveAllowed(),
      adjustServices:["checked_in","in_service"].includes(status)&&allowed("appointments.edit"),
      // Only a completed appointment can be checked out, and only once: the server says so, so
      // the button is absent rather than offered and refused. Absent, never disabled - the
      // precedent is calendarAction(), which withholds a transition the operator cannot make.
      checkout:status==="completed"&&!invoiced&&allowed("checkout.perform"),
      cancel:status==="scheduled"&&allowed("appointments.cancel"),
      bookAgain:allowed("appointments.create"),
      // NOT DERIVED AT ALL ANY MORE, and that is the point. The Ticket is the CRM document for the
      // visit - who, which pet, which services - so it needs no completion, no invoice and no
      // payment, and ADR-011's amendment says any state. The sheet is most useful BEFORE the
      // visit, printed and clipped to the run. This used to read `status==="completed"` while the
      // header's print icon beside it was ungated and `openTicket`'s own comment said in capitals
      // that there was no completion gate; three entry points, three rules, and the footer button
      // vanishing from exactly the appointment an operator wanted the sheet for.
      //
      // No permission gate either. The Ticket carries no money at all and never reads
      // `GET /api/invoices/:id/receipt`, so EXPOSING A TICKET DOES NOT EXPOSE A RECEIPT.
      //
      // `ticketPrimary` is presentation and nothing else: which of Ticket and Close is the footer's
      // primary button on a read-only surface. It decides no availability.
      ticketPrimary:status==="completed",
      editNote:["checked_in","in_service"].includes(status)&&allowed("operations.perform_service"),
      // The APPOINTMENT note, which is a different field with a different permission and no
      // status window at all. `readOnly` above is about the visit no longer moving; a note that
      // records what the client asked for is corrected long after the visit has settled, and
      // `PATCH /api/appointments/:id` accepts it in every status including completed and
      // invoiced. So this is gated on the permission and on nothing else.
      editAppointmentNote:allowed("appointments.edit")
    };
  };

  /**
   * The appointment note redraws ITS OWN PART OF THE BLOCK, never the surface.
   *
   * A full draw() rebuilds `dialog.innerHTML`, which would throw away a half-written SERVICE note
   * sitting in the textarea beside this one - so opening, cancelling, failing and saving all go
   * through here instead. Same reason drawPhotos() and drawCards() exist.
   */
  const drawRecordNote=(focus=null)=>{
    if(stale())return;
    const host=dialog.querySelector('[data-testid="appointment-record-note"]');
    if(!host)return;
    host.innerHTML=appointmentRecordNoteMarkup(surface);
    bindRecordNote();
    const target=focus&&host.querySelector(`[data-testid="${focus}"]`);
    if(!target)return;
    target.focus();
    // Correcting a note means adding to what is there far more often than replacing it, so the
    // caret lands after the existing text rather than selecting it.
    if(target.tagName==="TEXTAREA")target.setSelectionRange(target.value.length,target.value.length);
  };

  /**
   * A stale save is REFUSED AND SHOWN, never merged.
   *
   * `version` is the one this editor opened with, so a note somebody else corrected while this box
   * was open comes back 409 rather than being overwritten. The row is then re-read and presented
   * beside what the operator is still holding, and they choose: keep theirs, or take the saved one
   * into the box and go on from it. Nothing is combined, and nothing is discarded for them.
   */
  const saveRecordNote=async()=>{
    const note=surface.note;
    note.saving=true;note.error=null;note.conflict=null;
    drawRecordNote();
    const value=String(note.draft??"");
    try{
      // Emptied means CLEARED - `null` - and whitespace alone is emptied. Anything else is sent
      // exactly as typed, because the server does not trim and a note whose leading spaces were
      // eaten on the way back would not be the note the booking form wrote.
      const updated=await api(`/api/appointments/${id}`,{method:"PATCH",body:JSON.stringify({
        notes:value.trim()===""?null:value,version:note.baseVersion??surface.item.version})});
      if(stale())return;
      // 200 IS THE WHOLE CALENDAR ROW - the same projection GET /api/appointments/:id serves - so
      // the surface is re-seated on it rather than having one field patched into the old one.
      surface.item=updated;
      surface.model=appointmentPresentation(surface.item);
      surface.note={open:false,draft:null,baseVersion:null,conflict:null,error:null,saving:false};
      drawRecordNote("appointment-note-edit");
      applyCalendarAppointment(updated);
      toast("Appointment note saved");
    }catch(error){
      if(stale())return;
      note.saving=false;
      if(error.status!==409){note.error=error.message;drawRecordNote("appointment-note-record-input");return;}
      const current=await api(`/api/appointments/${id}`).catch(()=>null);
      if(stale())return;
      if(current){
        surface.item=current;
        surface.model=appointmentPresentation(surface.item);
        applyCalendarAppointment(current);
        note.baseVersion=current.version;
        note.conflict={notes:current.notes??null};
        drawRecordNote("appointment-note-conflict-keep");
      }else{
        note.error=`${error.message} The saved note could not be read - try again.`;
        drawRecordNote("appointment-note-record-input");
      }
    }
  };

  const bindRecordNote=()=>{
    const host=dialog.querySelector('[data-testid="appointment-record-note"]');
    if(!host)return;
    const on=(testid,handler)=>host.querySelector(`[data-testid="${testid}"]`)?.addEventListener("click",handler);
    on("appointment-note-edit",()=>{
      // `draft` is seeded here rather than left null so that a 409's re-read cannot become the
      // value in the box: once this editor is open, the box holds the operator's text and only
      // the operator's text.
      surface.note={open:true,draft:surface.item.notes??"",baseVersion:surface.item.version,
        conflict:null,error:null,saving:false};
      drawRecordNote("appointment-note-record-input");
    });
    on("appointment-note-cancel",()=>{
      surface.note={open:false,draft:null,baseVersion:null,conflict:null,error:null,saving:false};
      drawRecordNote("appointment-note-edit");
    });
    on("appointment-note-save",()=>runDetached(saveRecordNote));
    on("appointment-note-conflict-keep",()=>runDetached(saveRecordNote));
    on("appointment-note-conflict-take",()=>{
      surface.note.draft=surface.note.conflict?.notes??"";
      surface.note.conflict=null;
      drawRecordNote("appointment-note-record-input");
    });
    host.querySelector('[data-testid="appointment-note-record-input"]')
      ?.addEventListener("input",event=>{surface.note.draft=event.target.value;});
  };

  const drawRail=()=>{
    const host=dialog.querySelector(".surface-rail-body");
    if(!host)return;
    if(surface.client.failed){
      // A failed rail must not take the main column with it: times, services and money are what
      // this surface was opened for, and they are already on screen.
      host.innerHTML=`<div class="rail-status"><p class="note-empty">The client record could not be loaded.</p>`
        +`<button type="button" class="secondary compact" data-testid="appointment-client-retry">Retry</button></div>`;
      host.querySelector('[data-testid="appointment-client-retry"]')
        ?.addEventListener("click",()=>runDetached(loadClient));
      return;
    }
    if(!surface.client.loaded){host.innerHTML=`<p class="note-empty">Loading client…</p>`;return;}
    renderClientSummaryPane();
  };

  const drawActivity=()=>{
    const body=dialog.querySelector(".appointment-activity-body");
    if(body)body.innerHTML=appointmentActivityMarkup(surface.activity);
    const count=dialog.querySelector("[data-activity-count]");
    if(count)count.textContent=surface.activity.failed?"unavailable":`(${surface.activity.items.length})`;
    const lifecycle=dialog.querySelector('[data-testid="appointment-lifecycle"]');
    if(lifecycle)lifecycle.innerHTML=appointmentLifecycleMarkup(surface.activity);
  };

  // Photos and report cards re-render on their own after an upload, a removal or an edit, without
  // redrawing the surface around them or disturbing anything else in it.
  const drawPhotos=()=>{
    const target=dialog.querySelector('[data-testid="appointment-photos"]');
    if(!target)return;
    target.innerHTML=appointmentPhotosMarkup(surface.photos);
    bindAppointmentPhotos(dialog,id,surface.photos,drawPhotos);
  };

  // Add is rendered from the loaded data rather than from the markup above, because whether a pet
  // still needs a card is only known once the cards are back.
  const drawCards=()=>{
    const target=dialog.querySelector('[data-testid="appointment-report-cards"]');
    const slot=dialog.querySelector('[data-testid="report-card-add-slot"]');
    if(!target)return;
    target.innerHTML=appointmentReportCardsMarkup(surface.cards);
    if(slot){
      const pending=surface.cards.data?.canEdit?(surface.cards.data.availablePetIds||[]):[];
      // The photo strips also offer an "+ Add", so this one carries an explicit label rather than
      // relying on its visible text to tell the two apart.
      slot.innerHTML=pending.length
        ? `<button type="button" class="secondary compact" data-testid="report-card-add" data-report-card-add="${escape(pending[0])}" aria-label="Add report card">+ Add</button>`
        : "";
    }
    bindAppointmentReportCards(dialog,id,surface.cards,drawCards);
  };

  const loadActivity=async()=>{
    try{surface.activity={items:(await api(`/api/appointments/${id}/activity`)).items||[],failed:false};}
    catch{surface.activity={items:null,failed:true};}
    if(!stale())drawActivity();
  };

  const loadClient=async()=>{
    surface.client={loaded:false,failed:false};
    clientSummaryRail=null;
    drawRail();
    try{
      const [data,notes,agreements]=await Promise.all([
        api(`/api/customers/${surface.item.customerId}/history`),
        loadClientNotes(surface.item.customerId),loadClientAgreements(surface.item.customerId)]);
      if(stale())return;
      const customerId=surface.item.customerId;
      const previous=state.clientProfile?.data.customer.id===customerId?state.clientProfile:null;
      state.clientProfile={data,notes,agreements,notesExpanded:previous?.notesExpanded||false,
        tab:previous?.tab||"pets",
        // The appointment's own pet is preselected: this rail is context for THIS visit, so
        // opening the pet profile or booking again starts from the pet that was groomed. The
        // Pets panel lists every pet without marking one, so this is not a visible selection.
        petId:surface.item.petId||data.pets[0]?.id||null,appointmentId:id,
        historyView:{page:1,pageSize:HISTORY_INITIAL_ROWS},historyLoading:false};
      state.pets=[...state.pets.filter(pet=>pet.customerId!==customerId),...data.pets];
      surface.client.loaded=true;
      // Registered only once there is a client to draw, so an unrelated renderClientProfile()
      // while the fetch is in flight cannot write somebody else's record into this rail.
      clientSummaryRail={host:()=>$("#appointment-detail .surface-rail-body"),returnView};
    }catch{surface.client.failed=true;}
    if(!stale())drawRail();
  };

  const reload=async()=>{
    if(stale())return;
    const next=calendarAppointmentById(id)||await api(`/api/appointments/${id}`).catch(()=>null);
    if(stale())return;
    if(next)surface.item=next;
    surface.model=appointmentPresentation(surface.item);
    draw();
    await loadActivity();
  };

  // The shared #modal now opens ON TOP of this surface instead of replacing it, which is what
  // removed the close-then-reopen dance the old detail needed and stopped the operator losing the
  // appointment behind the dialog they opened from it. When it closes, the surface redraws from
  // whatever the server did.
  const throughModal=start=>{
    start();
    $("#modal").addEventListener("close",()=>runDetached(reload),{once:true});
  };

  const bind=()=>{
    const on=(testid,handler)=>dialog.querySelector(`[data-testid="${testid}"]`)?.addEventListener("click",handler);
    dialog.querySelector("[data-surface-close]")?.addEventListener("click",()=>runDetached(()=>popStackLevel()));
    const rail=dialog.querySelector(".surface-rail");
    rail?.addEventListener("toggle",()=>{appointmentRailOpen=rail.open;});
    // The lock note's Open Settings pointer is bound here rather than through
    // bindAppointmentLockNote(), which dismisses #modal - not the dialog this surface stands in.
    // Leaving for Settings is navigation away from the visit, so the stack comes down first,
    // exactly as Book Again does.
    dialog.querySelectorAll("[data-appointment-lock-settings]").forEach(button=>
      button.addEventListener("click",()=>runDetached(async()=>{
        if(await closeAppointmentStack()===false)return;
        await showView("admin-settings");
        renderSettingsCategory("business",{history:"push"});
      })));
    on("appointment-close",()=>runDetached(()=>popStackLevel()));
    on("appointment-print",()=>printAppointment(surface.item));
    on("appointment-groomer-edit",()=>throughModal(()=>moveAppointment(id)));
    on("appointment-adjust-services",()=>throughModal(()=>adjustServices(id)));
    // Check Out is level 2 of the stack now, not a modal over this one, so it is pushed rather
    // than opened through #modal. Guarded by the same key the calendar's own Checkout uses: two
    // concurrent renders of that screen is the failure advanceAppointment() documents.
    on("appointment-take-payment",()=>runDetached(()=>runOnce(`checkout:${id}`,()=>checkout(id))));
    // Level 3, pushed the same way and guarded the same way: `openTicket` awaits its two note
    // reads after it pushes, and a second press inside that window would render and bind the
    // surface twice. Both entry points share the one key, so the header icon and the footer
    // button cannot open two.
    const ticketLevel=()=>runDetached(()=>runOnce(`ticket:${id}`,()=>openTicket(surface.item)));
    on("appointment-ticket",ticketLevel);
    on("appointment-ticket-print",ticketLevel);
    // Booking is navigation away from this visit, so the stack comes down first rather than
    // leaving a stale appointment standing behind the booking workspace.
    on("appointment-book-again",()=>runDetached(async()=>{
      if(await closeAppointmentStack()===false)return;
      state.calendar.bookingCustomerId=surface.item.customerId;
      state.calendar.bookingPetId=surface.item.petId;
      actions["new-appointment"]();
    }));
    for(const [testid,status] of [["appointment-cancel","cancelled"],["appointment-no-show","no_show"]]){
      // terminalAppointment() confirms, reports its own outcome and refreshes the calendar. The
      // surface is redrawn from what came back rather than from what was asked for: a refusal
      // leaves the appointment exactly as it was, and the redraw says so.
      on(testid,()=>runDetached(async()=>{await terminalAppointment(id,status);await reload();}));
    }
    bindRecordNote();
    // The FOOTER Save writes the SERVICE note and only the service note. The appointment note has
    // its own Save inside its own block, because this one is not drawn at all outside the check-in
    // window while the appointment note is editable in every status.
    const save=dialog.querySelector('[data-testid="appointment-save"]');
    save?.addEventListener("click",()=>runDetached(async()=>{
      const field=dialog.querySelector('[data-testid="appointment-note-input"]');
      if(!field)return;
      save.disabled=true;
      try{
        const updated=await api(`/api/appointments/${id}/operations`,{method:"PATCH",
          body:JSON.stringify({operationalNotes:field.value.trim()||null,version:surface.item.version})});
        surface.item.version=updated.version;
        toast("Service note saved");
        await refresh();
        await reload();
      }catch(error){toast(error.message);if(save.isConnected)save.disabled=false;}
    }));
  };

  const draw=()=>{
    surface.permissions=derive();
    dialog.innerHTML=appointmentSurfaceMarkup(surface);
    bind();
    // After bind(), so a redraw restores the disclosure the operator left rather than snapping it
    // back to the breakpoint default every time the surface refreshes.
    syncAppointmentRail();
    drawRail();
    drawPhotos();
    drawCards();
  };

  draw();
  if(replacing){
    // Same element, same level, redrawn in place. The history depth does not move, so Back still
    // dismisses one surface, and `restoreFocus` stays the control that opened the first of them:
    // the row that opened this replacement is inside the surface being replaced.
    globalThis.history.replaceState(appointmentStackState(),"",location.pathname);
  }else{
    pushStackLevel(level);
  }

  // Everything below the header loads after the surface is on screen and in parallel. It is all
  // supporting detail, and blocking the surface on it would make opening an appointment slower
  // for the common case where nobody looks at any of it.
  await Promise.all([
    loadClient(),
    (async()=>{
      const [activityResult,photoResult,cardResult]=await Promise.allSettled([
        api(`/api/appointments/${id}/activity`),
        api(`/api/appointments/${id}/photos`),
        api(`/api/appointments/${id}/report-cards`)
      ]);
      if(activityResult.status==="fulfilled")surface.activity.items=activityResult.value.items||[];
      else surface.activity.failed=true;
      if(photoResult.status==="fulfilled")surface.photos.data=photoResult.value;
      else surface.photos.failed=true;
      if(cardResult.status==="fulfilled")surface.cards.data=cardResult.value;
      else surface.cards.failed=true;
      // The surface may have been replaced by another appointment while these were in flight.
      // Writing into it then would put one appointment's photos under another's header.
      if(stale())return;
      drawActivity();
      drawPhotos();
      drawCards();
    })()
  ]);
}

/* ---------------------------------------------------------------------------
   The Ticket: level 3 of the appointment stack.

   A TICKET IS A PRINTABLE WORK SHEET AND IT CARRIES NO MONEY. Not a price, not a total, not a
   tax line, not a payment, not a balance, and not an invoice status. It is the sheet the groomer
   works from: who the pet is, who is grooming it, what was booked, how long each service takes,
   and the three notes anybody handling this visit needs to have read.

   THE RECEIPT IS A DIFFERENT DOCUMENT AND IT LIVES IN CHECK OUT. The Ticket never reads
   `GET /api/invoices/:id/receipt`, never calls `receiptBodyMarkup`, and has no money states to
   be in - so it needs no `payments.view` gate either. A work sheet discloses nothing financial,
   which means every operator who can open the appointment sees exactly the same sheet, and there
   is no withheld-money footnote because there is nothing being withheld.

   AND IT IS NOT GATED ON COMPLETION. The sheet is most useful BEFORE the visit - it is what gets
   printed and clipped to the run - so a scheduled appointment has one exactly as a finished one
   does.
   --------------------------------------------------------------------------- */

/**
 * The salon's own identity, for the head of the sheet.
 *
 * THE SESSION'S ACTIVE LOCATION, from `state.me.business`, which `GET /api/me` returns whole -
 * name, phone, email and the active location's single free-text address line. The receipt
 * resolves its own header through the invoice's appointment's location instead, because a
 * receipt is a document about one visit and the address on it has to be a fact about that visit.
 * The Ticket has no invoice to resolve through and does not want one.
 */
function salonIdentity(){
  const business=state.me?.business;
  // Blank is the same absence as null here: a line is drawn only when there is something on it,
  // and a bare `Phone:` with nothing after it is never rendered.
  const line=value=>String(value??"").trim();
  return {name:line(business?.name),address:line(business?.address),
    phone:line(business?.phone),email:line(business?.email)};
}

// A cell with nothing in it. One character, so an absent note reads as a filled-in blank rather
// than as a row somebody forgot to complete.
const TICKET_EMPTY="-";
// A note thread that has not come back yet, and one that could not be read. Both are conventions
// this file already uses - the lifecycle strip shows "…" while the activity feed is in flight,
// and the activity disclosure says "unavailable" when it failed - so neither is a new vocabulary.
// "unavailable" is never collapsed into TICKET_EMPTY: "there is no note" and "the note could not
// be read" are different facts, and only one of them is safe to act on.
const TICKET_PENDING="…";
const TICKET_UNAVAILABLE="unavailable";

// A UUID is not a counter, so this is presented as a reference rather than an invented number.
// The same value the panel header carries and the sheet repeats under it.
function ticketReference(item){return String(item.id).slice(0,8);}

/**
 * A duration the way the sheet writes it: `2 h`, `30 m`, `1 h 30 m`.
 *
 * NOT `lifecycleDurationLabel`, which writes "30 min" and exists to describe a MEASURED elapsed
 * time that may not have been recorded at all. These are booked service durations: they are
 * always present, they are read down a narrow table column, and the sheet is scanned rather than
 * read, so the shorter form is the one that belongs here.
 */
function ticketDurationLabel(minutes){
  const total=Math.max(0,Math.round(Number(minutes)||0));
  const hours=Math.floor(total/60),rest=total%60;
  if(!hours)return `${rest} m`;
  return rest?`${hours} h ${rest} m`:`${hours} h`;
}

/**
 * The latest entry in one note thread, out of a settled read.
 *
 * SORTED BY `createdAt` HERE RATHER THAN TRUSTED FROM THE SERVER. Both note endpoints order
 * `pinned desc, created_at desc`, so their first row is the newest PINNED note whenever one
 * exists - which is the right order for a thread and the wrong answer for a column headed
 * "Latest Note". The sort is over one bounded page and settles the question here.
 */
function ticketLatestNote(settled){
  if(settled.status!=="fulfilled")return {failed:true,body:""};
  const items=[...(settled.value?.items||[])]
    .sort((first,second)=>new Date(second.createdAt)-new Date(first.createdAt));
  return {failed:false,body:String(items[0]?.body??"").trim()};
}

// Null while the read is in flight; `{failed}` or `{body}` once it has settled.
function ticketNoteCell(thread){
  if(!thread)return TICKET_PENDING;
  if(thread.failed)return TICKET_UNAVAILABLE;
  return thread.body||TICKET_EMPTY;
}

// Label and value on one line, the label carrying the weight. An absent line is not drawn.
function ticketSalonMarkup(salon){
  const line=(label,value)=>value
    ? `<p class="ticket-salon-line"><span>${escape(label)}:</span> ${escape(value)}</p>`
    : "";
  return `<div class="ticket-salon" data-testid="ticket-salon">`
    +`<p class="ticket-business">${escape(salon.name)}</p>`
    +line("Phone",salon.phone)+line("Email",salon.email)+line("Address",salon.address)
  +`</div>`;
}

// The visit's own two facts, opposite the salon block. The date is the APPOINTMENT'S date in the
// appointment's own scheduling zone, laid out by the workspace's date preference - the same
// formatter the rest of the product reads dates through.
function ticketVisitMarkup(item,model){
  const zone=item.schedulingTimezone||schedulingZone();
  return `<div class="ticket-visit">`
    +`<p data-testid="ticket-date"><span>Date:</span> ${escape(formatPrefDate(new Date(item.startAt),zone))}</p>`
    +`<p data-testid="ticket-client"><span>Client:</span> ${escape(model.customerName)}</p>`
  +`</div>`;
}

/**
 * What was booked, ONE ROW PER PET-SERVICE PAIR.
 *
 * A visit with two services on one pet is two rows that repeat the pet, the breed and the
 * groomer. That repetition is deliberate: the sheet is scanned a line at a time by somebody with
 * a dog in front of them, and a row that inherits its pet from the row above is a row that reads
 * wrong the moment it is the only one anybody looks at.
 *
 * NO PRICE COLUMN AND NO TOTAL ROW. A Pawsh appointment has one pet and a set of groomers
 * assigned to the whole visit rather than one per service, so the Groomer cell is the visit's
 * primary groomer on every row.
 */
function ticketServicesMarkup(model){
  const pet=petName({petName:model.petName});
  const breed=model.breed||TICKET_EMPTY;
  const groomer=model.groomer||TICKET_EMPTY;
  const rows=model.serviceSnapshots.map(service=>
    `<tr data-testid="ticket-service-row">`
      +`<td>${escape(pet)}</td><td>${escape(breed)}</td><td>${escape(groomer)}</td>`
      +`<td>${escape(service.name)}</td>`
      +`<td>${escape(ticketDurationLabel(service.durationMinutes))}</td>`
    +`</tr>`).join("")
    ||`<tr><td colspan="5" class="ticket-table-empty">No services on this appointment.</td></tr>`;
  return `<section class="ticket-section"><h3>Services</h3>`
    +`<div class="ticket-table-wrap"><table class="ticket-table" data-testid="ticket-services">`
      +`<thead><tr><th>Pet</th><th>Breed</th><th>Groomer</th><th>Service</th><th>Duration</th></tr></thead>`
      +`<tbody>${rows}</tbody></table></div>`
  +`</section>`;
}

/**
 * Three notes, always three rows.
 *
 * The pet's and the client's are the newest entry in each note thread; the third is the
 * appointment's own note, read straight off the live projection - so a correction saved on the
 * appointment surface is on the next sheet printed without anything here changing.
 *
 * STILL NEVER A TEXTAREA, but no longer for want of a route. `PATCH /api/appointments/:id` will
 * now write the appointment note and the appointment surface offers it; the Ticket declines it
 * because THE TICKET IS A DOCUMENT. It is the sheet that gets printed and clipped to the run, and
 * a document that could be edited from the page it is printed from is a document nobody can trust
 * they are holding a copy of. The note threads have no writer here for the same reason.
 *
 * THE ROWS ARE PRESENT EVEN WHEN EMPTY. "Nobody has written a note about this pet" is a fact the
 * groomer needs, and a table that silently drops the row leaves them unable to tell it from a
 * sheet that never had the row at all.
 */
function ticketNotesMarkup(item,model,notes){
  const row=(testid,label,value)=>
    `<tr data-testid="${testid}"><td>${escape(label)}</td><td>${escape(value)}</td></tr>`;
  return `<section class="ticket-section"><h3>Notes</h3>`
    +`<div class="ticket-table-wrap">`
      +`<table class="ticket-table ticket-notes-table" data-testid="ticket-notes">`
      +`<thead><tr><th>Item</th><th>Latest Note</th></tr></thead><tbody>`
      +row("ticket-note-pet",`${petName({petName:model.petName})} (Pet)`,ticketNoteCell(notes.pet))
      +row("ticket-note-client",`${model.customerName} (Client)`,ticketNoteCell(notes.client))
      +row("ticket-note-appointment","Appointment note",item.notes||TICKET_EMPTY)
    +`</tbody></table></div>`
  +`</section>`;
}

/**
 * The sheet itself - the thing that is on screen and the thing that goes on paper.
 *
 * ONE MARKUP FUNCTION, TWO HOSTS. The print root is not a second renderer, so whatever state the
 * note reads are in prints in that state; there is no print-only variant of anything here.
 */
function ticketDocumentMarkup(item,notes){
  const model=appointmentPresentation(item);
  return `<article class="ticket-doc" data-testid="ticket-document">`
    +`<p class="ticket-doc-reference" data-testid="ticket-appointment-reference">`
      +`Appointment #: ${escape(ticketReference(item))}</p>`
    +`<div class="ticket-doc-head">`
      +ticketSalonMarkup(salonIdentity())
      +ticketVisitMarkup(item,model)
    +`</div>`
    +ticketServicesMarkup(model)
    +ticketNotesMarkup(item,model,notes)
  +`</article>`;
}

/**
 * A thin bar, the sheet, and one button.
 *
 * The panel header carries the reference and nothing else, and it IS the `<h2>` the dialog is
 * labelled by, so the surface's accessible name is "Ticket #: 4f2c1a90" rather than a bare string
 * of hex. No status chip, no billing chip, no date subhead: everything the sheet says, it says on
 * the sheet.
 */
function ticketSurfaceMarkup(item,notes){
  return `<div class="surface-shell" data-testid="ticket">`
    +`<header class="surface-head ticket-head">`
      +`<h2 id="appointment-ticket-title" data-testid="ticket-reference">`
        +`Ticket #: ${escape(ticketReference(item))}</h2>`
      +`<button type="button" class="surface-close" data-surface-close aria-label="Close ticket">&#215;</button>`
    +`</header>`
    +`<div class="surface-body ticket-body">${ticketDocumentMarkup(item,notes)}</div>`
    +`<footer class="surface-foot ticket-foot"><div class="surface-foot-actions">`
      +`<button type="button" class="primary compact" data-testid="ticket-print">Print</button>`
    +`</div></footer>`
  +`</div>`;
}

/**
 * The sheet on paper.
 *
 * Printing is the one mechanism the product has: a `.print-root` appended to <body>, which the
 * print stylesheet is the only thing that shows. NO PREPENDED <h1> - `printAppointment` prepends
 * one because its body carries no title of its own, and this one opens on the appointment
 * reference and the salon's name.
 */
function printTicket(item,notes){
  const root=document.createElement("section");
  root.className="print-root print-ticket";
  root.innerHTML=ticketDocumentMarkup(item,notes);
  document.body.append(root);
  globalThis.print();
  setTimeout(()=>root.remove(),1000);
}

/**
 * Opens the Ticket. Level 3 of the appointment stack.
 *
 * It opens IMMEDIATELY: the salon block, the visit line and the whole Services table are composed
 * from data already in memory, so the only thing that arrives late is two note cells, and they
 * arrive underneath a sheet that is already on screen rather than delaying it.
 *
 * NO `guard`: nothing here is unsaved, and a confirm on the way out would be furniture that
 * trains the operator to dismiss confirms unread. NO refresh and NO reload of the level beneath
 * either, because the Ticket writes nothing at all.
 */
async function openTicket(item){
  const dialog=$("#appointment-ticket");
  const source=document.activeElement;
  const ticket={item,notes:{pet:null,client:null}};
  const level={id:"appointment-ticket",dialog,restoreFocus:source};

  /**
   * Where focus goes after a redraw.
   *
   * The Ticket is ONE DOCUMENT and redraws whole, unlike the detail surface, which redraws only
   * the region that changed precisely so this question never arises. Replacing the dialog's
   * markup detaches whatever was focused, and focus on a detached node falls to <body> - which
   * strands a keyboard inside a modal that is still on screen. Every redraw here therefore puts
   * focus back: on the same control when the new markup still has it, and otherwise on the close
   * button, which is where every level in this stack opens.
   */
  const focusAfterDraw=()=>{
    const active=document.activeElement;
    if(!active||!dialog.contains(active))return null;
    return active.dataset?.testid?`[data-testid="${active.dataset.testid}"]`:"[data-surface-close]";
  };

  const draw=()=>{
    const wanted=focusAfterDraw();
    dialog.innerHTML=ticketSurfaceMarkup(ticket.item,ticket.notes);
    bind();
    if(wanted)(dialog.querySelector(wanted)||dialog.querySelector("[data-surface-close]"))?.focus();
  };

  /**
   * The two note threads.
   *
   * `allSettled`, so one thread the operator may not read - `pets.view` and `customers.view` are
   * separate permissions - costs that one cell and not the other, and never the sheet. Neither
   * read is retried from a button: a work sheet is printed and carried away, and a Retry beside
   * one table cell is more machinery than the cell is worth.
   */
  const load=async()=>{
    const [pet,client]=await Promise.allSettled([
      ticket.item.petId
        ? api(`/api/pets/${ticket.item.petId}/notes`)
        : Promise.resolve({items:[]}),
      ticket.item.customerId
        ? api(`/api/customers/${ticket.item.customerId}/notes?page=1&pageSize=${CLIENT_NOTE_PAGE_SIZE}`)
        : Promise.resolve({items:[]})
    ]);
    ticket.notes={pet:ticketLatestNote(pet),client:ticketLatestNote(client)};
    if(!appointmentStack.levels.includes(level))return;
    draw();
  };

  const bind=()=>{
    dialog.querySelector("[data-surface-close]")?.addEventListener("click",()=>runDetached(()=>popStackLevel()));
    dialog.querySelector('[data-testid="ticket-print"]')
      ?.addEventListener("click",()=>printTicket(ticket.item,ticket.notes));
  };

  draw();
  pushStackLevel(level);
  await load();
}

function renderMessages(){const query=($("#message-search")?.value||"").trim().toLowerCase(),clients=state.customerDirectory.items.filter(item=>`${clientName(item)} ${item.phone||""} ${item.email||""}`.toLowerCase().includes(query));$("#message-client-list").innerHTML=clients.map(item=>`<button type="button" class="message-client ${item.id===state.messageClientId?"active":""}" data-message-client="${item.id}"><span><strong>${escape(clientName(item))}</strong><small>${escape(item.phone||item.email||"No contact details")}</small></span></button>`).join("")||`<p class="empty">No clients match.</p>`;$$('[data-message-client]').forEach(button=>button.addEventListener("click",()=>selectMessageClient(button.dataset.messageClient)));}
async function selectMessageClient(id){
  const [data,notes,agreements]=await Promise.all([
    api(`/api/customers/${id}/history`),loadClientNotes(id),loadClientAgreements(id)]);
  const previous=state.clientProfile?.data.customer.id===id?state.clientProfile:null;
  state.messageClientId=id;
  state.clientProfile={data,notes,agreements,notesExpanded:previous?.notesExpanded||false,
    tab:previous?.tab||"pets",petId:previous?.petId||data.pets[0]?.id||null,appointmentId:null,
    historyView:{page:1,pageSize:HISTORY_INITIAL_ROWS},historyLoading:false};
  state.pets=[...state.pets.filter(pet=>pet.customerId!==id),...data.pets];
  renderMessages();
  const name=clientName(data.customer);
  $("#message-thread").innerHTML=`<header><a class="message-client-link" href="/clients/${id}" target="_blank" rel="noopener">${escape(name)}</a></header><div class="message-disabled-state"><h3>Messaging is not connected</h3><p>No conversation history, inbound webhook, SMS provider, delivery status, or scheduler is configured.</p></div><footer><textarea disabled aria-label="Message composer" placeholder="Messaging unavailable"></textarea><button type="button" class="primary" disabled>Send</button></footer>`;
  renderClientSummaryPane();
}
const reminderTabs=[["appointment_reminder","Appointment Reminder","supported"],["secondary_reminder","Secondary Reminder","deferred"],["same_day_reminder","Same-Day Reminder","deferred"],["rebook_reminder","Rebook Reminder","deferred"],["vaccination_reminder","Vaccination Reminder","supported"],["birthday_reminder","Pet Birthday Reminder","deferred"]];
async function loadReminders(type=state.reminders.type){state.reminders.type=type;const result=await api(`/api/reminders?type=${encodeURIComponent(type)}`);state.reminders={type,items:result.items,supported:result.supported};renderReminders();}
function renderReminders(){const {type,items,supported}=state.reminders;$("#reminder-tabs").innerHTML=reminderTabs.map(([id,label])=>`<button type="button" role="tab" data-reminder-tab="${id}" aria-selected="${id===type}">${escape(label)}</button>`).join("");$$('[data-reminder-tab]').forEach(button=>button.addEventListener("click",()=>loadReminders(button.dataset.reminderTab)));if(!supported){$("#reminder-content").innerHTML=`<div class="reminder-empty"><p class="eyebrow">Deferred</p><h3>${escape(reminderTabs.find(([id])=>id===type)?.[1]||"Reminder")}</h3><p>This reminder type has no Pawsh scheduling or delivery backend yet. No records or actions are fabricated.</p></div>`;return;}$("#reminder-content").innerHTML=`<div class="reminder-table-wrap"><table class="reminder-table"><thead><tr><th>Record ID</th><th>Status</th><th>Time</th><th>Client</th><th>Reminder Status</th><th>Action</th><th>Logs</th></tr></thead><tbody>${items.map(item=>`<tr><td><code>${escape(String(item.appointmentId||item.id).slice(0,8))}</code></td><td><span class="status-dot">${escape(item.appointmentStatus||"Scheduled")}</span></td><td>${escape(formatPrefDateAndTime(new Date(item.scheduledOccurrence)))}</td><td>${escape([item.firstName,item.lastName].filter(Boolean).join(" ")||"Staff notification")}</td><td><span class="badge ${escape(item.reminderStatus)}">${escape(item.reminderStatus.replace("_"," "))}</span></td><td>${["pending","failed"].includes(item.reminderStatus)&&allowed("appointments.edit")?`<button type="button" class="secondary compact reminder-send" data-reminder-id="${item.id}">${item.reminderStatus==="failed"?"Retry":"Send"}</button>`:"—"}</td><td><button type="button" class="icon-action reminder-logs" data-reminder-id="${item.id}" aria-label="Show reminder logs" aria-expanded="false">+</button></td></tr><tr class="reminder-log-row" data-reminder-logs="${item.id}" hidden><td colspan="7">${item.logs.length?item.logs.map(log=>`<div class="reminder-log"><time>${escape(formatPrefDateAndTime(new Date(log.createdAt)))}</time><span>${escape(item.channel)} · ${escape(item.destination)}</span><strong>${escape(log.outcome)}</strong>${log.safeFailureReason?`<small>${escape(log.safeFailureReason)}</small>`:""}</div>`).join(""):`<span class="empty">No delivery attempts yet.</span>`}</td></tr>`).join("")||`<tr><td colspan="7" class="empty">No reminders in this workspace.</td></tr>`}</tbody></table></div>`;$$('.reminder-logs').forEach(button=>button.addEventListener("click",()=>{const row=$(`[data-reminder-logs="${button.dataset.reminderId}"]`),open=row.hidden;row.hidden=!open;button.textContent=open?"−":"+";button.setAttribute("aria-expanded",String(open));}));$$('.reminder-send').forEach(button=>button.addEventListener("click",async()=>{button.disabled=true;try{await api(`/api/reminders/${button.dataset.reminderId}/send`,{method:"POST"});toast("Reminder queued for delivery");await loadReminders();}catch(error){toast(error.message);button.disabled=false;}}));}
async function hydrateReminderLogs(button){try{const detail=await api(`/api/reminders/${button.dataset.reminderId}/logs`),row=$(`[data-reminder-logs="${button.dataset.reminderId}"] td`);if(!row)return;row.innerHTML=detail.logs.length?detail.logs.map(log=>`<div class="reminder-log"><time>${escape(formatPrefDateAndTime(new Date(log.createdAt)))}</time><span>${escape(detail.channel)} · ${escape(detail.destination)}</span><strong>${escape(log.attemptKind)} · ${escape(log.outcome)}</strong>${log.safeFailureReason?`<small>${escape(log.safeFailureReason)}</small>`:""}</div>`).join(""):`<span class="empty">No delivery attempts yet.</span>`;}catch(error){toast(error.message);}}
document.addEventListener("click",event=>{const button=event.target.closest?.(".reminder-logs");if(button)hydrateReminderLogs(button);},{capture:true});
document.addEventListener("click",event=>{const button=event.target.closest?.("[data-pet-profile]");if(!button)return;event.stopImmediatePropagation();const petId=button.dataset.petProfile;state.clientProfile.petId=petId;state.clientProfile.appointmentId=null;renderClientProfile();api(`/api/pets/${petId}`).then(pet=>{state.clientProfile.data.pets=state.clientProfile.data.pets.map(item=>item.id===petId?pet:item);openPetProfile(petId);}).catch(error=>toast(error.message));},{capture:true});
$$('[data-action]').forEach((button) => button.addEventListener("click", () => actions[button.dataset.action]?.()));
$("#service-search")?.addEventListener("input",renderServices);$("#service-category-filter")?.addEventListener("change",renderServices);$("#service-status-filter")?.addEventListener("change",renderServices);$("#service-filter-reset")?.addEventListener("click",()=>{$("#service-search").value="";$("#service-category-filter").value="all";$("#service-status-filter").value="active";renderServices();});
$("#message-search")?.addEventListener("input",renderMessages);
$("#report-charts-mode")?.addEventListener("click",()=>{state.reportMode="charts";renderReports();});
$("#report-table-mode")?.addEventListener("click",()=>{state.reportMode="table";renderReports();});
$("#report-apply")?.addEventListener("click",async()=>{state.reports=await api(`/api/reports?${reportQuery()}`);renderReports();});
const viewPaths={dashboard:"/",calendar:"/",customers:"/",messages:"/",reminders:"/","sales-expense":"/",product:"/",services:"/",setup:"/","admin-settings":"/settings",reports:"/","profile-account":"/account","intake-submissions":"/intake-submissions","client-profile":"/clients"};
// The breed catalog used to be a standalone Salon page. Its URLs still resolve, but they now
// deep-link into Settings -> Pet Options -> Pet Type -> Breeds, which is the one place breeds
// are managed. Keeping the routes costs a set lookup and keeps existing links and bookmarks
// working; keeping the page would have meant two catalogs to hold in sync.
const legacyBreedPaths=new Set(["/salon/breeds","/reports/breeds","/overview/breeds"]);
function viewForPath(path){if(path==="/account")return "profile-account";if(path==="/intake-submissions")return "intake-submissions";if(path.startsWith("/clients/"))return "client-profile";if(path==="/settings"||path.startsWith("/settings/"))return "admin-settings";return legacyBreedPaths.has(path)?"admin-settings":"dashboard";}
function closeSetupMenus(){$$(".setup-menu[open]").forEach(menu=>menu.open=false);}
$$("nav [data-view]").forEach((button) => button.addEventListener("click", () => {$("#primary-navigation").classList.remove("mobile-open");$("#mobile-nav-toggle").setAttribute("aria-expanded","false");$("#mobile-nav-toggle").setAttribute("aria-label","Open navigation");showView(button.dataset.view);}));
$("#mobile-nav-toggle").addEventListener("click",event=>{const open=$("#primary-navigation").classList.toggle("mobile-open");event.currentTarget.setAttribute("aria-expanded",String(open));event.currentTarget.setAttribute("aria-label",open?"Close navigation":"Open navigation");});
$$("[data-view-target]").forEach((button) => button.addEventListener("click", () => {closeAccountMenu();closeSetupMenus();showView(button.dataset.viewTarget);}));
$$("[data-view-link]").forEach(link=>link.addEventListener("click",event=>{event.preventDefault();closeSetupMenus();showView(link.dataset.viewLink);}));
$$(".setup-menu").forEach(menu=>{const summary=menu.querySelector("summary");menu.addEventListener("toggle",()=>summary.setAttribute("aria-expanded",String(menu.open)));menu.addEventListener("keydown",event=>{if(event.key==="Escape"&&menu.open){event.preventDefault();menu.open=false;summary.focus();}});});
document.addEventListener("click",event=>$$(".setup-menu[open]").forEach(menu=>{if(!menu.contains(event.target))menu.open=false;}));
// The appointment stack owns its own history entries, so Back dismisses one surface rather than
// navigating the view underneath it. Only a genuine view navigation reaches the router.
globalThis.addEventListener("popstate",event=>{
  if(reconcileAppointmentStack(event.state))return;
  showView(viewForPath(location.pathname),{history:"none"});
});
async function showView(view,{history="push"}={}) {
  if(!activateView(view,{history}))return;
  try{
    state.me=await api("/api/me");applyPermissions();renderLocationSwitcher();
    if(view==="calendar")await openCalendarView();
    if(view==="customers")await loadCustomerDirectory(state.customerDirectory.page||1);
    if(view==="messages")renderMessages();
    if(view==="reminders")await loadReminders();
    if(view==="client-profile"){const customerId=location.pathname.match(/^\/clients\/([^/]+)$/)?.[1];if(customerId&&!state.clientProfile)await openClientProfile(customerId);else renderClientProfile();}
    if(view==="profile-account")renderAccountIdentity();
    if(view==="admin-settings")openSettingsForPath({history:history==="none"?"none":"replace"});
    if($(`[data-view="${view}"]`)?.hidden){
      activateView("dashboard",{history:"replace"});
    }
  }catch{return bootstrap();}
}
function activateView(view,{history="push"}={}) {
  closeCalendarMenus();
  const target=$(`#${view}`);if(!target||$(`[data-view="${view}"]`)?.hidden)return;
  const canonicalPath=view==="client-profile"&&state.clientProfile?`/clients/${state.clientProfile.data.customer.id}`:viewPaths[view];if(canonicalPath&&history!=="none"&&view!=="admin-settings"&&location.pathname!==canonicalPath){globalThis.history[history==="replace"?"replaceState":"pushState"]({view},"",canonicalPath);}
  $$(".view").forEach(v=>v.hidden=v.id!==view); $$("nav button").forEach(b=>{const active=b.dataset.view===view;b.classList.toggle("active",active);if(active)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current");});const servicesHeader=$("[data-testid=header-services]");servicesHeader?.classList.toggle("active",view==="services");if(view==="services")servicesHeader?.setAttribute("aria-current","page");else servicesHeader?.removeAttribute("aria-current"); $("#page-kicker").textContent=view==="profile-account"?"Your account":view==="admin-settings"?"Administration":"Daily operations"; $("#page-title").textContent={dashboard:"Dashboard",calendar:"Calendar",customers:"Clients",messages:"Messages",reminders:"Reminders","sales-expense":"Sales & Expense",product:"Product",services:"Services",setup:"Salon","admin-settings":"Settings",reports:"Report","profile-account":"Profile & Account"}[view];
  // The active view is published on the body so density can be set per screen in CSS.
  document.body.dataset.view=view;
  if(view==="client-profile"){$("#page-title").textContent="Client Profile";$("#page-kicker").textContent="Relationships";}
  if(view==="intake-submissions"){$("#page-title").textContent="Intake Form Submissions";$("#page-kicker").textContent="Client intake";}
  return true;
}
$$(".close").forEach((button)=>button.addEventListener("click",()=>$("#modal").close()));
// `calendarDetailOrigin` is the notes dialog's focus return. The appointment surface no longer
// uses the shared dialog at all: it carries its own `restoreFocus` on its stack level, and a
// #modal opened from inside it must not pull focus back out to the calendar behind.
$("#modal").addEventListener("close",()=>{const dialog=$("#modal");dialog.querySelector(".modal-head .close").setAttribute("aria-label","Close");if(calendarDetailOrigin?.isConnected)calendarDetailOrigin.focus();calendarDetailOrigin=null;});
$("#archived-care-records")?.addEventListener("click",showArchivedCareRecords);
$("#customer-search").addEventListener("input", async ()=>{
  const sequence=++customerSearchSequence;
  await new Promise(resolve=>setTimeout(resolve,180));if(sequence!==customerSearchSequence)return;
  const customers=await api(`/api/customers?${customerDirectoryParams(1)}`);
  if(sequence!==customerSearchSequence)return;
  state.customerDirectory=customers;state.customers=customers.items;renderCustomersEnhanced();
});
[$("#customer-status"),$("#customer-upcoming"),$("#customer-sort"),$("#customer-page-size")].forEach(control=>control.addEventListener("change",()=>loadCustomerDirectory(1)));
$("#customer-prev").addEventListener("click",()=>loadCustomerDirectory(state.customerDirectory.page-1));$("#customer-next").addEventListener("click",()=>loadCustomerDirectory(state.customerDirectory.page+1));
function printRangeDefaults(){if(state.calendar.view==="day"||state.calendar.view==="month")return [state.calendar.selectedDate,state.calendar.selectedDate];return [state.calendar.weekStart,dateShift(state.calendar.weekStart,6)];}
function printableAgenda(items){const sorted=items.slice().sort((a,b)=>new Date(a.startAt)-new Date(b.startAt));return sorted.length?sorted.map(item=>{const model=appointmentPresentation(item);return `<article class="print-appointment"><header><strong>${escape(model.groomer)}</strong><span>${escape(model.dateLabel)} · ${escape(model.timeRange)}</span></header><div><p><b>Pet:</b> ${escape(petName({petName:model.petName}))}${model.breed?` · ${escape(model.breed)}`:""}</p><p><b>Services:</b> ${model.services.map(escape).join(", ")}</p><p><b>Client:</b> ${escape(model.customerName)}${item.customerPhone?` · ${escape(item.customerPhone)}`:""}</p>${item.notes?`<p><b>Appointment note:</b> ${escape(item.notes)}</p>`:""}</div></article>`;}).join(""):`<p>No appointments in this print range.</p>`;}
async function printAgendaItems(form){const start=String(form.get("printStart")),end=String(form.get("printEnd")),days=Math.round((dateAt(end)-dateAt(start))/86400000)+1;if(!start||!end||days<1||days>31)throw new Error("Choose a print range from 1 to 31 days.");const groomerId=String(form.get("printGroomer")||""),items=filteredAppointments(await loadAppointmentRange(start,days));return groomerId?items.filter(item=>(item.groomers||[]).some(groomer=>groomer.id===groomerId)):items;}
async function openPrintAgenda(){const [start,end]=printRangeDefaults(),groomers=selectedGroomers();openModal("Print agenda",`<div class="wide print-controls"><label>From<input type="date" name="printStart" value="${start}" required></label><label>To<input type="date" name="printEnd" value="${end}" required></label><label>Groomer<select name="printGroomer"><option value="">All selected groomers</option>${groomers.map(item=>`<option value="${item.id}">${escape(item.displayName)}</option>`).join("")}</select></label><button type="button" class="secondary compact" id="print-preview-update">Update preview</button></div><section id="print-agenda-preview" class="wide print-agenda-preview" aria-live="polite">Loading preview…</section>`,async form=>{const items=await printAgendaItems(form),printRoot=document.createElement("section");printRoot.className="print-root";printRoot.innerHTML=`<h1>Pawsh agenda</h1>${printableAgenda(items)}`;document.body.append(printRoot);globalThis.print();setTimeout(()=>printRoot.remove(),1000);},{cancelLabel:"Close",submitLabel:"Print"});const refreshPreview=async()=>{try{$("#print-agenda-preview").innerHTML=printableAgenda(await printAgendaItems(new FormData($("#modal-form"))));}catch(error){$("#modal-error").textContent=error.message;}};$("#print-preview-update").addEventListener("click",refreshPreview);await refreshPreview();}
function openCalendarSettings(){const preferences=calendarPreferences(),derived=state.businessHours.flatMap(period=>[String(period.startTime).slice(0,5),String(period.endTime).slice(0,5)]).map(value=>Number(value.slice(0,2))*60+Number(value.slice(3,5))),fallback=derived.length?[Math.min(...derived),Math.max(...derived)]:[480,1140],start=preferences.visibleStart??fallback[0],end=preferences.visibleEnd??fallback[1];openModal("Calendar settings",`<p class="wide settings-note">These preferences change only your calendar view. Salon business hours and booking rules remain unchanged.</p><label>Visible from<select name="visibleStart">${Array.from({length:33},(_,i)=>i*30+300).map(value=>`<option value="${value}" ${value===start?"selected":""}>${timeLabel(value)}</option>`).join("")}</select></label><label>Visible until<select name="visibleEnd">${Array.from({length:33},(_,i)=>i*30+480).map(value=>`<option value="${value}" ${value===end?"selected":""}>${timeLabel(value)}</option>`).join("")}</select></label><label>First day of week<select name="firstDay"><option value="sunday" ${preferences.firstDay==="sunday"?"selected":""}>Sunday</option><option value="monday" ${preferences.firstDay==="monday"?"selected":""}>Monday</option></select></label><label>Calendar density<select name="density"><option value="compact" ${preferences.density==="compact"?"selected":""}>Compact</option><option value="comfortable" ${preferences.density==="comfortable"?"selected":""}>Comfortable</option><option value="large" ${preferences.density==="large"?"selected":""}>Large</option></select></label><label class="wide">Appointment detail<select name="detail"><option value="compact" ${preferences.detail==="compact"?"selected":""}>Compact</option><option value="detailed" ${preferences.detail==="detailed"?"selected":""}>Detailed</option></select></label><button type="button" class="text-button wide" id="calendar-settings-reset">Reset to defaults</button>`,form=>{const next={visibleStart:Number(form.get("visibleStart")),visibleEnd:Number(form.get("visibleEnd")),firstDay:String(form.get("firstDay")),density:String(form.get("density")),detail:String(form.get("detail"))};if(next.visibleStart>=next.visibleEnd)throw new Error("Visible start must be before visible end.");state.calendar.preferences=next;globalThis.localStorage.setItem(calendarPreferenceKey(),JSON.stringify(next));state.calendar.weekStart=weekStart(state.calendar.selectedDate);applyCalendarPreferences();return ()=>loadCalendarWeek();},{cancelLabel:"Cancel",submitLabel:"Apply changes"});$("#calendar-settings-reset").addEventListener("click",()=>{globalThis.localStorage.removeItem(calendarPreferenceKey());state.calendar.preferences=null;$("#modal").close();applyCalendarPreferences();state.calendar.weekStart=weekStart(state.calendar.selectedDate);runDetached(loadCalendarWeek);});}
function applyCalendarPreferences(){const preferences=calendarPreferences(),shell=$("#calendar");shell.dataset.calendarDensity=preferences.density;shell.dataset.calendarDetail=preferences.detail;}
function calendarStep(direction){if(state.calendar.view==="day")return selectCalendarDate(dateShift(state.calendar.selectedDate,direction));if(state.calendar.view==="week")return selectCalendarDate(dateShift(state.calendar.weekStart,direction*7));const date=dateAt(`${state.calendar.month}-01`);date.setUTCMonth(date.getUTCMonth()+direction);state.calendar.month=date.toISOString().slice(0,7);state.calendar.selectedDate=`${state.calendar.month}-01`;state.calendar.weekStart=weekStart(state.calendar.selectedDate);return loadCalendarWeek();}
// The week grid scrolls horizontally once several groomers are shown, so selecting today is not
// enough on its own: today's column can sit thousands of pixels to the right of the viewport.
function revealCalendarDate(date){
  const scroll=$(".week-scroll");if(!scroll)return;
  const head=scroll.querySelector(`.week-day-head[data-calendar-date="${date}"]`);if(!head)return;
  const gutter=scroll.querySelector(".week-time")?.offsetWidth||0;
  scroll.scrollTo({left:Math.max(0,head.offsetLeft-gutter),behavior:"smooth"});
}
$("#calendar-today").addEventListener("click",()=>runDetached(async()=>{const date=businessDate();await selectCalendarDate(date);revealCalendarDate(date);}));$("#calendar-prev-week").addEventListener("click",()=>runDetached(()=>calendarStep(-1)));$("#calendar-next-week").addEventListener("click",()=>runDetached(()=>calendarStep(1)));
function updateCalendarViewControls(){$("#calendar-view-select").value=state.calendar.view;$("#calendar-agenda-mode").setAttribute("aria-pressed",String(state.calendar.displayMode==="agenda"));$("#calendar-calendar-mode").setAttribute("aria-pressed",String(state.calendar.displayMode==="calendar"));$("#calendar-view-control").hidden=state.calendar.displayMode!=="calendar";}
function setCalendarView(view){state.calendar.view=view;state.calendar.displayMode="calendar";updateCalendarViewControls();runDetached(loadCalendarWeek);}
$("#calendar-view-select").addEventListener("change",event=>setCalendarView(event.target.value));
$("[data-testid=print-agenda]").addEventListener("click",openPrintAgenda);$("[data-testid=calendar-settings]").addEventListener("click",openCalendarSettings);applyCalendarPreferences();
$("#calendar-agenda-mode").addEventListener("click",()=>{state.calendar.displayMode="agenda";updateCalendarViewControls();renderCalendar();});
$("#calendar-calendar-mode").addEventListener("click",()=>{state.calendar.displayMode="calendar";updateCalendarViewControls();renderCalendar();});
$("#groomer-filter").addEventListener("toggle",event=>{const open=event.currentTarget.open;$("#groomer-filter-trigger").setAttribute("aria-expanded",String(open));if(open){state.calendar.pendingGroomerIds=state.calendar.selectedGroomerIds===null?new Set(activeGroomers().map(item=>item.id)):new Set(state.calendar.selectedGroomerIds);renderGroomerFilter();}});
$("#groomer-select-all").addEventListener("click",()=>{$$("#groomer-filter-options input").forEach(input=>input.checked=true);});
$("#groomer-deselect-all").addEventListener("click",()=>{$$("#groomer-filter-options input").forEach(input=>input.checked=false);});
$("#groomer-filter-apply").addEventListener("click",()=>{const all=activeGroomers(),selected=new Set($$("#groomer-filter-options input:checked").map(input=>input.value));state.calendar.selectedGroomerIds=selected.size===all.length?null:selected;state.calendar.pendingGroomerIds=new Set(selected);globalThis.localStorage.setItem(`pawsh:groomer-filter:${state.me.business.id}`,JSON.stringify([...selected]));$("#groomer-filter").open=false;renderGroomerFilter();runDetached(loadCalendarWeek);});
$("#groomer-filter").addEventListener("keydown",event=>{if(event.key==="Escape"&&event.currentTarget.open){event.preventDefault();event.currentTarget.open=false;$("#groomer-filter-trigger").focus();}});
document.addEventListener("click",event=>{const filter=$("#groomer-filter");if(filter.open&&!filter.contains(event.target))filter.open=false;});
document.addEventListener("visibilitychange",async()=>{if(document.visibilityState==="visible"&&state.me){try{state.me=await api("/api/me");applyPermissions();await refresh();}catch{await bootstrap();}}});
if (inviteToken || resetToken) {
  state.login=true;
  $("#business-field").hidden=true; $("#business-field input").required=false;
  const emailLabel=$('#auth-form input[name="email"]').closest("label"); emailLabel.hidden=true; emailLabel.querySelector("input").required=false;
  $("#auth-title").textContent=resetToken?"Reset your password":"Join your salon";
  $("#auth-subtitle").textContent=resetToken?"Choose a new secure password.":"Choose a secure password to accept your invitation.";
  $("#auth-form button").textContent=resetToken?"Update password":"Accept invitation";
  $("#toggle-auth").hidden=true;$("#forgot-password").hidden=true;
  $("#auth-form input[name=password]").autocomplete="new-password";
}
setupBreedDrawer();
setupStaffServicesDrawer();
setupRoleEditorDrawer();
setupCouponEditorDrawer();
setupCreditLedgerDrawer();
setupTerminalDrawer();
setupTerminalCapture();
bootstrap();
