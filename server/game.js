// server/game.js — the PURE Bunker engine (SPEC.md §1–§7, §8 "Engine interface").
// No sockets, no timers: time only appears as timestamps taken from `now()`. All randomness comes from `rng`.
// Every public method is synchronous and never throws on bad input.
//
// §11 X5 (languages; reports/i18n-design.md §3): every English field stays and is rendered once (card text, special
// title and text, catastrophe, bunker, log text, notes, timer label), and a language-neutral twin sits next to it:
//   - a card's non-enumerable `tok` (a frozen content token; a swap or reroll replaces it, never edits it);
//   - a special's `ref` (its catalogue id, only when its words are the catalogue's English, else null: a literal);
//   - `catastropheTok` and `bunkerTok`;
//   - log entries, notes and the timer carry `key` and `params` (server/i18n; player refs {p, n}, never rendered text).
// view(id, lang) renders every human-readable string in the member's language (or `lang`), caching per token and per
// log entry; the view's `log` array is shared, read-only, by every recipient of one language until the log changes.
// A failure is {ok:false, code, key, params, message (English)}; rooms.js renders `key` in the socket's language.

import {
  CATEGORIES, createDealer, AIRLOCK_CARD, REVIVE_CARD, FALLBACK_SPECIAL as CONTENT_FALLBACK_SPECIAL,
  FALLBACK_FEATURE_TOK, FALLBACK_CATASTROPHE_TOK, FALLBACK_BUNKER_TOK, litTok, bunkerWithFeature,
  renderCard, renderSpecial, renderCatastrophe, renderBunker, renderFeature,
} from './content.js';
import { renderMsg, renderText, hasKey, normLang, categoryLabel, LANGS } from './i18n/index.js';

export { LANGS };

export const MAX_ROUNDS = 7;
export const MAX_PLAYERS = 16;
export const MAX_SPECTATORS = 50;
export const LOG_LIMIT = 200;
export const NAME_MAX = 20;

export const CATEGORY_IDS = Object.freeze(['profession', 'biology', 'health', 'hobby', 'phobia', 'skill', 'trait', 'baggage']);
const SPEC_LABELS = {
  profession: 'Profession', biology: 'Biology', health: 'Health', hobby: 'Hobby',
  phobia: 'Phobia', skill: 'Extra skill', trait: 'Personality', baggage: 'Baggage',
};
function contentLabel(id) {
  try {
    const found = Array.isArray(CATEGORIES) ? CATEGORIES.find((c) => c && c.id === id) : null;
    return found && typeof found.label === 'string' && found.label ? found.label : null;
  } catch { return null; }
}
/** Categories in display order (§1): ids fixed by the spec, labels from content.js when it has them. */
export const CATEGORY_LIST = Object.freeze(CATEGORY_IDS.map((id) => Object.freeze({ id, label: contentLabel(id) ?? SPEC_LABELS[id] })));
const IS_CATEGORY = (v) => typeof v === 'string' && CATEGORY_IDS.includes(v);

export const DEFAULT_OPTIONS = Object.freeze({ speechSeconds1: 60, speechSeconds: 30, discussionSeconds: 90, defenseSeconds: 30 });
const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);

// §2 — ejections scheduled at the end of rounds 1..7 for N starting players.
const KICKS_ROWS = {
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
export const KICKS = Object.freeze(Object.fromEntries(Object.entries(KICKS_ROWS).map(([n, row]) => [n, Object.freeze(row)])));
export function kicksRow(n) { return KICKS[n] ? [...KICKS[n]] : []; }

/**
 * §2 formula. `round` is 1..7; overtime counts as round 7.
 * r < 7: max(0, min(cum(r) − outCount, alive − capacity)); r = 7 / overtime: max(0, alive − capacity).
 */
export function kicksForStep({ row, round, overtime = false, outCount, alive, capacity }) {
  if (overtime || round >= MAX_ROUNDS) return Math.max(0, alive - capacity);
  let cum = 0;
  for (let i = 0; i < round && i < row.length; i++) cum += row[i];
  return Math.max(0, Math.min(cum - outCount, alive - capacity));
}

// §5 — the effect decides target type, category mode and timing.
//   category: 'any'    → a Category or 'choose' (any category may be chosen)
//             'hidden' → 'choose' or 'random' (limited to the target's hidden categories)
export const EFFECTS = Object.freeze({
  swap_card: { targets: ['other'], category: 'any', timing: 'anytime' },
  reroll_card: { targets: ['self', 'other'], category: 'any', timing: 'anytime' },
  force_reveal: { targets: ['other'], category: 'hidden', timing: 'anytime' },
  peek: { targets: ['other'], category: 'hidden', timing: 'anytime' },
  mass_reveal: { targets: ['none'], category: 'any', timing: 'anytime' },
  shuffle_category: { targets: ['none'], category: 'any', timing: 'anytime' },
  immunity: { targets: ['self'], timing: 'before_vote' },
  protect: { targets: ['other'], timing: 'before_vote' },
  double_vote: { targets: ['self'], timing: 'anytime' },
  block_vote: { targets: ['other'], timing: 'before_vote' },
  cancel_vote: { targets: ['none'], timing: 'anytime' },
  // The one-player Airlock of §5, kept for old tables and hand-made test deals only: content never deals it (§11 X1).
  eject: { targets: ['other'], timing: 'before_vote', minRound: 2 },
  // §11 X1: a first Airlock on a player opens the airlock on them; a second one on the same player, played by someone
  // else before this round's discussion ends, throws them out without a vote. Alone it jams at the end of the discussion.
  airlock: { targets: ['other'], timing: 'before_vote', minRound: 2 },
  revive: { targets: ['ejected'], timing: 'before_vote' },
  capacity_plus: { targets: ['none'], timing: 'anytime' },
  capacity_minus: { targets: ['none'], timing: 'before_vote' },
  bunker_add_feature: { targets: ['none'], timing: 'anytime' },
});

/**
 * §11 X1 fixed deal for N seated players at Start: AIRLOCKS(N) Airlocks (each to a different player) and REVIVES(N)
 * "Back from the Forest" revives (each to a player holding no Airlock and no other revive). None under 4 players.
 */
export function fixedDeal(n) {
  if (!Number.isInteger(n) || n < 4) return { airlocks: 0, revives: 0 };
  if (n <= 7) return { airlocks: 2, revives: 1 };
  if (n <= 11) return { airlocks: 3, revives: 1 };
  return { airlocks: 4, revives: 2 };
}
/** Effects drawSpecial() must never supply while the fixed deal is on (the engine deals them itself, §11 X1). */
const FIXED_ONLY = new Set(['airlock', 'revive', 'eject']);

const IN_GAME = new Set(['reveal', 'discussion', 'vote', 'defense']);
const BEFORE_VOTE = new Set(['reveal', 'discussion']);
const IN_STEP = new Set(['vote', 'defense']);

// ---------------------------------------------------------------------------------------------------------------
// Messages: schema check (shared with rooms.js so bad_request always wins, §7 precedence)

const SCHEMAS = {
  // §11 X5.1: `lang` ('en' | 'ru') on the hellos, and setLang at any time (rooms.js handles it like ping)
  create: { name: 'string', lang: 'lang?' },
  join: { room: 'string', name: 'string', spectator: 'boolean?', lang: 'lang?' },
  resume: { room: 'string', token: 'string', lang: 'lang?' },
  ping: {},
  setLang: { lang: 'lang' },
  leave: {},
  setOptions: { options: 'object' },
  start: {},
  takeSeat: {},
  kick: { playerId: 'string' },
  transferHost: { playerId: 'string' },
  // `at` (§11 R1): the step the click was made on; a stale one is refused with wrong_phase instead of landing on the next step.
  reveal: { category: 'category', at: 'stepref?' },
  endTurn: { at: 'stepref?' },
  next: { at: 'stepref?' },
  vote: { targetId: 'string', at: 'stepref?' },
  closeVote: { at: 'stepref?' },
  special: { uid: 'string', targetId: 'string?', category: 'category?', at: 'stepref?' },
  playAgain: {},
  // §11 X6: the host aborts the running game and takes everyone back to the lobby (in the final: the same as playAgain)
  endGame: {},
};
export const MESSAGE_TYPES = Object.freeze(Object.keys(SCHEMAS));
const ENGINE_TYPES = new Set(['leave', 'setOptions', 'start', 'takeSeat', 'kick', 'transferHost', 'reveal', 'endTurn', 'next', 'vote', 'closeVote', 'special', 'playAgain', 'endGame']);
const MAX_STRING = 1000;

/**
 * A failure (§7; §11 X5.4): {ok:false, code, key, params, message}. `key` is a server/i18n message key (default
 * `err.<code>`), `params` its language-neutral params, and `message` its English rendering, which tests and logs read;
 * rooms.js sends `key` rendered in the socket's language. A second argument that is not a catalogue key is taken as a
 * ready English message (callers outside the catalogue, such as server/dev.js): that failure has no key and is sent as
 * it is.
 */
export function fail(code, key, params) {
  if (typeof key === 'string' && key && !hasKey(key)) return { ok: false, code, message: key };
  const k = typeof key === 'string' && key ? key : `err.${code}`;
  if (!hasKey(k)) return { ok: false, code, message: 'Error' };
  const p = params && typeof params === 'object' ? params : {};
  return { ok: false, code, key: k, params: p, message: renderText('en', k, p) };
}
const ok = () => ({ ok: true });

// §11 R1 step key: `at: {phase, round, overtime, turnIndex, ballot, stage}`, copied from the StateView the click was made on.
// Each key is optional (an absent key is not compared); other keys are ignored.
const STEP_REF_TYPES = {
  phase: (x) => typeof x === 'string' && x.length <= 20,
  round: (x) => Number.isSafeInteger(x),
  overtime: (x) => typeof x === 'boolean',
  turnIndex: (x) => x === null || Number.isSafeInteger(x),
  ballot: (x) => x === null || Number.isSafeInteger(x),
  stage: (x) => x === null || (typeof x === 'string' && x.length <= 20),
};
const STEP_REF_KEYS = Object.keys(STEP_REF_TYPES);

function checkType(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string' && v.length <= MAX_STRING;
    case 'boolean': return typeof v === 'boolean';
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'category': return IS_CATEGORY(v);
    case 'lang': return LANGS.includes(v);
    case 'stepref': return checkType('object', v) && STEP_REF_KEYS.every((k) => !Object.hasOwn(v, k) || STEP_REF_TYPES[k](v[k]));
    default: return false;
  }
}

/** Returns null when `msg` passes the §7 schema check, otherwise a `bad_request` failure. */
export function validateMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return fail('bad_request', 'err.expectedObject');
  if (typeof msg.t !== 'string' || !Object.hasOwn(SCHEMAS, msg.t)) return fail('bad_request', 'err.unknownType');
  for (const [key, spec] of Object.entries(SCHEMAS[msg.t])) {
    const optional = spec.endsWith('?');
    const type = optional ? spec.slice(0, -1) : spec;
    const v = Object.hasOwn(msg, key) ? msg[key] : undefined;
    if (v === undefined || (optional && v === null)) {
      if (optional) continue;
      return fail('bad_request', 'err.missingField', { field: key });
    }
    if (!checkType(type, v)) return fail('bad_request', 'err.invalidField', { field: key });
  }
  if (msg.t === 'setOptions') {
    for (const key of OPTION_KEYS) {
      if (!Object.hasOwn(msg.options, key) || msg.options[key] === undefined) continue;
      const v = msg.options[key];
      if (!Number.isInteger(v) || v < 5 || v > 600) return fail('bad_request', 'err.optionRange', { field: key });
    }
  }
  return null;
}

// §6 / §11 names. Removed outright: Cc controls, every Cf format character (bidi marks and overrides, zero-width
// space/joiners, word joiner, soft hyphen, BOM, tags…), line/paragraph separators, the combining grapheme joiner and
// the characters that render as blanks (Hangul fillers, braille blank). A zero-width joiner survives only inside an
// emoji sequence (between two pictographs), where it is part of one visible glyph. §11 X5: the door emoji U+1F6AA is
// reserved for the airlock's log lines (clients recognise those by it), so a name never contains it. §11 Z4: lone
// surrogates (\p{Cs}) go too, so the two halves of a door split by a stripped character cannot join into one.
const NAME_STRIP = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u034F\u115F\u1160\u2800\u3164\uFFA0]|(?!\u200D)\p{Cf}|\u{1F6AA}[\uFE0E\uFE0F]?/gu;
const LONE_ZWJ = /(?<!\p{Extended_Pictographic}[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;
const VARIATION_SELECTORS = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
const ORPHAN_VS = /(^|\s)[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+/gu;
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

const GRAPHEMES = typeof Intl === 'object' && typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

/**
 * At most `max` code points of `s`, cut between graphemes (§11 X5), so an emoji sequence such as a family is kept whole
 * or dropped whole, never cut into a different emoji. A first grapheme longer than `max` is cut by code points.
 */
function clipGraphemes(s, max) {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  let out = '';
  let n = 0;
  if (GRAPHEMES) {
    for (const { segment } of GRAPHEMES.segment(s)) {
      const len = Array.from(segment).length;
      if (n + len > max) break;
      out += segment;
      n += len;
    }
  }
  return out || cps.slice(0, max).join('');
}

/** §6: trimmed to 1–20 characters with control, format and blank-rendering characters removed; '' when nothing visible is left. */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  let stripped = raw.normalize('NFC');
  // Until nothing more goes: a removal must never join what is left into something NAME_STRIP removes (§11 Z4).
  for (let prev = null; prev !== stripped;) { prev = stripped; stripped = stripped.replace(NAME_STRIP, ''); }
  // A variation selector with nothing before it to modify (at the start, after a space) is invisible junk: dropped.
  const cleaned = stripped.replace(LONE_ZWJ, '').replace(ORPHAN_VS, '$1').replace(/\s+/gu, ' ').trim();
  const name = clipGraphemes(cleaned, NAME_MAX).replace(LONE_ZWJ, '').trim();
  return VISIBLE.test(name.replace(VARIATION_SELECTORS, '')) ? name : '';
}

/** The key two names are compared by for the " (2)" suffix: names that look the same get the same key. */
export function nameKey(name) {
  return String(name).normalize('NFKC').replace(VARIATION_SELECTORS, '').replace(/\u200D/g, '').replace(/\s+/gu, ' ').trim();
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
const str = (v, fallback = '') => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const strList = (v) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);

/**
 * The catalogue id of a special whose words are exactly the catalogue's English (design §3.4), else null: a test card
 * that borrows a real id with other words stays a literal in every language.
 */
function catalogueRef(id, title, text) {
  let en = null;
  try { en = renderSpecial('en', id); } catch { en = null; }
  return en && en.title === title && en.text === text ? id : null;
}

/**
 * A dealt or hand-made special reduced to what the §5 effect table allows (also used by server/dev.js, §11 X9).
 * §11 X5: `ref` is its catalogue id when its title and text are the catalogue's English (null otherwise), and a card
 * without a title gets `special.untitled` ("Special condition"), marked `untitled` so it renders in every language.
 */
export function normalizeSpecial(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.effect !== 'string' || !Object.hasOwn(EFFECTS, raw.effect)) return null;
  const eff = EFFECTS[raw.effect];
  const target = eff.targets.includes(raw.target) ? raw.target : eff.targets[0];
  let category = null;
  if (eff.category === 'any') category = IS_CATEGORY(raw.category) || raw.category === 'choose' ? raw.category : 'choose';
  else if (eff.category === 'hidden') category = raw.category === 'random' ? 'random' : 'choose';
  const untitled = raw.title === undefined || raw.title === null;
  const id = str(raw.id, raw.effect);
  const title = (untitled ? renderText('en', 'special.untitled') : str(raw.title)).slice(0, 200);
  const text = str(raw.text).slice(0, 1000);
  const out = { id, title, text, effect: raw.effect, target, category, ref: untitled ? null : catalogueRef(id, title, text) };
  if (untitled) out.untitled = true;
  return out;
}

const FALLBACK_SPECIAL = CONTENT_FALLBACK_SPECIAL && typeof CONTENT_FALLBACK_SPECIAL === 'object' ? CONTENT_FALLBACK_SPECIAL
  : { id: 'fallback-feature', title: 'Hidden room', text: 'Add a new feature to the bunker.', effect: 'bunker_add_feature', target: 'none' };
// The fixed cards of §11 X1 (content.js owns their words; these stand in only if it ever lacks them).
const FIXED_AIRLOCK = normalizeSpecial(AIRLOCK_CARD) || normalizeSpecial({ id: 'airlock', title: 'Airlock', effect: 'airlock', target: 'other',
  text: 'Needs a partner. Choose a player to start cycling the airlock on them. If another player plays an Airlock on the same player this round before the vote, they are thrown out — no vote. Alone, the airlock jams.' });
const FIXED_REVIVE = normalizeSpecial(REVIVE_CARD) || normalizeSpecial({ id: 'revive', title: 'Back from the Forest', effect: 'revive', target: 'ejected',
  text: 'Play during a reveal or discussion phase. Choose an ejected player, whether they were voted out or thrown out through the airlock (not one who left the game): they come back and are alive again.' });

// ---------------------------------------------------------------------------------------------------------------
// §11 X5: language-neutral twins (reports/i18n-design.md §3)

/**
 * A characteristic card: {text, revealed} plus a non-enumerable `tok` (so a card still deep-equals {text, revealed}).
 * Every place that makes a new card object goes through here: a spread or a JSON copy would drop the token.
 */
function makeCard(text, tok, revealed) {
  const card = { text, revealed };
  Object.defineProperty(card, 'tok', { value: tok, enumerable: false, writable: true, configurable: true });
  return card;
}

/** A nested message param ({msg: {key, params}}), as server/i18n renders it. */
const M = (key, params = {}) => ({ msg: { key, params } });

/** The key of a log line an outside caller wrote as ready English text (server/dev.js, §11 X9: English-only). */
export const LEGACY_LOG_KEY = 'log.dev.text';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/**
 * Wire params (design §8.3): the internal params with every ref reduced to its language-neutral id. A player {p, n}
 * -> its id, a category -> its id, a special -> its catalogue ref (or its own id), a catastrophe -> its content id or
 * null, a bunker name -> null, a nested message -> {key, params} reduced; card and feature tokens are left out (their
 * text is in `text`/`parts` only). Numbers, booleans, strings and round prefixes {r, ot} pass through.
 */
const OMIT = Symbol('omit');
function reduceValue(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(reduceValue).filter((x) => x !== OMIT);
  if (typeof v !== 'object') return v;
  if (typeof v.p === 'string' && Object.hasOwn(v, 'n')) return v.p;
  if (Object.hasOwn(v, 'cat')) return v.cat;
  if (Object.hasOwn(v, 'tok') || Object.hasOwn(v, 'feat') || Object.hasOwn(v, 'cardtext')) return OMIT;
  if (Object.hasOwn(v, 'sp')) return v.sp && typeof v.sp === 'object' ? (v.sp.ref ?? v.sp.id ?? null) : null;
  if (Object.hasOwn(v, 'cata')) return v.cata && typeof v.cata === 'object' && typeof v.cata.id === 'string' ? v.cata.id : null;
  if (Object.hasOwn(v, 'bname')) return null;
  if (Object.hasOwn(v, 'msg')) return v.msg && typeof v.msg === 'object' ? { key: v.msg.key, params: reduceParams(v.msg.params) } : null;
  if (Object.hasOwn(v, 'r') && Object.hasOwn(v, 'ot')) return { r: v.r, ot: v.ot };
  return reduceParams(v);
}
function reduceParams(params) {
  const out = {};
  if (!params || typeof params !== 'object') return out;
  for (const [k, v] of Object.entries(params)) {
    const r = reduceValue(v);
    if (r !== OMIT) out[k] = r;
  }
  return out;
}

/**
 * Log entries as views show them, cached per entry (entries never change once logged) and language:
 * {id, ts, kind, text, key, params (wire), parts}, deep-frozen and shared by every view in that language.
 */
const ENTRY_VIEWS = new WeakMap();
function entryView(e, lang) {
  let c = ENTRY_VIEWS.get(e);
  if (!c) { c = {}; ENTRY_VIEWS.set(e, c); }
  if (c[lang]) return c[lang];
  if (!c.wire) c.wire = deepFreeze(reduceParams(e.params));
  const r = lang === 'en' && c.enParts ? { parts: c.enParts } : renderMsg(lang, e.key, e.params);
  c.enParts = undefined;
  // English is the entry's own text, rendered once when it was logged
  const text = lang === 'en' ? e.text : r.text;
  c[lang] = deepFreeze({ id: e.id, ts: e.ts, kind: e.kind, text, key: e.key, params: c.wire, parts: r.parts });
  return c[lang];
}

/** Warns once (in production) about a card without its token; under NODE_ENV=test it is an error (design §3.1). */
let tokWarned = false;
function missingTok() {
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test') {
    const e = new Error('a card without its language-neutral token reached a view');
    e.missingTok = true;
    throw e;
  }
  if (!tokWarned) { tokWarned = true; console.warn('[i18n] a card without its language-neutral token reached a view: English is shown'); }
}

// ---------------------------------------------------------------------------------------------------------------

export function createGame(opts = {}) { return new Game(opts); }

export class Game {
  constructor(opts = {}) {
    const { room = '', rng = Math.random, now = Date.now, minPlayers = 4, dealer = null, fixedSpecials = true } = opts && typeof opts === 'object' ? opts : {};
    this.room = str(room);
    this.rng = typeof rng === 'function' ? rng : Math.random;
    this.now = typeof now === 'function' ? now : Date.now;
    this.minPlayers = clampInt(minPlayers, 2, MAX_PLAYERS, 4);
    this.dealer = dealer || createDealer(this.rng);
    // §11 X1: deal AIRLOCKS(N)/REVIVES(N) fixed cards at Start. `fixedSpecials: false` hands every special slot to the
    // dealer instead (tests with a hand-made deal); then drawSpecial() may supply any effect, the old `eject` included.
    this.fixedSpecials = fixedSpecials !== false;
    this.hostId = '';
    this.hostSince = 0; // when the current host got the role: the §6 grace never counts time from before that
    this.players = []; // seated, in seat order
    this.spectators = []; // join order
    this.options = { ...DEFAULT_OPTIONS };
    this.log = [];
    this.logSeq = 0;
    this.idSeq = 0;
    this.uidSeq = 0;
    this._resetTable();
  }

  _resetTable() {
    this.phase = 'lobby';
    this.round = 0;
    this.overtime = false;
    this.N = 0;
    this.kicks = [];
    this.capacity = 0;
    this.catastrophe = null;
    this.catastropheTok = null; // §11 X5 language-neutral twins of the two fields above
    this.bunker = null;
    this.bunkerTok = null;
    this.turn = null; // { kind, order, index, hasRevealed }
    this.vote = null; // { stage, candidates, voters, votes: Map<voterId, targetId> }
    this.step = null; // { ballot, ballots, tied, mainVoters }
    this.timer = null;
    this.voteMods = { immune: new Set(), blocked: new Set(), doubleVote: new Set(), cancelNext: false };
    this.airlocks = []; // §11 X1 open airlocks: { targetId, byIds: [openerId], round }, in the order they were opened
    this.lastVoteResult = null;
    this.final = null;
  }

  // ------------------------------------------------------------------------------------------------ helpers
  _rand(n) {
    let x;
    try { x = Number(this.rng()); } catch { x = 0; }
    if (!(x >= 0 && x < 1)) x = 0;
    return Math.min(n - 1, Math.floor(x * n));
  }
  _pick(arr) { return arr[this._rand(arr.length)]; }
  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this._rand(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  _time() {
    try { const t = Number(this.now()); return Number.isFinite(t) ? t : 0; } catch { return 0; }
  }
  /**
   * Logs a line (§11 X5.3): `key` is a server/i18n key and `params` its language-neutral params (player refs {p, n},
   * tokens, nested messages; never rendered text). The entry keeps its English `text`, rendered now. A `key` that is
   * not a catalogue key is taken as a ready English line (server/dev.js writes those): it is kept as LEGACY_LOG_KEY
   * with the line as its `text` param, the same in every language.
   */
  _log(kind, key, params) {
    let k = key;
    let p = params;
    if (typeof key !== 'string' || !hasKey(key)) { k = LEGACY_LOG_KEY; p = { text: str(key) }; } else if (!p || typeof p !== 'object') p = {};
    deepFreeze(p);
    const r = renderMsg('en', k, p);
    const entry = { id: ++this.logSeq, ts: this._time(), kind, text: r.text, key: k, params: p };
    ENTRY_VIEWS.set(entry, { enParts: r.parts });
    this.log.push(entry);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }
  /** The round prefix as English text ('Round 3' / 'Overtime'); server/dev.js reads it. */
  _rp() { return this.overtime ? 'Overtime' : `Round ${this.round}`; }
  /** The round prefix as a message param (§11 X5.3 `rp`). */
  _rpRef() { return { r: this.round, ot: this.overtime }; }
  /** A member as a message param: {p: id, n: the name now} ('?' for an id that is not a member, as _name). */
  _ref(id) { return { p: id, n: this._name(id) }; }
  _refs(ids) { return ids.map((id) => this._ref(id)); }
  /** A member object as a message param. */
  _pref(x) { return { p: x.id, n: x.name }; }
  _player(id) { return typeof id === 'string' ? this.players.find((p) => p.id === id) ?? null : null; }
  _spectator(id) { return typeof id === 'string' ? this.spectators.find((s) => s.id === id) ?? null : null; }
  _member(id) {
    const p = this._player(id);
    if (p) return { kind: 'player', obj: p };
    const s = this._spectator(id);
    return s ? { kind: 'spectator', obj: s } : null;
  }
  _name(id) { return this._member(id)?.obj.name ?? '?'; }
  /** Names joined ', ' (English text; server/dev.js reads it). */
  _names(ids) { return ids.map((id) => this._name(id)).join(', '); }
  _alive() { return this.players.filter((p) => p.status === 'alive'); }
  _aliveCount() { return this.players.reduce((n, p) => n + (p.status === 'alive' ? 1 : 0), 0); }
  _outCount() { return this.phase === 'lobby' ? 0 : this.players.reduce((n, p) => n + (p.status !== 'alive' ? 1 : 0), 0); }
  _isAlive(id) { return this._player(id)?.status === 'alive'; }
  _renumber() { this.players.forEach((p, i) => { p.seat = i; }); }
  _seatOf(id) { return this._player(id)?.seat ?? 999; }
  _bySeat(ids) { return [...ids].sort((a, b) => this._seatOf(a) - this._seatOf(b)); }
  _hidden(p) { return p && p.cards ? CATEGORY_IDS.filter((c) => !p.cards[c].revealed) : []; }
  _mustReveal() { return this.phase === 'reveal' && this.round === 1 ? 'profession' : null; }
  _eligible(p) {
    const must = this._mustReveal();
    return (must ? [must] : CATEGORY_IDS).filter((c) => p.cards && !p.cards[c].revealed);
  }
  _speakerId() { return this.turn ? this.turn.order[this.turn.index] ?? null : null; }
  /** §11 R1: the current step as the StateView shows it ({phase, round, overtime, turnIndex, ballot, stage}). */
  _stepRef() {
    const turnShown = this.turn && (this.phase === 'reveal' || this.phase === 'defense');
    const voteShown = this.phase === 'vote' && this.vote && this.step;
    return {
      phase: this.phase, round: this.round, overtime: this.overtime,
      turnIndex: turnShown ? this.turn.index : null,
      ballot: voteShown ? this.step.ballot : null,
      stage: voteShown ? this.vote.stage : null,
    };
  }
  /**
   * §11 R1: a failure when the message's `at` names a step that is no longer the current one, otherwise null.
   * `ignore` lists keys that are not compared for this message (a special ignores `turnIndex`, §11 R3).
   */
  _stale(at, ignore = null) {
    if (at === undefined || at === null) return null;
    const cur = this._stepRef();
    for (const k of STEP_REF_KEYS) {
      if (ignore && ignore.includes(k)) continue;
      if (Object.hasOwn(at, k) && at[k] !== cur[k]) return fail('wrong_phase', 'err.stale');
    }
    return null;
  }
  _uniqueName(name) {
    const taken = new Set([...this.players, ...this.spectators].map((x) => nameKey(x.name)));
    if (!taken.has(nameKey(name))) return name;
    for (let i = 2; ; i++) {
      const candidate = `${name} (${i})`;
      if (!taken.has(nameKey(candidate))) return candidate;
    }
  }
  _newPlayer(id, name) {
    return {
      id, name, seat: this.players.length, connected: true, disconnectedAt: 0, status: 'alive',
      cards: null, specials: [], playedSpecials: [], notes: [], lastSpecialRound: 0,
    };
  }
  _kicksAt(round) {
    return kicksForStep({
      row: this.kicks, round, overtime: false, outCount: this._outCount(),
      alive: this._aliveCount(), capacity: this.capacity,
    });
  }
  _kicksNow() { return this._kicksAt(this.overtime ? MAX_ROUNDS : this.round); }
  _clearMods(includeCancel) {
    this.voteMods.immune.clear();
    this.voteMods.blocked.clear();
    this.voteMods.doubleVote.clear();
    if (includeCancel) this.voteMods.cancelNext = false;
  }
  /** The vote modifiers a cancelled or skipped step takes with it, for the log: a mods.used message, or null. */
  _expiringMods() {
    const items = [
      ...this._bySeat([...this.voteMods.immune]).map((id) => M('mod.immune', { p: this._ref(id) })),
      ...this._bySeat([...this.voteMods.blocked]).map((id) => M('mod.blocked', { p: this._ref(id) })),
      ...this._bySeat([...this.voteMods.doubleVote]).map((id) => M('mod.double', { p: this._ref(id) })),
    ];
    return items.length ? M('mods.used', { items, n: items.length }) : null;
  }

  /** The timer of a turn or a discussion: `key`/`params` name its label (timer.*), rendered in English here. */
  _setTimer(key, params, secs) {
    this.timer = { label: renderText('en', key, params), endsAt: this._time() + secs * 1000, key, params: deepFreeze(params) };
  }
  _dropMods(id) {
    this.voteMods.immune.delete(id);
    this.voteMods.blocked.delete(id);
    this.voteMods.doubleVote.delete(id);
  }

  // ------------------------------------------------------------------------------------------------ public API
  /** A new member (§6). `lang` (§11 X5): the member's language, 'en' unless given ('en' | 'ru'). */
  join(name, opts = {}) {
    try {
      const o = opts && typeof opts === 'object' ? opts : {};
      const spectator = o.spectator === true;
      const lang = normLang(o.lang) ?? 'en';
      const clean = sanitizeName(name);
      if (!clean) return fail('bad_request', 'err.nameRequired');
      const asSpectator = spectator === true || this.phase !== 'lobby' || this.players.length >= MAX_PLAYERS;
      if (asSpectator && this.spectators.length >= MAX_SPECTATORS) return fail('room_full');
      const id = `p${++this.idSeq}`;
      const finalName = this._uniqueName(clean);
      if (asSpectator) {
        this.spectators.push({ id, name: finalName, connected: true, disconnectedAt: 0, lang });
        this._log('info', 'log.watch', { p: { p: id, n: finalName } });
        return { ok: true, id, role: 'spectator' };
      }
      const p = this._newPlayer(id, finalName);
      p.lang = lang;
      this.players.push(p);
      this._log('info', 'log.join', { p: { p: id, n: finalName } });
      if (!this.hostId) this._setHost(id);
      return { ok: true, id, role: 'player' };
    } catch (e) {
      this.lastError = e;
      return fail('not_allowed', 'err.internal');
    }
  }

  /** §11 X5.1: sets a member's language. false for an unknown id or a language that is not supported. */
  setLang(id, lang) {
    const L = normLang(lang);
    const m = this._member(id);
    if (!L || !m) return false;
    m.obj.lang = L;
    return true;
  }

  /** A member's language ('en' | 'ru'), or null for an id that is not a member. */
  langOf(id) {
    const m = this._member(id);
    return m ? normLang(m.obj.lang) ?? 'en' : null;
  }

  handle(id, msg) {
    try {
      const bad = validateMessage(msg);
      if (bad) return bad;
      if (!ENGINE_TYPES.has(msg.t)) return fail('bad_request', 'err.notGameAction', { type: msg.t });
      const m = this._member(id);
      if (!m || (m.kind === 'player' && m.obj.status === 'left')) return fail('not_in_room');
      switch (msg.t) {
        case 'leave': return this._leave(m);
        case 'setOptions': return this._setOptions(id, msg.options);
        case 'start': return this._start(id);
        case 'takeSeat': return this._takeSeat(m);
        case 'kick': return this._kick(id, msg.playerId);
        case 'transferHost': return this._transferHost(id, msg.playerId);
        case 'reveal': return this._reveal(id, msg.category, msg.at);
        case 'endTurn': return this._endTurn(id, msg.at);
        case 'next': return this._next(id, msg.at);
        case 'vote': return this._vote(id, msg.targetId, msg.at);
        case 'closeVote': return this._closeVote(id, msg.at);
        case 'special': return this._special(m, msg);
        case 'playAgain': return this._playAgain(id);
        case 'endGame': return this._endGame(id);
        default: return fail('bad_request', 'err.unknownType');
      }
    } catch (e) {
      this.lastError = e;
      return { ...fail('not_allowed', 'err.internal'), internal: true };
    }
  }

  setConnected(id, connected) {
    const m = this._member(id);
    if (!m) return;
    if (m.kind === 'player' && m.obj.status === 'left') { m.obj.connected = false; return; }
    const was = m.obj.connected;
    m.obj.connected = !!connected;
    if (!connected && was) m.obj.disconnectedAt = this._time();
  }

  /** §6 grace-period passing: only to a *connected* player, no-op if none (or if the host is online). */
  passHost() {
    try {
      const host = this._player(this.hostId);
      if (!host || host.connected) return false;
      const next = this._pickHost(true);
      if (!next) return false;
      this._setHost(next.id, M('host.offline', { p: this._pref(host) }));
      return true;
    } catch (e) {
      this.lastError = e;
      return false;
    }
  }

  /**
   * ms the current host has been offline *as the host*, or null when there is no offline host. For rooms.js.
   * Counted from the later of the disconnect and the moment they became host (§11 H1), so a player who was handed
   * the role while offline gets the full grace period instead of losing it again at the next sweep.
   */
  hostOfflineMs() {
    const host = this._player(this.hostId);
    if (!host || host.connected || host.status === 'left') return null;
    return Math.max(0, this._time() - Math.max(host.disconnectedAt, this.hostSince));
  }

  /** true when `id` still has a place in the room (a seated non-left player, or a spectator). */
  isActive(id) {
    const m = this._member(id);
    return !!m && !(m.kind === 'player' && m.obj.status === 'left');
  }

  // ------------------------------------------------------------------------------------------------ host
  /** `why`: null, or the reason as a nested message (host.offline, host.handover). */
  _setHost(id, why = null) {
    this.hostId = id;
    this.hostSince = this._time();
    if (id) this._log('info', 'log.host', { p: this._ref(id), why: why || null });
  }
  _pickHost(connectedOnly) {
    const pool = this.players.filter((p) => p.status !== 'left' && p.id !== this.hostId);
    const aliveish = (p) => this.phase === 'lobby' || p.status === 'alive';
    const tiers = [(p) => p.connected && aliveish(p), (p) => p.connected && !aliveish(p)];
    if (!connectedOnly) tiers.push((p) => aliveish(p), (p) => !aliveish(p));
    for (const tier of tiers) {
      const found = pool.find(tier);
      if (found) return found;
    }
    return null;
  }
  _passHostNow() {
    const next = this._pickHost(false);
    this.hostId = '';
    if (next) this._setHost(next.id);
  }

  // ------------------------------------------------------------------------------------------------ lobby
  _setOptions(id, options) {
    if (id !== this.hostId) return fail('not_host');
    if (this.phase !== 'lobby') return fail('wrong_phase', 'err.optionsLobbyOnly');
    for (const key of OPTION_KEYS) if (Number.isInteger(options[key])) this.options[key] = options[key];
    return ok();
  }

  _takeSeat(m) {
    if (this.players.length >= MAX_PLAYERS) return fail('room_full', 'err.seatsFull');
    if (this.phase !== 'lobby') return fail('wrong_phase', 'err.seatsLobbyOnly');
    if (m.kind !== 'spectator') return fail('not_allowed', 'err.alreadySeated');
    const s = m.obj;
    this.spectators = this.spectators.filter((x) => x !== s);
    const p = this._newPlayer(s.id, s.name);
    p.connected = s.connected;
    p.disconnectedAt = s.disconnectedAt;
    p.lang = s.lang ?? 'en';
    this.players.push(p);
    this._renumber();
    this._log('info', 'log.seat', { p: this._pref(s) });
    if (!this.hostId) this._setHost(p.id);
    return ok();
  }

  _start(id) {
    if (id !== this.hostId) return fail('not_host');
    if (this.phase !== 'lobby') return fail('wrong_phase', 'err.alreadyStarted');
    const n = this.players.length;
    if (n < this.minPlayers) return fail('not_allowed', 'err.tooFewPlayers', { n: this.minPlayers });
    this._resetTable();
    this.N = n;
    this.kicks = kicksRow(n);
    this.capacity = Math.floor(n / 2);
    // §11 X5: a token dealer's twin when it has one (the same rng calls), else the English draw as a literal token;
    // nothing (or a throw) gives the engine's stand-in, which renders in every language
    this.catastropheTok = this._drawCatastropheTok();
    const cat = renderCatastrophe('en', this.catastropheTok) || {};
    this.catastrophe = { title: str(cat.title, 'Catastrophe'), text: str(cat.text), details: strList(cat.details) };
    this.bunkerTok = this._drawBunkerTok();
    const b = renderBunker('en', this.bunkerTok) || {};
    this.bunker = {
      name: str(b.name, 'The bunker'), size: str(b.size), duration: str(b.duration), food: str(b.food),
      features: strList(b.features),
    };
    // Deal order: for each player in seat order, 8 cards (category order), then 2 specials. §11 X1: the fixed Airlock
    // and revive holders are picked first (seeded rng); such a player's fixed card takes a random one of their 2 slots,
    // and drawSpecial() fills every other slot.
    const fixed = this._fixedHolders();
    for (const p of this.players) {
      p.status = 'alive';
      p.cards = {};
      for (const c of CATEGORY_IDS) {
        const d = this._drawCard(c);
        p.cards[c] = makeCard(d.text, d.tok, false);
      }
      const f = fixed.get(p.id);
      if (f) {
        const slot = this._rand(2);
        const first = slot === 0 ? this._issueSpecial(f) : this._drawSpecial();
        const second = slot === 0 ? this._drawSpecial() : this._issueSpecial(f);
        p.specials = [first, second];
      } else p.specials = [this._drawSpecial(), this._drawSpecial()];
      p.playedSpecials = [];
      p.notes = [];
      p.lastSpecialRound = 0;
    }
    this._log('system', 'log.gameBegins', {
      n, beds: this.capacity, cata: { cata: this.catastropheTok }, bname: { bname: this._bunkerNameTok() },
    });
    this._startReveal(1);
    return ok();
  }

  _safeDraw(fn, fallback) {
    try { return fn(); } catch (e) { this.lastError = e; return fallback; }
  }

  /** true when the dealer has the §11 X5 token twin `name` (picked per method: a test dealer may wrap only some). */
  _hasTok(name) {
    try { return !!this.dealer && typeof this.dealer[name] === 'function'; } catch { return false; }
  }

  /** {text, tok}: the dealt card's English text and its token ('—', a literal, when the dealer has nothing). */
  _drawCard(category) {
    if (this._hasTok('drawCardTok')) {
      const tok = this._safeDraw(() => this.dealer.drawCardTok(category), null);
      if (tok !== null && typeof tok === 'object') {
        const text = str(this._safeDraw(() => renderCard('en', tok), ''), '');
        if (text) return { text, tok };
      }
      return { text: '—', tok: litTok('—') };
    }
    const text = str(this._safeDraw(() => this.dealer.drawCard(category), ''), '') || '—';
    return { text, tok: litTok(text) };
  }

  _drawCatastropheTok() {
    if (this._hasTok('drawCatastropheTok')) {
      const tok = this._safeDraw(() => this.dealer.drawCatastropheTok(), null);
      return tok !== null && typeof tok === 'object' ? tok : FALLBACK_CATASTROPHE_TOK;
    }
    const cat = this._safeDraw(() => this.dealer.drawCatastrophe(), null);
    if (!cat || typeof cat !== 'object') return FALLBACK_CATASTROPHE_TOK;
    return deepFreeze({ lit: { title: str(cat.title, 'Catastrophe'), text: str(cat.text), details: strList(cat.details) } });
  }

  _drawBunkerTok() {
    if (this._hasTok('drawBunkerTok')) {
      const tok = this._safeDraw(() => this.dealer.drawBunkerTok(), null);
      return tok !== null && typeof tok === 'object' ? tok : FALLBACK_BUNKER_TOK;
    }
    const b = this._safeDraw(() => this.dealer.drawBunker(), null);
    if (!b || typeof b !== 'object') return FALLBACK_BUNKER_TOK;
    return deepFreeze({
      lit: { name: str(b.name, 'The bunker'), size: str(b.size), duration: str(b.duration), food: str(b.food), features: strList(b.features) },
    });
  }

  /** The bunker's name as a token of its own (a literal bunker's name is a literal). */
  _bunkerNameTok() {
    const t = this.bunkerTok;
    if (t && typeof t === 'object' && t.lit !== undefined) return litTok(this.bunker ? this.bunker.name : '');
    return t && typeof t === 'object' && t.name && typeof t.name === 'object' ? t.name : FALLBACK_BUNKER_TOK.name;
  }

  /** A bunker feature card's token: the dealer's, or the engine's stand-in "A hidden storeroom" (never dealt). */
  _drawFeatureTok() {
    let tok = null;
    if (this._hasTok('drawBunkerFeatureTok')) {
      tok = this._safeDraw(() => this.dealer.drawBunkerFeatureTok(), null);
      if (tok !== null && typeof tok === 'object' && !str(this._safeDraw(() => renderFeature('en', tok), ''), '')) tok = null;
    } else {
      const text = str(this._safeDraw(() => this.dealer.drawBunkerFeature(), ''));
      tok = text ? litTok(text) : null;
    }
    return tok !== null && typeof tok === 'object' ? tok : FALLBACK_FEATURE_TOK;
  }

  /** A random special from the dealer. With the fixed deal on, an Airlock, revive or `eject` it offers is redrawn. */
  _drawSpecial() {
    let card = null;
    for (let i = 0; i < 20 && !card; i++) {
      try { card = normalizeSpecial(this.dealer.drawSpecial()); } catch { card = null; }
      if (card && this.fixedSpecials && FIXED_ONLY.has(card.effect)) card = null;
    }
    return this._issueSpecial(card || normalizeSpecial(FALLBACK_SPECIAL));
  }

  /** A dealt copy of a normalized card: its own uid, and timing/minRound from the effect table (§7). */
  _issueSpecial(card) {
    const eff = EFFECTS[card.effect];
    return { ...card, uid: `s${++this.uidSeq}`, timing: eff.timing, minRound: eff.minRound ?? 1, used: false };
  }

  /** §11 X1: playerId -> the fixed card they are dealt (AIRLOCKS(N) Airlocks, then REVIVES(N) revives, all distinct). */
  _fixedHolders() {
    const out = new Map();
    if (!this.fixedSpecials) return out;
    const { airlocks, revives } = fixedDeal(this.players.length);
    if (!airlocks && !revives) return out;
    const order = this._shuffle(this.players.map((p) => p.id));
    for (const id of order.slice(0, airlocks)) out.set(id, FIXED_AIRLOCK);
    for (const id of order.slice(airlocks, airlocks + revives)) out.set(id, FIXED_REVIVE);
    return out;
  }

  _playAgain(id) {
    if (id !== this.hostId) return fail('not_host');
    if (this.phase !== 'final') return fail('wrong_phase', 'err.playAgainFinal');
    this._backToLobby();
    return ok();
  }

  /**
   * §11 X6: the host ends the game in any phase but the lobby. A running game (reveal, discussion, vote, defense) is
   * aborted: "The host ended the game" is logged and everyone goes back to the lobby exactly as with Play again. Nothing
   * hidden is revealed (there is no final), open airlocks, votes, turns, timers and vote modifiers are dropped without
   * lines of their own. In the final it is Play again itself (same state, same single line), so an End game whose two
   * taps crossed the last vote still lands.
   */
  _endGame(id) {
    if (id !== this.hostId) return fail('not_host');
    if (this.phase === 'lobby') return fail('wrong_phase', 'err.endGameLobby');
    if (this.phase !== 'final') this._log('system', 'log.endGame');
    this._backToLobby();
    return ok();
  }

  /** Play again and End game (§6, §11 X6): `left` players go, everyone else keeps their seat (renumbered), spectators
   * stay spectators, and the host, options and log are kept. Everything else is reset. */
  _backToLobby() {
    this.players = this.players.filter((p) => p.status !== 'left');
    for (const p of this.players) {
      p.status = 'alive';
      p.cards = null;
      p.specials = [];
      p.playedSpecials = [];
      p.notes = [];
      p.lastSpecialRound = 0;
    }
    this._renumber();
    this._resetTable();
    this._log('system', 'log.backToLobby');
  }

  // ------------------------------------------------------------------------------------------------ leave / kick / host
  _leave(m) {
    this._removeMember(m, 'left');
    return ok();
  }

  _kick(id, targetId) {
    if (id !== this.hostId) return fail('not_host');
    const m = this._member(targetId);
    if (!m || (m.kind === 'player' && m.obj.status === 'left')) return fail('not_allowed', 'err.noSuchPlayer');
    if (targetId === this.hostId) return fail('not_allowed', 'err.kickSelf');
    this._removeMember(m, 'kicked');
    return ok();
  }

  _removeMember(m, how) {
    const x = m.obj;
    const kicked = how === 'kicked';
    const who = { p: this._pref(x) };
    if (m.kind === 'spectator') {
      this.spectators = this.spectators.filter((s) => s !== x);
      this._log('info', kicked ? 'log.specKicked' : 'log.specLeft', who);
      return;
    }
    const wasHost = x.id === this.hostId;
    if (this.phase === 'lobby') {
      this.players = this.players.filter((p) => p !== x);
      this._renumber();
      this._log('info', kicked ? 'log.kicked' : 'log.leftLobby', who);
      if (wasHost) this._passHostNow();
      return;
    }
    const wasAlive = x.status === 'alive';
    x.status = 'left';
    x.connected = false;
    this._dropMods(x.id);
    // "… was removed by the host" (the client's final banner looks for exactly that phrase) or "… left the game".
    this._log('info', kicked ? 'log.kicked' : 'log.leftGame', who);
    // §11 Y1: an airlock on them jams right after that line, before a new host is named. When this ends the game, it
    // jams at the final instead, after "The bunker door closes" (_afterLostAlive → _checkEnd → _enterFinal).
    if (wasAlive && IN_GAME.has(this.phase) && this._aliveCount() > this.capacity) this._jamAirlocks((a) => a.targetId === x.id);
    if (wasHost) this._passHostNow();
    if (wasAlive && IN_GAME.has(this.phase)) this._afterLostAlive(x.id, M('why.gone', who));
  }

  _transferHost(id, targetId) {
    if (id !== this.hostId) return fail('not_host');
    const p = this._player(targetId);
    if (!p || p.status === 'left' || p.id === this.hostId) return fail('not_allowed', 'err.transferTarget');
    this._setHost(p.id, M('host.handover', { p: this._ref(id) }));
    return ok();
  }

  // ------------------------------------------------------------------------------------------------ rounds & turns
  _startReveal(round) {
    this.round = round;
    this.phase = 'reveal';
    this.vote = null;
    this.step = null;
    const order = this._alive().map((p) => p.id);
    if (round % 2 === 0) order.reverse();
    this.turn = { kind: 'reveal', order, index: 0, hasRevealed: false };
    this._log('system', 'log.roundReveal', { r: round, max: MAX_ROUNDS, asc: round % 2 === 1, first: round === 1 });
    this._startTurnTimer();
  }

  _startTurnTimer() {
    const t = this.turn;
    const sp = this._player(this._speakerId());
    const secs = t.kind === 'defense' ? this.options.defenseSeconds : this.round === 1 ? this.options.speechSeconds1 : this.options.speechSeconds;
    this._setTimer(t.kind === 'defense' ? 'timer.defense' : 'timer.turn', { p: { p: sp?.id ?? '', n: sp?.name ?? '' } }, secs);
  }

  _advanceReveal() {
    const t = this.turn;
    t.index++;
    while (t.index < t.order.length && !this._isAlive(t.order[t.index])) t.index++;
    if (t.index >= t.order.length) {
      this._startDiscussion();
      return;
    }
    t.hasRevealed = false;
    this._startTurnTimer();
  }

  _startDiscussion() {
    this.phase = 'discussion';
    this.turn = null;
    this.vote = null;
    this._setTimer(this.overtime ? 'timer.otDiscussion' : 'timer.discussion', {}, this.options.discussionSeconds);
    const k = this._kicksNow();
    const mode = k > 0 ? (this.voteMods.cancelNext ? 'cancelled' : 'vote') : 'none';
    this._log('system', 'log.discussion', { rp: this._rpRef(), mode, k });
  }

  _reveal(id, category, at) {
    if (this.phase !== 'reveal') return fail('wrong_phase', 'err.revealPhase');
    const stale = this._stale(at);
    if (stale) return stale;
    if (this._speakerId() !== id) return fail('not_your_turn');
    const p = this._player(id);
    if (this.turn.hasRevealed) return fail('not_allowed', 'err.alreadyRevealed');
    if (!this._eligible(p).includes(category)) {
      if (this._mustReveal() && category !== this._mustReveal()) return fail('not_allowed', 'err.round1Profession');
      return fail('not_allowed', 'err.cardRevealed');
    }
    this._doReveal(p, category, false);
    return ok();
  }

  _doReveal(p, category, auto) {
    p.cards[category].revealed = true;
    this.turn.hasRevealed = true;
    this._log('reveal', 'log.reveal', { rp: this._rpRef(), p: this._pref(p), cat: { cat: category }, card: { tok: p.cards[category].tok }, auto: !!auto });
  }

  _endTurn(id, at) {
    if (this.phase !== 'reveal' && this.phase !== 'defense') return fail('wrong_phase', 'err.noTurn');
    const stale = this._stale(at);
    if (stale) return stale;
    if (this._speakerId() !== id) return fail('not_your_turn');
    if (this.phase === 'reveal') {
      const p = this._player(id);
      if (!this.turn.hasRevealed && this._eligible(p).length > 0) return fail('not_allowed', 'err.revealFirst');
      this._advanceReveal();
    } else {
      this._advanceDefense();
    }
    return ok();
  }

  _next(id, at) {
    if (id !== this.hostId) return fail('not_host');
    const stale = IN_GAME.has(this.phase) ? this._stale(at) : null;
    if (stale) return stale;
    switch (this.phase) {
      case 'reveal': {
        const sp = this._player(this._speakerId());
        if (sp && !this.turn.hasRevealed) {
          const eligible = this._eligible(sp);
          if (eligible.length) this._doReveal(sp, this._mustReveal() || this._pick(eligible), true);
        }
        this._advanceReveal();
        return ok();
      }
      case 'defense': this._advanceDefense(); return ok();
      case 'discussion': this._afterDiscussion(); return ok();
      case 'vote': this._closeBallot(); return ok();
      default: return fail('wrong_phase', this.phase === 'lobby' ? 'err.useStart' : 'err.usePlayAgain');
    }
  }

  _afterDiscussion() {
    this._jamAirlocks(() => true); // §11 X1: the discussion of their round is over, whether a vote follows or not
    const k = this._kicksNow();
    if (k <= 0) { this._afterStep(); return; }
    if (this.voteMods.cancelNext) {
      const lost = this._expiringMods();
      this._clearMods(true);
      this.lastVoteResult = { stage: 'main', tally: [], ejectedId: null, tie: null, random: false, cancelled: true };
      this._log('vote', 'log.voteSkipped', { rp: this._rpRef(), k, mods: lost });
      this._afterStep();
      return;
    }
    this._startStep(k);
  }

  _afterStep() {
    if (this._checkEnd()) return;
    if (this.round < MAX_ROUNDS) { this._startReveal(this.round + 1); return; }
    if (!this.overtime) {
      this.overtime = true;
      this._log('system', 'log.overtime', { alive: this._aliveCount(), beds: this.capacity });
    }
    this._startDiscussion();
  }

  _checkEnd() {
    if (!IN_GAME.has(this.phase)) return false;
    if (this._aliveCount() > this.capacity) return false;
    this._enterFinal();
    return true;
  }

  _enterFinal() {
    this.phase = 'final';
    this.turn = null;
    this.vote = null;
    this.step = null;
    this.timer = null;
    this._clearMods(true);
    const survivors = this.players.filter((p) => p.status === 'alive').map((p) => p.id);
    const out = this.players.filter((p) => p.status !== 'alive').map((p) => p.id);
    this.final = { survivors, out };
    this._log('system', 'log.doorCloses', { in: this._refs(survivors), out: this._refs(out) });
    // §11 X1: open airlocks jam when the game ends. Logged after the door line, so the line before it stays the
    // move that ended the game (the client's final banner reads it).
    this._jamAirlocks(() => true);
  }

  /** §11 X1: closes every open airlock `pred` selects, each with its "jammed" line. The cards that opened them stay spent. */
  _jamAirlocks(pred) {
    if (!this.airlocks.length) return;
    const gone = this.airlocks.filter(pred);
    if (!gone.length) return;
    this.airlocks = this.airlocks.filter((a) => !gone.includes(a));
    for (const a of gone) this._log('special', 'log.airlockJam', { t: this._ref(a.targetId) });
  }

  /**
   * An alive player stopped being alive outside a ballot result (left, kicked, or ejected by a special).
   * `why` (a nested message: why.gone "with P1 gone") explains a smaller ballot total in the log when this happens
   * during a vote step.
   */
  _afterLostAlive(id, why = null) {
    this._dropMods(id);
    if (this._checkEnd()) return;
    // §11 X1: an airlock on someone who is no longer alive jams at once (one they opened on someone else stays open).
    this._jamAirlocks((a) => a.targetId === id);
    if (this.phase === 'reveal') {
      if (this._speakerId() === id) this._advanceReveal();
    } else if (this.phase === 'defense') {
      // The revote still happens while a tied player remains; only then does the new total hold for this ballot.
      this._refreshBallots(why, (this.step?.tied || []).some((x) => this._isAlive(x)));
      this._removeFromDefense(id);
    } else if (this.phase === 'vote' && this.vote) {
      this._refreshBallots(why, this.vote.candidates.some((x) => this._isAlive(x)));
      this._removeFromBallot(id);
    }
  }

  /**
   * §2 during a running step, after a leave, kick or capacity_plus: `ballots = (ballot − 1) + kicksThisStep`, re-evaluated
   * now instead of only when the next ballot opens. The open ballot (or its defense and revote) still runs to the end
   * (§3), so it always counts as one. When the total drops and this ballot goes on, the log says why; when this ballot
   * is about to end with nobody left in it, the next one (or the end of the step) follows at once and says it all.
   */
  _refreshBallots(why, ballotGoesOn) {
    const s = this.step;
    if (!s || !IN_STEP.has(this.phase)) return;
    const before = s.ballots;
    s.ballots = s.ballot - 1 + Math.max(1, this._kicksNow());
    const fewer = before - s.ballots;
    if (fewer > 0 && ballotGoesOn) {
      const n = s.ballots;
      this._log('vote', 'log.ballotsFewer', { rp: this._rpRef(), why: why || null, fewer, n, before });
    }
  }

  // ------------------------------------------------------------------------------------------------ vote step (§3)
  _startStep(k) {
    this.step = { ballot: 0, ballots: k, tied: null, mainVoters: null, ejected: 0 };
    this._log('vote', 'log.voteStep', { rp: this._rpRef(), k });
    this._openNextBallot();
  }

  _openNextBallot() {
    const k = this._kicksNow();
    if (k <= 0) {
      // Normally the last ballot just ran. If fewer ballots ran than the step still showed, say why it stops here.
      if (this.step && this.step.ballot < this.step.ballots) this._log('vote', 'log.noMoreDue', { rp: this._rpRef() });
      this._endStep();
      return;
    }
    const s = this.step;
    s.ballot += 1;
    s.ballots = s.ballot - 1 + k;
    s.tied = null;
    s.mainVoters = null;
    const alive = this._alive();
    const candidates = alive.filter((p) => !this.voteMods.immune.has(p.id)).map((p) => p.id);
    if (candidates.length === 0) {
      this._log('vote', 'log.allImmune', { rp: this._rpRef() });
      this._cancelStep('main');
      return;
    }
    const voters = alive
      .filter((p) => !this.voteMods.blocked.has(p.id) && candidates.some((c) => c !== p.id))
      .map((p) => p.id);
    this.phase = 'vote';
    this.turn = null;
    this.timer = null;
    this.vote = { stage: 'main', candidates, voters, votes: new Map() };
    this._autoClose();
  }

  _endStep() {
    this._clearMods(false);
    this.step = null;
    this.vote = null;
    this.turn = null;
    this._afterStep();
  }

  _cancelStep(stage) {
    this.lastVoteResult = { stage, tally: [], ejectedId: null, tie: null, random: false, cancelled: true };
    const lost = this._expiringMods();
    // An earlier ballot of this step may already have ejected someone: then only the rest of the vote is off.
    const earlier = this.step && this.step.ejected > 0;
    if (lost) this._log('vote', 'log.stepCancelled', { rp: this._rpRef(), earlier: !!earlier, mods: lost });
    this._clearMods(false);
    this.step = null;
    this.vote = null;
    this.turn = null;
    this._afterStep();
  }

  _vote(id, targetId, at) {
    if (this.phase !== 'vote' || !this.vote) return fail('wrong_phase', 'err.noOpenVote');
    const stale = this._stale(at);
    if (stale) return stale;
    const v = this.vote;
    if (!v.voters.includes(id)) return fail('not_allowed', 'err.notVoter');
    if (targetId === id) return fail('not_allowed', 'err.voteSelf');
    if (!v.candidates.includes(targetId)) return fail('not_allowed', 'err.notCandidate');
    v.votes.set(id, targetId);
    this._autoClose();
    return ok();
  }

  _closeVote(id, at) {
    if (id !== this.hostId) return fail('not_host');
    if (this.phase !== 'vote' || !this.vote) return fail('wrong_phase', 'err.noOpenVote');
    const stale = this._stale(at);
    if (stale) return stale;
    this._closeBallot();
    return ok();
  }

  _autoClose() {
    const v = this.vote;
    if (v && v.voters.every((x) => v.votes.has(x))) this._closeBallot();
  }

  _closeBallot() {
    const v = this.vote;
    const s = this.step;
    const entries = new Map(v.candidates.map((c) => [c, { targetId: c, votes: 0, voterIds: [] }]));
    let total = 0;
    for (const voter of this._bySeat(v.voters)) {
      const target = v.votes.get(voter);
      const e = target !== undefined ? entries.get(target) : undefined;
      if (!e) continue;
      const w = this.voteMods.doubleVote.has(voter) ? 2 : 1;
      e.votes += w;
      e.voterIds.push(voter);
      total += w;
    }
    const tally = [...entries.values()].sort((a, b) => b.votes - a.votes || this._seatOf(a.targetId) - this._seatOf(b.targetId));
    let ejectedId = null;
    let tie = null;
    let random = false;
    let how = 0; // log.eject: 1 nobody voted, 2 still tied (fate decides either way)
    if (total === 0) {
      ejectedId = this._pick(this._bySeat(v.candidates));
      random = true;
      how = 1;
    } else {
      const top = tally[0].votes;
      const tops = tally.filter((e) => e.votes === top).map((e) => e.targetId);
      if (tops.length === 1) ejectedId = tops[0];
      else if (v.stage === 'main') tie = tops;
      else {
        tie = tops;
        ejectedId = this._pick(tops);
        random = true;
        how = 2;
      }
    }
    this.lastVoteResult = {
      stage: v.stage,
      tally: tally.map((e) => ({ targetId: e.targetId, votes: e.votes, voterIds: [...e.voterIds] })),
      ejectedId, tie: tie ? [...tie] : null, random, cancelled: false,
    };
    const counted = new Set(tally.flatMap((e) => e.voterIds));
    const rows = tally.map((e) => ({
      t: this._ref(e.targetId), votes: e.votes,
      voters: e.voterIds.map((x) => ({ p: this._ref(x), x2: this.voteMods.doubleVote.has(x) })),
    }));
    const abstained = this._bySeat(v.voters).filter((x) => !counted.has(x));
    this._log('vote', 'log.tally', {
      rp: this._rpRef(), revote: v.stage === 'revote', ballot: s.ballot, ballots: s.ballots, rows, abstained: this._refs(abstained),
    });
    const mainVoters = v.voters;
    this.vote = null;
    if (tie && !ejectedId) {
      s.tied = this._bySeat(tie);
      s.mainVoters = [...mainVoters];
      this._startDefense(s.tied);
      return;
    }
    this._ejectByVote(ejectedId, how);
  }

  /** `how` (log.eject): 0 by the votes, 1 nobody voted, 2 still tied after the revote. */
  _ejectByVote(id, how = 0) {
    const p = this._player(id);
    p.status = 'ejected';
    if (this.step) this.step.ejected += 1;
    this._dropMods(id);
    this._jamAirlocks((a) => a.targetId === id); // none can be open during a vote step (they jam when it starts)
    this._log('eject', 'log.eject', { p: this._pref(p), how: [1, 2].includes(how) ? how : 0 });
    if (this._checkEnd()) return;
    this._openNextBallot();
  }

  _startDefense(tied) {
    this.phase = 'defense';
    this.turn = { kind: 'defense', order: [...tied], index: 0, hasRevealed: false };
    this._log('vote', 'log.tie', { rp: this._rpRef(), ids: this._refs(tied) });
    this._startTurnTimer();
  }

  _advanceDefense() {
    const t = this.turn;
    t.index++;
    if (t.index >= t.order.length) { this._openRevote(); return; }
    this._startTurnTimer();
  }

  _removeFromDefense(id) {
    const s = this.step;
    const t = this.turn;
    if (s) {
      if (s.mainVoters) s.mainVoters = s.mainVoters.filter((x) => x !== id);
      if (s.tied) s.tied = s.tied.filter((x) => x !== id);
    }
    const i = t.order.indexOf(id);
    if (i < 0) return;
    t.order.splice(i, 1);
    if (i < t.index) t.index--;
    else if (i === t.index) {
      if (t.index >= t.order.length) this._openRevote();
      else this._startTurnTimer();
    }
  }

  _openRevote() {
    const s = this.step;
    this.turn = null;
    this.timer = null;
    this.phase = 'vote';
    const candidates = this._bySeat((s.tied || []).filter((id) => this._isAlive(id)));
    if (candidates.length === 0) {
      this.lastVoteResult = { stage: 'revote', tally: [], ejectedId: null, tie: null, random: false, cancelled: false };
      this._log('vote', 'log.nobodyLeft', { rp: this._rpRef() });
      this._openNextBallot();
      return;
    }
    const voters = this._bySeat((s.mainVoters || []).filter((id) => this._isAlive(id) && candidates.some((c) => c !== id)));
    this.vote = { stage: 'revote', candidates, voters, votes: new Map() };
    this._log('vote', 'log.revote', { rp: this._rpRef(), ids: this._refs(candidates) });
    this._autoClose();
  }

  _removeFromBallot(id) {
    const v = this.vote;
    v.candidates = v.candidates.filter((x) => x !== id);
    v.voters = v.voters.filter((x) => x !== id);
    v.votes.delete(id);
    for (const [voter, target] of [...v.votes]) if (target === id) v.votes.delete(voter);
    // A voter left without a valid target cannot vote any more (§11 amendment): drop them so auto-close still works.
    v.voters = v.voters.filter((x) => v.candidates.some((c) => c !== x));
    for (const voter of [...v.votes.keys()]) if (!v.voters.includes(voter)) v.votes.delete(voter);
    if (v.candidates.length === 0) {
      this.lastVoteResult = { stage: v.stage, tally: [], ejectedId: null, tie: null, random: false, cancelled: false };
      this._log('vote', 'log.nobodyLeft', { rp: this._rpRef() });
      this.vote = null;
      this._openNextBallot();
      return;
    }
    this._autoClose();
  }

  // ------------------------------------------------------------------------------------------------ specials (§5)
  _special(m, msg) {
    if (!IN_GAME.has(this.phase)) return fail('wrong_phase', 'err.specialPhase');
    // §11 R3: a card aimed at a step that has ended (a vote that closed while it was in flight) must not land on the
    // next one: nothing is spent. Whose turn it is does not change what a card does, so `turnIndex` is not compared.
    // §11 Z2: nor does the step from a round's reveal phase into its discussion (an Airlock join confirmed on the last
    // turn stays good): a key naming the reveal counts for the discussion when round and overtime match. A card that
    // crossed into the vote or into the next round is still refused.
    const at = msg.at && msg.at.phase === 'reveal' && this.phase === 'discussion' ? { ...msg.at, phase: 'discussion' } : msg.at;
    const stale = this._stale(at, ['turnIndex']);
    if (stale) return stale;
    if (m.kind !== 'player') return fail('not_allowed', 'err.spectatorSpecial');
    const p = m.obj;
    const card = p.specials.find((s) => s.uid === msg.uid);
    if (!card) return fail('not_allowed', 'err.noCard');
    const eff = EFFECTS[card.effect];
    if (eff.timing === 'before_vote' && !BEFORE_VOTE.has(this.phase)) return fail('wrong_phase', 'err.beforeVoteOnly');
    if (p.status !== 'alive') return fail('not_allowed', 'err.specialAlive');
    if (card.used) return fail('not_allowed', 'err.cardUsed');
    if (p.lastSpecialRound === this.round) return fail('not_allowed', 'err.oneSpecial');
    if (this.round < card.minRound) return fail('not_allowed', 'err.fromRound', { n: card.minRound });
    const inStep = IN_STEP.has(this.phase);
    if (card.effect === 'cancel_vote' && !inStep && this.voteMods.cancelNext) return fail('not_allowed', 'err.cancelledAlready');
    // §11 Z3: a ×2 needs a vote to double. A blocked player has none in this or the next vote step (the block lasts the
    // whole step), and nor does anyone who is not a voter of the open ballot (they stay out for the rest of the step).
    if (card.effect === 'double_vote') {
      if (this.voteMods.blocked.has(p.id)) return fail('not_allowed', 'err.doubleBlocked', { now: inStep });
      if (this.phase === 'vote' && this.vote && !this.vote.voters.includes(p.id)) return fail('not_allowed', 'err.doubleNotVoter');
    }

    let target = null;
    if (card.target === 'self') target = p;
    else if (card.target === 'other') {
      target = this._player(msg.targetId);
      if (!target || target === p || target.status !== 'alive') return fail('not_allowed', 'err.pickAlive');
      if (eff.category === 'hidden' && this._hidden(target).length === 0) return fail('not_allowed', 'err.noHidden');
    } else if (card.target === 'ejected') {
      target = this._player(msg.targetId);
      if (!target || target.status !== 'ejected') return fail('not_allowed', 'err.pickEjected');
    }
    // §11 X1: the airlock needs a *different* second player (unreachable while one special per round holds: kept as a guard)
    if (card.effect === 'airlock' && this.airlocks.some((a) => a.targetId === target.id && a.byIds.includes(p.id))) {
      return fail('not_allowed', 'err.ownAirlock', { t: this._pref(target) });
    }

    let category = null;
    if (eff.category) {
      if (card.category === 'choose') {
        if (!IS_CATEGORY(msg.category)) return fail('not_allowed', 'err.pickCategory');
        if (eff.category === 'hidden' && !this._hidden(target).includes(msg.category)) return fail('not_allowed', 'err.notHidden');
        category = msg.category;
      } else if (card.category === 'random') {
        category = this._pick(this._hidden(target));
      } else {
        category = card.category;
      }
    }

    card.used = true;
    p.lastSpecialRound = this.round;
    p.playedSpecials.push(this._playedCopy(card));
    const after = this._applyEffect(p, card, target, category, inStep);
    return after ?? ok();
  }

  /** A played special as players[].playedSpecials keeps it: its words plus its content id and catalogue ref. */
  _playedCopy(card) {
    const out = { id: card.id, ref: card.ref ?? null, title: card.title, text: card.text };
    if (card.untitled) out.untitled = true;
    return out;
  }

  /** A special card as a message param ({sp}): its ids and its English words (a literal card shows those). */
  _spParam(card) {
    const sp = { id: card.id, ref: card.ref ?? null, title: card.title, text: card.text };
    if (card.untitled) sp.untitled = true;
    return { sp };
  }

  /** log.special: `result` is the nested res.* message. */
  _specialLog(p, card, key, params = {}) {
    this._log('special', 'log.special', { rp: this._rpRef(), p: this._pref(p), card: this._spParam(card), result: M(key, params) });
  }

  _applyEffect(p, card, target, category, inStep) {
    const cat = category ? { cat: category } : null;
    switch (card.effect) {
      case 'swap_card': {
        const a = p.cards[category];
        const b = target.cards[category];
        [a.text, b.text] = [b.text, a.text];
        [a.tok, b.tok] = [b.tok, a.tok];
        a.revealed = true;
        b.revealed = true;
        this._specialLog(p, card, 'res.swap', { a: this._pref(p), b: this._pref(target), cat, ca: { tok: a.tok }, cb: { tok: b.tok } });
        return null;
      }
      case 'reroll_card': {
        const d = this._drawCard(category);
        target.cards[category] = makeCard(d.text, d.tok, true);
        this._specialLog(p, card, 'res.reroll', { t: this._pref(target), cat, c: { tok: d.tok } });
        return null;
      }
      case 'force_reveal': {
        target.cards[category].revealed = true;
        this._specialLog(p, card, 'res.force', { t: this._pref(target), cat, c: { tok: target.cards[category].tok } });
        return null;
      }
      case 'peek': {
        // the note keeps the token as it is now: a later swap or reroll does not change what was seen
        const np = deepFreeze({ rp: this._rpRef(), t: this._pref(target), cat, c: { tok: target.cards[category].tok } });
        p.notes.push({ ts: this._time(), text: renderText('en', 'note.peek', np), key: 'note.peek', params: np });
        this._specialLog(p, card, 'res.peek', { p: this._pref(p), t: this._pref(target) });
        return null;
      }
      case 'mass_reveal': {
        const alive = this._alive();
        for (const x of alive) x.cards[category].revealed = true;
        this._specialLog(p, card, 'res.mass', { cat, rows: alive.map((x) => ({ p: this._pref(x), c: { tok: x.cards[category].tok } })) });
        return null;
      }
      case 'shuffle_category': {
        const alive = this._alive();
        // the same rng draws as before X5: one shuffle of an array as long as the alive list
        const dealt = this._shuffle(alive.map((x) => ({ text: x.cards[category].text, tok: x.cards[category].tok })));
        alive.forEach((x, i) => { x.cards[category] = makeCard(dealt[i].text, dealt[i].tok, true); });
        this._specialLog(p, card, 'res.shuffle', { cat, rows: alive.map((x) => ({ p: this._pref(x), c: { tok: x.cards[category].tok } })) });
        return null;
      }
      case 'immunity':
      case 'protect': {
        this.voteMods.immune.add(target.id);
        this._specialLog(p, card, 'res.protect', { t: this._pref(target) });
        return null;
      }
      case 'double_vote': {
        this.voteMods.doubleVote.add(p.id);
        this._specialLog(p, card, 'res.double', { p: this._pref(p), now: !!inStep });
        return null;
      }
      case 'block_vote': {
        this.voteMods.blocked.add(target.id);
        this._specialLog(p, card, 'res.block', { t: this._pref(target) });
        return null;
      }
      case 'cancel_vote': {
        if (inStep) {
          const stage = this.phase === 'vote' && this.vote ? this.vote.stage : 'main';
          this._specialLog(p, card, this.step && this.step.ejected > 0 ? 'res.cancelRest' : 'res.cancelNow');
          this._cancelStep(stage);
        } else {
          this.voteMods.cancelNext = true;
          this._specialLog(p, card, 'res.cancelNext');
        }
        return null;
      }
      case 'eject': {
        target.status = 'ejected';
        this._specialLog(p, card, 'res.eject', { t: this._pref(target) });
        this._afterLostAlive(target.id);
        return null;
      }
      case 'airlock': {
        // §11 X1. Airlocks only exist during the reveal and discussion of their round, so an open one is this round's.
        const open = this.airlocks.find((a) => a.targetId === target.id && a.round === this.round && !a.byIds.includes(p.id));
        if (open) {
          this.airlocks = this.airlocks.filter((a) => a !== open);
          target.status = 'ejected';
          this._log('eject', 'log.airlockSeal', { a: this._pref(p), by: this._refs(open.byIds), t: this._pref(target) });
          this._afterLostAlive(target.id);
        } else {
          this.airlocks.push({ targetId: target.id, byIds: [p.id], round: this.round });
          // §11 Z5: "before the overtime discussion ends" in overtime
          this._log('special', 'log.airlockStart', { a: this._pref(p), t: this._pref(target), ot: this.overtime });
        }
        return null;
      }
      case 'revive': {
        target.status = 'alive';
        // §1: a player still ahead in this phase's order (alive when it started) speaks this round; anyone else waits
        // for the next reveal phase, and after round 7 there is none (overtime has no reveals).
        let when = 0; // res.revive: 1 still gets a turn this round, 2 from the next round on
        if (this.phase === 'reveal') {
          if (this.turn.order.indexOf(target.id) > this.turn.index) when = 1;
          else if (this.round < MAX_ROUNDS) when = 2;
        }
        this._specialLog(p, card, 'res.revive', { t: this._pref(target), when });
        return null;
      }
      case 'capacity_plus': {
        this.capacity += 1;
        this._specialLog(p, card, 'res.beds', { n: this.capacity });
        if (!this._checkEnd()) this._refreshBallots(M('why.bed'), true);
        return null;
      }
      case 'capacity_minus': {
        const before = this.capacity;
        this.capacity = Math.max(1, this.capacity - 1);
        this._specialLog(p, card, before === this.capacity ? 'res.bedsMin' : 'res.beds', { n: this.capacity });
        this._checkEnd();
        return null;
      }
      case 'bunker_add_feature': {
        const ftok = this._drawFeatureTok();
        const f = str(this._safeDraw(() => renderFeature('en', ftok), '')) || 'A hidden storeroom';
        this.bunker.features.push(f);
        this.bunkerTok = bunkerWithFeature(this.bunkerTok, ftok);
        this._specialLog(p, card, 'res.feature', { f: { feat: ftok } });
        return null;
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------------------------------------ views (§7)
  /**
   * The StateView of member `id` (§7), every human-readable string in `lang` (§11 X5.2): the member's language by
   * default ('en' when unset). null for a non-member or a player who left.
   */
  view(id, lang) {
    try {
      return this._view(id, lang);
    } catch (e) {
      if (e && e.missingTok) throw e; // NODE_ENV=test: a card without its token is a bug to fail on (design §3.1)
      this.lastError = e;
      return null;
    }
  }

  /** A card's text in `lang` (English: the text stored when it was dealt). */
  _cardText(card, lang) {
    if (!card.tok || typeof card.tok !== 'object') {
      missingTok();
      return card.text;
    }
    return lang === 'en' ? card.text : renderCard(lang, card.tok);
  }

  /** {title, text} of a special in `lang`: the catalogue's words for a catalogue card, else its own. */
  _specialWords(s, lang) {
    if (lang !== 'en') {
      if (s.ref) {
        const r = renderSpecial(lang, s.ref);
        if (r) return r;
      } else if (s.untitled) return { title: renderText(lang, 'special.untitled'), text: s.text };
    }
    return { title: s.title, text: s.text };
  }

  _specialView(s, lang) {
    const w = this._specialWords(s, lang);
    return { id: s.id, title: w.title, text: w.text };
  }

  /** The view's log in `lang`: one frozen array per language, shared by every recipient until the log changes. */
  _logView(lang) {
    const log = this.log;
    const version = `${log.length ? log[0].id : 0}:${log.length ? log[log.length - 1].id : 0}:${log.length}`;
    if (this._logVersion !== version) {
      this._logVersion = version;
      this._logViews = {};
    }
    let out = this._logViews[lang];
    if (!out) {
      out = Object.freeze(log.slice(-LOG_LIMIT).map((e) => entryView(e, lang)));
      this._logViews[lang] = out;
    }
    return out;
  }

  _publicPlayer(p, lang) {
    const final = this.phase === 'final';
    const cards = {};
    for (const c of CATEGORY_IDS) cards[c] = p.cards && (final || p.cards[c].revealed) ? this._cardText(p.cards[c], lang) : null;
    const out = {
      id: p.id, name: p.name, seat: p.seat, connected: !!p.connected, isHost: p.id === this.hostId,
      status: this.phase === 'lobby' ? 'alive' : p.status,
      cards,
      revealedCount: p.cards ? CATEGORY_IDS.filter((c) => p.cards[c].revealed).length : 0,
      playedSpecials: p.playedSpecials.map((s) => this._specialView(s, lang)),
      specialsLeft: p.specials.filter((s) => !s.used).length,
    };
    if (final) out.unplayedSpecials = p.specials.filter((s) => !s.used).map((s) => this._specialView(s, lang));
    return out;
  }

  _catastropheView(lang) {
    if (!this.catastrophe) return null;
    const tok = this.catastropheTok;
    const id = tok && typeof tok === 'object' && typeof tok.id === 'string' ? tok.id : null;
    const r = lang !== 'en' && tok ? renderCatastrophe(lang, tok) : null;
    const src = r || this.catastrophe;
    return { id, title: src.title, text: src.text, details: [...src.details] };
  }

  _bunkerView(lang) {
    if (!this.bunker) return null;
    const r = lang !== 'en' && this.bunkerTok ? renderBunker(lang, this.bunkerTok) : null;
    const src = r || this.bunker;
    return { name: src.name, size: src.size, duration: src.duration, food: src.food, features: [...src.features] };
  }

  _view(id, lang) {
    const m = this._member(id);
    if (!m || (m.kind === 'player' && m.obj.status === 'left')) return null;
    const L = normLang(lang) ?? normLang(m.obj.lang) ?? 'en';
    const phase = this.phase;
    const inGame = phase !== 'lobby';
    const t = this.turn;
    const v = this.vote;
    const s = this.step;
    const seated = this.players.length;
    let kicksThisStep = 0;
    if (IN_STEP.has(phase) && s) kicksThisStep = s.ballots;
    else if (IN_GAME.has(phase)) kicksThisStep = this._kicksNow();

    let me = null;
    if (m.kind === 'player' && inGame && m.obj.cards) {
      const p = m.obj;
      const cards = {};
      for (const c of CATEGORY_IDS) cards[c] = { text: this._cardText(p.cards[c], L), revealed: p.cards[c].revealed };
      me = {
        cards,
        specials: p.specials.map((c) => {
          const w = this._specialWords(c, L);
          return {
            uid: c.uid, id: c.id, title: w.title, text: w.text, effect: c.effect, target: c.target,
            category: c.category ?? null, timing: c.timing, minRound: c.minRound, used: c.used,
          };
        }),
        canPlaySpecial: p.status === 'alive' && p.lastSpecialRound !== this.round && IN_GAME.has(phase),
        notes: p.notes.map((n) => ({ ts: n.ts, text: L === 'en' || !n.key ? n.text : renderText(L, n.key, n.params) })),
        myVote: phase === 'vote' && v ? v.votes.get(p.id) ?? null : null,
      };
    }

    const timer = this.timer && (phase === 'reveal' || phase === 'defense' || phase === 'discussion')
      ? { label: L === 'en' || !this.timer.key ? this.timer.label : renderText(L, this.timer.key, this.timer.params), endsAt: this.timer.endsAt }
      : null;

    return {
      serverNow: this._time(),
      room: this.room,
      you: { id, name: m.obj.name, role: m.kind, isHost: id === this.hostId, lang: L },
      hostId: this.hostId,
      phase,
      round: this.round,
      maxRounds: MAX_ROUNDS,
      overtime: this.overtime,
      minPlayers: this.minPlayers,
      maxPlayers: MAX_PLAYERS,
      options: { ...this.options },
      categories: CATEGORY_LIST.map((c) => ({ id: c.id, label: L === 'en' ? c.label : categoryLabel(L, c.id) })),
      catastrophe: this._catastropheView(L),
      bunker: this._bunkerView(L),
      capacity: this.capacity,
      players: this.players.map((p) => this._publicPlayer(p, L)),
      spectators: this.spectators.map((x) => ({ id: x.id, name: x.name, connected: !!x.connected })),
      me,
      turn: t && (phase === 'reveal' || phase === 'defense')
        ? {
          kind: t.kind, speakerId: t.order[t.index] ?? '', order: [...t.order], index: t.index,
          mustReveal: t.kind === 'reveal' ? this._mustReveal() : null,
          hasRevealed: t.kind === 'reveal' ? t.hasRevealed : false,
        }
        : null,
      vote: phase === 'vote' && v && s
        ? {
          stage: v.stage, ballot: s.ballot, ballots: s.ballots, candidates: [...v.candidates], voters: [...v.voters],
          voted: v.voters.filter((x) => v.votes.has(x)),
        }
        : null,
      schedule: {
        kicksByRound: inGame ? [...this.kicks] : seated >= 2 ? kicksRow(seated) : [],
        outCount: this._outCount(),
        kicksThisStep,
        nextVoteRound: this._nextVoteRound(),
      },
      voteMods: {
        immune: this._bySeat([...this.voteMods.immune]),
        blocked: this._bySeat([...this.voteMods.blocked]),
        doubleVote: this._bySeat([...this.voteMods.doubleVote]),
        cancelNext: this.voteMods.cancelNext,
      },
      airlocks: this.airlocks.map((a) => ({ targetId: a.targetId, byIds: [...a.byIds], round: a.round })),
      timer,
      lastVoteResult: this.lastVoteResult
        ? {
          ...this.lastVoteResult,
          tally: this.lastVoteResult.tally.map((e) => ({ ...e, voterIds: [...e.voterIds] })),
          tie: this.lastVoteResult.tie ? [...this.lastVoteResult.tie] : null,
        }
        : null,
      log: this._logView(L),
      final: this.final ? { survivors: [...this.final.survivors], out: [...this.final.out] } : null,
    };
  }

  _nextVoteRound() {
    const phase = this.phase;
    if (!IN_GAME.has(phase)) return null;
    if (IN_STEP.has(phase)) return this.round;
    if (this.overtime) return this._kicksNow() > 0 ? MAX_ROUNDS : null;
    for (let r = this.round; r <= MAX_ROUNDS; r++) if (this._kicksAt(r) > 0) return r;
    return null;
  }
}
