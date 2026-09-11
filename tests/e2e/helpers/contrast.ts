import { type Locator } from "@playwright/test";

/**
 * WCAG contrast, measured off the RENDERED page rather than off the stylesheet.
 *
 * The colour-slot picker draws its tick with `color-mix()`, so the value that actually reaches the
 * screen is not written down anywhere in `public/styles.css` - it is computed per swatch from that
 * swatch's own `--g`. Reading the source would only re-state the expression; the ratio a person
 * actually sees is only knowable after the cascade has run, which is why these read
 * `getComputedStyle` in the browser and do the arithmetic here.
 */

/**
 * One computed colour, as a browser hands it back.
 *
 * Engines serialise a mixed colour as `color(srgb 0.23 0.16 0.3)` with 0-1 components and a plain
 * one as `rgb(59, 42, 76)` with 0-255 components. Both arrive from the same `getComputedStyle`
 * call depending on how the value was authored, so the parser has to tell them apart - reading a
 * `color()` on the 0-255 assumption silently rounds every channel to 0 and reports black, which
 * looks like a passing contrast result rather than a broken measurement.
 */
export function parseColor(value: string): [number,number,number] {
  const parts=(value.match(/-?[\d.]+(?:e-?\d+)?/g)??[]).map(Number);
  if(parts.length<3) throw new Error(`not a colour this helper can read: ${value}`);
  const scale=/^color\(/.test(value) ? 255 : 1;
  const channel=(index: number): number=>
    Math.max(0,Math.min(255,Math.round((parts[index] as number)*scale)));
  return [channel(0),channel(1),channel(2)];
}

function relativeLuminance([r,g,b]: [number,number,number]): number {
  const channel=(value: number): number=>{
    const s=value/255;
    return s<=0.03928 ? s/12.92 : ((s+0.055)/1.055)**2.4;
  };
  return 0.2126*channel(r)+0.7152*channel(g)+0.0722*channel(b);
}

/** WCAG 2.1 contrast ratio, 1 to 21. */
export function contrastRatio(foreground: string,background: string): number {
  const a=relativeLuminance(parseColor(foreground));
  const b=relativeLuminance(parseColor(background));
  const [lighter,darker]=a>b ? [a,b] : [b,a];
  return (lighter+0.05)/(darker+0.05);
}

/**
 * The tick a selected colour swatch draws, and the fill it is drawn on.
 *
 * The tick is two borders of an empty `::after` - there is no element to address and no text to
 * read - so the mark's colour is its computed `border-left-color`, and `content` is how the test
 * tells "drawn" from "not drawn" at all.
 */
export async function swatchMark(dot: Locator): Promise<{mark: string; fill: string; drawn: boolean}> {
  return dot.evaluate((element)=>{
    const tick=getComputedStyle(element,"::after");
    return {
      mark:tick.borderLeftColor,
      fill:getComputedStyle(element).backgroundColor,
      drawn:tick.content!=="none"
    };
  });
}
