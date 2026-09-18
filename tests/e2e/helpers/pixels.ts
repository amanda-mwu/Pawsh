import type { Locator, Page } from "@playwright/test";

/**
 * The rendered pixels of one element, read back from a screenshot.
 *
 * Some defects are only visible after the browser has painted: a tick drawn by two rotated
 * borders has no text to read and no box to measure, and a native checkbox is whatever the
 * engine draws for `accent-color`. Computed styles can say what was asked for; only the pixels say
 * what a person saw. The screenshot is decoded IN THE PAGE - a data: image drawn onto a canvas -
 * so this needs no PNG library and gives the same answer in every engine Playwright drives.
 *
 * Coordinates in the result are DEVICE pixels; `scale` is how many of them make one CSS pixel on
 * the project's device, so a caller converting a CSS measurement multiplies by it.
 */
export interface Pixels {
  width: number;
  height: number;
  scale: number;
  /** RGBA, row-major, four bytes per pixel. */
  data: number[];
}

export async function elementPixels(page: Page, locator: Locator): Promise<Pixels> {
  // The calendar redraws when a load settles, which detaches whatever was being measured; the
  // locator re-resolves, so a detached element is retried rather than reported.
  let box: { x: number; y: number; width: number; height: number } | null = null;
  for (let attempt = 0; attempt < 5 && !box; attempt += 1) {
    try {
      await locator.scrollIntoViewIfNeeded();
      box = await locator.boundingBox();
    } catch (error) {
      if (attempt === 4) throw error;
      await page.waitForTimeout(150);
    }
  }
  if (!box) throw new Error("the element has no rendered box to read");
  const png = await page.screenshot({ clip: box, animations: "disabled", caret: "hide" });
  const scale = await page.evaluate(() => devicePixelRatio);
  return page.evaluate(async ([encoded, ratio]) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d canvas context to decode the screenshot with");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, scale: Number(ratio), data: Array.from(data) };
  }, [png.toString("base64"), scale] as const);
}

export function pixelAt(pixels: Pixels, x: number, y: number): [number, number, number] {
  const offset = (y * pixels.width + x) * 4;
  return [pixels.data[offset]!, pixels.data[offset + 1]!, pixels.data[offset + 2]!];
}

/** WCAG relative luminance of one pixel, 0 (black) to 1 (white). */
export function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Euclidean distance between two colours in RGB, 0 to about 441. */
export function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
