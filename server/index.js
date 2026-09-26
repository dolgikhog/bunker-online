#!/usr/bin/env node
// server/index.js — zero-dependency static server + WebSocket (/ws) on one port (SPEC.md §0, §8, §9).
//
// Env: PORT (8080; 0 = pick a free one), HOST (0.0.0.0), BUNKER_PUBLIC_DIR (<repo>/public; relative paths resolve
// against the repo root), BUNKER_SEED, BUNKER_MIN_PLAYERS (4, clamped 2..16), BUNKER_HOST_GRACE_MS (45000),
// BUNKER_NO_LIMITS (=1 lifts per-socket rate limits, the per-IP socket cap, the per-IP room cap and the per-IP budget of
// failed join/resume lookups), BUNKER_TRUST_PROXY (=1: behind a reverse proxy on this host, SPEC §11 X2; a socket whose
// TCP peer is loopback counts as the last address in its X-Forwarded-For for every per-IP limit).
// BUNKER_DEV (=1: dev mode, SPEC §11 X9: test shortcuts, see server/dev.js; never set in production, and refused
// together with BUNKER_TRUST_PROXY=1 or NODE_ENV=production).
// Once listening, prints `BUNKER_LISTENING <port>` and `listening on http://<host>:<port>` to stdout, then in dev mode
// DEV_BANNER.
// HTTP: GET /healthz -> ok; GET /stats -> {"rooms","activeGames","sockets"} only for a request made on this host (a
// loopback peer with no X-Forwarded-For, SPEC §11 X8), 404 for everyone else; in dev mode only, GET /devinfo ->
// {"dev":true} and /dev -> public/dev.html (without dev mode these and every public/dev.* file are the plain 404);
// every other path is a static file, GET or HEAD, with byte ranges for a GET (Accept-Ranges: bytes, 206, 416; see
// parseRange).

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Rooms, ipKey, siteKey, SITE_FACTOR } from './rooms.js';
import { mulberry32, seedFromString } from './rng.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CSP = "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'";
export const MAX_PAYLOAD = 8 * 1024;
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
          // byte ranges (parseRange): for a GET only (RFC 9110 §14.2), and an If-Range that is not this file's
          // Last-Modified (an ETag, an older date) means the file changed since: then the whole file
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
            'Content-Security-Policy': CSP,
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer',
            'X-Frame-Options': frameOptions,
            'Last-Modified': lastModified,
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

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, clientTracking: true });
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
    };
    ws._bunkerConn = conn;
    rooms.open(conn);
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
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      clearInterval(heartbeat);
      clearInterval(sweeper);
      if (rooms.dev) rooms.dev.close();
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => {
        wss.close(() => server.close(() => resolve()));
        server.closeAllConnections?.();
      });
    },
  };
}

if (import.meta.main) {
  process.on('uncaughtException', (e) => { process.stderr.write(`[bunker] uncaught: ${e?.stack || e}\n`); });
  process.on('unhandledRejection', (e) => { process.stderr.write(`[bunker] unhandled rejection: ${e?.stack || e}\n`); });
  const cfg = configFromEnv();
  startServer(cfg).then((srv) => {
    process.stdout.write(`BUNKER_LISTENING ${srv.port}\n`);
    process.stdout.write(`listening on ${srv.url}\n`);
    if (cfg.dev) process.stdout.write(`${DEV_BANNER}\n`);
    process.stderr.write(`[bunker] public dir ${cfg.publicDir}; min players ${cfg.minPlayers}${cfg.seed !== null ? `; seed ${cfg.seed}` : ''}${cfg.noLimits ? '; limits OFF' : ''}${cfg.trustProxy ? '; trusting X-Forwarded-For from loopback' : ''}${cfg.dev ? '; DEV MODE (test shortcuts at /dev)' : ''}\n`);
    const stop = () => { srv.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch((e) => {
    process.stderr.write(`[bunker] failed to start: ${e?.message || e}\n`);
    process.exit(1);
  });
}
