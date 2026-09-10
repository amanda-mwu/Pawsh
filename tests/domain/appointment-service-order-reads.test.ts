import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * THE READ SITES, AS A SET.
 *
 * The defect 0054 closes was not one bad query. `appointment_services` had no ordering column, so
 * FIVE separate reads each ordered a Ticket's services by a random uuid, and each of them looked
 * locally reasonable - `order by aps.id` reads like a deterministic tie-break until you notice the
 * id is `gen_random_uuid()`. The database tests prove the behaviour of the paths that exist today;
 * this proves the SHAPE, so a sixth read added next year with `order by id` is caught at review
 * rather than by an operator noticing their work sheet moved.
 *
 * It asserts on the TEXT of `routes.ts` deliberately, in the same spirit as
 * `migration-syntax.test.ts`: the property is "no read of this table orders by its primary key",
 * which is a statement about the source rather than about any one response.
 *
 * `line_position` is always followed by `, id` (or `, aps.id`, `, history.id`). The unique key from
 * 0054 makes that tie-break unreachable, and it is kept anyway so that a row written outside the
 * API - a repair script, a restore - cannot put an arbitrary result back on the screen.
 */
describe("appointment service reads are ordered by line_position", () => {
  const source = async () =>
    (await readFile("src/http/routes.ts", "utf8")).replaceAll("\r\n", "\n");

  /**
   * The five ordered reads, each named by what it serves. Anything removed from this list is a read
   * that no longer exists; anything added is a read someone has to have thought about.
   */
  const orderings = [
    // The calendar list and GET /api/appointments/:id, via `appointmentCalendarRows`. THE TICKET'S
    // SOURCE: the Ticket surface and the Ticket print document both render this array.
    ") order by aps.line_position, aps.id) filter (where aps.id is not null), '[]') as services,",
    // The client and pet profile history pages, via `appointmentHistoryPage`.
    ") order by aps.line_position, aps.id) from appointment_services aps",
    // The booking form's "same as last paid visit" default.
    "order by history.line_position, history.id",
    // The report card's list of what was done.
    "order by line_position, id\n      `,",
    // Checkout, which numbers `invoice_items.line_position` from this read.
    "order by line_position, id\n      `;"
  ];

  it("orders every per-appointment read by the recorded position", async () => {
    const routes = await source();
    for (const ordering of orderings) {
      expect(routes, ordering).toContain(ordering);
    }
  });

  /**
   * And none of the orderings this replaced survives. `order by aps.id` and `order by history.id`
   * are unambiguous - both aliases exist only in a query over `appointment_services`.
   */
  it("no longer orders any of them by the random primary key", async () => {
    const routes = await source();
    expect(routes).not.toContain("order by aps.id");
    expect(routes).not.toContain("order by history.id");
  });

  /**
   * BOTH WRITE PATHS STATE A POSITION. `line_position` is NOT NULL with no default, so an insert
   * that omitted it would fail at runtime rather than at build - which is precisely the failure
   * mode a type checker cannot see, because these are SQL template literals.
   */
  it("writes a position on every insert into appointment_services", async () => {
    const routes = await source();
    const inserts = routes.split("insert into appointment_services").slice(1);
    expect(inserts, "both write paths are still here").toHaveLength(2);
    for (const [index, insert] of inserts.entries()) {
      const statement = insert.slice(0, insert.indexOf("`"));
      expect(statement, `write path ${index + 1}`).toContain("line_position");
      // From the loop index over `catalog`, one based, rather than from a constant.
      expect(statement, `write path ${index + 1}`).toContain("${index + 1}");
    }
  });

  /**
   * THE TICKET DOES NOT READ AN INVOICE TO FIND ITS ORDER. `appointmentCalendarRows` is the
   * projection the Ticket renders, and its whole text must not mention `invoice_items` at all: the
   * sheet exists before any invoice does, and an order borrowed from one would change under a
   * visit the moment it was checked out.
   */
  it("builds the Ticket's projection without reading invoice_items", async () => {
    const routes = await source();
    const start = routes.indexOf("function appointmentCalendarRows(");
    expect(start, "appointmentCalendarRows is still the shared projection").toBeGreaterThan(-1);
    const projection = routes.slice(start, routes.indexOf("\n}", start));
    expect(projection).toContain("aps.line_position");
    // It joins `invoices` for the status and balance the calendar badge shows, which is a fact
    // ABOUT the visit rather than an ordering, and it reads no invoice LINE at all.
    expect(projection).not.toContain("invoice_items");
  });
});
