// Small seeded PRNG helpers (SPEC.md §8: BUNKER_SEED). Never used for tokens — those come from node:crypto.

/** mulberry32: a fast 32-bit seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turns any seed string ("42", "hello") into a 32-bit integer (FNV-1a). */
export function seedFromString(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A child rng derived from a parent rng, so each room's game stays deterministic on its own. */
export function deriveRng(parent) {
  return mulberry32(Math.floor(parent() * 4294967296) >>> 0);
}
