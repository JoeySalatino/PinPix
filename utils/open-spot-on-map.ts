import type { Router } from 'expo-router';

type SpotMapTarget = {
  id: string;
  latitude: number;
  longitude: number;
};

/** Opens the Map tab centered on a spot (and SpotPeek when `spotId` resolves). */
export function navigateToSpotOnMap(
  router: Pick<Router, 'push' | 'replace'>,
  spot: SpotMapTarget,
  opts?: { replace?: boolean }
): void {
  const params = {
    spotId: spot.id,
    lat: String(spot.latitude),
    lng: String(spot.longitude),
    zoom: '0.012',
  };
  if (opts?.replace) {
    router.replace({ pathname: '/main', params });
  } else {
    router.push({ pathname: '/main', params });
  }
}
