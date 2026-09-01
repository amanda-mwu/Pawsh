import { Platform, type TextStyle } from "react-native";

/**
 * Design tokens for the groomer app.
 *
 * Every light value is the web app's own `:root` value from `public/styles.css`. Dark mode does
 * not exist on web and is derived here. Three web aliases are deliberately collapsed rather than
 * ported: `--sage`, `--mint` and `--surface-2` are one colour, `--radius-sm` and `--radius-md`
 * are one radius, and `--coral` is `--brand` under a name that invites someone to "fix" it back
 * to orange.
 */

export const space = { hair: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { chip: 4, card: 12, button: 12, sheet: 16, pill: 999 } as const;

export const size = {
  /** `--control-h` under `@media (pointer:coarse)`. Mobile is always coarse. */
  tap: 44,
  /** Wet hands, one-handed, the most-tapped control in the product. A native addition. */
  tapPrimary: 52,
  tapSecondary: 48,
  iconBtn: 44,
  /** Groomer accent rail down the leading edge of a card. */
  rail: 4,
  tabBar: 49
} as const;

export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  ink: string;
  muted: string;
  placeholder: string;
  brand: string;
  brandText: string;
  brandStrong: string;
  brandTint: string;
  onBrand: string;
  danger: string;
  dangerFill: string;
  dangerTint: string;
  dangerLine: string;
  warning: string;
  warningTint: string;
  success: string;
  successTint: string;
  info: string;
  infoTint: string;
}

export const lightPalette: Palette = {
  bg: "#F7F8F6",
  surface: "#FFFFFF",
  surface2: "#F1F3F1",
  line: "#E2E6E2",
  ink: "#202522",
  muted: "#68706B",
  placeholder: "#868F89",
  brand: "#2F6F62",
  brandText: "#2F6F62",
  brandStrong: "#255A4F",
  brandTint: "#E9F1EF",
  onBrand: "#FFFFFF",
  danger: "#B3261E",
  dangerFill: "#B3261E",
  dangerTint: "#FDECEA",
  dangerLine: "#F0C7C2",
  warning: "#9A6410",
  warningTint: "#FDF3E2",
  success: "#1E7A4D",
  successTint: "#E8F5ED",
  info: "#1F6398",
  infoTint: "#E9F1F9"
};

/**
 * `brand` and `brandText` are identical in light and diverge in dark, and collapsing them is the
 * usual way a ported palette breaks: #2F6F62 reads at 5.9:1 on white but disappears on a #1B211E
 * ground, while #5FB3A1 reads there and is far too light to carry white text as a button fill.
 */
export const darkPalette: Palette = {
  bg: "#121614",
  surface: "#1B211E",
  surface2: "#232A26",
  line: "#333B36",
  ink: "#ECEFEC",
  muted: "#9CA6A0",
  placeholder: "#7E8983",
  brand: "#35806F",
  brandText: "#5FB3A1",
  brandStrong: "#8ACFC0",
  brandTint: "#163029",
  onBrand: "#FFFFFF",
  danger: "#FF6B60",
  dangerFill: "#C1372E",
  dangerTint: "#3A1D1A",
  dangerLine: "#5A2A24",
  warning: "#E0A53C",
  warningTint: "#33270F",
  success: "#4FBE85",
  successTint: "#16301F",
  info: "#5AA6E0",
  infoTint: "#14283A"
};

/**
 * The type ramp, rebuilt for a phone held at 40cm rather than a 27-inch monitor at 60cm.
 *
 * No `fontFamily`: the platform system font is what Pawsh already looks like, because the web
 * stack names Ubuntu and the project loads no font file anywhere. Leaving it undefined also buys
 * Dynamic Type and optical sizing for free. Nothing is smaller than 12; 11 exists only for
 * uppercase overlines, where cap height does the work.
 */
export type TypeToken =
  | "display" | "title1" | "title2" | "title3"
  | "body" | "bodyStrong" | "callout"
  | "subhead" | "subheadStrong" | "footnote"
  | "caption" | "overline" | "badge" | "timeMono";

export const type: Record<TypeToken, TextStyle> = {
  display: { fontSize: 28, fontWeight: "700", lineHeight: 34, letterSpacing: -0.5 },
  title1: { fontSize: 22, fontWeight: "600", lineHeight: 28, letterSpacing: -0.3 },
  title2: { fontSize: 18, fontWeight: "600", lineHeight: 24, letterSpacing: -0.1 },
  title3: { fontSize: 17, fontWeight: "600", lineHeight: 22 },
  body: { fontSize: 16, fontWeight: "400", lineHeight: 22 },
  bodyStrong: { fontSize: 16, fontWeight: "600", lineHeight: 22 },
  callout: { fontSize: 15, fontWeight: "400", lineHeight: 20 },
  subhead: { fontSize: 14, fontWeight: "500", lineHeight: 19 },
  subheadStrong: { fontSize: 14, fontWeight: "600", lineHeight: 19 },
  footnote: { fontSize: 13, fontWeight: "400", lineHeight: 18 },
  caption: { fontSize: 12, fontWeight: "500", lineHeight: 16, letterSpacing: 0.1 },
  overline: { fontSize: 11, fontWeight: "700", lineHeight: 14, letterSpacing: 1.2 },
  badge: { fontSize: 12, fontWeight: "700", lineHeight: 15, letterSpacing: 0.5 },
  timeMono: { fontSize: 15, fontWeight: "600", lineHeight: 20, fontVariant: ["tabular-nums"] }
};

/**
 * Cards get a 1px border, not a shadow — the newer web stylesheet layer already prefers that,
 * and it is why dark mode needs no shadow substitute. Elevation is reserved for the three
 * surfaces that genuinely float: the pinned action bar, sheets, and the tab bar.
 */
export const elevation = {
  bar: Platform.select({
    ios: {
      shadowColor: "#202522",
      shadowOpacity: 0.1,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: -2 }
    },
    default: { elevation: 8 }
  }),
  sheet: Platform.select({
    ios: {
      shadowColor: "#202522",
      shadowOpacity: 0.18,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: -4 }
    },
    default: { elevation: 16 }
  })
} as const;

export interface GroomerSlotColors {
  accent: string;
  tint: string;
}

/**
 * Groomer identity colours, assigned by `groomerSlotIndex()` so a groomer keeps the same colour
 * on web and on a phone.
 *
 * These are never a text colour: #a96e4c measures 4.18:1 on white and fails AA. They are spent
 * on a 4pt accent rail and a legend dot only. The tints have no dark counterpart that preserves
 * hue identity, so dark mode drops them.
 */
export const groomerSlots: readonly GroomerSlotColors[] = [
  { accent: "#492c63", tint: "#f3ecf8" },
  { accent: "#46769b", tint: "#ecf3f8" },
  { accent: "#397f7a", tint: "#ecf8f7" },
  { accent: "#a96e4c", tint: "#f8f1ec" },
  { accent: "#716033", tint: "#f8f5ec" },
  { accent: "#683253", tint: "#f4eff2" },
  { accent: "#62321d", tint: "#f3f0ee" },
  { accent: "#445386", tint: "#eff1f5" },
  { accent: "#8f4d50", tint: "#f5eff0" },
  { accent: "#005c6e", tint: "#ebf2f3" }
];

/**
 * Status pill, time gutter and tab label are layout anchors rather than content, so their scaling
 * is capped. The safety alarm deliberately has no cap.
 */
export const fontScaleCaps = { badge: 1.2, time: 1.3, tabLabel: 1.2 } as const;
