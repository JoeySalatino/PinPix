// ============================================================
// push-notification-nav.ts — Parse Expo push payloads and route
// to the correct screen when the user taps a notification.
// ============================================================

import {
  DEFAULT_ACTION_IDENTIFIER,
  type NotificationResponse,
} from 'expo-notifications';
import type { Router } from 'expo-router';
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';

export type ParsedPushData = {
  type: string;
  actorUid?: string;
  spotId?: string;
  commentId?: string;
};

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

const handledNotificationIds = new Set<string>();

export function parsePushData(
  data: Record<string, unknown> | undefined | null
): ParsedPushData | null {
  if (!data || typeof data !== 'object') return null;
  const type = data.type != null ? String(data.type).trim() : '';
  if (!type) return null;

  const actorUid =
    data.userId != null
      ? String(data.userId)
      : data.fromUid != null
        ? String(data.fromUid)
        : undefined;

  return {
    type,
    actorUid,
    spotId: data.spotId != null ? String(data.spotId) : undefined,
    commentId: data.commentId != null ? String(data.commentId) : undefined,
  };
}

export function parsePushNotificationResponse(
  response: NotificationResponse | null | undefined
): ParsedPushData | null {
  if (!response) return null;
  if (response.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) return null;
  const raw = response.notification.request.content.data as
    | Record<string, unknown>
    | undefined;
  return parsePushData(raw);
}

export function getNotificationId(response: NotificationResponse): string {
  return response.notification.request.identifier;
}

export function markPushNotificationHandled(id: string): void {
  handledNotificationIds.add(id);
}

export function isPushNotificationHandled(id: string): boolean {
  return handledNotificationIds.has(id);
}

async function navigateToUserProfile(
  router: Pick<Router, 'navigate' | 'replace' | 'push'>,
  uid: string,
  replace: boolean
): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) {
    const go = replace ? router.replace.bind(router) : router.navigate.bind(router);
    go('/social');
    return true;
  }
  const d = snap.data();
  const slug = String(d.username ?? d.displayUsername ?? 'user').toLowerCase();
  const go = replace ? router.replace.bind(router) : router.navigate.bind(router);
  go(`/user/${slug}`);
  return true;
}

/** Returns true when navigation was performed for a known push type. */
export async function navigateFromPushNotification(
  router: Pick<Router, 'navigate' | 'replace' | 'push'>,
  parsed: ParsedPushData,
  opts?: { replace?: boolean }
): Promise<boolean> {
  const replace = opts?.replace ?? false;
  const go = replace ? router.replace.bind(router) : router.navigate.bind(router);
  const { type, actorUid, spotId, commentId } = parsed;

  if (SPOT_PUSH_TYPES.has(type)) {
    if (!spotId) return false;
    const cid = commentId?.trim();
    go({
      pathname: '/spot/[id]',
      params: cid ? { id: spotId, focusCommentId: cid } : { id: spotId },
    });
    return true;
  }

  if (type === 'weekly_digest') {
    go('/weekly-review');
    return true;
  }

  if (SOCIAL_REQUEST_TYPES.has(type)) {
    go({ pathname: '/social', params: { focus: 'requests' } });
    return true;
  }

  if (PROFILE_PUSH_TYPES.has(type)) {
    if (!actorUid) return false;
    await navigateToUserProfile(router, actorUid, replace);
    return true;
  }

  return false;
}
