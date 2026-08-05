import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform } from 'react-native';
import { ensureAndroidPhotoLocationAccess } from './photo-location';

/** Keep original quality when picking so EXIF/GPS survives re-encode (upload compresses later). */
export const PICK_IMAGE_QUALITY = 1;

export type AndroidMediaLibrarySource = 'device' | 'google_photos';

type LaunchMediaLibraryOptions = ImagePicker.ImagePickerOptions & {
  /** When true (default), request Android photo-location access before opening the picker. */
  requestAndroidLocationAccess?: boolean;
  /** Skip the Android source sheet and use this source directly. */
  androidSource?: AndroidMediaLibrarySource;
};

/** Android-only: ask whether to browse on-device photos or Google Photos / cloud apps. */
export function pickAndroidMediaSource(): Promise<AndroidMediaLibrarySource | null> {
  return new Promise((resolve) => {
    Alert.alert(
      'Choose media source',
      'Device opens your on-phone gallery. Google Photos opens the Google Photos app (or a similar picker for cloud albums).',
      [
        { text: 'Device', onPress: () => resolve('device') },
        { text: 'Google Photos', onPress: () => resolve('google_photos') },
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      ],
      { cancelable: true, onDismiss: () => resolve(null) }
    );
  });
}

/**
 * Open the media library. On Android, shows a source picker (device vs Google Photos) first.
 * - Device → system photo picker (`legacy: false`)
 * - Google Photos → legacy intent picker (`legacy: true`) so cloud / Google Photos is available
 * Pass `mediaTypes: ['images', 'videos']` (or similar) to allow videos.
 */
export async function launchMediaLibraryAsync(
  options: LaunchMediaLibraryOptions = {}
): Promise<ImagePicker.ImagePickerResult> {
  const {
    requestAndroidLocationAccess = true,
    androidSource,
    ...pickerOptions
  } = options;

  if (Platform.OS !== 'android') {
    return ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      exif: true,
      quality: PICK_IMAGE_QUALITY,
      ...pickerOptions,
    });
  }

  const source = androidSource ?? (await pickAndroidMediaSource());
  if (!source) {
    return { canceled: true, assets: null };
  }

  if (requestAndroidLocationAccess) {
    await ensureAndroidPhotoLocationAccess();
  }

  return ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    exif: true,
    quality: PICK_IMAGE_QUALITY,
    ...pickerOptions,
    legacy: source === 'google_photos',
  });
}

export { requestPhotoLibraryPermission as requestMediaLibraryPermission } from './photo-location';
