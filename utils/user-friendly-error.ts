// ============================================================
// user-friendly-error.ts — Map Firebase / SDK errors for UI
// ------------------------------------------------------------
// Never surface raw Firebase strings like "Firebase: Error (auth/…)"
// in Alerts. Use userFacingErrorMessage() in catch blocks.
// ============================================================

const DEFAULT = 'Something went wrong. Please try again.';

export type CredentialWrongHint = 'sign-in' | 'current-password';

/** Firebase Auth — https://firebase.google.com/docs/auth/admin/errors */
const AUTH: Record<string, string> = {
  'auth/invalid-email': 'That email address does not look valid.',
  'auth/missing-email': 'Please enter your email address.',
  'auth/user-disabled': 'This account is no longer available. Contact support if you need help.',
  'auth/email-already-in-use': 'An account already exists with this email.',
  'auth/email-already-exists': 'An account already exists with this email.',
  'auth/weak-password': 'Please choose a stronger password (at least 6 characters).',
  'auth/too-many-requests': 'Too many attempts. Please wait a bit and try again.',
  'auth/network-request-failed': 'Network problem. Check your connection and try again.',
  'auth/internal-error': 'Something went wrong on our side. Please try again in a moment.',
  'auth/operation-not-allowed': 'This sign-in method is not available. Please contact support.',
  'auth/requires-recent-login': 'For your security, please sign out and sign back in, then try again.',
  'auth/invalid-verification-code': 'That verification code is not valid. Request a new one.',
  'auth/invalid-verification-id': 'That verification link is not valid. Request a new one.',
  'auth/expired-action-code': 'That link or code has expired. Request a new one.',
  'auth/invalid-action-code': 'That link or code is not valid. Request a new one.',
  'auth/missing-or-invalid-nonce': 'Sign-in could not be completed. Please try again.',
  'auth/credential-already-in-use': 'Those sign-in details are already linked to another account.',
  'auth/account-exists-with-different-credential':
    'An account already exists with this email using a different sign-in method. Try signing in another way.',
  'auth/invalid-app-credential': 'Sign-in could not be verified. Please try again.',
  'auth/invalid-phone-number': 'That phone number does not look valid.',
  'auth/missing-phone-number': 'Please enter a phone number.',
  'auth/quota-exceeded': 'Too many requests right now. Please try again later.',
  'auth/app-not-authorized': 'This app is not authorized to sign in. Please contact support.',
  'auth/keychain-error': 'Could not access secure storage. Try restarting the app.',
  'auth/web-storage-unsupported': 'This device cannot complete sign-in in the browser. Use the app instead.',
};

const FIRESTORE: Record<string, string> = {
  'permission-denied': "You don't have permission to do that. Try signing in again.",
  unavailable: 'Service is temporarily unavailable. Check your connection and try again.',
  'resource-exhausted': 'Too many requests. Please wait a moment and try again.',
  aborted: 'The request was interrupted. Please try again.',
  cancelled: 'The request was cancelled.',
  'failed-precondition': 'This action cannot be done right now. Please try again.',
  'not-found': 'We could not find that data. It may have been removed.',
  'already-exists': 'That already exists.',
  internal: 'Something went wrong. Please try again.',
};

const STORAGE: Record<string, string> = {
  'storage/unauthorized': "You don't have permission to access that file.",
  'storage/retry-limit-exceeded': 'Upload timed out. Check your connection and try again.',
  'storage/invalid-checksum': 'Upload failed. Please try again.',
  'storage/canceled': 'Upload was canceled.',
  'storage/unknown': 'Could not upload. Please try again.',
};

function getMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    return typeof m === 'string' ? m : undefined;
  }
  return undefined;
}

function getCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const c = (error as { code?: unknown }).code;
  if (typeof c === 'string' && c.length > 0) return c;
  const msg = getMessage(error);
  if (msg) {
    const authMatch = msg.match(/\((auth\/[a-z0-9-]+)\)/i);
    if (authMatch) return authMatch[1];
  }
  return undefined;
}

function looksLikeFirebaseOrSdkJargon(msg: string): boolean {
  const t = msg.toLowerCase();
  return (
    t.includes('firebase') ||
    t.includes('firestore') ||
    /auth\/[a-z0-9-]+/i.test(msg) ||
    t.includes('google cloud') ||
    t.includes('grpc') ||
    t.includes('@firebase') ||
    /\[firebase/i.test(msg)
  );
}

const WRONG_CREDENTIAL_CODES = new Set([
  'auth/user-not-found',
  'auth/wrong-password',
  'auth/invalid-credential',
  'auth/invalid-login-credentials',
]);

function wrongCredentialMessage(hint: CredentialWrongHint): string {
  return hint === 'current-password'
    ? 'Incorrect password. Please try again.'
    : 'Incorrect email or password.';
}

/**
 * Returns a short, non-technical message suitable for Alert.alert body text.
 */
export function userFacingErrorMessage(
  error: unknown,
  fallback: string = DEFAULT,
  options?: { credentialHint?: CredentialWrongHint }
): string {
  const code = getCode(error);
  const hint = options?.credentialHint ?? 'sign-in';
  if (code && WRONG_CREDENTIAL_CODES.has(code)) {
    return wrongCredentialMessage(hint);
  }
  if (code) {
    if (AUTH[code]) return AUTH[code];
    if (code.startsWith('auth/')) return fallback;
    if (FIRESTORE[code]) return FIRESTORE[code];
    if (STORAGE[code]) return STORAGE[code];
    if (code.startsWith('storage/')) return fallback;
  }
  const raw = getMessage(error);
  if (raw && raw.trim().length > 0) {
    if (looksLikeFirebaseOrSdkJargon(raw)) return fallback;
    if (raw.length <= 220) return raw;
  }
  return fallback;
}
