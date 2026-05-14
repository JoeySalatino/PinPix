// ============================================================
// complete-profile.tsx — First-time Social Sign-In Profile Setup
// ------------------------------------------------------------
// Runs once for users who signed in via Google or Apple and don't
// yet have a Firestore user doc. We collect a username (suggested
// from their email, but editable), then create the users/{uid}
// document. After this, they're routed into the app normally.
//
// Users CAN'T go back from this screen — they must complete it or
// sign out. This keeps the data model consistent (every authed
// user has a profile doc with a unique username).
// ============================================================

import { useRouter } from 'expo-router';
import { signOut } from 'firebase/auth';
import { collection, doc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BRAND } from '../constants/brand';
import { appScreenBackground } from '../constants/theme';
import { auth, db } from '../utils/firebase';
import { captureError } from '../utils/sentry';
import { userFacingErrorMessage } from '../utils/user-friendly-error';
import { suggestUsername } from '../utils/suggest-username';
import { getDeviceCountryCodeForPhone, normalizeToE164 } from '../utils/phone-normalize';
import { useTheme } from '../utils/theme-context';

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function CompleteProfileScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const screenBg = appScreenBackground(isDark);

  const [username, setUsername] = useState('');
  const [phoneOptional, setPhoneOptional] = useState('');
  const [saving, setSaving] = useState(false);

  // ---- Pre-fill the username from the provider's email / display name ----
  useEffect(() => {
    const user = auth.currentUser;
    if (!user) {
      // Shouldn't happen, but bounce them home if it does
      router.replace('/');
      return;
    }
    const suggested = suggestUsername({
      email: user.email,
      displayName: user.displayName,
    });
    setUsername(suggested);
  }, [router]);

  // ============================================================
  // HANDLE SAVE
  // Validates, checks uniqueness, creates the users/{uid} doc.
  // ============================================================
  const handleSave = async () => {
    const user = auth.currentUser;
    if (!user) return;

    const trimmed = username.trim();

    if (trimmed.length < 3) {
      return Alert.alert('Invalid Username', 'Username must be at least 3 characters.');
    }
    if (trimmed.length > 20) {
      return Alert.alert('Invalid Username', 'Username must be 20 characters or fewer.');
    }
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) {
      return Alert.alert(
        'Invalid Username',
        'Username can only contain letters, numbers, and underscores.'
      );
    }

    setSaving(true);
    try {
      // Check uniqueness against the lowercased version
      const usersRef = collection(db, 'users');
      const q = query(usersRef, where('username', '==', trimmed.toLowerCase()));
      const snap = await getDocs(q);
      if (!snap.empty) {
        setSaving(false);
        return Alert.alert('Username Taken', 'Please choose a different username.');
      }

      const authPhoneE164 = user.phoneNumber ? normalizeToE164(user.phoneNumber) : null;

      const phoneTrim = phoneOptional.trim();
      let contactPhone: string | null = null;
      if (phoneTrim) {
        const e164 = normalizeToE164(phoneTrim, getDeviceCountryCodeForPhone());
        if (!e164) {
          setSaving(false);
          return Alert.alert(
            'Invalid phone number',
            'Please enter a valid number with country code (e.g. +1…), or leave phone blank.'
          );
        }
        contactPhone = e164;
      } else if (authPhoneE164) {
        contactPhone = authPhoneE164;
      }

      // Create the profile doc (same shape as email/password signup)
      await setDoc(doc(db, 'users', user.uid), {
        username: trimmed.toLowerCase(),
        displayUsername: trimmed,
        email: (user.email || '').toLowerCase(),
        favorites: [],
        profileImage: user.photoURL || null,
        createdAt: new Date().toISOString(),
        profileVisible: true,
        showEmailOnProfile: false,
        pushNearbySpots: true,
        pushFavoriteActivity: true,
        pushCommentActivity: true,
        pushEnabled: true,
        pushFriendRequests: true,
        pushWeeklyDigest: false,
        emailDigest: false,
        blockedUserIds: [],
        following: [],
        followers: [],
        ...(contactPhone ? { contactMatchPhoneE164: contactPhone } : {}),
      });

      // Route into the app. Index will detect onboarding state and
      // route to /onboarding (first time) or /main (subsequent).
      router.replace('/');
    } catch (err: unknown) {
      captureError(err, { area: 'CompleteProfileScreen.handleSave' });
      Alert.alert(
        'Could not save profile',
        userFacingErrorMessage(err, 'Could not save your profile. Please try again.')
      );
    } finally {
      setSaving(false);
    }
  };

  // ============================================================
  // HANDLE SIGN OUT
  // Escape hatch — let the user back out if they don't want to
  // complete profile setup. Without this, they'd be stuck.
  // ============================================================
  const handleSignOut = async () => {
    try {
      await signOut(auth);
      router.replace('/login');
    } catch (err) {
      captureError(err, { area: 'CompleteProfileScreen.signOut' });
    }
  };

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: screenBg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Image
            source={require('../assets/images/icon.jpg')}
            style={styles.logoImage}
            resizeMode="contain"
          />
          <Text style={styles.appName}>One more step</Text>
          <Text style={styles.tagline}>Pick a username for your PinPix profile</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            placeholder="yourname"
            placeholderTextColor={CREAM_DARK}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={20}
          />
          <Text style={styles.hint}>
            3–20 characters. Letters, numbers, and underscores only. This is how other photographers
            will see you.
          </Text>

          <Text style={styles.label}>Phone (optional)</Text>
          <TextInput
            style={styles.input}
            value={phoneOptional}
            onChangeText={setPhoneOptional}
            placeholder="Include country code, e.g. +1 415…"
            placeholderTextColor={CREAM_DARK}
            keyboardType="phone-pad"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.hint}>
            Helps friends find you from their contacts. You can skip this and add it later in Settings.
          </Text>

          <TouchableOpacity
            style={[styles.primaryButton, saving && { opacity: 0.6 }]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color={CREAM} />
            ) : (
              <Text style={styles.primaryButtonText}>Continue</Text>
            )}
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={handleSignOut}>
          <Text style={styles.footerText}>
            Not you? <Text style={styles.footerLink}>Sign out</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 32 },
  logoImage: { width: 100, height: 100, marginBottom: 12 },
  appName: { fontSize: 28, fontWeight: '900', color: CREAM, letterSpacing: 0.5 },
  tagline: {
    fontSize: 14,
    color: CREAM_DARK,
    marginTop: 6,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  card: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.12)',
    marginBottom: 24,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: CREAM_DARK,
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: CREAM,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.15)',
  },
  hint: { color: CREAM_DARK, fontSize: 12, marginBottom: 20, lineHeight: 18 },
  primaryButton: {
    backgroundColor: ORANGE,
    padding: 16,
    borderRadius: 14,
    alignItems: 'center',
    shadowColor: ORANGE,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  primaryButtonText: { color: CREAM, fontWeight: '800', fontSize: 16, letterSpacing: 0.3 },
  footerText: { color: CREAM_DARK, textAlign: 'center', fontSize: 14 },
  footerLink: { color: ORANGE, fontWeight: '700' },
});
