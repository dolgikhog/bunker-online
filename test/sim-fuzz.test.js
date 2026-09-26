// Hostile-client tests (SPEC.md §7 error codes, §9 robustness): exact error codes over the wire, a fuzzer that sends
// random / malformed / oversized frames and illegal actions while real games run next to it (and while a hostile *player*
// sits in a game), and the rate limit / per-IP socket cap on a server with the limits on. The server must never exit,
// never print a stack trace, keep answering /healthz, and the games next to the fuzzer must still pass every invariant.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import WebSocket from 'ws';
import { ERROR_CODES, makeRng, pick, toWsUrl } from '../tools/botlib.js';
import { Bot, assertServerHealthy, expectError, runTable, sleep, startServer, until } from './helpers-sim.js';

const CATS = ['profession', 'biology', 'health', 'hobby', 'phobia', 'skill', 'trait', 'baggage'];
const ALL_T = ['create', 'join', 'resume', 'leave', 'setOptions', 'start', 'takeSeat', 'kick', 'transferHost', 'reveal', 'endTurn',
  'next', 'vote', 'closeVote', 'special', 'playAgain', 'endGame', 'ping'];
const GAME_T = ['setOptions', 'start', 'takeSeat', 'kick', 'transferHost', 'reveal', 'endTurn', 'next', 'vote', 'closeVote', 'special', 'playAgain',
  'endGame', 'ping'];
const JUNK = [null, true, false, 0, -1, 1.5, 5, 600, 601, 1e308, -1e308, '', ' ', 'x', 'A'.repeat(300), 'ABCD', 'abcd', 'p1', 'p2',
  '\u0000\u0007', '‮​', '<img src=x onerror=alert(1)>', [], [1, 2], {}, { a: 1 }, 'profession', 'choose', 'random', 'none',
  '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'NaN', '1e999', '../../etc/passwd'];

function randomString(rng, max = 30) {
  const n = Math.floor(rng() * max);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(rng() < 0.9 ? 32 + Math.floor(rng() * 95) : Math.floor(rng() * 0xffff));
  return s;
}

/** A random message; with a state, fields are often plausible (real ids, uids, categories). */
function randomMessage(rng, s, types = ALL_T) {
  const msg = { t: rng() < 0.93 ? pick(rng, types) : pick(rng, ['', 'bogus', 'CREATE', '__proto__', 'constructor', 'toString', 7, null]) };
  const ids = s ? [...s.players.map((p) => p.id), ...s.spectators.map((x) => x.id)] : [];
  const uids = s && s.me ? s.me.specials.map((x) => x.uid) : [];
  const plausible = rng() < 0.6;
  const junk = () => structuredClone(pick(rng, JUNK)); // never share (and later mutate) the corpus objects
  const val = (good) => (plausible && good !== undefined && rng() < 0.8 ? good : junk());
  if (rng() < 0.7) msg.name = rng() < 0.5 ? randomString(rng) : val('Fuzzy');
  if (rng() < 0.6) msg.room = val(s ? s.room : undefined);
  if (rng() < 0.3) msg.token = val(randomString(rng, 40));
  if (rng() < 0.3) msg.spectator = val(rng() < 0.5);
  if (rng() < 0.5) msg.targetId = val(pick(rng, ids));
  if (rng() < 0.4) msg.playerId = val(pick(rng, ids));
  if (rng() < 0.5) msg.category = val(pick(rng, [...CATS, 'choose', 'random']));
  if (rng() < 0.5) msg.uid = val(pick(rng, uids));
  if (rng() < 0.3) {
    if (rng() < 0.2) msg.options = junk();
    else {
      const o = {};
      for (const k of ['speechSeconds1', 'speechSeconds', 'discussionSeconds', 'defenseSeconds', 'maxPlayers', '__proto__', 'constructor']) {
        // own properties, as JSON.parse would create them (a plain assignment to __proto__ would set the prototype)
        if (rng() < 0.4) Object.defineProperty(o, k, { value: plausible ? Math.floor(rng() * 700) - 50 : junk(), enumerable: true, writable: true, configurable: true });
      }
      msg.options = o;
    }
  }
  if (rng() < 0.05) msg.extra = { deep: [[[[[{ x: 1 }]]]]] };
  return msg;
}

const RAW_CORPUS = [
  '', ' ', 'null', 'true', '0', '"t"', '[]', '[{"t":"ping"}]', '{', '}', '{"t":', '{"t":"ping"', '{"t":"ping"}}', 'undefined', 'NaN',
  '{"t":"join","room":"ABCD","name":"x","__proto__":{"polluted":1}}', '{"__proto__":{"polluted":1},"t":"create","name":"p"}',
  '{"constructor":{"prototype":{"polluted":1}},"t":"create","name":"c"}', '{"t":"create","name":"a","name":"b"}',
  '{"t":"create","name":"' + 'x'.repeat(5000) + '"}', '['.repeat(3900) + ']'.repeat(3900), '{"a":'.repeat(1300) + '1' + '}'.repeat(1300),
  '{"t":"ping"}\u0000', '﻿{"t":"ping"}', '{"t":"\\u0070ing"}', '{"t":"join","room":"\\u0000\\u0000\\u0000\\u0000","name":"z"}',
];

/** A raw socket that records every reply and checks each one's shape. */
function rawClient(url, problems, label) {
  const ws = new WebSocket(toWsUrl(url), { perMessageDeflate: false });
  const c = { ws, replies: [], closed: null, label };
  ws.on('message', (data) => {
    const text = data.toString();
    if (text.includes('polluted')) problems.push(`${label}: a reply mentions "polluted": ${text.slice(0, 200)}`);
    let m;
    try { m = JSON.parse(text); } catch { problems.push(`${label}: non-JSON reply ${text.slice(0, 100)}`); return; }
    c.replies.push(m);
    if (m.t === 'error' && (!ERROR_CODES.includes(m.code) || typeof m.message !== 'string' || !m.message)) problems.push(`${label}: malformed error ${text.slice(0, 200)}`);
    if (m.t === 'state' && m.you && m.you.role === 'spectator' && m.me !== null) problems.push(`${label}: spectator state with me`);
    if (!['error', 'pong', 'state', 'joined', 'kicked'].includes(m.t)) problems.push(`${label}: unknown reply type ${text.slice(0, 100)}`);
  });
  ws.on('close', (code) => { c.closed = code; });
  ws.on('error', () => {});
  c.open = () => new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return c;
}

async function expectOk(bot, msg) {
  assert.ok(bot.act(msg), 'socket open');
  const entry = bot.fifo[bot.fifo.length - 1];
  const before = bot.errors.length;
  await until(() => !bot.fifo.includes(entry), 3000, `pong for ${JSON.stringify(msg)}`);
  assert.equal(bot.errors.length, before, `${JSON.stringify(msg)} was rejected: ${JSON.stringify(bot.errors.slice(before))}`);
}

async function rawExpect(bot, text, codes) {
  const before = bot.received;
  const got = new Promise((resolve) => {
    const on = (m) => { if (m.t === 'error' || m.t === 'pong') { bot.off('message', on); resolve(m); } };
    bot.on('message', on);
  });
  bot.raw(text);
  const m = await Promise.race([got, sleep(3000).then(() => null)]);
  assert.ok(m && m.t === 'error', `no error reply to raw ${JSON.stringify(text).slice(0, 60)} (received ${bot.received - before})`);
  assert.ok(codes.includes(m.code), `raw ${JSON.stringify(text).slice(0, 60)} -> ${m.code}, expected ${codes.join('|')}`);
}

describe('protocol error codes over the wire (SPEC §7 precedence)', { concurrency: 1 }, () => {
  test('every rule answers with its documented code', { timeout: 60000 }, async () => {
    const server = await startServer({ seed: 5150, minPlayers: 2 });
    const bots = [];
    const mk = (name) => { const b = new Bot({ url: server.url, name, autoplay: false }); bots.push(b); return b; };
    try {
      const a = mk('Alice');
      await a.connect();
      await rawExpect(a, 'not json', ['bad_request']);
      await rawExpect(a, '{"t":"nope"}', ['bad_request']);
      await rawExpect(a, '{}', ['bad_request']);
      await rawExpect(a, '[]', ['bad_request']);
      await expectError(a, { t: 'start' }, ['not_in_room']);
      await expectError(a, { t: 'vote' }, ['bad_request']); // bad_request precedes not_in_room
      await expectError(a, { t: 'reveal', category: 'bogus' }, ['bad_request']);
      await expectError(a, { t: 'join', room: 'QQQQ', name: 'x' }, ['no_room']);
      await expectError(a, { t: 'join', name: 'x' }, ['bad_request']);
      await expectError(a, { t: 'join', room: 5, name: 'x' }, ['bad_request']);
      await expectError(a, { t: 'create', name: '    ' }, ['bad_request']);
      await expectError(a, { t: 'create', name: '\u0001\u0002\u007f' }, ['bad_request']);
      await expectError(a, { t: 'create' }, ['bad_request']);
      await expectError(a, { t: 'resume', room: 'QQQQ', token: 'abc' }, ['no_room']);
      const created = await a.create();
      const room = created.room;
      assert.match(room, /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
      assert.equal(created.state.you.isHost, true);
      assert.equal(created.state.phase, 'lobby');
      const probe = mk('Probe');
      await probe.connect();
      await expectError(probe, { t: 'resume', room, token: 'abc' }, ['bad_token']);
      await expectError(probe, { t: 'resume', room: room.toLowerCase(), token: 'x'.repeat(64) }, ['bad_token']);
      const b = mk('Bob');
      const jb = await b.join(room.toLowerCase());
      assert.equal(jb.state.you.role, 'player', 'room codes are case-insensitive');
      await expectError(b, { t: 'start' }, ['not_host']);
      await expectError(b, { t: 'setOptions', options: {} }, ['not_host']);
      await expectError(b, { t: 'takeSeat' }, ['not_allowed']);
      await expectError(a, { t: 'next' }, ['wrong_phase']);
      await expectError(a, { t: 'closeVote' }, ['wrong_phase']);
      await expectError(a, { t: 'playAgain' }, ['wrong_phase']);
      await expectError(a, { t: 'endGame' }, ['wrong_phase']); // §11 X6: no game to end in the lobby
      await expectError(b, { t: 'endGame' }, ['not_host']); // not_host wins over wrong_phase
      await expectError(a, { t: 'setOptions', options: { speechSeconds: 4 } }, ['bad_request']); // §11 I1
      await expectError(a, { t: 'setOptions', options: { speechSeconds: 601 } }, ['bad_request']); // §11 I1
      await expectError(a, { t: 'setOptions', options: { speechSeconds: 5.5 } }, ['bad_request']); // §11 I1
      await expectError(a, { t: 'setOptions', options: { speechSeconds: '30' } }, ['bad_request']);
      await expectError(a, { t: 'setOptions', options: 'fast' }, ['bad_request']);
      await expectOk(a, { t: 'setOptions', options: { speechSeconds: 600, defenseSeconds: 5 } });
      await a.waitFor((s) => s.options.speechSeconds === 600 && s.options.defenseSeconds === 5 && s.options.speechSeconds1 === 60, 2000, 'options applied, others kept');
      await expectError(a, { t: 'reveal', category: 'bogus' }, ['bad_request']);
      await expectError(a, { t: 'kick', playerId: a.id }, ['not_allowed']);
      await expectError(a, { t: 'transferHost', playerId: a.id }, ['not_allowed']);
      await expectError(a, { t: 'transferHost', playerId: 'zzz' }, ['not_allowed']);
      await expectError(a, { t: 'vote', targetId: b.id }, ['wrong_phase']);
      // names: trimmed, de-duplicated, truncated to 20
      const z1 = mk('  Zed  ');
      const r1 = await z1.join(room, { spectator: true });
      const z2 = mk('Zed');
      const r2 = await z2.join(room, { spectator: true });
      const z3 = mk('Zed');
      const r3 = await z3.join(room, { spectator: true });
      const names = (r) => r.state.spectators.find((x) => x.id === r.id).name;
      assert.deepEqual([names(r1), names(r2), names(r3)], ['Zed', 'Zed (2)', 'Zed (3)']);
      const long = mk('L'.repeat(40));
      const rl = await long.join(room, { spectator: true });
      assert.ok(names(rl).length <= 20 && names(rl).length >= 1, `name trimmed to 20 chars: ${names(rl)}`);
      // too few players: a lonely host
      const solo = mk('Solo');
      await solo.create();
      await expectError(solo, { t: 'start' }, ['not_allowed']);
      // the game
      await expectOk(a, { t: 'start' });
      const s1 = await a.waitFor((s) => s.phase === 'reveal', 2000, 'reveal');
      assert.equal(s1.turn.speakerId, a.id, 'seat 0 speaks first in round 1');
      await expectError(b, { t: 'reveal', category: 'profession' }, ['not_your_turn']);
      await expectError(b, { t: 'endTurn' }, ['not_your_turn']);
      await expectError(a, { t: 'reveal', category: 'health' }, ['not_allowed']);
      await expectError(a, { t: 'endTurn' }, ['not_allowed']);
      await expectError(a, { t: 'vote', targetId: b.id }, ['wrong_phase']);
      await expectError(a, { t: 'start' }, ['wrong_phase']);
      await expectError(a, { t: 'playAgain' }, ['wrong_phase']);
      await expectError(b, { t: 'endGame' }, ['not_host']); // §11 X6
      await expectError(z1, { t: 'endGame' }, ['not_host']); // a spectator
      await expectError(a, { t: 'special', uid: 'nope' }, ['not_allowed']);
      await expectError(a, { t: 'setOptions', options: { speechSeconds: 30 } }, ['wrong_phase']);
      await expectError(z1, { t: 'takeSeat' }, ['wrong_phase']);
      await expectOk(a, { t: 'reveal', category: 'profession' });
      await expectError(a, { t: 'reveal', category: 'health' }, ['not_allowed']);
      await expectOk(a, { t: 'endTurn' });
      await expectError(a, { t: 'endTurn' }, ['not_your_turn']);
      const late = mk('Late');
      const rlate = await late.join(room);
      assert.equal(rlate.state.you.role, 'spectator', 'joining a running game makes a spectator');
      assert.equal(rlate.state.me, null);
      // ping works with and without identity
      const pinger = mk('Pinger');
      await pinger.connect();
      await expectOk(pinger, { t: 'ping' });
      await assertServerHealthy(server);
    } finally {
      for (const b of bots) b.close();
      await server.stop();
    }
  });

  test('room_full (16 seats / 50 spectators) and server_busy (200 rooms)', { timeout: 60000 }, async () => {
    const server = await startServer({ seed: 5151 });
    const bots = [];
    const mk = (name) => { const b = new Bot({ url: server.url, name, autoplay: false }); bots.push(b); return b; };
    try {
      const host = mk('H');
      const { room } = await host.create();
      for (let i = 1; i < 16; i++) await mk(`P${i}`).join(room);
      const extra = mk('Seventeen');
      const re = await extra.join(room);
      assert.equal(re.state.you.role, 'spectator', 'the 17th joiner becomes a spectator');
      assert.equal(re.state.players.length, 16);
      await expectError(extra, { t: 'takeSeat' }, ['room_full']);
      for (let i = 1; i < 50; i++) await mk(`S${i}`).join(room, { spectator: true });
      const fiftyFirst = mk('S51');
      await fiftyFirst.connect();
      await expectError(fiftyFirst, { t: 'join', room, name: 'S51', spectator: true }, ['room_full']);
      // server_busy: rooms whose creator went away stay for the idle TTL (the per-network room cap is off under
      // BUNKER_NO_LIMITS), so 200 of them fill the server. (One socket re-creating no longer piles up rooms: its
      // previous lobby, where it was alone, is freed — see test/regressions-r1.test.js.)
      let busy = null;
      let created = 0;
      for (let i = 0; i < 205 && !busy; i++) {
        const creator = new Bot({ url: server.url, name: `C${i}`, autoplay: false });
        await creator.connect();
        creator.act({ t: 'create', name: `C${i}` });
        const entry = creator.fifo[creator.fifo.length - 1];
        await until(() => !creator.fifo.includes(entry), 3000, 'create reply');
        if (creator.errors.length) busy = creator.errors[creator.errors.length - 1];
        else created++;
        creator.close();
      }
      assert.ok(busy, 'creating rooms must stop at some point');
      assert.equal(busy.code, 'server_busy');
      assert.equal(created + 1, 200, 'server_busy exactly when 200 rooms exist (the host\'s room + the created ones)');
      await assertServerHealthy(server);
    } finally {
      for (const b of bots) b.close();
      await server.stop();
    }
  });
});

describe('hostile clients', () => {
  test('fuzzers next to real games: the server survives and both games still pass every invariant', { timeout: 90000 }, async (t) => {
    const server = await startServer({ seed: 31337 });
    const problems = [];
    const stats = { raw: 0, rawSockets: 0, closedByServer: 0, spectatorMsgs: 0, hostileMsgs: 0, oversizedClosed: 0 };
    try {
      // A: raw sockets (no identity) with malformed, binary, invalid-UTF-8 and oversized frames
      const rawFuzz = (async () => {
        const rng = makeRng('raw');
        for (let round = 0; round < 30; round++) {
          const c = rawClient(server.url, problems, `raw#${round}`);
          stats.rawSockets++;
          await c.open();
          for (let i = 0; i < 70 && c.ws.readyState === WebSocket.OPEN; i++) {
            const r = rng();
            if (r < 0.35) c.ws.send(pick(rng, RAW_CORPUS));
            else if (r < 0.85) c.ws.send(JSON.stringify(randomMessage(rng, null)));
            else if (r < 0.93) c.ws.send(Buffer.from(Array.from({ length: 1 + Math.floor(rng() * 64) }, () => Math.floor(rng() * 256))), { binary: true });
            else c.ws.send(randomString(rng, 200));
            stats.raw++;
            if (i % 10 === 0) await sleep(1);
          }
          if (round % 4 === 3) c.ws.send(Buffer.from([0xc3, 0x28, 0xa0, 0xa1]), { binary: false }); // invalid UTF-8 text frame
          await sleep(20);
          if (c.closed !== null) stats.closedByServer++;
          c.ws.terminate();
        }
        for (const size of [8 * 1024 + 1, 70000, 1 << 20]) {
          const c = rawClient(server.url, problems, `big${size}`);
          await c.open();
          c.ws.send(JSON.stringify({ t: 'create', name: 'x'.repeat(size) }));
          await until(() => c.closed !== null, 3000, `the server to close a socket after a ${size}-byte frame`).catch((e) => problems.push(e.message));
          if (c.closed !== null) stats.oversizedClosed++;
          c.ws.terminate();
        }
      })();

      // B: the victim game (N=6, specials) with a spectator in its room sending random and illegal actions all game long
      const victim = runTable(server, {
        n: 6, seed: 'victim', specials: 0.5, delay: 4, label: 'victim', timeoutMs: 60000,
        scenario: async (ctx) => {
          const mal = new Bot({ url: server.url, name: 'Mallory', autoplay: false });
          ctx.extras.push(mal);
          await mal.join(ctx.room, { spectator: true });
          const rng = makeRng('mallory');
          mal.on('message', (m) => {
            if (m.t === 'error' && !ERROR_CODES.includes(m.code)) problems.push(`Mallory: unknown code ${m.code}`);
            if (m.t === 'state' && m.room === ctx.room && m.me !== null) problems.push('Mallory (spectator) received me');
          });
          ctx.task((async () => {
            for (let i = 0; i < 4000; i++) {
              if (ctx.watcher.state && ctx.watcher.state.phase === 'final') break;
              if (!mal.connected) { await mal.connect(); mal.raw(JSON.stringify({ t: 'join', room: ctx.room, name: 'Mallory', spectator: true })); }
              // never 'create'/'resume'/'leave' here, so Mallory stays in the victim room most of the time
              const msg = randomMessage(rng, ctx.watcher.state, ALL_T.filter((x) => x !== 'create' && x !== 'resume' && x !== 'leave'));
              if (msg.t === 'join') { msg.room = ctx.room; msg.spectator = true; }
              mal.raw(JSON.stringify(msg));
              stats.spectatorMsgs++;
              if (i % 4 === 0) await sleep(1);
            }
          })());
        },
      });

      // C: a hostile *player* in a second game: plays its own turns (autoplay) and sends random in-game actions
      const hostileGame = runTable(server, {
        n: 5, seed: 'hostile-room', specials: 0.4, delay: 2, label: 'hostile-room', timeoutMs: 60000,
        scenario: async (ctx) => {
          const evil = ctx.bots[2];
          const rng = makeRng('evil');
          evil.hostile = true;
          evil.on('state', (s) => {
            if (s.phase === 'final' || s.phase === 'lobby') return;
            for (let k = 0; k < 5; k++) {
              evil.raw(JSON.stringify(randomMessage(rng, s, GAME_T)));
              stats.hostileMsgs++;
            }
          });
        },
      });

      const [rv, rh] = await Promise.all([victim, hostileGame, rawFuzz]);
      t.diagnostic(JSON.stringify(stats));
      t.diagnostic(`victim: ${JSON.stringify(rv.games)}; hostile room: ${JSON.stringify(rh.games)}`);
      assert.deepEqual(problems, []);
      assert.equal(rv.violations.length, 0, `victim game violations:\n${rv.violations.slice(0, 20).join('\n')}`);
      assert.ok(rv.games[0] && rv.games[0].done, 'the victim game reached the final');
      // the hostile player's own errors are expected; every other invariant must hold in its room
      const hv = rh.violations;
      assert.equal(hv.length, 0, `hostile room violations:\n${hv.slice(0, 20).join('\n')}`);
      assert.ok(rh.games[0] && rh.games[0].done, 'the hostile room reached the final');
      assert.equal(stats.oversizedClosed, 3, 'oversized frames close the socket (maxPayload 8 KB)');
      await assertServerHealthy(server);
    } finally {
      await server.stop();
    }
  });
});

describe('limits on (no BUNKER_NO_LIMITS)', () => {
  test('a flooding socket is throttled/closed, the per-IP cap holds, and other clients keep working', { timeout: 60000 }, async (t) => {
    const server = await startServer({ seed: 99, noLimits: false, minPlayers: 2 });
    const problems = [];
    const sockets = [];
    try {
      // flood: 300 pings at once
      const f = rawClient(server.url, problems, 'flood');
      sockets.push(f);
      await f.open();
      for (let i = 0; i < 300; i++) f.ws.send('{"t":"ping"}');
      await sleep(1500);
      const pongs = f.replies.filter((m) => m.t === 'pong').length;
      t.diagnostic(`flood: ${pongs} pongs for 300 pings, closed=${f.closed}`);
      assert.ok(pongs < 300, `the rate limiter should drop part of a 300-message burst (got ${pongs} pongs)`);
      assert.ok(f.closed !== null || pongs <= 60, 'more than 200 messages in 10 s should close the socket');
      // per-IP cap: 45 sockets from 127.0.0.1
      const many = [];
      for (let i = 0; i < 45; i++) {
        const c = rawClient(server.url, problems, `cap#${i}`);
        many.push(c);
        sockets.push(c);
        c.open().catch(() => {});
      }
      await sleep(800);
      const open = many.filter((c) => c.ws.readyState === WebSocket.OPEN && c.closed === null).length;
      t.diagnostic(`per-IP cap: ${open} of 45 sockets stayed open`);
      assert.ok(open <= 40, `at most 40 sockets per IP (had ${open})`);
      for (const c of many) c.ws.terminate();
      await sleep(200);
      // a normal client still works
      const ok = new Bot({ url: server.url, name: 'After', autoplay: false });
      const res = await ok.create();
      assert.equal(res.state.phase, 'lobby');
      ok.close();
      assert.deepEqual(problems, []);
      await assertServerHealthy(server);
    } finally {
      for (const c of sockets) c.ws.terminate();
      await server.stop();
    }
  });
});
