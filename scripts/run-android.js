/**
 * Runs `expo run:android` with JAVA_HOME set on Windows when the shell
 * has not picked up user environment variables yet (common in IDE terminals).
 */
const { spawnSync } = require('child_process');
const path = require('path');

const isWin = process.platform === 'win32';
const defaultJbr = 'C:\\Program Files\\Android\\Android Studio\\jbr';

if (isWin) {
  if (!process.env.JAVA_HOME) {
    process.env.JAVA_HOME = defaultJbr;
    const javaBin = path.join(defaultJbr, 'bin');
    process.env.Path = `${javaBin};${process.env.Path || ''}`;
  }
  // Keep Gradle caches off OneDrive-synced profile (avoids corrupt transforms).
  if (!process.env.GRADLE_USER_HOME) {
    process.env.GRADLE_USER_HOME = 'C:\\gradle';
  }
  const sdk = process.env.LOCALAPPDATA + '\\Android\\Sdk';
  if (!process.env.ANDROID_HOME) {
    process.env.ANDROID_HOME = sdk;
  }
  const adb = sdk + '\\platform-tools';
  if (!process.env.Path.includes(adb)) {
    process.env.Path = `${adb};${process.env.Path || ''}`;
  }
}

const result = spawnSync(
  'npx',
  ['expo', 'run:android', ...process.argv.slice(2)],
  { stdio: 'inherit', env: process.env, shell: isWin }
);

process.exit(result.status ?? 1);
