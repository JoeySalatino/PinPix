// ============================================================
// weekly-review.tsx — Swipeable recap of new nearby spots this week
// ------------------------------------------------------------
// Opened from the weekly digest push notification. Spot ids are
// stored on the user doc when nearby pushes fire during the week.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  ListRenderItem,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '../constants/brand';
import { appScreenBackground } from '../constants/theme';
import { auth, db } from '../utils/firebase';
import { navigateToSpotOnMap } from '../utils/open-spot-on-map';
import { captureError } from '../utils/sentry';
import {
  fetchWeeklyReviewSpots,
  toggleBookmark,
  toggleSpotLike,
  type FriendActivitySpot,
} from '../utils/social';
import { useTheme } from '../utils/theme-context';

const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK, danger: DANGER } = BRAND;

type ReviewPageProps = {
  item: FriendActivitySpot;
  itemHeight: number;
  onOpenMap: (item: FriendActivitySpot) => void;
  viewerUid: string | undefined;
  isDark: boolean;
};

function ReviewSpotPage({
  item,
  itemHeight,
  onOpenMap,
  viewerUid,
  isDark,
}: ReviewPageProps) {
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

  const authorSlug = (item.authorUsername || '').trim().toLowerCase();
  const openAuthorProfile = () => {
    if (!authorSlug) return;
    router.push(`/user/${authorSlug}`);
  };

  return (
    <View style={[styles.page, { height: itemHeight }]}>
      <View style={styles.cardFrame}>
        <View style={styles.feedImageStack}>
          <TouchableOpacity
            style={styles.tapLayer}
            activeOpacity={0.95}
            onPress={() => onOpenMap(item)}
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.title || 'spot'} on map`}
          />
          {item.imageUrl ? (
            <ExpoImage source={{ uri: item.imageUrl }} style={styles.fullImage} contentFit="cover" />
          ) : (
            <View style={[styles.fullImage, styles.imagePh]}>
              <Ionicons name="image-outline" size={48} color={CREAM_DARK} />
            </View>
          )}

          <View style={styles.overlayText}>
            {authorSlug ? (
              <TouchableOpacity onPress={openAuthorProfile} activeOpacity={0.8}>
                <Text style={styles.author}>@{item.authorUsername}</Text>
              </TouchableOpacity>
            ) : null}
            <Text style={styles.title} numberOfLines={3}>
              {item.title || 'Untitled spot'}
            </Text>
            <Text style={styles.swipeHint}>Swipe up for the next spot</Text>
          </View>

          <View style={styles.actionsTopRight}>
            <TouchableOpacity
              style={[styles.actionButton, isBookmarked && styles.actionButtonBm]}
              onPress={async () => {
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
                  captureError(e, { area: 'WeeklyReview.toggleBookmark', spotId: item.id });
                }
              }}
              accessibilityRole="button"
              accessibilityLabel={isBookmarked ? 'Remove bookmark' : 'Bookmark spot'}
            >
              <Ionicons
                name={isBookmarked ? 'bookmark' : 'bookmark-outline'}
                size={22}
                color={isBookmarked ? ORANGE : CREAM}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => onOpenMap(item)}
              accessibilityRole="button"
              accessibilityLabel="Open on map"
            >
              <Ionicons name="map-outline" size={22} color={CREAM} />
            </TouchableOpacity>
          </View>

          <View style={styles.actionsBottomRight}>
            <TouchableOpacity
              style={[styles.likePill, likedByMe && styles.likePillLiked]}
              onPress={async () => {
                if (!me) return;
                try {
                  await toggleSpotLike(item.id, likedByMe);
                } catch (e) {
                  captureError(e, { area: 'WeeklyReview.toggleLike', spotId: item.id });
                }
              }}
              accessibilityRole="button"
              accessibilityLabel={likedByMe ? 'Unlike spot' : 'Like spot'}
            >
              <Ionicons name={likedByMe ? 'heart' : 'heart-outline'} size={20} color={likedByMe ? DANGER : CREAM} />
              <Text style={styles.likeCountInPill}>{likeCount}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </View>
  );
}

export default function WeeklyReviewScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const bg = appScreenBackground(isDark);

  const [viewerUid, setViewerUid] = useState<string | undefined>(undefined);
  const [spots, setSpots] = useState<FriendActivitySpot[]>([]);
  const [loading, setLoading] = useState(true);

  const itemHeight = useMemo(() => {
    const winH = Dimensions.get('window').height;
    return Math.max(420, winH - 120);
  }, []);

  const loadSpots = useCallback(async (uid: string) => {
    setLoading(true);
    try {
      const rows = await fetchWeeklyReviewSpots(uid);
      setSpots(rows);
    } catch (e) {
      captureError(e, { area: 'WeeklyReview.loadSpots' });
      setSpots([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setViewerUid(user?.uid);
      if (!user) {
        setSpots([]);
        setLoading(false);
        router.replace('/login');
        return;
      }
      void loadSpots(user.uid);
    });
    return unsub;
  }, [loadSpots, router]);

  const openOnMap = useCallback(
    (item: FriendActivitySpot) => {
      navigateToSpotOnMap(
        router,
        { id: item.id, latitude: item.latitude, longitude: item.longitude },
        { replace: false }
      );
    },
    [router]
  );

  const renderItem: ListRenderItem<FriendActivitySpot> = useCallback(
    ({ item }) => (
      <ReviewSpotPage
        item={item}
        itemHeight={itemHeight}
        onOpenMap={openOnMap}
        viewerUid={viewerUid}
        isDark={isDark}
      />
    ),
    [itemHeight, isDark, openOnMap, viewerUid]
  );

  const listEmpty = useMemo(() => {
    if (loading) {
      return (
        <View style={[styles.centerEmpty, { minHeight: itemHeight }]}>
          <ActivityIndicator size="large" color={ORANGE} />
        </View>
      );
    }
    return (
      <View style={[styles.centerEmpty, { minHeight: itemHeight, paddingHorizontal: 28 }]}>
        <Ionicons name="calendar-outline" size={48} color={CREAM_DARK} />
        <Text style={styles.emptyTitle}>Nothing in this week&apos;s recap yet</Text>
        <Text style={styles.emptySub}>
          New spots near you will show up here after your next weekly summary.
        </Text>
        <TouchableOpacity style={styles.emptyBtn} onPress={() => router.replace('/main')}>
          <Text style={styles.emptyBtnText}>Explore the map</Text>
        </TouchableOpacity>
      </View>
    );
  }, [itemHeight, loading, router]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: bg }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={28} color={CREAM} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={styles.headerTitle}>This week in review</Text>
          {!loading && spots.length > 0 ? (
            <Text style={styles.headerSub}>{spots.length} new spot{spots.length === 1 ? '' : 's'} near you</Text>
          ) : null}
        </View>
      </View>

      <FlatList
        style={{ flex: 1 }}
        data={spots}
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
        contentContainerStyle={spots.length === 0 ? styles.listEmptyGrow : undefined}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 10,
    gap: 4,
  },
  backBtn: {
    padding: 4,
  },
  headerTextWrap: { flex: 1 },
  headerTitle: { fontSize: 24, fontWeight: '900', color: CREAM, letterSpacing: 0.2 },
  headerSub: { color: CREAM_DARK, fontSize: 13, marginTop: 2, fontWeight: '600' },
  listEmptyGrow: { flexGrow: 1 },
  centerEmpty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
  },
  emptyTitle: { color: CREAM, fontSize: 18, fontWeight: '800', textAlign: 'center', marginTop: 8 },
  emptySub: { color: CREAM_DARK, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  emptyBtn: {
    marginTop: 12,
    backgroundColor: ORANGE,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 12,
  },
  emptyBtnText: { color: CREAM, fontWeight: '800', fontSize: 15 },
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
    marginBottom: 4,
    width: '100%',
  },
  swipeHint: { color: CREAM_DARK, fontSize: 12, fontWeight: '600' },
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
  },
  likePillLiked: {
    backgroundColor: 'rgba(48,12,10,0.82)',
    borderColor: 'rgba(255,120,100,0.65)',
  },
  likeCountInPill: {
    color: CREAM,
    fontSize: 13,
    fontWeight: '800',
    minWidth: 20,
    textAlign: 'left',
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
