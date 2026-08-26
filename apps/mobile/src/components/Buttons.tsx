import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle
} from "react-native";
import { useTheme } from "../theme/theme";
import { radius, size, space, type } from "../theme/tokens";

/**
 * The primary action.
 *
 * 52pt rather than 44: this is operated with wet hands, one-handed, standing over a table, and it
 * is the most-tapped control in the product. While a mutation is in flight it keeps its label and
 * its width and adds an indicator, so the groomer can go on reading notes rather than watching a
 * blocking overlay.
 */
export function PrimaryButton({
  label,
  onPress,
  busy = false,
  disabled = false,
  testID
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primary,
        {
          backgroundColor: pressed ? colors.brandStrong : colors.brand,
          // Offline keeps the label and dims the control, so the groomer still knows what will
          // happen the moment signal returns.
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }]
        }
      ]}
    >
      <View style={styles.primaryInner}>
        <Text style={[styles.primaryLabel, { color: colors.onBrand }]} numberOfLines={1}>
          {label}
        </Text>
        {busy ? <ActivityIndicator color={colors.onBrand} size="small" /> : null}
      </View>
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  disabled = false,
  style,
  testID
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.secondary,
        { backgroundColor: pressed ? colors.line : colors.surface2, opacity: disabled ? 0.45 : 1 },
        style
      ]}
    >
      <Text style={[styles.secondaryLabel, { color: colors.ink }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function TextButton({
  label,
  onPress,
  tone = "brand",
  testID
}: {
  label: string;
  onPress: () => void;
  tone?: "brand" | "danger" | "warning";
  testID?: string;
}): React.ReactElement {
  const { colors } = useTheme();
  const color =
    tone === "danger" ? colors.danger : tone === "warning" ? colors.warning : colors.brandText;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={styles.text}
    >
      <Text style={[styles.textLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primary: {
    height: size.tapPrimary,
    borderRadius: radius.button,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg
  },
  primaryInner: { flexDirection: "row", alignItems: "center", gap: space.sm },
  primaryLabel: { ...type.title3 },
  secondary: {
    minHeight: size.tapSecondary,
    borderRadius: radius.button,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.md,
    paddingVertical: space.sm
  },
  secondaryLabel: { ...type.subheadStrong },
  text: { minHeight: size.tap, justifyContent: "center", paddingHorizontal: space.xs },
  textLabel: { ...type.subheadStrong }
});
