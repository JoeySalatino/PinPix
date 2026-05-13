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
// Push (Expo): onFriendRequestCreatedPush, onUserFriendsUpdatedPush
//   Reads users/{uid}/pushTokens and sends via expo-server-sdk (no extra secrets).
// ============================================================

import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { displayNameForUser, sendPushToUser } from './push';

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

// ---- Push: friend request (pending) ----
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
        body: `@${fromName} sent you a friend request`,
        data: { type: 'friend_request', fromUid: d.fromUid },
      }
    );
  }
);

// ---- Push: mutual friends (friends[] grew) ----
export const onUserFriendsUpdatedPush = onDocumentUpdated(
  { document: 'users/{userId}', region: 'us-central1' },
  async (event) => {
    const before = event.data?.before.data() as { friends?: string[] } | undefined;
    const after = event.data?.after.data() as { friends?: string[] } | undefined;
    const b = before?.friends ?? [];
    const a = after?.friends ?? [];
    if (JSON.stringify(b) === JSON.stringify(a)) return;
    const beforeSet = new Set(b);
    const ownerUid = event.params.userId as string;
    const added = a.filter((uid) => !beforeSet.has(uid));
    if (added.length === 0) return;
    const actorName = await displayNameForUser(ownerUid);
    for (const newFriendUid of added) {
      await sendPushToUser(
        newFriendUid,
        (prefs) => prefs.pushEnabled && prefs.pushFriendRequests,
        {
          title: 'PinPix',
          body: `@${actorName} is now your friend`,
          data: { type: 'friend_added', userId: ownerUid },
        }
      );
    }
  }
);
