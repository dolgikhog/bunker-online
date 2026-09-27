// Bunker Online: game content, the façade (SPEC.md §8 "Content module interface"; §11 X5.5; reports/i18n-design.md §3.3,
// §6).
//
// The words live in ./content/en/*.js (English, today's strings verbatim, keyed by stable ids) and ./content/ru/*.js
// (Russian, the same ids); the language-neutral rules and the dealer in ./content/gen.js; rendering in
// ./content/render.js. This module keeps the pre-X5 interface unchanged: CATEGORIES, createDealer, AIRLOCK_CARD,
// REVIVE_CARD and FIXED_EFFECTS, with every string in English and every seed dealing exactly what it dealt before
// (test/i18n-golden-content.test.js). X5 adds the dealer's Tok methods, the renderers, the category forms, and the
// engine's stand-ins as tokens.
// Every random choice goes through the injected `rng`, so a seeded rng gives a fully deterministic dealer.

import { CATEGORY_IDS, SPECIAL_RULES, FALLBACK_FEATURE_ID, buildDealer } from './content/gen.js';
import {
  TABLES, renderCard, renderSpecial, renderCatastrophe, renderBunker, renderBunkerName, renderFeature, categoryLabel,
  categoryForms,
} from './content/render.js';

const EN = TABLES.en;

/** The eight categories in display order, with their English labels. */
export const CATEGORIES = CATEGORY_IDS.map((id) => ({ id, label: EN.labels[id] }));

/** A catalogue special as the engine takes it: {id, title, text, effect, target} (English). */
function special(id) {
  const { title, text } = EN.specials[id];
  const { effect, target } = SPECIAL_RULES[id];
  return Object.freeze({ id, title, effect, target, text });
}

// The two fixed cards (SPEC §11 X1). They are never in the random pool: the engine deals AIRLOCKS(N) Airlocks to
// different players and REVIVES(N) of these revives to players who hold no Airlock, in every game of 4+ players.
// An Airlock needs a partner: the first one played on a player opens the airlock on them, a second one played on the
// same player by someone else in the same round (before the vote) throws them out; alone it jams when the discussion ends.
export const AIRLOCK_CARD = special('airlock');
export const REVIVE_CARD = special('revive');
/** The engine's stand-in when the dealer offers no usable special ("Hidden room"): catalogue id 'fallback-feature'. */
export const FALLBACK_SPECIAL = special('fallback-feature');
/** Effects the random pool never deals (§11 X1): the fixed cards, and the retired one-player Airlock. */
export const FIXED_EFFECTS = Object.freeze(['airlock', 'revive', 'eject']);

/**
 * The dealer (design §3.3). English methods, as before X5:
 *   drawCard(category) -> string                 drawSpecial() -> {id, title, text, effect, target, category?}
 *   drawCatastrophe() -> {title, text, details}  drawBunker() -> {name, size, duration, food, features}
 *   drawBunkerFeature() -> string
 * and their language-neutral twins, which return deep-frozen tokens (./content/render.js lists the shapes):
 *   drawCardTok(category) -> CardTok             drawCatastropheTok() -> CatTok
 *   drawBunkerTok() -> BunkerTok                 drawBunkerFeatureTok() -> FeatureTok
 * Each English method is renderX('en', <its Tok twin>()): the twins make exactly the same rng calls, share the same
 * state (decks, repeat check, the Profession's age range for the next Biology card, the last catastrophe's stay, the
 * current bunker's features), and may be mixed freely with the English methods.
 */
export function createDealer(rng = Math.random) {
  return buildDealer(rng);
}

/**
 * Renderers (design §6.5). Each takes (lang, token); an unknown language renders English; a missing translation
 * falls back to English entry by entry (warning once per file); results are cached per token and language, so keep
 * tokens immutable (a swap or reroll replaces the token, never edits it).
 *   renderCard(lang, CardTok) -> string
 *   renderSpecial(lang, ref) -> {title, text} (frozen), or null for an id the catalogue lacks
 *   renderCatastrophe(lang, CatTok) -> {id, title, text, details} (frozen; id = content id = clip basename, or null),
 *                                      or null for null
 *   renderBunker(lang, BunkerTok) -> {name, size, duration, food, features} (frozen), or null for null
 *   renderBunkerName(lang, NameTok) -> string       renderFeature(lang, FeatureTok) -> string
 *   categoryLabel(lang, id) -> string | null        categoryForms(lang, id) -> {label, nom, acc, gen, dat, ins, loc} | null
 * Every renderer takes a literal token {lit: …} (a hand-made dealer's text) and renders it as is in every language.
 */
export {
  renderCard, renderSpecial, renderCatastrophe, renderBunker, renderBunkerName, renderFeature, categoryLabel,
  categoryForms,
};

// The engine's stand-ins as tokens (design §3.4), so they render in every language.
/** A feature card's stand-in when the dealer fails: EN "A hidden storeroom" (never dealt). */
export const FALLBACK_FEATURE_TOK = Object.freeze({ id: FALLBACK_FEATURE_ID, v: Object.freeze([]) });
/** The catastrophe's stand-in when the dealer fails: EN title "Catastrophe", no text, no details; id null. */
export const FALLBACK_CATASTROPHE_TOK = Object.freeze({ id: null, fallback: true });
/** The bunker name's stand-in when the dealer fails: EN "The bunker". */
export const FALLBACK_BUNKER_NAME_TOK = Object.freeze({ k: 'fallback' });
/** The whole bunker's stand-in when the dealer fails: the fallback name and nothing else (size, stay, food: ''). */
export const FALLBACK_BUNKER_TOK = Object.freeze({ name: FALLBACK_BUNKER_NAME_TOK, features: Object.freeze([]) });

/** A literal token for a hand-made dealer's string: renders as `text` in every language. */
export function litTok(text) {
  return Object.freeze({ lit: typeof text === 'string' ? text : text == null ? '' : String(text) });
}

/**
 * A new bunker token: `bunkerTok` with `featureTok` added at the end (tokens are frozen; the cache is per token, so a
 * new feature means a new bunker token).
 */
export function bunkerWithFeature(bunkerTok, featureTok) {
  const b = bunkerTok !== null && typeof bunkerTok === 'object' ? bunkerTok : FALLBACK_BUNKER_TOK;
  const features = Array.isArray(b.features) ? b.features : [];
  return Object.freeze({ ...b, features: Object.freeze([...features, featureTok]) });
}
