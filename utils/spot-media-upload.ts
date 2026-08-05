// ============================================================
// spot-media-upload.ts — Detect media kind + Storage upload meta
// ============================================================

import type * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import type { SpotMediaKind } from '../components/types';
import { isVideoMediaUrl } from '../components/types';

/** Max clip length when posting a video (seconds). */
export const MAX_SPOT_VIDEO_DURATION_SEC = 60;
/** Client-side size guard before upload (bytes). Storage rules allow up to 75 MB. */
export const MAX_SPOT_VIDEO_BYTES = 70 * 1024 * 1024;

export function mediaKindFromAsset(asset: ImagePicker.ImagePickerAsset): SpotMediaKind {
  if (asset.type === 'video') return 'video';
  if (asset.type === 'image') return 'image';
  if (typeof asset.duration === 'number' && asset.duration > 0) return 'video';
  if (isVideoMediaUrl(asset.uri)) return 'video';
  return 'image';
}

export function mediaKindFromUrl(url: string): SpotMediaKind {
  return isVideoMediaUrl(url) ? 'video' : 'image';
}

/** Validate a picked video before adding it to the draft gallery. */
export function validateSpotVideoAsset(
  asset: ImagePicker.ImagePickerAsset
): { ok: true } | { ok: false; error: string } {
  const durationSec =
    typeof asset.duration === 'number' && asset.duration > 0
      ? asset.duration > 1000
        ? asset.duration / 1000
        : asset.duration
      : null;
  if (durationSec != null && durationSec > MAX_SPOT_VIDEO_DURATION_SEC) {
    return {
      ok: false,
      error: `Videos must be ${MAX_SPOT_VIDEO_DURATION_SEC} seconds or shorter.`,
    };
  }
  if (typeof asset.fileSize === 'number' && asset.fileSize > MAX_SPOT_VIDEO_BYTES) {
    return { ok: false, error: 'That video is too large. Try one under about 70 MB.' };
  }
  return { ok: true };
}

export function storageMetaForMedia(
  kind: SpotMediaKind,
  localUri: string,
  blobType?: string
): { ext: string; contentType: string } {
  if (kind === 'video') {
    const lower = localUri.toLowerCase();
    const fromBlob = (blobType || '').toLowerCase();
    if (fromBlob.includes('quicktime') || lower.includes('.mov')) {
      return { ext: 'mov', contentType: 'video/quicktime' };
    }
    if (fromBlob.includes('webm') || lower.includes('.webm')) {
      return { ext: 'webm', contentType: 'video/webm' };
    }
    if (fromBlob.startsWith('video/')) {
      return { ext: 'mp4', contentType: fromBlob };
    }
    return { ext: 'mp4', contentType: 'video/mp4' };
  }
  if ((blobType || '').startsWith('image/')) {
    const ext =
      blobType === 'image/png' ? 'png' : blobType === 'image/webp' ? 'webp' : 'jpg';
    return { ext, contentType: blobType! };
  }
  return { ext: 'jpg', contentType: 'image/jpeg' };
}

/** Grab a still frame near the start of a local video for grid / Saves thumbs. */
export async function generateLocalVideoPosterUri(videoUri: string): Promise<string | null> {
  try {
    const { uri } = await VideoThumbnails.getThumbnailAsync(videoUri, {
      time: 400,
      quality: 0.7,
    });
    return uri || null;
  } catch {
    return null;
  }
}
