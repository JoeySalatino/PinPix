// ============================================================
// HomeScreen.tsx — Main Map Screen
// ------------------------------------------------------------
// This is the core screen of the app. It shows a live map
// with pins for every photo spot in the database.
//
// Key concepts used here:
//   - onSnapshot: a Firestore real-time listener that fires
//     every time the data changes (like a live feed)
//   - useMemo: recalculates filtered spots only when the
//     relevant data changes, not on every render
//   - useCallback: memoizes functions so they don't get
//     recreated on every render (good for performance)
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  updateDoc,
} from 'firebase/firestore';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
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
import OfflineBanner from '../components/OfflineBanner';
import SpotPeek from '../components/SpotPeek';
import { Spot } from '../components/types';
import { BRAND } from '../constants/brand';
import { TAGS } from '../constants/tags';
import { auth, db } from '../utils/firebase';
import { deleteStorageObjectByUrl } from '../utils/storage-delete';
import { captureError } from '../utils/sentry';
import { useTheme } from '../utils/theme-context';

const { navy: NAVY, orange: ORANGE, cream: CREAM } = BRAND;

/** Shared by map filtering and peek pruning so the sheet never shows spots that no longer match. Search matches title, caption, username, and address. */
function spotMatchesHomeFilters(spot: Spot, searchQuery: string, activeTags: string[]): boolean {
  const q = searchQuery.trim().toLowerCase();
  const text =
    `${spot.title} ${spot.caption} ${spot.username} ${spot.address || ''}`.toLowerCase();
  if (q && !text.includes(q)) return false;
  if (activeTags.length > 0) {
    const normalized = (spot.tags || [])
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean);
    const tagOk = activeTags.some((at) =>
      normalized.includes(String(at).trim().toLowerCase())
    );
    if (!tagOk) return false;
  }
  return true;
}

export default function HomeScreen() {
  const router = useRouter();
  const { isDark } = useTheme();

  // Optional ?tag=Nature query param — pre-applies a tag filter
  // when arriving from another screen (e.g. tag press in SpotPeek).
  const { tag: incomingTag } = useLocalSearchParams<{ tag?: string }>();

  // ---- Map state ----
  const [region, setRegion] = useState<Region | null>(null);
  const [locationError, setLocationError] = useState(false);
  // Ref to the MapView so we can imperatively animate the camera
  // (zoom-in when a pin is tapped). Using `any` because the typed
  // ref from react-native-maps requires importing the full MapView
  // class type, which complicates the import.
  const mapRef = useRef<MapView | null>(null);

  // ---- Spots state ----
  const [spots, setSpots] = useState<Spot[]>([]);
  const [spotsLoaded, setSpotsLoaded] = useState(false);   // Prevents empty state flashing before data loads

  // ---- UI state ----
  const [selectedSpots, setSelectedSpots] = useState<Spot[]>([]); // Spots shown in the peek sheet
  const [favorites, setFavorites] = useState<string[]>([]);       // Keys of favorited spots
  /** UIDs whose spots are hidden from this user's map (see Settings to unblock). */
  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
  const blockedUserIdsRef = useRef<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  /** Bumped when SpotPeek closes so Marker keys change; native maps often keep the pin
   * selected after dismiss, so a second tap would not fire onPress until tapping away. */
  const [markerPressEpoch, setMarkerPressEpoch] = useState(0);
  const peekWasOpenRef = useRef(false);

  useEffect(() => {
    blockedUserIdsRef.current = blockedUserIds;
  }, [blockedUserIds]);

  useEffect(() => {
    const open = selectedSpots.length > 0;
    if (peekWasOpenRef.current && !open) {
      setMarkerPressEpoch((e) => e + 1);
    }
    peekWasOpenRef.current = open;
  }, [selectedSpots]);

  // ---- Apply incoming ?tag= query param ----
  // Runs once per distinct incoming tag so navigating to /home?tag=X
  // selects that filter chip automatically.
  useEffect(() => {
    if (!incomingTag) return;
    setActiveTags((prev) => (prev.includes(incomingTag) ? prev : [...prev, incomingTag]));
  }, [incomingTag]);

  // Drop spots from the open peek when filters change so the sheet stays in sync with the map.
  useEffect(() => {
    setSelectedSpots((prev) => {
      if (prev.length === 0) return prev;
      const next = prev.filter((s) => spotMatchesHomeFilters(s, searchQuery, activeTags));
      if (next.length === prev.length && next.every((s, i) => s.id === prev[i].id)) return prev;
      return next;
    });
  }, [searchQuery, activeTags]);

  // ---- Tag press from SpotPeek ----
  const handleTagPress = (tag: string) => {
    setSelectedSpots([]);
    setActiveTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
  };

  // ============================================================
  // LOCATION
  // Request permission and get the user's current position.
  // If denied, fall back to a default region so the map still loads.
  // ============================================================
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocationError(true);
        // Default to San Francisco if location is denied
        setRegion({ latitude: 37.7749, longitude: -122.4194, latitudeDelta: 0.1, longitudeDelta: 0.1 });
        return;
      }
      const loc = await Location.getCurrentPositionAsync({});
      setRegion({
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        latitudeDelta: 0.03,
        longitudeDelta: 0.03,
      });
    })();
  }, []);

  // ============================================================
  // LOAD SPOTS (REAL-TIME)
  // onSnapshot sets up a live listener on the 'spots' collection.
  // Every time a spot is added, edited, or deleted in Firestore,
  // this callback fires and updates our local state automatically.
  // We return the unsubscribe function so React cleans it up.
  // ============================================================
  useEffect(() => {
    // Wrap the snapshot in an auth listener so it only runs while
    // the user is logged in. When they log out, onAuthStateChanged
    // fires with null and we unsubscribe the Firestore listener,
    // preventing the permission-denied error.
    let spotsUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        // User is logged in — start listening to spots
        spotsUnsub = onSnapshot(collection(db, 'spots'), snap => {
          const loaded: Spot[] = [];
          snap.forEach(d => {
            const data = d.data();
            if (!data.location) return;
            const uid = data.userId || '';
            if (uid && blockedUserIdsRef.current.includes(uid)) return;
            loaded.push({
              id: d.id,
              latitude: data.location.latitude,
              longitude: data.location.longitude,
              imageUrl: data.imageUrl || '',
              title: data.title || '',
              caption: data.caption || '',
              address: data.address || '',
              username: data.displayUsername || data.username || '',
              userId: data.userId || '',
              tags: data.tags || [],
            });
          });
          setSpots(loaded);
          setSpotsLoaded(true);
        });
      } else {
        // User logged out — unsubscribe Firestore listener immediately
        if (spotsUnsub) {
          spotsUnsub();
          spotsUnsub = null;
        }
      }
    });

    // Clean up both listeners when component unmounts
    return () => {
      authUnsub();
      if (spotsUnsub) spotsUnsub();
    };
  }, []);

  // ============================================================
  // LOAD FAVORITES
  // useCallback memoizes this function so it can be safely
  // passed as a dependency to useEffect without causing loops
  // ============================================================
  // Live listener on the current user's own document so favorites and the
  // block list reflect changes immediately — including changes made on
  // another device (e.g. block from /user/[username]) or in Settings.
  useEffect(() => {
    let userDocUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        userDocUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
          if (!snap.exists()) return;
          const data = snap.data();
          setFavorites(data.favorites || []);
          setBlockedUserIds(data.blockedUserIds || []);
        });
      } else {
        if (userDocUnsub) {
          userDocUnsub();
          userDocUnsub = null;
        }
        setFavorites([]);
        setBlockedUserIds([]);
      }
    });

    return () => {
      authUnsub();
      if (userDocUnsub) userDocUnsub();
    };
  }, []);

  // ============================================================
  // TOGGLE FAVORITE
  // Uses Firestore's arrayUnion / arrayRemove to add or remove
  // a spot key from the user's favorites array atomically.
  // We also update local state immediately for instant UI feedback.
  // ============================================================
  const toggleFavorite = async (spot: Spot) => {
    const user = auth.currentUser;
    if (!user) return;

    // The key is a string combining lat/lng, used to identify the spot
    const key = `${spot.latitude.toFixed(4)}-${spot.longitude.toFixed(4)}`;
    const userRef = doc(db, 'users', user.uid);
    const isFav = favorites.includes(key);

    // Update Firestore
    await updateDoc(userRef, { favorites: isFav ? arrayRemove(key) : arrayUnion(key) });

    // Update local state instantly (no need to wait for Firestore)
    setFavorites(prev => isFav ? prev.filter(f => f !== key) : [...prev, key]);
  };

  // ============================================================
  // DELETE SPOT
  // Only the spot owner can delete their spot (enforced by
  // both this check and Firestore security rules).
  // We also try to delete the image from Storage.
  // ============================================================
  const deleteSpot = async (spot: Spot) => {
    const user = auth.currentUser;
    if (!user || user.uid !== spot.userId) return;

    Alert.alert('Delete Spot', 'Are you sure? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            // Try to delete the image file from Firebase Storage
            // We wrap in try/catch because the file might not exist
            await deleteStorageObjectByUrl(spot.imageUrl);
            // Delete the Firestore document
            await deleteDoc(doc(db, 'spots', spot.id));
            setSelectedSpots([]); // Close the peek sheet
            Alert.alert('Deleted', 'Your spot has been removed.');
          } catch (err) {
            captureError(err, { area: 'HomeScreen.deleteSpot', spotId: spot.id });
            Alert.alert('Error', 'Could not delete spot.');
          }
        },
      },
    ]);
  };

  // ============================================================
  // REPORT SPOT
  // Shows an action sheet with report reasons.
  // We write a report document to Firestore for admin review.
  // NOTE: The security rules allow creating reports but not
  // reading them, so we skip the duplicate check query
  // (which would fail due to those rules) and just write.
  // ============================================================
  const reportSpot = async (spot: Spot) => {
    const user = auth.currentUser;
    if (!user) return;

    Alert.alert('Report Spot', 'Why are you reporting this spot?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Inappropriate Content', onPress: () => submitReport(spot, 'Inappropriate Content') },
      { text: 'Spam', onPress: () => submitReport(spot, 'Spam') },
      { text: 'Wrong Location', onPress: () => submitReport(spot, 'Wrong Location') },
    ]);
  };

  const blockSpotOwner = (spot: Spot) => {
    const user = auth.currentUser;
    if (!user || !spot.userId || spot.userId === user.uid) return;

    Alert.alert(
      'Block this user?',
      'You will no longer see their spots on the map. You can unblock them anytime in Settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              await updateDoc(doc(db, 'users', user.uid), {
                blockedUserIds: arrayUnion(spot.userId),
              });
              setBlockedUserIds((prev) => Array.from(new Set([...prev, spot.userId])));
              setSelectedSpots([]);
              Alert.alert('Blocked', 'Their spots are hidden from your map.');
            } catch (err) {
              captureError(err, { area: 'HomeScreen.blockSpotOwner', blockedUid: spot.userId });
              Alert.alert('Error', 'Could not block this user. Please try again.');
            }
          },
        },
      ]
    );
  };

  const submitReport = async (spot: Spot, reason: string) => {
    const user = auth.currentUser;
    if (!user) return;
    try {
      // Write the report to Firestore
      // Admins can view these in the Firebase Console
      await addDoc(collection(db, 'reports'), {
        spotId: spot.id,
        spotTitle: spot.title,
        reportedBy: user.uid,
        reason,
        createdAt: new Date().toISOString(),
      });
      Alert.alert('Reported', 'Thank you. We will review this shortly.');
    } catch (err) {
      captureError(err, { area: 'HomeScreen.submitReport', spotId: spot.id });
      console.log('Report error:', err);
      Alert.alert('Error', 'Could not submit report. Please try again.');
    }
  };

  // ============================================================
  // OPEN DIRECTIONS
  // Opens the native maps app with the spot's coordinates.
  // iOS uses the Apple Maps URL scheme, Android uses geo: URIs.
  // ============================================================
  const openDirections = (spot: Spot) => {
    const url = Platform.select({
      ios: `maps:0,0?q=${spot.latitude},${spot.longitude}`,
      android: `geo:0,0?q=${spot.latitude},${spot.longitude}`,
    });
    if (url) Linking.openURL(url);
  };

  // ============================================================
  // HANDLE MARKER TAP
  // Animates the map to zoom into the tapped pin (roughly a
  // few-block radius) and then opens the SpotPeek sheet.
  // The deltas are smaller than the default region delta so it
  // feels like a real "zoom in" rather than just a recenter.
  // ============================================================
  const handleMarkerPress = (group: Spot[]) => {
    Keyboard.dismiss();
    const target = group[0];
    if (mapRef.current && target) {
      mapRef.current.animateToRegion(
        {
          latitude: target.latitude,
          longitude: target.longitude,
          latitudeDelta: 0.005,
          longitudeDelta: 0.005,
        },
        400 // ms
      );
    }
    setSelectedSpots(group);
  };

  // ============================================================
  // FILTER AND GROUP SPOTS
  // useMemo recalculates this only when spots, searchQuery, or
  // activeTags change — not on every render.
  //
  // We group spots by location key because multiple spots can
  // exist at the same coordinates (same pin on the map).
  // Tapping a pin shows all spots at that location.
  // ============================================================
  const filteredGroupedSpots = useMemo(() => {
    const grouped: Record<string, Spot[]> = {};

    spots.forEach((spot) => {
      if (!spotMatchesHomeFilters(spot, searchQuery, activeTags)) return;
      const key = `${spot.latitude.toFixed(4)}-${spot.longitude.toFixed(4)}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(spot);
    });

    return Object.entries(grouped);
  }, [spots, searchQuery, activeTags]);

  /** Baked into marker keys so react-native-maps remounts pins whenever filters change
      (not only toggling filtered vs unfiltered), avoiding stale native annotations on iOS. */
  const markerFilterStamp = `${searchQuery.trim()}|${[...activeTags].sort().join(',')}`;

  // Show loading text until we have a region
  if (!region) return (
    <View style={[styles.center, { backgroundColor: NAVY }]}>
      <Text style={{ color: CREAM }}>Loading map…</Text>
    </View>
  );

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <View style={styles.root}>

      {/* ---- Offline banner (sits at top, only visible when offline) ---- */}
      <OfflineBanner />

      {/* ---- Full-screen map ---- */}
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        initialRegion={region}
        showsUserLocation={!locationError}
        onPress={() => Keyboard.dismiss()}
      >
        {/* Render one marker per unique location.
            Marker key includes the current filter stamp so React remounts pins
            whenever search or tag chips change, not only toggling filtered vs
            unfiltered. That avoids stale native annotations on iOS (wrong pins
            visible until another tap). A press epoch in the key remounts markers when
            the peek closes so the same pin stays tappable. */}
        {filteredGroupedSpots.map(([key, group]) => (
          <Marker
            key={`${markerFilterStamp}|${key}|p${markerPressEpoch}`}
            coordinate={{ latitude: group[0].latitude, longitude: group[0].longitude }}
            pinColor={favorites.includes(key) ? '#FFD700' : ORANGE} // Gold if favorited
            onPress={() => handleMarkerPress(group)} // Zoom in + show peek sheet
            // Tells the native marker view it doesn't need to constantly
            // redraw itself — small perf win, no visual change.
            tracksViewChanges={false}
          />
        ))}
      </MapView>

      {/* ---- Top bar (search + filters) ---- */}
      {/* SafeAreaView ensures it doesn't overlap the status bar */}
      <SafeAreaView style={styles.topBar}>
        <View style={styles.topBarInner}>
          {/* Search input */}
          <View style={styles.searchWrapper}>
            <Ionicons name="search" size={16} color="#888" style={{ marginRight: 6 }} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search spots, users, or place…"
              placeholderTextColor="#888"
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={18} color="#888" />
              </TouchableOpacity>
            )}
          </View>

          {/* Profile button */}
          <TouchableOpacity style={styles.iconButton} onPress={() => router.push('/profile')}>
            <Ionicons name="person-outline" size={22} color={NAVY} />
          </TouchableOpacity>

          {/* Settings button */}
          <TouchableOpacity style={[styles.iconButton, { marginLeft: 8 }]} onPress={() => router.push('/settings')}>
            <Ionicons name="settings-outline" size={22} color={NAVY} />
          </TouchableOpacity>
        </View>

        {/* Horizontally scrollable tag filter chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {TAGS.map(tag => {
            const active = activeTags.includes(tag);
            return (
              <TouchableOpacity
                key={tag}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() =>
                  // Toggle tag on/off
                  setActiveTags(prev => active ? prev.filter(t => t !== tag) : [...prev, tag])
                }
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{tag}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </SafeAreaView>

      {/* ---- Empty state: no spots exist at all ---- */}
      {/* Only shown after spots have loaded so it doesn't flash on startup */}
      {spotsLoaded && spots.length === 0 && (
        <View style={styles.emptyState}>
          <Ionicons name="camera-outline" size={36} color={CREAM} />
          <Text style={styles.emptyStateTitle}>No spots yet!</Text>
          <Text style={styles.emptyStateSub}>Be the first to add a photo spot near you</Text>
        </View>
      )}

      {/* ---- Empty state: spots exist but none match current filters ---- */}
      {spotsLoaded && spots.length > 0 && filteredGroupedSpots.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No spots match your filters</Text>
        </View>
      )}

      {/* ---- Spot Peek bottom sheet ---- */}
      {selectedSpots.length > 0 && (
        <SpotPeek
          spots={selectedSpots}
          onClose={() => setSelectedSpots([])}
          toggleFavorite={toggleFavorite}
          openDirections={openDirections}
          favorites={favorites}
          isDark={isDark}
          currentUserId={auth.currentUser?.uid || ''}
          onDelete={deleteSpot}
          onReport={reportSpot}
          onBlock={blockSpotOwner}
          onTagPress={handleTagPress}
        />
      )}

      {/* ---- Floating action button (add a spot) ---- */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => router.push('/add-spot')}
        activeOpacity={0.85}
      >
        <Ionicons name="add" size={34} color={CREAM} />
      </TouchableOpacity>

    </View>
  );
}

// ============================================================
// STYLES
// ============================================================
const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  // Top bar floats above the map using absolute positioning
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 16, paddingBottom: 10, zIndex: 20 },
  topBarInner: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },

  // Glass-effect search bar
  searchWrapper: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.96)', borderRadius: 14,
    paddingHorizontal: 10, paddingVertical: 8,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 5,
  },
  searchInput: { flex: 1, fontSize: 15, color: NAVY },

  // Icon buttons (profile, settings)
  iconButton: {
    marginLeft: 10, backgroundColor: 'rgba(255,255,255,0.96)',
    padding: 9, borderRadius: 12,
    shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },

  // Filter chips
  chip: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.92)', marginRight: 8,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  chipActive: { backgroundColor: ORANGE },
  chipText: { color: NAVY, fontWeight: '700', fontSize: 13 },
  chipTextActive: { color: CREAM },

  // Floating add button
  fab: {
    position: 'absolute', bottom: 36, right: 20,
    width: 62, height: 62, borderRadius: 31, backgroundColor: NAVY,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: NAVY, shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8,
    borderWidth: 2, borderColor: ORANGE,
  },

  // Empty states
  emptyState: {
    position: 'absolute', bottom: 120, alignSelf: 'center', alignItems: 'center',
    backgroundColor: NAVY, paddingHorizontal: 24, paddingVertical: 18, borderRadius: 16,
    borderWidth: 1, borderColor: ORANGE,
  },
  emptyStateTitle: { color: CREAM, fontWeight: '800', fontSize: 16, marginTop: 8 },
  emptyStateSub: { color: '#D4C5B0', fontSize: 13, marginTop: 4, textAlign: 'center' },
  empty: {
    position: 'absolute', bottom: 120, alignSelf: 'center',
    backgroundColor: NAVY, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(227,92,37,0.4)',
  },
  emptyText: { color: CREAM, fontWeight: '600', fontSize: 14 },
});