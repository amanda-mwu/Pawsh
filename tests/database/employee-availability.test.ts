import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl=process.env.DATABASE_URL;
const describeDatabase=databaseUrl?describe:describe.skip;
const config:Config={NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,DATABASE_URL:databaseUrl??"postgres://unavailable",SESSION_SECRET:"employee-availability-secret-32-chars",APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false};
const cookie=(response:{headers:Record<string,unknown>})=>String(response.headers["set-cookie"]).split(";",1)[0]!;

interface Period{weekday:number;startTime:string;endTime:string}

// Guards the regression where the employee editor had no read endpoint and initialised every
// existing groomer from a hardcoded Mon-Fri 09:00-17:00 grid, silently proposing to overwrite
// real stored availability.
describeDatabase("employee working hours round trip",()=>{
  let db:Database,app:Awaited<ReturnType<typeof createApp>>;
  let ownerCookie:string,employeeId:string;
  // Deliberately not Mon-Fri 09:00-17:00: closed Sunday/Wednesday/Saturday, non-standard times.
  const stored:Period[]=[
    {weekday:1,startTime:"07:30",endTime:"11:45"},
    {weekday:2,startTime:"10:15",endTime:"19:05"},
    {weekday:4,startTime:"06:00",endTime:"23:59"},
    {weekday:5,startTime:"12:00",endTime:"16:30"}
  ];

  beforeAll(async()=>{
    db=createDatabase(config);app=await createApp(config,db,{runWorker:false,serveStatic:false});await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",
      payload:{email:`availability-${crypto.randomUUID()}@example.test`,password:"correct horse availability battery",businessName:"Availability Salon"}});
    ownerCookie=cookie(signup);
    employeeId=(await app.inject({method:"POST",url:"/api/employees",headers:{cookie:ownerCookie},
      payload:{displayName:"Real Hours Groomer",serviceIds:[]}})).json().id;
    const saved=await app.inject({method:"PUT",url:`/api/employees/${employeeId}/working-hours`,
      headers:{cookie:ownerCookie},payload:{hours:stored}});
    expect(saved.statusCode).toBe(204);
  });
  afterAll(async()=>{await app.close();await db.end();});

  const read=(cookieValue=ownerCookie)=>app.inject({method:"GET",
    url:`/api/employees/${employeeId}/working-hours`,headers:{cookie:cookieValue}});

  it("returns the stored schedule, not a fabricated Mon-Fri 09:00-17:00 default",async()=>{
    const response=await read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(stored);
    const days=response.json().map((period:Period)=>period.weekday);
    expect(days).not.toContain(0);
    expect(days).not.toContain(3);
    expect(days).not.toContain(6);
    expect(response.json().every((period:Period)=>period.startTime!=="09:00"||period.endTime!=="17:00")).toBe(true);
  });

  it("emits an editor-compatible HH:MM representation that PUT accepts unchanged",async()=>{
    const before=await read();
    const echoed=await app.inject({method:"PUT",url:`/api/employees/${employeeId}/working-hours`,
      headers:{cookie:ownerCookie},payload:{hours:before.json()}});
    expect(echoed.statusCode).toBe(204);
    const after=await read();
    expect(after.json()).toEqual(before.json());
    expect(after.json()).toEqual(stored);
    for(const period of after.json() as Period[]){
      expect(period.startTime).toMatch(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
      expect(period.endTime).toMatch(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
    }
  });

  it("keeps closed days closed when a day is removed and restored",async()=>{
    const withoutFriday=stored.filter((period)=>period.weekday!==5);
    expect((await app.inject({method:"PUT",url:`/api/employees/${employeeId}/working-hours`,
      headers:{cookie:ownerCookie},payload:{hours:withoutFriday}})).statusCode).toBe(204);
    expect((await read()).json()).toEqual(withoutFriday);
    expect((await app.inject({method:"PUT",url:`/api/employees/${employeeId}/working-hours`,
      headers:{cookie:ownerCookie},payload:{hours:stored}})).statusCode).toBe(204);
    expect((await read()).json()).toEqual(stored);
  });

  it("validates the employee identifier and rejects cross-tenant reads",async()=>{
    const malformed=await app.inject({method:"GET",url:"/api/employees/not-a-uuid/working-hours",headers:{cookie:ownerCookie}});
    expect(malformed.statusCode).toBe(400);
    const unknown=await app.inject({method:"GET",
      url:`/api/employees/${crypto.randomUUID()}/working-hours`,headers:{cookie:ownerCookie}});
    expect(unknown.statusCode).toBe(404);
    const foreign=await app.inject({method:"POST",url:"/api/auth/signup",
      payload:{email:`availability-foreign-${crypto.randomUUID()}@example.test`,password:"correct horse foreign availability",businessName:"Foreign Availability"}});
    const crossTenant=await read(cookie(foreign));
    expect(crossTenant.statusCode).toBe(404);
    const crossTenantWrite=await app.inject({method:"PUT",url:`/api/employees/${employeeId}/working-hours`,
      headers:{cookie:cookie(foreign)},payload:{hours:[{weekday:0,startTime:"00:00",endTime:"23:59"}]}});
    expect(crossTenantWrite.statusCode).toBe(404);
    expect((await read()).json()).toEqual(stored);
  });
});
