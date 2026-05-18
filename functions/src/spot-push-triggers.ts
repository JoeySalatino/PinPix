import type { DocumentSnapshot, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { FieldPath, GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { incrementDigestCounter } from './digest-counters';
import { geohash5Neighborhood, haversineKm } from './geo';
import { nearbySpotBody, spotLikedBody, spotSavedBody } from './push-copy';
import { displayNameForUser, getUserNotifyPrefs, sendPushToUser, weeklyDigestPushEnabled } from './push';

const NEARBY_MAX_KM = 42;
/** Only notify users whose device location was refreshed recently (see mapGeoAt). */
const MAX_USER_LOCATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function userLocationFreshEnough(data: Record<string, unknown>): boolean {
  const raw = data.mapGeoAt;
  if (!raw) return false;
  const ms = raw instanceof Timestamp ? raw.toMillis() : NaN;
  if (!Number.isFinite(ms)) return false;
  return Date.now() - ms <= MAX_USER_LOCATION_AGE_MS;
}

type SpotLoc = { latitude: number; longitude: number };

function readSpotLocation(data: Record<string, unknown>): SpotLoc | null {
  const raw = data.location;
  if (!raw || typeof raw !== 'object') return null;
  if (raw instanceof GeoPoint) {
    const { latitude: lat, longitude: lng } = raw;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { latitude: lat, longitude: lng };
  }
  const loc = raw as Record<string, unknown>;
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
        if (!userLocationFreshEnough(u)) continue;
        const uLat = u.mapLat;
        const uLng = u.mapLng;
        if (typeof uLat !== 'number' || typeof uLng !== 'number') continue;
        if (haversineKm(loc.latitude, loc.longitude, uLat, uLng) > NEARBY_MAX_KM) continue;

        seen.add(uid);

        try {
          const copy = nearbySpotBody(title, actorName);
          await sendPushToUser(uid, (p) => p.pushEnabled && p.pushNearbySpots, {
            title: copy.title,
            body: copy.body,
            data: {
              type: 'nearby_spot',
              spotId: String(spotId),
            },
          });

          const prefs = await getUserNotifyPrefs(uid);
          if (prefs.pushEnabled && prefs.pushNearbySpots) {
            await incrementDigestCounter(uid, 'digestNearbyWeek');
          }
        } catch (e) {
          logger.error('onSpotCreatedNearbyPush recipient failed', { uid, spotId, err: String(e) });
        }
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

    const likeCopy = spotLikedBody(likerName, title);
    await sendPushToUser(ownerUid, (p) => p.pushEnabled && p.pushFavoriteActivity, {
      title: likeCopy.title,
      body: likeCopy.body,
      data: {
        type: 'spot_activity',
        spotId: String(spotId),
        activity: 'like',
      },
    });

    await incrementDigestCounter(ownerUid, 'digestLikesWeek');
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

    const saveCopy = spotSavedBody(name, title);
    await sendPushToUser(ownerUid, (p) => p.pushEnabled && p.pushFavoriteActivity, {
      title: saveCopy.title,
      body: saveCopy.body,
      data: {
        type: 'spot_activity',
        spotId: String(spotId),
        activity: 'bookmark',
      },
    });

    await incrementDigestCounter(ownerUid, 'digestBookmarksWeek');
  }
);

async function forEachUserWhere(
  db: ReturnType<typeof getFirestore>,
  field: string,
  value: boolean,
  onPage: (docs: QueryDocumentSnapshot[]) => Promise<void>
): Promise<void> {
  let last: DocumentSnapshot | undefined;
  for (;;) {
    let q = db.collection('users').where(field, '==', value).orderBy(FieldPath.documentId()).limit(300);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    await onPage(snap.docs);
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 300) break;
  }
}

/** Monday 14:00 UTC — weekly recap push for users who opted in (including legacy `emailDigest`). */
export const weeklyDigestPush = onSchedule(
  { schedule: '0 14 * * 1', timeZone: 'Etc/UTC', region: 'us-central1' },
  async () => {
    const db = getFirestore();
    const seen = new Set<string>();
    let total = 0;

    const processWeeklyUser = async (doc: QueryDocumentSnapshot) => {
      const d = doc.data() as Record<string, unknown>;
      if (!weeklyDigestPushEnabled(d)) return;

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
          title: 'Weekly summary',
          body,
          data: { type: 'weekly_digest' },
        });
        try {
          await doc.ref.update({
            digestLikesWeek: 0,
            digestBookmarksWeek: 0,
            digestNearbyWeek: 0,
          });
        } catch (e) {
          logger.error('weeklyDigestPush digest reset failed', { uid: doc.id, err: String(e) });
        }
        total += 1;
      } catch (e) {
        logger.error('weeklyDigestPush user failed', { uid: doc.id, err: String(e) });
      }
    };

    await forEachUserWhere(db, 'pushWeeklyDigest', true, async (docs) => {
      for (const doc of docs) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        await processWeeklyUser(doc);
      }
    });

    await forEachUserWhere(db, 'emailDigest', true, async (docs) => {
      for (const doc of docs) {
        if (seen.has(doc.id)) continue;
        const d = doc.data() as Record<string, unknown>;
        if (d.pushWeeklyDigest === false) continue;
        seen.add(doc.id);
        await processWeeklyUser(doc);
      }
    });

    logger.info('weeklyDigestPush finished', { usersProcessed: total });
  }
);
