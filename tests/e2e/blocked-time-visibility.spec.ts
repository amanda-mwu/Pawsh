import { createAppointment, expect, login, test, type TenantFixture } from "./fixtures/tenant.js";
import { dragAppointmentToSlot } from "./helpers/calendar.js";
import { createDatabase } from "../../src/db/client.js";
import type { APIRequestContext, Page } from "@playwright/test";

/**
 * A BLOCKED TIME IS ENFORCED. THIS SUITE IS ABOUT WHETHER IT CAN BE SEEN.
 *
 * `tests/database/blocked-time-visibility.test.ts` proves the API half: the interval
 * `GET /api/blocked-times` returns is the interval `refuseStaffAvailability` refuses. This file is
 * the other half of the same fact, in a browser - THE CALENDAR DRAWS THE REGION THE SCHEDULER
 * REFUSES. Human QA found the gap by dragging an appointment onto a groomer's lunch, getting a
 * correct refusal, and seeing empty grid where the reason should have been; a refusal pointing at
 * nothing reads as the software being wrong rather than as the time being spoken for.
 *
 * So the load-bearing test below asserts BOTH IN ONE PLACE. Split apart, the suite could go green
 * while the grid drew a region nobody enforced, or enforced a region nobody drew - which is
 * precisely the state this seam closes.
 *
 * WHAT THIS SEAM IS NOT. A band is not draggable and not a drop target, and several tests below
 * exist to hold that line rather than to describe a feature. Editing a block - the dialog the band
 * now opens, its colour, its history - is `tests/e2e/blocked-time-editing.spec.ts`; this file is
 * still only about the region being drawn where the scheduler refuses.
 */

/** A second groomer, so "the right column" is a claim with something to be wrong about. */
async function addSecondGroomer(request: APIRequestContext, tenant: TenantFixture): Promise<string> {
  const response = await request.post("/api/employees", {
    data: { displayName: "Wanda Washer", serviceIds: [tenant.serviceId] }
  });
  expect(response.status(), await response.text()).toBe(201);
  const created = await response.json() as { id: string };
  return created.id;
}

async function createBlock(
  request: APIRequestContext,
  tenant: TenantFixture,
  options: { localStart: string; localEnd: string; reason: string; employeeId?: string }
): Promise<{ id: string }> {
  const response = await request.post("/api/blocked-times", {
    data: {
      employeeId: options.employeeId ?? tenant.employeeId,
      locationId: tenant.locationId,
      localStart: options.localStart,
      localEnd: options.localEnd,
      reason: options.reason,
      expectedLocationVersion: tenant.locationVersion
    }
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as { id: string };
}

async function openCalendar(page: Page): Promise<void> {
  await page.getByTestId("nav-calendar").click();
  await page.waitForLoadState("networkidle");
}

/** The middle of a box, for "is this band in that column, on that row" questions. */
function centreX(box: { x: number; width: number }): number { return box.x + box.width / 2; }
function centreY(box: { y: number; height: number }): number { return box.y + box.height / 2; }

/**
 * Measured with a retry, because the grid is redrawn wholesale.
 *
 * `renderCalendar` replaces the container's innerHTML, so a handle resolved a moment before a
 * redraw is detached by the time it is measured - which fails as "element is not attached" and
 * says nothing about the band. Re-resolving until a box comes back keeps the assertion about the
 * geometry it is actually making a claim about.
 */
async function boxOf(page: Page, selector: string, text?: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const locator = text ? page.locator(selector, { hasText: text }).first() : page.locator(selector).first();
  await expect(locator).toBeVisible();
  for (let attempt = 0; attempt < 20; attempt++) {
    const box = await locator.boundingBox().catch(() => null);
    if (box) return box;
    await page.waitForTimeout(100);
  }
  throw new Error(`${selector}${text ? ` (${text})` : ""} never settled into a measurable box`);
}

test("draws the block the scheduler already refuses, in the right groomer column at the right time",
  async ({ page, request, tenant }) => {
    await addSecondGroomer(request, tenant);
    const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
    });

    await login(page, tenant.ownerEmail);
    await openCalendar(page);

    // === Drawn, in the week grid ===
    const band = page.getByTestId("calendar-block");
    await expect(band).toHaveCount(1);
    // The range leads, then the reason - the range is what a clipped band still manages to say.
    await expect(band).toHaveText("12:00 PM–12:30 PM · Lunch");

    // The right DAY and the right GROOMER, measured rather than read back from the style this
    // client just wrote. The day header spans both groomer lanes and groomers are sorted by
    // display name, so Grace owns its left half and Wanda its right.
    const headBox = await boxOf(page, `[data-calendar-date="${tenant.anchor}"]`);
    const bandBox = await boxOf(page, '[data-testid="calendar-block"]');
    expect(centreX(bandBox)).toBeGreaterThan(headBox.x);
    expect(centreX(bandBox)).toBeLessThan(headBox.x + headBox.width / 2);

    // The right TIME: the band sits on the row the 12:00 axis label names.
    const rowBox = await boxOf(page, ".week-time", "12:00 PM");
    expect(centreY(bandBox)).toBeGreaterThanOrEqual(rowBox.y);
    expect(centreY(bandBox)).toBeLessThanOrEqual(rowBox.y + rowBox.height);

    // === And refused, for the same interval, through the same grid ===
    // The API answer first, so the refusal below is attributable to the block rather than to
    // whatever else a drag might have walked into.
    const refusedBooking = await request.post("/api/appointments", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        locationId: tenant.locationId, customerId: tenant.customerId, petId: tenant.petId,
        employeeId: tenant.employeeId, serviceIds: [tenant.serviceId],
        localStart: `${tenant.anchor}T12:00`, expectedLocationVersion: tenant.locationVersion
      }
    });
    expect(refusedBooking.status(), await refusedBooking.text()).toBe(409);
    expect((await refusedBooking.json()).code).toBe("TIME_BLOCKED");

    // Then the operator's own path onto it. The drag lands on the SLOT UNDERNEATH the band, since
    // the band carries no `data-slot` of its own - so this is at once the enforcement proof and
    // the proof that a band is not itself a drop target.
    await dragAppointmentToSlot(page, {
      appointmentId: appointment.id, slot: `${tenant.anchor}T12:00`, groomerId: tenant.employeeId
    });
    await page.getByTestId("stacked-dialog-confirm").click();
    await expect(page.getByTestId("modal")).toBeVisible();
    await expect(page.locator("#modal-error")).toContainText("has time blocked out");
    await page.getByTestId("modal").getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByTestId("modal")).toBeHidden();

    // The same block, in the day grid, in the same groomer's column.
    await page.locator("#calendar-view-select").selectOption("day");
    await page.waitForLoadState("networkidle");
    await expect(band).toHaveCount(1);
    await expect(band).toHaveText("12:00 PM–12:30 PM · Lunch");
    const graceColumn = await boxOf(page, ".day-groomer", "Grace Groomer");
    const wandaColumn = await boxOf(page, ".day-groomer", "Wanda Washer");
    const dayBandBox = await boxOf(page, '[data-testid="calendar-block"]');
    expect(centreX(dayBandBox)).toBeGreaterThan(graceColumn.x);
    expect(centreX(dayBandBox)).toBeLessThan(graceColumn.x + graceColumn.width);
    expect(centreX(dayBandBox)).toBeLessThan(wandaColumn.x);

    // A block is not an appointment: `data-appointment-id` is the attribute the drag, the detail
    // dialog and the notes panel all key off, and the band deliberately does not carry it.
    expect(await band.getAttribute("data-appointment-id")).toBeNull();
  });

test("shows the block's detail on hover, in the calendar's one tooltip", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  const block = await createBlock(request, tenant, {
    localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
  });
  await login(page, tenant.ownerEmail);
  await openCalendar(page);

  const preview = page.locator("#calendar-hover-preview");
  await expect(preview).toBeHidden();
  await page.getByTestId("calendar-block").hover();
  // THE SAME ELEMENT the appointment hover fills. There is one tooltip on this grid, not two.
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("data-hover-blocked-time-id", block.id);
  await expect(preview).toContainText("Block time");
  await expect(preview).toContainText("Grace Groomer");
  await expect(preview).toContainText("12:00 PM–12:30 PM");
  await expect(preview).toContainText("Lunch");

  await page.mouse.move(4, 4);
  await expect(preview).toBeHidden();
});

test("keeps the band out of every interaction it does not own: a drop target and a slot", async ({ page, request, tenant }) => {
  const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await createBlock(request, tenant, {
    localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
  });
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  await page.locator("#calendar-view-select").selectOption("day");
  await page.waitForLoadState("networkidle");

  const band = page.getByTestId("calendar-block");
  await expect(band).toHaveCount(1);
  // Not a card: no appointment identity, and never the card's class. It IS draggable for an owner
  // - `tests/e2e/blocked-time-drag.spec.ts` walks that - which is a different thing from being a
  // card, because a band is never a drop target.
  await expect(band).not.toHaveClass(/appointment-block/);
  expect(await band.getAttribute("data-appointment-id")).toBeNull();
  // Not a slot: `calendarDropSlot` and the slot menu both key off `[data-slot]`.
  expect(await band.getAttribute("data-slot")).toBeNull();
  await expect(page.locator('[data-testid="calendar-block"] [data-slot]')).toHaveCount(0);

  // Pressing and travelling on the band is a MOVE gesture now, and a move asks before it does
  // anything: the question comes up, Cancel answers it, and nothing else opened - not the
  // booking modal, and not the Block Time dialog, because a press that travelled is not a click.
  // Hovered first, so the press lands on the band as it is laid out NOW rather than where it was
  // measured a redraw ago - the day grid is repainted wholesale after its reads settle.
  const grip = band.locator(".calendar-block-label");
  await grip.hover();
  const box = (await grip.boundingBox())!;
  await page.mouse.down();
  // Upwards, onto the empty 11:00 row: the 12:00 band sits at the foot of the scrolled grid, and a
  // travel downwards would leave the visible slots altogether.
  await page.mouse.move(centreX(box), centreY(box) - 60, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("stacked-dialog")).toBeVisible();
  await expect(page.getByTestId("blocked-time-move-question")).toBeVisible();
  await page.getByTestId("stacked-dialog-dismiss").click();
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
  await expect(page.getByTestId("modal")).toBeHidden();
  await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
  await expect(band).toContainText("12:00 PM–12:30 PM");

  // Clicking opens the block, and ONLY the block. The band sits over a slot, so the thing being
  // held here is that it never falls through to the slot menu or the booking workspace: a band is
  // still a region rather than a bookable slot, even now that the region can be opened.
  await band.click();
  await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
  await expect(page.getByTestId("slot-menu")).toBeHidden();
  await expect(page.getByTestId("modal")).toBeHidden();
  await expect(page.getByTestId("booking-dialog")).toBeHidden();
  await page.getByTestId("blocked-time-cancel").click();
  await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();

  // And the appointment beside it still drags, so the assertions above are about the band rather
  // than about a calendar that has quietly stopped responding.
  await dragAppointmentToSlot(page, {
    appointmentId: appointment.id, slot: `${tenant.anchor}T10:00`, groomerId: tenant.employeeId
  });
  await expect(page.getByTestId("stacked-dialog")).toBeVisible();
  await page.getByTestId("stacked-dialog-dismiss").click();
  await expect(page.getByTestId("stacked-dialog")).toBeHidden();
});

test("reads the block's times through the workspace's hour format", async ({ page, request, tenant }) => {
  await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  await createBlock(request, tenant, {
    localStart: `${tenant.anchor}T14:00`, localEnd: `${tenant.anchor}T14:30`, reason: "Staff meeting"
  });
  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  const band = page.getByTestId("calendar-block");
  await expect(band).toHaveText("2:00 PM–2:30 PM · Staff meeting");

  // Settings -> Business -> Hour format, the same lever `tests/e2e/business.spec.ts` pulls for the
  // grid's time axis. A band that ignored it would be the one thing left on this calendar still
  // printing whatever the browser happens to prefer.
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("admin-settings-view")).toBeVisible();
  await page.locator("#settings-navigation").getByRole("button", { name: "Business", exact: true }).click();
  await page.getByTestId("business-hour-format").selectOption("24");
  await page.getByTestId("business-save").click();
  await expect(page.getByTestId("business-status")).toHaveText("Business settings saved.");
  await page.reload();
  await openCalendar(page);
  await expect(band).toHaveText("14:00–14:30 · Staff meeting");
  await expect(band).not.toContainText(/[AP]M/);
});

/**
 * `reason` is nullable in `blocked_times` and has been since 0001, but `blockedTimeSchema` requires
 * one - so the only honest way to reach the null case end to end is to write the null the create
 * schema cannot express and then let the real endpoint and the real client deal with it. This is
 * not a mock: the row is genuinely null in the database, `GET /api/blocked-times` serves it, and
 * the grid renders whatever it makes of it.
 */
test("renders a block with no reason as its time range alone", async ({ page, request, tenant }) => {
  // `scripts/run-playwright.mjs` starts the server from this same environment and refuses a
  // caller-supplied base URL, so DATABASE_URL here IS the database the server under test is on.
  test.skip(!process.env.DATABASE_URL,
    "needs this run's own database to write a reason the create schema cannot express");
  await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
  const block = await createBlock(request, tenant, {
    localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Lunch"
  });
  const db = createDatabase({ DATABASE_URL: process.env.DATABASE_URL! });
  try {
    const updated = await db`update blocked_times set reason=null where id=${block.id} returning id`;
    expect(updated.length, "the block being nulled has to exist in this run's database").toBe(1);
  } finally {
    await db.end({ timeout: 5 });
  }

  await login(page, tenant.ownerEmail);
  await openCalendar(page);
  const band = page.getByTestId("calendar-block");
  // The range alone. No separator with nothing after it, and no invented label: the salon never
  // gave a reason, and the calendar does not make one up on its behalf.
  await expect(band).toHaveText("12:00 PM–12:30 PM");
  await expect(band).not.toContainText("·");
  await expect(band).not.toContainText("Lunch");

  // The hover is honest about it too - a Reason row with nothing in it is worse than no row.
  await band.hover();
  const preview = page.locator("#calendar-hover-preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Block time");
  await expect(preview).not.toContainText("Reason");
});

/**
 * TWO BLOCKS AT ONE TIME ARE TWO BANDS, AND HUMAN QA HAD TO FIND THAT OUT THE HARD WAY.
 *
 * A band used to be emitted at the full width of its column, so a second block on the same groomer
 * at the same time painted exactly on top of the first. Nothing errored. The grid did not change.
 * The operator who had just created the second one read that as the create having failed, and their
 * next move was to create it a third time.
 *
 * So these tests assert BOTH HALVES of "it is there": each band has its own geometry AND its own
 * click. A test that only counted `calendar-block` elements would have passed against the defect,
 * because both elements were always in the document - they were simply in the same pixels.
 */
test("draws two blocks at the same time as two bands, each opening its own block",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    // The pair from human QA: a seeded lunch and a block made over it, same groomer, same half hour.
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "QA seed: Lunch"
    });
    await createBlock(request, tenant, {
      localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "NEED TIME"
    });

    await login(page, tenant.ownerEmail);
    await openCalendar(page);

    const bands = page.getByTestId("calendar-block");
    await expect(bands).toHaveCount(2);
    const lunch = bands.filter({ hasText: "QA seed: Lunch" });
    const need = bands.filter({ hasText: "NEED TIME" });

    // SIDE BY SIDE, MEASURED. Same row, disjoint columns of pixels - which is the assertion the
    // defect fails and an element count does not.
    //
    // AND WITHOUT ASSUMING WHICH ONE IS ON THE LEFT. Two blocks that share a start, an end and a
    // groomer fall through to `blockedTimeRows`'s last tiebreaker, `order by ... block.id`, so the
    // lane each takes is settled by the UUIDs Postgres happened to generate rather than by which
    // was created first. That is stable for a given pair - an operator reloading sees the same two
    // lanes - but it is a coin flip from one fixture run to the next, and asserting "Lunch is lane
    // 1" is what made this test fail about half the time it ran. Sorting by x is how the
    // three-band test below already reads the same geometry.
    const lunchBox = await boxOf(page, '[data-testid="calendar-block"]', "QA seed: Lunch");
    const needBox = await boxOf(page, '[data-testid="calendar-block"]', "NEED TIME");
    const [leftBox, rightBox] = [lunchBox, needBox].sort((a, b) => a.x - b.x);
    expect(Math.round(lunchBox.y)).toBe(Math.round(needBox.y));
    expect(leftBox!.x + leftBox!.width).toBeLessThanOrEqual(rightBox!.x + 1);
    expect(lunchBox.width).toBeGreaterThan(20);
    expect(needBox.width).toBeGreaterThan(20);

    // Each one is separately nameable, which is what a reader tabbing through them gets: its own
    // reason, and its own place in the stack rather than two bands both calling themselves 1 of 2.
    await expect(lunch.getByRole("button")).toHaveAttribute("aria-label", /QA seed: Lunch, [12] of 2$/);
    await expect(need.getByRole("button")).toHaveAttribute("aria-label", /NEED TIME, [12] of 2$/);
    const positions = await bands.getByRole("button").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label")?.match(/(\d+) of 2$/)?.[1]));
    expect(new Set(positions).size, `both bands claimed the same lane: ${positions.join(", ")}`).toBe(2);

    // And each one opens ITS OWN block rather than whichever happened to be painted last.
    await need.click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
    await expect(page.getByTestId("blocked-time-note")).toHaveValue("NEED TIME");
    await page.getByTestId("blocked-time-cancel").click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();

    await lunch.click();
    await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
    await expect(page.getByTestId("blocked-time-note")).toHaveValue("QA seed: Lunch");
    await page.getByTestId("blocked-time-cancel").click();

    // The same two bands, and the same two clicks, in the day grid.
    await page.locator("#calendar-view-select").selectOption("day");
    await expect(page.getByTestId("calendar-block")).toHaveCount(2);
    const dayLunch = await boxOf(page, '[data-testid="calendar-block"]', "QA seed: Lunch");
    const dayNeed = await boxOf(page, '[data-testid="calendar-block"]', "NEED TIME");
    // Sorted for the same reason as the week grid above: the lane order is the ids', not ours.
    const [dayLeft, dayRight] = [dayLunch, dayNeed].sort((a, b) => a.x - b.x);
    expect(dayLeft!.x + dayLeft!.width).toBeLessThanOrEqual(dayRight!.x + 1);
    await page.getByTestId("calendar-block").filter({ hasText: "NEED TIME" }).click();
    await expect(page.getByTestId("blocked-time-note")).toHaveValue("NEED TIME");
  });

test("keeps a third block reachable rather than hiding it behind the first two",
  async ({ page, request, tenant }) => {
    // Two lanes is exactly where a boolean overlap flag stops being enough - the appointment grid's
    // `.overlap` spends one fixed inset and has nothing left for a third card. A block stack has no
    // such ceiling, so the third one has to get a lane of its own.
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    for (const reason of ["First cover", "Second cover", "Third cover"]) {
      await createBlock(request, tenant, {
        localStart: `${tenant.anchor}T13:00`, localEnd: `${tenant.anchor}T13:30`, reason
      });
    }

    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await expect(page.getByTestId("calendar-block")).toHaveCount(3);

    const boxes: Array<{ reason: string; x: number; y: number; width: number; height: number }> = [];
    for (const reason of ["First cover", "Second cover", "Third cover"])
      boxes.push({ reason, ...await boxOf(page, '[data-testid="calendar-block"]', reason) });
    boxes.sort((a, b) => a.x - b.x);
    for (let index = 1; index < boxes.length; index++)
      expect(boxes[index]!.x, `${boxes[index]!.reason} overlaps ${boxes[index - 1]!.reason}`)
        .toBeGreaterThanOrEqual(boxes[index - 1]!.x + boxes[index - 1]!.width - 1);

    // The one that matters: every one of the three is still clickable and opens itself. Under the
    // defect this click landed on whichever band happened to be painted over the others.
    for (const reason of ["First cover", "Second cover", "Third cover"]) {
      await page.getByTestId("calendar-block").filter({ hasText: reason }).click();
      await expect(page.getByTestId("blocked-time-dialog")).toBeVisible();
      await expect(page.getByTestId("blocked-time-note")).toHaveValue(reason);
      await page.getByTestId("blocked-time-cancel").click();
      await expect(page.getByTestId("blocked-time-dialog")).toBeHidden();
    }
  });

test("reads a partial overlap as an overlap, and two blocks that merely touch as neither",
  async ({ page, request, tenant }) => {
    await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    // 11:00-12:00 and 11:30-12:30 share half an hour; 14:00-14:30 and 14:30-15:00 share an edge and
    // no pixels. The first pair must split the column, and the second pair must not - a narrowing
    // nobody asked for is its own small defect.
    //
    // THE STAGGER CLEARS THE 09:00 APPOINTMENT, which is a 90-minute Full Groom and so runs to
    // 10:30. Blocked time may not cover a booked appointment, so a stagger starting at 10:00 is
    // refused with BLOCK_TIME_APPOINTMENT_CONFLICT while the fixtures are still being built - a
    // setup failure that says nothing at all about the lane geometry this test exists to check.
    await createBlock(request, tenant, { localStart: `${tenant.anchor}T11:00`, localEnd: `${tenant.anchor}T12:00`, reason: "Early stagger" });
    await createBlock(request, tenant, { localStart: `${tenant.anchor}T11:30`, localEnd: `${tenant.anchor}T12:30`, reason: "Late stagger" });
    await createBlock(request, tenant, { localStart: `${tenant.anchor}T14:00`, localEnd: `${tenant.anchor}T14:30`, reason: "Before" });
    await createBlock(request, tenant, { localStart: `${tenant.anchor}T14:30`, localEnd: `${tenant.anchor}T15:00`, reason: "After" });

    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await expect(page.getByTestId("calendar-block")).toHaveCount(4);

    const early = await boxOf(page, '[data-testid="calendar-block"]', "Early stagger");
    const late = await boxOf(page, '[data-testid="calendar-block"]', "Late stagger");
    // Different rows AND different lanes: the stagger is visible as a stagger.
    expect(late.y).toBeGreaterThan(early.y);
    expect(late.x).toBeGreaterThanOrEqual(early.x + early.width - 1);

    const before = await boxOf(page, '[data-testid="calendar-block"]', "Before");
    const after = await boxOf(page, '[data-testid="calendar-block"]', "After");
    expect(Math.round(before.x)).toBe(Math.round(after.x));
    expect(Math.round(before.width)).toBe(Math.round(after.width));
    // And each of the untouched pair is still as wide as a lone band, not half of one.
    expect(before.width).toBeGreaterThan(early.width);

    await expect(page.getByTestId("calendar-block").filter({ hasText: "Before" }).getByRole("button"))
      .not.toHaveAttribute("aria-label", /\d of \d$/);
  });

test("keeps a stacked band out of drop, and still refuses the drop underneath it",
  async ({ page, request, tenant }) => {
    // Narrower bands are still bands. The two attributes that would make one a card or a target -
    // an appointment id, a slot - must still be absent however many lanes it is in, and the slot
    // underneath must still take the drop and still come back TIME_BLOCKED.
    const appointment = await createAppointment(request, tenant, { localStart: `${tenant.anchor}T09:00` });
    await createBlock(request, tenant, { localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "One" });
    await createBlock(request, tenant, { localStart: `${tenant.anchor}T12:00`, localEnd: `${tenant.anchor}T12:30`, reason: "Two" });

    await login(page, tenant.ownerEmail);
    await openCalendar(page);
    await expect(page.getByTestId("calendar-block")).toHaveCount(2);

    for (const reason of ["One", "Two"]) {
      const band = page.getByTestId("calendar-block").filter({ hasText: reason });
      expect(await band.getAttribute("data-appointment-id")).toBeNull();
      expect(await band.getAttribute("data-slot")).toBeNull();
      // Two lanes, so both bands say so, and each says which one it is.
      await expect(band).toHaveAttribute("data-block-lanes", "2");
    }

    await dragAppointmentToSlot(page, {
      appointmentId: appointment.id, slot: `${tenant.anchor}T12:00`, groomerId: tenant.employeeId
    });
    await page.getByTestId("stacked-dialog-confirm").click();
    await expect(page.getByTestId("modal")).toBeVisible();
    await expect(page.locator("#modal-error")).toContainText("has time blocked out");
  });
