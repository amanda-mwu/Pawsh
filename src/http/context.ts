import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { can, type Permission } from "@pawsh/domain";

export interface AuthContext {
  userId: string;
  businessId: string;
  membershipId: string;
  isOwner: boolean;
  permissions: string[];
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
      locationId: string | null;
    }[]>`
      select s.user_id, m.business_id, m.id as membership_id, m.is_owner, m.permissions,
        active_location.id as location_id
      from sessions s
      join users u on u.id = s.user_id
      join business_memberships m on m.user_id = u.id
      join businesses b on b.id = m.business_id
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
    request.auth = row;
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
      isOwner: false, permissions: [], locationId: null
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
