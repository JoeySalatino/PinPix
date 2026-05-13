// ============================================================
// Map pin clustering — group spots that are the same place
// ------------------------------------------------------------
// Pins were previously keyed by lat/lng rounded to 4 decimals.
// Slightly different GPS picks still produced two pins. We merge
// any spots whose haversine distance is within this threshold.
// ============================================================

const EARTH_RADIUS_M = 6_371_000;

/** Spots closer than this (straight-line, surface) share one map pin. */
export const MAP_PIN_CLUSTER_THRESHOLD_METERS = 40;

export function haversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lng2 - lng1);
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

type Mappable = { id: string; latitude: number; longitude: number };

/**
 * Single-linkage clusters: if A is near B and B is near C, all three share a pin
 * (transitive), so chains of “almost same spot” still merge.
 */
export function clusterByDistanceMeters<T extends Mappable>(items: T[], thresholdM: number): T[][] {
  const n = items.length;
  if (n === 0) return [];
  if (n === 1) return [[items[0]]];

  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array(n).fill(0);

  function find(i: number): number {
    if (parent[i] !== i) parent[i] = find(parent[i]);
    return parent[i];
  }

  function union(i: number, j: number) {
    let ri = find(i);
    let rj = find(j);
    if (ri === rj) return;
    if (rank[ri] < rank[rj]) [ri, rj] = [rj, ri];
    parent[rj] = ri;
    if (rank[ri] === rank[rj]) rank[ri]++;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (
        haversineDistanceMeters(items[i].latitude, items[i].longitude, items[j].latitude, items[j].longitude) <=
        thresholdM
      ) {
        union(i, j);
      }
    }
  }

  const buckets = new Map<number, T[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let arr = buckets.get(r);
    if (!arr) {
      arr = [];
      buckets.set(r, arr);
    }
    arr.push(items[i]);
  }

  return [...buckets.values()];
}

export function centroidLatLng(spots: { latitude: number; longitude: number }[]): {
  latitude: number;
  longitude: number;
} {
  if (spots.length === 0) return { latitude: 0, longitude: 0 };
  let slat = 0;
  let slng = 0;
  for (const s of spots) {
    slat += s.latitude;
    slng += s.longitude;
  }
  const n = spots.length;
  return { latitude: slat / n, longitude: slng / n };
}
