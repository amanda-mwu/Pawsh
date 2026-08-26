import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { radius, space, type } from "../theme/tokens";

/**
 * A note chip.
 *
 * Behaviour and medical notes are deliberately neutral. Only the rabies chip is red, and it is
 * carried over from the web app's `.rabies-needed` unchanged apart from raising the font size
 * from 11 to 12.
 */
export function NoteChip({
  label,
  tone = "neutral"
}: {
  label: string;
  tone?: "neutral" | "danger" | "warning";
}): React.ReactElement {
  const { colors } = useTheme();
  const palette =
    tone === "danger"
      ? { bg: colors.dangerTint, border: colors.danger, text: colors.danger }
      : tone === "warning"
        ? { bg: colors.warningTint, border: colors.warning, text: colors.warning }
        : { bg: colors.surface2, border: colors.line, text: colors.ink };
  return (
    <View
      style={[styles.chip, { backgroundColor: palette.bg, borderColor: palette.border }]}
    >
      <Text style={[styles.label, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

export function ChipRow({ children }: { children: React.ReactNode }): React.ReactElement {
  return <View style={styles.row}>{children}</View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { borderWidth: 1, borderRadius: radius.pill, paddingVertical: 3, paddingHorizontal: 9 },
  label: { ...type.caption }
});
