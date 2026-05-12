// ============================================================
// user/[username].tsx — Public user profile
// ------------------------------------------------------------
// Read-only view of another user's profile:
//   - Avatar, displayUsername
//   - Total spot count
//   - 3-column grid of their spots
//
// Looks up the user by lowercase username (the indexed field).
// If the username belongs to the current user, redirect to the
// editable /profile screen instead so they get full controls.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
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
import SpotPeek from '../../components/SpotPeek';
import { Spot } from '../../components/types';
import { BRAND } from '../../constants/brand';
import { auth, db } from '../../utils/firebase';
import { captureError } from '../../utils/sentry';
import { useTheme } from '../../utils/theme-context';

const { width } = Dimensions.get('window');
const TILE_SIZE = (width - 4) / 3;
const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function PublicUserProfileScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const { username: routeUsername } = useLocalSearchParams<{ username: string }>();

  // ---- Loaded user data ----
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [profileUid, setProfileUid] = useState<string | null>(null);
  const [displayUsername, setDisplayUsername] = useState('');
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [profileEmail, setProfileEmail] = useState<string | null>(null);
  const [showEmailOnProfile, setShowEmailOnProfile] = useState(false);

  // ---- Spots state ----
  const [userSpots, setUserSpots] = useState<Spot[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [selectedSpot, setSelectedSpot] = useState<Spot | null>(null);
  /** Current viewer's blocked UIDs (from users/{viewerUid}). */
  const [viewerBlockedIds, setViewerBlockedIds] = useState<string[]>([]);

  const profileBlockedByViewer = useMemo(
    () =>
      !!profileUid &&
      !!auth.currentUser &&
      viewerBlockedIds.includes(profileUid),
    [profileUid, viewerBlockedIds]
  );

  // ============================================================
  // LOOK UP THE USER BY USERNAME (one-shot)
  // We only need to translate the URL slug to a UID once — username
  // is an immutable lowercase field. After we have the UID, we attach
  // a live listener (next effect) for the actual profile data.
  // ============================================================
  useEffect(() => {
    let cancelled = false;

    const lookup = async () => {
      if (!routeUsername) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setNotFound(false);
      setIsPrivate(false);

      const usernameLower = routeUsername.toLowerCase();

      // Short-circuit: if the username matches the current user, send them
      // to their own editable profile screen.
      const currentUser = auth.currentUser;
      if (currentUser) {
        const meSnap = await getDoc(doc(db, 'users', currentUser.uid));
        if (meSnap.exists() && meSnap.data().username === usernameLower) {
          router.replace('/profile');
          return;
        }
      }

      try {
        const q = query(
          collection(db, 'users'),
          where('username', '==', usernameLower)
        );
        const snap = await getDocs(q);
        if (cancelled) return;

        if (snap.empty) {
          setNotFound(true);
          setLoading(false);
          return;
        }

        // Just capture the UID — the live listener below handles the rest.
        setProfileUid(snap.docs[0].id);
      } catch (err) {
        captureError(err, { area: 'PublicUserProfileScreen.lookup' });
        if (!cancelled) {
          setNotFound(true);
          setLoading(false);
        }
      }
    };

    lookup();
    return () => {
      cancelled = true;
    };
  }, [routeUsername, router]);

  // ============================================================
  // LIVE PROFILE DATA (REAL-TIME)
  // Listens to the viewed user's document so changes to username,
  // avatar, privacy, etc. show up immediately.
  // ============================================================
  useEffect(() => {
    if (!profileUid) return;
    const unsub = onSnapshot(doc(db, 'users', profileUid), (snap) => {
      if (!snap.exists()) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      const data = snap.data();
      if (data.profileVisible === false) {
        setIsPrivate(true);
        setLoading(false);
        return;
      }
      setIsPrivate(false);
      setDisplayUsername(data.displayUsername || data.username || '');
      setProfileImage(data.profileImage || null);
      setProfileEmail(data.email || null);
      setShowEmailOnProfile(!!data.showEmailOnProfile);
      setLoading(false);
    });
    return unsub;
  }, [profileUid]);

  // ============================================================
  // VIEWER'S OWN DOC (REAL-TIME)
  // Drives favorites (SpotPeek heart state) and the block list
  // (used to redirect this profile to the "blocked" placeholder).
  // ============================================================
  useEffect(() => {
    let userDocUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        userDocUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            setFavorites(data.favorites || []);
            setViewerBlockedIds(data.blockedUserIds || []);
          } else {
            setFavorites([]);
            setViewerBlockedIds([]);
          }
        });
      } else {
        if (userDocUnsub) {
          userDocUnsub();
          userDocUnsub = null;
        }
        setFavorites([]);
        setViewerBlockedIds([]);
      }
    });

    return () => {
      authUnsub();
      if (userDocUnsub) userDocUnsub();
    };
  }, []);

  // ============================================================
  // LOAD THE USER'S SPOTS (REAL-TIME)
  // ============================================================
  useEffect(() => {
    if (!profileUid || profileBlockedByViewer) {
      if (profileBlockedByViewer) setUserSpots([]);
      return;
    }
    const q = query(collection(db, 'spots'), where('userId', '==', profileUid));
    const unsub = onSnapshot(q, (snap) => {
      const loaded: Spot[] = [];
      snap.forEach((d) => {
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
      setUserSpots(loaded.reverse());
    });
    return unsub;
  }, [profileUid, profileBlockedByViewer]);

  // ============================================================
  // TOGGLE FAVORITE
  // Same coordinate-based key the rest of the app uses, so favorites
  // are consistent across screens.
  // ============================================================
  const toggleFavorite = async (spot: Spot) => {
    const user = auth.currentUser;
    if (!user) return;
    const key = `${spot.latitude.toFixed(4)}-${spot.longitude.toFixed(4)}`;
    const userRef = doc(db, 'users', user.uid);
    const isFav = favorites.includes(key);
    await updateDoc(userRef, {
      favorites: isFav ? arrayRemove(key) : arrayUnion(key),
    });
    setFavorites((prev) => (isFav ? prev.filter((f) => f !== key) : [...prev, key]));
  };

  // ============================================================
  // REPORT (viewer reports a spot on this profile)
  // ============================================================
  const handleReport = (spot: Spot) => {
    const user = auth.currentUser;
    if (!user) return;
    Alert.alert('Report Spot', 'Why are you reporting this spot?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Inappropriate Content',
        onPress: () => submitReport(spot, 'Inappropriate Content'),
      },
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
    } catch (err) {
      captureError(err, { area: 'PublicUserProfileScreen.submitReport' });
      Alert.alert('Error', 'Could not submit report.');
    }
  };

  const handleBlockFromSpot = (spot: Spot) => {
    const user = auth.currentUser;
    if (!user || !spot.userId || spot.userId === user.uid) return;
    Alert.alert(
      'Block this user?',
      'You will no longer see their spots on the map or their profile. You can unblock in Settings.',
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
              setViewerBlockedIds((prev) => Array.from(new Set([...prev, spot.userId])));
              setSelectedSpot(null);
              Alert.alert('Blocked', 'This user is now blocked.');
            } catch (err) {
              captureError(err, { area: 'PublicUserProfileScreen.blockUser', blockedUid: spot.userId });
              Alert.alert('Error', 'Could not block this user.');
            }
          },
        },
      ]
    );
  };

  const unblockThisProfile = async () => {
    const user = auth.currentUser;
    if (!user || !profileUid) return;
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        blockedUserIds: arrayRemove(profileUid),
      });
      setViewerBlockedIds((prev) => prev.filter((id) => id !== profileUid));
    } catch (err) {
      captureError(err, { area: 'PublicUserProfileScreen.unblock', profileUid });
      Alert.alert('Error', 'Could not unblock. Try again.');
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

  // ============================================================
  // TAG TAP — route to home with that tag pre-applied
  // We pass it through the URL as a search param.
  // ============================================================
  const handleTagPress = (tag: string) => {
    setSelectedSpot(null);
    router.push({ pathname: '/home', params: { tag } });
  };

  // ============================================================
  // RENDER
  // ============================================================
  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: NAVY }]}>
        <ActivityIndicator color={ORANGE} />
      </View>
    );
  }

  if (notFound) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: NAVY }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={28} color={CREAM} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Not Found</Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.center}>
          <Ionicons name="person-remove-outline" size={56} color={CREAM_DARK} />
          <Text style={styles.notFoundTitle}>User not found</Text>
          <Text style={styles.notFoundSub}>
            We couldn&apos;t find a profile for @{routeUsername}.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (isPrivate) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: NAVY }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={28} color={CREAM} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Profile</Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={56} color={CREAM_DARK} />
          <Text style={styles.notFoundTitle}>This profile is private</Text>
          <Text style={styles.notFoundSub}>
            @{routeUsername} has chosen to hide their public profile.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (profileBlockedByViewer) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: NAVY }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={28} color={CREAM} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Profile</Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.center}>
          <Ionicons name="ban-outline" size={56} color={CREAM_DARK} />
          <Text style={styles.notFoundTitle}>You blocked this user</Text>
          <Text style={styles.notFoundSub}>
            @{displayUsername}&apos;s spots are hidden from your map. Unblock to see their profile again.
          </Text>
          <TouchableOpacity
            style={styles.unblockButton}
            onPress={() => {
              void unblockThisProfile();
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.unblockButtonText}>Unblock</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: NAVY }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={28} color={CREAM} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          @{displayUsername}
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.profileSection}>
        {profileImage ? (
          <Image source={{ uri: profileImage }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Ionicons name="person" size={40} color={CREAM_DARK} />
          </View>
        )}
        <Text style={styles.username}>@{displayUsername}</Text>
        {showEmailOnProfile && profileEmail ? (
          <Text style={styles.publicEmail}>{profileEmail}</Text>
        ) : null}
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statNumber}>{userSpots.length}</Text>
            <Text style={styles.statLabel}>Spots</Text>
          </View>
        </View>
      </View>

      <View style={styles.divider} />

      {userSpots.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Ionicons name="camera-outline" size={36} color={CREAM_DARK} />
          <Text style={styles.emptyTitle}>No spots yet</Text>
          <Text style={styles.emptySub}>
            @{displayUsername} hasn&apos;t posted any spots yet.
          </Text>
        </View>
      ) : (
        <FlatList
          data={userSpots}
          keyExtractor={(item) => item.id}
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
                {hasImage ? (
                  <Image source={{ uri: item.imageUrl }} style={styles.tileImage} />
                ) : (
                  <View style={[styles.tileImage, styles.tilePlaceholder]}>
                    <Ionicons name="image-outline" size={24} color={CREAM_DARK} />
                  </View>
                )}
                {!!item.title && (
                  <View style={styles.tileOverlay}>
                    <Text style={styles.tileTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />
      )}

      {selectedSpot && (
        <SpotPeek
          spots={[selectedSpot]}
          onClose={() => setSelectedSpot(null)}
          toggleFavorite={toggleFavorite}
          openDirections={openDirections}
          favorites={favorites}
          isDark={isDark}
          currentUserId={auth.currentUser?.uid || ''}
          // The viewer is never the owner of these spots (own-profile redirects
          // to /profile above), so onDelete is a no-op.
          onDelete={() => undefined}
          onReport={handleReport}
          onBlock={handleBlockFromSpot}
          onTagPress={handleTagPress}
          // Hide the @username link inside SpotPeek when already viewing
          // that user's profile — would just re-open this page.
          showUsernameLink={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: CREAM,
    letterSpacing: 0.3,
    maxWidth: '60%',
  },
  profileSection: { alignItems: 'center', paddingVertical: 24 },
  avatar: { width: 96, height: 96, borderRadius: 48, borderWidth: 3, borderColor: ORANGE },
  avatarPlaceholder: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  username: { fontSize: 20, fontWeight: '800', color: CREAM, marginTop: 12, letterSpacing: 0.3 },
  publicEmail: { fontSize: 13, color: CREAM_DARK, marginTop: 6 },
  statsRow: { flexDirection: 'row', marginTop: 16, gap: 32 },
  stat: { alignItems: 'center' },
  statNumber: { fontSize: 22, fontWeight: '900', color: CREAM },
  statLabel: { fontSize: 12, color: CREAM_DARK, marginTop: 2, fontWeight: '600' },
  divider: { height: 1, backgroundColor: 'rgba(231,219,203,0.12)', marginBottom: 4 },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: CREAM, marginTop: 12, marginBottom: 6 },
  emptySub: { fontSize: 14, color: CREAM_DARK, textAlign: 'center', lineHeight: 20 },
  notFoundTitle: { fontSize: 22, fontWeight: '800', color: CREAM, marginTop: 16, marginBottom: 8 },
  notFoundSub: { fontSize: 14, color: CREAM_DARK, textAlign: 'center', paddingHorizontal: 32 },
  unblockButton: {
    marginTop: 24,
    backgroundColor: ORANGE,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 14,
  },
  unblockButtonText: { color: CREAM, fontWeight: '800', fontSize: 15 },
  tile: { overflow: 'hidden' },
  tileImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  tilePlaceholder: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tileOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(17,35,55,0.7)',
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  tileTitle: { color: CREAM, fontSize: 11, fontWeight: '600' },
});
