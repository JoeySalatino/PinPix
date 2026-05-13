import { FieldValue, getFirestore } from 'firebase-admin/firestore';

export type DigestCounterField = 'digestLikesWeek' | 'digestBookmarksWeek' | 'digestNearbyWeek';

export async function incrementDigestCounter(uid: string, field: DigestCounterField): Promise<void> {
  const ref = getFirestore().doc(`users/${uid}`);
  await ref.set({ [field]: FieldValue.increment(1) }, { merge: true });
}
