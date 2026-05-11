import NetInfo from '@react-native-community/netinfo';
import { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text } from 'react-native';

export default function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(false);
  const translateY = useRef(new Animated.Value(-60)).current;

  useEffect(() => {
    const unsub = NetInfo.addEventListener(state => {
      const offline = !state.isConnected;
      setIsOffline(offline);

      Animated.timing(translateY, {
        toValue: offline ? 0 : -60,
        duration: 300,
        useNativeDriver: true,
      }).start();
    });

    return unsub;
  }, [translateY]);

  if (!isOffline) return null;

  return (
    <Animated.View style={[styles.banner, { transform: [{ translateY }] }]}>
      <Text style={styles.text}>⚠ No internet connection</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: '#FF3B30',
    paddingVertical: 10,
    alignItems: 'center',
    zIndex: 999,
  },
  text: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
