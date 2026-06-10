// ============================================================
// PushNotificationDeepLink.tsx — Open the right screen when the
// user taps a remote notification (Expo push `data.type`).
// ------------------------------------------------------------
// Types: follow_request, follow_request_accepted, new_follower,
// nearby_spot, spot_activity, comment_activity, weekly_digest.
// Legacy: friend_request, friend_added (same destinations).
// ============================================================

import {
  addNotificationResponseReceivedListener,
  DEFAULT_ACTION_IDENTIFIER,
  type NotificationResponse,
  useLastNotificationResponse,
} from 'expo-notifications';
import { useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { useEffect, useRef } from 'react';
import { auth } from '../utils/firebase';
import {
  getNotificationId,
  isPushNotificationHandled,
  markPushNotificationHandled,
  navigateFromPushNotification,
  parsePushNotificationResponse,
} from '../utils/push-notification-nav';
import { captureError } from '../utils/sentry';

/** Resolves once Firebase has delivered the initial auth state (or signed-out null). */
function waitForInitialAuth(): Promise<import('firebase/auth').User | null> {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

export default function PushNotificationDeepLink() {
  const router = useRouter();
  const lastResponse = useLastNotificationResponse();
  const handledNotificationId = useRef<string | null>(null);
  const inFlightRef = useRef<string | null>(null);

  useEffect(() => {
    const processResponse = (response: NotificationResponse | null | undefined) => {
      if (!response) return;
      if (response.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) return;

      const parsed = parsePushNotificationResponse(response);
      if (!parsed) return;

      const notificationId = getNotificationId(response);
      if (
        handledNotificationId.current === notificationId ||
        isPushNotificationHandled(notificationId) ||
        inFlightRef.current === notificationId
      ) {
        return;
      }

      inFlightRef.current = notificationId;
      let cancelled = false;

      void (async () => {
        try {
          const user = await waitForInitialAuth();
          if (cancelled || !user) return;

          const handled = await navigateFromPushNotification(router, parsed);
          if (cancelled || !handled) return;

          handledNotificationId.current = notificationId;
          markPushNotificationHandled(notificationId);
        } catch (e) {
          if (!cancelled) {
            captureError(e, {
              area: 'PushNotificationDeepLink',
              type: parsed.type,
            });
          }
        } finally {
          if (inFlightRef.current === notificationId) {
            inFlightRef.current = null;
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    };

    const cleanupLast = processResponse(lastResponse);
    const sub = addNotificationResponseReceivedListener((response) => {
      processResponse(response);
    });

    return () => {
      cleanupLast?.();
      sub.remove();
    };
  }, [lastResponse, router]);

  return null;
}
