// ============================================================
// social.tsx — Follow hub (home)
// ------------------------------------------------------------
// Follow requests, shortcuts to followers / following lists, feed & saves.
// Activity feed: main → Feed tab. Full lists: /followers, /following.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '../constants/brand';
import { appScreenBackground } from '../constants/theme';
import { auth, db } from '../utils/firebase';
import { captureError } from '../utils/sentry';
import {
  acceptFollowRequest,
  declineFollowRequest,
  ensureFollowingMigrated,
  subscribeIncomingFollowRequests,
} from '../utils/social';
import { useTheme } from '../utils/theme-context';

const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function SocialScreen() {
  const router = useRouter();
  const { focus: focusParam } = useLocalSearchParams<{ focus?: string }>();
  const { isDark } = useTheme();
  const bg = appScreenBackground(isDark);

  const [incomingFrom, setIncomingFrom] = useState<string[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const [requestsSectionOffsetY, setRequestsSectionOffsetY] = useState(0);

  useEffect(() => {
    let incomingUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user) => {
      incomingUnsub?.();
      incomingUnsub = null;

      if (!user) {
        setIncomingFrom([]);
        return;
      }

      void ensureFollowingMigrated(user.uid);

      incomingUnsub = subscribeIncomingFollowRequests(
        user.uid,
        setIncomingFrom,
        (err) => captureError(err, { area: 'SocialScreen.incomingFollowRequests' })
      );
    });

    return () => {
      authUnsub();
      incomingUnsub?.();
    };
  }, []);

  useEffect(() => {
    if (incomingFrom.length === 0) setRequestsSectionOffsetY(0);
  }, [incomingFrom.length]);

  useEffect(() => {
    if (focusParam !== 'requests') return;
    const y = Math.max(0, requestsSectionOffsetY - 8);
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y, animated: true });
      });
    });
    return () => cancelAnimationFrame(id);
  }, [focusParam, requestsSectionOffsetY, incomingFrom.length]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: bg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={28} color={CREAM} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Follow</Text>
        <View style={{ width: 28 }} />
      </View>

      <TouchableOpacity
        style={styles.navLink}
        onPress={() => router.push('/main/friends')}
        activeOpacity={0.75}
      >
        <Ionicons name="images-outline" size={20} color={ORANGE} />
        <Text style={styles.navLinkText}>Following feed</Text>
        <Ionicons name="chevron-forward" size={18} color={CREAM_DARK} />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.navLink}
        onPress={() => router.push('/favorites')}
        activeOpacity={0.75}
      >
        <Ionicons name="bookmark-outline" size={20} color={ORANGE} />
        <Text style={styles.navLinkText}>Saved spots (map)</Text>
        <Ionicons name="chevron-forward" size={18} color={CREAM_DARK} />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.navLink}
        onPress={() => router.push('/followers')}
        activeOpacity={0.75}
      >
        <Ionicons name="people-outline" size={20} color={ORANGE} />
        <Text style={styles.navLinkText}>Followers</Text>
        <Ionicons name="chevron-forward" size={18} color={CREAM_DARK} />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.navLink}
        onPress={() => router.push('/following')}
        activeOpacity={0.75}
      >
        <Ionicons name="person-add-outline" size={20} color={ORANGE} />
        <Text style={styles.navLinkText}>Following</Text>
        <Ionicons name="chevron-forward" size={18} color={CREAM_DARK} />
      </TouchableOpacity>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scrollPad}
        keyboardShouldPersistTaps="handled"
      >
        {incomingFrom.length > 0 ? (
          <View
            onLayout={(e) => {
              setRequestsSectionOffsetY(e.nativeEvent.layout.y);
            }}
          >
            <Text style={styles.sectionLabel}>Requests for you</Text>
            {incomingFrom.map((fromUid) => (
              <IncomingRow
                key={fromUid}
                fromUid={fromUid}
                onAccepted={() => {
                  void (async () => {
                    const r = await acceptFollowRequest(fromUid);
                    if (!r.ok) Alert.alert('Follow', r.error);
                  })();
                }}
                onDeclined={() => void declineFollowRequest(fromUid)}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function IncomingRow({
  fromUid,
  onAccepted,
  onDeclined,
}: {
  fromUid: string;
  onAccepted: () => void;
  onDeclined: () => void;
}) {
  const [name, setName] = useState('…');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await getDoc(doc(db, 'users', fromUid));
        if (cancelled || !s.exists()) return;
        const d = s.data();
        setName((d.displayUsername || d.username || 'user') as string);
      } catch {
        if (!cancelled) setName('User');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fromUid]);

  return (
    <View style={styles.incomingCard}>
      <Text style={styles.incomingText}>
        <Text style={{ fontWeight: '800', color: CREAM }}>@{name}</Text> wants to follow you
      </Text>
      <View style={styles.incomingActions}>
        <TouchableOpacity style={styles.acceptBtn} onPress={onAccepted}>
          <Text style={styles.acceptBtnText}>Accept</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.declineBtn} onPress={onDeclined}>
          <Text style={styles.declineBtnText}>Decline</Text>
        </TouchableOpacity>
      </View>
    </View>
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
  navLink: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.3)',
    gap: 10,
  },
  navLinkText: { flex: 1, color: CREAM, fontSize: 14, fontWeight: '700' },
  scrollPad: { padding: 16, paddingBottom: 40 },
  sectionLabel: {
    color: CREAM_DARK,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 8,
    marginTop: 12,
  },
  incomingCard: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.35)',
  },
  incomingText: { color: CREAM_DARK, fontSize: 15, marginBottom: 10 },
  incomingActions: { flexDirection: 'row', gap: 10 },
  acceptBtn: {
    flex: 1,
    backgroundColor: ORANGE,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  acceptBtnText: { color: CREAM, fontWeight: '800' },
  declineBtn: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  declineBtnText: { color: CREAM, fontWeight: '700' },
});
