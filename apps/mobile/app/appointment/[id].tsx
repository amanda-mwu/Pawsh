import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  appointmentTerminalActions,
  permissionForTransition,
  type CalendarAppointment
} from "@pawsh/domain";
import { messageFor } from "../../src/api/errors";
import { useAuth } from "../../src/auth/AuthProvider";
import { StatusBadgePill } from "../../src/components/Badge";
import { PrimaryButton, SecondaryButton, TextButton } from "../../src/components/Buttons";
import { CareBlock, Field, Section } from "../../src/components/Layout";
import { NoteChip } from "../../src/components/Chips";
import { resolveSafetyState, SafetyAlarm } from "../../src/components/SafetyAlarm";
import { ErrorCard, SkeletonList } from "../../src/components/States";
import { NoteSheet } from "../../src/components/NoteSheet";
import { categoryLookup, toAppointmentView, type AppointmentView } from "../../src/features/appointments/model";
import { planPrimaryAction, useAppointmentTransition } from "../../src/features/appointments/transition";
import { useConnectivity } from "../../src/net/connectivity";
import { useDrafts } from "../../src/offline/DraftProvider";
import { useAppointment, useServices } from "../../src/query/hooks";
import { queryKeys } from "../../src/query/keys";
import { elevation, radius, size, space, type } from "../../src/theme/tokens";
import { useTheme } from "../../src/theme/theme";

/**
 * Appointment detail.
 *
 * Safety at the top, a pinned action zone at the bottom, and everything a groomer reads mid-groom
 * in between. The tab bar is hidden here on purpose: the bottom edge belongs to the work.
 */
export default function AppointmentScreen(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const appointmentId = String(id ?? "");
  const { me, allowed } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { online } = useConnectivity();
  const { queueOperationalNotes, draftFor, retry, discard } = useDrafts();

  const query = useAppointment(appointmentId, Boolean(me) && Boolean(appointmentId));
  const services = useServices(Boolean(me));
  const categoryOf = useMemo(() => categoryLookup(services.data), [services.data]);
  const careVisibility = allowed("pets.care.view") ? "visible" : "withheld";

  // The list the groomer tapped from already carried this appointment, safety alert and all, so
  // the alarm renders in the first frame rather than after a fetch resolves. If a pet bites, they
  // learn it immediately. Every cached day is searched, not just today's, because the same push
  // happens from Calendar and from a client profile.
  const cached = queryClient
    .getQueriesData<CalendarAppointment[]>({ queryKey: queryKeys.appointments })
    .flatMap(([, rows]) => (Array.isArray(rows) ? rows : []))
    .find((row) => row?.id === appointmentId);
  const source = query.data ?? cached ?? null;

  const view: AppointmentView | null = useMemo(
    () =>
      source
        ? toAppointmentView(source, {
            careVisibility,
            categoryOf,
            currency: me?.business?.currency ?? "USD"
          })
        : null,
    [source, careVisibility, categoryOf, me?.business?.currency]
  );

  const [noteSheetOpen, setNoteSheetOpen] = useState(false);
  const draft = draftFor(appointmentId);
  const buzzedRef = useRef(false);

  useEffect(() => {
    // One haptic per appointment per session, and only for an alarm on a detail screen. Nothing
    // fires on list render: a buzzing scroll is a setting people turn off, and then it is gone
    // when it matters.
    if (buzzedRef.current) return;
    if (!view || view.care !== "visible" || !view.safetyAlerts) return;
    buzzedRef.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, [view]);

  const transition = useAppointmentTransition(view);
  const plan = view ? planPrimaryAction(view, allowed) : null;
  const canEditOperationalNotes =
    allowed("operations.perform_service") &&
    Boolean(view) &&
    (view?.status === "checked_in" || view?.status === "in_service");

  const confirmTerminal = useCallback(
    (status: "cancelled" | "no_show", label: string) => {
      if (!view) return;
      Alert.alert(
        `${label}?`,
        `${view.petName}'s ${view.timeRange} appointment.`,
        [
          { text: "Keep it", style: "cancel" },
          {
            text: label,
            style: "destructive",
            onPress: () => void transition.run(status)
          }
        ]
      );
    },
    [transition, view]
  );

  const terminalOptions = appointmentTerminalActions.filter(
    (action) => view && allowed(permissionForTransition(action.status))
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: view?.petName ?? "Appointment",
          headerBackTitle: "Back"
        }}
      />

      <ScrollView
        testID="appointment-detail"
        contentContainerStyle={[styles.content, { paddingBottom: 180 + insets.bottom }]}
      >
        {/* Safety comes first and stays first. A failed detail fetch must never remove an alert
            that was already on screen, which is why this block is outside the error branch. */}
        {view ? (
          <View style={[styles.alarmHost, { backgroundColor: colors.surface, borderColor: colors.line }]}>
            <SafetyAlarm
              state={resolveSafetyState({
                care: view.care,
                loading: false,
                failed: false,
                safetyAlerts: view.safetyAlerts
              })}
            />
          </View>
        ) : null}

        {view && (view.rabiesNeeded || view.rabiesLabel) ? (
          <Section>
            <View style={styles.rabiesRow}>
              {view.rabiesNeeded ? <NoteChip label="Rabies needed" tone="danger" /> : null}
              <Text style={[styles.rabiesText, { color: colors.ink }]}>
                {view.rabiesLabel}
                {view.vaccinationExpires ? ` · Expires ${view.vaccinationExpires}` : ""}
                {view.rabiesStatus === "expires_before_appointment" ? " · Update required" : ""}
              </Text>
            </View>
          </Section>
        ) : null}

        {query.isError ? (
          <ErrorCard
            testID="detail-error"
            message={messageFor(query.error)}
            onRetry={() => void query.refetch()}
          />
        ) : null}

        {!view && query.isPending ? <SkeletonList testID="detail-loading" /> : null}

        {view ? (
          <Section>
            <View style={styles.summaryHead}>
              <Text style={[styles.time, { color: colors.ink }]}>{view.timeRange}</Text>
              <StatusBadgePill badge={view.badge} />
            </View>
            <Text style={[styles.date, { color: colors.muted }]}>{view.dateLabel}</Text>
            <Field label="Client" value={view.customerName} />
            <Field
              label="Pet"
              value={view.breed ? `${view.petName} · ${view.breed}` : view.petName}
            />
            <Field label="Services" value={view.serviceNames.join(", ") || "—"} />
            <Field label="Groomer" value={view.groomerName || "—"} />
            <Text style={[styles.totals, { color: colors.ink }]}>
              {view.durationMinutes} min
              {view.totalPriceLabel ? ` · ${view.totalPriceLabel}` : ""}
            </Text>
            {view.conflictOverridden ? (
              <Text style={[styles.overlap, { color: colors.warning }]}>Intentional overlap</Text>
            ) : null}
          </Section>
        ) : null}

        {view ? (
          <Section>
            {view.care === "withheld" ? (
              <Text style={[styles.muted, { color: colors.muted }]}>
                Care notes not visible with your access.
              </Text>
            ) : (
              <>
                <CareBlock
                  label="Behavior"
                  text={view.behaviorNotes}
                  emptyText="No behavior notes on file."
                />
                <CareBlock
                  label="Medical"
                  text={view.medicalNotes}
                  emptyText="No medical notes on file."
                />
                <CareBlock label="Grooming preferences" text={view.groomingPreferences} />
                <CareBlock label="Coat notes" text={view.coatNotes} />
              </>
            )}
            <CareBlock label="Appointment note" text={view.appointmentNotes} />
          </Section>
        ) : null}

        {view ? (
          <Section label="Groomer notes">
            {draft ? (
              <UnsentNote
                text={draft.text}
                state={draft.state}
                permanent={Boolean(draft.permanent)}
                error={draft.error ?? null}
                onRetry={() => void retry(draft.id)}
                onDiscard={() => void discard(draft.id)}
              />
            ) : view.operationalNotes ? (
              <Text style={[styles.noteBody, { color: colors.ink }]}>{view.operationalNotes}</Text>
            ) : (
              <Text style={[styles.muted, { color: colors.muted }]}>
                No notes on this appointment yet.
              </Text>
            )}
            {canEditOperationalNotes ? (
              <SecondaryButton
                testID="edit-notes"
                label={view.operationalNotes || draft ? "Edit notes" : "Add notes"}
                onPress={() => setNoteSheetOpen(true)}
              />
            ) : null}
          </Section>
        ) : null}

        {view ? (
          <Section>
            <LinkRow
              testID="link-client"
              label={view.customerName}
              detail="Client profile"
              onPress={() => router.push(`/customer/${view.customerId}`)}
              disabled={!allowed("customers.view")}
            />
            <LinkRow
              testID="link-pet"
              label={view.petName}
              detail={view.breed || "Pet profile"}
              onPress={() => router.push(`/pet/${view.petId}`)}
              disabled={!allowed("pets.view")}
            />
          </Section>
        ) : null}

        {terminalOptions.length && view && (view.status === "scheduled") ? (
          <Section label="Other actions">
            {terminalOptions.map((action) => (
              <TextButton
                key={action.status}
                testID={`terminal-${action.status}`}
                tone="danger"
                label={action.label}
                onPress={() =>
                  confirmTerminal(action.status as "cancelled" | "no_show", action.label)
                }
              />
            ))}
          </Section>
        ) : null}
      </ScrollView>

      {view ? (
        <View
          testID="action-zone"
          style={[
            styles.actionZone,
            {
              backgroundColor: colors.surface,
              borderTopColor: colors.line,
              paddingBottom: space.sm + 2 + insets.bottom
            },
            elevation.bar
          ]}
        >
          {transition.state.error ? (
            <View style={styles.actionError}>
              <Text style={[styles.actionNote, { color: colors.danger }]}>
                {transition.state.error}
              </Text>
              <TextButton label="Dismiss" onPress={transition.dismissError} />
            </View>
          ) : null}

          {plan && plan.available ? (
            <>
              <PrimaryButton
                testID="primary-action"
                label={plan.label}
                busy={transition.state.busy}
                disabled={!online}
                onPress={() => {
                  if (plan.target) void transition.run(plan.target);
                }}
              />
              {!online ? (
                <Text style={[styles.actionNote, { color: colors.warning }]}>
                  Offline — reconnect to {plan.label.toLowerCase()}.
                </Text>
              ) : null}
            </>
          ) : null}

          <View style={styles.secondaryRow}>
            {canEditOperationalNotes ? (
              <SecondaryButton
                testID="secondary-notes"
                label="Notes"
                style={styles.secondaryItem}
                onPress={() => setNoteSheetOpen(true)}
              />
            ) : null}
            {allowed("customers.view") ? (
              <SecondaryButton
                testID="secondary-client"
                label="Client"
                style={styles.secondaryItem}
                onPress={() => router.push(`/customer/${view.customerId}`)}
              />
            ) : null}
            {allowed("pets.view") ? (
              <SecondaryButton
                testID="secondary-pet"
                label="Pet"
                style={styles.secondaryItem}
                onPress={() => router.push(`/pet/${view.petId}`)}
              />
            ) : null}
          </View>
        </View>
      ) : null}

      {view ? (
        <NoteSheet
          visible={noteSheetOpen}
          title={`Notes · ${view.petName}`}
          initialValue={draft?.text ?? view.operationalNotes ?? ""}
          onClose={() => setNoteSheetOpen(false)}
          onSave={async (text) => {
            setNoteSheetOpen(false);
            await queueOperationalNotes({
              appointmentId: view.id,
              targetLabel: `${view.petName} · ${view.timeRange}`,
              text
            });
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * A note the groomer has written but the server has not accepted.
 *
 * The text itself is never dimmed — only its container is marked — because the point is that
 * their words are still there and still theirs. `Copy text` is the guarantee: whatever else goes
 * wrong, they can always get their writing out of the app.
 */
function UnsentNote({
  text,
  state,
  permanent,
  error,
  onRetry,
  onDiscard
}: {
  text: string;
  state: "pending" | "sending" | "failed";
  /**
   * Whether the server will keep refusing this. A lost connection is not permanent, and dressing
   * it up in red teaches a groomer that red means "wait a minute", which is exactly what red must
   * never mean in this app.
   */
  permanent: boolean;
  error: string | null;
  onRetry: () => void;
  onDiscard: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <View
      testID="unsent-note"
      style={[
        styles.unsent,
        {
          backgroundColor: permanent ? colors.dangerTint : colors.warningTint,
          borderColor: permanent ? colors.dangerLine : colors.warning
        }
      ]}
    >
      <Text style={[styles.noteBody, { color: colors.ink }]} selectable>
        {text}
      </Text>
      <Text
        style={[styles.actionNote, { color: permanent ? colors.danger : colors.warning }]}
      >
        {state === "sending"
          ? "Retrying…"
          : permanent
            ? `Couldn't be saved — ${error}`
            : "Not sent yet"}
      </Text>
      {state === "sending" ? null : (
        <View style={styles.unsentActions}>
          <TextButton label="Retry" tone={permanent ? "danger" : "warning"} onPress={onRetry} />
          <TextButton label="Discard" tone="danger" onPress={onDiscard} />
        </View>
      )}
    </View>
  );
}

function LinkRow({
  label,
  detail,
  onPress,
  disabled,
  testID
}: {
  label: string;
  detail: string;
  onPress: () => void;
  disabled: boolean;
  testID?: string;
}): React.ReactElement | null {
  const { colors } = useTheme();
  // Absent, not disabled: a row that opens a permission error is worse than no row.
  if (disabled) return null;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="link"
      onPress={onPress}
      style={({ pressed }) => [styles.linkRow, pressed ? { opacity: 0.6 } : null]}
    >
      <View style={styles.linkText}>
        <Text style={[styles.linkLabel, { color: colors.ink }]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={[styles.linkDetail, { color: colors.muted }]} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space.lg, gap: space.lg },
  alarmHost: { borderWidth: 1, borderRadius: radius.card, paddingHorizontal: space.lg },
  rabiesRow: { gap: space.sm },
  rabiesText: { ...type.body },
  summaryHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm
  },
  time: { ...type.timeMono },
  date: { ...type.subhead },
  totals: { ...type.bodyStrong },
  overlap: { ...type.caption },
  muted: { ...type.footnote },
  noteBody: { ...type.body },
  unsent: { borderWidth: 1, borderRadius: radius.card, padding: space.md, gap: space.sm },
  unsentActions: { flexDirection: "row", gap: space.lg },
  linkRow: {
    minHeight: size.tap,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md
  },
  linkText: { flexShrink: 1 },
  linkLabel: { ...type.title3 },
  linkDetail: { ...type.caption },
  chevron: { fontSize: 22 },
  actionZone: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingTop: space.sm + 2,
    gap: space.sm
  },
  actionError: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  actionNote: { ...type.footnote, flexShrink: 1 },
  secondaryRow: { flexDirection: "row", gap: space.sm },
  secondaryItem: { flex: 1 }
});
