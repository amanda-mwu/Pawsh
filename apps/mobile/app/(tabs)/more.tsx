import React, { useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { permissionLabels, type Permission } from "@pawsh/domain";
import { api } from "../../src/api/endpoints";
import { messageFor } from "../../src/api/errors";
import { useAuth } from "../../src/auth/AuthProvider";
import { SecondaryButton, TextButton } from "../../src/components/Buttons";
import { ScreenHeader, Section } from "../../src/components/Layout";
import { ErrorCard } from "../../src/components/States";
import { useConnectivity } from "../../src/net/connectivity";
import { useDrafts } from "../../src/offline/DraftProvider";
import { useLocations } from "../../src/query/hooks";
import { queryKeys } from "../../src/query/keys";
import { useTheme } from "../../src/theme/theme";
import { radius, size, space, type } from "../../src/theme/tokens";

/**
 * More.
 *
 * Account, location, and — the reason it earns a tab — everything the groomer wrote that has not
 * reached the server yet. Unsent work follows them off the screen they typed it on rather than
 * being announced once and forgotten.
 */
export default function MoreScreen(): React.ReactElement {
  const { me, setMe, signOut } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { online } = useConnectivity();
  const { drafts, retry, retryAll, discard } = useDrafts();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const multiLocation = (me?.business?.locationCount ?? 0) > 1;
  const locations = useLocations(Boolean(me) && multiLocation);

  const switchLocation = useCallback(
    async (locationId: string) => {
      setSwitching(true);
      setError(null);
      try {
        await api.selectLocation(locationId);
        queryClient.removeQueries({ queryKey: queryKeys.appointments });
        const refreshed = await api.me();
        queryClient.setQueryData(queryKeys.me, refreshed);
        setMe(refreshed);
        await queryClient.invalidateQueries();
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setSwitching(false);
      }
    },
    [queryClient, setMe]
  );

  const confirmSignOut = useCallback(() => {
    const unsent = drafts.length;
    Alert.alert(
      "Sign out?",
      unsent
        ? `${unsent} note${unsent === 1 ? "" : "s"} still to send. Signing out keeps them on this device but they will not be sent until you sign back in.`
        : "You will need your email and password to sign back in.",
      [
        { text: "Stay signed in", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void signOut() }
      ]
    );
  }, [drafts.length, signOut]);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <ScreenHeader title="More" />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space.xxl }]}
      >
        {error ? <ErrorCard message={error} onRetry={() => setError(null)} /> : null}

        <Section label="Account">
          <Text style={[styles.value, { color: colors.ink }]}>
            {me?.account?.displayName ?? "—"}
          </Text>
          <Text style={[styles.detail, { color: colors.muted }]}>{me?.account?.email ?? ""}</Text>
          <Text style={[styles.detail, { color: colors.muted }]}>
            {me?.business?.name ?? ""}
            {me?.business?.locationName ? ` · ${me.business.locationName}` : ""}
          </Text>
        </Section>

        <Section label={`Pending changes (${drafts.length})`}>
          {drafts.length === 0 ? (
            <Text style={[styles.detail, { color: colors.muted }]}>
              Everything you have written has been sent.
            </Text>
          ) : (
            <>
              {drafts.map((draft) => (
                <View
                  key={draft.id}
                  testID={`draft-${draft.id}`}
                  style={[
                    styles.draft,
                    {
                      backgroundColor: draft.permanent ? colors.dangerTint : colors.warningTint,
                      borderColor: draft.permanent ? colors.dangerLine : colors.warning
                    }
                  ]}
                >
                  <Text style={[styles.draftTarget, { color: colors.muted }]} numberOfLines={1}>
                    {draft.targetLabel}
                  </Text>
                  <Text style={[styles.value, { color: colors.ink }]} numberOfLines={3} selectable>
                    {draft.text}
                  </Text>
                  <Text
                    style={[
                      styles.detail,
                      { color: draft.permanent ? colors.danger : colors.warning }
                    ]}
                  >
                    {draft.state === "sending"
                      ? "Retrying…"
                      : draft.error
                        ? `Couldn't be saved — ${draft.error}`
                        : "Not sent yet"}
                  </Text>
                  <View style={styles.draftActions}>
                    <TextButton
                      label="Retry"
                      tone={draft.permanent ? "danger" : "warning"}
                      onPress={() => void retry(draft.id)}
                    />
                    {/* The guarantee: whatever the server will never accept, the groomer can
                        always get their own words out of the app and into a message. */}
                    <TextButton
                      label="Copy text"
                      onPress={() => void Clipboard.setStringAsync(draft.text)}
                    />
                    <TextButton label="Discard" tone="danger" onPress={() => void discard(draft.id)} />
                  </View>
                </View>
              ))}
              <SecondaryButton
                label={online ? "Retry all" : "Offline — will retry on reconnect"}
                disabled={!online}
                onPress={() => void retryAll()}
              />
            </>
          )}
        </Section>

        {multiLocation ? (
          <Section label="Location">
            {(locations.data ?? []).map((location) => (
              <Pressable
                key={location.id}
                testID={`switch-location-${location.id}`}
                accessibilityRole="button"
                accessibilityState={{ selected: location.current, disabled: switching }}
                disabled={switching || location.current}
                onPress={() => void switchLocation(location.id)}
                style={styles.locationRow}
              >
                <Text style={[styles.value, { color: colors.ink }]}>{location.name}</Text>
                {location.current ? (
                  <Text style={[styles.detail, { color: colors.brandText }]}>Current</Text>
                ) : null}
              </Pressable>
            ))}
          </Section>
        ) : null}

        <Section label="Your access">
          <Text style={[styles.detail, { color: colors.muted }]}>
            {me?.isOwner
              ? "Owner — full access."
              : (me?.permissions ?? [])
                  .map((permission) => permissionLabels[permission as Permission] ?? permission)
                  .join(" · ") || "No permissions granted."}
          </Text>
        </Section>

        <SecondaryButton testID="sign-out" label="Sign out" onPress={confirmSignOut} />

        <Text style={[styles.detail, { color: colors.muted }]}>
          Checkout, photos, messaging and salon settings are not in this release. They are absent
          rather than stubbed.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space.lg, gap: space.lg },
  value: { ...type.body },
  detail: { ...type.footnote },
  draft: { borderWidth: 1, borderRadius: radius.card, padding: space.md, gap: space.xs },
  draftTarget: { ...type.overline },
  draftActions: { flexDirection: "row", gap: space.lg, flexWrap: "wrap" },
  locationRow: {
    minHeight: size.tap,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md
  }
});
