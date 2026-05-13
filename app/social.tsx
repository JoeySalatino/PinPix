// ============================================================
// social.tsx — Friends hub
// ------------------------------------------------------------
// Friends hub: requests, add by username, list. Activity feed lives on main → Friends tab.
// Saved spots: /favorites (linked below header).
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { auth, db } from '../utils/firebase';
import { captureError } from '../utils/sentry';
import {
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  sendFriendRequest,
  subscribeIncomingFriendRequests,
} from '../utils/social';
import { useTheme } from '../utils/theme-context';

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

type FriendRow = { uid: string; displayUsername: string; usernameSlug: string };

export default function SocialScreen() {
  const router = useRouter();
  const { focus: focusParam } = useLocalSearchParams<{ focus?: string }>();
  const { isDark } = useTheme();
  const bg = isDark ? '#0d1c2b' : NAVY;

  const [uid, setUid] = useState<string | null>(null);
  const [friendUids, setFriendUids] = useState<string[]>([]);
  const [incomingFrom, setIncomingFrom] = useState<string[]>([]);
  const [friendsResolved, setFriendsResolved] = useState<FriendRow[]>([]);
  const [addUsername, setAddUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingFriends, setLoadingFriends] = useState(true);

  const friendsScrollRef = useRef<ScrollView>(null);
  /** Y offset of the "Requests for you" block inside the Friends ScrollView (for push deep link scroll). */
  const [requestsSectionOffsetY, setRequestsSectionOffsetY] = useState(0);

  // Auth + Firestore listeners together (same pattern as ProfileScreen) so
  // listeners tear down immediately on sign-out and avoid snapshot errors.
  useEffect(() => {
    let userDocUnsub: (() => void) | null = null;
    let incomingUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user) => {
      userDocUnsub?.();
      incomingUnsub?.();
      userDocUnsub = null;
      incomingUnsub = null;

      if (!user) {
        setUid(null);
        setFriendUids([]);
        setIncomingFrom([]);
        setLoadingFriends(false);
        return;
      }

      setUid(user.uid);
      setLoadingFriends(true);

      userDocUnsub = onSnapshot(
        doc(db, 'users', user.uid),
        (snap) => {
          const f = (snap.data()?.friends as string[] | undefined) || [];
          setFriendUids(f);
          setLoadingFriends(false);
        },
        (err) => {
          captureError(err, { area: 'SocialScreen.usersDoc' });
          setLoadingFriends(false);
        }
      );

      incomingUnsub = subscribeIncomingFriendRequests(
        user.uid,
        setIncomingFrom,
        (err) => captureError(err, { area: 'SocialScreen.incomingFriendRequests' })
      );
    });

    return () => {
      authUnsub();
      userDocUnsub?.();
      incomingUnsub?.();
    };
  }, []);

  useEffect(() => {
    if (incomingFrom.length === 0) setRequestsSectionOffsetY(0);
  }, [incomingFrom.length]);

  const resolveFriends = useCallback(async () => {
    if (friendUids.length === 0) {
      setFriendsResolved([]);
      return;
    }
    const rows: FriendRow[] = await Promise.all(
      friendUids.map(async (fid) => {
        try {
          const s = await getDoc(doc(db, 'users', fid));
          if (!s.exists())
            return { uid: fid, displayUsername: 'Unknown', usernameSlug: 'unknown' };
          const d = s.data();
          return {
            uid: fid,
            displayUsername: (d.displayUsername || d.username || 'user') as string,
            usernameSlug: ((d.username as string) || (d.displayUsername as string) || 'user').toLowerCase(),
          };
        } catch {
          return { uid: fid, displayUsername: 'Unknown', usernameSlug: 'unknown' };
        }
      })
    );
    setFriendsResolved(rows);
  }, [friendUids]);

  useEffect(() => {
    void resolveFriends();
  }, [resolveFriends]);

  const handleSendRequest = async () => {
    const name = addUsername.trim().toLowerCase();
    if (!name || !uid) return;
    setBusy(true);
    try {
      const q = query(collection(db, 'users'), where('username', '==', name));
      const snap = await getDocs(q);
      if (snap.empty) {
        Alert.alert('Not found', 'No user with that username.');
        setBusy(false);
        return;
      }
      const toUid = snap.docs[0].id;
      if (toUid === uid) {
        Alert.alert('That’s you', 'Enter someone else’s username.');
        setBusy(false);
        return;
      }
      const res = await sendFriendRequest(toUid);
      if (!res.ok) {
        Alert.alert('Can’t send', res.error);
      } else {
        Alert.alert('Sent', 'Friend request sent.');
        setAddUsername('');
      }
    } catch (e) {
      captureError(e, { area: 'SocialScreen.handleSendRequest' });
      Alert.alert('Error', 'Could not send request.');
    } finally {
      setBusy(false);
    }
  };

  // Deep link / push tap: /social?focus=requests — scroll to incoming requests.
  useEffect(() => {
    if (focusParam !== 'requests') return;
    const y = Math.max(0, requestsSectionOffsetY - 8);
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        friendsScrollRef.current?.scrollTo({ y, animated: true });
      });
    });
    return () => cancelAnimationFrame(id);
  }, [focusParam, requestsSectionOffsetY, incomingFrom.length]);

  const promptRemoveFriend = (f: FriendRow) => {
    Alert.alert(
      'Remove friend',
      `Remove @${f.displayUsername} from your friends? They will be removed from your list too.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeFriend(f.uid);
            } catch (e) {
              captureError(e, { area: 'SocialScreen.removeFriend', friendUid: f.uid });
              Alert.alert('Error', 'Could not remove friend. Try again.');
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
        <Text style={styles.headerTitle}>Friends</Text>
        <View style={{ width: 28 }} />
      </View>

      <TouchableOpacity
        style={styles.feedLink}
        onPress={() => router.push('/main/friends')}
        activeOpacity={0.75}
      >
        <Ionicons name="images-outline" size={20} color={ORANGE} />
        <Text style={styles.feedLinkText}>Friends’ spots feed</Text>
        <Ionicons name="chevron-forward" size={18} color={CREAM_DARK} />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.savesLink}
        onPress={() => router.push('/favorites')}
        activeOpacity={0.75}
      >
        <Ionicons name="bookmark-outline" size={20} color={ORANGE} />
        <Text style={styles.savesLinkText}>Saved spots (map)</Text>
        <Ionicons name="chevron-forward" size={18} color={CREAM_DARK} />
      </TouchableOpacity>

      <ScrollView
        ref={friendsScrollRef}
        contentContainerStyle={styles.scrollPad}
        keyboardShouldPersistTaps="handled"
      >
          <Text style={styles.sectionLabel}>Add a friend</Text>
          <View style={styles.addRow}>
            <TextInput
              style={styles.input}
              placeholder="Username (without @)"
              placeholderTextColor={CREAM_DARK}
              value={addUsername}
              onChangeText={setAddUsername}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={[styles.sendBtn, busy && { opacity: 0.6 }]}
              onPress={() => void handleSendRequest()}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={CREAM} size="small" />
              ) : (
                <Text style={styles.sendBtnText}>Send</Text>
              )}
            </TouchableOpacity>
          </View>

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
                      const r = await acceptFriendRequest(fromUid);
                      if (!r.ok) Alert.alert('Friends', r.error);
                    })();
                  }}
                  onDeclined={() => void declineFriendRequest(fromUid)}
                />
              ))}
            </View>
          ) : null}

          <Text style={styles.sectionLabel}>Your friends ({friendsResolved.length})</Text>
          {loadingFriends ? (
            <ActivityIndicator color={ORANGE} style={{ marginTop: 16 }} />
          ) : friendsResolved.length === 0 ? (
            <Text style={styles.empty}>No friends yet — send a request by username above.</Text>
          ) : (
            friendsResolved.map((f) => (
              <View key={f.uid} style={styles.friendRow}>
                <TouchableOpacity
                  style={styles.friendRowMain}
                  onPress={() => router.push(`/user/${f.usernameSlug}`)}
                  activeOpacity={0.75}
                >
                  <Ionicons name="person-circle-outline" size={36} color={CREAM_DARK} />
                  <Text style={styles.friendName}>@{f.displayUsername}</Text>
                  <Ionicons name="chevron-forward" size={20} color={CREAM_DARK} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => promptRemoveFriend(f)}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityLabel="Remove friend"
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
        <Text style={{ fontWeight: '800', color: CREAM }}>@{name}</Text> wants to connect
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
  feedLink: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.35)',
    gap: 10,
  },
  feedLinkText: { flex: 1, color: CREAM, fontSize: 14, fontWeight: '700' },
  savesLink: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.25)',
    gap: 8,
  },
  savesLinkText: { flex: 1, color: CREAM, fontSize: 14, fontWeight: '700' },
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
  addRow: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  input: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: CREAM,
    fontSize: 16,
  },
  sendBtn: {
    backgroundColor: ORANGE,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 12,
    minWidth: 72,
    alignItems: 'center',
  },
  sendBtnText: { color: CREAM, fontWeight: '800', fontSize: 15 },
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
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(231,219,203,0.15)',
    gap: 4,
  },
  friendRowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  friendName: { flex: 1, color: CREAM, fontSize: 16, fontWeight: '700' },
  empty: { color: CREAM_DARK, fontSize: 14, lineHeight: 20, marginTop: 8 },
});
