/* Bunker Online — "Report an issue" / "Suggest an idea" links and the visible version (SPEC §11 X10).
 *
 *   loadVersion(onChange)   once: fetches version.json ({"version","builtAt"}, written by deploy/deploy.sh and
 *                           git-ignored); onChange() is called when it arrives. Missing or malformed → 'dev'.
 *   appVersion()            the version now ('dev' until and unless version.json says otherwise)
 *   browserSummary()        a short "Chrome 131 · Linux" / "Safari 26 · iOS", never the full user agent
 *   issueUrl({lang, room})  the bug form, prefilled: template, version, browser, lang (EN|RU), room (only in a room)
 *   ideaUrl({lang})         the idea form, prefilled: template, version, lang
 *
 * The form field ids (version, browser, lang, room) are the public contract in .github/ISSUE_TEMPLATE/bug.yml and
 * idea.yml. Every value is URL-encoded with encodeURIComponent (a space is %20, never '+'). */

export const ISSUES_NEW = 'https://github.com/dolgikhog/bunker-online/issues/new';
const VERSION_URL = new URL('version.json', import.meta.url).href;

let version = '';
let loading = null;

/** The running version: the `version` of version.json, or 'dev' when there is none. */
export function appVersion() { return version || 'dev'; }

function cleanVersion(v) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  // `git describe --always --dirty` output: a tag or a hash, maybe "-dirty"; anything odd is not shown
  return /^[\w.+~-]{1,64}$/.test(t) ? t : '';
}

export function loadVersion(onChange) {
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch(VERSION_URL, { cache: 'no-store' });
      // a 404 (no version.json: a local run) is read to the end too: an unread body keeps the request open, and the
      // page then never goes network-idle
      if (!res.ok) { await res.text().catch(() => ''); return; }
      const j = await res.json();
      const v = cleanVersion(j && j.version);
      if (v && v !== version) { version = v; if (typeof onChange === 'function') onChange(); }
    } catch { /* no version.json (a local run): 'dev' */ }
  })();
  return loading;
}

/** A short browser + OS summary for a bug report, e.g. "Safari 26 · iOS", "Chrome 131 · Android". */
export function browserSummary(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : ''), touchPoints = (typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0)) {
  const u = String(ua || '');
  const tests = [
    ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/],
    ['Opera', /(?:OPR|OPT|OPiOS)\/(\d+)/],
    ['Samsung Internet', /SamsungBrowser\/(\d+)/],
    ['Yandex', /YaBrowser\/(\d+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /(?:HeadlessChrome|Chrome|CriOS)\/(\d+)/],
    ['Safari', /Version\/(\d+)[\d.]*(?: Mobile\/\S+)? Safari\//],
    ['WebView', /AppleWebKit\/(\d+)/],   // an in-app browser (Telegram, Instagram…) that names nothing else
  ];
  let browser = 'Unknown browser';
  for (const [name, re] of tests) {
    const m = re.exec(u);
    if (m) { browser = `${name} ${m[1]}`; break; }
  }
  let os = '';
  if (/iPhone|iPad|iPod/.test(u) || (/Macintosh/.test(u) && Number(touchPoints) > 1)) os = 'iOS';   // iPadOS asks for the desktop site
  else if (/Android/.test(u)) os = 'Android';
  else if (/CrOS/.test(u)) os = 'ChromeOS';
  else if (/Windows/.test(u)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(u)) os = 'macOS';
  else if (/Linux/.test(u)) os = 'Linux';
  return os ? `${browser} · ${os}` : browser;
}

function query(pairs) {
  return pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}
/** EN or RU: the language the viewer's UI is in. */
export function langParam(lang) { return String(lang || '').toLowerCase().startsWith('ru') ? 'RU' : 'EN'; }

export function issueUrl({ lang = 'en', room = '', browser = browserSummary(), v = appVersion() } = {}) {
  const code = /^[A-Z]{4}$/.test(String(room || '')) ? room : '';
  return `${ISSUES_NEW}?${query([['template', 'bug.yml'], ['version', v], ['browser', browser], ['lang', langParam(lang)], ['room', code]])}`;
}

export function ideaUrl({ lang = 'en', v = appVersion() } = {}) {
  return `${ISSUES_NEW}?${query([['template', 'idea.yml'], ['version', v], ['lang', langParam(lang)]])}`;
}
