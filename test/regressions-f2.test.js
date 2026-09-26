// Regression tests for the f2 review findings fixed on the server side (reports/fix-server-fixer-f2.md, SPEC §11 Z1–Z4):
//   - Z1: a neighbour's wrong room codes (same IPv4, or the same IPv6 /48) made the server refuse a player's valid resume
//   - Z2: an Airlock join confirmed on the last reveal turn was refused "Too late" in the discussion, where it still works
//   - Z3: a vote-blocked player (or a non-voter of the open ballot) could spend a ×2 for nothing
//   - Z4: the two UTF-16 halves of 🚪 split by a stripped character joined into a door in a name
//   - X1 wording: the airlock's start line said "before the vote", but it jams when this round's discussion ends
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGame, EFFECTS, sanitizeName, NAME_MAX } from '../server/game.js';
import { Rooms, JOIN_FAIL_BURST, JOIN_FAIL_SITE_BURST, JOIN_FAIL_REFILL_MS, SITE_FACTOR } from '../server/rooms.js';
import { mulberry32 } from '../server/rng.js';
import { startServer } from '../server/index.js';
import { playableSpecials } from '../tools/botlib.js';

// ------------------------------------------------------------------------------------------------ engine helpers
const FILLER = { id: 'filler', title: 'Blueprint', text: 'Adds a bunker feature.', effect: 'bunker_add_feature', target: 'none' };
const sp = (effect, extra = {}) => ({ id: effect, title: `T:${effect}`, text: `Card text for ${effect}`, effect, target: EFFECTS[effect].targets[0], ...extra });
function handDealer(specials = {}) {
  let cardN = 0;
  let specialN = 0;
  return {
    drawCard(c) { cardN++; return `<${c}#${cardN}>`; },
    drawSpecial() { const i = specialN++; return { ...(specials[Math.floor(i / 2)]?.[i % 2] ?? FILLER) }; },
    drawCatastrophe() { return { title: 'Flood', text: 'Water.', details: ['1%'] }; },
    drawBunker() { return { name: 'B', size: '50 m2', duration: '1 year', food: '1 year', features: ['Well'] }; },
    drawBunkerFeature() { cardN++; return `<feature#${cardN}>`; },
  };
}
function started(n, specials = {}) {
  const clock = { t: 1_800_000_000_000 };
  const g = createGame({ room: 'TEST', rng: mulberry32(11), now: () => clock.t++, minPlayers: 2, dealer: handDealer(specials), fixedSpecials: false });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`).id);
  ok(g.handle(ids[0], { t: 'start' }));
  return { g, ids };
}
/** A real-content game (the X1 fixed deal) of n players where exactly two hold an Airlock. */
function realWithTwoAirlocks(n) {
  for (let seed = 1; seed < 500; seed++) {
    const g = createGame({ room: 'TEST', rng: mulberry32(seed), now: () => 1e12, minPlayers: 4 });
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`).id);
    ok(g.handle(ids[0], { t: 'start' }));
    const holders = g.players.filter((p) => p.specials.some((s) => s.effect === 'airlock')).map((p) => p.id);
    if (holders.length === 2) return { g, ids, holders };
  }
  throw new Error('no seed deals two Airlocks');
}
const holders = (g) => g.players.filter((p) => p.specials.some((s) => s.effect === 'airlock')).map((p) => p.id);
function ok(res) { assert.deepEqual(res, { ok: true }, JSON.stringify(res)); }
function err(res, code, re) {
  assert.equal(res.ok, false, `expected ${code}, got ok`);
  assert.equal(res.code, code, `expected ${code}, got ${res.code}: ${res.message}`);
  if (re) assert.match(res.message, re);
}
const P = (g, id) => g.players.find((p) => p.id === id);
const card = (g, id, effect) => P(g, id).specials.find((s) => s.effect === effect && !s.used);
const play = (g, id, effect, extra = {}) => g.handle(id, { t: 'special', uid: card(g, id, effect).uid, ...extra });
/** The step key the shipped client sends on `special` (SPEC §11 R3/K7: R1's key without turnIndex). */
const keyOf = (g, id) => {
  const v = g.view(id);
  return { phase: v.phase, round: v.round, overtime: v.overtime, ballot: v.vote ? v.vote.ballot : null, stage: v.vote ? v.vote.stage : null };
};
const snap = (g) => JSON.stringify({ ...g.view(g.hostId), serverNow: 0 });
function nextUntil(g, pred) {
  for (let i = 0; i < 3000 && !pred(g); i++) {
    assert.notEqual(g.phase, 'final', 'the game ended first');
    if (g.phase === 'vote') {
      const target = g.vote.candidates[g.vote.candidates.length - 1];
      for (const v of [...g.vote.voters]) if (g.phase === 'vote' && v !== target) ok(g.handle(v, { t: 'vote', targetId: target }));
      if (g.phase === 'vote') ok(g.handle(g.hostId, { t: 'closeVote' }));
    } else ok(g.handle(g.hostId, { t: 'next' }));
  }
  assert.ok(pred(g), 'did not reach the wanted state');
}

// ------------------------------------------------------------------------------------------------ X1 wording
describe('the airlock start line says what the airlock does (SPEC §11 X1, Z2 note)', () => {
  test('6 players, round 2 (next vote in round 5): the line says "before this round\'s discussion ends", and so it is', () => {
    const { g, ids, holders: [A, B] } = realWithTwoAirlocks(6);
    const T = ids.find((id) => !holders(g).includes(id));
    nextUntil(g, (x) => x.round === 2 && x.phase === 'discussion');
    assert.equal(g.view(ids[0]).schedule.nextVoteRound, 5, 'no vote this round');
    ok(play(g, A, 'airlock', { targetId: T }));
    const line = g.log.at(-1).text;
    assert.equal(line, `🚪 ${P(g, A).name} started cycling the airlock on ${P(g, T).name}. If one more Airlock card is played on ${P(g, T).name} before this round's discussion ends, ${P(g, T).name} is out — no vote.`);
    assert.doesNotMatch(line, /before the vote/);
    ok(g.handle(g.hostId, { t: 'next' })); // this round's discussion ends: it jams, as the line says
    assert.deepEqual([g.round, g.phase, g.airlocks], [3, 'reveal', []]);
    assert.equal(g.log.filter((e) => e.text.startsWith('🚪')).at(-1).text, `🚪 The airlock on ${P(g, T).name} jammed — nobody closed it.`);
    // a later Airlock (still before round 5's vote) opens a new one: the line never promised otherwise
    nextUntil(g, (x) => x.round === 3 && x.phase === 'discussion');
    ok(play(g, B, 'airlock', { targetId: T }));
    assert.equal(P(g, T).status, 'alive');
    assert.match(g.log.at(-1).text, /started cycling the airlock on .+ before this round's discussion ends/);
  });
});

// ------------------------------------------------------------------------------------------------ Z2
describe('a special confirmed in the reveal and arriving in the same round\'s discussion still lands (SPEC §11 Z2)', () => {
  test('an Airlock join confirmed on the last reveal turn, the End turn landing first: the airlock is sealed', () => {
    const { g, ids, holders: [A, B] } = realWithTwoAirlocks(6);
    nextUntil(g, (x) => x.round === 2 && x.phase === 'reveal');
    const order = g.turn.order;
    const T = ids.find((id) => !holders(g).includes(id) && id !== order[order.length - 1]);
    ok(play(g, A, 'airlock', { targetId: T }));
    while (g.turn.index < g.turn.order.length - 1) ok(g.handle(g.hostId, { t: 'next' }));
    const confirmedOn = keyOf(g, B);
    assert.equal(confirmedOn.phase, 'reveal');
    const last = g.turn.order[g.turn.index];
    const hidden = Object.keys(P(g, last).cards).find((c) => !P(g, last).cards[c].revealed);
    ok(g.handle(last, { t: 'reveal', category: hidden }));
    ok(g.handle(last, { t: 'endTurn' }));
    assert.deepEqual([g.round, g.phase], [2, 'discussion']);
    ok(play(g, B, 'airlock', { targetId: T, at: confirmedOn }));
    assert.equal(P(g, T).status, 'ejected');
    assert.deepEqual(g.airlocks, []);
    assert.equal(g.log.at(-1).kind, 'eject');
    assert.match(g.log.at(-1).text, /^🚪 .+ sealed the airlock with .+ — .+ is thrown out of the bunker, no vote!$/u);
  });

  test('crossing into the vote or into the next round is still refused, and nothing is spent', () => {
    // N=6: round 5 has the first vote. An anytime card (mass_reveal) passes the timing check in a vote, so only the
    // step key can stop it there.
    const { g, ids } = started(6, { 2: [sp('mass_reveal', { category: 'hobby' }), sp('double_vote')] });
    nextUntil(g, (x) => x.round === 5 && x.phase === 'reveal');
    const k = keyOf(g, ids[2]);
    nextUntil(g, (x) => x.phase === 'vote');
    let before = snap(g);
    err(play(g, ids[2], 'mass_reveal', { at: k }), 'wrong_phase', /Too late/);
    assert.equal(snap(g), before);
    // round 1's reveal → round 2's reveal (no vote in between)
    const h = started(4, { 3: [sp('mass_reveal', { category: 'hobby' }), FILLER] });
    const k1 = keyOf(h.g, h.ids[3]);
    nextUntil(h.g, (x) => x.round === 2);
    before = snap(h.g);
    err(play(h.g, h.ids[3], 'mass_reveal', { at: k1 }), 'wrong_phase');
    assert.equal(snap(h.g), before);
    assert.equal(card(h.g, h.ids[3], 'mass_reveal').used, false);
    // a key naming the discussion while the reveal still runs is not the current step either
    const f = started(4, { 3: [sp('mass_reveal', { category: 'hobby' }), FILLER] });
    err(play(f.g, f.ids[3], 'mass_reveal', { at: { ...keyOf(f.g, f.ids[3]), phase: 'discussion' } }), 'wrong_phase');
    // the control: the same crossing within one round lands
    const c = started(4, { 3: [sp('mass_reveal', { category: 'hobby' }), FILLER] });
    const kc = keyOf(c.g, c.ids[3]);
    nextUntil(c.g, (x) => x.phase === 'discussion');
    ok(play(c.g, c.ids[3], 'mass_reveal', { at: kc }));
    assert.ok(c.g.players.every((p) => p.cards.hobby.revealed));
  });

  test('only specials: a Next made in the reveal still does not land on the discussion (SPEC §11 R1)', () => {
    const { g } = started(4);
    while (g.turn.index < g.turn.order.length - 1) ok(g.handle(g.hostId, { t: 'next' }));
    const k = { ...keyOf(g, g.hostId), turnIndex: g.turn.index };
    ok(g.handle(g.hostId, { t: 'next' }));
    assert.equal(g.phase, 'discussion');
    err(g.handle(g.hostId, { t: 'next', at: k }), 'wrong_phase');
    assert.equal(g.phase, 'discussion');
  });
});

// ------------------------------------------------------------------------------------------------ Z3
describe('a ×2 needs a vote to double (SPEC §11 Z3)', () => {
  const deal = { 0: [sp('block_vote'), FILLER], 1: [sp('double_vote'), FILLER], 2: [sp('double_vote'), FILLER] };

  test('blocked in the open vote: refused, the card and the round allowance stay; the unblocked player\'s ×2 works', () => {
    const { g, ids } = started(6, deal);
    nextUntil(g, (x) => x.round === 5 && x.phase === 'discussion');
    ok(play(g, ids[0], 'block_vote', { targetId: ids[1] }));
    ok(g.handle(g.hostId, { t: 'next' }));
    assert.equal(g.phase, 'vote');
    assert.ok(!g.vote.voters.includes(ids[1]));
    const before = snap(g);
    err(play(g, ids[1], 'double_vote'), 'not_allowed', /blocked in this vote/);
    assert.equal(snap(g), before, 'nothing changed: no log line, no ×2');
    assert.equal(card(g, ids[1], 'double_vote').used, false);
    assert.equal(g.view(ids[1]).me.canPlaySpecial, true);
    const x2 = (id) => playableSpecials(g.view(id)).filter((x) => x.special.effect === 'double_vote').length;
    assert.equal(x2(ids[1]), 0, 'bots see it as unplayable');
    assert.equal(x2(ids[2]), 1);
    ok(play(g, ids[2], 'double_vote'));
    assert.deepEqual(g.view(ids[0]).voteMods.doubleVote, [ids[2]]);
  });

  test('blocked for the next vote (played before it): refused; after that vote the block is gone and the ×2 plays', () => {
    const { g, ids } = started(6, deal);
    nextUntil(g, (x) => x.round === 3 && x.phase === 'reveal');
    ok(play(g, ids[0], 'block_vote', { targetId: ids[1] }));
    err(play(g, ids[1], 'double_vote'), 'not_allowed', /blocked in the next vote/);
    nextUntil(g, (x) => x.round === 4 && x.phase === 'discussion');
    err(play(g, ids[1], 'double_vote'), 'not_allowed', /blocked/);
    // in the defense of a tie (vote is null there) the block still holds
    nextUntil(g, (x) => x.round === 5 && x.phase === 'vote');
    const v = g.vote;
    const [a, b] = v.candidates.filter((c) => c !== ids[1]).slice(-2);
    const others = v.voters.filter((x) => x !== a && x !== b);
    others.forEach((voter, i) => {
      const third = v.candidates.find((c) => c !== a && c !== b && c !== voter);
      ok(g.handle(voter, { t: 'vote', targetId: i === others.length - 1 && others.length % 2 ? third : i % 2 ? a : b }));
    });
    ok(g.handle(a, { t: 'vote', targetId: b }));
    ok(g.handle(b, { t: 'vote', targetId: a }));
    assert.equal(g.phase, 'defense', 'a tie between a and b');
    assert.equal(g.vote, null);
    err(play(g, ids[1], 'double_vote'), 'not_allowed', /blocked in this vote/);
    nextUntil(g, (x) => x.round === 6 && x.phase === 'reveal');
    assert.deepEqual(g.view(ids[0]).voteMods.blocked, [], 'the block was for round 5\'s vote');
    ok(play(g, ids[1], 'double_vote'));
  });

  test('not a voter of the open ballot (the only one not immune): refused', () => {
    const { g, ids } = started(4, {
      0: [sp('immunity'), FILLER], 1: [sp('immunity'), FILLER], 2: [sp('immunity'), FILLER], 3: [sp('double_vote'), FILLER],
    });
    nextUntil(g, (x) => x.round === 6 && x.phase === 'discussion'); // N=4: the first vote is in round 6
    for (const i of [0, 1, 2]) ok(play(g, ids[i], 'immunity'));
    ok(g.handle(g.hostId, { t: 'next' }));
    assert.equal(g.phase, 'vote');
    assert.deepEqual(g.vote.candidates, [ids[3]]);
    assert.ok(!g.vote.voters.includes(ids[3]));
    err(play(g, ids[3], 'double_vote'), 'not_allowed', /not a voter/);
    assert.deepEqual(playableSpecials(g.view(ids[3])).filter((x) => x.special.effect === 'double_vote'), []);
  });
});

// ------------------------------------------------------------------------------------------------ Z4
describe('names: no door out of split halves (SPEC §11 Z4)', () => {
  test('a stripped character between the two halves of 🚪 does not join them; lone surrogates are removed', () => {
    const door = '\u{1F6AA}';
    assert.equal(sanitizeName('\uD83D\u0000\uDEAA'), '');
    assert.equal(sanitizeName('\uD83D\u200B\uDEAA Rex'), 'Rex');
    assert.equal(sanitizeName('\uD83D\u00AD\uDEAA sealed'), 'sealed');
    assert.equal(sanitizeName('\uD83D\u00AD\uDEAA\uFE0F sealed'), 'sealed', 'no orphan variation selector is left in front');
    assert.equal(sanitizeName('Ann \uFE0F\uFE0FBo'), 'Ann Bo');
    assert.equal(sanitizeName('\u2764\uFE0F Kate'), '\u2764\uFE0F Kate', 'a variation selector on its emoji stays');
    assert.equal(sanitizeName('\uD83D\u2028\uDEAA\uD83D\u0007\uDEAA'), '');
    assert.equal(sanitizeName('Ann\uD83D'), 'Ann');
    assert.equal(sanitizeName('\uDEAAAnn'), 'Ann');
    assert.equal(sanitizeName('😀 Ann'), '😀 Ann', 'a whole pair is kept');
    // a fuzz over the pieces that could make a door
    const pieces = ['\uD83D', '\uDEAA', '\u0000', '\u200B', '\u00AD', '\u2028', '\uFE0F', door, 'a', ' ', '😀', '\u200D'];
    const rng = mulberry32(7);
    for (let i = 0; i < 20000; i++) {
      let s = '';
      const len = 1 + Math.floor(rng() * 10);
      for (let j = 0; j < len; j++) s += pieces[Math.floor(rng() * pieces.length)];
      const out = sanitizeName(s);
      assert.ok(!out.includes(door), JSON.stringify(s));
      assert.ok(!/\p{Cs}/u.test(out), `lone surrogate left: ${JSON.stringify(s)}`);
      assert.ok(Array.from(out).length <= NAME_MAX);
    }
  });

  test('through the room registry: a name of split door halves is bad_request, and no log line gets a door', () => {
    const rooms = new Rooms({ rng: mulberry32(3), minPlayers: 2, now: () => 1 });
    const out = [];
    const c = { ip: '203.0.113.1', send: (m) => out.push(JSON.parse(JSON.stringify(m))) };
    rooms.open(c);
    rooms.message(c, JSON.stringify({ t: 'create', name: '\uD83D\u0000\uDEAA' }));
    assert.deepEqual([out[0].t, out[0].code], ['error', 'bad_request']);
    rooms.message(c, JSON.stringify({ t: 'create', name: '\uD83D\u200B\uDEAA Rex' }));
    const st = out.find((m) => m.t === 'state');
    assert.equal(st.players[0].name, 'Rex');
    assert.ok(st.log.every((e) => !e.text.startsWith('🚪')), JSON.stringify(st.log));
  });
});

// ------------------------------------------------------------------------------------------------ Z1
describe('a throttled network still gets its own seats back (SPEC §11 Z1)', () => {
  function registry() {
    const clock = { t: 5_000_000 };
    const rooms = new Rooms({ rng: mulberry32(99), minPlayers: 2, hostGraceMs: 45_000, now: () => clock.t });
    const conn = (ip) => {
      const c = { ip, out: [], send(obj) { c.out.push(JSON.parse(JSON.stringify(obj))); } };
      c.last = () => c.out.at(-1);
      c.firstNonState = () => c.out.find((m) => m.t !== 'state');
      rooms.open(c);
      return c;
    };
    const send = (c, msg) => rooms.message(c, JSON.stringify(msg));
    return { rooms, clock, conn, send };
  }
  const tokensLeft = (rooms, key) => (rooms.lookupBudget.get(key) || { tokens: Infinity }).tokens;

  test('IPv4: a neighbour spends the budget; the victim\'s valid resume is admitted; everything else is the same server_busy and costs nothing', () => {
    const { rooms, conn, send } = registry();
    const host = conn('198.51.100.9');
    send(host, { t: 'create', name: 'Host' });
    const { room } = host.out[0];
    const victim = conn('203.0.113.77');
    send(victim, { t: 'join', room, name: 'Victim' });
    const { id, token } = victim.out[0];
    rooms.close(victim); // Wi-Fi blip
    const game = rooms.rooms.get(room).game;
    assert.equal(game.players.find((p) => p.id === id).connected, false);
    const neighbour = conn('203.0.113.77');
    for (let i = 0; i < JOIN_FAIL_BURST; i++) { send(neighbour, { t: 'join', room: 'ZZZZ', name: 'x' }); assert.equal(neighbour.last().code, 'no_room'); }
    send(neighbour, { t: 'join', room: 'ZZZZ', name: 'x' });
    assert.equal(neighbour.last().code, 'server_busy');
    const left = tokensLeft(rooms, '203.0.113.77');
    assert.ok(left < 1);
    // the answers that must not tell a code apart: all the same, and none spends anything
    const probes = [
      { t: 'resume', room, token: 'not-a-token' },
      { t: 'resume', room: 'ZZZZ', token: 'not-a-token' },
      { t: 'resume', room: 'ZZZZ', token }, // a real token for a code that does not exist
      { t: 'join', room, name: 'Late' },
      { t: 'join', room: 'ZZZZ', name: 'Late' },
    ];
    const answers = probes.map((m) => { send(neighbour, m); return neighbour.last(); });
    for (const a of answers) assert.deepEqual(a, answers[0]);
    assert.equal(answers[0].code, 'server_busy');
    assert.match(answers[0].message, /Too many wrong room codes/);
    assert.equal(tokensLeft(rooms, '203.0.113.77'), left, 'refusals while throttled spend nothing');
    // the victim comes back on a new socket from the same network
    const back = conn('203.0.113.77');
    send(back, { t: 'resume', room: room.toLowerCase(), token });
    assert.deepEqual(back.firstNonState(), { t: 'joined', room, id, token });
    assert.equal(back.last().t, 'state');
    assert.equal(game.players.find((p) => p.id === id).connected, true);
    assert.equal(host.last().players.find((p) => p.id === id).connected, true, 'the table sees the victim back');
    assert.equal(tokensLeft(rooms, '203.0.113.77'), left, 'a valid resume spends nothing');
  });

  test(`IPv6: ${SITE_FACTOR} /64s empty their /48's bucket; a player on another /64 of it still resumes`, () => {
    const { rooms, conn, send } = registry();
    const host = conn('198.51.100.9');
    send(host, { t: 'create', name: 'Host' });
    const { room } = host.out[0];
    const victim = conn('2001:db8:99:1::1');
    send(victim, { t: 'join', room, name: 'Victim' });
    const { id, token } = victim.out[0];
    rooms.close(victim);
    let spent = 0;
    for (let k = 0; spent < JOIN_FAIL_SITE_BURST; k++) {
      const a = conn(`2001:db8:99:a${k}::1`);
      for (let i = 0; i < JOIN_FAIL_BURST && spent < JOIN_FAIL_SITE_BURST; i++, spent++) send(a, { t: 'join', room: 'ZZZZ', name: 'x' });
    }
    const back = conn('2001:db8:99:1::2');
    send(back, { t: 'resume', room, token: 'nope' });
    assert.equal(back.last().code, 'server_busy', 'the /48 is out of lookups');
    send(back, { t: 'resume', room, token });
    assert.deepEqual(back.out.at(-2), { t: 'joined', room, id, token });
    assert.equal(rooms.rooms.get(room).game.players.find((p) => p.id === id).connected, true);
  });

  test('a valid resume while throttled also replaces an older socket of the seat, as always', () => {
    const { conn, send } = registry();
    const host = conn('198.51.100.9');
    send(host, { t: 'create', name: 'Host' });
    const { room, token } = host.out[0];
    const scan = conn('198.51.100.9');
    for (let i = 0; i <= JOIN_FAIL_BURST; i++) send(scan, { t: 'join', room: 'QQQQ', name: 'x' });
    assert.equal(scan.last().code, 'server_busy');
    const tab2 = conn('198.51.100.9');
    send(tab2, { t: 'resume', room, token });
    assert.equal(tab2.out[0].t, 'joined');
    assert.deepEqual(host.last(), { t: 'error', code: 'replaced', message: 'This seat was opened in another tab or window' });
  });

  test('real sockets behind the proxy (limits on): 20 wrong codes from the victim\'s address, then its blip and resume', { timeout: 30000 }, async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', noLimits: false, trustProxy: true, minPlayers: 2, seed: 'z1', hostGraceMs: 45000, logger: () => {} });
    const socks = [];
    const open = (xff) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { 'X-Forwarded-For': xff } });
      const c = { ws, msgs: [] };
      socks.push(ws);
      ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
      ws.on('open', () => resolve(c));
      ws.on('error', reject);
    });
    const reply = async (c, msg) => {
      const n = c.msgs.length;
      c.ws.send(JSON.stringify(msg));
      const t0 = Date.now();
      for (;;) {
        const m = c.msgs.slice(n).find((x) => x.t !== 'state');
        if (m) return m;
        if (Date.now() - t0 > 3000) throw new Error(`no reply to ${JSON.stringify(msg)}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    try {
      const friend = await open('10.1.1.1, 198.51.100.9');
      const made = await reply(friend, { t: 'create', name: 'Friend' });
      const victim = await open('203.0.113.77');
      const joined = await reply(victim, { t: 'join', room: made.room, name: 'Victim' });
      assert.equal(joined.t, 'joined');
      victim.ws.terminate();
      const neighbour = await open('6.6.6.6, 203.0.113.77'); // a forged prefix changes nothing
      const codes = [];
      for (let i = 0; i <= JOIN_FAIL_BURST; i++) {
        await new Promise((r) => setTimeout(r, 55)); // under 20 msg/s
        codes.push((await reply(neighbour, { t: 'join', room: 'ZZZZ', name: 'x' })).code);
      }
      assert.deepEqual(codes, [...Array(JOIN_FAIL_BURST).fill('no_room'), 'server_busy']);
      const back = await open('203.0.113.77');
      assert.equal((await reply(back, { t: 'resume', room: made.room, token: 'nope' })).code, 'server_busy');
      const r = await reply(back, { t: 'resume', room: made.room, token: joined.token });
      assert.deepEqual([r.t, r.id], ['joined', joined.id]);
      const t0 = Date.now();
      const seen = () => [...friend.msgs].reverse().find((m) => m.t === 'state')?.players.find((p) => p.id === joined.id)?.connected;
      while (!seen() && Date.now() - t0 < 2000) await new Promise((res) => setTimeout(res, 10));
      assert.equal(seen(), true, 'the table sees the victim back');
    } finally {
      for (const ws of socks) ws.terminate();
      await srv.close();
    }
  });
});
