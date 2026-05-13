import { deleteObject, ref } from 'firebase/storage';
import { storage } from './firebase';

/**
 * Deletes a file from Firebase Storage. Accepts either a storage path
 * (e.g. `spots/uid/...`) or a full `gs://` / `https://` URL from getDownloadURL.
 */
export async function deleteStorageObjectByUrl(url: string | undefined | null): Promise<void> {
  const trimmed = url?.trim();
  if (!trimmed) return;
  try {
    const reference = ref(storage, trimmed);
    await deleteObject(reference);
  } catch {
    // Ignore missing file / permission / malformed URL — callers already handle UX.
  }
}

/** Deletes every distinct URL (e.g. all photos for one spot). */
export async function deleteStorageObjectsByUrls(urls: readonly string[] | undefined): Promise<void> {
  if (!urls?.length) return;
  const seen = new Set<string>();
  for (const u of urls) {
    const t = u?.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    await deleteStorageObjectByUrl(t);
  }
}
