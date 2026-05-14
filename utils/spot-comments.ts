import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Timestamp,
} from 'firebase/firestore';
import { auth, db } from './firebase';

export const SPOT_COMMENT_MAX_LEN = 2000;

export type SpotCommentRow = {
  id: string;
  userId: string;
  username: string;
  text: string;
  /** When set, this doc is a one-level reply to a top-level comment. */
  parentCommentId?: string;
  createdAt?: Timestamp;
};

export async function addSpotComment(
  spotId: string,
  rawText: string,
  userId: string,
  usernameLower: string,
  parentCommentId?: string | null
): Promise<void> {
  const text = rawText.trim();
  if (!text || text.length > SPOT_COMMENT_MAX_LEN) {
    throw new Error('Comment is empty or too long.');
  }
  const u = usernameLower.trim().toLowerCase();
  if (!u) throw new Error('Username required to comment.');
  const parent = parentCommentId?.trim();
  await addDoc(collection(db, 'spots', spotId, 'comments'), {
    userId,
    username: u,
    text,
    createdAt: serverTimestamp(),
    ...(parent ? { parentCommentId: parent } : {}),
  });
}

/** Remove all like docs under a comment, then the comment doc. */
export async function deleteSpotComment(spotId: string, commentId: string): Promise<void> {
  const likesRef = collection(db, 'spots', spotId, 'comments', commentId, 'likes');
  const likesSnap = await getDocs(likesRef);
  await Promise.all(likesSnap.docs.map((d) => deleteDoc(d.ref)));
  await deleteDoc(doc(db, 'spots', spotId, 'comments', commentId));
}

/** Delete a top-level comment and all replies (and their likes). */
export async function deleteSpotCommentThread(spotId: string, rootCommentId: string): Promise<void> {
  const repliesQ = query(
    collection(db, 'spots', spotId, 'comments'),
    where('parentCommentId', '==', rootCommentId)
  );
  const repliesSnap = await getDocs(repliesQ);
  await Promise.all(repliesSnap.docs.map((d) => deleteSpotComment(spotId, d.id)));
  await deleteSpotComment(spotId, rootCommentId);
}

export async function toggleCommentLike(
  spotId: string,
  commentId: string,
  liked: boolean
): Promise<void> {
  const me = auth.currentUser?.uid;
  if (!me || !spotId || !commentId) return;
  const likeRef = doc(db, 'spots', spotId, 'comments', commentId, 'likes', me);
  if (liked) {
    await deleteDoc(likeRef);
  } else {
    await setDoc(likeRef, { createdAt: serverTimestamp() });
  }
}

/** Short relative / date label for comment timestamps. */
export function formatSpotCommentTime(ts: Timestamp | undefined): string {
  if (!ts?.toDate) return '';
  const d = ts.toDate();
  const now = Date.now();
  const diffMs = now - d.getTime();
  if (diffMs < 60_000) return 'now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`;
  if (diffMs < 7 * 86_400_000) return `${Math.floor(diffMs / 86_400_000)}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
