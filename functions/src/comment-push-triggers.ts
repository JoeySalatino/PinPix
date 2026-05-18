import { getFirestore } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions/v2';
import {
  commentLikedBody,
  commentOnSpotBody,
  mentionOnSpotBody,
  replyOnSpotBody,
  replyToCommentBody,
} from './push-copy';
import { displayNameForUser, sendPushToUser } from './push';

/** @handle tokens in comment text (Firestore usernames are lowercase 1–40). */
function extractMentionSlugs(text: string): string[] {
  const re = /@([a-z0-9_]+)/gi;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const slug = m[1].toLowerCase();
    if (!slug || slug.length > 40) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

async function uidForUsername(
  db: ReturnType<typeof getFirestore>,
  username: string
): Promise<string | null> {
  try {
    const q = await db.collection('users').where('username', '==', username).limit(1).get();
    if (q.empty) return null;
    return q.docs[0].id;
  } catch (e) {
    logger.warn('uidForUsername query failed', { username, err: String(e) });
    return null;
  }
}

/** New comment or reply on a spot — notifies spot owner, parent author (reply), spot owner on others’ threads, and @mentioned users. */
export const onSpotCommentCreatedPush = onDocumentCreated(
  { document: 'spots/{spotId}/comments/{commentId}', region: 'us-central1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const spotId = event.params.spotId as string;
    const commentId = event.params.commentId as string;
    const d = snap.data() as Record<string, unknown>;
    const authorUid = typeof d.userId === 'string' ? d.userId : '';
    const parentRaw = d.parentCommentId;
    const parentId =
      typeof parentRaw === 'string' && parentRaw.trim().length > 0 ? parentRaw.trim() : '';
    const textRaw = typeof d.text === 'string' ? d.text : '';

    if (!authorUid) return;

    const db = getFirestore();
    let spotSnap;
    try {
      spotSnap = await db.doc(`spots/${spotId}`).get();
    } catch (e) {
      logger.error('onSpotCommentCreatedPush spot read failed', { spotId, err: String(e) });
      return;
    }
    if (!spotSnap.exists) return;
    const sd = spotSnap.data() as Record<string, unknown>;
    const ownerUid = typeof sd.userId === 'string' ? sd.userId : '';
    const spotTitle = typeof sd.title === 'string' && sd.title.trim() ? sd.title.trim() : 'your spot';

    let actorName: string;
    try {
      actorName = await displayNameForUser(authorUid);
    } catch (e) {
      logger.warn('onSpotCommentCreatedPush displayName failed', { authorUid, err: String(e) });
      actorName = 'Someone';
    }

    const notified = new Set<string>();

    const tryNotify = async (
      uid: string,
      copy: { title: string; body: string },
      activity: string
    ) => {
      if (!uid || uid === authorUid || notified.has(uid)) return;
      try {
        await sendPushToUser(uid, (p) => p.pushEnabled && p.pushCommentActivity, {
          title: copy.title,
          body: copy.body,
          data: {
            type: 'comment_activity',
            spotId: String(spotId),
            commentId: String(commentId),
            activity,
          },
        });
        notified.add(uid);
      } catch (e) {
        logger.error('onSpotCommentCreatedPush send failed', { spotId, commentId, uid, err: String(e) });
      }
    };

    try {
      if (parentId) {
        let parentSnap;
        try {
          parentSnap = await db.doc(`spots/${spotId}/comments/${parentId}`).get();
        } catch (e) {
          logger.error('onSpotCommentCreatedPush parent read failed', { spotId, parentId, err: String(e) });
          return;
        }
        if (!parentSnap.exists) return;
        const pd = parentSnap.data() as Record<string, unknown>;
        const parentAuthor = typeof pd.userId === 'string' ? pd.userId : '';

        if (parentAuthor && parentAuthor !== authorUid) {
          await tryNotify(parentAuthor, replyToCommentBody(actorName, spotTitle), 'reply');
        }

        if (ownerUid) {
          await tryNotify(ownerUid, replyOnSpotBody(actorName, spotTitle), 'spot_reply');
        }
      } else {
        if (ownerUid && ownerUid !== authorUid) {
          await tryNotify(ownerUid, commentOnSpotBody(actorName, spotTitle), 'comment');
        }
      }

      const slugs = extractMentionSlugs(textRaw);
      const mentionUids = (
        await Promise.all(slugs.map((slug) => uidForUsername(db, slug)))
      ).filter((u): u is string => !!u);

      for (const uid of [...new Set(mentionUids)]) {
        await tryNotify(uid, mentionOnSpotBody(actorName, spotTitle), 'mention');
      }
    } catch (e) {
      logger.error('onSpotCommentCreatedPush handler failed', { spotId, commentId, err: String(e) });
    }
  }
);

/** Like on a comment — notifies the comment author (not spot owner unless same). */
export const onSpotCommentLikeCreatedPush = onDocumentCreated(
  { document: 'spots/{spotId}/comments/{commentId}/likes/{likeUid}', region: 'us-central1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const spotId = event.params.spotId as string;
    const commentId = event.params.commentId as string;
    const likeUid = event.params.likeUid as string;

    const db = getFirestore();
    let commentSnap;
    try {
      commentSnap = await db.doc(`spots/${spotId}/comments/${commentId}`).get();
    } catch (e) {
      logger.error('onSpotCommentLikeCreatedPush comment read failed', { spotId, commentId, err: String(e) });
      return;
    }
    if (!commentSnap.exists) return;
    const cd = commentSnap.data() as Record<string, unknown>;
    const commentAuthor = typeof cd.userId === 'string' ? cd.userId : '';
    if (!commentAuthor || commentAuthor === likeUid) return;

    let spotTitle = 'a spot';
    try {
      const spotSnap = await db.doc(`spots/${spotId}`).get();
      if (spotSnap.exists) {
        const s = spotSnap.data() as Record<string, unknown>;
        if (typeof s.title === 'string' && s.title.trim()) spotTitle = s.title.trim();
      }
    } catch {
      // non-fatal
    }

    let likerName: string;
    try {
      likerName = await displayNameForUser(likeUid);
    } catch (e) {
      logger.warn('onSpotCommentLikeCreatedPush displayName failed', { likeUid, err: String(e) });
      likerName = 'Someone';
    }

    const copy = commentLikedBody(likerName, spotTitle);
    try {
      await sendPushToUser(commentAuthor, (p) => p.pushEnabled && p.pushCommentActivity, {
        title: copy.title,
        body: copy.body,
        data: {
          type: 'comment_activity',
          spotId: String(spotId),
          commentId: String(commentId),
          activity: 'comment_like',
        },
      });
    } catch (e) {
      logger.error('onSpotCommentLikeCreatedPush send failed', { spotId, commentId, err: String(e) });
    }
  }
);
