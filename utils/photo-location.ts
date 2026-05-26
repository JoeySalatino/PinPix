import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { captureError } from './sentry';

/** Convert a single EXIF GPS component (decimal or DMS) to decimal degrees. */
function exifComponentToDegrees(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length > 0) {
    const parts = value.map((part) => {
      if (typeof part === 'number' && Number.isFinite(part)) return part;
      if (Array.isArray(part) && part.length >= 2) {
        const num = Number(part[0]);
        const den = Number(part[1]);
        if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
      }
      const n = Number(part);
      return Number.isFinite(n) ? n : null;
    });
    if (parts.some((p) => p === null)) return null;
    const [deg, min = 0, sec = 0] = parts as number[];
    return deg + min / 60 + sec / 3600;
  }
  return null;
}

function applyGpsRef(degrees: number, ref: unknown, negativeRef: string): number {
  if (ref === negativeRef) return -Math.abs(degrees);
  return degrees;
}

/**
 * Parse EXIF GPS into decimal degrees. Handles signed decimals and DMS arrays.
 * Returns null when no usable GPS is present (including stripped 0,0 on Android).
 */
export function extractGpsFromExif(
  exif: Record<string, unknown> | null | undefined
): { latitude: number; longitude: number } | null {
  if (!exif) return null;

  const rawLat = exif.GPSLatitude;
  const rawLon = exif.GPSLongitude;
  let latitude = exifComponentToDegrees(rawLat);
  let longitude = exifComponentToDegrees(rawLon);

  if (latitude === null || longitude === null) return null;
  if (latitude === 0 && longitude === 0) return null;

  latitude = applyGpsRef(latitude, exif.GPSLatitudeRef, 'S');
  longitude = applyGpsRef(longitude, exif.GPSLongitudeRef, 'W');

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

/** On Android, request photo + media-location access needed for gallery GPS. */
export async function ensureAndroidPhotoLocationAccess(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const { granted } = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
  return granted;
}

/**
 * Resolve GPS for a picked image: EXIF from image-picker, then MediaLibrary on Android.
 */
export async function resolvePhotoGps(
  asset: ImagePicker.ImagePickerAsset
): Promise<{ latitude: number; longitude: number } | null> {
  const fromPickerExif = extractGpsFromExif(asset.exif as Record<string, unknown> | undefined);
  if (fromPickerExif) return fromPickerExif;

  if (Platform.OS !== 'android' || !asset.assetId) return null;

  try {
    const info = await MediaLibrary.getAssetInfoAsync(asset.assetId);
    const loc = info.location;
    if (
      loc &&
      Number.isFinite(loc.latitude) &&
      Number.isFinite(loc.longitude) &&
      !(loc.latitude === 0 && loc.longitude === 0)
    ) {
      return { latitude: loc.latitude, longitude: loc.longitude };
    }
    return extractGpsFromExif(info.exif as Record<string, unknown> | undefined);
  } catch (err) {
    captureError(err, { area: 'resolvePhotoGps.getAssetInfoAsync' });
    return null;
  }
}
