// ============================================================
// PushNotificationDeepLink.tsx — Open the right screen when the
// user taps a remote notification (Expo push `data.type`).
// ------------------------------------------------------------
// Handles: follow_request, follow_request_accepted, friend_request, new_follower, friend_added,
// nearby_spot, spot_activity, comment_activity (comment / reply / spot_reply / mention / comment_like),
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
  commentId?: string;
} {
  if (!data || typeof data !== 'object') return {};
  return {
    type: data.type != null ? String(data.type) : undefined,
    fromUid: data.fromUid != null ? String(data.fromUid) : undefined,
    userId: data.userId != null ? String(data.userId) : undefined,
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

export default function PushNotificationDeepLink() {
  const router = useRouter();
  const lastResponse = useLastNotificationResponse();
  const handledNotificationId = useRef<string | null>(null);

  useEffect(() => {
    if (lastResponse === undefined || lastResponse === null) return;
    if (lastResponse.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) return;

    const raw = lastResponse.notification.request.content.data as Record<string, unknown> | undefined;
    const { type, userId, spotId, commentId } = parsePushData(raw);
    if (
      type !== 'follow_request' &&
      type !== 'follow_request_accepted' &&
      type !== 'friend_request' &&
      type !== 'new_follower' &&
      type !== 'friend_added' &&
      type !== 'nearby_spot' &&
      type !== 'spot_activity' &&
      type !== 'comment_activity' &&
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

        if (type === 'nearby_spot' || type === 'spot_activity' || type === 'comment_activity') {
          if (!spotId) return;
          handledNotificationId.current = notificationId;
          const cid = commentId?.trim();
          router.navigate({
            pathname: '/main',
            params: cid ? { spotId, focusCommentId: cid } : { spotId },
          });
          return;
        }

        if (type === 'weekly_digest') {
          handledNotificationId.current = notificationId;
          router.navigate('/main');
          return;
        }

        if (type === 'follow_request' || type === 'friend_request') {
          handledNotificationId.current = notificationId;
          router.navigate({ pathname: '/social', params: { focus: 'requests' } });
          return;
        }

        if (type === 'follow_request_accepted') {
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
            captureError(e, { area: 'PushNotificationDeepLink.follow_request_accepted', userId });
            router.navigate('/social');
          }
          return;
        }

        if (type === 'new_follower' || type === 'friend_added') {
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
            captureError(e, { area: 'PushNotificationDeepLink.new_follower', userId });
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
