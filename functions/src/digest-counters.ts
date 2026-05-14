import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

export type DigestCounterField = 'digestLikesWeek' | 'digestBookmarksWeek' | 'digestNearbyWeek';

export async function incrementDigestCounter(uid: string, field: DigestCounterField): Promise<void> {
  const ref = getFirestore().doc(`users/${uid}`);
  try {
    await ref.set({ [field]: FieldValue.increment(1) }, { merge: true });
  } catch (e) {
    // Never block user-facing pushes (likes/saves/nearby) on weekly digest bookkeeping.
    logger.warn('incrementDigestCounter failed', { uid, field, err: String(e) });
  }
}
