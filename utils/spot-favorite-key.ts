// ============================================================
// Legacy map favorite pin key (users/{uid}.favorites).
// ------------------------------------------------------------
// Stored on users/{uid}.favorites as strings: lat/lng rounded to
// 4 decimals, joined with a single hyphen (longitude may be negative,
// so the string can contain "--" between the two numbers).
// ============================================================

export function spotFavoriteKey(spot: { latitude: number; longitude: number }): string {
  return `${spot.latitude.toFixed(4)}-${spot.longitude.toFixed(4)}`;
}

/** Recover coordinates from a favorites[] entry for opening the map or orphan UI. */
export function parseFavoriteKey(key: string): { latitude: number; longitude: number } | null {
  const m = key.trim().match(/^(-?\d+\.\d{4})-(-?\d+\.\d{4})$/);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}
