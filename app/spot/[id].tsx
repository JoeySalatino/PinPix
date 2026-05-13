// ============================================================
// spot/[id].tsx — Open a shared spot (pinpix://spot/{id})
// ------------------------------------------------------------
// Resolves the Firestore spot, then sends the user to the map
// with ?spotId= so HomeScreen opens SpotPeek. Signed-out users
// stash the id and continue after login (see deferred-spot-link).
// ============================================================

import { useLocalSearchParams, useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { auth, db } from '../../utils/firebase';
import { captureError } from '../../utils/sentry';
import { setDeferredSpotId } from '../../utils/deferred-spot-link';

function waitForInitialAuth(): Promise<import('firebase/auth').User | null> {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

export default function SpotDeepLinkScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const raw = Array.isArray(id) ? id[0] : id;
    const spotId = typeof raw === 'string' ? raw.trim() : '';

    void (async () => {
      if (!spotId) {
        router.replace('/main');
        return;
      }

      try {
        const user = await waitForInitialAuth();
        if (cancelled) return;

        if (!user) {
          await setDeferredSpotId(spotId);
          router.replace('/login');
          return;
        }

        const snap = await getDoc(doc(db, 'spots', spotId));
        if (cancelled) return;

        if (!snap.exists()) {
          Alert.alert('Spot unavailable', 'This spot may have been removed.');
          router.replace('/main');
          return;
        }

        const data = snap.data();
        const loc = data?.location;
        if (
          !loc ||
          typeof loc.latitude !== 'number' ||
          typeof loc.longitude !== 'number'
        ) {
          router.replace('/main');
          return;
        }

        router.replace({
          pathname: '/main',
          params: { spotId },
        });
      } catch (e) {
        if (!cancelled) {
          captureError(e, { area: 'SpotDeepLinkScreen', spotId });
          router.replace('/main');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, router]);

  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: '#112337',
      }}
    >
      <ActivityIndicator size="large" color="#E35C25" />
    </View>
  );
}
