// ============================================================
// Push notifications — Expo token registration + Firestore
// ------------------------------------------------------------
// Tokens live at users/{uid}/pushTokens/{id}. Cloud Functions read
// them and send via expo-server-sdk. Requires a dev/production build
// (not Expo Go) for real device tokens.
// ============================================================

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { collection, deleteDoc, doc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import { Platform } from 'react-native';
import { db } from './firebase';

/** Android channel id — must match Cloud Function payloads. */
export const ANDROID_PUSH_CHANNEL_ID = 'default';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function ensureAndroidPushChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_PUSH_CHANNEL_ID, {
    name: 'PinPix',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 250, 250, 250],
  });
}

/** Firestore-safe doc id derived from token (tokens may contain []). */
export function pushTokenDocId(token: string): string {
  return token.replace(/[/\s]/g, '_').slice(0, 200);
}

/**
 * Requests OS permission (if needed), obtains Expo push token, writes to
 * users/{uid}/pushTokens/{id}. Returns null if unavailable or denied.
 */
export async function registerAndUploadPushToken(uid: string): Promise<string | null> {
  if (!Device.isDevice) return null;

  const { status: existing } = await Notifications.getPermissionsAsync();
  let final = existing;
  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    final = status;
  }
  if (final !== 'granted') return null;

  await ensureAndroidPushChannel();

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) {
    console.warn('[push] Missing expo.extra.eas.projectId — cannot obtain Expo push token.');
    return null;
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  const docId = pushTokenDocId(token);
  await setDoc(
    doc(db, 'users', uid, 'pushTokens', docId),
    {
      token,
      platform: Platform.OS,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );
  return token;
}

/** Removes all stored Expo tokens (e.g. user disabled push in Settings). */
export async function removeAllPushTokens(uid: string): Promise<void> {
  const snap = await getDocs(collection(db, 'users', uid, 'pushTokens'));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
}
