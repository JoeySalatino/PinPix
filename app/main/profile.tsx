// ============================================================
// main/profile.tsx — Own profile (bottom tab)
// ------------------------------------------------------------
// Same content as legacy /profile, without a back button.
// Stats: pins (spot count), followers, following (Instagram-style).
// Contact sync: Sync contacts → one horizontal strip (contacts, then suggested). Hide collapses the whole strip; pull to refresh.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { onAuthStateChanged } from 'firebase/auth';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  where,
} from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  LayoutAnimation,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  UIManager,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import SpotPeek from '../../components/SpotPeek';
import { Spot, spotGalleryUrls } from '../../components/types';
import { BRAND } from '../../constants/brand';
import { appScreenBackground } from '../../constants/theme';
import { auth, db } from '../../utils/firebase';
import {
  findPinpixUsersForContactLookups,
  loadContactIdentifiersFromDevice,
  normalizeContactEmail,
  partitionContactMatches,
  type ContactMatchedUser,
} from '../../utils/contact-follow-discovery';
import { fetchDiscoverProfileSuggestions } from '../../utils/profile-discover-suggestions';
import { captureError } from '../../utils/sentry';
import { deleteStorageObjectsByUrls } from '../../utils/storage-delete';
import { ensureFollowingMigrated, followerUidList, followingUidList, followUser } from '../../utils/social';
import { useTheme } from '../../utils/theme-context';

const { width } = Dimensions.get('window');
const TILE_SIZE = (width - 4) / 3;
const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK } = BRAND;

const CONTACTS_CACHE_KEY = (uid: string) => `pinpix_profile_contact_peek_${uid}`;
/** When set, hides the whole people strip (contacts + suggested), not only discover. */
const PEEK_SUGGESTIONS_HIDDEN_KEY = (uid: string) => `pinpix_profile_hide_discover_peek_${uid}`;

type ProfilePeekItem = ContactMatchedUser & { followsYou?: boolean };

export default function MainProfileTabScreen() {
  const router = useRouter();
  const { isDark } = useTheme();
  const screenBg = appScreenBackground(isDark);

  const [username, setUsername] = useState('');
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);

  const [mySpots, setMySpots] = useState<Spot[]>([]);
  const [selectedSpot, setSelectedSpot] = useState<Spot | null>(null);

  const [meUid, setMeUid] = useState<string | null>(null);
  const [followerUids, setFollowerUids] = useState<string[]>([]);
  const [followingUids, setFollowingUids] = useState<string[]>([]);
  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
  const [myEmailNorm, setMyEmailNorm] = useState<string | null>(null);
  const [myPhoneE164, setMyPhoneE164] = useState<string | null>(null);

  const [contactMatched, setContactMatched] = useState<ContactMatchedUser[]>([]);
  /** Non-contact suggestions (recent public profiles). */
  const [discoverMatched, setDiscoverMatched] = useState<ContactMatchedUser[]>([]);
  /** True after we restored cache or finished a sync (even with zero matches). */
  const [contactsHasRun, setContactsHasRun] = useState(false);
  const [contactSyncBusy, setContactSyncBusy] = useState(false);
  const lastSilentContactSyncAt = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  /** Collapses the whole people strip (contacts + suggested); persisted per account. */
  const [peoplePeekHidden, setPeoplePeekHidden] = useState(false);

  useEffect(() => {
    let userDocUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        setMeUid(user.uid);
        void ensureFollowingMigrated(user.uid);
        void (async () => {
          try {
            const raw = await AsyncStorage.getItem(CONTACTS_CACHE_KEY(user.uid));
            if (raw) {
              const j = JSON.parse(raw) as { matches?: unknown };
              if (Array.isArray(j.matches)) {
                if (j.matches.length > 0) {
                  const parsed: ContactMatchedUser[] = j.matches
                    .filter(
                      (m: unknown): m is Record<string, unknown> =>
                        !!m &&
                        typeof m === 'object' &&
                        typeof (m as Record<string, unknown>).uid === 'string' &&
                        typeof (m as Record<string, unknown>).usernameSlug === 'string' &&
                        typeof (m as Record<string, unknown>).displayUsername === 'string'
                    )
                    .map((m) => ({
                      uid: m.uid as string,
                      email: typeof m.email === 'string' ? m.email : '',
                      contactMatchPhoneE164:
                        typeof m.contactMatchPhoneE164 === 'string' ? m.contactMatchPhoneE164 : null,
                      displayUsername: m.displayUsername as string,
                      usernameSlug: m.usernameSlug as string,
                    }));
                  setContactMatched(parsed);
                  setContactsHasRun(true);
                  lastSilentContactSyncAt.current = Date.now();
                } else {
                  setContactMatched([]);
                  setContactsHasRun(true);
                  lastSilentContactSyncAt.current = Date.now();
                }
              }
            }
          } catch (e) {
            captureError(e, { area: 'MainProfileTabScreen.loadContactCache' });
          }
        })();
        userDocUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
          if (snap.exists()) {
            const data = snap.data() as Record<string, unknown>;
            setUsername((data.displayUsername || data.username || '') as string);
            setProfileImage((data.profileImage as string | null) || null);
            const fList = followerUidList(data);
            const foList = followingUidList(data);
            setFollowerUids(fList);
            setFollowingUids(foList);
            setFollowerCount(fList.length);
            setFollowingCount(foList.length);
            setBlockedUserIds((data.blockedUserIds as string[] | undefined) || []);
            const docEmail = normalizeContactEmail((data.email as string | undefined) || '');
            setMyEmailNorm(docEmail || normalizeContactEmail(user.email || ''));
            const p = data.contactMatchPhoneE164;
            setMyPhoneE164(typeof p === 'string' && p.startsWith('+') ? p : null);
          }
          setLoading(false);
        });
      } else {
        setMeUid(null);
        setFollowerUids([]);
        setFollowingUids([]);
        setBlockedUserIds([]);
        setMyEmailNorm(null);
        setMyPhoneE164(null);
        setContactMatched([]);
        setDiscoverMatched([]);
        setPeoplePeekHidden(false);
        setContactsHasRun(false);
        if (userDocUnsub) {
          userDocUnsub();
          userDocUnsub = null;
        }
        setUsername('');
        setProfileImage(null);
        setFollowerCount(0);
        setFollowingCount(0);
        setLoading(false);
      }
    });

    return () => {
      authUnsub();
      if (userDocUnsub) userDocUnsub();
    };
  }, []);

  useEffect(() => {
    let spotsUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (user: import('firebase/auth').User | null) => {
      if (user) {
        const q = query(collection(db, 'spots'), where('userId', '==', user.uid));
        spotsUnsub = onSnapshot(q, (snap) => {
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
          setMySpots(loaded.reverse());
        });
      } else {
        if (spotsUnsub) {
          spotsUnsub();
          spotsUnsub = null;
        }
      }
    });

    return () => {
      authUnsub();
      if (spotsUnsub) spotsUnsub();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  const handleDelete = async (spot: Spot) => {
    Alert.alert('Delete Spot', 'Are you sure? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteStorageObjectsByUrls(spotGalleryUrls(spot));
            await deleteDoc(doc(db, 'spots', spot.id));
            setSelectedSpot(null);
            Alert.alert('Deleted', 'Your spot has been removed.');
          } catch {
            Alert.alert('Error', 'Could not delete spot.');
          }
        },
      },
    ]);
  };

  const handleReport = async (spot: Spot) => {
    const user = auth.currentUser;
    if (!user) return;
    Alert.alert('Report Spot', 'Why are you reporting this spot?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Inappropriate Content', onPress: () => submitReport(spot, 'Inappropriate Content') },
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
    } catch {
      Alert.alert('Error', 'Could not submit report.');
    }
  };

  const openDirections = (spot: Spot) => {
    const url = Platform.select({
      ios: `maps:0,0?q=${spot.latitude},${spot.longitude}`,
      android: `geo:0,0?q=${spot.latitude},${spot.longitude}`,
    });
    if (url) Linking.openURL(url);
  };

  const { followersInContacts, suggestedToFollow } = useMemo(() => {
    if (!meUid) return { followersInContacts: [], suggestedToFollow: [] };
    return partitionContactMatches({
      matched: contactMatched,
      myUid: meUid,
      myEmailNormalized: myEmailNorm,
      myPhoneE164,
      followerUids,
      followingUids,
      blockedUserIds,
    });
  }, [contactMatched, meUid, myEmailNorm, myPhoneE164, followerUids, followingUids, blockedUserIds]);

  const contactPeekRows = useMemo((): ProfilePeekItem[] => {
    const rows: ProfilePeekItem[] = [];
    const seen = new Set<string>();
    for (const u of followersInContacts) {
      if (followingUids.includes(u.uid)) continue;
      if (seen.has(u.uid)) continue;
      seen.add(u.uid);
      rows.push({ ...u, followsYou: true });
    }
    for (const u of suggestedToFollow) {
      if (seen.has(u.uid)) continue;
      seen.add(u.uid);
      rows.push({ ...u, followsYou: false });
    }
    return rows;
  }, [followersInContacts, suggestedToFollow, followingUids]);

  const discoverPeekRows = useMemo((): ProfilePeekItem[] => {
    return discoverMatched.filter((u) => !followingUids.includes(u.uid));
  }, [discoverMatched, followingUids]);

  const anyPeekRows = contactPeekRows.length > 0 || discoverPeekRows.length > 0;
  const showPeoplePeekScroll = !peoplePeekHidden && anyPeekRows;
  const showDiscoverInPeekStrip = !peoplePeekHidden && discoverPeekRows.length > 0;
  const peekBarVisible = anyPeekRows;

  const spotGridRows = useMemo(() => {
    const rows: Spot[][] = [];
    for (let i = 0; i < mySpots.length; i += 3) rows.push(mySpots.slice(i, i + 3));
    return rows;
  }, [mySpots]);

  const runContactSync = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    const uid = auth.currentUser?.uid;
    if (!uid) {
      if (!silent) Alert.alert('Sign in', 'Sign in to sync contacts.');
      return;
    }
    if (Platform.OS === 'web') {
      if (!silent) Alert.alert('Not available on web', 'Open PinPix on your phone to sync contacts.');
      return;
    }
    if (!silent) setContactSyncBusy(true);
    try {
      const loaded = await loadContactIdentifiersFromDevice();
      if (!loaded.ok) {
        if (!silent) {
          if (loaded.reason === 'denied') {
            Alert.alert('Contacts', 'Allow contacts access in system settings to find people you know.');
          } else {
            Alert.alert('Not supported', 'Contact sync is only available on the iOS and Android app.');
          }
        }
        return;
      }
      if (loaded.emails.length === 0 && loaded.phones.length === 0) {
        if (!silent) {
          Alert.alert(
            'No contacts to match',
            'None of your contacts have email or phone entries we can read. Try again after adding details to a contact.'
          );
        }
        return;
      }
      const users = await findPinpixUsersForContactLookups(loaded.emails, loaded.phones);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setContactMatched(users);
      setContactsHasRun(true);
      lastSilentContactSyncAt.current = Date.now();
      await AsyncStorage.setItem(CONTACTS_CACHE_KEY(uid), JSON.stringify({ matches: users }));
      if (!silent && users.length === 0) {
        Alert.alert('No matches yet', 'None of your contacts match a PinPix account yet.');
      }
    } catch (e) {
      captureError(e, { area: 'MainProfileTabScreen.contactSync' });
      if (!silent) Alert.alert('Error', 'Could not sync contacts. Check your connection and try again.');
    } finally {
      if (!silent) setContactSyncBusy(false);
    }
  }, []);

  const refetchDiscoverSuggestions = useCallback(async () => {
    if (!meUid) return;
    try {
      const exclude = new Set<string>([meUid, ...contactMatched.map((c) => c.uid)]);
      const rows = await fetchDiscoverProfileSuggestions({
        myUid: meUid,
        followingUids,
        blockedUserIds,
        excludeUids: exclude,
        maxResults: 16,
      });
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setDiscoverMatched(rows);
    } catch (e) {
      captureError(e, { area: 'MainProfileTabScreen.discoverFetch' });
    }
  }, [meUid, followingUids, blockedUserIds, contactMatched]);

  useEffect(() => {
    if (!meUid) {
      setPeoplePeekHidden(false);
      return;
    }
    void (async () => {
      try {
        const v = await AsyncStorage.getItem(PEEK_SUGGESTIONS_HIDDEN_KEY(meUid));
        setPeoplePeekHidden(v === '1');
      } catch (e) {
        captureError(e, { area: 'MainProfileTabScreen.loadPeekSuggestionsHidden' });
      }
    })();
  }, [meUid]);

  const hidePeoplePeek = useCallback(async () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setPeoplePeekHidden(true);
    if (meUid) {
      try {
        await AsyncStorage.setItem(PEEK_SUGGESTIONS_HIDDEN_KEY(meUid), '1');
      } catch (e) {
        captureError(e, { area: 'MainProfileTabScreen.persistPeekSuggestionsHidden' });
      }
    }
  }, [meUid]);

  const showPeoplePeek = useCallback(async () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setPeoplePeekHidden(false);
    if (meUid) {
      try {
        await AsyncStorage.removeItem(PEEK_SUGGESTIONS_HIDDEN_KEY(meUid));
      } catch (e) {
        captureError(e, { area: 'MainProfileTabScreen.clearPeekSuggestionsHidden' });
      }
    }
  }, [meUid]);

  useEffect(() => {
    void refetchDiscoverSuggestions();
  }, [refetchDiscoverSuggestions]);

  useFocusEffect(
    useCallback(() => {
      if (!contactsHasRun || Platform.OS === 'web' || !meUid) return undefined;
      const now = Date.now();
      if (now - lastSilentContactSyncAt.current < 45_000) return undefined;
      void runContactSync({ silent: true });
      return undefined;
    }, [contactsHasRun, meUid, runContactSync])
  );

  const onPullRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (meUid && Platform.OS !== 'web') {
        await runContactSync({ silent: true });
      }
      if (meUid) {
        await refetchDiscoverSuggestions();
      }
    } finally {
      setRefreshing(false);
    }
  }, [meUid, runContactSync, refetchDiscoverSuggestions]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: screenBg }]}>
        <ActivityIndicator color={ORANGE} />
      </View>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }} edges={['top']}>
      <View style={styles.header}>
        <View style={{ width: 28 }} />
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <TouchableOpacity onPress={() => router.push('/favorites')} hitSlop={8}>
            <Ionicons name="bookmark-outline" size={24} color={CREAM} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/settings')} hitSlop={8}>
            <Ionicons name="settings-outline" size={24} color={CREAM} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.profileScroll}
        contentContainerStyle={styles.profileScrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onPullRefresh()}
            tintColor={ORANGE}
            colors={Platform.OS === 'android' ? [ORANGE] : undefined}
          />
        }
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.profileSection}>
          {profileImage ? (
            <Image source={{ uri: profileImage }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Ionicons name="person" size={40} color={CREAM_DARK} />
            </View>
          )}
          <Text style={styles.username}>@{username}</Text>
          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Text style={styles.statNumber}>{mySpots.length}</Text>
              <Text style={styles.statLabel}>pins</Text>
            </View>
            <View style={styles.statDivider} />
            <TouchableOpacity
              style={styles.stat}
              onPress={() => router.push('/followers')}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8 }}
            >
              <Text style={styles.statNumber}>{followerCount}</Text>
              <Text style={[styles.statLabel, styles.statLabelLink]}>followers</Text>
            </TouchableOpacity>
            <View style={styles.statDivider} />
            <TouchableOpacity
              style={styles.stat}
              onPress={() => router.push('/following')}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8 }}
            >
              <Text style={styles.statNumber}>{followingCount}</Text>
              <Text style={[styles.statLabel, styles.statLabelLink]}>following</Text>
            </TouchableOpacity>
          </View>

          {!contactsHasRun ? (
            <View style={styles.friendDiscoveryIntro}>
              {Platform.OS === 'web' ? (
                <Text style={styles.friendDiscoveryHint}>
                  Contact-based suggestions run on the iOS and Android app. You can still add a mobile number in
                  Settings (Friend discovery) so friends can match you when they use PinPix on a phone.
                </Text>
              ) : (
                <>
                  <TouchableOpacity
                    style={styles.syncContactsBtnSubtle}
                    onPress={() => void runContactSync()}
                    disabled={contactSyncBusy}
                    activeOpacity={0.75}
                  >
                    {contactSyncBusy ? (
                      <ActivityIndicator color={ORANGE} size="small" />
                    ) : (
                      <>
                        <Ionicons name="sync-outline" size={16} color={CREAM_DARK} />
                        <Text style={styles.syncContactsBtnSubtleText}>Sync contacts</Text>
                      </>
                    )}
                  </TouchableOpacity>
                  <Text style={styles.friendDiscoveryHint}>
                    Finds PinPix accounts that share an email or phone with people in your address book. Suggested
                    profiles may appear here too when others have public profiles.
                  </Text>
                  <TouchableOpacity
                    style={styles.friendDiscoverySettingsLink}
                    onPress={() => router.push('/settings')}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    accessibilityLabel="Open settings to add mobile number for contact matching"
                  >
                    <Ionicons name="settings-outline" size={16} color={ORANGE} />
                    <Text style={styles.friendDiscoverySettingsLinkText}>
                      Add your mobile in Settings (Friend discovery)
                    </Text>
                    <Ionicons name="chevron-forward" size={16} color={CREAM_DARK} />
                  </TouchableOpacity>
                </>
              )}
            </View>
          ) : (
            <View style={styles.contactPeekSection}>
              {peekBarVisible ? (
                peoplePeekHidden ? (
                  <TouchableOpacity
                    style={styles.peekStripShowButton}
                    onPress={() => void showPeoplePeek()}
                    activeOpacity={0.75}
                    accessibilityRole="button"
                    accessibilityLabel="Show contact and suggested profiles"
                  >
                    <Ionicons name="chevron-down" size={18} color={ORANGE} />
                    <Text style={styles.peekStripShowButtonText}>Show suggestions</Text>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.peekStripBar}>
                    <View style={styles.peekStripBarSpacer} />
                    <TouchableOpacity
                      onPress={() => void hidePeoplePeek()}
                      hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
                      accessibilityRole="button"
                      accessibilityLabel="Hide contact and suggested profiles"
                    >
                      <Text style={styles.peekStripBarAction}>Hide suggestions</Text>
                    </TouchableOpacity>
                  </View>
                )
              ) : null}
              {showPeoplePeekScroll ? (
                <>
                  <ScrollView
                    horizontal
                    nestedScrollEnabled
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.contactPeekScrollContent}
                  >
                    {contactPeekRows.map((u) => (
                      <View key={u.uid} style={styles.contactPeekCard}>
                        <TouchableOpacity
                          style={styles.contactPeekCardMain}
                          onPress={() => router.push(`/user/${u.usernameSlug}`)}
                          activeOpacity={0.8}
                        >
                          <View style={styles.contactPeekAvatar}>
                            <Ionicons name="person" size={28} color={CREAM_DARK} />
                          </View>
                          <Text style={styles.contactPeekBadgeMuted} numberOfLines={1}>
                            {u.followsYou ? 'Follows you' : 'From contacts'}
                          </Text>
                          <Text style={styles.contactPeekName} numberOfLines={2}>
                            @{u.displayUsername}
                          </Text>
                        </TouchableOpacity>
                        {!followingUids.includes(u.uid) ? (
                          <TouchableOpacity
                            style={styles.contactPeekFollow}
                            onPress={async () => {
                              try {
                                const r = await followUser(u.uid);
                                if (!r.ok) Alert.alert('Follow', r.error);
                              } catch (err) {
                                captureError(err, { area: 'MainProfileTabScreen.followFromPeek', uid: u.uid });
                                Alert.alert('Error', 'Could not follow. Try again.');
                              }
                            }}
                          >
                            <Text style={styles.contactPeekFollowText}>Follow</Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    ))}
                    {showDiscoverInPeekStrip && contactPeekRows.length > 0 ? (
                      <View style={styles.peekStripSeparator} />
                    ) : null}
                    {showDiscoverInPeekStrip
                      ? discoverPeekRows.map((u) => (
                          <View key={`d-${u.uid}`} style={styles.contactPeekCard}>
                            <TouchableOpacity
                              style={styles.contactPeekCardMain}
                              onPress={() => router.push(`/user/${u.usernameSlug}`)}
                              activeOpacity={0.8}
                            >
                              <View style={styles.contactPeekAvatar}>
                                <Ionicons name="person" size={28} color={CREAM_DARK} />
                              </View>
                              <Text style={styles.contactPeekBadgeMuted} numberOfLines={1}>
                                For you
                              </Text>
                              <Text style={styles.contactPeekName} numberOfLines={2}>
                                @{u.displayUsername}
                              </Text>
                            </TouchableOpacity>
                            {!followingUids.includes(u.uid) ? (
                              <TouchableOpacity
                                style={styles.contactPeekFollow}
                                onPress={async () => {
                                  try {
                                    const r = await followUser(u.uid);
                                    if (!r.ok) Alert.alert('Follow', r.error);
                                  } catch (err) {
                                    captureError(err, {
                                      area: 'MainProfileTabScreen.followFromDiscover',
                                      uid: u.uid,
                                    });
                                    Alert.alert('Error', 'Could not follow. Try again.');
                                  }
                                }}
                              >
                                <Text style={styles.contactPeekFollowText}>Follow</Text>
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        ))
                      : null}
                  </ScrollView>
                </>
              ) : peoplePeekHidden && anyPeekRows ? null : (
                <View style={styles.contactPeekEmptyWrap}>
                  <Text style={styles.contactPeekEmpty}>
                    No matches or suggestions to show yet. That can mean no overlap with your contacts, few public
                    profiles to recommend, or everyone here is already someone you follow.
                  </Text>
                  {Platform.OS !== 'web' ? (
                    <TouchableOpacity
                      style={styles.friendDiscoverySettingsLink}
                      onPress={() => router.push('/settings')}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel="Open settings friend discovery section"
                    >
                      <Ionicons name="settings-outline" size={16} color={ORANGE} />
                      <Text style={styles.friendDiscoverySettingsLinkText}>
                        Add mobile in Settings (Friend discovery)
                      </Text>
                      <Ionicons name="chevron-forward" size={16} color={CREAM_DARK} />
                    </TouchableOpacity>
                  ) : null}
                  <Text style={styles.contactPeekEmptySecondary}>Pull down to refresh this list.</Text>
                </View>
              )}
            </View>
          )}

        </View>

        <View style={styles.divider} />

        <Text style={styles.postsSectionTitle}>Posts</Text>
        {mySpots.length === 0 ? (
          <View style={styles.emptyWrap}>
            <View style={styles.emptyIconCircle}>
              <Ionicons name="camera-outline" size={40} color={ORANGE} />
            </View>
            <Text style={styles.emptyTitle}>No spots yet</Text>
            <Text style={styles.emptySub}>Tap the + button on the map to add your first spot</Text>
            <TouchableOpacity style={styles.addButton} onPress={() => router.push('/add-spot')}>
              <Ionicons name="add-circle-outline" size={18} color={CREAM} style={{ marginRight: 6 }} />
              <Text style={styles.addButtonText}>Add a Spot</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.spotGrid}>
            {spotGridRows.map((row, rowIndex) => (
              <View key={`spot-row-${rowIndex}`} style={styles.spotGridRow}>
                {row.map((item) => {
                  const hasImage = item.imageUrl && item.imageUrl.trim() !== '';
                  return (
                    <TouchableOpacity
                      key={item.id}
                      style={[styles.tile, { width: TILE_SIZE, height: TILE_SIZE }]}
                      onPress={() => setSelectedSpot(item)}
                      activeOpacity={0.8}
                    >
                      {hasImage ? (
                        <Image source={{ uri: item.imageUrl }} style={styles.tileImage} />
                      ) : (
                        <View style={[styles.tileImage, styles.tilePlaceholder]}>
                          <Ionicons name="image-outline" size={24} color={CREAM_DARK} />
                        </View>
                      )}
                      {!!item.title && (
                        <View style={styles.tileOverlay}>
                          <Text style={styles.tileTitle} numberOfLines={1}>
                            {item.title}
                          </Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {selectedSpot && (
        <SpotPeek
          spots={[selectedSpot]}
          onClose={() => setSelectedSpot(null)}
          openDirections={openDirections}
          isDark={isDark}
          currentUserId={auth.currentUser?.uid || ''}
          onDelete={handleDelete}
          onEdit={(spot) => {
            setSelectedSpot(null);
            router.push(`/edit-spot/${spot.id}`);
          }}
          onReport={handleReport}
          onTagPress={(tag) => {
            setSelectedSpot(null);
            router.push({ pathname: '/main', params: { tag } });
          }}
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
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerTitle: { fontSize: 18, fontWeight: '800', color: CREAM, letterSpacing: 0.3 },
  profileSection: { alignItems: 'center', paddingVertical: 20 },
  avatar: { width: 96, height: 96, borderRadius: 48, borderWidth: 3, borderColor: ORANGE },
  avatarPlaceholder: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  username: { fontSize: 20, fontWeight: '800', color: CREAM, marginTop: 12, letterSpacing: 0.3 },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 18,
    paddingHorizontal: 12,
    gap: 0,
  },
  stat: { alignItems: 'center', minWidth: 88, paddingVertical: 4 },
  statDivider: { width: 1, height: 36, backgroundColor: 'rgba(231,219,203,0.18)' },
  statNumber: { fontSize: 20, fontWeight: '900', color: CREAM },
  statLabel: { fontSize: 12, color: CREAM_DARK, marginTop: 3, fontWeight: '600', textTransform: 'lowercase' },
  statLabelLink: { color: CREAM },
  friendDiscoveryIntro: {
    alignSelf: 'stretch',
    marginTop: 10,
    paddingHorizontal: 16,
  },
  friendDiscoveryHint: {
    marginTop: 12,
    fontSize: 13,
    color: CREAM_DARK,
    textAlign: 'center',
    lineHeight: 19,
  },
  friendDiscoverySettingsLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.35)',
    backgroundColor: 'rgba(227,92,37,0.08)',
  },
  friendDiscoverySettingsLinkText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: CREAM,
  },
  syncContactsBtnSubtle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    alignSelf: 'center',
    marginTop: 4,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minHeight: 36,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.22)',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  syncContactsBtnSubtleText: { fontSize: 13, fontWeight: '600', color: CREAM_DARK },
  contactPeekSection: {
    alignSelf: 'stretch',
    marginTop: 12,
    paddingBottom: 2,
  },
  peekStripSeparator: {
    width: StyleSheet.hairlineWidth,
    height: 128,
    alignSelf: 'center',
    backgroundColor: 'rgba(231,219,203,0.2)',
    marginRight: 10,
  },
  peekStripBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 14,
    paddingBottom: 6,
    minHeight: 28,
  },
  peekStripShowButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    marginHorizontal: 16,
    marginTop: 2,
    marginBottom: 4,
    paddingVertical: 11,
    paddingHorizontal: 18,
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.18)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  peekStripShowButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: CREAM,
    letterSpacing: 0.2,
  },
  peekStripBarSpacer: { flex: 1 },
  peekStripBarAction: {
    fontSize: 13,
    fontWeight: '600',
    color: CREAM,
    opacity: 0.72,
  },
  contactPeekScrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  contactPeekCard: {
    width: 112,
    marginRight: 10,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.35)',
    overflow: 'hidden',
  },
  contactPeekCardMain: {
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 6,
    alignItems: 'center',
  },
  contactPeekAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 6,
  },
  contactPeekBadgeMuted: {
    fontSize: 10,
    fontWeight: '800',
    color: CREAM_DARK,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  contactPeekName: {
    fontSize: 12,
    fontWeight: '700',
    color: CREAM,
    textAlign: 'center',
    lineHeight: 15,
    minHeight: 30,
  },
  contactPeekFollow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(231,219,203,0.15)',
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: 'rgba(227,92,37,0.15)',
  },
  contactPeekFollowText: { fontSize: 12, fontWeight: '800', color: CREAM },
  contactPeekEmptyWrap: {
    marginHorizontal: 12,
    marginTop: 4,
    alignItems: 'center',
  },
  contactPeekEmpty: {
    fontSize: 13,
    color: CREAM_DARK,
    textAlign: 'center',
    lineHeight: 18,
  },
  contactPeekEmptySecondary: {
    marginTop: 10,
    fontSize: 12,
    color: CREAM_DARK,
    opacity: 0.85,
    textAlign: 'center',
  },
  divider: { height: 1, backgroundColor: 'rgba(231,219,203,0.12)', marginBottom: 4 },
  profileScroll: { flex: 1 },
  profileScrollContent: {
    flexGrow: 1,
    paddingBottom: 40,
  },
  postsSectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: CREAM_DARK,
    letterSpacing: 0.75,
    textTransform: 'uppercase',
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 10,
  },
  spotGrid: { paddingHorizontal: 2, paddingBottom: 8 },
  spotGridRow: {
    flexDirection: 'row',
    gap: 2,
    marginBottom: 2,
    justifyContent: 'flex-start',
  },
  emptyWrap: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    paddingVertical: 48,
    minHeight: 320,
  },
  emptyIconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(227,92,37,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(227,92,37,0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: CREAM, marginBottom: 8 },
  emptySub: { fontSize: 14, color: CREAM_DARK, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ORANGE,
    paddingHorizontal: 24,
    paddingVertical: 13,
    borderRadius: 12,
    shadowColor: ORANGE,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  addButtonText: { color: CREAM, fontWeight: '800', fontSize: 15 },
  tile: { overflow: 'hidden' },
  tileImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  tilePlaceholder: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tileOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(17,35,55,0.7)',
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  tileTitle: { color: CREAM, fontSize: 11, fontWeight: '600' },
});
