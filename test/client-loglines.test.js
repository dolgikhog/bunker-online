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
/**
 * The view `id` gets, with the players renamed (every occurrence in the log too, as the server writes names). These
 * tests are about the English text path (a line without a key: a server from before X5), so the keys are stripped;
 * `keep` keeps them, with the names renamed in the player parts too (the key path, SPEC §11 X5.3).
 */
function viewAs(g, id, rename, keep = false) {
  const v = structuredClone(g.view(id));
  const sub = (t) => Object.entries(rename).reduce((acc, [a, b]) => acc.split(a).join(b), t);
  for (const p of v.players) p.name = sub(p.name);
  for (const e of v.log) {
    e.text = sub(e.text);
    if (!keep) { delete e.key; delete e.params; delete e.parts; } else e.parts = e.parts.map((x) => (typeof x === 'object' && x.t === 'player' ? { ...x, v: sub(x.v) } : typeof x === 'string' ? sub(x) : x));
  }
  return v;
}
/** finalCause on the key path agrees with the text path on the same (renamed) view. */
function sameCause(g, id, rename) {
  const a = finalCause(viewAs(g, id, rename, true));
  const b = finalCause(viewAs(g, id, rename));
  assert.deepEqual([a.kind, !!a.airlock, a.entry && a.entry.id], [b.kind, !!b.airlock, b.entry && b.entry.id]);
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
      sameCause(g, ids[0], { Bravo: hostile });
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
    sameCause(g, ids[0], { Charlie: '🚪Rex' });
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
    sameCause(g, ids[1], { Alpha: 'Anna', Bravo: 'left the game' });
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
    sameCause(g, bravo, rename);
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
    sameCause(g, ids[2], { Charlie: '🚪Rex' });
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

// ---------------------------------------------------------------------------------------------------------------
// SPEC §11 X5.3 (reports/i18n-design.md §8.4): the key path. Real seeded games with the real content, driven at random
// (reveals, every kind of special, votes, leaves, kicks): every reader gives the same answer from the keys as from the
// English text (keys stripped: the legacy path), and the same answer for a Russian view of the same game.
import { keyed, airlockOf, leaveOf, isEndGameLine, isGameStartLine, isRoundOneLine, hostChangeOf, revealOf, flashParts, partsText, voteHistory as vh } from '../public/loglines.js';

const CATS = ['profession', 'biology', 'health', 'hobby', 'phobia', 'skill', 'trait', 'baggage'];
/** A seeded game with the real dealer, played to the end at random; returns the game and the players' ids. */
function randomGame(seed, n) {
  const clock = { t: 1_800_000_000_000 };
  const rnd = mulberry32(seed * 7919 + 1);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const g = createGame({ room: 'KEYS', rng: mulberry32(seed), now: () => (clock.t += 1000), minPlayers: 2 });
  const ids = Array.from({ length: n }, (_, i) => g.join(`P${i + 1}`, { lang: i % 2 ? 'ru' : 'en' }).id);
  assert.deepEqual(g.handle(ids[0], { t: 'start' }), { ok: true });
  const alive = () => g.players.filter((p) => p.status === 'alive');
  let left = 0;
  for (let step = 0; step < 3000 && g.phase !== 'final'; step++) {
    const r = rnd();
    // a special, now and then, with a random target and category (refusals are fine)
    if (r < 0.12) {
      const p = pick(alive());
      const sp = p && p.specials.find((x) => !x.used);
      if (sp) {
        const others = g.players.filter((x) => x.id !== p.id);
        const msg = { t: 'special', uid: sp.uid, targetId: pick(others).id };
        if (sp.category === 'choose') msg.category = pick(CATS);
        g.handle(p.id, msg);
        continue;
      }
    }
    // a leave or a kick, rarely, while more than two are alive
    if (r > 0.995 && left < 2 && alive().length > 3 && GAME_PHASES_T.includes(g.phase)) {
      const p = pick(alive().filter((x) => x.id !== g.hostId));
      if (p) { g.handle(...(rnd() < 0.5 ? [p.id, { t: 'leave' }] : [g.hostId, { t: 'kick', playerId: p.id }])); left++; continue; }
    }
    const hv = g.view(g.hostId || ids[0]);
    const spId = hv.turn ? hv.turn.speakerId : null;
    if (g.phase === 'reveal' && spId) {
      const sp = g.players.find((x) => x.id === spId);
      const v = g.view(sp.id);
      if (!v.turn.hasRevealed) {
        const hidden = CATS.filter((c) => v.me && v.me.cards[c] && !v.me.cards[c].revealed && (!v.turn.mustReveal || v.turn.mustReveal === c));
        if (hidden.length && rnd() < 0.85) { g.handle(sp.id, { t: 'reveal', category: pick(hidden) }); continue; }
      }
      g.handle(rnd() < 0.8 ? sp.id : g.hostId, rnd() < 0.8 ? { t: 'endTurn' } : { t: 'next' });
      continue;
    }
    if (g.phase === 'vote' && g.vote) {
      const due = g.vote.voters.filter((x) => !g.vote.votes.has(x));
      if (due.length && rnd() < 0.9) {
        const v = pick(due);
        const c = g.vote.candidates.filter((x) => x !== v);
        if (c.length) { g.handle(v, { t: 'vote', targetId: pick(c) }); continue; }
      }
      g.handle(g.hostId, { t: 'closeVote' });
      continue;
    }
    if (g.phase === 'defense' && spId) { g.handle(spId, { t: 'endTurn' }); continue; }
    g.handle(g.hostId, { t: 'next' });
  }
  assert.equal(g.phase, 'final', `seed ${seed}: the game did not end`);
  return { g, ids };
}
const GAME_PHASES_T = ['reveal', 'discussion', 'vote', 'defense'];
/** The view with every key stripped: the legacy text path reads it (an entry of a server from before X5). */
function legacy(v) {
  const c = structuredClone(v);
  for (const e of c.log) { delete e.key; delete e.params; delete e.parts; }
  return c;
}
// the flash text as the client made it from the English text before X5 (public/app.js flashText, legacy branch)
function legacyFlash(e, names) {
  const m = e.kind === 'special' ? parseSpecialLine(e.text, names, () => '') : null;
  return m ? `${m.name} played “${m.title}” → ${m.result}` : e.text.replace(/^(?:Round \d+|Overtime)\s+—\s+/, '');
}

describe('client log lines: the key path (SPEC §11 X5.3) reads what the text path reads, in every language', () => {
  const games = [];
  for (let seed = 1; seed <= 24; seed++) games.push({ seed, ...randomGame(seed, 4 + (seed % 9)) });

  test('every entry has a key, params and parts whose texts join to its text', () => {
    for (const { g, ids } of games) {
      for (const lang of ['en', 'ru']) {
        const v = g.view(ids.find((x) => g.view(x)), lang);
        for (const e of v.log) {
          assert.ok(keyed(e), `${e.id}: ${JSON.stringify(e).slice(0, 120)}`);
          assert.equal(partsText(e.parts), e.text, `${lang} ${e.key}`);
        }
      }
    }
  });

  test('finalCause, the airlock lines, the leaves and the game/round/End game/host lines: keys = English text', () => {
    let causes = new Set();
    let air = 0;
    let leaves = 0;
    let hosts = 0;
    for (const { g, ids } of games) {
      const en = g.view(ids.find((x) => g.view(x)), 'en');
      const old = legacy(en);
      const names = en.players.map((p) => p.name);
      const a = finalCause(en);
      const b = finalCause(old);
      assert.equal(a.kind, b.kind);
      assert.equal(a.airlock, b.airlock);
      assert.equal(a.entry && a.entry.id, b.entry && b.entry.id);
      causes.add(a.kind + (a.airlock ? '+airlock' : ''));
      en.log.forEach((e, i) => {
        const o = old.log[i];
        const x = airlockOf(e);
        const y = airlockOf(o);
        assert.equal(x && x.kind, y && y.kind, e.text);
        if (x) {
          air++;
          assert.equal(x.target, y.target, e.text);
          if (x.kind !== 'jam') assert.equal(x.byName, y.by, e.text);
        }
        assert.equal(!!leaveOf(e, names), !!leaveOf(o, names), e.text);
        if (leaveOf(e, names)) { leaves++; assert.equal(leaveOf(e, names).kicked, leaveOf(o, names).kicked); }
        assert.equal(isEndGameLine(e), isEndGameLine(o));
        assert.equal(isGameStartLine(e), isGameStartLine(o));
        assert.equal(isRoundOneLine(e), isRoundOneLine(o));
        assert.equal(!!hostChangeOf(e), !!hostChangeOf(o), e.text);
        if (hostChangeOf(e)) hosts++;
        // the flash: the line without its round prefix and the special's rules text
        const fp = flashParts(e);
        assert.ok(fp && !fp.some((x) => typeof x === 'object' && (x.t === 'prefix' || x.t === 'cardtext')));
        assert.equal(partsText(fp), legacyFlash(o, names), e.text);
      });
      assert.deepEqual([...vh(en.log)], [...vh(old.log)]);
    }
    assert.ok(causes.size >= 2, `causes seen: ${[...causes]}`);
    assert.ok(air > 0 && leaves > 0 && hosts > 0, `airlock lines ${air}, leaves ${leaves}, host lines ${hosts}`);
  });

  test('a Russian view reads the same: the cause, the round track history, the airlock lines by id', () => {
    for (const { g, ids } of games) {
      for (const id of ids.filter((x) => g.view(x)).slice(0, 2)) {
        const en = g.view(id, 'en');
        const ru = g.view(id, 'ru');
        assert.ok(ru.log.some((e) => /[А-Яа-яЁё]/.test(e.text)), 'the Russian log is Russian');
        const a = finalCause(en);
        const b = finalCause(ru);
        assert.deepEqual([b.kind, b.airlock, b.entry && b.entry.id], [a.kind, a.airlock, a.entry && a.entry.id]);
        assert.deepEqual([...vh(ru.log)], [...vh(en.log)]);
        ru.log.forEach((e, i) => {
          const x = airlockOf(e);
          const y = airlockOf(en.log[i]);
          assert.deepEqual(x && [x.kind, x.a, x.t, x.by], y && [y.kind, y.a, y.t, y.by]);
          assert.equal(!!hostChangeOf(e), !!hostChangeOf(en.log[i]));
          assert.equal(isRoundOneLine(e), isRoundOneLine(en.log[i]));
        });
      }
    }
  });

  test('revealOf: the card a speaker revealed this round, by key, in any language', () => {
    const { g, ids } = started(4);
    const v0 = g.view(ids[0]);
    const sp = v0.turn.speakerId;
    ok(g.handle(sp, { t: 'reveal', category: 'profession' }));
    for (const lang of ['en', 'ru']) {
      const v = g.view(ids[0], lang);
      const r = revealOf(v.log, sp, v.round, v.overtime);
      assert.equal(r.cat, 'profession');
      assert.equal(r.value, v.players.find((p) => p.id === sp).cards.profession);
      assert.equal(revealOf(v.log, ids.find((x) => x !== sp), v.round, v.overtime), null);
      assert.equal(revealOf(v.log, sp, v.round + 1, false), null, 'another round');
    }
  });
});
