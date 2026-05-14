// ============================================================
// LoginScreen.tsx — User Login
// ------------------------------------------------------------
// Handles signing in with email and password via Firebase Auth.
//
// Email verification is encouraged but not required to log in.
// Verifying is required to post a spot (gated in add-spot), and users
// can resend the verification email from the Settings screen.
//
// Also handles:
//   - Forgot password flow (iOS uses Alert.prompt, Android uses
//     a custom Modal since Alert.prompt doesn't exist there)
// ============================================================

import { useRouter } from 'expo-router';
import { sendPasswordResetEmail, signInWithEmailAndPassword } from 'firebase/auth';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import SocialAuthButtons from '../components/SocialAuthButtons';
import { BRAND } from '../constants/brand';
import { appScreenBackground } from '../constants/theme';
import { auth } from '../utils/firebase';
import { userFacingErrorMessage } from '../utils/user-friendly-error';
import { useTheme } from '../utils/theme-context';

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function LoginScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const screenBg = appScreenBackground(isDark);

  // ---- Form state ----
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // ---- Loading states (prevent double-tapping buttons) ----
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  // ---- Reset password modal (Android only) ----
  const [modalVisible, setModalVisible] = useState(false);
  const [resetEmail, setResetEmail] = useState('');

  // ============================================================
  // HANDLE LOGIN
  // Signs the user in. Verification status is NOT checked here —
  // verifying is encouraged but not required to log in. Posting a
  // new spot is gated separately (see add-spot screen).
  // ============================================================
  const handleLogin = async () => {
    if (!email || !password) return Alert.alert('Missing Info', 'Please fill in all fields.');

    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      // Index will route to /onboarding (first-timers) or /main automatically
      // once it sees the new auth state. We replace to "/" so it re-evaluates.
      router.replace('/');
    } catch (err: unknown) {
      Alert.alert('Could not sign in', userFacingErrorMessage(err, 'Could not sign in. Please try again.'));
    } finally {
      // Always stop the loading spinner, even if there was an error
      setLoading(false);
    }
  };

  // ============================================================
  // FORGOT PASSWORD
  // iOS supports Alert.prompt natively.
  // Android doesn't have Alert.prompt, so we show a custom Modal.
  // ============================================================
  const handleForgotPassword = () => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Reset Password',
        'Enter your email address:',
        async (input) => {
          const emailToReset = input?.trim() || email.trim();
          if (!emailToReset) return Alert.alert('Email Required', 'Please provide an email.');
          try {
            await sendPasswordResetEmail(auth, emailToReset);
            Alert.alert('Email Sent', 'Check your inbox for the reset link.');
          } catch (err: unknown) {
            Alert.alert(
              'Could not send reset email',
              userFacingErrorMessage(err, 'Could not send reset email. Please try again.')
            );
          }
        },
        'plain-text',
        email // Pre-fill with whatever they typed in the email field
      );
    } else {
      // Android — open the custom modal instead
      setResetEmail(email);
      setModalVisible(true);
    }
  };

  // Sends the reset email from the Android modal
  const sendResetEmail = async () => {
    if (!resetEmail.trim()) return Alert.alert('Email Required', 'Please provide an email.');
    setResetLoading(true);
    try {
      await sendPasswordResetEmail(auth, resetEmail.trim());
      Alert.alert('Email Sent', 'Check your inbox for the reset link.');
      setModalVisible(false);
    } catch (err: unknown) {
      Alert.alert(
        'Could not send reset email',
        userFacingErrorMessage(err, 'Could not send reset email. Please try again.')
      );
    } finally {
      setResetLoading(false);
    }
  };

  // ============================================================
  // RENDER
  // ============================================================
  return (
    // KeyboardAvoidingView pushes the form up when the keyboard appears
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: screenBg }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">

        {/* ---- App logo and name ---- */}
        <View style={styles.header}>
          <Image
            source={require('../assets/images/icon.jpg')}
            style={styles.logoImage}
            resizeMode="contain"
          />
          <Text style={styles.appName}>PinPix</Text>
          <Text style={styles.tagline}>Find your perfect frame</Text>
        </View>

        {/* ---- Login form card ---- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Welcome back</Text>

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            placeholder="you@example.com"
            placeholderTextColor={CREAM_DARK}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            placeholderTextColor={CREAM_DARK}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <TouchableOpacity onPress={handleForgotPassword}>
            <Text style={styles.forgotText}>Forgot password?</Text>
          </TouchableOpacity>

          {/* Disabled while loading to prevent double-submit */}
          <TouchableOpacity
            style={[styles.primaryButton, loading && { opacity: 0.6 }]}
            onPress={handleLogin}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color={CREAM} />
              : <Text style={styles.primaryButtonText}>Log In</Text>}
          </TouchableOpacity>

          {/* ---- Google + Apple sign-in ---- */}
          <SocialAuthButtons variant="signin" />
        </View>

        {/* ---- Link to signup ---- */}
        <TouchableOpacity onPress={() => router.replace('/signup')}>
          <Text style={styles.footerText}>
            New to PinPix?{' '}
            <Text style={styles.footerLink}>Create an account</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* ---- Android-only reset password modal ---- */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalBg}>
          <View style={[styles.modalBox, { backgroundColor: screenBg }]}>
            <Text style={styles.modalTitle}>Reset Password</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your email"
              placeholderTextColor={CREAM_DARK}
              value={resetEmail}
              onChangeText={setResetEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
            <TouchableOpacity
              style={[styles.primaryButton, resetLoading && { opacity: 0.6 }]}
              onPress={sendResetEmail}
              disabled={resetLoading}
            >
              {resetLoading
                ? <ActivityIndicator color={CREAM} />
                : <Text style={styles.primaryButtonText}>Send Reset Link</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setModalVisible(false)} style={{ marginTop: 12, alignItems: 'center' }}>
              <Text style={{ color: ORANGE, fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ============================================================
// STYLES
// ============================================================
const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { flexGrow: 1, justifyContent: 'center', padding: 24 },

  // Logo section at the top
  header: { alignItems: 'center', marginBottom: 36 },
  logoImage: {
    width: 110,
    height: 110,
    marginBottom: 14,
  },
  appName: { fontSize: 36, fontWeight: '900', color: CREAM, letterSpacing: 1 },
  tagline: { fontSize: 14, color: CREAM_DARK, marginTop: 4, letterSpacing: 0.5 },

  // Semi-transparent card container
  card: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 24, padding: 24,
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.12)',
    marginBottom: 24,
  },
  cardTitle: { fontSize: 22, fontWeight: '800', color: CREAM, marginBottom: 20 },

  // Small uppercase labels above each input
  label: { fontSize: 12, fontWeight: '700', color: CREAM_DARK, letterSpacing: 0.8, marginBottom: 6 },

  // Text inputs with a subtle glass-like background
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12, padding: 14, fontSize: 15,
    color: CREAM, marginBottom: 16,
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.15)',
  },

  forgotText: { color: ORANGE, fontSize: 13, textAlign: 'right', marginBottom: 20, fontWeight: '600' },

  // Main action button with orange glow shadow
  primaryButton: {
    backgroundColor: ORANGE,
    padding: 16, borderRadius: 14, alignItems: 'center',
    shadowColor: ORANGE, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  primaryButtonText: { color: CREAM, fontWeight: '800', fontSize: 16, letterSpacing: 0.3 },

  // Outlined secondary button (used for resend)
  secondaryButton: {
    marginTop: 12, padding: 14, borderRadius: 14,
    borderWidth: 1.5, borderColor: ORANGE, alignItems: 'center',
  },
  secondaryButtonText: { color: ORANGE, fontWeight: '700', fontSize: 14 },

  footerText: { color: CREAM_DARK, textAlign: 'center', fontSize: 14 },
  footerLink: { color: ORANGE, fontWeight: '700' },

  // Modal overlay and box
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  modalBox: {
    width: '88%', backgroundColor: NAVY, padding: 24, borderRadius: 20,
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.15)',
  },
  modalTitle: { fontSize: 20, fontWeight: '800', color: CREAM, marginBottom: 16, textAlign: 'center' },
});