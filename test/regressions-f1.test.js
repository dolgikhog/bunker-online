// Regression tests for the f1 review findings fixed on the server side (reports/fix-server-fixer-f1.md, SPEC §11 X5):
//   - a 🚪 in a player's name made clients read that player's log lines as airlock lines: names never contain U+1F6AA
//   - names were cut mid-grapheme (5 family emoji became two families plus a different, partial one)
//   - §11 Y1 log order: an airlock target who is the host leaves → the jammed line came after "… is now the host"
//   - every add-feature card logged "a hidden room was found" (Supply Drop: "a crate crashes down")
//   - IPv6 clients (behind the proxy) escaped the per-client limits: the socket cap was per /128, V1/V2 per /64 only
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createGame, EFFECTS, sanitizeName, NAME_MAX } from '../server/game.js';
import {
  Rooms, ipKey, siteKey, SITE_FACTOR, MAX_ROOMS_PER_IP, MAX_ROOMS_PER_SITE, JOIN_FAIL_BURST, JOIN_FAIL_SITE_BURST, JOIN_FAIL_REFILL_MS,
} from '../server/rooms.js';
import { AIRLOCK_CARD, createDealer } from '../server/content.js';
import { mulberry32 } from '../server/rng.js';
import { startServer, MAX_SOCKETS_PER_IP, MAX_SOCKETS_PER_SITE, socketBuckets } from '../server/index.js';

// ------------------------------------------------------------------------------------------------ engine helpers
const FILLER = { id: 'filler', title: 'Blueprint', text: 'Adds a bunker feature.', effect: 'bunker_add_feature', target: 'none' };
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
function ok(res) { assert.deepEqual(res, { ok: true }, JSON.stringify(res)); }
const P = (g, id) => g.players.find((p) => p.id === id);
const play = (g, id, effect, extra = {}) => g.handle(id, { t: 'special', uid: P(g, id).specials.find((s) => s.effect === effect && !s.used).uid, ...extra });
/** Next through the game; every ballot ejects its first candidate (a unanimous vote), until pred(g). */
function advance(g, pred) {
  for (let i = 0; i < 3000 && !pred(g); i++) {
    if (g.phase === 'final') break;
    if (g.phase === 'vote') {
      const target = g.vote.candidates[0];
      for (const v of [...g.vote.voters]) if (g.phase === 'vote' && v !== target) g.handle(v, { t: 'vote', targetId: target });
      if (g.phase === 'vote') ok(g.handle(g.hostId, { t: 'closeVote' }));
    } else ok(g.handle(g.hostId, { t: 'next' }));
  }
  assert.ok(pred(g), 'advance did not reach its point');
}
// The three §11 X1 lines, the only ones that may carry the door emoji.
const X1_LINES = [
  /^🚪 .+ started cycling the airlock on .+\. If one more Airlock card is played on .+ before (?:this round's|the overtime) discussion ends, .+ is out — no vote\.$/u,
  /^🚪 .+ sealed the airlock with .+ — .+ is thrown out of the bunker, no vote!$/u,
  /^🚪 The airlock on .+ jammed — nobody closed it\.$/u,
];

// ------------------------------------------------------------------------------------------------ names
describe('names (SPEC §11 X5)', () => {
  test('the door emoji is removed from names, with its variation selector; a name of doors only is rejected', () => {
    assert.equal(sanitizeName('🚪Rex'), 'Rex');
    assert.equal(sanitizeName('🚪️ Door'), 'Door');
    assert.equal(sanitizeName('Rex 🚪 Door'), 'Rex Door');
    assert.equal(sanitizeName('E🚪ve'), 'Eve');
    assert.equal(sanitizeName('🚪‍🔥 Fire'), '🔥 Fire', 'no joiner is left dangling');
    assert.equal(sanitizeName('🚪🚪🚪'), '');
    assert.equal(sanitizeName('❤️ Kate'), '❤️ Kate', 'other emoji stay');
    const g = createGame({ room: 'T', rng: mulberry32(1), now: () => 1, minPlayers: 2 });
    const bad = g.join('🚪 🚪');
    assert.deepEqual([bad.ok, bad.code], [false, 'bad_request']);
    const rex = g.join('🚪Rex');
    assert.equal(P(g, rex.id).name, 'Rex');
    const spec = g.join('🚪 Watcher', { spectator: true });
    assert.equal(g.spectators.find((s) => s.id === spec.id).name, 'Watcher');
    const rooms = new Rooms({ rng: mulberry32(2), minPlayers: 2, now: () => 1 });
    const out = [];
    const c = { ip: '203.0.113.1', send: (m) => out.push(m) };
    rooms.open(c);
    rooms.message(c, JSON.stringify({ t: 'create', name: '🚪' }));
    assert.deepEqual([out[0].t, out[0].code], ['error', 'bad_request']);
  });

  test('whatever the names, no log line but the airlock\'s own carries 🚪 (a real game: seal, jam, leave, vote-outs)', () => {
    const clock = { t: 1_800_000_000_000 };
    const g = createGame({ room: 'T', rng: mulberry32(5), now: () => clock.t++, minPlayers: 2 }); // real content, the X1 fixed deal
    const names = ['🚪Ann', 'Bob 🚪', '🚪️Cid', 'Dan', 'E🚪ve', 'Fay', 'G🚪🚪us', 'Hal'];
    const ids = names.map((n) => g.join(n).id);
    assert.deepEqual(g.players.map((p) => p.name), ['Ann', 'Bob', 'Cid', 'Dan', 'Eve', 'Fay', 'Gus', 'Hal']);
    ok(g.handle(ids[0], { t: 'start' }));
    const holders = g.players.filter((p) => p.specials.some((s) => s.effect === 'airlock')).map((p) => p.id);
    assert.equal(holders.length, 3, 'N=8: three Airlocks');
    advance(g, (x) => x.round === 2 && x.phase === 'reveal');
    const victim = ids.find((id) => !holders.includes(id) && id !== g.hostId);
    ok(play(g, holders[0], 'airlock', { targetId: victim }));
    ok(play(g, holders[1], 'airlock', { targetId: victim }));
    assert.equal(P(g, victim).status, 'ejected');
    const lonely = ids.find((id) => id !== victim && id !== holders[2] && P(g, id).status === 'alive' && id !== g.hostId);
    ok(play(g, holders[2], 'airlock', { targetId: lonely }));
    ok(g.handle(lonely, { t: 'leave' }));
    advance(g, (x) => x.phase === 'final');
    const doors = g.log.filter((e) => e.text.includes('🚪'));
    assert.ok(doors.length >= 3, 'the game logged its airlock lines');
    for (const e of doors) assert.ok(X1_LINES.some((re) => re.test(e.text)), `a 🚪 outside the X1 lines: ${e.text}`);
    assert.ok(g.log.some((e) => e.kind === 'eject' && X1_LINES[1].test(e.text)), 'the seal');
    assert.ok(g.log.some((e) => X1_LINES[2].test(e.text)), 'the jam');
  });

  test(`names are cut between graphemes, at most ${NAME_MAX} code points`, () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'; // 7 code points, one glyph
    assert.equal(sanitizeName(family.repeat(5)), family.repeat(2), 'two whole families, not two and a partial one');
    assert.equal(sanitizeName(`ab${family.repeat(3)}`), `ab${family.repeat(2)}`);
    const thumb = '👍🏽'; // 2 code points
    assert.equal(sanitizeName(thumb.repeat(12)), thumb.repeat(10));
    const flag = '🇺🇦'; // 2 regional indicators
    assert.equal(sanitizeName(`x${flag.repeat(10)}`), `x${flag.repeat(9)}`, 'no lone regional indicator (a different flag letter) at the end');
    assert.equal(sanitizeName('a'.repeat(25)), 'a'.repeat(20));
    assert.equal(sanitizeName('Иван Иванович Иванов-Длинный'), 'Иван Иванович Иванов');
    const zalgo = `Z${'̶'.repeat(30)}`; // one grapheme longer than the limit: cut by code points, as before
    assert.equal(Array.from(sanitizeName(zalgo)).length, NAME_MAX);
    assert.ok(sanitizeName(zalgo).startsWith('Z'));
    for (const raw of [family.repeat(5), thumb.repeat(12), `x${flag.repeat(10)}`, zalgo]) assert.ok(Array.from(sanitizeName(raw)).length <= NAME_MAX);
  });
});

// ------------------------------------------------------------------------------------------------ log lines
describe('log lines (SPEC §11 Y1, X5)', () => {
  function started(n, specials) {
    const clock = { t: 1_800_000_000_000 };
    const g = createGame({ room: 'T', rng: mulberry32(7), now: () => clock.t++, minPlayers: 2, dealer: handDealer(specials), fixedSpecials: false });
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`).id);
    ok(g.handle(ids[0], { t: 'start' }));
    return { g, ids };
  }

  test('Y1: the host is the airlock\'s target and leaves: the jammed line comes right after "left the game", then the new host', () => {
    const { g, ids } = started(6, { 1: [AIRLOCK_CARD, FILLER] });
    advance(g, (x) => x.round === 2 && x.phase === 'reveal');
    ok(play(g, ids[1], 'airlock', { targetId: ids[0] }));
    const from = g.log.at(-1).id;
    ok(g.handle(ids[0], { t: 'leave' }));
    assert.deepEqual(g.log.filter((e) => e.id > from).map((e) => e.text),
      ['P0 left the game', '🚪 The airlock on P0 jammed — nobody closed it.', 'P1 is now the host']);
    assert.deepEqual(g.view(ids[1]).airlocks, []);
  });

  test('Y1: the host kicks the target; a target (and host) whose leave ends the game still jams after the door line', () => {
    {
      const { g, ids } = started(6, { 2: [AIRLOCK_CARD, FILLER] });
      advance(g, (x) => x.round === 2 && x.phase === 'discussion');
      ok(play(g, ids[2], 'airlock', { targetId: ids[3] }));
      ok(g.handle(ids[0], { t: 'kick', playerId: ids[3] }));
      assert.deepEqual(g.log.slice(-2).map((e) => e.text), ['P3 was removed by the host', '🚪 The airlock on P3 jammed — nobody closed it.']);
    }
    {
      const { g, ids } = started(4, { 1: [AIRLOCK_CARD, FILLER] });
      advance(g, (x) => x.round === 2 && x.phase === 'reveal');
      ok(g.handle(ids[3], { t: 'leave' }));
      ok(play(g, ids[1], 'airlock', { targetId: ids[0] }));
      const from = g.log.at(-1).id;
      ok(g.handle(ids[0], { t: 'leave' }));
      assert.equal(g.phase, 'final');
      const lines = g.log.filter((e) => e.id > from).map((e) => e.text);
      assert.equal(lines[0], 'P0 left the game');
      assert.equal(lines[1], 'P1 is now the host');
      assert.match(lines[2], /^The bunker door closes/);
      assert.equal(lines[3], '🚪 The airlock on P0 jammed — nobody closed it.');
      assert.equal(lines.length, 4);
    }
  });

  test('an add-feature card says "the bunker gains a new feature", whichever card it is (no "hidden room" for a Supply Drop)', () => {
    const d = createDealer(mulberry32(3));
    const pool = Array.from({ length: 52 }, () => d.drawSpecial()).filter((c) => c.effect === 'bunker_add_feature');
    assert.ok(pool.some((c) => /Supply Drop/.test(c.title)), 'the real pool has a Supply Drop');
    for (const card of pool) {
      const { g, ids } = started(4, { 1: [card, FILLER] });
      ok(play(g, ids[1], 'bunker_add_feature'));
      const line = g.log.at(-1).text;
      assert.match(line, /→ the bunker gains a new feature: “<feature#\d+>”$/, line);
      assert.doesNotMatch(line, /hidden room/);
    }
  });
});

// ------------------------------------------------------------------------------------------------ IPv6 networks
describe('IPv6 clients: every per-network limit also counts the /48 (SPEC §11 X5)', () => {
  test('ipKey / siteKey: IPv4 in any spelling is one IPv4 bucket with no site; IPv6 is its /64 inside its /48', () => {
    for (const a of ['203.0.113.50', '::ffff:203.0.113.50', '::ffff:cb00:7132', '0:0:0:0:0:ffff:203.0.113.50', '0:0:0:0:0:FFFF:CB00:7132']) {
      assert.equal(ipKey(a), '203.0.113.50', a);
      assert.equal(siteKey(a), null, a);
    }
    assert.equal(ipKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
    assert.equal(ipKey('2001:0DB8:0001:0002:ffff::9%eth0'), '2001:db8:1:2::/64');
    assert.equal(siteKey('2001:db8:1:2::1'), '2001:db8:1::/48');
    assert.equal(siteKey('2001:db8:1:ffff:1:2:3:4'), '2001:db8:1::/48');
    assert.notEqual(siteKey('2001:db8:1::1'), siteKey('2001:db8:2::1'));
    assert.equal(ipKey('1::2:3:4:5:1.2.3.4'), '1:0:2:3::/64', 'an embedded dotted IPv4 counts as two groups');
    assert.equal(ipKey(null), null);
    assert.equal(siteKey(undefined), null);
    assert.equal(ipKey('garbage:x'), 'garbage:x', 'an unparsable address is still a bucket of its own, never exempt');
    assert.deepEqual(socketBuckets('2001:db8:1:2::5'), [['2001:db8:1:2::/64', MAX_SOCKETS_PER_IP], ['2001:db8:1::/48', MAX_SOCKETS_PER_SITE]]);
    assert.deepEqual(socketBuckets('::ffff:10.0.0.1'), [['10.0.0.1', MAX_SOCKETS_PER_IP]]);
    assert.equal(MAX_SOCKETS_PER_SITE, SITE_FACTOR * MAX_SOCKETS_PER_IP);
  });

  function registry(extra = {}) {
    const clock = { t: 5_000_000 };
    const rooms = new Rooms({ rng: mulberry32(99), minPlayers: 2, hostGraceMs: 45_000, now: () => clock.t, ...extra });
    const conn = (ip) => {
      const c = { ip, out: [], send(obj) { c.out.push(JSON.parse(JSON.stringify(obj))); } };
      c.last = () => c.out.at(-1);
      rooms.open(c);
      return c;
    };
    const send = (c, msg) => rooms.message(c, JSON.stringify(msg));
    return { rooms, clock, conn, send };
  }

  test(`V2: a /48 gets ${JOIN_FAIL_SITE_BURST} failed lookups in all, however many /64s it uses, then one per refill; its /64s keep their own ${JOIN_FAIL_BURST}`, () => {
    const { rooms, clock, conn, send } = registry();
    const host = conn('198.51.100.9');
    send(host, { t: 'create', name: 'Host' });
    const { room } = host.out[0];
    const one = conn('2001:db8:5:0::1');
    for (let i = 0; i < JOIN_FAIL_BURST; i++) { send(one, { t: 'join', room: 'ZZZZ', name: 'x' }); assert.equal(one.last().code, 'no_room'); }
    send(one, { t: 'join', room: 'ZZZZ', name: 'x' });
    assert.equal(one.last().code, 'server_busy', 'one /64 still stops at its own burst');
    let n = JOIN_FAIL_BURST;
    for (let k = 1; n < JOIN_FAIL_SITE_BURST; k++) {
      const c = conn(`2001:db8:5:${k.toString(16)}::${k}`);
      for (let i = 0; i < JOIN_FAIL_BURST && n < JOIN_FAIL_SITE_BURST; i++, n++) { send(c, { t: 'join', room: 'ZZZZ', name: 'x' }); assert.equal(c.last().code, 'no_room'); }
    }
    const next64 = conn('2001:db8:5:ffff::1'); // a fresh /64 of the same /48
    send(next64, { t: 'join', room, name: 'x' });
    assert.equal(next64.last().code, 'server_busy', 'the /48 is out, whatever /64 asks');
    assert.match(next64.last().message, /Too many wrong room codes/);
    send(next64, { t: 'resume', room, token: 'nope' });
    assert.equal(next64.last().code, 'server_busy');
    const otherSite = conn('2001:db8:6:0::1');
    send(otherSite, { t: 'join', room: 'ZZZZ', name: 'x' });
    assert.equal(otherSite.last().code, 'no_room', 'another /48 is unaffected');
    const v4 = conn('192.0.2.1');
    send(v4, { t: 'join', room, name: 'Friend' });
    assert.equal(v4.out[0].t, 'joined');
    clock.t += JOIN_FAIL_REFILL_MS;
    send(next64, { t: 'join', room, name: 'Late' });
    assert.equal(next64.out.at(-2).t, 'joined', 'one lookup per refill interval, as for a /64');
    clock.t += JOIN_FAIL_SITE_BURST * JOIN_FAIL_REFILL_MS;
    rooms.sweep();
    assert.equal(rooms.lookupBudget.size, 0, 'full budgets are forgotten');
    const free = registry({ joinFailBurst: Infinity }); // BUNKER_NO_LIMITS
    for (let k = 0; k < 10; k++) {
      const c = free.conn(`2001:db8:7:${k}::1`);
      for (let i = 0; i < 30; i++) free.send(c, { t: 'join', room: 'ZZZZ', name: 'x' });
      assert.equal(c.last().code, 'no_room');
    }
  });

  test(`V1: a /48 holds at most ${MAX_ROOMS_PER_SITE} rooms; at the cap its oldest abandoned lone lobby makes room`, () => {
    const { rooms, conn, send } = registry();
    const hosts = [];
    for (let k = 0; k < MAX_ROOMS_PER_SITE / MAX_ROOMS_PER_IP; k++) {
      for (let i = 0; i < MAX_ROOMS_PER_IP; i++) {
        const c = conn(`2001:db8:9:${k}::${i + 1}`);
        send(c, { t: 'create', name: `H${k}${i}` });
        assert.equal(c.last().t, 'state');
        hosts.push(c);
      }
    }
    assert.equal(rooms.rooms.size, MAX_ROOMS_PER_SITE);
    const late = conn('2001:db8:9:ff::1');
    send(late, { t: 'create', name: 'Late' });
    assert.deepEqual([late.last().t, late.last().code], ['error', 'server_busy']);
    assert.match(late.last().message, /Too many rooms are open from your network/);
    const other = conn('2001:db8:a:0::1');
    send(other, { t: 'create', name: 'Other' });
    assert.equal(other.last().t, 'state', 'another /48 may create');
    const gone = hosts[7];
    const goneCode = gone.out.find((m) => m.t === 'joined').room;
    rooms.close(gone); // its lone lobby is now abandoned
    send(late, { t: 'create', name: 'Late' });
    assert.equal(late.last().t, 'state', 'the abandoned lobby of the /48 made room');
    assert.equal(rooms.rooms.has(goneCode), false);
    assert.equal([...rooms.rooms.values()].filter((r) => r.siteKey === '2001:db8:9::/48').length, MAX_ROOMS_PER_SITE);
    const free = registry({ maxRoomsPerIp: Infinity }); // BUNKER_NO_LIMITS lifts the /48 cap too
    for (let k = 0; k < 8; k++) {
      for (let i = 0; i < 5; i++) {
        const c = free.conn(`2001:db8:9:${k}::${i + 1}`);
        free.send(c, { t: 'create', name: 'H' });
        assert.equal(c.last().t, 'state');
      }
    }
  });

  test(`real sockets, proxy on: ${MAX_SOCKETS_PER_IP} per /64 whatever the host part, ${MAX_SOCKETS_PER_SITE} per /48; V2 across the /64s of one /48`, { timeout: 60000 }, async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', noLimits: false, trustProxy: true, minPlayers: 2, seed: 'x5', hostGraceMs: 45000, logger: () => {} });
    const socks = [];
    const open = (xff) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { 'X-Forwarded-For': xff } });
      const c = { ws, msgs: [], status: null };
      socks.push(ws);
      ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
      ws.on('open', () => resolve(c));
      ws.on('unexpected-response', (_q, res) => { c.status = res.statusCode; resolve(c); });
      ws.on('error', () => resolve(c));
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
    const isOpen = (c) => c.status === null && c.ws.readyState === WebSocket.OPEN;
    try {
      const first = [];
      for (let i = 0; i < MAX_SOCKETS_PER_IP; i++) first.push(await open(`2001:db8:1:2::${(i + 1).toString(16)}`));
      assert.ok(first.every(isOpen), `${MAX_SOCKETS_PER_IP} sockets from one /64`);
      assert.equal((await open('2001:db8:1:2:ffff:ffff:ffff:ffff')).status, 429, 'a new host part of the same /64 is no way around the cap');
      for (let k = 3; k < 2 + SITE_FACTOR; k++) {
        for (let i = 0; i < MAX_SOCKETS_PER_IP; i++) assert.ok(isOpen(await open(`2001:db8:1:${k}::${(i + 1).toString(16)}`)), `/64 #${k} socket ${i}`);
      }
      assert.equal((await open('2001:db8:1:99::1')).status, 429, `a fresh /64 of a /48 that has ${MAX_SOCKETS_PER_SITE} sockets`);
      const elsewhere = await open('2001:db8:2:1::1');
      assert.ok(isOpen(elsewhere), 'another /48 is unaffected');
      assert.ok(isOpen(await open('203.0.113.9')), 'IPv4 is unaffected');
      first[0].ws.close();
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(isOpen(await open('2001:db8:1:99::1')), 'a closed socket gives its place back in both buckets');
      for (const ws of socks.splice(0)) ws.terminate();
      await new Promise((r) => setTimeout(r, 200));
      // V2: SITE_FACTOR /64s of one /48 spend its budget together (one socket each, paced under 20 msg/s)
      const scanners = [];
      for (let k = 0; k < SITE_FACTOR; k++) scanners.push(await open(`2001:db8:3:${k}::1`));
      const per = JOIN_FAIL_SITE_BURST / SITE_FACTOR;
      const codes = await Promise.all(scanners.map(async (c) => {
        const got = [];
        for (let i = 0; i < per; i++) { await new Promise((r) => setTimeout(r, 60)); got.push((await reply(c, { t: 'join', room: 'ZZZZ', name: 'S' })).code); }
        return got;
      }));
      assert.ok(codes.flat().every((x) => x === 'no_room'), codes.flat().join(','));
      const fresh64 = await open('2001:db8:3:77::1');
      assert.equal((await reply(fresh64, { t: 'join', room: 'ZZZZ', name: 'S' })).code, 'server_busy', 'a fresh /64 of that /48');
      const otherSite = await open('2001:db8:4:0::1');
      assert.equal((await reply(otherSite, { t: 'join', room: 'ZZZZ', name: 'S' })).code, 'no_room', 'another /48');
    } finally {
      for (const ws of socks) ws.terminate();
      await srv.close();
    }
  });
});
