// Extracts every catastrophe card from server/content.js through its public interface
// (createDealer(rng).drawCatastrophe()), without editing or copying the source.
//
// Randomised numbers ({n:a-b} in the templates) are recovered as ranges by dealing the whole deck
// twice: once with rng() === 0 (every roll = minimum) and once with rng() -> 1 (every roll = maximum),
// then diffing the two renderings of each card. A number that differs becomes "{lo-hi}".
//
// Usage: node tools/voice/extract.mjs [path/to/content.js]   -> JSON array on stdout
// (default: server/content.js of this repository). make_voice.py runs it.
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const src = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../../server/content.js', import.meta.url));
const { createDealer } = await import(pathToFileURL(src).href);

function dealAll(rngValue) {
  const dealer = createDealer(() => rngValue);
  const seen = new Map();
  // The catastrophe deck is drawn without replacement and reshuffled when empty, so after
  // enough draws every card has appeared. Stop once a full extra cycle adds nothing new.
  let stale = 0;
  for (let i = 0; i < 2000 && stale < 200; i++) {
    const c = dealer.drawCatastrophe();
    if (seen.has(c.title)) stale++;
    else { seen.set(c.title, c); stale = 0; }
  }
  return seen;
}

// Also deal with Math.random to catch any card the constant rngs could never reach.
function dealRandom() {
  const dealer = createDealer(Math.random);
  const seen = new Map();
  for (let i = 0; i < 3000; i++) {
    const c = dealer.drawCatastrophe();
    if (!seen.has(c.title)) seen.set(c.title, c);
  }
  return seen;
}

const lo = dealAll(0);
const hi = dealAll(1 - 1e-12);
const rnd = dealRandom();
for (const t of rnd.keys()) {
  if (!lo.has(t) || !hi.has(t)) {
    console.error(`extract: card "${t}" only reachable with Math.random`);
    process.exit(2);
  }
}

// Merge two renderings of the same template: numeric tokens that differ -> "{lo-hi}".
function merge(a, b) {
  const re = /\d+(?:\.\d+)?/g;
  const ta = a.split(re), tb = b.split(re);
  const na = a.match(re) || [], nb = b.match(re) || [];
  if (ta.length !== tb.length || ta.some((s, i) => s !== tb[i])) {
    // Non-numeric difference (e.g. a {a|b} pick) - keep both variants visible.
    return { text: a, alt: b, varies: true };
  }
  let out = ta[0];
  for (let i = 0; i < na.length; i++) {
    out += na[i] === nb[i] ? na[i] : `{${na[i]}-${nb[i]}}`;
    out += ta[i + 1];
  }
  return { text: out, varies: false };
}

const cards = [];
for (const [title, a] of lo) {
  const b = hi.get(title);
  const t = merge(a.text, b.text);
  const details = a.details.map((d, i) => merge(d, b.details[i]));
  cards.push({
    title,
    text: t.text,
    details: details.map((d) => d.text),
    detailAlternatives: details.filter((d) => d.varies).map((d) => [d.text, d.alt]),
  });
}
process.stdout.write(JSON.stringify(cards, null, 2) + '\n');
