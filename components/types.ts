export type Spot = {
  id: string;
  latitude: number;
  longitude: number;
  /** Primary image (first in the gallery). Kept for backwards compatibility. */
  imageUrl: string;
  /** When set, full ordered gallery for this spot (should include the primary URL first). */
  imageUrls?: string[];
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