import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl=process.env.DATABASE_URL;
const describeDatabase=databaseUrl?describe:describe.skip;
const config:Config={NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,DATABASE_URL:databaseUrl??"postgres://unavailable",SESSION_SECRET:"account-profile-test-secret-at-least-32-characters",APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false};
const cookie=(response:{headers:Record<string,unknown>})=>String(response.headers["set-cookie"]).split(";",1)[0]!;

describeDatabase("authenticated account profile",()=>{
  let db:Database;
  let app:Awaited<ReturnType<typeof createApp>>;
  const suffix=crypto.randomUUID();
  const email=`profile-${suffix}@example.test`;
  const password="correct horse profile battery";
  let ownerCookie:string;

  beforeAll(async()=>{
    db=createDatabase(config);
    app=await createApp(config,db,{runWorker:false,serveStatic:false});
    await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email,password,businessName:"Profile Salon"}});
    ownerCookie=cookie(signup);
  });
  afterAll(async()=>{await app.close();await db.end();});

  it("returns safe account and membership information through /api/me",async()=>{
    const response=await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({account:{email,displayName:`profile-${suffix}`},isOwner:true,business:{name:"Profile Salon"}});
    expect(response.body).not.toMatch(/password|token|session/i);
  });

  it("updates only the authenticated user's display name and rejects authority fields",async()=>{
    const updated=await app.inject({method:"PATCH",url:"/api/me",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{displayName:"Callie Parker"}});
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({account:{email,displayName:"Callie Parker"}});
    const forbidden=await app.inject({method:"PATCH",url:"/api/me",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{displayName:"Callie",isOwner:false,businessId:crypto.randomUUID(),email:"changed@example.test"}});
    expect(forbidden.statusCode).toBe(400);
    const me=await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}});
    expect(me.json()).toMatchObject({account:{email,displayName:"Callie Parker"},isOwner:true});
  });

  it("requires the current password, preserves this session, and revokes other sessions",async()=>{
    const secondLogin=await app.inject({method:"POST",url:"/api/auth/login",payload:{email,password}});
    const secondCookie=cookie(secondLogin);
    const incorrect=await app.inject({method:"POST",url:"/api/me/password",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{currentPassword:"incorrect password",newPassword:"new correct horse profile battery"}});
    expect(incorrect.statusCode).toBe(400);
    const changed=await app.inject({method:"POST",url:"/api/me/password",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{currentPassword:password,newPassword:"new correct horse profile battery"}});
    expect(changed.statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:"/api/me",headers:{cookie:ownerCookie}})).statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:"/api/me",headers:{cookie:secondCookie}})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/api/auth/login",payload:{email,password}})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/api/auth/login",payload:{email,password:"new correct horse profile battery"}})).statusCode).toBe(200);
  });

  it("keeps profiles tenant-safe by deriving identity from the session",async()=>{
    const otherEmail=`other-profile-${suffix}@example.test`;
    const other=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:otherEmail,password:"correct horse other profile",businessName:"Other Profile Salon"}});
    const otherMe=await app.inject({method:"GET",url:"/api/me",headers:{cookie:cookie(other)}});
    expect(otherMe.statusCode).toBe(200);
    expect(otherMe.json()).toMatchObject({account:{email:otherEmail},business:{name:"Other Profile Salon"}});
    expect(otherMe.body).not.toContain("Callie Parker");
  });

  it("allows a non-owner to view and update only their own personal profile",async()=>{
    const memberEmail=`member-profile-${suffix}@example.test`;
    const invitation=await app.inject({method:"POST",url:"/api/members/invitations",headers:{cookie:ownerCookie,origin:config.APP_ORIGIN},payload:{email:memberEmail,permissions:["calendar.view"]}});
    const token=new URL(invitation.json().acceptancePath,"http://localhost").searchParams.get("invite");
    const accepted=await app.inject({method:"POST",url:"/api/auth/invitations/accept",payload:{token,password:"correct horse member profile"}});
    const memberCookie=cookie(accepted);
    const updated=await app.inject({method:"PATCH",url:"/api/me",headers:{cookie:memberCookie,origin:config.APP_ORIGIN},payload:{displayName:"Morgan Member"}});
    expect(updated.statusCode).toBe(200);
    const me=await app.inject({method:"GET",url:"/api/me",headers:{cookie:memberCookie}});
    expect(me.json()).toMatchObject({account:{email:memberEmail,displayName:"Morgan Member"},isOwner:false,permissions:["calendar.view"],business:{name:"Profile Salon"}});
  });
});
