import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { space, type } from "../theme/tokens";
import type { CareVisibility } from "../features/appointments/model";

export type SafetyState =
  /** The pet has a safety alert and it is the text below. */
  | { kind: "alert"; text: string }
  /** Care data has not arrived yet. The slot is held so nothing empty later turns red. */
  | { kind: "loading" }
  /** The care request failed. Silence here is the one failure that can hurt an animal. */
  | { kind: "unavailable" }
  /** The reader is not permitted to see care notes. */
  | { kind: "withheld" }
  /** Care data arrived and there is no alert. Absence is asserted, never inferred. */
  | { kind: "clear" };

export function resolveSafetyState(input: {
  care: CareVisibility;
  loading?: boolean;
  failed?: boolean;
  safetyAlerts: string | null;
}): SafetyState {
  if (input.care === "withheld") return { kind: "withheld" };
  if (input.failed) return { kind: "unavailable" };
  if (input.loading) return { kind: "loading" };
  if (input.safetyAlerts) return { kind: "alert", text: input.safetyAlerts };
  return { kind: "clear" };
}

/**
 * The alarm block.
 *
 * Only `safetyAlerts` is an alarm. Behaviour, medical and grooming notes are things a groomer
 * must have read; a safety alert is something they must act on before touching the dog. The web
 * app arrived at that rule by first colouring all four red and discovering that four red boxes
 * make zero red boxes, and this is the single most important thing the phone inherits.
 *
 * It has no close control, does not collapse, does not swipe away, and does not hide on scroll.
 * It is not a notification.
 */
export function SafetyAlarm({
  state,
  bleed = 0,
  lines,
  onRetry
}: {
  state: SafetyState;
  /** Negative horizontal margin, so the block reads as a band across a card, not a nested box. */
  bleed?: number;
  /** Two on a card, unset on a detail screen, where the alarm is never clipped. */
  lines?: number;
  onRetry?: (() => void) | undefined;
}): React.ReactElement | null {
  const { colors } = useTheme();
  const margin = bleed ? { marginHorizontal: -bleed } : null;

  if (state.kind === "clear") {
    return (
      <View style={[styles.quiet, margin]}>
        <Text style={[styles.quietText, { color: colors.muted }]}>
          ✓ No safety alerts on file.
        </Text>
      </View>
    );
  }

  if (state.kind === "loading") {
    return (
      <View style={[styles.quiet, styles.holding, { backgroundColor: colors.surface2 }, margin]}>
        <Text style={[styles.quietText, { color: colors.muted }]}>Checking notes…</Text>
      </View>
    );
  }

  if (state.kind === "withheld") {
    return (
      <View style={[styles.quiet, margin]}>
        <Text style={[styles.quietText, { color: colors.muted }]}>
          Care notes not visible with your access.
        </Text>
      </View>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <View
        style={[
          styles.alarm,
          { backgroundColor: colors.warningTint, borderLeftColor: colors.warning },
          margin
        ]}
      >
        <Text style={[styles.glyph, { color: colors.warning }]}>⚠</Text>
        <View style={styles.body}>
          <Text
            style={[styles.text, { color: colors.warning }]}
            onPress={onRetry}
            accessibilityRole={onRetry ? "button" : undefined}
            suppressHighlighting
          >
            Safety info unavailable{onRetry ? " — tap to retry" : ""}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.alarm,
        { backgroundColor: colors.dangerTint, borderLeftColor: colors.danger },
        margin
      ]}
      accessible
      accessibilityLabel={`Safety alert. ${state.text}`}
    >
      <Text style={[styles.glyph, { color: colors.danger }]}>⚠</Text>
      <View style={styles.body}>
        <Text style={[styles.label, { color: colors.danger }]}>SAFETY ALERT</Text>
        <Text style={[styles.text, { color: colors.danger }]} numberOfLines={lines}>
          {state.text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  alarm: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    minHeight: 44,
    paddingVertical: space.md - 2,
    paddingRight: space.md,
    // 9 plus the 3pt bar reads as 12 optically.
    paddingLeft: space.md - 3,
    borderLeftWidth: 3
  },
  body: { flex: 1 },
  glyph: { fontSize: 18, lineHeight: 22, marginTop: 1 },
  label: { ...type.overline, textTransform: "uppercase" },
  text: { ...type.subhead },
  quiet: { paddingVertical: space.sm, minHeight: 32, justifyContent: "center" },
  holding: { minHeight: 44, paddingHorizontal: space.md, justifyContent: "center" },
  quietText: { ...type.footnote }
});
