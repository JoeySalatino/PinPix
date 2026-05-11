// ============================================================
// SpotPeek.tsx — Bottom Sheet Spot Preview
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Spot } from './types';

const { width } = Dimensions.get('window');

const NAVY = '#112337';
const ORANGE = '#E35C25';
const CREAM = '#E7DBCB';
const CREAM_DARK = '#D4C5B0';

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
}: SpotPeekProps) {
  const [index, setIndex] = useState(0);
  const [imageLoading, setImageLoading] = useState(true);

  if (!spots || spots.length === 0) return null;

  const spot = spots[index];
  const key = `${spot.latitude.toFixed(4)}-${spot.longitude.toFixed(4)}`;
  const isFav = favorites.includes(key);
  const isOwner = currentUserId === spot.userId;
  const sheetBg = isDark ? '#0d1c2b' : NAVY;

  return (
    <View style={[styles.sheet, { backgroundColor: sheetBg }]}>

      {/* ---- Drag handle ---- */}
      <View style={styles.handleWrap}>
        <View style={styles.handle} />
      </View>

      {/* ---- Top bar: X on left, trash/flag on right ---- */}
      <View style={styles.topBar}>
        {/* Close button — top LEFT */}
        <TouchableOpacity onPress={onClose} style={styles.topBarButton}>
          <Ionicons name="close" size={24} color={CREAM} />
        </TouchableOpacity>

        {/* Delete or Report button — top RIGHT */}
        <TouchableOpacity
          style={styles.topBarButton}
          onPress={() => isOwner ? onDelete(spot) : onReport(spot)}
        >
          <Ionicons
            name={isOwner ? 'trash-outline' : 'flag-outline'}
            size={22}
            color={isOwner ? '#FF3B30' : CREAM_DARK}
          />
        </TouchableOpacity>
      </View>

      {/* ---- Horizontal image carousel ---- */}
      <View style={styles.imageContainer}>
        <FlatList
          data={spots}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(_, i) => i.toString()}
          onMomentumScrollEnd={e => {
            const newIndex = Math.round(e.nativeEvent.contentOffset.x / width);
            setIndex(newIndex);
            setImageLoading(true);
          }}
          renderItem={({ item }) => {
            const itemHasImage = item.imageUrl && item.imageUrl.trim() !== '';
            return (
              <View style={styles.imageSlide}>
                {itemHasImage ? (
                  <>
                    <Image
                      source={{ uri: item.imageUrl }}
                      style={styles.image}
                      onLoadStart={() => setImageLoading(true)}
                      onLoadEnd={() => setImageLoading(false)}
                    />
                    {imageLoading && (
                      <View style={styles.imagePlaceholder}>
                        <ActivityIndicator color={ORANGE} />
                      </View>
                    )}
                  </>
                ) : (
                  <View style={styles.imagePlaceholder}>
                    <Ionicons name="image-outline" size={40} color={CREAM_DARK} />
                    <Text style={{ color: CREAM_DARK, marginTop: 8, fontSize: 14 }}>No photo</Text>
                  </View>
                )}
              </View>
            );
          }}
        />

        {/* Count badge */}
        {spots.length > 1 && (
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{index + 1} / {spots.length}</Text>
          </View>
        )}

        {/* Favorite and directions buttons */}
        <View style={styles.imageActions}>
          <TouchableOpacity
            onPress={() => toggleFavorite(spot)}
            style={[styles.actionButton, isFav && styles.actionButtonFav]}
          >
            <Ionicons name={isFav ? 'heart' : 'heart-outline'} size={20} color={isFav ? '#FF3B30' : CREAM} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => openDirections(spot)} style={styles.actionButton}>
            <Ionicons name="navigate-outline" size={20} color={CREAM} />
          </TouchableOpacity>
        </View>
      </View>

      {/* ---- Dot indicators ---- */}
      {spots.length > 1 && (
        <View style={styles.dotsRow}>
          {spots.map((_, i) => (
            <View
              key={i}
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
      <ScrollView style={styles.info} contentContainerStyle={{ paddingBottom: 24 }} showsVerticalScrollIndicator={false}>
        <View style={styles.titleRow}>
          <View style={{ flex: 1 }}>
            {!!spot.title
              ? <Text style={styles.title} numberOfLines={2}>{spot.title}</Text>
              : <Text style={[styles.title, { color: CREAM_DARK, fontStyle: 'italic' }]}>Untitled Spot</Text>
            }
            <Text style={styles.postedBy}>
              Posted by <Text style={{ color: ORANGE, fontWeight: '700' }}>@{spot.username || 'anonymous'}</Text>
            </Text>
          </View>
        </View>

        {!!spot.address && (
          <View style={styles.addressRow}>
            <Ionicons name="location-outline" size={14} color={ORANGE} style={{ marginRight: 5, marginTop: 1 }} />
            <Text style={styles.address} numberOfLines={2}>{spot.address}</Text>
          </View>
        )}

        {!!spot.caption && (
          <Text style={styles.caption}>{spot.caption}</Text>
        )}

        {spot.tags && spot.tags.length > 0 && (
          <View style={styles.tagsRow}>
            {spot.tags.map(tag => (
              <View key={tag} style={styles.tag}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute', bottom: 0, width: '100%', maxHeight: '85%',
    borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 20, shadowOffset: { width: 0, height: -6 }, elevation: 20,
    borderTopWidth: 1, borderColor: 'rgba(227,92,37,0.25)',
  },

  // Drag handle
  handleWrap: { alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(231,219,203,0.3)' },

  // Top bar with X on left and trash/flag on right
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  topBarButton: {
    // Larger tap target with background pill for visibility
    backgroundColor: 'rgba(255,255,255,0.1)',
    padding: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.15)',
  },

  // Image carousel
  imageContainer: { position: 'relative' },
  imageSlide: { width, height: 260 },
  image: { width: '100%', height: '100%', resizeMode: 'cover' },
  imagePlaceholder: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(17,35,55,0.8)',
  },

  // Count badge
  countBadge: {
    position: 'absolute', top: 10, left: 14,
    backgroundColor: 'rgba(17,35,55,0.75)',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
    borderWidth: 1, borderColor: 'rgba(227,92,37,0.4)',
  },
  countText: { color: CREAM, fontSize: 12, fontWeight: '700' },

  // Favorite and directions overlaid on image
  imageActions: { position: 'absolute', bottom: 12, right: 14, flexDirection: 'row', gap: 8 },
  actionButton: {
    backgroundColor: 'rgba(17,35,55,0.7)', padding: 9, borderRadius: 20,
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.2)',
  },
  actionButtonFav: { backgroundColor: 'rgba(255,59,48,0.15)', borderColor: 'rgba(255,59,48,0.4)' },

  // Dots
  dotsRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 10, gap: 5 },
  dot: { height: 6, borderRadius: 3 },

  // Info
  info: { paddingHorizontal: 18, paddingTop: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  title: { fontSize: 18, fontWeight: '800', color: CREAM, marginBottom: 3, letterSpacing: 0.2 },
  postedBy: { fontSize: 13, color: CREAM_DARK },
  addressRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  address: { fontSize: 13, flex: 1, lineHeight: 18, color: CREAM_DARK },
  caption: { fontSize: 14, lineHeight: 20, marginBottom: 10, color: CREAM_DARK },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20,
    backgroundColor: 'rgba(227,92,37,0.15)',
    borderWidth: 1, borderColor: 'rgba(227,92,37,0.35)',
  },
  tagText: { fontSize: 12, fontWeight: '700', color: ORANGE },
});