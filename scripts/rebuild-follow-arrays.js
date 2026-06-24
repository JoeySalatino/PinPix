/**
 * Rebuild denormalized following[] / followers[] on a user doc from inverse
 * references elsewhere in Firestore (fixes "app shows 0 but relationships
 * still exist on other users' docs").
 *
 * Usage:
 *   node scripts/rebuild-follow-arrays.js YOUR_FIREBASE_UID
 *   node scripts/rebuild-follow-arrays.js YOUR_FIREBASE_UID --dry-run
 *
 * Auth: same as scripts/clear-follow-graph.js (service account or firebase login).
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'pinpix-app';

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const uid = positional[2];
  if (!uid || uid.startsWith('--')) {
    console.error('Usage: node scripts/rebuild-follow-arrays.js <UID> [--dry-run]');
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

function coerceUidList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x) => typeof x === 'string' && x.length > 0);
}

async function main() {
  const { uid, dryRun } = parseArgs(process.argv);
  await ensureCredentials();
  const admin = loadAdmin();

  if (admin.apps.length === 0) {
    admin.initializeApp({ projectId: PROJECT_ID });
  }
  const db = admin.firestore();

  console.log(`Project: ${PROJECT_ID}`);
  console.log(`UID:     ${uid}`);
  console.log(`Mode:    ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log('');

  const ownRef = db.doc(`users/${uid}`);
  const ownSnap = await ownRef.get();
  if (!ownSnap.exists) {
    console.error('users/{uid} does not exist — create the profile first.');
    process.exit(1);
  }

  const own = ownSnap.data();
  const curFollowing = coerceUidList(own.following);
  const curFollowers = coerceUidList(own.followers);
  const legacyFriends = coerceUidList(own.friends);

  console.log('Current doc (what the app reads):');
  console.log(`  following: ${curFollowing.length}`);
  console.log(`  followers: ${curFollowers.length}`);
  console.log(`  friends:   ${legacyFriends.length}`);
  console.log('');

  const [followingMeSnap, iFollowSnap, friendsSnap] = await Promise.all([
    db.collection('users').where('following', 'array-contains', uid).get(),
    db.collection('users').where('followers', 'array-contains', uid).get(),
    db.collection('users').where('friends', 'array-contains', uid).get(),
  ]);

  const rebuiltFollowers = [...new Set(followingMeSnap.docs.map((d) => d.id))].sort();
  const rebuiltFollowing = [
    ...new Set([
      ...iFollowSnap.docs.map((d) => d.id),
      ...friendsSnap.docs.map((d) => d.id),
      ...legacyFriends,
      ...curFollowing,
    ]),
  ].sort();

  console.log('Rebuilt from inverse references:');
  console.log(`  followers: ${rebuiltFollowers.length} (others with you in their following[])`);
  console.log(
    `  following: ${rebuiltFollowing.length} (others with you in their followers[] + legacy friends)`
  );
  console.log('');

  if (
    rebuiltFollowers.length === curFollowers.length &&
    rebuiltFollowing.length === curFollowing.length &&
    rebuiltFollowers.every((id, i) => id === [...curFollowers].sort()[i]) &&
    rebuiltFollowing.every((id, i) => id === [...curFollowing].sort()[i])
  ) {
    console.log('No change needed — arrays already match rebuilt values.');
    return;
  }

  if (dryRun) {
    console.log('Would write:');
    console.log(`  followers: [${rebuiltFollowers.slice(0, 5).join(', ')}${rebuiltFollowers.length > 5 ? ', …' : ''}]`);
    console.log(`  following: [${rebuiltFollowing.slice(0, 5).join(', ')}${rebuiltFollowing.length > 5 ? ', …' : ''}]`);
    console.log('');
    console.log('Re-run without --dry-run to apply.');
    return;
  }

  await ownRef.update({
    followers: rebuiltFollowers,
    following: rebuiltFollowing,
  });
  console.log('Done — followers/following updated on users/{uid}.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
