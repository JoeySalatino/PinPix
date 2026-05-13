// ============================================================
// Expo Push — read tokens from Firestore, send via Expo API
// ============================================================

import Expo from 'expo-server-sdk';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

const expo = new Expo();

/** Must match utils/push-notifications.ts ANDROID_PUSH_CHANNEL_ID */
export const ANDROID_PUSH_CHANNEL_ID = 'default';

export type UserNotifyPrefs = {
  pushEnabled: boolean;
  pushFriendRequests: boolean;
  pushNearbySpots: boolean;
  pushFavoriteActivity: boolean;
  pushWeeklyDigest: boolean;
};

export async function getUserNotifyPrefs(uid: string): Promise<UserNotifyPrefs> {
  const snap = await getFirestore().doc(`users/${uid}`).get();
  if (!snap.exists) {
    return {
      pushEnabled: true,
      pushFriendRequests: true,
      pushNearbySpots: true,
      pushFavoriteActivity: true,
      pushWeeklyDigest: false,
    };
  }
  const d = snap.data() as Record<string, unknown>;
  return {
    pushEnabled: d.pushEnabled !== false,
    pushFriendRequests: d.pushFriendRequests !== false,
    pushNearbySpots: d.pushNearbySpots !== false,
    pushFavoriteActivity: d.pushFavoriteActivity !== false,
    pushWeeklyDigest: d.pushWeeklyDigest === true || d.emailDigest === true,
  };
}

export async function getExpoPushTokensForUser(uid: string): Promise<string[]> {
  const snap = await getFirestore().collection('users').doc(uid).collection('pushTokens').get();
  const out: string[] = [];
  for (const d of snap.docs) {
    const t = d.data().token;
    if (typeof t === 'string' && Expo.isExpoPushToken(t)) out.push(t);
  }
  return [...new Set(out)];
}

export async function sendPushToUser(
  uid: string,
  canSend: (prefs: UserNotifyPrefs) => boolean,
  payload: { title: string; body: string; data?: Record<string, string> }
): Promise<void> {
  const prefs = await getUserNotifyPrefs(uid);
  if (!canSend(prefs)) {
    logger.debug('Push skipped by prefs', { uid });
    return;
  }
  const tokens = await getExpoPushTokensForUser(uid);
  if (tokens.length === 0) {
    logger.debug('Push skipped — no Expo tokens', { uid });
    return;
  }
  const messages = tokens.map((to) => ({
    to,
    sound: 'default' as const,
    title: payload.title,
    body: payload.body,
    data: payload.data,
    channelId: ANDROID_PUSH_CHANNEL_ID,
  }));
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket) => {
        if (ticket.status === 'error') {
          logger.warn('Expo push ticket error', { uid, message: ticket.message, details: ticket.details });
        }
      });
    } catch (e) {
      logger.error('sendPushNotificationsAsync failed', e);
    }
  }
}

export async function displayNameForUser(uid: string): Promise<string> {
  const snap = await getFirestore().doc(`users/${uid}`).get();
  if (!snap.exists) return 'Someone';
  const d = snap.data() as Record<string, unknown>;
  return String(d.displayUsername || d.username || 'Someone');
}
