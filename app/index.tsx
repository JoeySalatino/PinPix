// ============================================================
// index.tsx — App Entry Point
// ------------------------------------------------------------
// Checks auth state and routes to the correct screen.
// Also handles:
//   - Holding the splash screen until auth resolves
//   - Attaching the signed-in user to Sentry (see utils/sentry)
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { auth, db } from '../utils/firebase';
import { setSentryUser } from '../utils/sentry';

// ---- Keep splash visible until we're ready ----
// This must be called before any rendering happens.
// We call preventAutoHideAsync() at the module level so it runs
// immediately when the file is imported, before React mounts.
SplashScreen.preventAutoHideAsync();

export default function Index() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      if (user) {
        // Attach user to Sentry so crashes are linked to their account.
        // We let unverified users in — verification is gated at the
        // "create a spot" step (see add-spot screen) instead of at login.
        setSentryUser(user.uid, user.email || undefined);

        // First-time social sign-in: if the user is authenticated but doesn't
        // have a Firestore profile doc yet, send them to pick a username.
        // Email/password signups always create the doc inline, so they skip this.
        const profileSnap = await getDoc(doc(db, 'users', user.uid));
        if (!profileSnap.exists()) {
          router.replace('/complete-profile');
        } else {
          const onboardingDone = await AsyncStorage.getItem('onboarding_complete');
          if (!onboardingDone) {
            router.replace('/onboarding');
          } else {
            router.replace('/home');
          }
        }
      } else {
        router.replace('/login');
      }

      setChecking(false);

      // Hide the splash screen now that we know where to send the user.
      // The slight delay gives the router time to begin the transition
      // so there's no white flash between splash and the first screen.
      setTimeout(() => SplashScreen.hideAsync(), 100);
    });

    return unsub;
  }, [router]);

  if (checking) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#112337' }}>
        <ActivityIndicator size="large" color="#E35C25" />
      </View>
    );
  }

  return null;
}