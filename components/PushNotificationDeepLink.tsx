// ============================================================
// PushNotificationDeepLink.tsx — Open the right screen when the
// user taps a remote notification (Expo push `data.type`).
// ------------------------------------------------------------
// Handles: friend_request, friend_added, nearby_spot, spot_activity,
// weekly_digest (see Cloud Functions push payloads).
// Requires sign-in (Firestore user reads are auth-gated).
// ============================================================

import {
  DEFAULT_ACTION_IDENTIFIER,
  useLastNotificationResponse,
} from 'expo-notifications';
import { useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useRef } from 'react';
import { auth, db } from '../utils/firebase';
import { captureError } from '../utils/sentry';

function parsePushData(data: Record<string, unknown> | undefined | null): {
  type?: string;
  fromUid?: string;
  userId?: string;
  spotId?: string;
} {
  if (!data || typeof data !== 'object') return {};
  return {
    type: data.type != null ? String(data.type) : undefined,
    fromUid: data.fromUid != null ? String(data.fromUid) : undefined,
    userId: data.userId != null ? String(data.userId) : undefined,
    spotId: data.spotId != null ? String(data.spotId) : undefined,
  };
}

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

  useEffect(() => {
    if (lastResponse === undefined || lastResponse === null) return;
    if (lastResponse.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) return;

    const raw = lastResponse.notification.request.content.data as Record<string, unknown> | undefined;
    const { type, userId, spotId } = parsePushData(raw);
    if (
      type !== 'friend_request' &&
      type !== 'friend_added' &&
      type !== 'nearby_spot' &&
      type !== 'spot_activity' &&
      type !== 'weekly_digest'
    ) {
      return;
    }

    const notificationId = lastResponse.notification.request.identifier;
    if (handledNotificationId.current === notificationId) return;

    let cancelled = false;

    void (async () => {
      try {
        const user = await waitForInitialAuth();
        if (cancelled || !user) return;

        if (type === 'nearby_spot' || type === 'spot_activity') {
          if (!spotId) return;
          handledNotificationId.current = notificationId;
          router.navigate({ pathname: '/main', params: { spotId } });
          return;
        }

        if (type === 'weekly_digest') {
          handledNotificationId.current = notificationId;
          router.navigate('/main');
          return;
        }

        if (type === 'friend_request') {
          handledNotificationId.current = notificationId;
          router.navigate({ pathname: '/social', params: { focus: 'requests' } });
          return;
        }

        if (type === 'friend_added') {
          if (!userId) return;
          try {
            const snap = await getDoc(doc(db, 'users', userId));
            if (cancelled) return;
            handledNotificationId.current = notificationId;
            if (!snap.exists()) {
              router.navigate('/social');
              return;
            }
            const d = snap.data();
            const slug = String(d.username ?? d.displayUsername ?? 'user').toLowerCase();
            router.navigate(`/user/${slug}`);
          } catch (e) {
            handledNotificationId.current = notificationId;
            captureError(e, { area: 'PushNotificationDeepLink.friend_added', userId });
            router.navigate('/social');
          }
          return;
        }
      } catch (e) {
        captureError(e, { area: 'PushNotificationDeepLink', type: type ?? '' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lastResponse, router]);

  return null;
}
