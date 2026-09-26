// server/dev.js — SPEC §11 X9 dev mode: the test shortcuts behind BUNKER_DEV=1.
//
// Loaded only in dev mode: server/index.js imports this module dynamically when BUNKER_DEV=1, and rooms.js reaches it
// only through `rooms.dev`, which is null otherwise. So in production neither this code nor tools/botlib.js is even
// loaded: rooms.js answers every {t:'dev'} with not_allowed, `create` ignores `seed`, no StateView carries `god`, and
// index.js answers /dev, /devinfo and the dev files with its plain 404.
//
// What dev mode adds:
//   - `create` takes an optional `seed` (1–64 characters, or a safe integer): that room's rng is seeded with it, so the
//     same seed and the same seats deal the same game (catastrophe, bunker, cards, specials, Airlock/revive holders),
//     and a "[dev] Deals in this room follow the seed …" line is logged;
//   - {t:'dev', op, ...}, from any member of the room (a player or a spectator), each logged as "[dev] …" (kind info):
//       giveSpecial {playerId, effect}  in reveal/discussion/vote/defense: the player gets a card of that effect in place
//                                       of one unused special (one of that effect if they hold one, else one dev mode did
//                                       not give, else the oldest dev card) and is topped up to 2 unused cards with
//                                       freshly drawn ones. Used cards stay (they are in playedSpecials), so a hand can
//                                       grow past 2 cards (at most 7 played + 2); `eject` (retired, §11 X1) is refused
//       autoReveal                      reveal phase: every remaining speaker reveals as the host's Next would, and the
//                                       discussion starts
//       skipToVote                      reveal, discussion or defense: plays on, as the host's Next would with nobody
//                                       acting, until a ballot is open (or the game is over): the rest of the reveals, the
//                                       discussions of rounds without kicks, and the remaining defense speeches. Open
//                                       airlocks jam as usual; a vote step skipped by Cancel vote does not count. A running
//                                       game always has a vote ahead (round 7 and overtime vote until alive ≤ capacity),
//                                       so it never ends the game by itself; it stops in the final only when the vote it
//                                       reached closed at once (no voters) and that ejection ended the game
//       forceTie {ids}                  an open main ballot: the votes are rewritten so that exactly those candidates (2 or
//                                       more, not immune) tie for most votes (×2 votes counted, nobody votes for
//                                       themself, the rest abstain), then the ballot closes into the defense
//       god {on}                        the requesting socket's StateViews gain (or lose) `god: {players: {[id]: {cards,
//                                       specials}}}`: every seated player's cards and specials; nobody else's views change
//       fastTimers                      every timer option becomes 5 s, in any phase; a running timer is cut to 5 s
//       addBots {count, specials?}      1–15 in-process bots (tools/botlib.js over a loopback socket, no network) join:
//                                       seated in the lobby (as many as there are free seats), spectators in a game.
//                                       `specials` (0..1, default 0) is their chance per round to play a special card
//   - bots leave when no human member is left, and when no human has been connected for `botIdleMs` (3 min).
//
// Error codes in §7's order: bad_request (unknown op, a missing or mistyped field, a count outside 1..15, an effect that
// is not a §5/X1 effect, ids not 2..16 strings, a bad seed), not_in_room, room_full (addBots with no seat or spectator
// place left), wrong_phase, not_allowed (a player who is not seated or has left, a tie that cannot be made, …).
//
// Log lines and errors go through the message catalogue (§11 X5.3/X5.4): `log.dev.*` and `err.dev.*` keys in
// server/i18n/{en,ru}.js with language-neutral params, so every member reads them in their own language and rooms.js
// sends an error in the socket's language. DEV_TEXT keeps the English wording in one place; test/i18n-golden-engine
// pins it to the catalogue's English, so both stay identical.

import { EventEmitter } from 'node:events';
import { AIRLOCK_CARD, REVIVE_CARD, createDealer } from './content.js';
import { CATEGORY_IDS, EFFECTS, MAX_PLAYERS, MAX_SPECTATORS, fail, normalizeSpecial } from './game.js';
import { mulberry32, seedFromString } from './rng.js';
import { BOT_NAMES, Bot, Coordinator } from '../tools/botlib.js';

export const DEV_OPS = Object.freeze(['giveSpecial', 'autoReveal', 'skipToVote', 'forceTie', 'god', 'fastTimers', 'addBots']);
export const DEV_TIMER_SECONDS = 5;
export const MAX_BOTS_PER_OP = 15;
export const SEED_MAX = 64;
/** A room's bots leave once no human member has been connected for this long (a closed or reloaded test table). */
export const BOT_IDLE_MS = 3 * 60 * 1000;
/** Base delay of an in-process bot's action (ms); End turn waits twice as long, a bot host's Next in discussion 20×. */
export const BOT_DELAY_MS = 500;
/** The address in-process bots count as (rooms.js uses it only for per-network limits, which bots never reach). */
export const BOT_IP = 'dev-bot';

/**
 * Every user-facing string of dev mode in English, as the catalogue renders it (the golden test pins the two together).
 * The ops log and fail by key; only the fallback card is used from here. The /dev page itself is English-only.
 */
export const DEV_TEXT = Object.freeze({
  errors: Object.freeze({
    badMessage: 'Expected a JSON object',
    badOp: `Unknown dev op: use one of ${DEV_OPS.join(', ')}`,
    missing: (key) => `Missing field "${key}"`,
    invalid: (key) => `Invalid field "${key}"`,
    badSeed: `A seed is 1–${SEED_MAX} characters or a whole number`,
    ejectRetired: 'The one-player eject card is retired (§11 X1): give an Airlock instead',
    noPlayer: 'There is no such seated player',
    playerLeft: (name) => `${name} has left the game`,
    noGame: 'There is no game running',
    gameOver: 'The game is over',
    notReveal: 'Auto-reveal works only during a reveal phase',
    ballotOpen: 'A ballot is already open',
    noBallot: 'A tie can only be forced while a ballot is open',
    revote: 'Only a main ballot can be forced into a tie',
    duplicate: 'List each player once',
    notAlive: (name) => `${name} is not in the game any more`,
    immune: (name) => `${name} is immune in this vote, so they cannot be in the tie`,
    impossible: 'The voters of this ballot cannot make that tie (too few votes, or the double votes do not add up)',
    tableFull: 'Every seat is taken',
    spectatorsFull: 'The room has no room left for spectators',
    internal: 'Internal error',
  }),
  log: Object.freeze({
    seed: (seed) => `[dev] Deals in this room follow the seed “${seed}”`,
    giveSpecial: (by, target, title) => `[dev] ${by} gave ${target} the special “${title}”`,
    autoReveal: (by, rp) => `[dev] ${by} auto-revealed the rest of the reveal phase (${rp})`,
    skipToVote: (by) => `[dev] ${by} skipped ahead to the next vote`,
    forceTie: (by, names) => `[dev] ${by} forced a tie between ${names}`,
    god: (by, on) => `[dev] ${by} turned the god view ${on ? 'on' : 'off'} (on their own screen only)`,
    fastTimers: (by, secs) => `[dev] ${by} set every timer to ${secs} s`,
    addBots: (by, n, seated) => `[dev] ${by} added ${n} bot${n === 1 ? '' : 's'} (${seated ? 'they take seats' : 'they watch: seats are taken only in the lobby'})`,
  }),
  /** Only when the content has no card of that effect at all. */
  fallbackCard: (effect) => ({ title: `Test card (${effect})`, text: `A card given in dev mode, with the ${effect} effect.` }),
});

const T = DEV_TEXT;
const IN_GAME = new Set(['reveal', 'discussion', 'vote', 'defense']);
/** Effects giveSpecial accepts in its schema: every §5/X1 effect (the retired `eject` passes the schema, then is refused). */
const GIVE_EFFECTS = Object.freeze(Object.keys(EFFECTS));
const ok = () => ({ ok: true });

// ---------------------------------------------------------------------------------------------------------------
// Validation (bad_request)

const FIELD_CHECKS = {
  id: (v) => typeof v === 'string' && v.length > 0 && v.length <= 100,
  effect: (v) => typeof v === 'string' && GIVE_EFFECTS.includes(v),
  ids: (v) => Array.isArray(v) && v.length >= 2 && v.length <= MAX_PLAYERS && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 100),
  boolean: (v) => typeof v === 'boolean',
  count: (v) => Number.isInteger(v) && v >= 1 && v <= MAX_BOTS_PER_OP,
  chance: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
};
const OP_FIELDS = {
  giveSpecial: { playerId: 'id', effect: 'effect' },
  autoReveal: {},
  skipToVote: {},
  forceTie: { ids: 'ids' },
  god: { on: 'boolean' },
  fastTimers: {},
  addBots: { count: 'count', specials: 'chance?' },
};

/** null when `msg` is a well-formed dev op, otherwise its bad_request. Unknown extra keys are ignored (§7). */
export function validateDevMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.t !== 'dev') return fail('bad_request', 'err.expectedObject');
  if (typeof msg.op !== 'string' || !Object.hasOwn(OP_FIELDS, msg.op)) return fail('bad_request', 'err.dev.badOp');
  for (const [key, spec] of Object.entries(OP_FIELDS[msg.op])) {
    const optional = spec.endsWith('?');
    const check = FIELD_CHECKS[optional ? spec.slice(0, -1) : spec];
    const v = Object.hasOwn(msg, key) ? msg[key] : undefined;
    if (v === undefined || (optional && v === null)) {
      if (optional) continue;
      return fail('bad_request', 'err.missingField', { field: key });
    }
    if (!check(v)) return fail('bad_request', 'err.invalidField', { field: key });
  }
  return null;
}

/**
 * `create`'s seed in dev mode: {ok, seed} with seed a string or null (absent, null or blank: no seed), or {ok: false,
 * fail} for anything else (bad_request).
 */
export function parseSeed(v) {
  if (v === undefined || v === null) return { ok: true, seed: null };
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return { ok: true, seed: null };
    if (s.length <= SEED_MAX) return { ok: true, seed: s };
  } else if (Number.isSafeInteger(v)) return { ok: true, seed: String(v) };
  return { ok: false, fail: fail('bad_request', 'err.dev.badSeed') };
}

/** The rng of a room created with `seed` (the same function BUNKER_SEED uses, so "42" and 42 deal alike). */
export function seededRng(seed) {
  return mulberry32(seedFromString(seed));
}

// ---------------------------------------------------------------------------------------------------------------
// Engine ops: pure functions over a Game (they drive its own methods, exactly as the host's Next and the ballot do)

/** Every card of `effect` in the content, deck order (the fixed Airlock and revive for theirs). */
const cardCache = new Map();
function contentCards(effect) {
  if (cardCache.has(effect)) return cardCache.get(effect);
  let cards = [];
  if (effect === 'airlock') cards = [AIRLOCK_CARD];
  else if (effect === 'revive') cards = [REVIVE_CARD];
  else {
    // The dealer interface is the content's contract (§8): it deals every special once before any repeats (C2), so two
    // rounds of draws see the whole pool whatever the content's internals look like.
    const seen = new Map();
    try {
      const dealer = createDealer(mulberry32(0x5eed));
      for (let i = 0; i < 400; i++) {
        const c = dealer.drawSpecial();
        if (c && typeof c.id === 'string' && !seen.has(c.id)) seen.set(c.id, c);
      }
    } catch { /* fall back below */ }
    cards = [...seen.values()].filter((c) => c.effect === effect);
  }
  if (!cards.length) cards = [{ id: `dev-${effect}`, effect, target: EFFECTS[effect].targets[0], ...T.fallbackCard(effect) }];
  cardCache.set(effect, cards);
  return cards;
}

/** Runs the reveal phase's remaining turns the way the host's Next does (§6), which starts the discussion. */
function finishReveal(game) {
  const round = game.round;
  for (let guard = 0; game.phase === 'reveal' && game.round === round && guard < 64; guard++) {
    const sp = game._player(game._speakerId());
    if (sp && !game.turn.hasRevealed) {
      const eligible = game._eligible(sp);
      if (eligible.length) game._doReveal(sp, game._mustReveal() || game._pick(eligible), true);
    }
    game._advanceReveal();
  }
}

/**
 * Votes that make exactly `tied` (≥ 2 candidates, seat order) tie for most votes: a Map voter -> target, or null. Each
 * tied player gets W votes (a ×2 voter counts 2), everyone else none; nobody votes for themself; unused voters abstain.
 * The largest W that works is taken, so as many voters as possible vote. Small exact search with memo and a node budget.
 */
export function planTie(voters, weightOf, tied) {
  const vs = [...voters].sort((a, b) => weightOf(b) - weightOf(a));
  const k = tied.length;
  const rest = new Array(vs.length + 1).fill(0);
  for (let i = vs.length - 1; i >= 0; i--) rest[i] = rest[i + 1] + weightOf(vs[i]);
  const singles = vs.filter((v) => weightOf(v) === 1).length;
  for (let W = Math.floor(rest[0] / k); W >= 1; W--) {
    if (W % 2 === 1 && singles === 0) continue; // only ×2 voters cannot give anyone an odd count
    const need = tied.map(() => W);
    const assign = new Map();
    const failed = new Set();
    let budget = 200000;
    const dfs = (i, remaining) => {
      if (remaining === 0) return true;
      if (--budget < 0 || i >= vs.length || rest[i] < remaining) return false;
      const key = `${i}|${need.join(',')}`;
      if (failed.has(key)) return false;
      const v = vs[i];
      const w = weightOf(v);
      for (let j = 0; j < k; j++) {
        if (tied[j] === v || need[j] < w) continue;
        need[j] -= w;
        assign.set(v, tied[j]);
        if (dfs(i + 1, remaining - w)) return true;
        need[j] += w;
        assign.delete(v);
      }
      if (dfs(i + 1, remaining)) return true; // v abstains
      failed.add(key);
      return false;
    };
    if (dfs(0, W * k)) return assign;
  }
  return null;
}

/**
 * The engine side of the dev ops (everything but god and addBots, which belong to a socket and to the room registry).
 * One instance per server: it remembers which cards dev mode gave (giveSpecial's slot choice) and cycles through the
 * content's cards of an effect.
 */
export function createDevOps() {
  const given = new WeakMap(); // special object -> sequence number
  let givenSeq = 0;
  const rotation = new Map(); // effect -> how many cards of it were given


  const ops = {
    giveSpecial(game, by, { playerId, effect }) {
      if (game.phase === 'lobby') return fail('wrong_phase', 'err.dev.noGame');
      if (!IN_GAME.has(game.phase)) return fail('wrong_phase', 'err.dev.gameOver');
      if (effect === 'eject') return fail('not_allowed', 'err.dev.ejectRetired');
      const p = game._player(playerId);
      if (!p || !p.cards) return fail('not_allowed', 'err.dev.noPlayer');
      if (p.status === 'left') return fail('not_allowed', 'err.dev.playerLeft', { p: game._pref(p) });
      const cards = contentCards(effect);
      const n = rotation.get(effect) || 0;
      rotation.set(effect, n + 1);
      const card = game._issueSpecial(normalizeSpecial(cards[n % cards.length]));
      const unused = p.specials.filter((s) => !s.used);
      const slot = unused.find((s) => s.effect === effect)
        ?? unused.find((s) => !given.has(s))
        ?? [...unused].sort((a, b) => given.get(a) - given.get(b))[0];
      if (slot) p.specials[p.specials.indexOf(slot)] = card;
      else p.specials.push(card);
      given.set(card, ++givenSeq);
      for (let guard = 0; p.specials.filter((s) => !s.used).length < 2 && guard < 2; guard++) p.specials.push(game._drawSpecial());
      game._log('info', 'log.dev.giveSpecial', { a: game._ref(by), t: game._pref(p), card: game._spParam(card) });
      return ok();
    },

    autoReveal(game, by) {
      if (game.phase !== 'reveal') return fail('wrong_phase', 'err.dev.notReveal');
      game._log('info', 'log.dev.autoReveal', { a: game._ref(by), rp: game._rpRef() });
      finishReveal(game);
      return ok();
    },

    skipToVote(game, by) {
      if (game.phase === 'lobby') return fail('wrong_phase', 'err.dev.noGame');
      if (game.phase === 'final') return fail('wrong_phase', 'err.dev.gameOver');
      if (game.phase === 'vote') return fail('wrong_phase', 'err.dev.ballotOpen');
      game._log('info', 'log.dev.skipToVote', { a: game._ref(by) });
      // Every running game has a vote ahead, so the guard never trips; it only keeps a future rule from looping forever.
      for (let guard = 0; guard < 500 && game.phase !== 'vote' && game.phase !== 'final'; guard++) {
        if (game.phase === 'reveal') finishReveal(game);
        else if (game.phase === 'discussion') game._afterDiscussion();
        else if (game.phase === 'defense') game._advanceDefense();
        else break;
      }
      return ok();
    },

    forceTie(game, by, { ids }) {
      const v = game.vote;
      if (game.phase !== 'vote' || !v || !game.step) return fail('wrong_phase', 'err.dev.noBallot');
      if (v.stage !== 'main') return fail('not_allowed', 'err.dev.revote');
      if (new Set(ids).size !== ids.length) return fail('not_allowed', 'err.dev.duplicate');
      for (const id of ids) {
        const p = game._player(id);
        if (!p) return fail('not_allowed', 'err.dev.noPlayer');
        if (p.status !== 'alive') return fail('not_allowed', 'err.dev.notAlive', { p: game._pref(p) });
        if (!v.candidates.includes(id)) return fail('not_allowed', 'err.dev.immune', { p: game._pref(p) });
      }
      const tied = game._bySeat(ids);
      const plan = planTie(v.voters, (x) => (game.voteMods.doubleVote.has(x) ? 2 : 1), tied);
      if (!plan) return fail('not_allowed', 'err.dev.impossible');
      game._log('info', 'log.dev.forceTie', { a: game._ref(by), ids: game._refs(tied) });
      v.votes = plan;
      game._closeBallot();
      return ok();
    },

    fastTimers(game, by) {
      for (const k of Object.keys(game.options)) game.options[k] = DEV_TIMER_SECONDS;
      if (game.timer) game.timer.endsAt = Math.min(game.timer.endsAt, game._time() + DEV_TIMER_SECONDS * 1000);
      game._log('info', 'log.dev.fastTimers', { a: game._ref(by), secs: DEV_TIMER_SECONDS });
      return ok();
    },
  };

  return {
    /** Runs one engine op for member `by` (already validated with validateDevMessage). Never throws. */
    run(game, by, msg) {
      const op = Object.hasOwn(ops, msg.op) ? ops[msg.op] : null;
      if (!op) return fail('bad_request', 'err.dev.badOp');
      try {
        return op(game, by, msg);
      } catch (e) {
        game.lastError = e;
        return { ...fail('not_allowed', 'err.internal'), internal: true };
      }
    },
    /** true when dev mode gave this special object (tests). */
    wasGiven: (card) => given.has(card),
  };
}

/** §11 X9 god view: every seated player's cards and specials, whatever their state (for one socket only). */
export function godView(game) {
  const players = {};
  for (const p of game.players) {
    if (!p.cards) continue;
    const cards = {};
    for (const c of CATEGORY_IDS) cards[c] = p.cards[c].text;
    players[p.id] = { cards, specials: p.specials.map((s) => ({ title: s.title, text: s.text, effect: s.effect, used: !!s.used })) };
  }
  return { players };
}

// ---------------------------------------------------------------------------------------------------------------
// In-process bots: a WebSocket-shaped loopback that talks to the room registry directly

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * What botlib's Bot needs of a `ws` socket, wired to Rooms instead of the network: open() on the next tick, text frames
 * handed to rooms.message() and the conn's objects handed back as JSON text, both on later ticks and in order (as over
 * a socket: nothing re-enters the registry while it is broadcasting). close() lets the frames already sent through,
 * terminate() does not; either one detaches the identity like a socket's close event.
 */
export class LoopbackSocket extends EventEmitter {
  constructor(rooms, ip = BOT_IP) {
    super();
    this.rooms = rooms;
    this.readyState = CONNECTING;
    this.conn = { ip, devBot: true, send: (obj) => this._deliver(obj) };
    setImmediate(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      rooms.open(this.conn);
      this.emit('open');
    });
  }

  send(text) {
    if (this.readyState !== OPEN) return;
    const frame = String(text);
    setImmediate(() => {
      if (this.readyState === OPEN || this.readyState === CLOSING) this.rooms.message(this.conn, frame);
    });
  }

  _deliver(obj) {
    if (this.readyState !== OPEN) return;
    const data = JSON.stringify(obj);
    setImmediate(() => { if (this.readyState === OPEN) this.emit('message', data, false); });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    if (this.readyState === CONNECTING) { this._shut(code, reason); return; }
    this.readyState = CLOSING;
    setImmediate(() => this._shut(code, reason)); // after the frames sent before it
  }

  terminate() { this._shut(1006, ''); }

  _shut(code, reason) {
    if (this.readyState === CLOSED) return;
    const attached = this.readyState === OPEN || this.readyState === CLOSING;
    this.readyState = CLOSED;
    if (attached) {
      try { this.rooms.close(this.conn); } catch { /* the registry logs its own failures */ }
    }
    setImmediate(() => this.emit('close', code, Buffer.from(String(reason))));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The protocol side, one per server

export class DevTools {
  /**
   * @param {import('./rooms.js').Rooms} rooms
   * @param {object} [o]
   * @param {(msg: string, err?: unknown) => void} [o.logger]
   * @param {number} [o.botIdleMs]   bots leave once no human has been connected this long
   * @param {number} [o.botDelay]    base delay of a bot's action (ms)
   * @param {() => number} [o.now]
   */
  constructor(rooms, { logger = null, botIdleMs = BOT_IDLE_MS, botDelay = BOT_DELAY_MS, now = Date.now } = {}) {
    this.rooms = rooms;
    this.logger = logger || rooms.logger || (() => {});
    this.botIdleMs = Math.max(0, botIdleMs ?? BOT_IDLE_MS);
    this.botDelay = Math.max(0, botDelay ?? BOT_DELAY_MS);
    this.now = now;
    this.ops = createDevOps();
    /** @type {Map<string, {coordinator: Coordinator, bots: Set<Bot>, pending: number, pendingNames: string[], humanAt: number}>} */
    this.tables = new Map();
    this.botSerial = 0;
    this.closed = false;
  }

  parseSeed(v) { return parseSeed(v); }
  roomRng(seed) { return seededRng(seed); }
  logSeed(game, seed) { game._log('info', 'log.dev.seed', { seed: String(seed) }); }
  godView(game) { return godView(game); }

  /** Handles one {t:'dev'} frame of `conn` (rooms.js calls it only in dev mode). Replies like any action. */
  handle(conn, msg) {
    const bad = validateDevMessage(msg);
    if (bad) { this.rooms._error(conn, bad); return; }
    const room = conn.roomCode ? this.rooms.rooms.get(conn.roomCode) : null;
    const id = conn.playerId;
    if (!room || !id || room.conns.get(id) !== conn || !room.game.isActive(id)) { this.rooms._error(conn, fail('not_in_room')); return; }
    let res;
    try {
      if (msg.op === 'god') res = this._god(room, conn, msg.on);
      else if (msg.op === 'addBots') res = this._addBots(room, id, msg);
      else res = this.ops.run(room.game, id, msg);
    } catch (e) {
      this.logger(`dev op ${msg.op} failed`, e);
      res = fail('not_allowed', 'err.internal');
    }
    if (!res.ok) {
      if (res.internal) this.logger(`dev op ${msg.op} failed`, room.game.lastError);
      this.rooms._error(conn, res);
      return;
    }
    this.logger(`[dev] room ${room.code}: ${id} ${describeOp(msg)}`);
    this.rooms._afterChange(room, null);
  }

  _god(room, conn, on) {
    conn.devGod = on === true;
    room.game._log('info', 'log.dev.god', { a: room.game._ref(conn.playerId), on: conn.devGod });
    return ok();
  }

  // ---- bots ------------------------------------------------------------------------------------------------

  _table(code) {
    let t = this.tables.get(code);
    if (!t) {
      t = { coordinator: new Coordinator(), bots: new Set(), pending: 0, pendingNames: [], humanAt: this.now() };
      this.tables.set(code, t);
    }
    return t;
  }

  _addBots(room, by, msg) {
    const g = room.game;
    const t = this._table(room.code);
    const lobby = g.phase === 'lobby';
    const free = lobby ? MAX_PLAYERS - g.players.length - t.pending : MAX_SPECTATORS - g.spectators.length - t.pending;
    if (free <= 0) {
      if (!t.bots.size && !t.pending) this.tables.delete(room.code);
      return fail('room_full', lobby ? 'err.dev.tableFull' : 'err.dev.spectatorsFull');
    }
    const n = Math.min(msg.count, free);
    g._log('info', 'log.dev.addBots', { a: g._ref(by), n, seated: lobby });
    const specials = typeof msg.specials === 'number' ? msg.specials : 0;
    for (let i = 0; i < n; i++) this._spawnBot(room.code, t, specials);
    return ok();
  }

  _botName(code, t) {
    const room = this.rooms.rooms.get(code);
    const taken = new Set([...(room ? [...room.game.players, ...room.game.spectators].map((x) => x.name) : []), ...t.pendingNames]);
    return BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${this.botSerial + 1}`;
  }

  _spawnBot(code, t, specials) {
    const name = this._botName(code, t);
    const serial = ++this.botSerial;
    const bot = new Bot({
      url: 'http://in-process.invalid', name, seed: `dev:${code}:${serial}`,
      transport: () => new LoopbackSocket(this.rooms),
      delay: this.botDelay, speechDelay: 2 * this.botDelay, specials, coordinator: t.coordinator,
      // A bot that becomes the host (the humans' host left) keeps the game moving, without rushing the humans
      host: { discussionDelay: 20 * this.botDelay },
    });
    t.bots.add(bot);
    t.pending++;
    t.pendingNames.push(name);
    bot.on('kicked', () => this._retire(code, bot));
    bot.on('server-error', (e) => {
      if (e.code === 'not_in_room' && !this.rooms.rooms.has(code)) this._retire(code, bot);
      else if (!e.race && !e.expected && !(e.key && String(e.key).startsWith('request:'))) this.logger(`[dev] bot ${bot.name} in ${code}: ${e.code} ${e.message}`);
    });
    bot.join(code).catch((e) => {
      if (!this.closed) this.logger(`[dev] bot ${name} could not join ${code}: ${e.message}`);
      this._retire(code, bot);
    }).finally(() => {
      t.pending = Math.max(0, t.pending - 1);
      const i = t.pendingNames.indexOf(name);
      if (i >= 0) t.pendingNames.splice(i, 1);
      if (this.closed) this._retire(code, bot);
      else this._check(code);
    });
  }

  _retire(code, bot) {
    try { bot.close(); } catch { /* ignore */ }
    const t = this.tables.get(code);
    if (!t) return;
    t.bots.delete(bot);
    if (!t.bots.size && !t.pending) this.tables.delete(code);
  }

  /** Makes every bot of the room leave (then close); the room goes as soon as nobody is left in it (rooms.js). */
  _leaveAll(code) {
    const t = this.tables.get(code);
    if (!t) return;
    for (const bot of [...t.bots]) {
      try { if (bot.connected && bot.id && !bot.left && !bot.kicked) bot.leave(); } catch { /* ignore */ }
      this._retire(code, bot);
    }
  }

  _botIds(t) { return new Set([...t.bots].map((b) => b.id).filter(Boolean)); }

  /** A human member is still in the room: a seated player who has not left, or a spectator, who is not one of its bots. */
  _hasHuman(room, t) {
    const bots = this._botIds(t);
    const g = room.game;
    return g.players.some((p) => p.status !== 'left' && !bots.has(p.id)) || g.spectators.some((s) => !bots.has(s.id));
  }

  /** After every change in a room (rooms.js _afterChange): bots of a deleted room close, bots alone in a room leave. */
  afterChange(room) { this._check(room.code, room); }

  _check(code, room = this.rooms.rooms.get(code)) {
    const t = this.tables.get(code);
    if (!t || t.pending) return;
    if (!room || this.rooms.rooms.get(code) !== room) { for (const b of [...t.bots]) this._retire(code, b); return; }
    if (!this._hasHuman(room, t)) this._leaveAll(code);
  }

  /** Periodic (rooms.sweep): bots leave a room where no human has been connected for botIdleMs. */
  sweep() {
    const now = this.now();
    for (const [code, t] of [...this.tables]) {
      const room = this.rooms.rooms.get(code);
      if (!room) { this._check(code); continue; }
      const bots = this._botIds(t);
      const humanOnline = [...room.conns.keys()].some((id) => !bots.has(id));
      if (humanOnline || t.pending) { t.humanAt = now; continue; }
      if (now - t.humanAt >= this.botIdleMs) this._leaveAll(code);
      else this._check(code, room);
    }
  }

  /** Server shutdown: every bot closes (no leave). */
  close() {
    this.closed = true;
    for (const [code, t] of [...this.tables]) for (const b of [...t.bots]) this._retire(code, b);
    this.tables.clear();
  }

  /** Bots per room code, for tests and diagnostics. */
  botsIn(code) {
    const t = this.tables.get(code);
    return t ? [...t.bots] : [];
  }
}

function describeOp(msg) {
  switch (msg.op) {
    case 'giveSpecial': return `giveSpecial ${msg.effect} -> ${msg.playerId}`;
    case 'forceTie': return `forceTie ${msg.ids.join(',')}`;
    case 'god': return `god ${msg.on ? 'on' : 'off'}`;
    case 'addBots': return `addBots ${msg.count}${typeof msg.specials === 'number' ? ` specials=${msg.specials}` : ''}`;
    default: return msg.op;
  }
}
