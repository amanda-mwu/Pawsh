const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const inviteToken = new URLSearchParams(location.search).get("invite");
const resetToken = new URLSearchParams(location.search).get("reset");
const state = { me: null, customers: [], pets: [], employees: [], services: [], appointments: [], members: [], reports: null, login: false };
const pendingActions = new Set();
let customerSearchSequence = 0;

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(path, {
    credentials: "include",
    headers,
    ...options
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
function allowed(permission) {
  return Boolean(state.me?.isOwner || state.me?.permissions?.includes(permission));
}
function applyPermissions() {
  $$("[data-permission]").forEach((element) => {
    element.hidden = !allowed(element.dataset.permission);
  });
  $$("[data-any-permission]").forEach((element) => {
    element.hidden = !element.dataset.anyPermission.split(",").some(allowed);
  });
}
async function runOnce(key, operation) {
  if (pendingActions.has(key)) return;
  pendingActions.add(key);
  try { return await operation(); }
  finally { pendingActions.delete(key); }
}

async function bootstrap() {
  try {
    state.me = await api("/api/me");
    $("#salon-name").textContent = state.me.business.name;
    applyPermissions();
    await refresh();
    $("#auth-view").hidden = true; $("#app-view").hidden = false;
  } catch { $("#auth-view").hidden = false; $("#app-view").hidden = true; }
}

async function refresh() {
  const allowed = new Set(state.me.permissions);
  const owner = state.me.isOwner;
  const safe = (permission) => owner || allowed.has(permission);
  const requests = [
    safe("reports.view") ? api("/api/dashboard") : {},
    safe("customers.view") ? api("/api/customers") : [],
    safe("pets.view") ? api("/api/pets") : [],
    api("/api/employees"), api("/api/services"),
    safe("appointments.view") ? api(`/api/appointments?from=${new Date(Date.now()-86400000).toISOString()}&to=${new Date(Date.now()+8*86400000).toISOString()}`) : [],
    safe("team.manage") ? api("/api/members") : [],
    safe("reports.view") ? api("/api/reports") : null
  ];
  const [dashboard, customers, pets, employees, services, appointments, members, reports] = await Promise.all(requests);
  Object.assign(state, { customers, pets, employees, services, appointments, members, reports });
  applyPermissions();
  renderDashboard(dashboard); renderCustomersEnhanced(); renderSetupEnhanced(); renderAppointments(); renderReports();
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
  const details = [
    item.safetyAlerts ? `<strong>Safety alert:</strong> ${escape(item.safetyAlerts)}` : "",
    item.behaviorNotes ? `<strong>Behavior:</strong> ${escape(item.behaviorNotes)}` : "",
    item.medicalNotes ? `<strong>Medical:</strong> ${escape(item.medicalNotes)}` : "",
    item.groomingPreferences ? `<strong>Grooming:</strong> ${escape(item.groomingPreferences)}` : ""
  ].filter(Boolean);
  return details.length
    ? `<div class="safety-context" role="note" aria-label="Pet safety and care information" data-testid="safety-context">${details.map((detail) => `<p>${detail}</p>`).join("")}</div>`
    : "";
}
function appointmentHtml(item) {
  const time = new Date(item.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const customer = `${item.firstName} ${item.lastName}`;
  const actionDefinition = {
    scheduled: ["Check in", "operations.check_in"],
    checked_in: ["Start service", "operations.perform_service"],
    in_service: ["Complete", "operations.complete"],
    completed: ["Checkout", "checkout.perform"]
  }[item.status];
  const action = actionDefinition && allowed(actionDefinition[1])
    ? `<button data-testid="appointment-${item.status}" class="text-button appointment-action" data-id="${item.id}" data-status="${item.status}">${actionDefinition[0]} →</button>`
    : "";
  const conflictOverride=item.conflictOverridden?`<small class="conflict-override" data-testid="conflict-override">Intentional overlap</small>`:"";
  return `<article class="appointment" data-testid="appointment" data-appointment-id="${item.id}"><time>${time}</time><div><span class="pet">${escape(item.petName)}</span><small>${escape(customer)} · ${escape(item.employeeName)}</small>${conflictOverride}${safetyContext(item)}</div><div class="appointment-actions"><span class="badge ${item.status}">${item.status.replace("_"," ")}</span>${action}</div></article>`;
}
function renderAppointments() {
  const html = state.appointments.length ? state.appointments.map(appointmentHtml).join("") : "No appointments scheduled.";
  $("#calendar-list").innerHTML = html; $("#calendar-list").classList.toggle("empty", !state.appointments.length);
  const today = new Date().toDateString();
  const todays = state.appointments.filter((item) => new Date(item.startAt).toDateString() === today);
  $("#today-list").innerHTML = todays.length ? todays.map(appointmentHtml).join("") : "No appointments today.";
  $$(".appointment-action").forEach((button) => button.addEventListener("click", () => advanceAppointment(button.dataset.id, button.dataset.status, button)));
  state.appointments.filter(item=>item.status==="scheduled" && (allowed("appointments.edit") || allowed("appointments.cancel"))).forEach(item=>{
    $$(`.appointment-action[data-id="${item.id}"]`).forEach(button=>{
      button.parentElement.insertAdjacentHTML("beforeend",`<span>${allowed("appointments.edit")?`<button type="button" class="text-button move-action" data-id="${item.id}">Move</button>`:""} ${allowed("appointments.cancel")?`<button type="button" class="text-button terminal-action" data-id="${item.id}" data-status="cancelled">Cancel</button> <button type="button" class="text-button terminal-action" data-id="${item.id}" data-status="no_show">No show</button>`:""}</span>`);
    });
  });
  state.appointments.filter(item=>["checked_in","in_service"].includes(item.status) && allowed("appointments.edit")).forEach(item=>{
    $$(`.appointment-action[data-id="${item.id}"]`).forEach(button=>{
      button.parentElement.insertAdjacentHTML("beforeend",`<button type="button" class="text-button service-action" data-id="${item.id}">Adjust services</button>`);
    });
  });
  $$(".terminal-action").forEach(button=>button.addEventListener("click",()=>terminalAppointment(button.dataset.id,button.dataset.status)));
  $$(".move-action").forEach(button=>button.addEventListener("click",()=>moveAppointment(button.dataset.id)));
  $$(".service-action").forEach(button=>button.addEventListener("click",()=>adjustServices(button.dataset.id)));
}
function adjustServices(id) {
  const appointment=state.appointments.find(item=>item.id===id);
  openModal("Adjust appointment services",safetyContext(appointment)+serviceCheckboxes(appointment.services.map(service=>service.serviceId)),form=>api(`/api/appointments/${id}/services`,{method:"PUT",body:JSON.stringify({serviceIds:form.getAll("serviceIds"),version:appointment.version})}));
}
function moveAppointment(id) {
  const appointment=state.appointments.find(item=>item.id===id);
  const local=new Date(new Date(appointment.startAt).getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);
  openModal("Move appointment",select("employeeId","Groomer",state.employees.filter(item=>item.active).map(item=>[item.id,item.displayName]))+field("startAt","Start time","datetime-local",`required value="${local}"`),form=>schedulingMutation(`/api/appointments/${id}/schedule`,{employeeId:form.get("employeeId"),startAt:new Date(form.get("startAt")).toISOString(),version:appointment.version},"Reschedule"));
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
      const invoice=await api(`/api/appointments/${id}/checkout`,{method:"POST",body:JSON.stringify({
        discountMinor:Math.round(Number(values.discount||0)*100),
        discountType:Number(values.discount||0)>0?"manual":null,
        tipMinor:Math.round(Number(values.tip||0)*100)
      })});
      if (Number(invoice.balanceMinor)>0) await api(`/api/invoices/${invoice.id}/payments`,{method:"POST",body:JSON.stringify({amountMinor:Number(invoice.balanceMinor),method:values.method})});
      const receipt=await api(`/api/invoices/${invoice.id}/receipt`);
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
      await api(`/api/payments/${paymentId}/void`,{method:"POST",body:JSON.stringify({reason})});
      const receipt=await api(`/api/invoices/${invoiceId}/receipt`);
      $("#modal").close();toast("Payment record voided; no external refund was issued");setTimeout(()=>showReceipt(receipt),50);
    }catch(error){toast(error.message);}
  });
}
function renderCustomers() {
  $("#customer-grid").innerHTML = state.customers.length ? state.customers.map((customer) => {
    const pets = state.pets.filter((pet) => pet.customerId === customer.id);
    return `<article class="customer-card"><p class="eyebrow">${pets.length} pet${pets.length === 1 ? "" : "s"}</p><h3>${escape(customer.firstName)} ${escape(customer.lastName)}</h3><p>${escape(customer.email || customer.phone || "No contact added")}</p><p>${pets.map((pet) => escape(pet.name)).join(" · ") || "Add their first pet"}</p></article>`;
  }).join("") : `<p class="empty">Create your first customer to begin building salon history.</p>`;
}
function renderSetup() {
  $("#employee-list").innerHTML = state.employees.length ? state.employees.map((e) => `<div><strong>${escape(e.displayName)}</strong><small>${e.active ? "Active" : "Inactive"}</small></div>`).join("") : `<p class="empty">No team members yet.</p>`;
  $("#service-list").innerHTML = state.services.length ? state.services.map((s) => `<div><span><strong>${escape(s.name)}</strong><small>${s.baseDurationMinutes} min</small></span><strong>${money(s.basePriceMinor)}</strong></div>`).join("") : `<p class="empty">No services yet.</p>`;
  $("#member-list").innerHTML = state.members.length ? state.members.map((member) => `<div><span><strong>${escape(member.email)}</strong><small>${member.isOwner ? "Owner" : `${member.permissions.length} permissions`}</small></span>${member.isOwner ? "" : `<span><button class="text-button edit-member" data-id="${member.id}">Access</button> <button class="text-button remove-member" data-id="${member.id}">Remove</button></span>`}</div>`).join("") : `<p class="empty">Only you have workspace access.</p>`;
  $$(".edit-member").forEach((button)=>button.addEventListener("click",()=>editMember(button.dataset.id)));
  $$(".remove-member").forEach((button)=>button.addEventListener("click",()=>removeMember(button.dataset.id)));
}
function renderCustomersEnhanced() {
  renderCustomers();
  $("#customer-grid").innerHTML = state.customers.length ? state.customers.map((customer) => {
    const pets = state.pets.filter((pet) => pet.customerId === customer.id);
    return `<article class="customer-card" data-testid="customer-card" data-customer-id="${customer.id}"><p class="eyebrow">${pets.length} pet${pets.length === 1 ? "" : "s"}</p><h3>${escape(customer.firstName)} ${escape(customer.lastName)}</h3><p>${escape(customer.email || customer.phone || "No contact added")}</p><div class="pet-links">${pets.map((pet) => `<span data-pet-id="${pet.id}"><strong>${escape(pet.name)}${pet.safetyAlerts?" !":""}</strong>${allowed("pets.edit")?` <button type="button" class="text-button edit-pet" data-id="${pet.id}">Profile</button>`:""}${allowed("pets.care.view")&&allowed("pets.care.edit")?` <button type="button" class="text-button edit-pet-care" data-id="${pet.id}">Care</button>`:""}</span>`).join("") || "Add their first pet"}</div><div class="card-actions"><button type="button" class="text-button customer-history" data-id="${customer.id}">History</button>${allowed("customers.edit")?`<button type="button" class="text-button edit-customer" data-id="${customer.id}">Edit</button><button type="button" class="text-button archive-customer" data-id="${customer.id}">Archive</button>`:""}</div></article>`;
  }).join("") : `<p class="empty">Create your first customer to begin building salon history.</p>`;
  $$(".edit-customer").forEach((button)=>button.addEventListener("click",()=>editCustomer(button.dataset.id)));
  $$(".archive-customer").forEach((button)=>button.addEventListener("click",()=>archiveCustomer(button.dataset.id)));
  $$(".edit-pet").forEach((button)=>button.addEventListener("click",()=>editPet(button.dataset.id)));
  $$(".edit-pet-care").forEach((button)=>button.addEventListener("click",()=>editPetCare(button.dataset.id)));
  $$(".customer-history").forEach((button)=>button.addEventListener("click",()=>showCustomerHistory(button.dataset.id)));
}
function renderSetupEnhanced() {
  renderSetup();
  $("#employee-list").innerHTML = state.employees.length ? state.employees.map((employee) => `<div><span><strong>${escape(employee.displayName)}</strong><small>${employee.active ? "Active" : "Inactive"}</small></span>${employee.active?`<span><button type="button" class="text-button edit-employee" data-id="${employee.id}">Edit</button> <button type="button" class="text-button deactivate-employee" data-id="${employee.id}">Deactivate</button></span>`:""}</div>`).join("") : `<p class="empty">No team members yet.</p>`;
  $("#service-list").innerHTML = state.services.length ? state.services.map((service) => `<div><span><strong>${escape(service.name)}</strong><small>${service.baseDurationMinutes} min / ${money(service.basePriceMinor)}</small></span>${service.active?`<span><button type="button" class="text-button edit-service" data-id="${service.id}">Edit</button> <button type="button" class="text-button deactivate-service" data-id="${service.id}">Deactivate</button></span>`:"<small>Inactive</small>"}</div>`).join("") : `<p class="empty">No services yet.</p>`;
  $$(".edit-employee").forEach((button)=>button.addEventListener("click",()=>editEmployee(button.dataset.id)));
  $$(".deactivate-employee").forEach((button)=>button.addEventListener("click",()=>deactivate("employees",button.dataset.id)));
  $$(".edit-service").forEach((button)=>button.addEventListener("click",()=>editService(button.dataset.id)));
  $$(".deactivate-service").forEach((button)=>button.addEventListener("click",()=>deactivate("services",button.dataset.id)));
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
function serviceCheckboxes(selected=[]) {
  return `<fieldset class="wide permission-grid"><legend>Eligible services</legend>${state.services.filter(service=>service.active).map(service=>`<label><input type="checkbox" name="serviceIds" value="${service.id}" ${selected.includes(service.id)?"checked":""}> ${escape(service.name)}</label>`).join("")||"<p>Add a service first.</p>"}</fieldset>`;
}
function weeklyHoursFields() {
  return `<fieldset class="wide hours-grid"><legend>Working hours</legend>${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day,index)=>`<div><label><input type="checkbox" name="day${index}" ${index>0&&index<6?"checked":""}> ${day}</label><input type="time" name="start${index}" value="09:00"><input type="time" name="end${index}" value="17:00"></div>`).join("")}</fieldset>`;
}
function editEmployee(id) {
  const employee=state.employees.find(item=>item.id===id);
  openModal("Edit team member",field("displayName","Display name","text",`required value="${escape(employee.displayName)}"`,true)+serviceCheckboxes(employee.serviceIds)+weeklyHoursFields(),async(form)=>{
    await api(`/api/employees/${id}`,{method:"PUT",body:JSON.stringify({displayName:form.get("displayName"),serviceIds:form.getAll("serviceIds")})});
    await api(`/api/employees/${id}/working-hours`,{method:"PUT",body:JSON.stringify({hours:[0,1,2,3,4,5,6].filter(index=>form.get(`day${index}`)).map(index=>({weekday:index,startTime:form.get(`start${index}`),endTime:form.get(`end${index}`)}))})});
  });
}
function editService(id) {
  const service=state.services.find(item=>item.id===id);
  openModal("Edit service",field("name","Service name","text",`required value="${escape(service.name)}"`)+field("baseDurationMinutes","Duration (minutes)","number",`required min="1" value="${service.baseDurationMinutes}"`)+field("basePrice","Price ($)","number",`required min="0" step=".01" value="${Number(service.basePriceMinor)/100}`)+field("description","Description","text",`value="${escape(service.description||"")}"`,true),form=>{const values=Object.fromEntries(form);return api(`/api/services/${id}`,{method:"PUT",body:JSON.stringify({name:values.name,description:values.description||null,baseDurationMinutes:Number(values.baseDurationMinutes),basePriceMinor:Math.round(Number(values.basePrice)*100)})});});
}
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
    const appointments=historyData.appointments.map(item=>`<div><span>${new Date(item.startAt).toLocaleDateString()} / ${escape(item.petName)}</span><strong>${escape(item.status.replace("_"," "))}</strong></div>`).join("")||"<p>No appointments yet.</p>";
    const invoices=historyData.invoices.map(item=>`<div><span>Invoice ${escape(item.invoiceNumber)}</span><span><strong>${money(item.totalMinor)} / ${escape(item.status)}</strong><button type="button" class="text-button history-receipt" data-invoice-id="${item.id}">Receipt</button></span></div>`).join("")||`<p>${allowed("payments.view")?"No invoices yet.":"Financial history requires payment access."}</p>`;
    openModal(`${historyData.customer.firstName} ${historyData.customer.lastName} history`,`<div class="wide history-list"><h4>Appointments</h4>${appointments}<h4>Transactions</h4>${invoices}</div>`,async()=>{});
    $$(".history-receipt").forEach(button=>button.addEventListener("click",async()=>{
      const receipt=await api(`/api/invoices/${button.dataset.invoiceId}/receipt`);
      $("#modal").close();setTimeout(()=>showReceipt(receipt),50);
    }));
  }catch(error){toast(error.message);}
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
        weightOunces:form.get("weightOunces")===""?null:Number(form.get("weightOunces")),
        sex:form.get("sex")||null,
        coatNotes:form.get("coatNotes")||null,
        groomingPreferences:form.get("groomingPreferences")||null,
        photoPermission:form.has("photoPermission"),
        version:pet.version
      })});
    }catch(error){
      if(error.status===409){
        await refresh();
        pet=state.pets.find(item=>item.id===id);
        $("#modal-fields").innerHTML=petProfileFields(pet);
      }
      throw error;
    }
  });
}

function petProfileFields(pet){
  return field("name","Pet name","text",`required value="${escape(pet.name)}"`)+
    field("species","Species","text",`required value="${escape(pet.species)}"`)+
    field("breed","Breed","text",`value="${escape(pet.breed||"")}"`)+
    field("dateOfBirth","Date of birth","date",`value="${pet.dateOfBirth?String(pet.dateOfBirth).slice(0,10):""}"`)+
    field("approximateAge","Approximate age","text",`value="${escape(pet.approximateAge||"")}"`)+
    field("weightOunces","Weight (ounces)","number",`min="0" value="${pet.weightOunces??""}"`)+
    field("sex","Sex","text",`value="${escape(pet.sex||"")}"`)+
    field("coatNotes","Coat notes","text",`value="${escape(pet.coatNotes||"")}"`,true)+
    field("groomingPreferences","Grooming preferences","text",`value="${escape(pet.groomingPreferences||"")}"`,true)+
    `<label><input data-testid="field-photoPermission" name="photoPermission" type="checkbox" ${pet.photoPermission?"checked":""}> Photo permission</label>`;
}

function petCareFields(pet){
  return field("safetyAlerts","Safety alerts","text",`value="${escape(pet.safetyAlerts||"")}"`,true)+
    field("behaviorNotes","Behavior notes","text",`value="${escape(pet.behaviorNotes||"")}"`,true)+
    field("medicalNotes","Medical notes","text",`value="${escape(pet.medicalNotes||"")}"`,true)+
    field("emergencyContact","Emergency contact","text",`value="${escape(pet.emergencyContact||"")}"`,true)+
    field("veterinarian","Veterinarian","text",`value="${escape(pet.veterinarian||"")}"`,true)+
    field("vaccinationNotes","Vaccination notes","text",`value="${escape(pet.vaccinationNotes||"")}"`,true)+
    field("vaccinationExpiresOn","Vaccination expires","date",`value="${pet.vaccinationExpiresOn?String(pet.vaccinationExpiresOn).slice(0,10):""}"`);
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
        veterinarian:form.get("veterinarian")||null,
        vaccinationNotes:form.get("vaccinationNotes")||null,
        vaccinationExpiresOn:form.get("vaccinationExpiresOn")||null,
        version:pet.version
      })});
    }catch(error){
      if(error.status===409){
        await refresh();
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
function select(name, label, options, wide = false) {
  return `<label class="${wide ? "wide" : ""}">${label}<select data-testid="field-${name}" name="${name}" required><option value="">Choose…</option>${options.map(([v,l]) => `<option value="${v}">${escape(l)}</option>`).join("")}</select></label>`;
}
function openModal(title, fields, submit) {
  $("#modal-title").textContent = title; $("#modal-fields").innerHTML = fields; $("#modal-error").textContent = "";
  $("#modal-form").onsubmit = async (event) => {
    event.preventDefault(); $("#modal-error").textContent = "";
    const form=event.currentTarget;const button=form.querySelector('[type="submit"]');const original=button.textContent;
    button.disabled=true;button.textContent="Saving…";form.setAttribute("aria-busy","true");
    try {
      const afterClose=await submit(new FormData(form));
      await refresh(); $("#modal").close(); toast(`${title} saved`);
      if(typeof afterClose==="function")afterClose();
    }
    catch (error) {
      if(error.retryConflictOverride) renderConflictOverride(error);
      else {
        $("#modal-error").textContent = error.message;
        if(error.reconcileLifecycle)await refresh();
      }
    }
    finally{button.disabled=false;button.textContent=original;form.removeAttribute("aria-busy");}
  };
  $("#modal").showModal();
}

function schedulingMutation(path,payload,operationLabel){
  return api(path,{method:path.includes("/schedule")?"PATCH":"POST",body:JSON.stringify(payload)}).catch(error=>{
    if(error.status===409&&error.data?.code==="SCHEDULING_CONFLICT"&&error.data.canOverride){
      error.operationLabel=operationLabel;
      error.proposedEmployee=state.employees.find(item=>item.id===payload.employeeId)?.displayName||"Selected employee";
      error.proposedStart=new Date(payload.startAt);
      error.retryConflictOverride=()=>api(path,{
        method:path.includes("/schedule")?"PATCH":"POST",
        body:JSON.stringify({...payload,overrideConflict:true})
      });
    }
    throw error;
  });
}

function renderConflictOverride(error){
  const container=$("#modal-error");
  container.textContent="";
  const conflicts=error.data.conflicts||[];
  const proposed=error.proposedStart.toLocaleString();
  const conflictTimes=conflicts.map(item=>
    `${new Date(item.startsAt).toLocaleString()}–${new Date(item.endsAt).toLocaleTimeString()}`
  ).join(", ");
  const message=document.createElement("span");
  message.textContent=`${error.proposedEmployee} already has an overlapping appointment. ${error.operationLabel} at ${proposed} will overlap ${conflictTimes}.`;
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
  "new-pet": () => openModal("New pet",
    select("customerId","Customer",state.customers.map(c=>[c.id,`${c.firstName} ${c.lastName}`]),true)+field("name","Pet name","text","required")+field("breed","Breed")+field("species","Species","text",'value="dog"')+field("groomingPreferences","Grooming preferences","text","",true)+(allowed("pets.care.edit")?field("behaviorNotes","Behavior notes","text","",true)+field("safetyAlerts","Safety alert","text","",true)+field("medicalNotes","Medical notes","text","",true):""),
    (form) => api("/api/pets",{method:"POST",body:JSON.stringify(Object.fromEntries(form))})),
  "new-service": () => openModal("New service",
    field("name","Service name","text","required")+field("baseDurationMinutes","Duration (minutes)","number",'required min="1"')+field("basePrice","Price ($)","number",'required min="0" step=".01"')+field("description","Description","text","",true),
    (form) => { const o=Object.fromEntries(form); o.baseDurationMinutes=Number(o.baseDurationMinutes); o.basePriceMinor=Math.round(Number(o.basePrice)*100); delete o.basePrice; return api("/api/services",{method:"POST",body:JSON.stringify(o)}); }),
  "new-employee": () => openModal("New team member",
    field("displayName","Display name","text","required",true)+serviceCheckboxes(),
    (form) => api("/api/employees",{method:"POST",body:JSON.stringify({displayName:form.get("displayName"),serviceIds:form.getAll("serviceIds")})})),
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
      await api("/api/business/settings",{method:"PUT",body:JSON.stringify({
        name:values.name,timezone:values.timezone,currency:values.currency,
        taxRateBasisPoints:Math.round(Number(values.taxRate)*100),
        reminderLeadMinutes:Math.round(Number(values.reminderHours)*60)
      })});
      state.me=await api("/api/me");$("#salon-name").textContent=state.me.business.name;
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
    openModal("New appointment",
      select("customerId","Customer",state.customers.map(c=>[c.id,`${c.firstName} ${c.lastName}`]))+
      select("petId","Pet",[])+
      select("employeeId","Groomer",state.employees.filter(e=>e.active).map(e=>[e.id,e.displayName]))+
      serviceCheckboxes()+
      field("startAt","Start time","datetime-local","required",true)+field("notes","Appointment notes","text","",true),
      (form) => { const o=Object.fromEntries(form); return schedulingMutation("/api/appointments",{locationId:state.me.business.locationId,customerId:o.customerId,petId:o.petId,employeeId:o.employeeId,serviceIds:form.getAll("serviceIds"),startAt:new Date(o.startAt).toISOString(),notes:o.notes||null},"Booking"); });
    const customerSelect=$('[name="customerId"]');const petSelect=$('[name="petId"]');
    customerSelect.addEventListener("change",()=>{
      const pets=state.pets.filter(pet=>pet.customerId===customerSelect.value);
      petSelect.innerHTML=`<option value="">Choose…</option>${pets.map(pet=>`<option value="${pet.id}">${escape(pet.name)}</option>`).join("")}`;
    });
  }),
  "blocked-time": () => openModal("Block team time",
    select("employeeId","Team member",state.employees.filter(item=>item.active).map(item=>[item.id,item.displayName]))+
    field("startAt","Start","datetime-local","required")+field("endAt","End","datetime-local","required")+
    field("reason","Reason","text","required",true),
    form=>api("/api/blocked-times",{method:"POST",body:JSON.stringify({employeeId:form.get("employeeId"),startAt:new Date(form.get("startAt")).toISOString(),endAt:new Date(form.get("endAt")).toISOString(),reason:form.get("reason")})}))
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
$("#logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout",{method:"POST"}); }
  catch(error) {
    // Logout is intentionally idempotent: an already-ended session is the
    // requested outcome. Every other server or application failure still
    // surfaces as an uncaught page error for operators and smoke tests.
    if(error.message!=="Authentication required")throw error;
  }
  finally {
    settleUnauthenticated();
  }
});
$$("[data-action]").forEach((button) => button.addEventListener("click", () => actions[button.dataset.action]?.()));
$$("nav [data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$$("[data-view-target]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.viewTarget)));
async function showView(view) {
  const target=$(`#${view}`);if(!target||$(`[data-view="${view}"]`)?.hidden)return;
  $$(".view").forEach(v=>v.hidden=v.id!==view); $$("nav button").forEach(b=>b.classList.toggle("active",b.dataset.view===view)); $("#page-title").textContent={dashboard:"Good morning",calendar:"Your calendar",customers:"Client care",setup:"Salon setup",reports:"Business reports"}[view];
  try{
    state.me=await api("/api/me");applyPermissions();
    if($(`[data-view="${view}"]`)?.hidden){
      $$(".view").forEach(v=>v.hidden=v.id!=="dashboard");
      $("#page-title").textContent="Good morning";
    }
  }catch{return bootstrap();}
}
$$(".close").forEach((button)=>button.addEventListener("click",()=>$("#modal").close()));
$("#customer-search").addEventListener("input", async (event)=>{
  const sequence=++customerSearchSequence;
  const customers=await api(`/api/customers?q=${encodeURIComponent(event.target.value)}`);
  if(sequence!==customerSearchSequence)return;
  state.customers=customers;renderCustomersEnhanced();
});
$("#today").textContent = new Date().toLocaleDateString([], { weekday:"long", month:"short", day:"numeric" });
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
