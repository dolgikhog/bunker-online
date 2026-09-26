// Regression tests for the i1 review findings fixed on the server side (reports/fix-server-fixer-i1.md):
//   - a real broadcast cost 45–55% more server CPU than pre-X5: `ws.send(string)` encoded the whole 110–180 KB frame
//     again for every recipient. Now a state goes out as one WebSocket text message in two fragments, the recipient's
//     head and the log's UTF-8 bytes, which are encoded once per language and shared (SPEC §11 X5.2, report §3.8);
//   - states over the 120 KB budget in real games (a Russian final state ~170 KB): the report's §14 fallback, `parts`
//     only on the newest log entries that fit the log's byte budget (never fewer than PARTS_MIN), older ones as
//     {id, ts, kind, text, key, params};
//   - the bench measured one discussion state in JSON characters (tools/bench-broadcast.js now measures every state of
//     a game in UTF-8 bytes and times real sockets; it is not a test, timing flakes).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { createGame, CATEGORY_IDS } from '../server/game.js';
import { Rooms, stateFrame, stateFrameChunks, wireLog, LOG_WIRE_BUDGET, PARTS_MIN } from '../server/rooms.js';
import { mulberry32 } from '../server/rng.js';
import { startServer } from '../server/index.js';
import { validateServerMessage, validateStateView, PARTS_MIN as SCHEMA_PARTS_MIN } from './stateview-schema.js';

const BUDGET = 120 * 1024;
const bytes = (x) => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x));
const bare = ({ parts, ...rest }) => rest; // eslint-disable-line no-unused-vars

// ------------------------------------------------------------------------------------------------ a raw WebSocket
/** A WebSocket client that reads the server's frames one by one (RFC 6455 §5.2): {fin, opcode, payload}. */
async function rawSocket(port) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  const key = crypto.randomBytes(16).toString('base64');
  sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let buf = Buffer.alloc(0);
  let handshake = null;
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
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (buf.length < at + len) break;
      frames.push({ fin, opcode, payload: Buffer.from(buf.subarray(at, at + len)) });
      buf = buf.subarray(at + len);
    }
    if (wake) wake();
  });
  const until = async (pred, what) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > 5000) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 50); });
    }
  };
  await until(() => handshake !== null, 'the handshake');
  return {
    handshake: () => handshake,
    frames,
    until,
    /** A masked client text frame (every client frame is masked). */
    send(obj) {
      const payload = Buffer.from(JSON.stringify(obj));
      const mask = crypto.randomBytes(4);
      const head = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
      const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
      sock.write(Buffer.concat([head, mask, body]));
    },
    close() { sock.destroy(); },
  };
}

/** The messages in a list of frames: fragments joined (a text frame, then continuations until FIN). */
function messages(frames) {
  const out = [];
  let cur = null;
  for (const f of frames) {
    if (f.opcode >= 8) continue; // control frames may come between fragments
    if (f.opcode !== 0) cur = { opcode: f.opcode, frames: 0, chunks: [] };
    assert.ok(cur, 'a continuation frame without a message to continue');
    cur.frames++;
    cur.chunks.push(f.payload);
    if (f.fin) { out.push({ opcode: cur.opcode, frames: cur.frames, text: Buffer.concat(cur.chunks).toString('utf8') }); cur = null; }
  }
  return out;
}

describe('§11 X5.2 a broadcast: one message in two fragments, the log encoded once per language', () => {
  test('over a real socket a state is one text message of two fragments (head, then log) that parses to the view', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', minPlayers: 2, logger: () => {} });
    const a = await rawSocket(srv.port);
    const b = await rawSocket(srv.port);
    try {
      assert.match(a.handshake(), /^HTTP\/1\.1 101 /);
      a.send({ t: 'create', name: 'Анна', lang: 'ru' });
      await a.until(() => messages(a.frames).some((m) => m.text.startsWith('{"t":"state"')), 'the first state');
      const room = JSON.parse(messages(a.frames).find((m) => m.text.startsWith('{"t":"joined"')).text).room;
      b.send({ t: 'join', room, name: 'Bob', lang: 'en' });
      await b.until(() => messages(b.frames).some((m) => m.text.startsWith('{"t":"state"')), 'Bob\'s state');
      await a.until(() => messages(a.frames).filter((m) => m.text.startsWith('{"t":"state"')).length >= 2, 'the host\'s second state');
      const g = srv.rooms.rooms.get(room).game;
      for (const [c, id] of [[a, 'p1'], [b, 'p2']]) {
        const msgs = messages(c.frames);
        for (const m of msgs) {
          assert.equal(m.opcode, 1, 'a text message');
          const obj = JSON.parse(m.text);
          assert.deepEqual(validateServerMessage(obj), [], m.text.slice(0, 200));
          // `joined` is one frame; a state is two: its head, then the log (the shared bytes) with the closing brace
          assert.equal(m.frames, obj.t === 'state' ? 2 : 1, `${obj.t}: ${m.frames} frame(s)`);
        }
        const states = msgs.filter((m) => m.text.startsWith('{"t":"state"'));
        const firstFragment = c.frames.find((f) => f.opcode === 1 && !f.fin);
        assert.ok(firstFragment && firstFragment.payload.toString().startsWith('{"t":"state"'), 'the first fragment is the head');
        assert.ok(!firstFragment.payload.toString().includes('"log":'), 'the head has no log');
        const { serverNow, ...sent } = JSON.parse(states.at(-1).text); // eslint-disable-line no-unused-vars
        const view = g.view(id);
        const { serverNow: now, ...direct } = JSON.parse(JSON.stringify({ t: 'state', ...view, log: wireLog(view.log) })); // eslint-disable-line no-unused-vars
        assert.deepEqual(sent, direct);
      }
      assert.equal(JSON.parse(messages(a.frames).at(-1).text).you.lang, 'ru');
      assert.equal(JSON.parse(messages(b.frames).at(-1).text).you.lang, 'en');
    } finally {
      a.close();
      b.close();
      await srv.close();
    }
  });

  test('every recipient of one language is sent the very same log bytes; the chunks are exactly the text frame', () => {
    let t = 1_800_000_000_000;
    const rooms = new Rooms({ rng: mulberry32(5), minPlayers: 2, now: () => (t += 10), maxRoomsPerIp: Infinity, joinFailBurst: Infinity });
    const conns = [];
    const conn = (lang) => {
      const c = { ip: `198.51.100.${conns.length + 1}`, lang, sent: [], chunks: [] };
      c.send = (obj) => c.sent.push(JSON.parse(JSON.stringify(obj)));
      c.sendChunks = (ch) => { c.chunks.push(ch); c.sent.push(JSON.parse(Buffer.concat(ch).toString('utf8'))); };
      rooms.open(c);
      c.msg = (m) => rooms.message(c, JSON.stringify(m));
      conns.push(c);
      return c;
    };
    const host = conn('ru');
    host.msg({ t: 'create', name: 'Анна', lang: 'ru' });
    const room = host.sent.find((m) => m.t === 'joined').room;
    for (const [i, lang] of ['en', 'ru', 'en'].entries()) conn(lang).msg({ t: 'join', room, name: `P${i}`, lang });
    host.msg({ t: 'start' });
    for (let i = 0; i < 6; i++) host.msg({ t: 'next' });
    const g = rooms.rooms.get(room).game;
    const last = (c) => c.chunks.at(-1);
    // the same Buffer object (not a copy) for one language; another one for the other language
    assert.equal(last(conns[1])[1], last(conns[3])[1]);
    assert.equal(last(conns[0])[1], last(conns[2])[1]);
    assert.notEqual(last(conns[0])[1], last(conns[1])[1]);
    assert.notEqual(last(conns[0])[0], last(conns[2])[0], 'the head is per recipient');
    for (const [i, c] of conns.entries()) {
      const view = g.view(`p${i + 1}`);
      const [head, tail] = stateFrameChunks(view);
      assert.equal(Buffer.concat([head, tail]).toString('utf8'), stateFrame(view));
      // the head is the view without its log and without the closing brace; the tail brings the log and the brace
      const { log, ...rest } = view;
      assert.deepEqual(JSON.parse(`${head.toString('utf8')}}`), JSON.parse(JSON.stringify({ t: 'state', ...rest })));
      assert.ok(tail.toString('utf8').startsWith(',"log":[') && tail.toString('utf8').endsWith(']}'));
      assert.deepEqual(JSON.parse(tail.toString('utf8').slice(',"log":'.length, -1)), JSON.parse(JSON.stringify(wireLog(log))));
      assert.deepEqual(validateServerMessage(c.sent.at(-1)), []);
      assert.equal(c.sent.at(-1).you.lang, ['ru', 'en', 'ru', 'en'][i]);
    }
    // no chunks-capable transport: the plain object, with the same wire log
    const plain = { ip: '198.51.100.99', sent: [] };
    plain.send = (obj) => plain.sent.push(obj);
    rooms.open(plain);
    rooms.message(plain, JSON.stringify({ t: 'join', room, name: 'Watcher', spectator: true, lang: 'ru' }));
    const s = plain.sent.find((m) => m.t === 'state');
    assert.equal(s.log, wireLog(g.view(s.you.id).log));
  });
});

// ------------------------------------------------------------------------------------------------ the §14 cut
/**
 * The bench's game (tools/bench-broadcast.js): 16 players and 50 spectators in two languages, the real content, specials
 * played at half the chances, to the final. `onMove(game)` after every accepted move.
 */
function playBigGame(seed, onMove) {
  let t = 1_800_000_000_000;
  const g = createGame({ room: 'BENC', rng: mulberry32(seed), now: () => (t += 1000), minPlayers: 4 });
  const R = mulberry32(seed * 31 + 1);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  for (let i = 0; i < 16; i++) g.join(i % 2 ? `Игрок ${i + 1}` : `Player ${i + 1}`, { lang: i % 2 ? 'ru' : 'en' });
  for (let i = 0; i < 50; i++) g.join(i % 2 ? `Зритель ${i + 1}` : `Watcher ${i + 1}`, { spectator: true, lang: i % 2 ? 'ru' : 'en' });
  const act = (id, msg) => { const r = g.handle(id, msg); if (r.ok) onMove(g); return r; };
  act(g.hostId, { t: 'start' });
  for (let guard = 0; g.phase !== 'final' && guard < 20000; guard++) {
    if (g.phase === 'reveal' || g.phase === 'defense') {
      const sp = g._speakerId();
      const v = g.view(sp);
      if (v.me && v.me.canPlaySpecial && R() < 0.5) {
        const c = v.me.specials.find((x) => !x.used && x.effect !== 'airlock');
        if (c) {
          const alive = v.players.filter((p) => p.status === 'alive' && p.id !== sp);
          const out = v.players.filter((p) => p.status === 'ejected');
          const tgt = c.target === 'ejected' ? pick(out.length ? out : alive) : pick(alive);
          if (act(sp, { t: 'special', uid: c.uid, targetId: tgt && tgt.id, category: pick(CATEGORY_IDS) }).ok) continue;
        }
      }
      if (g.phase === 'reveal' && !g.turn.hasRevealed && v.me) {
        const c = v.turn.mustReveal || pick(CATEGORY_IDS.filter((x) => !v.me.cards[x].revealed));
        if (c) act(sp, { t: 'reveal', category: c });
      }
      act(sp, { t: 'endTurn' });
    } else if (g.phase === 'discussion') act(g.hostId, { t: 'next' });
    else if (g.phase === 'vote') {
      for (const x of [...g.vote.voters]) {
        if (g.phase !== 'vote' || g.vote.votes.has(x)) continue;
        const c = g.vote.candidates.filter((y) => y !== x);
        if (c.length) act(x, { t: 'vote', targetId: pick(c) });
      }
      if (g.phase === 'vote') act(g.hostId, { t: 'closeVote' });
    }
  }
  assert.equal(g.phase, 'final');
  return g;
}

/** The §14 cut of one view's log, checked against the engine's full log. */
function checkCut(view, where) {
  const full = view.log;
  const wire = wireLog(full);
  const withParts = wire.filter((e) => Object.hasOwn(e, 'parts')).length;
  const cut = wire.length - withParts;
  assert.equal(wire.length, full.length, where);
  wire.forEach((e, i) => {
    assert.equal(e.id, full[i].id, where);
    if (i < cut) assert.deepEqual(e, bare(full[i]), `${where}: an old entry is the engine's entry without its parts`);
    else assert.equal(e, full[i], `${where}: a newer entry goes as the engine made it`);
  });
  assert.ok(withParts >= Math.min(PARTS_MIN, full.length), `${where}: only ${withParts} entries keep their parts`);
  const wireBytes = bytes(wire);
  if (cut === 0) return { cut, wireBytes };
  // the cut is needed: with one more entry's parts the log would pass its budget (unless only PARTS_MIN are left)
  if (withParts > PARTS_MIN) assert.ok(wireBytes <= LOG_WIRE_BUDGET, `${where}: the wire log is ${wireBytes} bytes`);
  const oneMore = wire.map((e, i) => (i === cut - 1 ? full[i] : e));
  assert.ok(bytes(oneMore) > LOG_WIRE_BUDGET, `${where}: the entry #${full[cut - 1].id} lost its parts although they fit`);
  return { cut, wireBytes };
}

describe('§11 X5.2 the report §14 cut: a state stays within 120 KB per recipient', () => {
  test('a 16 + 50 game to the final (real content, both languages): every state within 120 KB of UTF-8, the cut minimal', () => {
    assert.equal(PARTS_MIN, SCHEMA_PARTS_MIN, 'the schema restates the server\'s PARTS_MIN');
    const watch = ['p1', 'p2', 'p17', 'p18']; // a player and a spectator per language (p17 = the first spectator)
    const max = { en: 0, ru: 0 };
    const seen = { cut: 0, uncut: 0, fullFits: 0 };
    let moves = 0;
    const g = playBigGame(42, (game) => {
      if (++moves % 3 && game.phase !== 'final') return; // every third move keeps the test quick; the final always
      for (const id of watch) {
        const view = game.view(id);
        const frame = stateFrame(view);
        const lang = game.langOf(id);
        max[lang] = Math.max(max[lang], bytes(frame));
        assert.ok(bytes(frame) <= BUDGET, `${id} (${lang}) in ${game.phase} round ${game.round}: ${bytes(frame)} bytes`);
        const { cut } = checkCut(view, `${id} ${game.phase} r${game.round} #${game.logSeq}`);
        if (cut) seen.cut++; else seen.uncut++;
        if (bytes(view.log) <= LOG_WIRE_BUDGET) { seen.fullFits++; assert.equal(wireLog(view.log), view.log, 'a log within its budget is sent whole'); }
        const s = JSON.parse(frame);
        const { t, ...wireView } = s; // eslint-disable-line no-unused-vars
        assert.deepEqual(validateStateView(wireView), [], `${id} ${game.phase}`);
      }
    });
    // the final: every recipient
    for (const id of [...g.players.map((p) => p.id), ...g.spectators.map((s) => s.id)]) {
      const b = bytes(stateFrame(g.view(id)));
      assert.ok(b <= BUDGET, `${id} in the final: ${b} bytes`);
    }
    assert.ok(seen.cut > 0 && seen.uncut > 0 && seen.fullFits > 0, JSON.stringify(seen));
    // without the cut the Russian final is far over the budget (so this test would catch the cut going away)
    const ruFinal = g.view('p2');
    assert.ok(bytes(JSON.stringify({ t: 'state', ...ruFinal })) > 150 * 1024, 'the uncut Russian final');
    assert.ok(max.ru > 100 * 1024 && max.en > 90 * 1024, JSON.stringify(max));
  });

  test('the cut on hand-made logs: nothing under the budget, the oldest first over it, never the newest PARTS_MIN', () => {
    const entry = (id, textLen, partsLen) => Object.freeze({
      id, ts: id, kind: 'info', text: 'т'.repeat(textLen), key: 'log.watch', params: Object.freeze({ p: 'p1' }),
      parts: Object.freeze([Object.freeze({ t: 'player', id: 'p1', v: 'ж'.repeat(partsLen) })]),
    });
    const withParts = (log) => log.filter((e) => Object.hasOwn(e, 'parts')).length;
    // small: sent whole, the very same array
    const small = Object.freeze(Array.from({ length: 200 }, (_, i) => entry(i + 1, 10, 10)));
    assert.equal(wireLog(small), small);
    // over the budget: parts on the newest entries that fit, the rest bare (in order, each the entry without parts)
    const mid = Object.freeze(Array.from({ length: 200 }, (_, i) => entry(i + 1, 100, 300)));
    const w = wireLog(mid);
    assert.equal(wireLog(mid), w, 'cached per log array');
    const k = withParts(w);
    assert.ok(k > PARTS_MIN && k < 200, `${k} entries keep their parts`);
    assert.ok(bytes(w) <= LOG_WIRE_BUDGET && bytes(w) + (bytes(mid[199 - k]) - bytes(bare(mid[199 - k]))) > LOG_WIRE_BUDGET);
    w.forEach((e, i) => assert.deepEqual(e, i < 200 - k ? bare(mid[i]) : mid[i]));
    // even the bare log is over the budget: the newest PARTS_MIN still keep their parts
    const huge = Object.freeze(Array.from({ length: 200 }, (_, i) => entry(i + 1, 400, 300)));
    assert.ok(bytes(huge.map(bare)) > LOG_WIRE_BUDGET);
    assert.equal(withParts(wireLog(huge)), PARTS_MIN);
    assert.ok(wireLog(huge).slice(-PARTS_MIN).every((e, i) => e === huge[200 - PARTS_MIN + i]));
    // a log that is not frozen (not the engine's shared array) is cut the same way, uncached
    assert.deepEqual(wireLog([...huge]), wireLog(huge));
  });

  test('the schema: entries without parts only as the oldest run of the log, never among the newest PARTS_MIN', () => {
    const g = playBigGame(7, () => {});
    const view = g.view('p2');
    const wire = wireLog(view.log);
    const cut = wire.findIndex((e) => Object.hasOwn(e, 'parts'));
    assert.ok(cut > 0, 'the final of a 16-player game is cut');
    const check = (log) => validateStateView({ ...JSON.parse(JSON.stringify(view)), log: JSON.parse(JSON.stringify(log)) });
    assert.deepEqual(check(wire), []);
    assert.deepEqual(check(view.log), [], 'the uncut log is valid too');
    // a bare entry after one with parts
    const hole = wire.map((e, i) => (i === cut + 3 ? bare(e) : e));
    assert.ok(check(hole).some((x) => /has no parts, but an older entry has them/.test(x)), check(hole).join('\n'));
    // too few entries with parts
    const tooFew = wire.map((e, i) => (i < wire.length - PARTS_MIN + 1 ? bare(e) : e));
    assert.ok(check(tooFew).some((x) => /of the newest 20 log entries have parts/.test(x)), check(tooFew).join('\n'));
    // a bare entry keeps exactly {id, ts, kind, text, key, params}
    const extra = wire.map((e, i) => (i === 0 ? { ...e, parts: undefined, extra: 1 } : e));
    assert.ok(check(extra).some((x) => /log\[0\]: unexpected key "extra"/.test(x)), check(extra).join('\n'));
  });
});
