// ============================================================
// main/friends.tsx — Vertical feed of friends’ recent spots
// ------------------------------------------------------------
// Instagram-style paging scroll: one spot per viewport (swipe up/down).
// Opens the map tab centered on a spot when the user taps “Map” or the image.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  ListRenderItem,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND } from '../../constants/brand';
import { auth, db } from '../../utils/firebase';
import { captureError } from '../../utils/sentry';
import { fetchFriendsRecentSpots, type FriendActivitySpot } from '../../utils/social';
import { useTheme } from '../../utils/theme-context';

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function FriendsFeedScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const bg = isDark ? '#0d1c2b' : NAVY;

  const [friendUids, setFriendUids] = useState<string[]>([]);
  const [activity, setActivity] = useState<FriendActivitySpot[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const itemHeight = useMemo(() => {
    const winH = Dimensions.get('window').height;
    return Math.max(420, winH - insets.top - tabBarHeight - 52);
  }, [insets.top, tabBarHeight]);

  useEffect(() => {
    let unsubUser: (() => void) | null = null;
    const authUnsub = onAuthStateChanged(auth, (user) => {
      unsubUser?.();
      unsubUser = null;
      if (!user) {
        setFriendUids([]);
        setLoadingList(false);
        return;
      }
      setLoadingList(true);
      unsubUser = onSnapshot(
        doc(db, 'users', user.uid),
        (snap) => {
          setFriendUids((snap.data()?.friends as string[] | undefined) || []);
          setLoadingList(false);
        },
        (err) => {
          captureError(err, { area: 'FriendsFeed.usersDoc' });
          setLoadingList(false);
        }
      );
    });
    return () => {
      authUnsub();
      unsubUser?.();
    };
  }, []);

  const loadFeed = useCallback(
    async (pull = false) => {
      if (friendUids.length === 0) {
        setActivity([]);
        setRefreshing(false);
        setLoadingFeed(false);
        return;
      }
      if (pull) setRefreshing(true);
      else setLoadingFeed(true);
      try {
        const rows = await fetchFriendsRecentSpots(friendUids);
        setActivity(rows);
      } catch (e) {
        captureError(e, { area: 'FriendsFeed.loadFeed' });
        setActivity([]);
      } finally {
        setLoadingFeed(false);
        setRefreshing(false);
      }
    },
    [friendUids]
  );

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  const openOnMap = useCallback(
    (a: FriendActivitySpot) => {
      router.replace({
        pathname: '/main',
        params: {
          lat: String(a.latitude),
          lng: String(a.longitude),
          zoom: '0.012',
        },
      });
    },
    [router]
  );

  const renderItem: ListRenderItem<FriendActivitySpot> = useCallback(
    ({ item }) => (
      <View style={[styles.page, { height: itemHeight }]}>
        <TouchableOpacity
          style={styles.imageTouch}
          activeOpacity={0.92}
          onPress={() => openOnMap(item)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${item.title || 'spot'} on map`}
        >
          {item.imageUrl ? (
            <ExpoImage source={{ uri: item.imageUrl }} style={styles.fullImage} contentFit="cover" />
          ) : (
            <View style={[styles.fullImage, styles.imagePh]}>
              <Ionicons name="image-outline" size={48} color={CREAM_DARK} />
            </View>
          )}
          <View style={styles.gradientBand} />
          <View style={styles.overlayText}>
            <Text style={styles.author} numberOfLines={1}>
              @{item.authorUsername || 'friend'}
            </Text>
            <Text style={styles.title} numberOfLines={2}>
              {item.title || 'Photo spot'}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.mapBtn} onPress={() => openOnMap(item)} activeOpacity={0.85}>
          <Ionicons name="map-outline" size={20} color={CREAM} />
          <Text style={styles.mapBtnText}>View on map</Text>
        </TouchableOpacity>
      </View>
    ),
    [itemHeight, openOnMap]
  );

  const listEmpty = useMemo(() => {
    if (loadingList || loadingFeed) {
      return (
        <View style={[styles.centerEmpty, { minHeight: itemHeight }]}>
          <ActivityIndicator size="large" color={ORANGE} />
        </View>
      );
    }
    if (friendUids.length === 0) {
      return (
        <View style={[styles.centerEmpty, { minHeight: itemHeight, paddingHorizontal: 28 }]}>
          <Ionicons name="people-outline" size={48} color={CREAM_DARK} />
          <Text style={styles.emptyTitle}>Add friends first</Text>
          <Text style={styles.emptySub}>Send requests from your friends list, then their new spots show up here.</Text>
          <TouchableOpacity style={styles.primaryLink} onPress={() => router.push('/social')} activeOpacity={0.85}>
            <Text style={styles.primaryLinkText}>Open friends hub</Text>
            <Ionicons name="chevron-forward" size={18} color={CREAM} />
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={[styles.centerEmpty, { minHeight: itemHeight, paddingHorizontal: 28 }]}>
        <Ionicons name="images-outline" size={44} color={CREAM_DARK} />
        <Text style={styles.emptyTitle}>No spots from friends yet</Text>
        <Text style={styles.emptySub}>When friends post, you’ll scroll through their spots here.</Text>
      </View>
    );
  }, [friendUids.length, itemHeight, loadingFeed, loadingList, router]);

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.headerTitle}>Friends</Text>
        <TouchableOpacity
          style={styles.headerLink}
          onPress={() => router.push('/social')}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.headerLinkText}>Hub</Text>
          <Ionicons name="person-add-outline" size={20} color={ORANGE} />
        </TouchableOpacity>
      </View>

      <FlatList
        style={{ flex: 1 }}
        data={activity}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={itemHeight}
        snapToAlignment="start"
        getItemLayout={(_, index) => ({
          length: itemHeight,
          offset: itemHeight * index,
          index,
        })}
        ListEmptyComponent={listEmpty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void loadFeed(true)}
            tintColor={ORANGE}
            progressViewOffset={insets.top}
          />
        }
        contentContainerStyle={activity.length === 0 ? styles.listEmptyGrow : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  headerTitle: { fontSize: 22, fontWeight: '900', color: CREAM, letterSpacing: 0.3 },
  headerLink: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headerLinkText: { color: ORANGE, fontWeight: '800', fontSize: 15 },
  listEmptyGrow: { flexGrow: 1 },
  centerEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  emptyTitle: { color: CREAM, fontSize: 18, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  emptySub: { color: CREAM_DARK, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  primaryLink: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: ORANGE,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 14,
  },
  primaryLinkText: { color: CREAM, fontWeight: '800', fontSize: 15 },
  page: {
    width: '100%',
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  imageTouch: {
    flex: 1,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  fullImage: { ...StyleSheet.absoluteFillObject },
  imagePh: { justifyContent: 'center', alignItems: 'center' },
  gradientBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 120,
    backgroundColor: 'rgba(17,35,55,0.55)',
  },
  overlayText: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 14,
  },
  author: { color: ORANGE, fontSize: 13, fontWeight: '800', marginBottom: 4 },
  title: { color: CREAM, fontSize: 20, fontWeight: '800', lineHeight: 26 },
  mapBtn: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 14,
    backgroundColor: 'rgba(227,92,37,0.95)',
  },
  mapBtnText: { color: CREAM, fontWeight: '800', fontSize: 15 },
});
