import Constants from 'expo-constants';

/** Google Static Maps preview for grid tiles (uses the same Places API key). */
export function spotStaticMapPreviewUrl(
  latitude: number,
  longitude: number,
  sidePx: number
): string | null {
  const key = (Constants.expoConfig?.extra?.googlePlacesKey as string | undefined)?.trim();
  if (!key) return null;
  const dim = Math.max(120, Math.min(640, Math.ceil(sidePx * 2)));
  const marker = `color:0xE35C25%7C${latitude},${longitude}`;
  const params = new URLSearchParams({
    center: `${latitude},${longitude}`,
    zoom: '15',
    size: `${dim}x${dim}`,
    scale: '2',
    maptype: 'roadmap',
    markers: marker,
    key,
  });
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}
