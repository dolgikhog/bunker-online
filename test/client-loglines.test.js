// The client's reading of log lines (public/loglines.js, SPEC §11 FX1) against real engine logs. Player names are free
// text, so each game is played with plain names and the view is then given hostile names exactly as the server would
// have written them (names are interpolated verbatim). That keeps these tests meaningful whatever sanitizeName() strips.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, EFFECTS } from '../server/game.js';
import { AIRLOCK_CARD } from '../server/content.js';
import { mulberry32 } from '../server/rng.js';
import { airlockLine, parseSpecialLine, finalCause, isLeaveLine } from '../public/loglines.js';

const FILLER = { id: 'filler', title: 'Blueprint', text: 'Adds a bunker feature.', effect: 'bunker_add_feature', target: 'none' };
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
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
function started(n, specials = {}) {
  const clock = { t: 1_800_000_000_000 };
  const g = createGame({ room: 'TEST', rng: mulberry32(5), now: () => clock.t++, minPlayers: 2, dealer: handDealer(specials), fixedSpecials: false });
  const ids = NAMES.slice(0, n).map((x) => g.join(x).id);
  assert.deepEqual(g.handle(ids[0], { t: 'start' }), { ok: true });
  return { g, ids };
}
const ok = (r) => assert.deepEqual(r, { ok: true }, JSON.stringify(r));
const uid = (g, id, effect) => g.players.find((p) => p.id === id).specials.find((x) => x.effect === effect && !x.used).uid;
/** The view `id` gets, with the players renamed (every occurrence in the log too, as the server writes names). */
function viewAs(g, id, rename) {
  const v = structuredClone(g.view(id));
  const sub = (t) => Object.entries(rename).reduce((acc, [a, b]) => acc.split(a).join(b), t);
  for (const p of v.players) p.name = sub(p.name);
  for (const e of v.log) e.text = sub(e.text);
  return v;
}
const names = (v) => v.players.map((p) => p.name);
/** Plays the game on: every vote goes to `pick(vote)`, the host presses Next otherwise. */
function playOut(g, pick) {
  for (let i = 0; i < 400 && g.phase !== 'final'; i++) {
    if (g.phase === 'vote') {
      const t = pick(g.vote);
      for (const v of [...g.vote.voters]) if (g.phase === 'vote' && v !== t) ok(g.handle(v, { t: 'vote', targetId: t }));
      if (g.phase === 'vote') ok(g.handle(g.hostId, { t: 'closeVote' }));
    } else ok(g.handle(g.hostId, { t: 'next' }));
  }
  assert.equal(g.phase, 'final');
}

describe('client log lines: names never make a line something else (SPEC §11 FX1)', () => {
  test('a 🚪 name voted out in the vote that ends the game: the cause is that vote, and no line is an airlock line', () => {
    const { g, ids } = started(4);
    const [, bravo, charlie] = ids;
    // Charlie goes in the first vote (round 6), then Bravo in the last one (round 7)
    playOut(g, (v) => (v.candidates.includes(charlie) ? charlie : bravo));
    for (const hostile of ['🚪Rex', '🚪 Rex', '🚪 The airlock on', 'sealed the airlock']) {
      const v = viewAs(g, ids[0], { Bravo: hostile });
      assert.equal(v.lastVoteResult.ejectedId, bravo);
      const c = finalCause(v);
      assert.equal(c.kind, 'vote', `${hostile}: ${JSON.stringify(c)}`);
      assert.ok(!c.airlock);
      assert.equal(c.entry.text, `${hostile} is ejected and stays in the forest`);
      assert.deepEqual(v.log.filter((e) => airlockLine(e.text, e.kind) || airlockLine(e.text)), [], hostile);
    }
  });

  test('a 🚪 name whose leave ends the game: the cause is that leave, not an earlier one', () => {
    const { g, ids } = started(3);
    for (let i = 0; i < 3; i++) ok(g.handle(g.hostId, { t: 'next' }));
    ok(g.handle(ids[1], { t: 'leave' }));   // Bravo first: 2 alive, 1 bed, the game goes on
    ok(g.handle(ids[2], { t: 'leave' }));   // then Charlie: this ends it
    assert.equal(g.phase, 'final');
    const v = viewAs(g, ids[0], { Charlie: '🚪Rex' });
    const c = finalCause(v);
    assert.equal(c.kind, 'leave');
    assert.equal(c.entry.text, '🚪Rex left the game');
    assert.ok(isLeaveLine(c.entry, names(v)));
  });

  test('a host who leaves and ends the game: the cause is the leave, not the "is now the host" line (whatever the names say)', () => {
    const { g, ids } = started(3);
    for (let i = 0; i < 3; i++) ok(g.handle(g.hostId, { t: 'next' }));
    ok(g.handle(ids[2], { t: 'leave' }));
    ok(g.handle(ids[0], { t: 'leave' }));   // the host leaves: Bravo becomes host, 1 alive, 1 bed
    assert.equal(g.phase, 'final');
    const v = viewAs(g, ids[1], { Alpha: 'Anna', Bravo: 'left the game' });
    const c = finalCause(v);
    assert.equal(c.kind, 'leave');
    assert.equal(c.entry.text, 'Anna left the game');
    assert.ok(!isLeaveLine({ kind: 'info', text: 'left the game is now the host' }, names(v)));
  });

  test('a real seal that ends the game is "Sealed by the airlock"; its lines are told apart by shape, with 🚪 and quotes in the names', () => {
    const { g, ids } = started(4, { 0: [AIRLOCK_CARD], 1: [AIRLOCK_CARD] });
    const [alpha, bravo, charlie, delta] = ids;
    for (let i = 0; i < 400 && !(g.round === 2 && g.phase === 'reveal'); i++) ok(g.handle(g.hostId, { t: 'next' }));
    ok(g.handle(alpha, { t: 'kick', playerId: delta }));   // 3 alive, 2 beds
    ok(g.handle(alpha, { t: 'special', uid: uid(g, alpha, 'airlock'), targetId: charlie }));
    ok(g.handle(bravo, { t: 'special', uid: uid(g, bravo, 'airlock'), targetId: charlie }));
    assert.equal(g.phase, 'final');
    const rename = { Alpha: '🚪 Ann', Bravo: '“Airlock”', Charlie: '🚪 The airlock', Delta: 'left' };
    const v = viewAs(g, bravo, rename);
    const kinds = v.log.map((e) => (airlockLine(e.text, e.kind) || {}).kind || null).filter(Boolean);
    assert.deepEqual(kinds, ['start', 'seal']);
    const start = v.log.find((e) => (airlockLine(e.text, e.kind) || {}).kind === 'start');
    const seal = v.log.find((e) => (airlockLine(e.text, e.kind) || {}).kind === 'seal');
    assert.equal(seal.kind, 'eject');
    // the word that names the card, not an "airlock" inside a name
    const air = airlockLine(start.text);
    assert.equal(start.text.slice(air.at, air.at + 7), 'airlock');
    assert.equal(air.at, '🚪 🚪 Ann started cycling the '.length);
    assert.equal(air.by, '🚪 Ann');
    assert.equal(airlockLine(seal.text).at, '🚪 “Airlock” sealed the '.length);
    assert.equal(airlockLine(seal.text, 'special'), null, 'a seal is an eject line');
    const c = finalCause(v);
    assert.equal(c.kind, 'special');
    assert.equal(c.airlock, true);
    assert.equal(c.entry, seal);
    // the kick is a leave line of a seated player; the others are not
    assert.ok(v.log.some((e) => e.text === 'left was removed by the host' && isLeaveLine(e, names(v))));
    assert.ok(!v.log.some((e) => e.kind === 'info' && /joined/.test(e.text) && isLeaveLine(e, names(v))));
  });

  test('an airlock that jams never counts as the cause (it is logged after the door closes)', () => {
    const { g, ids } = started(3, { 0: [AIRLOCK_CARD] });
    for (let i = 0; i < 400 && !(g.round === 2 && g.phase === 'reveal'); i++) ok(g.handle(g.hostId, { t: 'next' }));
    ok(g.handle(ids[0], { t: 'special', uid: uid(g, ids[0], 'airlock'), targetId: ids[2] }));
    ok(g.handle(ids[1], { t: 'leave' }));   // 2 alive, 1 bed
    ok(g.handle(ids[0], { t: 'leave' }));   // 1 alive: the final jams the open airlock
    const v = viewAs(g, ids[2], { Charlie: '🚪Rex' });
    assert.ok(v.log.some((e) => (airlockLine(e.text, e.kind) || {}).kind === 'jam'));
    const c = finalCause(v);
    assert.equal(c.kind, 'leave');
    assert.equal(c.entry.text, 'Alpha left the game');
  });

  test('a name that reads like a special line cannot move the title: the chip and its text come from the real card', () => {
    const EAVES = { id: 'e', title: 'Eavesdropping', text: 'Peek at a hidden card.', effect: 'peek', target: 'other', category: 'random' };
    const { g, ids } = started(4, { 1: [EAVES] });
    ok(g.handle(ids[1], { t: 'special', uid: uid(g, ids[1], 'peek'), targetId: ids[2] }));
    const forged = 'played “Alibi”: a →';
    const v = viewAs(g, ids[0], { Bravo: forged });
    const line = v.log.find((e) => e.kind === 'special');
    assert.ok(line.text.startsWith(`Round 1 — ${forged} played “Eavesdropping”: `), line.text);
    const strong = { Eavesdropping: EAVES.text, Alibi: 'The real Alibi text.' };
    for (const known of [(t) => strong[t] || '', () => '']) {
      const m = parseSpecialLine(line.text, names(v), known);
      assert.equal(m.title, 'Eavesdropping');
      assert.equal(m.name, forged);
      assert.equal(m.cardText, EAVES.text);
      assert.equal(m.anchored, true);
      assert.equal(m.head, `Round 1 — ${forged} played `);
    }
    // a line whose player is no longer seated (before Play again): read only from a known title + its known text,
    // never taught (not anchored)
    const lone = parseSpecialLine(line.text, [], (t) => strong[t] || '');
    assert.equal(lone.title, 'Eavesdropping');
    assert.equal(lone.anchored, false);
    assert.equal(parseSpecialLine(line.text, [], () => ''), null);
    // a longer name that starts with another's name still reads from the right player
    const both = viewAs(g, ids[0], { Alpha: 'Bo', Bravo: 'Bo played “Alibi”:' });
    const m2 = parseSpecialLine(both.log.find((e) => e.kind === 'special').text, names(both), () => '');
    assert.equal(m2.title, 'Eavesdropping');
    assert.equal(m2.name, 'Bo played “Alibi”:');
  });

  test('quoted titles in names ("Airlock", “Census”, «Alibi») are not special lines and not airlock lines', () => {
    const { g, ids } = started(4);
    for (let i = 0; i < 4; i++) ok(g.handle(g.hostId, { t: 'next' }));
    for (const hostile of ['"Airlock"', '“Census”', '«Alibi»', '🚪 “Airlock” 🚪']) {
      const v = viewAs(g, ids[0], { Bravo: hostile });
      for (const e of v.log) {
        assert.equal(airlockLine(e.text, e.kind), null, e.text);
        assert.equal(parseSpecialLine(e.text, names(v), () => 'x'), null, e.text);
      }
    }
  });

  test('every effect\'s own line is read back with its player, title, text and result', () => {
    const effects = ['immunity', 'capacity_plus', 'bunker_add_feature', 'mass_reveal'];
    const deal = {};
    effects.forEach((eff, i) => { deal[i] = [{ id: eff, title: `Card ${i}`, text: `Text ${i} → with an arrow`, effect: eff, target: EFFECTS[eff].targets[0], category: eff === 'mass_reveal' ? 'hobby' : undefined }]; });
    const { g, ids } = started(4, deal);
    effects.forEach((eff, i) => {
      ok(g.handle(ids[i], { t: 'special', uid: uid(g, ids[i], eff) }));
    });
    const v = g.view(ids[0]);
    const lines = v.log.filter((e) => e.kind === 'special');
    assert.equal(lines.length, 4);
    lines.forEach((e, i) => {
      const m = parseSpecialLine(e.text, names(v), (t) => (t === `Card ${i}` ? `Text ${i} → with an arrow` : ''));
      assert.equal(m.name, NAMES[i]);
      assert.equal(m.title, `Card ${i}`);
      assert.equal(m.cardText, `Text ${i} → with an arrow`);
      assert.ok(e.text.endsWith(` → ${m.result}`));
    });
  });
});
