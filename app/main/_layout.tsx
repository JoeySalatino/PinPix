// ============================================================
// main/_layout.tsx — Bottom tabs: Map + Friends activity feed
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { BRAND } from '../../constants/brand';

const { navy: NAVY, orange: ORANGE } = BRAND;

export default function MainTabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ORANGE,
        tabBarInactiveTintColor: 'rgba(231,219,203,0.55)',
        tabBarStyle: {
          backgroundColor: NAVY,
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
          title: 'Friends',
          tabBarIcon: ({ color, size }) => <Ionicons name="people" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
