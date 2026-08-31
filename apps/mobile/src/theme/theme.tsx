import React, { createContext, useContext, useMemo } from "react";
import { useColorScheme } from "react-native";
import type { AppointmentStatus, PaymentBadgeVariant } from "@pawsh/domain";
import { darkPalette, lightPalette, type Palette } from "./tokens";

export interface Theme {
  colors: Palette;
  scheme: "light" | "dark";
}

const ThemeContext = createContext<Theme>({ colors: lightPalette, scheme: "light" });

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const value = useMemo<Theme>(
    () => ({ scheme, colors: scheme === "dark" ? darkPalette : lightPalette }),
    [scheme]
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * The only place a status colour is decided.
 *
 * Payment badges are keyed separately because an invoice replaces the lifecycle badge entirely;
 * see `resolveAppointmentBadge()` in the shared domain.
 */
const statusFills: Record<AppointmentStatus | PaymentBadgeVariant, keyof Palette> = {
  scheduled: "ink",
  checked_in: "info",
  in_service: "warning",
  completed: "success",
  cancelled: "dangerFill",
  no_show: "dangerFill",
  paid: "success",
  unpaid: "warning",
  // Refunds are not a failure and not a success. They read as information, in the same slot the
  // lifecycle badge would have used, rather than borrowing the green that means money was kept.
  partially_refunded: "info",
  refunded: "info"
};

export function badgeFill(colors: Palette, variant: AppointmentStatus | PaymentBadgeVariant): string {
  return colors[statusFills[variant]];
}
