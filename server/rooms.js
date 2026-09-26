// server/rooms.js — room registry, identities & tokens, per-recipient broadcast, host grace, cleanup (SPEC.md §6, §7, §9).
// Transport-agnostic: a "conn" is any object with send(obj); one that also has sendChunks([Buffer, Buffer]) gets its
// states as the UTF-8 chunks of a ready JSON frame (index.js sends them as fragments of one WebSocket message), and one
// with sendText(string) as the JSON text.
//
// §11 X5.1 languages: every socket has `conn.lang` ('en' until a hello's `lang` or a setLang says otherwise). setLang
// is accepted at any time, like ping: before joining it only sets conn.lang (no reply); with an identity it also sets
// the member's language and sends that socket one state. Errors, `kicked.reason` and the `replaced` error are
// rendered in the receiving socket's language. States are rendered by the engine in the member's language; the log,
// the same for every recipient of one language, is serialized and UTF-8 encoded once per language and log version and
// spliced into each frame (`log` last on the wire, report §3.8). Over LOG_WIRE_BUDGET its oldest entries go without
// `parts` (report §14), and a frame that would still pass FRAME_BUDGET leaves its oldest entries off.

import crypto from 'node:crypto';
import { createGame, validateMessage, sanitizeName, fail } from './game.js';
import { deriveRng } from './rng.js';
import { renderText, normLang } from './i18n/index.js';

export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const MAX_ROOMS = 200;
export const ROOM_TTL_MS = 30 * 60 * 1000;
/** Live rooms one network (an IPv4 address, or an IPv6 /64) may have created (§11). BUNKER_NO_LIMITS lifts it. */
export const MAX_ROOMS_PER_IP = 5;
/**
 * Failed room lookups one network may make (§11 V2): `join`/`resume` naming a room that does not exist, or a token that
 * is not valid. A burst of JOIN_FAIL_BURST, then one more every JOIN_FAIL_REFILL_MS. Past that, join and resume get
 * `server_busy` whether or not the room exists, so the 4-letter code space cannot be scanned from one address. The one
 * exception (§11 Z1): a `resume` with a valid room and token is still admitted, so a neighbour's wrong codes on a
 * shared network cannot keep a player out of their own seat. BUNKER_NO_LIMITS lifts it.
 */
export const JOIN_FAIL_BURST = 20;
export const JOIN_FAIL_REFILL_MS = 3000;
/**
 * §11 X5: an IPv6 /48 ("site": what one customer or one free tunnel broker account gets, 65,536 /64s) counts as at most
 * SITE_FACTOR networks for every per-network limit: the V1 room cap, the V2 lookup budget (same refill, so a /48 scans
 * no faster than one /64) and index.js's socket cap. IPv4 has no site.
 */
export const SITE_FACTOR = 3;
export const MAX_ROOMS_PER_SITE = MAX_ROOMS_PER_IP * SITE_FACTOR;
export const JOIN_FAIL_SITE_BURST = JOIN_FAIL_BURST * SITE_FACTOR;
/** §11 X9: the answer to every {t:'dev'} when the server is not in dev mode (BUNKER_DEV=1), in English (err.devOff). */
export const DEV_OFF = renderText('en', 'err.devOff');
/** Hellos whose own `lang` applies before they are handled (§11 X5.1). */
const HELLOS = new Set(['create', 'join', 'resume']);

/**
 * §11 X5.2 (report §3.8, the §14 fallback): a state's size on the wire, FRAME_BUDGET bytes of UTF-8 per recipient at
 * most. Two steps, both on the log (the rest of the frame, "the head", is the view itself and is never trimmed):
 * 1. The parts cut. Every entry carries `parts` unless the log's JSON would then pass LOG_WIRE_BUDGET bytes; the
 *    oldest entries then go without them, as {id, ts, kind, text, key, params}, and clients render those from `text`
 *    (the path an entry without parts always takes). The newest PARTS_MIN entries always keep their parts: flashes, the
 *    final banner and the current turn read them. `parts` are half of a full log's bytes; without the cut a Russian
 *    state in the final is ~170 KB per recipient.
 * 2. The frame guard. LOG_WIRE_BUDGET leaves ~36 KB for the head, and the newest PARTS_MIN entries keep their parts
 *    whatever they cost, so with long Cyrillic names (NAME_MAX letters, 2 bytes each) and a special-heavy game the bare
 *    entries alone can nearly fill the log's budget, and a Russian final reached ~138 KB. When this recipient's head
 *    plus the cut log would pass FRAME_BUDGET, the parts cut is redone against what the head leaves (never below
 *    PARTS_MIN), and then the oldest entries are left off, as few as the frame needs and never the newest PARTS_MIN: the
 *    log is then the newest entries that fit, a shorter window of the same log (the engine already keeps only the last
 *    200). It only happens when a frame would pass the budget, so an English table (1 byte a letter) keeps its window.
 * Only which entries keep their parts and where the window starts depend on the budgets: the entries are the ones the
 * engine made, in its order, and every recipient whose frame fits gets the very same log.
 */
export const FRAME_BUDGET = 120 * 1024;
export const LOG_WIRE_BUDGET = 84 * 1024;
export const PARTS_MIN = 20;
/** The bytes a frame adds to its head and its log's JSON: `,"log":` (the head's closing `}` is reused). */
const LOG_SPLICE = Buffer.byteLength(',"log":');

/** An entry without its parts, cached per entry (entries are frozen and never change once logged). */
const BARE = new WeakMap();
function bareEntry(e) {
  if (!e || typeof e !== 'object' || !Object.hasOwn(e, 'parts')) return e;
  let b = BARE.get(e);
  if (b === undefined) {
    b = Object.freeze({ id: e.id, ts: e.ts, kind: e.kind, text: e.text, key: e.key, params: e.params });
    BARE.set(e, b);
  }
  return b;
}

/** An entry's JSON size in UTF-8 bytes, with and without its parts (cached per frozen entry). */
const SIZES = new WeakMap();
const jsonBytes = (x) => Buffer.byteLength(JSON.stringify(x) ?? 'null');
function entrySizes(e) {
  const frozen = !!e && typeof e === 'object' && Object.isFrozen(e);
  let s = frozen ? SIZES.get(e) : undefined;
  if (s === undefined) {
    const b = bareEntry(e);
    const full = jsonBytes(e);
    s = { full, bare: b === e ? full : jsonBytes(b) };
    if (frozen) SIZES.set(e, s);
  }
  return s;
}

/**
 * Where the §14 cut falls for a log that may take `logBudget` bytes of UTF-8 (Infinity: only the parts cut): `keep`, how
 * many of the newest entries keep their parts; `drop`, how many of the oldest are left off (the frame guard); `bytes`,
 * the resulting log's JSON size. The parts cut aims at min(LOG_WIRE_BUDGET, logBudget); only a log still over
 * logBudget with its newest PARTS_MIN entries' parts loses entries. When the parts cut alone fits logBudget, the plan is
 * exactly the parts cut's (the frame guard changes nothing for a frame within FRAME_BUDGET).
 */
function planCut(log, logBudget = Infinity, sizes = log.map(entrySizes)) {
  const n = log.length;
  let bytes = 2 + Math.max(0, n - 1); // the brackets and the commas
  for (const s of sizes) bytes += s.bare;
  const partsBudget = Math.min(LOG_WIRE_BUDGET, logBudget);
  let keep = 0;
  for (let i = n - 1; i >= 0; i--) {
    const extra = sizes[i].full - sizes[i].bare;
    if (keep >= PARTS_MIN && bytes + extra > partsBudget) break;
    bytes += extra;
    keep++;
  }
  let drop = 0;
  while (bytes > logBudget && n - drop > keep) bytes -= sizes[drop++].bare + 1; // the entry and its comma
  return { keep, drop, bytes };
}

/** The wire log a plan gives: the entries from `drop` on, those older than the newest `keep` without their parts. */
function applyCut(log, { keep, drop, bytes }) {
  const cut = log.length - keep;
  if (cut === 0 && drop === 0) return { log, bytes, json: null, tail: null };
  const out = [];
  for (let i = drop; i < log.length; i++) out.push(i < cut ? bareEntry(log[i]) : log[i]);
  return { log: Object.freeze(out), bytes, json: null, tail: null };
}

/**
 * What goes on the wire for one view's log array, for a frame whose log may take `logBudget` bytes. The engine hands
 * every recipient of one language the same frozen array until the log changes (report §3.8), so everything derived from
 * it is cached per array: the cut log, its JSON (kept only when a transport asks for text) and its UTF-8 bytes. The
 * parts cut alone (`def`) serves every frame it fits; the frame guard's cuts are cached by where they fall, so
 * recipients whose heads need the same cut share one encoding too.
 */
const WIRE = new WeakMap();
const cacheable = (log) => Array.isArray(log) && Object.isFrozen(log);
function wireOf(log, logBudget = Infinity) {
  if (!cacheable(log)) {
    const w = applyCut(log, planCut(log));
    return w.bytes <= logBudget ? w : applyCut(log, planCut(log, logBudget));
  }
  let c = WIRE.get(log);
  if (c === undefined) {
    const sizes = log.map(entrySizes);
    c = { sizes, def: applyCut(log, planCut(log, Infinity, sizes)), guarded: null };
    WIRE.set(log, c);
  }
  if (c.def.bytes <= logBudget) return c.def;
  const plan = planCut(log, logBudget, c.sizes);
  const k = `${plan.keep}:${plan.drop}`;
  c.guarded ??= new Map();
  let w = c.guarded.get(k);
  if (w === undefined) {
    w = applyCut(log, plan);
    c.guarded.set(k, w);
  }
  return w;
}

/**
 * A view's log as it is sent: the §14 parts cut (see LOG_WIRE_BUDGET), and, given the bytes the frame leaves for its
 * log (FRAME_BUDGET minus the head, see logBudgetFor), the frame guard.
 */
export function wireLog(log, logBudget = Infinity) {
  if (!Array.isArray(log)) return log;
  return wireOf(log, logBudget).log;
}

/** The bytes of UTF-8 a frame whose head (the view without its log, as JSON) takes `headBytes` leaves for its log. */
export function logBudgetFor(headBytes) {
  return FRAME_BUDGET - headBytes - LOG_SPLICE;
}

/** The JSON of a wire log, serialized once per cut of a log array (so once per language per log version). */
function jsonOf(w) {
  if (w.json === null) w.json = JSON.stringify(w.log);
  return w.json;
}

/**
 * The end of every frame that carries this wire log: `,"log":`, the log's JSON and the frame's closing `}`, as UTF-8,
 * encoded once per cut. Every recipient of one language is sent the very same bytes (no per-recipient encoding or copy).
 */
function tailOf(w) {
  if (w.tail === null) w.tail = Buffer.from(`,"log":${w.json ?? JSON.stringify(w.log)}}`);
  return w.tail;
}

/**
 * A state frame as JSON text: the view without its log, then the wire log (serialized once per language) spliced last,
 * within FRAME_BUDGET (the frame guard, see LOG_WIRE_BUDGET).
 */
export function stateFrame(view) {
  const { log, ...rest } = view;
  const head = JSON.stringify({ t: 'state', ...rest });
  if (!Array.isArray(log)) return `${head.slice(0, -1)},"log":${JSON.stringify(log)}}`;
  return `${head.slice(0, -1)},"log":${jsonOf(wireOf(log, logBudgetFor(Buffer.byteLength(head))))}}`;
}

/**
 * The same frame as two UTF-8 chunks whose concatenation is stateFrame(view): this recipient's head (the view without
 * its log, and without the closing `}`), then the log's shared tail (tailOf). index.js sends them as two fragments of
 * one WebSocket text message, so a broadcast encodes the head per recipient and the log once per language.
 */
export function stateFrameChunks(view) {
  const { log, ...rest } = view;
  const head = Buffer.from(JSON.stringify({ t: 'state', ...rest }));
  const tail = Array.isArray(log) ? tailOf(wireOf(log, logBudgetFor(head.length))) : Buffer.from(`,"log":${JSON.stringify(log)}}`);
  return [head.subarray(0, head.length - 1), tail];
}

/** A state as an object, for a transport that takes objects: the same wire log as the frame would carry. */
export function stateMessage(view) {
  const { log, ...rest } = view;
  const out = { t: 'state', ...view };
  if (Array.isArray(log)) out.log = wireLog(log, logBudgetFor(Buffer.byteLength(JSON.stringify({ t: 'state', ...rest }))));
  return out;
}

/** Phases of a game in progress (§11 X8 `activeGames`): a deploy restart would end it. */
const ACTIVE_PHASES = new Set(['reveal', 'discussion', 'vote', 'defense']);
const NO_TOKENS = new Map();

/** The 8 groups of an IPv6 address as numbers (a trailing dotted IPv4 is the last two), or null if it is not one. */
function ipv6Groups(a) {
  let s = a;
  const dotted = /(?:^|:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const b = dotted.slice(1, 5).map(Number);
    if (b.some((x) => x > 255)) return null;
    const start = dotted.index + (dotted[0].startsWith(':') ? 1 : 0);
    s = `${s.slice(0, start)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const h = parts[0] ? parts[0].split(':') : [];
  const t = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - h.length - t.length : 0;
  if (fill < 0 || (parts.length === 2 && fill === 0) || (parts.length === 1 && h.length !== 8)) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...t];
  return groups.every((g) => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map((g) => parseInt(g, 16)) : null;
}

/** A client address as {v4} (also any IPv4-mapped IPv6 spelling), {v6: groups}, or {raw} when it parses as neither. */
function parseAddr(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return null;
  let a = ip.trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (!a.includes(':')) return { v4: a };
  const g = ipv6Groups(a);
  if (!g) return { raw: a }; // never exempt: an odd string is still its own bucket
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return { v4: `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}` };
  return { v6: g };
}

/**
 * The bucket a client address counts in for MAX_ROOMS_PER_IP, the V2 lookup budget and the socket cap: IPv4 as is
 * (also IPv4-mapped IPv6, dotted or hex), IPv6 by its /64. `conn.ip` is the address index.js resolved (§11 X2: behind a
 * trusted proxy, the client's).
 */
export function ipKey(ip) {
  const a = parseAddr(ip);
  if (!a) return null;
  if (a.v6) return `${a.v6.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
  return a.v4 ?? a.raw;
}

/** §11 X5: the coarser bucket of an IPv6 client, its /48; null for IPv4 (and IPv4-mapped) or no address. */
export function siteKey(ip) {
  const a = parseAddr(ip);
  return a && a.v6 ? `${a.v6.slice(0, 3).map((x) => x.toString(16)).join(':')}::/48` : null;
}

export class Rooms {
  /**
   * @param {object} o
   * @param {(() => number)|null} o.rng   seeded rng (BUNKER_SEED) or null for crypto/Math.random
   * @param {number} o.minPlayers         BUNKER_MIN_PLAYERS
   * @param {number} o.hostGraceMs        BUNKER_HOST_GRACE_MS
   * @param {number} o.roomTtlMs          delete rooms with no connected sockets for this long
   * @param {number} [o.maxRoomsPerIp]    live rooms one client network may have created (Infinity = no cap)
   * @param {number} [o.joinFailBurst]    failed join/resume lookups one network may make at once (Infinity = no cap)
   * @param {number} [o.joinFailRefillMs] one more failed lookup is allowed per this many ms
   * @param {number} [o.maxRoomsPerSite]  §11 X5, per IPv6 /48 (default SITE_FACTOR × maxRoomsPerIp)
   * @param {number} [o.joinFailSiteBurst] §11 X5, per IPv6 /48 (default SITE_FACTOR × joinFailBurst)
   * @param {() => number} o.now
   * @param {(rng) => object} [o.dealerFactory]  optional, for tests
   * @param {boolean} [o.fixedSpecials=true]      §11 X1 fixed Airlock/revive deal (false: the dealer supplies every special; tests)
   * @param {(msg: string, err?: unknown) => void} [o.logger]
   */
  constructor({
    rng = null, minPlayers = 4, hostGraceMs = 45000, roomTtlMs = ROOM_TTL_MS, maxRoomsPerIp = MAX_ROOMS_PER_IP,
    joinFailBurst = JOIN_FAIL_BURST, joinFailRefillMs = JOIN_FAIL_REFILL_MS, now = Date.now, dealerFactory = null, logger = null,
    fixedSpecials = true, maxRoomsPerSite = maxRoomsPerIp * SITE_FACTOR, joinFailSiteBurst = joinFailBurst * SITE_FACTOR,
  } = {}) {
    this.rng = rng;
    this.fixedSpecials = fixedSpecials !== false;
    this.maxRoomsPerIp = maxRoomsPerIp;
    this.maxRoomsPerSite = maxRoomsPerSite;
    this.joinFailBurst = joinFailBurst;
    this.joinFailSiteBurst = joinFailSiteBurst;
    this.joinFailRefillMs = Math.max(1, joinFailRefillMs);
    /** @type {Map<string, {tokens: number, at: number, burst: number}>} failed-lookup budget per network and /48 (§11 V2, X5) */
    this.lookupBudget = new Map();
    this.minPlayers = minPlayers;
    this.hostGraceMs = hostGraceMs;
    this.roomTtlMs = roomTtlMs;
    this.now = now;
    this.dealerFactory = dealerFactory;
    this.logger = logger || (() => {});
    /** @type {Map<string, {code: string, game: any, tokens: Map<string,string>, idToken: Map<string,string>, conns: Map<string, any>, emptySince: number|null}>} */
    this.rooms = new Map();
    /**
     * §11 X9: server/dev.js's DevTools in dev mode (index.js sets it), otherwise null. Every dev path in this file is
     * behind it: {t:'dev'} ops, `create`'s seed, the god view and the in-process bots.
     */
    this.dev = null;
  }

  // ------------------------------------------------------------------------------------------------ transport hooks
  open(conn) {
    conn.roomCode = null;
    conn.playerId = null;
    conn.lang = normLang(conn.lang) ?? 'en';
  }

  close(conn) {
    this._detach(conn, true);
  }

  /** Handles one text frame. Never throws. */
  message(conn, text) {
    try {
      this._message(conn, text);
    } catch (e) {
      this.logger('message handler failed', e);
      this._error(conn, fail('bad_request', 'err.generic'));
    }
  }

  /** Periodic housekeeping: host grace passing and deleting abandoned rooms. */
  sweep() {
    const t = this.now();
    for (const key of [...this.lookupBudget.keys()]) this._budget(key, t); // drops budgets that are full again
    for (const room of [...this.rooms.values()]) {
      try {
        if (room.conns.size === 0) {
          if (room.emptySince !== null && t - room.emptySince >= this.roomTtlMs) {
            this.rooms.delete(room.code);
            this.logger(`room ${room.code} deleted (idle)`);
          }
          continue;
        }
        const off = room.game.hostOfflineMs();
        if (off !== null && off >= this.hostGraceMs && room.game.passHost()) this._broadcast(room);
      } catch (e) {
        this.logger('sweep failed', e);
      }
    }
    if (this.dev) {
      try { this.dev.sweep(); } catch (e) { this.logger('dev sweep failed', e); }
    }
  }

  /**
   * Registry counts. `activeGames` (§11 X8): rooms whose game is being played (phase reveal, discussion, vote or
   * defense), so neither in the lobby nor in the final. `sockets`: sockets attached to a room identity.
   */
  stats() {
    let sockets = 0;
    let activeGames = 0;
    for (const r of this.rooms.values()) {
      sockets += r.conns.size;
      if (ACTIVE_PHASES.has(r.game.phase)) activeGames++;
    }
    return { rooms: this.rooms.size, activeGames, sockets };
  }

  // ------------------------------------------------------------------------------------------------ internals
  _send(conn, obj) {
    try { conn.send(obj); } catch (e) { this.logger('send failed', e); }
  }

  /** An error in the socket's language (§11 X5.1): a failure's key rendered, or its ready message when it has none. */
  _error(conn, res) {
    this._send(conn, { t: 'error', code: res.code, message: this._text(conn, res.key, res.params, res.message) });
  }

  /** `key` rendered in the socket's language (`fallback` when there is no key). */
  _text(conn, key, params, fallback = '') {
    if (!key) return fallback;
    return renderText(normLang(conn.lang) ?? 'en', key, params || {});
  }

  _message(conn, text) {
    if (typeof text !== 'string') { this._error(conn, fail('bad_request', 'err.jsonFrame')); return; }
    let msg;
    try { msg = JSON.parse(text); } catch { this._error(conn, fail('bad_request', 'err.malformedJson')); return; }
    const isObj = msg !== null && typeof msg === 'object' && !Array.isArray(msg);
    // §11 X9: {t:'dev', op, ...} exists only in dev mode. Otherwise every such message is not_allowed before any of its
    // fields is read, whoever sends it, joined or not.
    if (isObj && msg.t === 'dev') {
      if (this.dev) this.dev.handle(conn, msg);
      else this._error(conn, fail('not_allowed', 'err.devOff'));
      return;
    }
    // §11 X5.1: a hello's own valid `lang` applies before the hello is handled, so its answer (an error too) is in it
    if (isObj && HELLOS.has(msg.t) && normLang(msg.lang)) conn.lang = msg.lang;
    const bad = validateMessage(msg);
    if (bad) { this._error(conn, bad); return; }
    switch (msg.t) {
      case 'ping': this._send(conn, { t: 'pong' }); return;
      case 'setLang': this._setLang(conn, msg.lang); return;
      case 'create': this._create(conn, msg); return;
      case 'join': this._join(conn, msg); return;
      case 'resume': this._resume(conn, msg); return;
      default: break;
    }
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : null;
    if (!room || !conn.playerId || room.conns.get(conn.playerId) !== conn) {
      this._error(conn, fail('not_in_room'));
      return;
    }
    const res = room.game.handle(conn.playerId, msg);
    if (!res.ok) {
      if (res.internal) this.logger(`engine error on ${msg.t}`, room.game.lastError);
      this._error(conn, res);
      return;
    }
    this._afterChange(room, msg.t === 'kick' ? msg.playerId : null);
  }

  /**
   * §11 X5.1 setLang: always the socket's language; with an identity also the member's, answered with one state to this
   * socket only (a language is not a public change: nobody else gets anything). Before joining there is no reply.
   */
  _setLang(conn, lang) {
    conn.lang = lang;
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : null;
    if (!room || !conn.playerId || room.conns.get(conn.playerId) !== conn) return;
    room.game.setLang(conn.playerId, lang);
    this._sendState(room, conn.playerId, conn);
  }

  _randInt(n) {
    if (this.rng) return Math.min(n - 1, Math.floor(this.rng() * n));
    return crypto.randomInt(n);
  }

  _newCode() {
    for (let i = 0; i < 10000; i++) {
      let code = '';
      for (let j = 0; j < 4; j++) code += ROOM_ALPHABET[this._randInt(ROOM_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  _newToken() {
    return crypto.randomBytes(18).toString('base64url'); // 144 bits, never from the seeded rng
  }

  _create(conn, msg) {
    // §11 X9: in dev mode `create` takes a `seed` (a malformed one is bad_request); without dev mode it is never read.
    let seed = null;
    if (this.dev) {
      const parsed = this.dev.parseSeed(msg.seed);
      if (!parsed.ok) { this._error(conn, parsed.fail); return; }
      seed = parsed.seed;
    }
    if (!sanitizeName(msg.name)) { this._error(conn, fail('bad_request', 'err.nameRequired')); return; }
    const old = this._soleLobby(conn); // freed below: nobody could ever come back to it
    if (this.rooms.size - (old ? 1 : 0) >= MAX_ROOMS) { this._error(conn, fail('server_busy')); return; }
    // Per-network cap: one client must not be able to hold every room slot. At the cap, the oldest abandoned
    // single-member lobby of that network makes room; rooms somebody else joined are never evicted. An IPv6 client
    // counts in its /64 and, more loosely, in its /48 (§11 X5).
    const key = ipKey(conn.ip);
    const site = siteKey(conn.ip);
    let evict = null;
    const full = [['ipKey', key, this.maxRoomsPerIp], ['siteKey', site, this.maxRoomsPerSite]]
      .filter(([, k, cap]) => k && Number.isFinite(cap))
      .map(([field, k, cap]) => ({ cap, mine: [...this.rooms.values()].filter((r) => r[field] === k && r !== old) }))
      .filter((level) => level.mine.length >= level.cap);
    if (full.length) {
      // The narrowest full level first: a lobby evicted from the /64 also frees a room of its /48.
      evict = full[0].mine.filter((r) => r.conns.size === 0 && isLoneLobby(r))
        .sort((a, b) => (a.emptySince ?? 0) - (b.emptySince ?? 0))[0] || null;
      if (!evict || full.some((level) => level.mine.length - (level.mine.includes(evict) ? 1 : 0) >= level.cap)) {
        this._error(conn, fail('server_busy', 'err.tooManyRooms'));
        return;
      }
    }
    const code = this._newCode();
    if (!code) { this._error(conn, fail('server_busy')); return; }
    const rng = seed !== null ? this.dev.roomRng(seed) : this.rng ? deriveRng(this.rng) : Math.random;
    const game = createGame({
      room: code, rng, now: this.now, minPlayers: this.minPlayers, fixedSpecials: this.fixedSpecials,
      ...(this.dealerFactory ? { dealer: this.dealerFactory(rng) } : {}),
    });
    const res = game.join(msg.name, { lang: conn.lang });
    if (!res.ok) { this._error(conn, res); return; }
    if (seed !== null) this.dev.logSeed(game, seed);
    if (evict) this._deleteRoom(evict);
    this._moveOut(conn, old);
    const room = { code, game, tokens: new Map(), idToken: new Map(), conns: new Map(), emptySince: null, ipKey: key, siteKey: site };
    this.rooms.set(code, room);
    this._admit(room, conn, res.id);
  }

  /**
   * The lobby this socket's identity is the only member of (no other seat, no spectator), or null. When the socket
   * creates, joins or resumes elsewhere, nobody could ever come back to that room, so it is deleted instead of
   * holding a room slot for the 30-minute idle TTL (§11).
   */
  _soleLobby(conn) {
    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : null;
    if (!room || !conn.playerId || room.conns.get(conn.playerId) !== conn || !isLoneLobby(room)) return null;
    return room.game.isActive(conn.playerId) ? room : null;
  }

  /** Takes the socket's identity out of its current room before it gets a new one: deletes `sole`, else detaches. */
  _moveOut(conn, sole) {
    if (sole && this.rooms.get(sole.code) === sole) {
      conn.roomCode = null;
      conn.playerId = null;
      this._deleteRoom(sole);
      return;
    }
    this._detach(conn, true);
  }

  /** Deletes a room at once (not logged: clients trigger it at will, and stderr must not become a flood target). */
  _deleteRoom(room) {
    this.rooms.delete(room.code);
    for (const c of room.conns.values()) { c.roomCode = null; c.playerId = null; }
    room.conns.clear();
  }

  _join(conn, msg) {
    if (!sanitizeName(msg.name)) { this._error(conn, fail('bad_request', 'err.nameRequired')); return; }
    if (this._lookupThrottled(conn)) { this._error(conn, fail('server_busy', 'err.lookupThrottled')); return; }
    const room = this.rooms.get(normalizeCode(msg.room));
    if (!room) { this._lookupFailed(conn); this._error(conn, fail('no_room', 'err.noRoomJoin')); return; }
    const old = this._soleLobby(conn);
    const res = room.game.join(msg.name, { spectator: msg.spectator === true, lang: conn.lang });
    if (!res.ok) { this._error(conn, res); return; }
    this._moveOut(conn, old !== room ? old : null);
    this._admit(room, conn, res.id);
  }

  // ---- §11 V2: failed room lookups per network (a token bucket; a network with no failures has no entry). §11 X5: an
  // IPv6 client also draws on its /48's bucket (SITE_FACTOR times the burst, the same refill); either one empty stops it.
  /** The bucket's budget refilled up to `t`; a full budget is dropped from the map (and returned as null). */
  _budget(key, t = this.now()) {
    const b = this.lookupBudget.get(key);
    if (!b) return null;
    b.tokens = Math.min(b.burst, b.tokens + Math.max(0, t - b.at) / this.joinFailRefillMs);
    b.at = t;
    if (b.tokens >= b.burst) { this.lookupBudget.delete(key); return null; }
    return b;
  }

  /** [bucket key, burst] pairs this socket's failed lookups count in: its network, and for IPv6 also its /48. */
  _lookupKeys(conn) {
    if (!Number.isFinite(this.joinFailBurst)) return [];
    return [[ipKey(conn.ip), this.joinFailBurst], [siteKey(conn.ip), this.joinFailSiteBurst]]
      .filter(([k, burst]) => k && Number.isFinite(burst));
  }

  _lookupThrottled(conn) {
    return this._lookupKeys(conn).some(([key]) => {
      const b = this._budget(key);
      return !!b && b.tokens < 1;
    });
  }

  _lookupFailed(conn) {
    for (const [key, burst] of this._lookupKeys(conn)) {
      const b = this._budget(key) || { tokens: burst, at: this.now(), burst };
      b.tokens -= 1;
      this.lookupBudget.set(key, b);
    }
  }

  _admit(room, conn, id) {
    const token = this._newToken();
    room.tokens.set(token, id);
    room.idToken.set(id, token);
    this._attach(room, conn, id);
    this._send(conn, { t: 'joined', room: room.code, id, token });
    this._broadcast(room);
  }

  _resume(conn, msg) {
    const room = this.rooms.get(normalizeCode(msg.room));
    const id = (room ? room.tokens : NO_TOKENS).get(msg.token); // the same work whether or not the room exists
    const valid = !!id && room.game.isActive(id);
    // §11 Z1: a throttled network still gets its own seats back. Only a valid room *and* token passes (a 144-bit token
    // cannot be guessed); anything else gets the same server_busy whether or not the room exists, and spends nothing.
    if (!valid && this._lookupThrottled(conn)) { this._error(conn, fail('server_busy', 'err.lookupThrottled')); return; }
    if (!room) { this._lookupFailed(conn); this._error(conn, fail('no_room', 'err.noRoomResume')); return; }
    if (!valid) { this._lookupFailed(conn); this._error(conn, fail('bad_token')); return; }
    // §11 X5.1: a resume with `lang` sets the member's language (conn.lang is set already); without it, the member keeps
    // theirs and the socket takes it over, so kicked.reason and errors match the member
    if (normLang(msg.lang)) room.game.setLang(id, msg.lang);
    else conn.lang = room.game.langOf(id) ?? conn.lang;
    if (conn.roomCode === room.code && conn.playerId === id && room.conns.get(id) === conn) {
      this._send(conn, { t: 'joined', room: room.code, id, token: msg.token });
      this._sendState(room, id, conn);
      return;
    }
    const sole = this._soleLobby(conn);
    this._moveOut(conn, sole !== room ? sole : null);
    const old = room.conns.get(id);
    if (old && old !== conn) {
      old.roomCode = null;
      old.playerId = null;
      room.conns.delete(id);
      this._send(old, { t: 'error', code: 'replaced', message: this._text(old, 'err.replacedTab') });
    }
    this._attach(room, conn, id);
    this._send(conn, { t: 'joined', room: room.code, id, token: msg.token });
    this._broadcast(room);
  }

  _attach(room, conn, id) {
    conn.roomCode = room.code;
    conn.playerId = id;
    room.conns.set(id, conn);
    room.emptySince = null;
    room.game.setConnected(id, true);
  }

  /** Detaches the socket's identity as a *disconnect* (the seat stays; resumable by token). */
  _detach(conn, broadcast) {
    const code = conn.roomCode;
    const id = conn.playerId;
    conn.roomCode = null;
    conn.playerId = null;
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room || room.conns.get(id) !== conn) return;
    room.conns.delete(id);
    room.game.setConnected(id, false);
    if (room.conns.size === 0) room.emptySince = this.now();
    if (broadcast) this._broadcast(room);
  }

  /** After a successful action: revoke identities that no longer exist (leave/kick/playAgain), then broadcast. */
  _afterChange(room, kickedId) {
    for (const [id, token] of [...room.idToken]) {
      if (room.game.isActive(id)) continue;
      room.idToken.delete(id);
      room.tokens.delete(token);
      const conn = room.conns.get(id);
      if (!conn) continue;
      room.conns.delete(id);
      conn.roomCode = null;
      conn.playerId = null;
      if (id === kickedId) this._send(conn, { t: 'kicked', reason: this._text(conn, 'kick.reason') });
    }
    // Nobody is left in it at all (in a game, `left` players stay listed but can never come back): free the code now
    // instead of holding one of the 200 room slots for the 30-minute idle TTL.
    if (!room.game.spectators.length && !room.game.players.some((p) => p.status !== 'left')) {
      this.rooms.delete(room.code);
      this._devAfterChange(room);
      return;
    }
    if (room.conns.size === 0 && room.emptySince === null) room.emptySince = this.now();
    this._broadcast(room);
    this._devAfterChange(room);
  }

  /** §11 X9: dev mode's bots leave a room no human is left in, and close when their room is gone. */
  _devAfterChange(room) {
    if (!this.dev) return;
    try { this.dev.afterChange(room); } catch (e) { this.logger('dev afterChange failed', e); }
  }

  _sendState(room, id, conn) {
    const view = room.game.view(id);
    if (!view) return;
    // §11 X9: the god view, only on the socket that asked for it, and only in dev mode
    if (this.dev && conn.devGod === true) view.god = this.dev.godView(room.game);
    // §11 X5.2: the log (the same for every recipient of one language) is serialized and encoded once per language and
    // spliced into each frame. A transport that takes chunks (index.js: one WebSocket message in two fragments) gets
    // the frame as UTF-8 with the log's bytes shared; one that takes text gets the JSON text.
    try {
      if (typeof conn.sendChunks === 'function') { conn.sendChunks(stateFrameChunks(view)); return; }
      if (typeof conn.sendText === 'function') { conn.sendText(stateFrame(view)); return; }
    } catch (e) {
      this.logger('send failed', e);
      return;
    }
    this._send(conn, stateMessage(view));
  }

  _broadcast(room) {
    for (const [id, conn] of room.conns) this._sendState(room, id, conn);
  }
}

/** A lobby with at most one member (seat or spectator). */
function isLoneLobby(room) {
  const g = room.game;
  return g.phase === 'lobby' && g.players.length + g.spectators.length <= 1;
}

export function normalizeCode(code) {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}
