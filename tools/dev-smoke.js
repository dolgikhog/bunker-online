#!/usr/bin/env node
// Bunker Online: a puppeteer smoke of the dev test table (SPEC §11 X9.6). Run `node tools/dev-smoke.js --help`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

const HELP = `Bunker Online dev table smoke (puppeteer-core + ${CHROME}).

  node tools/dev-smoke.js              spawn a dev server (BUNKER_DEV=1 PORT=0 BUNKER_MIN_PLAYERS=2) and run
  node tools/dev-smoke.js --url URL    run against a running dev server (the no-dev checks then spawn their own)

Options:
  --url URL        a running server started with BUNKER_DEV=1
  --screens DIR    screenshot directory (default reports/screens/devtools)
  --seed S         the test game's seed (default smoke-1)
  --timeout MS     how long one step may take (default 20000)
  --headful        show the browser
  -h, --help       this text

Flow (SPEC §11 X9.6): /dev with 4 human seats → New test game (seed) → Add bots (2) → Start → giveSpecial airlock to
P1 and P2 → Auto-reveal and the host's Next (in P1's frame) reach round 2 → P1 and P2 each play the Airlock on P3
through their own seat frames (the Play flow) → P3 is thrown out → Skip to vote → Force tie between two candidates →
the defense → God view shows every hidden card in the side panel (and only on the seat that asked). Also: Focus and Tabs
layouts, every op's "[dev]" log line, and on a server WITHOUT BUNKER_DEV: /dev and /devinfo are 404 and ?autojoin=1 is
ignored. Sound (the narrator; Chrome keeps its real autoplay policy, only muted): every seat frame has
allow="autoplay"; at the Start ONE seat reads the catastrophe (Auto = P1), and focusing another seat in the middle of
the clip does not stop it; then a second test game with the sound on P3, whose frame nothing but the table touched:
P3 plays by itself and nobody else does; ▶ Listen in P2 moves the sound there (P3 stops), the switch in P4 moves it
again (P2 stops) and leaves P4's saved switch alone. Screenshots go to the screens directory. Exit code 0 = pass,
1 = failure.`;

function parseArgs(argv) {
  const o = { seed: 'smoke-1', timeout: 20000, screens: path.join(ROOT, 'reports', 'screens', 'devtools') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--headful') o.headful = true;
    else if (/^--(url|screens|seed|timeout)$/.test(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = v;
    } else throw new Error(`unknown argument ${a}`);
  }
  o.timeout = Number(o.timeout);
  if (!Number.isFinite(o.timeout) || o.timeout < 1000) throw new Error('--timeout must be >= 1000 ms');
  o.screens = path.resolve(o.screens);
  return o;
}
let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n\n${HELP}`); process.exit(2); }
if (opts.help) { console.log(HELP); process.exit(0); }

const T0 = Date.now();
const log = (...a) => console.log(`[dev-smoke +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sel = (id, extra = '') => `[data-testid="${id}"]${extra}`;
const run = { servers: [], browser: null, shots: 0, failures: [], consoleErrors: [], stats: {} };
function check(cond, msg) { if (!cond) { run.failures.push(msg); log(`CHECK FAILED: ${msg}`); } return !!cond; }
class StepError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// servers

async function spawnServer(dev) {
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', BUNKER_MIN_PLAYERS: '2' };
  delete env.BUNKER_DEV; delete env.BUNKER_TRUST_PROXY; delete env.BUNKER_SEED;
  if (dev) env.BUNKER_DEV = '1';
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const srv = { child, out: '', err: '', url: null, exited: null, dev };
  run.servers.push(srv);
  child.stdout.on('data', (d) => { srv.out += d; });
  child.stderr.on('data', (d) => { srv.err += d; });
  child.on('exit', (code, signal) => { srv.exited = { code, signal }; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${srv.out}\n${srv.err}`)), 10000);
    const onData = () => {
      const m = /BUNKER_LISTENING (\d+)/.exec(srv.out);
      if (m) { clearTimeout(timer); srv.url = `http://127.0.0.1:${m[1]}`; resolve(); }
    };
    child.stdout.on('data', onData);
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`server exited:\n${srv.out}\n${srv.err}`)); });
  });
  return srv;
}

// ---------------------------------------------------------------------------------------------------------------
// the page, the seats

async function shot(page, label) {
  fs.mkdirSync(opts.screens, { recursive: true });
  const file = path.join(opts.screens, `${String(++run.shots).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: file }).catch((e) => log(`screenshot ${file}: ${e.message}`));
  log(`screenshot ${path.relative(ROOT, file)}`);
}
async function table(page) { return page.evaluate(() => window.__devTable || null); }
async function waitTable(page, pred, what, timeout = opts.timeout) {
  const t0 = Date.now();
  let t = null;
  for (;;) {
    t = await table(page).catch(() => null);
    try { if (t && pred(t)) return t; } catch { /* keep polling */ }
    if (Date.now() - t0 > timeout) throw new StepError(`timed out after ${timeout} ms waiting for ${what}; table: ${JSON.stringify(t && { room: t.room, seats: t.seats.map((s) => [s.k, s.screen, s.phase, s.id]), log: t.log.slice(-6) })}`);
    await sleep(100);
  }
}
/** The seat's frame (re-queried: a frame that navigated is a new one). */
async function seatFrame(page, k) {
  const h = await page.$(`iframe[data-seat="${k}"]`);
  const f = h ? await h.contentFrame() : null;
  if (!f) throw new StepError(`seat ${k}: no frame`);
  return f;
}
async function seatState(page, k) {
  try { return await (await seatFrame(page, k)).evaluate(() => window.__bunkerState || null); } catch { return null; }
}
async function waitSeat(page, k, pred, what, timeout = opts.timeout) {
  const t0 = Date.now();
  let s = null;
  for (;;) {
    s = await seatState(page, k);
    try { if (s && pred(s)) return s; } catch { /* keep polling */ }
    if (Date.now() - t0 > timeout) {
      throw new StepError(`seat P${k}: timed out after ${timeout} ms waiting for ${what}; state: ${s ? JSON.stringify({ phase: s.phase, round: s.round, turn: s.turn && s.turn.speakerId, vote: s.vote && s.vote.stage, log: s.log.slice(-4).map((e) => e.text) }) : null}`);
    }
    await sleep(100);
  }
}
/**
 * Clicks an enabled, visible hook inside seat k's frame with a real mouse click. The frame is scaled with a CSS
 * transform, which puppeteer's own ElementHandle.click() does not map (it lands at the unscaled offset), so the point is
 * mapped here: frame box + the element's centre × the frame's scale. The element is scrolled into view in its frame
 * first, and must be the topmost thing at that point there.
 */
async function seatClick(page, k, id, extra = '', what = '') {
  const q = `${sel(id, extra)}:not([disabled])`;
  let why = '';
  for (let i = 0; i < 10; i++) {
    const f = await seatFrame(page, k);
    await f.waitForSelector(q, { visible: true, timeout: opts.timeout })
      .catch(() => { throw new StepError(`seat P${k}: no enabled ${sel(id, extra)}${what ? ` (${what})` : ''}`); });
    const pt = await f.$eval(q, (e) => {
      e.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = e.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { x, y, hit: !!top && (top === e || e.contains(top)), top: top ? `${top.tagName}.${top.className}` : null };
    }).catch((e) => ({ hit: false, top: e.message }));
    const fr = await page.$eval(`iframe[data-seat="${k}"]`, (e) => {
      const b = e.getBoundingClientRect();
      const stage = e.closest('.seats').getBoundingClientRect();
      return { x: b.left, y: b.top, s: b.width / e.offsetWidth, stage: { l: stage.left, t: stage.top, r: stage.right, b: stage.bottom } };
    });
    const x = fr.x + pt.x * fr.s;
    const y = fr.y + pt.y * fr.s;
    const onStage = x > fr.stage.l && x < fr.stage.r && y > fr.stage.t && y < fr.stage.b;
    if (pt.hit && onStage) {
      await page.mouse.click(x, y);
      return;
    }
    why = pt.hit ? `off the visible stage (${Math.round(x)},${Math.round(y)})` : `covered by ${pt.top}`;
    await sleep(150);
  }
  throw new StepError(`seat P${k}: could not click ${sel(id, extra)}: ${why}`);
}
async function devClick(page, id, extra = '') {
  const h = await page.waitForSelector(`${sel(id, extra)}:not([disabled])`, { visible: true, timeout: opts.timeout })
    .catch(() => { throw new StepError(`/dev: no enabled ${sel(id, extra)}`); });
  await h.click();
}
const seatOf = (t, id) => (t.seats.find((s) => s.id === id) || {}).k || 0;
const devLines = (s) => s.log.filter((e) => /^\[dev\] /.test(e.text)).map((e) => e.text);

// ---------------------------------------------------------------------------------------------------------------
// main

async function main() {
  fs.mkdirSync(opts.screens, { recursive: true });
  for (const f of fs.readdirSync(opts.screens)) if (/^\d\d-.*\.png$|^FAIL-.*\.png$/.test(f)) fs.rmSync(path.join(opts.screens, f));
  const base = opts.url ? opts.url.replace(/\/+$/, '') : (await spawnServer(true)).url;
  log(opts.url ? `using ${base}` : `spawned a dev server at ${base}`);
  run.browser = await puppeteer.launch({
    executablePath: CHROME, headless: !opts.headful, defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--window-size=1680,1050'],
  });
  const ctx = await run.browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1680, height: 1050 });
  page.on('pageerror', (e) => { run.consoleErrors.push(`uncaught: ${e.message}`); log(`PAGE ERROR: ${e.message}`); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = (m.location() || {}).url || '';
    if (/\/version\.json$/.test(url) && /404/.test(m.text())) return;   // no version.json in a local run: 'dev' (X10)
    run.consoleErrors.push(`${m.text()} ${url}`);
    log(`CONSOLE ERROR: ${m.text()} ${url}`);
  });
  page.on('dialog', async (d) => { run.failures.push(`a native ${d.type()} dialog appeared`); await d.dismiss().catch(() => {}); });

  // 1. the table, 4 human seats, a seeded game
  const res = await page.goto(`${base}/dev`, { waitUntil: 'domcontentloaded' });
  check(res && res.status() === 200, `GET /dev answered ${res && res.status()} (dev mode must serve it)`);
  await page.waitForSelector(sel('dev-new-game'), { timeout: opts.timeout });
  await page.$eval(sel('dev-humans'), (e) => { e.value = '4'; });
  await page.$eval(sel('dev-seed'), (e, v) => { e.value = v; }, opts.seed);
  await devClick(page, 'dev-new-game');
  let t = await waitTable(page, (x) => x.room && x.seats.length === 4 && x.seats.every((s) => s.phase === 'lobby' && s.id), '4 seats in the lobby');
  const room = t.room;
  check(t.seats.every((s) => !s.blocked && s.ready), 'a seat frame was blocked or has no bridge');
  check(t.seats[0].isHost && t.hostSeat === 1, 'seat 1 (P1) is not the host');
  const ids = Object.fromEntries(t.seats.map((s) => [s.k, s.id]));
  check(new Set(Object.values(ids)).size === 4, `the 4 seats are not 4 players: ${JSON.stringify(ids)}`);
  for (const s of t.seats) {
    check(s.url === `/?room=${room}&name=P${s.k}&profile=p${s.k}&autojoin=1` || s.k === 1, `seat ${s.k}'s URL is ${s.url}`);
    check(s.name === `P${s.k}`, `seat ${s.k} is named ${s.name}, expected P${s.k}`);
  }
  const lobby = await seatState(page, 1);
  check(lobby.log.some((e) => /^\[dev\] .*seed/.test(e.text) && e.text.includes(opts.seed)), `no "[dev] … seed ${opts.seed}" line in the log`);
  log(`room ${room}: P1..P4 = ${JSON.stringify(ids)}`);
  // sound: every frame may autoplay (a click on the table is then the gesture), and Auto gives the sound to P1
  const allow = await page.$$eval('iframe[data-seat]', (els) => els.map((e) => e.getAttribute('allow') || ''));
  check(allow.length === 4 && allow.every((a) => /(^|;)\s*autoplay\b/.test(a)), `a seat frame lacks allow="autoplay": ${JSON.stringify(allow)}`);
  t = await waitTable(page, (x) => x.sound === 1 && x.seats.every((q) => q.narr && q.narr.on === (q.k === 1)), 'the sound on P1 (Auto), every other seat silent');
  const sndSel = await page.$eval(sel('dev-sound'), (e) => ({ value: e.value, text: e.options[e.selectedIndex].textContent }));
  check(t.soundMode === 'auto' && sndSel.value === 'auto' && /P1/.test(sndSel.text), `the 🔊 Sound choice reads ${JSON.stringify(sndSel)} (mode ${t.soundMode}), expected Auto (P1)`);
  const sndTop = await page.$eval(sel('dev-sound-status'), (e) => e.textContent);
  check(/sound: P1/.test(sndTop), `the top bar says ${JSON.stringify(sndTop)}, expected "🔊 sound: P1"`);
  await shot(page, 'lobby-4-seats');

  // 2. bots, Start, fast timers
  await page.$eval(sel('dev-bots-count'), (e) => { e.value = '2'; e.dispatchEvent(new Event('change', { bubbles: true })); });
  await devClick(page, 'dev-add-bots');
  await waitSeat(page, 1, (s) => s.players.length === 6, '6 seated players (2 bots)');
  await devClick(page, 'dev-fast-timers');
  await waitSeat(page, 1, (s) => s.options.speechSeconds1 === 5 && s.options.speechSeconds === 5 && s.options.discussionSeconds === 5 && s.options.defenseSeconds === 5, 'the fast timers (5/5/5/5)');
  await devClick(page, 'dev-start');
  await waitSeat(page, 1, (s) => s.phase === 'reveal' && s.round === 1, 'the game to start');
  for (const k of [2, 3, 4]) await waitSeat(page, k, (s) => s.phase === 'reveal' && !!s.me, `P${k} to see the game`);
  await waitSound(page, 1, 'the Start (Auto: P1)');
  await shot(page, 'started');

  // 3. giveSpecial airlock to P1 and P2 (a target dropdown fed by the host's state, an effect dropdown)
  for (const k of [1, 2]) {
    await page.waitForFunction((id) => [...document.querySelectorAll('[data-testid="dev-give-player"] option')].some((o) => o.value === id), { timeout: opts.timeout }, ids[k]);
    await page.select(sel('dev-give-player'), ids[k]);
    await page.select(sel('dev-give-effect'), 'airlock');
    await devClick(page, 'dev-give-special');
    await waitSeat(page, k, (s) => s.me.specials.some((x) => x.effect === 'airlock' && !x.used), `P${k} to hold an unused Airlock`);
  }
  log('P1 and P2 hold an Airlock');

  // 4. to round 2 (an Airlock is played from round 2 on): Auto-reveal, then the host's Next in P1's own frame
  await devClick(page, 'dev-auto-reveal');
  await waitSeat(page, 1, (s) => s.phase === 'discussion' && s.round === 1, 'the round-1 discussion after Auto-reveal');
  await seatClick(page, 1, 'next-btn', '', 'the host ends the discussion');
  await waitSeat(page, 1, (s) => s.phase === 'reveal' && s.round === 2, 'round 2');

  // 5. P1 then P2 play the Airlock on P3 through their own seats (§10 Play flow): P3 is thrown out, no vote
  const p3 = ids[3];
  await devClick(page, 'dev-seat-focus', '[data-seat="1"]');   // enlarge P1's seat while it plays
  await sleep(300);
  await playAirlock(page, 1, p3);
  const opened = await waitSeat(page, 1, (s) => (s.airlocks || []).some((a) => a.targetId === p3 && a.byIds.includes(ids[1])), 'the airlock on P3 to open');
  check(opened.players.find((p) => p.id === p3).status === 'alive', 'P3 is out after one Airlock');
  await shot(page, 'airlock-open-by-P1');
  await devClick(page, 'dev-seat-focus', '[data-seat="2"]');
  await sleep(300);
  // Auto follows the focus, but not in the middle of P1's clip (moving the sound would stop it)
  await waitSound(page, 1, 'focusing P2 in the middle of the clip (Auto keeps the sound on the seat that reads)');
  await playAirlock(page, 2, p3);
  const sealed = await waitSeat(page, 1, (s) => s.players.find((p) => p.id === p3).status === 'ejected', 'P3 to be thrown out by the second Airlock');
  const sealLine = sealed.log.find((e) => e.kind === 'eject' && /sealed the airlock/.test(e.text));
  check(!!sealLine && sealLine.text.includes('P2') && sealLine.text.includes('P1') && sealLine.text.includes('P3'), `no seal line naming P2, P1 and P3: ${sealLine && sealLine.text}`);
  await waitSeat(page, 3, (s) => s.players.find((p) => p.id === p3).status === 'ejected', 'P3 to see it');
  const p3head = await page.waitForFunction(() => document.querySelector('[data-testid="dev-seat"][data-seat="3"]').getAttribute('data-status') === 'ejected', { timeout: 5000 })
    .then(() => 'ejected').catch(() => page.$eval(sel('dev-seat', '[data-seat="3"]'), (e) => e.getAttribute('data-status')));
  check(p3head === 'ejected', `P3's seat header says ${p3head}, expected ejected`);
  await shot(page, 'P3-sealed-out');
  await devClick(page, 'dev-seat-focus', '[data-seat="2"]');   // back to the grid
  run.stats.airlock = sealLine ? sealLine.text : null;

  // 6. Skip to vote, then Force tie between two candidates → the defense
  await devClick(page, 'dev-skip-to-vote');
  const v = await waitSeat(page, 1, (s) => s.phase === 'vote' && s.vote && s.vote.stage === 'main', 'an open main ballot after Skip to vote', opts.timeout * 2);
  log(`skipped to the vote of round ${v.round}: candidates ${v.vote.candidates.join(',')}`);
  await shot(page, 'skip-to-vote');
  const humans = [ids[1], ids[2], ids[4]].filter((id) => v.vote.candidates.includes(id));
  const pickIds = (humans.length >= 2 ? humans : v.vote.candidates).slice(0, 2);
  await page.waitForFunction((a) => a.every((id) => document.querySelector(`[data-testid="dev-tie-option"][data-player-id="${id}"]`)), { timeout: opts.timeout }, pickIds);
  for (const id of pickIds) await page.click(sel('dev-tie-option', `[data-player-id="${id}"]`));
  await devClick(page, 'dev-force-tie');
  const d = await waitSeat(page, 1, (s) => s.phase === 'defense' || (s.lastVoteResult && s.lastVoteResult.tie), 'the defense after Force tie');
  check(d.phase === 'defense', `Force tie led to ${d.phase}, expected defense`);
  check(!!d.lastVoteResult && Array.isArray(d.lastVoteResult.tie) && d.lastVoteResult.tie.length === 2 && pickIds.every((id) => d.lastVoteResult.tie.includes(id)),
    `the tie is ${JSON.stringify(d.lastVoteResult && d.lastVoteResult.tie)}, expected ${JSON.stringify(pickIds)}`);
  check(!!d.turn && d.turn.kind === 'defense' && pickIds.includes(d.turn.speakerId), 'the defense is not between the tied players');
  await shot(page, 'force-tie-defense');

  // 7. God view: the side panel shows every card, hidden ones included; only the seat that asked gets `god`
  await devClick(page, 'dev-god-toggle');
  const g = await waitSeat(page, 1, (s) => s.god && s.god.players && Object.keys(s.god.players).length === s.players.length, 'the god view in the host seat');
  await page.waitForSelector(`${sel('dev-god-panel')}:not([hidden])`, { visible: true, timeout: opts.timeout });
  const panel = await page.$$eval(sel('dev-god-card'), (els) => els.map((e) => ({ id: e.closest('[data-player-id]').getAttribute('data-player-id'), cat: e.getAttribute('data-category'), hidden: e.getAttribute('data-hidden') === 'true', text: e.textContent })));
  const hiddenCells = panel.filter((c) => c.hidden);
  check(hiddenCells.length > 0, 'the god panel marks no hidden card (every card is face up?)');
  check(hiddenCells.every((c) => c.text && c.text !== '—' && c.text === g.god.players[c.id].cards[c.cat]), 'a hidden card in the god panel is empty or differs from the god view');
  check(hiddenCells.every((c) => g.players.find((p) => p.id === c.id).cards[c.cat] === null), 'the god panel marks a face-up card as hidden');
  check(panel.length === g.players.length * 8, `the god panel shows ${panel.length} cards, expected ${g.players.length * 8}`);
  const others = await Promise.all([2, 3, 4].map((k) => seatState(page, k)));
  check(others.every((s) => s && s.god === undefined), 'a seat that did not ask for it got the god view');
  run.stats.god = { hiddenShown: hiddenCells.length, cards: panel.length };
  log(`god view: ${hiddenCells.length} hidden cards shown of ${panel.length}`);
  await shot(page, 'god-view');

  // 8. layouts: focus a seat, tabs, back to the grid
  await devClick(page, 'dev-seat-focus', '[data-seat="3"]');
  await sleep(300);
  const sc = await page.$$eval(sel('dev-seat'), (els) => els.map((e) => [e.getAttribute('data-seat'), Number(e.getAttribute('data-scale') || 0)]));
  const f3 = sc.find(([k]) => k === '3');
  check(f3 && sc.every(([k, s]) => k === '3' || s < f3[1]), `focus did not enlarge seat 3: ${JSON.stringify(sc)}`);
  await shot(page, 'focus-P3');
  await devClick(page, 'dev-layout-tabs');
  await devClick(page, 'dev-tab', '[data-seat="2"]');
  await sleep(300);
  const vis = await page.$$eval(sel('dev-seat'), (els) => els.filter((e) => getComputedStyle(e).visibility === 'visible').map((e) => e.getAttribute('data-seat')));
  check(vis.length === 1 && vis[0] === '2', `tabs show seats ${JSON.stringify(vis)}, expected only 2`);
  await shot(page, 'tabs-P2');
  await devClick(page, 'dev-layout-grid');
  await devClick(page, 'dev-seat-focus', '[data-seat="3"]');   // unfocus: back to the plain grid

  // 8b. "Open seat in a new tab": the tab takes the seat over (autojoin → Rejoin, as this browser holds that profile's
  // seat) and the frame says it was replaced; the frame's ⟳ takes the seat back
  const href = await page.$eval(sel('dev-seat-open', '[data-seat="4"]'), (e) => e.getAttribute('href'));
  check(href === `/?room=${room}&name=P4&profile=p4&autojoin=1`, `seat 4's "open in a new tab" link is ${href}`);
  const tab = await ctx.newPage();
  await tab.setViewport({ width: 390, height: 844 });
  await tab.goto(base + href, { waitUntil: 'domcontentloaded' });
  const tabId = await tab.waitForFunction(() => window.__bunkerState && window.__bunkerState.you.id, { timeout: opts.timeout }).then((h) => h.jsonValue()).catch(() => null);
  check(tabId === ids[4], `the new tab is ${tabId}, expected P4's seat ${ids[4]}`);
  await page.bringToFront();
  await waitTable(page, (x) => x.seats.find((q) => q.k === 4).screen === 'replaced', 'seat 4\'s frame to say it was replaced by the new tab');
  await shot(page, 'seat-4-opened-in-a-tab');
  await devClick(page, 'dev-seat-reload', '[data-seat="4"]');
  await waitTable(page, (x) => { const q = x.seats.find((z) => z.k === 4); return q.screen === 'room' && q.id === ids[4]; }, 'seat 4 to take its seat back after ⟳');
  const tabGone = await tab.waitForFunction(() => !!document.querySelector('[data-act="take-over"]'), { timeout: 5000 }).then(() => true, () => false);
  check(tabGone, 'the new tab was not told that the seat went back to the table');
  await tab.close();
  log('seat 4: opened in a new tab (took the seat over), then taken back with ⟳');

  // 9. every op was logged "[dev] …" by the server
  const fin = await seatState(page, 1);
  const lines = devLines(fin);
  for (const re of [/seed/, /added 2 bots/, /every timer to 5 s/, /gave P1 the special/, /gave P2 the special/, /auto-revealed/, /skipped ahead/, /forced a tie/, /god view on/]) {
    check(lines.some((x) => re.test(x)), `no "[dev]" log line matching ${re}: ${JSON.stringify(lines)}`);
  }
  run.stats.devLines = lines.length;
  t = await table(page);
  check(t.seats.every((s) => s.errors === 0), `a seat reported errors: ${JSON.stringify(t.log.filter((l) => /✖/.test(l)))}`);

  // 9b. one seat reads the catastrophe: a new test game with the sound on P3 (its frame reloads, and from here on only the
  // table's own page is evaluated and clicked until the Start: P3's autoplay rests on allow="autoplay" and that click)
  await page.select(sel('dev-sound'), '3');
  await devClick(page, 'dev-new-game');
  t = await waitTable(page, (x) => x.room && x.room !== room && !x.busy && x.seats.length === 4 && x.seats.every((q) => q.phase === 'lobby' && q.id && q.ready), '4 seats in the lobby of a second test game');
  await waitTable(page, (x) => x.sound === 3 && x.soundMode === 3 && x.seats.every((q) => q.narr && q.narr.on === (q.k === 3)), 'the sound on P3');
  await devClick(page, 'dev-start');
  await waitTable(page, (x) => x.seats.every((q) => q.phase === 'reveal'), 'the second test game to start');
  await waitSound(page, 3, 'the Start with the sound on P3');
  await shot(page, 'sound-P3');
  // ▶ Listen in P2 moves the sound there; P3 stops
  await seatClick(page, 2, 'narrator-play', '', 'P2\'s ▶ Listen');
  await waitSound(page, 2, '▶ Listen in P2');
  // the switch in P4 moves it again; P2 stops; P4's own saved switch stays as it was (unset)
  await seatClick(page, 4, 'narrator-menu', '', 'P4\'s narrator button');
  const note4 = await (await seatFrame(page, 4)).$eval(sel('narrator-table-note'), (e) => e.textContent).catch(() => '');
  check(/P2 has the sound/.test(note4), `P4's narrator popover says ${JSON.stringify(note4)}, expected that P2 has the sound`);
  await seatClick(page, 4, 'narrator-toggle', '', 'P4\'s narrator switch');
  t = await waitTable(page, (x) => x.sound === 4 && x.seats.every((q) => q.narr && q.narr.on === (q.k === 4) && !['playing', 'loading'].includes(q.narr.status)), 'the sound on P4 after its switch (P2 stopped)');
  await shot(page, 'sound-P4-switch');
  const saved4 = await page.evaluate(() => localStorage.getItem('bunker.narrator@p4'));
  check(saved4 === null, `the table changed P4's saved narrator switch: ${saved4}`);
  await seatClick(page, 4, 'narrator-menu', '', 'P4\'s narrator button (close)');
  run.stats.sound = { start: 'P3', listen: 'P2', switch: 'P4' };
  log('sound: P3 read the catastrophe at the Start, ▶ Listen moved it to P2, the switch to P4; never two at once');

  // 10. without BUNKER_DEV: no /dev, no /devinfo, and ?autojoin=1 is ignored (SPEC §11 X9.2/X9.3)
  await noDevChecks();
}

/** Seat k reads the catastrophe (its narrator plays) and no other seat plays anything; read from the table's snapshot. */
async function waitSound(page, k, what) {
  const t = await waitTable(page, (x) => x.sound === k && x.seats.every((q) => q.narr && (q.k === k ? q.narr.status === 'playing' : !q.narr.on && !['playing', 'loading'].includes(q.narr.status))),
    `P${k} alone to play the catastrophe after ${what}`);
  const top = await page.$eval(sel('dev-sound-status'), (e) => ({ text: e.textContent, status: e.getAttribute('data-status') }));
  check(top.status === 'playing' && top.text.includes(`P${k}`), `the top bar says ${JSON.stringify(top)} while P${k} plays`);
  const badge = await page.$eval(sel('dev-seat-sound', `[data-seat="${k}"]`), (e) => e.textContent).catch(() => '');
  check(/playing/.test(badge), `P${k}'s header badge reads ${JSON.stringify(badge)}, expected "🔊 playing"`);
  return t;
}

async function playAirlock(page, k, targetId) {
  await seatClick(page, k, 'special-btn', '[data-effect="airlock"]', `P${k}'s Airlock`);
  await seatClick(page, k, 'target-option', `[data-player-id="${targetId}"]`, 'the target P3');
  await seatClick(page, k, 'special-confirm-btn', '', 'Play');
  log(`P${k} played the Airlock on P3 through its seat frame`);
}

async function noDevChecks() {
  const srv = await spawnServer(false);
  const base = srv.url;
  for (const p of ['/dev', '/devinfo', '/dev.js', '/dev.html']) {
    const r = await fetch(base + p);
    check(r.status === 404, `without BUNKER_DEV, GET ${p} answered ${r.status}, expected 404`);
  }
  const hdr = (await fetch(base + '/')).headers.get('x-frame-options');
  check(hdr === 'DENY', `without BUNKER_DEV, / has X-Frame-Options ${hdr}, expected DENY`);
  // a real room on that server, and a page opened with an autojoin link to it: it must stay on the landing page
  const ctx = await run.browser.createBrowserContext();
  const host = await ctx.newPage();
  await host.setViewport({ width: 1100, height: 800 });
  await host.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await host.waitForSelector(sel('name-input'));
  await host.type(sel('name-input'), 'Host');
  await host.click(sel('create-btn'));
  await host.waitForFunction(() => window.__bunkerState && window.__bunkerState.phase === 'lobby', { timeout: opts.timeout });
  const room = await host.evaluate(() => window.__bunkerState.room);
  const guest = await ctx.newPage();
  await guest.setViewport({ width: 390, height: 844 });
  await guest.goto(`${base}/?room=${room}&name=Zed&profile=zz&autojoin=1`, { waitUntil: 'domcontentloaded' });
  await guest.waitForSelector(sel('join-btn'));
  await sleep(2000);
  const g = await guest.evaluate(() => ({ state: !!window.__bunkerState, tag: (document.querySelector('[data-testid="profile-tag"]') || {}).textContent || '' }));
  const hs = await host.evaluate(() => window.__bunkerState.players.length);
  check(!g.state && hs === 1, `without dev mode ?autojoin=1 joined anyway (guest in a room: ${g.state}, players ${hs})`);
  check(g.tag === 'Profile: zz', `the landing's profile tag reads ${JSON.stringify(g.tag)}`);
  await guest.screenshot({ path: path.join(opts.screens, `${String(++run.shots).padStart(2, '0')}-no-dev-autojoin-ignored.png`) });
  log(`without dev mode: /dev, /devinfo 404, X-Frame-Options DENY, autojoin ignored (${room})`);
  await ctx.close();
}

async function cleanup() {
  if (run.browser) await run.browser.close().catch(() => {});
  for (const s of run.servers) if (!s.exited) s.child.kill('SIGTERM');
}

let ok = false;
try {
  await main();
  ok = run.failures.length === 0 && run.consoleErrors.length === 0;
} catch (e) {
  run.failures.push(e instanceof StepError ? `STUCK: ${e.message}` : (e.stack || String(e)));
  log(`FAILED: ${e.message}`);
  try {
    const pages = run.browser ? (await Promise.all((await run.browser.browserContexts()).map((c) => c.pages()))).flat() : [];
    for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(opts.screens, `FAIL-${i}.png`) }).catch(() => {});
  } catch { /* ignore */ }
} finally {
  await cleanup();
}
for (const c of run.consoleErrors) log(`console error: ${c}`);
log(`stats: ${JSON.stringify(run.stats)}`);
if (ok) log(`DEV SMOKE PASSED in ${((Date.now() - T0) / 1000).toFixed(1)} s; ${run.shots} screenshots in ${path.relative(ROOT, opts.screens)}`);
else { for (const f of run.failures) log(`FAILURE: ${f}`); log('DEV SMOKE FAILED'); }
process.exit(ok ? 0 : 1);
