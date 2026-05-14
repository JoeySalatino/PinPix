// ============================================================
// AddSpotScreen.tsx — Create or edit a spot
// ------------------------------------------------------------
// Create: post a new spot (`addDoc`) with photos in Storage.
// Edit: `/edit-spot/[id]` redirects here with `?edit=id`. Owner loads the doc,
// changes fields, `updateDoc`; images removed from the gallery are deleted from Storage.
// Form: title, description, address search, tags, photos, map pin.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { sendEmailVerification } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';
import { spotGalleryUrls } from '../components/types';
import { BRAND } from '../constants/brand';
import { appScreenBackground } from '../constants/theme';
import {
  MAX_TAGS_PER_SPOT,
  MAX_TAG_LENGTH,
  TAGS,
  dedupeTagsForSpot,
  normalizeTagInput,
} from '../constants/tags';
import { auth, db, storage } from '../utils/firebase';
import { deleteStorageObjectsByUrls } from '../utils/storage-delete';
import { captureError } from '../utils/sentry';
import { useTheme } from '../utils/theme-context';

// Read the Google Places API key from app.config.js extra fields
const GOOGLE_PLACES_API_KEY = Constants.expoConfig?.extra?.googlePlacesKey || '';

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

type LocalPhoto = { key: string; uri: string; /** Already stored in Firebase Storage */ remoteUrl?: string };

const MAX_SPOT_PHOTOS = 12;
const MAX_SPOT_TITLE_LENGTH = 200;

export default function AddSpotScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const screenBg = appScreenBackground(isDark);
  const { edit: editParam } = useLocalSearchParams<{ edit?: string | string[] }>();
  const editSpotId = Array.isArray(editParam) ? editParam[0] : editParam;

  // ---- Form state ----
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [customTagInput, setCustomTagInput] = useState('');

  // ---- Map/location state ----
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [region, setRegion] = useState<Region | null>(null); // The visible area of the map

  // ---- Photo state ----
  const [images, setImages] = useState<LocalPhoto[]>([]);
  /** True when the current map location was auto-filled from photo EXIF GPS. */
  const [locationFromPhoto, setLocationFromPhoto] = useState(false);

  // ---- Address autocomplete results ----
  const [searchResults, setSearchResults] = useState<any[]>([]);

  // ---- Loading state ----
  const [saving, setSaving] = useState(false);
  /** When `editSpotId` is set, true until Firestore spot is loaded into the form. */
  const [editSpotLoading, setEditSpotLoading] = useState(!!editSpotId);
  /** URLs that were on the doc when edit mode loaded (used to delete removed images from Storage). */
  const initialStoredUrlsRef = useRef<string[]>([]);

  // ---- Email verification gate ----
  // Posting a spot requires a verified email. We check on mount and
  // re-check when the user taps "I've verified" so they can continue
  // without restarting the app.
  const [emailVerified, setEmailVerified] = useState<boolean>(!!auth.currentUser?.emailVerified);
  const [resendingVerification, setResendingVerification] = useState(false);
  const [checkingVerification, setCheckingVerification] = useState(false);

  // ============================================================
  // VERIFICATION HELPERS
  // ============================================================
  const handleResendVerification = async () => {
    const user = auth.currentUser;
    if (!user) return;
    setResendingVerification(true);
    try {
      await sendEmailVerification(user);
      Alert.alert('Sent!', `We sent a new verification link to ${user.email}.`);
    } catch (err: any) {
      captureError(err, { area: 'AddSpotScreen.resendVerification', code: err?.code });
      const msg =
        err?.code === 'auth/too-many-requests'
          ? 'Please wait a minute before requesting another email.'
          : err?.message || 'Could not send verification email.';
      Alert.alert('Error', msg);
    } finally {
      setResendingVerification(false);
    }
  };

  const handleCheckVerification = async () => {
    const user = auth.currentUser;
    if (!user) return;
    setCheckingVerification(true);
    try {
      // Reload pulls the latest emailVerified flag from Firebase
      await user.reload();
      if (auth.currentUser?.emailVerified) {
        // Force-refresh the ID token so the email_verified claim updates
        // immediately. Without this, security rules would still see the
        // old (unverified) token until it auto-refreshes (~1 hour).
        await auth.currentUser.getIdToken(true);
        setEmailVerified(true);
      } else {
        Alert.alert('Not Verified Yet', 'We don\'t see a verification yet. Click the link in your email, then try again.');
      }
    } catch (err) {
      captureError(err, { area: 'AddSpotScreen.checkVerification' });
    } finally {
      setCheckingVerification(false);
    }
  };

  // ============================================================
  // GET CURRENT LOCATION
  // Used to center the map when the screen opens
  // ============================================================
  useEffect(() => {
    if (editSpotId) return;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const loc = await Location.getCurrentPositionAsync({});
      setRegion({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02,
      });
    })();
  }, [editSpotId]);

  // ---- Load existing spot when editing ----
  useEffect(() => {
    if (!editSpotId) {
      setEditSpotLoading(false);
      initialStoredUrlsRef.current = [];
      return;
    }
    let cancelled = false;
    setEditSpotLoading(true);
    (async () => {
      try {
        const user = auth.currentUser;
        if (!user) {
          router.back();
          return;
        }
        const snap = await getDoc(doc(db, 'spots', editSpotId));
        if (cancelled) return;
        if (!snap.exists()) {
          Alert.alert('Not found', 'This spot could not be loaded.');
          router.back();
          return;
        }
        const d = snap.data();
        if (d.userId !== user.uid) {
          Alert.alert('Not allowed', 'You can only edit your own spots.');
          router.back();
          return;
        }
        if (!d.location || typeof d.location.latitude !== 'number' || typeof d.location.longitude !== 'number') {
          Alert.alert('Error', 'This spot has no valid location.');
          router.back();
          return;
        }
        setTitle((d.title as string) || '');
        setDescription((d.caption as string) || '');
        setAddress((d.address as string) || '');
        setSelectedTags(dedupeTagsForSpot(Array.isArray(d.tags) ? (d.tags as string[]) : []));
        const coord = { latitude: d.location.latitude, longitude: d.location.longitude };
        setLocation(coord);
        setRegion({ ...coord, latitudeDelta: 0.02, longitudeDelta: 0.02 });
        setLocationFromPhoto(false);
        const urls = spotGalleryUrls({
          imageUrl: (d.imageUrl as string) || '',
          imageUrls: d.imageUrls as string[] | undefined,
        });
        initialStoredUrlsRef.current = [...urls];
        setImages(
          urls.map((u, i) => ({
            key: `existing-${editSpotId}-${i}`,
            uri: u,
            remoteUrl: u,
          }))
        );
      } catch (err) {
        captureError(err, { area: 'AddSpotScreen.loadEditSpot', spotId: editSpotId });
        if (!cancelled) {
          Alert.alert('Error', 'Could not load this spot.');
          router.back();
        }
      } finally {
        if (!cancelled) setEditSpotLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editSpotId, router]);

  // ============================================================
  // ADDRESS AUTOCOMPLETE
  // We debounce so we don't hit the Places API on every keystroke,
  // and we read `data.status` so configuration problems surface as
  // a clear alert instead of an empty dropdown.
  // ============================================================
  const autocompleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placesErrorShown = useRef(false);

  const runAddressAutocomplete = async (text: string) => {
    if (!GOOGLE_PLACES_API_KEY) {
      if (!placesErrorShown.current) {
        placesErrorShown.current = true;
        Alert.alert(
          'Address search unavailable',
          'Google Places API key is not configured.'
        );
      }
      return;
    }
    try {
      const resp = await fetch(
        `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(text)}&key=${GOOGLE_PLACES_API_KEY}`
      );
      const data = await resp.json();
      if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        // Surface real failures (REQUEST_DENIED, OVER_QUERY_LIMIT, etc.)
        // exactly once per session to avoid spamming the user.
        captureError(new Error(`Places autocomplete: ${data.status}`), {
          area: 'AddSpotScreen.handleAddressChange',
          status: data.status,
          error_message: data.error_message,
        });
        if (!placesErrorShown.current) {
          placesErrorShown.current = true;
          Alert.alert(
            'Address search unavailable',
            data.error_message ||
              `Google Places returned ${data.status}. Tap the map to drop a pin instead.`
          );
        }
        setSearchResults([]);
        return;
      }
      setSearchResults(data.predictions || []);
    } catch (err) {
      captureError(err, { area: 'AddSpotScreen.handleAddressChange' });
    }
  };

  const handleAddressChange = (text: string) => {
    setAddress(text);
    if (autocompleteTimer.current) clearTimeout(autocompleteTimer.current);
    if (!text || text.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    autocompleteTimer.current = setTimeout(() => {
      runAddressAutocomplete(text.trim());
    }, 300);
  };

  // When user taps a suggestion, geocode it to get coordinates
  const handleSelectAddress = async (item: any) => {
    setAddress(item.description);
    setSearchResults([]); // Hide the dropdown
    try {
      const resp = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(item.description)}&key=${GOOGLE_PLACES_API_KEY}`
      );
      const data = await resp.json();
      if (data.results?.[0]?.geometry?.location) {
        const { lat, lng } = data.results[0].geometry.location;
        const coord = { latitude: lat, longitude: lng };
        setLocation(coord);
        setRegion({ ...coord, latitudeDelta: 0.02, longitudeDelta: 0.02 });
      } else if (data.status && data.status !== 'OK') {
        captureError(new Error(`Geocode: ${data.status}`), {
          area: 'AddSpotScreen.handleSelectAddress',
          status: data.status,
          error_message: data.error_message,
        });
        Alert.alert(
          'Could not locate that address',
          data.error_message ||
            'Try a different address or tap the map to drop a pin.'
        );
      }
    } catch (err) {
      captureError(err, { area: 'AddSpotScreen.handleSelectAddress' });
    }
  };

  // ============================================================
  // REVERSE GEOCODE
  // When the user taps the map, we get coordinates from the tap
  // and convert them back to a human-readable address.
  // ============================================================
  const reverseGeocode = async (latitude: number, longitude: number) => {
    try {
      const resp = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${GOOGLE_PLACES_API_KEY}`
      );
      const data = await resp.json();
      if (data.results?.[0]?.formatted_address) setAddress(data.results[0].formatted_address);
    } catch (err) {
      captureError(err, { area: 'AddSpotScreen.reverseGeocode' });
      console.error(err);
    }
  };

  // ============================================================
  // PHOTO PICKER
  // Two options: take a new photo with the camera, or pick
  // an existing one from the photo library.
  // Both require explicit permission from the user.
  //
  // We also read EXIF GPS metadata when present and auto-fill
  // the spot location + address. Users can override with a map tap.
  // ============================================================

  // Parse EXIF GPS into decimal degrees. Handles two shapes:
  //   1. Signed decimal: { GPSLatitude: 42.36, GPSLongitude: -71.05 }
  //   2. Unsigned + ref: { GPSLatitude: 42.36, GPSLatitudeRef: 'N',
  //                        GPSLongitude: 71.05, GPSLongitudeRef: 'W' }
  // Returns null if no usable GPS is present.
  const extractGpsFromExif = (
    exif: Record<string, any> | null | undefined
  ): { latitude: number; longitude: number } | null => {
    if (!exif) return null;
    const rawLat = exif.GPSLatitude;
    const rawLon = exif.GPSLongitude;
    if (typeof rawLat !== 'number' || typeof rawLon !== 'number') return null;
    if (rawLat === 0 && rawLon === 0) return null;

    const latRef = exif.GPSLatitudeRef;
    const lonRef = exif.GPSLongitudeRef;
    const latitude = latRef === 'S' ? -Math.abs(rawLat) : rawLat;
    const longitude = lonRef === 'W' ? -Math.abs(rawLon) : rawLon;

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90) return null;
    if (longitude < -180 || longitude > 180) return null;
    return { latitude, longitude };
  };

  // Apply EXIF GPS from the picked asset, if available. Updates map pin,
  // address, and shows the "location from photo" indicator.
  const applyPhotoLocation = async (asset: ImagePicker.ImagePickerAsset) => {
    const coords = extractGpsFromExif(asset.exif as Record<string, any> | undefined);
    if (!coords) {
      setLocationFromPhoto(false);
      return;
    }
    setLocation(coords);
    setRegion({ ...coords, latitudeDelta: 0.01, longitudeDelta: 0.01 });
    setLocationFromPhoto(true);
    // Best-effort address fill — failures are non-fatal (the user can still
    // type or tap the map).
    reverseGeocode(coords.latitude, coords.longitude);
  };

  const takePhoto = async () => {
    if (images.length >= MAX_SPOT_PHOTOS) {
      return Alert.alert('Photo limit', `You can add up to ${MAX_SPOT_PHOTOS} photos per spot.`);
    }
    const { granted } = await ImagePicker.requestCameraPermissionsAsync();
    if (!granted) return Alert.alert('Permission required', 'Camera permission is required.');
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8, exif: true });
    if (!result.canceled) {
      const asset = result.assets[0];
      setImages((prev) => [
        ...prev,
        { key: `cam-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, uri: asset.uri },
      ]);
      await applyPhotoLocation(asset);
    }
  };

  const uploadPhotos = async () => {
    const remaining = MAX_SPOT_PHOTOS - images.length;
    if (remaining <= 0) {
      return Alert.alert('Photo limit', `You can add up to ${MAX_SPOT_PHOTOS} photos per spot.`);
    }
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) return Alert.alert('Permission required', 'Media library permission is required.');
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.8,
      exif: true,
      allowsMultipleSelection: true,
      selectionLimit: remaining,
    });
    if (result.canceled || !result.assets?.length) return;

    setImages((prev) => {
      const uris = new Set(prev.map((p) => p.uri));
      const next: LocalPhoto[] = [...prev];
      for (const asset of result.assets) {
        if (next.length >= MAX_SPOT_PHOTOS) break;
        if (uris.has(asset.uri)) continue;
        uris.add(asset.uri);
        next.push({
          key: `lib-${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${next.length}`,
          uri: asset.uri,
        });
      }
      return next;
    });

    for (const asset of result.assets) {
      const coords = extractGpsFromExif(asset.exif as Record<string, any> | undefined);
      if (coords) {
        await applyPhotoLocation(asset);
        break;
      }
    }
  };

  // ============================================================
  // TAGS — suggested chips + user-created labels (deduped case-insensitively)
  // ============================================================
  const toggleTag = (tag: string) => {
    const key = tag.trim().toLowerCase();
    setSelectedTags((prev) => {
      const has = prev.some((t) => t.trim().toLowerCase() === key);
      return has ? prev.filter((t) => t.trim().toLowerCase() !== key) : [...prev, tag];
    });
  };

  const removeTag = (tag: string) => {
    const key = tag.trim().toLowerCase();
    setSelectedTags((prev) => prev.filter((t) => t.trim().toLowerCase() !== key));
  };

  const addCustomTag = () => {
    const raw = normalizeTagInput(customTagInput);
    setCustomTagInput('');
    if (!raw) return;
    if (raw.length > MAX_TAG_LENGTH) {
      Alert.alert('Tag too long', `Use at most ${MAX_TAG_LENGTH} characters per tag.`);
      return;
    }
      setSelectedTags((prev) => {
        if (prev.some((t) => t.trim().toLowerCase() === raw.toLowerCase())) return prev;
        if (prev.length >= MAX_TAGS_PER_SPOT) return prev;
        return [...prev, raw];
      });
  };

  // ============================================================
  // SAVE SPOT (create or update)
  // Uploads new local images to Storage; keeps existing remote URLs in order.
  // ============================================================
  const saveSpot = async () => {
    if (!location) return Alert.alert('Missing location', 'Please tap the map or search for an address.');
    if (!address.trim()) return Alert.alert('Missing address', 'Please enter or select an address.');
    if (!title.trim()) return Alert.alert('Missing title', 'Please give your spot a short title.');
    if (title.trim().length > MAX_SPOT_TITLE_LENGTH) {
      return Alert.alert('Title too long', `Use at most ${MAX_SPOT_TITLE_LENGTH} characters.`);
    }

    setSaving(true);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Not logged in');

      // Get the user's username from Firestore
      const userSnap = await getDoc(doc(db, 'users', user.uid));
      const userData = userSnap.exists() ? userSnap.data() : {};

      const uploadBatchId = Date.now();
      const downloadURLs: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const ph = images[i];
        if (ph.remoteUrl) {
          downloadURLs.push(ph.remoteUrl);
        } else {
          const response = await fetch(ph.uri);
          const blob = await response.blob();
          const filename = `${user.uid}_${uploadBatchId}_${i}.jpg`;
          const storageRef = ref(storage, `spots/${filename}`);
          await uploadBytes(storageRef, blob, { contentType: 'image/jpeg' });
          downloadURLs.push(await getDownloadURL(storageRef));
        }
      }

      const primaryUrl = downloadURLs[0] || '';
      if (editSpotId && downloadURLs.length === 0) {
        Alert.alert('Photos required', 'Keep at least one photo, or delete the spot from your profile instead.');
        return;
      }

      const displayUsername = (userData.displayUsername || userData.username || 'anonymous') as string;
      const username = (userData.username || 'anonymous') as string;

      if (editSpotId) {
        await updateDoc(doc(db, 'spots', editSpotId), {
          imageUrl: primaryUrl,
          imageUrls: downloadURLs,
          location,
          title: title.trim(),
          caption: description.trim(),
          address: address.trim(),
          username,
          displayUsername,
          tags: dedupeTagsForSpot(selectedTags),
          updatedAt: serverTimestamp(),
        });
        const removed = initialStoredUrlsRef.current.filter((u) => !downloadURLs.includes(u));
        await deleteStorageObjectsByUrls(removed);
        Alert.alert('Updated', 'Your spot has been saved.');
      } else {
        await addDoc(collection(db, 'spots'), {
          imageUrl: primaryUrl,
          ...(downloadURLs.length > 0 ? { imageUrls: downloadURLs } : {}),
          location,
          title: title.trim(),
          caption: description.trim(),
          address: address.trim(),
          userId: user.uid,
          username,
          displayUsername,
          tags: dedupeTagsForSpot(selectedTags),
          createdAt: serverTimestamp(),
        });
        Alert.alert('Spot Added! 📍', 'Your spot is now live on the map.');
      }
      router.back();
    } catch (err) {
      captureError(err, { area: 'AddSpotScreen.saveSpot', mode: editSpotId ? 'edit' : 'create' });
      console.error(err);
      Alert.alert('Error', editSpotId ? 'Failed to update spot. Please try again.' : 'Failed to save spot. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ============================================================
  // VERIFICATION GATE
  // Users must verify email before posting or editing spots.
  // ============================================================
  if (!emailVerified) {
    const userEmail = auth.currentUser?.email || 'your email';
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }}>
        <View style={styles.gateHeader}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={26} color={CREAM} />
          </TouchableOpacity>
        </View>
        <View style={styles.gateContainer}>
          <View style={styles.gateIconCircle}>
            <Ionicons name="mail-outline" size={48} color={ORANGE} />
          </View>
          <Text style={styles.gateTitle}>Verify your email to post or edit</Text>
          <Text style={styles.gateSubtitle}>
            We sent a verification link to{'\n'}
            <Text style={{ color: CREAM, fontWeight: '700' }}>{userEmail}</Text>
            {'\n\n'}
            Click the link in that email, then come back and tap &quot;I&apos;ve verified&quot;.
          </Text>

          <TouchableOpacity
            style={[styles.gatePrimaryButton, checkingVerification && { opacity: 0.6 }]}
            onPress={handleCheckVerification}
            disabled={checkingVerification}
          >
            {checkingVerification
              ? <ActivityIndicator color={CREAM} />
              : <Text style={styles.gatePrimaryButtonText}>I&apos;ve verified</Text>}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.gateSecondaryButton, resendingVerification && { opacity: 0.6 }]}
            onPress={handleResendVerification}
            disabled={resendingVerification}
          >
            {resendingVerification
              ? <ActivityIndicator color={ORANGE} />
              : <Text style={styles.gateSecondaryButtonText}>Resend verification email</Text>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Show loading while opening spot for edit, or while waiting for GPS (new spot)
  if (editSpotId && editSpotLoading) {
    return (
      <View style={[styles.center, { backgroundColor: screenBg }]}>
        <ActivityIndicator color={ORANGE} />
        <Text style={{ color: CREAM, marginTop: 10 }}>Loading spot…</Text>
      </View>
    );
  }

  if (!region) return (
    <View style={[styles.center, { backgroundColor: screenBg }]}>
      <ActivityIndicator color={ORANGE} />
      <Text style={{ color: CREAM, marginTop: 10 }}>Getting your location…</Text>
    </View>
  );

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

          {/* ---- Header with back button ---- */}
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
              <Ionicons name="arrow-back" size={26} color={CREAM} />
            </TouchableOpacity>
            <Text style={styles.header}>{editSpotId ? 'Edit spot' : 'Add a Spot'}</Text>
          </View>

          {/* ---- Title input ---- */}
          <Text style={styles.label}>Title *</Text>
          <TextInput
            style={styles.input}
            placeholder="Give your spot a short name"
            placeholderTextColor={CREAM_DARK}
            value={title}
            onChangeText={setTitle}
            maxLength={MAX_SPOT_TITLE_LENGTH}
          />

          {/* ---- Description input ---- */}
          <Text style={styles.label}>Description</Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            placeholder="What makes this spot special? (optional)"
            placeholderTextColor={CREAM_DARK}
            multiline
            value={description}
            onChangeText={setDescription}
          />

          {/* ---- Address search ---- */}
          <Text style={styles.label}>Address *</Text>
          <TextInput
            style={styles.input}
            placeholder="Search for an address…"
            placeholderTextColor={CREAM_DARK}
            value={address}
            onChangeText={handleAddressChange}
          />

          {/* Autocomplete dropdown — only visible when there are results */}
          {searchResults.length > 0 && (
            <View style={styles.dropdown}>
              <FlatList
                data={searchResults}
                keyExtractor={item => item.place_id}
                scrollEnabled={false}
                renderItem={({ item }) => (
                  <TouchableOpacity onPress={() => handleSelectAddress(item)} style={styles.dropdownItem}>
                    <Ionicons name="location-outline" size={14} color={ORANGE} style={{ marginRight: 8 }} />
                    <Text style={{ color: CREAM, flex: 1, fontSize: 14 }}>{item.description}</Text>
                  </TouchableOpacity>
                )}
              />
            </View>
          )}

          {/* ---- Tag selector: your own + suggested ---- */}
          <Text style={styles.label}>Tags</Text>
          <Text style={styles.tagHint}>
            Add your own (max {MAX_TAGS_PER_SPOT} tags, {MAX_TAG_LENGTH} characters each) or tap a suggestion.
          </Text>
          {selectedTags.length > 0 ? (
            <View style={styles.selectedTagsRow}>
              {selectedTags.map((tag) => (
                <View key={tag} style={styles.selectedTagChip}>
                  <Text style={styles.selectedTagText} numberOfLines={1}>
                    {tag}
                  </Text>
                  <TouchableOpacity onPress={() => removeTag(tag)} hitSlop={8} accessibilityLabel={`Remove ${tag}`}>
                    <Ionicons name="close-circle" size={20} color={CREAM_DARK} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          ) : null}
          <Text style={styles.tagSubLabel}>Suggested</Text>
          <View style={styles.tagRow}>
            {TAGS.map((tag) => {
              const active = selectedTags.some((t) => t.trim().toLowerCase() === tag.toLowerCase());
              return (
                <TouchableOpacity
                  key={tag}
                  style={[styles.tag, active && styles.tagActive]}
                  onPress={() => toggleTag(tag)}
                >
                  <Text style={[styles.tagText, active && styles.tagTextActive]}>{tag}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={styles.customTagRow}>
            <TextInput
              style={[styles.input, styles.customTagInput, { marginBottom: 0 }]}
              placeholder="Your tag (e.g. Coffee, Rooftop)"
              placeholderTextColor={CREAM_DARK}
              value={customTagInput}
              onChangeText={setCustomTagInput}
              maxLength={MAX_TAG_LENGTH}
              returnKeyType="done"
              blurOnSubmit={false}
              onSubmitEditing={addCustomTag}
            />
            <TouchableOpacity style={styles.addTagBtn} onPress={addCustomTag}>
              <Text style={styles.addTagBtnText}>Add</Text>
            </TouchableOpacity>
          </View>

          {/* ---- Photo picker ---- */}
          <Text style={styles.label}>Photos</Text>
          <Text style={styles.photoHint}>Up to {MAX_SPOT_PHOTOS} photos</Text>
          <View style={styles.photoButtonsRow}>
            <TouchableOpacity style={styles.photoButton} onPress={takePhoto}>
              <Ionicons name="camera-outline" size={18} color={CREAM} style={{ marginRight: 6 }} />
              <Text style={styles.photoButtonText}>Take Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.photoButton} onPress={uploadPhotos}>
              <Ionicons name="images-outline" size={18} color={CREAM} style={{ marginRight: 6 }} />
              <Text style={styles.photoButtonText}>Upload</Text>
            </TouchableOpacity>
          </View>

          {images.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.photoThumbsScroll}
              contentContainerStyle={styles.photoThumbsRow}
            >
              {images.map((ph) => (
                <View key={ph.key} style={styles.photoThumbWrap}>
                  <Image source={{ uri: ph.uri }} style={styles.photoThumb} />
                  <TouchableOpacity
                    style={styles.removeThumb}
                    onPress={() => {
                      setImages((prev) => prev.filter((p) => p.key !== ph.key));
                      setLocationFromPhoto(false);
                    }}
                  >
                    <Ionicons name="close-circle" size={26} color={ORANGE} />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          )}

          {/* ---- Map for pinning location ---- */}
          <Text style={styles.label}>Pin Location *</Text>
          <MapView
            style={styles.map}
            region={region}
            onPress={e => {
              const coord = e.nativeEvent.coordinate;
              setLocation(coord);
              // Update region so map re-centers on the tapped point
              setRegion({ ...coord, latitudeDelta: 0.02, longitudeDelta: 0.02 });
              // Manual override — drop the "from photo" hint.
              setLocationFromPhoto(false);
              // Auto-fill address from the tapped coordinates
              reverseGeocode(coord.latitude, coord.longitude);
            }}
          >
            {location && <Marker coordinate={location} pinColor={ORANGE} />}
          </MapView>
          {locationFromPhoto ? (
            <View style={styles.photoLocationHint}>
              <Ionicons name="image-outline" size={14} color={ORANGE} style={{ marginRight: 6 }} />
              <Text style={styles.photoLocationHintText}>
                Location read from your photo. Tap the map to change.
              </Text>
            </View>
          ) : (
            <Text style={styles.mapHint}>Tap the map to pin the exact spot location</Text>
          )}

          {/* ---- Save button ---- */}
          <TouchableOpacity
            style={[styles.saveButton, saving && { opacity: 0.6 }]}
            onPress={saveSpot}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator color={CREAM} />
              : <>
                  <Ionicons name="checkmark-circle-outline" size={20} color={CREAM} style={{ marginRight: 8 }} />
                  <Text style={styles.saveButtonText}>{editSpotId ? 'Save changes' : 'Save Spot'}</Text>
                </>
            }
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ============================================================
// STYLES
// ============================================================
const styles = StyleSheet.create({
  scrollContent: { padding: 20, paddingBottom: 50 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  backButton: { marginRight: 12 },
  header: { fontSize: 24, fontWeight: '900', color: CREAM, letterSpacing: 0.3 },
  label: { fontSize: 11, fontWeight: '700', color: CREAM_DARK, letterSpacing: 1, marginBottom: 8, marginTop: 4 },
  input: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 12, padding: 14, fontSize: 15,
    color: CREAM, marginBottom: 16,
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.15)',
  },
  textArea: { height: 90, textAlignVertical: 'top' },
  photoHint: { color: CREAM_DARK, fontSize: 12, marginBottom: 10, lineHeight: 17 },
  photoThumbsScroll: { marginBottom: 12 },
  photoThumbsRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  photoThumbWrap: { position: 'relative', marginRight: 10 },
  photoThumb: { width: 96, height: 96, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.06)' },
  removeThumb: { position: 'absolute', top: -4, right: -4 },
  map: { width: '100%', height: 240, borderRadius: 14, marginBottom: 6 },
  mapHint: { color: CREAM_DARK, fontSize: 12, marginBottom: 16 },
  photoLocationHint: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: 'rgba(227,92,37,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.35)',
    alignSelf: 'flex-start',
  },
  photoLocationHintText: { color: CREAM, fontSize: 12, fontWeight: '600' },
  photoButtonsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  photoButton: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    padding: 13, borderRadius: 12, marginHorizontal: 4,
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.2)',
  },
  photoButtonText: { color: CREAM, fontWeight: '600', fontSize: 14 },
  saveButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: ORANGE, padding: 16, borderRadius: 14, marginTop: 14,
    shadowColor: ORANGE, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  saveButtonText: { color: CREAM, fontWeight: '800', fontSize: 16 },
  dropdown: {
    borderRadius: 12, marginBottom: 16, overflow: 'hidden',
    backgroundColor: 'rgba(17,35,55,0.98)',
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.15)',
  },
  dropdownItem: {
    flexDirection: 'row', alignItems: 'center', padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(231,219,203,0.1)',
  },
  tagHint: { color: CREAM_DARK, fontSize: 12, marginBottom: 10, lineHeight: 17 },
  tagSubLabel: {
    color: CREAM_DARK,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginTop: 4,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 8 },
  selectedTagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  selectedTagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '100%',
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: 'rgba(227,92,37,0.25)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.45)',
    gap: 4,
  },
  selectedTagText: { color: CREAM, fontWeight: '700', fontSize: 13, flexShrink: 1 },
  customTagRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  customTagInput: { flex: 1, marginBottom: 0 },
  addTagBtn: {
    backgroundColor: ORANGE,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 12,
    justifyContent: 'center',
  },
  addTagBtnText: { color: CREAM, fontWeight: '800', fontSize: 15 },
  tag: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
    borderWidth: 1.5, borderColor: 'rgba(227,92,37,0.5)',
    marginRight: 8, marginBottom: 8,
  },
  tagActive: { backgroundColor: ORANGE, borderColor: ORANGE },
  tagText: { color: CREAM_DARK, fontWeight: '600', fontSize: 13 },
  tagTextActive: { color: CREAM },

  // ---- Verification gate ----
  gateHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 4 },
  gateContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 32, paddingBottom: 60,
  },
  gateIconCircle: {
    width: 120, height: 120, borderRadius: 60,
    backgroundColor: 'rgba(227,92,37,0.12)',
    borderWidth: 1.5, borderColor: 'rgba(227,92,37,0.3)',
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 24,
  },
  gateTitle: { fontSize: 22, fontWeight: '800', color: CREAM, marginBottom: 12, textAlign: 'center' },
  gateSubtitle: { fontSize: 15, color: CREAM_DARK, textAlign: 'center', lineHeight: 22, marginBottom: 28 },
  gatePrimaryButton: {
    alignSelf: 'stretch',
    backgroundColor: ORANGE, padding: 16, borderRadius: 14, alignItems: 'center',
    shadowColor: ORANGE, shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 6,
    marginBottom: 12,
  },
  gatePrimaryButtonText: { color: CREAM, fontWeight: '800', fontSize: 16, letterSpacing: 0.3 },
  gateSecondaryButton: {
    alignSelf: 'stretch',
    padding: 14, borderRadius: 14,
    borderWidth: 1.5, borderColor: ORANGE, alignItems: 'center',
  },
  gateSecondaryButtonText: { color: ORANGE, fontWeight: '700', fontSize: 14 },
});