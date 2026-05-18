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
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import OfflineBanner from '../../components/OfflineBanner';
import SpotPeek from '../../components/SpotPeek';
import { Spot, spotGalleryUrls } from '../../components/types';
import { BRAND } from '../../constants/brand';
import { appScreenBackground } from '../../constants/theme';
import { TAGS } from '../../constants/tags';
import { auth, db } from '../../utils/firebase';
import {
  addMapSearchHistoryEntry,
  clearMapSearchHistory,
  loadMapSearchHistory,
  removeMapSearchHistoryEntry,
} from '../../utils/map-search-history';
import {
  MAP_PIN_CLUSTER_THRESHOLD_METERS,
  centroidLatLng,
  clusterByDistanceMeters,
} from '../../utils/map-cluster';
import { maybePersistUserMapFocus, type MapFocusPersistState } from '../../utils/map-focus-profile';
import {
  blockedUserIdsList,
  subscribeMyBookmarks,
  type BookmarkListItem,
} from '../../utils/social';
import { deleteStorageObjectsByUrls } from '../../utils/storage-delete';
import { captureError } from '../../utils/sentry';
import { useTheme } from '../../utils/theme-context';

const { navy: NAVY, orange: ORANGE, cream: CREAM } = BRAND;

function tagMatchesFilter(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

type MapUserSearchHit = { username: string; displayUsername: string; profileIsPrivate: boolean };

/** Shared by map filtering and peek pruning. Text search matches title, caption, username, address, and tags. */
function spotMatchesHomeFilters(spot: Spot, searchQuery: string, activeTags: string[]): boolean {
  const q = searchQuery.trim().toLowerCase().replace(/^#/, '');
  const tagLine = (spot.tags || []).map((t) => String(t).trim()).filter(Boolean).join(' ');
  const text =
    `${spot.title} ${spot.caption} ${spot.username} ${spot.address || ''} ${tagLine}`.toLowerCase();
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
  const insets = useSafeAreaInsets();
  // Tab scene already clears the tab bar; full `insets.bottom` often reads the home indicator again and pushes chrome too high.
  const mapChromeBottom = 6 + Math.min(insets.bottom, 6);
  const fabBottom = mapChromeBottom;
  const fabRight = 20;
  const fabSize = 62;
  const locateGap = 10;
  const locateSize = 48;
  /** Locate sits left of the + FAB with a fixed gap; nudged up to vertically center with the taller FAB. */
  const locateRight = fabRight + fabSize + locateGap;
  const locateBottom = fabBottom + (fabSize - locateSize) / 2;
  /** Bookmark shortcut above the FAB row; horizontally aligned over the + button. */
  const mapQuickStackBottom = fabBottom + fabSize + 10;
  const mapQuickStackRight = fabRight + (fabSize - locateSize) / 2;
  const emptyStateBottom = fabBottom + 72;

  const screenBg = appScreenBackground(isDark);
  const mapSearchSurface = isDark ? 'rgba(34,52,72,0.96)' : 'rgba(255,255,255,0.96)';
  const mapSearchInk = isDark ? CREAM : NAVY;
  const mapSearchMuted = isDark ? 'rgba(231,219,203,0.5)' : '#888';
  const mapHistorySurface = isDark ? 'rgba(28,44,62,0.98)' : 'rgba(255,255,255,0.98)';
  const mapHistoryBorder = isDark ? 'rgba(231,219,203,0.14)' : 'rgba(0,0,0,0.08)';
  const mapHistoryTitle = isDark ? 'rgba(231,219,203,0.75)' : '#555';
  const mapHistoryRowText = isDark ? CREAM : NAVY;
  const mapHistoryTimeIcon = isDark ? 'rgba(231,219,203,0.55)' : '#666';
  const mapChromeTile = isDark
    ? { backgroundColor: 'rgba(255,255,255,0.14)', borderColor: 'rgba(231,219,203,0.22)' }
    : {};
  const mapTopIconColor = isDark ? CREAM : NAVY;
  // Optional ?tag=Nature query param — pre-applies a tag filter
  // when arriving from another screen (e.g. tag press in SpotPeek).
  // Optional ?lat=&lng=&zoom= from Saves / Feed activity to center the map.
  const {
    tag: incomingTag,
    lat: paramLat,
    lng: paramLng,
    zoom: paramZoom,
    spotId: paramSpotId,
    focusCommentId: paramFocusCommentId,
  } = useLocalSearchParams<{
    tag?: string;
    lat?: string;
    lng?: string;
    zoom?: string;
    spotId?: string;
    focusCommentId?: string;
  }>();

  // ---- Map state ----
  const [region, setRegion] = useState<Region | null>(null);
  const [locationError, setLocationError] = useState(false);
  // Ref to the MapView so we can imperatively animate the camera
  // (zoom-in when a pin is tapped). Using `any` because the typed
  // ref from react-native-maps requires importing the full MapView
  // class type, which complicates the import.
  const mapRef = useRef<MapView | null>(null);
  const mapFocusDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mapFocusLastRef = useRef<MapFocusPersistState>(null);
  const mapFocusUidRef = useRef<string | null>(null);

  // ---- Spots state ----
  const [spots, setSpots] = useState<Spot[]>([]);
  const [spotsLoaded, setSpotsLoaded] = useState(false);   // Prevents empty state flashing before data loads

  // ---- UI state ----
  const [selectedSpots, setSelectedSpots] = useState<Spot[]>([]); // Spots shown in the peek sheet
  /** Spot IDs the current user has bookmarked — drives gold pins on the map. */
  const [bookmarkedSpotIds, setBookmarkedSpotIds] = useState<Set<string>>(new Set());
  /** UIDs whose spots are hidden from this user's map (see Settings to unblock). */
  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
  const blockedUserIdsRef = useRef<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [searchHistoryOpen, setSearchHistoryOpen] = useState(false);
  const [userSearchHits, setUserSearchHits] = useState<MapUserSearchHit[]>([]);
  const [userSearchLoading, setUserSearchLoading] = useState(false);
  const userSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyBlurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped when SpotPeek closes so Marker keys change; native maps often keep the pin
   * selected after dismiss, so a second tap would not fire onPress until tapping away. */
  const [markerPressEpoch, setMarkerPressEpoch] = useState(0);
  const peekWasOpenRef = useRef(false);

  useEffect(() => {
    blockedUserIdsRef.current = blockedUserIds;
  }, [blockedUserIds]);

  const cancelHistoryPanelClose = () => {
    if (historyBlurTimer.current) {
      clearTimeout(historyBlurTimer.current);
      historyBlurTimer.current = null;
    }
  };

  const scheduleHistoryPanelClose = () => {
    cancelHistoryPanelClose();
    historyBlurTimer.current = setTimeout(() => {
      historyBlurTimer.current = null;
      setSearchHistoryOpen(false);
    }, 280);
  };

  useEffect(() => () => cancelHistoryPanelClose(), []);

  useEffect(() => {
    return () => {
      if (mapFocusDebounceRef.current) {
        clearTimeout(mapFocusDebounceRef.current);
        mapFocusDebounceRef.current = null;
      }
    };
  }, []);

  const onMapRegionChangeComplete = useCallback((r: Region) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    if (mapFocusUidRef.current !== uid) {
      mapFocusUidRef.current = uid;
      mapFocusLastRef.current = null;
    }
    if (mapFocusDebounceRef.current) clearTimeout(mapFocusDebounceRef.current);
    mapFocusDebounceRef.current = setTimeout(() => {
      mapFocusDebounceRef.current = null;
      void (async () => {
        try {
          mapFocusLastRef.current = await maybePersistUserMapFocus(uid, r, mapFocusLastRef.current);
        } catch (e) {
          captureError(e, { area: 'HomeScreen.mapFocus' });
        }
      })();
    }, 10000);
  }, []);

  const refreshSearchHistory = useCallback(async () => {
    setSearchHistory(await loadMapSearchHistory());
  }, []);

  useEffect(() => {
    void refreshSearchHistory();
  }, [refreshSearchHistory]);

  useEffect(() => {
    const open = selectedSpots.length > 0;
    if (peekWasOpenRef.current && !open) {
      setMarkerPressEpoch((e) => e + 1);
    }
    peekWasOpenRef.current = open;
  }, [selectedSpots]);

  /** After opening SpotPeek from a push/deep link, scroll comments to this id (then cleared). */
  const [peekFocusCommentId, setPeekFocusCommentId] = useState<string | null>(null);

  /** Prevents double-handling ?spotId= while params update or spots snapshot churn. */
  const appliedSpotLinkRef = useRef<string | null>(null);

  // Center map when opening from Bookmarks (?lat=&lng=&zoom=).
  const appliedBookmarkParams = useRef<string | null>(null);
  useEffect(() => {
    if (!paramLat || !paramLng || !region) return;
    const key = `${paramLat},${paramLng},${paramZoom || ''}`;
    if (appliedBookmarkParams.current === key) return;
    appliedBookmarkParams.current = key;
    const la = Number(paramLat);
    const ln = Number(paramLng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
    const delta = Math.min(0.5, Math.max(0.002, Number(paramZoom) || 0.012));
    const r = { latitude: la, longitude: ln, latitudeDelta: delta, longitudeDelta: delta };
    const t = setTimeout(() => {
      mapRef.current?.animateToRegion(r, 500);
      setRegion(r);
    }, 200);
    return () => clearTimeout(t);
  }, [paramLat, paramLng, paramZoom, region]);

  // ---- Apply incoming ?tag= query param ----
  // Runs once per distinct incoming tag so navigating to /main?tag=X
  // selects that filter chip automatically.
  useEffect(() => {
    const raw = Array.isArray(incomingTag) ? incomingTag[0] : incomingTag;
    if (!raw || typeof raw !== 'string') return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    setActiveTags((prev) =>
      prev.some((t) => tagMatchesFilter(t, trimmed)) ? prev : [...prev, trimmed]
    );
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
    cancelHistoryPanelClose();
    setSearchHistoryOpen(false);
    const trimmed = tag.trim();
    if (!trimmed) return;
    setActiveTags((prev) =>
      prev.some((t) => tagMatchesFilter(t, trimmed)) ? prev : [...prev, trimmed]
    );
  };

  const mapFilterTagChips = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    const push = (label: string) => {
      const s = String(label).trim();
      if (!s) return;
      const k = s.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      ordered.push(s);
    };
    TAGS.forEach((t) => push(t));
    for (const sp of spots) {
      for (const t of sp.tags || []) push(String(t));
    }
    return ordered;
  }, [spots]);

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
        if (spotsUnsub) {
          spotsUnsub();
          spotsUnsub = null;
        }
        // User is logged in — start listening to spots
        spotsUnsub = onSnapshot(collection(db, 'spots'), snap => {
          const loaded: Spot[] = [];
          snap.forEach(d => {
            const data = d.data();
            if (!data.location) return;
            const uid = data.userId || '';
            if (uid && blockedUserIdsRef.current.includes(uid)) return;
            const rawUrls = data.imageUrls;
            const imageUrls = Array.isArray(rawUrls)
              ? rawUrls.filter((u: unknown): u is string => typeof u === 'string' && u.trim().length > 0)
              : undefined;
            loaded.push({
              id: d.id,
              latitude: data.location.latitude,
              longitude: data.location.longitude,
              imageUrl: data.imageUrl || '',
              ...(imageUrls && imageUrls.length > 0 ? { imageUrls } : {}),
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

  // Live listener on the current user's document for block list (and other profile fields).
  useEffect(() => {
    let userDocUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        if (userDocUnsub) {
          userDocUnsub();
          userDocUnsub = null;
        }
        userDocUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
          if (!snap.exists()) return;
          const data = snap.data() as Record<string, unknown>;
          setBlockedUserIds(blockedUserIdsList(data));
        });
      } else {
        if (userDocUnsub) {
          userDocUnsub();
          userDocUnsub = null;
        }
        setBlockedUserIds([]);
      }
    });

    return () => {
      authUnsub();
      if (userDocUnsub) userDocUnsub();
    };
  }, []);

  // Bookmarked spot IDs — gold pins match saved spots (users/{uid}/bookmarks).
  useEffect(() => {
    let bmUnsub: (() => void) | null = null;
    const authUnsub = onAuthStateChanged(auth, (user) => {
      bmUnsub?.();
      bmUnsub = null;
      if (user) {
        bmUnsub = subscribeMyBookmarks(user.uid, (items: BookmarkListItem[]) => {
          setBookmarkedSpotIds(new Set(items.map((i) => i.spotId)));
        });
      } else {
        setBookmarkedSpotIds(new Set());
      }
    });
    return () => {
      authUnsub();
      bmUnsub?.();
    };
  }, []);

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
            await deleteStorageObjectsByUrls(spotGalleryUrls(spot));
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

  /** Recenters the map on the device GPS (same pattern as Google Maps “my location”). */
  const recenterOnMyLocation = useCallback(async () => {
    Keyboard.dismiss();
    cancelHistoryPanelClose();
    setSearchHistoryOpen(false);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Location permission',
          'Allow location access to jump the map back to where you are. You can change this in your device settings.',
          [{ text: 'OK' }]
        );
        return;
      }
      setLocationError(false);
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const r: Region = {
        latitude: loc.coords.latitude,
        longitude: loc.coords.longitude,
        latitudeDelta: 0.04,
        longitudeDelta: 0.04,
      };
      mapRef.current?.animateToRegion(r, 500);
      setRegion(r);
    } catch (err) {
      captureError(err, { area: 'HomeScreen.recenterOnMyLocation' });
      Alert.alert('Could not get location', 'Try again in a moment.');
    }
  }, []);

  // ============================================================
  // HANDLE MARKER TAP
  // Animates the map to zoom into the tapped pin (roughly a
  // few-block radius) and then opens the SpotPeek sheet.
  // The deltas are smaller than the default region delta so it
  // feels like a real "zoom in" rather than just a recenter.
  // ============================================================
  const handleMarkerPress = (group: Spot[]) => {
    Keyboard.dismiss();
    cancelHistoryPanelClose();
    setSearchHistoryOpen(false);
    const target = centroidLatLng(group);
    if (mapRef.current && group.length > 0) {
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
  // We cluster by distance (see MAP_PIN_CLUSTER_THRESHOLD_METERS) so
  // nearly identical GPS picks still share one pin; tap shows every spot in the cluster.
  // ============================================================
  const filteredGroupedSpots = useMemo(() => {
    const filtered = spots.filter((spot) => spotMatchesHomeFilters(spot, searchQuery, activeTags));
    const clusters = clusterByDistanceMeters(filtered, MAP_PIN_CLUSTER_THRESHOLD_METERS);
    return clusters.map((group) => ({
      clusterKey: [...group]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((s) => s.id)
        .join('|'),
      group,
    }));
  }, [spots, searchQuery, activeTags]);

  // Open SpotPeek from a shared link: /main?spotId=…&focusCommentId=… or pinpix://spot/{id} → /spot/{id} → here.
  useEffect(() => {
    const raw = Array.isArray(paramSpotId) ? paramSpotId[0] : paramSpotId;
    const sid = typeof raw === 'string' ? raw.trim() : '';
    const rawFocus = Array.isArray(paramFocusCommentId)
      ? paramFocusCommentId[0]
      : paramFocusCommentId;
    const fid = typeof rawFocus === 'string' ? rawFocus.trim() : '';
    const linkKey = `${sid}|${fid}`;

    if (!spotsLoaded) return;
    if (!sid) {
      appliedSpotLinkRef.current = null;
      return;
    }
    if (appliedSpotLinkRef.current === linkKey) return;

    const spot = spots.find((s) => s.id === sid);
    if (!spot) {
      // Wait for the first non-empty snapshot before treating the id as missing.
      if (spots.length === 0) return;
      appliedSpotLinkRef.current = linkKey;
      Alert.alert(
        'Spot unavailable',
        'This spot may have been removed, filtered out, or you may not have access yet.'
      );
      router.setParams({ spotId: undefined, focusCommentId: undefined });
      return;
    }

    const entry = filteredGroupedSpots.find(({ group }) => group.some((s) => s.id === sid));
    Keyboard.dismiss();
    cancelHistoryPanelClose();
    setSearchHistoryOpen(false);

    if (fid) {
      setPeekFocusCommentId(fid);
      mapRef.current?.animateToRegion(
        {
          latitude: spot.latitude,
          longitude: spot.longitude,
          latitudeDelta: 0.005,
          longitudeDelta: 0.005,
        },
        400
      );
      setSelectedSpots([spot]);
    } else if (entry) {
      const target = centroidLatLng(entry.group);
      if (mapRef.current && entry.group.length > 0) {
        mapRef.current.animateToRegion(
          {
            latitude: target.latitude,
            longitude: target.longitude,
            latitudeDelta: 0.005,
            longitudeDelta: 0.005,
          },
          400
        );
      }
      setSelectedSpots(entry.group);
    } else {
      mapRef.current?.animateToRegion(
        {
          latitude: spot.latitude,
          longitude: spot.longitude,
          latitudeDelta: 0.005,
          longitudeDelta: 0.005,
        },
        400
      );
      setSelectedSpots([spot]);
    }

    appliedSpotLinkRef.current = linkKey;
    router.setParams({ spotId: undefined, focusCommentId: undefined });
  }, [spotsLoaded, spots, filteredGroupedSpots, paramSpotId, paramFocusCommentId, router]);

  /** Zoom map to every spot matching `query` + `tags` (used by Enter and by picking a history row). */
  const fitMapToFilters = useCallback(
    (query: string, tags: string[]) => {
      Keyboard.dismiss();
      const hasFilter = query.trim().length > 0 || tags.length > 0;
      if (!hasFilter) return;

      if (!spotsLoaded) {
        Alert.alert('One moment', 'Spots are still loading. Try again in a second.');
        return;
      }

      const filtered = spots.filter((s) => spotMatchesHomeFilters(s, query, tags));
      if (filtered.length === 0) {
        Alert.alert('No matches', 'No spots match your search and tag filters.');
        return;
      }

      const coords = filtered.map((s) => ({ latitude: s.latitude, longitude: s.longitude }));
      const map = mapRef.current;
      if (!map) return;

      const sameSpot =
        coords.length > 1 &&
        coords.every(
          (c) =>
            Math.abs(c.latitude - coords[0].latitude) < 1e-5 &&
            Math.abs(c.longitude - coords[0].longitude) < 1e-5
        );

      if (coords.length === 1 || sameSpot) {
        const c = coords[0];
        map.animateToRegion(
          { latitude: c.latitude, longitude: c.longitude, latitudeDelta: 0.035, longitudeDelta: 0.035 },
          450
        );
        return;
      }

      map.fitToCoordinates(coords, {
        edgePadding: { top: 150, right: 20, bottom: 100, left: 20 },
        animated: true,
      });
    },
    [spots, spotsLoaded]
  );

  const tryNavigateProfileExact = useCallback(async (raw: string): Promise<boolean> => {
    const uname = raw.trim().replace(/^@/, '').toLowerCase();
    if (!uname) return false;
    try {
      const snap = await getDocs(
        query(collection(db, 'users'), where('username', '==', uname), limit(1))
      );
      if (snap.empty) return false;
      const docSnap = snap.docs[0];
      if (blockedUserIdsRef.current.includes(docSnap.id)) return false;
      const myUid = auth.currentUser?.uid;
      if (myUid && docSnap.id === myUid) {
        router.push('/main/profile');
        return true;
      }
      const slug = (docSnap.data().username as string) || uname;
      router.push(`/user/${slug}`);
      return true;
    } catch (e) {
      captureError(e, { area: 'HomeScreen.tryNavigateProfileExact' });
      return false;
    }
  }, [router]);

  const handleSearchSubmit = useCallback(async () => {
    cancelHistoryPanelClose();
    setSearchHistoryOpen(false);
    const trimmed = searchQuery.trim();
    if (trimmed) {
      await addMapSearchHistoryEntry(trimmed);
      await refreshSearchHistory();
    }
    if (await tryNavigateProfileExact(trimmed)) {
      Keyboard.dismiss();
      return;
    }
    fitMapToFilters(searchQuery, activeTags);
  }, [searchQuery, activeTags, fitMapToFilters, refreshSearchHistory, tryNavigateProfileExact]);

  const filteredSearchHistory = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return searchHistory;
    return searchHistory.filter((h) => h.toLowerCase().includes(q));
  }, [searchHistory, searchQuery]);

  const filteredTagSuggestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase().replace(/^#/, '');
    if (q.length < 2) return [];
    return mapFilterTagChips.filter((tag) => tag.toLowerCase().includes(q)).slice(0, 10);
  }, [searchQuery, mapFilterTagChips]);

  const applyTagFilter = useCallback(
    (tag: string) => {
      cancelHistoryPanelClose();
      setSearchHistoryOpen(false);
      Keyboard.dismiss();
      setSearchQuery('');
      setActiveTags((prev) => {
        const next = prev.some((t) => tagMatchesFilter(t, tag)) ? prev : [...prev, tag];
        requestAnimationFrame(() => fitMapToFilters('', next));
        return next;
      });
    },
    [fitMapToFilters]
  );

  const mapSearchSuggestionsOpen =
    searchHistoryOpen &&
    (searchHistory.length > 0 ||
      searchQuery.trim().length >= 2 ||
      filteredTagSuggestions.length > 0);

  useEffect(() => {
    const raw = searchQuery.trim().replace(/^@/, '').toLowerCase();
    if (userSearchDebounceRef.current) {
      clearTimeout(userSearchDebounceRef.current);
      userSearchDebounceRef.current = null;
    }
    if (raw.length < 2) {
      setUserSearchHits([]);
      setUserSearchLoading(false);
      return;
    }
    userSearchDebounceRef.current = setTimeout(() => {
      userSearchDebounceRef.current = null;
      void (async () => {
        setUserSearchLoading(true);
        try {
          const snap = await getDocs(
            query(
              collection(db, 'users'),
              where('username', '>=', raw),
              where('username', '<=', `${raw}\uf8ff`),
              limit(12)
            )
          );
          const me = auth.currentUser?.uid;
          const blocked = blockedUserIdsRef.current;
          const hits: MapUserSearchHit[] = [];
          snap.forEach((d) => {
            if (me && d.id === me) return;
            if (blocked.includes(d.id)) return;
            const data = d.data();
            const username = (data.username as string) || '';
            if (!username) return;
            hits.push({
              username,
              displayUsername: (data.displayUsername || data.username || username) as string,
              profileIsPrivate: (data.profileVisible as boolean | undefined) === false,
            });
          });
          setUserSearchHits(hits);
        } catch (e) {
          captureError(e, { area: 'HomeScreen.userSearchPrefix' });
          setUserSearchHits([]);
        } finally {
          setUserSearchLoading(false);
        }
      })();
    }, 280);
    return () => {
      if (userSearchDebounceRef.current) {
        clearTimeout(userSearchDebounceRef.current);
        userSearchDebounceRef.current = null;
      }
    };
  }, [searchQuery, blockedUserIds]);

  /** Baked into marker keys so react-native-maps remounts pins whenever filters change
      (not only toggling filtered vs unfiltered), avoiding stale native annotations on iOS. */
  const markerFilterStamp = `${searchQuery.trim()}|${[...activeTags].sort().join(',')}`;

  // Show loading text until we have a region
  if (!region) return (
    <View style={[styles.center, { backgroundColor: screenBg }]}>
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
        onRegionChangeComplete={onMapRegionChangeComplete}
        onPress={() => {
          Keyboard.dismiss();
          cancelHistoryPanelClose();
          setSearchHistoryOpen(false);
        }}
      >
        {/* One marker per distance cluster (utils/map-cluster). Marker key includes the
            filter stamp and press epoch so pins remount when filters change or SpotPeek closes
            (avoids stale native annotations on iOS). */}
        {filteredGroupedSpots.map(({ clusterKey, group }) => {
          const coord = centroidLatLng(group);
          const pinGold = group.some((s) => bookmarkedSpotIds.has(s.id));
          return (
            <Marker
              key={`${markerFilterStamp}|${clusterKey}|p${markerPressEpoch}`}
              coordinate={{ latitude: coord.latitude, longitude: coord.longitude }}
              pinColor={pinGold ? '#FFD700' : ORANGE} // Gold if any spot in cluster is favorited
              onPress={() => handleMarkerPress(group)} // Zoom in + show peek sheet
              // Tells the native marker view it doesn't need to constantly
              // redraw itself — small perf win, no visual change.
              tracksViewChanges={false}
            />
          );
        })}
      </MapView>

      {/* ---- Top bar (search + filters) ---- */}
      {/* SafeAreaView ensures it doesn't overlap the status bar */}
      <SafeAreaView style={styles.topBar}>
        <View style={styles.topBarSearchRow}>
          <View style={styles.searchColumn}>
            <View style={[styles.searchWrapper, { backgroundColor: mapSearchSurface }]}>
              <Ionicons name="search" size={16} color={mapSearchMuted} style={{ marginRight: 6 }} />
              <TextInput
                style={[styles.searchInput, { color: mapSearchInk }]}
                placeholder="Search spots, tags, or @username…"
                placeholderTextColor={mapSearchMuted}
                value={searchQuery}
                onChangeText={(t) => {
                  setSearchQuery(t);
                  if (t.trim().length >= 2) {
                    cancelHistoryPanelClose();
                    setSearchHistoryOpen(true);
                  }
                }}
                returnKeyType="search"
                blurOnSubmit
                onSubmitEditing={() => void handleSearchSubmit()}
                onFocus={() => {
                  cancelHistoryPanelClose();
                  if (searchHistory.length > 0 || searchQuery.trim().length >= 2) {
                    setSearchHistoryOpen(true);
                  }
                }}
                onBlur={() => scheduleHistoryPanelClose()}
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity
                  onPress={() => {
                    setSearchQuery('');
                    cancelHistoryPanelClose();
                    setSearchHistoryOpen(false);
                  }}
                >
                  <Ionicons name="close-circle" size={18} color={mapSearchMuted} />
                </TouchableOpacity>
              )}
            </View>

            {mapSearchSuggestionsOpen && (
              <View
                style={[
                  styles.searchHistoryDropdown,
                  {
                    backgroundColor: mapHistorySurface,
                    borderColor: mapHistoryBorder,
                  },
                ]}
              >
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  style={styles.searchHistoryList}
                  showsVerticalScrollIndicator={false}
                >
                  {searchQuery.trim().length >= 2 ? (
                    <View>
                      <View
                        style={[
                          styles.searchSectionHeaderRow,
                          isDark && {
                            borderBottomColor: 'rgba(231,219,203,0.1)',
                            backgroundColor: 'rgba(0,0,0,0.12)',
                          },
                        ]}
                      >
                        <Text style={[styles.searchHistoryTitle, { color: mapHistoryTitle }]}>Profiles</Text>
                      </View>
                      {userSearchLoading ? (
                        <Text style={[styles.searchHistoryEmpty, { color: mapSearchMuted }]}>Searching…</Text>
                      ) : userSearchHits.length > 0 ? (
                        userSearchHits.map((hit) => (
                          <View key={hit.username} style={styles.searchHistoryRow}>
                            <TouchableOpacity
                              style={[
                                styles.searchHistoryRowMain,
                                { alignItems: 'flex-start', paddingTop: 10, paddingBottom: 10 },
                              ]}
                              onPressIn={cancelHistoryPanelClose}
                              onPress={() => {
                                setSearchHistoryOpen(false);
                                Keyboard.dismiss();
                                router.push(`/user/${hit.username}`);
                              }}
                            >
                              <Ionicons
                                name="person-outline"
                                size={18}
                                color={mapHistoryTimeIcon}
                                style={{ marginRight: 10 }}
                              />
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <Text
                                  style={[styles.searchProfilePrimary, { color: mapHistoryRowText }]}
                                  numberOfLines={1}
                                >
                                  @{hit.username}
                                </Text>
                                <Text
                                  style={[styles.searchProfileSubline, { color: mapSearchMuted }]}
                                  numberOfLines={1}
                                >
                                  {hit.displayUsername}
                                  {hit.profileIsPrivate ? ' · Private account' : ''}
                                </Text>
                              </View>
                            </TouchableOpacity>
                          </View>
                        ))
                      ) : (
                        <Text style={[styles.searchHistoryEmpty, { color: mapSearchMuted }]}>
                          No matching usernames — includes private accounts when the @handle matches. Map search
                          still filters spots and tags.
                        </Text>
                      )}
                    </View>
                  ) : null}

                  {filteredTagSuggestions.length > 0 ? (
                    <View>
                      {searchQuery.trim().length >= 2 ? (
                        <View
                          style={[
                            styles.searchDropdownDivider,
                            isDark && { backgroundColor: 'rgba(231,219,203,0.1)' },
                          ]}
                        />
                      ) : null}
                      <View
                        style={[
                          styles.searchSectionHeaderRow,
                          isDark && {
                            borderBottomColor: 'rgba(231,219,203,0.1)',
                            backgroundColor: 'rgba(0,0,0,0.12)',
                          },
                        ]}
                      >
                        <Text style={[styles.searchHistoryTitle, { color: mapHistoryTitle }]}>Tags</Text>
                      </View>
                      {filteredTagSuggestions.map((tag) => {
                        const active = activeTags.some((t) => tagMatchesFilter(t, tag));
                        return (
                          <View key={tag} style={styles.searchHistoryRow}>
                            <TouchableOpacity
                              style={styles.searchHistoryRowMain}
                              onPressIn={cancelHistoryPanelClose}
                              onPress={() => applyTagFilter(tag)}
                            >
                              <Ionicons
                                name="pricetag-outline"
                                size={18}
                                color={mapHistoryTimeIcon}
                                style={{ marginRight: 10 }}
                              />
                              <Text style={[styles.searchHistoryText, { color: mapHistoryRowText }]} numberOfLines={1}>
                                {tag}
                                {active ? ' · filtering' : ''}
                              </Text>
                            </TouchableOpacity>
                          </View>
                        );
                      })}
                    </View>
                  ) : null}

                  {searchHistory.length > 0 ? (
                    <View>
                      {searchQuery.trim().length >= 2 ? (
                        <View
                          style={[
                            styles.searchDropdownDivider,
                            isDark && { backgroundColor: 'rgba(231,219,203,0.1)' },
                          ]}
                        />
                      ) : null}
                      <View
                        style={[
                          styles.searchHistoryHeaderRow,
                          isDark && {
                            borderBottomColor: 'rgba(231,219,203,0.1)',
                            backgroundColor: 'rgba(0,0,0,0.12)',
                          },
                        ]}
                      >
                        <Text style={[styles.searchHistoryTitle, { color: mapHistoryTitle }]}>
                          Recent searches
                        </Text>
                        <TouchableOpacity
                          onPressIn={cancelHistoryPanelClose}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          onPress={() => {
                            Alert.alert('Clear recent searches?', 'This only clears searches on this device.', [
                              { text: 'Cancel', style: 'cancel' },
                              {
                                text: 'Clear',
                                style: 'destructive',
                                onPress: () => {
                                  void (async () => {
                                    await clearMapSearchHistory();
                                    await refreshSearchHistory();
                                    setSearchHistoryOpen(false);
                                  })();
                                },
                              },
                            ]);
                          }}
                        >
                          <Text style={styles.searchHistoryClear}>Clear</Text>
                        </TouchableOpacity>
                      </View>
                      {filteredSearchHistory.length === 0 ? (
                        <Text style={[styles.searchHistoryEmpty, { color: mapSearchMuted }]}>
                          No matching recents
                        </Text>
                      ) : (
                        filteredSearchHistory.map((item) => (
                          <View key={item} style={styles.searchHistoryRow}>
                            <TouchableOpacity
                              style={styles.searchHistoryRowMain}
                              onPressIn={cancelHistoryPanelClose}
                              onPress={() => {
                                setSearchQuery(item);
                                setSearchHistoryOpen(false);
                                void addMapSearchHistoryEntry(item);
                                void refreshSearchHistory();
                                requestAnimationFrame(() => fitMapToFilters(item, activeTags));
                              }}
                            >
                              <Ionicons
                                name="time-outline"
                                size={18}
                                color={mapHistoryTimeIcon}
                                style={{ marginRight: 10 }}
                              />
                              <Text style={[styles.searchHistoryText, { color: mapHistoryRowText }]} numberOfLines={2}>
                                {item}
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              onPressIn={cancelHistoryPanelClose}
                              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                              style={styles.searchHistoryRemove}
                              onPress={() => {
                                void (async () => {
                                  await removeMapSearchHistoryEntry(item);
                                  await refreshSearchHistory();
                                })();
                              }}
                            >
                              <Ionicons name="close-outline" size={22} color={mapSearchMuted} />
                            </TouchableOpacity>
                          </View>
                        ))
                      )}
                    </View>
                  ) : null}
                </ScrollView>
              </View>
            )}
          </View>

          <View style={styles.topBarTrailingButtons}>
            <TouchableOpacity
              style={[styles.iconButton, mapChromeTile]}
              onPress={() => router.push('/settings')}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              accessibilityLabel="Settings"
            >
              <Ionicons name="settings-outline" size={22} color={mapTopIconColor} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Horizontally scrollable tag filter chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {mapFilterTagChips.map((tag) => {
            const active = activeTags.some((t) => tagMatchesFilter(t, tag));
            return (
              <TouchableOpacity
                key={tag}
                style={[
                  styles.chip,
                  active && styles.chipActive,
                  !active && isDark && { backgroundColor: 'rgba(255,255,255,0.12)' },
                ]}
                onPress={() =>
                  setActiveTags((prev) => {
                    const on = prev.some((t) => tagMatchesFilter(t, tag));
                    return on ? prev.filter((t) => !tagMatchesFilter(t, tag)) : [...prev, tag];
                  })
                }
              >
                <Text
                  style={[
                    styles.chipText,
                    active && styles.chipTextActive,
                    !active && isDark && { color: CREAM },
                  ]}
                >
                  {tag}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </SafeAreaView>

      {/* ---- Empty state: no spots exist at all ---- */}
      {/* Only shown after spots have loaded so it doesn't flash on startup */}
      {spotsLoaded && spots.length === 0 && (
        <View style={[styles.emptyState, { bottom: emptyStateBottom, backgroundColor: screenBg }]}>
          <Ionicons name="camera-outline" size={36} color={CREAM} />
          <Text style={styles.emptyStateTitle}>No spots yet!</Text>
          <Text style={styles.emptyStateSub}>Be the first to add a photo spot near you</Text>
        </View>
      )}

      {/* ---- Empty state: spots exist but none match current filters ---- */}
      {spotsLoaded && spots.length > 0 && filteredGroupedSpots.length === 0 && (
        <View style={[styles.empty, { bottom: emptyStateBottom, backgroundColor: screenBg }]}>
          <Text style={styles.emptyText}>No spots match your filters</Text>
        </View>
      )}

      {/* ---- Spot Peek bottom sheet ---- */}
      {selectedSpots.length > 0 && (
        <SpotPeek
          peekContext="map"
          spots={selectedSpots}
          onClose={() => {
            setSelectedSpots([]);
            setPeekFocusCommentId(null);
          }}
          openDirections={openDirections}
          isDark={isDark}
          currentUserId={auth.currentUser?.uid || ''}
          onDelete={deleteSpot}
          onEdit={(spot) => {
            setSelectedSpots([]);
            setPeekFocusCommentId(null);
            router.push(`/edit-spot/${spot.id}`);
          }}
          onReport={reportSpot}
          onBlock={blockSpotOwner}
          onTagPress={handleTagPress}
          initialFocusCommentId={peekFocusCommentId}
          onInitialFocusCommentHandled={() => setPeekFocusCommentId(null)}
        />
      )}

      {/* ---- Saved (circular) above locate + add row (hidden while peek is open) ---- */}
      {selectedSpots.length === 0 && (
        <>
          <View style={[styles.mapQuickStack, { bottom: mapQuickStackBottom, right: mapQuickStackRight }]}>
            <TouchableOpacity
              style={[styles.mapQuickCircle, mapChromeTile]}
              onPress={() => router.push('/favorites')}
              activeOpacity={0.85}
              hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
              accessibilityLabel="Saved spots"
            >
              <Ionicons name="bookmark-outline" size={22} color={mapTopIconColor} />
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[styles.locateMeFab, mapChromeTile, { bottom: locateBottom, right: locateRight }]}
            onPress={() => void recenterOnMyLocation()}
            activeOpacity={0.85}
            accessibilityLabel="Center map on my location"
          >
            <Ionicons name="locate" size={26} color={mapTopIconColor} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.fab, { bottom: fabBottom, right: fabRight }]}
            onPress={() => router.push('/add-spot')}
            activeOpacity={0.85}
            accessibilityLabel="Add a spot"
          >
            <Ionicons name="add" size={34} color={CREAM} />
          </TouchableOpacity>
        </>
      )}

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
  topBar: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12, paddingBottom: 10, zIndex: 20 },
  /** Search stretches left; settings top-right. */
  topBarSearchRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8, gap: 8 },
  topBarTrailingButtons: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    flexShrink: 0,
    gap: 8,
    marginTop: 1,
  },
  /** Settings — light pills + navy icons (same language as search bar). */
  iconButton: {
    backgroundColor: 'rgba(255,255,255,0.96)',
    padding: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(17,35,55,0.12)',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },

  searchColumn: {
    flex: 1,
    minWidth: 0,
    position: 'relative',
    zIndex: 30,
  },
  searchHistoryDropdown: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '100%',
    marginTop: 6,
    maxHeight: 320,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
    overflow: 'hidden',
  },
  searchSectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.08)',
    backgroundColor: 'rgba(0,0,0,0.03)',
  },
  searchDropdownDivider: {
    height: 8,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  searchHistoryHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.08)',
    backgroundColor: 'rgba(0,0,0,0.03)',
  },
  searchHistoryTitle: { fontSize: 12, fontWeight: '800', color: '#555', letterSpacing: 0.3 },
  searchHistoryClear: { fontSize: 13, fontWeight: '700', color: ORANGE },
  searchHistoryList: { maxHeight: 280 },
  searchHistoryEmpty: {
    paddingHorizontal: 14,
    paddingVertical: 16,
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
  },
  searchHistoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  searchHistoryRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingLeft: 12,
    paddingRight: 4,
  },
  searchHistoryText: { flex: 1, fontSize: 15, color: NAVY },
  searchProfilePrimary: { fontSize: 15, fontWeight: '700' },
  searchProfileSubline: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  searchHistoryRemove: { paddingHorizontal: 10, paddingVertical: 8 },

  // Glass-effect search bar
  searchWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.96)', borderRadius: 14,
    paddingHorizontal: 12, paddingVertical: 10,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 5,
  },
  searchInput: { flex: 1, fontSize: 16, color: NAVY, minWidth: 0 },

  // Saved + social: circular stack above locate (right rail)
  mapQuickStack: {
    position: 'absolute',
    flexDirection: 'column',
    gap: 10,
    zIndex: 12,
    alignItems: 'center',
  },
  mapQuickCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.96)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
    borderWidth: 1,
    borderColor: 'rgba(17,35,55,0.12)',
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

  // Floating "my location" — left of add; same bottom as FAB (FAB is taller).
  locateMeFab: {
    position: 'absolute',
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.96)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
    borderWidth: 1,
    borderColor: 'rgba(17,35,55,0.12)',
    zIndex: 12,
  },

  // Floating add button
  fab: {
    position: 'absolute',
    width: 62, height: 62, borderRadius: 31, backgroundColor: NAVY,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: NAVY, shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 8,
    borderWidth: 2, borderColor: ORANGE,
  },

  // Empty states
  emptyState: {
    position: 'absolute', alignSelf: 'center', alignItems: 'center',
    backgroundColor: NAVY, paddingHorizontal: 24, paddingVertical: 18, borderRadius: 16,
    borderWidth: 1, borderColor: ORANGE,
  },
  emptyStateTitle: { color: CREAM, fontWeight: '800', fontSize: 16, marginTop: 8 },
  emptyStateSub: { color: '#D4C5B0', fontSize: 13, marginTop: 4, textAlign: 'center' },
  empty: {
    position: 'absolute', alignSelf: 'center',
    backgroundColor: NAVY, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(227,92,37,0.4)',
  },
  emptyText: { color: CREAM, fontWeight: '600', fontSize: 14 },
});