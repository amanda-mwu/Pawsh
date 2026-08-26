import React from "react";
import {
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/theme";
import { radius, space, type } from "../theme/tokens";

/**
 * A sticky screen header.
 *
 * Insets are applied to sticky chrome only. Wrapping a scroller in `SafeAreaView` kills
 * edge-to-edge scrolling and leaves a dead band at the bottom of every list.
 */
export function ScreenHeader({
  title,
  subtitle,
  right
}: {
  title: string;
  subtitle?: string | null;
  right?: React.ReactNode;
}): React.ReactElement {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  return (
    <View
      style={[
        styles.header,
        { paddingTop: insets.top, backgroundColor: colors.surface, borderBottomColor: colors.line }
      ]}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right}
      </View>
    </View>
  );
}

/**
 * The sync dot.
 *
 * Silence is the reward for being connected and current: there is no indicator at all in that
 * state. Anything else is a 6pt dot, never a spinner over the content.
 */
export function SyncDot({
  state
}: {
  state: "live" | "syncing" | "offline" | "pending" | "failed";
}): React.ReactElement | null {
  const { colors } = useTheme();
  if (state === "live") return null;
  const color =
    state === "syncing"
      ? colors.brandText
      : state === "failed"
        ? colors.danger
        : colors.warning;
  return (
    <View
      testID={`sync-${state}`}
      accessibilityLabel={`Sync status: ${state}`}
      style={[styles.dot, { backgroundColor: color }]}
    />
  );
}

export function Section({
  label,
  children,
  style
}: {
  label?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <View
      style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.line }, style]}
    >
      {label ? (
        <Text style={[styles.sectionLabel, { color: colors.muted }]}>{label.toUpperCase()}</Text>
      ) : null}
      {children}
    </View>
  );
}

/**
 * A labelled value.
 *
 * Two columns above 375pt and stacked below, so a long service list never squeezes its label into
 * a vertical stack of single characters.
 */
export function Field({
  label,
  value,
  wide = false
}: {
  label: string;
  value: React.ReactNode;
  /** Force the stacked form regardless of width, for a value that needs the whole line. */
  wide?: boolean;
}): React.ReactElement {
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  // Below 375pt a 96pt label column leaves too little for the value; stacking keeps both legible.
  const stacked = wide || width < 375;
  return (
    <View style={stacked ? styles.fieldStacked : styles.field}>
      <Text
        style={[styles.fieldLabel, { color: colors.muted }, stacked ? styles.fieldLabelFull : null]}
      >
        {label.toUpperCase()}
      </Text>
      <View style={styles.fieldValue}>
        {typeof value === "string" ? (
          <Text style={[styles.fieldText, { color: colors.ink }]}>{value}</Text>
        ) : (
          value
        )}
      </View>
    </View>
  );
}

/**
 * A care note block.
 *
 * Always expanded, never behind a "show more". These are things a groomer must have read, and a
 * disclosure triangle is an invitation not to.
 */
export function CareBlock({
  label,
  text,
  emptyText
}: {
  label: string;
  text: string | null;
  emptyText?: string;
}): React.ReactElement | null {
  const { colors } = useTheme();
  if (!text && !emptyText) return null;
  return (
    <View style={styles.care}>
      <Text style={[styles.fieldLabel, { color: colors.muted }]}>{label.toUpperCase()}</Text>
      <Text style={[styles.fieldText, { color: text ? colors.ink : colors.muted }]}>
        {text ?? emptyText}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { borderBottomWidth: StyleSheet.hairlineWidth },
  headerRow: {
    minHeight: 44,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md
  },
  headerText: { flexShrink: 1 },
  title: { ...type.display },
  subtitle: { ...type.subhead },
  dot: { width: 6, height: 6, borderRadius: 3 },
  section: {
    borderWidth: 1,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.md
  },
  sectionLabel: { ...type.overline },
  field: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  fieldStacked: { gap: space.xs },
  fieldLabel: { ...type.overline, width: 96 },
  fieldLabelFull: { width: "auto" },
  fieldValue: { flex: 1 },
  fieldText: { ...type.body },
  care: { gap: space.xs }
});
