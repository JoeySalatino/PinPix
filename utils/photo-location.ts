import * as ImagePicker from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';
import { captureError } from './sentry';

type GpsCoords = { latitude: number; longitude: number };

/** Parse "51/1" or "51.5" into a number. */
function parseRationalToken(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/')) {
    const [numStr, denStr] = trimmed.split('/');
    const num = Number(numStr);
    const den = Number(denStr);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
    return null;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Convert a single EXIF GPS component (decimal, DMS array, or rational string) to decimal degrees. */
function exifComponentToDegrees(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const commaParts = value.split(',').map((p) => p.trim()).filter(Boolean);
    if (commaParts.length >= 3) {
      const deg = parseRationalToken(commaParts[0]);
      const min = parseRationalToken(commaParts[1]);
      const sec = parseRationalToken(commaParts[2]);
      if (deg === null || min === null || sec === null) return null;
      return deg + min / 60 + sec / 3600;
    }
    return parseRationalToken(value);
  }
  if (Array.isArray(value) && value.length > 0) {
    const parts = value.map((part) => {
      if (typeof part === 'number' && Number.isFinite(part)) return part;
      if (Array.isArray(part) && part.length >= 2) {
        const num = Number(part[0]);
        const den = Number(part[1]);
        if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
      }
      return parseRationalToken(part);
    });
    if (parts.some((p) => p === null)) return null;
    const [deg, min = 0, sec = 0] = parts as number[];
    return deg + min / 60 + sec / 3600;
  }
  return null;
}

function applyGpsRef(degrees: number, ref: unknown, negativeRef: string): number {
  if (ref === negativeRef) return -Math.abs(degrees);
  if (negativeRef === 'S' && ref === 'N') return Math.abs(degrees);
  if (negativeRef === 'W' && ref === 'E') return Math.abs(degrees);
  return degrees;
}

function isValidGps(latitude: number, longitude: number): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude === 0 && longitude === 0) return false;
  if (latitude < -90 || latitude > 90) return false;
  if (longitude < -180 || longitude > 180) return false;
  return true;
}

type GpsCandidate = {
  lat: unknown;
  lon: unknown;
  latRef?: unknown;
  lonRef?: unknown;
};

function gpsCandidatesFromExif(exif: Record<string, unknown>): GpsCandidate[] {
  const out: GpsCandidate[] = [];
  const direct: GpsCandidate = {
    lat: exif.GPSLatitude ?? exif.gpsLatitude ?? exif.latitude ?? exif.Latitude,
    lon: exif.GPSLongitude ?? exif.gpsLongitude ?? exif.longitude ?? exif.Longitude,
    latRef: exif.GPSLatitudeRef ?? exif.gpsLatitudeRef,
    lonRef: exif.GPSLongitudeRef ?? exif.gpsLongitudeRef,
  };
  if (direct.lat != null || direct.lon != null) out.push(direct);

  for (const key of ['GPS', 'gps', '{GPS}']) {
    const nested = exif[key];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
    const g = nested as Record<string, unknown>;
    out.push({
      lat: g.GPSLatitude ?? g.Latitude ?? g.latitude,
      lon: g.GPSLongitude ?? g.Longitude ?? g.longitude,
      latRef: g.GPSLatitudeRef ?? g.LatitudeRef ?? g.latitudeRef,
      lonRef: g.GPSLongitudeRef ?? g.LongitudeRef ?? g.longitudeRef,
    });
  }
  return out;
}

function coordsFromCandidate(candidate: GpsCandidate): GpsCoords | null {
  if (candidate.lat == null || candidate.lon == null) return null;
  let latitude = exifComponentToDegrees(candidate.lat);
  let longitude = exifComponentToDegrees(candidate.lon);
  if (latitude === null || longitude === null) return null;
  latitude = applyGpsRef(latitude, candidate.latRef, 'S');
  longitude = applyGpsRef(longitude, candidate.lonRef, 'W');
  if (!isValidGps(latitude, longitude)) return null;
  return { latitude, longitude };
}

/**
 * Parse EXIF GPS into decimal degrees. Handles signed decimals, DMS arrays, rational strings,
 * and common Android/iOS key variants.
 */
export function extractGpsFromExif(
  exif: Record<string, unknown> | null | undefined
): GpsCoords | null {
  if (!exif) return null;
  for (const candidate of gpsCandidatesFromExif(exif)) {
    const coords = coordsFromCandidate(candidate);
    if (coords) return coords;
  }
  return null;
}

function coordsFromMediaLibraryLocation(
  loc: { latitude?: number; longitude?: number } | null | undefined
): GpsCoords | null {
  if (!loc) return null;
  const { latitude, longitude } = loc;
  if (!isValidGps(latitude ?? NaN, longitude ?? NaN)) return null;
  return { latitude: latitude!, longitude: longitude! };
}

/** Media-library + ACCESS_MEDIA_LOCATION on Android (needed for gallery GPS). */
export async function ensureAndroidPhotoLocationAccess(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const { granted } = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
  return granted;
}

/** Prefer MediaLibrary on Android so ACCESS_MEDIA_LOCATION is included with gallery access. */
export async function requestPhotoLibraryPermission(): Promise<boolean> {
  if (Platform.OS === 'android') {
    return ensureAndroidPhotoLocationAccess();
  }
  const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  return granted;
}

/** Resolve a MediaStore asset id from picker output (legacy/cloud URIs often omit assetId). */
export function resolveAndroidMediaAssetId(asset: ImagePicker.ImagePickerAsset): string | null {
  if (asset.assetId) return asset.assetId;
  const uri = asset.uri;
  if (!uri) return null;

  const mediaStore = uri.match(/content:\/\/media\/external(?:\/images|\/video)?\/media\/(\d+)/i);
  if (mediaStore?.[1]) return mediaStore[1];

  const documentId =
    uri.match(/document\/(?:image|video)%3A(\d+)/i) ?? uri.match(/document\/(?:image|video):(\d+)/i);
  if (documentId?.[1]) return documentId[1];

  return null;
}

async function resolveFromMediaLibrary(assetId: string): Promise<GpsCoords | null> {
  try {
    const info = await MediaLibrary.getAssetInfoAsync(assetId, {
      shouldDownloadFromNetwork: true,
    });
    const fromLocation = coordsFromMediaLibraryLocation(info.location);
    if (fromLocation) return fromLocation;
    return extractGpsFromExif(info.exif as Record<string, unknown> | undefined);
  } catch (err) {
    captureError(err, { area: 'resolvePhotoGps.getAssetInfoAsync', assetId });
    return null;
  }
}

/**
 * Resolve GPS for a picked image:
 * 1. EXIF attached by image-picker
 * 2. MediaLibrary asset location / EXIF (Android + iOS when asset id is known)
 */
export async function resolvePhotoGps(
  asset: ImagePicker.ImagePickerAsset
): Promise<GpsCoords | null> {
  const fromPickerExif = extractGpsFromExif(asset.exif as Record<string, unknown> | undefined);
  if (fromPickerExif) return fromPickerExif;

  const assetId =
    Platform.OS === 'android' ? resolveAndroidMediaAssetId(asset) : asset.assetId ?? null;
  if (!assetId) return null;

  return resolveFromMediaLibrary(assetId);
}

/** First asset in the list that has usable GPS metadata. */
export async function resolveFirstPhotoGps(
  assets: ImagePicker.ImagePickerAsset[]
): Promise<GpsCoords | null> {
  for (const asset of assets) {
    const coords = await resolvePhotoGps(asset);
    if (coords) return coords;
  }
  return null;
}
