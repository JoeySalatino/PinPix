// ============================================================
// SpotPeek.tsx — Bottom Sheet Spot Preview
// ------------------------------------------------------------
// Slide-up card shown when a map pin (or grid tile) is tapped.
// Displays:
//   - Image carousel (one slide per spot at this pin)
//   - Title, posted-by username (tappable to public profile)
//   - Address with Apple/Google Maps directions link
//   - Caption, tags (tappable to filter)
//   - Heart + like count (bottom-left); bookmark, share, directions (bottom-right) on photo scrim
//   - Tap-to-zoom fullscreen photo viewer
//   - Close, edit/delete or block/flag (overlaid on top of photo with scrim)
//
// Future: rewrite using @gorhom/bottom-sheet so the sheet is
// actually draggable. Today it's fixed-height for simplicity.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Keyboard,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import ImageView from 'react-native-image-viewing';
import { BRAND } from '../constants/brand';
import { auth, db } from '../utils/firebase';
import { captureError } from '../utils/sentry';
import { shareSpot } from '../utils/share';
import { toggleBookmark, toggleSpotLike } from '../utils/social';
import { Spot, spotGalleryUrls } from './types';

const { width } = Dimensions.get('window');
const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK, danger: DANGER } = BRAND;

type SpotPeekProps = {
  spots: Spot[];
  onClose: () => void;
  openDirections: (spot: Spot) => void;
  isDark: boolean;
  currentUserId: string;
  onDelete: (spot: Spot) => void;
  /** Owner: full edit form (photos, title, location, tags). */
  onEdit?: (spot: Spot) => void;
  onReport: (spot: Spot) => void;
  /** When set, non-owners see a Block control (UGC safety / App Store). */
  onBlock?: (spot: Spot) => void;
  // Optional: if provided, tapping a tag bubbles up so the parent can filter.
  onTagPress?: (tag: string) => void;
  // Optional: hide the @username link (e.g. when already on that user's profile)
  showUsernameLink?: boolean;
};

export default function SpotPeek({
  spots,
  onClose,
  openDirections,
  isDark,
  currentUserId,
  onDelete,
  onEdit,
  onReport,
  onBlock,
  onTagPress,
  showUsernameLink = true,
}: SpotPeekProps) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [zoomVisible, setZoomVisible] = useState(false);
  const [zoomImageIndex, setZoomImageIndex] = useState(0);
  const [innerPhotoIndex, setInnerPhotoIndex] = useState(0);
  const [likeCount, setLikeCount] = useState(0);
  const [likedByMe, setLikedByMe] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);

  // Pre-compute the list of images for the fullscreen zoom viewer
  // (only includes spots that actually have an image). Hooks must run
  // before any early return — see react-hooks/rules-of-hooks.
  const zoomImages = useMemo(
    () =>
      (spots || []).flatMap((s) => spotGalleryUrls(s).map((uri) => ({ uri }))),
    [spots]
  );

  const spotIdsKey = useMemo(() => (spots || []).map((s) => s.id).join('|'), [spots]);
  const spotCount = spots?.length ?? 0;
  const carouselRef = useRef<FlatList<Spot>>(null);

  useEffect(() => {
    setInnerPhotoIndex(0);
  }, [index, spotIdsKey]);

  // When the spot list at this pin changes (filters, etc.), reset carousel
  // scroll and index so we never read spots[index] out of range.
  useEffect(() => {
    if (!spots || spots.length === 0) return;
    setIndex(0);
    const id = requestAnimationFrame(() => {
      carouselRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
    return () => cancelAnimationFrame(id);
    // spotIdsKey encodes which spots are in the carousel; we must not reset on
    // unrelated `spots` reference changes from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps: spotIdsKey only
  }, [spotIdsKey]);

  // Keep index in range when length shrinks or FlatList reports an out-of-range page.
  useEffect(() => {
    if (spotCount === 0) return;
    const clamped = Math.min(Math.max(0, index), spotCount - 1);
    if (clamped !== index) setIndex(clamped);
  }, [index, spotCount]);

  // Corrupt / incomplete spot data — close rather than rendering a broken sheet.
  useEffect(() => {
    if (spotCount === 0 || !spots) return;
    const i = Math.min(Math.max(0, index), spotCount - 1);
    const s = spots[i];
    if (!s || typeof s.latitude !== 'number' || typeof s.longitude !== 'number') {
      onClose();
    }
  }, [spots, spotCount, index, onClose]);

  // Like count + bookmark presence for the visible spot.
  useEffect(() => {
    if (!spots?.length) return;
    const i = Math.min(Math.max(0, index), spots.length - 1);
    const s = spots[i];
    if (!s?.id) return;
    const me = auth.currentUser?.uid;
    const unsubLikes = onSnapshot(collection(db, 'spots', s.id, 'likes'), (snap) => {
      setLikeCount(snap.size);
      setLikedByMe(me ? snap.docs.some((d) => d.id === me) : false);
    });
    let unsubBm: (() => void) | undefined;
    if (me) {
      unsubBm = onSnapshot(doc(db, 'users', me, 'bookmarks', s.id), (bm) => {
        setIsBookmarked(bm.exists());
      });
    } else {
      setIsBookmarked(false);
    }
    return () => {
      unsubLikes();
      unsubBm?.();
    };
    // spotIdsKey + index define visible spot; avoid depending on `spots` identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, spotIdsKey]);

  if (!spots || spots.length === 0) return null;

  const maxIdx = spots.length - 1;
  const safeIndex = Math.min(Math.max(0, index), maxIdx);
  const spot = spots[safeIndex];
  if (!spot || typeof spot.latitude !== 'number' || typeof spot.longitude !== 'number') {
    return null;
  }
  const isOwner = currentUserId === spot.userId;
  const sheetBg = isDark ? '#0d1c2b' : NAVY;
  const peekGalleryUrls = spotGalleryUrls(spot);
  const peekMultiPhoto = peekGalleryUrls.length > 1;

  const handleUsernamePress = () => {
    if (!spot.username) return;
    onClose();
    // Use the lowercase form in the URL since /user/[username] queries
    // Firestore's lowercase `username` field.
    router.push(`/user/${spot.username.toLowerCase()}`);
  };

  const handleToggleLike = async () => {
    if (!currentUserId || !spot.id) return;
    try {
      await toggleSpotLike(spot.id, likedByMe);
    } catch (e) {
      captureError(e, { area: 'SpotPeek.toggleLike', spotId: spot.id });
    }
  };

  const handleToggleBookmark = async () => {
    if (!currentUserId) return;
    try {
      const thumb = spotGalleryUrls(spot)[0] || spot.imageUrl || '';
      await toggleBookmark(
        {
          id: spot.id,
          title: spot.title,
          imageUrl: thumb,
          latitude: spot.latitude,
          longitude: spot.longitude,
          address: spot.address,
        },
        isBookmarked
      );
    } catch (e) {
      captureError(e, { area: 'SpotPeek.toggleBookmark', spotId: spot.id });
    }
  };

  const openZoomForSpotItem = (item: Spot, urls: string[]) => {
    Keyboard.dismiss();
    if (zoomImages.length === 0) return;
    const si = spots.findIndex((s) => s.id === item.id);
    if (si < 0) return;
    let acc = 0;
    for (let i = 0; i < si; i++) {
      acc += spotGalleryUrls(spots[i]).length;
    }
    const inner =
      si === safeIndex
        ? Math.min(innerPhotoIndex, Math.max(0, urls.length - 1))
        : 0;
    const zi = Math.min(acc + inner, Math.max(0, zoomImages.length - 1));
    setZoomImageIndex(zi);
    setZoomVisible(true);
  };

  return (
    <View style={[styles.sheet, { backgroundColor: sheetBg }]}>
      {/* ---- Horizontal image carousel ---- */}
      <View style={styles.imageContainer}>
        <FlatList
          ref={carouselRef}
          data={spots}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(item) => item.id}
          onMomentumScrollEnd={(e) => {
            const max = spots.length - 1;
            if (max < 0) return;
            const raw = Math.round(e.nativeEvent.contentOffset.x / width);
            setIndex(Math.min(Math.max(0, raw), max));
          }}
          renderItem={({ item }) => {
            const urls = spotGalleryUrls(item);
            const itemHasImage = urls.length > 0;

            if (!itemHasImage) {
              return (
                <View style={styles.imageSlide}>
                  <View style={styles.imagePlaceholder}>
                    <Ionicons name="image-outline" size={40} color={CREAM_DARK} />
                    <Text style={{ color: CREAM_DARK, marginTop: 8, fontSize: 14 }}>No photo</Text>
                  </View>
                </View>
              );
            }

            if (urls.length === 1) {
              return (
                <TouchableOpacity
                  style={styles.imageSlide}
                  activeOpacity={0.9}
                  onPress={() => openZoomForSpotItem(item, urls)}
                >
                  <ExpoImage
                    source={{ uri: urls[0] }}
                    style={styles.image}
                    contentFit="cover"
                    transition={150}
                  />
                </TouchableOpacity>
              );
            }

            return (
              <View style={styles.imageSlide}>
                <ScrollView
                  horizontal
                  pagingEnabled
                  showsHorizontalScrollIndicator={false}
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                  onMomentumScrollEnd={(e) => {
                    const raw = Math.round(e.nativeEvent.contentOffset.x / width);
                    const clamped = Math.min(Math.max(0, raw), urls.length - 1);
                    if (spots[safeIndex]?.id === item.id) {
                      setInnerPhotoIndex(clamped);
                    }
                  }}
                >
                  {urls.map((uri, uidx) => (
                    <TouchableOpacity
                      key={`${item.id}-${uidx}`}
                      style={{ width, height: 260 }}
                      activeOpacity={0.9}
                      onPress={() => openZoomForSpotItem(item, urls)}
                    >
                      <ExpoImage
                        source={{ uri }}
                        style={styles.image}
                        contentFit="cover"
                        transition={150}
                      />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            );
          }}
        />

        <LinearGradient
          pointerEvents="none"
          colors={['rgba(7,15,24,0.82)', 'rgba(7,15,24,0.45)', 'transparent']}
          locations={[0, 0.4, 1]}
          style={styles.imageTopScrim}
        />

        {/* Subtle scrim + overlaid actions: keeps the sheet compact; gradient is
            non-interactive so horizontal swipes on the photo still scroll the carousel. */}
        <LinearGradient
          pointerEvents="none"
          colors={['transparent', 'rgba(7,15,24,0.55)', 'rgba(7,15,24,0.82)']}
          locations={[0, 0.45, 1]}
          style={styles.imageBottomScrim}
        />

        {spots.length > 1 && (
          <View style={styles.dotsRowOverlay} pointerEvents="none">
            {spots.map((s, i) => (
              <View
                key={s.id}
                style={[
                  styles.dot,
                  {
                    backgroundColor: i === safeIndex ? ORANGE : 'rgba(231,219,203,0.35)',
                    width: i === safeIndex ? 18 : 6,
                  },
                ]}
              />
            ))}
          </View>
        )}

        {peekMultiPhoto && spots.length > 1 && (
          <View style={styles.innerCountBadgeBottom} pointerEvents="none">
            <Text style={styles.countText}>
              {Math.min(innerPhotoIndex, Math.max(0, peekGalleryUrls.length - 1)) + 1} /{' '}
              {peekGalleryUrls.length}
            </Text>
          </View>
        )}

        {/* Close + actions on the photo (same pattern as bottom actions). */}
        <View style={styles.imageTopChrome} pointerEvents="box-none">
          <View style={styles.imageTopRow} pointerEvents="box-none">
            <TouchableOpacity onPress={onClose} style={styles.topBarButton}>
              <Ionicons name="close" size={24} color={CREAM} />
            </TouchableOpacity>

            <View style={styles.imageTopCenter} pointerEvents="none">
              {spots.length > 1 ? (
                <View style={styles.countBadgePill}>
                  <Text style={styles.countText}>
                    {safeIndex + 1} / {spots.length}
                  </Text>
                </View>
              ) : peekMultiPhoto ? (
                <View style={styles.countBadgePill}>
                  <Text style={styles.countText}>
                    {Math.min(innerPhotoIndex, Math.max(0, peekGalleryUrls.length - 1)) + 1} /{' '}
                    {peekGalleryUrls.length}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={styles.topBarRight}>
              {!isOwner && onBlock ? (
                <TouchableOpacity
                  style={[styles.topBarButton, { marginRight: 8 }]}
                  onPress={() => onBlock(spot)}
                  accessibilityLabel="Block user"
                >
                  <Ionicons name="ban-outline" size={22} color={CREAM_DARK} />
                </TouchableOpacity>
              ) : null}
              {isOwner && onEdit ? (
                <TouchableOpacity
                  style={[styles.topBarButton, { marginRight: 8 }]}
                  onPress={() => {
                    onClose();
                    onEdit(spot);
                  }}
                  accessibilityLabel="Edit spot"
                >
                  <Ionicons name="create-outline" size={22} color={CREAM} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={styles.topBarButton}
                onPress={() => (isOwner ? onDelete(spot) : onReport(spot))}
                accessibilityLabel={isOwner ? 'Delete spot' : 'Report spot'}
              >
                <Ionicons
                  name={isOwner ? 'trash-outline' : 'flag-outline'}
                  size={22}
                  color={isOwner ? DANGER : CREAM_DARK}
                />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={styles.imageActionsOverlay} pointerEvents="box-none">
          <View style={styles.imageActionsBar} pointerEvents="box-none">
            <View style={styles.imageActionsLeft} pointerEvents="box-none">
              {!!currentUserId ? (
                <TouchableOpacity
                  onPress={() => void handleToggleLike()}
                  style={[styles.likeHeartPill, likedByMe && styles.likeHeartPillLiked]}
                  activeOpacity={0.85}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                >
                  <Ionicons
                    name={likedByMe ? 'heart' : 'heart-outline'}
                    size={20}
                    color={likedByMe ? DANGER : CREAM}
                  />
                  <Text style={styles.likeCountInline}>{likeCount}</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.likeHeartPill} pointerEvents="none">
                  <Ionicons name="heart-outline" size={20} color={CREAM_DARK} />
                  <Text style={styles.likeCountInline}>{likeCount}</Text>
                </View>
              )}
            </View>
            <View style={styles.imageActionsRight} pointerEvents="box-none">
              {!!currentUserId && (
                <TouchableOpacity
                  onPress={() => void handleToggleBookmark()}
                  style={[styles.actionButton, isBookmarked && styles.actionButtonBm]}
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
                hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
              >
                <Ionicons name="share-outline" size={20} color={CREAM} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => openDirections(spot)} style={styles.actionButton}>
                <Ionicons name="navigate-outline" size={20} color={CREAM} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>

      {/* ---- Info section ---- */}
      <ScrollView
        style={styles.info}
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.titleRow}>
          <View style={{ flex: 1 }}>
            {spot.title ? (
              <Text style={styles.title} numberOfLines={2}>
                {spot.title}
              </Text>
            ) : (
              <Text style={[styles.title, styles.titleUntitled]}>Untitled Spot</Text>
            )}

            {/* Posted-by row. Tappable when showUsernameLink and we have a username. */}
            <Text style={styles.postedBy}>
              Posted by{' '}
              <Text
                style={styles.postedByName}
                onPress={
                  showUsernameLink && spot.username ? handleUsernamePress : undefined
                }
                suppressHighlighting={!showUsernameLink}
              >
                @{spot.username || 'anonymous'}
              </Text>
            </Text>
          </View>
        </View>

        {!!spot.address && (
          <View style={styles.addressRow}>
            <Ionicons
              name="location-outline"
              size={14}
              color={ORANGE}
              style={{ marginRight: 5, marginTop: 1 }}
            />
            <Text style={styles.address} numberOfLines={2}>
              {spot.address}
            </Text>
          </View>
        )}

        {!!spot.caption && <Text style={styles.caption}>{spot.caption}</Text>}

        {spot.tags && spot.tags.length > 0 && (
          <View style={styles.tagsRow}>
            {spot.tags.map((tag) => {
              const TagInner = (
                <Text style={styles.tagText}>{tag}</Text>
              );
              return onTagPress ? (
                <TouchableOpacity
                  key={tag}
                  style={styles.tag}
                  onPress={() => onTagPress(tag)}
                  activeOpacity={0.7}
                >
                  {TagInner}
                </TouchableOpacity>
              ) : (
                <View key={tag} style={styles.tag}>
                  {TagInner}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* ---- Fullscreen pinch-to-zoom photo viewer ---- */}
      <ImageView
        images={zoomImages}
        imageIndex={zoomImageIndex}
        visible={zoomVisible}
        onRequestClose={() => setZoomVisible(false)}
        onImageIndexChange={setZoomImageIndex}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    bottom: 0,
    width: '100%',
    maxHeight: '85%',
    zIndex: 50,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -6 },
    elevation: 24,
    borderTopWidth: 1,
    borderColor: 'rgba(227,92,37,0.25)',
  },

  // Top chrome on the photo (close + spot / photo count + owner / report actions)
  imageTopScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 96,
    zIndex: 4,
  },
  imageTopChrome: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    zIndex: 10,
    paddingTop: 10,
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  imageTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  imageTopCenter: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  topBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  topBarButton: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    padding: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.15)',
  },

  // Image carousel
  imageContainer: { position: 'relative' },
  imageSlide: { width, height: 260 },
  image: { width: '100%', height: '100%' },
  imagePlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(17,35,55,0.8)',
  },

  imageBottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 100,
    zIndex: 4,
  },

  // Bookmark / like / share / directions — overlaid on the photo bottom; outer
  // uses box-none so swipes on the image still reach the FlatList outside the buttons.
  imageActionsOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 8,
    paddingBottom: 10,
    paddingHorizontal: 12,
    paddingTop: 28,
  },
  imageActionsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 12,
  },
  imageActionsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  imageActionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 8,
    flexShrink: 1,
  },
  /** Heart + count on the bottom-left of the photo (read-only pill when not signed in). */
  likeHeartPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: 'rgba(17,35,55,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.2)',
  },
  likeHeartPillLiked: {
    backgroundColor: 'rgba(255,59,48,0.15)',
    borderColor: 'rgba(255,59,48,0.4)',
  },
  likeCountInline: { color: CREAM, fontSize: 13, fontWeight: '800', minWidth: 16, textAlign: 'left' },
  countBadgePill: {
    backgroundColor: 'rgba(17,35,55,0.75)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.4)',
  },
  innerCountBadgeBottom: {
    position: 'absolute',
    bottom: 52,
    left: 14,
    zIndex: 9,
    backgroundColor: 'rgba(17,35,55,0.75)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.4)',
  },
  countText: { color: CREAM, fontSize: 12, fontWeight: '700' },
  // Dot indicators (multi-spot only) — on the image, above the action chips
  dotsRowOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 50,
    zIndex: 7,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 5,
  },
  dot: { height: 6, borderRadius: 3 },

  actionButton: {
    backgroundColor: 'rgba(17,35,55,0.7)',
    padding: 9,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.2)',
  },
  actionButtonBm: {
    backgroundColor: 'rgba(227,92,37,0.25)',
    borderColor: 'rgba(227,92,37,0.5)',
  },

  // Info section
  info: { paddingHorizontal: 18, paddingTop: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  title: { fontSize: 18, fontWeight: '800', color: CREAM, marginBottom: 3, letterSpacing: 0.2 },
  titleUntitled: { color: CREAM_DARK, fontStyle: 'italic' },
  postedBy: { fontSize: 13, color: CREAM_DARK },
  postedByName: { color: ORANGE, fontWeight: '700' },
  addressRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  address: { fontSize: 13, flex: 1, lineHeight: 18, color: CREAM_DARK },
  caption: { fontSize: 14, lineHeight: 20, marginBottom: 10, color: CREAM_DARK },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: 'rgba(227,92,37,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.35)',
  },
  tagText: { fontSize: 12, fontWeight: '700', color: ORANGE },
});
