const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const inviteToken = new URLSearchParams(location.search).get("invite");
const resetToken = new URLSearchParams(location.search).get("reset");
const state = { me: null, customers: [], customerDirectory:{items:[],total:0,page:1,pageSize:25}, pets: [], dogBreeds: [], breedCatalog:{query:"",showInactive:false,sortDirection:1,editingId:null}, employees: [], services: [], appointments: [], businessHours:[], calendar:{selectedDate:null,weekStart:null,month:null,monthAppointments:[],selectedGroomerIds:null,pendingGroomerIds:null,filterInitialized:false,displayMode:"calendar",view:"week",bookingPreset:null,bookingGroomerId:null,bookingCustomerId:null,bookingPetId:null,opened:false,preferences:null}, clientProfile:null,clientProfileReturnView:"customers", messageClientId:null, reportMode:"charts",reminders:{type:"appointment_reminder",items:[],supported:true}, members: [], accessRequests:[], workspaces:[], locations: [], reports: null, login: false };
const pendingActions = new Set();
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
  state.me=null;
  state.locations=[];
  closeLocationMenu();
  state.calendar.preferences=null;state.calendar.filterInitialized=false;state.calendar.selectedGroomerIds=null;
  $("#app-view").hidden=true;
  $("#auth-view").hidden=false;
  if ($("#modal")?.open) $("#modal").close();
}

async function reconcilePermissions() {
  const response=await fetch("/api/me",{credentials:"include"});
  if (response.status===401) return settleUnauthenticated();
  if (!response.ok) return;
  state.me=await response.json();
  applyPermissions();
  renderAppointments();
}

function money(value = 0) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: state.me?.business?.currency || "USD" }).format(Number(value) / 100);
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
function normalizeBreedFilter(value){return String(value).trim().toLowerCase().replace(/[\s\-_]+/g," ").replace(/[^a-z0-9 ]/g,"");}
function allowed(permission) {
  return Boolean(state.me?.isOwner || state.me?.permissions?.includes(permission));
}
function applyPermissions() {
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

async function bootstrap() {
  try {
    state.me = await api("/api/me");
    $("#salon-name")?.replaceChildren(state.me.business.name);
    renderAccountIdentity();
    applyPermissions();
    await refresh();
    $("#auth-view").hidden = true; $("#app-view").hidden = false;
    const initialView=viewForPath(location.pathname);if(initialView==="client-profile"){const customerId=location.pathname.match(/^\/clients\/([^/]+)$/)?.[1];if(customerId)await openClientProfile(customerId);else activateView("customers",{history:"replace"});}else{activateView(initialView,{history:"replace"});if(initialView==="admin-settings")renderSettingsCategory(settingsPathCategory(),{history:"replace"});}
  } catch { $("#auth-view").hidden = false; $("#app-view").hidden = true; }
}

async function refresh() {
  const allowed = new Set(state.me.permissions);
  const owner = state.me.isOwner;
  const safe = (permission) => owner || allowed.has(permission);
  const requests = [
    safe("reports.view") ? api("/api/dashboard") : {},
    safe("customers.view") ? api("/api/customers?paged=true&page=1&pageSize=25") : {items:[],total:0,page:1,pageSize:25},
    state.pets,
    api("/api/employees"), api("/api/services"),
    safe("appointments.view") ? api(`/api/appointments?localDate=${businessDate()}&days=8`) : [],
    safe("team.manage") ? api("/api/members") : [],
    safe("reports.view") ? api("/api/reports") : null,
    safe("pets.view") && !state.dogBreeds.length ? api("/api/dog-breeds") : state.dogBreeds,
    safe("team.manage") ? api("/api/workspace-access-requests") : [],
    api("/api/workspaces"),
    loadLocations()
  ];
  const [dashboard, customerDirectory, pets, employees, services, appointments, members, reports, dogBreeds, accessRequests, workspaces, locations] = await Promise.all(requests);
  Object.assign(state, { customerDirectory,customers:customerDirectory.items||[], pets, employees, services, appointments, members, reports, dogBreeds, accessRequests, workspaces, locations });
  renderAccountIdentity();
  renderLocationSwitcher();
  reconcileGroomerFilter();
  if(!state.calendar.selectedDate){state.calendar.selectedDate=state.appointments[0]?appointmentLocalValue(state.appointments[0]).slice(0,10):businessDate();state.calendar.weekStart=weekStart(state.calendar.selectedDate);state.calendar.month=state.calendar.selectedDate.slice(0,7);}
  $("#today").textContent = new Intl.DateTimeFormat([], {timeZone:schedulingZone(),weekday:"long",month:"short",day:"numeric"}).format(new Date());
  applyPermissions();
  renderDashboard(dashboard); renderCustomersEnhanced(); renderSetupEnhanced(); renderServices(); renderAppointments(); renderReports();
}

function schedulingZone(){return state.me?.business?.timezone||"UTC";}
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
  return new Intl.DateTimeFormat([], {timeZone:item.schedulingTimezone||schedulingZone(),hour:"numeric",minute:"2-digit"}).format(new Date(item.startAt));
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
  const rabies=item.rabiesAppointmentStatus?`<span class="rabies-status rabies-${escape(item.rabiesAppointmentStatus)}" role="status" data-testid="rabies-appointment-status"><strong>Rabies:</strong> ${escape(rabiesLabels[item.rabiesAppointmentStatus]||item.rabiesAppointmentStatus)}${item.vaccinationExpiresOn?` · Expires ${new Date(`${String(item.vaccinationExpiresOn).slice(0,10)}T12:00:00Z`).toLocaleDateString()}`:""}${item.rabiesAppointmentStatus==="expires_before_appointment"?` · Appointment ${new Date(`${String(item.scheduledLocalStart).slice(0,10)}T12:00:00Z`).toLocaleDateString()} · Update required`:""}${item.rabiesCustomerNotificationStatus&&item.rabiesCustomerNotificationStatus!=="not_required"?` · Customer notice ${escape(item.rabiesCustomerNotificationStatus)}`:""}</span>`:"";
  const rabiesNeeded=["expires_before_appointment","expired","unverified","not_provided"].includes(item.rabiesAppointmentStatus);
  const compactRabies=rabiesNeeded?`<span class="rabies-status rabies-needed" role="status" data-testid="rabies-appointment-status"><strong>Rabies needed</strong></span>`:"";
  const details = [
    compactRabies||rabies,
    item.safetyAlerts ? `<strong>Safety alert:</strong> ${escape(item.safetyAlerts)}` : "",
    item.behaviorNotes ? `<strong>Behavior:</strong> ${escape(item.behaviorNotes)}` : "",
    item.medicalNotes ? `<strong>Medical:</strong> ${escape(item.medicalNotes)}` : "",
    item.groomingPreferences ? `<strong>Grooming:</strong> ${escape(item.groomingPreferences)}` : ""
  ].filter(Boolean);
  if(!details.length)return "";
  const careDetails=details.filter(detail=>detail!==compactRabies&&detail!==rabies);
  return `${compactRabies||rabies}${careDetails.length?`<div class="safety-context" role="note" aria-label="Pet safety and care information" data-testid="safety-context">${careDetails.map(detail=>`<p>${detail}</p>`).join("")}</div>`:""}`;
}
function appointmentHtml(item) {
  const time = schedulingTime(item);
  const customer = `${item.firstName} ${item.lastName}`;
  const conflictOverride=item.conflictOverridden?`<small class="conflict-override" data-testid="conflict-override">Intentional overlap</small>`:"";
  return `<article class="appointment" data-testid="appointment" data-appointment-id="${item.id}"><time>${time}</time><div><span class="pet">${escape(item.petName)}</span><small>${escape(customer)} · ${escape(item.employeeName)}</small>${conflictOverride}${safetyContext(item)}</div><div class="appointment-actions"><span class="badge ${item.status}">${item.status.replace("_"," ")}</span>${calendarAction(item)}</div></article>`;
}
function renderAppointments() {
  renderCalendar();
  const today = businessDate();
  const todays = state.appointments.filter((item) => appointmentLocalValue(item).slice(0,10) === today);
  $("#today-list").innerHTML = todays.length ? todays.map(appointmentHtml).join("") : "No appointments today.";
  bindCalendarInteractions($("#today-list"));
  $$(".appointment-action").forEach((button) => button.addEventListener("click", () => advanceAppointment(button.dataset.id, button.dataset.status, button)));
  $$(".terminal-action").forEach(button=>button.addEventListener("click",()=>terminalAppointment(button.dataset.id,button.dataset.status)));
  $$(".move-action").forEach(button=>button.addEventListener("click",()=>moveAppointment(button.dataset.id)));
  $$(".service-action").forEach(button=>button.addEventListener("click",()=>adjustServices(button.dataset.id)));
}
function calendarHours(){
  const values=state.businessHours.flatMap(period=>[String(period.startTime).slice(0,5),String(period.endTime).slice(0,5)]).map(value=>Number(value.slice(0,2))*60+Number(value.slice(3,5)));
  const derived=values.length?[Math.floor(Math.min(...values)/30)*30,Math.ceil(Math.max(...values)/30)*30]:[8*60,19*60],preferences=calendarPreferences(),start=preferences.visibleStart===null?derived[0]:Number(preferences.visibleStart),end=preferences.visibleEnd===null?derived[1]:Number(preferences.visibleEnd);return start<end?[start,end]:derived;
}
function timeLabel(minutes){const hour=Math.floor(minutes/60),minute=minutes%60;return new Intl.DateTimeFormat([],{hour:"numeric",minute:"2-digit"}).format(new Date(2020,0,1,hour,minute));}
function currentBusinessMinutes(){const parts=wallParts(),value=name=>Number(parts.find(part=>part.type===name)?.value||0);return value("hour")*60+value("minute");}
// Week and day cards are ~140px wide, so the header strip prints a compact range that states the
// meridiem once, at the end ("8:00–9:35 AM", "10:00–1:00 PM"). Anything shorter than twelve hours
// is fully determined by its end, and the grid row already fixes the half of the day; a range long
// enough to be ambiguous keeps both. The full range still drives the accessible name, the hover
// preview and the appointment detail dialog.
function compactTimeRange(start,end,zone){
  const format=new Intl.DateTimeFormat([],{hour:"numeric",minute:"2-digit",timeZone:zone}),period=value=>format.formatToParts(value).find(part=>part.type==="dayPeriod")?.value||"";
  const startText=format.format(start),endText=format.format(end),startPeriod=period(start),ambiguous=end-start>=12*60*60*1000;
  return startPeriod&&!ambiguous?`${startText.replace(startPeriod,"").trim()}–${endText}`:`${startText}–${endText}`;
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
  if(invoiceStatus) return invoiceStatus==="paid"
    ? {code:"PAI",label:"Paid",variant:"paid"}
    : {code:"UNP",label:"Unpaid",variant:"unpaid"};
  const badge=APPOINTMENT_BADGES[item&&item.status];
  return badge?{code:badge[0],label:badge[1],variant:item.status}:null;
}
// Pet care notes plus the appointment's own note. Empty means the card renders no notes button at
// all: a button that opens an empty panel is worse than no button.
function appointmentNoteEntries(item){
  return [["Safety alert",item.safetyAlerts],["Behavior",item.behaviorNotes],["Medical",item.medicalNotes],["Grooming preferences",item.groomingPreferences],["Coat notes",item.coatNotes],["Appointment notes",item.notes]].filter(([,value])=>typeof value==="string"&&value.trim().length>0);
}
function appointmentPresentation(item){
  const start=new Date(item.startAt),end=new Date(item.endAt),zone=item.schedulingTimezone||schedulingZone(),formatTime=value=>new Intl.DateTimeFormat([],{hour:"numeric",minute:"2-digit",timeZone:zone}).format(value),serviceSnapshots=item.services||[],services=serviceSnapshots.map(service=>service.name),groomers=(item.groomers||[]).map(groomer=>groomer.displayName),prices=serviceSnapshots.map(service=>service.priceMinor).filter(value=>value!==null&&value!==undefined);
  return {id:item.id,date:appointmentLocalValue(item).slice(0,10),dateLabel:new Intl.DateTimeFormat([],{weekday:"long",month:"long",day:"numeric",timeZone:zone}).format(start),timeRange:`${formatTime(start)}–${formatTime(end)}`,timeRangeCompact:compactTimeRange(start,end,zone),petName:item.petName,breed:item.breed||"",customerName:`${item.firstName} ${item.lastName}`,services,serviceSnapshots,groomer:groomers[0]||item.employeeName,status:item.status.replace("_"," "),conflictOverridden:Boolean(item.conflictOverridden),rabiesNeeded:["not_provided","expires_before_appointment"].includes(item.rabiesAppointmentStatus),warning:item.safetyAlerts||item.behaviorNotes||item.medicalNotes||item.groomingPreferences||item.coatNotes||"",durationMinutes:Math.max(1,Math.round((end-start)/60000)),totalPriceMinor:prices.length===serviceSnapshots.length?prices.reduce((sum,value)=>sum+Number(value),0):null};
}
function appointmentAccessibleName(model){return `${model.timeRange}, ${model.petName}${model.breed?`, ${model.breed}`:""}, ${model.customerName}, ${model.services.join(", ")}, ${model.status}`;}
function appointmentHoverDetails(model){return `<div><span>Status</span><strong>${escape(model.status)}</strong></div><p><strong>${escape(model.dateLabel)}</strong><br>${escape(model.timeRange)}</p><dl><div><dt>Client</dt><dd>${escape(model.customerName)}</dd></div><div><dt>Pet</dt><dd>${escape(model.petName)}${model.breed?` · ${escape(model.breed)}`:""}</dd></div><div><dt>Services</dt><dd>${model.services.map(escape).join("<br>")}</dd></div><div><dt>Groomer</dt><dd>${escape(model.groomer)}</dd></div></dl><p class="hover-summary"><strong>${model.durationMinutes} min${model.totalPriceMinor!==null?` · ${money(model.totalPriceMinor)}`:""}</strong></p>`;}
function calendarAction(item){
  const definition={scheduled:["Check in","operations.check_in"],checked_in:["Start service","operations.perform_service"],in_service:["Complete","operations.complete"],completed:["Checkout","checkout.perform"]}[item.status];
  const controls=[`<button type="button" role="menuitem" class="calendar-action view-appointment-action" data-id="${item.id}">View / Edit</button>`];
  if(definition&&allowed(definition[1]))controls.unshift(`<button role="menuitem" data-testid="appointment-${item.status}" class="calendar-action appointment-action" data-id="${item.id}" data-status="${item.status}">${definition[0]}</button>`);
  if(item.status==="scheduled"&&allowed("appointments.edit"))controls.push(`<button type="button" role="menuitem" class="calendar-action move-action" data-id="${item.id}">Move</button>`);
  if(item.status==="scheduled"&&allowed("appointments.cancel")){controls.push(`<button type="button" role="menuitem" class="calendar-action terminal-action destructive" data-id="${item.id}" data-status="cancelled">Cancel appointment</button>`);controls.push(`<button type="button" role="menuitem" class="calendar-action terminal-action" data-id="${item.id}" data-status="no_show">No show</button>`);}
  if(["checked_in","in_service"].includes(item.status)&&allowed("appointments.edit"))controls.push(`<button type="button" role="menuitem" class="calendar-action service-action" data-id="${item.id}">Adjust services</button>`);
  return `<div class="calendar-actions-menu"><button type="button" class="calendar-action-trigger" aria-label="Appointment actions for ${escape(item.petName)}" aria-haspopup="menu" aria-expanded="false" data-appointment-menu="${item.id}">&#8943;</button><div class="calendar-action-popover" role="menu" hidden>${controls.join("")}</div></div>`;
}
function groomerSlot(id){if(!id)return"";let hash=0;const key=String(id);for(let index=0;index<key.length;index++)hash=(hash*31+key.charCodeAt(index))>>>0;return hash%5;}
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
  const notesButton=notes.length?`<button type="button" class="appointment-notes-trigger" data-appointment-notes="${item.id}" data-testid="appointment-notes-trigger" ${alerted?'data-alert="true" ':""}aria-haspopup="dialog" aria-label="${alerted?"Safety alert and notes":"Notes"} for ${escape(model.petName)}"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4"/><path d="M10 12.5h6"/><path d="M10 16.5h4"/></svg></button>`:"";
  // .appointment-status stays as the machine-readable full status the calendar suite reads; the
  // visible badge is a separate element so the assertion and the design never fight each other.
  const badges=`<span class="appointment-badges"><small class="appointment-status" aria-hidden="true">${escape(model.status)}</small>${badge?`<span class="appointment-badge badge-${escape(badge.variant)}" role="img" aria-label="${escape(badge.label)}">${badge.code}</span>`:""}${model.rabiesNeeded?`<small class="card-warning" aria-label="Rabies needed">!</small>`:""}</span>`;
  const head=`<div class="appointment-head"><time class="appointment-time">${escape(model.timeRangeCompact)}</time>${notesButton}${badges}</div>`;
  const services=`<span class="appointment-services">${split.primary?`<span class="service-primary">${escape(split.primary)}</span>`:""}${addOns.map(name=>`<span class="service-addon">${escape(name)}</span>`).join("")}${extra>0?`<small>+${extra} more</small>`:""}</span>`;
  const body=`<button type="button" class="calendar-open" data-calendar-appointment="${item.id}" aria-label="${escape(appointmentAccessibleName(model))}"><span class="appointment-identity"><strong class="appointment-pet">${escape(model.petName)}</strong>${model.breed?`<span class="appointment-breed">${escape(model.breed)}</span>`:""}</span>${services}${model.conflictOverridden?`<small class="conflict-override" data-testid="conflict-override">Intentional overlap</small>`:""}<span class="appointment-client">${escape(model.customerName)}</span></button>`;
  return `<article class="${day?"day-appointment ":""}week-appointment appointment-block density-${density} status-${escape(item.status)} ${overlap?"overlap":""}" data-appointment-id="${item.id}" ${draggable?'data-draggable="true" ':""}${groomerId?`data-groomer-id="${groomerId}" data-groomer-slot="${groomerSlot(groomerId)}"`:""} style="${style}">${head}${body}<div class="sr-only appointment-accessible-safety">${safetyContext(item)}</div><div class="appointment-quick-actions">${calendarAction(item)}</div></article>`;
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
  $("#groomer-filter-options").innerHTML=groomers.map(item=>`<label data-groomer-slot="${groomerSlot(item.id)}"><input type="checkbox" value="${item.id}" ${selected.has(item.id)?"checked":""}> ${escape(item.displayName)}</label>`).join("")||"<p>No active groomers.</p>";
  const applied=state.calendar.selectedGroomerIds,count=applied===null?groomers.length:applied.size;
  $("#groomer-filter-trigger").firstChild.textContent=count===groomers.length?"All groomers ":`${count} groomer${count===1?"":"s"} `;
}
function renderCalendar(){if(state.calendar.displayMode==="agenda")renderAgendaCalendar();else if(state.calendar.view==="month")renderMonthCalendar();else if(state.calendar.view==="day")renderDayCalendar();else renderWeekCalendar();}
function renderAgendaCalendar(){
  const target=$("#calendar-list"),items=filteredAppointments().slice().sort((a,b)=>new Date(a.startAt)-new Date(b.startAt));
  const groups=items.reduce((map,item)=>{const date=appointmentPresentation(item).date,mapItems=map.get(date)||[];mapItems.push(item);map.set(date,mapItems);return map;},new Map());target.className="calendar-agenda";target.style.removeProperty("min-width");target.style.removeProperty("--groomer-count");target.innerHTML=items.length?[...groups].map(([date,group])=>`<section class="agenda-day"><h3>${new Intl.DateTimeFormat([],{weekday:"long",month:"long",day:"numeric"}).format(dateAt(date))}</h3>${group.map(item=>{const model=appointmentPresentation(item);return `<article class="agenda-entry" data-appointment-id="${item.id}"><time datetime="${escape(item.startAt)}">${escape(model.timeRange)}</time><button type="button" class="agenda-appointment" data-calendar-appointment="${item.id}" aria-label="${escape(appointmentAccessibleName(model))}"><strong>${escape(model.petName)}${model.breed?` <span>(${escape(model.breed)})</span>`:""}</strong><span>${escape(model.customerName)}</span><span>${model.services.map(escape).join(", ")}</span><small>${escape(model.groomer)}</small></button><div class="agenda-indicators"><span class="appointment-status">${escape(model.status)}</span>${model.rabiesNeeded?`<span class="rabies-needed">Rabies needed</span>`:""}${model.warning?`<span class="agenda-warning">⚠ ${escape(model.warning)}</span>`:""}</div></article>`;}).join("")}</section>`).join(""):"<p class=\"empty\">No appointments in this period.</p>";
  const days=state.calendar.view==="day"?1:state.calendar.view==="month"?42:7,start=state.calendar.view==="day"?state.calendar.selectedDate:state.calendar.view==="month"?dateShift(`${state.calendar.month}-01`,-dateAt(`${state.calendar.month}-01`).getUTCDay()):state.calendar.weekStart,end=dateShift(start,days-1);$("#calendar-range").textContent=days===1?new Intl.DateTimeFormat([],{dateStyle:"full"}).format(dateAt(start)):`${new Intl.DateTimeFormat([],{month:"short",day:"numeric"}).format(dateAt(start))} – ${new Intl.DateTimeFormat([],{month:"short",day:"numeric",year:"numeric"}).format(dateAt(end))}`;bindCalendarInteractions(target);
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
  const cells=days.map(day=>{const items=visible.filter(item=>appointmentLocalValue(item).slice(0,10)===day).sort((a,b)=>new Date(a.startAt)-new Date(b.startAt)),outside=day.slice(0,7)!==state.calendar.month,periods=state.businessHours.filter(item=>Number(item.weekday)===dateAt(day).getUTCDay()),closed=state.businessHours.length>0&&!periods.length,booked=items.filter(item=>!monthNeutralStatus(item)),revenue=booked.reduce((total,item)=>total+(item.services||[]).reduce((sum,service)=>sum+Number(service.priceMinor||0),0),0),ordered=[...booked,...items.filter(monthNeutralStatus)],shown=ordered.slice(0,MONTH_EVENT_LIMIT),dayLabel=new Intl.DateTimeFormat([],{dateStyle:"full"}).format(dateAt(day));return `<div class="calendar-month-day ${outside?"outside":""} ${closed?"closed":""} ${day===today?"today":""} ${day===state.calendar.selectedDate?"selected":""}" data-month-cell="${day}"><div class="month-day-head">${booked.length?`<span class="month-day-total"><span class="month-day-money">(${escape(money(revenue))}, </span>${booked.length} pet${booked.length===1?"":"s"}<span class="month-day-money">)</span></span>`:`<span class="month-day-total"></span>`}<button type="button" class="calendar-month-add" data-month-book-date="${day}" aria-label="Create appointment on ${escape(dayLabel)}">+</button><button type="button" class="calendar-month-date" data-month-open-date="${day}" aria-label="Open ${escape(dayLabel)} in day view">${Number(day.slice(8,10))}</button></div><div class="calendar-month-events">${shown.map(item=>{const model=appointmentPresentation(item),neutral=monthNeutralStatus(item),slot=neutral?"":groomerSlot((item.groomers||[])[0]?.id||item.employeeId);return `<span class="month-appointment-wrap ${neutral?"neutral":""}" data-appointment-id="${item.id}" ${slot===""?"":`data-groomer-slot="${slot}"`}><button type="button" class="calendar-month-event" data-calendar-appointment="${item.id}" aria-label="${escape(appointmentAccessibleName(model))}"><time>${escape(schedulingTime(item))}</time><span class="month-event-name">${escape(model.customerName)}</span></button></span>`;}).join("")}</div>${ordered.length>MONTH_EVENT_LIMIT?`<button type="button" class="calendar-month-more" data-month-open-date="${day}">+${ordered.length-MONTH_EVENT_LIMIT} more</button>`:""}</div>`;}).join("");
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
  const header=`<div class="week-corner" style="grid-column:1;grid-row:1/span 2">Time</div>${days.map((day,index)=>`<button type="button" class="week-day-head ${day===state.calendar.selectedDate?"selected":""}" data-calendar-date="${day}" style="grid-column:${index*groomers.length+2}/span ${groomers.length};grid-row:1"><strong>${new Intl.DateTimeFormat([],{weekday:"short"}).format(dateAt(day))}</strong> ${new Intl.DateTimeFormat([],{month:"short",day:"numeric"}).format(dateAt(day))}</button>`).join("")}${days.flatMap((day,dayIndex)=>groomers.map((groomer,groomerIndex)=>`<div class="week-groomer-head ${groomerIndex===0?"week-day-start":""}" data-groomer-slot="${groomerSlot(groomer.id)}" style="grid-column:${dayIndex*groomers.length+groomerIndex+2};grid-row:2" title="${escape(groomer.displayName)}">${escape(groomer.displayName)}</div>`)).join("")}`;
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
  if(!groomers.length){target.className="calendar-empty-groomers";target.innerHTML="<p><strong>No groomers selected.</strong><br>Choose groomers to display.</p>";$("#calendar-range").textContent=new Intl.DateTimeFormat([],{dateStyle:"full"}).format(dateAt(state.calendar.selectedDate));return;}
  let content=`<div class="day-corner" style="grid-column:1;grid-row:1">Time</div>${groomers.map((groomer,index)=>`<div class="day-groomer" data-groomer-slot="${groomerSlot(groomer.id)}" style="grid-column:${index+2};grid-row:1">${escape(groomer.displayName)}</div>`).join("")}`;
  for(let slot=0;slot<slots;slot++){const minutes=start+slot*30,row=slot+2,periods=state.businessHours.filter(item=>Number(item.weekday)===dateAt(state.calendar.selectedDate).getUTCDay()),open=!periods.length&&!state.businessHours.length||periods.some(period=>{const from=Number(String(period.startTime).slice(0,2))*60+Number(String(period.startTime).slice(3,5)),to=Number(String(period.endTime).slice(0,2))*60+Number(String(period.endTime).slice(3,5));return minutes>=from&&minutes<to;});content+=`<div class="day-time" style="grid-column:1;grid-row:${row}">${timeLabel(minutes)}</div>`;for(let index=0;index<groomers.length;index++){const groomer=groomers[index],preset=`${state.calendar.selectedDate}T${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;content+=`<button type="button" class="day-slot ${open?"":"closed"}" ${open?`data-slot="${preset}" data-slot-groomer="${groomer.id}"`:`disabled`} style="grid-column:${index+2};grid-row:${row}" aria-label="${escape(state.calendar.selectedDate)}, ${timeLabel(minutes)}, ${escape(groomer.displayName)}, ${open?"create appointment":"closed"}"></button>`;}}
  for(const item of filteredAppointments().filter(appointment=>appointmentLocalValue(appointment).slice(0,10)===state.calendar.selectedDate)){const local=appointmentLocalValue(item),minutes=Number(local.slice(11,13))*60+Number(local.slice(14,16)),duration=Math.max(30,Math.round((new Date(item.endAt)-new Date(item.startAt))/60000)),row=Math.floor((minutes-start)/30)+2;if(row<2||row>slots+1)continue;for(const assigned of item.groomers||[]){const column=groomers.findIndex(groomer=>groomer.id===assigned.id);if(column<0)continue;content+=appointmentCard(item,{day:true,groomerId:assigned.id,style:`grid-column:${column+2};grid-row:${row}/span ${Math.max(1,Math.ceil(duration/30))}`});}}
  const now=currentBusinessMinutes(),nowRow=Math.floor((now-start)/30)+2;if(state.calendar.selectedDate===businessDate()&&now>=start&&now<end)content+=`<div class="calendar-now-line" role="status" aria-label="Current business time" style="grid-column:2/-1;grid-row:${nowRow}"></div>`;target.innerHTML=content;$("#calendar-range").textContent=new Intl.DateTimeFormat([],{dateStyle:"full"}).format(dateAt(state.calendar.selectedDate));bindCalendarInteractions();
}
function closeCalendarMenus({restoreFocus=false}={}){$$(".calendar-action-popover:not([hidden])").forEach(popover=>{popover.hidden=true;const trigger=popover.previousElementSibling;trigger.setAttribute("aria-expanded","false");if(restoreFocus)trigger.focus();});}
function bindCalendarInteractions(root=document){const find=selector=>[...root.querySelectorAll(selector)];find('[data-slot]').forEach(button=>button.addEventListener("click",()=>{closeCalendarMenus();state.calendar.bookingPreset=button.dataset.slot;state.calendar.bookingGroomerId=button.dataset.slotGroomer||null;actions["new-appointment"]();}));find('[data-calendar-appointment]').forEach(button=>button.addEventListener("click",event=>{event.stopPropagation();closeCalendarMenus();openCalendarAppointment(button.dataset.calendarAppointment,event.currentTarget);}));find('[data-appointment-notes]').forEach(button=>button.addEventListener("click",event=>{event.stopPropagation();openAppointmentNotes(button.dataset.appointmentNotes,event.currentTarget);}));find('[data-appointment-menu]').forEach(trigger=>trigger.addEventListener("click",event=>{event.stopPropagation();const popover=trigger.nextElementSibling,opening=popover.hidden;closeCalendarMenus();popover.hidden=!opening;trigger.setAttribute("aria-expanded",String(opening));if(opening)popover.querySelector("button")?.focus();}));find('.calendar-action-popover').forEach(popover=>popover.addEventListener("keydown",event=>{if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;event.preventDefault();const items=[...popover.querySelectorAll('[role="menuitem"]')],index=items.indexOf(document.activeElement),next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;items[next]?.focus();}));find('.view-appointment-action').forEach(button=>button.addEventListener("click",event=>{closeCalendarMenus();openCalendarAppointment(button.dataset.id,event.currentTarget);}));}
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
function appointmentHost(target){return target.closest?.("[data-appointment-id]");}
// == Calendar drag-to-move ==
// Pointer events, not HTML5 drag-and-drop: the grid needs a movement threshold (so a press that
// never travels still opens the appointment), pointer capture (so a slot underneath cannot steal
// the stream mid-drag) and elementsFromPoint (so a slot already covered by another card stays a
// legal target and the server gets to answer with the conflict). A drop is never applied
// optimistically - the request goes first and the calendar reloads from what the server did.
const CALENDAR_DRAG_THRESHOLD=5,CALENDAR_DRAG_EDGE=48,CALENDAR_DRAG_SPEED=16;
let calendarDrag=null;
// Drag is a fine-pointer affordance. On touch the same move is one tap away through the card menu's
// Move action, and an accidental drag across a working schedule is expensive to undo, so coarse
// pointers keep the menu path only.
function calendarDragAvailable(){return allowed("appointments.edit")&&globalThis.matchMedia("(hover: hover) and (pointer: fine)").matches;}
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
async function openCalendarAppointmentLegacy(id){const item=state.appointments.find(appointment=>appointment.id===id);if(!item)return;try{const data=await api(`/api/customers/${item.customerId}/history`),pet=data.pets.find(candidate=>candidate.id===item.petId),groomers=(item.groomers||[]).map(groomer=>groomer.displayName).join(", ")||item.employeeName,services=item.services.map(service=>service.name).join(", ");openModal(`${data.customer.firstName} ${data.customer.lastName}`,`<div class="wide calendar-customer-context"><section><p class="eyebrow">Customer</p><h3>${escape(data.customer.firstName)} ${escape(data.customer.lastName)}</h3><p>${escape(data.customer.phone||"No phone")} · ${escape(data.customer.email||"No email")}</p></section><section><p class="eyebrow">Pet</p><h4>${escape(item.petName)}</h4><p>${escape(pet?.breed||"Breed not provided")}${pet?.weightOunces?` · ${Number(pet.weightOunces)/16} lb`:""}</p>${pet?.safetyAlerts?`<p><strong>Safety:</strong> ${escape(pet.safetyAlerts)}</p>`:""}</section><section><p class="eyebrow">Appointment</p><h4>${new Intl.DateTimeFormat([],{dateStyle:"full",timeStyle:"short",timeZone:item.schedulingTimezone||schedulingZone()}).format(new Date(item.startAt))}</h4><p>${escape(groomers)}</p><p>${escape(services)}</p>${safetyContext(item)}<span class="appointment-status">${escape(item.status.replace("_"," "))}</span></section><div class="customer-context-actions"><button type="button" class="secondary compact context-full-profile">View full customer profile</button>${item.status==="scheduled"&&allowed("appointments.edit")?`<button type="button" class="secondary compact calendar-move-detail">Move</button><button type="button" class="primary compact context-edit-appointment">Edit appointment</button>`:""}</div></div>`,null,{cancelLabel:"Close"});const next=callback=>{$("#modal").close();setTimeout(callback,50);};$(".context-full-profile")?.addEventListener("click",()=>next(()=>showCustomerDetail(item.customerId)));$(".calendar-move-detail")?.addEventListener("click",()=>next(()=>moveAppointment(id)));$(".context-edit-appointment")?.addEventListener("click",()=>next(()=>adjustServices(id)));}catch(error){toast(error.message);}}
void openCalendarAppointmentLegacy;
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
  openModal("Move appointment",groomerCheckboxes(assigned)+field("startAt","Start time","datetime-local",`required value="${escape(local)}"`)+disambiguationField(appointment.scheduledDisambiguation||""),form=>schedulingMutation(`/api/appointments/${id}/schedule`,{employeeId:form.get("employeeId"),localStart:form.get("startAt"),disambiguation:form.get("disambiguation")||undefined,expectedLocationVersion:state.me.business.locationVersion,version:appointment.version},"Reschedule"));
}
async function terminalAppointment(id,status) {
  if(!confirm(status==="cancelled"?"Cancel this appointment?":"Mark this appointment as a no-show?"))return;
  const appointment=state.appointments.find(item=>item.id===id);
  return runOnce(`transition:${id}`,async()=>{
    try{await api(`/api/appointments/${id}/transition`,{method:"POST",body:JSON.stringify({status,version:appointment.version})});toast(`Appointment ${status.replace("_"," ")}`);await refresh();}catch(error){toast(error.message);if([400,409].includes(error.status))await refresh();}
  });
}
async function advanceAppointment(id, status, actionButton) {
  if (status === "completed") return checkout(id);
  const appointment=state.appointments.find(item=>item.id===id);
  const next = {scheduled:"checked_in",checked_in:"in_service",in_service:"completed"}[status];
  if (status === "scheduled" || status === "checked_in") {
    return openModal(status === "scheduled" ? "Check in appointment" : "Start service",
      safetyContext(appointment)+(status === "checked_in" ? field("operationalNotes","Service notes","text","",true) : ""),
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
function checkout(id) {
  openModal("Complete checkout",
    field("discount","Discount ($)","number",'min="0" step=".01" value="0"')+
    field("tip","Tip ($)","number",'min="0" step=".01" value="0"')+
    select("method","Payment method",[["cash","Cash"],["external_card","External card"],["check","Check"],["other","Other"]],true),
    async (form) => {
      const values=Object.fromEntries(form);
      const invoicePayload={
        discountMinor:Math.round(Number(values.discount||0)*100),
        discountType:Number(values.discount||0)>0?"manual":null,
        tipMinor:Math.round(Number(values.tip||0)*100)
      };
      let invoice;
      try{invoice=await financialMutation(`/api/appointments/${id}/checkout`,`checkout.create-invoice`,invoicePayload);}
      catch(error){
        if(error.data?.code==="INVOICE_ALREADY_EXISTS"&&error.data.invoice){
          error.message=`${error.message}. Authoritative total: ${money(error.data.invoice.totalMinor)}.`;
        }
        throw error;
      }
      if(Number(invoice.balanceMinor)>0){
        try{
          await financialMutation(`/api/invoices/${invoice.id}/payments`,`payment.record`,{
            amountMinor:Number(invoice.balanceMinor),expectedBalanceMinor:Number(invoice.balanceMinor),method:values.method
          });
        }catch(error){
          error.message=`Invoice created; payment remains pending. ${error.message}`;
          if(error.status===409)error.reconcileFinancial=true;
          throw error;
        }
      }
      let receipt;
      try{receipt=await api(`/api/invoices/${invoice.id}/receipt`);}
      catch(error){error.message="Payment recorded successfully. Receipt is temporarily unavailable.";throw error;}
      return ()=>showReceipt(receipt);
    });
}
function showReceipt(receipt) {
  const invoice=receipt.invoice;
  const payments=receipt.payments.map(payment=>`<div><span>${escape(payment.method.replace("_"," "))} · ${escape(payment.status)}</span><strong>${money(payment.amountMinor)}</strong>${payment.status==="recorded"&&allowed("checkout.perform")?`<button type="button" class="text-button void-payment" data-payment-id="${payment.id}">Void record</button>`:""}</div>`).join("");
  openModal(`Receipt #${invoice.invoiceNumber}`,`<div class="wide receipt" data-testid="receipt"><p><strong>${escape(invoice.businessName)}</strong></p><p>${escape(invoice.firstName)} ${escape(invoice.lastName)}</p>${receipt.items.map(item=>`<div><span>${escape(item.description)}</span><strong>${money(item.amountMinor)}</strong></div>`).join("")}<div><span>Subtotal</span><strong>${money(invoice.subtotalMinor)}</strong></div><div><span>Discount</span><strong>-${money(invoice.discountMinor)}</strong></div><div><span>Tax</span><strong>${money(invoice.taxMinor)}</strong></div><div><span>Tip</span><strong>${money(invoice.tipMinor)}</strong></div><div class="receipt-total"><span>Total</span><strong>${money(invoice.totalMinor)}</strong></div><div><span>Balance</span><strong>${money(invoice.balanceMinor)}</strong></div><h4>Payment records</h4>${payments||"<p>No payment recorded.</p>"}</div>`,async()=>{});
  $$(".void-payment").forEach(button=>button.addEventListener("click",()=>voidPayment(button.dataset.paymentId,invoice.id)));
}
async function voidPayment(paymentId,invoiceId) {
  const reason=prompt("Reason for voiding this manual payment record:");
  if(!reason)return;
  if(!confirm("Void this Pawsh payment record? This does not refund external funds."))return;
  await runOnce(`void:${paymentId}`,async()=>{
    try{
      await financialMutation(`/api/payments/${paymentId}/void`,`payment.void`,{reason});
      const receipt=await api(`/api/invoices/${invoiceId}/receipt`);
      $("#modal").close();toast("Payment record voided; no external refund was issued");setTimeout(()=>showReceipt(receipt),50);
    }catch(error){toast(error.message);}
  });
}
function renderSetup() {
  $("#employee-list").innerHTML = state.employees.length ? state.employees.map((e) => `<div><strong>${escape(e.displayName)}</strong><small>${e.active ? "Active" : "Inactive"}</small></div>`).join("") : `<p class="empty">No team members yet.</p>`;
  if(!$("#member-list")||!$("#access-request-list"))return;
  $("#member-list").innerHTML = state.members.length ? state.members.map((member) => `<div><span><strong>${escape(member.email)}</strong><small>${member.isOwner ? "Owner" : `${member.permissions.length} permissions`}</small></span>${member.isOwner ? "" : `<span><button class="text-button edit-member" data-id="${member.id}">Access</button> <button class="text-button remove-member" data-id="${member.id}">Remove</button></span>`}</div>`).join("") : `<p class="empty">Only you have workspace access.</p>`;
  $$(".edit-member").forEach((button)=>button.addEventListener("click",()=>editMember(button.dataset.id)));
  $$(".remove-member").forEach((button)=>button.addEventListener("click",()=>removeMember(button.dataset.id)));
  const requests=state.accessRequests.filter(request=>request.status==="pending");
  $("#access-request-list").innerHTML=requests.length?requests.map(request=>`<div><span><strong>${escape(request.requesterName)}</strong><small>${escape(request.requesterEmail)} Â· ${new Date(request.createdAt).toLocaleDateString()}</small></span><span><button type="button" class="text-button approve-access-request" data-id="${request.id}">Approve</button> <button type="button" class="text-button reject-access-request" data-id="${request.id}">Reject</button></span></div>`).join(""):`<p class="empty">No pending requests.</p>`;
  $$(".approve-access-request").forEach(button=>button.addEventListener("click",()=>reviewAccessRequest(button.dataset.id,"approve")));
  $$(".reject-access-request").forEach(button=>button.addEventListener("click",()=>reviewAccessRequest(button.dataset.id,"reject")));
}
async function reviewAccessRequest(id,decision){
  if(!confirm(`${decision==="approve"?"Approve":"Reject"} this workspace access request?`))return;
  try{const result=await api(`/api/workspace-access-requests/${id}/${decision}`,{method:"POST"});let copied=false;if(result.acceptancePath&&navigator.clipboard){try{await navigator.clipboard.writeText(`${location.origin}${result.acceptancePath}`);copied=true;}catch{copied=false;}}toast(result.acceptancePath?(copied?"Approved; secure setup link copied":"Approved; the requester invitation was queued"):"Access request updated");await refresh();}catch(error){toast(error.message);}
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
    formatDate=value=>value?new Intl.DateTimeFormat([],{dateStyle:"medium",timeZone:schedulingZone()}).format(new Date(value)):"—",
    attr=value=>escape(value).replaceAll('"',"&quot;"),
    cell=(value,className)=>{const text=value||"—",tooltip=text==="—"?"":` title="${attr(text)}"`;return `<td class="${className}"${tooltip}>${escape(text)}</td>`;};
  $("#customer-grid").innerHTML=directory.items.length?directory.items.map(customer=>{
    const pets=customer.pets||[],shown=pets.slice(0,2),extra=pets.length-shown.length,
      label=pet=>`${pet.name}${pet.breed?` (${pet.breed})`:""}`,
      name=`${customer.firstName} ${customer.lastName}`,
      petText=pets.length?shown.map(label).join(", ")+(extra>0?` +${extra}`:""):"No active pets",
      petTitle=pets.length?pets.map(label).join(", "):"No active pets",
      alerted=pets.filter(pet=>pet.safetyAlerts),
      isNew=!customer.lastVisit&&!customer.nextAppointment,
      petActions=pets.map(pet=>`<p class="row-menu-label">${escape(pet.name)}</p>${allowed("pets.edit")?`<button type="button" class="row-menu-item row-pet-action" data-customer-id="${customer.id}" data-id="${pet.id}" data-action-name="profile">Pet profile</button>`:""}${allowed("pets.care.view")&&allowed("pets.care.edit")?`<button type="button" class="row-menu-item row-pet-action" data-customer-id="${customer.id}" data-id="${pet.id}" data-action-name="care">Pet care</button>`:""}${allowed("pets.care.view")?`<button type="button" class="row-menu-item row-pet-action" data-customer-id="${customer.id}" data-id="${pet.id}" data-action-name="documents">Documents</button>`:""}`).join("");
    return `<tr class="directory-row customer-card" tabindex="0" data-testid="customer-card" data-customer-id="${customer.id}" aria-label="Open ${attr(name)}">`
      +`<td class="clients-name"><button type="button" class="text-button customer-detail" data-id="${customer.id}">${escape(name)}</button>${isNew?`<span class="client-chip">New</span>`:""}</td>`
      +`<td class="clients-pets" title="${attr(petTitle)}">${escape(petText)}${alerted.length?`<span class="pet-alert"><span aria-hidden="true">!</span><span class="visually-hidden">Safety alert on ${escape(alerted.map(pet=>pet.name).join(", "))}</span></span>`:""}</td>`
      +cell(customer.preferredEmployeeName,"clients-groomer")
      +cell(customer.phone,"clients-phone")
      +cell(customer.email,"clients-email")
      +cell(formatDate(customer.lastVisit),"clients-date")
      +cell(formatDate(customer.nextAppointment),"clients-date")
      +`<td class="clients-status"><span class="status-dot ${customer.archivedAt?"inactive":""}">${customer.archivedAt?"Inactive":"Active"}</span></td>`
      +`<td class="clients-actions"><details class="row-menu"><summary class="row-menu-trigger" aria-expanded="false" data-testid="client-row-actions" aria-label="Actions for ${attr(name)}"><span aria-hidden="true">⋯</span></summary><div class="row-menu-list" role="group" aria-label="Actions for ${attr(name)}"><button type="button" class="row-menu-item customer-detail" data-testid="client-profile-action" data-id="${customer.id}">Client profile</button><button type="button" class="row-menu-item customer-history" data-testid="client-appointment-history" data-id="${customer.id}">Appointment history</button>${petActions}</div></details></td></tr>`;
  }).join(""):`<tr><td colspan="9" class="empty">No customers match these filters.</td></tr>`;
  const pages=Math.max(1,Math.ceil(directory.total/directory.pageSize));$("#customer-page-status").textContent=`Page ${directory.page} of ${pages} · ${directory.total} customers`;$("#customer-prev").disabled=directory.page<=1;$("#customer-next").disabled=directory.page>=pages;
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
async function loadCustomerDirectory(page=1){const params=new URLSearchParams({paged:"true",page:String(page),pageSize:"25",q:$("#customer-search").value,status:$("#customer-status").value,upcoming:$("#customer-upcoming").value,sort:$("#customer-sort").value});const result=await api(`/api/customers?${params}`);state.customerDirectory=result;state.customers=result.items;renderCustomersEnhanced();}
async function showCustomerDetail(id){try{const data=await api(`/api/customers/${id}/history`);state.pets=[...state.pets.filter(pet=>pet.customerId!==id),...data.pets];if(!state.customers.some(customer=>customer.id===id))state.customers.push(data.customer);const pets=data.pets.map(pet=>`<div class="customer-pet-row"><span><strong>${escape(pet.name)}</strong><small>${escape(pet.breed||"Breed not provided")} · ${pet.weightOunces?`${Number(pet.weightOunces)/16} lb`:"Weight not provided"}</small><small>${pet.vaccinationExpiresOn?`Rabies expires ${String(pet.vaccinationExpiresOn).slice(0,10)}`:"Rabies expiration not provided"}${pet.safetyAlerts?` · Safety: ${escape(pet.safetyAlerts)}`:""}</small></span><span>${allowed("pets.edit")?`<button type="button" class="text-button detail-edit-pet" data-id="${pet.id}">Profile</button>`:""}${allowed("pets.care.view")?`<button type="button" class="text-button detail-care" data-id="${pet.id}">Care & history</button>`:""}</span></div>`).join("")||"<p>No pets yet.</p>";openModal(`${data.customer.firstName} ${data.customer.lastName}`,`<div class="wide customer-detail"><p><strong>${escape(data.customer.phone||"No phone")}</strong> · ${escape(data.customer.email||"No email")}</p><div class="customer-detail-actions">${allowed("customers.edit")?`<button type="button" class="text-button detail-edit-customer">Edit customer</button><button type="button" class="text-button detail-archive-customer">Archive</button>`:""}<button type="button" class="text-button detail-history">Full history</button></div><h4>Pets</h4>${pets}</div>`,async()=>{});const next=callback=>{$("#modal").close();setTimeout(callback,50);};$(".detail-edit-customer")?.addEventListener("click",()=>next(()=>editCustomer(id)));$(".detail-archive-customer")?.addEventListener("click",()=>next(()=>archiveCustomer(id)));$(".detail-history")?.addEventListener("click",()=>next(()=>showCustomerHistory(id)));$$(".detail-edit-pet").forEach(button=>button.addEventListener("click",()=>next(()=>editPet(button.dataset.id))));$$(".detail-care").forEach(button=>button.addEventListener("click",()=>next(()=>editPetCare(button.dataset.id))));}catch(error){toast(error.message);}}
function renderSetupEnhanced() {
  renderSetup();
  $("#employee-list").innerHTML = state.employees.length ? state.employees.map((employee) => `<div><span><strong>${escape(employee.displayName)}</strong><small>${employee.active ? "Active" : "Inactive"}</small></span>${employee.active?`<span><button type="button" class="text-button edit-employee" data-id="${employee.id}">Edit</button> <button type="button" class="text-button deactivate-employee" data-id="${employee.id}">Deactivate</button></span>`:""}</div>`).join("") : `<p class="empty">No team members yet.</p>`;
  $$(".edit-employee").forEach((button)=>button.addEventListener("click",()=>editEmployee(button.dataset.id)));
  $$(".deactivate-employee").forEach((button)=>button.addEventListener("click",()=>deactivate("employees",button.dataset.id)));
}
function pricingMatrix(service){
  if(service.pricingMode!=="TIERED")return "";
  const classes=["SMOOTH_SINGLE","STANDARD","EXTRA_FLOOF"];const tiers=[["TIER_1","1–20"],["TIER_2","21–40"],["TIER_3","41–60"],["TIER_4","61–80"],["TIER_5","81–100"],["TIER_6","100+"]];
  return `<div class="pricing-scroll"><table class="pricing-matrix"><caption>${escape(service.name)} pricing tiers</caption><thead><tr><th scope="col">Pricing class</th>${tiers.map(([,label])=>`<th scope="col">${label} lb</th>`).join("")}</tr></thead><tbody>${classes.map(pricingClass=>`<tr><th scope="row">${escape(pricingClass.replaceAll("_"," "))}</th>${tiers.map(([code])=>`<td>${money(service.priceTiers.find(price=>price.pricingClass===pricingClass&&price.weightTierCode===code)?.priceMinor??0)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
// The catalog opens on the work a salon does every day. DOG_BASE leads, the add-ons that
// hang off it follow, then à la carte, cat, and anything general; a category the server
// adds later sorts in after those, alphabetically, so the order never depends on the order
// rows happen to arrive in.
const serviceCategoryOrder=["DOG_BASE","DOG_ADDON","A_LA_CARTE","CAT","GENERAL"];
// Which sections are collapsed is a view preference, like the calendar ones above: per
// account, per business, local to the browser, and never part of the catalog data.
function serviceSectionKey(){return `pawsh:service-sections:${state.me?.account?.id||state.me?.account?.email||"anonymous"}:${state.me?.business?.id||"none"}`;}
let serviceSectionStore=null;
function serviceSectionStorage(){
  const key=serviceSectionKey();
  if(serviceSectionStore?.key===key)return serviceSectionStore;
  let saved={};
  try{const parsed=JSON.parse(globalThis.localStorage.getItem(key)||"null");if(parsed&&typeof parsed==="object")saved=parsed;}
  catch{saved={};}
  // `revealed` holds the sections a filter opened. It is deliberately memory-only: a search
  // that surfaced a section keeps it open for the rest of the visit - clearing the search
  // must not slam shut the thing the user was just reading - but the next load starts from
  // the stored preference again.
  serviceSectionStore={key,saved,revealed:new Set()};
  return serviceSectionStore;
}
function serviceSectionOpen(category){
  const store=serviceSectionStorage();
  if(store.revealed.has(category))return true;
  return typeof store.saved[category]==="boolean"?store.saved[category]:category==="DOG_BASE";
}
function saveServiceSection(category,open){
  const store=serviceSectionStorage();
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
    return {label:employee.displayName,value,display:money(value),slot:groomerSlot(employee.id)};
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
    ?reportHorizontalBars(commission.map(employee=>({label:employee.displayName,value:amount(employee.commissionMinor),display:money(amount(employee.commissionMinor)),slot:groomerSlot(employee.id)})).sort((left,right)=>right.value-left.value),{empty:"No commission in this range."})
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
    dayFormat=new Intl.DateTimeFormat([],{dateStyle:"medium",timeZone:"UTC"});
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

const permissionLabels = {
  "calendar.view":"View calendar","appointments.view":"View appointments","appointments.create":"Create appointments",
  "appointments.edit":"Edit appointments","appointments.cancel":"Cancel appointments",
  "appointments.override_conflict":"Override scheduling conflicts","customers.view":"View customers",
  "customers.edit":"Edit customers","pets.view":"View pets","pets.edit":"Edit pets",
  "pets.care.view":"View Pet Care details","pets.care.edit":"Edit Pet Care details",
  "operations.check_in":"Check in pets","operations.perform_service":"Perform services",
  "operations.complete":"Complete services","checkout.perform":"Perform checkout","payments.view":"View payments",
  "discounts.apply":"Apply discounts","services.manage":"Manage services","team.manage":"Manage team",
  "reports.view":"View reports","settings.manage":"Manage settings"
};
function permissionFields(selected=[]) {
  return `<fieldset class="wide permission-grid"><legend>Permissions</legend>${Object.entries(permissionLabels).map(([value,label])=>`<label><input type="checkbox" name="permissions" value="${value}" ${selected.includes(value)?"checked":""}> ${label}</label>`).join("")}</fieldset>`;
}
function editMember(id) {
  const member=state.members.find((item)=>item.id===id);
  openModal("Edit member access",permissionFields(member.permissions)+`<label class="wide transfer-control"><input type="checkbox" name="transferOwnership"> Transfer protected business ownership to this member</label>`,async(form)=>{
    if(form.get("transferOwnership")){
      if(!confirm("Transfer ownership? Your account will no longer have protected Owner authority."))throw new Error("Ownership transfer cancelled");
      await api("/api/business/transfer-ownership",{method:"POST",body:JSON.stringify({membershipId:id})});
      state.me=await api("/api/me");
      return;
    }
    await api(`/api/members/${id}/permissions`,{method:"PATCH",body:JSON.stringify({permissions:form.getAll("permissions")})});
  });
}
async function removeMember(id) {
  if (!confirm("Remove this member’s Pawsh access?")) return;
  try { await api(`/api/members/${id}`,{method:"DELETE"});toast("Member access removed");await refresh(); }
  catch(error){toast(error.message);}
}
function groomerCheckboxes(selected=[]) {
  return select("employeeId","Groomer",state.employees.filter(employee=>employee.active).map(employee=>[employee.id,employee.displayName]),true,selected[0]||"");
}
function bookingServiceCheckboxes(selected=[]) {
  const labels={DOG_BASE:"Core grooming",DOG_ADDON:"Add-ons",A_LA_CARTE:"Care & finishing",CAT:"Cat",GENERAL:"Other"};
  const active=state.services.filter(service=>service.active),groups=[...new Set(active.map(service=>service.category))];
  return `<fieldset id="appointment-service-options" class="wide service-options"><legend>Services</legend>${groups.map(category=>`<section><h4>${labels[category]||escape(category)}</h4><div class="compact-options">${active.filter(service=>service.category===category).map(service=>`<label><input type="checkbox" name="serviceIds" value="${service.id}" ${selected.includes(service.id)?"checked":""}> <span>${escape(service.name)}<small>${money(service.basePriceMinor)} · ${service.baseDurationMinutes} min</small></span></label>`).join("")}</div></section>`).join("")||"<p>Add a service first.</p>"}</fieldset>`;
}
function weeklyHoursFields(hours=[]) {
  const byDay=new Map(hours.map(period=>[Number(period.weekday),period]));
  return `<fieldset class="wide hours-grid"><legend>Working hours</legend>${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day,index)=>{const period=byDay.get(index);return `<div><label><input type="checkbox" name="day${index}" ${period?"checked":""}> ${day}</label><input type="time" name="start${index}" value="${escape(period?.startTime||"09:00")}"><input type="time" name="end${index}" value="${escape(period?.endTime||"17:00")}"></div>`;}).join("")}</fieldset>`;
}
async function editEmployee(id) {
  const employee=state.employees.find(item=>item.id===id);
  try{const hours=await api(`/api/employees/${id}/working-hours`);openModal("Edit team member",field("displayName","Display name","text",`required value="${escape(employee.displayName)}"`,true)+weeklyHoursFields(hours),async(form)=>{
    await api(`/api/employees/${id}`,{method:"PUT",body:JSON.stringify({displayName:form.get("displayName")})});
    await api(`/api/employees/${id}/working-hours`,{method:"PUT",body:JSON.stringify({hours:[0,1,2,3,4,5,6].filter(index=>form.get(`day${index}`)).map(index=>({weekday:index,startTime:form.get(`start${index}`),endTime:form.get(`end${index}`)}))})});
  });}catch(error){toast(error.message);}
}
function editService(id) {
  const service=state.services.find(item=>item.id===id);
  const tierFields=service.pricingMode==="TIERED"?`<fieldset class="wide"><legend>Pricing matrix</legend><div class="pricing-scroll"><table class="pricing-matrix"><thead><tr><th scope="col">Class</th>${["1–20","21–40","41–60","61–80","81–100","100+"].map(label=>`<th scope="col">${label}</th>`).join("")}</tr></thead><tbody>${["SMOOTH_SINGLE","STANDARD","EXTRA_FLOOF"].map(pricingClass=>`<tr><th scope="row">${escape(pricingClass.replaceAll("_"," "))}</th>${[1,2,3,4,5,6].map(index=>{const price=service.priceTiers.find(item=>item.pricingClass===pricingClass&&item.weightTierCode===`TIER_${index}`);return `<td><label><span class="sr-only">${escape(pricingClass)} ${index} price</span><input name="tier:${pricingClass}:TIER_${index}" type="number" min="0" step=".01" value="${Number(price?.priceMinor??0)/100}"></label></td>`;}).join("")}</tr>`).join("")}</tbody></table></div></fieldset>`:"";
  openModal("Edit service",field("name","Service name","text",`required value="${escape(service.name)}"`)+field("baseDurationMinutes","Duration (minutes)","number",`required min="1" value="${service.baseDurationMinutes}"`)+field("basePrice","Base/fixed price ($)","number",`required min="0" step=".01" value="${Number(service.basePriceMinor)/100}`)+field("description","Description","text",`value="${escape(service.description||"")}"`,true)+`<label><input name="active" type="checkbox" ${service.active?"checked":""}> Active</label>`+tierFields,async form=>{const values=Object.fromEntries(form);await api(`/api/services/${id}`,{method:"PUT",body:JSON.stringify({name:values.name,description:values.description||null,baseDurationMinutes:Number(values.baseDurationMinutes),basePriceMinor:Math.round(Number(values.basePrice)*100),category:service.category,pricingMode:service.pricingMode,rangeMaxMinor:service.rangeMaxMinor,priceConfirmationRequired:service.priceConfirmationRequired,active:form.has("active")})});const prices=[...form.entries()].filter(([name])=>name.startsWith("tier:")).map(([name,value])=>{const [,pricingClass,weightTierCode]=name.split(":");return {pricingClass,weightTierCode,priceMinor:Math.round(Number(value)*100)};});if(prices.length)await api(`/api/services/${id}/pricing`,{method:"PUT",body:JSON.stringify({prices})});});
}
const breedClasses=[["SMOOTH_SINGLE","Smooth Single"],["STANDARD","Standard"],["EXTRA_FLOOF","Extra Floof"]];
function breedClassLabel(value){return breedClasses.find(([key])=>key===value)?.[1]??value.replaceAll("_"," ");}
function breedClassOptions(value){return breedClasses.map(([key,label])=>`<option value="${key}" ${key===value?"selected":""}>${label}</option>`).join("");}
function renderBreedCatalog(){
  const body=$("#breed-catalog-body");if(!body)return;
  const query=normalizeBreedFilter(state.breedCatalog.query);const breeds=state.dogBreeds.filter(breed=>(state.breedCatalog.showInactive||breed.active)&&(!query||breed.search.includes(query))).sort((a,b)=>state.breedCatalog.sortDirection*a.name.localeCompare(b.name));
  body.innerHTML=breeds.length?breeds.map(breed=>{
    if(state.breedCatalog.editingId===breed.id)return `<tr data-breed-id="${breed.id}"><td><label><span class="sr-only">Breed name</span><input class="breed-edit-name" value="${escape(breed.name)}" maxlength="100" aria-describedby="breed-error-${breed.id}"></label><small class="mobile-only">${escape(breedClassLabel(breed.defaultPricingClass))} · ${breed.active?"Active":"Inactive"}</small></td><td><label><span class="sr-only">Pricing class</span><select class="breed-edit-class">${breedClassOptions(breed.defaultPricingClass)}</select></label></td><td><span class="breed-status ${breed.active?"":"inactive"}">${breed.active?"Active":"Inactive"}</span></td><td><div class="breed-edit-actions"><button type="button" class="breed-save" aria-label="Save ${escape(breed.name)}">✓</button><button type="button" class="breed-cancel" aria-label="Cancel editing ${escape(breed.name)}">×</button></div></td></tr><tr id="breed-error-${breed.id}" class="breed-row-error" role="alert" aria-live="assertive" hidden><td colspan="4"></td></tr>`;
    return `<tr data-breed-id="${breed.id}"><td><strong>${escape(breed.name)}</strong><small class="mobile-only">${escape(breedClassLabel(breed.defaultPricingClass))} · ${breed.active?"Active":"Inactive"}</small></td><td>${escape(breedClassLabel(breed.defaultPricingClass))}</td><td><span class="breed-status ${breed.active?"":"inactive"}">${breed.active?"Active":"Inactive"}</span></td><td><details class="row-menu"><summary aria-label="Actions for ${escape(breed.name)}">⋯</summary><div class="row-menu-items"><button type="button" class="breed-edit">Edit</button><button type="button" class="breed-toggle">${breed.active?"Deactivate":"Reactivate"}</button></div></details></td></tr>`;
  }).join(""):`<tr><td colspan="4" class="empty">No breeds match this view.</td></tr>`;
  $("#breed-catalog-status").textContent=`${breeds.length} breed${breeds.length===1?"":"s"} shown`;
  $$("#breed-catalog-body .breed-edit").forEach(button=>button.addEventListener("click",()=>{state.breedCatalog.editingId=button.closest("tr").dataset.breedId;renderBreedCatalog();$(".breed-edit-name")?.focus();}));
  $$("#breed-catalog-body .breed-cancel").forEach(button=>button.addEventListener("click",()=>{state.breedCatalog.editingId=null;renderBreedCatalog();}));
  $$("#breed-catalog-body .breed-save").forEach(button=>button.addEventListener("click",()=>saveBreedRow(button.closest("tr"))));
  $$("#breed-catalog-body .breed-toggle").forEach(button=>button.addEventListener("click",async()=>{const id=button.closest("tr").dataset.breedId,breed=state.dogBreeds.find(item=>item.id===id);await toggleBreed(id,!breed.active);}));
  $$("#breed-catalog-body input,#breed-catalog-body select").forEach(control=>control.addEventListener("keydown",event=>{if(event.key==="Escape"){state.breedCatalog.editingId=null;renderBreedCatalog();}else if(event.key==="Enter"){event.preventDefault();saveBreedRow(control.closest("tr"));}}));
}
async function reloadBreeds(){state.dogBreeds=await api("/api/dog-breeds");renderBreedCatalog();}
async function saveBreedRow(row){const errorRow=row.nextElementSibling;try{await api(`/api/dog-breeds/${row.dataset.breedId}`,{method:"PATCH",body:JSON.stringify({name:row.querySelector(".breed-edit-name").value,defaultPricingClass:row.querySelector(".breed-edit-class").value})});state.breedCatalog.editingId=null;await reloadBreeds();toast("Breed updated");}catch(error){errorRow.hidden=false;errorRow.firstElementChild.textContent=error.message;row.querySelector(".breed-edit-name").setAttribute("aria-invalid","true");}}
async function toggleBreed(id,active){await api(`/api/dog-breeds/${id}`,{method:"PATCH",body:JSON.stringify({active})});await reloadBreeds();toast(active?"Breed reactivated":"Breed deactivated");}
async function deactivate(type,id) {
  if(!confirm(`Deactivate this ${type==="services"?"service":"team member"}?`))return;
  try{await api(`/api/${type}/${id}`,{method:"DELETE"});toast("Deactivated");await refresh();}catch(error){toast(error.message);}
}
function editCustomer(id) {
  const customer=state.customers.find(item=>item.id===id);
  const contactOptions=["email","phone","none"].map(value=>`<option value="${value}" ${customer.preferredContactMethod===value?"selected":""}>${value}</option>`).join("");
  openModal("Edit customer",
    field("firstName","First name","text",`required value="${escape(customer.firstName)}"`)+
    field("lastName","Last name","text",`required value="${escape(customer.lastName)}"`)+
    field("email","Email","email",`value="${escape(customer.email||"")}"`)+
    field("phone","Phone","tel",`value="${escape(customer.phone||"")}"`)+
    field("address","Address","text",`value="${escape(customer.address||"")}"`,true)+
    `<label>Preferred contact<select data-testid="field-preferredContactMethod" name="preferredContactMethod">${contactOptions}</select></label>`+
    `<label><input data-testid="field-emailAllowed" name="emailAllowed" type="checkbox" ${customer.emailAllowed?"checked":""}> Email allowed</label>`+
    field("notes","Notes","text",`value="${escape(customer.notes||"")}"`,true),
    form=>api(`/api/customers/${id}`,{method:"PUT",body:JSON.stringify({
      ...Object.fromEntries(form),
      emailAllowed:form.has("emailAllowed")
    })})
  );
}
async function showCustomerHistory(id) {
  try{
    const historyData=await api(`/api/customers/${id}/history`);
    const appointments=historyData.appointments.map(item=>`<div><span>${new Intl.DateTimeFormat([],{timeZone:item.schedulingTimezone||schedulingZone()}).format(new Date(item.startAt))} / ${escape(item.petName)}</span><strong>${escape(item.status.replace("_"," "))}</strong></div>`).join("")||"<p>No appointments yet.</p>";
    const invoices=historyData.invoices.map(item=>`<div><span>Invoice ${escape(item.invoiceNumber)}</span><span><strong>${money(item.totalMinor)} / ${escape(item.status)}</strong><button type="button" class="text-button history-receipt" data-invoice-id="${item.id}">Receipt</button></span></div>`).join("")||`<p>${allowed("payments.view")?"No invoices yet.":"Financial history requires payment access."}</p>`;
    const petDocuments=allowed("pets.care.view")?historyData.pets.map(pet=>`<div><span>${escape(pet.name)}${pet.archivedAt?" (archived)":""}</span><button type="button" class="text-button history-pet-documents" data-pet-id="${pet.id}">Documents</button></div>`).join(""):"";
    openModal(`${historyData.customer.firstName} ${historyData.customer.lastName} history`,`<div class="wide history-list">${petDocuments?`<h4>Pet Care documents</h4>${petDocuments}`:""}<h4>Appointments</h4>${appointments}<h4>Transactions</h4>${invoices}</div>`,async()=>{});
    $$(".history-pet-documents").forEach(button=>button.addEventListener("click",()=>showPetDocuments(button.dataset.petId)));
    $$(".history-receipt").forEach(button=>button.addEventListener("click",async()=>{
      const receipt=await api(`/api/invoices/${button.dataset.invoiceId}/receipt`);
      $("#modal").close();setTimeout(()=>showReceipt(receipt),50);
    }));
  }catch(error){toast(error.message);}
}

async function showArchivedCareRecords(){
  try{
    const records=await api("/api/customers/archived");
    const rows=records.map(record=>`<div><span>${escape(record.firstName)} ${escape(record.lastName)} / ${escape(record.petName)}${record.petArchivedAt?" (pet archived)":""}</span><button type="button" class="text-button archived-pet-documents" data-pet-id="${record.petId}">Documents</button></div>`).join("");
    openModal("Archived Pet Care records",`<div class="wide history-list">${rows||"<p>No archived Pet Care records.</p>"}</div>`,async()=>{});
    $$(".archived-pet-documents").forEach(button=>button.addEventListener("click",()=>showPetDocuments(button.dataset.petId,true)));
  }catch(error){toast(error.message);}
}

async function showPetDocuments(petId,historicalOnly=false){
  try{
    const data=await api(`/api/pets/${petId}/documents`);
    const current=data.current;
    const activeRequest=null;
    const previous=data.previous.map(item=>`<div><span>${escape(item.filename)}<small>${item.expiresOn?`Expires ${new Date(`${item.expiresOn}T00:00:00`).toLocaleDateString()}`:"Expiration date not recorded"}</small></span><button type="button" class="text-button download-pet-document" data-id="${item.id}">Download</button></div>`).join("");
    const expired=current?.expiresOn&&new Date(`${current.expiresOn}T23:59:59`)<new Date();
    const currentView=current?`<section class="wide document-current" data-testid="rabies-current"><p><strong>${escape(current.filename)}</strong></p><p>${current.expiresOn?`${expired?"Rabies vaccination expired — ":"Expires "}${new Date(`${current.expiresOn}T00:00:00`).toLocaleDateString()}`:"Expiration date not recorded"}</p><button type="button" class="text-button download-pet-document" data-id="${current.id}">Download</button></section>`:`<p class="wide empty">No rabies vaccination record uploaded</p>`;
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
async function archiveCustomer(id) {
  if(!confirm("Archive this customer? Their operational and financial history will remain."))return;
  try{await api(`/api/customers/${id}/archive`,{method:"POST"});toast("Customer archived");await refresh();}catch(error){toast(error.message);}
}
function editPet(id) {
  let pet=state.pets.find(item=>item.id===id);
  openModal("Edit pet profile",petProfileFields(pet),async(form)=>{
    try{
      return await api(`/api/pets/${id}`,{method:"PUT",body:JSON.stringify({
        customerId:pet.customerId,
        name:form.get("name"),
        species:form.get("species"),
        breed:form.get("breed")||null,
        dateOfBirth:form.get("dateOfBirth")||null,
        approximateAge:form.get("approximateAge")||null,
        weightOunces:form.get("weightPounds")===""?null:Math.round(Number(form.get("weightPounds"))*16),
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
      throw error;
    }
  });
  setupBreedAutocomplete();
}

function petProfileFields(pet){
  return field("name","Pet name","text",`required value="${escape(pet.name)}"`)+
    field("species","Species","text",`required value="${escape(pet.species)}"`)+
    breedField(pet.breed||"")+
    field("dateOfBirth","Date of birth","date",`value="${pet.dateOfBirth?String(pet.dateOfBirth).slice(0,10):""}"`)+
    field("approximateAge","Approximate age","text",`value="${escape(pet.approximateAge||"")}"`)+
    field("weightPounds","Weight (lb)","number",`min="0.0625" step="0.0625" value="${pet.weightOunces===null||pet.weightOunces===undefined?"":Number(pet.weightOunces)/16}"`)+
    field("sex","Sex","text",`value="${escape(pet.sex||"")}"`)+
    field("coatNotes","Coat notes","text",`value="${escape(pet.coatNotes||"")}"`,true)+
    field("groomingPreferences","Grooming preferences","text",`value="${escape(pet.groomingPreferences||"")}"`,true)+
    `<label><input data-testid="field-photoPermission" name="photoPermission" type="checkbox" ${pet.photoPermission?"checked":""}> Photo permission</label>`;
}

function petCareFields(pet){
  const expiration=pet.vaccinationExpiresOn?String(pet.vaccinationExpiresOn).slice(0,10):null;
  const nextDate=pet.nextAppointmentLocalStart?String(pet.nextAppointmentLocalStart).slice(0,10):null;
  const display=date=>new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US");
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
function breedField(value="") {
  return `<label class="breed-combobox">Breed<input data-testid="field-breed" name="breed" type="text" value="${escape(value)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="breed-options" aria-activedescendant=""><span class="breed-options" id="breed-options" role="listbox" hidden></span></label>`;
}
function setupBreedAutocomplete() {
  const input=$('[name="breed"]'),list=$("#breed-options");if(!input||!list)return;
  let matches=[],active=-1;
  const normalized=value=>String(value).trim().toLowerCase().replace(/[\s\-_]+/g," ").replace(/[^a-z0-9 ]/g,"");
  const close=()=>{list.hidden=true;input.setAttribute("aria-expanded","false");input.setAttribute("aria-activedescendant","");active=-1;};
  const selectBreed=index=>{const breed=matches[index];if(!breed)return;input.value=breed.name;close();input.dispatchEvent(new globalThis.Event("change",{bubbles:true}));};
  const render=()=>{const query=normalized(input.value);matches=query?state.dogBreeds.filter(item=>item.active&&item.search.includes(query)).sort((a,b)=>Number(!a.search.startsWith(query))-Number(!b.search.startsWith(query))||a.name.localeCompare(b.name)).slice(0,12):[];active=matches.length?0:-1;list.innerHTML=matches.length?matches.map((item,index)=>`<button type="button" id="breed-option-${index}" role="option" aria-selected="${index===active}" data-index="${index}">${escape(item.name)}</button>`).join(""):`<span class="breed-no-results" role="option" aria-disabled="true">No matching breeds. You may keep the existing value or choose Other.</span>`;list.hidden=false;input.setAttribute("aria-expanded","true");input.setAttribute("aria-activedescendant",active>=0?`breed-option-${active}`:"");};
  const move=direction=>{if(!matches.length)return;active=(active+direction+matches.length)%matches.length;list.querySelectorAll('[role="option"]').forEach((option,index)=>option.setAttribute("aria-selected",String(index===active)));input.setAttribute("aria-activedescendant",`breed-option-${active}`);list.querySelector(`#breed-option-${active}`)?.scrollIntoView({block:"nearest"});};
  input.addEventListener("input",render);input.addEventListener("focus",()=>{if(input.value)render();});input.addEventListener("keydown",event=>{if(event.key==="ArrowDown"||event.key==="ArrowUp"){event.preventDefault();if(list.hidden)render();else move(event.key==="ArrowDown"?1:-1);}else if(event.key==="Enter"&&!list.hidden&&active>=0){event.preventDefault();selectBreed(active);}else if(event.key==="Escape"){event.preventDefault();close();}});list.addEventListener("pointerdown",event=>{const option=event.target.closest("[data-index]");if(option){event.preventDefault();selectBreed(Number(option.dataset.index));}});input.addEventListener("blur",()=>setTimeout(close,100));
}
function select(name, label, options, wide = false, selectedValue = "", required = true) {
  return `<label class="${wide ? "wide" : ""}">${label}<select data-testid="field-${name}" name="${name}" ${required?"required":""}><option value="">Choose…</option>${options.map(([v,l]) => `<option value="${v}" ${String(v)===String(selectedValue)?"selected":""}>${escape(l)}</option>`).join("")}</select></label>`;
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
      const afterClose=await submit(new FormData(form));
      if(state.me)await refresh(); $("#modal").close(); toast(`${title} saved`);
      if(typeof afterClose==="function")runDetached(afterClose);
    }
    catch (error) {
      if(error.retryConflictOverride) renderConflictOverride(error);
      else {
        $("#modal-error").textContent = error.message;
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

function renderConflictOverride(error){
  const container=$("#modal-error");
  container.textContent="";
  const conflicts=error.data.conflicts||[];
  const proposed=error.proposedStart;
  const locationConflictTimes=conflicts.map(item=>`${new Intl.DateTimeFormat([],{timeZone:schedulingZone(),dateStyle:"short",timeStyle:"short"}).format(new Date(item.startsAt))} to ${new Intl.DateTimeFormat([],{timeZone:schedulingZone(),timeStyle:"short"}).format(new Date(item.endsAt))}`).join(", ");
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
      $("#modal").close();
      toast(`${error.operationLabel} saved with intentional overlap`);
    }catch(retryError){
      if(retryError.status===403)await reconcilePermissions();
      container.textContent=retryError.message;
    }finally{button.disabled=false;}
  });
  container.append(message,button);
}

const actions = {
  "new-customer": () => openModal("New customer",
    field("firstName","First name","text","required")+field("lastName","Last name","text","required")+field("email","Email","email")+field("phone","Phone","tel")+field("notes","Notes","text","",true),
    (form) => api("/api/customers",{method:"POST",body:JSON.stringify(Object.fromEntries(form))})),
  "new-pet": () => { openModal("New pet",
    select("customerId","Customer",state.customers.map(c=>[c.id,`${c.firstName} ${c.lastName}`]),true)+field("name","Pet name","text","required")+breedField()+field("weightPounds","Weight (lb)","number",'min="0.0625" step="0.0625"')+field("species","Species","text",'value="dog"')+field("groomingPreferences","Grooming preferences","text","",true)+(allowed("pets.care.edit")?field("behaviorNotes","Behavior notes","text","",true)+field("safetyAlerts","Safety alert","text","",true)+field("medicalNotes","Medical notes","text","",true):""),
    (form) => {const values=Object.fromEntries(form);values.weightOunces=values.weightPounds===""?null:Math.round(Number(values.weightPounds)*16);delete values.weightPounds;return api("/api/pets",{method:"POST",body:JSON.stringify(values)});}); setupBreedAutocomplete(); },
  "new-service": () => openModal("New service",
    field("name","Service name","text","required")+field("baseDurationMinutes","Duration (minutes)","number",'required min="1"')+field("basePrice","Fixed price ($)","number",'required min="0" step=".01"')+select("category","Category",[["GENERAL","General"],["DOG_ADDON","Dog add-on"],["A_LA_CARTE","À la carte"],["CAT","Cat"]],true,"GENERAL")+field("description","Description","text","",true),
    (form) => { const o=Object.fromEntries(form); o.baseDurationMinutes=Number(o.baseDurationMinutes); o.basePriceMinor=Math.round(Number(o.basePrice)*100);o.pricingMode="FIXED";o.active=true;delete o.basePrice; return api("/api/services",{method:"POST",body:JSON.stringify(o)}); }),
  "new-employee": () => openModal("New team member",
    field("displayName","Display name","text","required",true),
    (form) => api("/api/employees",{method:"POST",body:JSON.stringify({displayName:form.get("displayName")})})),
  "invite-member": () => openModal("Invite workspace member",
    field("email","Email","email","required",true)+
    `<label class="wide">Access preset<select name="preset"><option value="groomer">Groomer</option><option value="receptionist">Receptionist</option><option value="manager">Manager</option></select></label>`,
    async(form)=>{
      const values=Object.fromEntries(form);
      const definitions=await api("/api/permissions");
      const result=await api("/api/members/invitations",{method:"POST",body:JSON.stringify({email:values.email,permissions:definitions.presets[values.preset]})});
      await navigator.clipboard.writeText(`${location.origin}${result.acceptancePath}`);
      toast("Secure invitation link copied");
    }),
  "business-settings": () => openModal("Business settings",
    field("name","Salon name","text",`required value="${escape(state.me.business.name)}"`,true)+
    field("timezone","IANA timezone","text",`required value="${escape(state.me.business.timezone)}"`)+
    field("currency","Currency","text",`required maxlength="3" value="${escape(state.me.business.currency)}"`)+
    field("taxRate","Tax rate (%)","number",`required min="0" max="100" step=".01" value="${Number(state.me.business.taxRateBasisPoints)/100}"`)+
    field("reminderHours","Reminder lead (hours)","number",`required min="0" value="${Number(state.me.business.reminderLeadMinutes)/60}"`),
    async(form)=>{
      const values=Object.fromEntries(form);
      if(values.timezone!==state.me.business.timezone&&state.appointments.some(item=>new Date(item.startAt)>new Date())&&!confirm("Changing this location's timezone affects how new and rescheduled appointment times are interpreted. Existing appointment instants will not be moved."))return;
      await api("/api/business/settings",{method:"PUT",body:JSON.stringify({
        name:values.name,timezone:values.timezone,currency:values.currency,
        taxRateBasisPoints:Math.round(Number(values.taxRate)*100),
        reminderLeadMinutes:Math.round(Number(values.reminderHours)*60),locationVersion:state.me.business.locationVersion
      })});
      state.me=await api("/api/me");renderAccountIdentity();
    }),
  "business-hours": () => openModal("Business hours",
    `<fieldset class="wide hours-grid"><legend>Weekly schedule</legend>${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day,index)=>`<div><label><input type="checkbox" name="day${index}" ${index>0&&index<6?"checked":""}> ${day}</label><input type="time" name="start${index}" value="09:00"><input type="time" name="end${index}" value="17:00"></div>`).join("")}</fieldset>`,
    form=>api("/api/business/working-hours",{method:"PUT",body:JSON.stringify({hours:[0,1,2,3,4,5,6].filter(index=>form.get(`day${index}`)).map(index=>({weekday:index,startTime:form.get(`start${index}`),endTime:form.get(`end${index}`)}))})})),
  "new-appointment": () => runOnce("open:new-appointment", async () => {
    const [customers, pets, employees, services] = await Promise.all([
      api("/api/customers"),
      api("/api/pets"),
      api("/api/employees"),
      api("/api/services")
    ]);
    Object.assign(state, { customers, pets, employees, services });
    const explicitGroomerId=state.calendar.bookingGroomerId,presetCustomerId=state.calendar.bookingCustomerId,presetPetId=state.calendar.bookingPetId;
    openModal("New appointment",
      select("customerId","Customer",state.customers.map(c=>[c.id,`${c.firstName} ${c.lastName}`]))+
      select("petId","Pet",[])+
      groomerCheckboxes(explicitGroomerId?[explicitGroomerId]:[])+bookingServiceCheckboxes()+
      field("startAt","Start time","datetime-local",`required value="${state.calendar.bookingPreset||""}"`,true)+disambiguationField()+
      `<div class="wide pricing-preview" role="status" aria-live="polite" data-testid="booking-price-status">Choose a pet and service to calculate pricing.</div>`+
      `<p class="wide" role="status" aria-live="polite" data-testid="booking-rabies-status">Choose a pet and appointment time to evaluate rabies information.</p>`+
      field("notes","Appointment notes","text","",true),
      async (form) => { const o=Object.fromEntries(form); await schedulingMutation("/api/appointments",{locationId:state.me.business.locationId,customerId:o.customerId,petId:o.petId,employeeId:o.employeeId,serviceIds:form.getAll("serviceIds"),localStart:o.startAt,disambiguation:o.disambiguation||undefined,expectedLocationVersion:state.me.business.locationVersion,notes:o.notes||null},"Booking");return ()=>selectCalendarDate(String(o.startAt).slice(0,10)); });
    const customerSelect=$('[name="customerId"]');const petSelect=$('[name="petId"]');
    state.calendar.bookingPreset=null;state.calendar.bookingGroomerId=null;state.calendar.bookingCustomerId=null;state.calendar.bookingPetId=null;
    const startInput=$('[name="startAt"]');const rabiesStatus=$('[data-testid="booking-rabies-status"]');
    const priceStatus=$('[data-testid="booking-price-status"]');let priceSequence=0;
    const updatePricePreview=async()=>{const sequence=++priceSequence;const serviceIds=$$('input[name="serviceIds"]:checked').map(input=>input.value);if(!petSelect.value||!serviceIds.length){priceStatus.textContent="Choose a pet and service to calculate pricing.";return;}priceStatus.textContent="Calculating authoritative price…";try{const prices=await api("/api/pricing/resolve",{method:"POST",body:JSON.stringify({petId:petSelect.value,serviceIds})});if(sequence!==priceSequence)return;const resolved=prices.filter(price=>price.status==="resolved"),summary=resolved.length===prices.length?`<p class="booking-service-summary"><strong>${prices.length} service${prices.length===1?"":"s"} · ${resolved.reduce((sum,price)=>sum+Number(price.durationMinutes),0)} min · ${money(resolved.reduce((sum,price)=>sum+Number(price.priceMinor),0))}</strong></p>`:"";priceStatus.innerHTML=prices.map(price=>price.status==="resolved"?`<p><strong>${escape(price.name)}</strong> · ${money(price.priceMinor)} · ${price.durationMinutes} min${price.weightTierLabel?` · ${escape(price.weightTierLabel)}`:""}</p>`:`<p><strong>${escape(price.name)}</strong><br>${price.status==="weight_required"?"Weight required to determine pricing.":price.status==="quote_required"?"Quote required.":"Admin price confirmation required."}</p>`).join("")+summary;}catch(error){if(sequence===priceSequence)priceStatus.textContent=error.message;}};
    const updateRabiesPreview=()=>{
      const pet=state.pets.find(item=>item.id===petSelect.value),appointmentDate=String(startInput.value||"").slice(0,10);
      if(!pet||!appointmentDate){rabiesStatus.textContent="Choose a pet and appointment time to evaluate rabies information.";return;}
      const expiration=pet.vaccinationExpiresOn?String(pet.vaccinationExpiresOn).slice(0,10):null;
      const status=!expiration?"Not provided"
        :expiration<appointmentDate?"Expires before appointment — updated rabies information is required"
        :"Valid for appointment";
      rabiesStatus.textContent=`Rabies: ${status}${expiration?`. Expiration ${expiration}. Appointment ${appointmentDate}.`:""}`;
    };
    customerSelect.addEventListener("change",()=>{
      const pets=state.pets.filter(pet=>pet.customerId===customerSelect.value);
      petSelect.innerHTML=`<option value="">Choose…</option>${pets.map(pet=>`<option value="${pet.id}">${escape(pet.name)}</option>`).join("")}`;
      updateRabiesPreview();updatePricePreview();
    });
    const bindServicePreview=()=>$$('input[name="serviceIds"]').forEach(input=>input.addEventListener("change",updatePricePreview));
    const applyBookingDefaults=async()=>{const petId=petSelect.value;if(!petId)return;const defaults=await api(`/api/pets/${petId}/booking-defaults`);if(petSelect.value!==petId)return;const serviceIds=new Set(defaults.services.map(item=>item.id));if(!explicitGroomerId&&defaults.groomers[0])$('[name="employeeId"]').value=defaults.groomers[0].id;$$('input[name="serviceIds"]').forEach(input=>input.checked=serviceIds.has(input.value));updatePricePreview();};
    petSelect.addEventListener("change",()=>{updateRabiesPreview();applyBookingDefaults();});startInput.addEventListener("change",updateRabiesPreview);bindServicePreview();
    if(presetCustomerId){customerSelect.value=presetCustomerId;customerSelect.dispatchEvent(new globalThis.Event("change"));if(presetPetId){petSelect.value=presetPetId;petSelect.dispatchEvent(new globalThis.Event("change"));}}
  }),
  "blocked-time": () => openModal("Block team time",
    select("employeeId","Team member",state.employees.filter(item=>item.active).map(item=>[item.id,item.displayName]))+
    field("startAt","Start","datetime-local","required")+field("endAt","End","datetime-local","required")+
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
document.addEventListener("click",event=>{if(!event.target.closest(".calendar-actions-menu"))closeCalendarMenus();});
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
    state.calendar.opened=false;state.calendar.monthAppointments=[];state.businessHours=[];
    applyPermissions();
    toast(`Switched to ${result?.locationName||state.me.business.locationName}`);
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
newActionMenu.addEventListener("click",async event=>{const item=event.target.closest?.("[data-new-action]");if(!item||item.disabled)return;const action=item.dataset.newAction;closeNewActionMenu();if(action==="quick-existing"){await actions["new-appointment"]();setTimeout(()=>$('#modal [name="customerId"]')?.focus(),0);}else await actions[action]?.();});
document.addEventListener("click",event=>{if(!newActionMenu.hidden&&!$(".new-action-control").contains(event.target))closeNewActionMenu();});
document.addEventListener("keydown",event=>{if(event.key==="Escape"){if(!newActionMenu.hidden){event.preventDefault();closeNewActionMenu({restoreFocus:true});}else if(locationMenu&&!locationMenu.hidden){event.preventDefault();closeLocationMenu({restoreFocus:true});}else if(!accountMenu.hidden){event.preventDefault();closeAccountMenu({restoreFocus:true});}else if($(".calendar-action-popover:not([hidden])")){event.preventDefault();closeCalendarMenus({restoreFocus:true});}}});
$("#profile-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,error=$("#profile-error"),button=form.querySelector("button[type=submit]");error.textContent="";button.disabled=true;try{await api("/api/me",{method:"PATCH",body:JSON.stringify({displayName:new FormData(form).get("displayName")})});state.me=await api("/api/me");renderAccountIdentity();toast("Profile updated");}catch(problem){error.textContent=problem.message;}finally{button.disabled=false;}});
$("#profile-cancel").addEventListener("click",()=>{renderAccountIdentity();$("#profile-error").textContent="";});
$("#profile-workspace-select").addEventListener("change",async event=>{try{await api("/api/workspaces/select",{method:"POST",body:JSON.stringify({businessId:event.target.value})});location.reload();}catch(error){toast(error.message);renderAccountIdentity();}});
$("#password-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,values=Object.fromEntries(new FormData(form)),error=$("#password-error"),button=form.querySelector("button[type=submit]");error.textContent="";if(values.newPassword!==values.confirmPassword){error.textContent="New passwords do not match";form.elements.confirmPassword.focus();return;}button.disabled=true;try{await api("/api/me/password",{method:"POST",body:JSON.stringify({currentPassword:values.currentPassword,newPassword:values.newPassword})});form.reset();toast("Password changed; other sessions signed out");}catch(problem){error.textContent=problem.message;}finally{button.disabled=false;}});
const settingsCategories=[
  ["account","Account","canonical"],["staff","Staff","canonical"],["business","Business","functional"],["availability","Availability","canonical"],["appointment-schedule","Appointment schedule","placeholder"],["locations","Locations","placeholder"],["permissions","Permissions","functional"],["services","Services","canonical"],["payroll","Payroll","placeholder"],["pet-options","Pet options","canonical"],["tax-payments","Tax & payments","functional"],["discounts","Coupons & discounts","placeholder"],["automated-messages","Automated messages","functional"],["sms-auto-reply","SMS auto-reply","placeholder"],["agreements","Agreements","placeholder"],["online-booking","Online booking","placeholder"],["intake-form","Intake form","placeholder"],["client-portal","Client portal","placeholder"],["loyalty","Loyalty program","placeholder"],["reviews","Review booster","placeholder"],["report-cards","Report card","placeholder"],["integrations","Integrations","placeholder"]
];
const settingsDescriptions={"appointment-schedule":"Configurable appointment policy is not yet available. Calendar display preferences remain under the Calendar gear.",locations:"Pawsh currently supports one active scheduling location per workspace. Multi-location management requires the approved location architecture.",payroll:"Payroll, commissions, and pay runs are not yet available in Pawsh.",discounts:"Manual checkout discounts are supported, but a coupon or discount-program management system is not yet available.","sms-auto-reply":"Pawsh does not currently provide an SMS auto-reply integration.",agreements:"Agreement and waiver template management is not yet available.","online-booking":"Public online-booking configuration is not yet available.","intake-form":"A configurable intake-form builder is not yet available.","client-portal":"Pawsh does not currently provide a client portal.",loyalty:"A points or rewards program is not yet available.",reviews:"Automated external review requests are not yet available.","report-cards":"Configurable grooming report cards are not yet available.",integrations:"No external integrations are currently configured."};
function settingsPathCategory(){const match=location.pathname.match(/^\/settings\/([^/]+)$/);return settingsCategories.some(([id])=>id===match?.[1])?match[1]:"account";}
function settingsLink(title,description,label,target){return `<article class="settings-panel"><h3>${escape(title)}</h3><p>${escape(description)}</p><button type="button" class="primary compact settings-canonical-link" data-target="${target}">${escape(label)}</button></article>`;}
function settingsPlaceholder(id,title){return `<article class="settings-panel settings-placeholder" data-testid="settings-placeholder"><p class="eyebrow">Coming soon</p><h3>${escape(title)}</h3><p>${escape(settingsDescriptions[id]||"This capability is not yet available in Pawsh.")}</p></article>`;}
function renderSettingsCategory(category=settingsPathCategory(),{history="replace"}={}){const definition=settingsCategories.find(([id])=>id===category)||settingsCategories[0],[id,title]=definition,nav=$("#settings-navigation"),content=$("#settings-content");if(!nav||!content)return;nav.innerHTML=settingsCategories.map(([key,label])=>`<button type="button" data-settings-category="${key}" class="${key===id?"active":""}" ${key===id?'aria-current="page"':""}>${escape(label)}</button>`).join("");let html="";if(id==="account")html=settingsLink("Account","Personal identity and password security remain in your canonical account workspace.","Manage profile & security","profile-account");else if(id==="staff")html=settingsLink("Staff","Groomer records, operational eligibility, and active status remain in Salon.","Open Salon team","setup");else if(id==="business")html=`<article class="settings-panel"><h3>Business</h3><p>Manage the workspace name and authoritative timezone, currency, tax rate, and reminder lead time.</p><button type="button" class="primary compact settings-business-action">Edit business settings</button></article>`;else if(id==="availability")html=settingsLink("Availability","Salon owns authoritative operating hours and staff availability. Calendar visible hours remain a personal view preference.","Open Salon availability","setup");else if(id==="permissions")html=allowed("team.manage")?`<article class="settings-panel"><div class="panel-head"><div><h3>Permissions</h3><p>Manage workspace membership and server-authorized access.</p></div><button type="button" class="secondary compact settings-invite">+ Invite</button></div><div id="member-list" class="simple-list"></div><h4>Pending access requests</h4><div id="access-request-list" class="simple-list"></div></article>`:settingsPlaceholder(id,title);else if(id==="services")html=settingsLink("Services","Service names, pricing, durations, and availability have one canonical workspace.","Open Services","services");else if(id==="pet-options")html=settingsLink("Pet options","Breed Catalog and pricing classifications remain location-operational configuration under Salon. Rabies safety rules are not configurable here.","Open Breed Catalog","breed-catalog");else if(id==="tax-payments")html=`<article class="settings-panel"><h3>Tax & payments</h3><p>The server-authoritative tax rate is part of Business settings. Payment recording remains in checkout.</p><button type="button" class="primary compact settings-business-action">Manage tax settings</button></article>`;else if(id==="automated-messages")html=`<article class="settings-panel"><h3>Automated messages</h3><p>Pawsh’s durable reminder/outbox flow uses the configured reminder lead time. Template and channel management are deferred.</p><button type="button" class="primary compact settings-business-action">Manage reminder timing</button></article>`;else html=settingsPlaceholder(id,title);content.innerHTML=`<div class="settings-content-head"><p class="eyebrow">Settings</p><h2>${escape(title)}</h2></div>${html}`;nav.querySelectorAll("[data-settings-category]").forEach(button=>button.addEventListener("click",()=>renderSettingsCategory(button.dataset.settingsCategory,{history:"push"})));content.querySelectorAll(".settings-canonical-link").forEach(button=>button.addEventListener("click",()=>showView(button.dataset.target)));content.querySelectorAll(".settings-business-action").forEach(button=>button.addEventListener("click",actions["business-settings"]));content.querySelector(".settings-invite")?.addEventListener("click",actions["invite-member"]);if(id==="permissions")renderSetup();if(history!=="none")globalThis.history[history==="push"?"pushState":"replaceState"]({view:"admin-settings",settingsCategory:id},"",`/settings/${id}`);content.focus({preventScroll:true});}

async function openClientProfile(customerId,{petId=null,appointmentId=null,returnView=null}={}){
  if(returnView)state.clientProfileReturnView=returnView;
  const previous=state.clientProfile?.data.customer.id===customerId?state.clientProfile:null;
  const [data,notes,agreements]=await Promise.all([api(`/api/customers/${customerId}/history`),loadClientNotes(customerId),loadClientAgreements(customerId)]);
  state.clientProfile={data,notes,agreements,notesExpanded:previous?.notesExpanded||false,tab:previous?.tab||"pets",petId:petId||data.pets[0]?.id||null,appointmentId};
  state.pets=[...state.pets.filter(pet=>pet.customerId!==customerId),...data.pets];activateView("client-profile");renderClientProfile();
}
function petProfileDetails(pet){const values=[["Species",pet.species],["Breed",pet.breed],["Gender",pet.sex],["Weight",pet.weightOunces?`${Number(pet.weightOunces)/16} lb`:null],["Birthday",pet.dateOfBirth?new Date(`${String(pet.dateOfBirth).slice(0,10)}T12:00:00Z`).toLocaleDateString():null],["Age",pet.approximateAge],["Coat",pet.coatNotes],["Behavior",pet.behaviorNotes],["Grooming preferences",pet.groomingPreferences],["Medical",pet.medicalNotes],["Safety",pet.safetyAlerts],["Rabies",pet.vaccinationExpiresOn?`Expires ${new Date(`${String(pet.vaccinationExpiresOn).slice(0,10)}T12:00:00Z`).toLocaleDateString()}`:"Rabies needed"]].filter(([,value])=>value);return values.map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("");}
function openPetProfile(petId){const pet=state.clientProfile?.data.pets.find(item=>item.id===petId);if(!pet)return;openModal(`${pet.name} · Pet Profile`,`<div class="wide pet-profile-modal"><div class="pet-avatar" aria-hidden="true">${escape(Array.from(pet.name)[0]?.toUpperCase()||"P")}</div><div><p class="eyebrow">Pet profile</p><h3>${escape(pet.name)}</h3></div><dl class="pet-profile-facts">${petProfileDetails(pet)}</dl>${allowed("pets.edit")?`<button type="button" class="secondary compact pet-profile-edit">Edit pet</button>`:""}${allowed("pets.care.view")?`<button type="button" class="secondary compact pet-profile-documents">Rabies documents</button>`:""}</div>`,null,{cancelLabel:"Close"});$(".pet-profile-edit")?.addEventListener("click",()=>{$("#modal").close();setTimeout(()=>editPet(pet.id),50);});$(".pet-profile-documents")?.addEventListener("click",()=>{$("#modal").close();setTimeout(()=>showPetDocuments(pet.id),50);});}
function openPreferredGroomer(){const {customer}=state.clientProfile.data,active=state.employees.filter(employee=>employee.active);openModal("Set preferred groomer",`<label class="wide">Preferred groomer<select name="employeeId"><option value="">Not set</option>${active.map(employee=>`<option value="${employee.id}" ${customer.preferredEmployeeId===employee.id?"selected":""}>${escape(employee.displayName)}</option>`).join("")}</select></label>`,async form=>{await api(`/api/customers/${customer.id}/preferred-groomer`,{method:"PATCH",body:JSON.stringify({employeeId:form.get("employeeId")||null})});const data=await api(`/api/customers/${customer.id}/history`);state.clientProfile.data=data;renderClientProfile();},{cancelLabel:"Cancel",submitLabel:"Save"});}
// The profile projection is bounded at 100 appointments; the paginated route supplies the rest
// so the first page is never presented as the client's complete history.
async function loadMoreClientAppointments(){
  const profile=state.clientProfile;if(!profile)return;
  const button=$(".history-view-all");if(button)button.disabled=true;
  try{
    const pageSize=100,page=Math.floor(profile.data.appointments.length/pageSize)+1;
    const next=await api(`/api/customers/${profile.data.customer.id}/appointments?page=${page}&pageSize=${pageSize}`);
    const seen=new Set(profile.data.appointments.map(item=>item.id));
    profile.data.appointments=[...profile.data.appointments,...next.items.filter(item=>!seen.has(item.id))];
    profile.data.appointmentTotal=next.total;
    profile.data.appointmentsTruncated=profile.data.appointments.length<next.total;
    renderClientProfile();
  }catch(error){toast(error.message);if(button)button.disabled=false;}
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
  return `${new Intl.DateTimeFormat([],{dateStyle:"full"}).format(when)} ${new Intl.DateTimeFormat([],{timeStyle:"short"}).format(when)}`;
}
function clientNoteMarkup(note,editable){
  const menu=editable?`<details class="row-menu note-menu"><summary class="row-menu-trigger" aria-expanded="false" aria-label="Actions for note by ${clientAttr(note.authorName)}"><span aria-hidden="true">⋯</span></summary><div class="row-menu-list" role="group" aria-label="Actions for note by ${clientAttr(note.authorName)}"><button type="button" class="row-menu-item note-edit" data-note-id="${clientAttr(note.id)}">Edit</button><button type="button" class="row-menu-item note-pin" data-note-id="${clientAttr(note.id)}">${note.pinned?"Unpin":"Pin to top"}</button><button type="button" class="row-menu-item note-delete" data-note-id="${clientAttr(note.id)}">Delete</button></div></details>`:"";
  // The reference product calls a pinned note a "popup note". Pawsh has no popup surface, so the
  // marker states the behaviour that actually exists: the note is pinned to the top of the thread.
  const marker=note.pinned?`<span class="note-pinned">[pinned]</span> `:"";
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
    +`<label class="inline-check"><input type="checkbox" name="pinned"${note?.pinned?" checked":""}> Pin to the top of the thread</label>`;
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
    await reloadClientProfile();toast(note.pinned?"Note unpinned":"Note pinned");
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
    +`<div class="pref-row pref-row-status"><span class="pref-text"><span class="pref-name">Client status</span><span class="pref-hint">${customer.archivedAt?`Inactive since ${escape(new Date(customer.archivedAt).toLocaleDateString())}. Pawsh has no reactivation flow yet.`:"History is kept. Pawsh has no reactivation flow yet, so this is one-way."}</span></span>${customer.archivedAt?`<span class="status-dot inactive">Inactive</span>`:`<button type="button" class="secondary compact pref-archive"${allowed("customers.edit")?"":" disabled"}>Mark inactive</button>`}</div>`
    +(customer.archivedAt?`<p class="pref-hint">Preferences cannot be changed while the client is inactive.</p>`:"");
}

// Pets. `Fixed` from the reference has no column in Pawsh, so the fourth fact is rabies status,
// which the salon does record and does act on.
function petFactCells(pet){
  const care=allowed("pets.care.view"),locked="Requires Pet Care access";
  const rabies=pet.vaccinationExpiresOn
    ? `Expires ${new Date(`${String(pet.vaccinationExpiresOn).slice(0,10)}T12:00:00Z`).toLocaleDateString()}`
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
  const weight=pet.weightOunces?`${Number(pet.weightOunces)/16} lb`:null;
  const detail=[pet.breed||pet.species||"Pet",weight].filter(Boolean).join(" - ");
  return `<article class="pet-card"><div class="pet-card-head"><span class="pet-avatar" aria-hidden="true">${escape(Array.from(pet.name||"P")[0]?.toUpperCase()||"P")}</span><button type="button" class="pet-card-name" data-pet-profile="${clientAttr(pet.id)}"><strong>${escape(pet.name)}</strong> <span>(${escape(detail)})</span></button></div><dl class="pet-fact-grid">${petFactCells(pet)}</dl>${petNotesMarkup(pet)}</article>`;
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
  const payment=paid?`<span class="history-chip chip-${paid.invoiceStatus==="paid"?"paid":"unpaid"}">${paid.invoiceStatus==="paid"?"Paid":`Unpaid ${money(paid.invoiceBalanceMinor||0)}`}</span>`:"";
  return `<tr class="history-row${item.id===selectedId?" active":""}">`
    +`<td class="history-id"><button type="button" class="text-button" data-profile-appointment="${clientAttr(item.id)}" aria-pressed="${item.id===selectedId}">#${escape(String(item.id).slice(0,8))}</button></td>`
    +`<td class="history-status"><span class="history-chip chip-${clientAttr(item.status)}">${escape(item.status.replace("_"," "))}</span>${payment}</td>`
    +`<td class="history-date">${escape(new Intl.DateTimeFormat([],{dateStyle:"medium",timeZone:zone}).format(start))}<span>${escape(new Intl.DateTimeFormat([],{weekday:"short",hour:"numeric",minute:"2-digit",timeZone:zone}).format(start))}</span></td>`
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
  return `${new Intl.DateTimeFormat([],{dateStyle:"medium"}).format(when)} ${new Intl.DateTimeFormat([],{timeStyle:"short"}).format(when)}`;
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
  return `<li class="agreement-row">`
    +`<div class="agreement-row-main"><p class="agreement-name">${escape(item.name)}${item.required?` <span class="agreement-tag">Required</span>`:""}${item.active?"":` <span class="agreement-tag archived">Archived</span>`}</p>${agreementStateMarkup(item)}</div>`
    +`<div class="agreement-row-action">${action}</div></li>`;
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
    +`<label class="wide">Name the client signed<input name="signedName" type="text" maxlength="120" required autocomplete="off" value="${clientAttr(`${customer.firstName} ${customer.lastName}`.trim())}"></label>`
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

function bindClientAgreements(customerId){
  const agreements=state.clientProfile?.agreements;
  $(".agreements-retry")?.addEventListener("click",()=>runDetached(()=>refreshClientAgreements(customerId)));
  $(".agreements-send")?.addEventListener("click",()=>openAgreementSend(customerId));
  $(".agreement-banner-open")?.addEventListener("click",()=>openAgreementSend(customerId,{preselect:agreements?.summary?.unsignedRequiredTemplateIds||[]}));
  $(".agreement-banner-dismiss")?.addEventListener("click",()=>{dismissedAgreementBanners.add(customerId);renderClientProfile();});
  $$(".agreement-sign").forEach(button=>button.addEventListener("click",()=>openAgreementSignature(customerId,button.dataset.agreementTemplate)));
  $$(".agreement-correct").forEach(button=>button.addEventListener("click",()=>openAgreementCorrection(customerId,button.dataset.agreementTemplate)));
}

function renderClientProfile(){
  const profile=state.clientProfile;if(!profile)return;
  const {data}=profile,customer=data.customer;
  const pet=data.pets.find(item=>item.id===profile.petId)||data.pets[0];
  // The table carries a Pets column and the counts are client-scoped, so history is no longer
  // narrowed to the selected pet: the heading, the table and `Load N more` now agree.
  const appointments=data.appointments;
  const selected=appointments.find(item=>item.id===profile.appointmentId)||null;
  const paid=data.invoices.reduce((sum,item)=>sum+Number(item.totalMinor)-Number(item.balanceMinor),0);
  const outstanding=data.invoices.reduce((sum,item)=>sum+Number(item.balanceMinor),0);
  const tab=profile.tab==="preference"?"preference":"pets";
  const payments=appointmentPaymentIndex();
  const remaining=Math.max(0,Number(data.appointmentTotal||0)-appointments.length);
  const name=`${customer.firstName} ${customer.lastName}`;

  const left=`<section class="client-profile-left">`
    +`<button type="button" class="text-button client-profile-back">← Back</button>`
    +(customer.archivedAt?`<p class="profile-banner">This client is marked inactive. History is kept and new bookings are blocked.</p>`:"")
    +agreementBannerMarkup(profile.agreements,customer.id)
    +`<div class="client-identity"><span class="client-avatar" aria-hidden="true">${escape(Array.from(customer.firstName||"C")[0]?.toUpperCase()||"C")}</span><div><p class="eyebrow">Basic Info</p><h2>${escape(customer.firstName)} ${escape(customer.lastName)}</h2></div>${allowed("customers.edit")?`<button type="button" class="secondary compact client-edit">Edit</button>`:""}</div>`
    +`<dl class="profile-facts"><div><dt>Phone</dt><dd>${escape(customer.phone||"Not provided")}</dd></div><div><dt>Email</dt><dd>${escape(customer.email||"Not provided")}</dd></div><div><dt>Preferred groomer</dt><dd><button type="button" class="text-button preferred-groomer"${allowed("customers.edit")?"":" disabled"}>${escape(customer.preferredEmployeeName||"Not set")}</button></dd></div><div><dt>Client since</dt><dd>${escape(new Date(customer.createdAt).toLocaleDateString())}</dd></div></dl>`
    +`<div class="profile-section-head"><h3>Notes</h3>${allowed("customers.edit")&&!customer.archivedAt?`<button type="button" class="text-button note-add">Add</button>`:""}</div>`
    +`<div class="client-notes">${clientNotesMarkup(profile)}</div>`
    +`<div class="profile-tabs" role="tablist" aria-label="Client detail">`
    +`<button type="button" role="tab" id="client-tab-pets" aria-controls="client-panel-pets" aria-selected="${tab==="pets"}" tabindex="${tab==="pets"?0:-1}" data-client-tab="pets">Pets</button>`
    +`<button type="button" role="tab" id="client-tab-preference" aria-controls="client-panel-preference" aria-selected="${tab==="preference"}" tabindex="${tab==="preference"?0:-1}" data-client-tab="preference">Preference</button></div>`
    +`<div class="profile-panel" role="tabpanel" id="client-panel-pets" aria-labelledby="client-tab-pets" tabindex="0"${tab==="pets"?"":" hidden"}>`
    +(allowed("pets.edit")&&!customer.archivedAt?`<div class="panel-actions"><button type="button" class="secondary compact profile-add-pet">+ Pet</button></div>`:"")
    +`${data.pets.map(petCardMarkup).join("")||`<p class="note-empty">No pets yet.</p>`}</div>`
    +`<div class="profile-panel" role="tabpanel" id="client-panel-preference" aria-labelledby="client-tab-preference" tabindex="0"${tab==="preference"?"":" hidden"}>${clientPreferenceMarkup(customer)}</div>`
    +`</section>`;

  const right=`<section class="client-profile-right">`
    +`<div class="profile-summary"><div><span>Appointments</span><strong>${escape(String(data.appointmentTotal??appointments.length))}</strong></div>${allowed("payments.view")?`<div><span>Paid sales</span><strong>${money(paid)}</strong></div><div><span>Outstanding</span><strong>${money(outstanding)}</strong></div>`:""}</div>`
    +`<div class="panel-head"><div><p class="eyebrow">Appointment history</p><h3>History (${escape(String(data.appointmentTotal??appointments.length))})</h3></div><button type="button" class="primary compact profile-book-new">Book New</button></div>`
    +(appointments.length
      ? `<div class="history-table-wrap" data-allow-horizontal-scroll><table class="history-table"><caption class="visually-hidden">Appointment history for ${escape(name)}</caption><thead><tr><th scope="col">ID</th><th scope="col">Status</th><th scope="col">Date</th><th scope="col">Pets</th><th scope="col">Items</th><th scope="col">Total Sales</th><th scope="col">Duration</th><th scope="col">Groomer</th></tr></thead><tbody>${appointments.map(item=>historyRowMarkup(item,{pets:data.pets,payments,selectedId:selected?.id})).join("")}</tbody></table></div>`
      : `<p class="note-empty">No appointments recorded for this client.</p>`)
    +(remaining?`<div class="history-more"><span>Showing ${escape(String(appointments.length))} of ${escape(String(data.appointmentTotal))}</span><button type="button" class="secondary compact history-view-all">Load ${escape(String(remaining))} more</button></div>`:"")
    +(selected?`<article class="profile-appointment-detail"><h4>Selected appointment</h4><p><strong>Groomer:</strong> ${escape(selected.employeeName)}</p>${selected.notes?`<p><strong>Notes:</strong> ${escape(selected.notes)}</p>`:""}</article>`:"")
    +(allowed("payments.view")&&data.invoices.length?`<section class="profile-invoices"><h4>Invoices</h4>${data.invoices.slice(0,20).map(invoice=>`<div><span>${escape(invoice.invoiceNumber)} · ${escape(new Date(invoice.createdAt).toLocaleDateString())}</span><strong>${money(invoice.totalMinor)} · ${escape(invoice.status)}</strong></div>`).join("")}</section>`:"")
    +clientAgreementsPanelMarkup(profile.agreements)
    +`</section>`;

  $("#client-profile-content").innerHTML=left+right;
  bindNoteMenus();
  bindClientAgreements(customer.id);

  $(".client-profile-back").addEventListener("click",()=>showView(state.clientProfileReturnView||"customers"));
  $(".client-edit")?.addEventListener("click",()=>editCustomer(customer.id));
  $(".preferred-groomer")?.addEventListener("click",openPreferredGroomer);
  $(".profile-book-new").addEventListener("click",()=>{state.calendar.bookingCustomerId=customer.id;state.calendar.bookingPetId=pet?.id||null;actions["new-appointment"]();});
  $(".history-view-all")?.addEventListener("click",loadMoreClientAppointments);
  $$('[data-profile-appointment]').forEach(button=>button.addEventListener("click",()=>{
    profile.appointmentId=profile.appointmentId===button.dataset.profileAppointment?null:button.dataset.profileAppointment;renderClientProfile();
  }));

  $(".note-add")?.addEventListener("click",addClientNote);
  $(".notes-retry")?.addEventListener("click",()=>runDetached(reloadClientProfile));
  $(".note-toggle")?.addEventListener("click",()=>{profile.notesExpanded=!profile.notesExpanded;renderClientProfile();});
  $$(".note-edit").forEach(button=>button.addEventListener("click",()=>{closeNoteMenus();editClientNote(button.dataset.noteId);}));
  $$(".note-pin").forEach(button=>button.addEventListener("click",()=>{closeNoteMenus();runDetached(()=>toggleClientNotePin(button.dataset.noteId));}));
  $$(".note-delete").forEach(button=>button.addEventListener("click",()=>{closeNoteMenus();runDetached(()=>deleteClientNote(button.dataset.noteId));}));
  $$(".note-menu").forEach(menu=>menu.addEventListener("toggle",()=>{
    menu.querySelector("summary")?.setAttribute("aria-expanded",String(menu.open));
    if(menu.open)$$(".note-menu[open]").forEach(other=>{if(other!==menu){other.open=false;other.querySelector("summary")?.setAttribute("aria-expanded","false");}});
  }));

  const tabs=$$("[data-client-tab]");
  const selectTab=(next,{focus=false}={})=>{profile.tab=next;renderClientProfile();if(focus)$(`[data-client-tab="${next}"]`)?.focus();};
  tabs.forEach(button=>{
    button.addEventListener("click",()=>selectTab(button.dataset.clientTab));
    button.addEventListener("keydown",event=>{
      if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
      event.preventDefault();
      const index=tabs.indexOf(button);
      const next=event.key==="Home"?0:event.key==="End"?tabs.length-1:(index+(event.key==="ArrowRight"?1:-1)+tabs.length)%tabs.length;
      selectTab(tabs[next].dataset.clientTab,{focus:true});
    });
  });

  $(".profile-add-pet")?.addEventListener("click",()=>{
    actions["new-pet"]();
    const select=$('#modal select[name="customerId"]');
    if(select)select.value=customer.id;
    $("#modal").addEventListener("close",()=>runDetached(reloadClientProfile),{once:true});
  });
  $(".pref-archive")?.addEventListener("click",()=>runDetached(archiveClientFromProfile));
  $$("[data-pref-switch]").forEach(input=>input.addEventListener("change",()=>{
    const key=input.dataset.prefSwitch;
    const definition=CLIENT_PREFERENCE_SWITCHES.find(([id])=>id===key);
    if(!definition)return;
    const [,label,inverted]=definition;
    runDetached(()=>saveClientPreference({[key]:inverted?!input.checked:input.checked},label));
  }));
  const frequency=$("#pref-booking-frequency");
  frequency?.addEventListener("change",()=>{
    const raw=frequency.value.trim();
    if(!raw)return runDetached(()=>saveClientPreference({bookingFrequencyWeeks:null},"Booking frequency"));
    const weeks=Number(raw);
    if(!Number.isInteger(weeks)||weeks<1||weeks>104){toast("Booking frequency must be a whole number of weeks between 1 and 104");renderClientProfile();return;}
    runDetached(()=>saveClientPreference({bookingFrequencyWeeks:weeks},"Booking frequency"));
  });
}
async function openCalendarAppointment(id,origin=null){const item=calendarAppointmentById(id);if(!item)return;calendarDetailOrigin=origin||document.activeElement;hideCalendarHover();const model=appointmentPresentation(item),serviceRows=model.serviceSnapshots.map(service=>`<div><span><strong>${escape(service.name)}</strong><small>${Number(service.durationMinutes)} min</small></span><strong>${service.priceMinor===null||service.priceMinor===undefined?"Price unavailable":money(service.priceMinor)}</strong></div>`).join("");openModal("Appointment",`<article class="wide appointment-detail" data-testid="appointment-detail"><header><div><span class="appointment-status">${escape(model.status)}</span><h3>${escape(model.dateLabel)}</h3><p>${escape(model.timeRange)} · ${model.durationMinutes} min</p></div></header><section><h4>Client</h4><button type="button" class="text-button appointment-detail-client">${escape(model.customerName)}</button>${item.customerPhone?`<p>${escape(item.customerPhone)}</p>`:""}</section><section><h4>Pet</h4><p><strong>${escape(model.petName)}</strong>${model.breed?` · ${escape(model.breed)}`:""}</p>${model.rabiesNeeded?`<p class="rabies-needed">Rabies needed</p>`:""}${model.warning?`<p class="detail-warning">${escape(model.warning)}</p>`:""}</section><section><h4>Groomer</h4><p>${escape(model.groomer)}</p></section><section class="appointment-detail-services"><h4>Services</h4>${serviceRows}</section><section class="appointment-detail-summary"><span>Total</span><strong>${model.durationMinutes} min${model.totalPriceMinor!==null?` · ${money(model.totalPriceMinor)}`:""}</strong></section>${item.notes?`<section><h4>Notes</h4><p>${escape(item.notes)}</p></section>`:""}<footer><button type="button" class="secondary compact appointment-detail-client">View client</button>${item.status==="scheduled"&&allowed("appointments.edit")?`<button type="button" class="secondary compact appointment-detail-move">Move</button>`:""}${["checked_in","in_service"].includes(item.status)&&allowed("appointments.edit")?`<button type="button" class="secondary compact appointment-detail-services-action">Adjust services</button>`:""}</footer></article>`,null,{cancelLabel:"Close"});const dialog=$("#modal");dialog.classList.add("appointment-detail-dialog");dialog.querySelector(".modal-head .close").setAttribute("aria-label","Close appointment details");dialog.querySelector(".modal-head .close").focus();const next=callback=>{dialog.close();setTimeout(callback,50);};dialog.querySelectorAll(".appointment-detail-client").forEach(button=>button.addEventListener("click",()=>next(()=>openClientProfile(item.customerId,{petId:item.petId,appointmentId:item.id,returnView:"calendar"}))));dialog.querySelector(".appointment-detail-move")?.addEventListener("click",()=>next(()=>moveAppointment(id)));dialog.querySelector(".appointment-detail-services-action")?.addEventListener("click",()=>next(()=>adjustServices(id)));}
function renderMessages(){const query=($("#message-search")?.value||"").trim().toLowerCase(),clients=state.customerDirectory.items.filter(item=>`${item.firstName} ${item.lastName} ${item.phone||""} ${item.email||""}`.toLowerCase().includes(query));$("#message-client-list").innerHTML=clients.map(item=>`<button type="button" class="message-client ${item.id===state.messageClientId?"active":""}" data-message-client="${item.id}"><span><strong>${escape(item.firstName)} ${escape(item.lastName)}</strong><small>${escape(item.phone||item.email||"No contact details")}</small></span></button>`).join("")||`<p class="empty">No clients match.</p>`;$$('[data-message-client]').forEach(button=>button.addEventListener("click",()=>selectMessageClient(button.dataset.messageClient)));}
async function selectMessageClient(id){const data=await api(`/api/customers/${id}/history`);state.messageClientId=id;renderMessages();const name=`${data.customer.firstName} ${data.customer.lastName}`;$("#message-thread").innerHTML=`<header><a class="message-client-link" href="/clients/${id}" target="_blank" rel="noopener">${escape(name)}</a></header><div class="message-disabled-state"><h3>Messaging is not connected</h3><p>No conversation history, inbound webhook, SMS provider, delivery status, or scheduler is configured.</p></div><footer><textarea disabled aria-label="Message composer" placeholder="Messaging unavailable"></textarea><button type="button" class="primary" disabled>Send</button></footer>`;$("#message-client-context").innerHTML=`<p class="eyebrow">Client</p><h3>${escape(name)}</h3><dl class="profile-facts"><div><dt>Phone</dt><dd>${escape(data.customer.phone||"Not provided")}</dd></div><div><dt>Email</dt><dd>${escape(data.customer.email||"Not provided")}</dd></div></dl><h4>Pets</h4>${data.pets.map(pet=>`<button type="button" class="context-pet" data-context-pet="${pet.id}"><strong>${escape(pet.name)}</strong><span>${escape(pet.breed||"Breed not provided")}</span></button>`).join("")||"<p>No pets.</p>"}<button type="button" class="secondary compact open-context-profile">Open full profile</button>`;$(".open-context-profile").addEventListener("click",()=>openClientProfile(id,{returnView:"messages"}));}
const reminderTabs=[["appointment_reminder","Appointment Reminder","supported"],["secondary_reminder","Secondary Reminder","deferred"],["same_day_reminder","Same-Day Reminder","deferred"],["rebook_reminder","Rebook Reminder","deferred"],["vaccination_reminder","Vaccination Reminder","supported"],["birthday_reminder","Pet Birthday Reminder","deferred"]];
async function loadReminders(type=state.reminders.type){state.reminders.type=type;const result=await api(`/api/reminders?type=${encodeURIComponent(type)}`);state.reminders={type,items:result.items,supported:result.supported};renderReminders();}
function renderReminders(){const {type,items,supported}=state.reminders;$("#reminder-tabs").innerHTML=reminderTabs.map(([id,label])=>`<button type="button" role="tab" data-reminder-tab="${id}" aria-selected="${id===type}">${escape(label)}</button>`).join("");$$('[data-reminder-tab]').forEach(button=>button.addEventListener("click",()=>loadReminders(button.dataset.reminderTab)));if(!supported){$("#reminder-content").innerHTML=`<div class="reminder-empty"><p class="eyebrow">Deferred</p><h3>${escape(reminderTabs.find(([id])=>id===type)?.[1]||"Reminder")}</h3><p>This reminder type has no Pawsh scheduling or delivery backend yet. No records or actions are fabricated.</p></div>`;return;}$("#reminder-content").innerHTML=`<div class="reminder-table-wrap"><table class="reminder-table"><thead><tr><th>Record ID</th><th>Status</th><th>Time</th><th>Client</th><th>Reminder Status</th><th>Action</th><th>Logs</th></tr></thead><tbody>${items.map(item=>`<tr><td><code>${escape(String(item.appointmentId||item.id).slice(0,8))}</code></td><td><span class="status-dot">${escape(item.appointmentStatus||"Scheduled")}</span></td><td>${new Intl.DateTimeFormat([],{dateStyle:"medium",timeStyle:"short"}).format(new Date(item.scheduledOccurrence))}</td><td>${escape([item.firstName,item.lastName].filter(Boolean).join(" ")||"Staff notification")}</td><td><span class="badge ${escape(item.reminderStatus)}">${escape(item.reminderStatus.replace("_"," "))}</span></td><td>${["pending","failed"].includes(item.reminderStatus)&&allowed("appointments.edit")?`<button type="button" class="secondary compact reminder-send" data-reminder-id="${item.id}">${item.reminderStatus==="failed"?"Retry":"Send"}</button>`:"—"}</td><td><button type="button" class="icon-action reminder-logs" data-reminder-id="${item.id}" aria-label="Show reminder logs" aria-expanded="false">+</button></td></tr><tr class="reminder-log-row" data-reminder-logs="${item.id}" hidden><td colspan="7">${item.logs.length?item.logs.map(log=>`<div class="reminder-log"><time>${new Date(log.createdAt).toLocaleString()}</time><span>${escape(item.channel)} · ${escape(item.destination)}</span><strong>${escape(log.outcome)}</strong>${log.safeFailureReason?`<small>${escape(log.safeFailureReason)}</small>`:""}</div>`).join(""):`<span class="empty">No delivery attempts yet.</span>`}</td></tr>`).join("")||`<tr><td colspan="7" class="empty">No reminders in this workspace.</td></tr>`}</tbody></table></div>`;$$('.reminder-logs').forEach(button=>button.addEventListener("click",()=>{const row=$(`[data-reminder-logs="${button.dataset.reminderId}"]`),open=row.hidden;row.hidden=!open;button.textContent=open?"−":"+";button.setAttribute("aria-expanded",String(open));}));$$('.reminder-send').forEach(button=>button.addEventListener("click",async()=>{button.disabled=true;try{await api(`/api/reminders/${button.dataset.reminderId}/send`,{method:"POST"});toast("Reminder queued for delivery");await loadReminders();}catch(error){toast(error.message);button.disabled=false;}}));}
async function hydrateReminderLogs(button){try{const detail=await api(`/api/reminders/${button.dataset.reminderId}/logs`),row=$(`[data-reminder-logs="${button.dataset.reminderId}"] td`);if(!row)return;row.innerHTML=detail.logs.length?detail.logs.map(log=>`<div class="reminder-log"><time>${new Date(log.createdAt).toLocaleString()}</time><span>${escape(detail.channel)} · ${escape(detail.destination)}</span><strong>${escape(log.attemptKind)} · ${escape(log.outcome)}</strong>${log.safeFailureReason?`<small>${escape(log.safeFailureReason)}</small>`:""}</div>`).join(""):`<span class="empty">No delivery attempts yet.</span>`;}catch(error){toast(error.message);}}
document.addEventListener("click",event=>{const button=event.target.closest?.(".reminder-logs");if(button)hydrateReminderLogs(button);},{capture:true});
document.addEventListener("click",event=>{const button=event.target.closest?.("[data-pet-profile]");if(!button)return;event.stopImmediatePropagation();const petId=button.dataset.petProfile;state.clientProfile.petId=petId;state.clientProfile.appointmentId=null;renderClientProfile();api(`/api/pets/${petId}`).then(pet=>{state.clientProfile.data.pets=state.clientProfile.data.pets.map(item=>item.id===petId?pet:item);openPetProfile(petId);}).catch(error=>toast(error.message));},{capture:true});
$$('[data-action]').forEach((button) => button.addEventListener("click", () => actions[button.dataset.action]?.()));
$("#service-search")?.addEventListener("input",renderServices);$("#service-category-filter")?.addEventListener("change",renderServices);$("#service-status-filter")?.addEventListener("change",renderServices);$("#service-filter-reset")?.addEventListener("click",()=>{$("#service-search").value="";$("#service-category-filter").value="all";$("#service-status-filter").value="active";renderServices();});
$("#message-search")?.addEventListener("input",renderMessages);
$("#report-charts-mode")?.addEventListener("click",()=>{state.reportMode="charts";renderReports();});
$("#report-table-mode")?.addEventListener("click",()=>{state.reportMode="table";renderReports();});
$("#report-apply")?.addEventListener("click",async()=>{state.reports=await api(`/api/reports?${reportQuery()}`);renderReports();});
const viewPaths={dashboard:"/",calendar:"/",customers:"/",messages:"/",reminders:"/","sales-expense":"/",product:"/",services:"/",setup:"/","breed-catalog":"/salon/breeds","admin-settings":"/settings",reports:"/","profile-account":"/account","intake-submissions":"/intake-submissions","client-profile":"/clients"};
function viewForPath(path){if(path==="/account")return "profile-account";if(path==="/intake-submissions")return "intake-submissions";if(path.startsWith("/clients/"))return "client-profile";if(path==="/settings"||path.startsWith("/settings/"))return "admin-settings";return path==="/salon/breeds"||path==="/reports/breeds"||path==="/overview/breeds"?"breed-catalog":"dashboard";}
function closeSetupMenus(){$$(".setup-menu[open]").forEach(menu=>menu.open=false);}
$$("nav [data-view]").forEach((button) => button.addEventListener("click", () => {$("#primary-navigation").classList.remove("mobile-open");$("#mobile-nav-toggle").setAttribute("aria-expanded","false");$("#mobile-nav-toggle").setAttribute("aria-label","Open navigation");showView(button.dataset.view);}));
$("#mobile-nav-toggle").addEventListener("click",event=>{const open=$("#primary-navigation").classList.toggle("mobile-open");event.currentTarget.setAttribute("aria-expanded",String(open));event.currentTarget.setAttribute("aria-label",open?"Close navigation":"Open navigation");});
$$("[data-view-target]").forEach((button) => button.addEventListener("click", () => {closeAccountMenu();closeSetupMenus();showView(button.dataset.viewTarget);}));
$$("[data-view-link]").forEach(link=>link.addEventListener("click",event=>{event.preventDefault();closeSetupMenus();showView(link.dataset.viewLink);}));
$$(".setup-menu").forEach(menu=>{const summary=menu.querySelector("summary");menu.addEventListener("toggle",()=>summary.setAttribute("aria-expanded",String(menu.open)));menu.addEventListener("keydown",event=>{if(event.key==="Escape"&&menu.open){event.preventDefault();menu.open=false;summary.focus();}});});
document.addEventListener("click",event=>$$(".setup-menu[open]").forEach(menu=>{if(!menu.contains(event.target))menu.open=false;}));
globalThis.addEventListener("popstate",()=>showView(viewForPath(location.pathname),{history:"none"}));
async function showView(view,{history="push"}={}) {
  if(!activateView(view,{history}))return;
  try{
    state.me=await api("/api/me");applyPermissions();renderLocationSwitcher();
    if(view==="calendar")await openCalendarView();
    if(view==="customers")await loadCustomerDirectory(state.customerDirectory.page||1);
    if(view==="messages")renderMessages();
    if(view==="reminders")await loadReminders();
    if(view==="client-profile"){const customerId=location.pathname.match(/^\/clients\/([^/]+)$/)?.[1];if(customerId&&!state.clientProfile)await openClientProfile(customerId);else renderClientProfile();}
    if(view==="breed-catalog")renderBreedCatalog();
    if(view==="profile-account")renderAccountIdentity();
    if(view==="admin-settings")renderSettingsCategory(settingsPathCategory(),{history:history==="none"?"none":"replace"});
    if($(`[data-view="${view}"]`)?.hidden){
      activateView("dashboard",{history:"replace"});
    }
  }catch{return bootstrap();}
}
function activateView(view,{history="push"}={}) {
  closeCalendarMenus();
  const target=$(`#${view}`);if(!target||$(`[data-view="${view}"]`)?.hidden)return;
  const canonicalPath=view==="client-profile"&&state.clientProfile?`/clients/${state.clientProfile.data.customer.id}`:viewPaths[view];if(canonicalPath&&history!=="none"&&view!=="admin-settings"&&(location.pathname!==canonicalPath||view==="breed-catalog")){globalThis.history[history==="replace"?"replaceState":"pushState"]({view},"",canonicalPath);}
  $$(".view").forEach(v=>v.hidden=v.id!==view); $$("nav button").forEach(b=>{const active=b.dataset.view===view||view==="breed-catalog"&&b.dataset.view==="setup";b.classList.toggle("active",active);if(active)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current");});const servicesHeader=$("[data-testid=header-services]");servicesHeader?.classList.toggle("active",view==="services");if(view==="services")servicesHeader?.setAttribute("aria-current","page");else servicesHeader?.removeAttribute("aria-current"); $("#page-kicker").textContent=view==="breed-catalog"?"Salon":view==="profile-account"?"Your account":view==="admin-settings"?"Administration":"Daily operations"; $("#page-title").textContent={dashboard:"Dashboard",calendar:"Calendar",customers:"Clients",messages:"Messages",reminders:"Reminders","sales-expense":"Sales & Expense",product:"Product",services:"Services",setup:"Salon","breed-catalog":"Salon","admin-settings":"Settings",reports:"Report","profile-account":"Profile & Account"}[view];
  if(view==="client-profile"){$("#page-title").textContent="Client Profile";$("#page-kicker").textContent="Relationships";}
  if(view==="intake-submissions"){$("#page-title").textContent="Intake Form Submissions";$("#page-kicker").textContent="Client intake";}
  if(view==="breed-catalog")renderBreedCatalog();
  return true;
}
$$(".close").forEach((button)=>button.addEventListener("click",()=>$("#modal").close()));
$("#modal").addEventListener("close",()=>{const dialog=$("#modal");dialog.classList.remove("appointment-detail-dialog");dialog.querySelector(".modal-head .close").setAttribute("aria-label","Close");if(calendarDetailOrigin?.isConnected)calendarDetailOrigin.focus();calendarDetailOrigin=null;});
$("#archived-care-records")?.addEventListener("click",showArchivedCareRecords);
$("#customer-search").addEventListener("input", async (event)=>{
  const sequence=++customerSearchSequence;
  await new Promise(resolve=>setTimeout(resolve,180));if(sequence!==customerSearchSequence)return;
  const params=new URLSearchParams({paged:"true",page:"1",pageSize:"25",q:event.target.value,status:$("#customer-status").value,upcoming:$("#customer-upcoming").value,sort:$("#customer-sort").value});
  const customers=await api(`/api/customers?${params}`);
  if(sequence!==customerSearchSequence)return;
  state.customerDirectory=customers;state.customers=customers.items;renderCustomersEnhanced();
});
[$("#customer-status"),$("#customer-upcoming"),$("#customer-sort")].forEach(control=>control.addEventListener("change",()=>loadCustomerDirectory(1)));
$("#customer-prev").addEventListener("click",()=>loadCustomerDirectory(state.customerDirectory.page-1));$("#customer-next").addEventListener("click",()=>loadCustomerDirectory(state.customerDirectory.page+1));
$("#breed-search")?.addEventListener("input",event=>{state.breedCatalog.query=event.target.value;renderBreedCatalog();});
$("#breed-show-inactive")?.addEventListener("change",event=>{state.breedCatalog.showInactive=event.target.checked;renderBreedCatalog();});
$("#breed-sort-name")?.addEventListener("click",()=>{state.breedCatalog.sortDirection*=-1;$("#breed-sort-name span").textContent=state.breedCatalog.sortDirection===1?"A–Z":"Z–A";renderBreedCatalog();});
$("#breed-add-form")?.addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,errorBox=$("#breed-add-error");errorBox.textContent="";form.elements.name.removeAttribute("aria-invalid");try{const values=Object.fromEntries(new FormData(form));await api("/api/dog-breeds",{method:"POST",body:JSON.stringify(values)});form.reset();await reloadBreeds();toast("Breed added");}catch(error){errorBox.textContent=error.message;if(error.status===409&&error.data?.existing&&!error.data.existing.active){const button=document.createElement("button");button.type="button";button.className="text-button";button.textContent=`Reactivate ${error.data.existing.name}`;button.addEventListener("click",()=>toggleBreed(error.data.existing.id,true));errorBox.append(" ",button);}form.elements.name.setAttribute("aria-invalid","true");}});
function printRangeDefaults(){if(state.calendar.view==="day"||state.calendar.view==="month")return [state.calendar.selectedDate,state.calendar.selectedDate];return [state.calendar.weekStart,dateShift(state.calendar.weekStart,6)];}
function printableAgenda(items){const sorted=items.slice().sort((a,b)=>new Date(a.startAt)-new Date(b.startAt));return sorted.length?sorted.map(item=>{const model=appointmentPresentation(item);return `<article class="print-appointment"><header><strong>${escape(model.groomer)}</strong><span>${escape(model.dateLabel)} · ${escape(model.timeRange)}</span></header><div><p><b>Pet:</b> ${escape(model.petName)}${model.breed?` · ${escape(model.breed)}`:""}</p><p><b>Services:</b> ${model.services.map(escape).join(", ")}</p><p><b>Client:</b> ${escape(model.customerName)}${item.customerPhone?` · ${escape(item.customerPhone)}`:""}</p>${item.notes?`<p><b>Appointment note:</b> ${escape(item.notes)}</p>`:""}</div></article>`;}).join(""):`<p>No appointments in this print range.</p>`;}
async function printAgendaItems(form){const start=String(form.get("printStart")),end=String(form.get("printEnd")),days=Math.round((dateAt(end)-dateAt(start))/86400000)+1;if(!start||!end||days<1||days>31)throw new Error("Choose a print range from 1 to 31 days.");const groomerId=String(form.get("printGroomer")||""),items=filteredAppointments(await loadAppointmentRange(start,days));return groomerId?items.filter(item=>(item.groomers||[]).some(groomer=>groomer.id===groomerId)):items;}
async function openPrintAgenda(){const [start,end]=printRangeDefaults(),groomers=selectedGroomers();openModal("Print agenda",`<div class="wide print-controls"><label>From<input type="date" name="printStart" value="${start}" required></label><label>To<input type="date" name="printEnd" value="${end}" required></label><label>Groomer<select name="printGroomer"><option value="">All selected groomers</option>${groomers.map(item=>`<option value="${item.id}">${escape(item.displayName)}</option>`).join("")}</select></label><button type="button" class="secondary compact" id="print-preview-update">Update preview</button></div><section id="print-agenda-preview" class="wide print-agenda-preview" aria-live="polite">Loading preview…</section>`,async form=>{const items=await printAgendaItems(form),printRoot=document.createElement("section");printRoot.className="print-root";printRoot.innerHTML=`<h1>Pawsh agenda</h1>${printableAgenda(items)}`;document.body.append(printRoot);globalThis.print();setTimeout(()=>printRoot.remove(),1000);},{cancelLabel:"Close",submitLabel:"Print"});const refreshPreview=async()=>{try{$("#print-agenda-preview").innerHTML=printableAgenda(await printAgendaItems(new FormData($("#modal-form"))));}catch(error){$("#modal-error").textContent=error.message;}};$("#print-preview-update").addEventListener("click",refreshPreview);await refreshPreview();}
function openCalendarSettings(){const preferences=calendarPreferences(),derived=state.businessHours.flatMap(period=>[String(period.startTime).slice(0,5),String(period.endTime).slice(0,5)]).map(value=>Number(value.slice(0,2))*60+Number(value.slice(3,5))),fallback=derived.length?[Math.min(...derived),Math.max(...derived)]:[480,1140],start=preferences.visibleStart??fallback[0],end=preferences.visibleEnd??fallback[1];openModal("Calendar settings",`<p class="wide settings-note">These preferences change only your calendar view. Salon business hours and booking rules remain unchanged.</p><label>Visible from<select name="visibleStart">${Array.from({length:33},(_,i)=>i*30+300).map(value=>`<option value="${value}" ${value===start?"selected":""}>${timeLabel(value)}</option>`).join("")}</select></label><label>Visible until<select name="visibleEnd">${Array.from({length:33},(_,i)=>i*30+480).map(value=>`<option value="${value}" ${value===end?"selected":""}>${timeLabel(value)}</option>`).join("")}</select></label><label>First day of week<select name="firstDay"><option value="sunday" ${preferences.firstDay==="sunday"?"selected":""}>Sunday</option><option value="monday" ${preferences.firstDay==="monday"?"selected":""}>Monday</option></select></label><label>Calendar density<select name="density"><option value="compact" ${preferences.density==="compact"?"selected":""}>Compact</option><option value="comfortable" ${preferences.density==="comfortable"?"selected":""}>Comfortable</option><option value="large" ${preferences.density==="large"?"selected":""}>Large</option></select></label><label class="wide">Appointment detail<select name="detail"><option value="compact" ${preferences.detail==="compact"?"selected":""}>Compact</option><option value="detailed" ${preferences.detail==="detailed"?"selected":""}>Detailed</option></select></label><button type="button" class="text-button wide" id="calendar-settings-reset">Reset to defaults</button>`,form=>{const next={visibleStart:Number(form.get("visibleStart")),visibleEnd:Number(form.get("visibleEnd")),firstDay:String(form.get("firstDay")),density:String(form.get("density")),detail:String(form.get("detail"))};if(next.visibleStart>=next.visibleEnd)throw new Error("Visible start must be before visible end.");state.calendar.preferences=next;globalThis.localStorage.setItem(calendarPreferenceKey(),JSON.stringify(next));state.calendar.weekStart=weekStart(state.calendar.selectedDate);applyCalendarPreferences();return ()=>loadCalendarWeek();},{cancelLabel:"Cancel",submitLabel:"Apply changes"});$("#calendar-settings-reset").addEventListener("click",()=>{globalThis.localStorage.removeItem(calendarPreferenceKey());state.calendar.preferences=null;$("#modal").close();applyCalendarPreferences();state.calendar.weekStart=weekStart(state.calendar.selectedDate);runDetached(loadCalendarWeek);});}
function applyCalendarPreferences(){const preferences=calendarPreferences(),shell=$("#calendar");shell.dataset.calendarDensity=preferences.density;shell.dataset.calendarDetail=preferences.detail;}
function calendarStep(direction){if(state.calendar.view==="day")return selectCalendarDate(dateShift(state.calendar.selectedDate,direction));if(state.calendar.view==="week")return selectCalendarDate(dateShift(state.calendar.weekStart,direction*7));const date=dateAt(`${state.calendar.month}-01`);date.setUTCMonth(date.getUTCMonth()+direction);state.calendar.month=date.toISOString().slice(0,7);state.calendar.selectedDate=`${state.calendar.month}-01`;state.calendar.weekStart=weekStart(state.calendar.selectedDate);return loadCalendarWeek();}
$("#calendar-today").addEventListener("click",()=>runDetached(()=>selectCalendarDate(businessDate())));$("#calendar-prev-week").addEventListener("click",()=>runDetached(()=>calendarStep(-1)));$("#calendar-next-week").addEventListener("click",()=>runDetached(()=>calendarStep(1)));
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
bootstrap();
