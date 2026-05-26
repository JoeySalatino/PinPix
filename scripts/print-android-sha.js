/**
 * Prints SHA-1/SHA-256 for local Android debug builds and checks google-services.json.
 * Add missing fingerprints in Firebase → Project settings → Android app (com.pinpix.android),
 * then re-download google-services.json.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const debugKeystore = path.join(root, 'android', 'app', 'debug.keystore');
const googleServicesPath = path.join(root, 'google-services.json');

function findKeytool() {
  const candidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'keytool.exe'),
    'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\keytool.exe',
    'keytool',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c === 'keytool' || fs.existsSync(c)) return c;
    } catch {
      /* continue */
    }
  }
  return 'keytool';
}

function parseFingerprints(output) {
  const sha1 = output.match(/SHA1:\s*([0-9A-F:]+)/i)?.[1] ?? null;
  const sha256 = output.match(/SHA256:\s*([0-9A-F:]+)/i)?.[1] ?? null;
  return { sha1, sha256 };
}

function normalizeSha1(sha1) {
  return sha1.replace(/:/g, '').toLowerCase();
}

function readGoogleServicesInfo() {
  if (!fs.existsSync(googleServicesPath)) {
    return { sha1Hashes: [], webClientId: null };
  }
  const json = JSON.parse(fs.readFileSync(googleServicesPath, 'utf8'));
  const sha1Hashes = [];
  let webClientId = null;
  for (const client of json.client ?? []) {
    for (const oauth of client.oauth_client ?? []) {
      const hash = oauth.android_info?.certificate_hash;
      if (hash) sha1Hashes.push(hash.toLowerCase());
      if (oauth.client_type === 3 && oauth.client_id) {
        webClientId = oauth.client_id;
      }
    }
  }
  return { sha1Hashes: [...new Set(sha1Hashes)], webClientId };
}

function main() {
  console.log('PinPix Android signing fingerprints\n');

  if (!fs.existsSync(debugKeystore)) {
    console.log('No android/app/debug.keystore yet. Run: npm run android');
    process.exit(1);
  }

  const keytool = findKeytool();
  let output;
  try {
    output = execSync(
      `"${keytool}" -list -v -keystore "${debugKeystore}" -alias androiddebugkey -storepass android -keypass android`,
      { encoding: 'utf8' }
    );
  } catch (err) {
    console.error('Could not run keytool:', err.message);
    process.exit(1);
  }

  const { sha1, sha256 } = parseFingerprints(output);
  if (!sha1) {
    console.error('Could not read SHA-1 from debug keystore.');
    process.exit(1);
  }

  const { sha1Hashes: registered, webClientId } = readGoogleServicesInfo();
  const debugNorm = normalizeSha1(sha1);
  const inGoogleServices = registered.includes(debugNorm);

  console.log('Local debug build (npm run android):');
  console.log(`  SHA-1:   ${sha1}`);
  console.log(`  SHA-256: ${sha256 ?? '(not found)'}`);
  console.log(
    inGoogleServices
      ? '\n  ✓ Debug SHA-1 is listed in google-services.json'
      : '\n  ✗ Debug SHA-1 is NOT in google-services.json — Google Sign-In will show DEVELOPER_ERROR locally'
  );

  if (registered.length) {
    console.log('\nSHA-1 hashes currently in google-services.json:');
    for (const h of registered) {
      console.log(`  - ${h}`);
    }
  }

  if (webClientId) {
    console.log('\nGOOGLE_WEB_CLIENT_ID (EAS production + local .env) must be exactly:');
    console.log(`  ${webClientId}`);
    console.log('  Use the Web client (type 3), NOT an Android client ID from the list above.');
  }

  console.log(`
If Google Sign-In still fails after SHA-1s are in google-services.json:
1. Play Console → App integrity → "App signing key certificate" SHA-1 must match one hash above.
   (Play Store installs use that key, not the upload key.)
2. expo.dev → PinPix → Environment variables → GOOGLE_WEB_CLIENT_ID = Web client above.
3. Firebase → Authentication → Sign-in method → Google → Enabled.
4. Google Cloud → OAuth consent screen → add your Google account as a test user if app is in "Testing".
5. Rebuild native app (OTA updates do not refresh google-services.json):
   eas build --platform android --profile production
`);
}

main();
