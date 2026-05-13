// ============================================================
// index.tsx — App Entry Point
// ------------------------------------------------------------
// Checks auth state and routes to the correct screen.
// Also handles:
//   - Holding the splash screen until auth resolves
//   - Attaching the signed-in user to Sentry (see utils/sentry)
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { appScreenBackground } from '../constants/theme';
import { auth, db } from '../utils/firebase';
import { clearDeferredSpotId, peekDeferredSpotId } from '../utils/deferred-spot-link';
import { setSentryUser } from '../utils/sentry';
import { parseSpotIdFromDeepLinkUrl } from '../utils/spot-deep-link';
import { useTheme } from '../utils/theme-context';

// ---- Keep splash visible until we're ready ----
// This must be called before any rendering happens.
// We call preventAutoHideAsync() at the module level so it runs
// immediately when the file is imported, before React mounts.
SplashScreen.preventAutoHideAsync();

export default function Index() {
  const router = useRouter();
  const { isDark } = useTheme();
  const screenBg = appScreenBackground(isDark);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      let initialUrl: string | null = null;
      try {
        initialUrl = await Linking.getInitialURL();
      } catch {
        initialUrl = null;
      }
      const spotFromUrl = parseSpotIdFromDeepLinkUrl(initialUrl);

      if (!user) {
        if (spotFromUrl) {
          router.replace({ pathname: '/spot/[id]', params: { id: spotFromUrl } });
        } else {
          router.replace('/login');
        }
        setChecking(false);
        setTimeout(() => SplashScreen.hideAsync(), 100);
        return;
      }

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
      } else if (spotFromUrl) {
        // Prefer shared spot over home (Expo Router iOS can drop cold-start deep links).
        router.replace({ pathname: '/spot/[id]', params: { id: spotFromUrl } });
      } else {
        const onboardingDone = await AsyncStorage.getItem('onboarding_complete');
        if (!onboardingDone) {
          router.replace('/onboarding');
        } else {
          const deferred = await peekDeferredSpotId();
          if (deferred) {
            await clearDeferredSpotId();
            router.replace({ pathname: '/main', params: { spotId: deferred } });
          } else {
            router.replace('/main');
          }
        }
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
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: screenBg }}>
        <ActivityIndicator size="large" color="#E35C25" />
      </View>
    );
  }

  return null;
}