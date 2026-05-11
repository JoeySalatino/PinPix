// ============================================================
// SignupScreen.tsx — New User Registration
// ------------------------------------------------------------
// Creates a new account using Firebase Auth, then saves extra
// user info (username, email, etc.) to Firestore.
//
// Firebase Auth only stores email + password.
// Firestore is where we store everything else about the user.
//
// Flow:
//   1. Validate all fields client-side
//   2. Create the Firebase Auth account
//   3. Force a token refresh so Firestore recognizes the auth state
//   4. Check username uniqueness (after auth so rules pass)
//   5. Save user profile to Firestore
//   6. Send verification email
//   7. Sign out (they must verify before logging in)
//   8. Redirect to login
// ============================================================

import { useRouter } from 'expo-router';
import { createUserWithEmailAndPassword, sendEmailVerification } from 'firebase/auth';
import { collection, doc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { useState } from 'react';
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
import { auth, db } from '../utils/firebase';
import { BRAND } from '../constants/brand';
import { captureError } from '../utils/sentry';

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function SignupScreen() {
  const router = useRouter();

  // ---- Form state ----
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');

  // ---- Loading state (prevents double-submit) ----
  const [loading, setLoading] = useState(false);

  // ============================================================
  // HANDLE SIGNUP
  // ============================================================
  const handleSignup = async () => {
    // ---- Client-side validation ----
    if (!email || !password || !username || !confirmPassword)
      return Alert.alert('Missing Info', 'Please fill in all fields.');
    if (username.trim().length < 3)
      return Alert.alert('Invalid Username', 'Username must be at least 3 characters.');
    if (!/^[a-zA-Z0-9_]+$/.test(username.trim()))
      return Alert.alert('Invalid Username', 'Username can only contain letters, numbers, and underscores.');
    if (password.length < 6)
      return Alert.alert('Weak Password', 'Password must be at least 6 characters.');
    if (password !== confirmPassword)
      return Alert.alert('Password Mismatch', 'Passwords do not match.');

    setLoading(true);
    try {
      // ---- Create Firebase Auth account first ----
      // We create the account before the Firestore checks so the user
      // is authenticated when we write to Firestore (rules require auth)
      const userCredential = await createUserWithEmailAndPassword(auth, email.trim(), password);
      const user = userCredential.user;

      // ---- Force token refresh ----
      // This ensures Firestore recognizes the new auth state immediately.
      // Without this, Firestore writes can fail with permission errors
      // because the auth token hasn't propagated yet.
      await user.getIdToken(true);

      // ---- Check username uniqueness in Firestore ----
      // Done after auth is established so the security rules allow the read
      const usersRef = collection(db, 'users');
      const q = query(usersRef, where('username', '==', username.trim().toLowerCase()));
      const snap = await getDocs(q);
      if (!snap.empty) {
        // Username taken — delete the auth account we just created and bail
        await user.delete();
        setLoading(false);
        return Alert.alert('Username Taken', 'Please choose a different username.');
      }

      // ---- Save user profile to Firestore ----
      // We store two versions of username:
      //   username: lowercase (used for uniqueness checks and searching)
      //   displayUsername: original casing (shown in the UI)
      await setDoc(doc(db, 'users', user.uid), {
        username: username.trim().toLowerCase(),
        displayUsername: username.trim(),
        email: email.trim().toLowerCase(),
        favorites: [],        // Array of spot keys the user has favorited
        profileImage: null,   // Will be set when they upload a photo
        createdAt: new Date().toISOString(),
      });

      // ---- Send verification email ----
      await sendEmailVerification(user);

      // ---- Sign out immediately — they must verify before logging in ----
      await auth.signOut();

      Alert.alert('Check your inbox!', 'We sent a verification email. Verify your account before logging in.');
      router.replace('/login');
    } catch (err: any) {
      captureError(err, { area: 'SignupScreen.handleSignup' });
      console.log('Signup error:', err);
      Alert.alert('Signup Error', err.message);
    } finally {
      setLoading(false);
    }
  };

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">

        {/* ---- App logo and name ---- */}
        <View style={styles.header}>
          <Image
            source={require('../assets/images/icon.jpg')}
            style={styles.logoImage}
            resizeMode="contain"
          />
          <Text style={styles.appName}>PinPix</Text>
          <Text style={styles.tagline}>Join the community of photographers</Text>
        </View>

        {/* ---- Signup form card ---- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Create account</Text>

          <Text style={styles.label}>Username</Text>
          <TextInput
            style={styles.input}
            placeholder="yourname"
            placeholderTextColor={CREAM_DARK}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
          />

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
            placeholder="Min. 6 characters"
            placeholderTextColor={CREAM_DARK}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <Text style={styles.label}>Confirm Password</Text>
          <TextInput
            style={styles.input}
            placeholder="Repeat your password"
            placeholderTextColor={CREAM_DARK}
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
          />

          <TouchableOpacity
            style={[styles.primaryButton, loading && { opacity: 0.6 }]}
            onPress={handleSignup}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color={CREAM} />
              : <Text style={styles.primaryButtonText}>Create Account</Text>}
          </TouchableOpacity>
        </View>

        {/* ---- Link to login ---- */}
        <TouchableOpacity onPress={() => router.replace('/login')}>
          <Text style={styles.footerText}>
            Already have an account?{' '}
            <Text style={styles.footerLink}>Log in</Text>
          </Text>
        </TouchableOpacity>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ============================================================
// STYLES
// ============================================================
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: NAVY },
  container: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  header: { alignItems: 'center', marginBottom: 32 },
  logoImage: {
    width: 110,
    height: 110,
    marginBottom: 14,
  },
  appName: { fontSize: 36, fontWeight: '900', color: CREAM, letterSpacing: 1 },
  tagline: { fontSize: 14, color: CREAM_DARK, marginTop: 4, letterSpacing: 0.5, textAlign: 'center' },
  card: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 24, padding: 24,
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.12)',
    marginBottom: 24,
  },
  cardTitle: { fontSize: 22, fontWeight: '800', color: CREAM, marginBottom: 20 },
  label: { fontSize: 12, fontWeight: '700', color: CREAM_DARK, letterSpacing: 0.8, marginBottom: 6 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12, padding: 14, fontSize: 15,
    color: CREAM, marginBottom: 16,
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.15)',
  },
  primaryButton: {
    backgroundColor: ORANGE,
    padding: 16, borderRadius: 14, alignItems: 'center', marginTop: 4,
    shadowColor: ORANGE, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  primaryButtonText: { color: CREAM, fontWeight: '800', fontSize: 16, letterSpacing: 0.3 },
  footerText: { color: CREAM_DARK, textAlign: 'center', fontSize: 14 },
  footerLink: { color: ORANGE, fontWeight: '700' },
});