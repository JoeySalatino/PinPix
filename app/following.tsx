// ============================================================
// following.tsx — Accounts you follow (searchable, unfollow)
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BRAND } from '../constants/brand';
import { appScreenBackground } from '../constants/theme';
import { auth, db } from '../utils/firebase';
import { captureError } from '../utils/sentry';
import { ensureFollowingMigrated, followingUidList, unfollow } from '../utils/social';
import { resolveFollowPersonRows, type FollowPersonRow } from '../utils/follow-list-people';
import { useTheme } from '../utils/theme-context';

const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function FollowingListScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const bg = appScreenBackground(isDark);

  const [followingUids, setFollowingUids] = useState<string[]>([]);
  const [rows, setRows] = useState<FollowPersonRow[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    const authUnsub = onAuthStateChanged(auth, (user) => {
      unsub?.();
      unsub = null;
      if (!user) {
        setFollowingUids([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      void ensureFollowingMigrated(user.uid);
      unsub = onSnapshot(
        doc(db, 'users', user.uid),
        (snap) => {
          const d = snap.data() as Record<string, unknown> | undefined;
          setFollowingUids(followingUidList(d));
          setLoading(false);
        },
        (err) => {
          captureError(err, { area: 'FollowingListScreen.usersDoc' });
          setLoading(false);
        }
      );
    });
    return () => {
      authUnsub();
      unsub?.();
    };
  }, []);

  const refreshRows = useCallback(async () => {
    if (followingUids.length === 0) {
      setRows([]);
      return;
    }
    setRows(await resolveFollowPersonRows(followingUids));
  }, [followingUids]);

  useEffect(() => {
    void refreshRows();
  }, [refreshRows]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (f) => f.usernameSlug.includes(q) || f.displayUsername.toLowerCase().includes(q)
    );
  }, [rows, filter]);

  const promptUnfollow = (f: FollowPersonRow) => {
    Alert.alert(
      'Unfollow',
      `Stop following @${f.displayUsername}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unfollow',
          style: 'destructive',
          onPress: async () => {
            try {
              await unfollow(f.uid);
            } catch (e) {
              captureError(e, { area: 'FollowingListScreen.unfollow', uid: f.uid });
              Alert.alert('Error', 'Could not unfollow. Try again.');
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: bg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={28} color={CREAM} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Following</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollPad}
        keyboardShouldPersistTaps="handled"
      >
        {rows.length > 0 ? (
          <TextInput
            style={styles.searchInput}
            placeholder="Search people you follow"
            placeholderTextColor={CREAM_DARK}
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
            autoCorrect={false}
          />
        ) : null}

        {loading ? (
          <ActivityIndicator color={ORANGE} style={{ marginTop: 24 }} />
        ) : rows.length === 0 ? (
          <Text style={styles.empty}>
            You are not following anyone yet — discover photographers from the map or their shared links, then follow
            from their profile.
          </Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>No one in your following list matches that search.</Text>
        ) : (
          filtered.map((f) => (
            <View key={f.uid} style={styles.row}>
              <TouchableOpacity
                style={styles.rowMain}
                onPress={() => router.push(`/user/${f.usernameSlug}`)}
                activeOpacity={0.75}
              >
                <Ionicons name="person-circle-outline" size={36} color={CREAM_DARK} />
                <Text style={styles.name}>@{f.displayUsername}</Text>
                <Ionicons name="chevron-forward" size={20} color={CREAM_DARK} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => promptUnfollow(f)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                accessibilityLabel="Unfollow"
              >
                <Ionicons name="person-remove-outline" size={22} color={CREAM_DARK} />
              </TouchableOpacity>
            </View>
          ))
        )}
      </ScrollView>
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
  scrollPad: { padding: 16, paddingBottom: 40 },
  searchInput: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: CREAM,
    fontSize: 16,
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(231,219,203,0.15)',
    gap: 4,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  name: { flex: 1, color: CREAM, fontSize: 16, fontWeight: '700' },
  empty: { color: CREAM_DARK, fontSize: 14, lineHeight: 20, marginTop: 8 },
});
