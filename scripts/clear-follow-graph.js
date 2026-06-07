/**
 * One-off: remove a user's UID from all follow-related Firestore data.
 *
 * Usage:
 *   node scripts/clear-follow-graph.js YOUR_FIREBASE_UID
 *   node scripts/clear-follow-graph.js YOUR_FIREBASE_UID --dry-run
 *
 * Auth (pick one):
 *   1. Service account JSON:
 *        set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\serviceAccountKey.json
 *   2. gcloud ADC:
 *        gcloud auth application-default login
 *        set GOOGLE_CLOUD_PROJECT=pinpix-app
 *
 * Get YOUR_FIREBASE_UID from Firebase Console → Authentication → Users.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'pinpix-app';
const BATCH_SIZE = 400;

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const uid = positional[2];
  if (!uid || uid.startsWith('--')) {
    console.error('Usage: node scripts/clear-follow-graph.js <UID> [--dry-run]');
    process.exit(1);
  }
  return { uid, dryRun: flags.has('--dry-run') };
}

function loadAdmin() {
  const adminPath = path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin');
  if (!fs.existsSync(adminPath)) {
    console.error('Missing firebase-admin. Run: npm install --prefix functions');
    process.exit(1);
  }
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(adminPath);
}

function resolveFirebaseToolsModule(subpath) {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'firebase-tools', subpath),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'firebase-tools', subpath),
    path.join(process.env.USERPROFILE || '', '.npm-global', 'node_modules', 'firebase-tools', subpath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find firebase-tools module: ${subpath}`);
}

async function ensureCredentials() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(`Auth: ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
    return;
  }

  try {
    const { getGlobalDefaultAccount } = require(resolveFirebaseToolsModule('lib/auth.js'));
    const { getCredentialPathAsync } = require(resolveFirebaseToolsModule('lib/defaultCredentials.js'));
    const account = getGlobalDefaultAccount();
    if (!account) {
      throw new Error('No Firebase CLI login found. Run: firebase login');
    }
    const credPath = await getCredentialPathAsync(account);
    if (!credPath) {
      throw new Error('Could not resolve Firebase CLI credentials.');
    }
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;
    console.log(`Auth: Firebase CLI (${account.user.email || account.user.uid})`);
  } catch (err) {
    console.error(
      'No credentials found. Run `firebase login`, or set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON.'
    );
    throw err;
  }
}

async function queryUsers(db, field, uid) {
  const snap = await db.collection('users').where(field, 'array-contains', uid).get();
  return snap.docs;
}

async function queryFriendRequests(db, field, uid) {
  const snap = await db.collection('friendRequests').where(field, '==', uid).get();
  return snap.docs;
}

async function commitBatches(db, ops, dryRun, label) {
  if (ops.length === 0) {
    console.log(`  ${label}: nothing to do`);
    return 0;
  }
  console.log(`  ${label}: ${ops.length} write(s)`);
  if (dryRun) return ops.length;

  let committed = 0;
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = ops.slice(i, i + BATCH_SIZE);
    for (const op of chunk) {
      if (op.type === 'update') batch.update(op.ref, op.data);
      else if (op.type === 'delete') batch.delete(op.ref);
    }
    await batch.commit();
    committed += chunk.length;
    console.log(`    committed ${committed}/${ops.length}`);
  }
  return committed;
}

async function main() {
  const { uid, dryRun } = parseArgs(process.argv);
  await ensureCredentials();
  const admin = loadAdmin();

  if (admin.apps.length === 0) {
    admin.initializeApp({ projectId: PROJECT_ID });
  }
  const db = admin.firestore();
  const FieldValue = admin.firestore.FieldValue;

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`UID:     ${uid}`);
  console.log(`Mode:    ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log('');

  const ownRef = db.doc(`users/${uid}`);
  const ownSnap = await ownRef.get();
  if (!ownSnap.exists) {
    console.warn('Warning: users/{uid} document does not exist — will still clean other docs.');
  } else {
    const d = ownSnap.data();
    console.log('Your doc today:');
    console.log(`  following: ${Array.isArray(d.following) ? d.following.length : '(missing)'}`);
    console.log(`  followers: ${Array.isArray(d.followers) ? d.followers.length : '(missing)'}`);
    console.log(`  friends:   ${Array.isArray(d.friends) ? d.friends.length : '(missing)'}`);
    console.log('');
  }

  const ops = [];

  // Others who follow you (your UID in their following[]).
  const inTheirFollowing = await queryUsers(db, 'following', uid);
  for (const doc of inTheirFollowing) {
    ops.push({
      type: 'update',
      ref: doc.ref,
      data: { following: FieldValue.arrayRemove(uid) },
      note: `remove from ${doc.id}.following`,
    });
  }

  // Others you follow (your UID in their followers[]).
  const inTheirFollowers = await queryUsers(db, 'followers', uid);
  for (const doc of inTheirFollowers) {
    if (doc.id === uid) continue;
    ops.push({
      type: 'update',
      ref: doc.ref,
      data: { followers: FieldValue.arrayRemove(uid) },
      note: `remove from ${doc.id}.followers`,
    });
  }

  // Legacy mutual friends[].
  const inTheirFriends = await queryUsers(db, 'friends', uid);
  for (const doc of inTheirFriends) {
    if (doc.id === uid) continue;
    ops.push({
      type: 'update',
      ref: doc.ref,
      data: { friends: FieldValue.arrayRemove(uid) },
      note: `remove from ${doc.id}.friends`,
    });
  }

  // Pending follow requests involving this user.
  const [outReqs, inReqs] = await Promise.all([
    queryFriendRequests(db, 'fromUid', uid),
    queryFriendRequests(db, 'toUid', uid),
  ]);
  const requestDocs = new Map();
  for (const doc of [...outReqs, ...inReqs]) requestDocs.set(doc.id, doc);
  for (const doc of requestDocs.values()) {
    ops.push({ type: 'delete', ref: doc.ref, note: `delete friendRequests/${doc.id}` });
  }

  // Reset own profile social fields.
  if (ownSnap.exists) {
    ops.push({
      type: 'update',
      ref: ownRef,
      data: {
        following: [],
        followers: [],
        friends: FieldValue.delete(),
      },
      note: 'clear own following/followers/friends',
    });
  }

  if (dryRun) {
    console.log('Planned changes:');
    for (const op of ops) console.log(`  - ${op.note}`);
    console.log('');
    console.log(`Total: ${ops.length} operation(s). Re-run without --dry-run to apply.`);
    return;
  }

  console.log('Applying…');
  await commitBatches(db, ops, false, 'follow graph cleanup');
  console.log('');
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
