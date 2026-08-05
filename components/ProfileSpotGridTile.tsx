// Profile grid cell: photo thumbnail, video poster, static map preview, or location-styled fallback.

import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { BRAND } from '../constants/brand';
import { spotStaticMapPreviewUrl } from '../utils/static-map-preview';
import { Spot, isSpotMediaVideo, spotGalleryUrls, spotThumbnailUrl } from './types';

const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK, navy: NAVY } = BRAND;

type Props = {
  spot: Spot;
  size: number;
  onPress: () => void;
};

function tileLabel(spot: Spot): string {
  const title = spot.title?.trim();
  if (title) return title;
  const address = spot.address?.trim();
  if (address) {
    const first = address.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'Pin';
}

export default function ProfileSpotGridTile({ spot, size, onPress }: Props) {
  const gallery = spotGalleryUrls(spot);
  const hasImage = gallery.length > 0;
  const thumb = hasImage ? spotThumbnailUrl(spot) : '';
  const isVideo = hasImage && isSpotMediaVideo(spot, 0);
  const mapUrl = useMemo(() => {
    if (hasImage) return null;
    if (typeof spot.latitude !== 'number' || typeof spot.longitude !== 'number') return null;
    return spotStaticMapPreviewUrl(spot.latitude, spot.longitude, size);
  }, [hasImage, spot.latitude, spot.longitude, size]);
  const [mapFailed, setMapFailed] = useState(false);

  const showMap = !hasImage && !!mapUrl && !mapFailed;
  const showLocationArt = !hasImage && !showMap;
  const label = tileLabel(spot);

  return (
    <TouchableOpacity
      style={[styles.tile, { width: size, height: size }]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityLabel={label}
    >
      {hasImage ? (
        <>
          {thumb ? (
            <ExpoImage source={{ uri: thumb }} style={styles.media} contentFit="cover" transition={120} />
          ) : (
            <View style={[styles.media, styles.videoFallback]}>
              <Ionicons name="videocam" size={size > 100 ? 28 : 22} color={CREAM_DARK} />
            </View>
          )}
          {isVideo ? (
            <View style={styles.playBadge} pointerEvents="none">
              <Ionicons name="play" size={14} color={CREAM} style={{ marginLeft: 1 }} />
            </View>
          ) : null}
        </>
      ) : showMap ? (
        <ExpoImage
          source={{ uri: mapUrl! }}
          style={styles.media}
          contentFit="cover"
          transition={120}
          onError={() => setMapFailed(true)}
        />
      ) : (
        <LinearGradient
          colors={['#1e3a5c', NAVY, '#0a1524']}
          locations={[0, 0.55, 1]}
          style={styles.media}
        >
          <View style={styles.gridLines} pointerEvents="none">
            <View style={[styles.gridLineH, { top: '22%' }]} />
            <View style={[styles.gridLineH, { top: '50%' }]} />
            <View style={[styles.gridLineH, { top: '78%' }]} />
            <View style={[styles.gridLineV, { left: '32%' }]} />
            <View style={[styles.gridLineV, { left: '68%' }]} />
          </View>
          <View style={styles.pinBadge}>
            <Ionicons name="location" size={size > 100 ? 26 : 22} color={CREAM} />
          </View>
        </LinearGradient>
      )}

      {showLocationArt ? (
        <View style={styles.locationTag} pointerEvents="none">
          <Ionicons name="map-outline" size={10} color={ORANGE} />
          <Text style={styles.locationTagText} numberOfLines={1}>
            Map pin
          </Text>
        </View>
      ) : null}

      <View style={styles.overlay} pointerEvents="none">
        <Text style={styles.title} numberOfLines={hasImage ? 1 : 2}>
          {label}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  tile: { overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.06)' },
  media: { width: '100%', height: '100%' },
  videoFallback: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridLines: { ...StyleSheet.absoluteFillObject },
  gridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(231,219,203,0.07)',
  },
  gridLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(231,219,203,0.07)',
  },
  pinBadge: {
    position: 'absolute',
    alignSelf: 'center',
    top: '32%',
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: ORANGE,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  locationTag: {
    position: 'absolute',
    top: 6,
    right: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: 'rgba(17,35,55,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.35)',
  },
  locationTagText: {
    fontSize: 9,
    fontWeight: '800',
    color: CREAM_DARK,
    letterSpacing: 0.2,
  },
  overlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(17,35,55,0.78)',
    paddingHorizontal: 6,
    paddingVertical: 5,
  },
  title: { color: CREAM, fontSize: 11, fontWeight: '700', lineHeight: 14 },
});
