// Golden test of the content restructure (SPEC §11 X5.4, X5.5, X5.8; reports/i18n-design.md §6, §11.3, §12 B1).
//
// The baseline is test/fixtures/pre-x5/content.js, the orchestrator's frozen snapshot of server/content.js from before
// X5 (read-only). Two things are proved against it:
//   1. The English content files hold today's strings verbatim, under the ids of the §6.2 rule, in deck order, and the
//      language-neutral rules in server/content/gen.js are today's (weights aside, which the deals below cover).
//   2. The new dealer deals exactly what the pre-X5 dealer dealt: for seeds 1..50, the call sequence of §11.3 (and a
//      random mix of calls, and some pathological rngs) gives identical results, byte for byte.
// Checkpoint B2 adds the dealer's Tok methods and the renderers (design §3.3, §6.5):
//   3. renderX('en', <Tok method>()) equals the legacy method's result, and so the pre-X5 dealer's, for the same seeds
//      (the twins may be mixed freely); tokens are deep-frozen, JSON-safe data with the documented shapes.
//   4. The Russian renderer, over synthetic Russian tables (the real ones are the translators' and may be stubs): the
//      positional syntax of §6.3, per-entry English fallback, caching, literals and the engine's stand-ins.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as V1 from './fixtures/pre-x5/content.js';
import * as V2 from '../server/content.js';
import { TABLES, COMPLETE, CONTENT_FILES, createRenderer, drawTemplate } from '../server/content/render.js';
import {
  CATEGORY_IDS, SPECIAL_RULES, SPECIAL_POOL, NOT_IN_POOL, STAY, POOL_IDS, CATASTROPHE_IDS, FEATURE_IDS, FALLBACK_FEATURE_ID,
} from '../server/content/gen.js';
import { mulberry32 } from '../server/rng.js';

const EN = TABLES.en;
const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg); // key order included

// The snapshot's private arrays: its source, with one export line added, imported as a module of its own.
const SRC = fs.readFileSync(new URL('./fixtures/pre-x5/content.js', import.meta.url), 'utf8');
const OLD = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(`${SRC}
export { PROFESSIONS, HEALTH, HOBBIES, PHOBIAS, SKILLS, TRAITS, BAGGAGE, ORIENTATIONS, BIO_NOTES, BIO_NOTE_CHANCE,
  CATASTROPHES, BUNKER_NICKNAMES, BUNKER_LETTERS, FEATURES, SPECIALS, SEVERITY, PHOBIA_INTENSITY, ORDINALS };`)}`);

// The id rule of §6.2: a slug of the English base with placeholders removed; lower case, "'s" -> "s", runs of anything
// else -> "-", trimmed; cut at <= 32 characters on a "-" (one word longer than that stays whole); a duplicate within a
// file gets "-2".
function slug(text) {
  let s = text.replace(/\{[^{}]*\}/g, ' ').toLowerCase().replace(/'s\b/g, 's').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > 32) {
    const cut = s.slice(0, 33).lastIndexOf('-');
    s = cut > 0 ? s.slice(0, cut) : s.split('-')[0];
  }
  return s;
}
function ids(texts, base = slug) {
  const seen = new Map();
  return texts.map((t) => {
    const b = base(t);
    const n = (seen.get(b) || 0) + 1;
    seen.set(b, n);
    return n === 1 ? b : `${b}-${n}`;
  });
}

/** The first keys of `map` are exactly `keys` with exactly `values` (growth after them is allowed). */
function startsWith(map, keys, values, what) {
  const entries = Object.entries(map).slice(0, keys.length);
  same(entries.map(([k]) => k), keys, `${what}: ids (frozen at B1: never renamed, removed or reordered)`);
  same(entries.map(([, v]) => v), values, `${what}: English values (today's strings, verbatim)`);
}

describe('English content files: today\'s strings under the B1 ids', () => {
  const POOLS = {
    professions: OLD.PROFESSIONS, health: OLD.HEALTH, hobbies: OLD.HOBBIES, skills: OLD.SKILLS, traits: OLD.TRAITS,
    baggage: OLD.BAGGAGE,
  };
  for (const [file, texts] of Object.entries(POOLS)) {
    test(`${file}: ${texts.length} cards`, () => startsWith(EN[file], ids(texts), texts, file));
  }
  test('phobias: 58 cards, the id is the name before the colon', () => {
    startsWith(EN.phobias, ids(OLD.PHOBIAS, (t) => slug(t.split(':')[0])), OLD.PHOBIAS, 'phobias');
  });

  test('pools and deck order: POOL_IDS is the key order of the English maps', () => {
    same(Object.keys(POOL_IDS), ['profession', 'health', 'hobby', 'phobia', 'skill', 'trait', 'baggage']);
    const file = { profession: 'professions', health: 'health', hobby: 'hobbies', phobia: 'phobias', skill: 'skills', trait: 'traits', baggage: 'baggage' };
    for (const [c, list] of Object.entries(POOL_IDS)) same(list, Object.keys(EN[file[c]]), c);
  });

  test('every id is a slug of at most 32 characters (one single-word phobia excepted)', () => {
    const all = [
      ...Object.values(POOL_IDS).flat(), ...Object.keys(EN.bunker.nicknames), ...Object.keys(EN.bunker.features),
      ...CATASTROPHE_IDS, ...Object.keys(EN.specials), ...Object.keys(EN.biology.notes), ...Object.keys(EN.labels),
    ];
    for (const id of all) {
      assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, id);
      assert.ok(id.length <= 32 || !id.includes('-'), id);
    }
  });

  test('labels: the pre-X5 CATEGORIES, in order', () => {
    same(CATEGORY_IDS, V1.CATEGORIES.map((c) => c.id));
    same(Object.entries(EN.labels), V1.CATEGORIES.map((c) => [c.id, c.label]));
  });

  test('mods: severity, phobia intensity, the student ordinals', () => {
    same(EN.mods.sev, OLD.SEVERITY.map((s) => s[0]));
    same(EN.mods.phobiaIntensity, OLD.PHOBIA_INTENSITY);
    same(EN.mods.profession.student, `student, {i:${OLD.ORDINALS.join('|')}} year`);
    same(Object.keys(EN.mods.profession), ['exp', 'intern1', 'intern', 'retired', 'student', 'self', 'award', 'revoked', 'fake']);
    same(Object.keys(EN.mods.hobby), ['years', 'childhood', 'started', 'semipro', 'obsessed']);
  });

  test('biology: orientations and notes, with the ids of §6.1', () => {
    same(Object.keys(EN.biology.orientation), ['hetero', 'gay', 'bi', 'ace']);
    same(OLD.ORIENTATIONS.map((o) => o[0]), ['heterosexual', 'gay', 'bisexual', 'asexual']);
    same(Object.values(EN.biology.orientation), ['heterosexual', { f: 'lesbian', m: 'gay' }, 'bisexual', 'asexual']);
    same(Object.keys(EN.biology.notes), ['pregnant', 'twin', 'left-handed', 'very-tall', 'short', 'one-child', 'children', 'adopted', 'strong-build']);
    same(Object.values(EN.biology.notes), OLD.BIO_NOTES.map((n) => n.text));
    same(EN.biology.sex, { f: 'Female', m: 'Male' });
    assert.equal(typeof EN.biology.card, 'function');
  });

  test('catastrophes: 18, keyed by the narration clip basenames, with their stay', () => {
    const list = EN.catastrophes.list;
    same(CATASTROPHE_IDS, OLD.CATASTROPHES.map((c) => slug(c.title)));
    same(Object.values(list), OLD.CATASTROPHES.map(({ title, text, details }) => ({ title, text, details })));
    same(CATASTROPHE_IDS.map((id) => STAY[id]), OLD.CATASTROPHES.map((c) => c.stay));
    // (SPEC §11 X5.16: an entry names its id; its English clip is audio/catastrophes/<id>.mp3, or <id>-<hash8>.mp3
    // after a rebuild changed the audio. test/narration.test.js checks every language's clips.)
    const clips = fs.readdirSync(new URL('../public/audio/catastrophes/', import.meta.url)).filter((f) => f.endsWith('.mp3'));
    const manifest = JSON.parse(fs.readFileSync(new URL('../public/audio/narration.json', import.meta.url), 'utf8'));
    same(manifest.map((c) => c.id).sort(), [...CATASTROPHE_IDS].sort(), 'narration.json: one entry per catastrophe, by its id');
    same(manifest.map((c) => c.src.replace(/^audio\/catastrophes\//, '')).sort(), clips.sort(), 'every catastrophe has its clip, and every clip its catastrophe');
    for (const c of manifest) {
      assert.match(c.src, new RegExp(`^audio/catastrophes/${c.id}(-[0-9a-f]{8})?\\.mp3$`), `narration.json ${c.id}: ${c.src}`);
      assert.equal(list[c.id]?.title, c.title, `narration.json ${c.src}`);
    }
    assert.equal(EN.catastrophes.fallbackTitle, 'Catastrophe');
  });

  test('bunker: nicknames, features (plus the never-dealt fallback), letters, the engine\'s fallback name', () => {
    startsWith(EN.bunker.nicknames, ids(OLD.BUNKER_NICKNAMES), OLD.BUNKER_NICKNAMES, 'nicknames');
    startsWith(EN.bunker.features, ids(OLD.FEATURES), OLD.FEATURES, 'features');
    same(FEATURE_IDS, ids(OLD.FEATURES));
    assert.equal(FALLBACK_FEATURE_ID, 'hidden-storeroom');
    assert.equal(EN.bunker.features[FALLBACK_FEATURE_ID], 'A hidden storeroom');
    assert.equal(EN.bunker.letters, OLD.BUNKER_LETTERS);
    assert.equal(EN.bunker.name.fallback, 'The bunker');
    assert.equal(typeof EN.bunker.months, 'function');
    assert.equal(typeof EN.bunker.range, 'function');
  });

  test('specials: the 52 of the pool in order, then airlock, revive and fallback-feature', () => {
    same(SPECIAL_POOL, OLD.SPECIALS.map((s) => s.id));
    same(Object.keys(EN.specials), [...OLD.SPECIALS.map((s) => s.id), ...NOT_IN_POOL]);
    for (const s of OLD.SPECIALS) {
      same(EN.specials[s.id], { title: s.title, text: s.text }, s.id);
      same(SPECIAL_RULES[s.id], { effect: s.effect, target: s.target, ...(s.category ? { category: s.category } : {}) }, s.id);
    }
    for (const card of [V1.AIRLOCK_CARD, V1.REVIVE_CARD]) {
      same(EN.specials[card.id], { title: card.title, text: card.text }, card.id);
      same(SPECIAL_RULES[card.id], { effect: card.effect, target: card.target }, card.id);
    }
    // server/game.js's FALLBACK_SPECIAL, so that the engine's stand-in is the catalogue card (design §3.4).
    same(EN.specials['fallback-feature'], { title: 'Hidden room', text: 'Add a new feature to the bunker.' });
    same(V2.FALLBACK_SPECIAL, { id: 'fallback-feature', title: 'Hidden room', effect: 'bunker_add_feature', target: 'none', text: 'Add a new feature to the bunker.' });
  });
});

describe('Russian stubs and the category API (checkpoint B1)', () => {
  test('13 content files per language; each Russian file exports COMPLETE and a default object', async () => {
    assert.equal(CONTENT_FILES.length, 13);
    for (const file of CONTENT_FILES) {
      const m = await import(`../server/content/ru/${file}.js`);
      assert.equal(typeof m.COMPLETE, 'boolean', `ru/${file}.js COMPLETE`);
      assert.ok(m.default && typeof m.default === 'object' && !Array.isArray(m.default), `ru/${file}.js default`);
      assert.equal(COMPLETE.ru[file], m.COMPLETE);
      assert.ok(EN[file] && typeof EN[file] === 'object', `en/${file}.js`);
    }
  });

  test('categoryLabel / categoryForms in English: every form is the label', () => {
    for (const { id, label } of V1.CATEGORIES) {
      assert.equal(V2.categoryLabel('en', id), label);
      same(V2.categoryForms('en', id), { label, nom: label, acc: label, gen: label, dat: label, ins: label, loc: label });
    }
  });

  test('categoryForms in Russian: all seven forms are non-empty strings (English until translated)', () => {
    for (const id of CATEGORY_IDS) {
      const f = V2.categoryForms('ru', id);
      same(Object.keys(f), ['label', 'nom', 'acc', 'gen', 'dat', 'ins', 'loc']);
      for (const v of Object.values(f)) assert.ok(typeof v === 'string' && v.length > 0);
      assert.equal(V2.categoryLabel('ru', id), f.label);
      assert.ok(Object.isFrozen(f));
    }
  });

  test('unknown ids give null; unknown languages render English', () => {
    for (const id of ['choose', 'random', 'constructor', '', null, undefined, 3]) {
      assert.equal(V2.categoryLabel('en', id), null, String(id));
      assert.equal(V2.categoryForms('ru', id), null, String(id));
    }
    assert.equal(V2.categoryLabel('de', 'skill'), 'Extra skill');
    assert.equal(V2.categoryLabel(undefined, 'trait'), 'Personality');
  });
});

describe('the dealer deals exactly what the pre-X5 dealer dealt', () => {
  test('the fixed exports are unchanged', () => {
    same(V2.CATEGORIES, V1.CATEGORIES);
    same(V2.AIRLOCK_CARD, V1.AIRLOCK_CARD);
    same(V2.REVIVE_CARD, V1.REVIVE_CARD);
    same(V2.FIXED_EFFECTS, V1.FIXED_EFFECTS);
    assert.ok(Object.isFrozen(V2.AIRLOCK_CARD) && Object.isFrozen(V2.REVIVE_CARD) && Object.isFrozen(V2.FIXED_EFFECTS));
  });

  /** Runs `calls` against an old and a new dealer on the same rng, comparing every result. Returns the call count. */
  function lockstep(makeRng, calls) {
    const a = V1.createDealer(makeRng());
    const b = V2.createDealer(makeRng());
    let n = 0;
    for (const [op, arg] of calls()) {
      const x = a[op](arg);
      const y = b[op](arg);
      if (JSON.stringify(x) !== JSON.stringify(y)) assert.fail(`call ${n} ${op}(${arg ?? ''}): ${JSON.stringify(y)} !== ${JSON.stringify(x)}`);
      n++;
    }
    return n;
  }

  // §11.3: 400 drawCard per category, interleaved as the engine deals (per player, Profession then Biology and the rest
  // in category order), plus drawSpecial ×200, drawCatastrophe ×40, drawBunker ×40 and drawBunkerFeature ×100.
  function* engineOrder() {
    for (let game = 0; game < 40; game++) {
      yield ['drawCatastrophe'];
      yield ['drawBunker'];
      for (let p = 0; p < 10; p++) {
        for (const c of CATEGORY_IDS) yield ['drawCard', c];
        if (p % 2 === 0) yield ['drawSpecial'];
      }
      for (let f = 0; f < (game % 2 ? 2 : 3); f++) yield ['drawBunkerFeature'];
    }
  }

  test('seeds 1..50, the engine\'s order: identical', () => {
    let total = 0;
    for (let seed = 1; seed <= 50; seed++) total += lockstep(() => mulberry32(seed), engineOrder);
    assert.equal(total, 50 * (40 * (2 + 10 * 8 + 5) + 100));
  });

  test('seeds 1..50, a random mix of calls (Biology without a Profession first, bunkers without a catastrophe): identical', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const drive = mulberry32(seed * 7919 + 1);
      lockstep(() => mulberry32(seed), function* mix() {
        for (let i = 0; i < 1500; i++) {
          const r = drive();
          if (r < 0.7) yield ['drawCard', CATEGORY_IDS[Math.floor(drive() * CATEGORY_IDS.length)]];
          else if (r < 0.8) yield ['drawSpecial'];
          else if (r < 0.85) yield ['drawCatastrophe'];
          else if (r < 0.9) yield ['drawBunker'];
          else yield ['drawBunkerFeature'];
        }
      });
    }
  });

  test('pathological rngs (0, just below 1, 1, NaN, negative, constant): identical', () => {
    for (const value of [0, 0.9999999, 1, NaN, -1, 0.5]) lockstep(() => () => value, function* () { yield* engineOrder(); });
  });

  test('an unknown category throws the same TypeError', () => {
    for (const c of ['nope', undefined, 7]) {
      const msg = (d) => { try { d.drawCard(c); } catch (e) { return `${e.constructor.name}: ${e.message}`; } return 'no throw'; };
      assert.equal(msg(V2.createDealer(mulberry32(1))), msg(V1.createDealer(mulberry32(1))));
    }
  });

  test('a dealer without a usable rng still deals (Math.random)', () => {
    for (const d of [V2.createDealer(), V2.createDealer('not a function')]) {
      assert.equal(typeof d.drawCard('biology'), 'string');
      assert.equal(typeof d.drawBunker().name, 'string');
    }
  });
});

// ---- checkpoint B2: tokens and renderers ---------------------------------------------------------------------------

describe('B2: the Tok methods deal what the English methods deal', () => {
  const TOK = {
    drawCard: (d, c) => V2.renderCard('en', d.drawCardTok(c)),
    drawCatastrophe: (d) => { const { title, text, details } = V2.renderCatastrophe('en', d.drawCatastropheTok()); return { title, text, details }; },
    drawBunker: (d) => { const { name, size, duration, food, features } = V2.renderBunker('en', d.drawBunkerTok()); return { name, size, duration, food, features }; },
    drawBunkerFeature: (d) => V2.renderFeature('en', d.drawBunkerFeatureTok()),
    drawSpecial: (d) => d.drawSpecial(),
  };

  /** The pre-X5 dealer, the English methods and the Tok twins (or a mix: `useTok(i)`), in lockstep on one seed. */
  function triple(seed, calls, useTok = () => true) {
    const v1 = V1.createDealer(mulberry32(seed));
    const en = V2.createDealer(mulberry32(seed));
    const tk = V2.createDealer(mulberry32(seed));
    let i = 0;
    for (const [op, arg] of calls()) {
      const a = JSON.stringify(v1[op](arg));
      const b = JSON.stringify(en[op](arg));
      const c = JSON.stringify(useTok(i) ? TOK[op](tk, arg) : tk[op](arg));
      if (a !== b || a !== c) assert.fail(`seed ${seed} call ${i} ${op}(${arg ?? ''}): v1 ${a}, en ${b}, tok ${c}`);
      i++;
    }
    return i;
  }

  function* engineOrder() {
    for (let game = 0; game < 40; game++) {
      yield ['drawCatastrophe'];
      yield ['drawBunker'];
      for (let p = 0; p < 10; p++) {
        for (const c of CATEGORY_IDS) yield ['drawCard', c];
        if (p % 2 === 0) yield ['drawSpecial'];
      }
      for (let f = 0; f < (game % 2 ? 2 : 3); f++) yield ['drawBunkerFeature'];
    }
  }

  test('the dealer has the four Tok methods next to the five English ones', () => {
    const d = V2.createDealer(mulberry32(1));
    for (const m of ['drawCard', 'drawSpecial', 'drawCatastrophe', 'drawBunker', 'drawBunkerFeature', 'drawCardTok',
      'drawCatastropheTok', 'drawBunkerTok', 'drawBunkerFeatureTok']) assert.equal(typeof d[m], 'function', m);
  });

  test('seeds 1..50, the engine\'s order: renderX(\'en\', tok) === the English method === the pre-X5 dealer', () => {
    let n = 0;
    for (let seed = 1; seed <= 50; seed++) n += triple(seed, engineOrder);
    assert.equal(n, 50 * (40 * (2 + 10 * 8 + 5) + 100));
  });

  test('seeds 1..50, Tok and English calls mixed at random on one dealer: still the pre-X5 deal', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const coin = mulberry32(seed * 104729 + 3);
      triple(seed, engineOrder, () => coin() < 0.5);
    }
  });

  test('pathological rngs through the Tok methods: identical', () => {
    for (const value of [0, 0.9999999, 1, NaN, -1, 0.5]) {
      const v1 = V1.createDealer(() => value);
      const tk = V2.createDealer(() => value);
      let i = 0;
      for (const [op, arg] of engineOrder()) {
        assert.equal(JSON.stringify(TOK[op](tk, arg)), JSON.stringify(v1[op](arg)), `rng ${value} call ${i} ${op}`);
        i++;
      }
    }
  });

  test('drawCardTok throws the English method\'s TypeError for an unknown category', () => {
    for (const c of ['nope', undefined, 7]) {
      assert.throws(() => V2.createDealer(mulberry32(1)).drawCardTok(c), { name: 'TypeError', message: `content: unknown category ${String(c)}` });
    }
  });
});

/** Every token a seed deals in the engine's order, by kind. */
function dealTokens(seed, games = 6) {
  const d = V2.createDealer(mulberry32(seed));
  const out = { card: [], cat: [], bunker: [], feature: [] };
  for (let g = 0; g < games; g++) {
    out.cat.push(d.drawCatastropheTok());
    out.bunker.push(d.drawBunkerTok());
    for (let p = 0; p < 12; p++) for (const c of CATEGORY_IDS) out.card.push(d.drawCardTok(c));
    for (let f = 0; f < 3; f++) out.feature.push(d.drawBunkerFeatureTok());
  }
  return out;
}

const isFrozenDeep = (x) => x === null || typeof x !== 'object' || (Object.isFrozen(x) && Object.values(x).every(isFrozenDeep));

describe('B2: tokens are frozen, JSON-safe data of the documented shapes', () => {
  const MOD_KINDS = {
    profession: { exp: [1, 30], intern1: null, intern: [1, 11], retired: [20, 42], student: [1, 5], self: [1, 15], award: [15, 35], revoked: [2, 20], fake: [1, 10] },
    hobby: { years: [1, 20], childhood: null, started: null, semipro: [3, 20], obsessed: [1, 15] },
  };
  const FILE = { profession: 'professions', health: 'health', hobby: 'hobbies', phobia: 'phobias', skill: 'skills', trait: 'traits', baggage: 'baggage' };

  /** The values `v` fit the English template's placeholders. */
  function fits(template, v, what) {
    const P = drawTemplate(template).params;
    assert.equal(v.length, P.length, `${what}: one value per placeholder`);
    P.forEach((p, i) => {
      assert.ok(Number.isInteger(v[i]), `${what}: value ${i} is an integer`);
      if (p.type === 'n' || p.type === 'yrs') assert.ok(v[i] >= p.lo && v[i] <= p.hi, `${what}: ${v[i]} in ${p.lo}-${p.hi}`);
      else if (p.type === 'sev') assert.ok(v[i] >= 0 && v[i] <= 2, what);
      else assert.ok(v[i] >= 0 && v[i] < p.options.length, what);
    });
  }

  function checkCard(tok) {
    const what = JSON.stringify(tok);
    if (tok.c === 'biology') {
      assert.deepEqual(Object.keys(tok).filter((k) => k !== 'note'), ['c', 'sex', 'age', 'o'], what);
      assert.ok(['f', 'm'].includes(tok.sex) && Number.isInteger(tok.age) && tok.age >= 18 && tok.age <= 85, what);
      assert.ok(Object.hasOwn(EN.biology.orientation, tok.o), what);
      if (tok.note) {
        assert.ok(Object.hasOwn(EN.biology.notes, tok.note.id), what);
        fits(EN.biology.notes[tok.note.id], tok.note.v, what);
      }
      return;
    }
    assert.ok(Object.hasOwn(FILE, tok.c) && POOL_IDS[tok.c].includes(tok.id), what);
    fits(EN[FILE[tok.c]][tok.id], tok.v, what);
    if (tok.mod) {
      assert.ok(['profession', 'hobby'].includes(tok.c) && !EN[FILE[tok.c]][tok.id].includes('('), what);
      const range = MOD_KINDS[tok.c][tok.mod.k];
      assert.notEqual(range, undefined, what);
      if (range) assert.ok(Number.isInteger(tok.mod.n) && tok.mod.n >= range[0] && tok.mod.n <= range[1], what);
      else assert.equal(tok.mod.n, undefined, what);
    } else if (tok.c === 'profession' || tok.c === 'hobby') assert.ok(EN[FILE[tok.c]][tok.id].includes('('), `${what}: no modifier only for a card with its own "(…)"`);
    if (Object.hasOwn(tok, 'int')) assert.ok(tok.c === 'phobia' && tok.int >= 0 && tok.int < EN.mods.phobiaIntensity.length, what);
  }

  test('seeds 1..20: every card, catastrophe, bunker and feature token', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const t = dealTokens(seed);
      for (const x of [...t.card, ...t.cat, ...t.bunker, ...t.feature]) {
        assert.ok(isFrozenDeep(x), `deep-frozen: ${JSON.stringify(x)}`);
        assert.deepEqual(JSON.parse(JSON.stringify(x)), x, 'JSON-safe');
      }
      t.card.forEach(checkCard);
      for (const c of t.cat) {
        assert.deepEqual(Object.keys(c), ['id', 'v', 'stay']);
        assert.ok(CATASTROPHE_IDS.includes(c.id));
        assert.deepEqual(c.stay, STAY[c.id]);
        EN.catastrophes.list[c.id].details.forEach((d, i) => fits(d, c.v[i], `${c.id} detail ${i}`));
      }
      for (const b of [...t.bunker]) {
        assert.deepEqual(Object.keys(b), ['name', 'size', 'stay', 'food', 'features']);
        assert.ok(b.size % 5 === 0 && b.size >= 60 && b.size <= 300);
        assert.ok(Number.isInteger(b.stay) && Number.isInteger(b.food) && b.food >= 1);
        assert.ok(b.features.length >= 3 && b.features.length <= 5);
        assert.equal(new Set(b.features.map((f) => f.id)).size, b.features.length, 'no feature twice in one bunker');
        const n = b.name;
        if (n.k === 'nick') assert.ok(Object.hasOwn(EN.bunker.nicknames, n.nick));
        else if (n.k === 'shelter') assert.ok(n.n >= 2 && n.n <= 99);
        else {
          assert.equal(n.k, 'object');
          assert.ok(n.n >= 10 && n.n <= 999 && n.letter >= 0 && n.letter < 15 && Object.hasOwn(EN.bunker.nicknames, n.nick));
        }
      }
      for (const f of [...t.feature, ...t.bunker.flatMap((b) => b.features)]) {
        assert.ok(FEATURE_IDS.includes(f.id), f.id);
        fits(EN.bunker.features[f.id], f.v, f.id);
      }
    }
  });

  test('a token is data: a JSON copy renders exactly like the original, in every language', () => {
    const t = dealTokens(7, 3);
    const copy = (x) => JSON.parse(JSON.stringify(x));
    for (const lang of ['en', 'ru']) {
      for (const x of t.card) assert.equal(V2.renderCard(lang, copy(x)), V2.renderCard(lang, x));
      for (const x of t.cat) assert.deepEqual(V2.renderCatastrophe(lang, copy(x)), V2.renderCatastrophe(lang, x));
      for (const x of t.bunker) assert.deepEqual(V2.renderBunker(lang, copy(x)), V2.renderBunker(lang, x));
      for (const x of t.feature) assert.equal(V2.renderFeature(lang, copy(x)), V2.renderFeature(lang, x));
    }
  });
});

describe('B2: the renderers', () => {
  test('cached per token and language; object results are deep-frozen; an unknown language renders English', () => {
    const t = dealTokens(3, 2);
    const cat = t.cat[0];
    const a = V2.renderCatastrophe('en', cat);
    assert.equal(V2.renderCatastrophe('en', cat), a);
    assert.ok(isFrozenDeep(a));
    assert.deepEqual(Object.keys(a), ['id', 'title', 'text', 'details']);
    assert.equal(a.id, cat.id);
    assert.equal(V2.renderCatastrophe('de', cat), a);
    assert.equal(V2.renderCatastrophe(undefined, cat), a);
    const b = V2.renderBunker('ru', t.bunker[0]);
    assert.equal(V2.renderBunker('ru', t.bunker[0]), b);
    assert.ok(isFrozenDeep(b));
    assert.deepEqual(Object.keys(b), ['name', 'size', 'duration', 'food', 'features']);
    assert.equal(V2.renderBunkerName('en', t.bunker[0].name), V2.renderBunker('en', t.bunker[0]).name);
    for (const x of t.card) assert.equal(V2.renderCard('xx', x), V2.renderCard('en', x));
  });

  test('renderSpecial: the catalogue\'s words by id (55 ids), null for anything else', () => {
    for (const [id, card] of Object.entries(EN.specials)) {
      const r = V2.renderSpecial('en', id);
      assert.deepEqual({ ...r }, card, id);
      assert.ok(Object.isFrozen(r));
      assert.equal(V2.renderSpecial('en', id), r, 'cached');
      const ru = V2.renderSpecial('ru', id);
      const own = TABLES.ru.specials[id];
      assert.equal(ru.title, typeof own?.title === 'string' ? own.title : card.title, id);
      assert.equal(ru.text, typeof own?.text === 'string' ? own.text : card.text, id);
    }
    for (const x of ['nope', '', null, undefined, 3, 'constructor', '__proto__', 'toString']) assert.equal(V2.renderSpecial('en', x), null, String(x));
  });

  test('literals render as they are in every language; null gives the empty result', () => {
    for (const lang of ['en', 'ru']) {
      assert.equal(V2.renderCard(lang, V2.litTok('<health#1>')), '<health#1>');
      assert.equal(V2.renderCard(lang, { lit: 'Asthma' }), 'Asthma');
      assert.equal(V2.renderFeature(lang, { lit: 'Pool' }), 'Pool');
      assert.equal(V2.renderBunkerName(lang, { lit: 'Test bunker' }), 'Test bunker');
      assert.deepEqual(V2.renderCatastrophe(lang, { lit: { title: 'T', text: 'X', details: ['a', 'b'] } }), { id: null, title: 'T', text: 'X', details: ['a', 'b'] });
      assert.deepEqual(V2.renderCatastrophe(lang, { lit: 'T' }), { id: null, title: 'T', text: '', details: [] });
      assert.deepEqual(V2.renderBunker(lang, { lit: { name: 'B', size: '1', duration: '2', food: '3', features: ['f'] }, features: [{ lit: 'g' }] }),
        { name: 'B', size: '1', duration: '2', food: '3', features: ['f', 'g'] });
      assert.equal(V2.renderCard(lang, null), '');
      assert.equal(V2.renderFeature(lang, undefined), '');
      assert.equal(V2.renderBunkerName(lang, null), '');
      assert.equal(V2.renderCatastrophe(lang, null), null);
      assert.equal(V2.renderBunker(lang, null), null);
    }
    assert.deepEqual(V2.litTok(null), { lit: '' });
  });

  test('the engine\'s stand-ins (design §3.4) render as the pre-X5 engine printed them', () => {
    assert.equal(V2.renderFeature('en', V2.FALLBACK_FEATURE_TOK), 'A hidden storeroom');
    assert.deepEqual(V2.renderCatastrophe('en', V2.FALLBACK_CATASTROPHE_TOK), { id: null, title: 'Catastrophe', text: '', details: [] });
    assert.equal(V2.renderBunkerName('en', V2.FALLBACK_BUNKER_NAME_TOK), 'The bunker');
    assert.deepEqual(V2.renderBunker('en', V2.FALLBACK_BUNKER_TOK), { name: 'The bunker', size: '', duration: '', food: '', features: [] });
    for (const x of [V2.FALLBACK_FEATURE_TOK, V2.FALLBACK_CATASTROPHE_TOK, V2.FALLBACK_BUNKER_NAME_TOK, V2.FALLBACK_BUNKER_TOK]) assert.ok(isFrozenDeep(x));
    // Russian: the translators' words when present, English until then (never an empty title)
    assert.ok(V2.renderCatastrophe('ru', V2.FALLBACK_CATASTROPHE_TOK).title.length > 0);
    assert.ok(V2.renderBunkerName('ru', V2.FALLBACK_BUNKER_NAME_TOK).length > 0);
  });

  test('bunkerWithFeature: a new frozen token, the original untouched', () => {
    const [b] = dealTokens(5, 1).bunker;
    const before = V2.renderBunker('en', b);
    const b2 = V2.bunkerWithFeature(b, V2.FALLBACK_FEATURE_TOK);
    assert.notEqual(b2, b);
    assert.ok(isFrozenDeep(b2));
    assert.deepEqual(V2.renderBunker('en', b2), { ...before, features: [...before.features, 'A hidden storeroom'] });
    assert.equal(V2.renderBunker('en', b), before);
    assert.equal(b.features.length + 1, b2.features.length);
    const lit = V2.bunkerWithFeature({ lit: { name: 'B', features: ['x'] } }, { lit: 'y' });
    assert.deepEqual(V2.renderBunker('en', lit).features, ['x', 'y']);
    assert.deepEqual(V2.renderBunker('en', V2.bunkerWithFeature(null, V2.FALLBACK_FEATURE_TOK)).features, ['A hidden storeroom']);
  });

  test('the real Russian tables: every dealt token renders to text in ru, whatever the translators have done so far', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const t = dealTokens(seed, 4);
      for (const x of [...t.card]) assert.equal(typeof V2.renderCard('ru', x), 'string');
      for (const x of t.feature) assert.equal(typeof V2.renderFeature('ru', x), 'string');
      for (const x of t.cat) {
        const r = V2.renderCatastrophe('ru', x);
        assert.equal(r.id, x.id);
        assert.equal(r.details.length, x.v.length + 1);
        for (const s of [r.title, r.text, ...r.details]) assert.ok(typeof s === 'string' && s.length > 0 && !/[{}]/.test(s), s);
      }
      for (const x of t.bunker) {
        const r = V2.renderBunker('ru', x);
        assert.equal(r.features.length, x.features.length);
        for (const s of [r.name, r.size, r.duration, r.food, ...r.features]) assert.ok(typeof s === 'string' && s.length > 0 && !/[{}]/.test(s), s);
      }
      for (const c of CATEGORY_IDS) assert.equal(typeof V2.categoryLabel('ru', c), 'string');
    }
  });
});

// Synthetic Russian tables that use every form of the positional syntax (design §6.3); the rest falls back to English.
const RU = {
  labels: {},
  mods: {
    sev: ['лёгкая форма', 'средняя форма', 'тяжёлая форма'],
    yrs: '{n} {n|год|года|лет}',
    phobiaIntensity: ['лёгкая', 'умеренная', 'сильная', 'панические атаки'],
    phobiaWrap: '{base} ({mod})',
    profession: { exp: 'стаж {n} {n|год|года|лет}', student: '{n}-й курс', retired: (p, f) => `на пенсии после ${f.num(p.n)} ${f.pl(p.n, 'года', 'лет', 'лет')} работы` },
    professionWrap: '{base} ({mod})',
    hobby: { years: '{n} {n|год|года|лет}', childhood: 'с детства' },
    hobbyWrap: '{base}: {mod}',
  },
  professions: { 'surgeon': 'Хирург', 'homemaker-raised-children': 'Домашнее хозяйство (на руках {0} {0|ребёнок|ребёнка|детей})' },
  health: {
    'asthma': 'Астма ({0})',
    'type-2-diabetes': 'Диабет 2-го типа ({0:лёгкий|средний|тяжёлый})',
    'allergy-to': 'Аллергия на {0:арахис|пыль|кошек|пенициллин|укусы пчёл|плесень|глютен} ({1})',
    'infertility': 'Бесплодие: {0}',
    'survived-a-heart-attack-ago': 'Инфаркт {0} назад',
    'near-sightedness-diopters-no': (v, f) => `Близорукость (−${f.num(v[0])} ${f.pl(v[0], 'диоптрия', 'диоптрии', 'диоптрий')})`,
    'cancer-in-remission': 'Рак в ремиссии ({0})',
    'hemophilia': () => { throw new Error('translator bug'); },
  },
  hobbies: { 'fishing': 'Рыбалка' },
  phobias: { 'claustrophobia': 'Клаустрофобия: страх замкнутых пространств' },
  skills: {
    'former-prisoner-years-for': 'Отсидка: {0} {0|год|года|лет} за {1:мошенничество|грабёж|уклонение от налогов|контрабанду|то, о чём не любит говорить}',
    'speaks-languages': '{0} {0|язык|языка|языков} — свободно',
  },
  traits: {},
  baggage: { 'tent-for-people': 'Палатка на {0} {0|человека|человека|человек}' },
  biology: {
    sex: { f: 'Женщина', m: 'Мужчина' },
    orientation: { hetero: { f: 'гетеросексуальна', m: 'гетеросексуален' }, gay: { f: 'лесбиянка', m: 'гей' } },
    notes: { 'children': '{0:||двое|трое|четверо|пятеро} детей', 'very-tall': { f: 'очень высокая ({0} см)', m: 'очень высокий ({0} см)' } },
    card: (v, f) => `${v.sexText}, ${f.num(v.age)} ${f.pl(v.age, 'год', 'года', 'лет')}, ${v.oText}${v.noteText ? `, ${v.noteText}` : ''}`,
  },
  catastrophes: {
    list: { 'nuclear-winter': { title: 'Ядерная зима', text: 'Текст.', details: ['Выжившие: около {0}% населения Земли', 'Поверхность: −{0}°C'] } },
    safe: 'Поверхность станет безопасной через {range}',
    fallbackTitle: 'Катастрофа',
  },
  bunker: {
    nicknames: { 'last-hope': 'Последняя надежда' },
    features: { 'camera-drone-with-batteries': 'Дрон с камерой и {0} {0|аккумулятором|аккумуляторами|аккумуляторами}' },
    letters: 'АБВГДЕКМНПРСТХЗ',
    name: { nick: 'Бункер «{nick}»', shelter: 'Убежище № {n}', object: 'Объект {n}-{letter} «{nick}»', fallback: 'Бункер' },
    size: '{n} м²',
    duration: 'Сидеть внутри: {months}',
    food: 'Еды на {months}',
    months: (v, f) => (v.m < 12 ? `${f.num(v.m)} ${f.pl(v.m, 'месяц', 'месяца', 'месяцев')}` : `${f.num(v.m / 12)} ${f.pl(v.m / 12, 'год', 'года', 'лет')}`),
    range: (v, f) => `${f.num(v.lo / 12)}–${f.num(v.hi / 12)} ${f.pl(v.hi / 12, 'год', 'года', 'лет')}`,
  },
  specials: { 'airlock': { title: 'Шлюз', text: 'Нужен напарник.' }, 'revive': { title: 'Вернулся из леса' } },
};

describe('B2: the Russian (positional) renderer over synthetic tables', () => {
  const warnings = [];
  const R = createRenderer({ en: TABLES.en, ru: RU }, { warn: (m) => warnings.push(m) });
  const card = (tok) => R.renderCard('ru', Object.freeze(tok));

  test('{0} prints a number, a «N лет» (yrs, from mods.yrs) or the severity phrase (sev, from mods.sev)', () => {
    assert.equal(card({ c: 'health', id: 'asthma', v: [2] }), 'Астма (тяжёлая форма)');
    assert.equal(card({ c: 'health', id: 'survived-a-heart-attack-ago', v: [1] }), 'Инфаркт 1 год назад');
    assert.equal(card({ c: 'health', id: 'survived-a-heart-attack-ago', v: [3] }), 'Инфаркт 3 года назад');
    assert.equal(card({ c: 'health', id: 'cancer-in-remission', v: [5] }), 'Рак в ремиссии (5 лет)');
    assert.equal(card({ c: 'skill', id: 'speaks-languages', v: [5] }), '5 языков — свободно');
  });

  test('{0|a|b|c} is one/few/many; {i:…} picks an option of a pick, a sev (3 forms) or by the number itself', () => {
    const prisoner = (n, k) => card({ c: 'skill', id: 'former-prisoner-years-for', v: [n, k] });
    assert.equal(prisoner(2, 0), 'Отсидка: 2 года за мошенничество');
    assert.equal(prisoner(11, 4), 'Отсидка: 11 лет за то, о чём не любит говорить');
    assert.equal(prisoner(15, 3), 'Отсидка: 15 лет за контрабанду');
    assert.equal(card({ c: 'health', id: 'type-2-diabetes', v: [1] }), 'Диабет 2-го типа (средний)');
    assert.equal(card({ c: 'health', id: 'allergy-to', v: [4, 0] }), 'Аллергия на укусы пчёл (лёгкая форма)');
    assert.equal(card({ c: 'baggage', id: 'tent-for-people', v: [2] }), 'Палатка на 2 человека');
    assert.equal(card({ c: 'baggage', id: 'tent-for-people', v: [5] }), 'Палатка на 5 человек');
    assert.equal(card({ c: 'profession', id: 'homemaker-raised-children', v: [2] }), 'Домашнее хозяйство (на руках 2 ребёнка)');
  });

  test('a function value gets the values array and the Russian helpers', () => {
    assert.equal(card({ c: 'health', id: 'near-sightedness-diopters-no', v: [2] }), 'Близорукость (−2 диоптрии)');
    assert.equal(card({ c: 'health', id: 'near-sightedness-diopters-no', v: [5] }), 'Близорукость (−5 диоптрий)');
  });

  test('modifiers and wraps come from ru/mods.js (named params; student {n}), falling back per key', () => {
    assert.equal(card({ c: 'profession', id: 'surgeon', v: [], mod: { k: 'exp', n: 21 } }), 'Хирург (стаж 21 год)');
    assert.equal(card({ c: 'profession', id: 'surgeon', v: [], mod: { k: 'student', n: 3 } }), 'Хирург (3-й курс)');
    assert.equal(card({ c: 'profession', id: 'surgeon', v: [], mod: { k: 'retired', n: 21 } }), 'Хирург (на пенсии после 21 года работы)');
    assert.equal(card({ c: 'profession', id: 'surgeon', v: [], mod: { k: 'fake', n: 2 } }), 'Хирург (fake diploma, 2 years of practice)');
    assert.equal(card({ c: 'hobby', id: 'fishing', v: [], mod: { k: 'years', n: 12 } }), 'Рыбалка: 12 лет');
    assert.equal(card({ c: 'hobby', id: 'fishing', v: [], mod: { k: 'childhood' } }), 'Рыбалка: с детства');
    assert.equal(card({ c: 'phobia', id: 'claustrophobia', v: [], int: 3 }), 'Клаустрофобия: страх замкнутых пространств (панические атаки)');
    assert.equal(card({ c: 'phobia', id: 'claustrophobia', v: [] }), 'Клаустрофобия: страх замкнутых пространств');
  });

  test('a missing entry falls back to English, with one warning per file', () => {
    const before = warnings.length;
    assert.equal(card({ c: 'trait', id: POOL_IDS.trait[0], v: [] }), TABLES.en.traits[POOL_IDS.trait[0]]);
    assert.equal(card({ c: 'trait', id: POOL_IDS.trait[1], v: [] }), TABLES.en.traits[POOL_IDS.trait[1]]);
    assert.equal(card({ c: 'health', id: 'epilepsy-seizures', v: [1] }), 'Epilepsy (seizures about once a month)');
    const added = warnings.slice(before);
    assert.equal(added.filter((m) => m.includes('ru/traits.js')).length, 1, added.join('\n'));
    assert.equal(added.filter((m) => m.includes('ru/health.js')).length, 1, added.join('\n'));
  });

  test('a translator\'s function that throws, and an option printed with {i}: English, with a warning', () => {
    const tok = { c: 'health', id: 'hemophilia', v: [0] };
    assert.equal(card(tok), 'Hemophilia (mild)');
    assert.ok(warnings.some((m) => m.includes('translator bug')));
    assert.equal(card({ c: 'health', id: 'infertility', v: [1] }), 'Бесплодие: untreatable');
    assert.ok(warnings.some((m) => m.includes('option param')));
  });

  test('biology: words by the card\'s own sex, notes positional, the card function, English where missing', () => {
    const bio = (sex, age, o, note) => card({ c: 'biology', sex, age, o, ...(note ? { note } : {}) });
    assert.equal(bio('f', 34, 'hetero'), 'Женщина, 34 года, гетеросексуальна');
    assert.equal(bio('m', 21, 'gay', { id: 'children', v: [3] }), 'Мужчина, 21 год, гей, трое детей');
    assert.equal(bio('f', 25, 'gay', { id: 'very-tall', v: [201] }), 'Женщина, 25 лет, лесбиянка, очень высокая (201 см)');
    assert.equal(bio('m', 40, 'hetero', { id: 'very-tall', v: [199] }), 'Мужчина, 40 лет, гетеросексуален, очень высокий (199 см)');
    assert.equal(bio('m', 40, 'bi', { id: 'twin', v: [] }), 'Мужчина, 40 лет, bisexual, twin');
  });

  test('catastrophes: title, text, positional details, the safe line with ru range(); English per missing field', () => {
    const tok = Object.freeze({ id: 'nuclear-winter', v: [[5], [40], []], stay: [24, 72] });
    const r = R.renderCatastrophe('ru', tok);
    assert.deepEqual(r, {
      id: 'nuclear-winter', title: 'Ядерная зима', text: 'Текст.',
      details: ['Выжившие: около 5% населения Земли', 'Поверхность: −40°C', 'Threats: cold, radiation, starving raiders', 'Поверхность станет безопасной через 2–6 лет'],
    });
    assert.equal(R.renderCatastrophe('ru', tok), r);
    const lows = (d) => drawTemplate(d).params.map((p) => p.lo);
    const volcano = TABLES.en.catastrophes.list.supervolcano;
    const other = R.renderCatastrophe('ru', Object.freeze({ id: 'supervolcano', v: volcano.details.map(lows), stay: [24, 60] }));
    assert.equal(other.title, volcano.title);
    assert.equal(other.details[0], R.replay(volcano.details[0], lows(volcano.details[0])));
    assert.equal(other.details.at(-1), 'Поверхность станет безопасной через 2–5 лет');
    assert.deepEqual(R.renderCatastrophe('ru', { id: null, fallback: true }), { id: null, title: 'Катастрофа', text: '', details: [] });
  });

  test('bunkers: the name kinds (Cyrillic letters by index), size, stay and food with ru months(), positional features', () => {
    const b = Object.freeze({
      name: { k: 'object', n: 123, letter: 5, nick: 'last-hope' }, size: 120, stay: 24, food: 6,
      features: [{ id: 'camera-drone-with-batteries', v: [2] }, { id: 'radiation-suits', v: [3] }],
    });
    assert.deepEqual(R.renderBunker('ru', b), {
      name: 'Объект 123-Е «Последняя надежда»', size: '120 м²', duration: 'Сидеть внутри: 2 года', food: 'Еды на 6 месяцев',
      features: ['Дрон с камерой и 2 аккумуляторами', '3 radiation suits'],
    });
    assert.equal(R.renderBunkerName('ru', { k: 'nick', nick: 'last-hope' }), 'Бункер «Последняя надежда»');
    assert.equal(R.renderBunkerName('ru', { k: 'nick', nick: 'molehill' }), 'Бункер «Molehill»');
    assert.equal(R.renderBunkerName('ru', { k: 'shelter', n: 42 }), 'Убежище № 42');
    assert.equal(R.renderBunkerName('ru', { k: 'fallback' }), 'Бункер');
    assert.equal(R.renderBunkerName('en', { k: 'object', n: 123, letter: 5, nick: 'last-hope' }), 'Object 123-K "Last Hope"');
  });

  test('specials: the Russian title and text per field, English where missing', () => {
    assert.deepEqual({ ...R.renderSpecial('ru', 'airlock') }, { title: 'Шлюз', text: 'Нужен напарник.' });
    assert.deepEqual({ ...R.renderSpecial('ru', 'revive') }, { title: 'Вернулся из леса', text: TABLES.en.specials.revive.text });
    assert.deepEqual({ ...R.renderSpecial('ru', 'swap-baggage') }, TABLES.en.specials['swap-baggage']);
  });

  test('English over the same tables is unchanged by them', () => {
    const t = dealTokens(11, 2);
    for (const x of t.card) assert.equal(R.renderCard('en', x), V2.renderCard('en', x));
    for (const x of t.cat) assert.deepEqual(R.renderCatastrophe('en', x), V2.renderCatastrophe('en', x));
    for (const x of t.bunker) assert.deepEqual(R.renderBunker('en', x), V2.renderBunker('en', x));
  });
});
