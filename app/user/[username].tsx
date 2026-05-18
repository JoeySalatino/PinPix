// ============================================================
// user/[username].tsx — Public user profile
// ------------------------------------------------------------
// Read-only view of another user's profile:
//   - Avatar, displayUsername
//   - Total spot count (hidden for private accounts until you follow)
//   - 3-column grid of their spots
//
// Private accounts (`profileVisible === false`) show a limited view until you follow.
//
// Looks up the user by lowercase username (the indexed field).
// If the username belongs to the current user, redirect to the
// editable /main/profile tab instead so they get full controls.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ProfileSpotGridTile from '../../components/ProfileSpotGridTile';
import SpotPeek from '../../components/SpotPeek';
import { Spot } from '../../components/types';
import { BRAND } from '../../constants/brand';
import { appScreenBackground } from '../../constants/theme';
import { auth, db } from '../../utils/firebase';
import {
  acceptFollowRequest,
  blockedUserIdsList,
  cancelOutgoingFollowRequest,
  declineFollowRequest,
  followRequestDocId,
  followUser,
  followerUidList,
  followingUidList,
  unfollow,
} from '../../utils/social';
import { navigateToSpotOnMap } from '../../utils/open-spot-on-map';
import { captureError } from '../../utils/sentry';
import { useTheme } from '../../utils/theme-context';

const { width } = Dimensions.get('window');
const TILE_SIZE = (width - 4) / 3;
const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

export default function PublicUserProfileScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const screenBg = appScreenBackground(isDark);
  const { username: routeUsername } = useLocalSearchParams<{ username: string }>();

  // ---- Loaded user data ----
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [profileOwnerPrivate, setProfileOwnerPrivate] = useState(false);
  const [profileUid, setProfileUid] = useState<string | null>(null);
  const [displayUsername, setDisplayUsername] = useState('');
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [profileEmail, setProfileEmail] = useState<string | null>(null);
  const [showEmailOnProfile, setShowEmailOnProfile] = useState(false);

  // ---- Spots state ----
  const [userSpots, setUserSpots] = useState<Spot[]>([]);
  const [selectedSpot, setSelectedSpot] = useState<Spot | null>(null);
  /** Current viewer's blocked UIDs (from users/{viewerUid}). */
  const [viewerBlockedIds, setViewerBlockedIds] = useState<string[]>([]);
  /** Viewer following UIDs (for relationship UI). */
  const [viewerFollowingUids, setViewerFollowingUids] = useState<string[]>([]);
  const [outgoingRequestPending, setOutgoingRequestPending] = useState(false);
  const [incomingRequestPending, setIncomingRequestPending] = useState(false);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);

  const profileBlockedByViewer = useMemo(
    () =>
      !!profileUid &&
      !!auth.currentUser &&
      viewerBlockedIds.includes(profileUid),
    [profileUid, viewerBlockedIds]
  );

  // ============================================================
  // LOOK UP THE USER BY USERNAME (one-shot)
  // We only need to translate the URL slug to a UID once — username
  // is an immutable lowercase field. After we have the UID, we attach
  // a live listener (next effect) for the actual profile data.
  // ============================================================
  useEffect(() => {
    let cancelled = false;

    const lookup = async () => {
      if (!routeUsername) {
        setNotFound(true);
        setLoading(false);
        return;
      }

      setNotFound(false);
      setProfileOwnerPrivate(false);

      const usernameLower = routeUsername.toLowerCase();

      // Short-circuit: if the username matches the current user, send them
      // to their own editable profile screen.
      const currentUser = auth.currentUser;
      if (currentUser) {
        const meSnap = await getDoc(doc(db, 'users', currentUser.uid));
        if (meSnap.exists() && meSnap.data().username === usernameLower) {
          router.replace('/main/profile');
          return;
        }
      }

      try {
        const q = query(
          collection(db, 'users'),
          where('username', '==', usernameLower)
        );
        const snap = await getDocs(q);
        if (cancelled) return;

        if (snap.empty) {
          setNotFound(true);
          setLoading(false);
          return;
        }

        // Just capture the UID — the live listener below handles the rest.
        setProfileUid(snap.docs[0].id);
      } catch (err) {
        captureError(err, { area: 'PublicUserProfileScreen.lookup' });
        if (!cancelled) {
          setNotFound(true);
          setLoading(false);
        }
      }
    };

    lookup();
    return () => {
      cancelled = true;
    };
  }, [routeUsername, router]);

  // ============================================================
  // LIVE PROFILE DATA (REAL-TIME)
  // Listens to the viewed user's document so changes to username,
  // avatar, privacy, etc. show up immediately.
  // ============================================================
  useEffect(() => {
    if (!profileUid) return;
    const unsub = onSnapshot(doc(db, 'users', profileUid), (snap) => {
      if (!snap.exists()) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      const data = snap.data();
      setProfileOwnerPrivate(data.profileVisible === false);
      setDisplayUsername(data.displayUsername || data.username || '');
      setProfileImage(data.profileImage || null);
      setProfileEmail(data.email || null);
      setShowEmailOnProfile(!!data.showEmailOnProfile);
      const rec = data as Record<string, unknown>;
      setFollowerCount(followerUidList(rec).length);
      setFollowingCount(followingUidList(rec).length);
      setLoading(false);
    });
    return unsub;
  }, [profileUid]);

  // ============================================================
  // VIEWER'S OWN DOC (REAL-TIME)
  // Drives the block list (used to redirect this profile to the "blocked" placeholder).
  // ============================================================
  useEffect(() => {
    let userDocUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        if (userDocUnsub) {
          userDocUnsub();
          userDocUnsub = null;
        }
        userDocUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
          if (snap.exists()) {
            const data = snap.data();
            setViewerBlockedIds(blockedUserIdsList(data as Record<string, unknown>));
            setViewerFollowingUids(followingUidList(data as Record<string, unknown>));
          } else {
            setViewerBlockedIds([]);
            setViewerFollowingUids([]);
          }
        });
      } else {
        if (userDocUnsub) {
          userDocUnsub();
          userDocUnsub = null;
        }
        setViewerBlockedIds([]);
        setViewerFollowingUids([]);
      }
    });

    return () => {
      authUnsub();
      if (userDocUnsub) userDocUnsub();
    };
  }, []);

  // Follow request docs between viewer and this profile (real-time).
  useEffect(() => {
    const me = auth.currentUser?.uid;
    if (!me || !profileUid || me === profileUid) {
      setOutgoingRequestPending(false);
      setIncomingRequestPending(false);
      return;
    }
    const outId = followRequestDocId(me, profileUid);
    const inId = followRequestDocId(profileUid, me);
    const unsubOut = onSnapshot(doc(db, 'friendRequests', outId), (s) => {
      setOutgoingRequestPending(s.exists() && s.data()?.status === 'pending');
    });
    const unsubIn = onSnapshot(doc(db, 'friendRequests', inId), (s) => {
      setIncomingRequestPending(s.exists() && s.data()?.status === 'pending');
    });
    return () => {
      unsubOut();
      unsubIn();
    };
  }, [profileUid]);

  // ============================================================
  // LOAD THE USER'S SPOTS (REAL-TIME)
  // ============================================================
  useEffect(() => {
    if (!profileUid || profileBlockedByViewer) {
      if (profileBlockedByViewer) setUserSpots([]);
      return;
    }
    const viewerFollows =
      !!auth.currentUser?.uid && profileUid ? viewerFollowingUids.includes(profileUid) : false;
    if (profileOwnerPrivate && !viewerFollows) {
      setUserSpots([]);
      return;
    }
    const q = query(collection(db, 'spots'), where('userId', '==', profileUid));
    const unsub = onSnapshot(q, (snap) => {
      const loaded: Spot[] = [];
      snap.forEach((d) => {
        const data = d.data();
        if (!data.location) return;
        const rawUrls = data.imageUrls;
        const imageUrls = Array.isArray(rawUrls)
          ? rawUrls.filter((u: unknown): u is string => typeof u === 'string' && u.trim().length > 0)
          : undefined;
        loaded.push({
          id: d.id,
          latitude: data.location.latitude,
          longitude: data.location.longitude,
          imageUrl: data.imageUrl || '',
          ...(imageUrls && imageUrls.length > 0 ? { imageUrls } : {}),
          title: data.title || '',
          caption: data.caption || '',
          address: data.address || '',
          username: data.displayUsername || data.username || '',
          userId: data.userId || '',
          tags: data.tags || [],
        });
      });
      setUserSpots(loaded.reverse());
    });
    return unsub;
  }, [profileUid, profileBlockedByViewer, profileOwnerPrivate, viewerFollowingUids]);

  const meUid = auth.currentUser?.uid;
  const isFollowing = !!(profileUid && meUid && viewerFollowingUids.includes(profileUid));

  const handleFollowFromProfile = async () => {
    if (!profileUid || !meUid) return;
    try {
      const r = await followUser(profileUid);
      if (!r.ok) Alert.alert('Follow', r.error);
      else Alert.alert('Follow', profileOwnerPrivate ? 'Follow request sent.' : 'You are now following this account.');
    } catch (e) {
      captureError(e, { area: 'PublicUserProfile.followUser' });
      Alert.alert('Error', 'Could not follow.');
    }
  };

  const handleAcceptIncomingFollow = async () => {
    if (!profileUid) return;
    try {
      const r = await acceptFollowRequest(profileUid);
      if (!r.ok) Alert.alert('Follow', r.error);
    } catch (e) {
      captureError(e, { area: 'PublicUserProfile.acceptFollow' });
      Alert.alert('Error', 'Could not accept request.');
    }
  };

  const handleDeclineIncomingFollow = async () => {
    if (!profileUid) return;
    try {
      await declineFollowRequest(profileUid);
    } catch (e) {
      captureError(e, { area: 'PublicUserProfile.declineFollow' });
    }
  };

  const handleCancelOutgoingFollow = async () => {
    if (!profileUid) return;
    try {
      await cancelOutgoingFollowRequest(profileUid);
    } catch (e) {
      captureError(e, { area: 'PublicUserProfile.cancelFollowRequest' });
    }
  };

  const handleUnfollow = () => {
    if (!profileUid) return;
    Alert.alert('Unfollow', `Stop following @${displayUsername}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Unfollow',
        style: 'destructive',
        onPress: async () => {
          try {
            await unfollow(profileUid);
          } catch (e) {
            captureError(e, { area: 'PublicUserProfile.unfollow', profileUid });
            Alert.alert('Error', 'Could not unfollow.');
          }
        },
      },
    ]);
  };

  // ============================================================
  const handleReport = (spot: Spot) => {
    const user = auth.currentUser;
    if (!user) return;
    Alert.alert('Report Spot', 'Why are you reporting this spot?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Inappropriate Content',
        onPress: () => submitReport(spot, 'Inappropriate Content'),
      },
      { text: 'Spam', onPress: () => submitReport(spot, 'Spam') },
      { text: 'Wrong Location', onPress: () => submitReport(spot, 'Wrong Location') },
    ]);
  };

  const submitReport = async (spot: Spot, reason: string) => {
    const user = auth.currentUser;
    if (!user) return;
    try {
      await addDoc(collection(db, 'reports'), {
        spotId: spot.id,
        spotTitle: spot.title,
        reportedBy: user.uid,
        reason,
        createdAt: new Date().toISOString(),
      });
      Alert.alert('Reported', 'Thank you. We will review this shortly.');
    } catch (err) {
      captureError(err, { area: 'PublicUserProfileScreen.submitReport' });
      Alert.alert('Error', 'Could not submit report.');
    }
  };

  const handleBlockFromSpot = (spot: Spot) => {
    const user = auth.currentUser;
    if (!user || !spot.userId || spot.userId === user.uid) return;
    Alert.alert(
      'Block this user?',
      'You will no longer see their spots on the map or their profile. You can unblock in Settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            try {
              await updateDoc(doc(db, 'users', user.uid), {
                blockedUserIds: arrayUnion(spot.userId),
              });
              setViewerBlockedIds((prev) => Array.from(new Set([...prev, spot.userId])));
              setSelectedSpot(null);
              Alert.alert('Blocked', 'This user is now blocked.');
            } catch (err) {
              captureError(err, { area: 'PublicUserProfileScreen.blockUser', blockedUid: spot.userId });
              Alert.alert('Error', 'Could not block this user.');
            }
          },
        },
      ]
    );
  };

  const unblockThisProfile = async () => {
    const user = auth.currentUser;
    if (!user || !profileUid) return;
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        blockedUserIds: arrayRemove(profileUid),
      });
      setViewerBlockedIds((prev) => prev.filter((id) => id !== profileUid));
    } catch (err) {
      captureError(err, { area: 'PublicUserProfileScreen.unblock', profileUid });
      Alert.alert('Error', 'Could not unblock. Try again.');
    }
  };

  // ============================================================
  // OPEN DIRECTIONS
  // ============================================================
  const openDirections = (spot: Spot) => {
    const url = Platform.select({
      ios: `maps:0,0?q=${spot.latitude},${spot.longitude}`,
      android: `geo:0,0?q=${spot.latitude},${spot.longitude}`,
    });
    if (url) Linking.openURL(url);
  };

  const viewOnMap = (spot: Spot) => {
    setSelectedSpot(null);
    navigateToSpotOnMap(router, spot);
  };

  // ============================================================
  // TAG TAP — route to home with that tag pre-applied
  // We pass it through the URL as a search param.
  // ============================================================
  const handleTagPress = (tag: string) => {
    setSelectedSpot(null);
    router.push({ pathname: '/main', params: { tag } });
  };

  // ============================================================
  // RENDER
  // ============================================================
  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: screenBg }]}>
        <ActivityIndicator color={ORANGE} />
      </View>
    );
  }

  const viewerFollows =
    !!meUid && !!profileUid ? viewerFollowingUids.includes(profileUid) : false;
  const showPrivateGate = profileOwnerPrivate && !viewerFollows && !profileBlockedByViewer;
  const profileSlug = (routeUsername || '').toLowerCase();
  const openFollowers = () => {
    if (!profileSlug) return;
    router.push(`/user/${profileSlug}/followers`);
  };
  const openFollowing = () => {
    if (!profileSlug) return;
    router.push(`/user/${profileSlug}/following`);
  };

  if (notFound) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={28} color={CREAM} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Not Found</Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.center}>
          <Ionicons name="person-remove-outline" size={56} color={CREAM_DARK} />
          <Text style={styles.notFoundTitle}>User not found</Text>
          <Text style={styles.notFoundSub}>
            We couldn&apos;t find a profile for @{routeUsername}.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (profileBlockedByViewer) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={28} color={CREAM} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Profile</Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.center}>
          <Ionicons name="ban-outline" size={56} color={CREAM_DARK} />
          <Text style={styles.notFoundTitle}>You blocked this user</Text>
          <Text style={styles.notFoundSub}>
            @{displayUsername}&apos;s spots are hidden from your map. Unblock to see their profile again.
          </Text>
          <TouchableOpacity
            style={styles.unblockButton}
            onPress={() => {
              void unblockThisProfile();
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.unblockButtonText}>Unblock</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (showPrivateGate && !meUid) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={28} color={CREAM} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Profile</Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={56} color={CREAM_DARK} />
          <Text style={styles.notFoundTitle}>This profile is private</Text>
          <Text style={styles.notFoundSub}>
            Sign in to request to follow @{displayUsername || routeUsername}.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (showPrivateGate && meUid) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={28} color={CREAM} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>
            @{displayUsername}
          </Text>
          <View style={{ width: 28 }} />
        </View>
        <View style={styles.profileSection}>
          {profileImage ? (
            <Image source={{ uri: profileImage }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Ionicons name="person" size={40} color={CREAM_DARK} />
            </View>
          )}
          <Text style={styles.username}>@{displayUsername}</Text>
          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Text style={styles.statNumber}>{userSpots.length}</Text>
              <Text style={styles.statLabel}>pins</Text>
            </View>
            <View style={styles.statDivider} />
            <TouchableOpacity
              style={styles.stat}
              onPress={openFollowers}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8 }}
            >
              <Text style={styles.statNumber}>{followerCount}</Text>
              <Text style={[styles.statLabel, styles.statLabelLink]}>followers</Text>
            </TouchableOpacity>
            <View style={styles.statDivider} />
            <TouchableOpacity
              style={styles.stat}
              onPress={openFollowing}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8 }}
            >
              <Text style={styles.statNumber}>{followingCount}</Text>
              <Text style={[styles.statLabel, styles.statLabelLink]}>following</Text>
            </TouchableOpacity>
          </View>
          <Text style={[styles.notFoundSub, { marginTop: 12, paddingHorizontal: 28 }]}>
            This account is private. Send a follow request to see their spots once they accept.
          </Text>
          {profileUid && meUid !== profileUid ? (
            <View style={[styles.friendBar, { marginTop: 8 }]}>
              {isFollowing ? (
                <View style={styles.friendMutualRow}>
                  <View style={styles.friendPill}>
                    <Ionicons name="checkmark-circle" size={18} color={CREAM} />
                    <Text style={styles.friendPillText}>Following</Text>
                  </View>
                  <TouchableOpacity onPress={() => void handleUnfollow()} hitSlop={10}>
                    <Text style={styles.removeFriendText}>Unfollow</Text>
                  </TouchableOpacity>
                </View>
              ) : incomingRequestPending ? (
                <View style={{ width: '100%', alignItems: 'center' }}>
                  <Text style={styles.friendHint}>Follow request</Text>
                  <View style={styles.friendBtnRow}>
                    <TouchableOpacity style={styles.acceptFriendBtn} onPress={() => void handleAcceptIncomingFollow()}>
                      <Text style={styles.acceptFriendBtnText}>Accept</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.declineFriendBtn} onPress={() => void handleDeclineIncomingFollow()}>
                      <Text style={styles.declineFriendBtnText}>Decline</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : outgoingRequestPending ? (
                <View style={styles.friendBtnRow}>
                  <Text style={styles.friendPending}>Request sent</Text>
                  <TouchableOpacity onPress={() => void handleCancelOutgoingFollow()}>
                    <Text style={styles.cancelReqText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.addFriendBtn} onPress={() => void handleFollowFromProfile()}>
                  <Ionicons name="person-add-outline" size={18} color={CREAM} style={{ marginRight: 6 }} />
                  <Text style={styles.addFriendBtnText}>Follow</Text>
                </TouchableOpacity>
              )}
            </View>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={28} color={CREAM} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          @{displayUsername}
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.profileSection}>
        {profileImage ? (
          <Image source={{ uri: profileImage }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]}>
            <Ionicons name="person" size={40} color={CREAM_DARK} />
          </View>
        )}
        <Text style={styles.username}>@{displayUsername}</Text>
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statNumber}>{userSpots.length}</Text>
            <Text style={styles.statLabel}>pins</Text>
          </View>
          <View style={styles.statDivider} />
          <TouchableOpacity
            style={styles.stat}
            onPress={openFollowers}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8 }}
          >
            <Text style={styles.statNumber}>{followerCount}</Text>
            <Text style={[styles.statLabel, styles.statLabelLink]}>followers</Text>
          </TouchableOpacity>
          <View style={styles.statDivider} />
          <TouchableOpacity
            style={styles.stat}
            onPress={openFollowing}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8 }}
          >
            <Text style={styles.statNumber}>{followingCount}</Text>
            <Text style={[styles.statLabel, styles.statLabelLink]}>following</Text>
          </TouchableOpacity>
        </View>
        {showEmailOnProfile && profileEmail ? (
          <Text style={styles.publicEmail}>{profileEmail}</Text>
        ) : null}
        {meUid && profileUid && meUid !== profileUid && !profileBlockedByViewer ? (
          <View style={styles.friendBar}>
            {isFollowing ? (
              <View style={styles.friendMutualRow}>
                <View style={styles.friendPill}>
                  <Ionicons name="checkmark-circle" size={18} color={CREAM} />
                  <Text style={styles.friendPillText}>Following</Text>
                </View>
                <TouchableOpacity onPress={() => void handleUnfollow()} hitSlop={10}>
                  <Text style={styles.removeFriendText}>Unfollow</Text>
                </TouchableOpacity>
              </View>
            ) : incomingRequestPending ? (
              <View style={{ width: '100%', alignItems: 'center' }}>
                <Text style={styles.friendHint}>Follow request</Text>
                <View style={styles.friendBtnRow}>
                  <TouchableOpacity style={styles.acceptFriendBtn} onPress={() => void handleAcceptIncomingFollow()}>
                    <Text style={styles.acceptFriendBtnText}>Accept</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.declineFriendBtn} onPress={() => void handleDeclineIncomingFollow()}>
                    <Text style={styles.declineFriendBtnText}>Decline</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : outgoingRequestPending ? (
              <View style={styles.friendBtnRow}>
                <Text style={styles.friendPending}>Request sent</Text>
                <TouchableOpacity onPress={() => void handleCancelOutgoingFollow()}>
                  <Text style={styles.cancelReqText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={styles.addFriendBtn} onPress={() => void handleFollowFromProfile()}>
                <Ionicons name="person-add-outline" size={18} color={CREAM} style={{ marginRight: 6 }} />
                <Text style={styles.addFriendBtnText}>Follow</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : null}
      </View>

      <View style={styles.divider} />

      {userSpots.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Ionicons name="camera-outline" size={36} color={CREAM_DARK} />
          <Text style={styles.emptyTitle}>No spots yet</Text>
          <Text style={styles.emptySub}>
            @{displayUsername} hasn&apos;t posted any spots yet.
          </Text>
        </View>
      ) : (
        <FlatList
          data={userSpots}
          keyExtractor={(item) => item.id}
          numColumns={3}
          contentContainerStyle={{ gap: 2 }}
          columnWrapperStyle={{ gap: 2 }}
          renderItem={({ item }) => (
            <ProfileSpotGridTile
              spot={item}
              size={TILE_SIZE}
              onPress={() => setSelectedSpot(item)}
            />
          )}
        />
      )}

      {selectedSpot && (
        <SpotPeek
          peekContext="profile"
          spots={[selectedSpot]}
          onClose={() => setSelectedSpot(null)}
          openDirections={openDirections}
          onViewOnMap={viewOnMap}
          isDark={isDark}
          currentUserId={auth.currentUser?.uid || ''}
          // The viewer is never the owner of these spots (own-profile redirects
          // to /main/profile above), so onDelete is a no-op.
          onDelete={() => undefined}
          onReport={handleReport}
          onBlock={handleBlockFromSpot}
          onTagPress={handleTagPress}
          // Hide the @username link inside SpotPeek when already viewing
          // that user's profile — would just re-open this page.
          showUsernameLink={false}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: CREAM,
    letterSpacing: 0.3,
    maxWidth: '60%',
  },
  profileSection: { alignItems: 'center', paddingVertical: 24 },
  avatar: { width: 96, height: 96, borderRadius: 48, borderWidth: 3, borderColor: ORANGE },
  avatarPlaceholder: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  username: { fontSize: 20, fontWeight: '800', color: CREAM, marginTop: 12, letterSpacing: 0.3 },
  publicEmail: { fontSize: 13, color: CREAM_DARK, marginTop: 6 },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
    paddingHorizontal: 8,
  },
  stat: { alignItems: 'center', minWidth: 84, paddingVertical: 2 },
  statDivider: { width: 1, height: 34, backgroundColor: 'rgba(231,219,203,0.18)' },
  statNumber: { fontSize: 20, fontWeight: '900', color: CREAM },
  statLabel: {
    fontSize: 12,
    color: CREAM_DARK,
    marginTop: 3,
    fontWeight: '600',
    textTransform: 'lowercase',
  },
  statLabelLink: { color: CREAM },
  friendBar: { marginTop: 16, width: '100%', paddingHorizontal: 20, alignItems: 'center' },
  friendPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(227,92,37,0.2)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.45)',
  },
  friendMutualRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    flexWrap: 'wrap',
  },
  removeFriendText: { color: CREAM_DARK, fontWeight: '800', fontSize: 14, textDecorationLine: 'underline' },
  friendPillText: { color: CREAM, fontWeight: '800', fontSize: 14 },
  friendHint: { color: CREAM_DARK, fontSize: 13, marginBottom: 8 },
  friendBtnRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  acceptFriendBtn: {
    backgroundColor: ORANGE,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
  },
  acceptFriendBtnText: { color: CREAM, fontWeight: '800', fontSize: 14 },
  declineFriendBtn: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
  },
  declineFriendBtnText: { color: CREAM, fontWeight: '700', fontSize: 14 },
  friendPending: { color: CREAM_DARK, fontSize: 14, fontWeight: '600' },
  cancelReqText: { color: ORANGE, fontWeight: '800', fontSize: 14 },
  addFriendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.2)',
  },
  addFriendBtnText: { color: CREAM, fontWeight: '800', fontSize: 15 },
  divider: { height: 1, backgroundColor: 'rgba(231,219,203,0.12)', marginBottom: 4 },
  emptyWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: CREAM, marginTop: 12, marginBottom: 6 },
  emptySub: { fontSize: 14, color: CREAM_DARK, textAlign: 'center', lineHeight: 20 },
  notFoundTitle: { fontSize: 22, fontWeight: '800', color: CREAM, marginTop: 16, marginBottom: 8 },
  notFoundSub: { fontSize: 14, color: CREAM_DARK, textAlign: 'center', paddingHorizontal: 32 },
  unblockButton: {
    marginTop: 24,
    backgroundColor: ORANGE,
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 14,
  },
  unblockButtonText: { color: CREAM, fontWeight: '800', fontSize: 15 },
});
