// ============================================================
// followers.tsx — People who follow you (searchable)
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
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
import { ensureFollowingMigrated, followerUidList } from '../utils/social';
import { resolveFollowPersonRows, type FollowPersonRow } from '../utils/follow-list-people';
import { useTheme } from '../utils/theme-context';

const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function FollowersScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const bg = appScreenBackground(isDark);

  const [followerUids, setFollowerUids] = useState<string[]>([]);
  const [rows, setRows] = useState<FollowPersonRow[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    const authUnsub = onAuthStateChanged(auth, (user) => {
      unsub?.();
      unsub = null;
      if (!user) {
        setFollowerUids([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      void ensureFollowingMigrated(user.uid);
      unsub = onSnapshot(
        doc(db, 'users', user.uid),
        (snap) => {
          const d = snap.data() as Record<string, unknown> | undefined;
          setFollowerUids(followerUidList(d));
          setLoading(false);
        },
        (err) => {
          captureError(err, { area: 'FollowersScreen.usersDoc' });
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
    if (followerUids.length === 0) {
      setRows([]);
      return;
    }
    setRows(await resolveFollowPersonRows(followerUids));
  }, [followerUids]);

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

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: bg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="arrow-back" size={28} color={CREAM} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Followers</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollPad}
        keyboardShouldPersistTaps="handled"
      >
        {rows.length > 0 ? (
          <TextInput
            style={styles.searchInput}
            placeholder="Search followers"
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
            When people follow you, they show up here. Share your profile or spots from the map.
          </Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>No follower matches that search.</Text>
        ) : (
          filtered.map((f) => (
            <View key={f.uid} style={styles.row}>
              <TouchableOpacity
                style={[styles.rowMain, { paddingRight: 12 }]}
                onPress={() => router.push(`/user/${f.usernameSlug}`)}
                activeOpacity={0.75}
              >
                <Ionicons name="person-circle-outline" size={36} color={CREAM_DARK} />
                <Text style={styles.name}>@{f.displayUsername}</Text>
                <Ionicons name="chevron-forward" size={20} color={CREAM_DARK} />
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
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  name: { flex: 1, color: CREAM, fontSize: 16, fontWeight: '700' },
  empty: { color: CREAM_DARK, fontSize: 14, lineHeight: 20, marginTop: 8 },
});
