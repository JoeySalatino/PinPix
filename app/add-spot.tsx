// ============================================================
// AddSpotScreen.tsx — Create a New Spot
// ------------------------------------------------------------
// Lets users add a new photo spot to the map. They can:
//   - Enter a title and description
//   - Search for an address (Google Places Autocomplete)
//   - Select tags to help others find the spot
//   - Take a photo or upload one from the library
//   - Tap the map to pin the exact location
//   - Save everything to Firestore (+ image to Firebase Storage)
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { sendEmailVerification } from 'firebase/auth';
import { addDoc, collection, doc, getDoc, serverTimestamp } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { useEffect, useState } from 'react';
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
import { BRAND } from '../constants/brand';
import { TAGS } from '../constants/tags';
import { auth, db, storage } from '../utils/firebase';
import { captureError } from '../utils/sentry';

// Read the Google Places API key from app.config.js extra fields
const GOOGLE_PLACES_API_KEY = Constants.expoConfig?.extra?.googlePlacesKey || '';

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function AddSpotScreen() {
  const router = useRouter();

  // ---- Form state ----
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  // ---- Map/location state ----
  const [location, setLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [region, setRegion] = useState<Region | null>(null); // The visible area of the map

  // ---- Photo state ----
  const [image, setImage] = useState<string | null>(null); // Local URI of selected image

  // ---- Address autocomplete results ----
  const [searchResults, setSearchResults] = useState<any[]>([]);

  // ---- Loading state ----
  const [saving, setSaving] = useState(false);

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
  }, []);

  // ============================================================
  // ADDRESS AUTOCOMPLETE
  // As the user types, we call the Google Places API and show
  // suggestions in a dropdown list below the input.
  // ============================================================
  const handleAddressChange = async (text: string) => {
    setAddress(text);
    if (!text) return setSearchResults([]);
    try {
      const resp = await fetch(
        `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(text)}&key=${GOOGLE_PLACES_API_KEY}`
      );
      const data = await resp.json();
      setSearchResults(data.predictions || []);
    } catch (err) {
      captureError(err, { area: 'AddSpotScreen.handleAddressChange' });
      console.error(err);
    }
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
      }
    } catch (err) {
      captureError(err, { area: 'AddSpotScreen.handleSelectAddress' });
      console.error(err);
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
  // ============================================================
  const takePhoto = async () => {
    const { granted } = await ImagePicker.requestCameraPermissionsAsync();
    if (!granted) return Alert.alert('Permission required', 'Camera permission is required.');
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (!result.canceled) setImage(result.assets[0].uri);
  };

  const uploadPhoto = async () => {
    const { granted } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!granted) return Alert.alert('Permission required', 'Media library permission is required.');
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });
    if (!result.canceled) setImage(result.assets[0].uri);
  };

  // ============================================================
  // TOGGLE TAG
  // Adds or removes a tag from the selectedTags array
  // ============================================================
  const toggleTag = (tag: string) => {
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  // ============================================================
  // SAVE SPOT
  // Uploads the image to Firebase Storage (if one was selected),
  // then saves all the spot data to Firestore.
  //
  // Image upload process:
  //   1. Fetch the local file as a blob (binary data)
  //   2. Upload the blob to Firebase Storage
  //   3. Get the public download URL back
  //   4. Save that URL in the Firestore document
  // ============================================================
  const saveSpot = async () => {
    if (!location) return Alert.alert('Missing location', 'Please tap the map or search for an address.');
    if (!address.trim()) return Alert.alert('Missing address', 'Please enter or select an address.');

    setSaving(true);
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('Not logged in');

      // Get the user's username from Firestore
      const userSnap = await getDoc(doc(db, 'users', user.uid));
      const userData = userSnap.exists() ? userSnap.data() : {};

      let downloadURL = '';

      // Only upload if the user selected a photo
      if (image) {
        // Convert the local image URI to a blob for uploading
        const response = await fetch(image);
        const blob = await response.blob();

        // Create a unique filename using the user's ID and timestamp
        const filename = `${user.uid}_${Date.now()}.jpg`;
        const storageRef = ref(storage, `spots/${filename}`);

        // Upload to Firebase Storage
        await uploadBytes(storageRef, blob);

        // Get the public URL for the uploaded image
        downloadURL = await getDownloadURL(storageRef);
      }

      // Save the spot document to Firestore
      // serverTimestamp() sets the time on the server (more reliable than client time)
      await addDoc(collection(db, 'spots'), {
        imageUrl: downloadURL,
        location,               // { latitude, longitude }
        title: title.trim(),
        caption: description.trim(),
        address: address.trim(),
        userId: user.uid,       // Used for ownership checks
        username: userData.username || 'anonymous',
        displayUsername: userData.displayUsername || userData.username || 'anonymous',
        tags: selectedTags,
        createdAt: serverTimestamp(),
      });

      Alert.alert('Spot Added! 📍', 'Your spot is now live on the map.');
      router.back();
    } catch (err) {
      captureError(err, { area: 'AddSpotScreen.saveSpot' });
      console.error(err);
      Alert.alert('Error', 'Failed to save spot. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ============================================================
  // VERIFICATION GATE
  // Users can browse, favorite, and use everything else, but must
  // verify their email before posting a new spot.
  // ============================================================
  if (!emailVerified) {
    const userEmail = auth.currentUser?.email || 'your email';
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: NAVY }}>
        <View style={styles.gateHeader}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Ionicons name="arrow-back" size={26} color={CREAM} />
          </TouchableOpacity>
        </View>
        <View style={styles.gateContainer}>
          <View style={styles.gateIconCircle}>
            <Ionicons name="mail-outline" size={48} color={ORANGE} />
          </View>
          <Text style={styles.gateTitle}>Verify your email to post</Text>
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

  // Show loading while waiting for location
  if (!region) return (
    <View style={[styles.center, { backgroundColor: NAVY }]}>
      <ActivityIndicator color={ORANGE} />
      <Text style={{ color: CREAM, marginTop: 10 }}>Getting your location…</Text>
    </View>
  );

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: NAVY }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">

          {/* ---- Header with back button ---- */}
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
              <Ionicons name="arrow-back" size={26} color={CREAM} />
            </TouchableOpacity>
            <Text style={styles.header}>Add a Spot</Text>
          </View>

          {/* ---- Title input ---- */}
          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            placeholder="Give your spot a name (optional)"
            placeholderTextColor={CREAM_DARK}
            value={title}
            onChangeText={setTitle}
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

          {/* ---- Tag selector ---- */}
          <Text style={styles.label}>Tags</Text>
          <View style={styles.tagRow}>
            {TAGS.map(tag => {
              const active = selectedTags.includes(tag);
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

          {/* ---- Photo picker ---- */}
          <Text style={styles.label}>Photo</Text>
          <View style={styles.photoButtonsRow}>
            <TouchableOpacity style={styles.photoButton} onPress={takePhoto}>
              <Ionicons name="camera-outline" size={18} color={CREAM} style={{ marginRight: 6 }} />
              <Text style={styles.photoButtonText}>Take Photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.photoButton} onPress={uploadPhoto}>
              <Ionicons name="image-outline" size={18} color={CREAM} style={{ marginRight: 6 }} />
              <Text style={styles.photoButtonText}>Upload Photo</Text>
            </TouchableOpacity>
          </View>

          {/* Preview the selected image with a remove button */}
          {image && (
            <View>
              <Image source={{ uri: image }} style={styles.image} />
              <TouchableOpacity style={styles.removePhoto} onPress={() => setImage(null)}>
                <Ionicons name="close-circle" size={28} color={ORANGE} />
              </TouchableOpacity>
            </View>
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
              // Auto-fill address from the tapped coordinates
              reverseGeocode(coord.latitude, coord.longitude);
            }}
          >
            {location && <Marker coordinate={location} pinColor={ORANGE} />}
          </MapView>
          <Text style={styles.mapHint}>Tap the map to pin the exact spot location</Text>

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
                  <Text style={styles.saveButtonText}>Save Spot</Text>
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
  image: { width: '100%', height: 220, borderRadius: 14, marginVertical: 10 },
  removePhoto: { position: 'absolute', top: 16, right: 6 },
  map: { width: '100%', height: 240, borderRadius: 14, marginBottom: 6 },
  mapHint: { color: CREAM_DARK, fontSize: 12, marginBottom: 16 },
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
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 16 },
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