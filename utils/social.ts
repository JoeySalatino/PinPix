// ============================================================
// social.ts — Follows, bookmarks, spot likes (Firestore)
// ------------------------------------------------------------
// friendRequests/{fromUid_toUid}: fromUid wants to follow toUid (private accounts only).
// users/{uid}.following / followers — one-way follow; denormalized followers[] for counts.
// users/{uid}/bookmarks/{spotId}: denormalized fields for list UI.
// spots/{spotId}/likes/{userId}: { createdAt } — one doc per like.
// ============================================================

import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { spotGalleryUrls } from '../components/types';
import { auth, db } from './firebase';

export function followRequestDocId(fromUid: string, toUid: string) {
  return `${fromUid}_${toUid}`;
}

/** @deprecated same as followRequestDocId — kept for searchability */
export const friendRequestDocId = followRequestDocId;

/** Effective following list including legacy `friends` until migrated. */
export function followingUidList(data: Record<string, unknown> | undefined | null): string[] {
  if (!data) return [];
  const fo = (data.following as string[] | undefined) || [];
  const leg = (data.friends as string[] | undefined) || [];
  return [...new Set([...fo, ...leg])];
}

/** UIDs who follow this user (denormalized; maintained on follow / unfollow / accept). */
export function followerUidList(data: Record<string, unknown> | undefined | null): string[] {
  if (!data) return [];
  return (data.followers as string[] | undefined) || [];
}

/** Copies legacy friends[] into following[] once, then removes friends. */
export async function ensureFollowingMigrated(uid: string): Promise<void> {
  const ref = doc(db, 'users', uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const d = snap.data() as Record<string, unknown>;
  const legacy = (d.friends as string[] | undefined) || [];
  if (legacy.length === 0) return;
  const cur = (d.following as string[] | undefined) || [];
  const merged = [...new Set([...cur, ...legacy])];
  try {
    await updateDoc(ref, { following: merged, friends: deleteField() });
  } catch {
    // Non-fatal — UI still merges via followingUidList
  }
}

/**
 * Follow a public profile immediately, or create a pending request for a private profile
 * (`profileVisible === false`).
 */
export async function followUser(toUid: string) {
  const me = auth.currentUser?.uid;
  if (!me || me === toUid) return { ok: false as const, error: 'Not signed in' };

  const [meSnap, targetSnap] = await Promise.all([getDoc(doc(db, 'users', me)), getDoc(doc(db, 'users', toUid))]);
  if (!targetSnap.exists()) return { ok: false as const, error: 'User not found' };

  const myFollowing = followingUidList(meSnap.data() as Record<string, unknown>);
  if (myFollowing.includes(toUid)) return { ok: false as const, error: 'Already following' };

  const targetPrivate = (targetSnap.data()?.profileVisible as boolean | undefined) === false;

  if (!targetPrivate) {
    const batch = writeBatch(db);
    batch.update(doc(db, 'users', me), { following: arrayUnion(toUid) });
    batch.update(doc(db, 'users', toUid), { followers: arrayUnion(me) });
    await batch.commit();
    return { ok: true as const };
  }

  const rid = followRequestDocId(me, toUid);
  const ref = doc(db, 'friendRequests', rid);
  const existing = await getDoc(ref);
  if (existing.exists()) {
    const st = existing.data()?.status;
    if (st === 'pending') return { ok: false as const, error: 'Request already sent' };
  }
  const reverse = await getDoc(doc(db, 'friendRequests', followRequestDocId(toUid, me)));
  if (reverse.exists() && reverse.data()?.status === 'pending') {
    return {
      ok: false as const,
      error: 'This person already sent you a request — check Follow hub.',
    };
  }

  await setDoc(ref, {
    fromUid: me,
    toUid,
    status: 'pending',
    createdAt: serverTimestamp(),
  });
  return { ok: true as const };
}

/** Accepter (private profile owner) approves follower `fromUid` — they will follow you. */
export async function acceptFollowRequest(fromUid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = auth.currentUser?.uid;
  if (!me) return { ok: false, error: 'Not signed in' };
  const rid = followRequestDocId(fromUid, me);
  const ref = doc(db, 'friendRequests', rid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ok: false, error: 'No request found' };
  const d = snap.data();
  if (d?.status !== 'pending' || d?.toUid !== me) return { ok: false, error: 'Invalid or expired request' };

  try {
    const batch = writeBatch(db);
    batch.delete(ref);
    batch.update(doc(db, 'users', fromUid), { following: arrayUnion(me) });
    batch.update(doc(db, 'users', me), { followers: arrayUnion(fromUid) });
    await batch.commit();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Could not accept request';
    return { ok: false, error: msg };
  }
}

export async function declineFollowRequest(fromUid: string) {
  const me = auth.currentUser?.uid;
  if (!me) return;
  const rid = followRequestDocId(fromUid, me);
  await deleteDoc(doc(db, 'friendRequests', rid));
}

export async function cancelOutgoingFollowRequest(toUid: string) {
  const me = auth.currentUser?.uid;
  if (!me) return;
  const rid = followRequestDocId(me, toUid);
  await deleteDoc(doc(db, 'friendRequests', rid));
}

/** Stop following someone (one-way). Clears stale request docs between you two. */
export async function unfollow(otherUid: string) {
  const me = auth.currentUser?.uid;
  if (!me || !otherUid || me === otherUid) return;
  const id1 = followRequestDocId(me, otherUid);
  const id2 = followRequestDocId(otherUid, me);
  const [d1, d2, meSnap, otherSnap] = await Promise.all([
    getDoc(doc(db, 'friendRequests', id1)),
    getDoc(doc(db, 'friendRequests', id2)),
    getDoc(doc(db, 'users', me)),
    getDoc(doc(db, 'users', otherUid)),
  ]);

  const batch = writeBatch(db);

  // Only touch `friends` if it is still a real array. After `ensureFollowingMigrated`,
  // `friends` is removed — Firestore rejects arrayRemove on a missing/non-array field.
  const myData = meSnap.exists() ? (meSnap.data() as Record<string, unknown>) : {};
  const friendsRaw = myData.friends;
  const myPatch: Record<string, unknown> = { following: arrayRemove(otherUid) };
  if (Array.isArray(friendsRaw) && friendsRaw.includes(otherUid)) {
    myPatch.friends = arrayRemove(otherUid);
  }
  batch.update(doc(db, 'users', me), myPatch);

  // Legacy mutual "friends" often had no symmetric `followers[]`. Rules require
  // followers.size to drop by exactly 1 when we write — skip if we're not listed.
  const theirFollowers = otherSnap.exists() ? (otherSnap.data()?.followers as unknown) : undefined;
  if (Array.isArray(theirFollowers) && theirFollowers.includes(me)) {
    batch.update(doc(db, 'users', otherUid), { followers: arrayRemove(me) });
  }

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

/** Recent spots from users you follow (Firestore `in` max 10 per query). */
export async function fetchFollowingRecentSpots(followingUids: string[]): Promise<FriendActivitySpot[]> {
  if (followingUids.length === 0) return [];
  const all: FriendActivitySpot[] = [];
  for (const group of chunkIds(followingUids, 10)) {
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
      if (urls.length === 0) return;
      all.push({
        id: docSnap.id,
        userId: (d.userId as string) || '',
        authorUsername: ((d.displayUsername || d.username) as string) || '',
        title: (d.title as string) || '',
        imageUrl: urls[0],
        latitude: Number(d.location.latitude) || 0,
        longitude: Number(d.location.longitude) || 0,
        createdAtMs: ms,
      });
    });
  }
  all.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return all.slice(0, 100);
}

/** @deprecated use fetchFollowingRecentSpots */
export const fetchFriendsRecentSpots = fetchFollowingRecentSpots;

/**
 * Live inbox of follow requests addressed to `uid` (private profile owners).
 * Uses a single equality on `toUid` and filters `status === 'pending'` client-side.
 */
export function subscribeIncomingFollowRequests(
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

/** @deprecated use subscribeIncomingFollowRequests */
export const subscribeIncomingFriendRequests = subscribeIncomingFollowRequests;

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
