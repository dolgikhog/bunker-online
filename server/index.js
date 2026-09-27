#!/usr/bin/env node
// server/index.js — zero-dependency static server + WebSocket (/ws) on one port (SPEC.md §0, §8, §9).
//
// Env: PORT (8080; 0 = pick a free one), HOST (0.0.0.0), BUNKER_PUBLIC_DIR (<repo>/public; relative paths resolve
// against the repo root), BUNKER_SEED, BUNKER_MIN_PLAYERS (4, clamped 2..16), BUNKER_HOST_GRACE_MS (45000),
// BUNKER_NO_LIMITS (=1 lifts per-socket rate limits, the per-IP socket cap, the per-IP room cap and the per-IP budget of
// failed join/resume lookups), BUNKER_TRUST_PROXY (=1: behind a reverse proxy on this host, SPEC §11 X2; a socket whose
// TCP peer is loopback counts as the last address in its X-Forwarded-For for every per-IP limit).
// BUNKER_DEV (=1: dev mode, SPEC §11 X9: test shortcuts, see server/dev.js; never set in production, and refused
// together with BUNKER_TRUST_PROXY=1 or NODE_ENV=production). BUNKER_WS_DEFLATE (=1: permessage-deflate on /ws, =0: off;
// off by default, SPEC §11 X5.15: see WS_DEFLATE). BUNKER_STATE_DIR (unset: in memory only; relative paths resolve
// against the repo root): where analytics.json, the daily usage counts, is kept (server/analytics.js; never in dev
// mode; production: /var/lib/bunker).
// BUNKER_ADMIN_TOKEN (at least 24 characters, URL-safe): turns on GET /admin/stats?key=<token>, the usage dashboard;
// unset or shorter, that path is the plain 404 like any other.
// Once listening, prints `BUNKER_LISTENING <port>` and `listening on http://<host>:<port>` to stdout, then in dev mode
// DEV_BANNER.
// HTTP: GET /healthz -> ok; GET /stats -> {"rooms","activeGames","sockets"} only for a request made on this host (a
// loopback peer with no X-Forwarded-For, SPEC §11 X8), 404 for everyone else; in dev mode only, GET /devinfo ->
// {"dev":true} and /dev -> public/dev.html (without dev mode these and every public/dev.* file are the plain 404);
// GET /admin/stats?key=<BUNKER_ADMIN_TOKEN> -> the usage dashboard (&format=json: its data), to anyone with the key
// (serveAdmin; without dev mode only); every other path is a static file, GET or HEAD, with byte ranges for a GET
// (Accept-Ranges: bytes, 206, 416; see parseRange) and, for every file but the app page, a weak ETag and 304 answers
// to If-None-Match / If-Modified-Since (Cache-Control: no-cache, so a browser revalidates and gets a 304, not the
// bytes again). The app page (/ or /index.html) is no-store; with a valid ?room=CODE it is sent with the invite's
// title, og:title and og:url (server/meta.js, for link previews). A GET of it is counted (analytics.js: a day's views
// and visitors, never the request itself).

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Rooms, ipKey, siteKey, SITE_FACTOR } from './rooms.js';
import { mulberry32, seedFromString } from './rng.js';
import { Analytics, AdminGate, ADMIN_CSP, ANALYTICS_FILE, adminTokenUsable, renderDashboard } from './analytics.js';
import { roomFromUrl, withRoomPreview } from './meta.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CSP = "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'";
export const MAX_PAYLOAD = 8 * 1024;

/**
 * §11 X5.15: permessage-deflate (RFC 7692) on /ws, when BUNKER_WS_DEFLATE turns it on (configFromEnv). Tuned with
 * tools/bench-broadcast.js on one core at 16 players + 50 spectators (reports/ws-compression.md):
 *   - zlib level 1, memLevel 8 (zlib's default): level 2 took ~4% more CPU for ~8% fewer bytes; memLevel 5 saves ~55 KB
 *     per socket for ~3% more bytes; a smaller window costs more CPU and more bytes (12 bits: ~1.5× the CPU, 10: ~2.7×);
 *   - server_no_context_takeover: every message is compressed on its own, so nothing sent earlier on the socket (the
 *     `joined` token) is ever in the window of a later message that carries other people's names (a CRIME-style size
 *     oracle), and a message under `threshold` goes out as it is (ws decides on its first fragment). Context takeover
 *     would save ~5% of the bytes and no memory: ws keeps the deflater and only resets it;
 *   - no server_max_window_bits / client_max_window_bits: every browser's offer is accepted as it is made (with a number
 *     here, ws fails the handshake of an offer that lacks the parameter);
 *   - concurrencyLimit 10 (ws's own default; the limiter is process-wide): on one core, 1 cost ~20% more CPU per
 *     broadcast and ~15% more wall time.
 * MAX_PAYLOAD still bounds a client's message after inflating (1009).
 */
export const WS_DEFLATE = Object.freeze({
  zlibDeflateOptions: Object.freeze({ level: 1, memLevel: 8 }),
  serverNoContextTakeover: true,
  threshold: 1024,
  concurrencyLimit: 10,
});

/**
 * Whether /ws offers permessage-deflate when BUNKER_WS_DEFLATE is neither "1" nor "0": no. On one core a 16 + 50
 * broadcast then costs 3.2-3.9× the pre-X5 CPU (the X5.2 budget is 1×) for 5× fewer bytes (§11 X5.15).
 */
export const WS_DEFLATE_DEFAULT = false;

/** The WebSocketServer's `perMessageDeflate` option: false, or a fresh copy of WS_DEFLATE. */
export function wsDeflateOption(on) {
  return on ? { ...WS_DEFLATE, zlibDeflateOptions: { ...WS_DEFLATE.zlibDeflateOptions } } : false;
}
const RATE_PER_SEC = 20;
const BURST_WINDOW_MS = 10_000;
const BURST_MAX = 200;
/** Open sockets per network (an IPv4 address or an IPv6 /64, rooms.js ipKey) and, §11 X5, per IPv6 /48. */
export const MAX_SOCKETS_PER_IP = 40;
export const MAX_SOCKETS_PER_SITE = MAX_SOCKETS_PER_IP * SITE_FACTOR;
const HEARTBEAT_MS = 30_000;
/** §11 X9: printed on start in dev mode. */
export const DEV_BANNER = '*** DEV MODE — test shortcuts enabled, never expose publicly ***';
/** §11 X9: why startServer refuses dev mode on what looks like the production unit. */
export const DEV_REFUSED = 'BUNKER_DEV=1 together with BUNKER_TRUST_PROXY=1 or NODE_ENV=production looks like production: dev mode refused (test shortcuts must never be public)';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function intEnv(v, dflt) {
  if (v === undefined || v === null || String(v).trim() === '') return dflt;
  const n = Number(v);
  return Number.isInteger(n) ? n : dflt;
}

/** Reads the §8 environment variables. */
export function configFromEnv(env = process.env) {
  let port = intEnv(env.PORT, 8080);
  if (port < 0 || port > 65535) port = 8080;
  const publicDir = env.BUNKER_PUBLIC_DIR && env.BUNKER_PUBLIC_DIR.trim()
    ? path.resolve(REPO_ROOT, env.BUNKER_PUBLIC_DIR.trim())
    : path.join(REPO_ROOT, 'public');
  // unset: the counts stay in memory (a local run or a test never writes into the repo); production sets it
  const stateDir = env.BUNKER_STATE_DIR && env.BUNKER_STATE_DIR.trim()
    ? path.resolve(REPO_ROOT, env.BUNKER_STATE_DIR.trim())
    : null;
  return {
    port,
    host: env.HOST && env.HOST.trim() ? env.HOST.trim() : '0.0.0.0',
    publicDir,
    seed: env.BUNKER_SEED !== undefined && env.BUNKER_SEED !== '' ? String(env.BUNKER_SEED) : null,
    minPlayers: Math.min(16, Math.max(2, intEnv(env.BUNKER_MIN_PLAYERS, 4))),
    hostGraceMs: Math.max(0, intEnv(env.BUNKER_HOST_GRACE_MS, 45000)),
    noLimits: env.BUNKER_NO_LIMITS === '1',
    trustProxy: env.BUNKER_TRUST_PROXY === '1',
    // §11 X9: exactly "1", like the other switches. `production` only guards against dev mode on the production unit.
    dev: env.BUNKER_DEV === '1',
    production: env.NODE_ENV === 'production',
    // §11 X5.15: permessage-deflate on /ws (WS_DEFLATE): "1" on, "0" off, anything else the default (WS_DEFLATE_DEFAULT)
    wsDeflate: env.BUNKER_WS_DEFLATE === '1' ? true : env.BUNKER_WS_DEFLATE === '0' ? false : WS_DEFLATE_DEFAULT,
    // usage counts (server/analytics.js): the directory of analytics.json (null: counted in memory only), and the
    // dashboard's key (not adminTokenUsable: no dashboard)
    stateDir,
    adminToken: typeof env.BUNKER_ADMIN_TOKEN === 'string' ? env.BUNKER_ADMIN_TOKEN.trim() : '',
  };
}

// ---- §11 X9: dev routes -----------------------------------------------------------------------------------------

/**
 * Whether a decoded pathname is one of dev mode's: /dev, /devinfo, anything under /dev/ or /devinfo/, and every
 * public/dev.* file (dev.html, dev.js, …). Compared on the first path segment, lower-cased, so //dev.html, /%64ev.html
 * and /DEV.html (on a case-insensitive disk) are covered too. Without dev mode they all get the plain 404.
 */
export function isDevPath(pathname) {
  const first = String(pathname).split('/').find(Boolean)?.toLowerCase() ?? '';
  return first === 'dev' || first === 'devinfo' || first.startsWith('dev.');
}

// ---- §11 X2: the client address behind a reverse proxy -----------------------------------------------------------

/** A TCP peer address on this host: 127.0.0.0/8, ::1, or an IPv4-mapped 127.x (dotted or hex form). */
export function isLoopback(addr) {
  if (typeof addr !== 'string') return false;
  let a = addr.trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (net.isIPv4(a)) return a.startsWith('127.');
  if (!net.isIPv6(a)) return false;
  if (a === '::1' || /^(0{1,4}:){7}0{0,3}1$/.test(a)) return true;
  const mapped = /^(?:0{1,4}:){0,5}:?ffff:(.+)$/.exec(a) || /^::ffff:(.+)$/.exec(a);
  if (!mapped) return false;
  const tail = mapped[1];
  if (net.isIPv4(tail)) return tail.startsWith('127.');
  return /^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(tail); // ::ffff:7f00:1
}

/** One X-Forwarded-For entry as a bare address ("1.2.3.4", "1.2.3.4:5678", "[2001:db8::1]:443" …), or null if it is not one. */
export function parseForwardedAddress(entry) {
  if (typeof entry !== 'string') return null;
  let a = entry.trim();
  if (!a || a.length > 100) return null;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(a);
  if (bracketed) a = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(a)) a = a.slice(0, a.lastIndexOf(':'));
  a = a.toLowerCase();
  if (!net.isIP(a)) return null;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  return mapped ? mapped[1] : a;
}

/**
 * The socket-cap buckets of a resolved client address, as [key, cap] pairs: its network (an IPv4 address, or an IPv6
 * /64; §11 X5, before this every IPv6 address was its own bucket) and, for IPv6, its /48.
 */
export function socketBuckets(ip) {
  const out = [[ipKey(ip) || String(ip), MAX_SOCKETS_PER_IP]];
  const site = siteKey(ip);
  if (site) out.push([site, MAX_SOCKETS_PER_SITE]);
  return out;
}

/**
 * §11 X2: the address a socket counts as for every per-IP or per-network limit. With `trustProxy` on and a loopback
 * TCP peer (the proxy on this host), the LAST X-Forwarded-For entry: the proxy appends the address it saw, while
 * earlier entries come from the client and may be forged. Otherwise, or when that entry is missing or unparsable, the
 * peer itself. `xff` is the raw header value (Node joins repeated headers with ", "; an array is accepted too).
 */
export function resolveClientIp(peer, xff, trustProxy) {
  const fallback = typeof peer === 'string' && peer ? peer : 'unknown';
  if (!trustProxy || !isLoopback(fallback)) return fallback;
  const header = Array.isArray(xff) ? xff.join(',') : xff;
  if (typeof header !== 'string' || !header.trim()) return fallback;
  const entries = header.split(',');
  return parseForwardedAddress(entries[entries.length - 1]) || fallback;
}

// ---- §11 X8: operator stats, answered only on the server itself -------------------------------------------------

/** Headers a forwarding proxy adds (Caddy always sets the X-Forwarded-* ones). Any of them means "came through a proxy". */
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto'];

/**
 * §11 X8: may this request read GET /stats? Only when it was made on this host: the TCP peer is loopback and no
 * forwarding header is present (X-Forwarded-For, which Caddy always adds, and its relatives). `headers` is Node's
 * lower-cased header object; a header that is present but empty still counts as present.
 */
export function statsAllowed(peer, headers) {
  if (!isLoopback(peer)) return false;
  const h = headers && typeof headers === 'object' ? headers : {};
  return FORWARDING_HEADERS.every((k) => h[k] === undefined);
}

/**
 * §11 X5.2: sends UTF-8 chunks as ONE WebSocket text message, each chunk a fragment (RFC 6455 §5.4; every browser and
 * `ws` reassemble them). The chunks are handed to the socket as they are, so a buffer shared by many recipients (the
 * log, rooms.js) is neither copied nor re-encoded per recipient; `ws.send(string)` would encode the whole frame for each
 * one, a fresh 100–180 KB allocation per recipient per broadcast. Safe because the fragments go out back to back: the
 * calls are synchronous, and with perMessageDeflate off (and no Blob ever sent) `ws` writes each one at once, so no
 * other message can come between them. With permessage-deflate on (§11 X5.15), `ws` compresses the fragments in order
 * through the socket's one deflater and queues every later send behind them, so the order holds there too (ws decides
 * whether to compress the message on its first fragment, the head, against WS_DEFLATE.threshold).
 */
export function sendFragments(ws, chunks) {
  const last = chunks.length - 1;
  for (let i = 0; i <= last; i++) ws.send(chunks[i], { binary: false, fin: i === last });
}

function sendText(res, status, text, extra = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function insideDir(dir, p) {
  return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

// ---- static files: byte ranges (RFC 9110 §14) --------------------------------------------------------------------

/**
 * What a GET's Range header asks of a static file of `size` bytes. Media needs this: Safari and every iOS browser do
 * not play audio from a server that answers a range request with the whole file (200), and Chrome cannot seek in it.
 *   { status: 200 }              the whole file: no Range header, a unit other than `bytes` or none (RFC 9110 §14.2: a
 *                                server MUST ignore those), or more than one range (multipart/byteranges is not
 *                                implemented; a server MAY ignore Range, and media players ask for one range only);
 *   { status: 206, start, end }  bytes start..end, `end` inclusive: "a-b" (b past the end means to the end), "a-", and
 *                                "-n" (the last n bytes; the whole file when n >= size);
 *   { status: 416 }              nothing can be served: a malformed `bytes` range ("5-2", "x-1", "-", "1-2-3", an empty
 *                                list), a range that starts at or past the end, "-0", any range of an empty file, or
 *                                several ranges none of which can be served.
 * The caller applies Range to a GET only, and sends a 416 with the unsatisfied-range form of Content-Range (the file's
 * size after "bytes *", RFC 9110 §14.4).
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return { status: 200 };
  const eq = header.indexOf('=');
  if (eq < 0 || header.slice(0, eq).trim().toLowerCase() !== 'bytes') return { status: 200 };
  const specs = header.slice(eq + 1).split(',').map((x) => x.trim()).filter(Boolean);   // empty list elements are allowed
  if (!specs.length) return { status: 416 };
  const ranges = [];
  for (const spec of specs) {
    const m = /^(\d+)-(\d*)$|^-(\d+)$/.exec(spec);
    if (!m) return { status: 416 };
    let start;
    let end;
    if (m[3] !== undefined) {
      const n = Number(m[3]);
      start = Math.max(0, size - n);
      end = n > 0 ? size - 1 : -1;
    } else {
      start = Number(m[1]);
      if (m[2] !== '' && Number(m[2]) < start) return { status: 416 };   // last-pos < first-pos: invalid (RFC 9110 §14.1.1)
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    ranges.push(start < size && end >= start ? { start, end } : null);
  }
  const ok = ranges.filter(Boolean);
  if (!ok.length) return { status: 416 };
  if (ranges.length > 1) return { status: 200 };
  return { status: 206, ...ok[0] };
}

// ---- static files: conditional requests (RFC 9110 §13) -----------------------------------------------------------

/**
 * A static file's validator: a weak entity tag of its size and modification time (weak, so it never satisfies an
 * If-Range: that needs a strong one, and If-Range keeps comparing Last-Modified). deploy.sh's rsync keeps the source
 * files' mtimes, so an unchanged file keeps its tag across deploys and a changed one gets a new one.
 */
export function fileEtag(st) {
  return `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

/**
 * Whether a GET or HEAD of a file with `etag` and modification time `mtimeMs` may be answered 304 Not Modified:
 * If-None-Match, when present, decides alone (a weak comparison against each listed tag, or "*"); otherwise a valid
 * If-Modified-Since at or after the file's time (in whole seconds, Last-Modified's precision) does (RFC 9110 §13.2.2).
 */
export function notModified(headers, etag, mtimeMs) {
  const inm = headers['if-none-match'];
  if (typeof inm === 'string') {
    const want = etag.replace(/^W\//, '');
    return inm.split(',').some((t) => { const x = t.trim(); return x === '*' || x.replace(/^W\//, '') === want; });
  }
  const ims = headers['if-modified-since'];
  if (typeof ims !== 'string') return false;
  const since = Date.parse(ims);
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

/**
 * The static file server. `dev` (§11 X9): serve /devinfo and /dev (public/dev.html), and let pages of this origin frame
 * ours (X-Frame-Options SAMEORIGIN instead of DENY: the test table shows each seat's client in an <iframe>). Without it
 * every dev path is the plain 404, whether or not the file exists.
 */
function makeStaticHandler(publicDir, { dev = false } = {}) {
  const root = path.resolve(publicDir);
  const frameOptions = dev ? 'SAMEORIGIN' : 'DENY';
  return function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    } catch {
      sendText(res, 400, 'Bad request');
      return;
    }
    if (pathname === '/healthz') { sendText(res, 200, 'ok'); return; }
    if (isDevPath(pathname)) {
      if (!dev) { sendText(res, 404, 'Not found'); return; }
      if (pathname === '/devinfo') { sendJson(res, 200, { dev: true }); return; }
      if (pathname === '/dev' || pathname === '/dev/') pathname = '/dev.html';
    }
    if (pathname.includes('\0') || pathname.includes('\\')) { sendText(res, 400, 'Bad request'); return; }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const segments = pathname.split('/').filter(Boolean);
    if (segments.some((s) => s === '..')) { sendText(res, 403, 'Forbidden'); return; }
    if (segments.some((s) => s.startsWith('.'))) { sendText(res, 404, 'Not found'); return; }
    const filePath = path.resolve(root, ...segments);
    if (!insideDir(root, filePath) || filePath === root) { sendText(res, 403, 'Forbidden'); return; }
    fs.realpath(root, (errRoot, realRoot) => {
      if (errRoot) { sendText(res, 404, 'Not found'); return; }
      fs.realpath(filePath, (err, real) => {
        if (err) { sendText(res, 404, 'Not found'); return; }
        if (!insideDir(realRoot, real) || real === realRoot) { sendText(res, 403, 'Forbidden'); return; }
        fs.stat(real, (errStat, st) => {
          if (errStat || !st.isFile()) { sendText(res, 404, 'Not found'); return; }
          const ext = path.extname(real).toLowerCase();
          const isIndex = path.basename(real) === 'index.html';
          const lastModified = st.mtime.toUTCString();
          const security = {
            'Content-Security-Policy': CSP,
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'X-Frame-Options': frameOptions,
          };
          // an invite link to the app page (/?room=ABCD): the page with the room in its title, og:title and og:url, so
          // a chat app's preview names the room (server/meta.js; anything but a valid code gets the file as it is).
          // The whole page, 200: Range is ignored, which a server may always do.
          if (isIndex && real === path.join(realRoot, 'index.html') && roomFromUrl(req.url)) {
            fs.readFile(real, 'utf8', (errRead, text) => {
              if (errRead) { sendText(res, 404, 'Not found'); return; }
              const body = Buffer.from(withRoomPreview(text, req.url), 'utf8');
              res.writeHead(200, {
                'Content-Type': MIME['.html'],
                'Content-Length': body.length,
                'Cache-Control': 'no-store',
                ...security,
                'Last-Modified': lastModified,
              });
              res.end(req.method === 'HEAD' ? undefined : body);
            });
            return;
          }
          // every file but the app page (no-store: counted, and never cached) is revalidated: a weak ETag and
          // Last-Modified, and a 304 when the browser's copy is current (notModified)
          const etag = isIndex ? null : fileEtag(st);
          if (etag && notModified(req.headers, etag, st.mtimeMs)) {
            res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': 'no-cache', ...security });
            res.end();
            return;
          }
          // byte ranges (parseRange): for a GET only (RFC 9110 §14.2), and an If-Range that is not this file's
          // Last-Modified (a weak ETag, an older date) means the file changed since: then the whole file
          const ifRange = req.headers['if-range'];
          const range = req.method === 'GET' && (ifRange === undefined || ifRange === lastModified)
            ? parseRange(req.headers.range, st.size) : { status: 200 };
          if (range.status === 416) {
            sendText(res, 416, 'Range not satisfiable', { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${st.size}` });
            return;
          }
          const part = range.status === 206;
          res.writeHead(range.status, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': part ? range.end - range.start + 1 : st.size,
            ...(part ? { 'Content-Range': `bytes ${range.start}-${range.end}/${st.size}` } : {}),
            'Accept-Ranges': 'bytes',
            'Cache-Control': isIndex ? 'no-store' : 'no-cache',
            ...security,
            'Last-Modified': lastModified,
            ...(etag ? { ETag: etag } : {}),
          });
          if (req.method === 'HEAD') { res.end(); return; }
          const stream = fs.createReadStream(real, part ? { start: range.start, end: range.end } : undefined);
          stream.on('error', () => res.destroy());
          res.on('close', () => stream.destroy());
          stream.pipe(res);
        });
      });
    });
  };
}

// ---- usage counts and the owner's dashboard (server/analytics.js) ------------------------------------------------

/** The app page: what a visit loads first (/?room=CODE included). */
function isAppPage(pathname) {
  return pathname === '/' || pathname === '/index.html';
}

/** An answer of the dashboard: no-store, never indexed, never framed, no referrer (its URL carries the key). */
function sendAdmin(res, type, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': ADMIN_CSP,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

function rejectUpgrade(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* ignore */ }
  socket.destroy();
}

/**
 * Starts the server. Options override the env config (see configFromEnv).
 * Resolves to { server, rooms, port, host, url, close() }.
 */
export async function startServer(options = {}) {
  const cfg = { ...configFromEnv(), ...options };
  const log = cfg.logger || ((msg, err) => { process.stderr.write(`[bunker] ${msg}${err ? `: ${err?.stack || err}` : ''}\n`); });
  // §11 X9: dev mode only on exactly `dev: true` (BUNKER_DEV=1), never next to the production unit's settings. Its code
  // (server/dev.js, and tools/botlib.js for the bots) is loaded only here, so production never even imports it.
  const dev = cfg.dev === true;
  if (dev && (cfg.trustProxy || cfg.production)) throw new Error(DEV_REFUSED);
  const devModule = dev ? await import('./dev.js') : null;
  const rng = cfg.seed !== null && cfg.seed !== undefined ? mulberry32(seedFromString(cfg.seed)) : null;
  const rooms = new Rooms({
    rng,
    minPlayers: cfg.minPlayers,
    hostGraceMs: cfg.hostGraceMs,
    roomTtlMs: cfg.roomTtlMs ?? undefined,
    // §11 X9: a dev test table opens a room per "New test game" from one address, and its bots keep rooms busy, so the
    // per-network room cap (V1) would stop the owner after 5 of them: dev mode lifts it (the 200-room cap stays)
    maxRoomsPerIp: cfg.noLimits || dev ? Infinity : (cfg.maxRoomsPerIp ?? undefined),
    joinFailBurst: cfg.noLimits ? Infinity : (cfg.joinFailBurst ?? undefined),
    joinFailRefillMs: cfg.joinFailRefillMs ?? undefined,
    dealerFactory: cfg.dealerFactory ?? null,
    fixedSpecials: cfg.fixedSpecials !== false,
    logger: log,
  });
  if (devModule) rooms.dev = new devModule.DevTools(rooms, { logger: log, botIdleMs: cfg.devBotIdleMs, botDelay: cfg.devBotDelay });
  const serveStatic = makeStaticHandler(cfg.publicDir, { dev });

  // Usage counts (server/analytics.js): never in dev mode (its test tables are not visitors), and off with
  // `analytics: false`; an object there overrides Analytics' options (tests: a clock, a salt source, the interval).
  // `stateDir: null` keeps them in memory only. The dashboard needs them and a usable BUNKER_ADMIN_TOKEN.
  let wss = null;
  const analyticsOpts = cfg.analytics && typeof cfg.analytics === 'object' ? cfg.analytics : {};
  const analytics = dev || cfg.analytics === false ? null : new Analytics({
    file: cfg.stateDir ? path.join(cfg.stateDir, ANALYTICS_FILE) : null,
    logger: log,
    gauges: () => ({ sockets: wss ? wss.clients.size : 0, activeGames: rooms.stats().activeGames }),
    ...analyticsOpts,
  });
  rooms.analytics = analytics;
  const adminGate = analytics && adminTokenUsable(cfg.adminToken) ? new AdminGate({ token: cfg.adminToken, ...(cfg.adminGate || {}) }) : null;
  const clientIp = (req) => resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], cfg.trustProxy);

  /** Counts a GET of the app page (a view or a bot hit, and today's visitor hash in memory). Never throws. */
  const countPageView = (req, url) => {
    try {
      analytics.pageView({
        ip: clientIp(req), ua: req.headers['user-agent'], referer: req.headers.referer, host: req.headers.host,
        invite: url.searchParams.has('room'),
      });
    } catch (e) { log('analytics page view failed', e); }
  };

  /**
   * GET /admin/stats?key=… (HEAD too): the dashboard, or with &format=json its data. A missing or wrong key, a network
   * that has spent its failed attempts (AdminGate), or no dashboard at all get the static server's own 404, byte for
   * byte, so the path looks absent and there is no oracle. The static server itself answers them (there is no
   * public/admin/stats): a refusal then takes a missing file's time too, not a shortcut's measurably quicker one.
   */
  const serveAdmin = (req, res, url) => {
    if (!adminGate || !adminGate.check(clientIp(req), url.searchParams.get('key'))) { serveStatic(req, res); return; }
    const st = rooms.stats();
    const report = analytics.report({ sockets: wss.clients.size, rooms: st.rooms, activeGames: st.activeGames });
    if (url.searchParams.get('format') === 'json') {
      sendAdmin(res, 'application/json; charset=utf-8', JSON.stringify(report));
      return;
    }
    const jsonHref = `?key=${encodeURIComponent(url.searchParams.get('key'))}&format=json`;
    sendAdmin(res, 'text/html; charset=utf-8', renderDashboard(report, { jsonHref }));
  };

  // §11 X8: {rooms, activeGames, sockets} for the deploy script (curl 127.0.0.1:8080/stats on the server). Anyone
  // else, including every request through the proxy, gets the static server's own 404, so /stats looks absent.
  // `sockets` counts every open WebSocket, in a room or not.
  const serveStats = (req, res) => {
    if (!statsAllowed(req.socket.remoteAddress, req.headers)) { sendText(res, 404, 'Not found'); return; }
    const st = rooms.stats();
    const body = Buffer.from(JSON.stringify({ rooms: st.rooms, activeGames: st.activeGames, sockets: wss.clients.size }), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const isStatsRequest = (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false; // the static server's 405, as for any path
    try { return new URL(req.url || '/', 'http://localhost').pathname === '/stats'; } catch { return false; }
  };

  const server = http.createServer((req, res) => {
    try {
      if (isStatsRequest(req)) { serveStats(req, res); return; }
      if (analytics && (req.method === 'GET' || req.method === 'HEAD')) {
        let url = null;
        try { url = new URL(req.url || '/', 'http://localhost'); } catch { /* the static server answers it */ }
        if (url && url.pathname === '/admin/stats') { serveAdmin(req, res, url); return; }
        if (url && req.method === 'GET' && isAppPage(url.pathname)) countPageView(req, url);
      }
      serveStatic(req, res);
    } catch (e) {
      log('http handler failed', e);
      try { sendText(res, 500, 'Internal error'); } catch { res.destroy(); }
    }
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: wsDeflateOption(cfg.wsDeflate === true), clientTracking: true });
  const perIp = new Map();

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { /* keep '' */ }
    if (pathname !== '/ws') { rejectUpgrade(socket, 404, 'Not Found'); return; }
    // §11 X2: behind the proxy every peer is 127.0.0.1; the client's own address is what every per-IP limit counts
    const ip = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], cfg.trustProxy);
    req.bunkerIp = ip;
    if (!cfg.noLimits && socketBuckets(ip).some(([k, cap]) => (perIp.get(k) || 0) >= cap)) { rejectUpgrade(socket, 429, 'Too Many Requests'); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log('upgrade failed', e);
      socket.destroy();
    }
  });

  wss.on('connection', (ws, req) => {
    const ip = req.bunkerIp || resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], cfg.trustProxy);
    const buckets = socketBuckets(ip).map(([k]) => k);
    for (const k of buckets) perIp.set(k, (perIp.get(k) || 0) + 1);
    const conn = {
      ip,
      alive: true,
      recent: [],
      secStart: 0,
      secCount: 0,
      send(obj) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
      },
      // §11 X5.2: a state as the UTF-8 chunks of one JSON frame (rooms.js: this recipient's head, then the log's bytes,
      // encoded once per language and shared by every recipient of it)
      sendChunks(chunks) {
        if (ws.readyState === ws.OPEN) sendFragments(ws, chunks);
      },
    };
    ws._bunkerConn = conn;
    rooms.open(conn);
    if (analytics) {
      try { analytics.observe({ sockets: wss.clients.size }); } catch (e) { log('analytics observe failed', e); }
    }
    ws.on('error', () => {});
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data, isBinary) => {
      conn.alive = true;
      if (!cfg.noLimits) {
        const t = Date.now();
        conn.recent.push(t);
        while (conn.recent.length && conn.recent[0] <= t - BURST_WINDOW_MS) conn.recent.shift();
        if (conn.recent.length > BURST_MAX) { ws.close(1008, 'Too many messages'); return; }
        if (t - conn.secStart >= 1000) { conn.secStart = t; conn.secCount = 0; }
        if (++conn.secCount > RATE_PER_SEC) return; // dropped silently (§7)
      }
      let text = null;
      try { if (!isBinary) text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.concat([].concat(data)).toString('utf8'); } catch { text = null; }
      rooms.message(conn, text);
    });
    ws.on('close', () => {
      for (const k of buckets) {
        const n = (perIp.get(k) || 1) - 1;
        if (n <= 0) perIp.delete(k); else perIp.set(k, n);
      }
      try { rooms.close(conn); } catch (e) { log('close failed', e); }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const conn = ws._bunkerConn;
      if (!conn) continue;
      if (!conn.alive) { ws.terminate(); continue; }
      conn.alive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const sweepMs = Math.max(50, Math.min(1000, Math.floor(cfg.hostGraceMs / 5) || 50));
  const sweeper = setInterval(() => rooms.sweep(), sweepMs);
  sweeper.unref();

  await new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(cfg.port, cfg.host);
  });
  server.on('error', (e) => log('server error', e));
  // the analytics tick (a new salt at UTC midnight, the peaks sampled, the file written when something changed), and
  // the dashboard's failed-attempt budgets dropped once refilled
  analytics?.start();
  const gateSweep = adminGate ? setInterval(() => adminGate.sweep(), 60_000) : null;
  gateSweep?.unref();

  const port = server.address().port;
  const shownHost = cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host;
  let closed = false;
  return {
    server,
    wss,
    rooms,
    port,
    host: cfg.host,
    url: `http://${shownHost}:${port}`,
    config: cfg,
    analytics,
    adminEnabled: !!adminGate,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      clearInterval(heartbeat);
      clearInterval(sweeper);
      if (rooms.dev) rooms.dev.close();
      clearInterval(gateSweep);
      // the day's counts reach the disk first (SIGTERM: a deploy restart), then the sockets close
      const flushed = analytics ? analytics.close().catch((e) => log('analytics close failed', e)) : Promise.resolve();
      for (const ws of wss.clients) ws.terminate();
      const stopped = new Promise((resolve) => {
        wss.close(() => server.close(() => resolve()));
        server.closeAllConnections?.();
      });
      return Promise.all([flushed, stopped]).then(() => {});
    },
  };
}

/**
 * The process-wide handlers of a server run from the command line: an error nothing else caught is logged to stderr
 * instead of killing every room. A write to stdout or stderr after the process reading them has gone (a harness or a
 * terminal that exited; production's journald never goes) fails with EPIPE, which the stream reports as an 'error'
 * event. Unheard, that event is itself an uncaught exception, whose handler writes to stderr again, fails again, and so
 * on: an orphaned server spun at ~80% of a core for hours. So a failed log write is dropped (the stream's 'error'
 * listener), and the handler never throws.
 */
export function installProcessHandlers(proc = process) {
  const drop = () => {};
  proc.stdout.on('error', drop);
  proc.stderr.on('error', drop);
  const say = (line) => { try { proc.stderr.write(line); } catch { /* nowhere left to say it */ } };
  proc.on('uncaughtException', (e) => say(`[bunker] uncaught: ${e?.stack || e}\n`));
  proc.on('unhandledRejection', (e) => say(`[bunker] unhandled rejection: ${e?.stack || e}\n`));
}

if (import.meta.main) {
  installProcessHandlers();
  const cfg = configFromEnv();
  startServer(cfg).then((srv) => {
    process.stdout.write(`BUNKER_LISTENING ${srv.port}\n`);
    process.stdout.write(`listening on ${srv.url}\n`);
    if (cfg.dev) process.stdout.write(`${DEV_BANNER}\n`);
    process.stderr.write(`[bunker] public dir ${cfg.publicDir}; min players ${cfg.minPlayers}${cfg.seed !== null ? `; seed ${cfg.seed}` : ''}${cfg.noLimits ? '; limits OFF' : ''}${cfg.trustProxy ? '; trusting X-Forwarded-For from loopback' : ''}${cfg.wsDeflate ? '; WebSocket permessage-deflate on' : ''}${cfg.dev ? '; DEV MODE (test shortcuts at /dev)' : ''}${srv.analytics ? `; usage counts in ${srv.analytics.file ?? 'memory'}${srv.adminEnabled ? ', dashboard at /admin/stats' : ''}` : ''}\n`);
    if (srv.analytics && cfg.adminToken && !srv.adminEnabled) process.stderr.write('[bunker] BUNKER_ADMIN_TOKEN is shorter than 24 characters: /admin/stats stays off\n');
    const stop = () => { srv.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch((e) => {
    process.stderr.write(`[bunker] failed to start: ${e?.message || e}\n`);
    process.exit(1);
  });
}
