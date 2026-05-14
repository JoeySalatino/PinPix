// ============================================================
// phone-normalize.ts — E.164 for contact matching & profile field
// ------------------------------------------------------------
// Uses libphonenumber-js (same validation rules as iOS/Android).
// ============================================================

import { getLocales } from 'expo-localization';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

/** ISO region from the device (used when a contact number has no country code). */
export function getDeviceCountryCodeForPhone(): CountryCode | undefined {
  const code = getLocales()[0]?.regionCode;
  if (!code || typeof code !== 'string' || code.length !== 2) return undefined;
  return code.toUpperCase() as CountryCode;
}

/** Returns E.164 including leading +, or null if not a valid number. */
export function normalizeToE164(raw: string, defaultCountry?: CountryCode): string | null {
  const t = raw.trim();
  if (!t) return null;
  const parsed = parsePhoneNumberFromString(t, defaultCountry);
  if (!parsed?.isValid()) return null;
  return parsed.number;
}
