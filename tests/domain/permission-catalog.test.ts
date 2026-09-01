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
    const source = await readFile(file, "utf8");
    const referenced = await permissionStringsIn(file);
    // Every permission string it does spell out must be one the domain defines.
    expect(referenced.filter((value) => !permissionSet.has(value))).toEqual([]);
    // And it must be doing one of the two honest things: spelling them out, or deriving them from
    // the tuple. A file doing NEITHER has been renamed, moved, or quietly rewritten, and this test
    // would otherwise be asserting nothing at all while continuing to pass. Deriving is the better
    // of the two - a hand-maintained copy of the tuple is exactly what fell behind when the
    // reporting taxonomy was added.
    const derives = /from\s+"@pawsh\/domain"/.test(source);
    expect(
      derives || referenced.length > 0,
      `${file} neither lists permissions nor derives them from the domain tuple`
    ).toBe(true);
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

  it("grants every permission to somebody, through 0041 or 0043", async () => {
    // Migrations are historical records and must not be edited when the tuple grows, so neither of
    // these names the whole tuple on its own: 0041 seeded roles from the presets as they stood
    // then, and 0043 added the reporting taxonomy to the roles that already had `reports.view`.
    //
    // TOGETHER THEY MUST COVER IT. A permission named in neither is one that exists in code, is
    // grantable through the editor, and that NO EXISTING ROLE HAS - so every workspace silently
    // starts without it and nobody is told. That may well be the right answer for a genuinely new
    // capability, but it is a decision, and this test exists to force it to be made rather than
    // arrived at by omission.
    const named = new Set<string>();
    for (const file of ["0041_roles.sql", "0043_report_dashboard_taxonomy.sql"]) {
      const sql = (await readFile(`migrations/${file}`, "utf8")).replaceAll("\r\n", "\n");
      for (const match of sql.matchAll(candidate)) {
        const value = match[1]!;
        if (namespaces.has(value.split(".", 1)[0]!)) named.add(value);
      }
      // Neither migration may name a permission the domain does not define.
      expect([...named].filter((value) => !permissionSet.has(value)), file).toEqual([]);
    }
    expect([...permissions].filter((value) => !named.has(value))).toEqual([]);
  });
});
