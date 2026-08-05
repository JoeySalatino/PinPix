export type SpotMediaKind = 'image' | 'video';

export type Spot = {
  id: string;
  latitude: number;
  longitude: number;
  /** Primary image (first in the gallery). Kept for backwards compatibility. */
  imageUrl: string;
  /** When set, full ordered gallery for this spot (should include the primary URL first). */
  imageUrls?: string[];
  /**
   * Parallel to `imageUrls` / gallery order: `'image'` or `'video'`.
   * Optional for legacy spots — kind is inferred from the URL when missing.
   */
  mediaKinds?: SpotMediaKind[];
  /**
   * Parallel to gallery URLs: JPEG poster for video slots (empty string for photos).
   * Used for grid / Saves thumbs when the primary media is a video.
   */
  posterUrls?: string[];
  /** Convenience primary poster (usually `posterUrls[0]` when that item is a video). */
  posterUrl?: string;
  title: string;
  caption: string;
  address: string;
  username: string;
  userId: string;
  tags: string[];
};

/** Ordered gallery URLs for a spot (multi-photo field or legacy single `imageUrl`). */
export function spotGalleryUrls(spot: Pick<Spot, 'imageUrl' | 'imageUrls'>): string[] {
  const fromArray =
    spot.imageUrls?.filter((u) => typeof u === 'string' && u.trim().length > 0) ?? [];
  if (fromArray.length > 0) return fromArray;
  const one = spot.imageUrl?.trim();
  return one ? [one] : [];
}

/** True when a storage / download URL points at a video file. */
export function isVideoMediaUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const path = decodeURIComponent(url.split('?')[0]);
    return /\.(mp4|mov|m4v|webm|avi)$/i.test(path);
  } catch {
    return /\.(mp4|mov|m4v|webm|avi)(\?|$)/i.test(url);
  }
}

/** Whether gallery item at `index` is a video (uses `mediaKinds` when present). */
export function isSpotMediaVideo(
  spot: Pick<Spot, 'imageUrl' | 'imageUrls' | 'mediaKinds'>,
  index = 0
): boolean {
  const kinds = spot.mediaKinds;
  if (Array.isArray(kinds) && typeof kinds[index] === 'string') {
    return kinds[index] === 'video';
  }
  const urls = spotGalleryUrls(spot);
  return isVideoMediaUrl(urls[index]);
}

/** Image-only URLs from a spot gallery (for fullscreen zoom viewers). */
export function spotGalleryImageUrls(
  spot: Pick<Spot, 'imageUrl' | 'imageUrls' | 'mediaKinds'>
): string[] {
  return spotGalleryUrls(spot).filter((uri, i) => !isSpotMediaVideo(spot, i));
}

/**
 * Best still image for grids / bookmarks.
 * Prefers a video poster, else the first photo in the gallery, else primary URL.
 */
export function spotThumbnailUrl(
  spot: Pick<Spot, 'imageUrl' | 'imageUrls' | 'mediaKinds' | 'posterUrl' | 'posterUrls'>
): string {
  const primaryPoster = spot.posterUrl?.trim();
  if (primaryPoster) return primaryPoster;

  const urls = spotGalleryUrls(spot);
  const posters = spot.posterUrls;

  for (let i = 0; i < urls.length; i++) {
    if (isSpotMediaVideo(spot, i)) {
      const p = typeof posters?.[i] === 'string' ? posters[i].trim() : '';
      if (p) return p;
      continue;
    }
    return urls[i];
  }

  if (Array.isArray(posters)) {
    const any = posters.find((p) => typeof p === 'string' && p.trim().length > 0);
    if (any) return any.trim();
  }

  return urls[0] || spot.imageUrl || '';
}

/** Parse optional Firestore `mediaKinds` aligned with gallery URLs. */
export function parseSpotMediaKinds(
  raw: unknown,
  urls: string[]
): SpotMediaKind[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const kinds = raw.map((k, i) => {
    if (k === 'video' || k === 'image') return k as SpotMediaKind;
    return isVideoMediaUrl(urls[i] || '') ? 'video' : 'image';
  });
  return kinds;
}

/** Parse optional Firestore `posterUrls` (strings; blanks allowed for photo slots). */
export function parseSpotPosterUrls(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((p) => (typeof p === 'string' ? p : ''));
}
