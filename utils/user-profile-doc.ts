// ============================================================
// user-profile-doc.ts — Safe create / existence checks for users/{uid}
// ------------------------------------------------------------
// Profile docs must only be created once. setDoc on an existing doc
// replaces the whole document and can wipe followers/following.
// ============================================================

import { doc, getDoc, runTransaction } from 'firebase/firestore';
import { db } from './firebase';
import { captureError } from './sentry';

const PROFILE_LOOKUP_RETRIES = 3;
const PROFILE_LOOKUP_DELAY_MS = 400;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns whether users/{uid} exists. On persistent read failure, returns 'unknown'. */
export async function userProfileDocExists(uid: string): Promise<boolean | 'unknown'> {
  for (let attempt = 0; attempt < PROFILE_LOOKUP_RETRIES; attempt++) {
    try {
      const snap = await getDoc(doc(db, 'users', uid));
      return snap.exists();
    } catch (err) {
      if (attempt === PROFILE_LOOKUP_RETRIES - 1) {
        captureError(err, { area: 'userProfileDocExists', uid, attempt });
        return 'unknown';
      }
      await delay(PROFILE_LOOKUP_DELAY_MS);
    }
  }
  return 'unknown';
}

export type NewUserProfileFields = {
  username: string;
  displayUsername: string;
  email: string;
  profileImage?: string | null;
  contactMatchPhoneE164?: string;
};

const DEFAULT_PROFILE_FIELDS = {
  favorites: [] as string[],
  profileVisible: true,
  showEmailOnProfile: false,
  pushNearbySpots: true,
  pushFavoriteActivity: true,
  pushCommentActivity: true,
  pushEnabled: true,
  pushFriendRequests: true,
  pushWeeklyDigest: true,
  emailDigest: false,
  blockedUserIds: [] as string[],
  following: [] as string[],
  followers: [] as string[],
};

/**
 * Creates users/{uid} only if the document is missing (transaction).
 * Never overwrites an existing profile.
 */
export async function createUserProfileDocIfMissing(
  uid: string,
  fields: NewUserProfileFields
): Promise<'created' | 'already_exists'> {
  const ref = doc(db, 'users', uid);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) return 'already_exists';

    tx.set(ref, {
      ...DEFAULT_PROFILE_FIELDS,
      username: fields.username,
      displayUsername: fields.displayUsername,
      email: fields.email.toLowerCase(),
      profileImage: fields.profileImage ?? null,
      createdAt: new Date().toISOString(),
      ...(fields.contactMatchPhoneE164
        ? { contactMatchPhoneE164: fields.contactMatchPhoneE164 }
        : {}),
    });
    return 'created';
  });
}
