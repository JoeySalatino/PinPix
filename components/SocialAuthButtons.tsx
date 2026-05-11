// ============================================================
// SocialAuthButtons.tsx — Google + Apple Sign-In buttons
// ------------------------------------------------------------
// Renders side-by-side or stacked sign-in buttons for the login
// and signup screens. Handles the full flow:
//   1. Native Google / Apple sign-in
//   2. Exchange the token for a Firebase credential
//   3. Sign into Firebase
//   4. Route to /complete-profile (first time) or /
//
// Apple button is hidden on Android (per Apple's guidelines, only
// required where the user might also use Google).
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND } from '../constants/brand';
import {
  normalizeSocialAuthError,
  signInWithApple,
  signInWithGoogle,
} from '../utils/social-auth';

const { cream: CREAM, creamDark: CREAM_DARK } = BRAND;

type Props = {
  // Optional copy override ("Continue with..." vs "Sign in with..."). Defaults to "Continue".
  variant?: 'continue' | 'signin';
};

export default function SocialAuthButtons({ variant = 'continue' }: Props) {
  const router = useRouter();
  const [busyProvider, setBusyProvider] = useState<'google' | 'apple' | null>(null);

  const prefix = variant === 'signin' ? 'Sign in' : 'Continue';

  const handleGoogle = async () => {
    if (busyProvider) return;
    setBusyProvider('google');
    try {
      const result = await signInWithGoogle();
      // First-time social user → go pick a username. Otherwise let index route.
      router.replace(result.isNewUser ? '/complete-profile' : '/');
    } catch (err) {
      const norm = normalizeSocialAuthError(err);
      if (norm.code !== 'cancelled') {
        Alert.alert('Google Sign-In', norm.message);
      }
    } finally {
      setBusyProvider(null);
    }
  };

  const handleApple = async () => {
    if (busyProvider) return;
    setBusyProvider('apple');
    try {
      const result = await signInWithApple();
      router.replace(result.isNewUser ? '/complete-profile' : '/');
    } catch (err) {
      const norm = normalizeSocialAuthError(err);
      if (norm.code !== 'cancelled') {
        Alert.alert('Apple Sign-In', norm.message);
      }
    } finally {
      setBusyProvider(null);
    }
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>

      <TouchableOpacity
        style={[styles.button, styles.googleButton, !!busyProvider && { opacity: 0.6 }]}
        onPress={handleGoogle}
        disabled={!!busyProvider}
      >
        {busyProvider === 'google' ? (
          <ActivityIndicator color="#1f1f1f" />
        ) : (
          <>
            <Ionicons name="logo-google" size={18} color="#1f1f1f" style={styles.icon} />
            <Text style={styles.googleText}>{prefix} with Google</Text>
          </>
        )}
      </TouchableOpacity>

      {Platform.OS === 'ios' && (
        <TouchableOpacity
          style={[styles.button, styles.appleButton, !!busyProvider && { opacity: 0.6 }]}
          onPress={handleApple}
          disabled={!!busyProvider}
        >
          {busyProvider === 'apple' ? (
            <ActivityIndicator color={CREAM} />
          ) : (
            <>
              <Ionicons name="logo-apple" size={20} color={CREAM} style={styles.icon} />
              <Text style={styles.appleText}>{prefix} with Apple</Text>
            </>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8 },
  divider: { flexDirection: 'row', alignItems: 'center', marginVertical: 18 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(231,219,203,0.25)' },
  dividerText: {
    color: CREAM_DARK,
    paddingHorizontal: 12,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    borderRadius: 12,
    marginBottom: 10,
  },
  icon: { marginRight: 10 },
  googleButton: {
    backgroundColor: '#ffffff',
  },
  googleText: { color: '#1f1f1f', fontWeight: '700', fontSize: 15 },
  appleButton: {
    backgroundColor: '#000000',
  },
  appleText: { color: CREAM, fontWeight: '700', fontSize: 15 },
});
