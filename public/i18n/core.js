// public/i18n/core.js: the shared formatter (SPEC §11 X5.5; reports/i18n-design.md §7).
//
// No DOM and no imports: the browser loads it as a module, and the server (server/i18n, server/content) imports it.
// Every function is pure and synchronous.
//
// Template grammar (server messages, client strings, the Russian content templates and the words in
// server/content/<lang>/mods.js and bunker.js):
//   {name}            params[name]. A number goes through num(); a string passes through; an array is a list joined
//                     ', ' (each element that is not a string or number goes through hook); any other object goes to
//                     hook(value, form), or, without a hook, into the output untouched.
//   {name@form}       the same, with a form: '@and' joins a list "A, B and C"; '@cap' upper-cases the first letter of a
//                     string; any other form ('@acc', '@gen', '@bare', ...) is handed to hook(value, form).
//   {name|f0|f1}      two forms: f0 when Number(params[name]) === 1, else f1, in every language. For a word whose
//                     number is not printed ("the kick carries" / "the kicks carry").
//   {name|f0|f1|f2}   three forms: Russian one/few/many (a non-integer takes f1). For a word next to a printed number.
//                     Both print only the word: write "{n} {n|год|года|лет}".
//   {name:o0|o1|...}  an option by integer index, or by boolean (false -> o0, true -> o1). An option may be empty.
//                     Options (and plural forms) are plain text: no placeholders inside them.
//   {{ and }}         literal braces.
// Param names are letters, digits and '_' ('0', '1', ... are the positional params of the Russian content templates;
// params may then be an array). A missing param renders as "{name}" and warns once. A malformed placeholder is left
// as it is written.
//
// Selectors ('|' and ':') read Number(value), so an object with a numeric valueOf() works as a number there while
// '{name}' still hands the object to the hook (the content renderer uses this for "yrs" and "sev" params).

export const LANGS = Object.freeze(['en', 'ru']);

/** 'en' | 'ru' for exactly those strings, else null. */
export function normLang(x) {
  return typeof x === 'string' && LANGS.includes(x) ? x : null;
}

/**
 * The plural category of n: 'one' | 'few' | 'many' | 'other'.
 * ru (integers): |n| mod 100 = a, a mod 10 = b; b = 1 and a != 11 -> one; b in 2..4 and a not in 12..14 -> few;
 * else many. ru non-integer -> other. Every other language: n === 1 -> one, else other.
 */
export function pluralCategory(lang, n) {
  const x = Number(n);
  if (lang === 'ru') {
    if (!Number.isInteger(x)) return 'other';
    const a = Math.abs(x) % 100;
    const b = a % 10;
    if (b === 1 && a !== 11) return 'one';
    if (b >= 2 && b <= 4 && (a < 12 || a > 14)) return 'few';
    return 'many';
  }
  return x === 1 ? 'one' : 'other';
}

/**
 * The form of `forms` for the number n. One form: always it. Two forms (any language): n === 1 ? f0 : f1.
 * Three forms: Russian one/few/many (the only three-form language; 'other', a non-integer, takes the few form).
 */
export function pluralForm(lang, n, forms) {
  if (!Array.isArray(forms) || forms.length === 0) return '';
  if (forms.length === 1) return forms[0];
  const x = Number(n);
  if (forms.length === 2) return x === 1 ? forms[0] : forms[1];
  const c = pluralCategory('ru', x);
  return c === 'one' ? forms[0] : c === 'many' ? forms[2] : forms[1];
}

/**
 * A number as text. en (and any other language): String(x), exactly as the English strings always printed it.
 * ru: a decimal comma, a real minus sign (U+2212), no grouping below 10 000, and U+202F (narrow no-break space)
 * between groups of three digits from 10 000 up. A non-number is returned as String(x).
 */
export function num(lang, x) {
  if (typeof x !== 'number' || lang !== 'ru' || !Number.isFinite(x)) return String(x);
  const s = String(Math.abs(x));
  const sign = x < 0 ? '−' : '';
  if (/e/i.test(s)) return sign + s.replace('.', ',');
  const dot = s.indexOf('.');
  let int = dot < 0 ? s : s.slice(0, dot);
  const frac = dot < 0 ? '' : ',' + s.slice(dot + 1);
  if (int.length > 4) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return sign + int + frac;
}

const AND = { en: ' and ', ru: ' и ' };

/** A list as an array of items and separators (adjacent strings merged, empty strings dropped). */
function listParts(lang, items, style) {
  const xs = Array.isArray(items) ? items.map((x) => (typeof x === 'number' ? num(lang, x) : x)) : [];
  const sep = typeof style === 'string' && style !== 'and' ? style : ', ';
  const out = [];
  xs.forEach((x, i) => {
    if (i > 0) push(out, style === 'and' && i === xs.length - 1 ? AND[lang] || AND.en : sep);
    push(out, x);
  });
  return out;
}

/**
 * A list. style 'and': en "A, B and C", ru "А, Б и В" (one item: "A"; two: "A and B"). Any other string is the
 * separator, and the default is ', '. Numbers go through num(). Returns a string when every item is text; when an
 * item is not (a DOM node, a log part), returns an array of the items and the separators.
 */
export function list(lang, items, style) {
  const out = listParts(lang, items, style);
  if (out.every((x) => typeof x === 'string')) return out.join('');
  return out;
}

// ---- templates ----------------------------------------------------------------------------------------------------

const PLACEHOLDER = /\{\{|\}\}|\{([^{}]*)\}/g;
const BODY = /^([A-Za-z0-9_]+)(?:([@|:])([\s\S]*))?$/;
const FORM = /^[A-Za-z]+$/;
const parsed = new Map();
const PARSE_CACHE_MAX = 5000;

/** Template -> tokens: a string, or {name, kind: 'value'|'plural'|'option', form?, choices?, raw}. Cached. */
function parse(template) {
  let tokens = parsed.get(template);
  if (tokens) return tokens;
  tokens = [];
  let last = 0;
  const text = (s) => {
    if (!s) return;
    if (typeof tokens[tokens.length - 1] === 'string') tokens[tokens.length - 1] += s;
    else tokens.push(s);
  };
  for (const m of template.matchAll(PLACEHOLDER)) {
    text(template.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0] === '{{') { text('{'); continue; }
    if (m[0] === '}}') { text('}'); continue; }
    const b = BODY.exec(m[1]);
    if (!b || (b[2] === '@' && !FORM.test(b[3]))) { text(m[0]); continue; }
    const [, name, sep, rest] = b;
    if (!sep) tokens.push({ name, kind: 'value', raw: m[0] });
    else if (sep === '@') tokens.push({ name, kind: 'value', form: rest, raw: m[0] });
    else tokens.push({ name, kind: sep === '|' ? 'plural' : 'option', choices: rest.split('|'), raw: m[0] });
  }
  text(template.slice(last));
  if (parsed.size >= PARSE_CACHE_MAX) parsed.clear();
  parsed.set(template, tokens);
  return tokens;
}

/**
 * The placeholders of a template, in order: [{name, kind: 'value'|'plural'|'option', form?, choices?}]. For the
 * catalogue checker (tools/i18n-check.js) and anyone who needs to know what a template asks for.
 */
export function placeholders(template) {
  if (typeof template !== 'string') return [];
  return parse(template).filter((t) => typeof t !== 'string').map(({ raw, ...t }) => ({ ...t, ...(t.choices ? { choices: [...t.choices] } : {}) }));
}

/**
 * A template as its sequence, in order: strings (literal text, with {{ and }} already unescaped) and placeholders
 * {name, kind: 'value'|'plural'|'option', form?, choices?}. For the catalogue checker's lints (tools/i18n-check.js),
 * which need the text around each placeholder. Not a string: [].
 */
export function parseTemplate(template) {
  if (typeof template !== 'string') return [];
  return parse(template).map((t) => (typeof t === 'string' ? t : {
    name: t.name, kind: t.kind, ...(t.form ? { form: t.form } : {}), ...(t.choices ? { choices: [...t.choices] } : {}),
  }));
}

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key) || warned.size > 1000) return;
  warned.add(key);
  console.warn(`i18n: ${message}`);
}

/** Appends x to out: arrays are flattened, empty strings, null and undefined dropped, adjacent strings merged. */
function push(out, x) {
  if (x == null || x === '' || x === false) return;
  if (Array.isArray(x)) { for (const y of x) push(out, y); return; }
  if (typeof x === 'string' && typeof out[out.length - 1] === 'string') out[out.length - 1] += x;
  else out.push(x);
}

const selectorNumber = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : Number(v));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function renderToken(lang, t, params, hook, template, out) {
  const value = params == null ? undefined : params[t.name];
  if (value === undefined || value === null) {
    warnOnce(`${template}\u0000${t.name}`, `missing param "${t.name}" in "${template}"`);
    push(out, `{${t.name}}`);
    return;
  }
  if (t.kind === 'plural') {
    push(out, pluralForm(lang, selectorNumber(value), t.choices));
    return;
  }
  if (t.kind === 'option') {
    const i = selectorNumber(value);
    if (Number.isInteger(i) && i >= 0 && i < t.choices.length) push(out, t.choices[i]);
    else warnOnce(`${template}\u0000${t.name}\u0000${i}`, `option ${String(value)} out of range for "${t.name}" in "${template}"`);
    return;
  }
  const form = t.form;
  if (typeof value === 'string') push(out, form === 'cap' ? cap(value) : value);
  else if (typeof value === 'number') push(out, num(lang, value));
  else if (typeof value === 'boolean' || typeof value === 'bigint') push(out, String(value));
  else if (Array.isArray(value)) {
    const itemForm = form === 'and' ? undefined : form;
    const items = value.map((x) => (x !== null && typeof x === 'object' && hook ? hook(x, itemForm) : x));
    push(out, listParts(lang, items, form === 'and' ? 'and' : ', '));
  } else push(out, hook ? hook(value, form) : value);
}

/**
 * Renders a template. Returns an array of strings and whatever the hook (or an object param without a hook) put in:
 * adjacent strings merged, no empty strings, nested arrays from the hook flattened. A template that is not a string
 * renders as [] (a missing dictionary entry is the caller's fallback to handle).
 */
export function format(lang, template, params, hook) {
  if (typeof template !== 'string') return [];
  const out = [];
  for (const t of parse(template)) {
    if (typeof t === 'string') push(out, t);
    else renderToken(lang, t, params, hook, template, out);
  }
  return out;
}

/** The text of a rendered item: a string, a part's `v`, or String(x). */
function itemText(x) {
  if (typeof x === 'string') return x;
  if (x !== null && typeof x === 'object' && typeof x.v === 'string') return x.v;
  return String(x);
}

/** format() joined into one string. Hook results must be text, or objects with a string `v` (log parts). */
export function formatText(lang, template, params, hook) {
  return format(lang, template, params, hook).map(itemText).join('');
}

/**
 * The helper object handed to function values in dictionaries and content files as their second argument, `f`:
 *   f.lang                   the language
 *   f.num(x)                 num(lang, x)
 *   f.pl(n, f0, f1[, f2])    the plural word for n (same rules as {n|f0|f1|f2}); the forms may also be one array
 *   f.opt(i, o0, o1, ...)    an option by index or boolean ('' when out of range)
 *   f.list(items, style)     list(lang, items, style)
 *   f.format(template, p)    format(lang, template, p, hook)
 *   f.text(template, p)      formatText(lang, template, p, hook)
 */
export function helpers(lang, hook) {
  const forms = (xs) => (xs.length === 1 && Array.isArray(xs[0]) ? xs[0] : xs);
  return Object.freeze({
    lang,
    num: (x) => num(lang, x),
    pl: (n, ...fs) => pluralForm(lang, n, forms(fs)),
    opt: (i, ...os) => {
      const xs = forms(os);
      const k = selectorNumber(i);
      return Number.isInteger(k) && k >= 0 && k < xs.length ? xs[k] : '';
    },
    list: (items, style) => list(lang, items, style),
    format: (template, p) => format(lang, template, p, hook),
    text: (template, p) => formatText(lang, template, p, hook),
  });
}
