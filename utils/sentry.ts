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
// ============================================================
export function captureError(error: any, context?: Record<string, any>) {
  if (context) Sentry.setContext('extra', context);
  Sentry.captureException(error);
}