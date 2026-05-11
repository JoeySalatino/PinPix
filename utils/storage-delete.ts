import { deleteObject, ref, refFromURL } from 'firebase/storage';
import { storage } from './firebase';

/**
 * Deletes a file from Firebase Storage. Accepts either a storage path
 * (e.g. `spots/uid/...`) or a full `gs://` / `https://` URL from getDownloadURL.
 */
export async function deleteStorageObjectByUrl(url: string | undefined | null): Promise<void> {
  const trimmed = url?.trim();
  if (!trimmed) return;
  try {
    const reference =
      trimmed.startsWith('http') || trimmed.startsWith('gs:')
        ? refFromURL(storage, trimmed)
        : ref(storage, trimmed);
    await deleteObject(reference);
  } catch {
    // Ignore missing file / permission / malformed URL — callers already handle UX.
  }
}
