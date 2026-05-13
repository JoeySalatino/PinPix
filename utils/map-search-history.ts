// ============================================================
// map-search-history.ts — Persisted recent map search strings
// ------------------------------------------------------------
// Stored locally with AsyncStorage (device-only, not synced).
// ============================================================

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'pinpix_map_search_history_v1';
const MAX_ENTRIES = 15;

function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s) => s.length > 0)
    .slice(0, MAX_ENTRIES);
}

export async function loadMapSearchHistory(): Promise<string[]> {
  try {
    const json = await AsyncStorage.getItem(STORAGE_KEY);
    if (!json) return [];
    return normalizeList(JSON.parse(json));
  } catch {
    return [];
  }
}

/** Adds or moves `query` to the front; dedupes case-insensitively. */
export async function addMapSearchHistoryEntry(query: string): Promise<void> {
  const trimmed = query.trim();
  if (!trimmed) return;
  try {
    const prev = await loadMapSearchHistory();
    const lower = trimmed.toLowerCase();
    const without = prev.filter((s) => s.toLowerCase() !== lower);
    const next = [trimmed, ...without].slice(0, MAX_ENTRIES);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore persistence failures
  }
}

export async function removeMapSearchHistoryEntry(query: string): Promise<void> {
  const lower = query.trim().toLowerCase();
  if (!lower) return;
  try {
    const prev = await loadMapSearchHistory();
    const next = prev.filter((s) => s.toLowerCase() !== lower);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export async function clearMapSearchHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
