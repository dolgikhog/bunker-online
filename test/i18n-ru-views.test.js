// SPEC §11 X5.2, X5.6, X5.8; reports/i18n-design.md §11.3, §13 item 3 — the engine's Russian views (i18n-server, A2).
// Seeded games with the real content and Cyrillic player names, every member viewed in ru and in en after every step:
//   - every human-readable string of a ru view (log text and parts, cards, specials, catastrophe, bunker, labels, timer,
//     notes) has no Latin letter beyond the allowlist (°C, 3D, USB) — asserted once every Russian catalogue says
//     COMPLETE (until then the gaps are reported, not failed: a missing translation falls back to English by design);
//   - the parts invariant (the §7 schema, parts included) holds in both languages;
//   - an en view and a ru view of the same member at the same moment are structurally identical: the same neutral
//     projection (every word as '*'), the same log keys and wire params, and per log entry the same multiset of
//     {t, id} over the non-string parts;
//   - a cross-language leak scan: every hidden card, rendered in both languages, is searched in every other recipient's
//     view, in both languages (text, parts and params of the log, and the public cards);
//   - the engine's fallbacks (a dealer that throws for the catastrophe, the bunker, a feature and a special) render in ru.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, CATEGORY_IDS } from '../server/game.js';
import { mulberry32 } from '../server/rng.js';
import { COMPLETE as CONTENT_COMPLETE } from '../server/content/render.js';
import * as ruMessages from '../server/i18n/ru.js';
import { renderCard, renderSpecial } from '../server/content.js';
import { allowedCategories, playableSpecials } from '../tools/botlib.js';
import { validateLogEntry, validateStateView } from './stateview-schema.js';
import { neutralPublic } from './helpers-sim.js';

const RU_COMPLETE = ruMessages.COMPLETE === true && Object.values(CONTENT_COMPLETE.ru).every(Boolean);
const NAMES = ['Анна', 'Борис', 'Вера', 'Глеб', 'Дарья', 'Егор', 'Жанна', 'Зоя', 'Иван', 'Кира', 'Лев', 'Мила', 'Нина', 'Остап', 'Пётр', 'Рита',
  'Соня', 'Тимур', 'Ульяна', 'Фёдор', 'Юля', 'Яков'];
const ALLOWED = /°C|3D|USB/g;
const LATIN = /[A-Za-z]/;

/** Every human-readable string of a view, with where it is. */
function words(v) {
  const out = [];
  const add = (where, s) => { if (typeof s === 'string') out.push([where, s]); };
  for (const c of v.categories) add('categories.label', c.label);
  if (v.catastrophe) { add('catastrophe.title', v.catastrophe.title); add('catastrophe.text', v.catastrophe.text); v.catastrophe.details.forEach((d) => add('catastrophe.details', d)); }
  if (v.bunker) { for (const k of ['name', 'size', 'duration', 'food']) add(`bunker.${k}`, v.bunker[k]); v.bunker.features.forEach((f) => add('bunker.features', f)); }
  for (const p of v.players) {
    for (const c of CATEGORY_IDS) add(`cards.${c}`, p.cards[c]);
    for (const s of [...p.playedSpecials, ...(p.unplayedSpecials || [])]) { add('special.title', s.title); add('special.text', s.text); }
  }
  if (v.me) {
    for (const c of CATEGORY_IDS) add(`me.cards.${c}`, v.me.cards[c].text);
    for (const s of v.me.specials) { add('me.special.title', s.title); add('me.special.text', s.text); }
    for (const n of v.me.notes) add('me.notes', n.text);
  }
  if (v.timer) add('timer.label', v.timer.label);
  for (const e of v.log) {
    add(`log ${e.key}`, e.text);
    for (const x of e.parts) if (typeof x !== 'string' && x.t === 'card') { add(`log ${e.key} card.title`, x.title); add(`log ${e.key} card.text`, x.text); add(`log ${e.key} card.label`, x.label); }
  }
  return out;
}

/** The view with every word as '*': equal for en and ru (you.lang aside). */
function neutralView(v) {
  const { log, you, me, serverNow, ...pub } = v; // eslint-disable-line no-unused-vars
  const star = (s) => (typeof s === 'string' ? '*' : s);
  return {
    pub: neutralPublic(pub),
    you: { ...you, lang: '*' },
    me: me && {
      ...me,
      cards: Object.fromEntries(Object.entries(me.cards).map(([k, c]) => [k, { ...c, text: star(c.text) }])),
      specials: me.specials.map((s) => ({ ...s, title: star(s.title), text: star(s.text) })),
      notes: me.notes.map((n) => ({ ...n, text: star(n.text) })),
    },
    log: log.map((e) => ({
      id: e.id, ts: e.ts, kind: e.kind, key: e.key, params: e.params,
      refs: e.parts.filter((x) => typeof x !== 'string').map((x) => `${x.t}:${x.id ?? ''}`).sort(),
    })),
  };
}

/** A small random driver (real content, the §11 X1 fixed deal, specials, leaves, End game, Play again). */
function play(seed, n, spectators, onStep) {
  const R = mulberry32(seed * 131 + 7);
  const r = () => R();
  const pick = (a) => a[Math.floor(r() * a.length)];
  let t = 1_800_000_000_000;
  const g = createGame({ room: 'RUSS', rng: mulberry32(seed), now: () => (t += 700), minPlayers: 4 });
  for (let i = 0; i < n + spectators; i++) g.join(NAMES[i % NAMES.length], { spectator: i >= n, lang: r() < 0.5 ? 'ru' : 'en' });
  let games = 0;
  let last = 'lobby';
  // big tables play on until the log is full and has scrolled (the per-language log cache must follow it)
  for (let step = 0; step < 6000 && (games < 2 || (n >= 12 && g.logSeq < 240)); step++) {
    if (g.phase !== last) { if (last !== 'lobby' && (g.phase === 'final' || g.phase === 'lobby')) games++; last = g.phase; }
    const host = g.hostId;
    const x = r();
    if (g.phase === 'lobby') g.handle(host, { t: 'start' });
    else if (g.phase === 'final') g.handle(host, { t: 'playAgain' });
    else if (x < 0.005) g.handle(host, { t: 'endGame' });
    else if (x < 0.01 && g._aliveCount() > 4) g.handle(pick(g._alive().filter((p) => p.id !== host)).id, { t: 'leave' });
    else if (x < 0.35 && tryspecial()) { /* played */ } else if (g.phase === 'reveal') {
      const sp = g._speakerId();
      const p = g._player(sp);
      if (!g.turn.hasRevealed && g._eligible(p).length) g.handle(sp, { t: 'reveal', category: g._mustReveal() || pick(g._eligible(p)) });
      else g.handle(sp, { t: 'endTurn' });
    } else if (g.phase === 'defense') g.handle(g._speakerId(), { t: 'endTurn' });
    else if (g.phase === 'discussion') g.handle(host, { t: 'next' });
    else if (g.phase === 'vote') {
      const todo = g.vote.voters.filter((v) => !g.vote.votes.has(v));
      if (todo.length) { const v = pick(todo); g.handle(v, { t: 'vote', targetId: pick(g.vote.candidates.filter((c) => c !== v)) }); } else g.handle(host, { t: 'closeVote' });
    }
    onStep(g);
  }
  return g;

  function tryspecial() {
    const pid = pick(g._alive().map((p) => p.id));
    const v = g.view(pid, 'en');
    const opts = v ? playableSpecials(v) : [];
    if (!opts.length) return false;
    const o = pick(opts);
    const waiting = o.special.effect === 'airlock' ? v.airlocks.filter((a) => !a.byIds.includes(pid) && o.targets.includes(a.targetId)).map((a) => a.targetId) : [];
    const targetId = waiting.length && r() < 0.8 ? pick(waiting) : pick(o.targets);
    const category = pick(allowedCategories(v, o.special, targetId));
    const msg = { t: 'special', uid: o.special.uid };
    if (targetId) msg.targetId = targetId;
    if (category) msg.category = category;
    return g.handle(pid, msg).ok;
  }
}

describe('§11 X5 Russian views of the engine', () => {
  test('ru views: no Latin (once complete), the parts invariant, en and ru structurally identical, no leak in either language', () => {
    const latin = new Map(); // where -> an example
    const keys = new Set();
    let views = 0;
    let secrets = 0;
    const seen = new Map(); // member -> last log id checked for leaks
    for (const [seed, n, specs] of [[1, 5, 1], [2, 8, 2], [3, 12, 0], [4, 16, 3], [5, 6, 1], [6, 9, 2], [7, 4, 1], [8, 13, 2]]) {
      play(seed, n, specs, (g) => {
        const members = [...g.players.filter((p) => p.status !== 'left').map((p) => p.id), ...g.spectators.map((s) => s.id)];
        const byLang = { en: new Map(), ru: new Map() };
        for (const id of members) {
          const en = g.view(id, 'en');
          const ru = g.view(id, 'ru');
          views += 2;
          byLang.en.set(id, en);
          byLang.ru.set(id, ru);
          assert.deepEqual(validateStateView(en), [], `seed ${seed} ${id} en`);
          assert.deepEqual(validateStateView(ru), [], `seed ${seed} ${id} ru`);
          assert.equal(ru.you.lang, 'ru');
          // the log view is the engine's log now (the per-language cache follows every change, a full log too)
          assert.equal(ru.log.length, Math.min(g.log.length, 200));
          if (g.log.length) assert.deepEqual([ru.log.at(-1).id, en.log.at(-1).text], [g.log.at(-1).id, g.log.at(-1).text]);
          // wire params are language-neutral ids, numbers and flags: never a token (a card's identity) or a special's words
          for (const e of ru.log) assert.doesNotMatch(JSON.stringify(e.params), /"(lit|tok|feat|sp|mod|sex|note|nick|stay|title|text)":|"v":\[/, `${e.key} params`);
          // catalogue specials show the catalogue's Russian words, and every card its own token's Russian text
          const me = g._player(id);
          for (const [i, s] of (ru.me ? ru.me.specials : []).entries()) {
            const own = me.specials[i];
            if (own.ref) assert.deepEqual({ title: s.title, text: s.text }, { ...renderSpecial('ru', own.ref) }, `${id}'s ${own.ref}`);
          }
          for (const p of g.players) {
            const pv = ru.players.find((x) => x.id === p.id);
            p.playedSpecials.forEach((s, i) => { if (s.ref) assert.equal(pv.playedSpecials[i].title, renderSpecial('ru', s.ref).title); });
            if (p.cards) for (const c of CATEGORY_IDS) if (pv.cards[c] !== null) assert.equal(pv.cards[c], renderCard('ru', p.cards[c].tok), `${p.id}.${c} in ru`);
          }
          const ne = neutralView(en);
          const nr = neutralView(ru);
          assert.deepEqual(nr, ne, `seed ${seed}: the ru and en views of ${id} differ in structure`);
          for (const [where, s] of words(ru)) {
            if (LATIN.test(s.replace(ALLOWED, '')) && !latin.has(where)) latin.set(where, s);
          }
          for (const e of ru.log) keys.add(e.key);
        }
        // cross-language leaks: every hidden card, in both languages, against every other member's view in both
        const fresh = {};
        for (const L of ['en', 'ru']) {
          for (const [id, v] of byLang[L]) {
            const from = seen.get(`${L}:${id}`) ?? 0;
            const entries = v.log.filter((e) => e.id > from);
            seen.set(`${L}:${id}`, v.log.length ? v.log.at(-1).id : from);
            fresh[`${L}:${id}`] = entries.map((e) => `${e.text}\n${JSON.stringify(e.parts)}\n${JSON.stringify(e.params)}`).join('\n');
          }
        }
        if (g.phase === 'final' || g.phase === 'lobby') return;
        for (const p of g.players) {
          if (!p.cards || p.status === 'left') continue;
          for (const c of CATEGORY_IDS) {
            if (p.cards[c].revealed) continue;
            for (const L of ['en', 'ru']) {
              const secret = L === 'en' ? p.cards[c].text : renderCard('ru', p.cards[c].tok);
              if (secret.length < 6) continue;
              secrets++;
              for (const V of ['en', 'ru']) {
                for (const [id, v] of byLang[V]) {
                  if (id === p.id) continue;
                  const pub = v.players.find((x) => x.id === p.id);
                  assert.equal(pub.cards[c], null, `seed ${seed}: ${p.id}.${c} is hidden but public in ${id}'s ${V} view`);
                  const text = fresh[`${V}:${id}`];
                  if (!text || !text.includes(secret)) continue;
                  // the same words may be public elsewhere (another player's revealed card, the bunker, a catastrophe)
                  const open = JSON.stringify([v.players.map((x) => x.cards), v.bunker, v.catastrophe]);
                  if (open.includes(secret)) continue;
                  assert.fail(`seed ${seed}: the hidden ${p.id}.${c} (${L}) ${JSON.stringify(secret)} is in ${id}'s ${V} log`);
                }
              }
            }
          }
        }
      });
    }
    const report = [...latin].map(([where, s]) => `${where}: ${JSON.stringify(s)}`);
    console.log(`# ru views: ${views} views, ${keys.size} log keys, ${secrets} hidden-card checks; Latin in ${latin.size} place(s)${report.length ? `\n#   ${report.slice(0, 20).join('\n#   ')}` : ''}`);
    if (RU_COMPLETE) assert.deepEqual(report, [], 'Latin letters in Russian views');
    for (const k of ['log.gameBegins', 'log.roundReveal', 'log.reveal', 'log.discussion', 'log.voteStep', 'log.tally', 'log.eject', 'log.special', 'log.doorCloses', 'log.backToLobby']) {
      assert.ok(keys.has(k), `${k} was never rendered (the rest is covered by the catalogue test's exhaustive render)`);
    }
  });

  test('the engine\'s fallbacks render in ru: a dealer that throws for the catastrophe, the bunker, a feature and a special', () => {
    const boom = () => { throw new Error('boom'); };
    const real = createGame({ rng: mulberry32(1) }).dealer;
    const dealer = Object.create(real);
    Object.assign(dealer, { drawCatastropheTok: boom, drawBunkerTok: boom, drawBunkerFeatureTok: boom, drawSpecial: boom });
    const g = createGame({ room: 'FALL', rng: mulberry32(3), now: () => 1_800_000_000_000, minPlayers: 4, dealer, fixedSpecials: false });
    for (const name of NAMES.slice(0, 4)) g.join(name, { lang: 'ru' });
    assert.equal(g.handle('p1', { t: 'start' }).ok, true);
    const en = g.view('p1', 'en');
    assert.deepEqual([en.catastrophe.title, en.catastrophe.id, en.bunker.name], ['Catastrophe', null, 'The bunker']);
    // every special is the stand-in "Hidden room" (a catalogue card): play one, the feature is the stand-in storeroom
    assert.equal(g.handle('p1', { t: 'special', uid: g._player('p1').specials[0].uid }).ok, true);
    assert.equal(g.bunker.features.at(-1), 'A hidden storeroom');
    const ru = g.view('p1');
    assert.equal(ru.you.lang, 'ru');
    const hidden = renderSpecial('ru', 'fallback-feature');
    assert.equal(ru.me.specials[0].id, 'fallback-feature');
    assert.equal(ru.me.specials[0].title, hidden.title);
    assert.notEqual(ru.catastrophe.title, 'Catastrophe');
    assert.notEqual(ru.bunker.name, 'The bunker');
    assert.notEqual(ru.bunker.features.at(-1), 'A hidden storeroom');
    const strings = [ru.catastrophe.title, ru.bunker.name, ru.bunker.features.at(-1), ru.me.specials[0].title, ru.me.specials[0].text, ru.log.at(-1).text, ru.log.at(-3).text];
    if (RU_COMPLETE) for (const s of strings) assert.doesNotMatch(s.replace(ALLOWED, ''), LATIN, s);
    // (the stand-in bunker has no features of its own, as before X5, so only its log is held to the §7 schema here)
    for (const e of ru.log) assert.deepEqual(validateLogEntry(e), [], e.key);
  });

  test('a card without its token in a view is an error under NODE_ENV=test (design §3.1)', () => {
    const g = createGame({ room: 'TOKS', rng: mulberry32(4), now: () => 1_800_000_000_000, minPlayers: 4 });
    for (const name of NAMES.slice(0, 4)) g.join(name);
    g.handle('p1', { t: 'start' });
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      g._player('p2').cards.health = { text: 'a copy', revealed: true }; // a spread or a JSON copy drops the token
      assert.throws(() => g.view('p1'), /without its language-neutral token/);
    } finally {
      process.env.NODE_ENV = was;
    }
  });
});
