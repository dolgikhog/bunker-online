/* Bunker Online — reading the server's log lines (no DOM: app.js imports it, and test/client-loglines.test.js runs it
 * against real engine logs).
 *
 * Two paths (SPEC §11 X5.3; reports/i18n-design.md §8):
 *   - the key path: an entry with `key` (a server/i18n message key) and `params` (its language-neutral wire params:
 *     player ids, category ids, the round prefix {r, ot}, nested messages {key, params}). Everything below reads the
 *     key and the params, never the text, which is in the viewer's language and may be Russian. `parts` (typed segments
 *     whose texts join to `text`) carry the chips; flashParts() and partsText() read them.
 *   - the legacy path: an entry without `key` (a mock fixture, a server from before X5, the deploy window) is read from
 *     its English text as before, by the exact shapes below. The text functions stay exported for it.
 *
 * The legacy text path:
 * Player names are free text (SPEC §6/N1: letters, digits, punctuation and symbols, so quotes, “…”, «…» and even 🚪 are
 * allowed), and they sit inside the lines. So a line is never classified by a character or a quoted word that a name
 * could carry, only by the exact shapes the server writes, with the names in them matched as whole names:
 *   - the three airlock lines of SPEC §11 X1/Y1 (the only lines that start with "🚪 ");
 *   - a special's own line (SPEC §5): "Round N — {player} played “{title}”: {card text} → {result}";
 *   - a leave or kick: "{player} left the game", "{player} was removed by the host" (SPEC §11 L2).
 * (SPEC §11 FX1.) */

// SPEC §11 X1. Every other `eject` line ends "… is ejected and stays in the forest", and every other `special` line
// starts "Round N — " or "Overtime — ", so no name can give another line one of these shapes. The fixed phrases are
// longer than any name (20 characters), so the lazy groups cannot stop inside a name.
// The start line names the deadline. It read "before the vote" until SPEC §11 (f2) changed it to "before this round's
// discussion ends" (an airlock jams then, even in a round without a vote); both exact wordings are read.
const AIR_SEAL = /^🚪 ([\s\S]+?) sealed the airlock with ([\s\S]+) — ([\s\S]+) is thrown out of the bunker, no vote!$/u;
const AIR_START = /^🚪 ([\s\S]+?) started cycling the airlock on ([\s\S]+)\. If one more Airlock card is played on \2 (?:before the vote|before this round['’]s discussion ends|before the overtime discussion ends), \2 is out — no vote\.$/u;
const AIR_JAM = /^🚪 The airlock on ([\s\S]+) jammed — nobody closed it\.$/u;
const DOOR = '🚪 ';

/**
 * Which airlock line this is: `{kind: 'seal'|'start'|'jam', at}` (`at` = where the word "airlock" that names the card
 * starts), or null. `logKind` (the entry's `kind`), when given, must be the one the server uses for that line:
 * `eject` for a seal, `special` for the other two.
 */
export function airlockLine(text, logKind) {
  if (typeof text !== 'string' || !text.startsWith(DOOR)) return null;
  let m = AIR_SEAL.exec(text);
  if (m) return logKind && logKind !== 'eject' ? null : { kind: 'seal', at: DOOR.length + m[1].length + ' sealed the '.length, by: m[1], target: m[3] };
  if (logKind && logKind !== 'special') return null;
  m = AIR_START.exec(text);
  if (m) return { kind: 'start', at: DOOR.length + m[1].length + ' started cycling the '.length, by: m[1], target: m[2] };
  m = AIR_JAM.exec(text);
  if (m) return { kind: 'jam', at: DOOR.length + 'The '.length, target: m[1] };
  return null;
}
/** The legacy text reader under the name the design gives it (reports/i18n-design.md §8.4). */
export { airlockLine as airlockLineText };

/* ------------------------------------------------------------------ the key path (SPEC §11 X5.3) */

/** Whether an entry carries a message key (and so is read by it, never by its text). */
export function keyed(e) {
  return !!e && typeof e.key === 'string' && e.key !== '' && !!e.params && typeof e.params === 'object';
}
/** The three airlock lines by key (SPEC §11 X1): params a (who started it), by (who sealed it), t (the target). */
export const AIR_KEYS = Object.freeze({ 'log.airlockSeal': 'seal', 'log.airlockStart': 'start', 'log.airlockJam': 'jam' });
/** A player who left a game, or was kicked from it (SPEC §11 L2): param p. */
export const LEAVE_KEYS = Object.freeze(['log.leftGame', 'log.kicked']);
const CANCEL_RESULTS = ['res.cancelNow', 'res.cancelRest'];

/** The name a player part of the line gives for `id` (the name when the line was logged), or ''. */
export function partName(e, id) {
  for (const x of (e && Array.isArray(e.parts) ? e.parts : [])) if (x && typeof x === 'object' && x.t === 'player' && x.id === id) return String(x.v);
  return '';
}

/**
 * Which airlock line an entry is: `{kind: 'seal'|'start'|'jam', ...}` or null. By key: `{kind, a, t, by}` (ids; by is
 * a list), plus the names `byName` and `target` read from the line's own player parts. Without a key: the text reader
 * above (`{kind, at, by, target}` with names), checked against the entry's kind.
 */
export function airlockOf(e) {
  if (!e) return null;
  if (keyed(e)) {
    const kind = AIR_KEYS[e.key];
    if (!kind) return null;
    const p = e.params;
    return { kind, a: p.a ?? null, t: p.t ?? null, by: Array.isArray(p.by) ? p.by : [], byName: partName(e, p.a), target: partName(e, p.t) };
  }
  return airlockLine(e.text, e.kind);
}

/** "{player} left the game" / "{player} was removed by the host": by key (param p), else the legacy text shapes. */
export function leaveOf(e, names) {
  if (!e) return null;
  if (keyed(e)) return LEAVE_KEYS.includes(e.key) ? { id: e.params.p ?? null, kicked: e.key === 'log.kicked' } : null;
  return isLeaveLine(e, names) ? { id: null, kicked: typeof e.text === 'string' && e.text.endsWith(' was removed by the host') } : null;
}

/** SPEC §11 X6: the host's End game line (`log.endGame`; the text 'The host ended the game' without a key). */
export function isEndGameLine(e) {
  if (!e || e.kind !== 'system') return false;
  return keyed(e) ? e.key === 'log.endGame' : e.text === 'The host ended the game';
}
/** A game's first line ("The game begins: …", `log.gameBegins`). */
export function isGameStartLine(e) {
  if (!e || e.kind !== 'system') return false;
  return keyed(e) ? e.key === 'log.gameBegins' : typeof e.text === 'string' && /^The game (begins|started)\b/.test(e.text);
}
/** Round 1's reveal line ("Round 1 of 7 — reveal phase …", `log.roundReveal` with r = 1): a game's briefing starts there. */
export function isRoundOneLine(e) {
  if (!e || e.kind !== 'system') return false;
  return keyed(e) ? e.key === 'log.roundReveal' && e.params.r === 1 : typeof e.text === 'string' && /^Round 1 of /.test(e.text);
}
/** A host change ("… is now the host", `log.host`): `{id, why}` (why: the nested reason's key, or null), else null. */
export function hostChangeOf(e) {
  if (!e || e.kind !== 'info') return null;
  if (keyed(e)) {
    if (e.key !== 'log.host') return null;
    const w = e.params.why;
    return { id: e.params.p ?? null, why: w && typeof w === 'object' && typeof w.key === 'string' ? w : null };
  }
  return typeof e.text === 'string' && / is now the host$/.test(e.text) ? { id: null, why: null } : null;
}

/** A round prefix param {r, ot} as the round it names (1..7, or 'OT'), or null. */
function roundOf(rp) {
  if (!rp || typeof rp !== 'object') return null;
  return rp.ot ? 'OT' : Number.isInteger(rp.r) ? rp.r : null;
}

/**
 * The card a speaker revealed on this turn (the bar names it): the last `log.reveal` of player `id` in round
 * `round`/`overtime`, looking back no further than the start of the phase (a system line). `{cat, entry, value}`
 * (value: the card's text as the line shows it), or null. Key path only; see app.js for the legacy text reader.
 */
export function revealOf(log, id, round, overtime) {
  const want = overtime ? 'OT' : round;
  for (let i = (log || []).length - 1; i >= 0; i--) {
    const e = log[i];
    if (!e || e.kind === 'system') break;
    if (!keyed(e) || e.key !== 'log.reveal' || e.params.p !== id || roundOf(e.params.rp) !== want) continue;
    const v = (Array.isArray(e.parts) ? e.parts : []).find((x) => x && typeof x === 'object' && x.t === 'value');
    return { cat: e.params.cat, entry: e, value: v ? String(v.v) : '' };
  }
  return null;
}

/** A part's text: a plain string, or a typed segment's `v`. */
export function partText(x) { return typeof x === 'string' ? x : x && typeof x === 'object' ? String(x.v ?? '') : ''; }
/** The text of a list of parts (design §8.1: the parts of an entry join to exactly its text). */
export function partsText(parts) { return (Array.isArray(parts) ? parts : []).map(partText).join(''); }
/**
 * A line as a flash (and the final banner) tells it (design §8.2): without the round prefix and without the special's
 * own rules text (both stay in the log). The parts that are left, or null for an entry without parts.
 */
export function flashParts(e) {
  if (!e || !Array.isArray(e.parts) || !keyed(e)) return null;
  return e.parts.filter((x) => !(x && typeof x === 'object' && (x.t === 'prefix' || x.t === 'cardtext')));
}

const ROUND_HEAD = /^(?:(?:Round \d+|Overtime) — )?/;
const PLAYED = ' played “';

/**
 * A special's own line, "Round N — {player} played “{title}”: {card text} → {result}" (also without the round prefix,
 * as a flash shows it), split up:
 *   `{head, name, title, cardText, result, anchored}`, where `head` is everything before the title ("Round 2 — Anna
 *   played "), or null when the line is not one.
 * `names` are the seated players' names: the line is read from the one it starts with (the longest that fits, so a
 * name that itself reads "X played “T”: …" cannot move the title). `known(title)` gives a title's rules text as the
 * state has it (played specials, the final's unplayed ones, the own hand), or ''. A line whose player is not in the
 * state (one from before Play again) is read only when it quotes a known title followed by exactly its known text,
 * and is never `anchored`: only an anchored line may teach a title's text.
 */
export function parseSpecialLine(text, names, known = () => '') {
  if (typeof text !== 'string') return null;
  const head = ROUND_HEAD.exec(text)[0];
  const rest = text.slice(head.length);
  const list = [...new Set((names || []).filter((n) => typeof n === 'string' && n))].sort((a, b) => b.length - a.length);
  // (a flash has no round prefix, so a name that itself starts "Round 2 — " is tried on the whole text too)
  for (const [pre, body] of head ? [[head, rest], ['', text]] : [['', text]]) {
    for (const name of list) {
      if (!body.startsWith(name + PLAYED)) continue;
      const t = splitTail(body.slice(name.length + PLAYED.length), known, false);
      if (t) return { head: pre + name + ' played ', name, ...t, anchored: true };
    }
  }
  for (let i = rest.indexOf(PLAYED); i > 0; i = rest.indexOf(PLAYED, i + 1)) {
    const t = splitTail(rest.slice(i + PLAYED.length), known, true);
    if (t) return { head: head + rest.slice(0, i) + ' played ', name: rest.slice(0, i), ...t, anchored: false };
  }
  return null;
}
// `{title}”: {card text} → {result}` (or `{title}” → {result}`, a card without text, or a flash). `strict`: only a
// known title followed by its known text.
function splitTail(s, known, strict) {
  const q = s.indexOf('”');
  if (q <= 0) return null;
  const title = s.slice(0, q);
  const after = s.slice(q + 1);
  const text = (typeof known === 'function' && known(title)) || '';
  if (text && after.startsWith(`: ${text} → `)) return { title, cardText: text, result: after.slice(text.length + 5) };
  if (strict) return null;
  const m = /^(?::\s([\s\S]*?))?\s→\s([\s\S]*)$/.exec(after);
  return m ? { title, cardText: m[1] || '', result: m[2] } : null;
}

/**
 * A special's own line as the log shows it with a card chip (SPEC §11 X3/FX1, f2): only when its title is one the state
 * knows (`known(title)`, from played specials, the final's unplayed ones and the own hand) and exactly that card's text
 * follows it. It is read from the seated name it starts with (the longest), and otherwise from the first
 * "… played “T”: {T's text} → " in it: a line whose player has left the seat list since (before Play again) must not
 * be read from a shorter seated name that happens to prefix it. A name is at most 20 characters and every card text is
 * longer, so no name can supply a known title together with its text. Nothing is ever learned from a line.
 */
export function cardLine(text, names, known) {
  if (typeof known !== 'function') return null;
  for (const list of [names || [], []]) {
    const m = parseSpecialLine(text, list, known);
    if (m && m.cardText && known(m.title) === m.cardText) return m;
  }
  return null;
}

/**
 * What each played round's vote step did, from the log (the round track shows this for played rounds, SPEC §11 f2):
 * a Map from the round (1..7, or 'OT' for overtime) to `{out, cancelled, due}`: how many players the vote ejected, whether
 * a special cancelled it (before it began, or the rest of it), and how many ejections were due at its start. Only the
 * current game counts (a "The game begins" line starts afresh), and a round whose opening line was cut off the log (it
 * keeps the last 200 lines) is absent: the caller falls back to the plan for it. Only the server's exact shapes count:
 * the vote lines carry the round prefix, an ejection line never reads as a seal (a name cannot make one, FX1).
 */
export function voteHistory(log) {
  const h = new Map();
  let cur = null;
  const at = (r) => { if (!h.has(r)) h.set(r, { out: 0, cancelled: false, due: 0 }); return h.get(r); };
  for (const e of log || []) {
    // the key path: the same events, read from keys and params (the round from the line's round prefix)
    if (keyed(e)) {
      const k = e.key;
      const p = e.params;
      if (k === 'log.gameBegins') { h.clear(); cur = null; continue; }
      if (k === 'log.roundReveal' && Number.isInteger(p.r)) { cur = p.r; at(cur); continue; }
      if (k === 'log.overtime') { cur = 'OT'; at(cur); continue; }
      if (cur === null) continue;
      if (k === 'log.eject') { at(cur).out += 1; continue; }
      if (roundOf(p.rp) !== cur) continue;
      if ((k === 'log.discussion' && p.mode === 'vote') || k === 'log.voteStep') at(cur).due = Number(p.k) || 0;
      else if (k === 'log.voteSkipped' || k === 'log.allImmune') at(cur).cancelled = true;
      else if (k === 'log.special' && p.result && CANCEL_RESULTS.includes(p.result.key)) at(cur).cancelled = true;
      continue;
    }
    if (!e || typeof e.text !== 'string') continue;
    const t = e.text;
    let m;
    if (e.kind === 'system') {
      if (t.startsWith('The game begins: ')) { h.clear(); cur = null; continue; }
      if ((m = /^Round (\d+) of \d+ — reveal phase/.exec(t))) { cur = Number(m[1]); at(cur); continue; }
      if (t.startsWith('Overtime — the bunker is still over capacity')) { cur = 'OT'; at(cur); continue; }
    }
    if (cur === null) continue;
    const rp = cur === 'OT' ? 'Overtime — ' : `Round ${cur} — `;
    if (e.kind === 'system' && (m = /^discussion — then a vote: (\d+) players? will stay outside$/.exec(t.startsWith(rp) ? t.slice(rp.length) : ''))) {
      at(cur).due = Number(m[1]);
    } else if (e.kind === 'vote' && t.startsWith(rp)) {
      const v = t.slice(rp.length);
      if ((m = /^vote: (\d+) players? will stay outside$/.exec(v))) at(cur).due = Number(m[1]);
      else if (v.startsWith('the vote is cancelled (a special card)') || v === 'everyone is immune: the rest of the vote is cancelled') at(cur).cancelled = true;
    } else if (e.kind === 'special' && t.startsWith(rp) && / → (?:the rest of the vote|the vote) is cancelled right now; the kicks (?:still due )?carry over$/.test(t)) {
      at(cur).cancelled = true;
    } else if (e.kind === 'eject' && !airlockLine(t, e.kind) && t.endsWith(' is ejected and stays in the forest')) {
      at(cur).out += 1;
    }
  }
  return h;
}

/**
 * "{player} left the game" or "{player} was removed by the host" (SPEC §11 L2): by key (`log.leftGame`,
 * `log.kicked`), or, without one, the exact text for one of `names`.
 */
export function isLeaveLine(e, names) {
  if (!e || e.kind !== 'info') return false;
  if (keyed(e)) return LEAVE_KEYS.includes(e.key);
  if (typeof e.text !== 'string') return false;
  return (names || []).some((n) => e.text === `${n} left the game` || e.text === `${n} was removed by the host`);
}

/**
 * What ended the game (the final banner): the move logged right before "The bunker door closes" (the last `system`
 * entry; the final only adds jammed airlocks after it). `{kind: 'vote'|'special'|'leave'|null, entry, airlock?}`:
 * a vote ejection, a special (a sealed airlock is one, with `airlock: true`), or a player who left or was kicked. An
 * airlock that only started or jammed never ended a game, nor does a host change.
 */
export function finalCause(s) {
  const log = (s && s.log) || [];
  const names = ((s && s.players) || []).map((p) => p.name);
  let i = log.length - 1;
  // (by key: the last `log.doorCloses`; without one, the last system line, as the door's line always is)
  while (i >= 0 && !(keyed(log[i]) ? log[i].key === 'log.doorCloses' : log[i].kind === 'system')) i--;
  for (let j = i - 1; j >= 0 && j >= i - 12; j--) {
    const e = log[j];
    const air = airlockOf(e);
    if (air && air.kind === 'seal') return { kind: 'special', entry: e, airlock: true };
    if (air) continue;
    if (e.kind === 'eject') {
      // (a plain "is ejected" line right after a seal would still be the seal's)
      const prev = j > 0 ? log[j - 1] : null;
      if (prev && (airlockOf(prev) || {}).kind === 'seal') return { kind: 'special', entry: prev, airlock: true };
      return { kind: 'vote', entry: e };
    }
    if (e.kind === 'special') return { kind: 'special', entry: e };
    if (isLeaveLine(e, names)) return { kind: 'leave', entry: e };
    if (e.kind === 'system' || e.kind === 'reveal') break;
  }
  return { kind: null, entry: null };
}
