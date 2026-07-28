const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { me: null, customers: [], pets: [], employees: [], services: [], appointments: [], login: false };

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong");
  return result;
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

async function bootstrap() {
  try {
    state.me = await api("/api/me");
    $("#auth-view").hidden = true; $("#app-view").hidden = false;
    $("#salon-name").textContent = state.me.business.name;
    await refresh();
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
    safe("appointments.view") ? api(`/api/appointments?from=${new Date(Date.now()-86400000).toISOString()}&to=${new Date(Date.now()+8*86400000).toISOString()}`) : []
  ];
  const [dashboard, customers, pets, employees, services, appointments] = await Promise.all(requests);
  Object.assign(state, { customers, pets, employees, services, appointments });
  renderDashboard(dashboard); renderCustomers(); renderSetup(); renderAppointments();
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

function appointmentHtml(item) {
  const time = new Date(item.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const customer = `${item.firstName} ${item.lastName}`;
  const action = {scheduled:"Check in",checked_in:"Start service",in_service:"Complete",completed:"Checkout"}[item.status];
  return `<div class="appointment"><time>${time}</time><div><span class="pet">${escape(item.petName)}</span><small>${escape(customer)} · ${escape(item.employeeName)}</small>${item.safetyAlerts ? `<small>⚠ ${escape(item.safetyAlerts)}</small>` : ""}</div><div class="appointment-actions"><span class="badge ${item.status}">${item.status.replace("_"," ")}</span>${action ? `<button class="text-button appointment-action" data-id="${item.id}" data-status="${item.status}">${action} →</button>` : ""}</div></div>`;
}
function renderAppointments() {
  const html = state.appointments.length ? state.appointments.map(appointmentHtml).join("") : "No appointments scheduled.";
  $("#calendar-list").innerHTML = html; $("#calendar-list").classList.toggle("empty", !state.appointments.length);
  const today = new Date().toDateString();
  const todays = state.appointments.filter((item) => new Date(item.startAt).toDateString() === today);
  $("#today-list").innerHTML = todays.length ? todays.map(appointmentHtml).join("") : "No appointments today.";
  $$(".appointment-action").forEach((button) => button.addEventListener("click", () => advanceAppointment(button.dataset.id, button.dataset.status)));
}
async function advanceAppointment(id, status) {
  if (status === "completed") return checkout(id);
  const next = {scheduled:"checked_in",checked_in:"in_service",in_service:"completed"}[status];
  try { await api(`/api/appointments/${id}/transition`,{method:"POST",body:JSON.stringify({status:next})}); toast(`Appointment ${next.replace("_"," ")}`); await refresh(); }
  catch (error) { toast(error.message); }
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
}

function field(name, label, type = "text", extra = "", wide = false) {
  return `<label class="${wide ? "wide" : ""}">${label}<input name="${name}" type="${type}" ${extra}></label>`;
}
function select(name, label, options, wide = false) {
  return `<label class="${wide ? "wide" : ""}">${label}<select name="${name}" required><option value="">Choose…</option>${options.map(([v,l]) => `<option value="${v}">${escape(l)}</option>`).join("")}</select></label>`;
}
function openModal(title, fields, submit) {
  $("#modal-title").textContent = title; $("#modal-fields").innerHTML = fields; $("#modal-error").textContent = "";
  $("#modal-form").onsubmit = async (event) => {
    event.preventDefault(); $("#modal-error").textContent = "";
    try { await submit(new FormData(event.currentTarget)); $("#modal").close(); toast(`${title} saved`); await refresh(); }
    catch (error) { $("#modal-error").textContent = error.message; }
  };
  $("#modal").showModal();
}

const actions = {
  "new-customer": () => openModal("New customer",
    field("firstName","First name","text","required")+field("lastName","Last name","text","required")+field("email","Email","email")+field("phone","Phone","tel")+field("notes","Notes","text","",true),
    (form) => api("/api/customers",{method:"POST",body:JSON.stringify(Object.fromEntries(form))})),
  "new-pet": () => openModal("New pet",
    select("customerId","Customer",state.customers.map(c=>[c.id,`${c.firstName} ${c.lastName}`]),true)+field("name","Pet name","text","required")+field("breed","Breed")+field("species","Species","text",'value="dog"')+field("safetyAlerts","Safety alert","text","",true)+field("medicalNotes","Medical notes","text","",true),
    (form) => api("/api/pets",{method:"POST",body:JSON.stringify(Object.fromEntries(form))})),
  "new-service": () => openModal("New service",
    field("name","Service name","text","required")+field("baseDurationMinutes","Duration (minutes)","number",'required min="1"')+field("basePrice","Price ($)","number",'required min="0" step=".01"')+field("description","Description","text","",true),
    (form) => { const o=Object.fromEntries(form); o.baseDurationMinutes=Number(o.baseDurationMinutes); o.basePriceMinor=Math.round(Number(o.basePrice)*100); delete o.basePrice; return api("/api/services",{method:"POST",body:JSON.stringify(o)}); }),
  "new-employee": () => openModal("New team member",
    field("displayName","Display name","text","required",true),
    (form) => api("/api/employees",{method:"POST",body:JSON.stringify({...Object.fromEntries(form),serviceIds:[]})})),
  "new-appointment": () => openModal("New appointment",
    select("customerId","Customer",state.customers.map(c=>[c.id,`${c.firstName} ${c.lastName}`]))+
    select("petId","Pet",state.pets.map(p=>[p.id,p.name]))+
    select("employeeId","Groomer",state.employees.filter(e=>e.active).map(e=>[e.id,e.displayName]))+
    select("serviceId","Service",state.services.filter(s=>s.active).map(s=>[s.id,`${s.name} · ${money(s.basePriceMinor)}`]))+
    field("startAt","Start time","datetime-local","required",true)+field("notes","Appointment notes","text","",true),
    (form) => { const o=Object.fromEntries(form); return api("/api/appointments",{method:"POST",body:JSON.stringify({locationId:state.me.business.locationId,customerId:o.customerId,petId:o.petId,employeeId:o.employeeId,serviceIds:[o.serviceId],startAt:new Date(o.startAt).toISOString(),notes:o.notes||null})}); })
};

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault(); $("#auth-error").textContent = "";
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    await api(state.login ? "/api/auth/login" : "/api/auth/signup", { method: "POST", body: JSON.stringify(data) });
    await bootstrap();
  } catch (error) { $("#auth-error").textContent = error.message; }
});
$("#toggle-auth").addEventListener("click", () => {
  state.login = !state.login; $("#business-field").hidden = state.login; $("#business-field input").required = !state.login;
  $("#auth-title").textContent = state.login ? "Welcome back" : "Create your salon";
  $("#auth-subtitle").textContent = state.login ? "Sign in to continue your day." : "Set up your workspace in under a minute.";
  $("#auth-form button").textContent = state.login ? "Sign in" : "Create workspace";
  $("#toggle-auth").textContent = state.login ? "New to Pawsh? Create a workspace" : "Already have an account? Sign in";
});
$("#logout").addEventListener("click", async () => { await api("/api/auth/logout",{method:"POST"}); location.reload(); });
$$("[data-action]").forEach((button) => button.addEventListener("click", () => actions[button.dataset.action]?.()));
$$("nav [data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
$$("[data-view-target]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.viewTarget)));
function showView(view) { $$(".view").forEach(v=>v.hidden=v.id!==view); $$("nav button").forEach(b=>b.classList.toggle("active",b.dataset.view===view)); $("#page-title").textContent={dashboard:"Good morning",calendar:"Your calendar",customers:"Client care",setup:"Salon setup"}[view]; }
$$(".close").forEach((button)=>button.addEventListener("click",()=>$("#modal").close()));
$("#customer-search").addEventListener("input", async (event)=>{state.customers=await api(`/api/customers?q=${encodeURIComponent(event.target.value)}`);renderCustomers();});
$("#today").textContent = new Date().toLocaleDateString([], { weekday:"long", month:"short", day:"numeric" });
bootstrap();
