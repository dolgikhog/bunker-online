// Bunker Online: reusable bot client (Node, ESM) over the SPEC.md §7 WebSocket protocol.
//
// Used by tools/bots.js (the CLI), test/sim*.test.js (protocol simulations) and tools/e2e.js (browser run).
//
//   import { Bot } from './botlib.js';
//   const bot = new Bot({ url: 'http://127.0.0.1:8080', name: 'Bot Anna', seed: 1, delay: 0, specials: 0.3 });
//   await bot.create();                    // or bot.join('ABCD'), bot.join('ABCD', { spectator: true }), bot.resume()
//   await bot.waitFor((s) => s.phase === 'final', 60000);
//   bot.close();
//
// Policy (autoplay, on by default):
//   - my reveal turn: reveal (profession in round 1, otherwise a random hidden card), then End turn;
//     nothing eligible -> End turn at once;
//   - my defense turn: End turn;
//   - vote: a random candidate that is not me (candidates already exclude immune players);
//   - specials: with probability `specials` per round the bot plans to play one special in a random phase
//     (reveal / discussion / vote-or-defense) and then plays a random *playable* special (SPEC §5) with a random
//     valid target and category;
//   - airlocks and revives (SPEC §11 X1; only for a bot that plays specials at all): an Airlock holder joins an airlock
//     someone else opened with probability `airlockJoin` (once per round and airlock), opens one on a random player
//     with probability `airlockOpen` per round, and a revive holder brings back a player thrown out through the airlock
//     with probability `reviveVictims` per round;
//   - as host (whenever state.you.isHost): Next in discussion, Next for an offline speaker, Close vote when only
//     offline voters are missing, optional auto-Start / Play again / hand the host over to the first human, and
//     optionally (host.endGame, SPEC §11 X6) End game at a random moment of a running game: back to the lobby.
//
// Every action is followed by a {t:'ping'}. The server answers messages in order, and a successful action has no reply
// of its own, so an `error` that arrives before the action's `pong` belongs to that action. An error is marked
// `race: true` when some `state` arrived between sending the action and the error (the bot decided on a state that was
// already outdated when the server processed the action). `race: false` means the server rejected an action the bot
// believed legal on the very state the server had: that is a bug in the bot or in the server.
//
// Determinism: all game choices come from a seeded RNG (`seed`), consumed only when an action is actually sent.
//
// Importing this module has no side effects (no sockets, timers, listeners or output until a Bot is used), so the dev
// server (SPEC §11 X9, server/dev.js) imports it to run in-process bots through a loopback `transport`.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export const CATEGORY_IDS = ['profession', 'biology', 'health', 'hobby', 'phobia', 'skill', 'trait', 'baggage'];
export const ACTIVE_PHASES = ['reveal', 'discussion', 'vote', 'defense'];
export const MAX_ROUNDS = 7;
export const ERROR_CODES = ['bad_request', 'not_in_room', 'no_room', 'bad_token', 'server_busy', 'room_full', 'not_host',
  'wrong_phase', 'not_your_turn', 'not_allowed', 'replaced'];

/** SPEC §2: KICKS[N][r-1] = ejections scheduled at the end of round r. */
export const KICKS = {
  2: [0, 0, 0, 0, 0, 0, 1],
  3: [0, 0, 0, 0, 0, 1, 1],
  4: [0, 0, 0, 0, 0, 1, 1],
  5: [0, 0, 0, 0, 1, 1, 1],
  6: [0, 0, 0, 0, 1, 1, 1],
  7: [0, 0, 0, 1, 1, 1, 1],
  8: [0, 0, 0, 1, 1, 1, 1],
  9: [0, 0, 1, 1, 1, 1, 1],
  10: [0, 0, 1, 1, 1, 1, 1],
  11: [0, 1, 1, 1, 1, 1, 1],
  12: [0, 1, 1, 1, 1, 1, 1],
  13: [0, 1, 1, 1, 1, 1, 2],
  14: [0, 1, 1, 1, 1, 1, 2],
  15: [0, 1, 1, 1, 1, 2, 2],
  16: [0, 1, 1, 1, 1, 2, 2],
};

/** SPEC §5: legal combinations. `category`: 'any' = a Category or 'choose'; 'hidden' = 'choose' or 'random'. */
export const EFFECT_RULES = {
  swap_card: { targets: ['other'], category: 'any', timing: 'anytime' },
  reroll_card: { targets: ['self', 'other'], category: 'any', timing: 'anytime' },
  force_reveal: { targets: ['other'], category: 'hidden', timing: 'anytime', needsHidden: true },
  peek: { targets: ['other'], category: 'hidden', timing: 'anytime', needsHidden: true },
  mass_reveal: { targets: ['none'], category: 'any', timing: 'anytime' },
  shuffle_category: { targets: ['none'], category: 'any', timing: 'anytime' },
  immunity: { targets: ['self'], category: null, timing: 'before_vote' },
  protect: { targets: ['other'], category: null, timing: 'before_vote' },
  double_vote: { targets: ['self'], category: null, timing: 'anytime' },
  block_vote: { targets: ['other'], category: null, timing: 'before_vote' },
  cancel_vote: { targets: ['none'], category: null, timing: 'anytime' },
  // SPEC §11 X1: `eject` (the one-player Airlock) is never dealt any more; `airlock` needs a partner.
  airlock: { targets: ['other'], category: null, timing: 'before_vote', minRound: 2 },
  revive: { targets: ['ejected'], category: null, timing: 'before_vote' },
  capacity_plus: { targets: ['none'], category: null, timing: 'anytime' },
  capacity_minus: { targets: ['none'], category: null, timing: 'before_vote' },
  bunker_add_feature: { targets: ['none'], category: null, timing: 'anytime' },
};

export const BOT_NAMES = ['Bot Anna', 'Bot Boris', 'Bot Clara', 'Bot Dmitri', 'Bot Elena', 'Bot Fedor', 'Bot Galina',
  'Bot Igor', 'Bot Katya', 'Bot Leonid', 'Bot Masha', 'Bot Nikolai', 'Bot Olga', 'Bot Pavel', 'Bot Rita', 'Bot Sergei',
  'Bot Tanya', 'Bot Vadim', 'Bot Yulia', 'Bot Zakhar'];

// ---------------------------------------------------------------------------------------------------------------
// Small utilities

/** Seeded PRNG (mulberry32 over an FNV-1a hash of the seed). Returns a () => [0,1) function. */
export function makeRng(seed = 1) {
  let h = 2166136261 >>> 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let a = h || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, arr) {
  return arr.length ? arr[Math.floor(rng() * arr.length)] : undefined;
}

/** http://h:p, ws://h:p, h:p, http://h:p/?room=X -> ws://h:p/ws */
export function toWsUrl(url) {
  let u = String(url || 'http://127.0.0.1:8080').trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = 'http://' + u;
  const parsed = new URL(u);
  const proto = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
  const path = parsed.protocol.startsWith('ws') && parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/ws';
  return `${proto}//${parsed.host}${path}`;
}

/** Any of the above -> http://h:p (no trailing slash). */
export function toHttpUrl(url) {
  let u = String(url || 'http://127.0.0.1:8080').trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = 'http://' + u;
  const parsed = new URL(u);
  const proto = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return `${proto}//${parsed.host}`;
}

export function roomLink(url, room) {
  return `${toHttpUrl(url)}/?room=${room}`;
}

export function categoryIds(state) {
  return state && Array.isArray(state.categories) && state.categories.length
    ? state.categories.map((c) => c.id) : CATEGORY_IDS;
}

/** Actions that carry the step key (SPEC §11 R1; `special` since R3). */
export const STEP_KEYED = new Set(['reveal', 'endTurn', 'next', 'closeVote', 'vote', 'special']);
/** The step key the shipped client sends: the step of the StateView the action was decided on. */
export function stepRefOf(s) {
  return {
    phase: s.phase, round: s.round, overtime: s.overtime,
    turnIndex: s.turn ? s.turn.index : null, ballot: s.vote ? s.vote.ballot : null, stage: s.vote ? s.vote.stage : null,
  };
}

export function playerById(state, id) {
  return state && state.players ? state.players.find((p) => p.id === id) || null : null;
}

export function alivePlayers(state) {
  return state.players.filter((p) => p.status === 'alive');
}

/** Categories of a player that are hidden according to the public view (not meaningful in 'final'). */
export function hiddenCategories(state, playerId) {
  const p = playerById(state, playerId);
  if (!p || !p.cards) return [];
  return categoryIds(state).filter((c) => p.cards[c] === null || p.cards[c] === undefined);
}

/** Categories the recipient (the current speaker) may reveal now (SPEC §7 field semantics). */
export function eligibleReveal(state) {
  if (!state || !state.me || !state.turn || state.phase !== 'reveal') return [];
  const base = state.turn.mustReveal ? [state.turn.mustReveal] : categoryIds(state);
  return base.filter((c) => state.me.cards[c] && !state.me.cards[c].revealed);
}

export function cumKicks(n, r) {
  const row = KICKS[n];
  if (!row) return 0;
  let s = 0;
  for (let i = 0; i < Math.min(r, 7); i++) s += row[i];
  return s;
}

/** SPEC §2 kicksThisStep for round `round` (default state.round) computed from the public state. */
export function kicksFormula(state, round = state.round) {
  const n = state.players.length;
  const alive = state.players.filter((p) => p.status === 'alive').length;
  const out = n - alive;
  if (round >= MAX_ROUNDS || state.overtime) return Math.max(0, alive - state.capacity);
  return Math.max(0, Math.min(cumKicks(n, round) - out, alive - state.capacity));
}

/** SPEC §7 schedule.nextVoteRound outside a step. */
export function nextVoteRoundFormula(state) {
  if (state.phase === 'lobby' || state.phase === 'final') return null;
  if (state.phase === 'vote' || state.phase === 'defense') return state.round;
  for (let r = Math.max(1, state.round); r <= MAX_ROUNDS; r++) {
    if (kicksFormula(state, r) > 0) return r;
  }
  return null;
}

/** Valid targets of a special for the recipient (SPEC §5). [null] for 'self'/'none'. */
export function validTargets(state, special) {
  const myId = state.you && state.you.id;
  const needsHidden = special.effect === 'force_reveal' || special.effect === 'peek';
  if (special.target === 'none' || special.target === 'self') return [null];
  if (special.target === 'other') {
    return state.players
      .filter((p) => p.status === 'alive' && p.id !== myId && (!needsHidden || hiddenCategories(state, p.id).length > 0))
      .map((p) => p.id);
  }
  if (special.target === 'ejected') return state.players.filter((p) => p.status === 'ejected').map((p) => p.id);
  return [];
}

/** Allowed categories for a special against a target; [null] when the special has no category choice. */
export function allowedCategories(state, special, targetId) {
  if (special.category !== 'choose') return [null];
  if (special.effect === 'force_reveal' || special.effect === 'peek') return hiddenCategories(state, targetId);
  return categoryIds(state);
}

/** The recipient's playable specials: [{ special, targets }] (SPEC §5 "A special is playable iff ..."). */
export function playableSpecials(state) {
  if (!state || !state.me || !state.me.canPlaySpecial || !ACTIVE_PHASES.includes(state.phase)) return [];
  const self = playerById(state, state.you.id);
  if (!self || self.status !== 'alive') return [];
  const beforeVote = state.phase === 'reveal' || state.phase === 'discussion';
  const inStep = state.phase === 'vote' || state.phase === 'defense';
  const out = [];
  for (const sp of state.me.specials || []) {
    if (sp.used) continue;
    if (state.round < (sp.minRound || 1)) continue;
    if (sp.timing !== 'anytime' && !beforeVote) continue;
    if (sp.effect === 'cancel_vote' && !inStep && state.voteMods && state.voteMods.cancelNext) continue;
    // SPEC §11 Z3: a ×2 needs a vote: not while blocked, nor for a non-voter of the open ballot
    if (sp.effect === 'double_vote' && ((state.voteMods && state.voteMods.blocked.includes(self.id))
      || (state.phase === 'vote' && state.vote && !state.vote.voters.includes(self.id)))) continue;
    const targets = validTargets(state, sp).filter((t) => allowedCategories(state, sp, t).length > 0);
    if (targets.length) out.push({ special: sp, targets });
  }
  return out;
}

/** SPEC §11 X1 log line of an airlock that closed: "🚪 A sealed the airlock with B — T is thrown out of the bunker, no vote!" */
export const AIRLOCK_SEALED_RE = /^🚪 (.+) sealed the airlock with (.+) — (.+) is thrown out of the bunker, no vote!$/u;

/** Players the current game threw out through an airlock who are still ejected (from the log, by name). */
export function airlockVictims(state) {
  if (!state || !Array.isArray(state.log) || !Array.isArray(state.players)) return [];
  let start = 0;
  for (let i = state.log.length - 1; i >= 0; i--) {
    if (state.log[i].kind === 'system' && /^The game begins/.test(state.log[i].text)) { start = i; break; }
  }
  const byName = new Map(state.players.map((p) => [p.name, p]));
  const out = new Set();
  for (const e of state.log.slice(start)) {
    const m = e.kind === 'eject' ? AIRLOCK_SEALED_RE.exec(e.text) : null;
    const p = m ? byName.get(m[3]) : null;
    if (p && p.status === 'ejected') out.add(p.id);
  }
  return [...out];
}

/** One-line human summary of a state (for logs and timeouts). */
export function describeState(s) {
  if (!s) return '(no state yet)';
  const alive = s.players ? s.players.filter((p) => p.status === 'alive').length : 0;
  const parts = [`room=${s.room}`, `phase=${s.phase}`, `round=${s.round}${s.overtime ? '(OT)' : ''}`,
    `alive=${alive}/${s.players ? s.players.length : 0}`, `cap=${s.capacity}`, `host=${s.hostId}`];
  if (s.turn) parts.push(`turn=${s.turn.kind}:${s.turn.speakerId}#${s.turn.index}/${s.turn.order.length} revealed=${s.turn.hasRevealed}`);
  if (s.vote) parts.push(`vote=${s.vote.stage} ${s.vote.ballot}/${s.vote.ballots} voted=${s.vote.voted.length}/${s.vote.voters.length}`);
  const offline = s.players ? s.players.filter((p) => !p.connected && p.status !== 'left').map((p) => p.id) : [];
  if (offline.length) parts.push(`offline=${offline.join(',')}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// Coordinator: lets an in-process host bot wait until the other bots are idle before pressing Next / Close vote.

export class Coordinator {
  constructor() { this.bots = new Set(); }
  add(bot) { this.bots.add(bot); }
  remove(bot) { this.bots.delete(bot); }
  get botIds() { return new Set([...this.bots].map((b) => b.id).filter(Boolean)); }
  isIdle(except) {
    for (const b of this.bots) {
      if (b === except || b.stopped || !b.autoplay || b.paused || !b.connected) continue;
      if (b.timer || b.fifo.length) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The bot

const DEFAULT_HOST = {
  enabled: true, // act as host whenever state.you.isHost
  next: true, // Next in discussion, and for an offline speaker in reveal/defense
  closeVote: true, // Close vote when every still-missing voter is offline
  autoStart: 0, // Start once this many players are seated (0 = never)
  playAgain: false, // Play again after the final
  handOverToHuman: false, // in the lobby, transfer host to the first seated player that is not a bot of this coordinator
  delay: null, // ms before a host action (null = bot delay)
  discussionDelay: null, // ms before Next in discussion (null = host delay)
  playAgainDelay: null, // ms before Play again (null = 3 x host delay)
  patience: 0, // ms: press Next / Close vote anyway when a turn or ballot stalls this long (0 = never)
  // SPEC §11 X6: probability per game of pressing End game at a random moment of it (a random count of states into the
  // game, at the first moment the other bots of the coordinator are idle). The table goes back to the lobby.
  endGame: 0,
};

let botCounter = 0;

export class Bot extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.url            server URL (http://h:p, ws://h:p/ws or h:p)
   * @param {string} o.name
   * @param {*} [o.seed]              RNG seed (default: the name)
   * @param {number} [o.delay=0]      ms before a normal action (0 = next tick). Jittered x0.6..1.4 when > 0
   * @param {number} [o.speechDelay]  ms before End turn (default: delay)
   * @param {number} [o.specials=0]   probability per round of playing one special
   * @param {number} [o.specialsFromRound=1]  do not plan specials before this round (keeps them for the late game)
   * @param {number} [o.airlockJoin=0.75]   SPEC §11 X1, when `specials` > 0: chance to join an airlock someone else opened
   * @param {number} [o.airlockOpen=0.3]    ... chance per round that an Airlock holder opens one
   * @param {number} [o.reviveVictims=0.5]  ... chance per round that a revive holder brings back an airlock victim
   * @param {(state:object, candidates:string[], rng:()=>number)=>string} [o.voteFor]  vote strategy (default: random)
   * @param {boolean} [o.autoplay=true]
   * @param {object} [o.host]         see DEFAULT_HOST
   * @param {Coordinator} [o.coordinator]
   * @param {boolean} [o.reconnect=false]  resume automatically after an unexpected socket close
   * @param {number} [o.maxRate=Infinity]    autoplay sends at most this many messages per rolling second (the server drops
   *                                         messages above 20/s unless BUNKER_NO_LIMITS=1; each action costs 2: action + ping)
   * @param {number} [o.pongTimeout=5000]    an action without a pong after this long counts as dropped and may be retried
   * @param {boolean} [o.stepKeys=true]      autoplay adds the step key `at` (SPEC §11 R1/R3) to reveal/endTurn/next/closeVote/
   *                                         vote/special, as the shipped client does, so a stale action is refused instead of
   *                                         landing on the next turn or ballot (a human host's Next never skips a bot's
   *                                         successor, and a card meant for a vote that just closed is not spent on the next)
   * @param {(url:string)=>object} [o.transport]  opens the bot's socket instead of `new WebSocket(url)`: any object with the
   *                                         `ws` shape the bot uses (readyState with OPEN = 1, send(text), close(), terminate(),
   *                                         and 'open'/'message'/'error'/'close' events). The dev server's in-process bots
   *                                         (SPEC §11 X9, server/dev.js) pass a loopback socket that talks to the room
   *                                         registry directly
   * @param {(line:string)=>void} [o.log]
   */
  constructor(o = {}) {
    super();
    this.setMaxListeners(100);
    this.opts = o;
    this.serial = ++botCounter;
    this.url = toWsUrl(o.url);
    this.name = o.name || `Bot ${this.serial}`;
    this.seed = o.seed ?? this.name;
    this.rng = makeRng(this.seed);
    this.jitterRng = makeRng(`${this.seed}:jitter`);
    this.delay = o.delay ?? 0;
    this.speechDelay = o.speechDelay ?? this.delay;
    this.specialsP = o.specials ?? 0;
    this.specialsFromRound = o.specialsFromRound ?? 1;
    this.airlockJoinP = o.airlockJoin ?? 0.75;
    this.airlockOpenP = o.airlockOpen ?? 0.3;
    this.reviveVictimsP = o.reviveVictims ?? 0.5;
    this.voteFor = typeof o.voteFor === 'function' ? o.voteFor : null;
    this.autoplay = o.autoplay !== false;
    this.host = { ...DEFAULT_HOST, ...(o.host || {}) };
    this.coordinator = o.coordinator || null;
    this.reconnect = !!o.reconnect;
    this.logFn = o.log || null;
    this.pongTimeout = o.pongTimeout ?? 5000;
    this.maxRate = o.maxRate ?? Infinity;
    this.stepKeys = o.stepKeys !== false;
    this.transport = typeof o.transport === 'function' ? o.transport : null;
    this.sentTimes = [];
    this.dropped = 0; // actions whose pong never came (see _expireStale)

    this.ws = null;
    this.socketGen = 0;
    this.id = null;
    this.room = null;
    this.token = null;
    this.state = null;
    this.prevState = null;
    this.stateSeq = 0;
    this.fifo = []; // sent messages awaiting their pong: { msg, key, seq, t }
    this.errors = []; // { code, message, msg, key, race, phase, t }
    this.sent = 0;
    this.received = 0;
    this.acted = new Set();
    this.retries = new Map();
    this.timer = null;
    this.ctxKey = '';
    this.ctxSince = Date.now();
    this.plans = new Map();
    this.gameNo = 0;
    this.gameStates = 0; // states received since the current game started (the End game policy counts them)
    this.endedAtSeq = -1; // stateSeq of the last lobby state that followed a running game (SPEC §11 X6 End game)
    this.paused = false;
    this.stopped = false;
    this.kicked = null;
    this.replaced = false;
    this.left = false;
    this.pending = null;
    this.specialsPlayed = [];
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    if (this.coordinator) this.coordinator.add(this);
  }

  get connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  get me() { return this.state ? this.state.me : null; }
  get isHost() { return !!(this.state && this.state.you && this.state.you.isHost); }
  get self() { return playerById(this.state, this.id); }

  say(line) {
    if (this.logFn) this.logFn(`[${this.name}] ${line}`);
  }

  // ---- connection ------------------------------------------------------------------------------------------

  /** Opens a fresh socket (closing any previous one). */
  connect() {
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try { old.terminate(); } catch { /* ignore */ }
    }
    this.fifo = [];
    const gen = ++this.socketGen;
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = this.transport ? this.transport(this.url) : new WebSocket(this.url, { handshakeTimeout: 10000, perMessageDeflate: false });
      this.ws = ws;
      ws.on('open', () => { opened = true; resolve(this); });
      ws.on('message', (data, isBinary) => this._onRaw(data, isBinary, gen));
      ws.on('error', (err) => {
        if (!opened) reject(err);
        this.emit('socket-error', err);
      });
      ws.on('close', (code, reason) => {
        if (!opened) reject(new Error(`socket closed before open (${code})`));
        if (this.ws === ws) {
          this.ws = null;
          this._clearTimer();
          this.fifo = [];
        }
        this.emit('close', { code, reason: String(reason || ''), gen });
        if (this.pending && this.pending.gen === gen) {
          this.pending.reject(new Error(`socket closed (${code}) during ${this.pending.kind}`));
          this.pending = null;
        }
        if (this.ws === null && gen === this.socketGen) this._maybeReconnect();
      });
    });
  }

  async _request(kind, msg, timeoutMs = 10000) {
    if (!this.connected) await this.connect();
    if (this.pending) throw new Error(`${this.name}: ${this.pending.kind} already pending`);
    this.stopped = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.kind === kind) this.pending = null;
        reject(new Error(`${this.name}: ${kind} timed out`));
      }, timeoutMs);
      this.pending = {
        kind,
        gen: this.socketGen,
        joined: false,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this._send(msg, `request:${kind}`);
    });
  }

  /** Creates a room; resolves { room, id, token, state } once the first state arrived. */
  create() {
    return this._request('create', { t: 'create', name: this.name });
  }

  join(room, { spectator = false } = {}) {
    const msg = { t: 'join', room: String(room), name: this.name }; // sent as given: the server is case-insensitive
    if (spectator) msg.spectator = true;
    return this._request('join', msg);
  }

  /** Resumes on a new socket with the stored (or given) room and token. */
  async resume(room = this.room, token = this.token) {
    await this.connect();
    return this._request('resume', { t: 'resume', room, token });
  }

  /**
   * Sends `leave` and stops autoplay. No ping follows it: after a leave the server sends nothing more to the socket
   * (SPEC §6), so there is no reply to wait for. The socket stays open until close().
   */
  leave() {
    this.left = true;
    this.stop();
    this.fifo = [];
    if (!this.connected) return false;
    this.ws.send(JSON.stringify({ t: 'leave' }));
    this.sent++;
    this.leftAtSeq = this.stateSeq;
    return true;
  }

  /** Abrupt disconnect (no leave): the seat stays, shown offline. */
  drop() {
    this._clearTimer();
    const ws = this.ws;
    this.ws = null;
    this.fifo = [];
    if (ws) { try { ws.terminate(); } catch { /* ignore */ } }
  }

  /** Stops autoplay (the socket stays open). */
  stop() {
    this.stopped = true;
    this._clearTimer();
  }

  /** Stops autoplay and closes the socket gracefully (no leave). */
  close() {
    this.stop();
    this.reconnect = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.coordinator) this.coordinator.remove(this);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(1000, 'bye'); } catch { /* ignore */ }
      const t = setTimeout(() => { try { ws.terminate(); } catch { /* ignore */ } }, 500);
      t.unref?.();
    }
  }

  pause() { this.paused = true; this._clearTimer(); }
  resumePlay() { this.paused = false; this._kick(); }

  /** Sends an action followed by a ping (for error attribution). Returns false if the socket is not open. */
  act(msg, key = null) {
    return this._send(msg, key);
  }

  /** Sends raw data without bookkeeping (fuzzing). */
  raw(data) {
    if (!this.connected) return false;
    this.ws.send(data);
    return true;
  }

  _send(msg, key) {
    if (!this.connected) return false;
    this.ws.send(JSON.stringify(msg));
    this.ws.send('{"t":"ping"}');
    const now = Date.now();
    this.fifo.push({ msg, key, seq: this.stateSeq, t: now });
    this.sent++;
    if (Number.isFinite(this.maxRate)) this.sentTimes.push(now, now);
    const watchdog = setTimeout(() => this._expireStale(), this.pongTimeout + 5);
    watchdog.unref?.();
    return true;
  }

  /** Drops fifo entries whose pong never came (e.g. dropped by the server's rate limiter); their action may be retried. */
  _expireStale() {
    const now = Date.now();
    let expired = false;
    while (this.fifo.length && now - this.fifo[0].t >= this.pongTimeout) {
      const e = this.fifo.shift();
      expired = true;
      this.dropped++;
      if (e.key && !String(e.key).startsWith('request:')) this.acted.delete(e.key);
      this.say(`no reply to ${JSON.stringify(e.msg)} within ${this.pongTimeout} ms (dropped by the rate limiter?)`);
    }
    if (expired) this._kick();
  }

  /** ms to wait before autoplay may send another action (action + ping) under maxRate. */
  _rateWait() {
    if (!Number.isFinite(this.maxRate)) return 0;
    const now = Date.now();
    while (this.sentTimes.length && now - this.sentTimes[0] >= 1000) this.sentTimes.shift();
    if (this.sentTimes.length + 2 <= this.maxRate) return 0;
    return 1000 - (now - this.sentTimes[0]) + 1;
  }

  _maybeReconnect() {
    // one pending attempt at a time: a failed attempt reaches here twice (its socket's close event and the catch below)
    if (this.reconnectTimer || !this.reconnect || this.stopped || this.kicked || this.replaced || this.left || !this.token) return;
    const wait = Math.min(10000, 1000 * 2 ** Math.min(this.reconnectAttempts, 4));
    this.reconnectAttempts++;
    this.say(`connection lost, resuming in ${Math.round(wait / 1000)} s`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.resume();
        this.reconnectAttempts = 0;
        this.say('resumed');
      } catch (e) {
        const code = e && e.code;
        if (code === 'bad_token' || code === 'no_room') { this.say(`cannot resume (${code}), giving up`); this.stop(); return; }
        this._maybeReconnect();
      }
    }, wait);
  }

  // ---- incoming --------------------------------------------------------------------------------------------

  _onRaw(data, isBinary, gen) {
    if (gen !== this.socketGen) return; // a stale socket
    this.received++;
    let msg;
    try { msg = JSON.parse(isBinary ? Buffer.from(data).toString('utf8') : data.toString()); } catch {
      this.emit('garbage', data);
      return;
    }
    const meta = { gen, t: Date.now() };
    this.emit('message', msg, meta);
    switch (msg && msg.t) {
      case 'joined':
        this.id = msg.id;
        this.room = msg.room;
        this.token = msg.token;
        if (this.pending) this.pending.joined = true;
        this.emit('joined', msg);
        break;
      case 'state': this._onState(msg, meta); break;
      case 'error': this._onError(msg); break;
      case 'kicked':
        this.kicked = msg.reason || 'kicked';
        this.stop();
        this.say(`kicked: ${this.kicked}`);
        this.emit('kicked', msg);
        break;
      case 'pong':
        this.fifo.shift();
        this.emit('pong');
        this._kick();
        break;
      default:
        this.emit('unknown', msg);
    }
  }

  _onState(s, meta) {
    this.prevState = this.state;
    this.state = s;
    this.stateSeq++;
    const prev = this.prevState;
    if (prev && prev.phase !== s.phase) {
      this.acted.clear();
      this.retries.clear();
      if (prev.phase === 'lobby' && s.phase !== 'lobby') { this.gameNo++; this.plans.clear(); this.gameStates = 0; }
    }
    if (s.phase !== 'lobby') this.gameStates++;
    if (prev && ACTIVE_PHASES.includes(prev.phase) && s.phase === 'lobby') this.endedAtSeq = this.stateSeq;
    const ctx = [s.phase, s.round, s.overtime, s.turn ? `${s.turn.index}:${s.turn.speakerId}:${s.turn.hasRevealed}` : '',
      s.vote ? `${s.vote.ballot}:${s.vote.stage}` : ''].join('|');
    if (ctx !== this.ctxKey) {
      this.ctxKey = ctx;
      this.ctxSince = Date.now();
      this._clearTimer();
    }
    if (this.pending && this.pending.joined) {
      const p = this.pending;
      this.pending = null;
      p.resolve({ room: this.room, id: this.id, token: this.token, state: s });
    }
    this.emit('state', s, prev, meta);
    this._kick();
  }

  _onError(msg) {
    // 'replaced' is unsolicited: it answers another socket's resume, not our oldest message
    const head = msg.code === 'replaced' ? undefined : this.fifo[0];
    // SPEC §11 X6: an action sent during a game that the host ended before the server got to it. The lobby state came
    // first, so this answer is about a game that is gone: expected, like the answers after a kick or a leave.
    const crossedEnd = !!head && head.seq < this.endedAtSeq;
    const err = {
      expected: !!(this.kicked || this.left || this.replaced || msg.code === 'replaced' || crossedEnd), crossedEnd,
      code: msg.code, message: msg.message, msg: head ? head.msg : null, key: head ? head.key : null,
      race: head ? this.stateSeq > head.seq : null, phase: this.state ? this.state.phase : null, t: Date.now(),
      state: this.state ? describeState(this.state) : null,
    };
    this.errors.push(err);
    if (head && head.key && !String(head.key).startsWith('request:')) {
      // A race may be retried if the decision still applies; a genuine rejection is never retried.
      const n = this.retries.get(head.key) || 0;
      if (err.race && n < 3) { this.retries.set(head.key, n + 1); this.acted.delete(head.key); }
    }
    this.say(`error ${msg.code}${err.race ? ' (race)' : ''}: ${msg.message} <- ${head ? JSON.stringify(head.msg) : '?'}`);
    this.emit('server-error', err);
    if (this.pending && (!head || String(head.key).startsWith('request:'))) {
      const p = this.pending;
      this.pending = null;
      const e = new Error(`${this.name}: ${p.kind} failed: ${msg.code} ${msg.message}`);
      e.code = msg.code;
      p.reject(e);
    }
    if (msg.code === 'replaced') {
      this.replaced = true;
      this.stop();
      this.emit('replaced', msg);
    }
  }

  // ---- waiting ---------------------------------------------------------------------------------------------

  /** Resolves with the state once pred(state) is true (checked immediately and on every state). */
  waitFor(pred, timeoutMs = 10000, label = 'condition') {
    return new Promise((resolve, reject) => {
      if (this.state && safePred(pred, this.state)) { resolve(this.state); return; }
      const onState = (s) => {
        if (safePred(pred, s)) { cleanup(); resolve(s); }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.name}: timed out after ${timeoutMs} ms waiting for ${label}; last state: ${describeState(this.state)}`));
      }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); this.off('state', onState); };
      this.on('state', onState);
    });
  }

  // ---- policy ----------------------------------------------------------------------------------------------

  _clearTimer() {
    if (this.timer) {
      if (this.timer.immediate) clearImmediate(this.timer.handle); else clearTimeout(this.timer.handle);
      this.timer = null;
    }
  }

  _jitter(ms) {
    if (!ms) return 0;
    return Math.round(ms * (0.6 + 0.8 * this.jitterRng()));
  }

  _hostDelay() { return this.host.delay ?? this.delay; }

  _next(s) {
    const list = this.decide(s);
    for (const d of list) if (!this.acted.has(d.key)) return d;
    return null;
  }

  _kick() {
    if (!this.autoplay || this.paused || this.stopped || !this.state || !this.id || !this.connected) return;
    if (this.timer) return;
    if (this.fifo.length) return; // re-kicked by the pong, or by _expireStale()
    const d = this._next(this.state);
    if (!d) return;
    let wait = d.delay || 0;
    if (d.notBefore) wait = Math.max(wait, d.notBefore - Date.now());
    this._arm(wait);
  }

  _arm(wait) {
    const run = () => { this.timer = null; this._fire(); };
    this.timer = wait > 0 ? { immediate: false, handle: setTimeout(run, wait) } : { immediate: true, handle: setImmediate(run) };
  }

  _fire() {
    if (!this.autoplay || this.paused || this.stopped || !this.state || !this.connected) return;
    if (this.fifo.length) return; // re-kicked by the pong
    const d = this._next(this.state);
    if (!d) return;
    if (d.notBefore && d.notBefore > Date.now()) { this._arm(d.notBefore - Date.now()); return; }
    if (d.host && this.coordinator && !this.coordinator.isIdle(this)) { this._arm(3); return; }
    const rateWait = this._rateWait();
    if (rateWait > 0) { this._arm(rateWait); return; }
    this.acted.add(d.key);
    const msg = d.build();
    if (!msg) { this._kick(); return; }
    if (this.stepKeys && STEP_KEYED.has(msg.t) && msg.at === undefined) msg.at = stepRefOf(this.state);
    if (this._send(msg, d.key) && d.describe) this.say(d.describe(msg));
  }

  /** The ordered list of things this bot wants to do now: [{ key, delay, build, host?, describe? }]. */
  decide(s) {
    const out = [];
    if (!s || !s.you || !this.id) return out;
    const myId = s.you.id;
    const isPlayer = s.you.role === 'player';
    const self = playerById(s, myId);
    const alive = !!(self && self.status === 'alive');
    const d = this.delay;
    const rng = this.rng;
    const name = (id) => { const p = playerById(s, id); return p ? p.name : id; };

    // 0. as host: End game, when this game's roll says so (SPEC §11 X6). First, so it can land mid-turn or mid-vote.
    if (this.host.enabled && s.you.isHost) {
      const eg = this._endGameDecision(s);
      if (eg) out.push(eg);
    }

    // 1. my turn
    if (isPlayer && s.turn && s.turn.speakerId === myId) {
      const tk = `${s.round}:${s.overtime}:${s.turn.index}`;
      if (s.phase === 'reveal') {
        const elig = eligibleReveal(s);
        if (!s.turn.hasRevealed && elig.length) {
          out.push({ key: `reveal:${tk}`, delay: this._jitter(d),
            build: () => ({ t: 'reveal', category: elig.includes('profession') && s.round === 1 ? 'profession' : pick(rng, elig) }),
            describe: (m) => `reveals ${m.category}` });
        } else {
          out.push({ key: `end:${tk}`, delay: this._jitter(this.speechDelay), build: () => ({ t: 'endTurn' }),
            describe: () => 'ends turn' });
        }
      } else if (s.phase === 'defense') {
        out.push({ key: `defense:${tk}`, delay: this._jitter(this.speechDelay), build: () => ({ t: 'endTurn' }),
          describe: () => 'ends defense speech' });
      }
    }

    // 2a. airlocks and revives of airlock victims (SPEC §11 X1). Same key as 2., so at most one special per round.
    if (this.specialsP > 0 && alive && s.me && s.me.canPlaySpecial && (s.phase === 'reveal' || s.phase === 'discussion')
      && s.round >= this.specialsFromRound) {
      const x1 = this._airlockPlan(s);
      if (x1) out.push({ key: `special:${this.gameNo}:${s.round}`, delay: this._jitter(d), build: x1.build, describe: x1.describe });
    }

    // 2. a special, if one is planned for this round and phase
    if (this.specialsP > 0 && alive && s.me && s.me.canPlaySpecial && ACTIVE_PHASES.includes(s.phase) && s.round >= this.specialsFromRound) {
      const planKey = `${this.gameNo}:${s.round}`;
      if (!this.plans.has(planKey)) {
        const roll = this.rng();
        let phase = null;
        if (roll < this.specialsP) {
          const r = this.rng();
          phase = r < 0.45 ? 'reveal' : r < 0.75 ? 'discussion' : 'vote';
        }
        this.plans.set(planKey, phase);
      }
      let planned = this.plans.get(planKey);
      if (planned === 'vote' && s.schedule && s.schedule.nextVoteRound !== s.round && s.phase === 'discussion') planned = 'discussion';
      const phaseOk = planned && (planned === s.phase || (planned === 'vote' && s.phase === 'defense')
        || (planned === 'reveal' && s.phase === 'discussion'));
      if (phaseOk) {
        const playable = playableSpecials(s);
        if (playable.length) {
          out.push({ key: `special:${this.gameNo}:${s.round}`, delay: this._jitter(d),
            build: () => {
              const now = playableSpecials(this.state);
              if (!now.length) return null;
              const choice = pick(rng, now);
              // an Airlock picked at random still goes to an airlock someone else opened, most of the time
              const waiting = choice.special.effect === 'airlock'
                ? (this.state.airlocks || []).filter((a) => !a.byIds.includes(myId) && choice.targets.includes(a.targetId)).map((a) => a.targetId) : [];
              const targetId = waiting.length && rng() < 0.8 ? pick(rng, waiting) : pick(rng, choice.targets);
              const category = pick(rng, allowedCategories(this.state, choice.special, targetId));
              const msg = { t: 'special', uid: choice.special.uid };
              if (targetId) msg.targetId = targetId;
              if (category) msg.category = category;
              this.specialsPlayed.push({ effect: choice.special.effect, round: this.state.round, phase: this.state.phase, msg });
              return msg;
            },
            describe: (m) => {
              const sp = (s.me.specials || []).find((x) => x.uid === m.uid);
              return `plays special "${sp ? sp.title : m.uid}" (${sp ? sp.effect : '?'})${m.targetId ? ` on ${name(m.targetId)}` : ''}${m.category ? ` [${m.category}]` : ''}`;
            } });
        }
      }
    }

    // 3. vote
    if (s.phase === 'vote' && s.vote && s.me && s.vote.voters.includes(myId) && !s.me.myVote) {
      const cands = s.vote.candidates.filter((id) => id !== myId);
      if (cands.length) {
        out.push({ key: `vote:${s.round}:${s.overtime}:${s.vote.ballot}:${s.vote.stage}:${s.vote.candidates.join(',')}`,
          delay: this._jitter(d),
          build: () => {
            const choice = this.voteFor ? this.voteFor(this.state, cands, rng) : null;
            return { t: 'vote', targetId: cands.includes(choice) ? choice : pick(rng, cands) };
          },
          describe: (m) => `votes against ${name(m.targetId)}` });
      }
    }

    // 4. host duties
    if (this.host.enabled && s.you.isHost) out.push(...this._hostDecisions(s));
    return out;
  }

  /**
   * SPEC §11 X1: what this bot does with an Airlock or a revive this round, or null. Each chance is rolled once per
   * game, round (and airlock), so the policy is stable across the many decide() calls of one state.
   */
  _airlockPlan(s) {
    const myId = s.you.id;
    const playable = playableSpecials(s);
    const air = playable.find((x) => x.special.effect === 'airlock');
    const roll = (key, p) => {
      if (!this.plans.has(key)) this.plans.set(key, this.rng() < p);
      return this.plans.get(key);
    };
    const play = (special, why, chooseTarget) => ({
      build: () => {
        const st = this.state;
        const now = playableSpecials(st).find((x) => x.special.uid === special.uid);
        if (!now) return null;
        const targetId = chooseTarget(st, now.targets);
        if (!targetId) return null;
        const msg = { t: 'special', uid: special.uid, targetId };
        this.specialsPlayed.push({ effect: special.effect, round: st.round, phase: st.phase, msg, why });
        return msg;
      },
      describe: (m) => {
        const p = playerById(this.state, m.targetId);
        return `plays special "${special.title}" (${special.effect}, ${why}) on ${p ? p.name : m.targetId}`;
      },
    });
    if (air) {
      for (const a of s.airlocks || []) {
        if (a.byIds.includes(myId) || !air.targets.includes(a.targetId)) continue;
        if (roll(`x1-join:${this.gameNo}:${s.round}:${a.targetId}:${a.byIds.join(',')}`, this.airlockJoinP)) {
          return play(air.special, 'joins the airlock', (st, targets) => {
            const still = (st.airlocks || []).some((x) => x.targetId === a.targetId && !x.byIds.includes(myId));
            return still && targets.includes(a.targetId) ? a.targetId : null;
          });
        }
      }
      if (roll(`x1-open:${this.gameNo}:${s.round}`, this.airlockOpenP)) {
        return play(air.special, 'opens an airlock', (st, targets) => {
          const free = targets.filter((t) => !(st.airlocks || []).some((x) => x.targetId === t));
          return pick(this.rng, free.length ? free : targets) || null;
        });
      }
    }
    const rev = playable.find((x) => x.special.effect === 'revive');
    if (rev) {
      const victims = airlockVictims(s).filter((id) => rev.targets.includes(id));
      if (victims.length && roll(`x1-revive:${this.gameNo}:${s.round}`, this.reviveVictimsP)) {
        return play(rev.special, 'revives an airlock victim', (st, targets) => {
          const v = airlockVictims(st).filter((id) => targets.includes(id));
          return pick(this.rng, v) || null;
        });
      }
    }
    return null;
  }

  /**
   * SPEC §11 X6: with probability host.endGame per game, End game once this bot has seen a random number of states of
   * it (rolled once per game when it first decides as host). A host action: it waits until the other bots of the
   * coordinator are idle, so it lands on a quiet state (the host's own turn or vote, a discussion, an offline speaker)
   * and no other bot's action crosses it.
   */
  _endGameDecision(s) {
    const p = this.host.endGame;
    if (!(p > 0) || !ACTIVE_PHASES.includes(s.phase)) return null;
    const key = `x6-endgame:${this.gameNo}`;
    if (!this.plans.has(key)) this.plans.set(key, this.rng() < p ? 1 + Math.floor(this.rng() * (20 + 30 * s.players.length)) : Infinity);
    if (this.gameStates < this.plans.get(key)) return null;
    return { key: `endGame:${this.gameNo}`, delay: this._jitter(this._hostDelay()), host: true,
      build: () => ({ t: 'endGame' }), describe: () => 'ends the game (back to the lobby)' };
  }

  _hostDecisions(s) {
    const out = [];
    const h = this.host;
    const hd = this._hostDelay();
    const connected = (id) => { const p = playerById(s, id); return !!(p && p.connected); };
    if (s.phase === 'lobby') {
      if (h.handOverToHuman && this.coordinator) {
        const bots = this.coordinator.botIds;
        const human = s.players.find((p) => !bots.has(p.id) && p.connected);
        if (human) {
          out.push({ key: `handover:${human.id}`, delay: this._jitter(hd), host: true,
            build: () => ({ t: 'transferHost', playerId: human.id }), describe: () => `hands the host over to ${human.name}` });
          return out;
        }
      }
      if (h.autoStart && s.players.length >= Math.max(h.autoStart, s.minPlayers || 2)) {
        out.push({ key: 'start', delay: this._jitter(hd), host: true, build: () => ({ t: 'start' }), describe: () => 'starts the game' });
      }
    } else if ((s.phase === 'reveal' || s.phase === 'defense') && s.turn && h.next) {
      const sid = s.turn.speakerId;
      if (!connected(sid)) {
        out.push({ key: `next:${s.phase}:${s.turn.index}`, delay: this._jitter(hd), host: true,
          build: () => ({ t: 'next' }), describe: () => 'presses Next (speaker offline)' });
      } else if (h.patience > 0) {
        out.push({ key: `next:${s.phase}:${s.turn.index}`, delay: 0, notBefore: this.ctxSince + h.patience, host: true,
          build: () => ({ t: 'next' }), describe: () => 'presses Next (speaker took too long)' });
      }
    } else if (s.phase === 'discussion' && h.next) {
      // round/overtime/timer: consecutive overtime discussions stay in phase 'discussion' but restart the timer
      out.push({ key: `next:discussion:${s.round}:${s.overtime}:${s.timer ? s.timer.endsAt : ''}`, delay: this._jitter(h.discussionDelay ?? hd), host: true,
        build: () => ({ t: 'next' }), describe: () => 'presses Next (end of discussion)' });
    } else if (s.phase === 'vote' && s.vote && h.closeVote) {
      const missing = s.vote.voters.filter((id) => !s.vote.voted.includes(id));
      if (missing.length && missing.every((id) => !connected(id))) {
        out.push({ key: `close:${s.vote.ballot}:${s.vote.stage}:${s.vote.voted.length}`, delay: this._jitter(hd), host: true,
          build: () => ({ t: 'closeVote' }), describe: () => 'closes the vote (missing voters are offline)' });
      } else if (missing.length && h.patience > 0) {
        out.push({ key: `close:${s.vote.ballot}:${s.vote.stage}:${s.vote.voted.length}`, delay: 0,
          notBefore: this.ctxSince + h.patience, host: true, build: () => ({ t: 'closeVote' }),
          describe: () => 'closes the vote (took too long)' });
      }
    } else if (s.phase === 'final' && h.playAgain) {
      out.push({ key: 'playAgain', delay: this._jitter(h.playAgainDelay ?? 3 * hd), host: true,
        build: () => ({ t: 'playAgain' }), describe: () => 'presses Play again' });
    }
    return out;
  }
}

function safePred(pred, s) {
  try { return !!pred(s); } catch { return false; }
}
