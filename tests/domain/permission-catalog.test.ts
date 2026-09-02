import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  builtInRoles, permissionGroups, permissionLabels, permissionPresets, permissions,
  unenforcedPermissions
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

  it("grants every permission to somebody, through 0041, 0043 or 0045", async () => {
    // Migrations are historical records and must not be edited when the tuple grows, so none of
    // these names the whole tuple on its own: 0041 seeded roles from the presets as they stood
    // then, 0043 added the reporting taxonomy to the roles that already had `reports.view`, and
    // 0045 added the Role Permission taxonomy to the roles that already held all 46.
    //
    // TOGETHER THEY MUST COVER IT. A permission named in neither is one that exists in code, is
    // grantable through the editor, and that NO EXISTING ROLE HAS - so every workspace silently
    // starts without it and nobody is told. That may well be the right answer for a genuinely new
    // capability, but it is a decision, and this test exists to force it to be made rather than
    // arrived at by omission.
    const named = new Set<string>();
    const chain = [
      "0041_roles.sql", "0043_report_dashboard_taxonomy.sql", "0045_permission_taxonomy.sql"
    ];
    for (const file of chain) {
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

  it("still means by Groomer, Receptionist and Manager what the migration chain wrote", async () => {
    // The built-in roles now exist in TWO places that can never be merged: SQL literals in
    // migrations that have already run and must never be edited, and `builtInRoles`, which
    // `provisionRoleCatalog` gives to every business created since. Nothing makes them agree.
    //
    // So this pins them to each other. A migrated salon's Groomer and a salon that signed up this
    // morning must be the same role - if they drift, the same workspace shows two different
    // Groomers depending on when it was created, and no error is raised anywhere.
    //
    // The model is the migration chain's NET EFFECT, not 0041 alone. Each link carries its own
    // predicate and each is reproduced here exactly:
    //
    //   0041  seeded the three presets as they stood then.
    //   0043  granted the reporting taxonomy to every role holding `reports.view` - which is how
    //         the Manager caught up, and why the Groomer and the Receptionist correctly did not.
    //   0045  granted the Role Permission taxonomy to every role already holding all 46, which is
    //         "the roles that could already do everything", expressed relationally rather than by
    //         name so a renamed built-in and a fully-granted custom role are both covered.
    //
    // A NEW MIGRATION IN THIS CHAIN MUST BE ADDED HERE. That is not busywork: this test is the
    // only thing pinning the frozen SQL literals to the live definitions, and a link left out
    // would let the two drift silently in exactly the direction 0043 had to repair.
    const read = async (file: string) =>
      (await readFile(`migrations/${file}`, "utf8")).replaceAll("\r\n", "\n");
    const roles = await read("0041_roles.sql");
    const reportingSql = await read("0043_report_dashboard_taxonomy.sql");
    const permissionSql = await read("0045_permission_taxonomy.sql");
    const stringsIn = (sql: string) => [...sql.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    const granted = (sql: string) =>
      stringsIn(/permissions \|\| array\[([\s\S]*?)\]/.exec(sql)![1]!);
    const taxonomy = granted(reportingSql);
    const permissionTaxonomy = granted(permissionSql);
    // 0045's own predicate: `where permissions @> array[...]`.
    const alreadyEverything = stringsIn(
      /permissions @> array\[([\s\S]*?)\]::text\[\]/.exec(permissionSql)![1]!
    );
    expect(taxonomy.length).toBeGreaterThan(0);
    expect(permissionTaxonomy.length).toBeGreaterThan(0);
    expect(alreadyEverything.length).toBeGreaterThan(0);

    const seeded = new Map(
      [...roles.matchAll(/\('(\w+)',\s*array\[([^\]]*)\]/g)]
        .map((match) => [match[1]!, stringsIn(match[2]!)] as const)
    );
    // Every built-in Pawsh ships is one 0041 actually seeded. A fourth added to `builtInRoles`
    // would reach new businesses and no existing one, which is a decision, not a detail.
    expect([...seeded.keys()].sort()).toEqual(builtInRoles.map((role) => role.name).sort());

    for (const role of builtInRoles) {
      const migrated = new Set(seeded.get(role.name));
      // 0043's own predicate: `where 'reports.view' = any(permissions)`.
      if (migrated.has("reports.view")) for (const permission of taxonomy) migrated.add(permission);
      // 0045's: every role holding all 46 as they stood before it.
      if (alreadyEverything.every((permission) => migrated.has(permission))) {
        for (const permission of permissionTaxonomy) migrated.add(permission);
      }
      expect([...migrated].sort(), role.name).toEqual([...role.permissions].sort());
    }
  });
});
