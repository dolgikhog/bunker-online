// SPEC §11 X5, reports/i18n-design.md §11.3 — mixed-language tables over real WebSockets (i18n-server, A2).
// runTable (test/helpers-sim.js) with half of the bots joining in Russian, one bot switching its language with setLang
// every 5 actions, a seated bot and a spectator per language (the reference watcher in English, a second watcher in
// Russian), specials, End game allowed. The Checker runs `neutral`: public states are compared without their words
// (log entries by key and params), every entry is checked once per client and must never change, and the leak scan
// pairs each owner's hand with a reference stream in the same language, over the log's text, parts and params.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertServerHealthy, runTable, startServer } from './helpers-sim.js';

function assertClean(r) {
  const msg = [...r.violations.slice(0, 25), r.violations.length > 25 ? `... ${r.violations.length - 25} more` : ''].filter(Boolean).join('\n');
  assert.equal(r.violations.length, 0, `invariant violations:\n${msg}`);
  assert.ok(r.games.length >= 1 && r.games.every((g) => g.done || g.endedByHost), 'every game ends');
}

describe('§11 X5 mixed-language tables', { concurrency: 1 }, () => {
  const tables = [
    { n: 8, specials: 0.5, games: 2, endGame: 0.3 },
    { n: 6, specials: 1, games: 2, endGame: 0 },
    { n: 12, specials: 0.35, games: 1, endGame: 0.2 },
    { n: 4, specials: 1, games: 3, endGame: 0.3 },
  ];
  for (const [i, cfg] of tables.entries()) {
    test(`N=${cfg.n}, specials ${cfg.specials}: half the bots in Russian, one switching every 5 actions`, { timeout: 90000 }, async (t) => {
      const server = await startServer({ seed: `i18n-${i}` });
      try {
        const r = await runTable(server, {
          ...cfg, seed: `i18n-sim-${i}`, label: `i18n N=${cfg.n}`,
          langs: (j) => (j % 2 ? 'ru' : 'en'), toggleLang: { bot: 1, every: 5 },
        });
        const s = r.leakStats;
        t.diagnostic(`games ${r.games.map((g) => (g.endedByHost ? `ended@${g.endedIn.phase}` : `${g.survivors}/${g.n}`)).join(',')} messages ${r.messages} compared ${r.comparedStates} leak streams ${JSON.stringify(s.streams)}`);
        assertClean(r);
        // the leak scan really walked a stream per language and checked cards in both
        assert.deepEqual(s.streams.map((x) => x.lang).sort(), ['en', 'ru']);
        for (const x of s.streams) assert.ok(x.slots > 0 && x.scanned > 0, `the ${x.lang} stream checked nothing: ${JSON.stringify(x)}`);
        assert.ok(r.comparedStates > 100);
        await assertServerHealthy(server);
      } finally {
        await server.stop();
      }
    });
  }
});
