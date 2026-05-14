// ============================================================
// main/profile.tsx — Own profile (bottom tab)
// ------------------------------------------------------------
// Same content as legacy /profile, without a back button.
// Stats: pins (spot count), followers, following (Instagram-style).
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
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
import SpotPeek from '../../components/SpotPeek';
import { Spot, spotGalleryUrls } from '../../components/types';
import { BRAND } from '../../constants/brand';
import { appScreenBackground } from '../../constants/theme';
import { auth, db } from '../../utils/firebase';
import { deleteStorageObjectsByUrls } from '../../utils/storage-delete';
import { ensureFollowingMigrated, followerUidList, followingUidList } from '../../utils/social';
import { useTheme } from '../../utils/theme-context';

const { width } = Dimensions.get('window');
const TILE_SIZE = (width - 4) / 3;
const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function MainProfileTabScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const screenBg = appScreenBackground(isDark);

  const [username, setUsername] = useState('');
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);

  const [mySpots, setMySpots] = useState<Spot[]>([]);
  const [selectedSpot, setSelectedSpot] = useState<Spot | null>(null);

  useEffect(() => {
    let userDocUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        void ensureFollowingMigrated(user.uid);
        userDocUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
          if (snap.exists()) {
            const data = snap.data() as Record<string, unknown>;
            setUsername((data.displayUsername || data.username || '') as string);
            setProfileImage((data.profileImage as string | null) || null);
            setFollowerCount(followerUidList(data).length);
            setFollowingCount(followingUidList(data).length);
          }
          setLoading(false);
        });
      } else {
        if (userDocUnsub) {
          userDocUnsub();
          userDocUnsub = null;
        }
        setUsername('');
        setProfileImage(null);
        setFollowerCount(0);
        setFollowingCount(0);
        setLoading(false);
      }
    });

    return () => {
      authUnsub();
      if (userDocUnsub) userDocUnsub();
    };
  }, []);

  useEffect(() => {
    let spotsUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user: import('firebase/auth').User | null) => {
      if (user) {
        const q = query(collection(db, 'spots'), where('userId', '==', user.uid));
        spotsUnsub = onSnapshot(q, (snap) => {
          const loaded: Spot[] = [];
          snap.forEach((d) => {
            const data = d.data();
            if (!data.location) return;
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

  const handleDelete = async (spot: Spot) => {
    Alert.alert('Delete Spot', 'Are you sure? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteStorageObjectsByUrls(spotGalleryUrls(spot));
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

  const openDirections = (spot: Spot) => {
    const url = Platform.select({
      ios: `maps:0,0?q=${spot.latitude},${spot.longitude}`,
      android: `geo:0,0?q=${spot.latitude},${spot.longitude}`,
    });
    if (url) Linking.openURL(url);
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: screenBg }]}>
        <ActivityIndicator color={ORANGE} />
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }} edges={['top']}>
      <View style={styles.header}>
        <View style={{ width: 28 }} />
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <TouchableOpacity onPress={() => router.push('/favorites')} hitSlop={8}>
            <Ionicons name="bookmark-outline" size={24} color={CREAM} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/settings')} hitSlop={8}>
            <Ionicons name="settings-outline" size={24} color={CREAM} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.profileSection}>
        {profileImage ? (
          <Image source={{ uri: profileImage }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Ionicons name="person" size={40} color={CREAM_DARK} />
          </View>
        )}
        <Text style={styles.username}>@{username}</Text>
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statNumber}>{mySpots.length}</Text>
            <Text style={styles.statLabel}>pins</Text>
          </View>
          <View style={styles.statDivider} />
          <TouchableOpacity
            style={styles.stat}
            onPress={() => router.push('/followers')}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8 }}
          >
            <Text style={styles.statNumber}>{followerCount}</Text>
            <Text style={[styles.statLabel, styles.statLabelLink]}>followers</Text>
          </TouchableOpacity>
          <View style={styles.statDivider} />
          <TouchableOpacity
            style={styles.stat}
            onPress={() => router.push('/following')}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8 }}
          >
            <Text style={styles.statNumber}>{followingCount}</Text>
            <Text style={[styles.statLabel, styles.statLabelLink]}>following</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.divider} />

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
        <FlatList
          data={mySpots}
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
          openDirections={openDirections}
          isDark={isDark}
          currentUserId={auth.currentUser?.uid || ''}
          onDelete={handleDelete}
          onEdit={(spot) => {
            setSelectedSpot(null);
            router.push(`/edit-spot/${spot.id}`);
          }}
          onReport={handleReport}
          onTagPress={(tag) => {
            setSelectedSpot(null);
            router.push({ pathname: '/main', params: { tag } });
          }}
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
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: { fontSize: 18, fontWeight: '800', color: CREAM, letterSpacing: 0.3 },
  profileSection: { alignItems: 'center', paddingVertical: 20 },
  avatar: { width: 96, height: 96, borderRadius: 48, borderWidth: 3, borderColor: ORANGE },
  avatarPlaceholder: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  username: { fontSize: 20, fontWeight: '800', color: CREAM, marginTop: 12, letterSpacing: 0.3 },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
    paddingHorizontal: 12,
    gap: 0,
  },
  stat: { alignItems: 'center', minWidth: 88, paddingVertical: 4 },
  statDivider: { width: 1, height: 36, backgroundColor: 'rgba(231,219,203,0.18)' },
  statNumber: { fontSize: 20, fontWeight: '900', color: CREAM },
  statLabel: { fontSize: 12, color: CREAM_DARK, marginTop: 3, fontWeight: '600', textTransform: 'lowercase' },
  statLabelLink: { color: CREAM },
  divider: { height: 1, backgroundColor: 'rgba(231,219,203,0.12)', marginBottom: 4 },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyIconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(227,92,37,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(227,92,37,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: CREAM, marginBottom: 8 },
  emptySub: { fontSize: 14, color: CREAM_DARK, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ORANGE,
    paddingHorizontal: 24,
    paddingVertical: 13,
    borderRadius: 12,
    shadowColor: ORANGE,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  addButtonText: { color: CREAM, fontWeight: '800', fontSize: 15 },
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
