// ============================================================
// deferred-spot-link.ts — Persist a spot deep link across login
// ------------------------------------------------------------
// When a signed-out user opens pinpix://spot/{id}, we stash the
// id here, send them to login, then resume on /main after auth.
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'pinpix_deferred_spot_id';

export async function setDeferredSpotId(id: string): Promise<void> {
  await AsyncStorage.setItem(KEY, id.trim());
}

export async function peekDeferredSpotId(): Promise<string | null> {
  const v = await AsyncStorage.getItem(KEY);
  return v?.trim() ? v.trim() : null;
}

export async function clearDeferredSpotId(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
