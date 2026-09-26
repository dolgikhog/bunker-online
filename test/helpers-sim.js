// Shared helpers for the protocol simulations (test/sim*.test.js):
//   startServer()  spawns `node server/index.js` on a free port and watches it (exit, stderr);
//   Checker        records every message every client receives and checks the SPEC invariants on it;
//   runTable()     plays full games with bots (tools/botlib.js), a spectator "watcher" as the reference stream,
//                  optional scenario hooks, stall detection and a quiescence check at the end.
// Side-effect free on import (bare `node --test` would load this file as a test file).
//
// §11 X5 (languages; report §11.2). Each recipient's view is in its own language (`you.lang`), so:
//   - log lines are checked by `key` and `params` (the airlock lines X1/Y1, ejections, End game and Play again E1); the
//     English text is still compared for English recipients;
//   - every log entry is validated once per client (the §7 schema, parts included) and must never change afterwards;
//     the same entry id must look the same to every recipient of one language (or, `neutral`, the same key and params
//     to everybody);
//   - `neutral: true` (a table with several languages): the public fingerprints drop every rendered string (labels,
//     titles, texts, details, names of bunker and catastrophe, card texts become '*', nullness kept; log entries are
//     compared by key and params), so recipients in different languages compare equal; a card is compared with its
//     owner's hand only within one language;
//   - the leak scan pairs by language: a hidden card seen in its owner's hand in language L is searched in the log
//     (text, parts and params) of a reference stream in L. The main reference is one; `attach(bot, {leakRef: true})`
//     adds another (runTable adds a watcher per extra language).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_PHASES, AIRLOCK_SEALED_RE, BOT_NAMES, Bot, CATEGORY_IDS, Coordinator, EFFECT_RULES, ERROR_CODES, KICKS, describeState,
  kicksFormula, nextVoteRoundFormula, playerById,
} from '../tools/botlib.js';
import { AIRLOCK_CARD, REVIVE_CARD } from '../server/content.js';
import { validateServerMessage, PARTS_MIN } from './stateview-schema.js';

/** The §11 X5 language of a state ('en' for a server before X5). */
const langOf = (s) => (s && s.you && typeof s.you.lang === 'string' ? s.you.lang : 'en');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHASES = ['lobby', 'reveal', 'discussion', 'vote', 'defense', 'final'];
const LOG_KINDS = ['system', 'reveal', 'special', 'vote', 'eject', 'info'];
/** §11 X5.2 (copied from the SPEC text): a state is at most this many bytes of UTF-8 per recipient; the log keeps 200 lines. */
export const FRAME_BUDGET = 120 * 1024;
const LOG_LIMIT = 200;
/** More than any one log line takes without its parts (the longest, a 16-player tally or a special's line, is ~3 KB). */
const LINE_MAX_BYTES = 16 * 1024;

/** SPEC §11 X1 table (copied from the SPEC text, not from the engine): [Airlocks, revives] dealt to N players. */
export function x1Deal(n) {
  if (n < 4) return [0, 0];
  if (n <= 7) return [2, 1];
  if (n <= 11) return [3, 1];
  return [4, 2];
}
const sameCard = (c, card) => !!c && c.title === card.title && c.text === card.text;
/**
 * The fixed cards of §11 X1, by their content id (§11 X5.2); in an English view (or one without ids) their words must
 * be the catalogue's too.
 */
const isFixedCard = (c, card, lang) => !!c && (c.id === undefined ? sameCard(c, card) : c.id === card.id && (lang !== 'en' || sameCard(c, card)));
const isAirlockCard = (c, lang = 'en') => isFixedCard(c, AIRLOCK_CARD, lang);
const isReviveCard = (c, lang = 'en') => isFixedCard(c, REVIVE_CARD, lang);

// ---------------------------------------------------------------------------------------------------------------
// Server process

const liveServers = new Set();
let exitHookInstalled = false;

/**
 * Spawns the real server. Resolves { url, port, child, stdout(), stderr(), exited, stop(), problems() }.
 * PORT=0 (the server prints the real port), HOST=127.0.0.1, BUNKER_NO_LIMITS=1 unless noLimits:false.
 */
export async function startServer({ seed = 1, minPlayers = 2, noLimits = true, env = {}, timeoutMs = 10000, entry = path.join(ROOT, 'server', 'index.js') } = {}) {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => { for (const s of liveServers) { try { s.child.kill('SIGKILL'); } catch { /* ignore */ } } });
  }
  const childEnv = { ...process.env, PORT: '0', HOST: '127.0.0.1', BUNKER_SEED: String(seed), BUNKER_MIN_PLAYERS: String(minPlayers), ...env };
  if (noLimits) childEnv.BUNKER_NO_LIMITS = '1'; else delete childEnv.BUNKER_NO_LIMITS;
  // SPEC §11 X9: a server under test is in dev mode only when the test asks for it, never because the shell running
  // `npm test` happens to export BUNKER_DEV
  if (!Object.hasOwn(env, 'BUNKER_DEV')) delete childEnv.BUNKER_DEV;
  const child = spawn(process.execPath, [entry], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const server = {
    child, url: null, port: null, seed, exited: null,
    stdout: () => out,
    stderr: () => err,
    /** Lines of stderr that look like crashes or caught exceptions. */
    problems() {
      return err.split('\n').filter((l) => /uncaught|unhandled|TypeError|ReferenceError|RangeError|SyntaxError|Error:|^\s+at\s/i.test(l)
        && !/ExperimentalWarning|--trace-warnings/.test(l));
    },
    async stop() {
      if (server.exited) { liveServers.delete(server); return server.exited; }
      const done = new Promise((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
      await done;
      clearTimeout(t);
      liveServers.delete(server);
      return server.exited;
    },
  };
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('exit', (code, signal) => { server.exited = { code, signal, t: Date.now() }; liveServers.delete(server); });
  liveServers.add(server);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); child.kill('SIGKILL'); reject(new Error(`server did not print "listening on" within ${timeoutMs} ms\nstdout: ${out}\nstderr: ${err}`)); }, timeoutMs);
    const onData = () => {
      const m = /listening on (https?):\/\/([^\s:]+):(\d+)/.exec(out);
      if (m) { cleanup(); server.port = Number(m[3]); server.url = `http://127.0.0.1:${server.port}`; resolve(); }
    };
    const onExit = (code, signal) => { cleanup(); reject(new Error(`server exited early (code ${code}, signal ${signal})\nstdout: ${out}\nstderr: ${err}`)); };
    const cleanup = () => { clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit); };
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
  return server;
}

/** Throws unless the server is still running with a clean stderr and /healthz answers ok. */
export async function assertServerHealthy(server) {
  if (server.exited) throw new Error(`server process exited: ${JSON.stringify(server.exited)}\nstderr:\n${server.stderr()}`);
  const problems = server.problems();
  if (problems.length) throw new Error(`server stderr shows errors:\n${problems.slice(0, 20).join('\n')}`);
  const res = await fetch(`${server.url}/healthz`);
  const body = (await res.text()).trim();
  if (res.status !== 200 || body !== 'ok') throw new Error(`/healthz answered ${res.status} ${JSON.stringify(body)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Utilities

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function canon(v) {
  if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

/** Everything in a StateView except the recipient-specific fields. */
export function publicPart(s) {
  // eslint-disable-next-line no-unused-vars
  const { serverNow, you, me, ...pub } = s;
  return pub;
}

const STAR = (v) => (typeof v === 'string' ? '*' : v);
/**
 * §11 X5: the public part with every rendered string replaced by '*' (nullness kept), the same in every language:
 * category labels, the catastrophe's words, the bunker's, card texts, special titles and texts, the timer label.
 */
export function neutralPublic(pub) {
  const sp = (x) => (x && typeof x === 'object' ? { ...x, title: STAR(x.title), text: STAR(x.text) } : x);
  return {
    ...pub,
    categories: Array.isArray(pub.categories) ? pub.categories.map((c) => ({ ...c, label: STAR(c.label) })) : pub.categories,
    catastrophe: pub.catastrophe && typeof pub.catastrophe === 'object'
      ? { ...pub.catastrophe, title: STAR(pub.catastrophe.title), text: STAR(pub.catastrophe.text), details: (pub.catastrophe.details || []).map(STAR) }
      : pub.catastrophe,
    bunker: pub.bunker && typeof pub.bunker === 'object'
      ? { ...Object.fromEntries(Object.entries(pub.bunker).map(([k, v]) => [k, STAR(v)])), features: (pub.bunker.features || []).map(STAR) }
      : pub.bunker,
    players: Array.isArray(pub.players) ? pub.players.map((p) => ({
      ...p,
      cards: p.cards && typeof p.cards === 'object' ? Object.fromEntries(Object.entries(p.cards).map(([k, v]) => [k, STAR(v)])) : p.cards,
      playedSpecials: Array.isArray(p.playedSpecials) ? p.playedSpecials.map(sp) : p.playedSpecials,
      ...(p.unplayedSpecials !== undefined ? { unplayedSpecials: Array.isArray(p.unplayedSpecials) ? p.unplayedSpecials.map(sp) : p.unplayedSpecials } : {}),
    })) : pub.players,
    timer: pub.timer && typeof pub.timer === 'object' ? { ...pub.timer, label: STAR(pub.timer.label) } : pub.timer,
  };
}

/**
 * A log entry as compared across recipients: without its parts, and (neutral) without its rendered text either. The
 * parts are compared on their own (entryParts), because an old entry may reach a recipient without them (§11 X5.2, the
 * report's §14 fallback: a client that joins late sees the oldest lines of a long log without parts).
 */
function entryShape(e, neutral) {
  if (!e || typeof e !== 'object') return e;
  if (neutral) return { id: e.id, ts: e.ts, kind: e.kind, key: e.key, params: e.params };
  const { parts, ...rest } = e; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * The log of a state as [last id]: entries are checked one by one elsewhere, and the window (which of the log's lines a
 * frame carries) by Checker.checkWindow. Where the window starts may differ between recipients: §11 X5.2's frame guard
 * leaves the oldest lines off a frame that would pass FRAME_BUDGET, and heads differ in size (a player's hand, a
 * language's words).
 */
function logRange(log) {
  return Array.isArray(log) ? [log.length ? log[log.length - 1].id : 0] : log;
}

/**
 * The public part of a state as a JSON key: the log as its id range (every entry is compared once, by id), and,
 * `neutral`, every rendered string as '*' (§11 X5): equal keys mean equal public states for every recipient.
 */
export function publicKey(s, neutral = false) {
  const pub = publicPart(s);
  const shaped = neutral ? neutralPublic(pub) : pub;
  return JSON.stringify({ ...shaped, log: logRange(pub.log) });
}

function sha1(str) { return createHash('sha1').update(str).digest('hex').slice(0, 20); }

/** Up to `max` differing paths between two JSON values. */
export function diffPaths(a, b, max = 6, p = '', out = []) {
  if (out.length >= max) return out;
  if (a === b) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb || (ta !== 'object' && ta !== 'array')) {
    out.push(`${p || '<root>'}: ${short(a)} != ${short(b)}`);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) diffPaths(a[k], b[k], max, `${p}${ta === 'array' ? `[${k}]` : `.${k}`}`, out);
  return out;
}

function short(v) {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

const isStr = (v) => typeof v === 'string';
const isInt = (v) => Number.isInteger(v);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const seatOrder = (s, ids) => [...ids].sort((x, y) => playerById(s, x).seat - playerById(s, y).seat);

// ---------------------------------------------------------------------------------------------------------------
// Checker

export class Checker {
  /**
   * @param {object} o
   * @param {string} o.label
   * @param {boolean} [o.strictSpecialsFree]  no specials and no leaves: survivors and ejections must match KICKS exactly
   * @param {boolean} [o.checkDeal=true]  every final must show the §11 X1 fixed deal (off for hand-made test deals)
   * @param {boolean} [o.neutral=false]   §11 X5: recipients may be in different languages; public states are compared
   *                                      without their rendered strings, log entries by key and params
   */
  constructor({ label = 'room', strictSpecialsFree = false, checkDeal = true, neutral = false } = {}) {
    this.label = label;
    this.strictSpecialsFree = strictSpecialsFree;
    this.checkDeal = checkDeal;
    this.neutral = !!neutral;
    this.entryJson = new Map(); // `${lang or 'n'}:${id}` -> the entry as the first recipient saw it (JSON, no parts)
    this.entryParts = new Map(); // `${lang}:${id}` -> its parts as the first recipient that got them saw them (JSON)
    this.bareBytes = new Map(); // `${lang}:${id}` -> the entry's size on the wire without its parts (UTF-8 bytes of JSON)
    this.leakRefs = []; // clients whose streams the leak scan walks (the reference, plus one per extra language)
    this.langs = new Set(); // languages seen in states
    this.violations = [];
    this.warnings = [];
    this.clients = new Map(); // bot -> client record
    this.fpJson = new Map(); // fp -> public JSON (first seen)
    this.reference = null;
    this.refSeq = []; // [{ fp, t }] deduped, reference stream
    this.meByFp = new Map(); // playerId -> Map(fp -> { cards, notes })
    this.games = [];
    this.g = null;
    this.refPrev = null;
    this.tokens = new Set();
    this.messages = 0;
    this.schemaChecked = 0;
  }

  v(msg) {
    if (this.violations.length < 300) this.violations.push(`[${this.label}] ${msg}`);
  }

  w(msg) {
    if (this.warnings.length < 300) this.warnings.push(`[${this.label}] ${msg}`);
  }

  /**
   * Records everything `bot` receives. The reference is a spectator present for the whole run. `leakRef`: this
   * client's stream is scanned for leaks too (§11 X5: a spectator in another language than the reference).
   */
  attach(bot, { reference = false, leakRef = false } = {}) {
    const c = {
      bot, label: bot.name, segments: [], seg: null, lastLogId: 0, roundKey: null, roundStartPlayed: 0, kickedAt: null, prevPhase: null, gameNo: 0,
      logChecked: 0, logTexts: new Map(), leak: null,
    };
    this.clients.set(bot, c);
    if (reference) this.reference = c;
    if (reference || leakRef) {
      c.leak = { seq: [], log: new Map(), lang: null };
      this.leakRefs.push(c);
    }
    bot.on('message', (msg, meta) => {
      this.messages++;
      const t = performance.now();
      if (!msg || typeof msg !== 'object') { this.v(`${c.label}: non-object message`); return; }
      // every message, field by field against SPEC §7 (test/stateview-schema.js); a log entry in depth once per client
      // (checkLog makes sure it never changes afterwards)
      this.schemaChecked++;
      const problems = validateServerMessage(msg, { logFrom: c.logChecked });
      if (problems.length) {
        this.v(`${c.label}: §7 schema [${msg.t}${msg.phase ? ` ${msg.phase} r${msg.round}` : ''}]: ${problems.slice(0, 6).join('; ')}${problems.length > 6 ? ` (+${problems.length - 6} more)` : ''}`);
      }
      if (msg.t === 'joined') {
        if (!isStr(msg.room) || !isStr(msg.id) || !isStr(msg.token)) this.v(`${c.label}: bad joined ${short(msg)}`);
        if (isStr(msg.token)) {
          this.tokens.add(msg.token);
          if (msg.token.length < 16) this.v(`${c.label}: token too short (${msg.token.length} chars) for >= 128 bits`);
        }
        return;
      }
      if (msg.t === 'kicked') { c.kickedAt = t; return; }
      if (msg.t === 'error') {
        if (msg.code === 'replaced') c.replacedAt = t;
        if (!ERROR_CODES.includes(msg.code)) this.v(`${c.label}: error with unknown code ${short(msg)}`);
        if (!isStr(msg.message) || !msg.message) this.v(`${c.label}: error without a message ${short(msg)}`);
        return;
      }
      if (msg.t === 'pong') return;
      if (msg.t !== 'state') { this.v(`${c.label}: unknown message type ${short(msg)}`); return; }
      try {
        this.onState(c, msg, t, meta && typeof meta.bytes === 'number' ? meta.bytes : null);
      } catch (e) {
        this.v(`${c.label}: checker crashed on a state: ${e.stack}`);
      }
    });
  }

  onState(c, s, t, bytes = null) {
    const bot = c.bot;
    if (c.kickedAt !== null) this.v(`${c.label}: received a state after {t:'kicked'}`);
    if (c.replacedAt !== undefined) this.v(`${c.label}: received a state after error 'replaced'`);
    if ((c.prevPhase === null || c.prevPhase === 'lobby') && s.phase !== 'lobby') c.gameNo++;
    c.prevPhase = s.phase;
    // segment bookkeeping (one per socket)
    if (!c.seg || c.seg.gen !== bot.socketGen) {
      c.seg = { gen: bot.socketGen, seq: [] };
      c.segments.push(c.seg);
    }
    const json = publicKey(s, this.neutral);
    const fp = sha1(json);
    if (!this.fpJson.has(fp)) this.fpJson.set(fp, json);
    const last = c.seg.seq[c.seg.seq.length - 1];
    if (!last || last.fp !== fp) c.seg.seq.push({ fp, t });
    this.langs.add(langOf(s));
    if (c.leak) this.recordLeakStream(c, s, fp);

    this.checkShape(c, s);
    this.checkLog(c, s);
    this.checkWindow(c, s, bytes);
    this.checkRecipient(c, s, fp);
    if (c === this.reference) {
      const lastRef = this.refSeq[this.refSeq.length - 1];
      if (!lastRef || lastRef.fp !== fp) this.refSeq.push({ fp, t, phase: s.phase });
      this.onReference(s);
      if (this.g && s.phase !== 'lobby') this.g.refStates++;
    }
  }

  /** The reference stream a leak scan walks: its states (public part, the log as a range) and its log entries by id. */
  recordLeakStream(c, s, fp) {
    const L = c.leak;
    L.lang = langOf(s);
    for (const e of s.log) {
      if (L.log.has(e.id)) continue;
      L.log.set(e.id, { text: e.text, blob: JSON.stringify([e.params, e.parts]) });
    }
    const last = L.seq[L.seq.length - 1];
    if (!last || last.fp !== fp) L.seq.push({ fp, json: this.neutral ? publicKey(s, false) : null, lang: L.lang });
  }

  /**
   * §11 X5.3: the log entries of one state. An entry is compared with the first recipient's copy of it (in the same
   * language; `neutral`: its key and params only) the first time this client sees it, and must keep its text afterwards.
   */
  checkLog(c, s) {
    const L = c.label;
    const lang = langOf(s);
    let max = c.logChecked;
    for (const e of s.log) {
      if (!e || typeof e !== 'object' || !isInt(e.id)) continue;
      if (e.id <= c.logChecked) {
        const was = c.logTexts.get(e.id);
        if (was !== undefined && was !== e.text && langOf(s) === c.logLang) this.v(`${L}: log entry #${e.id} changed after it was sent: ${short(was)} -> ${short(e.text)}`);
        continue;
      }
      c.logTexts.set(e.id, e.text);
      const k = `${this.neutral ? 'n' : lang}:${e.id}`;
      const json = JSON.stringify(entryShape(e, this.neutral));
      const first = this.entryJson.get(k);
      if (first === undefined) this.entryJson.set(k, json);
      else if (first !== json) this.v(`(a) ${L}: log entry #${e.id} differs between recipients: ${short(JSON.parse(json))} vs ${short(JSON.parse(first))}`);
      if (!this.neutral && Array.isArray(e.parts)) {
        const pj = JSON.stringify(e.parts);
        const firstParts = this.entryParts.get(k);
        if (firstParts === undefined) this.entryParts.set(k, pj);
        else if (firstParts !== pj) this.v(`(a) ${L}: the parts of log entry #${e.id} differ between recipients: ${short(e.parts)} vs ${short(JSON.parse(firstParts))}`);
      }
      if (e.id > max) max = e.id;
    }
    // a language switch re-renders every entry: its texts are compared from here on in the new language
    if (c.logLang !== lang) {
      c.logLang = lang;
      for (const e of s.log) if (e && isInt(e.id)) c.logTexts.set(e.id, e.text);
    }
    c.logChecked = max;
    const first = s.log.length ? s.log[0].id : max + 1;
    if (c.logTexts.size > 400) for (const id of [...c.logTexts.keys()]) if (id < first) c.logTexts.delete(id);
  }

  /**
   * §11 X5.2, the frame guard (server/rooms.js): a state's log is the newest lines of the game's log, with contiguous
   * ids, and it is the whole window (the last 200 lines, or every line so far) unless the frame is at FRAME_BUDGET: then
   * the line just before the window would have passed the budget, even without its parts (exact when this Checker has
   * seen that line in this language; otherwise the frame must be within LINE_MAX_BYTES of the budget), and the frame is
   * within the budget unless only the newest PARTS_MIN lines are left. `bytes`: the frame's size on the wire.
   */
  checkWindow(c, s, bytes) {
    const log = Array.isArray(s.log) ? s.log : [];
    if (!log.length || !log.every((e) => e && isInt(e.id))) return; // (checkShape reports a malformed log)
    const bad = (m) => this.v(`${c.label} [${s.phase} r${s.round}]: ${m}`);
    const lang = langOf(s);
    // every line's size without its parts, once per language: the new lines are at the window's ends (what this
    // language has seen is a run of windows), so each end is walked only up to the first line already known
    const known = (e) => {
      const k = `${lang}:${e.id}`;
      if (this.bareBytes.has(k)) return true;
      this.bareBytes.set(k, Buffer.byteLength(JSON.stringify({ id: e.id, ts: e.ts, kind: e.kind, text: e.text, key: e.key, params: e.params })));
      return false;
    };
    for (let i = log.length - 1; i >= 0 && !known(log[i]); i--);
    for (let i = 0; i < log.length && !known(log[i]); i++);
    for (let i = 1; i < log.length; i++) {
      if (log[i].id !== log[i - 1].id + 1) { bad(`log ids jump from #${log[i - 1].id} to #${log[i].id} (a window has no gaps)`); return; }
    }
    const last = log[log.length - 1].id;
    const whole = Math.min(LOG_LIMIT, last);
    if (log.length >= whole) return;
    const tag = `the log is lines #${log[0].id}-#${last} (${log.length} of ${whole})`;
    if (!isInt(bytes)) { bad(`${tag}, and the frame's size is unknown`); return; }
    if (bytes > FRAME_BUDGET && log.length > PARTS_MIN) bad(`${tag}: the frame is ${bytes} bytes, over ${FRAME_BUDGET}, with more than ${PARTS_MIN} lines left`);
    const before = this.bareBytes.get(`${lang}:${log[0].id - 1}`);
    if (before !== undefined) {
      if (bytes + before + 1 <= FRAME_BUDGET) bad(`${tag}: line #${log[0].id - 1} (${before + 1} bytes) was left off a ${bytes}-byte frame although it fit`);
    } else if (bytes + LINE_MAX_BYTES <= FRAME_BUDGET) {
      bad(`${tag}: a ${bytes}-byte frame is not at the budget (${FRAME_BUDGET}), yet it left lines off`);
    }
  }

  // ---- per-message shape -------------------------------------------------------------------------------------

  checkShape(c, s) {
    const L = c.label;
    const bad = (m) => this.v(`${L} [${s.phase} r${s.round}]: ${m}`);
    if (!isInt(s.serverNow)) bad('serverNow not an integer');
    if (!isStr(s.room) || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/.test(s.room)) bad(`bad room ${short(s.room)}`);
    if (!s.you || !isStr(s.you.id) || !['player', 'spectator'].includes(s.you.role)) bad(`bad you ${short(s.you)}`);
    if (!PHASES.includes(s.phase)) bad(`bad phase ${short(s.phase)}`);
    if (s.maxRounds !== 7 || s.maxPlayers !== 16) bad('maxRounds/maxPlayers');
    if (!isInt(s.minPlayers) || s.minPlayers < 2 || s.minPlayers > 16) bad(`bad minPlayers ${s.minPlayers}`);
    if (!s.options || !['speechSeconds1', 'speechSeconds', 'discussionSeconds', 'defenseSeconds'].every((k) => isInt(s.options[k]))) bad('bad options');
    if (!Array.isArray(s.categories) || s.categories.map((x) => x.id).join() !== CATEGORY_IDS.join()) bad('categories not in §1 order');
    if (!Array.isArray(s.players) || !Array.isArray(s.spectators) || !Array.isArray(s.log)) { bad('players/spectators/log not arrays'); return; }
    if (typeof s.overtime !== 'boolean') bad('overtime not boolean');
    // players
    const ids = new Set();
    s.players.forEach((p, i) => {
      if (p.seat !== i) bad(`players[${i}].seat = ${p.seat}`);
      if (ids.has(p.id)) bad(`duplicate player id ${p.id}`);
      ids.add(p.id);
      if (!['alive', 'ejected', 'left'].includes(p.status)) bad(`bad status ${p.status}`);
      if (typeof p.connected !== 'boolean' || typeof p.isHost !== 'boolean') bad(`bad connected/isHost for ${p.id}`);
      if (p.isHost !== (p.id === s.hostId)) bad(`players[${p.id}].isHost=${p.isHost} but hostId=${s.hostId}`);
      if (!p.cards || CATEGORY_IDS.some((k) => !(k in p.cards)) || Object.keys(p.cards).length !== 8) bad(`cards of ${p.id} lack categories`);
      if (!isInt(p.revealedCount)) bad('revealedCount');
      if (!Array.isArray(p.playedSpecials)) bad('playedSpecials');
      if (s.phase === 'final' ? !Array.isArray(p.unplayedSpecials) : p.unplayedSpecials !== undefined) bad(`unplayedSpecials present=${p.unplayedSpecials !== undefined} in ${s.phase}`);
      if (s.phase !== 'lobby' && p.specialsLeft !== 2 - p.playedSpecials.length) bad(`specialsLeft ${p.specialsLeft} != 2 - played ${p.playedSpecials.length} for ${p.id}`);
    });
    for (const sp of s.spectators) {
      if (ids.has(sp.id)) bad(`id ${sp.id} is both player and spectator`);
      ids.add(sp.id);
    }
    if (s.hostId !== '' && !s.players.some((p) => p.id === s.hostId)) bad(`hostId ${s.hostId} is not a seated player`);
    if (s.you && s.you.isHost !== (s.you.id === s.hostId)) bad('you.isHost inconsistent with hostId');
    // per-phase table (§4)
    const ph = s.phase;
    if (ph === 'lobby' || ph === 'final') { if (s.turn !== null || s.vote !== null || s.timer !== null) bad('turn/vote/timer must be null'); }
    if (ph === 'reveal' && (!s.turn || s.turn.kind !== 'reveal' || s.vote !== null || !s.timer)) bad('reveal needs turn(kind reveal), vote null, timer');
    if (ph === 'discussion' && (s.turn !== null || s.vote !== null || !s.timer)) bad('discussion needs turn null, vote null, timer');
    if (ph === 'vote' && (s.turn !== null || !s.vote || s.timer !== null)) bad('vote needs turn null, vote, timer null');
    if (ph === 'defense' && (!s.turn || s.turn.kind !== 'defense' || s.vote !== null || !s.timer)) bad('defense needs turn(kind defense), vote null, timer');
    if (s.timer && (!isStr(s.timer.label) || !isInt(s.timer.endsAt))) bad(`bad timer ${short(s.timer)}`);
    if (s.turn) {
      const tu = s.turn;
      if (tu.speakerId !== tu.order[tu.index]) bad(`turn.speakerId ${tu.speakerId} != order[${tu.index}]`);
      const expectMust = ph === 'reveal' && s.round === 1 ? 'profession' : null;
      if (tu.mustReveal !== expectMust) bad(`turn.mustReveal ${tu.mustReveal}, expected ${expectMust}`);
      if (ph === 'defense' && tu.hasRevealed !== false) bad('defense hasRevealed must be false');
      const sp = playerById(s, tu.speakerId);
      if (!sp || sp.status !== 'alive') bad(`current speaker ${tu.speakerId} is not alive`);
    }
    if (s.vote) {
      const vo = s.vote;
      if (!['main', 'revote'].includes(vo.stage) || !isInt(vo.ballot) || vo.ballot < 1 || vo.ballots < vo.ballot) bad(`bad vote header ${short({ ...vo, candidates: undefined, voters: undefined, voted: undefined })}`);
      for (const id of vo.candidates) { const p = playerById(s, id); if (!p || p.status !== 'alive') bad(`candidate ${id} not alive`); }
      for (const id of vo.voters) { const p = playerById(s, id); if (!p || p.status !== 'alive') bad(`voter ${id} not alive`); }
      for (const id of vo.voted) if (!vo.voters.includes(id)) bad(`voted ${id} is not a voter`);
      if (new Set(vo.voted).size !== vo.voted.length) bad('duplicate in voted');
    }
    // log
    let prevId = 0;
    for (const e of s.log) {
      if (!isInt(e.id) || e.id <= prevId) { bad(`log ids not increasing at ${short(e)}`); break; }
      prevId = e.id;
      if (!LOG_KINDS.includes(e.kind) || !isStr(e.text) || !isInt(e.ts)) { bad(`bad log entry ${short(e)}`); break; }
    }
    if (s.log.length > 200) bad(`log has ${s.log.length} entries (> 200)`);
    if (prevId < c.lastLogId) bad(`log went backwards (${prevId} < ${c.lastLogId})`);
    c.lastLogId = Math.max(c.lastLogId, prevId);
    // lobby specifics
    if (ph === 'lobby') {
      if (s.round !== 0 || s.capacity !== 0 || s.catastrophe !== null || s.bunker !== null || s.final !== null || s.lastVoteResult !== null) bad('lobby: round/capacity/catastrophe/bunker/final/lastVoteResult must be reset');
      for (const p of s.players) {
        if (p.status !== 'alive' || p.revealedCount !== 0 || p.specialsLeft !== 0 || CATEGORY_IDS.some((k) => p.cards[k] !== null)) bad(`lobby player ${p.id} not blank`);
      }
      const row = s.players.length >= 2 ? (KICKS[s.players.length] || []) : [];
      if (!s.schedule || canon(s.schedule.kicksByRound) !== canon(row) || s.schedule.kicksThisStep !== 0 || s.schedule.nextVoteRound !== null) bad(`lobby schedule ${short(s.schedule)}`);
    } else {
      if (s.round < 1 || s.round > 7) bad(`round ${s.round}`);
      if (!isInt(s.capacity) || s.capacity < 1) bad(`capacity ${s.capacity}`);
      if (!s.catastrophe || !isStr(s.catastrophe.title) || !Array.isArray(s.catastrophe.details)) bad('catastrophe');
      if (!s.bunker || !Array.isArray(s.bunker.features) || s.bunker.features.length < 3) bad('bunker (3+ features)');
      if (s.overtime && s.round !== 7) bad('overtime with round != 7');
    }
  }

  // ---- per-recipient ------------------------------------------------------------------------------------------

  checkRecipient(c, s, fp) {
    const L = c.label;
    const bad = (m) => this.v(`${L} [${s.phase} r${s.round}]: ${m}`);
    const bot = c.bot;
    if (bot.id && s.you.id !== bot.id) bad(`you.id ${s.you.id} != joined id ${bot.id}`);
    const self = playerById(s, s.you.id);
    const isSpectator = s.you.role === 'spectator';
    if (isSpectator) {
      if (s.me !== null) bad('(c) spectator received me != null');
      if (self) bad('spectator is listed in players');
      if (!s.spectators.some((x) => x.id === s.you.id)) bad('spectator not listed in spectators');
      return;
    }
    if (!self) { bad('player not listed in players (removed identity still receives states)'); return; }
    if (self.status === 'left') {
      if (bot.left) bad('received a state after its own leave was processed (status left)');
      else this.w(`${L}: received a state showing itself as left (kicked?)`);
    }
    if (s.phase === 'lobby') { if (s.me !== null) bad('(c) me must be null in the lobby'); return; }
    if (!s.me) { bad('player in a game received me === null'); return; }
    const me = s.me;
    if (!me.cards || CATEGORY_IDS.some((k) => !me.cards[k] || !isStr(me.cards[k].text) || typeof me.cards[k].revealed !== 'boolean')) { bad('me.cards malformed'); return; }
    // own public slots vs private
    let revealed = 0;
    for (const k of CATEGORY_IDS) {
      const pubText = self.cards[k];
      const priv = me.cards[k];
      if (priv.revealed) revealed++;
      if (s.phase === 'final') {
        if (pubText !== priv.text) bad(`final: public ${k} ${short(pubText)} != own ${short(priv.text)}`);
      } else if (priv.revealed) {
        if (pubText !== priv.text) bad(`own revealed ${k}: public ${short(pubText)} != private ${short(priv.text)}`);
      } else if (pubText !== null) bad(`own hidden ${k} is public (${short(pubText)})`);
    }
    if (revealed !== self.revealedCount) bad(`revealedCount ${self.revealedCount} != own revealed ${revealed}`);
    // specials
    if (!Array.isArray(me.specials) || me.specials.length !== 2) bad(`me.specials has ${me.specials && me.specials.length} cards (expected 2)`);
    for (const sp of me.specials || []) {
      const rule = EFFECT_RULES[sp.effect];
      if (!rule) { bad(`unknown special effect ${sp.effect}`); continue; }
      if (!isStr(sp.uid) || !isStr(sp.title) || !isStr(sp.text)) bad(`special ${sp.effect} lacks uid/title/text`);
      if (!rule.targets.includes(sp.target)) bad(`special ${sp.effect} has target ${sp.target}`);
      if (sp.timing !== rule.timing) bad(`special ${sp.effect} timing ${sp.timing} (expected ${rule.timing})`);
      if (sp.minRound !== (rule.minRound || 1)) bad(`special ${sp.effect} minRound ${sp.minRound}`);
      const catOk = rule.category === null ? sp.category === null
        : rule.category === 'any' ? (sp.category === 'choose' || CATEGORY_IDS.includes(sp.category))
          : (sp.category === 'choose' || sp.category === 'random');
      if (!catOk) bad(`special ${sp.effect} category ${sp.category}`);
    }
    const usedCount = (me.specials || []).filter((x) => x.used).length;
    if (usedCount !== self.playedSpecials.length) bad(`used specials ${usedCount} != public playedSpecials ${self.playedSpecials.length}`);
    // canPlaySpecial
    const rk = `${c.gameNo}:${s.round}`;
    if (c.roundKey !== rk) { c.roundKey = rk; c.roundStartPlayed = self.playedSpecials.length; }
    const expectCan = self.status === 'alive' && ACTIVE_PHASES.includes(s.phase) && self.playedSpecials.length === c.roundStartPlayed;
    if (me.canPlaySpecial !== expectCan) bad(`canPlaySpecial ${me.canPlaySpecial}, expected ${expectCan} (status ${self.status}, played ${self.playedSpecials.length}, at round start ${c.roundStartPlayed})`);
    // notes: only the owner's own peeks
    const peeks = (me.specials || []).filter((x) => x.effect === 'peek' && x.used).length;
    if (!Array.isArray(me.notes)) bad('me.notes not an array');
    else if (me.notes.length > peeks) bad(`(b) ${me.notes.length} notes but only ${peeks} peek(s) used`);
    // myVote
    if (s.phase === 'vote') {
      const hasVoted = s.vote.voted.includes(s.you.id);
      if (!!me.myVote !== hasVoted) bad(`myVote ${me.myVote} but voted=${hasVoted}`);
      if (me.myVote && !s.vote.candidates.includes(me.myVote)) bad(`myVote ${me.myVote} is not a candidate`);
      if (me.myVote === s.you.id) bad('voted for self');
    } else if (me.myVote !== null) bad(`myVote ${me.myVote} outside the vote phase`);
    // the private part must not carry tokens
    const meJson = JSON.stringify(me);
    for (const tok of this.tokens) if (meJson.includes(tok)) bad('a token appears in me');
    // remember the owner's hand per public fingerprint (for the leak scan)
    let m = this.meByFp.get(s.you.id);
    if (!m) { m = new Map(); this.meByFp.set(s.you.id, m); }
    // per public state and language: the leak scan pairs a hand only with a reference stream in its language (§11 X5)
    let byLang = m.get(fp);
    if (!byLang) { byLang = {}; m.set(fp, byLang); }
    const lang = langOf(s);
    if (!byLang[lang]) byLang[lang] = { cards: me.cards, notes: me.notes };
  }

  // ---- reference stream: game-flow invariants (d) (e) (f) ---------------------------------------------------

  onReference(s) {
    const ps = this.refPrev;
    this.refPrev = s;
    if (s.phase === 'lobby') {
      if (ps && ps.phase !== 'lobby') this.checkBackToLobby(ps, s);
      else if (this.g && !this.g.done) this.v(`game ${this.g.no} went back to the lobby without a final`);
      if (this.g) this.g = null;
      return;
    }
    if (!ps || ps.phase === 'lobby' || !this.g) { this.startGame(s, ps); return; }
    const g = this.g;
    const bad = (m) => this.v(`game ${g.no} [${ps.phase}->${s.phase} r${s.round}${s.overtime ? ' OT' : ''}]: ${m}`);
    const aliveIds = (st) => st.players.filter((p) => p.status === 'alive').map((p) => p.id);
    const alive = aliveIds(s).length;
    if (s.players.length !== g.n) bad(`player count changed ${g.n} -> ${s.players.length}`);
    if (s.players.some((p, i) => p.id !== g.ids[i])) bad('seats changed during the game');

    // monotonic reveals; status transitions
    for (const p of s.players) {
      const q = playerById(ps, p.id);
      if (!q) continue;
      if (s.phase !== 'final') {
        for (const k of CATEGORY_IDS) if (q.cards[k] !== null && p.cards[k] === null) bad(`${p.id}.${k} went hidden again`);
        if (p.revealedCount < q.revealedCount) bad(`${p.id}.revealedCount decreased`);
        const nonNull = CATEGORY_IDS.filter((k) => p.cards[k] !== null).length;
        if (nonNull !== p.revealedCount) bad(`${p.id}: ${nonNull} public cards but revealedCount ${p.revealedCount}`);
      } else if (p.revealedCount !== q.revealedCount && ps.phase !== 'final') bad(`${p.id}: the final changed revealedCount`);
      if (q.status === 'left' && p.status !== 'left') bad(`${p.id} came back from left`);
      if (q.status === 'alive' && p.status === 'ejected') g.ejections.push({ id: p.id, round: ps.round, overtime: ps.overtime, phase: ps.phase });
      if (q.status !== 'left' && p.status === 'left') g.left++;
      if (q.status === 'ejected' && p.status === 'alive') {
        g.revived++;
        if (g.airlockVictims.delete(p.id)) g.airlockRevived++;
      }
      if (p.playedSpecials.length > q.playedSpecials.length) g.specials += p.playedSpecials.length - q.playedSpecials.length;
    }
    if (s.capacity !== ps.capacity) g.capacityChanges++;

    // §11 X1: nobody leaves the table outside a vote except through a two-player airlock (or by leaving or a kick),
    // airlocks open and close only as the SPEC says, and every one that closes unsealed is logged as jammed
    const lastPs = ps.log.length ? ps.log[ps.log.length - 1].id : 0;
    const fresh = s.log.filter((e) => e.id > lastPs);
    const discEnded = ps.phase === 'discussion' && (s.phase !== 'discussion' || s.overtime !== ps.overtime
      || (s.timer && ps.timer && s.timer.endsAt !== ps.timer.endsAt));
    const sealed = this.checkEjections(ps, s, fresh, bad);
    this.checkAirlocks(ps, s, fresh, discEnded, sealed, bad);

    // end condition: alive <= capacity -> final, at any time
    if (s.phase !== 'final' && alive <= s.capacity) bad(`alive ${alive} <= capacity ${s.capacity} but phase is ${s.phase}`);

    // schedule
    if (s.phase !== 'final') {
      if (canon(s.schedule.kicksByRound) !== canon(KICKS[g.n])) bad(`schedule.kicksByRound ${short(s.schedule.kicksByRound)}`);
      if (s.schedule.outCount !== g.n - alive) bad(`schedule.outCount ${s.schedule.outCount} != ${g.n - alive}`);
      if (s.phase === 'reveal' || s.phase === 'discussion') {
        const k = kicksFormula(s);
        if (s.schedule.kicksThisStep !== k) bad(`schedule.kicksThisStep ${s.schedule.kicksThisStep}, §2 gives ${k}`);
      }
      if (s.phase === 'vote' && s.schedule.kicksThisStep !== s.vote.ballots) bad(`schedule.kicksThisStep ${s.schedule.kicksThisStep} != vote.ballots ${s.vote.ballots}`);
      if (s.phase === 'vote') {
        // §2 re-evaluated at once after a leave, kick or Extra Bunk mid-step (§11 R4); the open ballot always counts as one
        const k = kicksFormula(s);
        const want = s.vote.ballot - 1 + Math.max(1, k);
        if (s.vote.ballots !== want) bad(`vote.ballots ${s.vote.ballots} at ballot ${s.vote.ballot}, §2 gives (ballot − 1) + max(1, ${k}) = ${want}`);
      }
      const nv = nextVoteRoundFormula(s);
      if (s.schedule.nextVoteRound !== nv) bad(`schedule.nextVoteRound ${s.schedule.nextVoteRound}, expected ${nv}`);
    } else if (s.schedule.kicksThisStep !== 0 || s.schedule.nextVoteRound !== null) bad(`final schedule ${short(s.schedule)}`);

    // (d) reveal turns
    if (s.phase === 'reveal' && (ps.phase !== 'reveal' || ps.round !== s.round)) {
      if (!(ps.phase === 'discussion' || ps.phase === 'vote' || ps.phase === 'defense')) bad(`reveal entered from ${ps.phase}`);
      if (s.round !== ps.round + 1) bad(`reveal of round ${s.round} after round ${ps.round}`);
      this.checkRevealOrder(s, bad);
    }
    if (ps.phase === 'reveal' && ps.turn) {
      const sameTurn = s.phase === 'reveal' && s.round === ps.round && s.turn.index === ps.turn.index;
      const sp = ps.turn.speakerId;
      if (sameTurn && !ps.turn.hasRevealed && s.turn.hasRevealed) {
        const before = playerById(ps, sp);
        const after = playerById(s, sp);
        const fresh = CATEGORY_IDS.filter((k) => before.cards[k] === null && after.cards[k] !== null);
        if (!fresh.length) bad(`${sp} hasRevealed but no new public card`);
        if (s.round === 1 && !fresh.includes('profession')) bad(`(d) round 1 reveal by ${sp} was ${fresh.join(',')}, not profession`);
        g.ownReveals++;
      }
      // The game can end in the middle of a turn (a special or a leave brings alive <= capacity, §1): that turn just
      // stops, with no auto-reveal. Anything else that ends a turn must reveal for a speaker who has not.
      const endedMidTurn = s.phase === 'final';
      if (endedMidTurn) {
        const aliveN = (st) => st.players.filter((p) => p.status === 'alive').length;
        if (!(s.capacity > ps.capacity || aliveN(s) < aliveN(ps))) bad('the game ended during a reveal turn although neither capacity nor alive changed');
      }
      if (!sameTurn && !endedMidTurn) {
        const before = playerById(ps, sp);
        const after = playerById(s, sp);
        if (after.status === 'alive' && !ps.turn.hasRevealed) {
          const base = ps.turn.mustReveal ? [ps.turn.mustReveal] : CATEGORY_IDS;
          const eligible = base.filter((k) => before.cards[k] === null);
          if (eligible.length) {
            if (after.revealedCount <= before.revealedCount) bad(`(d) ${sp}'s turn ended without the auto-reveal (eligible ${eligible.join(',')})`);
            else if (ps.round === 1 && after.cards.profession === null) bad(`(d) round 1 auto-reveal for ${sp} was not the profession`);
            g.autoReveals++;
          }
        } else if (after.status !== 'alive' && !ps.turn.hasRevealed) {
          // The speaker stopped being alive during their own turn (an Airlock, or a leave) before revealing: the turn
          // advances with no reveal (§6). If a Back from the Forest brings them back later in this phase, that turn
          // is gone and must not be counted as one they had to reveal in.
          g.turns.set(sp, Math.max(0, (g.turns.get(sp) || 0) - 1));
        }
      }
    }
    if (s.phase === 'reveal' && s.turn && (ps.phase !== 'reveal' || ps.round !== s.round || ps.turn.index !== s.turn.index)) {
      g.turns.set(s.turn.speakerId, (g.turns.get(s.turn.speakerId) || 0) + 1);
      g.turnLog.push(`${s.round}:${s.turn.speakerId}`);
    }
    if (ps.phase === 'reveal' && s.phase !== 'reveal') {
      if (s.phase !== 'discussion' && s.phase !== 'final') bad(`reveal phase left to ${s.phase}`);
      for (const p of s.players) {
        if (p.status !== 'alive') continue;
        let taken = g.turns.get(p.id) || 0;
        // a turn cut short by the end of the game did not have to reveal
        if (s.phase === 'final' && p.id === ps.turn.speakerId && !ps.turn.hasRevealed) taken -= 1;
        if (p.revealedCount < Math.min(8, taken)) bad(`(d) ${p.id} revealed ${p.revealedCount} cards after ${taken} turns`);
      }
      if (ps.round === 1 && s.phase !== 'final') {
        for (const p of s.players) {
          if (p.status === 'alive' && (g.turns.get(p.id) || 0) >= 1 && p.cards.profession === null) bad(`(d) ${p.id} took a round-1 turn but the profession is hidden`);
        }
      }
    }

    // discussion
    if (s.phase === 'discussion' && ps.phase !== 'discussion') {
      if (ps.phase === 'reveal') { if (s.round !== ps.round || s.overtime !== ps.overtime) bad('discussion round mismatch'); }
      else if (ps.phase === 'vote' || ps.phase === 'defense') { if (!s.overtime || s.round !== 7) bad('discussion after a vote step must be overtime'); }
      else bad(`discussion entered from ${ps.phase}`);
      if (s.overtime && !ps.overtime) g.overtime = true;
    }

    // end of a discussion (to a vote step, a skipped/cancelled step, the next round, overtime or the final)
    if (discEnded) {
      const k = kicksFormula(ps);
      const aliveBefore = ps.players.filter((p) => p.status === 'alive');
      const consumed = ps.voteMods.cancelNext && !s.voteMods.cancelNext;
      const allImmune = aliveBefore.every((p) => ps.voteMods.immune.includes(p.id));
      const r = s.lastVoteResult;
      if (s.phase === 'vote') {
        if (k <= 0) bad('(e) a vote step started although §2 gives 0 kicks');
        if (ps.voteMods.cancelNext) bad('(e) a vote step started although cancelNext was set');
        if (s.vote.ballot !== 1 || s.vote.stage !== 'main') bad('step must start with ballot 1 main');
        g.step = { round: ps.round, overtime: ps.overtime, startKicks: k, byVote: 0, ballotsClosed: 0 };
        g.steps++;
      } else if (s.phase === 'final' && alive <= s.capacity && canon(r) === canon(ps.lastVoteResult)
        && (s.capacity > ps.capacity || alive < aliveBefore.length)) {
        // ended during the discussion without a vote: a special (capacity_plus, a sealed airlock) or a leave/kick brought
        // alive <= capacity, and the end check runs after every such change (§1)
        g.endedByChange = (g.endedByChange || 0) + 1;
      } else {
        const instant = r && canon(r) !== canon(ps.lastVoteResult) && !r.cancelled;
        if (k > 0) {
          if (instant) {
            this.w(`game ${g.no}: a whole vote step resolved within one change (zero-voter ballot?): ${short(r)}`);
            g.steps++;
          } else if (consumed) {
            g.skips++;
            if (!r || !r.cancelled || r.stage !== 'main' || r.tally.length || r.ejectedId !== null) bad(`(e) bad skip result ${short(r)}`);
            if (s.voteMods.immune.length || s.voteMods.blocked.length || s.voteMods.doubleVote.length) bad('(e) vote modifiers not cleared by the skip');
          } else if (allImmune) {
            g.cancels++;
            if (!r || !r.cancelled) bad(`(e) everyone immune: expected a cancelled result, got ${short(r)}`);
          } else bad(`(e) §2 gives ${k} kicks but no vote step happened and cancelNext was ${ps.voteMods.cancelNext}`);
        } else {
          if (s.voteMods.cancelNext !== ps.voteMods.cancelNext) bad('(e) a 0-kick round consumed cancelNext');
          if (s.phase === 'final') bad(`final reached from discussion with alive ${alive} > capacity ${s.capacity}`);
        }
        if (s.phase === 'reveal' && (s.round !== ps.round + 1 || ps.round >= 7)) bad(`next round ${s.round} after discussion of ${ps.round}`);
        if (s.phase === 'discussion') {
          if (!(ps.round === 7 && s.overtime)) bad('discussion -> discussion outside overtime');
          g.overtime = true;
        }
        if (s.phase === 'defense' || s.phase === 'lobby') bad(`discussion -> ${s.phase}`);
      }
    }

    // vote ballots
    if (s.phase === 'vote') {
      const opened = ps.phase !== 'vote' || ps.vote.ballot !== s.vote.ballot || ps.vote.stage !== s.vote.stage;
      if (opened) this.checkBallotOpen(s, ps, bad);
    }
    const resultChanged = s.lastVoteResult && (!ps.lastVoteResult || canon(s.lastVoteResult) !== canon(ps.lastVoteResult));
    if (resultChanged && !['vote', 'defense', 'discussion'].includes(ps.phase)) bad(`lastVoteResult changed during ${ps.phase}: ${short(s.lastVoteResult)}`);
    if (resultChanged && (ps.phase === 'vote' || ps.phase === 'defense')) {
      const r = s.lastVoteResult;
      if (r.cancelled) {
        if (r.tally.length || r.ejectedId !== null) bad(`cancelled result must have empty tally ${short(r)}`);
        if (s.phase === 'vote' || s.phase === 'defense') bad('a cancelled step continued');
      } else if (ps.phase === 'vote') {
        this.checkTally(s, ps, bad);
      } else if (r.stage === 'revote' && r.random && r.tally.every((e) => e.votes === 0 && !e.voterIds.length)
        && ps.lastVoteResult && ps.lastVoteResult.tie && r.tally.every((e) => ps.lastVoteResult.tie.includes(e.targetId))) {
        // the defense ended and the revote had no voter left (leaves during the defense), so it closed at once (§3)
        this.w(`game ${g.no}: a revote opened and closed at once with zero voters: ${short(r)}`);
        g.zeroVote++;
        g.fate++;
        if (g.step) g.step.byVote++;
      } else bad(`a ballot result appeared during defense: ${short(r)}`);
    }
    if ((ps.phase === 'vote' || ps.phase === 'defense') && s.phase !== 'vote' && s.phase !== 'defense') {
      const step = g.step;
      const cancelled = s.lastVoteResult && s.lastVoteResult.cancelled;
      if (step && !cancelled && s.phase !== 'final') {
        const left = kicksFormula({ ...s, overtime: step.overtime }, step.round);
        if (left !== 0) bad(`(e) the step of round ${step.round} ended with §2 still giving ${left}`);
      }
      if (step && cancelled) g.cancels++;
      if (step && step.byVote > step.startKicks) bad(`(e) ${step.byVote} vote ejections in a step that started with ${step.startKicks} kicks`);
      if (step && step.round === 7 && !cancelled && s.phase !== 'final') bad('(e) a round-7/overtime step ended without reaching the final');
      if (s.phase === 'reveal' && step && s.round !== step.round + 1) bad('reveal round after step');
      if (s.phase === 'discussion' && !(s.overtime && s.round === 7)) bad('discussion after step must be overtime');
      if (s.phase === 'defense' || s.phase === 'lobby') bad(`after-step phase ${s.phase}`);
      g.stepHistory.push(step ? { ...step, cancelled: !!cancelled } : null);
      g.step = null;
    }
    if (s.phase === 'defense' && ps.phase !== 'defense') {
      g.defenses++;
      if (ps.phase !== 'vote') bad(`defense entered from ${ps.phase}`);
      const tie = s.lastVoteResult && s.lastVoteResult.tie;
      if (!tie) bad('defense without a tie in lastVoteResult');
      else if (canon(s.turn.order) !== canon(seatOrder(s, tie))) bad(`defense order ${short(s.turn.order)} != tied players in seat order ${short(tie)}`);
    }

    // (f) final
    if (s.phase === 'final' && ps.phase !== 'final') this.checkFinal(s, bad);
    if (s.phase === 'final' && ps.phase === 'final' && canon(s.final) !== canon(ps.final)) bad('the final object changed');
    if (s.phase === 'final') g.done = true;
    if (s.phase !== 'final' && ps.phase === 'final') bad(`left the final to ${s.phase}`);
  }

  /**
   * Play again (from the final) and End game (§11 X6, from any phase of a running game, or from the final where it is
   * Play again) in one change: exactly the expected system lines; `left` players gone, everyone else in the same order
   * (renumbered, same names and connections), the same spectators, host and options, and the log kept. The lobby's
   * own shape (blank players, no cards, round 0 …) is checked by checkShape and the §7 schema.
   */
  checkBackToLobby(ps, s) {
    const g = this.g;
    const tag = g ? `game ${g.no}` : 'a game the reference joined late';
    const bad = (m) => this.v(`${tag} [${ps.phase}->lobby r${ps.round}${ps.overtime ? ' OT' : ''}]: ${m}`);
    const lastPs = ps.log.length ? ps.log[ps.log.length - 1].id : 0;
    const fresh = s.log.filter((e) => e.id > lastPs);
    const ended = ps.phase !== 'final';
    // §11 X5: by key; an English reference also checks the words
    const wantKeys = [...(ended ? ['log.endGame'] : []), 'log.backToLobby'];
    const want = [...(ended ? ['The host ended the game'] : []), 'Back to the lobby — same table, new cards next game'];
    const english = langOf(s) === 'en';
    if (canon(fresh.map((e) => [e.kind, e.key])) !== canon(wantKeys.map((k) => ['system', k]))
      || (english && canon(fresh.map((e) => e.text)) !== canon(want))) {
      bad(`${ended ? 'went back to the lobby without a final: expected End game' : 'Play again'}'s lines ${short(wantKeys)}${english ? ` ${short(want)}` : ''}, got ${short(fresh.map((e) => `${e.kind}: ${e.key}: ${e.text}`))}`);
    } else if (ended && g) {
      g.endedByHost = true;
      g.endedIn = { phase: ps.phase, round: ps.round, overtime: ps.overtime, airlocks: (ps.airlocks || []).length, vote: !!ps.vote,
        turn: ps.turn ? ps.turn.kind : null, voteMods: ps.voteMods.immune.length + ps.voteMods.blocked.length + ps.voteMods.doubleVote.length + (ps.voteMods.cancelNext ? 1 : 0),
        out: ps.players.filter((p) => p.status !== 'alive').length };
    }
    if (!ended && g && !g.done) bad('Play again from a final the reference never saw');
    const kept = ps.players.filter((p) => p.status !== 'left');
    if (canon(s.players.map((p) => [p.id, p.name, p.connected])) !== canon(kept.map((p) => [p.id, p.name, p.connected]))) {
      bad(`seated players ${short(s.players.map((p) => p.id))}, expected the non-left ones in the same order ${short(kept.map((p) => p.id))}`);
    }
    if (canon(s.spectators) !== canon(ps.spectators)) bad(`spectators changed: ${short(ps.spectators.map((x) => x.id))} -> ${short(s.spectators.map((x) => x.id))}`);
    if (s.hostId !== ps.hostId) bad(`host changed ${ps.hostId} -> ${s.hostId}`);
    if (canon(s.options) !== canon(ps.options)) bad('options changed');
    // (the lines both frames carry must be the same, and end where the old log ended; which older lines a frame carries
    // is checkWindow's: the lobby's smaller head may bring back lines the final's frame guard left off)
    const oldPart = s.log.slice(0, s.log.length - fresh.length).map((e) => e.id);
    const psIds = ps.log.map((e) => e.id);
    const both = Math.min(oldPart.length, psIds.length);
    if (canon(oldPart.slice(oldPart.length - both)) !== canon(psIds.slice(psIds.length - both)) || (psIds.length > 0 && oldPart.at(-1) !== psIds.at(-1))) bad('the log was not kept');
    if (fresh.length && fresh[0].id !== lastPs + 1) bad(`log ids jumped ${lastPs} -> ${fresh[0].id}`);
    if (!Array.isArray(s.airlocks) || s.airlocks.length) bad(`airlocks in the lobby: ${short(s.airlocks)}`);
  }

  /**
   * §11 X1: classifies every alive -> ejected change of this transition. A vote ejection needs its vote line and a
   * running (or just started) vote step; anything else must be a sealed airlock: an airlock open on that player in
   * this round, closed by a second, different, alive player who played an Airlock card now, with the "sealed" line.
   * Returns the ids thrown out through the airlock.
   */
  checkEjections(ps, s, fresh, bad) {
    const g = this.g;
    const out = [];
    const lang = langOf(s);
    const english = lang === 'en';
    const nameOf = (id) => { const p = playerById(s, id); return p ? p.name : id; };
    const resultChanged = s.lastVoteResult && !s.lastVoteResult.cancelled && canon(s.lastVoteResult) !== canon(ps.lastVoteResult);
    for (const p of s.players) {
      const q = playerById(ps, p.id);
      if (!q || q.status !== 'alive' || p.status !== 'ejected') continue;
      // §11 X5: the vote's eject line by key and params (English references: the words too)
      const voteLine = fresh.some((e) => e.kind === 'eject' && e.key === 'log.eject' && e.params && e.params.p === p.id
        && (!english || e.text === `${p.name} is ejected and stays in the forest` || e.text.endsWith(`: ${p.name} is ejected and stays in the forest`)));
      if (voteLine && (ps.phase === 'vote' || ps.phase === 'defense' || resultChanged)) { g.airlockVictims.delete(p.id); continue; }
      if (ps.phase !== 'reveal' && ps.phase !== 'discussion') { bad(`(x1) ${p.id} was ejected in ${ps.phase} without a vote line`); continue; }
      const open = (ps.airlocks || []).find((a) => a.targetId === p.id);
      const seal = fresh.find((e) => e.kind === 'eject' && e.key === 'log.airlockSeal' && e.params && e.params.t === p.id);
      if (!open) { bad(`(x1) ${p.id} was ejected outside a vote with no airlock open on them`); continue; }
      if (!seal) { bad(`(x1) ${p.id} left through the airlock without a "sealed the airlock" line`); continue; }
      const m = { a: seal.params.a, by: Array.isArray(seal.params.by) ? seal.params.by : [] };
      if (english) {
        const t = AIRLOCK_SEALED_RE.exec(seal.text);
        if (!t || t[1] !== nameOf(m.a) || t[2] !== m.by.map(nameOf).join(', ') || t[3] !== p.name) bad(`(x1) the English seal line does not name its players: ${short(seal.text)}`);
      }
      if (open.round !== ps.round) bad(`(x1) the airlock on ${p.id} was opened in round ${open.round}, sealed in round ${ps.round}`);
      const joiner = playerById(s, m.a);
      const jq = joiner ? playerById(ps, joiner.id) : null;
      if (!joiner || !jq || joiner.id === p.id || open.byIds.includes(joiner.id)) {
        bad(`(x1) the airlock on ${p.id} was sealed by "${m.a}", not by a second, different player (opened by ${open.byIds.join(',')})`);
      } else {
        if (jq.status !== 'alive') bad(`(x1) ${joiner.id} sealed an airlock while ${jq.status}`);
        if (joiner.playedSpecials.length !== jq.playedSpecials.length + 1 || !isAirlockCard(joiner.playedSpecials[joiner.playedSpecials.length - 1], lang)) {
          bad(`(x1) ${joiner.id} sealed the airlock on ${p.id} without playing an Airlock card now`);
        }
      }
      if (canon(m.by) !== canon(open.byIds)) bad(`(x1) "sealed the airlock with ${m.by.join(', ')}" but it was opened by ${open.byIds.join(',')}`);
      g.airlockSealed++;
      g.airlockVictims.add(p.id);
      out.push(p.id);
    }
    return out;
  }

  /** §11 X1: the open airlocks between two reference states (shape, lifetime, opening and jamming). */
  checkAirlocks(ps, s, fresh, discEnded, sealed, bad) {
    const g = this.g;
    const now = Array.isArray(s.airlocks) ? s.airlocks : [];
    const before = Array.isArray(ps.airlocks) ? ps.airlocks : [];
    const lang = langOf(s);
    const english = lang === 'en';
    const nameOf = (id) => { const p = playerById(s, id); return p ? p.name : id; };
    const key = (a) => `${a.targetId}|${(a.byIds || []).join(',')}|${a.round}`;
    if (now.length && s.phase !== 'reveal' && s.phase !== 'discussion') bad(`(x1) ${now.length} airlock(s) open in ${s.phase}`);
    if (now.length && discEnded) bad(`(x1) an airlock outlived the discussion of its round: ${short(now)}`);
    const targets = new Set();
    for (const a of now) {
      const t = playerById(s, a.targetId);
      if (targets.has(a.targetId)) bad(`(x1) two airlocks on ${a.targetId}`);
      targets.add(a.targetId);
      if (!t || t.status !== 'alive') bad(`(x1) an airlock is open on ${a.targetId}, who is ${t ? t.status : 'unknown'}`);
      if (a.round !== s.round || s.round < 2) bad(`(x1) airlock of round ${a.round} open in round ${s.round}`);
      if (!Array.isArray(a.byIds) || a.byIds.length !== 1 || a.byIds.includes(a.targetId)) bad(`(x1) airlock on ${a.targetId} has byIds ${short(a.byIds)}`);
    }
    const beforeKeys = new Set(before.map(key));
    const nowKeys = new Set(now.map(key));
    for (const a of now) {
      if (beforeKeys.has(key(a))) continue;
      g.airlockOpened++;
      const opener = a.byIds && a.byIds[0];
      const q = playerById(ps, opener);
      const p = playerById(s, opener);
      if (ps.phase !== 'reveal' && ps.phase !== 'discussion') bad(`(x1) an airlock was opened in ${ps.phase}`);
      if (!q || q.status !== 'alive') bad(`(x1) the airlock on ${a.targetId} was opened by ${opener}, who was not alive`);
      if (!p || !q || p.playedSpecials.length !== q.playedSpecials.length + 1 || !isAirlockCard(p.playedSpecials[p.playedSpecials.length - 1], lang)) {
        bad(`(x1) the airlock on ${a.targetId} opened without ${opener} playing an Airlock card now`);
      }
      // §11 X5: by key and params (the Z5 overtime wording is the `ot` param); English references: the words too
      const line = `🚪 ${nameOf(opener)} started cycling the airlock on ${nameOf(a.targetId)}. If one more Airlock card is played on ${nameOf(a.targetId)} before ${s.overtime ? 'the overtime discussion ends' : "this round's discussion ends"}, ${nameOf(a.targetId)} is out — no vote.`;
      if (!fresh.some((e) => e.kind === 'special' && e.key === 'log.airlockStart' && e.params && e.params.a === opener && e.params.t === a.targetId
        && e.params.ot === s.overtime && (!english || e.text === line))) bad(`(x1) no "started cycling the airlock" line for the airlock on ${a.targetId}`);
    }
    for (const a of before) {
      if (nowKeys.has(key(a)) || sealed.includes(a.targetId)) continue;
      const t = playerById(s, a.targetId);
      const jam = `🚪 The airlock on ${nameOf(a.targetId)} jammed — nobody closed it.`;
      const jamAt = fresh.findIndex((e) => e.kind === 'special' && e.key === 'log.airlockJam' && e.params && e.params.t === a.targetId && (!english || e.text === jam));
      if (jamAt < 0) bad(`(x1) the airlock on ${a.targetId} closed unsealed without a "jammed" line`);
      else {
        g.airlockJammed++;
        // §11 Y1: a target who left or was kicked: the jammed line comes right after that line (before, say, a new
        // host's line); unless that ended the game, when it comes after "The bunker door closes" (and other jams).
        const prev = jamAt > 0 ? fresh[jamAt - 1] : null;
        const gone = !!prev && ['log.leftGame', 'log.kicked'].includes(prev.key) && prev.params && prev.params.p === a.targetId;
        const afterDoor = s.phase === 'final' && !!prev && ['log.doorCloses', 'log.airlockJam'].includes(prev.key);
        if (t && t.status === 'left' && !gone && !afterDoor) bad(`(y1) the airlock on ${a.targetId}, who left, jammed after ${short(prev ? prev.text : '')} instead of right after the leave/kick line`);
      }
      if (!(discEnded || s.phase === 'final' || !t || t.status !== 'alive')) bad(`(x1) the airlock on ${a.targetId} jammed while its discussion was running and its target alive`);
    }
  }

  startGame(s, ps) {
    const no = this.games.length + 1;
    const g = {
      no, n: s.players.length, ids: s.players.map((p) => p.id), turns: new Map(), turnLog: [], ejections: [], left: 0, revived: 0,
      specials: 0, capacityChanges: 0, steps: 0, skips: 0, cancels: 0, defenses: 0, ballots: 0, ties: 0, fate: 0, zeroVote: 0,
      ownReveals: 0, autoReveals: 0, overtime: false, step: null, stepHistory: [], done: false, final: null, startedAt: Date.now(),
      refStates: 0, airlockOpened: 0, airlockSealed: 0, airlockJammed: 0, airlockRevived: 0, airlockVictims: new Set(), dealChecked: false,
      endedByHost: false, endedIn: null,
    };
    this.games.push(g);
    this.g = g;
    const bad = (m) => this.v(`game ${no} [start]: ${m}`);
    if (ps && ps.phase !== 'lobby') bad(`first reference state of a game after ${ps.phase}`);
    if (!ps) { this.w(`game ${no}: reference joined mid-game; start checks skipped`); return; }
    if (s.phase !== 'reveal' || s.round !== 1 || s.overtime) bad(`game starts in ${s.phase} r${s.round}`);
    if (s.capacity !== Math.floor(g.n / 2)) bad(`capacity ${s.capacity} != floor(${g.n}/2)`);
    if (s.lastVoteResult !== null) bad('lastVoteResult not reset at start');
    if (canon(s.players.map((p) => p.id)) !== canon(ps.players.map((p) => p.id))) bad('seats changed at start');
    for (const p of s.players) {
      if (p.status !== 'alive' || p.revealedCount !== 0 || p.specialsLeft !== 2 || CATEGORY_IDS.some((k) => p.cards[k] !== null)) bad(`player ${p.id} not freshly dealt`);
    }
    const f = s.bunker ? s.bunker.features.length : 0;
    if (f < 3 || f > 5) bad(`bunker has ${f} features`);
    if (!Array.isArray(s.airlocks) || s.airlocks.length) bad(`(x1) airlocks at the start: ${short(s.airlocks)}`);
    this.checkRevealOrder(s, bad);
  }

  checkRevealOrder(s, bad) {
    const alive = s.players.filter((p) => p.status === 'alive').map((p) => p.id);
    const expected = s.round % 2 === 1 ? alive : [...alive].reverse();
    if (canon(s.turn.order) !== canon(expected)) bad(`(d) reveal order of round ${s.round} ${short(s.turn.order)}, expected ${short(expected)}`);
    if (s.turn.index !== 0 && !(s.turn.order.slice(0, s.turn.index).every((id) => playerById(s, id).status !== 'alive'))) bad('reveal phase does not start at the first alive speaker');
  }

  checkBallotOpen(s, ps, bad) {
    const g = this.g;
    const vo = s.vote;
    const alive = s.players.filter((p) => p.status === 'alive').map((p) => p.id);
    if (vo.voted.length) bad('a new ballot opened with votes already cast');
    if (vo.stage === 'main') {
      g.ballots++;
      const k = kicksFormula(s);
      if (k <= 0) bad('(e) a ballot opened although §2 gives 0 kicks');
      if (vo.ballots !== vo.ballot - 1 + k) bad(`(e) ballot ${vo.ballot}: ballots=${vo.ballots}, expected ${vo.ballot - 1 + k} ((ballot-1)+§2)`);
      const cands = alive.filter((id) => !s.voteMods.immune.includes(id));
      if (canon(vo.candidates) !== canon(cands)) bad(`candidates ${short(vo.candidates)}, expected alive non-immune ${short(cands)}`);
      const voters = alive.filter((id) => !s.voteMods.blocked.includes(id) && cands.some((x) => x !== id));
      if (canon(vo.voters) !== canon(voters)) bad(`voters ${short(vo.voters)}, expected ${short(voters)}`);
      if (g.step && ps.phase === 'vote' && vo.ballot !== ps.vote.ballot + 1) this.w(`game ${g.no}: ballot jumped ${ps.vote.ballot} -> ${vo.ballot} (a zero-voter ballot closed at once?)`);
    } else {
      const tie = s.lastVoteResult && s.lastVoteResult.tie;
      if (ps.phase !== 'defense') bad(`revote opened from ${ps.phase}`);
      if (!tie) bad('revote without a tie');
      else {
        const cands = seatOrder(s, tie.filter((id) => alive.includes(id)));
        if (canon(vo.candidates) !== canon(cands)) bad(`revote candidates ${short(vo.candidates)}, expected ${short(cands)}`);
      }
      if (g.lastMainVoters) {
        const expectedVoters = g.lastMainVoters.filter((id) => alive.includes(id) && vo.candidates.some((x) => x !== id));
        if (canon(vo.voters) !== canon(expectedVoters)) bad(`revote voters ${short(vo.voters)}, expected ${short(expectedVoters)}`);
      }
    }
    if (vo.stage === 'main') g.lastMainVoters = vo.voters.slice();
  }

  checkTally(s, ps, bad) {
    const g = this.g;
    const r = s.lastVoteResult;
    const vo = ps.vote;
    if (g.step) g.step.ballotsClosed++;
    const ids = r.tally.map((e) => e.targetId);
    if (!sameSet(ids, vo.candidates)) {
      // The open ballot closed (its own result is overwritten) and the NEXT main ballot opened and closed within the
      // same change, because it had no voter (§3: "the ballot closes at once with zero votes"). Verify that claim:
      // at that ballot, alive = the alive players now plus the one it ejected; its candidates are those who are not
      // immune, and none of them could vote (blocked, or no candidate other than themselves).
      if (r.stage === 'main' && r.random && r.ejectedId && r.tally.every((e) => e.votes === 0 && !e.voterIds.length)) {
        const aliveThen = s.players.filter((p) => p.status === 'alive' || p.id === r.ejectedId).map((p) => p.id);
        const cands = aliveThen.filter((id) => !ps.voteMods.immune.includes(id));
        const voters = aliveThen.filter((id) => !ps.voteMods.blocked.includes(id) && cands.some((c) => c !== id));
        if (canon(seatOrder(s, ids)) !== canon(seatOrder(s, cands))) bad(`instant ballot: tally ${short(ids)} != alive non-immune ${short(cands)}`);
        if (voters.length) bad(`instant ballot claimed zero voters, but ${short(voters)} could vote`);
        this.w(`game ${g.no}: a ballot opened and closed at once with zero voters (not observable as open): ${short(r)}`);
        g.zeroVote++;
        g.fate++;
        if (g.step) g.step.byVote++;
        return;
      }
      bad(`tally targets ${short(ids)} != candidates ${short(vo.candidates)}`);
    }
    if (r.stage !== vo.stage) bad(`result stage ${r.stage} != ballot stage ${vo.stage}`);
    const seen = new Set();
    for (const e of r.tally) {
      let w = 0;
      for (const v of e.voterIds) {
        if (seen.has(v)) bad(`voter ${v} counted twice`);
        seen.add(v);
        if (!vo.voters.includes(v)) bad(`tally voter ${v} was not a voter`);
        if (v === e.targetId) bad(`${v} voted for self`);
        w += ps.voteMods.doubleVote.includes(v) ? 2 : 1;
      }
      if (e.votes !== w) bad(`tally ${e.targetId}: votes ${e.votes} but weighted voters give ${w}`);
    }
    for (const v of vo.voted) if (!seen.has(v) && playerById(s, v).status === 'alive') bad(`voter ${v} voted but is missing from the tally`);
    for (let i = 1; i < r.tally.length; i++) {
      const a = r.tally[i - 1];
      const b = r.tally[i];
      if (a.votes < b.votes || (a.votes === b.votes && playerById(s, a.targetId).seat > playerById(s, b.targetId).seat)) { bad(`tally not sorted by votes desc then seat: ${short(r.tally.map((e) => [e.targetId, e.votes]))}`); break; }
    }
    const top = r.tally.length ? r.tally[0].votes : 0;
    const tops = r.tally.filter((e) => e.votes === top).map((e) => e.targetId);
    if (!r.tally.length) {
      if (r.ejectedId !== null || r.tie !== null) bad(`empty ballot result ${short(r)}`);
      return;
    }
    if (top === 0) {
      g.zeroVote++;
      g.fate++;
      if (!r.random || !vo.candidates.includes(r.ejectedId)) bad(`(e) zero votes: expected a random ejection among candidates ${short(r)}`);
    } else if (tops.length === 1) {
      if (r.ejectedId !== tops[0] || r.tie !== null || r.random) bad(`(e) unique top ${tops[0]} but result ${short({ ejectedId: r.ejectedId, tie: r.tie, random: r.random })}`);
    } else {
      g.ties++;
      if (!r.tie || !sameSet(r.tie, tops)) bad(`(e) tie ${short(r.tie)} != top ${short(tops)}`);
      if (vo.stage === 'main') {
        if (r.ejectedId !== null || r.random) bad('(e) a main-ballot tie must go to defense without an ejection');
        if (s.phase !== 'defense' && s.phase !== 'final') bad(`(e) tie in main ballot but next phase is ${s.phase}`);
      } else {
        g.fate++;
        if (!r.random || !tops.includes(r.ejectedId)) bad(`(e) tied revote must eject one of the tied at random ${short(r)}`);
      }
    }
    if (r.ejectedId) {
      const p = playerById(s, r.ejectedId);
      if (!p || p.status !== 'ejected') bad(`${r.ejectedId} is not ejected after the ballot`);
      if (g.step) g.step.byVote++;
    }
  }

  checkFinal(s, bad) {
    const g = this.g;
    g.final = s.final;
    const alive = s.players.filter((p) => p.status === 'alive').map((p) => p.id);
    const out = s.players.filter((p) => p.status !== 'alive').map((p) => p.id);
    if (!s.final) { bad('(f) final is null'); return; }
    if (canon(s.final.survivors) !== canon(alive)) bad(`(f) survivors ${short(s.final.survivors)} != alive ${short(alive)}`);
    if (canon(s.final.out) !== canon(out)) bad(`(f) out ${short(s.final.out)} != ${short(out)}`);
    if (s.final.survivors.length > s.capacity) bad(`(f) ${s.final.survivors.length} survivors > capacity ${s.capacity}`);
    for (const p of s.players) {
      const hidden = CATEGORY_IDS.filter((k) => !isStr(p.cards[k]));
      if (hidden.length) bad(`(f) ${p.id} still has hidden cards in the final: ${hidden.join(',')}`);
      if (!Array.isArray(p.unplayedSpecials) || p.unplayedSpecials.length + p.playedSpecials.length !== 2) bad(`(f) ${p.id}: played ${p.playedSpecials.length} + unplayed ${p.unplayedSpecials && p.unplayedSpecials.length} != 2`);
    }
    if (this.checkDeal) {
      // §11 X1 deal: the final shows every hand (played + unplayed), so the fixed cards can be counted exactly
      const [wantA, wantR] = x1Deal(g.n);
      const lang = langOf(s);
      let holdersA = 0;
      let holdersR = 0;
      for (const p of s.players) {
        const hand = [...p.playedSpecials, ...(p.unplayedSpecials || [])];
        const a = hand.filter((c) => isAirlockCard(c, lang)).length;
        const r = hand.filter((c) => isReviveCard(c, lang)).length;
        if (a > 1 || r > 1 || (a && r)) bad(`(x1) ${p.id} was dealt ${a} Airlock(s) and ${r} revive(s)`);
        holdersA += a ? 1 : 0;
        holdersR += r ? 1 : 0;
        for (const c of hand) {
          // an English view names the fixed cards: a random card must not look like one (§11 X5: other languages by id)
          if (lang === 'en' && ((c.title === AIRLOCK_CARD.title && !isAirlockCard(c, lang)) || (c.title === REVIVE_CARD.title && !isReviveCard(c, lang)))) {
            bad(`(x1) ${p.id} holds a "${c.title}" that is not the fixed card (the random deck dealt it): ${short(c.text)}`);
          }
        }
      }
      if (holdersA !== wantA || holdersR !== wantR) bad(`(x1) deal: ${holdersA} Airlock and ${holdersR} revive holders at N=${g.n}; SPEC §11 X1 wants ${wantA} and ${wantR}`);
      g.dealChecked = true;
    }
    if (this.strictSpecialsFree && g.specials === 0 && g.left === 0) {
      if (s.final.survivors.length !== Math.floor(g.n / 2)) bad(`(f) no specials: ${s.final.survivors.length} survivors, expected floor(N/2) = ${Math.floor(g.n / 2)}`);
      if (s.round !== 7 || s.overtime) bad(`(f) no specials: final at round ${s.round}${s.overtime ? ' in overtime' : ''}, expected after round 7`);
      const perRound = [0, 0, 0, 0, 0, 0, 0];
      for (const e of g.ejections) perRound[e.round - 1]++;
      if (canon(perRound) !== canon(KICKS[g.n])) bad(`(e) no specials: ejections per round ${short(perRound)} != KICKS[${g.n}] ${short(KICKS[g.n])}`);
    }
  }

  // ---- post-hoc: (a) identical public views, (b) hidden-text leaks, tokens -----------------------------------

  finish() {
    const ref = this.reference;
    if (!ref) { this.v('no reference client attached'); return this.report(); }
    const R = this.refSeq;
    const refIndex = new Map();
    R.forEach((e, i) => { const arr = refIndex.get(e.fp); if (arr) arr.push(i); else refIndex.set(e.fp, [i]); });
    let compared = 0;
    for (const c of this.clients.values()) {
      if (c === ref) continue;
      for (const seg of c.segments) {
        const S = seg.seq.filter((e) => R.length && e.t >= R[0].t);
        if (!S.length) continue;
        const cand = refIndex.get(S[0].fp);
        if (!cand) {
          const near = R.reduce((best, e, i) => (best === -1 || Math.abs(e.t - S[0].t) < Math.abs(R[best].t - S[0].t) ? i : best), -1);
          this.v(`(a) ${c.label}: first state of socket #${seg.gen} was never seen by the reference; vs nearest: ${this.fpDiff(S[0].fp, near >= 0 ? R[near].fp : null)}`);
          continue;
        }
        let i0 = cand[0];
        for (const i of cand) if (Math.abs(R[i].t - S[0].t) < Math.abs(R[i0].t - S[0].t)) i0 = i;
        for (let j = 0; j < S.length; j++) {
          const r = R[i0 + j];
          compared++;
          if (!r) { this.v(`(a) ${c.label}: received ${S.length - j} public state(s) after the reference's last one`); break; }
          if (r.fp !== S[j].fp && canon(JSON.parse(this.fpJson.get(r.fp))) !== canon(JSON.parse(this.fpJson.get(S[j].fp)))) {
            this.v(`(a) ${c.label} (socket #${seg.gen}) diverges from the reference at its state #${j} (${r.phase}): ${this.fpDiff(S[j].fp, r.fp)}`);
            break;
          }
        }
      }
    }
    this.comparedStates = compared;
    this.scanLeaks();
    return this.report();
  }

  fpDiff(a, b) {
    if (!a || !b) return 'n/a';
    return diffPaths(JSON.parse(this.fpJson.get(a)), JSON.parse(this.fpJson.get(b))).join('; ');
  }

  /**
   * (b): walks each leak reference stream (the reference, and one per extra language, §11 X5); for every public state
   * checks every public card against its owner's hand at that same broadcast (in the stream's language), and scans new
   * log entries (text, parts and params) for the text of any card that is still hidden.
   */
  scanLeaks() {
    const stats = { logEntriesScanned: 0, slotsChecked: 0, streams: [] };
    for (const c of this.leakRefs) {
      const r = this.scanStream(c);
      stats.logEntriesScanned += r.scanned;
      stats.slotsChecked += r.slotsChecked;
      stats.streams.push({ label: c.label, lang: c.leak.lang, states: c.leak.seq.length, scanned: r.scanned, slots: r.slotsChecked });
    }
    this.leakStats = stats;
  }

  scanStream(c) {
    const current = new Map(); // pid -> cards (the latest own view known at this point of the stream, in its language)
    const everPublic = [];
    const everPublicSet = new Set();
    const ambiguous = new Map();
    let lastLogId = 0;
    let lastPhase = null;
    let scanned = 0;
    let slotsChecked = 0;
    const isAmbiguous = (text, staticText) => {
      if (text.length < 4) return true;
      if (staticText.includes(text)) return true;
      const a = ambiguous.get(text);
      if (a && a.yes) return true;
      let from = a ? a.upTo : 0;
      for (; from < everPublic.length; from++) {
        if (everPublic[from].includes(text)) { ambiguous.set(text, { yes: true, upTo: from }); return true; }
      }
      ambiguous.set(text, { yes: false, upTo: from });
      return false;
    };
    const tag = this.leakRefs.length > 1 ? ` [${c.label}, ${c.leak.lang}]` : '';
    for (const e of c.leak.seq) {
      const json = e.json || this.fpJson.get(e.fp);
      for (const tok of this.tokens) if (json.includes(tok)) this.v(`(b) a token appears in a public state${tag}`);
      if (json.includes('"notes"')) this.v(`(b) a public state contains a "notes" field${tag}`);
      const s = JSON.parse(json);
      const lang = e.lang;
      const [last] = Array.isArray(s.log) ? s.log : [0];
      if (s.phase === 'lobby') { current.clear(); lastPhase = 'lobby'; lastLogId = Math.max(lastLogId, last); continue; }
      if (lastPhase === 'lobby' || lastPhase === null) current.clear();
      lastPhase = s.phase;
      for (const p of s.players) {
        const m = this.meByFp.get(p.id);
        const byLang = m && m.get(e.fp);
        const exact = byLang && byLang[lang];
        if (exact) current.set(p.id, exact.cards);
        for (const k of CATEGORY_IDS) {
          const t = p.cards[k];
          if (t !== null && !everPublicSet.has(t)) { everPublicSet.add(t); everPublic.push(t); }
          if (s.phase === 'final' || !exact) continue;
          slotsChecked++;
          if (t !== null && (!exact.cards[k].revealed || exact.cards[k].text !== t)) this.v(`(b) public ${p.id}.${k}=${short(t)} but the owner's hand says ${short(exact.cards[k])}${tag}`);
          if (t === null && exact.cards[k].revealed) this.v(`(b) ${p.id}.${k} revealed in the owner's hand but null in public${tag}`);
        }
      }
      if (s.phase === 'final') { lastLogId = Math.max(lastLogId, last); continue; }
      const staticText = [s.catastrophe && s.catastrophe.title, s.catastrophe && s.catastrophe.text, ...(s.catastrophe ? s.catastrophe.details : []),
        s.bunker && JSON.stringify(s.bunker), ...s.players.map((p) => p.name), ...s.spectators.map((x) => x.name),
        ...s.players.flatMap((p) => p.playedSpecials.map((x) => `${x.title} ${x.text}`))].join('\n');
      const fresh = [];
      for (let id = lastLogId + 1; id <= last; id++) {
        const entry = c.leak.log.get(id);
        if (entry) fresh.push(entry);
      }
      lastLogId = Math.max(lastLogId, last);
      if (!fresh.length) continue;
      // the text, and the parts and params as JSON (a card chip's words and every param are sent too)
      const logText = fresh.map((l) => `${l.text}\n${l.blob}`).join('\n');
      for (const p of s.players) {
        const own = current.get(p.id);
        if (!own) continue;
        for (const k of CATEGORY_IDS) {
          if (p.cards[k] !== null || own[k].revealed) continue;
          const secret = own[k].text;
          if (!logText.includes(secret) && !logText.includes(JSON.stringify(secret).slice(1, -1))) continue;
          if (isAmbiguous(secret, staticText)) continue;
          this.v(`(b) LEAK: the hidden ${p.id}.${k} ${short(secret)} appears in the public log${tag}: ${short(fresh.map((l) => l.text).filter((x) => x.includes(secret)))}`);
        }
      }
      scanned += fresh.length;
    }
    return { scanned, slotsChecked };
  }

  report() {
    return {
      violations: this.violations,
      warnings: this.warnings,
      games: this.games.map((g) => ({
        n: g.n, done: g.done, survivors: g.final ? g.final.survivors.length : null, ejections: g.ejections.length,
        steps: g.steps, ballots: g.ballots, ties: g.ties, defenses: g.defenses, fate: g.fate, zeroVote: g.zeroVote, skips: g.skips,
        cancels: g.cancels, specials: g.specials, left: g.left, revived: g.revived, capacityChanges: g.capacityChanges,
        overtime: g.overtime, ownReveals: g.ownReveals, autoReveals: g.autoReveals, refStates: g.refStates,
        airlockOpened: g.airlockOpened, airlockSealed: g.airlockSealed, airlockJammed: g.airlockJammed, airlockRevived: g.airlockRevived,
        dealChecked: g.dealChecked, endedByHost: g.endedByHost, endedIn: g.endedIn,
      })),
      messages: this.messages,
      schemaChecked: this.schemaChecked,
      referenceStates: this.refSeq.length,
      comparedStates: this.comparedStates || 0,
      leakStats: this.leakStats || null,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Running a table of bots

/**
 * Creates a room with `n` bot players (the first is the host) plus a spectator "watcher" (the reference stream),
 * plays `games` full games and returns { violations, warnings, report, errors, bots, ... }.
 *
 * scenario(ctx) may register hooks: ctx.onRef((s, prev) => ...) runs on every reference state; ctx.task(promise) tracks
 * async work; ctx.fail(msg) records a violation. ctx.bots[i], ctx.host, ctx.watcher, ctx.addClient(bot), ctx.mkBot().
 * ctx.afterPlayAgain(state) / ctx.afterEndGame(state) run in the lobby after Play again / after the host ended a game.
 *
 * §11 X5 languages: `langs` gives bot i its language (a function of i, an array cycled over, or one language; default
 * 'en'), `watcherLang` the reference's; every other language in play gets a spectator watcher of its own for the leak
 * scan. `toggleLang` {bot, every}: bot index `bot` switches its language with setLang after every `every` actions.
 * With more than one language in play the Checker compares public states `neutral`ly (language-free).
 * `names`: bot i's name (a function of i, or an array; default BOT_NAMES), e.g. botlib realNames for a real table's
 * long names (§11 X5.2: they are what fills a frame to its budget).
 */
export async function runTable(server, {
  n, seed = 1, specials = 0, specialsFromRound = 1, delay = 0, games = 1, label = `N=${n}`, scenario = null, timeoutMs = 40000, stallMs = 5000,
  strictErrors = specials === 0 && !scenario, allowRaceErrors = true, log = null, botOpts = {},
  endWith = 'close', // 'close': every socket just closes (the room waits for the idle TTL); 'leave': everyone sends leave first
  endGame = 0, // SPEC §11 X6: chance per game that the bot host presses End game at a random moment (the game then counts
  //              as played, ended by the host, and the next one starts from the lobby)
  langs = 'en', watcherLang = 'en', toggleLang = null, neutral = null, names = null,
} = {}) {
  const nameFor = (i) => (typeof names === 'function' ? names(i) : Array.isArray(names) ? names[i % names.length]
    : BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? ` ${i}` : ''));
  const langFor = (i) => (typeof langs === 'function' ? langs(i) : Array.isArray(langs) ? langs[i % langs.length] : langs) || 'en';
  const inPlay = new Set([watcherLang, ...Array.from({ length: n }, (_, i) => langFor(i))]);
  if (toggleLang) for (const l of ['en', 'ru']) inPlay.add(l);
  const coord = new Coordinator();
  const checker = new Checker({ label, strictSpecialsFree: specials === 0 && !scenario, neutral: neutral ?? inPlay.size > 1 });
  const bots = [];
  const extras = [];
  const tasks = [];
  const refHooks = [];
  const watchers = [];
  const mkBot = (name, extra = {}) => {
    const b = new Bot({ url: server.url, name, seed: `${seed}:${name}`, delay, specials, specialsFromRound, coordinator: coord, log,
      ...botOpts, ...extra, host: { delay: 0, discussionDelay: 2, endGame, ...(botOpts.host || {}), ...(extra.host || {}) } });
    return b;
  };
  const botLangOpts = (i) => {
    const o = { lang: langFor(i) };
    if (toggleLang && toggleLang.bot === i) o.toggleLang = toggleLang.every || 5;
    return o;
  };
  const ctx = {
    server, checker, coord, bots, extras, mkBot, room: null, host: null, watcher: null, watchers,
    onRef: (fn) => refHooks.push(fn),
    task: (p) => { tasks.push(Promise.resolve(p).catch((e) => checker.v(`scenario task failed: ${e.stack || e}`))); return p; },
    fail: (m) => checker.v(`scenario: ${m}`),
    addClient: (b) => { extras.push(b); checker.attach(b); return b; },
    addBot: (b) => { bots.push(b); checker.attach(b); return b; },
  };
  const closeAll = () => { for (const b of [...bots, ...extras, ctx.watcher, ...watchers]) if (b) b.close(); };
  try {
    const host = mkBot(nameFor(0), botLangOpts(0));
    bots.push(host);
    checker.attach(host);
    await host.create();
    ctx.host = host;
    ctx.room = host.room;
    const watcher = new Bot({ url: server.url, name: 'Watcher', autoplay: false, lang: watcherLang });
    ctx.watcher = watcher;
    checker.attach(watcher, { reference: true });
    await watcher.join(host.room, { spectator: true });
    // §11 X5: a watcher per other language, so the leak scan pairs every hand with a stream in its own language
    for (const l of [...inPlay].filter((x) => x !== watcherLang)) {
      const w = new Bot({ url: server.url, name: `Watcher ${l}`, autoplay: false, lang: l });
      watchers.push(w);
      checker.attach(w, { leakRef: true });
      await w.join(host.room, { spectator: true });
    }
    watcher.on('state', (s, prev) => {
      for (const fn of refHooks) {
        try { fn(s, prev); } catch (e) { checker.v(`scenario hook threw: ${e.stack}`); }
      }
    });
    for (let i = 1; i < n; i++) {
      const b = mkBot(nameFor(i), botLangOpts(i));
      bots.push(b);
      checker.attach(b);
      await b.join(host.room);
    }
    await watcher.waitFor((s) => s.players.length === n && s.players.every((p) => p.connected), 5000, `${n} seated players`);
    if (scenario) await scenario(ctx);
    // The host is whoever the reference stream says it is: a bot that dropped and is resuming has its socket open
    // before its fresh state arrives, and until then its old state may still say isHost (soak r2 #123, #166).
    const refHostId = () => (watcher.state ? watcher.state.hostId : null);
    for (let gno = 1; gno <= games; gno++) {
      const hostBot = bots.find((b) => b.isHost && b.id === refHostId()) || bots.find((b) => b.isHost) || host;
      if (!hostBot.act({ t: 'start' })) throw new Error('host socket closed before start');
      await watcher.waitFor((s) => s.phase !== 'lobby', 5000, 'the game to start');
      const end = await playUntil(ctx, (s) => s.phase === 'final' || s.phase === 'lobby', { timeoutMs, stallMs, what: `the final of game ${gno}` });
      if (end.phase === 'lobby') {
        // SPEC §11 X6: the host ended this game, and the table is in the lobby already (no Play again)
        await quiesce(ctx);
        ctx.afterEndGame && (await ctx.afterEndGame(watcher.state));
        continue;
      }
      if (gno < games) {
        // A host that dropped (chaos) may be resuming right now, or the grace period may be about to pass the role on:
        // give either a moment instead of failing on the race between that and the final.
        const connectedHost = () => bots.find((b) => b.connected && b.isHost && b.id === refHostId());
        if (!connectedHost()) await until(connectedHost, 5000, 'a connected host bot to press Play again').catch(() => {});
        const hb = connectedHost();
        if (!hb) throw new Error('no connected host bot to press Play again');
        await quiesce(ctx);
        // The host bot's own End game, rolled in a running phase, may have landed on the final instead, where it is Play
        // again (SPEC §11 X6): then the table is in the lobby already, and a second Play again would be wrong_phase.
        if (!(watcher.state && watcher.state.phase === 'lobby')) hb.act({ t: 'playAgain' });
        await watcher.waitFor((s) => s.phase === 'lobby', 5000, 'the lobby after Play again');
        ctx.afterPlayAgain && (await ctx.afterPlayAgain(watcher.state));
      }
    }
    await quiesce(ctx);
    await Promise.all(tasks);
    // A task may end with a broadcast of its own (a resume that lands on the final): Anna's copy resolved the task,
    // the reference's copy may still be in flight. Let every client receive it before the sockets close (soak X1 #181).
    await quiesce(ctx);
  } catch (e) {
    checker.v(`run aborted: ${e.message}\n${diagnose(ctx)}`);
  } finally {
    if (endWith === 'leave') {
      try { await leaveAll(ctx); } catch (e) { checker.v(`leaving at the end failed: ${e.message}`); }
    }
    closeAll();
  }
  const report = checker.finish();
  // (g) errors to legal bot actions
  const errors = [];
  for (const b of bots) {
    if (b.hostile) continue; // a deliberately hostile bot's errors are expected
    for (const e of b.errors) {
      errors.push({ bot: b.name, ...e });
      if (e.expected) continue;
      if (e.race === false || strictErrors) {
        checker.v(`(g) ${b.name} got error ${e.code} "${e.message}" for ${short(e.msg)}${e.race ? ' (race)' : ''} at ${e.state}`);
      } else if (e.race && !allowRaceErrors) checker.v(`(g) ${b.name}: race error ${e.code} for ${short(e.msg)}`);
    }
  }
  return {
    ...report, violations: checker.violations, warnings: checker.warnings, errors, room: ctx.room,
    raceErrors: errors.filter((e) => e.race).length,
    droppedActions: bots.reduce((n, b) => n + b.dropped, 0),
    specialsPlayed: bots.flatMap((b) => b.specialsPlayed.map((x) => x.effect)),
  };
}

/** Every connected bot sends `leave` (the watcher last); each leave is confirmed on the watcher's view. */
async function leaveAll(ctx) {
  const w = ctx.watcher;
  for (const b of [...ctx.bots, ...ctx.extras, ...(ctx.watchers || [])]) {
    if (!b || !b.connected || b.left || b.kicked || b.replaced || !b.id) continue;
    const id = b.id;
    b.leave();
    if (w && w.connected) {
      await until(() => { const p = playerById(w.state, id); return !p || p.status === 'left'; }, 3000, `${b.name}'s leave`);
    }
  }
  if (w && w.connected) w.leave();
}

/**
 * Sends `msg` from `bot` and resolves with the error reply, which must have one of `codes`. Rejects if the server
 * accepted the message (its pong came without an error). The error is marked expected (not a (g) violation).
 */
export function expectError(bot, msg, codes, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (!bot.act(msg)) { reject(new Error(`${bot.name}: socket closed, cannot send ${short(msg)}`)); return; }
    const entry = bot.fifo[bot.fifo.length - 1];
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${bot.name}: no reply to ${short(msg)} within ${timeoutMs} ms`)); }, timeoutMs);
    const onErr = (e) => {
      if (e.msg !== msg) return;
      cleanup();
      e.expected = true;
      if (codes.includes(e.code)) resolve(e);
      else reject(new Error(`${bot.name}: ${short(msg)} got error ${e.code} (${e.message}), expected ${codes.join('|')}`));
    };
    const onPong = () => {
      if (!bot.fifo.includes(entry)) { cleanup(); reject(new Error(`${bot.name}: ${short(msg)} was accepted, expected error ${codes.join('|')}`)); }
    };
    const cleanup = () => { clearTimeout(timer); bot.off('server-error', onErr); bot.off('pong', onPong); };
    bot.on('server-error', onErr);
    bot.on('pong', onPong);
  });
}

/** Resolves once pred() is true (polled), or rejects after timeoutMs. */
export async function until(pred, timeoutMs = 5000, what = 'condition') {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(5);
  }
}

/** Waits for pred on the reference; fails on a stall (no new reference state for stallMs) or the timeout. */
export async function playUntil(ctx, pred, { timeoutMs = 40000, stallMs = 5000, what = 'condition' } = {}) {
  const w = ctx.watcher;
  const t0 = Date.now();
  let lastSeq = w.stateSeq;
  let lastChange = Date.now();
  for (;;) {
    if (w.state && pred(w.state)) return w.state;
    if (w.stateSeq !== lastSeq) { lastSeq = w.stateSeq; lastChange = Date.now(); }
    if (Date.now() - lastChange > stallMs) throw new Error(`STALL: no state change for ${stallMs} ms while waiting for ${what}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`TIMEOUT after ${timeoutMs} ms waiting for ${what}`);
    if (ctx.server.exited) throw new Error(`server exited: ${JSON.stringify(ctx.server.exited)}`);
    await sleep(20);
  }
}

/** Waits until no bot has anything in flight and every connected client holds the same public state. */
export async function quiesce(ctx, timeoutMs = 3000) {
  const t0 = Date.now();
  let stableSince = null;
  for (;;) {
    const all = [...ctx.bots, ...ctx.extras, ctx.watcher, ...(ctx.watchers || [])].filter((b) => b && b.connected && !b.left && !b.kicked && !b.replaced && b.state);
    const busy = all.some((b) => b.fifo.length || b.timer);
    const fps = new Set(all.map((b) => publicKey(b.state, ctx.checker.neutral)));
    if (!busy && fps.size <= 1) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= 40) return;
    } else stableSince = null;
    if (Date.now() - t0 > timeoutMs) {
      ctx.checker.v(`no quiescence within ${timeoutMs} ms (busy=${busy}, distinct public states=${fps.size})`);
      return;
    }
    await sleep(5);
  }
}

export function diagnose(ctx) {
  const lines = [`reference: ${describeState(ctx.watcher && ctx.watcher.state)}`];
  for (const b of [...ctx.bots, ...ctx.extras]) {
    const pending = b.state ? b.decide(b.state).map((d) => `${d.key}${b.acted.has(d.key) ? '(done)' : ''}`).join(' ') : '';
    lines.push(`  ${b.name} id=${b.id} conn=${b.connected} fifo=${b.fifo.length} timer=${!!b.timer} paused=${b.paused} stopped=${b.stopped} host=${b.isHost} errors=${b.errors.length} wants=[${pending}]${b.errors.length ? ` last=${b.errors[b.errors.length - 1].code}:${b.errors[b.errors.length - 1].message}` : ''}`);
  }
  const s = ctx.watcher && ctx.watcher.state;
  if (s) lines.push(`  log tail: ${s.log.slice(-6).map((l) => l.text).join(' | ')}`);
  return lines.join('\n');
}

export { BOT_NAMES, Bot, Coordinator, KICKS, describeState, playerById };
