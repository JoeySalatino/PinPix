// ============================================================
// share.ts — Share helpers using the native iOS / Android share sheet
// ------------------------------------------------------------
// expo-sharing requires a file URI to share, which isn't great
// for spot links. We fall back to React Native's built-in Share
// API for text/URL sharing — works on both iOS (UIActivityViewController)
// and Android (ACTION_SEND).
// ============================================================

import { Share } from 'react-native';
import type { Spot } from '../components/types';
import { captureError } from './sentry';

// Universal link URL for a single spot. Used both for sharing and (later)
// for deep linking. Update the base URL once you set up your domain.
export function getSpotUrl(spot: Spot): string {
  return `https://pinpix.app/spot/${spot.id}`;
}

export async function shareSpot(spot: Spot): Promise<void> {
  const url = getSpotUrl(spot);
  const titleLine = spot.title ? `"${spot.title}"` : 'this photo spot';
  const message = `Check out ${titleLine} on PinPix — ${url}`;

  try {
    await Share.share(
      {
        // iOS uses `url` separately, Android puts everything in `message`
        message,
        url,
        title: spot.title || 'PinPix Spot',
      },
      {
        // iOS-only options
        subject: spot.title || 'PinPix Spot',
        dialogTitle: 'Share this spot',
      }
    );
  } catch (err) {
    captureError(err, { area: 'share.shareSpot', spotId: spot.id });
  }
}
