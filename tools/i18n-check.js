#!/usr/bin/env node
// tools/i18n-check.js: the catalogue checker (SPEC §11 X5.8; reports/i18n-design.md §7, §7.1, §10, §11 "test/i18n-catalog
// .test.js checks", §13 item 2). Owner: i18n-content. test/i18n-catalog.test.js runs it inside `npm test`.
//
//   npm run i18n:check                 check everything; exit 1 on any error
//   node tools/i18n-check.js --gate    the release gate (§13): also every Russian file COMPLETE and the gender review
//                                      list fully marked, with no line marked fix
//   options: --out <dir>   where the gender review list and the sample sheet go (default .scratch/i18n-qa)
//            --no-write    write nothing          --json   print the result as JSON
//            --quiet       only the summary and the errors (not the missing entries)
//
// Three catalogues, each English and Russian: the content (server/content/{en,ru}/*.js, 13 files), the server
// messages (server/i18n/{en,ru}.js, whose index.js SCHEMA types every param) and the client dictionary
// (public/i18n/{en,ru}.js, whose params are typed by name, §7.1). A catalogue whose files are not there yet is skipped
// with a note. For each:
//   - keys: no Russian key that English lacks; an English key that Russian lacks is `missing` (reported, not failing)
//     until that Russian file exports COMPLETE = true, and an error after;
//   - placeholders: Russian refers only to the params English has; param names come from §7.1; option counts match
//     (a pick: English's count; a sev: 3; an option on a number: hi + 1); a plural has 2 forms in English and 2 or 3 in
//     Russian, and only on a number; forms (@acc, @and, …) fit the param's type;
//   - the plural lint: a Russian number printed and followed by a Cyrillic word needs a 3-form selector on that word
//     ({n} {n|год|года|лет}) unless the word is invariable, and 3 forms need their number printed (§7);
//   - the exhaustive render: every Russian entry over its param matrix (numbers: min, max, and every one of 1, 2, 5, 11,
//     12, 21, 22 and each plural class inside the range; every option; sev 0..2; biology: both sexes x every
//     orientation x every note x ages of every plural class; every message and client key over the §7.1 values, with
//     the real protocol identifiers for `field`/`type`). Every render: no throw, no warning, no { or }, no double space,
//     no leading or trailing space (fragment keys excepted), no Latin letter beyond the allowlist and the Latin that
//     the params supply (player names, room codes), no bracketed gender form, and year/month/player/bed words that
//     agree with the number before them;
//   - the gender lint: `(а)`, `(ла)`, `(ась)`, `(ая)`, `(на)`, `(ен)` fail; a past tense or short participle near a
//     player or «ты», and in any card, goes to the review list (<out>/gender-review.txt) that QA marks ok or fix;
//   - the glossary (§10.1): the category labels and their case forms; «Шлюз» and «Вернулся из леса»; every client
//     string that names a special in English names it in Russian; the server's and the client's labels agree.
// A render that depends on a Russian entry still missing elsewhere (a nested message, a category label) is not
// checked for Latin until that entry exists: the missing entry is what gets reported.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- the rules' data ------------------------------------------------------------------------------------------------

/** §7.1: every param name a message or client template may use, with its type. */
export const PARAM_TYPES = Object.freeze(Object.fromEntries([
  ...['n', 'k', 'm', 'r', 'max', 'beds', 'alive', 'before', 'fewer', 'ballot', 'ballots', 'votes', 'secs', 'mins', 'lo', 'hi',
    'seat', 'count', 'left', 'total', 'i'].map((x) => [x, 'number']),
  ...['p', 't', 'a', 'b', 'host', 'who', 'name'].map((x) => [x, 'player']),
  ['cat', 'cat'],
  ...['ids', 'by', 'in', 'out', 'items', 'rows', 'list', 'voters', 'abstained'].map((x) => [x, 'list']),
  ['rp', 'rp'],
  ...['c', 'ca', 'cb', 'f', 'title', 'text', 'card', 'cata', 'bname'].map((x) => [x, 'text']),
  ['code', 'code'],
  ...['why', 'result', 'mods'].map((x) => [x, 'nested']),
  ...['field', 'type'].map((x) => [x, 'protocol']),
  ...['asc', 'first', 'auto', 'now', 'ot', 'revote', 'earlier', 'mine'].map((x) => [x, 'bool']),
  ...['mode', 'how', 'when', 'kind', 'stage'].map((x) => [x, 'enum']),
]));
/** Params every server message may use without the engine passing them (server/i18n/en.js "derived"). */
const DERIVED = new Set(['airlock', 'cardtext']);

/** §7: words after a printed number that do not agree with it. */
export const INVARIABLE = new Set(['из', 'до', 'от', 'на', 'в', 'и', 'или', 'по', 'мин', 'с', 'ч', 'км', 'кг', 'см', 'м²', 'Вт']);
/** §11: Latin that Russian text may hold anywhere. */
export const LATIN_ALLOWED = Object.freeze(['°C', '3D', 'USB']);
/** §11: Latin a single client key may hold. */
const CLIENT_LATIN = { 'landing.codePh': ['ABCD'] };
/** Fragment keys, only ever rendered inside another message: may start or end with a space (§11). */
const FRAGMENT = /^(?:rp(?:\.|$)|why\.|mod\.|mods\.|res\.)/;

export const GENDER_HARD = /\((?:а|ла|ась|ая|на|ен)\)/;
const YOU = /(?<!\p{L})(?:ты|тебя|тебе|тобой)(?!\p{L})/iu;
const PLAYER_PARAMS = new Set(['p', 't', 'a', 'b', 'host', 'who', 'name']);
const PAST_OR_PARTICIPLE = /(?:л|ла|лся|лась|ан|ана|ян|яна|ен|ена|ён|ёна)$/;
/** Words with those endings that are not a past tense or a short participle (the review list skips them). */
export const REVIEW_NOUNS = new Set(`
финал сигнал зал канал стол пол предел отдел материал генерал капитал арсенал металл стул угол пепел орёл козёл осёл
котёл узел ангел дятел посол тыл мел ил пыл вол кол пенал журнал вокзал персонал минерал интервал идеал кристалл коралл
балл бал запал накал провал обвал подвал завал перевал сеновал самосвал штурвал фал оригинал терминал аврал
сериал ритуал потенциал криминал маргинал
сила игла пила скала стрела мгла метла смола зола могила дела тела числа масла мыла стекла весла крыла жала начала
одеяла зеркала сала стола зала угла пола мела села шила рыла пчела юла кабала ангела посла узла котла дятла орла
план экран диван стакан туман океан роман баран карман кран клан вулкан ураган чемодан фонтан барабан капкан таракан
великан сарафан стан пан банан тюльпан пеликан орган ресторан сан баклажан караван кальян баян изъян бурьян смутьян
капитан истукан шафран фазан титан курган кабан жбан
плана экрана дивана стакана тумана океана романа барана кармана крана клана вулкана урагана чемодана фонтана
охрана страна рана поляна сметана лиана ванна
член ген феномен рентген бизнесмен спортсмен джентльмен обмен размен манекен
цена стена сцена арена смена замена пена вена антенна измена перемена гиена сирена хризантема
клён лён
бензопила спортзал супервулкан кардинал сначала семян кукол игл сериала пенал фестиваль
`.split(/\s+/).filter((w) => w && /^[а-яё]+$/.test(w)));

// Number words that must agree with the number before them (the output check "plural coverage"): the forms one |
// few | many after a number in the nominative or accusative, and after a preposition that takes the genitive.
const PARADIGMS = [
  { nom: ['год', 'года', 'лет'], gen: ['года', 'лет', 'лет'] },
  { nom: ['месяц', 'месяца', 'месяцев'], gen: ['месяца', 'месяцев', 'месяцев'] },
  { nom: ['неделя', 'недели', 'недель'], gen: ['недели', 'недель', 'недель'] },
  { nom: ['день', 'дня', 'дней'], gen: ['дня', 'дней', 'дней'] },
  { nom: ['час', 'часа', 'часов'], gen: ['часа', 'часов', 'часов'] },
  { nom: ['минута', 'минуты', 'минут'], gen: ['минуты', 'минут', 'минут'] },
  { nom: ['секунда', 'секунды', 'секунд'], gen: ['секунды', 'секунд', 'секунд'] },
  { nom: ['игрок', 'игрока', 'игроков'], gen: ['игрока', 'игроков', 'игроков'] },
  { nom: ['койка', 'койки', 'коек'], gen: ['койки', 'коек', 'коек'] },
  { nom: ['раунд', 'раунда', 'раундов'], gen: ['раунда', 'раундов', 'раундов'] },
];
const GENITIVE_PREPS = new Set(['от', 'до', 'после', 'около', 'из', 'без', 'для', 'кроме', 'с', 'со', 'у', 'менее', 'более', 'больше', 'меньше', 'свыше', 'дольше']);
const PARADIGM_WORDS = new Map();
for (const p of PARADIGMS) for (const w of [...p.nom, ...p.gen]) PARADIGM_WORDS.set(w, p);

// ---- helpers --------------------------------------------------------------------------------------------------------

const hasOwn = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);
const own = (o, k) => (hasOwn(o, k) ? o[k] : undefined);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const short = (s, n = 90) => { const t = String(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The combinations of `axes` (arrays of candidates): the full product when it has at most `cap` entries, else every
 * candidate of each axis with the others at their first candidate, plus a seeded sample, `cap` in all.
 */
export function combos(axes, cap = 1500) {
  if (axes.length === 0) return [[]];
  const total = axes.reduce((n, a) => n * Math.max(1, a.length), 1);
  const out = [];
  if (total <= cap) {
    const idx = axes.map(() => 0);
    for (;;) {
      out.push(axes.map((a, i) => a[idx[i]]));
      let i = axes.length - 1;
      while (i >= 0 && ++idx[i] >= axes[i].length) { idx[i] = 0; i--; }
      if (i < 0) return out;
    }
  }
  const base = axes.map((a) => a[0]);
  out.push(base);
  axes.forEach((a, i) => a.slice(1).forEach((x) => { const c = [...base]; c[i] = x; out.push(c); }));
  const rnd = mulberry(total);
  while (out.length < cap) out.push(axes.map((a) => a[Math.floor(rnd() * a.length)]));
  return out;
}

const pluralClass = (n) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a >= 11 && a <= 14) return 'teen';
  if (b === 1) return 'one';
  if (b >= 2 && b <= 4) return 'few';
  return 'many';
};

/**
 * Numbers to render for a range: all of a short range (at most 13 values: an option selector may pick by the number),
 * else lo, hi, every one of 1, 2, 5, 11, 12, 21, 22 inside it, and the first of each plural class (one, few, many, 11-14).
 */
export function numbersIn(lo, hi) {
  if (hi - lo <= 12) return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const set = new Set([lo, hi]);
  for (const x of [1, 2, 5, 11, 12, 21, 22]) if (x >= lo && x <= hi) set.add(x);
  const seen = new Set();
  for (let x = lo; x <= hi && seen.size < 4; x++) {
    const c = pluralClass(x);
    if (!seen.has(c)) { seen.add(c); set.add(x); }
  }
  return [...set].sort((a, b) => a - b);
}

// ---- lints on text --------------------------------------------------------------------------------------------------

const LATIN = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/; // Latin letters, not × (U+00D7) or ÷

/** The Latin letters left in `text` once the allowlist and `allowed` (strings the params supplied) are taken out. */
export function latinLeft(text, allowed = []) {
  let s = String(text);
  for (const a of [...allowed].filter((x) => typeof x === 'string' && x && LATIN.test(x)).sort((x, y) => y.length - x.length)) s = s.split(a).join(' ');
  s = s.split('°C').join(' ');
  s = s.replace(/(?<![A-Za-z])(?:3D|USB)(?![A-Za-z])/g, ' ');
  const m = s.match(new RegExp(LATIN.source, 'g'));
  return m ? m.join('') : '';
}

/** The words of `text` that look like a past tense or a short participle, minus REVIEW_NOUNS. */
export function reviewWords(text) {
  const out = [];
  for (const m of String(text).matchAll(/\p{L}+/gu)) {
    const w = m[0].toLowerCase();
    if (w.length < 3 || !/^[а-яё]+$/.test(w) || !PAST_OR_PARTICIPLE.test(w) || REVIEW_NOUNS.has(w)) continue;
    out.push(m[0]);
  }
  return [...new Set(out)];
}

/**
 * Number words that disagree with the number before them («2 год», «5 года», «до 2 года»): [{number, word, want}].
 * After a genitive preposition (от, до, после, около, …) the genitive forms apply; a non-integer takes the few form.
 */
export function timeAgreement(text) {
  const bad = [];
  const re = /(?:(\p{L}+)[ \u00A0\u202F]+)?(?:\d+(?:[.,]\d+)?[–-])?((?:\d{1,3}(?:[ \u00A0\u202F]\d{3})+|\d+)(?:[.,]\d+)?)[ \u00A0\u202F]+(\p{L}+)(?!\p{L})/gu;
  for (const m of String(text).matchAll(re)) {
    const word = m[3].toLowerCase();
    const p = PARADIGM_WORDS.get(word);
    if (!p) continue;
    const n = Number(m[2].replace(/[ \u00A0\u202F]/g, '').replace(',', '.'));
    if (!Number.isFinite(n)) continue;
    const gen = Boolean(m[1]) && GENITIVE_PREPS.has(m[1].toLowerCase());
    const forms = gen ? p.gen : p.nom;
    // a fraction takes the few form (\u00AB1,5 \u0433\u043E\u0434\u0430\u00BB), and the genitive singular after such a preposition (\u00AB\u0434\u043E 1,5 \u0433\u043E\u0434\u0430\u00BB)
    const c = !Number.isInteger(n) ? (gen ? 'one' : 'few') : pluralClass(n) === 'teen' ? 'many' : pluralClass(n);
    const want = c === 'one' ? forms[0] : c === 'few' ? forms[1] : forms[2];
    if (word !== want) bad.push({ number: m[2], word: m[3], want });
  }
  return bad;
}

/** Problems of one rendered Russian string: [rule, detail]. */
export function textProblems(text, { allowed = [], fragment = false } = {}) {
  const out = [];
  const s = String(text);
  if (/[{}]/.test(s)) out.push(['braces', `a { or } is left: ${short(s)}`]);
  if (/[ \u00A0\u202F]{2,}/.test(s)) out.push(['double space', `a double space: ${short(s)}`]);
  if (!fragment && /^\s|\s$/.test(s)) out.push(['edge space', `a leading or trailing space: "${short(s)}"`]);
  const latin = latinLeft(s, allowed);
  if (latin) out.push(['latin', `Latin letters (${short(latin, 20)}): ${short(s)}`]);
  if (GENDER_HARD.test(s)) out.push(['gender', `a bracketed gender form: ${short(s)}`]);
  for (const b of timeAgreement(s)) out.push(['agreement', `«${b.number} ${b.word}» should be «${b.number} ${b.want}»: ${short(s)}`]);
  return out;
}

/** Problems of a Russian source string (a template, a plain text; `code`: a function's source): [rule, detail]. */
function sourceProblems(src, code = false) {
  const out = [];
  if (GENDER_HARD.test(src)) out.push(['gender', `a bracketed gender form: ${short(src)}`]);
  if (!code && /["\u201D]/.test(src)) out.push(['quotes', `straight or English quotes: use «…» (nested „…“), §10.4: ${short(src)}`]);
  return out;
}

// ---- lints on templates ---------------------------------------------------------------------------------------------

let core = null; // public/i18n/core.js, loaded by check()

/**
 * The plural lint (§7, §11) on a Russian template: [rule, detail]. `numeric(name)`: whether {name} prints a bare number.
 */
export function pluralLint(template, numeric) {
  const seq = core.parseTemplate(template);
  const out = [];
  const printed = new Set(seq.filter((t) => typeof t !== 'string' && t.kind === 'value' && !t.form && numeric(t.name)).map((t) => t.name));
  seq.forEach((t, i) => {
    if (typeof t === 'string') return;
    if (t.kind === 'plural' && t.choices.length === 3 && !printed.has(t.name)) {
      out.push(['plural', `{${t.name}|…} has three forms but {${t.name}} is not printed: three forms go next to the printed number, two otherwise (§7)`]);
    }
    if (t.kind !== 'value' || t.form || !numeric(t.name)) return;
    const next = seq[i + 1];
    if (typeof next !== 'string') return;
    const m = /^[ \u00A0\u202F]+([\p{L}²]+)/u.exec(next);
    if (m && /[а-яё]/i.test(m[1]) && !INVARIABLE.has(m[1]) && !INVARIABLE.has(m[1].toLowerCase())) {
      out.push(['plural', `{${t.name}} is followed by «${m[1]}»: write {${t.name}} {${t.name}|one|few|many} (§7)`]);
      return;
    }
    if (/^[ \u00A0\u202F]+$/.test(next)) {
      const after = seq[i + 2];
      if (after && typeof after !== 'string' && after.kind === 'plural' && after.name === t.name && after.choices.length !== 3) {
        out.push(['plural', `{${t.name}} {${t.name}|…}: right after the printed number use three forms, one|few|many (§7)`]);
      }
    }
  });
  return out;
}

/**
 * Placeholder problems of a template: [rule, detail]. `spec(name)` -> undefined (unknown param) or {type, …}:
 *   number | yrs                   value (prints), plural (2, or 2|3 in ru), option only with `options` (a count)
 *   sev                            value (the default phrase), option (exactly 3)
 *   pick                           option (exactly options), never printed
 *   bool                           option (exactly 2)
 *   index                          option (exactly options)
 *   player | text | nested | code | special | derived | rows   value; forms from `forms`
 *   cat                            value with a case form or none
 *   list                           value, @and
 *   rp                             value, @bare
 *   protocol                       value only in English (never printed in Russian)
 *   enum                           nothing (a function picks by it)
 * `ru`: Russian rules (2 or 3 plural forms; protocol identifiers not printed).
 */
export function placeholderLint(template, spec, { ru = false } = {}) {
  const out = [];
  for (const t of core.placeholders(template)) {
    const s = spec(t.name);
    const at = `{${t.name}${t.form ? `@${t.form}` : t.kind === 'plural' ? '|…' : t.kind === 'option' ? ':…' : ''}}`;
    if (!s) { out.push(['param', `${at}: no such param here`]); continue; }
    const ty = s.type;
    if (t.kind === 'plural') {
      if (!['number', 'yrs'].includes(ty)) out.push(['plural', `${at}: a plural selector needs a number (${ty})`]);
      else if (ru ? ![2, 3].includes(t.choices.length) : t.choices.length !== 2) out.push(['plural', `${at}: ${t.choices.length} forms (${ru ? '2 or 3' : '2'} expected)`]);
      continue;
    }
    if (t.kind === 'option') {
      const want = ty === 'bool' ? 2 : ty === 'sev' ? 3 : ['pick', 'index', 'number', 'yrs', 'enumIndex'].includes(ty) ? s.options : undefined;
      if (want === undefined) out.push(['option', `${at}: an option selector needs a boolean or an index (${ty})`]);
      else if (t.choices.length !== want) out.push(['option', `${at}: ${t.choices.length} options, ${want} expected`]);
      continue;
    }
    const form = t.form;
    switch (ty) {
      case 'number':
        if (form) out.push(['form', `${at}: a number takes no form`]);
        break;
      case 'yrs': case 'sev':
        if (form && form !== 'cap') out.push(['form', `${at}: only @cap`]);
        break;
      case 'pick':
        out.push(['option', `${at}: an option param cannot be printed: use {${t.name}:option|…} (§6.3)`]);
        break;
      case 'bool': case 'index': case 'enum': case 'enumIndex':
        out.push(['option', `${at}: ${ty === 'bool' ? 'a boolean' : 'an index'} cannot be printed: pick with {${t.name}:…}`]);
        break;
      case 'cat':
        if (form && !['nom', 'acc', 'gen', 'dat', 'ins', 'loc', 'cap'].includes(form)) out.push(['form', `${at}: a category takes a case (@acc, @gen, …)`]);
        break;
      case 'list':
        if (form && form !== 'and') out.push(['form', `${at}: a list takes only @and`]);
        break;
      case 'rp':
        if (form && form !== 'bare') out.push(['form', `${at}: a round prefix takes only @bare`]);
        break;
      case 'protocol':
        if (ru) out.push(['protocol', `${at}: a protocol identifier is Latin: leave it out of Russian text (§5)`]);
        else if (form) out.push(['form', `${at}: no form`]);
        break;
      case 'player':
        if (form) out.push(['form', `${at}: a player's name is never declined or changed (§10.3)`]);
        break;
      default:
        if (form && form !== 'cap') out.push(['form', `${at}: only @cap`]);
    }
  }
  return out;
}

// ---- the report ---------------------------------------------------------------------------------------------------

/** Collects problems ({level: 'error'|'missing', area, file, key, rule, msg}), review lines and sample lines. */
export class Report {
  constructor() {
    this.problems = [];
    this.reviews = [];
    this.samples = [];
    this.notes = [];
    this.stats = {};
    this.seen = new Set();
  }

  add(level, area, file, key, rule, msg) {
    const id = `${level}\u0000${file}\u0000${key}\u0000${rule}`;
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.problems.push({ level, area, file, key, rule, msg });
  }

  error(area, file, key, rule, msg) { this.add('error', area, file, key, rule, msg); }

  missing(area, file, key, complete, what = 'no Russian entry') {
    this.add(complete ? 'error' : 'missing', area, file, key, 'missing', complete ? `${what}, but the file exports COMPLETE = true` : what);
  }

  note(msg) { this.notes.push(msg); }

  review(area, file, key, words, text) { this.reviews.push({ area, file, key, words, text: String(text) }); }

  sample(section, line) { this.samples.push(`${section}\t${line}`); }

  text(area, file, key, text, opts) {
    this.stats.renders = (this.stats.renders || 0) + 1;
    for (const [rule, msg] of textProblems(text, opts)) this.error(area, file, key, rule, msg);
  }

  source(area, file, key, src) {
    const code = typeof src === 'function';
    for (const [rule, msg] of sourceProblems(code ? src.toString() : src, code)) this.error(area, file, key, rule, msg);
  }

  lints(area, file, key, list) {
    for (const [rule, msg] of list) this.error(area, file, key, rule, msg);
  }
}

/** Runs fn with console.warn captured: {value, warnings, error}. */
function captured(fn) {
  const warnings = [];
  const prev = console.warn;
  console.warn = (...a) => warnings.push(a.map(String).join(' '));
  try {
    return { value: fn(), warnings };
  } catch (error) {
    return { error, warnings };
  } finally {
    console.warn = prev;
  }
}

// ---- content ------------------------------------------------------------------------------------------------------

const POOL_FILES = ['professions', 'health', 'hobbies', 'phobias', 'skills', 'traits', 'baggage'];
const FORMS = ['label', 'nom', 'acc', 'gen', 'dat', 'ins', 'loc'];
// §10.1: the binding words.
const GLOSSARY_LABELS = {
  profession: ['Профессия', 'профессию', 'профессии'], biology: ['Биология', 'биологию', 'биологии'],
  health: ['Здоровье', 'здоровье', 'здоровья'], hobby: ['Хобби', 'хобби', 'хобби'], phobia: ['Фобия', 'фобию', 'фобии'],
  skill: ['Навык', 'навык', 'навыка'], trait: ['Характер', 'характер', 'характера'], baggage: ['Багаж', 'багаж', 'багажа'],
};
const GLOSSARY_TITLES = { airlock: 'Шлюз', revive: 'Вернулся из леса' };
// Named-template params of ../server/content/<lang>/mods.js and bunker.js: [params (name: type), required].
const MOD_N = (lo, hi) => ({ params: { n: { type: 'number', lo, hi } }, required: [['n']] });
const MODS_SPEC = {
  yrs: MOD_N(1, 12),
  'profession.exp': MOD_N(1, 30),
  'profession.intern1': { params: {}, required: [] },
  'profession.intern': MOD_N(1, 11),
  'profession.retired': MOD_N(20, 42),
  'profession.student': { params: { n: { type: 'number', lo: 1, hi: 5 }, i: { type: 'index', options: 5, lo: 0, hi: 4 } }, required: [['n', 'i']] },
  'profession.self': MOD_N(1, 15),
  'profession.award': MOD_N(15, 35),
  'profession.revoked': MOD_N(2, 20),
  'profession.fake': MOD_N(1, 10),
  'hobby.years': MOD_N(1, 20),
  'hobby.childhood': { params: {}, required: [] },
  'hobby.started': { params: {}, required: [] },
  'hobby.semipro': MOD_N(3, 20),
  'hobby.obsessed': MOD_N(1, 15),
};
const WRAP_SPEC = { params: { base: { type: 'text' }, mod: { type: 'text' } }, required: [['base'], ['mod']] };
const BUNKER_SPEC = {
  'name.nick': { params: { nick: { type: 'text' } }, required: [['nick']] },
  'name.shelter': { params: { n: { type: 'number', lo: 2, hi: 99 } }, required: [['n']] },
  'name.object': { params: { n: { type: 'number', lo: 10, hi: 999 }, letter: { type: 'text' }, nick: { type: 'text' } }, required: [['n'], ['letter'], ['nick']] },
  'name.fallback': { params: {}, required: [] },
  size: { params: { n: { type: 'number', lo: 60, hi: 300 } }, required: [['n']] },
  duration: { params: { months: { type: 'text' } }, required: [['months']] },
  food: { params: { months: { type: 'text' } }, required: [['months']] },
};
const SAFE_SPEC = { params: { range: { type: 'text' } }, required: [['range']] };
// Stand-ins for Russian words an entry depends on while they are missing, so that the entry itself is checked.
const STANDIN = {
  sev: ['лёгкая форма', 'средняя форма', 'тяжёлая форма'],
  yrs: '{n} {n|год|года|лет}',
  months: (v, f) => `${f.num(v.m)} ${f.pl(v.m, 'месяц', 'месяца', 'месяцев')}`,
  range: (v, f) => `от ${f.num(v.lo)} до ${f.num(v.hi)} ${f.pl(v.hi, 'месяца', 'месяцев', 'месяцев')}`,
  word: 'слово',
};
/** Every duration in months the dealer can print: 1..5, multiples of 3 to 15, multiples of 6 to 240 (food x2). */
const MONTHS = [1, 2, 3, 4, 5, 6, 9, 12, 15, ...Array.from({ length: 38 }, (_, i) => 18 + 6 * i)];

/** Checks a named template (content) against its spec. */
function namedLint(rep, file, key, value, spec) {
  if (typeof value === 'function') return;
  if (typeof value !== 'string') { rep.error('content', file, key, 'type', 'not a template or a function'); return; }
  rep.source('content', file, key, value);
  rep.lints('content', file, key, placeholderLint(value, (n) => spec.params[n], { ru: true }));
  rep.lints('content', file, key, pluralLint(value, (n) => spec.params[n]?.type === 'number'));
  const used = new Set(core.placeholders(value).map((t) => t.name));
  for (const alts of spec.required) {
    if (!alts.some((n) => used.has(n))) rep.error('content', file, key, 'param', `{${alts.join('} or {')}} is left out: English prints it`);
  }
}

/** Renders a named template (or function) over a list of params, checking every result; returns the first text. */
function namedRenders(rep, file, key, value, paramsList) {
  let first = null;
  for (const p of paramsList) {
    const r = captured(() => (typeof value === 'function' ? value(p, core.helpers('ru')) : core.formatText('ru', value, p)));
    if (r.error) { rep.error('content', file, key, 'throw', `throws: ${r.error.message}`); return first; }
    if (r.warnings.length) rep.error('content', file, key, 'warning', r.warnings[0]);
    if (typeof r.value !== 'string') { rep.error('content', file, key, 'type', 'a function must return a string'); return first; }
    rep.text('content', file, key, r.value);
    if (first === null) first = r.value;
  }
  return first;
}

function namedParamsList(spec, extra = {}) {
  const axes = Object.entries(spec.params).map(([n, s]) => (
    s.type === 'number' ? numbersIn(s.lo, s.hi).map((x) => [n, x])
      : s.type === 'index' ? Array.from({ length: s.options }, (_, i) => [n, i])
        : [[n, extra[n] ?? 'текст']]));
  let list = combos(axes, 400).map((c) => Object.fromEntries(c));
  if (spec.params.i && spec.params.n) list = list.filter((p) => p.i === p.n - 1);
  return list.length ? list : [{}];
}

/** The positional spec of an English draw template (design §6.3). */
function positionalSpec(enTemplate, R) {
  const P = R.drawTemplate(enTemplate).params;
  return (name) => {
    if (!/^\d+$/.test(name)) return undefined;
    const p = P[Number(name)];
    if (!p) return undefined;
    if (p.type === 'n') return { type: 'number', options: p.hi + 1 };
    if (p.type === 'yrs') return { type: 'yrs', options: p.hi + 1 };
    if (p.type === 'sev') return { type: 'sev' };
    return { type: 'pick', options: p.options.length };
  };
}

/** The value combinations of an English draw template's params. */
function positionalCombos(enTemplate, R, cap = 600) {
  const P = R.drawTemplate(enTemplate).params;
  return combos(P.map((p) => (p.type === 'n' || p.type === 'yrs' ? numbersIn(p.lo, p.hi)
    : p.type === 'sev' ? [0, 1, 2] : p.options.map((_, i) => i))), cap);
}

/** One positional entry: lints, the exhaustive render, the review words, a sample line. Returns the first render. */
function positionalEntry(rep, R, E, file, key, enTemplate, value, { review = true, sample = true } = {}) {
  if (typeof value !== 'string' && typeof value !== 'function') {
    rep.error('content', file, key, 'type', 'not a template or a function');
    return null;
  }
  const spec = positionalSpec(enTemplate, R);
  if (typeof value === 'string') {
    rep.source('content', file, key, value);
    rep.lints('content', file, key, placeholderLint(value, spec, { ru: true }));
    rep.lints('content', file, key, pluralLint(value, (n) => spec(n)?.type === 'number'));
  } else rep.source('content', file, key, value);
  let first = null;
  let firstV = null;
  for (const v of positionalCombos(enTemplate, R)) {
    if (typeof value === 'function') {
      const raw = captured(() => value(v, core.helpers('ru')));
      if (!raw.error && typeof raw.value !== 'string') { rep.error('content', file, key, 'type', 'a function must return a string'); break; }
    }
    const r = captured(() => E.renderEntry('ru', enTemplate, value, v));
    if (r.error) { rep.error('content', file, key, 'throw', `throws for [${v}]: ${r.error.message}`); break; }
    if (r.warnings.length) rep.error('content', file, key, 'warning', `${r.warnings[0]} (values [${v}])`);
    if (typeof r.value !== 'string') { rep.error('content', file, key, 'type', 'a function must return a string'); break; }
    rep.text('content', file, key, r.value);
    if (first === null) { first = r.value; firstV = v; }
  }
  if (first !== null) {
    if (review) {
      const words = reviewWords(first);
      if (words.length) rep.review('content', file, key, words, first);
    }
    if (sample) rep.sample(`content/${file}`, `${key}\t${E.replay(enTemplate, firstV)}\t${first}`);
  }
  return first;
}

function strayKeys(rep, file, ru, en, where = '') {
  for (const k of Object.keys(isObj(ru) ? ru : {})) {
    if (!hasOwn(en, k)) rep.error('content', file, `${where}${k}`, 'stray', 'a key English does not have');
  }
}

/** Plain Russian text (a title, a nickname, a word): a string, no placeholders, the text checks. */
function plainText(rep, file, key, value, { review = false } = {}) {
  if (typeof value !== 'string' || !value) { rep.error('content', file, key, 'type', 'must be a non-empty string'); return; }
  rep.source('content', file, key, value);
  rep.text('content', file, key, value);
  if (review) {
    const words = reviewWords(value);
    if (words.length) rep.review('content', file, key, words, value);
  }
}

export function checkContent(rep, C) {
  const { EN, RU, COMPLETE, R } = C;
  const miss = (file, key, what) => rep.missing('content', file, key, COMPLETE[file], what);
  const counts = {};
  const count = (file, has) => { const c = counts[file] || (counts[file] = { total: 0, done: 0 }); c.total++; if (has) c.done++; };

  // A renderer over the Russian tables with stand-ins for the words entries depend on (sev, yrs), so an entry is
  // checked on its own while those are missing (they are reported under mods).
  const ruMods = isObj(RU.mods) ? RU.mods : {};
  const sevOk = Array.isArray(ruMods.sev) && ruMods.sev.length === 3 && ruMods.sev.every((x) => typeof x === 'string');
  const E = R.createRenderer({
    en: EN,
    ru: { ...RU, mods: { ...ruMods, sev: sevOk ? ruMods.sev : STANDIN.sev, yrs: typeof ruMods.yrs === 'string' || typeof ruMods.yrs === 'function' ? ruMods.yrs : STANDIN.yrs } },
  }, { warn: (m) => console.warn(m) });

  for (const file of R.CONTENT_FILES) {
    if (!isObj(RU[file])) rep.error('content', file, '', 'type', 'the default export must be an object');
  }

  // labels
  {
    const file = 'labels';
    strayKeys(rep, file, RU.labels, EN.labels);
    for (const id of Object.keys(EN.labels)) {
      const v = own(RU.labels, id);
      count(file, v !== undefined);
      if (v === undefined) { miss(file, id); continue; }
      if (!isObj(v)) { rep.error('content', file, id, 'type', 'a Russian label is an object {label, nom, acc, gen, dat, ins, loc}: Russian inflects it'); continue; }
      for (const k of Object.keys(v)) if (!FORMS.includes(k)) rep.error('content', file, `${id}.${k}`, 'stray', `not one of ${FORMS.join(', ')}`);
      for (const f of FORMS) {
        const w = own(v, f);
        if (w === undefined) { miss(file, `${id}.${f}`, 'no Russian form'); continue; }
        plainText(rep, file, `${id}.${f}`, w);
        if (typeof w !== 'string' || !w) continue;
        if (f === 'label' && w[0] !== w[0].toUpperCase()) rep.error('content', file, `${id}.${f}`, 'case', 'the label is capitalised (chips, headings)');
        if (f !== 'label' && w[0] !== w[0].toLowerCase()) rep.error('content', file, `${id}.${f}`, 'case', 'running-text forms are lower case (§10.3 rule 5)');
      }
      const g = GLOSSARY_LABELS[id];
      if (g) {
        [['label', g[0]], ['acc', g[1]], ['gen', g[2]]].forEach(([f, want]) => {
          if (typeof own(v, f) === 'string' && v[f] !== want) rep.error('glossary', file, `${id}.${f}`, 'glossary', `«${v[f]}»: the glossary (§10.1) says «${want}»`);
        });
      }
      rep.sample('content/labels', `${id}\t${EN.labels[id]}\t${FORMS.map((f) => own(v, f) ?? '—').join(' / ')}`);
    }
  }

  // mods
  {
    const file = 'mods';
    const M = isObj(RU.mods) ? RU.mods : {};
    strayKeys(rep, file, M, EN.mods);
    for (const g of ['profession', 'hobby']) if (isObj(M[g])) strayKeys(rep, file, M[g], EN.mods[g], `${g}.`);
    for (const [key, len] of [['sev', 3], ['phobiaIntensity', 4]]) {
      const v = own(M, key);
      count(file, v !== undefined);
      if (v === undefined) { miss(file, key); continue; }
      if (!Array.isArray(v) || v.length !== len) { rep.error('content', file, key, 'type', `an array of ${len} phrases`); continue; }
      v.forEach((w, i) => plainText(rep, file, `${key}[${i}]`, w));
      rep.sample('content/mods', `${key}\t${EN.mods[key].join(' / ')}\t${v.join(' / ')}`);
    }
    const named = [['yrs', MODS_SPEC.yrs, own(M, 'yrs'), EN.mods.yrs]];
    for (const g of ['profession', 'hobby']) {
      for (const k of Object.keys(EN.mods[g])) named.push([`${g}.${k}`, MODS_SPEC[`${g}.${k}`], own(own(M, g), k), EN.mods[g][k]]);
    }
    for (const w of ['phobiaWrap', 'professionWrap', 'hobbyWrap']) named.push([w, WRAP_SPEC, own(M, w), EN.mods[w]]);
    for (const [key, spec, v, en] of named) {
      count(file, v !== undefined);
      if (v === undefined) { miss(file, key); continue; }
      namedLint(rep, file, key, v, spec);
      const list = namedParamsList(spec, { base: 'Хирург', mod: 'стаж 5 лет' });
      const first = namedRenders(rep, file, key, v, list);
      if (first !== null) {
        rep.sample('content/mods', `${key}\t${core.formatText('en', en, list[0])}\t${first}`);
        const words = reviewWords(first);
        if (words.length && !key.endsWith('Wrap')) rep.review('content', file, key, words, first);
      }
    }
  }

  // the pools
  for (const file of POOL_FILES) {
    const Rf = isObj(RU[file]) ? RU[file] : {};
    strayKeys(rep, file, Rf, EN[file]);
    for (const id of Object.keys(EN[file])) {
      const v = own(Rf, id);
      count(file, v !== undefined);
      if (v === undefined) { miss(file, id); continue; }
      positionalEntry(rep, R, E, file, id, EN[file][id], v);
    }
  }

  // biology
  {
    const file = 'biology';
    const B = isObj(RU.biology) ? RU.biology : {};
    const BE = EN.biology;
    strayKeys(rep, file, B, BE);
    for (const g of ['sex', 'orientation', 'notes']) if (isObj(B[g])) strayKeys(rep, file, B[g], BE[g], `${g}.`);
    const word = (key, v) => {
      if (typeof v === 'string') { plainText(rep, file, key, v); return; }
      if (!isObj(v)) { rep.error('content', file, key, 'type', 'a string or {f, m}'); return; }
      for (const k of Object.keys(v)) if (!['f', 'm'].includes(k)) rep.error('content', file, `${key}.${k}`, 'stray', 'only f and m');
      for (const s of ['f', 'm']) {
        if (own(v, s) === undefined) miss(file, `${key}.${s}`, 'no form for this sex');
        else plainText(rep, file, `${key}.${s}`, v[s]);
      }
    };
    const sexes = { f: null, m: null };
    count(file, own(B, 'sex') !== undefined);
    if (own(B, 'sex') === undefined) miss(file, 'sex');
    else if (!isObj(B.sex)) rep.error('content', file, 'sex', 'type', '{f, m}');
    else for (const s of ['f', 'm']) {
      if (own(B.sex, s) === undefined) miss(file, `sex.${s}`);
      else { plainText(rep, file, `sex.${s}`, B.sex[s]); sexes[s] = B.sex[s]; }
    }
    const oWords = {};
    for (const o of Object.keys(BE.orientation)) {
      const v = own(own(B, 'orientation'), o);
      count(file, v !== undefined);
      if (v === undefined) { miss(file, `orientation.${o}`); continue; }
      word(`orientation.${o}`, v);
      oWords[o] = v;
    }
    const noteTexts = {}; // id -> sex -> [{v, text}]
    for (const id of Object.keys(BE.notes)) {
      const v = own(own(B, 'notes'), id);
      count(file, v !== undefined);
      if (v === undefined) { miss(file, `notes.${id}`); continue; }
      const bySex = isObj(v) ? v : { f: v, m: v };
      if (isObj(v)) for (const k of Object.keys(v)) if (!['f', 'm'].includes(k)) rep.error('content', file, `notes.${id}.${k}`, 'stray', 'only f and m');
      noteTexts[id] = {};
      for (const s of ['f', 'm']) {
        const x = own(bySex, s);
        if (x === undefined) { miss(file, `notes.${id}.${s}`, 'no form for this sex'); continue; }
        const key = isObj(v) ? `notes.${id}.${s}` : `notes.${id}`;
        if (s === 'm' && !isObj(v)) {
          noteTexts[id].m = noteTexts[id].f;
          continue;
        }
        positionalEntry(rep, R, E, file, key, BE.notes[id], x, { sample: false, review: !isObj(v) });
        noteTexts[id][s] = positionalCombos(BE.notes[id], R, 40).map((vals) => {
          const r = captured(() => E.renderEntry('ru', BE.notes[id], x, vals));
          return { v: vals, text: typeof r.value === 'string' ? r.value : STANDIN.word };
        });
      }
    }
    const card = own(B, 'card');
    count(file, card !== undefined);
    if (card === undefined) miss(file, 'card', 'no card() function');
    else if (typeof card !== 'function') rep.error('content', file, 'card', 'type', 'card must be a function (v, f) => string');
    else {
      rep.source('content', file, 'card', card);
      const ages = [18, 19, 20, 21, 22, 24, 25, 31, 34, 44, 51, 61, 71, 85];
      const f = core.helpers('ru');
      let n = 0;
      outer: for (const sex of ['f', 'm']) {
        for (const o of Object.keys(BE.orientation)) {
          const notes = [null];
          for (const id of Object.keys(BE.notes)) for (const x of (noteTexts[id]?.[sex] ?? [{ v: [], text: STANDIN.word }])) notes.push({ id, ...x });
          for (const note of notes) {
            for (const age of ages) {
              const oText = typeof oWords[o] === 'string' ? oWords[o] : isObj(oWords[o]) && typeof oWords[o][sex] === 'string' ? oWords[o][sex] : STANDIN.word;
              const v = {
                sex, age, o, noteId: note ? note.id : null, noteV: note ? note.v : [],
                sexText: typeof sexes[sex] === 'string' ? sexes[sex] : STANDIN.word, oText, noteText: note ? note.text : null,
              };
              const r = captured(() => card(v, f));
              if (r.error) { rep.error('content', file, 'card', 'throw', `throws for ${JSON.stringify(v)}: ${r.error.message}`); break outer; }
              if (r.warnings.length) rep.error('content', file, 'card', 'warning', r.warnings[0]);
              if (typeof r.value !== 'string') { rep.error('content', file, 'card', 'type', 'card() must return a string'); break outer; }
              rep.text('content', file, 'card', r.value);
              if (n++ % 97 === 0) rep.sample('content/biology', `${sex} ${age} ${o} ${note ? `${note.id} [${note.v}]` : '-'}\t${r.value}`);
            }
          }
        }
      }
    }
  }

  // catastrophes
  {
    const file = 'catastrophes';
    const Cr = isObj(RU.catastrophes) ? RU.catastrophes : {};
    const CE = EN.catastrophes;
    strayKeys(rep, file, Cr, CE);
    if (isObj(Cr.list)) strayKeys(rep, file, Cr.list, CE.list, 'list.');
    for (const id of Object.keys(CE.list)) {
      const c = own(own(Cr, 'list'), id);
      count(file, c !== undefined);
      if (c === undefined) { miss(file, `list.${id}`); continue; }
      if (!isObj(c)) { rep.error('content', file, `list.${id}`, 'type', '{title, text, details}'); continue; }
      strayKeys(rep, file, c, CE.list[id], `list.${id}.`);
      for (const k of ['title', 'text']) {
        if (own(c, k) === undefined) miss(file, `list.${id}.${k}`);
        else plainText(rep, file, `list.${id}.${k}`, c[k]);
      }
      const d = own(c, 'details');
      if (d === undefined) { miss(file, `list.${id}.details`); continue; }
      if (!Array.isArray(d) || d.length !== CE.list[id].details.length) {
        rep.error('content', file, `list.${id}.details`, 'type', `an array of ${CE.list[id].details.length} lines, in English's order`);
        continue;
      }
      d.forEach((x, i) => positionalEntry(rep, R, E, file, `list.${id}.details[${i}]`, CE.list[id].details[i], x, { review: false }));
      rep.sample('content/catastrophes', `${id}\t${CE.list[id].title}\t${c.title ?? '—'}`);
    }
    const rangeFn = typeof own(RU.bunker, 'range') === 'function' ? RU.bunker.range : STANDIN.range;
    const safe = own(Cr, 'safe');
    count(file, safe !== undefined);
    if (safe === undefined) miss(file, 'safe');
    else {
      namedLint(rep, file, 'safe', safe, SAFE_SPEC);
      const ranges = [...new Set(Object.values(C.STAY).map((s) => s.join('-')))].map((s) => s.split('-').map(Number));
      const list = ranges.map(([lo, hi]) => { const r = captured(() => rangeFn({ lo, hi }, core.helpers('ru'))); return { range: typeof r.value === 'string' ? r.value : STANDIN.word }; });
      const first = namedRenders(rep, file, 'safe', safe, list);
      if (first !== null) rep.sample('content/catastrophes', `safe\t\t${first}`);
    }
    const fb = own(Cr, 'fallbackTitle');
    count(file, fb !== undefined);
    if (fb === undefined) miss(file, 'fallbackTitle');
    else plainText(rep, file, 'fallbackTitle', fb);
  }

  // bunker
  {
    const file = 'bunker';
    const Bk = isObj(RU.bunker) ? RU.bunker : {};
    const BE = EN.bunker;
    strayKeys(rep, file, Bk, BE);
    for (const g of ['nicknames', 'features', 'name']) if (isObj(Bk[g])) strayKeys(rep, file, Bk[g], BE[g], `${g}.`);
    const nicks = [];
    for (const id of Object.keys(BE.nicknames)) {
      const v = own(own(Bk, 'nicknames'), id);
      count(file, v !== undefined);
      if (v === undefined) { miss(file, `nicknames.${id}`); continue; }
      plainText(rep, file, `nicknames.${id}`, v);
      if (typeof v === 'string') nicks.push(v);
      rep.sample('content/bunker', `nicknames.${id}\t${BE.nicknames[id]}\t${v}`);
    }
    for (const id of Object.keys(BE.features)) {
      const v = own(own(Bk, 'features'), id);
      count(file, v !== undefined);
      if (v === undefined) { miss(file, `features.${id}`); continue; }
      positionalEntry(rep, R, E, file, `features.${id}`, BE.features[id], v, { review: false });
    }
    const letters = own(Bk, 'letters');
    count(file, letters !== undefined);
    let letterList = ['А'];
    if (letters === undefined) miss(file, 'letters');
    else if (typeof letters !== 'string') rep.error('content', file, 'letters', 'type', 'a string of 15 letters');
    else {
      const a = Array.from(letters);
      if (a.length !== Array.from(BE.letters).length) rep.error('content', file, 'letters', 'count', `${a.length} letters: exactly ${Array.from(BE.letters).length}, the dealer draws an index`);
      if (new Set(a).size !== a.length) rep.error('content', file, 'letters', 'count', 'a letter twice');
      if (!a.every((x) => /^[А-ЯЁ]$/.test(x))) rep.error('content', file, 'letters', 'latin', 'capital Cyrillic letters only');
      letterList = a;
    }
    const monthsFn = own(Bk, 'months');
    const monthTexts = MONTHS.map((m) => (typeof monthsFn === 'function' ? captured(() => monthsFn({ m }, core.helpers('ru'))).value : null)).map((x) => (typeof x === 'string' ? x : '3 месяца'));
    for (const [key, spec] of Object.entries(BUNKER_SPEC)) {
      const v = key.startsWith('name.') ? own(own(Bk, 'name'), key.slice(5)) : own(Bk, key);
      count(file, v !== undefined);
      if (v === undefined) { miss(file, key); continue; }
      namedLint(rep, file, key, v, spec);
      let list;
      if (key === 'name.object') list = numbersIn(10, 999).flatMap((n) => letterList.map((letter) => ({ n, letter, nick: nicks[0] ?? 'Кротовина' })));
      else if (key === 'name.nick') list = (nicks.length ? nicks : ['Кротовина']).map((nick) => ({ nick }));
      else if (key === 'duration' || key === 'food') list = monthTexts.map((months) => ({ months }));
      else list = namedParamsList(spec);
      const first = namedRenders(rep, file, key, v, list);
      if (first !== null) rep.sample('content/bunker', `${key}\t${core.formatText('en', key.startsWith('name.') ? BE.name[key.slice(5)] : BE[key], { n: 42, nick: 'Last Hope', letter: 'K', months: '2 years' })}\t${first}`);
    }
    const fnCheck = (key, calls) => {
      const fn = own(Bk, key);
      count(file, fn !== undefined);
      if (fn === undefined) { miss(file, `${key}()`, 'no function'); return; }
      if (typeof fn !== 'function') { rep.error('content', file, key, 'type', 'must be a function (v, f) => string'); return; }
      rep.source('content', file, key, fn);
      for (const [v, en] of calls) {
        const r = captured(() => fn(v, core.helpers('ru')));
        if (r.error) { rep.error('content', file, key, 'throw', `throws for ${JSON.stringify(v)}: ${r.error.message}`); return; }
        if (r.warnings.length) rep.error('content', file, key, 'warning', r.warnings[0]);
        if (typeof r.value !== 'string') { rep.error('content', file, key, 'type', 'must return a string'); return; }
        rep.text('content', file, `${key}()`, r.value);
        rep.sample(`content/bunker ${key}()`, `${JSON.stringify(v)}\t${en}\t${r.value}`);
      }
    };
    const fEn = core.helpers('en');
    fnCheck('months', MONTHS.map((m) => [{ m }, BE.months({ m }, fEn)]));
    const pairs = [...new Set(Object.values(C.STAY).map((s) => s.join('-')))].map((s) => s.split('-').map(Number));
    fnCheck('range', pairs.map(([lo, hi]) => [{ lo, hi }, BE.range({ lo, hi }, fEn)]));
  }

  // specials
  {
    const file = 'specials';
    const S = isObj(RU.specials) ? RU.specials : {};
    strayKeys(rep, file, S, EN.specials);
    for (const id of Object.keys(EN.specials)) {
      const v = own(S, id);
      count(file, v !== undefined);
      if (v === undefined) { miss(file, id); continue; }
      if (!isObj(v)) { rep.error('content', file, id, 'type', '{title, text}'); continue; }
      for (const k of Object.keys(v)) if (!['title', 'text'].includes(k)) rep.error('content', file, `${id}.${k}`, 'stray', 'only title and text');
      for (const k of ['title', 'text']) {
        if (own(v, k) === undefined) { miss(file, `${id}.${k}`); continue; }
        plainText(rep, file, `${id}.${k}`, v[k], { review: true });
      }
      if (typeof v.title === 'string') {
        if (/[«»"]/.test(v.title)) rep.error('content', file, `${id}.title`, 'quotes', 'a title carries no quotes: the log and the chips add «…»');
        if (/[.!]$/.test(v.title)) rep.error('content', file, `${id}.title`, 'period', 'a title has no final period');
        if (GLOSSARY_TITLES[id] && v.title !== GLOSSARY_TITLES[id]) rep.error('glossary', file, `${id}.title`, 'glossary', `«${v.title}»: the glossary (§10.1) says «${GLOSSARY_TITLES[id]}»`);
      }
      rep.sample('content/specials', `${id}\t${EN.specials[id].title}\t${v.title ?? '—'}\t${v.text ?? '—'}`);
    }
  }

  rep.stats.content = Object.fromEntries(Object.entries(counts).map(([f, c]) => [f, { ...c, complete: COMPLETE[f] }]));

  // Whole dealt tables through the real renderer (the sample sheet: what a Russian player sees today).
  for (let seed = 1; seed <= 3; seed++) {
    const d = C.content.createDealer(C.mulberry32(seed));
    const cat = d.drawCatastropheTok();
    const bunker = d.drawBunkerTok();
    const rc = C.content.renderCatastrophe('ru', cat);
    const rb = C.content.renderBunker('ru', bunker);
    rep.sample(`deal seed ${seed}`, `catastrophe\t${rc.title}\t${rc.details.join(' | ')}`);
    rep.sample(`deal seed ${seed}`, `bunker\t${rb.name}\t${[rb.size, rb.duration, rb.food, ...rb.features].join(' | ')}`);
    for (let p = 1; p <= 6; p++) {
      const cards = C.CATEGORY_IDS.map((c) => `${C.content.categoryLabel('ru', c)}: ${C.content.renderCard('ru', d.drawCardTok(c))}`);
      rep.sample(`deal seed ${seed}`, `player ${p}\t${cards.join(' | ')}`);
    }
  }
}

// ---- server messages ------------------------------------------------------------------------------------------------

const PLAYERS = [{ p: 'p1', n: 'Анна' }, { p: 'p2', n: 'Bot Anna' }, { p: 'p3', n: '🚪 «Эд» "Q"' }];
const PLAYER_NAMES = PLAYERS.map((x) => x.n);
/** Render problems that synthetic params can cause in English too (an empty list at the end of a line). */
const STRUCTURAL = new Set(['edge space', 'double space', 'braces']);
const NUMS = [0, 1, 2, 4, 5, 11, 12, 21, 22];

/** The candidate values of a SCHEMA param type (server/i18n/index.js). */
function schemaCandidates(type, schema, depth = 0) {
  if (Array.isArray(type)) {
    const row = (i) => Object.fromEntries(Object.entries(type[0]).map(([k, t]) => {
      const c = schemaCandidates(t, schema, depth + 1);
      return [k, c[Math.min(c.length - 1, (i + 1) % c.length)]];
    }));
    return [[], [row(0)], [row(0), row(1), row(2)]];
  }
  const [base, rest] = String(type).split(/:(.*)/s);
  switch (base) {
    case 'player': return PLAYERS;
    case 'player[]': return [[], [PLAYERS[0]], PLAYERS];
    case 'num': return NUMS;
    case 'bool': return [false, true];
    case 'enum': return rest.split('|');
    case 'int': return rest.split('|').map(Number);
    case 'id': return rest.split('|');
    case 'cat': return Object.keys(GLOSSARY_LABELS).map((cat) => ({ cat }));
    case 'card': return [{ tok: { lit: 'Кирпич' } }];
    case 'feat': return [{ feat: { lit: 'Потайная кладовка' } }];
    case 'special': return [{ sp: { id: 'protect-alibi', ref: null, title: 'Алиби', text: 'Выбери другого игрока.' } }, { sp: { id: 'x', ref: null, title: 'Карта', text: '' } }];
    case 'cata': return [{ cata: { lit: { title: 'Ядерная зима', text: '', details: [] } } }];
    case 'bname': return [{ bname: { lit: 'Бункер «Кротовина»' } }];
    case 'rp': return [{ r: 1, ot: false }, { r: 7, ot: false }, { r: 7, ot: true }];
    case 'text': return ['Текст'];
    case 'msg': case 'msg?': case 'msg[]': {
      const keys = rest.split('|');
      const msgs = depth > 3 ? [] : keys.map((key) => ({ msg: { key, params: representative(key, schema, depth + 1) } }));
      if (base === 'msg?') return [null, ...msgs];
      if (base === 'msg[]') return [[], msgs.slice(0, 1), [0, 1, 2].map((i) => msgs[i % msgs.length])];
      return msgs;
    }
    default: return [undefined];
  }
}

function representative(key, schema, depth) {
  const s = schema[key];
  if (!s) return {};
  return Object.fromEntries(Object.entries(s.params).map(([n, t]) => {
    const c = schemaCandidates(t, schema, depth);
    return [n, c[Math.min(1, c.length - 1)]];
  }));
}

/** A SCHEMA type as the placeholder lint's spec. */
function schemaSpec(type) {
  if (Array.isArray(type)) return { type: 'rows' };
  const [base, rest] = String(type).split(/:(.*)/s);
  switch (base) {
    case 'num': return { type: 'number' };
    case 'bool': return { type: 'bool' };
    case 'int': return { type: 'index', options: Math.max(...rest.split('|').map(Number)) + 1 };
    case 'enum': return { type: 'enum' };
    case 'player': return { type: 'player' };
    case 'player[]': return { type: 'list' };
    case 'cat': return { type: 'cat' };
    case 'rp': return { type: 'rp' };
    case 'id': return { type: 'protocol' };
    case 'special': return { type: 'special' };
    case 'msg': case 'msg?': case 'msg[]': return { type: base === 'msg[]' ? 'list' : 'nested' };
    default: return { type: 'text' };
  }
}

export function checkMessages(rep, M, C) {
  const { EN, RU, COMPLETE: complete, SCHEMA, isDevKey, renderValue, traceKeys, setWarn } = M;
  const area = 'messages';
  const file = 'server/i18n/ru.js';
  let done = 0;
  let total = 0;
  for (const k of Object.keys(RU)) if (!hasOwn(EN, k)) rep.error(area, file, k, 'stray', 'a key server/i18n/en.js does not have');
  const specOf = (key) => {
    const s = SCHEMA[key] || { params: {} };
    return (name) => (hasOwn(s.params, name) ? schemaSpec(s.params[name])
      : DERIVED.has(name) && (s.derived || []).includes(name) ? { type: 'derived' } : undefined);
  };
  // English: param names (§7.1) and placeholders, for every key that is not dev-only.
  for (const [key, v] of Object.entries(EN)) {
    if (isDevKey(key)) continue;
    const s = SCHEMA[key];
    if (s) for (const n of Object.keys(s.params)) if (!hasOwn(PARAM_TYPES, n)) rep.error(area, 'server/i18n/en.js', key, 'name', `param "${n}" is not a §7.1 name`);
    if (typeof v === 'string') rep.lints(area, 'server/i18n/en.js', key, placeholderLint(v, specOf(key)));
  }
  const ruLabels = C ? C.RU.labels : {};
  const labelMissing = (id) => !isObj(own(ruLabels, id));
  let warnings = [];
  setWarn((m) => warnings.push(String(m)));
  try {
    for (const key of Object.keys(EN)) {
      const dev = isDevKey(key);
      if (!hasOwn(RU, key)) {
        if (!dev) { total++; rep.missing(area, file, key, complete); }
        continue;
      }
      if (!dev) { total++; done++; }
      const value = RU[key];
      if (typeof value !== 'string' && typeof value !== 'function') { rep.error(area, file, key, 'type', 'a template or a function (p, f)'); continue; }
      const spec = specOf(key);
      if (typeof value === 'string') {
        rep.source(area, file, key, value);
        rep.lints(area, file, key, placeholderLint(value, spec, { ru: true }));
        rep.lints(area, file, key, pluralLint(value, (n) => spec(n)?.type === 'number'));
      } else rep.source(area, file, key, value);
      const s = SCHEMA[key] || { params: {} };
      const names = Object.keys(s.params);
      const list = combos(names.map((n) => schemaCandidates(s.params[n], SCHEMA)), 600).map((c) => Object.fromEntries(names.map((n, i) => [n, c[i]])));
      let first = null;
      for (const params of list) {
        warnings = [];
        let out;
        let err = null;
        const traced = traceKeys(() => { try { out = renderValue('ru', value, params); } catch (e) { err = e; } });
        if (err) { rep.error(area, file, key, 'throw', `throws: ${err.message} (params ${short(JSON.stringify(params), 120)})`); break; }
        const deps = [...traced].filter((k) => k !== key && !hasOwn(RU, k));
        const cats = JSON.stringify(params).match(/"cat":"(\w+)"/g)?.map((x) => x.slice(7, -1)).filter(labelMissing) ?? [];
        for (const w of warnings) if (!/English is used/.test(w)) rep.error(area, file, key, 'warning', w);
        const text = out.text;
        const deferred = deps.length > 0 || cats.length > 0;
        if (deferred) rep.stats.deferred = (rep.stats.deferred || 0) + 1;
        let enText;
        rep.stats.renders = (rep.stats.renders || 0) + 1;
        for (const [rule, msg] of textProblems(text, { allowed: PLAYER_NAMES, fragment: FRAGMENT.test(key) })) {
          if (rule === 'latin' && (deferred || dev)) continue;
          if (STRUCTURAL.has(rule)) {
            // the same problem in English with the same params: the synthetic params, not the translation
            if (enText === undefined) { try { enText = M.renderValue('en', EN[key], params).text; } catch { enText = ''; } }
            if (textProblems(enText, { fragment: FRAGMENT.test(key) }).some(([r]) => r === rule)) continue;
          }
          rep.error(area, file, key, rule, msg);
        }
        if (first === null) first = text;
      }
      if (first !== null) {
        rep.sample('messages', `${key}\t${short(first, 400)}`);
        const hasPlayer = names.some((n) => PLAYER_PARAMS.has(n) || /player/.test(String(s.params[n])));
        const words = reviewWords(typeof value === 'string' ? value : first);
        if (words.length && (hasPlayer || YOU.test(first))) rep.review(area, file, key, words, typeof value === 'string' ? value : first);
      }
    }
  } finally {
    setWarn((m) => console.warn(`[i18n] ${m}`));
  }
  rep.stats.messages = { total, done, complete };
}

// ---- the client ---------------------------------------------------------------------------------------------------

function clientCandidates(name, enChoices) {
  const ty = PARAM_TYPES[name];
  switch (ty) {
    case 'number': return NUMS;
    case 'player': return PLAYER_NAMES;
    case 'cat': return Object.keys(GLOSSARY_LABELS);
    case 'list': return [[], ['Анна'], ['Анна', 'Bot Anna', 'Вера']];
    case 'text': case 'nested': return ['Кириллица'];
    case 'code': return ['ABCD', 'QWXZ'];
    case 'bool': return [false, true];
    case 'enum': return Array.from({ length: enChoices ?? 3 }, (_, i) => i);
    case 'rp': return ['Раунд 3 — '];
    case 'protocol': return ['room'];
    default: return ['Кириллица'];
  }
}

function clientSpec(name, enOptions) {
  const ty = PARAM_TYPES[name];
  if (!ty) return undefined;
  if (ty === 'enum') return { type: 'enumIndex', options: enOptions.get(name) ?? 0 };
  if (ty === 'code' || ty === 'nested') return { type: 'text' };
  return { type: ty };
}

export function checkClient(rep, K, C) {
  const { EN, RU, COMPLETE: complete, t, setLang } = K;
  const area = 'client';
  const file = 'public/i18n/ru.js';
  for (const k of Object.keys(RU)) if (!hasOwn(EN, k)) rep.error(area, file, k, 'stray', 'a key public/i18n/en.js does not have');
  let done = 0;
  const enInfo = (v) => {
    const ph = typeof v === 'string' ? core.placeholders(v) : [];
    const names = new Set(ph.map((x) => x.name));
    const options = new Map(ph.filter((x) => x.kind === 'option').map((x) => [x.name, x.choices.length]));
    return { names, options, fn: typeof v === 'function' };
  };
  for (const [key, v] of Object.entries(EN)) {
    const { names, options } = enInfo(v);
    for (const n of names) if (!hasOwn(PARAM_TYPES, n)) rep.error(area, 'public/i18n/en.js', key, 'name', `param "${n}" is not a §7.1 name`);
    if (typeof v === 'string') rep.lints(area, 'public/i18n/en.js', key, placeholderLint(v, (n) => clientSpec(n, options)));
  }
  const ruHas = (k) => hasOwn(RU, k) && typeof RU[k] === 'string';
  const catMissing = (id, form) => !ruHas(`cat.${id}`) || (form && ['acc', 'gen', 'dat'].includes(form) && !ruHas(`cat.${id}.${form}`));
  setLang('ru', { store: false });
  try {
    for (const key of Object.keys(EN)) {
      if (!hasOwn(RU, key)) { rep.missing(area, file, key, complete); continue; }
      done++;
      const value = RU[key];
      const en = enInfo(EN[key]);
      if (typeof value !== 'string' && typeof value !== 'function') { rep.error(area, file, key, 'type', 'a template or a function (params, f)'); continue; }
      const spec = (n) => ((en.fn || en.names.has(n)) ? clientSpec(n, en.options) : undefined);
      let names = [...en.names];
      if (typeof value === 'string') {
        rep.source(area, file, key, value);
        rep.lints(area, file, key, placeholderLint(value, spec, { ru: true }));
        rep.lints(area, file, key, pluralLint(value, (n) => PARAM_TYPES[n] === 'number'));
        names = [...new Set([...names, ...core.placeholders(value).map((x) => x.name).filter((n) => hasOwn(PARAM_TYPES, n))])];
      } else rep.source(area, file, key, value);
      const ph = typeof value === 'string' ? core.placeholders(value) : [];
      const catForms = ph.filter((x) => x.name === 'cat').map((x) => x.form);
      const allowed = [...PLAYER_NAMES, 'Bot Anna', 'ABCD', 'QWXZ', ...(CLIENT_LATIN[key] || []), ...(key.startsWith('lang.') || /^(EN|RU)$/.test(String(EN[key])) ? ['EN', 'RU'] : [])];
      const list = combos(names.map((n) => clientCandidates(n, en.options.get(n))), 400).map((c) => Object.fromEntries(names.map((n, i) => [n, c[i]])));
      let first = null;
      for (const params of list) {
        const r = captured(() => t(key, params));
        if (r.error) { rep.error(area, file, key, 'throw', `throws: ${r.error.message}`); break; }
        for (const w of r.warnings) rep.error(area, file, key, 'warning', w);
        const text = String(r.value);
        const deferred = typeof params.cat === 'string' && (catForms.length ? catForms : [undefined]).some((f) => catMissing(params.cat, f));
        if (deferred) rep.stats.deferred = (rep.stats.deferred || 0) + 1;
        let enText;
        rep.stats.renders = (rep.stats.renders || 0) + 1;
        for (const [rule, msg] of textProblems(text, { allowed })) {
          if (rule === 'latin' && deferred) continue;
          if (STRUCTURAL.has(rule)) {
            if (enText === undefined) {
              setLang('en', { store: false });
              enText = captured(() => t(key, params)).value ?? '';
              setLang('ru', { store: false });
            }
            if (textProblems(String(enText)).some(([r]) => r === rule)) continue;
          }
          rep.error(area, file, key, rule, msg);
        }
        if (first === null) first = text;
      }
      if (first !== null) {
        rep.sample('client', `${key}\t${short(first, 400)}`);
        const words = reviewWords(typeof value === 'string' ? value : first);
        if (words.length && (names.some((n) => PLAYER_PARAMS.has(n)) || YOU.test(first))) rep.review(area, file, key, words, typeof value === 'string' ? value : first);
      }
    }
  } finally {
    setLang('en', { store: false });
  }
  rep.stats.client = { total: Object.keys(EN).length, done, complete };
}

// ---- the glossary across catalogues ------------------------------------------------------------------------------

export function checkGlossary(rep, C, M, K) {
  const area = 'glossary';
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (K) {
    // every client string that names a special in English names it in Russian
    for (const [id, card] of Object.entries(C.EN.specials)) {
      const ru = own(own(C.RU.specials, id), 'title');
      if (typeof ru !== 'string') continue;
      const re = new RegExp(`(?<![A-Za-z])${esc(card.title)}(?![A-Za-z])`);
      for (const [key, en] of Object.entries(K.EN)) {
        if (typeof en !== 'string' || !re.test(en) || typeof own(K.RU, key) !== 'string') continue;
        if (!K.RU[key].toLowerCase().includes(ru.toLowerCase())) {
          rep.error(area, 'public/i18n/ru.js', key, 'glossary', `English names the card "${card.title}": the Russian must name «${ru}» (server/content/ru/specials.js)`);
        }
      }
    }
    // the category labels and their shared case forms
    for (const id of Object.keys(C.EN.labels)) {
      const s = own(C.RU.labels, id);
      if (!isObj(s)) continue;
      for (const [f, ck] of [['label', `cat.${id}`], ['acc', `cat.${id}.acc`], ['gen', `cat.${id}.gen`], ['dat', `cat.${id}.dat`]]) {
        const a = own(s, f);
        const b = own(K.RU, ck);
        if (typeof a === 'string' && typeof b === 'string' && a !== b) {
          rep.error(area, 'public/i18n/ru.js', ck, 'glossary', `«${b}», but server/content/ru/labels.js ${id}.${f} is «${a}»`);
        }
      }
    }
  }
  if (M) {
    const word = own(M.RU, 'word.airlock');
    const title = own(own(C.RU.specials, 'airlock'), 'title');
    if (typeof word === 'string' && typeof title === 'string' && word.toLowerCase() !== title.toLowerCase()) {
      rep.error(area, 'server/i18n/ru.js', 'word.airlock', 'glossary', `«${word}», but the card is «${title}»: the chip word is the card's title in lower case`);
    }
    const q = own(M.RU, 'fmt.quote');
    if (typeof q === 'string' && q !== '«{title}»') rep.error(area, 'server/i18n/ru.js', 'fmt.quote', 'glossary', `${q}: card titles are quoted «{title}» (§10.3 rule 5)`);
  }
}

// ---- loading, the review list, the whole check ----------------------------------------------------------------------

async function tryImport(file) {
  if (!fs.existsSync(file)) return { missing: true };
  try {
    return { mod: await import(pathToFileURL(file).href) };
  } catch (error) {
    return { error };
  }
}

/** Loads public/i18n/core.js, which the lints use (load() and check() do it). */
export async function init(root = ROOT) {
  core = await import(pathToFileURL(path.join(root, 'public/i18n/core.js')).href);
  return core;
}

/** Loads everything; a catalogue whose files are missing or broken is null, with a note. */
export async function load(root = ROOT) {
  const out = { notes: [], errors: [] };
  out.core = await init(root);
  const R = await import(pathToFileURL(path.join(root, 'server/content/render.js')).href);
  const G = await import(pathToFileURL(path.join(root, 'server/content/gen.js')).href);
  const content = await import(pathToFileURL(path.join(root, 'server/content.js')).href);
  const { mulberry32 } = await import(pathToFileURL(path.join(root, 'server/rng.js')).href);
  out.C = { EN: R.TABLES.en, RU: R.TABLES.ru, COMPLETE: R.COMPLETE.ru, R, STAY: G.STAY, CATEGORY_IDS: G.CATEGORY_IDS, content, mulberry32 };

  const idx = await tryImport(path.join(root, 'server/i18n/index.js'));
  const en = await tryImport(path.join(root, 'server/i18n/en.js'));
  const ru = await tryImport(path.join(root, 'server/i18n/ru.js'));
  if (idx.error || en.error || ru.error) out.errors.push(['messages', 'server/i18n', `cannot load: ${(idx.error || en.error || ru.error).message}`]);
  else if (idx.missing || en.missing || ru.missing || typeof idx.mod.renderValue !== 'function' || !idx.mod.SCHEMA) {
    out.notes.push('server messages skipped: server/i18n/{index,en,ru}.js (with SCHEMA and renderValue) are not all there yet');
  } else {
    const m = idx.mod;
    out.M = {
      EN: en.mod.default, RU: isObj(ru.mod.default) ? ru.mod.default : {}, COMPLETE: ru.mod.COMPLETE === true, SCHEMA: m.SCHEMA,
      isDevKey: typeof m.isDevKey === 'function' ? m.isDevKey : () => false, renderValue: m.renderValue,
      traceKeys: typeof m.traceKeys === 'function' ? m.traceKeys : (fn) => { fn(); return new Set(); },
      setWarn: typeof m.setWarn === 'function' ? m.setWarn : () => {},
    };
  }

  const cidx = await tryImport(path.join(root, 'public/i18n/index.js'));
  const cen = await tryImport(path.join(root, 'public/i18n/en.js'));
  const cru = await tryImport(path.join(root, 'public/i18n/ru.js'));
  if (cidx.error || cen.error || cru.error) out.errors.push(['client', 'public/i18n', `cannot load: ${(cidx.error || cen.error || cru.error).message}`]);
  else if (cidx.missing || cen.missing || cru.missing || typeof cidx.mod.t !== 'function' || typeof cidx.mod.setLang !== 'function') {
    out.notes.push('client strings skipped: public/i18n/{index,en,ru}.js (with t and setLang) are not all there yet');
  } else {
    out.K = { EN: cen.mod.default, RU: isObj(cru.mod.default) ? cru.mod.default : {}, COMPLETE: cru.mod.COMPLETE === true, t: cidx.mod.t, setLang: cidx.mod.setLang };
  }
  return out;
}

const reviewId = (r) => `${r.file}\t${r.key}\t${r.text.replace(/\s+/g, ' ')}`;

/** Reads the marks of an existing review list: id -> 'ok' | 'fix'. */
export function readMarks(file) {
  const marks = new Map();
  if (!fs.existsSync(file)) return marks;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [mark, , fileName, key, , text] = line.split('\t');
    if (mark === 'ok' || mark === 'fix') marks.set(`${fileName}\t${key}\t${text}`, mark);
  }
  return marks;
}

function reviewText(reviews, marks) {
  const head = [
    '# Gender review list (reports/i18n-design.md §11): every Russian string with a player or «ты» and a word that looks',
    '# like a past tense or a short participle, and every card or special with such a word. Mark the first column ok or',
    '# fix (tab-separated; the checker keeps the marks when it rewrites this file). The release gate needs every line',
    '# marked and none marked fix.',
    '# mark\tarea\tfile\tkey\twords\ttext',
  ];
  return `${[...head, ...reviews.map((r) => `${marks.get(reviewId(r)) ?? '?'}\t${r.area}\t${r.file}\t${r.key}\t${r.words.join(' ')}\t${r.text.replace(/\s+/g, ' ')}`)].join('\n')}\n`;
}

/**
 * The whole check: {problems, reviews, samples, notes, stats, ok}. `gate`: the release gate's extra rules. `out`: the
 * directory with gender-review.txt (its marks are read for the gate).
 */
export async function check({ root = ROOT, gate = false, out = path.join(ROOT, '.scratch/i18n-qa') } = {}) {
  const L = await load(root);
  const rep = new Report();
  for (const n of L.notes) rep.note(n);
  for (const [area, file, msg] of L.errors) rep.error(area, file, '', 'load', msg);
  checkContent(rep, L.C);
  if (L.M) checkMessages(rep, L.M, L.C);
  if (L.K) checkClient(rep, L.K, L.C);
  checkGlossary(rep, L.C, L.M, L.K);
  if (gate) {
    for (const [f, c] of Object.entries(L.C.COMPLETE)) if (!c) rep.error('gate', `server/content/ru/${f}.js`, '', 'complete', 'not COMPLETE');
    if (!L.M || !L.M.COMPLETE) rep.error('gate', 'server/i18n/ru.js', '', 'complete', 'not COMPLETE');
    if (!L.K || !L.K.COMPLETE) rep.error('gate', 'public/i18n/ru.js', '', 'complete', 'not COMPLETE');
    const marks = readMarks(path.join(out, 'gender-review.txt'));
    for (const r of rep.reviews) {
      const m = marks.get(reviewId(r));
      if (m !== 'ok') rep.error('gate', r.file, r.key, 'review', m === 'fix' ? 'marked fix in the gender review list' : 'not marked in the gender review list');
    }
  }
  const errors = rep.problems.filter((p) => p.level === 'error');
  return { problems: rep.problems, errors, reviews: rep.reviews, samples: rep.samples, notes: rep.notes, stats: rep.stats, ok: errors.length === 0 };
}

/** Writes <out>/gender-review.txt (keeping QA's marks) and <out>/ru-sample.txt. */
export function write(result, out) {
  fs.mkdirSync(out, { recursive: true });
  const reviewFile = path.join(out, 'gender-review.txt');
  fs.writeFileSync(reviewFile, reviewText(result.reviews, readMarks(reviewFile)));
  fs.writeFileSync(path.join(out, 'ru-sample.txt'), `# Russian as rendered today (section, key, English, Russian); written by tools/i18n-check.js\n${result.samples.join('\n')}\n`);
  return [reviewFile, path.join(out, 'ru-sample.txt')];
}

// ---- CLI ------------------------------------------------------------------------------------------------------------

function summary(result) {
  const lines = [];
  const s = result.stats;
  const pct = (d, t) => `${d}/${t}`;
  if (s.content) {
    lines.push('content (server/content/ru):');
    for (const [f, c] of Object.entries(s.content)) lines.push(`  ${f.padEnd(13)} ${pct(c.done, c.total).padStart(9)}  ${c.complete ? 'COMPLETE' : ''}`);
  }
  if (s.messages) lines.push(`messages (server/i18n/ru.js): ${pct(s.messages.done, s.messages.total)} ${s.messages.complete ? 'COMPLETE' : ''}`);
  if (s.client) lines.push(`client (public/i18n/ru.js):   ${pct(s.client.done, s.client.total)} ${s.client.complete ? 'COMPLETE' : ''}`);
  if (s.renders) lines.push(`${s.renders} Russian renders checked`);
  if (s.deferred) lines.push(`${s.deferred} renders not checked for Latin yet: they use a Russian entry that is still missing elsewhere`);
  return lines.join('\n');
}

async function main(argv) {
  const has = (f) => argv.includes(f);
  const at = argv.indexOf('--out');
  const out = at >= 0 && argv[at + 1] ? path.resolve(argv[at + 1]) : path.join(ROOT, '.scratch/i18n-qa');
  const result = await check({ gate: has('--gate'), out });
  if (has('--json')) {
    process.stdout.write(`${JSON.stringify({ ok: result.ok, stats: result.stats, notes: result.notes, problems: result.problems, reviews: result.reviews.length }, null, 2)}\n`);
  } else {
    for (const n of result.notes) console.log(`note: ${n}`);
    const missing = result.problems.filter((p) => p.level === 'missing');
    if (!has('--quiet') && missing.length) {
      const byFile = new Map();
      for (const p of missing) byFile.set(p.file, [...(byFile.get(p.file) || []), p.key]);
      for (const [f, keys] of byFile) console.log(`missing in ${f.includes('/') ? f : `server/content/ru/${f}.js`} (${keys.length}): ${short(keys.join(' '), 300)}`);
    }
    for (const p of result.errors) console.log(`ERROR ${p.area} ${p.file.includes('/') ? p.file : `server/content/ru/${p.file}.js`} ${p.key} [${p.rule}] ${p.msg}`);
    console.log(summary(result));
    console.log(`${result.errors.length} error(s), ${missing.length} missing, ${result.reviews.length} line(s) in the gender review list`);
  }
  if (!has('--no-write')) {
    const files = write(result, out);
    if (!has('--json')) console.log(`wrote ${files.map((f) => path.relative(process.cwd(), f)).join(', ')}`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 2; });
}
