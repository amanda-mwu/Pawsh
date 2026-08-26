import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { AppointmentBadge } from "@pawsh/domain";
import { badgeFill, useTheme } from "../theme/theme";
import { fontScaleCaps, radius, type } from "../theme/tokens";

/**
 * The status pill.
 *
 * Three redundant signals carry status, and colour is only the second of them: the pill spells
 * out the label, the fill repeats it, and the card's own treatment repeats it again. Nothing in
 * this product is communicated by colour alone.
 *
 * A `null` badge renders nothing at all. There is no grey "Unknown" fallback, because that would
 * assert a state the API cannot back.
 */
export function StatusBadgePill({
  badge,
  compact = false
}: {
  badge: AppointmentBadge | null;
  compact?: boolean;
}): React.ReactElement | null {
  const { colors } = useTheme();
  if (!badge) return null;
  return (
    <View
      style={[styles.pill, { backgroundColor: badgeFill(colors, badge.variant) }]}
      accessibilityLabel={badge.label}
    >
      <Text
        style={[styles.label, { color: colors.onBrand }]}
        maxFontSizeMultiplier={fontScaleCaps.badge}
        numberOfLines={1}
      >
        {compact ? badge.code : badge.label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: radius.pill,
    paddingVertical: 3,
    paddingHorizontal: 9,
    alignSelf: "flex-start"
  },
  label: { ...type.badge }
});
