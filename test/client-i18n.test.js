// SPEC §11 X5.7 (reports/i18n-design.md §9, §11.3): the client's i18n runtime and dictionaries, without a browser.
//   - public/i18n/index.js: t() / tn() / catLabel() / pickLang() / latinCode(), the fallback to English
//   - public/i18n/en.js: every template renders for synthetic params of its params' types, and every key the client
//     code names exists (a missing key would show on screen as its name)
//   - public/i18n/ru.js: only keys that English has
// The key-based loglines cases (against real engine logs in both languages) come with the log `parts` work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeholders } from '../public/i18n/core.js';
import en from '../public/i18n/en.js';
import serverEn from '../server/i18n/en.js';
import ru, { COMPLETE } from '../public/i18n/ru.js';
import { t, tn, catLabel, pickLang, latinCode, lang, setLang, has, initLang, saveLang, langStorageKey } from '../public/i18n/index.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// synthetic values by param name (design §7.1)
const NUM = new Set(['n', 'k', 'm', 'r', 'i', 'max', 'beds', 'alive', 'ballot', 'ballots', 'votes', 'secs', 'mins', 'lo', 'hi', 'count', 'total', 'before', 'fewer', 'seat', 'left']);
const NAME = new Set(['p', 't', 'a', 'b', 'host', 'who', 'name']);
const LIST = new Set(['list', 'by', 'ids', 'in', 'out', 'items', 'rows', 'voters', 'abstained']);
const TEXT = new Set(['title', 'text', 'ca', 'cb', 'bname', 'code', 'c', 'f', 'card', 'cata']);
const BOOL = new Set(['ot', 'now', 'mine', 'asc', 'first', 'auto', 'revote', 'earlier']);
const ENUM = new Set(['mode', 'how', 'when', 'kind', 'stage']);
function sample(name, v) {
  if (NUM.has(name)) return [0, 1, 2, 5, 21][v % 5];
  if (NAME.has(name)) return ['Анна', 'Bot Anna', '🚪 “Spy”'][v % 3];
  if (LIST.has(name)) return [['Анна'], ['Анна', 'Boris', 'Вера']][v % 2];
  if (TEXT.has(name)) return 'ABCD';
  if (BOOL.has(name)) return v % 2 === 1;
  if (ENUM.has(name)) return v % 2;
  if (name === 'cat') return ['profession', 'skill', 'baggage'][v % 3];
  return undefined;
}

test('en.js: every template renders for every param name it uses, with only typed param names', () => {
  setLang('en', { store: false });
  let rendered = 0;
  for (const [key, tmpl] of Object.entries(en)) {
    assert.equal(typeof tmpl, 'string', `${key}: English entries are templates`);
    const ps = placeholders(tmpl);
    for (const p of ps) assert.notEqual(sample(p.name, 0), undefined, `${key}: param "${p.name}" is not a typed name (design §7.1)`);
    for (let v = 0; v < 4; v++) {
      const params = Object.fromEntries(ps.map((p) => [p.name, sample(p.name, v)]));
      const out = t(key, params);
      assert.equal(typeof out, 'string');
      assert.ok(out.length > 0, `${key} renders empty`);
      for (const p of ps) assert.ok(!out.includes(`{${p.name}}`), `${key}: {${p.name}} left in "${out}"`);
      assert.ok(!/ {2}/.test(out), `${key}: a double space in "${out}"`);
      rendered++;
    }
  }
  assert.ok(rendered > 2000, `rendered ${rendered}`);
});

test('en.js: the exact English of a few strings the page showed before X5', () => {
  setLang('en', { store: false });
  assert.equal(t('lobby.waitingFor', { n: 1 }), 'Waiting for 1 more player before the game can start.');
  assert.equal(t('lobby.waitingFor', { n: 2 }), 'Waiting for 2 more players before the game can start.');
  assert.equal(t('bar.closeOffline', { n: 1 }), '1 offline voter abstains');
  assert.equal(t('bar.closeMissing', { n: 3 }), '3 missing voters abstain');
  assert.equal(t('vote.revoteTitle', { list: ['Anna', 'Boris', 'Vera'] }), 'Revote: Anna, Boris and Vera');
  assert.equal(t('result.noVotes', { list: ['Anna', 'Boris'] }), 'No votes: Anna, Boris');
  assert.equal(t('air.when', { n: 1, ot: false }), 'jams if nobody closes it before this round’s discussion ends');
  assert.equal(t('air.when', { n: 2, ot: true }), 'each jams if nobody closes it before the overtime discussion ends');
  assert.equal(t('bar.revealYour', { cat: 'skill' }), 'Reveal your Extra skill');
  assert.equal(t('why.blockedDouble', { now: true }), 'Your vote is blocked in this vote, so ×2 would do nothing');
  assert.equal(t('why.blockedDouble', { now: false }), 'Your vote is blocked in the next vote, so ×2 would do nothing');
  assert.equal(t('toast.youAreHost', { mode: 0 }), 'You are the host now: you move the game on with Start.');
  assert.equal(t('turn.speaksInLower', { n: 3 }), 'speaks in 3 turns');
  assert.equal(t('app.titleTurn', { code: 'KXQR' }), '▶ Your turn · Bunker KXQR');
  // a param's own braces are never read as a placeholder (names are free text)
  assert.equal(t('bar.speaking', { p: '{p} {n|a|b}' }), '{p} {n|a|b} is speaking');
});

test('t(): an unknown key renders as the key; ru falls back to English key by key', () => {
  setLang('en', { store: false });
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(has('bar.start'), true);
  assert.equal(has('no.such.key'), false);
  setLang('ru', { store: false });
  try {
    assert.equal(lang(), 'ru');
    for (const key of ['bar.start', 'landing.create', 'narr.listen']) {
      assert.equal(t(key), Object.prototype.hasOwnProperty.call(ru, key) ? t(key) : en[key]);
    }
  } finally {
    setLang('en', { store: false });
  }
  assert.equal(lang(), 'en');
});

test('tn(): node-like params stay objects, in place; the text around them merges', () => {
  setLang('en', { store: false });
  const b1 = { node: 'code' };
  const b2 = { node: 'name' };
  assert.deepEqual(tn('landing.rejoinTextAs', { code: b1, name: b2 }), ['You were at the table in room ', b1, ' as ', b2, '. Rejoin to take your seat back.']);
  assert.deepEqual(tn('conn.rejoining', { code: b1 }), ['Rejoining room ', b1, '…']);
});

test('catLabel(): the dictionary names every category and its case forms (English: all forms are the label)', () => {
  setLang('en', { store: false });
  const labels = { profession: 'Profession', biology: 'Biology', health: 'Health', hobby: 'Hobby', phobia: 'Phobia', skill: 'Extra skill', trait: 'Personality', baggage: 'Baggage' };
  for (const [id, label] of Object.entries(labels)) {
    for (const form of ['label', 'acc', 'gen', 'dat']) assert.equal(catLabel(id, form), label, `${id} ${form}`);
    assert.equal(catLabel(id, 'loc'), label, 'a form the dictionary lacks is the label');
  }
  assert.equal(catLabel('unknown'), 'unknown');
});

test('pickLang(): ?lang= beats the stored choice, which beats navigator.language (ru* only)', () => {
  assert.equal(pickLang({ url: 'ru', stored: 'en', nav: 'en-US' }), 'ru');
  assert.equal(pickLang({ url: 'xx', stored: 'en', nav: 'ru-RU' }), 'en');
  assert.equal(pickLang({ url: null, stored: 'ru', nav: 'en-US' }), 'ru');
  assert.equal(pickLang({ url: null, stored: null, nav: 'ru-RU' }), 'ru');
  assert.equal(pickLang({ url: null, stored: null, nav: 'ru' }), 'ru');
  assert.equal(pickLang({ url: null, stored: null, nav: 'rw-RW' }), 'en');
  assert.equal(pickLang({ url: null, stored: null, nav: 'uk-UA' }), 'en');
  assert.equal(pickLang({}), 'en');
  // in Node there is no window: initLang() falls back to English without throwing
  assert.equal(initLang({ memory: true }), 'en');
});

test('latinCode(): Cyrillic look-alikes become the Latin code letters; О and anything else are dropped', () => {
  assert.equal(latinCode('КМТХ'), 'KMTX');
  assert.equal(latinCode('кмтх'), 'KMTX');
  assert.equal(latinCode('АВЕКМНРСТУХ'), 'ABEKMHPCTYX');
  assert.equal(latinCode('О-І-Ж ab1'), 'AB');
  assert.equal(latinCode('kxqr'), 'KXQR');
  assert.equal(latinCode(null), '');
});

test('ru.js: a stub or a translation of English keys only (COMPLETE says whether it is whole)', () => {
  assert.equal(typeof COMPLETE, 'boolean');
  for (const key of Object.keys(ru)) assert.ok(Object.prototype.hasOwnProperty.call(en, key), `ru.js has a key English does not: ${key}`);
  if (COMPLETE) for (const key of Object.keys(en)) assert.ok(Object.prototype.hasOwnProperty.call(ru, key), `ru.js is COMPLETE but lacks ${key}`);
});

test('every key the client code names exists in en.js', () => {
  const areas = 'app|landing|fan|conn|screen|hdr|phase|jump|track|turn|leave|host|lobby|opts|preset|est|sched|howto|role|brief|sit|stakes|order|air|final|vote|result|board|tag|status|seat|pop|hand|sp|meta|target|why|intel|watch|picker|play|bar|next|toast|err|rules|log|fb|narr|common|cat|lang';
  const re = new RegExp(`'((?:${areas})\\.[A-Za-z0-9.]+)'`, 'g');
  const missing = [];
  let n = 0;
  for (const f of ['app.js', 'narrator.js', 'mock.js']) {
    const src = fs.readFileSync(path.join(PUB, f), 'utf8');
    // (a server message key the code reads a log line by, 'log.kicked', 'host.offline', is the server's: SPEC §11 X5.3)
    for (const m of src.matchAll(re)) { n++; if (!Object.prototype.hasOwnProperty.call(en, m[1]) && !Object.prototype.hasOwnProperty.call(serverEn, m[1])) missing.push(`${f}: ${m[1]}`); }
  }
  assert.ok(n > 500, `found ${n} key references`);
  assert.deepEqual(missing, []);
  // keys built in code: their families exist whole
  for (const id of ['lobby', 'reveal', 'discussion', 'vote', 'defense', 'final', 'revote']) assert.ok(has('phase.' + id), 'phase.' + id);
  for (const id of ['none', 'self', 'other', 'ejected']) assert.ok(has('target.' + id), 'target.' + id);
  for (const id of ['quick', 'standard', 'relaxed']) assert.ok(has('preset.' + id), 'preset.' + id);
  for (const f of ['speechSeconds1', 'speechSeconds', 'discussionSeconds', 'defenseSeconds']) assert.ok(has('opts.' + f) && has(`opts.${f}.hint`), 'opts.' + f);
  for (const k of ['reveals', 'discussion', 'vote', 'specials', 'airlock', 'end']) assert.ok(has('howto.' + k) && has(`howto.${k}K`), 'howto.' + k);
  for (const k of ['table', 'hand', 'you', 'info', 'log']) assert.ok(has('jump.' + k) && has(`jump.${k}Title`), 'jump.' + k);
  for (const k of ['error', 'airlock', 'out', 'special', 'left', 'vote', 'note']) assert.ok(has('toast.k.' + k), 'toast.k.' + k);
  for (const k of ['wipedLeft', 'wipedKicked', 'wipedLeftPanel', 'wipedKickedPanel']) assert.ok(has('vote.' + k), 'vote.' + k);
});

test('index.js is import-safe: no browser globals touched at load (it loaded above in Node)', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof t, 'function');
});

test('saveLang() stores a choice without switching (a switch in a room waits for the server, design §9.3)', () => {
  setLang('en', { store: false });
  assert.equal(saveLang('xx'), false, 'not a language');
  // (Node: no window, so the write is a no-op; initLang({memory: true}) above keeps choices in memory)
  assert.equal(saveLang('ru'), true);
  assert.equal(lang(), 'en', 'the language on screen is unchanged');
  assert.equal(langStorageKey(), null, 'a memory page has no storage key');
});

test('the keys added after C1 exist in English, with their exact words (log: .scratch/i18n-client-C2/checkpoint-changes.md)', () => {
  setLang('en', { store: false });
  assert.equal(t('lang.switch'), 'Language: English. Switch to Russian');
  assert.equal(t('toast.whyOffline', { p: 'Anna' }), 'Anna has been offline for a while');
  assert.equal(t('toast.whyHandover', { p: 'Anna' }), 'Anna handed over the host role');
  // the new host's flash, as the pre-X5 client made it from the server's line
  assert.equal(t('toast.youAreHostWhy', { text: t('toast.whyHandover', { p: 'Anna' }), mode: 1 }), 'Anna handed over the host role. You are the host now: you move the game on with Next.');
  assert.equal(t('final.causeLine', { text: 'Anna left the game' }), 'Anna left the game.');
});
