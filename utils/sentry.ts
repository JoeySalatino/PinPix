// ============================================================
// utils/sentry.ts — Sentry Error Tracking Setup
// ------------------------------------------------------------
// Initializes Sentry for crash reporting and error tracking.
// Import and call initSentry() once at app startup (in index.tsx).
//
// Setup steps:
//   1. Run: npx expo install @sentry/react-native
//   2. Create a project at sentry.io
//   3. Add SENTRY_DSN to your .env file
//   4. Add SENTRY_PROJECT and SENTRY_ORG to .env (for source maps)
// ============================================================

import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

export function initSentry() {
  const dsn = Constants.expoConfig?.extra?.sentryDsn;
  const sentryExtra = (Constants.expoConfig?.extra?.sentry ?? {}) as Partial<{
    sendDefaultPii: boolean;
    enableLogs: boolean;
    replaysSessionSampleRate: number;
    replaysOnErrorSampleRate: number;
  }>;

  // Don't init if no DSN is configured (e.g. local dev without .env)
  if (!dsn) {
    console.log('[Sentry] No DSN configured — skipping init');
    return;
  }

  Sentry.init({
    dsn,
    // Set to 1.0 to capture 100% of transactions in production.
    // Lower this (e.g. 0.2) once you have more users to reduce quota usage.
    tracesSampleRate: 1.0,
    // Only enable debug logging in development
    debug: __DEV__,
    // Attach user context automatically (set after login — see below)
    enableAutoSessionTracking: true,
    sendDefaultPii: !!sentryExtra.sendDefaultPii,
    enableLogs: __DEV__ || !!sentryExtra.enableLogs,
    replaysSessionSampleRate: typeof sentryExtra.replaysSessionSampleRate === 'number' ? sentryExtra.replaysSessionSampleRate : 0.1,
    replaysOnErrorSampleRate: typeof sentryExtra.replaysOnErrorSampleRate === 'number' ? sentryExtra.replaysOnErrorSampleRate : 1,
    integrations: [Sentry.mobileReplayIntegration(), Sentry.feedbackIntegration()],
  });
}

// ============================================================
// Call this after a user logs in to attach their ID to errors.
// This makes it easy to look up which user experienced a crash.
// ============================================================
export function setSentryUser(uid: string, email?: string) {
  Sentry.setUser({ id: uid, email });
}

// ============================================================
// Call this after logout to clear user context from Sentry.
// ============================================================
export function clearSentryUser() {
  Sentry.setUser(null);
}

// ============================================================
// Use this to manually capture non-fatal errors that you want
// to track but that don't crash the app (e.g. failed uploads).
//
// Skips Firebase Auth "expected" outcomes (wrong password, rate limits on
// verification email, etc.) so Sentry doesn't email you for normal UX.
// Pass { force: true } to always report (rare).
// ============================================================

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const c = (error as { code?: unknown }).code;
  return typeof c === 'string' ? c : undefined;
}

/** Client-side auth / account outcomes we already show in an Alert — not product bugs. */
const SKIP_SENTRY_ERROR_CODES = new Set([
  'auth/too-many-requests', // e.g. resend verification email throttled
  'auth/user-not-found',
  'auth/wrong-password',
  'auth/invalid-credential',
  'auth/invalid-email',
  'auth/email-already-in-use',
  'auth/weak-password',
  'auth/user-disabled',
  'auth/requires-recent-login',
  'auth/invalid-verification-code',
  'auth/expired-action-code',
  'auth/missing-email',
  'auth/credential-already-in-use',
]);

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const code = typeof o.code === 'string' ? o.code : '';
    const message = typeof o.message === 'string' ? o.message : '';
    // Firebase and similar SDKs often throw { code, message } (not instanceof Error).
    const msg =
      code && message
        ? `[${code}] ${message}`
        : message || (code ? `[${code}]` : '') || JSON.stringify(value);
    const err = new Error(msg);
    err.name = typeof o.name === 'string' ? o.name : code ? 'FirebaseError' : 'NonErrorThrown';
    return err;
  }
  return new Error(String(value));
}

export function captureError(
  error: unknown,
  context?: Record<string, unknown>,
  opts?: { force?: boolean }
) {
  const code = getErrorCode(error);
  if (!opts?.force && code && SKIP_SENTRY_ERROR_CODES.has(code)) {
    return;
  }

  Sentry.withScope((scope) => {
    if (context) scope.setContext('extra', context);
    if (error && typeof error === 'object' && !(error instanceof Error)) {
      const o = error as Record<string, unknown>;
      if (typeof o.code === 'string') scope.setTag('error.code', o.code);
      if (typeof o.message === 'string') scope.setExtra('caught_message', o.message);
    }
    scope.captureException(toError(error));
  });
}