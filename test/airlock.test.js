// SPEC §11 X1 engine tests: the cooperative Airlock (open / join / expire), the guaranteed Airlock + revive deal, and
// how they meet the rest of the rules (revive, immunity, cancel_vote, leave, kick, the end check, overtime, Play again).
// Drives server/game.js through its §8 interface. Hand-made deals use `fixedSpecials: false` (the dealer then fills
// every slot); the deal tests use the engine's own fixed deal.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, EFFECTS, fixedDeal } from '../server/game.js';
import { AIRLOCK_CARD, REVIVE_CARD, createDealer } from '../server/content.js';
import { Rooms } from '../server/rooms.js';
import { mulberry32 } from '../server/rng.js';
import { validateStateView } from './stateview-schema.js';

// ------------------------------------------------------------------------------------------------ helpers
const FILLER = { id: 'filler', title: 'Blueprint', text: 'Adds a bunker feature.', effect: 'bunker_add_feature', target: 'none' };
const sp = (effect, extra = {}) => ({ id: effect, title: `T:${effect}`, text: `Card text for ${effect}`, effect, target: EFFECTS[effect].targets[0], ...extra });
const AIR = AIRLOCK_CARD;
const REV = REVIVE_CARD;

/** specials[seat] = [first, second] (filler otherwise), dealt in seat order. */
function handDealer(specials = {}) {
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
    drawBunker() { return { name: 'Test bunker', size: '50 m2', duration: '1 year', food: '1 year', features: ['Well', 'Gym', 'Lab'] }; },
    drawBunkerFeature() { cardN++; return `<feature#${cardN}>`; },
  };
}

function started(n, { specials = {}, seed = 7, spectators = 1, fixedSpecials = false, dealer = null } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const g = createGame({ room: 'TEST', rng: mulberry32(seed), now: () => clock.t++, minPlayers: 2, dealer: dealer || handDealer(specials), fixedSpecials });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`).id);
  const specs = [];
  for (let i = 0; i < spectators; i++) specs.push(g.join(`S${i}`, { spectator: true }).id);
  ok(g.handle(ids[0], { t: 'start' }));
  return { g, ids, specs, host: ids[0], clock };
}
function ok(res) { assert.deepEqual(res, { ok: true }, JSON.stringify(res)); }
function err(res, code, re) {
  assert.equal(res.ok, false, `expected ${code}, got ok`);
  assert.equal(res.code, code, `expected ${code}, got ${res.code}: ${res.message}`);
  if (re) assert.match(res.message, re);
}
const P = (g, id) => g.players.find((p) => p.id === id);
const status = (g, id) => P(g, id).status;
const name = (g, id) => P(g, id).name;
function uidOf(g, id, effect) {
  const c = P(g, id).specials.find((x) => x.effect === effect && !x.used);
  assert.ok(c, `${id} holds no unused ${effect}`);
  return c.uid;
}
const play = (g, id, effect, extra = {}) => g.handle(id, { t: 'special', uid: uidOf(g, id, effect), ...extra });
const airlock = (g, by, target) => play(g, by, 'airlock', { targetId: target });
function next(g) { ok(g.handle(g.hostId, { t: 'next' })); }
/** Next until (round, phase); a ballot on the way ejects the first candidate not in `keep` (everyone votes for them). */
function advanceTo(g, round, phase, keep = []) {
  for (let i = 0; i < 3000 && !(g.round === round && g.phase === phase); i++) {
    assert.notEqual(g.phase, 'final', `the game ended before round ${round} ${phase}`);
    if (g.phase === 'vote' && keep.length) {
      const target = g.vote.candidates.find((c) => !keep.includes(c));
      assert.ok(target, 'someone to vote out');
      for (const voter of [...g.vote.voters]) if (voter !== target && g.phase === 'vote') ok(g.handle(voter, { t: 'vote', targetId: target }));
      if (g.phase === 'vote' && g.vote && g.vote.candidates.includes(target)) next(g);
    } else next(g);
  }
  assert.deepEqual([g.round, g.phase], [round, phase]);
}
const texts = (g) => g.log.map((e) => e.text);
const openLine = (g, a, t) => `🚪 ${name(g, a)} started cycling the airlock on ${name(g, t)}. If one more Airlock card is played on ${name(g, t)} before ${g.overtime ? 'the overtime discussion ends' : "this round's discussion ends"}, ${name(g, t)} is out — no vote.`;
const sealLine = (g, a, b, t) => `🚪 ${name(g, a)} sealed the airlock with ${name(g, b)} — ${name(g, t)} is thrown out of the bunker, no vote!`;
const jamLine = (g, t) => `🚪 The airlock on ${name(g, t)} jammed — nobody closed it.`;
/** Every recipient's view: valid by the strict §7 validator, and the same `airlocks` for everyone (a public field). */
function views(g) {
  const ids = [...g.players.filter((p) => p.status !== 'left').map((p) => p.id), ...g.spectators.map((s) => s.id)];
  const vs = ids.map((id) => g.view(id));
  for (const v of vs) assert.deepEqual(validateStateView(v), [], `${v.you.id} ${v.phase} r${v.round}`);
  for (const v of vs) assert.deepEqual(v.airlocks, vs[0].airlocks, 'airlocks are identical for every recipient');
  return vs;
}
const pubAirlocks = (g) => views(g)[0].airlocks;

// ------------------------------------------------------------------------------------------------ the deal
describe('§11 X1 deal: AIRLOCKS(N) and REVIVES(N) fixed cards', () => {
  test('the table: 2/1 for 4–7, 3/1 for 8–11, 4/2 for 12–16, none under 4', () => {
    for (let n = 0; n <= 17; n++) {
      const want = n < 4 ? [0, 0] : n <= 7 ? [2, 1] : n <= 11 ? [3, 1] : [4, 2];
      const d = fixedDeal(n);
      assert.deepEqual([d.airlocks, d.revives], n > 16 ? [4, 2] : want, `N=${n}`);
    }
  });

  test('every N from 2 to 16, many seeds, real content: exact counts, distinct holders, revive holders hold no Airlock', () => {
    const holderSeats = { airlock: new Set(), revive: new Set() };
    for (let n = 2; n <= 16; n++) {
      for (let seed = 1; seed <= 25; seed++) {
        const g = createGame({ room: 'DEAL', rng: mulberry32(seed * 31 + n), now: () => 1, minPlayers: 2 });
        for (let i = 0; i < n; i++) g.join(`P${i}`);
        ok(g.handle(g.players[0].id, { t: 'start' }));
        const { airlocks, revives } = fixedDeal(n);
        let a = 0;
        let r = 0;
        for (const p of g.players) {
          assert.equal(p.specials.length, 2);
          const pa = p.specials.filter((c) => c.effect === 'airlock').length;
          const pr = p.specials.filter((c) => c.effect === 'revive').length;
          assert.ok(pa <= 1 && pr <= 1 && !(pa && pr), `N=${n} seed ${seed}: ${p.id} holds ${pa} Airlock(s), ${pr} revive(s)`);
          assert.ok(!p.specials.some((c) => c.effect === 'eject'), 'the retired eject is never dealt');
          if (pa) holderSeats.airlock.add(`${n}:${p.seat}`);
          if (pr) holderSeats.revive.add(`${n}:${p.seat}`);
          a += pa;
          r += pr;
          for (const c of p.specials.filter((x) => x.effect === 'airlock')) {
            assert.deepEqual({ title: c.title, text: c.text, target: c.target, category: c.category, timing: c.timing, minRound: c.minRound, used: c.used },
              { title: AIR.title, text: AIR.text, target: 'other', category: null, timing: 'before_vote', minRound: 2, used: false });
          }
          for (const c of p.specials.filter((x) => x.effect === 'revive')) {
            assert.deepEqual({ title: c.title, text: c.text, target: c.target, category: c.category, timing: c.timing, minRound: c.minRound },
              { title: REV.title, text: REV.text, target: 'ejected', category: null, timing: 'before_vote', minRound: 1 });
          }
        }
        assert.deepEqual([a, r], [airlocks, revives], `N=${n} seed ${seed}`);
        const uids = g.players.flatMap((p) => p.specials.map((c) => c.uid));
        assert.equal(new Set(uids).size, uids.length, 'uids stay unique');
      }
    }
    // random, not always the same seats
    assert.ok(holderSeats.airlock.size > 100 && holderSeats.revive.size > 60, `${holderSeats.airlock.size} / ${holderSeats.revive.size}`);
  });

  test('deterministic for a seeded rng: the same seed deals the same hands, other seeds differ', () => {
    const deal = (seed) => {
      const g = createGame({ room: 'DEAL', rng: mulberry32(seed), now: () => 1, minPlayers: 2 });
      for (let i = 0; i < 10; i++) g.join(`P${i}`);
      g.handle(g.players[0].id, { t: 'start' });
      return JSON.stringify(g.players.map((p) => p.specials.map((c) => `${c.uid}:${c.id}`)));
    };
    assert.equal(deal(42), deal(42));
    const others = new Set([1, 2, 3, 4, 5, 6].map(deal));
    assert.ok(others.size >= 5, 'the deal follows the seed');
    // the fixed card takes either slot
    const slots = new Set();
    for (let seed = 1; seed <= 30; seed++) {
      const g = createGame({ room: 'DEAL', rng: mulberry32(seed), now: () => 1, minPlayers: 2 });
      for (let i = 0; i < 6; i++) g.join(`P${i}`);
      g.handle(g.players[0].id, { t: 'start' });
      for (const p of g.players) p.specials.forEach((c, i) => { if (c.effect === 'airlock') slots.add(i); });
    }
    assert.deepEqual([...slots].sort(), [0, 1]);
  });

  test('Play again deals again, for the new N (a player who left is gone)', () => {
    const { g, ids } = started(8, { fixedSpecials: true, dealer: createDealer(mulberry32(3)), seed: 3 });
    const count = (effect) => g.players.filter((p) => p.specials.some((c) => c.effect === effect)).length;
    const kick = (k) => { for (let i = 0; i < k; i++) ok(g.handle(g.hostId, { t: 'kick', playerId: g.players.filter((p) => p.status !== 'left' && p.id !== g.hostId).pop().id })); };
    assert.deepEqual([count('airlock'), count('revive')], [3, 1]);
    ok(g.handle(ids[7], { t: 'leave' }));
    while (g.phase !== 'final') next(g);
    ok(g.handle(g.hostId, { t: 'playAgain' }));
    assert.equal(g.phase, 'lobby');
    assert.deepEqual(views(g)[0].airlocks, []);
    assert.ok(g.players.every((p) => p.specials.length === 0), 'nothing dealt in the lobby');
    ok(g.handle(g.hostId, { t: 'start' }));
    assert.equal(g.players.length, 7);
    assert.deepEqual([count('airlock'), count('revive')], [2, 1], 'N = 7 now');
    kick(4); // alive 3 <= 3 beds
    assert.equal(g.phase, 'final');
    ok(g.handle(g.hostId, { t: 'playAgain' }));
    g.join('Late');
    ok(g.handle(g.hostId, { t: 'start' }));
    assert.equal(g.players.length, 4);
    assert.deepEqual([count('airlock'), count('revive')], [2, 1]);
    kick(2);
    assert.equal(g.phase, 'final');
    ok(g.handle(g.hostId, { t: 'playAgain' }));
    g.join('Later');
    ok(g.handle(g.hostId, { t: 'start' }));
    assert.equal(g.players.length, 3, 'a test table');
    assert.deepEqual([count('airlock'), count('revive')], [0, 0], 'no fixed cards under 4 players');
  });

  test('with the fixed deal on, drawSpecial() cannot add Airlocks, revives or eject (they are redrawn); off, the dealer rules', () => {
    // a dealer that offers the fixed effects first, then fillers
    const greedy = () => {
      let k = 0;
      const d = handDealer();
      d.drawSpecial = () => ({ ...[AIR, REV, sp('eject'), AIR, REV][k++ % 7] ?? FILLER });
      return d;
    };
    const on = started(6, { fixedSpecials: true, dealer: greedy() }).g;
    const n = (g, e) => g.players.flatMap((p) => p.specials).filter((c) => c.effect === e).length;
    assert.deepEqual([n(on, 'airlock'), n(on, 'revive'), n(on, 'eject')], [2, 1, 0]);
    const off = started(6, { fixedSpecials: false, dealer: greedy() }).g;
    assert.ok(n(off, 'airlock') + n(off, 'revive') + n(off, 'eject') > 3, 'fixedSpecials: false leaves the deal to the dealer');
  });

  test('rooms.js deals the fixed cards by default (and passes fixedSpecials: false through for tests)', () => {
    for (const fixedSpecials of [undefined, false]) {
      const rooms = new Rooms({ rng: mulberry32(9), minPlayers: 2, ...(fixedSpecials === false ? { fixedSpecials, dealerFactory: () => handDealer() } : {}) });
      const conns = [];
      const conn = () => { const c = { ip: '192.0.2.1', sent: [], send(o) { this.sent.push(o); } }; rooms.open(c); conns.push(c); return c; };
      const h = conn();
      rooms.message(h, JSON.stringify({ t: 'create', name: 'H' }));
      const code = h.sent.find((m) => m.t === 'joined').room;
      for (let i = 0; i < 5; i++) rooms.message(conn(), JSON.stringify({ t: 'join', room: code, name: `J${i}` }));
      rooms.message(h, JSON.stringify({ t: 'start' }));
      const g = rooms.rooms.get(code).game;
      const air = g.players.filter((p) => p.specials.some((c) => c.effect === 'airlock')).length;
      assert.equal(air, fixedSpecials === false ? 0 : 2);
    }
  });
});

// ------------------------------------------------------------------------------------------------ playing an Airlock
describe('§11 X1 Airlock: open and join', () => {
  const deal6 = { 0: [AIR, FILLER], 1: [AIR, FILLER], 2: [AIR, FILLER], 3: [REV, FILLER] };

  test('when it can be played: round 2+, reveal or discussion, on another alive player', () => {
    const { g, ids, specs } = started(6, { specials: deal6 });
    err(airlock(g, ids[0], ids[4]), 'not_allowed', /round 2/);
    advanceTo(g, 2, 'reveal');
    err(airlock(g, ids[0], ids[0]), 'not_allowed'); // the joiner can never be the target: target 'other'
    err(airlock(g, ids[0], 'nobody'), 'not_allowed');
    err(airlock(g, ids[0], specs[0]), 'not_allowed');
    err(g.handle(specs[0], { t: 'special', uid: P(g, ids[0]).specials[0].uid, targetId: ids[4] }), 'not_allowed');
    ok(g.handle(ids[5], { t: 'leave' }));
    err(airlock(g, ids[0], ids[5]), 'not_allowed', /still in the game/);
    advanceTo(g, 6, 'vote'); // with P5 gone, round 5 has nothing to vote on
    err(airlock(g, ids[0], ids[4]), 'wrong_phase', /before the vote/);
    assert.equal(P(g, ids[0]).specials[0].used, false, 'a refused play changes nothing');
  });

  test('the first Airlock opens an airlock: public, logged, the card spent; nothing else happens', () => {
    const { g, ids } = started(6, { specials: deal6 });
    advanceTo(g, 2, 'reveal');
    const before = g.view(ids[5]).schedule;
    ok(airlock(g, ids[0], ids[4]));
    assert.equal(status(g, ids[4]), 'alive');
    assert.deepEqual(pubAirlocks(g), [{ targetId: ids[4], byIds: [ids[0]], round: 2 }]);
    const last = g.log[g.log.length - 1];
    assert.deepEqual([last.kind, last.text], ['special', openLine(g, ids[0], ids[4])]);
    assert.equal(P(g, ids[0]).specials[0].used, true);
    assert.deepEqual(g.view(ids[5]).players[0].playedSpecials, [{ title: AIR.title, text: AIR.text }]);
    assert.equal(g.view(ids[0]).me.canPlaySpecial, false, 'one special per round');
    assert.deepEqual(g.view(ids[5]).schedule, before, 'an open airlock changes nothing in the schedule');
    assert.equal(g.phase, 'reveal');
  });

  test('a second Airlock on the same player by someone else throws them out at once: no vote, counts for §2', () => {
    const { g, ids, specs } = started(6, { specials: deal6 });
    advanceTo(g, 2, 'discussion');
    ok(airlock(g, ids[0], ids[4]));
    const lvr = g.lastVoteResult;
    ok(airlock(g, ids[1], ids[4]));
    assert.equal(status(g, ids[4]), 'ejected');
    const last = g.log[g.log.length - 1];
    assert.deepEqual([last.kind, last.text], ['eject', sealLine(g, ids[1], ids[0], ids[4])]);
    assert.deepEqual(pubAirlocks(g), [], 'the airlock closes');
    assert.equal(g.phase, 'discussion', 'no vote');
    assert.equal(g.lastVoteResult, lvr, 'not a vote result');
    const v = g.view(specs[0]);
    assert.equal(v.schedule.outCount, 1);
    assert.equal(v.players[4].status, 'ejected');
    assert.equal(v.players[4].cards.health, null, 'their hidden cards stay hidden');
    assert.deepEqual(v.players[1].playedSpecials, [{ title: AIR.title, text: AIR.text }]);
    // N=6 votes once in round 5: the airlock ejection already covers it
    advanceTo(g, 5, 'discussion');
    assert.equal(g.view(specs[0]).schedule.kicksThisStep, 0);
    assert.equal(g.view(specs[0]).schedule.nextVoteRound, 6);
    // the thrown-out player sees their own cards, no longer plays or votes
    assert.equal(g.view(ids[4]).me.canPlaySpecial, false);
  });

  test('airlocks on different players never combine; several can be open at once', () => {
    const { g, ids } = started(6, { specials: deal6 });
    advanceTo(g, 2, 'reveal');
    ok(airlock(g, ids[0], ids[4]));
    ok(airlock(g, ids[1], ids[5]));
    assert.deepEqual(pubAirlocks(g), [{ targetId: ids[4], byIds: [ids[0]], round: 2 }, { targetId: ids[5], byIds: [ids[1]], round: 2 }]);
    assert.equal(status(g, ids[4]), 'alive');
    assert.equal(status(g, ids[5]), 'alive');
    ok(airlock(g, ids[2], ids[5]));
    assert.equal(status(g, ids[5]), 'ejected');
    assert.equal(status(g, ids[4]), 'alive');
    assert.deepEqual(pubAirlocks(g), [{ targetId: ids[4], byIds: [ids[0]], round: 2 }]);
  });

  test('the target may answer with an Airlock of their own: it opens a separate airlock, it does not close theirs', () => {
    const { g, ids } = started(6, { specials: deal6 });
    advanceTo(g, 2, 'reveal');
    ok(airlock(g, ids[0], ids[1]));
    ok(airlock(g, ids[1], ids[0]));
    assert.deepEqual(pubAirlocks(g).map((a) => [a.targetId, a.byIds[0]]), [[ids[1], ids[0]], [ids[0], ids[1]]]);
    assert.equal(status(g, ids[0]), 'alive');
    assert.equal(status(g, ids[1]), 'alive');
  });

  test('nobody can close their own airlock (the second player must be a different one)', () => {
    const { g, ids } = started(6, { specials: { 0: [AIR, AIR] } });
    advanceTo(g, 2, 'reveal');
    ok(airlock(g, ids[0], ids[4]));
    err(airlock(g, ids[0], ids[4]), 'not_allowed', /already played a special this round/);
    // even without the round limit (a guard for the rule itself)
    P(g, ids[0]).lastSpecialRound = 0;
    err(airlock(g, ids[0], ids[4]), 'not_allowed', /someone else has to close it/);
    assert.equal(status(g, ids[4]), 'alive');
  });

  test('vote immunity (immunity, protect) does not stop an airlock; the target loses their vote modifiers', () => {
    const { g, ids } = started(6, { specials: { ...deal6, 4: [sp('immunity'), FILLER], 5: [sp('protect'), sp('double_vote')] } });
    advanceTo(g, 2, 'reveal');
    ok(play(g, ids[4], 'immunity'));
    ok(play(g, ids[5], 'protect', { targetId: ids[3] }));
    assert.deepEqual(g.view(ids[0]).voteMods.immune, [ids[3], ids[4]]);
    ok(airlock(g, ids[0], ids[4]));
    ok(airlock(g, ids[1], ids[4]));
    ok(airlock(g, ids[2], ids[3]));
    assert.equal(status(g, ids[4]), 'ejected', 'immune from votes, not from the airlock');
    assert.deepEqual(g.view(ids[0]).voteMods.immune, [ids[3]]);
    assert.match(AIR.text, /Vote immunity does not stop it/);
  });

  test('cancel_vote does not touch an open airlock (and an airlock does not touch cancelNext)', () => {
    const { g, ids } = started(6, { specials: { ...deal6, 5: [sp('cancel_vote'), FILLER] } });
    advanceTo(g, 5, 'discussion');
    ok(airlock(g, ids[0], ids[4]));
    ok(play(g, ids[5], 'cancel_vote'));
    assert.equal(g.voteMods.cancelNext, true);
    assert.equal(pubAirlocks(g).length, 1);
    ok(airlock(g, ids[1], ids[4]));
    assert.equal(status(g, ids[4]), 'ejected');
    assert.equal(g.voteMods.cancelNext, true);
  });

  test('a speaker thrown out during their own turn: the turn moves on; a revive before the phase ends gives no turn back', () => {
    const { g, ids } = started(6, { specials: deal6 });
    advanceTo(g, 2, 'reveal');
    const spk = g.turn.order[0]; // descending: seat 5
    assert.equal(spk, ids[5]);
    ok(airlock(g, ids[0], spk));
    ok(airlock(g, ids[1], spk));
    assert.equal(g.turn.index, 1);
    assert.equal(g.turn.order[g.turn.index], ids[4]);
    ok(play(g, ids[3], 'revive', { targetId: spk }));
    assert.equal(status(g, spk), 'alive');
    assert.match(g.log[g.log.length - 1].text, /back in the game \(from the next round on\)$/);
  });

  test('revive brings back an airlock victim; they can be airlocked again by others (a new airlock)', () => {
    const { g, ids } = started(6, { specials: { ...deal6, 4: [AIR, FILLER] } });
    advanceTo(g, 2, 'reveal');
    ok(airlock(g, ids[0], ids[5]));
    ok(airlock(g, ids[1], ids[5]));
    ok(play(g, ids[3], 'revive', { targetId: ids[5] }));
    assert.equal(status(g, ids[5]), 'alive');
    assert.deepEqual(pubAirlocks(g), [], 'the old airlock does not come back');
    ok(airlock(g, ids[2], ids[5]));
    assert.deepEqual(pubAirlocks(g), [{ targetId: ids[5], byIds: [ids[2]], round: 2 }]);
    ok(airlock(g, ids[4], ids[5]));
    assert.equal(status(g, ids[5]), 'ejected');
  });

  test('...the game-ending seal: eject line, "The bunker door closes", then a jammed line per open airlock', () => {
    const { g, ids } = started(6, { specials: { ...deal6, 4: [AIR, FILLER] } });
    ok(g.handle(ids[5], { t: 'leave' }));
    ok(g.handle(g.hostId, { t: 'kick', playerId: ids[3] })); // alive 4, 3 beds
    advanceTo(g, 2, 'reveal');
    ok(airlock(g, ids[4], ids[2])); // open, will jam at the final
    ok(airlock(g, ids[0], ids[1]));
    ok(airlock(g, ids[2], ids[1])); // alive 3 <= 3
    assert.equal(g.phase, 'final');
    const t = texts(g);
    const i = t.findIndex((x) => /^The bunker door closes/.test(x));
    assert.equal(t[i - 1], sealLine(g, ids[2], ids[0], ids[1]));
    assert.equal(g.log[i - 1].kind, 'eject');
    assert.equal(t[i + 1], jamLine(g, ids[2]));
    assert.equal(g.log[i + 1].kind, 'special');
    assert.equal(t.length, i + 2);
    assert.deepEqual(pubAirlocks(g), [], 'none open in the final');
    assert.deepEqual(g.final.out, [ids[1], ids[3], ids[5]]);
    assert.deepEqual(g.view(ids[0]).players[2].unplayedSpecials, [{ title: FILLER.title, text: FILLER.text }]);
  });
});

// ------------------------------------------------------------------------------------------------ expiry
describe('§11 X1 Airlock: every way an open airlock jams', () => {
  const deal = { 0: [AIR, FILLER], 1: [AIR, FILLER], 2: [AIR, FILLER], 3: [REV, FILLER], 5: [sp('cancel_vote'), FILLER] };

  test('the end of its discussion, into the next round (no vote): jammed, logged, the card stays spent', () => {
    const { g, ids } = started(6, { specials: deal });
    advanceTo(g, 2, 'reveal');
    ok(airlock(g, ids[0], ids[4]));
    advanceTo(g, 2, 'discussion');
    assert.equal(pubAirlocks(g).length, 1, 'it survives the reveal phase into the discussion');
    const n = g.log.length;
    next(g);
    assert.deepEqual([g.round, g.phase], [3, 'reveal']);
    assert.deepEqual(pubAirlocks(g), []);
    assert.equal(g.log[n].text, jamLine(g, ids[4]), 'logged first, before the next round');
    assert.equal(g.log[n].kind, 'special');
    assert.equal(P(g, ids[0]).specials[0].used, true);
    assert.equal(status(g, ids[4]), 'alive');
    // a jammed airlock cannot be joined: the next Airlock on the same player opens a new one
    ok(airlock(g, ids[1], ids[4]));
    assert.equal(status(g, ids[4]), 'alive');
    assert.deepEqual(pubAirlocks(g), [{ targetId: ids[4], byIds: [ids[1]], round: 3 }]);
  });

  test('the end of its discussion, into the vote step: jammed before the vote opens; none open during the vote', () => {
    const { g, ids } = started(6, { specials: deal });
    advanceTo(g, 5, 'discussion');
    ok(airlock(g, ids[0], ids[4]));
    ok(airlock(g, ids[1], ids[3]));
    const n = g.log.length;
    next(g);
    assert.equal(g.phase, 'vote');
    assert.deepEqual(texts(g).slice(n, n + 2), [jamLine(g, ids[4]), jamLine(g, ids[3])], 'in the order they were opened');
    assert.match(texts(g)[n + 2], /vote: 1 player will stay outside/);
    assert.deepEqual(pubAirlocks(g), []);
  });

  test('...and into a vote step that cancelNext skips', () => {
    const { g, ids } = started(6, { specials: deal });
    advanceTo(g, 5, 'discussion');
    ok(play(g, ids[5], 'cancel_vote'));
    ok(airlock(g, ids[0], ids[4]));
    next(g);
    assert.deepEqual([g.round, g.phase], [6, 'reveal']);
    assert.ok(texts(g).includes(jamLine(g, ids[4])));
    assert.deepEqual(pubAirlocks(g), []);
  });

  test('at once when the target is no longer alive: they leave, or the host kicks them', () => {
    for (const how of ['leave', 'kick']) {
      const { g, ids } = started(6, { specials: deal });
      advanceTo(g, 2, 'reveal');
      ok(airlock(g, ids[0], ids[4]));
      ok(airlock(g, ids[1], ids[3]));
      ok(how === 'leave' ? g.handle(ids[4], { t: 'leave' }) : g.handle(g.hostId, { t: 'kick', playerId: ids[4] }));
      const t = texts(g);
      assert.equal(t[t.length - 1], jamLine(g, ids[4]), how);
      assert.match(t[t.length - 2], how === 'leave' ? /^P4 left the game$/ : /^P4 was removed by the host$/);
      assert.deepEqual(pubAirlocks(g), [{ targetId: ids[3], byIds: [ids[1]], round: 2 }], 'the other airlock stays');
    }
  });

  test('the opener leaving, being kicked or being thrown out keeps their airlock open: a partner can still close it', () => {
    for (const how of ['leave', 'kick', 'airlock']) {
      const { g, ids } = started(6, { specials: { ...deal, 4: [AIR, FILLER] } });
      advanceTo(g, 2, 'reveal');
      ok(airlock(g, ids[1], ids[5])); // P1 opens on P5
      if (how === 'leave') ok(g.handle(ids[1], { t: 'leave' }));
      else if (how === 'kick') ok(g.handle(g.hostId, { t: 'kick', playerId: ids[1] }));
      else { ok(airlock(g, ids[0], ids[1])); ok(airlock(g, ids[4], ids[1])); } // P1 thrown out
      assert.notEqual(status(g, ids[1]), 'alive');
      assert.deepEqual(pubAirlocks(g), [{ targetId: ids[5], byIds: [ids[1]], round: 2 }], `${how}: still open`);
      ok(airlock(g, ids[2], ids[5]));
      assert.equal(status(g, ids[5]), 'ejected', how);
      assert.equal(g.log[g.log.length - 1].text, sealLine(g, ids[2], ids[1], ids[5]));
    }
  });

  test('when the game reaches the final some other way (a leave), after the door line', () => {
    const { g, ids } = started(4, { specials: { 0: [AIR, FILLER], 1: [AIR, FILLER] } });
    advanceTo(g, 2, 'discussion');
    ok(airlock(g, ids[0], ids[2]));
    ok(airlock(g, ids[1], ids[0]));
    ok(g.handle(ids[3], { t: 'leave' })); // alive 3, 2 beds
    assert.equal(g.phase, 'discussion');
    ok(g.handle(ids[2], { t: 'leave' })); // the target of the first airlock: alive 2 <= 2 -> final
    assert.equal(g.phase, 'final');
    const t = texts(g);
    const i = t.findIndex((x) => /^The bunker door closes/.test(x));
    assert.equal(t[i - 1], 'P2 left the game', 'the move that ended the game stays right before the door line');
    assert.deepEqual(t.slice(i + 1), [jamLine(g, ids[2]), jamLine(g, ids[0])]);
    assert.deepEqual(pubAirlocks(g), []);
  });

  test('in overtime: opened in an overtime discussion, jammed when it ends', () => {
    const { g, ids } = started(6, { specials: { 0: [AIR, FILLER], 1: [AIR, FILLER], 5: [sp('cancel_vote'), FILLER] } });
    advanceTo(g, 7, 'discussion', [ids[0], ids[1], ids[3], ids[5]]);
    ok(play(g, ids[5], 'cancel_vote')); // round 7's vote is skipped -> overtime
    next(g);
    assert.deepEqual([g.phase, g.overtime], ['discussion', true]);
    ok(airlock(g, ids[0], ids[3])); // overtime counts as round 7: P0 has not played in round 7
    assert.deepEqual(pubAirlocks(g), [{ targetId: ids[3], byIds: [ids[0]], round: 7 }]);
    assert.equal(g.log.at(-1).text, openLine(g, ids[0], ids[3]));
    assert.match(g.log.at(-1).text, /before the overtime discussion ends, P3 is out/, '§11 Z5');
    const n = g.log.length;
    next(g); // the overtime discussion ends: the vote step
    assert.equal(g.phase, 'vote');
    assert.equal(g.log[n].text, jamLine(g, ids[3]));
    assert.deepEqual(pubAirlocks(g), []);
  });

  test('...and an overtime airlock can be sealed too', () => {
    const { g, ids } = started(6, { specials: { 0: [AIR, FILLER], 1: [AIR, FILLER], 5: [sp('cancel_vote'), FILLER] } });
    advanceTo(g, 7, 'discussion', [ids[0], ids[1], ids[3], ids[5]]);
    ok(play(g, ids[5], 'cancel_vote'));
    next(g);
    const alive = g.players.filter((p) => p.status === 'alive').length;
    ok(airlock(g, ids[0], ids[3]));
    ok(airlock(g, ids[1], ids[3]));
    assert.equal(status(g, ids[3]), 'ejected');
    assert.equal(g.players.filter((p) => p.status === 'alive').length, alive - 1);
  });

  test('Play again and Start never carry an airlock over', () => {
    const { g, ids } = started(4, { specials: { 0: [AIR, FILLER], 1: [AIR, FILLER] } });
    advanceTo(g, 2, 'reveal');
    ok(airlock(g, ids[0], ids[2]));
    ok(g.handle(ids[3], { t: 'leave' }));
    ok(g.handle(g.hostId, { t: 'kick', playerId: ids[1] }));
    assert.equal(g.phase, 'final');
    assert.deepEqual(g.airlocks, []);
    ok(g.handle(g.hostId, { t: 'playAgain' }));
    assert.deepEqual(pubAirlocks(g), []);
  });
});

// ------------------------------------------------------------------------------------------------ fuzz
describe('§11 X1 fuzz', () => {
  test('random Airlock-heavy play keeps the airlock invariants, and no ejection outside a vote without a pair', () => {
    const rnd = mulberry32(777);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    let sealed = 0;
    let jammed = 0;
    for (let gameNo = 0; gameNo < 80; gameNo++) {
      const n = 4 + Math.floor(rnd() * 13);
      const { g, ids } = started(n, { fixedSpecials: true, dealer: createDealer(mulberry32(gameNo)), seed: gameNo + 100 });
      for (let k = 0; k < 600 && g.phase !== 'final'; k++) {
        const before = new Map(g.players.map((p) => [p.id, p.status]));
        const openBefore = g.airlocks.map((a) => ({ ...a, byIds: [...a.byIds] }));
        const logN = g.logSeq;
        const r = rnd();
        const alive = g.players.filter((p) => p.status === 'alive').map((p) => p.id);
        if (r < 0.35) {
          const holder = pick(g.players.filter((p) => p.status === 'alive' && p.specials.some((c) => c.effect === 'airlock' && !c.used)).map((p) => p.id).concat(['none']));
          const targets = g.airlocks.length && rnd() < 0.6 ? g.airlocks.map((a) => a.targetId) : alive;
          if (holder !== 'none') g.handle(holder, { t: 'special', uid: P(g, holder).specials.find((c) => c.effect === 'airlock').uid, targetId: pick(targets) });
        } else if (r < 0.4) {
          const holder = g.players.find((p) => p.status === 'alive' && p.specials.some((c) => c.effect === 'revive' && !c.used));
          const out = g.players.filter((p) => p.status === 'ejected');
          if (holder && out.length) g.handle(holder.id, { t: 'special', uid: holder.specials.find((c) => c.effect === 'revive').uid, targetId: pick(out).id });
        } else if (r < 0.42 && alive.length > 2) {
          g.handle(pick(alive.filter((id) => id !== g.hostId)), { t: 'leave' });
        } else if (g.phase === 'vote') {
          const v = g.vote;
          const voter = pick(v.voters.filter((x) => !v.votes.has(x)).concat([null]));
          if (voter) g.handle(voter, { t: 'vote', targetId: pick(v.candidates.filter((c) => c !== voter)) || 'x' });
          else next(g);
        } else next(g);
        // invariants
        const fresh = g.log.filter((e) => e.id > logN);
        if (!['reveal', 'discussion'].includes(g.phase)) assert.deepEqual(g.airlocks, []);
        for (const a of g.airlocks) {
          assert.equal(status(g, a.targetId), 'alive');
          assert.equal(a.round, g.round);
          assert.equal(a.byIds.length, 1);
        }
        for (const [id, st] of before) {
          if (st !== 'alive' || status(g, id) !== 'ejected') continue;
          const byVote = fresh.some((e) => e.kind === 'eject' && e.text.endsWith(`${name(g, id)} is ejected and stays in the forest`));
          if (byVote) continue;
          const open = openBefore.find((a) => a.targetId === id);
          assert.ok(open, `${id} was ejected outside a vote with no airlock open on them`);
          const line = fresh.find((e) => e.kind === 'eject' && e.text.startsWith('🚪') && e.text.includes(`— ${name(g, id)} is thrown out`));
          assert.ok(line, 'the sealed line');
          assert.ok(!line.text.startsWith(`🚪 ${name(g, open.byIds[0])} sealed`), 'sealed by a second, different player');
          sealed++;
        }
        for (const a of openBefore) {
          if (g.airlocks.some((x) => x.targetId === a.targetId) || status(g, a.targetId) === 'ejected') continue;
          assert.ok(fresh.some((e) => e.text === jamLine(g, a.targetId)), 'a jammed line for every airlock that closed unsealed');
          jammed++;
        }
      }
    }
    assert.ok(sealed > 30 && jammed > 30, `sealed ${sealed}, jammed ${jammed}`);
  });
});
