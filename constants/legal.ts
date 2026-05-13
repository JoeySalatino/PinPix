// ============================================================
// legal.ts — Centralized URLs for legal / support pages
// ------------------------------------------------------------
// Replace these with your hosted Privacy Policy and Terms of
// Service URLs before submitting to the App Store or Play Store.
// Both stores require functioning links.
//
// Spot shares use an https page on this same site (`open-spot.html`)
// so iMessage/SMS can show a tappable link; that page redirects to
// the PinPix app. Copy `share-web/open-spot.html` from this repo into
// the pinpix-legal repository root when you update legal pages.
//
// Easy free hosts:
//   - GitHub Pages (free, takes 5 min)
//   - Notion public page (free)
//   - termly.io / freeprivacypolicy.com (free generators)
// ============================================================

export const LEGAL = {
  privacyPolicyUrl: 'https://joeysalatino.github.io/pinpix-legal/privacy.html',
  termsOfServiceUrl: 'https://joeysalatino.github.io/pinpix-legal/terms.html',
  supportEmail: 'pinpixhelp@gmail.com',
} as const;

/** Root URL of the pinpix-legal GitHub Pages site (same origin as privacy/terms). */
export function pinpixLegalPagesRoot(): string {
  try {
    const u = new URL(LEGAL.privacyPolicyUrl);
    const path = u.pathname.replace(/\/[^/]+$/, '') || '';
    return `${u.origin}${path}`.replace(/\/$/, '');
  } catch {
    return 'https://joeysalatino.github.io/pinpix-legal';
  }
}
