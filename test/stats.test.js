// SPEC §11 X8: GET /stats answers {rooms, activeGames, sockets} only to a request made on the server itself (a loopback
// TCP peer and no X-Forwarded-For); everyone else, every request through the proxy included, gets the static 404.
//   - statsAllowed() over peers and headers;
//   - the real server (in process, limits on): direct loopback 200 (GET and HEAD, IPv4 and IPv6 loopback), the counts
//     through a game's life (lobby 0, running 1, End game 0, final 0), the 404 for X-Forwarded-For (even empty) and its
//     relatives being byte-identical to a missing file's, 404 through a Caddy-like proxy, 404 from a non-loopback
//     address of this machine, and the static 405 for other methods.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import WebSocket from 'ws';
import { startServer, statsAllowed } from '../server/index.js';

describe('§11 X8 statsAllowed', () => {
  test('loopback peers without forwarding headers only', () => {
    for (const peer of ['127.0.0.1', '127.3.2.1', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) {
      assert.equal(statsAllowed(peer, {}), true, peer);
      assert.equal(statsAllowed(peer, { host: '127.0.0.1:8080', 'user-agent': 'curl/8', accept: '*/*' }), true, peer);
      assert.equal(statsAllowed(peer, undefined), true, `${peer}, no header object`);
    }
    for (const peer of ['192.168.0.10', '10.0.0.1', '203.0.113.9', '::ffff:10.0.0.1', '2001:db8::1', 'fe80::1', '0.0.0.0', '', null, undefined]) {
      assert.equal(statsAllowed(peer, {}), false, String(peer));
    }
  });

  test('any forwarding header, even empty, means "through a proxy"', () => {
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto']) {
      for (const v of ['203.0.113.9', '127.0.0.1', '', ['a', 'b']]) assert.equal(statsAllowed('127.0.0.1', { [h]: v }), false, `${h}: ${JSON.stringify(v)}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** A raw HTTP request (so headers such as an empty X-Forwarded-For go out exactly as given). */
function get(port, path = '/stats', { host = '127.0.0.1', headers = {}, method = 'GET', localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method, headers, localAddress, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const without = (h, ...keys) => Object.fromEntries(Object.entries(h).filter(([k]) => !['date', ...keys].includes(k)));

/** A reverse proxy in front of the game that sets the headers Caddy's reverse_proxy sets. */
async function caddyLikeProxy(targetPort) {
  const proxy = http.createServer((req, res) => {
    const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress.replace(/^::ffff:/, ''), 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host };
    const up = http.request({ host: '127.0.0.1', port: targetPort, path: req.url, method: req.method, headers, agent: false }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  return { port: proxy.address().port, close: () => new Promise((r) => proxy.close(r)) };
}

function openWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = { ws, msgs: [] };
    ws.on('message', (d) => c.msgs.push(JSON.parse(String(d))));
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
async function send(c, msg, pred) {
  const n = c.msgs.length;
  c.ws.send(JSON.stringify(msg));
  c.ws.send('{"t":"ping"}');
  const t0 = Date.now();
  for (;;) {
    const i = c.msgs.slice(n).findIndex((m) => m.t === 'pong');
    if (i >= 0) {
      const got = c.msgs.slice(n, n + i);
      if (pred) assert.ok(got.some(pred), `no matching reply to ${JSON.stringify(msg)}: ${JSON.stringify(got)}`);
      return got;
    }
    if (Date.now() - t0 > 3000) throw new Error(`no pong after ${JSON.stringify(msg)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function withServer(opts, fn) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', dev: false, noLimits: false, minPlayers: 2, seed: 'x8', logger: () => {}, ...opts });
  try { await fn(srv); } finally { await srv.close(); }
}

describe('§11 X8 GET /stats on the real server', () => {
  test('direct from 127.0.0.1: JSON with exactly rooms, activeGames and sockets; HEAD too; query strings do not matter', async () => {
    await withServer({}, async (srv) => {
      const r = await get(srv.port);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.deepEqual(JSON.parse(r.body), { rooms: 0, activeGames: 0, sockets: 0 });
      assert.deepEqual(Object.keys(JSON.parse(r.body)), ['rooms', 'activeGames', 'sockets']);
      const h = await get(srv.port, '/stats', { method: 'HEAD' });
      assert.equal(h.status, 200);
      assert.equal(h.body, '');
      assert.equal((await get(srv.port, '/stats?x=1')).status, 200);
      // what deploy/deploy.sh does with it: python3 -c 'json.load(sys.stdin)["activeGames"]'
      assert.equal(JSON.parse(r.body).activeGames, 0);
    });
  });

  test('the counts follow the rooms: a lobby is not active, a running game is, End game and the final make it inactive again', async () => {
    await withServer({}, async (srv) => {
      const stats = async () => JSON.parse((await get(srv.port)).body);
      const idle = await openWs(srv.port); // an open socket that never joins: a socket, but no room
      const a = await openWs(srv.port);
      const b = await openWs(srv.port);
      const c = await openWs(srv.port);
      try {
        const joined = (await send(a, { t: 'create', name: 'A' }, (m) => m.t === 'joined')).find((m) => m.t === 'joined');
        await send(b, { t: 'join', room: joined.room, name: 'B' }, (m) => m.t === 'joined');
        await send(c, { t: 'create', name: 'C' }, (m) => m.t === 'joined');
        assert.deepEqual(await stats(), { rooms: 2, activeGames: 0, sockets: 4 });
        await send(a, { t: 'start' }, (m) => m.t === 'state' && m.phase === 'reveal');
        assert.deepEqual(await stats(), { rooms: 2, activeGames: 1, sockets: 4 });
        await send(a, { t: 'endGame' }, (m) => m.t === 'state' && m.phase === 'lobby');
        assert.deepEqual(await stats(), { rooms: 2, activeGames: 0, sockets: 4 });
        await send(a, { t: 'start' }, (m) => m.t === 'state' && m.phase === 'reveal');
        assert.equal((await stats()).activeGames, 1);
        await send(b, { t: 'leave' }); // 1 alive <= 1 bed: the final
        assert.equal(a.msgs.filter((m) => m.t === 'state').pop().phase, 'final');
        assert.deepEqual(await stats(), { rooms: 2, activeGames: 0, sockets: 4 }, 'a final is not an active game; the left socket is still open');
        idle.ws.close();
        await new Promise((r) => setTimeout(r, 100));
        assert.equal((await stats()).sockets, 3);
      } finally {
        for (const x of [idle, a, b, c]) x.ws.terminate();
      }
    });
  });

  test('X-Forwarded-For (even empty) or another forwarding header: the same 404 as a missing file', async () => {
    await withServer({}, async (srv) => {
      const missing = await get(srv.port, '/no-such-file');
      assert.equal(missing.status, 404);
      const variants = [
        { 'X-Forwarded-For': '203.0.113.9' }, { 'X-Forwarded-For': '127.0.0.1' }, { 'X-Forwarded-For': '' },
        { Forwarded: 'for=127.0.0.1' }, { 'X-Real-IP': '127.0.0.1' }, { 'X-Forwarded-Proto': 'https' }, { 'X-Forwarded-Host': 'x' },
      ];
      for (const headers of variants) {
        const r = await get(srv.port, '/stats', { headers });
        assert.equal(r.status, 404, JSON.stringify(headers));
        assert.equal(r.body, missing.body);
        assert.deepEqual(without(r.headers), without(missing.headers), `headers for ${JSON.stringify(headers)}`);
      }
      // other methods: the static server's 405, as for any path
      assert.equal((await get(srv.port, '/stats', { method: 'POST' })).status, 405);
      assert.equal((await get(srv.port, '/stats/')).status, 404);
    });
  });

  test('through a reverse proxy that adds X-Forwarded-For as Caddy does: 404, while /healthz goes through', async () => {
    for (const trustProxy of [true, false]) {
      await withServer({ trustProxy }, async (srv) => {
        const proxy = await caddyLikeProxy(srv.port);
        try {
          const r = await get(proxy.port, '/stats');
          assert.equal(r.status, 404, `trustProxy=${trustProxy}`);
          assert.equal(r.body, 'Not found');
          assert.equal((await get(proxy.port, '/healthz')).body, 'ok', 'the proxy itself works');
          assert.equal((await get(srv.port, '/stats')).status, 200, 'direct still works');
        } finally {
          await proxy.close();
        }
      });
    }
  });

  test('from a non-loopback address of this machine: 404 (skipped when there is none)', async (t) => {
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    if (!lan) { t.skip('no non-loopback IPv4 address'); return; }
    await withServer({ host: '0.0.0.0' }, async (srv) => {
      const r = await get(srv.port, '/stats', { host: lan.address, localAddress: lan.address });
      assert.equal(r.status, 404, `from ${lan.address}`);
      assert.equal((await get(srv.port, '/stats', { host: '127.0.0.1' })).status, 200, 'the same server from 127.0.0.1');
    });
  });

  test('IPv6 loopback (::1) is loopback too (skipped without IPv6)', async (t) => {
    const can = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(0, '::1', () => s.close(() => r(true))); });
    if (!can) { t.skip('no ::1'); return; }
    await withServer({ host: '::1' }, async (srv) => {
      const r = await get(srv.port, '/stats', { host: '::1' });
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), { rooms: 0, activeGames: 0, sockets: 0 });
      assert.equal((await get(srv.port, '/stats', { host: '::1', headers: { 'X-Forwarded-For': '::1' } })).status, 404);
    });
  });
});
