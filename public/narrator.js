/* Bunker Online — the catastrophe narrator (opt-in, per player, per device).
 *
 * A dramatic British voice reads the catastrophe aloud when a game starts, for the players who turned it on.
 * Self-contained ES module, no dependencies, CSP-safe (no inline code, same-origin media). The host page imports it
 * and calls four functions; everything else (storage, the <audio> element, the "tap to listen" prompt, clicks on
 * [data-narr] controls) lives here:
 *
 *   init({ onChange, notify, memory })   once. onChange(): re-render the page; notify(text): show a short message;
 *                                         memory: keep preferences in memory only (mock/demo pages)
 *   sync(state | null)                    every render: the StateView on screen (null = not in a room) — plays the
 *                                         clip once when this page SEES the game start (lobby -> round 1), stops it
 *                                         back in the lobby, in another room or game, and when the room is left
 *   headerControl(state)                  the header button + its popover (toggle, volume, listen)
 *   titleRow(titleEl, state, where)       wraps a catastrophe title with its ▶ Listen button (or returns it as is)
 * and, in a seat of the /dev test table only (its dev bridge in app.js), devSound() and devState() (see there).
 *
 * Returned nodes are plain DOM elements (the host morphs them into its tree; the wrappers carry data-key).
 * Clips: audio/narration.json = [{ title, src, voice, durationSec }], matched to catastrophe.title case-insensitively.
 * No clip for a catastrophe -> no narrator controls for that game (the header toggle stays: it is a preference). */

import { pkey } from './profile.js';
import { STR } from './strings.js';

// storage keys, namespaced by ?profile= (SPEC §11 X9.1): pkey() in load/save, and in the `storage` event check
const PREF_KEY = 'bunker.narrator';
const PLAYED_KEY = 'bunker.narrator.played';
const BASE = new URL('./', import.meta.url);
const MANIFEST_URL = new URL('audio/narration.json', BASE).href;
const TEXT_LOBBY_ON = 'Narrator on — you’ll hear the catastrophe when the game starts.';
const TEXT_GAME_ON = 'Narrator on — it reads the catastrophe when a game starts. Press ▶ Listen to hear this one now.';
// a game start seen later than this (the page got the news late: a reconnect after the phone was locked in the lobby,
// a frozen background tab waking up) is not announced by itself — ▶ Listen is there for it
const FRESH_MS = 15000;

let opts = { onChange() {}, notify() {}, memory: false };
const mem = new Map();
const prefs = { on: false, vol: 100 };
let clips = null;             // Map<lower-case title, {title, src, voice, durationSec}> once narration.json is in
let audio = null;             // the one <audio> element (outside the host's tree, so a re-render never touches it)
let volumeWorks = true;       // false where media volume is fixed (iOS Safari): the slider is replaced by a note
let pill = null;              // the "▶ Listen to the catastrophe" prompt shown when the browser refused to autoplay
let playSeq = 0;
let started = false;
let clockSkew = null;         // max(serverNow - Date.now()) over the states seen: this device's offset to the server
let table = null;             // a /dev test table seat: { on, who, want } from devSound(); null everywhere else
const st = {
  seen: null,                 // the last state sync() got
  game: null,                 // { room, title (lower case), label } of the game on screen
  status: 'idle',             // idle | loading | playing | error
  forTitle: '',               // lower-case title of the clip loaded in the element
  blocked: false,             // autoplay was refused: show the prompt
  pendingAuto: '',            // the game start happened before narration.json arrived: play when it does
  menu: false,                // the header popover is open
  hint: '',                   // the popover's status line
};

/* ------------------------------------------------------------------ storage (never throws) */
function load(key) {
  try { const raw = opts.memory ? mem.get(key) : window.localStorage.getItem(pkey(key)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function save(key, v) {
  try { const raw = JSON.stringify(v); if (opts.memory) mem.set(key, raw); else window.localStorage.setItem(pkey(key), raw); } catch { /* blocked storage */ }
}
function savePrefs() { save(PREF_KEY, { on: prefs.on, vol: prefs.vol }); }
function readPrefs() {
  const p = load(PREF_KEY);
  prefs.on = !!p && typeof p === 'object' && p.on === true;
  const v = p && typeof p === 'object' ? Number(p.vol) : NaN;
  prefs.vol = Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 100;
}
// on: this profile's own switch, or on the test table the table's choice (it never touches the saved switch)
function isOn() { return table ? table.on : prefs.on; }
function wasPlayed(key) { const a = load(PLAYED_KEY); return Array.isArray(a) && a.includes(key); }
function markPlayed(key) {
  const a = load(PLAYED_KEY);
  const list = (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x !== key) : []).slice(-7);
  list.push(key);
  save(PLAYED_KEY, list);
}

/* ------------------------------------------------------------------ tiny DOM builder */
const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') { const c = Array.isArray(v) ? v.filter(Boolean).join(' ') : v; if (c) n.setAttribute('class', c); }
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'value') { n.setAttribute('value', String(v)); n.value = String(v); }
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  if (tag === 'button' && !n.hasAttribute('type')) n.setAttribute('type', 'button');
  return n;
}
function svgEl(tag, attrs, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
  for (const k of kids) n.appendChild(k);
  return n;
}
// speaker glyph: waves when on, a cross when off
function speaker(on) {
  return svgEl('svg', { class: 'narr-ico', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    svgEl('path', { d: 'M3 9h4l5-4v14l-5-4H3z', fill: 'currentColor' }),
    on ? svgEl('path', { class: 'narr-waves', d: 'M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
      : svgEl('path', { d: 'M16 9.5l5 5M21 9.5l-5 5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }));
}
function glyph(kind) {
  // ▶ play / ■ stop, drawn (font-independent, same box for both)
  return svgEl('svg', { class: 'narr-glyph', viewBox: '0 0 12 12', 'aria-hidden': 'true', focusable: 'false' },
    kind === 'stop' ? svgEl('rect', { x: 2, y: 2, width: 8, height: 8, fill: 'currentColor' }) : svgEl('path', { d: 'M3 1.5v9l7.5-4.5z', fill: 'currentColor' }));
}

/* ------------------------------------------------------------------ clips */
function clipFor(title) {
  if (!clips || typeof title !== 'string') return null;
  return clips.get(title.trim().toLowerCase()) || null;
}
function currentClip() { return st.game ? clipFor(st.game.title) : null; }
function clipUrl(c) { return new URL(c.src, BASE).href; }
// fetched when the module is evaluated (index.html preloads the module), so the ▶ Listen buttons are known before the
// first game state arrives and never pop in after it
const manifestReq = fetch(MANIFEST_URL, { cache: 'no-cache', credentials: 'same-origin' })
  .then((res) => { if (!res.ok) throw new Error(String(res.status)); return res.json(); });
manifestReq.catch(() => { /* handled in loadManifest */ });
async function loadManifest() {
  try {
    const list = await manifestReq;
    const m = new Map();
    for (const x of Array.isArray(list) ? list : []) {
      if (!x || typeof x.title !== 'string' || typeof x.src !== 'string') continue;
      // same-origin relative paths only
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(x.src)) continue;
      m.set(x.title.trim().toLowerCase(), { title: x.title, src: x.src, voice: x.voice || '', durationSec: Number(x.durationSec) || 0 });
    }
    clips = m;
  } catch {
    clips = new Map();          // no narration available: no controls, no errors
  }
  if (st.pendingAuto && st.game && st.pendingAuto === st.game.title) { st.pendingAuto = ''; play(true); }
  changed();
}

/* ------------------------------------------------------------------ playback */
function changed() {
  updatePill();
  try { opts.onChange(); } catch { /* the host's problem */ }
}
function playing() { return st.status === 'playing' || st.status === 'loading'; }
function play(auto) {
  const c = currentClip();
  if (!c || !audio) return;
  const url = clipUrl(c);
  const token = ++playSeq;
  st.blocked = false;
  st.forTitle = st.game.title;
  if (st.status === 'error' || audio.error) st.hint = '';   // a new try: drop the old failure message
  if (audio.src !== url) {
    audio.preload = 'auto';
    audio.src = url;
  } else if (audio.error) {
    audio.load();                             // the last download failed (flaky network): fetch it again
  } else if (audio.ended || audio.currentTime > 0) {
    try { audio.currentTime = 0; } catch { /* not seekable yet: plays from where it is */ }
  }
  audio.volume = prefs.vol / 100;
  st.status = 'loading';
  let p;
  try { p = audio.play(); } catch (e) { p = Promise.reject(e); }
  Promise.resolve(p).then(() => {
    if (token !== playSeq) return;
    st.status = audio.paused ? 'idle' : 'playing';
    changed();
  }, (err) => {
    if (token !== playSeq) return;           // stopped or restarted meanwhile (AbortError): nothing to say
    const name = err && err.name;
    if (name === 'NotAllowedError') {         // no user gesture yet: offer a button instead
      st.status = 'idle';
      st.blocked = !!auto || st.blocked;
      if (!auto) st.hint = 'Your browser blocked the sound. Tap ▶ Listen again.';
    } else if (name === 'AbortError') {
      st.status = 'idle';
    } else {
      st.status = 'error';
      st.hint = 'The narration could not be played on this device.';
    }
    changed();
  });
  changed();
}
// user Stop: rewind, keep the clip loaded
function stop() {
  playSeq++;
  st.blocked = false;
  if (audio && (!audio.paused || audio.currentTime > 0)) {
    audio.pause();
    try { audio.currentTime = 0; } catch { /* ignore */ }
  }
  st.status = 'idle';
}
// leaving the game (lobby, another room, left): stop and drop the clip, so nothing keeps downloading
function reset() {
  playSeq++;
  st.blocked = false;
  st.pendingAuto = '';
  st.status = 'idle';
  st.forTitle = '';
  if (audio && audio.getAttribute('src')) {
    audio.pause();
    audio.removeAttribute('src');
    audio.preload = 'none';
    try { audio.load(); } catch { /* ignore */ }
  }
}
function setVolume(v) {
  const n = Math.max(0, Math.min(100, Math.round(Number(v))));
  if (!Number.isFinite(n)) return;
  prefs.vol = n;
  if (audio) audio.volume = n / 100;
  savePrefs();
  for (const o of document.querySelectorAll('[data-narr-out]')) o.textContent = n + '%';
}
function toggle() {
  if (table) { table.want(!table.on); return; }   // the test table decides; it answers with devSound()
  prefs.on = !prefs.on;
  savePrefs();
  if (prefs.on) {
    const inLobby = !st.game;
    st.hint = inLobby || !currentClip() ? TEXT_LOBBY_ON : TEXT_GAME_ON;
    opts.notify(st.hint);
  } else {
    st.hint = 'Narrator off. The ▶ Listen button still plays it on demand.';
    stop();
  }
}

/* ------------------------------------------------------------------ the page tells us what is on screen */
// The game's start marker: the log id of the server's "…Catastrophe: <title>…" system line (Play again keeps the log
// and ids only grow, so it differs per game); plus the room and the title.
function startLine(s) {
  const log = Array.isArray(s.log) ? s.log : [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e && e.kind === 'system' && typeof e.text === 'string' && e.text.includes('Catastrophe:')) return e;
  }
  return null;
}
function gameKey(s) {
  const e = startLine(s);
  return `${s.room}|${e ? String(e.id) : ''}|${String(s.catastrophe.title).trim().toLowerCase()}`;
}
// ms since the game started by the server's clock, as this page sees it now (null = unknown, e.g. a mock state)
function startAge(s) {
  const e = startLine(s);
  if (!e || typeof e.ts !== 'number' || !(e.ts > 0) || clockSkew === null) return null;
  return Date.now() + clockSkew - e.ts;
}
export function sync(s) {
  if (!started) return;
  const prev = st.seen;
  if (s === prev) return;
  st.seen = s || null;
  // each sample under-estimates the offset by that message's delay: the largest one is the closest (a state that
  // arrives late — a reconnect, a frozen tab — gives a small one and changes nothing)
  if (s && typeof s.serverNow === 'number' && Number.isFinite(s.serverNow)) {
    const o = s.serverNow - Date.now();
    clockSkew = clockSkew === null ? o : Math.max(clockSkew, o);
  }
  const title = s && s.catastrophe && typeof s.catastrophe.title === 'string' ? s.catastrophe.title : '';
  const inGame = !!s && s.phase !== 'lobby' && !!title;
  const game = inGame ? { room: s.room, title: title.trim().toLowerCase(), label: title } : null;
  const same = !!game && !!st.game && st.game.room === game.room && st.game.title === game.title;
  if (!same) {
    // back in the lobby (Play again), another room or game, or the room was left: silence
    if (st.forTitle || st.blocked || playing()) reset();
    st.pendingAuto = '';
    if (!s) st.menu = false;
  }
  st.game = game;
  if (st.blocked && s && (s.round > 1 || s.overtime)) st.blocked = false;   // the moment has passed
  // Autoplay only on the transition this page saw itself: lobby -> round 1 of the same room, and only while that start
  // is fresh. A reload mid-game starts without a lobby state; a page that was offline (or frozen) in the lobby gets
  // the news late: neither autoplays. The key keeps it to once per game (also across tabs of one browser).
  if (game && isOn() && prev && prev.room === s.room && prev.phase === 'lobby' && s.round === 1 && !s.overtime && s.phase !== 'final') {
    const key = gameKey(s);
    const age = startAge(s);
    if ((age === null || age <= FRESH_MS) && !wasPlayed(key)) {
      markPlayed(key);
      if (clips) play(true); else st.pendingAuto = game.title;
    }
  }
  updatePill();
}

/* ------------------------------------------------------------------ UI pieces for the host's tree */
function listenLabel() {
  if (st.status === 'loading') return 'Loading…';
  if (st.status === 'playing') return 'Stop';
  return 'Listen';
}
function listenButton(c, where, testid) {
  if (!c) return null;
  const on = playing();
  return el('button', {
    class: ['narr-listen', on && 'is-on', st.status === 'loading' && 'is-loading', st.status === 'error' && 'is-error'],
    'data-narr': 'play', 'data-where': where, 'data-testid': testid, 'data-state': st.status,
    'aria-pressed': String(on),
    title: on ? 'Stop the narration' : `Hear “${c.title}” read aloud (about ${Math.round(c.durationSec) || 40} s)`,
    'aria-label': on ? 'Stop the narration' : `Listen to the catastrophe, ${c.title}`,
  }, glyph(on ? 'stop' : 'play'), el('span', { class: 'narr-listen-t', text: listenLabel() }));
}
export function titleRow(titleEl, s, where) {
  if (!started || !s || !s.catastrophe || s.phase === 'lobby') return titleEl;
  // narration.json not in yet: hold the button's place (invisible), so it never pops in and pushes the text down
  if (clips === null) {
    return el('div', { class: 'narr-title-row', 'data-key': 'narr-row-' + where }, titleEl,
      el('span', { class: 'narr-listen is-pending', 'aria-hidden': 'true' }, glyph('play'), el('span', { class: 'narr-listen-t', text: 'Listen' })));
  }
  const c = clipFor(s.catastrophe.title);
  if (!c) return titleEl;
  return el('div', { class: 'narr-title-row', 'data-key': 'narr-row-' + where }, titleEl, listenButton(c, where, 'narrator-play'));
}
export function headerControl(s) {
  if (!started) return null;
  const on = isOn();
  const live = playing();
  const inGame = !!(s && s.phase !== 'lobby');
  return el('div', { class: ['narr-hdr', on && 'is-on', live && 'is-live', st.menu && 'is-open', inGame ? 'in-game' : 'in-lobby'], 'data-key': 'narr-hdr' },
    el('button', {
      class: 'btn ghost sm narr-btn', 'data-narr': 'menu', 'data-testid': 'narrator-menu',
      'aria-haspopup': 'dialog', 'aria-expanded': String(st.menu),
      title: on ? 'Narrator is on: the catastrophe is read aloud when a game starts' : 'Narrator is off: turn it on to hear the catastrophe read aloud',
      'aria-label': `Narrator (${on ? 'on' : 'off'})`,
    }, speaker(on || live), el('span', { class: 'narr-btn-t', text: 'Narrator' })),
    st.menu ? popover(s) : null);
}
function popover(s) {
  const on = isOn();
  const c = currentClip();
  const inGame = !!(s && s.phase !== 'lobby');
  let note = st.hint;
  if (!note && playing() && c) note = `Playing “${c.title}”.`;
  if (!note) note = on ? (inGame ? 'On: it plays when the next game starts.' : TEXT_LOBBY_ON) : 'Off: nothing plays by itself.';
  return el('div', { class: 'narr-pop', role: 'dialog', 'aria-label': 'Narrator', 'data-key': 'narr-pop' },
    el('div', { class: 'narr-pop-head' },
      el('span', { class: 'narr-pop-k', text: 'Narrator' }),
      el('button', { class: 'narr-x', 'data-narr': 'close', 'aria-label': 'Close', title: 'Close' }, '×')),
    el('p', { class: 'narr-pop-lead', text: 'A dramatic British voice reads the catastrophe aloud when the game starts. Only on this device — turn it on if you want it.' }),
    table ? el('p', { class: 'narr-pop-note', 'data-testid': 'narrator-table-note', text: table.on ? STR.narrTableOn : table.who ? STR.narrTableOther({ who: table.who }) : STR.narrTableOff }) : null,
    el('button', { class: ['narr-switch', on && 'is-on'], role: 'switch', 'aria-checked': String(on), 'data-narr': 'toggle', 'data-testid': 'narrator-toggle' },
      el('span', { class: 'narr-switch-t', text: 'Read the catastrophe at game start' }),
      el('span', { class: 'narr-track', 'aria-hidden': 'true' }, el('span', { class: 'narr-knob' })),
      el('span', { class: 'narr-switch-v', text: on ? 'On' : 'Off' })),
    volumeWorks
      ? el('label', { class: 'narr-vol' },
        el('span', { class: 'narr-vol-k', text: 'Volume' }),
        el('input', { type: 'range', min: 0, max: 100, step: 1, value: prefs.vol, class: 'narr-range', 'data-narr': 'volume', 'data-testid': 'narrator-volume', 'aria-label': 'Narrator volume' }),
        el('span', { class: 'narr-vol-v', 'data-narr-out': '', text: prefs.vol + '%' }))
      // iOS: a page cannot set media volume, so a slider would do nothing
      : el('div', { class: 'narr-vol', 'data-testid': 'narrator-volume-fixed' },
        el('span', { class: 'narr-vol-k', text: 'Volume' }),
        el('span', { class: 'narr-vol-na', text: 'Use your device’s volume buttons.' })),
    c ? el('div', { class: 'narr-pop-play' }, listenButton(c, 'menu', 'narrator-play-menu'), el('span', { class: 'narr-pop-clip', text: c.title })) : null,
    inGame && clips && !c ? el('p', { class: 'narr-pop-note', text: 'No narration for this catastrophe.' }) : null,
    el('p', { class: ['narr-pop-note', st.status === 'error' && 'is-error'], role: 'status', text: note }));
}

/* ------------------------------------------------------------------ the prompt when autoplay was refused */
function updatePill() {
  if (!pill) return;
  const c = st.blocked ? currentClip() : null;
  const show = !!c && !playing();
  if (pill.hidden === !show && (!show || pill.getAttribute('data-title') === c.title)) return;
  pill.hidden = !show;
  if (show) {
    pill.setAttribute('data-title', c.title);
    const sub = pill.querySelector('.narr-pill-sub');
    if (sub) sub.textContent = `${c.title} — your browser wants one tap for sound`;
  }
}
function makePill() {
  pill = el('div', { class: 'narr-pill', role: 'region', 'aria-label': 'Narration', hidden: true },
    el('button', { class: 'narr-pill-go', 'data-narr': 'unblock', 'data-testid': 'narrator-unblock' },
      glyph('play'),
      el('span', { class: 'narr-pill-text' }, el('span', { class: 'narr-pill-t', text: 'Listen to the catastrophe' }), el('span', { class: 'narr-pill-sub' }))),
    el('button', { class: 'narr-pill-x', 'data-narr': 'dismiss', 'aria-label': 'No thanks', title: 'No thanks' }, '×'));
  document.body.appendChild(pill);
}

/* ------------------------------------------------------------------ events */
function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  const ctl = t ? t.closest('[data-narr]') : null;
  if (st.menu && !(t && t.closest('.narr-hdr'))) { st.menu = false; changed(); }
  if (!ctl || ctl.hasAttribute('disabled')) return;
  const act = ctl.getAttribute('data-narr');
  if (act === 'volume') return;
  e.preventDefault();
  switch (act) {
    case 'menu': st.menu = !st.menu; if (st.menu) st.hint = ''; break;
    case 'close': st.menu = false; focusMenuButton(); break;
    case 'toggle': toggle(); break;
    case 'play': if (playing()) stop(); else { play(false); if (table && !table.on) table.want(true); } break;
    case 'unblock': play(false); break;
    case 'dismiss': st.blocked = false; break;
    default: return;
  }
  changed();
}
function focusMenuButton() {
  setTimeout(() => { const b = document.querySelector('[data-testid="narrator-menu"]'); if (b) try { b.focus({ preventScroll: true }); } catch { /* ignore */ } }, 0);
}
function onInput(e) {
  const t = e.target;
  if (t instanceof HTMLInputElement && t.getAttribute('data-narr') === 'volume') setVolume(t.value);
}
function onKey(e) {
  if (e.key === 'Escape' && st.menu) { st.menu = false; changed(); focusMenuButton(); }
}
// another tab of this browser changed the preferences: follow them (else this tab would save its stale copy over them)
function onStorage(e) {
  if (e.key !== pkey(PREF_KEY) && e.key !== null) return;    // another profile's tab is not ours; null: storage was cleared
  readPrefs();
  if (audio) audio.volume = prefs.vol / 100;
  for (const o of document.querySelectorAll('[data-narr-out]')) o.textContent = prefs.vol + '%';
  changed();
}

/* ------------------------------------------------------------------ the /dev test table (SPEC §11 X9.3)
 * Every seat of the table is a page of this client in one browser tab: several narrators would read the same
 * catastrophe at once. So the table gives the sound to one seat, through the seat's dev bridge (public/app.js):
 *   devSound({ on, who }, want)   on: this seat has the sound, and plays at the game start as if its switch were on
 *                                 (the switch this profile saved is left as it is); who: the seat that has it ('' =
 *                                 none); want(bool): ask the table for the sound (▶ Listen here, or the switch).
 *                                 Losing the sound stops a clip, so one seat plays at a time.
 *   devState()                    { on, status } for the table's seat header: idle | loading | playing | error | blocked */
export function devSound(v, want) {
  if (!started || !v || typeof v !== 'object') return;
  table = { on: v.on === true, who: typeof v.who === 'string' ? v.who : '', want: typeof want === 'function' ? want : () => {} };
  if (!table.on) { st.pendingAuto = ''; if (playing() || st.blocked) stop(); }
  changed();
}
export function devState() {
  return { on: isOn(), status: st.blocked && !playing() ? 'blocked' : st.status };
}

export function init(o = {}) {
  if (started) return;
  started = true;
  opts = { ...opts, ...o };
  readPrefs();
  audio = document.createElement('audio');
  audio.preload = 'none';
  audio.hidden = true;
  audio.setAttribute('data-testid', 'narrator-audio');
  try { audio.volume = 0.5; volumeWorks = Math.abs(audio.volume - 0.5) < 0.01; } catch { volumeWorks = false; }
  audio.volume = prefs.vol / 100;
  const onMedia = (ev) => {
    if (!audio.getAttribute('src')) return;
    if (ev.type === 'playing') st.status = 'playing';
    else if (ev.type === 'waiting' && !audio.paused) st.status = 'loading';
    else if (ev.type === 'pause' || ev.type === 'ended') { if (st.status !== 'error') st.status = 'idle'; }
    else if (ev.type === 'error') { st.status = 'error'; st.hint = 'The narration could not be loaded.'; }
    changed();
  };
  for (const t of ['playing', 'waiting', 'pause', 'ended', 'error']) audio.addEventListener(t, onMedia);
  document.body.appendChild(audio);
  makePill();
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('keydown', onKey);
  if (!opts.memory) window.addEventListener('storage', onStorage);
  loadManifest();
}

