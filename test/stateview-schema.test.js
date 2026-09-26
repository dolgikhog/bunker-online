// The strict §7 validator (test/stateview-schema.js) against the engine directly: every recipient's view after every
// action of many random games (real content, random legal play incl. specials, leaves, kicks, disconnects, Play
// again, End game at random moments, §11 X6) must match the SPEC field by field; and the validator itself must reject
// drifted views (it is not vacuous), also a lobby that kept anything of an ended game.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../server/game.js';
import { mulberry32 } from '../server/rng.js';
import { allowedCategories, eligibleReveal, playableSpecials } from '../tools/botlib.js';
import { validateStateView } from './stateview-schema.js';

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

function recipients(g) {
  return [...g.players.filter((p) => p.status !== 'left').map((p) => p.id), ...g.spectators.map((s) => s.id)];
}

function checkAll(g, where) {
  for (const id of recipients(g)) {
    const v = g.view(id);
    assert.ok(v, `view for ${id}`);
    const problems = validateStateView(v);
    assert.deepEqual(problems, [], `${where}: view for ${id} (${v.you.role}, ${v.phase} r${v.round}) drifts from SPEC §7`);
  }
}

/** One random legal-ish action; returns a label. Illegal ones are fine too: they must change nothing. */
function randomAction(g, rng, stats) {
  const hostView = g.hostId ? g.view(g.hostId) : null;
  const seatedIds = g.players.filter((p) => p.status !== 'left').map((p) => p.id);
  const phase = g.phase;
  const r = rng();
  if (phase === 'lobby') {
    if (r < 0.05 && g.spectators.length) { g.handle(g.spectators[0].id, { t: 'takeSeat' }); return 'takeSeat'; }
    if (r < 0.1) { g.join(`J${Math.floor(rng() * 1000)}`); return 'join'; }
    if (g.hostId) g.handle(g.hostId, { t: 'start' });
    return 'start';
  }
  if (phase === 'final') {
    // §11 X6: End game in the final is Play again
    const t = rng() < 0.3 ? 'endGame' : 'playAgain';
    if (g.hostId) g.handle(g.hostId, { t });
    stats[t === 'endGame' ? 'endGameInFinal' : 'playAgain']++;
    return t;
  }
  // §11 X6: the host ends the running game now and then, whatever is going on
  if (rng() < 0.0015 && g.hostId) {
    const res = g.handle(g.hostId, { t: 'endGame' });
    assert.deepEqual(res, { ok: true }, `endGame in ${phase} was refused: ${res.code}`);
    stats.endGame++;
    stats.endedIn[phase] = (stats.endedIn[phase] || 0) + 1;
    return `endGame in ${phase}`;
  }
  // chaos
  if (r < 0.004 && seatedIds.length > 2) {
    const victim = pick(rng, seatedIds.filter((id) => id !== g.hostId));
    if (victim) { g.handle(victim, { t: 'leave' }); stats.leaves++; return 'leave'; }
  }
  if (r < 0.008 && g.hostId) {
    const victim = pick(rng, seatedIds.filter((id) => id !== g.hostId));
    if (victim) { g.handle(g.hostId, { t: 'kick', playerId: victim }); stats.kicks++; return 'kick'; }
  }
  if (r < 0.015) { const id = pick(rng, seatedIds); g.setConnected(id, rng() < 0.5); return 'connection'; }
  if (r < 0.02 && seatedIds.length > 1) { g.handle(g.hostId, { t: 'transferHost', playerId: pick(rng, seatedIds) }); return 'transfer'; }
  if (r < 0.03) { g.join(`Late${Math.floor(rng() * 1000)}`); return 'spectate'; }
  // specials
  if (r < 0.2) {
    const pid = pick(rng, seatedIds);
    const v = g.view(pid);
    const options = playableSpecials(v);
    if (options.length) {
      const o = pick(rng, options);
      const targetId = pick(rng, o.targets);
      const category = pick(rng, allowedCategories(v, o.special, targetId));
      const msg = { t: 'special', uid: o.special.uid };
      if (targetId) msg.targetId = targetId;
      if (category) msg.category = category;
      const res = g.handle(pid, msg);
      assert.deepEqual(res, { ok: true }, `a special playable by the §5 rule was refused: ${JSON.stringify(msg)} ${res.code}`);
      stats.effects[o.special.effect] = (stats.effects[o.special.effect] || 0) + 1;
      return `special ${o.special.effect}`;
    }
  }
  if (phase === 'reveal' || phase === 'defense') {
    const sp = g.view(g.turn.order[g.turn.index]);
    if (rng() < 0.15 && g.hostId) { g.handle(g.hostId, { t: 'next' }); return 'next'; }
    const elig = eligibleReveal(sp);
    if (phase === 'reveal' && !sp.turn.hasRevealed && elig.length) g.handle(sp.you.id, { t: 'reveal', category: pick(rng, elig) });
    else g.handle(sp.you.id, { t: 'endTurn' });
    return 'turn';
  }
  if (phase === 'vote') {
    const missing = hostView.vote.voters.filter((id) => !hostView.vote.voted.includes(id));
    if (rng() < 0.1 || !missing.length) { g.handle(g.hostId, { t: 'closeVote' }); stats.closes++; return 'closeVote'; }
    const voter = pick(rng, missing);
    if (rng() < 0.1) return 'abstain';
    const cands = hostView.vote.candidates.filter((c) => c !== voter);
    if (cands.length) g.handle(voter, { t: 'vote', targetId: pick(rng, cands) });
    return 'vote';
  }
  g.handle(g.hostId, { t: 'next' });
  return 'next';
}

describe('StateView schema (SPEC §7) over the engine', () => {
  test('every view of every recipient after every action of 40 random tables (100+ games) matches the SPEC', () => {
    const stats = { games: 0, finals: 0, views: 0, actions: 0, leaves: 0, kicks: 0, closes: 0, playAgain: 0, endGame: 0, endGameInFinal: 0, endedIn: {}, effects: {} };
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed * 7919);
      let t = 1_800_000_000_000;
      const g = createGame({ room: 'SWAN', rng: mulberry32(seed), now: () => (t += 250), minPlayers: 2 });
      const n = 2 + (seed % 15);
      for (let i = 0; i < n; i++) g.join(`P${i}`);
      g.join('Watcher', { spectator: true });
      let finals = 0;
      for (let step = 0; step < 20000 && finals < 3; step++) {
        const before = g.phase;
        const label = randomAction(g, rng, stats);
        stats.actions++;
        checkAll(g, `seed ${seed} step ${step} after ${label}`);
        stats.views += recipients(g).length;
        if (before !== 'final' && g.phase === 'final') { finals++; stats.finals++; }
        if (!g.hostId || g.players.filter((p) => p.status !== 'left').length < 2) break;
      }
      stats.games++;
    }
    assert.ok(stats.finals >= 100, `only ${stats.finals} finals`);
    assert.ok(stats.endGame >= 20 && stats.endGameInFinal >= 10, `End game: ${stats.endGame} running, ${stats.endGameInFinal} in the final`);
    // a discussion lasts about one action in this driver, so it is rarely hit here (test/endgame.test.js covers each phase)
    assert.ok(stats.endedIn.reveal && (stats.endedIn.vote || stats.endedIn.defense), `End game in ${JSON.stringify(stats.endedIn)}`);
    // §11 X1: 14 effects from the random pool plus the fixed Airlock and revive; the retired eject never
    const want = ['swap_card', 'reroll_card', 'force_reveal', 'peek', 'mass_reveal', 'shuffle_category', 'immunity', 'protect', 'double_vote',
      'block_vote', 'cancel_vote', 'airlock', 'revive', 'capacity_plus', 'capacity_minus', 'bunker_add_feature'];
    assert.deepEqual(Object.keys(stats.effects).sort(), want.sort(), `effects played: ${Object.keys(stats.effects).join(',')}`);
    console.log(`# schema over the engine: ${JSON.stringify(stats)}`);
  });

  test('the validator rejects drifted views (it is not vacuous)', () => {
    let t = 1_800_000_000_000;
    const g = createGame({ room: 'ABCD', rng: mulberry32(1), now: () => (t += 10), minPlayers: 2 });
    const ids = ['A', 'B', 'C', 'D', 'E', 'F'].map((x) => g.join(x).id);
    const w = g.join('W', { spectator: true }).id;
    assert.deepEqual(validateStateView(g.view(ids[0])), []);
    g.handle(ids[0], { t: 'start' });
    const v = g.view(ids[1]);
    assert.deepEqual(validateStateView(v), []);
    const drift = {
      'extra top-level key': (c) => { c.secret = 1; },
      'missing top-level key': (c) => { delete c.schedule; },
      'me for a spectator': (c) => { c.you = { ...g.view(w).you }; },
      'a hidden card in players[]': (c) => { c.players[0].cards.health = 'x'; },
      'unplayedSpecials outside the final': (c) => { c.players[0].unplayedSpecials = []; },
      'mustReveal null in round 1': (c) => { c.turn.mustReveal = null; },
      'no timer in reveal': (c) => { c.timer = null; },
      'vote outside the vote phase': (c) => { c.vote = { stage: 'main' }; },
      'special without timing': (c) => { delete c.me.specials[0].timing; },
      'special minRound': (c) => { c.me.specials[0].minRound = 3; },
      'kicksByRound': (c) => { c.schedule.kicksByRound = [0, 0, 0, 0, 0, 0, 0]; },
      'log kind': (c) => { c.log[0].kind = 'chat'; },
      'seat order': (c) => { c.players[1].seat = 5; },
      'you.isHost': (c) => { c.you.isHost = true; },
      'options range': (c) => { c.options.speechSeconds = 1; },
      'bunker extra key': (c) => { c.bunker.secret = 'x'; },
      'myVote outside a vote': (c) => { c.me.myVote = 'p1'; },
      'revealedCount': (c) => { c.players[2].revealedCount = 3; },
      'string round': (c) => { c.round = '1'; },
      'lastVoteResult shape': (c) => { c.lastVoteResult = { stage: 'main', tally: [] }; },
      'final outside the final': (c) => { c.final = { survivors: [], out: [] }; },
      'timer longer than its option': (c) => { c.timer.endsAt = c.serverNow + (c.options.speechSeconds1 + 1) * 1000; },
      'airlocks missing': (c) => { delete c.airlocks; },
      'airlocks not an array': (c) => { c.airlocks = null; },
      'an airlock in round 1': (c) => { c.airlocks = [{ targetId: ids[2], byIds: [ids[1]], round: 1 }]; },
      'a special with the retired eject effect': (c) => { c.me.specials[0] = { ...c.me.specials[0], effect: 'eject', target: 'other', category: null, timing: 'before_vote', minRound: 2 }; },
    };
    for (const [name, f] of Object.entries(drift)) {
      const c = structuredClone(v);
      f(c);
      assert.ok(validateStateView(c).length > 0, `the validator missed: ${name}`);
    }
    // §11 X1: a valid open airlock in round 2 passes; each drifted one does not
    while (g.round < 2) g.handle(ids[0], { t: 'next' });
    const base = structuredClone(g.view(ids[1]));
    base.airlocks = [{ targetId: ids[2], byIds: [ids[1]], round: 2 }];
    assert.deepEqual(validateStateView(base), [], 'a valid open airlock');
    const airDrift = {
      'an airlock with an extra key': (c) => { c.airlocks[0].secret = 1; },
      'an airlock without byIds': (c) => { delete c.airlocks[0].byIds; },
      'an airlock on its own opener': (c) => { c.airlocks[0].byIds = [ids[2]]; },
      'an empty byIds': (c) => { c.airlocks[0].byIds = []; },
      'an airlock of another round': (c) => { c.airlocks[0].round = 3; },
      'two airlocks on one target': (c) => { c.airlocks.push({ targetId: ids[2], byIds: [ids[3]], round: 2 }); },
      'an airlock on a stranger': (c) => { c.airlocks[0].targetId = 'p999'; },
      'an airlock on an ejected player': (c) => { c.players[2].status = 'ejected'; },
    };
    for (const [name, f] of Object.entries(airDrift)) {
      const c = structuredClone(base);
      f(c);
      assert.ok(validateStateView(c).some((x) => /airlock/i.test(x)), `the validator missed: ${name}: ${validateStateView(c).join('; ')}`);
    }
    // §11 X6: the lobby after End game is valid; a lobby that kept anything of the ended game is not
    g.handle(ids[1], { t: 'leave' });
    const mid = structuredClone(g.view(ids[2]));
    g.handle(ids[0], { t: 'endGame' });
    const lobby = structuredClone(g.view(ids[2]));
    assert.equal(lobby.phase, 'lobby');
    assert.deepEqual(validateStateView(lobby), [], 'the lobby after End game');
    assert.deepEqual(validateStateView(g.view(w)), [], 'the spectator\'s lobby after End game');
    const lobbyDrift = {
      'an open airlock': (c) => { c.airlocks = [{ targetId: ids[2], byIds: [ids[3]], round: 2 }]; },
      'a player who left': (c) => { c.players.push({ ...c.players[0], id: ids[1], name: 'B', seat: c.players.length, isHost: false, status: 'left' }); },
      'an ejected player': (c) => { c.players[1].status = 'ejected'; },
      'a vote modifier': (c) => { c.voteMods.immune = [ids[2]]; },
      'cancelNext': (c) => { c.voteMods.cancelNext = true; },
      'the last vote result': (c) => { c.lastVoteResult = { stage: 'main', tally: [], ejectedId: null, tie: null, random: false, cancelled: true }; },
      'overtime': (c) => { c.overtime = true; },
      'the round': (c) => { c.round = mid.round; },
      'the beds': (c) => { c.capacity = mid.capacity; },
      'the catastrophe': (c) => { c.catastrophe = mid.catastrophe; },
      'the bunker': (c) => { c.bunker = mid.bunker; },
      'the turn': (c) => { c.turn = mid.turn; },
      'the timer': (c) => { c.timer = mid.timer; },
      'a hand': (c) => { c.me = mid.me; },
      'a revealed card': (c) => { c.players[0].cards.profession = 'Surgeon'; },
      'a played special': (c) => { c.players[0].playedSpecials = [{ title: 'x', text: 'y' }]; },
      'the old schedule': (c) => { c.schedule = mid.schedule; },
    };
    for (const [name, f] of Object.entries(lobbyDrift)) {
      const c = structuredClone(lobby);
      f(c);
      assert.ok(validateStateView(c).length > 0, `the validator missed a lobby with ${name}`);
    }
  });
});
