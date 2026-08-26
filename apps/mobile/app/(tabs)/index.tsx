import React, { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { messageFor } from "../../src/api/errors";
import { useAuth } from "../../src/auth/AuthProvider";
import { AppointmentCard } from "../../src/components/AppointmentCard";
import { PrimaryButton, TextButton } from "../../src/components/Buttons";
import { ScreenHeader, SyncDot } from "../../src/components/Layout";
import { OfflineBanner } from "../../src/components/OfflineBanner";
import { EmptyState, ErrorCard, SkeletonList } from "../../src/components/States";
import {
  findNowAppointment,
  isAssignedTo,
  isTerminal,
  type AppointmentView
} from "../../src/features/appointments/model";
import { planPrimaryAction, useAppointmentTransition } from "../../src/features/appointments/transition";
import { useDayView } from "../../src/features/appointments/useDay";
import { deviceLocalDate, formatDeviceTime, formatShortDate } from "../../src/features/appointments/time";
import { useConnectivity } from "../../src/net/connectivity";
import { useDrafts } from "../../src/offline/DraftProvider";
import { unsentCount } from "../../src/offline/drafts";
import { resolveMyEmployeeId, useEmployees } from "../../src/query/hooks";
import { useTheme } from "../../src/theme/theme";
import { radius, space, type } from "../../src/theme/tokens";

type Scope = "mine" | "all";

/**
 * Today.
 *
 * The screen a groomer opens twenty times a shift, so it earns the most attention: one
 * chronological list, one promoted card carrying its own action so the most common tap in the
 * product needs no navigation, and finished work folded out of the way without being deleted.
 */
export default function TodayScreen(): React.ReactElement {
  const { me, allowed } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { online } = useConnectivity();
  const { drafts } = useDrafts();
  // Today asks for the location's own current day by omitting the date. The header prints the
  // device's date, which is the same day for a groomer standing in the salon.
  const day = useDayView(null, Boolean(me));
  const employees = useEmployees(Boolean(me));
  const myEmployeeId = resolveMyEmployeeId(employees.data, me?.membershipId);
  const [scope, setScope] = useState<Scope>("mine");
  const [showFinished, setShowFinished] = useState(false);

  // Scope filters the day already in hand rather than refetching it: one request serves both
  // views, and switching is instant on a phone that may be on one bar of signal.
  const scoped = useMemo(() => {
    if (!myEmployeeId || scope === "all") return day.views;
    return day.views.filter((view) => isAssignedTo(view, myEmployeeId));
  }, [day.views, myEmployeeId, scope]);

  const active = scoped.filter((view) => !isTerminal(view.status));
  const finished = scoped.filter((view) => isTerminal(view.status));
  const now = findNowAppointment(active);
  const rest = active.filter((view) => view.id !== now?.id);

  const pending = unsentCount(drafts);
  const failed = drafts.some((draft) => draft.state === "failed");
  const syncState = !online
    ? "offline"
    : failed
      ? "failed"
      : pending > 0
        ? "pending"
        : day.query.isFetching
          ? "syncing"
          : "live";

  const openAppointment = useCallback(
    (view: AppointmentView) => router.push(`/appointment/${view.id}`),
    [router]
  );

  const showingCachedOffline = !online && day.views.length > 0;
  const locationName = me?.business?.locationName ?? null;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <ScreenHeader
        title="Today"
        subtitle={[formatShortDate(deviceLocalDate()), locationName].filter(Boolean).join(" · ")}
        right={<SyncDot state={syncState} />}
      />

      {myEmployeeId ? (
        <View style={[styles.scopeRow, { borderBottomColor: colors.line, backgroundColor: colors.surface }]}>
          <ScopeSegment value={scope} onChange={setScope} />
        </View>
      ) : null}

      {showingCachedOffline ? (
        <OfflineBanner
          lastSyncedLabel={day.lastSyncedAt ? formatDeviceTime(new Date(day.lastSyncedAt)) : null}
          onRetry={() => void day.query.refetch()}
        />
      ) : null}

      <ScrollView
        testID="today-list"
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
            testID="today-error"
            message={
              day.query.data
                ? messageFor(day.query.error)
                : "Today's schedule could not be loaded."
            }
            onRetry={() => void day.query.refetch()}
          />
        ) : null}

        {day.query.isPending ? <SkeletonList testID="today-loading" /> : null}

        {!day.query.isPending && !scoped.length && !day.query.isError ? (
          myEmployeeId && scope === "mine" && day.views.length > 0 ? (
            <EmptyState
              testID="today-empty-filtered"
              title="Nothing assigned to you today."
              detail="Other groomers have appointments booked."
              actionLabel="Show all groomers"
              onAction={() => setScope("all")}
            />
          ) : (
            <EmptyState
              testID="today-empty"
              title="No appointments today."
              detail="Your schedule is clear."
              actionLabel={allowed("calendar.view") ? "View calendar" : undefined}
              onAction={allowed("calendar.view") ? () => router.push("/calendar") : undefined}
            />
          )
        ) : null}

        {now ? (
          <NowCard view={now} onOpen={() => openAppointment(now)} showGroomer={scope === "all"} />
        ) : null}

        {rest.map((view) => (
          <AppointmentCard
            key={view.id}
            testID={`appointment-${view.id}`}
            view={view}
            showGroomer={scope === "all"}
            onPress={() => openAppointment(view)}
          />
        ))}

        {finished.length ? (
          <View style={styles.finished}>
            <Pressable
              testID="finished-toggle"
              accessibilityRole="button"
              accessibilityState={{ expanded: showFinished }}
              onPress={() => setShowFinished((value) => !value)}
              style={styles.finishedHeader}
            >
              <Text style={[styles.finishedLabel, { color: colors.muted }]}>
                Finished ({finished.length})
              </Text>
              <Text style={[styles.finishedLabel, { color: colors.muted }]}>
                {showFinished ? "▲" : "▼"}
              </Text>
            </Pressable>
            {showFinished
              ? finished.map((view) => (
                  <AppointmentCard
                    key={view.id}
                    testID={`appointment-${view.id}`}
                    view={view}
                    showGroomer={scope === "all"}
                    onPress={() => openAppointment(view)}
                  />
                ))
              : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * The promoted card: whatever is on the table, or the next thing that is not.
 *
 * It carries the primary action inline, which is the whole reason it exists — the most common tap
 * on the busiest screen in the product should not cost a navigation.
 */
function NowCard({
  view,
  onOpen,
  showGroomer
}: {
  view: AppointmentView;
  onOpen: () => void;
  showGroomer: boolean;
}): React.ReactElement {
  const { allowed } = useAuth();
  const { colors } = useTheme();
  const { online } = useConnectivity();
  const { state, run, dismissError } = useAppointmentTransition(view);
  const plan = planPrimaryAction(view, allowed);

  return (
    <AppointmentCard
      testID={`now-card-${view.id}`}
      view={view}
      promoted
      showGroomer={showGroomer}
      onPress={onOpen}
      footer={
        plan && plan.available ? (
          <View style={styles.nowAction}>
            <PrimaryButton
              testID="now-primary"
              label={plan.label}
              busy={state.busy}
              // Status changes are never queued offline; the label stays so the groomer knows
              // what will happen the moment signal returns.
              disabled={!online}
              onPress={() => {
                if (plan.target) void run(plan.target);
              }}
            />
            {!online ? (
              <Text style={[styles.offlineNote, { color: colors.warning }]}>
                Offline — reconnect to {plan.label.toLowerCase()}.
              </Text>
            ) : null}
            {state.error ? (
              <View style={styles.nowError}>
                <Text style={[styles.offlineNote, { color: colors.danger }]}>{state.error}</Text>
                <TextButton label="Dismiss" onPress={dismissError} />
              </View>
            ) : null}
          </View>
        ) : null
      }
    />
  );
}

function ScopeSegment({
  value,
  onChange
}: {
  value: Scope;
  onChange: (next: Scope) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <View style={[styles.segment, { backgroundColor: colors.surface2 }]}>
      {(["mine", "all"] as const).map((option) => (
        <Pressable
          key={option}
          testID={`scope-${option}`}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === option }}
          onPress={() => onChange(option)}
          style={[
            styles.segmentItem,
            value === option ? { backgroundColor: colors.surface } : null
          ]}
        >
          <Text
            style={[
              styles.segmentLabel,
              { color: value === option ? colors.ink : colors.muted }
            ]}
          >
            {option === "mine" ? "Mine" : "All"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scopeRow: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  segment: { flexDirection: "row", borderRadius: radius.chip, padding: 2, height: 32 },
  segmentItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.chip
  },
  segmentLabel: { ...type.caption },
  list: { padding: space.lg, gap: space.md },
  nowAction: { gap: space.sm, marginTop: space.xs },
  nowError: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  offlineNote: { ...type.footnote, flexShrink: 1 },
  finished: { gap: space.md, marginTop: space.sm },
  finishedHeader: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  finishedLabel: { ...type.subheadStrong }
});
