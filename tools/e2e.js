#!/usr/bin/env node
// Bunker Online: browser end-to-end run (puppeteer-core + /usr/bin/google-chrome-stable).
// Drives the client ONLY through the SPEC §10 data-testid hooks and window.__bunkerState, so one script tests any
// client that follows §10. Run `node tools/e2e.js --help`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import {
  AIRLOCK_SEALED_RE, BOT_NAMES, Bot, Coordinator, airlockVictims, allowedCategories, describeState, eligibleReveal, makeRng, pick, playableSpecials,
  playerById, stepRefOf, validTargets,
} from './botlib.js';
import { estimateGame } from '../public/kicks.js';
import { airlockOf, finalCause } from '../public/loglines.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const MOBILE_RESIZE = { width: 390, height: 844, deviceScaleFactor: 2 }; // for the host page (no isMobile toggle: that reloads)

const HELP = `Bunker Online browser e2e (puppeteer-core + ${CHROME}).

  node tools/e2e.js                                   spawn the server (./public) on a free port and run
  node tools/e2e.js --public-dir clients/a            spawn the server with BUNKER_PUBLIC_DIR=clients/a
  node tools/e2e.js --url http://127.0.0.1:8080       run against a running server

Options:
  --url URL          use a running server instead of spawning one
  --public-dir DIR   client directory for the spawned server (BUNKER_PUBLIC_DIR); default ./public
  --screens DIR      screenshot directory (default reports/screens/e2e)
  --players N        players in total, humans included (default 6, min 2, max 16); bots fill the seats beyond 2 humans
  --seed S           seed for the server, the bots and the humans' choices (default 1)
  --timeout MS       how long any single step may take before the run fails as stuck (default 20000)
  --headful          show the browser windows
  --slow             human-watchable pace (slower bots, pauses between clicks, slowMo)
  --strict-layout    fail when a mobile screenshot shows horizontal scrolling (otherwise a warning)
  -h, --help         this text

Flow: host creates a game via the UI; a 2nd human joins through the room link (mobile 390x844); a 3rd context watches
as a spectator; bots fill the other seats; the host starts; both humans play every turn via reveal-btn / end-turn-btn,
vote via vote-btn; the host drives with next-btn / close-vote-btn; one special is played through the Play flow;
the 2nd human's page is reloaded mid-game and must resume; on the final the host presses Play again.
Owner features (SPEC §11 X1/X3/X4): the lobby's estimated game length (every viewer; it follows the presets and an
unsent timer edit), a special card chip's popover (hover on desktop, tap on the phone), and the airlock UI (a bot, else
a human through the Play flow, opens an airlock: badge, alert, bar, a human's "join" hint and picker; a failure when it
cannot run with 4+ players; skipped under 4 or when the server sends no \`airlocks\`), and a human's revive of an
airlock victim through the Play flow when the deal gives a human "Back from the Forest". When a bot opens the airlock,
a human holding an Airlock first aims it at the same player (Confirm), and the view that opens the airlock must hold
Play with a note; the airlock is then closed from the alert's "Join" button, which opens on Confirm (SPEC §11 FX2).
At the end, the mock final "hostile-names" checks that names with 🚪 and quoted titles stay names, and the popover
edge cases (a pinned chip scrolled out of the log; a chip pinned with Space, then Tab) (SPEC §11 FX1/FX3). Then more
mock screens (SPEC §11, client-fixer f2): a table cell's popover closes when the mouse or the focus moves onto a cell
that fits, only cut-off cells are Tab stops, long names wrap in the Airlock's Confirm and Join, two join targets in
opening order, spent airlocks threaten nobody, the round track's played votes, and the lobby estimate in every bar.
Live (f2): the airlock copy never says "before the vote", Esc gives the focus back to the button that opened the
picker, a resume answered with server_busy is retried with a banner, and the host's own Next into a vote holds the
vote choices for a moment.
End game (SPEC §11 X6): after Play again the host starts a second game, a late arrival opens the link and can only watch;
mid-round the host ends it with end-game-btn (a double click only arms it, a second tap sends endGame); everyone is back
in the lobby, same seats, is told why (flash, lobby bar, the log line); the late arrival takes a seat (on a full table
the host first kicks a bot) and the next game deals them in. Phone layout (X7): every phone-sized screenshot checks that
the page itself is not scrolled and the action bar ends flush with the bottom of the screen; the final banner is
brought into view inside the shell on the phone.
Narrator (public/narrator.js): the phone player turns it on in the lobby; at the start the catastrophe's clip plays on
that page by itself (Chrome runs with --autoplay-policy=no-user-gesture-required and --mute-audio), the host and the
spectator (switch off) stay silent, every page shows ▶ Listen, and the reload mid-game does not replay it.
Profiles and report links (SPEC §11 X9.1, X10): two tabs of ONE browser context with ?profile=alpha / ?profile=beta join
one room as two players, each resumes its own seat after a reload, the invite link has no profile, a tab without one
sees neither seat, and the narrator setting stays per profile. "Report an issue" / "Suggest an idea" are checked on the
landing footer, the header menu (lobby, in play, final), the rules sheet and the final screen: prefilled GitHub URLs
(template, version, a short browser summary, lang, room only in a room; URL-encoded; a new tab), and app-version reads
v<version.json's version> or vdev.
Languages (SPEC §11 X5.7/X5.8): every page reads English whatever the machine's locale (navigator.language is en-US
and bunker.lang is set to en when absent). On the landing page the host's EN | RU switch turns the page Russian at once
(on screen at 360 × 640, above the form), the choice is stored, a room code typed as «КМТХ» reads KMTX, and the switch
back restores English; the create hello says lang en. Bob (the phone) first taps the switch there and back (EN → RU
→ EN in 120 ms): no setLang goes out and his page never shows Russian; then again 650 ms apart over a throttled link
(both setLang go out, and the late answer in Russian is skipped: his page never shows it). Then he plays in Russian from
the start of game 1
through his first vote: the switch is sampled every 25 ms and after every render (the page's language, the log and his
hand never disagree; with a COMPLETE ru.js the action bar too), completes within 2 s, marks no card new, keeps his
narrator clip playing, changes nothing on the host's or the spectator's page, keeps the log and the bar status out of
aria-live for the render that changes the language, and while it waits the switch is named in the chosen language
(aria-busy, lang); a chip shows his card's Russian title and so does its popover. Around a reconnect over a throttled
link he switches to English while the page waits to reconnect, and back to Russian while the resume's hello is on its
way: no sample mixes two languages without the connection banner, and the second switch flips the page once; the
airlock checks compare with the words of his language; after the reload he is still Russian and the resume carried the
language; then he switches back over a throttled link (the answer takes about 3 s): the page stays wholly Russian until
it lands, then changes in one render. On both phones in play the header's timer label keeps ≥ 59 px. Dana (the late
arrival) has a Russian browser and a 360 × 640 phone: her first visit is Russian, her join carries lang ru, and at four
points (watching game 2, the lobby after End game, seated, game 3) her page has no Latin letter beyond names, the room
code, EN/RU and °C/3D/USB (text nodes and the text CSS writes: ::before/::after), no horizontal scroll and the bar
flush. Checks that need Russian client words are warnings until public/i18n/ru.js
says COMPLETE.
Slow link (SPEC §11 X5.2): once, from round 2, the host's Next at the end of a discussion goes out over a link throttled
so that its answer takes about 2 × ANSWER_MS: no "No answer from the server" toast, no new socket, no banner, and the
answer shows when it lands.
Exit code 0 = pass, 1 = failure (message, screenshots FAIL-*.png and state dumps in the screens directory).`;

function parseArgs(argv) {
  const o = { players: 6, seed: '1', timeout: 20000, screens: path.join(ROOT, 'reports', 'screens', 'e2e') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--headful') o.headful = true;
    else if (a === '--slow') o.slow = true;
    else if (a === '--strict-layout') o.strictLayout = true;
    else if (/^--(url|public-dir|screens|players|seed|timeout)$/.test(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      o[a.slice(2).replace('-d', 'D')] = v;
    } else throw new Error(`unknown argument ${a}`);
  }
  o.players = Number(o.players);
  o.timeout = Number(o.timeout);
  if (!Number.isInteger(o.players) || o.players < 2 || o.players > 16) throw new Error('--players must be 2..16');
  if (!Number.isFinite(o.timeout) || o.timeout < 1000) throw new Error('--timeout must be >= 1000 ms');
  o.screens = path.resolve(o.screens);
  if (o.publicDir) o.publicDir = path.resolve(o.publicDir);
  return o;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`${e.message}\n\n${HELP}`);
  process.exit(2);
}
if (opts.help) { console.log(HELP); process.exit(0); }

const T0 = Date.now();
const SLOW = !!opts.slow;
const PAUSE = SLOW ? 900 : 120; // between human UI steps
const TIMEOUT = SLOW ? opts.timeout * 3 : opts.timeout;
const rng = makeRng(`${opts.seed}:humans`);
const log = (...a) => console.log(`[e2e +${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = {
  server: null, browser: null, bots: [], pages: [], shots: 0, failures: [], warnings: [], consoleErrors: [],
  stats: { hookRereads: 0, hostTurns: 0, bobTurns: 0, hostVotes: 0, bobVotes: 0, defenseTurns: 0, nextClicks: 0, closeVoteClicks: 0, special: null, reload: null, errorToasts: [], sentSteps: {}, twoTap: null, clickThrough: null,
    estimate: null, popover: null, airlock: null, airlockBadgeChecks: 0, narrator: null, endGame: null, barFlush: 0 },
};

class StuckError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// languages (SPEC §11 X5.7/X5.8; reports/i18n-design.md §9.7). The client's own dictionaries (of the client under test)
// render what a page in either language must say, so a check on a Russian page compares with the Russian words.

const I18N = { t: null, setLang: null, lang: null, ruComplete: false, loaded: false };
async function loadI18n() {
  const base = opts.publicDir || path.join(ROOT, 'public');
  try {
    const m = await import(pathToFileURL(path.join(base, 'i18n', 'index.js')).href);
    const ru = await import(pathToFileURL(path.join(base, 'i18n', 'ru.js')).href);
    Object.assign(I18N, { t: m.t, setLang: m.setLang, lang: m.lang, ruComplete: ru.COMPLETE === true, loaded: true });
  } catch (e) {
    run.warnings.push(`no client dictionaries at ${base}/i18n (${e.message}): the language checks are skipped`);
  }
}
/** `key` rendered in `lang` by the client's own dictionary (the module's language is put back). */
function L(lang, key, params) {
  if (!I18N.loaded) return null;
  const was = I18N.lang();
  I18N.setLang(lang, { store: false });
  try { return I18N.t(key, params); } finally { I18N.setLang(was, { store: false }); }
}
/** The language a page shows (its <html lang>, which the client sets with the dictionary). */
async function pageLang(P) { return P.page.evaluate(() => document.documentElement.lang).catch(() => 'en'); }
const CYR = /[А-Яа-яЁё]/;
/** A check that needs Russian client words: a failure once ru.js is COMPLETE, a warning while it is being written. */
function checkRu(cond, msg) {
  if (cond) return true;
  if (I18N.ruComplete) return check(false, msg);
  const w = `${msg} (public/i18n/ru.js is not COMPLETE yet: a warning until it is)`;
  if (!run.warnings.includes(w)) run.warnings.push(w);
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// server

async function spawnServer() {
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', BUNKER_SEED: String(opts.seed), BUNKER_MIN_PLAYERS: '2', BUNKER_NO_LIMITS: '1' };
  if (opts.publicDir) env.BUNKER_PUBLIC_DIR = opts.publicDir;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const srv = { child, out: '', err: '', url: null, exited: null };
  child.stdout.on('data', (d) => { srv.out += d; });
  child.stderr.on('data', (d) => { srv.err += d; });
  child.on('exit', (code, signal) => { srv.exited = { code, signal }; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${srv.out}\n${srv.err}`)), 10000);
    const check = () => {
      const m = /listening on https?:\/\/[^\s:]+:(\d+)/.exec(srv.out);
      if (m) { clearTimeout(timer); srv.url = `http://127.0.0.1:${m[1]}`; resolve(); }
    };
    child.stdout.on('data', check);
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`server exited:\n${srv.out}\n${srv.err}`)); });
  });
  return srv;
}

// ---------------------------------------------------------------------------------------------------------------
// pages

const sel = (id, extra = '') => `[data-testid="${id}"]${extra}`;

async function newPage(context, name, viewport, o = {}) {
  const page = await context.newPage();
  await page.setViewport(viewport);
  // SPEC §11 X5.7/X5.8 (reports/i18n-design.md §9.7): the pages read English, whatever the runner's locale. A page's
  // first visit follows navigator.language (overridden here; --lang is not reliable in headless Chrome), and the stored
  // choice (bunker.lang) is set only when absent, so a page's own switch survives its reload. o.lang: another language.
  await page.evaluateOnNewDocument((lang) => {
    const tag = lang === 'ru' ? 'ru-RU' : 'en-US';
    try {
      Object.defineProperty(Navigator.prototype, 'language', { get: () => tag, configurable: true });
      Object.defineProperty(Navigator.prototype, 'languages', { get: () => [tag, tag.slice(0, 2)], configurable: true });
    } catch { /* keep the browser's own */ }
    try {
      // (the key as public/profile.js pkey() names it: a ?profile= tab keeps its own, SPEC §11 X9.1)
      const prof = new URLSearchParams(location.search).get('profile');
      const key = prof && /^[a-z0-9_-]{1,16}$/.test(prof) ? `bunker.lang@${prof}` : 'bunker.lang';
      if (lang !== 'ru' && localStorage.getItem(key) === null) localStorage.setItem(key, 'en');
    } catch { /* no storage */ }
  }, o.lang || 'en');
  // visible = rendered with a box and not visibility:hidden (offsetParent is null for position:fixed elements)
  await page.evaluateOnNewDocument(() => {
    window.__e2eVisible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
    // SPEC §11 R1: record every turn/ballot action the client sends, with the step shown by __bunkerState at that moment
    window.__e2eSent = [];
    window.__e2eResumes = 0;
    window.__e2eFakeBusy = 0;
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      try {
        const m = JSON.parse(d);
        if (m.t === 'resume') window.__e2eResumes++;
        // SPEC §11 X5.1: the language each hello carries, and how many setLang this page sent
        if (['create', 'join', 'resume'].includes(m.t)) (window.__e2eHellos = window.__e2eHellos || []).push({ t: m.t, lang: m.lang ?? null });
        if (m.t === 'setLang') window.__e2eSetLang = (window.__e2eSetLang || 0) + 1;
        // busyResumeTest: the next resume is answered as a network over its V2 budget is (SPEC §11 V2), not sent
        if (m.t === 'resume' && window.__e2eFakeBusy > 0) {
          window.__e2eFakeBusy--;
          const sock = this;
          setTimeout(() => sock.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'error', code: 'server_busy', message: 'Too many wrong room codes from your network. Wait a minute and try again.' }) })), 30);
          return undefined;
        }
        if (['reveal', 'endTurn', 'next', 'closeVote', 'vote', 'leave', 'kick', 'special', 'setOptions', 'endGame', 'takeSeat'].includes(m.t)) {
          const s = window.__bunkerState;
          window.__e2eSent.push({ t: m.t, at: m.at === undefined ? null : m.at, target: m.targetId || m.playerId || null, ts: Date.now(),
            now: s ? { phase: s.phase, round: s.round, overtime: !!s.overtime, turnIndex: s.turn ? s.turn.index : null, ballot: s.vote ? s.vote.ballot : null, stage: s.vote ? s.vote.stage : null } : null });
        }
      } catch { /* not JSON */ }
      return origSend.call(this, d);
    };
  });
  const P = { name, page, viewport, vpName: viewport.width < 600 ? 'mobile' : 'desktop', id: null };
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = msg.location() || {};
    const entry = { page: name, text: msg.text(), url: loc.url || '' };
    if (/favicon\.ico/.test(entry.url) && /404/.test(entry.text)) { run.warnings.push(`${name}: favicon.ico 404 (add <link rel="icon">)`); return; }
    // SPEC §11 X10: deploy.sh writes public/version.json; a local run has none, and the client then says 'dev'
    if (/\/version\.json$/.test(entry.url) && /404/.test(entry.text)) return;
    run.consoleErrors.push(entry);
    log(`CONSOLE ERROR on ${name}: ${entry.text} ${entry.url}`);
  });
  page.on('pageerror', (err) => {
    run.consoleErrors.push({ page: name, text: `uncaught: ${err.message}` });
    log(`PAGE ERROR on ${name}: ${err.message}`);
  });
  page.on('dialog', async (d) => {
    run.failures.push(`${name}: a native ${d.type()} dialog appeared ("${d.message()}"); §10 forbids alert/confirm/prompt`);
    await d.dismiss().catch(() => {});
  });
  run.pages.push(P);
  return P;
}

async function state(P) {
  try {
    return await P.page.evaluate(() => (window.__bunkerState ? window.__bunkerState : null));
  } catch {
    return null; // navigating
  }
}

async function waitState(P, pred, what, timeout = TIMEOUT) {
  const t0 = Date.now();
  let s = null;
  for (;;) {
    s = await state(P);
    try { if (s && pred(s)) return s; } catch { /* keep polling */ }
    if (Date.now() - t0 > timeout) throw new StuckError(`${P.name}: timed out after ${timeout} ms waiting for ${what}; state: ${describeState(s)}`);
    if (run.server && run.server.exited) throw new Error(`the server exited: ${JSON.stringify(run.server.exited)}\n${run.server.err}`);
    await sleep(60);
  }
}

async function waitHook(P, id, extra = '', what = null, timeout = TIMEOUT) {
  try {
    return await P.page.waitForSelector(`${sel(id, extra)}:not([disabled])`, { visible: true, timeout });
  } catch {
    throw new StuckError(`${P.name}: timed out after ${timeout} ms waiting for an enabled, visible ${sel(id, extra)}${what ? ` (${what})` : ''}; state: ${describeState(await state(P))}`);
  }
}

/** Clicks an enabled, visible hook; re-queries when a re-render detached the node between the query and the click. */
async function click(P, id, extra = '', what = null) {
  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    const el = await waitHook(P, id, extra, what);
    try {
      await el.click();
      return el;
    } catch (e) {
      lastErr = e;
      if (!/detached|not clickable|not visible|no longer|Node is/i.test(e.message)) throw e;
      await sleep(80);
    }
  }
  throw new StuckError(`${P.name}: could not click ${sel(id, extra)} (re-rendered away ${6} times): ${lastErr && lastErr.message}`);
}

/**
 * Compares the enabled, visible hooks `id` (their `attr`) with expectFn(state), re-reading both for up to ~1.5 s so a
 * render that lags the state (or a transition) is not reported. expectFn returns null when the action is no longer due.
 */
async function stableHooks(P, id, attr, expectFn) {
  let last = null;
  for (let i = 0; i < 15; i++) {
    const s = await state(P);
    const expected = s ? expectFn(s) : null;
    const shown = await hookValues(P, id, attr).catch(() => []);
    last = { s, shown, expected, ok: expected !== null && sameSet(shown, expected), gone: expected === null };
    if (last.ok || last.gone) {
      if (i > 0) run.stats.hookRereads++;
      return last;
    }
    await sleep(100);
  }
  return last;
}

async function hookValues(P, id, attr, onlyEnabled = true) {
  return P.page.$$eval(sel(id), (els, a, en) => els
    .filter((e) => (!en || !e.disabled) && window.__e2eVisible(e))
    .map((e) => e.getAttribute(a)), attr, onlyEnabled);
}

async function typeInto(P, id, text) {
  const el = await waitHook(P, id);
  await el.evaluate((e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await el.type(text, { delay: SLOW ? 40 : 0 });
}

async function shot(label, pages = run.pages, { alsoMobile = false } = {}) {
  fs.mkdirSync(opts.screens, { recursive: true });
  const n = String(++run.shots).padStart(2, '0');
  for (const P of pages) {
    const file = path.join(opts.screens, `${n}-${label}-${P.name}-${P.vpName}.png`);
    if (P.vpName === 'mobile') await checkBarFlush(P, label);
    await P.page.screenshot({ path: file, fullPage: P.vpName === 'mobile' }).catch((e) => run.warnings.push(`screenshot ${file}: ${e.message}`));
    if (P.vpName === 'mobile') await checkOverflow(P, label);
    if (alsoMobile && P.vpName === 'desktop') {
      await P.page.setViewport(MOBILE_RESIZE);
      await sleep(250);
      await checkBarFlush(P, label);
      const f2 = path.join(opts.screens, `${n}-${label}-${P.name}-mobile.png`);
      await P.page.screenshot({ path: f2, fullPage: true }).catch((e) => run.warnings.push(`screenshot ${f2}: ${e.message}`));
      await checkOverflow(P, label);
      await P.page.setViewport(P.viewport);
      await sleep(150);
    }
  }
}

// SPEC §11 X7: on a phone the app shell is the whole screen and the page itself never scrolls, so the action bar ends
// flush with the bottom of the viewport (a scrolled page slid the shell up and left an empty band under the bar).
async function checkBarFlush(P, label) {
  const r = await P.page.evaluate(() => {
    const bar = document.querySelector('#app .shell .bar');
    if (!bar) return null;
    const b = bar.getBoundingClientRect();
    return { scrollY: window.scrollY, bottom: b.bottom, ih: window.innerHeight, sh: document.scrollingElement.scrollHeight };
  }).catch(() => null);
  if (!r) return;
  run.stats.barFlush++;
  check(r.scrollY === 0 && Math.abs(r.bottom - r.ih) <= 1 && r.sh <= r.ih + 1,
    `${P.name} @${label}: the action bar is not flush with the bottom of the screen (page scrollY ${r.scrollY}, bar bottom ${Math.round(r.bottom)} of ${r.ih}, page height ${r.sh}) (SPEC §11 X7)`);
}

async function checkOverflow(P, label) {
  const r = await P.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })).catch(() => null);
  if (r && r.sw > r.iw + 1) {
    const msg = `${P.name} @${label}: horizontal scroll at ${r.iw}px wide (scrollWidth ${r.sw}px); §10 wants none down to 360 px`;
    if (opts.strictLayout) run.failures.push(msg); else if (!run.warnings.includes(msg)) run.warnings.push(msg);
  }
}

async function collectToasts(P) {
  const toasts = await P.page.$$eval(sel('error-toast'), (els) => els.filter((e) => window.__e2eVisible(e))
    .map((e) => ({ code: e.getAttribute('data-code'), text: e.textContent.trim() }))).catch(() => []);
  for (const t of toasts) {
    const key = `${P.name}:${t.code}:${t.text}`;
    if (!run.stats.errorToasts.some((x) => x.key === key)) {
      run.stats.errorToasts.push({ key, page: P.name, ...t });
      log(`error-toast on ${P.name}: [${t.code}] ${t.text}`);
    }
  }
}

function sameSet(a, b) {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function check(cond, msg) {
  if (!cond) { run.failures.push(msg); log(`CHECK FAILED: ${msg}`); }
  return cond;
}

// SPEC §11 R1: every reveal / endTurn / next / closeVote / vote the client sends carries `at`, equal to the step shown
// by __bunkerState when it was sent ({phase, round, overtime, turnIndex, ballot, stage}), so a click that crosses another
// message in flight is refused by the server instead of landing on the next speaker or ballot.
const STEP_KEYS = ['phase', 'round', 'overtime', 'turnIndex', 'ballot', 'stage'];
// SPEC §11 K7: a special carries the same key without the turn index (who is speaking does not change what it does)
const SPECIAL_STEP_KEYS = STEP_KEYS.filter((k) => k !== 'turnIndex');
async function checkSentSteps(P) {
  const sent = await P.page.evaluate(() => { const x = window.__e2eSent || []; window.__e2eSent = []; return x; }).catch(() => []);
  for (const f of sent) {
    if (!['reveal', 'endTurn', 'next', 'closeVote', 'vote', 'special'].includes(f.t)) continue;
    run.stats.sentSteps[f.t] = (run.stats.sentSteps[f.t] || 0) + 1;
    const keys = f.t === 'special' ? SPECIAL_STEP_KEYS : STEP_KEYS;
    const ok = !!f.at && typeof f.at === 'object' && !!f.now && keys.every((k) => f.at[k] === f.now[k]);
    check(ok, `${P.name}: sent ${f.t} with at=${JSON.stringify(f.at)}, but the state shown then was ${JSON.stringify(f.now)} (SPEC §11 ${f.t === 'special' ? 'K7' : 'R1'})`);
  }
  return sent;
}

/**
 * Two real clicks on the same spot, `gap` ms apart (a double click / double tap). Returns what the FIRST click hit
 * (the page can re-render between measuring and clicking, e.g. a bot's special adds a tag to a row above).
 */
async function doubleClick(P, id, extra, gap = 150) {
  const el = await waitHook(P, id, extra);
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await sleep(50);
  const box = await el.boundingBox();
  if (!box) throw new StuckError(`${P.name}: ${sel(id, extra)} has no box to double-click`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await P.page.evaluate(() => {
    window.__e2eFirstHit = null;
    document.addEventListener('click', (e) => { const a = e.target instanceof Element ? e.target.closest('[data-testid]') : null; window.__e2eFirstHit = a ? a.getAttribute('data-testid') : null; }, { capture: true, once: true });
  });
  await P.page.mouse.click(x, y);
  await sleep(gap);
  const under = await P.page.evaluate(({ x: px, y: py }) => {
    const e = document.elementFromPoint(px, py);
    const a = e && e.closest('[data-act]');
    return a ? `${a.getAttribute('data-act')}${a.disabled ? ' (disabled)' : ''}` : e ? String(e.className) : null;
  }, { x, y }).catch(() => null);
  (run.stats.secondClicks = run.stats.secondClicks || []).push(`${P.name}:${id}→${under}`);
  await P.page.mouse.click(x, y);
  return P.page.evaluate(() => window.__e2eFirstHit).catch(() => null);
}
/** Double-clicks a two-tap hook until its first click really arms it (at most 3 tries, 1.2 s apart). */
async function doubleClickArming(P, id, extra) {
  for (let i = 0; i < 3; i++) {
    const hit = await doubleClick(P, id, extra);
    if (hit === id) return true;
    log(`${P.name}: the first click of the double click on ${sel(id, extra)} hit ${hit} (the page moved); again`);
    await sleep(1200);
  }
  return false;
}

// SPEC §11 K2/K6: in a game, leaving (or kicking a seated player) is for good, so one click only arms leave-btn /
// kick-btn and a second click a little later sends. One click must send nothing, and neither must a double click
// (two clicks 150 ms apart): its second click is not a deliberate second tap.
async function twoTapTest(host, bob) {
  const hs0 = await state(host);
  await checkSentSteps(bob);
  const leaveHit = await doubleClickArming(bob, 'leave-btn', '');
  check(leaveHit, 'bob: the double click never landed on leave-btn, so the K2/K6 check could not run');
  await sleep(600);
  const bobSent = await bob.page.evaluate(() => (window.__e2eSent || []).filter((f) => f.t === 'leave').length).catch(() => -1);
  const hs1 = await state(host);
  const b = hs1 && playerById(hs1, bob.id);
  const bs = await state(bob);
  check(bobSent === 0 && b && b.status !== 'left' && bs && bs.you && bs.you.id === bob.id,
    `bob: a DOUBLE click on leave-btn during ${hs0.phase} sent leave (frames ${bobSent}, status ${b && b.status}); in a game it must take two separate taps (SPEC §11 K2/K6)`);
  const victim = hs1 && hs1.players.find((p) => p.id !== host.id && p.id !== bob.id && p.status !== 'left');
  let kickSent = null;
  if (victim) {
    const kickHit = await doubleClickArming(host, 'kick-btn', `[data-player-id="${victim.id}"]`);
    check(kickHit, `host: the double click never landed on kick-btn for ${victim.name}, so the K2/K6 check could not run`);
    await sleep(600);
    kickSent = await host.page.evaluate(() => (window.__e2eSent || []).filter((f) => f.t === 'kick').length).catch(() => -1);
    const hs2 = await state(host);
    const v = hs2 && playerById(hs2, victim.id);
    check(kickSent === 0 && v && v.status !== 'left', `host: a DOUBLE click on kick-btn for ${victim.name} during ${hs0.phase} kicked them (frames ${kickSent}, status ${v && v.status}); in a game it must take two separate taps (SPEC §11 K2/K6)`);
  }
  // the second click must not have landed on anything else either (a row that expands, another button)
  const expanded = await host.page.$$eval('[aria-expanded="true"].who-main', (els) => els.map((e) => e.closest('[data-player-id]').getAttribute('data-player-id'))).catch(() => null);
  check(!expanded || expanded.length === 0, `host: the double click on kick-btn expanded row(s) ${JSON.stringify(expanded)}: its second click reached what moved under the pointer (SPEC §11 K6)`);
  run.stats.twoTap = { phase: hs0.phase, round: hs0.round, leaveFrames: bobSent, kickFrames: kickSent, hostRowsExpanded: expanded };
  log(`two-tap guard: a double click on leave-btn (bob) and on kick-btn (host) sent nothing`);
}

// ---------------------------------------------------------------------------------------------------------------
// human actions

async function playMyTurn(P, s, statKey) {
  const me = s.you.id;
  if (s.phase === 'reveal') {
    const elig = eligibleReveal(s);
    if (!s.turn.hasRevealed && elig.length) {
      await waitHook(P, 'reveal-btn', '', 'my reveal buttons');
      await sleep(PAUSE);
      const due = (x) => (x.phase === 'reveal' && x.turn && x.turn.speakerId === me && !x.turn.hasRevealed && x.round === s.round ? eligibleReveal(x) : null);
      const r = await stableHooks(P, 'reveal-btn', 'data-category', due);
      if (r.gone) return;
      const shown = r.shown;
      check(r.ok, `${P.name} round ${s.round}: reveal-btn categories ${JSON.stringify(shown)} != eligible ${JSON.stringify(r.expected)}`);
      if (s.round === 1) check(shown.length === 1 && shown[0] === 'profession', `${P.name}: round 1 must offer only profession, got ${JSON.stringify(shown)}`);
      const cat = s.round === 1 ? 'profession' : pick(rng, r.expected.length ? r.expected : elig);
      if (!run.firstRevealShot) { run.firstRevealShot = true; await shot('my-reveal-turn', [P]); }
      await click(P, 'reveal-btn', `[data-category="${cat}"]`);
      await waitState(P, (x) => !(x.turn && x.turn.speakerId === me && x.round === s.round && x.phase === 'reveal' && !x.turn.hasRevealed), `my reveal of ${cat} to register`);
      log(`${P.name} revealed ${cat} (round ${s.round})`);
      return;
    }
    await sleep(PAUSE);
    await click(P, 'end-turn-btn', '', 'End turn');
    await waitState(P, (x) => !(x.turn && x.turn.speakerId === me && x.turn.index === s.turn.index && x.phase === s.phase && x.round === s.round), 'the turn to pass after End turn');
    run.stats[statKey]++;
    log(`${P.name} ended turn (round ${s.round})`);
  } else if (s.phase === 'defense') {
    if (!run.defenseShot) { run.defenseShot = true; await shot('defense', run.pages); }
    await sleep(PAUSE);
    await click(P, 'end-turn-btn', '', 'End turn in defense');
    await waitState(P, (x) => !(x.phase === 'defense' && x.turn && x.turn.speakerId === me && x.turn.index === s.turn.index), 'the defense turn to pass');
    run.stats.defenseTurns++;
    log(`${P.name} ended the defense speech`);
  }
}

/**
 * Like waitHook, but gives up (returns null) as soon as the action is no longer due: a hook that a client holds
 * disabled for a moment (SPEC §11 F1/K1) may never be enabled if the step ends meanwhile (a special cancels the vote).
 */
async function waitHookWhileDue(P, id, dueFn, what) {
  const t0 = Date.now();
  for (;;) {
    const el = await P.page.waitForSelector(`${sel(id)}:not([disabled])`, { visible: true, timeout: 400 }).catch(() => null);
    if (el) return el;
    const s = await state(P);
    if (s && !dueFn(s)) return null;
    if (Date.now() - t0 > TIMEOUT) throw new StuckError(`${P.name}: timed out after ${TIMEOUT} ms waiting for an enabled, visible ${sel(id)} (${what}); state: ${describeState(s)}`);
  }
}

async function castVote(P, s0, statKey) {
  const me = s0.you.id;
  const due = (x) => (x.phase === 'vote' && x.vote && x.me && !x.me.myVote && x.vote.voters.includes(me) ? x.vote.candidates.filter((id) => id !== me) : null);
  if (!(await waitHookWhileDue(P, 'vote-btn', (x) => due(x) !== null, 'vote buttons'))) return; // the ballot ended first
  await sleep(PAUSE);
  const r = await stableHooks(P, 'vote-btn', 'data-player-id', due);
  if (r.gone) return; // the ballot moved on before we voted: the main loop will look again
  const s = r.s;
  const shown = r.shown;
  check(r.ok, `${P.name} ballot ${s.vote.ballot}/${s.vote.stage}: vote-btn ids ${JSON.stringify(shown)} != candidates minus me ${JSON.stringify(r.expected)}`);
  if (!run.voteShot) { run.voteShot = true; await shot('vote', run.pages, { alsoMobile: true }); }
  const target = pick(rng, shown.length ? shown : r.expected);
  await click(P, 'vote-btn', `[data-player-id="${target}"]`);
  // double-send guard (SPEC §11 F1, K1): right after a vote every vote-btn is disabled, so a second click of a double
  // click can never land on another name (or on the next ballot's list once this vote closes the ballot)
  const enabledAfter = await hookValues(P, 'vote-btn', 'data-player-id').catch(() => []);
  check(enabledAfter.length === 0, `${P.name}: vote-btn still enabled right after voting (${JSON.stringify(enabledAfter)}): a double click would send a 2nd vote`);
  await waitState(P, (x) => x.phase !== 'vote' || !x.vote || x.vote.ballot !== s.vote.ballot || x.vote.stage !== s.vote.stage || (x.me && x.me.myVote), 'my vote to register');
  run.stats[statKey]++;
  log(`${P.name} voted against ${playerById(s, target) ? playerById(s, target).name : target}`);
}

/** The §10 Play flow: special-btn -> target-option -> category-option -> special-confirm-btn. */
async function playSpecial(P) {
  const s = await state(P);
  const buttons = await P.page.$$eval(sel('special-btn'), (els) => els.filter((e) => !e.disabled && window.__e2eVisible(e))
    .map((e) => ({ uid: e.getAttribute('data-uid'), effect: e.getAttribute('data-effect'), target: e.getAttribute('data-target') })));
  if (!buttons.length) return false;
  const expectPlayable = new Map();
  for (const x of playableSpecials(s)) expectPlayable.set(x.special.uid, x);
  if (!sameSet(buttons.map((x) => x.uid), [...expectPlayable.keys()])) {
    await sleep(250); // the DOM may lag the state by a render
    const s2 = await state(P);
    const b2 = await P.page.$$eval(sel('special-btn'), (els) => els.filter((e) => !e.disabled && window.__e2eVisible(e)).map((e) => e.getAttribute('data-uid')));
    const p2 = playableSpecials(s2).map((x) => x.special.uid);
    check(sameSet(b2, p2), `${P.name}: enabled special-btn uids ${JSON.stringify(b2)} != playable specials per §5 ${JSON.stringify(p2)}`);
  }
  if (!buttons.every((x) => expectPlayable.has(x.uid))) return false;
  const calm = buttons.filter((b) => !['eject', 'airlock', 'capacity_plus', 'capacity_minus', 'cancel_vote'].includes(b.effect));
  const b = (calm.length ? calm : buttons)[0];
  const sp = s.me.specials.find((x) => x.uid === b.uid);
  check(sp && sp.effect === b.effect && sp.target === b.target, `${P.name}: special-btn data-effect/data-target do not match me.specials for ${b.uid}`);
  log(`${P.name} plays special "${sp ? sp.title : b.uid}" (${b.effect}, target ${b.target}, category ${sp ? sp.category : '?'})`);
  await sleep(PAUSE);
  await click(P, 'special-btn', `[data-uid="${b.uid}"]`);
  let targetId = null;
  if (b.target === 'other' || b.target === 'ejected') {
    await waitHook(P, 'target-option', '', 'target options');
    const r = await stableHooks(P, 'target-option', 'data-player-id', (cur) => validTargets(cur, sp).filter((t) => allowedCategories(cur, sp, t).length > 0));
    const shown = r.shown;
    check(r.ok, `${P.name}: target-option ids ${JSON.stringify(shown)} != valid targets ${JSON.stringify(r.expected)}`);
    await shot('special-target-picker', [P]);
    targetId = pick(rng, shown);
    await sleep(PAUSE);
    await click(P, 'target-option', `[data-player-id="${targetId}"]`);
  }
  let category = null;
  if (sp.category === 'choose') {
    await waitHook(P, 'category-option', '', 'category options');
    const r = await stableHooks(P, 'category-option', 'data-category', (cur) => allowedCategories(cur, sp, targetId));
    const shown = r.shown;
    check(r.ok, `${P.name}: category-option ${JSON.stringify(shown)} != allowed ${JSON.stringify(r.expected)}`);
    if (!targetId) await shot('special-category-picker', [P]);
    category = pick(rng, shown);
    await sleep(PAUSE);
    await click(P, 'category-option', `[data-category="${category}"]`);
  }
  await waitHook(P, 'special-confirm-btn', '', 'the confirm button');
  if (b.target !== 'other' && b.target !== 'ejected') {
    const stray = await hookValues(P, 'target-option', 'data-player-id', false);
    check(stray.length === 0, `${P.name}: target-option shown for a special with target ${b.target}`);
  }
  if (sp.category !== 'choose') {
    const stray = await hookValues(P, 'category-option', 'data-category', false);
    check(stray.length === 0, `${P.name}: category-option shown for a special with category ${sp.category}`);
  }
  await shot('special-confirm', [P]);
  await sleep(PAUSE);
  // SPEC §11 K6 click-through shield: right after Play closes the sheet, no action hook on this page may be enabled, so
  // the second click of a double click cannot land on the Next / vote / reveal button that was under the sheet
  await P.page.evaluate(() => {
    window.__e2eConfirmAt = null;
    document.addEventListener('click', (e) => { if (e.target instanceof Element && e.target.closest('[data-testid="special-confirm-btn"]')) window.__e2eConfirmAt = Date.now(); }, { capture: true, once: true });
  });
  await click(P, 'special-confirm-btn');
  const ct = await P.page.evaluate(() => ({
    since: window.__e2eConfirmAt ? Date.now() - window.__e2eConfirmAt : null,
    enabled: [...document.querySelectorAll('[data-testid="next-btn"],[data-testid="close-vote-btn"],[data-testid="vote-btn"],[data-testid="reveal-btn"],[data-testid="end-turn-btn"],[data-testid="special-btn"],[data-testid="kick-btn"],[data-testid="leave-btn"]')]
      .filter((e) => !e.disabled && window.__e2eVisible(e)).map((e) => e.getAttribute('data-testid')),
  })).catch(() => null);
  if (ct && ct.since !== null && ct.since < 350) {
    check(ct.enabled.length === 0, `${P.name}: ${ct.since} ms after Play closed the special picker these hooks were enabled: ${JSON.stringify(ct.enabled)}; a double click's second click would land on them (SPEC §11 K6)`);
    run.stats.clickThrough = { page: P.name, sinceMs: ct.since, enabled: ct.enabled.length };
  } else run.stats.clickThrough = { page: P.name, notChecked: ct ? ct.since : 'n/a' };
  await waitState(P, (x) => x.me && x.me.specials.find((y) => y.uid === b.uid).used, 'the special to be used');
  const after = await state(P);
  const logged = after.log.slice(-6).some((l) => l.kind === 'special');
  check(logged, `${P.name}: no 'special' log entry after playing ${b.effect}`);
  run.stats.special = { page: P.name, effect: b.effect, title: sp.title, targetId, category };
  await sleep(PAUSE);
  await shot('after-special', [P]);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// owner features (SPEC §11 X1 airlock, X3 card popovers, X4 lobby estimate)

const PRESET_VALUES = {
  quick: { speechSeconds1: 40, speechSeconds: 20, discussionSeconds: 60, defenseSeconds: 20 },
  standard: { speechSeconds1: 60, speechSeconds: 30, discussionSeconds: 90, defenseSeconds: 30 },
  relaxed: { speechSeconds1: 90, speechSeconds: 45, discussionSeconds: 150, defenseSeconds: 45 },
};
const estimateOf = (s, o) => estimateGame(s.players.length < s.minPlayers ? s.minPlayers : s.players.length, o || s.options).mid;
const readEstimate = (P) => P.page.$eval(sel('time-estimate'), (e) => ({ minutes: Number(e.getAttribute('data-minutes')), text: e.innerText.replace(/\s+/g, ' ').trim() })).catch(() => null);
const sentCount = (P, t) => P.page.evaluate((tt) => (window.__e2eSent || []).filter((f) => f.t === tt).length, t).catch(() => -1);

/** Waits (5 s) until P's time-estimate shows `want` minutes ("≈ N min" and data-minutes); returns what it showed. */
async function waitEstimate(P, want, what) {
  const t0 = Date.now();
  let r = null;
  while (Date.now() - t0 < 5000) {
    r = await readEstimate(P);
    if (r && r.minutes === want && r.text.includes(`≈ ${want} min`)) return r;
    await sleep(80);
  }
  check(false, `${P.name}: time-estimate shows ${JSON.stringify(r)}, expected ≈ ${want} min (${what}; SPEC §11 X4)`);
  return r;
}

// SPEC §11 X4/I4 (f2): every lobby's action bar states the estimate too (a phone keeps the bar on screen, the panel is far
// down): the host, the players and the spectators; below the minimum it is the minimum table's, and it says so.
async function checkBarEstimate(P, what) {
  let last = null;
  for (let i = 0; i < 30; i++) {
    const s = await state(P);
    const bar = await P.page.$eval(sel('action-bar'), (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '');
    if (s && s.phase === 'lobby') {
      const want = estimateOf(s);
      const few = s.players.length < s.minPlayers;
      last = { bar, want, few };
      if (bar.includes(`about ${want} min`) && (!few || bar.includes('(the minimum)'))) return true;
    }
    await sleep(100);
  }
  return check(false, `${P.name}: the lobby's action bar reads ${JSON.stringify(last)}; it must state the estimate ("about N min"${last && last.few ? ', for the minimum table' : ''}) for every viewer (SPEC §11 X4/I4, f2)`);
}

// SPEC §11 X4: every viewer of the lobby sees the estimated game length (the formula over the shared KICKS table); it
// changes with the presets, and the host's own view follows a timer being typed before it is sent.
async function estimateTest(host, bob, spec) {
  const s0 = await state(host);
  const first = {};
  for (const P of [host, bob, spec]) first[P.name] = (await waitEstimate(P, estimateOf(await state(P)), 'as the lobby opened')).minutes;
  for (const P of [host, bob, spec]) await checkBarEstimate(P, 'the full lobby');
  if (s0.players.length === 6 && Object.entries(PRESET_VALUES.standard).every(([k, v]) => s0.options[k] === v)) {
    check(first.host === 45, `host: 6 players on Standard timers show ≈ ${first.host} min; SPEC §11 X4's sanity value is ≈ 45 min`);
  }
  const start = Object.keys(PRESET_VALUES).find((id) => Object.entries(PRESET_VALUES[id]).every(([k, v]) => s0.options[k] === v)) || 'standard';
  const seen = [];
  for (const id of ['quick', 'relaxed', start]) {
    const before = (await readEstimate(host) || {}).minutes;
    await host.page.click(`[data-act="preset"][data-preset="${id}"]:not([disabled])`);
    const s = await waitState(host, (x) => Object.entries(PRESET_VALUES[id]).every(([k, v]) => x.options[k] === v), `the ${id} timers to apply`);
    const want = estimateOf(s, PRESET_VALUES[id]);
    for (const P of [host, bob, spec]) await waitEstimate(P, want, `after the host chose ${id}`);
    check(want !== before, `host: switching to ${id} left the estimate at ≈ ${before} min`);
    seen.push(`${id}≈${want}`);
  }
  // an edit that is not sent yet already moves the host's estimate (and nobody else's), and undoing it sends nothing
  const field = await host.page.$('[data-field="opt:discussionSeconds"]');
  const s1 = await state(host);
  const cur = s1.options.discussionSeconds;
  const sent0 = await sentCount(host, 'setOptions');
  await field.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await field.focus();
  await field.evaluate((e) => e.select());
  await field.type('300');
  const wantDraft = estimateOf(s1, { ...s1.options, discussionSeconds: 300 });
  const draft = await waitEstimate(host, wantDraft, 'while the host types 300 s of discussion, unsent');
  const sBob = await state(bob);
  await waitEstimate(bob, estimateOf(sBob), 'bob, while the host is still typing');
  check((await sentCount(host, 'setOptions')) === sent0 && (await state(host)).options.discussionSeconds === cur,
    'host: typing a timer sent it before the field was left (the estimate must follow the unsent edit)');
  await field.evaluate((e) => e.select());
  await field.type(String(cur));
  await host.page.keyboard.press('Tab');
  await waitEstimate(host, estimateOf(await state(host)), 'after the edit was typed back to its value');
  check((await sentCount(host, 'setOptions')) === sent0, 'host: undoing a timer edit sent setOptions');
  run.stats.estimate = { ok: true, first, presets: seen, draft: draft && draft.minutes, players: s0.players.length };
  log(`lobby estimate: ${JSON.stringify(run.stats.estimate)}`);
}

// SPEC §11 X3: a played special's chip shows its rules text in a popover: on hover on the desktop, on a tap on a phone.
async function popoverTest(host, bob) {
  const pickChip = (P, scope) => P.page.evaluateHandle((sc) => [...document.querySelectorAll(`${sc} [data-testid="card-chip"]`)]
    .find((e) => window.__e2eVisible(e)) || null, scope);
  const popInfo = (P) => P.page.evaluate(() => {
    const e = document.querySelector('[data-testid="card-popover"]');
    if (!e || !window.__e2eVisible(e)) return null;
    const r = e.getBoundingClientRect();
    return { title: e.getAttribute('data-title'), text: e.textContent, onScreen: r.left >= 0 && r.top >= 0 && r.right <= document.documentElement.clientWidth && r.bottom <= innerHeight };
  }).catch(() => null);
  const textOf = (s, title) => { for (const p of s.players) for (const x of [...p.playedSpecials, ...(p.unplayedSpecials || [])]) if (x.title === title) return x.text; return null; };
  const out = {};
  // desktop: hover a chip on the table
  const h1 = (await pickChip(host, '[data-testid="player-card"]')).asElement();
  if (h1) {
    await h1.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    const title = await h1.evaluate((e) => e.getAttribute('data-title'));
    await host.page.mouse.move(2, 2);
    await h1.hover();
    let p = null;
    for (let i = 0; i < 25 && !p; i++) { await sleep(80); p = await popInfo(host); }
    const want = textOf(await state(host), title);
    check(p && p.title === title && want && p.text.includes(want) && p.onScreen, `host: hovering the "${title}" chip showed ${JSON.stringify(p)}; expected an on-screen card-popover with its text (SPEC §11 X3)`);
    await host.page.mouse.move(2, 2);
    let gone = false;
    for (let i = 0; i < 25 && !gone; i++) { await sleep(80); gone = !(await popInfo(host)); }
    check(gone, 'host: the card-popover stayed after the mouse left its chip');
    out.desktop = { title, shown: !!p };
  } else check(false, 'host: no visible card-chip on the table although a special was played');
  // phone: tap a chip (the table or the log), then Esc (a tap that the page moved away from is tried again)
  const b1 = (await pickChip(bob, '[data-testid="player-card"]')).asElement() || (await pickChip(bob, '[data-testid="log"]')).asElement();
  if (b1) {
    const title = await b1.evaluate((e) => e.getAttribute('data-title'));
    let p = null;
    for (let attempt = 0; attempt < 3 && !p; attempt++) {
      await b1.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await sleep(150);
      const box = await b1.boundingBox();
      if (!box) break;
      await bob.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 20 && !p; i++) { await sleep(80); p = await popInfo(bob); }
    }
    const want = textOf(await state(bob), title);
    check(p && p.title === title && want && p.text.includes(want) && p.onScreen, `bob: tapping the "${title}" chip showed ${JSON.stringify(p)}; expected an on-screen card-popover with its text (SPEC §11 X3)`);
    await shot('card-popover', [bob]);
    await bob.page.keyboard.press('Escape');
    await sleep(150);
    check(!(await popInfo(bob)), 'bob: Esc did not close the card-popover');
    out.mobile = { title, shown: !!p };
  } else check(false, 'bob: no visible card-chip although a special was played');
  run.stats.popover = out;
  log(`card popovers: ${JSON.stringify(out)}`);
}

// SPEC §11 X1.7: an airlock is opened on a bot (by a bot holding an Airlock, else by a human through the Play flow);
// everyone sees the badge, the alert and the bar line; a human holding a playable Airlock sees the "join" hint, and
// their picker lists the target first, marked. Then a second Airlock (a human's through the Play flow, else a bot's)
// closes it, or it is left to jam at the end of the discussion. Bots holding an Airlock are held still meanwhile, so
// none closes it before the humans had their look. (reviveTest later brings a victim back through the Play flow.)
async function airlockTest(host, bob, spec) {
  const hs = await state(host);
  run.airlockRounds = run.airlockRounds || new Set();
  if (run.airlockRounds.has(hs.round)) return;
  run.airlockRounds.add(hs.round);
  const raw = run.bots.map((b) => b.state).find(Boolean);
  if (!raw || !Array.isArray(raw.airlocks)) { run.stats.airlock = { skipped: 'the server sends no `airlocks` (SPEC §11 X1 is not implemented there)' }; log(`airlock check skipped: ${run.stats.airlock.skipped}`); return; }
  if (hs.players.length < 4) { run.stats.airlock = { skipped: `${hs.players.length} players: no Airlocks are dealt under 4 (SPEC §11 X1.3)`, expected: true }; log(`airlock check skipped: ${run.stats.airlock.skipped}`); return; }
  const humans = new Set([host.id, bob.id]);
  const botAirlock = (b) => (b.state && b.id && alive(hs, b.id) ? (playableSpecials(b.state).find((x) => x.special.effect === 'airlock') || {}).special : null) || null;
  const humanAirlock = async (P) => {
    const s = await state(P);
    const mine = s && s.me && alive(s, s.you.id) ? s.me.specials.find((x) => x.effect === 'airlock' && !x.used) : null;
    const pl = mine && playableSpecials(s).find((x) => x.special.uid === mine.uid);
    return pl ? { P, s, card: mine, targets: pl.targets } : null;
  };
  const holders = run.bots.map((b) => ({ b, card: botAirlock(b) })).filter((x) => x.card);
  const open = (hs.airlocks || []).find((a) => alive(hs, a.targetId) && !humans.has(a.targetId));
  let T = open ? open.targetId : null;
  let openerId = open ? open.byIds[0] : null;
  let openedBy = open ? 'already open' : null;
  const held = [];
  const hold = (b) => { if (b && !b.paused && !held.includes(b)) { b.pause(); held.push(b); } };
  try {
    if (!T) {
      const freeBot = (s, notId, among) => s.players.find((p) => p.status === 'alive' && !humans.has(p.id) && p.id !== notId
        && (!among || among.includes(p.id)) && !(s.airlocks || []).some((a) => a.targetId === p.id));
      if (holders.length) {
        const { b, card } = holders[0];
        // aimed from the bot's own latest view, so a target that just left the game is not a genuine rejection
        const target = freeBot(b.state, b.id);
        if (!target) { log('no bot to aim an airlock at'); return; }
        T = target.id;
        openerId = b.id;
        openedBy = 'a bot';
        // held still meanwhile, so its own autoplay cannot spend the round's special first (and no other bot closes it);
        // every bot waits while a human aims, so no other state arrives between the aim and the airlock opening (the
        // first view that changes what the aimed card does must already carry the note and the hold)
        for (const x of holders) hold(x.b);
        for (const x of run.bots) hold(x);
        // SPEC §11 FC1/FX2: a human already on Confirm with their Airlock aimed at T ("start cycling") when the bot's
        // airlock opens on T: the very first view of it must carry the note and hold Play, before it reads "… is out"
        const aim = await aimAirlock([host, bob], T, target.name);
        log(`${b.name} opens an airlock on ${target.name} (round ${hs.round}, ${hs.phase})`);
        b.act({ t: 'special', uid: card.uid, targetId: T, at: stepRefOf(b.state) });
        if (aim) await aimedAirlockOpened(aim, T, target.name);
      } else {
        // no bot can open one: a human opens it through the ordinary Play flow (SPEC §10)
        let hh = null;
        for (const P of [host, bob]) { hh = await humanAirlock(P); if (hh) break; }
        const target = hh && freeBot(hh.s, hh.s.you.id, hh.targets);
        if (!hh || !target) {
          if (hs.round >= 6) run.stats.airlock = { skipped: `nobody could play an Airlock on a bot in a reveal phase of rounds 2..${hs.round}` };
          else log(`round ${hs.round}: nobody can play an Airlock on a bot now; the airlock check waits for a later round`);
          return;
        }
        const P = hh.P;
        T = target.id;
        openerId = hh.s.you.id;
        openedBy = P.name;
        for (const x of holders) hold(x.b);
        log(`${P.name} opens an airlock on ${target.name} through the Play flow (round ${hs.round}, ${hs.phase})`);
        await sleep(PAUSE);
        await click(P, 'special-btn', `[data-uid="${hh.card.uid}"]`);
        await waitHook(P, 'target-option', '', 'the Airlock targets');
        const r = await stableHooks(P, 'target-option', 'data-player-id', (cur) => validTargets(cur, hh.card));
        check(r.ok, `${P.name}: Airlock target-option ids ${JSON.stringify(r.shown)} != valid targets ${JSON.stringify(r.expected)}`);
        await click(P, 'target-option', `[data-player-id="${T}"]`);
        const conf = await waitHook(P, 'special-confirm-btn', '', 'the Airlock confirm button');
        const label = (await conf.evaluate((e) => e.textContent)).trim();
        const want = playLabel(await pageLang(P), hh.card.title);
        check(label === want, `${P.name}: the confirm button for opening an airlock on ${target.name} reads "${label}", expected "${want}" (not "… is out": it only opens one)`);
        await shot('airlock-open-confirm', [P]);
        await click(P, 'special-confirm-btn');
      }
      const opened = await waitState(host, (x) => (x.airlocks || []).some((a) => a.targetId === T) || !alive(x, T), 'the airlock to open', 6000).catch(() => null);
      if (!opened || !(opened.airlocks || []).some((a) => a.targetId === T)) { check(false, `host: the airlock ${openedBy} played on ${playerById(hs, T).name} never showed in state.airlocks`); run.stats.airlock = { failed: true }; return; }
    }
    // every other bot that could close it waits until the humans had their look
    for (const x of holders) if (x.b.id !== openerId) hold(x.b);
    const s1 = await state(host);
    const tName = playerById(s1, T).name;
    const oName = playerById(s1, openerId).name;
    const st = { target: tName, opener: oName, openedBy, round: s1.round, badge: {}, join: [], sealed: null };
    // the badge on every viewer's table (the host on a desktop, bob on a phone, the spectator)
    for (const P of [host, bob, spec]) {
      const el = await P.page.waitForSelector(`${sel('airlock-badge')}[data-player-id="${T}"]`, { timeout: 4000 }).catch(() => null);
      const txt = el ? await el.evaluate((e) => e.textContent.replace(/\s+/g, ' ')) : '';
      const pl = await pageLang(P);
      const by = P.id === openerId ? (L(pl, 'air.you') ?? 'you') : oName;
      const badge = L(pl, 'air.badge', { n: 1 }) ?? 'AIRLOCK 1/2';
      check(!!el && txt.includes(badge) && txt.includes(by), `${P.name}: airlock-badge for ${tName} ${el ? `reads "${txt}"` : 'missing'}; expected "${badge} · … ${by}" (SPEC §11 X1.7)`);
      const alert = await P.page.$eval('#sec-airlock', (e) => e.innerText).catch(() => '');
      const bar = await P.page.$eval('.bar-airlock', (e) => e.innerText).catch(() => '');
      check(alert.includes(tName) && bar.includes(tName), `${P.name}: the open airlock on ${tName} is missing from the ${alert.includes(tName) ? 'action bar' : 'airlock alert'} (SPEC §11 X1.7)`);
      // an airlock jams when its round's discussion ends, vote or not: nothing may promise "before the vote" (f2)
      const strips = await P.page.$$eval('.airlock-strip', (els) => els.map((e) => e.innerText).join(' | ')).catch(() => '');
      check(!/before the vote/i.test(`${alert} ${bar} ${strips}`), `${P.name}: the airlock copy says "before the vote" (${JSON.stringify(`${alert} ${bar} ${strips}`.slice(0, 300))}); it jams when this round's discussion ends (SPEC §11 X1, f2)`);
      st.badge[P.name] = !!el;
    }
    await shot('airlock-open', run.pages);
    // a human holding a playable Airlock: the card says "join", the picker lists the target first, marked
    let sealer = null;
    for (const P of [host, bob]) {
      const hh = await humanAirlock(P);
      if (!hh || T === hh.s.you.id || !hh.targets.includes(T)) continue;
      const mine = hh.card;
      const hint = await P.page.waitForSelector(sel('airlock-join-hint'), { timeout: 3000 }).catch(() => null);
      const hintIds = hint ? (await hint.evaluate((e) => e.getAttribute('data-player-id') || '')).split(' ') : [];
      const btn = (await P.page.$eval(`${sel('special-btn')}[data-uid="${mine.uid}"]`, (e) => e.textContent).catch(() => '')).trim();
      const pl = await pageLang(P);
      const joinBtn = L(pl, 'sp.btnJoin') ?? 'Join the airlock…';
      check(hintIds.includes(T) && btn === joinBtn, `${P.name}: holds a playable Airlock while ${oName}'s airlock on ${tName} is open, but the card shows no "join" hint (hint ${JSON.stringify(hintIds)}, button "${btn}", expected "${joinBtn}"; SPEC §11 X1.7)`);
      await click(P, 'special-btn', `[data-uid="${mine.uid}"]`);
      await waitHook(P, 'target-option', '', 'the Airlock targets');
      const optsList = await P.page.$$eval(sel('target-option'), (els) => els.map((e) => ({ id: e.getAttribute('data-player-id'), join: e.getAttribute('data-airlock') })));
      check(optsList[0] && optsList[0].id === T && optsList[0].join === 'join', `${P.name}: the Airlock picker does not lead with ${tName} marked "join": ${JSON.stringify(optsList.slice(0, 3))}`);
      await checkTargetsClickable(P, 'the Airlock picker');
      await shot('airlock-picker', [P]);
      st.join.push(P.name);
      if (!sealer) {
        // close the airlock from the alert's "Join: throw T out" (SPEC §11 FX2): the sheet opens on Confirm for T itself
        await P.page.keyboard.press('Escape');
        await P.page.waitForSelector(sel('special-picker'), { hidden: true, timeout: 3000 }).catch(() => check(false, `${P.name}: Esc did not close the picker`));
        await sleep(600);   // K6: the click-through shield after the sheet closed
        await checkFocusBack(P, `${sel('special-btn')}[data-uid="${mine.uid}"]`, 'Esc in the Airlock picker');
        await click(P, 'airlock-join', `[data-player-id="${T}"]`);
        await P.page.waitForSelector(sel('special-picker'), { visible: true, timeout: 3000 }).catch(() => null);
        const step = await P.page.evaluate(() => ({ targets: document.querySelectorAll('[data-testid="target-option"]').length, confirm: !!document.querySelector('[data-testid="special-confirm-btn"]') }));
        check(step.confirm && step.targets === 0, `${P.name}: "Join: throw ${tName} out" did not open the Airlock on its Confirm step for ${tName} (${JSON.stringify(step)}; SPEC §11 FX2)`);
        if (!step.confirm && step.targets) await click(P, 'target-option', `[data-player-id="${T}"]`);   // (to go on after that failure)
        const conf = await waitHook(P, 'special-confirm-btn', '', 'the Airlock confirm button');
        const label = (await conf.evaluate((e) => e.textContent)).trim();
        const want = joinLabel(pl, mine.title, tName);
        check(label === want, `${P.name}: the confirm button for closing ${tName}'s airlock reads "${label}", expected "${want}"`);
        await click(P, 'special-confirm-btn');
        sealer = P.name;
        st.joinButton = true;
      } else {
        await P.page.keyboard.press('Escape');
        await P.page.waitForSelector(sel('special-picker'), { hidden: true, timeout: 3000 }).catch(() => check(false, `${P.name}: Esc did not close the picker`));
        await sleep(600);   // K6: the click-through shield after the sheet closed
      }
    }
    // no human could close it: it is left alone, to jam when this round's discussion ends (unless a bot's own autoplay
    // closes it first); the main loop checks which of the two happened once the round's discussion is over
    if (!sealer && !alive(await state(host), T)) sealer = '(a bot on its own)';
    if (sealer) {
      const s2 = await waitState(host, (x) => !alive(x, T), `${tName} to be thrown out by the second Airlock (${sealer})`, 6000).catch(() => null);
      check(!!s2 && playerById(s2, T).status === 'ejected', `host: ${tName} is not ejected after ${sealer} closed the airlock`);
      await checkAirlockBadges(host);
      const line = await host.page.$$eval('[data-testid="log"] .k-airlock', (els) => els.map((e) => e.textContent)).catch(() => []);
      check(line.some((t) => /sealed/.test(t) && t.includes(tName)), `host: the log shows no "sealed the airlock" line for ${tName}`);
      await shot('airlock-sealed', [host, bob]);
      st.sealed = sealer;
    } else {
      st.jamExpected = true;
      run.airlockWatch = { T, name: tName, round: s1.round, overtime: !!s1.overtime };
    }
    run.stats.airlock = st;
    log(`airlock UI: ${JSON.stringify(st)}`);
  } finally {
    for (const b of held) b.resumePlay();
  }
}

// The Airlock picker's Play button as the page's language words it: "Play {title}" (it opens an airlock) or "Play
// {title}: {t} is out" (it closes one). (bob may be playing in Russian then: SPEC §11 X5.8.)
function playLabel(lang, title) { return L(lang, 'picker.play', { title }) ?? `Play ${title}`; }
function joinLabel(lang, title, tName) { return L(lang, 'picker.playJoin', { title, t: tName }) ?? `Play ${title}: ${tName} is out`; }

// SPEC §11 FC1/FX2, part 1: a human holding a playable Airlock aims it at T (Confirm, "start cycling the airlock"),
// before anyone opened an airlock on T. Returns what the page needs to watch for, or null when no human can.
async function aimAirlock(humansP, T, tName) {
  for (const P of humansP) {
    const s = await state(P);
    const mine = s && s.me && playerById(s, s.you.id) && playerById(s, s.you.id).status === 'alive' ? s.me.specials.find((x) => x.effect === 'airlock' && !x.used) : null;
    const pl = mine && playableSpecials(s).find((x) => x.special.uid === mine.uid);
    if (!pl || s.you.id === T || !pl.targets.includes(T)) continue;
    await click(P, 'special-btn', `[data-uid="${mine.uid}"]`);
    await waitHook(P, 'target-option', '', 'the Airlock targets');
    await click(P, 'target-option', `[data-player-id="${T}"]`);
    const conf = await waitHook(P, 'special-confirm-btn', '', 'the Airlock confirm button');
    const label = (await conf.evaluate((e) => e.textContent)).trim();
    const lang = await pageLang(P);
    check(label === playLabel(lang, mine.title), `${P.name}: aiming an Airlock at ${tName} with no airlock open, the confirm button reads "${label}", expected "${playLabel(lang, mine.title)}"`);
    // record the first rendered view that has the airlock on T (the state and its render arrive together)
    await P.page.evaluate((t) => {
      window.__e2eAir = null;
      const look = () => {
        if (window.__e2eAir) return;
        const s = window.__bunkerState;
        if (!s || !(s.airlocks || []).some((a) => a.targetId === t)) return;
        const b = document.querySelector('[data-testid="special-confirm-btn"]');
        const n = document.querySelector('[data-testid="special-picker"] .callout.warn');
        window.__e2eAir = { disabled: !b || b.disabled, label: b ? b.textContent : null, note: n ? n.textContent : '' };
      };
      const mo = new MutationObserver(look);
      mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      const iv = setInterval(() => { look(); if (window.__e2eAir) { clearInterval(iv); mo.disconnect(); } }, 5);
    }, T);
    log(`${P.name} aims an Airlock at ${tName} (on Confirm) before the airlock opens`);
    return { P, uid: mine.uid, title: mine.title, lang };
  }
  return null;
}
// …part 2: the airlock just opened on T. Its first view says so and holds Play; then Play reads "… is out". The picker
// is left with Esc (the rest of airlockTest joins through the card and the alert).
async function aimedAirlockOpened(aim, T, tName) {
  const { P } = aim;
  await P.page.waitForFunction(() => window.__e2eAir, { timeout: 6000, polling: 20 }).catch(() => null);
  const first = await P.page.evaluate(() => window.__e2eAir);
  const note = L(aim.lang, 'picker.airJustStarted', { t: tName }) ?? 'just started';
  const out = joinLabel(aim.lang, aim.title, tName);
  check(!!first && first.disabled && (first.note || '').includes(note) && (first.label || '').trim() === out,
    `${P.name}: when the airlock opened on ${tName} under an aimed Airlock, the first view was ${JSON.stringify(first)}; expected the note "${note}", a held (disabled) Play reading "${out}" (SPEC §11 FC1/FX2)`);
  const conf = await waitHook(P, 'special-confirm-btn', '', 'the Airlock confirm button after the hold', 3000);
  const label = (await conf.evaluate((e) => e.textContent)).trim();
  check(label === out, `${P.name}: after the hold, the confirm button reads "${label}"; expected "${out}"`);
  run.stats.airlockAim = { who: P.name, first };
  log(`airlock aimed and opened: ${JSON.stringify(first)}`);
  await shot('airlock-aimed-opened', [P]);
  await P.page.keyboard.press('Escape');
  await P.page.waitForSelector(sel('special-picker'), { hidden: true, timeout: 3000 }).catch(() => check(false, `${P.name}: Esc did not close the picker`));
  await sleep(600);   // K6: the click-through shield after the sheet closed
}

// A sheet closed without playing (Esc) gives the keyboard focus back to the button that opened it, once the K6 shield
// lets that button be enabled again: not to <body>, from where Tab starts at the top of the page (SPEC §11, f2).
async function checkFocusBack(P, q, what) {
  let got = null;
  for (let i = 0; i < 12; i++) {
    got = await P.page.evaluate((qq) => {
      const a = document.activeElement;
      return { back: !!a && a.matches(qq), focus: !a || a === document.body ? 'body' : `${a.tagName.toLowerCase()}.${String(a.className).split(' ')[0]}[${a.getAttribute('data-testid') || ''}]` };
    }, q).catch(() => null);
    if (got && got.back) { run.stats.focusBack = (run.stats.focusBack || 0) + 1; return true; }
    await sleep(100);
  }
  return check(false, `${P.name}: after ${what} the focus is on ${got && got.focus}, not on the button that opened the sheet (${q})`);
}

// Every target-option of an open picker can take a click: nothing (a card popover, a toast) lies over its centre.
async function checkTargetsClickable(P, what) {
  const covered = await P.page.$$eval(sel('target-option'), (els) => els.filter((e) => window.__e2eVisible(e)).map((e) => {
    e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at && !e.contains(at) ? `${e.getAttribute('data-player-id')} under ${at.tagName.toLowerCase()}.${String(at.className).split(' ')[0]}` : null;
  }).filter(Boolean)).catch(() => []);
  check(covered.length === 0, `${P.name}: ${what}: target options covered by another element: ${JSON.stringify(covered)}`);
}

// SPEC §11 X1.4: a human holding "Back from the Forest" brings a player thrown out through the airlock back, through
// the ordinary Play flow (only when a human holds a playable revive while a victim is out; bots may do it first).
async function reviveTest(host, bob) {
  for (const P of [host, bob]) {
    const s = await state(P);
    if (!s || !s.me || !playerById(s, s.you.id) || playerById(s, s.you.id).status !== 'alive') continue;
    const rev = playableSpecials(s).find((x) => x.special.effect === 'revive');
    const victims = airlockVictims(s).filter((id) => rev && rev.targets.includes(id));
    if (!rev || !victims.length) continue;
    const V = victims[0];
    const vName = playerById(s, V).name;
    log(`${P.name} brings ${vName} back from the forest through the Play flow (round ${s.round}, ${s.phase})`);
    await sleep(PAUSE);
    await click(P, 'special-btn', `[data-uid="${rev.special.uid}"]`);
    await waitHook(P, 'target-option', '', 'the revive targets');
    const r = await stableHooks(P, 'target-option', 'data-player-id', (cur) => validTargets(cur, rev.special));
    await checkTargetsClickable(P, 'the revive picker');
    check(r.ok && r.shown.includes(V), `${P.name}: revive target-option ids ${JSON.stringify(r.shown)} != ejected players ${JSON.stringify(r.expected)} (airlock victim ${vName})`);
    if (!r.shown.includes(V)) { await P.page.keyboard.press('Escape'); run.stats.revive = { failed: true }; return; }
    await click(P, 'target-option', `[data-player-id="${V}"]`);
    await waitHook(P, 'special-confirm-btn', '', 'the revive confirm button');
    await shot('revive-confirm', [P]);
    await click(P, 'special-confirm-btn');
    const s2 = await waitState(host, (x) => alive(x, V) || !x.players.some((p) => p.id === V), `${vName} to be back in the game`, 6000).catch(() => null);
    check(!!s2 && alive(s2, V), `host: ${vName} is not alive after ${P.name} played "${rev.special.title}" on them`);
    // (by key: the host's own line for this card with a revive result on V; without keys, the English text)
    const line = s2 ? s2.log.slice(-8).find((l) => l.kind === 'special' && (l.key
      ? l.params.result && l.params.result.key === 'res.revive' && l.params.result.params.t === V
      : l.text.includes(rev.special.title) && l.text.includes(vName))) : null;
    check(!!line, `host: no special log line for ${P.name}'s "${rev.special.title}" on ${vName}`);
    await sleep(PAUSE);
    await shot('revived', [host, bob]);
    run.stats.revive = { page: P.name, title: rev.special.title, victim: vName, round: s.round };
    log(`revive UI: ${JSON.stringify(run.stats.revive)}`);
    return;
  }
}
function alive(s, id) { const p = playerById(s, id); return !!p && p.status === 'alive'; }

// ---------------------------------------------------------------------------------------------------------------
// SPEC §11 X10: "Report an issue" / "Suggest an idea" links and the visible version

const ISSUES_NEW = 'https://github.com/dolgikhog/bunker-online/issues/new';
async function expectedVersion() {
  if (run.version) return run.version;
  let v = 'dev';
  try {
    const r = await fetch(`${run.baseUrl}/version.json`, { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); if (j && typeof j.version === 'string' && j.version.trim()) v = j.version.trim(); }
  } catch { /* none: 'dev' */ }
  run.version = v;
  return v;
}
/**
 * The two links shown at `where` (landing | menu | rules | final): exactly one of each visible; the bug form prefilled
 * with template=bug.yml, version, a short browser summary, lang EN (or RU) and room only in a room; the idea form with
 * template=idea.yml, version and lang; every value URL-encoded; both open in a new tab.
 */
async function checkReportLinks(P, where, room) {
  const want = await expectedVersion();
  const got = await P.page.evaluate((w) => {
    const pick = (id) => [...document.querySelectorAll(`[data-testid="${id}"][data-where="${w}"]`)].filter((e) => window.__e2eVisible(e))
      .map((e) => ({ href: e.getAttribute('href'), target: e.getAttribute('target'), rel: e.getAttribute('rel') || '', text: e.textContent.trim() }));
    return { bug: pick('report-issue-link'), idea: pick('suggest-idea-link') };
  }, where);
  const tag = `${P.name} @${where}`;
  check(got.bug.length === 1 && got.idea.length === 1, `${tag}: ${got.bug.length} report-issue-link and ${got.idea.length} suggest-idea-link are visible, expected one each (SPEC §11 X10)`);
  const b = got.bug[0];
  const i = got.idea[0];
  if (b) {
    const u = new URL(b.href);
    const q = Object.fromEntries(u.searchParams);
    check(u.origin + u.pathname === ISSUES_NEW, `${tag}: the bug link goes to ${u.origin + u.pathname}, expected ${ISSUES_NEW}`);
    check(q.template === 'bug.yml' && q.version === want && q.lang === 'EN', `${tag}: bug link params ${JSON.stringify(q)}; expected template=bug.yml, version=${want}, lang=EN`);
    check(typeof q.browser === 'string' && q.browser.length <= 40 && /^[A-Z][\w ]*? \d+ · [A-Za-z]+$/.test(q.browser), `${tag}: browser=${JSON.stringify(q.browser)} is not a short "Chrome 131 · Linux" summary`);
    check(room ? q.room === room : !Object.hasOwn(q, 'room'), `${tag}: room=${JSON.stringify(q.room)}, expected ${room || 'no room parameter'} (present only in a room)`);
    check(Object.keys(q).every((k) => ['template', 'version', 'browser', 'lang', 'room'].includes(k)), `${tag}: unexpected bug link parameters ${JSON.stringify(Object.keys(q))}`);
    const raw = b.href.split('?')[1] || '';
    check(!/[\s+]/.test(raw) && raw.includes(`browser=${encodeURIComponent(q.browser)}`), `${tag}: the bug link's values are not URL-encoded (${raw})`);
    check(b.target === '_blank' && /\bnoopener\b/.test(b.rel), `${tag}: the bug link must open in a new tab (target ${b.target}, rel ${b.rel})`);
    check(b.text === 'Report an issue', `${tag}: the bug link reads ${JSON.stringify(b.text)}`);
  }
  if (i) {
    const u = new URL(i.href);
    const q = Object.fromEntries(u.searchParams);
    check(u.origin + u.pathname === ISSUES_NEW && q.template === 'idea.yml' && q.version === want && q.lang === 'EN' && Object.keys(q).length === 3,
      `${tag}: the idea link is ${i.href}; expected ${ISSUES_NEW}?template=idea.yml&version=${want}&lang=EN`);
    check(i.target === '_blank' && /\bnoopener\b/.test(i.rel), `${tag}: the idea link must open in a new tab (target ${i.target}, rel ${i.rel})`);
    check(i.text === 'Suggest an idea', `${tag}: the idea link reads ${JSON.stringify(i.text)}`);
  }
  (run.stats.reportLinks ||= []).push(`${P.name}@${where}`);
}
/** `app-version` at `where` reads v<version> (version.json's, or 'dev' without one). */
async function checkVersion(P, where) {
  const want = `v${await expectedVersion()}`;
  let shown = [];
  for (let i = 0; i < 20; i++) {
    shown = await P.page.$$eval(`${sel('app-version')}[data-where="${where}"]`, (els) => els.filter((e) => window.__e2eVisible(e)).map((e) => e.textContent.trim())).catch(() => []);
    if (shown.length === 1 && shown[0] === want) break;
    await sleep(100);
  }
  check(shown.length === 1 && shown[0] === want, `${P.name} @${where}: app-version shows ${JSON.stringify(shown)}, expected ["${want}"] (SPEC §11 X10)`);
}
/** The header menu (every in-room phase): opens from header-menu-btn, holds both links, fits the screen, Esc closes it. */
async function headerMenuTest(P, room, label) {
  await click(P, 'header-menu-btn', '', 'the header menu');
  const menu = await P.page.waitForSelector(sel('header-menu'), { visible: true, timeout: 4000 }).catch(() => null);
  if (!check(!!menu, `${P.name} (${label}): header-menu-btn did not open the header menu`)) return;
  await checkReportLinks(P, 'menu', room);
  await checkVersion(P, 'menu');
  const r = await menu.evaluate((e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, b: b.bottom, vw: document.documentElement.clientWidth, vh: window.innerHeight }; });
  check(r.l >= 0 && r.r <= r.vw + 1 && r.b <= r.vh + 1, `${P.name} (${label}): the header menu is off screen ${JSON.stringify(r)}`);
  if (P.vpName === 'mobile' && !run.stats.menuShot) { run.stats.menuShot = true; await sleep(300); await shot('header-menu', [P]); }   // after its drop-in
  await P.page.keyboard.press('Escape');
  const closed = await P.page.waitForSelector(sel('header-menu'), { hidden: true, timeout: 3000 }).then(() => true, () => false);
  check(closed, `${P.name} (${label}): Esc did not close the header menu`);
}
/** The rules sheet carries both links and the version at its foot. */
async function rulesLinksTest(P, room) {
  const btn = await P.page.waitForSelector('.rules-btn:not([disabled])', { visible: true, timeout: 4000 }).catch(() => null);
  if (!check(!!btn, `${P.name}: no Rules button in the header`)) return;
  await btn.click();
  const sheet = await P.page.waitForSelector(sel('rules-sheet'), { visible: true, timeout: 4000 }).catch(() => null);
  if (!check(!!sheet, `${P.name}: the Rules button did not open the rules sheet`)) return;
  await checkReportLinks(P, 'rules', room);
  await checkVersion(P, 'rules');
  await P.page.keyboard.press('Escape');
  await P.page.waitForSelector(sel('rules-sheet'), { hidden: true, timeout: 3000 }).catch(() => check(false, `${P.name}: Esc did not close the rules sheet`));
  await sleep(600);   // K6: the click-through shield after a sheet closes
}

// ---------------------------------------------------------------------------------------------------------------
// SPEC §11 X9.1: ?profile= makes tabs of ONE browser (one context: one localStorage, per-tab sessionStorage) separate
// players. Two tabs with different profiles join one room as two players, each resumes its own seat after a reload,
// the invite link carries no profile, the URL keeps it, a tab without a profile sees neither seat, and the narrator
// setting of one profile does not leak into the other.
async function profileTest() {
  const ctx = await run.browser.createBrowserContext();
  const A = await newPage(ctx, 'prof-alpha', DESKTOP);
  const B = await newPage(ctx, 'prof-beta', DESKTOP);
  // tabs of one window: only the front one renders, and puppeteer's click waits for a rendered frame
  const front = async (P) => { await P.page.bringToFront(); await sleep(150); };
  await front(A);
  await A.page.goto(`${run.baseUrl}/?profile=alpha`, { waitUntil: 'domcontentloaded' });
  await waitHook(A, 'name-input');
  const tagA = await A.page.$eval(sel('profile-tag'), (e) => e.textContent.trim()).catch(() => null);
  check(tagA === 'Profile: alpha', `profile: the landing's tag reads ${JSON.stringify(tagA)}, expected "Profile: alpha" (SPEC §11 X9.1)`);
  await typeInto(A, 'name-input', 'Ann');
  await click(A, 'create-btn');
  const sa = await waitState(A, (s) => s.phase === 'lobby' && s.you.isHost, 'profile alpha in its lobby');
  const room = sa.room;
  await front(B);
  await B.page.goto(`${run.baseUrl}/?room=${room}&profile=beta`, { waitUntil: 'domcontentloaded' });
  await waitHook(B, 'name-input');
  const offer = await B.page.$(sel('rejoin-btn'));
  check(!offer, 'profile: a tab with another profile was offered "Rejoin" for the first profile\'s seat (the identity leaked across profiles)');
  const tagB = await B.page.$eval(sel('profile-tag'), (e) => e.textContent.trim()).catch(() => null);
  check(tagB === 'Profile: beta', `profile: the second tab's tag reads ${JSON.stringify(tagB)}`);
  await typeInto(B, 'name-input', 'Ben');
  await click(B, 'join-btn');
  const sb = await waitState(B, (s) => s.phase === 'lobby' && s.you.role === 'player', 'profile beta seated');
  const both = await waitState(A, (s) => s.players.length === 2, 'two players in the profile room');
  check(sb.you.id !== sa.you.id && both.players.some((p) => p.id === sb.you.id && p.name === 'Ben') && both.players.some((p) => p.id === sa.you.id && p.name === 'Ann'),
    `profile: two tabs of one browser with different profiles are not two players: ${JSON.stringify(both.players.map((p) => [p.id, p.name]))}`);
  await front(A);
  const link = await A.page.$eval('#invite-link', (e) => e.value).catch(() => null);
  check(link === `${run.baseUrl}/?room=${room}`, `profile: the invite link is ${JSON.stringify(link)}; it must be exactly ${run.baseUrl}/?room=${room}, without the profile`);
  const urlA = new URL(A.page.url());
  check(urlA.searchParams.get('profile') === 'alpha' && urlA.searchParams.get('room') === room, `profile: the page URL lost its profile or room: ${A.page.url()}`);
  const keys = await A.page.evaluate(() => [Object.keys(localStorage).sort(), Object.keys(sessionStorage).sort()]);
  check(keys[0].includes('bunker.identity@alpha') && keys[0].includes('bunker.identity@beta') && !keys.flat().some((k) => /^bunker\.[\w.]+$/.test(k)),
    `profile: storage keys are not namespaced by profile: ${JSON.stringify(keys)}`);
  // the narrator setting (narrator.js keeps its own keys) follows the profile too
  await click(A, 'narrator-menu');
  await click(A, 'narrator-toggle');
  await A.page.keyboard.press('Escape');
  await sleep(300);
  await front(B);
  const bNarr = await B.page.$eval(sel('narrator-menu'), (e) => e.getAttribute('aria-label') || '').catch(() => '');
  check(/\(off\)/.test(bNarr), `profile: turning the narrator on under profile alpha turned it on for beta too (${bNarr})`);
  // reloads: each tab takes its own seat back
  for (const [P, s0] of [[A, sa], [B, sb]]) {
    await front(P);
    await P.page.reload({ waitUntil: 'domcontentloaded' });
    const s1 = await waitState(P, (s) => s.phase === 'lobby' && s.room === room, `${P.name} to resume after a reload`);
    check(s1.you.id === s0.you.id, `profile: after a reload ${P.name} is ${s1.you.id}, expected its own seat ${s0.you.id}`);
  }
  // a third tab without a profile sees neither seat (no Rejoin offer, no resume)
  const C = await newPage(ctx, 'prof-none', DESKTOP);
  await front(C);
  await C.page.goto(`${run.baseUrl}/?room=${room}`, { waitUntil: 'domcontentloaded' });
  await waitHook(C, 'name-input');
  await sleep(500);
  const cState = await state(C);
  const cOffer = await C.page.$(sel('rejoin-btn'));
  const cTag = await C.page.$(sel('profile-tag'));
  check(!cState && !cOffer && !cTag, `profile: a tab without a profile resumed or was offered a profile's seat (state ${!!cState}, rejoin ${!!cOffer}, tag ${!!cTag})`);
  for (const P of [A, B]) { await front(P); await shot('profiles', [P]); }
  // clean up: both leave the lobby (one click there)
  for (const P of [B, A]) { await front(P); await click(P, 'leave-btn'); await waitHook(P, 'name-input'); }
  run.stats.profiles = { room, alpha: sa.you.id, beta: sb.you.id, keys: keys[0].filter((k) => k.includes('@')) };
  log(`profiles: ${JSON.stringify(run.stats.profiles)}`);
  for (const P of [A, B, C]) { await P.page.close().catch(() => {}); run.pages.splice(run.pages.indexOf(P), 1); }
  await ctx.close().catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------
// SPEC §11 X5.7/X5.8 (reports/i18n-design.md §9.7): the language switch, a mid-game switch, a Russian first visit

const PHONE_360 = { width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const langShown = (P) => P.page.evaluate(() => {
  const b = document.querySelector('[data-testid="lang-switch"]');
  const s = window.__bunkerState;
  return { html: document.documentElement.lang, sw: b ? b.getAttribute('data-lang') : null, you: s && s.you && typeof s.you.lang === 'string' ? s.you.lang : null };
}).catch(() => null);

// The landing page (the host, before Create): the switch turns the page Russian at once, on screen at 360 × 640 above
// the form, and the choice is stored; a room code typed with the Russian look-alikes (КМТХ) reads as its Latin letters
// (KMTX); the switch back restores English (the rest of the run reads the host's page in English).
async function landingLangTest(P) {
  if (!I18N.loaded) return;
  const btn = await P.page.waitForSelector(`${sel('lang-switch')}[data-lang="en"]`, { visible: true, timeout: 4000 }).catch(() => null);
  if (!check(!!btn, `${P.name}: no language switch (${sel('lang-switch')}[data-lang="en"]) on the landing page (SPEC §11 X5.7)`)) return;
  const out = {};
  await P.page.setViewport({ width: 360, height: 640, deviceScaleFactor: 1 });
  await sleep(250);
  const place = await P.page.evaluate(() => {
    const b = document.querySelector('[data-testid="lang-switch"]').getBoundingClientRect();
    const f = document.querySelector('.entry .form, [data-testid="name-input"]').getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height), vw: document.documentElement.clientWidth, formTop: Math.round(f.top) };
  });
  check(place.top >= 0 && place.bottom <= 640 && place.bottom <= place.formTop && place.right <= place.vw && place.h >= 32,
    `${P.name}: at 360 × 640 the landing's language switch is not on screen above the form, or is under 32 px high (${JSON.stringify(place)}) (SPEC §11 X5.7)`);
  await P.page.setViewport(P.viewport);
  await sleep(150);
  await click(P, 'lang-switch');
  const ru = await P.page.waitForFunction(() => document.documentElement.lang === 'ru' && document.querySelector('[data-testid="lang-switch"]').getAttribute('data-lang') === 'ru', { timeout: 2000 }).then(() => true, () => false);
  check(ru, `${P.name}: the landing did not switch to Russian (${JSON.stringify(await langShown(P))})`);
  const create = (await P.page.$eval(sel('create-btn'), (e) => e.textContent.trim()).catch(() => '')) || '';
  check(create === L('ru', 'landing.create'), `${P.name}: the create button reads "${create}" in Russian, expected "${L('ru', 'landing.create')}"`);
  checkRu(CYR.test(create), `${P.name}: the create button's Russian text "${create}" has no Cyrillic`);
  const stored = await P.page.evaluate(() => localStorage.getItem('bunker.lang')).catch(() => null);
  check(stored === 'ru', `${P.name}: the language choice was not stored (bunker.lang = ${JSON.stringify(stored)})`);
  // a Russian keyboard: the Cyrillic look-alikes are the code's Latin letters (design §9.2)
  await typeInto(P, 'room-input', 'КМТХ');
  const code = await P.page.$eval(sel('room-input'), (e) => e.value).catch(() => null);
  check(code === 'KMTX', `${P.name}: typing «КМТХ» into the room code gave ${JSON.stringify(code)}, expected "KMTX" (design §9.2)`);
  await P.page.$eval(sel('room-input'), (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await shot('landing-ru', [P], { alsoMobile: true });
  await click(P, 'lang-switch');
  const en = await P.page.waitForFunction(() => document.documentElement.lang === 'en' && document.querySelector('[data-testid="lang-switch"]').getAttribute('data-lang') === 'en', { timeout: 2000 }).then(() => true, () => false);
  const create2 = (await P.page.$eval(sel('create-btn'), (e) => e.textContent.trim()).catch(() => '')) || '';
  const stored2 = await P.page.evaluate(() => localStorage.getItem('bunker.lang')).catch(() => null);
  check(en && create2 === L('en', 'landing.create') && stored2 === 'en', `${P.name}: the switch back to English left ${JSON.stringify({ lang: await langShown(P), create2, stored2 })}`);
  Object.assign(out, { place, create, code });
  run.stats.lang = { ...(run.stats.lang || {}), landing: out };
  log(`language switch on the landing page: ${JSON.stringify(out)}`);
}

// Fresh-marked cards (the 6 s highlight of a card just revealed or changed) on a page, as "player:category" keys.
const freshKeys = (P) => P.page.$$eval('.fresh', (els) => els.map((e) => {
  const p = e.closest('[data-player-id]');
  return `${p ? p.getAttribute('data-player-id') : 'hand'}:${e.getAttribute('data-cat') || e.getAttribute('data-key') || ''}`;
})).catch(() => []);
// #app's text without the running clocks and the flashes (they change by themselves)
const appText = (P) => P.page.evaluate(() => {
  const c = document.getElementById('app').cloneNode(true);
  for (const e of c.querySelectorAll('[data-ends], .toasts')) e.remove();
  return c.textContent;
}).catch(() => null);

// A phone in play: the header's timer label ("Kai's turn", «Ход: Оля») keeps a readable width next to the language
// pill and the narrator (it sits above the clock there; beside it, it once kept 2–3 letters: client-fixer-i1).
async function phoneTimerCheck(P, where) {
  const k = await P.page.evaluate(() => {
    const e = document.querySelector('header .timer-cell .k');
    if (!e || window.innerWidth > 639 || !window.__e2eVisible(e)) return null;
    return { cw: e.clientWidth, sw: e.scrollWidth, text: e.textContent, vw: window.innerWidth };
  }).catch(() => null);
  if (!k) return;
  check(k.cw >= Math.min(k.sw, 59), `${P.name} @${where}: the header's timer label "${k.text}" is cut to ${k.cw} px of ${k.sw} at ${k.vw} px (it needs at least 59 px)`);
  (run.stats.timerLabel = run.stats.timerLabel || []).push({ who: P.name, where, ...k });
}

// A tap there and back on the switch (EN → RU → EN, 120 ms apart, in a room): the page never shows the language it
// left, and nothing goes to the server (design §9.3: setLang goes out LANG_SEND_MS after the last tap, and not at all
// when the choice ends where it started).
async function langDoubleTapTest(bob) {
  if (!I18N.loaded) return;
  const cdp = await bob.page.createCDPSession();
  const sent = [];
  try {
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketFrameSent', (e) => { if (/"setLang"/.test(e.response.payloadData)) sent.push(e.response.payloadData); });
    const l0 = await langShown(bob);
    await bob.page.evaluate(() => {
      window.__e2eTap = [];
      window.__e2eTapMo = new MutationObserver(() => window.__e2eTap.push(document.documentElement.lang));
      window.__e2eTapMo.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
      const b = () => document.querySelector('[data-testid="lang-switch"]');
      b().click();
      setTimeout(() => b().click(), 120);
    });
    await sleep(1200);
    const seen = await bob.page.evaluate(() => { window.__e2eTapMo.disconnect(); return window.__e2eTap; }).catch(() => null);
    const l1 = await langShown(bob);
    check(!!seen && seen.length === 0 && !!l0 && !!l1 && l1.html === l0.html && l1.sw === l0.sw && l1.you === l0.you,
      `bob: a tap there and back on the language switch showed ${JSON.stringify(seen)} (before ${JSON.stringify(l0)}, after ${JSON.stringify(l1)}) (design §9.3)`);
    check(sent.length === 0, `bob: a tap there and back on the language switch sent ${sent.length} setLang frame(s): ${JSON.stringify(sent)} (design §9.3)`);
    run.stats.lang = { ...(run.stats.lang || {}), doubleTap: { langs: seen, setLang: sent.length } };
  } finally { await cdp.detach().catch(() => {}); }
}

// bob's language switch mid-game (design §9.7): atomic (sampled every 25 ms: the page's language, the log, the hand
// and the bar never disagree), within 2 s, only bob's page changes (the host's and the spectator's text and you.lang
// stay), no card is marked fresh by it, and a narrator clip that is playing goes on. The render that changes the
// language keeps the log and the bar status out of aria-live (a screen reader would queue the whole log again), and
// they are live again a moment later. The bots are held still meanwhile.
// o.slow: bob's link is throttled so that the answer takes about 3 s, longer than the 1.5 s after which the client once
// committed anyway (a Russian page over English server text): the page must stay whole in its old language until the
// answer arrives, and then change in one render (client-fixer-i1).
async function langSwitchTest(host, bob, spec, to, o = {}) {
  if (!I18N.loaded) return;
  const held = run.bots.filter((b) => !b.paused);
  for (const b of held) b.pause();
  const res = { to };
  let cdp = null;
  try {
    // no card still highlighted (a reveal a moment ago), so "no card turns fresh" means something
    for (let i = 0; i < 80 && (await freshKeys(bob)).length; i++) await sleep(100);
    const up = await bob.page.$$eval('.sc, .card.up', (els) => els.length).catch(() => 0);
    const others = {};
    for (const P of [host, spec]) others[P.name] = { text: await appText(P), lang: (await state(P)).you.lang };
    const fresh0 = await freshKeys(bob);
    const a0 = await narrAudio(bob);
    await bob.page.evaluate(() => {
      const cyr = (t) => /[А-Яа-яЁё]/.test(t || '');
      const txt = (q, n) => [...document.querySelectorAll(q)].slice(-n).map((e) => e.textContent).join(' ');
      window.__e2eLang = [];
      const tick = (why) => window.__e2eLang.push({
        why, t: Math.round(performance.now()), html: document.documentElement.lang,
        log: cyr(txt('[data-testid="log"] li .lt', 4)), hand: cyr(txt('.hc-text', 8)),
        bar: cyr((document.querySelector('[data-testid="action-bar"]') || {}).innerText),
        sw: (document.querySelector('[data-testid="lang-switch"]') || { getAttribute: () => null }).getAttribute('data-lang'),
        live: [document.querySelector('[data-testid="log"]'), document.querySelector('[data-testid="action-bar"]')].map((e) => (e ? e.getAttribute('aria-live') : '-')).join('/'),
        // the switch's accessible name while the switch waits (review-switch-i2 finding 4)
        swName: (document.querySelector('[data-testid="lang-switch"]') || { getAttribute: () => null }).getAttribute('aria-label'),
        swBusy: (document.querySelector('[data-testid="lang-switch"]') || { getAttribute: () => null }).getAttribute('aria-busy'),
        swLang: (document.querySelector('[data-testid="lang-switch"]') || { getAttribute: () => null }).getAttribute('lang'),
      });
      tick('start');
      // every 25 ms, and after every render (a mutation observer's callback runs once the render has finished)
      window.__e2eLangIv = setInterval(() => tick('timer'), 25);
      window.__e2eLangMo = new MutationObserver(() => tick('render'));
      window.__e2eLangMo.observe(document.getElementById('app'), { subtree: true, childList: true, characterData: true, attributes: true });
    });
    const limit = o.slow ? 9000 : 2000;
    if (o.slow) {
      const chars = await bob.page.evaluate(() => JSON.stringify(window.__bunkerState).length).catch(() => 60000);
      res.kbps = Math.max(2, Math.round(chars / 1024 / 3));
      cdp = await bob.page.createCDPSession();
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: res.kbps * 1024, uploadThroughput: -1 });
    }
    const t0 = Date.now();
    await click(bob, 'lang-switch');
    const s1 = await waitState(bob, (s) => s.you && s.you.lang === to, `bob's state in ${to} after the switch`, limit).catch(() => null);
    const html = await bob.page.waitForFunction((l) => document.documentElement.lang === l, { timeout: limit }, to).then(() => true, () => false);
    res.ms = Date.now() - t0;
    if (cdp) { await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {}); }
    check(!!s1 && html && res.ms <= limit, `bob: the switch to ${to} did not complete within ${limit / 1000} s (state ${s1 ? s1.you.lang : '-'}, page ${JSON.stringify(await langShown(bob))}) (SPEC §11 X5.7)`);
    if (o.slow && res.ms < 1600) run.warnings.push(`bob: the throttled switch to ${to} (${res.kbps} KB/s) was answered in ${res.ms} ms: the slow path (answer after 1.5 s) was not exercised`);
    await sleep(300);
    const samples = await bob.page.evaluate(() => { clearInterval(window.__e2eLangIv); window.__e2eLangMo.disconnect(); return window.__e2eLang; }).catch(() => []);
    // server text (the log, the hand's cards) is Russian exactly when the page is: never one without the other
    const mixed = samples.filter((x) => (x.html === 'ru') !== x.log || (x.html === 'ru') !== x.hand);
    check(samples.length >= 3 && mixed.length === 0, `bob: ${mixed.length} of ${samples.length} samples during the switch mixed two languages (page, log, hand): ${JSON.stringify(mixed.slice(0, 3))} (design §9.3)`);
    check(samples[0] && samples[0].html === (to === 'ru' ? 'en' : 'ru') && samples[samples.length - 1].html === to, `bob: the samples do not go from the old language to ${to}: ${samples.map((x) => x.html).join(' ')}`);
    const barMixed = samples.filter((x) => (x.html === 'ru') !== x.bar);
    checkRu(barMixed.length === 0, `bob: ${barMixed.length} samples had the action bar in another language than the page: ${JSON.stringify(barMixed.slice(0, 3))}`);
    check(samples.length > 0 && samples[samples.length - 1].sw === to, `bob: the switch shows data-lang=${samples.length ? samples[samples.length - 1].sw : '-'}, expected ${to}`);
    res.samples = samples.length;
    res.flips = samples.filter((x, i) => i && x.html !== samples[i - 1].html).length;
    // (page language + the switch's choice per sample; the renders in between, after the click: 'e' old, 'r' Russian)
    res.seq = samples.map((x) => (x.html === 'ru' ? 'r' : 'e') + (x.sw === 'ru' ? 'R' : 'E') + (x.why === 'render' ? '*' : '')).join(' ');
    res.renders = samples.filter((x) => x.why === 'render').length;
    // the render that changed the language kept the log and the bar status silent (aria-live off), and they are live
    // again a moment later (reviewer-switch i1 finding 5)
    const first = samples.find((x) => x.html === to);
    check(!!first && first.live.split('/').every((x) => x === 'off' || x === '-'), `bob: the render that switched to ${to} left the live regions (log/bar) at aria-live ${first ? first.live : '-'}; expected off (a screen reader would read the whole log again)`);
    const relive = await bob.page.waitForFunction(() => ['[data-testid="log"]', '[data-testid="action-bar"]'].every((q) => { const e = document.querySelector(q); return !e || e.getAttribute('aria-live') === 'polite'; }), { timeout: 2500 }).then(() => true, () => false);
    check(relive, `bob: the log and the bar status did not become aria-live="polite" again after the switch to ${to}`);
    res.quiet = first ? first.live : null;
    // while the switch waits for the server, the button shows the choice (data-lang), and its accessible name is that
    // language's own, which says what a tap does now (go back), with lang= and aria-busy; the language on screen names
    // it again once the switch is done (review-switch-i2 finding 4)
    const from = to === 'ru' ? 'en' : 'ru';
    const badName = samples.filter((x) => (x.sw === x.html
      ? !(x.swName === L(x.html, 'lang.switch') && x.swBusy === null && x.swLang === null)
      : !(x.sw === to && x.html === from && x.swName === L(to, 'lang.switch') && x.swBusy === 'true' && x.swLang === to)));
    res.pendingSamples = samples.filter((x) => x.sw !== x.html).length;
    check(badName.length === 0, `bob: ${badName.length} samples of the switch to ${to} named the language switch wrongly (${JSON.stringify(badName.slice(0, 2).map((x) => ({ html: x.html, sw: x.sw, name: x.swName, busy: x.swBusy, lang: x.swLang })))})`);
    await phoneTimerCheck(bob, `in ${to}`);
    // no card marked fresh by the switch itself (a changed text is not a reveal)
    const fresh1 = await freshKeys(bob);
    const newFresh = fresh1.filter((k) => !fresh0.includes(k));
    check(newFresh.length === 0, `bob: the switch marked ${newFresh.length} card(s) of ${up} on the table as new: ${JSON.stringify(newFresh.slice(0, 4))} (design §9.3)`);
    res.cardsUp = up;
    // the narrator's clip, playing when the switch was made, is not cut off (the game is known by the catastrophe's id)
    if (a0 && a0.src && !a0.paused) {
      const a1 = await narrAudio(bob);
      check(!!a1 && a1.src === a0.src && !a1.paused && a1.t > a0.t, `bob: the narrator clip stopped or changed at the language switch (${JSON.stringify({ a0, a1 })}) (design §9.5)`);
      res.narrator = a1 ? 'kept playing' : 'gone';
    }
    // nobody else changed: their language and their page
    for (const P of [host, spec]) {
      const st = await state(P);
      const txt = await appText(P);
      check(st && st.you.lang === others[P.name].lang, `${P.name}: you.lang changed to ${st && st.you.lang} when bob switched (SPEC §11 X5.1: a language is not a public change)`);
      check(txt === others[P.name].text, `${P.name}: the page's text changed when bob switched language`);
    }
    if (to === 'ru') {
      // a special card's chip shows the card's Russian title, and so does its popover (a tap on the phone)
      const s = await state(bob);
      const chip = await bob.page.evaluateHandle(() => [...document.querySelectorAll('#sec-specials [data-testid="card-chip"]')].find((e) => window.__e2eVisible(e)) || null);
      const el = chip.asElement();
      if (el) {
        const title = await el.evaluate((e) => e.getAttribute('data-title'));
        const own = s && s.me ? s.me.specials.map((x) => x.title) : [];
        check(own.includes(title) && CYR.test(title), `bob: a special chip is titled ${JSON.stringify(title)} after the switch; expected one of his cards' Russian titles ${JSON.stringify(own)}`);
        await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
        await sleep(150);
        const box = await el.boundingBox();
        let pop = null;
        if (box) {
          await bob.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
          for (let i = 0; i < 20 && !pop; i++) { await sleep(80); pop = await bob.page.$eval(sel('card-popover'), (e) => e.getAttribute('data-title')).catch(() => null); }
        }
        check(pop === title, `bob: the popover of the "${title}" chip is titled ${JSON.stringify(pop)}`);
        await shot('lang-ru-popover', [bob]);
        await bob.page.keyboard.press('Escape');
        res.chip = title;
      } else run.warnings.push('bob: no special chip on his page to check the Russian title of');
      await shot('lang-ru', [bob]);
    }
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
    for (const b of held) b.resumePlay();
  }
  run.stats.lang = { ...(run.stats.lang || {}), [to === 'ru' ? 'bobToRu' : 'bobBack']: res };
  log(`bob switched to ${to}: ${JSON.stringify(res)}`);
}

// Throttles P's download to about `bytes / seconds` (CDP; upload and latency as given). Returns the CDP session and the
// rate in KB/s; unthrottle() and detach it afterwards.
async function throttle(P, seconds, latency = 0) {
  const chars = await P.page.evaluate(() => JSON.stringify(window.__bunkerState).length).catch(() => 60000);
  const bps = Math.max(1024, Math.round(chars / seconds));
  const cdp = await P.page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: bps, uploadThroughput: -1 });
  return { cdp, kbps: Math.round(bps / 102.4) / 10, chars };
}
async function unthrottle(t) {
  if (!t) return;
  await t.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
  await t.cdp.detach().catch(() => {});
}
// In-page recorder for the language checks below: every 20 ms and after every render, the page's language, the state's
// you.lang, whether the log's last lines and the hand's cards are Russian, the connection banner and the socket.
const LANG_REC = () => {
  const cyr = (t) => /[А-Яа-яЁё]/.test(t || '');
  const txt = (q, n) => [...document.querySelectorAll(q)].slice(-n).map((e) => e.textContent).join(' ');
  window.__e2eRec = [];
  const tick = (why) => {
    const s = window.__bunkerState;
    const c = window.__bunkerDebug ? window.__bunkerDebug.conn() : {};
    window.__e2eRec.push({ why, t: Math.round(performance.now()), html: document.documentElement.lang, you: s && s.you ? s.you.lang : null,
      log: cyr(txt('[data-testid="log"] li .lt', 4)), hand: cyr(txt('.hc-text', 8)), banner: !!document.querySelector('[data-testid="conn-banner"]'),
      conn: `${c.status}${c.joined ? '/joined' : ''}`, sw: (document.querySelector('[data-testid="lang-switch"]') || { getAttribute: () => null }).getAttribute('data-lang') });
  };
  tick('start');
  window.__e2eRecIv = setInterval(() => tick('timer'), 20);
  window.__e2eRecMo = new MutationObserver(() => tick('render'));
  window.__e2eRecMo.observe(document.getElementById('app'), { subtree: true, childList: true, characterData: true, attributes: true });
};
const langRecStop = (P) => P.page.evaluate(() => { clearInterval(window.__e2eRecIv); window.__e2eRecMo.disconnect(); return window.__e2eRec; }).catch(() => []);
// server text (the log, the hand) in another language than the page, or the state on screen in another language
const recMixed = (x) => (x.html === 'ru') !== x.log || (x.html === 'ru') !== x.hand || (!!x.you && x.you !== x.html);

// A tap there and back on a slow link, the second tap after the first setLang went out (review-switch-i2 finding 3).
// The answer to the language left arrives first and late (the link is throttled so that a state takes about 2.5 s,
// past the 1.5 s after which the client once took it): the page must skip it and never show that language.
async function langTapBackTest(bob) {
  if (!I18N.loaded) return;
  const held = run.bots.filter((b) => !b.paused);
  for (const b of held) b.pause();
  const res = {};
  let t = null;
  try {
    await sleep(400);
    const l0 = await langShown(bob);
    const left = l0.html === 'ru' ? 'en' : 'ru';
    t = await throttle(bob, 2.5);
    res.kbps = t.kbps;
    const frames = [];
    const T0 = Date.now();
    t.cdp.on('Network.webSocketFrameSent', (e) => { if (/"setLang"/.test(e.response.payloadData)) frames.push({ ms: Date.now() - T0, out: e.response.payloadData }); });
    t.cdp.on('Network.webSocketFrameReceived', (e) => { const m = /^\{"t":"state"[\s\S]*?"you":\{[^}]*"lang":"(en|ru)"/.exec(e.response.payloadData); if (m) frames.push({ ms: Date.now() - T0, state: m[1] }); });
    await bob.page.evaluate(LANG_REC);
    await bob.page.evaluate(() => { const b = () => document.querySelector('[data-testid="lang-switch"]'); b().click(); setTimeout(() => b().click(), 650); });
    // both answers: the one to the language left, then the one to the language kept
    for (let i = 0; i < 200 && frames.filter((f) => f.state).length < 2; i++) await sleep(100);
    await sleep(400);
    const rec = await langRecStop(bob);
    const l1 = await langShown(bob);
    res.frames = frames.map((f) => `${f.ms}:${f.state ? 'state ' + f.state : 'setLang'}`).join(' ');
    res.langs = [...new Set(rec.map((x) => x.html))].join(',');
    const sent = frames.filter((f) => f.out).length;
    const states = frames.filter((f) => f.state).map((f) => f.state);
    check(sent === 2 && states.length === 2 && states[0] === left && states[1] === l0.html,
      `bob: the tap there and back on a slow link did not go as set up (setLang ${sent}, answers ${JSON.stringify(states)}): the check says nothing (${res.frames})`);
    check(rec.length > 5 && rec.every((x) => x.html === l0.html), `bob: a tap there and back on a slow link showed ${left} (${res.langs}; ${res.frames}) (review-switch-i2 finding 3)`);
    check(!!l1 && l1.html === l0.html && l1.you === l0.html && l1.sw === l0.html, `bob: after the tap there and back the page is ${JSON.stringify(l1)}, expected ${l0.html}`);
  } finally {
    await unthrottle(t);
    for (const b of held) b.resumePlay();
  }
  run.stats.lang = { ...(run.stats.lang || {}), tapBack: res };
  log(`bob's tap there and back on a slow link: ${JSON.stringify(res)}`);
}

// A switch around a reconnect, on a slow link (a state takes about 2 s) with some latency (review-switch-i2 finding 2).
// mode 'waiting': the switch is made while the page waits to reconnect (the banner is up). It happens at once, and the
// resume's hello carries it; the banner stays up until the new socket's first state has replaced the old one (in the
// other language). mode 'hello': the switch is made while the resume's hello, in the old language, is on its way. It
// waits like an online switch: the page stays whole in its old language, and changes in one render when the answer
// arrives. Either way no sample shows two languages without the connection banner.
async function langReconnectTest(bob, mode, to) {
  if (!I18N.loaded) return;
  const held = run.bots.filter((b) => !b.paused);
  for (const b of held) b.pause();
  const res = { mode, to };
  let t = null;
  try {
    await sleep(400);
    const l0 = await langShown(bob);
    t = await throttle(bob, 2, 150);
    res.kbps = t.kbps;
    await bob.page.evaluate(LANG_REC);
    const T0 = Date.now();
    await bob.page.evaluate(() => window.__bunkerDebug.drop());
    let at = null;
    for (let i = 0; i < 4000 && !at && Date.now() - T0 < 20000; i++) {
      const c = await bob.page.evaluate(() => window.__bunkerDebug.conn()).catch(() => null);
      if (c && (mode === 'waiting' ? c.status === 'waiting' : c.status === 'open' && !c.joined)) at = c;
      else await sleep(3);
    }
    if (!check(!!at, `bob: the reconnect never reached the moment to switch in (${mode})`)) return;
    await bob.page.evaluate(() => document.querySelector('[data-testid="lang-switch"]').click());
    res.switchAtMs = Date.now() - T0;
    const ok = await bob.page.waitForFunction((l) => { const s = window.__bunkerState; const c = window.__bunkerDebug.conn(); return document.documentElement.lang === l && s && s.you.lang === l && c.status === 'open' && c.joined && !document.querySelector('[data-testid="conn-banner"]'); }, { timeout: 25000, polling: 50 }, to).then(() => true, () => false);
    res.ms = Date.now() - T0;
    await sleep(300);
    const rec = await langRecStop(bob);
    check(ok, `bob: the switch to ${to} around a reconnect (${mode}) did not end online and in ${to} within 25 s (${JSON.stringify(await langShown(bob))})`);
    const bad = rec.filter((x) => recMixed(x) && !x.banner);
    res.samples = rec.length;
    res.mixedWithBanner = rec.filter((x) => recMixed(x) && x.banner).length;
    res.flips = rec.filter((x, i) => i && x.html !== rec[i - 1].html).length;
    check(rec.length > 10 && bad.length === 0, `bob: ${bad.length} of ${rec.length} samples of a switch to ${to} around a reconnect (${mode}) mixed two languages with no connection banner: ${JSON.stringify(bad.slice(0, 3))} (review-switch-i2 finding 2)`);
    // a switch made while the hello is on its way waits for the server: the page flips once, and only when the state
    // in the new language is there
    if (mode === 'hello') {
      const early = rec.filter((x) => x.html === to && x.you !== to);
      check(res.flips === 1 && early.length === 0 && rec[0].html === l0.html, `bob: the switch made while the resume's hello was on its way flipped the page ${res.flips} time(s), ${early.length} sample(s) before the answer (review-switch-i2 finding 2)`);
    }
  } finally {
    await unthrottle(t);
    for (const b of held) b.resumePlay();
  }
  run.stats.lang = { ...(run.stats.lang || {}), ['reconnect-' + mode]: res };
  log(`bob switched to ${to} around a reconnect (${mode}): ${JSON.stringify(res)}`);
}

// SPEC §11 X5.2 on a slow link (review-switch-i2 finding 1). The host's Next goes out over a link throttled so that the
// state that answers it takes about twice ANSWER_MS (4 s). The client must not take the socket for dead: the ping it
// sends just ahead of every action is answered at once, so there is no "No answer from the server" toast, no new
// socket and no banner, and the answer shows when it lands.
async function slowActionTest(P, what, act, done) {
  const held = run.bots.filter((b) => !b.paused);
  for (const b of held) b.pause();
  const res = { what };
  let t = null;
  try {
    await sleep(300);
    t = await throttle(P, 8.5, 100);
    res.kbps = t.kbps;
    res.kb = Math.round(t.chars / 1024);
    let sockets = 0;
    t.cdp.on('Network.webSocketCreated', () => { sockets++; });
    await P.page.evaluate(() => {
      window.__e2eSlow = { toasts: [], banner: false, conn: new Set() };
      window.__e2eSlowIv = setInterval(() => {
        const c = window.__bunkerDebug.conn();
        window.__e2eSlow.conn.add(`${c.status}${c.joined ? '/joined' : ''}`);
        if (document.querySelector('[data-testid="conn-banner"]')) window.__e2eSlow.banner = true;
        for (const e of document.querySelectorAll('[data-testid="error-toast"]')) window.__e2eSlow.toasts.push(e.getAttribute('data-code'));
      }, 50);
    });
    await sleep(300);
    const t0 = Date.now();
    await act();
    const s1 = await waitState(P, done, `${P.name}: the answer to ${what} over a slow link`, 40000).catch(() => null);
    res.ms = Date.now() - t0;
    const w = await P.page.evaluate(() => { clearInterval(window.__e2eSlowIv); const x = window.__e2eSlow; return { toasts: [...new Set(x.toasts)], banner: x.banner, conn: [...x.conn] }; }).catch(() => null);
    res.seen = w;
    res.sockets = sockets;
    check(!!s1, `${P.name}: the answer to ${what} never arrived over a ${t.kbps} KB/s link (SPEC §11 X5.2)`);
    check(!!w && sockets === 0 && !w.banner && w.toasts.length === 0 && w.conn.every((c) => c === 'open/joined'),
      `${P.name}: over a ${t.kbps} KB/s link (a ${res.kb} KB state) the client took its live socket for dead after ${what}: ${JSON.stringify({ sockets, ...w })} (review-switch-i2 finding 1)`);
    if (res.ms < 5000) run.warnings.push(`${P.name}: the throttled answer to ${what} took only ${res.ms} ms, under ANSWER_MS (4 s) + 1 s: the slow path was not exercised`);
  } finally {
    await unthrottle(t);
    for (const b of held) b.resumePlay();
  }
  run.stats.slowAction = res;
  log(`${P.name}: ${what} over a slow link: ${JSON.stringify(res)}`);
}

// A Russian page (Dana, whose browser speaks Russian): in Russian with no Latin letter in the visible text beyond the
// player and spectator names, the room code, the switch's EN/RU and the allowlist (°C, 3D, USB); at 360 × 640 no
// horizontal scroll and the action bar flush (X7, with Russian lengths).
async function ruPageCheck(P, where) {
  if (!I18N.loaded) return;
  await sleep(300);
  const r = await P.page.evaluate(() => {
    const s = window.__bunkerState;
    const names = new Set();
    if (s) {
      for (const p of s.players || []) names.add(p.name);
      for (const x of s.spectators || []) names.add(x.name);
      for (const e of s.log || []) for (const x of e.parts || []) if (x && x.t === 'player') names.add(x.v);
    }
    const drop = [...names].filter(Boolean).sort((a, b) => b.length - a.length);
    if (s && s.room) drop.push(s.room);
    drop.push('°C', '3D', 'USB');
    const bad = [];
    const w = document.createTreeWalker(document.getElementById('app'), NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const el = n.parentElement;
      if (!el || el.closest('[data-testid="lang-switch"]')) continue;
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) continue;
      let t = n.nodeValue;
      for (const d of drop) t = t.split(d).join(' ');
      const m = t.match(/[A-Za-z][A-Za-z'’.-]*/g);
      if (m) bad.push({ in: String(el.className || el.tagName).slice(0, 32), text: n.nodeValue.trim().slice(0, 70), latin: m.slice(0, 4) });
    }
    // text that CSS writes (::before / ::after: quoted strings and attr()), which a text-node scan cannot see (an English
    // " · time's up" once came from a CSS literal)
    for (const el of document.getElementById('app').querySelectorAll('*')) {
      if (el.closest('[data-testid="lang-switch"]')) continue;
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) continue;
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        if (!cs.content || cs.content === 'none' || cs.content === 'normal' || cs.display === 'none') continue;
        let t = [...cs.content.matchAll(/"((?:[^"\\]|\\.)*)"|attr\(([\w-]+)\)/g)].map((x) => (x[2] ? el.getAttribute(x[2]) || '' : x[1])).join(' ');
        for (const d of drop) t = t.split(d).join(' ');
        const m = t.match(/[A-Za-z][A-Za-z'’.-]*/g);
        if (m) bad.push({ in: `${String(el.className || el.tagName).slice(0, 32)}${pseudo}`, text: cs.content.slice(0, 70), latin: m.slice(0, 4) });
      }
    }
    return { html: document.documentElement.lang, you: s && s.you ? s.you.lang : null, n: bad.length, bad: bad.slice(0, 10), sw: document.documentElement.scrollWidth, iw: window.innerWidth };
  }).catch((e) => ({ error: String(e) }));
  check(r.html === 'ru' && r.you === 'ru', `${P.name} @${where}: the page is not Russian (page ${r.html}, you.lang ${r.you}) (SPEC §11 X5.7)`);
  checkRu(r.n === 0, `${P.name} @${where}: ${r.n} Latin text(s) on the Russian page: ${JSON.stringify(r.bad)}`);
  checkRu(r.sw <= r.iw + 1, `${P.name} @${where}: horizontal scroll at ${r.iw} px in Russian (scrollWidth ${r.sw})`);
  await checkBarFlush(P, `${where} (ru)`);
  await phoneTimerCheck(P, `${where} (ru)`);
  (run.stats.ruPage = run.stats.ruPage || []).push({ where, latin: r.n, scroll: r.sw > r.iw + 1 });
}

// ---------------------------------------------------------------------------------------------------------------
// main

async function main() {
  await loadI18n();
  fs.mkdirSync(opts.screens, { recursive: true });
  for (const f of fs.readdirSync(opts.screens)) if (/^(\d\d-.*|FAIL-.*)\.png$|^e2e-(summary|failure-states)\.json$/.test(f)) fs.rmSync(path.join(opts.screens, f));
  if (opts.url) {
    run.baseUrl = opts.url.replace(/\/+$/, '');
    log(`using the running server at ${run.baseUrl}`);
  } else {
    run.server = await spawnServer();
    run.baseUrl = run.server.url;
    log(`spawned the server at ${run.baseUrl} (public dir ${opts.publicDir || 'public'}, seed ${opts.seed})`);
  }
  run.browser = await puppeteer.launch({
    executablePath: CHROME, headless: !opts.headful, slowMo: SLOW ? 40 : 0, defaultViewport: null,
    // the narrator's clip plays at the start without a user gesture; muted: media still plays, the speakers stay quiet
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const host = await newPage(await run.browser.createBrowserContext(), 'host', DESKTOP);
  const bob = await newPage(await run.browser.createBrowserContext(), 'bob', MOBILE);
  const spec = await newPage(await run.browser.createBrowserContext(), 'spectator', DESKTOP);
  const humans = [host, bob];

  // 1. host creates a game
  await host.page.goto(run.baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await waitHook(host, 'name-input');
  await shot('landing', [host], { alsoMobile: true });
  await checkReportLinks(host, 'landing', '');   // SPEC §11 X10: the landing footer
  await checkVersion(host, 'landing');
  await landingLangTest(host);   // SPEC §11 X5.7: the switch on the landing page, the look-alike room code
  check(!(await host.page.$(sel('profile-tag'))), 'the landing shows a profile tag without ?profile= (SPEC §11 X9.1)');
  await typeInto(host, 'name-input', 'Alice');
  await sleep(PAUSE);
  await click(host, 'create-btn');
  const codeEl = await host.page.waitForSelector(sel('room-code'), { visible: true, timeout: TIMEOUT }).catch(() => null);
  if (!codeEl) throw new StuckError('host: room-code never appeared after create-btn');
  const code = (await codeEl.evaluate((e) => e.textContent)).trim();
  check(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(code), `room-code text is ${JSON.stringify(code)}, expected exactly the 4-letter code`);
  const hs0 = await waitState(host, (s) => s.phase === 'lobby' && s.room === code && s.you.isHost, 'the lobby as host');
  host.id = hs0.you.id;
  const hh = await host.page.evaluate(() => window.__e2eHellos || []).catch(() => []);
  check(!I18N.loaded || (hh.length === 1 && hh[0].t === 'create' && hh[0].lang === 'en'), `host: the create hello carried ${JSON.stringify(hh)}; expected lang "en" (SPEC §11 X5.1)`);
  await waitHook(host, 'copy-link-btn', '', 'the copy-link button');
  log(`room ${code} created by Alice (${host.id})`);
  await checkBarEstimate(host, 'the host alone, below the minimum');

  // 2. a second human joins through the link (mobile)
  await bob.page.goto(`${run.baseUrl}/?room=${code}`, { waitUntil: 'domcontentloaded' });
  await waitHook(bob, 'name-input');
  const prefilled = await bob.page.$eval(sel('room-input'), (e) => e.value).catch(() => null);
  if (!check(prefilled && prefilled.trim().toUpperCase() === code, `bob: /?room=${code} did not pre-fill room-input (value ${JSON.stringify(prefilled)})`)) await typeInto(bob, 'room-input', code);
  await typeInto(bob, 'name-input', 'Bob');
  await sleep(PAUSE);
  await click(bob, 'join-btn');
  const bs0 = await waitState(bob, (s) => s.phase === 'lobby' && s.you.role === 'player', 'bob in the lobby');
  bob.id = bs0.you.id;

  // 3. a spectator
  await spec.page.goto(`${run.baseUrl}/?room=${code}`, { waitUntil: 'domcontentloaded' });
  await typeInto(spec, 'name-input', 'Carol');
  await sleep(PAUSE);
  await click(spec, 'spectate-btn');
  await waitState(spec, (s) => s.you.role === 'spectator' && s.me === null, 'the spectator view');

  // 4. bots fill the table
  const coord = new Coordinator();
  const nBots = opts.players - 2;
  for (let i = 0; i < nBots; i++) {
    const bot = new Bot({ url: run.baseUrl, name: BOT_NAMES[i], seed: `${opts.seed}:bot${i}`, delay: SLOW ? 1200 : 250, speechDelay: SLOW ? 2500 : 350,
      specials: 0.25, airlockOpen: 0, coordinator: coord, maxRate: 16, log: SLOW ? log : null });
    run.bots.push(bot);
    await bot.join(code);
  }
  await waitState(host, (s) => s.players.length === opts.players, `${opts.players} seated players`);
  const lobbyIds = await hookValues(host, 'lobby-player', 'data-player-id', false);
  const hsL = await state(host);
  check(sameSet(lobbyIds, hsL.players.map((p) => p.id)), `lobby-player ids ${JSON.stringify(lobbyIds)} != players ${JSON.stringify(hsL.players.map((p) => p.id))}`);
  const kickBtns = await hookValues(host, 'kick-btn', 'data-player-id', false);
  check(kickBtns.length >= 1 && !kickBtns.includes(host.id), `host lobby: kick-btn should exist for other players and not for the host (got ${JSON.stringify(kickBtns)})`);
  const bobStart = await hookValues(bob, 'start-btn', 'data-testid');
  check(bobStart.length === 0, 'bob (not host) has an enabled start-btn');
  await estimateTest(host, bob, spec);
  await narratorLobby(bob);
  await shot('lobby-full', run.pages, { alsoMobile: true });
  // SPEC §11 X10: the header menu in the lobby (desktop and phone) and the rules sheet
  await headerMenuTest(host, code, 'lobby');
  await headerMenuTest(bob, code, 'lobby');
  await rulesLinksTest(host, code);

  // 5. start
  await sleep(PAUSE);
  await click(host, 'start-btn');
  await waitState(host, (s) => s.phase === 'reveal', 'the game to start');
  await waitState(bob, (s) => s.phase === 'reveal', 'bob to see the game');
  await waitState(spec, (s) => s.phase === 'reveal', 'the spectator to see the game');
  await narratorStart(bob, [host, spec]);
  await shot('game-start', run.pages, { alsoMobile: true });
  // SPEC §11 X5.8: bob plays in Russian from here through his first vote (his narrator clip is playing now), and
  // switches back before the English checks of the final and of End game
  if (I18N.loaded) {
    // the host reveals first in round 1: a card on the table that the switch must not mark as new
    const h1 = await state(host);
    if (h1.turn && h1.turn.speakerId === host.id && !h1.turn.hasRevealed) await playMyTurn(host, h1, 'hostTurns');
    await langDoubleTapTest(bob);
    await langTapBackTest(bob);
    await langSwitchTest(host, bob, spec, 'ru');
    // a switch around a reconnect, both ways (bob is Russian again afterwards)
    await langReconnectTest(bob, 'waiting', 'en');
    await langReconnectTest(bob, 'hello', 'ru');
    run.bobRu = { from: 'the start of game 1' };
  }

  // 6. play
  const specialP = rng() < 0.5 ? [host, bob] : [bob, host];
  let pausedBot = null;
  let closeVoteDone = false;
  let lastSig = '';
  let lastProgress = Date.now();
  let iter = 0;
  let discussionShot = false;
  for (;;) {
    iter++;
    const hs = await state(host);
    if (!hs) throw new StuckError('host: no __bunkerState');
    const sig = [hs.phase, hs.round, hs.overtime, hs.turn && hs.turn.index, hs.turn && hs.turn.hasRevealed, hs.vote && hs.vote.ballot,
      hs.vote && hs.vote.stage, hs.vote && hs.vote.voted.length, hs.log.length && hs.log[hs.log.length - 1].id].join('|');
    if (sig !== lastSig) { lastSig = sig; lastProgress = Date.now(); }
    if (Date.now() - lastProgress > TIMEOUT) throw new StuckError(`the game made no progress for ${TIMEOUT} ms; host state: ${describeState(hs)}`);
    // SPEC §11 X1: an airlock left alone jams once its round's discussion is over (or a bot closed it meanwhile)
    const aw = run.airlockWatch;
    if (aw && (hs.round !== aw.round || !!hs.overtime !== aw.overtime || !['reveal', 'discussion'].includes(hs.phase))) {
      run.airlockWatch = null;
      const t = playerById(hs, aw.T);
      // (by key and target id, SPEC §11 X5.3; a server without keys: the English line and the name)
      const onT = (a) => !!a && (a.t !== undefined ? a.t === aw.T : a.target === aw.name);
      const jammed = hs.log.some((e) => { const a = airlockOf(e); return !!a && a.kind === 'jam' && onT(a); });
      // sealed by a bot (the victim may be back already: a revive), or its target is gone
      const closed = (!!t && t.status !== 'alive') || hs.log.some((e) => { const a = airlockOf(e); return !!a && a.kind === 'seal' && onT(a); })
        || hs.log.some((e) => !e.key && e.kind === 'eject' && (AIRLOCK_SEALED_RE.exec(e.text) || [])[3] === aw.name);
      check((jammed || closed) && !(hs.airlocks || []).some((a) => a.targetId === aw.T),
        `the airlock on ${aw.name} is still open after its round's discussion (jammed line ${jammed}, ${aw.name} ${t && t.status}; SPEC §11 X1.2)`);
      await checkAirlockBadges(host);
      if (run.stats.airlock) run.stats.airlock.after = jammed ? 'jammed' : 'closed by a bot';
      log(`the airlock on ${aw.name}: ${jammed ? 'jammed' : 'closed by a bot'}`);
    }
    if (hs.phase === 'final') break;
    if (run.server && run.server.exited) throw new Error(`the server exited: ${JSON.stringify(run.server.exited)}\n${run.server.err}`);

    // periodic hook checks
    if (iter % 15 === 1) await periodicChecks(host, bob, spec);

    // a) human turns and votes
    let acted = false;
    for (const P of humans) {
      const s = P === host ? hs : await state(P);
      if (!s || !s.you) continue;
      const statKey = P === host ? 'hostTurns' : 'bobTurns';
      if (s.turn && s.turn.speakerId === s.you.id && (s.phase === 'reveal' || s.phase === 'defense')) {
        await playMyTurn(P, s, statKey);
        acted = true;
        break;
      }
      if (s.phase === 'vote' && s.vote && s.vote.voters.includes(s.you.id) && s.me && !s.me.myVote) {
        await castVote(P, s, P === host ? 'hostVotes' : 'bobVotes');
        // SPEC §11 X5.8: bob's Russian stretch ends with his first vote
        if (P === bob && run.bobRu && !run.bobRu.back && run.stats.bobVotes > 0) {
          run.bobRu.back = `after his first vote (round ${s.round})`;
          await langSwitchTest(host, bob, spec, 'en', { slow: true });
        }
        acted = true;
        break;
      }
    }
    if (acted) continue;

    // b) the reconnect test: reload bob mid-game (round >= 2, not bob's turn)
    if (!run.stats.reload && hs.round >= 2 && hs.phase === 'reveal' && hs.turn.speakerId !== bob.id) {
      await reloadTest(bob);
      continue;
    }
    // b1) a resume the server refuses with server_busy (SPEC §11 V2) is retried with backoff, under a banner (f2)
    if (run.stats.reload && !run.stats.busyResume && (hs.phase === 'reveal' || hs.phase === 'discussion') && (!hs.turn || hs.turn.speakerId !== bob.id)) {
      await busyResumeTest(host, bob);
      continue;
    }

    // b2) the airlock UI (SPEC §11 X1.7): a bot opens an airlock during a reveal phase from round 2 (it stays open
    // until this round's discussion ends, and the host only presses Next there after this step)
    if (!run.stats.airlock && hs.round >= 2 && hs.phase === 'reveal' && !(run.airlockRounds && run.airlockRounds.has(hs.round))) {
      await airlockTest(host, bob, spec);
      continue;
    }
    // b3) a human holding "Back from the Forest" brings an airlock victim back (SPEC §11 X1.4), when the deal allows it
    if (!run.stats.revive && (hs.phase === 'reveal' || hs.phase === 'discussion') && airlockVictims(hs).length) await reviveTest(host, bob);

    // c) one special through the UI (in a discussion: the host controls when it ends)
    if (!run.stats.special && hs.phase === 'discussion') {
      for (const P of specialP) {
        if (await playSpecial(P)) break;
      }
      if (!run.stats.special) log(`no playable special for the humans in round ${hs.round} discussion; will retry`);
    }
    // c2) a played special's title chip opens its rules text (SPEC §11 X3): hover on the desktop, tap on the phone
    if (!run.stats.popover && hs.phase === 'discussion' && hs.players.some((p) => p.playedSpecials.length)) await popoverTest(host, bob);

    // d) host driving
    if (hs.phase === 'discussion') {
      if (!discussionShot) {
        discussionShot = true;
        await shot('discussion', run.pages, { alsoMobile: true });
        await headerMenuTest(spec, code, 'in play');   // SPEC §11 X10: the header menu in play (the spectator: nothing to hold up)
      }
      if (!run.stats.twoTap && bob.id && playerById(hs, bob.id) && playerById(hs, bob.id).status === 'alive') await twoTapTest(host, bob);
      // before the first vote step, keep one bot from voting so the host has to use Close vote
      if (!closeVoteDone && !pausedBot && hs.schedule && hs.schedule.nextVoteRound === hs.round && hs.schedule.kicksThisStep > 0) {
        pausedBot = run.bots.find((b) => b.id && playerById(hs, b.id) && playerById(hs, b.id).status === 'alive') || null;
        if (pausedBot) { pausedBot.pause(); log(`${pausedBot.name} will not vote in the first ballot (to exercise close-vote-btn)`); }
      }
      await sleep(SLOW ? 2500 : 300);
      const hs2 = await state(host);
      if (hs2 && hs2.phase === 'discussion' && hs2.round === hs.round) {
        // the host's own Next opens the vote: on a phone its choices take that button's spot, so the page holds them
        // for a moment and a "did it work?" re-tap cannot vote (SPEC §11, f2)
        const watchHold = !run.stats.voteHold && hs2.schedule && hs2.schedule.kicksThisStep > 0 && !hs2.voteMods.cancelNext;
        if (watchHold) await watchVoteHold(host);
        const leftDiscussion = (x) => x.phase !== 'discussion' || x.round !== hs.round || x.overtime !== hs.overtime || (x.timer && hs2.timer && x.timer.endsAt !== hs2.timer.endsAt);
        // SPEC §11 X5.2: once, this Next goes out over a slow link (its answer takes about 2 × ANSWER_MS)
        if (!run.stats.slowAction && !watchHold && hs.round >= 2) await slowActionTest(host, 'Next at the end of the discussion', () => click(host, 'next-btn', '', 'Next at the end of the discussion'), leftDiscussion);
        else await click(host, 'next-btn', '', 'Next at the end of the discussion');
        run.stats.nextClicks++;
        await waitState(host, leftDiscussion, 'Next to leave the discussion');
        if (watchHold) await checkVoteHold(host);
      }
      continue;
    }
    if ((hs.phase === 'reveal' || hs.phase === 'defense') && hs.turn) {
      const sp = playerById(hs, hs.turn.speakerId);
      if (sp && !sp.connected) {
        await sleep(PAUSE);
        await click(host, 'next-btn', '', 'Next for an offline speaker');
        run.stats.nextClicks++;
        await waitState(host, (x) => !x.turn || x.turn.index !== hs.turn.index || x.phase !== hs.phase, 'Next to skip the offline speaker');
        continue;
      }
    }
    if (hs.phase === 'vote' && hs.vote) {
      const missing = hs.vote.voters.filter((id) => !hs.vote.voted.includes(id));
      const onlyPaused = pausedBot && missing.length === 1 && missing[0] === pausedBot.id;
      const onlyOffline = missing.length && missing.every((id) => !playerById(hs, id).connected);
      if (onlyPaused || onlyOffline) {
        await shot('before-close-vote', [host]);
        await sleep(PAUSE);
        await click(host, 'close-vote-btn', '', 'Close vote');
        run.stats.closeVoteClicks++;
        await waitState(host, (x) => x.phase !== 'vote' || !x.vote || x.vote.ballot !== hs.vote.ballot || x.vote.stage !== hs.vote.stage, 'Close vote to close the ballot');
        if (onlyPaused) { closeVoteDone = true; pausedBot.resumePlay(); pausedBot = null; await shot('vote-result', run.pages); }
        continue;
      }
      if (pausedBot && !hs.vote.voters.includes(pausedBot.id)) { pausedBot.resumePlay(); pausedBot = null; }
    }
    if (pausedBot && hs.phase !== 'vote' && hs.phase !== 'discussion' && hs.phase !== 'defense') { pausedBot.resumePlay(); pausedBot = null; }
    // the paused bot may itself be tied and have to defend (e.g. it was blocked, so the ballot closed without it):
    // a paused bot never ends its speech, so let it play again
    if (pausedBot && hs.phase === 'defense' && hs.turn && hs.turn.speakerId === pausedBot.id) { pausedBot.resumePlay(); pausedBot = null; }
    await sleep(100);
  }

  // 7. final
  log('final reached');
  // (bob never voted in Russian, e.g. he was out first: back to English for the English checks from here on)
  if (run.bobRu && !run.bobRu.back) {
    run.bobRu.back = 'at the final (he cast no vote in Russian)';
    run.warnings.push(`bob's Russian stretch ended ${run.bobRu.back}`);
    await langSwitchTest(host, bob, spec, 'en', { slow: true });
  }
  if (run.bobRu) run.stats.lang = { ...(run.stats.lang || {}), bobStretch: run.bobRu };
  for (const P of humans) await checkSentSteps(P);
  const sentN = run.stats.sentSteps;
  check((sentN.vote || 0) > 0 && ((sentN.reveal || 0) + (sentN.endTurn || 0)) > 0 && (sentN.next || 0) > 0,
    `too few turn/ballot actions were seen on the wire to check their step key: ${JSON.stringify(sentN)}`);
  check(!!run.stats.twoTap, 'the two-click Leave/Kick check did not run');
  check(run.stats.hostTurns + run.stats.bobTurns >= 2, `the humans played only ${run.stats.hostTurns + run.stats.bobTurns} turns via the UI`);
  if (!run.stats.special) run.warnings.push('no special could be played through the UI in this run (none was playable for the humans in a discussion)');
  check(!!run.stats.reload, 'the reload test did not run');
  check(!!run.stats.estimate && run.stats.estimate.ok, 'the lobby estimate check did not run');
  if (!run.stats.popover) run.warnings.push('the card-chip popover check did not run (no special was played in a discussion)');
  if (!run.stats.slowAction) run.warnings.push('the slow-link action check did not run (no discussion from round 2 on without the vote-hold check)');
  // SPEC §11 X1: from 4 players on, at least two Airlocks are dealt, so the check must run (under 4 none are dealt)
  const airlockRan = run.stats.airlock && !run.stats.airlock.skipped;
  if (!airlockRan && run.stats.airlock && run.stats.airlock.expected) run.warnings.push(`the airlock UI check did not run: ${run.stats.airlock.skipped}`);
  else if (!airlockRan && run.stats.airlock && /no `airlocks`/.test(run.stats.airlock.skipped)) run.warnings.push(`the airlock UI check did not run: ${run.stats.airlock.skipped}`);
  else check(airlockRan, `the airlock UI check did not run: ${run.stats.airlock ? run.stats.airlock.skipped : 'no reveal phase from round 2'}`);
  for (const P of run.pages) {
    await waitHook(P, 'final-screen', '', 'the final screen').catch(async (e) => {
      // final-screen is a container, not an action: it may not be "enabled"-able, so fall back to presence
      const el = await P.page.$(sel('final-screen'));
      if (!el) throw e;
    });
  }
  const fs1 = await state(host);
  for (const P of run.pages) await checkBoard(P, fs1, 'final');
  // SPEC §11 X7: the game-over hero is brought into view inside the shell (bob's phone may be scrolled down to his
  // hand), never by scrolling the page, which would slide the bar up off the bottom
  const fb = await bob.page.evaluate(() => {
    const f = document.querySelector('.final-banner');
    const body = document.querySelector('#app .shell .body');
    if (!f || !body) return null;
    return { top: f.getBoundingClientRect().top, bodyTop: body.getBoundingClientRect().top, scrollY: window.scrollY };
  }).catch(() => null);
  check(!!fb && fb.scrollY === 0 && fb.top >= fb.bodyTop - 1 && fb.top < fb.bodyTop + 120,
    `bob: the final banner was not brought into view inside the shell on the phone (${JSON.stringify(fb)}) (SPEC §11 X7)`);
  await checkBarFlush(bob, 'final');
  await checkFinalReading(fs1);
  // SPEC §11 X10: the final screen's links (every page), and the header menu there
  for (const P of run.pages) await checkReportLinks(P, 'final', code);
  await headerMenuTest(host, code, 'final');
  await sleep(SLOW ? 1500 : 300);
  await shot('final', run.pages, { alsoMobile: true });
  const again = await hookValues(bob, 'play-again-btn', 'data-testid');
  check(again.length === 0, 'bob (not host) has an enabled play-again-btn');

  // 8. play again
  await sleep(PAUSE);
  await click(host, 'play-again-btn');
  const back = await waitState(host, (s) => s.phase === 'lobby', 'the lobby after Play again');
  await waitState(bob, (s) => s.phase === 'lobby', 'bob back in the lobby');
  await waitState(spec, (s) => s.phase === 'lobby' && s.you.role === 'spectator', 'the spectator back in the lobby (still a spectator)');
  await waitHook(host, 'start-btn', '', 'Start in the new lobby');
  const lobbyAgain = await hookValues(host, 'lobby-player', 'data-player-id', false);
  check(sameSet(lobbyAgain, back.players.map((p) => p.id)) && back.players.length === opts.players, `lobby after Play again: ${lobbyAgain.length} lobby-player hooks, ${back.players.length} players (expected ${opts.players})`);
  await sleep(SLOW ? 1500 : 300);
  await shot('lobby-again', run.pages, { alsoMobile: true });

  // 8b. SPEC §11 X6: the host ends a game mid-round; a late arrival takes a seat; a new game starts
  await endGameTest(host, bob, spec, code);

  // 9. names are free text: a mock final with hostile names (no server needed), and the popover's edge cases
  await namesTest();
  // 10. more mock screens (SPEC §11, client-fixer f2)
  await mockChecks();
  // 11. SPEC §11 X9.1: ?profile= isolation in one browser context
  await profileTest();
}

// SPEC §11 X6: "End game → back to the lobby". The host starts another game; a friend who arrives during it can only
// watch. Mid-round the host ends it with end-game-btn: one click (and a double click) only arms it, a second deliberate
// click sends endGame. Everyone lands in the lobby (the same seats, spectators still spectators), is told why, and the
// log carries "The host ended the game". The late arrival takes a seat (on a full table the host first kicks a bot in
// the lobby), and the next game deals them in.
async function endGameTest(host, bob, spec, code) {
  await sleep(PAUSE);
  await click(host, 'start-btn', '', 'Start (the second game)');
  await waitState(host, (s) => s.phase === 'reveal', 'the second game to start');
  await waitState(bob, (s) => s.phase === 'reveal', 'bob in the second game');
  // a late arrival opens the link while the game runs: joined as a spectator
  // (SPEC §11 X5.8: Dana's phone speaks Russian and she chose nothing, so her first visit is Russian; she stays so,
  // on a 360 × 640 screen)
  const late = await newPage(await run.browser.createBrowserContext(), 'late', I18N.loaded ? PHONE_360 : MOBILE, { lang: 'ru' });
  await late.page.goto(`${run.baseUrl}/?room=${code}`, { waitUntil: 'domcontentloaded' });
  if (I18N.loaded) {
    await waitHook(late, 'name-input');
    const l0 = await langShown(late);
    check(!!l0 && l0.html === 'ru' && l0.sw === 'ru', `Dana: a first visit from a Russian browser is not Russian (${JSON.stringify(l0)}) (SPEC §11 X5.7)`);
  }
  await typeInto(late, 'name-input', 'Dana');
  await sleep(PAUSE);
  await click(late, 'join-btn');
  const ls0 = await waitState(late, (s) => s.you.role === 'spectator' && GAME_PHASES_E2E.includes(s.phase), 'the late arrival watching the running game');
  late.id = ls0.you.id;
  if (I18N.loaded) {
    // her join carried the language: the server spoke Russian from its first answer, and no setLang was needed
    const w = await late.page.evaluate(() => ({ hellos: window.__e2eHellos || [], setLang: window.__e2eSetLang || 0 })).catch(() => null);
    check(!!w && w.hellos.length === 1 && w.hellos[0].t === 'join' && w.hellos[0].lang === 'ru' && w.setLang === 0, `Dana: her hellos were ${JSON.stringify(w)}; the join must carry lang "ru" (SPEC §11 X5.1)`);
  }
  await ruPageCheck(late, 'watching game 2');
  // mid-round: the host's Next moves the reveals on by a speaker or two, then the host ends it
  for (let i = 0; i < 2; i++) {
    const h0 = await state(host);
    if (h0.phase !== 'reveal' || !h0.turn || h0.turn.index >= 1) break;
    await sleep(PAUSE);
    await click(host, 'next-btn', '', 'Next (the second game)');
    await waitState(host, (s) => s.phase !== 'reveal' || !s.turn || s.turn.index !== h0.turn.index, 'Next to move the reveals on');
  }
  const hs0 = await state(host);
  check(GAME_PHASES_E2E.includes(hs0.phase), `the second game is not running before End game (${hs0.phase})`);
  // only the host has it; nobody else, not even disabled
  for (const P of [bob, spec, late]) {
    const n = await P.page.$$eval(sel('end-game-btn'), (els) => els.length).catch(() => -1);
    check(n === 0, `${P.name}: end-game-btn is on the page for a non-host (${n})`);
  }
  await checkSentSteps(host);
  // one double click arms it and sends nothing
  const hit = await doubleClickArming(host, 'end-game-btn', '');
  check(hit, 'host: the double click never landed on end-game-btn, so the X6 two-tap check could not run');
  await sleep(600);
  const sent1 = await host.page.evaluate(() => (window.__e2eSent || []).filter((f) => f.t === 'endGame').length).catch(() => -1);
  const hs1 = await state(host);
  check(sent1 === 0 && GAME_PHASES_E2E.includes(hs1.phase), `host: a DOUBLE click on end-game-btn ended the game (endGame frames ${sent1}, phase ${hs1.phase}); it must take two separate taps (SPEC §11 X6)`);
  const armed = await host.page.evaluate(() => {
    const b = document.querySelector('[data-testid="end-game-btn"]');
    const note = document.querySelector('.bar-endnote');
    return { text: b ? b.textContent.trim() : null, note: note ? note.textContent : '' };
  }).catch(() => ({}));
  check(/again/i.test(armed.text || '') && /late arrivals can then take a seat/.test(armed.note || ''),
    `host: the armed End game does not say what a second tap does (button ${JSON.stringify(armed.text)}, note ${JSON.stringify(armed.note)})`);
  await shot('end-game-armed', [host]);
  // the second, deliberate tap (still within ARM_MS) ends it
  await click(host, 'end-game-btn', '', 'End game, second tap');
  const back = await waitState(host, (s) => s.phase === 'lobby', 'the lobby after End game');
  for (const P of [bob, spec, late]) await waitState(P, (s) => s.phase === 'lobby', `${P.name} back in the lobby after End game`);
  const sent2 = await host.page.evaluate(() => (window.__e2eSent || []).filter((f) => f.t === 'endGame').length).catch(() => -1);
  check(sent2 === 1, `host: End game sent ${sent2} endGame frames (expected exactly 1)`);
  check(back.players.length === hs0.players.filter((p) => p.status !== 'left').length && back.players.some((p) => p.id === bob.id),
    `End game: ${back.players.length} seated in the lobby, expected everyone who had not left (${hs0.players.length})`);
  check((back.log || []).some((e) => e.kind === 'system' && (e.key ? e.key === 'log.endGame' : e.text === 'The host ended the game')), 'End game: the log has no "The host ended the game" line');
  const ls1 = await state(late);
  check(ls1.you.role === 'spectator' && (await state(spec)).you.role === 'spectator', 'End game: a spectator was seated by it');
  // Dana (Russian) is told too: by the hooks and the keys, not by English words
  const danaToast = await late.page.waitForSelector('[data-testid="info-toast"][data-code="ended"]', { timeout: 3000 }).then(() => true, () => false);
  check(danaToast && (ls1.log || []).some((e) => e.key === 'log.endGame' && e.kind === 'system'), `Dana: after End game no "ended" flash (${danaToast}) or no log.endGame line in her log`);
  await ruPageCheck(late, 'the lobby after End game');
  // everyone is told why (a flash) and the lobby's bar says so
  const told = await bob.page.evaluate(() => {
    const t = [...document.querySelectorAll('[data-testid="info-toast"][data-code="ended"]')].map((e) => e.textContent);
    const eb = document.querySelector('.bar-eyebrow');
    return { toast: t.join(' | '), eyebrow: eb ? eb.textContent : '' };
  }).catch(() => ({}));
  check(/ended the game/.test(told.toast || '') && /host ended the last game/i.test(told.eyebrow || ''), `bob: not told that the host ended the game (${JSON.stringify(told)})`);
  await shot('end-game-lobby', [host, bob, late]);
  // a full table: the host makes room first (in the lobby a kick is one tap)
  let lob = await state(host);
  if (lob.players.length >= lob.maxPlayers) {
    const bot = run.bots.find((b) => lob.players.some((p) => p.id === b.id));
    check(!!bot, 'End game: a full table without a bot to make room');
    if (bot) {
      await click(host, 'kick-btn', `[data-player-id="${bot.id}"]`, `kick ${bot.name} to make room`);
      lob = await waitState(host, (s) => s.phase === 'lobby' && s.players.length < s.maxPlayers, 'a free seat');
    }
  }
  await click(late, 'take-seat-btn', '', 'Take a seat (late arrival)');
  await waitState(late, (s) => s.you.role === 'player' && s.players.some((p) => p.id === late.id), 'the late arrival seated');
  await ruPageCheck(late, 'seated in the lobby');
  await waitState(host, (s) => s.players.some((p) => p.id === late.id), 'the host to see the late arrival seated');
  await sleep(PAUSE);
  await click(host, 'start-btn', '', 'Start (with the late arrival)');
  const ls2 = await waitState(late, (s) => s.phase === 'reveal' && !!s.me && Object.keys(s.me.cards || {}).length === 8, 'the late arrival dealt into the new game');
  await ruPageCheck(late, 'playing game 3');
  await waitHook(host, 'player-card', `[data-player-id="${late.id}"]`, 'the late arrival on the host\'s table').catch(async (e) => {
    if (!(await host.page.$(sel('player-card', `[data-player-id="${late.id}"]`)))) throw e;
  });
  // the event log of the new game still carries the line (the log is kept across games)
  const logged = await host.page.$eval(sel('log'), (e) => e.textContent.includes('The host ended the game')).catch(() => false);
  check(logged, 'host: the event log of the next game does not show "The host ended the game"');
  await shot('after-end-game', [host, late]);
  run.stats.endGame = { endedIn: `${hs1.phase} r${hs1.round}`, doubleClickFrames: sent1, frames: sent2, seatedAfter: ls2.players.length, lateId: late.id };
  log(`End game: ended ${hs1.phase} of round ${hs1.round} (a double click sent nothing), everyone back in the lobby, Dana took a seat, a ${ls2.players.length}-player game started`);
}
const GAME_PHASES_E2E = ['reveal', 'discussion', 'vote', 'defense'];

// SPEC §11 FX1: the final banner and the log read the lines by their exact shapes (public/loglines.js): the banner's
// cause is the one finalCause() gives for the state, and exactly the airlock lines are styled as airlock lines.
async function checkFinalReading(s) {
  const want = finalCause(s).kind;
  const airN = s.log.filter((e) => airlockOf(e)).length;
  for (const P of run.pages) {
    const got = await P.page.evaluate(() => {
      const c = document.querySelector('[data-testid="final-cause"]');
      return { cause: c ? c.getAttribute('data-cause') : null, air: document.querySelectorAll('[data-testid="log"] li.k-airlock').length, lines: document.querySelectorAll('[data-testid="log"] li').length };
    }).catch(() => null);
    check(!!got && got.cause === want, `${P.name}: the final banner's cause is ${got && got.cause}, the log says ${want} (SPEC §11 K5/FX1)`);
    // the log shows the last 200 lines of the state, so the counts compare only when it shows all of them
    if (got && got.lines === s.log.length) check(got.air === airN, `${P.name}: ${got.air} log lines styled as airlock lines, ${airN} airlock lines in the log`);
  }
  run.stats.finalCause = want;
}

// SPEC §11 FX1/FX3: player names may carry 🚪, quotes and quoted card titles. The mock final "hostile-names" (served by
// the same server, rendered without one) has "🚪 Rex" voted out last, a player named "Airlock" (in quotes) thrown out
// through a real airlock, and a player named 'played “Alibi”: a →' who played Spy. The banner must name the vote, only
// the two real airlock lines are airlock lines, and the log's only chips are the cards really played. Then the
// popover: a pinned chip scrolled out of the log closes, and a chip pinned with the keyboard closes when Tab moves on.
async function namesTest() {
  const P = await newPage(await run.browser.createBrowserContext(), 'names', DESKTOP);
  await P.page.goto(`${run.baseUrl}/?mock=hostile-names`, { waitUntil: 'domcontentloaded' });
  await P.page.waitForSelector(sel('final-cause'), { timeout: 8000 }).catch(() => null);
  await sleep(400);
  const r = await P.page.evaluate(() => {
    const c = document.querySelector('[data-testid="final-cause"]');
    const log = document.querySelector('[data-testid="log"]');
    return {
      cause: c ? c.getAttribute('data-cause') : null,
      causeText: c ? c.textContent : '',
      airlockLines: [...log.querySelectorAll('li.k-airlock')].map((l) => l.querySelector('.lt').textContent),
      logChips: [...log.querySelectorAll('[data-testid="card-chip"]')].map((x) => x.getAttribute('data-title')).sort(),
      spyText: (log.querySelector('[data-testid="card-chip"][data-title="Spy"]') || { getAttribute: () => null }).getAttribute('data-pop-text'),
      alibi: document.querySelectorAll('[data-title="Alibi"]').length,
    };
  }).catch((e) => ({ error: String(e) }));
  check(r.cause === 'vote' && /Rex/.test(r.causeText), `names: the final banner reads ${JSON.stringify([r.cause, r.causeText])}; "🚪 Rex" was voted out last, so it is "The last vote" (SPEC §11 FX1)`);
  check(r.airlockLines && r.airlockLines.length === 2 && r.airlockLines.every((t) => t.startsWith('🚪 ') && /the airlock/.test(t)),
    `names: log lines styled as airlock lines: ${JSON.stringify(r.airlockLines)}; expected exactly the 2 real ones (a start and a seal)`);
  check(JSON.stringify(r.logChips) === JSON.stringify(['Airlock', 'Airlock', 'Spy']) && r.alibi === 0,
    `names: card chips in the log ${JSON.stringify(r.logChips)} (and ${r.alibi} "Alibi" chips on the page); expected only Spy and the two airlock lines' Airlock (SPEC §11 FX1)`);
  check(/^Secretly look at one hidden card/.test(r.spyText || ''), `names: the Spy chip's text is ${JSON.stringify(r.spyText)}, not the card's own`);
  const popInfo = () => P.page.evaluate(() => (window.__bunkerDebug && window.__bunkerDebug.popover ? window.__bunkerDebug.popover() : null));
  // a pinned popover whose chip scrolls out of the log closes (it must not float next to a hidden chip)
  const chip = '[data-testid="log"] [data-testid="card-chip"][data-title="Spy"]';
  await P.page.$eval(chip, (e) => e.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await (await P.page.$(chip)).click();
  await sleep(250);
  const pinned = await popInfo();
  check(!!pinned && pinned.pinned && pinned.title === 'Spy', `names: clicking the Spy chip in the log showed ${JSON.stringify(pinned)}`);
  // scrolled just past the log's top edge: the chip is hidden by the log, but still inside the viewport (the case the
  // viewport test alone missed)
  const out = await P.page.$eval(chip, (e) => {
    const log = e.closest('[data-testid="log"]');
    const a0 = e.getBoundingClientRect();
    const b = log.getBoundingClientRect();
    log.scrollTop += Math.ceil(a0.bottom - b.top + 4);
    const a = e.getBoundingClientRect();
    return (a.bottom <= b.top || a.top >= b.bottom) && a.bottom > 0 && a.top < window.innerHeight;
  });
  await sleep(250);
  const after = await popInfo();
  if (out) check(!after, `names: the Spy chip scrolled out of the log, but its popover stayed: ${JSON.stringify(after)} (SPEC §11 FX3)`);
  else run.warnings.push('names: the log does not scroll far enough to hide a chip inside the viewport; the scrolled-out popover check did not run');
  // a chip pinned with the keyboard (Space) closes when Tab moves the focus on
  await P.page.keyboard.press('Escape');
  await P.page.$eval(chip, (e) => e.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await P.page.focus(chip);
  await P.page.keyboard.press('Space');
  await sleep(200);
  const kb = await popInfo();
  check(!!kb && kb.pinned && kb.title === 'Spy', `names: Space on the focused Spy chip showed ${JSON.stringify(kb)}; expected it pinned`);
  await P.page.keyboard.press('Tab');
  await sleep(250);
  const tabbed = await popInfo();
  const focused = await P.page.evaluate(() => (document.activeElement ? document.activeElement.getAttribute('data-title') : null));
  check(!tabbed || (!tabbed.pinned && tabbed.title === focused), `names: after Tab the popover is ${JSON.stringify(tabbed)} (focus on ${JSON.stringify(focused)}); the one pinned with Space must close (SPEC §11 FX3)`);
  run.stats.names = { cause: r.cause, airlockLines: (r.airlockLines || []).length, logChips: r.logChips, scrolledOut: out ? !after : 'n/a', tabbed: tabbed ? tabbed.title : null };
  log(`hostile names: ${JSON.stringify(run.stats.names)}`);
  await shot('hostile-names', [P]);
}

// SPEC §11 (client-fixer f2), on mock screens (rendered without a server):
//  - vote-16 at 1280×720: a table cell's popover closes when the mouse moves on to a cell whose text fits (it stayed
//    open over that cell), only cut-off cells are Tab stops, and every popover open during a Tab walk is the focused
//    element's own;
//  - airlock-long-name at 360: "Play Airlock: {20 emoji} is out" and the alert's Join stay on screen (they wrap);
//  - airlock-two-joins: the picker lists the two join targets in the order their airlocks opened, and says "one of them";
//  - airlock-spent: every Airlock is played, so nothing says "one more Airlock … and you are out";
//  - track-history: played rounds show what their vote did (cancelled ones struck through), not the plan;
//  - lobby-spectator at 360 and lobby-min: the bar states the estimate for the minimum table.
async function mockChecks() {
  const out = {};
  const open = async (P, id) => {
    await P.page.goto(`${run.baseUrl}/?mock=${id}`, { waitUntil: 'domcontentloaded' });
    await P.page.waitForSelector('#app > div', { timeout: 8000 }).catch(() => null);
    await sleep(450);
  };
  const D = await newPage(await run.browser.createBrowserContext(), 'mock-desk', { width: 1280, height: 720, deviceScaleFactor: 1 });
  const M = await newPage(await run.browser.createBrowserContext(), 'mock-phone', { width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const popTitle = (P) => P.page.evaluate(() => { const e = document.getElementById('card-pop'); return e ? e.getAttribute('data-title') : null; });
  // a) the mouse: clamped cell A (its popover opens), then a revealed cell B in the same row whose text fits
  await open(D, 'vote-16');
  const pairs = await D.page.evaluate(() => {
    const cut = (c) => { const v = c.querySelector('.cval') || c; return v.scrollHeight > v.clientHeight + 1 || v.scrollWidth > v.clientWidth + 1; };
    const res = [];
    for (const row of document.querySelectorAll('.prow')) {
      const cells = [...row.querySelectorAll('.card.up[data-pop="clamp"]')];
      for (let i = 0; i + 1 < cells.length; i++) {
        if (!cut(cells[i]) || cut(cells[i + 1])) continue;
        const a = cells[i].getBoundingClientRect();
        const b = cells[i + 1].getBoundingClientRect();
        if (a.top > 120 && b.bottom < innerHeight - 160) res.push({ a: [a.left + a.width / 2, a.top + a.height / 2], b: [b.left + b.width / 2, b.top + b.height / 2], aT: cells[i].getAttribute('data-pop-title') });
      }
    }
    return res.slice(0, 3);
  });
  let stale = 0;
  for (const p of pairs) {
    await D.page.mouse.move(p.a[0], p.a[1], { steps: 3 });
    await sleep(350);
    const onA = await popTitle(D);
    await D.page.mouse.move(p.b[0], p.b[1], { steps: 4 });
    await sleep(450);
    const after = await popTitle(D);
    if (onA !== p.aT || after) stale++;
    await D.page.mouse.move(3, 3);
    await sleep(250);
  }
  check(pairs.length > 0, 'mock vote-16: no clamped cell next to one that fits (the hover check did not run)');
  check(stale === 0, `mock vote-16: ${stale} of ${pairs.length} cell popovers did not open on their cell or stayed open after the mouse moved on to a cell whose text fits (SPEC §11 X3/FC2, f2)`);
  // b) the keyboard: Tab stops among the cells are exactly the cut-off ones; a popover open at a stop is that stop's own
  const stops = await D.page.evaluate(() => {
    const cut = (c) => { const v = c.querySelector('.cval') || c; return v.scrollHeight > v.clientHeight + 1 || v.scrollWidth > v.clientWidth + 1; };
    const cells = [...document.querySelectorAll('.board.matrix .card.up[data-pop="clamp"]')];
    return { cells: cells.length, stops: cells.filter((c) => c.getAttribute('tabindex') === '0').length, stopsNotCut: cells.filter((c) => c.getAttribute('tabindex') === '0' && !cut(c)).length, cutNotStop: cells.filter((c) => cut(c) && c.getAttribute('tabindex') !== '0').length };
  });
  check(stops.stops > 0 && stops.stopsNotCut === 0 && stops.cutNotStop === 0, `mock vote-16: table cells as Tab stops ${JSON.stringify(stops)}; only (and every) cut-off cell must be one (SPEC §11 FC2, f2)`);
  await D.page.mouse.click(2, 200);
  let foreign = 0;
  let walked = 0;
  for (let i = 0; i < 70; i++) {
    await D.page.keyboard.press('Tab');
    await sleep(70);
    const f = await D.page.evaluate(() => {
      const e = document.activeElement;
      const p = document.getElementById('card-pop');
      const a = document.querySelector('[aria-describedby="card-pop"]');
      return { stop: !!e && e !== document.body, pop: !!p, own: !!a && a === e };
    });
    if (f.stop) walked++;
    if (f.pop && !f.own) foreign++;
  }
  check(foreign === 0, `mock vote-16: at ${foreign} of ${walked} Tab stops a popover of another element stayed open (SPEC §11 X3/FC2, f2)`);
  out.table = { hoverPairs: pairs.length, stale, ...stops, tabs: walked, foreign };
  // c) long names on a phone: the Airlock's Confirm, then (after Esc) the alert's Join
  await open(M, 'airlock-long-name');
  const fit = async (q) => M.page.evaluate((qq) => { const e = document.querySelector(qq); if (!e) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), vw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth }; }, q);
  const conf = await fit(sel('special-confirm-btn'));
  await M.page.keyboard.press('Escape');
  await sleep(650);
  await M.page.$eval(sel('airlock-join'), (e) => e.scrollIntoView({ block: 'center' })).catch(() => null);
  const join = await fit(sel('airlock-join'));
  for (const [what, r] of [['Confirm', conf], ['Join', join]]) {
    check(!!r && r.l >= 0 && r.r <= r.vw && r.sw <= r.vw, `mock airlock-long-name at 360: the ${what} button spans ${JSON.stringify(r)}; it must wrap inside the screen (f2)`);
  }
  out.longName = { confirm: conf, join };
  // d) two join targets: in the order their airlocks opened, and "one of them"
  await open(D, 'airlock-two-joins');
  const tj = await D.page.evaluate(() => ({
    first: [...document.querySelectorAll('[data-testid="target-option"]')].slice(0, 3).map((e) => [e.getAttribute('data-player-id'), e.getAttribute('data-airlock')]),
    callout: (document.querySelector('.airlock-callout') || { textContent: '' }).textContent,
    order: (window.__bunkerState.airlocks || []).map((a) => a.targetId),
  }));
  check(JSON.stringify(tj.first.slice(0, 2)) === JSON.stringify(tj.order.map((id) => [id, 'join'])) && tj.first[2] && !tj.first[2][1],
    `mock airlock-two-joins: the first target options are ${JSON.stringify(tj.first)}; expected the join targets in opening order ${JSON.stringify(tj.order)} (f2)`);
  check(/one of them/.test(tj.callout) && !/pick them/.test(tj.callout), `mock airlock-two-joins: the picker's callout reads ${JSON.stringify(tj.callout)} (f2)`);
  out.twoJoins = tj;
  // e) every Airlock played: no threat anywhere
  await open(D, 'airlock-spent');
  const sp = await D.page.evaluate(() => ({ spent: !!document.querySelector('#sec-airlock[data-spent="true"]'), text: [...document.querySelectorAll('#sec-airlock, .bar-airlock, .airlock-strip')].map((e) => e.innerText).join(' | ').replace(/\s+/g, ' ') }));
  check(sp.spent && !/one more Airlock|you are out|thrown out/i.test(sp.text) && /jams/.test(sp.text), `mock airlock-spent: ${JSON.stringify(sp)}; with every Airlock played an open airlock can only jam (f2)`);
  out.spent = sp.spent;
  // f) the round track's played votes
  await open(D, 'track-history');
  const tr = await D.page.$$eval('.hdr-track li', (els) => els.map((e) => `${e.querySelector('.rt-n').textContent}${e.classList.contains('rt-cancel') ? '~' : ''}${e.querySelector('.rt-k').textContent}`));
  check(JSON.stringify(tr) === JSON.stringify(['1·', '2·', '3·', '4·', '5~✖1', '6✖1', '7~✖2', 'OT✖2']), `mock track-history: the round track reads ${JSON.stringify(tr)}; expected round 5 and 7 struck through (cancelled) and round 6 with its one ejection (f2)`);
  out.track = tr;
  // g) the estimate in every lobby bar, also below the minimum
  for (const [P, id] of [[M, 'lobby-spectator'], [D, 'lobby-min']]) {
    await open(P, id);
    const bar = await P.page.$eval(sel('action-bar'), (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '');
    const est = await P.page.$eval(sel('time-estimate'), (e) => e.getAttribute('data-minutes')).catch(() => null);
    check(!!est && bar.includes(`about ${est} min`) && bar.includes('(the minimum)'), `mock ${id}: the bar reads ${JSON.stringify(bar)}; it must state the estimate (≈ ${est} min) for the minimum table (SPEC §11 X4, f2)`);
    out[id] = bar.includes(`about ${est} min`);
  }
  await shot('mock-f2', [D, M]);
  await D.page.close().catch(() => {});
  await M.page.close().catch(() => {});
  run.pages = run.pages.filter((x) => x !== D && x !== M);
  run.stats.mockF2 = out;
  log(`mock checks (f2): ${JSON.stringify(out)}`);
}

async function periodicChecks(host, bob, spec) {
  const ss = await state(spec);
  if (ss && ss.phase !== 'lobby' && ss.phase !== 'final') {
    const enabled = await spec.page.$$eval('[data-testid="reveal-btn"],[data-testid="vote-btn"],[data-testid="end-turn-btn"],[data-testid="next-btn"],[data-testid="close-vote-btn"],[data-testid="special-btn"],[data-testid="kick-btn"],[data-testid="transfer-btn"]',
      (els) => els.filter((e) => !e.disabled && window.__e2eVisible(e)).map((e) => e.getAttribute('data-testid'))).catch(() => []);
    check(enabled.length === 0, `spectator has enabled action hooks: ${JSON.stringify(enabled)}`);
    check(ss.me === null, 'spectator state has me !== null');
    await checkBoard(spec, ss, 'game');
  }
  const hs = await state(host);
  if (hs && hs.phase !== 'lobby' && hs.phase !== 'final') {
    await checkBoard(host, hs, 'game');
    if (!hs.you.isHost) return;
    let nextOk = await hookValues(host, 'next-btn', 'data-testid');
    // A client may hold Next disabled for a moment after a click or a turn change (a double-send guard, SPEC §11 F1):
    // watch the page for up to 1.5 s (in the page itself, so no enabled moment is missed between two reads). With fast
    // bots whose turns end every 0.2–0.5 s the guard restarts with every turn, so Next may legitimately stay disabled
    // the whole time: that is accepted only if the turn/ballot changed at least twice meanwhile. With at most one change
    // there is always a stable stretch longer than the guard, and Next must be enabled in it.
    let busy = null;
    let movedOn = false;
    if (!nextOk.length) {
      busy = await host.page.evaluate((ms) => new Promise((res) => {
        const t0 = Date.now();
        let changes = 0;
        let last = null;
        const key = () => { const x = window.__bunkerState; return x ? [x.phase, x.round, x.overtime, x.turn && x.turn.index, x.vote && x.vote.ballot, x.vote && x.vote.stage].join('|') : ''; };
        const tick = () => {
          const b = document.querySelector('[data-testid="next-btn"]');
          if (b && !b.disabled && window.__e2eVisible(b)) { res({ enabled: true, changes }); return; }
          const k = key();
          if (last !== null && k !== last) changes++;
          last = k;
          if (Date.now() - t0 > ms) { res({ enabled: false, changes }); return; }
          setTimeout(tick, 15);
        };
        tick();
      }), 1500).catch(() => null);
      if (busy && busy.enabled) { nextOk = ['next-btn']; run.stats.hookRereads++; }
      else if (busy && busy.changes >= 2) { nextOk = ['next-btn (F1 guard: the turn changed ' + busy.changes + ' times)']; run.stats.nextGuardBusy = (run.stats.nextGuardBusy || 0) + 1; }
      const h2 = await state(host);
      movedOn = !h2 || !h2.you.isHost || h2.phase === 'lobby' || h2.phase === 'final'; // the game moved on meanwhile
    }
    let diag = '';
    if (!nextOk.length && hs.phase !== 'vote' && !movedOn) {
      diag = await host.page.evaluate(() => {
        const b = document.querySelector('[data-testid="next-btn"]');
        const s = window.__bunkerState;
        const c = window.__bunkerDebug && typeof window.__bunkerDebug.conn === 'function' ? window.__bunkerDebug.conn() : null;
        return JSON.stringify({ btn: b ? { disabled: b.disabled, cls: b.className, visible: window.__e2eVisible(b) } : null, conn: c,
          step: s && [s.phase, s.round, s.turn && s.turn.index, s.you && s.you.isHost] });
      }).catch((e) => String(e));
      diag += ` watch=${JSON.stringify(busy)}`;
    }
    check(nextOk.length >= 1 || hs.phase === 'vote' || movedOn, `host: no enabled, visible next-btn in ${hs.phase}${diag ? ` (${diag})` : ''}`);
  }
  const bs = await state(bob);
  if (bs && bs.phase !== 'lobby' && bs.phase !== 'final') {
    const nb = await hookValues(bob, 'next-btn', 'data-testid');
    check(nb.length === 0, 'bob (not host) has an enabled next-btn');
  }
  for (const P of run.pages) await collectToasts(P);
  for (const P of [host, bob]) await checkSentSteps(P);
  await checkAirlockBadges(host);
}

// SPEC §11 X1.7: an airlock-badge (data-player-id) is shown exactly for the alive targets of the open airlocks.
async function checkAirlockBadges(P) {
  let last = null;
  for (let i = 0; i < 15; i++) {
    const s = await state(P);
    if (!s || !Array.isArray(s.airlocks)) return;   // a server without SPEC §11 X1
    const want = s.phase === 'lobby' || s.phase === 'final' ? [] : s.airlocks.filter((a) => { const t = playerById(s, a.targetId); return t && t.status === 'alive'; }).map((a) => a.targetId);
    const shown = await P.page.$$eval(sel('airlock-badge'), (els) => els.map((e) => e.getAttribute('data-player-id'))).catch(() => []);
    last = { want, shown };
    if (sameSet([...new Set(shown)], want) && shown.length === want.length) { run.stats.airlockBadgeChecks++; return; }
    await sleep(100);
  }
  check(false, `${P.name}: airlock-badge ids ${JSON.stringify(last.shown)} != open airlocks' alive targets ${JSON.stringify(last.want)}`);
}

async function checkBoard(P, s, where) {
  if (!s) return;
  const phaseEl = await P.page.$(sel('phase'));
  const dataPhase = phaseEl ? await phaseEl.evaluate((e) => e.getAttribute('data-phase')) : null;
  // the DOM may lag the state by one render: re-read once before complaining
  if (dataPhase !== s.phase) {
    await sleep(150);
    const s2 = await state(P);
    const el2 = await P.page.$(sel('phase'));
    const dp2 = el2 ? await el2.evaluate((e) => e.getAttribute('data-phase')) : null;
    check(dp2 === (s2 && s2.phase), `${P.name} ${where}: [data-testid=phase] data-phase=${dp2}, state.phase=${s2 && s2.phase}`);
    s = s2 || s;
  }
  const cards = await P.page.$$eval(sel('player-card'), (els) => els.map((e) => ({ id: e.getAttribute('data-player-id'), status: e.getAttribute('data-status') }))).catch(() => []);
  const ids = s.players.map((p) => p.id);
  const okIds = sameSet(cards.map((c) => c.id), ids);
  const badStatus = cards.filter((c) => { const p = playerById(s, c.id); return p && p.status !== c.status; });
  if (!okIds || badStatus.length) {
    await sleep(150);
    const s2 = await state(P);
    const cards2 = await P.page.$$eval(sel('player-card'), (els) => els.map((e) => ({ id: e.getAttribute('data-player-id'), status: e.getAttribute('data-status') }))).catch(() => []);
    check(s2 && sameSet(cards2.map((c) => c.id), s2.players.map((p) => p.id)), `${P.name} ${where}: player-card ids ${JSON.stringify(cards2.map((c) => c.id))} != players`);
    const bad2 = s2 ? cards2.filter((c) => { const p = playerById(s2, c.id); return p && p.status !== c.status; }) : [];
    check(!bad2.length, `${P.name} ${where}: player-card data-status mismatch ${JSON.stringify(bad2)}`);
  }
  if (where === 'game') {
    for (const id of ['round', 'timer', 'log']) {
      let el = await P.page.$(sel(id));
      let timed = !!s.timer;
      // the state read above may be a step old (a discussion with its timer that just became a vote without one):
      // re-read both once before complaining
      if (!el && id === 'timer') { await sleep(150); const s2 = await state(P); timed = !!(s2 && s2.timer && GAME_PHASES_E2E.includes(s2.phase)); el = await P.page.$(sel(id)); }
      check(!!el || (id === 'timer' && !timed), `${P.name} game screen: missing [data-testid=${id}]`);
    }
  }
}

// SPEC §11 V2 / §10 (f2): a resume answered with server_busy (a network over its budget of wrong room codes) is not the
// end of the seat: the client drops that socket, shows the banner and retries with backoff until it is back. The page's
// WebSocket shim answers the first resume after the drop with a fake server_busy, as such a server would.
async function busyResumeTest(host, P) {
  const before = await state(P);
  log(`${P.name}: the connection drops and the first resume is refused with server_busy (round ${before.round}, ${before.phase})`);
  await P.page.evaluate(() => { window.__e2eFakeBusy = 1; window.__e2eResumes = 0; window.__bunkerDebug.drop(); });
  const t0 = Date.now();
  let seen = { banner: false, busy: false };
  let last = null;
  while (Date.now() - t0 < 15000) {
    last = await P.page.evaluate(() => {
      const b = document.querySelector('[data-testid="conn-banner"]');
      return { banner: !!b, busy: !!b && b.getAttribute('data-why') === 'busy', resumes: window.__e2eResumes, fake: window.__e2eFakeBusy, conn: window.__bunkerDebug.conn() };
    }).catch(() => null);
    if (last) { seen = { banner: seen.banner || last.banner, busy: seen.busy || last.busy }; }
    if (last && last.fake === 0 && last.conn.joined && last.resumes >= 2) break;
    await sleep(100);
  }
  const ms = Date.now() - t0;
  const back = await waitState(host, (s) => { const p = playerById(s, P.id); return !!p && p.connected; }, `${P.name} to be online again after the refused resume`, 8000).catch(() => null);
  check(!!last && last.conn.joined && last.resumes >= 2 && seen.busy && !!back,
    `${P.name}: after a resume refused with server_busy: ${JSON.stringify({ last, seen, hostSeesOnline: !!back, ms })}; the client must show the busy banner and retry until it is back (SPEC §11 V2, f2)`);
  run.stats.busyResume = { ms, resumes: last && last.resumes, banner: seen.busy };
  log(`busy resume: ${JSON.stringify(run.stats.busyResume)}`);
}

// f2: records, in the page, when the vote phase is first seen and when a vote-btn is first enabled after that.
async function watchVoteHold(P) {
  await P.page.evaluate(() => {
    window.__e2eHold = { t0: 0, t1: 0 };
    const iv = setInterval(() => {
      const w = window.__e2eHold;
      const s = window.__bunkerState;
      if (!w.t0 && s && s.phase === 'vote') w.t0 = performance.now();
      if (w.t0 && !w.t1 && [...document.querySelectorAll('[data-testid="vote-btn"]')].some((b) => !b.disabled)) w.t1 = performance.now();
      if (w.t1 || (w.t0 && performance.now() - w.t0 > 4000)) clearInterval(iv);
    }, 10);
  });
}
async function checkVoteHold(P) {
  await sleep(1600);
  const s = await state(P);
  const w = await P.page.evaluate(() => window.__e2eHold).catch(() => null);
  if (!s || s.phase !== 'vote' || !s.vote || !s.vote.voters.includes(s.you.id) || !w || !w.t0) return;   // not a voter here
  const hold = w.t1 ? Math.round(w.t1 - w.t0) : null;
  check(hold === null || hold >= 850, `${P.name}: the vote choices were enabled ${hold} ms after the host's own Next opened the vote; they must be held for about a second (SPEC §11, f2)`);
  run.stats.voteHold = { ms: hold };
  log(`vote hold after the host's Next: ${hold} ms`);
}

// The opt-in catastrophe narrator (public/narrator.js, reports/narrator-port.md). Not part of SPEC §10: a client
// without it (--public-dir / --url) only gets a warning; the repo's own ./public must have it.
const narrAudio = (P) => P.page.evaluate(() => {
  const a = document.querySelector('audio[data-testid="narrator-audio"]');
  return a ? { src: a.getAttribute('src'), paused: a.paused, t: a.currentTime, count: document.querySelectorAll('audio').length } : null;
}).catch(() => null);
async function narratorLobby(P) {
  const t0 = Date.now();
  const btn = await P.page.waitForSelector(sel('narrator-menu'), { visible: true, timeout: 3000 }).catch(() => null);
  if (!btn) {
    const msg = `${P.name}: no narrator control (narrator-menu) in the lobby header`;
    if (!opts.url && !opts.publicDir) check(false, msg); else run.warnings.push(`${msg}; narrator check skipped`);
    run.stats.narrator = { skipped: msg };
    return;
  }
  check(/\(off\)/.test(await btn.evaluate((e) => e.getAttribute('aria-label') || '')), `${P.name}: the narrator should be off by default`);
  await click(P, 'narrator-menu');
  await click(P, 'narrator-toggle');
  const on = await P.page.waitForFunction((q) => document.querySelector(q)?.getAttribute('aria-checked') === 'true', { timeout: 3000 }, sel('narrator-toggle')).then(() => true, () => false);
  check(on, `${P.name}: the narrator switch did not turn on`);
  const saved = await P.page.evaluate(() => { try { return JSON.parse(localStorage.getItem('bunker.narrator')); } catch { return null; } });
  check(!!saved && saved.on === true, `${P.name}: the narrator setting was not saved (bunker.narrator = ${JSON.stringify(saved)})`);
  await P.page.keyboard.press('Escape');
  const closed = await P.page.waitForFunction((q) => !document.querySelector(q), { timeout: 3000 }, sel('narrator-toggle')).then(() => true, () => false);
  check(closed, `${P.name}: Esc did not close the narrator popover`);
  const a = await narrAudio(P);
  check(!!a && a.count === 1 && !a.src, `${P.name}: in the lobby the narrator's one <audio> must have no clip yet (${JSON.stringify(a)})`);
  run.stats.narrator = { on: P.name, ms: Date.now() - t0 };
}
async function narratorStart(P, others) {
  if (!run.stats.narrator || run.stats.narrator.skipped) return;
  const t0 = Date.now();
  const s = await state(P);
  const title = s && s.catastrophe ? s.catastrophe.title : '';
  const clips = await P.page.evaluate(() => fetch('audio/narration.json').then((r) => r.json())).catch(() => []);
  // (the clip of the catastrophe's content id, audio/catastrophes/<id>.mp3, SPEC §11 X5.2; a server without ids: the title)
  const cid = s && s.catastrophe && typeof s.catastrophe.id === 'string' ? s.catastrophe.id : null;
  const clip = (Array.isArray(clips) ? clips : []).find((x) => x && typeof x.title === 'string' && typeof x.src === 'string'
    && (cid ? x.src.endsWith(`/${cid}.mp3`) : x.title.toLowerCase() === title.toLowerCase()));
  if (!check(!!clip, `no clip in audio/narration.json for the dealt catastrophe "${title}"`)) return;
  let a0 = await narrAudio(P);
  for (let i = 0; i < 50 && !(a0 && a0.src && !a0.paused && a0.t > 0.05); i++) { await sleep(100); a0 = await narrAudio(P); }
  await sleep(600);
  const a1 = await narrAudio(P);
  const playing = !!a0 && !!a1 && !!a1.src && a1.src.endsWith('/' + clip.src) && !a1.paused && a1.t > a0.t + 0.25;
  check(playing, `${P.name}: narrator on, the game started, but ${clip.src} is not playing by itself (${JSON.stringify({ a0, a1 })})`);
  const listen = {};
  for (const Q of [P, ...others]) {
    listen[Q.name] = await hookValues(Q, 'narrator-play', 'data-where');
    check(listen[Q.name].length >= 1, `${Q.name}: no ▶ Listen (narrator-play) next to the catastrophe title at the start`);
  }
  const states = await P.page.$$eval(sel('narrator-play'), (els) => els.filter((e) => window.__e2eVisible(e)).map((e) => e.getAttribute('data-state')));
  check(states.length >= 1 && states.every((x) => x === 'playing' || x === 'loading'), `${P.name}: ▶ Listen should show Stop while the clip plays (${JSON.stringify(states)})`);
  for (const Q of others) {
    const q = await narrAudio(Q);
    check(!!q && q.paused && !q.src, `${Q.name}: the narrator is off there, but the page has a clip (${JSON.stringify(q)})`);
  }
  run.stats.narrator = { on: P.name, clip: clip.src, t: a0 && a1 ? [+a0.t.toFixed(2), +a1.t.toFixed(2)] : null, listen, ms: run.stats.narrator.ms + Date.now() - t0 };
  log(`narrator: ${JSON.stringify(run.stats.narrator)}`);
}
async function reloadTest(P) {
  const before = await state(P);
  log(`reloading ${P.name}'s page mid-game (round ${before.round}, ${before.phase})`);
  await checkSentSteps(P);
  await shot('before-reload', [P]);
  const t0 = Date.now();
  await P.page.reload({ waitUntil: 'domcontentloaded' });
  const after = await waitState(P, (s) => s.you && s.you.id === before.you.id && s.phase !== 'lobby', `${P.name} to resume after the reload`);
  const ms = Date.now() - t0;
  const landingVisible = (await hookValues(P, 'name-input', 'data-testid', false)).length > 0;
  check(!landingVisible, `${P.name}: the landing form is still visible after resuming`);
  if (before.me && after.me) {
    for (const [k, c] of Object.entries(before.me.cards)) {
      if (!c.revealed && !after.me.cards[k].revealed) check(after.me.cards[k].text === c.text, `${P.name}: hidden ${k} changed across the reload`);
    }
  }
  run.stats.reload = { ms, round: after.round, phase: after.phase };
  log(`${P.name} resumed as ${after.you.id} after ${ms} ms`);
  // SPEC §11 X5.7: a page switched to Russian is still Russian after a reload (the choice is stored, and the resume
  // carries it)
  if (P.name === 'bob' && run.bobRu && !run.bobRu.back) {
    const l = await langShown(P);
    check(!!l && l.html === 'ru' && l.sw === 'ru' && after.you.lang === 'ru', `bob: after the reload his page is not Russian any more (${JSON.stringify(l)}, you.lang ${after.you.lang})`);
    // the resume itself carried the language (no setLang was needed to put the server right)
    const w = await P.page.evaluate(() => ({ hellos: window.__e2eHellos || [], setLang: window.__e2eSetLang || 0 })).catch(() => null);
    check(!!w && w.hellos.length >= 1 && w.hellos.every((x) => x.lang === 'ru') && w.setLang === 0, `bob: after the reload the hellos were ${JSON.stringify(w)}; the resume must carry lang "ru" (SPEC §11 X5.1)`);
    run.bobRu.reload = l && l.html;
  }
  await sleep(PAUSE);
  if (run.stats.narrator && run.stats.narrator.on === P.name) {
    // the narrator reads a game out only when the page saw it start: a reload mid-game must not replay it
    const a = await narrAudio(P);
    check(!!a && a.paused && !a.src, `${P.name}: the narrator replayed the catastrophe after a reload mid-game (${JSON.stringify(a)})`);
    run.stats.narrator.afterReload = a && !a.src ? 'silent' : 'played';
  }
  await shot('after-reload', [P]);
}

async function failShots(reason) {
  try {
    fs.mkdirSync(opts.screens, { recursive: true });
    const dumps = {};
    for (const P of run.pages) {
      await P.page.screenshot({ path: path.join(opts.screens, `FAIL-${P.name}-${P.vpName}.png`), fullPage: true }).catch(() => {});
      dumps[P.name] = await state(P);
    }
    fs.writeFileSync(path.join(opts.screens, 'e2e-failure-states.json'), JSON.stringify({ reason, states: dumps, bots: run.bots.map((b) => ({ name: b.name, id: b.id, state: describeState(b.state), errors: b.errors.slice(-5) })) }, null, 2));
  } catch { /* best effort */ }
}

async function cleanup() {
  for (const b of run.bots) b.close();
  if (run.browser) await run.browser.close().catch(() => {});
  if (run.server && !run.server.exited) {
    run.server.child.kill('SIGTERM');
    await new Promise((r) => { const t = setTimeout(r, 2000); run.server.child.once('exit', () => { clearTimeout(t); r(); }); });
    if (!run.server.exited) run.server.child.kill('SIGKILL');
  }
}

function summary(ok, err) {
  const s = {
    ok, error: err ? String(err.message || err) : null, url: run.baseUrl, publicDir: opts.publicDir || null, players: opts.players,
    seconds: Math.round((Date.now() - T0) / 100) / 10, screenshots: run.shots, stats: { ...run.stats, errorToasts: run.stats.errorToasts.map(({ key, ...x }) => x) },
    failures: run.failures, consoleErrors: run.consoleErrors, warnings: run.warnings,
    botErrors: run.bots.flatMap((b) => b.errors.filter((e) => !e.race && !e.expected).map((e) => ({ bot: b.name, code: e.code, message: e.message, msg: e.msg }))),
    serverStderr: run.server ? run.server.err.split('\n').filter((l) => /error|uncaught|^\s+at /i.test(l)).slice(0, 20) : null,
  };
  try { fs.writeFileSync(path.join(opts.screens, 'e2e-summary.json'), JSON.stringify(s, null, 2)); } catch { /* ignore */ }
  return s;
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { log(`interrupted (${sig})`); await cleanup(); process.exit(130); });
process.on('exit', () => { if (run.server && !run.server.exited) { try { run.server.child.kill('SIGKILL'); } catch { /* ignore */ } } });

main().then(async () => {
  for (const P of run.pages) await collectToasts(P).catch(() => {});
  const s = summary(true, null);
  const problems = [...run.failures, ...run.consoleErrors.map((c) => `console error on ${c.page}: ${c.text} ${c.url || ''}`),
    ...(s.serverStderr && s.serverStderr.length ? [`server stderr: ${s.serverStderr.join(' | ')}`] : []),
    ...s.botErrors.map((e) => `bot ${e.bot} got ${e.code} for ${JSON.stringify(e.msg)}`)];
  await cleanup();
  log(`stats: ${JSON.stringify(s.stats)}`);
  for (const w of run.warnings) log(`WARN ${w}`);
  if (problems.length) {
    for (const p of problems) log(`FAIL ${p}`);
    log(`E2E FAILED: ${problems.length} problem(s); screenshots in ${opts.screens}`);
    process.exit(1);
  }
  log(`E2E PASSED in ${s.seconds} s; ${run.shots} screenshot sets in ${opts.screens}`);
  process.exit(0);
}).catch(async (err) => {
  log(`E2E FAILED: ${err instanceof StuckError ? 'STUCK: ' : ''}${err.message}`);
  if (!(err instanceof StuckError) && err.stack) console.error(err.stack);
  await failShots(err.message);
  summary(false, err);
  for (const f of run.failures) log(`FAIL ${f}`);
  for (const c of run.consoleErrors) log(`console error on ${c.page}: ${c.text}`);
  await cleanup();
  log(`failure screenshots and state dumps are in ${opts.screens}`);
  process.exit(1);
});
