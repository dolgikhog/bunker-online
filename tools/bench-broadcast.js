#!/usr/bin/env node
// Bunker Online: the cost and the size of a broadcast (SPEC §11 X5.2; reports/i18n-design.md §3.8, §14, §13 item 5a).
//
//   node tools/bench-broadcast.js [--players 16] [--spectators 50] [--reps 30] [--seed 42] [--specials 0.5]
//                                 [--langs en,ru] [--names real|short] [--size-seeds 4,11,13,3,7 | none]
//                                 [--size-langs ru,en] [--json]
//
// Plays one game with the real content on the pre-X5 engine (test/fixtures/pre-x5/game.js) and on the X5 engine in
// lockstep (the same seed, the same moves) from the lobby to the final. `--langs` are handed out to the members in turn.
//
// Names (`--names`): `real` (the default) gives everyone an ordinary full name of 15-20 letters (botlib realNames:
// «Александра Кузнецова», "Christopher Richards"), Cyrillic for a Russian member and Latin for an English one, as real
// tables have. The size budget is about those: a Cyrillic letter is 2 bytes, and names fill every tally, door and airlock
// line. `short` is the old «Игрок N» / "Player N", for comparison only (it hid a 120-138 KB Russian final).
//
// Size: after every move, every recipient's state on both engines, in JSON characters and in UTF-8 bytes (what goes on
// the wire). X5 is measured as rooms.js sends it (stateFrame: the log spliced last, with the §14 cut of `parts` on old
// entries and the frame guard). The largest state per language and phase is reported; the budget is the largest over
// the whole game, final included (every card is shown there, and the log is full).
// Then the size sweep: for every seed of `--size-seeds` and every language of `--size-langs`, one more game on the X5
// engine alone with the whole table in that language (the worst case for it: every name in the log is in its letters),
// the same moves and specials, every recipient's frame (stateFrameChunks, the production path) after every move. The
// default seeds include the special-heavy ones (4, 11, 13) that went over 120 KB with real Russian names before the
// frame guard. Reported per game: the largest frame, and how often and how far the frame guard shortened the log.
//
// CPU: at two points, the first reveal/discussion/vote state of round 4 or later with a full log (200 entries; the
// design's point) and the final, one broadcast to every recipient over REAL WebSockets on loopback: a sink process holds
// one socket per recipient and reports when every one of them has its whole message. The CPU is this process's (user +
// system, process.cpuUsage) from the first view to the sink's report, so it includes the views, the JSON, the UTF-8
// encoding, the WebSocket framing and the kernel's socket writes, exactly the work a server does. Median of --reps.
//   - pre-X5:   per recipient ws.send(JSON.stringify({t:'state', ...view})) (rooms.js and index.js before X5);
//   - X5:       per recipient rooms.js stateFrameChunks(view) sent by index.js sendFragments(): the recipient's head,
//               then the log's UTF-8 bytes, encoded once per language and shared, as fragments of one message;
//               "after a new log line": the per-language log arrays (their wire logs and bytes) are rebuilt first;
//   - X5 text:  for comparison only, after a new line too, the same frame as one string per recipient
//               (ws.send(stateFrame(view))), which encodes the whole frame again for every recipient (what X5 did before
//               the fragments).
//
// Budgets (design §3.8): at both points, X5 after a new line costs no more CPU than pre-X5; and no recipient's state is
// over 120 KB (122,880 bytes of UTF-8) at any point of any game, the sweep's included. Exit code 1 when a budget is
// missed. Timing on a busy machine is noisy: run it twice before believing a small difference. Not part of `npm test`
// (timing tests flake); i18n-qa runs it. Opens a server on 127.0.0.1 port 0 and one child process, and closes both.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import WebSocket, { WebSocketServer } from 'ws';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));

/** rooms.js's wireLog and logBudgetFor (imported in main, after the sink check; guardStat below uses them). */
const guardFns = {};

// ---- the sink (a child process): one socket per recipient, reports every complete broadcast ----------------------
if (args.sink) {
  const n = Number(args.n);
  const url = String(args.sink);
  let got = 0;
  const socks = [];
  for (let i = 0; i < n; i++) {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    ws.on('message', () => { if (++got % n === 0) process.send({ done: got / n }); });
    ws.on('error', (e) => { process.stderr.write(`sink: ${e.message}\n`); process.exit(2); });
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(String(i)); // which recipient this socket is
    socks.push(ws);
  }
  process.send({ ready: true });
  process.on('message', (m) => { if (m && m.bye) { for (const ws of socks) ws.terminate(); process.exit(0); } });
  process.on('disconnect', () => process.exit(0));
} else {
  await main();
}

async function main() {
  if (args.help || args.h) {
    console.log('usage: node tools/bench-broadcast.js [--players 16] [--spectators 50] [--reps 30] [--seed 42] [--specials 0.5] [--langs en,ru]\n'
      + '                                [--names real|short] [--size-seeds 4,11,13,3,7 | none] [--size-langs ru,en] [--json]\n'
      + 'Plays one game on the pre-X5 and the X5 engine (lockstep), measures every state\'s size, times one broadcast over real\n'
      + 'WebSockets at a full log and at the final, sweeps more seeds for the largest state, and checks the design §3.8 budgets.');
    return;
  }
  const old = await import('../test/fixtures/pre-x5/game.js');
  const { createGame } = await import('../server/game.js');
  const { stateFrame, stateFrameChunks, wireLog, logBudgetFor, FRAME_BUDGET } = await import('../server/rooms.js');
  const { sendFragments } = await import('../server/index.js');
  const { mulberry32 } = await import('../server/rng.js');
  const { realNames } = await import('./botlib.js');
  Object.assign(guardFns, { wireLog, logBudgetFor });

  const PLAYERS = Number(args.players || 16);
  const SPECTATORS = Number(args.spectators || 50);
  const REPS = Number(args.reps || 30);
  const SEED = Number(args.seed || 42);
  const SPECIALS = Number(args.specials ?? 0.5);
  const LANGS = String(args.langs || 'en,ru').split(',').filter(Boolean);
  const NAMES = String(args.names || 'real');
  const SIZE_SEEDS = args['size-seeds'] === 'none' ? [] : String(args['size-seeds'] ?? '4,11,13,3,7').split(',').filter(Boolean).map(Number);
  const SIZE_LANGS = String(args['size-langs'] ?? 'ru,en').split(',').filter(Boolean);
  if (!['real', 'short'].includes(NAMES)) throw new Error('--names is real or short');
  if (!SIZE_SEEDS.every(Number.isInteger)) throw new Error('--size-seeds takes seeds such as 4,11,13 (or none)');
  if (!SIZE_LANGS.every((l) => ['en', 'ru'].includes(l))) throw new Error('--size-langs takes en and/or ru');
  const BUDGET_BYTES = 120 * 1024;
  if (FRAME_BUDGET !== BUDGET_BYTES) throw new Error(`rooms.js FRAME_BUDGET is ${FRAME_BUDGET}, the design's budget ${BUDGET_BYTES}`);
  const KB = (n) => +(n / 1024).toFixed(1);
  // member k's name in `lang` (k: players first, then spectators, as they join)
  const N = PLAYERS + SPECTATORS;
  const real = { ru: realNames('ru', N), en: realNames('en', N) };
  const nameOf = (k, lang) => (NAMES === 'real' ? real[lang === 'ru' ? 'ru' : 'en'][k]
    : k < PLAYERS ? (lang === 'ru' ? `Игрок ${k + 1}` : `Player ${k + 1}`) : (lang === 'ru' ? `Зритель ${k - PLAYERS + 1}` : `Watcher ${k - PLAYERS + 1}`));

  // ---- one game on both engines, in lockstep ------------------------------------------------------------------------
  const clock = { t: 1_800_000_000_000 };
  const now = () => clock.t;
  const A = new old.Game({ room: 'BENC', rng: mulberry32(SEED), now, minPlayers: 4 });
  const B = createGame({ room: 'BENC', rng: mulberry32(SEED), now, minPlayers: 4 });
  const R = mulberry32(SEED * 31 + 1);
  // Cyrillic names for Russian members, Latin for English ones (as real tables would have)
  for (let k = 0; k < N; k++) {
    const lang = LANGS[k % LANGS.length];
    const a = A.join(nameOf(k, lang), { spectator: k >= PLAYERS });
    const b = B.join(nameOf(k, lang), { spectator: k >= PLAYERS, lang });
    if (!a.id || a.id !== b.id) throw new Error('the engines diverged at a join');
  }

  let afterMove = () => {}; // set below: measures every state after each move
  const step = driver([A, B], R, SPECIALS, clock, () => afterMove());
  const recipients = () => [...A.players.map((p) => p.id), ...A.spectators.map((s) => s.id)].filter((id) => A.view(id));

  // ---- sizes, after every move -------------------------------------------------------------------------------------
  const sizes = {}; // `${phase}` -> `${lang}` -> {maxChars, maxBytes, sum, n}
  const at = (phase, k) => ((sizes[phase] ||= {})[k] ||= { maxChars: 0, maxBytes: 0, sum: 0, n: 0 });
  const guard = newGuardStats();
  function measure() {
    for (const id of recipients()) {
      const pre = JSON.stringify({ t: 'state', ...A.view(id) });
      const view = B.view(id);
      const x5 = stateFrame(view);
      guardStat(guard, view, Buffer.byteLength(x5), B);
      for (const [k, s] of [['pre-X5', pre], [B.langOf(id), x5]]) {
        const bytes = Buffer.byteLength(s);
        for (const r of [at(A.phase, k), at('all', k)]) {
          r.maxChars = Math.max(r.maxChars, s.length);
          r.maxBytes = Math.max(r.maxBytes, bytes);
          r.sum += bytes;
          r.n++;
        }
      }
    }
  }

  // ---- real sockets: this process is the server, a child process the recipients ------------------------------------
  const server = http.createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 8 * 1024 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}`;
  const sockets = new Array(N);
  wss.on('connection', (ws) => ws.once('message', (d) => { sockets[Number(String(d))] = ws; }));
  const sink = spawn(process.execPath, [fileURLToPath(import.meta.url), '--sink', url, '--n', String(N)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  let acked = 0;
  let waiter = null;
  const ready = new Promise((resolve, reject) => {
    sink.on('message', (m) => {
      if (m.ready) resolve();
      if (m.done) { acked = m.done; if (waiter && acked >= waiter.k) { const w = waiter; waiter = null; w.resolve(); } }
    });
    sink.once('exit', (code) => reject(new Error(`the sink exited (${code})`)));
  });
  await ready;
  await new Promise((resolve) => { const t = setInterval(() => { if (sockets.every(Boolean)) { clearInterval(t); resolve(); } }, 5); });
  let sent = 0;
  const allReceived = () => new Promise((resolve) => { if (acked >= sent) resolve(); else waiter = { k: sent, resolve }; });

  // one broadcast to every current recipient; ms of this process's CPU (user + system) and wall until all have it
  async function broadcast(kind) {
    const ids = recipients();
    if (ids.length !== N) throw new Error('every member must still be a recipient');
    const c0 = process.cpuUsage();
    const t0 = performance.now();
    if (kind === 'pre') {
      for (let i = 0; i < N; i++) sockets[i].send(JSON.stringify({ t: 'state', ...A.view(ids[i]) }));
    } else {
      if (kind !== 'x5warm') B._logVersion = null; // a line was just added: the per-language log arrays are new
      for (let i = 0; i < N; i++) {
        const view = B.view(ids[i]);
        if (kind === 'x5text') sockets[i].send(stateFrame(view));
        else sendFragments(sockets[i], stateFrameChunks(view));
      }
    }
    sent++;
    await allReceived();
    const c = process.cpuUsage(c0);
    return { cpu: (c.user + c.system) / 1000, wall: performance.now() - t0 };
  }
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const KINDS = ['pre', 'x5', 'x5warm', 'x5text'];
  async function timeAll() {
    const runs = Object.fromEntries(KINDS.map((k) => [k, []]));
    for (let i = 0; i < 3; i++) for (const k of KINDS) await broadcast(k); // warm up
    for (let i = 0; i < REPS; i++) for (const k of KINDS) runs[k].push(await broadcast(k)); // interleaved: noise hits all alike
    const out = {};
    for (const k of KINDS) out[k] = { cpuMs: +median(runs[k].map((r) => r.cpu)).toFixed(2), wallMs: +median(runs[k].map((r) => r.wall)).toFixed(2) };
    return out;
  }

  // ---- play: measure every move, time at the full-log point and at the final --------------------------------------
  const points = {};
  let moves = 0;
  measure();
  afterMove = measure;
  while (moves++ < 20000) {
    const fullLog = A.log.length >= 200 && ['reveal', 'discussion', 'vote'].includes(A.phase) && A.round >= 4;
    if (!points.fullLog && fullLog) points.fullLog = { phase: A.phase, round: A.round, log: B.log.length, ...(await timeAll()) };
    if (!step()) break;
  }
  if (A.phase !== 'final') throw new Error(`the game did not reach the final (${A.phase})`);
  points.final = { phase: A.phase, round: A.round, log: B.log.length, ...(await timeAll()) };
  sink.send({ bye: true });
  for (const ws of wss.clients) ws.terminate();
  await new Promise((resolve) => wss.close(() => server.close(() => resolve())));

  // ---- the size sweep: more seeds, one language per table, the X5 engine alone ------------------------------------
  const sweep = [];
  for (const seed of SIZE_SEEDS) {
    for (const lang of SIZE_LANGS) {
      const c = { t: 1_800_000_000_000 };
      const G = createGame({ room: 'BENC', rng: mulberry32(seed), now: () => c.t, minPlayers: 4 });
      for (let k = 0; k < N; k++) G.join(nameOf(k, lang), { spectator: k >= PLAYERS, lang });
      const st = newGuardStats();
      const ids = () => [...G.players.map((p) => p.id), ...G.spectators.map((x) => x.id)];
      const each = () => {
        for (const id of ids()) {
          const view = G.view(id);
          if (!view) continue;
          const [head, tail] = stateFrameChunks(view);
          guardStat(st, view, head.length + tail.length, G, head.length + 1);
        }
      };
      const play = driver([G], mulberry32(seed * 31 + 1), SPECIALS, c, each);
      each();
      for (let i = 0; i < 20000 && play(); i++);
      if (G.phase !== 'final') throw new Error(`the sweep's game (seed ${seed}, ${lang}) did not reach the final (${G.phase})`);
      sweep.push({ seed, lang, specialsPlayed: G.players.reduce((n, p) => n + p.playedSpecials.length, 0), ...guardSummary(st) });
    }
  }

  // ---- budgets -------------------------------------------------------------------------------------------------------
  const x5Langs = Object.keys(sizes.all).filter((k) => k !== 'pre-X5');
  const mainBytes = Math.max(...x5Langs.map((k) => sizes.all[k].maxBytes));
  const maxBytes = Math.max(mainBytes, ...sweep.map((g) => g.maxBytes));
  const maxChars = Math.max(...x5Langs.map((k) => sizes.all[k].maxChars));
  const cpu = Object.fromEntries(Object.entries(points).map(([p, r]) => [p, { ok: r.x5.cpuMs <= r.pre.cpuMs, x5: r.x5.cpuMs, pre: r.pre.cpuMs }]));
  const result = {
    setup: { players: PLAYERS, spectators: SPECTATORS, recipients: N, langs: LANGS, names: NAMES, seed: SEED, specials: SPECIALS, reps: REPS,
      sizeSeeds: SIZE_SEEDS, sizeLangs: SIZE_LANGS, node: process.version },
    msPerBroadcast: points,
    sizePerRecipient: Object.fromEntries(Object.entries(sizes).map(([ph, m]) => [ph, Object.fromEntries(Object.entries(m).map(([k, r]) => [k, {
      maxKB: KB(r.maxBytes), maxKChars: KB(r.maxChars), avgKB: KB(r.sum / r.n),
    }]))])),
    frameGuard: guardSummary(guard),
    sizeSweep: sweep,
    budgets: {
      cpu: { ok: Object.values(cpu).every((x) => x.ok), points: cpu, rule: 'X5 after a new line <= pre-X5 (CPU ms per broadcast, median)' },
      size: { ok: maxBytes <= BUDGET_BYTES, maxBytes, maxKB: KB(maxBytes), maxKChars: KB(maxChars), rule: '<= 120 KB of UTF-8 per recipient, every state of every game (the sweep\'s too)' },
    },
  };
  if (args.json) { console.log(JSON.stringify(result, null, 2)); } else {
    console.log(`${PLAYERS} players + ${SPECTATORS} spectators (languages ${LANGS.join('/')}, ${NAMES} names such as ${JSON.stringify(nameOf(0, LANGS[0]))}), seed ${SEED}, specials ${SPECIALS}, ${REPS} reps, node ${process.version}`);
    console.log('CPU per broadcast over real WebSockets (ms of this process, user + system; wall in brackets):');
    for (const [p, r] of Object.entries(points)) {
      console.log(`  ${p === 'final' ? 'final' : 'full log'} (${r.phase} round ${r.round}, log ${r.log}):`);
      console.log(`    pre-X5:                   ${r.pre.cpuMs.toFixed(2)} (${r.pre.wallMs.toFixed(2)})`);
      console.log(`    X5, after a new log line: ${r.x5.cpuMs.toFixed(2)} (${r.x5.wallMs.toFixed(2)})   ${cpu[p].ok ? 'ok' : 'OVER'} (budget: no more than pre-X5)`);
      console.log(`    X5, no new log line:      ${r.x5warm.cpuMs.toFixed(2)} (${r.x5warm.wallMs.toFixed(2)})`);
      console.log(`    X5 as text frames:        ${r.x5text.cpuMs.toFixed(2)} (${r.x5text.wallMs.toFixed(2)})   (for comparison: one string per recipient)`);
    }
    console.log('largest state per recipient (UTF-8 KB / K JSON characters), by phase:');
    const cols = ['pre-X5', ...x5Langs];
    for (const ph of ['lobby', 'reveal', 'discussion', 'vote', 'defense', 'final', 'all'].filter((x) => sizes[x])) {
      const m = sizes[ph];
      console.log(`  ${(ph === 'all' ? 'any phase' : ph).padEnd(10)} ${cols.filter((k) => m[k]).map((k) => `${k} ${KB(m[k].maxBytes)} KB / ${KB(m[k].maxChars)} K`).join('   ')}`);
    }
    console.log(`  frame guard: ${guardLine(result.frameGuard)}`);
    if (sweep.length) {
      console.log(`size sweep (every recipient after every move; the whole table in one language, ${NAMES} names):`);
      for (const g of sweep) {
        console.log(`  seed ${String(g.seed).padEnd(4)} ${g.lang}: max ${KB(g.maxBytes)} KB (${g.maxBytes} bytes) ${g.maxBytes <= BUDGET_BYTES ? 'ok' : 'OVER'}   `
          + `(${g.specialsPlayed} specials played; frame guard: ${guardLine(g)})`);
      }
    }
    console.log(`  size budget: max ${KB(maxBytes)} KB of UTF-8 (${maxBytes} bytes; ${KB(maxChars)} K characters in the lockstep game) ${result.budgets.size.ok ? 'ok' : 'OVER'} (<= 120 KB = ${BUDGET_BYTES} bytes per recipient)`);
  }
  process.exitCode = result.budgets.cpu.ok && result.budgets.size.ok ? 0 : 1;
  setTimeout(() => process.exit(), 50).unref();
}

// ---- shared by the lockstep game and the sweep --------------------------------------------------------------------


/**
 * The bench's moves: one turn, one discussion step or one ballot per call (as the design's scratch bench played), the
 * speaker playing a special at `SPECIALS` odds (a special it holds and may play now, other than the Airlock). `engines` get every move in lockstep (the first one's state decides it;
 * a move must give the same answer everywhere); `onMove` runs after every accepted move. Returns false in the final.
 */
function driver(engines, R, SPECIALS, clock, onMove) {
  const [A] = engines;
  const CATS = ['profession', 'biology', 'health', 'hobby', 'phobia', 'skill', 'trait', 'baggage'];
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const both = (id, msg) => {
    clock.t += 1000;
    const res = engines.map((g) => g.handle(id, msg));
    if (res.some((r) => r.ok !== res[0].ok || r.message !== res[0].message)) throw new Error(`the engines diverged: ${JSON.stringify(msg)} ${res.map((r) => r.message).join(' / ')}`);
    if (res[0].ok) onMove();
    return res[0];
  };
  return function step() {
    const host = A.hostId;
    if (A.phase === 'lobby') { both(host, { t: 'start' }); return true; }
    if (A.phase === 'final') return false;
    if (A.phase === 'reveal' || A.phase === 'defense') {
      const sp = A._speakerId();
      const v = A.view(sp);
      if (v.me && v.me.canPlaySpecial && R() < SPECIALS) {
        const c = v.me.specials.find((x) => !x.used && x.effect !== 'airlock');
        if (c) {
          const alive = v.players.filter((p) => p.status === 'alive' && p.id !== sp);
          const out = v.players.filter((p) => p.status === 'ejected');
          const tgt = c.target === 'ejected' ? pick(out.length ? out : alive) : pick(alive);
          if (both(sp, { t: 'special', uid: c.uid, targetId: tgt && tgt.id, category: pick(CATS) }).ok) return true;
        }
      }
      if (A.phase === 'reveal' && !A.turn.hasRevealed && v.me) {
        const hidden = CATS.filter((c) => !v.me.cards[c].revealed);
        const c = v.turn.mustReveal || pick(hidden);
        if (c) both(sp, { t: 'reveal', category: c });
      }
      both(sp, { t: 'endTurn' });
      return true;
    }
    if (A.phase === 'discussion') { both(host, { t: 'next' }); return true; }
    if (A.phase === 'vote') {
      for (const x of [...A.vote.voters]) {
        if (A.phase !== 'vote' || A.vote.votes.has(x)) continue;
        const c = A.vote.candidates.filter((y) => y !== x);
        if (c.length) both(x, { t: 'vote', targetId: pick(c) });
      }
      if (A.phase === 'vote') both(host, { t: 'closeVote' });
      return true;
    }
    return false;
  };
}

/** The frame guard at work: frames measured, frames whose log it shortened, the shortest window (and of how many). */
function newGuardStats() { return { frames: 0, maxBytes: 0, shortened: 0, shortest: null }; }
/** One frame of `bytes` for `view` (headBytes: its head with the closing brace, if known; else the frame minus the log). */
function guardStat(st, view, bytes, game, headBytes = null) {
  st.frames++;
  st.maxBytes = Math.max(st.maxBytes, bytes);
  if (!Array.isArray(view.log) || !view.log.length) return;
  const { log, ...rest } = view;
  const hb = headBytes ?? Buffer.byteLength(JSON.stringify({ t: 'state', ...rest }));
  const n = guardFns.wireLog(log, guardFns.logBudgetFor(hb)).length;
  if (n >= log.length) return;
  st.shortened++;
  if (!st.shortest || n < st.shortest.n) st.shortest = { n, of: log.length, phase: game.phase, round: game.round, player: !!view.me };
}
function guardSummary(st) { return { frames: st.frames, maxBytes: st.maxBytes, shortened: st.shortened, shortest: st.shortest }; }
function guardLine(g) {
  if (!g.shortened) return `never needed (${g.frames} frames)`;
  const s = g.shortest;
  return `shortened the log of ${g.shortened} of ${g.frames} frames, to ${s.n} of ${s.of} lines at the shortest (${s.phase} round ${s.round}, a ${s.player ? 'player' : 'spectator'})`;
}
