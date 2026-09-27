// server/analytics.js — first-party, aggregate-only usage counts and the owner's dashboard (reports/analytics.md).
//
// What is counted, per UTC day, and nothing else:
//   - page views: GETs of the app page (/ and /index.html, any query), `invites` those with ?room=, and `bots` the ones
//     whose User-Agent looks like a crawler, a link previewer or a script (isBotUA; counted as a number only);
//   - visitors: distinct HMAC-SHA256(dailySalt, network + "\0" + User-Agent) among today's human views (the Plausible
//     approach). The salt is 32 random bytes made when the UTC day starts, held in memory only and replaced at the next
//     UTC midnight (or restart); the set of today's hashes is in memory only and dropped with it. Only the COUNT is
//     persisted, so nobody can be followed from one day to the next, and nothing on disk can be tied to an address. The
//     network is the address every per-IP limit uses (index.js resolveClientIp, trust-proxy aware), IPv6 by its /64
//     (rooms.js ipKey), so a phone rotating privacy addresses is still one visitor;
//   - sources: the host of an external Referer (www. stripped, never an IP literal), at most MAX_SOURCES_PER_DAY a day;
//   - game events the server already knows (rooms.js calls these): rooms created, spectators joined, games started
//     (with seated players, a 2..16 histogram of them, their languages), finished (reached the final), ended by the
//     host, abandoned (deleted idle mid-game), and the day's peak open sockets and peak games in progress.
// No cookies, no client-side script, no third party. The day records go to one JSON file (atomic: tmp + fsync +
// rename) at most once per WRITE_INTERVAL_MS and on close; KEEP_DAYS days are kept, older ones are folded into
// `archived` (so all-time totals survive). A missing file starts fresh; an unreadable one is moved to <file>.bak first.
//
// The dashboard: GET /admin/stats?key=<BUNKER_ADMIN_TOKEN> (index.js). AdminGate compares keys in constant time
// (SHA-256 of both, then timingSafeEqual) and limits failed attempts per network; every refusal is the static 404.
// renderDashboard is one self-contained HTML page: inline CSS and inline SVG, no script, no external asset.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { ipKey } from './rooms.js';

export const ANALYTICS_FILE = 'analytics.json';
export const KEEP_DAYS = 400;
export const WRITE_INTERVAL_MS = 60_000;
/** Hashes of today's visitors kept in memory at most; past it a new visitor is still counted, without dedup. */
export const MAX_VISITORS_PER_DAY = 100_000;
export const MAX_SOURCES_PER_DAY = 30;
export const OTHER_SOURCE = '(other)';
/** BUNKER_ADMIN_TOKEN shorter than this leaves /admin/stats off (a plain 404). */
export const ADMIN_TOKEN_MIN = 24;
/** Failed dashboard attempts one network may make at once, then one more per ADMIN_REFILL_MS. */
export const ADMIN_BURST = 10;
export const ADMIN_REFILL_MS = 60_000;
const ADMIN_MAX_BUCKETS = 10_000;
const DAY_MS = 86_400_000;
const FORMAT = 1;
const STALE_TMP_MS = 3_600_000;

/** Plain counters of a day record (summed over periods). */
export const COUNTERS = Object.freeze(['views', 'invites', 'bots', 'visitors', 'rooms', 'started', 'finished', 'endedByHost', 'abandoned', 'players', 'spectators']);
/** Peaks of a day record (the max over periods). */
export const PEAKS = Object.freeze(['peakSockets', 'peakGames']);
export const HIST_MIN = 2;
export const HIST_MAX = 16;
export const LANG_KEYS = Object.freeze(['en', 'ru']);

// ---- helpers --------------------------------------------------------------------------------------------------------

/** 'YYYY-MM-DD' of a time in UTC. */
export function dayKey(t) {
  return new Date(t).toISOString().slice(0, 10);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDayKey = (k) => typeof k === 'string' && DAY_RE.test(k) && !Number.isNaN(Date.parse(`${k}T00:00:00Z`)) && dayKey(Date.parse(`${k}T00:00:00Z`)) === k;
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

export function emptyDay() {
  const d = {};
  for (const k of COUNTERS) d[k] = 0;
  for (const k of PEAKS) d[k] = 0;
  d.hist = {};
  d.langs = {};
  d.sources = {};
  return d;
}

/** A day record rebuilt from anything (a file): known fields only, every number a non-negative safe integer. */
function sanitizeDay(x, maxSources = MAX_SOURCES_PER_DAY) {
  const d = emptyDay();
  if (!x || typeof x !== 'object' || Array.isArray(x)) return d;
  for (const k of [...COUNTERS, ...PEAKS]) d[k] = count(x[k]);
  if (x.hist && typeof x.hist === 'object') {
    for (let n = HIST_MIN; n <= HIST_MAX; n++) if (count(x.hist[n])) d.hist[n] = count(x.hist[n]);
  }
  if (x.langs && typeof x.langs === 'object') for (const l of LANG_KEYS) if (count(x.langs[l])) d.langs[l] = count(x.langs[l]);
  if (x.sources && typeof x.sources === 'object' && !Array.isArray(x.sources)) {
    for (const [h, v] of Object.entries(x.sources)) {
      if (Object.keys(d.sources).length >= maxSources) break;
      if ((h === OTHER_SOURCE || isSourceHost(h)) && count(v)) d.sources[h] = count(v);
    }
  }
  return d;
}

function addInto(sum, d) {
  for (const k of COUNTERS) sum[k] += d[k];
  for (const k of PEAKS) sum[k] = Math.max(sum[k], d[k]);
  for (const [k, v] of Object.entries(d.hist)) sum.hist[k] = (sum.hist[k] || 0) + v;
  for (const [k, v] of Object.entries(d.langs)) sum.langs[k] = (sum.langs[k] || 0) + v;
  for (const [k, v] of Object.entries(d.sources)) sum.sources[k] = (sum.sources[k] || 0) + v;
  return sum;
}

const HOST_RE = /^(?=.{1,100}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
function isSourceHost(h) {
  return typeof h === 'string' && HOST_RE.test(h) && !net.isIP(h) && !/^\d+(?:\.\d+)*$/.test(h);
}

/**
 * The source of a view: the host of an external Referer (http, https, android-app), lower-cased and without "www.",
 * or null (none, unparsable, an IP literal, or this site itself: `ownHost` from the Host header, with and without www.).
 */
export function sourceOf(referer, ownHost) {
  if (typeof referer !== 'string' || !referer || referer.length > 2000) return null;
  let u;
  try { u = new URL(referer); } catch { return null; }
  if (!['http:', 'https:', 'android-app:'].includes(u.protocol)) return null;
  const strip = (h) => String(h || '').toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const host = strip(u.hostname);
  if (!host || !isSourceHost(host)) return null;
  const own = typeof ownHost === 'string' ? strip(ownHost.replace(/:\d+$/, '')) : '';
  return own && host === own ? null : host;
}

/**
 * Whether a User-Agent is a crawler, a link previewer, a monitor or a script rather than a person's browser. Every
 * browser sends "Mozilla/5.0 …"; one that does not (curl, python-requests, WhatsApp's previewer …) or sends nothing is
 * a bot. Among Mozilla-compatible ones: a "…bot" word (not the Cubot phone), a URL (crawlers name their info page),
 * crawl/spider/preview/headless and the known tools and previewers.
 */
const BOT_WORDS = /(?<!cu)bot\b|https?:\/\/|crawl|spider|slurp|preview|headless|phantom|selenium|puppeteer|playwright|webdriver|lighthouse|pagespeed|gtmetrix|pingdom|uptime|statuscake|monitor|facebookexternalhit|meta-externalagent|embedly|vkshare|google-|googleother|-google|feedfetcher|validator|archiver|scanner|curl|wget|python|java\/|go-http|httpclient|http-client|okhttp|axios|node-fetch|undici|libwww|scrapy|php\//i;
export function isBotUA(ua) {
  if (typeof ua !== 'string') return true;
  const s = ua.trim();
  if (!s || s.length > 1000) return true;
  if (!/mozilla\//i.test(s) && !/^opera\//i.test(s)) return true;
  return BOT_WORDS.test(s);
}

// ---- the counter ----------------------------------------------------------------------------------------------------

export class Analytics {
  /**
   * @param {object} o
   * @param {string|null} [o.file]           the JSON file (null: in memory only)
   * @param {() => number} [o.now]           the clock (tests inject one)
   * @param {(n: number) => Buffer} [o.randomBytes]   the salt source
   * @param {(msg: string, err?: unknown) => void} [o.logger]
   * @param {() => {sockets?: number, activeGames?: number}} [o.gauges]   read on every tick and when a day starts
   * @param {number} [o.writeIntervalMs]
   * @param {number} [o.keepDays]
   * @param {number} [o.maxVisitors]
   */
  constructor({
    file = null, now = Date.now, randomBytes = crypto.randomBytes, logger = null, gauges = null,
    writeIntervalMs = WRITE_INTERVAL_MS, keepDays = KEEP_DAYS, maxVisitors = MAX_VISITORS_PER_DAY,
  } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.now = now;
    this.randomBytes = randomBytes;
    this.logger = logger || (() => {});
    this.gauges = gauges;
    this.writeIntervalMs = Math.max(1000, writeIntervalMs);
    this.keepDays = Math.max(1, keepDays);
    this.maxVisitors = maxVisitors;
    /** @type {Map<string, ReturnType<typeof emptyDay>>} day key -> record */
    this.days = new Map();
    /** Days pruned past keepDays, summed (all-time totals keep them). */
    this.archived = emptyDay();
    this.since = null;
    this.dirty = false;
    this.closed = false;
    this._today = null;
    this._salt = null;       // memory only, never serialized
    this._seen = new Set();  // today's visitor hashes, memory only
    this._timer = null;
    this._writing = null;
    this._writeFailed = false;
    if (this.file) this._load();
  }

  // -- the day and its salt
  /** Today's record; a new UTC day gets a new salt, an empty visitor set, its peaks seeded from the gauges. */
  _day() {
    const t = this.now();
    const key = dayKey(t);
    if (key !== this._today) {
      this._today = key;
      this._salt = this.randomBytes(32);
      this._seen = new Set();
      if (!this.days.has(key)) {
        this.days.set(key, emptyDay());
        this.dirty = true;
      }
      if (!this.since || key < this.since) this.since = key;
      this._prune(t);
      const g = this._readGauges();
      const d = this.days.get(key);
      if (g) this._peaks(d, g);
      return d;
    }
    return this.days.get(key);
  }

  _readGauges() {
    if (typeof this.gauges !== 'function') return null;
    try { return this.gauges(); } catch { return null; }
  }

  /** Folds days older than keepDays into `archived`. */
  _prune(t = this.now()) {
    const oldest = dayKey(t - (this.keepDays - 1) * DAY_MS);
    for (const k of [...this.days.keys()]) {
      if (k >= oldest) continue;
      addInto(this.archived, this.days.get(k));
      this.archived.sources = {}; // sources are shown for recent days only: the archive keeps none
      this.days.delete(k);
      this.dirty = true;
    }
  }

  _peaks(d, { sockets, activeGames } = {}) {
    if (Number.isSafeInteger(sockets) && sockets > d.peakSockets) { d.peakSockets = sockets; this.dirty = true; }
    if (Number.isSafeInteger(activeGames) && activeGames > d.peakGames) { d.peakGames = activeGames; this.dirty = true; }
  }

  _bump(field, n = 1) {
    const d = this._day();
    d[field] += n;
    this.dirty = true;
    return d;
  }

  /** The visitor hash of a network and user agent under today's salt (call _day() first). */
  _visitorHash(ip, ua) {
    const netKey = ipKey(ip) ?? String(ip ?? '');
    return crypto.createHmac('sha256', this._salt).update(netKey).update('\0').update(String(ua ?? '')).digest('base64url').slice(0, 22);
  }

  // -- events
  /**
   * A GET of the app page. `ip`: the resolved client address; `ua`, `referer`, `host`: the request's headers; `invite`:
   * the URL had ?room=. Returns 'bot' or 'view'. Nothing of the request is kept beyond today's in-memory hash.
   */
  pageView({ ip, ua, referer, host, invite = false } = {}) {
    const d = this._day();
    this.dirty = true;
    if (isBotUA(ua)) { d.bots++; return 'bot'; }
    d.views++;
    if (invite) d.invites++;
    const h = this._visitorHash(ip, ua);
    if (!this._seen.has(h)) {
      d.visitors++;
      if (this._seen.size < this.maxVisitors) this._seen.add(h);
    }
    const src = sourceOf(referer, host);
    if (src) {
      const k = Object.hasOwn(d.sources, src) || Object.keys(d.sources).length < MAX_SOURCES_PER_DAY - 1 ? src : OTHER_SOURCE;
      d.sources[k] = (d.sources[k] || 0) + 1;
    }
    return 'view';
  }

  roomCreated() { this._bump('rooms'); }
  spectatorJoined() { this._bump('spectators'); }

  /** A game started: `players` seated (the histogram), their languages ({en, ru} counts). */
  gameStarted({ players = 0, langs = {} } = {}) {
    const d = this._bump('started');
    const n = count(players);
    d.players += n;
    if (n >= HIST_MIN && n <= HIST_MAX) d.hist[n] = (d.hist[n] || 0) + 1;
    for (const l of LANG_KEYS) if (count(langs[l])) d.langs[l] = (d.langs[l] || 0) + count(langs[l]);
  }

  gameFinished() { this._bump('finished'); }
  gameEndedByHost() { this._bump('endedByHost'); }
  gameAbandoned() { this._bump('abandoned'); }

  /** Current open sockets and/or games in progress: raises the day's peaks. */
  observe(g = {}) { this._peaks(this._day(), g); }

  // -- time passing, persistence
  /** Starts the periodic tick (unref'd). */
  start() {
    if (this._timer || this.closed) return this;
    this._timer = setInterval(() => this.tick(), this.writeIntervalMs);
    this._timer.unref?.();
    return this;
  }

  /** Once per interval: roll the day (a new salt at UTC midnight even with no traffic), sample the gauges, write. */
  tick() {
    if (this.closed) return null;
    const d = this._day();
    const g = this._readGauges();
    if (g) this._peaks(d, g);
    return this.flush();
  }

  /** The file's contents: day records and totals only (never the salt, a hash, an address or a user agent). */
  serialize() {
    const days = {};
    for (const k of [...this.days.keys()].sort()) days[k] = this.days.get(k);
    return JSON.stringify({ v: FORMAT, since: this.since, archived: this.archived, days });
  }

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') this.logger(`analytics: cannot read ${this.file}, starting fresh`, e.code || e);
      this._cleanTmp();
      return;
    }
    this._cleanTmp();
    let obj = null;
    try { obj = JSON.parse(text); } catch { obj = null; }
    const ok = obj && typeof obj === 'object' && !Array.isArray(obj) && obj.v === FORMAT && obj.days && typeof obj.days === 'object' && !Array.isArray(obj.days);
    if (!ok) {
      const bak = `${this.file}.bak`;
      try { fs.renameSync(this.file, bak); } catch { /* keep going: the next write replaces it */ }
      this.logger(`analytics: ${this.file} is not a valid analytics file; moved to ${path.basename(bak)}, starting fresh`);
      return;
    }
    for (const [k, v] of Object.entries(obj.days)) if (isDayKey(k)) this.days.set(k, sanitizeDay(v));
    this.archived = sanitizeDay(obj.archived, 0);
    const first = [...this.days.keys()].sort()[0] ?? null;
    this.since = isDayKey(obj.since) && (!first || obj.since <= first) ? obj.since : first;
    this._prune();
  }

  /** Removes temp files an interrupted write left (older than an hour: another process may be writing one now). */
  _cleanTmp() {
    try {
      const dir = path.dirname(this.file);
      const base = path.basename(this.file);
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(`${base}.`) || !f.endsWith('.tmp')) continue;
        const p = path.join(dir, f);
        try { if (this.now() - fs.statSync(p).mtimeMs > STALE_TMP_MS) fs.unlinkSync(p); } catch { /* ignore */ }
      }
    } catch { /* no directory yet */ }
  }

  _tmpName() {
    return `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  }

  _wrote(ok, e) {
    if (ok) { this._writeFailed = false; return; }
    this.dirty = true;
    if (!this._writeFailed) this.logger(`analytics: cannot write ${this.file}`, e?.code || e);
    this._writeFailed = true;
  }

  /** Writes the file now if anything changed (tmp, fsync, rename). Resolves when done; never rejects. */
  flush() {
    if (!this.file || !this.dirty || this.closed) return Promise.resolve(false);
    if (this._writing) return this._writing;
    const body = this.serialize();
    this.dirty = false;
    const tmp = this._tmpName();
    this._writing = (async () => {
      try {
        await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const fh = await fsp.open(tmp, 'w', 0o600);
        try { await fh.writeFile(body); await fh.sync(); } finally { await fh.close(); }
        await fsp.rename(tmp, this.file);
        this._wrote(true);
        return true;
      } catch (e) {
        await fsp.unlink(tmp).catch(() => {});
        this._wrote(false, e);
        return false;
      } finally {
        this._writing = null;
      }
    })();
    return this._writing;
  }

  /** The same write, synchronously (close). */
  flushSync() {
    if (!this.file || !this.dirty) return false;
    const body = this.serialize();
    const tmp = this._tmpName();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      this._wrote(true);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      this._wrote(false, e);
      return false;
    }
  }

  /** Stops the tick, waits for a write in flight, then writes what is left. Drops the salt and today's hashes. */
  async close() {
    if (this.closed) return;
    clearInterval(this._timer);
    this._timer = null;
    if (this._writing) await this._writing;
    this.closed = true;
    this.flushSync();
    this._salt = null;
    this._seen = new Set();
  }

  // -- reading
  /** Sums of the days from `fromKey` to `toKey` (inclusive). */
  sum(fromKey, toKey) {
    const s = emptyDay();
    for (const [k, d] of this.days) if (k >= fromKey && k <= toKey) addInto(s, d);
    return s;
  }

  /** Everything the dashboard shows: periods (today, last 7 and 30 days, all time) and the kept days, oldest first. */
  report(live = null) {
    this._day();
    const today = this._today;
    const t = Date.parse(`${today}T00:00:00Z`);
    const back = (n) => dayKey(t - n * DAY_MS);
    const all = addInto(this.sum('0000-00-00', '9999-99-99'), this.archived);
    const days = [];
    for (const k of [...this.days.keys()].sort()) days.push({ date: k, ...this.days.get(k) });
    return {
      generatedAt: new Date(this.now()).toISOString(),
      timezone: 'UTC',
      today,
      since: this.since,
      live,
      periods: {
        today: this.sum(today, today),
        last7: this.sum(back(6), today),
        last30: this.sum(back(29), today),
        all,
      },
      days,
    };
  }
}

// ---- the dashboard's gate -------------------------------------------------------------------------------------------

/** Whether a BUNKER_ADMIN_TOKEN value turns the dashboard on. */
export function adminTokenUsable(token) {
  return typeof token === 'string' && token.length >= ADMIN_TOKEN_MIN;
}

export class AdminGate {
  /**
   * @param {object} o
   * @param {string} o.token      BUNKER_ADMIN_TOKEN (adminTokenUsable)
   * @param {() => number} [o.now]
   * @param {number} [o.burst]    failed attempts one network may make at once
   * @param {number} [o.refillMs] one more failed attempt per this many ms
   */
  constructor({ token, now = Date.now, burst = ADMIN_BURST, refillMs = ADMIN_REFILL_MS, maxBuckets = ADMIN_MAX_BUCKETS } = {}) {
    if (!adminTokenUsable(token)) throw new Error(`admin token must be at least ${ADMIN_TOKEN_MIN} characters`);
    this._want = crypto.createHash('sha256').update(token, 'utf8').digest();
    this.now = now;
    this.burst = burst;
    this.refillMs = Math.max(1, refillMs);
    this.maxBuckets = maxBuckets;
    /** @type {Map<string, {tokens: number, at: number}>} failed-attempt budget per network (memory only) */
    this.buckets = new Map();
  }

  /**
   * Whether `key` is the token, in constant time: both sides are hashed to 32 bytes first, so neither the length nor
   * any prefix of the token shows in the timing. A missing or non-string key is compared as '' (the same work).
   */
  matches(key) {
    const got = crypto.createHash('sha256').update(typeof key === 'string' ? key : '', 'utf8').digest();
    return crypto.timingSafeEqual(got, this._want);
  }

  _bucket(k, t = this.now()) {
    const b = this.buckets.get(k);
    if (!b) return null;
    b.tokens = Math.min(this.burst, b.tokens + Math.max(0, t - b.at) / this.refillMs);
    b.at = t;
    if (b.tokens >= this.burst) { this.buckets.delete(k); return null; }
    return b;
  }

  /**
   * One attempt from a client address: true only for the right key from a network with budget left. A network that has
   * spent its budget is refused even the right key until it refills, so guessing cannot go faster than the refill.
   */
  check(ip, key) {
    const ok = this.matches(key);
    const t = this.now();
    let slot = ipKey(ip) ?? String(ip ?? '');
    let b = this._bucket(slot, t);
    // once the map is full, every network without a budget of its own shares one: memory stays bounded, and a flood
    // of fresh networks is throttled as one
    if (!b && this.buckets.size >= this.maxBuckets) {
      slot = '*';
      b = this._bucket(slot, t);
    }
    if (b && b.tokens < 1) return false;
    if (ok) return true;
    if (!b) {
      b = { tokens: this.burst, at: t };
      this.buckets.set(slot, b);
    }
    b.tokens = Math.max(0, b.tokens - 1);
    return false;
  }

  /** Drops budgets that have refilled (index.js calls it with the analytics tick). */
  sweep() {
    const t = this.now();
    for (const k of [...this.buckets.keys()]) this._bucket(k, t);
  }
}

// ---- the dashboard's page -------------------------------------------------------------------------------------------

/** The dashboard's own CSP: nothing but its inline style (no script, no request of any kind). */
export const ADMIN_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const pct = (a, b) => (b > 0 ? `${Math.round((100 * a) / b)}%` : '—');
const avg = (a, b, digits = 1) => (b > 0 ? (a / b).toFixed(digits) : '—');

/** A rounded-top bar from the baseline (4px data end, square at the baseline). */
function barPath(x, y, w, base) {
  const r = Math.min(4, w / 2, base - y);
  if (r <= 0) return `M${x},${base}H${x + w}`;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

/** The chart's top: 2, 4, 6, 8 or 10 times a power of ten, so its half (the middle gridline) is a whole number. */
function niceMax(v) {
  if (v <= 2) return 2;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [2, 4, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * An inline-SVG column chart of one series: `points` [{label, value, title}], one baseline, a gridline and label at
 * the rounded-up max, x labels every `every` columns, a native tooltip (<title>) on each column.
 */
function columnChart(points, { title, unit, every = 1, height = 180, desc = '' }) {
  const W = 720;
  const H = height;
  const left = 40;
  const right = 8;
  const top = 14;
  const base = H - 26;
  const n = Math.max(1, points.length);
  const slot = (W - left - right) / n;
  const w = Math.min(24, Math.max(2, slot - 2));
  const max = niceMax(Math.max(0, ...points.map((p) => p.value)));
  const y = (v) => base - ((base - top) * v) / max;
  const parts = [];
  parts.push(`<line class="grid" x1="${left}" x2="${W - right}" y1="${top}" y2="${top}"/>`);
  parts.push(`<line class="grid" x1="${left}" x2="${W - right}" y1="${y(max / 2)}" y2="${y(max / 2)}"/>`);
  parts.push(`<text class="axis" x="${left - 6}" y="${top + 5}" text-anchor="end">${fmt(max)}</text>`);
  parts.push(`<text class="axis" x="${left - 6}" y="${y(max / 2) + 5}" text-anchor="end">${fmt(max / 2)}</text>`);
  points.forEach((p, i) => {
    const x = left + i * slot + (slot - w) / 2;
    const tip = `<title>${esc(p.title ?? `${p.label}: ${fmt(p.value)} ${unit}`)}</title>`;
    // the hit target is the whole slot, taller than the mark
    parts.push(`<g class="col">${tip}<rect class="hit" x="${left + i * slot}" y="${top}" width="${slot}" height="${base - top}"/>${p.value > 0 ? `<path class="bar" d="${barPath(x, y(p.value), w, base)}"/>` : ''}</g>`);
    if (i % every === 0 || i === n - 1) parts.push(`<text class="axis" x="${x + w / 2}" y="${base + 18}" text-anchor="middle">${esc(p.label)}</text>`);
  });
  parts.push(`<line class="base" x1="${left}" x2="${W - right}" y1="${base}" y2="${base}"/>`);
  return `<figure><figcaption>${esc(title)}</figcaption><div class="wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${desc ? `<desc>${esc(desc)}</desc>` : ''}${parts.join('')}</svg></div></figure>`;
}

/** EN/RU share as one stacked bar with direct labels. */
function shareBar(langs, title) {
  const en = langs.en || 0;
  const ru = langs.ru || 0;
  const total = en + ru;
  if (!total) return `<figure><figcaption>${esc(title)}</figcaption><p class="muted">No games yet.</p></figure>`;
  const W = 720;
  const gap = en && ru ? 2 : 0;
  const wEn = Math.round(((W - gap) * en) / total);
  const wRu = W - gap - wEn;
  const segs = [];
  if (en) segs.push(`<rect class="s1" x="0" y="0" width="${wEn}" height="24" rx="4"><title>English: ${fmt(en)} seats (${pct(en, total)})</title></rect>`);
  if (ru) segs.push(`<rect class="s2" x="${wEn + gap}" y="0" width="${wRu}" height="24" rx="4"><title>Russian: ${fmt(ru)} seats (${pct(ru, total)})</title></rect>`);
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} 24" role="img" aria-label="${esc(title)}">${segs.join('')}</svg>`
    + `<p class="legend"><span class="key s1"></span>EN ${pct(en, total)} (${fmt(en)}) <span class="key s2"></span>RU ${pct(ru, total)} (${fmt(ru)})</p></figure>`;
}

function topSources(sources, n = 12) {
  const rows = Object.entries(sources).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const head = rows.slice(0, n);
  const rest = rows.slice(n).reduce((s, [, v]) => s + v, 0);
  if (rest) head.push([OTHER_SOURCE, rest]);
  return head;
}

/**
 * The dashboard: a self-contained HTML page (inline CSS and SVG, no script, no external asset). `jsonHref` links the
 * same data as JSON (it carries the key, so the page is no-store and no-referrer).
 */
export function renderDashboard(report, { jsonHref = '', siteName = 'Seal the Bunker' } = {}) {
  const { periods: P, live } = report;
  const cols = [['Today', P.today], ['7 days', P.last7], ['30 days', P.last30], ['All time', P.all]];
  const row = (label, f, hint = '') => `<tr><th scope="row">${esc(label)}${hint ? ` <span class="muted">${esc(hint)}</span>` : ''}</th>${cols.map(([, s]) => `<td>${f(s)}</td>`).join('')}</tr>`;
  const table = `<table class="sum"><thead><tr><th></th>${cols.map(([l]) => `<th scope="col">${esc(l)}</th>`).join('')}</tr></thead><tbody>`
    + row('Visitors', (s) => fmt(s.visitors), 'daily uniques, summed')
    + row('Page views', (s) => fmt(s.views))
    + row('… via an invite link', (s) => fmt(s.invites))
    + row('Bot hits', (s) => fmt(s.bots), 'not in the views')
    + row('Rooms created', (s) => fmt(s.rooms))
    + row('Games started', (s) => fmt(s.started))
    + row('… finished', (s) => fmt(s.finished))
    + row('… ended by the host', (s) => fmt(s.endedByHost))
    + row('… abandoned', (s) => fmt(s.abandoned))
    + row('Players per game', (s) => avg(s.players, s.started), 'average')
    + row('Spectators joined', (s) => fmt(s.spectators))
    + row('Peak open connections', (s) => fmt(s.peakSockets))
    + row('Peak games at once', (s) => fmt(s.peakGames))
    + '</tbody></table>';

  // the last 30 days, oldest first, missing days as zeros
  const t = Date.parse(`${report.today}T00:00:00Z`);
  const byDate = new Map(report.days.map((d) => [d.date, d]));
  const last30 = [];
  for (let i = 29; i >= 0; i--) {
    const k = dayKey(t - i * DAY_MS);
    last30.push({ date: k, ...(byDate.get(k) || emptyDay()) });
  }
  const short = (k) => k.slice(5);
  const visitorsChart = columnChart(last30.map((d) => ({ label: short(d.date), value: d.visitors, title: `${d.date}: ${fmt(d.visitors)} visitors, ${fmt(d.views)} views` })),
    { title: 'Visitors per day, last 30 days (UTC)', unit: 'visitors', every: 5 });
  const gamesChart = columnChart(last30.map((d) => ({ label: short(d.date), value: d.started, title: `${d.date}: ${fmt(d.started)} games started, ${fmt(d.finished)} finished` })),
    { title: 'Games started per day, last 30 days (UTC)', unit: 'games', every: 5 });
  const lo = [2, 3].some((n) => P.all.hist[n]) ? HIST_MIN : 4;
  const hist = [];
  for (let n = lo; n <= HIST_MAX; n++) hist.push({ label: String(n), value: P.all.hist[n] || 0, title: `${n} players: ${fmt(P.all.hist[n] || 0)} games` });
  const histChart = columnChart(hist, { title: 'Players per started game, all time', unit: 'games', height: 160 });

  const srcRows = topSources(P.last30.sources);
  const sources = srcRows.length
    ? `<table class="src"><thead><tr><th scope="col">Source (last 30 days)</th><th scope="col">Views</th></tr></thead><tbody>${srcRows.map(([h, v]) => `<tr><td>${esc(h)}</td><td>${fmt(v)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No external referrers in the last 30 days (direct visits, apps and privacy settings send none).</p>';

  const daily = `<table class="daily"><thead><tr>${['Day', 'Visitors', 'Views', 'Invites', 'Bots', 'Rooms', 'Started', 'Finished', 'Ended', 'Abandoned', 'Peak conn.', 'Peak games'].map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>`
    + [...last30].reverse().map((d) => `<tr><th scope="row">${esc(d.date)}</th>${[d.visitors, d.views, d.invites, d.bots, d.rooms, d.started, d.finished, d.endedByHost, d.abandoned, d.peakSockets, d.peakGames].map((v) => `<td>${fmt(v)}</td>`).join('')}</tr>`).join('')
    + '</tbody></table>';

  const now = live ? `<p class="live"><strong>${fmt(live.sockets)}</strong> open connections · <strong>${fmt(live.rooms)}</strong> rooms · <strong>${fmt(live.activeGames)}</strong> games in progress</p>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Usage stats</title>
<style>
:root{color-scheme:light;--bg:#fcfcfb;--card:#ffffff;--ink:#0b0b0b;--ink2:#52514e;--rule:#e4e3df;--s1:#2a78d6;--s2:#eb6834}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;--bg:#1a1a19;--card:#222220;--ink:#ffffff;--ink2:#c3c2b7;--rule:#383835;--s1:#3987e5;--s2:#d95926}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:800px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:16px;margin:28px 0 8px}
.muted,.axis,figcaption,.meta{color:var(--ink2)}
.meta{margin:0 0 12px;font-size:13px}
.live{margin:0 0 16px}
.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{padding:5px 8px;border-bottom:1px solid var(--rule);text-align:right;white-space:nowrap}
th[scope=row],.src td:first-child,.src th:first-child{text-align:left;font-weight:normal}
thead th{font-weight:600;color:var(--ink2);font-size:13px}
.sum th[scope=row] .muted{font-size:12px}
.daily{font-size:13px}
.daily th,.daily td{padding:4px 6px}
@media (max-width:600px){th,td{padding:4px 5px}.sum th[scope=row]{white-space:normal}.sum th[scope=row] .muted{display:none}}
figure{margin:20px 0 0}
figcaption{font-size:13px;margin-bottom:4px}
svg{display:block;width:100%;height:auto}
svg text{font-size:13px;fill:var(--ink2)}
svg.chart{min-width:540px}
.bar{fill:var(--s1)}
.hit{fill:transparent}
.col:hover .bar{opacity:.8}
.grid{stroke:var(--rule);stroke-width:1}
.base{stroke:var(--ink2);stroke-width:1}
.s1{fill:var(--s1);background:var(--s1)}
.s2{fill:var(--s2);background:var(--s2)}
.legend{font-size:13px;margin:6px 0 0}
.key{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px;vertical-align:-1px}
.key:first-child{margin-left:0}
footer{margin-top:32px;font-size:13px;color:var(--ink2)}
a{color:var(--s1)}
</style>
</head>
<body>
<main>
<h1>${esc(siteName)} · usage</h1>
<p class="meta">UTC day ${esc(report.today)} · generated ${esc(report.generatedAt.slice(11, 16))} UTC${report.since ? ` · counting since ${esc(report.since)}` : ''}${jsonHref ? ` · <a href="${esc(jsonHref)}" rel="noreferrer">JSON</a>` : ''}</p>
${now}
<div class="wrap">${table}</div>
${visitorsChart}
${gamesChart}
<h2>Games</h2>
${histChart}
${shareBar(P.all.langs, 'Language of seated players, all time')}
${shareBar(P.last30.langs, 'Language of seated players, last 30 days')}
<h2>Where views come from</h2>
<div class="wrap">${sources}</div>
<h2>Last 30 days</h2>
<div class="wrap">${daily}</div>
<footer>
<p>Counted on the server, without cookies or scripts. A visitor is a salted hash of the network address and browser, with a random salt that lives in memory for one UTC day; only the daily count is stored, so visitors of different days (or before and after a restart) are counted again. Views exclude bots (by User-Agent) and HEAD requests. Peaks are sampled on connect, game start and every minute.</p>
</footer>
</main>
</body>
</html>
`;
}
