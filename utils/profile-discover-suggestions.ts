// ============================================================
// profile-discover-suggestions.ts — Non-contact profile picks
// ------------------------------------------------------------
// Recent public profiles for the Profile tab "Suggested for you"
// strip (same peek cards as contact matches).
// ============================================================

import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { db } from './firebase';
import type { ContactMatchedUser } from './contact-follow-discovery';

function mapUserDoc(docSnap: { id: string; data: () => Record<string, unknown> }): ContactMatchedUser {
  const d = docSnap.data();
  const phone = d.contactMatchPhoneE164;
  return {
    uid: docSnap.id,
    email: String(d.email || ''),
    contactMatchPhoneE164: typeof phone === 'string' && phone.startsWith('+') ? phone : null,
    displayUsername: (d.displayUsername || d.username || 'user') as string,
    usernameSlug: ((d.username as string) || (d.displayUsername as string) || 'user').toLowerCase(),
  };
}

/**
 * Recent users (by `createdAt` on the profile doc), excluding self, people you
 * already follow, blocked accounts, private profiles, and anyone in `excludeUids`
 * (e.g. contact matches shown in the other strip).
 */
export async function fetchDiscoverProfileSuggestions(opts: {
  myUid: string;
  followingUids: string[];
  blockedUserIds: string[];
  excludeUids: Set<string>;
  maxResults: number;
}): Promise<ContactMatchedUser[]> {
  const q = query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(80));
  const snap = await getDocs(q);
  const following = new Set(opts.followingUids);
  const blocked = new Set(opts.blockedUserIds);
  const out: ContactMatchedUser[] = [];

  for (const docSnap of snap.docs) {
    const id = docSnap.id;
    if (id === opts.myUid) continue;
    if (following.has(id)) continue;
    if (blocked.has(id)) continue;
    if (opts.excludeUids.has(id)) continue;
    const d = docSnap.data();
    if (d.profileVisible === false) continue;
    out.push(mapUserDoc(docSnap));
    if (out.length >= opts.maxResults) break;
  }

  return out;
}
