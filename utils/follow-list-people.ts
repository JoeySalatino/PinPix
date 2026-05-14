// ============================================================
// follow-list-people.ts — Resolve user UIDs to list rows (followers / following UI)
// ============================================================

import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';

export type FollowPersonRow = { uid: string; displayUsername: string; usernameSlug: string };

export async function resolveFollowPersonRows(uids: string[]): Promise<FollowPersonRow[]> {
  if (uids.length === 0) return [];
  return Promise.all(
    uids.map(async (fid) => {
      try {
        const s = await getDoc(doc(db, 'users', fid));
        if (!s.exists())
          return { uid: fid, displayUsername: 'Unknown', usernameSlug: 'unknown' };
        const d = s.data();
        return {
          uid: fid,
          displayUsername: (d.displayUsername || d.username || 'user') as string,
          usernameSlug: ((d.username as string) || (d.displayUsername as string) || 'user').toLowerCase(),
        };
      } catch {
        return { uid: fid, displayUsername: 'Unknown', usernameSlug: 'unknown' };
      }
    })
  );
}
