// ============================================================
// UserFollowListScreen — Searchable followers / following for any user
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, doc, getDoc, getDocs, onSnapshot, query, where } from 'firebase/firestore';
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
import { resolveFollowPersonRows, type FollowPersonRow } from '../utils/follow-list-people';
import { captureError } from '../utils/sentry';
import { ensureFollowingMigrated, followerUidList, followingUidList, unfollow } from '../utils/social';
import { useTheme } from '../utils/theme-context';

const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export type UserFollowListKind = 'followers' | 'following';

type Props = {
  usernameSlug: string;
  listKind: UserFollowListKind;
};

export default function UserFollowListScreen({ usernameSlug, listKind }: Props) {
  const router = useRouter();
  const { isDark } = useTheme();
  const bg = appScreenBackground(isDark);

  const [profileUid, setProfileUid] = useState<string | null>(null);
  const [displayUsername, setDisplayUsername] = useState('');
  const [memberUids, setMemberUids] = useState<string[]>([]);
  const [rows, setRows] = useState<FollowPersonRow[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [viewerUid, setViewerUid] = useState<string | null>(null);

  const isOwnProfile = !!(profileUid && viewerUid && profileUid === viewerUid);
  const allowUnfollow = isOwnProfile && listKind === 'following';

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setViewerUid(user?.uid ?? null);
    });
    return unsub;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const lookup = async () => {
      const slug = usernameSlug.trim().toLowerCase();
      if (!slug) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setNotFound(false);
      setLoading(true);

      const currentUser = auth.currentUser;
      if (currentUser) {
        const meSnap = await getDoc(doc(db, 'users', currentUser.uid));
        if (meSnap.exists() && meSnap.data().username === slug) {
          router.replace(listKind === 'followers' ? '/followers' : '/following');
          return;
        }
      }

      try {
        const q = query(collection(db, 'users'), where('username', '==', slug));
        const snap = await getDocs(q);
        if (cancelled) return;

        if (snap.empty) {
          setProfileUid(null);
          setNotFound(true);
          setLoading(false);
          return;
        }

        const uid = snap.docs[0].id;
        setProfileUid(uid);
      } catch (err) {
        captureError(err, { area: 'UserFollowListScreen.lookup', listKind });
        if (!cancelled) {
          setNotFound(true);
          setLoading(false);
        }
      }
    };

    void lookup();
    return () => {
      cancelled = true;
    };
  }, [usernameSlug, listKind, router]);

  useEffect(() => {
    if (!profileUid) return;

    void ensureFollowingMigrated(profileUid);
    const unsub = onSnapshot(
      doc(db, 'users', profileUid),
      (snap) => {
        if (!snap.exists()) {
          setNotFound(true);
          setMemberUids([]);
          setLoading(false);
          return;
        }
        const data = snap.data() as Record<string, unknown>;
        setDisplayUsername((data.displayUsername || data.username || usernameSlug) as string);
        setMemberUids(
          listKind === 'followers' ? followerUidList(data) : followingUidList(data)
        );
        setLoading(false);
      },
      (err) => {
        captureError(err, { area: 'UserFollowListScreen.usersDoc', listKind });
        setLoading(false);
      }
    );
    return unsub;
  }, [profileUid, listKind, usernameSlug]);

  const refreshRows = useCallback(async () => {
    if (memberUids.length === 0) {
      setRows([]);
      return;
    }
    setRows(await resolveFollowPersonRows(memberUids));
  }, [memberUids]);

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

  const headerTitle = useMemo(() => {
    if (listKind === 'followers') {
      return isOwnProfile ? 'Followers' : `${displayUsername || usernameSlug}'s followers`;
    }
    return isOwnProfile ? 'Following' : `${displayUsername || usernameSlug} is following`;
  }, [listKind, isOwnProfile, displayUsername, usernameSlug]);

  const searchPlaceholder = useMemo(() => {
    if (isOwnProfile) {
      return listKind === 'followers' ? 'Search followers' : 'Search people you follow';
    }
    return listKind === 'followers'
      ? `Search @${displayUsername || usernameSlug}'s followers`
      : `Search who @${displayUsername || usernameSlug} follows`;
  }, [isOwnProfile, listKind, displayUsername, usernameSlug]);

  const emptyMessage = useMemo(() => {
    if (isOwnProfile) {
      return listKind === 'followers'
        ? 'When people follow you, they show up here. Share your profile or spots from the map.'
        : 'You are not following anyone yet — discover photographers from the map or their shared links, then follow from their profile.';
    }
    return listKind === 'followers'
      ? `@${displayUsername || usernameSlug} does not have any followers yet.`
      : `@${displayUsername || usernameSlug} is not following anyone yet.`;
  }, [isOwnProfile, listKind, displayUsername, usernameSlug]);

  const noMatchMessage = useMemo(() => {
    if (isOwnProfile) {
      return listKind === 'followers'
        ? 'No follower matches that search.'
        : 'No one in your following list matches that search.';
    }
    return 'No one matches that search.';
  }, [isOwnProfile, listKind]);

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
              captureError(e, { area: 'UserFollowListScreen.unfollow', uid: f.uid });
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
        <Text style={styles.headerTitle} numberOfLines={1}>
          {headerTitle}
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollPad}
        keyboardShouldPersistTaps="handled"
      >
        {rows.length > 0 ? (
          <TextInput
            style={styles.searchInput}
            placeholder={searchPlaceholder}
            placeholderTextColor={CREAM_DARK}
            value={filter}
            onChangeText={setFilter}
            autoCapitalize="none"
            autoCorrect={false}
          />
        ) : null}

        {loading ? (
          <ActivityIndicator color={ORANGE} style={{ marginTop: 24 }} />
        ) : notFound ? (
          <Text style={styles.empty}>We couldn&apos;t find that profile.</Text>
        ) : rows.length === 0 ? (
          <Text style={styles.empty}>{emptyMessage}</Text>
        ) : filtered.length === 0 ? (
          <Text style={styles.empty}>{noMatchMessage}</Text>
        ) : (
          filtered.map((f) => (
            <View key={f.uid} style={styles.row}>
              <TouchableOpacity
                style={[styles.rowMain, !allowUnfollow && { paddingRight: 12 }]}
                onPress={() => router.push(`/user/${f.usernameSlug}`)}
                activeOpacity={0.75}
              >
                <Ionicons name="person-circle-outline" size={36} color={CREAM_DARK} />
                <Text style={styles.name}>@{f.displayUsername}</Text>
                <Ionicons name="chevron-forward" size={20} color={CREAM_DARK} />
              </TouchableOpacity>
              {allowUnfollow ? (
                <TouchableOpacity
                  onPress={() => promptUnfollow(f)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityLabel="Unfollow"
                >
                  <Ionicons name="person-remove-outline" size={22} color={CREAM_DARK} />
                </TouchableOpacity>
              ) : null}
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
    gap: 8,
  },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '800', color: CREAM, textAlign: 'center' },
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
