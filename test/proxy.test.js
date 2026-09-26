// SPEC §11 X2: behind a reverse proxy (BUNKER_TRUST_PROXY=1) every per-IP and per-network limit counts the client's
// address, which is the LAST X-Forwarded-For entry, and only when the TCP peer is loopback (the proxy on this host).
// Unit tests of the resolver, then the real server (in process, limits on) over real WebSockets from 127.0.0.1.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { configFromEnv, isLoopback, parseForwardedAddress, resolveClientIp, startServer } from '../server/index.js';
import { ipKey } from '../server/rooms.js';

describe('§11 X2 client address resolver', () => {
  test('loopback peers: 127.0.0.0/8, ::1 (any spelling), IPv4-mapped 127.x (dotted or hex); nothing else', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '127.255.255.255', '::1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001',
      '::ffff:127.0.0.1', '::FFFF:127.0.0.9', '0:0:0:0:0:ffff:127.0.0.1', '::ffff:7f00:1', ' 127.0.0.1 ']) {
      assert.equal(isLoopback(a), true, a);
    }
    for (const a of ['128.0.0.1', '10.0.0.1', '192.168.1.1', '::2', '::', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '2001:db8::1', 'fe80::1',
      '0.0.0.0', 'localhost', '127.0.0', '', null, undefined, 127001, '::ffff:127.0.0.1.5']) {
      assert.equal(isLoopback(a), false, String(a));
    }
  });

  test('one header entry: a bare IPv4/IPv6 address, also with a port or in brackets; IPv4-mapped becomes IPv4; garbage is null', () => {
    const cases = {
      '203.0.113.9': '203.0.113.9', ' 203.0.113.9 ': '203.0.113.9', '203.0.113.9:51234': '203.0.113.9',
      '2001:DB8::1': '2001:db8::1', '[2001:db8::1]': '2001:db8::1', '[2001:db8::1]:443': '2001:db8::1', '::ffff:198.51.100.7': '198.51.100.7',
      '': null, '   ': null, 'unknown': null, 'evil': null, '1.2.3': null, '1.2.3.4.5': null, '256.1.1.1': null, '::zz': null,
      '203.0.113.9:99999999': null, '[2001:db8::1': null, 'for=203.0.113.9': null, '"203.0.113.9"': null,
    };
    for (const [entry, want] of Object.entries(cases)) assert.equal(parseForwardedAddress(entry), want, JSON.stringify(entry));
    assert.equal(parseForwardedAddress(undefined), null);
    assert.equal(parseForwardedAddress('1'.repeat(200)), null);
  });

  test('flag on + loopback peer: the LAST entry wins; spoofed earlier entries are ignored', () => {
    assert.equal(resolveClientIp('127.0.0.1', '203.0.113.9', true), '203.0.113.9');
    // the client sent "X-Forwarded-For: 6.6.6.6, 7.7.7.7"; the proxy appended the address it saw
    assert.equal(resolveClientIp('127.0.0.1', '6.6.6.6, 7.7.7.7, 203.0.113.9', true), '203.0.113.9');
    assert.equal(resolveClientIp('127.0.0.1', '6.6.6.6,203.0.113.9', true), '203.0.113.9');
    // repeated headers: Node joins them with ", "; an array is accepted as well
    assert.equal(resolveClientIp('127.0.0.1', ['6.6.6.6', '203.0.113.9'], true), '203.0.113.9');
    assert.equal(resolveClientIp('::1', '2001:db8::7', true), '2001:db8::7');
    assert.equal(resolveClientIp('::ffff:127.0.0.1', '[2001:db8::7]:443', true), '2001:db8::7');
    assert.equal(resolveClientIp('::ffff:127.0.0.1', '::ffff:198.51.100.7', true), '198.51.100.7');
  });

  test('flag on + loopback peer, but the header is missing or its last entry is unparsable: the peer', () => {
    for (const xff of [undefined, null, '', '   ', 'garbage', '203.0.113.9, garbage', '203.0.113.9,', '203.0.113.9, ', [], 42]) {
      assert.equal(resolveClientIp('127.0.0.1', xff, true), '127.0.0.1', JSON.stringify(xff));
    }
    assert.equal(resolveClientIp('::1', 'nope', true), '::1');
    assert.equal(resolveClientIp(undefined, '203.0.113.9', true), 'unknown', 'no peer address at all');
  });

  test('flag on, but the peer is not loopback (a client reaching the port directly): the header is ignored', () => {
    for (const peer of ['198.51.100.2', '::ffff:198.51.100.2', '2001:db8::2', '10.0.0.1']) {
      assert.equal(resolveClientIp(peer, '127.0.0.1', true), peer);
      assert.equal(resolveClientIp(peer, '6.6.6.6, 203.0.113.9', true), peer);
    }
  });

  test('flag off (the default): X-Forwarded-For is ignored completely, even from loopback', () => {
    for (const xff of ['203.0.113.9', '6.6.6.6, 203.0.113.9', ['203.0.113.9']]) {
      assert.equal(resolveClientIp('127.0.0.1', xff, false), '127.0.0.1');
      assert.equal(resolveClientIp('::1', xff, undefined), '::1');
    }
  });

  test('BUNKER_TRUST_PROXY: "1" turns it on; anything else (or unset) leaves it off', () => {
    assert.equal(configFromEnv({}).trustProxy, false);
    assert.equal(configFromEnv({ BUNKER_TRUST_PROXY: '1' }).trustProxy, true);
    for (const v of ['0', '', 'true', 'yes', ' 1']) assert.equal(configFromEnv({ BUNKER_TRUST_PROXY: v }).trustProxy, false, JSON.stringify(v));
  });

  test('the resolved address feeds the same V1/V2 network key as a direct peer would', () => {
    assert.equal(ipKey(resolveClientIp('127.0.0.1', '6.6.6.6, 203.0.113.9', true)), '203.0.113.9');
    assert.equal(ipKey(resolveClientIp('127.0.0.1', '2001:db8:aa:bb:1::9', true)), '2001:db8:aa:bb::/64');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The real server, limits ON, every socket from 127.0.0.1

function open(port, xff) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, xff === undefined ? {} : { headers: { 'X-Forwarded-For': xff } });
    const c = { ws, msgs: [], status: null };
    ws.on('message', (d) => c.msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve(c));
    ws.on('unexpected-response', (_req, res) => { c.status = res.statusCode; resolve(c); });
    ws.on('error', () => resolve(c));
  });
}
async function reply(c, msg, pred = (m) => m.t !== 'state', ms = 3000) {
  const n = c.msgs.length;
  c.ws.send(JSON.stringify(msg));
  const t0 = Date.now();
  for (;;) {
    const m = c.msgs.slice(n).find(pred);
    if (m) return m;
    if (Date.now() - t0 > ms) throw new Error(`no reply to ${JSON.stringify(msg)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function withServer(trustProxy, fn) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', dev: false, noLimits: false, trustProxy, minPlayers: 2, seed: 'x2', hostGraceMs: 45000, logger: () => {} });
  const socks = [];
  const track = async (xff) => { const c = await open(srv.port, xff); socks.push(c.ws); return c; };
  try {
    await fn(srv, track);
  } finally {
    for (const ws of socks) ws.terminate();
    await srv.close();
  }
}

describe('§11 X2 over real sockets (limits on)', () => {
  test('the per-IP socket cap (40) counts the forwarded client, not the proxy; a spoofed first entry changes nothing', { timeout: 30000 }, async () => {
    await withServer(true, async (srv, track) => {
      const a = [];
      for (let i = 0; i < 40; i++) a.push(await track('203.0.113.1'));
      assert.ok(a.every((c) => c.status === null && c.ws.readyState === WebSocket.OPEN), '40 sockets for one client');
      assert.equal((await track('203.0.113.1')).status, 429, 'the 41st from the same client');
      assert.equal((await track('6.6.6.6, 203.0.113.1')).status, 429, 'a forged earlier entry does not help');
      const b = await track('203.0.113.2');
      assert.equal(b.status, null, 'another client behind the same proxy is not affected');
      assert.equal(b.ws.readyState, WebSocket.OPEN);
      const g = await track('garbage');
      assert.equal(g.status, null, 'an unparsable header counts as the proxy itself (127.0.0.1), which has room');
    });
  });

  test('flag off: the header is ignored, so every socket from 127.0.0.1 shares one cap', { timeout: 30000 }, async () => {
    await withServer(false, async (srv, track) => {
      for (let i = 0; i < 40; i++) assert.equal((await track(`203.0.113.${i + 1}`)).status, null);
      assert.equal((await track('198.51.100.99')).status, 429);
    });
  });

  test('V1 rooms per network and V2 failed lookups per network use the forwarded client too', { timeout: 30000 }, async () => {
    await withServer(true, async (srv, track) => {
      // V1: 5 live rooms per network
      for (let i = 0; i < 5; i++) {
        const c = await track('198.51.100.10');
        assert.equal((await reply(c, { t: 'create', name: `A${i}` })).t, 'joined');
      }
      const sixth = await track('9.9.9.9, 198.51.100.10');
      const e = await reply(sixth, { t: 'create', name: 'A5' });
      assert.deepEqual([e.t, e.code], ['error', 'server_busy']);
      assert.match(e.message, /Too many rooms are open from your network/);
      const other = await track('198.51.100.11');
      assert.equal((await reply(other, { t: 'create', name: 'B0' })).t, 'joined', 'another client behind the proxy may create');
      // V2: 20 failed lookups per network
      const scanner = await track('198.51.100.20');
      const paced = async (c, msg) => { await new Promise((r) => setTimeout(r, 60)); return reply(c, msg); }; // under 20 msg/s per socket
      for (let i = 0; i < 20; i++) assert.equal((await paced(scanner, { t: 'join', room: 'ZZZZ', name: 'S' })).code, 'no_room');
      assert.equal((await paced(scanner, { t: 'join', room: 'ZZZZ', name: 'S' })).code, 'server_busy');
      const same = await track('1.1.1.1, 198.51.100.20');
      assert.equal((await reply(same, { t: 'join', room: 'ZZZZ', name: 'S' })).code, 'server_busy', 'same client, new socket, forged prefix');
      const fresh = await track('198.51.100.21');
      assert.equal((await reply(fresh, { t: 'join', room: 'ZZZZ', name: 'S' })).code, 'no_room', 'another client keeps its budget');
      assert.equal([...srv.rooms.rooms.values()].filter((r) => r.ipKey === '198.51.100.10').length, 5);
    });
  });
});
