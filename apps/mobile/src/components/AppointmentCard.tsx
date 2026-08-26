import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { elevation, fontScaleCaps, groomerSlots, radius, size, space, type } from "../theme/tokens";
import type { AppointmentView } from "../features/appointments/model";
import { isTerminal } from "../features/appointments/model";
import { StatusBadgePill } from "./Badge";
import { ChipRow, NoteChip } from "./Chips";
import { resolveSafetyState, SafetyAlarm } from "./SafetyAlarm";

const CARD_PAD = space.lg;

/**
 * Screen-reader order puts safety first, which deliberately diverges from the web app's
 * accessible name: that one carries no safety information at all and puts status last.
 */
function accessibleName(view: AppointmentView, careFailed: boolean): string {
  const parts: string[] = [];
  if (view.care === "visible" && view.safetyAlerts) parts.push(`Safety alert. ${view.safetyAlerts}.`);
  if (careFailed) parts.push("Safety information unavailable.");
  parts.push(view.timeRange, view.petName);
  if (view.breed) parts.push(view.breed);
  parts.push(view.customerName);
  if (view.badge) parts.push(view.badge.label);
  return parts.filter(Boolean).join(", ");
}

/**
 * One appointment.
 *
 * The web app tints the whole card body with the groomer's colour. That is not ported: on a phone
 * the card is the full width of the screen, so a vertical list of tinted cards reads as a list of
 * alert levels and the safety alarm loses the only thing that made it stand out. Identity moves
 * to a 4pt accent rail plus the groomer's name, which also works in dark mode, where none of the
 * five tints have a counterpart.
 */
export function AppointmentCard({
  view,
  onPress,
  showGroomer = true,
  promoted = false,
  careLoading = false,
  careFailed = false,
  onRetryCare,
  footer,
  testID
}: {
  view: AppointmentView;
  onPress: () => void;
  showGroomer?: boolean;
  /** The "now" card: elevated, brand-bordered, and carrying its own primary action. */
  promoted?: boolean;
  careLoading?: boolean;
  careFailed?: boolean;
  onRetryCare?: (() => void) | undefined;
  footer?: React.ReactNode;
  testID?: string;
}): React.ReactElement {
  const { colors } = useTheme();
  const terminal = isTerminal(view.status) && view.status !== "completed";
  const slot = view.groomerSlot === null ? null : groomerSlots[view.groomerSlot];
  const rail = slot ? slot.accent : colors.line;
  const safety = resolveSafetyState({
    care: view.care,
    loading: careLoading,
    failed: careFailed,
    safetyAlerts: view.safetyAlerts
  });

  const chips: React.ReactNode[] = [];
  if (view.rabiesNeeded) chips.push(<NoteChip key="rabies" label="Rabies needed" tone="danger" />);
  if (view.care === "visible" && !careFailed) {
    if (view.behaviorNotes) chips.push(<NoteChip key="behavior" label="Behavior" />);
    if (view.medicalNotes) chips.push(<NoteChip key="medical" label="Medical" />);
  }
  if (careFailed) {
    chips.push(<NoteChip key="care" label="Safety info unavailable" tone="warning" />);
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibleName(view, careFailed)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: pressed ? colors.surface2 : colors.surface,
          borderColor: promoted ? colors.brand : colors.line
        },
        // `in_service` is the one card with a top border, so the dog currently on the table is
        // findable without reading anything.
        view.status === "in_service" ? { borderTopWidth: 2, borderTopColor: colors.warning } : null,
        promoted ? elevation.bar : null,
        terminal ? styles.terminal : null
      ]}
    >
      <View style={[styles.rail, { backgroundColor: rail }]} />
      <View style={[styles.body, terminal ? { opacity: 0.55 } : null]}>
        <View style={styles.headRow}>
          <Text
            style={[styles.time, { color: colors.ink }, terminal ? styles.struck : null]}
            maxFontSizeMultiplier={fontScaleCaps.time}
          >
            {view.timeRange}
          </Text>
          <View style={styles.headTail}>
            <StatusBadgePill badge={view.badge} />
            <Text style={[styles.duration, { color: colors.muted }]}>{view.durationMinutes}m</Text>
          </View>
        </View>

        <View style={styles.identity}>
          <Text style={[styles.pet, { color: colors.ink }]} numberOfLines={1}>
            {view.petName}
          </Text>
          {view.breed ? (
            <Text style={[styles.breed, { color: colors.muted }]} numberOfLines={1}>
              ({view.breed})
            </Text>
          ) : null}
        </View>

        {terminal ? null : (
          <SafetyAlarm state={safety} bleed={CARD_PAD} lines={2} onRetry={onRetryCare} />
        )}

        {view.services.primary ? (
          <Text style={[styles.services, { color: colors.ink }]} numberOfLines={2}>
            {view.services.primary}
            {view.services.addOns.length ? (
              <Text style={{ color: colors.muted }}>
                {" · "}
                {view.services.addOns.slice(0, 2).join(" · ")}
                {view.services.addOns.length > 2 ? ` +${view.services.addOns.length - 2}` : ""}
              </Text>
            ) : null}
          </Text>
        ) : null}

        <Text style={[styles.meta, { color: colors.muted }]} numberOfLines={1}>
          {view.customerName}
          {showGroomer && view.groomerName ? ` · ${view.groomerName}` : ""}
        </Text>

        {view.conflictOverridden ? (
          <Text style={[styles.overlap, { color: colors.warning }]}>Intentional overlap</Text>
        ) : null}

        {terminal || !chips.length ? null : <ChipRow>{chips}</ChipRow>}

        {footer}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: radius.card,
    overflow: "hidden"
  },
  terminal: { minHeight: 56 },
  rail: { width: size.rail },
  body: { flex: 1, padding: CARD_PAD, gap: space.sm },
  headRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  headTail: { flexDirection: "row", alignItems: "center", gap: space.sm },
  time: { ...type.timeMono, flexShrink: 1 },
  struck: { textDecorationLine: "line-through" },
  duration: { ...type.caption },
  identity: { flexDirection: "row", alignItems: "baseline", gap: space.xs },
  pet: { ...type.title3, flexShrink: 0 },
  breed: { ...type.caption, flexShrink: 1 },
  services: { ...type.callout },
  meta: { ...type.subhead },
  overlap: { ...type.caption }
});
