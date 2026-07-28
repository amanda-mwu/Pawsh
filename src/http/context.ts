import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { can, type Permission } from "../domain/permissions.js";

export interface AuthContext {
  userId: string;
  businessId: string;
  membershipId: string;
  isOwner: boolean;
  permissions: string[];
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

export function authentication(db: Database) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies.pawsh_session;
    if (!token) return reply.code(401).send({ error: "Authentication required" });
    const requestedBusiness = request.headers["x-business-id"];
    const rows = await db<{
      userId: string;
      businessId: string;
      membershipId: string;
      isOwner: boolean;
      permissions: string[];
    }[]>`
      select s.user_id, m.business_id, m.id as membership_id, m.is_owner, m.permissions
      from sessions s
      join users u on u.id = s.user_id
      join business_memberships m on m.user_id = u.id
      join businesses b on b.id = m.business_id
      where s.token_hash = ${tokenHash(token)}
        and s.revoked_at is null and s.expires_at > now()
        and u.disabled_at is null and m.status = 'active' and b.status = 'active'
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
    const token = request.cookies.pawsh_session;
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
      isOwner: false, permissions: []
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
