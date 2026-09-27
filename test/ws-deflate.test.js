// SPEC §11 X5.15: permessage-deflate (RFC 7692) on /ws, off by default and turned on with BUNKER_WS_DEFLATE=1
// (server/index.js WS_DEFLATE; reports/ws-compression.md). Here:
//   - the switch: "1" on, "0" off, anything else the default (off); the options are WS_DEFLATE's;
//   - on the wire, with a raw client that offers it as a browser does: the handshake agrees on
//     `permessage-deflate; server_no_context_takeover`; a state is one compressed message (RSV1 on its first fragment)
//     that a fresh inflater turns back into the view, message after message (no context carried between messages); a
//     message under the threshold (`joined`, with the token) goes out uncompressed; a client's compressed message is
//     read, and one that inflates past MAX_PAYLOAD closes the socket (1009);
//   - off (the default, and "0"): the offer is declined and nothing is compressed;
//   - a whole game over real sockets whose bots negotiated it (tools/botlib.js through a `transport`), in two
//     languages with specials: the Checker finds nothing, and the bytes on the wire are a fraction of the messages.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import zlib from 'node:zlib';
import { describe, test } from 'node:test';
import WebSocket from 'ws';
import { configFromEnv, startServer as startInProcess, wsDeflateOption, WS_DEFLATE, WS_DEFLATE_DEFAULT, MAX_PAYLOAD } from '../server/index.js';
import { stateFrame } from '../server/rooms.js';
import { wireBytes } from '../tools/botlib.js';
import { assertServerHealthy, runTable, startServer } from './helpers-sim.js';

const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const SYNC = zlib.constants.Z_SYNC_FLUSH;

/**
 * A raw WebSocket client (RFC 6455 §5.2) that offers permessage-deflate as a browser does and keeps every frame the
 * server sends: {fin, rsv1, opcode, payload}.
 */
async function rawSocket(port, { offer = 'permessage-deflate; client_max_window_bits' } = {}) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  const key = crypto.randomBytes(16).toString('base64');
  sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n`
    + `Sec-WebSocket-Version: 13\r\n${offer ? `Sec-WebSocket-Extensions: ${offer}\r\n` : ''}\r\n`);
  let buf = Buffer.alloc(0);
  let handshake = null;
  let ended = false;
  const frames = [];
  let wake = null;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (handshake === null) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      handshake = buf.subarray(0, end).toString();
      buf = buf.subarray(end + 4);
    }
    for (;;) {
      if (buf.length < 2) break;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); at = 4; } else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (buf.length < at + len) break;
      frames.push({ fin: (buf[0] & 0x80) !== 0, rsv1: (buf[0] & 0x40) !== 0, opcode: buf[0] & 0x0f, payload: Buffer.from(buf.subarray(at, at + len)) });
      buf = buf.subarray(at + len);
    }
    if (wake) wake();
  });
  sock.on('close', () => { ended = true; if (wake) wake(); });
  sock.on('error', () => {});
  const until = async (pred, what) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > 5000) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 50); });
    }
  };
  await until(() => handshake !== null, 'the handshake');
  /** A masked client frame; rsv1: its payload is already compressed. */
  const frame = (payload, rsv1 = false) => {
    const mask = crypto.randomBytes(4);
    const b0 = 0x81 | (rsv1 ? 0x40 : 0);
    const head = payload.length < 126 ? Buffer.from([b0, 0x80 | payload.length]) : Buffer.from([b0, 0x80 | 126, payload.length >> 8, payload.length & 255]);
    sock.write(Buffer.concat([head, mask, Buffer.from(payload.map((x, i) => x ^ mask[i % 4]))]));
  };
  return {
    handshake: () => handshake,
    ended: () => ended,
    frames,
    until,
    send(obj) { frame(Buffer.from(JSON.stringify(obj))); },
    /** The text compressed as RFC 7692 §7.2.1 says (sync flush, the 4-byte trailer taken off), sent with RSV1. */
    sendDeflated(text) { frame(zlib.deflateRawSync(Buffer.from(text), { finishFlush: SYNC }).subarray(0, -4), true); },
    close() { sock.destroy(); },
  };
}

/** The data messages in a list of frames: fragments joined; `compressed` from the first frame's RSV1. */
function messages(frames) {
  const out = [];
  let cur = null;
  for (const f of frames) {
    if (f.opcode >= 8) continue; // control frames may come between fragments
    if (f.opcode !== 0) cur = { opcode: f.opcode, compressed: f.rsv1, frames: [], chunks: [] };
    assert.ok(cur, 'a continuation frame without a message to continue');
    assert.ok(f.opcode !== 0 || !f.rsv1, 'RSV1 is set on the first frame of a message only (RFC 7692 §6)');
    cur.frames.push(f);
    cur.chunks.push(f.payload);
    if (f.fin) {
      const payload = Buffer.concat(cur.chunks);
      // a fresh inflater for every message: this only works when the server carries no context between messages
      const data = cur.compressed ? zlib.inflateRawSync(Buffer.concat([payload, TRAILER]), { finishFlush: SYNC }) : payload;
      out.push({ ...cur, wire: payload.length, text: data.toString('utf8') });
      cur = null;
    }
  }
  return out;
}
const statesOf = (c) => messages(c.frames).filter((m) => m.text.startsWith('{"t":"state"'));

describe('§11 X5.15 BUNKER_WS_DEFLATE', () => {
  test('the switch: "1" on, "0" off, anything else the default (off); the options are WS_DEFLATE\'s', () => {
    assert.equal(WS_DEFLATE_DEFAULT, false);
    assert.equal(configFromEnv({}).wsDeflate, WS_DEFLATE_DEFAULT);
    assert.equal(configFromEnv({ BUNKER_WS_DEFLATE: '1' }).wsDeflate, true);
    assert.equal(configFromEnv({ BUNKER_WS_DEFLATE: '0' }).wsDeflate, false);
    for (const v of ['', 'yes', 'true', ' 1']) assert.equal(configFromEnv({ BUNKER_WS_DEFLATE: v }).wsDeflate, WS_DEFLATE_DEFAULT, JSON.stringify(v));
    assert.equal(wsDeflateOption(false), false);
    const o = wsDeflateOption(true);
    assert.deepEqual(o, { zlibDeflateOptions: { level: 1, memLevel: 8 }, serverNoContextTakeover: true, threshold: 1024, concurrencyLimit: 10 });
    // no window-bits demands: a number there turns an offer without that parameter into a failed handshake (ws)
    assert.ok(!('serverMaxWindowBits' in o) && !('clientMaxWindowBits' in o));
    o.zlibDeflateOptions.level = 9;
    assert.equal(WS_DEFLATE.zlibDeflateOptions.level, 1, 'a fresh copy every time');
  });

  test('on: negotiated without context takeover; a state is one compressed message a fresh inflater reads; small messages go out as they are', async () => {
    const srv = await startInProcess({ port: 0, host: '127.0.0.1', minPlayers: 2, wsDeflate: true, logger: () => {} });
    const a = await rawSocket(srv.port);
    const b = await rawSocket(srv.port);
    try {
      assert.match(a.handshake(), /^HTTP\/1\.1 101 /);
      assert.match(a.handshake(), /\r\nSec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover(\r\n|$)/i);
      a.send({ t: 'create', name: 'Анна', lang: 'ru' });
      await a.until(() => statesOf(a).length >= 1, 'the first state');
      const joined = messages(a.frames).find((m) => m.text.startsWith('{"t":"joined"'));
      assert.equal(joined.compressed, false, '`joined` (under the threshold, with the token) is not compressed');
      assert.ok(joined.wire < WS_DEFLATE.threshold);
      const { room } = JSON.parse(joined.text);
      b.send({ t: 'join', room, name: 'Bob', lang: 'en' });
      await b.until(() => statesOf(b).length >= 1, 'Bob\'s state');
      await a.until(() => statesOf(a).length >= 2, 'the host\'s second state');
      a.send({ t: 'start' });
      await a.until(() => statesOf(a).some((m) => JSON.parse(m.text).phase === 'reveal'), 'the game');
      await b.until(() => statesOf(b).some((m) => JSON.parse(m.text).phase === 'reveal'), 'the game for Bob');
      const g = srv.rooms.rooms.get(room).game;
      for (const [c, id] of [[a, 'p1'], [b, 'p2']]) {
        const states = statesOf(c);
        for (const m of states) {
          assert.equal(m.opcode, 1, 'a text message');
          assert.equal(m.frames.length, 2, 'still two fragments: the head, then the log');
          // ws decides on the first fragment: the head (every state here has one over the threshold)
          const head = Buffer.byteLength(m.text.slice(0, m.text.indexOf(',"log":')));
          assert.ok(head >= WS_DEFLATE.threshold && m.compressed, `a state with a head of ${head} bytes is compressed`);
          const size = Buffer.byteLength(m.text);
          // a state of two players is 2-7 KB and shrinks 2-2.5×; a big table's (16 + 50) about 5× (the whole-game test)
          assert.ok(m.wire * (size > 4096 ? 2 : 1.5) < size, `compressed ${m.wire} of ${size} bytes`);
        }
        const { serverNow, ...sent } = JSON.parse(states.at(-1).text); // eslint-disable-line no-unused-vars
        const { serverNow: now, ...direct } = JSON.parse(stateFrame(g.view(id))); // eslint-disable-line no-unused-vars
        assert.deepEqual(sent, direct);
      }
      // a client's compressed message is read (a ping answered by a pong)
      const pongs = () => messages(a.frames).filter((m) => m.text === '{"t":"pong"}').length;
      const before = pongs();
      a.sendDeflated('{"t":"ping"}');
      await a.until(() => pongs() > before, 'the pong to a compressed ping');
      // MAX_PAYLOAD bounds a client message after inflating: a few dozen bytes that inflate past it close the socket
      const bomb = `{"t":"ping","x":"${'a'.repeat(MAX_PAYLOAD)}"}`;
      assert.ok(zlib.deflateRawSync(Buffer.from(bomb)).length < 100);
      b.sendDeflated(bomb);
      await b.until(() => b.frames.some((f) => f.opcode === 8) || b.ended(), 'the close');
      const close = b.frames.find((f) => f.opcode === 8);
      assert.ok(close && close.payload.readUInt16BE(0) === 1009, `closed with 1009 (message too big), got ${close && close.payload.readUInt16BE(0)}`);
    } finally {
      a.close();
      b.close();
      await srv.close();
    }
  });

  test('off (the default): the offer is declined and nothing is compressed', async () => {
    for (const options of [{}, { wsDeflate: false }]) {
      const srv = await startInProcess({ port: 0, host: '127.0.0.1', minPlayers: 2, logger: () => {}, ...options });
      const a = await rawSocket(srv.port);
      try {
        assert.equal(srv.config.wsDeflate, false);
        assert.match(a.handshake(), /^HTTP\/1\.1 101 /);
        assert.doesNotMatch(a.handshake(), /Sec-WebSocket-Extensions/i);
        a.send({ t: 'create', name: 'Ann' });
        await a.until(() => statesOf(a).length >= 1, 'the first state');
        assert.ok(a.frames.every((f) => !f.rsv1), 'no frame is compressed');
      } finally {
        a.close();
        await srv.close();
      }
    }
  });

  test('BUNKER_WS_DEFLATE=0 on a spawned server: a client that offers it gets a plain socket', { timeout: 20000 }, async () => {
    const server = await startServer({ seed: 'deflate-off', env: { BUNKER_WS_DEFLATE: '0' } });
    try {
      const ws = new WebSocket(server.url.replace(/^http/, 'ws') + '/ws', { perMessageDeflate: true });
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      assert.equal(ws.extensions, '');
      ws.close();
    } finally {
      await server.stop();
    }
  });

  test('BUNKER_WS_DEFLATE=1: a whole game over sockets that negotiated deflate (en/ru, specials) is clean, and the wire is a fraction', { timeout: 120000 }, async (t) => {
    const server = await startServer({ seed: 'deflate-on', env: { BUNKER_WS_DEFLATE: '1' } });
    const socks = [];
    // the bots' sockets offer deflate as a browser does (ws's default offer); the watchers keep plain ones (a mixed room)
    const transport = (url) => {
      const ws = new WebSocket(url, { handshakeTimeout: 10000, perMessageDeflate: true });
      const s = { ws, raw: null, decoded: 0, extensions: null };
      ws.once('upgrade', (res) => { s.extensions = res.headers['sec-websocket-extensions'] ?? ''; });
      ws.once('open', () => { s.raw = ws._socket; });
      ws.on('message', (d) => { s.decoded += wireBytes(d); });
      socks.push(s);
      return ws;
    };
    try {
      const r = await runTable(server, {
        n: 6, seed: 'deflate-sim', specials: 0.5, games: 2, langs: (i) => (i % 2 ? 'ru' : 'en'), watcherLang: 'ru',
        label: 'deflate', botOpts: { transport },
      });
      const opened = socks.filter((s) => s.raw);
      const wire = opened.reduce((n, s) => n + s.raw.bytesRead, 0);
      const decoded = opened.reduce((n, s) => n + s.decoded, 0);
      t.diagnostic(`games ${r.games.map((g) => `${g.survivors}/${g.n}`).join(',')} messages ${r.messages} compared ${r.comparedStates}; `
        + `${opened.length} deflate sockets read ${wire} bytes on the wire for ${decoded} bytes of messages`);
      const msg = [...r.violations.slice(0, 25), r.violations.length > 25 ? `... ${r.violations.length - 25} more` : ''].filter(Boolean).join('\n');
      assert.equal(r.violations.length, 0, `invariant violations:\n${msg}`);
      assert.ok(r.games.length === 2 && r.games.every((g) => g.done), 'both games reach the final');
      assert.ok(opened.length >= 6, `${opened.length} bot sockets opened`);
      for (const s of opened) assert.equal(s.extensions, 'permessage-deflate; server_no_context_takeover');
      assert.ok(decoded > 500_000 && wire * 3 < decoded, `on the wire ${wire} bytes for ${decoded} bytes of messages`);
      await assertServerHealthy(server);
    } finally {
      await server.stop();
    }
  });
});
