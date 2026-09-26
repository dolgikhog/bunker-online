/* Bunker Online — storage profiles (SPEC §11 X9.1).
 *
 * `?profile=<id>` (1–16 characters from [a-z0-9_-]) works in every build, production included. It namespaces EVERY
 * storage key the client uses (identity, name, preferences, the narrator, and later the language), so tabs of one
 * browser with different profiles are independent players: the owner tests alone, and every incognito window of a
 * browser shares one storage. Without the parameter (or with an invalid one) nothing changes: keys are as before.
 *
 * Rules for every module of the client:
 *   - read and write web storage only through a key passed through pkey() (sessionStorage too: same-origin frames of
 *     one tab, such as the /dev test table's seats, share it);
 *   - a `storage` event compares e.key against pkey(KEY), never against KEY;
 *   - an in-app URL change keeps the `profile` parameter (edit location's own URL, or use withProfile());
 *   - the copyable join link (location.origin + '/?room=' + code) never carries it: a friend who opens it is not in
 *     this browser's profile. */

export const PROFILE_RE = /^[a-z0-9_-]{1,16}$/;

function readProfile() {
  try {
    const v = new URLSearchParams(location.search).get('profile');
    return v && PROFILE_RE.test(v) ? v : '';
  } catch {
    return '';
  }
}

/** The active profile id, or '' when none (or an invalid one) was given. */
export const PROFILE = readProfile();

/** The storage key for `key` in the active profile: 'bunker.identity' → 'bunker.identity@p2' (unchanged without one). */
export function pkey(key) { return PROFILE ? `${key}@${PROFILE}` : key; }

/** An in-app URL (relative or absolute, same origin) with the active profile kept on it. */
export function withProfile(href) {
  if (!PROFILE) return href;
  try {
    const u = new URL(href, location.href);
    if (u.origin !== location.origin) return href;
    u.searchParams.set('profile', PROFILE);
    return u.pathname + u.search + u.hash;
  } catch {
    return href;
  }
}
