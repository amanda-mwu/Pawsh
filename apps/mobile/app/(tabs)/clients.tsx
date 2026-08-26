import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { messageFor } from "../../src/api/errors";
import { useAuth } from "../../src/auth/AuthProvider";
import { ScreenHeader } from "../../src/components/Layout";
import { EmptyState, ErrorCard, SkeletonList } from "../../src/components/States";
import { useCustomerSearch, usePetSearch } from "../../src/query/hooks";
import { useTheme } from "../../src/theme/theme";
import { radius, size, space, type } from "../../src/theme/tokens";

/**
 * Clients.
 *
 * One search box over both directories, because a groomer knows the dog's name far more often
 * than the owner's. Each side is gated on its own permission and simply does not appear without
 * it, rather than returning an error the groomer cannot act on.
 */
export default function ClientsScreen(): React.ReactElement {
  const { me, allowed } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    // A search box that fires on every keystroke burns the 120-per-minute rate limit in about
    // four words.
    const handle = setTimeout(() => setDebounced(term.trim()), 350);
    return () => clearTimeout(handle);
  }, [term]);

  const mayViewCustomers = allowed("customers.view");
  const mayViewPets = allowed("pets.view");
  const ready = Boolean(me);

  const customers = useCustomerSearch(debounced, ready && mayViewCustomers);
  const pets = usePetSearch(debounced, ready && mayViewPets);

  const loading = customers.isPending && pets.isPending;
  const error = customers.error ?? pets.error;
  const customerRows = customers.data ?? [];
  const petRows = pets.data ?? [];
  const empty = !loading && !error && !customerRows.length && !petRows.length;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <ScreenHeader title="Clients" />

      <View style={[styles.searchRow, { backgroundColor: colors.surface, borderBottomColor: colors.line }]}>
        <TextInput
          testID="client-search"
          accessibilityLabel="Search clients and pets"
          value={term}
          onChangeText={setTerm}
          placeholder="Search by pet or owner name"
          placeholderTextColor={colors.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          style={[
            styles.search,
            { color: colors.ink, backgroundColor: colors.surface2, borderColor: colors.line }
          ]}
        />
      </View>

      <ScrollView
        testID="clients-list"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + space.xxl }]}
      >
        {error ? (
          <ErrorCard
            testID="clients-error"
            message={messageFor(error)}
            onRetry={() => {
              void customers.refetch();
              void pets.refetch();
            }}
          />
        ) : null}

        {loading ? <SkeletonList testID="clients-loading" /> : null}

        {empty ? (
          <EmptyState
            testID="clients-empty"
            title={debounced ? "No matches." : "Search for a client or pet."}
            detail={debounced ? "Try a different name or phone number." : undefined}
          />
        ) : null}

        {mayViewPets && petRows.length ? (
          <>
            <Text style={[styles.groupLabel, { color: colors.muted }]}>PETS</Text>
            {petRows.map((pet) => (
              <Row
                key={pet.id}
                testID={`pet-row-${pet.id}`}
                title={pet.name ?? "Unnamed pet"}
                detail={[pet.breed, pet.customerName].filter(Boolean).join(" · ")}
                alert={Boolean(pet.safetyAlerts)}
                onPress={() => router.push(`/pet/${pet.id}`)}
              />
            ))}
          </>
        ) : null}

        {mayViewCustomers && customerRows.length ? (
          <>
            <Text style={[styles.groupLabel, { color: colors.muted }]}>CLIENTS</Text>
            {customerRows.map((customer) => (
              <Row
                key={customer.id}
                testID={`customer-row-${customer.id}`}
                title={
                  [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
                  "Unnamed client"
                }
                detail={
                  (customer.pets ?? []).map((pet) => pet.name).filter(Boolean).join(", ") ||
                  customer.phone ||
                  ""
                }
                alert={(customer.pets ?? []).some((pet) => Boolean(pet.safetyAlerts))}
                onPress={() => router.push(`/customer/${customer.id}`)}
              />
            ))}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * A directory row.
 *
 * A pet carrying a safety alert says so here, on the row, in words. A groomer must never have to
 * open a record to discover that a dog bites.
 */
function Row({
  title,
  detail,
  alert,
  onPress,
  testID
}: {
  title: string;
  detail: string;
  alert: boolean;
  onPress: () => void;
  testID?: string;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={alert ? `${title}. Safety alert. ${detail}` : `${title}. ${detail}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? colors.surface2 : colors.surface, borderColor: colors.line }
      ]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: colors.ink }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={[styles.rowDetail, { color: colors.muted }]} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
        {alert ? (
          <View style={styles.alertRow}>
            <View style={[styles.dot, { backgroundColor: colors.danger }]} />
            <Text style={[styles.alertText, { color: colors.danger }]}>Safety alert</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  searchRow: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  search: {
    minHeight: size.tap,
    borderWidth: 1,
    borderRadius: radius.button,
    paddingHorizontal: space.md,
    ...type.body
  },
  list: { padding: space.lg, gap: space.sm },
  groupLabel: { ...type.overline, marginTop: space.sm },
  row: {
    minHeight: 64,
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
  rowTitle: { ...type.title3 },
  rowDetail: { ...type.caption },
  alertRow: { flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  alertText: { ...type.caption },
  chevron: { fontSize: 22 }
});
