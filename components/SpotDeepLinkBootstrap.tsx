// ============================================================
// SpotDeepLinkBootstrap.tsx — Handle pinpix links while app runs
// ------------------------------------------------------------
// Cold start is handled in app/index.tsx via getInitialURL().
// This listens for Linking "url" when the app is already open
// (e.g. user returns from Safari after tapping a share link).
// ============================================================

import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { parseSpotIdFromDeepLinkUrl } from '../utils/spot-deep-link';

export default function SpotDeepLinkBootstrap() {
  const router = useRouter();

  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) => {
      const id = parseSpotIdFromDeepLinkUrl(url);
      if (!id) return;
      router.replace({ pathname: '/spot/[id]', params: { id } });
    });
    return () => sub.remove();
  }, [router]);

  return null;
}
