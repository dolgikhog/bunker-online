// server/rooms.js — room registry, identities & tokens, per-recipient broadcast, host grace, cleanup (SPEC.md §6, §7, §9).
// Transport-agnostic: a "conn" is any object with send(obj). index.js wraps each WebSocket in one.

import crypto from 'node:crypto';
import { createGame, validateMessage, sanitizeName, fail } from './game.js';
import { deriveRng } from './rng.js';

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
const LOOKUP_THROTTLED = 'Too many wrong room codes from your network. Wait a minute, then try again';
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
  }

  // ------------------------------------------------------------------------------------------------ transport hooks
  open(conn) {
    conn.roomCode = null;
    conn.playerId = null;
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
      this._error(conn, fail('bad_request', 'Something went wrong'));
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

  _error(conn, res) {
    this._send(conn, { t: 'error', code: res.code, message: res.message });
  }

  _message(conn, text) {
    if (typeof text !== 'string') { this._error(conn, fail('bad_request', 'Expected a JSON text frame')); return; }
    let msg;
    try { msg = JSON.parse(text); } catch { this._error(conn, fail('bad_request', 'Malformed JSON')); return; }
    const bad = validateMessage(msg);
    if (bad) { this._error(conn, bad); return; }
    switch (msg.t) {
      case 'ping': this._send(conn, { t: 'pong' }); return;
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
    if (!sanitizeName(msg.name)) { this._error(conn, fail('bad_request', 'Please enter a name (1–20 characters)')); return; }
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
        this._error(conn, fail('server_busy', 'Too many rooms are open from your network. Leave one of them, or try again later'));
        return;
      }
    }
    const code = this._newCode();
    if (!code) { this._error(conn, fail('server_busy')); return; }
    const rng = this.rng ? deriveRng(this.rng) : Math.random;
    const game = createGame({
      room: code, rng, now: this.now, minPlayers: this.minPlayers, fixedSpecials: this.fixedSpecials,
      ...(this.dealerFactory ? { dealer: this.dealerFactory(rng) } : {}),
    });
    const res = game.join(msg.name);
    if (!res.ok) { this._error(conn, res); return; }
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
    if (!sanitizeName(msg.name)) { this._error(conn, fail('bad_request', 'Please enter a name (1–20 characters)')); return; }
    if (this._lookupThrottled(conn)) { this._error(conn, fail('server_busy', LOOKUP_THROTTLED)); return; }
    const room = this.rooms.get(normalizeCode(msg.room));
    if (!room) { this._lookupFailed(conn); this._error(conn, fail('no_room', 'There is no room with that code')); return; }
    const old = this._soleLobby(conn);
    const res = room.game.join(msg.name, { spectator: msg.spectator === true });
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
    if (!valid && this._lookupThrottled(conn)) { this._error(conn, fail('server_busy', LOOKUP_THROTTLED)); return; }
    if (!room) { this._lookupFailed(conn); this._error(conn, fail('no_room', 'That room no longer exists')); return; }
    if (!valid) { this._lookupFailed(conn); this._error(conn, fail('bad_token')); return; }
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
      this._send(old, { t: 'error', code: 'replaced', message: 'This seat was opened in another tab or window' });
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
      if (id === kickedId) this._send(conn, { t: 'kicked', reason: 'The host removed you from the room' });
    }
    // Nobody is left in it at all (in a game, `left` players stay listed but can never come back): free the code now
    // instead of holding one of the 200 room slots for the 30-minute idle TTL.
    if (!room.game.spectators.length && !room.game.players.some((p) => p.status !== 'left')) {
      this.rooms.delete(room.code);
      return;
    }
    if (room.conns.size === 0 && room.emptySince === null) room.emptySince = this.now();
    this._broadcast(room);
  }

  _sendState(room, id, conn) {
    const view = room.game.view(id);
    if (view) this._send(conn, { t: 'state', ...view });
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
