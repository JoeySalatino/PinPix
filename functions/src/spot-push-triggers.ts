import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { incrementDigestCounter } from './digest-counters';
import { geohash5Neighborhood, haversineKm } from './geo';
import { displayNameForUser, getUserNotifyPrefs, sendPushToUser } from './push';

const NEARBY_MAX_KM = 42;

function trunc(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

type SpotLoc = { latitude: number; longitude: number };

function readSpotLocation(data: Record<string, unknown>): SpotLoc | null {
  const loc = data.location as Record<string, unknown> | undefined;
  if (!loc) return null;
  const lat = loc.latitude;
  const lng = loc.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { latitude: lat, longitude: lng };
}

export const onSpotCreatedNearbyPush = onDocumentCreated(
  { document: 'spots/{spotId}', region: 'us-central1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const spotId = event.params.spotId as string;
    const d = snap.data() as Record<string, unknown>;
    const ownerUid = typeof d.userId === 'string' ? d.userId : '';
    const title = typeof d.title === 'string' ? d.title : 'New spot';
    const loc = readSpotLocation(d);
    if (!loc || !ownerUid) return;

    const cells = geohash5Neighborhood(loc.latitude, loc.longitude);
    const db = getFirestore();
    const seen = new Set<string>();
    const actorName = await displayNameForUser(ownerUid);

    const cellSnaps = await Promise.all(
      cells.map((cell) => db.collection('users').where('mapGeohash5', '==', cell).limit(80).get())
    );

    for (const qSnap of cellSnaps) {
      for (const doc of qSnap.docs) {
        const uid = doc.id;
        if (uid === ownerUid || seen.has(uid)) continue;

        const u = doc.data() as Record<string, unknown>;
        const uLat = u.mapLat;
        const uLng = u.mapLng;
        if (typeof uLat !== 'number' || typeof uLng !== 'number') continue;
        if (haversineKm(loc.latitude, loc.longitude, uLat, uLng) > NEARBY_MAX_KM) continue;

        seen.add(uid);

        const prefs = await getUserNotifyPrefs(uid);
        if (prefs.pushEnabled && prefs.pushNearbySpots) {
          await incrementDigestCounter(uid, 'digestNearbyWeek');
        }

        await sendPushToUser(uid, (p) => p.pushEnabled && p.pushNearbySpots, {
          title: 'PinPix',
          body: `${trunc(title, 48)} — new spot near you by @${trunc(actorName, 20)}`,
          data: {
            type: 'nearby_spot',
            spotId,
          },
        });
      }
    }
  }
);

export const onSpotLikeCreatedPush = onDocumentCreated(
  { document: 'spots/{spotId}/likes/{likeUid}', region: 'us-central1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const spotId = event.params.spotId as string;
    const likeUid = event.params.likeUid as string;

    const spotSnap = await getFirestore().doc(`spots/${spotId}`).get();
    if (!spotSnap.exists) return;
    const sd = spotSnap.data() as Record<string, unknown>;
    const ownerUid = typeof sd.userId === 'string' ? sd.userId : '';
    if (!ownerUid || ownerUid === likeUid) return;

    const title = typeof sd.title === 'string' ? sd.title : 'your spot';
    const likerName = await displayNameForUser(likeUid);

    await incrementDigestCounter(ownerUid, 'digestLikesWeek');

    await sendPushToUser(ownerUid, (p) => p.pushEnabled && p.pushFavoriteActivity, {
      title: 'PinPix',
      body: `@${trunc(likerName, 22)} liked ${trunc(title, 40)}`,
      data: {
        type: 'spot_activity',
        spotId,
        activity: 'like',
      },
    });
  }
);

export const onBookmarkCreatedSpotActivityPush = onDocumentCreated(
  { document: 'users/{userId}/bookmarks/{spotId}', region: 'us-central1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const bookmarkerUid = event.params.userId as string;
    const spotId = event.params.spotId as string;

    const spotSnap = await getFirestore().doc(`spots/${spotId}`).get();
    if (!spotSnap.exists) return;
    const sd = spotSnap.data() as Record<string, unknown>;
    const ownerUid = typeof sd.userId === 'string' ? sd.userId : '';
    if (!ownerUid || ownerUid === bookmarkerUid) return;

    const title = typeof sd.title === 'string' ? sd.title : 'your spot';
    const name = await displayNameForUser(bookmarkerUid);

    await incrementDigestCounter(ownerUid, 'digestBookmarksWeek');

    await sendPushToUser(ownerUid, (p) => p.pushEnabled && p.pushFavoriteActivity, {
      title: 'PinPix',
      body: `@${trunc(name, 22)} saved ${trunc(title, 40)}`,
      data: {
        type: 'spot_activity',
        spotId,
        activity: 'bookmark',
      },
    });
  }
);

/** Monday 14:00 UTC — weekly recap push for users who opted in. */
export const weeklyDigestPush = onSchedule(
  { schedule: '0 14 * * 1', timeZone: 'Etc/UTC', region: 'us-central1' },
  async () => {
    const db = getFirestore();
    let last: DocumentSnapshot | undefined;
    let total = 0;

    for (;;) {
      let q = db
        .collection('users')
        .where('pushWeeklyDigest', '==', true)
        .orderBy(FieldPath.documentId())
        .limit(300);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        last = doc;
        const d = doc.data() as Record<string, unknown>;
        const likes = Number(d.digestLikesWeek) || 0;
        const saves = Number(d.digestBookmarksWeek) || 0;
        const near = Number(d.digestNearbyWeek) || 0;

        const parts: string[] = [];
        if (likes > 0) parts.push(`${likes} like${likes === 1 ? '' : 's'} on your spots`);
        if (saves > 0) parts.push(`${saves} new save${saves === 1 ? '' : 's'}`);
        if (near > 0) parts.push(`${near} new spot${near === 1 ? '' : 's'} near you`);

        const body =
          parts.length > 0
            ? `This week: ${parts.join(', ')}. Open PinPix for more.`
            : 'Your PinPix week in review — see what\'s new on the map.';

        try {
          await sendPushToUser(doc.id, (p) => p.pushEnabled && p.pushWeeklyDigest, {
            title: 'PinPix — weekly summary',
            body,
            data: { type: 'weekly_digest' },
          });
          await doc.ref.update({
            digestLikesWeek: 0,
            digestBookmarksWeek: 0,
            digestNearbyWeek: 0,
          });
          total += 1;
        } catch (e) {
          logger.error('weeklyDigestPush user failed', { uid: doc.id, err: String(e) });
        }
      }

      if (snap.size < 300) break;
    }

    logger.info('weeklyDigestPush finished', { usersProcessed: total });
  }
);
