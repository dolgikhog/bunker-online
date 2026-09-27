// SPEC §11 X5.3/X5.8, reports/i18n-design.md §4, §5, §11.3 — golden tests of the i18n server (i18n-server).
//
// Part 1 (checkpoint A1, "messages frozen"): the English catalogue server/i18n/en.js against the pre-X5 code.
//   - structure: en.js, ru.js and index.js SCHEMA agree (keys, placeholders, params, log kinds, param types);
//   - every key renders for synthetic params in en and ru without a throw, a leftover brace, a warning, or a broken
//     parts invariant (text === the parts joined, no empty or adjacent strings, a prefix only first);
//   - byte for byte: every log line, result, note, timer label and error the frozen pre-X5 engine
//     (test/fixtures/pre-x5/game.js) produces in scripted games equals the catalogue's rendering of the key and params
//     the X5 engine will log for it; rooms.js and dev.js strings likewise; and every key is compared at least once.
// Part 2 (A2, report §11.3): the X5 engine in lockstep with the snapshot over 240 random games and scripted rare paths,
// every English view, result and error equal once the X5.2 additions are removed; every twin renders its English field;
// every log.*, res.* and engine err.* key produced (see the section "part 2: lockstep" below).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as old from './fixtures/pre-x5/game.js';
import * as X5 from '../server/game.js';
import { AIRLOCK_CARD, REVIVE_CARD } from './fixtures/pre-x5/content.js';
import { mulberry32 } from '../server/rng.js';
import { Rooms, DEV_OFF } from '../server/rooms.js';
import * as enModule from '../server/i18n/en.js';
import * as ruModule from '../server/i18n/ru.js';
import {
  renderMsg, renderText, renderValue, SCHEMA, KEYS, LANGS, normLang, categoryLabel, setWarn, traceKeys, isDevKey, hasKey,
} from '../server/i18n/index.js';

const EN = enModule.default;
const warnings = [];
setWarn((m) => warnings.push(m));

// ------------------------------------------------------------------------------------------------ helpers
const covered = new Set();
/** The English rendering of `key`; records every key it used (nested ones and fragments too). */
function T(key, params = {}) {
  assert.ok(hasKey(key), `unknown key ${key}`);
  let out;
  for (const k of traceKeys(() => { out = renderText('en', key, params); })) covered.add(k);
  return out;
}

const P = (g, id) => ({ p: id, n: g._name(id) });
const Ps = (g, ids) => ids.map((id) => P(g, id));
const RP = (g) => ({ r: g.round, ot: g.overtime });
const M = (key, params = {}) => ({ msg: { key, params } });
const TOK = (text) => ({ tok: { lit: text } });
const CAT = (id) => ({ cat: id });
const SP = (card) => ({ sp: { id: card.id, ref: card.id, title: card.title, text: card.text } });
const cardText = (g, id, c) => g._player(id).cards[c].text;

/** Runs `fn` and checks the log lines it added: [[key, params], …] (or a function returning that, called after). */
function expectLog(g, fn, expected) {
  const from = g.logSeq;
  const res = fn();
  if (res && typeof res === 'object') assert.notEqual(res.ok, false, `the action failed: ${res.message}`);
  const lines = g.log.filter((e) => e.id > from);
  const exp = typeof expected === 'function' ? expected() : expected;
  assert.deepEqual(
    lines.map((e) => [e.kind, e.text]),
    exp.map(([key, params]) => [SCHEMA[key].kind, T(key, params)]),
  );
  return res;
}

/** A failure from the pre-X5 code equals the catalogue: same code, message === the English rendering. */
function expectErr(res, code, key, params = {}) {
  assert.ok(res && res.ok === false, `expected ${code} (${key}), got ${JSON.stringify(res)}`);
  assert.equal(res.code, code);
  assert.equal(res.message, T(key, params));
}

const NAMES = ['Anna', 'Bob', 'Cleo {p}', 'Dan “D”', 'Ёжик', 'Finn', 'Gus', 'Hana', 'Ivo', 'Jo', 'Kai', 'Lu', 'Mo', 'Ned', 'Oz', 'Pia'];
const FILLER = { id: 'filler', title: 'Blueprint', text: 'Adds a bunker feature.', effect: 'bunker_add_feature', target: 'none' };
const card = (id, effect, extra = {}) => ({ id, title: `T ${id}`, text: `Text of ${id}.`, effect, target: old.EFFECTS[effect].targets[0], ...extra });
const CARDS = {
  swap: card('swap', 'swap_card', { title: 'Body Swap', category: 'choose' }),
  rerollSelf: card('reroll-self', 'reroll_card', { target: 'self', category: 'baggage' }),
  rerollOther: card('reroll-other', 'reroll_card', { target: 'other', category: 'choose', text: '' }),
  force: card('force', 'force_reveal', { category: 'choose' }),
  forceRandom: card('force-random', 'force_reveal', { category: 'random' }),
  peek: card('peek', 'peek', { category: 'choose' }),
  mass: card('mass', 'mass_reveal', { category: 'hobby' }),
  shuffle: card('shuffle', 'shuffle_category', { category: 'phobia' }),
  immunity: card('immunity', 'immunity'),
  protect: card('protect', 'protect'),
  double: card('double', 'double_vote'),
  block: card('block', 'block_vote'),
  cancel: card('cancel', 'cancel_vote'),
  eject: card('eject', 'eject'),
  revive: REVIVE_CARD,
  plus: card('plus', 'capacity_plus'),
  minus: card('minus', 'capacity_minus'),
  feature: card('feature', 'bunker_add_feature'),
  airlock: AIRLOCK_CARD,
};

function dealer({ features = 'ok' } = {}) {
  let n = 0;
  return {
    drawCard: (c) => `<${c}#${++n}>`,
    drawSpecial: () => ({ ...FILLER }),
    drawCatastrophe: () => ({ title: 'Flood', text: 'Water.', details: ['1%'] }),
    drawBunker: () => ({ name: 'Vault 9', size: '50 m2', duration: '1 year', food: '1 year', features: ['Well'] }),
    drawBunkerFeature: () => {
      if (features === 'throw') throw new Error('no feature');
      return `<feature#${++n}>`;
    },
  };
}

/** n seated players of the pre-X5 engine (the first hosts), started unless start: false. Hand-made deal. */
function table(n, { seed = 7, start = true, features = 'ok' } = {}) {
  const g = new old.Game({ room: 'GOLD', rng: mulberry32(seed), now: () => 1_800_000_000_000, minPlayers: 2, dealer: dealer({ features }), fixedSpecials: false });
  for (const method of ['_ejectByVote', '_startDefense']) {
    const orig = g[method];
    g[method] = function wrapped(...args) {
      this.tallySnapshot = structuredClone(this.lastVoteResult);
      return orig.apply(this, args);
    };
  }
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(g.join(NAMES[i]).id);
  if (start) assert.equal(g.handle(ids[0], { t: 'start' }).ok, true);
  return { g, ids, host: ids[0] };
}

function give(g, id, def) {
  const c = g._issueSpecial(old.normalizeSpecial(def));
  g._player(id).specials.push(c);
  return c;
}

/** Plays a fresh copy of `def` (one special a round is lifted), checking the log.special line and what follows it. */
function expectSpecial(g, id, def, extra, result, more = () => []) {
  const rp = RP(g);
  const who = P(g, id);
  let c = null;
  expectLog(g, () => {
    c = give(g, id, def);
    g._player(id).lastSpecialRound = 0;
    return g.handle(id, { t: 'special', uid: c.uid, ...extra });
  }, () => [['log.special', { rp, p: who, card: SP(c), result: M(...result()) }], ...more()]);
  return c;
}

/** The host presses Next until the reveal phase is over (unchecked lines). */
function finishReveal(g, host) {
  for (let i = 0; g.phase === 'reveal' && i < 64; i++) g.handle(host, { t: 'next' });
}
/** Unchecked: plays on (Next) until the reveal phase of round `r` has begun. */
function toRound(g, host, r) {
  for (let i = 0; !(g.round === r && g.phase === 'reveal') && i < 500; i++) {
    if (g.phase === 'vote') g.handle(host, { t: 'closeVote' });
    else g.handle(host, { t: 'next' });
  }
  assert.equal(g.round, r);
  assert.equal(g.phase, 'reveal');
}

/**
 * Rows of the last closed ballot as log.tally params, from the engine's own tally. A ballot's close logs the tally and
 * then goes on to _ejectByVote or _startDefense, which may overwrite lastVoteResult (a cancelled step): table() wraps
 * both to keep a copy of the result the tally line was made from.
 */
function tallyRows(g, doubled) {
  return (g.tallySnapshot ?? g.lastVoteResult).tally.map((e) => ({
    t: P(g, e.targetId), votes: e.votes, voters: e.voterIds.map((x) => ({ p: P(g, x), x2: doubled.has(x) })),
  }));
}
/** The vote modifiers a cancelled step takes with it, as mods.used params (engine order: immune, blocked, double). */
function modsParams(g) {
  const m = g.voteMods;
  const items = [
    ...g._bySeat([...m.immune]).map((id) => M('mod.immune', { p: P(g, id) })),
    ...g._bySeat([...m.blocked]).map((id) => M('mod.blocked', { p: P(g, id) })),
    ...g._bySeat([...m.doubleVote]).map((id) => M('mod.double', { p: P(g, id) })),
  ];
  return items.length ? M('mods.used', { items, n: items.length }) : null;
}

// ------------------------------------------------------------------------------------------------ structure
const KINDS = new Set(['info', 'system', 'reveal', 'vote', 'eject', 'special']);
const PLACEHOLDER = /\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)(?:@([A-Za-z_][A-Za-z0-9_]*))?(?:\|([^{}]*)|:([^{}]*))?\}/g;
const placeholders = (tpl) => [...tpl.matchAll(PLACEHOLDER)].filter((m) => m[1]).map((m) => m[1]);
const TYPE_RE = /^(player|player\[\]|cat|card|feat|special|cata|bname|rp|num|bool|text|enum:[\w|]+|int:[\d|]+|msg\??:[\w.|]+|msg\[\]:[\w.|]+|id:[\w|]+)$/;

function checkType(type, where) {
  if (Array.isArray(type)) {
    assert.equal(type.length, 1, where);
    for (const [k, t] of Object.entries(type[0])) checkType(t, `${where}.${k}`);
    return;
  }
  assert.match(type, TYPE_RE, where);
  const m = /^msg(?:\?|\[\])?:(.+)$/.exec(type);
  if (m) for (const k of m[1].split('|')) assert.ok(hasKey(k), `${where}: nested key ${k} is not in en.js`);
}

describe('i18n A1: the server catalogue', () => {
  test('en.js, ru.js and SCHEMA have the same keys; ru.js has no key en.js lacks', () => {
    assert.deepEqual(Object.keys(SCHEMA), Object.keys(EN));
    assert.deepEqual([...KEYS], Object.keys(EN));
    assert.equal(enModule.COMPLETE, true);
    const ru = ruModule.default;
    assert.ok(ru && typeof ru === 'object' && !Array.isArray(ru), 'ru.js exports an object');
    assert.equal(typeof ruModule.COMPLETE, 'boolean');
    for (const k of Object.keys(ru)) assert.ok(Object.hasOwn(EN, k), `ru.js has ${k}, which en.js does not`);
    for (const v of Object.values(ru)) assert.ok(typeof v === 'string' || typeof v === 'function');
    // dev keys (§11 X9: English-only tools) may stay English in a complete ru.js
    if (ruModule.COMPLETE === true) assert.deepEqual(Object.keys(ru).filter((k) => !isDevKey(k)).sort(), Object.keys(EN).filter((k) => !isDevKey(k)).sort());
  });

  test('values are templates or functions; templates use exactly their params (plus the derived ones)', () => {
    for (const [key, value] of Object.entries(EN)) {
      assert.ok(typeof value === 'string' || typeof value === 'function', key);
      const s = SCHEMA[key];
      assert.ok(s && typeof s.params === 'object', key);
      if (typeof value !== 'string') continue;
      const used = new Set(placeholders(value));
      const allowed = new Set([...Object.keys(s.params), ...(s.derived ?? [])]);
      for (const u of used) assert.ok(allowed.has(u), `${key}: {${u}} is not a param`);
      for (const p of Object.keys(s.params)) assert.ok(used.has(p), `${key}: param ${p} is never used`);
    }
  });

  test('log lines have a kind, nothing else does; every param type is known', () => {
    for (const [key, s] of Object.entries(SCHEMA)) {
      if (key.startsWith('log.')) assert.ok(KINDS.has(s.kind), `${key} kind ${s.kind}`);
      else assert.equal(s.kind, undefined, key);
      for (const [name, type] of Object.entries(s.params)) checkType(type, `${key}.${name}`);
      for (const d of s.derived ?? []) assert.ok(['airlock', 'cardtext'].includes(d), `${key} derived ${d}`);
    }
    assert.ok(isDevKey('log.dev.seed') && isDevKey('err.dev.badOp') && !isDevKey('log.join'));
  });

  test('LANGS, normLang and categoryLabel', () => {
    assert.deepEqual(LANGS, ['en', 'ru']);
    assert.equal(normLang('ru'), 'ru');
    assert.equal(normLang('en'), 'en');
    for (const bad of ['RU', 'de', '', null, undefined, 1, {}, ['en']]) assert.equal(normLang(bad), null);
    assert.equal(categoryLabel('en', 'skill'), 'Extra skill');
    for (const c of old.CATEGORY_LIST) assert.equal(categoryLabel('en', c.id), c.label);
  });
});

// ------------------------------------------------------------------------------------------------ synthetic render
const SYN = {
  player: [{ p: 'p1', n: 'Anna' }, { p: 'p2', n: 'Бот Анна' }, { p: 'p3', n: 'Zed {x} “q”' }],
  cat: [CAT('health'), CAT('skill')],
  card: [TOK('Asthma (mild)')],
  feat: [{ feat: { lit: 'A sauna' } }],
  special: [{ sp: { id: 'alibi', ref: 'alibi', title: 'Alibi', text: 'You were elsewhere.' } }, { sp: { id: 'x', ref: null, title: 'Blank', text: '' } }],
  cata: [{ cata: { lit: 'Nuclear winter' } }],
  bname: [{ bname: { lit: 'Vault 9' } }],
  rp: [{ r: 3, ot: false }, { r: 7, ot: true }],
  num: [1, 0, 2, 5, 11, 21, 1.5],
  bool: [false, true],
  text: ['abc'],
};

function variants(type, depth) {
  if (Array.isArray(type)) {
    const one = (i) => Object.fromEntries(Object.entries(type[0]).map(([k, t]) => [k, variants(t, depth)[i % variants(t, depth).length]]));
    return [[one(0)], [], [one(0), one(1), one(2)]];
  }
  if (SYN[type]) return SYN[type];
  if (type === 'player[]') return [[SYN.player[0]], [], SYN.player];
  const [kind, list] = type.split(/:(.*)/s);
  const values = list ? list.split('|') : [];
  if (kind === 'enum' || kind === 'id') return values;
  if (kind === 'int') return values.map(Number);
  const nested = depth > 2 ? values.slice(0, 1) : values;
  const msgs = nested.flatMap((k) => samples(k, depth + 1).slice(0, 2).map((params) => M(k, params)));
  if (kind === 'msg') return msgs;
  if (kind === 'msg?') return [...msgs, null];
  if (kind === 'msg[]') return [msgs.slice(0, 1), msgs.slice(0, 3)];
  throw new Error(`type ${type}`);
}

/** Param sets for `key`: the first variant of everything, then each param through its variants. */
function samples(key, depth = 0) {
  const params = SCHEMA[key].params;
  const base = Object.fromEntries(Object.entries(params).map(([k, t]) => [k, variants(t, depth)[0]]));
  const out = [base];
  if (depth > 1) return out;
  for (const [k, t] of Object.entries(params)) for (const v of variants(t, depth).slice(1)) out.push({ ...base, [k]: v });
  return out;
}

function checkParts(key, lang, { text, parts }) {
  assert.equal(typeof text, 'string', key);
  assert.ok(Array.isArray(parts), key);
  assert.equal(parts.map((x) => (typeof x === 'string' ? x : x.v)).join(''), text, `${key} ${lang}: text is not the parts joined`);
  parts.forEach((x, i) => {
    if (typeof x === 'string') {
      assert.notEqual(x, '', `${key}: empty string part`);
      assert.notEqual(typeof parts[i - 1], 'string', `${key}: two string parts in a row`);
      return;
    }
    assert.ok(['player', 'card', 'cardtext', 'cat', 'value', 'prefix'].includes(x.t), `${key}: part type ${x.t}`);
    assert.equal(typeof x.v, 'string', `${key}: part v`);
    if (x.t === 'prefix') assert.equal(i, 0, `${key}: a prefix part not first`);
    if (x.t === 'cardtext') assert.ok(x.v.startsWith(': '), `${key}: cardtext without its ': '`);
    if (x.t === 'card') for (const f of ['id', 'label', 'title', 'text']) assert.equal(typeof x[f], 'string', `${key}: card.${f}`);
    if (x.t === 'player' || x.t === 'cat') assert.equal(typeof x.id, 'string', `${key}: ${x.t}.id`);
  });
}

describe('i18n A1: every key renders', () => {
  test('a function value gets core helpers plus t, k, join and list; pieces nest and print as text', () => {
    const A = { p: 'p1', n: 'Anna' };
    const B = { p: 'p2', n: 'Bob' };
    const C = { p: 'p3', n: 'Вера' };
    const seen = {};
    const r = renderValue('ru', (p, f) => {
      Object.assign(seen, { lang: f.lang, num: f.num(1.5), pl: f.pl(5, 'год', 'года', 'лет'), opt: f.opt(true, 'нет', 'да'), text: f.text('{p}!') });
      const who = f.list(p.ids, 'and');
      return [f.t('{rp}'), f.format('{a}: '), f.t('{who} — ', { who }), f.join([A, 'x', f.k('word.nobody')], '; '), ` (${String(who)})`];
    }, { rp: { r: 2, ot: false }, a: A, p: B, ids: [A, B, C] });
    assert.deepEqual(seen, { lang: 'ru', num: '1,5', pl: 'лет', opt: 'да', text: 'Bob!' });
    // the nested keys in whatever words ru.js has now (English until it has them): this test is about the helpers
    const rp = renderText('ru', 'rp', { r: 2 });
    const nobody = renderText('ru', 'word.nobody');
    assert.equal(r.text, `${rp}Anna: Anna, Bob и Вера — Anna; x; ${nobody} (Anna, Bob и Вера)`);
    checkParts('renderValue', 'ru', r);
    assert.deepEqual(r.parts.slice(0, 2), [{ t: 'prefix', v: rp }, { t: 'player', id: 'p1', v: 'Anna' }]);
    assert.equal(r.parts.filter((x) => x.t === 'player').length, 5);
    assert.deepEqual(renderValue('en', '{x@cap} {airlock@cap} {c@cap}', { x: 'abc', c: TOK('ёж') }).text, 'Abc Airlock Ёж');
    assert.throws(() => renderValue('en', () => { throw new Error('boom'); }), /boom/);
  });

  for (const lang of LANGS) {
    test(`${lang}: synthetic params, no throw, no leftover placeholder, the parts invariant`, () => {
      const before = warnings.length;
      let n = 0;
      for (const key of KEYS) {
        for (const params of samples(key)) {
          const r = renderMsg(lang, key, params);
          checkParts(key, lang, r);
          // player names come from params and may hold braces: take them out before looking for leftovers
          let text = r.text;
          for (const x of r.parts) if (typeof x !== 'string' && x.t === 'player') text = text.split(x.v).join('');
          assert.doesNotMatch(text, /[{}]|undefined|null|NaN|\[object /, `${key} ${lang}: ${r.text}`);
          n++;
        }
      }
      assert.ok(n > KEYS.length * 2);
      const unexpected = warnings.slice(before).filter((w) => !/^no ru text for /.test(w));
      assert.deepEqual(unexpected, []);
    });
  }

  test('ru falls back to English per key until ru.js has it', () => {
    const ru = ruModule.default;
    for (const key of KEYS) {
      if (Object.hasOwn(ru, key)) continue;
      for (const params of samples(key).slice(0, 3)) assert.deepEqual(renderMsg('ru', key, params), renderMsg('en', key, params), key);
    }
  });

  test('an unknown language renders English; an unknown key renders the key itself; values are never parsed', () => {
    assert.equal(renderText('xx', 'log.join', { p: { p: 'p1', n: 'A' } }), 'A joined');
    assert.equal(renderText('en', 'no.such.key'), 'no.such.key');
    assert.equal(renderText('en', 'log.join', { p: { p: 'p1', n: '{p} {{x}} {n|a|b}' } }), '{p} {{x}} {n|a|b} joined');
    assert.equal(renderText('en', 'log.dev.seed', { seed: '{seed}' }), '[dev] Deals in this room follow the seed “{seed}”');
    const r = renderMsg('en', 'log.reveal', { rp: { r: 3, ot: false }, p: { p: 'p4', n: 'Dan' }, cat: CAT('health'), card: TOK('Asthma'), auto: false });
    assert.deepEqual(r.parts, [
      { t: 'prefix', v: 'Round 3 — ' }, { t: 'player', id: 'p4', v: 'Dan' }, ' revealed ', { t: 'cat', id: 'health', v: 'Health' }, ': ',
      { t: 'value', v: 'Asthma' },
    ]);
    const s = renderMsg('en', 'log.special', { rp: { r: 2, ot: false }, p: { p: 'p1', n: 'A' }, card: SYN.special[0], result: M('res.cancelNext') });
    assert.deepEqual(s.parts, [
      { t: 'prefix', v: 'Round 2 — ' }, { t: 'player', id: 'p1', v: 'A' }, ' played ',
      { t: 'card', id: 'alibi', v: '“Alibi”', label: 'Alibi', title: 'Alibi', text: 'You were elsewhere.' },
      { t: 'cardtext', v: ': You were elsewhere.' }, ' → the next vote will be cancelled',
    ]);
    const a = renderMsg('en', 'log.airlockJam', { t: { p: 'p3', n: 'C' } });
    assert.deepEqual(a.parts[1], { t: 'card', id: 'airlock', v: 'airlock', label: 'airlock', title: AIRLOCK_CARD.title, text: AIRLOCK_CARD.text });
  });
});

// ------------------------------------------------------------------------------------------------ byte for byte: pre-X5
describe('i18n A1: English equals the pre-X5 engine, byte for byte', () => {
  test('the lobby: joins, spectators, seats, leaves, kicks and every host change', () => {
    const g = new old.Game({ room: 'GOLD', rng: mulberry32(1), now: () => 1_800_000_000_000, minPlayers: 4, dealer: dealer(), fixedSpecials: false });
    expectLog(g, () => g.join('Anna'), () => [['log.join', { p: P(g, 'p1') }], ['log.host', { p: P(g, 'p1'), why: null }]]);
    expectLog(g, () => g.join(' Anna '), () => [['log.join', { p: P(g, 'p2') }]]); // "Anna (2)"
    assert.equal(g._name('p2'), 'Anna (2)');
    expectLog(g, () => g.join('Cleo {p}'), () => [['log.join', { p: P(g, 'p3') }]]);
    expectLog(g, () => g.join('Sam', { spectator: true }), () => [['log.watch', { p: P(g, 'p4') }]]);
    expectLog(g, () => g.handle('p4', { t: 'takeSeat' }), () => [['log.seat', { p: P(g, 'p4') }]]);
    g.join('Tom', { spectator: true });
    const tom = P(g, 'p5');
    expectLog(g, () => g.handle('p5', { t: 'leave' }), [['log.specLeft', { p: tom }]]);
    g.join('Uma', { spectator: true });
    const uma = P(g, 'p6');
    expectLog(g, () => g.handle('p1', { t: 'kick', playerId: 'p6' }), [['log.specKicked', { p: uma }]]);
    const bob = P(g, 'p2');
    expectLog(g, () => g.handle('p2', { t: 'leave' }), [['log.leftLobby', { p: bob }]]);
    const cleo = P(g, 'p3');
    expectLog(g, () => g.handle('p1', { t: 'kick', playerId: 'p3' }), [['log.kicked', { p: cleo }]]);
    g.join('Dan “D”');
    g.join('Ёжик');
    const anna = P(g, 'p1');
    expectLog(g, () => g.handle('p1', { t: 'transferHost', playerId: 'p7' }), () => [['log.host', { p: P(g, 'p7'), why: M('host.handover', { p: anna }) }]]);
    const dan = P(g, 'p7');
    expectLog(g, () => g.handle('p7', { t: 'leave' }), () => [['log.leftLobby', { p: dan }], ['log.host', { p: P(g, g.hostId), why: null }]]);
    const was = P(g, g.hostId);
    g.setConnected(g.hostId, false);
    expectLog(g, () => g.passHost(), () => [['log.host', { p: P(g, g.hostId), why: M('host.offline', { p: was }) }]]);
    assert.notEqual(g.hostId, was.p);
  });

  test('the start, the reveal phase, Next, the discussion and the timers', () => {
    const { g, ids, host } = table(4, { start: false });
    expectLog(g, () => g.handle(host, { t: 'start' }), [
      ['log.gameBegins', { n: 4, beds: 2, cata: { cata: { lit: 'Flood' } }, bname: { bname: { lit: 'Vault 9' } } }],
      ['log.roundReveal', { r: 1, max: 7, asc: true, first: true }],
    ]);
    assert.equal(g.timer.label, T('timer.turn', { p: P(g, g._speakerId()) }));
    const sp = g._speakerId();
    expectLog(g, () => g.handle(sp, { t: 'reveal', category: 'profession' }), () => [
      ['log.reveal', { rp: RP(g), p: P(g, sp), cat: CAT('profession'), card: TOK(cardText(g, sp, 'profession')), auto: false }],
    ]);
    g.handle(sp, { t: 'endTurn' });
    while (g.turn.index < g.turn.order.length - 1) {
      const who = g._speakerId();
      expectLog(g, () => g.handle(host, { t: 'next' }), () => [
        ['log.reveal', { rp: RP(g), p: P(g, who), cat: CAT('profession'), card: TOK(cardText(g, who, 'profession')), auto: true }],
      ]);
      assert.equal(g.timer.label, T('timer.turn', { p: P(g, g._speakerId()) }));
    }
    const last = g._speakerId();
    const rp1 = RP(g);
    expectLog(g, () => g.handle(host, { t: 'next' }), () => [
      ['log.reveal', { rp: rp1, p: P(g, last), cat: CAT('profession'), card: TOK(cardText(g, last, 'profession')), auto: true }],
      ['log.discussion', { rp: rp1, mode: 'none', k: 0 }],
    ]);
    assert.equal(g.timer.label, T('timer.discussion'));
    expectLog(g, () => g.handle(host, { t: 'next' }), [['log.roundReveal', { r: 2, max: 7, asc: false, first: false }]]);
    assert.deepEqual(g.turn.order, [...ids].reverse());
    // round 2: any hidden card, revealed by its owner
    const s2 = g._speakerId();
    expectLog(g, () => g.handle(s2, { t: 'reveal', category: 'skill' }), () => [
      ['log.reveal', { rp: RP(g), p: P(g, s2), cat: CAT('skill'), card: TOK(cardText(g, s2, 'skill')), auto: false }],
    ]);
  });

  test('a vote step: ×2 votes, abstentions, a tie, the defense, the revote, fate, nobody voting, the door', () => {
    const { g, ids, host } = table(6);
    const [a, b, c, d, e, f] = ids;
    g.kicks = [0, 2, 1, 0, 0, 0, 0];
    toRound(g, host, 2);
    finishReveal(g, host);
    assert.equal(g.phase, 'discussion');
    assert.equal(g.log.at(-1).text, T('log.discussion', { rp: RP(g), mode: 'vote', k: 2 }));
    expectSpecial(g, b, CARDS.double, {}, () => ['res.double', { p: P(g, b), now: false }]);
    expectSpecial(g, c, CARDS.block, { targetId: f }, () => ['res.block', { t: P(g, f) }]);
    expectLog(g, () => g.handle(host, { t: 'next' }), () => [['log.voteStep', { rp: RP(g), k: 2 }]]);
    const doubled = new Set(g.voteMods.doubleVote);
    g.handle(b, { t: 'vote', targetId: d });
    g.handle(a, { t: 'vote', targetId: e });
    g.handle(c, { t: 'vote', targetId: d });
    const rp = RP(g);
    expectLog(g, () => g.handle(host, { t: 'closeVote' }), () => [
      ['log.tally', { rp, revote: false, ballot: 1, ballots: 2, rows: tallyRows(g, doubled), abstained: Ps(g, [d, e]) }],
      ['log.eject', { p: P(g, d), how: 0 }],
    ]);
    // ballot 2: a tie, then the defense
    g.handle(b, { t: 'vote', targetId: c });
    g.handle(a, { t: 'vote', targetId: e });
    g.handle(c, { t: 'vote', targetId: e });
    expectLog(g, () => g.handle(host, { t: 'closeVote' }), () => [
      ['log.tally', { rp, revote: false, ballot: 2, ballots: 2, rows: tallyRows(g, doubled), abstained: Ps(g, [e]) }],
      ['log.tie', { rp, ids: Ps(g, [c, e]) }],
    ]);
    assert.equal(g.phase, 'defense');
    assert.equal(g.timer.label, T('timer.defense', { p: P(g, c) }));
    g.handle(c, { t: 'endTurn' });
    assert.equal(g.timer.label, T('timer.defense', { p: P(g, e) }));
    expectLog(g, () => g.handle(e, { t: 'endTurn' }), () => [['log.revote', { rp, ids: Ps(g, [c, e]) }]]);
    g.handle(a, { t: 'vote', targetId: c });
    g.handle(c, { t: 'vote', targetId: e });
    expectLog(g, () => g.handle(host, { t: 'closeVote' }), () => [
      ['log.tally', { rp, revote: true, ballot: 2, ballots: 2, rows: tallyRows(g, doubled), abstained: Ps(g, [b, e]) }],
      ['log.eject', { p: P(g, g.lastVoteResult.ejectedId), how: 2 }],
      ['log.roundReveal', { r: 3, max: 7, asc: true, first: false }],
    ]);
    // round 3: nobody votes, fate decides, and the game ends
    finishReveal(g, host);
    assert.equal(g.log.at(-1).text, T('log.discussion', { rp: RP(g), mode: 'vote', k: 1 }));
    g.handle(host, { t: 'next' });
    const voters = [...g.vote.voters];
    const rp3 = RP(g);
    expectLog(g, () => g.handle(host, { t: 'closeVote' }), () => [
      ['log.tally', { rp: rp3, revote: false, ballot: 1, ballots: 1, rows: tallyRows(g, new Set()), abstained: Ps(g, voters) }],
      ['log.eject', { p: P(g, g.lastVoteResult.ejectedId), how: 1 }],
      ['log.doorCloses', { in: Ps(g, g.final.survivors), out: Ps(g, g.final.out) }],
    ]);
    // the final: Next, End game and Play again
    expectErr(g.handle(host, { t: 'next' }), 'wrong_phase', 'err.usePlayAgain');
    expectLog(g, () => g.handle(host, { t: 'endGame' }), [['log.backToLobby', {}]]);
  });

  test('the door with nobody on one side, End game mid-vote, Play again', () => {
    const { g, ids, host } = table(4);
    expectLog(g, () => g._enterFinal(), () => [['log.doorCloses', { in: Ps(g, ids), out: [] }]]);
    expectLog(g, () => g.handle(host, { t: 'playAgain' }), [['log.backToLobby', {}]]);
    g.handle(host, { t: 'start' });
    for (const p of g.players) p.status = 'left';
    expectLog(g, () => g._enterFinal(), () => [['log.doorCloses', { in: [], out: Ps(g, ids) }]]);
    const t2 = table(6);
    t2.g.kicks = [1, 0, 0, 0, 0, 0, 0];
    finishReveal(t2.g, t2.host);
    t2.g.handle(t2.host, { t: 'next' });
    assert.equal(t2.g.phase, 'vote');
    expectLog(t2.g, () => t2.g.handle(t2.host, { t: 'endGame' }), [['log.endGame', {}], ['log.backToLobby', {}]]);
  });

  test('specials: every effect and result', () => {
    const { g, ids, host } = table(6);
    const [a, b, c, d, e, f] = ids;
    toRound(g, host, 2);
    expectSpecial(g, a, CARDS.swap, { targetId: b, category: 'health' }, () => ['res.swap', {
      a: P(g, a), b: P(g, b), cat: CAT('health'), ca: TOK(cardText(g, a, 'health')), cb: TOK(cardText(g, b, 'health')),
    }]);
    expectSpecial(g, a, CARDS.rerollSelf, {}, () => ['res.reroll', { t: P(g, a), cat: CAT('baggage'), c: TOK(cardText(g, a, 'baggage')) }]);
    expectSpecial(g, a, CARDS.rerollOther, { targetId: b, category: 'skill' }, () => ['res.reroll', { t: P(g, b), cat: CAT('skill'), c: TOK(cardText(g, b, 'skill')) }]);
    expectSpecial(g, a, CARDS.force, { targetId: c, category: 'trait' }, () => ['res.force', { t: P(g, c), cat: CAT('trait'), c: TOK(cardText(g, c, 'trait')) }]);
    let forced = null;
    const hiddenBefore = g._hidden(g._player(d));
    expectSpecial(g, a, CARDS.forceRandom, { targetId: d }, () => {
      forced = hiddenBefore.find((x) => g._player(d).cards[x].revealed);
      return ['res.force', { t: P(g, d), cat: CAT(forced), c: TOK(cardText(g, d, forced)) }];
    });
    const rp = RP(g);
    expectSpecial(g, b, CARDS.peek, { targetId: e, category: 'biology' }, () => ['res.peek', { p: P(g, b), t: P(g, e) }]);
    assert.equal(g._player(b).notes.at(-1).text, T('note.peek', { rp, t: P(g, e), cat: CAT('biology'), c: TOK(cardText(g, e, 'biology')) }));
    const rows = (cat) => g._alive().map((x) => ({ p: P(g, x.id), c: TOK(x.cards[cat].text) }));
    expectSpecial(g, c, CARDS.mass, {}, () => ['res.mass', { cat: CAT('hobby'), rows: rows('hobby') }]);
    expectSpecial(g, c, CARDS.shuffle, {}, () => ['res.shuffle', { cat: CAT('phobia'), rows: rows('phobia') }]);
    expectSpecial(g, e, CARDS.immunity, {}, () => ['res.protect', { t: P(g, e) }]);
    expectSpecial(g, a, CARDS.protect, { targetId: b }, () => ['res.protect', { t: P(g, b) }]);
    expectSpecial(g, d, CARDS.cancel, {}, () => ['res.cancelNext', {}]);
    expectSpecial(g, d, CARDS.plus, {}, () => ['res.beds', { n: 4 }]);
    expectSpecial(g, d, CARDS.minus, {}, () => ['res.beds', { n: 3 }]);
    expectSpecial(g, d, CARDS.minus, {}, () => ['res.beds', { n: 2 }]);
    expectSpecial(g, d, CARDS.minus, {}, () => ['res.beds', { n: 1 }]);
    expectSpecial(g, d, CARDS.minus, {}, () => ['res.bedsMin', { n: 1 }]);
    g.capacity = 3;
    expectSpecial(g, e, CARDS.feature, {}, () => ['res.feature', { f: { feat: { lit: g.bunker.features.at(-1) } } }]);
    // the retired one-player eject, then Back from the Forest in each timing (round 2 speaks f, e, d, c, b, a)
    assert.deepEqual(g.turn.order, [f, e, d, c, b, a]);
    assert.equal(g._speakerId(), f);
    expectSpecial(g, a, CARDS.eject, { targetId: f }, () => ['res.eject', { t: P(g, f) }]);
    assert.equal(g._speakerId(), e); // the ejected speaker's turn passed on
    expectSpecial(g, b, CARDS.revive, { targetId: f }, () => ['res.revive', { t: P(g, f), when: 2 }]);
    expectSpecial(g, a, CARDS.eject, { targetId: c }, () => ['res.eject', { t: P(g, c) }]);
    expectSpecial(g, d, CARDS.revive, { targetId: c }, () => ['res.revive', { t: P(g, c), when: 1 }]);
    finishReveal(g, host);
    assert.equal(g.phase, 'discussion');
    g._player(f).status = 'ejected';
    expectSpecial(g, d, CARDS.revive, { targetId: f }, () => ['res.revive', { t: P(g, f), when: 0 }]);
    // a feature when the dealer has none: the engine's own fallback
    const t2 = table(4, { features: 'throw' });
    expectSpecial(t2.g, t2.ids[1], CARDS.feature, {}, () => ['res.feature', { f: { feat: { lit: 'A hidden storeroom' } } }]);
    assert.equal(t2.g.bunker.features.at(-1), 'A hidden storeroom');
  });

  test('specials inside a vote step: ×2 now, Cancel vote now and for the rest, the extra bed', () => {
    const { g, ids, host } = table(6);
    const [a, b, c, d, e] = ids;
    g.kicks = [0, 3, 0, 0, 0, 0, 0];
    toRound(g, host, 2);
    finishReveal(g, host);
    g.handle(host, { t: 'next' });
    assert.equal(g.phase, 'vote');
    assert.equal(g.step.ballots, 3);
    const rp = RP(g);
    expectSpecial(g, a, CARDS.plus, {}, () => ['res.beds', { n: 4 }], () => [
      ['log.ballotsFewer', { rp, why: M('why.bed'), fewer: 1, n: 2, before: 3 }],
    ]);
    expectSpecial(g, b, CARDS.double, {}, () => ['res.double', { p: P(g, b), now: true }]);
    const doubled = new Set(g.voteMods.doubleVote);
    const voters1 = [...g.vote.voters];
    g.handle(b, { t: 'vote', targetId: c });
    expectLog(g, () => g.handle(host, { t: 'closeVote' }), () => [
      ['log.tally', { rp, revote: false, ballot: 1, ballots: 2, rows: tallyRows(g, doubled), abstained: Ps(g, voters1.filter((x) => x !== b)) }],
      ['log.eject', { p: P(g, c), how: 0 }],
    ]);
    const mods = modsParams(g);
    assert.ok(mods);
    expectSpecial(g, d, CARDS.cancel, {}, () => ['res.cancelRest', {}], () => [
      ['log.stepCancelled', { rp, earlier: true, mods }],
      ['log.roundReveal', { r: 3, max: 7, asc: true, first: false }],
    ]);
    // Cancel vote before anyone is out
    const t2 = table(6);
    t2.g.kicks = [0, 2, 0, 0, 0, 0, 0];
    toRound(t2.g, t2.host, 2);
    finishReveal(t2.g, t2.host);
    t2.g.handle(t2.host, { t: 'next' });
    const [a2, b2] = t2.ids;
    expectSpecial(t2.g, b2, CARDS.double, {}, () => ['res.double', { p: P(t2.g, b2), now: true }]);
    const rp2 = RP(t2.g);
    const mods2 = modsParams(t2.g);
    assert.ok(mods2);
    expectSpecial(t2.g, a2, CARDS.cancel, {}, () => ['res.cancelNow', {}], () => [
      ['log.stepCancelled', { rp: rp2, earlier: false, mods: mods2 }],
      ['log.roundReveal', { r: 3, max: 7, asc: true, first: false }],
    ]);
  });

  test('a cancelled vote with every kind of modifier, one kick and two', () => {
    for (const [k, withMods] of [[1, true], [2, false], [2, true]]) {
      const { g, ids, host } = table(8);
      const [a, b, c, d, e] = ids;
      g.kicks = [0, k, 0, 0, 0, 0, 0];
      toRound(g, host, 2);
      expectSpecial(g, a, CARDS.cancel, {}, () => ['res.cancelNext', {}]);
      const rp = RP(g);
      if (withMods) {
        expectSpecial(g, b, CARDS.immunity, {}, () => ['res.protect', { t: P(g, b) }]);
        expectSpecial(g, c, CARDS.block, { targetId: d }, () => ['res.block', { t: P(g, d) }]);
        expectSpecial(g, e, CARDS.double, {}, () => ['res.double', { p: P(g, e), now: false }]);
        if (k === 2) expectSpecial(g, d, CARDS.protect, { targetId: a }, () => ['res.protect', { t: P(g, a) }]);
      }
      const who = g.turn.order.at(-1);
      g.turn.index = g.turn.order.length - 1;
      g.turn.hasRevealed = true;
      expectLog(g, () => g.handle(who, { t: 'endTurn' }), [['log.discussion', { rp, mode: 'cancelled', k }]]);
      const mods = modsParams(g);
      assert.equal(!!mods, withMods);
      expectLog(g, () => g.handle(host, { t: 'next' }), [
        ['log.voteSkipped', { rp, k, mods }],
        ['log.roundReveal', { r: 3, max: 7, asc: true, first: false }],
      ]);
    }
  });

  test('everyone immune, before and after an ejection; no more ejections due; ballots that drop', () => {
    {
      const { g, host } = table(6);
      g.kicks = [0, 1, 0, 0, 0, 0, 0];
      toRound(g, host, 2);
      finishReveal(g, host);
      for (const p of g._alive()) g.voteMods.immune.add(p.id);
      const rp = RP(g);
      const mods = modsParams(g);
      expectLog(g, () => g.handle(host, { t: 'next' }), [
        ['log.voteStep', { rp, k: 1 }],
        ['log.allImmune', { rp }],
        ['log.stepCancelled', { rp, earlier: false, mods }],
        ['log.roundReveal', { r: 3, max: 7, asc: true, first: false }],
      ]);
    }
    {
      const { g, ids, host } = table(8);
      g.kicks = [0, 2, 0, 0, 0, 0, 0];
      toRound(g, host, 2);
      finishReveal(g, host);
      g.handle(host, { t: 'next' });
      const voters = [...g.vote.voters];
      g.handle(ids[1], { t: 'vote', targetId: ids[2] });
      for (const p of g._alive()) if (p.id !== ids[2]) g.voteMods.immune.add(p.id);
      const rp = RP(g);
      const mods = modsParams(g);
      assert.equal(mods.msg.params.n, ids.length - 1);
      expectLog(g, () => g.handle(host, { t: 'closeVote' }), () => [
        ['log.tally', { rp, revote: false, ballot: 1, ballots: 2, rows: tallyRows(g, new Set()), abstained: Ps(g, voters.filter((x) => x !== ids[1])) }],
        ['log.eject', { p: P(g, ids[2]), how: 0 }],
        ['log.allImmune', { rp }],
        ['log.stepCancelled', { rp, earlier: true, mods }],
        ['log.roundReveal', { r: 3, max: 7, asc: true, first: false }],
      ]);
    }
    {
      const { g, ids, host } = table(8);
      g.kicks = [0, 2, 0, 0, 0, 0, 0];
      toRound(g, host, 2);
      finishReveal(g, host);
      g.handle(host, { t: 'next' });
      const voters = [...g.vote.voters];
      g.handle(ids[1], { t: 'vote', targetId: ids[2] });
      g.kicks = [0, 0, 0, 0, 0, 0, 0];
      const rp = RP(g);
      expectLog(g, () => g.handle(host, { t: 'closeVote' }), () => [
        ['log.tally', { rp, revote: false, ballot: 1, ballots: 2, rows: tallyRows(g, new Set()), abstained: Ps(g, voters.filter((x) => x !== ids[1])) }],
        ['log.eject', { p: P(g, ids[2]), how: 0 }],
        ['log.noMoreDue', { rp }],
        ['log.roundReveal', { r: 3, max: 7, asc: true, first: false }],
      ]);
    }
    {
      // a leave during the vote: one ejection fewer; then the counts the log can print
      const { g, ids, host } = table(10);
      g.kicks = [0, 2, 0, 0, 0, 0, 0];
      toRound(g, host, 2);
      finishReveal(g, host);
      g.handle(host, { t: 'next' });
      const rp = RP(g);
      const gone = P(g, ids[4]);
      expectLog(g, () => g.handle(ids[4], { t: 'leave' }), [
        ['log.leftGame', { p: gone }],
        ['log.ballotsFewer', { rp, why: M('why.gone', { p: gone }), fewer: 1, n: 1, before: 2 }],
      ]);
      g.step.ballot = 2;
      g.step.ballots = 5;
      expectLog(g, () => g._refreshBallots('', true), [['log.ballotsFewer', { rp, why: null, fewer: 3, n: 2, before: 5 }]]);
      g.step.ballots = 3;
      expectLog(g, () => g._refreshBallots(`with ${gone.n} gone`, true), [['log.ballotsFewer', { rp, why: M('why.gone', { p: gone }), fewer: 1, n: 2, before: 3 }]]);
    }
  });

  test('leaves, kicks and host changes in a game; nobody left to vote out', () => {
    const { g, ids, host } = table(10);
    const [a, b, c, d, e] = ids;
    g.kicks = [0, 3, 0, 0, 0, 0, 0]; // round 2: 3 due, minus the 2 who leave = 1
    toRound(g, host, 2);
    const bob = P(g, b);
    expectLog(g, () => g.handle(host, { t: 'kick', playerId: b }), [['log.kicked', { p: bob }]]);
    const anna = P(g, a);
    expectLog(g, () => g.handle(a, { t: 'leave' }), () => [['log.leftGame', { p: anna }], ['log.host', { p: P(g, c), why: null }]]);
    assert.equal(g.hostId, c);
    finishReveal(g, c);
    g.handle(c, { t: 'next' });
    assert.equal(g.phase, 'vote');
    assert.equal(g.step.ballots, 1);
    // a tie between d and e: the other voters split, d and e vote for each other
    g.vote.votes.clear();
    g.vote.voters.filter((v) => v !== d && v !== e).forEach((v, i) => g.vote.votes.set(v, i % 2 ? d : e));
    g.vote.votes.set(d, e);
    g.vote.votes.set(e, d);
    g._closeBallot();
    assert.equal(g.phase, 'defense');
    assert.deepEqual(g.step.tied, [d, e]);
    const dan = P(g, d);
    expectLog(g, () => g.handle(d, { t: 'leave' }), [['log.leftGame', { p: dan }]]);
    const eve = P(g, e);
    const rp = RP(g);
    expectLog(g, () => g.handle(e, { t: 'leave' }), [
      ['log.leftGame', { p: eve }],
      ['log.nobodyLeft', { rp }],
      ['log.roundReveal', { r: 3, max: 7, asc: true, first: false }],
    ]);
  });

  test('the Airlock: started, sealed, jammed at the end of the discussion and by a leave; overtime', () => {
    const { g, ids, host } = table(10);
    const [a, b, c, d, e, f] = ids;
    toRound(g, host, 2);
    expectLog(g, () => g.handle(a, { t: 'special', uid: give(g, a, CARDS.airlock).uid, targetId: c }), () => [
      ['log.airlockStart', { a: P(g, a), t: P(g, c), ot: false }],
    ]);
    expectLog(g, () => g.handle(b, { t: 'special', uid: give(g, b, CARDS.airlock).uid, targetId: c }), () => [
      ['log.airlockSeal', { a: P(g, b), by: Ps(g, [a]), t: P(g, c) }],
    ]);
    g.handle(d, { t: 'special', uid: give(g, d, CARDS.airlock).uid, targetId: e });
    g._player(d).lastSpecialRound = 0;
    expectErr(g.handle(d, { t: 'special', uid: give(g, d, CARDS.airlock).uid, targetId: e }), 'not_allowed', 'err.ownAirlock', { t: P(g, e) });
    g._player(f).lastSpecialRound = 0;
    g.handle(f, { t: 'special', uid: give(g, f, CARDS.airlock).uid, targetId: ids[6] });
    const leaver = P(g, ids[6]);
    expectLog(g, () => g.handle(ids[6], { t: 'leave' }), () => [['log.leftGame', { p: leaver }], ['log.airlockJam', { t: leaver }]]);
    finishReveal(g, host);
    expectLog(g, () => g.handle(host, { t: 'next' }), () => [
      ['log.airlockJam', { t: P(g, e) }],
      ['log.roundReveal', { r: 3, max: 7, asc: true, first: false }],
    ]);
    // overtime
    finishReveal(g, host);
    g.round = 7;
    const cap = g.capacity;
    expectLog(g, () => g._afterStep(), () => [
      ['log.overtime', { alive: g._aliveCount(), beds: cap }],
      ['log.discussion', { rp: { r: 7, ot: true }, mode: 'vote', k: g._aliveCount() - cap }],
    ]);
    assert.equal(g.timer.label, T('timer.otDiscussion'));
    const opener = g._alive()[0].id;
    const target = g._alive()[1].id;
    g._player(opener).lastSpecialRound = 0;
    expectLog(g, () => g.handle(opener, { t: 'special', uid: give(g, opener, CARDS.airlock).uid, targetId: target }), () => [
      ['log.airlockStart', { a: P(g, opener), t: P(g, target), ot: true }],
    ]);
    expectLog(g, () => g.handle(g.hostId, { t: 'next' }), () => [
      ['log.airlockJam', { t: P(g, target) }],
      ['log.voteStep', { rp: { r: 7, ot: true }, k: g._aliveCount() - g.capacity }],
    ]);
  });

  test('errors of the engine: the default per code and every specific message', () => {
    for (const code of ['bad_request', 'not_in_room', 'no_room', 'bad_token', 'server_busy', 'room_full', 'not_host', 'wrong_phase', 'not_your_turn', 'not_allowed', 'replaced']) {
      expectErr(old.fail(code), code, `err.${code}`);
    }
    expectErr(old.validateMessage(null), 'bad_request', 'err.expectedObject');
    expectErr(old.validateMessage([]), 'bad_request', 'err.expectedObject');
    expectErr(old.validateMessage({ t: 'nope' }), 'bad_request', 'err.unknownType');
    expectErr(old.validateMessage({ t: 'kick' }), 'bad_request', 'err.missingField', { field: 'playerId' });
    expectErr(old.validateMessage({ t: 'join', name: 'A' }), 'bad_request', 'err.missingField', { field: 'room' });
    expectErr(old.validateMessage({ t: 'kick', playerId: 3 }), 'bad_request', 'err.invalidField', { field: 'playerId' });
    expectErr(old.validateMessage({ t: 'setOptions', options: { speechSeconds: 3 } }), 'bad_request', 'err.optionRange', { field: 'speechSeconds' });
    assert.equal(old.normalizeSpecial({ effect: 'peek' }).title, T('special.untitled'));

    // the lobby
    const lobby = new old.Game({ room: 'GOLD', rng: mulberry32(3), now: () => 0, minPlayers: 4, dealer: dealer(), fixedSpecials: false });
    expectErr(lobby.join('   '), 'bad_request', 'err.nameRequired');
    const [h, x] = [lobby.join('Anna').id, lobby.join('Bob').id];
    const s = lobby.join('Sam', { spectator: true }).id;
    expectErr(lobby.handle(h, { t: 'ping' }), 'bad_request', 'err.notGameAction', { type: 'ping' });
    expectErr(lobby.handle('nobody', { t: 'leave' }), 'not_in_room', 'err.not_in_room');
    expectErr(lobby.handle(x, { t: 'setOptions', options: {} }), 'not_host', 'err.not_host');
    expectErr(lobby.handle(h, { t: 'start' }), 'not_allowed', 'err.tooFewPlayers', { n: 4 });
    expectErr(lobby.handle(h, { t: 'next' }), 'wrong_phase', 'err.useStart');
    expectErr(lobby.handle(h, { t: 'endGame' }), 'wrong_phase', 'err.endGameLobby');
    expectErr(lobby.handle(h, { t: 'playAgain' }), 'wrong_phase', 'err.playAgainFinal');
    expectErr(lobby.handle(x, { t: 'takeSeat' }), 'not_allowed', 'err.alreadySeated');
    expectErr(lobby.handle(h, { t: 'kick', playerId: 'p99' }), 'not_allowed', 'err.noSuchPlayer');
    expectErr(lobby.handle(h, { t: 'kick', playerId: h }), 'not_allowed', 'err.kickSelf');
    expectErr(lobby.handle(h, { t: 'transferHost', playerId: h }), 'not_allowed', 'err.transferTarget');
    expectErr(lobby.handle(h, { t: 'reveal', category: 'health' }), 'wrong_phase', 'err.revealPhase');
    expectErr(lobby.handle(h, { t: 'endTurn' }), 'wrong_phase', 'err.noTurn');
    expectErr(lobby.handle(h, { t: 'vote', targetId: x }), 'wrong_phase', 'err.noOpenVote');
    expectErr(lobby.handle(h, { t: 'closeVote' }), 'wrong_phase', 'err.noOpenVote');
    expectErr(lobby.handle(h, { t: 'special', uid: 's1' }), 'wrong_phase', 'err.specialPhase');
    for (let i = 0; i < 14; i++) lobby.join(`X${i}`);
    expectErr(lobby.handle(s, { t: 'takeSeat' }), 'room_full', 'err.seatsFull');
    for (let i = 0; i < 49; i++) lobby.join(`S${i}`, { spectator: true });
    expectErr(lobby.join('One more'), 'room_full', 'err.room_full');
    const crash = table(2, { start: false }).g;
    crash._uniqueName = () => { throw new Error('boom'); };
    expectErr(crash.join('Crash'), 'not_allowed', 'err.internal');
    crash._leave = () => { throw new Error('boom'); };
    expectErr(crash.handle('p2', { t: 'leave' }), 'not_allowed', 'err.internal');

    // a game
    const { g, ids, host } = table(6);
    const [a, b, c, d, e, f] = ids;
    const spec = g.join('Late', { spectator: true }).id;
    expectErr(g.handle(host, { t: 'setOptions', options: {} }), 'wrong_phase', 'err.optionsLobbyOnly');
    expectErr(g.handle(host, { t: 'start' }), 'wrong_phase', 'err.alreadyStarted');
    expectErr(g.handle(spec, { t: 'takeSeat' }), 'wrong_phase', 'err.seatsLobbyOnly');
    const sp = g._speakerId();
    const other = ids.find((id) => id !== sp);
    expectErr(g.handle(other, { t: 'reveal', category: 'profession' }), 'not_your_turn', 'err.not_your_turn');
    expectErr(g.handle(sp, { t: 'reveal', category: 'health' }), 'not_allowed', 'err.round1Profession');
    expectErr(g.handle(sp, { t: 'endTurn' }), 'not_allowed', 'err.revealFirst');
    expectErr(g.handle(sp, { t: 'endTurn', at: { round: 5 } }), 'wrong_phase', 'err.stale');
    g.handle(sp, { t: 'reveal', category: 'profession' });
    expectErr(g.handle(sp, { t: 'reveal', category: 'profession' }), 'not_allowed', 'err.alreadyRevealed');
    const air = give(g, a, CARDS.airlock);
    expectErr(g.handle(a, { t: 'special', uid: air.uid, targetId: b }), 'not_allowed', 'err.fromRound', { n: 2 });
    expectErr(g.handle(spec, { t: 'special', uid: 's1' }), 'not_allowed', 'err.spectatorSpecial');
    expectErr(g.handle(a, { t: 'special', uid: 'nope' }), 'not_allowed', 'err.noCard');
    toRound(g, host, 2);
    const s2 = g._speakerId();
    g.handle(s2, { t: 'reveal', category: 'health' });
    g.turn.hasRevealed = false;
    expectErr(g.handle(s2, { t: 'reveal', category: 'health' }), 'not_allowed', 'err.cardRevealed');
    const pick = give(g, a, CARDS.force);
    expectErr(g.handle(a, { t: 'special', uid: pick.uid, targetId: b }), 'not_allowed', 'err.pickCategory');
    expectErr(g.handle(a, { t: 'special', uid: pick.uid, targetId: b, category: 'profession' }), 'not_allowed', 'err.notHidden');
    expectErr(g.handle(a, { t: 'special', uid: pick.uid, targetId: a, category: 'health' }), 'not_allowed', 'err.pickAlive');
    for (const cat of old.CATEGORY_IDS) g._player(c).cards[cat].revealed = true;
    expectErr(g.handle(a, { t: 'special', uid: pick.uid, targetId: c, category: 'health' }), 'not_allowed', 'err.noHidden');
    const rev = give(g, a, CARDS.revive);
    expectErr(g.handle(a, { t: 'special', uid: rev.uid, targetId: b }), 'not_allowed', 'err.pickEjected');
    const cn = give(g, a, CARDS.cancel);
    g.voteMods.cancelNext = true;
    expectErr(g.handle(a, { t: 'special', uid: cn.uid }), 'not_allowed', 'err.cancelledAlready');
    g.voteMods.cancelNext = false;
    const dbl = give(g, b, CARDS.double);
    g.voteMods.blocked.add(b);
    expectErr(g.handle(b, { t: 'special', uid: dbl.uid }), 'not_allowed', 'err.doubleBlocked', { now: false });
    g.voteMods.blocked.delete(b);
    const used = give(g, d, CARDS.plus);
    g.handle(d, { t: 'special', uid: used.uid });
    g._player(d).lastSpecialRound = 0;
    expectErr(g.handle(d, { t: 'special', uid: used.uid }), 'not_allowed', 'err.cardUsed');
    const two = give(g, d, CARDS.plus);
    g.handle(d, { t: 'special', uid: give(g, d, CARDS.minus).uid });
    expectErr(g.handle(d, { t: 'special', uid: two.uid }), 'not_allowed', 'err.oneSpecial');
    g._player(f).status = 'ejected';
    const dead = give(g, f, CARDS.plus);
    expectErr(g.handle(f, { t: 'special', uid: dead.uid }), 'not_allowed', 'err.specialAlive');
    g._player(f).status = 'alive';
    finishReveal(g, host);
    expectErr(g.handle(sp, { t: 'reveal', category: 'hobby' }), 'wrong_phase', 'err.revealPhase');
    expectErr(g.handle(host, { t: 'endTurn' }), 'wrong_phase', 'err.noTurn');
    // the vote
    g.kicks = [0, 1, 0, 0, 0, 0, 0];
    g.voteMods.blocked.add(e);
    g.voteMods.immune.add(f);
    g.handle(host, { t: 'next' });
    assert.equal(g.phase, 'vote');
    expectErr(g.handle(e, { t: 'vote', targetId: a }), 'not_allowed', 'err.notVoter');
    expectErr(g.handle(a, { t: 'vote', targetId: a }), 'not_allowed', 'err.voteSelf');
    expectErr(g.handle(a, { t: 'vote', targetId: f }), 'not_allowed', 'err.notCandidate');
    const imm = give(g, a, CARDS.immunity);
    g._player(a).lastSpecialRound = 0;
    expectErr(g.handle(a, { t: 'special', uid: imm.uid }), 'wrong_phase', 'err.beforeVoteOnly');
    const dbl2 = give(g, e, CARDS.double);
    g._player(e).lastSpecialRound = 0;
    expectErr(g.handle(e, { t: 'special', uid: dbl2.uid }), 'not_allowed', 'err.doubleBlocked', { now: true });
    g.vote.voters = g.vote.voters.filter((v) => v !== d);
    const dbl3 = give(g, d, CARDS.double);
    g._player(d).lastSpecialRound = 0;
    expectErr(g.handle(d, { t: 'special', uid: dbl3.uid }), 'not_allowed', 'err.doubleNotVoter');
  });
});

// ------------------------------------------------------------------------------------------------ rooms.js and dev.js
describe('i18n A1: English equals the rooms.js and dev.js strings', () => {
  function socket(ip = '198.51.100.7') {
    const conn = { ip, sent: [], send(obj) { this.sent.push(obj); } };
    return conn;
  }
  const last = (conn) => conn.sent.at(-1);
  const expectSent = (conn, code, key, params) => assert.deepEqual(last(conn), { t: 'error', code, message: T(key, params) });

  test('rooms.js: every error it sends and the kicked reason', () => {
    const rooms = new Rooms({ now: () => 1000, joinFailBurst: 1, joinFailRefillMs: 1e9, maxRoomsPerIp: 1, minPlayers: 2 });
    const x = socket();
    rooms.open(x);
    rooms.message(x, null);
    expectSent(x, 'bad_request', 'err.jsonFrame');
    rooms.message(x, '{');
    expectSent(x, 'bad_request', 'err.malformedJson');
    rooms.message(x, JSON.stringify({ t: 'dev', op: 'god', on: true }));
    expectSent(x, 'not_allowed', 'err.devOff');
    assert.equal(DEV_OFF, T('err.devOff'));
    rooms.message(x, JSON.stringify({ t: 'create', name: ' ' }));
    expectSent(x, 'bad_request', 'err.nameRequired');
    rooms.message(x, JSON.stringify({ t: 'join', room: 'ZZZZ', name: 'A' }));
    expectSent(x, 'no_room', 'err.noRoomJoin');
    rooms.message(x, JSON.stringify({ t: 'join', room: 'ZZZZ', name: 'A' }));
    expectSent(x, 'server_busy', 'err.lookupThrottled');
    const y = socket('203.0.113.9');
    rooms.open(y);
    rooms.message(y, JSON.stringify({ t: 'resume', room: 'ZZZZ', token: 'x' }));
    expectSent(y, 'no_room', 'err.noRoomResume');
    const host = socket('192.0.2.1');
    rooms.open(host);
    rooms.message(host, JSON.stringify({ t: 'create', name: 'Anna' }));
    const joined = host.sent.find((m) => m.t === 'joined');
    const z = socket('192.0.2.200');
    rooms.open(z);
    rooms.message(z, JSON.stringify({ t: 'resume', room: joined.room, token: 'wrong' }));
    expectSent(z, 'bad_token', 'err.bad_token');
    const again = socket('192.0.2.1');
    rooms.open(again);
    rooms.message(again, JSON.stringify({ t: 'create', name: 'Anna' }));
    expectSent(again, 'server_busy', 'err.tooManyRooms');
    const tab = socket('192.0.2.1');
    rooms.open(tab);
    rooms.message(tab, JSON.stringify({ t: 'resume', room: joined.room, token: joined.token }));
    expectSent(host, 'replaced', 'err.replacedTab');
    const guest = socket('192.0.2.50');
    rooms.open(guest);
    rooms.message(guest, JSON.stringify({ t: 'join', room: joined.room, name: 'Bob' }));
    const guestId = guest.sent.find((m) => m.t === 'joined').id;
    rooms.message(tab, JSON.stringify({ t: 'kick', playerId: guestId }));
    assert.deepEqual(guest.sent.at(-1), { t: 'kicked', reason: T('kick.reason') });
    rooms.message(tab, JSON.stringify({ t: 'next' }));
    expectSent(tab, 'wrong_phase', 'err.useStart');
    rooms._message = () => { throw new Error('boom'); };
    rooms.message(x, '{}');
    expectSent(x, 'bad_request', 'err.generic');
  });

  test('dev.js: every log line and error of DEV_TEXT', async () => {
    const dev = await import('../server/dev.js');
    const { DEV_TEXT: D } = dev;
    assert.ok(D, 'server/dev.js exports DEV_TEXT');
    const A = { p: 'p1', n: 'Anna' };
    const B = { p: 'p2', n: 'Bob' };
    const C = { p: 'p3', n: 'Cleo {p}' };
    const alibi = { id: 'alibi', title: 'Alibi', text: 'You were elsewhere.' };
    assert.equal(D.log.seed('42'), T('log.dev.seed', { seed: '42' }));
    assert.equal(D.log.seed('a “b” {c}'), T('log.dev.seed', { seed: 'a “b” {c}' }));
    assert.equal(D.log.giveSpecial('Anna', 'Bob', 'Alibi'), T('log.dev.giveSpecial', { a: A, t: B, card: SP(alibi) }));
    assert.equal(D.log.autoReveal('Anna', 'Round 3'), T('log.dev.autoReveal', { a: A, rp: { r: 3, ot: false } }));
    assert.equal(D.log.autoReveal('Anna', 'Overtime'), T('log.dev.autoReveal', { a: A, rp: { r: 7, ot: true } }));
    assert.equal(D.log.skipToVote('Anna'), T('log.dev.skipToVote', { a: A }));
    assert.equal(D.log.forceTie('Anna', 'Bob, Cleo {p}'), T('log.dev.forceTie', { a: A, ids: [B, C] }));
    assert.equal(D.log.god('Anna', true), T('log.dev.god', { a: A, on: true }));
    assert.equal(D.log.god('Anna', false), T('log.dev.god', { a: A, on: false }));
    assert.equal(D.log.fastTimers('Anna', 5), T('log.dev.fastTimers', { a: A, secs: 5 }));
    for (const [n, seated] of [[1, true], [3, true], [1, false], [15, false]]) {
      assert.equal(D.log.addBots('Anna', n, seated), T('log.dev.addBots', { a: A, n, seated }));
    }
    const E = D.errors;
    assert.equal(E.badMessage, T('err.expectedObject'));
    assert.equal(E.missing('ids'), T('err.missingField', { field: 'ids' }));
    assert.equal(E.invalid('count'), T('err.invalidField', { field: 'count' }));
    assert.equal(E.internal, T('err.internal'));
    for (const k of ['badOp', 'badSeed', 'ejectRetired', 'noPlayer', 'noGame', 'gameOver', 'notReveal', 'ballotOpen', 'noBallot',
      'revote', 'duplicate', 'impossible', 'tableFull', 'spectatorsFull']) {
      assert.equal(E[k], T(`err.dev.${k}`), k);
    }
    for (const k of ['playerLeft', 'notAlive', 'immune']) assert.equal(E[k]('Cleo {p}'), T(`err.dev.${k}`, { p: C }), k);
    const extra = Object.keys(E).filter((k) => !['badMessage', 'missing', 'invalid', 'internal', 'badOp', 'badSeed', 'ejectRetired', 'noPlayer', 'playerLeft',
      'noGame', 'gameOver', 'notReveal', 'ballotOpen', 'noBallot', 'revote', 'duplicate', 'notAlive', 'immune', 'impossible', 'tableFull', 'spectatorsFull'].includes(k));
    assert.deepEqual(extra, [], 'a dev error without a key');
    assert.deepEqual(Object.keys(D.log).sort(), ['addBots', 'autoReveal', 'fastTimers', 'forceTie', 'giveSpecial', 'god', 'seed', 'skipToVote']);

    // (dev.js now logs by key through the X5 engine's refs, so it no longer runs on the pre-X5 engine; the pre-X5 line
    // it wrote there was DEV_TEXT's, pinned above)
    const line = D.log.autoReveal('Bob', 'Round 1');

    // on the X5 engine dev.js logs by key (i18n-integration): the English text is DEV_TEXT's, a Russian view renders the
    // line in Russian, and its errors carry keys too
    const x = new X5.Game({ room: 'GOLD', rng: mulberry32(7), now: () => 1_800_000_000_000, minPlayers: 2, dealer: dealer(), fixedSpecials: false });
    const xids = ['Anna', 'Bob', 'Cleo {p}', 'Dan “D”'].map((n) => x.join(n).id);
    assert.equal(x.handle(xids[0], { t: 'start' }).ok, true);
    const xfrom = x.logSeq;
    const ops = dev.createDevOps();
    assert.equal(ops.run(x, xids[1], { t: 'dev', op: 'autoReveal' }).ok, true);
    const e = x.log.find((l) => l.id > xfrom);
    assert.deepEqual([e.key, e.params], ['log.dev.autoReveal', { a: { p: xids[1], n: 'Bob' }, rp: { r: 1, ot: false } }]);
    assert.equal(e.text, D.log.autoReveal('Bob', 'Round 1'));
    const ruLine = x.view(xids[0], 'ru').log.find((l) => l.id === e.id).text;
    assert.equal(ruLine, renderText('ru', 'log.dev.autoReveal', e.params));
    assert.notEqual(ruLine, e.text);
    const bad = ops.run(x, xids[1], { t: 'dev', op: 'autoReveal' });
    assert.deepEqual([bad.ok, bad.code, bad.key, bad.message], [false, 'wrong_phase', 'err.dev.notReveal', D.errors.notReveal]);
    // a line written as ready English text (a caller outside the catalogue) is kept as log.dev.text, the same in every language
    x._log('info', line);
    const legacy = x.log[x.log.length - 1];
    assert.deepEqual([legacy.key, legacy.params, legacy.text], [X5.LEGACY_LOG_KEY, { text: line }, line]);
    assert.equal(T(X5.LEGACY_LOG_KEY, legacy.params), line);
    assert.equal(renderText('ru', legacy.key, legacy.params), line);
    assert.equal(x.view(xids[0], 'ru').log.find((l) => l.id === legacy.id).text, line);
  });
});

test('i18n A1: every key was compared with a string of the pre-X5 code at least once', () => {
  const missing = KEYS.filter((k) => !covered.has(k));
  assert.deepEqual(missing, [], `keys never compared with the pre-X5 code: ${missing.join(', ')}`);
  const unexpected = warnings.filter((w) => !/^no ru text for /.test(w) && w !== 'unknown message key no.such.key');
  assert.deepEqual(unexpected, []);
});

// ------------------------------------------------------------------------------------------------ part 2: lockstep
// Report §11.3 (A2): the X5 engine (server/game.js with the real content, whose dealer the engine now drives through
// its token twins) and the frozen pre-X5 engine (test/fixtures/pre-x5/game.js with its own content.js) in lockstep
// under one seeded random driver: reveals, specials (a dealer wrapper deals the catalogue's random pool in order, so
// every special is dealt and played; the §11 X1 fixed deal is on), votes, ties, defenses, leaves, kicks, takeSeat,
// transferHost, a host going offline, Play again and End game at random moments, plus random invalid actions from any
// member. After every step every recipient's view must be equal once the X5.2 additions are removed (you.lang,
// catastrophe.id, the special ids, the log's key/params/parts), and every result equal ({ok, code, message}). The X5
// members get random languages: a view in English must not depend on them. The run asserts that every log.*, res.* and
// engine err.* key was produced, apart from a listed few that cannot be reached.
import { createDealer as newDealer, renderCard, renderSpecial, renderCatastrophe, renderBunker } from '../server/content.js';
import { createDealer as oldDealer } from './fixtures/pre-x5/content.js';
import { allowedCategories, playableSpecials } from '../tools/botlib.js';

/** The random pool in deal order (the first cycle of a dealer deals each special once). */
function specialPool(createDealer) {
  const d = createDealer(mulberry32(1));
  const seen = new Map();
  for (let i = 0; i < 400; i++) {
    const c = d.drawSpecial();
    if (c && !seen.has(c.id)) seen.set(c.id, c);
  }
  return [...seen.values()];
}
const OLD_POOL = specialPool(oldDealer);
const NEW_POOL = specialPool(newDealer);

/** The real dealer with drawSpecial dealing `pool` in order from `offset` (prototype delegation keeps the Tok twins). */
function poolDealer(real, pool, offset) {
  const d = Object.create(real);
  let i = offset;
  d.drawSpecial = () => ({ ...pool[i++ % pool.length] });
  return d;
}

/** A fast deep equality (no key order); assert.deepStrictEqual gives the diff when it fails. */
function eq(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const arr = Array.isArray(a);
  if (arr !== Array.isArray(b)) return false;
  if (arr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !eq(a[k], b[k])) return false;
  return true;
}

/** An X5 view without its X5.2 additions (the view is fresh apart from the shared log, which is compared separately). */
function stripX5(v) {
  if (!v) return v;
  const { log, ...rest } = v; // eslint-disable-line no-unused-vars
  delete rest.you.lang;
  if (rest.catastrophe) delete rest.catastrophe.id;
  for (const p of rest.players) {
    for (const s of p.playedSpecials) delete s.id;
    if (p.unplayedSpecials) for (const s of p.unplayedSpecials) delete s.id;
  }
  if (rest.me) for (const s of rest.me.specials) delete s.id;
  return rest;
}
function withoutLog(v) {
  if (!v) return v;
  const { log, ...rest } = v; // eslint-disable-line no-unused-vars
  return rest;
}

const res3 = (r) => (r && typeof r === 'object' ? { ok: r.ok, code: r.code, message: r.message, internal: r.internal, id: r.id, role: r.role } : r);

/**
 * The X5 engine's twins render to its own English fields (design §3.1): every card's token to its text, every special's
 * ref to its words, the catastrophe and bunker tokens to the English objects, and the note and timer keys to their
 * texts. With the English fields equal to the pre-X5 engine's (compared above), every other language renders the same
 * cards, not merely the same shapes.
 */
function twinsMatch(g, where) {
  for (const p of g.players) {
    if (p.cards) {
      for (const c of old.CATEGORY_IDS) {
        const card = p.cards[c];
        assert.ok(card.tok && Object.isFrozen(card.tok), `${where()}: ${p.id}.${c} has no frozen token`);
        if (renderCard('en', card.tok) !== card.text) assert.equal(renderCard('en', card.tok), card.text, `${where()}: ${p.id}.${c}'s token`);
      }
    }
    for (const s of [...p.specials, ...p.playedSpecials]) {
      if (!s.ref) continue;
      const w = renderSpecial('en', s.ref);
      if (!w || w.title !== s.title || w.text !== s.text) assert.deepEqual(w, { title: s.title, text: s.text }, `${where()}: ${p.id}'s special ${s.ref}`);
    }
    for (const n of p.notes) if (renderText('en', n.key, n.params) !== n.text) assert.equal(renderText('en', n.key, n.params), n.text, `${where()}: a note`);
  }
  if (g.timer && renderText('en', g.timer.key, g.timer.params) !== g.timer.label) assert.equal(renderText('en', g.timer.key, g.timer.params), g.timer.label, `${where()}: the timer`);
  if (g.catastrophe) {
    const c = renderCatastrophe('en', g.catastropheTok);
    if (!eq([c.title, c.text, [...c.details]], [g.catastrophe.title, g.catastrophe.text, g.catastrophe.details])) assert.deepEqual(c, g.catastrophe, `${where()}: the catastrophe token`);
  }
  if (g.bunker) {
    const b = renderBunker('en', g.bunkerTok);
    if (!eq({ ...b, features: [...b.features] }, g.bunker)) assert.deepEqual({ ...b, features: [...b.features] }, g.bunker, `${where()}: the bunker token`);
  }
}

/** The keys the X5 engine produced: log lines and everything nested in them, notes, timers and failures. */
function collectKeys(set, params) {
  if (!params || typeof params !== 'object') return;
  for (const v of Array.isArray(params) ? params : Object.values(params)) {
    if (v && typeof v === 'object') {
      if (v.msg && typeof v.msg === 'object') { set.add(v.msg.key); collectKeys(set, v.msg.params); } else collectKeys(set, v);
    }
  }
}

/**
 * A pair of engines in lockstep: the pre-X5 one (A) and the X5 one (B), built alike. `both(fn)` applies fn to each,
 * compares the results and then every view. `dealer`: 'pool' (the real content, the pool dealt in order) or 'hand'
 * (part 1's hand-made deal, literal cards).
 */
function makePair({ seed, dealerKind = 'pool', fixedSpecials = true, minPlayers = 4, stats, R }) {
  const clock = { t: 1_800_000_000_000 + seed };
  const now = () => clock.t;
  const rngA = mulberry32(1000 + seed);
  const rngB = mulberry32(1000 + seed);
  const offset = (seed * 11) % OLD_POOL.length;
  const dealers = dealerKind === 'pool'
    ? [poolDealer(oldDealer(rngA), OLD_POOL, offset), poolDealer(newDealer(rngB), NEW_POOL, offset)]
    : [dealer(), dealer()];
  const A = new old.Game({ room: 'GOLD', rng: rngA, now, minPlayers, dealer: dealers[0], fixedSpecials });
  const B = new X5.Game({ room: 'GOLD', rng: rngB, now, minPlayers, dealer: dealers[1], fixedSpecials });
  const ctx = { A, B, clock, steps: 0, loggedTo: 0, label: `seed ${seed}` };
  ctx.where = () => `${ctx.label} step ${ctx.steps} ${A.phase} r${A.round}${A.overtime ? ' OT' : ''}`;
  ctx.compareAll = () => {
    // the internal logs: the same lines (id, ts, kind, text); the X5 one also records the keys it used
    assert.equal(B.logSeq, A.logSeq, `${ctx.where()}: log length`);
    for (const e of B.log) {
      if (e.id <= ctx.loggedTo) continue;
      const a = A.log.find((x) => x.id === e.id);
      assert.ok(a, `${ctx.where()}: log #${e.id} only in X5`);
      if (a.kind !== e.kind || a.text !== e.text || a.ts !== e.ts) assert.deepEqual([e.kind, e.text], [a.kind, a.text], `${ctx.where()}: log #${e.id}`);
      stats.keys.add(e.key);
      collectKeys(stats.keys, e.params);
    }
    ctx.loggedTo = B.logSeq;
    const ids = [...A.players.map((p) => p.id), ...A.spectators.map((x) => x.id), 'p999'];
    for (const id of ids) {
      const a = A.view(id);
      const b = B.view(id, 'en');
      stats.views++;
      if (!a || !b) { assert.equal(b, a, `${ctx.where()}: view of ${id} null in one engine only`); continue; }
      const sa = withoutLog(a);
      const sb = stripX5(b);
      if (!eq(sa, sb)) assert.deepStrictEqual(sb, sa, `${ctx.where()}: view of ${id}`);
      if (a.log.length !== b.log.length || (a.log.length && (a.log[0].id !== b.log[0].id || a.log.at(-1).text !== b.log.at(-1).text))) {
        assert.deepEqual(b.log.map((e) => [e.id, e.text]), a.log.map((e) => [e.id, e.text]), `${ctx.where()}: log of ${id}`);
      }
    }
    for (const p of B.players) for (const n of p.notes) stats.keys.add(n.key);
    if (B.timer && B.timer.key) stats.keys.add(B.timer.key);
    twinsMatch(B, ctx.where);
  };
  /** fn(engine) on both; the results must agree ({ok, code, message}, and a join's id and role). */
  ctx.both = (fn, what) => {
    ctx.steps++;
    ctx.clock.t += 1 + Math.floor((R ? R() : 0.5) * 3000);
    const a = fn(A);
    const b = fn(B);
    if (!eq(res3(a), res3(b))) assert.deepEqual(res3(b), res3(a), `${ctx.where()}: ${what}`);
    if (b && b.ok === false) {
      assert.ok(b.key, `${ctx.where()}: ${what}: a failure without a key`);
      stats.keys.add(b.key);
      assert.equal(renderText('en', b.key, b.params), b.message);
    }
    ctx.compareAll();
    return b;
  };
  ctx.act = (id, msg) => ctx.both((g) => g.handle(id, msg), `${id} ${JSON.stringify(msg)}`);
  /** The same change to both engines' state (a scripted situation), then every view compared. */
  ctx.set = (fn, what = 'set') => ctx.both((g) => { fn(g); return { ok: true }; }, what);
  /** Joins to both engines; the X5 member in `lang`. */
  ctx.join = (name, { spectator = false, lang = 'en' } = {}) => ctx.both((g) => (g === B ? g.join(name, { spectator, lang }) : g.join(name, { spectator })), `join ${name}`);
  return ctx;
}

function lockstepTable(tableNo, stats) {
  const R = mulberry32(0x5eed + tableNo * 7919);
  const r = () => R();
  const pickR = (arr) => arr[Math.floor(r() * arr.length)];
  const N = [4, 6, 9, 12, 16][tableNo % 5];
  const spectators = tableNo % 6;
  const gamesWanted = 3;
  const P2 = makePair({ seed: tableNo, stats, R });
  P2.label = `table ${tableNo} (N=${N})`;
  const { A, act, both } = P2;

  // the table: N players (the first hosts), then spectators; the X5 members in random languages. On the way, the
  // lobby errors of a table too small to start.
  for (let i = 0; i < N + spectators; i++) {
    P2.join(NAMES[i % NAMES.length], { spectator: i >= N, lang: r() < 0.5 ? 'ru' : 'en' });
    if (i === 1) {
      act('p1', { t: 'start' });
      act('p1', { t: 'next' });
      act('p1', { t: 'endGame' });
      act('p2', { t: 'endTurn' });
    }
  }
  let games = 0;
  let guard = 0;
  let lastPhase = 'lobby';
  while (games < gamesWanted && guard++ < 5000) {
    if (A.phase !== lastPhase) {
      if (lastPhase !== 'lobby' && (A.phase === 'lobby' || A.phase === 'final')) games++;
      lastPhase = A.phase;
      if (games >= gamesWanted) break;
    }
    const host = A.hostId;
    const x = r();
    // random invalid (or accidentally valid) actions from anyone, now and then
    if (x < 0.12) { fuzz(); continue; }
    // spectators come and go, in the lobby and in a game
    if (x < 0.125 && A.spectators.length) { act(pickR(A.spectators).id, { t: 'leave' }); continue; }
    if (x < 0.13 && A.spectators.length) { act(host, { t: 'kick', playerId: pickR(A.spectators).id }); continue; }
    if (x < 0.135 && A.spectators.length < 6) { P2.join(`Guest${P2.steps}`, { spectator: true, lang: r() < 0.5 ? 'ru' : 'en' }); continue; }
    if (A.phase === 'lobby') {
      if (x < 0.2 && A.spectators.length && A.players.length < 16) { act(A.spectators[0].id, { t: 'takeSeat' }); continue; }
      if (x < 0.25 && A.players.length > 5) { act(host, { t: 'transferHost', playerId: pickR(A.players.filter((p) => p.id !== host)).id }); continue; }
      if (x < 0.27 && A.players.length > 5) { act(pickR(A.players.filter((p) => p.id !== host)).id, { t: 'leave' }); continue; }
      if (x < 0.29 && A.players.length < 16) { P2.join(`New${P2.steps}`, { lang: r() < 0.5 ? 'ru' : 'en' }); continue; }
      if (A.players.length < 4) { P2.join(`Fill${P2.steps}`); continue; }
      act(host, { t: 'start' });
      continue;
    }
    if (A.phase === 'final') {
      act(host, { t: r() < 0.3 ? 'endGame' : 'playAgain' });
      continue;
    }
    // chaos, rarely
    if (x < 0.14) { act(host, { t: 'endGame' }); stats.endGame++; continue; }
    if (x < 0.145 && A._aliveCount() > 3) { act(pickR(A._alive().filter((p) => p.id !== host)).id, { t: 'leave' }); continue; }
    if (x < 0.15 && A._aliveCount() > 3) { act(host, { t: 'kick', playerId: pickR(A._alive().filter((p) => p.id !== host)).id }); continue; }
    if (x < 0.155) {
      const to = A.players.filter((p) => p.status !== 'left' && p.id !== host);
      if (to.length) { act(host, { t: 'transferHost', playerId: pickR(to).id }); continue; }
    }
    if (x < 0.16) {
      // the host goes offline and the grace period passes the role on (§6); they come back later
      P2.set((g) => g.setConnected(host, false), 'host offline');
      P2.clock.t += 60_000;
      both((g) => ({ ok: g.passHost(), code: String(g.hostOfflineMs()) }), 'passHost');
      P2.set((g) => g.setConnected(host, true), 'host back');
      continue;
    }
    // a special from a random player who can play one
    if (x < 0.42) {
      const pid = pickR(A._alive().map((p) => p.id));
      const v = A.view(pid);
      const options = v ? playableSpecials(v) : [];
      if (options.length) {
        const o = pickR(options);
        const waiting = o.special.effect === 'airlock' ? (v.airlocks || []).filter((al) => !al.byIds.includes(pid) && o.targets.includes(al.targetId)).map((al) => al.targetId) : [];
        const targetId = waiting.length && r() < 0.85 ? pickR(waiting) : pickR(o.targets);
        const category = pickR(allowedCategories(v, o.special, targetId));
        const msg = { t: 'special', uid: o.special.uid };
        if (targetId) msg.targetId = targetId;
        if (category) msg.category = category;
        stats.effects[o.special.effect] = (stats.effects[o.special.effect] || 0) + 1;
        act(pid, msg);
        continue;
      }
    }
    // the natural move of the phase
    if (A.phase === 'reveal') {
      const sp = A._speakerId();
      const p = A._player(sp);
      if (!A.turn.hasRevealed && A._eligible(p).length && r() < 0.85) act(sp, { t: 'reveal', category: A._mustReveal() || pickR(A._eligible(p)) });
      else if (r() < 0.8) act(sp, { t: 'endTurn' });
      else act(host, { t: 'next' });
    } else if (A.phase === 'defense') {
      act(r() < 0.7 ? A._speakerId() : host, { t: r() < 0.7 ? 'endTurn' : 'next' });
    } else if (A.phase === 'discussion') {
      act(host, { t: 'next' });
    } else if (A.phase === 'vote') {
      const todo = A.vote.voters.filter((vid) => !A.vote.votes.has(vid));
      if (todo.length && r() < 0.93) {
        const vid = pickR(todo);
        // few candidates, so ties and revotes happen
        const c = A.vote.candidates.filter((id) => id !== vid);
        act(vid, { t: 'vote', targetId: c[Math.floor(r() * Math.min(c.length, 3))] });
      } else act(host, { t: 'closeVote' });
    }
  }
  stats.games += games;
  stats.steps += P2.steps;
  assert.ok(games >= gamesWanted, `table ${tableNo}: only ${games} games in ${P2.steps} steps`);

  /** A random action, mostly invalid, from any member (or nobody), with plausible and implausible fields. */
  function fuzz() {
    const all = [...A.players.map((p) => p.id), ...A.spectators.map((x) => x.id), 'p999'];
    let who = pickR(all);
    const anyId = () => pickR(all);
    const cat = () => pickR([...old.CATEGORY_IDS, 'nope']);
    const cards = A.players.flatMap((p) => p.specials.map((c) => ({ p: p.id, c })));
    // a card and, most of the time, its own holder, so the deeper checks of §5 are reached
    const ownCard = () => {
      if (!cards.length) return 'nope';
      const x = pickR(cards);
      if (r() < 0.8) who = x.p;
      return x.c.uid;
    };
    const k = Math.floor(r() * 24);
    let msg;
    switch (k) {
      case 0: msg = null; break;
      case 1: msg = ['x']; break;
      case 2: msg = { t: 'nope' }; break;
      case 3: msg = { t: 'kick' }; break;
      case 4: msg = { t: 'kick', playerId: 5 }; break;
      // setLang is new in X5 (the pre-X5 engine does not know it): the protocol test covers it
      case 5: msg = { t: pickR(['ping', 'create', 'join', 'resume']) }; break;
      case 6: msg = { t: 'setOptions', options: { [pickR(['speechSeconds1', 'speechSeconds', 'discussionSeconds', 'defenseSeconds'])]: pickR([3, 30, 601, 1.5, 60]) } }; break;
      case 7: if (A.turn && r() < 0.7) who = A._speakerId(); msg = { t: 'reveal', category: cat() }; break;
      case 8: msg = { t: 'reveal', category: cat(), at: { round: 99 } }; break;
      case 9: if (A.turn && r() < 0.5) who = A._speakerId(); msg = { t: 'endTurn' }; break;
      case 10: msg = { t: 'next', at: { phase: 'vote', ballot: 7 } }; break;
      case 11: msg = { t: 'vote', targetId: anyId() }; break;
      case 12: msg = { t: 'closeVote' }; break;
      case 13: { const uid = ownCard(); msg = { t: 'special', uid, targetId: anyId(), ...(r() < 0.6 ? { category: cat() } : {}) }; break; }
      case 14: msg = { t: 'special', uid: ownCard() }; break;
      case 15: msg = { t: 'kick', playerId: r() < 0.3 ? A.hostId : 'p999' }; break;
      case 16: msg = { t: 'transferHost', playerId: anyId() }; break;
      case 17: msg = { t: 'takeSeat' }; break;
      case 18: msg = { t: 'start' }; break;
      case 19: msg = { t: 'playAgain' }; break;
      case 20: msg = { t: 'endGame' }; break;
      case 21: msg = { t: 'setOptions', options: {} }; break;
      case 22: { const uid = ownCard(); msg = { t: 'special', uid, targetId: anyId() }; break; }
      default: {
        const name = r() < 0.5 ? '   ' : `Late${P2.steps}`;
        const spectator = r() < 0.5;
        both((g) => g.join(name, { spectator }), 'fuzz join');
        return;
      }
    }
    // a kick, leave or transfer that happens to be valid is fine: both engines must still agree
    act(who, msg);
  }
}

/**
 * Scripted situations the random driver rarely reaches, played in lockstep on a hand-made deal (as in part 1): every
 * one immune, no more ejections due, nobody left to vote out, Cancel vote after an ejection, the extra bed in a step,
 * the minimum bed count, the retired eject, the own-airlock guard, a full room, an engine exception.
 */
function lockstepScripts(stats) {
  const card = (id, effect, extra = {}) => ({ id, title: `T ${id}`, text: `Text of ${id}.`, effect, target: old.EFFECTS[effect].targets[0], ...extra });
  const give = (P, id, def) => {
    let uid = null;
    P.set((g) => {
      const c = g._issueSpecial((g === P.A ? old.normalizeSpecial : X5.normalizeSpecial)(def));
      g._player(id).specials.push(c);
      g._player(id).lastSpecialRound = 0;
      uid = c.uid;
    }, `give ${def.id}`);
    return uid;
  };
  const table = (n, seed, extra = {}) => {
    const P = makePair({ seed: 500 + seed, dealerKind: 'hand', fixedSpecials: false, minPlayers: 2, stats, ...extra });
    P.label = `script ${seed}`;
    for (let i = 0; i < n; i++) P.join(NAMES[i], { lang: i % 2 ? 'ru' : 'en' });
    P.act('p1', { t: 'start' });
    return P;
  };
  const toRound = (P, r) => { for (let i = 0; i < 400 && !(P.A.round === r && P.A.phase === 'reveal'); i++) P.act(P.A.hostId, P.A.phase === 'vote' ? { t: 'closeVote' } : { t: 'next' }); };
  const finishReveal = (P) => { for (let i = 0; i < 64 && P.A.phase === 'reveal'; i++) P.act(P.A.hostId, { t: 'next' }); };
  const ids = (P) => P.A.players.map((p) => p.id);

  { // everyone immune: the rest of the vote is cancelled
    const P = table(6, 1);
    P.set((g) => { g.kicks = [0, 1, 0, 0, 0, 0, 0]; });
    toRound(P, 2);
    finishReveal(P);
    P.set((g) => { for (const p of g._alive()) g.voteMods.immune.add(p.id); });
    P.act(P.A.hostId, { t: 'next' });
  }
  { // an ejection, then no more ejections due in this vote
    const P = table(8, 2);
    P.set((g) => { g.kicks = [0, 2, 0, 0, 0, 0, 0]; });
    toRound(P, 2);
    finishReveal(P);
    P.act(P.A.hostId, { t: 'next' });
    const [, b, c] = ids(P);
    P.act(b, { t: 'vote', targetId: c });
    P.set((g) => { g.kicks = [0, 0, 0, 0, 0, 0, 0]; });
    P.act(P.A.hostId, { t: 'closeVote' });
  }
  { // a tie whose tied players both leave during the defense: nobody left to vote out
    const P = table(10, 3);
    const [a, , , d, e] = ids(P);
    P.set((g) => { g.kicks = [0, 1, 0, 0, 0, 0, 0]; });
    toRound(P, 2);
    finishReveal(P);
    P.act(P.A.hostId, { t: 'next' });
    P.set((g) => {
      g.vote.votes.clear();
      g.vote.voters.filter((v) => v !== d && v !== e).forEach((v, i) => g.vote.votes.set(v, i % 2 ? d : e));
      g.vote.votes.set(d, e);
      g.vote.votes.set(e, d);
      g._closeBallot();
    }, 'a forced tie');
    assert.equal(P.A.phase, 'defense');
    P.act(d, { t: 'leave' });
    P.act(e, { t: 'leave' });
    void a;
  }
  { // two ballots: Cancel vote after the first ejected someone; the extra bed during a step; the minimum bed count
    const P = table(8, 4);
    const [a, b, c, d] = ids(P);
    P.set((g) => { g.kicks = [0, 4, 0, 0, 0, 0, 0]; }); // 4 due for 4 beds: the extra bed takes one off
    toRound(P, 2);
    finishReveal(P);
    P.act(P.A.hostId, { t: 'next' });
    P.act(a, { t: 'special', uid: give(P, a, card('plus', 'capacity_plus')) });
    P.act(b, { t: 'vote', targetId: c });
    P.act(P.A.hostId, { t: 'closeVote' });
    P.act(d, { t: 'special', uid: give(P, d, card('cancel', 'cancel_vote')) });
    for (let i = 0; i < 6; i++) P.act(d, { t: 'special', uid: give(P, d, card(`minus${i}`, 'capacity_minus')) });
  }
  { // the retired one-player eject (content never deals it), and the own-airlock guard
    const P = table(6, 5);
    const [a, b, c] = ids(P);
    toRound(P, 2);
    P.act(a, { t: 'special', uid: give(P, a, card('eject', 'eject')), targetId: c });
    P.act(b, { t: 'special', uid: give(P, b, AIRLOCK_CARD), targetId: ids(P)[4] });
    P.act(b, { t: 'special', uid: give(P, b, AIRLOCK_CARD), targetId: ids(P)[4] });
  }
  { // the errors of the lobby, the final and §5 that random play seldom meets
    const P = makePair({ seed: 507, dealerKind: 'hand', fixedSpecials: false, minPlayers: 2, stats });
    P.label = 'script 7';
    for (let i = 0; i < 6; i++) P.join(NAMES[i]);
    const [a, b, c, d, e] = ids(P);
    P.act(b, { t: 'takeSeat' }); // already seated
    P.act(a, { t: 'kick', playerId: a }); // the host kicks themself
    P.act(a, { t: 'start' });
    toRound(P, 2);
    const cn = give(P, a, card('cancel', 'cancel_vote'));
    P.set((g) => { g.voteMods.cancelNext = true; });
    P.act(a, { t: 'special', uid: cn }); // already cancelled
    P.set((g) => { g.voteMods.cancelNext = false; g.voteMods.blocked.add(b); });
    P.act(b, { t: 'special', uid: give(P, b, card('double', 'double_vote')) }); // blocked in the next vote
    P.set((g) => { g.voteMods.blocked.delete(b); for (const cat of old.CATEGORY_IDS) g._player(c).cards[cat].revealed = true; });
    const force = give(P, d, card('force', 'force_reveal', { category: 'choose' }));
    P.act(d, { t: 'special', uid: force, targetId: c, category: 'health' }); // no hidden cards left
    P.act(d, { t: 'special', uid: force, targetId: e, category: 'profession' }); // that card is not hidden
    finishReveal(P);
    P.set((g) => { g.kicks = [0, 1, 0, 0, 0, 0, 0]; g.voteMods.blocked.add(e); });
    P.act(P.A.hostId, { t: 'next' });
    assert.equal(P.A.phase, 'vote');
    P.act(e, { t: 'special', uid: give(P, e, card('double2', 'double_vote')) }); // blocked in this vote
    P.set((g) => { g.voteMods.blocked.delete(e); g.vote.voters = g.vote.voters.filter((v) => v !== b); });
    P.act(b, { t: 'special', uid: give(P, b, card('double3', 'double_vote')) }); // not a voter in this ballot
    P.set((g) => g._enterFinal(), 'to the final');
    P.act(P.A.hostId, { t: 'next' }); // use Play again
  }
  { // a full room (50 spectators), and an engine exception in join and in handle
    const P = makePair({ seed: 506, dealerKind: 'hand', fixedSpecials: false, minPlayers: 2, stats });
    P.label = 'script 6';
    for (let i = 0; i < 16 + 50; i++) P.both((g) => g.join(`S${i}`, { spectator: i >= 16 }), `join ${i}`);
    P.both((g) => g.join('One more', { spectator: true }), 'the 51st spectator');
    P.set((g) => { g._uniqueName = () => { throw new Error('boom'); }; });
    P.both((g) => g.join('Crash'), 'join throws');
    P.set((g) => { g._leave = () => { throw new Error('boom'); }; });
    P.act('p2', { t: 'leave' });
  }
}

describe('i18n A2: the X5 engine in lockstep with the pre-X5 engine (English views, results and errors)', () => {
  test('the special pools are the same cards in the same order', () => {
    assert.deepEqual(NEW_POOL, OLD_POOL);
    assert.ok(NEW_POOL.length >= 50);
  });

  test('80 tables x 3 games (N 4..16, 0-5 spectators, random languages): every step equal', () => {
    const stats = { games: 0, steps: 0, views: 0, endGame: 0, effects: {}, keys: new Set() };
    for (let t = 0; t < 80; t++) lockstepTable(t, stats);
    assert.ok(stats.games >= 200, `${stats.games} games`);
    lockstepScripts(stats);
    // every special effect of the random pool and the fixed deal was played
    for (const e of Object.keys(old.EFFECTS).filter((x) => x !== 'eject')) assert.ok(stats.effects[e] > 0, `effect ${e} never played`);
    // key coverage: every log line, result and engine error, apart from the ones the driver cannot reach
    const unreachable = new Set();
    // rooms.js keys and the per-code defaults the engine never uses (it always names a specific key for those codes)
    const notEngine = ['err.no_room', 'err.bad_token', 'err.server_busy', 'err.replaced', 'err.bad_request', 'err.wrong_phase', 'err.not_allowed',
      'err.lookupThrottled', 'err.noRoomJoin', 'err.noRoomResume', 'err.replacedTab', 'err.tooManyRooms', 'err.jsonFrame', 'err.malformedJson',
      'err.generic', 'err.devOff'];
    const engineErr = KEYS.filter((k) => k.startsWith('err.') && !isDevKey(k) && !notEngine.includes(k));
    const want = KEYS.filter((k) => (k.startsWith('log.') && !isDevKey(k)) || k.startsWith('res.')).concat(engineErr, ['note.peek', 'timer.turn', 'timer.defense', 'timer.discussion', 'timer.otDiscussion', 'why.gone', 'why.bed', 'mods.used', 'mod.immune', 'mod.blocked', 'mod.double', 'host.offline', 'host.handover']);
    const missing = want.filter((k) => !stats.keys.has(k) && !unreachable.has(k));
    console.log(`# lockstep: ${JSON.stringify({ games: stats.games, steps: stats.steps, views: stats.views, endGame: stats.endGame, effects: stats.effects })}`);
    assert.deepEqual(missing, [], `never produced: ${missing.join(', ')}`);
  });
});
