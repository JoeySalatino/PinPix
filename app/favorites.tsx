// ============================================================
// favorites.tsx — Saved spots (bookmarks)
// ------------------------------------------------------------
// Bookmarks live under users/{uid}/bookmarks/{spotId}. They drive
// gold pins on the map and this list. Tap a row to open the map there.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '../constants/brand';
import { auth } from '../utils/firebase';
import { captureError } from '../utils/sentry';
import { subscribeMyBookmarks, toggleBookmark, type BookmarkListItem } from '../utils/social';
import { useTheme } from '../utils/theme-context';

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function FavoritesScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const bg = isDark ? '#0d1c2b' : NAVY;

  const [uid, setUid] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkListItem[]>([]);

  useEffect(() => {
    return onAuthStateChanged(auth, (u) => setUid(u?.uid ?? null));
  }, []);

  useEffect(() => {
    if (!uid) {
      setBookmarks([]);
      return;
    }
    return subscribeMyBookmarks(uid, setBookmarks);
  }, [uid]);

  const openOnMap = (latitude: number, longitude: number) => {
    router.push({
      pathname: '/main',
      params: {
        lat: String(latitude),
        lng: String(longitude),
        zoom: '0.012',
      },
    });
  };

  const removeBookmark = async (item: BookmarkListItem) => {
    try {
      await toggleBookmark(
        {
          id: item.spotId,
          title: item.title,
          imageUrl: item.imageUrl,
          latitude: item.latitude,
          longitude: item.longitude,
          address: item.address,
        },
        true
      );
    } catch (e) {
      captureError(e, { area: 'FavoritesScreen.removeBookmark', spotId: item.spotId });
      Alert.alert('Error', 'Could not remove this save.');
    }
  };

  const confirmRemove = (item: BookmarkListItem) => {
    Alert.alert('Remove saved spot?', 'The gold map pin will clear for this spot.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeBookmark(item) },
    ]);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: bg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={28} color={CREAM} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Saves</Text>
        <View style={{ width: 28 }} />
      </View>

      <Text style={styles.subhead}>
        Bookmark a spot from the map to save it here and highlight its pin in gold.
      </Text>

      <FlatList
        data={bookmarks}
        keyExtractor={(b) => b.spotId}
        contentContainerStyle={styles.listPad}
        ListEmptyComponent={
          !uid ? (
            <Text style={styles.empty}>Sign in to see your saved spots.</Text>
          ) : (
            <Text style={styles.empty}>
              No saved spots yet. Open the map, tap a spot, and tap the bookmark to save it.
            </Text>
          )
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <TouchableOpacity
              style={styles.rowMain}
              onPress={() => openOnMap(item.latitude, item.longitude)}
              activeOpacity={0.75}
            >
              {item.imageUrl ? (
                <ExpoImage source={{ uri: item.imageUrl }} style={styles.thumb} contentFit="cover" />
              ) : (
                <View style={[styles.thumb, styles.thumbPh]}>
                  <Ionicons name="image-outline" size={22} color={CREAM_DARK} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={2}>
                  {item.title || 'Saved spot'}
                </Text>
                {!!item.address && (
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {item.address}
                  </Text>
                )}
              </View>
              <Ionicons name="map-outline" size={22} color={ORANGE} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => confirmRemove(item)} hitSlop={12} style={styles.removeBtn}>
              <Ionicons name="trash-outline" size={22} color={CREAM_DARK} />
            </TouchableOpacity>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: { fontSize: 18, fontWeight: '800', color: CREAM },
  subhead: {
    color: CREAM_DARK,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  listPad: { padding: 16, paddingBottom: 40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(231,219,203,0.12)',
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  removeBtn: { paddingHorizontal: 10, paddingVertical: 10 },
  thumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.2)' },
  thumbPh: { justifyContent: 'center', alignItems: 'center' },
  rowTitle: { color: CREAM, fontSize: 15, fontWeight: '700' },
  rowSub: { color: CREAM_DARK, fontSize: 12, marginTop: 2 },
  empty: { color: CREAM_DARK, fontSize: 14, lineHeight: 20, marginTop: 8 },
});
