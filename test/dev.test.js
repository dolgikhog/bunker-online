// SPEC §11 X9 dev mode, server side (server/dev.js, the dev paths of server/index.js and server/rooms.js).
//   - production (no BUNKER_DEV): /dev, /devinfo and every public/dev.* file are the plain 404, every {t:'dev'} is
//     not_allowed (joined or not, player or spectator, well-formed or not) and changes nothing, `create` ignores `seed`
//     (the deal follows BUNKER_SEED alone), no state carries `god`, frames stay DENY, and server/dev.js and
//     tools/botlib.js are never even loaded;
//   - the switch: only BUNKER_DEV=1, the banner, the refusal next to BUNKER_TRUST_PROXY=1 or NODE_ENV=production;
//   - the ops on the engine: giveSpecial (slots, top-up, every effect, eject refused, the Airlock pair ejecting),
//     autoReveal, skipToVote (lands on a ballot from every phase; cancelled votes, airlocks, overtime, defense; a random
//     sweep proving every running game has a vote ahead), forceTie (double votes, immune, ejected, duplicates, revote,
//     infeasible; planTie against brute force), fastTimers, the god view, validation;
//   - the ops over the wire: codes in §7 order, '[dev] …' log lines, seeds reproducing deals, the god view on one
//     socket only, the X9.6 smoke (Airlocks given to two players seal on a third, skipToVote, forceTie, god), and the
//     in-process bots (seated in the lobby, clamped at 16, spectators in a game, kicked, leaving with the last human or
//     after the idle time, a full game to the final with a strict schema on every state);
//   - test/stateview-schema.js: `god` only with {dev: true}.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { DEV_BANNER, DEV_REFUSED, isDevPath, startServer } from '../server/index.js';
import { CATEGORY_IDS, EFFECTS, createGame } from '../server/game.js';
import { AIRLOCK_CARD } from '../server/content.js';
import { mulberry32 } from '../server/rng.js';
import { DEV_OPS, DEV_TEXT, createDevOps, godView, parseSeed, planTie, validateDevMessage } from '../server/dev.js';
import { validateServerMessage, validateStateView } from './stateview-schema.js';
import { Bot, ROOT, startServer as spawnServer } from './helpers-sim.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ok(res) { assert.deepEqual(res, { ok: true }, JSON.stringify(res)); }
function err(res, code, re) {
  assert.equal(res.ok, false, `expected ${code}, got ok`);
  assert.equal(res.code, code, `expected ${code}, got ${res.code}: ${res.message}`);
  assert.ok(typeof res.message === 'string' && res.message.length > 0);
  if (re) assert.match(res.message, re);
}

// ------------------------------------------------------------------------------------------------ engine helpers
function mk(n, { seed = 7, start = true } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const g = createGame({ room: 'DEVT', rng: mulberry32(seed), now: () => clock.t, minPlayers: 2 });
  const ids = [];
  for (let i = 1; i <= n; i++) ids.push(g.join(`P${i}`).id);
  if (start) ok(g.handle(ids[0], { t: 'start' }));
  const ops = createDevOps();
  const dev = (op, extra = {}, by = ids[0]) => ops.run(g, by, { t: 'dev', op, ...extra });
  return { g, ids, clock, ops, dev };
}
const P = (g, id) => g.players.find((p) => p.id === id);
const unusedOf = (g, id, effect) => P(g, id).specials.find((s) => s.effect === effect && !s.used);
const play = (g, id, effect, extra = {}) => g.handle(id, { t: 'special', uid: unusedOf(g, id, effect).uid, ...extra });
const next = (g) => ok(g.handle(g.hostId, { t: 'next' }));
function advanceTo(g, round, phase) {
  for (let guard = 0; !(g.round === round && g.phase === phase); guard++) {
    assert.ok(guard < 3000, `stuck at ${g.round}/${g.phase}`);
    assert.notEqual(g.phase, 'final', `the game ended before round ${round} ${phase}`);
    if (g.phase === 'vote') {
      for (const v of [...g.vote.voters]) if (g.phase === 'vote' && g.vote && g.vote.voters.includes(v) && !g.vote.votes.has(v)) g.handle(v, { t: 'vote', targetId: g.vote.candidates.find((c) => c !== v) });
      if (g.phase === 'vote') next(g);
    } else next(g);
  }
}
const recipients = (g) => [...g.players.filter((p) => p.status !== 'left').map((p) => p.id), ...g.spectators.map((s) => s.id)];
/** Every recipient's view passes the strict schema for a dev server (and a god view built from the engine too). */
function checkViews(g, what = '') {
  for (const id of recipients(g)) {
    const v = g.view(id);
    const problems = validateStateView({ ...v, god: godView(g) }, { dev: true });
    assert.deepEqual(problems, [], `${what} view of ${id}: ${problems.join('; ')}`);
  }
}
const lastLog = (g) => g.log[g.log.length - 1].text;
const devLines = (log) => log.filter((e) => e.text.startsWith('[dev] '));

// ------------------------------------------------------------------------------------------------ validation
describe('§11 X9 dev op validation (bad_request) and the seed', () => {
  test('the ops are the seven of the SPEC; unknown ops, missing or mistyped fields and out-of-range values are bad_request', () => {
    assert.deepEqual([...DEV_OPS], ['giveSpecial', 'autoReveal', 'skipToVote', 'forceTie', 'god', 'fastTimers', 'addBots']);
    const good = [
      { op: 'giveSpecial', playerId: 'p1', effect: 'airlock' }, { op: 'giveSpecial', playerId: 'p1', effect: 'eject' },
      { op: 'autoReveal' }, { op: 'skipToVote' }, { op: 'forceTie', ids: ['p1', 'p2'] }, { op: 'god', on: true }, { op: 'god', on: false },
      { op: 'fastTimers' }, { op: 'addBots', count: 1 }, { op: 'addBots', count: 15, specials: 0.5 }, { op: 'addBots', count: 3, specials: null },
      { op: 'skipToVote', extra: 1, at: 'ignored' },
    ];
    for (const m of good) assert.equal(validateDevMessage({ t: 'dev', ...m }), null, JSON.stringify(m));
    for (const e of Object.keys(EFFECTS)) assert.equal(validateDevMessage({ t: 'dev', op: 'giveSpecial', playerId: 'p1', effect: e }), null, e);
    const bad = [
      null, [], 'x', { t: 'dev' }, { t: 'dev', op: 1 }, { t: 'dev', op: 'nope' }, { t: 'dev', op: '__proto__' }, { t: 'dev', op: 'toString' },
      { t: 'dev', op: 'giveSpecial', effect: 'airlock' }, { t: 'dev', op: 'giveSpecial', playerId: 'p1' },
      { t: 'dev', op: 'giveSpecial', playerId: 'p1', effect: 'nope' }, { t: 'dev', op: 'giveSpecial', playerId: '', effect: 'peek' },
      { t: 'dev', op: 'giveSpecial', playerId: 5, effect: 'peek' },
      { t: 'dev', op: 'forceTie' }, { t: 'dev', op: 'forceTie', ids: ['p1'] }, { t: 'dev', op: 'forceTie', ids: 'p1,p2' },
      { t: 'dev', op: 'forceTie', ids: ['p1', 2] }, { t: 'dev', op: 'forceTie', ids: Array.from({ length: 17 }, (_, i) => `p${i}`) },
      { t: 'dev', op: 'god' }, { t: 'dev', op: 'god', on: 'yes' }, { t: 'dev', op: 'god', on: 1 },
      { t: 'dev', op: 'addBots' }, { t: 'dev', op: 'addBots', count: 0 }, { t: 'dev', op: 'addBots', count: 16 },
      { t: 'dev', op: 'addBots', count: 1.5 }, { t: 'dev', op: 'addBots', count: '3' }, { t: 'dev', op: 'addBots', count: 2, specials: 2 },
      { t: 'dev', op: 'addBots', count: 2, specials: '0.5' },
    ];
    for (const m of bad) err(validateDevMessage(m), 'bad_request', null);
  });

  test('parseSeed: 1–64 characters (trimmed) or a safe integer; absent, null or blank means none; anything else is bad_request', () => {
    assert.deepEqual(parseSeed(undefined), { ok: true, seed: null });
    assert.deepEqual(parseSeed(null), { ok: true, seed: null });
    assert.deepEqual(parseSeed('  '), { ok: true, seed: null });
    assert.deepEqual(parseSeed(' 42 '), { ok: true, seed: '42' });
    assert.deepEqual(parseSeed(42), { ok: true, seed: '42' });
    assert.deepEqual(parseSeed(-3), { ok: true, seed: '-3' });
    assert.deepEqual(parseSeed('x'.repeat(64)), { ok: true, seed: 'x'.repeat(64) });
    for (const v of ['x'.repeat(65), 1.5, NaN, Infinity, 2 ** 60, {}, [], true]) {
      const r = parseSeed(v);
      assert.equal(r.ok, false, String(v));
      err(r.fail, 'bad_request', /seed/);
    }
  });
});

// ------------------------------------------------------------------------------------------------ giveSpecial
describe('§11 X9 giveSpecial', () => {
  test('refused in the lobby and the final (wrong_phase), for unknown and left players, and for the retired eject', () => {
    const lobby = mk(4, { start: false });
    err(lobby.dev('giveSpecial', { playerId: lobby.ids[1], effect: 'peek' }), 'wrong_phase', /no game/);
    const t = mk(4);
    err(t.dev('giveSpecial', { playerId: 'p99', effect: 'peek' }), 'not_allowed', /no such/);
    err(t.dev('giveSpecial', { playerId: t.ids[1], effect: 'eject' }), 'not_allowed', /retired/);
    ok(t.g.handle(t.ids[3], { t: 'leave' }));
    err(t.dev('giveSpecial', { playerId: t.ids[3], effect: 'peek' }), 'not_allowed', /left/);
    const before = JSON.stringify(t.g.view(t.ids[0]));
    err(t.dev('giveSpecial', { playerId: t.ids[1], effect: 'eject' }), 'not_allowed');
    assert.equal(JSON.stringify(t.g.view(t.ids[0])), before, 'a refused op changes nothing');
    t.g.phase = 'final'; // (the op only looks at the phase)
    err(t.dev('giveSpecial', { playerId: t.ids[1], effect: 'peek' }), 'wrong_phase', /over/);
  });

  test('replaces an unused card (one of that effect first, then one dev mode did not give), keeps 2 unused cards, logs it', () => {
    const { g, ids, dev, ops } = mk(5);
    const p = P(g, ids[1]);
    const [a, b] = p.specials;
    ok(dev('giveSpecial', { playerId: ids[1], effect: 'capacity_plus' }));
    assert.equal(p.specials.length, 2);
    const given = p.specials.find((s) => s.effect === 'capacity_plus' && ops.wasGiven(s));
    assert.ok(given, 'the card of that effect is in the hand');
    assert.equal(lastLog(g), `[dev] P1 gave P2 the special “${given.title}”`);
    assert.equal(g.log[g.log.length - 1].kind, 'info');
    const kept = p.specials.find((s) => s !== given);
    assert.ok(kept === a || kept === b, 'the other card is kept as it was');
    // a second card of another effect goes into the other slot: both given cards are held
    ok(dev('giveSpecial', { playerId: ids[1], effect: 'revive' }));
    assert.deepEqual(p.specials.map((s) => s.effect).sort(), ['capacity_plus', 'revive']);
    // the same effect again replaces the card of that effect (not the other given one)
    const reviveUid = unusedOf(g, ids[1], 'revive').uid;
    ok(dev('giveSpecial', { playerId: ids[1], effect: 'revive' }));
    assert.deepEqual(p.specials.map((s) => s.effect).sort(), ['capacity_plus', 'revive']);
    assert.notEqual(unusedOf(g, ids[1], 'revive').uid, reviveUid, 'a fresh card (new uid)');
    // a third effect replaces the oldest dev card (capacity_plus)
    ok(dev('giveSpecial', { playerId: ids[1], effect: 'peek' }));
    assert.deepEqual(p.specials.map((s) => s.effect).sort(), ['peek', 'revive']);
    const uids = p.specials.map((s) => s.uid);
    assert.equal(new Set(uids).size, 2);
    checkViews(g, 'after gives');
  });

  test('a player with used cards is topped up to 2 unused ones; used cards stay, as in playedSpecials: a valid dev view only', () => {
    const { g, ids, dev } = mk(5);
    const p = P(g, ids[2]);
    const consistent = () => {
      assert.equal(p.specials.filter((x) => x.used).length, p.playedSpecials.length);
      assert.equal(p.specials.filter((x) => !x.used).length, 2);
      assert.equal(new Set(p.specials.map((x) => x.uid)).size, p.specials.length);
    };
    advanceTo(g, 2, 'reveal');
    ok(dev('giveSpecial', { playerId: ids[2], effect: 'bunker_add_feature' }));
    ok(play(g, ids[2], 'bunker_add_feature'));
    ok(dev('giveSpecial', { playerId: ids[2], effect: 'capacity_plus' }));
    assert.equal(p.specials.length, 3, 'one used, the given card, one drawn');
    assert.ok(unusedOf(g, ids[2], 'capacity_plus'));
    consistent();
    checkViews(g, '3 cards');
    assert.ok(validateStateView(g.view(ids[2])).some((x) => /me\.specials must have 2 cards/.test(x)), 'a normal server never shows 3 cards');
    for (let r = 3; r <= 7; r++) {
      advanceTo(g, r, 'reveal');
      ok(dev('giveSpecial', { playerId: ids[2], effect: 'bunker_add_feature' }));
      consistent();
      ok(play(g, ids[2], 'bunker_add_feature'));
      checkViews(g, `round ${r}`);
    }
    ok(dev('giveSpecial', { playerId: ids[2], effect: 'peek' }));
    consistent();
    assert.equal(p.specials.length, 8, '6 played (rounds 2-7) and 2 unused');
    assert.equal(g.view(ids[0]).players[2].specialsLeft, 2);
    checkViews(g, 'a hand of 8');
  });

  test('every §5/X1 effect but eject can be given; the card is the content\'s (the fixed Airlock for airlock), and playable', () => {
    for (const effect of Object.keys(EFFECTS).filter((e) => e !== 'eject')) {
      const { g, ids, dev } = mk(4, { seed: 3 });
      advanceTo(g, 2, 'reveal');
      ok(dev('giveSpecial', { playerId: ids[1], effect }));
      const c = unusedOf(g, ids[1], effect);
      assert.ok(c, effect);
      assert.equal(c.timing, EFFECTS[effect].timing, effect);
      assert.equal(c.minRound, EFFECTS[effect].minRound ?? 1, effect);
      assert.ok(EFFECTS[effect].targets.includes(c.target), effect);
      assert.ok(!c.title.startsWith('Test card'), `${effect}: a real content card, not the fallback`);
      if (effect === 'airlock') assert.equal(c.title, AIRLOCK_CARD.title);
      checkViews(g, effect);
    }
  });

  test('Airlocks given to two players, both played on a third in round 2: the third is thrown out, no vote (X1 as dealt)', () => {
    const { g, ids, dev } = mk(5, { seed: 11 });
    advanceTo(g, 2, 'reveal');
    ok(dev('giveSpecial', { playerId: ids[0], effect: 'airlock' }));
    ok(dev('giveSpecial', { playerId: ids[1], effect: 'airlock' }));
    ok(play(g, ids[0], 'airlock', { targetId: ids[2] }));
    assert.deepEqual(g.view(ids[3]).airlocks, [{ targetId: ids[2], byIds: [ids[0]], round: 2 }]);
    ok(play(g, ids[1], 'airlock', { targetId: ids[2] }));
    assert.equal(P(g, ids[2]).status, 'ejected');
    assert.deepEqual(g.view(ids[3]).airlocks, []);
    assert.equal(lastLog(g), '🚪 P2 sealed the airlock with P1 — P3 is thrown out of the bunker, no vote!');
    checkViews(g, 'after the seal');
  });
});

// ------------------------------------------------------------------------------------------------ autoReveal
describe('§11 X9 autoReveal', () => {
  test('only in a reveal phase', () => {
    const lobby = mk(4, { start: false });
    err(lobby.dev('autoReveal'), 'wrong_phase', /reveal phase/);
    const { g, dev } = mk(4);
    advanceTo(g, 1, 'discussion');
    err(dev('autoReveal'), 'wrong_phase');
    advanceTo(g, 6, 'vote');
    err(dev('autoReveal'), 'wrong_phase');
  });

  test('round 1: everyone reveals their Profession automatically, then the discussion starts; the dev line comes first', () => {
    const { g, ids, dev } = mk(6);
    const logFrom = g.log.length;
    ok(dev('autoReveal', {}, ids[3]));
    assert.equal(g.phase, 'discussion');
    assert.equal(g.round, 1);
    for (const id of ids) assert.deepEqual(CATEGORY_IDS.filter((c) => P(g, id).cards[c].revealed), ['profession'], id);
    const lines = g.log.slice(logFrom).map((e) => e.text);
    assert.equal(lines[0], '[dev] P4 auto-revealed the rest of the reveal phase (Round 1)');
    assert.equal(lines.filter((l) => l.endsWith('(revealed automatically)')).length, 6);
    checkViews(g);
  });

  test('mid-phase: speakers who already revealed are not revealed again, everyone else reveals exactly one card', () => {
    const { g, ids, dev } = mk(5);
    advanceTo(g, 2, 'reveal');
    const first = g.turn.order[0];
    const second = g.turn.order[1];
    ok(g.handle(first, { t: 'reveal', category: 'hobby' }));
    ok(g.handle(first, { t: 'endTurn' }));
    ok(g.handle(second, { t: 'reveal', category: 'phobia' })); // revealed, turn not ended
    ok(dev('autoReveal'));
    assert.equal(g.phase, 'discussion');
    for (const id of ids) assert.equal(CATEGORY_IDS.filter((c) => P(g, id).cards[c].revealed).length, 2, id);
    assert.ok(P(g, second).cards.phobia.revealed);
  });
});

// ------------------------------------------------------------------------------------------------ skipToVote
describe('§11 X9 skipToVote', () => {
  test('refused in the lobby, in the final and while a ballot is open (wrong_phase)', () => {
    const lobby = mk(4, { start: false });
    err(lobby.dev('skipToVote'), 'wrong_phase', /no game/);
    const { g, dev } = mk(4);
    ok(dev('skipToVote'));
    assert.equal(g.phase, 'vote');
    const before = JSON.stringify(g.view(g.hostId));
    err(dev('skipToVote'), 'wrong_phase', /already open/);
    assert.equal(JSON.stringify(g.view(g.hostId)), before);
    g.phase = 'final';
    err(dev('skipToVote'), 'wrong_phase', /over/);
  });

  test('4 players from round 1: every reveal and discussion is played, and it stops on round 6\'s ballot (the first with a kick)', () => {
    const { g, ids, dev } = mk(4);
    const logFrom = g.log.length;
    ok(dev('skipToVote'));
    assert.equal(g.phase, 'vote');
    assert.equal(g.round, 6);
    assert.equal(g.vote.stage, 'main');
    assert.equal(g.step.ballot, 1);
    for (const id of ids) assert.equal(P(g, id).cards && CATEGORY_IDS.filter((c) => P(g, id).cards[c].revealed).length, 6, id);
    assert.equal(g.log[logFrom].text, '[dev] P1 skipped ahead to the next vote');
    const lines = g.log.slice(logFrom).map((e) => e.text);
    for (let r = 1; r <= 5; r++) assert.ok(lines.includes(`Round ${r} — discussion — no vote this round`), `round ${r}`);
    checkViews(g);
  });

  test('16 players: round 1 has no vote, round 2 has; from a discussion with a kick it goes straight to that vote', () => {
    const a = mk(16);
    ok(a.dev('skipToVote'));
    assert.deepEqual([a.g.phase, a.g.round], ['vote', 2]);
    const b = mk(6);
    advanceTo(b.g, 5, 'discussion');
    ok(b.dev('skipToVote'));
    assert.deepEqual([b.g.phase, b.g.round], ['vote', 5]);
  });

  test('open airlocks jam as usual, and a vote skipped by Cancel vote does not count: it lands on the next real ballot', () => {
    const { g, ids, dev } = mk(4, { seed: 5 });
    advanceTo(g, 2, 'reveal');
    ok(dev('giveSpecial', { playerId: ids[0], effect: 'airlock' }));
    ok(dev('giveSpecial', { playerId: ids[1], effect: 'cancel_vote' }));
    ok(play(g, ids[0], 'airlock', { targetId: ids[2] }));
    ok(play(g, ids[1], 'cancel_vote'));
    assert.equal(g.voteMods.cancelNext, true);
    const logFrom = g.log.length;
    ok(dev('skipToVote'));
    const lines = g.log.slice(logFrom).map((e) => e.text);
    assert.ok(lines.includes('🚪 The airlock on P3 jammed — nobody closed it.'), lines.join('\n'));
    assert.ok(lines.some((l) => /^Round 6 — the vote is cancelled/.test(l)), 'round 6 vote skipped by Cancel vote');
    assert.deepEqual([g.phase, g.round, g.overtime], ['vote', 7, false]);
    assert.equal(g.voteMods.cancelNext, false);
    checkViews(g);
  });

  test('overtime: from the overtime discussion to the overtime ballot; from a defense to the revote', () => {
    const { g, ids, dev } = mk(4, { seed: 9 });
    advanceTo(g, 7, 'reveal');
    const alive = ids.filter((id) => P(g, id).status === 'alive');
    assert.equal(alive.length, 3);
    const canceller = alive[0];
    ok(dev('giveSpecial', { playerId: canceller, effect: 'cancel_vote' }));
    ok(dev('skipToVote'));
    assert.deepEqual([g.phase, g.round], ['vote', 7]);
    ok(play(g, canceller, 'cancel_vote'));
    assert.deepEqual([g.phase, g.overtime], ['discussion', true]);
    ok(dev('skipToVote'));
    assert.deepEqual([g.phase, g.round, g.overtime], ['vote', 7, true]);
    ok(dev('forceTie', { ids: [alive[2], alive[1]] }));
    assert.equal(g.phase, 'defense');
    ok(dev('skipToVote'));
    assert.equal(g.phase, 'vote');
    assert.equal(g.vote.stage, 'revote');
    assert.deepEqual(g.vote.candidates, [alive[1], alive[2]]);
    checkViews(g);
  });

  test('a running game always has a vote ahead: from anywhere, skipToVote lands on an open ballot (or the final), never elsewhere', () => {
    let landings = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const n = 2 + (seed % 15);
      const { g, ids, dev } = mk(n, { seed });
      const rng = mulberry32(seed * 7919);
      for (let guard = 0; g.phase !== 'final'; guard++) {
        assert.ok(guard < 400, `seed ${seed}: stuck`);
        if (g.phase === 'vote') {
          // vote at random, sometimes leave a voter out and close; sometimes force a tie
          const v = g.vote;
          if (v.stage === 'main' && v.candidates.length >= 2 && rng() < 0.3) { ok(dev('forceTie', { ids: v.candidates.slice(0, 2) })); continue; }
          for (const voter of [...v.voters]) if (rng() < 0.9 && g.vote === v) g.handle(voter, { t: 'vote', targetId: v.candidates.filter((c) => c !== voter)[Math.floor(rng() * (v.candidates.length - 1))] ?? v.candidates[0] });
          if (g.phase === 'vote' && g.vote === v) next(g);
          continue;
        }
        if (rng() < 0.3) { next(g); continue; } // move a bit by hand first
        const phase = g.phase;
        ok(dev('skipToVote', {}, ids[Math.floor(rng() * ids.length)]));
        assert.ok(g.phase === 'vote' || g.phase === 'final', `seed ${seed}: from ${phase} it landed in ${g.phase}`);
        landings++;
      }
      checkViews(g, `seed ${seed} final`);
    }
    assert.ok(landings > 60, `${landings} landings`);
  });
});

// ------------------------------------------------------------------------------------------------ forceTie
describe('§11 X9 forceTie', () => {
  test('outside a ballot wrong_phase; in a revote, with duplicates, unknown, ejected or immune players not_allowed; nothing changes', () => {
    const { g, ids, dev } = mk(6, { seed: 4 });
    err(dev('forceTie', { ids: [ids[0], ids[1]] }), 'wrong_phase', /ballot/);
    advanceTo(g, 2, 'reveal');
    ok(dev('giveSpecial', { playerId: ids[0], effect: 'airlock' }));
    ok(dev('giveSpecial', { playerId: ids[1], effect: 'airlock' }));
    ok(play(g, ids[0], 'airlock', { targetId: ids[5] }));
    ok(play(g, ids[1], 'airlock', { targetId: ids[5] }));
    assert.equal(P(g, ids[5]).status, 'ejected');
    advanceTo(g, 5, 'discussion');
    ok(dev('giveSpecial', { playerId: ids[2], effect: 'immunity' }));
    ok(play(g, ids[2], 'immunity'));
    ok(dev('skipToVote'));
    assert.deepEqual([g.phase, g.round], ['vote', 6], 'with P6 thrown out, round 5 has no kick left');
    const before = JSON.stringify(g.view(g.hostId));
    err(dev('forceTie', { ids: [ids[0], ids[0]] }), 'not_allowed', /once/);
    err(dev('forceTie', { ids: [ids[0], 'p99'] }), 'not_allowed', /no such/);
    err(dev('forceTie', { ids: [ids[0], ids[5]] }), 'not_allowed', /P6 is not in the game/);
    err(dev('forceTie', { ids: [ids[0], ids[2]] }), 'not_allowed', /P3 is immune/);
    assert.equal(JSON.stringify(g.view(g.hostId)), before, 'refusals change nothing');
    ok(dev('forceTie', { ids: [ids[1], ids[0]] }));
    assert.equal(g.phase, 'defense');
    ok(dev('skipToVote'));
    assert.equal(g.vote.stage, 'revote');
    err(dev('forceTie', { ids: [ids[0], ids[1]] }), 'not_allowed', /main ballot/);
  });

  test('the votes are rewritten into exactly that tie (seat order, ×2 counted, no self-vote), the ballot closes into the defense', () => {
    const { g, ids, dev } = mk(6, { seed: 8 });
    advanceTo(g, 5, 'discussion');
    ok(dev('skipToVote'));
    ok(dev('giveSpecial', { playerId: ids[3], effect: 'double_vote' }));
    ok(play(g, ids[3], 'double_vote'));
    ok(g.handle(ids[4], { t: 'vote', targetId: ids[5] })); // a vote that the tie overwrites
    const logFrom = g.log.length;
    ok(dev('forceTie', { ids: [ids[4], ids[1]] }, ids[2]));
    assert.equal(g.log[logFrom].text, '[dev] P3 forced a tie between P2, P5');
    assert.equal(g.phase, 'defense');
    assert.deepEqual(g.turn.order, [ids[1], ids[4]]);
    const r = g.view(ids[0]).lastVoteResult;
    assert.deepEqual(r.tie, [ids[1], ids[4]]);
    assert.equal(r.ejectedId, null);
    const votes = Object.fromEntries(r.tally.map((e) => [e.targetId, e.votes]));
    assert.equal(votes[ids[1]], votes[ids[4]]);
    assert.ok(votes[ids[1]] >= 1);
    for (const e of r.tally) {
      if (e.targetId !== ids[1] && e.targetId !== ids[4]) assert.equal(e.votes, 0);
      assert.ok(!e.voterIds.includes(e.targetId), 'nobody votes for themself');
      assert.equal(e.votes, e.voterIds.reduce((n, v) => n + (v === ids[3] ? 2 : 1), 0), 'the ×2 counts twice');
    }
    checkViews(g);
  });

  test('a tie of three, and a tie the voters cannot make (3 alive, one ×2): not_allowed, while a tie of two there works', () => {
    const three = mk(6, { seed: 2 });
    advanceTo(three.g, 5, 'discussion');
    ok(three.dev('skipToVote'));
    ok(three.dev('forceTie', { ids: three.ids.slice(0, 3) }));
    assert.deepEqual(three.g.turn.order, three.ids.slice(0, 3));

    const { g, ids, dev } = mk(3, { seed: 6 });
    ok(dev('skipToVote'));
    assert.deepEqual([g.phase, g.round, g.vote.voters.length], ['vote', 6, 3]);
    ok(dev('giveSpecial', { playerId: ids[0], effect: 'double_vote' }));
    ok(play(g, ids[0], 'double_vote'));
    err(dev('forceTie', { ids: [...ids] }), 'not_allowed', /cannot make that tie/);
    assert.equal(g.phase, 'vote');
    ok(dev('forceTie', { ids: [ids[1], ids[2]] }));
    assert.equal(g.phase, 'defense');
  });

  test('planTie agrees with a brute force on random ballots, and every plan it returns is an exact tie', () => {
    const rng = mulberry32(1234);
    let feasible = 0;
    let infeasible = 0;
    for (let trial = 0; trial < 1500; trial++) {
      const nv = 1 + Math.floor(rng() * 6);
      const voters = Array.from({ length: nv }, (_, i) => `v${i}`);
      const weights = new Map(voters.map((v) => [v, rng() < 0.25 ? 2 : 1]));
      const pool = [...voters, 'x1', 'x2'];
      const k = 2 + Math.floor(rng() * 2);
      const tied = pool.filter(() => rng() < 0.5).slice(0, k);
      if (tied.length < 2) continue;
      const w = (v) => weights.get(v);
      // brute force: each voter abstains or votes for a tied player other than themself
      let brute = false;
      const choice = new Array(nv).fill(-1);
      const rec = (i) => {
        if (brute) return;
        if (i === nv) {
          const got = tied.map(() => 0);
          choice.forEach((c, j) => { if (c >= 0) got[c] += w(voters[j]); });
          if (got[0] >= 1 && got.every((x) => x === got[0])) brute = true;
          return;
        }
        for (let c = -1; c < tied.length; c++) {
          if (c >= 0 && tied[c] === voters[i]) continue;
          choice[i] = c;
          rec(i + 1);
        }
      };
      rec(0);
      const plan = planTie(voters, w, tied);
      assert.equal(!!plan, brute, `voters ${JSON.stringify([...weights])} tied ${tied}`);
      if (!plan) { infeasible++; continue; }
      feasible++;
      const got = new Map(tied.map((t) => [t, 0]));
      for (const [v, t] of plan) {
        assert.notEqual(v, t);
        assert.ok(got.has(t));
        got.set(t, got.get(t) + w(v));
      }
      const counts = [...got.values()];
      assert.ok(counts[0] >= 1 && counts.every((c) => c === counts[0]), JSON.stringify([...plan]));
    }
    assert.ok(feasible > 100 && infeasible > 20, `${feasible} feasible, ${infeasible} infeasible`);
  });
});

// ------------------------------------------------------------------------------------------------ fastTimers, god
describe('§11 X9 fastTimers and the god view', () => {
  test('fastTimers: every option 5 s in any phase, a running timer cut to 5 s, logged', () => {
    const lobby = mk(4, { start: false });
    ok(lobby.dev('fastTimers', {}, lobby.ids[2]));
    assert.deepEqual(lobby.g.options, { speechSeconds1: 5, speechSeconds: 5, discussionSeconds: 5, defenseSeconds: 5 });
    assert.equal(lastLog(lobby.g), '[dev] P3 set every timer to 5 s');
    const { g, dev, clock } = mk(4);
    assert.equal(g.timer.endsAt - clock.t, 60_000);
    ok(dev('fastTimers'));
    assert.equal(g.timer.endsAt - clock.t, 5_000);
    checkViews(g);
    next(g);
    assert.equal(g.timer.endsAt - clock.t, 5_000, 'the next turn uses the 5 s option');
    ok(dev('skipToVote'));
    ok(dev('fastTimers'));
    assert.equal(g.phase, 'vote');
  });

  test('godView: every seated player\'s cards and specials, the used flags, nothing in the lobby', () => {
    const lobby = mk(3, { start: false });
    assert.deepEqual(godView(lobby.g), { players: {} });
    const { g, ids } = mk(4);
    advanceTo(g, 2, 'reveal');
    const gv = godView(g);
    assert.deepEqual(Object.keys(gv.players), ids);
    for (const id of ids) {
      const p = P(g, id);
      assert.deepEqual(gv.players[id].cards, Object.fromEntries(CATEGORY_IDS.map((c) => [c, p.cards[c].text])));
      assert.deepEqual(gv.players[id].specials, p.specials.map((s) => ({ title: s.title, text: s.text, effect: s.effect, used: s.used })));
    }
    checkViews(g);
  });

  test('the schema: `god` is an unexpected key unless {dev: true}, and a wrong one is caught', () => {
    const { g, ids } = mk(4);
    const v = { ...g.view(ids[0]), god: godView(g) };
    assert.ok(validateStateView(v).some((x) => /unexpected key "god"/.test(x)));
    assert.deepEqual(validateStateView(v, { dev: true }), []);
    assert.deepEqual(validateServerMessage({ t: 'state', ...v }, { dev: true }), []);
    const own = structuredClone(v);
    own.god.players[ids[0]].cards.health = 'not my card';
    assert.ok(validateStateView(own, { dev: true }).some((x) => /my own cards differ from me\.cards/.test(x)));
    ok(g.handle(ids[0], { t: 'reveal', category: 'profession' }));
    const pub = { ...g.view(ids[1]), god: godView(g) };
    assert.deepEqual(validateStateView(pub, { dev: true }), []);
    pub.god.players[ids[0]].cards.profession = 'not the public text';
    assert.ok(validateStateView(pub, { dev: true }).some((x) => /differs from the public card/.test(x)));
    const missing = structuredClone(v);
    delete missing.god.players[ids[2]];
    assert.ok(validateStateView(missing, { dev: true }).some((x) => /every seated player/.test(x)));
    const extra = structuredClone(v);
    extra.god.players[ids[1]].specials[0].uid = 's1';
    assert.ok(validateStateView(extra, { dev: true }).some((x) => /unexpected key "uid"/.test(x)));
    const lobby = mk(2, { start: false });
    assert.ok(validateStateView({ ...lobby.g.view(lobby.ids[0]), god: { players: { p1: v.god.players[ids[0]] } } }, { dev: true }).some((x) => /empty in the lobby/.test(x)));
  });
});

// ------------------------------------------------------------------------------------------------ over the wire
const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'bunker-dev-test-'));
before(() => {
  fs.writeFileSync(path.join(FIXTURE, 'index.html'), '<!doctype html><title>client</title>');
  fs.writeFileSync(path.join(FIXTURE, 'dev.html'), '<!doctype html><title>Test table</title>');
  fs.writeFileSync(path.join(FIXTURE, 'dev.js'), 'export const devPage = 1;\n');
  fs.writeFileSync(path.join(FIXTURE, 'app.js'), 'export const app = 1;\n');
});
after(() => { fs.rmSync(FIXTURE, { recursive: true, force: true }); });

function get(port, p, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function openWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = { ws, msgs: [], state: null, states: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      c.msgs.push(m);
      if (m.t === 'state') { c.state = m; c.states.push(m); }
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
/** Sends `msg` and a ping; resolves with every message before the pong. */
async function send(c, msg) {
  const n = c.msgs.length;
  c.ws.send(JSON.stringify(msg));
  c.ws.send('{"t":"ping"}');
  const t0 = Date.now();
  for (;;) {
    const i = c.msgs.slice(n).findIndex((m) => m.t === 'pong');
    if (i >= 0) return c.msgs.slice(n, n + i);
    if (Date.now() - t0 > 4000) throw new Error(`no pong after ${JSON.stringify(msg)}`);
    await sleep(3);
  }
}
async function sendOk(c, msg) {
  const r = await send(c, msg);
  const e = r.find((m) => m.t === 'error');
  assert.equal(e, undefined, `${JSON.stringify(msg)} -> ${JSON.stringify(e)}`);
  return r;
}
async function sendErr(c, msg, code, re) {
  const r = await send(c, msg);
  const e = r.filter((m) => m.t === 'error');
  assert.equal(e.length, 1, `${JSON.stringify(msg)} -> ${JSON.stringify(r)}`);
  assert.equal(e[0].code, code, `${JSON.stringify(msg)} -> ${JSON.stringify(e[0])}`);
  if (re) assert.match(e[0].message, re);
  return r;
}
async function waitState(c, pred, what = 'state', ms = 5000) {
  const t0 = Date.now();
  while (!(c.state && pred(c.state))) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; phase ${c.state?.phase} round ${c.state?.round}`);
    await sleep(3);
  }
  return c.state;
}
async function withServer(opts, fn) {
  const srv = await startServer({
    port: 0, host: '127.0.0.1', noLimits: true, minPlayers: 2, seed: 'dev-test', logger: () => {}, publicDir: FIXTURE,
    dev: false, production: false, trustProxy: false, devBotDelay: 1, ...opts,
  });
  const clients = [];
  const open = async () => { const c = await openWs(srv.port); clients.push(c); return c; };
  try { await fn(srv, open); } finally {
    for (const c of clients) c.ws.terminate();
    await srv.close();
  }
}
const withProd = (fn, opts = {}) => withServer({ ...opts, dev: false }, fn);
const withDev = (fn, opts = {}) => withServer({ ...opts, dev: true }, fn);

/** One of each op (well-formed), plus malformed ones: all must be not_allowed without dev mode. */
const ALL_DEV_MSGS = [
  { t: 'dev', op: 'giveSpecial', playerId: 'p1', effect: 'airlock' }, { t: 'dev', op: 'autoReveal' }, { t: 'dev', op: 'skipToVote' },
  { t: 'dev', op: 'forceTie', ids: ['p1', 'p2'] }, { t: 'dev', op: 'god', on: true }, { t: 'dev', op: 'fastTimers' },
  { t: 'dev', op: 'addBots', count: 3 }, { t: 'dev' }, { t: 'dev', op: 'nope' }, { t: 'dev', op: 'addBots', count: 99 },
  { t: 'dev', op: 'god', on: 'yes' },
];

describe('§11 X9 without dev mode (production)', () => {
  test('/dev, /devinfo and every dev file: the plain 404 (byte for byte), frames DENY; other files unchanged', async () => {
    await withProd(async (srv) => {
      const missing = await get(srv.port, '/no-such-file.js');
      assert.equal(missing.status, 404);
      for (const p of ['/dev', '/dev/', '/dev.html', '/dev.js', '/devinfo', '/devinfo/', '/.//dev.html', '/%2fdev.html', '/./dev.html', '/a/../dev.html',
        '/%2e%2e/dev.html', '/dev%2ehtml', '/%64ev.html', '/DEV.html', '/Dev.js', '/dev/index.html', '/dev?x=1', '/devinfo?x=1']) {
        const r = await get(srv.port, p);
        assert.equal(r.status, 404, p);
        assert.equal(r.body, missing.body, p);
        assert.equal(r.headers['content-type'], missing.headers['content-type'], p);
        assert.equal((await get(srv.port, p, { method: 'HEAD' })).status, 404, `HEAD ${p}`);
      }
      // odd spellings that are not dev paths at all (//x is a host, a backslash is refused): never the dev files either
      for (const p of ['//dev.html', '///dev.js', '/%5cdev.html', '/x/../%2e/dev.js']) {
        const r = await get(srv.port, p);
        assert.ok(!r.body.includes('Test table') && !r.body.includes('devPage'), `${p}: ${r.status} ${r.body.slice(0, 60)}`);
      }
      const idx = await get(srv.port, '/');
      assert.equal(idx.status, 200);
      assert.equal(idx.headers['x-frame-options'], 'DENY');
      assert.equal((await get(srv.port, '/app.js')).status, 200);
      assert.equal((await get(srv.port, '/healthz')).body, 'ok');
    });
  });

  test('every {t:\'dev\'} is not_allowed, before and after joining, for players and spectators; it changes nothing and no state carries god', async () => {
    await withProd(async (srv, open) => {
      const a = await open();
      for (const m of ALL_DEV_MSGS) await sendErr(a, m, 'not_allowed', /Dev mode is off/);
      await sendOk(a, { t: 'create', name: 'P1', seed: 'abc' });
      const b = await open();
      await sendOk(b, { t: 'join', room: a.state.room, name: 'P2' });
      const s = await open();
      await sendOk(s, { t: 'join', room: a.state.room, name: 'S', spectator: true });
      await sendOk(a, { t: 'start' });
      for (const c of [b, s]) await waitState(c, (st) => st.phase === 'reveal');
      await sleep(20);
      for (const c of [a, b, s]) {
        const states = c.states.length;
        for (const m of ALL_DEV_MSGS) {
          const r = await sendErr(c, m, 'not_allowed', /Dev mode is off/);
          assert.equal(r.length, 1, 'nothing but the error');
        }
        assert.equal(c.states.length, states, 'no state was sent: nothing changed');
      }
      await sleep(20);
      for (const c of [a, b, s]) {
        for (const m of c.msgs) assert.deepEqual(validateServerMessage(m), [], JSON.stringify(m).slice(0, 200));
        assert.ok(c.states.every((st) => !Object.hasOwn(st, 'god')));
        assert.ok(c.states.every((st) => st.log.every((e) => !e.text.startsWith('[dev]'))));
      }
      assert.equal(srv.rooms.dev, null);
    });
  });

  test('`create` ignores `seed`: with the same BUNKER_SEED, rooms created with different seeds deal the same game; a malformed seed is no error', async () => {
    const deal = async (seed) => {
      let out = null;
      await withProd(async (srv, open) => {
        const a = await open();
        await sendOk(a, { t: 'create', name: 'P1', seed });
        const b = await open();
        await sendOk(b, { t: 'join', room: a.state.room, name: 'P2' });
        await sendOk(a, { t: 'start' });
        await waitState(b, (st) => st.phase === 'reveal');
        out = JSON.stringify([a.state.room, a.state.catastrophe, a.state.bunker, a.state.me.cards, a.state.me.specials, b.state.me.cards, b.state.me.specials]);
      }, { seed: 'fixed-global' });
      return out;
    };
    const x = await deal('alpha');
    assert.equal(await deal('beta'), x);
    assert.equal(await deal(12345), x);
    assert.equal(await deal({ not: 'a seed' }), x);
  });

  test('server/dev.js and tools/botlib.js are never loaded without dev mode (and are with it)', async (t) => {
    const mod = await import('node:module');
    if (typeof mod.registerHooks !== 'function') { t.skip('module.registerHooks is not available'); return; }
    const script = `
      import { registerHooks } from 'node:module';
      const loaded = new Set();
      registerHooks({ resolve(spec, ctx, next) { const r = next(spec, ctx); const m = /\\/(server\\/dev|tools\\/botlib)\\.js$/.exec(r.url); if (m) loaded.add(m[1]); return r; } });
      const { startServer } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'server', 'index.js')).href)});
      const { default: WebSocket } = await import('ws');
      const srv = await startServer({ port: 0, host: '127.0.0.1', dev: process.env.CHECK_DEV === '1', production: false, trustProxy: false, logger: () => {} });
      const ws = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws');
      await new Promise((r) => ws.on('open', r));
      const replies = [];
      ws.on('message', (d) => replies.push(JSON.parse(String(d))));
      for (const m of [{ t: 'create', name: 'P1', seed: 'x' }, { t: 'dev', op: 'god', on: true }, { t: 'dev', op: 'addBots', count: 2 }, { t: 'ping' }]) ws.send(JSON.stringify(m));
      await new Promise((r) => { const i = setInterval(() => { if (replies.some((m) => m.t === 'pong')) { clearInterval(i); r(); } }, 5); });
      ws.terminate();
      await srv.close();
      console.log(JSON.stringify({ loaded: [...loaded].sort(), errors: replies.filter((m) => m.t === 'error').map((m) => m.code) }));
    `;
    const run = (checkDev) => new Promise((resolve, reject) => {
      const env = { ...process.env, CHECK_DEV: checkDev ? '1' : '0' };
      delete env.BUNKER_DEV;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let errOut = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { errOut += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.on('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(JSON.parse(out.trim().split('\n').pop())); else reject(new Error(`exit ${code}: ${errOut}`)); });
    });
    assert.deepEqual(await run(false), { loaded: [], errors: ['not_allowed', 'not_allowed'] });
    assert.deepEqual(await run(true), { loaded: ['server/dev', 'tools/botlib'], errors: [] });
  });

  test('tools/botlib.js has no side effects on import: a process that only imports it exits at once, silently', async () => {
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', "await import('./tools/botlib.js');"], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      const t0 = Date.now();
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, ms: Date.now() - t0 }); });
    });
    assert.deepEqual([r.code, r.signal, r.out], [0, null, '']);
  });
});

describe('§11 X9 the BUNKER_DEV switch on the real server', () => {
  test('only BUNKER_DEV=1 turns it on; then the banner is printed, /devinfo answers and ops work', async () => {
    for (const v of ['0', 'true', 'yes', ' 1', '']) {
      const srv = await spawnServer({ env: { BUNKER_DEV: v }, noLimits: false });
      try {
        assert.ok(!srv.stdout().includes('DEV MODE'), `BUNKER_DEV=${JSON.stringify(v)}`);
        assert.equal((await get(srv.port, '/devinfo')).status, 404, `BUNKER_DEV=${JSON.stringify(v)}`);
      } finally { await srv.stop(); }
    }
    const srv = await spawnServer({ env: { BUNKER_DEV: '1' }, noLimits: false });
    try {
      await sleep(50);
      assert.ok(srv.stdout().split('\n').includes(DEV_BANNER), srv.stdout());
      assert.equal(DEV_BANNER, '*** DEV MODE — test shortcuts enabled, never expose publicly ***');
      assert.match(srv.stderr(), /DEV MODE/);
      const r = await get(srv.port, '/devinfo');
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), { dev: true });
      const c = await openWs(srv.port);
      await sendOk(c, { t: 'create', name: 'P1' });
      await sendOk(c, { t: 'dev', op: 'fastTimers' });
      assert.equal(c.state.options.speechSeconds, 5);
      c.ws.terminate();
    } finally { await srv.stop(); }
    assert.deepEqual(srv.problems(), []);
  });

  test('refused next to the production unit\'s settings (BUNKER_TRUST_PROXY=1 or NODE_ENV=production): exit 1, nothing listens', async () => {
    for (const extra of [{ BUNKER_TRUST_PROXY: '1' }, { NODE_ENV: 'production' }]) {
      const res = await new Promise((resolve) => {
        const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', BUNKER_DEV: '1', ...extra };
        const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let errOut = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { errOut += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
        child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, errOut }); });
      });
      assert.equal(res.code, 1, JSON.stringify(extra));
      assert.ok(!res.out.includes('listening'), res.out);
      assert.ok(res.errOut.includes(DEV_REFUSED), res.errOut);
    }
    await assert.rejects(startServer({ port: 0, host: '127.0.0.1', dev: true, trustProxy: true, logger: () => {} }), /dev mode refused/);
  });

  test('isDevPath', () => {
    for (const p of ['/dev', '/dev/', '/dev.html', '/dev.js', '/dev.css', '/devinfo', '/devinfo/x', '//dev.html', '/DEV.HTML', '/dev/a/b']) assert.equal(isDevPath(p), true, p);
    for (const p of ['/', '/index.html', '/app.js', '/devices.png', '/developer', '/x/dev.html', '/healthz', '/stats', '/devinfox']) assert.equal(isDevPath(p), false, p);
  });
});

describe('§11 X9 dev mode over the wire', () => {
  test('/devinfo, /dev (dev.html), the dev files, and frames of this origin allowed', async () => {
    await withDev(async (srv) => {
      const info = await get(srv.port, '/devinfo');
      assert.equal(info.status, 200);
      assert.equal(info.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(info.headers['cache-control'], 'no-store');
      assert.equal(info.body, '{"dev":true}');
      const head = await get(srv.port, '/devinfo', { method: 'HEAD' });
      assert.deepEqual([head.status, head.body], [200, '']);
      assert.equal((await get(srv.port, '/devinfo', { method: 'POST' })).status, 405);
      for (const p of ['/dev', '/dev/', '/dev.html']) {
        const r = await get(srv.port, p);
        assert.equal(r.status, 200, p);
        assert.equal(r.body, '<!doctype html><title>Test table</title>', p);
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', p);
        assert.ok(r.headers['content-security-policy'], p);
      }
      assert.equal((await get(srv.port, '/dev.js')).body, 'export const devPage = 1;\n');
      assert.equal((await get(srv.port, '/dev/index.html')).status, 404);
      const idx = await get(srv.port, '/?room=ABCD&profile=p2&autojoin=1');
      assert.equal(idx.status, 200);
      assert.equal(idx.headers['x-frame-options'], 'SAMEORIGIN');
    });
  });

  test('codes in §7 order: bad_request, then not_in_room, then wrong_phase/not_allowed; a bad seed is bad_request', async () => {
    await withDev(async (srv, open) => {
      const a = await open();
      await sendErr(a, { t: 'dev', op: 'nope' }, 'bad_request', /Unknown dev op/);
      await sendErr(a, { t: 'dev', op: 'addBots', count: 16 }, 'bad_request', /count/);
      await sendErr(a, { t: 'dev', op: 'god', on: true }, 'not_in_room');
      await sendErr(a, { t: 'dev', op: 'autoReveal' }, 'not_in_room');
      for (const seed of [{}, 1.5, 'x'.repeat(65), true]) await sendErr(a, { t: 'create', name: 'P1', seed }, 'bad_request', /seed/);
      await sendOk(a, { t: 'create', name: 'P1' });
      assert.ok(a.state.log.every((e) => !e.text.startsWith('[dev]')), 'no seed, no seed line');
      await sendErr(a, { t: 'dev', op: 'autoReveal' }, 'wrong_phase');
      await sendErr(a, { t: 'dev', op: 'skipToVote' }, 'wrong_phase');
      await sendErr(a, { t: 'dev', op: 'giveSpecial', playerId: a.state.you.id, effect: 'peek' }, 'wrong_phase');
      await sendErr(a, { t: 'dev', op: 'forceTie', ids: ['p1', 'p2'] }, 'wrong_phase');
      const b = await open();
      await sendOk(b, { t: 'join', room: a.state.room, name: 'P2' });
      await sendOk(a, { t: 'start' });
      await sendErr(b, { t: 'dev', op: 'giveSpecial', playerId: 'p9', effect: 'peek' }, 'not_allowed', /no such/);
      await sendOk(b, { t: 'leave' });
      await sendErr(b, { t: 'dev', op: 'fastTimers' }, 'not_in_room');
    });
  });

  test('the same seed deals the same game in two rooms ("42" and 42 alike); another seed deals another; a seed line is logged', async () => {
    await withDev(async (srv, open) => {
      const table = async (seed) => {
        const host = await open();
        await sendOk(host, { t: 'create', name: 'Host', seed });
        const others = [];
        for (let i = 2; i <= 5; i++) {
          const c = await open();
          await sendOk(c, { t: 'join', room: host.state.room, name: `P${i}` });
          others.push(c);
        }
        await sendOk(host, { t: 'dev', op: 'god', on: true });
        await sendOk(host, { t: 'start' });
        const s = await waitState(host, (st) => st.phase === 'reveal' && !!st.god);
        const seedLine = s.log.find((e) => e.text.startsWith('[dev] Deals'));
        return {
          line: seedLine && seedLine.text,
          deal: JSON.stringify([s.catastrophe, s.bunker, s.players.map((p) => s.god.players[p.id]), s.turn.order]),
        };
      };
      const a = await table('42');
      const b = await table(42);
      const c = await table('43');
      assert.equal(a.line, '[dev] Deals in this room follow the seed “42”');
      assert.equal(b.deal, a.deal);
      assert.notEqual(c.deal, a.deal);
    });
  });

  test('the god view goes to the requesting socket only, follows the game, and ends with god off or a new socket', async () => {
    await withDev(async (srv, open) => {
      const a = await open();
      await sendOk(a, { t: 'create', name: 'P1' });
      const b = await open();
      await sendOk(b, { t: 'join', room: a.state.room, name: 'P2' });
      const joinedB = b.msgs.find((m) => m.t === 'joined');
      const s = await open();
      await sendOk(s, { t: 'join', room: a.state.room, name: 'Watcher', spectator: true });
      await sendOk(s, { t: 'dev', op: 'god', on: true }); // a spectator may use it too
      const sv = await waitState(s, (st) => !!st.god);
      assert.deepEqual(sv.god, { players: {} });
      assert.equal(sv.log[sv.log.length - 1].text, '[dev] Watcher turned the god view on (on their own screen only)');
      await sendOk(a, { t: 'start' });
      await waitState(s, (st) => st.phase === 'reveal' && Object.keys(st.god.players).length === 2);
      const bv = await waitState(b, (st) => st.phase === 'reveal');
      assert.deepEqual(s.state.god.players[bv.you.id].cards, Object.fromEntries(CATEGORY_IDS.map((c) => [c, bv.me.cards[c].text])));
      assert.ok(a.states.every((st) => !Object.hasOwn(st, 'god')) && b.states.every((st) => !Object.hasOwn(st, 'god')), 'nobody else gets it');
      await sendOk(s, { t: 'dev', op: 'god', on: false });
      assert.ok(!Object.hasOwn(s.state, 'god'));
      // per socket: b turns it on, then resumes on a new socket, which has no god view
      await sendOk(b, { t: 'dev', op: 'god', on: true });
      assert.ok(b.state.god);
      const b2 = await open();
      await sendOk(b2, { t: 'resume', room: joinedB.room, token: joinedB.token });
      await waitState(b2, (st) => st.phase === 'reveal');
      assert.ok(!Object.hasOwn(b2.state, 'god'));
      await sendOk(b2, { t: 'dev', op: 'fastTimers' });
      assert.ok(!Object.hasOwn(b2.state, 'god'));
      for (const c of [a, b, b2, s]) for (const m of c.msgs) assert.deepEqual(validateServerMessage(m, { dev: true }), [], JSON.stringify(m).slice(0, 300));
      for (const c of [a, b2]) for (const m of c.msgs) assert.deepEqual(validateServerMessage(m), [], 'without god, a normal view');
    });
  });

  test('the X9 smoke: Airlocks given to P1 and P2 seal on P3, then skipToVote, forceTie and the god view; every op logs "[dev] …"', async () => {
    await withDev(async (srv, open) => {
      const cs = [];
      for (let i = 1; i <= 4; i++) {
        const c = await open();
        if (i === 1) await sendOk(c, { t: 'create', name: 'P1', seed: 'smoke' });
        else await sendOk(c, { t: 'join', room: cs[0].state.room, name: `P${i}` });
        cs.push(c);
      }
      const [p1, p2, p3, p4] = cs;
      const id = (c) => c.state.you.id;
      await sendOk(p4, { t: 'dev', op: 'fastTimers' });
      await sendOk(p1, { t: 'start' });
      await sendOk(p2, { t: 'dev', op: 'autoReveal' });
      await waitState(p1, (st) => st.phase === 'discussion');
      await sendOk(p1, { t: 'next' });
      await waitState(p1, (st) => st.round === 2 && st.phase === 'reveal');
      await sendOk(p4, { t: 'dev', op: 'giveSpecial', playerId: id(p1), effect: 'airlock' });
      await sendOk(p4, { t: 'dev', op: 'giveSpecial', playerId: id(p2), effect: 'airlock' });
      const air = (c) => c.state.me.specials.find((x) => x.effect === 'airlock' && !x.used);
      for (const c of [p1, p2]) await waitState(c, (st) => devLines(st.log).length === 5 && !!st.me.specials.find((x) => x.effect === 'airlock' && !x.used));
      await sendOk(p1, { t: 'special', uid: air(p1).uid, targetId: id(p3) });
      await waitState(p4, (st) => st.airlocks.length === 1);
      assert.deepEqual(p4.state.airlocks.map((a) => a.targetId), [id(p3)]);
      await sendOk(p2, { t: 'special', uid: air(p2).uid, targetId: id(p3) });
      const after = await waitState(p4, (st) => st.players.find((p) => p.id === id(p3)).status === 'ejected');
      assert.ok(after.log.some((e) => e.text === '🚪 P2 sealed the airlock with P1 — P3 is thrown out of the bunker, no vote!'));
      await sendOk(p3, { t: 'dev', op: 'skipToVote' }); // an ejected player is still a member
      const v = await waitState(p1, (st) => st.phase === 'vote');
      assert.equal(v.round, 7, '4 players with one thrown out: round 6 has no kick left, round 7 votes');
      await sendOk(p1, { t: 'dev', op: 'forceTie', ids: [id(p4), id(p1)] });
      const d = await waitState(p1, (st) => st.phase === 'defense');
      assert.deepEqual(d.turn.order, [id(p1), id(p4)]);
      await sendOk(p1, { t: 'dev', op: 'god', on: true });
      assert.deepEqual(Object.keys(p1.state.god.players), [id(p1), id(p2), id(p3), id(p4)]);
      const lines = devLines(p1.state.log).map((e) => e.text);
      assert.deepEqual(lines, [
        '[dev] Deals in this room follow the seed “smoke”',
        '[dev] P4 set every timer to 5 s',
        '[dev] P2 auto-revealed the rest of the reveal phase (Round 1)',
        `[dev] P4 gave P1 the special “${AIRLOCK_CARD.title}”`,
        `[dev] P4 gave P2 the special “${AIRLOCK_CARD.title}”`,
        '[dev] P3 skipped ahead to the next vote',
        '[dev] P1 forced a tie between P1, P4',
        '[dev] P1 turned the god view on (on their own screen only)',
      ]);
      assert.ok(devLines(p1.state.log).every((e) => e.kind === 'info'));
      for (const c of cs) for (const m of c.msgs) assert.deepEqual(validateServerMessage(m, { dev: true }), [], JSON.stringify(m).slice(0, 300));
    });
  });

  test('addBots: seated in the lobby (clamped to 16 seats, then room_full), spectators in a game, a kicked bot closes', async () => {
    await withDev(async (srv, open) => {
      const a = await open();
      await sendOk(a, { t: 'create', name: 'P1' });
      const code = a.state.room;
      await sendOk(a, { t: 'dev', op: 'addBots', count: 3 });
      await waitState(a, (st) => st.players.length === 4, '3 bots seated');
      assert.deepEqual(a.state.players.map((p) => p.name), ['P1', 'Bot Anna', 'Bot Boris', 'Bot Clara']);
      assert.equal(srv.rooms.dev.botsIn(code).length, 3);
      await sendOk(a, { t: 'dev', op: 'addBots', count: 15 });
      await waitState(a, (st) => st.players.length === 16, '16 seats');
      await sleep(30);
      assert.equal(a.state.spectators.length, 0, 'clamped: nobody became a spectator');
      assert.deepEqual(devLines(a.state.log).map((e) => e.text), ['[dev] P1 added 3 bots (they take seats)', '[dev] P1 added 12 bots (they take seats)']);
      await sendErr(a, { t: 'dev', op: 'addBots', count: 1 }, 'room_full');
      await sendOk(a, { t: 'start' });
      await sendOk(a, { t: 'dev', op: 'addBots', count: 2 });
      await waitState(a, (st) => st.spectators.length === 2, '2 bot spectators');
      assert.equal(a.state.log.filter((e) => e.text.includes('(they watch: seats are taken only in the lobby)')).length, 1);
      const victim = a.state.players.find((p) => p.name === 'Bot Boris');
      await sendOk(a, { t: 'kick', playerId: victim.id });
      await sleep(30);
      assert.equal(srv.rooms.dev.botsIn(code).length, 16, '15 + 2 - 1');
      assert.ok(!srv.rooms.dev.botsIn(code).some((b) => b.id === victim.id));
    });
  });

  test('bots leave with the last human (the room is gone at once), and after the idle time when no human is connected', async () => {
    await withDev(async (srv, open) => {
      const a = await open();
      await sendOk(a, { t: 'create', name: 'P1' });
      const code = a.state.room;
      await sendOk(a, { t: 'dev', op: 'addBots', count: 3 });
      await waitState(a, (st) => st.players.length === 4);
      await sendOk(a, { t: 'start' });
      await sendOk(a, { t: 'leave' });
      for (let i = 0; i < 200 && srv.rooms.rooms.has(code); i++) await sleep(5);
      assert.equal(srv.rooms.rooms.has(code), false, 'the room is deleted once the bots have left too');
      assert.equal(srv.rooms.dev.tables.size, 0);
      const probe = await open();
      await sendErr(probe, { t: 'join', room: code, name: 'X' }, 'no_room');
    }); // the default idle time (3 min): only the last human's leave can have made them go
    // idle: the human's socket closes (the seat stays): the bots leave after botIdleMs, the human's seat stays
    await withDev(async (srv, open) => {
      const h = await open();
      await sendOk(h, { t: 'create', name: 'Human' });
      const code2 = h.state.room;
      await sendOk(h, { t: 'dev', op: 'addBots', count: 2 });
      await waitState(h, (st) => st.players.length === 3);
      h.ws.terminate();
      await sleep(250);
      assert.equal(srv.rooms.dev.botsIn(code2).length, 2, 'not before the idle time');
      for (let i = 0; i < 400 && srv.rooms.dev.botsIn(code2).length; i++) await sleep(5);
      assert.equal(srv.rooms.dev.botsIn(code2).length, 0);
      for (let i = 0; i < 200 && srv.rooms.rooms.get(code2)?.game.players.length !== 1; i++) await sleep(5);
      assert.deepEqual(srv.rooms.rooms.get(code2).game.players.map((p) => p.name), ['Human']);
    }, { devBotIdleMs: 400, hostGraceMs: 200 });
  });

  test('a human host (a botlib Bot over a real socket) plays a full game with in-process bots: to the final, every state valid, no rejected legal action', async () => {
    await withDev(async (srv) => {
      const human = new Bot({ url: `http://127.0.0.1:${srv.port}`, name: 'Human', seed: 'h', delay: 0, host: { autoStart: 6 } });
      const seen = [];
      human.on('message', (m) => seen.push(m));
      try {
        await human.create();
        human.act({ t: 'dev', op: 'god', on: true });
        human.act({ t: 'dev', op: 'fastTimers' });
        human.act({ t: 'dev', op: 'addBots', count: 5, specials: 0.6 });
        const fin = await human.waitFor((s) => s.phase === 'final', 30000, 'the final');
        assert.equal(fin.players.length, 6);
        assert.ok(fin.god && Object.keys(fin.god.players).length === 6);
        const problems = seen.flatMap((m) => validateServerMessage(m, { dev: true }));
        assert.deepEqual(problems.slice(0, 10), []);
        const bots = srv.rooms.dev.botsIn(fin.room);
        assert.equal(bots.length, 5);
        const botErrors = bots.flatMap((b) => b.errors.filter((e) => !e.race && !e.expected));
        assert.deepEqual(botErrors.map((e) => `${e.code} ${e.message} <- ${JSON.stringify(e.msg)}`), []);
        assert.deepEqual(human.errors.filter((e) => !e.race && !e.expected).map((e) => e.code), []);
        assert.ok(bots.some((b) => b.specialsPlayed.length > 0), 'with specials > 0 the bots play cards');
      } finally { human.close(); }
    });
  });

  test('dev mode lifts the per-network room cap (V1): six rooms from one address', async () => {
    await withDev(async (srv, open) => {
      for (let i = 0; i < 7; i++) {
        const c = await open();
        await sendOk(c, { t: 'create', name: `Host ${i}` });
      }
      assert.equal(srv.rooms.rooms.size, 7);
    }, { noLimits: false });
    await withProd(async (srv, open) => {
      for (let i = 0; i < 5; i++) await sendOk(await open(), { t: 'create', name: `Host ${i}` });
      await sendErr(await open(), { t: 'create', name: 'Host 6' }, 'server_busy');
    }, { noLimits: false });
  });

  test('DEV_TEXT holds the dev strings in one place', () => {
    assert.equal(typeof DEV_TEXT.log.giveSpecial('a', 'b', 'c'), 'string');
    for (const f of Object.values(DEV_TEXT.log)) assert.match(f('X', 'Y', 'Z'), /^\[dev\] /);
  });
});
