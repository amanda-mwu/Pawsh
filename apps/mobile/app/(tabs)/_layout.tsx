import React from "react";
import { StyleSheet, Text, View, type ColorValue } from "react-native";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../src/auth/AuthProvider";
import { useDrafts } from "../../src/offline/DraftProvider";
import { unsentCount } from "../../src/offline/drafts";
import { useTheme } from "../../src/theme/theme";
import { fontScaleCaps, size, space, type } from "../../src/theme/tokens";

/**
 * Four tabs, filtered by permission exactly as the web navigation is.
 *
 * `href: null` removes a tab rather than disabling it, so the bar re-centres and a groomer never
 * taps something that tells them no. The minimum viable set is Today plus More.
 *
 * There is deliberately no fifth tab. Checkout is a step inside an appointment, not a
 * destination, and every administrative view — Reports, Sales, Products, Messages, Settings — is
 * absent rather than stubbed: a tab that opens "coming soon" costs trust every time it is tapped.
 */
export default function TabsLayout(): React.ReactElement {
  const { allowed } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { drafts } = useDrafts();
  const pending = unsentCount(drafts);

  const showCalendar = allowed("calendar.view");
  const showClients = allowed("customers.view") || allowed("pets.view");

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brandText,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          height: size.tabBar + insets.bottom,
          paddingBottom: insets.bottom,
          backgroundColor: colors.surface,
          borderTopColor: colors.line
        },
        tabBarLabelStyle: type.caption,
        tabBarAllowFontScaling: true
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Today",
          tabBarIcon: ({ color }) => <TabGlyph glyph="◉" color={color} />
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: "Calendar",
          href: showCalendar ? "/calendar" : null,
          tabBarIcon: ({ color }) => <TabGlyph glyph="▤" color={color} />
        }}
      />
      <Tabs.Screen
        name="clients"
        options={{
          title: "Clients",
          href: showClients ? "/clients" : null,
          tabBarIcon: ({ color }) => <TabGlyph glyph="☰" color={color} />
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: ({ color }) => <TabGlyph glyph="⋯" color={color} />,
          // Unsent work follows the groomer off the screen they typed it on.
          tabBarBadge: pending > 0 ? pending : undefined
        }}
      />
    </Tabs>
  );
}

function TabGlyph({ glyph, color }: { glyph: string; color: ColorValue }): React.ReactElement {
  return (
    <View style={styles.glyphBox}>
      <Text
        style={[styles.glyph, { color }]}
        maxFontSizeMultiplier={fontScaleCaps.tabLabel}
        accessibilityElementsHidden
      >
        {glyph}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  glyphBox: { height: 22, justifyContent: "center", paddingTop: space.hair },
  glyph: { fontSize: 18, lineHeight: 22 }
});
