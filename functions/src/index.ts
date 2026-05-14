// ============================================================
// PinPix Cloud Functions
// ------------------------------------------------------------
// onReportCreated:
//   When a new document is written to /reports/{reportId}, we
//   email pinpixhelp@gmail.com with the details so we can
//   triage the report in real time.
//
// Configuration (set before deploying):
//   firebase functions:secrets:set GMAIL_USER
//   firebase functions:secrets:set GMAIL_APP_PASSWORD
//
// GMAIL_USER         e.g. pinpixhelp@gmail.com
// GMAIL_APP_PASSWORD App password generated at
//                    https://myaccount.google.com/apppasswords
//                    (requires 2-Step Verification on the Gmail account).
//
// To deploy:
//   cd functions
//   npm install
//   npm run build
//   firebase deploy --only functions
//
// Push (Expo): follow request, follow accepted, new follower, nearby spots, spot activity,
// comment activity (comment / reply / spot_reply / mention / comment like), weekly digest.
//   Reads users/{uid}/pushTokens and sends via expo-server-sdk (no extra secrets).
// ============================================================

import { onDocumentCreated, onDocumentDeleted, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { displayNameForUser, sendPushToUser } from './push';
export {
  onBookmarkCreatedSpotActivityPush,
  onSpotCreatedNearbyPush,
  onSpotLikeCreatedPush,
  weeklyDigestPush,
} from './spot-push-triggers';
export { onSpotCommentCreatedPush, onSpotCommentLikeCreatedPush } from './comment-push-triggers';

// Nodemailer is imported inside the handler so deploy-time code analysis
// does not time out loading a large dependency graph (see Firebase tip:
// https://firebase.google.com/docs/functions/tips#avoid_deployment_timeouts_during_initialization).

if (getApps().length === 0) {
  initializeApp();
}

const GMAIL_USER = defineSecret('GMAIL_USER');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');

// Where the moderation email goes. Change this if the support address moves.
const REPORT_RECIPIENT = 'pinpixhelp@gmail.com';

export const onReportCreated = onDocumentCreated(
  {
    document: 'reports/{reportId}',
    region: 'us-central1',
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const report = snap.data() as {
      spotId?: string;
      spotTitle?: string;
      reportedBy?: string;
      reason?: string;
      createdAt?: string;
    };

    // Best-effort fetch of the reported spot so the email has context.
    let spotSummary = '(spot not found)';
    let spotImageUrl: string | undefined;
    let spotOwnerUid: string | undefined;
    if (report.spotId) {
      try {
        const spotSnap = await getFirestore().doc(`spots/${report.spotId}`).get();
        if (spotSnap.exists) {
          const s = spotSnap.data() as Record<string, unknown>;
          spotSummary = [
            (s.title as string) || '(no title)',
            (s.caption as string) || '',
            (s.address as string) || '',
          ].filter(Boolean).join('\n');
          spotImageUrl = s.imageUrl as string | undefined;
          spotOwnerUid = s.userId as string | undefined;
        }
      } catch (err) {
        logger.warn('Failed to fetch spot for report email', err);
      }
    }

    // Best-effort fetch of the reporter username.
    let reporterLabel = report.reportedBy || '(unknown user)';
    if (report.reportedBy) {
      try {
        const userSnap = await getFirestore().doc(`users/${report.reportedBy}`).get();
        if (userSnap.exists) {
          const u = userSnap.data() as Record<string, unknown>;
          const display = (u.displayUsername as string) || (u.username as string);
          if (display) reporterLabel = `@${display} (${report.reportedBy})`;
        }
      } catch {
        // Non-fatal — fall through with uid only.
      }
    }

    const subject = `[PinPix Report] ${report.reason || 'No reason'} — ${report.spotTitle || report.spotId || 'unknown spot'}`;

    const lines = [
      'A new report was submitted in PinPix.',
      '',
      `Report ID:    ${event.params.reportId}`,
      `Reason:       ${report.reason || '(no reason)'}`,
      `Reported by:  ${reporterLabel}`,
      `Created:      ${report.createdAt || new Date().toISOString()}`,
      '',
      `Spot ID:      ${report.spotId || '(unknown)'}`,
      `Spot owner:   ${spotOwnerUid || '(unknown)'}`,
      `Spot title:   ${report.spotTitle || '(unknown)'}`,
      '',
      'Spot details:',
      spotSummary,
      '',
      spotImageUrl ? `Image: ${spotImageUrl}` : 'Image: (none)',
      '',
      'Review the report and take action in the Firebase Console:',
      'https://console.firebase.google.com/',
    ];

    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER.value(),
        pass: GMAIL_APP_PASSWORD.value(),
      },
    });

    await transporter.sendMail({
      from: `PinPix Reports <${GMAIL_USER.value()}>`,
      to: REPORT_RECIPIENT,
      subject,
      text: lines.join('\n'),
    });

    logger.info('Report email sent', { reportId: event.params.reportId });
  }
);

// ---- Push: follow request (private profile, pending) ----
export const onFriendRequestCreatedPush = onDocumentCreated(
  { document: 'friendRequests/{requestId}', region: 'us-central1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() as { fromUid?: string; toUid?: string; status?: string };
    if (d.status !== 'pending' || !d.toUid || !d.fromUid) return;
    const fromName = await displayNameForUser(d.fromUid);
    await sendPushToUser(
      d.toUid,
      (p) => p.pushEnabled && p.pushFriendRequests,
      {
        title: 'PinPix',
        body: `@${fromName} requested to follow you`,
        data: { type: 'follow_request', fromUid: d.fromUid },
      }
    );
  }
);

// ---- Push: follow request was removed — if requester now follows, they were accepted ----
export const onFollowRequestDeletedAcceptNotify = onDocumentDeleted(
  { document: 'friendRequests/{requestId}', region: 'us-central1' },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const old = snap.data() as { fromUid?: string; toUid?: string; status?: string } | undefined;
    if (!old?.fromUid || !old?.toUid) return;
    if (old.status !== 'pending') return;

    const fromUid = old.fromUid;
    const toUid = old.toUid;
    const db = getFirestore();

    let accepted = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 150));
      }
      try {
        const userSnap = await db.doc(`users/${fromUid}`).get();
        const following = (userSnap.data()?.following as string[] | undefined) ?? [];
        const friends = (userSnap.data()?.friends as string[] | undefined) ?? [];
        if (following.includes(toUid) || friends.includes(toUid)) {
          accepted = true;
          break;
        }
      } catch (err) {
        logger.warn('followRequestDeleted: read following failed', { fromUid, toUid, err });
      }
    }
    if (!accepted) return;

    // Only private profiles use the request/accept flow; public follows are instant and
    // should not surface an "accepted your follow request" push (stale request deletes, etc.).
    let accepterPrivate = false;
    try {
      const targetSnap = await db.doc(`users/${toUid}`).get();
      accepterPrivate = (targetSnap.data()?.profileVisible as boolean | undefined) === false;
    } catch (err) {
      logger.warn('followRequestDeleted: read accepter profile failed', { toUid, err });
      return;
    }
    if (!accepterPrivate) return;

    try {
      const accepterName = await displayNameForUser(toUid);
      await sendPushToUser(
        fromUid,
        (prefs) => prefs.pushEnabled && prefs.pushFriendRequests,
        {
          title: 'PinPix',
          body: `@${accepterName} accepted your follow request`,
          data: { type: 'follow_request_accepted', userId: toUid },
        }
      );
    } catch (err) {
      logger.warn('followRequestDeleted: accept notify failed', { fromUid, toUid, err });
    }
  }
);

// ---- Push: someone started following you (their following[] grew) ----
export const onUserFriendsUpdatedPush = onDocumentUpdated(
  { document: 'users/{userId}', region: 'us-central1' },
  async (event) => {
    const before = event.data?.before.data() as { following?: string[] } | undefined;
    const after = event.data?.after.data() as { following?: string[] } | undefined;
    const b = before?.following ?? [];
    const a = after?.following ?? [];
    if (JSON.stringify(b) === JSON.stringify(a)) return;
    const beforeSet = new Set(b);
    const followerUid = event.params.userId as string;
    const newlyFollowedUids = a.filter((uid) => !beforeSet.has(uid));
    if (newlyFollowedUids.length === 0) return;
    const followerName = await displayNameForUser(followerUid);
    for (const followedUid of newlyFollowedUids) {
      await sendPushToUser(
        followedUid,
        (prefs) => prefs.pushEnabled && prefs.pushFriendRequests,
        {
          title: 'PinPix',
          body: `@${followerName} followed you`,
          data: { type: 'new_follower', userId: followerUid },
        }
      );
    }
  }
);
