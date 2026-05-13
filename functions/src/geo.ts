import ngeohash from 'ngeohash';

const EARTH_KM = 6371;

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Geohash precision 5 (~5 km cells) plus the eight adjacent cells. */
export function geohash5Neighborhood(lat: number, lng: number): string[] {
  const center = ngeohash.encode(lat, lng, 5);
  const neigh = ngeohash.neighbors(center) as string[];
  return [...new Set([center, ...neigh])];
}
