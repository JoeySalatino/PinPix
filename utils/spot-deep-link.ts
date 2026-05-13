// ============================================================
// spot-deep-link.ts — Parse spot id from native launch URLs
// ------------------------------------------------------------
// Expo Router on iOS uses Linking.getLinkingURL() for the initial
// route; when it is empty the app falls back to "/" and the spot
// link is lost. We also read Linking.getInitialURL() in app/index
// and route here. Supports dev-client wrappers and both
// pinpix://spot/id and pinpix:///spot/id (three slashes).
// ============================================================

/**
 * Extract Firestore spot id from a launch / deep-link URL.
 */
export function parseSpotIdFromDeepLinkUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  let u = url.trim();
  if (!u) return null;

  try {
    if (u.startsWith('expo-development-client://')) {
      const parsed = new URL(u);
      const inner = parsed.searchParams.get('url');
      if (inner) return parseSpotIdFromDeepLinkUrl(decodeURIComponent(inner));
    }
  } catch {
    /* ignore */
  }

  // Prefer pinpix:///spot/{id} (empty host, path /spot/…)
  const triple = u.match(/pinpix:\/\/\/spot\/([^?#]+)/);
  if (triple?.[1]) {
    try {
      return decodeURIComponent(triple[1]);
    } catch {
      return triple[1];
    }
  }
  // pinpix://spot/{id} — URL parser treats "spot" as host
  const dual = u.match(/pinpix:\/\/spot\/([^?#]+)/i);
  if (dual?.[1]) {
    try {
      return decodeURIComponent(dual[1]);
    } catch {
      return dual[1];
    }
  }
  return null;
}

/** Canonical in-app / share-bridge deep link (three slashes, path /spot/{id}). */
export function spotDeepLinkForId(spotId: string): string {
  return `pinpix:///spot/${encodeURIComponent(spotId.trim())}`;
}
