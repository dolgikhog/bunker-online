// server/content/render.js: the content tables per language, and rendering (SPEC §11 X5.5; reports/i18n-design.md
// §6.3–§6.5, §3.8).
//
// The tables of every language (./en/*.js, ./ru/*.js), category labels with their case forms, and the renderers of
// the language-neutral tokens that ./gen.js deals. English replays each English template with the values recorded in
// the token (the pre-X5 `fill`, minus the drawing), so an English render is byte for byte what the pre-X5 dealer
// printed. Every other language renders its positional templates (design §6.3) and falls back to English per entry
// (per field, per word) while a translation is missing, warning once per file.
//
// Tokens (design §3.2; deep-frozen, never mutated: a change is a new token, which keeps the per-token caches right):
//   CardTok
//     { lit: 'text' }                                             a literal (a hand-made dealer's string), any language
//     { c: 'health', id: 'asthma', v: [1] }                       a pooled card; v = the EN template's placeholder values
//     { c: 'profession', id, v: [], mod: { k: 'exp', n: 12 } }    a Profession with a modifier (./en/mods.js profession)
//     { c: 'hobby', id, v: [], mod: { k: 'years', n: 5 } }        a Hobby with a modifier (./en/mods.js hobby)
//     { c: 'phobia', id, v: [], int: 2 }                          a Phobia with an intensity index (absent = none)
//     { c: 'biology', sex: 'f', age: 34, o: 'hetero', note: { id: 'pregnant', v: [3] } }   note optional
//   CatTok     { id, v: [[...], [...], ...], stay: [lo, hi] }   v per detail line; stay in months
//              { id: null, fallback: true }                     the engine's stand-in ("Catastrophe": no text, no details)
//              { lit: {title, text, details} | 'title' }        a hand-made dealer's catastrophe, any language
//   BunkerTok  { name: NameTok, size, stay, food, features: FeatureTok[] }   size in m², stay and food in months; a
//              field that is not a number renders as '' (the engine's stand-in bunker has only a name)
//              { lit: {name, size, duration, food, features}, features?: FeatureTok[] }   a hand-made dealer's bunker,
//              any language; FeatureToks next to `lit` (features added in the game) render after its own
//   NameTok    { k: 'nick', nick } | { k: 'shelter', n } | { k: 'object', n, letter, nick } | { k: 'fallback' } | { lit }
//   FeatureTok { id, v: [...] } | { lit: 'text' }
//
// Renderers (design §6.5), each (lang, x): an unknown language renders English, and a result is cached per token and
// language (WeakMap), so the same token gives the same string or the same frozen object every time.
//   renderCard(lang, CardTok)          -> string                                ('' for null)
//   renderSpecial(lang, ref)           -> {title, text} (frozen), or null for an id the catalogue lacks
//   renderCatastrophe(lang, CatTok)    -> {id, title, text, details} (frozen; id: the content id, or null), or null
//   renderBunker(lang, BunkerTok)      -> {name, size, duration, food, features} (frozen), or null
//   renderBunkerName(lang, NameTok)    -> string
//   renderFeature(lang, FeatureTok)    -> string
//   categoryForms(lang, id)            -> {label, nom, acc, gen, dat, ins, loc} (frozen), or null for an unknown id
//   categoryLabel(lang, id)            -> string, or null for an unknown id
// createRenderer(tables) builds the same set over other tables (tests, the catalogue checker), plus replay (the English
// replay of a draw template) and renderEntry (one entry in isolation, for the checker).

import { formatText, helpers } from '../../public/i18n/core.js';

import * as enLabels from './en/labels.js';
import * as enMods from './en/mods.js';
import * as enProfessions from './en/professions.js';
import * as enHealth from './en/health.js';
import * as enHobbies from './en/hobbies.js';
import * as enPhobias from './en/phobias.js';
import * as enSkills from './en/skills.js';
import * as enTraits from './en/traits.js';
import * as enBaggage from './en/baggage.js';
import * as enBiology from './en/biology.js';
import * as enCatastrophes from './en/catastrophes.js';
import * as enBunker from './en/bunker.js';
import * as enSpecials from './en/specials.js';

import * as ruLabels from './ru/labels.js';
import * as ruMods from './ru/mods.js';
import * as ruProfessions from './ru/professions.js';
import * as ruHealth from './ru/health.js';
import * as ruHobbies from './ru/hobbies.js';
import * as ruPhobias from './ru/phobias.js';
import * as ruSkills from './ru/skills.js';
import * as ruTraits from './ru/traits.js';
import * as ruBaggage from './ru/baggage.js';
import * as ruBiology from './ru/biology.js';
import * as ruCatastrophes from './ru/catastrophes.js';
import * as ruBunker from './ru/bunker.js';
import * as ruSpecials from './ru/specials.js';

/** The content files, the same 13 names in every language. */
export const CONTENT_FILES = Object.freeze([
  'labels', 'mods', 'professions', 'health', 'hobbies', 'phobias', 'skills', 'traits', 'baggage', 'biology',
  'catastrophes', 'bunker', 'specials',
]);

const MODULES = {
  en: [enLabels, enMods, enProfessions, enHealth, enHobbies, enPhobias, enSkills, enTraits, enBaggage, enBiology,
    enCatastrophes, enBunker, enSpecials],
  ru: [ruLabels, ruMods, ruProfessions, ruHealth, ruHobbies, ruPhobias, ruSkills, ruTraits, ruBaggage, ruBiology,
    ruCatastrophes, ruBunker, ruSpecials],
};

const table = (mods) => Object.freeze(Object.fromEntries(CONTENT_FILES.map((f, i) => [f, mods[i].default ?? {}])));

/** TABLES[lang][file]: each file's default export. */
export const TABLES = Object.freeze({ en: table(MODULES.en), ru: table(MODULES.ru) });

/** COMPLETE[lang][file]: whether the translator marked the file done (English always is). */
export const COMPLETE = Object.freeze({
  en: Object.freeze(Object.fromEntries(CONTENT_FILES.map((f) => [f, true]))),
  ru: Object.freeze(Object.fromEntries(CONTENT_FILES.map((f, i) => [f, MODULES.ru[i].COMPLETE === true]))),
});

/** Which file holds a pooled category's cards. */
export const POOL_FILE = Object.freeze({
  profession: 'professions', health: 'health', hobby: 'hobbies', phobia: 'phobias', skill: 'skills', trait: 'traits',
  baggage: 'baggage',
});

// ---- English draw templates ---------------------------------------------------------------------------------------

const drawCache = new Map();

/**
 * An English card template, parsed: `params` are its placeholders left to right ({type: 'n'|'yrs', lo, hi},
 * {type: 'sev'} or {type: 'pick', options}); `parts` is the text with {i} markers. A brace body that is none of these
 * stays as text, as the pre-X5 dealer left it.
 */
export function drawTemplate(template) {
  let t = drawCache.get(template);
  if (t) return t;
  const params = [];
  const parts = [];
  let last = 0;
  for (const m of template.matchAll(/\{([^{}]+)\}/g)) {
    const body = m[1];
    let p = null;
    let r;
    if (body === 'sev') p = { type: 'sev' };
    else if ((r = /^n:(\d+)-(\d+)$/.exec(body))) p = { type: 'n', lo: Number(r[1]), hi: Number(r[2]) };
    else if ((r = /^yrs:(\d+)-(\d+)$/.exec(body))) p = { type: 'yrs', lo: Number(r[1]), hi: Number(r[2]) };
    else if (body.includes('|')) p = { type: 'pick', options: Object.freeze(body.split('|')) };
    if (!p) continue;
    parts.push(template.slice(last, m.index), { i: params.length });
    params.push(Object.freeze(p));
    last = m.index + m[0].length;
  }
  parts.push(template.slice(last));
  t = Object.freeze({ params: Object.freeze(params), parts: Object.freeze(parts.filter((x) => x !== '')) });
  drawCache.set(template, t);
  return t;
}

// ---- helpers ------------------------------------------------------------------------------------------------------

const hasOwn = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
/** o[k] when o is an object that has k as its own key, else undefined. */
const own = (o, k) => (hasOwn(o, k) ? o[k] : undefined);
const isStr = (x) => typeof x === 'string';
const str = (x) => (typeof x === 'string' ? x : x == null ? '' : String(x));
const strList = (xs) => (Array.isArray(xs) ? xs.map(str).filter(Boolean) : []);
/** A word that may be {f, m}: the form for the card's sex. */
const bySex = (w, sex) => (w !== null && typeof w === 'object' && !Array.isArray(w) ? own(w, sex) : w);
const usable = (x) => typeof x === 'string' || typeof x === 'function';
const modParams = (mod) => (mod.k === 'student' ? { n: mod.n, i: mod.n - 1 } : { n: mod.n });

function deepFreeze(x) {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

/**
 * A positional param of a non-English content template (design §6.3), for the kinds that are not plain numbers:
 * selectors ({0|…}, {0:…}) read its number through valueOf(), and {0} hands it to the renderer's hook, which prints
 * «3 года» (yrs), the severity phrase (sev) or, for a pick, which may not be printed, the English option.
 */
class Param {
  constructor(type, x, options) {
    this.type = type;
    this.x = x;
    this.options = options;
    Object.freeze(this);
  }

  valueOf() { return this.x; }
}

/**
 * The renderers over `tables` ({en: {file: table}, ru: …}; default: the real content). `opts.warn(message)` receives
 * the warnings (default console.warn, each distinct one once).
 */
export function createRenderer(tables = TABLES, opts = {}) {
  const EN = tables.en;
  const LANG_TABLES = tables;
  const langOf = (lang) => (lang !== 'en' && typeof lang === 'string' && Object.hasOwn(LANG_TABLES, lang) ? lang : 'en');
  const T = (L) => LANG_TABLES[L];
  const F = new Map();
  const fh = (L) => { let f = F.get(L); if (!f) F.set(L, (f = helpers(L))); return f; };

  const warned = new Set();
  const warnFn = typeof opts.warn === 'function' ? opts.warn : (m) => console.warn(`i18n: ${m}`);
  function warnOnce(key, message) {
    if (warned.has(key) || warned.size > 2000) return;
    warned.add(key);
    try { warnFn(message); } catch { /* a warning never breaks rendering */ }
  }
  function missing(L, file, what) {
    warnOnce(`missing\u0000${L}\u0000${file}`, `server/content/${L}/${file}.js has no ${what} (and maybe more): English is used`);
  }

  /** A value of `lang`'s table found by `get`, else English's: {L, v} (L: the language the value is in). */
  function find(L, file, get, what) {
    if (L !== 'en') {
      const v = get(T(L)[file]);
      if (v !== undefined && v !== null) return { L, v };
      missing(L, file, what);
    }
    return { L: 'en', v: get(EN[file]) };
  }

  /** A named template (or a function (params, f) => string) rendered in L. */
  function named(L, value, params) {
    if (typeof value === 'function') return str(value(params, fh(L)));
    return isStr(value) ? formatText(L, value, params) : '';
  }

  // ---- English replay and the positional templates -------------------------------------------------------------

  function enValue(p, x) {
    switch (p.type) {
      case 'n': return String(x);
      case 'yrs': return formatText('en', EN.mods.yrs, { n: x });
      case 'sev': return EN.mods.sev[x] ?? '';
      case 'pick': return p.options[x] ?? '';
      default: return '';
    }
  }

  /** An English card template replayed with its recorded values. */
  function replay(template, v) {
    const t = drawTemplate(template);
    let out = '';
    for (const x of t.parts) out += typeof x === 'string' ? x : enValue(t.params[x.i], v[x.i]);
    return out;
  }

  function paramHook(L) {
    return (x, form) => {
      let s;
      if (!(x instanceof Param)) s = str(x);
      else if (x.type === 'yrs') {
        const { L: l, v } = find(L, 'mods', (m) => own(m, 'yrs'), 'yrs');
        s = named(l, v, { n: x.x });
      } else if (x.type === 'sev') {
        const { v } = find(L, 'mods', (m) => { const a = own(m, 'sev'); return Array.isArray(a) && isStr(a[x.x]) ? a[x.x] : undefined; }, 'sev');
        s = str(v);
      } else {
        warnOnce(`pick\u0000${L}`, `a ${L} template prints an option param with {i}: use {i:option|…} (the English option is shown)`);
        s = str(x.options[x.x]);
      }
      return form === 'cap' && s ? s[0].toUpperCase() + s.slice(1) : s;
    };
  }
  const hooks = new Map();
  const hookOf = (L) => { let h = hooks.get(L); if (!h) hooks.set(L, (h = paramHook(L))); return h; };

  /**
   * An entry: `value` is L's template (positional) or function for the English template `enTpl`, rendered with the
   * token's values `v`; undefined -> the English replay.
   */
  function entry(L, enTpl, value, v) {
    const vals = Array.isArray(v) ? v : [];
    if (L === 'en' || value === undefined || value === null) return replay(enTpl, vals);
    if (typeof value === 'function') return str(value(vals, fh(L)));
    const P = drawTemplate(enTpl).params;
    const params = P.map((p, i) => (p.type === 'n' ? vals[i] : new Param(p.type, vals[i], p.options)));
    return formatText(L, str(value), params, hookOf(L));
  }

  /** The entry `id` of a map `key` in `file` (e.g. bunker.features), with its English template. */
  function mapEntry(L, file, pick, id, v, what) {
    const enTpl = own(pick(EN[file]), id);
    if (!isStr(enTpl)) {
      warnOnce(`unknown\u0000${file}\u0000${id}`, `unknown ${what} id ${String(id)}`);
      return '';
    }
    let value;
    if (L !== 'en') {
      value = own(pick(T(L)[file]), id);
      if (!usable(value)) { value = undefined; missing(L, file, `${what} '${id}'`); }
    }
    return entry(L, enTpl, value, v);
  }

  // ---- cards ---------------------------------------------------------------------------------------------------

  function modText(L, group, mod) {
    const { L: l, v } = find(L, 'mods', (m) => { const x = own(own(m, group), mod.k); return usable(x) ? x : undefined; }, `${group}.${mod.k}`);
    return named(l, v, modParams(mod));
  }

  function wrap(L, key, base, mod) {
    const { L: l, v } = find(L, 'mods', (m) => { const x = own(m, key); return usable(x) ? x : undefined; }, key);
    return named(l, v, { base, mod });
  }

  function biology(L, tok) {
    const B = L === 'en' ? null : T(L).biology;
    const BE = EN.biology;
    const sex = tok.sex;
    const note = tok.note || null;
    const word = (ru, en, what) => {
      const r = bySex(ru, sex);
      if (L !== 'en' && !usable(r)) missing(L, 'biology', what);
      return usable(r) ? r : bySex(en, sex);
    };
    const sexText = str(word(own(B, 'sex'), BE.sex, 'sex'));
    const oText = str(word(own(own(B, 'orientation'), tok.o), own(BE.orientation, tok.o), `orientation '${tok.o}'`));
    let noteText = null;
    if (note) {
      const enTpl = bySex(own(BE.notes, note.id), sex);
      if (!isStr(enTpl)) warnOnce(`unknown\u0000biology\u0000${note.id}`, `unknown biology note id ${String(note.id)}`);
      else {
        let r = L === 'en' ? undefined : bySex(own(own(B, 'notes'), note.id), sex);
        if (L !== 'en' && !usable(r)) { r = undefined; missing(L, 'biology', `note '${note.id}'`); }
        noteText = entry(L, enTpl, r, note.v);
      }
    }
    let card = own(B, 'card');
    let l = L;
    if (typeof card !== 'function') {
      if (L !== 'en') missing(L, 'biology', 'card()');
      card = BE.card;
      l = 'en';
    }
    return str(card({
      sex, age: tok.age, o: tok.o, noteId: note ? note.id : null, noteV: note ? note.v : [], sexText, oText, noteText,
    }, fh(l)));
  }

  function card(L, tok) {
    if (typeof tok.lit === 'string') return tok.lit;
    if (tok.c === 'biology') return biology(L, tok);
    const file = POOL_FILE[tok.c];
    if (!file) {
      warnOnce(`unknown\u0000c\u0000${tok.c}`, `a card token of unknown category ${String(tok.c)}`);
      return '';
    }
    const base = mapEntry(L, file, (t) => t, tok.id, tok.v, tok.c);
    if (tok.mod && tok.c === 'profession') return wrap(L, 'professionWrap', base, modText(L, 'profession', tok.mod));
    if (tok.mod && tok.c === 'hobby') return wrap(L, 'hobbyWrap', base, modText(L, 'hobby', tok.mod));
    if (tok.c === 'phobia' && typeof tok.int === 'number') {
      const { v } = find(L, 'mods', (m) => { const a = own(m, 'phobiaIntensity'); return Array.isArray(a) && isStr(a[tok.int]) ? a[tok.int] : undefined; }, 'phobiaIntensity');
      return wrap(L, 'phobiaWrap', base, str(v));
    }
    return base;
  }

  // ---- catastrophes, bunkers, features, specials ------------------------------------------------------------------

  function catastrophe(L, tok) {
    if (tok.lit !== undefined) {
      const x = tok.lit;
      if (x !== null && typeof x === 'object') return { id: null, title: str(x.title), text: str(x.text), details: strList(x.details) };
      return { id: null, title: str(x), text: '', details: [] };
    }
    const CE = isStr(tok.id) ? own(EN.catastrophes.list, tok.id) : undefined;
    if (!CE) {
      if (!tok.fallback) warnOnce(`unknown\u0000catastrophe\u0000${tok.id}`, `unknown catastrophe id ${String(tok.id)}`);
      const { L: l, v } = find(L, 'catastrophes', (c) => { const x = own(c, 'fallbackTitle'); return isStr(x) ? x : undefined; }, 'fallbackTitle');
      return { id: null, title: named(l, v, {}), text: '', details: [] };
    }
    const C = L === 'en' ? undefined : own(own(T(L).catastrophes, 'list'), tok.id);
    if (L !== 'en' && !C) missing(L, 'catastrophes', `'${tok.id}'`);
    const title = isStr(own(C, 'title')) ? C.title : CE.title;
    const text = isStr(own(C, 'text')) ? C.text : CE.text;
    const rd = own(C, 'details');
    const details = (Array.isArray(tok.v) ? tok.v : []).map((vals, i) => {
      const r = Array.isArray(rd) && usable(rd[i]) ? rd[i] : undefined;
      return entry(L, CE.details[i], r, vals);
    });
    if (Array.isArray(tok.stay)) {
      const [lo, hi] = tok.stay;
      const rg = find(L, 'bunker', (b) => { const f = own(b, 'range'); return typeof f === 'function' ? f : undefined; }, 'range()');
      const range = str(rg.v({ lo, hi }, fh(rg.L)));
      const sf = find(L, 'catastrophes', (c) => { const x = own(c, 'safe'); return usable(x) ? x : undefined; }, 'safe');
      details.push(named(sf.L, sf.v, { range }));
    }
    return { id: tok.id, title, text, details };
  }

  function nickname(L, id) {
    const { v } = find(L, 'bunker', (b) => { const x = own(own(b, 'nicknames'), id); return isStr(x) ? x : undefined; }, `nickname '${id}'`);
    return str(v);
  }

  function letter(L, i) {
    const { v } = find(L, 'bunker', (b) => {
      const s = own(b, 'letters');
      const x = isStr(s) ? Array.from(s)[i] : undefined;
      return x;
    }, 'letters');
    return str(v);
  }

  function bunkerName(L, tok) {
    if (typeof tok.lit === 'string') return tok.lit;
    const kind = ['nick', 'shelter', 'object'].includes(tok.k) ? tok.k : 'fallback';
    const { L: l, v } = find(L, 'bunker', (b) => { const x = own(own(b, 'name'), kind); return usable(x) ? x : undefined; }, `name.${kind}`);
    switch (kind) {
      case 'nick': return named(l, v, { nick: nickname(L, tok.nick) });
      case 'shelter': return named(l, v, { n: tok.n });
      case 'object': return named(l, v, { n: tok.n, letter: letter(L, tok.letter), nick: nickname(L, tok.nick) });
      default: return named(l, v, {});
    }
  }

  function months(L, m) {
    const { L: l, v } = find(L, 'bunker', (b) => { const f = own(b, 'months'); return typeof f === 'function' ? f : undefined; }, 'months()');
    return str(v({ m }, fh(l)));
  }

  function bunkerLine(L, key, params) {
    const { L: l, v } = find(L, 'bunker', (b) => { const x = own(b, key); return usable(x) ? x : undefined; }, key);
    return named(l, v, params);
  }

  function feature(L, tok) {
    if (typeof tok.lit === 'string') return tok.lit;
    return mapEntry(L, 'bunker', (b) => own(b, 'features'), tok.id, tok.v, 'bunker feature');
  }

  function bunker(L, tok) {
    const added = (Array.isArray(tok.features) ? tok.features : []).map((f) => renderFeature(L, f));
    if (tok.lit !== undefined) {
      // a hand-made dealer's bunker; `features` next to `lit` are FeatureToks added later in the game
      const x = tok.lit !== null && typeof tok.lit === 'object' ? tok.lit : { name: tok.lit };
      return {
        name: str(x.name), size: str(x.size), duration: str(x.duration), food: str(x.food),
        features: [...strList(x.features), ...added],
      };
    }
    const name = tok.name !== null && typeof tok.name === 'object' ? renderBunkerName(L, tok.name) : renderBunkerName(L, { k: 'fallback' });
    const size = typeof tok.size === 'number' ? bunkerLine(L, 'size', { n: tok.size }) : '';
    const duration = typeof tok.stay === 'number' ? bunkerLine(L, 'duration', { months: months(L, tok.stay) }) : '';
    const food = typeof tok.food === 'number' ? bunkerLine(L, 'food', { months: months(L, tok.food) }) : '';
    return { name, size, duration, food, features: added };
  }

  const specialCache = new Map();
  function renderSpecial(lang, ref) {
    if (!isStr(ref) || !Object.hasOwn(EN.specials, ref)) return null;
    const L = langOf(lang);
    const key = `${L}\u0000${ref}`;
    let out = specialCache.get(key);
    if (out) return out;
    const E = EN.specials[ref];
    const R = L === 'en' ? undefined : own(T(L).specials, ref);
    if (L !== 'en' && !(isStr(own(R, 'title')) && isStr(own(R, 'text')))) missing(L, 'specials', `'${ref}'`);
    out = Object.freeze({ title: isStr(own(R, 'title')) ? R.title : E.title, text: isStr(own(R, 'text')) ? R.text : E.text });
    specialCache.set(key, out);
    return out;
  }

  // ---- caching ------------------------------------------------------------------------------------------------------

  /**
   * A renderer (lang, tok) over `fn(L, tok)`: cached per token and language; `empty` for a token that is not an
   * object (a string is a literal); in a language other than English, a translator's function that throws falls back
   * to the English render of the whole token, with a warning.
   */
  function cachedRenderer(name, fn, empty, freeze) {
    const cache = new WeakMap();
    const self = (lang, tok) => {
      if (typeof tok === 'string') return freeze ? empty : tok;
      if (tok === null || typeof tok !== 'object') return empty;
      const L = langOf(lang);
      let slot = cache.get(tok);
      if (!slot) cache.set(tok, (slot = new Map()));
      if (slot.has(L)) return slot.get(L);
      let out;
      if (L === 'en') out = fn('en', tok);
      else {
        try {
          out = fn(L, tok);
        } catch (e) {
          warnOnce(`throw\u0000${name}\u0000${L}`, `${name}(${L}) failed (${e?.message}): English is used`);
          out = self('en', tok);
        }
      }
      if (freeze) out = deepFreeze(out);
      slot.set(L, out);
      return out;
    };
    return self;
  }

  const renderCard = cachedRenderer('renderCard', card, '', false);
  const renderCatastrophe = cachedRenderer('renderCatastrophe', catastrophe, null, true);
  const renderBunker = cachedRenderer('renderBunker', bunker, null, true);
  const renderBunkerName = cachedRenderer('renderBunkerName', bunkerName, '', false);
  const renderFeature = cachedRenderer('renderFeature', feature, '', false);

  // ---- category labels ------------------------------------------------------------------------------------------

  const FORM_NAMES = ['nom', 'acc', 'gen', 'dat', 'ins', 'loc'];
  const formsCache = new Map();

  /**
   * A category's label and case forms: {label, nom, acc, gen, dat, ins, loc}, or null for an unknown category id.
   * `label` is the capitalised label (chips, headings); nom..loc are the forms running text uses (Russian: lower case,
   * inflected). A language's entry is a string (every form is that string, as in English) or an object; a missing
   * form falls back to nom, a missing nom to label, and a missing entry to English. An unknown language renders
   * English.
   */
  function categoryForms(lang, id) {
    const L = langOf(lang);
    const key = `${L}\u0000${id}`;
    if (formsCache.has(key)) return formsCache.get(key);
    let out = null;
    if (typeof id === 'string' && Object.hasOwn(EN.labels, id)) {
      const mine = own(T(L).labels, id);
      const raw = mine ?? EN.labels[id];
      const o = typeof raw === 'string' ? { label: raw } : raw && typeof raw === 'object' ? raw : {};
      const label = typeof o.label === 'string' && o.label ? o.label : EN.labels[id];
      const nom = typeof o.nom === 'string' && o.nom ? o.nom : label;
      out = { label, nom };
      for (const f of FORM_NAMES.slice(1)) out[f] = typeof o[f] === 'string' && o[f] ? o[f] : nom;
      out = Object.freeze(out);
    }
    formsCache.set(key, out);
    return out;
  }

  /** A category's label in a language ('Profession', 'Профессия'), or null for an unknown category id. */
  function categoryLabel(lang, id) {
    const forms = categoryForms(lang, id);
    return forms ? forms.label : null;
  }

  /**
   * One content entry rendered in isolation (the catalogue checker): `value` is a template of `lang` (positional,
   * design §6.3) or a function (v, f), for the English template `enTemplate`, with the values `v`; undefined renders
   * the English replay. Throws what a function value throws. Not cached.
   */
  function renderEntry(lang, enTemplate, value, v) {
    return entry(langOf(lang), enTemplate, value, v);
  }

  return Object.freeze({
    renderCard, renderSpecial, renderCatastrophe, renderBunker, renderBunkerName, renderFeature, categoryForms,
    categoryLabel, replay, renderEntry,
  });
}

// ---- the real content --------------------------------------------------------------------------------------------

const DEFAULT = createRenderer(TABLES);

export const {
  renderCard, renderSpecial, renderCatastrophe, renderBunker, renderBunkerName, renderFeature, categoryForms,
  categoryLabel,
} = DEFAULT;

/** An English card template replayed with its recorded values (the pre-X5 `fill`, minus the drawing). */
export const replayEn = DEFAULT.replay;

// The English renders the dealer's legacy methods and its repeat check use (B1 names, kept).
export const cardTextEn = (tok) => renderCard('en', tok);
export const catastropheEn = (tok) => renderCatastrophe('en', tok);
export const bunkerEn = (tok) => renderBunker('en', tok);
export const bunkerNameEn = (tok) => renderBunkerName('en', tok);
export const featureEn = (tok) => renderFeature('en', tok);
