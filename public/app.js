const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const inviteToken = new URLSearchParams(location.search).get("invite");
const resetToken = new URLSearchParams(location.search).get("reset");
const state = { me: null, customers: [], customerDirectory:{items:[],total:0,page:1,pageSize:25}, pets: [], dogBreeds: [], breedCatalog:{query:"",showInactive:false,sortDirection:1,editingId:null}, employees: [], services: [], appointments: [], businessHours:[], calendar:{selectedDate:null,weekStart:null,month:null,monthAppointmentDates:[],employeeId:"",view:"week",bookingPreset:null,bookingGroomerId:null,opened:false}, members: [], accessRequests:[], workspaces:[], reports: null, login: false };
const pendingActions = new Set();
let customerSearchSequence = 0;

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !(options.body instanceof FormData)) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers
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
    activateView(viewForPath(location.pathname),{history:"replace"});
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
    api("/api/workspaces")
  ];
  const [dashboard, customerDirectory, pets, employees, services, appointments, members, reports, dogBreeds, accessRequests, workspaces] = await Promise.all(requests);
  Object.assign(state, { customerDirectory,customers:customerDirectory.items||[], pets, employees, services, appointments, members, reports, dogBreeds, accessRequests, workspaces });
  renderAccountIdentity();
  $("#calendar-employee-filter").innerHTML=`<option value="">All employees</option>${employees.filter(employee=>employee.active).map(employee=>`<option value="${employee.id}" ${employee.id===state.calendar.employeeId?"selected":""}>${escape(employee.displayName)}</option>`).join("")}`;
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
function weekStart(value){const date=dateAt(value);return dateShift(value,-date.getUTCDay());}
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
  $$(".appointment-action").forEach((button) => button.addEventListener("click", () => advanceAppointment(button.dataset.id, button.dataset.status, button)));
  $$(".terminal-action").forEach(button=>button.addEventListener("click",()=>terminalAppointment(button.dataset.id,button.dataset.status)));
  $$(".move-action").forEach(button=>button.addEventListener("click",()=>moveAppointment(button.dataset.id)));
  $$(".service-action").forEach(button=>button.addEventListener("click",()=>adjustServices(button.dataset.id)));
}
function calendarHours(){
  const values=state.businessHours.flatMap(period=>[String(period.startTime).slice(0,5),String(period.endTime).slice(0,5)]).map(value=>Number(value.slice(0,2))*60+Number(value.slice(3,5)));
  return values.length?[Math.floor(Math.min(...values)/30)*30,Math.ceil(Math.max(...values)/30)*30]:[8*60,19*60];
}
function timeLabel(minutes){const hour=Math.floor(minutes/60),minute=minutes%60;return new Intl.DateTimeFormat([],{hour:"numeric",minute:"2-digit"}).format(new Date(2020,0,1,hour,minute));}
function calendarAction(item){
  const definition={scheduled:["Check in","operations.check_in"],checked_in:["Start service","operations.perform_service"],in_service:["Complete","operations.complete"],completed:["Checkout","checkout.perform"]}[item.status];
  const controls=[`<button type="button" role="menuitem" class="calendar-action view-appointment-action" data-id="${item.id}">View / Edit</button>`];
  if(definition&&allowed(definition[1]))controls.unshift(`<button role="menuitem" data-testid="appointment-${item.status}" class="calendar-action appointment-action" data-id="${item.id}" data-status="${item.status}">${definition[0]}</button>`);
  if(item.status==="scheduled"&&allowed("appointments.edit"))controls.push(`<button type="button" role="menuitem" class="calendar-action move-action" data-id="${item.id}">Move</button>`);
  if(item.status==="scheduled"&&allowed("appointments.cancel")){controls.push(`<button type="button" role="menuitem" class="calendar-action terminal-action destructive" data-id="${item.id}" data-status="cancelled">Cancel appointment</button>`);controls.push(`<button type="button" role="menuitem" class="calendar-action terminal-action" data-id="${item.id}" data-status="no_show">No show</button>`);}
  if(["checked_in","in_service"].includes(item.status)&&allowed("appointments.edit"))controls.push(`<button type="button" role="menuitem" class="calendar-action service-action" data-id="${item.id}">Adjust services</button>`);
  return `<div class="calendar-actions-menu"><button type="button" class="calendar-action-trigger" aria-label="Appointment actions for ${escape(item.petName)}" aria-haspopup="menu" aria-expanded="false" data-appointment-menu="${item.id}">&#8943;</button><div class="calendar-action-popover" role="menu" hidden>${controls.join("")}</div></div>`;
}
function appointmentCard(item,{day=false,style="",groomerId="",overlap=false}={}){
  const groomerNames=(item.groomers||[]).map(groomer=>groomer.displayName).join(", ")||item.employeeName;
  const services=item.services.map(service=>service.name).join(", ");
  return `<article class="${day?"day-appointment ":""}week-appointment status-${escape(item.status)} ${overlap?"overlap":""}" data-appointment-id="${item.id}" ${groomerId?`data-groomer-id="${groomerId}"`:""} style="${style}"><button type="button" class="calendar-open" data-calendar-appointment="${item.id}" aria-label="Open ${escape(item.petName)} appointment"><time>${schedulingTime(item)}</time><strong>${escape(item.petName)} · ${escape(item.firstName)} ${escape(item.lastName)}</strong><span title="${escape(services)}">${escape(services)}</span>${day?"":`<span>${escape(groomerNames)}</span>`}${item.conflictOverridden?`<small class="conflict-override" data-testid="conflict-override">Intentional overlap</small>`:""}</button><div class="appointment-card-footer">${safetyContext(item)}<span class="appointment-status">${escape(item.status.replace("_"," "))}</span>${calendarAction(item)}</div></article>`;
}
function renderCalendar(){if(state.calendar.view==="day")renderDayCalendar();else renderWeekCalendar();}
function renderWeekCalendar(){
  const target=$("#calendar-list");if(!target||!state.calendar.weekStart)return;
  target.className="week-grid";target.setAttribute("aria-label","Weekly appointment schedule");target.style.removeProperty("--groomer-count");target.style.removeProperty("min-width");
  const days=Array.from({length:7},(_,index)=>dateShift(state.calendar.weekStart,index));const [start,end]=calendarHours();const slots=(end-start)/30;
  const header=`<div class="week-corner" style="grid-column:1;grid-row:1"></div>${days.map((day,index)=>`<button type="button" class="week-day-head ${day===state.calendar.selectedDate?"selected":""}" data-calendar-date="${day}" style="grid-column:${index+2};grid-row:1"><strong>${new Intl.DateTimeFormat([],{weekday:"short"}).format(dateAt(day))}</strong><br>${new Intl.DateTimeFormat([],{month:"short",day:"numeric"}).format(dateAt(day))}</button>`).join("")}`;
  let cells="";
  for(let slot=0;slot<slots;slot++){const minutes=start+slot*30;cells+=`<div class="week-time" style="grid-column:1;grid-row:${slot+2}">${timeLabel(minutes)}</div>`;for(let dayIndex=0;dayIndex<7;dayIndex++){const day=days[dayIndex];const periods=state.businessHours.filter(item=>Number(item.weekday)===dateAt(day).getUTCDay());const open=!periods.length&&!state.businessHours.length||periods.some(period=>{const from=Number(String(period.startTime).slice(0,2))*60+Number(String(period.startTime).slice(3,5));const to=Number(String(period.endTime).slice(0,2))*60+Number(String(period.endTime).slice(3,5));return minutes>=from&&minutes<to;});cells+=`<button type="button" aria-label="Book ${day} at ${timeLabel(minutes)}" class="week-slot ${open?"":"closed"}" ${open?`data-slot="${day}T${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}"`:"disabled"} style="grid-column:${dayIndex+2};grid-row:${slot+2}"></button>`;}}
  const visible=state.appointments.filter(item=>!state.calendar.employeeId||(item.groomers||[]).some(groomer=>groomer.id===state.calendar.employeeId));const placed=[];
  const appointments=visible.map(item=>{const local=appointmentLocalValue(item),day=local.slice(0,10),dayIndex=days.indexOf(day);if(dayIndex<0)return "";const minutes=Number(local.slice(11,13))*60+Number(local.slice(14,16));const duration=Math.max(30,Math.round((new Date(item.endAt)-new Date(item.startAt))/60000));const row=Math.floor((minutes-start)/30)+2;if(row<2||row>slots+1)return "";const overlap=placed.some(other=>other.day===day&&minutes<other.end&&minutes+duration>other.start);placed.push({day,start:minutes,end:minutes+duration});return appointmentCard(item,{overlap,style:`grid-column:${dayIndex+2};grid-row:${row}/span ${Math.max(1,Math.ceil(duration/30))}`});}).join("");
  target.innerHTML=header+cells+appointments;
  $("#calendar-range").textContent=`${new Intl.DateTimeFormat([],{month:"short",day:"numeric"}).format(dateAt(days[0]))} – ${new Intl.DateTimeFormat([],{month:"short",day:"numeric",year:"numeric"}).format(dateAt(days[6]))}`;
  renderMonthNavigator();
  $$('[data-calendar-date]').forEach(button=>button.addEventListener("click",()=>selectCalendarDate(button.dataset.calendarDate)));
  bindCalendarInteractions();
}
function renderDayCalendar(){
  const target=$("#calendar-list");if(!target||!state.calendar.selectedDate)return;
  const groomers=state.employees.filter(employee=>employee.active&&(!state.calendar.employeeId||employee.id===state.calendar.employeeId));
  const [start,end]=calendarHours(),slots=(end-start)/30,columns=Math.max(1,groomers.length);
  target.className="day-grid";target.setAttribute("aria-label","Daily appointment schedule by groomer");target.style.setProperty("--groomer-count",columns);target.style.minWidth=`${64+columns*190}px`;
  let content=`<div class="day-corner" style="grid-column:1;grid-row:1">Time</div>${groomers.map((groomer,index)=>`<div class="day-groomer" style="grid-column:${index+2};grid-row:1">${escape(groomer.displayName)}</div>`).join("")}`;
  for(let slot=0;slot<slots;slot++){const minutes=start+slot*30,row=slot+2,periods=state.businessHours.filter(item=>Number(item.weekday)===dateAt(state.calendar.selectedDate).getUTCDay()),open=!periods.length&&!state.businessHours.length||periods.some(period=>{const from=Number(String(period.startTime).slice(0,2))*60+Number(String(period.startTime).slice(3,5)),to=Number(String(period.endTime).slice(0,2))*60+Number(String(period.endTime).slice(3,5));return minutes>=from&&minutes<to;});content+=`<div class="day-time" style="grid-column:1;grid-row:${row}">${timeLabel(minutes)}</div>`;for(let index=0;index<groomers.length;index++){const groomer=groomers[index],preset=`${state.calendar.selectedDate}T${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;content+=`<button type="button" class="day-slot ${open?"":"closed"}" ${open?`data-slot="${preset}" data-slot-groomer="${groomer.id}"`:`disabled`} style="grid-column:${index+2};grid-row:${row}" aria-label="${escape(state.calendar.selectedDate)}, ${timeLabel(minutes)}, ${escape(groomer.displayName)}, ${open?"create appointment":"closed"}"></button>`;}}
  for(const item of state.appointments.filter(appointment=>appointmentLocalValue(appointment).slice(0,10)===state.calendar.selectedDate)){const local=appointmentLocalValue(item),minutes=Number(local.slice(11,13))*60+Number(local.slice(14,16)),duration=Math.max(30,Math.round((new Date(item.endAt)-new Date(item.startAt))/60000)),row=Math.floor((minutes-start)/30)+2;if(row<2||row>slots+1)continue;for(const assigned of item.groomers||[]){const column=groomers.findIndex(groomer=>groomer.id===assigned.id);if(column<0)continue;content+=appointmentCard(item,{day:true,groomerId:assigned.id,style:`grid-column:${column+2};grid-row:${row}/span ${Math.max(1,Math.ceil(duration/30))}`});}}
  target.innerHTML=content;$("#calendar-range").textContent=new Intl.DateTimeFormat([],{dateStyle:"full"}).format(dateAt(state.calendar.selectedDate));renderMonthNavigator();bindCalendarInteractions();
}
function closeCalendarMenus({restoreFocus=false}={}){$$(".calendar-action-popover:not([hidden])").forEach(popover=>{popover.hidden=true;const trigger=popover.previousElementSibling;trigger.setAttribute("aria-expanded","false");if(restoreFocus)trigger.focus();});}
function bindCalendarInteractions(){$$('[data-slot]').forEach(button=>button.addEventListener("click",()=>{closeCalendarMenus();state.calendar.bookingPreset=button.dataset.slot;state.calendar.bookingGroomerId=button.dataset.slotGroomer||null;actions["new-appointment"]();}));$$('[data-calendar-appointment]').forEach(button=>button.addEventListener("click",event=>{event.stopPropagation();closeCalendarMenus();openCalendarAppointment(button.dataset.calendarAppointment);}));$$('[data-appointment-menu]').forEach(trigger=>trigger.addEventListener("click",event=>{event.stopPropagation();const popover=trigger.nextElementSibling,opening=popover.hidden;closeCalendarMenus();popover.hidden=!opening;trigger.setAttribute("aria-expanded",String(opening));if(opening)popover.querySelector("button")?.focus();}));$$('.calendar-action-popover').forEach(popover=>popover.addEventListener("keydown",event=>{if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;event.preventDefault();const items=[...popover.querySelectorAll('[role="menuitem"]')],index=items.indexOf(document.activeElement),next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;items[next]?.focus();}));$$('.view-appointment-action').forEach(button=>button.addEventListener("click",()=>{closeCalendarMenus();openCalendarAppointment(button.dataset.id);}));}
function renderMonthNavigator(){
  if(!state.calendar.month)return;const first=`${state.calendar.month}-01`,start=dateShift(first,-dateAt(first).getUTCDay());const appointmentDates=new Set(state.calendar.monthAppointmentDates);
  $("#month-label").textContent=new Intl.DateTimeFormat([],{month:"long",year:"numeric"}).format(dateAt(first));
  $("#month-grid").innerHTML=Array.from({length:42},(_,index)=>{const day=dateShift(start,index);return `<button type="button" data-month-date="${day}" class="${day.slice(0,7)===state.calendar.month?"":"outside"} ${day===businessDate()?"today":""} ${day===state.calendar.selectedDate?"selected":""} ${appointmentDates.has(day)?"has-appointment":""}" aria-label="${new Intl.DateTimeFormat([],{dateStyle:"full"}).format(dateAt(day))}">${Number(day.slice(8,10))}</button>`;}).join("");
  $$('[data-month-date]').forEach(button=>button.addEventListener("click",()=>selectCalendarDate(button.dataset.monthDate)));
}
async function loadCalendarWeek(start=state.calendar.weekStart){
  state.calendar.weekStart=start;const rangeStart=state.calendar.view==="day"?state.calendar.selectedDate:start,days=state.calendar.view==="day"?1:7;const requests=[api(`/api/appointments?localDate=${rangeStart}&days=${days}`),state.businessHours.length?state.businessHours:api("/api/business/working-hours")];if(!state.calendar.monthAppointmentDates.length)requests.push(loadCalendarMonth(state.calendar.month,false));const [appointments,hours]=await Promise.all(requests);state.appointments=appointments;state.businessHours=hours;renderAppointments();
}
async function openCalendarView(){await loadCalendarWeek();if(!state.calendar.opened&&!state.appointments.length){const upcoming=await api(`/api/appointments?localDate=${businessDate()}&days=31`);if(upcoming.length){const date=appointmentLocalValue(upcoming[0]).slice(0,10);state.calendar.opened=true;return selectCalendarDate(date);}}state.calendar.opened=true;}
async function loadCalendarMonth(month=state.calendar.month,render=true){const first=`${month}-01`,date=dateAt(first);date.setUTCMonth(date.getUTCMonth()+1);const days=Math.round((date-dateAt(first))/86_400_000);const appointments=await api(`/api/appointments?localDate=${first}&days=${days}`);state.calendar.monthAppointmentDates=[...new Set(appointments.map(item=>appointmentLocalValue(item).slice(0,10)))];if(render)renderMonthNavigator();}
async function selectCalendarDate(date){const changedMonth=state.calendar.month!==date.slice(0,7);state.calendar.selectedDate=date;state.calendar.weekStart=weekStart(date);state.calendar.month=date.slice(0,7);if(changedMonth)await loadCalendarMonth(state.calendar.month,false);await loadCalendarWeek();}
function openCalendarAppointment(id){const item=state.appointments.find(appointment=>appointment.id===id);if(!item)return;const groomers=(item.groomers||[]).map(groomer=>groomer.displayName).join(", ")||item.employeeName;openModal(`${item.petName} appointment`,`<div class="wide appointment-detail"><p><strong>${escape(item.firstName)} ${escape(item.lastName)}</strong> · ${escape(groomers)}</p><p>${escape(item.services.map(service=>service.name).join(", "))}</p><p>${new Intl.DateTimeFormat([],{dateStyle:"full",timeStyle:"short",timeZone:item.schedulingTimezone||schedulingZone()}).format(new Date(item.startAt))}</p>${safetyContext(item)}${item.status==="scheduled"&&allowed("appointments.edit")?`<button type="button" class="secondary compact calendar-move-detail">Move appointment</button>`:""}</div>`,null,{cancelLabel:"Close"});$(".calendar-move-detail")?.addEventListener("click",()=>{$("#modal").close();moveAppointment(id);});}
function adjustServices(id) {
  const appointment=state.appointments.find(item=>item.id===id);
  openModal("Adjust appointment services",safetyContext(appointment)+bookingServiceCheckboxes(appointment.services.map(service=>service.serviceId)),form=>api(`/api/appointments/${id}/services`,{method:"PUT",body:JSON.stringify({serviceIds:form.getAll("serviceIds"),version:appointment.version})}));
}
function moveAppointment(id) {
  const appointment=state.appointments.find(item=>item.id===id);
  const local=appointmentLocalValue(appointment);
  openModal("Move appointment",groomerCheckboxes((appointment.groomers||[]).map(item=>item.id))+field("startAt","Start time","datetime-local",`required value="${local}"`)+disambiguationField(appointment.scheduledDisambiguation||""),form=>schedulingMutation(`/api/appointments/${id}/schedule`,{employeeIds:form.getAll("employeeIds"),localStart:form.get("startAt"),disambiguation:form.get("disambiguation")||undefined,expectedLocationVersion:state.me.business.locationVersion,version:appointment.version},"Reschedule"));
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
function renderCustomersEnhanced() {
  const directory=state.customerDirectory,formatDate=value=>value?new Intl.DateTimeFormat([],{dateStyle:"medium",timeZone:schedulingZone()}).format(new Date(value)):"—";
  $("#customer-grid").innerHTML=directory.items.length?directory.items.map(customer=>{const pets=customer.pets||[],shown=pets.slice(0,3),extra=pets.length-shown.length;return `<tr class="directory-row customer-card" tabindex="0" data-testid="customer-card" data-customer-id="${customer.id}" aria-label="Open ${escape(customer.firstName)} ${escape(customer.lastName)}"><td><div class="directory-customer"><button type="button" class="text-button customer-detail" data-id="${customer.id}"><strong>${escape(customer.firstName)} ${escape(customer.lastName)}</strong></button><span class="pet-summary">${shown.map(pet=>`<span data-pet-id="${pet.id}">${escape(pet.name)}${pet.breed?` · ${escape(pet.breed)}`:""}${pet.safetyAlerts?" !":""} <span class="pet-row-actions">${allowed("pets.edit")?`<button type="button" class="text-button row-pet-action" data-customer-id="${customer.id}" data-id="${pet.id}" data-action-name="profile">Profile</button>`:""}${allowed("pets.care.view")&&allowed("pets.care.edit")?`<button type="button" class="text-button row-pet-action" data-customer-id="${customer.id}" data-id="${pet.id}" data-action-name="care">Care</button>`:""}${allowed("pets.care.view")?`<button type="button" class="text-button row-pet-action" data-customer-id="${customer.id}" data-id="${pet.id}" data-action-name="documents">Documents</button>`:""}</span></span>`).join("; ")||"No active pets"}${extra>0?` · +${extra} more`:""}</span></div></td><td>${escape(customer.phone||"—")}</td><td>${escape(customer.email||"—")}</td><td>${formatDate(customer.lastVisit)}</td><td>${formatDate(customer.nextAppointment)}</td><td><span class="status-dot ${customer.archivedAt?"inactive":""}">${customer.archivedAt?"Inactive":"Active"}</span></td></tr>`;}).join(""):`<tr><td colspan="6" class="empty">No customers match these filters.</td></tr>`;
  directory.items.forEach(customer=>document.querySelector(`[data-customer-id="${customer.id}"] .directory-customer`)?.insertAdjacentHTML("beforeend",`<button type="button" class="text-button customer-history" data-id="${customer.id}">History</button>`));
  const pages=Math.max(1,Math.ceil(directory.total/directory.pageSize));$("#customer-page-status").textContent=`Page ${directory.page} of ${pages} · ${directory.total} customers`;$("#customer-prev").disabled=directory.page<=1;$("#customer-next").disabled=directory.page>=pages;
  $$(".customer-detail").forEach(button=>button.addEventListener("click",()=>showCustomerDetail(button.dataset.id)));$$(".customer-history").forEach(button=>button.addEventListener("click",()=>showCustomerHistory(button.dataset.id)));
  $$(".directory-row").forEach(row=>{row.addEventListener("click",event=>{if(!event.target.closest("button,a,input,select"))showCustomerDetail(row.dataset.customerId);});row.addEventListener("keydown",event=>{if(event.target===row&&(event.key==="Enter"||event.key===" ")){event.preventDefault();showCustomerDetail(row.dataset.customerId);}});});
  $$(".row-pet-action").forEach(button=>button.addEventListener("click",async()=>{const data=await api(`/api/customers/${button.dataset.customerId}/history`);state.pets=[...state.pets.filter(pet=>pet.customerId!==button.dataset.customerId),...data.pets];if(button.dataset.actionName==="profile")editPet(button.dataset.id);else if(button.dataset.actionName==="care")editPetCare(button.dataset.id);else showPetDocuments(button.dataset.id);}));
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
  const classes=[...new Set(service.priceTiers.map(price=>price.pricingClass))];const tiers=[["TIER_1","1–20"],["TIER_2","21–40"],["TIER_3","41–60"],["TIER_4","61–80"],["TIER_5","81–100"],["TIER_6","100+"]];
  return `<div class="pricing-scroll"><table class="pricing-matrix"><caption>${escape(service.name)} pricing tiers</caption><thead><tr><th scope="col">Pricing class</th>${tiers.map(([,label])=>`<th scope="col">${label} lb</th>`).join("")}</tr></thead><tbody>${classes.map(pricingClass=>`<tr><th scope="row">${escape(pricingClass.replaceAll("_"," "))}</th>${tiers.map(([code])=>`<td>${money(service.priceTiers.find(price=>price.pricingClass===pricingClass&&price.weightTierCode===code)?.priceMinor??0)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function renderServices(){
  const target=$("#service-list");if(!target)return;target.innerHTML=state.services.map(service=>`<article class="panel service-card"><div class="panel-head"><div><p class="eyebrow">${escape(service.category.replaceAll("_"," "))}</p><h3>${escape(service.name)}</h3><p>${service.baseDurationMinutes} min · ${escape(service.pricingMode.replaceAll("_"," "))}${service.pricingMode==="FIXED"?` · ${money(service.basePriceMinor)}`:service.pricingMode==="RANGE"?` · ${money(service.basePriceMinor)}–${money(service.rangeMaxMinor)}`:""}</p></div>${allowed("services.manage")?`<span><button type="button" class="text-button edit-service" data-id="${service.id}">Edit</button>${service.active?` <button type="button" class="text-button deactivate-service" data-id="${service.id}">Deactivate</button>`:""}</span>`:""}</div>${pricingMatrix(service)}${service.active?"":`<p class="fine">Inactive</p>`}</article>`).join("")||`<p class="empty">No services configured.</p>`;
  $$(".edit-service").forEach(button=>button.addEventListener("click",()=>editService(button.dataset.id)));$$(".deactivate-service").forEach(button=>button.addEventListener("click",()=>deactivate("services",button.dataset.id)));
}
function renderReports() {
  if (!state.reports) return;
  $("#revenue-report").innerHTML=state.reports.revenue.length?state.reports.revenue.map(row=>`<div><span>${new Date(`${row.date}T00:00:00`).toLocaleDateString()}</span><strong>${money(row.revenueMinor)}</strong></div>`).join(""):`<p class="empty">No paid revenue yet.</p>`;
  $("#employee-report").innerHTML=state.reports.employees.length?state.reports.employees.map(row=>`<div><span>${escape(row.displayName)}</span><strong>${row.appointmentCount}</strong></div>`).join(""):`<p class="empty">No completed appointments.</p>`;
  $("#service-report").innerHTML=state.reports.services.length?state.reports.services.map(row=>`<div><span>${escape(row.service)}</span><strong>${row.performed}</strong></div>`).join(""):`<p class="empty">No services completed.</p>`;
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
  return `<fieldset id="appointment-groomers" class="wide compact-options"><legend>Groomers <small>Choose one or more</small></legend>${state.employees.filter(employee=>employee.active).map(employee=>`<label><input type="checkbox" name="employeeIds" value="${employee.id}" ${selected.includes(employee.id)?"checked":""}> ${escape(employee.displayName)}</label>`).join("")||"<p>Add an active groomer first.</p>"}</fieldset>`;
}
function bookingServiceCheckboxes(selected=[]) {
  const labels={DOG_BASE:"Core grooming",DOG_ADDON:"Add-ons",A_LA_CARTE:"Care & finishing",CAT:"Cat",GENERAL:"Other"};
  const active=state.services.filter(service=>service.active),groups=[...new Set(active.map(service=>service.category))];
  return `<fieldset id="appointment-service-options" class="wide service-options"><legend>Services</legend>${groups.map(category=>`<section><h4>${labels[category]||escape(category)}</h4><div class="compact-options">${active.filter(service=>service.category===category).map(service=>`<label><input type="checkbox" name="serviceIds" value="${service.id}" ${selected.includes(service.id)?"checked":""}> <span>${escape(service.name)}<small>${money(service.basePriceMinor)} · ${service.baseDurationMinutes} min</small></span></label>`).join("")}</div></section>`).join("")||"<p>Add a service first.</p>"}</fieldset>`;
}
function weeklyHoursFields() {
  return `<fieldset class="wide hours-grid"><legend>Working hours</legend>${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day,index)=>`<div><label><input type="checkbox" name="day${index}" ${index>0&&index<6?"checked":""}> ${day}</label><input type="time" name="start${index}" value="09:00"><input type="time" name="end${index}" value="17:00"></div>`).join("")}</fieldset>`;
}
function editEmployee(id) {
  const employee=state.employees.find(item=>item.id===id);
  openModal("Edit team member",field("displayName","Display name","text",`required value="${escape(employee.displayName)}"`,true)+weeklyHoursFields(),async(form)=>{
    await api(`/api/employees/${id}`,{method:"PUT",body:JSON.stringify({displayName:form.get("displayName")})});
    await api(`/api/employees/${id}/working-hours`,{method:"PUT",body:JSON.stringify({hours:[0,1,2,3,4,5,6].filter(index=>form.get(`day${index}`)).map(index=>({weekday:index,startTime:form.get(`start${index}`),endTime:form.get(`end${index}`)}))})});
  });
}
function editService(id) {
  const service=state.services.find(item=>item.id===id);
  const tierFields=service.pricingMode==="TIERED"?`<fieldset class="wide"><legend>Pricing matrix</legend><div class="pricing-scroll"><table class="pricing-matrix"><thead><tr><th scope="col">Class</th>${["1–20","21–40","41–60","61–80","81–100","100+"].map(label=>`<th scope="col">${label}</th>`).join("")}</tr></thead><tbody>${[...new Set(service.priceTiers.map(price=>price.pricingClass))].map(pricingClass=>`<tr><th scope="row">${escape(pricingClass.replaceAll("_"," "))}</th>${[1,2,3,4,5,6].map(index=>{const price=service.priceTiers.find(item=>item.pricingClass===pricingClass&&item.weightTierCode===`TIER_${index}`);return `<td><label><span class="sr-only">${escape(pricingClass)} ${index} price</span><input name="tier:${pricingClass}:TIER_${index}" type="number" min="0" step=".01" value="${Number(price?.priceMinor??0)/100}"></label></td>`;}).join("")}</tr>`).join("")}</tbody></table></div></fieldset>`:"";
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
      if(typeof afterClose==="function")afterClose();
    }
    catch (error) {
      if(error.retryConflictOverride) renderConflictOverride(error);
      else {
        $("#modal-error").textContent = error.message;
        if(error.reconcileLifecycle||error.reconcileFinancial)await refresh();
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
    const explicitGroomerId=state.calendar.bookingGroomerId;
    openModal("New appointment",
      select("customerId","Customer",state.customers.map(c=>[c.id,`${c.firstName} ${c.lastName}`]))+
      select("petId","Pet",[])+
      groomerCheckboxes(explicitGroomerId?[explicitGroomerId]:[])+bookingServiceCheckboxes()+
      field("startAt","Start time","datetime-local",`required value="${state.calendar.bookingPreset||""}"`,true)+disambiguationField()+
      `<div class="wide pricing-preview" role="status" aria-live="polite" data-testid="booking-price-status">Choose a pet and service to calculate pricing.</div>`+
      `<p class="wide" role="status" aria-live="polite" data-testid="booking-rabies-status">Choose a pet and appointment time to evaluate rabies information.</p>`+
      field("notes","Appointment notes","text","",true),
      async (form) => { const o=Object.fromEntries(form); await schedulingMutation("/api/appointments",{locationId:state.me.business.locationId,customerId:o.customerId,petId:o.petId,employeeIds:form.getAll("employeeIds"),serviceIds:form.getAll("serviceIds"),localStart:o.startAt,disambiguation:o.disambiguation||undefined,expectedLocationVersion:state.me.business.locationVersion,notes:o.notes||null},"Booking");return ()=>selectCalendarDate(String(o.startAt).slice(0,10)); });
    const customerSelect=$('[name="customerId"]');const petSelect=$('[name="petId"]');
    state.calendar.bookingPreset=null;state.calendar.bookingGroomerId=null;
    const startInput=$('[name="startAt"]');const rabiesStatus=$('[data-testid="booking-rabies-status"]');
    const priceStatus=$('[data-testid="booking-price-status"]');let priceSequence=0;
    const updatePricePreview=async()=>{const sequence=++priceSequence;const serviceIds=$$('input[name="serviceIds"]:checked').map(input=>input.value);if(!petSelect.value||!serviceIds.length){priceStatus.textContent="Choose a pet and service to calculate pricing.";return;}priceStatus.textContent="Calculating authoritative price…";try{const prices=await api("/api/pricing/resolve",{method:"POST",body:JSON.stringify({petId:petSelect.value,serviceIds})});if(sequence!==priceSequence)return;priceStatus.innerHTML=prices.map(price=>price.status==="resolved"?`<p><strong>${escape(price.name)}</strong> · ${money(price.priceMinor)} · ${price.durationMinutes} min${price.weightTierLabel?` · ${escape(price.weightTierLabel)}`:""}</p>`:`<p><strong>${escape(price.name)}</strong><br>${price.status==="weight_required"?"Weight required to determine pricing.":price.status==="quote_required"?"Quote required.":"Admin price confirmation required."}</p>`).join("");}catch(error){if(sequence===priceSequence)priceStatus.textContent=error.message;}};
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
    const applyBookingDefaults=async()=>{const petId=petSelect.value;if(!petId)return;const defaults=await api(`/api/pets/${petId}/booking-defaults`);if(petSelect.value!==petId)return;const groomerIds=new Set(defaults.groomers.map(item=>item.id)),serviceIds=new Set(defaults.services.map(item=>item.id));if(!explicitGroomerId)$$('input[name="employeeIds"]').forEach(input=>input.checked=groomerIds.has(input.value));$$('input[name="serviceIds"]').forEach(input=>input.checked=serviceIds.has(input.value));updatePricePreview();};
    petSelect.addEventListener("change",()=>{updateRabiesPreview();applyBookingDefaults();});startInput.addEventListener("change",updateRabiesPreview);bindServicePreview();
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
function openAccountMenu(){accountMenu.hidden=false;accountTrigger.setAttribute("aria-expanded","true");}
accountTrigger.addEventListener("click",()=>accountMenu.hidden?openAccountMenu():closeAccountMenu());
accountTrigger.addEventListener("keydown",event=>{if(["ArrowDown","ArrowUp"].includes(event.key)){event.preventDefault();openAccountMenu();const items=[...accountMenu.querySelectorAll("[role=menuitem]")];items[event.key==="ArrowDown"?0:items.length-1]?.focus();}});
accountMenu.addEventListener("keydown",event=>{const items=[...accountMenu.querySelectorAll("[role=menuitem]")],index=items.indexOf(document.activeElement);if(event.key==="Escape"){event.preventDefault();closeAccountMenu({restoreFocus:true});}else if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;items[next]?.focus();}});
document.addEventListener("click",event=>{if(!accountMenu.hidden&&!$(".account-control").contains(event.target))closeAccountMenu();});
document.addEventListener("click",event=>{if(!event.target.closest(".calendar-actions-menu"))closeCalendarMenus();});
document.addEventListener("keydown",event=>{if(event.key==="Escape"){if(!accountMenu.hidden){event.preventDefault();closeAccountMenu({restoreFocus:true});}else if($(".calendar-action-popover:not([hidden])")){event.preventDefault();closeCalendarMenus({restoreFocus:true});}}});
$("#profile-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,error=$("#profile-error"),button=form.querySelector("button[type=submit]");error.textContent="";button.disabled=true;try{await api("/api/me",{method:"PATCH",body:JSON.stringify({displayName:new FormData(form).get("displayName")})});state.me=await api("/api/me");renderAccountIdentity();toast("Profile updated");}catch(problem){error.textContent=problem.message;}finally{button.disabled=false;}});
$("#profile-cancel").addEventListener("click",()=>{renderAccountIdentity();$("#profile-error").textContent="";});
$("#profile-workspace-select").addEventListener("change",async event=>{try{await api("/api/workspaces/select",{method:"POST",body:JSON.stringify({businessId:event.target.value})});location.reload();}catch(error){toast(error.message);renderAccountIdentity();}});
$("#password-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget,values=Object.fromEntries(new FormData(form)),error=$("#password-error"),button=form.querySelector("button[type=submit]");error.textContent="";if(values.newPassword!==values.confirmPassword){error.textContent="New passwords do not match";form.elements.confirmPassword.focus();return;}button.disabled=true;try{await api("/api/me/password",{method:"POST",body:JSON.stringify({currentPassword:values.currentPassword,newPassword:values.newPassword})});form.reset();toast("Password changed; other sessions signed out");}catch(problem){error.textContent=problem.message;}finally{button.disabled=false;}});
$$('[data-action]').forEach((button) => button.addEventListener("click", () => actions[button.dataset.action]?.()));
const viewPaths={dashboard:"/",calendar:"/",customers:"/",services:"/",setup:"/","breed-catalog":"/salon/breeds","admin-settings":"/settings",reports:"/","profile-account":"/account"};
function viewForPath(path){if(path==="/account")return "profile-account";if(path==="/settings")return "admin-settings";return path==="/salon/breeds"||path==="/reports/breeds"||path==="/overview/breeds"?"breed-catalog":"dashboard";}
function closeSetupMenus(){$$(".setup-menu[open]").forEach(menu=>menu.open=false);}
$$("nav [data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$$("[data-view-target]").forEach((button) => button.addEventListener("click", () => {closeAccountMenu();closeSetupMenus();showView(button.dataset.viewTarget);}));
$$("[data-view-link]").forEach(link=>link.addEventListener("click",event=>{event.preventDefault();closeSetupMenus();showView(link.dataset.viewLink);}));
$$(".setup-menu").forEach(menu=>{const summary=menu.querySelector("summary");menu.addEventListener("toggle",()=>summary.setAttribute("aria-expanded",String(menu.open)));menu.addEventListener("keydown",event=>{if(event.key==="Escape"&&menu.open){event.preventDefault();menu.open=false;summary.focus();}});});
document.addEventListener("click",event=>$$(".setup-menu[open]").forEach(menu=>{if(!menu.contains(event.target))menu.open=false;}));
globalThis.addEventListener("popstate",()=>showView(viewForPath(location.pathname),{history:"none"}));
async function showView(view,{history="push"}={}) {
  if(!activateView(view,{history}))return;
  try{
    state.me=await api("/api/me");applyPermissions();
    if(view==="calendar")await openCalendarView();
    if(view==="customers")await loadCustomerDirectory(state.customerDirectory.page||1);
    if(view==="breed-catalog")renderBreedCatalog();
    if(view==="profile-account")renderAccountIdentity();
    if($(`[data-view="${view}"]`)?.hidden){
      activateView("dashboard",{history:"replace"});
    }
  }catch{return bootstrap();}
}
function activateView(view,{history="push"}={}) {
  closeCalendarMenus();
  const target=$(`#${view}`);if(!target||$(`[data-view="${view}"]`)?.hidden)return;
  const canonicalPath=viewPaths[view];if(canonicalPath&&history!=="none"&&(location.pathname!==canonicalPath||view==="breed-catalog")){globalThis.history[history==="replace"?"replaceState":"pushState"]({view},"",canonicalPath);}
  $$(".view").forEach(v=>v.hidden=v.id!==view); $$("nav button").forEach(b=>{const active=b.dataset.view===view||view==="breed-catalog"&&b.dataset.view==="setup";b.classList.toggle("active",active);if(active)b.setAttribute("aria-current","page");else b.removeAttribute("aria-current");}); $("#page-kicker").textContent=view==="breed-catalog"?"Salon":view==="profile-account"?"Your account":view==="admin-settings"?"Administration":"Daily operations"; $("#page-title").textContent={dashboard:"Good morning",calendar:"Your calendar",customers:"Client care",services:"Services & Pricing",setup:"Salon","breed-catalog":"Salon","admin-settings":"Settings",reports:"Business reports","profile-account":"Profile & Account"}[view];
  if(view==="breed-catalog")renderBreedCatalog();
  return true;
}
$$(".close").forEach((button)=>button.addEventListener("click",()=>$("#modal").close()));
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
$("#calendar-today").addEventListener("click",()=>selectCalendarDate(businessDate()));$("#calendar-prev-week").addEventListener("click",()=>selectCalendarDate(dateShift(state.calendar.view==="day"?state.calendar.selectedDate:state.calendar.weekStart,state.calendar.view==="day"?-1:-7)));$("#calendar-next-week").addEventListener("click",()=>selectCalendarDate(dateShift(state.calendar.view==="day"?state.calendar.selectedDate:state.calendar.weekStart,state.calendar.view==="day"?1:7)));
function setCalendarView(view){state.calendar.view=view;$("#calendar-week-view").setAttribute("aria-pressed",String(view==="week"));$("#calendar-day-view").setAttribute("aria-pressed",String(view==="day"));loadCalendarWeek();}
$("#calendar-week-view").addEventListener("click",()=>setCalendarView("week"));$("#calendar-day-view").addEventListener("click",()=>setCalendarView("day"));
$("#month-prev").addEventListener("click",async()=>{const first=dateAt(`${state.calendar.month}-01`);first.setUTCMonth(first.getUTCMonth()-1);state.calendar.month=first.toISOString().slice(0,7);await loadCalendarMonth();});$("#month-next").addEventListener("click",async()=>{const first=dateAt(`${state.calendar.month}-01`);first.setUTCMonth(first.getUTCMonth()+1);state.calendar.month=first.toISOString().slice(0,7);await loadCalendarMonth();});
$("#calendar-employee-filter").addEventListener("change",event=>{state.calendar.employeeId=event.target.value;renderCalendar();});
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
