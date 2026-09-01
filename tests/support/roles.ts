import { createHash } from "node:crypto";
import type { createApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";

type App = Awaited<ReturnType<typeof createApp>>;

/**
 * Creates a role holding exactly `permissions`, and returns its id.
 *
 * A member's access is their role and nothing else, so a test that wants somebody to hold
 * `["calendar.view"]` has to say which role grants that. This exists so the eight suites that used
 * to pass a permission array straight to the invitation endpoint keep expressing the same
 * intention in one line, rather than each growing its own two-step create-then-grant dance.
 *
 * The role name carries the caller's suffix because `roles` is uniquely indexed on
 * (business_id, lower(name)); suites that create several roles in one business must pass distinct
 * names or the second create is a 409.
 */
export async function createRole(
  app: App,
  cookie: string,
  name: string,
  permissions: readonly string[] = []
): Promise<string> {
  const created = await app.inject({
    method: "POST", url: "/api/roles", headers: { cookie }, payload: { name }
  });
  if (created.statusCode !== 201) {
    throw new Error(`role create failed (${created.statusCode}): ${created.body}`);
  }
  const role = created.json();
  if (permissions.length === 0) return role.id;
  const granted = await app.inject({
    method: "PATCH", url: `/api/roles/${role.id}`, headers: { cookie },
    payload: { version: role.version, permissions: [...permissions] }
  });
  if (granted.statusCode !== 200) {
    throw new Error(`role grant failed (${granted.statusCode}): ${granted.body}`);
  }
  return role.id;
}

/**
 * Finds or creates a role holding exactly `permissions`, in raw SQL, and returns its id.
 *
 * For the many suites that seed a membership directly rather than going through the invitation
 * endpoint. Since 0042 a non-owner membership MUST carry a role -
 * `membership_role_matches_ownership` makes "non-owner with no role" unrepresentable, because that
 * state resolves to the empty set and is a person silently locked out - so a raw seed must name one.
 *
 * The role is looked up by its permission SET and its name is derived from that set, so calling
 * this twice with the same permissions in a different order returns the SAME role rather than
 * colliding on the unique (business_id, lower(name)) index. That is what lets it be dropped into a
 * `beforeAll` which runs repeatedly against a database these suites never clean up.
 */
export async function roleFor(
  db: Database,
  businessId: string,
  permissions: readonly string[]
): Promise<string> {
  const canonical = [...new Set(permissions)].sort();
  // A short, stable digest of the set, so the name is deterministic and readable in a failure.
  const digest = createHash("sha256").update(canonical.join(" ")).digest("hex").slice(0, 10);
  const name = `Seeded access ${digest}`;
  const [existing] = await db<{ id: string }[]>`
    select id from roles where business_id = ${businessId} and name = ${name}
  `;
  if (existing) return existing.id;
  const [created] = await db<{ id: string }[]>`
    insert into roles (business_id, name, permissions)
    values (${businessId}, ${name}, ${canonical as string[]})
    returning id
  `;
  return created!.id;
}
