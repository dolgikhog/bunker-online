// Regression tests for the i2 review findings fixed on the server side (reports/fix-server-fixer-i2.md):
//   - a 16-player Russian table with ordinary Russian names (NAME_MAX letters, 2 bytes each) went over the 120 KB
//     per-recipient budget, to ~138 KB in a special-heavy final: the §14 parts cut kept the newest PARTS_MIN entries'
//     parts whatever they cost, and the bare entries alone nearly filled the log's budget. Now the frame guard
//     (server/rooms.js, FRAME_BUDGET) holds the whole frame to 120 KB: over it, the parts cut is redone against what
//     the recipient's head leaves, and then the oldest lines are left off, as few as needed (SPEC §11 X5.2);
//   - the bench (tools/bench-broadcast.js) named everyone «Игрок N» and printed "ok" at ~115 KB; it now uses real names
//     and sweeps the special-heavy seeds (a tool, not a test: timing flakes);
//   - an orphaned server spun at ~80% CPU: its uncaughtException handler wrote to a closed stderr, the EPIPE was
//     uncaught again, and so on forever (server/index.js installProcessHandlers).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, CATEGORY_IDS, NAME_MAX } from '../server/game.js';
import {
  stateFrame, stateFrameChunks, stateMessage, wireLog, logBudgetFor, FRAME_BUDGET, LOG_WIRE_BUDGET, PARTS_MIN,
} from '../server/rooms.js';
import { mulberry32 } from '../server/rng.js';
import { realNames } from '../tools/botlib.js';
import { validateStateView } from './stateview-schema.js';
import { FRAME_BUDGET as CHECKER_FRAME_BUDGET } from './helpers-sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bytes = (x) => Buffer.byteLength(typeof x === 'string' ? x : JSON.stringify(x));
const bare = ({ parts, ...rest }) => rest; // eslint-disable-line no-unused-vars
const hasParts = (e) => Object.hasOwn(e, 'parts');

/**
 * The bench's game (tools/bench-broadcast.js): 16 players and 50 spectators, the whole table in `lang` with real names
 * (botlib realNames: 15-20 letters), the real content, the speaker playing a special at half the chances, to the final.
 * `onMove(game)` after every accepted move.
 */
function playTable(seed, lang, onMove) {
  let t = 1_800_000_000_000;
  const g = createGame({ room: 'BENC', rng: mulberry32(seed), now: () => (t += 1000), minPlayers: 4 });
  const R = mulberry32(seed * 31 + 1);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const names = realNames(lang, 66);
  assert.ok(names.every((n) => [...n].length <= NAME_MAX) && names.some((n) => [...n].length === NAME_MAX));
  for (let i = 0; i < 66; i++) assert.ok(g.join(names[i], { spectator: i >= 16, lang }).id);
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

/**
 * One recipient's frame, checked against the frame guard's rule. Returns {bytes, lines, shortened, overWithoutGuard}.
 * - the frame is within FRAME_BUDGET (unless only the newest PARTS_MIN lines are left), and its chunks are its text;
 * - when the parts cut alone fits what the head leaves, the frame carries exactly it (the same array);
 * - otherwise the log is a suffix of the engine's log; each line is the engine's entry or that entry without its parts,
 *   the bare ones first; the newest PARTS_MIN keep their parts; and no line was left off that fit: with the line just
 *   before the window (bare) the log would pass what the head leaves.
 */
function checkFrame(view, where) {
  const [head, tail] = stateFrameChunks(view);
  const frame = head.length + tail.length;
  const text = stateFrame(view);
  assert.equal(Buffer.concat([head, tail]).toString('utf8'), text, `${where}: the chunks are the text frame`);
  const headBytes = head.length + 1;
  const budget = logBudgetFor(headBytes);
  assert.equal(budget, FRAME_BUDGET - headBytes - ',"log":'.length);
  const full = view.log;
  const partsCut = wireLog(full);
  const wire = wireLog(full, budget);
  assert.equal(tail.toString('utf8'), `,"log":${JSON.stringify(wire)}}`, `${where}: the tail is the guarded wire log`);
  assert.equal(frame, headBytes + ',"log":'.length + bytes(wire));
  const overWithoutGuard = headBytes + ',"log":'.length + bytes(partsCut) > FRAME_BUDGET;
  if (!overWithoutGuard) {
    assert.equal(wire, partsCut, `${where}: a frame the parts cut fits carries exactly it`);
    return { bytes: frame, lines: wire.length, shortened: false, overWithoutGuard };
  }
  const drop = full.length - wire.length;
  assert.ok(drop >= 0);
  let seenParts = false;
  wire.forEach((e, i) => {
    const orig = full[drop + i];
    assert.equal(e.id, orig.id, `${where}: the window is the log's newest lines, in order`);
    if (hasParts(e)) { assert.equal(e, orig, `${where}: a line with parts is the engine's`); seenParts = true; }
    else {
      assert.ok(!seenParts, `${where}: #${e.id} is bare after a line with parts`);
      assert.deepEqual(e, bare(orig), `${where}: a bare line is the engine's without its parts`);
    }
  });
  const withParts = wire.filter(hasParts).length;
  assert.ok(withParts >= Math.min(PARTS_MIN, full.length), `${where}: only ${withParts} lines keep their parts`);
  if (wire.length > PARTS_MIN) assert.ok(frame <= FRAME_BUDGET, `${where}: a ${frame}-byte frame`);
  if (drop > 0) {
    assert.equal(withParts, Math.min(PARTS_MIN, wire.length), `${where}: lines were left off while more than PARTS_MIN kept parts`);
    assert.ok(bytes(wire) + bytes(bare(full[drop - 1])) + 1 > budget, `${where}: line #${full[drop - 1].id} was left off although it fit`);
  }
  return { bytes: frame, lines: wire.length, shortened: drop > 0, overWithoutGuard };
}

describe('§11 X5.2 the frame guard: a state stays within 120 KB per recipient with real names', () => {
  test('the budgets agree: rooms.js, the Checker (copied from the SPEC) and the design (120 KB of UTF-8)', () => {
    assert.equal(FRAME_BUDGET, 120 * 1024);
    assert.equal(CHECKER_FRAME_BUDGET, FRAME_BUDGET);
    assert.ok(LOG_WIRE_BUDGET < FRAME_BUDGET);
  });

  test('a Russian table of real names (16 + 50, the special-heavy seed 4) to the final: every frame within 120 KB, the oldest lines left off only as needed', (t) => {
    const watch = ['p1', 'p2', 'p17', 'p18']; // two players, two spectators (p17 = the first spectator)
    const seen = { frames: 0, shortened: 0, overWithoutGuard: 0, max: 0, shortest: Infinity };
    const g = playTable(4, 'ru', (game) => {
      if (game.round < 5 && game.phase !== 'final') return; // the log fills up by round 5; the guard is needed only later
      for (const id of watch) {
        const view = game.view(id);
        const r = checkFrame(view, `${id} ${game.phase} r${game.round} #${game.logSeq}`);
        seen.frames++;
        seen.max = Math.max(seen.max, r.bytes);
        if (r.overWithoutGuard) seen.overWithoutGuard++;
        if (r.shortened) { seen.shortened++; seen.shortest = Math.min(seen.shortest, r.lines); }
      }
    });
    // the final: every recipient, and the wire views pass the schema
    for (const id of [...g.players.map((p) => p.id), ...g.spectators.map((s) => s.id)]) {
      const view = g.view(id);
      const r = checkFrame(view, `${id} in the final`);
      assert.ok(r.bytes <= FRAME_BUDGET, `${id} in the final: ${r.bytes} bytes`);
      const { t, ...wireView } = JSON.parse(stateFrame(view)); // eslint-disable-line no-unused-vars
      assert.deepEqual(validateStateView(wireView), [], `${id} in the final`);
    }
    t.diagnostic(JSON.stringify(seen));
    // the guard was needed (without it these frames pass 120 KB: the test would catch it going away), and it left off
    // no more than a round's lines
    assert.ok(seen.overWithoutGuard > 20 && seen.shortened > 20, JSON.stringify(seen));
    assert.ok(seen.max <= FRAME_BUDGET && seen.max > FRAME_BUDGET - 2048, JSON.stringify(seen));
    assert.ok(seen.shortest >= 140, JSON.stringify(seen));
  });

  test('an English table of real names (the same game): the guard never shortens its log', (t) => {
    let frames = 0;
    let max = 0;
    const g = playTable(4, 'en', (game) => {
      if (game.round < 5 && game.phase !== 'final') return;
      for (const id of ['p1', 'p17']) {
        const view = game.view(id);
        const r = checkFrame(view, `${id} ${game.phase} r${game.round}`);
        assert.ok(!r.overWithoutGuard && !r.shortened, `${id} ${game.phase} r${game.round}: ${r.bytes} bytes`);
        frames++;
        max = Math.max(max, r.bytes);
      }
    });
    for (const id of [...g.players.map((p) => p.id), ...g.spectators.map((s) => s.id)]) {
      const view = g.view(id);
      assert.equal(wireLog(view.log, logBudgetFor(bytes(JSON.stringify({ t: 'state', ...view, log: undefined })))), wireLog(view.log));
    }
    t.diagnostic(`${frames} frames, max ${max} bytes`);
    assert.ok(frames > 100 && max > 90 * 1024 && max < FRAME_BUDGET, `${frames} frames, max ${max}`);
  });

  test('hand-made views: the guard follows the head, redoes the parts cut first, then leaves the oldest lines off', () => {
    const entry = (id, textLen, partsLen) => Object.freeze({
      id, ts: id, kind: 'info', text: 'т'.repeat(textLen), key: 'log.watch', params: Object.freeze({ p: 'p1' }),
      parts: Object.freeze([Object.freeze({ t: 'player', id: 'p1', v: 'ж'.repeat(partsLen) })]),
    });
    const log = Object.freeze(Array.from({ length: 200 }, (_, i) => entry(i + 1, 100, 300)));
    const view = (pad) => ({ you: { id: 'p1' }, pad: 'x'.repeat(pad), log });
    const headOf = (pad) => bytes({ t: 'state', ...view(pad), log: undefined });
    const partsCut = wireLog(log);
    const k0 = partsCut.filter(hasParts).length;
    assert.ok(k0 > PARTS_MIN && k0 < 200 && bytes(partsCut) <= LOG_WIRE_BUDGET, `${k0} lines keep their parts`);
    // an ordinary head: the parts cut, the same tail bytes for every head that fits
    const [, t1] = stateFrameChunks(view(1000));
    const [, t2] = stateFrameChunks(view(20000));
    assert.equal(t1, t2, 'one encoding for every recipient the parts cut fits');
    assert.equal(stateMessage(view(1000)).log, partsCut, 'the object transport carries the same log');
    // a head that leaves less than the parts cut: fewer lines keep their parts, and none is left off yet
    const pad1 = FRAME_BUDGET - bytes(partsCut) - 7 - headOf(0) + 10_000; // leaves the log 10 KB less than the parts cut
    const w1 = wireLog(log, logBudgetFor(headOf(pad1)));
    assert.equal(w1.length, 200, 'no line left off while dropping parts is enough');
    const k1 = w1.filter(hasParts).length;
    assert.ok(k1 < k0 && k1 > PARTS_MIN, `${k1} lines keep their parts`);
    const f1 = stateFrameChunks(view(pad1));
    assert.ok(f1[0].length + f1[1].length <= FRAME_BUDGET);
    assert.equal(f1[1], stateFrameChunks(view(pad1))[1], 'the same cut is encoded once');
    assert.deepEqual(stateMessage(view(pad1)).log, w1);
    // a head that leaves less than the bare log: the newest PARTS_MIN keep their parts, the oldest lines are left off
    const barePlusMin = bytes([...log.slice(0, 200 - PARTS_MIN).map(bare), ...log.slice(-PARTS_MIN)]);
    const pad2 = FRAME_BUDGET - barePlusMin - 7 - headOf(0) + 5_000;
    const b2 = logBudgetFor(headOf(pad2));
    const w2 = wireLog(log, b2);
    assert.ok(w2.length < 200 && w2.length > PARTS_MIN, `${w2.length} lines`);
    assert.equal(w2.filter(hasParts).length, PARTS_MIN);
    assert.equal(w2.at(-1), log.at(-1));
    assert.equal(w2[0].id, 200 - w2.length + 1, 'the oldest lines, and only they, are left off');
    assert.ok(bytes(w2) <= b2 && bytes(w2) + bytes(bare(log[200 - w2.length - 1])) + 1 > b2, 'as few as needed');
    const [h2, t2b] = stateFrameChunks(view(pad2));
    assert.ok(h2.length + t2b.length <= FRAME_BUDGET);
    assert.equal(Buffer.concat([h2, t2b]).toString('utf8'), stateFrame(view(pad2)));
    // a head too big for even the newest PARTS_MIN lines: those, with their parts, and nothing else (the frame is over)
    const w3 = wireLog(log, logBudgetFor(headOf(FRAME_BUDGET)));
    assert.deepEqual(w3, log.slice(-PARTS_MIN));
    // a log that is not frozen is cut the same way (uncached)
    assert.deepEqual(wireLog([...log], b2), w2);
    // a short log with a head that fits: sent whole, the very same array
    const small = Object.freeze(log.slice(0, 10));
    assert.equal(wireLog(small, logBudgetFor(headOf(1000))), small);
  });
});

describe('an orphaned server does not spin on a closed stderr (EPIPE)', () => {
  test('the real CLI entry: stdout and stderr closed by their reader, then a log line: no uncaught exception, no busy loop', { timeout: 20000 }, async () => {
    // a preload counts the server's uncaught exceptions and its CPU once this test has closed both pipes and asked it
    // to write one line to stderr (as the idle-room sweep does 30 minutes after a harness exits)
    const preload = `data:text/javascript,${encodeURIComponent(`
      let n = 0; process.on('uncaughtException', () => { n++; });
      process.on('message', (m) => {
        if (!m || !m.go) return;
        const c0 = process.cpuUsage();
        process.stderr.write('a log line after the reader is gone\\n');
        setTimeout(() => { const c = process.cpuUsage(c0); process.send({ uncaught: n, cpuMs: (c.user + c.system) / 1000 }); }, 500);
      });`)}`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BUNKER_') && k !== 'NODE_ENV'));
    const child = spawn(process.execPath, ['--import', preload, path.join(ROOT, 'server', 'index.js')], {
      env: { ...env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    try {
      const report = await new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`no report; stdout: ${out}`)), 15000);
        child.once('exit', (code, sig) => { clearTimeout(timer); reject(new Error(`the server exited (${code} ${sig})`)); });
        child.stderr.resume();
        child.stdout.on('data', (d) => {
          out += d;
          if (!/BUNKER_LISTENING \d+/.test(out)) return;
          child.stdout.removeAllListeners('data');
          child.stdout.destroy();
          child.stderr.destroy();
          setTimeout(() => child.send({ go: true }), 100);
        });
        child.on('message', (m) => { clearTimeout(timer); resolve(m); });
      });
      // before the fix: ~13,000 uncaught EPIPEs and the whole 500 ms of CPU
      assert.equal(report.uncaught, 0, JSON.stringify(report));
      assert.ok(report.cpuMs < 150, JSON.stringify(report));
    } finally {
      child.removeAllListeners('exit');
      child.kill('SIGKILL');
    }
  });
});
