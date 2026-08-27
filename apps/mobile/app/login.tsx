import React, { useCallback, useRef, useState } from "react";
import Ionicons from "@expo/vector-icons/Ionicons";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { messageFor } from "../src/api/errors";
import { useAuth } from "../src/auth/AuthProvider";
import { PrimaryButton } from "../src/components/Buttons";
import { ErrorCard } from "../src/components/States";
import { useTheme } from "../src/theme/theme";
import { radius, size, space, type } from "../src/theme/tokens";

/**
 * The tokens carry no glyph scale, so the eye is sized off the type ramp rather than a loose
 * number: at the title ramp's 22 it out-weighs the field's 16pt body text and reads as a control
 * rather than as decoration, while still clearing the 44pt row it sits in.
 */
const REVEAL_ICON_SIZE = type.title1.fontSize;

export default function LoginScreen(): React.ReactElement {
  const { signIn } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const passwordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);

  // Presentation only: the value never leaves `password`, and the input keeps its identity across
  // the flip so the caret, the focus and the password manager's fill all survive it.
  const toggleReveal = useCallback(() => setRevealed((shown) => !shown), []);

  const submit = useCallback(async () => {
    if (busy) return;
    const trimmed = email.trim();
    if (!trimmed || !password) {
      // Client-side only to save a round trip. The server validates the same thing, and it is the
      // server that decides whether these credentials are real.
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn({ email: trimmed, password });
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, email, password, signIn]);

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xxl }
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <Text style={[styles.wordmark, { color: colors.brandText }]}>Pawsh</Text>
          <Text style={[styles.tagline, { color: colors.muted }]}>Groomer</Text>
        </View>

        {error ? <ErrorCard message={error} testID="login-error" /> : null}

        <View style={styles.field}>
          <Text nativeID="email-label" style={[styles.label, { color: colors.muted }]}>
            EMAIL
          </Text>
          <TextInput
            testID="email"
            accessibilityLabelledBy="email-label"
            accessibilityLabel="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
            placeholder="you@salon.com"
            placeholderTextColor={colors.placeholder}
            style={[
              styles.input,
              { color: colors.ink, backgroundColor: colors.surface, borderColor: colors.line }
            ]}
          />
        </View>

        <View style={styles.field}>
          <Text nativeID="password-label" style={[styles.label, { color: colors.muted }]}>
            PASSWORD
          </Text>
          <View
            style={[styles.inputRow, { backgroundColor: colors.surface, borderColor: colors.line }]}
          >
            <TextInput
              testID="password"
              ref={passwordRef}
              accessibilityLabelledBy="password-label"
              accessibilityLabel="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!revealed}
              autoCapitalize="none"
              // Revealed text is ordinary text to the keyboard, which would otherwise offer to
              // correct it and learn it into the dictionary.
              autoCorrect={false}
              spellCheck={false}
              autoComplete="current-password"
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
              placeholderTextColor={colors.placeholder}
              style={[styles.rowInput, { color: colors.ink }]}
            />
            <Pressable
              testID="password-reveal"
              // One accessibility element, so the glyph is not announced beside its own label.
              accessible
              accessibilityRole="button"
              accessibilityLabel={revealed ? "Hide password" : "Show password"}
              accessibilityState={{ selected: revealed }}
              onPress={toggleReveal}
              style={({ pressed }) => [styles.reveal, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Ionicons
                testID="password-reveal-icon"
                name={revealed ? "eye-off-outline" : "eye-outline"}
                size={REVEAL_ICON_SIZE}
                color={colors.brandText}
              />
            </Pressable>
          </View>
        </View>

        <PrimaryButton testID="sign-in" label="Sign in" busy={busy} onPress={() => void submit()} />

        <Text style={[styles.footnote, { color: colors.muted }]}>
          Sessions last 14 days. Signing out here also ends the session on the server.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: space.lg, gap: space.lg, flexGrow: 1, justifyContent: "center" },
  brand: { alignItems: "center", gap: space.xs, marginBottom: space.lg },
  wordmark: { ...type.display },
  tagline: { ...type.subhead },
  field: { gap: space.xs },
  label: { ...type.overline },
  input: {
    minHeight: size.tap,
    borderWidth: 1,
    borderRadius: radius.button,
    paddingHorizontal: space.md,
    ...type.body
  },
  /** The password field's chrome moves to the row so the reveal control sits inside the border. */
  inputRow: {
    minHeight: size.tap,
    borderWidth: 1,
    borderRadius: radius.button,
    flexDirection: "row",
    alignItems: "center"
  },
  rowInput: { flex: 1, minHeight: size.tap, paddingHorizontal: space.md, ...type.body },
  /**
   * The glyph is 22pt but the target is a full 44 square: the two eyes are the same width, so the
   * extra room the "Show"/"Hide" wording needed to stop the field resizing is now just a gap.
   */
  reveal: {
    minWidth: size.tap,
    minHeight: size.tap,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm
  },
  footnote: { ...type.footnote, textAlign: "center" }
});
