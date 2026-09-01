import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  permissionGroups, permissionLabels, permissionPresets, permissions, unenforcedPermissions
} from "@pawsh/domain";

/**
 * Every permission string written down anywhere in the repository must be one the domain tuple
 * actually defines.
 *
 * The tuple is the only place a permission exists. `z.enum(permissions)` rejects an unknown string
 * at every write boundary, and `can()` will never match one, so a seed or fixture that grants
 * `reports.veiw` does not fail loudly - IT GRANTS NOTHING, quietly, and the QA workspace or test
 * tenant it built goes on looking plausible while one person silently cannot do their job. That is
 * exactly the failure this file exists to make impossible, and it is not hypothetical: 0004 had to
 * migrate `pets.safety.view` to `pets.care.view`, and a fixture left on the old spelling would
 * still parse, still read like a permission, and still grant nothing.
 *
 * A string counts as a permission if it begins with one of the namespaces the tuple itself uses -
 * derived from the tuple rather than listed here, so adding a namespace extends the check for free
 * instead of leaving a blind spot nobody remembers to close.
 */

const permissionSet = new Set<string>(permissions);
const namespaces = new Set([...permissions].map((permission) => permission.split(".", 1)[0]));
const candidate = /["'`]([a-z][a-z_]*(?:\.[a-z][a-z_]*)+)["'`]/g;

/** Files that grant permissions to a seeded workspace or a test tenant. */
const seedsAndFixtures = [
  "scripts/seed-qa.ts",
  "tests/e2e/fixtures/tenant.ts",
  "apps/mobile/__tests__/support/fixtures.ts"
];

async function permissionStringsIn(file: string): Promise<string[]> {
  const source = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
  const found = new Set<string>();
  for (const match of source.matchAll(candidate)) {
    const value = match[1]!;
    if (namespaces.has(value.split(".", 1)[0]!)) found.add(value);
  }
  return [...found].sort();
}

describe("permission catalog", () => {
  it("defines every permission exactly once", () => {
    expect(new Set(permissions).size).toBe(permissions.length);
  });

  it.each(seedsAndFixtures)("grants only real permissions in %s", async (file) => {
    const referenced = await permissionStringsIn(file);
    // Guards against a renamed or moved file turning this into a test of nothing.
    expect(referenced.length, `${file} referenced no permissions at all`).toBeGreaterThan(0);
    expect(referenced.filter((value) => !permissionSet.has(value))).toEqual([]);
  });

  it("places every permission in exactly one group", () => {
    const grouped = permissionGroups.flatMap((group) => group.permissions);
    // Missing from the catalog means an owner can never grant it through the Roles editor; listed
    // twice means a checkbox that disagrees with itself.
    expect([...permissions].filter((permission) => !grouped.includes(permission))).toEqual([]);
    expect(grouped.filter((permission, index) => grouped.indexOf(permission) !== index)).toEqual([]);
    expect(new Set(permissionGroups.map((group) => group.id)).size).toBe(permissionGroups.length);
  });

  it("uses a real permission as every group master", () => {
    for (const group of permissionGroups) {
      if (group.masterKey === null) continue;
      // A master is a real permission that gates something on its own, not a synthetic header.
      expect(permissionSet.has(group.masterKey), group.id).toBe(true);
    }
  });

  it("labels every permission", () => {
    for (const permission of permissions) {
      expect(permissionLabels[permission]?.trim(), permission).toBeTruthy();
    }
  });

  it("marks unenforced permissions as ones that really exist", () => {
    // The set says "stored but gates nothing yet". A string in it that is not a permission would
    // silently mark nothing, and the editor would present a dead switch as a live one.
    for (const permission of unenforcedPermissions) expect(permissionSet.has(permission)).toBe(true);
  });

  it("builds every preset from real permissions", () => {
    for (const [name, preset] of Object.entries(permissionPresets)) {
      expect(preset.filter((value) => !permissionSet.has(value)), name).toEqual([]);
      expect(new Set(preset).size, `${name} repeats a permission`).toBe(preset.length);
    }
  });

  it("keeps the migration 0041 preset literals in step with the domain presets", async () => {
    // 0041 hard-codes the three presets, because a migration is a historical record and must not
    // change meaning when the tuple later does. That is correct - but on the day it was written
    // the two had to agree, or the backfill would have named a role after a preset it did not
    // actually match and quietly left everyone on `Custom access N` instead.
    const migration = (await readFile("migrations/0041_roles.sql", "utf8")).replaceAll("\r\n", "\n");
    const referenced = new Set<string>();
    for (const match of migration.matchAll(candidate)) {
      const value = match[1]!;
      if (namespaces.has(value.split(".", 1)[0]!)) referenced.add(value);
    }
    expect([...referenced].filter((value) => !permissionSet.has(value))).toEqual([]);
    // The Manager preset is the whole tuple, so the migration must name every permission there is.
    expect([...permissions].filter((value) => !referenced.has(value))).toEqual([]);
  });
});
