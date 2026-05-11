// ============================================================
// social-auth.ts — Google & Apple Sign-In via Firebase Auth
// ------------------------------------------------------------
// Wraps the native Google and Apple sign-in flows and converts
// the resulting tokens into Firebase Auth credentials.
//
// For first-time social users (no Firestore user doc yet), the
// caller should route to /complete-profile so the user can pick
// a username. We detect "first time" by checking for a users/{uid}
// doc — same model regardless of provider.
//
// All errors here are normalized to a shape the UI can show:
//   { code: 'cancelled' | 'play_services' | 'unknown', message }
// ============================================================

import {
  GoogleSignin,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import Constants from 'expo-constants';
import {
  AppleAuthProvider,
  GoogleAuthProvider,
  signInWithCredential,
  User,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { Platform } from 'react-native';
import { auth, db } from './firebase';
import { captureError } from './sentry';

// ---- One-time GoogleSignin configuration ----
// Must be called before signIn(). Safe to call multiple times.
let googleConfigured = false;
function ensureGoogleConfigured() {
  if (googleConfigured) return;
  const extra = Constants.expoConfig?.extra?.googleAuth ?? {};
  const webClientId = extra.webClientId as string | undefined;
  const iosClientId = extra.iosClientId as string | undefined;

  if (!webClientId) {
    throw new Error(
      'Google Sign-In is not configured: GOOGLE_WEB_CLIENT_ID is missing in .env'
    );
  }

  GoogleSignin.configure({
    webClientId,
    iosClientId,
    offlineAccess: false,
  });
  googleConfigured = true;
}

export type SocialAuthResult = {
  user: User;
  isNewUser: boolean; // True if there's no Firestore profile doc yet
  // Suggested fields from the provider, useful for the username picker
  suggested: {
    email: string | null;
    displayName: string | null;
  };
};

export type SocialAuthError = {
  code: 'cancelled' | 'play_services' | 'unknown';
  message: string;
};

// ---- Helper: check whether the user has a Firestore profile doc ----
async function hasProfileDoc(uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists();
}

// ============================================================
// GOOGLE SIGN-IN
// ============================================================
export async function signInWithGoogle(): Promise<SocialAuthResult> {
  ensureGoogleConfigured();

  // On Android, verify Play Services are present before attempting sign-in
  if (Platform.OS === 'android') {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  }

  const response = await GoogleSignin.signIn();
  // SDK 13+ wraps the user in { data, type }; older versions return the user directly.
  // Normalize both shapes here so the rest of the function doesn't care.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userInfo: any = (response as any)?.data ?? response;
  const idToken = userInfo?.idToken ?? userInfo?.user?.idToken;

  if (!idToken) {
    throw {
      code: 'unknown',
      message: 'Google did not return an ID token. Try again.',
    } as SocialAuthError;
  }

  const credential = GoogleAuthProvider.credential(idToken);
  const userCred = await signInWithCredential(auth, credential);

  const isNewUser = !(await hasProfileDoc(userCred.user.uid));

  return {
    user: userCred.user,
    isNewUser,
    suggested: {
      email: userCred.user.email,
      displayName: userCred.user.displayName,
    },
  };
}

// ============================================================
// APPLE SIGN-IN
// Only available on iOS 13+. Caller should hide the button on Android.
// ============================================================
export async function signInWithApple(): Promise<SocialAuthResult> {
  if (Platform.OS !== 'ios') {
    throw {
      code: 'unknown',
      message: 'Apple Sign-In is only available on iOS.',
    } as SocialAuthError;
  }

  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });

  if (!credential.identityToken) {
    throw {
      code: 'unknown',
      message: 'Apple did not return an identity token.',
    } as SocialAuthError;
  }

  const firebaseCredential = AppleAuthProvider.credential(credential.identityToken);
  const userCred = await signInWithCredential(auth, firebaseCredential);

  const isNewUser = !(await hasProfileDoc(userCred.user.uid));

  // Apple only sends fullName on the FIRST sign-in. For returning users,
  // these will be null. We use whatever we get; the username picker will
  // fall back to the email prefix if displayName is empty.
  const fullName = credential.fullName
    ? [credential.fullName.givenName, credential.fullName.familyName]
        .filter(Boolean)
        .join(' ')
        .trim() || null
    : null;

  return {
    user: userCred.user,
    isNewUser,
    suggested: {
      email: userCred.user.email ?? credential.email ?? null,
      displayName: userCred.user.displayName ?? fullName,
    },
  };
}

// ============================================================
// ERROR NORMALIZATION
// Converts raw provider errors into a shape we can render.
// ============================================================
export function normalizeSocialAuthError(err: unknown): SocialAuthError {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;

  // Already normalized
  if (e?.code === 'cancelled' || e?.code === 'play_services') return e;

  // Google Sign-In status codes
  if (e?.code === statusCodes.SIGN_IN_CANCELLED) {
    return { code: 'cancelled', message: 'Sign-in cancelled.' };
  }
  if (e?.code === statusCodes.IN_PROGRESS) {
    return { code: 'cancelled', message: 'Sign-in already in progress.' };
  }
  if (e?.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
    return {
      code: 'play_services',
      message: 'Google Play Services is required to sign in with Google.',
    };
  }

  // Apple Sign-In cancellation
  if (e?.code === 'ERR_REQUEST_CANCELED' || e?.code === 'ERR_CANCELED') {
    return { code: 'cancelled', message: 'Sign-in cancelled.' };
  }

  // Anything else — log to Sentry and return generic
  captureError(err, { area: 'social-auth.normalizeSocialAuthError' });
  return {
    code: 'unknown',
    message: e?.message || 'Could not complete sign-in. Please try again.',
  };
}

// ============================================================
// USERNAME GENERATION
// Generate a sensible default username from email + displayName.
// The complete-profile screen presents this pre-filled but editable.
// ============================================================
export function suggestUsername(opts: {
  email: string | null;
  displayName: string | null;
}): string {
  const { email, displayName } = opts;

  // Prefer the local part of the email (everything before @)
  if (email) {
    const local = email.split('@')[0];
    const cleaned = local.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
    if (cleaned.length >= 3) return cleaned.slice(0, 20);
  }

  // Fall back to first word of display name
  if (displayName) {
    const cleaned = displayName.split(/\s+/)[0].replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
    if (cleaned.length >= 3) return cleaned.slice(0, 20);
  }

  return '';
}
