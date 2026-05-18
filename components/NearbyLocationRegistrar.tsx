// ============================================================
// Keeps users/{uid} mapLat/mapLng in sync with device GPS while
// the app is foregrounded, for "nearby new spots" push matching.
// ============================================================

import * as Location from 'expo-location';
import { onAuthStateChanged } from 'firebase/auth';
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { auth } from '../utils/firebase';
import {
  maybePersistUserNearbyLocation,
  type NearbyLocationPersistState,
} from '../utils/nearby-location-profile';
import { captureError } from '../utils/sentry';

export default function NearbyLocationRegistrar() {
  const uidRef = useRef<string | null>(null);
  const lastRef = useRef<NearbyLocationPersistState>(null);
  const watchRef = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    let cancelled = false;

    const stopWatch = () => {
      watchRef.current?.remove();
      watchRef.current = null;
    };

    const persist = async (coords: { latitude: number; longitude: number }) => {
      const uid = uidRef.current;
      if (!uid || cancelled) return;
      try {
        lastRef.current = await maybePersistUserNearbyLocation(uid, coords, lastRef.current);
      } catch (e) {
        captureError(e, { area: 'NearbyLocationRegistrar.persist' });
      }
    };

    const startWatch = async () => {
      if (cancelled || watchRef.current) return;
      const { status } = await Location.getForegroundPermissionsAsync();
      if (status !== 'granted') return;

      try {
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        await persist(loc.coords);
      } catch (e) {
        captureError(e, { area: 'NearbyLocationRegistrar.initial' });
      }

      if (cancelled) return;

      watchRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: 250,
          timeInterval: 60_000,
        },
        (loc) => {
          void persist(loc.coords);
        }
      );
    };

    const unsubAuth = onAuthStateChanged(auth, (user) => {
      stopWatch();
      lastRef.current = null;
      uidRef.current = user?.uid ?? null;
      if (user && AppState.currentState === 'active') {
        void startWatch();
      }
    });

    const onAppState = (state: AppStateStatus) => {
      if (state === 'active' && uidRef.current) {
        void startWatch();
      } else {
        stopWatch();
      }
    };

    const appSub = AppState.addEventListener('change', onAppState);

    return () => {
      cancelled = true;
      unsubAuth();
      appSub.remove();
      stopWatch();
    };
  }, []);

  return null;
}
