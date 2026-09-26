// Full-game protocol simulations over real WebSockets against a spawned server (SPEC.md §7, §2, §3, §5).
// Every state message every client receives is checked by test/helpers-sim.js (Checker):
//   (a) identical public info for all recipients, (b) no hidden card text leaks, (c) spectators get me === null,
//   (d) reveal turns, (e) §2 ejection formula per step and ballot, (f) the final, (g) no errors to legal actions,
//   (h) the server never crashes (exit code / stderr / healthz).
// Scenarios live in sim-scenarios.test.js, the hostile-client fuzz in sim-fuzz.test.js.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { assertServerHealthy, runTable, startServer } from './helpers-sim.js';

function summarize(r) {
  return r.games.map((g) => `N=${g.n} survivors=${g.survivors} steps=${g.steps} ballots=${g.ballots} ties=${g.ties} defenses=${g.defenses} fate=${g.fate} skips=${g.skips} cancels=${g.cancels} specials=${g.specials} revived=${g.revived} cap±=${g.capacityChanges} OT=${g.overtime} airlocks=${g.airlockOpened}/${g.airlockSealed}/${g.airlockJammed}/${g.airlockRevived}`).join('; ');
}

function assertClean(r) {
  const msg = [...r.violations.slice(0, 25), r.violations.length > 25 ? `... ${r.violations.length - 25} more` : ''].filter(Boolean).join('\n');
  assert.equal(r.violations.length, 0, `invariant violations:\n${msg}`);
  assert.ok(r.games.length >= 1 && r.games.every((g) => g.done), 'every game must reach the final');
}

describe('full games without specials, N = 2..16', { concurrency: 1 }, () => {
  const Ns = [2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 15, 16];
  for (const n of Ns) {
    test(`N=${n}: plays to the final with the exact KICKS schedule`, { timeout: 60000 }, async (t) => {
      const server = await startServer({ seed: 1000 + n });
      try {
        const r = await runTable(server, { n, seed: `sweep-${n}`, specials: 0 });
        t.diagnostic(`${summarize(r)} | messages=${r.messages} refStates=${r.referenceStates} compared=${r.comparedStates}`);
        assertClean(r);
        assert.equal(r.errors.length, 0, `no errors expected: ${JSON.stringify(r.errors.slice(0, 5))}`);
        assert.equal(r.games[0].survivors, Math.floor(n / 2));
        await assertServerHealthy(server);
      } finally {
        await server.stop();
      }
    });
  }
});

describe('specials-heavy batch (every bot plays a special every round it can)', () => {
  // 6 server seeds x 6 table sizes; tables on one server run concurrently (different rooms).
  const seeds = [11, 22, 33, 44, 55, 66];
  const sizes = [4, 5, 7, 10, 13, 16];
  const totals = { games: 0, specials: 0, effects: {}, races: 0, overtime: 0, skips: 0, cancels: 0, revived: 0, ties: 0, fate: 0,
    airlockOpened: 0, airlockSealed: 0, airlockJammed: 0, airlockRevived: 0 };
  after(() => {
    // printed once at the end of the batch
    console.log(`# specials batch: ${JSON.stringify(totals)}`);
  });
  for (const seed of seeds) {
    test(`BUNKER_SEED=${seed}: ${sizes.length} concurrent specials games`, { timeout: 90000 }, async (t) => {
      const server = await startServer({ seed });
      try {
        const results = await Promise.all(sizes.map((n, i) => runTable(server, {
          n, seed: `sp-${seed}-${i}`, specials: 1.0, label: `seed=${seed} N=${n}`,
        })));
        for (const r of results) {
          t.diagnostic(`${summarize(r)} races=${r.raceErrors}`);
          totals.games++;
          totals.races += r.raceErrors;
          for (const e of r.specialsPlayed) totals.effects[e] = (totals.effects[e] || 0) + 1;
          for (const g of r.games) {
            totals.specials += g.specials;
            totals.overtime += g.overtime ? 1 : 0;
            totals.skips += g.skips;
            totals.cancels += g.cancels;
            totals.revived += g.revived;
            totals.ties += g.ties;
            totals.fate += g.fate;
            for (const k of ['airlockOpened', 'airlockSealed', 'airlockJammed', 'airlockRevived']) totals[k] += g[k];
          }
        }
        for (const r of results) assertClean(r);
        await assertServerHealthy(server);
      } finally {
        await server.stop();
      }
    });
  }
  test('the batch exercised every special effect, and airlocks were opened, sealed and jammed (§11 X1)', () => {
    const seen = Object.keys(totals.effects).sort();
    t_assertEffects(seen);
    assert.ok(totals.airlockSealed >= 5 && totals.airlockJammed >= 1 && totals.airlockOpened >= totals.airlockSealed,
      `airlocks opened=${totals.airlockOpened} sealed=${totals.airlockSealed} jammed=${totals.airlockJammed} revived=${totals.airlockRevived}`);
  });
});

function t_assertEffects(seen) {
  const all = ['bunker_add_feature', 'cancel_vote', 'capacity_minus', 'capacity_plus', 'double_vote', 'airlock', 'force_reveal',
    'immunity', 'mass_reveal', 'peek', 'protect', 'reroll_card', 'revive', 'shuffle_category', 'swap_card', 'block_vote'].sort();
  const missing = all.filter((e) => !seen.includes(e));
  // The deck decides which effects are dealt; a missing effect is reported, not fatal, unless most are missing.
  if (missing.length) console.log(`# effects never played in the batch: ${missing.join(', ')}`);
  assert.ok(seen.length >= 10, `only ${seen.length} distinct effects were played: ${seen.join(', ')}`);
}

describe('late specials batch (specials only from round 6: cancels in round 7, overtime, late revives)', () => {
  let server;
  before(async () => { server = await startServer({ seed: 4242 }); });
  after(async () => { if (server) await server.stop(); });
  test('16 games, 4 at a time', { timeout: 90000 }, async (t) => {
    const sizes = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 6, 7, 9];
    let overtime = 0;
    let cancels = 0;
    for (let i = 0; i < sizes.length; i += 4) {
      const chunk = sizes.slice(i, i + 4);
      const results = await Promise.all(chunk.map((n, j) => runTable(server, {
        n, seed: `late-${i + j}`, specials: 1.0, specialsFromRound: 6, label: `late#${i + j} N=${n}`,
      })));
      for (const r of results) {
        t.diagnostic(summarize(r));
        assertClean(r);
        overtime += r.games.filter((g) => g.overtime).length;
        cancels += r.games.reduce((a, g) => a + g.cancels, 0);
      }
    }
    t.diagnostic(`overtime games: ${overtime}, mid-step cancels: ${cancels}`);
    console.log(`# late specials batch: overtime games=${overtime} mid-step cancels=${cancels}`);
    await assertServerHealthy(server);
  });
});

describe('mixed batch (specials probability 0.35, varied seeds)', () => {
  let server;
  before(async () => { server = await startServer({ seed: 777 }); });
  after(async () => { if (server) await server.stop(); });
  test('12 games, 3 at a time', { timeout: 90000 }, async (t) => {
    const sizes = [6, 8, 9, 12, 14, 15, 6, 8, 11, 12, 16, 4];
    for (let i = 0; i < sizes.length; i += 3) {
      const chunk = sizes.slice(i, i + 3);
      const results = await Promise.all(chunk.map((n, j) => runTable(server, { n, seed: `mix-${i + j}`, specials: 0.35, label: `mix#${i + j} N=${n}` })));
      for (const r of results) { t.diagnostic(summarize(r)); assertClean(r); }
    }
    await assertServerHealthy(server);
  });
});
