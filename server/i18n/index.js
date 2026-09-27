// server/i18n/index.js — server messages in every language (SPEC §11 X5.3–X5.5; reports/i18n-design.md §3.5–§3.8, §4,
// §5, §7, §8).
//
//   renderMsg(lang, key, params)  -> {text, parts}   a log line, note, timer label or error in `lang`
//   renderText(lang, key, params) -> string          the same, text only
//   renderValue(lang, value, params) -> {text, parts}  a candidate template or function, as if it were an entry
//   LANGS, normLang(x), categoryLabel(lang, id), SCHEMA, KEYS, hasKey(key), isDevKey(key), setWarn(fn), traceKeys(fn)
//
// `params` hold language-neutral values (report §3.5), never rendered text:
//   {p: id, n: name}            a player or spectator (n = the name when the line was logged) -> a `player` part
//   [ref, ref, …]               a list, joined ', ' (@and: "A, B and C"); an empty list prints `word.nobody`
//   {cat: id}                   a category -> a `cat` part (its label; a case form with @acc, @gen, …)
//   {tok: CardTok}              a characteristic card -> a `value` part
//   {feat: FeatureTok}          a bunker feature -> a `value` part
//   {sp: {id, ref, title, text}} a special card -> a `card` part (quoted title, `fmt.quote`); also `{cardtext}`
//   {cata: CatTok}              a catastrophe -> its title
//   {bname: BunkerNameTok}      a bunker's name
//   {r, ot}                     the round prefix -> a `prefix` part ('Round 3 — '); @bare: 'Round 3', plain text
//   {msg: {key, params}}        a nested message, rendered in place; null for a missing optional one
//   numbers, booleans, strings  as they are (strings are printed verbatim, never parsed)
// A token {lit: 'text'} (hand-made test dealers, report §3.3) renders as that text in every language.
//
// Content renderers (renderCard, renderSpecial, renderFeature, renderCatastrophe, renderBunkerName, categoryForms)
// come from server/content.js once it has them (i18n-content, B2); until then only English and literal tokens render.
//
// Templates go through the shared formatter public/i18n/core.js (report §7), the same one content and the client use.
// A function value gets `f`: core's helpers() plus t, k, join and list for pieces of a log line (see en.js).

import * as content from '../content.js';
import * as core from '../../public/i18n/core.js';
import * as enModule from './en.js';
import * as ruModule from './ru.js';

export const LANGS = core.LANGS;
/** 'en' | 'ru' for a supported language, otherwise null. */
export const normLang = core.normLang;

const EN = enModule.default;
const CATALOGUES = { en: EN, ru: ruModule.default && typeof ruModule.default === 'object' ? ruModule.default : {} };

/** Every message key (the English catalogue's keys, in its order). */
export const KEYS = Object.freeze(Object.keys(EN));
export function hasKey(key) { return typeof key === 'string' && Object.hasOwn(EN, key); }
/** Keys that only a dev server (BUNKER_DEV=1, §11 X9) produces; their tools are English-only. */
export function isDevKey(key) { return typeof key === 'string' && (key.startsWith('log.dev.') || key.startsWith('err.dev.')); }

// ---------------------------------------------------------------------------------------------------------------
// Warnings: once per distinct problem, never a throw (the engine must not break over a message).

let warnFn = (m) => console.warn(`[i18n] ${m}`);
const warned = new Set();
function warnOnce(id, message) {
  if (warned.has(id)) return;
  if (warned.size < 10000) warned.add(id);
  try { if (warnFn) warnFn(message); } catch { /* ignore */ }
}
/** Replaces the warning sink (tests and tools); null silences it. */
export function setWarn(fn) { warnFn = typeof fn === 'function' ? fn : null; }

// ---------------------------------------------------------------------------------------------------------------
// Formatting

/** What a function value's helpers return: rendered parts, usable as a result or as a param value. */
class Rendered {
  constructor(parts) { this.parts = parts; Object.freeze(this); }
  toString() { return textOf(this.parts); }
}

// Derived and special param values (report §4: {airlock}; §8.1: cardtext; empty lists print word.nobody).
const EMPTY = Object.freeze({ i18n: 'empty' });
const NOBODY = Object.freeze({ i18n: 'nobody' });
const AIRLOCK = Object.freeze({ i18n: 'airlock' });

/** A param value as a template sees it: null prints nothing, an empty list prints word.nobody. */
function prepValue(v) {
  if (v === null || v === undefined) return EMPTY;
  return Array.isArray(v) && v.length === 0 ? NOBODY : v;
}

/** The params a template sees: prepValue on each, plus the derived {airlock} and {cardtext}. */
function prep(params) {
  const p = { airlock: AIRLOCK };
  if (params && typeof params === 'object') for (const [k, v] of Object.entries(params)) p[k] = prepValue(v);
  if (!Object.hasOwn(p, 'cardtext')) {
    const c = p.card;
    p.cardtext = c && typeof c === 'object' && c.sp && typeof c.sp === 'object' ? { cardtext: c.sp } : EMPTY;
  }
  return p;
}

const namesCache = new Map();
/** core.format, reporting through warnOnce a placeholder the params lack (core itself prints "{name}"). */
function formatParts(lang, template, p, hook) {
  const tpl = String(template);
  let names = namesCache.get(tpl);
  if (!names) {
    names = [...new Set(core.placeholders(tpl).map((x) => x.name))];
    if (namesCache.size > 5000) namesCache.clear();
    namesCache.set(tpl, names);
  }
  for (const name of names) if (!Object.hasOwn(p, name)) warnOnce(`param:${name}:${tpl}`, `unknown param {${name}} in "${tpl}"`);
  return core.format(lang, tpl, p, hook);
}

/** One value (a ref, a piece, a string, a list…) rendered on its own. */
function itemParts(lang, x, hook) {
  return core.format(lang, '{x}', { x: prepValue(x) }, hook);
}

function joinPieces(items, sep) {
  const out = [];
  items.forEach((it, i) => {
    if (i > 0 && sep) out.push(sep);
    out.push(...it);
  });
  return out;
}

/** Flattens a function's result or a part list into parts: no empty strings, no two strings in a row. */
function normalize(x, out = []) {
  if (x === null || x === undefined || x === false) return out;
  if (typeof x === 'string') {
    if (!x) return out;
    if (typeof out[out.length - 1] === 'string') out[out.length - 1] += x;
    else out.push(x);
    return out;
  }
  if (x instanceof Rendered) { for (const y of x.parts) normalize(y, out); return out; }
  if (Array.isArray(x)) { for (const y of x) normalize(y, out); return out; }
  if (typeof x === 'object' && typeof x.t === 'string') { out.push(x); return out; }
  return normalize(String(x), out);
}

function textOf(parts) {
  let s = '';
  for (const x of parts) s += typeof x === 'string' ? x : x.v;
  return s;
}

function cap(lang, s) {
  if (typeof s !== 'string' || !s) return s;
  const first = String.fromCodePoint(s.codePointAt(0));
  return first.toLocaleUpperCase(lang) + s.slice(first.length);
}

// ---------------------------------------------------------------------------------------------------------------
// Content (i18n-content's façade when present; English and literal tokens otherwise)

const SPEC_LABELS = {
  profession: 'Profession', biology: 'Biology', health: 'Health', hobby: 'Hobby',
  phobia: 'Phobia', skill: 'Extra skill', trait: 'Personality', baggage: 'Baggage',
};

function englishLabel(id) {
  try {
    const found = Array.isArray(content.CATEGORIES) ? content.CATEGORIES.find((c) => c && c.id === id) : null;
    if (found && typeof found.label === 'string' && found.label) return found.label;
  } catch { /* fall through */ }
  return SPEC_LABELS[id] ?? String(id);
}

function catForms(lang, id) {
  if (typeof content.categoryForms === 'function') {
    try {
      const f = content.categoryForms(lang, id);
      if (f && typeof f.label === 'string') return f;
    } catch (e) { warnOnce(`catForms:${lang}:${id}`, `categoryForms(${lang}, ${id}) failed: ${e?.message}`); }
  }
  return { label: englishLabel(id) };
}

/** A category's label in `lang` ('Extra skill'). */
export function categoryLabel(lang, id) {
  return catForms(normLang(lang) ?? 'en', id).label;
}

function viaContent(fnName, lang, tok, pick) {
  if (tok && typeof tok === 'object' && typeof tok.lit === 'string') return tok.lit;
  const fn = content[fnName];
  if (typeof fn === 'function') {
    try {
      const r = fn(lang, tok);
      const s = pick ? pick(r) : r;
      if (typeof s === 'string') return s;
    } catch (e) { warnOnce(`${fnName}:${lang}`, `${fnName}(${lang}) failed: ${e?.message}`); }
  } else warnOnce(`${fnName}:missing`, `server/content.js has no ${fnName} yet`);
  return '?';
}

/**
 * {title, text} of a special in `lang`: the catalogue's words for a catalogue card (ref), else its own (literal). A
 * card that had no title (`untitled`, the engine's `special.untitled`) gets that key's words in `lang`.
 */
function specialWords(lang, sp) {
  if (lang !== 'en' && sp.ref && typeof content.renderSpecial === 'function') {
    try {
      const r = content.renderSpecial(lang, sp.ref);
      if (r && typeof r.title === 'string') return { title: r.title, text: typeof r.text === 'string' ? r.text : '' };
    } catch (e) { warnOnce(`renderSpecial:${lang}:${sp.ref}`, `renderSpecial(${lang}, ${sp.ref}) failed: ${e?.message}`); }
  }
  const text = sp.text == null ? '' : String(sp.text);
  if (lang !== 'en' && !sp.ref && sp.untitled === true) return { title: textOf(parts(lang, 'special.untitled', {}, 1)), text };
  return { title: sp.title == null ? '' : String(sp.title), text };
}

function airlockCard() {
  const c = content.AIRLOCK_CARD;
  return { id: 'airlock', ref: 'airlock', title: typeof c?.title === 'string' ? c.title : 'Airlock', text: typeof c?.text === 'string' ? c.text : '' };
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

let tracer = null;
const MAX_DEPTH = 8;

function lookup(lang, key) {
  const cat = CATALOGUES[lang];
  if (cat && Object.hasOwn(cat, key)) return { lang, value: cat[key] };
  if (!Object.hasOwn(EN, key)) return null;
  // dev keys (§11 X9: English-only tools) may stay English without a warning
  if (lang !== 'en' && !isDevKey(key)) warnOnce(`missing:${lang}:${key}`, `no ${lang} text for ${key}: English is used`);
  return { lang: 'en', value: EN[key] };
}

function hookFor(lang, depth) {
  return function hook(v, form) {
    if (v instanceof Rendered) return v.parts;
    if (v === EMPTY) return [];
    if (v === NOBODY) return parts(lang, 'word.nobody', {}, depth + 1);
    if (v === AIRLOCK) {
      const word = textOf(parts(lang, 'word.airlock', {}, depth + 1));
      const shown = form === 'cap' ? cap(lang, word) : word;
      const w = specialWords(lang, airlockCard());
      return [{ t: 'card', id: 'airlock', v: shown, label: shown, title: w.title, text: w.text }];
    }
    if (typeof v.p === 'string' && Object.hasOwn(v, 'n')) return [{ t: 'player', id: v.p, v: v.n == null ? '' : String(v.n) }];
    if (Object.hasOwn(v, 'cat')) {
      const f = catForms(lang, v.cat);
      return [{ t: 'cat', id: String(v.cat), v: (form && typeof f[form] === 'string' ? f[form] : f.label) }];
    }
    if (Object.hasOwn(v, 'tok')) return [{ t: 'value', v: withCap(lang, viaContent('renderCard', lang, v.tok), form) }];
    if (Object.hasOwn(v, 'feat')) return [{ t: 'value', v: withCap(lang, viaContent('renderFeature', lang, v.feat), form) }];
    if (Object.hasOwn(v, 'sp') && v.sp && typeof v.sp === 'object') {
      const w = specialWords(lang, v.sp);
      const quoted = textOf(parts(lang, 'fmt.quote', { title: w.title }, depth + 1));
      return [{ t: 'card', id: String(v.sp.id ?? v.sp.ref ?? ''), v: quoted, label: w.title, title: w.title, text: w.text }];
    }
    if (Object.hasOwn(v, 'cardtext')) {
      const w = v.cardtext && typeof v.cardtext === 'object' ? specialWords(lang, v.cardtext) : { text: '' };
      return w.text ? [{ t: 'cardtext', v: `: ${w.text}` }] : [];
    }
    if (Object.hasOwn(v, 'cata')) return [withCap(lang, viaContent('renderCatastrophe', lang, v.cata, (r) => r?.title), form)];
    if (Object.hasOwn(v, 'bname')) return [withCap(lang, viaContent('renderBunkerName', lang, v.bname), form)];
    if (Object.hasOwn(v, 'msg')) return v.msg && typeof v.msg === 'object' ? parts(lang, v.msg.key, v.msg.params, depth + 1) : [];
    if (Object.hasOwn(v, 'r') && Object.hasOwn(v, 'ot')) {
      const bare = form === 'bare';
      const key = v.ot ? (bare ? 'rp.otBare' : 'rp.ot') : (bare ? 'rp.bare' : 'rp');
      const s = textOf(parts(lang, key, { r: v.r }, depth + 1));
      return bare ? [s] : [{ t: 'prefix', v: s }];
    }
    warnOnce(`value:${Object.keys(v).join(',')}`, `cannot render a param value with keys ${Object.keys(v).join(', ')}`);
    return ['?'];
  };
}

function withCap(lang, s, form) { return form === 'cap' ? cap(lang, s) : s; }

const asList = (items) => (Array.isArray(items) ? items : []);

/** `f` for a function value: core.helpers() with this catalogue's hook and params, plus t, k, join and list. */
function helpers(lang, p, depth) {
  const hook = hookFor(lang, depth);
  const fmt = (tpl, params) => normalize(formatParts(lang, tpl, prep(params === undefined ? p : params), hook));
  return Object.freeze({
    ...core.helpers(lang, hook),
    format: (tpl, params) => fmt(tpl, params),
    text: (tpl, params) => textOf(fmt(tpl, params)),
    t: (tpl, params) => new Rendered(fmt(tpl, params)),
    k: (key, params = p) => new Rendered(parts(lang, key, params, depth + 1)),
    join: (items, sep = ', ') => new Rendered(normalize(joinPieces(asList(items).map((x) => itemParts(lang, x, hook)), String(sep)))),
    list: (items, style) => new Rendered(normalize(core.list(lang, asList(items).map((x) => itemParts(lang, x, hook)), style))),
  });
}

/** A catalogue value (template or function) in `lang` -> normalized parts. May throw (a function's own error). */
function valueParts(lang, value, params, depth) {
  const p = params && typeof params === 'object' ? params : {};
  if (typeof value === 'function') return normalize(value(p, helpers(lang, p, depth)));
  return normalize(formatParts(lang, value, prep(p), hookFor(lang, depth)));
}

/** The normalized parts of `key` in `lang` (falls back to English, never throws). */
function parts(lang, key, params, depth) {
  if (tracer) tracer.add(key);
  if (depth > MAX_DEPTH) { warnOnce(`depth:${key}`, `messages nested too deep at ${key}`); return [String(key)]; }
  const found = lookup(lang, key);
  if (!found) { warnOnce(`unknown:${key}`, `unknown message key ${key}`); return [String(key)]; }
  try {
    return valueParts(found.lang, found.value, params, depth);
  } catch (e) {
    warnOnce(`throw:${found.lang}:${key}`, `rendering ${key} in ${found.lang} failed: ${e?.message}`);
    if (found.lang !== 'en') return parts('en', key, params, depth);
    return [String(key)];
  }
}

/**
 * A candidate catalogue value (a template or a (p, f) function) rendered in `lang` as if it were an entry: {text,
 * parts}. For translators and the catalogue checker trying a value before it is in ru.js. Throws what the value throws.
 */
export function renderValue(lang, value, params = {}) {
  const p = valueParts(normLang(lang) ?? 'en', value, params, 0);
  return { text: textOf(p), parts: p };
}

/** A message in `lang` ('en' when not supported): {text, parts} (report §8.1: text === the parts joined). */
export function renderMsg(lang, key, params = {}) {
  const p = parts(normLang(lang) ?? 'en', key, params, 0);
  return { text: textOf(p), parts: p };
}

/** A message's text in `lang`. */
export function renderText(lang, key, params = {}) {
  return textOf(parts(normLang(lang) ?? 'en', key, params, 0));
}

/** Tests: runs fn and returns the set of keys rendered meanwhile (nested ones and fragments included). */
export function traceKeys(fn) {
  const prev = tracer;
  const set = new Set();
  tracer = set;
  try { fn(); } finally { tracer = prev; }
  return set;
}

// ---------------------------------------------------------------------------------------------------------------
// SCHEMA: every key, its log kind (log lines only) and its params (frozen at A1, grows only).
//
// Param types:
//   'player'          {p: id, n: name}                       'player[]'  a list of them (empty -> word.nobody)
//   'cat'             {cat: CategoryId}                      'card'      {tok: CardTok}      'feat'  {feat: FeatureTok}
//   'special'         {sp: {id, ref, title, text}}           'cata'      {cata: CatTok}      'bname' {bname: BunkerNameTok}
//   'rp'              {r: round, ot: overtime}
//   'num'  'bool'     a number, a boolean
//   'enum:a|b'        one of these strings                   'int:0|1|2' one of these integers
//   'msg:k1|k2'       {msg: {key, params}} with key k1 or k2; 'msg?:…' may also be null; 'msg[]:…' a list of them
//   'id:v1|v2'        a protocol identifier, one of these real (Latin) values; keep it out of Russian text
//   'text'            a raw string, printed as it is (a seed, a title)
//   [{…}]             a list of objects with these fields (only in keys whose en.js value is a function)
// `derived` names params every template of that key may use without the engine passing them ({airlock}, {cardtext}).

const PLAYER = 'player';
const PLAYERS = 'player[]';
const NUM = 'num';
const BOOL = 'bool';
const RP = 'rp';
const CAT = 'cat';
const CARD = 'card';
const RESULTS = 'msg:res.swap|res.reroll|res.force|res.peek|res.mass|res.shuffle|res.protect|res.double|res.block|res.cancelNow|res.cancelRest|res.cancelNext|res.eject|res.revive|res.beds|res.bedsMin|res.feature';
const FIELDS = 'id:name|room|spectator|token|lang|options|playerId|category|at|uid|targetId|effect|ids|on|count|specials';
const OPTION_FIELDS = 'id:speechSeconds1|speechSeconds|discussionSeconds|defenseSeconds';
const NON_GAME_TYPES = 'id:create|join|resume|ping|setLang';
const ROWS = [{ p: PLAYER, c: CARD }];

const log = (kind, params = {}, extra = {}) => ({ kind, params, ...extra });
const part = (params = {}, extra = {}) => ({ params, ...extra });

const SCHEMA_ENTRIES = {
  'log.join': log('info', { p: PLAYER }),
  'log.watch': log('info', { p: PLAYER }),
  'log.seat': log('info', { p: PLAYER }),
  'log.leftLobby': log('info', { p: PLAYER }),
  'log.leftGame': log('info', { p: PLAYER }),
  'log.kicked': log('info', { p: PLAYER }),
  'log.specLeft': log('info', { p: PLAYER }),
  'log.specKicked': log('info', { p: PLAYER }),
  'log.host': log('info', { p: PLAYER, why: 'msg?:host.offline|host.handover' }),
  'host.offline': part({ p: PLAYER }),
  'host.handover': part({ p: PLAYER }),

  'log.gameBegins': log('system', { n: NUM, beds: NUM, cata: 'cata', bname: 'bname' }),
  'log.endGame': log('system'),
  'log.backToLobby': log('system'),
  'log.roundReveal': log('system', { r: NUM, max: NUM, asc: BOOL, first: BOOL }),
  'log.discussion': log('system', { rp: RP, mode: 'enum:vote|cancelled|none', k: NUM }),
  'log.overtime': log('system', { alive: NUM, beds: NUM }),
  'log.doorCloses': log('system', { in: PLAYERS, out: PLAYERS }),
  'log.reveal': log('reveal', { rp: RP, p: PLAYER, cat: CAT, card: CARD, auto: BOOL }),

  'log.voteSkipped': log('vote', { rp: RP, k: NUM, mods: 'msg?:mods.used' }),
  'log.ballotsFewer': log('vote', { rp: RP, why: 'msg?:why.gone|why.bed', fewer: NUM, n: NUM, before: NUM }),
  'why.gone': part({ p: PLAYER }),
  'why.bed': part(),
  'log.voteStep': log('vote', { rp: RP, k: NUM }),
  'log.noMoreDue': log('vote', { rp: RP }),
  'log.allImmune': log('vote', { rp: RP }),
  'log.stepCancelled': log('vote', { rp: RP, earlier: BOOL, mods: 'msg:mods.used' }),
  'mods.used': part({ items: 'msg[]:mod.immune|mod.blocked|mod.double', n: NUM }),
  'mod.immune': part({ p: PLAYER }),
  'mod.blocked': part({ p: PLAYER }),
  'mod.double': part({ p: PLAYER }),
  'log.tally': log('vote', {
    rp: RP, revote: BOOL, ballot: NUM, ballots: NUM,
    rows: [{ t: PLAYER, votes: NUM, voters: [{ p: PLAYER, x2: BOOL }] }], abstained: PLAYERS,
  }),
  'log.tie': log('vote', { rp: RP, ids: PLAYERS }),
  'log.nobodyLeft': log('vote', { rp: RP }),
  'log.revote': log('vote', { rp: RP, ids: PLAYERS }),
  'log.eject': log('eject', { p: PLAYER, how: 'int:0|1|2' }),

  'log.airlockStart': log('special', { a: PLAYER, t: PLAYER, ot: BOOL }, { derived: ['airlock'] }),
  'log.airlockSeal': log('eject', { a: PLAYER, by: PLAYERS, t: PLAYER }, { derived: ['airlock'] }),
  'log.airlockJam': log('special', { t: PLAYER }, { derived: ['airlock'] }),

  'log.special': log('special', { rp: RP, p: PLAYER, card: 'special', result: RESULTS }, { derived: ['cardtext'] }),
  'res.swap': part({ a: PLAYER, b: PLAYER, cat: CAT, ca: CARD, cb: CARD }),
  'res.reroll': part({ t: PLAYER, cat: CAT, c: CARD }),
  'res.force': part({ t: PLAYER, cat: CAT, c: CARD }),
  'res.peek': part({ p: PLAYER, t: PLAYER }),
  'res.mass': part({ cat: CAT, rows: ROWS }),
  'res.shuffle': part({ cat: CAT, rows: ROWS }),
  'res.protect': part({ t: PLAYER }),
  'res.double': part({ p: PLAYER, now: BOOL }),
  'res.block': part({ t: PLAYER }),
  'res.cancelNow': part(),
  'res.cancelRest': part(),
  'res.cancelNext': part(),
  'res.eject': part({ t: PLAYER }),
  'res.revive': part({ t: PLAYER, when: 'int:0|1|2' }),
  'res.beds': part({ n: NUM }),
  'res.bedsMin': part({ n: NUM }),
  'res.feature': part({ f: 'feat' }),

  'note.peek': part({ rp: RP, t: PLAYER, cat: CAT, c: CARD }),
  'timer.turn': part({ p: PLAYER }),
  'timer.defense': part({ p: PLAYER }),
  'timer.discussion': part(),
  'timer.otDiscussion': part(),
  'rp': part({ r: NUM }),
  'rp.ot': part(),
  'rp.bare': part({ r: NUM }),
  'rp.otBare': part(),
  'kick.reason': part(),
  'fmt.quote': part({ title: 'text' }),
  'word.airlock': part(),
  'word.nobody': part(),
  'special.untitled': part(),

  'log.dev.seed': log('info', { seed: 'text' }),
  'log.dev.giveSpecial': log('info', { a: PLAYER, t: PLAYER, card: 'special' }, { derived: ['cardtext'] }),
  'log.dev.autoReveal': log('info', { a: PLAYER, rp: RP }),
  'log.dev.skipToVote': log('info', { a: PLAYER }),
  'log.dev.forceTie': log('info', { a: PLAYER, ids: PLAYERS }),
  'log.dev.god': log('info', { a: PLAYER, on: BOOL }),
  'log.dev.fastTimers': log('info', { a: PLAYER, secs: NUM }),
  'log.dev.addBots': log('info', { a: PLAYER, n: NUM, seated: BOOL }),
  'log.dev.text': log('info', { text: 'text' }),

  'err.missingField': part({ field: FIELDS }),
  'err.invalidField': part({ field: FIELDS }),
  'err.optionRange': part({ field: OPTION_FIELDS }),
  'err.notGameAction': part({ type: NON_GAME_TYPES }),
  'err.tooFewPlayers': part({ n: NUM }),
  'err.fromRound': part({ n: NUM }),
  'err.doubleBlocked': part({ now: BOOL }),
  'err.ownAirlock': part({ t: PLAYER }),
  'err.dev.playerLeft': part({ p: PLAYER }),
  'err.dev.notAlive': part({ p: PLAYER }),
  'err.dev.immune': part({ p: PLAYER }),
};

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** key -> {kind?, params, derived?}. Every key of en.js; error keys without params have `params: {}`. */
export const SCHEMA = deepFreeze(Object.fromEntries(KEYS.map((k) => [k, SCHEMA_ENTRIES[k] ?? part()])));
