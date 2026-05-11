// ============================================================
// ProfileScreen.tsx — User's Own Profile
// ------------------------------------------------------------
// Shows the current user's profile with:
//   - Their avatar and username
//   - A count of how many spots they've posted
//   - A 3-column photo grid of all their spots
//
// Tapping a tile opens the SpotPeek bottom sheet, the same
// sheet that appears when tapping a map pin on HomeScreen.
// This lets the user view, favorite, delete, or get directions
// to any of their spots right from their profile.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { deleteObject, ref as storageRef } from 'firebase/storage';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import SpotPeek from '../components/SpotPeek';
import { Spot } from '../components/types';
import { BRAND } from '../constants/brand';
import { auth, db, storage } from '../utils/firebase';
import { useTheme } from '../utils/theme-context';

const { width } = Dimensions.get('window');

// Each tile is 1/3 of the screen width with 2px gaps
const TILE_SIZE = (width - 4) / 3;

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function ProfileScreen() {
  const router = useRouter();
  const { isDark } = useTheme();

  // ---- User state ----
  const [username, setUsername] = useState('');
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ---- Spots state ----
  const [mySpots, setMySpots] = useState<Spot[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);

  // ---- SpotPeek state ----
  // When the user taps a tile, we set selectedSpot to show the peek sheet
  const [selectedSpot, setSelectedSpot] = useState<Spot | null>(null);

  // ============================================================
  // LOAD USER PROFILE
  // ============================================================
  useEffect(() => {
    const loadUser = async () => {
      const user = auth.currentUser;
      if (!user) return;
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) {
        setUsername(snap.data().displayUsername || snap.data().username || '');
        setProfileImage(snap.data().profileImage || null);
        setFavorites(snap.data().favorites || []);
      }
      setLoading(false);
    };
    loadUser();
  }, []);

  // ============================================================
  // LOAD USER'S SPOTS (REAL-TIME)
  // ============================================================
  useEffect(() => {
    // Same auth-guard pattern as HomeScreen — wrap the Firestore
    // listener in onAuthStateChanged so it stops immediately when
    // the user logs out, preventing permission-denied errors.
    let spotsUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user: import('firebase/auth').User | null) => {
      if (user) {
        const q = query(collection(db, 'spots'), where('userId', '==', user.uid));
        spotsUnsub = onSnapshot(q, snap => {
          const loaded: Spot[] = [];
          snap.forEach(d => {
            const data = d.data();
            if (!data.location) return;
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
          setMySpots(loaded.reverse());
        });
      } else {
        if (spotsUnsub) {
          spotsUnsub();
          spotsUnsub = null;
        }
      }
    });

    return () => {
      authUnsub();
      if (spotsUnsub) spotsUnsub();
    };
  }, []);

  // ============================================================
  // TOGGLE FAVORITE
  // Same logic as HomeScreen — uses arrayUnion/arrayRemove
  // ============================================================
  const toggleFavorite = async (spot: Spot) => {
    const user = auth.currentUser;
    if (!user) return;
    const key = `${spot.latitude.toFixed(4)}-${spot.longitude.toFixed(4)}`;
    const userRef = doc(db, 'users', user.uid);
    const isFav = favorites.includes(key);
    await updateDoc(userRef, { favorites: isFav ? arrayRemove(key) : arrayUnion(key) });
    setFavorites(prev => isFav ? prev.filter(f => f !== key) : [...prev, key]);
  };

  // ============================================================
  // DELETE SPOT
  // ============================================================
  const handleDelete = async (spot: Spot) => {
    Alert.alert('Delete Spot', 'Are you sure? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            if (spot.imageUrl?.trim()) {
              try { await deleteObject(storageRef(storage, spot.imageUrl)); } catch {}
            }
            await deleteDoc(doc(db, 'spots', spot.id));
            setSelectedSpot(null);
            Alert.alert('Deleted', 'Your spot has been removed.');
          } catch {
            Alert.alert('Error', 'Could not delete spot.');
          }
        },
      },
    ]);
  };

  // ============================================================
  // REPORT SPOT
  // (User shouldn't be able to report their own spots, but
  // SpotPeek handles that by showing trash instead of flag
  // when currentUserId matches spot.userId)
  // ============================================================
  const handleReport = async (spot: Spot) => {
    const user = auth.currentUser;
    if (!user) return;
    Alert.alert('Report Spot', 'Why are you reporting this spot?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Inappropriate Content', onPress: () => submitReport(spot, 'Inappropriate Content') },
      { text: 'Spam', onPress: () => submitReport(spot, 'Spam') },
      { text: 'Wrong Location', onPress: () => submitReport(spot, 'Wrong Location') },
    ]);
  };

  const submitReport = async (spot: Spot, reason: string) => {
    const user = auth.currentUser;
    if (!user) return;
    try {
      await addDoc(collection(db, 'reports'), {
        spotId: spot.id,
        spotTitle: spot.title,
        reportedBy: user.uid,
        reason,
        createdAt: new Date().toISOString(),
      });
      Alert.alert('Reported', 'Thank you. We will review this shortly.');
    } catch {
      Alert.alert('Error', 'Could not submit report.');
    }
  };

  // ============================================================
  // OPEN DIRECTIONS
  // ============================================================
  const openDirections = (spot: Spot) => {
    const url = Platform.select({
      ios: `maps:0,0?q=${spot.latitude},${spot.longitude}`,
      android: `geo:0,0?q=${spot.latitude},${spot.longitude}`,
    });
    if (url) Linking.openURL(url);
  };

  if (loading) return (
    <View style={[styles.center, { backgroundColor: NAVY }]}>
      <ActivityIndicator color={ORANGE} />
    </View>
  );

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: NAVY }}>

      {/* ---- Header ---- */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={28} color={CREAM} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Profile</Text>
        <TouchableOpacity onPress={() => router.push('/settings')}>
          <Ionicons name="settings-outline" size={24} color={CREAM} />
        </TouchableOpacity>
      </View>

      {/* ---- Profile info ---- */}
      <View style={styles.profileSection}>
        {profileImage
          ? <Image source={{ uri: profileImage }} style={styles.avatar} />
          : <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Ionicons name="person" size={40} color={CREAM_DARK} />
            </View>
        }
        <Text style={styles.username}>@{username}</Text>
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statNumber}>{mySpots.length}</Text>
            <Text style={styles.statLabel}>Spots</Text>
          </View>
        </View>
      </View>

      <View style={styles.divider} />

      {/* ---- Spots grid or empty state ---- */}
      {mySpots.length === 0 ? (
        <View style={styles.emptyWrap}>
          <View style={styles.emptyIconCircle}>
            <Ionicons name="camera-outline" size={40} color={ORANGE} />
          </View>
          <Text style={styles.emptyTitle}>No spots yet</Text>
          <Text style={styles.emptySub}>Tap the + button on the map to add your first spot</Text>
          <TouchableOpacity style={styles.addButton} onPress={() => router.push('/add-spot')}>
            <Ionicons name="add-circle-outline" size={18} color={CREAM} style={{ marginRight: 6 }} />
            <Text style={styles.addButtonText}>Add a Spot</Text>
          </TouchableOpacity>
        </View>
      ) : (
        // 3-column tappable grid
        // Each tile is wrapped in TouchableOpacity so tapping it
        // sets selectedSpot, which opens the SpotPeek sheet below
        <FlatList
          data={mySpots}
          keyExtractor={item => item.id}
          numColumns={3}
          contentContainerStyle={{ gap: 2 }}
          columnWrapperStyle={{ gap: 2 }}
          renderItem={({ item }) => {
            const hasImage = item.imageUrl && item.imageUrl.trim() !== '';
            return (
              <TouchableOpacity
                style={[styles.tile, { width: TILE_SIZE, height: TILE_SIZE }]}
                onPress={() => setSelectedSpot(item)}
                activeOpacity={0.8}
              >
                {hasImage
                  ? <Image source={{ uri: item.imageUrl }} style={styles.tileImage} />
                  : <View style={[styles.tileImage, styles.tilePlaceholder]}>
                      <Ionicons name="image-outline" size={24} color={CREAM_DARK} />
                    </View>
                }
                {!!item.title && (
                  <View style={styles.tileOverlay}>
                    <Text style={styles.tileTitle} numberOfLines={1}>{item.title}</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* ---- SpotPeek sheet ---- */}
      {/* We wrap the selected spot in an array because SpotPeek
          expects an array (multiple spots can share one map pin) */}
      {selectedSpot && (
        <SpotPeek
          spots={[selectedSpot]}
          onClose={() => setSelectedSpot(null)}
          toggleFavorite={toggleFavorite}
          openDirections={openDirections}
          favorites={favorites}
          isDark={isDark}
          currentUserId={auth.currentUser?.uid || ''}
          onDelete={handleDelete}
          onReport={handleReport}
          // Tapping a tag on your own profile routes to the map
          // with that tag pre-applied as a filter.
          onTagPress={(tag) => {
            setSelectedSpot(null);
            router.push({ pathname: '/home', params: { tag } });
          }}
          // Already on the profile — hide the username link to avoid
          // pointlessly re-opening the same page.
          showUsernameLink={false}
        />
      )}

    </SafeAreaView>
  );
}

// ============================================================
// STYLES
// ============================================================
const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14 },
  headerTitle: { fontSize: 18, fontWeight: '800', color: CREAM, letterSpacing: 0.3 },
  profileSection: { alignItems: 'center', paddingVertical: 24 },
  avatar: { width: 96, height: 96, borderRadius: 48, borderWidth: 3, borderColor: ORANGE },
  avatarPlaceholder: { backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center', alignItems: 'center' },
  username: { fontSize: 20, fontWeight: '800', color: CREAM, marginTop: 12, letterSpacing: 0.3 },
  statsRow: { flexDirection: 'row', marginTop: 16, gap: 32 },
  stat: { alignItems: 'center' },
  statNumber: { fontSize: 22, fontWeight: '900', color: CREAM },
  statLabel: { fontSize: 12, color: CREAM_DARK, marginTop: 2, fontWeight: '600' },
  divider: { height: 1, backgroundColor: 'rgba(231,219,203,0.12)', marginBottom: 4 },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyIconCircle: {
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: 'rgba(227,92,37,0.12)',
    borderWidth: 1.5, borderColor: 'rgba(227,92,37,0.3)',
    justifyContent: 'center', alignItems: 'center', marginBottom: 16,
  },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: CREAM, marginBottom: 8 },
  emptySub: { fontSize: 14, color: CREAM_DARK, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  addButton: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: ORANGE, paddingHorizontal: 24, paddingVertical: 13, borderRadius: 12,
    shadowColor: ORANGE, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 5,
  },
  addButtonText: { color: CREAM, fontWeight: '800', fontSize: 15 },
  tile: { overflow: 'hidden' },
  tileImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  tilePlaceholder: { backgroundColor: 'rgba(255,255,255,0.06)', justifyContent: 'center', alignItems: 'center' },
  tileOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(17,35,55,0.7)', paddingHorizontal: 6, paddingVertical: 4,
  },
  tileTitle: { color: CREAM, fontSize: 11, fontWeight: '600' },
});