import React, { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/theme";
import { elevation, radius, space, type } from "../theme/tokens";
import { PrimaryButton, TextButton } from "./Buttons";

/**
 * The note editor.
 *
 * Every text entry in this app lives in a sheet rather than an inline field in a scroll view, so
 * the sheet owns the keyboard relationship and Save can be pinned above it. A groomer who cannot
 * see Save assumes the note was lost, and a groomer who assumes that stops typing notes.
 *
 * Dismissing with unsaved changes asks rather than discards. Nothing a groomer wrote is ever
 * dropped silently.
 */
export function NoteSheet({
  visible,
  title,
  initialValue,
  onClose,
  onSave
}: {
  visible: boolean;
  title: string;
  initialValue: string;
  onClose: () => void;
  onSave: (text: string) => void | Promise<void>;
}): React.ReactElement {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  const dirty = value !== initialValue;

  const requestClose = (): void => {
    if (!dirty) {
      onClose();
      return;
    }
    Alert.alert("Keep this draft?", "Your note has not been saved yet.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: onClose }
    ]);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={requestClose}
      accessibilityViewIsModal
    >
      <Pressable style={styles.scrim} onPress={requestClose} accessibilityLabel="Close notes" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.sheetHost}
      >
        <View
          testID="note-sheet"
          style={[
            styles.sheet,
            { backgroundColor: colors.surface, borderColor: colors.line },
            elevation.sheet
          ]}
        >
          <View style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: colors.line }]} />
          </View>
          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: colors.ink }]} numberOfLines={1}>
              {title}
            </Text>
            <TextButton label="Cancel" onPress={requestClose} />
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" style={styles.fieldHost}>
            <TextInput
              testID="note-input"
              accessibilityLabel="Note"
              value={value}
              onChangeText={setValue}
              multiline
              autoCapitalize="sentences"
              autoCorrect
              // Return inserts a newline. A groomer writing four sentences must not have the
              // first one submitted out from under them.
              returnKeyType="default"
              placeholder="What happened during this groom?"
              placeholderTextColor={colors.placeholder}
              style={[
                styles.input,
                {
                  color: colors.ink,
                  backgroundColor: colors.surface2,
                  borderColor: colors.line,
                  maxHeight: Math.max(160, height * 0.4)
                }
              ]}
            />
          </ScrollView>

          <View style={[styles.saveRow, { paddingBottom: space.md + insets.bottom }]}>
            <PrimaryButton
              testID="note-save"
              label="Save"
              busy={saving}
              onPress={() => {
                setSaving(true);
                void Promise.resolve(onSave(value.trim())).finally(() => setSaving(false));
              }}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(32,37,34,0.35)"
  },
  sheetHost: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    maxHeight: "88%"
  },
  handleRow: { alignItems: "center", paddingTop: space.sm },
  handle: { width: 36, height: 4, borderRadius: 2 },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    gap: space.md
  },
  title: { ...type.title2, flexShrink: 1 },
  fieldHost: { paddingHorizontal: space.lg, paddingTop: space.md },
  input: {
    minHeight: 120,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: space.md,
    textAlignVertical: "top",
    ...type.body
  },
  saveRow: { paddingHorizontal: space.lg, paddingTop: space.md }
});
