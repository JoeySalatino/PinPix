// ============================================================
// SpotPeek.tsx — Bottom Sheet Spot Preview
// ------------------------------------------------------------
// Slide-up card shown when a map pin (or grid tile) is tapped.
// Displays:
//   - Image carousel (one slide per spot at this pin)
//   - Title, posted-by username (tappable to public profile)
//   - Address with Apple/Google Maps directions link
//   - Caption, tags (tappable to filter)
//   - Favorite / share / directions overlay buttons
//   - Tap-to-zoom fullscreen photo viewer
//   - Trash icon for the spot's owner, flag for everyone else
//
// Future: rewrite using @gorhom/bottom-sheet so the sheet is
// actually draggable. Today it's fixed-height for simplicity.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
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
import { shareSpot } from '../utils/share';
import { Spot } from './types';

const { width } = Dimensions.get('window');
const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK, danger: DANGER } = BRAND;

type SpotPeekProps = {
  spots: Spot[];
  onClose: () => void;
  toggleFavorite: (spot: Spot) => void;
  openDirections: (spot: Spot) => void;
  favorites: string[];
  isDark: boolean;
  currentUserId: string;
  onDelete: (spot: Spot) => void;
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
  toggleFavorite,
  openDirections,
  favorites,
  isDark,
  currentUserId,
  onDelete,
  onReport,
  onBlock,
  onTagPress,
  showUsernameLink = true,
}: SpotPeekProps) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [zoomVisible, setZoomVisible] = useState(false);

  // Pre-compute the list of images for the fullscreen zoom viewer
  // (only includes spots that actually have an image). Hooks must run
  // before any early return — see react-hooks/rules-of-hooks.
  const zoomImages = useMemo(
    () =>
      (spots || [])
        .filter((s) => s.imageUrl && s.imageUrl.trim() !== '')
        .map((s) => ({ uri: s.imageUrl })),
    [spots]
  );

  const spotIdsKey = useMemo(() => (spots || []).map((s) => s.id).join('|'), [spots]);
  const carouselRef = useRef<FlatList<Spot>>(null);

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

  if (!spots || spots.length === 0) return null;

  const spot = spots[index];
  // Coordinate-based key — matches the favorites format used elsewhere.
  // We keep this for parity with HomeScreen's favorites array.
  const key = `${spot.latitude.toFixed(4)}-${spot.longitude.toFixed(4)}`;
  const isFav = favorites.includes(key);
  const isOwner = currentUserId === spot.userId;
  const sheetBg = isDark ? '#0d1c2b' : NAVY;

  const handleUsernamePress = () => {
    if (!spot.username) return;
    onClose();
    // Use the lowercase form in the URL since /user/[username] queries
    // Firestore's lowercase `username` field.
    router.push(`/user/${spot.username.toLowerCase()}`);
  };

  return (
    <View style={[styles.sheet, { backgroundColor: sheetBg }]}>
      {/* ---- Top bar: X on left, block + flag (others) or trash (owner) ---- */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={onClose} style={styles.topBarButton}>
          <Ionicons name="close" size={24} color={CREAM} />
        </TouchableOpacity>

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
            const newIndex = Math.round(e.nativeEvent.contentOffset.x / width);
            setIndex(newIndex);
          }}
          renderItem={({ item }) => {
            const itemHasImage = item.imageUrl && item.imageUrl.trim() !== '';
            return (
              <TouchableOpacity
                style={styles.imageSlide}
                activeOpacity={itemHasImage ? 0.9 : 1}
                onPress={
                  itemHasImage
                    ? () => {
                        Keyboard.dismiss();
                        setZoomVisible(true);
                      }
                    : undefined
                }
              >
                {itemHasImage ? (
                  <ExpoImage
                    source={{ uri: item.imageUrl }}
                    style={styles.image}
                    contentFit="cover"
                    transition={150}
                  />
                ) : (
                  <View style={styles.imagePlaceholder}>
                    <Ionicons name="image-outline" size={40} color={CREAM_DARK} />
                    <Text style={{ color: CREAM_DARK, marginTop: 8, fontSize: 14 }}>No photo</Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          }}
        />

        {/* Count badge */}
        {spots.length > 1 && (
          <View style={styles.countBadge}>
            <Text style={styles.countText}>
              {index + 1} / {spots.length}
            </Text>
          </View>
        )}

        {/* Favorite / share / directions overlay */}
        <View style={styles.imageActions}>
          <TouchableOpacity
            onPress={() => toggleFavorite(spot)}
            style={[styles.actionButton, isFav && styles.actionButtonFav]}
          >
            <Ionicons
              name={isFav ? 'heart' : 'heart-outline'}
              size={20}
              color={isFav ? DANGER : CREAM}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => shareSpot(spot)} style={styles.actionButton}>
            <Ionicons name="share-outline" size={20} color={CREAM} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => openDirections(spot)} style={styles.actionButton}>
            <Ionicons name="navigate-outline" size={20} color={CREAM} />
          </TouchableOpacity>
        </View>
      </View>

      {/* ---- Dot indicators ---- */}
      {spots.length > 1 && (
        <View style={styles.dotsRow}>
          {spots.map((s, i) => (
            <View
              key={s.id}
              style={[
                styles.dot,
                {
                  backgroundColor: i === index ? ORANGE : 'rgba(231,219,203,0.25)',
                  width: i === index ? 18 : 6,
                },
              ]}
            />
          ))}
        </View>
      )}

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
        imageIndex={Math.min(index, Math.max(0, zoomImages.length - 1))}
        visible={zoomVisible}
        onRequestClose={() => setZoomVisible(false)}
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
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -6 },
    elevation: 20,
    borderTopWidth: 1,
    borderColor: 'rgba(227,92,37,0.25)',
  },

  // Top bar with X on left and trash/flag on right
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  topBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
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

  // Count badge
  countBadge: {
    position: 'absolute',
    top: 10,
    left: 14,
    backgroundColor: 'rgba(17,35,55,0.75)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.4)',
  },
  countText: { color: CREAM, fontSize: 12, fontWeight: '700' },

  // Favorite / share / directions buttons overlaid on image
  imageActions: {
    position: 'absolute',
    bottom: 12,
    right: 14,
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    backgroundColor: 'rgba(17,35,55,0.7)',
    padding: 9,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.2)',
  },
  actionButtonFav: {
    backgroundColor: 'rgba(255,59,48,0.15)',
    borderColor: 'rgba(255,59,48,0.4)',
  },

  // Dots
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 5,
  },
  dot: { height: 6, borderRadius: 3 },

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
