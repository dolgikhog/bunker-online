// Regression tests for the round-2 review findings fixed on the server side (reports/fix-server-fixer-r2.md):
//   - a special aimed at a vote landing on the next step: the optional step key `at` on `special` (SPEC §11 R3)
//   - vote.ballots / kicksThisStep not re-evaluated after a leave, kick or Extra Bunk mid-step (§11 R4)
//   - "the vote ends without an ejection" after an earlier ballot of the same vote ejected someone
//   - "Make host" on an offline player bounced at the next sweep (§11 H1)
//   - "X was removed by the host the game"; the revive card's promise of a turn; specials using up hidden cards (§11 C6)
//   - the 4-letter room code space scanned from one address (§11 V2)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGame, EFFECTS, CATEGORY_IDS, KICKS, kicksForStep } from '../server/game.js';
import { Rooms, JOIN_FAIL_BURST, JOIN_FAIL_REFILL_MS } from '../server/rooms.js';
import { createDealer, REVIVE_CARD } from '../server/content.js';
import { mulberry32 } from '../server/rng.js';
import { startServer as startInProcess } from '../server/index.js';
import { startServer } from './helpers-sim.js';

// ------------------------------------------------------------------------------------------------ engine helpers
const FILLER = { id: 'filler', title: 'Blueprint', text: 'Adds a bunker feature.', effect: 'bunker_add_feature', target: 'none' };
const sp = (effect, extra = {}) => ({ id: effect, title: `T:${effect}`, text: `Card text for ${effect}`, effect, target: EFFECTS[effect].targets[0], ...extra });

function makeDealer(specials = {}) {
  let cardN = 0;
  let specialN = 0;
  return {
    drawCard(c) { cardN++; return `<${c}#${cardN}>`; },
    drawSpecial() {
      const seat = Math.floor(specialN / 2);
      const slot = specialN % 2;
      specialN++;
      return { ...(specials[seat]?.[slot] ?? FILLER) };
    },
    drawCatastrophe() { return { title: 'Test flood', text: 'Water everywhere.', details: ['Survivors: 1%'] }; },
    drawBunker() { return { name: 'Test bunker', size: '50 m2', duration: '1 year', food: '1 year', features: ['Well'] }; },
    drawBunkerFeature() { return 'A feature'; },
  };
}
function started(n, { specials = {}, seed = 7 } = {}) {
  const clock = { t: 1_000_000 };
  const g = createGame({ room: 'TEST', rng: mulberry32(seed), now: () => clock.t, minPlayers: 2, dealer: makeDealer(specials), fixedSpecials: false });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`).id);
  ok(g.handle(ids[0], { t: 'start' }));
  return { g, ids, clock };
}
function ok(res) { assert.deepEqual(res, { ok: true }, JSON.stringify(res)); }
function err(res, code) {
  assert.equal(res.ok, false, `expected ${code}, got ok`);
  assert.equal(res.code, code, `expected ${code}, got ${res.code}: ${res.message}`);
}
const P = (g, id) => g.players.find((p) => p.id === id);
const card = (g, id, effect) => P(g, id).specials.find((s) => s.effect === effect && !s.used);
const play = (g, id, effect, extra = {}) => g.handle(id, { t: 'special', uid: card(g, id, effect).uid, ...extra });
/** The step key exactly as the shipped client builds it from a StateView (SPEC §11 R1). */
function atOf(view) {
  return {
    phase: view.phase, round: view.round, overtime: view.overtime,
    turnIndex: view.turn ? view.turn.index : null, ballot: view.vote ? view.vote.ballot : null, stage: view.vote ? view.vote.stage : null,
  };
}
const at = (g, id = g.hostId) => atOf(g.view(id));
const snap = (g) => JSON.stringify({ ...g.view(g.hostId), serverNow: 0 });
const logSince = (g, id0) => g.log.filter((e) => e.id > id0).map((e) => e.text);
const formula = (g) => kicksForStep({
  row: g.kicks, round: g.round, overtime: g.overtime, outCount: g.players.filter((p) => p.status !== 'alive').length,
  alive: g.players.filter((p) => p.status === 'alive').length, capacity: g.capacity,
});
/** Next through the game; every ballot ejects its first candidate not in `avoid` (by a unanimous vote), until pred(g). */
function advance(g, pred, avoid = []) {
  for (let i = 0; i < 3000 && !pred(g); i++) {
    assert.notEqual(g.phase, 'final', 'the game ended before the wanted state');
    if (g.phase === 'vote') {
      const v = g.vote;
      const target = v.candidates.find((c) => !avoid.includes(c)) ?? v.candidates[0];
      for (const voter of v.voters) {
        if (g.vote !== v) break;
        const t = voter === target ? v.candidates.find((c) => c !== voter) : target;
        ok(g.handle(voter, { t: 'vote', targetId: t }));
      }
      if (g.vote === v) ok(g.handle(g.hostId, { t: 'closeVote' }));
    } else ok(g.handle(g.hostId, { t: 'next' }));
  }
  assert.ok(pred(g), 'advance did not reach the wanted state');
}
/** Every voter of the open main ballot votes for A or B so that A and B tie at the top. */
function tie(g, A, B) {
  const v = g.vote;
  const others = v.voters.filter((x) => x !== A && x !== B);
  const third = v.candidates.find((c) => c !== A && c !== B);
  others.forEach((voter, i) => {
    if (g.vote !== v) return;
    let t = i % 2 ? B : A;
    if (i === others.length - 1 && others.length % 2) t = third === voter ? v.candidates.find((c) => c !== voter && c !== A && c !== B) : third;
    ok(g.handle(voter, { t: 'vote', targetId: t }));
  });
  if (g.vote === v && v.voters.includes(A)) ok(g.handle(A, { t: 'vote', targetId: B }));
  if (g.vote === v && v.voters.includes(B)) ok(g.handle(B, { t: 'vote', targetId: A }));
  if (g.vote === v) ok(g.handle(g.hostId, { t: 'closeVote' }));
}

// ------------------------------------------------------------------------------------------------ special + step key
describe('a special aimed at a vote does not land on the next step (SPEC §11 R3)', () => {
  test('schema: `at` is optional on special; a wrongly typed one is bad_request', () => {
    const { g, ids } = started(4, { specials: { 1: [sp('double_vote'), FILLER] } });
    err(g.handle(ids[1], { t: 'special', uid: card(g, ids[1], 'double_vote').uid, at: 5 }), 'bad_request');
    err(g.handle(ids[1], { t: 'special', uid: card(g, ids[1], 'double_vote').uid, at: { round: '1' } }), 'bad_request');
    err(g.handle(ids[1], { t: 'special', uid: card(g, ids[1], 'double_vote').uid, at: { stage: 7 } }), 'bad_request');
    ok(g.handle(ids[1], { t: 'special', uid: card(g, ids[1], 'double_vote').uid, at: null }));
  });

  test('cancel_vote made on the open ballot, arriving after it closed: refused, nothing spent, the ejection stands', () => {
    // N=6: KICKS [0,0,0,0,1,1,1]; P2 holds cancel_vote and wants to save P4 in round 5's 1-ballot vote
    const { g, ids } = started(6, { specials: { 2: [sp('cancel_vote'), FILLER] } });
    advance(g, (x) => x.phase === 'vote' && x.round === 5);
    const clickedOn = at(g, ids[2]); // the saver's view: ballot 1 open
    for (const i of [0, 1, 3, 5]) ok(g.handle(ids[i], { t: 'vote', targetId: ids[4] }));
    ok(g.handle(ids[2], { t: 'vote', targetId: ids[1] }));
    ok(g.handle(ids[4], { t: 'vote', targetId: ids[1] })); // the last vote closes the ballot first
    assert.equal(P(g, ids[4]).status, 'ejected');
    assert.equal(g.phase, 'reveal');
    assert.equal(g.round, 6);
    const before = snap(g);
    const res = play(g, ids[2], 'cancel_vote', { at: clickedOn });
    err(res, 'wrong_phase');
    assert.match(res.message, /Too late/);
    assert.equal(snap(g), before, 'nothing changed');
    assert.equal(card(g, ids[2], 'cancel_vote').used, false, 'the card is not spent');
    assert.equal(g.view(ids[2]).me.canPlaySpecial, true, "round 6's allowance is kept");
    assert.equal(g.voteMods.cancelNext, false, 'the next vote is not cancelled');
    // played again on purpose, on the new step, it does what the new step makes of it
    ok(play(g, ids[2], 'cancel_vote', { at: at(g, ids[2]) }));
    assert.equal(g.voteMods.cancelNext, true);
  });

  test('control: the same card arriving while its ballot is open cancels that vote', () => {
    const { g, ids } = started(6, { specials: { 2: [sp('cancel_vote'), FILLER] } });
    advance(g, (x) => x.phase === 'vote' && x.round === 5);
    for (const i of [0, 1, 3]) ok(g.handle(ids[i], { t: 'vote', targetId: ids[4] }));
    ok(play(g, ids[2], 'cancel_vote', { at: at(g, ids[2]) }));
    assert.equal(P(g, ids[4]).status, 'alive');
    assert.equal(g.round, 6);
    assert.equal(g.lastVoteResult.cancelled, true);
  });

  test('a ×2 meant for the main ballot, arriving in the defense after a tie, is refused; replayed there it counts in the revote', () => {
    const { g, ids } = started(6, { specials: { 2: [sp('double_vote'), FILLER] } });
    advance(g, (x) => x.phase === 'vote' && x.round === 5);
    const clickedOn = at(g, ids[2]);
    tie(g, ids[1], ids[3]);
    assert.equal(g.phase, 'defense');
    const before = snap(g);
    err(play(g, ids[2], 'double_vote', { at: clickedOn }), 'wrong_phase');
    assert.equal(snap(g), before);
    ok(play(g, ids[2], 'double_vote', { at: at(g, ids[2]) }));
    assert.deepEqual(g.view(ids[0]).voteMods.doubleVote, [ids[2]]);
  });

  test('a card from the previous ballot of the same step is refused (ballot 1 → ballot 2)', () => {
    // N=6, round 5's vote cancelled in advance → round 6 has two ballots
    const { g, ids } = started(6, { specials: { 0: [sp('cancel_vote'), FILLER], 5: [sp('cancel_vote'), FILLER] } });
    advance(g, (x) => x.phase === 'reveal' && x.round === 5);
    ok(play(g, ids[0], 'cancel_vote'));
    advance(g, (x) => x.phase === 'vote' && x.round === 6);
    assert.equal(g.step.ballots, 2);
    const clickedOn = at(g, ids[5]);
    for (const voter of [...g.vote.voters]) if (g.step.ballot === 1) ok(g.handle(voter, { t: 'vote', targetId: voter === ids[1] ? ids[2] : ids[1] }));
    assert.equal(P(g, ids[1]).status, 'ejected');
    assert.equal(g.step.ballot, 2);
    err(play(g, ids[5], 'cancel_vote', { at: clickedOn }), 'wrong_phase');
    assert.equal(g.phase, 'vote', 'ballot 2 still runs');
  });

  test('whose turn it is does not matter: `turnIndex` is not compared for a special', () => {
    const { g, ids } = started(4, { specials: { 3: [sp('mass_reveal', { category: 'hobby' }), FILLER] } });
    const clickedOn = at(g, ids[3]);
    ok(g.handle(g.hostId, { t: 'next', at: at(g) })); // the speaker changes while the card is in flight
    assert.equal(g.turn.index, 1);
    ok(play(g, ids[3], 'mass_reveal', { at: clickedOn }));
    assert.ok(g.players.every((p) => p.cards.hobby.revealed));
    // but a stale round is refused: a card made in round 1's reveal, arriving in round 2's (§11 Z2 lets it into round
    // 1's discussion, see regressions-f2)
    const g2 = started(4, { specials: { 3: [sp('mass_reveal', { category: 'hobby' }), FILLER] } }).g;
    const k = at(g2, g2.players[3].id);
    while (g2.round === 1) ok(g2.handle(g2.hostId, { t: 'next' }));
    assert.equal(g2.phase, 'reveal');
    err(play(g2, g2.players[3].id, 'mass_reveal', { at: k }), 'wrong_phase');
  });

  test('precedence: lobby/final keep their own wrong_phase; a stale key wins over not_allowed; no key = as before', () => {
    const lobby = createGame({ minPlayers: 2 });
    const h = lobby.join('H').id;
    const r = lobby.handle(h, { t: 'special', uid: 's1', at: { phase: 'vote' } });
    err(r, 'wrong_phase');
    assert.match(r.message, /during the game/);
    const { g, ids } = started(4, { specials: { 1: [sp('immunity'), FILLER] } });
    const w = g.join('Watcher', { spectator: true }).id;
    err(g.handle(w, { t: 'special', uid: 's1', at: { phase: 'discussion' } }), 'wrong_phase');
    err(g.handle(w, { t: 'special', uid: 's1' }), 'not_allowed');
    err(g.handle(ids[1], { t: 'special', uid: 'nope', at: { round: 3 } }), 'wrong_phase');
    ok(play(g, ids[1], 'immunity'));
  });
});

describe('over real WebSockets: a special crossing the last vote of its ballot (SPEC §11 R3)', () => {
  test('the vote lands first → the card made on the open ballot is refused and stays in the hand', { timeout: 30000 }, async () => {
    const specials = { 2: [sp('cancel_vote'), FILLER] };
    const srv = await startInProcess({ port: 0, host: '127.0.0.1', noLimits: true, minPlayers: 2, seed: 'r2-cross', hostGraceMs: 45000, dealerFactory: () => makeDealer(specials), fixedSpecials: false, logger: () => {} });
    const socks = [];
    try {
      const url = `ws://127.0.0.1:${srv.port}/ws`;
      const client = async () => {
        const ws = new WebSocket(url);
        const c = { ws, msgs: [], state: null };
        ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'state') c.state = m; });
        await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
        socks.push(ws);
        c.send = (m) => ws.send(JSON.stringify(m));
        c.until = async (pred, ms = 5000) => {
          const t0 = Date.now();
          while (!pred(c)) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); }
        };
        return c;
      };
      const h = await client();
      h.send({ t: 'create', name: 'P0' });
      await h.until((c) => c.state);
      const cs = [h];
      for (let i = 1; i < 6; i++) {
        const c = await client();
        c.send({ t: 'join', room: h.state.room, name: `P${i}` });
        await c.until((x) => x.state);
        cs.push(c);
      }
      await h.until((c) => c.state.players.length === 6);
      h.send({ t: 'start' });
      await h.until((c) => c.state.phase === 'reveal');
      while (!(h.state.phase === 'vote' && h.state.round === 5)) {
        const before = h.msgs.length;
        h.send({ t: 'next', at: atOf(h.state) });
        await h.until((c) => c.msgs.length > before);
      }
      const ids = h.state.players.map((p) => p.id);
      const saver = cs[2];
      await saver.until((c) => c.state.phase === 'vote');
      for (const i of [0, 1, 3]) cs[i].send({ t: 'vote', targetId: ids[4], at: atOf(cs[i].state) });
      cs[4].send({ t: 'vote', targetId: ids[1], at: atOf(cs[4].state) });
      saver.send({ t: 'vote', targetId: ids[1], at: atOf(saver.state) });
      await saver.until((c) => c.state.vote && c.state.vote.voted.length === 5);
      const clickedOn = atOf(saver.state); // ballot 1, 5 of 6 voted
      const uid = saver.state.me.specials.find((x) => x.effect === 'cancel_vote').uid;
      cs[5].send({ t: 'vote', targetId: ids[4], at: atOf(cs[5].state) }); // the last vote
      await saver.until((c) => c.state.phase === 'reveal' && c.state.round === 6);
      const errs = saver.msgs.filter((m) => m.t === 'error').length;
      saver.send({ t: 'special', uid, at: clickedOn }); // the card, made on the open ballot, arrives now
      saver.send({ t: 'ping' });
      await saver.until((c) => c.msgs.filter((m) => m.t === 'pong').length >= 1);
      const e = saver.msgs.filter((m) => m.t === 'error');
      assert.equal(e.length, errs + 1);
      assert.equal(e[e.length - 1].code, 'wrong_phase');
      const s = saver.state;
      assert.equal(s.players.find((p) => p.id === ids[4]).status, 'ejected');
      assert.equal(s.voteMods.cancelNext, false);
      assert.equal(s.me.canPlaySpecial, true);
      assert.equal(s.me.specials.find((x) => x.uid === uid).used, false);
      assert.ok(!s.log.some((l) => /cancel_vote/.test(l.text)), 'no special was logged');
    } finally {
      for (const ws of socks) ws.terminate();
      await srv.close();
    }
  });
});

// ------------------------------------------------------------------------------------------------ ballots re-evaluated
describe('vote.ballots follows §2 while a step runs (SPEC §11 R4)', () => {
  test('a candidate leaves during "vote 1 of 2": 1 ballot now, the log says why, and the tally says "1 of 1"', () => {
    const { g, ids } = started(16);
    advance(g, (x) => x.phase === 'vote' && x.round === 6);
    let v = g.view(ids[0]);
    assert.deepEqual([v.vote.ballot, v.vote.ballots, v.schedule.kicksThisStep], [1, 2, 2]);
    const leaver = g.vote.candidates.find((x) => x !== g.hostId);
    const id0 = g.logSeq;
    ok(g.handle(leaver, { t: 'leave' }));
    v = g.view(ids[0]);
    assert.deepEqual([v.vote.ballot, v.vote.ballots, v.schedule.kicksThisStep], [1, 1, 1]);
    const name = P(g, leaver).name;
    assert.deepEqual(logSince(g, id0), [
      `${name} left the game`,
      `Round 6 — with ${name} gone, one ejection fewer is due: this vote now has 1 ballot instead of 2`,
    ]);
    ok(g.handle(g.hostId, { t: 'closeVote', at: at(g) }));
    const lines = logSince(g, id0);
    assert.ok(lines.some((l) => /^Round 6 — vote 1 of 1: /.test(l)), lines.join('\n'));
    assert.equal(g.phase, 'reveal');
    assert.equal(g.round, 7);
  });

  test('Extra Bunk during round 7\'s "vote 1 of 2" (N=14): 1 ballot now, logged', () => {
    const { g, ids } = started(14, { specials: { 13: [sp('capacity_plus'), FILLER] } });
    advance(g, (x) => x.phase === 'vote' && x.round === 7, [ids[13]]);
    assert.equal(g.step.ballots, 2);
    const id0 = g.logSeq;
    ok(play(g, ids[13], 'capacity_plus', { at: at(g, ids[13]) }));
    const v = g.view(ids[13]);
    assert.deepEqual([v.capacity, v.vote.ballot, v.vote.ballots, v.schedule.kicksThisStep], [8, 1, 1, 1]);
    assert.equal(logSince(g, id0)[1], 'Round 7 — with the extra bed, one ejection fewer is due: this vote now has 1 ballot instead of 2');
  });

  test('a kick during a defense in "vote 1 of 2": the revote is "1 of 1"', () => {
    const { g, ids } = started(16);
    advance(g, (x) => x.phase === 'vote' && x.round === 6);
    const [A, B] = g.vote.candidates.filter((x) => x !== g.hostId);
    tie(g, A, B);
    assert.equal(g.phase, 'defense');
    assert.equal(g.view(ids[0]).schedule.kicksThisStep, 2);
    const id0 = g.logSeq;
    ok(g.handle(g.hostId, { t: 'kick', playerId: A }));
    assert.equal(g.view(ids[0]).schedule.kicksThisStep, 1);
    assert.deepEqual(logSince(g, id0).slice(0, 2), [
      `${P(g, A).name} was removed by the host`,
      `Round 6 — with ${P(g, A).name} gone, one ejection fewer is due: this vote now has 1 ballot instead of 2`,
    ]);
    while (g.phase === 'defense') ok(g.handle(g.hostId, { t: 'next' }));
    assert.equal(g.vote.stage, 'revote');
    assert.equal(g.view(ids[0]).vote.ballots, 1);
  });

  test('the open ballot always counts: a leave during "vote 2 of 2" leaves it at 2 of 2 with no extra line', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('cancel_vote'), FILLER] } });
    advance(g, (x) => x.phase === 'reveal' && x.round === 5);
    ok(play(g, ids[0], 'cancel_vote'));
    advance(g, (x) => x.phase === 'vote' && x.round === 6 && x.step.ballot === 2);
    assert.equal(g.step.ballots, 2);
    const leaver = g.vote.candidates.find((x) => x !== g.hostId);
    const id0 = g.logSeq;
    ok(g.handle(leaver, { t: 'leave' }));
    assert.equal(g.phase, 'vote', '4 alive, 3 beds: the ballot goes on');
    assert.equal(formula(g), 0, 'the leave used up the last kick of round 6');
    assert.deepEqual([g.view(ids[0]).vote.ballot, g.view(ids[0]).vote.ballots], [2, 2]);
    assert.deepEqual(logSince(g, id0), [`${P(g, leaver).name} left the game`]);
    ok(g.handle(g.hostId, { t: 'closeVote', at: at(g) }));
    assert.ok(logSince(g, id0).some((l) => /^Round 6 — vote 2 of 2: /.test(l)));
    assert.ok(!logSince(g, id0).some((l) => /no more ejections/.test(l)));
  });

  test('both tied players leave during the defense: no contradicting lines, the step just ends', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('cancel_vote'), FILLER] } });
    advance(g, (x) => x.phase === 'reveal' && x.round === 5);
    ok(play(g, ids[0], 'cancel_vote'));
    advance(g, (x) => x.phase === 'vote' && x.round === 6);
    tie(g, ids[1], ids[2]);
    assert.equal(g.phase, 'defense');
    const id0 = g.logSeq;
    ok(g.handle(ids[1], { t: 'leave' }));
    assert.equal(g.view(ids[0]).schedule.kicksThisStep, 1);
    ok(g.handle(ids[2], { t: 'leave' }));
    const lines = logSince(g, id0);
    assert.equal(lines.filter((l) => /ejection fewer/.test(l)).length, 1, lines.join('\n'));
    assert.ok(!lines.some((l) => /vote 2 of|no more ejections/.test(l)), lines.join('\n'));
    assert.ok(g.phase === 'reveal' || g.phase === 'final');
  });

  test('random games with leaves, kicks and specials: in every vote view, ballots = (ballot − 1) + max(1, §2), never growing', () => {
    let ballotsSeen = 0;
    for (let seed = 1; seed <= 250; seed++) {
      const A = mulberry32(seed * 7919 + 3);
      const rnd = (n) => Math.floor(A() * n);
      const pick = (a) => a[rnd(a.length)];
      const n = 4 + rnd(13);
      const g = createGame({ room: 'FZ', rng: mulberry32(seed), now: () => 5e6, minPlayers: 2, dealer: createDealer(mulberry32(seed + 1)) });
      const ids = [];
      for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`).id);
      ok(g.handle(ids[0], { t: 'start' }));
      let last = null;
      for (let step = 0; step < 4000 && g.phase !== 'final'; step++) {
        const everyone = g.players.filter((p) => p.status !== 'left').map((p) => p.id);
        const r = A();
        let actor;
        let msg;
        if (r < 0.012) { actor = pick(everyone); msg = { t: 'leave' }; } else if (r < 0.02) { actor = g.hostId; msg = { t: 'kick', playerId: pick(everyone) }; } else if (r < 0.2) {
          actor = pick(everyone);
          const s = pick(P(g, actor).specials);
          if (!s) continue;
          const t = pick(g.players);
          const hidden = t.cards ? CATEGORY_IDS.filter((c) => !t.cards[c].revealed) : [];
          msg = { t: 'special', uid: s.uid, targetId: t.id, category: pick(hidden.length ? hidden : CATEGORY_IDS) };
        } else if (g.phase === 'vote') {
          if (A() < 0.05) { actor = g.hostId; msg = { t: 'closeVote' }; } else {
            actor = pick(g.vote.voters.length ? g.vote.voters : everyone);
            const c = g.vote.candidates.filter((x) => x !== actor);
            msg = { t: 'vote', targetId: c.length ? c[rnd(Math.min(2, c.length))] : actor };
          }
        } else { actor = g.hostId; msg = { t: 'next' }; }
        const res = g.handle(actor, msg);
        assert.ok(!res.internal, String(g.lastError?.stack));
        const v = g.view(g.hostId) || g.view(everyone.find((x) => g.view(x)));
        if (v && v.phase === 'vote') {
          ballotsSeen++;
          const want = v.vote.ballot - 1 + Math.max(1, formula(g));
          assert.equal(v.vote.ballots, want, `seed ${seed} ${JSON.stringify(msg)}`);
          assert.equal(v.schedule.kicksThisStep, v.vote.ballots);
          if (last && last.round === v.round && last.overtime === v.overtime && last.ballot === v.vote.ballot) {
            assert.ok(v.vote.ballots <= last.ballots, `seed ${seed}: ballots grew within ballot ${v.vote.ballot}`);
          }
          last = { round: v.round, overtime: v.overtime, ballot: v.vote.ballot, ballots: v.vote.ballots };
        } else if (v && v.phase !== 'defense') last = null;
      }
      assert.equal(g.phase, 'final', `seed ${seed} did not finish`);
    }
    assert.ok(ballotsSeen > 1000, `only ${ballotsSeen} vote views`);
  });
});

// ------------------------------------------------------------------------------------------------ cancel wording
describe('a vote cancelled after an earlier ballot ejected someone', () => {
  test('Blackout during "vote 2 of 2": "the rest of the vote is cancelled", "no further ejections", not "without an ejection"', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('cancel_vote'), FILLER], 1: [sp('cancel_vote'), FILLER], 2: [sp('immunity'), FILLER] } });
    advance(g, (x) => x.phase === 'reveal' && x.round === 5);
    ok(play(g, ids[0], 'cancel_vote'));
    advance(g, (x) => x.phase === 'reveal' && x.round === 6);
    ok(play(g, ids[2], 'immunity'));
    advance(g, (x) => x.phase === 'vote');
    advance(g, (x) => x.phase === 'vote' && x.step.ballot === 2, [ids[1], ids[2]]);
    const id0 = g.logSeq;
    ok(play(g, ids[1], 'cancel_vote', { at: at(g, ids[1]) }));
    const lines = logSince(g, id0);
    assert.match(lines[0], /→ the rest of the vote is cancelled right now; the kicks still due carry over$/);
    assert.equal(lines[1], "Round 6 — no further ejections in this vote. P2's immunity was for this vote and is used up");
    assert.ok(!lines.some((l) => /without an ejection/.test(l)));
  });

  test('"everyone is immune" at ballot 2 after ballot 1 ejected the only candidate: "no further ejections in this vote"', () => {
    const imm = sp('immunity');
    const { g, ids } = started(6, { specials: { 0: [sp('cancel_vote'), imm], 1: [imm], 2: [imm], 3: [imm], 4: [imm] } });
    advance(g, (x) => x.phase === 'reveal' && x.round === 5);
    ok(play(g, ids[0], 'cancel_vote'));
    advance(g, (x) => x.phase === 'reveal' && x.round === 6);
    for (const i of [0, 1, 2, 3, 4]) ok(play(g, ids[i], 'immunity'));
    const id0 = g.logSeq;
    advance(g, (x) => x.round === 7);
    const lines = logSince(g, id0);
    assert.equal(P(g, ids[5]).status, 'ejected');
    assert.ok(lines.includes('Round 6 — everyone is immune: the rest of the vote is cancelled'), lines.join('\n'));
    assert.ok(lines.some((l) => /^Round 6 — no further ejections in this vote\. P0's immunity/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /without an ejection/.test(l)));
  });

  test('control: a vote cancelled before any ejection still says "the vote ends without an ejection"', () => {
    const { g, ids } = started(6, { specials: { 1: [sp('cancel_vote'), FILLER], 2: [sp('immunity'), FILLER] } });
    advance(g, (x) => x.phase === 'reveal' && x.round === 5);
    ok(play(g, ids[2], 'immunity'));
    advance(g, (x) => x.phase === 'vote');
    const id0 = g.logSeq;
    ok(play(g, ids[1], 'cancel_vote'));
    const lines = logSince(g, id0);
    assert.match(lines[0], /→ the vote is cancelled right now; the kicks carry over$/);
    assert.equal(lines[1], "Round 5 — the vote ends without an ejection. P2's immunity was for this vote and is used up");
  });
});

// ------------------------------------------------------------------------------------------------ host role
function fakeConn(ip) {
  const c = { ip, out: [], send(obj) { c.out.push(JSON.parse(JSON.stringify(obj))); } };
  c.last = (t) => [...c.out].reverse().find((m) => !t || m.t === t);
  return c;
}
function registry(extra = {}) {
  const clock = { t: 5_000_000 };
  const rooms = new Rooms({ rng: mulberry32(99), minPlayers: 2, hostGraceMs: 45_000, now: () => clock.t, ...extra });
  const conn = (ip = '203.0.113.7') => { const c = fakeConn(ip); rooms.open(c); return c; };
  const send = (c, msg) => rooms.message(c, JSON.stringify(msg));
  return { rooms, clock, conn, send };
}

describe('"Make host" on a player who has been offline a while (SPEC §11 H1)', () => {
  test('the new host keeps the role for the full grace period, counted from the handover', () => {
    const { rooms, clock, conn, send } = registry();
    const a = conn();
    send(a, { t: 'create', name: 'Alice' });
    const { room } = a.out[0];
    const others = ['Bob', 'Carol', 'Dave'].map((name) => { const c = conn(); send(c, { t: 'join', room, name }); return c; });
    send(a, { t: 'start' });
    const id = (name) => a.last('state').players.find((p) => p.name === name).id;
    rooms.close(others[1]); // Carol drops
    clock.t += 120_000;
    send(a, { t: 'transferHost', playerId: id('Carol') });
    assert.equal(a.last('state').hostId, id('Carol'));
    clock.t += 500;
    rooms.sweep();
    assert.equal(a.last('state').hostId, id('Carol'), 'not bounced at the next sweep');
    clock.t += 45_000 - 500 - 1;
    rooms.sweep();
    assert.equal(a.last('state').hostId, id('Carol'), 'still within the grace');
    clock.t += 1;
    rooms.sweep();
    assert.equal(a.last('state').hostId, id('Alice'), 'Carol did not come back within the grace: the first connected player');
    assert.match(a.last('state').log.at(-1).text, /^Carol has been offline for a while — Alice is now the host$/);
  });

  test('unchanged: a host who drops passes the role 45 s after the disconnect', () => {
    const { rooms, clock, conn, send } = registry();
    const a = conn();
    send(a, { t: 'create', name: 'Alice' });
    const b = conn();
    send(b, { t: 'join', room: a.out[0].room, name: 'Bob' });
    clock.t += 10_000;
    rooms.close(a);
    clock.t += 44_999;
    rooms.sweep();
    assert.equal(b.last('state').hostId, a.out[0].id);
    clock.t += 1;
    rooms.sweep();
    assert.equal(b.last('state').hostId, b.out[0].id);
  });
});

// ------------------------------------------------------------------------------------------------ log and card texts
describe('log lines and card texts', () => {
  test('an in-game kick reads "X was removed by the host" (no dangling "the game"); a leave "X left the game"', () => {
    const { g, ids } = started(6);
    ok(g.handle(g.hostId, { t: 'kick', playerId: ids[3] }));
    assert.equal(g.log.at(-1).text, 'P3 was removed by the host');
    ok(g.handle(ids[4], { t: 'leave' }));
    assert.equal(g.log.at(-1).text, 'P4 left the game');
    assert.ok(!g.log.some((e) => /host the game/.test(e.text)));
  });

  test('a kick that ends the game is the line before "The bunker door closes", in the words the final banner looks for', () => {
    const { g, ids } = started(4);
    ok(g.handle(g.hostId, { t: 'kick', playerId: ids[2] }));
    ok(g.handle(g.hostId, { t: 'kick', playerId: ids[3] }));
    assert.equal(g.phase, 'final');
    const i = g.log.findIndex((e) => /^The bunker door closes/.test(e.text));
    const cause = g.log[i - 1];
    assert.equal(cause.kind, 'info');
    assert.match(cause.text, /\b(left|removed by the host)\b/); // public/app.js finalCause()
    assert.equal(cause.text, 'P3 was removed by the host');
  });

  test('"Back from the Forest" promises no turn that never comes', () => {
    const revive = REVIVE_CARD; // a fixed card since §11 X1 (never in the random pool)
    assert.doesNotMatch(revive.text, /next round/);
    assert.match(revive.text, /no turn in a reveal phase that began without them, and round 7 has the last reveal phase/);
  });

  test('the deck: at most 3 of the 52 pool specials reveal a category for everyone (mass_reveal, shuffle_category)', () => {
    const d = createDealer(mulberry32(2));
    const deck = Array.from({ length: 52 }, () => d.drawSpecial());
    assert.equal(new Set(deck.map((c) => c.id)).size, 52, 'each card once');
    assert.equal(new Set(deck.map((c) => c.title)).size, 52, 'titles are distinct');
    const mass = deck.filter((c) => c.effect === 'mass_reveal' || c.effect === 'shuffle_category');
    assert.ok(mass.length <= 3, mass.map((c) => c.title).join(', '));
    assert.ok(mass.length >= 1, 'the effects still exist');
  });
});

// ------------------------------------------------------------------------------------------------ room code scanning
describe('room codes cannot be scanned from one network (SPEC §11 V2)', () => {
  test(`${JOIN_FAIL_BURST} failed lookups, then join and resume answer server_busy whether or not the room exists; it refills`, () => {
    const { rooms, clock, conn, send } = registry();
    const host = conn('198.51.100.9');
    send(host, { t: 'create', name: 'Host' });
    const { room, token } = host.out[0];
    const scan = conn('203.0.113.50');
    for (let i = 0; i < JOIN_FAIL_BURST; i++) {
      send(scan, { t: 'join', room: i % 2 ? 'QQQQ' : 'ZZZZ', name: 'x' });
      assert.equal(scan.last().code, 'no_room');
    }
    send(scan, { t: 'join', room, name: 'x' }); // the right code, but the budget is used up
    assert.equal(scan.last().t, 'error');
    assert.equal(scan.last().code, 'server_busy');
    assert.match(scan.last().message, /Too many wrong room codes/);
    send(scan, { t: 'resume', room, token: 'not-a-token' }); // §11 Z1: only a valid room *and* token get past (regressions-f2)
    assert.equal(scan.last().code, 'server_busy');
    send(scan, { t: 'resume', room: 'QQQQ', token });
    assert.equal(scan.last().code, 'server_busy');
    const same = conn('203.0.113.50'); // a new socket from the same address is no way around it
    send(same, { t: 'join', room, name: 'y' });
    assert.equal(same.last().code, 'server_busy');
    const other = conn('192.0.2.1'); // another network is unaffected
    send(other, { t: 'join', room, name: 'Friend' });
    assert.equal(other.out[0].t, 'joined');
    clock.t += JOIN_FAIL_REFILL_MS;
    send(scan, { t: 'join', room, name: 'Late' });
    assert.equal(scan.out.at(-2).t, 'joined', 'one lookup per refill interval');
    assert.equal(rooms.game ?? null, null);
    clock.t += JOIN_FAIL_BURST * JOIN_FAIL_REFILL_MS;
    rooms.sweep();
    assert.equal(rooms.lookupBudget.size, 0, 'full budgets are forgotten');
  });

  test('bad tokens count too; successful joins and resumes do not; no limit without an address or with BUNKER_NO_LIMITS', () => {
    const { conn, send } = registry();
    const host = conn('198.51.100.9');
    send(host, { t: 'create', name: 'Host' });
    const { room, token } = host.out[0];
    const c = conn('203.0.113.60');
    for (let i = 0; i < 40; i++) send(c, { t: 'resume', room, token });
    assert.equal(c.last().t, 'state', 'a valid resume never counts');
    for (let i = 0; i < JOIN_FAIL_BURST; i++) send(c, { t: 'resume', room, token: `bad${i}` });
    assert.equal(c.last().code, 'bad_token');
    send(c, { t: 'resume', room, token: 'bad-again' });
    assert.equal(c.last().code, 'server_busy');
    send(c, { t: 'resume', room, token }); // §11 Z1: the network's own seat still comes back
    assert.equal(c.last().t, 'state');
    const free = registry({ joinFailBurst: Infinity });
    const f = free.conn('203.0.113.70');
    for (let i = 0; i < 100; i++) free.send(f, { t: 'join', room: 'QQQQ', name: 'x' });
    assert.equal(f.last().code, 'no_room');
    const unknown = registry();
    const u = unknown.conn(null);
    for (let i = 0; i < 100; i++) unknown.send(u, { t: 'join', room: 'QQQQ', name: 'x' });
    assert.equal(u.last().code, 'no_room');
  });

  test('over real WebSockets with limits on: the 21st wrong code from one address gets server_busy', { timeout: 30000 }, async () => {
    const server = await startServer({ seed: 91, noLimits: false });
    const socks = [];
    try {
      const url = `ws://127.0.0.1:${server.port}/ws`;
      const ws = new WebSocket(url);
      socks.push(ws);
      const replies = [];
      ws.on('message', (d) => replies.push(JSON.parse(d)));
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      for (let i = 0; i <= JOIN_FAIL_BURST; i++) {
        ws.send(JSON.stringify({ t: 'join', room: 'QQQQ', name: 'x' }));
        await new Promise((r) => setTimeout(r, 70)); // under the 20 messages/s limiter
      }
      const t0 = Date.now();
      while (replies.length < JOIN_FAIL_BURST + 1 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(replies.map((m) => m.code), [...Array(JOIN_FAIL_BURST).fill('no_room'), 'server_busy']);
      assert.deepEqual(server.problems(), []);
    } finally {
      for (const ws of socks) ws.terminate();
      await server.stop();
    }
  });

  test('with BUNKER_NO_LIMITS=1 (tests, bots) there is no such budget', { timeout: 30000 }, async () => {
    const server = await startServer({ seed: 92, noLimits: true });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const replies = [];
      ws.on('message', (d) => replies.push(JSON.parse(d)));
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      for (let i = 0; i < 40; i++) ws.send(JSON.stringify({ t: 'join', room: 'QQQQ', name: 'x' }));
      const t0 = Date.now();
      while (replies.length < 40 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
      ws.terminate();
      assert.equal(replies.length, 40);
      assert.ok(replies.every((m) => m.code === 'no_room'));
    } finally {
      await server.stop();
    }
  });
});

// KICKS is imported to keep this file honest about the schedule it relies on (N=6 → round 5 and 6 have one kick each).
assert.deepEqual(KICKS[6], [0, 0, 0, 0, 1, 1, 1]);
assert.deepEqual(KICKS[16].slice(5), [2, 2]);
