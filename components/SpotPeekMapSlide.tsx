// Mini map preview for SpotPeek when a spot has no photos.

import { useMemo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';
import { BRAND } from '../constants/brand';
import type { Spot } from './types';

const { orange: ORANGE } = BRAND;
const MAP_DELTA = 0.011;

export function spotPeekMapRegion(spot: Pick<Spot, 'latitude' | 'longitude'>): Region {
  return {
    latitude: spot.latitude,
    longitude: spot.longitude,
    latitudeDelta: MAP_DELTA,
    longitudeDelta: MAP_DELTA,
  };
};

type SpotPeekMapSlideProps = {
  spot: Pick<Spot, 'latitude' | 'longitude'>;
  width: number;
  height: number;
};

export default function SpotPeekMapSlide({ spot, width, height }: SpotPeekMapSlideProps) {
  const region = useMemo(
    () => spotPeekMapRegion(spot),
    [spot.latitude, spot.longitude]
  );

  return (
    <View style={[styles.wrap, { width, height }]}>
      <MapView
        style={StyleSheet.absoluteFill}
        initialRegion={region}
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}
        liteMode={Platform.OS === 'android'}
        pointerEvents="none"
      >
        <Marker
          coordinate={{ latitude: spot.latitude, longitude: spot.longitude }}
          pinColor={ORANGE}
          tracksViewChanges={false}
        />
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
    backgroundColor: 'rgba(17,35,55,0.9)',
  },
});
