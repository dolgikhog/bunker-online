// Engine unit tests (node --test). Drives server/game.js through its §8 interface only
// (createGame / join / handle / view / setConnected / passHost), with a hand-made dealer.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, KICKS, kicksForStep, kicksRow, EFFECTS, CATEGORY_IDS, validateMessage, sanitizeName, MAX_ROUNDS,
} from '../server/game.js';
import { mulberry32 } from '../server/rng.js';

// ------------------------------------------------------------------------------------------------ helpers
const FILLER = { id: 'filler', title: 'Blueprint', text: 'Adds a bunker feature.', effect: 'bunker_add_feature', target: 'none' };

function sp(effect, extra = {}) {
  return { id: effect, title: `T:${effect}`, text: `Card text for ${effect}`, effect, target: EFFECTS[effect].targets[0], ...extra };
}

/** Test dealer: unique, delimiter-wrapped card texts; specials[seat] = [first, second] (filler otherwise). */
function makeDealer(specials = {}) {
  let cardN = 0;
  let specialN = 0;
  let dealt = 0;
  let featN = 0;
  return {
    drawCard(c) { cardN++; return `<${c}#${cardN}>`; },
    drawSpecial() {
      const seat = Math.floor(specialN / 2);
      const slot = specialN % 2;
      specialN++;
      const card = specials[seat]?.[slot] ?? FILLER;
      dealt++;
      return { ...card, text: `${card.text} [special#${dealt}]` };
    },
    drawCatastrophe() { return { title: 'Test flood', text: 'Water everywhere.', details: ['Survivors: 1%'] }; },
    drawBunker() { return { name: 'Test bunker', size: '50 m2', duration: '1 year', food: '1 year', features: ['Well'] }; },
    drawBunkerFeature() { featN++; return `<feature#${featN}>`; },
    resetSpecials() { specialN = 0; },
  };
}

// The hand-made deal controls every special slot, so the §11 X1 fixed Airlock/revive deal is off here
// (test/airlock.test.js covers it).
function setup(n, { specials = {}, minPlayers = 2, seed = 7, spectators = 0, fixedSpecials = false } = {}) {
  const clock = { t: 1_000_000 };
  const dealer = makeDealer(specials);
  const g = createGame({ room: 'TEST', rng: mulberry32(seed), now: () => clock.t, minPlayers, dealer, fixedSpecials });
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = g.join(`P${i}`);
    assert.equal(r.ok, true);
    assert.equal(r.role, 'player');
    ids.push(r.id);
  }
  const specs = [];
  for (let i = 0; i < spectators; i++) specs.push(g.join(`S${i}`, { spectator: true }).id);
  return { g, ids, host: ids[0], clock, dealer, specs };
}
function started(n, opts) {
  const ctx = setup(n, opts);
  ok(ctx.g.handle(ctx.host, { t: 'start' }));
  return ctx;
}
function ok(res) { assert.deepEqual(res, { ok: true }, JSON.stringify(res)); }
function err(res, code) {
  assert.equal(res.ok, false, `expected ${code}, got ok`);
  assert.equal(res.code, code, `expected ${code}, got ${res.code}: ${res.message}`);
  assert.equal(typeof res.message, 'string');
  assert.ok(res.message.length > 0);
}
const P = (g, id) => g.players.find((p) => p.id === id);
const status = (g, id) => P(g, id).status;
const aliveIds = (g) => g.players.filter((p) => p.status === 'alive').map((p) => p.id);
function next(g) { ok(g.handle(g.hostId, { t: 'next' })); }
function advanceTo(g, round, phase) {
  let guard = 0;
  while (!(g.round === round && g.phase === phase)) {
    assert.ok(guard++ < 3000, `stuck at ${g.round}/${g.phase}`);
    assert.notEqual(g.phase, 'final', `game ended before round ${round} ${phase}`);
    next(g);
  }
}
function finishReveal(g) { while (g.phase === 'reveal') next(g); }
function uidOf(g, id, effect) {
  const s = P(g, id).specials.find((x) => x.effect === effect && !x.used);
  assert.ok(s, `${id} has no unused ${effect}`);
  return s.uid;
}
function play(g, id, effect, extra = {}) { return g.handle(id, { t: 'special', uid: uidOf(g, id, effect), ...extra }); }
function votes(g, map) { for (const [voter, target] of Object.entries(map)) ok(g.handle(voter, { t: 'vote', targetId: target })); }
const lastLog = (g) => g.log[g.log.length - 1].text;
const logText = (g) => g.log.map((e) => e.text).join('\n');

/** The integrity property (§9): nobody but the owner ever sees a hidden card, an unplayed special or a peek note. */
function assertRedacted(g, extraSecrets = []) {
  const final = g.phase === 'final';
  const viewers = [...g.players.filter((p) => p.status !== 'left').map((p) => p.id), ...g.spectators.map((s) => s.id)];
  let playersJson = null;
  for (const vid of viewers) {
    const v = g.view(vid);
    assert.ok(v, `view for ${vid}`);
    const pj = JSON.stringify(v.players);
    if (playersJson === null) playersJson = pj;
    else assert.equal(pj, playersJson, 'players[] must be identical for every recipient');
    const stripped = { ...v, me: v.me ? { ...v.me, notes: [] } : null };
    const json = JSON.stringify(stripped);
    for (const s of extraSecrets) assert.ok(!json.includes(s), `${vid} sees discarded ${s}`);
    if (v.me) {
      for (const n of v.me.notes) assert.ok(P(g, vid).notes.some((x) => x.text === n.text));
    }
    if (final) continue;
    for (const p of g.players) {
      if (!p.cards || p.id === vid) continue;
      for (const c of CATEGORY_IDS) {
        if (!p.cards[c].revealed) assert.ok(!json.includes(p.cards[c].text), `${vid} sees hidden ${p.name}.${c} ${p.cards[c].text}`);
      }
      for (const s of p.specials) {
        if (!s.used) {
          assert.ok(!json.includes(s.text), `${vid} sees ${p.name}'s unplayed special`);
          assert.ok(!json.includes(`"${s.uid}"`), `${vid} sees ${p.name}'s special uid`);
        }
      }
      for (const n of p.notes) assert.ok(!JSON.stringify(v).includes(n.text), `${vid} sees ${p.name}'s note`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ §2 KICKS
describe('§2 vote schedule', () => {
  test('KICKS rows 2..16: 7 rounds, round 1 never votes, totals = ceil(N/2), survivors = floor(N/2)', () => {
    for (let n = 2; n <= 16; n++) {
      const row = KICKS[n];
      assert.equal(row.length, 7, `row ${n}`);
      assert.equal(row[0], 0);
      const total = row.reduce((a, b) => a + b, 0);
      assert.equal(total, Math.ceil(n / 2), `total for ${n}`);
      assert.equal(n - total, Math.floor(n / 2), `survivors for ${n}`);
      if (n > 2) for (let r = 0; r < 7; r++) assert.ok(row[r] >= KICKS[n - 1][r], `monotonic ${n} r${r + 1}`);
    }
    assert.deepEqual(kicksRow(6), [0, 0, 0, 0, 1, 1, 1]);
    assert.deepEqual(kicksRow(16), [0, 1, 1, 1, 1, 2, 2]);
    assert.deepEqual(kicksRow(1), []);
    assert.deepEqual(kicksRow(17), []);
  });

  test('the table matches the spec text exactly', () => {
    const spec = {
      2: '0000001', 3: '0000011', 4: '0000011', 5: '0000111', 6: '0000111', 7: '0001111', 8: '0001111', 9: '0011111',
      10: '0011111', 11: '0111111', 12: '0111111', 13: '0111112', 14: '0111112', 15: '0111122', 16: '0111122',
    };
    for (const [n, s] of Object.entries(spec)) assert.equal(KICKS[n].join(''), s, `N=${n}`);
  });

  test('formula: min(cum − out, alive − capacity) before round 7, alive − capacity at 7 and overtime', () => {
    const row = KICKS[16];
    assert.equal(kicksForStep({ row, round: 1, outCount: 0, alive: 16, capacity: 8 }), 0);
    assert.equal(kicksForStep({ row, round: 2, outCount: 0, alive: 16, capacity: 8 }), 1);
    assert.equal(kicksForStep({ row, round: 6, outCount: 4, alive: 12, capacity: 8 }), 2);
    assert.equal(kicksForStep({ row, round: 6, outCount: 5, alive: 11, capacity: 8 }), 1); // someone left
    assert.equal(kicksForStep({ row, round: 3, outCount: 0, alive: 16, capacity: 8 }), 2); // round 2's kick carried over (cancelled)
    assert.equal(kicksForStep({ row, round: 4, outCount: 0, alive: 16, capacity: 8 }), 3);
    assert.equal(kicksForStep({ row, round: 3, outCount: 0, alive: 16, capacity: 15 }), 1); // capped by beds
    assert.equal(kicksForStep({ row, round: 5, outCount: 9, alive: 7, capacity: 8 }), 0); // never negative
    assert.equal(kicksForStep({ row, round: 7, outCount: 0, alive: 16, capacity: 8 }), 8);
    assert.equal(kicksForStep({ row, round: 7, overtime: true, outCount: 7, alive: 9, capacity: 8 }), 1);
  });

  test('a full game driven only by Next ejects exactly KICKS[N] per round for every N from 2 to 16', () => {
    for (let n = 2; n <= 16; n++) {
      const { g, host } = started(n, { seed: n });
      const view0 = g.view(host);
      assert.deepEqual(view0.schedule.kicksByRound, KICKS[n]);
      assert.equal(view0.capacity, Math.floor(n / 2));
      assert.equal(view0.schedule.nextVoteRound, KICKS[n].findIndex((k) => k > 0) + 1);
      const ejected = [0, 0, 0, 0, 0, 0, 0, 0];
      let guard = 0;
      while (g.phase !== 'final') {
        assert.ok(guard++ < 5000);
        const before = g.players.filter((p) => p.status === 'ejected').length;
        const round = g.round;
        next(g);
        ejected[round] += g.players.filter((p) => p.status === 'ejected').length - before;
      }
      assert.deepEqual(ejected.slice(1), [...KICKS[n]], `N=${n}`);
      assert.equal(g.final.survivors.length, Math.floor(n / 2));
      assert.equal(g.final.out.length, Math.ceil(n / 2));
      assert.equal(g.overtime, false);
      assert.equal(g.round, 7);
    }
  });

  test('schedule fields in the lobby, during play and during a step', () => {
    const { g, host, ids } = setup(1);
    assert.deepEqual(g.view(host).schedule, { kicksByRound: [], outCount: 0, kicksThisStep: 0, nextVoteRound: null });
    g.join('B');
    assert.deepEqual(g.view(host).schedule.kicksByRound, KICKS[2]);
    for (let i = 0; i < 4; i++) g.join(`X${i}`);
    assert.deepEqual(g.view(host).schedule.kicksByRound, KICKS[6]);
    ok(g.handle(host, { t: 'start' }));
    let s = g.view(host).schedule;
    assert.deepEqual(s, { kicksByRound: [0, 0, 0, 0, 1, 1, 1], outCount: 0, kicksThisStep: 0, nextVoteRound: 5 });
    advanceTo(g, 5, 'reveal');
    s = g.view(host).schedule;
    assert.equal(s.kicksThisStep, 1);
    assert.equal(s.nextVoteRound, 5);
    advanceTo(g, 5, 'vote');
    s = g.view(host).schedule;
    assert.equal(s.kicksThisStep, 1);
    assert.equal(s.nextVoteRound, 5);
    assert.equal(ids.length, 1);
  });
});

// ------------------------------------------------------------------------------------------------ lobby
describe('lobby, joining, names, options', () => {
  test('names are sanitized, de-duplicated across players and spectators; empty names rejected', () => {
    const bell = String.fromCharCode(7);
    const rlo = String.fromCharCode(0x202e);
    assert.equal(sanitizeName(`  Al${bell}ice${rlo}  `), 'Alice');
    assert.equal(sanitizeName('x'.repeat(40)), 'x'.repeat(20));
    assert.equal(sanitizeName(`${bell}${bell}   `), '');
    assert.equal(sanitizeName(42), '');
    const { g, host } = setup(1);
    assert.equal(P(g, host).name, 'P0');
    const b = g.join('P0');
    assert.equal(P(g, b.id).name, 'P0 (2)');
    const c = g.join('P0', { spectator: true });
    assert.equal(g.view(c.id).you.name, 'P0 (3)');
    assert.equal(g.view(c.id).you.role, 'spectator');
    err(g.join('   '), 'bad_request');
    err(g.join(null), 'bad_request');
  });

  test('the first seated player is host; 17th joiner and anyone joining a running game become spectators', () => {
    const { g, ids } = setup(16);
    assert.equal(g.hostId, ids[0]);
    const s = g.join('Late');
    assert.equal(s.role, 'spectator');
    err(g.handle(s.id, { t: 'takeSeat' }), 'room_full');
    ok(g.handle(ids[0], { t: 'start' }));
    const s2 = g.join('Later');
    assert.equal(s2.role, 'spectator');
    const v = g.view(s2.id);
    assert.equal(v.me, null);
    assert.equal(v.you.role, 'spectator');
    err(g.handle(s2.id, { t: 'takeSeat' }), 'room_full'); // room_full precedes wrong_phase (§7)
  });

  test('50 spectators max, then room_full', () => {
    const { g } = setup(2);
    for (let i = 0; i < 50; i++) assert.equal(g.join(`S${i}`, { spectator: true }).ok, true);
    err(g.join('One too many', { spectator: true }), 'room_full');
  });

  test('takeSeat: spectator in the lobby gets appended with the same id; seated players cannot', () => {
    const { g, ids, specs } = setup(2, { spectators: 1 });
    err(g.handle(ids[1], { t: 'takeSeat' }), 'not_allowed');
    ok(g.handle(specs[0], { t: 'takeSeat' }));
    const v = g.view(specs[0]);
    assert.equal(v.you.role, 'player');
    assert.equal(v.players[2].id, specs[0]);
    assert.equal(v.players[2].seat, 2);
    assert.equal(v.spectators.length, 0);
    ok(g.handle(ids[0], { t: 'start' }));
    const late = g.join('late').id;
    err(g.handle(late, { t: 'takeSeat' }), 'wrong_phase');
  });

  test('setOptions: host only, lobby only, integers 5..600, omitted keys kept', () => {
    const { g, ids } = setup(4);
    err(g.handle(ids[1], { t: 'setOptions', options: { speechSeconds: 20 } }), 'not_host');
    err(g.handle(ids[0], { t: 'setOptions', options: { speechSeconds: 4 } }), 'bad_request');
    err(g.handle(ids[0], { t: 'setOptions', options: { speechSeconds: 601 } }), 'bad_request');
    err(g.handle(ids[0], { t: 'setOptions', options: { speechSeconds: 20.5 } }), 'bad_request');
    err(g.handle(ids[0], { t: 'setOptions', options: { speechSeconds: '20' } }), 'bad_request');
    err(g.handle(ids[0], { t: 'setOptions', options: [] }), 'bad_request');
    err(g.handle(ids[0], { t: 'setOptions' }), 'bad_request');
    ok(g.handle(ids[0], { t: 'setOptions', options: { speechSeconds: 20, defenseSeconds: 600, bogus: 1 } }));
    assert.deepEqual(g.view(ids[1]).options, { speechSeconds1: 60, speechSeconds: 20, discussionSeconds: 90, defenseSeconds: 600 });
    ok(g.handle(ids[0], { t: 'start' }));
    err(g.handle(ids[0], { t: 'setOptions', options: { speechSeconds: 25 } }), 'wrong_phase');
  });

  test('start: host only, needs minPlayers (offline players count), then round 1 reveal', () => {
    const { g, ids } = setup(3, { minPlayers: 4 });
    err(g.handle(ids[1], { t: 'start' }), 'not_host');
    err(g.handle(ids[0], { t: 'start' }), 'not_allowed');
    const d = g.join('D').id;
    g.setConnected(d, false);
    ok(g.handle(ids[0], { t: 'start' }));
    assert.equal(g.phase, 'reveal');
    assert.equal(g.round, 1);
    assert.ok(P(g, d).cards);
    err(g.handle(ids[0], { t: 'start' }), 'wrong_phase');
  });

  test('lobby view: me null, statuses alive, cards null, counters 0', () => {
    const { g, ids, specs } = setup(3, { spectators: 1 });
    for (const id of [...ids, ...specs]) {
      const v = g.view(id);
      assert.equal(v.me, null);
      assert.equal(v.phase, 'lobby');
      assert.equal(v.round, 0);
      assert.equal(v.capacity, 0);
      assert.equal(v.turn, null);
      assert.equal(v.vote, null);
      assert.equal(v.timer, null);
      assert.equal(v.catastrophe, null);
      assert.equal(v.bunker, null);
      assert.equal(v.maxRounds, 7);
      assert.equal(v.maxPlayers, 16);
      assert.equal(v.minPlayers, 2);
      assert.deepEqual(v.categories.map((c) => c.id), CATEGORY_IDS);
      for (const p of v.players) {
        assert.equal(p.status, 'alive');
        assert.equal(p.revealedCount, 0);
        assert.equal(p.specialsLeft, 0);
        assert.ok(Object.values(p.cards).every((x) => x === null));
        assert.equal('unplayedSpecials' in p, false);
      }
    }
    assert.equal(g.view('nobody'), null);
  });
});

// ------------------------------------------------------------------------------------------------ errors
describe('§7 validation and error precedence', () => {
  test('validateMessage schema checks', () => {
    for (const bad of [null, 1, 'x', [], {}, { t: 1 }, { t: 'nope' }, { t: '__proto__' }, { t: 'constructor' }, { t: 'toString' },
      { t: 'join', room: 'ABCD' }, { t: 'join', room: 'ABCD', name: 'x', spectator: 'yes' }, { t: 'vote' }, { t: 'vote', targetId: 5 },
      { t: 'reveal', category: 'money' }, { t: 'special' }, { t: 'special', uid: 's1', category: 'x' }, { t: 'special', uid: 's1', targetId: {} },
      { t: 'kick', playerId: ['a'] }, { t: 'setOptions', options: null }, { t: 'create', name: 'x'.repeat(5000) }]) {
      const r = validateMessage(bad);
      assert.ok(r && r.code === 'bad_request', `should reject ${JSON.stringify(bad)}`);
    }
    for (const good of [{ t: 'ping' }, { t: 'create', name: 'A' }, { t: 'special', uid: 's1', targetId: null, category: null },
      { t: 'join', room: 'abcd', name: 'x', spectator: false }, { t: 'reveal', category: 'health' }, { t: 'setOptions', options: {} }]) {
      assert.equal(validateMessage(good), null, JSON.stringify(good));
    }
  });

  test('precedence: bad_request > not_in_room > not_host > wrong_phase > not_your_turn > not_allowed', () => {
    const { g, ids } = setup(4);
    err(g.handle('ghost', { t: 'vote' }), 'bad_request');
    err(g.handle('ghost', { t: 'next' }), 'not_in_room');
    err(g.handle(ids[0], { t: 'create', name: 'x' }), 'bad_request');
    err(g.handle(ids[0], { t: 'ping' }), 'bad_request');
    err(g.handle(ids[1], { t: 'next' }), 'not_host');
    err(g.handle(ids[0], { t: 'next' }), 'wrong_phase');
    err(g.handle(ids[0], { t: 'closeVote' }), 'wrong_phase');
    err(g.handle(ids[0], { t: 'playAgain' }), 'wrong_phase');
    err(g.handle(ids[1], { t: 'reveal', category: 'profession' }), 'wrong_phase');
    ok(g.handle(ids[0], { t: 'start' }));
    err(g.handle(ids[1], { t: 'reveal', category: 'profession' }), 'not_your_turn');
    err(g.handle(ids[1], { t: 'endTurn' }), 'not_your_turn');
    err(g.handle(ids[0], { t: 'reveal', category: 'health' }), 'not_allowed');
    err(g.handle(ids[0], { t: 'reveal', category: 'cash' }), 'bad_request');
    err(g.handle(ids[1], { t: 'vote', targetId: ids[2] }), 'wrong_phase');
    err(g.handle(ids[1], { t: 'special', uid: 'nope' }), 'not_allowed');
    err(g.handle(ids[1], { t: 'special', uid: 'nope', category: 'cash' }), 'bad_request');
    // the engine never throws, whatever it is fed
    for (const junk of [undefined, null, 5, 'next', [], { t: 'vote', targetId: { toString: null } }, Object.create(null)]) {
      assert.equal(g.handle(ids[0], junk).ok, false);
      assert.equal(g.handle(junk, { t: 'next' }).ok, false);
    }
    assert.equal(g.join({}).ok, false);
    assert.equal(g.join('Nully', null).role, 'spectator'); // running game: spectator; a null options object is fine
    assert.equal(createGame(null).phase, 'lobby');
    assert.equal(g.view(undefined), null);
    g.setConnected(undefined, true);
    g.setConnected('ghost', false);
  });
});

// ------------------------------------------------------------------------------------------------ §1 reveal phase
describe('§1 reveal phase', () => {
  test('round 1: profession only; End turn only after revealing; one reveal per turn', () => {
    const { g, ids } = started(4);
    const v = g.view(ids[0]);
    assert.equal(v.turn.kind, 'reveal');
    assert.equal(v.turn.speakerId, ids[0]);
    assert.equal(v.turn.mustReveal, 'profession');
    assert.equal(v.turn.hasRevealed, false);
    err(g.handle(ids[0], { t: 'endTurn' }), 'not_allowed');
    err(g.handle(ids[0], { t: 'reveal', category: 'biology' }), 'not_allowed');
    ok(g.handle(ids[0], { t: 'reveal', category: 'profession' }));
    assert.match(lastLog(g), /^Round 1 — P0 revealed Profession: <profession#1>$/);
    err(g.handle(ids[0], { t: 'reveal', category: 'profession' }), 'not_allowed');
    const v2 = g.view(ids[2]);
    assert.equal(v2.turn.hasRevealed, true);
    assert.equal(v2.turn.mustReveal, 'profession');
    assert.equal(v2.players[0].cards.profession, '<profession#1>');
    assert.equal(v2.players[0].revealedCount, 1);
    assert.equal(g.view(ids[0]).me.cards.profession.revealed, true);
    ok(g.handle(ids[0], { t: 'endTurn' }));
    assert.equal(g.view(ids[0]).turn.speakerId, ids[1]);
  });

  test('turn order: ascending by seat in odd rounds, descending in even rounds; timers restart per speaker', () => {
    const { g, ids, clock } = started(5);
    assert.deepEqual(g.view(ids[0]).turn.order, ids);
    assert.deepEqual(g.view(ids[0]).timer, { label: "P0's turn", endsAt: clock.t + 60_000 });
    clock.t += 5000;
    next(g);
    assert.equal(g.view(ids[0]).timer.endsAt, clock.t + 60_000);
    finishReveal(g);
    assert.equal(g.phase, 'discussion');
    assert.equal(g.view(ids[0]).timer.endsAt, clock.t + 90_000);
    assert.equal(g.view(ids[0]).turn, null);
    next(g);
    assert.equal(g.round, 2);
    const v = g.view(ids[0]);
    assert.deepEqual(v.turn.order, [...ids].reverse());
    assert.equal(v.turn.speakerId, ids[4]);
    assert.equal(v.turn.mustReveal, null);
    assert.equal(v.timer.endsAt, clock.t + 30_000);
    finishReveal(g);
    next(g);
    assert.deepEqual(g.view(ids[0]).turn.order, ids);
  });

  test('Next auto-reveals: profession in round 1, a random hidden card later', () => {
    const { g, ids } = started(4);
    next(g);
    assert.equal(P(g, ids[0]).cards.profession.revealed, true);
    assert.match(lastLog(g), /revealed automatically/);
    finishReveal(g);
    next(g); // round 2
    const sp0 = g.view(ids[0]).turn.speakerId;
    const hiddenBefore = CATEGORY_IDS.filter((c) => !P(g, sp0).cards[c].revealed).length;
    next(g);
    assert.equal(CATEGORY_IDS.filter((c) => !P(g, sp0).cards[c].revealed).length, hiddenBefore - 1);
  });

  test('any hidden card may be revealed in rounds 2..7; after 7 rounds one card stays hidden', () => {
    const { g, ids } = started(4);
    finishReveal(g);
    next(g);
    const speaker = g.view(ids[0]).turn.speakerId;
    err(g.handle(speaker, { t: 'reveal', category: 'profession' }), 'not_allowed'); // already revealed
    ok(g.handle(speaker, { t: 'reveal', category: 'baggage' }));
    ok(g.handle(speaker, { t: 'endTurn' }));
    while (g.phase !== 'final') next(g);
    for (const id of g.final.survivors) assert.equal(P(g, id).cards && CATEGORY_IDS.filter((c) => P(g, id).cards[c].revealed).length, 7);
  });

  test('a speaker with nothing eligible may End turn without revealing; a special never counts as their reveal', () => {
    const { g, ids } = started(4, { specials: { 0: [sp('force_reveal', { category: 'choose' })] } });
    ok(g.handle(ids[0], { t: 'reveal', category: 'profession' }));
    ok(play(g, ids[0], 'force_reveal', { targetId: ids[1], category: 'profession' }));
    ok(g.handle(ids[0], { t: 'endTurn' }));
    const v = g.view(ids[1]);
    assert.equal(v.turn.speakerId, ids[1]);
    assert.equal(v.turn.hasRevealed, false);
    assert.equal(v.turn.mustReveal, 'profession');
    err(g.handle(ids[1], { t: 'reveal', category: 'profession' }), 'not_allowed');
    ok(g.handle(ids[1], { t: 'endTurn' }));
    assert.equal(g.view(ids[1]).turn.speakerId, ids[2]);
  });

  test('speaker ejected mid-turn (special) or leaving: the turn advances automatically', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('eject')] } });
    finishReveal(g);
    next(g); // round 2, descending: P5 speaks first
    assert.equal(g.view(ids[0]).turn.speakerId, ids[5]);
    ok(play(g, ids[0], 'eject', { targetId: ids[5] }));
    assert.equal(status(g, ids[5]), 'ejected');
    let v = g.view(ids[0]);
    assert.equal(v.turn.speakerId, ids[4]);
    assert.equal(v.turn.index, 1);
    assert.equal(v.turn.hasRevealed, false);
    ok(g.handle(ids[4], { t: 'reveal', category: 'health' }));
    ok(g.handle(ids[4], { t: 'leave' }));
    v = g.view(ids[0]);
    assert.equal(v.turn.speakerId, ids[3]);
    assert.equal(v.turn.hasRevealed, false);
    assert.equal(g.view(ids[4]), null);
    assert.deepEqual(v.turn.order, [ids[5], ids[4], ids[3], ids[2], ids[1], ids[0]]);
    assert.equal(v.schedule.outCount, 2);
  });
});

// ------------------------------------------------------------------------------------------------ §3 votes
describe('§3 vote procedure', () => {
  test('secret while open, changeable, auto-closes, result published openly', () => {
    const { g, ids } = started(6);
    advanceTo(g, 5, 'vote');
    const v = g.view(ids[0]).vote;
    assert.deepEqual(v, { stage: 'main', ballot: 1, ballots: 1, candidates: ids, voters: ids, voted: [] });
    assert.equal(g.view(ids[0]).turn, null);
    assert.equal(g.view(ids[0]).timer, null);
    err(g.handle(ids[0], { t: 'vote', targetId: ids[0] }), 'not_allowed');
    err(g.handle(ids[0], { t: 'vote', targetId: 'ghost' }), 'not_allowed');
    ok(g.handle(ids[0], { t: 'vote', targetId: ids[1] }));
    ok(g.handle(ids[0], { t: 'vote', targetId: ids[2] })); // changed
    assert.equal(g.view(ids[0]).me.myVote, ids[2]);
    assert.equal(g.view(ids[1]).me.myVote, null);
    assert.deepEqual(g.view(ids[1]).vote.voted, [ids[0]]);
    for (const id of ids.slice(1)) assert.ok(!JSON.stringify(g.view(id)).includes(`"myVote":"${ids[2]}"`));
    votes(g, { [ids[1]]: ids[2], [ids[2]]: ids[1], [ids[3]]: ids[2], [ids[4]]: ids[2] });
    assert.equal(g.phase, 'vote');
    votes(g, { [ids[5]]: ids[1] });
    assert.equal(status(g, ids[2]), 'ejected');
    assert.equal(g.phase, 'reveal');
    assert.equal(g.round, 6);
    const r = g.view(ids[1]).lastVoteResult;
    assert.equal(r.stage, 'main');
    assert.equal(r.ejectedId, ids[2]);
    assert.equal(r.tie, null);
    assert.equal(r.random, false);
    assert.equal(r.cancelled, false);
    assert.deepEqual(r.tally.map((e) => [e.targetId, e.votes]), [[ids[2], 4], [ids[1], 2], [ids[0], 0], [ids[3], 0], [ids[4], 0], [ids[5], 0]]);
    assert.deepEqual(r.tally[0].voterIds, [ids[0], ids[1], ids[3], ids[4]]);
    assert.match(logText(g), /vote 1 of 1: P2 4 \(P0, P1, P3, P4\); P1 2 \(P2, P5\)/);
    assert.match(logText(g), /P2 is ejected/);
    // ejected players see public info plus their own cards, and cannot vote any more
    const ev = g.view(ids[2]);
    assert.ok(ev.me);
    assert.equal(ev.me.canPlaySpecial, false);
  });

  test('tie → defense (in seat order) → revote → still tied → fate decides', () => {
    const { g, ids, clock } = started(6, { seed: 3 });
    advanceTo(g, 5, 'vote');
    votes(g, { [ids[0]]: ids[3], [ids[1]]: ids[3], [ids[3]]: ids[1], [ids[4]]: ids[1] });
    ok(g.handle(ids[0], { t: 'closeVote' }));
    assert.equal(g.phase, 'defense');
    let v = g.view(ids[2]);
    assert.equal(v.vote, null);
    assert.deepEqual(v.lastVoteResult.tie, [ids[1], ids[3]]);
    assert.equal(v.lastVoteResult.ejectedId, null);
    assert.deepEqual(v.turn, { kind: 'defense', speakerId: ids[1], order: [ids[1], ids[3]], index: 0, mustReveal: null, hasRevealed: false });
    assert.equal(v.timer.endsAt, clock.t + 30_000);
    assert.equal(v.schedule.kicksThisStep, 1);
    assert.equal(v.schedule.nextVoteRound, 5);
    err(g.handle(ids[3], { t: 'endTurn' }), 'not_your_turn');
    err(g.handle(ids[1], { t: 'vote', targetId: ids[3] }), 'wrong_phase');
    ok(g.handle(ids[1], { t: 'endTurn' }));
    assert.equal(g.view(ids[2]).turn.speakerId, ids[3]);
    next(g);
    assert.equal(g.phase, 'vote');
    v = g.view(ids[2]);
    assert.equal(v.vote.stage, 'revote');
    assert.equal(v.vote.ballot, 1);
    assert.deepEqual(v.vote.candidates, [ids[1], ids[3]]);
    assert.deepEqual(v.vote.voters, ids); // the main ballot's voters, all with a valid target
    err(g.handle(ids[1], { t: 'vote', targetId: ids[1] }), 'not_allowed');
    err(g.handle(ids[0], { t: 'vote', targetId: ids[2] }), 'not_allowed');
    votes(g, { [ids[0]]: ids[1], [ids[1]]: ids[3], [ids[2]]: ids[1], [ids[3]]: ids[1], [ids[4]]: ids[3], [ids[5]]: ids[3] });
    const r = g.lastVoteResult;
    assert.equal(r.stage, 'revote');
    assert.deepEqual(r.tie, [ids[1], ids[3]]);
    assert.equal(r.random, true);
    assert.ok([ids[1], ids[3]].includes(r.ejectedId));
    assert.equal(status(g, r.ejectedId), 'ejected');
    assert.match(logText(g), /fate decides/i);
    assert.equal(g.round, 6);
  });

  test('a revote with a unique top ejects without fate', () => {
    const { g, ids } = started(6);
    advanceTo(g, 5, 'vote');
    votes(g, { [ids[0]]: ids[1], [ids[1]]: ids[0], [ids[2]]: ids[0], [ids[3]]: ids[1], [ids[4]]: ids[2], [ids[5]]: ids[2] });
    assert.equal(g.phase, 'defense');
    assert.deepEqual(g.turn.order, [ids[0], ids[1], ids[2]]);
    next(g); next(g); next(g);
    votes(g, { [ids[0]]: ids[2], [ids[1]]: ids[2], [ids[2]]: ids[0], [ids[3]]: ids[0], [ids[4]]: ids[2], [ids[5]]: ids[1] });
    assert.equal(g.lastVoteResult.ejectedId, ids[2]);
    assert.equal(g.lastVoteResult.random, false);
    assert.equal(g.lastVoteResult.tie, null);
  });

  test('zero votes (main and revote): a random candidate is ejected', () => {
    const { g, ids } = started(6, { seed: 11 });
    advanceTo(g, 5, 'vote');
    ok(g.handle(ids[0], { t: 'closeVote' }));
    let r = g.lastVoteResult;
    assert.equal(r.random, true);
    assert.equal(r.tie, null);
    assert.ok(ids.includes(r.ejectedId));
    assert.ok(r.tally.every((e) => e.votes === 0 && e.voterIds.length === 0));
    assert.equal(r.tally.length, 6);
    assert.match(logText(g), /Nobody voted — fate decides/);
    // revote with zero votes
    advanceTo(g, 6, 'vote');
    const alive = aliveIds(g);
    votes(g, { [alive[0]]: alive[1], [alive[1]]: alive[0] });
    ok(g.handle(ids[0], { t: 'closeVote' }));
    assert.equal(g.phase, 'defense');
    next(g); next(g);
    assert.equal(g.vote.stage, 'revote');
    next(g); // host closes the revote: nobody voted
    r = g.lastVoteResult;
    assert.equal(r.stage, 'revote');
    assert.equal(r.random, true);
    assert.ok([alive[0], alive[1]].includes(r.ejectedId));
  });

  test('multi-ballot step: "vote 1 of 2" then the next ballot opens immediately', () => {
    const { g, ids } = started(16, { seed: 5 });
    advanceTo(g, 2, 'vote');
    advanceTo(g, 6, 'vote');
    const v = g.view(ids[0]).vote;
    assert.equal(v.ballot, 1);
    assert.equal(v.ballots, 2);
    const alive = aliveIds(g);
    for (const id of alive) if (id !== alive[0]) ok(g.handle(id, { t: 'vote', targetId: alive[0] }));
    ok(g.handle(alive[0], { t: 'vote', targetId: alive[1] }));
    assert.equal(status(g, alive[0]), 'ejected');
    const v2 = g.view(ids[1]).vote;
    assert.equal(g.phase, 'vote');
    assert.equal(v2.ballot, 2);
    assert.equal(v2.ballots, 2);
    assert.equal(v2.candidates.includes(alive[0]), false);
    assert.equal(g.view(ids[1]).lastVoteResult.ejectedId, alive[0]);
  });

  test('double_vote counts twice at tally, even when played during the open ballot', () => {
    const { g, ids } = started(6, { specials: { 2: [sp('double_vote')], 3: [sp('double_vote')] } });
    advanceTo(g, 4, 'discussion');
    ok(play(g, ids[2], 'double_vote'));
    assert.deepEqual(g.view(ids[0]).voteMods.doubleVote, [ids[2]]);
    advanceTo(g, 5, 'vote');
    ok(play(g, ids[3], 'double_vote')); // anytime: counts for this ballot
    assert.match(lastLog(g), /counts twice in this vote/);
    votes(g, { [ids[2]]: ids[0], [ids[3]]: ids[0], [ids[0]]: ids[1], [ids[1]]: ids[4], [ids[4]]: ids[1], [ids[5]]: ids[1] });
    const r = g.lastVoteResult;
    assert.deepEqual(r.tally.slice(0, 2).map((e) => [e.targetId, e.votes]), [[ids[0], 4], [ids[1], 3]]);
    assert.equal(r.ejectedId, ids[0]);
    assert.match(logText(g), /P0 4 \(P2 ×2, P3 ×2\)/);
    assert.deepEqual(g.view(ids[1]).voteMods.doubleVote, []); // cleared when the step ended
  });

  test('immunity / protect: not a candidate for the next step, then cleared; they carry over steps that do not happen', () => {
    const { g, ids } = started(6, { specials: { 1: [sp('immunity')], 2: [sp('protect')] } });
    ok(play(g, ids[1], 'immunity'));
    ok(play(g, ids[2], 'protect', { targetId: ids[4] }));
    assert.deepEqual(g.view(ids[0]).voteMods.immune, [ids[1], ids[4]]);
    advanceTo(g, 5, 'vote'); // rounds 1..4 had no step: still immune
    const v = g.view(ids[0]).vote;
    assert.deepEqual(v.candidates, [ids[0], ids[2], ids[3], ids[5]]);
    err(g.handle(ids[0], { t: 'vote', targetId: ids[1] }), 'not_allowed');
    assert.ok(v.voters.includes(ids[1]));
    votes(g, { [ids[0]]: ids[5], [ids[1]]: ids[5], [ids[2]]: ids[5], [ids[3]]: ids[5], [ids[4]]: ids[5], [ids[5]]: ids[0] });
    assert.equal(status(g, ids[5]), 'ejected');
    assert.deepEqual(g.view(ids[0]).voteMods.immune, []);
  });

  test('block_vote: the target is not a voter in the next step', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('block_vote')] } });
    advanceTo(g, 3, 'reveal');
    ok(play(g, ids[0], 'block_vote', { targetId: ids[3] }));
    assert.deepEqual(g.view(ids[5]).voteMods.blocked, [ids[3]]);
    advanceTo(g, 5, 'vote');
    assert.deepEqual(g.view(ids[5]).vote.voters, [ids[0], ids[1], ids[2], ids[4], ids[5]]);
    assert.ok(g.view(ids[5]).vote.candidates.includes(ids[3]));
    err(g.handle(ids[3], { t: 'vote', targetId: ids[1] }), 'not_allowed');
    votes(g, { [ids[0]]: ids[1], [ids[1]]: ids[2], [ids[2]]: ids[1], [ids[4]]: ids[1] });
    assert.equal(g.phase, 'vote');
    votes(g, { [ids[5]]: ids[1] }); // the last non-blocked voter closes the ballot
    assert.equal(status(g, ids[1]), 'ejected');
    assert.deepEqual(g.view(ids[5]).voteMods.blocked, []);
  });

  test('everyone blocked: no voters, the ballot closes at once with zero votes', () => {
    const specials = {};
    for (let i = 0; i < 4; i++) specials[i] = [sp('block_vote')];
    const { g, ids } = started(4, { specials });
    advanceTo(g, 5, 'reveal');
    for (let i = 0; i < 4; i++) ok(play(g, ids[i], 'block_vote', { targetId: ids[(i + 1) % 4] }));
    advanceTo(g, 6, 'discussion');
    next(g);
    assert.equal(g.round, 7);
    assert.equal(g.phase, 'reveal');
    assert.equal(g.lastVoteResult.random, true);
    assert.equal(g.players.filter((p) => p.status === 'ejected').length, 1);
  });

  test('everyone immune: the rest of the step is cancelled (and the kick carries over)', () => {
    const specials = {};
    for (let i = 0; i < 4; i++) specials[i] = [sp('immunity')];
    const { g, ids } = started(4, { specials });
    advanceTo(g, 6, 'reveal');
    for (const id of ids) ok(play(g, id, 'immunity'));
    advanceTo(g, 6, 'discussion');
    next(g);
    assert.equal(g.round, 7);
    assert.equal(g.phase, 'reveal');
    assert.equal(g.lastVoteResult.cancelled, true);
    assert.match(logText(g), /everyone is immune/);
    assert.deepEqual(g.view(ids[0]).voteMods.immune, []);
    assert.equal(g.view(ids[0]).schedule.kicksThisStep, 2); // round 7: alive − capacity
    advanceTo(g, 7, 'vote');
    assert.equal(g.view(ids[0]).vote.ballots, 2);
  });
});

// ------------------------------------------------------------------------------------------------ cancel & overtime
describe('cancel_vote, overtime', () => {
  test('cancel_vote before a step sets cancelNext; a 0-kick step does not consume it; the kicks carry over', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('cancel_vote')], 1: [sp('cancel_vote')] } });
    ok(play(g, ids[0], 'cancel_vote'));
    assert.match(lastLog(g), /next vote will be cancelled/);
    assert.equal(g.view(ids[3]).voteMods.cancelNext, true);
    err(play(g, ids[1], 'cancel_vote'), 'not_allowed'); // cannot stack
    assert.equal(P(g, ids[1]).specials[0].used, false);
    assert.equal(g.view(ids[1]).me.canPlaySpecial, true); // a rejected play costs nothing
    advanceTo(g, 4, 'discussion');
    assert.equal(g.voteMods.cancelNext, true);
    advanceTo(g, 5, 'discussion');
    next(g); // the round 5 step is skipped
    assert.equal(g.round, 6);
    assert.equal(g.phase, 'reveal');
    assert.equal(g.voteMods.cancelNext, false);
    assert.deepEqual(g.lastVoteResult, { stage: 'main', tally: [], ejectedId: null, tie: null, random: false, cancelled: true });
    assert.equal(g.view(ids[0]).schedule.kicksThisStep, 2);
    advanceTo(g, 6, 'vote');
    assert.equal(g.view(ids[0]).vote.ballots, 2);
  });

  test('cancel_vote during an open ballot and during a defense cancels the running step at once', () => {
    const { g, ids } = started(8, { specials: { 0: [sp('cancel_vote')], 1: [sp('cancel_vote')] } });
    advanceTo(g, 4, 'vote');
    votes(g, { [ids[2]]: ids[3] });
    ok(play(g, ids[0], 'cancel_vote'));
    assert.equal(g.phase, 'reveal');
    assert.equal(g.round, 5);
    assert.deepEqual(g.lastVoteResult, { stage: 'main', tally: [], ejectedId: null, tie: null, random: false, cancelled: true });
    assert.ok(!logText(g).includes('P3 1'), 'open votes are discarded unpublished');
    assert.equal(g.view(ids[0]).schedule.kicksThisStep, 2);
    advanceTo(g, 5, 'vote');
    votes(g, { [ids[0]]: ids[2], [ids[2]]: ids[0] });
    ok(g.handle(ids[0], { t: 'closeVote' }));
    assert.equal(g.phase, 'defense');
    ok(play(g, ids[1], 'cancel_vote'));
    assert.equal(g.round, 6);
    assert.equal(g.phase, 'reveal');
    assert.equal(g.lastVoteResult.cancelled, true);
    assert.equal(g.players.filter((p) => p.status === 'ejected').length, 0);
    assert.equal(g.view(ids[0]).schedule.kicksThisStep, 3);
  });

  test('overtime after a cancelled round-7 vote; overtime counts as round 7 for specials', () => {
    const specials = {};
    for (let i = 0; i < 4; i++) specials[i] = [sp('cancel_vote'), sp('capacity_minus')];
    const { g, ids } = started(4, { specials, seed: 9 });
    advanceTo(g, 6, 'vote');
    next(g); // random eject
    assert.equal(g.round, 7);
    const alive = aliveIds(g);
    assert.equal(alive.length, 3);
    ok(play(g, alive[0], 'cancel_vote'));
    advanceTo(g, 7, 'discussion');
    next(g); // round 7 step skipped → overtime
    assert.equal(g.overtime, true);
    assert.equal(g.round, 7);
    assert.equal(g.phase, 'discussion');
    assert.equal(g.lastVoteResult.cancelled, true);
    const v = g.view(alive[0]);
    assert.equal(v.overtime, true);
    assert.equal(v.timer.label, 'Overtime discussion');
    assert.equal(v.schedule.nextVoteRound, 7);
    assert.equal(v.me.canPlaySpecial, false); // already played in round 7
    err(play(g, alive[0], 'capacity_minus'), 'not_allowed');
    assert.match(logText(g), /Overtime — the bunker is still over capacity/);
    next(g);
    assert.equal(g.phase, 'vote');
    assert.equal(g.view(alive[1]).vote.ballots, 1);
    next(g);
    assert.equal(g.phase, 'final');
    assert.equal(g.final.survivors.length, 2);
  });

  test('overtime repeats while alive > capacity (cancel in overtime too)', () => {
    const specials = {};
    for (let i = 0; i < 4; i++) specials[i] = [sp('cancel_vote'), sp('cancel_vote')];
    const { g } = started(4, { specials, seed: 4 });
    advanceTo(g, 6, 'vote');
    next(g);
    const alive = aliveIds(g);
    ok(play(g, alive[0], 'cancel_vote'));
    advanceTo(g, 7, 'discussion');
    next(g);
    assert.equal(g.overtime, true);
    ok(play(g, alive[1], 'cancel_vote'));
    next(g); // skipped again → another overtime discussion
    assert.equal(g.phase, 'discussion');
    assert.equal(g.overtime, true);
    next(g);
    next(g);
    assert.equal(g.phase, 'final');
  });
});

// ------------------------------------------------------------------------------------------------ §5 specials
describe('§5 special cards', () => {
  test('swap_card: fixed category, both cards revealed and moved; target validation', () => {
    const { g, ids } = started(4, { specials: { 0: [sp('swap_card', { category: 'baggage' })], 1: [sp('swap_card', { category: 'choose' })] } });
    const a = P(g, ids[0]).cards.baggage.text;
    const b = P(g, ids[2]).cards.baggage.text;
    err(play(g, ids[0], 'swap_card', { targetId: ids[0] }), 'not_allowed');
    err(play(g, ids[0], 'swap_card'), 'not_allowed');
    err(play(g, ids[0], 'swap_card', { targetId: 'ghost' }), 'not_allowed');
    ok(play(g, ids[0], 'swap_card', { targetId: ids[2], category: 'health' })); // fixed category: message category ignored
    assert.equal(P(g, ids[0]).cards.baggage.text, b);
    assert.equal(P(g, ids[2]).cards.baggage.text, a);
    assert.equal(P(g, ids[0]).cards.baggage.revealed, true);
    assert.equal(P(g, ids[2]).cards.baggage.revealed, true);
    assert.equal(P(g, ids[0]).cards.health.revealed, false);
    assert.equal(lastLog(g), `Round 1 — P0 played “T:swap_card”: ${P(g, ids[0]).playedSpecials[0].text} → P0 and P2 swapped Baggage: P0 now has “${b}”, P2 now has “${a}”`);
    const v = g.view(ids[3]);
    assert.equal(v.players[0].cards.baggage, b);
    assert.equal(v.players[0].playedSpecials[0].title, 'T:swap_card');
    assert.equal(v.players[0].specialsLeft, 1);
    // 'choose' allows any category, even an already revealed one
    err(play(g, ids[1], 'swap_card', { targetId: ids[3] }), 'not_allowed');
    ok(play(g, ids[1], 'swap_card', { targetId: ids[0], category: 'baggage' }));
    assert.equal(P(g, ids[1]).cards.baggage.text, b);
    // one special per round
    err(play(g, ids[0], 'bunker_add_feature'), 'not_allowed');
    assertRedacted(g);
  });

  test('reroll_card (self and other): replaced card is revealed; the old one is never shown, not even in the final', () => {
    const { g, ids } = started(4, { specials: { 0: [sp('reroll_card', { target: 'self', category: 'health' })], 1: [sp('reroll_card', { target: 'other', category: 'choose' })] } });
    const old0 = P(g, ids[0]).cards.health.text;
    const old2 = P(g, ids[2]).cards.phobia.text;
    ok(play(g, ids[0], 'reroll_card', { targetId: ids[3] })); // self: targetId ignored
    assert.notEqual(P(g, ids[0]).cards.health.text, old0);
    assert.equal(P(g, ids[0]).cards.health.revealed, true);
    assert.equal(P(g, ids[3]).cards.health.revealed, false);
    err(play(g, ids[1], 'reroll_card', { targetId: ids[2] }), 'not_allowed'); // category missing
    ok(play(g, ids[1], 'reroll_card', { targetId: ids[2], category: 'phobia' }));
    assert.equal(P(g, ids[2]).cards.phobia.revealed, true);
    assert.match(lastLog(g), /P2's Phobia was replaced with a new card/);
    assertRedacted(g, [old0, old2]);
    while (g.phase !== 'final') next(g);
    assertRedacted(g, [old0, old2]);
    assert.ok(!logText(g).includes(old0) && !logText(g).includes(old2));
  });

  test('force_reveal: choose among hidden only, or random; a target with no hidden cards is invalid', () => {
    const { g, ids } = started(4, { specials: { 0: [sp('force_reveal', { category: 'choose' })], 1: [sp('force_reveal', { category: 'random' })] } });
    ok(g.handle(ids[0], { t: 'reveal', category: 'profession' }));
    ok(g.handle(ids[0], { t: 'endTurn' }));
    ok(g.handle(ids[1], { t: 'reveal', category: 'profession' }));
    err(play(g, ids[0], 'force_reveal', { targetId: ids[1], category: 'profession' }), 'not_allowed'); // already revealed
    err(play(g, ids[0], 'force_reveal', { targetId: ids[1] }), 'not_allowed'); // must choose
    ok(play(g, ids[0], 'force_reveal', { targetId: ids[1], category: 'phobia' }));
    assert.equal(P(g, ids[1]).cards.phobia.revealed, true);
    assert.equal(g.view(ids[3]).players[1].cards.phobia, P(g, ids[1]).cards.phobia.text);
    assert.match(lastLog(g), /P1 had to reveal Phobia: “<phobia#\d+>”/);
    ok(play(g, ids[1], 'force_reveal', { targetId: ids[2], category: 'baggage' })); // 'random': the category is ignored
    assert.equal(CATEGORY_IDS.filter((c) => P(g, ids[2]).cards[c].revealed).length, 1);
    // a target with nothing hidden cannot be picked
    const g2 = started(2, { specials: { 0: [sp('force_reveal', { category: 'random' })], 1: [sp('mass_reveal', { category: 'choose' })] } }).g;
    const [x, y] = g2.players.map((p) => p.id);
    for (const c of CATEGORY_IDS) g2.players[1].cards[c].revealed = true; // (setup shortcut: reveal all of y's cards)
    err(g2.handle(x, { t: 'special', uid: uidOf(g2, x, 'force_reveal'), targetId: y }), 'not_allowed');
    assert.equal(g2.players[0].specials[0].used, false);
  });

  test('peek: private note for the player only; the public log only says a peek happened', () => {
    const { g, ids } = started(4, { specials: { 0: [sp('peek', { category: 'choose' })], 1: [sp('peek', { category: 'random' })] } });
    const secret = P(g, ids[2]).cards.health.text;
    ok(play(g, ids[0], 'peek', { targetId: ids[2], category: 'health' }));
    assert.equal(P(g, ids[2]).cards.health.revealed, false);
    const mine = g.view(ids[0]).me.notes;
    assert.equal(mine.length, 1);
    assert.ok(mine[0].text.includes(secret));
    assert.equal(typeof mine[0].ts, 'number');
    assert.match(lastLog(g), /P0 secretly looked at one of P2's hidden cards$/);
    assert.ok(!lastLog(g).includes('Health'));
    for (const id of [ids[1], ids[2], ids[3]]) assert.deepEqual(g.view(id).me.notes, []);
    for (const id of [ids[1], ids[3]]) assert.ok(!JSON.stringify(g.view(id)).includes(secret));
    ok(play(g, ids[1], 'peek', { targetId: ids[3] }));
    assert.equal(g.view(ids[1]).me.notes.length, 1);
    assertRedacted(g);
  });

  test('mass_reveal: every alive player’s card of the category; ejected players keep theirs hidden', () => {
    const { g, ids } = started(4, { specials: { 0: [sp('eject')], 1: [sp('mass_reveal', { category: 'choose' })], 2: [sp('mass_reveal', { category: 'trait' })] } });
    finishReveal(g);
    next(g);
    ok(play(g, ids[0], 'eject', { targetId: ids[3] }));
    err(play(g, ids[1], 'mass_reveal'), 'not_allowed');
    ok(play(g, ids[1], 'mass_reveal', { category: 'skill' }));
    for (const id of ids.slice(0, 3)) assert.equal(P(g, id).cards.skill.revealed, true);
    assert.equal(P(g, ids[3]).cards.skill.revealed, false);
    assert.match(lastLog(g), /everyone's Extra skill is revealed: P0 — “<skill#\d+>”; P1 — /);
    ok(play(g, ids[2], 'mass_reveal'));
    assert.equal(P(g, ids[0]).cards.trait.revealed, true);
    assertRedacted(g);
  });

  test('shuffle_category: the alive players’ cards of that category are permuted and all revealed', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('shuffle_category', { category: 'baggage' })] }, seed: 21 });
    const before = ids.map((id) => P(g, id).cards.baggage.text).sort();
    ok(play(g, ids[0], 'shuffle_category'));
    const after = ids.map((id) => P(g, id).cards.baggage.text).sort();
    assert.deepEqual(after, before);
    for (const id of ids) assert.equal(P(g, id).cards.baggage.revealed, true);
    assert.match(lastLog(g), /all Baggage cards were shuffled/);
  });

  test('immunity / protect / block_vote are before_vote; protect and block need another alive player', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('immunity'), sp('protect')], 1: [sp('block_vote'), sp('protect')], 2: [sp('eject')] } });
    err(play(g, ids[1], 'protect', { targetId: ids[1] }), 'not_allowed');
    err(play(g, ids[1], 'block_vote'), 'not_allowed');
    ok(play(g, ids[1], 'block_vote', { targetId: ids[0] }));
    ok(play(g, ids[0], 'immunity'));
    assert.match(lastLog(g), /nobody can vote against P0 in the next vote/);
    advanceTo(g, 2, 'reveal');
    ok(play(g, ids[2], 'eject', { targetId: ids[5] }));
    err(play(g, ids[0], 'protect', { targetId: ids[5] }), 'not_allowed'); // ejected is not a valid target
    advanceTo(g, 6, 'vote'); // the special ejection covered round 5's kick
    err(play(g, ids[0], 'protect', { targetId: ids[3] }), 'wrong_phase');
    err(play(g, ids[1], 'protect', { targetId: ids[3] }), 'wrong_phase');
    assert.equal(P(g, ids[0]).specials[1].used, false);
  });

  test('eject: from round 2 only, before the vote; ends the game when alive ≤ capacity', () => {
    const { g, ids } = started(4, { specials: { 0: [sp('eject')], 1: [sp('eject')], 2: [sp('eject')] } });
    err(play(g, ids[0], 'eject', { targetId: ids[1] }), 'not_allowed'); // round 1
    assert.equal(g.view(ids[0]).me.specials[0].minRound, 2);
    assert.equal(g.view(ids[0]).me.specials[0].timing, 'before_vote');
    finishReveal(g);
    next(g);
    err(play(g, ids[0], 'eject', { targetId: ids[0] }), 'not_allowed');
    ok(play(g, ids[0], 'eject', { targetId: ids[1] }));
    assert.equal(status(g, ids[1]), 'ejected');
    assert.match(lastLog(g), /P1 is ejected and stays in the forest/);
    err(play(g, ids[1], 'eject', { targetId: ids[2] }), 'not_allowed'); // ejected players cannot play
    assert.equal(g.view(ids[0]).schedule.outCount, 1);
    ok(play(g, ids[2], 'eject', { targetId: ids[3] }));
    assert.equal(g.phase, 'final');
    assert.deepEqual(g.final, { survivors: [ids[0], ids[2]], out: [ids[1], ids[3]] });
  });

  test('revive: only an ejected (not left) player; they wait for the next round to speak; more kicks become due', () => {
    const { g, ids } = started(4, { specials: { 0: [sp('eject')], 1: [sp('revive')], 2: [sp('revive')] } });
    err(play(g, ids[1], 'revive', { targetId: ids[2] }), 'not_allowed'); // nobody is ejected
    finishReveal(g);
    next(g);
    finishReveal(g);
    ok(play(g, ids[0], 'eject', { targetId: ids[3] })); // round 2 discussion
    next(g); // round 3 reveal, order without P3
    assert.deepEqual(g.view(ids[0]).turn.order, [ids[0], ids[1], ids[2]]);
    ok(play(g, ids[1], 'revive', { targetId: ids[3] }));
    assert.equal(status(g, ids[3]), 'alive');
    assert.match(lastLog(g), /P3 is back in the game/);
    assert.deepEqual(g.view(ids[0]).turn.order, [ids[0], ids[1], ids[2]]);
    assert.equal(g.view(ids[3]).me.canPlaySpecial, true);
    finishReveal(g);
    next(g);
    assert.deepEqual(g.view(ids[0]).turn.order, [ids[3], ids[2], ids[1], ids[0]]);
    // a left player cannot be revived
    ok(g.handle(ids[3], { t: 'leave' }));
    err(play(g, ids[2], 'revive', { targetId: ids[3] }), 'not_allowed');
  });

  test('revive prevents the end: round 7 needs alive − capacity kicks', () => {
    const specials = {};
    for (let i = 0; i < 4; i++) specials[i] = [sp('revive')];
    const { g, ids } = started(4, { specials });
    advanceTo(g, 6, 'vote');
    next(g);
    const out = ids.find((id) => status(g, id) === 'ejected');
    const reviver = aliveIds(g)[0];
    ok(play(g, reviver, 'revive', { targetId: out }));
    assert.equal(aliveIds(g).length, 4);
    advanceTo(g, 7, 'vote');
    assert.equal(g.view(ids[0]).vote.ballots, 2);
    next(g);
    assert.equal(g.phase, 'vote');
    next(g);
    assert.equal(g.phase, 'final');
    assert.equal(g.final.survivors.length, 2);
  });

  test('capacity_plus (anytime) can end the game at once; capacity_minus (before_vote) never below 1', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('capacity_minus')], 1: [sp('capacity_plus')], 2: [sp('capacity_plus')] } });
    ok(play(g, ids[0], 'capacity_minus'));
    assert.equal(g.capacity, 2);
    assert.match(lastLog(g), /the bunker now has 2 beds/);
    ok(play(g, ids[1], 'capacity_plus'));
    assert.equal(g.capacity, 3);
    advanceTo(g, 5, 'vote');
    votes(g, { [ids[0]]: ids[5], [ids[1]]: ids[5], [ids[2]]: ids[5], [ids[3]]: ids[5], [ids[4]]: ids[5], [ids[5]]: ids[0] });
    advanceTo(g, 6, 'vote');
    votes(g, { [ids[0]]: ids[4], [ids[1]]: ids[4], [ids[2]]: ids[4], [ids[3]]: ids[4], [ids[4]]: ids[0] });
    assert.equal(aliveIds(g).length, 4);
    advanceTo(g, 7, 'vote');
    ok(play(g, ids[2], 'capacity_plus')); // mid-ballot: alive 4 ≤ capacity 4
    assert.equal(g.phase, 'final');
    assert.equal(g.final.survivors.length, 4);
    // capacity_minus floor
    const g2 = started(2, { specials: { 0: [sp('capacity_minus')] } }).g;
    ok(g2.handle(g2.players[0].id, { t: 'special', uid: uidOf(g2, g2.players[0].id, 'capacity_minus') }));
    assert.equal(g2.capacity, 1);
    assert.match(g2.log[g2.log.length - 1].text, /already has only 1 bed/);
  });

  test('capacity_minus is before_vote; bunker_add_feature adds a feature', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('capacity_minus')], 1: [sp('bunker_add_feature')] } });
    ok(play(g, ids[1], 'bunker_add_feature'));
    assert.deepEqual(g.view(ids[4]).bunker.features, ['Well', '<feature#1>']);
    assert.match(lastLog(g), /→ the bunker gains a new feature: “<feature#1>”$/);
    advanceTo(g, 5, 'vote');
    err(play(g, ids[0], 'capacity_minus'), 'wrong_phase');
  });

  test('timing: before_vote cards are wrong_phase in vote and defense; anytime cards work there', () => {
    const specials = {
      0: [sp('immunity'), sp('mass_reveal', { category: 'health' })],
      1: [sp('block_vote'), sp('bunker_add_feature')],
      2: [sp('revive'), sp('eject')],
      3: [sp('capacity_minus'), sp('shuffle_category', { category: 'trait' })],
    };
    const { g, ids } = started(6, { specials });
    advanceTo(g, 5, 'vote');
    const tries = [[0, 'immunity', {}], [1, 'block_vote', { targetId: ids[4] }], [2, 'eject', { targetId: ids[4] }], [3, 'capacity_minus', {}]];
    for (const [i, effect, extra] of tries) err(play(g, ids[i], effect, extra), 'wrong_phase');
    votes(g, { [ids[0]]: ids[1], [ids[1]]: ids[0], [ids[2]]: ids[0], [ids[3]]: ids[1] });
    ok(g.handle(ids[0], { t: 'closeVote' }));
    assert.equal(g.phase, 'defense');
    for (const [i, effect, extra] of tries) err(play(g, ids[i], effect, extra), 'wrong_phase');
    ok(play(g, ids[0], 'mass_reveal')); // anytime works in defense
    ok(play(g, ids[1], 'bunker_add_feature'));
    ok(play(g, ids[3], 'shuffle_category'));
    assert.ok(P(g, ids[0]).specials.filter((s) => s.used).length === 1);
    assert.equal(g.phase, 'defense');
  });

  test('capacity_minus raises the round-7 kicks', () => {
    const specials = {};
    for (let i = 0; i < 6; i++) specials[i] = [sp('capacity_minus')];
    const { g, ids } = started(6, { specials });
    advanceTo(g, 7, 'reveal');
    const before = g.view(ids[0]).schedule.kicksThisStep;
    ok(play(g, aliveIds(g)[1], 'capacity_minus'));
    assert.equal(g.view(ids[0]).schedule.kicksThisStep, before + 1);
    advanceTo(g, 7, 'vote');
    assert.equal(g.view(ids[0]).vote.ballots, before + 1);
  });

  test('a speaker kicked by the host mid-turn is skipped like a leaver', () => {
    const { g, ids } = started(6);
    finishReveal(g);
    next(g);
    assert.equal(g.view(ids[0]).turn.speakerId, ids[5]);
    ok(g.handle(ids[0], { t: 'kick', playerId: ids[5] }));
    assert.equal(status(g, ids[5]), 'left');
    assert.equal(g.view(ids[0]).turn.speakerId, ids[4]);
    assert.equal(g.view(ids[0]).turn.index, 1);
  });

  test('general rules: one per round, used cards, spectators, lobby/final, unknown uid, rejected plays cost nothing', () => {
    const { g, ids, specs } = setup(4, { specials: { 0: [sp('bunker_add_feature'), sp('bunker_add_feature')] }, spectators: 1 });
    err(g.handle(ids[0], { t: 'special', uid: 's1' }), 'wrong_phase'); // lobby
    ok(g.handle(ids[0], { t: 'start' }));
    const [a, b] = P(g, ids[0]).specials.map((s) => s.uid);
    const v = g.view(ids[0]);
    assert.deepEqual(v.me.specials[0], { uid: a, id: 'bunker_add_feature', title: 'T:bunker_add_feature', text: P(g, ids[0]).specials[0].text, effect: 'bunker_add_feature', target: 'none', category: null, timing: 'anytime', minRound: 1, used: false });
    err(g.handle(specs[0], { t: 'special', uid: a }), 'not_allowed');
    err(g.handle(ids[1], { t: 'special', uid: a }), 'not_allowed'); // not their card
    ok(g.handle(ids[0], { t: 'special', uid: a, targetId: ids[3], category: 'health' })); // extra fields ignored for none
    assert.equal(g.view(ids[0]).me.canPlaySpecial, false);
    err(g.handle(ids[0], { t: 'special', uid: b }), 'not_allowed');
    finishReveal(g);
    next(g);
    assert.equal(g.view(ids[0]).me.canPlaySpecial, true);
    err(g.handle(ids[0], { t: 'special', uid: a }), 'not_allowed'); // used
    ok(g.handle(ids[0], { t: 'special', uid: b }));
    assert.equal(g.view(ids[1]).players[0].specialsLeft, 0);
    assert.equal(g.view(ids[1]).players[0].playedSpecials.length, 2);
  });

  test('content with a wrong target/category combination is normalized by the effect table', () => {
    const { g, ids } = started(4, { specials: { 0: [{ id: 'x', title: 'Bad', text: 'bad', effect: 'force_reveal', target: 'self', category: 'health' }, { id: 'y', title: 'Unknown', text: 'u', effect: 'teleport', target: 'none' }] } });
    const [c1, c2] = g.view(ids[0]).me.specials;
    assert.equal(c1.target, 'other');
    assert.equal(c1.category, 'choose');
    assert.equal(c2.effect, 'bunker_add_feature'); // unknown effects are redrawn (the test dealer then gives the filler)
  });
});

// ------------------------------------------------------------------------------------------------ leave / kick mid-step
describe('leave and kick', () => {
  test('lobby: leave removes and renumbers; host passes at once; kick rules', () => {
    const { g, ids, specs } = setup(4, { spectators: 1 });
    ok(g.handle(ids[1], { t: 'leave' }));
    assert.equal(g.view(ids[1]), null);
    assert.deepEqual(g.view(ids[0]).players.map((p) => [p.id, p.seat]), [[ids[0], 0], [ids[2], 1], [ids[3], 2]]);
    err(g.handle(ids[2], { t: 'kick', playerId: ids[3] }), 'not_host');
    err(g.handle(ids[0], { t: 'kick', playerId: ids[0] }), 'not_allowed');
    err(g.handle(ids[0], { t: 'kick', playerId: ids[1] }), 'not_allowed'); // already gone
    ok(g.handle(ids[0], { t: 'kick', playerId: specs[0] }));
    assert.equal(g.view(specs[0]), null);
    g.setConnected(ids[2], false);
    ok(g.handle(ids[0], { t: 'leave' }));
    assert.equal(g.hostId, ids[3]); // first *connected* player
    assert.equal(g.view(ids[3]).you.isHost, true);
    err(g.handle(ids[1], { t: 'next' }), 'not_in_room');
  });

  test('game: leave/kick make a player "left" (out), ejected players too; the end check runs', () => {
    const { g, ids, specs } = started(4, { spectators: 1, specials: { 0: [sp('eject')] } });
    finishReveal(g);
    next(g);
    ok(play(g, ids[0], 'eject', { targetId: ids[1] }));
    ok(g.handle(ids[0], { t: 'kick', playerId: ids[1] })); // ejected → left
    assert.equal(status(g, ids[1]), 'left');
    assert.equal(g.view(ids[1]), null);
    ok(g.handle(ids[0], { t: 'kick', playerId: specs[0] }));
    assert.equal(g.spectators.length, 0);
    assert.equal(g.view(ids[0]).schedule.outCount, 1);
    ok(g.handle(ids[3], { t: 'leave' }));
    assert.equal(g.phase, 'final');
    assert.deepEqual(g.final, { survivors: [ids[0], ids[2]], out: [ids[1], ids[3]] });
    assert.equal(g.view(ids[0]).players[1].status, 'left');
  });

  test('leave during an open ballot: votes by and for the leaver are discarded; over-ejection is absorbed later', () => {
    const { g, ids } = started(6);
    advanceTo(g, 5, 'vote');
    votes(g, { [ids[1]]: ids[2], [ids[3]]: ids[2], [ids[2]]: ids[0] });
    ok(g.handle(ids[2], { t: 'leave' }));
    let v = g.view(ids[0]).vote;
    assert.deepEqual(v.candidates, [ids[0], ids[1], ids[3], ids[4], ids[5]]);
    assert.deepEqual(v.voters, [ids[0], ids[1], ids[3], ids[4], ids[5]]);
    assert.deepEqual(v.voted, []);
    assert.equal(g.view(ids[1]).me.myVote, null);
    votes(g, { [ids[0]]: ids[4], [ids[1]]: ids[4], [ids[3]]: ids[4], [ids[4]]: ids[0], [ids[5]]: ids[4] });
    assert.equal(status(g, ids[4]), 'ejected');
    assert.equal(g.round, 6);
    v = g.view(ids[0]);
    assert.equal(v.schedule.outCount, 2);
    assert.equal(v.schedule.kicksThisStep, 0); // cum(6) = 2 = outCount
    assert.equal(v.schedule.nextVoteRound, 7);
    advanceTo(g, 7, 'vote');
    assert.equal(g.view(ids[0]).vote.ballots, 1);
    next(g);
    assert.equal(g.phase, 'final');
    assert.equal(g.final.survivors.length, 3);
  });

  test('a ballot left with no candidate ends with nobody ejected; voters without a valid target are dropped', () => {
    const specials = {};
    for (let i = 0; i < 4; i++) specials[i] = [sp('immunity')];
    const { g, ids } = started(4, { specials });
    advanceTo(g, 6, 'reveal');
    ok(play(g, ids[2], 'immunity'));
    ok(play(g, ids[3], 'immunity'));
    advanceTo(g, 6, 'vote');
    let v = g.view(ids[0]).vote;
    assert.deepEqual(v.candidates, [ids[0], ids[1]]);
    ok(g.handle(ids[0], { t: 'vote', targetId: ids[1] }));
    ok(g.handle(ids[1], { t: 'leave' }));
    v = g.view(ids[0]).vote;
    assert.deepEqual(v.candidates, [ids[0]]);
    assert.deepEqual(v.voters, [ids[2], ids[3]]); // P0 has nobody left to vote for
    votes(g, { [ids[2]]: ids[0], [ids[3]]: ids[0] });
    assert.equal(g.phase, 'final');
    assert.deepEqual(g.final.survivors, [ids[2], ids[3]]);

    // same, but the last candidate leaves → nobody ejected, the step re-evaluates (cum − out = 0 → ends)
    const s2 = started(6, { specials: { 1: [sp('immunity')], 2: [sp('immunity')], 3: [sp('immunity')], 4: [sp('immunity')], 5: [sp('immunity')] } });
    const g2 = s2.g;
    const i2 = s2.ids;
    for (let i = 1; i <= 5; i++) ok(play(g2, i2[i], 'immunity'));
    advanceTo(g2, 5, 'vote');
    assert.deepEqual(g2.view(i2[1]).vote.candidates, [i2[0]]);
    assert.equal(g2.hostId, i2[0]);
    ok(g2.handle(i2[0], { t: 'leave' }));
    assert.equal(g2.hostId, i2[1]);
    assert.deepEqual(g2.lastVoteResult, { stage: 'main', tally: [], ejectedId: null, tie: null, random: false, cancelled: false });
    assert.equal(g2.round, 6);
    assert.equal(g2.phase, 'reveal');
    assert.deepEqual(g2.view(i2[1]).voteMods.immune, []);
  });

  test('leave during defense: removed from the defense order; the revote uses whoever is left', () => {
    const { g, ids } = started(6);
    advanceTo(g, 5, 'vote');
    votes(g, { [ids[0]]: ids[1], [ids[1]]: ids[2], [ids[2]]: ids[1], [ids[3]]: ids[2], [ids[4]]: ids[0], [ids[5]]: ids[3] });
    assert.equal(g.phase, 'defense');
    assert.deepEqual(g.turn.order, [ids[1], ids[2]]);
    ok(g.handle(ids[1], { t: 'leave' }));
    const v = g.view(ids[0]);
    assert.equal(v.phase, 'defense');
    assert.deepEqual(v.turn.order, [ids[2]]);
    assert.equal(v.turn.speakerId, ids[2]);
    ok(g.handle(ids[2], { t: 'endTurn' }));
    assert.equal(g.vote.stage, 'revote');
    assert.deepEqual(g.vote.candidates, [ids[2]]);
    assert.deepEqual(g.vote.voters, [ids[0], ids[3], ids[4], ids[5]]);
    votes(g, { [ids[0]]: ids[2], [ids[3]]: ids[2], [ids[4]]: ids[2], [ids[5]]: ids[2] });
    assert.equal(status(g, ids[2]), 'ejected');
    // the leave counted as out: round 6 has cum 2 − out 2 = 0 kicks
    assert.equal(g.view(ids[0]).schedule.kicksThisStep, 0);
  });

  test('leave in the final keeps the final object; Play again drops left players', () => {
    const { g, ids } = started(4);
    while (g.phase !== 'final') next(g);
    const fin = JSON.stringify(g.final);
    const leaver = g.final.survivors[1];
    ok(g.handle(leaver, { t: 'leave' }));
    assert.equal(JSON.stringify(g.final), fin);
    assert.equal(status(g, leaver), 'left');
    ok(g.handle(g.hostId, { t: 'playAgain' }));
    assert.equal(g.players.length, 3);
    assert.ok(!g.players.some((p) => p.id === leaver));
    assert.equal(ids.length, 4);
  });
});

// ------------------------------------------------------------------------------------------------ host
describe('host powers and passing', () => {
  test('transferHost: only to a seated, non-left player other than the host', () => {
    const { g, ids, specs } = started(4, { spectators: 1 });
    err(g.handle(ids[1], { t: 'transferHost', playerId: ids[2] }), 'not_host');
    err(g.handle(ids[0], { t: 'transferHost', playerId: specs[0] }), 'not_allowed');
    err(g.handle(ids[0], { t: 'transferHost', playerId: ids[0] }), 'not_allowed');
    err(g.handle(ids[0], { t: 'transferHost', playerId: 'ghost' }), 'not_allowed');
    ok(g.handle(ids[3], { t: 'leave' }));
    err(g.handle(ids[0], { t: 'transferHost', playerId: ids[3] }), 'not_allowed');
    ok(g.handle(ids[0], { t: 'transferHost', playerId: ids[2] }));
    assert.equal(g.hostId, ids[2]);
    err(g.handle(ids[0], { t: 'next' }), 'not_host');
    next(g);
    assert.equal(g.view(ids[1]).players[2].isHost, true);
    assert.match(logText(g), /P2 is now the host/);
  });

  test('an ejected host keeps every host power', () => {
    const { g, ids } = started(4, { specials: { 1: [sp('eject')] } });
    finishReveal(g);
    next(g);
    ok(play(g, ids[1], 'eject', { targetId: ids[0] }));
    assert.equal(g.hostId, ids[0]);
    next(g);
    ok(g.handle(ids[0], { t: 'kick', playerId: ids[3] }));
    assert.equal(g.phase, 'final');
    ok(g.handle(ids[0], { t: 'playAgain' }));
  });

  test('host leaves in a game: connected alive > connected ejected > alive > ejected', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('eject')] } });
    finishReveal(g);
    next(g);
    ok(play(g, ids[0], 'eject', { targetId: ids[1] }));
    for (const id of [ids[2], ids[3], ids[4], ids[5]]) g.setConnected(id, false);
    ok(g.handle(ids[0], { t: 'leave' }));
    assert.equal(g.hostId, ids[1]); // connected ejected beats offline alive
    ok(g.handle(ids[1], { t: 'leave' }));
    assert.equal(g.hostId, ids[2]); // nobody connected: first alive
  });

  test('grace passing (passHost): only to a connected player; no-op otherwise; the ex-host does not get it back', () => {
    const { g, ids } = started(4);
    assert.equal(g.passHost(), false); // host online
    g.setConnected(ids[0], false);
    g.setConnected(ids[1], false);
    g.setConnected(ids[2], false);
    g.setConnected(ids[3], false);
    assert.equal(g.passHost(), false);
    assert.equal(g.hostId, ids[0]);
    g.setConnected(ids[2], true);
    assert.ok(g.hostOfflineMs() >= 0);
    assert.equal(g.passHost(), true);
    assert.equal(g.hostId, ids[2]);
    g.setConnected(ids[0], true);
    assert.equal(g.hostId, ids[2]);
    assert.equal(g.hostOfflineMs(), null);
  });

  test('hostId is "" when nobody qualifies; the next seated player becomes host', () => {
    const { g, ids, specs } = setup(1, { spectators: 1 });
    ok(g.handle(ids[0], { t: 'leave' }));
    assert.equal(g.hostId, '');
    assert.equal(g.view(specs[0]).hostId, '');
    const late = g.join('late', { spectator: true });
    assert.equal(g.hostId, '');
    ok(g.handle(specs[0], { t: 'takeSeat' }));
    assert.equal(g.hostId, specs[0]);
    assert.equal(late.role, 'spectator');
    const { g: g2, ids: i2 } = setup(1);
    ok(g2.handle(i2[0], { t: 'leave' }));
    const j = g2.join('newbie');
    assert.equal(g2.hostId, j.id);
  });
});

// ------------------------------------------------------------------------------------------------ play again
describe('play again', () => {
  test('returns to the lobby: same players (renumbered), spectators stay, host/options/log kept, the rest reset', () => {
    const { g, ids, specs } = started(5, { spectators: 1, seed: 2 });
    ok(g.handle(ids[0], { t: 'kick', playerId: ids[2] }));
    while (g.phase !== 'final') next(g);
    err(g.handle(ids[1], { t: 'playAgain' }), 'not_host');
    const lastLogId = g.log[g.log.length - 1].id;
    ok(g.handle(ids[0], { t: 'playAgain' }));
    const v = g.view(ids[1]);
    assert.equal(v.phase, 'lobby');
    assert.equal(v.round, 0);
    assert.equal(v.overtime, false);
    assert.equal(v.capacity, 0);
    assert.equal(v.me, null);
    assert.equal(v.final, null);
    assert.equal(v.lastVoteResult, null);
    assert.equal(v.catastrophe, null);
    assert.deepEqual(v.players.map((p) => [p.id, p.seat, p.status, p.specialsLeft]), [[ids[0], 0, 'alive', 0], [ids[1], 1, 'alive', 0], [ids[3], 2, 'alive', 0], [ids[4], 3, 'alive', 0]]);
    assert.deepEqual(v.spectators.map((s) => s.id), specs);
    assert.equal(v.hostId, ids[0]);
    assert.ok(v.log[v.log.length - 1].id > lastLogId);
    assert.deepEqual(v.voteMods, { immune: [], blocked: [], doubleVote: [], cancelNext: false });
    assert.equal(g.view(ids[2]), null);
    ok(g.handle(ids[0], { t: 'start' }));
    assert.equal(g.capacity, 2);
    assert.deepEqual(g.view(ids[0]).schedule.kicksByRound, KICKS[4]);
    assert.equal(g.view(ids[3]).me.specials.length, 2);
  });
});

// ------------------------------------------------------------------------------------------------ redaction
describe('redaction (§7, §9)', () => {
  test('no hidden text in any non-final view; the final reveals everything incl. unplayed specials', () => {
    const { g, ids, specs } = started(6, {
      spectators: 2,
      specials: {
        0: [sp('peek', { category: 'random' }), sp('swap_card', { category: 'choose' })],
        1: [sp('force_reveal', { category: 'random' }), sp('eject')],
        2: [sp('reroll_card', { target: 'other', category: 'choose' }), sp('double_vote')],
        3: [sp('mass_reveal', { category: 'choose' }), sp('shuffle_category', { category: 'choose' })],
      },
    });
    const secrets = [];
    const step = () => assertRedacted(g, secrets);
    step();
    ok(play(g, ids[0], 'peek', { targetId: ids[1] }));
    step();
    ok(play(g, ids[1], 'force_reveal', { targetId: ids[2] }));
    step();
    secrets.push(P(g, ids[3]).cards.hobby.text);
    ok(play(g, ids[2], 'reroll_card', { targetId: ids[3], category: 'hobby' }));
    step();
    ok(play(g, ids[3], 'mass_reveal', { category: 'phobia' }));
    step();
    let guard = 0;
    while (g.phase !== 'final' && guard++ < 500) {
      if (g.round === 2 && g.phase === 'reveal' && !P(g, ids[1]).specials[1].used) ok(play(g, ids[1], 'eject', { targetId: ids[5] }));
      if (g.round === 3 && g.phase === 'reveal' && !P(g, ids[0]).specials[1].used) ok(play(g, ids[0], 'swap_card', { targetId: ids[1], category: 'health' }));
      if (g.round === 3 && g.phase === 'discussion' && !P(g, ids[3]).specials[1].used) ok(play(g, ids[3], 'shuffle_category', { category: 'biology' }));
      next(g);
      step();
      if (g.phase === 'vote') {
        for (const id of g.vote.voters) {
          const target = g.vote.candidates.find((c) => c !== id);
          ok(g.handle(id, { t: 'vote', targetId: target }));
          if (g.phase !== 'vote') break;
          step();
        }
      }
    }
    assert.equal(g.phase, 'final');
    // final: every card and every unplayed special is public; revealedCount / revealed flags unchanged
    const v = g.view(specs[0]);
    for (const p of g.players) {
      const pv = v.players.find((x) => x.id === p.id);
      for (const c of CATEGORY_IDS) assert.equal(pv.cards[c], p.cards[c].text);
      assert.deepEqual(pv.unplayedSpecials, p.specials.filter((s) => !s.used).map((s) => ({ id: s.id, title: s.title, text: s.text })));
      assert.equal(pv.revealedCount, CATEGORY_IDS.filter((c) => p.cards[c].revealed).length);
    }
    assert.ok(v.players.some((p) => p.revealedCount < 8));
    assert.equal(v.me, null);
    assert.equal(g.view(ids[0]).me.notes.length, 1);
    assert.deepEqual(g.view(ids[1]).me.notes, []);
    step();
  });

  test('ejected players and spectators see only public info (+ own cards for the ejected)', () => {
    const { g, ids, specs } = started(4, { spectators: 1, specials: { 0: [sp('eject')] } });
    finishReveal(g);
    next(g);
    ok(play(g, ids[0], 'eject', { targetId: ids[3] }));
    const ev = g.view(ids[3]);
    assert.equal(ev.you.role, 'player');
    assert.ok(ev.me);
    assert.equal(ev.me.canPlaySpecial, false);
    assert.equal(g.view(specs[0]).me, null);
    assertRedacted(g);
  });
});

// ------------------------------------------------------------------------------------------------ fuzz
describe('fuzz', () => {
  test('random play never throws, keeps invariants and redaction, and every game can be finished by Next', () => {
    const effects = Object.keys(EFFECTS);
    const rnd = mulberry32(12345);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    for (let gameNo = 0; gameNo < 60; gameNo++) {
      const n = 2 + Math.floor(rnd() * 11);
      const specials = {};
      for (let i = 0; i < n; i++) {
        specials[i] = [0, 1].map(() => {
          const effect = pick(effects);
          const e = EFFECTS[effect];
          const cat = e.category === 'any' ? pick(['choose', ...CATEGORY_IDS]) : e.category === 'hidden' ? pick(['choose', 'random']) : undefined;
          return sp(effect, { target: pick(e.targets), ...(cat ? { category: cat } : {}) });
        });
      }
      const { g, ids, specs } = started(n, { specials, seed: gameNo + 1, spectators: 1 });
      const everyone = [...ids, ...specs, 'ghost'];
      for (let k = 0; k < 250 && g.phase !== 'final'; k++) {
        const actor = rnd() < 0.3 ? g.hostId || ids[0] : pick(everyone);
        const roll = rnd();
        let msg;
        if (roll < 0.25) msg = { t: 'next' };
        else if (roll < 0.35) msg = { t: 'reveal', category: pick(CATEGORY_IDS) };
        else if (roll < 0.45) msg = { t: 'endTurn' };
        else if (roll < 0.62) msg = { t: 'vote', targetId: pick(everyone) };
        else if (roll < 0.82) {
          const p = g.players.find((x) => x.id === actor);
          msg = { t: 'special', uid: p && p.specials.length ? pick(p.specials).uid : 's1', targetId: rnd() < 0.9 ? pick(everyone) : undefined, category: rnd() < 0.8 ? pick(CATEGORY_IDS) : undefined };
        } else if (roll < 0.85) msg = { t: 'closeVote' };
        else if (roll < 0.87) msg = { t: 'leave' };
        else if (roll < 0.89) msg = { t: 'kick', playerId: pick(everyone) };
        else if (roll < 0.91) msg = { t: 'transferHost', playerId: pick(everyone) };
        else if (roll < 0.93) { g.setConnected(pick(everyone), rnd() < 0.5); msg = { t: 'next' }; }
        else if (roll < 0.95) { g.passHost(); msg = { t: 'next' }; }
        else msg = pick([{ t: 'start' }, { t: 'playAgain' }, { t: 'takeSeat' }, { t: 'setOptions', options: { speechSeconds: 10 } }, { t: 'bogus' }, null]);
        const res = g.handle(actor, msg);
        assert.equal(typeof res.ok, 'boolean');
        assert.ok(!res.internal, `internal error: ${g.lastError?.stack}`);
        checkInvariants(g);
        if (k % 7 === 0) assertRedacted(g);
      }
      if (!g.hostId || !g.players.some((p) => p.id === g.hostId)) continue;
      let guard = 0;
      while (g.phase !== 'final') {
        assert.ok(guard++ < 2000, `game ${gameNo} does not terminate (${g.phase}, round ${g.round})`);
        ok(g.handle(g.hostId, { t: 'next' }));
        checkInvariants(g);
      }
      assertRedacted(g);
      ok(g.handle(g.hostId, { t: 'playAgain' }));
      checkInvariants(g);
    }
  });
});

function checkInvariants(g) {
  const phases = ['lobby', 'reveal', 'discussion', 'vote', 'defense', 'final'];
  assert.ok(phases.includes(g.phase));
  g.players.forEach((p, i) => assert.equal(p.seat, i));
  if (g.hostId) {
    const h = g.players.find((p) => p.id === g.hostId);
    assert.ok(h && h.status !== 'left', 'host must be a seated, non-left player');
  }
  const alive = g.players.filter((p) => p.status === 'alive');
  if (['reveal', 'discussion', 'vote', 'defense'].includes(g.phase)) {
    assert.ok(alive.length > g.capacity, 'alive must exceed capacity during play');
    assert.ok(g.capacity >= 1);
    assert.ok(g.round >= 1 && g.round <= MAX_ROUNDS);
  }
  if (g.phase === 'reveal') {
    const sp0 = g.turn.order[g.turn.index];
    assert.equal(g.players.find((p) => p.id === sp0)?.status, 'alive', 'reveal speaker must be alive');
  }
  if (g.phase === 'defense') {
    assert.ok(g.turn.order.length > 0);
    assert.ok(g.turn.order.every((id) => g.players.find((p) => p.id === id).status === 'alive'));
    assert.ok(g.turn.index < g.turn.order.length);
  }
  if (g.phase === 'vote') {
    assert.ok(g.vote && g.step);
    assert.ok(g.vote.candidates.length > 0);
    assert.ok(g.vote.candidates.every((id) => g.players.find((p) => p.id === id).status === 'alive'));
    assert.ok(g.vote.voters.every((id) => g.players.find((p) => p.id === id).status === 'alive'));
    assert.ok(g.vote.voters.every((id) => g.vote.candidates.some((c) => c !== id)));
    assert.ok(!g.vote.voters.every((id) => g.vote.votes.has(id)), 'a fully voted ballot must have closed');
    assert.ok(g.step.ballot >= 1 && g.step.ballot <= g.step.ballots);
    for (const [voter, target] of g.vote.votes) {
      assert.ok(g.vote.voters.includes(voter));
      assert.ok(g.vote.candidates.includes(target) && target !== voter);
    }
  } else {
    assert.equal(g.vote, null);
  }
  // §11 X1: open airlocks only in the reveal/discussion of their round, one per alive target, opened by someone else
  if (!['reveal', 'discussion'].includes(g.phase)) assert.deepEqual(g.airlocks, [], `airlocks open in ${g.phase}`);
  const airTargets = new Set();
  for (const a of g.airlocks) {
    assert.equal(g.players.find((p) => p.id === a.targetId)?.status, 'alive', 'an airlock target must be alive');
    assert.ok(!airTargets.has(a.targetId), 'one airlock per target');
    airTargets.add(a.targetId);
    assert.equal(a.round, g.round);
    assert.equal(a.byIds.length, 1);
    assert.ok(!a.byIds.includes(a.targetId));
  }
  if (g.phase === 'final') {
    assert.ok(g.final);
    assert.ok(g.final.survivors.every((id) => g.players.find((p) => p.id === id)));
  }
  for (const id of [...g.players.filter((p) => p.status !== 'left').map((p) => p.id), ...g.spectators.map((s) => s.id)]) {
    const v = g.view(id);
    assert.ok(v, 'active members always get a view');
    if (v.phase !== 'vote') assert.equal(v.vote, null);
    if (v.phase === 'lobby' || v.phase === 'final') {
      assert.equal(v.turn, null);
      assert.equal(v.timer, null);
    }
  }
}

// ------------------------------------------------------------------------------------------------ rooms.js (no sockets)
import { Rooms, ROOM_ALPHABET, MAX_ROOMS } from '../server/rooms.js';

function fakeConn() {
  const c = { out: [], send(obj) { c.out.push(JSON.parse(JSON.stringify(obj))); } };
  c.last = (t) => [...c.out].reverse().find((m) => !t || m.t === t);
  c.states = () => c.out.filter((m) => m.t === 'state');
  c.clear = () => { c.out.length = 0; };
  return c;
}
function registry(extra = {}) {
  const clock = { t: 5_000_000 };
  const rooms = new Rooms({ rng: mulberry32(99), minPlayers: 2, hostGraceMs: 45_000, now: () => clock.t, ...extra });
  const conn = () => { const c = fakeConn(); rooms.open(c); return c; };
  const send = (c, msg) => rooms.message(c, typeof msg === 'string' ? msg : JSON.stringify(msg));
  return { rooms, clock, conn, send };
}

describe('rooms.js registry', () => {
  test('create / join (case-insensitive code) / tokens / per-recipient state', () => {
    const { rooms, conn, send } = registry();
    const a = conn();
    send(a, { t: 'create', name: 'Ann' });
    const j = a.out[0];
    assert.equal(j.t, 'joined');
    assert.match(j.room, new RegExp(`^[${ROOM_ALPHABET}]{4}$`));
    assert.ok(Buffer.from(j.token, 'base64url').length >= 16, 'token has at least 128 bits');
    assert.equal(a.last('state').you.isHost, true);
    const b = conn();
    send(b, { t: 'join', room: ` ${j.room.toLowerCase()} `, name: 'Ann' });
    assert.equal(b.out[0].t, 'joined');
    assert.equal(b.last('state').you.name, 'Ann (2)');
    assert.equal(a.last('state').players.length, 2);
    const c = conn();
    send(c, { t: 'join', room: j.room, name: 'Zed', spectator: true });
    assert.equal(c.last('state').you.role, 'spectator');
    assert.equal(rooms.stats().rooms, 1);
    assert.equal(rooms.stats().sockets, 3);
  });

  test('error codes before and after identity; ping; malformed input never throws', () => {
    const { conn, send, rooms } = registry();
    const x = conn();
    send(x, 'not json');
    assert.equal(x.last().code, 'bad_request');
    send(x, '[1,2]');
    assert.equal(x.last().code, 'bad_request');
    send(x, { t: 'dance' });
    assert.equal(x.last().code, 'bad_request');
    rooms.message(x, null); // a binary frame
    assert.equal(x.last().code, 'bad_request');
    send(x, { t: 'next' });
    assert.equal(x.last().code, 'not_in_room');
    send(x, { t: 'vote' });
    assert.equal(x.last().code, 'bad_request');
    send(x, { t: 'join', room: 'QQQQ', name: 'x' });
    assert.equal(x.last().code, 'no_room');
    send(x, { t: 'join', room: 'QQQQ', name: '  ' });
    assert.equal(x.last().code, 'bad_request');
    send(x, { t: 'resume', room: 'QQQQ', token: 'nope' });
    assert.equal(x.last().code, 'no_room');
    send(x, { t: 'ping' });
    assert.deepEqual(x.last(), { t: 'pong' });
    send(x, { t: 'create', name: 'Host' });
    const room = x.out.find((m) => m.t === 'joined').room;
    send(x, { t: 'resume', room, token: 'forged' });
    assert.equal(x.last().code, 'bad_token');
    for (const m of x.out.filter((o) => o.t === 'error')) assert.equal(typeof m.message, 'string');
  });

  test('resume moves the identity to the new socket; the old one gets "replaced" and no more state', () => {
    const { conn, send } = registry();
    const a = conn();
    send(a, { t: 'create', name: 'Ann' });
    const { room, token, id } = a.out[0];
    const b = conn();
    send(b, { t: 'join', room, name: 'Bob' });
    const a2 = conn();
    send(a2, { t: 'resume', room: room.toLowerCase(), token });
    assert.deepEqual(a2.out[0], { t: 'joined', room, id, token });
    assert.equal(a.last().t, 'error');
    assert.equal(a.last().code, 'replaced');
    a.clear();
    send(b, { t: 'start' }); // not host → error to b only
    assert.equal(b.last().code, 'not_host');
    send(a2, { t: 'start' });
    assert.equal(a.out.length, 0, 'the replaced socket gets nothing more');
    assert.equal(a2.last('state').phase, 'reveal');
    send(a, { t: 'next' });
    assert.equal(a.last().code, 'not_in_room');
    // resuming onto the same socket again is harmless
    send(a2, { t: 'resume', room, token });
    assert.equal(a2.last('state').you.id, id);
  });

  test('disconnect keeps the seat (offline); a socket holds one identity (create/join detaches the old one)', () => {
    const { conn, send, rooms } = registry();
    const a = conn();
    send(a, { t: 'create', name: 'Ann' });
    const first = a.out[0];
    const b = conn();
    send(b, { t: 'join', room: first.room, name: 'Bob' });
    send(a, { t: 'create', name: 'Ann again' });
    assert.equal(rooms.rooms.size, 2);
    const bs = b.last('state');
    assert.equal(bs.players.find((p) => p.id === first.id).connected, false);
    rooms.close(b);
    const a3 = conn();
    send(a3, { t: 'resume', room: first.room, token: first.token });
    assert.deepEqual(a3.last('state').players.map((p) => p.connected), [true, false]);
  });

  test('leave and kick revoke the token; the kicked socket gets {t:"kicked"}; leavers get nothing more', () => {
    const { conn, send } = registry();
    const h = conn();
    send(h, { t: 'create', name: 'Host' });
    const { room } = h.out[0];
    const b = conn();
    send(b, { t: 'join', room, name: 'Bob' });
    const bj = b.out[0];
    const c = conn();
    send(c, { t: 'join', room, name: 'Cat' });
    const cj = c.out[0];
    c.clear();
    send(c, { t: 'leave' });
    assert.equal(c.out.length, 0);
    send(c, { t: 'resume', room, token: cj.token });
    assert.equal(c.last().code, 'bad_token');
    b.clear();
    send(h, { t: 'kick', playerId: bj.id });
    assert.equal(b.out.length, 1);
    assert.equal(b.out[0].t, 'kicked');
    assert.equal(typeof b.out[0].reason, 'string');
    send(b, { t: 'resume', room, token: bj.token });
    assert.equal(b.last().code, 'bad_token');
    assert.equal(h.last('state').players.length, 1);
    // the kicked socket can start over
    send(b, { t: 'join', room, name: 'Bob' });
    assert.equal(b.last('state').players.length, 2);
  });

  test('host grace: after BUNKER_HOST_GRACE_MS offline the host passes to a connected player (sweep)', () => {
    const { conn, send, rooms, clock } = registry({ hostGraceMs: 1000 });
    const h = conn();
    send(h, { t: 'create', name: 'Host' });
    const { room, id: hostId } = h.out[0];
    const b = conn();
    send(b, { t: 'join', room, name: 'Bob' });
    const bId = b.out[0].id;
    rooms.close(h);
    clock.t += 999;
    rooms.sweep();
    assert.equal(b.last('state').hostId, hostId);
    clock.t += 1;
    rooms.sweep();
    assert.equal(b.last('state').hostId, bId);
    const h2 = conn();
    send(h2, { t: 'resume', room, token: h.out[0].token });
    assert.equal(h2.last('state').hostId, bId);
  });

  test('rooms with no connected socket for 30 minutes are deleted; 200 rooms → server_busy; empty rooms freed at once', () => {
    const { conn, send, rooms, clock } = registry();
    const a = conn();
    send(a, { t: 'create', name: 'Ann' });
    const { room } = a.out[0];
    rooms.close(a);
    clock.t += 30 * 60 * 1000 - 1;
    rooms.sweep();
    assert.ok(rooms.rooms.has(room));
    clock.t += 1;
    rooms.sweep();
    assert.ok(!rooms.rooms.has(room));
    for (let i = 0; i < MAX_ROOMS; i++) send(conn(), { t: 'create', name: `R${i}` });
    assert.equal(rooms.rooms.size, MAX_ROOMS);
    const z = conn();
    send(z, { t: 'create', name: 'one more' });
    assert.equal(z.last().code, 'server_busy');
    send(z, { t: 'create', name: '' });
    assert.equal(z.last().code, 'bad_request'); // bad_request wins over server_busy
    const lone = [...rooms.rooms.values()][0];
    const [loneId] = lone.conns.keys();
    const loneConn = lone.conns.get(loneId);
    send(loneConn, { t: 'leave' });
    assert.ok(!rooms.rooms.has(lone.code));
  });

  test('a room is freed at once when its last member leaves mid-game or in the final (left players cannot return)', () => {
    for (const when of ['reveal', 'final']) {
      const { conn, send, rooms } = registry();
      const h = conn();
      send(h, { t: 'create', name: 'Host' });
      const { room } = h.out[0];
      const b = conn();
      send(b, { t: 'join', room, name: 'Bob' });
      const w = conn();
      send(w, { t: 'join', room, name: 'Watcher', spectator: true });
      send(h, { t: 'start' });
      if (when === 'final') {
        for (let i = 0; i < 200 && h.last('state').phase !== 'final'; i++) send(h, { t: 'next' });
        assert.equal(h.last('state').phase, 'final');
      }
      send(h, { t: 'leave' });
      assert.ok(rooms.rooms.has(room), 'Bob and the watcher are still there');
      send(b, { t: 'leave' });
      assert.ok(rooms.rooms.has(room), 'the spectator is still there');
      assert.equal(w.last('state').players.every((p) => p.status === 'left'), true);
      send(w, { t: 'leave' });
      assert.ok(!rooms.rooms.has(room), `room freed once nobody is left (${when})`);
      const x = conn();
      send(x, { t: 'join', room, name: 'Late' });
      assert.equal(x.last().code, 'no_room');
    }
    // a disconnected (not left) player still holds the room until the idle TTL
    const { conn, send, rooms } = registry();
    const h = conn();
    send(h, { t: 'create', name: 'Host' });
    const { room } = h.out[0];
    const b = conn();
    send(b, { t: 'join', room, name: 'Bob' });
    send(h, { t: 'start' });
    rooms.close(b);
    send(h, { t: 'leave' });
    assert.ok(rooms.rooms.has(room), 'offline Bob can still resume');
  });

  test('a seeded registry gives deterministic room codes but unpredictable tokens', () => {
    const r1 = registry();
    const r2 = registry();
    const a = r1.conn();
    const b = r2.conn();
    r1.send(a, { t: 'create', name: 'A' });
    r2.send(b, { t: 'create', name: 'A' });
    assert.equal(a.out[0].room, b.out[0].room);
    assert.notEqual(a.out[0].token, b.out[0].token);
  });
});
