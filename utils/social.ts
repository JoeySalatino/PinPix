// ============================================================
// social.ts — Friends, bookmarks, spot likes (Firestore)
// ------------------------------------------------------------
// friendRequests/{fromUid_toUid}: fromUid, toUid, status, createdAt
// users/{uid}/friends is a string[] on the user doc (arrayUnion).
// users/{uid}/bookmarks/{spotId}: denormalized fields for list UI.
// spots/{spotId}/likes/{userId}: { createdAt } — one doc per like.
// ============================================================

import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { spotGalleryUrls } from '../components/types';
import { auth, db } from './firebase';

export function friendRequestDocId(fromUid: string, toUid: string) {
  return `${fromUid}_${toUid}`;
}

export async function sendFriendRequest(toUid: string) {
  const me = auth.currentUser?.uid;
  if (!me || me === toUid) return { ok: false as const, error: 'Not signed in' };
  const rid = friendRequestDocId(me, toUid);
  const ref = doc(db, 'friendRequests', rid);
  const existing = await getDoc(ref);
  if (existing.exists()) {
    const st = existing.data()?.status;
    if (st === 'pending') return { ok: false as const, error: 'Request already sent' };
  }
  // Block duplicate reverse pending: they sent to us
  const reverse = await getDoc(doc(db, 'friendRequests', friendRequestDocId(toUid, me)));
  if (reverse.exists() && reverse.data()?.status === 'pending') {
    return { ok: false as const, error: 'This person already sent you a request — check Friends.' };
  }
  const meDoc = await getDoc(doc(db, 'users', me));
  const friends = (meDoc.data()?.friends as string[] | undefined) || [];
  if (friends.includes(toUid)) return { ok: false as const, error: 'Already friends' };

  await setDoc(ref, {
    fromUid: me,
    toUid,
    status: 'pending',
    createdAt: serverTimestamp(),
  });
  return { ok: true as const };
}

export async function acceptFriendRequest(fromUid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = auth.currentUser?.uid;
  if (!me) return { ok: false, error: 'Not signed in' };
  const rid = friendRequestDocId(fromUid, me);
  const ref = doc(db, 'friendRequests', rid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ok: false, error: 'No request found' };
  const d = snap.data();
  if (d?.status !== 'pending' || d?.toUid !== me) return { ok: false, error: 'Invalid or expired request' };

  try {
    const batch = writeBatch(db);
    batch.delete(ref);
    batch.update(doc(db, 'users', me), { friends: arrayUnion(fromUid) });
    batch.update(doc(db, 'users', fromUid), { friends: arrayUnion(me) });
    await batch.commit();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Could not accept request';
    return { ok: false, error: msg };
  }
}

export async function declineFriendRequest(fromUid: string) {
  const me = auth.currentUser?.uid;
  if (!me) return;
  const rid = friendRequestDocId(fromUid, me);
  await deleteDoc(doc(db, 'friendRequests', rid));
}

export async function cancelOutgoingFriendRequest(toUid: string) {
  const me = auth.currentUser?.uid;
  if (!me) return;
  const rid = friendRequestDocId(me, toUid);
  await deleteDoc(doc(db, 'friendRequests', rid));
}

/** Remove mutual friendship (updates both users' friends[] and clears stale request docs). */
export async function removeFriend(otherUid: string) {
  const me = auth.currentUser?.uid;
  if (!me || !otherUid || me === otherUid) return;
  const id1 = friendRequestDocId(me, otherUid);
  const id2 = friendRequestDocId(otherUid, me);
  const [d1, d2] = await Promise.all([getDoc(doc(db, 'friendRequests', id1)), getDoc(doc(db, 'friendRequests', id2))]);
  const batch = writeBatch(db);
  batch.update(doc(db, 'users', me), { friends: arrayRemove(otherUid) });
  batch.update(doc(db, 'users', otherUid), { friends: arrayRemove(me) });
  if (d1.exists()) batch.delete(doc(db, 'friendRequests', id1));
  if (d2.exists()) batch.delete(doc(db, 'friendRequests', id2));
  await batch.commit();
}

function chunkIds<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type FriendActivitySpot = {
  id: string;
  userId: string;
  authorUsername: string;
  title: string;
  imageUrl: string;
  latitude: number;
  longitude: number;
  createdAtMs: number;
};

/** Recent spots posted by the given friend UIDs (Firestore `in` max 10 per query). */
export async function fetchFriendsRecentSpots(friendUids: string[]): Promise<FriendActivitySpot[]> {
  if (friendUids.length === 0) return [];
  const all: FriendActivitySpot[] = [];
  for (const group of chunkIds(friendUids, 10)) {
    const q = query(collection(db, 'spots'), where('userId', 'in', group));
    const snap = await getDocs(q);
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      if (!d.location) return;
      let ms = 0;
      const ca = d.createdAt;
      if (ca && typeof ca.toMillis === 'function') ms = ca.toMillis();
      else if (typeof ca === 'string') ms = Date.parse(ca) || 0;
      else if (ca && typeof ca.seconds === 'number') ms = ca.seconds * 1000;
      const urls = spotGalleryUrls({
        imageUrl: (d.imageUrl as string) || '',
        imageUrls: d.imageUrls as string[] | undefined,
      });
      all.push({
        id: docSnap.id,
        userId: (d.userId as string) || '',
        authorUsername: ((d.displayUsername || d.username) as string) || '',
        title: (d.title as string) || '',
        imageUrl: urls[0] || '',
        latitude: Number(d.location.latitude) || 0,
        longitude: Number(d.location.longitude) || 0,
        createdAtMs: ms,
      });
    });
  }
  all.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return all.slice(0, 100);
}

/**
 * Live inbox of friend requests addressed to `uid`.
 * Uses a single equality on `toUid` (automatic single-field index) and filters
 * `status === 'pending'` client-side so the listener does not depend on a
 * composite index (missing index surfaces as onSnapshot errors).
 */
export function subscribeIncomingFriendRequests(
  uid: string,
  onChange: (fromUids: string[]) => void,
  onListenError?: (e: unknown) => void
): () => void {
  const q = query(collection(db, 'friendRequests'), where('toUid', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const fromUids = snap.docs
        .filter((d) => (d.data().status as string | undefined) === 'pending')
        .map((d) => d.data().fromUid as string)
        .filter(Boolean);
      onChange([...new Set(fromUids)]);
    },
    (err) => {
      onListenError?.(err);
    }
  );
}

export async function toggleSpotLike(spotId: string, liked: boolean) {
  const me = auth.currentUser?.uid;
  if (!me || !spotId) return;
  const likeRef = doc(db, 'spots', spotId, 'likes', me);
  if (liked) {
    await deleteDoc(likeRef);
  } else {
    await setDoc(likeRef, { createdAt: serverTimestamp() });
  }
}

export async function toggleBookmark(
  spot: {
    id: string;
    title: string;
    imageUrl: string;
    latitude: number;
    longitude: number;
    address?: string;
  },
  bookmarked: boolean
) {
  const me = auth.currentUser?.uid;
  if (!me) return;
  const bRef = doc(db, 'users', me, 'bookmarks', spot.id);
  if (bookmarked) {
    await deleteDoc(bRef);
  } else {
    await setDoc(bRef, {
      spotId: spot.id,
      title: spot.title || '',
      imageUrl: spot.imageUrl || '',
      latitude: spot.latitude,
      longitude: spot.longitude,
      address: spot.address || '',
      addedAt: serverTimestamp(),
    });
  }
}

export type BookmarkListItem = {
  spotId: string;
  title: string;
  imageUrl: string;
  latitude: number;
  longitude: number;
  address: string;
  addedAtMs: number;
};

export function subscribeMyBookmarks(
  uid: string,
  onChange: (items: BookmarkListItem[]) => void
): () => void {
  const q = query(collection(db, 'users', uid, 'bookmarks'));
  return onSnapshot(q, (snap) => {
    const items: BookmarkListItem[] = snap.docs.map((d) => {
      const x = d.data();
      const ts = x.addedAt;
      let addedAtMs = 0;
      if (ts && typeof ts.toMillis === 'function') addedAtMs = ts.toMillis();
      else if (ts && typeof ts.seconds === 'number') addedAtMs = ts.seconds * 1000;
      return {
        spotId: d.id,
        title: (x.title as string) || '',
        imageUrl: (x.imageUrl as string) || '',
        latitude: Number(x.latitude) || 0,
        longitude: Number(x.longitude) || 0,
        address: (x.address as string) || '',
        addedAtMs,
      };
    });
    items.sort((a, b) => b.addedAtMs - a.addedAtMs);
    onChange(items);
  });
}
