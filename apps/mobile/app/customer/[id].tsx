import React, { useMemo } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatMinor } from "@pawsh/domain";
import { messageFor } from "../../src/api/errors";
import { useAuth } from "../../src/auth/AuthProvider";
import { AppointmentCard } from "../../src/components/AppointmentCard";
import { Section } from "../../src/components/Layout";
import { ErrorCard, SkeletonList } from "../../src/components/States";
import {
  categoryLookup,
  toAppointmentView,
  type CareVisibility
} from "../../src/features/appointments/model";
import { useCustomerHistory, useServices } from "../../src/query/hooks";
import { useTheme } from "../../src/theme/theme";
import { radius, size, space, type } from "../../src/theme/tokens";

/**
 * Customer profile. Read-only on mobile — editing the record, merging, marketing preferences,
 * invoice detail and receipts are desk work.
 *
 * Contact first, then pets, then the next visit. Phone and email are real 44pt targets here
 * rather than the static text the web app prints: on a phone they are the most-used controls on
 * the screen.
 */
export default function CustomerScreen(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const customerId = String(id ?? "");
  const { me, allowed } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const enabled = Boolean(me) && Boolean(customerId) && allowed("customers.view");
  const history = useCustomerHistory(customerId, enabled);
  const services = useServices(Boolean(me));
  const categoryOf = useMemo(() => categoryLookup(services.data), [services.data]);
  const careVisibility: CareVisibility = allowed("pets.care.view") ? "visible" : "withheld";

  const data = history.data;
  const customer = data?.customer;
  const fullName =
    [customer?.firstName, customer?.lastName].filter(Boolean).join(" ") || "Unnamed client";

  const nextVisit = data?.upcoming.items[0]
    ? toAppointmentView(data.upcoming.items[0], {
        careVisibility,
        categoryOf,
        currency: me?.business?.currency ?? "USD"
      })
    : null;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Stack.Screen
        options={{ headerShown: true, title: fullName, headerBackTitle: "Back" }}
      />
      <ScrollView
        testID="customer-profile"
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      >
        {!allowed("customers.view") ? (
          <Section>
            <Text style={[styles.muted, { color: colors.muted }]}>
              Client records are not visible with your access.
            </Text>
          </Section>
        ) : null}

        {history.isError ? (
          <ErrorCard
            testID="customer-error"
            message={messageFor(history.error)}
            onRetry={() => void history.refetch()}
          />
        ) : null}

        {history.isPending && enabled ? <SkeletonList testID="customer-loading" /> : null}

        {data ? (
          <>
            <Section>
              <Text style={[styles.name, { color: colors.ink }]}>{fullName}</Text>
              <View style={styles.actions}>
                <ContactChip
                  testID="call-client"
                  label={customer?.phone ?? "No phone"}
                  hint="Call"
                  onPress={
                    customer?.phone
                      ? () => void Linking.openURL(`tel:${customer.phone}`)
                      : undefined
                  }
                />
                <ContactChip
                  testID="email-client"
                  label={customer?.email ?? "No email"}
                  hint="Email"
                  onPress={
                    customer?.email
                      ? () => void Linking.openURL(`mailto:${customer.email}`)
                      : undefined
                  }
                />
              </View>
            </Section>

            <Section label={`Pets (${data.pets.length})`}>
              {data.pets.length === 0 ? (
                <Text style={[styles.muted, { color: colors.muted }]}>
                  No pets on this client yet.
                </Text>
              ) : null}
              {data.pets.map((pet) => (
                <Pressable
                  key={pet.id}
                  testID={`pet-${pet.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={
                    pet.safetyAlerts
                      ? `${pet.name ?? "Pet"}. Safety alert. ${pet.breed ?? ""}`
                      : `${pet.name ?? "Pet"}. ${pet.breed ?? ""}`
                  }
                  disabled={!allowed("pets.view")}
                  onPress={() => router.push(`/pet/${pet.id}`)}
                  style={({ pressed }) => [styles.petRow, pressed ? { opacity: 0.6 } : null]}
                >
                  <View style={styles.petText}>
                    <Text style={[styles.petName, { color: colors.ink }]} numberOfLines={1}>
                      {pet.name ?? "Unnamed pet"}
                    </Text>
                    {pet.breed ? (
                      <Text style={[styles.muted, { color: colors.muted }]} numberOfLines={1}>
                        {pet.breed}
                      </Text>
                    ) : null}
                    {/* A groomer must never have to open a pet to discover it bites. */}
                    {careVisibility === "visible" && pet.safetyAlerts ? (
                      <View style={styles.alertRow}>
                        <View style={[styles.dot, { backgroundColor: colors.danger }]} />
                        <Text style={[styles.alertText, { color: colors.danger }]}>
                          Safety alert
                        </Text>
                      </View>
                    ) : null}
                    {careVisibility === "withheld" ? (
                      <Text style={[styles.muted, { color: colors.muted }]}>
                        Care notes not visible with your access.
                      </Text>
                    ) : null}
                  </View>
                  {allowed("pets.view") ? (
                    <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
                  ) : null}
                </Pressable>
              ))}
            </Section>

            {nextVisit ? (
              <View style={styles.block}>
                <Text style={[styles.blockLabel, { color: colors.muted }]}>NEXT APPOINTMENT</Text>
                <AppointmentCard
                  testID={`appointment-${nextVisit.id}`}
                  view={nextVisit}
                  onPress={() => router.push(`/appointment/${nextVisit.id}`)}
                />
              </View>
            ) : null}

            {customer?.notes ? (
              <Section label="Client notes">
                <Text style={[styles.body, { color: colors.ink }]}>{customer.notes}</Text>
              </Section>
            ) : null}

            {/* Money is withheld rather than zeroed without `payments.view`, so an absent summary
                is never mistaken for a client who has never spent anything. */}
            {data.summary ? (
              <Section label="Account">
                <Text style={[styles.body, { color: colors.ink }]}>
                  {formatMinor(data.summary.outstandingMinor, me?.business?.currency ?? "USD")}{" "}
                  outstanding across {data.summary.invoiceCount} invoice
                  {data.summary.invoiceCount === 1 ? "" : "s"}
                </Text>
              </Section>
            ) : null}

            <Section label={`Appointment history (${data.appointmentTotal})`}>
              {data.history.items.length === 0 ? (
                <Text style={[styles.muted, { color: colors.muted }]}>No past appointments.</Text>
              ) : null}
              {data.history.items.slice(0, 5).map((row) => {
                const view = toAppointmentView(row, {
                  careVisibility,
                  categoryOf,
                  currency: me?.business?.currency ?? "USD"
                });
                return (
                  <Pressable
                    key={view.id}
                    testID={`history-${view.id}`}
                    accessibilityRole="button"
                    onPress={() => router.push(`/appointment/${view.id}`)}
                    style={({ pressed }) => [styles.historyRow, pressed ? { opacity: 0.6 } : null]}
                  >
                    <Text style={[styles.body, { color: colors.ink }]} numberOfLines={1}>
                      {view.dateLabel}
                    </Text>
                    <Text style={[styles.muted, { color: colors.muted }]} numberOfLines={1}>
                      {view.petName} · {view.services.primary || view.serviceNames.join(", ")}
                    </Text>
                  </Pressable>
                );
              })}
              {data.appointmentsTruncated ? (
                <Text style={[styles.muted, { color: colors.muted }]}>
                  Older visits are on the desktop app.
                </Text>
              ) : null}
            </Section>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * A contact target.
 *
 * A missing value renders a disabled chip that says so. The absence is stated, not implied by a
 * gap where a phone number would be.
 */
function ContactChip({
  label,
  hint,
  onPress,
  testID
}: {
  label: string;
  hint: string;
  onPress?: (() => void) | undefined;
  testID?: string;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={onPress ? `${hint} ${label}` : label}
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: pressed ? colors.line : colors.surface2,
          borderColor: colors.line,
          opacity: onPress ? 1 : 0.6
        }
      ]}
    >
      <Text style={[styles.chipHint, { color: colors.muted }]}>{hint.toUpperCase()}</Text>
      <Text style={[styles.chipLabel, { color: colors.ink }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space.lg, gap: space.lg },
  name: { ...type.title1 },
  actions: { flexDirection: "row", gap: space.sm },
  chip: {
    flex: 1,
    minHeight: size.tap,
    borderWidth: 1,
    borderRadius: radius.button,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    justifyContent: "center",
    gap: 2
  },
  chipHint: { ...type.overline },
  chipLabel: { ...type.subhead },
  petRow: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md
  },
  petText: { flexShrink: 1, gap: 2 },
  petName: { ...type.title3 },
  alertRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
  alertText: { ...type.caption },
  block: { gap: space.sm },
  blockLabel: { ...type.overline },
  body: { ...type.body },
  muted: { ...type.footnote },
  historyRow: { minHeight: size.tap, justifyContent: "center", gap: 2 },
  chevron: { fontSize: 22 }
});
