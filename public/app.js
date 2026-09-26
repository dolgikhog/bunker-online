/* Bunker Online — client B ("command console").
 * Vanilla ES module, no build step, CSP-safe: no inline scripts, no on…= attributes, and every
 * server- or user-supplied string goes through textContent / setAttribute (never innerHTML).
 * The whole UI is re-rendered from (state, ui) and morphed into the live DOM, so focus, scroll
 * positions and inputs survive the frequent `state` pushes. Clicks are handled by delegation
 * through data-act attributes. */

import { KICKS, estimateGame, airlockDeal } from './kicks.js';
import { airlockLine, parseSpecialLine, cardLine, finalCause, isLeaveLine, voteHistory } from './loglines.js';

const params = new URLSearchParams(location.search);
const MOCK = params.has('mock') ? (params.get('mock') || 'index') : null;

const CATS_FALLBACK = [
  { id: 'profession', label: 'Profession' }, { id: 'biology', label: 'Biology' },
  { id: 'health', label: 'Health' }, { id: 'hobby', label: 'Hobby' }, { id: 'phobia', label: 'Phobia' },
  { id: 'skill', label: 'Extra skill' }, { id: 'trait', label: 'Personality' }, { id: 'baggage', label: 'Baggage' },
];
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;
const ID_KEY = 'bunker.identity';
const NAME_KEY = 'bunker.name';
const PREFS_KEY = 'bunker.b.prefs';
const GAME_PHASES = ['reveal', 'discussion', 'vote', 'defense'];
const PHASE_LABEL = { lobby: 'Lobby', reveal: 'Reveals', discussion: 'Discussion', vote: 'Vote', defense: 'Defense', final: 'Final' };
const LOG_GLYPH = { system: '::', reveal: '◆', special: '✦', vote: '▣', eject: '✖', info: '·' };
// Double-send guard: after sending a turn-advancing action (reveal, End turn, Next, Close vote, Start, Play again) those
// buttons stay disabled until the answer arrives AND at least LOCK_MS have passed, so a double click (or two quick taps)
// can never skip a speaker or close two ballots. GUARD_MS: after the turn/ballot changes, Next and Close vote stay
// disabled briefly, so a click aimed at the previous speaker or ballot never lands on the new one.
const LOCK_MS = 650;
const GUARD_MS = 350;
// A ballot this page opened itself (the host's Next into the vote or Close vote into the next ballot, a speaker's End
// my defense into the revote): on a phone its vote choices take the spot of the button just tapped, so a "did it
// work?" re-tap about a second later cast a vote. There the ballot's buttons wait VOTE_HOLD_MS instead of GUARD_MS.
const VOTE_HOLD_MS = 1100;
// Liveness (a phone that switches networks keeps a dead socket that never closes): any send expects an answer within
// ANSWER_MS, an idle socket is pinged every PING_EVERY_MS and must answer within PING_WAIT_MS, and a socket that is still
// not joined CONNECT_MS after it was opened is given up and retried.
const ANSWER_MS = 4000;
const PING_EVERY_MS = 5000;
const PING_WAIT_MS = 8000;
const WAKE_WAIT_MS = 3000;
const CONNECT_MS = 8000;
// Leaving a game or kicking a player from one is final (§6), so in play it takes a second tap within ARM_MS, and that
// tap counts only ARM_MIN_MS or more after the first: the second click of one double click never confirms.
const ARM_MS = 4000;
const ARM_MIN_MS = 450;
// Click-through guards (SPEC §11 K6). A double click whose first click closes an overlay or collapses a panel must not
// land its second click on whatever slides under the pointer (the action bar's Next, a vote, Start…): for SHIELD_MS
// every action outside an open overlay is held. Inside the special picker, the options and Play are held for
// PICK_GUARD_MS after the sheet opens or changes step, so a double click on a target never plays the card unconfirmed.
const SHIELD_MS = 500;
const PICK_GUARD_MS = 400;
const SHIELD_ACTS = new Set(['picker-confirm', 'picker-cancel', 'rules-close', 'briefing-close', 'toggle-situation', 'toggle-last', 'expand', 'board-view', 'full-text']);
// Effects whose meaning depends on which vote step they land in: a picker for one of them closes when the vote it was
// opened for ends or ejects someone (the card would silently apply to the next vote instead).
const STEP_SENSITIVE = new Set(['cancel_vote', 'double_vote']);
const BRIEF_KEY = 'bunker.briefed';
const TIMER_PRESETS = [
  { id: 'quick', label: 'Quick', hint: 'turns 20 s · talk 60 s', v: { speechSeconds1: 40, speechSeconds: 20, discussionSeconds: 60, defenseSeconds: 20 } },
  { id: 'standard', label: 'Standard', hint: 'turns 30 s · talk 90 s', v: { speechSeconds1: 60, speechSeconds: 30, discussionSeconds: 90, defenseSeconds: 30 } },
  { id: 'relaxed', label: 'Relaxed', hint: 'turns 45 s · talk 150 s', v: { speechSeconds1: 90, speechSeconds: 45, discussionSeconds: 150, defenseSeconds: 45 } },
];
const mq = (q) => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
const isConsole = () => mq('(min-width: 1180px)');   // desktop console layout: fixed-height columns, side rail
const isMatrix = () => mq('(min-width: 1024px)');    // the players x categories matrix
const isNarrow = () => mq('(max-width: 639px)');     // phones

/* ------------------------------------------------------------------ storage (never throws) */
const memStore = { session: new Map(), local: new Map() };
function backend(kind) {
  if (MOCK) {
    const m = memStore[kind];
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  }
  return kind === 'session' ? window.sessionStorage : window.localStorage;
}
function sGet(kind, key) { try { const raw = backend(kind).getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function sSet(kind, key, val) { try { backend(kind).setItem(key, JSON.stringify(val)); } catch { /* blocked storage */ } }
function sDel(kind, key) { try { backend(kind).removeItem(key); } catch { /* blocked storage */ } }
function isIdentity(x) {
  return !!x && typeof x === 'object' && typeof x.room === 'string' && CODE_RE.test(x.room) &&
    typeof x.token === 'string' && x.token.length > 0 && typeof x.id === 'string';
}

/* ------------------------------------------------------------------ app state */
let state = null;             // latest StateView (also window.__bunkerState)
let identity = null;          // {room, id, token, name}
let clockOffset = 0;          // serverNow - Date.now()
const offsetSamples = [];
const freshAt = new Map();    // "playerId:category" -> ms when the card text appeared/changed
const outAt = new Map();      // playerId -> ms when they stopped being alive (the EJECTED stamp slams in)
let lastResultSig = '';
const seenBeforeFinal = new Set();
let hadPreFinal = false;
let toastSeq = 0;

const prefs = sGet('local', PREFS_KEY) || {};
function savePrefs() { sSet('local', PREFS_KEY, prefs); }

const ui = {
  screen: 'landing',          // landing | resuming | replaced | room (lobby/game/final come from state.phase)
  landing: { name: '', room: '', invite: '' },   // invite: the code from an invite link (/?room=CODE)
  notice: null,               // {kind:'info'|'warn', text} shown on the landing page
  rejoinOffer: null,          // identity from localStorage, offered as "Rejoin as <name>"
  pending: false,             // create / join / resume in flight
  pendingName: '',
  askedSpectator: null,
  picker: null,               // {uid, targetId, category, note}
  pickerFocused: '',
  expanded: new Set(),
  showLast: null,             // null = default (open while the result is fresh), else the viewer's choice
  resultFresh: false,         // the last vote result arrived recently (open until the next discussion starts)
  toasts: [],
  copied: null, copiedAt: 0,
  inflight: null,             // {at, replied}: a turn-advancing action was just sent; blocks double sends
  voteInflight: null,         // the same for a vote (its own lock, so the host's Next / Close vote stay free)
  adminInflight: null,        // the same for the host's kick / transfer (a list that closes up can't take a 2nd click)
  stepKey: '', stepAt: 0,     // the turn/ballot key and when it last changed (GUARD_MS)
  listKey: '', listAt: 0,     // the seated/spectator ids and when that list last changed (GUARD_MS for kick/transfer)
  shieldUntil: 0,             // click-through shield (SHIELD_MS) after an overlay closed or a panel collapsed
  overlayOpenedAt: 0,         // when the picker or the rules sheet opened (its backdrop ignores the 2nd click)
  pickerStepAt: 0,            // when the picker opened or changed step (PICK_GUARD_MS)
  briefed: '',                // the game whose round-1 briefing this viewer dismissed
  armed: null,                // {what: 'leave' | 'kick:<id>', at, until}: the first tap of a two-tap Leave / Kick
  rulesOpen: false,           // the "How to play" sheet
  scrollFinal: false,         // bring the final hero into view after the next render
  mockConn: null,             // mock-only: simulate a dropped connection
  mockScenarios: null,
  situation: null,            // {room, phase, open}: the viewer's choice for the situation panel
  flash: null,                // {id, until}: briefly highlight a player row after jumping to it
  optDraft: {},               // lobby timer fields being typed in (not sent yet): the estimate follows them (X4)
  rulesOpener: '',            // the button that opened the rules sheet (a selector; the picker keeps its own)
  refocus: null,              // {q, until}: give the focus back to the button that opened a sheet closed unplayed
  voteWiped: null,            // {key, text}: the viewer's vote was wiped because its target left (SPEC §3), this ballot
  lastStepSend: null,         // {key, at}: the step this page's last Next / Close vote / End turn was aimed at
  voteHoldUntil: 0,           // a ballot this page's own tap opened: its buttons wait until then (VOTE_HOLD_MS)
};

/* ------------------------------------------------------------------ tiny DOM builder + morph */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') {
        const c = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
        if (c) el.setAttribute('class', c);
      } else if (k === 'text') el.textContent = String(v);
      else if (k === 'testid') el.setAttribute('data-testid', v);
      else if (k === 'act') el.setAttribute('data-act', v);
      else if (k === 'key') el.setAttribute('data-key', String(v));
      else if (k === 'value') { el.setAttribute('value', String(v)); el.value = String(v); }
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  addKids(el, kids);
  if (tag === 'button' && !el.hasAttribute('type')) el.setAttribute('type', 'button');
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k of Object.keys(attrs || {})) el.setAttribute(k, String(attrs[k]));
  addKids(el, kids);
  return el;
}
// The radiation trefoil: three 60° blades drawn as one dashed ring on a yellow disc (decorative).
function trefoil(cls) {
  return svg('svg', { class: 'trefoil ' + (cls || ''), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    svg('circle', { cx: 12, cy: 12, r: 11, fill: 'currentColor' }),
    svg('circle', { cx: 12, cy: 12, r: 6, fill: 'none', stroke: '#111', 'stroke-width': 6.4, 'stroke-dasharray': '6.283 6.283', transform: 'rotate(-120 12 12)' }),
    svg('circle', { cx: 12, cy: 12, r: 1.9, fill: '#111' }));
}
function addKids(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false || k === true) continue;
    if (Array.isArray(k)) addKids(el, k);
    else if (k instanceof Node) el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
}
function sameNode(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType !== 1) return true;
  return a.nodeName === b.nodeName && a.getAttribute('data-key') === b.getAttribute('data-key');
}
function morph(from, to) {
  if (!sameNode(from, to)) { from.replaceWith(to); return; }
  if (from.nodeType !== 1) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
  const fa = from.attributes;
  for (let i = fa.length - 1; i >= 0; i--) { const n = fa[i].name; if (!to.hasAttribute(n)) from.removeAttribute(n); }
  const ta = to.attributes;
  for (let i = 0; i < ta.length; i++) { const { name, value } = ta[i]; if (from.getAttribute(name) !== value) from.setAttribute(name, value); }
  if (from.nodeName === 'INPUT' || from.nodeName === 'TEXTAREA') {
    const want = to.getAttribute('value');
    if (want !== null && document.activeElement !== from && from.value !== want) from.value = want;
    return;
  }
  morphChildren(from, to);
}
function morphChildren(from, to) {
  const keyed = new Map();
  for (let n = from.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.hasAttribute('data-key')) keyed.set(n.getAttribute('data-key'), n);
  }
  let cursor = from.firstChild;
  let t = to.firstChild;
  while (t) {
    const next = t.nextSibling;
    const key = t.nodeType === 1 ? t.getAttribute('data-key') : null;
    let match = null;
    if (key !== null) { match = keyed.get(key) || null; if (match) keyed.delete(key); }
    else if (cursor && !(cursor.nodeType === 1 && cursor.hasAttribute('data-key')) && sameNode(cursor, t)) match = cursor;
    if (match) {
      if (match === cursor) cursor = cursor.nextSibling; else from.insertBefore(match, cursor);
      morph(match, t);
    } else {
      from.insertBefore(t, cursor);
    }
    t = next;
  }
  while (cursor) { const n = cursor.nextSibling; from.removeChild(cursor); cursor = n; }
}

/* ------------------------------------------------------------------ small helpers */
const pad2 = (n) => String(n).padStart(2, '0');
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
function cats(s) { return s && Array.isArray(s.categories) && s.categories.length ? s.categories : CATS_FALLBACK; }
function catLabel(s, id) { const c = cats(s).find((x) => x.id === id); return c ? c.label : id; }
function byId(s, id) { return (s && s.players.find((p) => p.id === id)) || null; }
function nameOf(s, id) {
  const p = byId(s, id) || (s.spectators || []).find((x) => x.id === id);
  return p ? p.name : 'someone';
}
function namesOf(s, ids) { return ids.map((id) => nameOf(s, id)); }
function listText(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
function hiddenCatsOf(s, p) { return cats(s).map((c) => c.id).filter((c) => p.cards[c] == null); }
function clip(t, n) { t = String(t); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; }
// The card the current speaker revealed on this turn, from the log ("Round N — <name> revealed <Label>: <text>"),
// scanning back to the start of the phase. null when there is none (or the log was cut).
function turnReveal(s, sp) {
  const log = s.log || [];
  const pre = `${s.overtime ? 'Overtime' : `Round ${s.round}`} — ${sp.name} revealed `;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.kind === 'system') break;
    if (e.kind !== 'reveal' || !e.text.startsWith(pre)) continue;
    const rest = e.text.slice(pre.length);
    const c = cats(s).find((x) => rest.startsWith(x.label + ': '));
    if (!c) return null;
    const text = sp.cards[c.id] != null ? sp.cards[c.id] : rest.slice(c.label.length + 2).replace(/ \(revealed automatically\)$/, '');
    return { cat: c.id, label: c.label, text };
  }
  return null;
}
function serverNow() { return Date.now() + clockOffset; }
function fmtClock(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${pad2(sec % 60)}`;
}
function hhmm(ts) { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
// A name is at most NAME_MAX characters as the server counts them (code points), cut only between graphemes, so an
// emoji sequence ("👨‍👩‍👧‍👦" is 7 code points) is kept whole or left out, never split into a broken glyph.
const NAME_MAX = 20;
let graphemes = null;
function capName(t) {
  if (Array.from(t).length <= NAME_MAX) return t;
  try { graphemes = graphemes || new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch { graphemes = false; }
  const parts = graphemes ? Array.from(graphemes.segment(t), (x) => x.segment) : Array.from(t);
  let out = '';
  let n = 0;
  for (const g of parts) {
    const c = Array.from(g).length;
    if (n + c > NAME_MAX) break;
    out += g;
    n += c;
  }
  return out;
}
function cleanName(v) { return capName(String(v || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).trim(); }
function cleanCode(v) { return String(v || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); }
function timerTotal(s) {
  const o = s.options || {};
  if (s.phase === 'reveal') return (s.round === 1 ? o.speechSeconds1 : o.speechSeconds) * 1000;
  if (s.phase === 'discussion') return o.discussionSeconds * 1000;
  if (s.phase === 'defense') return o.defenseSeconds * 1000;
  return 0;
}

/* ------------------------------------------------------------------ derived view model */
function derive(s) {
  const d = {};
  d.meId = s.you.id;
  d.meP = byId(s, d.meId);
  d.isPlayer = s.you.role === 'player' && !!d.meP;
  d.isSpectator = s.you.role === 'spectator';
  d.alive = d.isPlayer && d.meP.status === 'alive';
  d.isHost = !!s.you.isHost;
  d.online = MOCK ? !ui.mockConn : (conn.status === 'open' && joinedOnSocket);
  d.hostName = s.hostId ? nameOf(s, s.hostId) : '';
  d.aliveList = s.players.filter((p) => p.status === 'alive');
  d.outList = s.players.filter((p) => p.status !== 'alive');
  d.inGame = GAME_PHASES.includes(s.phase);
  const t = s.turn;
  d.turn = t;
  d.speaker = t ? byId(s, t.speakerId) : null;
  d.isSpeaker = !!t && t.speakerId === d.meId && d.alive;
  d.eligible = [];
  if (t && t.kind === 'reveal' && d.isSpeaker && s.me) {
    const base = t.mustReveal ? [t.mustReveal] : cats(s).map((c) => c.id);
    d.eligible = base.filter((c) => s.me.cards[c] && !s.me.cards[c].revealed);
  }
  // the click-through shield (SHIELD_MS after an overlay closed): every action outside the overlay is held
  d.shield = Date.now() < ui.shieldUntil;
  const free = d.online && !ui.inflight && !d.shield;
  d.canReveal = free && d.isSpeaker && t.kind === 'reveal' && !t.hasRevealed && d.eligible.length > 0;
  d.canEndTurn = free && d.isSpeaker && (t.kind === 'defense' || t.hasRevealed || d.eligible.length === 0);
  const v = s.vote;
  d.amVoter = !!v && v.voters.includes(d.meId);
  d.myVote = s.me ? s.me.myVote : null;
  d.cooling = !!ui.stepAt && Date.now() - ui.stepAt < GUARD_MS;
  // vote buttons are shown to every voter; they are enabled only while no vote is in flight and not in the first
  // GUARD_MS of a new ballot or revote (a double click on the last vote must not land on the next ballot's list)
  d.voteOpen = s.phase === 'vote' && d.amVoter;
  d.voteHold = s.phase === 'vote' && Date.now() < ui.voteHoldUntil;
  d.canVote = d.online && d.voteOpen && !d.cooling && !d.voteHold && !ui.voteInflight && !d.shield;
  d.canNext = free && d.isHost && d.inGame && !d.cooling && !d.voteHold;
  d.canClose = free && d.isHost && s.phase === 'vote' && !d.cooling && !d.voteHold;
  // kick / transfer: held while one is unanswered and for GUARD_MS after the list of players or spectators changed,
  // so a row that slides up under the pointer never takes the second click of a double click
  d.canAdmin = d.online && d.isHost && !ui.adminInflight && !d.shield && !(ui.listAt && Date.now() - ui.listAt < GUARD_MS);
  return d;
}
// §2 formula for the step of round `r` given `out` players out and `alive` alive (round 7 and overtime: alive − beds).
function formulaKicks(s, r, out, alive, cap, overtime) {
  const row = (s.schedule && s.schedule.kicksByRound) || [];
  if (r >= s.maxRounds || overtime) return Math.max(0, alive - cap);
  let cum = 0;
  for (let i = 0; i < r && i < row.length; i++) cum += Number(row[i]) || 0;
  return Math.max(0, Math.min(cum - out, alive - cap));
}
// What §2 gives right now for the current round (during a vote step: the ejections still due in it, this ballot included).
function kicksNow(s) {
  const alive = s.players.filter((p) => p.status === 'alive').length;
  return formulaKicks(s, s.round, s.players.length - alive, alive, s.capacity, s.overtime);
}
// "Vote X of Y": §2 says vote.ballots = (ballot − 1) + kicksThisStep and can only shrink (a leave, kick or Extra bunk
// mid-step). Shown from the formula as well, so a step that just shrank never promises a ballot that will not come.
function ballotsOf(s) {
  const v = s.vote;
  if (!v) return 0;
  const k = kicksNow(s);
  return Math.max(v.ballot, Math.min(v.ballots, v.ballot - 1 + Math.max(1, k)));
}
// The special's step key (SPEC §11 R1/K7): like stepAt, but without the turn index (a special does not depend on who
// is speaking), so it is refused only when the phase, round, ballot or stage moved on.
function specialAt(s) {
  const a = stepAt(s);
  delete a.turnIndex;
  return a;
}
// Which vote step a special would land in: the running one (round, overtime and how many are out: an ejection or a
// leave inside the step changes it), or null outside a step.
function voteKeyOf(s) {
  if (s.phase !== 'vote' && s.phase !== 'defense') return null;
  return [s.round, s.overtime, s.players.filter((p) => p.status !== 'alive').length].join('|');
}
function shield(ms = SHIELD_MS) {
  ui.shieldUntil = Math.max(ui.shieldUntil, Date.now() + ms);
  setTimeout(scheduleRender, ms + 20);
}
function pickerMoved() {
  ui.pickerStepAt = Date.now();
  setTimeout(scheduleRender, PICK_GUARD_MS + 20);
}
function pickerSettling() { return Date.now() - ui.pickerStepAt < PICK_GUARD_MS; }
function nextInOrder(s) {
  const t = s.turn;
  if (!t) return null;
  for (let i = t.index + 1; i < t.order.length; i++) {
    const p = byId(s, t.order[i]);
    if (p && p.status === 'alive') return p;
  }
  return null;
}
function speakerHasEligible(s, p, t) {
  const base = t.mustReveal ? [t.mustReveal] : cats(s).map((c) => c.id);
  return base.some((c) => p.cards[c] == null);
}
function orderPosition(s, d) {
  const t = s.turn;
  if (!t || !d.isPlayer) return '';
  if (!d.alive) return '';
  const i = t.order.indexOf(d.meId);
  if (i === -1) return t.kind === 'reveal' ? 'You have no turn this round.' : '';
  if (i < t.index) return t.kind === 'reveal' ? 'You already spoke this round.' : 'You already defended.';
  if (i === t.index) return '';
  let n = 0;
  for (let k = t.index + 1; k < i; k++) { const p = byId(s, t.order[k]); if (p && p.status === 'alive') n++; }
  if (t.kind === 'defense') return n === 0 ? 'You defend next.' : `You defend after ${plural(n, 'more player')}.`;
  return n === 0 ? 'You are next.' : `You speak after ${plural(n, 'more player')}.`;
}

/* ------------------------------------------------------------------ specials */
const EFFECT_INFO = {
  swap_card: 'Swap a card with another player — both become public',
  reroll_card: 'Replace a card with a freshly drawn one (revealed)',
  force_reveal: 'Force another player to reveal a hidden card',
  peek: 'Secretly look at a hidden card of another player',
  mass_reveal: 'Every alive player reveals a category',
  shuffle_category: 'Shuffle one category among all alive players',
  immunity: 'Nobody can vote against you in the next vote',
  protect: 'Nobody can vote against another player in the next vote',
  double_vote: 'Your vote counts twice in the current or next vote',
  block_vote: 'Another player cannot vote in the next vote',
  cancel_vote: 'Cancel the current or the next vote',
  eject: 'Retired one-player eject (no card deals it any more, SPEC §11 X1)',
  airlock: 'Needs a partner: a second Airlock on the same player before that round’s discussion ends throws them out',
  revive: 'Bring an ejected player back into the game',
  capacity_plus: 'The bunker gets one more bed',
  capacity_minus: 'The bunker loses one bed',
  bunker_add_feature: 'Discover a new feature of the bunker',
};
const TARGET_LABEL = { none: 'No target', self: 'Yourself', other: 'Another alive player', ejected: 'An ejected player' };

/* ------------------------------------------------------------------ airlocks (SPEC §11 X1) */
// The open airlocks: [] when none are open, and also when a server that predates X1 sends no `airlocks` at all.
function airlocksOf(s) { return s && Array.isArray(s.airlocks) ? s.airlocks : []; }
function airlockOn(s, id) { return airlocksOf(s).find((a) => a.targetId === id) || null; }
// An Airlock from the viewer on this airlock's target would close it: someone else started it this round, and it
// is not on the viewer (only this round's airlock combines; the server jams older ones anyway).
function joinsAirlock(s, a) { return !!a && a.targetId !== s.you.id && !a.byIds.includes(s.you.id) && (!a.round || a.round === s.round); }
function myAirlock(s) { return s.me ? (s.me.specials || []).find((x) => x.effect === 'airlock' && !x.used) || null : null; }
function whoName(s, id) { return id === s.you.id ? 'you' : nameOf(s, id); }
// What the viewer's Airlock would do to this player now: 'join' (close an open one), 'open' (start one), 'mine'.
function airlockKey(s, id) { const a = airlockOn(s, id); return !a ? 'open' : joinsAirlock(s, a) ? 'join' : 'mine'; }
function airlockCount(a) { return `${Math.min(2, Math.max(1, a.byIds.length))}/2`; }
// When an open airlock jams (SPEC §11 X1.2): at the end of its round's discussion, whether a vote follows or not. So
// its deadline is never "the vote": in a round without one (rounds 2–4 with 6 players) a partner who waits for the
// next vote only opens a new airlock (SPEC §11, f2).
function airEnd(s) { return s && s.overtime ? 'the overtime discussion ends' : 'this round’s discussion ends'; }
// Airlock cards not played yet: the deal (SPEC §11 X1.3, from the seated players; left and kicked ones stay listed in a
// game) minus the Airlocks in everyone's played specials, never less than the viewer's own. 0: an open airlock can no
// longer be closed by anyone, so it will jam, and nobody should be told "one more Airlock and you are out".
function airlocksLeft(s) {
  const played = s.players.reduce((n, p) => n + p.playedSpecials.filter((x) => x && x.title === 'Airlock').length, 0);
  return Math.max(myAirlock(s) ? 1 : 0, airlockDeal(s.players.length).airlocks - played);
}
function airlockStarters(s, a) { return listText(a.byIds.map((id) => whoName(s, id))) || 'someone'; }
// The Airlock picker's note when there is nothing to join. An airlock may still be cycling (on the viewer, whose own
// card can never close it), so "nobody has started one" is said only when none is open.
function airlockPickNote(s) {
  const open = airlocksOf(s).filter((a) => (byId(s, a.targetId) || {}).status === 'alive');
  const rest = `another player then has to play theirs on the same player before ${airEnd(s)}, or it jams.`;
  if (!open.length) return `Nobody has started an airlock yet. Yours opens it (1/2): ${rest}`;
  const onMe = open.find((a) => a.targetId === s.you.id);
  if (onMe) return `An airlock is cycling on you (started by ${airlockStarters(s, onMe)}), and your own card cannot close it. Yours starts a new one (1/2) on the player you pick: ${rest}`;
  return `Your card cannot close the open airlock${open.length > 1 ? 's' : ''} on ${listText(open.map((a) => nameOf(s, a.targetId)))}. Yours starts a new one (1/2) on the player you pick: ${rest}`;
}
// Airlocks the viewer can close right now with their own card (the card is playable and someone else started them).
function joinableAirlocks(s, d) {
  const card = myAirlock(s);
  if (!card || !specialStatus(s, d, card).ok) return [];
  return airlocksOf(s).filter((a) => joinsAirlock(s, a) && (byId(s, a.targetId) || {}).status === 'alive');
}

/* ------------------------------------------------------------------ special card texts (SPEC §11 X3) */
// Every title/text pair this client has seen in a state (played specials, the final's unplayed ones, the own hand),
// and nothing else: a log line never teaches a text (SPEC §11 FX1, f2). Its player's name is free text and, after Play
// again, may no longer be in the seat list the line is read against, so a line cannot vouch for a title or a text.
// Log lines, the final banner and the board look texts up here. A chip is only the title a special's own line plays,
// followed by exactly that card's known text (public/loglines.js cardLine), or the card an airlock line names.
const cardBook = new Map();   // title -> { text, strong }
let cardBookVer = 0;          // bumped when the book or the seated names change (the log's segments depend on both)
let seatNames = [];           // the seated players' names (a special's line is read from its player's name)
let seatNamesKey = '';
function learnCard(title, text, strong) {
  if (typeof title !== 'string' || !title.trim() || typeof text !== 'string' || !text.trim()) return;
  const cur = cardBook.get(title);
  if (cur && (cur.text === text || (cur.strong && !strong))) return;
  cardBook.set(title, { text, strong: !!strong });
  cardBookVer++;
}
function cardText(title) { const c = cardBook.get(title); return c ? c.text : ''; }
function strongText(title) { const c = cardBook.get(title); return c && c.strong ? c.text : ''; }
function specialLine(text) { return parseSpecialLine(text, seatNames, strongText); }
function learnFromState(s) {
  const key = s.players.map((p) => p.name).join('\u0001');
  if (key !== seatNamesKey) { seatNamesKey = key; seatNames = s.players.map((p) => p.name); cardBookVer++; }
  for (const p of s.players) {
    for (const x of p.playedSpecials) if (x) learnCard(x.title, x.text, true);
    for (const x of p.unplayedSpecials || []) if (x) learnCard(x.title, x.text, true);
  }
  if (s.me) for (const x of s.me.specials) if (x) learnCard(x.title, x.text, true);
}
// A log line (or the final banner's line) as plain runs and card chips: [{t:'text'|'dim', v} | {t:'card', title, v}].
// A special's own line: "… played [Title]: its text (dimmed) → result". An airlock line (SPEC §11 X1's exact shapes):
// the word "airlock" that names the card. Nothing else is a chip, so a name like “Census” or "Airlock" stays a name.
function textSegments(text) {
  text = String(text || '');
  const m = cardLine(text, seatNames, cardText);
  if (m) {
    const out = [{ t: 'text', v: m.head }, { t: 'card', title: m.title, v: m.title }];
    if (m.cardText) out.push({ t: 'dim', v: `: ${m.cardText}` });
    // the result part never re-chips the card just played (an Airlock line names "Airlock" again, for example)
    out.push({ t: 'text', v: ` → ${m.result}` });
    return out;
  }
  const air = cardBook.has('Airlock') ? airlockLine(text) : null;
  if (air) {
    const end = air.at + 'airlock'.length;
    return [{ t: 'text', v: text.slice(0, air.at) }, { t: 'card', title: 'Airlock', v: text.slice(air.at, end) }, { t: 'text', v: text.slice(end) }];
  }
  return [{ t: 'text', v: text }];
}
const segCache = new Map();   // text -> {ver, segs}
function segmentsOf(text) {
  const c = segCache.get(text);
  if (c && c.ver === cardBookVer) return c.segs;
  const segs = textSegments(text);
  if (segCache.size > 600) segCache.clear();
  segCache.set(text, { ver: cardBookVer, segs });
  return segs;
}
function richText(text, keyBase, kicker) { return richSegs(segmentsOf(text), keyBase, kicker); }
function richSegs(segs, keyBase, kicker) {
  return segs.map((g, i) => {
    if (g.t === 'card') return cardChip(g.title, cardText(g.title), { label: g.v, cls: 'in-text', popKey: `${keyBase}:${i}`, kicker: kicker || 'Special card' });
    if (g.t === 'dim') return h('span', { class: 'lt-card', text: g.v });
    return g.v;
  });
}
// A special card's title as a chip: hover (mouse), focus (keyboard) or tap (touch) shows its rules text in a popover
// (SPEC §11 X3). Without a known text it is just the title. o: {label, cls, key (morph key), popKey (re-anchoring),
// kicker, meta, icon}
function cardChip(title, text, o = {}) {
  if (!text) return h('span', { class: ['card-title-plain', o.cls], key: o.key, text: o.label || title });
  return h('button', {
    class: ['card-chip', o.cls], key: o.key, testid: 'card-chip', 'data-title': title, 'data-pop': 'card',
    'data-pop-title': title, 'data-pop-text': text, 'data-pop-kicker': o.kicker || null, 'data-pop-meta': o.meta || null,
    'data-pop-key': o.popKey || null,
  }, o.icon === false ? null : icon('spark', 'cc-ico'), h('span', { class: 'cc-t', text: o.label || title }));
}
function specialMeta(s, sp) {
  const parts = [`Target: ${TARGET_LABEL[sp.target] || sp.target}`];
  if (sp.category === 'choose') parts.push('Category: you choose');
  else if (sp.category === 'random') parts.push('Category: random hidden');
  else if (sp.category) parts.push(`Category: ${catLabel(s, sp.category)}`);
  parts.push(sp.timing === 'before_vote' ? 'Before the vote' : 'Any time in play');
  if (sp.minRound > 1) parts.push(`From round ${sp.minRound}`);
  return parts.join(' · ');
}
function validTargets(s, sp) {
  const meId = s.you.id;
  if (sp.target === 'other') {
    const needHidden = sp.effect === 'force_reveal' || sp.effect === 'peek';
    return s.players.filter((p) => p.id !== meId && p.status === 'alive' && (!needHidden || hiddenCatsOf(s, p).length > 0));
  }
  if (sp.target === 'ejected') return s.players.filter((p) => p.status === 'ejected');
  return [];
}
function allowedCats(s, sp, targetId) {
  if (sp.category !== 'choose') return [];
  if (sp.effect === 'force_reveal' || sp.effect === 'peek') {
    const t = byId(s, targetId);
    return t ? hiddenCatsOf(s, t) : [];
  }
  return cats(s).map((c) => c.id);
}
function specialStatus(s, d, sp) {
  if (sp.used) return { ok: false, why: 'Already played' };
  if (s.phase === 'final') return { ok: false, why: 'The game is over' };
  if (!GAME_PHASES.includes(s.phase)) return { ok: false, why: 'Not in this phase' };
  if (!d.meP || d.meP.status !== 'alive') return { ok: false, why: 'Only players still in the game can play specials' };
  if (!s.me.canPlaySpecial) return { ok: false, why: 'One special per round — you already played one' };
  if (s.round < (sp.minRound || 1)) return { ok: false, why: `Playable from round ${sp.minRound}` };
  if (sp.timing === 'before_vote' && s.phase !== 'reveal' && s.phase !== 'discussion') {
    return { ok: false, why: 'Only before the vote (reveals or discussion)' };
  }
  if (sp.effect === 'cancel_vote' && s.phase !== 'vote' && s.phase !== 'defense' && s.voteMods.cancelNext) {
    return { ok: false, why: 'The next vote is already cancelled' };
  }
  // SPEC §11 Z3: a ×2 needs a vote to double. A vote block lasts the whole vote step, and a player who is not a voter
  // of the open ballot stays out of the rest of the step, so the card would be spent for nothing.
  if (sp.effect === 'double_vote') {
    const inStep = s.phase === 'vote' || s.phase === 'defense';
    if (s.voteMods.blocked.includes(d.meId)) return { ok: false, why: `Your vote is blocked in ${inStep ? 'this' : 'the next'} vote, so ×2 would do nothing` };
    if (s.phase === 'vote' && s.vote && !s.vote.voters.includes(d.meId)) return { ok: false, why: 'You have no vote in this ballot, so ×2 would do nothing' };
  }
  if ((sp.target === 'other' || sp.target === 'ejected') && validTargets(s, sp).length === 0) {
    return { ok: false, why: sp.target === 'ejected' ? 'Nobody has been ejected' : 'No valid target right now' };
  }
  if (!d.online) return { ok: false, why: 'Offline — reconnecting' };
  return { ok: true, why: '' };
}
function describePlay(s, sp, target, cat) {
  const tn = target ? target.name : 'the target';
  const cl = cat ? catLabel(s, cat) : (sp.category && sp.category !== 'choose' && sp.category !== 'random' ? catLabel(s, sp.category) : null);
  const inStep = s.phase === 'vote' || s.phase === 'defense';
  switch (sp.effect) {
    case 'swap_card': return `Swap your ${cl} with ${tn}'s ${cl}. Both cards become public.`;
    case 'reroll_card': return sp.target === 'self'
      ? `Replace your ${cl} with a freshly drawn card. The new card is revealed to everyone.`
      : `Replace ${tn}'s ${cl} with a freshly drawn card. The new card is revealed to everyone.`;
    case 'force_reveal': return cl ? `${tn} must reveal their ${cl} to everyone.` : `${tn} must reveal a random hidden card to everyone.`;
    case 'peek': return cl ? `You secretly see ${tn}'s ${cl}. Only you get the result, under Private intel.` : `You secretly see a random hidden card of ${tn}. Only you get the result, under Private intel.`;
    case 'mass_reveal': return `Every alive player's ${cl} becomes public.`;
    case 'shuffle_category': return `Everyone's ${cl} is collected, shuffled and dealt back. All of them become public.`;
    case 'immunity': return 'Nobody can vote against you during the next vote (a cancelled vote uses it up too).';
    case 'protect': return `Nobody can vote against ${tn} during the next vote (a cancelled vote uses it up too).`;
    case 'double_vote': return inStep ? 'Your vote counts twice in this vote.' : 'Your vote counts twice in the next vote (a cancelled vote uses it up too).';
    case 'block_vote': return `${tn} cannot vote during the next vote (a cancelled vote uses it up too).`;
    case 'cancel_vote': return inStep ? 'The rest of this vote is cancelled right now. Nobody else is ejected in it.' : 'The next vote is cancelled.';
    case 'eject': return `${tn} is ejected from the bunker immediately.`;
    case 'airlock': {
      const a = target ? airlockOn(s, target.id) : null;
      if (a && joinsAirlock(s, a)) return `${tn} is thrown out of the bunker right now, with no vote: you close the airlock ${listText(namesOf(s, a.byIds))} started.`;
      return `You start cycling the airlock on ${tn}. If another player plays an Airlock on ${tn} before ${airEnd(s)}, ${tn} is out, with no vote. If nobody does, it jams then.${airlocksLeft(s) <= 1 ? ' Yours is the last Airlock in this game, so nobody can close it: it will jam.' : ''}`;
    }
    case 'revive': return `${tn} comes back from the forest and is in the game again.`;
    case 'capacity_plus': return 'The bunker gets one more bed.';
    case 'capacity_minus': return 'The bunker loses one bed.';
    case 'bunker_add_feature': return 'A new feature of the bunker is discovered.';
    default: return 'Play this card.';
  }
}
function pickerSteps(sp) {
  const steps = [];
  if (sp.target === 'other' || sp.target === 'ejected') steps.push('target');
  if (sp.category === 'choose') steps.push('category');
  steps.push('confirm');
  return steps;
}
function pickerStep(sp, p) {
  if ((sp.target === 'other' || sp.target === 'ejected') && !p.targetId) return 'target';
  if (sp.category === 'choose' && !p.category) return 'category';
  return 'confirm';
}
// The target step's list as the picker shows it: the valid targets, with an Airlock's "join" targets first and marked
// (SPEC §11 X1.7), and its key (the order and the marks), so a list that moves under the pointer can be held.
function pickerTargets(s, sp) {
  let list = validTargets(s, sp);
  // the "join" targets in the order their airlocks opened, as the alert, the bar and the card's hint list them
  const joinIds = sp.effect === 'airlock' ? airlocksOf(s).filter((a) => joinsAirlock(s, a) && list.some((t) => t.id === a.targetId)).map((a) => a.targetId) : [];
  if (joinIds.length) list = [...joinIds.map((id) => list.find((t) => t.id === id)), ...list.filter((t) => !joinIds.includes(t.id))];
  return { list, joinIds, key: list.map((t) => (joinIds.includes(t.id) ? '+' : '') + t.id).join(',') };
}
// Records what the player sees as they aim the card (on open, on a pick, on Back): the target list, and what an Airlock
// does to the chosen target. The next state is compared with exactly this, so the first state that changes it (an
// airlock opening on that target right after the pick, say) already gets its note and its hold (SPEC §11 FC1/FX2).
function pickerSaw(p, sp) {
  if (!p || !sp || !state) return;
  if (sp.target === 'other' || sp.target === 'ejected') p.listKey = pickerTargets(state, sp).key;
  if (sp.effect === 'airlock') { p.airFor = p.targetId; p.airKey = p.targetId ? airlockKey(state, p.targetId) : ''; }
}
function validatePicker() {
  const p = ui.picker;
  if (!p) return;
  if (!state || !state.me) { ui.picker = null; return; }
  const sp = state.me.specials.find((x) => x.uid === p.uid);
  const d = derive(state);
  const note0 = p.note;
  // (a sheet that closes by itself also shields: a tap aimed at its Play must not land on the bar under it)
  if (!sp || !specialStatus(state, d, sp).ok) {
    closeOverlay();
    shield();
    if (sp && !sp.used && d.online) toast('info', 'special', `${sp.title} can't be played right now.`);
    return;
  }
  // The vote this card was opened for is over (or ejected someone): "cancel the rest of this vote" would now cancel
  // the NEXT vote, "×2 in this vote" would count in the next one. Close it and say why, instead of letting a Play
  // aimed at this vote land on the next one.
  const vk = voteKeyOf(state);
  if (p.voteKey === undefined) p.voteKey = vk;
  else if (vk !== p.voteKey) {
    if (p.voteKey !== null && STEP_SENSITIVE.has(sp.effect)) {
      closeOverlay();
      shield();
      toast('info', 'special', `The vote moved on before you played “${sp.title}”, so it was not played. It is still in your hand.`);
      return;
    }
    p.voteKey = vk;
  }
  if (p.targetId && !validTargets(state, sp).some((t) => t.id === p.targetId)) {
    p.targetId = null; p.category = null; p.note = 'That target is no longer valid — pick again.';
    pickerMoved();
  }
  // An Airlock's meaning depends on the target's airlock (SPEC §11 X1): when one opens on the chosen target, or the
  // one it was going to close jams, say so and hold Play briefly (a click aimed at the old meaning must not land).
  if (sp.effect === 'airlock') {
    const ak = p.targetId ? airlockKey(state, p.targetId) : '';
    if (p.targetId && p.airFor === p.targetId && ak !== p.airKey) {
      const tn = nameOf(state, p.targetId);
      p.note = ak === 'join'
        ? `An airlock was just started on ${tn}: playing now throws ${tn} out, with no vote.`
        : `The airlock on ${tn} is no longer open: playing now starts a new one.`;
      pickerMoved();
    }
    p.airKey = ak;
    p.airFor = p.targetId;
  }
  // On the target step, options that move (an airlock opens and its target jumps to the front, a player leaves or comes
  // back) are held like a new step, so a tap aimed at one option never lands on the one that slid under it.
  if ((sp.target === 'other' || sp.target === 'ejected') && pickerStep(sp, p) === 'target') {
    const { key, joinIds, list } = pickerTargets(state, sp);
    if (p.listKey !== undefined && key !== p.listKey) {
      const before = p.listKey.split(',').filter((x) => x.startsWith('+')).map((x) => x.slice(1));
      const fresh = joinIds.filter((id) => !before.includes(id));
      const gone = before.filter((id) => !joinIds.includes(id) && list.some((t) => t.id === id));
      // (unless this state already explained itself above: the chosen target is gone)
      if (p.note === note0) {
        if (fresh.length) p.note = `An airlock was just started on ${listText(fresh.map((id) => nameOf(state, id)))}: ${fresh.length === 1 ? 'that player is' : 'they are'} now listed first. Picking one of them throws them out, with no vote.`;
        else if (gone.length) p.note = `The airlock on ${listText(gone.map((id) => nameOf(state, id)))} is no longer open.`;
      }
      pickerMoved();
    }
    p.listKey = key;
  }
  if (p.category && sp.category === 'choose' && !allowedCats(state, sp, p.targetId).includes(p.category)) {
    p.category = null; p.note = 'That category is no longer available — pick again.';
    pickerMoved();
  }
}

/* ------------------------------------------------------------------ connection */
// probeAt: when the oldest unanswered send or ping went out (0 = nothing unanswered); probeBy: when an answer is due;
// probeWhy: 'action' (a user's move is waiting for its answer), 'keepalive' or 'wake'.
// why: 'busy' when the last attempt was refused with server_busy (said in the banner), else ''.
const conn = { status: 'idle', attempt: 0, timer: 0, nextAt: 0, lastMsgAt: 0, openedAt: 0, probeAt: 0, probeBy: 0, probeWhy: '', why: '' };
let ws = null;
let wsGen = 0;
let hello = null;
let joinedOnSocket = false;
let resumeInFlight = false;
let stopped = false;          // after `replaced`: never reconnect by ourselves

function wsUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'; }
function dropSocket() {
  joinedOnSocket = false;
  conn.probeAt = 0; conn.probeBy = 0; conn.probeWhy = '';
  if (ws) { const s = ws; ws = null; wsGen++; try { s.close(); } catch { /* ignore */ } }
}
function openSocket(first) {
  clearTimeout(conn.timer); conn.timer = 0; conn.nextAt = 0;
  dropSocket();
  hello = first || null;
  let sock;
  try { sock = new WebSocket(wsUrl()); } catch { onSocketGone(); return; }
  const gen = ++wsGen;
  ws = sock;
  conn.status = 'connecting';
  conn.openedAt = Date.now();
  // a socket that does not open in time (packets lost while it was being set up) is retried, instead of sitting in
  // "Reconnecting…" until the browser gives up on it minutes later; its hello then has CONNECT_MS to be answered
  setTimeout(() => { if (gen === wsGen && ws === sock && sock.readyState === 0) socketDead(); }, CONNECT_MS);
  sock.onopen = () => {
    if (gen !== wsGen) return;
    conn.status = 'open';
    conn.lastMsgAt = Date.now();
    if (hello) { sendHello(sock, hello); hello = null; }
    scheduleRender();
  };
  sock.onmessage = (ev) => {
    if (gen !== wsGen) return;
    conn.lastMsgAt = Date.now();
    conn.probeAt = 0; conn.probeBy = 0; conn.probeWhy = '';
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m && typeof m === 'object') onMessage(m);
  };
  sock.onclose = () => {
    if (gen !== wsGen) return;
    ws = null; joinedOnSocket = false;
    onSocketGone();
  };
  sock.onerror = () => { /* a close event follows */ };
  scheduleRender();
}
// The socket is dead but may never say so (a silent network switch leaves it "open", and a close handshake can hang
// for a minute): detach it now and reconnect, rather than waiting for its close event.
function socketDead() {
  if (!ws) return;
  const why = conn.probeWhy;
  dropSocket();
  if (why === 'action' && identity) toast('error', 'offline', 'No answer from the server — reconnecting. Check that your move went through.');
  onSocketGone();
}
// create / join / resume: `joined` (or an error) must come back within CONNECT_MS
function sendHello(sock, msg) {
  resumeInFlight = msg.t === 'resume';
  try { sock.send(JSON.stringify(msg)); } catch { socketDead(); return; }
  probe(CONNECT_MS, 'hello');
}
// Expect an answer (any message) within `ms`: the server answers every action with a state or an error, a hello with
// `joined` or an error, and a ping with a pong. Nothing by then means the connection is gone.
function probe(ms, why) {
  if (!ws || ws.readyState !== 1) return;
  const now = Date.now();
  if (why === 'keepalive' || why === 'wake') { try { ws.send('{"t":"ping"}'); } catch { /* the check below notices */ } }
  if (!conn.probeAt) { conn.probeAt = now; conn.probeBy = now + ms; conn.probeWhy = why; }
  else {
    conn.probeBy = Math.min(conn.probeBy, now + ms);
    if (why === 'action') conn.probeWhy = 'action';
  }
  const gen = wsGen;
  setTimeout(() => { if (gen === wsGen) checkLiveness(); }, ms + 20);
}
function checkLiveness() {
  if (!ws || !conn.probeAt) return;
  if (Date.now() >= conn.probeBy) socketDead();
}
function onSocketGone() {
  resumeInFlight = false;
  conn.why = '';
  ui.inflight = null;
  ui.voteInflight = null;
  ui.adminInflight = null;
  if (stopped) { conn.status = 'idle'; scheduleRender(); return; }
  if (identity) scheduleReconnect();
  else {
    conn.status = 'idle';
    if (ui.pending) {
      ui.pending = false;
      toast('error', 'offline', 'Could not reach the game server. Check the address and try again.');
    }
  }
  scheduleRender();
}
function scheduleReconnect() {
  const base = Math.min(10000, 600 * Math.pow(2, conn.attempt));
  const delay = Math.round(base * (0.75 + Math.random() * 0.5));
  conn.attempt++;
  conn.status = 'waiting';
  conn.nextAt = Date.now() + delay;
  clearTimeout(conn.timer);
  conn.timer = setTimeout(reconnectNow, delay);
}
function reconnectNow() {
  if (!identity || stopped) return;
  openSocket({ t: 'resume', room: identity.room, token: identity.token });
}
function send(msg) {
  if (MOCK) { mockSend(msg); return true; }
  if (ws && ws.readyState === 1 && joinedOnSocket) {
    try { ws.send(JSON.stringify(msg)); } catch { socketDead(); return false; }
    if (msg.t !== 'leave') probe(ANSWER_MS, 'action');
    return true;
  }
  // "open" but the socket is closing or gone: make the "reconnecting" below true
  if (ws && ws.readyState !== 1 && conn.status === 'open') socketDead();
  else if (!ws && identity && conn.status !== 'waiting' && conn.status !== 'connecting' && !stopped) onSocketGone();
  toast('error', 'offline', 'Not connected — reconnecting. Try again in a moment.');
  return false;
}
function lockSend(msg, slot) {
  if (!send(msg)) return;
  const token = { at: Date.now(), replied: false };
  ui[slot] = token;
  setTimeout(() => { if (ui[slot] === token && token.replied) { ui[slot] = null; scheduleRender(); } }, LOCK_MS + 10);
  setTimeout(() => { if (ui[slot] === token) { ui[slot] = null; scheduleRender(); } }, ANSWER_MS + 250);
}
function sendTurnAction(msg) {
  if (msg.t === 'next' || msg.t === 'closeVote' || msg.t === 'endTurn') ui.lastStepSend = { key: ui.stepKey, at: Date.now() };
  lockSend(msg, 'inflight');
}
function sendVote(msg) { lockSend(msg, 'voteInflight'); }
function sendAdmin(msg) { lockSend(msg, 'adminInflight'); }
// A state answered the action: release the lock once LOCK_MS have passed since the send (the timer above does it).
function answerInflight() {
  for (const slot of ['inflight', 'voteInflight', 'adminInflight']) {
    const t = ui[slot];
    if (!t) continue;
    t.replied = true;
    if (Date.now() - t.at >= LOCK_MS) ui[slot] = null;
  }
}
// SPEC §11 R1: the step a click was aimed at, taken from the state it was made on. The server rejects the action
// (wrong_phase) when that turn or ballot is already over, so an End turn / vote and the host's Next / Close vote that
// cross in flight can never both land (the second one would hit the next speaker or ballot).
function stepAt(s) {
  return {
    phase: s.phase, round: s.round, overtime: !!s.overtime,
    turnIndex: s.turn ? s.turn.index : null, ballot: s.vote ? s.vote.ballot : null, stage: s.vote ? s.vote.stage : null,
  };
}
function stepKeyOf(s) {
  const t = s.turn;
  const v = s.vote;
  return [s.room, s.phase, s.round, s.overtime, t && t.kind, t && t.index, v && v.ballot, v && v.stage].join('|');
}
function connectWith(msg) {
  ui.notice = null;
  if (MOCK) { mockSend(msg); return; }
  stopped = false;
  ui.pending = true;
  if (ws && ws.readyState === 1 && !joinedOnSocket) sendHello(ws, msg);
  else openSocket(msg);
}
function saveIdentity() { if (!identity) return; sSet('session', ID_KEY, identity); sSet('local', ID_KEY, identity); }
function clearIdentity() {
  identity = null;
  sDel('session', ID_KEY); sDel('local', ID_KEY);
  ui.rejoinOffer = null;
}
function setUrlRoom(room) {
  if (MOCK) return;
  try {
    const u = new URL(location.href);
    if (room) u.searchParams.set('room', room); else u.searchParams.delete('room');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  } catch { /* ignore */ }
}
function resetToLanding(notice) {
  state = null;
  window.__bunkerState = null;
  ui.screen = 'landing';
  ui.picker = null;
  ui.pending = false;
  ui.inflight = null;
  ui.voteInflight = null;
  ui.adminInflight = null;
  ui.armed = null;
  ui.rulesOpen = false;
  ui.landing.invite = '';
  ui.expanded.clear();
  ui.notice = notice || null;
  const local = sGet('local', ID_KEY);
  ui.rejoinOffer = isIdentity(local) ? local : null;
}

function onMessage(m) {
  switch (m.t) {
    case 'joined': {
      if (typeof m.room !== 'string' || typeof m.token !== 'string' || typeof m.id !== 'string') break;
      const same = !!identity && identity.id === m.id && identity.room === m.room;
      const prevName = same ? identity.name : '';
      identity = { room: m.room, id: m.id, token: m.token, name: ui.pendingName || prevName || '', wasHost: same && !!identity.wasHost };
      ui.pendingName = '';
      saveIdentity();
      joinedOnSocket = true;
      resumeInFlight = false;
      ui.pending = false;
      conn.attempt = 0;
      conn.why = '';
      if (ui.screen !== 'replaced') ui.screen = 'room';
      setUrlRoom(m.room);
      break;
    }
    case 'state': {
      const { t, ...sv } = m;
      onState(sv);
      break;
    }
    case 'error': onError(m); break;
    case 'kicked': {
      const room = identity ? identity.room : '';
      clearIdentity();
      dropSocket();
      conn.status = 'idle';
      const reason = typeof m.reason === 'string' && m.reason.trim() ? m.reason.trim().replace(/\.$/, '') : '';
      resetToLanding({ kind: 'warn', text: reason ? `${reason} (room ${room}).` : `The host removed you from room ${room}.` });
      break;
    }
    default: break;
  }
  scheduleRender();
}
function onError(m) {
  const code = typeof m.code === 'string' && m.code ? m.code : 'error';
  const message = typeof m.message === 'string' && m.message ? m.message : 'Something went wrong.';
  ui.inflight = null;
  ui.voteInflight = null;
  ui.adminInflight = null;
  if (code === 'replaced') {
    stopped = true;
    dropSocket();
    conn.status = 'idle';
    ui.screen = 'replaced';
    ui.picker = null;
    toast('error', code, message);
    return;
  }
  if (resumeInFlight && (code === 'bad_token' || code === 'no_room')) {
    resumeInFlight = false;
    const room = identity ? identity.room : '';
    clearIdentity();
    dropSocket();
    conn.status = 'idle';
    // a room that is gone must not come back as an invite on the next reload (the URL still has its ?room=)
    if (code === 'no_room') { setUrlRoom(null); ui.landing.room = ''; }
    resetToLanding({
      kind: 'warn',
      text: code === 'no_room'
        ? `Room ${room} no longer exists (games are lost when the server restarts). Create or join a new game.`
        : `Your seat in room ${room} is no longer valid. Join again with the form.`,
    });
    toast('error', code, message);
    return;
  }
  // Any other answer to a resume is not about the seat: `server_busy` (too many wrong room codes from this network,
  // SPEC §11 V2; the budget refills) or something unexpected. The seat is still ours, so this is a failed connection
  // attempt like any other: drop the socket, show the banner and retry with backoff. Left alone, the socket would stay
  // open and unjoined forever (its pongs keep it alive), with no banner and the seat offline on the server.
  if (resumeInFlight) {
    resumeInFlight = false;
    ui.pending = false;
    dropSocket();
    onSocketGone();
    conn.why = code === 'server_busy' ? 'busy' : '';
    if (code !== 'server_busy') toast('error', code, message);
    return;
  }
  // an invite link to a room that is gone (an old link, or the server restarted): stop inviting to it
  if (code === 'no_room' && ui.pending && ui.screen === 'landing' && ui.landing.invite) {
    const room = ui.landing.invite;
    ui.landing.invite = '';
    ui.landing.room = '';
    setUrlRoom(null);
    if (ui.rejoinOffer && ui.rejoinOffer.room === room) { sDel('local', ID_KEY); ui.rejoinOffer = null; }
    ui.notice = { kind: 'warn', text: `Room ${room} does not exist any more (an old link, or the server was restarted: games are lost then). Ask the host for a new link, or start a game of your own.` };
  }
  ui.pending = false;
  toast('error', code, message);
}
// Fill defaults for anything optional or missing so a surprising StateView can never break rendering.
function normalize(s) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  s.players = arr(s.players).filter((p) => p && typeof p === 'object' && typeof p.id === 'string');
  for (const p of s.players) {
    p.name = typeof p.name === 'string' ? p.name : '?';
    p.cards = p.cards && typeof p.cards === 'object' ? p.cards : {};
    p.playedSpecials = arr(p.playedSpecials);
    if (p.unplayedSpecials !== undefined) p.unplayedSpecials = arr(p.unplayedSpecials);
    p.revealedCount = Number(p.revealedCount) || 0;
    p.seat = Number(p.seat) || 0;
    p.status = p.status || 'alive';
    p.connected = p.connected !== false;
  }
  s.spectators = arr(s.spectators);
  s.log = arr(s.log);
  s.categories = arr(s.categories).length ? s.categories : CATS_FALLBACK;
  s.options = { speechSeconds1: 60, speechSeconds: 30, discussionSeconds: 90, defenseSeconds: 30, ...(s.options || {}) };
  s.schedule = { kicksByRound: [], outCount: 0, kicksThisStep: 0, nextVoteRound: null, ...(s.schedule || {}) };
  s.schedule.kicksByRound = arr(s.schedule.kicksByRound);
  const vm = s.voteMods || {};
  s.voteMods = { immune: arr(vm.immune), blocked: arr(vm.blocked), doubleVote: arr(vm.doubleVote), cancelNext: !!vm.cancelNext };
  s.maxRounds = s.maxRounds || 7;
  s.maxPlayers = s.maxPlayers || 16;
  s.minPlayers = s.minPlayers || 4;
  s.round = Number(s.round) || 0;
  s.capacity = Number(s.capacity) || 0;
  if (s.turn) s.turn.order = arr(s.turn.order);
  if (s.vote) { s.vote.candidates = arr(s.vote.candidates); s.vote.voters = arr(s.vote.voters); s.vote.voted = arr(s.vote.voted); }
  if (s.lastVoteResult) { s.lastVoteResult.tally = arr(s.lastVoteResult.tally); for (const t of s.lastVoteResult.tally) t.voterIds = arr(t.voterIds); }
  if (s.final) { s.final.survivors = arr(s.final.survivors); s.final.out = arr(s.final.out); }
  // SPEC §11 X1.5 (absent from a server that predates it: left absent, airlocksOf() reads it as [])
  if (s.airlocks !== undefined) {
    s.airlocks = arr(s.airlocks).filter((a) => a && typeof a === 'object' && typeof a.targetId === 'string')
      .map((a) => ({ targetId: a.targetId, byIds: arr(a.byIds).filter((x) => typeof x === 'string'), round: Number(a.round) || 0 }));
  }
  if (s.me) {
    s.me.cards = s.me.cards || {};
    s.me.specials = arr(s.me.specials);
    s.me.notes = arr(s.me.notes);
  }
  return s;
}
function onState(s) {
  if (!s || typeof s !== 'object' || !s.you || !Array.isArray(s.players)) return;
  normalize(s);
  if (ui.screen === 'replaced') return;
  const prev = state;
  learnFromState(s);
  // lobby timer drafts (X4): the server's value wins once it changed, except in the field being typed in
  if (prev && prev.room === s.room) {
    for (const k of Object.keys(ui.optDraft)) {
      const el = document.activeElement;
      const typing = el instanceof HTMLInputElement && el.getAttribute('data-field') === 'opt:' + k;
      if (!typing || s.phase !== 'lobby') delete ui.optDraft[k];
    }
  } else ui.optDraft = {};
  if (typeof s.serverNow === 'number') {
    offsetSamples.push(s.serverNow - Date.now());
    if (offsetSamples.length > 12) offsetSamples.shift();
    clockOffset = Math.max(...offsetSamples);   // each sample under-estimates by the one-way latency
  }
  trackChanges(prev, s);
  announce(prev, s);
  // the game just ended: bring the final hero into view (a phone player may be scrolled down to their hand)
  if (prev && prev.room === s.room && prev.phase !== 'final' && s.phase === 'final') ui.scrollFinal = true;
  if (ui.askedSpectator === false && s.you.role === 'spectator' && (!prev || prev.room !== s.room)) {
    toast('info', 'spectator', 'That game has already started (or is full), so you joined as a spectator.');
  }
  ui.askedSpectator = null;
  state = s;
  window.__bunkerState = s;
  answerInflight();
  const key = stepKeyOf(s);
  if (key !== ui.stepKey) {
    const hadKey = !!ui.stepKey && !!prev && prev.room === s.room;
    // a ballot that follows right on the step this page's own Next / Close vote / End turn was aimed at: this page
    // opened it, and the finger that did it may tap that spot again (VOTE_HOLD_MS)
    const own = hadKey && s.phase === 'vote' && !!ui.lastStepSend && ui.lastStepSend.key === ui.stepKey && Date.now() - ui.lastStepSend.at < ANSWER_MS;
    ui.stepKey = key;
    ui.stepAt = hadKey ? Date.now() : 0;
    ui.voteHoldUntil = own ? Date.now() + VOTE_HOLD_MS : 0;
    if (hadKey) setTimeout(scheduleRender, GUARD_MS + 20);
    if (own) setTimeout(scheduleRender, VOTE_HOLD_MS + 20);
  }
  const lk = [s.room, s.players.map((p) => p.id).join(','), (s.spectators || []).map((x) => x.id).join(',')].join('|');
  if (lk !== ui.listKey) {
    const hadList = !!ui.listKey && !!prev && prev.room === s.room;
    ui.listKey = lk;
    ui.listAt = hadList ? Date.now() : 0;
    if (hadList) setTimeout(scheduleRender, GUARD_MS + 20);
  }
  if (ui.screen !== 'replaced') ui.screen = 'room';
  if (identity && s.you && s.you.name && identity.name !== s.you.name) { identity.name = s.you.name; saveIdentity(); }
  // back in a fresh tab (or after a reload) and no longer the host: say who is and why (on a live page the log line
  // itself is flashed by announce())
  if (identity && s.you && identity.id === s.you.id && (!prev || prev.room !== s.room)) {
    if (identity.wasHost && !s.you.isHost && s.phase !== 'final') {
      const e = s.log.slice().reverse().find((x) => x.kind === 'info' && / is now the host$/.test(x.text));
      toast('info', 'host', e ? `${flashText(e)}. You are no longer the host.` : `${s.hostId ? nameOf(s, s.hostId) : 'Nobody'} is the host now.`);
    }
  }
  if (identity && s.you && identity.id === s.you.id && !!identity.wasHost !== !!s.you.isHost) { identity.wasHost = !!s.you.isHost; saveIdentity(); }
  if (s.phase === 'lobby') { ui.picker = null; freshAt.clear(); }
  if (ui.armed && ui.armed.what.startsWith('kick:') && !byId(s, ui.armed.what.slice(5)) && !(s.spectators || []).some((x) => 'kick:' + x.id === ui.armed.what)) ui.armed = null;
  if (ui.armed && ui.armed.what === 'end-game' && (!s.you.isHost || !GAME_PHASES.includes(s.phase))) ui.armed = null;
  for (const id of ui.expanded) if (!byId(s, id)) ui.expanded.delete(id);
  validatePicker();
  scheduleRender();
}
// Surface the big public events (specials, ejections) and "your turn" beyond the log.
function announce(prev, next) {
  if (ui.quiet || !prev || prev.room !== next.room || !Array.isArray(next.log)) return;
  const lastId = prev.log && prev.log.length ? prev.log[prev.log.length - 1].id : 0;
  // A player who leaves or is kicked in the middle of a game is out for good (§6), and the votes cast for them are
  // wiped (§3): that is flashed like an ejection, not left to the log (SPEC §11, f2). Only the exact line shapes of a
  // listed player count (public/loglines.js), never a name that happens to read "… left the game".
  const names = [...new Set([...prev.players, ...next.players].map((p) => p.name))];
  const inGame = GAME_PHASES.includes(next.phase);
  const leaves = inGame ? next.log.filter((e) => e.id > lastId && isLeaveLine(e, names) && !e.text.startsWith(`${next.you.name} `)) : [];
  // The viewer's vote went to a player who just left: §3 wiped it, and the ballot waits for them again (or the host's
  // Close vote counts them as abstaining). Say why, here and in the bar (ui.voteWiped), instead of a silent re-prompt.
  const wiped = voteWipe(prev, next, leaves);
  ui.voteWiped = wiped ? { key: ballotKey(next), text: wiped.text } : ui.voteWiped && ui.voteWiped.key === ballotKey(next) && !(next.me && next.me.myVote) ? ui.voteWiped : null;
  const fresh = next.log.filter((e) => e.id > lastId && (e.kind === 'special' || e.kind === 'eject' || (leaves.includes(e) && !(wiped && wiped.line === e))));
  // the host role moved (handed over, or passed on after 45 s offline): flashed to everyone with its reason, and the
  // new host is told what it means for them (a returning ex-host sees the same line, so they know why)
  const hostNews = next.log.filter((e) => e.id > lastId && e.kind === 'info' && / is now the host$/.test(e.text)).pop();
  // the move that ends the game is told by the final banner itself: no flash over it
  if (next.phase !== 'final') {
    // an airlock line (SPEC §11 X1's exact shapes, never a 🚪 in a name) gets its own kicker
    // the last Airlock of the game was just played: an earlier "one more Airlock … is out" flash is no longer true
    const spent = airlocksLeft(next) === 0;
    if (spent) ui.toasts = ui.toasts.filter((t) => !t.threat);
    // (phones keep one flash at a time, desktops two: the vote note below comes last, so it is the one that stays)
    for (const e of fresh.slice(isNarrow() ? -1 : -2)) {
      const air = airlockLine(e.text, e.kind);
      let text = flashText(e);
      // the last Airlock of the game just opened one: nobody is left to close it, so it is no threat (SPEC §11, f2)
      if (air && air.kind === 'start' && spent) text = `🚪 ${air.by} started cycling the airlock on ${air.target}. That was the last Airlock in the game, so nobody can close it: it jams when ${airEnd(next)}.`;
      toast('info', leaves.includes(e) ? 'leave' : e.kind, text, { air: !!air, threat: !!air && air.kind === 'start' && !spent });
    }
    if (wiped) toast('info', 'vote', wiped.text);
    // SPEC §11 X6: the host ended the game mid-way: everyone lands in the lobby, and is told why
    if (GAME_PHASES.includes(prev.phase) && next.phase === 'lobby' && next.log.some((e) => e.id > lastId && isEndGameLine(e))) {
      const host = next.hostId ? nameOf(next, next.hostId) : 'The host';
      toast('info', 'ended', next.you.isHost ? 'You ended the game. Late arrivals can take a seat now.'
        : next.you.role === 'spectator' ? `${host} ended the game. You can take a seat now.`
          : `${host} ended the game. Back to the lobby, same seats.`);
    }
    if (hostNews) {
      const who = next.players.find((p) => hostNews.text.endsWith(` — ${p.name} is now the host`));
      const why = who ? hostNews.text.slice(0, -` — ${who.name} is now the host`.length) : '';
      if (next.you.isHost && !prev.you.isHost) {
        toast('info', 'host', `${why ? why + '. ' : ''}You are the host now: you move the game on with ${next.phase === 'lobby' ? 'Start' : 'Next'}.`);
      } else toast('info', 'host', flashText(hostNews));
    }
  } else ui.toasts = ui.toasts.filter((t) => t.kind !== 'info');
  if (!prev.you.isHost && next.you.isHost) { try { if (navigator.vibrate) navigator.vibrate([80, 60, 80]); } catch { /* not supported */ } }
  const wasMine = prev.turn && prev.turn.speakerId === prev.you.id;
  const isMine = next.turn && next.turn.speakerId === next.you.id && (!prev.turn || prev.turn.speakerId !== next.turn.speakerId || prev.turn.kind !== next.turn.kind);
  if (isMine && !wasMine) { try { if (navigator.vibrate) navigator.vibrate(120); } catch { /* not supported */ } }
}
// SPEC §11 X6: the server's line for an End game, and whether the lobby on screen came from one (no game began since).
function isEndGameLine(e) { return !!e && e.kind === 'system' && e.text === 'The host ended the game'; }
function endedByHost(s) {
  const log = s.log || [];
  for (let i = log.length - 1; i >= 0; i--) {
    if (isEndGameLine(log[i])) return true;
    if (log[i].kind === 'system' && /^The game (begins|started)\b/.test(log[i].text)) return false;
  }
  return false;
}
// The ballot a vote belongs to (the viewer's vote is per ballot and stage).
function ballotKey(s) { return s && s.vote ? [s.room, s.round, !!s.overtime, s.vote.ballot, s.vote.stage].join('|') : ''; }
// {text, line} when the viewer's vote in the running ballot was for a player who has just left or been kicked (the
// server then drops it, SPEC §3), else null.
function voteWipe(prev, next, leaves) {
  const was = prev.me && prev.me.myVote;
  if (!was || !next.me || next.me.myVote || next.phase !== 'vote' || !prev.vote || ballotKey(prev) !== ballotKey(next)) return null;
  const p = byId(next, was);
  if (!p || p.status !== 'left') return null;
  const line = leaves.find((e) => e.text === `${p.name} left the game` || e.text === `${p.name} was removed by the host`) || null;
  const how = line && line.text.endsWith(' was removed by the host') ? 'was removed by the host' : 'left the game';
  return { line, text: `${p.name} ${how}, so your vote for them no longer counts: vote again.` };
}
// A flash leads with the outcome: "Anna played “Spy” → …", without the round prefix and the card's rules text
// (both stay in the log).
function flashText(e) {
  let t = String(e.text || '');
  // a special's own line is read from its player's name (a name may itself read "X played “T”: …")
  const m = e.kind === 'special' ? specialLine(t) : null;
  if (m) t = `${m.name} played “${m.title}” → ${m.result}`;
  else t = t.replace(/^(?:Round \d+|Overtime)\s+—\s+/, '');
  return t.length > 170 ? t.slice(0, 167) + '…' : t;
}
function resultSig(r) {
  return r ? JSON.stringify([r.stage, r.ejectedId, r.tie, r.random, r.cancelled, r.tally.map((x) => x.targetId + ':' + x.votes)]) : '';
}
function trackChanges(prev, next) {
  const now = Date.now();
  let fresh = false;
  if (prev && prev.room === next.room && next.phase !== 'final' && prev.phase !== 'lobby') {
    for (const p of next.players) {
      const op = prev.players.find((x) => x.id === p.id);
      if (!op) continue;
      for (const c of Object.keys(p.cards || {})) {
        if (p.cards[c] != null && p.cards[c] !== op.cards[c]) { freshAt.set(p.id + ':' + c, now); fresh = true; }
      }
      if (op.status === 'alive' && p.status !== 'alive') { outAt.set(p.id, now); fresh = true; }
    }
  }
  // the last vote result stays open until the next discussion starts (unless the viewer toggles it)
  const sig = resultSig(next.lastVoteResult);
  if (sig !== lastResultSig) {
    lastResultSig = sig;
    ui.resultFresh = !!sig && !!prev && prev.room === next.room;
    ui.showLast = null;
  }
  if (prev && prev.phase !== 'discussion' && next.phase === 'discussion') { ui.resultFresh = false; ui.showLast = null; }
  if (next.phase === 'lobby') ui.resultFresh = false;
  if (next.phase !== 'final') {
    seenBeforeFinal.clear();
    for (const p of next.players) for (const c of Object.keys(p.cards || {})) if (p.cards[c] != null) seenBeforeFinal.add(p.id + ':' + c);
    hadPreFinal = GAME_PHASES.includes(next.phase);
  }
  if (fresh) setTimeout(scheduleRender, 6300);
}

/* ------------------------------------------------------------------ toasts */
function toast(kind, code, message, extra) {
  const now = Date.now();
  const dup = ui.toasts.find((t) => t.code === code && t.message === message);
  if (dup) { dup.until = Math.max(dup.until, now + 5000); scheduleRender(); return; }
  const t = { id: ++toastSeq, kind, code, message, air: !!(extra && extra.air), threat: !!(extra && extra.threat), until: now + (kind === 'error' ? 5500 : 4200) };
  ui.toasts.push(t);
  if (kind === 'info') {
    // phones get at most one flash at a time (the newest), desktops two
    const max = isNarrow() ? 1 : 2;
    const infos = ui.toasts.filter((x) => x.kind === 'info');
    if (infos.length > max) ui.toasts = ui.toasts.filter((x) => !infos.slice(0, infos.length - max).includes(x));
  }
  while (ui.toasts.length > 4) ui.toasts.shift();
  setTimeout(() => { expireToasts(); }, t.until - now + 20);
  scheduleRender();
}
function expireToasts() {
  const now = Date.now();
  const before = ui.toasts.length;
  ui.toasts = ui.toasts.filter((t) => t.until > now);
  if (ui.toasts.length !== before) scheduleRender();
}

/* ------------------------------------------------------------------ popovers (SPEC §11 X3) */
// One popover for the page. It lives outside the rendered tree (morph never touches it) with position:fixed, so no
// scroll container clips it, and it is clamped to the viewport. Anchors are [data-pop] elements:
//   "card"  a special card's title chip: the card's rules text;
//   "clamp" a revealed characteristic whose text is cut off (the table's line clamp, a shortened quote): all of it.
// A mouse shows it while hovering, keyboard focus while focused; a click or a tap pins it until Esc, a tap on it, a
// tap elsewhere (a touch tap that only dismisses does nothing else) or its anchor leaving the page.
const POP_ID = 'card-pop';
const pop = { el: null, anchor: null, key: '', pinned: false, viaKey: false, sig: '', showTimer: 0, hideTimer: 0, swallowAt: 0 };
function popAnchorOf(t) { return t instanceof Element ? t.closest('[data-pop]') : null; }
function popWanted(a) {
  if (!a || !a.isConnected) return false;
  if (a.getAttribute('data-pop') !== 'clamp' || a.hasAttribute('data-pop-cut')) return true;
  const v = a.querySelector('.cval') || a;   // only a text that is actually cut off
  return v.scrollHeight > v.clientHeight + 1 || v.scrollWidth > v.clientWidth + 1;
}
function showPop(a, pinned) {
  clearTimeout(pop.showTimer);
  // An anchor with nothing to show (a table cell whose text fits) opens nothing, and the popover still open for the
  // anchor the pointer or the focus just left closes now: it describes a cell the player is no longer on, and it
  // would cover the one they are reading. (A pinned one stays unless this is a tap: only a tap or Esc closes it.)
  if (!popWanted(a)) { if (pop.anchor && (pinned || !pop.pinned)) hidePop(); return; }
  clearTimeout(pop.hideTimer);
  if (pop.anchor && pop.anchor !== a) pop.anchor.removeAttribute('aria-describedby');
  pop.anchor = a;
  pop.key = a.getAttribute('data-pop-key') || '';
  pop.pinned = !!pinned;
  pop.viaKey = false;
  fillPop();
  placePop();
}
function hidePop() {
  clearTimeout(pop.showTimer);
  clearTimeout(pop.hideTimer);
  if (pop.anchor) pop.anchor.removeAttribute('aria-describedby');
  pop.anchor = null;
  pop.pinned = false;
  pop.viaKey = false;
  pop.sig = '';
  if (pop.el) pop.el.remove();
}
function fillPop() {
  const a = pop.anchor;
  const kind = a.getAttribute('data-pop') === 'clamp' ? 'paper' : 'special';
  const title = a.getAttribute('data-pop-title') || '';
  const text = a.getAttribute('data-pop-text') || '';
  const kicker = a.getAttribute('data-pop-kicker') || '';
  const meta = a.getAttribute('data-pop-meta') || '';
  if (!pop.el) {
    pop.el = document.createElement('div');
    pop.el.id = POP_ID;
    pop.el.setAttribute('role', 'tooltip');
  }
  const el = pop.el;
  el.className = `card-pop cp-${kind}${pop.pinned ? ' pinned' : ''}`;
  el.setAttribute('data-testid', 'card-popover');
  el.setAttribute('data-title', title);
  el.setAttribute('data-kind', kind);
  const sig = [kind, title, text, kicker, meta].join('\u0001');
  if (sig !== pop.sig) {
    pop.sig = sig;
    const kids = [];
    if (kicker) kids.push(h('div', { class: 'cp-k', text: kicker }));
    if (title) kids.push(h('div', { class: 'cp-t' }, kind === 'special' ? icon('spark', 'cp-ico') : null, h('span', { text: title })));
    kids.push(h('p', { class: 'cp-x', text }));
    if (meta) kids.push(h('p', { class: 'cp-m', text: meta }));
    // the body scrolls (a long text on a small screen), the box does not: its arrow sticks out of it
    el.replaceChildren(h('div', { class: 'cp-body' }, kids));
  }
  if (!el.isConnected) document.body.appendChild(el);
  a.setAttribute('aria-describedby', POP_ID);
}
// The part of an anchor that is really on screen: its box cut by the viewport and by every ancestor that clips its
// content (the log, the rail and the table scroll). null when (almost) nothing of it shows: a chip scrolled out of the
// log, whose popover would otherwise stay pinned next to a hidden anchor, over whatever is there instead.
function visibleRect(a) {
  const r = a.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  let left = Math.max(r.left, 0);
  let top = Math.max(r.top, 0);
  let right = Math.min(r.right, document.documentElement.clientWidth || window.innerWidth);
  let bottom = Math.min(r.bottom, window.innerHeight);
  for (let el = a.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const c = el.getBoundingClientRect();
      const cl = c.left + el.clientLeft;
      const ct = c.top + el.clientTop;
      if (cs.overflowX !== 'visible') { left = Math.max(left, cl); right = Math.min(right, cl + el.clientWidth); }
      if (cs.overflowY !== 'visible') { top = Math.max(top, ct); bottom = Math.min(bottom, ct + el.clientHeight); }
    }
    if (cs.position === 'fixed') break;   // nothing further up moves or clips a fixed box
  }
  const w = right - left;
  const ht = bottom - top;
  if (w < Math.min(8, r.width / 2) || ht < Math.min(8, r.height / 2)) return null;
  return { left, top, right, bottom, width: w, height: ht };
}
// Below the anchor (above when there is no room), its arrow pointing at the anchor; a clamped text floats over its
// own cell as paper. Always inside the viewport, 8 px from every edge.
function placePop() {
  const a = pop.anchor;
  const el = pop.el;
  if (!a || !el) return;
  if (!a.isConnected) { hidePop(); return; }
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const M = 8;
  const r = visibleRect(a);
  if (!r) { hidePop(); return; }
  // a table cell's text floats over the cell itself; any other anchor (a chip, a shortened quote) gets it next to it
  const overCell = el.classList.contains('cp-paper') && a.classList.contains('card');
  el.style.minWidth = overCell ? `${Math.round(Math.min(vw - 2 * M, 300, Math.max(r.width + 4, 220)))}px` : '';
  el.style.left = '0px';
  el.style.top = '0px';
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  let left;
  let top;
  let above = false;
  if (overCell) {
    left = r.left - 2;
    top = r.top - 2;
    if (top + ht > vh - M) top = vh - M - ht;
  } else {
    left = r.left + r.width / 2 - Math.min(w / 2, 40);
    top = r.bottom + 9;
    if (top + ht > vh - M && r.top - 9 - ht >= M) { top = r.top - 9 - ht; above = true; } else if (top + ht > vh - M) top = vh - M - ht;
  }
  left = Math.max(M, Math.min(left, vw - M - w));
  top = Math.max(M, top);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.setProperty('--ax', `${Math.round(Math.max(14, Math.min(w - 14, r.left + r.width / 2 - left)))}px`);
  el.classList.toggle('above', above);
}
// After a render: follow the anchor (morph keeps the node, or a keyed twin replaces it), refresh the text, re-place.
function syncPop() {
  if (!pop.anchor) return;
  if (!pop.anchor.isConnected) {
    const twin = pop.key ? document.querySelector(`[data-pop-key="${CSS.escape(pop.key)}"]`) : null;
    if (!twin) { hidePop(); return; }
    pop.anchor = twin;
  }
  if (!popWanted(pop.anchor)) { hidePop(); return; }
  fillPop();
  placePop();
}
document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  if (pop.el && pop.el.contains(e.target)) { clearTimeout(pop.hideTimer); return; }
  const a = popAnchorOf(e.target);
  if (!a || pop.pinned) return;
  clearTimeout(pop.showTimer);
  if (pop.anchor === a) { clearTimeout(pop.hideTimer); return; }
  // an anchor with nothing to show (a cell whose text fits) keeps the hide timer the pointer leaving the last one set
  if (!popWanted(a)) return;
  clearTimeout(pop.hideTimer);
  // moving from one chip to the next swaps at once; the first one waits a moment (a pointer just passing over)
  pop.showTimer = setTimeout(() => showPop(a, false), pop.anchor ? 0 : 110);
});
document.addEventListener('pointerout', (e) => {
  if (e.pointerType !== 'mouse' || pop.pinned) return;
  const inPop = !!pop.el && pop.el.contains(e.target);
  if (!inPop && !popAnchorOf(e.target)) return;
  const to = e.relatedTarget;
  if (to instanceof Node && ((pop.anchor && pop.anchor.contains(to)) || (pop.el && pop.el.contains(to)))) return;
  clearTimeout(pop.showTimer);
  if (pop.anchor) pop.hideTimer = setTimeout(hidePop, 140);
});
document.addEventListener('pointerdown', (e) => {
  pop.swallowAt = 0;
  if (!pop.anchor || !pop.pinned) return;
  if ((pop.el && pop.el.contains(e.target)) || pop.anchor.contains(e.target)) return;
  // a finger that taps elsewhere only closes the popover (what is under it may be a vote or Next); a mouse click
  // closes it and goes on to do what it does
  if (e.pointerType !== 'mouse' && !popAnchorOf(e.target)) pop.swallowAt = Date.now();
  hidePop();
}, true);
document.addEventListener('pointercancel', () => { pop.swallowAt = 0; }, true);
document.addEventListener('click', (e) => {
  if (pop.swallowAt && Date.now() - pop.swallowAt < 900) { pop.swallowAt = 0; e.preventDefault(); e.stopPropagation(); return; }
  pop.swallowAt = 0;
  if (pop.el && pop.el.contains(e.target)) { hidePop(); e.stopPropagation(); return; }
  const a = popAnchorOf(e.target);
  if (!a) return;
  if (pop.anchor === a && pop.pinned) hidePop();
  else {
    showPop(a, true);
    pop.viaKey = e.detail === 0;   // Enter or Space on the chip (a keyboard "click")
  }
}, true);
document.addEventListener('focusin', (e) => {
  const t = e.target;
  let kb = false;
  try { kb = t instanceof Element && t.matches(':focus-visible'); } catch { kb = false; }
  // focus moved on (Tab) from a pinned popover's anchor: that popover closes, so the newly focused anchor can show its
  // own and nothing floats over the page for an element the keyboard has left
  if (pop.anchor && pop.pinned && (pop.viaKey || kb) && !pop.anchor.contains(t) && !(pop.el && pop.el.contains(t))) hidePop();
  const a = popAnchorOf(t);
  if (!a || pop.pinned || a !== t) return;
  if (kb) showPop(a, false);
});
document.addEventListener('focusout', (e) => {
  if (!pop.anchor || pop.pinned || e.target !== pop.anchor) return;
  pop.hideTimer = setTimeout(() => { if (!pop.pinned) hidePop(); }, 60);
});
// Esc closes the popover first (and only it: an open special picker stays open)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pop.anchor) { hidePop(); e.stopPropagation(); e.preventDefault(); }
}, true);
let popFrame = 0;
function popFollow(e) {
  if (!pop.anchor || (e && pop.el && e.target === pop.el)) return;
  if (popFrame) return;
  popFrame = requestAnimationFrame(() => { popFrame = 0; placePop(); });
}
document.addEventListener('scroll', popFollow, true);
window.addEventListener('resize', () => popFollow(null));

/* ------------------------------------------------------------------ narrator hook (public/narrator.js)
 * The opt-in catastrophe narrator is a self-contained module, loaded on the side: if it is missing or throws, the game
 * runs exactly as without it. Hooks: this block, render() (sync), vHeader (headerControl), vSituation + vBriefing
 * (narrTitle), index.html (modulepreload), style.css ("narrator" section). */
let narr = null;
function narrHook(fn, fallback = null) {
  if (!narr) return fallback;
  try { return fn(narr); } catch (err) { console.error('narrator failed', err); narr = null; return fallback; }
}
function narrTitle(titleEl, s, where) { return narrHook((n) => n.titleRow(titleEl, s, where), titleEl); }
import('./narrator.js').then((m) => {
  m.init({ onChange: scheduleRender, notify: (text) => { if (!isNarrow()) toast('info', 'narrator', text); }, memory: !!MOCK });
  narr = m;
  scheduleRender();
}).catch(() => { /* no narrator */ });

/* ------------------------------------------------------------------ rendering */
let renderQueued = false;
let lastTopH = -1;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => { renderQueued = false; render(); });
}
function render() {
  narrHook((n) => n.sync(ui.screen === 'room' ? state : null));   // narrator hook: the game on screen (plays / stops)
  const root = document.getElementById('app');
  if (!root) return;
  const logEl = root.querySelector('[data-testid="log"]');
  const stick = !logEl || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
  let tree;
  try {
    tree = h('div', null, view(), vToasts(), vModal());
  } catch (err) {
    console.error('render failed', err);
    tree = h('div', null, h('div', { class: 'screen center' },
      h('div', { class: 'hz-strip', 'aria-hidden': 'true' }),
      h('div', { class: 'panel narrow' },
        h('div', { class: 'panel-head' }, h('h2', { text: 'Display error' })),
        h('p', { class: 'big-line', text: 'Something unexpected arrived and this screen could not be drawn. Your seat is safe.' }),
        h('div', { class: 'row gap' }, h('button', { class: 'btn primary', act: 'reload' }, 'Reload the page')))), vToasts());
  }
  morphChildren(root, tree);
  const logAfter = root.querySelector('[data-testid="log"]');
  if (logAfter && stick) logAfter.scrollTop = logAfter.scrollHeight;
  measureChrome(root);
  pinPage();
  fitBoard(root);
  syncCellStops(root);
  centerTurnStrip(root);
  document.title = pageTitle();
  document.body.classList.toggle('modal-open', !!ui.picker || ui.rulesOpen);
  syncOverlayHistory();
  focusPicker();
  restoreFocus();
  updateTimers();
  syncPop();
  if (ui.scrollFinal) {
    ui.scrollFinal = false;
    const fb = root.querySelector('.final-banner');
    if (fb) scrollWithin(fb, 'start');
  }
}
// The special picker and the rules sheet are overlays: they get a history entry, so the phone's Back button closes
// them instead of leaving the page (and the game). Closing one any other way pops that entry again.
let overlayEntry = false;
let ignorePops = 0;
function syncOverlayHistory() {
  const want = !!ui.picker || ui.rulesOpen;
  try {
    if (want && !overlayEntry) { history.pushState({ bunkerOverlay: true }, ''); overlayEntry = true; }
    else if (!want && overlayEntry) { overlayEntry = false; ignorePops++; history.back(); }
  } catch { /* history not available */ }
}
window.addEventListener('popstate', () => {
  if (ignorePops > 0) { ignorePops--; return; }
  if (!overlayEntry) return;
  overlayEntry = false;
  closeOverlay();
  shield();
  scheduleRender();
});
// The element that opened an overlay (a special's Play…, the alert's Join, Rules), as a selector: the node itself may
// be replaced by a render meanwhile.
function openerOf(el) {
  if (!(el instanceof Element)) return '';
  const act = el.getAttribute('data-act');
  if (!act) return '';
  let q = `[data-act="${CSS.escape(act)}"]`;
  for (const a of ['data-uid', 'data-player-id', 'data-testid']) q += el.hasAttribute(a) ? `[${a}="${CSS.escape(el.getAttribute(a))}"]` : `:not([${a}])`;
  return q;
}
// The special picker or the rules sheet closes without playing (Esc, Cancel, ×, the backdrop, Back): the keyboard
// focus goes back to the button that opened it (the focused node inside the sheet is gone), once the click-through
// shield lets that button be enabled again; not to <body>, which sends a keyboard player back to the top of the page.
function closeOverlay() {
  const q = ui.picker ? ui.picker.opener : ui.rulesOpen ? ui.rulesOpener : '';
  ui.picker = null;
  ui.rulesOpen = false;
  if (q) ui.refocus = { q, until: Date.now() + SHIELD_MS + 2000 };
}
function restoreFocus() {
  const r = ui.refocus;
  if (!r || ui.picker || ui.rulesOpen) return;
  const active = document.activeElement;
  const parked = !!active && active.hasAttribute('data-focus-park');
  if (Date.now() > r.until || (active && active !== document.body && active !== document.documentElement && !parked)) { ui.refocus = null; return; }
  const el = document.querySelector(r.q);
  if (!el) { ui.refocus = null; return; }
  if (el.disabled) {
    // held by the click-through shield (SPEC §11 K6): meanwhile the focus waits on the button's own card or alert row
    // (focusable by script only), so a Tab pressed right away goes on from there, not from the top of the page
    const box = el.closest('[data-focus-park]');
    if (box && active !== box) try { box.focus({ preventScroll: true }); } catch { /* ignore */ }
    return;   // the render after the shield moves it onto the button
  }
  ui.refocus = null;
  try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
}
// SPEC §11 X7. An app shell (lobby, game, final) is exactly the dynamic viewport, and the page itself never scrolls:
// on iOS Safari a scrolled page slides the whole shell up, header and action bar with it, and leaves a band of empty
// page under the bar (with the toolbar showing, the page could be taller than the screen by the toolbar). So code here
// scrolls an element's own scroll box only (scrollWithin), never with scrollIntoView, which scrolls every ancestor up
// to the page; and whatever still scrolled the page (the browser bringing a focused field into view above the
// keyboard, a test's scrollIntoView) is put back once no text field has the focus and the page is not pinch-zoomed.
function pinPage() {
  const shell = !!document.querySelector('#app .shell');
  document.documentElement.classList.toggle('app-shell', shell);
  if (!shell) return;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
  const vv = window.visualViewport;
  if (vv && Math.abs(vv.scale - 1) > 0.01) return;
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
}
let pinQueued = false;
function schedulePin() {
  if (pinQueued) return;
  pinQueued = true;
  requestAnimationFrame(() => { pinQueued = false; pinPage(); });
}
window.addEventListener('scroll', schedulePin, { passive: true });
// the keyboard went away (iOS may leave the page scrolled where it put the field): once now, once it has slid down
document.addEventListener('focusout', () => { setTimeout(schedulePin, 0); setTimeout(schedulePin, 400); });
if (window.visualViewport) window.visualViewport.addEventListener('resize', schedulePin);
// Brings `el` into view inside its own scroll boxes (a list, the shell's middle, a column), the way scrollIntoView
// does, honouring each box's scroll-padding (the toasts under the header), but never scrolls the page itself.
function scrollWithin(el, block = 'start', smooth = false) {
  if (!el || !el.isConnected) return;
  const boxes = [];
  for (let box = el.parentElement; box && box !== document.body && box !== document.documentElement; box = box.parentElement) {
    const oy = getComputedStyle(box).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && box.scrollHeight > box.clientHeight + 1) boxes.push(box);
  }
  boxes.forEach((box, i) => {
    const cs = getComputedStyle(box);
    const padT = parseFloat(cs.scrollPaddingTop) || 0;
    const padB = parseFloat(cs.scrollPaddingBottom) || 0;
    const b = box.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const top = b.top + box.clientTop + padT;
    const delta = block === 'center' ? (r.top + r.height / 2) - (top + (box.clientHeight - padT - padB) / 2) : r.top - top;
    // inner boxes jump at once, so the next box measures where the element really is; only the outermost glides
    const behavior = smooth && i === boxes.length - 1 ? 'smooth' : 'auto';
    try { box.scrollTo({ top: box.scrollTop + delta, behavior }); } catch { box.scrollTop += delta; }
  });
}
// The sticky header and the bottom action bar cover the page on phones: publish their heights so scroll-padding,
// the toasts and scroll-margin keep content (and anything scrolled into view) clear of them.
let lastBarH = -1;
let lastToastH = -1;
function measureChrome(root) {
  const topEl = root.querySelector('.top');
  const topH = topEl ? Math.round(topEl.getBoundingClientRect().height) : 0;
  if (topH !== lastTopH) { lastTopH = topH; document.documentElement.style.setProperty('--top-h', topH + 'px'); }
  // phones: a flash sits under the header, so scrolled-into-view content must also clear it
  const toastsEl = root.querySelector('.toasts');
  const toastH = toastsEl && toastsEl.children.length && isNarrow() ? Math.round(toastsEl.getBoundingClientRect().height) + 6 : 0;
  if (toastH !== lastToastH) { lastToastH = toastH; document.documentElement.style.setProperty('--toast-h', toastH + 'px'); }
  const barEl = root.querySelector('.bar');
  const barH = barEl ? Math.round(barEl.getBoundingClientRect().height) : 0;
  if (barH !== lastBarH) { lastBarH = barH; document.documentElement.style.setProperty('--bar-h', barH + 'px'); }
}
// Matrix text: as many lines per card cell as fit with every row still on screen (2..8), or all of it on request.
// The clamp is tried against the real layout (a few synchronous reflows), so short rows leave room for long ones.
function fitBoard(root) {
  const board = root.querySelector('.board.matrix');
  if (!board) return;
  const setCl = (v) => {
    if (board.getAttribute('data-cl') === v) return;
    board.setAttribute('data-cl', v);
    if (v === 'none') board.style.removeProperty('--cl'); else board.style.setProperty('--cl', v);
  };
  if (prefs.fullText || !isMatrix()) { boardCl = 'none'; setCl('none'); return; }
  const head = board.querySelector('.bhead');
  const main = board.closest('.main-col');
  if (!head) return;
  let avail;
  if (isConsole() && main) {
    const top = head.getBoundingClientRect().bottom - main.getBoundingClientRect().top;
    avail = main.clientHeight - top - 14;
  } else {
    avail = window.innerHeight - (lastTopH > 0 ? lastTopH : 0) - (lastBarH > 0 ? lastBarH : 0) - head.getBoundingClientRect().height - 24;
  }
  let fixed = head.getBoundingClientRect().height;
  for (const g of board.querySelectorAll('.bgroup')) { const gh = g.getBoundingClientRect().height; avail -= gh; fixed += gh; }
  const rowsH = () => board.getBoundingClientRect().height - fixed;
  let cl = Number(boardCl) || 2;
  setCl(String(cl));
  if (rowsH() > avail) {
    while (cl > 2) { cl--; setCl(String(cl)); if (rowsH() <= avail) break; }
  } else {
    while (cl < 8) { setCl(String(cl + 1)); if (rowsH() > avail) { setCl(String(cl)); break; } cl++; }
  }
  boardCl = String(cl);
}
let boardCl = '2';
// The table cells whose text is cut off right now (their data-pop-key): only these are Tab stops. Measured after the
// clamp is fitted; a change is applied to the live cells at once and remembered, so the next render builds the same
// tabindex (morph then leaves it alone). The focused cell keeps its stop (dropping it would throw the focus away).
const cutCells = new Set();
function syncCellStops(root) {
  const cells = root.querySelectorAll('.board.matrix .card.up[data-pop="clamp"]');
  const clampable = isMatrix() && !prefs.fullText;
  const now = new Set();
  for (const c of cells) {
    const key = c.getAttribute('data-pop-key');
    const cut = clampable && (popWanted(c) || c === document.activeElement);
    if (cut) now.add(key);
    if (cut && c.getAttribute('tabindex') !== '0') c.setAttribute('tabindex', '0');
    else if (!cut && c.hasAttribute('tabindex')) c.removeAttribute('tabindex');
  }
  cutCells.clear();
  for (const k of now) cutCells.add(k);
}
// Phones: the speaking order is one horizontal strip; keep the current speaker in view (without moving the page).
let lastStripKey = '';
function centerTurnStrip(root) {
  const list = root.querySelector('.to-list');
  const now = list && list.querySelector('.to-now');
  if (!list || !now || list.scrollWidth <= list.clientWidth + 2) return;
  const key = stepKeyOf(state || {}) + ':' + list.clientWidth;
  if (key === lastStripKey) return;
  lastStripKey = key;
  const li = now.parentElement.getBoundingClientRect();
  const box = list.getBoundingClientRect();
  list.scrollLeft = Math.max(0, list.scrollLeft + (li.left - box.left) - (box.width - li.width) / 2);
}
function pageTitle() {
  if (!state || ui.screen !== 'room') return 'Bunker Online';
  const d = derive(state);
  let pre = '';
  if (d.canReveal || d.canEndTurn) pre = '▶ Your turn · ';
  else if (d.voteOpen && !d.myVote) pre = '▶ Vote · ';
  return `${pre}Bunker ${state.room}`;
}
function focusPicker() {
  if (!ui.picker) { ui.pickerFocused = ''; return; }
  const sp = state && state.me ? state.me.specials.find((x) => x.uid === ui.picker.uid) : null;
  if (!sp) return;
  const key = ui.picker.uid + ':' + pickerStep(sp, ui.picker);
  if (ui.pickerFocused === key) return;
  ui.pickerFocused = key;
  const first = document.querySelector('.modal [data-testid="target-option"], .modal [data-testid="category-option"], .modal [data-testid="special-confirm-btn"]');
  if (first && first.disabled) { ui.pickerFocused = ''; return; }   // held for PICK_GUARD_MS: focus it once enabled
  if (first) try { first.focus({ preventScroll: true }); } catch { /* ignore */ }
}
function updateTimers() {
  const now = serverNow();
  for (const el of document.querySelectorAll('[data-ends]')) {
    const rem = Number(el.getAttribute('data-ends')) - now;
    const txt = fmtClock(rem);
    if (el.textContent !== txt) el.textContent = txt;
    const over = rem <= 0;
    const low = !over && rem <= 10000;
    el.closest('[data-timer-box]')?.classList.toggle('over', over);
    el.closest('[data-timer-box]')?.classList.toggle('low', low);
  }
  for (const el of document.querySelectorAll('[data-bar-ends]')) {
    const total = Number(el.getAttribute('data-total')) || 1;
    const rem = Math.max(0, Number(el.getAttribute('data-bar-ends')) - now);
    el.style.transform = `scaleX(${Math.min(1, rem / total).toFixed(4)})`;
  }
}
let lastSecondRendered = -1;
let lastTimerOver = null;
setInterval(() => {
  updateTimers();
  // the host's Next turns primary when the speaker's time runs out: re-render on that edge
  const over = !!(state && state.timer && state.timer.endsAt <= serverNow());
  if (over !== lastTimerOver) { lastTimerOver = over; if (state) scheduleRender(); }
  if (conn.status === 'waiting') {
    const sec = Math.ceil((conn.nextAt - Date.now()) / 1000);
    if (sec !== lastSecondRendered) { lastSecondRendered = sec; scheduleRender(); }
  }
  if (ui.copied && Date.now() - ui.copiedAt > 2600) { ui.copied = null; scheduleRender(); }
}, 250);

function view() {
  if (ui.screen === 'landing') return vLanding();
  if (ui.screen === 'resuming') return vResuming();
  if (ui.screen === 'replaced') return vReplaced();
  if (ui.screen === 'mock-index') return vMockIndex();
  if (!state) return ui.screen === 'room' ? vEntering() : vResuming();
  if (state.phase === 'lobby') return vLobby();
  return vGame();
}

/* ---------- shared bits */
function hazardSign(extra) { return h('span', { class: ['hz-sign', extra], 'aria-hidden': 'true' }, h('span', { text: '!' })); }
function tag(text, kind, title) { return h('span', { class: ['tag', kind && 'tag-' + kind], title: title || null, text }); }
function kv(k, v, cls, attrs) {
  return h('div', Object.assign({ class: ['kv', cls] }, attrs || {}), h('span', { class: 'k', text: k }), ' ', v instanceof Node ? v : h('span', { class: 'v', text: v }));
}
function connBanner() {
  // an open socket that has not (re)joined yet is still reconnecting: the table on screen is not live
  const st = MOCK ? ui.mockConn : (conn.status === 'open' && joinedOnSocket ? 'open' : conn.status === 'open' && identity ? 'connecting' : conn.status);
  if (!st || st === 'open' || st === 'idle') return null;
  const secs = conn.nextAt ? Math.max(0, Math.ceil((conn.nextAt - Date.now()) / 1000)) : 0;
  const msg = st === 'waiting' ? `Retrying in ${secs}s (attempt ${conn.attempt}).` : 'Reconnecting…';
  const busy = st === 'waiting' && conn.why === 'busy';
  return h('div', { class: 'conn-banner', role: 'status', testid: 'conn-banner', 'data-why': busy ? 'busy' : null },
    h('span', { class: 'conn-pulse', 'aria-hidden': 'true' }),
    h('strong', { text: busy ? 'The server is busy.' : 'Connection lost.' }), ' ',
    busy ? 'Too many wrong room codes came from your network, so it asks everyone there to wait a moment. ' : null, msg, ' Your seat is kept.',
    h('button', { class: 'btn xs', act: 'retry-now' }, 'Retry now'));
}

/* ---------- landing */
function vLanding() {
  const L = ui.landing;
  const name = cleanName(L.name);
  const nameOk = name.length > 0;
  const codeOk = CODE_RE.test(L.room);
  const busy = ui.pending;
  const offer = ui.rejoinOffer;
  // Opened from an invite link: joining that room is the main action; a new game of your own is the side road.
  const invited = !!L.invite;
  // the invite is to the room this browser already has a seat in (a discarded phone tab, a second tab): Rejoin is
  // the way back; Join would seat the same person twice ("Mia (2)"), or make them a spectator of their own game
  const sameSeat = !!offer && invited && offer.room === L.invite;
  let hint = '';
  if (!nameOk) hint = invited ? `You are invited to room ${L.invite}. Enter your name first: it is what the others see at the table.` : 'Enter your name first. It is what the others see at the table.';
  else if (L.room && !codeOk) hint = 'Room codes are 4 letters (there is no I or O).';
  else if (!L.room) hint = 'Have a code? Type it to join or watch.';
  else if (sameSeat && L.room === L.invite) hint = `You already have a seat in room ${L.room}${offer.name ? ` as ${offer.name}` : ''}: tap Rejoin above to take it back. Join adds a second, new player.`;
  else if (invited && L.room === L.invite) hint = `You are invited to room ${L.room}. Press Join to take a seat at the table.`;
  const nameField = h('label', { class: 'field' },
    h('span', { class: 'field-k', text: 'Your name' }),
    h('input', {
      class: 'input', testid: 'name-input', 'data-field': 'name', maxlength: '80', autocomplete: 'nickname',
      placeholder: 'e.g. Anna', spellcheck: 'false', value: L.name, enterkeyhint: 'go',
    }));
  const codeField = h('label', { class: 'field code-field' },
    h('span', { class: 'field-k', text: 'Room code' }),
    h('input', {
      class: 'input code', testid: 'room-input', 'data-field': 'room', maxlength: '4', autocomplete: 'off',
      autocapitalize: 'characters', spellcheck: 'false', placeholder: 'ABCD', value: L.room, enterkeyhint: 'go',
    }));
  const joinOff = !(nameOk && codeOk) || busy;
  const form = invited
    ? h('div', { class: 'panel form invited' },
      h('div', { class: 'invite-head' }, h('span', { class: 'k', text: 'You are invited to room' }), h('span', { class: 'invite-code-big mono', text: L.room || L.invite })),
      nameField,
      h('button', { class: ['btn block', sameSeat && L.room === L.invite ? 'ghost' : 'primary big'], testid: 'join-btn', act: 'join', disabled: joinOff },
        sameSeat && L.room === L.invite ? 'Join as a new player' : codeOk ? `Join room ${L.room}` : 'Join'),
      h('div', { class: 'join-row invited-row' },
        codeField,
        h('button', { class: 'btn ghost', testid: 'spectate-btn', act: 'spectate', disabled: joinOff }, 'Just watch')),
      h('p', { class: 'fine hint', text: busy ? 'Connecting…' : hint }),
      h('div', { class: 'or', 'aria-hidden': 'true' }, h('span', { text: 'not this room?' })),
      h('button', { class: 'btn ghost block', testid: 'create-btn', act: 'create', disabled: !nameOk || busy }, 'Start a different game of my own'))
    : h('div', { class: 'panel form' },
      nameField,
      h('button', { class: 'btn primary block big', testid: 'create-btn', act: 'create', disabled: !nameOk || busy }, 'Create a new game'),
      h('div', { class: 'or', 'aria-hidden': 'true' }, h('span', { text: 'or use a room code' })),
      h('div', { class: 'join-row' },
        codeField,
        h('button', { class: 'btn', testid: 'join-btn', act: 'join', disabled: joinOff }, 'Join'),
        h('button', { class: 'btn ghost', testid: 'spectate-btn', act: 'spectate', disabled: joinOff }, 'Watch')),
      h('p', { class: 'fine hint', text: busy ? 'Connecting…' : hint }));
  return h('div', { class: 'screen landing' },
    h('div', { class: 'hz-strip', 'aria-hidden': 'true' }),
    h('main', { class: 'landing-grid' },
      h('section', { class: 'brand' },
        h('div', { class: 'brand-kicker' }, hazardSign(), h('span', { text: 'Shelter access terminal' })),
        h('h1', { class: 'brand-title' }, h('span', { class: 'bt-main', text: 'BUNKER' }), h('span', { class: 'bt-sub', text: 'online' })),
        h('p', { class: 'brand-lede', text: 'A catastrophe has happened. The bunker has beds for only half of you. Reveal who you are, argue your case on voice, and vote on who stays outside.' }),
        vFan()),
      h('section', { class: 'brand-how' },
        h('ol', { class: 'brand-steps' },
          h('li', null, h('span', { class: 'n', text: '01' }), h('span', { text: 'Get everyone on a voice call (Discord, Telegram…). There is no chat here.' })),
          h('li', null, h('span', { class: 'n', text: '02' }), h('span', { text: 'One person creates a game and shares the link or the 4-letter code.' })),
          h('li', null, h('span', { class: 'n', text: '03' }), h('span', { text: 'This page deals the cards, runs the turns and counts the votes.' })))),
      h('section', { class: 'entry' },
        ui.notice && h('div', { class: ['callout', ui.notice.kind === 'warn' ? 'warn' : 'info'], role: 'status', testid: 'landing-notice' }, ui.notice.text),
        offer && h('div', { class: 'panel rejoin' },
          h('div', { class: 'panel-head' }, h('h2', { text: 'Your last seat' }), h('span', { class: 'meta', text: `Room ${offer.room}` })),
          h('p', { class: 'rejoin-text' }, 'You were at the table in room ', h('b', { class: 'mono', text: offer.room }),
            offer.name ? [' as ', h('b', { text: offer.name })] : null, '. Rejoin to take your seat back.'),
          h('div', { class: 'row gap' },
            h('button', { class: 'btn primary', testid: 'rejoin-btn', act: 'rejoin', disabled: busy }, `Rejoin as ${offer.name || 'before'}`),
            h('button', { class: 'btn ghost', act: 'forget' }, 'Forget it')),
          h('p', { class: 'fine', text: 'Or join as someone new with the form below.' })),
        form)),
    h('footer', { class: 'landing-foot' },
      h('span', { text: 'An online party game in the style of the discussion game “Bunker” («Бункер»). 4–16 players · spectators welcome.' })));
}
// Decorative: a hand of cards on the table — two backs, two face-up cards and a special.
function vFan() {
  const face = (label, text) => h('div', { class: 'fc face' }, h('span', { class: 'fc-cat', text: label }), h('span', { class: 'fc-text', text }));
  const back = () => h('div', { class: 'fc back' }, h('span', { class: 'fc-emblem' }, trefoil('fc-tre')));
  return h('div', { class: 'fan', 'aria-hidden': 'true' },
    back(), back(), face('Baggage', 'A live goat'), face('Profession', 'Surgeon, 12 years'),
    h('div', { class: 'fc special' }, h('span', { class: 'fc-cat', text: 'Special' }), h('span', { class: 'fc-title', text: 'Airlock' }), h('span', { class: 'fc-text', text: 'Needs a partner: two on one player and they are out.' })));
}
function vResuming() {
  const room = identity ? identity.room : (state ? state.room : '');
  const st = conn.status;
  const secs = conn.nextAt ? Math.max(0, Math.ceil((conn.nextAt - Date.now()) / 1000)) : 0;
  return h('div', { class: 'screen center' },
    h('div', { class: 'hz-strip', 'aria-hidden': 'true' }),
    h('div', { class: 'panel narrow' },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Reconnecting' }), h('span', { class: 'meta mono', text: room })),
      h('p', { class: 'big-line' }, 'Rejoining room ', h('b', { class: 'mono', text: room || '…' }),
        identity && identity.name ? [' as ', h('b', { text: identity.name })] : null, '…'),
      h('p', { class: 'fine', text: st !== 'waiting' ? 'Connecting to the table.'
        : conn.why === 'busy' ? `The server is busy: too many wrong room codes came from your network. Your seat is kept. Retrying in ${secs}s (attempt ${conn.attempt}).`
          : `The server is not answering. Retrying in ${secs}s (attempt ${conn.attempt}).` }),
      h('div', { class: 'row gap' },
        st === 'waiting' && h('button', { class: 'btn', act: 'retry-now' }, 'Retry now'),
        h('button', { class: 'btn ghost', act: 'cancel-resume' }, 'Cancel'))));
}
function vEntering() {
  return h('div', { class: 'screen center' },
    h('div', { class: 'hz-strip', 'aria-hidden': 'true' }),
    h('div', { class: 'panel narrow' },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Entering the room' }), h('span', { class: 'meta mono', text: identity ? identity.room : '' })),
      h('p', { class: 'big-line', text: 'Loading the table…' })));
}
function vReplaced() {
  return h('div', { class: 'screen center' },
    h('div', { class: 'hz-strip', 'aria-hidden': 'true' }),
    h('div', { class: 'panel narrow' },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Opened somewhere else' })),
      h('p', { class: 'big-line', text: 'Your seat is now open in another tab or device, so this tab stopped following the game.' }),
      h('p', { class: 'fine', text: 'Taking it back here disconnects the other tab.' }),
      h('div', { class: 'row gap' },
        identity && h('button', { class: 'btn primary', act: 'take-over' }, 'Use this tab instead'),
        h('button', { class: 'btn ghost', act: 'to-landing' }, 'Back to start'))));
}

/* ---------- header */
function vHeader(s, d) {
  const inPlay = s.phase !== 'lobby';
  const inGame = GAME_PHASES.includes(s.phase);
  const phaseText = s.phase === 'vote' && s.vote && s.vote.stage === 'revote' ? 'Revote' : PHASE_LABEL[s.phase] || s.phase;
  const timer = s.timer;
  const total = timer ? timerTotal(s) : 0;
  const over = Math.max(0, d.aliveList.length - s.capacity);
  return h('header', { class: 'hdr' },
    h('div', { class: 'hdr-row' },
      h('div', { class: 'hdr-brand' }, trefoil('hb-logo'), h('span', { class: 'hb-word', text: 'BUNKER' })),
      h('div', { class: 'hcell room-cell' }, h('span', { class: 'k', text: 'Room' }), h('span', { class: 'v mono code', testid: 'room-code', text: s.room })),
      inPlay && h('div', { class: ['hcell round-cell', s.overtime && 'ot'], testid: 'round', 'data-round': String(s.round), 'data-overtime': String(!!s.overtime) },
        h('span', { class: 'k', text: s.overtime ? 'Round 7 +' : 'Round' }), ' ',
        h('span', { class: 'v' }, s.overtime ? 'Overtime' : `${s.round}/${s.maxRounds}`)),
      h('div', { class: ['hcell phase-cell', 'ph-' + s.phase] }, h('span', { class: 'k', text: 'Phase' }),
        h('span', { class: 'v', testid: 'phase', 'data-phase': s.phase, text: phaseText })),
      inPlay && h('div', { class: 'hcell beds-cell', title: 'Beds in the bunker vs players still in the game' },
        h('span', { class: 'k', text: 'Beds / alive' }),
        h('span', { class: 'v' }, h('b', { class: 'beds', text: String(s.capacity) }), h('span', { class: 'sep', text: ' / ' }), h('span', { text: String(d.aliveList.length) }),
          inGame && over > 0 ? h('span', { class: 'over-chip', title: `${plural(over, 'player')} more than there are beds: that many must still leave` }, `${over} too many`) : null)),
      inGame && (() => { const nv = nextVoteShort(s); return h('div', { class: 'hcell wide-only nv-cell', title: nv.title },
        h('span', { class: 'k', text: 'Next vote' }), h('span', { class: ['v', nv.cls], text: nv.v })); })(),
      inGame && vRoundTrack(s, 'hdr-track'),
      h('div', { class: 'hdr-spacer' }),
      h('div', { class: 'hdr-break', 'aria-hidden': 'true' }),
      timer && h('div', { class: 'hcell timer-cell', 'data-timer-box': '' },
        h('span', { class: 'k', text: timer.label || 'Timer' }),
        h('span', { class: 'v mono', testid: 'timer', 'data-ends': String(timer.endsAt), text: fmtClock(timer.endsAt - serverNow()) })),
      inPlay && vJumpNav(s, d),
      h('div', { class: 'hcell you-cell' },
        h('span', { class: 'k', text: d.isSpectator ? 'Watching as' : d.isHost ? 'You · host' : 'You' }),
        h('span', { class: 'v you-name', text: s.you.name })),
      narrHook((n) => n.headerControl(s)),   // narrator hook: the header button + its popover
      h('button', { class: 'btn ghost sm rules-btn', act: 'rules', title: 'How to play: the goal, a round, the vote and the specials', 'aria-label': 'How to play' }, 'Rules'),
      // phones in play: Leave moves to the foot of the page, away from the jump chips right under it
      isNarrow() && inPlay ? null : vLeaveBtn(s, d, 'header')),
    timer && total > 0 && h('div', { class: 'hdr-progress', 'aria-hidden': 'true' },
      h('div', { class: 'hdr-progress-fill', 'data-bar-ends': String(timer.endsAt), 'data-total': String(total) })));
}
// Leaving a game is for good (§6: the seat counts as out and never comes back), and so is being kicked from one, so in
// play both take a second tap within ARM_MS (SPEC §11 K2). The lobby and spectators keep one tap: they can come back.
function leaveIsFinal(s, d) { return d.isPlayer && s.phase !== 'lobby' && d.meP.status !== 'left'; }
function isArmed(what) { return !!ui.armed && ui.armed.what === what && ui.armed.until > Date.now(); }
// the confirming tap counts only ARM_MIN_MS after arming: the 2nd click of a double click is not a second tap
function armReady(what) { return isArmed(what) && Date.now() - ui.armed.at >= ARM_MIN_MS; }
function arm(what) {
  const now = Date.now();
  ui.armed = { what, at: now, until: now + ARM_MS };
  // the armed button is wider ("Remove?", "Tap again to leave"): whatever moves under the pointer must not take the
  // second click of the double click either (the row's expand, the crown next to it)
  shield();
  setTimeout(scheduleRender, ARM_MIN_MS + 20);
  setTimeout(scheduleRender, ARM_MS + 30);
}
function vLeaveBtn(s, d, where) {
  const final = leaveIsFinal(s, d);
  const armed = final && isArmed('leave');
  const settling = armed && !armReady('leave');
  let title = d.isSpectator ? 'Stop watching' : final ? 'Leave this game for good: you cannot come back into it' : 'Leave the room';
  if (!d.online) title = 'Reconnecting — you can leave once the connection is back';
  return h('button', {
    class: ['btn sm leave', where === 'foot' || armed ? 'danger' : 'ghost', armed && 'armed', settling && 'settling', 'at-' + where], testid: 'leave-btn', act: 'leave',
    disabled: !d.online || d.shield || settling, title, 'aria-label': armed ? 'Tap again to leave the game for good' : null,
  }, armed ? 'Tap again to leave' : d.isSpectator && where === 'foot' ? 'Stop watching' : 'Leave');
}
function vLeavePanel(s, d) {
  const final = leaveIsFinal(s, d);
  const armed = final && isArmed('leave');
  let text;
  if (d.isSpectator) text = 'You can come back with the link at any time.';
  else if (!final) text = 'Leave the table.';
  else if (armed) text = 'Tap again to leave for good. You cannot come back into this game.';
  else text = 'Leaving is for good: you cannot come back into this game, and you count as out.';
  if (!d.online) text = 'Reconnecting — you can leave once the connection is back.';
  return h('section', { class: ['panel leave-panel', armed && 'armed'], id: 'sec-leave' },
    h('p', { class: 'leave-text', text }),
    vLeaveBtn(s, d, 'foot'));
}
function nextVoteShort(s) {
  const sch = s.schedule || {};
  const k = sch.kicksThisStep || 0;
  if (s.phase === 'vote' || s.phase === 'defense') { const n = s.vote ? ballotsOf(s) : k; return { v: `now · ${n} out`, cls: 'red', title: `This vote step ejects ${plural(n, 'player')}` }; }
  if (k > 0 && s.voteMods && s.voteMods.cancelNext) return { v: 'cancelled', cls: 'dim', title: 'The next vote was cancelled by a special card' };
  if (k > 0) return { v: `this round · ${k} out`, cls: 'red', title: `After this round's discussion ${plural(k, 'player')} will be voted out` };
  if (sch.nextVoteRound) return { v: `after R${sch.nextVoteRound}`, cls: '', title: `No vote this round; the next one is after round ${sch.nextVoteRound}` };
  return { v: '—', cls: 'dim', title: 'No more votes scheduled' };
}
function turnState(s, p) {
  const t = s.turn;
  if (!t) return null;
  const i = t.order.indexOf(p.id);
  if (i === -1) return t.kind === 'reveal' && p.status === 'alive' ? { text: 'no turn', cls: 'dim', title: 'No turn this round (was out when the round started)' } : null;
  if (i < t.index) return { text: t.kind === 'reveal' ? '✓ spoke' : '✓ defended', cls: 'ok' };
  if (i === t.index) return { text: t.kind === 'reveal' ? (t.hasRevealed ? '▶ speaking' : '▶ picking') : '▶ defending', cls: 'hz', title: t.kind === 'reveal' && !t.hasRevealed ? 'Choosing a card to reveal' : null };
  if (p.status !== 'alive') return { text: 'skipped', cls: 'dim' };
  let n = 0;
  for (let k = t.index + 1; k < i; k++) { const q = byId(s, t.order[k]); if (q && q.status === 'alive') n++; }
  return n === 0 ? { text: 'up next', cls: 'hz' } : { text: `in ${n + 1}`, cls: 'dim', title: `Speaks in ${n + 1} turns` };
}
// The votes still to come, projected with the §2 formula from the table as it is now (who is out, the beds, a
// cancelled next vote), "if nothing else changes". Played rounds show what their vote did, read from the log
// (voteHistory in public/loglines.js): the players it ejected, or struck through when a special cancelled it. The
// start-of-game KICKS row is only the fallback for a round whose lines were cut off the log.
// Cells: {r, k, st: 'past'|'now'|'future', cancelled, cut, ot}.
function trackPlan(s) {
  const row = (s.schedule && s.schedule.kicksByRound) || [];
  const hist = voteHistory(s.log);
  const cells = [];
  let alive = s.players.filter((p) => p.status === 'alive').length;
  let out = s.players.length - alive;
  const cap = s.capacity;
  let cancel = !!(s.voteMods && s.voteMods.cancelNext);
  const inStep = s.phase === 'vote' || s.phase === 'defense';
  const after = (k) => { out += k; alive -= k; };
  for (let r = 1; r <= 7; r++) {
    if (r < s.round || (r === s.round && s.overtime)) {
      const h = hist.get(r);
      if (!h) cells.push({ r, k: Number(row[r - 1]) || 0, st: 'past', plan: true });
      else if (h.cancelled && !h.out) cells.push({ r, k: h.due || Number(row[r - 1]) || 0, st: 'past', cancelled: true });
      else cells.push({ r, k: h.out, st: 'past', cut: h.cancelled });
      continue;
    }
    const now = r === s.round;
    if (now && inStep) {
      // the running step: its ballot total (as "Vote X of Y" shows it); what is still due in it moves the rounds after
      cells.push({ r, k: s.vote ? ballotsOf(s) : Number(s.schedule.kicksThisStep) || 0, st: 'now' });
      after(kicksNow(s));
      continue;
    }
    const k = alive > cap ? formulaKicks(s, r, out, alive, cap, false) : 0;
    if (k > 0 && cancel) { cells.push({ r, k, st: now ? 'now' : 'future', cancelled: true }); cancel = false; continue; }
    cells.push({ r, k, st: now ? 'now' : 'future' });
    after(k);
  }
  if (s.overtime) {
    const k = inStep ? (s.vote ? ballotsOf(s) : Number(s.schedule.kicksThisStep) || 0) : Math.max(0, alive - cap);
    cells.push({ r: 'OT', k, st: 'now', ot: true, cancelled: !inStep && k > 0 && cancel });
  } else if (alive > cap) cells.push({ r: 'OT', k: alive - cap, st: 'future', ot: true });   // round 7's vote is cancelled
  return cells;
}
function vRoundTrack(s, cls) {
  const cells = trackPlan(s).map((c) => {
    const name = c.ot ? 'Overtime' : `Round ${c.r}`;
    let title;
    if (c.st === 'past') {
      title = c.plan ? `${name}: played` : c.cancelled ? `${name}: played; its vote was cancelled by a special card`
        : c.k > 0 ? `${name}: played; ${plural(c.k, 'player')} voted out${c.cut ? ', then the rest of the vote was cancelled by a special card' : ''}`
          : `${name}: played, no one voted out`;
    }
    else if (c.cancelled) title = `${name}: its vote (${plural(c.k, 'ejection')}) is cancelled by a special card; they move to later votes`;
    else if (c.k > 0) title = c.st === 'now' && (s.phase === 'vote' || s.phase === 'defense') ? `${name}: voting now, ${plural(c.k, 'ejection')} in this vote`
      : `${name}: a vote for ${plural(c.k, 'ejection')} ${c.st === 'now' ? 'after this round' : 'if nothing changes (leaves and specials move it)'}`;
    else title = `${name}: no vote${c.st === 'future' ? ' planned' : ''}`;
    return h('li', { class: ['rt', 'rt-' + c.st, c.k > 0 && !c.cancelled && 'rt-vote', c.cancelled && 'rt-cancel'], key: String(c.r), title },
      h('span', { class: 'rt-n', text: String(c.r) }), h('span', { class: 'rt-k', text: c.k > 0 ? '✖' + c.k : '·' }));
  });
  return h('ol', { class: ['round-track', cls], 'aria-label': 'Rounds and the ejections due in them' }, cells);
}

/* ---------- lobby */
function vLobby() {
  const s = state;
  const d = derive(s);
  const link = location.origin + '/?room=' + s.room;
  const n = s.players.length;
  const copyLabel = ui.copied === 'ok' ? 'Copied ✓' : ui.copied === 'manual' ? 'Press Ctrl+C' : 'Copy link';
  return h('div', { class: 'shell lobby' },
    h('div', { class: 'top' }, vHeader(s, d), connBanner()),
    h('div', { class: 'body' },
      h('main', { class: 'main-col' },
        h('section', { class: 'panel invite' },
          h('div', { class: 'invite-code' },
            h('span', { class: 'k', text: 'Room code' }),
            h('span', { class: 'invite-letters mono', text: s.room })),
          h('div', { class: 'invite-link' },
            h('span', { class: 'k', text: 'Invite link — send it to everyone on the call' }),
            h('div', { class: 'link-row' },
              h('input', { class: 'input mono link-input', id: 'invite-link', readonly: true, value: link, 'aria-label': 'Invite link', 'data-select-all': '' }),
              h('button', { class: ['btn', ui.copied === 'ok' ? 'ok' : 'primary'], testid: 'copy-link-btn', act: 'copy-link' }, copyLabel)),
            h('p', { class: 'fine', text: 'Friends open the link, type a name and press Join. Late arrivals can watch as spectators.' }))),
        h('section', { class: 'panel' },
          h('div', { class: 'panel-head' }, h('h2', { text: 'Players at the table' }), h('span', { class: 'meta', text: `${n}/${s.maxPlayers} seated · min ${s.minPlayers}` })),
          h('ol', { class: 'lobby-list' }, s.players.map((p) => vLobbyPlayer(s, d, p))),
          n < s.minPlayers && h('p', { class: 'fine pad', text: `Waiting for ${plural(s.minPlayers - n, 'more player')} before the game can start.` })),
        vSpectators(s, d)),
      // the estimated game length leads the side column: everyone sees it first, and the host sees it follow the timers
      h('aside', { class: 'side-col' },
        vLobbySchedule(s, n),
        vLobbySettings(s, d),
        vRules())),
    vBar(s, d));
}
function vLobbyPlayer(s, d, p) {
  const me = p.id === s.you.id;
  return h('li', { class: ['lp', me && 'me', !p.connected && 'offline'], key: p.id, testid: 'lobby-player', 'data-player-id': p.id, 'data-connected': String(p.connected) },
    h('span', { class: 'seat mono', text: pad2(p.seat + 1) }),
    h('span', { class: ['dot', p.connected ? 'on' : 'off'], title: p.connected ? 'Online' : 'Offline' }),
    h('span', { class: 'lp-name', text: p.name }),
    h('span', { class: 'lp-tags' }, p.isHost && tag('Host', 'host'), me && tag('You', 'you'), !p.connected && tag('Offline', 'off')),
    d.isHost && !me && h('span', { class: 'admin' },
      h('button', { class: 'btn xs ghost', testid: 'transfer-btn', act: 'transfer', 'data-player-id': p.id, disabled: !d.canAdmin, title: `Make ${p.name} the host` }, 'Make host'),
      h('button', { class: 'btn xs danger', testid: 'kick-btn', act: 'kick', 'data-player-id': p.id, disabled: !d.canAdmin, title: `Remove ${p.name}` }, 'Kick')));
}
function vSpectators(s, d) {
  const list = s.spectators || [];
  if (!list.length && s.phase !== 'lobby') return null;
  return h('section', { class: 'panel spectators' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'Spectators' }), h('span', { class: 'meta', text: String(list.length) })),
    list.length ? h('ul', { class: 'spec-list' }, list.map((x) => h('li', { key: x.id, class: ['sp-row', !x.connected && 'offline'] },
      h('span', { class: ['dot', x.connected ? 'on' : 'off'] }),
      h('span', { class: 'lp-name', text: x.name }),
      x.id === s.you.id && tag('You', 'you'),
      d.isHost && x.id !== s.you.id && h('button', { class: 'btn xs danger', testid: 'kick-btn', act: 'kick', 'data-player-id': x.id, disabled: !d.canAdmin, title: `Remove ${x.name}` }, 'Kick'))))
      : h('p', { class: 'fine pad', text: 'Nobody is watching yet. Anyone with the link can press Watch.' }));
}
const OPTION_FIELDS = [
  ['speechSeconds1', 'Round 1 speech', 'Each player\'s turn in round 1'],
  ['speechSeconds', 'Speech', 'Each turn from round 2'],
  ['discussionSeconds', 'Discussion', 'Open discussion each round'],
  ['defenseSeconds', 'Defense', 'Each tied player before a revote'],
];
// Presets set all four timers at once; the one matching the current values is marked.
function vPresets(s, d) {
  const o = draftOptions(s);
  const cur = TIMER_PRESETS.find((p) => Object.keys(p.v).every((k) => o[k] === p.v[k]));
  return h('div', { class: 'presets', role: 'group', 'aria-label': 'Timer presets' },
    TIMER_PRESETS.map((p) => h('button', {
      class: ['preset', cur === p && 'on'], key: p.id, act: 'preset', 'data-preset': p.id, 'aria-pressed': String(cur === p),
      disabled: !d.isHost || !d.online, title: `Round 1 speech ${p.v.speechSeconds1} s, speeches ${p.v.speechSeconds} s, discussion ${p.v.discussionSeconds} s, defense ${p.v.defenseSeconds} s${d.isHost ? '' : ' (only the host can change the timers)'}`,
    }, h('span', { class: 'pr-l', text: p.label }), h('span', { class: 'pr-h mono', text: p.hint }))));
}
function vLobbySettings(s, d) {
  const o = s.options || {};
  return h('section', { class: 'panel settings' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'Timers' }), h('span', { class: 'meta', text: d.isHost ? 'seconds · you can edit' : 'seconds · set by host' })),
    vPresets(s, d),
    h('div', { class: 'opt-list' }, OPTION_FIELDS.map(([key, label, hint]) => h('label', { class: 'opt-row', key },
      h('span', { class: 'opt-text' }, h('span', { class: 'opt-label', text: label }), h('span', { class: 'opt-hint', text: hint })),
      d.isHost
        ? h('input', { class: 'input num mono', type: 'number', min: '5', max: '600', step: '5', inputmode: 'numeric', 'data-field': 'opt:' + key, value: String(o[key]), 'aria-label': label + ' (seconds)', disabled: !d.online })
        : h('span', { class: 'opt-val mono', text: `${o[key]} s` })))),
    h('p', { class: 'fine pad', text: 'Timers are only a guide: nothing happens automatically when one runs out. The host moves the game on with Next.' }));
}
// The timers the estimate uses: the room's, with the host's unsent edits on top (X4: it follows the typing).
function draftOptions(s) {
  const o = { ...(s.options || {}) };
  for (const [k, v] of Object.entries(ui.optDraft)) if (Number.isInteger(v) && v >= 5 && v <= 600 && k in o) o[k] = v;
  return o;
}
// SPEC §11 X4: the estimated game length, from the shared KICKS table (public/kicks.js) and the timers.
function vEstimate(s, n) {
  const minimum = n < s.minPlayers;
  const N = Math.max(2, Math.min(16, minimum ? s.minPlayers : n));
  const o = draftOptions(s);
  const est = estimateGame(N, o);
  const preset = TIMER_PRESETS.find((p) => Object.keys(p.v).every((k) => o[k] === p.v[k]));
  return h('div', { class: 'estimate', testid: 'time-estimate', 'data-minutes': String(est.mid), 'data-seconds': String(Math.round(est.seconds)), 'data-players': String(N) },
    h('div', { class: 'est-row' },
      h('span', { class: 'k', text: 'Estimated game length' }),
      h('span', { class: 'est-main' },
        h('b', { class: 'est-v mono', text: `≈ ${est.mid} min` }),
        h('span', { class: 'est-range mono', text: `(${est.lo}–${est.hi} min)` }))),
    h('p', { class: 'est-sub', text: `${minimum ? `with ${s.minPlayers} players (minimum)` : `with ${plural(N, 'player')}`} · ${preset ? `${preset.label} timers` : 'custom timers'}` }),
    h('p', { class: 'est-note', text: "Timers are a guide, so the real pace depends on the host's Next." }));
}
function vLobbySchedule(s, n) {
  const kicks = (s.schedule && s.schedule.kicksByRound && s.schedule.kicksByRound.length) ? s.schedule.kicksByRound : (KICKS[n] || []);
  const beds = Math.floor(n / 2);
  const total = kicks.reduce((a, b) => a + b, 0);
  return h('section', { class: 'panel schedule' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'If you start now' }), h('span', { class: 'meta', text: plural(n, 'player') })),
    vEstimate(s, n),
    n >= 2 ? h('div', { class: 'sched' },
      h('div', { class: 'sched-stats' },
        kv('Beds', String(beds), 'big'), kv('Ejected', String(total), 'big'), kv('Rounds', '7', 'big')),
      h('ol', { class: 'round-track wide' }, kicks.map((k, i) => h('li', { class: ['rt', k > 0 && 'rt-vote'], title: k > 0 ? `After round ${i + 1}: ${plural(k, 'ejection')}` : `Round ${i + 1}: no vote` },
        h('span', { class: 'rt-n', text: String(i + 1) }), h('span', { class: 'rt-k', text: k > 0 ? '✖' + k : '·' })))),
      h('p', { class: 'fine', text: '✖ marks the rounds that end with a vote, and how many players leave in it.' }))
      : h('p', { class: 'fine pad', text: 'The schedule appears once two players are seated.' }));
}
function vRules() {
  return h('section', { class: 'panel rules' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'How a round works' })),
    h('p', { class: 'rules-goal' }, h('b', { text: 'The goal. ' }), 'The bunker has beds for half of you. Get a bed, and make sure the ones inside can rebuild humanity.'),
    h('ol', { class: 'rules-list' },
      h('li', null, h('b', { text: 'Reveals. ' }), 'In seat order each player reveals one hidden card and makes their case. Round 1 is always the Profession.'),
      h('li', null, h('b', { text: 'Discussion. ' }), 'Everyone argues on voice about who the bunker needs.'),
      h('li', null, h('b', { text: 'Vote. ' }), 'In the rounds marked ✖, players vote on who stays outside. Ties get a defense speech and a revote.'),
      h('li', null, h('b', { text: 'Specials. ' }), 'Everyone holds 2 secret special cards. You may play one per round; the server applies it.'),
      h('li', null, h('b', { text: 'Airlock. ' }), 'It needs a partner: two Airlocks from different players on the same player in the same round, before its discussion ends, throw them out, with no vote. Alone, it jams. From 4 players on, a Back from the Forest is always dealt too.'),
      h('li', null, h('b', { text: 'The end. ' }), 'When the players left fit in the beds, the doors close. Every card is revealed.')));
}

/* ---------- game */
function vGame() {
  const s = state;
  const d = derive(s);
  const final = s.phase === 'final';
  const wide = isConsole();
  const hand = d.isPlayer && !!s.me;
  return h('div', { class: ['shell', 'game', 'ph-' + s.phase, final && 'is-final'], testid: final ? 'final-screen' : null },
    h('div', { class: 'top' }, vHeader(s, d), connBanner()),
    h('div', { class: 'body' },
      h('main', { class: 'main-col' },
        final && vFinalBanner(s, d),
        !final && vRoleBanner(s, d),
        vAirlockAlert(s, d),
        vBriefing(s, d),
        h('div', { class: 'strips' }, wide ? null : vSituation(s, d, false), vLastVote(s)),
        !final && vStakes(s, d),
        vVotePanel(s, d),
        vTurnOrder(s, d),
        vBoard(s, d)),
      // desktop rail: the specials right under the hand (SPEC §10 groups them), so they are on screen from the start;
      // the full situation follows (round 1 also shows it as a briefing at the top of the table)
      h('aside', { class: 'side-col' },
        hand && s.me.notes.length ? vIntel(s) : null,
        hand ? vHand(s, d) : vWatcher(s, d),
        hand ? vSpecials(s, d) : null,
        wide ? vSituation(s, d, true) : null,
        vLog(s),
        d.isPlayer && (s.spectators || []).length ? vSpectators(s, d) : null,
        isNarrow() ? vLeavePanel(s, d) : null)),
    vBar(s, d));
}
// Round 1: the catastrophe and the bunker are what everyone argues from, so they open the table as a briefing
// (everyone, until dismissed) wherever the full situation panel is not already open on screen.
function briefingKey(s) {
  const log = s.log || [];
  let start = null;
  for (let i = log.length - 1; i >= 0; i--) if (log[i].kind === 'system' && /^Round 1 of /.test(log[i].text)) { start = log[i]; break; }
  return start ? `${s.room}:${start.id}` : `${s.room}:${s.catastrophe ? s.catastrophe.title : ''}`;
}
function vBriefing(s, d) {
  const c = s.catastrophe;
  const b = s.bunker;
  if (!c || !b || s.round !== 1 || s.overtime || (s.phase !== 'reveal' && s.phase !== 'discussion')) return null;
  if (!isConsole() && situationOpen(s)) return null;
  const key = briefingKey(s);
  if (!ui.briefed) ui.briefed = sGet('session', BRIEF_KEY) || '';
  if (ui.briefed === key) return null;
  const n = s.players.length;
  return h('section', { class: 'panel briefing', id: 'sec-briefing', 'aria-label': 'Briefing: the catastrophe and the bunker', 'data-key': key },
    h('div', { class: 'brief-head' },
      h('div', { class: 'brief-head-text' },
        h('div', { class: 'k', text: 'Briefing · what you argue about' }),
        narrTitle(h('h2', { class: 'brief-title', text: c.title }), s, 'briefing')),   // narrator hook: ▶ Listen
      h('button', { class: 'btn sm', act: 'briefing-close', 'data-key': key, title: 'Hide the briefing (the Situation panel keeps it all)' }, 'Got it')),
    h('p', { class: 'brief-text', text: c.text }),
    c.details && c.details.length ? h('ul', { class: 'brief-facts' }, c.details.map((x, i) => h('li', { key: 'd' + i, text: x }))) : null,
    h('div', { class: 'brief-bunker' },
      h('span', { class: 'k', text: 'The bunker' }),
      h('b', { text: b.name }),
      h('span', { text: ` · ${b.size} · ${b.duration} · ${b.food}` })),
    b.features && b.features.length ? h('p', { class: 'brief-feats' }, h('span', { class: 'k', text: 'Inside ' }), b.features.join(' · ')) : null,
    h('p', { class: 'brief-beds' }, h('b', { text: `${plural(s.capacity, 'bed')} for ${n} players` }), ` — ${plural(Math.max(0, n - s.capacity), 'player')} will stay in the forest.`));
}
function vJumpNav(s, d) {
  const hand = d.isPlayer && s.me;
  const items = [['sec-table', 'Table', 'The table'], [hand ? 'sec-hand' : 'sec-watch', hand ? 'Hand' : 'You', hand ? 'My hand' : 'Watching'], ['sec-situation', 'Info', 'Catastrophe and bunker'], ['sec-log', 'Log', 'Event log']];
  return h('nav', { class: 'jump', 'aria-label': 'Jump to section' }, items.map(([id, label, title]) => h('button', { class: 'jump-btn', act: 'jump', 'data-target': id, title, 'aria-label': title }, label)));
}
function vRoleBanner(s, d) {
  if (d.isSpectator) {
    return h('div', { class: 'role-banner watch', role: 'note' },
      h('span', { class: 'rb-k', text: 'Spectating' }),
      h('span', { class: 'rb-t', text: 'You see only public information: revealed cards, played specials, votes and the log.' }));
  }
  if (d.isPlayer && d.meP.status === 'ejected') {
    return h('div', { class: 'role-banner out', role: 'note' },
      h('span', { class: 'rb-k', text: 'You are out' }),
      h('span', { class: 'rb-t', text: `You stay in the forest and watch. Your hidden cards stay secret until the end.${d.isHost ? ' You are still the host.' : ''}` }));
  }
  return null;
}
// SPEC §11 X1.7: every open airlock, at the top of the table for everyone, with what happens next. A viewer whose
// Airlock would close one gets a Join button (it opens the ordinary Play flow of that card, the target highlighted).
function vAirlockAlert(s, d) {
  if (!d.inGame) return null;
  const list = airlocksOf(s).filter((a) => (byId(s, a.targetId) || {}).status === 'alive');
  if (!list.length) return null;
  const card = myAirlock(s);
  const canJoin = !!card && specialStatus(s, d, card).ok;
  const end = airEnd(s);
  // every Airlock of the game is played: nothing can close these any more, so they only wait to jam (no threat)
  const spent = airlocksLeft(s) === 0;
  return h('section', { class: ['panel airlock-alert', spent && 'spent'], id: 'sec-airlock', 'aria-label': 'Open airlocks', 'data-spent': spent ? 'true' : null },
    h('div', { class: 'aa-head' },
      icon('door', 'aa-ico'),
      h('span', { class: 'aa-k', text: list.length > 1 ? `${list.length} airlocks cycling` : 'Airlock cycling' }),
      h('span', { class: 'aa-when', text: spent
        ? `every Airlock in this game has been played, so ${list.length > 1 ? 'each' : 'it'} jams when ${end}`
        : `${list.length > 1 ? 'each jams' : 'jams'} if nobody closes it before ${end}` })),
    h('ul', { class: 'aa-list' }, list.map((a) => {
      const t = byId(s, a.targetId);
      const onMe = a.targetId === s.you.id;
      const mine = a.byIds.includes(s.you.id);
      const join = canJoin && joinsAirlock(s, a);
      let line;
      if (spent) {
        const who = onMe ? `It is cycling on you, started by ${airlockStarters(s, a)}.` : mine ? 'You started it.' : `Started by ${airlockStarters(s, a)}.`;
        line = `${who} No Airlock card is left in the game, so ${onMe ? 'it cannot throw you out' : 'nobody can close it'}: it jams when ${end}.`;
      }
      else if (onMe) line = `It is cycling on you, started by ${airlockStarters(s, a)}. One more Airlock card from another player before ${end} and you are thrown out, with no vote. Make your case now.`;
      else if (mine) line = `You started it. Another player has to play their Airlock on ${t.name} before ${end} to throw ${t.name} out; otherwise it jams then.`;
      else if (join) line = `Started by ${airlockStarters(s, a)}. You hold an Airlock: play it on ${t.name} and ${t.name} is thrown out right now, with no vote.`;
      else line = `Started by ${airlockStarters(s, a)}. One more Airlock card on ${t.name} before ${end} throws ${t.name} out, with no vote.`;
      return h('li', { key: a.targetId, class: ['aa-item', onMe && 'on-me', join && 'joinable'], tabindex: join ? '-1' : null, 'data-focus-park': join ? '' : null },
        h('div', { class: 'aa-top' },
          h('button', { class: 'aa-who', act: 'jump-player', 'data-player-id': a.targetId, title: `Show ${t.name} on the table` },
            h('span', { class: 'aa-name', text: onMe ? `${t.name} (you)` : t.name }),
            h('span', { class: 'aa-count mono', text: airlockCount(a) })),
          join ? h('button', { class: 'btn sm danger aa-join', testid: 'airlock-join', act: 'special-open', 'data-uid': card.uid, 'data-player-id': a.targetId, disabled: d.shield || !d.online }, `Join: throw ${t.name} out`) : null),
        h('p', { class: 'aa-text', text: line }));
    })));
}
// SPEC §11 X1.7: an open airlock on the target's own panel ("AIRLOCK 1/2 · started by Anna").
function vAirlockStrip(s, p) {
  const a = airlockOn(s, p.id);
  if (!a || p.status !== 'alive' || !GAME_PHASES.includes(s.phase)) return null;
  const onMe = p.id === s.you.id;
  const spent = airlocksLeft(s) === 0;
  const end = airEnd(s);
  return h('div', { class: ['airlock-strip', onMe && 'on-me', spent && 'spent'], key: 'airlock' },
    h('span', { class: 'airlock-badge', testid: 'airlock-badge', 'data-player-id': p.id, 'data-count': String(a.byIds.length) },
      icon('door', 'ab-ico'), h('b', { class: 'ab-k', text: `AIRLOCK ${airlockCount(a)}` }), h('span', { class: 'ab-by', text: ` · started by ${airlockStarters(s, a)}` })),
    h('span', { class: 'ab-note', text: spent ? `no Airlock left in the game: it jams when ${end}`
      : onMe ? `one more Airlock on you before ${end}: you are out` : `one more Airlock before ${end}: out, no vote` }));
}
// What ended the game (the final banner): finalCause() in public/loglines.js reads the move logged right before "The
// bunker door closes" from the exact line shapes (a vote, a special or a sealed airlock, a leave or a kick).
function finalCauseText(s, c) {
  if (c.kind === 'special') return flashText(c.entry);
  if (c.kind === 'vote') return s.lastVoteResult ? resultSentence(s, s.lastVoteResult) : flashText(c.entry);
  if (c.kind === 'leave') return `${flashText(c.entry).replace(/\.$/, '')}.`;
  return '';
}
// The banner's special, as the flash reads it ("Anna played [Spy] → …"), with the chip only where the log line itself
// earns one (cardLine: a known title and exactly its text); an airlock line keeps its own chip.
function finalCauseSegs(s, c) {
  const m = !airlockLine(c.entry.text, c.entry.kind) ? cardLine(c.entry.text, seatNames, cardText) : null;
  if (m) return [{ t: 'text', v: `${m.name} played ` }, { t: 'card', title: m.title, v: m.title }, { t: 'text', v: ` → ${m.result}` }];
  return segmentsOf(finalCauseText(s, c));
}
function vFinalBanner(s, d) {
  const f = s.final || { survivors: [], out: [] };
  const inBunker = d.isPlayer && f.survivors.includes(d.meId);
  const bunkerName = s.bunker && s.bunker.name ? s.bunker.name : 'the bunker';
  const cause = finalCause(s);
  const causeText = finalCauseText(s, cause);
  return h('section', { class: 'final-banner' },
    h('div', { class: 'fb-hero' },
      trefoil('fb-wheel'),
      h('div', { class: 'fb-hero-text' },
        h('div', { class: 'fb-kicker', text: s.catastrophe ? s.catastrophe.title : 'After the catastrophe' }),
        h('h1', { class: 'fb-title', text: 'The door is sealed' }),
        h('p', { class: 'fb-sum', text: `${f.survivors.length} made it into ${bunkerName}. ${f.out.length} stayed in the forest.` }))),
    causeText ? h('p', { class: ['fb-cause', 'c-' + cause.kind], testid: 'final-cause', 'data-cause': cause.kind },
      h('span', { class: 'fb-cause-k', text: cause.kind === 'vote' ? 'The last vote' : cause.airlock ? 'Sealed by the airlock' : cause.kind === 'special' ? 'Sealed by a special' : 'Sealed by a departure' }),
      h('span', { class: 'fb-cause-t' }, cause.kind === 'special' ? richSegs(finalCauseSegs(s, cause), 'cause') : causeText)) : null,
    d.isPlayer && h('p', { class: ['fb-you', inBunker ? 'good' : 'bad'], text: inBunker ? 'You made it inside. Every card is face up now — was it the right crew?' : 'You stayed in the forest. Every card is face up now.' }),
    h('div', { class: 'fb-cols' },
      h('div', { class: 'fb-col in' }, h('div', { class: 'k', text: 'In the bunker' }),
        h('ul', { class: 'chips' }, f.survivors.map((id) => h('li', { class: 'chip good', key: id, text: nameOf(s, id) })))),
      h('div', { class: 'fb-col out' }, h('div', { class: 'k', text: 'Stayed in the forest' }),
        h('ul', { class: 'chips' }, f.out.map((id) => { const p = byId(s, id); return h('li', { class: 'chip bad', key: id }, nameOf(s, id), p && p.status === 'left' ? h('span', { class: 'chip-sub', text: ' (left)' }) : null); })))));
}
// rail = the always-visible desktop version in the side column; otherwise a one-line summary that expands.
function vSituation(s, d, rail) {
  const c = s.catastrophe;
  const b = s.bunker;
  if (!c && !b) return null;
  const open = rail || situationOpen(s);
  return h('section', { class: ['panel situation', open ? 'open' : 'closed', rail && 'rail'], id: 'sec-situation' },
    rail
      ? h('div', { class: 'panel-head' }, h('h2', { text: 'Situation' }), h('span', { class: 'meta', text: `${s.capacity} beds` }))
      : h('button', { class: 'sit-bar', act: 'toggle-situation', 'aria-expanded': String(open) },
        h('span', { class: 'k', text: 'Situation' }),
        h('span', { class: 'sit-sum' },
          c && h('span', { class: 'sit-sum-cat', text: c.title }),
          b && h('span', { class: 'sit-sum-sep', text: ' · ' }),
          b && h('span', { class: 'sit-sum-b', text: `${b.name} · ${b.size} · ${b.duration}` })),
        h('span', { class: 'sit-toggle mono', text: open ? 'Hide ▴' : 'Show ▾' })),
    open && h('div', { class: 'sit-grid' },
      c && h('div', { class: 'sit-block sit-cat' },
        h('div', { class: 'k', text: 'Catastrophe' }),
        narrTitle(h('h3', { class: 'sit-title', text: c.title }), s, rail ? 'rail' : 'situation'),   // narrator hook: ▶ Listen
        h('p', { class: 'sit-text', text: c.text }),
        c.details && c.details.length ? h('ul', { class: 'facts' }, c.details.map((x, i) => h('li', { key: 'd' + i, text: x }))) : null),
      b && h('div', { class: 'sit-block sit-bunker' },
        h('div', { class: 'k', text: 'The bunker' }),
        h('h3', { class: 'sit-title', text: b.name }),
        h('dl', { class: 'dl' },
          h('dt', { text: 'Size' }), h('dd', { text: b.size }),
          h('dt', { text: 'Stay' }), h('dd', { text: b.duration }),
          h('dt', { text: 'Food' }), h('dd', { text: b.food }),
          h('dt', { text: 'Beds' }), h('dd', { text: bedsText(s) })),
        h('div', { class: 'k sub', text: `Features (${b.features.length})` }),
        h('ul', { class: 'facts' }, b.features.map((x, i) => h('li', { key: 'f' + i, text: x }))))));
}
// The beds are half of the players at the start, until a special card adds or removes one.
function bedsText(s) {
  const start = Math.floor(s.players.length / 2);
  if (s.capacity === start) return `${s.capacity} (half of the ${s.players.length} players at the start)`;
  return `${s.capacity} (${start} at the start; ${s.capacity > start ? 'a special card added' : 'a special card took away'} ${plural(Math.abs(s.capacity - start), 'bed')})`;
}
// Below the console layout (the rail there is always open): open by default on laptop widths (>= 1024 px);
// collapsed on phones and tablets, so the player's own hand and the table come first — the one-line summary still
// names the catastrophe and the bunker, and the viewer's choice is kept for the rest of the game.
// A vote or a defense, and a short laptop screen (a 768p display at 125 %), start with it collapsed too: there the
// open panel filled the whole space between the header and the action bar.
function situationOpen(s) {
  const bucket = s.phase === 'final' ? 'final' : 'play';
  if (ui.situation && ui.situation.room === s.room && ui.situation.phase === bucket) return ui.situation.open;
  return isMatrix() && s.phase !== 'final' && s.phase !== 'vote' && s.phase !== 'defense' && mq('(min-height: 700px)');
}
function vStakes(s, d) {
  const alive = d.aliveList.length;
  const mustGo = Math.max(0, alive - s.capacity);
  const sch = s.schedule || {};
  let voteLine;
  if (s.phase === 'vote' || s.phase === 'defense') voteLine = `Voting now: ${plural(s.vote ? ballotsOf(s) : sch.kicksThisStep || 0, 'ejection')} in this step`;
  else if (s.voteMods && s.voteMods.cancelNext) voteLine = 'The next vote is cancelled by a special';
  else if (sch.kicksThisStep > 0) voteLine = `Vote after this round's discussion: ${plural(sch.kicksThisStep, 'player')} out`;
  else if (sch.nextVoteRound) voteLine = `No vote this round · next vote after round ${sch.nextVoteRound}`;
  else voteLine = 'No more votes scheduled';
  return h('section', { class: 'stakes' },
    vRoundTrack(s, 'stakes-track'),
    h('div', { class: 'stakes-nums' },
      kv('Out', String(d.outList.length)),
      kv('To leave', String(mustGo), mustGo > 0 ? 'red' : 'ok', { title: 'Players still in the game minus beds' })),
    h('div', { class: 'stakes-vote', text: voteLine }));
}
// Odd rounds go up the seats ("clockwise"), even rounds come back down.
function dirText(s) { return s.round % 2 === 1 ? 'clockwise (seats ↑)' : 'counter-clockwise (seats ↓)'; }
function vTurnOrder(s, d) {
  const t = s.turn;
  if (!t) return null;
  const title = t.kind === 'reveal' ? `Speaking order · round ${s.round} · ${dirText(s)}` : 'Defense order · then a revote';
  return h('section', { class: 'turn-order', 'aria-label': title },
    h('span', { class: 'k' }, t.kind === 'reveal' ? h('span', { class: 'dir-glyph', 'aria-hidden': 'true', text: s.round % 2 === 1 ? '↻' : '↺' }) : null, title),
    h('ol', { class: 'to-list' }, t.order.map((id, i) => {
      const p = byId(s, id);
      const skipped = !p || p.status !== 'alive';
      const st = i < t.index ? 'done' : i === t.index ? 'now' : 'todo';
      const off = !!p && !skipped && !p.connected && st !== 'done';
      return h('li', { key: id + ':' + i },
        h('button', { class: ['to', 'to-' + st, skipped && i !== t.index && 'to-skip', id === s.you.id && 'to-me', off && 'to-off'], act: 'jump-player', 'data-player-id': id, title: off ? `${p.name} is offline — show on the table` : 'Show this player on the table' },
          h('span', { class: 'to-mark', text: st === 'done' ? '✓' : st === 'now' ? '▶' : String(i + 1) }),
          h('span', { class: 'to-name', text: p ? p.name : '?' }),
          off ? h('span', { class: 'to-off-tag', text: 'offline' }) : null));
    })));
}

/* ---------- vote panel */
function vVotePanel(s, d) {
  const v = s.vote;
  const r = s.lastVoteResult;
  if (s.phase === 'vote' && v) {
    const revote = v.stage === 'revote';
    const missing = v.voters.filter((id) => !v.voted.includes(id));
    const mods = s.voteMods || { immune: [], blocked: [], doubleVote: [] };
    const showPrev = lastOpen(s);
    let mine = null;
    if (d.amVoter) {
      mine = d.myVote
        ? h('p', { class: 'vp-mine done' }, h('span', { class: 'vp-mine-k', text: 'You voted' }), h('b', { text: nameOf(s, d.myVote) }), ' stays outside — you can change it until the vote closes.')
        : h('p', { class: 'vp-mine todo' }, h('span', { class: 'vp-mine-k', text: 'Your vote' }),
          ui.voteWiped && ui.voteWiped.key === ballotKey(s) ? `${ui.voteWiped.text.replace(/: vote again\.$/, '')}: tap a name in the bar below.` : 'Not cast yet: tap a name in the bar below.');
    } else if (d.isPlayer && d.alive && s.voteMods.blocked.includes(d.meId)) {
      mine = h('p', { class: 'vp-mine none' }, h('span', { class: 'vp-mine-k', text: 'Blocked' }), 'A special card took your vote in this vote step.');
    }
    return h('section', { class: ['panel vote-panel ballot', revote && 'revote'], id: 'sec-vote' },
      h('div', { class: 'vp-head' },
        h('div', { class: 'vp-head-text' },
          h('div', { class: 'vp-kicker' }, revote ? 'Revote · tie-break' : 'Ballot', ` · ${v.ballot} of ${ballotsOf(s)}`),
          h('h2', { class: 'vp-title', text: revote ? `Revote: ${listText(namesOf(s, v.candidates))}` : 'Who stays outside?' }),
          h('p', { class: 'vp-sub', text: revote
            ? 'They tied and have defended themselves; only they can be voted out now. Still tied → fate decides.'
            : 'Secret until the vote closes, then everyone sees who voted for whom. Votes can be changed until then.' })),
        h('div', { class: 'vp-progress' },
          h('span', { class: 'vp-count mono', text: `${v.voted.length}/${v.voters.length} voted` }),
          h('div', { class: 'vp-meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(v.voters.length), 'aria-valuenow': String(v.voted.length) },
            h('div', { class: 'vp-meter-fill', style: `width:${v.voters.length ? Math.round(100 * v.voted.length / v.voters.length) : 100}%` })),
          h('p', { class: 'vp-wait' }, missing.length ? [h('span', { class: 'k', text: 'Waiting for ' }), missing.map((id) => { const p = byId(s, id); return nameOf(s, id) + (p && !p.connected ? ' (offline)' : ''); }).join(', ')] : 'Everyone has voted.'))),
      mine,
      (mods.immune.length || mods.blocked.length || mods.doubleVote.length || !d.amVoter) ? h('div', { class: 'vp-grid' },
        !d.amVoter && h('div', { class: 'vp-col' }, h('span', { class: 'k', text: `Can be voted out (${v.candidates.length}) ` }), namesOf(s, v.candidates).join(', ')),
        (mods.immune.length || mods.blocked.length || mods.doubleVote.length) ? h('ul', { class: 'mods' },
          mods.immune.map((id) => h('li', { key: 'i' + id }, tag('Immune', 'immune'), ' ', nameOf(s, id), h('span', { class: 'fine', text: ' can’t be voted out' }))),
          mods.blocked.map((id) => h('li', { key: 'b' + id }, tag('Blocked', 'blocked'), ' ', nameOf(s, id), h('span', { class: 'fine', text: ' can’t vote' }))),
          mods.doubleVote.map((id) => h('li', { key: 'x' + id }, tag('×2', 'double'), ' ', nameOf(s, id), h('span', { class: 'fine', text: ' vote counts twice' })))) : null) : null,
      r && h('div', { class: ['vp-last', showPrev && 'open'] },
        h('button', { class: 'sit-bar', act: 'toggle-last', 'aria-expanded': String(showPrev) },
          h('span', { class: 'k', text: 'Previous result' }),
          h('span', { class: 'sit-sum', text: resultSentence(s, r) }),
          h('span', { class: 'sit-toggle mono', text: showPrev ? 'Hide ▴' : 'Details ▾' })),
        showPrev && vResults(s, r)));
  }
  if (s.phase === 'defense' && s.turn) {
    const tied = s.turn.order;
    return h('section', { class: 'panel vote-panel defense', id: 'sec-vote' },
      h('div', { class: 'vp-head' },
        h('div', { class: 'vp-head-text' },
          h('div', { class: 'vp-kicker', text: 'Tie · defense speeches' }),
          h('h2', { class: 'vp-title', text: `${listText(namesOf(s, tied))} tied` }),
          h('p', { class: 'vp-sub', text: `Each of them gets ${s.options.defenseSeconds} s to defend themselves, in seat order. Then a revote between them only. If that ties too, fate decides.` }))),
      r && h('div', { class: 'vp-last' }, h('div', { class: 'k', text: 'Why there is a defense' }), vResults(s, r)));
  }
  return null;
}
// The last result: while it is fresh (until the next discussion starts) the strip shows who voted for whom in a
// compact form; Details opens the full table. Inside the vote panel (the next ballot) it starts collapsed.
function lastOpen(s) {
  if (ui.showLast !== null) return ui.showLast;
  return false;
}
function lastBrief(s) {
  return ui.showLast === null && ui.resultFresh && s.phase !== 'vote' && s.phase !== 'final';
}
function vLastVote(s) {
  const r = s.lastVoteResult;
  if (r && s.phase !== 'lobby' && s.phase !== 'vote' && s.phase !== 'defense') {
    const open = lastOpen(s);
    const brief = !open && lastBrief(s) && r.tally.some((x) => x.votes > 0);
    // at the final, a vote that did not end the game is an earlier one (the banner tells what did)
    const label = s.phase === 'final' && finalCause(s).kind !== 'vote' ? 'Earlier vote' : 'Last vote';
    return h('section', { class: ['panel last-vote', open && 'open', brief && 'brief'] },
      h('button', { class: 'sit-bar', act: 'toggle-last', 'aria-expanded': String(open) },
        h('span', { class: 'k', text: label }),
        h('span', { class: 'sit-sum', text: resultSentence(s, r) }),
        h('span', { class: 'sit-toggle mono', text: open ? 'Hide ▴' : 'Details ▾' })),
      brief && vTallyBrief(s, r),
      open && h('div', { class: 'lv-body' }, vResults(s, r)));
  }
  return null;
}
// "Sasha 6 ← Alex, Ivan, …" for every candidate who got votes, flowing on one or two lines.
function vTallyBrief(s, r) {
  const rows = r.tally.filter((x) => x.votes > 0);
  return h('ul', { class: 'tally-brief', 'aria-label': 'Who voted for whom' }, rows.map((x) => h('li', { key: x.targetId, class: [x.targetId === r.ejectedId && 'out', r.tie && r.tie.includes(x.targetId) && 'tie'] },
    h('b', { class: 'tb-name', text: nameOf(s, x.targetId) }),
    h('span', { class: 'tb-n mono', text: String(x.votes) }),
    h('span', { class: 'tb-arrow', 'aria-hidden': 'true', text: '←' }),
    h('span', { class: 'tb-v', text: x.voterIds.length ? namesOf(s, x.voterIds).join(', ') + (x.votes > x.voterIds.length ? ' (incl. a ×2 vote)' : '') : '—' }))));
}
function resultSentence(s, r) {
  if (r.cancelled) return 'The vote was cancelled by a special card — nobody was ejected.';
  if (r.ejectedId) {
    const top = r.tally.find((x) => x.targetId === r.ejectedId);
    const votes = top ? ` with ${plural(top.votes, 'vote')}` : '';
    if (r.random && r.tally.every((x) => x.votes === 0)) return `Nobody voted — fate decided: ${nameOf(s, r.ejectedId)} is out.`;
    if (r.random) return `Still tied — fate decided: ${nameOf(s, r.ejectedId)} is out.`;
    return `${nameOf(s, r.ejectedId)} was voted out${votes}.`;
  }
  if (r.tie) return `Tie between ${listText(namesOf(s, r.tie))} → defense speeches, then a revote.`;
  return 'Nobody was left to eject.';
}
function vResults(s, r) {
  if (r.cancelled) return h('p', { class: 'callout info', testid: 'vote-result', text: resultSentence(s, r) });
  const max = Math.max(1, ...r.tally.map((x) => x.votes));
  const withVotes = r.tally.filter((x) => x.votes > 0);
  const zero = r.tally.filter((x) => x.votes === 0);
  return h('div', { class: 'results', testid: 'vote-result' },
    h('p', { class: ['result-line', r.ejectedId ? 'bad' : r.tie ? 'warn' : ''], text: `${r.stage === 'revote' ? 'Revote' : 'Main vote'}: ${resultSentence(s, r)}` }),
    withVotes.length ? h('table', { class: 'rtable' },
      h('thead', null, h('tr', null, h('th', { text: 'Against' }), h('th', { class: 'num', text: 'Votes' }), h('th', { text: 'Voted by' }))),
      h('tbody', null, withVotes.map((x) => h('tr', { key: x.targetId, class: [x.targetId === r.ejectedId && 'ejected', r.tie && r.tie.includes(x.targetId) && 'tied'] },
        h('th', { scope: 'row' }, h('span', { text: nameOf(s, x.targetId) }), x.targetId === r.ejectedId ? h('span', { class: 'tag tag-out', text: 'Out' }) : null, r.tie && r.tie.includes(x.targetId) && !r.ejectedId ? h('span', { class: 'tag tag-tie', text: 'Tie' }) : null),
        h('td', { class: 'num' }, h('span', { class: 'bar-mini', style: `width:${Math.round(56 * x.votes / max)}px` }), h('b', { class: 'mono', text: String(x.votes) })),
        h('td', { class: 'voters', text: x.voterIds.length ? namesOf(s, x.voterIds).join(', ') + (x.votes > x.voterIds.length ? '  (incl. a ×2 vote)' : '') : '—' }))))) : null,
    zero.length ? h('p', { class: 'fine', text: `No votes: ${namesOf(s, zero.map((x) => x.targetId)).join(', ')}` }) : null);
}

/* ---------- board */
const ICON_PATHS = {
  crown: ['M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z'],
  kick: ['M6 6l12 12M18 6L6 18'],
  spark: ['M13 2 4.5 13.5H11L10 22l8.5-11.5H12z'],
  door: ['M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21', 'M3 21h18', 'M12 7.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', 'M12 7.5v7M8.5 11h7'],
};
function icon(name, cls) {
  return svg('svg', { class: 'ico' + (cls ? ' ' + cls : ''), viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    (ICON_PATHS[name] || []).map((dd) => svg('path', { d: dd })));
}
// Host tools on a player panel: small, quiet icon buttons (always present for the host, as §10 requires), kept
// away from the vote buttons: they sit next to the name, never in the Vote column.
function vHostTools(s, d, p) {
  const isMe = p.id === s.you.id;
  if (!d.isHost || isMe || p.status === 'left') return null;
  const armed = isArmed('kick:' + p.id);
  const settling = armed && !armReady('kick:' + p.id);
  return h('span', { class: 'hostx' },
    h('button', { class: 'icon-btn', testid: 'transfer-btn', act: 'transfer', 'data-player-id': p.id, disabled: !d.canAdmin, title: `Make ${p.name} the host`, 'aria-label': `Make ${p.name} the host` }, icon('crown')),
    h('button', {
      class: ['icon-btn danger', armed && 'armed', settling && 'settling'], testid: 'kick-btn', act: 'kick', 'data-player-id': p.id, disabled: !d.canAdmin || settling,
      title: armed ? `Tap again to remove ${p.name} for good` : `Remove ${p.name} from the game (no undo; tap twice)`,
      'aria-label': armed ? `Tap again to remove ${p.name} for good` : `Kick ${p.name}`,
    }, armed ? h('span', { class: 'arm-text', text: 'Remove?' }) : icon('kick')));
}
// table = the players x categories matrix (desktop), cards = one panel per player with every text in full.
// Phones and small tablets always get the panels (hidden cards collapse into one row of card backs).
function boardView(s) {
  const final = s.phase === 'final';
  if (!isMatrix()) return 'cards';
  const v = prefs.view && prefs.view[final ? 'final' : 'play'];
  if (v === 'table' || v === 'cards') return v;
  return final ? 'cards' : 'table';
}
function playerFlags(s, d, p) {
  const t = s.turn;
  const v = s.vote;
  const mods = s.voteMods || { immune: [], blocked: [], doubleVote: [] };
  const o = {
    isMe: p.id === s.you.id,
    final: s.phase === 'final',
    speaking: !!t && t.speakerId === p.id && p.status === 'alive',
    cand: !!v && v.candidates.includes(p.id),
    voter: !!v && v.voters.includes(p.id),
    voted: !!v && v.voted.includes(p.id),
    immune: mods.immune.includes(p.id),
    blocked: mods.blocked.includes(p.id),
    dbl: mods.doubleVote.includes(p.id),
    myPick: d.myVote === p.id,
    defending: s.phase === 'defense' && !!t && t.order.includes(p.id),
    expanded: ui.expanded.has(p.id),
  };
  const nx = t ? nextInOrder(s) : null;
  o.isNext = !!nx && nx.id === p.id;
  const oa = outAt.get(p.id);
  o.slam = !!oa && Date.now() - oa < 1500;
  const stamp = !o.final && p.status !== 'alive'
    ? h('span', { class: ['stamp-tag', p.status === 'left' ? 'grey' : 'red', o.slam && 'slam'], title: p.status === 'left' ? 'Left the game' : 'Voted out or ejected: stays in the forest', text: p.status === 'left' ? 'Left' : 'Ejected' })
    : null;
  o.tags = [
    o.speaking && tag(t.kind === 'defense' ? 'Defending' : 'Speaking', 'speak'),
    !o.speaking && o.isNext && tag('Next', 'next'),
    o.isMe && tag('You', 'you'),
    p.isHost && tag('Host', 'host'),
    stamp,
    o.final && p.status === 'left' && tag('Left', 'left'),
    !p.connected && p.status !== 'left' && !o.final && tag('Offline', 'off'),
    v && o.voter && tag(o.voted ? '✓ voted' : 'voting…', o.voted ? 'voted' : 'voting', o.voted ? 'Has voted (the choice stays secret until the vote closes)' : 'Has not voted yet'),
    o.myPick && tag('Your vote', 'myvote', 'You voted to eject this player'),
    !o.final && o.immune && tag('Immune', 'immune', 'Nobody can vote against them in this vote step'),
    !o.final && o.blocked && tag('Blocked', 'blocked', 'Cannot vote in this vote step'),
    !o.final && o.dbl && tag('×2', 'double', 'Their vote counts twice'),
  ].filter(Boolean);
  return o;
}
function vBoard(s, d) {
  const cs = cats(s);
  const final = s.phase === 'final';
  const view = boardView(s);
  const n = s.players.length;
  const density = n <= 8 ? 'roomy' : n <= 12 ? 'medium' : 'dense';
  const tools = isMatrix() ? h('div', { class: 'board-tools' },
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Board view' },
      h('button', { class: ['seg-btn', view === 'table' && 'on'], act: 'board-view', 'data-view': 'table', 'aria-pressed': String(view === 'table'), title: 'Players × categories: compare everyone at a glance' }, 'Table'),
      h('button', { class: ['seg-btn', view === 'cards' && 'on'], act: 'board-view', 'data-view': 'cards', 'aria-pressed': String(view === 'cards'), title: 'One panel per player with every card text in full' }, 'Cards')),
    view === 'table' && h('button', { class: ['seg-btn solo', prefs.fullText && 'on'], act: 'full-text', 'aria-pressed': String(!!prefs.fullText), title: 'Show every card text in full (rows get taller)' }, 'Full text')) : null;
  const meta = final
    ? `${s.final ? s.final.survivors.length : 0} in the bunker · ${s.final ? s.final.out.length : 0} in the forest · NEW = first seen now`
    : `${d.aliveList.length} alive · ${d.outList.length} out${s.turn && s.turn.kind === 'reveal' ? ` · ${s.round % 2 === 1 ? '↻' : '↺'} ${dirText(s)}` : ''}${view === 'table' ? ' · hover or tap a card, or click a name, for full text' : ''}`;
  const head = h('div', { class: 'panel-head' },
    h('h2', { text: final ? 'Every card, face up' : 'The table' }),
    h('span', { class: 'meta', text: meta }),
    tools);
  if (view === 'cards') {
    let body;
    if (final && s.final) {
      const surv = s.final.survivors.map((id) => byId(s, id)).filter(Boolean);
      const out = s.players.filter((p) => !s.final.survivors.includes(p.id));
      body = [
        h('div', { class: 'seat-group in', key: 'g-in' },
          h('h3', { class: 'sg-title' }, trefoil('sg-ico'), h('span', { text: 'In the bunker' }), h('span', { class: 'sg-count', text: String(surv.length) })),
          h('div', { class: ['seats', density] }, surv.map((p) => vSeat(s, d, p)))),
        h('div', { class: 'seat-group out', key: 'g-out' },
          h('h3', { class: 'sg-title' }, h('span', { class: 'sg-tree', 'aria-hidden': 'true', text: '▲' }), h('span', { text: 'Stayed in the forest' }), h('span', { class: 'sg-count', text: String(out.length) })),
          h('div', { class: ['seats', density] }, out.map((p) => vSeat(s, d, p)))),
      ];
    } else body = h('div', { class: ['seats', density] }, s.players.map((p) => vSeat(s, d, p)));
    return h('section', { class: ['panel board-panel', 'view-cards'], id: 'sec-table' }, head, body);
  }
  const hd = h('div', { class: 'brow bhead', role: 'row' },
    h('div', { class: 'bc who', role: 'columnheader', text: 'Seat · player' }),
    cs.map((c) => h('div', { class: 'bc cat', role: 'columnheader', key: c.id, text: c.label })),
    h('div', { class: 'bc st', role: 'columnheader', text: s.phase === 'vote' ? 'Vote' : 'Status' }));
  let rows;
  if (final && s.final) {
    const surv = s.final.survivors.map((id) => byId(s, id)).filter(Boolean);
    const out = s.players.filter((p) => !s.final.survivors.includes(p.id));
    rows = [
      h('div', { class: 'bgroup good', key: 'g-in', role: 'row' }, h('span', { text: 'In the bunker' }), h('span', { class: 'meta', text: String(surv.length) })),
      surv.map((p) => vPlayerRow(s, d, p)),
      h('div', { class: 'bgroup bad', key: 'g-out', role: 'row' }, h('span', { text: 'Stayed in the forest' }), h('span', { class: 'meta', text: String(out.length) })),
      out.map((p) => vPlayerRow(s, d, p)),
    ];
  } else rows = s.players.map((p) => vPlayerRow(s, d, p));
  return h('section', { class: 'panel board-panel', id: 'sec-table' }, head,
    h('div', {
      class: ['board', 'matrix', density, d.isHost && 'with-adm', prefs.fullText && 'full'], role: 'table', 'aria-label': 'Players and their revealed cards',
      'data-cl': boardCl, style: boardCl !== 'none' ? `--cl:${boardCl}` : null,
    }, hd, rows));
}
function vPlayerRow(s, d, p) {
  const o = playerFlags(s, d, p);
  return h('div', {
    class: ['brow', 'prow', 'st-' + p.status, o.isMe && 'me', ui.flash && ui.flash.id === p.id && ui.flash.until > Date.now() && 'flash', o.speaking && 'speaking', !p.connected && 'offline', o.expanded && 'expanded', o.cand && 'cand', o.myPick && 'my-pick', o.defending && 'defending', o.slam && 'just-out'],
    role: 'row', key: p.id, testid: 'player-card', 'data-player-id': p.id, 'data-status': p.status,
    'data-connected': String(p.connected), 'data-speaking': o.speaking ? 'true' : null, 'data-voted': s.vote ? String(o.voted) : null,
  },
  h('div', { class: 'bc who', role: 'rowheader' },
    h('button', { class: 'who-main', act: 'expand', 'data-player-id': p.id, 'aria-expanded': String(o.expanded), title: o.expanded ? 'Collapse' : 'Show full card texts and specials' },
      h('span', { class: 'seat mono', text: pad2(p.seat + 1) }),
      h('span', { class: ['dot', p.status === 'left' ? 'gone' : p.connected ? 'on' : 'off'], 'aria-hidden': 'true' }),
      h('span', { class: 'pname', text: p.name })),
    vHostTools(s, d, p),
    o.tags.length ? h('div', { class: 'tags' }, o.tags) : null),
  cats(s).map((c) => vCell(s, p, c)),
  h('div', { class: 'bc st', role: 'cell' }, vStatusCell(s, d, p, o)),
  vAirlockStrip(s, p));
}
function cardInfo(s, p, c) {
  const txt = p.cards ? p.cards[c.id] : null;
  const key = p.id + ':' + c.id;
  const fa = freshAt.get(key);
  return {
    txt,
    fresh: txt != null && !!fa && Date.now() - fa < 6000,
    late: txt != null && s.phase === 'final' && hadPreFinal && !seenBeforeFinal.has(key),
  };
}
function vCell(s, p, c) {
  const { txt, fresh, late } = cardInfo(s, p, c);
  if (txt == null) {
    return h('div', { class: 'bc card hidden', role: 'cell', key: c.id, 'data-cat': c.id, title: `${c.label}: still hidden` },
      h('span', { class: 'clabel', text: c.label }),
      h('span', { class: 'cval', 'aria-label': 'hidden' }, h('span', { class: 'facedown' })));
  }
  // a text the matrix clamps shows in full in a popover on hover, focus or tap (SPEC §11 X3); the table view only.
  // Only a cell whose text is really cut off is a Tab stop (the layout decides: syncCellStops() after each render), so
  // the keyboard does not walk through every revealed card of a 16-player table on its way to the hand.
  const clampable = isMatrix() && !prefs.fullText;
  const popKey = `cell:${p.id}:${c.id}`;
  return h('div', {
    class: ['bc card up', fresh && 'fresh', late && 'late'], role: 'cell', key: c.id, 'data-cat': c.id, 'data-full': txt,
    'data-pop': 'clamp', 'data-pop-title': `${p.name} · ${c.label}${late ? ' · first seen at the end' : ''}`, 'data-pop-text': txt,
    'data-pop-key': popKey, tabindex: clampable && cutCells.has(popKey) ? '0' : null, 'aria-label': `${c.label}: ${txt}`,
  },
  h('span', { class: 'clabel', text: c.label }),
  h('span', { class: 'cval', text: txt }),
  late ? h('span', { class: 'new-tag', text: 'New' }) : null);
}
function vStatusCell(s, d, p, o) {
  const parts = [];
  const played = p.playedSpecials || [];
  const unplayed = p.unplayedSpecials || [];
  if (s.phase === 'vote' && s.vote) {
    const line = [];
    line.push(h('span', { class: ['vmark', o.voter ? (o.voted ? 'ok' : 'wait') : 'none'], title: o.voter ? (o.voted ? 'Has voted' : 'Has not voted yet') : 'Does not vote in this ballot', 'aria-label': o.voter ? (o.voted ? 'voted' : 'not voted yet') : 'no vote', text: o.voter ? (o.voted ? '✓' : '…') : '–' }));
    if (o.cand) {
      if (d.voteOpen && !o.isMe) {
        line.push(h('button', { class: ['btn xs vote-row', o.myPick ? 'picked' : ''], act: 'vote', 'data-player-id': p.id, disabled: !d.canVote, 'aria-pressed': String(o.myPick), 'aria-label': o.myPick ? `Your vote: ${p.name}` : `Vote ${p.name} out`, title: o.myPick ? 'Your current vote' : `Vote ${p.name} out` },
          o.myPick ? 'Yours ✓' : ['Vote', h('span', { class: 'xtra', text: ' out' })]));
      } else line.push(h('span', { class: 'st-line cand', text: o.myPick ? 'your vote' : 'candidate' }));
    }
    else if (p.status === 'alive' && (s.voteMods.immune || []).includes(p.id)) line.push(h('span', { class: 'st-line dim', text: 'immune' }));
    parts.push(h('span', { class: 'st-row' }, line));
  } else if (p.status === 'alive' || o.final) {
    const ts = turnState(s, p);
    parts.push(h('span', { class: 'st-row' },
      ts ? h('span', { class: ['st-line', ts.cls], title: ts.title || null, text: ts.text }) : null,
      h('span', { class: 'st-line dim mono', title: 'Cards revealed during play', text: `${p.revealedCount}/8` })));
  } else {
    parts.push(h('span', { class: 'st-row' }, h('span', { class: 'st-line dim', text: p.status === 'left' ? 'left the game' : 'in the forest' })));
  }
  if ((played.length || unplayed.length) && (s.phase !== 'vote' || o.expanded)) {
    parts.push(h('div', { class: ['sp-chips', o.final && 'wrap'] },
      played.map((x, i) => cardChip(x.title, x.text, { cls: 'sp-chip played', key: 'p' + i, popKey: `pl:${p.id}:${i}`, kicker: `Played by ${p.name}` })),
      unplayed.length ? h('span', { class: 'sp-never', key: 'nv', text: 'Never played:' }) : null,
      unplayed.map((x, i) => cardChip(x.title, x.text, { cls: 'sp-chip unplayed', key: 'u' + i, popKey: `un:${p.id}:${i}`, kicker: `${p.name}’s card · never played` }))));
  }
  if (o.expanded && (played.length || unplayed.length)) {
    parts.push(h('ul', { class: 'sp-detail' },
      played.map((x, i) => h('li', { key: 'dp' + i }, h('b', { text: x.title + ': ' }), x.text)),
      unplayed.map((x, i) => h('li', { key: 'du' + i, class: 'unplayed' }, h('b', { text: x.title + ' (never played): ' }), x.text))));
  }
  return parts;
}
// One panel per player: every revealed card in full on paper, hidden ones as a row of card backs, specials with
// their texts, and (in play) the turn or vote state. Used for the final and for the desktop "Cards" view.
function vSeat(s, d, p) {
  const o = playerFlags(s, d, p);
  const cs = cats(s);
  const played = p.playedSpecials || [];
  const unplayed = p.unplayedSpecials || [];
  const ups = [];
  const downs = [];
  for (const c of cs) {
    const { txt, fresh, late } = cardInfo(s, p, c);
    if (txt == null) { downs.push(h('span', { class: 'sc-back', key: c.id, title: `${c.label}: still hidden`, text: c.label })); continue; }
    ups.push(h('li', { class: ['sc', fresh && 'fresh', late && 'late'], key: c.id },
      h('span', { class: 'sc-k', text: c.label }),
      h('span', { class: 'sc-v', text: txt }),
      late ? h('span', { class: 'new-tag', text: 'New' }) : null));
  }
  let status = null;
  if (!o.final) {
    if (s.phase === 'vote' && s.vote && o.cand && d.voteOpen && !o.isMe) {
      status = h('button', { class: ['btn sm vote-row', o.myPick ? 'picked' : ''], act: 'vote', 'data-player-id': p.id, disabled: !d.canVote, 'aria-pressed': String(o.myPick) }, o.myPick ? 'Your vote ✓' : `Vote ${p.name} out`);
    } else if (p.status === 'alive') {
      const ts = turnState(s, p);
      status = h('span', { class: 'st-row' }, ts ? h('span', { class: ['st-line', ts.cls], title: ts.title || null, text: ts.title && /^Speaks/.test(ts.title) ? ts.title.replace('Speaks', 'speaks') : ts.text }) : null,
        o.cand ? h('span', { class: 'st-line cand', text: 'candidate' }) : null,
        h('span', { class: 'st-line dim mono', text: `${p.revealedCount}/8 revealed` }));
    }
  }
  return h('article', {
    class: ['seat-card', 'st-' + p.status, o.isMe && 'me', o.speaking && 'speaking', !p.connected && 'offline', o.cand && 'cand', o.myPick && 'my-pick', o.defending && 'defending', o.final && 'final'],
    key: p.id, testid: 'player-card', 'data-player-id': p.id, 'data-status': p.status, 'data-connected': String(p.connected),
    'data-speaking': o.speaking ? 'true' : null, 'data-voted': s.vote ? String(o.voted) : null,
  },
  h('header', { class: 'sc-head' },
    h('span', { class: 'sc-seat mono', text: String(p.seat + 1) }),
    h('span', { class: ['dot', p.status === 'left' ? 'gone' : p.connected ? 'on' : 'off'], 'aria-hidden': 'true' }),
    h('span', { class: 'sc-name', text: p.name }),
    vHostTools(s, d, p)),
  o.tags.length ? h('div', { class: 'tags' }, o.tags) : null,
  vAirlockStrip(s, p),
  ups.length ? h('ul', { class: 'sc-ups' }, ups) : null,
  downs.length ? h('div', { class: 'sc-downs', title: `${plural(downs.length, 'card')} still hidden` }, downs) : null,
  played.length ? h('ul', { class: ['sc-specials', !o.final && 'brief'] }, played.map((x, i) => h('li', { key: 'p' + i },
    cardChip(x.title, x.text, { cls: 'scs-chip', popKey: `pl:${p.id}:${i}`, kicker: `Played by ${p.name}` }),
    o.final ? h('span', { class: 'scs-x', text: x.text }) : null))) : null,
  unplayed.length ? h('div', { class: 'sc-never' }, h('span', { class: 'k', text: 'Never played' }),
    h('ul', { class: 'sc-specials never' }, unplayed.map((x, i) => h('li', { key: 'u' + i },
      cardChip(x.title, x.text, { cls: 'scs-chip unplayed', popKey: `un:${p.id}:${i}`, kicker: `${p.name}’s card · never played` }),
      h('span', { class: 'scs-x', text: x.text }))))) : null,
  status ? h('div', { class: 'sc-status' }, status) : null);
}

/* ---------- my hand */
function vHand(s, d) {
  const me = s.me;
  const cs = cats(s);
  const shown = cs.filter((c) => me.cards[c.id] && me.cards[c.id].revealed).length;
  const final = s.phase === 'final';
  const picking = d.canReveal || (d.isSpeaker && s.turn && s.turn.kind === 'reveal' && !s.turn.hasRevealed && d.eligible.length > 0);
  // the specials sit below the hand (below the fold on a laptop): the hand's head says they exist and jumps to them
  const spLeft = final ? 0 : (me.specials || []).filter((x) => !x.used).length;
  return h('section', { class: ['panel hand', picking && 'picking'], id: 'sec-hand' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'My hand' }), h('span', { class: 'meta', text: final ? 'every card is public now' : `${shown}/8 public · only you see the rest` }),
      spLeft ? h('button', { class: 'hand-sp-link', act: 'jump', 'data-target': 'sec-specials', title: 'Your special cards: one per round, any player can be surprised' }, `+ ${plural(spLeft, 'special')} ↓`) : null),
    picking && h('div', { class: 'callout hz', text: s.turn.mustReveal
      ? `Your turn — reveal your ${catLabel(s, s.turn.mustReveal)}: tap Reveal on the glowing card (or use the bar).`
      : 'Your turn — tap Reveal on one of the glowing cards (or use the bar). Everyone sees it at once.' }),
    h('ul', { class: 'hand-cards' }, cs.map((c) => {
      const card = me.cards[c.id] || { text: '?', revealed: false };
      const eligible = picking && d.eligible.includes(c.id);
      const fa = freshAt.get(s.you.id + ':' + c.id);
      const fresh = !!fa && Date.now() - fa < 6000;
      return h('li', { key: c.id, class: ['hc', card.revealed ? 'public' : 'secret', eligible && 'eligible', picking && !eligible && 'dim', fresh && 'fresh'] },
        h('span', { class: 'hc-label', text: c.label }),
        h('span', { class: 'hc-text', text: card.text }),
        eligible
          ? h('button', { class: 'btn xs primary hc-reveal', act: 'reveal', 'data-category': c.id, disabled: !d.canReveal, 'aria-label': `Reveal ${c.label}` }, 'Reveal')
          : h('span', { class: ['hc-state', card.revealed ? 'pub' : 'sec'], text: card.revealed ? 'Public' : final ? 'Unseen' : 'Secret' }));
    })));
}
function vSpecials(s, d) {
  const list = s.me.specials || [];
  const unused = list.filter((x) => !x.used).length;
  return h('section', { class: 'panel specials-panel', id: 'sec-specials' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'Special cards' }), h('span', { class: 'meta', text: s.phase === 'final' ? (unused ? `${unused} never played` : 'all played') : `${unused} unused · 1 per round` })),
    !list.length ? h('p', { class: 'fine pad', text: 'No special cards.' }) : null,
    list.map((sp) => {
      const st = specialStatus(s, d, sp);
      // SPEC §11 X1.7: an Airlock that would close someone else's open airlock says so, on the card and its button
      const joins = sp.effect === 'airlock' && !sp.used && st.ok ? joinableAirlocks(s, d) : [];
      const tNames = listText(joins.map((a) => nameOf(s, a.targetId)));
      return h('div', { key: sp.uid, class: ['special', sp.used && 'used', st.ok && 'ready', joins.length && 'joins'], tabindex: '-1', 'data-focus-park': '' },
        h('div', { class: 'sp-top' },
          h('span', { class: 'sp-title' }, cardChip(sp.title, sp.text, { cls: 'cc-lg', popKey: `my:${sp.uid}`, kicker: 'Your special card', meta: specialMeta(s, sp) })),
          h('span', { class: ['sp-state', sp.used ? 'used' : st.ok ? 'ready' : 'wait'], text: sp.used ? 'Played' : st.ok ? 'Ready' : 'Not now' })),
        h('p', { class: 'sp-text', text: sp.text }),
        joins.length ? h('p', { class: 'sp-join', testid: 'airlock-join-hint', 'data-player-id': joins.map((a) => a.targetId).join(' ') },
          icon('door', 'sp-join-ico'),
          h('span', null, h('b', { text: `Join the airlock on ${tNames}. ` }),
            joins.length === 1 ? `${airlockStarters(s, joins[0])} started it: play this card on ${tNames} and they are thrown out right now, with no vote.`
              : 'Someone else started them: play this card on one of them, and that player is thrown out right now, with no vote.')) : null,
        h('p', { class: 'sp-meta', text: specialMeta(s, sp) }),
        h('div', { class: 'sp-actions' },
          h('button', {
            class: ['btn sm', st.ok ? (joins.length ? 'danger-solid' : 'primary') : ''], testid: 'special-btn', act: 'special-open', 'data-uid': sp.uid,
            'data-effect': sp.effect, 'data-target': sp.target, disabled: !st.ok || d.shield,
          }, sp.used ? 'Played' : joins.length ? 'Join the airlock…' : 'Play…'),
          !st.ok && !sp.used && h('span', { class: 'sp-why', text: st.why })));
    }));
}
// Peek results: private, so they get their own box at the top of the rail (phones: right above the hand).
function vIntel(s) {
  const notes = s.me.notes || [];
  return h('section', { class: 'panel intel', id: 'sec-intel' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'Private intel' }), h('span', { class: 'meta', text: 'only you see this' })),
    h('ul', { class: 'note-list' }, notes.map((n, i) => h('li', { key: 'n' + i + ':' + n.ts }, h('time', { class: 'mono', text: hhmm(n.ts) }), h('span', { text: n.text })))));
}

function vWatcher(s, d) {
  const list = s.spectators || [];
  return h('section', { class: 'panel watcher', id: 'sec-watch' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'Watching' }), h('span', { class: 'meta', text: 'public view' })),
    h('p', { class: 'watch-text', text: 'You are a spectator: you see exactly what is public at the table — revealed cards, played specials, votes and the log. Hidden cards stay hidden until the final.' }),
    h('div', { class: 'k sub', text: `Spectators (${list.length})` }),
    h('ul', { class: 'spec-list' }, list.map((x) => h('li', { key: x.id, class: ['sp-row', !x.connected && 'offline'] },
      h('span', { class: ['dot', x.connected ? 'on' : 'off'] }),
      h('span', { class: 'lp-name', text: x.name }),
      x.id === s.you.id && tag('You', 'you'),
      d.isHost && x.id !== s.you.id && h('button', { class: 'btn xs danger', testid: 'kick-btn', act: 'kick', 'data-player-id': x.id, disabled: !d.canAdmin }, 'Kick')))));
}
function vLog(s) {
  const log = s.log || [];
  return h('section', { class: 'panel log-panel', id: 'sec-log' },
    h('div', { class: 'panel-head' }, h('h2', { text: 'Event log' }), h('span', { class: 'meta', text: log.length ? `${log.length} events` : 'empty' })),
    h('ol', { class: 'log', testid: 'log', role: 'log', 'aria-live': 'polite', tabindex: '0' },
      log.map((e) => h('li', { key: 'l' + e.id, class: ['le', 'k-' + e.kind, airlockLine(e.text, e.kind) && 'k-airlock'] },
        h('time', { class: 'mono', text: hhmm(e.ts) }),
        h('span', { class: 'lg mono', 'aria-hidden': 'true', text: LOG_GLYPH[e.kind] || '·' }),
        // a special card named in the line is a chip with its rules text (SPEC §11 X3)
        h('span', { class: 'lt' }, richText(e.text, `log:${e.id}`))))));
}

/* ---------- the action bar: what is happening + what I can do, in plain words */
function nextButton(s, d) {
  const t = s.turn;
  let main = 'Next';
  let sub = '';
  // on the host's own turn Next is toned down: it would skip their own choice
  const ownTurn = d.isSpeaker && !!t && (s.phase === 'reveal' || s.phase === 'defense');
  // …and so it is while another player is online and still within their time: Next would take their pick (a random
  // card is revealed for them) or cut their speech. It becomes the primary button when the speaker is offline or
  // their timer has run out, which is when the host is actually needed.
  const sp = d.speaker;
  const spOffline = !!sp && sp.status === 'alive' && !sp.connected;
  const speakerBusy = !!t && !!sp && sp.status === 'alive' && sp.connected && !!s.timer && s.timer.endsAt > serverNow();
  if (s.phase === 'reveal' && t) {
    const nx = nextInOrder(s);
    main = nx ? `Next: ${nx.name}'s turn` : 'Next: discussion';
    if (sp && sp.status === 'alive' && !t.hasRevealed && speakerHasEligible(s, sp, t)) {
      sub = ownTurn ? (t.mustReveal ? `skips your turn · reveals your ${catLabel(s, t.mustReveal)}` : 'skips your pick · reveals a random card of yours')
        : spOffline ? `${sp.name} is offline · reveals a card for them`
          : t.mustReveal ? `reveals ${sp.name}'s ${catLabel(s, t.mustReveal)} for them` : `takes ${sp.name}'s pick · reveals a random card`;
    } else sub = ownTurn ? 'ends your turn' : spOffline ? `${sp.name} is offline · moves on` : nx ? 'ends the current turn' : 'ends the reveals';
  } else if (s.phase === 'defense' && t) {
    const nx = nextInOrder(s);
    main = nx ? `Next: ${nx.name} defends` : 'Next: start the revote';
    sub = spOffline ? `${sp.name} is offline · moves on` : nx ? 'ends this defense speech' : 'between the tied players';
  } else if (s.phase === 'discussion') {
    const k = (s.schedule && s.schedule.kicksThisStep) || 0;
    if (k > 0 && s.voteMods.cancelNext) { main = 'Next: skip the vote'; sub = 'it was cancelled by a special'; }
    else if (k > 0) { main = 'Next: start the vote'; sub = `${plural(k, 'player')} will be voted out`; }
    else if (s.round < s.maxRounds && !s.overtime) { main = `Next: round ${s.round + 1}`; sub = 'no vote this round'; }
    else { main = 'Next: final'; sub = 'close the bunker doors'; }
  } else if (s.phase === 'vote') {
    // the same move as Close vote, right next to it: kept (§10's hook), but small
    main = 'Next'; sub = '= Close vote';
  }
  const quiet = s.phase === 'vote' || ownTurn || ((s.phase === 'reveal' || s.phase === 'defense') && speakerBusy);
  return h('button', { class: ['btn host-btn next-btn', quiet ? 'ghost' : 'primary', ownTurn && 'own-turn', s.phase === 'vote' && 'vote-dup', d.cooling && !ui.inflight && 'cooling'], testid: 'next-btn', act: 'next', disabled: !d.canNext, title: s.phase === 'vote' ? 'Next closes the vote and counts it, the same as Close vote' : null },
    h('span', { class: 'b-main', text: main }), sub ? h('span', { class: 'b-sub', text: sub }) : null);
}
// SPEC §11 X6: "End game → back to the lobby". It ends the game for everyone, so it takes two taps like Leave and Kick
// (ARM_MS / ARM_MIN_MS: the second click of a double click never confirms), and it sits apart from Next, small.
const END_GAME_TEXT = 'Ends the game for everyone and returns to the lobby — late arrivals can then take a seat.';
function endGameButton(s, d) {
  const armed = isArmed('end-game');
  const settling = armed && !armReady('end-game');
  return h('button', {
    class: ['btn sm end-game', armed ? 'danger-solid armed' : 'ghost danger', settling && 'settling'], testid: 'end-game-btn', act: 'end-game',
    disabled: !d.online || !!ui.inflight || d.shield || settling,
    title: armed ? 'Tap again to end the game for everyone' : `End game → back to the lobby. ${END_GAME_TEXT} (tap twice)`,
    'aria-label': armed ? 'Tap again to end the game for everyone' : 'End the game and go back to the lobby (tap twice)',
  }, armed ? 'Tap again to end' : 'End game');
}
function barModel(s, d) {
  const m = { tone: 'wait', eyebrow: '', title: '', detail: '', choices: null, choiceKind: '', buttons: [], host: [] };
  const t = s.turn;
  const hostWho = d.isHost ? 'you' : d.hostName || 'the host';
  // The host dropped (a closed tab, a locked phone): nobody should be told to wait for their Next. The role passes on
  // by itself after a grace time (SPEC §6; the time is not in the state, so no number of seconds is promised).
  const hostP = s.hostId ? byId(s, s.hostId) : null;
  const hostOff = !d.isHost && !!hostP && !hostP.connected;
  const hostAway = hostOff ? `The host, ${hostP.name}, is offline: if they are not back soon, the host role passes to a player who is online.` : '';
  switch (s.phase) {
    case 'lobby': {
      const n = s.players.length;
      m.eyebrow = `Lobby · room ${s.room}${endedByHost(s) ? ' · the host ended the last game' : ''}`;
      // X4: the estimate also rides in the bar for every viewer, which a phone keeps on screen (the lobby panel is far
      // down there); below the minimum it is the minimum table's, and says so
      const mins = estimateGame(Math.max(2, Math.min(16, Math.max(n, s.minPlayers))), draftOptions(s)).mid;
      const few = n < s.minPlayers;
      const est = few ? `with ${s.minPlayers} players (the minimum), a game of about ${mins} min` : `a game of about ${mins} min`;
      if (d.isSpectator) {
        m.title = 'You are watching this lobby';
        const lead = few ? `With ${s.minPlayers} players (the minimum), a game of about ${mins} min` : `Started now, it is a game of about ${mins} min`;
        m.detail = `${n < s.maxPlayers ? `Want to play? Take a seat (${n}/${s.maxPlayers} taken).` : 'All 16 seats are taken — you will watch the game.'} ${lead}.`;
        m.buttons.push(h('button', { class: 'btn primary', testid: 'take-seat-btn', act: 'take-seat', disabled: !d.online || n >= s.maxPlayers || d.shield }, 'Take a seat'));
        m.tone = 'info';
      } else if (d.isHost) {
        const ready = n >= s.minPlayers;
        m.tone = ready ? 'mine' : 'wait';
        m.title = ready ? 'Ready when you are' : 'Waiting for players';
        m.detail = ready
          ? `${n} players → ${Math.floor(n / 2)} beds, a game of about ${mins} min. Start when everyone is on the voice call.`
          : `${n} of at least ${s.minPlayers} players are here; ${est}. Share the link or the code ${s.room}.`;
        m.host.push(h('button', { class: 'btn primary host-btn', testid: 'start-btn', act: 'start', disabled: !ready || !d.online || !!ui.inflight || d.shield },
          h('span', { class: 'b-main', text: 'Start the game' }), h('span', { class: 'b-sub', text: ready ? `deal cards to ${n} players` : `need ${s.minPlayers - n} more` })));
      } else {
        m.title = s.hostId ? `Waiting for ${d.hostName} to start` : 'Waiting for a host';
        m.detail = s.hostId ? `${n} seated (minimum ${s.minPlayers}); ${est}. ${hostOff ? hostAway : 'Join the voice call meanwhile.'}` : 'The next player to take a seat becomes the host.';
      }
      break;
    }
    case 'reveal': {
      const sp = d.speaker;
      m.eyebrow = `Round ${s.round} · reveals${t ? ` · speaker ${t.index + 1} of ${t.order.length}` : ''}`;
      if (d.isSpeaker) {
        m.tone = 'mine';
        if (d.canReveal || (!t.hasRevealed && d.eligible.length > 0)) {
          m.eyebrow = `Your turn · round ${s.round}`;
          m.title = t.mustReveal ? `Reveal your ${catLabel(s, t.mustReveal)}` : 'Reveal one of your hidden cards';
          m.detail = t.mustReveal ? 'Round 1: everyone starts with their profession. Then make your case on voice.' : 'Everyone sees it at once. Then make your case on voice.';
          m.choiceKind = 'reveal';
          m.choices = d.eligible.map((c) => h('button', { class: 'choice reveal-choice', key: c, testid: 'reveal-btn', act: 'reveal', 'data-category': c, disabled: !d.canReveal },
            h('span', { class: 'ch-k', text: `Reveal ${catLabel(s, c)}` }), h('span', { class: 'ch-v', text: s.me.cards[c].text })));
        } else if (t.hasRevealed) {
          m.eyebrow = `Your turn · round ${s.round}`;
          m.title = 'Make your case, then end your turn';
          m.detail = 'Your card is on the table. Explain why the bunker needs you.';
          m.buttons.push(h('button', { class: 'btn primary', testid: 'end-turn-btn', act: 'end-turn', disabled: !d.canEndTurn }, 'End my turn'));
        } else {
          m.eyebrow = `Your turn · round ${s.round}`;
          m.title = 'Nothing left to reveal — just speak';
          m.detail = 'Special cards already revealed what you would have shown. End your turn when you are done.';
          m.buttons.push(h('button', { class: 'btn primary', testid: 'end-turn-btn', act: 'end-turn', disabled: !d.canEndTurn }, 'End my turn'));
        }
      } else if (sp) {
        const pos = orderPosition(s, d);
        let what;
        let whatNodes = null;
        if (t.hasRevealed) {
          // name the card: on a phone the table (and so the card) is usually off screen; a shortened text opens in
          // full on hover or tap (SPEC §11 X3)
          const rv = turnReveal(s, sp);
          const short = rv ? clip(rv.text, isNarrow() ? 70 : 140) : '';
          what = rv ? `Revealed ${rv.label}: “${short}”.` : 'Card revealed — listening to the pitch.';
          if (rv && short !== rv.text) {
            whatNodes = [`Revealed ${rv.label}: “`, h('span', {
              class: 'clip-pop', 'data-pop': 'clamp', 'data-pop-cut': '', 'data-pop-title': `${sp.name} · ${rv.label}`, 'data-pop-text': rv.text,
              'data-pop-key': 'bar-reveal', tabindex: '0', role: 'button', 'aria-label': `${rv.label}: ${rv.text}`,
            }, short), '”.'];
          }
        } else what = `Choosing a card to reveal${t.mustReveal ? ` (${catLabel(s, t.mustReveal)})` : ''}.`;
        if (!sp.connected) {
          // nobody should wait for someone who is gone without knowing it
          m.title = `${sp.name}'s turn — ${sp.name} is offline`;
          what = t.hasRevealed ? what : 'Nobody is choosing a card right now.';
          what += d.isHost ? ' Press Next to reveal a card for them and move on.' : hostOff ? ` ${hostAway}` : ` ${d.hostName || 'The host'} can move on with Next.`;
          whatNodes = null;
        } else m.title = `${sp.name} is speaking`;
        const rest = [pos, d.isPlayer && !d.alive ? 'You are out, watching.' : ''].filter(Boolean);
        m.detail = [what, ...rest].join(' ');
        if (whatNodes) m.detailNodes = [...whatNodes, rest.length ? ' ' + rest.join(' ') : null];
      }
      break;
    }
    case 'discussion': {
      m.eyebrow = s.overtime ? 'Overtime · discussion' : `Round ${s.round} · discussion`;
      m.title = 'Open discussion on voice';
      const k = (s.schedule && s.schedule.kicksThisStep) || 0;
      let after;
      if (k > 0 && s.voteMods.cancelNext) after = 'The vote after it was cancelled by a special card.';
      else if (k > 0) after = `Then a vote: ${plural(k, 'player')} will stay outside.`;
      else if (s.schedule && s.schedule.nextVoteRound) after = `No vote this round (the next one is after round ${s.schedule.nextVoteRound}).`;
      else after = 'No vote this round.';
      m.detail = `${after} ${d.isHost ? 'Press Next when the talk is done.' : hostOff ? hostAway : `${hostWho} moves on with Next.`}`;
      if (d.isPlayer && !d.alive) m.detail += ' You are out, watching.';
      break;
    }
    case 'vote': {
      const v = s.vote;
      if (!v) break;
      const revote = v.stage === 'revote';
      m.eyebrow = `${revote ? 'Revote' : 'Vote'} ${v.ballot} of ${ballotsOf(s)} · ${v.voted.length}/${v.voters.length} voted`;
      if (d.amVoter) {
        m.tone = d.myVote ? 'done' : 'mine';
        m.title = d.myVote ? `You voted: ${nameOf(s, d.myVote)} stays outside` : revote ? `Revote: who stays outside — ${listText(namesOf(s, v.candidates))}?` : 'Vote: who stays outside?';
        m.detail = d.myVote ? 'You can change it until the vote closes. Everyone sees who voted for whom afterwards.' : 'Tap a name. Nobody sees your choice until the vote closes.';
        // the player this viewer voted for left mid-ballot, so the vote was wiped (§3): say why they are asked again
        if (!d.myVote && ui.voteWiped && ui.voteWiped.key === ballotKey(s)) m.detail = `${ui.voteWiped.text} ${m.detail}`;
        m.choiceKind = 'vote';
        m.choices = v.candidates.filter((id) => id !== d.meId).map((id) => {
          const p = byId(s, id);
          return h('button', { class: ['choice vote-choice', d.myVote === id && 'picked'], key: id, testid: 'vote-btn', act: 'vote', 'data-player-id': id, 'aria-pressed': String(d.myVote === id), disabled: !d.canVote },
            h('span', { class: 'ch-k mono', text: p ? pad2(p.seat + 1) : '' }), h('span', { class: 'ch-v', text: nameOf(s, id) }), d.myVote === id ? h('span', { class: 'ch-mark', text: '✓' }) : null);
        });
      } else {
        const mods = s.voteMods || { blocked: [] };
        if (d.isSpectator) m.title = 'The players are voting';
        else if (d.isPlayer && !d.alive) m.title = 'You are out — watching the vote';
        else if (mods.blocked.includes(d.meId)) m.title = 'You are blocked from this vote';
        else m.title = 'You have no vote in this ballot';
        m.detail = `Deciding between ${listText(namesOf(s, v.candidates))}.`;
      }
      // the vote closes by itself once every voter has voted; only the host can close it before that
      if (hostOff) m.detail = `${m.detail} ${hostAway}`;
      if (d.isHost) {
        // Close vote is the host's main move only once everyone still online has voted (the rest are gone); before that
        // it would cut the vote short, and at 0 votes fate would pick at random
        const missing = v.voters.filter((id) => !v.voted.includes(id));
        const onlyOffline = missing.length > 0 && missing.every((id) => { const p = byId(s, id); return !p || !p.connected; });
        const sub = v.voted.length === 0 ? 'nobody has voted yet: fate picks at random'
          : `${plural(missing.length, onlyOffline ? 'offline voter' : 'missing voter')} ${missing.length === 1 ? 'abstains' : 'abstain'}`;
        m.host.push(h('button', { class: ['btn host-btn', onlyOffline ? 'primary' : 'ghost'], testid: 'close-vote-btn', act: 'close-vote', disabled: !d.canClose },
          h('span', { class: 'b-main', text: 'Close vote' }),
          h('span', { class: 'b-sub', text: sub })));
      }
      break;
    }
    case 'defense': {
      const sp = d.speaker;
      const tied = t ? namesOf(s, t.order) : [];
      m.eyebrow = `Defense ${t ? t.index + 1 : 1} of ${t ? t.order.length : 1} · tie-break`;
      if (d.isSpeaker) {
        m.tone = 'mine';
        m.title = 'Your defense — convince them';
        m.detail = `You tied with ${listText(tied.filter((x) => x !== s.you.name))}. A revote between you follows.`;
        m.buttons.push(h('button', { class: 'btn primary', testid: 'end-turn-btn', act: 'end-turn', disabled: !d.canEndTurn }, 'End my defense'));
      } else {
        const off = !!sp && !sp.connected;
        m.title = sp ? `${sp.name} is defending${off ? ' — offline' : ''}` : 'Defense speeches';
        m.detail = `Tie between ${listText(tied)}. Then a revote between them. ${off ? (d.isHost ? 'They are offline: press Next to move on. ' : hostOff ? `They are offline. ${hostAway} ` : 'They are offline: the host can move on with Next. ') : ''}${orderPosition(s, d)}`.trim();
      }
      break;
    }
    case 'final': {
      const f = s.final || { survivors: [] };
      m.tone = 'final';
      m.eyebrow = 'Game over';
      m.title = `${plural(f.survivors.length, 'player')} made it into the bunker`;
      const mine = d.isPlayer ? (f.survivors.includes(d.meId) ? 'You are inside.' : 'You stayed in the forest.') : '';
      m.detail = `${mine} ${d.isHost ? 'Play again returns everyone to the lobby with the same seats.' : hostOff ? hostAway : `${d.hostName || 'The host'} can start a new game with the same players.`}`.trim();
      if (d.isHost) {
        m.host.push(h('button', { class: 'btn primary host-btn', testid: 'play-again-btn', act: 'play-again', disabled: !d.online || !!ui.inflight || d.shield },
          h('span', { class: 'b-main', text: 'Play again' }), h('span', { class: 'b-sub', text: 'back to the lobby' })));
      }
      break;
    }
    default: break;
  }
  if (d.isPlayer && d.meP.status === 'ejected' && d.inGame) m.eyebrow = `You are out · ${m.eyebrow}`;
  if (d.isHost && d.inGame) m.host.push(nextButton(s, d));
  // SPEC §11 X6: the host can end a running game (the final has Play again): in the host tools, away from Next
  m.endGame = d.isHost && d.inGame;
  if (m.endGame && isArmed('end-game')) m.endNote = true;
  if (d.inGame && !s.hostId) m.detail = `${m.detail} Nobody is host right now.`.trim();
  if (!d.online && !MOCK) { m.tone = 'offline'; m.eyebrow = 'Offline · reconnecting'; }
  if (MOCK && ui.mockConn) { m.tone = 'offline'; m.eyebrow = 'Offline · reconnecting'; }
  return m;
}
// The bar names every open airlock too (SPEC §11 X1.7): on a phone it stays on screen while the table scrolls away.
function vBarAirlocks(s, d) {
  if (!d.inGame) return null;
  const list = airlocksOf(s).filter((a) => (byId(s, a.targetId) || {}).status === 'alive');
  if (!list.length) return null;
  const join = joinableAirlocks(s, d);
  const onMe = list.some((a) => a.targetId === s.you.id);
  const many = list.length > 1;
  const spent = airlocksLeft(s) === 0;
  const end = airEnd(s);
  const tail = spent ? `every Airlock in this game has been played, so ${many ? 'each' : 'it'} jams when ${end}`
    : join.length ? `you hold an Airlock: yours would close ${many ? 'one' : 'it'}` : onMe ? `one more Airlock on you before ${end} and you are out`
      : many ? `a second Airlock on the same player before ${end} closes each` : `one more Airlock before ${end} closes it`;
  return h('div', { class: ['bar-airlock', join.length && 'joinable', onMe && !spent && 'on-me', spent && 'spent'] },
    icon('door', 'ba-ico'),
    h('span', { class: 'ba-k', text: 'Airlock' }),
    h('span', { class: 'ba-t' }, list.map((a, i) => [i ? ' · ' : '', h('b', { text: a.targetId === s.you.id ? (i ? 'you' : 'You') : nameOf(s, a.targetId) }),
      ` ${airlockCount(a)}, by ${airlockStarters(s, a)}`]), ` — ${tail}`));
}
function vBar(s, d) {
  const m = barModel(s, d);
  return h('footer', { class: ['bar', 'tone-' + m.tone], role: 'region', 'aria-label': 'What happens now' },
    h('div', { class: 'bar-stripe', 'aria-hidden': 'true' }),
    h('div', { class: 'bar-inner' },
      h('div', { class: 'bar-main' },
        h('div', { class: 'bar-status', 'aria-live': 'polite', testid: 'action-bar' },
          h('div', { class: 'bar-eyebrow', text: m.eyebrow }),
          h('div', { class: 'bar-title', text: m.title }),
          m.detail ? h('div', { class: 'bar-detail' }, m.detailNodes || m.detail) : null,
          vBarAirlocks(s, d),
          m.endNote ? h('div', { class: 'bar-endnote', role: 'alert' },
            h('b', { text: 'End the game now? ' }), END_GAME_TEXT, ' Hidden cards stay hidden. Tap again to confirm.') : null),
        m.buttons.length ? h('div', { class: 'bar-buttons' }, m.buttons) : null,
        m.host.length ? h('div', { class: ['bar-host', m.endGame && 'with-end'] },
          h('div', { class: 'bar-host-head' }, h('span', { class: 'bar-host-k', text: 'Host' }), m.endGame ? endGameButton(s, d) : null),
          m.host) : null),
      m.choices && m.choices.length ? h('div', { class: ['bar-choices', 'ch-' + m.choiceKind, `n${m.choices.length}`] }, m.choices) : null));
}

/* ---------- toasts + modal */
function vToasts() {
  // flashes about other players' moves wait while the special picker is open; errors and ejections always show
  // (an ejection may be exactly what the card in the picker was meant to prevent)
  const list = ui.picker ? ui.toasts.filter((t) => t.kind === 'error' || t.code === 'eject') : ui.toasts;
  return h('div', { class: 'toasts', 'aria-live': 'assertive' }, list.map((t) => h('div', {
    key: 't' + t.id, class: ['toast', 'toast-' + t.kind], role: t.kind === 'error' ? 'alert' : 'status',
    testid: t.kind === 'error' ? 'error-toast' : 'info-toast', 'data-code': t.code,
  },
  h('span', { class: 'toast-k mono', text: t.kind === 'error' ? 'Error' : t.air ? 'Airlock' : t.code === 'eject' ? 'Out' : t.code === 'special' ? 'Special' : t.code === 'leave' ? 'Left' : t.code === 'vote' ? 'Vote' : 'Note' }),
  h('span', { class: 'toast-msg', text: t.message }),
  h('button', { class: 'toast-x', act: 'toast-close', 'data-id': String(t.id), 'aria-label': 'Dismiss' }, '×'))));
}
// SPEC §11 X1.3 in words: how many Airlocks and revives this table deals.
function airlockDealText(s) {
  const n = s && s.players ? s.players.length : 0;
  const general = 'Every game of 4 or more players deals Airlocks to different players (2 with 4–7 players, 3 with 8–11, 4 with 12–16) and a Back from the Forest (2 with 12–16) to players without an Airlock, so a way back always exists.';
  if (!s || n < 2) return general;
  const { airlocks, revives } = airlockDeal(n);
  const where = s.phase === 'lobby' ? `If you start with ${n} players, the game deals` : `This game (${n} players) dealt`;
  if (!airlocks) return `${general} ${s.phase === 'lobby' ? `With ${n} players` : 'This game has fewer than 4 players, so'} no Airlocks and no Back from the Forest${s.phase === 'lobby' ? ' would be dealt' : ' were dealt'}.`;
  return `${where} ${plural(airlocks, 'Airlock')}, each to a different player, and ${revives === 1 ? 'one Back from the Forest' : `${revives} Back from the Forest cards`} to ${revives === 1 ? 'a player' : 'players'} without an Airlock: a way back always exists.`;
}
// "How to play", from the header in every phase: the goal, a round, the vote, the specials and the end.
function vRulesModal() {
  const s = state;
  const beds = s && s.capacity ? `${s.capacity} beds` : 'beds for half of the players';
  const sec = (title, ...items) => h('section', { class: 'rs' }, h('h3', { class: 'rs-t', text: title }), h('ul', { class: 'rs-list' }, items.map((x, i) => h('li', { key: String(i) }, x))));
  return h('div', { class: 'modal-wrap', key: 'rules' },
    h('div', { class: 'modal-back', act: 'rules-close' }),
    h('div', { class: 'modal rules-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rules-title', testid: 'rules-sheet' },
      h('div', { class: 'modal-head' },
        h('div', null, h('div', { class: 'k', text: 'Bunker · the rules' }), h('h2', { id: 'rules-title', class: 'modal-title', text: 'How to play' })),
        h('button', { class: 'toast-x', act: 'rules-close', 'aria-label': 'Close' }, '×')),
      h('div', { class: 'rules-body' },
        sec('The goal',
          `A catastrophe has happened. The bunker has ${beds}; everyone else stays in the forest.`,
          'Argue that the bunker needs you, and vote out the players the group can do without. The players still in the game when they fit in the beds are the bunker.'),
        sec('A round (7 in all)',
          'Reveals: in seat order (up the seats in odd rounds, down in even ones) each player reveals one hidden card, then makes their case. Round 1 is always the Profession. Press End turn when done.',
          'Discussion: everyone argues on the voice call.',
          'Vote: after the rounds marked ✖ on the round track, which shows how many players go in each. Leaves and special cards move the votes; the track always shows the plan as it is now.',
          'Timers are only a guide: nothing happens when one runs out. The host moves the game on with Next.'),
        sec('The vote',
          'You cannot vote for yourself. Votes are secret until the vote closes, and you can change yours until then. Then everyone sees who voted for whom.',
          'Whoever gets the most votes is out. A tie: the tied players get a defense speech each, then a revote between them only. Still tied, or nobody voted: fate decides at random.',
          'The host can close the vote early; whoever has not voted abstains.'),
        sec('Special cards',
          'You hold 2 secret special cards and may play one per round. The server carries out the effect, and everyone sees the card and what it did (a peek only shows you the card).',
          'Hover or tap a card’s name anywhere (on the table, in the log, at the end) to read what it does.',
          '“Before the vote” cards can be played during the reveals or the discussion; “Any time in play” cards also during a vote or a defense.',
          'Immunity, protection, a vote block or a ×2 vote lasts until the next vote step ends — a vote cancelled by a special uses it up too.'),
        sec('Airlock and Back from the Forest',
          'An Airlock needs a partner. Played on a player (from round 2, during the reveals or the discussion), it starts cycling the airlock on them, and everyone sees “Airlock 1/2” on their panel.',
          'If a different player plays another Airlock on the same player in the same round, before its discussion ends, that player is thrown out at once, with no vote (it is not a vote, so immunity does not stop it). Airlocks on different players never add up.',
          'Nobody joins in time: the airlock jams when that round’s discussion ends, whether a vote follows or not (or when its target is out anyway). An Airlock played in a later round starts a new one. The card that opened it is spent.',
          airlockDealText(s),
          'Back from the Forest brings back anyone who was ejected, whether by a vote or through the airlock.'),
        sec('The end',
          'As soon as the players still in the game fit in the beds, the door closes. Every card is turned face up — was it the right crew?',
          'Leaving a game is for good: you cannot come back into it.')),
      h('div', { class: 'modal-actions' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary', act: 'rules-close' }, 'Got it'))));
}
function vModal() {
  if (ui.rulesOpen) return vRulesModal();
  if (!ui.picker || !state || !state.me) return null;
  const s = state;
  const d = derive(s);
  const p = ui.picker;
  const sp = s.me.specials.find((x) => x.uid === p.uid);
  if (!sp) return null;
  const steps = pickerSteps(sp);
  const step = pickerStep(sp, p);
  const target = p.targetId ? byId(s, p.targetId) : null;
  const stepLabel = { target: 'Target', category: 'Category', confirm: 'Confirm' };
  const stepValue = { target: target ? target.name : '', category: p.category ? catLabel(s, p.category) : '', confirm: '' };
  // just opened or just changed step: a double click's 2nd click must not pick or play (SPEC §11 K6)
  const settling = pickerSettling();
  let body;
  const isAir = sp.effect === 'airlock';
  if (step === 'target') {
    // an Airlock: the players whose open airlock this card would close come first, marked (SPEC §11 X1.7)
    const { list, joinIds } = pickerTargets(s, sp);
    const q = sp.target === 'ejected' ? 'Who comes back from the forest?' : sp.effect === 'peek' || sp.effect === 'force_reveal' ? 'Whose hidden card?'
      : isAir ? (joinIds.length ? 'Join the open airlock, or start a new one' : 'Start cycling the airlock on…') : 'Choose a player';
    body = h('div', { class: 'pick' },
      h('p', { class: 'pick-q', text: q }),
      joinIds.length ? h('p', { class: 'callout airlock-callout' }, icon('door', 'ac-ico'),
        h('span', null, h('b', { text: `Join the airlock on ${listText(joinIds.map((id) => nameOf(s, id)))}: ` }),
          joinIds.length === 1 ? `pick ${nameOf(s, joinIds[0])} and they are thrown out right now, with no vote.` : 'pick one of them, and that player is thrown out right now, with no vote.')) : null,
      isAir && !joinIds.length ? h('p', { class: 'pick-note', text: airlockPickNote(s) }) : null,
      h('div', { class: 'opt-grid' }, list.map((t) => {
        const hid = hiddenCatsOf(s, t).length;
        const a = isAir ? airlockOn(s, t.id) : null;
        const join = joinIds.includes(t.id);
        const sub = t.status === 'ejected' ? 'ejected' : !isAir ? `${plural(hid, 'hidden card')}`
          : join ? `Airlock ${airlockCount(a)} by ${airlockStarters(s, a)}: join, and ${t.name} is out` : 'starts an airlock (1/2)';
        return h('button', { class: ['opt', join && 'join'], key: t.id, testid: 'target-option', 'data-player-id': t.id, 'data-airlock': join ? 'join' : null, act: 'pick-target', disabled: settling },
          h('span', { class: 'opt-seat mono', text: pad2(t.seat + 1) }),
          h('span', { class: 'opt-name', text: t.name }),
          h('span', { class: 'opt-sub', text: sub }));
      })));
  } else if (step === 'category') {
    const list = allowedCats(s, sp, p.targetId);
    body = h('div', { class: 'pick' },
      h('p', { class: 'pick-q', text: sp.effect === 'force_reveal' || sp.effect === 'peek' ? `Which of ${target ? target.name + "'s" : 'their'} hidden cards?` : 'Which category?' }),
      h('div', { class: 'opt-grid cats' }, list.map((c) => {
        let sub = '';
        if (sp.effect === 'swap_card' && target) sub = `yours: ${s.me.cards[c].text} ⇄ theirs: ${target.cards[c] == null ? 'hidden' : target.cards[c]}`;
        else if (sp.effect === 'reroll_card') sub = sp.target === 'self' ? `yours: ${s.me.cards[c].text}` : target ? `now: ${target.cards[c] == null ? 'hidden' : target.cards[c]}` : '';
        else if (sp.effect === 'mass_reveal' || sp.effect === 'shuffle_category') {
          const hiddenN = d.aliveList.filter((x) => x.cards[c] == null).length;
          sub = `${hiddenN} of ${d.aliveList.length} still hidden`;
        } else sub = 'hidden';
        return h('button', { class: 'opt', key: c, testid: 'category-option', 'data-category': c, act: 'pick-cat', disabled: settling },
          h('span', { class: 'opt-name', text: catLabel(s, c) }), h('span', { class: 'opt-sub', text: sub }));
      })));
  }
  const joinNow = isAir && !!target && airlockKey(s, target.id) === 'join';
  if (step === 'confirm') {
    body = h('div', { class: ['confirm', joinNow && 'join'] },
      h('p', { class: 'confirm-what', text: describePlay(s, sp, target, p.category) }),
      h('p', { class: 'confirm-warn', text: sp.effect === 'peek'
        ? 'Everyone sees that you played this card and on whom — but not what you saw.'
        : 'Everyone sees this card, its text and the result as soon as you play it.' }));
  }
  return h('div', { class: 'modal-wrap', key: 'picker' },
    h('div', { class: 'modal-back', act: 'picker-cancel' }),
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'picker-title', testid: 'special-picker' },
      h('div', { class: 'modal-head' },
        h('div', null, h('div', { class: 'k', text: 'Play a special card' }),
          // the chip look, but no popover: the full text is printed right under it, and a hover popover here opened
          // under a resting pointer and covered the targets (the click that followed only closed it)
          h('h2', { id: 'picker-title', class: 'modal-title' }, h('span', { class: 'card-chip cc-xl cc-static' }, icon('spark', 'cc-ico'), h('span', { class: 'cc-t', text: sp.title })))),
        h('button', { class: 'toast-x', act: 'picker-cancel', 'aria-label': 'Cancel' }, '×')),
      h('p', { class: 'modal-card-text', text: sp.text }),
      h('p', { class: 'modal-card-meta', text: specialMeta(s, sp) }),
      h('ol', { class: 'steps' }, steps.map((x, i) => h('li', { key: x, class: ['step', x === step && 'now', steps.indexOf(step) > i && 'done'] },
        h('span', { class: 'step-n mono', text: String(i + 1) }), h('span', { class: 'step-l', text: stepLabel[x] }),
        stepValue[x] ? h('span', { class: 'step-v', text: stepValue[x] }) : null))),
      p.note && h('p', { class: 'callout warn', text: p.note }),
      body,
      h('div', { class: 'modal-actions' },
        step !== steps[0] && h('button', { class: 'btn ghost', act: 'picker-back' }, '‹ Back'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn ghost', act: 'picker-cancel' }, 'Cancel'),
        step === 'confirm' && h('button', { class: ['btn primary', joinNow && 'join', settling && 'settling'], testid: 'special-confirm-btn', act: 'picker-confirm', disabled: !d.online || settling },
          joinNow ? `Play ${sp.title}: ${target.name} is out` : `Play ${sp.title}`))));
}
function vMockIndex() {
  const list = ui.mockScenarios || [];
  return h('div', { class: 'screen center' },
    h('div', { class: 'hz-strip', 'aria-hidden': 'true' }),
    h('div', { class: 'panel narrow' },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Mock scenarios' }), h('span', { class: 'meta', text: String(list.length) })),
      h('p', { class: 'fine', text: 'Fixture StateViews rendered without a server. Buttons work on a small local simulation.' }),
      h('ul', { class: 'mock-list' }, list.map((x) => h('li', { key: x.id },
        h('a', { href: '?mock=' + encodeURIComponent(x.id), class: 'mono' }, x.id), h('span', { class: 'fine', text: ' — ' + x.title }))))));
}

/* ------------------------------------------------------------------ actions (event delegation) */
const ACTIONS = {
  create() {
    const name = cleanName(ui.landing.name);
    if (!name) return;
    ui.pendingName = name; sSet('local', NAME_KEY, name);
    ui.askedSpectator = null;
    connectWith({ t: 'create', name });
  },
  join() { joinRoom(false); },
  spectate() { joinRoom(true); },
  rejoin() {
    const offer = ui.rejoinOffer;
    if (!offer) return;
    identity = { ...offer };
    sSet('session', ID_KEY, identity);
    ui.screen = 'resuming';
    ui.pendingName = offer.name || '';
    connectWith({ t: 'resume', room: offer.room, token: offer.token });
  },
  forget() { sDel('local', ID_KEY); ui.rejoinOffer = null; },
  'cancel-resume'() {
    clearTimeout(conn.timer);
    dropSocket();
    conn.status = 'idle'; conn.attempt = 0;
    identity = null;
    sDel('session', ID_KEY);
    resetToLanding(null);
  },
  'retry-now'() {
    if (MOCK) { ui.mockConn = null; return; }
    conn.attempt = Math.max(0, conn.attempt - 1);
    reconnectNow();
  },
  'take-over'() {
    if (!identity) return;
    stopped = false;
    ui.screen = 'resuming';
    openSocket({ t: 'resume', room: identity.room, token: identity.token });
  },
  'to-landing'() {
    dropSocket(); stopped = false; conn.status = 'idle';
    identity = null;
    sDel('session', ID_KEY);
    resetToLanding(null);
  },
  leave() {
    const room = state ? state.room : identity ? identity.room : '';
    if (state) {
      const d = derive(state);
      if (leaveIsFinal(state, d)) {
        if (!isArmed('leave')) { arm('leave'); return; }
        if (!armReady('leave')) return;   // the 2nd click of the double click that armed it
      }
    }
    ui.armed = null;
    if (MOCK) { mockSend({ t: 'leave' }); return; }
    // offline, the leave would never reach the server and the seat would stay in the game: keep it (SPEC §10)
    if (!(ws && ws.readyState === 1 && joinedOnSocket)) {
      toast('error', 'offline', 'Not connected, so you have not left. Leave again once the connection is back.');
      return;
    }
    ws.send(JSON.stringify({ t: 'leave' }));
    clearIdentity();
    dropSocket();
    clearTimeout(conn.timer);
    conn.status = 'idle'; conn.attempt = 0;
    resetToLanding({ kind: 'info', text: `You left room ${room}.` });
    ui.landing.room = '';
    setUrlRoom(null);
  },
  'copy-link'() { copyInviteLink(); },
  start() { sendTurnAction({ t: 'start' }); },
  'take-seat'() { send({ t: 'takeSeat' }); },
  kick(el) {
    const id = el.getAttribute('data-player-id');
    if (!id) return;
    // a seated player kicked from a game never comes back: that takes a second tap (the lobby and spectators: one)
    if (state && state.phase !== 'lobby' && byId(state, id)) {
      if (!isArmed('kick:' + id)) { arm('kick:' + id); return; }
      if (!armReady('kick:' + id)) return;   // the 2nd click of the double click that armed it
    }
    ui.armed = null;
    sendAdmin({ t: 'kick', playerId: id });
  },
  rules(el) { ui.rulesOpen = true; ui.rulesOpener = openerOf(el); ui.picker = null; ui.overlayOpenedAt = Date.now(); },
  'rules-close'() { closeOverlay(); },
  'briefing-close'(el) {
    const key = el.getAttribute('data-key') || '';
    ui.briefed = key;
    sSet('session', BRIEF_KEY, key);
  },
  transfer(el) { const id = el.getAttribute('data-player-id'); if (id) sendAdmin({ t: 'transferHost', playerId: id }); },
  // every turn or ballot action names the step it was aimed at (SPEC §11 R1)
  reveal(el) { const c = el.getAttribute('data-category'); if (c && state) sendTurnAction({ t: 'reveal', category: c, at: stepAt(state) }); },
  'end-turn'() { if (state) sendTurnAction({ t: 'endTurn', at: stepAt(state) }); },
  next() { if (state) sendTurnAction({ t: 'next', at: stepAt(state) }); },
  'close-vote'() { if (state) sendTurnAction({ t: 'closeVote', at: stepAt(state) }); },
  vote(el) { const id = el.getAttribute('data-player-id'); if (id && state) sendVote({ t: 'vote', targetId: id, at: stepAt(state) }); },
  'play-again'() { sendTurnAction({ t: 'playAgain' }); },
  'end-game'() {
    if (!state) return;
    const d = derive(state);
    if (!d.isHost || !d.inGame) return;
    if (!isArmed('end-game')) { arm('end-game'); return; }
    if (!armReady('end-game')) return;   // the 2nd click of the double click that armed it
    ui.armed = null;
    sendTurnAction({ t: 'endGame' });
  },
  'special-open'(el) {
    const uid = el.getAttribute('data-uid');
    if (!uid) return;
    ui.picker = { uid, targetId: null, category: null, note: '', voteKey: state ? voteKeyOf(state) : null, opener: openerOf(el) };
    const sp = state && state.me ? state.me.specials.find((x) => x.uid === uid) : null;
    // the alert's "Join: throw T out" names its target: the sheet opens on Confirm for exactly that player (Back
    // changes it), never on a list that leads with someone else (SPEC §11 FX2)
    const tid = el.getAttribute('data-player-id');
    if (sp && sp.effect === 'airlock' && tid && airlockKey(state, tid) === 'join' && validTargets(state, sp).some((t) => t.id === tid)) ui.picker.targetId = tid;
    pickerSaw(ui.picker, sp);
    ui.pickerFocused = '';
    ui.overlayOpenedAt = Date.now();
    pickerMoved();
  },
  'pick-target'(el) {
    const p = ui.picker;
    if (!p || !state || !state.me) return;
    p.targetId = el.getAttribute('data-player-id');
    p.category = null;
    p.note = '';
    pickerSaw(p, state.me.specials.find((x) => x.uid === p.uid));
    pickerMoved();
  },
  'pick-cat'(el) { if (ui.picker) { ui.picker.category = el.getAttribute('data-category'); ui.picker.note = ''; pickerMoved(); } },
  'picker-back'() {
    const p = ui.picker;
    if (!p || !state || !state.me) return;
    const sp = state.me.specials.find((x) => x.uid === p.uid);
    const step = sp ? pickerStep(sp, p) : 'target';
    if (step === 'confirm' && sp && sp.category === 'choose') p.category = null;
    else if (step === 'confirm' || step === 'category') { p.targetId = null; p.category = null; }
    p.note = '';
    pickerSaw(p, sp);
    pickerMoved();
  },
  'picker-cancel'() { closeOverlay(); },
  'picker-confirm'() {
    const p = ui.picker;
    if (!p || !state || !state.me) return;
    const sp = state.me.specials.find((x) => x.uid === p.uid);
    if (!sp) { ui.picker = null; return; }
    // the step it is aimed at (SPEC §11 K7): a Play that crosses the vote closing is refused, not applied to the next one
    const msg = { t: 'special', uid: sp.uid, at: specialAt(state) };
    if (sp.target === 'other' || sp.target === 'ejected') msg.targetId = p.targetId;
    if (sp.category === 'choose') msg.category = p.category;
    ui.picker = null;
    // like the other turn actions (F1): Next, End turn and Reveal stay held until the answer has arrived
    sendTurnAction(msg);
  },
  expand(el) {
    const id = el.getAttribute('data-player-id');
    if (!id) return;
    if (ui.expanded.has(id)) ui.expanded.delete(id); else ui.expanded.add(id);
  },
  'toggle-situation'() {
    if (!state) return;
    ui.situation = { room: state.room, phase: state.phase === 'final' ? 'final' : 'play', open: !situationOpen(state) };
  },
  'toggle-last'() { if (state) ui.showLast = !lastOpen(state); },
  'board-view'(el) {
    if (!state) return;
    const v = el.getAttribute('data-view');
    if (v !== 'table' && v !== 'cards') return;
    prefs.view = { ...(prefs.view || {}), [state.phase === 'final' ? 'final' : 'play']: v };
    savePrefs();
  },
  'full-text'() { prefs.fullText = !prefs.fullText; savePrefs(); },
  preset(el) {
    const p = TIMER_PRESETS.find((x) => x.id === el.getAttribute('data-preset'));
    if (p) send({ t: 'setOptions', options: { ...p.v } });
  },
  reload() { location.reload(); },
  'toast-close'(el) { const id = Number(el.getAttribute('data-id')); ui.toasts = ui.toasts.filter((t) => t.id !== id); },
  'jump-player'(el) {
    const id = el.getAttribute('data-player-id');
    const row = id && document.querySelector(`[data-testid="player-card"][data-player-id="${CSS.escape(id)}"]`);
    if (!row) return;
    scrollWithin(row, 'center', true);
    ui.flash = { id, until: Date.now() + 1600 };
    setTimeout(scheduleRender, 1700);
  },
  jump(el) {
    const id = el.getAttribute('data-target');
    // "Info" opens the collapsed situation summary on the way
    if (id === 'sec-situation' && state && !isConsole() && !situationOpen(state)) {
      ui.situation = { room: state.room, phase: state.phase === 'final' ? 'final' : 'play', open: true };
      render();
    }
    const target = document.getElementById(id);
    if (target) scrollWithin(target, 'start', true);
  },
};
function joinRoom(spectator) {
  const name = cleanName(ui.landing.name);
  const room = cleanCode(ui.landing.room);
  if (!name || !CODE_RE.test(room)) return;
  ui.pendingName = name; sSet('local', NAME_KEY, name);
  ui.askedSpectator = spectator;
  const msg = { t: 'join', room, name };
  if (spectator) msg.spectator = true;
  connectWith(msg);
}
async function copyInviteLink() {
  const input = document.getElementById('invite-link');
  const text = input ? input.value : '';
  let ok = false;
  try {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; }
  } catch { ok = false; }
  if (!ok && input) {
    try {
      input.focus();
      input.select();
      input.setSelectionRange(0, text.length);
      ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    } catch { ok = false; }
  }
  ui.copied = ok ? 'ok' : 'manual';
  ui.copiedAt = Date.now();
  if (!ok && input) { try { input.focus(); input.select(); } catch { /* ignore */ } }
  scheduleRender();
}

document.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-act]') : null;
  if (!el || el.hasAttribute('disabled')) return;
  const act = el.getAttribute('data-act');
  const fn = ACTIONS[act];
  if (!fn) return;
  e.preventDefault();
  const now = Date.now();
  // SPEC §11 K6: the second click of a double click whose first click closed an overlay or collapsed a panel lands on
  // whatever slid under the pointer; nothing outside an open overlay acts until the shield is down
  if (now < ui.shieldUntil && !el.closest('.modal-wrap')) return;
  // …and the backdrop right after a sheet opened or changed step is the second click of the click that did it
  if (el.classList.contains('modal-back') && (pickerSettling() || now - ui.overlayOpenedAt < PICK_GUARD_MS)) return;
  fn(el, e);
  if (SHIELD_ACTS.has(act)) shield();
  scheduleRender();
});
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (el instanceof HTMLInputElement && el.hasAttribute('data-select-all')) setTimeout(() => { try { el.select(); } catch { /* ignore */ } }, 0);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement)) return;
  const f = el.getAttribute('data-field') || '';
  if (f === 'name') {
    // the 20-character cap, counted and cut as the server counts (a maxlength of 20 counts UTF-16 units, which cuts an
    // emoji in half and leaves only 10 for emoji names)
    // (not while an input method is composing: rewriting the field then breaks the composition; submit caps it anyway)
    const v = e.isComposing ? el.value : capName(el.value);
    if (v !== el.value) el.value = v;
    ui.landing.name = v;
  }
  else if (f === 'room') {
    const v = cleanCode(el.value);
    if (v !== el.value) el.value = v;
    ui.landing.room = v;
  } else if (f.startsWith('opt:')) {
    // X4: the lobby estimate follows the timer being typed, before it is sent (a value out of 5..600 is ignored)
    const n = Number(el.value);
    if (el.value.trim() !== '' && Number.isInteger(n) && n >= 5 && n <= 600) ui.optDraft[f.slice(4)] = n;
    else delete ui.optDraft[f.slice(4)];
  } else return;
  scheduleRender();
});
document.addEventListener('focusout', (e) => {
  const el = e.target;
  const f = el instanceof HTMLInputElement ? el.getAttribute('data-field') || '' : '';
  // a draft lives while its field is edited, and until the room answers the value that leaving the field sent (the
  // next state clears it); a value the room already has is no draft
  const k = f.startsWith('opt:') ? f.slice(4) : '';
  if (k && ui.optDraft[k] !== undefined && (!state || !state.options || state.options[k] === ui.optDraft[k])) { delete ui.optDraft[k]; scheduleRender(); }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement)) return;
  const f = el.getAttribute('data-field') || '';
  if (!f.startsWith('opt:') || !state) return;
  const key = f.slice(4);
  const n = Number(el.value);
  const cur = state.options ? state.options[key] : undefined;
  if (!Number.isInteger(n) || n < 5 || n > 600) {
    toast('error', 'bad_request', 'Timers must be whole seconds from 5 to 600.');
    if (cur !== undefined) el.value = String(cur);
    delete ui.optDraft[key];
    scheduleRender();
    return;
  }
  if (n !== cur && !send({ t: 'setOptions', options: { [key]: n } })) { delete ui.optDraft[key]; scheduleRender(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (ui.picker || ui.rulesOpen)) { closeOverlay(); shield(); scheduleRender(); return; }
  if (e.key !== 'Enter') return;
  const el = e.target;
  if (!(el instanceof HTMLInputElement)) return;
  const f = el.getAttribute('data-field') || '';
  if (f === 'name' || f === 'room') {
    e.preventDefault();
    const nameOk = cleanName(ui.landing.name).length > 0;
    if (!nameOk || ui.pending) return;
    // the invite is to a room this browser holds a seat in: Enter takes that seat back instead of seating a twin
    const offer = ui.rejoinOffer;
    if (offer && ui.landing.invite && offer.room === ui.landing.invite && ui.landing.room === ui.landing.invite) ACTIONS.rejoin();
    else if (CODE_RE.test(ui.landing.room)) joinRoom(false);
    else if (f === 'name' && !ui.landing.room) ACTIONS.create();
    scheduleRender();
  } else if (f.startsWith('opt:')) el.blur();
});
window.addEventListener('resize', () => { if (state) scheduleRender(); });
// Back online, or back to this tab (phones freeze background tabs): retry a waiting or stuck reconnect at once, and
// check that an "open" socket still answers.
function wake() {
  if (MOCK || !identity || stopped) return;
  if (conn.status === 'waiting') reconnectNow();
  else if (conn.status === 'connecting' && Date.now() - conn.openedAt > 1500) reconnectNow();
  // open but not joined, and no hello waiting for its answer: that socket will never carry the game again
  else if (conn.status === 'open' && !joinedOnSocket && conn.probeWhy !== 'hello') reconnectNow();
  else if (conn.status === 'open') probe(WAKE_WAIT_MS, 'wake');
}
window.addEventListener('online', wake);
document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
// Keepalive: an idle socket is pinged and must answer (a dead one is found in ~PING_EVERY_MS + PING_WAIT_MS).
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  if (conn.probeAt) { checkLiveness(); return; }
  // a seat's socket that is open but not joined, with no hello in flight (an answer the code above did not expect):
  // give it up and reconnect with backoff rather than keep it alive with pings
  if (identity && !joinedOnSocket && !stopped && !ui.pending && Date.now() - conn.openedAt > CONNECT_MS) { dropSocket(); onSocketGone(); return; }
  if (Date.now() - conn.lastMsgAt >= PING_EVERY_MS - 500) probe(PING_WAIT_MS, 'keepalive');
}, PING_EVERY_MS);

/* ------------------------------------------------------------------ mock mode */
let mockApi = null;
function mockSend(msg) {
  if (!mockApi) return;
  const res = mockApi.handle(msg, state, ui);
  if (!res) { toast('info', 'mock', `Mock mode: “${msg.t}” is not simulated.`); return; }
  if (res.screen) { ui.screen = res.screen; state = null; window.__bunkerState = null; }
  if (res.notice) ui.notice = res.notice;
  if (res.error) toast('error', res.error.code, res.error.message);
  if (res.info) toast('info', 'mock', res.info);
  if (res.state) { ui.screen = 'room'; onState(res.state); }
  scheduleRender();
}
async function bootMock() {
  let mod;
  try { mod = await import('./mock.js'); } catch (err) {
    document.getElementById('app').textContent = 'Could not load mock.js: ' + String(err);
    return;
  }
  mockApi = mod;
  ui.mockScenarios = mod.list();
  const sc = mod.scenario(MOCK);
  if (!sc) { ui.screen = 'mock-index'; render(); return; }
  if (sc.landing) {
    ui.screen = sc.landing.screen || 'landing';
    Object.assign(ui.landing, sc.landing.form || {});
    ui.rejoinOffer = sc.landing.rejoin || null;
    ui.notice = sc.landing.notice || null;
    if (sc.landing.identity) identity = sc.landing.identity;
  }
  ui.quiet = true;
  if (sc.states) for (const st of sc.states) onState(st);
  ui.quiet = false;
  if (sc.ui) {
    if (sc.ui.picker) ui.picker = { note: '', ...sc.ui.picker };
    if (sc.ui.rules) ui.rulesOpen = true;
    if (sc.ui.expanded) for (const id of sc.ui.expanded) ui.expanded.add(id);
    if (sc.ui.showLast) ui.showLast = true;
    if (sc.ui.view) prefs.view = { play: sc.ui.view, final: sc.ui.view };
    if (sc.ui.mockConn) { ui.mockConn = sc.ui.mockConn; conn.status = 'waiting'; conn.attempt = 3; conn.nextAt = Date.now() + 4200; }
    if (sc.ui.toasts) for (const t of sc.ui.toasts) toast(t.kind, t.code, t.message, { air: !!airlockLine(t.message) });
    if (sc.ui.situation !== undefined) ui.situation = { room: state ? state.room : '', phase: state && state.phase === 'final' ? 'final' : 'play', open: sc.ui.situation };
    if (sc.ui.optDraft) Object.assign(ui.optDraft, sc.ui.optDraft);
    if (sc.ui.armed) ui.armed = { what: sc.ui.armed, at: Date.now() - 60000, until: Date.now() + 3600000 };   // held for a screenshot
  }
  render();
  // a draft timer shows in its field (focused, so the next render keeps it there)
  if (sc.ui && sc.ui.optDraft) {
    for (const [k, v] of Object.entries(sc.ui.optDraft)) {
      const el = document.querySelector(`[data-field="opt:${k}"]`);
      if (el) { el.focus({ preventScroll: true }); el.value = String(v); }
    }
  }
  // a scenario may open a popover on an anchor (a CSS selector, or '@clamped': the first cut-off table cell), as a
  // tap would (pinned)
  if (sc.ui && sc.ui.pop) {
    const a = sc.ui.pop === '@clamped' ? [...document.querySelectorAll('.card.up[data-pop="clamp"]')].find((x) => popWanted(x)) : document.querySelector(sc.ui.pop);
    if (a) {
      scrollWithin(a, 'center');
      showPop(a, true);
    }
  }
}

/* ------------------------------------------------------------------ boot */
function boot() {
  window.__bunkerState = null;
  // test aid: simulate a network drop (the client must reconnect and resume by itself)
  window.__bunkerDebug = {
    drop() { if (ws) ws.close(); },
    conn: () => ({
      status: conn.status, attempt: conn.attempt, joined: joinedOnSocket, probe: conn.probeWhy || null,
      inflight: !!ui.inflight, voteInflight: !!ui.voteInflight, sinceStepMs: ui.stepAt ? Date.now() - ui.stepAt : null,
    }),
    // what the round track and "Vote X of Y" show for the current state (for audits against the server's schedule)
    plan: () => (state && GAME_PHASES.includes(state.phase) ? { cells: trackPlan(state), ballots: state.vote ? ballotsOf(state) : null } : null),
    // the open popover (SPEC §11 X3), for audits: what it shows and where
    popover: () => {
      if (!pop.anchor || !pop.el || !pop.el.isConnected) return null;
      const r = pop.el.getBoundingClientRect();
      return { title: pop.el.getAttribute('data-title'), kind: pop.el.getAttribute('data-kind'), pinned: pop.pinned, text: pop.el.textContent,
        rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, vw: document.documentElement.clientWidth, vh: window.innerHeight };
    },
  };
  if (MOCK) { bootMock(); return; }
  const roomParam = cleanCode(params.get('room'));
  ui.landing.room = CODE_RE.test(roomParam) ? roomParam : '';
  ui.landing.invite = ui.landing.room;
  const savedName = sGet('local', NAME_KEY);
  ui.landing.name = typeof savedName === 'string' ? savedName : '';
  const sess = sGet('session', ID_KEY);
  const local = sGet('local', ID_KEY);
  if (isIdentity(sess) && (!ui.landing.room || sess.room === ui.landing.room)) {
    identity = sess;
    ui.screen = 'resuming';
    ui.pendingName = sess.name || '';
    openSocket({ t: 'resume', room: sess.room, token: sess.token });
  } else {
    ui.screen = 'landing';
    ui.rejoinOffer = isIdentity(local) ? local : null;
  }
  render();
}
boot();
