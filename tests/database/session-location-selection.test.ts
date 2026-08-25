import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl=process.env.DATABASE_URL;
const describeDatabase=databaseUrl?describe:describe.skip;
const config:Config={NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,DATABASE_URL:databaseUrl??"postgres://unavailable",SESSION_SECRET:"session-location-test-secret-at-least-32-characters",APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false};
const cookie=(response:{headers:Record<string,unknown>})=>String(response.headers["set-cookie"]).split(";",1)[0]!;

interface LocationRow{id:string;name:string;address:string|null;timezone:string;version:number;current:boolean}

describeDatabase("session location selection",()=>{
  let db:Database;
  let app:Awaited<ReturnType<typeof createApp>>;
  const suffix=crypto.randomUUID();
  const email=`location-${suffix}@example.test`;
  const password="correct horse location battery";
  let ownerCookie:string;
  let businessId:string;
  let originalLocationId:string;
  // "Airport" sorts ahead of the signup location, so an ordering regression is visible.
  let airportId:string;
  let harborId:string;

  beforeAll(async()=>{
    db=createDatabase(config);
    app=await createApp(config,db,{runWorker:false,serveStatic:false});
    await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email,password,businessName:"Multi Location Salon"}});
    ownerCookie=cookie(signup);
    businessId=signup.json().businessId;
    originalLocationId=signup.json().locationId;
    const [airport]=await db<{id:string}[]>`
      insert into locations(business_id,name,address,timezone)
      values (${businessId},'Airport','1 Runway Rd','America/Denver') returning id`;
    const [harbor]=await db<{id:string}[]>`
      insert into locations(business_id,name,address,timezone)
      values (${businessId},'Harbor','9 Dock St','America/New_York') returning id`;
    airportId=airport!.id;harborId=harbor!.id;
  });
  afterAll(async()=>{await app.close();await db.end();});

  it("allows a business to hold several active locations",async()=>{
    const active=await db<{count:number}[]>`
      select count(*)::int as count from locations where business_id=${businessId} and active`;
    expect(active[0]?.count).toBe(3);
  });

  it("lists active locations by name and flags the current one",async()=>{
    const response=await app.inject({method:"GET",url:"/api/locations",headers:{cookie:ownerCookie}});
    expect(response.statusCode).toBe(200);
    const rows=response.json() as LocationRow[];
    expect(rows.map(row=>row.name)).toEqual(["Airport","Harbor","Multi Location Salon"]);
    expect(rows.filter(row=>row.current)).toHaveLength(1);
    expect(rows.find(row=>row.current)?.id).toBe(originalLocationId);
    expect(rows.find(row=>row.name==="Airport")).toMatchObject({address:"1 Runway Rd",timezone:"America/Denver",version:1,current:false});
  });

  it("requires authentication to list locations",async()=>{
    expect((await app.inject({method:"GET",url:"/api/locations"})).statusCode).toBe(401);
  });

  it("resolves /api/me deterministically and reports the active location count",async()=>{
    const first=(await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}})).json();
    const second=(await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}})).json();
    expect(first.business.locationId).toBe(originalLocationId);
    expect(second.business.locationId).toBe(originalLocationId);
    expect(first.business.locationCount).toBe(3);
    expect(first.business).toMatchObject({locationName:"Multi Location Salon",timezone:"America/Los_Angeles"});
    expect(typeof first.business.locationVersion).toBe("number");
  });

  it("switches the session location and carries the location timezone with it",async()=>{
    const switched=await app.inject({method:"POST",url:"/api/me/location",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{locationId:harborId}});
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toEqual({locationId:harborId,locationName:"Harbor",timezone:"America/New_York",locationVersion:1});
    const me=(await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}})).json();
    expect(me.business).toMatchObject({locationId:harborId,locationName:"Harbor",timezone:"America/New_York",locationVersion:1,locationCount:3});
    const rows=(await app.inject({method:"GET",url:"/api/locations",headers:{cookie:ownerCookie}})).json() as LocationRow[];
    expect(rows.find(row=>row.current)?.id).toBe(harborId);
  });

  it("persists the choice on the session row so it survives a reload",async()=>{
    const [session]=await db<{locationId:string|null}[]>`
      select location_id from sessions where user_id=(select id from users where normalized_email=${email})
        and revoked_at is null order by created_at desc limit 1`;
    expect(session?.locationId).toBe(harborId);
    const reloaded=await createApp(config,db,{runWorker:false,serveStatic:false});
    await reloaded.ready();
    const me=(await reloaded.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}})).json();
    expect(me.business.locationId).toBe(harborId);
    await reloaded.close();
  });

  it("scopes business settings and working hours to the selected location",async()=>{
    const me=(await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}})).json();
    const saved=await app.inject({method:"PUT",url:"/api/business/settings",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},
      payload:{name:"Harbor Salon",currency:"USD",taxRateBasisPoints:0,reminderLeadMinutes:1440,timezone:"America/Chicago",locationVersion:me.business.locationVersion}});
    expect(saved.statusCode).toBe(200);
    const [harbor]=await db<{timezone:string;name:string}[]>`select timezone,name from locations where id=${harborId}`;
    expect(harbor).toMatchObject({timezone:"America/Chicago",name:"Harbor Salon"});
    const [untouched]=await db<{timezone:string}[]>`select timezone from locations where id=${originalLocationId}`;
    expect(untouched?.timezone).toBe("America/Los_Angeles");
    await app.inject({method:"PUT",url:"/api/business/working-hours",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{hours:[{weekday:1,startTime:"09:00",endTime:"17:00"}]}});
    const hours=await db<{locationId:string}[]>`select location_id from business_hours where business_id=${businessId}`;
    expect(hours.map(row=>row.locationId)).toEqual([harborId]);
    const readBack=(await app.inject({method:"GET",url:"/api/business/working-hours",headers:{cookie:ownerCookie}})).json();
    expect(readBack).toHaveLength(1);
  });

  it("falls back deterministically when the chosen location is deactivated",async()=>{
    await db`update locations set active=false where id=${harborId}`;
    const me=(await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}})).json();
    expect(me.business.locationId).toBe(airportId);
    expect(me.business.locationCount).toBe(2);
    expect(me.business.timezone).toBe("America/Denver");
    const rejected=await app.inject({method:"POST",url:"/api/me/location",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{locationId:harborId}});
    expect(rejected.statusCode).toBe(404);
    await db`update locations set active=true where id=${harborId}`;
    await app.inject({method:"POST",url:"/api/me/location",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{locationId:harborId}});
  });

  it("falls back for a legacy session that has no stored location",async()=>{
    const login=await app.inject({method:"POST",url:"/api/auth/login",payload:{email,password}});
    const legacyCookie=cookie(login);
    await db`update sessions set location_id=null where user_id=(select id from users where normalized_email=${email})`;
    const me=(await app.inject({method:"GET",url:"/api/me",headers:{cookie:legacyCookie}})).json();
    expect(me.business.locationId).toBe(airportId);
    expect(me.locationId).toBe(airportId);
    await app.inject({method:"POST",url:"/api/me/location",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{locationId:harborId}});
  });

  it("refuses a location owned by another business without disclosing that it exists",async()=>{
    const intruderEmail=`intruder-${suffix}@example.test`;
    const other=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:intruderEmail,password:"correct horse intruder battery",businessName:"Rival Salon"}});
    const otherCookie=cookie(other);
    const rivalLocationId=other.json().locationId;

    const stolen=await app.inject({method:"POST",url:"/api/me/location",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{locationId:rivalLocationId}});
    expect(stolen.statusCode).toBe(404);
    expect(stolen.json()).toEqual({error:"Location is unavailable"});
    const unknown=await app.inject({method:"POST",url:"/api/me/location",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{locationId:crypto.randomUUID()}});
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(stolen.json());

    const me=(await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}})).json();
    expect(me.business.locationId).toBe(harborId);
    const rivalRows=(await app.inject({method:"GET",url:"/api/locations",headers:{cookie:otherCookie}})).json() as LocationRow[];
    expect(rivalRows.map(row=>row.id)).toEqual([rivalLocationId]);
    const ownRows=(await app.inject({method:"GET",url:"/api/locations",headers:{cookie:ownerCookie}})).json() as LocationRow[];
    expect(ownRows.some(row=>row.id===rivalLocationId)).toBe(false);
    expect(ownRows).toHaveLength(3);
  });

  it("rejects a malformed body",async()=>{
    const response=await app.inject({method:"POST",url:"/api/me/location",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{locationId:"not-a-uuid"}});
    expect(response.statusCode).toBe(400);
    const extra=await app.inject({method:"POST",url:"/api/me/location",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{locationId:airportId,businessId:crypto.randomUUID()}});
    expect(extra.statusCode).toBe(400);
  });

  it("requires authentication to switch location",async()=>{
    const response=await app.inject({method:"POST",url:"/api/me/location",headers:{origin:config.APP_ORIGIN},payload:{locationId:airportId}});
    expect(response.statusCode).toBe(401);
  });

  it("drops the stored location when the session switches workspace",async()=>{
    const secondBusinessEmail=`workspace-${suffix}@example.test`;
    const second=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:secondBusinessEmail,password:"correct horse workspace battery",businessName:"Second Workspace"}});
    const secondBusinessId=second.json().businessId;
    const secondLocationId=second.json().locationId;
    await db`insert into business_memberships(business_id,user_id,is_owner,permissions)
      values (${secondBusinessId},(select id from users where normalized_email=${email}),false,${["calendar.view","settings.manage"] as unknown as string[]})`;

    const switched=await app.inject({method:"POST",url:"/api/workspaces/select",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{businessId:secondBusinessId}});
    expect(switched.statusCode).toBe(200);
    const me=(await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}})).json();
    expect(me.businessId).toBe(secondBusinessId);
    expect(me.business.locationId).toBe(secondLocationId);
    expect(me.business.locationCount).toBe(1);

    const back=await app.inject({method:"POST",url:"/api/workspaces/select",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{businessId}});
    expect(back.statusCode).toBe(200);
    const restored=(await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}})).json();
    expect(restored.businessId).toBe(businessId);
    expect(restored.business.locationId).toBe(airportId);
  });

  it("keeps the session location inside its business at the database level",async()=>{
    const [rival]=await db<{id:string}[]>`select id from locations where business_id<>${businessId} limit 1`;
    await expect(db`
      update sessions set location_id=${rival!.id}
      where user_id=(select id from users where normalized_email=${email}) and business_id=${businessId}
    `).rejects.toThrow(/sessions_location_within_business|foreign key/i);
  });
});
