// ============================================================
// main/friends.tsx — Vertical feed from people you follow
// ------------------------------------------------------------
// Instagram-style paging scroll: one spot per viewport (swipe up/down).
// Opens the map tab when the user taps the photo or map action; bookmark / share / map in a horizontal row top-right; like + count bottom-right.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
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
import type { Spot } from '../../components/types';
import FeedSpotComments from '../../components/FeedSpotComments';
import { BRAND } from '../../constants/brand';
import { appScreenBackground } from '../../constants/theme';
import { auth, db } from '../../utils/firebase';
import { captureError } from '../../utils/sentry';
import { shareSpot } from '../../utils/share';
import {
  ensureFollowingMigrated,
  fetchFollowingRecentSpots,
  followingUidList,
  toggleBookmark,
  toggleSpotLike,
  type FriendActivitySpot,
} from '../../utils/social';
import { useTheme } from '../../utils/theme-context';

const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK, danger: DANGER } = BRAND;

function activityToSpot(a: FriendActivitySpot): Spot {
  return {
    id: a.id,
    latitude: a.latitude,
    longitude: a.longitude,
    imageUrl: a.imageUrl || '',
    title: a.title || '',
    caption: '',
    address: '',
    username: a.authorUsername || '',
    userId: a.userId,
    tags: [],
  };
}

type FriendFeedPageProps = {
  item: FriendActivitySpot;
  itemHeight: number;
  onImagePress: (a: FriendActivitySpot) => void;
  viewerUid: string | undefined;
  isDark: boolean;
};

const FriendFeedPage = memo(function FriendFeedPage({
  item,
  itemHeight,
  onImagePress,
  viewerUid,
  isDark,
}: FriendFeedPageProps) {
  const router = useRouter();
  const me = viewerUid ?? '';
  const [likeCount, setLikeCount] = useState(0);
  const [likedByMe, setLikedByMe] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);

  useEffect(() => {
    if (!item.id) return;
    const unsubLikes = onSnapshot(collection(db, 'spots', item.id, 'likes'), (snap) => {
      setLikeCount(snap.size);
      setLikedByMe(me ? snap.docs.some((d) => d.id === me) : false);
    });
    let unsubBm: (() => void) | undefined;
    if (me) {
      unsubBm = onSnapshot(doc(db, 'users', me, 'bookmarks', item.id), (bm) => {
        setIsBookmarked(bm.exists());
      });
    } else {
      setIsBookmarked(false);
    }
    return () => {
      unsubLikes();
      unsubBm?.();
    };
  }, [item.id, me]);

  const spot = useMemo(() => activityToSpot(item), [item]);

  const authorSlug = (item.authorUsername || '').trim().toLowerCase();
  const openAuthorProfile = () => {
    if (!authorSlug) return;
    router.push(`/user/${authorSlug}`);
  };

  const handleToggleLike = async () => {
    if (!me) return;
    try {
      await toggleSpotLike(item.id, likedByMe);
    } catch (e) {
      captureError(e, { area: 'FriendsFeed.toggleLike', spotId: item.id });
    }
  };

  const handleToggleBookmark = async () => {
    if (!me) return;
    try {
      await toggleBookmark(
        {
          id: item.id,
          title: item.title,
          imageUrl: item.imageUrl || '',
          latitude: item.latitude,
          longitude: item.longitude,
        },
        isBookmarked
      );
    } catch (e) {
      captureError(e, { area: 'FriendsFeed.toggleBookmark', spotId: item.id });
    }
  };

  return (
    <View style={[styles.page, { height: itemHeight }]}>
      <View style={styles.cardFrame}>
        <View style={styles.feedImageStack}>
          <View style={styles.tapLayer} pointerEvents="box-none">
            <TouchableOpacity
              style={StyleSheet.absoluteFillObject}
              activeOpacity={0.92}
              onPress={() => onImagePress(item)}
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
            </TouchableOpacity>
            <View style={styles.overlayText} pointerEvents="box-none">
              <Text style={styles.title} numberOfLines={4}>
                {item.title || 'Photo spot'}
              </Text>
              <TouchableOpacity
                style={{ alignSelf: 'flex-start', maxWidth: '100%' }}
                onPress={openAuthorProfile}
                activeOpacity={0.75}
                disabled={!authorSlug}
                hitSlop={{ top: 6, bottom: 6, left: 4, right: 8 }}
                accessibilityRole="link"
                accessibilityLabel={`Open profile @${item.authorUsername || 'photographer'}`}
              >
                <Text style={styles.author} numberOfLines={1}>
                  @{item.authorUsername || 'photographer'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.actionsTopRight} pointerEvents="box-none">
            {!!me && (
              <TouchableOpacity
                onPress={() => void handleToggleBookmark()}
                style={[styles.actionButton, isBookmarked && styles.actionButtonBm]}
                activeOpacity={0.85}
                accessibilityLabel={isBookmarked ? 'Remove bookmark' : 'Bookmark'}
              >
                <Ionicons
                  name={isBookmarked ? 'bookmark' : 'bookmark-outline'}
                  size={20}
                  color={CREAM}
                />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={() => void shareSpot(spot)}
              style={styles.actionButton}
              activeOpacity={0.85}
              accessibilityLabel="Share spot"
            >
              <Ionicons name="share-outline" size={20} color={CREAM} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onImagePress(item)}
              style={styles.actionButton}
              activeOpacity={0.85}
              accessibilityLabel="View on map"
            >
              <Ionicons name="map-outline" size={20} color={CREAM} />
            </TouchableOpacity>
          </View>

          <View style={styles.actionsBottomRight} pointerEvents="box-none">
            {!!me ? (
              <TouchableOpacity
                onPress={() => void handleToggleLike()}
                style={[styles.likePill, likedByMe && styles.likePillLiked]}
                activeOpacity={0.85}
                accessibilityLabel={likedByMe ? 'Unlike' : 'Like'}
              >
                <Ionicons
                  name={likedByMe ? 'heart' : 'heart-outline'}
                  size={22}
                  color={likedByMe ? DANGER : CREAM}
                />
                <Text style={styles.likeCountInPill}>{likeCount}</Text>
              </TouchableOpacity>
            ) : (
              <View style={[styles.likePill, styles.likePillReadOnly]} accessibilityElementsHidden>
                <Ionicons name="heart-outline" size={22} color={CREAM_DARK} />
                <Text style={[styles.likeCountInPill, styles.likeCountReadOnly]}>{likeCount}</Text>
              </View>
            )}
          </View>
        </View>

        <FeedSpotComments
          spotId={item.id}
          spotOwnerUid={item.userId}
          viewerUid={me}
          isDark={isDark}
        />
      </View>
    </View>
  );
});

export default function FollowingFeedScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const bg = appScreenBackground(isDark);

  const [followingUids, setFollowingUids] = useState<string[]>([]);
  const [activity, setActivity] = useState<FriendActivitySpot[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [viewerUid, setViewerUid] = useState<string | undefined>(undefined);

  const itemHeight = useMemo(() => {
    const winH = Dimensions.get('window').height;
    return Math.max(420, winH - insets.top - tabBarHeight - 52);
  }, [insets.top, tabBarHeight]);

  useEffect(() => {
    let unsubUser: (() => void) | null = null;
    const authUnsub = onAuthStateChanged(auth, (user) => {
      unsubUser?.();
      unsubUser = null;
      setViewerUid(user?.uid);
      if (!user) {
        setFollowingUids([]);
        setLoadingList(false);
        return;
      }
      setLoadingList(true);
      void ensureFollowingMigrated(user.uid);
      unsubUser = onSnapshot(
        doc(db, 'users', user.uid),
        (snap) => {
          setFollowingUids(followingUidList(snap.data() as Record<string, unknown> | undefined));
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
      if (followingUids.length === 0) {
        setActivity([]);
        setRefreshing(false);
        setLoadingFeed(false);
        return;
      }
      if (pull) setRefreshing(true);
      else setLoadingFeed(true);
      try {
        const rows = await fetchFollowingRecentSpots(followingUids);
        setActivity(rows);
      } catch (e) {
        captureError(e, { area: 'FriendsFeed.loadFeed' });
        setActivity([]);
      } finally {
        setLoadingFeed(false);
        setRefreshing(false);
      }
    },
    [followingUids]
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
      <FriendFeedPage
        item={item}
        itemHeight={itemHeight}
        onImagePress={openOnMap}
        viewerUid={viewerUid}
        isDark={isDark}
      />
    ),
    [itemHeight, isDark, openOnMap, viewerUid]
  );

  const listEmpty = useMemo(() => {
    if (loadingList || loadingFeed) {
      return (
        <View style={[styles.centerEmpty, { minHeight: itemHeight }]}>
          <ActivityIndicator size="large" color={ORANGE} />
        </View>
      );
    }
    if (followingUids.length === 0) {
      return (
        <View style={[styles.centerEmpty, { minHeight: itemHeight, paddingHorizontal: 28 }]}>
          <Ionicons name="people-outline" size={48} color={CREAM_DARK} />
          <Text style={styles.emptyTitle}>Follow people first</Text>
          <Text style={styles.emptySub}>
            Find people from the map search, open a profile to follow them, or go to your Profile tab and tap
            Following.
          </Text>
        </View>
      );
    }
    return (
      <View style={[styles.centerEmpty, { minHeight: itemHeight, paddingHorizontal: 28 }]}>
        <Ionicons name="images-outline" size={44} color={CREAM_DARK} />
        <Text style={styles.emptyTitle}>No spots from people you follow yet</Text>
        <Text style={styles.emptySub}>When they post, new spots appear in this feed.</Text>
      </View>
    );
  }, [followingUids.length, itemHeight, loadingFeed, loadingList]);

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.headerTitle}>Feed</Text>
        <View style={styles.headerRightActions}>
          <TouchableOpacity
            onPress={() => router.push('/favorites')}
            hitSlop={12}
            style={styles.headerIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Open bookmarks"
          >
            <Ionicons name="bookmark-outline" size={26} color={CREAM} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push('/settings')}
            hitSlop={12}
            style={styles.headerIconBtn}
            accessibilityRole="button"
            accessibilityLabel="Open settings"
          >
            <Ionicons name="settings-outline" size={26} color={CREAM} />
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        style={{ flex: 1 }}
        data={activity}
        extraData={viewerUid}
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
  headerTitle: { fontSize: 27, fontWeight: '900', color: CREAM, letterSpacing: 0.3 },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  headerIconBtn: {
    padding: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  listEmptyGrow: { flexGrow: 1 },
  centerEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  emptyTitle: { color: CREAM, fontSize: 18, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  emptySub: { color: CREAM_DARK, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  page: {
    width: '100%',
    paddingHorizontal: 12,
    paddingBottom: 4,
  },
  cardFrame: {
    flex: 1,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.25)',
    position: 'relative',
    flexDirection: 'column',
  },
  feedImageStack: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
  },
  tapLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  fullImage: { ...StyleSheet.absoluteFillObject },
  imagePh: { justifyContent: 'center', alignItems: 'center' },
  overlayText: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingLeft: 14,
    paddingRight: 112,
    paddingTop: 12,
    paddingBottom: 14,
    backgroundColor: 'rgba(17,35,55,0.58)',
    zIndex: 2,
  },
  author: { color: ORANGE, fontSize: 16, fontWeight: '800', alignSelf: 'flex-start' },
  title: {
    color: CREAM,
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 26,
    marginBottom: 8,
    width: '100%',
  },
  actionsTopRight: {
    position: 'absolute',
    top: 12,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 4,
  },
  actionsBottomRight: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    alignItems: 'center',
    zIndex: 4,
  },
  likePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 13,
    borderRadius: 24,
    backgroundColor: 'rgba(6,10,16,0.78)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.38)',
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 14,
  },
  likePillLiked: {
    backgroundColor: 'rgba(48,12,10,0.82)',
    borderColor: 'rgba(255,120,100,0.65)',
  },
  likePillReadOnly: {
    opacity: 0.95,
  },
  likeCountInPill: {
    color: CREAM,
    fontSize: 13,
    fontWeight: '800',
    minWidth: 20,
    textAlign: 'left',
  },
  likeCountReadOnly: {
    color: CREAM_DARK,
  },
  actionButton: {
    backgroundColor: 'rgba(17,35,55,0.72)',
    padding: 9,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.22)',
  },
  actionButtonBm: {
    backgroundColor: 'rgba(227,92,37,0.28)',
    borderColor: 'rgba(227,92,37,0.5)',
  },
});
