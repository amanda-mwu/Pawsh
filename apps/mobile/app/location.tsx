import React, { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../src/api/endpoints";
import { messageFor } from "../src/api/errors";
import { useAuth } from "../src/auth/AuthProvider";
import { ErrorCard, SkeletonList } from "../src/components/States";
import { TextButton } from "../src/components/Buttons";
import { useLocations } from "../src/query/hooks";
import { queryKeys } from "../src/query/keys";
import { useTheme } from "../src/theme/theme";
import { radius, size, space, type } from "../src/theme/tokens";

/**
 * The location picker.
 *
 * Only reachable when the business has more than one active location — a single-location salon
 * never sees it, because there is no choice to make. The chosen location is stored on the session
 * server-side, so every subsequent calendar read is scoped by it without the app passing anything.
 */
export default function LocationScreen(): React.ReactElement {
  const { me, setMe, locationChosen } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const locations = useLocations(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = useCallback(
    async (locationId: string) => {
      setPendingId(locationId);
      setError(null);
      try {
        await api.selectLocation(locationId);
        // The session's location changed, so every cached read scoped to it is now about the
        // wrong salon. Clearing is blunt and correct: showing one location's schedule under
        // another's name is worse than a moment of loading.
        queryClient.removeQueries({ queryKey: queryKeys.appointments });
        const refreshed = await api.me();
        queryClient.setQueryData(queryKeys.me, refreshed);
        setMe(refreshed);
        locationChosen();
        router.replace("/");
      } catch (cause) {
        setError(messageFor(cause));
      } finally {
        setPendingId(null);
      }
    },
    [locationChosen, queryClient, router, setMe]
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + space.xl, paddingBottom: insets.bottom + space.xl }
        ]}
      >
        <Text style={[styles.title, { color: colors.ink }]}>Choose a location</Text>
        <Text style={[styles.detail, { color: colors.muted }]}>
          Your schedule shows the location you are working from. You can switch it later under
          More.
        </Text>

        {error ? <ErrorCard message={error} onRetry={() => setError(null)} /> : null}

        {locations.isPending ? <SkeletonList testID="locations-loading" /> : null}

        {locations.isError ? (
          <ErrorCard
            message={messageFor(locations.error)}
            onRetry={() => void locations.refetch()}
          />
        ) : null}

        {(locations.data ?? []).map((location) => (
          <Pressable
            key={location.id}
            testID={`location-${location.id}`}
            accessibilityRole="button"
            accessibilityState={{ selected: location.current, busy: pendingId === location.id }}
            disabled={pendingId !== null}
            onPress={() => void choose(location.id)}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: pressed ? colors.surface2 : colors.surface,
                borderColor: location.current ? colors.brand : colors.line
              }
            ]}
          >
            <View style={styles.rowText}>
              <Text style={[styles.name, { color: colors.ink }]}>{location.name}</Text>
              {location.address ? (
                <Text style={[styles.address, { color: colors.muted }]} numberOfLines={1}>
                  {location.address}
                </Text>
              ) : null}
            </View>
            {location.current ? (
              <Text style={[styles.current, { color: colors.brandText }]}>Current</Text>
            ) : null}
          </Pressable>
        ))}

        {me?.business?.locationName ? (
          <TextButton
            label={`Keep ${me.business.locationName}`}
            onPress={() => {
              locationChosen();
              router.replace("/");
            }}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: space.lg, gap: space.md },
  title: { ...type.display },
  detail: { ...type.body, marginBottom: space.sm },
  row: {
    minHeight: size.tap + 20,
    borderWidth: 1,
    borderRadius: radius.card,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md
  },
  rowText: { flexShrink: 1, gap: 2 },
  name: { ...type.title3 },
  address: { ...type.caption },
  current: { ...type.caption }
});
