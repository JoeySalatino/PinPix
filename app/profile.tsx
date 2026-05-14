// ============================================================
// profile.tsx — Legacy route → main Profile tab
// ------------------------------------------------------------
// Deep links and old code may still open /profile; keep a redirect.
// ============================================================

import { Redirect } from 'expo-router';

export default function ProfileRedirectScreen() {
  return <Redirect href="/main/profile" />;
}
