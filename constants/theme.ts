import { BRAND } from './brand';

/** Main app background in dark mode (matches SpotPeek / social). */
export const DARK_SCREEN = '#0d1c2b';

export function appScreenBackground(isDark: boolean): string {
  return isDark ? DARK_SCREEN : BRAND.navy;
}
