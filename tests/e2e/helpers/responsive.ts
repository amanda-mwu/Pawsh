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
  const box=await locator.boundingBox();
  expect(box,"Critical target must have a rendered bounding box").not.toBeNull();
  expect(box!.width,"Critical target width").toBeGreaterThanOrEqual(44);
  expect(box!.height,"Critical target height").toBeGreaterThanOrEqual(44);
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
