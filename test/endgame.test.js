// SPEC §11 X6 (host "End game → back to the lobby"), server side; the exact rules are in §11 E1.
//   - engine: endGame in every phase but the lobby (mid-turn before and after the reveal, discussion with open airlocks
//     and every vote modifier, an open ballot with votes cast, defense, revote, overtime discussion and vote, the final),
//     validation and error precedence, what a refused endGame changes (nothing), who is kept, and a second game;
//   - protocol: over real WebSockets under the full Checker, a game ended mid-vote (a leaver, a dropped player and a late
//     spectator), the late joiner takes a seat and a second game is played to the final with them; the tokens of the
//     leaver stay revoked, the dropped player resumes into the lobby.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, EFFECTS, validateMessage, MESSAGE_TYPES } from '../server/game.js';
import { Rooms } from '../server/rooms.js';
import { mulberry32 } from '../server/rng.js';
import { validateStateView } from './stateview-schema.js';
import { Bot, assertServerHealthy, expectError, playerById, runTable, startServer } from './helpers-sim.js';

const ENDED = 'The host ended the game';
const LOBBY = 'Back to the lobby — same table, new cards next game';

// ------------------------------------------------------------------------------------------------ engine helpers
const FILLER = { id: 'filler', title: 'Blueprint', text: 'Adds a bunker feature.', effect: 'bunker_add_feature', target: 'none' };
const sp = (effect, extra = {}) => ({ id: effect, title: `T:${effect}`, text: `Card text for ${effect}`, effect, target: EFFECTS[effect].targets[0], ...extra });
function handDealer(specials = {}) {
  let cardN = 0;
  let specialN = 0;
  return {
    drawCard(c) { cardN++; return `<${c}#${cardN}>`; },
    drawSpecial() { const i = specialN++; return { ...(specials[Math.floor(i / 2) % 100]?.[i % 2] ?? FILLER) }; },
    drawCatastrophe() { return { title: 'Flood', text: 'Water.', details: ['1%'] }; },
    drawBunker() { return { name: 'B', size: '50 m2', duration: '1 year', food: '1 year', features: ['Well', 'Gym', 'Farm'] }; },
    drawBunkerFeature() { cardN++; return `<feature#${cardN}>`; },
  };
}
/** n seated players (P0 hosts), `spectators` spectators, started unless `start: false`. Hand-made deal, no fixed cards. */
function table(n, { specials = {}, spectators = 0, start = true, seed = 11 } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const g = createGame({ room: 'TEST', rng: mulberry32(seed), now: () => clock.t, minPlayers: 2, dealer: handDealer(specials), fixedSpecials: false });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`).id);
  const specs = [];
  for (let i = 0; i < spectators; i++) specs.push(g.join(`S${i}`, { spectator: true }).id);
  if (start) ok(g.handle(ids[0], { t: 'start' }));
  return { g, ids, specs, clock };
}
function ok(res) { assert.deepEqual(res, { ok: true }, JSON.stringify(res)); }
function err(res, code, re) {
  assert.equal(res.ok, false, `expected ${code}, got ok`);
  assert.equal(res.code, code, `expected ${code}, got ${res.code}: ${res.message}`);
  assert.ok(typeof res.message === 'string' && res.message.length > 0);
  if (re) assert.match(res.message, re);
}
const P = (g, id) => g.players.find((p) => p.id === id);
const card = (g, id, effect) => P(g, id).specials.find((s) => s.effect === effect && !s.used);
const play = (g, id, effect, extra = {}) => g.handle(id, { t: 'special', uid: card(g, id, effect).uid, ...extra });
const next = (g) => ok(g.handle(g.hostId, { t: 'next' }));
function advanceTo(g, round, phase) {
  for (let guard = 0; !(g.round === round && g.phase === phase); guard++) {
    assert.ok(guard < 3000, `stuck at ${g.round}/${g.phase}`);
    assert.notEqual(g.phase, 'final', `the game ended before round ${round} ${phase}`);
    next(g);
  }
}
const recipients = (g) => [...g.players.filter((p) => p.status !== 'left').map((p) => p.id), ...g.spectators.map((s) => s.id)];
const snapshot = (g) => JSON.stringify(recipients(g).map((id) => g.view(id)));

/**
 * Ends the game from `g.hostId` and checks the lobby it lands in against the state just before: the two log lines,
 * `left` players gone and everyone else in the same order (renumbered, alive, blank, same names and connections),
 * the same spectators, host and options, the log kept, every per-game field reset (the view, and the engine's own
 * turn/vote/step/timer/airlocks/modifiers, which a later game would otherwise inherit), and the strict §7 schema for
 * every recipient.
 */
function endAndCheck(g, { lines = [ENDED, LOBBY] } = {}) {
  const host = g.hostId;
  const before = g.view(host);
  const keptIds = before.players.filter((p) => p.status !== 'left').map((p) => p.id);
  const leftIds = before.players.filter((p) => p.status === 'left').map((p) => p.id);
  const lastLogId = g.log[g.log.length - 1].id;
  ok(g.handle(host, { t: 'endGame' }));
  const v = g.view(host);
  assert.equal(v.phase, 'lobby');
  assert.equal(v.round, 0);
  assert.equal(v.overtime, false);
  assert.equal(v.capacity, 0);
  assert.equal(v.catastrophe, null);
  assert.equal(v.bunker, null);
  assert.equal(v.turn, null);
  assert.equal(v.vote, null);
  assert.equal(v.timer, null);
  assert.equal(v.final, null);
  assert.equal(v.lastVoteResult, null);
  assert.equal(v.me, null);
  assert.deepEqual(v.airlocks, []);
  assert.deepEqual(v.voteMods, { immune: [], blocked: [], doubleVote: [], cancelNext: false });
  assert.deepEqual(v.schedule, { kicksByRound: keptIds.length >= 2 ? v.schedule.kicksByRound : [], outCount: 0, kicksThisStep: 0, nextVoteRound: null });
  assert.deepEqual(v.players.map((p) => p.id), keptIds, 'left players go, everyone else keeps their place');
  assert.deepEqual(v.players.map((p) => p.seat), keptIds.map((_, i) => i), 'seats renumbered');
  for (const p of v.players) {
    const was = before.players.find((q) => q.id === p.id);
    assert.equal(p.name, was.name);
    assert.equal(p.connected, was.connected);
    assert.equal(p.status, 'alive');
    assert.deepEqual(Object.values(p.cards), Array(8).fill(null));
    assert.equal(p.revealedCount, 0);
    assert.deepEqual(p.playedSpecials, []);
    assert.equal(p.specialsLeft, 0);
    assert.equal(p.unplayedSpecials, undefined);
  }
  assert.deepEqual(v.spectators, before.spectators, 'spectators stay spectators');
  assert.equal(v.hostId, host, 'the host keeps the role');
  assert.deepEqual(v.options, before.options, 'options kept');
  const fresh = v.log.filter((e) => e.id > lastLogId);
  assert.deepEqual(fresh.map((e) => [e.kind, e.text]), lines.map((t) => ['system', t]));
  assert.ok(v.log.some((e) => e.id === lastLogId), 'the log is kept');
  for (const id of leftIds) assert.equal(g.view(id), null, 'a left player is gone for good');
  for (const id of recipients(g)) assert.deepEqual(validateStateView(g.view(id)), [], `§7 schema for ${id}`);
  // the engine's own per-game state: a later Start must not inherit any of it
  assert.equal(g.turn, null);
  assert.equal(g.vote, null);
  assert.equal(g.step, null);
  assert.equal(g.timer, null);
  assert.equal(g.final, null);
  assert.equal(g.N, 0);
  assert.deepEqual(g.kicks, []);
  assert.deepEqual(g.airlocks, []);
  assert.equal(g.voteMods.immune.size + g.voteMods.blocked.size + g.voteMods.doubleVote.size, 0);
  for (const p of g.players) {
    assert.equal(p.cards, null);
    assert.deepEqual(p.specials, []);
    assert.deepEqual(p.notes, []);
    assert.equal(p.lastSpecialRound, 0);
  }
  return { v, fresh };
}

/** A fresh Start after the end: a clean round 1 for everyone seated, 2 unused specials each, no notes. */
function startAgain(g) {
  const logBefore = g.log[g.log.length - 1].id;
  ok(g.handle(g.hostId, { t: 'start' }));
  const n = g.players.length;
  for (const p of g.players) {
    const v = g.view(p.id);
    assert.deepEqual(validateStateView(v), []);
    assert.equal(v.phase, 'reveal');
    assert.equal(v.round, 1);
    assert.equal(v.capacity, Math.floor(n / 2));
    assert.equal(v.me.specials.length, 2);
    assert.ok(v.me.specials.every((s) => !s.used));
    assert.deepEqual(v.me.notes, []);
    assert.equal(v.me.canPlaySpecial, true);
    assert.deepEqual(v.airlocks, []);
    assert.equal(v.lastVoteResult, null);
    assert.ok(v.players.every((q) => q.status === 'alive' && q.revealedCount === 0));
  }
  assert.ok(g.log[0].id <= logBefore && g.log.some((e) => e.text.startsWith(`The game begins: ${n} players`)));
}

// ------------------------------------------------------------------------------------------------ engine
describe('§11 X6 endGame: validation and who may send it', () => {
  test('the §7 schema knows it; extra keys are ignored like everywhere else; bad frames stay bad_request', () => {
    assert.ok(MESSAGE_TYPES.includes('endGame'));
    assert.equal(validateMessage({ t: 'endGame' }), null);
    assert.equal(validateMessage({ t: 'endGame', at: { phase: 'vote' }, why: 'x' }), null);
    assert.equal(validateMessage({ t: 'endgame' })?.code, 'bad_request', 'type names are case-sensitive');
    const { g, ids } = table(4);
    err(g.handle(ids[0], { t: 'EndGame' }), 'bad_request');
    err(g.handle(ids[0], null), 'bad_request');
    err(g.handle('p999', { t: 5 }), 'bad_request', /Unknown message type/); // bad_request wins over not_in_room
  });

  test('error precedence: not_in_room, then not_host (players, spectators, ejected), then wrong_phase in the lobby', () => {
    const { g, ids, specs } = table(5, { spectators: 1, start: false });
    err(g.handle(ids[1], { t: 'endGame' }), 'not_host', /Only the host/); // not_host wins over wrong_phase
    err(g.handle(specs[0], { t: 'endGame' }), 'not_host');
    err(g.handle(ids[0], { t: 'endGame' }), 'wrong_phase', /no game to end/);
    err(g.handle('p999', { t: 'endGame' }), 'not_in_room');
    ok(g.handle(ids[0], { t: 'start' }));
    ok(g.handle(ids[4], { t: 'leave' }));
    err(g.handle(ids[4], { t: 'endGame' }), 'not_in_room', /not in a room/);
    err(g.handle(ids[1], { t: 'endGame' }), 'not_host');
    err(g.handle(specs[0], { t: 'endGame' }), 'not_host');
    assert.equal(g.phase, 'reveal');
  });

  test('a refused endGame changes nothing at all (every recipient\'s view, the log)', () => {
    const { g, ids, specs } = table(5, { spectators: 1 });
    advanceTo(g, 2, 'discussion');
    const before = snapshot(g);
    for (const [who, code] of [[ids[2], 'not_host'], [specs[0], 'not_host'], ['nobody', 'not_in_room']]) err(g.handle(who, { t: 'endGame' }), code);
    assert.equal(snapshot(g), before);
    // and in the lobby afterwards
    endAndCheck(g);
    const lobby = snapshot(g);
    err(g.handle(ids[0], { t: 'endGame' }), 'wrong_phase');
    assert.equal(snapshot(g), lobby);
  });

  test('an ejected host still has the power; a transferred host role moves it; an offline host keeps it until passed', () => {
    const { g, ids } = table(4);
    advanceTo(g, 6, 'vote');
    for (const v of [ids[1], ids[2], ids[3]]) ok(g.handle(v, { t: 'vote', targetId: ids[0] }));
    ok(g.handle(ids[0], { t: 'vote', targetId: ids[1] }));
    assert.equal(P(g, ids[0]).status, 'ejected');
    assert.notEqual(g.phase, 'final');
    ok(g.handle(ids[0], { t: 'transferHost', playerId: ids[2] }));
    err(g.handle(ids[0], { t: 'endGame' }), 'not_host');
    ok(g.handle(ids[2], { t: 'transferHost', playerId: ids[0] }));
    g.setConnected(ids[0], false);
    endAndCheck(g); // the ejected, offline host: back in the lobby alive, offline, still host
    assert.equal(g.view(ids[1]).players[0].connected, false);
  });
});

describe('§11 X6 endGame in every phase of a running game', () => {
  test('reveal, mid-turn before the speaker revealed: no auto-reveal, nothing hidden becomes public', () => {
    const { g, ids } = table(5, { spectators: 1 });
    next(g); // P0's turn auto-revealed; P1 speaks now and has not revealed
    assert.equal(g.turn.order[g.turn.index], ids[1]);
    const secret = P(g, ids[1]).cards.profession.text;
    const { v } = endAndCheck(g);
    assert.ok(!JSON.stringify(v).includes(secret), 'the speaker\'s card never went public');
    assert.ok(!g.log.some((e) => e.text.includes('revealed automatically') && e.text.includes('P1')));
    startAgain(g);
  });

  test('reveal, mid-turn after the speaker revealed (round 2, descending order)', () => {
    const { g, ids } = table(6);
    advanceTo(g, 2, 'reveal');
    const speaker = g.turn.order[g.turn.index];
    assert.equal(speaker, ids[5], 'even rounds go down the seats');
    ok(g.handle(speaker, { t: 'reveal', category: 'health' }));
    endAndCheck(g);
    startAgain(g);
  });

  test('discussion with two open airlocks and every vote modifier set (immunity, block, ×2, cancelNext) and a peek note: all gone, no jam lines', () => {
    const specials = {
      1: [sp('airlock'), FILLER], 2: [sp('airlock'), FILLER], 3: [sp('immunity'), FILLER], 4: [sp('block_vote'), FILLER],
      5: [sp('double_vote'), FILLER], 6: [sp('cancel_vote'), FILLER], 7: [sp('peek', { category: 'choose' }), FILLER],
    };
    const { g, ids } = table(8, { specials, spectators: 2 });
    advanceTo(g, 2, 'reveal');
    ok(play(g, ids[1], 'airlock', { targetId: ids[3] }));
    ok(play(g, ids[2], 'airlock', { targetId: ids[4] }));
    ok(play(g, ids[3], 'immunity'));
    ok(play(g, ids[4], 'block_vote', { targetId: ids[0] }));
    ok(play(g, ids[5], 'double_vote'));
    ok(play(g, ids[6], 'cancel_vote'));
    ok(play(g, ids[7], 'peek', { targetId: ids[0], category: 'health' }));
    advanceTo(g, 2, 'discussion');
    const v0 = g.view(ids[0]);
    assert.equal(v0.airlocks.length, 2);
    assert.deepEqual(v0.voteMods, { immune: [ids[3]], blocked: [ids[0]], doubleVote: [ids[5]], cancelNext: true });
    assert.equal(g.view(ids[7]).me.notes.length, 1);
    const { fresh } = endAndCheck(g);
    assert.ok(!fresh.some((e) => /jammed/.test(e.text)), 'an aborted game logs no jammed airlocks');
    startAgain(g);
    assert.deepEqual(g.view(ids[7]).me.notes, [], 'the peek note belonged to the old game');
    assert.equal(g.voteMods.cancelNext, false);
  });

  test('an open ballot with votes cast (and an earlier ballot\'s result): votes, myVote and lastVoteResult are gone', () => {
    const { g, ids } = table(13, { spectators: 1 }); // KICKS[13] votes from round 2; round 7 has 2 ballots
    advanceTo(g, 2, 'vote');
    ok(g.handle(ids[1], { t: 'vote', targetId: ids[2] }));
    ok(g.handle(ids[0], { t: 'vote', targetId: ids[2] }));
    assert.equal(g.view(ids[1]).me.myVote, ids[2]);
    ok(g.handle(ids[0], { t: 'closeVote' }));
    advanceTo(g, 3, 'vote');
    assert.notEqual(g.lastVoteResult, null);
    ok(g.handle(ids[4], { t: 'vote', targetId: ids[5] }));
    const { v } = endAndCheck(g);
    assert.equal(v.players.length, 13, 'the ejected player of round 2 is back at the table');
    startAgain(g);
  });

  test('the second ballot of a two-ballot step (round 7, N=13)', () => {
    const { g, ids } = table(13);
    advanceTo(g, 7, 'vote');
    ok(g.handle(ids[0], { t: 'closeVote' })); // zero votes: fate ejects one, ballot 2 opens
    assert.equal(g.phase, 'vote');
    assert.equal(g.step.ballot, 2);
    endAndCheck(g);
    startAgain(g);
  });

  test('defense: mid-speech of a tied player', () => {
    const { g, ids } = table(4);
    advanceTo(g, 6, 'vote');
    ok(g.handle(ids[0], { t: 'vote', targetId: ids[1] }));
    ok(g.handle(ids[1], { t: 'vote', targetId: ids[0] }));
    ok(g.handle(ids[2], { t: 'vote', targetId: ids[3] }));
    ok(g.handle(ids[3], { t: 'vote', targetId: ids[2] }));
    assert.equal(g.phase, 'defense');
    ok(g.handle(g.turn.order[0], { t: 'endTurn' }));
    endAndCheck(g);
    startAgain(g);
  });

  test('the revote after a defense', () => {
    const { g, ids } = table(4);
    advanceTo(g, 6, 'vote');
    ok(g.handle(ids[0], { t: 'vote', targetId: ids[1] }));
    ok(g.handle(ids[1], { t: 'vote', targetId: ids[0] }));
    ok(g.handle(ids[2], { t: 'vote', targetId: ids[0] }));
    ok(g.handle(ids[3], { t: 'vote', targetId: ids[1] }));
    while (g.phase === 'defense') next(g);
    assert.equal(g.vote.stage, 'revote');
    ok(g.handle(ids[2], { t: 'vote', targetId: ids[1] }));
    endAndCheck(g);
    startAgain(g);
  });

  test('overtime: in the overtime discussion and in the overtime vote', () => {
    const cancel = [sp('cancel_vote'), FILLER];
    for (const where of ['discussion', 'vote']) {
      const { g } = table(4, { specials: { 0: cancel, 1: cancel, 2: cancel, 3: cancel } });
      advanceTo(g, 7, 'vote');
      ok(play(g, g.players.find((p) => p.status === 'alive').id, 'cancel_vote')); // round 7's step is cancelled: overtime
      assert.equal(g.overtime, true);
      assert.equal(g.phase, 'discussion');
      if (where === 'vote') next(g);
      assert.equal(g.phase, where);
      endAndCheck(g);
      startAgain(g);
      assert.equal(g.overtime, false);
    }
  });

  test('with players who left and were ejected: the leavers go (their seat numbers close up), the ejected come back', () => {
    const { g, ids, specs } = table(8, { spectators: 1 });
    ok(g.handle(ids[2], { t: 'leave' }));
    ok(g.handle(ids[0], { t: 'kick', playerId: ids[4] }));
    advanceTo(g, 6, 'vote'); // KICKS[8] with 2 out: the first vote is round 6's
    ok(g.handle(ids[0], { t: 'closeVote' }));
    assert.ok(g.players.some((p) => p.status === 'ejected'));
    advanceTo(g, 7, 'reveal');
    const { v } = endAndCheck(g);
    assert.deepEqual(v.players.map((p) => [p.id, p.seat]), [ids[0], ids[1], ids[3], ids[5], ids[6], ids[7]].map((id, i) => [id, i]));
    assert.deepEqual(v.spectators.map((x) => x.id), specs);
    startAgain(g);
    assert.equal(g.capacity, 3);
  });

  test('after leaves the lobby schedule is the row for the players kept', () => {
    const { g, ids } = table(6);
    ok(g.handle(ids[1], { t: 'leave' }));
    ok(g.handle(ids[2], { t: 'leave' }));
    assert.notEqual(g.phase, 'final');
    const { v } = endAndCheck(g);
    assert.equal(v.players.length, 4);
    assert.deepEqual(v.schedule.kicksByRound, [0, 0, 0, 0, 0, 1, 1]);
  });
});

describe('§11 X6 endGame in the final and after it', () => {
  function toFinal(seed) {
    const t = table(5, { spectators: 1, seed });
    ok(t.g.handle(t.ids[3], { t: 'leave' }));
    while (t.g.phase !== 'final') next(t.g);
    return t;
  }

  test('in the final it is exactly Play again: the same state for every recipient, one "Back to the lobby" line, no "ended" line', () => {
    const a = toFinal(3);
    const b = toFinal(3);
    assert.equal(snapshot(a.g), snapshot(b.g), 'twin games');
    err(a.g.handle(a.ids[1], { t: 'endGame' }), 'not_host');
    endAndCheck(a.g, { lines: [LOBBY] });
    ok(b.g.handle(b.ids[0], { t: 'playAgain' }));
    assert.equal(snapshot(a.g), snapshot(b.g), 'endGame in the final == playAgain');
    assert.ok(!a.g.log.some((e) => e.text === ENDED));
  });

  test('playAgain is still refused outside the final (endGame is the only way out of a running game)', () => {
    const { g, ids } = table(4);
    err(g.handle(ids[0], { t: 'playAgain' }), 'wrong_phase', /only available after the game/);
    ok(g.handle(ids[0], { t: 'endGame' }));
    err(g.handle(ids[0], { t: 'playAgain' }), 'wrong_phase');
  });

  test('a late joiner: a spectator during the game, takes a seat after End game, plays the second game; log ids only grow', () => {
    const { g, ids } = table(5);
    advanceTo(g, 3, 'reveal');
    const late = g.join('Late');
    assert.deepEqual([late.ok, late.role], [true, 'spectator'], 'joining a running game makes a spectator');
    err(g.handle(late.id, { t: 'takeSeat' }), 'wrong_phase');
    endAndCheck(g);
    ok(g.handle(late.id, { t: 'takeSeat' }));
    const v = g.view(late.id);
    assert.deepEqual(v.players.map((p) => p.id), [...ids, late.id]);
    assert.equal(v.you.role, 'player');
    startAgain(g);
    assert.equal(g.N, 6);
    assert.equal(g.capacity, 3);
    const logIds = g.log.map((e) => e.id);
    assert.ok(logIds.every((id, i) => i === 0 || id > logIds[i - 1]));
    // and the second game can be ended too, and so on
    advanceTo(g, 2, 'discussion');
    endAndCheck(g);
    startAgain(g);
  });

  test('many random games ended at random moments: every view of every recipient passes the §7 schema, a new game always starts clean', () => {
    let ended = 0;
    const where = {};
    for (let seed = 1; seed <= 60; seed++) {
      const rng = mulberry32(seed * 31);
      const clock = { t: 1_800_000_000_000 };
      const g = createGame({ room: 'FUZZ', rng: mulberry32(seed), now: () => (clock.t += 100), minPlayers: 2 }); // real content, X1 deal
      const n = 4 + (seed % 13);
      const ids = [];
      for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`).id);
      g.join('W', { spectator: true });
      ok(g.handle(ids[0], { t: 'start' }));
      const stopAt = 1 + Math.floor(rng() * 5 * n); // shorter than any game of n players
      for (let step = 0; step < stopAt && g.phase !== 'final'; step++) {
        if (g.phase === 'vote') {
          const voter = g.vote.voters.find((x) => !g.vote.votes.has(x));
          const target = voter && g.vote.candidates.find((c) => c !== voter);
          if (voter && target && rng() < 0.7) { ok(g.handle(voter, { t: 'vote', targetId: target })); continue; }
        }
        next(g);
      }
      if (g.phase === 'final') continue;
      where[g.phase] = (where[g.phase] || 0) + 1;
      endAndCheck(g);
      ended++;
      startAgain(g);
      while (g.phase !== 'final') next(g);
      for (const id of recipients(g)) assert.deepEqual(validateStateView(g.view(id)), []);
    }
    assert.ok(ended >= 45, `only ${ended} games ended`);
    assert.ok(where.reveal && where.discussion, `ended in ${JSON.stringify(where)}`);
  });
});

describe('§11 X6 endGame in the room registry', () => {
  test('tokens: the left player\'s stays revoked, everyone kept can still resume; stats().activeGames follows', () => {
    const rooms = new Rooms({ rng: mulberry32(5), minPlayers: 2, now: () => 1e12, maxRoomsPerIp: Infinity, joinFailBurst: Infinity });
    const conn = (ip = '198.51.100.1') => { const c = { ip, sent: [], send(o) { this.sent.push(o); } }; rooms.open(c); return c; };
    const say = (c, m) => rooms.message(c, JSON.stringify(m));
    const last = (c, t) => [...c.sent].reverse().find((m) => m.t === t);
    const a = conn(); say(a, { t: 'create', name: 'A' });
    const code = last(a, 'joined').room;
    const b = conn(); say(b, { t: 'join', room: code, name: 'B' });
    const c = conn(); say(c, { t: 'join', room: code, name: 'C' });
    const cTok = last(c, 'joined').token;
    const bTok = last(b, 'joined').token;
    assert.deepEqual(rooms.stats(), { rooms: 1, activeGames: 0, sockets: 3 });
    say(a, { t: 'start' });
    assert.deepEqual(rooms.stats(), { rooms: 1, activeGames: 1, sockets: 3 });
    say(c, { t: 'leave' });
    rooms.close(b); // B drops: offline, seat kept
    const w = conn(); say(w, { t: 'join', room: code, name: 'Late' });
    assert.equal(last(w, 'state').you.role, 'spectator');
    say(a, { t: 'endGame' });
    const s = last(a, 'state');
    assert.equal(s.phase, 'lobby');
    assert.deepEqual(s.players.map((p) => [p.name, p.connected]), [['A', true], ['B', false]]);
    assert.equal(last(w, 'state').phase, 'lobby', 'the spectator got the lobby too');
    assert.deepEqual(rooms.stats(), { rooms: 1, activeGames: 0, sockets: 2 });
    const c2 = conn(); say(c2, { t: 'resume', room: code, token: cTok });
    assert.equal(last(c2, 'error').code, 'bad_token', 'a player who left never comes back');
    const b2 = conn(); say(b2, { t: 'resume', room: code, token: bTok });
    assert.equal(last(b2, 'state').phase, 'lobby', 'the dropped player resumes into the lobby');
    say(w, { t: 'takeSeat' });
    say(a, { t: 'start' });
    assert.equal(last(w, 'state').players.length, 3);
    assert.deepEqual(rooms.stats(), { rooms: 1, activeGames: 1, sockets: 3 });
    say(b2, { t: 'endGame' });
    assert.deepEqual(last(b2, 'error'), { t: 'error', code: 'not_host', message: 'Only the host can do that' });
  });
});

// ------------------------------------------------------------------------------------------------ protocol
describe('§11 X6 over real WebSockets', () => {
  test('ended mid-vote (after a leave, with a dropped player and a late spectator), then a second game with the late joiner seated', { timeout: 90000 }, async (t) => {
    const server = await startServer({ seed: 'x6-endgame' });
    try {
      const seen = { endedAt: null, lobby: null, resumed: null, lateRole: null, leaverResume: null };
      const r = await runTable(server, {
        n: 6, seed: 'x6', label: 'x6-end-game', games: 2,
        scenario: (ctx) => {
          const { host, watcher } = ctx;
          const leaver = ctx.bots[4];
          const dropper = ctx.bots[3];
          let late = null;
          let stage = 0;
          ctx.onRef((s) => {
            if (stage === 0 && s.phase === 'reveal' && s.round === 1) { stage = 1; leaver.leave(); }
            if (stage === 1 && s.phase === 'reveal' && s.round === 2) {
              stage = 2;
              ctx.task((async () => {
                late = ctx.addBot(ctx.mkBot('Late Lena'));
                const res = await late.join(ctx.room);
                seen.lateRole = res.state.you.role;
              })());
            }
            if (stage === 2 && s.phase === 'reveal' && s.round === 3) { stage = 3; dropper.drop(); }
            // the first open ballot, while the other bots are still voting: End game crosses their votes
            if (stage === 3 && s.phase === 'vote' && s.vote.voted.length < s.vote.voters.length) {
              stage = 4;
              seen.endedAt = { phase: s.phase, round: s.round, voted: s.vote.voted.length, voters: s.vote.voters.length };
              host.act({ t: 'endGame' });
            }
          });
          ctx.afterEndGame = async (s) => {
            assert.equal(s.phase, 'lobby');
            assert.equal(s.log[s.log.length - 2].text, ENDED);
            assert.equal(s.log[s.log.length - 1].text, LOBBY);
            assert.ok(!s.players.some((p) => p.id === leaver.id), 'the leaver is gone');
            assert.ok(s.spectators.some((x) => x.id === late.id), 'the late joiner is still a spectator');
            assert.equal(s.hostId, host.id);
            const offline = playerById(s, dropper.id);
            assert.ok(offline && !offline.connected, 'the dropped player keeps the seat, offline');
            seen.lobby = s.players.map((p) => p.id);
            const back = await dropper.resume();
            seen.resumed = back.state.phase;
            // the leaver's token was revoked when it left: it cannot come back
            const ghost = ctx.addClient(new Bot({ url: server.url, name: 'Ghost', autoplay: false }));
            seen.leaverResume = await ghost.resume(ctx.room, leaver.token).then(() => 'joined', (e) => e.code);
            await expectError(late, { t: 'endGame' }, ['not_host']);
            await expectError(host, { t: 'endGame' }, ['wrong_phase']);
            late.act({ t: 'takeSeat' });
            await watcher.waitFor((st) => st.players.length === 6 && st.players.every((p) => p.connected), 5000, 'the late joiner seated');
          };
        },
      });
      t.diagnostic(JSON.stringify({ seen, games: r.games, raceErrors: r.raceErrors, warnings: r.warnings.slice(0, 5) }));
      assert.equal(r.violations.length, 0, r.violations.slice(0, 20).join('\n'));
      assert.equal(seen.lateRole, 'spectator');
      assert.equal(seen.resumed, 'lobby');
      assert.equal(seen.leaverResume, 'bad_token');
      assert.equal(seen.endedAt.phase, 'vote');
      assert.equal(r.games.length, 2);
      assert.equal(r.games[0].endedByHost, true);
      assert.equal(r.games[0].done, false);
      assert.equal(r.games[0].endedIn.phase, 'vote');
      assert.equal(r.games[1].done, true, 'the second game reaches the final');
      assert.equal(r.games[1].endedByHost, false);
      assert.equal(r.games[1].n, 6, 'five kept players plus the late joiner');
      assert.ok(r.games[1].dealChecked);
      await assertServerHealthy(server);
    } finally {
      await server.stop();
    }
  });

  test('bot hosts that End game at random moments (soak policy): many short tables stay clean under the Checker', { timeout: 120000 }, async (t) => {
    const server = await startServer({ seed: 'x6-random' });
    try {
      const out = [];
      for (const [i, n] of [5, 7, 9, 12].entries()) {
        const r = await runTable(server, { n, seed: `x6r-${i}`, label: `x6-random-${i}`, games: 3, specials: 0.5, endGame: 0.6 });
        out.push({ n, games: r.games.map((g) => (g.endedByHost ? `ended@${g.endedIn.phase}` : g.done ? 'final' : 'stuck')) });
        assert.equal(r.violations.length, 0, r.violations.slice(0, 20).join('\n'));
        assert.equal(r.games.length, 3);
        assert.ok(r.games.every((g) => g.done !== g.endedByHost), 'each game either reached the final or was ended');
      }
      t.diagnostic(JSON.stringify(out));
      assert.ok(out.flatMap((x) => x.games).some((x) => x.startsWith('ended@')), 'no game was ended');
      await assertServerHealthy(server);
    } finally {
      await server.stop();
    }
  });
});
