// ============================================================
// social-auth.ts — Google & Apple Sign-In via Firebase Auth
// ------------------------------------------------------------
// Google Sign-In is loaded lazily so Expo Go does not crash on
// startup (Expo Go does not include the RNGoogleSignin native module).
//
// In Expo Go, social buttons should be hidden (see SocialAuthButtons);
// if sign-in is invoked anyway, we return a clear error.
// ============================================================

import * as AppleAuthentication from 'expo-apple-authentication';
import Constants from 'expo-constants';
import {
  GoogleAuthProvider,
  OAuthProvider,
  reauthenticateWithCredential,
  signInWithCredential,
  User,
} from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { Platform } from 'react-native';
import { auth, db } from './firebase';
import { captureError } from './sentry';
import { userFacingErrorMessage } from './user-friendly-error';

const isExpoGo = Constants.appOwnership === 'expo';

export type SocialAuthResult = {
  user: User;
  isNewUser: boolean;
  suggested: {
    email: string | null;
    displayName: string | null;
  };
};

export type SocialAuthError = {
  code: 'cancelled' | 'play_services' | 'unknown';
  message: string;
};

async function hasProfileDoc(uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists();
}

let googleConfigured = false;

/** v16+ returns `{ type, data }`; older shapes are tolerated for tests. */
function extractGoogleIdTokenFromSignInResponse(response: unknown): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = response as any;
  if (r?.type === 'cancelled') return null;
  const payload = r?.type === 'success' ? r.data : (r?.data ?? r);
  return payload?.idToken ?? payload?.user?.idToken ?? null;
}

function isGoogleDeveloperError(err: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;
  const code = String(e?.code ?? '');
  const message = String(e?.message ?? '');
  return (
    code === '10' ||
    code === 'DEVELOPER_ERROR' ||
    message.includes('DEVELOPER_ERROR') ||
    message.includes('developer_error')
  );
}

function googleDeveloperErrorMessage(): string {
  return (
    'Google Sign-In is not set up for this Android build (DEVELOPER_ERROR). ' +
    'In Firebase → Project settings → Android app (com.pinpix.android), add every SHA-1 you use: ' +
    'local debug (run npm run android:sha), EAS upload key, and Play Console app signing key. ' +
    'Then download a new google-services.json, replace the file in the project root, and rebuild.'
  );
}

async function resolveGoogleIdTokenAfterSignIn(
  GoogleSignin: Awaited<ReturnType<typeof import('@react-native-google-signin/google-signin')>>['GoogleSignin'],
  signInResponse: unknown
): Promise<string> {
  let idToken = extractGoogleIdTokenFromSignInResponse(signInResponse);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((signInResponse as any)?.type === 'cancelled') {
    throw { code: 'cancelled', message: 'Sign-in cancelled.' } as SocialAuthError;
  }
  if (!idToken && Platform.OS === 'android') {
    try {
      const tokens = await GoogleSignin.getTokens();
      idToken = tokens.idToken;
    } catch {
      /* fall through to error below */
    }
  }
  if (!idToken) {
    throw {
      code: 'unknown',
      message: 'Google did not return an ID token. Try again.',
    } as SocialAuthError;
  }
  return idToken;
}

// ============================================================
// GOOGLE SIGN-IN (lazy native module)
// ============================================================
export async function signInWithGoogle(): Promise<SocialAuthResult> {
  if (isExpoGo) {
    throw {
      code: 'unknown',
      message:
        'Google Sign-In needs a development or store build. Open this project in your PinPix dev client (from EAS Build), or use email/password in Expo Go.',
    } as SocialAuthError;
  }

  const { GoogleSignin, statusCodes } = await import('@react-native-google-signin/google-signin');

  if (!googleConfigured) {
    const extra = Constants.expoConfig?.extra?.googleAuth ?? {};
    const webClientId = extra.webClientId as string | undefined;
    const iosClientId = extra.iosClientId as string | undefined;

    if (!webClientId) {
      throw {
        code: 'unknown',
        message: 'Google Sign-In is not configured: GOOGLE_WEB_CLIENT_ID is missing in .env',
      } as SocialAuthError;
    }

    GoogleSignin.configure({
      webClientId,
      iosClientId,
      offlineAccess: false,
    });
    googleConfigured = true;
  }

  if (Platform.OS === 'android') {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  }

  let response: unknown;
  try {
    response = await GoogleSignin.signIn();
  } catch (err) {
    if (isGoogleDeveloperError(err)) {
      throw { code: 'unknown', message: googleDeveloperErrorMessage() } as SocialAuthError;
    }
    throw err;
  }

  const idToken = await resolveGoogleIdTokenAfterSignIn(GoogleSignin, response);

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
// REAUTH HELPERS — used for sensitive actions like changing email
// when the user signed in with a social provider (no password).
// ============================================================
async function getGoogleIdToken(): Promise<string> {
  if (isExpoGo) {
    throw {
      code: 'unknown',
      message: 'Google Sign-In needs a development or store build.',
    } as SocialAuthError;
  }

  const { GoogleSignin } = await import('@react-native-google-signin/google-signin');

  if (!googleConfigured) {
    const extra = Constants.expoConfig?.extra?.googleAuth ?? {};
    const webClientId = extra.webClientId as string | undefined;
    const iosClientId = extra.iosClientId as string | undefined;
    if (!webClientId) {
      throw {
        code: 'unknown',
        message: 'Google Sign-In is not configured.',
      } as SocialAuthError;
    }
    GoogleSignin.configure({ webClientId, iosClientId, offlineAccess: false });
    googleConfigured = true;
  }

  if (Platform.OS === 'android') {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  }

  // Force a fresh consent prompt so we know we just got a current token.
  try { await GoogleSignin.signOut(); } catch { /* not signed in is fine */ }
  let response: unknown;
  try {
    response = await GoogleSignin.signIn();
  } catch (err) {
    if (isGoogleDeveloperError(err)) {
      throw { code: 'unknown', message: googleDeveloperErrorMessage() } as SocialAuthError;
    }
    throw err;
  }
  return resolveGoogleIdTokenAfterSignIn(GoogleSignin, response);
}

export async function reauthenticateWithGoogle(user: User): Promise<void> {
  const idToken = await getGoogleIdToken();
  const credential = GoogleAuthProvider.credential(idToken);
  await reauthenticateWithCredential(user, credential);
}

export async function reauthenticateWithApple(user: User): Promise<void> {
  if (Platform.OS !== 'ios') {
    throw {
      code: 'unknown',
      message: 'Sign in with Apple is only available on iOS.',
    } as SocialAuthError;
  }
  if (isExpoGo) {
    throw {
      code: 'unknown',
      message: 'Sign in with Apple needs a development or store build.',
    } as SocialAuthError;
  }
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });
  if (!credential.identityToken) {
    throw {
      code: 'unknown',
      message: 'Apple did not return an identity token.',
    } as SocialAuthError;
  }
  const provider = new OAuthProvider('apple.com');
  const firebaseCredential = provider.credential({
    idToken: credential.identityToken,
  });
  await reauthenticateWithCredential(user, firebaseCredential);
}

export function getPrimaryProvider(user: User): 'password' | 'google.com' | 'apple.com' | 'other' {
  const ids = user.providerData.map((p) => p.providerId);
  if (ids.includes('google.com')) return 'google.com';
  if (ids.includes('apple.com')) return 'apple.com';
  if (ids.includes('password')) return 'password';
  return 'other';
}

// ============================================================
// APPLE SIGN-IN
// ============================================================
export async function signInWithApple(): Promise<SocialAuthResult> {
  if (Platform.OS !== 'ios') {
    throw {
      code: 'unknown',
      message: 'Apple Sign-In is only available on iOS.',
    } as SocialAuthError;
  }

  if (isExpoGo) {
    throw {
      code: 'unknown',
      message:
        'Sign in with Apple needs a development or store build. Use email/password in Expo Go, or install your PinPix dev client from EAS Build.',
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

  // Build the Firebase Apple credential. The web/JS Firebase SDK does not
  // expose AppleAuthProvider; instead we use the generic OAuthProvider.
  const provider = new OAuthProvider('apple.com');
  const firebaseCredential = provider.credential({
    idToken: credential.identityToken,
  });
  const userCred = await signInWithCredential(auth, firebaseCredential);

  const isNewUser = !(await hasProfileDoc(userCred.user.uid));

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
// ERROR NORMALIZATION (lazy-load Google status codes when needed)
// ============================================================
export async function normalizeSocialAuthError(err: unknown): Promise<SocialAuthError> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = err as any;

  if (e?.code === 'cancelled' || e?.code === 'play_services') return e;

  if (isGoogleDeveloperError(err)) {
    return { code: 'unknown', message: googleDeveloperErrorMessage() };
  }

  // Apple Sign-In cancellation (expo module — always safe to check)
  if (e?.code === 'ERR_REQUEST_CANCELED' || e?.code === 'ERR_CANCELED') {
    return { code: 'cancelled', message: 'Sign-in cancelled.' };
  }

  // Google Sign-In status codes (only when not in Expo Go)
  if (!isExpoGo) {
    try {
      const { statusCodes } = await import('@react-native-google-signin/google-signin');
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
    } catch {
      // Module unavailable — fall through
    }
  }

  captureError(err, { area: 'social-auth.normalizeSocialAuthError' });
  return {
    code: 'unknown',
    message: userFacingErrorMessage(err, 'Could not complete sign-in. Please try again.'),
  };
}

// Re-export for any code that imported suggestUsername from here before
export { suggestUsername } from './suggest-username';
