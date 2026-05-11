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
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { auth } from '../utils/firebase';
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
      if (user && user.emailVerified) {
        // Attach user to Sentry so crashes are linked to their account
        setSentryUser(user.uid, user.email || undefined);

        const onboardingDone = await AsyncStorage.getItem('onboarding_complete');
        if (!onboardingDone) {
          router.replace('/onboarding');
        } else {
          router.replace('/home');
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