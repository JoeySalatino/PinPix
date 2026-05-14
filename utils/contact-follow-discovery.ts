// ============================================================
// contact-follow-discovery.ts — Match device contacts to PinPix users
// ------------------------------------------------------------
// Reads emails and phone numbers from the system address book (on device),
// then looks up Firestore users by `email` (signup email) and/or
// `contactMatchPhoneE164` (optional field the member saves in Settings).
// ============================================================

import * as Contacts from 'expo-contacts';
import { Platform } from 'react-native';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { getDeviceCountryCodeForPhone, normalizeToE164 } from './phone-normalize';

/** Firestore `in` disjunction limit. */
const IN_QUERY_LIMIT = 30;

/** Cap unique values sent to Firestore to control read cost. */
const MAX_UNIQUE_EMAILS = 3000;
const MAX_UNIQUE_PHONES = 3000;

export type ContactMatchedUser = {
  uid: string;
  email: string;
  contactMatchPhoneE164: string | null;
  displayUsername: string;
  usernameSlug: string;
};

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

export function normalizeContactEmail(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  if (!t || !t.includes('@')) return null;
  if (t.length > 254) return null;
  return t;
}

function collectEmailsFromContact(c: Contacts.Contact, into: Set<string>): void {
  const emails = c.emails;
  if (!emails?.length) return;
  for (const entry of emails) {
    const addr = typeof entry === 'string' ? entry : entry?.email;
    if (!addr || typeof addr !== 'string') continue;
    const n = normalizeContactEmail(addr);
    if (n) into.add(n);
  }
}

function collectPhonesFromContact(
  c: Contacts.Contact,
  defaultRegion: ReturnType<typeof getDeviceCountryCodeForPhone>,
  into: Set<string>
): void {
  const phones = c.phoneNumbers;
  if (!phones?.length) return;
  for (const entry of phones) {
    const raw = typeof entry === 'string' ? entry : entry?.number;
    if (!raw || typeof raw !== 'string') continue;
    const e164 = normalizeToE164(raw, defaultRegion);
    if (e164) into.add(e164);
  }
}

async function gatherContactEmailsAndPhones(): Promise<{ emails: string[]; phones: string[] }> {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const defaultRegion = getDeviceCountryCodeForPhone();
  let pageOffset = 0;
  const pageSize = 500;

  for (;;) {
    const { data, hasNextPage } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.Emails, Contacts.Fields.PhoneNumbers],
      pageSize,
      pageOffset,
    });
    for (const c of data) {
      collectEmailsFromContact(c, emails);
      collectPhonesFromContact(c, defaultRegion, phones);
    }
    if (!hasNextPage || data.length === 0) break;
    pageOffset += data.length;
    if (emails.size >= 8000 && phones.size >= 8000) break;
  }

  const emailList = [...emails].sort().slice(0, MAX_UNIQUE_EMAILS);
  const phoneList = [...phones].sort().slice(0, MAX_UNIQUE_PHONES);
  return { emails: emailList, phones: phoneList };
}

export type LoadContactIdentifiersResult =
  | { ok: true; emails: string[]; phones: string[] }
  | { ok: false; reason: 'unsupported' | 'denied' };

/**
 * Requests contacts permission (if needed) and returns normalized unique emails
 * and E.164 phone numbers from the address book. iOS / Android only.
 */
export async function loadContactIdentifiersFromDevice(): Promise<LoadContactIdentifiersResult> {
  if (Platform.OS === 'web') return { ok: false, reason: 'unsupported' };

  const existing = await Contacts.getPermissionsAsync();
  if (existing.status !== 'granted') {
    const req = await Contacts.requestPermissionsAsync();
    if (req.status !== 'granted') return { ok: false, reason: 'denied' };
  }

  return { ok: true, ...(await gatherContactEmailsAndPhones()) };
}

async function fetchUsersByEmailsInChunk(emails: string[]): Promise<ContactMatchedUser[]> {
  if (emails.length === 0) return [];
  const usersRef = collection(db, 'users');
  const q = query(usersRef, where('email', 'in', emails));
  const snap = await getDocs(q);
  const out: ContactMatchedUser[] = [];
  snap.forEach((docSnap) => out.push(mapUserDoc(docSnap)));
  return out;
}

async function fetchUsersByPhonesInChunk(phones: string[]): Promise<ContactMatchedUser[]> {
  if (phones.length === 0) return [];
  const usersRef = collection(db, 'users');
  const q = query(usersRef, where('contactMatchPhoneE164', 'in', phones));
  const snap = await getDocs(q);
  const out: ContactMatchedUser[] = [];
  snap.forEach((docSnap) => out.push(mapUserDoc(docSnap)));
  return out;
}

async function findUsersChunked(
  values: string[],
  fetchChunk: (chunk: string[]) => Promise<ContactMatchedUser[]>
): Promise<ContactMatchedUser[]> {
  const byUid = new Map<string, ContactMatchedUser>();
  for (let i = 0; i < values.length; i += IN_QUERY_LIMIT) {
    const chunk = values.slice(i, i + IN_QUERY_LIMIT);
    const part = await fetchChunk(chunk);
    for (const u of part) byUid.set(u.uid, u);
  }
  return [...byUid.values()];
}

export async function findPinpixUsersForEmails(emails: string[]): Promise<ContactMatchedUser[]> {
  const unique = [...new Set(emails.map((e) => normalizeContactEmail(e)).filter(Boolean))] as string[];
  const rows = await findUsersChunked(unique, fetchUsersByEmailsInChunk);
  return rows.sort((a, b) => a.displayUsername.toLowerCase().localeCompare(b.displayUsername.toLowerCase()));
}

export async function findPinpixUsersForPhones(phones: string[]): Promise<ContactMatchedUser[]> {
  const unique = [...new Set(phones.filter((p) => typeof p === 'string' && p.startsWith('+')))];
  const rows = await findUsersChunked(unique, fetchUsersByPhonesInChunk);
  return rows.sort((a, b) => a.displayUsername.toLowerCase().localeCompare(b.displayUsername.toLowerCase()));
}

/** Email + phone lookups merged and de-duplicated by uid (phone data merged onto existing rows). */
export async function findPinpixUsersForContactLookups(emails: string[], phones: string[]): Promise<ContactMatchedUser[]> {
  const [fromEmail, fromPhone] = await Promise.all([
    findPinpixUsersForEmails(emails),
    findPinpixUsersForPhones(phones),
  ]);
  const byUid = new Map<string, ContactMatchedUser>();
  for (const u of fromEmail) byUid.set(u.uid, u);
  for (const u of fromPhone) {
    const prev = byUid.get(u.uid);
    if (prev) {
      byUid.set(u.uid, {
        ...prev,
        contactMatchPhoneE164: u.contactMatchPhoneE164 || prev.contactMatchPhoneE164,
      });
    } else {
      byUid.set(u.uid, u);
    }
  }
  return [...byUid.values()].sort((a, b) =>
    a.displayUsername.toLowerCase().localeCompare(b.displayUsername.toLowerCase())
  );
}

export function partitionContactMatches(opts: {
  matched: ContactMatchedUser[];
  myUid: string;
  myEmailNormalized: string | null;
  myPhoneE164: string | null;
  followerUids: string[];
  followingUids: string[];
  blockedUserIds: string[];
}): { followersInContacts: ContactMatchedUser[]; suggestedToFollow: ContactMatchedUser[] } {
  const followerSet = new Set(opts.followerUids);
  const followingSet = new Set(opts.followingUids);
  const blocked = new Set(opts.blockedUserIds);

  const followersInContacts: ContactMatchedUser[] = [];
  const suggestedToFollow: ContactMatchedUser[] = [];

  for (const u of opts.matched) {
    if (u.uid === opts.myUid) continue;
    if (opts.myEmailNormalized && normalizeContactEmail(u.email) === opts.myEmailNormalized) continue;
    if (opts.myPhoneE164 && u.contactMatchPhoneE164 && u.contactMatchPhoneE164 === opts.myPhoneE164) continue;
    if (blocked.has(u.uid)) continue;
    const isFollower = followerSet.has(u.uid);
    const isFollowing = followingSet.has(u.uid);
    if (isFollower) followersInContacts.push(u);
    else if (!isFollowing) suggestedToFollow.push(u);
  }

  const sortByName = (a: ContactMatchedUser, b: ContactMatchedUser) =>
    a.displayUsername.toLowerCase().localeCompare(b.displayUsername.toLowerCase());

  followersInContacts.sort(sortByName);
  suggestedToFollow.sort(sortByName);

  return { followersInContacts, suggestedToFollow };
}
