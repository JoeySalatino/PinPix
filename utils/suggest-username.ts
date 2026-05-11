// ============================================================
// suggest-username.ts — Username suggestion (no native deps)
// ------------------------------------------------------------
// Kept separate from social-auth.ts so screens like complete-profile
// can import this without pulling in @react-native-google-signin,
// which would crash Expo Go on module load.
// ============================================================

export function suggestUsername(opts: {
  email: string | null;
  displayName: string | null;
}): string {
  const { email, displayName } = opts;

  if (email) {
    const local = email.split('@')[0];
    const cleaned = local.replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
    if (cleaned.length >= 3) return cleaned.slice(0, 20);
  }

  if (displayName) {
    const cleaned = displayName
      .split(/\s+/)[0]
      .replace(/[^a-zA-Z0-9_]/g, '')
      .toLowerCase();
    if (cleaned.length >= 3) return cleaned.slice(0, 20);
  }

  return '';
}
