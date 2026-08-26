import React, { useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { messageFor } from "../../src/api/errors";
import { useAuth } from "../../src/auth/AuthProvider";
import { AppointmentCard } from "../../src/components/AppointmentCard";
import { ScreenHeader } from "../../src/components/Layout";
import { OfflineBanner } from "../../src/components/OfflineBanner";
import { EmptyState, ErrorCard, SkeletonList } from "../../src/components/States";
import {
  deviceLocalDate,
  formatDeviceTime,
  formatShortDate,
  shiftDate
} from "../../src/features/appointments/time";
import { useDayView } from "../../src/features/appointments/useDay";
import { useConnectivity } from "../../src/net/connectivity";
import { useTheme } from "../../src/theme/theme";
import { radius, size, space, type } from "../../src/theme/tokens";

/**
 * Calendar.
 *
 * A chronological day list, permanently. The web app's day grid is `64px + repeat(N, minmax(190px,
 * 1fr))` — four groomers is 824pt of content on a 375pt screen — and two-axis grids and drag
 * targets are mouse affordances. The product already ships the answer in its narrow-viewport
 * agenda fallback; this is that, at full width.
 */
export default function CalendarScreen(): React.ReactElement {
  const { me } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { online } = useConnectivity();
  const today = deviceLocalDate();
  const [date, setDate] = useState(today);
  const day = useDayView(date, Boolean(me));

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <ScreenHeader
        title="Calendar"
        subtitle={me?.business?.locationName ?? null}
        right={
          date === today ? null : (
            <Pressable
              testID="jump-today"
              accessibilityRole="button"
              onPress={() => setDate(today)}
              style={[styles.todayPill, { borderColor: colors.brand }]}
            >
              <Text style={[styles.todayLabel, { color: colors.brandText }]}>Today</Text>
            </Pressable>
          )
        }
      />

      <View
        style={[styles.dateNav, { backgroundColor: colors.surface, borderBottomColor: colors.line }]}
      >
        <Pressable
          testID="prev-day"
          accessibilityRole="button"
          accessibilityLabel="Previous day"
          onPress={() => setDate((current) => shiftDate(current, -1))}
          style={styles.chevronButton}
        >
          <Text style={[styles.chevron, { color: colors.brandText }]}>‹</Text>
        </Pressable>
        <Text style={[styles.dateLabel, { color: colors.ink }]}>{formatShortDate(date)}</Text>
        <Pressable
          testID="next-day"
          accessibilityRole="button"
          accessibilityLabel="Next day"
          onPress={() => setDate((current) => shiftDate(current, 1))}
          style={styles.chevronButton}
        >
          <Text style={[styles.chevron, { color: colors.brandText }]}>›</Text>
        </Pressable>
      </View>

      {!online && day.views.length ? (
        <OfflineBanner
          lastSyncedLabel={day.lastSyncedAt ? formatDeviceTime(new Date(day.lastSyncedAt)) : null}
          onRetry={() => void day.query.refetch()}
        />
      ) : null}

      <ScrollView
        testID="calendar-list"
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space.xxl }]}
        refreshControl={
          <RefreshControl
            refreshing={day.query.isRefetching}
            onRefresh={() => void day.query.refetch()}
            tintColor={colors.brandText}
            colors={[colors.brandText]}
          />
        }
      >
        {day.query.isError ? (
          <ErrorCard
            testID="calendar-error"
            message={messageFor(day.query.error)}
            onRetry={() => void day.query.refetch()}
          />
        ) : null}

        {day.query.isPending ? <SkeletonList /> : null}

        {!day.query.isPending && !day.query.isError && !day.views.length ? (
          <EmptyState testID="calendar-empty" title="No appointments in this period." />
        ) : null}

        {day.views.map((view) => (
          <AppointmentCard
            key={view.id}
            testID={`appointment-${view.id}`}
            view={view}
            onPress={() => router.push(`/appointment/${view.id}`)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  dateNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  chevronButton: {
    width: size.iconBtn,
    height: size.iconBtn,
    alignItems: "center",
    justifyContent: "center"
  },
  chevron: { fontSize: 26, lineHeight: 30 },
  dateLabel: { ...type.title2 },
  todayPill: {
    minHeight: 32,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    justifyContent: "center"
  },
  todayLabel: { ...type.caption },
  list: { padding: space.lg, gap: space.md }
});
