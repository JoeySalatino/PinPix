// ============================================================
// OnboardingScreen.tsx — First-Time User Walkthrough
// ------------------------------------------------------------
// Shown once after a user logs in for the first time.
// Uses AsyncStorage to remember that they've seen it.
//
// AsyncStorage is basically a key-value store that persists
// data on the device even after the app is closed. Think of
// it like localStorage in web development.
//
// The slides are a horizontal FlatList with pagingEnabled,
// which means it snaps to each full-width slide automatically.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '../constants/brand';
import { appScreenBackground } from '../constants/theme';
import { clearDeferredSpotId, peekDeferredSpotId } from '../utils/deferred-spot-link';
import { useTheme } from '../utils/theme-context';

const { width } = Dimensions.get('window');

const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

// ---- Slide data ----
// Each slide has an icon name (from Ionicons), title, and subtitle
const SLIDES = [
  {
    id: '1',
    icon: 'map' as const,
    title: 'Discover Spots',
    subtitle:
      'Browse a map of photo locations, filter by tags, and tap pins to preview spots before you go.',
  },
  {
    id: '2',
    icon: 'camera' as const,
    title: 'Share Your Finds',
    subtitle:
      'Add a spot with several photos at once, pick tags, and pin the location — owners can edit anytime from their profile.',
  },
  {
    id: '3',
    icon: 'heart' as const,
    title: 'Save & Navigate',
    subtitle:
      'Bookmark favorites (gold pins on the map), share a spot link, or jump to directions in one tap.',
  },
  {
    id: '4',
    icon: 'people' as const,
    title: 'Friends',
    subtitle:
      'Send friend requests by username, manage requests in Friends, and scroll your friends’ latest spots on the Friends tab.',
  },
];

export default function OnboardingScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const screenBg = appScreenBackground(isDark);

  // Track which slide the user is currently on (0-indexed)
  const [currentIndex, setCurrentIndex] = useState(0);

  // useRef gives us a direct reference to the FlatList so we can
  // programmatically scroll it when the user taps "Next"
  const flatListRef = useRef<FlatList>(null);

  // ============================================================
  // HANDLE NEXT BUTTON
  // Either scrolls to next slide, or finishes onboarding
  // ============================================================
  const handleNext = () => {
    if (currentIndex < SLIDES.length - 1) {
      // Scroll to the next slide
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1 });
      setCurrentIndex(prev => prev + 1);
    } else {
      // Last slide — finish onboarding
      finishOnboarding();
    }
  };

  // ============================================================
  // FINISH ONBOARDING
  // Save a flag to AsyncStorage so we never show this again,
  // then navigate to the main map screen
  // ============================================================
  const finishOnboarding = async () => {
    await AsyncStorage.setItem('onboarding_complete', 'true');
    const deferred = await peekDeferredSpotId();
    if (deferred) {
      await clearDeferredSpotId();
      router.replace({ pathname: '/main', params: { spotId: deferred } });
    } else {
      router.replace('/main');
    }
  };

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: screenBg }]}>

      {/* ---- Skip button (top right) ---- */}
      <TouchableOpacity style={styles.skipButton} onPress={finishOnboarding}>
        <Text style={styles.skipText}>Skip</Text>
      </TouchableOpacity>

      {/* ---- Slides ---- */}
      {/* scrollEnabled={false} prevents manual swiping — we control it programmatically */}
      <FlatList
        ref={flatListRef}
        data={SLIDES}
        horizontal
        pagingEnabled
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <View style={[styles.slide, { width }]}>
            {/* Icon circle */}
            <View style={styles.iconCircle}>
              <Ionicons name={item.icon} size={64} color={ORANGE} />
            </View>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.subtitle}>{item.subtitle}</Text>
          </View>
        )}
      />

      {/* ---- Progress dots ---- */}
      {/* The active dot is wider and orange, inactive dots are small and dim */}
      <View style={styles.dotsRow}>
        {SLIDES.map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                backgroundColor: i === currentIndex ? ORANGE : 'rgba(231,219,203,0.3)',
                width: i === currentIndex ? 24 : 8, // Active dot is wider
              },
            ]}
          />
        ))}
      </View>

      {/* ---- Next / Get Started button ---- */}
      <TouchableOpacity style={styles.button} onPress={handleNext}>
        <Text style={styles.buttonText}>
          {currentIndex === SLIDES.length - 1 ? 'Get Started' : 'Next'}
        </Text>
        <Ionicons
          name={currentIndex === SLIDES.length - 1 ? 'checkmark' : 'arrow-forward'}
          size={20}
          color={CREAM}
          style={{ marginLeft: 8 }}
        />
      </TouchableOpacity>

    </SafeAreaView>
  );
}

// ============================================================
// STYLES
// ============================================================
const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center' },
  skipButton: { alignSelf: 'flex-end', padding: 16 },
  skipText: { color: CREAM_DARK, fontSize: 15 },
  slide: {
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 40, paddingBottom: 40,
  },
  iconCircle: {
    width: 140, height: 140, borderRadius: 70,
    backgroundColor: 'rgba(227,92,37,0.15)',
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 40,
    borderWidth: 1.5, borderColor: 'rgba(227,92,37,0.3)',
  },
  title: { fontSize: 28, fontWeight: '900', color: CREAM, textAlign: 'center', marginBottom: 16, letterSpacing: 0.3 },
  subtitle: { fontSize: 16, color: CREAM_DARK, textAlign: 'center', lineHeight: 24 },
  dotsRow: { flexDirection: 'row', gap: 6, marginBottom: 32, alignItems: 'center' },
  dot: { height: 8, borderRadius: 4 },
  button: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: ORANGE,
    paddingHorizontal: 40, paddingVertical: 16,
    borderRadius: 16, marginBottom: 20,
    shadowColor: ORANGE, shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  buttonText: { color: CREAM, fontSize: 17, fontWeight: '800' },
});