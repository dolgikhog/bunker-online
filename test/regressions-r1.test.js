// Regression tests for the round-1 review findings fixed on the server side (reports/fix-server-fixer-r1.md):
//   - crossing clicks: the optional step key `at` on reveal/endTurn/next/closeVote/vote (SPEC §11 R1)
//   - one socket / one network holding every room slot (per-network room cap, lone lobbies freed on moving on)
//   - invisible or look-alike names; the revive log line; vote modifiers lost to a cancelled vote; content wording
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGame, EFFECTS, validateMessage, sanitizeName, nameKey } from '../server/game.js';
import { Rooms, MAX_ROOMS, MAX_ROOMS_PER_IP, ipKey } from '../server/rooms.js';
import { createDealer } from '../server/content.js';
import { mulberry32 } from '../server/rng.js';
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
  const g = createGame({ room: 'TEST', rng: mulberry32(seed), now: () => 1_000_000, minPlayers: 2, dealer: makeDealer(specials), fixedSpecials: false });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`).id);
  ok(g.handle(ids[0], { t: 'start' }));
  return { g, ids, host: ids[0] };
}
function ok(res) { assert.deepEqual(res, { ok: true }, JSON.stringify(res)); }
function err(res, code) {
  assert.equal(res.ok, false, `expected ${code}, got ok`);
  assert.equal(res.code, code, `expected ${code}, got ${res.code}: ${res.message}`);
}
const P = (g, id) => g.players.find((p) => p.id === id);
const speaker = (g) => g.turn.order[g.turn.index];
/** The step key exactly as the shipped client builds it from a StateView (SPEC §11 R1). */
function atOf(view) {
  return {
    phase: view.phase, round: view.round, overtime: view.overtime,
    turnIndex: view.turn ? view.turn.index : null, ballot: view.vote ? view.vote.ballot : null, stage: view.vote ? view.vote.stage : null,
  };
}
const at = (g) => atOf(g.view(g.hostId));
/** A snapshot of everything that must not change when a message is refused. */
const snap = (g) => JSON.stringify({ ...g.view(g.hostId), serverNow: 0 });
function nextUntil(g, pred) {
  for (let i = 0; i < 3000 && !pred(g); i++) {
    assert.notEqual(g.phase, 'final');
    if (g.phase === 'vote') {
      const v = g.vote;
      for (const voter of v.voters) if (g.phase === 'vote' && g.vote === v) ok(g.handle(voter, { t: 'vote', targetId: v.candidates.find((c) => c !== voter) }));
      if (g.phase === 'vote' && g.vote === v) ok(g.handle(g.hostId, { t: 'closeVote' }));
    } else ok(g.handle(g.hostId, { t: 'next' }));
  }
  assert.ok(pred(g), 'nextUntil did not reach the wanted state');
}
/** Reveals a card for the current speaker so End turn is allowed. */
function speakerReveals(g) {
  const id = speaker(g);
  const c = g.round === 1 ? 'profession' : Object.keys(P(g, id).cards).find((k) => !P(g, id).cards[k].revealed);
  ok(g.handle(id, { t: 'reveal', category: c, at: at(g) }));
  return id;
}

// ------------------------------------------------------------------------------------------------ step key (§11 R1)
describe('crossing clicks: the optional step key `at` (SPEC §11 R1)', () => {
  test('schema: `at` is optional on reveal/endTurn/next/closeVote/vote; a wrongly typed one is bad_request', () => {
    for (const t of ['endTurn', 'next', 'closeVote']) {
      assert.equal(validateMessage({ t }), null);
      assert.equal(validateMessage({ t, at: null }), null);
      assert.equal(validateMessage({ t, at: { phase: 'reveal', round: 1, overtime: false, turnIndex: 0, ballot: null, stage: null } }), null);
      assert.equal(validateMessage({ t, at: {} }), null);
      assert.equal(validateMessage({ t, at: { extra: [1, 2] } }), null, 'unknown keys are ignored');
      for (const bad of ['reveal', 7, [], true, { round: '1' }, { overtime: 0 }, { turnIndex: 1.5 }, { ballot: '2' }, { stage: 5 }, { phase: null }]) {
        assert.equal(validateMessage({ t, at: bad })?.code, 'bad_request', `${t} at=${JSON.stringify(bad)}`);
      }
    }
    assert.equal(validateMessage({ t: 'vote', targetId: 'p1', at: { ballot: 1, stage: 'main' } }), null);
    assert.equal(validateMessage({ t: 'reveal', category: 'health', at: { turnIndex: 2 } }), null);
    assert.equal(validateMessage({ t: 'vote', targetId: 'p1', at: 'x' })?.code, 'bad_request');
  });

  test('B: speaker End turn + host Next crossing — the host\'s stale Next is refused; exactly one advance', () => {
    const { g, host } = started(4);
    const idx0 = g.turn.index;
    speakerReveals(g);
    const hostView = at(g); // the host's click was made on this state
    ok(g.handle(speaker(g), { t: 'endTurn', at: at(g) }));
    const before = snap(g);
    err(g.handle(host, { t: 'next', at: hostView }), 'wrong_phase');
    assert.equal(snap(g), before, 'a refused Next changes nothing');
    assert.equal(g.turn.index, idx0 + 1, 'exactly one advance');
    assert.equal(P(g, speaker(g)).cards.profession.revealed, false, 'the next speaker was not auto-revealed');
    // the reverse order: the host's Next lands first, then the speaker's stale End turn is refused
    const v2 = at(g);
    const sp2 = speaker(g);
    ok(g.handle(host, { t: 'next', at: v2 }));
    err(g.handle(sp2, { t: 'endTurn', at: v2 }), 'wrong_phase');
    assert.equal(g.turn.index, idx0 + 2);
  });

  test('C: last reveal speaker End turn + host Next — the discussion is not skipped', () => {
    const { g, host } = started(4);
    nextUntil(g, (x) => x.phase === 'reveal' && x.turn.index === x.turn.order.length - 1);
    speakerReveals(g);
    const hostView = at(g);
    ok(g.handle(speaker(g), { t: 'endTurn', at: at(g) }));
    assert.equal(g.phase, 'discussion');
    err(g.handle(host, { t: 'next', at: hostView }), 'wrong_phase');
    assert.equal(g.phase, 'discussion');
  });

  test('A: last defense speaker End turn + host Next — the revote is not closed with 0 votes', () => {
    const { g, ids, host } = started(4);
    nextUntil(g, (x) => x.phase === 'vote');
    // tie P0/P1: P0->P1, P1->P0, P2->P1, P3->P0
    const plan = { [ids[0]]: ids[1], [ids[1]]: ids[0], [ids[2]]: ids[1], [ids[3]]: ids[0] };
    for (const id of g.vote.voters) ok(g.handle(id, { t: 'vote', targetId: plan[id], at: at(g) }));
    assert.equal(g.phase, 'defense');
    ok(g.handle(speaker(g), { t: 'endTurn', at: at(g) }));
    const hostView = at(g);
    ok(g.handle(speaker(g), { t: 'endTurn', at: at(g) }));
    assert.equal(g.phase, 'vote');
    assert.equal(g.vote.stage, 'revote');
    const before = snap(g);
    err(g.handle(host, { t: 'next', at: hostView }), 'wrong_phase');
    assert.equal(snap(g), before);
    assert.equal(g.vote.stage, 'revote', 'the revote is still open');
  });

  test('D: last vote + host Close vote crossing in a 2-ballot step — ballot 2 is not closed with 0 votes', () => {
    const { g, host } = started(4, { specials: { 0: [sp('capacity_minus'), FILLER] } });
    nextUntil(g, (x) => x.phase === 'discussion' && x.round === 5);
    ok(g.handle(host, { t: 'special', uid: P(g, host).specials[0].uid }));
    nextUntil(g, (x) => x.phase === 'vote' && x.round === 7);
    assert.equal(g.step.ballots, 2);
    const v = g.vote;
    const [a, b, c] = v.voters;
    ok(g.handle(a, { t: 'vote', targetId: b, at: at(g) }));
    ok(g.handle(b, { t: 'vote', targetId: c, at: at(g) }));
    const hostView = at(g);
    ok(g.handle(c, { t: 'vote', targetId: b, at: at(g) })); // the last vote closes ballot 1 → ballot 2 opens
    assert.equal(g.phase, 'vote');
    assert.equal(g.step.ballot, 2);
    err(g.handle(host, { t: 'closeVote', at: hostView }), 'wrong_phase');
    err(g.handle(host, { t: 'next', at: hostView }), 'wrong_phase');
    assert.equal(g.phase, 'vote', 'ballot 2 is still open');
    assert.equal(g.lastVoteResult.ejectedId, b);
  });

  test('E: last vote + host "Next: close & count" in a 1-ballot step — the next round\'s first speaker is not skipped', () => {
    const { g, host } = started(4);
    nextUntil(g, (x) => x.phase === 'vote' && x.round === 6);
    const v = g.vote;
    const target = v.candidates[v.candidates.length - 1];
    const hostView = at(g);
    for (const id of v.voters) ok(g.handle(id, { t: 'vote', targetId: id === target ? v.candidates[0] : target, at: at(g) }));
    assert.equal(g.phase, 'reveal');
    assert.equal(g.round, 7);
    err(g.handle(host, { t: 'next', at: hostView }), 'wrong_phase');
    assert.equal(g.turn.index, 0);
    assert.ok(Object.values(P(g, speaker(g)).cards).filter((c) => c.revealed).length === 6, 'no auto-reveal for the first speaker');
  });

  test('a stale vote (aimed at the closed ballot) is refused; a current key and a missing key are accepted', () => {
    const { g, ids } = started(4);
    nextUntil(g, (x) => x.phase === 'vote' && x.round === 6);
    const v = g.vote;
    const view = at(g);
    ok(g.handle(v.voters[0], { t: 'vote', targetId: v.candidates.find((c) => c !== v.voters[0]), at: view }));
    ok(g.handle(v.voters[0], { t: 'vote', targetId: v.candidates.find((c) => c !== v.voters[0]) })); // no key: as before
    ok(g.handle(v.voters[1], { t: 'vote', targetId: v.candidates.find((c) => c !== v.voters[1]), at: { ballot: 1 } })); // partial key
    for (const id of v.voters.slice(2)) ok(g.handle(id, { t: 'vote', targetId: v.candidates.find((c) => c !== id) }));
    assert.equal(g.phase, 'reveal');
    err(g.handle(ids[1], { t: 'vote', targetId: ids[2], at: view }), 'wrong_phase');
    // precedence: not_host still wins for host actions, wrong_phase before not_your_turn / not_allowed
    const stale = { ...at(g), turnIndex: 99 };
    err(g.handle(ids[1], { t: 'next', at: stale }), 'not_host');
    const other = g.players.find((p) => p.status === 'alive' && p.id !== speaker(g)).id;
    err(g.handle(other, { t: 'endTurn', at: stale }), 'wrong_phase');
    err(g.handle(other, { t: 'endTurn', at: at(g) }), 'not_your_turn');
    err(g.handle(speaker(g), { t: 'reveal', category: 'baggage', at: stale }), 'wrong_phase');
    // Next in the lobby/final keeps its own wrong_phase message
    const lobby = createGame({ minPlayers: 2 });
    const h = lobby.join('H').id;
    err(lobby.handle(h, { t: 'next', at: { phase: 'reveal' } }), 'wrong_phase');
  });

  test('over real WebSockets: End turn and the host\'s Next in flight together, both with `at` → exactly one advance', { timeout: 30000 }, async () => {
    const server = await startServer({ seed: 4711, minPlayers: 2 });
    const socks = [];
    try {
      const url = `ws://127.0.0.1:${server.port}/ws`;
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
      h.send({ t: 'create', name: 'Host' });
      await h.until((c) => c.state);
      const others = [];
      for (let i = 1; i < 4; i++) {
        const c = await client();
        c.send({ t: 'join', room: h.state.room, name: `P${i}` });
        await c.until((x) => x.state);
        others.push(c);
      }
      const all = [h, ...others];
      const byId = (id) => all.find((c) => c.state.you.id === id);
      await h.until((c) => c.state.players.length === 4);
      h.send({ t: 'start' });
      await h.until((c) => c.state.phase === 'reveal');
      const count = (c, t) => c.msgs.filter((m) => m.t === t).length;
      for (let turn = 0; turn < 3; turn++) {
        await h.until((c) => c.state.turn && c.state.turn.index === turn);
        const spk = byId(h.state.turn.speakerId);
        await spk.until((c) => c.state.turn && c.state.turn.index === turn);
        spk.send({ t: 'reveal', category: 'profession', at: atOf(spk.state) });
        await spk.until((c) => c.state.turn.hasRevealed);
        await h.until((c) => c.state.turn.hasRevealed);
        const errs = count(h, 'error') + (spk === h ? 0 : count(spk, 'error'));
        const pongs = [count(h, 'pong'), count(spk, 'pong')];
        // both clicks made on the same state and sent at the same moment
        spk.send({ t: 'endTurn', at: atOf(spk.state) });
        h.send({ t: 'next', at: atOf(h.state) });
        spk.send({ t: 'ping' });
        h.send({ t: 'ping' });
        await h.until((c) => count(c, 'pong') > pongs[0]);
        await spk.until((c) => count(c, 'pong') > pongs[1] + (spk === h ? 1 : 0));
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(h.state.turn.index, turn + 1, `turn ${turn}: exactly one advance`);
        assert.equal(h.state.players.find((p) => p.id === h.state.turn.speakerId).cards.profession, null, 'the next speaker was not auto-revealed');
        const refused = [...h.msgs, ...(spk === h ? [] : spk.msgs)].filter((m) => m.t === 'error');
        assert.equal(refused.length - errs, 1, 'whichever click the server handled second was refused');
        assert.equal(refused[refused.length - 1].code, 'wrong_phase');
      }
      assert.deepEqual(server.problems(), []);
    } finally {
      for (const ws of socks) ws.terminate();
      await server.stop();
    }
  });
});

// ------------------------------------------------------------------------------------------------ room slots
function fakeConn(ip) {
  const c = { ip, out: [], send(obj) { c.out.push(JSON.parse(JSON.stringify(obj))); } };
  c.last = (t) => [...c.out].reverse().find((m) => !t || m.t === t);
  return c;
}
function registry(extra = {}) {
  const clock = { t: 5_000_000 };
  const logs = [];
  const rooms = new Rooms({ rng: mulberry32(99), minPlayers: 2, hostGraceMs: 45_000, now: () => clock.t, logger: (m) => logs.push(m), ...extra });
  const conn = (ip = '203.0.113.7') => { const c = fakeConn(ip); rooms.open(c); return c; };
  const send = (c, msg) => rooms.message(c, JSON.stringify(msg));
  return { rooms, clock, conn, send, logs };
}

describe('room slots: one client cannot hold every room', () => {
  test('one socket creating over and over holds one room: its previous lone lobby is freed', () => {
    const { rooms, conn, send } = registry();
    const a = conn();
    for (let i = 0; i < 250; i++) send(a, { t: 'create', name: `r${i}` });
    assert.equal(rooms.rooms.size, 1);
    assert.equal(a.out.filter((m) => m.t === 'joined').length, 250);
    const b = conn('198.51.100.1');
    send(b, { t: 'create', name: 'Friend' });
    assert.equal(b.last().t, 'state');
    assert.equal(rooms.rooms.size, 2);
  });

  test('moving on from a lobby somebody else is in only detaches (the seat stays resumable)', () => {
    const { rooms, conn, send } = registry();
    const a = conn();
    send(a, { t: 'create', name: 'Ann' });
    const first = a.out[0];
    const w = conn('198.51.100.2');
    send(w, { t: 'join', room: first.room, name: 'Watcher', spectator: true });
    send(a, { t: 'create', name: 'Ann again' });
    assert.equal(rooms.rooms.size, 2, 'the first room has a spectator: kept');
    const a2 = conn();
    send(a2, { t: 'resume', room: first.room, token: first.token });
    assert.equal(a2.last('state').you.id, first.id);
    // join / resume elsewhere free a lone lobby too; joining your own lone lobby again does not delete it
    const x = conn('192.0.2.9');
    send(x, { t: 'create', name: 'X' });
    const xRoom = x.out[0].room;
    send(x, { t: 'join', room: xRoom, name: 'X2' });
    assert.ok(rooms.rooms.has(xRoom));
    const y = conn('192.0.2.10');
    send(y, { t: 'create', name: 'Y' });
    const yRoom = y.out[0].room;
    send(y, { t: 'join', room: first.room, name: 'Y' });
    assert.ok(!rooms.rooms.has(yRoom), 'a lone lobby is freed when its member joins another room');
    const z = conn('192.0.2.11');
    send(z, { t: 'create', name: 'Z' });
    const zRoom = z.out[0].room;
    send(z, { t: 'resume', room: first.room, token: first.token });
    assert.ok(!rooms.rooms.has(zRoom), 'a lone lobby is freed when its member resumes elsewhere');
    assert.equal(z.last('state').you.id, first.id);
  });

  test(`a network may hold ${MAX_ROOMS_PER_IP} rooms; at the cap its oldest abandoned lone lobby makes room, else server_busy`, () => {
    const { rooms, conn, send, clock } = registry();
    const made = [];
    for (let i = 0; i < MAX_ROOMS_PER_IP; i++) {
      const c = conn();
      send(c, { t: 'create', name: `R${i}` });
      made.push({ c, room: c.out[0].room });
      clock.t += 1000;
      rooms.close(c); // the tab is gone: an abandoned lone lobby
    }
    assert.equal(rooms.rooms.size, MAX_ROOMS_PER_IP);
    const n = conn();
    send(n, { t: 'create', name: 'Next' });
    assert.equal(n.last().t, 'state');
    assert.equal(rooms.rooms.size, MAX_ROOMS_PER_IP, 'the oldest abandoned lobby was evicted');
    assert.ok(!rooms.rooms.has(made[0].room));
    // rooms that somebody else joined are never evicted: fill the network's quota with real rooms
    const { rooms: r2, conn: conn2, send: send2 } = registry();
    for (let i = 0; i < MAX_ROOMS_PER_IP; i++) {
      const c = conn2();
      send2(c, { t: 'create', name: `H${i}` });
      const g = conn2('198.51.100.50');
      send2(g, { t: 'join', room: c.out[0].room, name: 'Guest' });
      r2.close(c);
      r2.close(g);
    }
    const busy = conn2();
    send2(busy, { t: 'create', name: 'One more' });
    assert.equal(busy.last().code, 'server_busy');
    assert.equal(r2.rooms.size, MAX_ROOMS_PER_IP);
    // another network is unaffected, and IPv4-mapped IPv6 counts as the same IPv4 address
    const other = conn2('198.51.100.51');
    send2(other, { t: 'create', name: 'Other' });
    assert.equal(other.last().t, 'state');
    const mapped = conn2('::ffff:203.0.113.7');
    send2(mapped, { t: 'create', name: 'Mapped' });
    assert.equal(mapped.last().code, 'server_busy');
    // bad_request still wins
    send2(busy, { t: 'create', name: '   ' });
    assert.equal(busy.last().code, 'bad_request');
  });

  test('IPv6 clients count per /64; no cap without an address or with maxRoomsPerIp = Infinity (BUNKER_NO_LIMITS)', () => {
    assert.equal(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
    assert.notEqual(ipKey('2001:db8:1:2::1'), ipKey('2001:db8:1:3::1'));
    assert.equal(ipKey('::ffff:10.1.2.3'), '10.1.2.3');
    assert.equal(ipKey(undefined), null);
    const { rooms, conn, send } = registry({ maxRoomsPerIp: Infinity });
    for (let i = 0; i < 20; i++) { const c = conn(); send(c, { t: 'create', name: `R${i}` }); rooms.close(c); }
    assert.equal(rooms.rooms.size, 20);
    const { rooms: r3, conn: c3, send: s3 } = registry();
    for (let i = 0; i < 20; i++) { const c = c3(null); s3(c, { t: 'create', name: `R${i}` }); r3.close(c); }
    assert.equal(r3.rooms.size, 20);
    assert.ok(MAX_ROOMS >= 200);
  });

  test('over real WebSockets with limits on: one socket sending create 200 times leaves room for a fresh socket', { timeout: 60000 }, async () => {
    const server = await startServer({ seed: 77, noLimits: false });
    const socks = [];
    try {
      const url = `ws://127.0.0.1:${server.port}/ws`;
      const open = () => new Promise((res, rej) => { const ws = new WebSocket(url); socks.push(ws); ws.once('open', () => res(ws)); ws.once('error', rej); });
      const a = await open();
      let joined = 0;
      let closed = false;
      a.on('message', (d) => { if (JSON.parse(d).t === 'joined') joined++; });
      a.on('close', () => { closed = true; });
      for (let i = 0; i < 200 && !closed; i++) { a.send(JSON.stringify({ t: 'create', name: `r${i}` })); await new Promise((r) => setTimeout(r, 55)); }
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(closed, false);
      assert.ok(joined >= 150, `joined ${joined}`);
      // a second socket from the same address cycles open/create/close; the cap keeps it to MAX_ROOMS_PER_IP rooms
      for (let i = 0; i < 12; i++) {
        const c = await open();
        c.send(JSON.stringify({ t: 'create', name: `c${i}` }));
        await new Promise((res) => c.once('message', res));
        c.close();
      }
      const b = await open();
      const reply = await new Promise((res) => {
        b.on('message', (d) => { const m = JSON.parse(d); if (m.t !== 'state') res(m); });
        b.send(JSON.stringify({ t: 'create', name: 'Friend' }));
      });
      assert.equal(reply.t, 'joined', JSON.stringify(reply));
      assert.deepEqual(server.problems(), []);
    } finally {
      for (const ws of socks) ws.terminate();
      await server.stop();
    }
  });
});

// ------------------------------------------------------------------------------------------------ names
describe('names: invisible characters and look-alikes', () => {
  test('format characters, fillers and lone joiners are removed; nothing visible left → rejected', () => {
    for (const blank of ['ㅤ', 'ᅟ', 'ᅠ', 'ﾠ', '⁠', '️', '‍', '­', '⠀⠀', '́', '͏', '‌', ' 　 ']) {
      assert.equal(sanitizeName(blank), '', JSON.stringify(blank));
    }
    assert.equal(sanitizeName('P0⁠'), 'P0');
    assert.equal(sanitizeName('P0­'), 'P0');
    assert.equal(sanitizeName('Al‍ice'), 'Alice');
    assert.equal(sanitizeName('A　　B'), 'A B');
    assert.equal(sanitizeName('á'.repeat(15)), 'á'.repeat(15), 'NFC: one code point per letter');
    // emoji sequences survive (the joiner and the variation selector are part of one glyph)
    assert.equal(sanitizeName('\u{1F3F3}️‍\u{1F308}'), '\u{1F3F3}️‍\u{1F308}');
    assert.equal(sanitizeName('❤️ Kate'), '❤️ Kate');
    assert.ok(!sanitizeName('\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'.repeat(6)).endsWith('‍'), 'no dangling joiner after the cut');
    assert.equal(sanitizeName('Иван'), 'Иван');
  });

  test('names that look the same get the " (2)" suffix', () => {
    const g = createGame({ minPlayers: 2 });
    const names = [];
    for (const n of ['P0', 'P0⁠', 'P0­', 'P0️', 'Ｐ０', 'P0 ', 'Ann', 'Ann‍']) {
      const r = g.join(n, { spectator: names.length > 3 });
      assert.equal(r.ok, true, n);
      names.push(g.view(r.id).you.name);
    }
    assert.deepEqual(names.slice(0, 3), ['P0', 'P0 (2)', 'P0 (3)']);
    assert.equal(nameKey(names[3]), nameKey('P0 (4)'));
    assert.equal(nameKey(names[4]), 'P0 (5)', 'full-width letters compare equal (NFKC)');
    assert.equal(names[5], 'P0 (6)');
    assert.deepEqual(names.slice(6), ['Ann', 'Ann (2)']);
    assert.equal(g.join('ㅤ').code, 'bad_request');
  });
});

// ------------------------------------------------------------------------------------------------ log lines
describe('log lines say what the engine does', () => {
  const lastSpecialLog = (g) => [...g.log].reverse().find((e) => e.kind === 'special').text;

  test('revive: a player still ahead in the reveal order speaks this round, and the log says so', () => {
    const { g, ids } = started(6, { specials: { 0: [sp('eject'), FILLER], 1: [sp('revive'), FILLER] } });
    nextUntil(g, (x) => x.phase === 'reveal' && x.round === 2);
    assert.deepEqual(g.turn.order, [...ids].reverse()); // descending; P2 is later than the speaker
    ok(g.handle(ids[0], { t: 'special', uid: P(g, ids[0]).specials[0].uid, targetId: ids[2] }));
    ok(g.handle(ids[1], { t: 'special', uid: P(g, ids[1]).specials[0].uid, targetId: ids[2] }));
    const line = lastSpecialLog(g);
    assert.match(line, /P2 is back in the game \(they still get their turn this round\)$/);
    let spoke = false;
    while (g.phase === 'reveal') { if (speaker(g) === ids[2]) spoke = true; ok(g.handle(g.hostId, { t: 'next' })); }
    assert.ok(spoke, 'the log matches what happened');
  });

  test('revive: someone who was out when the phase began waits for the next round; in round 7 there is no suffix', () => {
    const { g, ids } = started(6, { specials: { 1: [sp('revive'), FILLER], 2: [sp('revive'), FILLER] } });
    nextUntil(g, (x) => x.phase === 'reveal' && x.round === 6);
    const out = g.players.find((p) => p.status === 'ejected');
    const reviver = [ids[1], ids[2]].find((id) => P(g, id).status === 'alive' && id !== out.id);
    ok(g.handle(reviver, { t: 'special', uid: P(g, reviver).specials[0].uid, targetId: out.id }));
    assert.match(lastSpecialLog(g), /is back in the game \(from the next round on\)$/);
    assert.ok(!g.turn.order.includes(out.id));
    nextUntil(g, (x) => x.phase === 'reveal' && x.round === 7);
    const out7 = g.players.find((p) => p.status === 'ejected');
    const r7 = [ids[1], ids[2]].find((id) => P(g, id).status === 'alive' && !P(g, id).specials[0].used);
    if (out7 && r7) {
      ok(g.handle(r7, { t: 'special', uid: P(g, r7).specials[0].uid, targetId: out7.id }));
      assert.match(lastSpecialLog(g), /is back in the game$/, 'round 7: no later reveal phase exists');
    }
  });

  test('a skipped (cancelled) vote names the immunity, block and ×2 it uses up', () => {
    const { g, ids } = started(8, {
      specials: { 0: [sp('cancel_vote'), FILLER], 1: [sp('immunity'), FILLER], 2: [sp('block_vote'), FILLER], 3: [sp('double_vote'), FILLER] },
    });
    nextUntil(g, (x) => x.phase === 'discussion' && x.round === 4);
    assert.ok(g._kicksNow() > 0, 'round 4 has a vote for 8 players');
    ok(g.handle(ids[1], { t: 'special', uid: P(g, ids[1]).specials[0].uid }));
    ok(g.handle(ids[2], { t: 'special', uid: P(g, ids[2]).specials[0].uid, targetId: ids[4] }));
    ok(g.handle(ids[3], { t: 'special', uid: P(g, ids[3]).specials[0].uid }));
    ok(g.handle(ids[0], { t: 'special', uid: P(g, ids[0]).specials[0].uid }));
    ok(g.handle(g.hostId, { t: 'next' }));
    const line = [...g.log].reverse().find((e) => e.kind === 'vote').text;
    assert.match(line, /the vote is cancelled/);
    assert.match(line, /P1's immunity, P4's vote block and P3's double vote were for this vote and are used up/);
    assert.deepEqual(g.view(ids[0]).voteMods, { immune: [], blocked: [], doubleVote: [], cancelNext: false }, 'the rule itself is unchanged (SPEC §3)');
  });
});

// ------------------------------------------------------------------------------------------------ content
describe('content wording', () => {
  test('profession years fit the age on the Biology card dealt right after; no clinical "homosexual"', () => {
    let pairs = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const d = createDealer(mulberry32(seed));
      d.drawCatastrophe();
      d.drawBunker();
      for (let i = 0; i < 8; i++) {
        const prof = d.drawCard('profession');
        const bio = d.drawCard('biology');
        for (const c of ['health', 'hobby', 'phobia', 'skill', 'trait', 'baggage']) {
          const t = d.drawCard(c);
          assert.doesNotMatch(t, /battery lasts/);
        }
        pairs++;
        assert.doesNotMatch(bio, /homosexual/);
        const age = Number(/(\d+) y\.o\./.exec(bio)[1]);
        assert.ok(age >= 18 && age <= 85, bio);
        const m = /(\d+) years? of experience|retired after (\d+) years|license revoked after (\d+) years?|self-taught, (\d+) years?|(\d+) years? of practice|(\d+) years without a job/.exec(prof);
        const yrs = m ? Number(m.slice(1).find((x) => x !== undefined)) : 0;
        assert.ok(!yrs || yrs <= age - 14, `${bio} | ${prof}`);
        if (/retired/.test(prof)) assert.ok(age >= 42, `${bio} | ${prof}`);
        if (/student, /.test(prof)) assert.ok(age <= 40, `${bio} | ${prof}`);
        if (/lesbian/.test(bio)) assert.match(bio, /^Female/);
        if (/, gay/.test(bio)) assert.match(bio, /^Male/);
      }
    }
    assert.equal(pairs, 2400);
  });
});
