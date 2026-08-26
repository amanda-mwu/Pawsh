import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { space, type } from "../theme/tokens";
import { TextButton } from "./Buttons";

/**
 * The offline banner.
 *
 * It pushes content down; it never overlays a card, because an overlay that covers a safety alarm
 * is not acceptable. Cached data stays visible behind it — a groomer with a nine-hour-old
 * schedule can still work, and one staring at a loading indicator cannot.
 */
export function OfflineBanner({
  lastSyncedLabel,
  onRetry
}: {
  lastSyncedLabel: string | null;
  onRetry: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <View
      testID="offline-banner"
      accessibilityRole="alert"
      style={[styles.banner, { backgroundColor: colors.warningTint, borderBottomColor: colors.line }]}
    >
      <Text style={[styles.text, { color: colors.warning }]} numberOfLines={2}>
        {lastSyncedLabel
          ? `Offline · showing your last sync at ${lastSyncedLabel}`
          : "Offline · showing cached data"}
      </Text>
      <TextButton label="Retry" tone="warning" onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 36,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm
  },
  text: { ...type.subheadStrong, flexShrink: 1 }
});
