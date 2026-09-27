/* Bunker Online — the client's language runtime (SPEC §11 X5.7; reports/i18n-design.md §9.1).
 *
 *   initLang(o)        once, at boot: ?lang=en|ru (applied, stored, and removed from the URL) > the stored choice
 *                      (localStorage[o.storageKey], default 'bunker.lang') > navigator.language starting with "ru" ? ru
 *                      : en. o.memory: keep the choice in memory only (mock pages). Returns the language.
 *   pickLang(x)        the same precedence as a pure function of {url, stored, nav} (tests, and initLang itself)
 *   lang()             the current language, 'en' | 'ru'
 *   setLang(l, o)      switch: <html lang>, the listeners; stores the choice unless o.store === false. Returns true when
 *                      the language changed.
 *   saveLang(l)        stores the choice without switching (a switch in a room waits for the server, design §9.3)
 *   langStorageKey()   the key the choice is stored under (null on a mock page, which keeps it in memory)
 *   onLang(fn)         fn(lang) after every change; returns an unsubscribe function
 *   t(key, params)     the string for key in the current language (falls back to en, then to the key itself, warning
 *                      once). Params are named by type (design §7.1); `cat` is a category id, rendered by catLabel()
 *                      with the form the template asks for ({cat@acc}).
 *   tn(key, params)    the same as an array of strings and DOM nodes: a param may be a node (a bold name, a code), and
 *                      it is placed where the template puts it
 *   tIn(l, key, params) t() in language l, whatever is on screen (the language switch names a pending choice in its
 *                      own words)
 *   catLabel(id, form) a category's name from the dictionary: 'Profession' / «Профессия», form 'acc' «профессию», …
 *                      (a missing form is the label; an unknown id is returned as it is)
 *   has(key)           whether the English dictionary has key (every key starts there)
 *
 * Import-safe in Node: nothing touches window, document, localStorage or navigator until initLang()/setLang() run
 * (the catalogue checker and test/client-i18n.test.js import this module). Both dictionaries are static imports: the
 * strings arrive with the code, with no fetch (CSP 'self'). A dictionary value is a template string (the grammar of
 * core.js) or, only where a template cannot do the job, a function (params, f) => string with f = core.helpers(). */

import { LANGS, normLang, format, formatText, helpers } from './core.js';
import en from './en.js';
import ru from './ru.js';

const DICTS = { en, ru };
const DEFAULT_KEY = 'bunker.lang';
let cur = 'en';
let storageKey = DEFAULT_KEY;
let memory = false;
let memStored = null;
const listeners = new Set();
const warned = new Set();

function warnOnce(k, msg) {
  if (warned.has(k) || warned.size > 500) return;
  warned.add(k);
  try { console.warn(`i18n: ${msg}`); } catch { /* no console */ }
}

/** The language a page starts in: `url` (the ?lang= value) > `stored` > `nav` (navigator.language). */
export function pickLang({ url, stored, nav } = {}) {
  return normLang(url) || normLang(stored) || (typeof nav === 'string' && /^ru(?:[-_]|$)/i.test(nav) ? 'ru' : 'en');
}

function readStored() {
  if (memory) return memStored;
  try { return window.localStorage.getItem(storageKey); } catch { return null; }
}
function writeStored(l) {
  if (memory) { memStored = l; return; }
  try { window.localStorage.setItem(storageKey, l); } catch { /* blocked storage: the choice lasts this page only */ }
}

export function initLang(o = {}) {
  memory = !!o.memory;
  if (typeof o.storageKey === 'string' && o.storageKey) storageKey = o.storageKey;
  let url = null;
  try {
    const u = new URL(window.location.href);
    url = normLang(u.searchParams.get('lang'));
    // a valid ?lang= is a choice: stored, and taken off the URL (a mock page keeps it: its choice is not stored)
    if (u.searchParams.has('lang') && !memory) {
      u.searchParams.delete('lang');
      window.history.replaceState(window.history.state, '', u.pathname + u.search + u.hash);
    }
  } catch { url = null; }
  let nav = '';
  try { nav = String(window.navigator.language || ''); } catch { nav = ''; }
  const l = pickLang({ url, stored: readStored(), nav });
  if (url) writeStored(url);
  apply(l);
  return l;
}

function apply(l) {
  cur = l;
  try { if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = l; } catch { /* no DOM */ }
}

export function lang() { return cur; }

export function setLang(l, o = {}) {
  const x = normLang(l);
  if (!x) return false;
  if (o.store !== false) writeStored(x);
  if (x === cur) return false;
  apply(x);
  for (const fn of [...listeners]) { try { fn(x); } catch (err) { warnOnce('listener', String(err)); } }
  return true;
}

/** Stores the viewer's choice without switching (design §9.3: a switch in a room is stored at once, but the page keeps
 * its language until the server's answer arrives). Returns false for a language that is not supported. */
export function saveLang(l) {
  const x = normLang(l);
  if (!x) return false;
  writeStored(x);
  return true;
}

/** The storage key the choice lives under (a `storage` event from another tab of this browser names it). */
export function langStorageKey() { return memory ? null : storageKey; }

export function onLang(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function has(key) { return Object.prototype.hasOwnProperty.call(en, key); }

// A Russian phone keyboard cannot type the Latin room code without switching layouts, so the Cyrillic letters that
// look like code letters count as them (design §9.2). О and І have no twin (a code has no O or I) and are dropped, as
// is everything else that is not A–Z.
const LOOKALIKE = { А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X' };
/** Upper-case Latin letters only: the text as a room code would read it (no length limit). */
export function latinCode(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[А-ЯЁ]/g, (ch) => LOOKALIKE[ch] || '').replace(/[^A-Z]/g, '');
}

function lookup(key) {
  const d = DICTS[cur] || en;
  if (Object.prototype.hasOwnProperty.call(d, key)) return d[key];
  if (Object.prototype.hasOwnProperty.call(en, key)) return en[key];
  warnOnce('key:' + key, `missing key "${key}"`);
  return null;
}

/** A category's name in the current language: the label, or a case form the dictionary has ('acc', 'gen', 'dat'). */
export function catLabel(id, form = 'label') {
  const d = DICTS[cur] || en;
  const own = (k) => (Object.prototype.hasOwnProperty.call(d, k) ? d[k] : Object.prototype.hasOwnProperty.call(en, k) ? en[k] : undefined);
  const f = form && form !== 'label' ? own(`cat.${id}.${form}`) : undefined;
  const v = typeof f === 'string' ? f : own(`cat.${id}`);
  return typeof v === 'string' ? v : String(id);
}

// `cat` params are category ids: they reach the hook (a plain string would pass through untouched), which renders
// them with the form the template asks for
const CAT = Symbol('cat');
function prep(params) {
  if (!params || typeof params !== 'object') return params || {};
  if (typeof params.cat !== 'string') return params;
  return { ...params, cat: { [CAT]: params.cat } };
}
const isNode = (v) => typeof Node !== 'undefined' && v instanceof Node;
function hookText(v, form) {
  if (v && v[CAT] !== undefined) return catLabel(v[CAT], form);
  if (isNode(v)) return v.textContent;
  return String(v);
}
function hookNode(v, form) {
  if (v && v[CAT] !== undefined) return catLabel(v[CAT], form);
  return v;
}

export function t(key, params) {
  const v = lookup(key);
  if (v === null) return key;
  const p = prep(params);
  if (typeof v === 'function') {
    const r = v(p, helpers(cur, hookText));
    return Array.isArray(r) ? r.map((x) => (typeof x === 'string' ? x : hookText(x))).join('') : String(r);
  }
  return formatText(cur, v, p, hookText);
}

/** t() in language l (a supported one; otherwise the current language), without switching the page. */
export function tIn(l, key, params) {
  const x = normLang(l);
  if (!x || x === cur) return t(key, params);
  const was = cur;
  cur = x;   // (synchronous: lookup() and the formatter's helpers read cur; nothing is notified)
  try { return t(key, params); } finally { cur = was; }
}

export function tn(key, params) {
  const v = lookup(key);
  if (v === null) return [key];
  const p = prep(params);
  if (typeof v === 'function') {
    const r = v(p, helpers(cur, hookNode));
    return Array.isArray(r) ? r : [String(r)];
  }
  return format(cur, v, p, hookNode);
}

export { LANGS };
