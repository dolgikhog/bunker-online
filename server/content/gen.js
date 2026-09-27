// server/content/gen.js: language-neutral content generation (SPEC §8, §11 X5.4–X5.5; reports/i18n-design.md §6.1,
// §6.4, §3.9).
//
// Everything here is independent of language: the category order, what each special does, the weights, the ranges,
// the catastrophes' `stay`, the Biology rules and ages, and the dealer. Words live in ./en/*.js and ./ru/*.js; the
// deck order of every pool is the key order of the English map, and the number ranges and option counts come from the
// English templates.
//
// The dealer deals language-neutral tokens (./render.js lists their shapes): its Tok methods return them, and each
// English method is renderX('en', <its Tok method>()), so every random call happens exactly as in the pre-X5 dealer and
// a seed deals the same cards, byte for byte (test/i18n-golden-content.test.js). The repeat check (`unique`) compares
// English texts, as before.

import { TABLES, POOL_FILE, drawTemplate, renderCard, renderCatastrophe, renderBunker, renderFeature } from './render.js';

const EN = TABLES.en;

/** Category ids in display and deal order (SPEC §1). */
export const CATEGORY_IDS = Object.freeze(['profession', 'biology', 'health', 'hobby', 'phobia', 'skill', 'trait', 'baggage']);

// ---- specials -------------------------------------------------------------------------------------------------------

// What each special does (SPEC §5): effect, target and category, by the id of ./en/specials.js. The random pool never
// holds an Airlock, a revive or the retired one-player `eject`: the engine deals the fixed cards itself (§11 X1).
// Cards that reveal a category for every alive player (mass_reveal, shuffle_category) are kept to 3 of the 52: with
// more, round-7 turns often had nothing left to reveal (SPEC §1 "one card stays hidden"; §11 C6).
export const SPECIAL_RULES = Object.freeze({
  // swap_card (target other; a Category or 'choose')
  'swap-baggage': { effect: 'swap_card', target: 'other', category: 'baggage' },
  'swap-profession': { effect: 'swap_card', target: 'other', category: 'profession' },
  'swap-health': { effect: 'swap_card', target: 'other', category: 'health' },
  'swap-hobby': { effect: 'swap_card', target: 'other', category: 'hobby' },
  'swap-phobia': { effect: 'swap_card', target: 'other', category: 'phobia' },
  'swap-trait': { effect: 'swap_card', target: 'other', category: 'trait' },
  'swap-biology': { effect: 'swap_card', target: 'other', category: 'biology' },
  'swap-choose': { effect: 'swap_card', target: 'other', category: 'choose' },

  // reroll_card (target self or other; a Category or 'choose')
  'reroll-self-health': { effect: 'reroll_card', target: 'self', category: 'health' },
  'reroll-self-profession': { effect: 'reroll_card', target: 'self', category: 'profession' },
  'reroll-self-phobia': { effect: 'reroll_card', target: 'self', category: 'phobia' },
  'reroll-self-baggage': { effect: 'reroll_card', target: 'self', category: 'baggage' },
  'reroll-self-choose': { effect: 'reroll_card', target: 'self', category: 'choose' },
  'reroll-other-baggage': { effect: 'reroll_card', target: 'other', category: 'baggage' },
  'reroll-other-trait': { effect: 'reroll_card', target: 'other', category: 'trait' },
  'reroll-other-health': { effect: 'reroll_card', target: 'other', category: 'health' },
  'reroll-other-choose': { effect: 'reroll_card', target: 'other', category: 'choose' },

  // force_reveal (target other; 'choose' or 'random')
  'reveal-interrogation': { effect: 'force_reveal', target: 'other', category: 'choose' },
  'reveal-background-check': { effect: 'force_reveal', target: 'other', category: 'choose' },
  'reveal-subpoena': { effect: 'force_reveal', target: 'other', category: 'choose' },
  'reveal-truth-serum': { effect: 'force_reveal', target: 'other', category: 'random' },
  'reveal-paparazzi': { effect: 'force_reveal', target: 'other', category: 'random' },
  'reveal-loose-lips': { effect: 'force_reveal', target: 'other', category: 'random' },

  // peek (target other; 'choose' or 'random')
  'peek-dossier': { effect: 'peek', target: 'other', category: 'choose' },
  'peek-xray': { effect: 'peek', target: 'other', category: 'choose' },
  'peek-stolen-diary': { effect: 'peek', target: 'other', category: 'choose' },
  'peek-keyhole': { effect: 'peek', target: 'other', category: 'random' },
  'peek-gossip': { effect: 'peek', target: 'other', category: 'random' },
  'peek-eavesdropping': { effect: 'peek', target: 'other', category: 'random' },
  'peek-bribed-guard': { effect: 'peek', target: 'other', category: 'choose' },
  'peek-wiretap': { effect: 'peek', target: 'other', category: 'random' },

  // mass_reveal (target none; a Category or 'choose')
  'mass-health': { effect: 'mass_reveal', target: 'none', category: 'health' },
  'mass-biology': { effect: 'mass_reveal', target: 'none', category: 'biology' },

  // shuffle_category (target none; a Category or 'choose')
  'shuffle-baggage': { effect: 'shuffle_category', target: 'none', category: 'baggage' },

  // immunity (target self), before_vote
  'immunity-untouchable': { effect: 'immunity', target: 'self' },
  'immunity-diplomatic': { effect: 'immunity', target: 'self' },

  // protect (target other), before_vote
  'protect-bodyguard': { effect: 'protect', target: 'other' },
  'protect-alibi': { effect: 'protect', target: 'other' },
  'protect-human-shield': { effect: 'protect', target: 'other' },

  // double_vote (target self), anytime
  'double-megaphone': { effect: 'double_vote', target: 'self' },
  'double-loud-voice': { effect: 'double_vote', target: 'self' },
  'double-kingmaker': { effect: 'double_vote', target: 'self' },

  // block_vote (target other), before_vote
  'block-gag-order': { effect: 'block_vote', target: 'other' },
  'block-laryngitis': { effect: 'block_vote', target: 'other' },

  // cancel_vote (target none), anytime
  'cancel-blackout': { effect: 'cancel_vote', target: 'none' },
  'cancel-fire-drill': { effect: 'cancel_vote', target: 'none' },

  // capacity_plus (target none), anytime
  'capacity-extra-bunk': { effect: 'capacity_plus', target: 'none' },

  // capacity_minus (target none), before_vote
  'capacity-cave-in': { effect: 'capacity_minus', target: 'none' },

  // bunker_add_feature (target none), anytime
  'feature-secret-door': { effect: 'bunker_add_feature', target: 'none' },
  'feature-old-blueprints': { effect: 'bunker_add_feature', target: 'none' },
  'feature-supply-drop': { effect: 'bunker_add_feature', target: 'none' },
  'feature-maintenance-log': { effect: 'bunker_add_feature', target: 'none' },

  // Never in the random pool: the fixed cards (§11 X1) and the engine's stand-in.
  'airlock': { effect: 'airlock', target: 'other' },
  'revive': { effect: 'revive', target: 'ejected' },
  'fallback-feature': { effect: 'bunker_add_feature', target: 'none' },
});
for (const r of Object.values(SPECIAL_RULES)) Object.freeze(r);

/** Special ids that are never dealt from the random pool. */
export const NOT_IN_POOL = Object.freeze(['airlock', 'revive', 'fallback-feature']);
/** The random pool of specials, in deal order. */
export const SPECIAL_POOL = Object.freeze(Object.keys(EN.specials).filter((id) => !NOT_IN_POOL.includes(id)));

// ---- characteristic cards -------------------------------------------------------------------------------------------

/** Pool ids per category, in deck order (the key order of the English map). Biology is generated, not pooled. */
export const POOL_IDS = Object.freeze(Object.fromEntries(
  Object.entries(POOL_FILE).map(([c, file]) => [c, Object.freeze(Object.keys(EN[file]))]),
));

// {sev}: mild / moderate / severe, by weight.
const SEVERITY = [[0, 40], [1, 35], [2, 25]];

// Professions with their own "(...)" whose numbers bound the age of the Biology card dealt right after them.
const PROFESSION_MIN_AGE = {
  'unemployed-years-without-a-job': (v) => v[0] + 18,
  'homemaker-raised-children': (v) => 20 + v[0],
};

const PHOBIA_INTENSITY_CHANCE = 0.55;

// Biology: sex, age 18–85 skewed to 20–60, orientation, sometimes one extra note. Infertility lives in the Health
// pool, not here.
const ORIENTATIONS = [['hetero', 78], ['gay', 8], ['bi', 9], ['ace', 5]];
const BIO_NOTE_CHANCE = 0.25;
const BIO_NOTES = [
  { id: 'pregnant', w: 3, ok: (female, age) => female && age <= 44 },
  { id: 'twin', w: 1, ok: () => true },
  { id: 'left-handed', w: 1, ok: () => true },
  { id: 'very-tall', w: 1, ok: () => true },
  { id: 'short', w: 1, ok: () => true },
  { id: 'one-child', w: 1, ok: (female, age) => age >= 20 },
  { id: 'children', w: 1.5, ok: (female, age) => age >= 25 },
  { id: 'adopted', w: 0.7, ok: () => true },
  { id: 'strong-build', w: 1, ok: () => true },
];

// ---- catastrophes and bunkers ---------------------------------------------------------------------------------------

// `stay` = [min, max] months until the surface is safe; the bunker drawn after the catastrophe gets a stay inside that
// range, so the two never contradict each other.
export const STAY = Object.freeze({
  'nuclear-winter': [24, 72],
  'the-gray-fever': [12, 36],
  'asteroid-impact': [36, 96],
  'supervolcano': [18, 60],
  'machine-uprising': [24, 72],
  'the-visitors': [12, 48],
  'the-great-flood': [12, 48],
  'solar-superflare': [12, 36],
  'spore-rain': [18, 60],
  'the-yellow-cloud': [6, 24],
  'new-ice-age': [36, 120],
  'gray-goo': [24, 72],
  'the-biting-plague': [12, 48],
  'silent-spring': [24, 60],
  'gamma-ray-burst': [12, 48],
  'the-barren-plague': [12, 36],
  'pole-reversal': [18, 60],
  'scorched-earth': [36, 96],
});
for (const s of Object.values(STAY)) Object.freeze(s);

/** Catastrophe ids in deck order (= the narration clip basenames). */
export const CATASTROPHE_IDS = Object.freeze(Object.keys(EN.catastrophes.list));
/** The feature the engine adds when a "new feature" card finds the dealer failing; never dealt. */
export const FALLBACK_FEATURE_ID = 'hidden-storeroom';
/** Bunker feature ids in deck order. */
export const FEATURE_IDS = Object.freeze(Object.keys(EN.bunker.features).filter((id) => id !== FALLBACK_FEATURE_ID));
const NICKNAME_IDS = Object.freeze(Object.keys(EN.bunker.nicknames));
const LETTER_COUNT = Array.from(EN.bunker.letters).length;

const DEFAULT_STAY = [6, 72];
const FOOD_RATIOS = [0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1.25, 1.5, 2];

// Exact-repeat avoidance only looks at the most recent texts per category (about three games' worth), so it prevents
// duplicates at one table without skewing the long-run mix towards rare combinations.
const RECENT_WINDOW = 48;

// ---- random helpers (all driven by the injected rng) ------------------------------------------------------------

export function makeRandom(rng) {
  const unit = () => {
    const x = Number(rng());
    if (!(x >= 0)) return 0; // NaN or negative
    return x < 1 ? x : 1 - Number.EPSILON;
  };
  const int = (a, b) => a + Math.floor(unit() * (b - a + 1));
  const index = (length) => Math.floor(unit() * length);
  const chance = (p) => unit() < p;
  const weighted = (items, weightOf) => {
    let total = 0;
    for (const it of items) total += weightOf(it);
    let r = unit() * total;
    for (const it of items) {
      r -= weightOf(it);
      if (r < 0) return it;
    }
    return items[items.length - 1];
  };
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(unit() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  return { unit, int, index, chance, weighted, shuffle };
}

// A shuffled deck of indices 0..size-1. Every index is dealt once per cycle; a new cycle starts when the deck runs
// out. `blocked(i)` lets the caller skip indices (used to avoid duplicate bunker features); if every remaining index
// is blocked, a fresh cycle is started, and a repeat is allowed only if even that has no unblocked index.
function makeDeck(size, R) {
  let order = [];
  const refill = () => {
    order = R.shuffle(Array.from({ length: size }, (_, i) => i));
  };
  return {
    draw(blocked) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (order.length === 0) refill();
        for (let i = order.length - 1; i >= 0; i--) {
          if (!blocked || !blocked(order[i])) return order.splice(i, 1)[0];
        }
        refill();
      }
      return order.pop();
    },
  };
}

function deepFreeze(x) {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

/** The values of an English template's placeholders, drawn left to right (the pre-X5 `fill`, minus the text). */
function drawValues(template, R) {
  return drawTemplate(template).params.map((p) => {
    switch (p.type) {
      case 'sev': return R.weighted(SEVERITY, (s) => s[1])[0];
      case 'n':
      case 'yrs': return R.int(p.lo, p.hi);
      default: return R.index(p.options.length);
    }
  });
}

// `ages` (filled in): the age range the Profession's years fit, { min, max }. The dealer hands it to the Biology card
// drawn right after it (the engine deals each player's Profession, then their Biology), so a character is never
// "retired after 30 years" at 23 or a first-year student at 80.
function professionTok(id, R, ages) {
  const base = EN.professions[id];
  ages.min = 18;
  ages.max = 85;
  if (base.includes('(')) {
    const v = drawValues(base, R);
    if (PROFESSION_MIN_AGE[id]) ages.min = PROFESSION_MIN_AGE[id](v);
    return deepFreeze({ c: 'profession', id, v });
  }
  const r = R.unit();
  let mod;
  if (r < 0.60) {
    const n = 1 + Math.floor(Math.pow(R.unit(), 1.4) * 30); // skewed towards fewer years
    mod = { k: 'exp', n };
    ages.min = n + 18;
  } else if (r < 0.69) {
    mod = R.chance(0.3) ? { k: 'intern1' } : { k: 'intern', n: R.int(1, 11) };
  } else if (r < 0.77) {
    const n = R.int(20, 42);
    mod = { k: 'retired', n };
    ages.min = n + 22;
  } else if (r < 0.84) {
    const k = R.int(0, 4);
    mod = { k: 'student', n: k + 1 };
    ages.min = 18 + k;
    ages.max = 40;
  } else if (r < 0.90) {
    const n = R.int(1, 15);
    mod = { k: 'self', n };
    ages.min = n + 14;
  } else if (r < 0.95) {
    const n = R.int(15, 35);
    mod = { k: 'award', n };
    ages.min = n + 20;
  } else if (r < 0.98) {
    const n = R.int(2, 20);
    mod = { k: 'revoked', n };
    ages.min = n + 22;
  } else {
    const n = R.int(1, 10);
    mod = { k: 'fake', n };
    ages.min = n + 20;
  }
  ages.min = Math.max(18, Math.min(85, ages.min));
  return deepFreeze({ c: 'profession', id, v: [], mod });
}

function hobbyTok(id, R) {
  const base = EN.hobbies[id];
  if (base.includes('(')) return deepFreeze({ c: 'hobby', id, v: drawValues(base, R) });
  const r = R.unit();
  let mod;
  if (r < 0.72) mod = { k: 'years', n: R.int(1, 20) };
  else if (r < 0.82) mod = { k: 'childhood' };
  else if (r < 0.92) mod = { k: 'started' };
  else if (r < 0.97) mod = { k: 'semipro', n: R.int(3, 20) };
  else mod = { k: 'obsessed', n: R.int(1, 15) };
  return deepFreeze({ c: 'hobby', id, v: [], mod });
}

function phobiaTok(id, R) {
  const v = drawValues(EN.phobias[id], R);
  if (R.chance(PHOBIA_INTENSITY_CHANCE)) return deepFreeze({ c: 'phobia', id, v, int: R.index(EN.mods.phobiaIntensity.length) });
  return deepFreeze({ c: 'phobia', id, v });
}

// Any pooled category but profession (professionTok) and biology (biologyTok).
function pooledTok(c, id, R) {
  if (c === 'hobby') return hobbyTok(id, R);
  if (c === 'phobia') return phobiaTok(id, R);
  return deepFreeze({ c, id, v: drawValues(EN[POOL_FILE[c]][id], R) });
}

function drawAge(R) {
  const r = R.unit();
  if (r < 0.05) return R.int(18, 19);
  if (r < 0.85) return R.int(20, 60);
  return 61 + Math.floor(Math.pow(R.unit(), 1.5) * 25); // 61..85, mostly the younger end
}

// `ages`: the age range of the Profession dealt just before (see professionTok), or null.
function biologyTok(R, ages = null) {
  const female = R.chance(0.5);
  let age = drawAge(R);
  if (ages) {
    for (let i = 0; i < 30 && (age < ages.min || age > ages.max); i++) age = drawAge(R);
    if (age < ages.min || age > ages.max) age = R.int(ages.min, Math.max(ages.min, ages.max));
  }
  const o = R.weighted(ORIENTATIONS, (x) => x[1])[0];
  const tok = { c: 'biology', sex: female ? 'f' : 'm', age, o };
  if (R.chance(BIO_NOTE_CHANCE)) {
    const note = R.weighted(BIO_NOTES.filter((n) => n.ok(female, age)), (n) => n.w);
    tok.note = { id: note.id, v: drawValues(EN.biology.notes[note.id], R) };
  }
  return deepFreeze(tok);
}

function roundMonths(m) {
  if (m >= 18) return Math.round(m / 6) * 6;
  if (m >= 6) return Math.round(m / 3) * 3;
  return Math.max(1, Math.round(m));
}

function bunkerNameTok(R) {
  const r = R.unit();
  if (r < 0.45) return { k: 'nick', nick: NICKNAME_IDS[R.index(NICKNAME_IDS.length)] };
  if (r < 0.7) return { k: 'shelter', n: R.int(2, 99) };
  const n = R.int(10, 999);
  const letter = R.index(LETTER_COUNT);
  return { k: 'object', n, letter, nick: NICKNAME_IDS[R.index(NICKNAME_IDS.length)] };
}

// ---- the dealer ---------------------------------------------------------------------------------------------------

/**
 * The dealer (SPEC §8 "Content module interface"; design §3.3): the English methods and their Tok twins over one
 * shared state (decks, the repeat check, the Profession's age range for the next Biology card, the last catastrophe's
 * stay, the current bunker's features). `onBase(category, index)` is an optional hook, not part of the public
 * interface, that reports which base card a pooled draw used.
 */
export function buildDealer(rng, onBase) {
  if (typeof rng !== 'function') rng = Math.random;
  const R = makeRandom(rng);
  const decks = {};
  const issued = {};
  for (const c of CATEGORY_IDS) {
    issued[c] = [];
    if (POOL_IDS[c]) decks[c] = makeDeck(POOL_IDS[c].length, R);
  }
  const catastropheDeck = makeDeck(CATASTROPHE_IDS.length, R);
  const featureDeck = makeDeck(FEATURE_IDS.length, R);
  const specialDeck = makeDeck(SPECIAL_POOL.length, R);
  let lastStay = null; // `stay` of the most recently drawn catastrophe
  let bunkerFeatures = new Set(); // feature indices the current bunker already has

  // Generate a card, retrying a few times if this dealer issued exactly the same English text recently.
  function unique(category, generate) {
    const recent = issued[category];
    let tok = generate();
    let text = renderCard('en', tok);
    for (let i = 0; i < 8 && recent.includes(text); i++) {
      tok = generate();
      text = renderCard('en', tok);
    }
    recent.push(text);
    if (recent.length > RECENT_WINDOW) recent.shift();
    return tok;
  }

  function drawFeatureTok() {
    const idx = featureDeck.draw((i) => bunkerFeatures.has(i));
    bunkerFeatures.add(idx);
    const id = FEATURE_IDS[idx];
    return deepFreeze({ id, v: drawValues(EN.bunker.features[id], R) });
  }

  // The age range of the Profession just drawn, for the Biology card drawn right after it (and only then).
  let professionAges = null;

  function drawCardTok(category) {
    const ages = professionAges;
    professionAges = null;
    if (category === 'biology') return unique('biology', () => biologyTok(R, ages));
    if (typeof category !== 'string' || !Object.hasOwn(POOL_IDS, category)) {
      throw new TypeError(`content: unknown category ${String(category)}`);
    }
    const idx = decks[category].draw();
    if (onBase) onBase(category, idx);
    const id = POOL_IDS[category][idx];
    if (category === 'profession') {
      let range = null;
      const tok = unique(category, () => { range = {}; return professionTok(id, R, range); });
      professionAges = range;
      return tok;
    }
    return unique(category, () => pooledTok(category, id, R));
  }

  function drawCatastropheTok() {
    const id = CATASTROPHE_IDS[catastropheDeck.draw()];
    lastStay = STAY[id];
    return deepFreeze({ id, v: EN.catastrophes.list[id].details.map((d) => drawValues(d, R)), stay: [...lastStay] });
  }

  function drawBunkerTok() {
    const [lo, hi] = lastStay || DEFAULT_STAY;
    const stay = Math.min(hi, Math.max(lo, roundMonths(R.int(lo, hi))));
    const food = roundMonths(Math.max(1, stay * FOOD_RATIOS[R.index(FOOD_RATIOS.length)]));
    bunkerFeatures = new Set();
    const count = R.int(3, 5);
    const features = [];
    for (let i = 0; i < count; i++) features.push(drawFeatureTok());
    const name = bunkerNameTok(R);
    const size = R.int(12, 60) * 5;
    return deepFreeze({ name, size, stay, food, features });
  }

  return {
    drawCard(category) {
      return renderCard('en', drawCardTok(category));
    },

    drawSpecial() {
      const id = SPECIAL_POOL[specialDeck.draw()];
      const card = EN.specials[id];
      const rule = SPECIAL_RULES[id];
      const out = { id, title: card.title, text: card.text, effect: rule.effect, target: rule.target };
      if (rule.category) out.category = rule.category;
      return out;
    },

    drawCatastrophe() {
      const { title, text, details } = renderCatastrophe('en', drawCatastropheTok());
      return { title, text, details: [...details] };
    },

    drawBunker() {
      const { name, size, duration, food, features } = renderBunker('en', drawBunkerTok());
      return { name, size, duration, food, features: [...features] };
    },

    drawBunkerFeature() {
      return renderFeature('en', drawFeatureTok());
    },

    // The same draws as language-neutral tokens (design §3.3): the same rng calls in the same order as the English
    // method of the same name, so a dealer may be driven through either, or both, interchangeably.
    drawCardTok,
    drawCatastropheTok,
    drawBunkerTok,
    drawBunkerFeatureTok: drawFeatureTok,
  };
}
