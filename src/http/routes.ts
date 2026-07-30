import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { ZodType } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import { canTransition, type AppointmentStatus } from "../domain/appointments.js";
import { calculateInvoice } from "../domain/money.js";
import { permissionPresets, permissions } from "../domain/permissions.js";
import { auth, authentication, issueToken, platformAuthentication, requirePermission, tokenHash } from "./context.js";
import {
  appointmentSchema, checkoutSchema, customerSchema, employeeSchema, idParams, loginSchema,
  normalizeEmail, normalizePhone, paymentSchema, petSchema, serviceSchema, signupSchema,
  transitionSchema, businessSettingsSchema, workingHoursSchema, blockedTimeSchema,
  operationalUpdateSchema, voidPaymentSchema, appointmentMoveSchema, appointmentServicesSchema,
  passwordResetRequestSchema, passwordResetConfirmSchema, invitationSchema,
  invitationAcceptSchema, ownershipTransferSchema
} from "./schemas.js";
import { sealSecret } from "../security/secrets.js";
import { hashPassword, validateNewPassword, verifyPassword } from "../security/passwords.js";

type Transaction = postgres.TransactionSql;

function body<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

async function setTenant(tx: Transaction, businessId: string): Promise<void> {
  await tx`select set_config('app.business_id', ${businessId}, true)`;
}

async function record(
  tx: Transaction,
  input: {
    businessId: string;
    actorId: string;
    action: string;
    resourceType: string;
    resourceId?: string | undefined;
    before?: unknown;
    after?: unknown;
    reason?: string | null | undefined;
    eventType?: string | undefined;
  }
): Promise<void> {
  const correlationId = randomUUID();
  await tx`
    insert into audit_events
      (business_id, actor_id, action, resource_type, resource_id, correlation_id, before_data, after_data, reason)
    values
      (${input.businessId}, ${input.actorId}, ${input.action}, ${input.resourceType},
       ${input.resourceId ?? null}, ${correlationId}, ${input.before ? tx.json(input.before as any) : null},
       ${input.after ? tx.json(input.after as any) : null}, ${input.reason ?? null})
  `;
  if (input.eventType) {
    await tx`
      insert into outbox_events
        (business_id, event_type, actor_id, resource_id, correlation_id, payload)
      values
        (${input.businessId}, ${input.eventType}, ${input.actorId}, ${input.resourceId ?? null},
         ${correlationId}, ${tx.json((input.after ?? {}) as any)})
    `;
    if ([
      "BusinessCreated", "CustomerCreated", "PetCreated", "AppointmentCreated",
      "AppointmentCompleted", "InvoiceCreated", "PaymentRecorded", "EmployeeCreated",
      "ServiceCreated"
    ].includes(input.eventType)) {
      await tx`
        insert into product_analytics_events
          (business_id,user_id,event_name,resource_id,properties)
        values (${input.businessId},${input.actorId},${input.eventType},${input.resourceId ?? null},
          ${tx.json((input.after ?? {}) as any)})
      `;
    }
  }
}

function sessionCookie(config: Config) {
  return {
    path: "/",
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: 60 * 60 * 24 * 14,
    signed: false
  };
}

export function registerRoutes(app: FastifyInstance, db: Database, config: Config): void {
  const authenticate = authentication(db);
  const authenticatePlatform = platformAuthentication(db);

  app.post("/api/auth/signup", async (request, reply) => {
    const input = body(signupSchema, request.body);
    const email = normalizeEmail(input.email);
    await validateNewPassword(input.password, { email });
    const passwordHash = await hashPassword(input.password);
    const result = await db.begin(async (tx) => {
      const [user] = await tx<{ id: string }[]>`
        insert into users (email, normalized_email, password_hash)
        values (${input.email.trim()}, ${email}, ${passwordHash})
        returning id
      `;
      if (!user) throw new Error("User creation failed");
      const [business] = await tx<{ id: string }[]>`
        insert into businesses (name, email) values (${input.businessName}, ${email}) returning id
      `;
      if (!business) throw new Error("Business creation failed");
      await setTenant(tx, business.id);
      const [membership] = await tx<{ id: string }[]>`
        insert into business_memberships (business_id, user_id, is_owner, permissions)
        values (${business.id}, ${user.id}, true, ${permissions as unknown as string[]})
        returning id
      `;
      const [location] = await tx<{ id: string }[]>`
        insert into locations (business_id, name, timezone)
        values (${business.id}, ${input.businessName}, ${input.timezone})
        returning id
      `;
      const token = issueToken();
      await tx`
        insert into sessions (user_id, token_hash, expires_at)
        values (${user.id}, ${tokenHash(token)}, now() + interval '14 days')
      `;
      await record(tx, {
        businessId: business.id, actorId: user.id, action: "business.create",
        resourceType: "business", resourceId: business.id,
        after: { name: input.businessName }, eventType: "BusinessCreated"
      });
      return { userId: user.id, businessId: business.id, membershipId: membership?.id, locationId: location?.id, token };
    });
    return reply
      .setCookie("pawsh_session", result.token, sessionCookie(config))
      .code(201)
      .send({ ...result, token: undefined });
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = body(loginSchema, request.body);
    const [user] = await db<{ id: string; passwordHash: string }[]>`
      select id, password_hash from users
      where normalized_email = ${normalizeEmail(input.email)} and disabled_at is null
    `;
    if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
      return reply.code(401).send({ error: "Invalid email or password" });
    }
    const token = issueToken();
    await db`
      insert into sessions (user_id, token_hash, expires_at)
      values (${user.id}, ${tokenHash(token)}, now() + interval '14 days')
    `;
    return reply.setCookie("pawsh_session", token, sessionCookie(config)).send({ ok: true });
  });

  app.post("/api/auth/logout", { preHandler: authenticate }, async (request, reply) => {
    const token = request.cookies.pawsh_session;
    if (token) await db`update sessions set revoked_at = now() where token_hash = ${tokenHash(token)}`;
    return reply.clearCookie("pawsh_session", { path: "/" }).code(204).send();
  });

  app.post("/api/auth/password-reset/request", async (request) => {
    const input = body(passwordResetRequestSchema, request.body);
    const [user] = await db<{ id: string; businessId: string | null }[]>`
      select user_account.id,
        (
          select membership.business_id from business_memberships membership
          where membership.user_id=user_account.id and membership.status='active'
          order by membership.created_at limit 1
        ) as business_id
      from users user_account
      where user_account.normalized_email=${normalizeEmail(input.email)}
        and user_account.disabled_at is null
    `;
    let developmentToken: string | undefined;
    if (user) {
      const token = issueToken();
      await db.begin(async (tx) => {
        await tx`update password_reset_tokens set used_at=now() where user_id=${user.id} and used_at is null`;
        await tx`
          insert into password_reset_tokens(user_id,token_hash,expires_at)
          values (${user.id},${tokenHash(token)},now()+interval '30 minutes')
        `;
        if (user.businessId) {
          const resetMessage = [
            "A Pawsh password reset was requested for this email address.",
            `Open ${config.APP_ORIGIN}/?reset=${encodeURIComponent(token)} to choose a new password.`,
            "This link expires in 30 minutes. If you did not request it, you can ignore this message."
          ].join("\n\n");
          await tx`select set_config('app.business_id',${user.businessId},true)`;
          await tx`
            insert into notification_intents
              (business_id,customer_id,notification_type,scheduled_occurrence,channel,destination,encrypted_body)
            values (${user.businessId},null,'password_reset',now(),'email',${normalizeEmail(input.email)},
              ${sealSecret(resetMessage,config.SESSION_SECRET)})
          `;
        }
      });
      if (config.NODE_ENV === "test") developmentToken = token;
    }
    return { accepted: true, ...(developmentToken ? { developmentToken } : {}) };
  });

  app.post("/api/auth/password-reset/confirm", async (request, reply) => {
    const input = body(passwordResetConfirmSchema, request.body);
    await validateNewPassword(input.password);
    const passwordHash = await hashPassword(input.password);
    const changed = await db.begin(async (tx) => {
      const [reset] = await tx<{ id: string; userId: string }[]>`
        select id,user_id from password_reset_tokens
        where token_hash=${tokenHash(input.token)} and used_at is null and expires_at>now() for update
      `;
      if (!reset) return false;
      await tx`update users set password_hash=${passwordHash},updated_at=now() where id=${reset.userId}`;
      await tx`update password_reset_tokens set used_at=now() where user_id=${reset.userId} and used_at is null`;
      await tx`update sessions set revoked_at=now() where user_id=${reset.userId} and revoked_at is null`;
      return true;
    });
    if (!changed) return reply.code(400).send({ error: "Reset token is invalid or expired" });
    return { changed: true };
  });

  app.post("/api/auth/invitations/accept", async (request, reply) => {
    const input = body(invitationAcceptSchema, request.body);
    const result = await db.begin(async (tx) => {
      const [invitation] = await tx<{
        id: string; businessId: string; email: string; normalizedEmail: string; permissions: string[];
      }[]>`
        select id,business_id,email,normalized_email,permissions from membership_invitations
        where token_hash=${tokenHash(input.token)} and accepted_at is null and revoked_at is null
          and expires_at>now() for update
      `;
      if (!invitation) return null;
      let [user] = await tx<{ id: string; passwordHash: string }[]>`
        select id,password_hash from users where normalized_email=${invitation.normalizedEmail}
      `;
      if (!user) {
        await validateNewPassword(input.password, { email:invitation.normalizedEmail });
        const passwordHash = await hashPassword(input.password);
        [user] = await tx<{ id: string; passwordHash: string }[]>`
          insert into users(email,normalized_email,password_hash)
          values (${invitation.email},${invitation.normalizedEmail},${passwordHash})
          returning id,password_hash
        `;
      } else {
        if (!(await verifyPassword(user.passwordHash, input.password))) {
          throw new Error("Existing Pawsh users must enter their current password");
        }
        const existingMembership = await tx`
          select id from business_memberships
          where business_id=${invitation.businessId} and user_id=${user.id}
        `;
        if (existingMembership.length) throw new Error("This user already belongs to the business");
      }
      if (!user) throw new Error("Invitation user creation failed");
      const [membership] = await tx<{ id: string }[]>`
        insert into business_memberships(business_id,user_id,permissions,status)
        values (${invitation.businessId},${user.id},${invitation.permissions},'active') returning id
      `;
      await tx`update membership_invitations set accepted_at=now() where id=${invitation.id}`;
      const token = issueToken();
      await tx`
        insert into sessions(user_id,token_hash,expires_at)
        values (${user.id},${tokenHash(token)},now()+interval '14 days')
      `;
      await setTenant(tx, invitation.businessId);
      await record(tx, {
        businessId: invitation.businessId, actorId: user.id, action: "membership.accept",
        resourceType: "membership", resourceId: membership?.id
      });
      return { token, businessId: invitation.businessId };
    });
    if (!result) return reply.code(400).send({ error: "Invitation is invalid or expired" });
    return reply.setCookie("pawsh_session", result.token, sessionCookie(config)).send({ businessId: result.businessId });
  });

  app.get("/api/me", { preHandler: authenticate }, async (request) => {
    const context = auth(request);
    const [business] = await db`
      select b.*, l.id as location_id, l.name as location_name, l.timezone
      from businesses b join locations l on l.business_id = b.id and l.active
      where b.id = ${context.businessId}
    `;
    return { ...context, business };
  });

  app.get("/api/permissions", { preHandler: authenticate }, async () => ({
    permissions, presets: permissionPresets
  }));

  app.put("/api/business/settings", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request) => {
    const context = auth(request);
    const input = body(businessSettingsSchema, request.body);
    return db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [updated] = await tx`
        update businesses set name=${input.name}, phone=${input.phone ?? null}, email=${input.email ?? null},
          currency=${input.currency}, tax_rate_basis_points=${input.taxRateBasisPoints},
          reminder_lead_minutes=${input.reminderLeadMinutes}, updated_at=now()
        where id=${context.businessId} returning *
      `;
      await tx`
        update locations set name=${input.name}, timezone=${input.timezone}, updated_at=now()
        where business_id=${context.businessId} and active
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "business.settings.update",
        resourceType: "business", resourceId: context.businessId
      });
      return updated;
    });
  });

  app.get("/api/members", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request) => {
    const context = auth(request);
    return db`
      select m.id, u.email, m.is_owner, m.permissions, m.status, m.created_at
      from business_memberships m join users u on u.id = m.user_id
      where m.business_id = ${context.businessId}
      order by m.is_owner desc, u.email
    `;
  });

  app.post("/api/members/invitations", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    if (!context.isOwner) return reply.code(403).send({ error: "Only an Owner can invite members" });
    const input = body(invitationSchema, request.body);
    const invitationToken = issueToken();
    const normalized = normalizeEmail(input.email);
    const invitation = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [created] = await tx<{ id: string; email: string; permissions: string[]; expiresAt: Date }[]>`
        insert into membership_invitations
          (business_id,email,normalized_email,token_hash,permissions,invited_by,expires_at)
        values (${context.businessId},${input.email.trim()},${normalized},${tokenHash(invitationToken)},
          ${input.permissions},${context.userId},now()+interval '7 days')
        on conflict (business_id,normalized_email) do update set
          email=excluded.email,token_hash=excluded.token_hash,permissions=excluded.permissions,
          invited_by=excluded.invited_by,expires_at=excluded.expires_at,accepted_at=null,revoked_at=null,
          created_at=now()
        returning id,email,permissions,expires_at
      `;
      if (!created) throw new Error("Invitation creation failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "membership.invite",
        resourceType: "membership_invitation", resourceId: created.id,
        after: { email: created.email }, eventType: "MemberInvited"
      });
      return created;
    });
    return reply.code(201).send({
      ...invitation,
      acceptancePath: `/?invite=${encodeURIComponent(invitationToken)}`
    });
  });

  app.patch("/api/members/:id/permissions", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    if (!context.isOwner) return reply.code(403).send({ error: "Only an Owner can change member access" });
    const { id } = idParams.parse(request.params);
    const input = body(
      (await import("zod")).z.object({ permissions: (await import("zod")).z.array((await import("zod")).z.enum(permissions)) }),
      request.body
    );
    const member = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [before] = await tx<{ permissions: string[] }[]>`
        select permissions from business_memberships
        where id=${id} and business_id=${context.businessId} and not is_owner for update
      `;
      if (!before) return null;
      const [updated] = await tx`
        update business_memberships set permissions=${input.permissions},updated_at=now()
        where id=${id} and business_id=${context.businessId} and not is_owner
        returning id,permissions
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "membership.permissions.update",
        resourceType: "membership", resourceId: id,
        before: { permissions: before.permissions }, after: { permissions: input.permissions }
      });
      return updated;
    });
    if (!member) return reply.code(404).send({ error: "Editable member not found" });
    return member;
  });

  app.delete("/api/members/:id", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    if (!context.isOwner) return reply.code(403).send({ error: "Only an Owner can remove members" });
    const { id } = idParams.parse(request.params);
    const removed = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [membership] = await tx<{ userId: string; isOwner: boolean }[]>`
        select user_id,is_owner from business_memberships
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!membership) return false;
      if (membership.isOwner) throw new Error("Transfer ownership before removing an Owner");
      await tx`
        update business_memberships set status='disabled',updated_at=now()
        where business_id=${context.businessId} and id=${id}
      `;
      await tx`update sessions set revoked_at=now() where user_id=${membership.userId} and revoked_at is null`;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "membership.remove",
        resourceType: "membership", resourceId: id
      });
      return true;
    });
    if (!removed) return reply.code(404).send({ error: "Membership not found" });
    return reply.code(204).send();
  });

  app.post("/api/business/transfer-ownership", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    if (!context.isOwner) return reply.code(403).send({ error: "Only an Owner can transfer ownership" });
    const input = body(ownershipTransferSchema, request.body);
    if (input.membershipId === context.membershipId) {
      return reply.code(400).send({ error: "Select another active member" });
    }
    const transferred = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [target] = await tx<{ id: string }[]>`
        select id from business_memberships
        where business_id=${context.businessId} and id=${input.membershipId} and status='active' for update
      `;
      if (!target) return false;
      await tx`
        update business_memberships set is_owner=true,permissions=${permissions as unknown as string[]},
          updated_at=now() where id=${target.id}
      `;
      await tx`
        update business_memberships set is_owner=false,updated_at=now()
        where id=${context.membershipId}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "ownership.transfer",
        resourceType: "membership", resourceId: target.id,
        after: { previousOwnerMembershipId: context.membershipId }
      });
      return true;
    });
    if (!transferred) return reply.code(404).send({ error: "Active target member not found" });
    return { transferred: true };
  });

  app.get("/api/services", { preHandler: authenticate }, async (request) => {
    const context = auth(request);
    return db`select * from services where business_id = ${context.businessId} order by active desc, name`;
  });

  app.post("/api/services", {
    preHandler: [authenticate, requirePermission("services.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(serviceSchema, request.body);
    const service = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [created] = await tx<{ id: string }[]>`
        insert into services (business_id,name,description,base_duration_minutes,base_price_minor)
        values (${context.businessId},${input.name},${input.description ?? null},
          ${input.baseDurationMinutes},${input.basePriceMinor}) returning *
      `;
      if (!created) throw new Error("Service creation failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "service.create",
        resourceType: "service", resourceId: created.id, eventType: "ServiceCreated"
      });
      return created;
    });
    return reply.code(201).send(service);
  });

  app.put("/api/services/:id", {
    preHandler: [authenticate, requirePermission("services.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(serviceSchema, request.body);
    const [service] = await db`
      update services set name=${input.name},description=${input.description ?? null},
        base_duration_minutes=${input.baseDurationMinutes},base_price_minor=${input.basePriceMinor},
        updated_at=now()
      where business_id=${context.businessId} and id=${id} returning *
    `;
    if (!service) return reply.code(404).send({ error: "Service not found" });
    return service;
  });

  app.delete("/api/services/:id", {
    preHandler: [authenticate, requirePermission("services.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [service] = await db`
      update services set active=false,updated_at=now()
      where business_id=${context.businessId} and id=${id} and active returning id
    `;
    if (!service) return reply.code(404).send({ error: "Active service not found" });
    return reply.code(204).send();
  });

  app.get("/api/employees", { preHandler: authenticate }, async (request) => {
    const context = auth(request);
    return db`
      select e.*,
        coalesce(array_agg(es.service_id) filter (where es.service_id is not null),'{}') as service_ids
      from employees e left join employee_services es on es.employee_id=e.id
      where e.business_id=${context.businessId}
      group by e.id order by e.active desc,e.display_name
    `;
  });

  app.post("/api/employees", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(employeeSchema, request.body);
    const employee = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [created] = await tx<{ id: string; displayName: string }[]>`
        insert into employees (business_id, membership_id, display_name)
        values (${context.businessId}, ${input.membershipId ?? null}, ${input.displayName})
        returning id, display_name
      `;
      if (!created) throw new Error("Employee creation failed");
      for (const serviceId of input.serviceIds) {
        await tx`
          insert into employee_services (business_id, employee_id, service_id)
          values (${context.businessId}, ${created.id}, ${serviceId})
        `;
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "employee.create",
        resourceType: "employee", resourceId: created.id, eventType: "EmployeeCreated"
      });
      return created;
    });
    return reply.code(201).send(employee);
  });

  app.put("/api/employees/:id", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(employeeSchema, request.body);
    const employee = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [updated] = await tx<{ id: string }[]>`
        update employees set display_name=${input.displayName},membership_id=${input.membershipId ?? null},
          updated_at=now() where business_id=${context.businessId} and id=${id} returning *
      `;
      if (!updated) return null;
      await tx`delete from employee_services where business_id=${context.businessId} and employee_id=${id}`;
      for (const serviceId of input.serviceIds) {
        await tx`
          insert into employee_services(business_id,employee_id,service_id)
          values (${context.businessId},${id},${serviceId})
        `;
      }
      return updated;
    });
    if (!employee) return reply.code(404).send({ error: "Employee not found" });
    return employee;
  });

  app.delete("/api/employees/:id", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [employee] = await db`
      update employees set active=false,updated_at=now()
      where business_id=${context.businessId} and id=${id} and active returning id
    `;
    if (!employee) return reply.code(404).send({ error: "Active employee not found" });
    return reply.code(204).send();
  });

  app.put("/api/employees/:id/working-hours", {
    preHandler: [authenticate, requirePermission("team.manage")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(workingHoursSchema, request.body);
    const exists = await db`select id from employees where business_id=${context.businessId} and id=${id}`;
    if (!exists.length) return reply.code(404).send({ error: "Employee not found" });
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      await tx`delete from employee_working_hours where business_id=${context.businessId} and employee_id=${id}`;
      for (const period of input.hours) {
        await tx`
          insert into employee_working_hours (business_id,employee_id,weekday,start_time,end_time)
          values (${context.businessId},${id},${period.weekday},${period.startTime},${period.endTime})
        `;
      }
    });
    return reply.code(204).send();
  });

  app.post("/api/blocked-times", {
    preHandler: [authenticate, requirePermission("appointments.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(blockedTimeSchema, request.body);
    const [created] = await db`
      insert into blocked_times (business_id,employee_id,start_at,end_at,reason,created_by)
      values (${context.businessId},${input.employeeId},${input.startAt},${input.endAt},
        ${input.reason},${context.userId}) returning *
    `;
    return reply.code(201).send(created);
  });

  app.put("/api/business/working-hours", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request) => {
    const context = auth(request);
    const input = body(workingHoursSchema, request.body);
    await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [location] = await tx<{ id: string }[]>`
        select id from locations where business_id=${context.businessId} and active
      `;
      if (!location) throw new Error("Active location not found");
      await tx`delete from business_hours where business_id=${context.businessId} and location_id=${location.id}`;
      for (const period of input.hours) {
        await tx`
          insert into business_hours(business_id,location_id,weekday,start_time,end_time)
          values (${context.businessId},${location.id},${period.weekday},${period.startTime},${period.endTime})
        `;
      }
    });
    return { saved: true };
  });

  app.get("/api/customers", {
    preHandler: [authenticate, requirePermission("customers.view")]
  }, async (request) => {
    const context = auth(request);
    const query = request.query as { q?: string };
    const search = query.q?.trim() ?? "";
    return db`
      select * from customers
      where business_id = ${context.businessId} and archived_at is null
        and (${search} = '' or concat_ws(' ', first_name, last_name) ilike ${`%${search}%`}
          or normalized_phone like ${`%${normalizePhone(search) ?? search}%`}
          or normalized_email ilike ${`%${search.toLowerCase()}%`})
      order by last_name, first_name limit 100
    `;
  });

  app.post("/api/customers", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(customerSchema, request.body);
    const customer = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [created] = await tx<{ id: string }[]>`
        insert into customers
          (business_id, first_name, last_name, phone, normalized_phone, email, normalized_email,
           address, preferred_contact_method, email_allowed, notes, created_by, updated_by)
        values
          (${context.businessId}, ${input.firstName}, ${input.lastName}, ${input.phone ?? null},
           ${normalizePhone(input.phone)}, ${input.email ?? null},
           ${input.email ? normalizeEmail(input.email) : null}, ${input.address ?? null},
           ${input.preferredContactMethod}, ${input.emailAllowed}, ${input.notes ?? null},
           ${context.userId}, ${context.userId})
        returning *
      `;
      if (!created) throw new Error("Customer creation failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "customer.create",
        resourceType: "customer", resourceId: created.id, eventType: "CustomerCreated"
      });
      return created;
    });
    return reply.code(201).send(customer);
  });

  app.put("/api/customers/:id", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(customerSchema, request.body);
    const [updated] = await db`
      update customers set first_name=${input.firstName},last_name=${input.lastName},
        phone=${input.phone ?? null},normalized_phone=${normalizePhone(input.phone)},
        email=${input.email ?? null},normalized_email=${input.email ? normalizeEmail(input.email) : null},
        address=${input.address ?? null},preferred_contact_method=${input.preferredContactMethod},
        email_allowed=${input.emailAllowed},notes=${input.notes ?? null},
        updated_by=${context.userId},updated_at=now()
      where business_id=${context.businessId} and id=${id} and archived_at is null returning *
    `;
    if (!updated) return reply.code(404).send({ error: "Active customer not found" });
    return updated;
  });

  app.get("/api/customers/:id/history", {
    preHandler: [authenticate, requirePermission("customers.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [customer] = await db`select * from customers where business_id=${context.businessId} and id=${id}`;
    if (!customer) return reply.code(404).send({ error: "Customer not found" });
    const [pets, appointments, invoices] = await Promise.all([
      db`select * from pets where business_id=${context.businessId} and customer_id=${id} order by name`,
      db`select a.*, p.name as pet_name, e.display_name as employee_name
         from appointments a join pets p on p.id=a.pet_id join employees e on e.id=a.employee_id
         where a.business_id=${context.businessId} and a.customer_id=${id} order by a.start_at desc`,
      db`select * from invoices where business_id=${context.businessId} and customer_id=${id} order by created_at desc`
    ]);
    return { customer, pets, appointments, invoices };
  });

  app.post("/api/customers/:id/archive", {
    preHandler: [authenticate, requirePermission("customers.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [customer] = await db`
      update customers set archived_at=now(), updated_by=${context.userId}, updated_at=now()
      where business_id=${context.businessId} and id=${id} and archived_at is null returning id
    `;
    if (!customer) return reply.code(404).send({ error: "Active customer not found" });
    return reply.code(204).send();
  });

  app.get("/api/pets", {
    preHandler: [authenticate, requirePermission("pets.view")]
  }, async (request) => {
    const context = auth(request);
    const query = request.query as { q?: string; customerId?: string };
    const rows = await db`
      select p.*, concat_ws(' ', c.first_name, c.last_name) as customer_name
      from pets p join customers c on c.id=p.customer_id
      where p.business_id=${context.businessId} and p.archived_at is null
        and (${query.customerId ?? null}::uuid is null or p.customer_id=${query.customerId ?? null}::uuid)
        and (${query.q ?? ""}='' or p.name ilike ${`%${query.q ?? ""}%`} or p.breed ilike ${`%${query.q ?? ""}%`})
      order by p.name limit 100
    `;
    if (context.isOwner || context.permissions.includes("pets.safety.view")) return rows;
    return rows.map((pet) => ({
      ...pet,
      safetyAlerts: null,
      medicalNotes: null,
      behaviorNotes: null,
      emergencyContact: null,
      veterinarian: null,
      vaccinationNotes: null
    }));
  });

  app.post("/api/pets", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(petSchema, request.body);
    const pet = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [created] = await tx<{ id: string }[]>`
        insert into pets
          (business_id, customer_id, name, species, breed, date_of_birth, approximate_age,
           weight_ounces, sex, coat_notes, grooming_preferences, behavior_notes, medical_notes,
           safety_alerts, emergency_contact, veterinarian, vaccination_notes,
           vaccination_expires_on, photo_permission, created_by, updated_by)
        values
          (${context.businessId}, ${input.customerId}, ${input.name}, ${input.species},
           ${input.breed ?? null}, ${input.dateOfBirth ?? null}, ${input.approximateAge ?? null},
           ${input.weightOunces ?? null}, ${input.sex ?? null}, ${input.coatNotes ?? null},
           ${input.groomingPreferences ?? null}, ${input.behaviorNotes ?? null},
           ${input.medicalNotes ?? null}, ${input.safetyAlerts ?? null},
           ${input.emergencyContact ?? null}, ${input.veterinarian ?? null},
           ${input.vaccinationNotes ?? null}, ${input.vaccinationExpiresOn ?? null},
           ${input.photoPermission ?? null}, ${context.userId}, ${context.userId})
        returning *
      `;
      if (!created) throw new Error("Pet creation failed");
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "pet.create",
        resourceType: "pet", resourceId: created.id,
        after: {
          hasSafetyAlerts: Boolean(input.safetyAlerts),
          hasMedicalNotes: Boolean(input.medicalNotes),
          hasBehaviorNotes: Boolean(input.behaviorNotes)
        },
        eventType: "PetCreated"
      });
      return created;
    });
    return reply.code(201).send(pet);
  });

  app.put("/api/pets/:id", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(petSchema, request.body);
    const updated = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [before] = await tx<{ safetyAlerts: string | null; medicalNotes: string | null; behaviorNotes: string | null }[]>`
        select safety_alerts,medical_notes,behavior_notes from pets
        where business_id=${context.businessId} and id=${id} and archived_at is null for update
      `;
      if (!before) return null;
      const [pet] = await tx`
        update pets set customer_id=${input.customerId},name=${input.name},species=${input.species},
          breed=${input.breed ?? null},date_of_birth=${input.dateOfBirth ?? null},
          approximate_age=${input.approximateAge ?? null},weight_ounces=${input.weightOunces ?? null},
          sex=${input.sex ?? null},coat_notes=${input.coatNotes ?? null},
          grooming_preferences=${input.groomingPreferences ?? null},
          behavior_notes=${input.behaviorNotes ?? null},medical_notes=${input.medicalNotes ?? null},
          safety_alerts=${input.safetyAlerts ?? null},emergency_contact=${input.emergencyContact ?? null},
          veterinarian=${input.veterinarian ?? null},vaccination_notes=${input.vaccinationNotes ?? null},
          vaccination_expires_on=${input.vaccinationExpiresOn ?? null},
          photo_permission=${input.photoPermission ?? null},updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id} returning *
      `;
      const changedFields = [
        before.safetyAlerts !== (input.safetyAlerts ?? null) ? "safety_alerts" : null,
        before.medicalNotes !== (input.medicalNotes ?? null) ? "medical_notes" : null,
        before.behaviorNotes !== (input.behaviorNotes ?? null) ? "behavior_notes" : null
      ].filter(Boolean);
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "pet.safety.update",
        resourceType: "pet", resourceId: id,
        after: { changedFields }
      });
      return pet;
    });
    if (!updated) return reply.code(404).send({ error: "Active pet not found" });
    return updated;
  });

  app.post("/api/pets/:id/archive", {
    preHandler: [authenticate, requirePermission("pets.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [pet] = await db`
      update pets set archived_at=now(),updated_by=${context.userId},updated_at=now()
      where business_id=${context.businessId} and id=${id} and archived_at is null returning id
    `;
    if (!pet) return reply.code(404).send({ error: "Active pet not found" });
    return reply.code(204).send();
  });

  app.get("/api/appointments", {
    preHandler: [authenticate, requirePermission("appointments.view")]
  }, async (request) => {
    const context = auth(request);
    const query = request.query as { from?: string; to?: string };
    const from = query.from ?? new Date(Date.now() - 86_400_000).toISOString();
    const to = query.to ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
    const rows = await db`
      select a.*, c.first_name, c.last_name, p.name as pet_name, p.safety_alerts,
        p.behavior_notes, p.medical_notes, p.grooming_preferences, p.coat_notes,
        e.display_name as employee_name,
        coalesce(json_agg(json_build_object(
          'id', aps.id, 'name', aps.service_name_snapshot, 'durationMinutes',
          aps.duration_minutes_snapshot, 'priceMinor', aps.price_minor_snapshot,
          'serviceId', aps.service_id
        )) filter (where aps.id is not null), '[]') as services
      from appointments a
      join customers c on c.id=a.customer_id
      join pets p on p.id=a.pet_id
      join employees e on e.id=a.employee_id
      left join appointment_services aps on aps.appointment_id=a.id
      where a.business_id=${context.businessId} and a.start_at >= ${from} and a.start_at < ${to}
      group by a.id,c.id,p.id,e.id order by a.start_at
    `;
    if (context.isOwner || context.permissions.includes("pets.safety.view")) return rows;
    return rows.map((appointment) => ({
      ...appointment,
      safetyAlerts: null,
      behaviorNotes: null,
      medicalNotes: null,
      groomingPreferences: null,
      coatNotes: null
    }));
  });

  app.post("/api/appointments", {
    preHandler: [authenticate, requirePermission("appointments.create")]
  }, async (request, reply) => {
    const context = auth(request);
    const input = body(appointmentSchema, request.body);
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [participants] = await tx<{ available: boolean }[]>`
        select exists (
          select 1 from customers customer
          join pets pet on pet.customer_id=customer.id and pet.business_id=customer.business_id
          where customer.business_id=${context.businessId} and customer.id=${input.customerId}
            and pet.id=${input.petId} and customer.archived_at is null and pet.archived_at is null
        ) as available
      `;
      if (!participants?.available) throw new Error("The selected customer or pet is unavailable");
      const catalog = await tx<{ id: string; name: string; baseDurationMinutes: number; basePriceMinor: number }[]>`
        select service.id,service.name,service.base_duration_minutes,service.base_price_minor
        from services service
        join employee_services eligibility on eligibility.service_id=service.id
          and eligibility.employee_id=${input.employeeId}
        join employees employee on employee.id=eligibility.employee_id and employee.active
        where service.business_id=${context.businessId} and service.id in ${tx(input.serviceIds)}
          and service.active
      `;
      if (catalog.length !== new Set(input.serviceIds).size) throw new Error("One or more services are unavailable");
      const totalMinutes = catalog.reduce((sum, service) => sum + service.baseDurationMinutes, 0);
      const startAt = new Date(input.startAt);
      const endAt = new Date(startAt.getTime() + totalMinutes * 60_000);
      const [availability] = await tx<{ withinHours: boolean; blocked: boolean }[]>`
        select
          (
            (
              not exists (select 1 from employee_working_hours where employee_id=${input.employeeId})
              or exists (
                select 1 from employee_working_hours wh
                join locations l on l.business_id=wh.business_id
                where wh.business_id=${context.businessId} and wh.employee_id=${input.employeeId}
                  and l.id=${input.locationId}
                  and wh.weekday=extract(dow from (${startAt}::timestamptz at time zone l.timezone))
                  and (${startAt}::timestamptz at time zone l.timezone)::time >= wh.start_time
                  and (${endAt}::timestamptz at time zone l.timezone)::time <= wh.end_time
              )
            )
            and (
              not exists (select 1 from business_hours where location_id=${input.locationId})
              or exists (
                select 1 from business_hours bh
                join locations l on l.id=bh.location_id
                where bh.business_id=${context.businessId} and bh.location_id=${input.locationId}
                  and bh.weekday=extract(dow from (${startAt}::timestamptz at time zone l.timezone))
                  and (${startAt}::timestamptz at time zone l.timezone)::time >= bh.start_time
                  and (${endAt}::timestamptz at time zone l.timezone)::time <= bh.end_time
              )
            )
          ) as within_hours,
          exists (
            select 1 from blocked_times bt
            where bt.business_id=${context.businessId} and bt.employee_id=${input.employeeId}
              and tstzrange(bt.start_at,bt.end_at,'[)') && tstzrange(${startAt},${endAt},'[)')
          ) as blocked
      `;
      if ((!availability?.withinHours || availability.blocked) && !input.availabilityOverride) {
        throw new Error("Requested time is outside employee availability; an explicit override is required");
      }
      if (input.availabilityOverride && !context.isOwner && !context.permissions.includes("appointments.edit")) {
        throw new Error("Availability override is not authorized");
      }
      const [appointment] = await tx<{ id: string }[]>`
        insert into appointments
          (business_id, location_id, customer_id, pet_id, employee_id, start_at, end_at,
           notes, availability_overridden, created_by, updated_by)
        values
          (${context.businessId}, ${input.locationId}, ${input.customerId}, ${input.petId},
           ${input.employeeId}, ${startAt}, ${endAt}, ${input.notes ?? null},
           ${input.availabilityOverride}, ${context.userId}, ${context.userId})
        returning *
      `;
      if (!appointment) throw new Error("Appointment creation failed");
      for (const service of catalog) {
        await tx`
          insert into appointment_services
            (business_id, appointment_id, service_id, service_name_snapshot,
             duration_minutes_snapshot, price_minor_snapshot)
          values
            (${context.businessId}, ${appointment.id}, ${service.id}, ${service.name},
             ${service.baseDurationMinutes}, ${service.basePriceMinor})
        `;
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "appointment.create",
        resourceType: "appointment", resourceId: appointment.id,
        after: { startAt, endAt, employeeId: input.employeeId },
        reason: input.overrideReason, eventType: "AppointmentCreated"
      });
      return appointment;
    });
    return reply.code(201).send(result);
  });

  app.post("/api/appointments/:id/transition", {
    preHandler: authenticate
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(transitionSchema, request.body);
    const required = input.status === "checked_in" ? "operations.check_in"
      : input.status === "in_service" ? "operations.perform_service"
      : input.status === "completed" ? "operations.complete"
      : "appointments.cancel";
    if (!context.isOwner && !context.permissions.includes(required)) {
      return reply.code(403).send({ error: `Missing permission: ${required}` });
    }
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [current] = await tx<{ status: AppointmentStatus; version: number }[]>`
        select status,version from appointments where business_id=${context.businessId} and id=${id} for update
      `;
      if (!current) return null;
      if (input.version && current.version !== input.version) {
        return { stale: true } as const;
      }
      if (!canTransition(current.status, input.status)) {
        throw new Error(`Invalid appointment transition: ${current.status} -> ${input.status}`);
      }
      const [updated] = await tx`
        update appointments set status=${input.status}, version=version+1,
          updated_by=${context.userId}, updated_at=now()
        where business_id=${context.businessId} and id=${id} returning *
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId,
        action: `appointment.${input.status}`, resourceType: "appointment", resourceId: id,
        before: { status: current.status }, after: { status: input.status }, reason: input.reason,
        eventType: input.status === "checked_in" ? "AppointmentCheckedIn"
          : input.status === "in_service" ? "AppointmentStarted"
          : input.status === "completed" ? "AppointmentCompleted"
          : input.status === "cancelled" ? "AppointmentCancelled" : undefined
      });
      return updated;
    });
    if (!result) return reply.code(404).send({ error: "Appointment not found" });
    if ("stale" in result) return reply.code(409).send({ error: "Appointment changed; refresh before continuing" });
    return result;
  });

  app.patch("/api/appointments/:id/schedule", {
    preHandler: [authenticate, requirePermission("appointments.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(appointmentMoveSchema, request.body);
    const moved = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [current] = await tx<{ startAt: Date; endAt: Date; status: string; locationId: string }[]>`
        select start_at,end_at,status,location_id from appointments
        where business_id=${context.businessId} and id=${id} and version=${input.version} for update
      `;
      if (!current) return null;
      if (current.status !== "scheduled") throw new Error("Only scheduled appointments can be moved");
      const [assignment] = await tx<{ eligible: boolean }[]>`
        select
          exists (
            select 1 from employees
            where business_id=${context.businessId} and id=${input.employeeId} and active
          )
          and not exists (
            select 1 from appointment_services booked
            where booked.business_id=${context.businessId} and booked.appointment_id=${id}
              and not exists (
                select 1 from employee_services eligible
                where eligible.employee_id=${input.employeeId}
                  and eligible.service_id=booked.service_id
              )
          ) as eligible
      `;
      if (!assignment?.eligible) throw new Error("The selected employee is not eligible for every booked service");
      const startAt = new Date(input.startAt);
      const endAt = new Date(startAt.getTime() + (current.endAt.getTime() - current.startAt.getTime()));
      const [availability] = await tx<{ withinHours: boolean; blocked: boolean }[]>`
        select
          (
            (
              not exists (select 1 from employee_working_hours where employee_id=${input.employeeId})
              or exists (
                select 1 from employee_working_hours wh join locations l on l.business_id=wh.business_id
                where wh.business_id=${context.businessId} and wh.employee_id=${input.employeeId}
                  and l.id=${current.locationId}
                  and wh.weekday=extract(dow from (${startAt}::timestamptz at time zone l.timezone))
                  and (${startAt}::timestamptz at time zone l.timezone)::time>=wh.start_time
                  and (${endAt}::timestamptz at time zone l.timezone)::time<=wh.end_time
              )
            )
            and (
              not exists (select 1 from business_hours where location_id=${current.locationId})
              or exists (
                select 1 from business_hours bh join locations l on l.id=bh.location_id
                where bh.business_id=${context.businessId} and bh.location_id=${current.locationId}
                  and bh.weekday=extract(dow from (${startAt}::timestamptz at time zone l.timezone))
                  and (${startAt}::timestamptz at time zone l.timezone)::time>=bh.start_time
                  and (${endAt}::timestamptz at time zone l.timezone)::time<=bh.end_time
              )
            )
          ) as within_hours,
          exists (
            select 1 from blocked_times bt where bt.business_id=${context.businessId}
              and bt.employee_id=${input.employeeId}
              and tstzrange(bt.start_at,bt.end_at,'[)') && tstzrange(${startAt},${endAt},'[)')
          ) as blocked
      `;
      if ((!availability?.withinHours || availability.blocked) && !input.availabilityOverride) {
        throw new Error("Requested time is outside employee availability; an explicit override is required");
      }
      const [updated] = await tx`
        update appointments set employee_id=${input.employeeId},start_at=${startAt},end_at=${endAt},
          availability_overridden=${input.availabilityOverride},version=version+1,
          updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id} and version=${input.version}
        returning *
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "appointment.move",
        resourceType: "appointment", resourceId: id,
        before: { startAt: current.startAt, endAt: current.endAt },
        after: { startAt, endAt, employeeId: input.employeeId },
        reason: input.overrideReason, eventType: "AppointmentUpdated"
      });
      return updated;
    });
    if (!moved) return reply.code(409).send({ error: "Appointment changed or no longer exists" });
    return moved;
  });

  app.patch("/api/appointments/:id/operations", {
    preHandler: [authenticate, requirePermission("operations.perform_service")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(operationalUpdateSchema, request.body);
    const [updated] = input.version
      ? await db`
          update appointments set operational_notes=${input.operationalNotes ?? null},
            version=version+1, updated_by=${context.userId}, updated_at=now()
          where business_id=${context.businessId} and id=${id} and version=${input.version}
            and status in ('checked_in','in_service') returning *
        `
      : await db`
          update appointments set operational_notes=${input.operationalNotes ?? null},
            version=version+1, updated_by=${context.userId}, updated_at=now()
          where business_id=${context.businessId} and id=${id}
            and status in ('checked_in','in_service') returning *
        `;
    if (!updated) return reply.code(404).send({ error: "Active service appointment not found" });
    return updated;
  });

  app.put("/api/appointments/:id/services", {
    preHandler: [authenticate, requirePermission("appointments.edit")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(appointmentServicesSchema, request.body);
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [appointment] = await tx<{ startAt: Date; status: string; employeeId: string; version: number }[]>`
        select start_at,status,employee_id,version from appointments
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!appointment) return null;
      if (input.version && appointment.version !== input.version) {
        return { stale: true } as const;
      }
      if (!["scheduled","checked_in","in_service"].includes(appointment.status)) {
        throw new Error("Services cannot be changed in the current appointment state");
      }
      const invoice = await tx`
        select id from invoices where business_id=${context.businessId} and appointment_id=${id} and status<>'void'
      `;
      if (invoice.length) throw new Error("Services cannot change after checkout begins");
      const catalog = await tx<{ id: string; name: string; baseDurationMinutes: number; basePriceMinor: number }[]>`
        select service.id,service.name,service.base_duration_minutes,service.base_price_minor
        from services service
        join employee_services eligibility on eligibility.service_id=service.id
          and eligibility.employee_id=${appointment.employeeId}
        where service.business_id=${context.businessId} and service.id in ${tx(input.serviceIds)}
          and service.active
      `;
      if (catalog.length !== new Set(input.serviceIds).size) throw new Error("One or more services are unavailable");
      await tx`delete from appointment_services where business_id=${context.businessId} and appointment_id=${id}`;
      for (const service of catalog) {
        await tx`
          insert into appointment_services
            (business_id,appointment_id,service_id,service_name_snapshot,duration_minutes_snapshot,price_minor_snapshot)
          values (${context.businessId},${id},${service.id},${service.name},
            ${service.baseDurationMinutes},${service.basePriceMinor})
        `;
      }
      const minutes = catalog.reduce((sum, service) => sum + service.baseDurationMinutes, 0);
      const endAt = new Date(appointment.startAt.getTime() + minutes * 60_000);
      await tx`
        update appointments set end_at=${endAt},version=version+1,updated_by=${context.userId},updated_at=now()
        where business_id=${context.businessId} and id=${id}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "appointment.services.update",
        resourceType: "appointment", resourceId: id,
        after: { serviceIds: input.serviceIds, endAt }, eventType: "AppointmentUpdated"
      });
      return { id, endAt };
    });
    if (!result) return reply.code(404).send({ error: "Appointment not found" });
    if ("stale" in result) return reply.code(409).send({ error: "Appointment changed; refresh before continuing" });
    return result;
  });

  app.post("/api/appointments/:id/checkout", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(checkoutSchema, request.body);
    if (input.discountMinor > 0 && !context.isOwner && !context.permissions.includes("discounts.apply")) {
      return reply.code(403).send({ error: "Missing permission: discounts.apply" });
    }
    const invoice = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [appointment] = await tx<{ customerId: string; status: string; taxRateBasisPoints: number }[]>`
        select a.customer_id, a.status, b.tax_rate_basis_points
        from appointments a join businesses b on b.id=a.business_id
        where a.business_id=${context.businessId} and a.id=${id} for update
      `;
      if (!appointment) return null;
      if (appointment.status !== "completed") throw new Error("Only completed appointments can be checked out");
      const [existing] = await tx`
        select * from invoices
        where business_id=${context.businessId} and appointment_id=${id} and status<>'void'
      `;
      if (existing) return existing;
      const services = await tx<{ id: string; serviceNameSnapshot: string; priceMinorSnapshot: number }[]>`
        select id, service_name_snapshot, price_minor_snapshot from appointment_services
        where business_id=${context.businessId} and appointment_id=${id}
      `;
      const totals = calculateInvoice({
        lineAmounts: services.map((service) => service.priceMinorSnapshot),
        discount: input.discountMinor, taxRateBasisPoints: appointment.taxRateBasisPoints,
        tip: input.tipMinor
      });
      const [created] = await tx<{ id: string }[]>`
        insert into invoices
          (business_id, appointment_id, customer_id, status, subtotal_minor, discount_minor,
           tax_minor, tip_minor, total_minor, balance_minor, discount_type, discount_actor)
        values
          (${context.businessId}, ${id}, ${appointment.customerId}, 'open',
           ${totals.subtotal}, ${totals.discount}, ${totals.tax}, ${totals.tip},
           ${totals.total}, ${totals.total}, ${input.discountType ?? null},
           ${input.discountMinor > 0 ? context.userId : null})
        returning *
      `;
      if (!created) throw new Error("Invoice creation failed");
      for (const service of services) {
        await tx`
          insert into invoice_items
            (business_id, invoice_id, description, quantity, unit_price_minor, amount_minor,
             source_appointment_service_id)
          values
            (${context.businessId}, ${created.id}, ${service.serviceNameSnapshot}, 1,
             ${service.priceMinorSnapshot}, ${service.priceMinorSnapshot}, ${service.id})
        `;
      }
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "invoice.create",
        resourceType: "invoice", resourceId: created.id, after: totals, eventType: "InvoiceCreated"
      });
      return created;
    });
    if (!invoice) return reply.code(404).send({ error: "Appointment not found" });
    return reply.code(201).send(invoice);
  });

  app.post("/api/invoices/:id/payments", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(paymentSchema, request.body);
    const payment = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [invoice] = await tx<{ balanceMinor: number; status: string }[]>`
        select balance_minor, status from invoices
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!invoice) return null;
      if (!["open", "partially_paid"].includes(invoice.status)) throw new Error("Invoice cannot accept payment");
      if (input.amountMinor > invoice.balanceMinor) throw new Error("Payment exceeds invoice balance");
      const [created] = await tx<{ id: string }[]>`
        insert into payments
          (business_id, invoice_id, amount_minor, method, external_reference, recorded_by)
        values
          (${context.businessId}, ${id}, ${input.amountMinor}, ${input.method},
           ${input.externalReference ?? null}, ${context.userId})
        returning *
      `;
      const balance = invoice.balanceMinor - input.amountMinor;
      await tx`
        update invoices set balance_minor=${balance},
          status=${balance === 0 ? "paid" : "partially_paid"}, updated_at=now()
        where id=${id} and business_id=${context.businessId}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "payment.record",
        resourceType: "payment", resourceId: created?.id,
        after: { invoiceId: id, amountMinor: input.amountMinor, method: input.method },
        eventType: "PaymentRecorded"
      });
      return created;
    });
    if (!payment) return reply.code(404).send({ error: "Invoice not found" });
    return reply.code(201).send(payment);
  });

  app.post("/api/payments/:id/void", {
    preHandler: [authenticate, requirePermission("checkout.perform")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body(voidPaymentSchema, request.body);
    const result = await db.begin(async (tx) => {
      await setTenant(tx, context.businessId);
      const [payment] = await tx<{ invoiceId: string; amountMinor: number; status: string }[]>`
        select invoice_id, amount_minor, status from payments
        where business_id=${context.businessId} and id=${id} for update
      `;
      if (!payment) return null;
      if (payment.status !== "recorded") throw new Error("Payment is already voided");
      await tx`
        update payments set status='voided',voided_by=${context.userId},voided_at=now(),
          void_reason=${input.reason} where business_id=${context.businessId} and id=${id}
      `;
      const [invoice] = await tx<{ totalMinor: number }[]>`
        select total_minor from invoices where business_id=${context.businessId}
          and id=${payment.invoiceId} for update
      `;
      const [sum] = await tx<{ paid: number }[]>`
        select coalesce(sum(amount_minor),0)::integer as paid from payments
        where business_id=${context.businessId} and invoice_id=${payment.invoiceId} and status='recorded'
      `;
      const balance = (invoice?.totalMinor ?? 0) - (sum?.paid ?? 0);
      await tx`
        update invoices set balance_minor=${balance},
          status=${balance === (invoice?.totalMinor ?? 0) ? "open" : balance === 0 ? "paid" : "partially_paid"},
          updated_at=now()
        where business_id=${context.businessId} and id=${payment.invoiceId}
      `;
      await record(tx, {
        businessId: context.businessId, actorId: context.userId, action: "payment.void",
        resourceType: "payment", resourceId: id, reason: input.reason,
        before: { status: "recorded" }, after: { status: "voided" }
      });
      return { id, balance };
    });
    if (!result) return reply.code(404).send({ error: "Payment not found" });
    return result;
  });

  app.get("/api/invoices/:id/receipt", {
    preHandler: [authenticate, requirePermission("payments.view")]
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [invoice] = await db`
      select i.*, b.name as business_name, b.currency, c.first_name, c.last_name
      from invoices i join businesses b on b.id=i.business_id join customers c on c.id=i.customer_id
      where i.business_id=${context.businessId} and i.id=${id}
    `;
    if (!invoice) return reply.code(404).send({ error: "Invoice not found" });
    const [items, payments] = await Promise.all([
      db`select * from invoice_items where business_id=${context.businessId} and invoice_id=${id}`,
      db`select * from payments where business_id=${context.businessId} and invoice_id=${id}`
    ]);
    return { invoice, items, payments };
  });

  app.get("/api/dashboard", {
    preHandler: [authenticate, requirePermission("reports.view")]
  }, async (request) => {
    const context = auth(request);
    const [metrics] = await db`
      select
        count(*) filter (
          where (a.start_at at time zone l.timezone)::date=(now() at time zone l.timezone)::date
        ) as todays_appointments,
        count(*) filter (where a.start_at>=now() and a.status='scheduled') as upcoming_appointments,
        count(*) filter (
          where (a.start_at at time zone l.timezone)::date=(now() at time zone l.timezone)::date
            and a.status='completed'
        ) as completed_today
      from appointments a join locations l on l.id=a.location_id
      where a.business_id=${context.businessId}
    `;
    const [finance] = await db`
      select
        coalesce(sum(i.total_minor-i.balance_minor) filter (
          where (i.created_at at time zone l.timezone)::date=(now() at time zone l.timezone)::date
        ),0) as todays_sales_minor,
        coalesce(sum(i.balance_minor) filter (where i.status in ('open','partially_paid')),0) as outstanding_minor
      from invoices i
      join appointments a on a.id=i.appointment_id
      join locations l on l.id=a.location_id
      where i.business_id=${context.businessId}
    `;
    return { ...metrics, ...finance };
  });

  app.get("/api/reports", {
    preHandler: [authenticate, requirePermission("reports.view")]
  }, async (request) => {
    const context = auth(request);
    const query = request.query as { from?: string; to?: string };
    const from = query.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const to = query.to ?? new Date(Date.now() + 86_400_000).toISOString();
    const [revenue, employees, servicesPerformed] = await Promise.all([
      db`
        select created_at::date as date,sum(total_minor-balance_minor)::bigint as revenue_minor
        from invoices where business_id=${context.businessId} and created_at>=${from} and created_at<${to}
        group by created_at::date order by date
      `,
      db`
        select e.id,e.display_name,count(a.id)::integer as appointment_count
        from employees e left join appointments a on a.employee_id=e.id
          and a.start_at>=${from} and a.start_at<${to} and a.status='completed'
        where e.business_id=${context.businessId}
        group by e.id order by appointment_count desc
      `,
      db`
        select aps.service_name_snapshot as service,count(*)::integer as performed
        from appointment_services aps join appointments a on a.id=aps.appointment_id
        where aps.business_id=${context.businessId} and a.status='completed'
          and a.start_at>=${from} and a.start_at<${to}
        group by aps.service_name_snapshot order by performed desc
      `
    ]);
    return { from, to, revenue, employees, services: servicesPerformed };
  });

  app.get("/api/audit", {
    preHandler: [authenticate, requirePermission("settings.manage")]
  }, async (request) => {
    const context = auth(request);
    return db`
      select id, actor_id, action, resource_type, resource_id, reason, created_at
      from audit_events where business_id=${context.businessId}
      order by created_at desc limit 100
    `;
  });

  app.get("/api/admin/businesses/:id", {
    preHandler: authenticatePlatform
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [business] = await db`
      select id,name,status,created_at,updated_at from businesses where id=${id}
    `;
    if (!business) return reply.code(404).send({ error: "Business not found" });
    await db`
      insert into audit_events
        (business_id,actor_id,action,resource_type,resource_id,correlation_id,reason)
      values (${id},${context.userId},'platform.metadata.view','business',${id},${randomUUID()},
        'Exact-id internal support lookup')
    `;
    return business;
  });

  app.get("/api/admin/users/:id", {
    preHandler: authenticatePlatform
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const [user] = await db`
      select id,email,email_verified_at,disabled_at,created_at,updated_at
      from users where id=${id}
    `;
    if (!user) return reply.code(404).send({ error: "User not found" });
    await db`
      insert into audit_events(actor_id,action,resource_type,resource_id,correlation_id,reason)
      values (${context.userId},'platform.user_metadata.view','user',${id},${randomUUID()},
        'Exact-id internal support lookup')
    `;
    return user;
  });

  app.post("/api/admin/users/:id/disable", {
    preHandler: authenticatePlatform
  }, async (request, reply) => {
    const context = auth(request);
    const { id } = idParams.parse(request.params);
    const input = body((await import("zod")).z.object({
      reason: (await import("zod")).z.string().trim().min(5).max(500)
    }), request.body);
    const disabled = await db.begin(async (tx) => {
      const [user] = await tx<{ id: string }[]>`
        update users set disabled_at=now(),updated_at=now()
        where id=${id} and disabled_at is null returning id
      `;
      if (!user) return false;
      await tx`update sessions set revoked_at=now() where user_id=${id} and revoked_at is null`;
      await tx`
        insert into audit_events(actor_id,action,resource_type,resource_id,correlation_id,reason)
        values (${context.userId},'platform.user.disable','user',${id},${randomUUID()},${input.reason})
      `;
      return true;
    });
    if (!disabled) return reply.code(404).send({ error: "Active user not found" });
    return { disabled: true };
  });
}
