// Persists the device GPS position to users/{uid} so Cloud Functions can
// match "nearby new spots" to the user's current location.

import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import ngeohash from 'ngeohash';
import { db } from './firebase';

const MIN_WRITE_MS = 90_000;
const MIN_MOVE_KM = 2;

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export type NearbyLocationPersistState = { t: number; la: number; lo: number } | null;

/** Returns updated last-persisted state, or `last` if skipped. */
export async function maybePersistUserNearbyLocation(
  uid: string,
  coords: { latitude: number; longitude: number },
  last: NearbyLocationPersistState
): Promise<NearbyLocationPersistState> {
  const now = Date.now();
  const la = coords.latitude;
  const lo = coords.longitude;
  if (
    last &&
    now - last.t < MIN_WRITE_MS &&
    haversineKm(last.la, last.lo, la, lo) < MIN_MOVE_KM
  ) {
    return last;
  }
  await updateDoc(doc(db, 'users', uid), {
    mapLat: la,
    mapLng: lo,
    mapGeohash5: ngeohash.encode(la, lo, 5),
    mapGeoAt: serverTimestamp(),
  });
  return { t: now, la, lo };
}
