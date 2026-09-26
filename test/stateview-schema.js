// Strict, field-by-field validator for every server -> client message of SPEC.md §7 (StateView, joined, error,
// kicked, pong). Clients were written against the SPEC text, so any drift here (a missing, extra or retyped key, a
// field outside its documented range or phase) is a client-breaking bug even when the game itself plays fine.
//
//   import { validateServerMessage, validateStateView } from './stateview-schema.js';
//   const problems = validateServerMessage(msg);   // [] when the message matches the SPEC exactly
//   validateServerMessage(msg, { dev: true })      // a dev-mode server (SPEC §11 X9): see below
//
// Dev mode (§11 X9) is opt-in: without `{dev: true}` a `god` key is an unexpected key, so every simulation proves that a
// normal server never sends it. With it, `god` is optional and checked against the view, and a hand may hold more than
// 2 specials (giveSpecial tops a player up to 2 unused cards and keeps the used ones, which stay in playedSpecials): at
// most DEV_MAX_HAND, 7 played (one per round) plus 2 unused.
//
// §11 X5.2 (languages): `you.lang`, `catastrophe.id`, an `id` on every special entry, and `key`, `params` and `parts` on
// every log entry, whose parts must join to exactly its `text` (report §8.1: no empty or adjacent strings, a prefix only
// first, a cardtext with its ': '). validateLogEntry() is exported for the Checker. The report's §14 fallback: the oldest
// entries of a long log may come without `parts` ({id, ts, kind, text, key, params}), but only as a run at the start of
// the log, and never among its newest PARTS_MIN entries.
//
// Used by the Checker in test/helpers-sim.js (so every simulated state in `npm test` is validated) and by the
// integration soak. Side-effect free on import (`node --test test/` loads every file in test/).

export const CATEGORY_IDS = ['profession', 'biology', 'health', 'hobby', 'phobia', 'skill', 'trait', 'baggage'];
const PHASES = ['lobby', 'reveal', 'discussion', 'vote', 'defense', 'final'];
/** §11 X5.1 languages (copied from the SPEC text). */
export const LANGS = ['en', 'ru'];
const PART_TYPES = ['player', 'card', 'cardtext', 'cat', 'value', 'prefix'];
const LOG_KEYS = ['id', 'ts', 'kind', 'text', 'key', 'params', 'parts'];
/** §11 X5.2 (report §14): an old entry without its parts, and how many of the newest entries always have them. */
const LOG_KEYS_BARE = ['id', 'ts', 'kind', 'text', 'key', 'params'];
export const PARTS_MIN = 20;
const LOG_KINDS = ['system', 'reveal', 'special', 'vote', 'eject', 'info'];
const STATUSES = ['alive', 'ejected', 'left'];
const ERROR_CODES = ['bad_request', 'not_in_room', 'no_room', 'bad_token', 'server_busy', 'room_full', 'not_host', 'wrong_phase',
  'not_your_turn', 'not_allowed', 'replaced'];
const ROOM_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
/** §11 X9: the largest hand a dev server can show (7 cards played, one per round, plus 2 unused ones). */
const DEV_MAX_HAND = 9;

/** §2 KICKS (copied from the SPEC text, not from the server, so the two are checked against each other). */
const KICKS = {
  2: [0, 0, 0, 0, 0, 0, 1], 3: [0, 0, 0, 0, 0, 1, 1], 4: [0, 0, 0, 0, 0, 1, 1], 5: [0, 0, 0, 0, 1, 1, 1],
  6: [0, 0, 0, 0, 1, 1, 1], 7: [0, 0, 0, 1, 1, 1, 1], 8: [0, 0, 0, 1, 1, 1, 1], 9: [0, 0, 1, 1, 1, 1, 1],
  10: [0, 0, 1, 1, 1, 1, 1], 11: [0, 1, 1, 1, 1, 1, 1], 12: [0, 1, 1, 1, 1, 1, 1], 13: [0, 1, 1, 1, 1, 1, 2],
  14: [0, 1, 1, 1, 1, 1, 2], 15: [0, 1, 1, 1, 1, 2, 2], 16: [0, 1, 1, 1, 1, 2, 2],
};

/** §5 effect table: allowed targets, category mode (null | 'any' | 'hidden'), timing, minRound (§7 semantics). */
const EFFECTS = {
  swap_card: { targets: ['other'], category: 'any', timing: 'anytime' },
  reroll_card: { targets: ['self', 'other'], category: 'any', timing: 'anytime' },
  force_reveal: { targets: ['other'], category: 'hidden', timing: 'anytime' },
  peek: { targets: ['other'], category: 'hidden', timing: 'anytime' },
  mass_reveal: { targets: ['none'], category: 'any', timing: 'anytime' },
  shuffle_category: { targets: ['none'], category: 'any', timing: 'anytime' },
  immunity: { targets: ['self'], category: null, timing: 'before_vote' },
  protect: { targets: ['other'], category: null, timing: 'before_vote' },
  double_vote: { targets: ['self'], category: null, timing: 'anytime' },
  block_vote: { targets: ['other'], category: null, timing: 'before_vote' },
  cancel_vote: { targets: ['none'], category: null, timing: 'anytime' },
  // §11 X1: the one-player `eject` is gone (content never deals it); the Airlock needs a partner
  airlock: { targets: ['other'], category: null, timing: 'before_vote', minRound: 2 },
  revive: { targets: ['ejected'], category: null, timing: 'before_vote' },
  capacity_plus: { targets: ['none'], category: null, timing: 'anytime' },
  capacity_minus: { targets: ['none'], category: null, timing: 'before_vote' },
  bunker_add_feature: { targets: ['none'], category: null, timing: 'anytime' },
};

const TOP_KEYS = ['serverNow', 'room', 'you', 'hostId', 'phase', 'round', 'maxRounds', 'overtime', 'minPlayers', 'maxPlayers', 'options',
  'categories', 'catastrophe', 'bunker', 'capacity', 'players', 'spectators', 'me', 'turn', 'vote', 'schedule', 'voteMods', 'timer',
  'lastVoteResult', 'log', 'final', 'airlocks'];
const PLAYER_KEYS = ['id', 'name', 'seat', 'connected', 'isHost', 'status', 'cards', 'revealedCount', 'playedSpecials', 'specialsLeft'];
const SPECIAL_KEYS = ['uid', 'id', 'title', 'text', 'effect', 'target', 'category', 'timing', 'minRound', 'used'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNEStr = (v) => typeof v === 'string' && v.length > 0;
const isInt = (v) => Number.isInteger(v);
const isBool = (v) => typeof v === 'boolean';
const short = (v) => { const s = JSON.stringify(v); return s === undefined ? 'undefined' : s.length > 100 ? `${s.slice(0, 97)}...` : s; };

function exactKeys(obj, keys, optional = []) {
  if (!isObj(obj)) return [`not an object: ${short(obj)}`];
  const out = [];
  for (const k of keys) if (!Object.hasOwn(obj, k)) out.push(`missing key "${k}"`);
  for (const k of Object.keys(obj)) if (!keys.includes(k) && !optional.includes(k)) out.push(`unexpected key "${k}"`);
  return out;
}

function strArray(v) { return Array.isArray(v) && v.every(isStr); }
function unique(arr) { return new Set(arr).size === arr.length; }

/**
 * §11 X5.3 / report §8.1: the problems of one log entry's `parts` against its `text` ([] when fine). A string part is
 * plain text; the others are {t:'player', id, v}, {t:'card', id, v, label, title, text}, {t:'cardtext', v} (with its
 * leading ': '), {t:'cat', id, v}, {t:'value', v} and {t:'prefix', v} (only first). No empty string, no two strings in a
 * row, and the parts joined are exactly the text.
 */
export function validateParts(parts, text) {
  const out = [];
  if (!Array.isArray(parts)) return [`parts is not an array: ${short(parts)}`];
  let joined = '';
  parts.forEach((x, i) => {
    if (typeof x === 'string') {
      if (!x) out.push(`parts[${i}] is an empty string`);
      if (i > 0 && typeof parts[i - 1] === 'string') out.push(`parts[${i - 1}] and parts[${i}] are two strings in a row`);
      joined += x;
      return;
    }
    if (!isObj(x) || !PART_TYPES.includes(x.t)) { out.push(`parts[${i}] has no known type: ${short(x)}`); return; }
    const keys = {
      player: ['t', 'id', 'v'], card: ['t', 'id', 'v', 'label', 'title', 'text'], cardtext: ['t', 'v'], cat: ['t', 'id', 'v'],
      value: ['t', 'v'], prefix: ['t', 'v'],
    }[x.t];
    for (const y of exactKeys(x, keys)) out.push(`parts[${i}] (${x.t}): ${y}`);
    for (const k of keys) if (k !== 't' && !isStr(x[k])) out.push(`parts[${i}].${k} is not a string`);
    if ((x.t === 'player' || x.t === 'card') && !isNEStr(x.id)) out.push(`parts[${i}] (${x.t}) has an empty id`);
    if (x.t === 'cat' && !CATEGORY_IDS.includes(x.id)) out.push(`parts[${i}] (cat) id ${short(x.id)}`);
    if (x.t === 'prefix' && i !== 0) out.push(`parts[${i}] is a prefix but not first`);
    if (x.t === 'cardtext' && isStr(x.v) && !x.v.startsWith(': ')) out.push(`parts[${i}] (cardtext) does not start with ': '`);
    joined += isStr(x.v) ? x.v : '';
  });
  if (isStr(text) && joined !== text) out.push(`the parts join to ${short(joined)}, not the text ${short(text)}`);
  return out;
}

/**
 * Entries already found valid. The engine hands every view of one language the same deep-frozen entry objects, so a
 * frozen entry is validated once (a changed or copied entry is a new object and is validated again).
 */
const VALID_ENTRIES = new WeakSet();
const frozenEntry = (e) => Object.isFrozen(e) && (!Object.hasOwn(e, 'parts')
  || (Array.isArray(e.parts) && Object.isFrozen(e.parts) && e.parts.every((x) => typeof x === 'string' || Object.isFrozen(x))));
const hasParts = (e) => isObj(e) && Object.hasOwn(e, 'parts');

/**
 * §11 X5.3: the problems of one log entry {id, ts, kind, text, key, params, parts} ([] when fine). An entry without the
 * `parts` key is the §14 fallback's old entry {id, ts, kind, text, key, params}; where it may stand is checked with the
 * whole log (validateStateView).
 */
export function validateLogEntry(e) {
  const out = exactKeys(e, hasParts(e) ? LOG_KEYS : LOG_KEYS_BARE);
  if (!isObj(e)) return out;
  if (!isInt(e.ts)) out.push('ts');
  if (!LOG_KINDS.includes(e.kind)) out.push(`kind ${short(e.kind)}`);
  if (!isStr(e.text)) out.push('text');
  if (!isNEStr(e.key)) out.push(`key ${short(e.key)}`);
  if (!isObj(e.params)) out.push(`params ${short(e.params)}`);
  if (hasParts(e)) out.push(...validateParts(e.parts, e.text));
  if (!out.length && isInt(e.id) && frozenEntry(e)) VALID_ENTRIES.add(e);
  return out;
}

/** Validates one server -> client message. Returns a list of problems ([] = matches the SPEC). */
export function validateServerMessage(msg, opts = {}) {
  if (!isObj(msg)) return [`message is not an object: ${short(msg)}`];
  switch (msg.t) {
    case 'state': {
      const { t, ...view } = msg; // eslint-disable-line no-unused-vars
      return validateStateView(view, opts);
    }
    case 'joined': {
      const p = exactKeys(msg, ['t', 'room', 'id', 'token']).map((x) => `joined: ${x}`);
      if (!ROOM_RE.test(msg.room)) p.push(`joined: bad room ${short(msg.room)}`);
      if (!isNEStr(msg.id)) p.push('joined: id');
      if (!isStr(msg.token) || msg.token.length < 22) p.push('joined: token shorter than 128 bits of base64');
      return p;
    }
    case 'error': {
      const p = exactKeys(msg, ['t', 'message', 'code']).map((x) => `error: ${x}`);
      if (!ERROR_CODES.includes(msg.code)) p.push(`error: unknown code ${short(msg.code)}`);
      if (!isNEStr(msg.message)) p.push('error: empty message');
      return p;
    }
    case 'kicked': {
      const p = exactKeys(msg, ['t', 'reason']).map((x) => `kicked: ${x}`);
      if (!isStr(msg.reason)) p.push('kicked: reason is not a string');
      return p;
    }
    case 'pong': return exactKeys(msg, ['t']).map((x) => `pong: ${x}`);
    default: return [`unknown message type ${short(msg.t)}`];
  }
}

/**
 * Validates a StateView (without the wire `t`) field by field against SPEC §7 incl. "Field semantics".
 * `dev: true` validates a dev-mode server's view (§11 X9): an optional `god`, and hands of 2–4 specials.
 * `logFrom`: validate only the log entries with a larger id in depth (a caller that validated the older ones already,
 * and checks elsewhere that they did not change); ids and order are always checked.
 */
export function validateStateView(s, { dev = false, logFrom = 0 } = {}) {
  const P = [];
  const bad = (m) => P.push(m);
  for (const x of exactKeys(s, TOP_KEYS, dev ? ['god'] : [])) bad(`StateView: ${x}`);
  if (!isObj(s)) return P;

  const phase = s.phase;
  const lobby = phase === 'lobby';
  const final = phase === 'final';
  const inStep = phase === 'vote' || phase === 'defense';
  if (!PHASES.includes(phase)) bad(`phase ${short(phase)}`);
  if (!isInt(s.serverNow) || s.serverNow <= 0) bad(`serverNow ${short(s.serverNow)}`);
  if (!ROOM_RE.test(s.room)) bad(`room ${short(s.room)}`);
  if (!isInt(s.round) || (lobby ? s.round !== 0 : s.round < 1 || s.round > 7)) bad(`round ${short(s.round)} in ${phase}`);
  if (s.maxRounds !== 7) bad('maxRounds !== 7');
  if (s.maxPlayers !== 16) bad('maxPlayers !== 16');
  if (!isInt(s.minPlayers) || s.minPlayers < 2 || s.minPlayers > 16) bad(`minPlayers ${short(s.minPlayers)}`);
  if (!isBool(s.overtime)) bad('overtime not boolean');
  else if (s.overtime && s.round !== 7) bad('overtime with round != 7');
  else if (s.overtime && lobby) bad('overtime in the lobby');

  // options
  for (const x of exactKeys(s.options, ['speechSeconds1', 'speechSeconds', 'discussionSeconds', 'defenseSeconds'])) bad(`options: ${x}`);
  if (isObj(s.options)) for (const [k, v] of Object.entries(s.options)) if (!isInt(v) || v < 5 || v > 600) bad(`options.${k} = ${short(v)}`);

  // categories
  if (!Array.isArray(s.categories) || s.categories.length !== 8) bad('categories must have 8 entries');
  else {
    s.categories.forEach((c, i) => {
      for (const x of exactKeys(c, ['id', 'label'])) bad(`categories[${i}]: ${x}`);
      if (c && c.id !== CATEGORY_IDS[i]) bad(`categories[${i}].id ${short(c.id)} (expected ${CATEGORY_IDS[i]})`);
      if (c && !isNEStr(c.label)) bad(`categories[${i}].label`);
    });
  }

  // catastrophe / bunker / capacity
  if (lobby) {
    if (s.catastrophe !== null) bad('catastrophe must be null in the lobby');
    if (s.bunker !== null) bad('bunker must be null in the lobby');
    if (s.capacity !== 0) bad('capacity must be 0 in the lobby');
  } else {
    for (const x of exactKeys(s.catastrophe, ['id', 'title', 'text', 'details'])) bad(`catastrophe: ${x}`);
    if (isObj(s.catastrophe) && (!isNEStr(s.catastrophe.title) || !isStr(s.catastrophe.text) || !strArray(s.catastrophe.details))) bad('catastrophe field types');
    if (isObj(s.catastrophe) && s.catastrophe.id !== null && !isNEStr(s.catastrophe.id)) bad(`catastrophe.id ${short(s.catastrophe.id)} (a content id or null)`);
    for (const x of exactKeys(s.bunker, ['name', 'size', 'duration', 'food', 'features'])) bad(`bunker: ${x}`);
    if (isObj(s.bunker)) {
      for (const k of ['name', 'size', 'duration', 'food']) if (!isStr(s.bunker[k])) bad(`bunker.${k} not a string`);
      if (!strArray(s.bunker.features) || s.bunker.features.length < 3) bad(`bunker.features ${short(s.bunker.features)}`);
    }
    if (!isInt(s.capacity) || s.capacity < 1) bad(`capacity ${short(s.capacity)}`);
  }

  // players
  const players = Array.isArray(s.players) ? s.players : [];
  if (!Array.isArray(s.players)) bad('players not an array');
  if (players.length > 16) bad(`${players.length} players (> 16)`);
  const byId = new Map();
  players.forEach((p, i) => {
    const L = `players[${i}]`;
    for (const x of exactKeys(p, PLAYER_KEYS, final ? ['unplayedSpecials'] : [])) bad(`${L}: ${x}`);
    if (!isObj(p)) return;
    if (final && !Object.hasOwn(p, 'unplayedSpecials')) bad(`${L}: unplayedSpecials missing in the final`);
    if (!final && Object.hasOwn(p, 'unplayedSpecials')) bad(`${L}: unplayedSpecials present outside the final`);
    if (!isNEStr(p.id)) bad(`${L}.id`);
    if (byId.has(p.id)) bad(`duplicate player id ${p.id}`);
    byId.set(p.id, p);
    if (!isNEStr(p.name)) bad(`${L}.name`);
    if (p.seat !== i) bad(`${L}.seat ${short(p.seat)} (players must be ordered by seat 0..n-1)`);
    if (!isBool(p.connected)) bad(`${L}.connected`);
    if (!isBool(p.isHost) || p.isHost !== (p.id === s.hostId)) bad(`${L}.isHost ${short(p.isHost)} vs hostId ${short(s.hostId)}`);
    if (!STATUSES.includes(p.status)) bad(`${L}.status ${short(p.status)}`);
    for (const x of exactKeys(p.cards, CATEGORY_IDS)) bad(`${L}.cards: ${x}`);
    let nonNull = 0;
    if (isObj(p.cards)) {
      for (const c of CATEGORY_IDS) {
        const v = p.cards[c];
        if (v !== null && !isStr(v)) bad(`${L}.cards.${c} is ${short(v)}`);
        if (v !== null) nonNull++;
        if (final && !isStr(v)) bad(`${L}.cards.${c} hidden in the final`);
      }
    }
    if (!isInt(p.revealedCount) || p.revealedCount < 0 || p.revealedCount > 8) bad(`${L}.revealedCount ${short(p.revealedCount)}`);
    else if (!final && nonNull !== p.revealedCount) bad(`${L}: ${nonNull} public cards but revealedCount ${p.revealedCount}`);
    const specList = (arr, what) => {
      if (!Array.isArray(arr)) { bad(`${L}.${what} not an array`); return; }
      arr.forEach((x, j) => {
        for (const y of exactKeys(x, ['id', 'title', 'text'])) bad(`${L}.${what}[${j}]: ${y}`);
        if (isObj(x) && (!isNEStr(x.id) || !isStr(x.title) || !isStr(x.text))) bad(`${L}.${what}[${j}] types`);
      });
    };
    specList(p.playedSpecials, 'playedSpecials');
    if (final) specList(p.unplayedSpecials, 'unplayedSpecials');
    if (!isInt(p.specialsLeft) || p.specialsLeft < 0 || p.specialsLeft > 2) bad(`${L}.specialsLeft ${short(p.specialsLeft)}`);
    if (lobby) {
      if (p.status !== 'alive' || nonNull !== 0 || p.revealedCount !== 0 || p.specialsLeft !== 0 || (Array.isArray(p.playedSpecials) && p.playedSpecials.length)) {
        bad(`${L}: lobby players must be alive, blank, with 0 counters`);
      }
    } else if (Array.isArray(p.playedSpecials)) {
      const held = p.specialsLeft + p.playedSpecials.length;
      if (dev ? held < 2 || held > DEV_MAX_HAND : held !== 2) bad(`${L}: specialsLeft ${p.specialsLeft} + played ${p.playedSpecials.length} != 2${dev ? ` (dev: 2..${DEV_MAX_HAND})` : ''}`);
      if (final && Array.isArray(p.unplayedSpecials) && p.unplayedSpecials.length !== p.specialsLeft) bad(`${L}: unplayedSpecials ${p.unplayedSpecials.length} != specialsLeft ${p.specialsLeft}`);
    }
  });
  const alive = players.filter((p) => p && p.status === 'alive').map((p) => p.id);
  const isPlayer = (id) => byId.has(id);
  const isAlive = (id) => byId.has(id) && byId.get(id).status === 'alive';
  const seatOf = (id) => (byId.has(id) ? byId.get(id).seat : 999);
  const inSeatOrder = (ids) => ids.every((id, i) => i === 0 || seatOf(ids[i - 1]) < seatOf(id));

  // spectators
  const specs = Array.isArray(s.spectators) ? s.spectators : [];
  if (!Array.isArray(s.spectators)) bad('spectators not an array');
  if (specs.length > 50) bad(`${specs.length} spectators (> 50)`);
  specs.forEach((x, i) => {
    for (const y of exactKeys(x, ['id', 'name', 'connected'])) bad(`spectators[${i}]: ${y}`);
    if (isObj(x) && (!isNEStr(x.id) || !isNEStr(x.name) || !isBool(x.connected))) bad(`spectators[${i}] types`);
    if (isObj(x) && byId.has(x.id)) bad(`id ${x.id} is both a player and a spectator`);
  });

  // host / you
  if (!isStr(s.hostId)) bad('hostId not a string');
  else if (s.hostId !== '' && !isPlayer(s.hostId)) bad(`hostId ${s.hostId} is not a seated player`);
  else if (s.hostId !== '' && byId.get(s.hostId).status === 'left') bad(`hostId ${s.hostId} has left`);
  for (const x of exactKeys(s.you, ['id', 'name', 'role', 'isHost', 'lang'])) bad(`you: ${x}`);
  const you = isObj(s.you) ? s.you : {};
  if (!LANGS.includes(you.lang)) bad(`you.lang ${short(you.lang)}`);
  if (!['player', 'spectator'].includes(you.role)) bad(`you.role ${short(you.role)}`);
  if (you.isHost !== (you.id === s.hostId)) bad('you.isHost inconsistent with hostId');
  const selfPub = byId.get(you.id);
  if (you.role === 'player') {
    if (!selfPub) bad('you.role is player but you are not in players[]');
    else {
      if (selfPub.name !== you.name) bad('you.name differs from players[]');
      if (selfPub.status === 'left') bad('a left player still receives states');
    }
  } else if (you.role === 'spectator') {
    const me = specs.find((x) => x && x.id === you.id);
    if (!me) bad('you.role is spectator but you are not in spectators[]');
    else if (me.name !== you.name) bad('you.name differs from spectators[]');
  }

  // me
  const expectMe = you.role === 'player' && !lobby;
  if (!expectMe) {
    if (s.me !== null) bad(`me must be null (${you.role}, ${phase})`);
  } else {
    const me = s.me;
    for (const x of exactKeys(me, ['cards', 'specials', 'canPlaySpecial', 'notes', 'myVote'])) bad(`me: ${x}`);
    if (isObj(me)) {
      for (const x of exactKeys(me.cards, CATEGORY_IDS)) bad(`me.cards: ${x}`);
      if (isObj(me.cards)) {
        let revealed = 0;
        for (const c of CATEGORY_IDS) {
          const card = me.cards[c];
          for (const x of exactKeys(card, ['text', 'revealed'])) bad(`me.cards.${c}: ${x}`);
          if (!isObj(card)) continue;
          if (!isStr(card.text) || !isBool(card.revealed)) { bad(`me.cards.${c} types`); continue; }
          if (card.revealed) revealed++;
          if (selfPub && isObj(selfPub.cards)) {
            const pub = selfPub.cards[c];
            if (final) { if (pub !== card.text) bad(`final: public ${c} differs from me.cards`); }
            else if (card.revealed ? pub !== card.text : pub !== null) bad(`me.cards.${c} (revealed=${card.revealed}) vs public ${short(pub)}`);
          }
        }
        if (selfPub && selfPub.revealedCount !== revealed) bad(`revealedCount ${selfPub.revealedCount} != me.cards revealed ${revealed}`);
      }
      if (!Array.isArray(me.specials) || (dev ? me.specials.length < 2 || me.specials.length > DEV_MAX_HAND : me.specials.length !== 2)) bad(`me.specials must have 2 cards${dev ? ` (dev: 2..${DEV_MAX_HAND})` : ''}: ${short(me.specials)}`);
      else {
        const uids = [];
        me.specials.forEach((c, i) => {
          const L = `me.specials[${i}]`;
          for (const x of exactKeys(c, SPECIAL_KEYS)) bad(`${L}: ${x}`);
          if (!isObj(c)) return;
          uids.push(c.uid);
          if (!isNEStr(c.uid) || !isNEStr(c.id) || !isStr(c.title) || !isStr(c.text) || !isBool(c.used)) bad(`${L} types`);
          const rule = EFFECTS[c.effect];
          if (!rule) { bad(`${L}.effect ${short(c.effect)}`); return; }
          if (!rule.targets.includes(c.target)) bad(`${L}: target ${short(c.target)} not allowed for ${c.effect}`);
          const catOk = rule.category === null ? c.category === null
            : rule.category === 'any' ? c.category === 'choose' || CATEGORY_IDS.includes(c.category)
              : c.category === 'choose' || c.category === 'random';
          if (!catOk) bad(`${L}: category ${short(c.category)} not allowed for ${c.effect}`);
          if (c.timing !== rule.timing) bad(`${L}: timing ${short(c.timing)} (expected ${rule.timing})`);
          if (c.minRound !== (rule.minRound || 1)) bad(`${L}: minRound ${short(c.minRound)}`);
        });
        if (!unique(uids)) bad('me.specials uids not unique');
        if (selfPub) {
          const used = me.specials.filter((c) => c && c.used).length;
          if (Array.isArray(selfPub.playedSpecials) && used !== selfPub.playedSpecials.length) bad(`me: ${used} used specials but ${selfPub.playedSpecials.length} public playedSpecials`);
          if (me.specials.length - used !== selfPub.specialsLeft) bad(`me: specialsLeft ${selfPub.specialsLeft} != unused ${me.specials.length - used}`);
        }
      }
      if (!isBool(me.canPlaySpecial)) bad('me.canPlaySpecial not boolean');
      else if (me.canPlaySpecial && (!selfPub || selfPub.status !== 'alive' || lobby || final)) bad('canPlaySpecial true for a non-alive player or outside reveal/discussion/vote/defense');
      if (!Array.isArray(me.notes)) bad('me.notes not an array');
      else me.notes.forEach((n, i) => {
        for (const x of exactKeys(n, ['ts', 'text'])) bad(`me.notes[${i}]: ${x}`);
        if (isObj(n) && (!isInt(n.ts) || !isStr(n.text))) bad(`me.notes[${i}] types`);
      });
      if (me.myVote !== null && !isStr(me.myVote)) bad(`me.myVote ${short(me.myVote)}`);
      if (me.myVote !== null && phase !== 'vote') bad(`me.myVote set outside the vote phase`);
      if (isStr(me.myVote) && isObj(s.vote)) {
        if (!Array.isArray(s.vote.candidates) || !s.vote.candidates.includes(me.myVote)) bad('me.myVote is not a candidate');
        if (me.myVote === you.id) bad('me.myVote is myself');
        if (!Array.isArray(s.vote.voted) || !s.vote.voted.includes(you.id)) bad('me.myVote set but I am not in vote.voted');
      }
      if (me.myVote === null && phase === 'vote' && isObj(s.vote) && Array.isArray(s.vote.voted) && s.vote.voted.includes(you.id)) bad('I am in vote.voted but me.myVote is null');
    }
  }

  // turn / vote / timer per phase (§4 table)
  const wantTurn = phase === 'reveal' || phase === 'defense';
  if (!wantTurn) { if (s.turn !== null) bad(`turn must be null in ${phase}`); } else {
    const t = s.turn;
    for (const x of exactKeys(t, ['kind', 'speakerId', 'order', 'index', 'mustReveal', 'hasRevealed'])) bad(`turn: ${x}`);
    if (isObj(t)) {
      if (t.kind !== phase) bad(`turn.kind ${short(t.kind)} in ${phase}`);
      if (!strArray(t.order) || !t.order.length || !unique(t.order) || !t.order.every(isPlayer)) bad(`turn.order ${short(t.order)}`);
      if (!isInt(t.index) || t.index < 0 || !Array.isArray(t.order) || t.index >= t.order.length) bad(`turn.index ${short(t.index)}`);
      else if (t.speakerId !== t.order[t.index]) bad('turn.speakerId !== order[index]');
      if (!isAlive(t.speakerId)) bad(`turn.speakerId ${short(t.speakerId)} is not alive`);
      const must = phase === 'reveal' && s.round === 1 ? 'profession' : null;
      if (t.mustReveal !== must) bad(`turn.mustReveal ${short(t.mustReveal)} (expected ${must})`);
      if (!isBool(t.hasRevealed)) bad('turn.hasRevealed not boolean');
      if (phase === 'defense' && t.hasRevealed !== false) bad('turn.hasRevealed must be false in defense');
      if (phase === 'reveal' && Array.isArray(t.order)) {
        const dir = s.round % 2 === 1 ? 1 : -1;
        if (!t.order.every((id, i) => i === 0 || dir * (seatOf(id) - seatOf(t.order[i - 1])) > 0)) bad(`reveal order not ${dir > 0 ? 'ascending' : 'descending'} in round ${s.round}`);
      }
      if (phase === 'defense' && Array.isArray(t.order) && !inSeatOrder(t.order)) bad('defense order not in seat order');
    }
  }
  if (phase !== 'vote') { if (s.vote !== null) bad(`vote must be null in ${phase}`); } else {
    const v = s.vote;
    for (const x of exactKeys(v, ['stage', 'ballot', 'ballots', 'candidates', 'voters', 'voted'])) bad(`vote: ${x}`);
    if (isObj(v)) {
      if (!['main', 'revote'].includes(v.stage)) bad(`vote.stage ${short(v.stage)}`);
      if (!isInt(v.ballot) || v.ballot < 1 || !isInt(v.ballots) || v.ballots < v.ballot) bad(`vote.ballot ${short(v.ballot)} of ${short(v.ballots)}`);
      for (const k of ['candidates', 'voters', 'voted']) {
        if (!strArray(v[k]) || !unique(v[k])) { bad(`vote.${k} ${short(v[k])}`); continue; }
        if (!v[k].every(isAlive)) bad(`vote.${k} contains a player who is not alive`);
        if (!inSeatOrder(v[k])) bad(`vote.${k} not in seat order`);
      }
      if (Array.isArray(v.candidates) && !v.candidates.length) bad('vote.candidates empty');
      if (Array.isArray(v.voted) && Array.isArray(v.voters) && !v.voted.every((id) => v.voters.includes(id))) bad('vote.voted not a subset of voters');
    }
  }
  const wantTimer = phase === 'reveal' || phase === 'discussion' || phase === 'defense';
  if (!wantTimer) { if (s.timer !== null) bad(`timer must be null in ${phase}`); } else {
    for (const x of exactKeys(s.timer, ['label', 'endsAt'])) bad(`timer: ${x}`);
    if (isObj(s.timer) && (!isStr(s.timer.label) || !isInt(s.timer.endsAt))) bad(`timer types ${short(s.timer)}`);
    else if (isObj(s.timer) && isObj(s.options) && isInt(s.serverNow)) {
      // §1/§3: speechSeconds1 in round 1, speechSeconds later, discussionSeconds, defenseSeconds; each (re)started
      // when its turn or phase starts, so at any view the time left is at most the option's length
      const secs = phase === 'discussion' ? s.options.discussionSeconds : phase === 'defense' ? s.options.defenseSeconds
        : s.round === 1 ? s.options.speechSeconds1 : s.options.speechSeconds;
      const left = s.timer.endsAt - s.serverNow;
      if (left > secs * 1000) bad(`timer ends ${left} ms after serverNow, more than the ${secs} s ${phase} option`);
      if (s.timer.endsAt < s.serverNow - 24 * 3600 * 1000) bad('timer.endsAt is not on the server clock');
    }
  }

  // schedule
  const sc = s.schedule;
  for (const x of exactKeys(sc, ['kicksByRound', 'outCount', 'kicksThisStep', 'nextVoteRound'])) bad(`schedule: ${x}`);
  if (isObj(sc)) {
    const row = lobby ? (players.length >= 2 ? KICKS[players.length] || [] : []) : KICKS[players.length];
    if (!Array.isArray(sc.kicksByRound) || JSON.stringify(sc.kicksByRound) !== JSON.stringify(row)) bad(`schedule.kicksByRound ${short(sc.kicksByRound)} (expected ${short(row)})`);
    const out = lobby ? 0 : players.length - alive.length;
    if (sc.outCount !== out) bad(`schedule.outCount ${short(sc.outCount)} (expected ${out})`);
    if (!isInt(sc.kicksThisStep) || sc.kicksThisStep < 0) bad(`schedule.kicksThisStep ${short(sc.kicksThisStep)}`);
    else if ((lobby || final) && sc.kicksThisStep !== 0) bad(`schedule.kicksThisStep ${sc.kicksThisStep} in ${phase}`);
    else if (phase === 'vote' && isObj(s.vote) && sc.kicksThisStep !== s.vote.ballots) bad('schedule.kicksThisStep !== vote.ballots during a step');
    if (lobby || final) { if (sc.nextVoteRound !== null) bad(`schedule.nextVoteRound must be null in ${phase}`); }
    else if (inStep) { if (sc.nextVoteRound !== s.round) bad(`schedule.nextVoteRound ${short(sc.nextVoteRound)} during a step (expected ${s.round})`); }
    else if (sc.nextVoteRound !== null && (!isInt(sc.nextVoteRound) || sc.nextVoteRound < s.round || sc.nextVoteRound > 7)) bad(`schedule.nextVoteRound ${short(sc.nextVoteRound)}`);
  }

  // voteMods
  const vm = s.voteMods;
  for (const x of exactKeys(vm, ['immune', 'blocked', 'doubleVote', 'cancelNext'])) bad(`voteMods: ${x}`);
  if (isObj(vm)) {
    for (const k of ['immune', 'blocked', 'doubleVote']) {
      if (!strArray(vm[k]) || !unique(vm[k])) { bad(`voteMods.${k} ${short(vm[k])}`); continue; }
      if (!vm[k].every(isAlive)) bad(`voteMods.${k} lists a player who is not alive`);
      if (!inSeatOrder(vm[k])) bad(`voteMods.${k} not in seat order`);
      if (lobby && vm[k].length) bad(`voteMods.${k} not empty in the lobby`);
    }
    if (!isBool(vm.cancelNext)) bad('voteMods.cancelNext not boolean');
    else if (lobby && vm.cancelNext) bad('voteMods.cancelNext set in the lobby');
  }

  // airlocks (§11 X1): open airlocks only exist in the reveal and discussion phases of their own round (from round 2),
  // one per target, on an alive player, opened by someone else
  if (!Array.isArray(s.airlocks)) bad(`airlocks not an array: ${short(s.airlocks)}`);
  else {
    if (s.airlocks.length && phase !== 'reveal' && phase !== 'discussion') bad(`airlocks must be [] in ${phase}`);
    const targets = new Set();
    s.airlocks.forEach((a, i) => {
      const L = `airlocks[${i}]`;
      for (const x of exactKeys(a, ['targetId', 'byIds', 'round'])) bad(`${L}: ${x}`);
      if (!isObj(a)) return;
      if (!isAlive(a.targetId)) bad(`${L}.targetId ${short(a.targetId)} is not an alive player`);
      if (targets.has(a.targetId)) bad(`two open airlocks on ${a.targetId}`);
      targets.add(a.targetId);
      if (!strArray(a.byIds) || !a.byIds.length || !unique(a.byIds) || !a.byIds.every(isPlayer) || a.byIds.includes(a.targetId)) bad(`${L}.byIds ${short(a.byIds)}`);
      if (!isInt(a.round) || a.round !== s.round || a.round < 2) bad(`${L}.round ${short(a.round)} in round ${s.round}`);
    });
  }

  // lastVoteResult
  const r = s.lastVoteResult;
  if (lobby && r !== null) bad('lastVoteResult must be null in the lobby');
  if (r !== null) {
    for (const x of exactKeys(r, ['stage', 'tally', 'ejectedId', 'tie', 'random', 'cancelled'])) bad(`lastVoteResult: ${x}`);
    if (isObj(r)) {
      if (!['main', 'revote'].includes(r.stage)) bad(`lastVoteResult.stage ${short(r.stage)}`);
      if (!isBool(r.random) || !isBool(r.cancelled)) bad('lastVoteResult.random/cancelled not boolean');
      if (r.ejectedId !== null && !isPlayer(r.ejectedId)) bad(`lastVoteResult.ejectedId ${short(r.ejectedId)}`);
      if (r.tie !== null && (!strArray(r.tie) || r.tie.length < 2 || !r.tie.every(isPlayer))) bad(`lastVoteResult.tie ${short(r.tie)}`);
      if (!Array.isArray(r.tally)) bad('lastVoteResult.tally not an array');
      else {
        const seen = new Set();
        r.tally.forEach((e, i) => {
          for (const x of exactKeys(e, ['targetId', 'votes', 'voterIds'])) bad(`lastVoteResult.tally[${i}]: ${x}`);
          if (!isObj(e)) return;
          if (!isPlayer(e.targetId) || seen.has(e.targetId)) bad(`lastVoteResult.tally[${i}].targetId ${short(e.targetId)}`);
          seen.add(e.targetId);
          if (!isInt(e.votes) || e.votes < 0) bad(`lastVoteResult.tally[${i}].votes ${short(e.votes)}`);
          if (!strArray(e.voterIds) || !e.voterIds.every(isPlayer) || e.voterIds.includes(e.targetId)) bad(`lastVoteResult.tally[${i}].voterIds ${short(e.voterIds)}`);
          else if (isInt(e.votes) && (e.votes < e.voterIds.length || e.votes > 2 * e.voterIds.length)) bad(`lastVoteResult.tally[${i}]: ${e.votes} votes from ${e.voterIds.length} voters`);
          if (i > 0 && isObj(r.tally[i - 1])) {
            const a = r.tally[i - 1];
            if (a.votes < e.votes || (a.votes === e.votes && seatOf(a.targetId) > seatOf(e.targetId))) bad('lastVoteResult.tally not sorted by votes desc, then seat');
          }
        });
        if (r.cancelled && (r.tally.length || r.ejectedId !== null || r.tie !== null || r.random)) bad(`a cancelled result must have tally [], ejectedId null, tie null, random false: ${short(r)}`);
        if (!r.cancelled && r.ejectedId !== null && !r.tally.some((e) => e && e.targetId === r.ejectedId)) bad('lastVoteResult.ejectedId is not in the tally');
        if (!r.cancelled && r.tie && !r.tie.every((id) => r.tally.some((e) => e && e.targetId === id))) bad('lastVoteResult.tie not in the tally');
        if (!r.cancelled && r.ejectedId === null && r.tie === null && r.tally.length) bad(`a non-cancelled result with a tally must eject or tie: ${short(r)}`);
        if (!r.cancelled && r.random && r.ejectedId === null) bad('random: true without an ejection');
      }
    }
  }

  // log
  if (!Array.isArray(s.log)) bad('log not an array');
  else {
    if (s.log.length > 200) bad(`log has ${s.log.length} entries (> 200)`);
    let prev = 0;
    s.log.forEach((e, i) => {
      if (!isObj(e) || !(VALID_ENTRIES.has(e) || (isInt(e.id) && e.id <= logFrom))) for (const x of validateLogEntry(e)) bad(`log[${i}]: ${x}`);
      if (!isObj(e)) return;
      if (!isInt(e.id) || e.id <= prev) bad(`log[${i}].id ${short(e.id)} not increasing`);
      prev = isInt(e.id) ? e.id : prev;
    });
    if (s.log.length && s.log[0].id < 1) bad('log ids must start at 1');
    // §11 X5.2 (report §14): entries without parts only as the log's oldest run, never among the newest PARTS_MIN
    let bare = 0;
    while (bare < s.log.length && isObj(s.log[bare]) && !hasParts(s.log[bare])) bare++;
    s.log.forEach((e, i) => { if (i > bare && isObj(e) && !hasParts(e)) bad(`log[${i}] (#${short(e.id)}) has no parts, but an older entry has them`); });
    if (bare > Math.max(0, s.log.length - PARTS_MIN)) bad(`only ${s.log.length - bare} of the newest ${Math.min(PARTS_MIN, s.log.length)} log entries have parts`);
  }

  // god (§11 X9, dev mode only): every seated player's cards and specials, consistent with the public view
  if (dev && Object.hasOwn(s, 'god')) {
    const g = s.god;
    const english = you.lang === 'en'; // the god view is English-only (§11 X9): its words match only an English view
    for (const x of exactKeys(g, ['players'])) bad(`god: ${x}`);
    if (isObj(g) && !isObj(g.players)) bad(`god.players not an object: ${short(g.players)}`);
    else if (isObj(g)) {
      const ids = Object.keys(g.players);
      if (lobby && ids.length) bad('god.players must be empty in the lobby (nothing is dealt)');
      if (!lobby && players.some((p) => isObj(p) && !ids.includes(p.id))) bad('god.players does not list every seated player');
      for (const id of ids) {
        const L = `god.players.${id}`;
        const e = g.players[id];
        const pub = byId.get(id);
        if (!pub) bad(`${L}: not a seated player`);
        for (const x of exactKeys(e, ['cards', 'specials'])) bad(`${L}: ${x}`);
        if (!isObj(e)) continue;
        for (const x of exactKeys(e.cards, CATEGORY_IDS)) bad(`${L}.cards: ${x}`);
        if (isObj(e.cards)) {
          for (const c of CATEGORY_IDS) {
            if (!isStr(e.cards[c])) bad(`${L}.cards.${c} is ${short(e.cards[c])}`);
            else if (english && pub && isObj(pub.cards) && pub.cards[c] !== null && pub.cards[c] !== e.cards[c]) bad(`${L}.cards.${c} differs from the public card`);
          }
        }
        if (!Array.isArray(e.specials) || e.specials.length < 2 || e.specials.length > DEV_MAX_HAND) { bad(`${L}.specials ${short(e.specials)}`); continue; }
        e.specials.forEach((c, j) => {
          for (const x of exactKeys(c, ['title', 'text', 'effect', 'used'])) bad(`${L}.specials[${j}]: ${x}`);
          if (isObj(c) && (!isStr(c.title) || !isStr(c.text) || !EFFECTS[c.effect] || !isBool(c.used))) bad(`${L}.specials[${j}] types ${short(c)}`);
        });
        if (pub) {
          const used = e.specials.filter((c) => isObj(c) && c.used).length;
          if (Array.isArray(pub.playedSpecials) && used !== pub.playedSpecials.length) bad(`${L}: ${used} used specials but ${pub.playedSpecials.length} played`);
          if (e.specials.length - used !== pub.specialsLeft) bad(`${L}: ${e.specials.length - used} unused specials but specialsLeft ${pub.specialsLeft}`);
        }
        if (english && you.id === id && isObj(s.me) && Array.isArray(s.me.specials) && isObj(s.me.cards)) {
          if (CATEGORY_IDS.some((c) => isObj(s.me.cards[c]) && s.me.cards[c].text !== e.cards?.[c])) bad(`${L}: my own cards differ from me.cards`);
          if (s.me.specials.length !== e.specials.length || s.me.specials.some((c, j) => !isObj(c) || c.title !== e.specials[j]?.title || c.used !== e.specials[j]?.used)) bad(`${L}: my own specials differ from me.specials`);
        }
      }
    }
  }

  // final
  if (!final) { if (s.final !== null) bad(`final must be null in ${phase}`); } else {
    const f = s.final;
    for (const x of exactKeys(f, ['survivors', 'out'])) bad(`final: ${x}`);
    if (isObj(f)) {
      if (!strArray(f.survivors) || !strArray(f.out)) bad('final lists not string arrays');
      else {
        const all = [...f.survivors, ...f.out];
        if (!unique(all) || !all.every(isPlayer)) bad('final lists overlap or name unknown ids');
        if (!inSeatOrder(f.survivors) || !inSeatOrder(f.out)) bad('final lists not in seat order');
        if (f.survivors.length > s.capacity) bad(`final: ${f.survivors.length} survivors > capacity ${s.capacity}`);
        // players who were seated when the final began are all listed; later leavers stay where they were
        if (!players.every((p) => all.includes(p.id))) bad('final does not list every seated player');
        if (!f.survivors.every((id) => byId.get(id).status !== 'ejected')) bad('an ejected player is listed as a survivor');
        if (!f.out.every((id) => byId.get(id).status !== 'alive')) bad('an alive player is listed as out');
      }
    }
  }
  return P;
}
