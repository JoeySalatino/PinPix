// ============================================================
// share.ts — Share helpers using the native iOS / Android share sheet
// ------------------------------------------------------------
// React Native's Share API is platform-picky: passing both `url` and
// `message` often breaks iOS (sheet opens empty or share fails). We
// share a single `message` string that includes the link — reliable
// on iOS and Android. Web uses the Web Share API or clipboard fallback.
// ============================================================

import Constants from 'expo-constants';
import { Alert, Platform, Share } from 'react-native';
import { pinpixLegalPagesRoot } from '../constants/legal';
import type { Spot } from '../components/types';
import { captureError } from './sentry';

function shareWebBase(): string | undefined {
  const raw = Constants.expoConfig?.extra?.shareWebBaseUrl;
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().replace(/\/$/, '');
  return t.length > 0 ? t : undefined;
}

/**
 * Public URL for shared spots. SMS/iMessage only auto-link http(s), not custom schemes.
 *
 * 1. EXPO_PUBLIC_SHARE_WEB_BASE_URL — your real site (e.g. https://pinpix.app) + /spot/{id}
 * 2. Otherwise — https page on pinpix-legal (`open-spot.html`) that redirects to pinpix://
 *    (deploy share-web/open-spot.html from this repo into that GitHub Pages repo).
 */
export function getSpotUrl(spot: Spot): string {
  const base = shareWebBase();
  if (base) return `${base}/spot/${encodeURIComponent(spot.id)}`;
  return `${pinpixLegalPagesRoot()}/open-spot.html?id=${encodeURIComponent(spot.id)}`;
}

async function shareOnWeb(title: string, message: string, url: string): Promise<void> {
  if (typeof navigator === 'undefined') return;

  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text: message, url });
      return;
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name;
      if (name === 'AbortError') return;
      captureError(err, { area: 'share.web.navigatorShare' });
    }
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(message);
      Alert.alert('Copied', 'Spot link copied to your clipboard.');
      return;
    }
  } catch (err) {
    captureError(err, { area: 'share.web.clipboard' });
  }

  Alert.alert('Share this spot', `${message}\n\n${url}`);
}

export async function shareSpot(spot: Spot): Promise<void> {
  if (!spot?.id?.trim()) {
    Alert.alert('Share unavailable', 'This spot is still loading. Try again in a moment.');
    return;
  }

  const url = getSpotUrl(spot);
  const titleLine = spot.title ? `"${spot.title}"` : 'this photo spot';
  // Put the https URL on its own line so iMessage / SMS data-detectors linkify it reliably.
  const message = `Check out ${titleLine} on PinPix:\n${url}`;
  const title = spot.title?.trim() || 'PinPix Spot';

  try {
    if (Platform.OS === 'web') {
      await shareOnWeb(title, message, url);
      return;
    }

    // One combined string avoids iOS bugs when `url` and `message` are both set.
    await Share.share(
      { message, title },
      Platform.OS === 'ios' ? { subject: title } : { dialogTitle: 'Share this spot' }
    );
  } catch (err: unknown) {
    const e = err as { message?: string };
    const msg = typeof e?.message === 'string' ? e.message : '';
    if (msg.includes('User did not share') || msg.includes('cancel')) {
      return;
    }
    captureError(err, { area: 'share.shareSpot', spotId: spot.id });
    Alert.alert('Could not share', 'Please try again, or copy the link from the spot details.');
  }
}
