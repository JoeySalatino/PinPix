// ============================================================
// PushNotificationDeepLink.tsx — Open the right screen when the
// user taps a remote notification (Expo push `data.type`).
// ------------------------------------------------------------
// Types: follow_request, follow_request_accepted, new_follower,
// nearby_spot, spot_activity, comment_activity, weekly_digest.
// Legacy: friend_request, friend_added (same destinations).
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

const SPOT_PUSH_TYPES = new Set([
  'nearby_spot',
  'spot_activity',
  'comment_activity',
]);

const SOCIAL_REQUEST_TYPES = new Set(['follow_request', 'friend_request']);

const PROFILE_PUSH_TYPES = new Set([
  'follow_request_accepted',
  'new_follower',
  'friend_added',
]);

function parsePushData(data: Record<string, unknown> | undefined | null): {
  type?: string;
  actorUid?: string;
  spotId?: string;
  commentId?: string;
} {
  if (!data || typeof data !== 'object') return {};
  const actorUid =
    data.userId != null
      ? String(data.userId)
      : data.fromUid != null
        ? String(data.fromUid)
        : undefined;
  return {
    type: data.type != null ? String(data.type) : undefined,
    actorUid,
    spotId: data.spotId != null ? String(data.spotId) : undefined,
    commentId: data.commentId != null ? String(data.commentId) : undefined,
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

async function navigateToUserProfile(
  router: ReturnType<typeof useRouter>,
  uid: string,
  cancelled: () => boolean
): Promise<void> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (cancelled()) return;
  if (!snap.exists()) {
    router.navigate('/social');
    return;
  }
  const d = snap.data();
  const slug = String(d.username ?? d.displayUsername ?? 'user').toLowerCase();
  router.navigate(`/user/${slug}`);
}

export default function PushNotificationDeepLink() {
  const router = useRouter();
  const lastResponse = useLastNotificationResponse();
  const handledNotificationId = useRef<string | null>(null);

  useEffect(() => {
    if (lastResponse === undefined || lastResponse === null) return;
    if (lastResponse.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) return;

    const raw = lastResponse.notification.request.content.data as Record<string, unknown> | undefined;
    const { type, actorUid, spotId, commentId } = parsePushData(raw);
    if (!type) return;

    const notificationId = lastResponse.notification.request.identifier;
    if (handledNotificationId.current === notificationId) return;

    let cancelled = false;
    const isCancelled = () => cancelled;

    void (async () => {
      try {
        const user = await waitForInitialAuth();
        if (isCancelled() || !user) return;

        if (SPOT_PUSH_TYPES.has(type)) {
          if (!spotId) return;
          handledNotificationId.current = notificationId;
          const cid = commentId?.trim();
          router.navigate({
            pathname: '/spot/[id]',
            params: cid ? { id: spotId, focusCommentId: cid } : { id: spotId },
          });
          return;
        }

        if (type === 'weekly_digest') {
          handledNotificationId.current = notificationId;
          router.navigate('/main');
          return;
        }

        if (SOCIAL_REQUEST_TYPES.has(type)) {
          handledNotificationId.current = notificationId;
          router.navigate({ pathname: '/social', params: { focus: 'requests' } });
          return;
        }

        if (PROFILE_PUSH_TYPES.has(type)) {
          if (!actorUid) return;
          try {
            await navigateToUserProfile(router, actorUid, isCancelled);
            if (!isCancelled()) handledNotificationId.current = notificationId;
          } catch (e) {
            handledNotificationId.current = notificationId;
            captureError(e, { area: 'PushNotificationDeepLink.profile', type, actorUid });
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
