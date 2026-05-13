// ============================================================
// account.ts — Account-level helpers (delete account, etc.)
// ------------------------------------------------------------
// Centralizes the multi-step account deletion flow so it's
// consistent and easy to audit.
//
// Deleting an account requires:
//   1. Delete all of the user's spots (Firestore docs + Storage images)
//   2. Delete the user's profile picture from Storage
//   3. Delete the user's Firestore profile document
//   4. Delete the Firebase Auth account itself
//
// Step 4 may require recent authentication. If it fails with
// "auth/requires-recent-login", the UI should prompt the user
// to sign in again and retry.
// ============================================================

import { deleteUser, User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  where,
} from 'firebase/firestore';
import { deleteObject, ref as storageRef } from 'firebase/storage';
import { db, storage } from './firebase';
import { deleteStorageObjectsByUrls } from './storage-delete';
import { spotGalleryUrls } from '../components/types';
import { captureError } from './sentry';

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; code: 'requires-recent-login' | 'unknown'; message: string };

export async function deleteAccount(user: User): Promise<DeleteAccountResult> {
  try {
    // ---- 1. Delete all of the user's spots ----
    const spotsQuery = query(collection(db, 'spots'), where('userId', '==', user.uid));
    const spotsSnap = await getDocs(spotsQuery);

    await Promise.all(
      spotsSnap.docs.map(async (d) => {
        const data = d.data();
        // Best-effort image delete — failure here shouldn't block the rest
        try {
          await deleteStorageObjectsByUrls(
            spotGalleryUrls({
              imageUrl: (data.imageUrl as string) || '',
              imageUrls: data.imageUrls as string[] | undefined,
            })
          );
        } catch (err) {
          captureError(err, { area: 'account.deleteAccount.spotImage', spotId: d.id });
        }
        await deleteDoc(doc(db, 'spots', d.id));
      })
    );

    // ---- 2. Delete the user's profile picture (if any) ----
    try {
      await deleteObject(storageRef(storage, `profilePictures/${user.uid}.jpg`));
    } catch {
      // No profile picture or already gone — fine
    }

    // ---- 3. Delete the user's Firestore profile document ----
    try {
      await deleteDoc(doc(db, 'users', user.uid));
    } catch (err) {
      captureError(err, { area: 'account.deleteAccount.userDoc' });
    }

    // ---- 4. Delete the Auth account ----
    // This may throw 'auth/requires-recent-login' if the user signed in
    // more than ~5 min ago. The caller should re-auth and retry in that case.
    await deleteUser(user);

    return { ok: true };
  } catch (err: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    if (e?.code === 'auth/requires-recent-login') {
      return {
        ok: false,
        code: 'requires-recent-login',
        message:
          'For security, please sign out and sign back in, then try deleting your account again.',
      };
    }
    captureError(err, { area: 'account.deleteAccount' });
    return {
      ok: false,
      code: 'unknown',
      message: e?.message || 'Could not delete account. Please try again.',
    };
  }
}
