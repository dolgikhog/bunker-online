// Client fixes of the f2 review that live in the pure log readers (public/loglines.js), run against real engine logs:
// the airlock start line's new deadline wording, card chips that never trust a name (FX1 after Play again), and the
// round track's history of played votes. SPEC §11 (client-fixer f2).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../server/game.js';
import { AIRLOCK_CARD } from '../server/content.js';
import { mulberry32 } from '../server/rng.js';
import { airlockLine, cardLine, parseSpecialLine, voteHistory } from '../public/loglines.js';

const FILLER = { id: 'filler', title: 'Blueprint', text: 'Adds a bunker feature to the shelter.', effect: 'bunker_add_feature', target: 'none' };
const DOOR = { id: 'door', title: 'Secret Door', text: 'You find a sealed door — the bunker gains a new feature.', effect: 'bunker_add_feature', target: 'none' };
const CANCEL = { id: 'cancel', title: 'Blackout', text: 'Cancel the current vote, or the next one if no vote is running.', effect: 'cancel_vote', target: 'none' };
function handDealer(specials = {}) {
  let cardN = 0;
  let specialN = 0;
  return {
    drawCard(c) { cardN++; return `<${c}#${cardN}>`; },
    drawSpecial() { const seat = Math.floor(specialN / 2); const slot = specialN % 2; specialN++; return { ...(specials[seat]?.[slot] ?? FILLER) }; },
    drawCatastrophe() { return { title: 'Test flood', text: 'Water everywhere.', details: [] }; },
    drawBunker() { return { name: 'Test bunker', size: '50 m2', duration: '1 year', food: '1 year', features: ['Well', 'Gym', 'Lab'] }; },
    drawBunkerFeature() { cardN++; return `<feature#${cardN}>`; },
  };
}
function started(names, specials = {}) {
  const clock = { t: 1_800_000_000_000 };
  const g = createGame({ room: 'TEST', rng: mulberry32(11), now: () => clock.t++, minPlayers: 2, dealer: handDealer(specials), fixedSpecials: false });
  const ids = names.map((x) => g.join(x).id);
  assert.deepEqual(g.handle(ids[0], { t: 'start' }), { ok: true });
  return { g, ids };
}
const ok = (r) => assert.deepEqual(r, { ok: true }, JSON.stringify(r));
/** A log as a server from before X5 sent it: no key, params or parts (the client reads the English text). */
const textOnly = (log) => log.map(({ key, params, parts, ...e }) => e);
const uid = (g, id, effect) => g.players.find((p) => p.id === id).specials.find((x) => x.effect === effect && !x.used).uid;
/** Every vote goes to the last candidate (the voter excepted); the host presses Next otherwise. `hook(g)` runs first
 * on every step and returns true when it acted. */
function playOut(g, hook = () => false) {
  for (let i = 0; i < 800 && g.phase !== 'final'; i++) {
    if (hook(g)) continue;
    if (g.phase === 'vote') {
      const t = g.vote.candidates[g.vote.candidates.length - 1];
      for (const v of [...g.vote.voters]) if (g.phase === 'vote' && v !== t) ok(g.handle(v, { t: 'vote', targetId: t }));
      if (g.phase === 'vote') ok(g.handle(g.hostId, { t: 'closeVote' }));
    } else ok(g.handle(g.hostId, { t: 'next' }));
  }
  assert.equal(g.phase, 'final');
}
/** What the state teaches the client (public/app.js learnFromState): played specials, the final's unplayed ones, the
 * own hand. Never a log line. */
function knownFrom(v) {
  const book = new Map();
  for (const p of v.players) for (const x of [...p.playedSpecials, ...(p.unplayedSpecials || [])]) book.set(x.title, x.text);
  if (v.me) for (const x of v.me.specials) book.set(x.title, x.text);
  return (t) => book.get(t) || '';
}

describe('client f2: the airlock start line names the real deadline (SPEC §11 X1 amended)', () => {
  test('the engine\'s start line in a round without a vote is read as a start line, target and opener whole', () => {
    const { g, ids } = started(['Ann', 'Bo', 'Cy', 'Di', 'Ed', 'Flo'], { 0: [AIRLOCK_CARD] });
    for (let i = 0; i < 400 && !(g.round === 2 && g.phase === 'reveal'); i++) ok(g.handle(g.hostId, { t: 'next' }));
    assert.equal(g.view(ids[0]).schedule.kicksThisStep, 0, 'round 2 of a 6-player game has no vote');
    ok(g.handle(ids[0], { t: 'special', uid: uid(g, ids[0], 'airlock'), targetId: ids[3] }));
    const line = g.view(ids[1]).log.find((e) => e.text.startsWith('🚪 Ann started'));
    assert.ok(line, 'a start line');
    assert.doesNotMatch(line.text, /before the vote/, 'an airlock in a round without a vote jams when that round\'s discussion ends');
    const a = airlockLine(line.text, line.kind);
    assert.deepEqual({ kind: a.kind, by: a.by, target: a.target }, { kind: 'start', by: 'Ann', target: 'Di' });
    assert.equal(line.text.slice(a.at, a.at + 7), 'airlock');
    // the wording before f2 is still read (and nothing else is)
    const old = '🚪 Ann started cycling the airlock on Di. If one more Airlock card is played on Di before the vote, Di is out — no vote.';
    assert.equal(airlockLine(old, 'special').kind, 'start');
    assert.equal(airlockLine(old.replace('before the vote', 'before the overtime discussion ends'), 'special').kind, 'start', 'the overtime form (SPEC §11 Z5)');
    assert.equal(airlockLine(old.replace('before the vote', 'before lunch'), 'special'), null);
    assert.equal(airlockLine(old.replace('played on Di before', 'played on Bo before'), 'special'), null, 'the target named twice must be the same');
  });
});

describe('client f2: a log line never makes a card chip that the state does not vouch for (SPEC §11 FX1)', () => {
  test('after Play again a departed author\'s crafted name cannot credit a made-up card to a seated player', () => {
    const forged = 'M played “Nuke”: ok';
    assert.ok([...forged].length <= 20);
    const { g, ids } = started(['M', forged, 'Zed'], { 1: [DOOR] });
    ok(g.handle(ids[1], { t: 'special', uid: uid(g, ids[1], 'bunker_add_feature') }));
    const line = g.view(ids[2]).log.find((e) => e.kind === 'special').text;
    assert.ok(line.startsWith(`Round 1 — ${forged} played “Secret Door”: `), line);
    // game 1, the author seated: read from the author's name, chip Secret Door with its own text
    const v1 = g.view(ids[2]);
    const m1 = cardLine(line, v1.players.map((p) => p.name), knownFrom(v1));
    assert.deepEqual([m1.name, m1.title, m1.cardText], [forged, 'Secret Door', DOOR.text]);
    // the author leaves, the game ends, Play again: the log carries over, the author is gone from the seats
    ok(g.handle(ids[1], { t: 'leave' }));
    playOut(g);
    ok(g.handle(g.hostId, { t: 'playAgain' }));
    const v2 = g.view(ids[2]);
    const seated = v2.players.map((p) => p.name);
    assert.deepEqual(seated, ['M', 'Zed']);
    assert.ok(v2.log.some((e) => e.text === line), 'the old line is still in the log');
    // the reading that anchors on the shorter seated name "M" is exactly the forgery …
    const naive = parseSpecialLine(line, seated, () => '');
    assert.deepEqual([naive.name, naive.title, naive.anchored], ['M', 'Nuke', true]);
    // … and it never becomes a chip: a spectator of game 2 knows no text for it (nothing is learned from the log)
    assert.equal(cardLine(line, seated, knownFrom(v2)), null);
    // a client that saw game 1 knows Secret Door: the chip is the real card, credited to the real (departed) author
    const k = (t) => (t === 'Secret Door' ? DOOR.text : knownFrom(v2)(t));
    const m2 = cardLine(line, seated, k);
    assert.deepEqual([m2.name, m2.title, m2.cardText], [forged, 'Secret Door', DOOR.text]);
    // even a known title in the name gets no chip without its exact text after it
    const k2 = (t) => (t === 'Nuke' ? 'The real Nuke text.' : '');
    assert.equal(cardLine(line, seated, k2), null);
  });

  test('no dealt card text fits in a name, so a name can never supply a known title and its text', async () => {
    const { createDealer } = await import('../server/content.js');
    const d = createDealer(mulberry32(3));
    const shortest = Math.min(...Array.from({ length: 300 }, () => d.drawSpecial().text.length), AIRLOCK_CARD.text.length);
    assert.ok(shortest > 20, `shortest special text ${shortest}`);
  });
});

describe('client f2: the round track reads what each played vote did (SPEC §11, f2)', () => {
  test('cancelled before it began, cut short after an ejection, cancelled again, then overtime', () => {
    const { g, ids } = started(['A', 'B', 'C', 'D', 'E', 'F'], { 0: [CANCEL, CANCEL], 1: [CANCEL] });
    const done = new Set();
    playOut(g, (x) => {
      const key = `${x.round}:${x.phase}:${x.step ? x.step.ballot : ''}`;
      if (done.has(key)) return false;
      if (x.round === 5 && x.phase === 'discussion') { done.add(key); ok(x.handle(ids[0], { t: 'special', uid: uid(x, ids[0], 'cancel_vote') })); return true; }
      // round 6: the first ballot ejects someone, then the rest of the vote is cancelled
      if (x.round === 6 && x.phase === 'vote' && x.step && x.step.ballot === 2) { done.add(key); ok(x.handle(ids[1], { t: 'special', uid: uid(x, ids[1], 'cancel_vote') })); return true; }
      if (x.round === 7 && x.phase === 'discussion' && !x.overtime) { done.add(key); ok(x.handle(ids[0], { t: 'special', uid: uid(x, ids[0], 'cancel_vote') })); return true; }
      return false;
    });
    const h = voteHistory(g.view(ids[5]).log);
    // (SPEC §11 X5.3: the keys, the English text without keys and a Russian view all read the same history)
    assert.deepEqual([...voteHistory(textOnly(g.view(ids[5]).log))], [...h]);
    assert.deepEqual([...voteHistory(g.view(ids[5], 'ru').log)], [...h]);
    assert.deepEqual([...h.keys()], [1, 2, 3, 4, 5, 6, 7, 'OT']);
    for (const r of [1, 2, 3, 4]) assert.deepEqual(h.get(r), { out: 0, cancelled: false, due: 0 }, `round ${r}`);
    assert.deepEqual(h.get(5), { out: 0, cancelled: true, due: 1 });
    assert.equal(h.get(6).out, 1);
    assert.equal(h.get(6).cancelled, true);
    assert.equal(h.get(7).cancelled, true);
    assert.equal(h.get(7).out, 0);
    assert.ok(h.get(7).due >= 1);
    assert.ok(h.get('OT').out >= 1);
    // the number ejected by votes is the number the log says went out by a vote
    const outByVote = g.view(ids[5]).log.filter((e) => e.kind === 'eject' && e.text.endsWith(' is ejected and stays in the forest')).length;
    assert.equal([...h.values()].reduce((n, x) => n + x.out, 0), outByVote);
  });

  test('a seal is not a vote ejection, a new game starts afresh, a cut-off round is absent, names change nothing', () => {
    const { g, ids } = started(['Ann', 'Bo', 'Cy', 'Di'], { 0: [AIRLOCK_CARD], 1: [AIRLOCK_CARD] });
    for (let i = 0; i < 400 && !(g.round === 2 && g.phase === 'reveal'); i++) ok(g.handle(g.hostId, { t: 'next' }));
    ok(g.handle(ids[0], { t: 'special', uid: uid(g, ids[0], 'airlock'), targetId: ids[3] }));
    ok(g.handle(ids[1], { t: 'special', uid: uid(g, ids[1], 'airlock'), targetId: ids[3] }));
    assert.equal(g.players.find((p) => p.id === ids[3]).status, 'ejected');
    const log = g.view(ids[2]).log;
    assert.deepEqual(voteHistory(log).get(2), { out: 0, cancelled: false, due: 0 });
    assert.deepEqual([...voteHistory(textOnly(log))], [...voteHistory(log)]);
    // a name that reads like a vote line or an ejection changes nothing (only the server's shapes with a round prefix;
    // the text path, a line without a key)
    const hostile = textOnly(log).map((e) => ({ ...e, text: e.text.split('Cy').join('is ejected and stays in the forest') }));
    assert.deepEqual([...voteHistory(hostile)], [...voteHistory(log)]);
    // the lines of round 1 cut off (the log keeps the last 200): round 1 is absent, the caller uses its plan
    const cut = log.slice(log.findIndex((e) => /^Round 2 of /.test(e.text)));
    assert.deepEqual([...voteHistory(cut).keys()], [2]);
    assert.deepEqual([...voteHistory(textOnly(cut)).keys()], [2]);
    // a new game after Play again starts the history afresh
    playOut(g);
    ok(g.handle(g.hostId, { t: 'playAgain' }));
    ok(g.handle(g.hostId, { t: 'start' }));
    assert.deepEqual([...voteHistory(g.view(ids[2]).log).keys()], [1]);
  });
});
