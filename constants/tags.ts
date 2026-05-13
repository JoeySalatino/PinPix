/** Quick-pick labels on add/edit spot and always shown first on the map filter bar. */
export const TAGS = ['Nature', 'Urban', 'Sunset', 'Architecture', 'Water', 'Night'] as const;

export type Tag = (typeof TAGS)[number];

export const MAX_TAGS_PER_SPOT = 15;
export const MAX_TAG_LENGTH = 28;

/** Trim, collapse spaces, cap length (user-defined tags). */
export function normalizeTagInput(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
}

/** Dedupe case-insensitively, preserve first-seen casing, cap count. */
export function dedupeTagsForSpot(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const n = normalizeTagInput(t);
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
    if (out.length >= MAX_TAGS_PER_SPOT) break;
  }
  return out;
}

