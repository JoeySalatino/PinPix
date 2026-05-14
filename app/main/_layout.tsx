// ============================================================
// main/_layout.tsx — Bottom tabs: Map, Feed, Profile
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { BRAND } from '../../constants/brand';
import { appScreenBackground } from '../../constants/theme';
import { useTheme } from '../../utils/theme-context';

const { navy: NAVY, orange: ORANGE } = BRAND;

export default function MainTabsLayout() {
  const { isDark } = useTheme();
  const tabBg = appScreenBackground(isDark);
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ORANGE,
        tabBarInactiveTintColor: 'rgba(231,219,203,0.55)',
        tabBarStyle: {
          backgroundColor: tabBg,
          borderTopWidth: 1,
          borderTopColor: 'rgba(231,219,203,0.12)',
        },
        tabBarLabelStyle: { fontWeight: '700', fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Map',
          tabBarIcon: ({ color, size }) => <Ionicons name="map" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="friends"
        options={{
          title: 'Feed',
          tabBarIcon: ({ color, size }) => <Ionicons name="images" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
