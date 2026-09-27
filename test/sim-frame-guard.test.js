// SPEC §11 X5.2, the frame guard over real WebSockets (reports/fix-server-fixer-i2.md): a full table with real names
// (botlib realNames, 15-20 letters; Cyrillic ones are 2 bytes a letter), half of it in Russian, 40 spectators (a bigger
// head), specials whenever a bot can, two games (Play again). The Checker runs `neutral`, and checks every state's log
// window: the newest lines with no gap, the whole window unless the frame is at 120 KB (then the line just before it
// would not have fit), the newest 20 with their parts (§7 schema). Here, besides a clean run: the guard really fired
// (some frames left the oldest lines off), and no client received a state over 120 KB.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assertServerHealthy, runTable, startServer, Bot, FRAME_BUDGET } from './helpers-sim.js';
import { realNames } from '../tools/botlib.js';

describe('§11 X5.2 the frame guard over real sockets', { concurrency: 1 }, () => {
  test('16 bots with real names (en/ru) + 40 spectators, specials, Play again: clean, the guard fires, no state over 120 KB', { timeout: 180000 }, async (t) => {
    const server = await startServer({ seed: 'frame-guard' });
    const names = { ru: realNames('ru', 56), en: realNames('en', 56) };
    const lang = (i) => (i % 2 ? 'ru' : 'en');
    const seen = { states: 0, maxBytes: 0, shortened: 0, shortest: Infinity };
    const watch = (b) => b.on('message', (msg, meta) => {
      if (!msg || msg.t !== 'state') return;
      seen.states++;
      seen.maxBytes = Math.max(seen.maxBytes, meta.bytes);
      const last = msg.log.length ? msg.log.at(-1).id : 0;
      if (msg.log.length < Math.min(200, last)) { seen.shortened++; seen.shortest = Math.min(seen.shortest, msg.log.length); }
    });
    try {
      const r = await runTable(server, {
        n: 16, seed: 'frame-guard-sim', specials: 1, games: 2, label: 'frame guard', timeoutMs: 120000, stallMs: 10000,
        names: (i) => names[lang(i)][i], langs: lang, watcherLang: 'ru',
        scenario: async (ctx) => {
          for (const b of [...ctx.bots, ctx.watcher, ...ctx.watchers]) watch(b);
          for (let i = 0; i < 40; i++) {
            const l = lang(i);
            const b = ctx.addClient(new Bot({ url: server.url, name: names[l][16 + i], autoplay: false, lang: l }));
            watch(b);
            await b.join(ctx.room, { spectator: true });
          }
        },
      });
      t.diagnostic(`games ${r.games.map((g) => `${g.survivors}/${g.n}`).join(',')} messages ${r.messages} compared ${r.comparedStates} ${JSON.stringify(seen)}`);
      const msg = [...r.violations.slice(0, 25), r.violations.length > 25 ? `... ${r.violations.length - 25} more` : ''].filter(Boolean).join('\n');
      assert.equal(r.violations.length, 0, `invariant violations:\n${msg}`);
      assert.ok(r.games.length === 2 && r.games.every((g) => g.done), 'both games reach the final');
      assert.ok(seen.shortened > 0, `the frame guard never fired: ${JSON.stringify(seen)}`);
      assert.ok(seen.maxBytes <= FRAME_BUDGET && seen.maxBytes > FRAME_BUDGET - 4096, JSON.stringify(seen));
      await assertServerHealthy(server);
    } finally {
      await server.stop();
    }
  });
});
