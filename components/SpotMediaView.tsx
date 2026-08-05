// ============================================================
// SpotMediaView — Image or video for spot galleries
// ------------------------------------------------------------
// Photos use expo-image. Videos use expo-video (muted/loop for feed,
// optional native controls for peek).
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { BRAND } from '../constants/brand';
import { isVideoMediaUrl } from './types';

const { cream: CREAM } = BRAND;

type SpotMediaViewProps = {
  uri: string;
  style?: StyleProp<ViewStyle>;
  contentFit?: 'cover' | 'contain';
  /** Force video mode when URL detection is ambiguous. */
  isVideo?: boolean;
  /** Start playback when mounted (feed). */
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  nativeControls?: boolean;
  /** Small play badge for static/thumbnail contexts. */
  showPlayBadge?: boolean;
};

function SpotVideoPlayer({
  uri,
  style,
  contentFit = 'cover',
  autoPlay = false,
  muted = true,
  loop = true,
  nativeControls = false,
}: Omit<SpotMediaViewProps, 'isVideo' | 'showPlayBadge'> & { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = loop;
    p.muted = muted;
    if (autoPlay) p.play();
  });

  useEffect(() => {
    player.loop = loop;
    player.muted = muted;
  }, [loop, muted, player]);

  useEffect(() => {
    if (autoPlay) player.play();
    else player.pause();
  }, [autoPlay, player]);

  return (
    <VideoView
      player={player}
      style={style}
      contentFit={contentFit}
      nativeControls={nativeControls}
      allowsFullscreen={nativeControls}
    />
  );
}

/** Renders a spot gallery item as an image or video. */
export default function SpotMediaView({
  uri,
  style,
  contentFit = 'cover',
  isVideo: isVideoProp,
  autoPlay = false,
  muted = true,
  loop = true,
  nativeControls = false,
  showPlayBadge = false,
}: SpotMediaViewProps) {
  const isVideo = isVideoProp ?? isVideoMediaUrl(uri);

  if (!isVideo) {
    return <ExpoImage source={{ uri }} style={style as never} contentFit={contentFit} transition={150} />;
  }

  if (showPlayBadge && !autoPlay && !nativeControls) {
    return (
      <View style={[styles.videoThumb, style]}>
        <View style={styles.playBadge}>
          <Ionicons name="play" size={22} color={CREAM} style={{ marginLeft: 2 }} />
        </View>
      </View>
    );
  }

  return (
    <SpotVideoPlayer
      uri={uri}
      style={style}
      contentFit={contentFit}
      autoPlay={autoPlay}
      muted={muted}
      loop={loop}
      nativeControls={nativeControls}
    />
  );
}

const styles = StyleSheet.create({
  videoThumb: {
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  playBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
