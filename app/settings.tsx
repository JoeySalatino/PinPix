// ============================================================
// SettingsScreen.tsx — User Account Settings
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  verifyBeforeUpdateEmail,
} from 'firebase/auth';
import { collection, doc, getDoc, getDocs, query, updateDoc, where } from 'firebase/firestore';
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
import { BRAND } from '../constants/brand';
import { auth, db, storage } from '../utils/firebase';
import { captureError } from '../utils/sentry';
import { useTheme } from '../utils/theme-context';

const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK, danger: DANGER } = BRAND;

export default function SettingsScreen() {
  const router = useRouter();
  const { isDark, toggleTheme } = useTheme();

  const [displayUsername, setDisplayUsername] = useState('');
  const [email, setEmail] = useState('');
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

  // ============================================================
  // LOAD USER DATA
  // ============================================================
  useEffect(() => {
    const loadUser = async () => {
      const user = auth.currentUser;
      if (!user) return;
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) {
        setDisplayUsername(snap.data().displayUsername || snap.data().username || '');
        setProfileImage(snap.data().profileImage || null);
      }
      setEmail(user.email || '');
      setLoading(false);
    };
    loadUser();
  }, []);

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
      await uploadBytes(imageRef, blob);
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
        spotsSnap.docs.map(d =>
          updateDoc(doc(db, 'spots', d.id), {
            username: trimmed.toLowerCase(),
            displayUsername: trimmed,
          })
        )
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
    if (!newEmail.trim() || !currentPasswordForEmail)
      return Alert.alert('Missing info', 'Please fill in all fields.');
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

      // Re-authenticate to prove identity before making changes
      const credential = EmailAuthProvider.credential(user.email, currentPasswordForEmail);
      await reauthenticateWithCredential(user, credential);

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
    } catch (err: any) {
      captureError(err, { area: 'SettingsScreen.handleChangeEmail', code: err?.code });
      console.log('Email change error:', err.code, err.message);
      const msg =
        err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential'
          ? 'Incorrect current password. Please try again.'
          : err.code === 'auth/email-already-in-use'
          ? 'That email address is already in use by another account.'
          : err.code === 'auth/invalid-email'
          ? 'Please enter a valid email address.'
          : err.code === 'auth/requires-recent-login'
          ? 'Please log out and log back in before changing your email.'
          : err.message;
      Alert.alert('Could not change email', msg);
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
    } catch (err: any) {
      const msg =
        err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password'
          ? 'Incorrect current password.'
          : err.message;
      Alert.alert('Error', msg);
    } finally { setPasswordLoading(false); }
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
    <View style={[styles.center, { backgroundColor: NAVY }]}>
      <ActivityIndicator color={ORANGE} />
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: NAVY }}>
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

        {/* ---- Dark mode toggle ---- */}
        <View style={[styles.rowCard, { marginHorizontal: 20 }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name={isDark ? 'moon' : 'sunny'} size={20} color={ORANGE} style={{ marginRight: 10 }} />
            <Text style={styles.rowCardLabel}>Dark Mode</Text>
          </View>
          <Switch
            value={isDark}
            onValueChange={toggleTheme}
            trackColor={{ false: 'rgba(255,255,255,0.2)', true: ORANGE }}
            thumbColor={CREAM}
          />
        </View>

        <Text style={styles.sectionTitle}>ACCOUNT</Text>

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

        {/* ---- Change password row ---- */}
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

        {/* ---- Logout button ---- */}
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={20} color={CREAM} style={{ marginRight: 8 }} />
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>

      </ScrollView>

      {/* ---- Change Email Modal ---- */}
      <Modal visible={emailModalVisible} transparent animationType="slide" onRequestClose={() => setEmailModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <View style={styles.modalBg}>
            <View style={styles.modalBox}>
              <Text style={styles.modalTitle}>Change Email</Text>
              <Text style={styles.modalSubtitle}>
                A verification link will be sent to your new email. Your email will update once you click it.
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
              <TouchableOpacity
                style={[styles.modalButton, emailLoading && { opacity: 0.6 }]}
                onPress={handleChangeEmail}
                disabled={emailLoading}
              >
                {emailLoading ? <ActivityIndicator color={CREAM} /> : <Text style={styles.modalButtonText}>Send Verification Link</Text>}
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
            <View style={styles.modalBox}>
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
  rowCardLabel: { fontSize: 15, fontWeight: '600', color: CREAM },
  stackCard: {
    borderRadius: 16, padding: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.12)',
  },
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
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  modalBox: {
    backgroundColor: NAVY, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: 24, paddingBottom: 40,
    borderWidth: 1, borderColor: 'rgba(231,219,203,0.15)',
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