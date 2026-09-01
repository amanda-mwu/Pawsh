import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { effectivePermissions } from "../db/effective-permissions.js";
import { can, type Permission } from "@pawsh/domain";

/** The role a membership is assigned, as the clients need to name it. Null for owners. */
export interface AuthRole {
  id: string;
  name: string;
  enabled: boolean;
}

export interface AuthContext {
  userId: string;
  businessId: string;
  membershipId: string;
  isOwner: boolean;
  /**
   * The permissions this membership EFFECTIVELY holds, already resolved through its role by
   * `effectivePermissions`. A disabled role resolves to the empty set here, so every downstream
   * `context.permissions.includes(...)` check inherits the kill switch without knowing about it.
   */
  permissions: string[];
  /**
   * The assigned role, or null for an owner (and for a membership not yet migrated onto one).
   * `enabled` is reported as it is stored: a client showing "Groomer (disabled)" is telling the
   * truth, and `permissions` above is already empty in that case.
   */
  role: AuthRole | null;
  /** Active location for this session; null only when the business has no active location. */
  locationId: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function issueToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The session token for this request, from either transport.
 *
 * Browsers send the httpOnly cookie; native clients hold the token themselves and send it as a
 * bearer credential. The header wins so a native client is never silently authenticated as
 * whatever cookie happened to ride along. Every read of the session token must go through here:
 * a handler that reaches for the cookie directly would address the wrong session, or no session
 * at all, for a bearer caller.
 */
export function sessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || undefined;
  return request.cookies.pawsh_session;
}

/**
 * Resolves the session, the membership behind it, and what that membership may do.
 *
 * PERMISSIONS ARE RE-RESOLVED ON EVERY REQUEST, and that is the property the whole roles feature
 * rests on. Nothing about a membership's authority is cached in the session row or in the token,
 * so editing a role, disabling a role, or reassigning a member takes effect on THE VERY NEXT
 * REQUEST that session makes - no session invalidation, no forced re-login, no revocation sweep.
 * An owner who disables a role during an incident has closed it, not scheduled it to close.
 *
 * The corollary is that this query is on the hot path for every authenticated request, so it stays
 * a single round trip: the role is resolved by the same statement, not by a follow-up query.
 */
export function authentication(db: Database) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = sessionToken(request);
    if (!token) return reply.code(401).send({ error: "Authentication required" });
    const requestedBusiness = request.headers["x-business-id"];
    const rows = await db<{
      userId: string;
      businessId: string;
      membershipId: string;
      isOwner: boolean;
      permissions: string[];
      roleId: string | null;
      roleName: string | null;
      roleEnabled: boolean | null;
      locationId: string | null;
    }[]>`
      select s.user_id, m.business_id, m.id as membership_id, m.is_owner,
        ${effectivePermissions(db, "m")} as permissions,
        assigned_role.id as role_id, assigned_role.name as role_name,
        assigned_role.enabled as role_enabled,
        active_location.id as location_id
      from sessions s
      join users u on u.id = s.user_id
      join business_memberships m on m.user_id = u.id
      join businesses b on b.id = m.business_id
      -- Tenant-qualified on both columns, matching the composite foreign key that stores the
      -- reference. Joining on the role id alone would be a join that reads correctly and, the
      -- day a cross-tenant row existed, resolved another business's role.
      left join roles assigned_role
        on assigned_role.business_id = m.business_id and assigned_role.id = m.role_id
      -- The chosen location wins while it is still active and still owned by the
      -- resolved business; otherwise the (name,id) ordering makes the fallback
      -- deterministic rather than whatever the planner returns first.
      left join lateral (
        select l.id from locations l
        where l.business_id = m.business_id and l.active
        order by (l.id is not distinct from s.location_id) desc, l.name, l.id
        limit 1
      ) active_location on true
      where s.token_hash = ${tokenHash(token)}
        and s.revoked_at is null and s.expires_at > now()
        and u.disabled_at is null and m.status = 'active' and b.status = 'active'
        and (s.business_id is null or m.business_id=s.business_id)
        and (${typeof requestedBusiness === "string" ? requestedBusiness : null}::uuid is null
          or m.business_id = ${typeof requestedBusiness === "string" ? requestedBusiness : null}::uuid)
      order by m.created_at
      limit 1
    `;
    const row = rows[0];
    if (!row) return reply.code(401).send({ error: "Session is invalid or business access is unavailable" });
    const { roleId, roleName, roleEnabled, ...context } = row;
    request.auth = {
      ...context,
      role: roleId ? { id: roleId, name: roleName ?? "", enabled: roleEnabled ?? false } : null
    };
  };
}

export function platformAuthentication(db: Database) {
  return async function authenticatePlatform(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = sessionToken(request);
    if (!token) return reply.code(401).send({ error: "Authentication required" });
    const [row] = await db<{ userId: string }[]>`
      select s.user_id from sessions s
      join users u on u.id=s.user_id
      join platform_administrators p on p.user_id=u.id and p.active
      where s.token_hash=${tokenHash(token)} and s.revoked_at is null
        and s.expires_at>now() and u.disabled_at is null
    `;
    if (!row) return reply.code(403).send({ error: "Platform administrator access required" });
    request.auth = {
      userId: row.userId, businessId: "", membershipId: "",
      isOwner: false, permissions: [], role: null, locationId: null
    };
  };
}

export function requirePermission(permission: Permission) {
  return async function authorize(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.auth) return reply.code(401).send({ error: "Authentication required" });
    if (!can(request.auth, permission)) {
      return reply.code(403).send({ error: `Missing permission: ${permission}` });
    }
  };
}

export function auth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new Error("Route used without authentication");
  return request.auth;
}
