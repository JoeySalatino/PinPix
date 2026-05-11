export const TAGS = ['Nature', 'Urban', 'Sunset', 'Architecture', 'Water', 'Night'] as const;

export type Tag = (typeof TAGS)[number];

