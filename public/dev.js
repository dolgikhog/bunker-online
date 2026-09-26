/* Bunker Online — the dev test table (SPEC §11 X9.3 / X9.4). An English-only tool, exempt from i18n; the server
 * serves it at /dev only when it runs with BUNKER_DEV=1 (`npm run dev`).
 *
 * One page, N human seats side by side. Each seat is an <iframe> of the normal client with its own ?profile=pK, so
 * each keeps its own identity although every frame of this tab shares one localStorage and one sessionStorage. The
 * frames are phone-sized (or tablet / laptop) and scaled to fit: a grid, a grid with one seat focused (enlarged), or
 * tabs. A frame is never moved in the DOM (that would reload it): layouts only reposition it.
 *
 * No socket of its own. Dev ops must come from a member of the room (X9.4), so every command goes through a seat:
 * this page posts { bunkerDev: 1, cmd } to the frame of the host seat, and the client's dev bridge (public/app.js,
 * "dev mode": installed only in a frame, and only when GET /devinfo says dev) sends { t: 'dev', op, ...params } on
 * that seat's own socket. The seats post their status, every StateView (the god view included) and every error
 * back. The bridge's comment in app.js lists the messages.
 *
 * Seat K's URL is /?room=CODE&name=PK&profile=pK&autojoin=1 (X9.3). Seat 1 creates the room through the bridge
 * ({ cmd: 'create', name: 'P1', seed }): before the first game its frame is /?profile=p1&name=P1.
 *
 * Test hooks (tools/dev-smoke.js): data-testid="dev-*" on every control; each seat is dev-seat (+data-seat,
 * data-profile, data-player-id, data-status) with an iframe[data-seat]; window.__devTable is a read-only snapshot. */

const MIN_SEATS = 2;
const MAX_SEATS = 16;
const SIZES = {
  phone: { w: 390, h: 844, label: 'Phone 390×844' },
  small: { w: 360, h: 740, label: 'Small phone 360×740' },
  tablet: { w: 820, h: 1180, label: 'Tablet 820×1180' },
  laptop: { w: 1280, h: 800, label: 'Laptop 1280×800' },
};
// every effect giveSpecial accepts (§5 and X1; `eject` is gone since X1)
const EFFECTS = [
  ['airlock', 'airlock — Airlock (needs a partner)'],
  ['revive', 'revive — Back from the Forest'],
  ['swap_card', 'swap_card'], ['reroll_card', 'reroll_card'], ['force_reveal', 'force_reveal'], ['peek', 'peek'],
  ['mass_reveal', 'mass_reveal'], ['shuffle_category', 'shuffle_category'],
  ['immunity', 'immunity'], ['protect', 'protect'], ['double_vote', 'double_vote'], ['block_vote', 'block_vote'],
  ['cancel_vote', 'cancel_vote'], ['capacity_plus', 'capacity_plus'], ['capacity_minus', 'capacity_minus'],
  ['bunker_add_feature', 'bunker_add_feature'],
];
const CATS_FALLBACK = [
  { id: 'profession', label: 'Profession' }, { id: 'biology', label: 'Biology' }, { id: 'health', label: 'Health' },
  { id: 'hobby', label: 'Hobby' }, { id: 'phobia', label: 'Phobia' }, { id: 'skill', label: 'Extra skill' },
  { id: 'trait', label: 'Personality' }, { id: 'baggage', label: 'Baggage' },
];
const PHASE = { lobby: 'Lobby', reveal: 'Reveals', discussion: 'Discussion', vote: 'Vote', defense: 'Defense', final: 'Final' };
const SAVE_KEY = 'bunker.dev.table';   // this page's own settings (the seats' storage is namespaced by their profiles)
const HEAD_H = 30;
const GAP = 10;
const NO_BRIDGE_MS = 7000;

/* ------------------------------------------------------------------ settings */
const T = {
  n: 4, seed: '', layout: 'grid', size: 'phone', room: '', bots: 2, focus: 0, tab: 1,
  godFold: false,     // the god view's table folded to its header line (the god view itself stays on)
  ctlHidden: false,   // the controls column hidden (the seats get its width); the top bar's button brings it back
  effect: 'airlock', target: '',
  tie: new Set(),
  seats: new Map(),   // k -> seat
  log: [],
  busy: false,
};
function clampInt(v, lo, hi, dflt) { const n = Number(v); return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
function loadSettings() {
  let j = null;
  try { j = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { j = null; }
  if (!j || typeof j !== 'object') return;
  T.n = clampInt(j.n, MIN_SEATS, MAX_SEATS, 4);
  T.seed = typeof j.seed === 'string' ? j.seed.slice(0, 64) : '';
  T.layout = j.layout === 'tabs' ? 'tabs' : 'grid';
  T.size = SIZES[j.size] ? j.size : 'phone';
  T.room = typeof j.room === 'string' && /^[A-Z]{4}$/.test(j.room) ? j.room : '';
  T.bots = clampInt(j.bots, 1, 15, 2);
  T.focus = clampInt(j.focus, 0, MAX_SEATS, 0);
  T.tab = clampInt(j.tab, 1, MAX_SEATS, 1);
  T.godFold = j.godFold === true;
  T.ctlHidden = j.ctlHidden === true;
}
function saveSettings() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ n: T.n, seed: T.seed, layout: T.layout, size: T.size, room: T.room, bots: T.bots, focus: T.focus, tab: T.tab, godFold: T.godFold, ctlHidden: T.ctlHidden }));
  } catch { /* storage blocked: settings are per load then */ }
}

/* ------------------------------------------------------------------ tiny DOM builder (text only via textContent) */
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'testid') n.setAttribute('data-testid', v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    n.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (tag === 'button' && !n.hasAttribute('type')) n.type = 'button';
  return n;
}
function setKids(n, ...kids) { n.replaceChildren(...kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)); }

/* ------------------------------------------------------------------ seats */
const baseUrl = (k) => `/?profile=p${k}&name=P${k}`;
const seatUrl = (k) => `/?room=${T.room}&name=P${k}&profile=p${k}&autojoin=1`;

function makeSeat(k) {
  const seat = { k, profile: `p${k}`, name: `P${k}`, url: '', status: null, state: null, ready: false, blocked: false, noBridge: false, errors: 0, loadTimer: 0 };
  seat.frame = el('iframe', { class: 'seat-frame', title: `Seat ${k} (P${k})`, name: `seat-${k}`, 'data-seat': k, allow: 'autoplay; clipboard-write', tabindex: '-1' });
  seat.ph = el('div', { class: 'seat-ph' }, el('b', { text: `P${k}` }), el('span', { text: 'joins at the next New test game' }));
  seat.box = el('div', { class: 'seat-box' }, seat.frame, seat.ph);
  seat.head = el('div', { class: 'seat-head' });
  seat.cell = el('section', { class: 'seat', testid: 'dev-seat', 'data-seat': k, 'data-profile': seat.profile }, seat.head, seat.box);
  seat.frame.addEventListener('load', () => onFrameLoad(seat));
  ui.seats.appendChild(seat.cell);   // appended once, never moved (moving an iframe reloads it)
  T.seats.set(k, seat);
  return seat;
}
function removeSeat(seat) {
  clearTimeout(seat.loadTimer);
  try { seat.frame.src = 'about:blank'; } catch { /* ignore */ }
  seat.cell.remove();
  T.seats.delete(seat.k);
  T.tie.clear();
}
function setSeatUrl(seat, url) {
  seat.url = url || '';
  seat.ready = false; seat.blocked = false; seat.noBridge = false;
  seat.status = null; seat.state = null;
  seat.cell.classList.toggle('empty', !url);
  seat.frame.src = url || 'about:blank';
}
function onFrameLoad(seat) {
  if (!seat.url) return;
  let blocked = false;
  try { void seat.frame.contentWindow.location.href; } catch { blocked = true; }   // an error page is cross-origin
  seat.blocked = blocked;
  if (blocked) logLine(seat, '✖ the frame was refused: the server must allow same-origin framing (X-Frame-Options: SAMEORIGIN) in dev mode', 'err');
  clearTimeout(seat.loadTimer);
  if (!blocked) {
    seat.loadTimer = setTimeout(() => {
      if (!seat.ready && seat.url) { seat.noBridge = true; logLine(seat, '✖ no dev bridge in this seat (does GET /devinfo say {"dev":true}?)', 'err'); schedule(); }
    }, NO_BRIDGE_MS);
  }
  schedule();
}
function post(seat, msg) {
  if (!seat || !seat.frame.contentWindow) return false;
  try { seat.frame.contentWindow.postMessage({ bunkerDev: 1, ...msg }, location.origin); return true; } catch { return false; }
}
function seatsInOrder() { return [...T.seats.values()].sort((a, b) => a.k - b.k); }
function inRoom(seat) { return !!(seat && seat.ready && seat.state && seat.status && seat.status.screen === 'room' && seat.state.room === T.room); }
// dev ops and Start go through the host's seat; any seat in the room will do for a dev op (X9.4: any member)
function hostSeat() { return seatsInOrder().find((s) => inRoom(s) && s.state.you.isHost) || null; }
function opSeat() { return hostSeat() || seatsInOrder().find(inRoom) || null; }
function viewState() { const s = hostSeat() || opSeat(); return s ? s.state : null; }
/** The language of a seat's page ('en' until its state says otherwise). */
function seatLang(seat) { const l = seat && seat.state && seat.state.you ? seat.state.you.lang : null; return typeof l === 'string' && l ? l : 'en'; }
function godSeat() { return seatsInOrder().find((s) => inRoom(s) && s.state.god && typeof s.state.god === 'object') || null; }

/* ------------------------------------------------------------------ messages from the seats */
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const m = e.data;
  if (!m || typeof m !== 'object' || m.bunkerDev !== 1 || typeof m.ev !== 'string') return;
  const seat = seatsInOrder().find((s) => s.frame.contentWindow === e.source);
  if (!seat) return;
  switch (m.ev) {
    case 'ready':
      seat.ready = true; seat.noBridge = false;
      clearTimeout(seat.loadTimer);
      break;
    case 'status':
      seat.status = { screen: String(m.screen || ''), room: String(m.room || ''), id: String(m.id || ''), online: !!m.online, pending: !!m.pending };
      if (seat.status.screen === 'landing') seat.state = null;
      break;
    case 'joined':
      logLine(seat, `joined ${m.room} as ${m.id}`);
      break;
    case 'state':
      if (m.state && typeof m.state === 'object' && m.state.you) seat.state = m.state;
      break;
    case 'error':
      // `replaced`: this seat was opened in another tab (↗), which is what that button is for; ⟳ takes it back
      if (m.code === 'replaced') { logLine(seat, 'opened in another tab: this frame stopped (⟳ takes the seat back)'); break; }
      seat.errors++;
      // (the message is in the seat's language, SPEC §11 X5.1: a seat switched to Russian says so, in this English log)
      logLine(seat, `✖ ${m.code}${seatLang(seat) !== 'en' ? ` [${seatLang(seat)}]` : ''}: ${m.message}`, 'err');
      if (m.code === 'no_room' && T.room && seat.status && !seat.status.room) logLine(null, `room ${T.room} is gone (a server restart?): press New test game`, 'err');
      break;
    default: return;
  }
  schedule();
});

/* ------------------------------------------------------------------ commands */
async function waitFor(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 80));
  }
}
function sendDev(op, params) {
  const s = opSeat();
  if (!s) { logLine(null, `✖ ${op}: no seat is in a room yet (New test game first)`, 'err'); return false; }
  post(s, { cmd: 'dev', op, params: params || {} });
  logLine(s, `→ ${op}${params && Object.keys(params).length ? ' ' + JSON.stringify(params) : ''}`, 'op');
  return true;
}
async function newGame() {
  if (T.busy) return;
  T.busy = true;
  schedule();
  try {
    const n = clampInt(ui.n.value, MIN_SEATS, MAX_SEATS, 4);
    const seed = ui.seed.value.trim().slice(0, 64);
    T.n = n; T.seed = seed;
    ui.n.value = String(n);
    const oldRoom = T.room;
    logLine(null, `New test game: ${n} seats${seed ? `, seed "${seed}"` : ''}`);
    // 1. every seat leaves the previous test game for good (else its seat would sit there offline)
    const leaving = seatsInOrder().filter((s) => s.ready && s.status && s.status.room);
    for (const s of leaving) post(s, { cmd: 'leave' });
    if (leaving.length) await waitFor(() => leaving.every((s) => !s.ready || !s.status || !s.status.room), 2500);
    T.room = '';
    T.tie.clear();
    if (T.focus > n) T.focus = 0;
    if (T.tab > n) T.tab = 1;
    // 2. seats beyond n go away
    for (const s of seatsInOrder()) if (s.k > n) removeSeat(s);
    // 3. seat 1 creates the room as P1 (the host), through its bridge
    const s1 = T.seats.get(1) || makeSeat(1);
    if (!s1.url || !s1.ready) {
      setSeatUrl(s1, baseUrl(1));
      layout();
      if (!(await waitFor(() => s1.ready || s1.blocked, 9000)) || s1.blocked) throw new Error('seat 1 has no dev bridge (see its frame and the log)');
    }
    s1.state = null;
    post(s1, { cmd: 'create', name: 'P1', seed: seed || undefined });
    const created = await waitFor(() => (inRoomAny(s1) && s1.state.phase === 'lobby' && s1.state.you.isHost && s1.state.room !== oldRoom ? s1.state.room : null), 9000);
    if (!created) throw new Error('seat 1 did not create a room (see its frame and the log)');
    T.room = created;
    s1.url = seatUrl(1);   // not reloaded: its page already put ?room= in its own URL
    // 4. seats 2..n join it by themselves
    for (let k = 2; k <= n; k++) setSeatUrl(T.seats.get(k) || makeSeat(k), seatUrl(k));
    saveSettings();
    layout();
    logLine(null, `room ${T.room} created by P1; P2..P${n} are joining`);
  } catch (err) {
    logLine(null, `✖ ${err.message}`, 'err');
  } finally {
    T.busy = false;
    schedule();
  }
}
function inRoomAny(s) { return !!(s && s.ready && s.state && s.status && s.status.screen === 'room'); }

/* ------------------------------------------------------------------ log */
function logLine(seat, text, kind = '') {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  T.log.push({ ts, who: seat ? `P${seat.k}` : 'table', text: String(text), kind });
  if (T.log.length > 150) T.log.splice(0, T.log.length - 150);
  schedule();
}

/* ------------------------------------------------------------------ layout: grid, grid with a focused seat, tabs */
function place(seat, x, y, k, visible = true) {
  const { w, h } = SIZES[T.size];
  seat.cell.style.left = `${Math.round(x)}px`;
  seat.cell.style.top = `${Math.round(y)}px`;
  seat.cell.style.width = `${Math.floor(w * k)}px`;
  seat.cell.style.visibility = visible ? 'visible' : 'hidden';
  seat.cell.style.zIndex = visible ? '' : '-1';
  seat.box.style.width = `${Math.floor(w * k)}px`;
  seat.box.style.height = `${Math.floor(h * k)}px`;
  seat.frame.style.width = `${w}px`;
  seat.frame.style.height = `${h}px`;
  seat.frame.style.transform = `scale(${k})`;
  seat.cell.dataset.scale = k.toFixed(3);
  return { right: x + w * k, bottom: y + HEAD_H + h * k };
}
function gridIn(list, x, y, W, H, maxK = 1) {
  const { w, h } = SIZES[T.size];
  if (!list.length) return { right: x, bottom: y };
  let best = { c: 1, k: 0 };
  for (let c = 1; c <= list.length; c++) {
    const r = Math.ceil(list.length / c);
    const k = Math.min((W - (c - 1) * GAP) / c / w, (H - (r - 1) * GAP - r * HEAD_H) / r / h);
    if (k > best.k) best = { c, k };
  }
  const k = Math.max(0.16, Math.min(maxK, best.k));
  let right = x;
  let bottom = y;
  list.forEach((s, i) => {
    const col = i % best.c;
    const row = Math.floor(i / best.c);
    const e = place(s, x + col * (w * k + GAP), y + row * (h * k + HEAD_H + GAP), k);
    right = Math.max(right, e.right);
    bottom = Math.max(bottom, e.bottom);
  });
  return { right, bottom };
}
function layout() {
  const list = seatsInOrder();
  const W = ui.seats.clientWidth - 2 * GAP;
  const H = ui.seats.clientHeight - 2 * GAP;
  const { w, h } = SIZES[T.size];
  let ext = { right: 0, bottom: 0 };
  const tabs = T.layout === 'tabs';
  const focus = !tabs && T.focus && T.seats.has(T.focus) ? T.seats.get(T.focus) : null;
  ui.stage.classList.toggle('tabs', tabs);
  if (tabs) {
    if (!T.seats.has(T.tab)) T.tab = list.length ? list[0].k : 1;
    const k = Math.max(0.2, Math.min(1, W / w, (H - HEAD_H) / h));
    for (const s of list) {
      const e = place(s, GAP, GAP, k, s.k === T.tab);
      if (s.k === T.tab) ext = e;
    }
  } else if (focus) {
    const others = list.filter((s) => s !== focus);
    const kf = Math.max(0.2, Math.min(1, (H - HEAD_H) / h, (others.length ? W * 0.62 : W) / w));
    const e1 = place(focus, GAP, GAP, kf);
    const x0 = e1.right + GAP * 2;
    // the others are thumbnails, at most 60% of the focused seat: when the seats are short (the god table is open)
    // they would otherwise come out as big as the focused one
    const e2 = gridIn(others, x0, GAP, Math.max(120, W + GAP - x0), H, Math.max(0.16, kf * 0.6));
    ext = { right: Math.max(e1.right, e2.right), bottom: Math.max(e1.bottom, e2.bottom) };
  } else {
    ext = gridIn(list, GAP, GAP, W, H);
  }
  for (const s of list) s.cell.classList.toggle('focused', s === focus);
  ui.sizer.style.width = `${Math.ceil(ext.right + GAP)}px`;
  ui.sizer.style.height = `${Math.ceil(ext.bottom + GAP)}px`;
  renderTabs();
}

/* ------------------------------------------------------------------ rendering (the controls are built once; this refreshes them) */
let queued = false;
function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; update(); });
}
function playerLabel(s, p) { return `${p.name} · ${p.id}${p.status !== 'alive' ? ` · ${p.status}` : ''}${p.id === s.hostId ? ' · host' : ''}`; }
function sigOf(list) { return list.map((x) => x.join('\u0001')).join('\u0002'); }
function fillSelect(sel, options, keep) {
  const sig = sigOf(options);
  if (sel.dataset.sig !== sig) {
    setKids(sel, options.map(([v, label]) => el('option', { value: v, text: label })));
    sel.dataset.sig = sig;
  }
  if (options.some(([v]) => v === keep)) sel.value = keep;
  else if (options.length) sel.value = options[0][0];
}
function update() {
  const vs = viewState();
  const host = hostSeat();
  const ready = !!opSeat() && !T.busy;
  // top bar
  const players = vs ? vs.players : [];
  const alive = players.filter((p) => p.status === 'alive').length;
  setKids(ui.status,
    el('span', { class: 'st-k', text: 'Room' }), el('b', { class: 'st-room mono', testid: 'dev-room', text: T.room || '—' }),
    vs ? [
      el('span', { class: 'st-sep', text: '·' }), el('span', { testid: 'dev-phase', 'data-phase': vs.phase, text: `${PHASE[vs.phase] || vs.phase}${vs.phase !== 'lobby' ? (vs.overtime ? ' · overtime' : ` · round ${vs.round}/${vs.maxRounds || 7}`) : ''}` }),
      vs.phase !== 'lobby' ? [el('span', { class: 'st-sep', text: '·' }), el('span', { text: `beds ${vs.capacity} / alive ${alive}` })] : null,
      el('span', { class: 'st-sep', text: '·' }), el('span', { text: `${players.length} seated, ${(vs.spectators || []).length} watching` }),
      el('span', { class: 'st-sep', text: '·' }), el('span', { text: `host ${host ? `P${host.k}` : (players.find((p) => p.id === vs.hostId) || { name: '—' }).name}` }),
    ] : el('span', { class: 'st-dim', text: T.busy ? 'working…' : T.room ? 'waiting for the seats…' : 'no game yet: set the seats and press New test game' }),
    T.room ? el('a', { class: 'st-link', href: `/?room=${T.room}&profile=watch`, target: '_blank', rel: 'noopener', title: 'A spectator (or a late arrival) in a new tab, with its own profile' }, 'watch ↗') : null);
  // buttons
  ui.newGame.disabled = T.busy;
  ui.newGame.textContent = T.busy ? 'Working…' : 'New test game';
  // Each button is enabled only where the server would take it, and says why not on hover (the server still checks)
  const phase = vs ? vs.phase : '';
  const noSeat = T.busy ? 'Wait: the table is setting up' : 'No seat is in a room yet: press New test game first';
  const gate = (b, ok, why) => { b.disabled = !ok; b.title = ok ? (b.dataset.hint || '') : why; };
  for (const b of [ui.fast, ui.addBots, ui.god]) gate(b, ready, noSeat);
  gate(ui.start, !!(host && !T.busy && phase === 'lobby'), !ready ? noSeat : 'Only in the lobby (End game in the host seat goes back to it)');
  gate(ui.autoReveal, ready && phase === 'reveal', !ready ? noSeat : 'Only during a reveal phase');
  gate(ui.skipToVote, ready && ['reveal', 'discussion', 'defense'].includes(phase), !ready ? noSeat : phase === 'vote' ? 'A ballot is already open' : 'Only during a game');
  // giveSpecial: a player, an effect
  fillSelect(ui.givePlayer, players.map((p) => [p.id, playerLabel(vs, p)]), ui.givePlayer.value || T.target);
  T.target = ui.givePlayer.value;
  gate(ui.give, ready && players.length > 0 && ['reveal', 'discussion', 'vote', 'defense'].includes(phase), !ready ? noSeat : 'Only during a game (start it first)');
  // forceTie: the open main ballot's candidates (otherwise the alive players; the server says what is allowed)
  const cands = vs && vs.phase === 'vote' && vs.vote && vs.vote.stage === 'main' ? vs.vote.candidates : players.filter((p) => p.status === 'alive').map((p) => p.id);
  for (const id of [...T.tie]) if (!cands.includes(id)) T.tie.delete(id);
  const tieSig = cands.join(',') + '|' + (vs ? vs.players.map((p) => p.name).join(',') : '');
  if (ui.tieList.dataset.sig !== tieSig) {
    ui.tieList.dataset.sig = tieSig;
    setKids(ui.tieList, cands.map((id) => {
      const p = players.find((x) => x.id === id);
      const box = el('input', { type: 'checkbox', value: id, testid: 'dev-tie-option', 'data-player-id': id });
      box.checked = T.tie.has(id);
      box.addEventListener('change', () => { if (box.checked) T.tie.add(id); else T.tie.delete(id); schedule(); });
      return el('label', { class: 'tie-opt' }, box, el('span', { text: p ? p.name : id }));
    }));
    if (!cands.length) ui.tieList.appendChild(el('span', { class: 'dim', text: 'no candidates yet' }));
  }
  const inMain = !!(vs && vs.phase === 'vote' && vs.vote && vs.vote.stage === 'main');
  gate(ui.forceTie, ready && inMain && T.tie.size >= 2, !ready ? noSeat : !inMain ? 'Only while a main ballot is open (Skip to vote first)' : 'Tick 2 or more candidates');
  ui.tieHint.textContent = inMain ? `${T.tie.size} picked: the ballot closes as a tie between them` : 'Needs an open main ballot (Skip to vote first)';
  // god view
  const gs = godSeat();
  ui.god.textContent = gs ? 'God view: on · turn off' : 'God view: off · turn on';
  ui.god.setAttribute('aria-pressed', String(!!gs));
  ui.god.dataset.on = String(!!gs);
  renderGod(gs);
  // seats
  for (const s of seatsInOrder()) renderSeatHead(s);
  renderTabs();
  renderLog();
  // test snapshot
  window.__devTable = snapshot();
}
function renderSeatHead(s) {
  const st = inRoom(s) ? s.state : null;
  const me = st ? st.players.find((p) => p.id === st.you.id) : null;
  const status = !s.url ? 'empty' : s.blocked ? 'blocked' : s.noBridge ? 'no-bridge' : !s.ready ? 'loading'
    : !s.status ? 'loading' : s.status.screen !== 'room' ? s.status.screen : st ? (me ? me.status : st.you.role) : 'joining';
  s.cell.dataset.status = status;
  s.cell.dataset.playerId = st ? st.you.id : '';
  const badges = [];
  if (st && st.you.isHost) badges.push(el('span', { class: 'bdg host', text: 'host' }));
  if (st && st.turn && st.turn.speakerId === st.you.id) badges.push(el('span', { class: 'bdg turn', text: st.turn.kind === 'defense' ? 'defends' : 'speaks' }));
  if (st && st.vote && st.vote.voters.includes(st.you.id) && !st.vote.voted.includes(st.you.id)) badges.push(el('span', { class: 'bdg vote', text: 'votes' }));
  if (st && (st.airlocks || []).some((a) => a.targetId === st.you.id)) badges.push(el('span', { class: 'bdg air', text: 'airlock' }));
  if (s.status && s.status.screen === 'room' && !s.status.online) badges.push(el('span', { class: 'bdg off', text: 'offline' }));
  const open = s.url ? (T.room ? seatUrl(s.k) : baseUrl(s.k)) : null;
  const sig = JSON.stringify([status, st && st.you.name, badges.map((b) => b.textContent), open, T.focus === s.k, T.layout]);
  if (s.head.dataset.sig === sig) return;
  s.head.dataset.sig = sig;
  // the seat's name, status and badges give way (clipped) before its buttons do: those must stay reachable at any scale
  setKids(s.head,
    el('span', { class: 'sh-main', title: `P${s.k} (profile ${s.profile}): ${status}${badges.length ? ' · ' + badges.map((b) => b.textContent).join(' · ') : ''}` },
      el('span', { class: 'sh-k mono', text: `P${s.k}` }),
      el('span', { class: ['sh-name', `st-${status}`], text: st && st.you.name !== `P${s.k}` ? `${st.you.name} · ${status}` : status }),
      badges),
    T.layout === 'grid' ? el('button', { class: 'sh-btn', testid: 'dev-seat-focus', 'data-seat': s.k, title: T.focus === s.k ? 'Back to the grid' : 'Focus: enlarge this seat', 'aria-pressed': String(T.focus === s.k), on: { click: () => { T.focus = T.focus === s.k ? 0 : s.k; saveSettings(); layout(); schedule(); } } }, T.focus === s.k ? '⤡' : '⤢') : null,
    open ? el('a', { class: 'sh-btn', testid: 'dev-seat-open', 'data-seat': s.k, href: open, target: '_blank', rel: 'noopener', title: 'Open this seat in a new tab (it takes the seat over; this frame then says so)' }, '↗') : null,
    s.url ? el('button', { class: 'sh-btn', testid: 'dev-seat-reload', 'data-seat': s.k, title: 'Reload this seat (it resumes its seat)', on: { click: () => reloadSeat(s) } }, '⟳') : null);
}
function reloadSeat(s) {
  try { s.frame.contentWindow.location.reload(); } catch { setSeatUrl(s, s.url); }
  s.ready = false; s.status = null; s.state = null;
  schedule();
}
function renderTabs() {
  const tabs = T.layout === 'tabs';
  ui.tabs.hidden = !tabs;
  if (!tabs) return;
  const list = seatsInOrder();
  const sig = JSON.stringify([T.tab, list.map((s) => [s.k, s.cell.dataset.status || ''])]);
  if (ui.tabs.dataset.sig === sig) return;
  ui.tabs.dataset.sig = sig;
  setKids(ui.tabs, list.map((s) => el('button', {
    class: ['tab', s.k === T.tab && 'on', `st-${s.cell.dataset.status || ''}`], testid: 'dev-tab', 'data-seat': s.k, 'aria-pressed': String(s.k === T.tab),
    on: { click: () => { T.tab = s.k; saveSettings(); layout(); schedule(); } },
  }, `P${s.k}`)));
}
function renderLog() {
  const sig = T.log.length ? `${T.log.length}|${T.log[T.log.length - 1].ts}|${T.log[T.log.length - 1].text}` : '';
  if (ui.log.dataset.sig === sig) return;
  ui.log.dataset.sig = sig;
  const stick = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 30;
  setKids(ui.log, T.log.map((l) => el('li', { class: ['ll', l.kind] }, el('time', { text: l.ts }), el('b', { text: l.who }), el('span', { text: l.text }))));
  if (stick) ui.log.scrollTop = ui.log.scrollHeight;
}
// X9.4 god view: every player's cards and specials, as the god socket's StateView carries them, as one players ×
// categories table docked under the seats (a side panel would take its width from the seats, which on a desktop are
// narrow long before they are short). A card still hidden from the table (null in the public players[].cards) is
// yellow; everything else is already face up. Long texts are clamped to two lines (the whole text is the cell's
// title). The table folds to its header line (▾) and the god view stays on.
function renderGod(gs) {
  const on = !!gs;
  ui.root.classList.toggle('god-on', on);
  ui.godPanel.hidden = !on;
  ui.godPanel.classList.toggle('folded', T.godFold);
  ui.godFold.textContent = T.godFold ? '▴ show' : '▾ hide';
  ui.godFold.title = T.godFold ? 'Show the god table' : 'Fold the god table away (the god view stays on): the seats get the room';
  ui.godFold.setAttribute('aria-expanded', String(!T.godFold));
  if (!on) { if (ui.godPanel.dataset.sig) { ui.godPanel.dataset.sig = ''; setKids(ui.godBody); setKids(ui.godSum); } return; }
  const s = gs.state;
  const g = s.god && s.god.players && typeof s.god.players === 'object' ? s.god.players : {};
  const sig = JSON.stringify([g, s.players.map((p) => [p.id, p.status, p.cards])]);
  if (ui.godPanel.dataset.sig === sig) return;
  ui.godPanel.dataset.sig = sig;
  // the columns in the seat's order, named in English like the rest of this table: the god view's texts are English
  // (server godView), while the seat's own categories[].label follow its language (a seat switched to Russian)
  const cats = (Array.isArray(s.categories) && s.categories.length ? s.categories : CATS_FALLBACK)
    .map((c) => ({ id: c.id, label: (CATS_FALLBACK.find((f) => f.id === c.id) || c).label }));
  let hidden = 0;
  const rows = s.players.map((p) => {
    const gp = g[p.id] || {};
    const cards = gp.cards && typeof gp.cards === 'object' ? gp.cards : {};
    const specials = Array.isArray(gp.specials) ? gp.specials : [];
    return el('tr', { class: `st-${p.status}`, testid: 'dev-god-player', 'data-player-id': p.id, 'data-status': p.status },
      el('th', { scope: 'row', class: 'gm-name' }, el('b', { text: p.name }), el('span', { class: 'dim', text: ` #${p.seat + 1}${p.status !== 'alive' ? ` · ${p.status}` : ''}` })),
      cats.map((c) => {
        const isHidden = p.cards[c.id] === null || p.cards[c.id] === undefined;
        if (isHidden && cards[c.id]) hidden++;
        const text = cards[c.id] == null ? '—' : String(cards[c.id]);
        return el('td', { class: isHidden ? 'hidden' : 'shown', testid: 'dev-god-card', 'data-category': c.id, 'data-hidden': String(isHidden), title: `${c.label}${isHidden ? ' (hidden from the table)' : ' (face up)'}: ${text}` },
          el('span', { class: 'cl', text }));
      }),
      el('td', { class: 'gm-sp' }, specials.length ? specials.map((x) => el('span', { class: ['sp', x.used && 'used'], title: `${x.title || '?'} (${x.effect || ''}${x.used ? ', used' : ''}): ${x.text || ''}` },
        el('b', { text: String(x.title || '?') }), el('span', { class: 'dim', text: ` ${x.effect || ''}${x.used ? ' · used' : ''}` }))) : el('span', { class: 'dim', text: '—' })));
  });
  setKids(ui.godSum, el('span', { testid: 'dev-god-summary', 'data-hidden-cards': hidden, text: `${hidden} card${hidden === 1 ? '' : 's'} still hidden from the table (yellow) · from P${gs.k}'s socket` }));
  setKids(ui.godBody, el('table', { class: 'god-mx' },
    el('colgroup', null, el('col', { class: 'c-name' }), cats.map(() => el('col', { class: 'c-card' })), el('col', { class: 'c-sp' })),
    el('thead', null, el('tr', null, el('th', { text: 'Player' }), cats.map((c) => el('th', { text: c.label })), el('th', { text: 'Specials' }))),
    el('tbody', null, rows)));
}
function snapshot() {
  return {
    room: T.room, busy: T.busy, layout: T.layout, focus: T.focus, tab: T.tab,
    seats: seatsInOrder().map((s) => ({
      k: s.k, profile: s.profile, url: s.url, ready: s.ready, blocked: s.blocked, noBridge: s.noBridge,
      screen: s.status ? s.status.screen : '', id: s.state ? s.state.you.id : '', name: s.state ? s.state.you.name : '',
      isHost: !!(s.state && s.state.you.isHost), phase: s.state ? s.state.phase : '', errors: s.errors, god: !!(s.state && s.state.god),
    })),
    hostSeat: hostSeat() ? hostSeat().k : 0,
    log: T.log.map((l) => `${l.who} ${l.text}`),
  };
}

/* ------------------------------------------------------------------ the page */
const ui = {};
function section(title, ...kids) { return el('section', { class: 'ctl-sec' }, el('h2', { text: title }), kids); }
function field(label, input, hint) { return el('label', { class: 'fld' }, el('span', { class: 'fld-k', text: label }), input, hint ? el('span', { class: 'fld-h', text: hint }) : null); }
function build() {
  ui.root = document.getElementById('dev');
  ui.n = el('input', { type: 'number', min: MIN_SEATS, max: MAX_SEATS, step: 1, value: T.n, testid: 'dev-humans', class: 'in num' });
  ui.seed = el('input', { type: 'text', maxlength: 64, value: T.seed, placeholder: 'optional, e.g. 42', testid: 'dev-seed', class: 'in', spellcheck: 'false' });
  ui.newGame = el('button', { class: 'b primary', testid: 'dev-new-game', on: { click: newGame } }, 'New test game');
  const layoutBtn = (id, label) => el('button', { class: ['seg', T.layout === id && 'on'], testid: `dev-layout-${id}`, 'aria-pressed': String(T.layout === id), on: { click: () => { T.layout = id; for (const b of ui.layoutBtns) { b.classList.toggle('on', b.dataset.id === id); b.setAttribute('aria-pressed', String(b.dataset.id === id)); } saveSettings(); layout(); schedule(); } }, 'data-id': id }, label);
  ui.layoutBtns = [layoutBtn('grid', 'Grid'), layoutBtn('tabs', 'Tabs')];
  ui.size = el('select', { class: 'in', testid: 'dev-size', on: { change: () => { T.size = ui.size.value; saveSettings(); layout(); } } },
    Object.entries(SIZES).map(([id, s]) => el('option', { value: id, text: s.label })));
  ui.size.value = T.size;
  // every op button carries its hint in data-hint: update() shows it as the title, or why the button is off right now
  ui.start = el('button', { class: 'b primary', testid: 'dev-start', 'data-hint': 'The host seat presses Start', on: { click: () => { const s = hostSeat(); if (s) { post(s, { cmd: 'start' }); logLine(s, '→ start', 'op'); } } } }, 'Start');
  ui.fast = el('button', { class: 'b', testid: 'dev-fast-timers', 'data-hint': 'Every timer 5 s, in any phase', on: { click: () => sendDev('fastTimers') } }, 'Fast timers');
  ui.bots = el('input', { type: 'number', min: 1, max: 15, step: 1, value: T.bots, testid: 'dev-bots-count', class: 'in num', on: { change: () => { T.bots = clampInt(ui.bots.value, 1, 15, 2); ui.bots.value = String(T.bots); saveSettings(); } } });
  ui.addBots = el('button', { class: 'b', testid: 'dev-add-bots', 'data-hint': 'Bots run in the server: in the lobby they take seats, in a game they watch', on: { click: () => { T.bots = clampInt(ui.bots.value, 1, 15, 2); ui.bots.value = String(T.bots); saveSettings(); sendDev('addBots', { count: T.bots }); } } }, 'Add bots');
  ui.givePlayer = el('select', { class: 'in', testid: 'dev-give-player', on: { change: () => { T.target = ui.givePlayer.value; } } });
  ui.giveEffect = el('select', { class: 'in', testid: 'dev-give-effect', on: { change: () => { T.effect = ui.giveEffect.value; } } }, EFFECTS.map(([v, l]) => el('option', { value: v, text: l })));
  ui.giveEffect.value = T.effect;
  ui.give = el('button', { class: 'b', testid: 'dev-give-special', 'data-hint': 'That player gets a card of that effect in place of an unused special', on: { click: () => sendDev('giveSpecial', { playerId: ui.givePlayer.value, effect: ui.giveEffect.value }) } }, 'Give special');
  ui.autoReveal = el('button', { class: 'b', testid: 'dev-auto-reveal', 'data-hint': 'Finish the reveal phase: every remaining speaker reveals and ends their turn', on: { click: () => sendDev('autoReveal') } }, 'Auto-reveal');
  ui.skipToVote = el('button', { class: 'b', testid: 'dev-skip-to-vote', 'data-hint': 'Fast-forward to the next vote step', on: { click: () => sendDev('skipToVote') } }, 'Skip to vote');
  ui.tieList = el('div', { class: 'tie-list' });
  ui.tieHint = el('span', { class: 'fld-h' });
  ui.forceTie = el('button', { class: 'b', testid: 'dev-force-tie', 'data-hint': 'The open ballot closes as a tie between the ticked players (then their defense)', on: { click: () => sendDev('forceTie', { ids: [...T.tie] }) } }, 'Force tie');
  ui.god = el('button', { class: 'b god', testid: 'dev-god-toggle', 'data-hint': 'Every card and special, hidden ones included, under the seats (on one seat\'s socket only)', on: { click: () => sendDev('god', { on: !godSeat() }) } }, 'God view');
  ui.log = el('ol', { class: 'log', testid: 'dev-log' });
  ui.status = el('div', { class: 'st' });
  ui.tabs = el('div', { class: 'tabs', hidden: true });
  ui.sizer = el('div', { class: 'sizer', 'aria-hidden': 'true' });
  ui.seats = el('div', { class: 'seats' }, ui.sizer);
  // the god view docks under the seats (see renderGod)
  ui.godSum = el('span', { class: 'god-sum dim' });
  ui.godFold = el('button', { class: 'god-fold', testid: 'dev-god-fold', on: { click: () => { T.godFold = !T.godFold; saveSettings(); schedule(); } } });
  ui.godBody = el('div', { class: 'god-body' });
  ui.godPanel = el('section', { class: 'god-panel', testid: 'dev-god-panel', hidden: true },
    el('div', { class: 'god-head' }, el('h2', { text: 'God view' }), ui.godSum, el('span', { class: 'grow' }), ui.godFold), ui.godBody);
  ui.stage = el('main', { class: 'stage' }, ui.tabs, ui.seats, ui.godPanel);
  // the controls scroll; the log stays pinned under them, so an op's error (✖, red) is always in sight
  const controls = el('aside', { class: 'ctl' },
    el('div', { class: 'ctl-main' },
      section('Table',
        el('div', { class: 'row' }, field('Humans', ui.n), field('Seed', ui.seed)),
        ui.newGame,
        el('div', { class: 'row' }, field('Layout', el('div', { class: 'segs' }, ui.layoutBtns)), field('Frames', ui.size))),
      section('Game',
        el('div', { class: 'row' }, ui.start, ui.fast),
        el('div', { class: 'row end' }, field('Bots', ui.bots), ui.addBots)),
      section('Shortcuts',
        el('div', { class: 'row' }, field('Player', ui.givePlayer), field('Effect', ui.giveEffect)), ui.give,
        el('div', { class: 'row' }, ui.autoReveal, ui.skipToVote),
        field('Force a tie between', ui.tieList), ui.tieHint, ui.forceTie,
        ui.god)),
    el('section', { class: 'ctl-sec ctl-log' }, el('h2', { text: 'Log', title: 'Your commands (→), the seats\' errors (✖) and the table\'s own steps. The game log in each seat shows the server\'s “[dev] …” lines' }), ui.log));
  ui.ctlToggle = el('button', { class: 'b ghost ctl-toggle', testid: 'dev-ctl-toggle', on: { click: () => { T.ctlHidden = !T.ctlHidden; saveSettings(); renderCtlToggle(); } } });
  const top = el('header', { class: 'top' }, ui.ctlToggle, el('h1', null, el('span', { class: 'hz', text: 'BUNKER' }), ' dev table'), ui.status,
    el('span', { class: 'warn', text: 'DEV MODE · never expose publicly' }));
  setKids(ui.root, top, controls, ui.stage);
  renderCtlToggle();
  new ResizeObserver(() => layout()).observe(ui.seats);
}

// the controls column folds away (the seats then get its width) and comes back from the top bar
function renderCtlToggle() {
  ui.root.classList.toggle('ctl-hidden', T.ctlHidden);
  ui.ctlToggle.textContent = T.ctlHidden ? '» Controls' : '« Hide';
  ui.ctlToggle.title = T.ctlHidden ? 'Show the controls and the log' : 'Hide the controls: the seats get their width (bigger, easier to read)';
  ui.ctlToggle.setAttribute('aria-expanded', String(!T.ctlHidden));
}

function boot() {
  loadSettings();
  build();
  // seats: the running test game's (they resume their seats), or seat 1 alone, ready to create one
  const n = T.room ? T.n : 1;
  for (let k = 1; k <= Math.max(1, n); k++) makeSeat(k);
  for (let k = 2; k <= T.n && !T.room; k++) makeSeat(k);
  for (const s of seatsInOrder()) setSeatUrl(s, T.room ? seatUrl(s.k) : s.k === 1 ? baseUrl(1) : '');
  if (T.room) logLine(null, `back to room ${T.room}: the seats resume`);
  layout();
  schedule();
}
boot();
