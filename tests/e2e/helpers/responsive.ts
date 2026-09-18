import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

export async function expectAuthenticatedSurface(page: Page): Promise<void> {
  await expect(page.locator("#app-view")).toBeVisible();
  await expect(page.locator("#auth-view")).toBeHidden();
  expect(await hiddenControlsAreInert(page,"#auth-view")).toBeTruthy();
}

export async function expectUnauthenticatedSurface(page: Page): Promise<void> {
  await expect(page.locator("#auth-view")).toBeVisible();
  await expect(page.locator("#app-view")).toBeHidden();
  expect(await hiddenControlsAreInert(page,"#app-view")).toBeTruthy();
}

async function hiddenControlsAreInert(page: Page,container: string): Promise<boolean> {
  return page.locator(`${container} button, ${container} a, ${container} input, ${container} select, ${container} textarea`)
    .evaluateAll((elements)=>elements.every((element)=>{
      const control=element as HTMLElement;
      return control.getClientRects().length===0 && control.offsetParent===null;
    }));
}

export async function expectNoDocumentOverflow(page: Page,testInfo: TestInfo): Promise<void> {
  const diagnostics=await page.evaluate(()=>{
    const root=document.documentElement;
    const clientWidth=root.clientWidth;
    const offenders=[...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element)=>{
        const style=getComputedStyle(element);
        if(style.display==="none"||style.visibility==="hidden")return false;
        if(element.closest("[data-allow-horizontal-scroll]"))return false;
        const rect=element.getBoundingClientRect();
        return rect.width>0 && (rect.left < -1 || rect.right > clientWidth + 1);
      })
      .slice(0,20)
      .map((element)=>{
        const rect=element.getBoundingClientRect();
        return {
          element:[
            element.tagName.toLowerCase(),
            element.id?`#${element.id}`:"",
            ...[...element.classList].slice(0,3).map((name)=>`.${name}`)
          ].join(""),
          left:Math.round(rect.left),
          right:Math.round(rect.right),
          width:Math.round(rect.width)
        };
      });
    return {
      url:location.href,
      viewportWidth:innerWidth,
      clientWidth,
      scrollWidth:root.scrollWidth,
      offenders
    };
  });
  if(diagnostics.scrollWidth>diagnostics.clientWidth) {
    await testInfo.attach("responsive-overflow-diagnostics",{
      body:Buffer.from(JSON.stringify({project:testInfo.project.name,...diagnostics},null,2)),
      contentType:"application/json"
    });
  }
  expect(
    diagnostics.scrollWidth,
    `${testInfo.project.name} overflow at ${diagnostics.url}: ${JSON.stringify(diagnostics.offenders)}`
  ).toBeLessThanOrEqual(diagnostics.clientWidth);
}

export async function expectCriticalTarget(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  // Measured through a poll rather than a single read. The calendar re-renders whenever a load
  // settles, which detaches the element being measured and makes `boundingBox()` return null —
  // a race that showed up as a different responsive test failing on each full-suite run while
  // every one of them passed alone.
  const measured = { width: 0, height: 0 };
  await expect.poll(async () => {
    const box = await locator.boundingBox().catch(() => null);
    if (!box) return null;
    measured.width = box.width;
    measured.height = box.height;
    return Math.min(box.width, box.height);
  }, { message: "Critical target must have a rendered bounding box" }).not.toBeNull();
  expect(measured.width,"Critical target width").toBeGreaterThanOrEqual(44);
  expect(measured.height,"Critical target height").toBeGreaterThanOrEqual(44);
}

/**
 * THE EFFECTIVE TARGET: what a finger can press, measured by asking the page rather than the box.
 *
 * `expectCriticalTarget` reads `boundingBox()`, which is the PAINTED box. A phone control drawn at
 * 36px that carries an invisible `::after` reaching 4px past each edge (the calendar toolbar, see
 * "The calendar toolbar on a phone" in styles.css) is a 44px target the bounding box cannot see,
 * and a control whose neighbour paints over its edge is a smaller target than its box claims. So
 * this walks outward from the control's centre one pixel at a time, asking `elementFromPoint`
 * whether the control - or something inside it - is still what would receive the press, and
 * reports the extent it found. A pseudo-element hit-tests as its originating element, which is
 * exactly the fact the toolbar relies on.
 */
export async function expectEffectiveTarget(locator: Locator, minimum = 44): Promise<void> {
  await expect(locator).toBeVisible();
  const measured = { name: "", width: 0, height: 0 };
  // Polled, and the scroll inside the poll: the calendar redraws when a load settles, which
  // detaches the element mid-measurement, and the locator re-resolves on the next attempt.
  await expect.poll(async () => {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const extent = await locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      const centreX = box.left + box.width / 2, centreY = box.top + box.height / 2;
      const hits = (x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
        const target = document.elementFromPoint(x, y);
        return target !== null && (target === element || element.contains(target));
      };
      if (!hits(centreX, centreY)) return { name: element.tagName.toLowerCase(), width: 0, height: 0 };
      const reach = (stepX: number, stepY: number): number => {
        let distance = 0;
        while (distance < 60 && hits(centreX + (distance + 1) * stepX, centreY + (distance + 1) * stepY)) distance += 1;
        return distance;
      };
      const name = [element.tagName.toLowerCase(), element.id ? `#${element.id}` : "",
        element.getAttribute("data-testid") ? `[${element.getAttribute("data-testid")}]` : ""].join("");
      return { name, width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1 };
    }).catch(() => null);
    if (!extent) return null;
    measured.name = extent.name;
    measured.width = extent.width;
    measured.height = extent.height;
    return Math.min(extent.width, extent.height);
  }, { message: "Effective target must be measurable" }).not.toBeNull();
  expect(measured.width, `Effective target width of ${measured.name}`).toBeGreaterThanOrEqual(minimum);
  expect(measured.height, `Effective target height of ${measured.name}`).toBeGreaterThanOrEqual(minimum);
}

/**
 * The Create Appointment workspace is its own dialog with its own header and action bar, so
 * the same reachability guarantee has to be checked against those controls rather than the
 * shared dialog's.
 */
export async function expectBookingControlsReachable(page: Page): Promise<void> {
  const dialog=page.getByTestId("booking-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#booking-title")).toBeVisible();
  const close=dialog.getByRole("button",{name:"Close"});
  const submit=dialog.getByTestId("booking-submit");
  await close.scrollIntoViewIfNeeded();
  await expectCriticalTarget(close);
  await submit.scrollIntoViewIfNeeded();
  await expectCriticalTarget(submit);
}

export async function expectDialogControlsReachable(page: Page): Promise<void> {
  const dialog=page.getByTestId("modal");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#modal-title")).toBeVisible();
  const close=dialog.getByRole("button",{name:"Close"});
  const submit=dialog.getByTestId("modal-submit");
  await close.scrollIntoViewIfNeeded();
  await expectCriticalTarget(close);
  await submit.scrollIntoViewIfNeeded();
  await expectCriticalTarget(submit);
}
