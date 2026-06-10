import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';

export type DigestCounterField = 'digestLikesWeek' | 'digestBookmarksWeek' | 'digestNearbyWeek';

const MAX_WEEKLY_REVIEW_SPOT_IDS = 50;

export async function incrementDigestCounter(uid: string, field: DigestCounterField): Promise<void> {
  const ref = getFirestore().doc(`users/${uid}`);
  try {
    await ref.set({ [field]: FieldValue.increment(1) }, { merge: true });
  } catch (e) {
    // Never block user-facing pushes (likes/saves/nearby) on weekly digest bookkeeping.
    logger.warn('incrementDigestCounter failed', { uid, field, err: String(e) });
  }
}

/** Track nearby spot ids for the weekly recap swipe feed. */
export async function appendWeeklyReviewSpotId(uid: string, spotId: string): Promise<void> {
  const ref = getFirestore().doc(`users/${uid}`);
  try {
    const snap = await ref.get();
    const existing = snap.data()?.digestNearbySpotIds;
    const ids = Array.isArray(existing)
      ? existing.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    if (ids.includes(spotId)) return;
    const next = [...ids, spotId].slice(-MAX_WEEKLY_REVIEW_SPOT_IDS);
    await ref.set({ digestNearbySpotIds: next }, { merge: true });
  } catch (e) {
    logger.warn('appendWeeklyReviewSpotId failed', { uid, spotId, err: String(e) });
  }
}
