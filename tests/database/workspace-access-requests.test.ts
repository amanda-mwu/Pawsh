import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import type { Config } from "../../src/config.js";
import { createDatabase, type Database } from "../../src/db/client.js";

const databaseUrl=process.env.DATABASE_URL;
const describeDatabase=databaseUrl?describe:describe.skip;
const config:Config={NODE_ENV:"test",DOCUMENT_STORAGE_ADAPTER:"memory",PORT:3000,DATABASE_URL:databaseUrl??"postgres://unavailable",SESSION_SECRET:"workspace-access-test-secret-at-least-32-chars",APP_ORIGIN:"http://localhost:3000",SMTP_PORT:587,SMTP_SECURE:false};
const cookie=(response:{headers:Record<string,unknown>})=>String(response.headers["set-cookie"]).split(";",1)[0]!;

describeDatabase("existing workspace access requests",()=>{
  let db:Database;
  let app:Awaited<ReturnType<typeof createApp>>;
  const suffix=crypto.randomUUID();
  const ownerEmail=`access-owner-${suffix}@example.test`;
  let ownerCookie:string,businessId:string;

  beforeAll(async()=>{
    db=createDatabase(config);app=await createApp(config,db,{runWorker:false,serveStatic:false});await app.ready();
    const signup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:ownerEmail,password:"correct horse access owner",businessName:`Access Salon ${suffix}`}});
    ownerCookie=cookie(signup);businessId=signup.json().businessId;
  });
  afterAll(async()=>{await app.close();await db.end();});

  const request=(email:string)=>app.inject({method:"POST",url:"/api/workspace-access-requests",payload:{requesterName:"Prospective Groomer",requesterEmail:email,workspaceName:`Access Salon ${suffix}`,workspaceAdminEmail:ownerEmail,message:"Please review my request."}});

  it("accepts anonymous requests generically, suppresses duplicates, and notifies reviewers",async()=>{
    const email=`pending-${suffix}@example.test`;
    const [first,duplicate,unknown]=await Promise.all([request(email),request(email),app.inject({method:"POST",url:"/api/workspace-access-requests",payload:{requesterName:"Unknown",requesterEmail:`unknown-${suffix}@example.test`,workspaceName:"No Such Workspace",workspaceAdminEmail:ownerEmail}})]);
    for(const response of [first,duplicate,unknown]){expect(response.statusCode).toBe(202);expect(response.json()).toEqual({accepted:true,message:"If the request can be processed, the workspace administrator will be notified."});}
    const [count]=await db<{count:number}[]>`select count(*)::int count from workspace_access_requests where business_id=${businessId} and normalized_email=${email}`;
    expect(count?.count).toBe(1);
    const [notifications]=await db<{count:number}[]>`select count(*)::int count from notification_intents where business_id=${businessId} and notification_type='workspace_access_request'`;
    expect(notifications!.count).toBeGreaterThan(0);
    expect((await app.inject({method:"GET",url:"/api/workspace-access-requests"})).statusCode).toBe(401);
  });

  it("lets a team manager review but never lets the requester choose privilege",async()=>{
    const staffEmail=`staff-${suffix}@example.test`;
    const staffInvitation=await app.inject({method:"POST",url:"/api/members/invitations",headers:{cookie:ownerCookie},payload:{email:staffEmail,permissions:["calendar.view"]}});
    const staffToken=new URL(staffInvitation.json().acceptancePath,"http://localhost").searchParams.get("invite");
    const staff=await app.inject({method:"POST",url:"/api/auth/invitations/accept",payload:{token:staffToken,password:"correct horse access staff"}});
    expect((await app.inject({method:"GET",url:"/api/workspace-access-requests",headers:{cookie:cookie(staff)}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:"/api/workspace-access-requests",payload:{requesterName:"Escalation",requesterEmail:`escalation-${suffix}@example.test`,workspaceName:`Access Salon ${suffix}`,workspaceAdminEmail:ownerEmail,role:"owner"}})).statusCode).toBe(400);
    const managerEmail=`manager-${suffix}@example.test`;
    const invitation=await app.inject({method:"POST",url:"/api/members/invitations",headers:{cookie:ownerCookie},payload:{email:managerEmail,permissions:["team.manage"]}});
    const token=new URL(invitation.json().acceptancePath,"http://localhost").searchParams.get("invite");
    const accepted=await app.inject({method:"POST",url:"/api/auth/invitations/accept",payload:{token,password:"correct horse access manager"}});
    expect((await app.inject({method:"GET",url:"/api/workspace-access-requests",headers:{cookie:cookie(accepted)}})).statusCode).toBe(200);

    const requesterEmail=`new-user-${suffix}@example.test`;await request(requesterEmail);
    const list=await app.inject({method:"GET",url:"/api/workspace-access-requests",headers:{cookie:ownerCookie}});
    const pending=list.json().find((item:{requesterEmail:string})=>item.requesterEmail===requesterEmail);
    const approval=await app.inject({method:"POST",url:`/api/workspace-access-requests/${pending.id}/approve`,headers:{cookie:ownerCookie}});
    expect(approval.statusCode).toBe(200);expect(approval.json()).toMatchObject({approved:true,membershipCreated:false,invitationCreated:true});
    const invitationRow=await db<{permissions:string[];invitedBy:string}[]>`select permissions,invited_by from membership_invitations where business_id=${businessId} and normalized_email=${requesterEmail}`;
    expect(invitationRow[0]?.permissions).not.toContain("team.manage");
    expect(invitationRow[0]?.permissions).not.toContain("settings.manage");
  });

  it("adds an existing user exactly once, permits workspace selection, and enforces tenant boundaries",async()=>{
    const existingEmail=`existing-${suffix}@example.test`;
    const otherSignup=await app.inject({method:"POST",url:"/api/auth/signup",payload:{email:existingEmail,password:"correct horse existing member",businessName:`Other Salon ${suffix}`}});
    const otherCookie=cookie(otherSignup);await request(existingEmail);
    const pending=(await app.inject({method:"GET",url:"/api/workspace-access-requests",headers:{cookie:ownerCookie}})).json().find((item:{requesterEmail:string})=>item.requesterEmail===existingEmail);
    expect((await app.inject({method:"POST",url:`/api/workspace-access-requests/${pending.id}/approve`,headers:{cookie:otherCookie}})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:`/api/workspace-access-requests/${pending.id}/approve`,headers:{cookie:ownerCookie}})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:`/api/workspace-access-requests/${pending.id}/approve`,headers:{cookie:ownerCookie}})).statusCode).toBe(404);
    const workspaces=await app.inject({method:"GET",url:"/api/workspaces",headers:{cookie:otherCookie}});
    expect(workspaces.json()).toHaveLength(2);
    expect((await app.inject({method:"POST",url:"/api/workspaces/select",headers:{cookie:otherCookie},payload:{businessId}})).statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:"/api/me",headers:{cookie:otherCookie}})).json().business.id).toBe(businessId);
    const [memberships]=await db<{count:number}[]>`select count(*)::int count from business_memberships membership join users account on account.id=membership.user_id where membership.business_id=${businessId} and account.normalized_email=${existingEmail}`;
    expect(memberships?.count).toBe(1);
  });

  it("records an authorized rejection",async()=>{
    const email=`rejected-${suffix}@example.test`;await request(email);
    const pending=(await app.inject({method:"GET",url:"/api/workspace-access-requests",headers:{cookie:ownerCookie}})).json().find((item:{requesterEmail:string})=>item.requesterEmail===email);
    expect((await app.inject({method:"POST",url:`/api/workspace-access-requests/${pending.id}/reject`,headers:{cookie:ownerCookie}})).statusCode).toBe(200);
    const [stored]=await db<{status:string;reviewedBy:string}[]>`select status,reviewed_by from workspace_access_requests where id=${pending.id}`;
    expect(stored).toMatchObject({status:"rejected"});expect(stored?.reviewedBy).toBeTruthy();
  });
});
