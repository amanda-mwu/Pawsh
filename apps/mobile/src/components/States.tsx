import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme/theme";
import { radius, space, type } from "../theme/tokens";
import { SecondaryButton, TextButton } from "./Buttons";

/**
 * A failed read.
 *
 * Inline, at the top of the list it belongs to, never a toast: a groomer who looks up two seconds
 * later must still be able to see what went wrong and act on it. This is the web app's
 * `.note-failure` anatomy — one sentence and a Retry — at phone scale.
 */
export function ErrorCard({
  message,
  onRetry,
  testID
}: {
  message: string;
  onRetry?: (() => void) | undefined;
  testID?: string;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <View
      testID={testID}
      accessibilityRole="alert"
      style={[styles.error, { backgroundColor: colors.dangerTint, borderColor: colors.dangerLine }]}
    >
      <Text style={[styles.errorText, { color: colors.danger }]}>{message}</Text>
      {onRetry ? <SecondaryButton label="Retry" onPress={onRetry} testID="retry" /> : null}
    </View>
  );
}

export function EmptyState({
  title,
  detail,
  actionLabel,
  onAction,
  testID
}: {
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <View testID={testID} style={styles.empty}>
      <Text style={[styles.emptyGlyph, { color: colors.line }]}>◷</Text>
      <Text style={[styles.emptyTitle, { color: colors.ink }]}>{title}</Text>
      {detail ? <Text style={[styles.emptyDetail, { color: colors.muted }]}>{detail}</Text> : null}
      {actionLabel && onAction ? <TextButton label={actionLabel} onPress={onAction} /> : null}
    </View>
  );
}

/**
 * Loading placeholders.
 *
 * No spinner and no shimmer sweep: this screen is glanced at, not watched, and a sweeping
 * highlight reads as motion in peripheral vision every time a groomer looks up.
 */
export function SkeletonCard({ widths }: { widths: readonly number[] }): React.ReactElement {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.skeleton, { backgroundColor: colors.surface, borderColor: colors.line }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {widths.map((width, index) => (
        <View
          key={index}
          style={[styles.skeletonBar, { backgroundColor: colors.surface2, width: `${width}%` }]}
        />
      ))}
    </View>
  );
}

export function SkeletonList({ testID }: { testID?: string }): React.ReactElement {
  return (
    <View testID={testID} style={styles.skeletonList}>
      <SkeletonCard widths={[60, 40, 80]} />
      <SkeletonCard widths={[40, 80, 60]} />
      <SkeletonCard widths={[80, 60, 40]} />
    </View>
  );
}

const styles = StyleSheet.create({
  error: {
    borderWidth: 1,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.md
  },
  errorText: { ...type.body },
  empty: { alignItems: "center", gap: space.sm, paddingVertical: space.xxl * 2 },
  emptyGlyph: { fontSize: 32, lineHeight: 38 },
  emptyTitle: { ...type.title3 },
  emptyDetail: { ...type.footnote },
  skeletonList: { gap: space.md },
  skeleton: {
    borderWidth: 1,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.md,
    minHeight: 104,
    justifyContent: "center"
  },
  skeletonBar: { height: 12, borderRadius: radius.chip }
});
