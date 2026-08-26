import React from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  evaluateRabiesProfile,
  petHealthIssueLabels,
  poundsFromOunces,
  rabiesVerificationStatusLabels,
  type PetHealthIssue
} from "@pawsh/domain";
import { messageFor } from "../../src/api/errors";
import { useAuth } from "../../src/auth/AuthProvider";
import { TextButton } from "../../src/components/Buttons";
import { ChipRow, NoteChip } from "../../src/components/Chips";
import { CareBlock, Section } from "../../src/components/Layout";
import { SafetyAlarm } from "../../src/components/SafetyAlarm";
import { ErrorCard, SkeletonList } from "../../src/components/States";
import { deviceLocalDate, formatDateValue } from "../../src/features/appointments/time";
import { usePet, usePetNotes } from "../../src/query/hooks";
import { useTheme } from "../../src/theme/theme";
import { radius, space, type } from "../../src/theme/tokens";

/** Verbatim from the web app's pet form, so the two never describe the same dog differently. */
const FIXED_STATUS_LABELS: Record<string, string> = {
  spayed: "Spayed (female)",
  neutered: "Neutered (male)",
  intact: "Intact"
};

/**
 * Pet profile.
 *
 * Ordered by what a groomer needs mid-service: identity, then the alarm, then the must-reads,
 * then everything else. Safety is never something you have to open something to find.
 *
 * Read-only. Editing care fields, rabies dates, breed and pricing class is desk work and is not
 * in this release; no edit affordance appears at all rather than a pencil that produces a
 * permission error.
 */
export default function PetScreen(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const petId = String(id ?? "");
  const { me, allowed } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const enabled = Boolean(me) && Boolean(petId) && allowed("pets.view");
  const pet = usePet(petId, enabled);
  const notes = usePetNotes(petId, enabled);
  const careVisible = allowed("pets.care.view");

  const data = pet.data;
  const weightPounds = poundsFromOunces(data?.weightOunces);
  const rabiesProfile = careVisible
    ? evaluateRabiesProfile(data?.vaccinationExpiresOn ?? null, deviceLocalDate())
    : null;

  // The web app renders every rabies state on the same neutral ground, so "expired" and "current"
  // look identical. Tinting by severity is the one improvement worth making here; the sentences
  // themselves stay verbatim.
  const rabiesSentence =
    rabiesProfile === "not_provided"
      ? "Rabies expiration date not provided."
      : rabiesProfile === "expired"
        ? `Rabies vaccination expired on ${formatDateValue(data?.vaccinationExpiresOn) ?? "an unknown date"}.`
        : "Rabies vaccination is current for the next appointment.";

  const identityLine = [
    data?.breed,
    weightPounds === null ? null : `${weightPounds.toFixed(0)} lb`,
    data?.species,
    data?.fixedStatus ? (FIXED_STATUS_LABELS[data.fixedStatus] ?? "").split(" ")[0] : null
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Stack.Screen
        options={{ headerShown: true, title: data?.name ?? "Pet", headerBackTitle: "Back" }}
      />
      <ScrollView
        testID="pet-profile"
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      >
        {!allowed("pets.view") ? (
          <Section>
            <Text style={[styles.muted, { color: colors.muted }]}>
              Pet records are not visible with your access.
            </Text>
          </Section>
        ) : null}

        {pet.isError ? (
          <ErrorCard
            testID="pet-error"
            message={messageFor(pet.error)}
            onRetry={() => void pet.refetch()}
          />
        ) : null}

        {pet.isPending && enabled ? <SkeletonList testID="pet-loading" /> : null}

        {data ? (
          <>
            <Section>
              <Text style={[styles.name, { color: colors.ink }]}>{data.name ?? "Unnamed pet"}</Text>
              {identityLine ? (
                <Text style={[styles.identity, { color: colors.muted }]}>{identityLine}</Text>
              ) : null}
            </Section>

            <View
              style={[styles.alarmHost, { backgroundColor: colors.surface, borderColor: colors.line }]}
            >
              <SafetyAlarm
                state={
                  !careVisible
                    ? { kind: "withheld" }
                    : data.safetyAlerts
                      ? { kind: "alert", text: data.safetyAlerts }
                      : { kind: "clear" }
                }
              />
            </View>

            {careVisible ? (
              <Section>
                <CareBlock
                  label="Behavior"
                  text={data.behaviorNotes}
                  emptyText="No behavior notes on file."
                />
                <CareBlock
                  label="Medical"
                  text={data.medicalNotes}
                  emptyText="No medical notes on file."
                />
                {data.healthIssues?.length ? (
                  <View style={styles.block}>
                    <Text style={[styles.blockLabel, { color: colors.muted }]}>HEALTH ISSUES</Text>
                    <ChipRow>
                      {data.healthIssues.map((issue) => (
                        <NoteChip
                          key={issue}
                          label={petHealthIssueLabels[issue as PetHealthIssue] ?? issue}
                        />
                      ))}
                    </ChipRow>
                  </View>
                ) : null}
              </Section>
            ) : null}

            {careVisible ? (
              <View
                style={[
                  styles.rabies,
                  rabiesProfile === "current"
                    ? { backgroundColor: colors.successTint, borderColor: colors.line }
                    : { backgroundColor: colors.dangerTint, borderColor: colors.danger }
                ]}
              >
                <Text style={[styles.blockLabel, { color: colors.muted }]}>RABIES</Text>
                <Text
                  style={[
                    styles.body,
                    { color: rabiesProfile === "current" ? colors.ink : colors.danger }
                  ]}
                >
                  {rabiesSentence}
                </Text>
                {data.rabiesVerificationStatus ? (
                  <Text style={[styles.muted, { color: colors.muted }]}>
                    {rabiesVerificationStatusLabels[data.rabiesVerificationStatus]}
                  </Text>
                ) : null}
              </View>
            ) : null}

            <Section>
              <CareBlock label="Grooming preferences" text={data.groomingPreferences} />
              <CareBlock label="Coat notes" text={data.coatNotes} />
              {data.customerPhone ? (
                <View style={styles.block}>
                  <Text style={[styles.blockLabel, { color: colors.muted }]}>OWNER</Text>
                  <Text style={[styles.body, { color: colors.ink }]}>
                    {data.customerName ?? "—"}
                  </Text>
                  <TextButton
                    testID="call-owner"
                    label={`Call ${data.customerPhone}`}
                    onPress={() => void Linking.openURL(`tel:${data.customerPhone}`)}
                  />
                </View>
              ) : null}
            </Section>

            <Section label={`Notes (${notes.data?.length ?? 0})`}>
              {notes.isError ? (
                <ErrorCard
                  message="Notes could not be loaded."
                  onRetry={() => void notes.refetch()}
                />
              ) : null}
              {notes.isPending ? (
                <Text style={[styles.muted, { color: colors.muted }]}>Loading notes…</Text>
              ) : null}
              {notes.data && notes.data.length === 0 ? (
                <Text style={[styles.muted, { color: colors.muted }]}>No notes on this pet yet.</Text>
              ) : null}
              {(notes.data ?? []).map((note) => (
                <View
                  key={note.id}
                  testID={`pet-note-${note.id}`}
                  style={[
                    styles.note,
                    { borderColor: colors.line },
                    note.pinned
                      ? { borderLeftWidth: 3, borderLeftColor: colors.brandText }
                      : null
                  ]}
                >
                  <Text style={[styles.body, { color: colors.ink }]}>{note.body}</Text>
                  <Text style={[styles.muted, { color: colors.muted }]}>
                    {note.authorName ?? "Unknown"} · {formatDateValue(note.createdAt) ?? ""}
                  </Text>
                </View>
              ))}
            </Section>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space.lg, gap: space.lg },
  name: { ...type.title1 },
  identity: { ...type.subhead },
  alarmHost: { borderWidth: 1, borderRadius: radius.card, paddingHorizontal: space.lg },
  block: { gap: space.xs },
  blockLabel: { ...type.overline },
  body: { ...type.body },
  muted: { ...type.footnote },
  rabies: { borderWidth: 1, borderRadius: radius.card, padding: space.lg, gap: space.xs },
  note: { borderWidth: 1, borderRadius: radius.card, padding: space.md, gap: space.xs }
});
