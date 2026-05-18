// ============================================================
// SettingsScreen.tsx — User Account Settings
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  sendEmailVerification,
  updatePassword,
  verifyBeforeUpdateEmail,
} from 'firebase/auth';
import { collection, doc, getDoc, getDocs, query, updateDoc, where, arrayRemove, deleteField } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { deleteAccount } from '../utils/account';
import { getDeviceCountryCodeForPhone, normalizeToE164 } from '../utils/phone-normalize';
import { BRAND } from '../constants/brand';
import { appScreenBackground } from '../constants/theme';
import { LEGAL } from '../constants/legal';
import { registerAndUploadPushToken, removeAllPushTokens } from '../utils/push-notifications';
import { auth, db, storage } from '../utils/firebase';
import { blockedUserIdsList } from '../utils/social';
import { captureError } from '../utils/sentry';
import { userFacingErrorMessage } from '../utils/user-friendly-error';
import {
  getPrimaryProvider,
  reauthenticateWithApple,
  reauthenticateWithGoogle,
} from '../utils/social-auth';
import { useTheme } from '../utils/theme-context';

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK, danger: DANGER } = BRAND;

/** Native `Switch` with brand orange when on — same system control, custom track only. */
function SettingsSwitch({
  value,
  onValueChange,
  disabled,
}: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const trackOff = 'rgba(231,219,203,0.22)';
  return (
    <View style={styles.switchWrap}>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: trackOff, true: ORANGE }}
        ios_backgroundColor={trackOff}
        thumbColor={Platform.OS === 'android' ? CREAM : undefined}
      />
    </View>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const { isDark, setDarkMode } = useTheme();
  const screenBg = appScreenBackground(isDark);

  const [displayUsername, setDisplayUsername] = useState('');
  const [email, setEmail] = useState('');
  // Which provider this user signed in with — determines whether we can
  // change email/password with a password, or whether we need to reauth
  // with Google / Apple instead.
  const [authProvider, setAuthProvider] = useState<'password' | 'google.com' | 'apple.com' | 'other'>('password');
  const [profileImage, setProfileImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingUsername, setSavingUsername] = useState(false);

  const [emailModalVisible, setEmailModalVisible] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [currentPasswordForEmail, setCurrentPasswordForEmail] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);

  const [passwordModalVisible, setPasswordModalVisible] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  // ---- Email verification state ----
  const [emailVerified, setEmailVerified] = useState<boolean>(!!auth.currentUser?.emailVerified);
  const [resendingVerification, setResendingVerification] = useState(false);

  // ---- Privacy preferences (persisted on the user doc) ----
  // Defaults match the most-private sensible setting:
  //  - profileVisible: true (the app is a community of photographers — your
  //    spots only make sense if your profile is reachable)
  //  - showEmailOnProfile: false (emails shouldn't be public by default)
  const [profileVisible, setProfileVisible] = useState(true);
  const [showEmailOnProfile, setShowEmailOnProfile] = useState(false);

  /** E.164 saved on the user doc for contact / friend discovery (optional). */
  const [contactPhoneDraft, setContactPhoneDraft] = useState('');
  const [savingContactPhone, setSavingContactPhone] = useState(false);

  // ---- Notification preferences (persisted on user doc; Cloud Functions read them) ----
  const [pushEnabled, setPushEnabled] = useState(true);
  const [pushFriendRequests, setPushFriendRequests] = useState(true);
  const [pushNearbySpots, setPushNearbySpots] = useState(true);
  const [pushFavoriteActivity, setPushFavoriteActivity] = useState(true);
  const [pushCommentActivity, setPushCommentActivity] = useState(true);
  /** Weekly digest as push (not email). Legacy `emailDigest` is migrated on load. */
  const [pushWeeklyDigest, setPushWeeklyDigest] = useState(false);

  /** Blocked user UIDs with display labels for the Settings list. */
  const [blockedAccounts, setBlockedAccounts] = useState<{ uid: string; label: string }[]>([]);
  const [unblockingUid, setUnblockingUid] = useState<string | null>(null);

  // ---- Delete account state ----
  const [deleting, setDeleting] = useState(false);

  // ============================================================
  // LOAD USER DATA
  // We always end in setLoading(false) so the screen never gets
  // permanently stuck on the spinner if Firebase hiccups.
  // We also reload() BEFORE reading user.email so that an email
  // change confirmed via the verification link reflects right away.
  // ============================================================
  useEffect(() => {
    let cancelled = false;

    const loadUser = async () => {
      const user = auth.currentUser;
      if (!user) {
        // Unauthenticated — send them back to the login screen instead
        // of trapping them on a perpetual loading spinner.
        if (!cancelled) {
          setLoading(false);
          router.replace('/login');
        }
        return;
      }

      // Pull the freshest auth state first. This picks up email changes
      // that were confirmed by clicking the verification link on another
      // device, and updates emailVerified.
      try {
        await user.reload();
      } catch {
        // Non-fatal — fall through with whatever cached state we have.
      }
      const fresh = auth.currentUser ?? user;

      try {
        const snap = await getDoc(doc(db, 'users', fresh.uid));
        if (!cancelled && snap.exists()) {
          const data = snap.data();
          setDisplayUsername(data.displayUsername || data.username || '');
          setProfileImage(data.profileImage || null);
          setProfileVisible(data.profileVisible ?? true);
          setShowEmailOnProfile(data.showEmailOnProfile ?? false);
          setPushEnabled(data.pushEnabled ?? true);
          setPushFriendRequests(data.pushFriendRequests ?? true);
          setPushNearbySpots(data.pushNearbySpots ?? true);
          setPushFavoriteActivity(data.pushFavoriteActivity ?? true);
          setPushCommentActivity(data.pushCommentActivity ?? true);
          setPushWeeklyDigest(data.pushWeeklyDigest ?? data.emailDigest ?? false);

          const savedPhone = data.contactMatchPhoneE164;
          const phoneStr = typeof savedPhone === 'string' && savedPhone.startsWith('+') ? savedPhone : '';
          setContactPhoneDraft(phoneStr);

          const blockedIds = blockedUserIdsList(data as Record<string, unknown>);
          if (blockedIds.length === 0) {
            setBlockedAccounts([]);
          } else {
            const capped = blockedIds.slice(0, 100);
            const entries = await Promise.all(
              capped.map(async (uid) => {
                try {
                  const u = await getDoc(doc(db, 'users', uid));
                  if (!u.exists()) return { uid, label: 'Unknown user' };
                  const udata = u.data();
                  const name = udata.displayUsername || udata.username || 'user';
                  return { uid, label: `@${name}` };
                } catch {
                  return { uid, label: 'Unknown user' };
                }
              })
            );
            setBlockedAccounts(entries);
          }
        } else if (!cancelled) {
          setBlockedAccounts([]);
          setContactPhoneDraft('');
        }
      } catch (err) {
        captureError(err, { area: 'SettingsScreen.loadUser' });
      }

      if (cancelled) return;
      setEmail(fresh.email || '');
      setAuthProvider(getPrimaryProvider(fresh));
      setEmailVerified(!!fresh.emailVerified);
      setLoading(false);
    };

    loadUser();

    return () => {
      cancelled = true;
    };
  }, [router]);

  const persistPushEnabled = async (value: boolean) => {
    const user = auth.currentUser;
    if (!user) return;
    setPushEnabled(value);
    try {
      if (!value) {
        await removeAllPushTokens(user.uid);
      }
      await updateDoc(doc(db, 'users', user.uid), { pushEnabled: value });
      if (value) {
        await registerAndUploadPushToken(user.uid);
      }
    } catch (err) {
      captureError(err, { area: 'SettingsScreen.persistPushEnabled' });
      Alert.alert('Error', 'Could not update push settings. Try again.');
    }
  };

  // ============================================================
  // PERSIST A PREFERENCE FLAG
  // Fire-and-forget — updates local state immediately and writes
  // the change to Firestore in the background.
  // ============================================================
  const persistPref = async (field: string, value: boolean) => {
    const user = auth.currentUser;
    if (!user) return;
    try {
      await updateDoc(doc(db, 'users', user.uid), { [field]: value });
    } catch (err) {
      captureError(err, { area: 'SettingsScreen.persistPref', field });
    }
  };

  const persistWeeklyDigestPush = async (value: boolean) => {
    const user = auth.currentUser;
    if (!user) return;
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        pushWeeklyDigest: value,
        ...(value === false ? { emailDigest: false } : {}),
      });
    } catch (err) {
      captureError(err, { area: 'SettingsScreen.persistWeeklyDigestPush' });
    }
  };

  const handleSaveContactDiscoveryPhone = async () => {
    const user = auth.currentUser;
    if (!user) return;
    const trimmed = contactPhoneDraft.trim();
    if (!trimmed) {
      Alert.alert('Phone number', 'Enter a number or use Remove to clear saved discovery phone.');
      return;
    }
    const e164 = normalizeToE164(trimmed, getDeviceCountryCodeForPhone());
    if (!e164) {
      Alert.alert(
        'Invalid number',
        'Use international format (for example +1 415 555 2671) or include enough digits for your country.'
      );
      return;
    }
    setSavingContactPhone(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), { contactMatchPhoneE164: e164 });
      setContactPhoneDraft(e164);
      Alert.alert('Saved', 'Friends can find you from their contacts when numbers match.');
    } catch (err) {
      captureError(err, { area: 'SettingsScreen.saveContactPhone' });
      Alert.alert('Error', 'Could not save phone number. Try again.');
    } finally {
      setSavingContactPhone(false);
    }
  };

  const handleClearContactDiscoveryPhone = () => {
    const user = auth.currentUser;
    if (!user) return;
    Alert.alert(
      'Remove discovery phone',
      'You will not be matched by phone from contacts until you save a number again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setSavingContactPhone(true);
            try {
              await updateDoc(doc(db, 'users', user.uid), { contactMatchPhoneE164: deleteField() });
              setContactPhoneDraft('');
            } catch (err) {
              captureError(err, { area: 'SettingsScreen.clearContactPhone' });
              Alert.alert('Error', 'Could not remove phone. Try again.');
            } finally {
              setSavingContactPhone(false);
            }
          },
        },
      ]
    );
  };

  const handleUnblockUser = async (uid: string) => {
    const user = auth.currentUser;
    if (!user) return;
    setUnblockingUid(uid);
    try {
      await updateDoc(doc(db, 'users', user.uid), { blockedUserIds: arrayRemove(uid) });
      setBlockedAccounts((prev) => prev.filter((e) => e.uid !== uid));
    } catch (err) {
      captureError(err, { area: 'SettingsScreen.unblockUser', uid });
      Alert.alert('Error', 'Could not unblock. Please try again.');
    } finally {
      setUnblockingUid(null);
    }
  };

  // ============================================================
  // RESEND VERIFICATION EMAIL
  // Shown only when the user's email isn't verified yet.
  // ============================================================
  const handleResendVerification = async () => {
    const user = auth.currentUser;
    if (!user) return;
    setResendingVerification(true);
    try {
      await sendEmailVerification(user);
      Alert.alert('Sent!', `We sent a new verification link to ${user.email}.`);
    } catch (err: unknown) {
      captureError(err, { area: 'SettingsScreen.resendVerification' });
      Alert.alert(
        'Could not send email',
        userFacingErrorMessage(err, 'Could not send verification email. Please try again.')
      );
    } finally {
      setResendingVerification(false);
    }
  };

  // ============================================================
  // PICK AND UPLOAD PROFILE PICTURE
  // ============================================================
  const handlePickImage = async () => {
    const user = auth.currentUser;
    if (!user) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Allow photo access to upload a profile picture.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      quality: 0.8,
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (result.canceled) return;
    try {
      const uri = result.assets[0].uri;
      const response = await fetch(uri);
      const blob = await response.blob();
      const imageRef = ref(storage, `profilePictures/${user.uid}.jpg`);
      // Pass contentType explicitly — React Native's fetch().blob() leaves
      // it empty, which would fail the Storage rule's image/.* check.
      await uploadBytes(imageRef, blob, { contentType: 'image/jpeg' });
      const downloadURL = await getDownloadURL(imageRef);
      await updateDoc(doc(db, 'users', user.uid), { profileImage: downloadURL });
      setProfileImage(downloadURL);
    } catch (err) {
      captureError(err, { area: 'SettingsScreen.handlePickImage' });
      console.log('Upload error:', err);
      Alert.alert('Upload failed', 'Could not upload image.');
    }
  };

  // ============================================================
  // UPDATE USERNAME
  // ============================================================
  const handleUpdateUsername = async () => {
    const user = auth.currentUser;
    if (!user) return;
    const trimmed = displayUsername.trim();
    if (trimmed.length < 3) return Alert.alert('Too short', 'Username must be at least 3 characters.');
    if (!/^[a-zA-Z0-9_]+$/.test(trimmed)) return Alert.alert('Invalid characters', 'Letters, numbers, and underscores only.');
    setSavingUsername(true);
    try {
      const q = query(collection(db, 'users'), where('username', '==', trimmed.toLowerCase()));
      const snap = await getDocs(q);
      if (snap.docs.some(d => d.id !== user.uid)) {
        setSavingUsername(false);
        return Alert.alert('Username Taken', 'Please choose a different username.');
      }
      await updateDoc(doc(db, 'users', user.uid), {
        username: trimmed.toLowerCase(),
        displayUsername: trimmed,
      });
      const spotsQuery = query(collection(db, 'spots'), where('userId', '==', user.uid));
      const spotsSnap = await getDocs(spotsQuery);
      await Promise.all(
        spotsSnap.docs.map((d) => {
          const spotTitle = String((d.data().title as string | undefined) ?? '').trim();
          return updateDoc(doc(db, 'spots', d.id), {
            username: trimmed.toLowerCase(),
            displayUsername: trimmed,
            ...(spotTitle ? {} : { title: 'Photo spot' }),
          });
        })
      );
      Alert.alert('Updated!', 'Username updated across all your spots.');
    } catch (err) {
      captureError(err, { area: 'SettingsScreen.handleUpdateUsername' });
      Alert.alert('Error', 'Could not update username.');
    }
    finally { setSavingUsername(false); }
  };

  // ============================================================
  // CHANGE EMAIL
  // ------------------------------------------------------------
  // Uses verifyBeforeUpdateEmail which is required when Firebase
  // Email Enumeration Protection is enabled.
  //
  // This sends a verification link to the NEW email address.
  // Firebase only switches the email after the user clicks it.
  // The user stays logged in and nothing changes until they verify.
  // ============================================================
  const handleChangeEmail = async () => {
    const user = auth.currentUser;
    if (!user || !user.email) return;
    if (!newEmail.trim())
      return Alert.alert('Missing info', 'Please enter a new email address.');
    // Password users must also supply their current password.
    if (authProvider === 'password' && !currentPasswordForEmail)
      return Alert.alert('Missing info', 'Please enter your current password.');
    if (newEmail.trim().toLowerCase() === user.email.toLowerCase())
      return Alert.alert('Same email', 'New email must be different from your current email.');

    setEmailLoading(true);
    try {
      // Check Firestore first — Email Enumeration Protection stops Firebase
      // from revealing if an email is already taken at the auth level, so
      // we check our own users collection instead.
      const emailQuery = query(
        collection(db, 'users'),
        where('email', '==', newEmail.trim().toLowerCase())
      );
      const emailSnap = await getDocs(emailQuery);
      if (emailSnap.docs.some(d => d.id !== user.uid)) {
        setEmailLoading(false);
        return Alert.alert('Email Already In Use', 'That email address is already associated with another account.');
      }

      // Re-authenticate to prove identity before making changes.
      // The reauth method depends on how the user originally signed in.
      if (authProvider === 'google.com') {
        await reauthenticateWithGoogle(user);
      } else if (authProvider === 'apple.com') {
        await reauthenticateWithApple(user);
      } else {
        const credential = EmailAuthProvider.credential(user.email, currentPasswordForEmail);
        await reauthenticateWithCredential(user, credential);
      }

      // Send a verification link to the NEW email.
      // The email won't actually change until the user clicks the link.
      // The user stays logged in with their current email in the meantime.
      await verifyBeforeUpdateEmail(user, newEmail.trim());

      setEmailModalVisible(false);
      setNewEmail('');
      setCurrentPasswordForEmail('');

      Alert.alert(
        'Verification Email Sent!',
        `A verification link has been sent to ${newEmail.trim()}. Your email will update automatically once you click it.`
      );
    } catch (err: unknown) {
      captureError(err, { area: 'SettingsScreen.handleChangeEmail' });
      console.log('Email change error:', err);
      Alert.alert(
        'Could not change email',
        userFacingErrorMessage(err, 'Could not update your email. Please try again.', {
          credentialHint: 'current-password',
        })
      );
    } finally { setEmailLoading(false); }
  };

  // ============================================================
  // CHANGE PASSWORD
  // ============================================================
  const handleChangePassword = async () => {
    const user = auth.currentUser;
    if (!user || !user.email) return;
    if (!currentPassword || !newPassword || !confirmNewPassword)
      return Alert.alert('Missing info', 'Please fill in all fields.');
    if (newPassword.length < 6)
      return Alert.alert('Weak password', 'Password must be at least 6 characters.');
    if (newPassword !== confirmNewPassword)
      return Alert.alert('Mismatch', 'New passwords do not match.');
    if (currentPassword === newPassword)
      return Alert.alert('Same password', 'New password must be different.');
    setPasswordLoading(true);
    try {
      const credential = EmailAuthProvider.credential(user.email, currentPassword.trim());
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPassword);
      setPasswordModalVisible(false);
      setCurrentPassword(''); setNewPassword(''); setConfirmNewPassword('');
      Alert.alert('Password Updated', 'Your password has been changed.');
    } catch (err: unknown) {
      Alert.alert(
        'Could not update password',
        userFacingErrorMessage(err, 'Could not update your password. Please try again.', {
          credentialHint: 'current-password',
        })
      );
    } finally { setPasswordLoading(false); }
  };

  // ============================================================
  // OPEN EXTERNAL LINK
  // Used by the About section for Privacy Policy, Terms of Service,
  // and Contact Support (mailto:). Falls back to a friendly error
  // if the device can't open the URL.
  // ============================================================
  const openExternalLink = async (url: string) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        Alert.alert('Cannot open link', url);
      }
    } catch (err) {
      captureError(err, { area: 'SettingsScreen.openExternalLink', url });
    }
  };

  // ============================================================
  // DELETE ACCOUNT
  // Required by Apple App Store policy 5.1.1(v) for any app that
  // supports account creation. Walks the user through a two-step
  // confirmation, then deletes spots → storage → profile doc → auth.
  // ============================================================
  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This will permanently delete your account, all your spots, and your photos. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            // Second confirmation — irreversible action
            Alert.alert(
              'Are you absolutely sure?',
              'There is no way to recover your account or spots after this.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Yes, delete forever',
                  style: 'destructive',
                  onPress: runDeleteAccount,
                },
              ]
            );
          },
        },
      ]
    );
  };

  const runDeleteAccount = async () => {
    const user = auth.currentUser;
    if (!user) return;
    setDeleting(true);
    const result = await deleteAccount(user);
    setDeleting(false);

    if (result.ok) {
      Alert.alert('Account Deleted', 'Your account and all your data have been removed.');
      // onAuthStateChanged in index.tsx will route them to /login automatically
      router.replace('/login');
    } else if (result.code === 'requires-recent-login') {
      Alert.alert(
        'Please sign in again',
        result.message,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Sign Out',
            style: 'destructive',
            onPress: async () => {
              await auth.signOut();
              router.replace('/login');
            },
          },
        ]
      );
    } else {
      Alert.alert('Error', result.message);
    }
  };

  // ============================================================
  // LOGOUT
  // ============================================================
  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out', style: 'destructive', onPress: async () => {
          await auth.signOut();
          router.replace('/login');
        },
      },
    ]);
  };

  if (loading) return (
    <View style={[styles.center, { backgroundColor: screenBg }]}>
      <ActivityIndicator color={ORANGE} />
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: screenBg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 50 }}>

        {/* ---- Header ---- */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={() => router.back()}>
            <Ionicons name="arrow-back" size={28} color={CREAM} />
          </TouchableOpacity>
          <Text style={styles.title}>Settings</Text>
        </View>

        {/* ---- Profile picture ---- */}
        <TouchableOpacity onPress={handlePickImage} style={styles.avatarWrap}>
          {profileImage
            ? <Image source={{ uri: profileImage }} style={styles.avatar} />
            : <View style={[styles.avatar, styles.avatarPlaceholder]}>
                <Ionicons name="person" size={40} color={CREAM_DARK} />
              </View>
          }
          <View style={styles.avatarEditBadge}>
            <Ionicons name="camera" size={14} color={CREAM} />
          </View>
          <Text style={styles.changePhotoText}>Tap to change photo</Text>
        </TouchableOpacity>

        {/* ---- Dark mode ---- */}
        <View style={[styles.rowCard, styles.rowCardSwitch, { marginHorizontal: 20 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <Ionicons name={isDark ? 'moon' : 'sunny'} size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowCardLabel}>Dark Mode</Text>
              <Text style={styles.rowCardSub}>Map, tabs, and screens follow this setting</Text>
            </View>
          </View>
          <SettingsSwitch value={isDark} onValueChange={(v) => void setDarkMode(v)} />
        </View>

        <Text style={styles.sectionTitle}>ACCOUNT</Text>

        {/* ---- Verify email card (unverified users only) ---- */}
        {!emailVerified && (
          <View style={[styles.verifyCard, { marginHorizontal: 20 }]}>
            <View style={styles.verifyHeader}>
              <View style={styles.verifyIconCircle}>
                <Ionicons name="mail-unread-outline" size={20} color={ORANGE} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.verifyTitle}>Verify your email</Text>
                <Text style={styles.verifySubtitle}>
                  Required before you can post a new spot.
                </Text>
              </View>
            </View>
            <TouchableOpacity
              style={[styles.updateButton, resendingVerification && { opacity: 0.6 }]}
              onPress={handleResendVerification}
              disabled={resendingVerification}
            >
              {resendingVerification
                ? <ActivityIndicator color={CREAM} size="small" />
                : <Text style={styles.updateButtonText}>Resend verification email</Text>}
            </TouchableOpacity>
          </View>
        )}

        {/* ---- Username card ---- */}
        <View style={[styles.stackCard, { marginHorizontal: 20 }]}>
          <Text style={styles.fieldLabel}>Username</Text>
          <TextInput
            value={displayUsername}
            onChangeText={setDisplayUsername}
            style={styles.fieldInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={CREAM_DARK}
          />
          <TouchableOpacity
            style={[styles.updateButton, savingUsername && { opacity: 0.6 }]}
            onPress={handleUpdateUsername}
            disabled={savingUsername}
          >
            {savingUsername
              ? <ActivityIndicator color={CREAM} size="small" />
              : <Text style={styles.updateButtonText}>Update Username</Text>}
          </TouchableOpacity>
        </View>

        {/* ---- Email card ---- */}
        <View style={[styles.stackCard, { marginHorizontal: 20, marginTop: 12 }]}>
          <Text style={styles.fieldLabel}>Email</Text>
          <Text style={styles.fieldValue}>{email}</Text>
          <TouchableOpacity
            style={styles.updateButton}
            onPress={() => { setNewEmail(''); setCurrentPasswordForEmail(''); setEmailModalVisible(true); }}
          >
            <Text style={styles.updateButtonText}>Change Email</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionTitle}>FRIEND DISCOVERY</Text>
        <Text style={[styles.rowCardSub, { marginHorizontal: 24, marginTop: -4, marginBottom: 10 }]}>
          Used when someone taps Sync contacts on Profile. Add your number so friends can match you by phone
          (your full contact list is never uploaded).
        </Text>

        {/* ---- Friend discovery phone (optional; used when friends sync contacts from Profile) ---- */}
        <View style={[styles.stackCard, { marginHorizontal: 20, marginTop: 0 }]}>
          <Text style={styles.fieldLabel}>Mobile number for contact matching</Text>
          <TextInput
            value={contactPhoneDraft}
            onChangeText={setContactPhoneDraft}
            style={[styles.fieldInput, { marginTop: 8 }]}
            placeholder="+1 415 555 2671"
            placeholderTextColor={CREAM_DARK}
            keyboardType="phone-pad"
            autoCorrect={false}
          />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
            <TouchableOpacity
              style={[styles.updateButton, { flex: 1 }, savingContactPhone && { opacity: 0.6 }]}
              onPress={() => void handleSaveContactDiscoveryPhone()}
              disabled={savingContactPhone}
            >
              {savingContactPhone ? (
                <ActivityIndicator color={CREAM} size="small" />
              ) : (
                <Text style={styles.updateButtonText}>Save number</Text>
              )}
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.updateButton,
                { flex: 1, backgroundColor: 'rgba(255,255,255,0.08)' },
                savingContactPhone && { opacity: 0.6 },
              ]}
              onPress={handleClearContactDiscoveryPhone}
              disabled={savingContactPhone || !contactPhoneDraft}
            >
              <Text style={[styles.updateButtonText, { color: CREAM_DARK }]}>Remove</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ---- Change password row ---- */}
        {/* Only password users have a password to change. Google/Apple users
            manage their credentials in their Google/Apple account settings. */}
        {authProvider === 'password' ? (
          <TouchableOpacity
            style={[styles.rowCard, { marginHorizontal: 20, marginTop: 12 }]}
            onPress={() => { setCurrentPassword(''); setNewPassword(''); setConfirmNewPassword(''); setPasswordModalVisible(true); }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name="lock-closed-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
              <Text style={styles.rowCardLabel}>Change Password</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={CREAM_DARK} />
          </TouchableOpacity>
        ) : (
          <View style={[styles.rowCard, { marginHorizontal: 20, marginTop: 12, opacity: 0.7 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
              <Ionicons
                name={authProvider === 'google.com' ? 'logo-google' : 'logo-apple'}
                size={20}
                color={ORANGE}
                style={{ marginRight: 10 }}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowCardLabel}>
                  Managed by {authProvider === 'google.com' ? 'Google' : 'Apple'}
                </Text>
                <Text style={styles.rowCardSub}>
                  Change your password in your {authProvider === 'google.com' ? 'Google' : 'Apple'} account.
                </Text>
              </View>
            </View>
          </View>
        )}

        {/* ============================================================ */}
        {/* PRIVACY                                                        */}
        {/* ============================================================ */}
        <Text style={styles.sectionTitle}>PRIVACY</Text>

        <View style={[styles.rowCard, styles.rowCardSwitch, { marginHorizontal: 20 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <Ionicons name="eye-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowCardLabel}>Public profile</Text>
              <Text style={styles.rowCardSub}>
                When off, your grid stays hidden until someone follows you (they request first, then you approve).
              </Text>
            </View>
          </View>
          <SettingsSwitch
            value={profileVisible}
            onValueChange={(v) => { setProfileVisible(v); persistPref('profileVisible', v); }}
          />
        </View>

        <View style={[styles.rowCard, styles.rowCardSwitch, { marginHorizontal: 20, marginTop: 12 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <Ionicons name="mail-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowCardLabel}>Show email on profile</Text>
              <Text style={styles.rowCardSub}>Display your email to other users</Text>
            </View>
          </View>
          <SettingsSwitch
            value={showEmailOnProfile}
            onValueChange={(v) => { setShowEmailOnProfile(v); persistPref('showEmailOnProfile', v); }}
          />
        </View>

        <Text style={styles.sectionTitle}>BLOCKED ACCOUNTS</Text>
        <Text style={[styles.rowCardSub, { marginHorizontal: 24, marginBottom: 10 }]}>
          People you block won&apos;t appear on your map. You can unblock anytime.
        </Text>
        {blockedAccounts.length === 0 ? (
          <View style={[styles.rowCard, { marginHorizontal: 20, opacity: 0.65 }]}>
            <Text style={styles.rowCardSub}>No blocked accounts.</Text>
          </View>
        ) : (
          blockedAccounts.map((entry) => (
            <View
              key={entry.uid}
              style={[styles.rowCard, { marginHorizontal: 20, marginTop: 8, flexDirection: 'row', alignItems: 'center' }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.rowCardLabel}>{entry.label}</Text>
              </View>
              <TouchableOpacity
                onPress={() => void handleUnblockUser(entry.uid)}
                disabled={unblockingUid === entry.uid}
                style={{ opacity: unblockingUid === entry.uid ? 0.5 : 1 }}
              >
                {unblockingUid === entry.uid ? (
                  <ActivityIndicator color={ORANGE} size="small" />
                ) : (
                  <Text style={{ color: ORANGE, fontWeight: '800', fontSize: 14 }}>Unblock</Text>
                )}
              </TouchableOpacity>
            </View>
          ))
        )}

        {/* ============================================================ */}
        {/* NOTIFICATIONS — Expo push; prefs read by Cloud Functions      */}
        {/* ============================================================ */}
        <Text style={styles.sectionTitle}>NOTIFICATIONS</Text>
        <Text style={[styles.rowCardSub, { marginHorizontal: 24, marginBottom: 10 }]}>
          Control which PinPix alerts appear on this device.
        </Text>

        <View style={[styles.rowCard, styles.rowCardSwitch, { marginHorizontal: 20 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <Ionicons name="notifications-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowCardLabel}>Allow push notifications</Text>
              <Text style={styles.rowCardSub}>Turn off to stop all PinPix pushes on this account</Text>
            </View>
          </View>
          <SettingsSwitch value={pushEnabled} onValueChange={(v) => void persistPushEnabled(v)} />
        </View>

        <View style={[styles.rowCard, styles.rowCardSwitch, { marginHorizontal: 20, marginTop: 12, opacity: pushEnabled ? 1 : 0.55 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <Ionicons name="people-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowCardLabel}>Follow requests & new followers</Text>
              <Text style={styles.rowCardSub}>When someone asks to follow you or starts following you</Text>
            </View>
          </View>
          <SettingsSwitch
            value={pushFriendRequests}
            disabled={!pushEnabled}
            onValueChange={(v) => {
              setPushFriendRequests(v);
              void persistPref('pushFriendRequests', v);
            }}
          />
        </View>

        <View style={[styles.rowCard, styles.rowCardSwitch, { marginHorizontal: 20, marginTop: 12, opacity: pushEnabled ? 1 : 0.55 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <Ionicons name="location-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowCardLabel}>Nearby new spots</Text>
              <Text style={styles.rowCardSub}>When someone posts near where you last browsed the map</Text>
            </View>
          </View>
          <SettingsSwitch
            value={pushNearbySpots}
            disabled={!pushEnabled}
            onValueChange={(v) => {
              setPushNearbySpots(v);
              void persistPref('pushNearbySpots', v);
            }}
          />
        </View>

        <View style={[styles.rowCard, styles.rowCardSwitch, { marginHorizontal: 20, marginTop: 12, opacity: pushEnabled ? 1 : 0.55 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <Ionicons name="heart-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowCardLabel}>Spot activity</Text>
              <Text style={styles.rowCardSub}>When someone likes or saves one of your spots</Text>
            </View>
          </View>
          <SettingsSwitch
            value={pushFavoriteActivity}
            disabled={!pushEnabled}
            onValueChange={(v) => {
              setPushFavoriteActivity(v);
              void persistPref('pushFavoriteActivity', v);
            }}
          />
        </View>

        <View style={[styles.rowCard, styles.rowCardSwitch, { marginHorizontal: 20, marginTop: 12, opacity: pushEnabled ? 1 : 0.55 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <Ionicons name="chatbubble-ellipses-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowCardLabel}>Comments & replies</Text>
              <Text style={styles.rowCardSub}>
                When someone comments on your spot, replies on your spot, @mentions you, or likes your
                comment
              </Text>
            </View>
          </View>
          <SettingsSwitch
            value={pushCommentActivity}
            disabled={!pushEnabled}
            onValueChange={(v) => {
              setPushCommentActivity(v);
              void persistPref('pushCommentActivity', v);
            }}
          />
        </View>

        <View style={[styles.rowCard, styles.rowCardSwitch, { marginHorizontal: 20, marginTop: 12, opacity: pushEnabled ? 1 : 0.55 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <Ionicons name="newspaper-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowCardLabel}>Weekly summary</Text>
              <Text style={styles.rowCardSub}>One push per week with likes, saves, and nearby highlights</Text>
            </View>
          </View>
          <SettingsSwitch
            value={pushWeeklyDigest}
            disabled={!pushEnabled}
            onValueChange={(v) => {
              setPushWeeklyDigest(v);
              void persistWeeklyDigestPush(v);
            }}
          />
        </View>

        {/* ============================================================ */}
        {/* ABOUT                                                          */}
        {/* ============================================================ */}
        <Text style={styles.sectionTitle}>ABOUT</Text>

        <TouchableOpacity
          style={[styles.rowCard, { marginHorizontal: 20 }]}
          onPress={() => openExternalLink(LEGAL.privacyPolicyUrl)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="shield-checkmark-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <Text style={styles.rowCardLabel}>Privacy Policy</Text>
          </View>
          <Ionicons name="open-outline" size={18} color={CREAM_DARK} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.rowCard, { marginHorizontal: 20, marginTop: 12 }]}
          onPress={() => openExternalLink(LEGAL.termsOfServiceUrl)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="document-text-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <Text style={styles.rowCardLabel}>Terms of Service</Text>
          </View>
          <Ionicons name="open-outline" size={18} color={CREAM_DARK} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.rowCard, { marginHorizontal: 20, marginTop: 12 }]}
          onPress={() => openExternalLink(`mailto:${LEGAL.supportEmail}?subject=PinPix%20support`)}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="help-circle-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <Text style={styles.rowCardLabel}>Contact Support</Text>
          </View>
          <Ionicons name="open-outline" size={18} color={CREAM_DARK} />
        </TouchableOpacity>

        <View style={[styles.rowCard, { marginHorizontal: 20, marginTop: 12 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="information-circle-outline" size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <Text style={styles.rowCardLabel}>App Version</Text>
          </View>
          <Text style={styles.rowCardValue}>{Constants.expoConfig?.version || '1.0.0'}</Text>
        </View>

        {/* ============================================================ */}
        {/* DANGER ZONE                                                    */}
        {/* ============================================================ */}
        <Text style={[styles.sectionTitle, { color: DANGER, opacity: 0.85 }]}>DANGER ZONE</Text>

        {/* ---- Logout button ---- */}
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={20} color={CREAM} style={{ marginRight: 8 }} />
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>

        {/* ---- Delete account button (P0: required by App Store) ---- */}
        <TouchableOpacity
          style={[styles.deleteAccountButton, deleting && { opacity: 0.6 }]}
          onPress={handleDeleteAccount}
          disabled={deleting}
        >
          {deleting ? (
            <ActivityIndicator color={DANGER} />
          ) : (
            <>
              <Ionicons name="trash-outline" size={20} color={DANGER} style={{ marginRight: 8 }} />
              <Text style={styles.deleteAccountText}>Delete Account</Text>
            </>
          )}
        </TouchableOpacity>

      </ScrollView>

      {/* ---- Change Email Modal ---- */}
      <Modal visible={emailModalVisible} transparent animationType="slide" onRequestClose={() => setEmailModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <View style={styles.modalBg}>
            <View style={[styles.modalBox, { backgroundColor: screenBg }]}>
              <Text style={styles.modalTitle}>Change Email</Text>
              <Text style={styles.modalSubtitle}>
                {authProvider === 'google.com'
                  ? 'You\u2019ll be asked to sign in again with Google to confirm it\u2019s you. After that we\u2019ll send a verification link to the new email.'
                  : authProvider === 'apple.com'
                  ? 'You\u2019ll be asked to sign in again with Apple to confirm it\u2019s you. After that we\u2019ll send a verification link to the new email.'
                  : 'A verification link will be sent to your new email. Your email will update once you click it.'}
              </Text>
              <TextInput
                style={styles.modalInput}
                placeholder="New email address"
                placeholderTextColor={CREAM_DARK}
                value={newEmail}
                onChangeText={setNewEmail}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              {authProvider === 'password' && (
                <TextInput
                  style={styles.modalInput}
                  placeholder="Current password"
                  placeholderTextColor={CREAM_DARK}
                  value={currentPasswordForEmail}
                  onChangeText={setCurrentPasswordForEmail}
                  secureTextEntry
                  autoCorrect={false}
                  autoCapitalize="none"
                />
              )}
              <TouchableOpacity
                style={[styles.modalButton, emailLoading && { opacity: 0.6 }]}
                onPress={handleChangeEmail}
                disabled={emailLoading}
              >
                {emailLoading
                  ? <ActivityIndicator color={CREAM} />
                  : <Text style={styles.modalButtonText}>
                      {authProvider === 'google.com'
                        ? 'Continue with Google'
                        : authProvider === 'apple.com'
                        ? 'Continue with Apple'
                        : 'Send Verification Link'}
                    </Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setEmailModalVisible(false)} style={styles.modalCancel}>
                <Text style={{ color: ORANGE, fontSize: 15 }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ---- Change Password Modal ---- */}
      <Modal visible={passwordModalVisible} transparent animationType="slide" onRequestClose={() => setPasswordModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <View style={styles.modalBg}>
            <View style={[styles.modalBox, { backgroundColor: screenBg }]}>
              <Text style={styles.modalTitle}>Change Password</Text>
              <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                <TextInput
                  style={styles.modalInput}
                  placeholder="Current password"
                  placeholderTextColor={CREAM_DARK}
                  value={currentPassword}
                  onChangeText={setCurrentPassword}
                  secureTextEntry
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                <TextInput
                  style={styles.modalInput}
                  placeholder="New password (min. 6 chars)"
                  placeholderTextColor={CREAM_DARK}
                  value={newPassword}
                  onChangeText={setNewPassword}
                  secureTextEntry
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                <TextInput
                  style={styles.modalInput}
                  placeholder="Confirm new password"
                  placeholderTextColor={CREAM_DARK}
                  value={confirmNewPassword}
                  onChangeText={setConfirmNewPassword}
                  secureTextEntry
                  autoCorrect={false}
                  autoCapitalize="none"
                />
                <TouchableOpacity
                  style={[styles.modalButton, passwordLoading && { opacity: 0.6 }]}
                  onPress={handleChangePassword}
                  disabled={passwordLoading}
                >
                  {passwordLoading ? <ActivityIndicator color={CREAM} /> : <Text style={styles.modalButtonText}>Update Password</Text>}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setPasswordModalVisible(false)} style={styles.modalCancel}>
                  <Text style={{ color: ORANGE, fontSize: 15 }}>Cancel</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 10, marginBottom: 24 },
  title: { fontSize: 24, fontWeight: '900', color: CREAM, marginLeft: 12, letterSpacing: 0.3 },
  avatarWrap: { alignItems: 'center', marginBottom: 28 },
  avatar: { width: 100, height: 100, borderRadius: 50, borderWidth: 3, borderColor: ORANGE },
  avatarPlaceholder: { backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', alignItems: 'center' },
  avatarEditBadge: {
    position: 'absolute', bottom: 28, right: '35%',
    backgroundColor: ORANGE, width: 28, height: 28, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: NAVY,
  },
  changePhotoText: { color: CREAM_DARK, marginTop: 8, fontSize: 13 },
  sectionTitle: { fontSize: 11, fontWeight: '700', color: CREAM_DARK, letterSpacing: 1.2, marginLeft: 20, marginBottom: 10, marginTop: 20 },
  rowCard: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderRadius: 16, padding: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.12)',
  },
  /** Rows with a trailing `Switch`: top-align so the control matches the title line (native size). */
  rowCardSwitch: { alignItems: 'flex-start' },
  switchWrap: { justifyContent: 'center', paddingTop: Platform.OS === 'ios' ? 1 : 0 },
  rowCardLabel: { fontSize: 15, fontWeight: '600', color: CREAM },
  rowCardSub: { fontSize: 12, color: CREAM_DARK, marginTop: 2 },
  rowCardValue: { fontSize: 14, color: CREAM_DARK, fontWeight: '600' },
  stackCard: {
    borderRadius: 16, padding: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.12)',
  },
  verifyCard: {
    borderRadius: 16, padding: 16, marginBottom: 12,
    backgroundColor: 'rgba(227,92,37,0.08)',
    borderWidth: 1, borderColor: 'rgba(227,92,37,0.35)',
  },
  verifyHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  verifyIconCircle: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(227,92,37,0.18)',
    justifyContent: 'center', alignItems: 'center',
    marginRight: 12,
  },
  verifyTitle: { fontSize: 15, fontWeight: '700', color: CREAM, marginBottom: 2 },
  verifySubtitle: { fontSize: 12, color: CREAM_DARK },
  fieldLabel: { fontSize: 11, fontWeight: '700', color: CREAM_DARK, letterSpacing: 1, marginBottom: 8 },
  fieldValue: { fontSize: 16, color: CREAM, marginBottom: 14, fontWeight: '500' },
  fieldInput: {
    fontSize: 16, color: CREAM,
    paddingVertical: 8, marginBottom: 14,
    borderBottomWidth: 1, borderBottomColor: 'rgba(231,219,203,0.25)',
  },
  updateButton: { backgroundColor: ORANGE, paddingVertical: 10, borderRadius: 10, alignItems: 'center' },
  updateButtonText: { color: CREAM, fontWeight: '700', fontSize: 14 },
  logoutButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginHorizontal: 20, marginTop: 32,
    backgroundColor: 'rgba(255,59,48,0.15)',
    borderWidth: 1.5, borderColor: DANGER,
    paddingVertical: 14, borderRadius: 14,
  },
  logoutText: { color: DANGER, fontWeight: '700', fontSize: 16 },
  deleteAccountButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginHorizontal: 20, marginTop: 12,
    backgroundColor: 'transparent',
    borderWidth: 1.5, borderColor: 'rgba(255,59,48,0.5)',
    paddingVertical: 14, borderRadius: 14,
  },
  deleteAccountText: { color: DANGER, fontWeight: '700', fontSize: 15 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalBox: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.15)',
  },
  modalTitle: { fontSize: 20, fontWeight: '800', color: CREAM, marginBottom: 6, textAlign: 'center' },
  modalSubtitle: { fontSize: 13, color: CREAM_DARK, textAlign: 'center', marginBottom: 16, lineHeight: 18 },
  modalInput: {
    backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 12,
    padding: 14, fontSize: 15, color: CREAM, marginBottom: 12,
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.15)',
  },
  modalButton: { backgroundColor: ORANGE, padding: 15, borderRadius: 12, alignItems: 'center' },
  modalButtonText: { color: CREAM, fontWeight: '800', fontSize: 15 },
  modalCancel: { alignItems: 'center', marginTop: 14 },
});