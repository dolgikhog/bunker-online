// server/meta.js — link previews for invite links (reports/seo.md). Pure functions: no I/O, no state, no logging.
//
// A chat app that unfurls https://sealthebunker.com/?room=ABCD reads the page without running app.js, so the room has to
// be in the HTML itself. withRoomPreview(html, url) takes public/index.html's text and the request URL and, for a valid
// room code, returns the page with "Join room ABCD — Seal the Bunker" in <title> and og:title (and twitter:title, if the
// page has one), and https://sealthebunker.com/?room=ABCD as og:url. Anything else comes back unchanged, byte for byte.
//
// Safety: the only request data that reaches the output is the room code, and only once it is exactly 4 letters of the
// SPEC §7 alphabet (ABCDEFGHJKLMNPQRSTUVWXYZ, no I or O; either case on input, as §7 allows, and upper case out). The
// origin is fixed, never the Host header or the request's own path, and no other query parameter is read. Every value
// written is HTML-escaped anyway. The canonical link is left alone: an invite is the home page, for search engines.
//
// Wiring (server/index.js, the integrator): when the static server answers the app page (/ or /index.html) and
// roomFromUrl(req.url) is not null, read the file as UTF-8, send withRoomPreview(text, req.url) with the page's usual
// headers (Content-Length of the new body; Range is ignored, the whole page is a 200), and HEAD without the body.

/** Where the site lives. Every URL written into a preview uses it (never the request's Host). */
export const SITE_ORIGIN = 'https://sealthebunker.com';
/** The site's brand on this domain (the in-game name stays "Bunker Online" / «Бункер онлайн»). */
export const SITE_NAME = 'Seal the Bunker';

/** SPEC §7: a room code is 4 of ABCDEFGHJKLMNPQRSTUVWXYZ. ASCII only: checked before upper-casing (see roomFromUrl). */
const ROOM_CODE = /^[A-HJ-NP-Z]{4}$/i;
/** One <meta …> tag; a quoted attribute value may hold a ">". */
const META_TAG = /<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const TITLE_TAG = /<title\b[^>]*>[\s\S]*?<\/title\s*>/i;
/** An HTML comment, captured so that split() keeps it. An unclosed one runs to the end, as in a browser. */
const COMMENT = /(<!--[\s\S]*?(?:-->|$))/;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text made safe for HTML text and for a quoted attribute value. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * The invite's room code from a request URL (`req.url`, a path with its query, or an absolute URL string or a URL), upper
 * case, or null when there is none or it is not a room code. The first `room` parameter counts, as in app.js. The value
 * is checked as ASCII before it is upper-cased, so no look-alike ("ſ", "ı", fullwidth or Cyrillic letters) turns into
 * a code by case mapping.
 */
export function roomFromUrl(url) {
  let params;
  try {
    if (url instanceof URL) params = url.searchParams;
    else if (typeof url === 'string') params = new URL(url, SITE_ORIGIN).searchParams;
    else return null;
  } catch {
    return null;
  }
  const code = params.get('room');
  return code !== null && ROOM_CODE.test(code) ? code.toUpperCase() : null;
}

/** The preview of an invite: its title and canonical-style URL, or null when the URL has no valid room code. */
export function roomPreview(url) {
  const code = roomFromUrl(url);
  if (!code) return null;
  return { code, title: `Join room ${code} — ${SITE_NAME}`, url: `${SITE_ORIGIN}/?room=${code}` };
}

/** Sets the content of every <meta property|name="key"> in `html` (the value escaped); other tags stay as they are. */
function setMeta(html, key, value) {
  return html.replace(META_TAG, (tag) => {
    const name = /\s(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!name || (name[1] ?? name[2]).toLowerCase() !== key) return tag;
    return tag.replace(/(\scontent\s*=\s*)(?:"[^"]*"|'[^']*')/i, (m, lead) => `${lead}"${escapeHtml(value)}"`);
  });
}

/**
 * The app page with the invite's preview tags (see the top of this file): `html` is public/index.html's text and `url`
 * the request URL. Without a valid room code, or when `html` is not a string, `html` is returned as it is. Comments are
 * left alone (the page's own comments name these tags), and only the first <title> is replaced.
 */
export function withRoomPreview(html, url) {
  if (typeof html !== 'string') return html;
  const p = roomPreview(url);
  if (!p) return html;
  let titled = false;
  return html.split(COMMENT).map((part, i) => {
    if (i % 2 === 1) return part;   // a comment (split keeps the captured separators at the odd indices)
    let out = part;
    if (!titled && TITLE_TAG.test(out)) {
      titled = true;
      out = out.replace(TITLE_TAG, () => `<title>${escapeHtml(p.title)}</title>`);
    }
    out = setMeta(out, 'og:title', p.title);
    out = setMeta(out, 'twitter:title', p.title);
    return setMeta(out, 'og:url', p.url);
  }).join('');
}
