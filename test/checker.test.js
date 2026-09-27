// Unit tests for the protocol Checker itself (test/helpers-sim.js): exact engine sequences, fed to it through stub
// clients, for the rare-but-legal paths the soak found (the game ending mid-turn or mid-discussion through a special;
// a vote that resolves several ballots in one change because the last one has no voter) and for bogus variants of
// them that the Checker must still reject. The Checker must neither cry wolf nor go blind.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createGame, EFFECTS } from '../server/game.js';
import { mulberry32 } from '../server/rng.js';
import { AIRLOCK_CARD, REVIVE_CARD } from '../server/content.js';
import { Checker, FRAME_BUDGET, x1Deal } from './helpers-sim.js';

function sp(effect) { return { id: effect, title: `T:${effect}`, text: `Card ${effect}`, effect, target: EFFECTS[effect].targets[0] }; }
const FILL = sp('bunker_add_feature');
// the real fixed cards (§11 X1), so the Checker recognises them by title and text as it does in a real game
const AIR = { ...AIRLOCK_CARD };
const REV = { ...REVIVE_CARD };

/** An engine game (hand-made deal: specials[seat] = [a, b]) whose every change is broadcast to stub clients. */
/** `fixedDeal`: the engine's §11 X1 fixed deal (then `specials` only fill the other slots, in deal order). */
/**
 * §11 X5: `langs(i)` gives member i its language (players first, then the watcher), `neutral` the Checker's mode, and
 * `ruWatcher` adds a Russian spectator whose stream the leak scan walks too.
 */
function world(n, specials, { seed = 3, fixedDeal = false, checkDeal = fixedDeal, langs = null, neutral = false, ruWatcher = false } = {}) {
  let card = 0;
  let k = 0;
  const dealer = {
    drawCard: (c) => `<${c}#${++card}>`,
    drawSpecial: () => { const i = k++; return { ...(specials[Math.floor(i / 2)]?.[i % 2] ?? FILL) }; },
    drawCatastrophe: () => ({ title: 'Flood', text: 'Water.', details: ['1%'] }),
    drawBunker: () => ({ name: 'B', size: '50 m²', duration: '1 year', food: '1 year', features: ['Well', 'Gym', 'Lab'] }),
    drawBunkerFeature: () => `<feature#${++card}>`,
  };
  let t = 1_800_000_000_000;
  const g = createGame({ room: 'ABCD', rng: mulberry32(seed), now: () => (t += 100), minPlayers: 2, dealer, fixedSpecials: fixedDeal });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`, { lang: langs ? langs(i) : 'en' }).id);
  const wid = g.join('Watcher', { spectator: true }).id;
  const rid = ruWatcher ? g.join('Watcher ru', { spectator: true, lang: 'ru' }).id : null;
  const checker = new Checker({ label: 'unit', checkDeal, neutral });
  const clients = new Map();
  const stub = (id, name) => { const b = new EventEmitter(); Object.assign(b, { id, name, socketGen: 1, left: false }); return b; };
  for (const id of [...ids, wid, ...(rid ? [rid] : [])]) {
    const b = stub(id, id);
    clients.set(id, b);
    checker.attach(b, { reference: id === wid, leakRef: id === rid });
  }
  // every state comes with its size on the wire, as a bot reports it (§11 X5.2: the Checker holds a shortened log
  // window against the frame budget); `sizeOf(msg, id)` overrides it (undefined: a size the client does not know)
  const broadcast = (tamper, sizeOf) => {
    for (const [id, b] of clients) {
      let v = g.view(id);
      if (!v) continue;
      if (tamper) v = tamper(structuredClone(v), id);
      const msg = { t: 'state', ...v };
      b.emit('message', msg, { bytes: sizeOf ? sizeOf(msg, id) : Buffer.byteLength(JSON.stringify(msg)) });
    }
  };
  const act = (id, msg, tamper, sizeOf) => {
    const res = g.handle(id, msg);
    assert.deepEqual(res, { ok: true }, `${id} ${JSON.stringify(msg)}: ${res.code} ${res.message}`);
    if (msg.t === 'leave') clients.get(id).left = true;
    broadcast(tamper, sizeOf);
  };
  const uid = (id, effect) => g.players.find((p) => p.id === id).specials.find((s) => s.effect === effect && !s.used).uid;
  /** A spectator who joins now (a late recipient: it sees the old log lines for the first time). */
  const lateWatcher = (name, lang = 'en') => {
    const id = g.join(name, { spectator: true, lang }).id;
    const b = stub(id, id);
    clients.set(id, b);
    checker.attach(b, {});
    return id;
  };
  broadcast();
  return { g, ids, checker, act, broadcast, uid, host: ids[0], rid, lateWatcher };
}

/** Next until pred (votes in these tests are cast explicitly). */
function nextUntil(w, pred) {
  for (let i = 0; i < 500 && !pred(w.g); i++) w.act(w.g.hostId, { t: 'next' });
  assert.ok(pred(w.g), 'nextUntil did not reach its point');
}

describe('the Checker on exact engine sequences', () => {
  test('a revote ejection followed by a zero-voter ballot in the same change (soak #62) is legal', () => {
    // N=4: p4 leaves (alive 3); round 7: capacity 2 -> 1, p2 immune, p2 blocked => 2 kicks. Ballot 1 (p1, p3) ties,
    // the revote ties again (fate), and ballot 2 has one candidate whose only possible voter is blocked: it closes at
    // once with zero votes and fate ejects the last candidate -> final. The reference sees revote -> final directly.
    const w = world(4, { 0: [sp('capacity_minus'), FILL], 1: [sp('immunity'), FILL], 2: [sp('block_vote'), FILL] });
    const [p1, p2, p3, p4] = w.ids;
    w.act(p1, { t: 'start' });
    nextUntil(w, (g) => g.round === 2);
    w.act(p4, { t: 'leave' });
    nextUntil(w, (g) => g.round === 7 && g.phase === 'reveal');
    w.act(p1, { t: 'special', uid: w.uid(p1, 'capacity_minus') });
    w.act(p2, { t: 'special', uid: w.uid(p2, 'immunity') });
    w.act(p3, { t: 'special', uid: w.uid(p3, 'block_vote'), targetId: p2 });
    nextUntil(w, (g) => g.phase === 'vote');
    assert.deepEqual(w.g.view(p1).vote.candidates, [p1, p3]);
    w.act(p1, { t: 'vote', targetId: p3 });
    w.act(p3, { t: 'vote', targetId: p1 });
    assert.equal(w.g.phase, 'defense');
    nextUntil(w, (g) => g.phase === 'vote');
    w.act(p1, { t: 'vote', targetId: p3 });
    w.act(p3, { t: 'vote', targetId: p1 }); // closes the revote, and the zero-voter ballot 2, and ends the game
    assert.equal(w.g.phase, 'final');
    const r = w.g.view(p2).lastVoteResult;
    assert.equal(r.stage, 'main');
    assert.equal(r.random, true);
    const rep = w.checker.finish();
    assert.deepEqual(rep.violations, []);
    assert.ok(rep.warnings.some((x) => /closed at once with zero voters/.test(x)));
  });

  test('...but a zero-voter claim is checked: if someone could have voted, it is a violation', () => {
    const w = world(4, { 0: [sp('capacity_minus'), FILL], 1: [sp('immunity'), FILL], 2: [sp('block_vote'), FILL] });
    const [p1, p2, p3, p4] = w.ids;
    w.act(p1, { t: 'start' });
    nextUntil(w, (g) => g.round === 2);
    w.act(p4, { t: 'leave' });
    nextUntil(w, (g) => g.round === 7 && g.phase === 'reveal');
    w.act(p1, { t: 'special', uid: w.uid(p1, 'capacity_minus') });
    w.act(p2, { t: 'special', uid: w.uid(p2, 'immunity') });
    w.act(p3, { t: 'special', uid: w.uid(p3, 'block_vote'), targetId: p2 });
    // a lying server: the broadcasts stop showing p2 as blocked, so p2 could have voted in ballot 2
    const unblock = (v) => { v.voteMods.blocked = []; if (v.vote) v.vote.voters = v.vote.voters.includes(p2) ? v.vote.voters : v.vote.voters; return v; };
    w.broadcast(unblock);
    nextUntil(w, (g) => g.phase === 'vote');
    w.act(p1, { t: 'vote', targetId: p3 }, unblock);
    w.act(p3, { t: 'vote', targetId: p1 }, unblock);
    nextUntil(w, (g) => g.phase === 'vote');
    w.act(p1, { t: 'vote', targetId: p3 }, unblock);
    w.act(p3, { t: 'vote', targetId: p1 }, unblock);
    const rep = w.checker.finish();
    assert.ok(rep.violations.some((x) => /claimed zero voters/.test(x)), rep.violations.join('\n'));
  });

  test('the game ending mid-turn (capacity_plus) or mid-discussion (a sealed airlock) is legal, without an auto-reveal', () => {
    { // mid-turn: Extra Bunk
      const w = world(3, { 1: [sp('capacity_plus'), FILL] }); // 3 players, 1 bed
      const [p1, p2] = w.ids;
      w.act(p1, { t: 'start' });
      nextUntil(w, (g) => g.round === 7 && g.phase === 'reveal');
      w.act(p1, { t: 'next' }); // one turn done; now mid-turn of the second speaker in round 7
      assert.equal(w.g.players.filter((p) => p.status === 'alive').length, 2, 'the round-6 vote left 2 alive for 1 bed');
      w.act(p2, { t: 'special', uid: w.uid(p2, 'capacity_plus') });
      assert.equal(w.g.phase, 'final');
      const rep = w.checker.finish();
      assert.deepEqual(rep.violations, [], `reveal: ${rep.violations.join('\n')}`);
    }
    { // mid-discussion: two players seal the airlock on the third of 3 alive for 2 beds
      const w = world(4, { 0: [AIR, FILL], 1: [AIR, FILL] });
      const [p1, p2, p3, p4] = w.ids;
      w.act(p1, { t: 'start' });
      w.act(p4, { t: 'leave' });
      nextUntil(w, (g) => g.round === 2 && g.phase === 'discussion');
      w.act(p1, { t: 'special', uid: w.uid(p1, 'airlock'), targetId: p3 });
      w.act(p2, { t: 'special', uid: w.uid(p2, 'airlock'), targetId: p3 });
      assert.equal(w.g.phase, 'final');
      const rep = w.checker.finish();
      assert.deepEqual(rep.violations, [], `discussion: ${rep.violations.join('\n')}`);
      assert.deepEqual([rep.games[0].airlockOpened, rep.games[0].airlockSealed], [1, 1]);
    }
  });

  test('a speaker thrown out by an airlock during their own turn and revived in the same phase (soak r2 #116) is legal', () => {
    // §6: the turn of a speaker who stops being alive advances at once, with no reveal; §1: a revived player gets no
    // turn back. The Checker used to count that cut turn as one they had to reveal in.
    const w = world(6, { 0: [AIR, FILL], 1: [REV, FILL], 2: [AIR, FILL] });
    const [p0, p1, p2] = w.ids;
    w.act(p0, { t: 'start' });
    nextUntil(w, (g) => g.round === 2 && g.phase === 'reveal');
    const victim = w.g.turn.order[0]; // round 2 is descending: the last seat speaks first
    w.act(p0, { t: 'special', uid: w.uid(p0, 'airlock'), targetId: victim });
    assert.equal(w.g.turn.index, 0, 'one Airlock alone does nothing yet');
    w.act(p2, { t: 'special', uid: w.uid(p2, 'airlock'), targetId: victim });
    assert.equal(w.g.turn.index, 1, 'the ejected speaker\'s turn advanced');
    w.act(p1, { t: 'special', uid: w.uid(p1, 'revive'), targetId: victim });
    nextUntil(w, (g) => g.phase === 'discussion');
    const v = w.g.view(victim);
    assert.equal(v.players.find((p) => p.id === victim).revealedCount, 1, 'only the round-1 profession');
    const rep = w.checker.finish();
    assert.deepEqual(rep.violations, []);
    assert.equal(rep.games[0].airlockRevived, 1);
  });

  test('...but a speaker who stays alive and ends a turn without any reveal is still a violation', () => {
    const w = world(6, {});
    w.act(w.host, { t: 'start' });
    nextUntil(w, (g) => g.round === 2 && g.phase === 'reveal');
    const spk = w.g.turn.order[0];
    // a lying server: Next moves on but the broadcast hides the auto-reveal it made
    const hide = (v) => ({ ...v, players: v.players.map((p) => (p.id === spk ? { ...p, cards: { ...p.cards, ...Object.fromEntries(Object.keys(p.cards).filter((c) => c !== 'profession').map((c) => [c, null])) }, revealedCount: 1 } : p)) });
    w.act(w.host, { t: 'next' }, hide);
    const rep = w.checker.finish();
    assert.ok(rep.violations.some((x) => /turn ended without the auto-reveal/.test(x)), rep.violations.join('\n'));
  });

  test('...but ending the game without any cause is a violation (the exemptions stay tight)', () => {
    for (const where of ['reveal', 'discussion']) {
      const w = world(6, {});
      w.act(w.host, { t: 'start' });
      nextUntil(w, (g) => g.round === 3 && g.phase === where);
      // a lying server: the next broadcast is a final although nobody left, nothing was played and capacity is unchanged
      w.act(w.host, where === 'reveal' ? { t: 'reveal', category: w.g.players.find((p) => p.id === w.g.turn.order[w.g.turn.index]).id === w.host ? 'health' : 'health' } : { t: 'next' }, (v) => {
        const survivors = v.players.filter((p) => p.status === 'alive').map((p) => p.id);
        return {
          ...v, phase: 'final', turn: null, vote: null, timer: null, me: v.me && { ...v.me, canPlaySpecial: false, myVote: null },
          players: v.players.map((p) => ({ ...p, cards: Object.fromEntries(Object.keys(p.cards).map((c) => [c, p.cards[c] ?? `x-${p.id}-${c}`])), unplayedSpecials: [] })),
          schedule: { ...v.schedule, kicksThisStep: 0, nextVoteRound: null },
          final: { survivors, out: [] },
        };
      });
      const rep = w.checker.finish();
      assert.ok(rep.violations.length > 0, `${where}: a causeless final passed the Checker`);
    }
  });

  // ---- SPEC §11 X1 -------------------------------------------------------------------------------------------------

  test('airlocks over a real fixed deal: open, seal, jam, a revived victim, the deal at every final (Play again too)', () => {
    for (const n of [4, 8, 12]) {
      const w = world(n, {}, { fixedDeal: true, seed: 20 + n });
      for (let game = 1; game <= 2; game++) {
        w.act(w.host, { t: 'start' });
        const holders = (effect) => w.g.players.filter((p) => p.specials.some((c) => c.effect === effect)).map((p) => p.id);
        const air = holders('airlock');
        const rev = holders('revive');
        assert.deepEqual([air.length, rev.length], x1Deal(n), `N=${n} game ${game}`);
        nextUntil(w, (g) => g.round === 2 && g.phase === 'discussion');
        const victim = w.ids.find((id) => !air.includes(id) && !rev.includes(id));
        w.act(air[0], { t: 'special', uid: w.uid(air[0], 'airlock'), targetId: victim });
        w.act(air[1], { t: 'special', uid: w.uid(air[1], 'airlock'), targetId: victim });
        assert.equal(w.g.players.find((p) => p.id === victim).status, 'ejected');
        w.act(rev[0], { t: 'special', uid: w.uid(rev[0], 'revive'), targetId: victim });
        if (air.length > 2) {
          const lonely = w.ids.find((id) => id !== victim && id !== air[2] && w.g.players.find((p) => p.id === id).status === 'alive');
          w.act(air[2], { t: 'special', uid: w.uid(air[2], 'airlock'), targetId: lonely });
        }
        nextUntil(w, (g) => g.phase === 'final');
        if (game === 1) w.act(w.g.hostId, { t: 'playAgain' });
      }
      const rep = w.checker.finish();
      assert.deepEqual(rep.violations, [], `N=${n}: ${rep.violations.join('\n')}`);
      for (const gm of rep.games) {
        assert.equal(gm.dealChecked, true);
        assert.deepEqual([gm.airlockSealed, gm.airlockRevived, gm.airlockJammed], [1, 1, n >= 8 ? 1 : 0], `N=${n}`);
      }
    }
  });

  test('...but an ejection outside a vote without a two-player airlock is a violation (the retired eject)', () => {
    const w = world(6, { 0: [sp('eject'), FILL] });
    const [p0] = w.ids;
    w.act(p0, { t: 'start' });
    nextUntil(w, (g) => g.round === 2 && g.phase === 'reveal');
    w.act(p0, { t: 'special', uid: w.uid(p0, 'eject'), targetId: w.ids[3] });
    const rep = w.checker.finish();
    assert.ok(rep.violations.some((x) => /\(x1\) .* ejected outside a vote with no airlock open/.test(x)), rep.violations.join('\n'));
    assert.ok(rep.violations.some((x) => /unknown special effect eject/.test(x)), 'the retired effect in a hand is flagged too');
  });

  test('...and so is an airlock that vanishes without its "jammed" line, or one that outlives its discussion', () => {
    { // a lying server drops the jam line
      const w = world(6, { 0: [AIR, FILL] });
      w.act(w.host, { t: 'start' });
      nextUntil(w, (g) => g.round === 2 && g.phase === 'discussion');
      w.act(w.host, { t: 'special', uid: w.uid(w.host, 'airlock'), targetId: w.ids[4] });
      w.act(w.host, { t: 'next' }, (v) => ({ ...v, log: v.log.filter((e) => !/jammed/.test(e.text)) }));
      const rep = w.checker.finish();
      assert.ok(rep.violations.some((x) => /closed unsealed without a "jammed" line/.test(x)), rep.violations.join('\n'));
    }
    { // a lying server keeps showing it after the discussion
      const w = world(6, { 0: [AIR, FILL] });
      w.act(w.host, { t: 'start' });
      nextUntil(w, (g) => g.round === 2 && g.phase === 'discussion');
      w.act(w.host, { t: 'special', uid: w.uid(w.host, 'airlock'), targetId: w.ids[4] });
      const kept = w.g.view(w.host).airlocks;
      w.act(w.host, { t: 'next' }, (v) => ({ ...v, airlocks: kept }));
      const rep = w.checker.finish();
      assert.ok(rep.violations.some((x) => /outlived the discussion|airlock of round 2 open in round 3/.test(x)), rep.violations.join('\n'));
    }
  });

  test('§11 Y1: a target who leaves or is kicked (the host too): the jammed line comes right after that line', () => {
    { // the host is the target and leaves: the new host's line comes after the jam (review airlock-rules f1 r1)
      const w = world(6, { 1: [AIR, FILL], 2: [AIR, FILL] });
      w.act(w.host, { t: 'start' });
      nextUntil(w, (g) => g.round === 2 && g.phase === 'reveal');
      w.act(w.ids[1], { t: 'special', uid: w.uid(w.ids[1], 'airlock'), targetId: w.host });
      w.act(w.host, { t: 'leave' });
      const tail = w.g.log.slice(-3).map((e) => e.text);
      assert.deepEqual(tail, ['P0 left the game', '🚪 The airlock on P0 jammed — nobody closed it.', 'P1 is now the host']);
      w.act(w.ids[2], { t: 'special', uid: w.uid(w.ids[2], 'airlock'), targetId: w.ids[4] });
      w.act(w.g.hostId, { t: 'kick', playerId: w.ids[4] });
      assert.deepEqual(w.g.log.slice(-2).map((e) => e.text), ['P4 was removed by the host', '🚪 The airlock on P4 jammed — nobody closed it.']);
      nextUntil(w, (g) => g.phase === 'final');
      const rep = w.checker.finish();
      assert.deepEqual(rep.violations, [], rep.violations.join('\n'));
      assert.equal(rep.games[0].airlockJammed, 2);
    }
    { // the leave ends the game: the jam comes at the final, after "The bunker door closes"
      const w = world(4, { 1: [AIR, FILL] });
      w.act(w.host, { t: 'start' });
      nextUntil(w, (g) => g.round === 2 && g.phase === 'reveal');
      w.act(w.ids[3], { t: 'leave' });
      w.act(w.ids[1], { t: 'special', uid: w.uid(w.ids[1], 'airlock'), targetId: w.host });
      w.act(w.host, { t: 'leave' });
      assert.equal(w.g.phase, 'final');
      const tail = w.g.log.slice(-4).map((e) => e.text);
      assert.equal(tail[0], 'P0 left the game');
      assert.match(tail[2], /^The bunker door closes/);
      assert.equal(tail[3], '🚪 The airlock on P0 jammed — nobody closed it.');
      const rep = w.checker.finish();
      assert.deepEqual(rep.violations, [], rep.violations.join('\n'));
    }
    { // a lying server that names the new host first is caught
      const w = world(6, { 1: [AIR, FILL] });
      w.act(w.host, { t: 'start' });
      nextUntil(w, (g) => g.round === 2 && g.phase === 'reveal');
      w.act(w.ids[1], { t: 'special', uid: w.uid(w.ids[1], 'airlock'), targetId: w.host });
      w.act(w.host, { t: 'leave' }, (v) => {
        const n = v.log.length;
        const [jam, hostLine] = [v.log[n - 2], v.log[n - 1]];
        v.log[n - 2] = { ...hostLine, id: jam.id };
        v.log[n - 1] = { ...jam, id: hostLine.id };
        return v;
      });
      const rep = w.checker.finish();
      assert.ok(rep.violations.some((x) => /\(y1\) the airlock on p\d+, who left, jammed after .*is now the host/.test(x)), rep.violations.join('\n'));
    }
  });

  test('...and a final whose hands do not show the SPEC §11 X1 deal', () => {
    const w = world(6, {}, { checkDeal: true }); // the engine's fixed deal is off: nobody holds an Airlock
    w.act(w.host, { t: 'start' });
    nextUntil(w, (g) => g.phase === 'final');
    const rep = w.checker.finish();
    assert.ok(rep.violations.some((x) => /\(x1\) deal: 0 Airlock and 0 revive holders at N=6; SPEC §11 X1 wants 2 and 1/.test(x)), rep.violations.join('\n'));
  });
});

// ---- SPEC §11 X5: languages ------------------------------------------------------------------------------------------

describe('the Checker with several languages (§11 X5)', () => {
  const mixed = { langs: (i) => (i % 2 ? 'ru' : 'en'), neutral: true, ruWatcher: true };

  test('a mixed-language table (and a Russian leak stream): clean, airlocks by key, the deal by id', () => {
    const w = world(8, {}, { ...mixed, fixedDeal: true, seed: 28 });
    w.act(w.host, { t: 'start' });
    const air = w.g.players.filter((p) => p.specials.some((c) => c.effect === 'airlock')).map((p) => p.id);
    nextUntil(w, (g) => g.round === 2 && g.phase === 'discussion');
    const victim = w.ids.find((id) => !air.includes(id));
    w.act(air[0], { t: 'special', uid: w.uid(air[0], 'airlock'), targetId: victim });
    w.act(air[1], { t: 'special', uid: w.uid(air[1], 'airlock'), targetId: victim });
    w.act(air[2], { t: 'special', uid: w.uid(air[2], 'airlock'), targetId: w.ids.find((id) => id !== victim && !air.includes(id)) });
    nextUntil(w, (g) => g.phase === 'final');
    const rep = w.checker.finish();
    assert.deepEqual(rep.violations, [], rep.violations.join('\n'));
    assert.deepEqual([rep.games[0].airlockSealed, rep.games[0].airlockJammed, rep.games[0].dealChecked], [1, 1, true]);
    assert.deepEqual(rep.leakStats.streams.map((x) => x.lang), ['en', 'ru']);
    assert.ok(rep.leakStats.streams.every((x) => x.slots > 0));
  });

  test('...but without `neutral`, recipients in two languages differ (the fingerprints hold every word)', () => {
    const w = world(4, {}, { langs: (i) => (i % 2 ? 'ru' : 'en') });
    w.act(w.host, { t: 'start' });
    const rep = w.checker.finish();
    assert.ok(rep.violations.some((x) => /\(a\) .*diverges from the reference|\(a\) .*was never seen by the reference/.test(x)), rep.violations.join('\n'));
  });

  test('...and a hidden card in a Russian line (its text, a chip or a param) is caught by the Russian stream only', () => {
    for (const where of ['text', 'parts', 'params']) {
      const w = world(6, {}, mixed);
      w.act(w.host, { t: 'start' });
      nextUntil(w, (g) => g.round === 2 && g.phase === 'reveal');
      const owner = w.ids[1]; // Russian
      const secret = w.g.players.find((p) => p.id === owner).cards.baggage.text;
      // a lying server: the Russian views of the next line carry the owner's hidden Baggage
      w.act(w.host, { t: 'next' }, (v) => {
        if (v.you.lang !== 'ru') return v;
        const e = { ...v.log.at(-1) };
        if (where === 'text') {
          e.text += ` ${secret}`;
          e.parts = typeof e.parts.at(-1) === 'string' ? [...e.parts.slice(0, -1), `${e.parts.at(-1)} ${secret}`] : [...e.parts, ` ${secret}`];
        }
        if (where === 'parts') e.parts = [...e.parts.slice(0, -1), { t: 'card', id: 'x', v: typeof e.parts.at(-1) === 'string' ? e.parts.at(-1) : e.parts.at(-1).v, label: 'x', title: 'x', text: secret }];
        if (where === 'params') e.params = { ...e.params, hint: secret };
        v.log = [...v.log.slice(0, -1), e];
        return v;
      });
      const rep = w.checker.finish();
      assert.ok(rep.violations.some((x) => /\(b\) LEAK: the hidden p\d+\.baggage .* \[p\d+, ru\]/.test(x)), `${where}: ${rep.violations.join('\n')}`);
      assert.ok(!rep.violations.some((x) => /LEAK.*, en\]/.test(x)), `${where}: the English stream saw a Russian leak`);
      assert.ok(!rep.violations.some((x) => /§7 schema/.test(x)), `${where}: the tampered line itself is well-formed: ${rep.violations.join('\n')}`);
    }
  });

  test('...and a log entry that differs between recipients, or changes after it was sent, is caught', () => {
    { // neutral: the same entry id with other params for one recipient
      const w = world(4, {}, mixed);
      w.act(w.host, { t: 'start' }, (v, id) => (id === w.ids[2] ? { ...v, log: [...v.log.slice(0, -1), { ...v.log.at(-1), params: { ...v.log.at(-1).params, r: 9 } }] } : v));
      const rep = w.checker.finish();
      assert.ok(rep.violations.some((x) => /\(a\) .*log entry #\d+ differs between recipients/.test(x)), rep.violations.join('\n'));
    }
    { // an old entry rewritten later, in the same language
      const w = world(4, {}, mixed);
      w.act(w.host, { t: 'start' });
      w.act(w.host, { t: 'next' }, (v, id) => (id === w.ids[0] ? { ...v, log: [{ ...v.log[0], text: 'rewritten', parts: ['rewritten'] }, ...v.log.slice(1)] } : v));
      const rep = w.checker.finish();
      assert.ok(rep.violations.some((x) => /log entry #1 changed after it was sent/.test(x)), rep.violations.join('\n'));
    }
  });

  // §11 X5.2, the report's §14 fallback (server/rooms.js): the oldest lines of a long log may go without parts
  const bareOf = (e) => ({ id: e.id, ts: e.ts, kind: e.kind, text: e.text, key: e.key, params: e.params });
  const cutOld = (v) => ({ ...v, log: v.log.map((e, i) => (i < v.log.length - 20 ? bareOf(e) : e)) });
  test('a late recipient who gets the oldest lines of a long log without parts (the §14 cut) is clean', () => {
    const w = world(6, {}, { seed: 5 });
    w.act(w.host, { t: 'start' });
    nextUntil(w, (g) => g.log.length >= 45);
    const late = w.lateWatcher('Late');
    w.act(w.host, { t: 'next' }, (v, id) => (id === late ? cutOld(v) : v));
    nextUntil(w, (g) => g.phase === 'final');
    const rep = w.checker.finish();
    assert.deepEqual(rep.violations, [], rep.violations.join('\n'));
  });

  test('...but the parts of one line that differ between two recipients of one language are caught', () => {
    const w = world(6, {}, { seed: 5 });
    w.act(w.host, { t: 'start' });
    nextUntil(w, (g) => g.log.length >= 30);
    w.act(w.host, { t: 'next' }, (v, id) => {
      if (id !== w.ids[2]) return v;
      const i = v.log.findLastIndex((e) => e.parts.some((x) => typeof x === 'object' && x.t === 'player'));
      const e = v.log[i];
      const parts = e.parts.map((x) => (typeof x === 'object' && x.t === 'player' ? { ...x, id: 'p99' } : x));
      return { ...v, log: v.log.map((y, j) => (j === i ? { ...e, parts } : y)) };
    });
    const rep = w.checker.finish();
    assert.ok(rep.violations.some((x) => /\(a\) .*the parts of log entry #\d+ differ between recipients/.test(x)), rep.violations.join('\n'));
  });

  test('...and a line without parts among the newest 20 is a §7 schema violation', () => {
    const w = world(6, {}, { seed: 5 });
    w.act(w.host, { t: 'start' });
    nextUntil(w, (g) => g.log.length >= 30);
    w.act(w.host, { t: 'next' }, (v, id) => (id === w.ids[1] ? { ...v, log: v.log.map((e, i) => (i === v.log.length - 2 ? bareOf(e) : e)) } : v));
    const rep = w.checker.finish();
    assert.ok(rep.violations.some((x) => /has no parts, but an older entry has them/.test(x)), rep.violations.join('\n'));
  });

  // §11 X5.2, the frame guard (server/rooms.js): a frame at 120 KB leaves the oldest lines off; nowhere else
  describe('the frame guard: a shortened log window', () => {
    const played = (o = {}) => {
      const w = world(6, {}, { seed: 5, ...o });
      w.act(w.host, { t: 'start' });
      nextUntil(w, (g) => g.log.length >= 45);
      return w;
    };
    const sized = (who, n) => (msg, id) => (id === who ? n : Buffer.byteLength(JSON.stringify(msg)));
    const dropOld = (who, k) => (v, id) => (id === who ? { ...v, log: v.log.slice(k) } : v);
    const run = (fn, o) => { const w = played(o); fn(w); return w.checker.finish().violations; };

    test('the oldest lines left off a frame at the budget (the next one would not fit) are clean, and the window may grow back', () => {
      const v = run((w) => {
        w.act(w.host, { t: 'next' }, dropOld(w.ids[1], 3), sized(w.ids[1], FRAME_BUDGET - 20));
        w.act(w.host, { t: 'next' }, dropOld(w.ids[1], 1), sized(w.ids[1], FRAME_BUDGET));
        w.act(w.host, { t: 'next' });
        nextUntil(w, (g) => g.phase === 'final');
      });
      assert.deepEqual(v, [], v.join('\n'));
    });

    test('...but lines left off a frame that had room for them are caught', () => {
      const v = run((w) => w.act(w.host, { t: 'next' }, dropOld(w.ids[1], 3), sized(w.ids[1], 50_000)));
      assert.ok(v.some((x) => /the log is lines #\d+-#\d+ \(\d+ of \d+\): line #\d+ \(\d+ bytes\) was left off a 50000-byte frame although it fit/.test(x)), v.join('\n'));
    });

    test('...and so is a gap in the window, a frame over the budget with more than 20 lines, and a short window of unknown size', () => {
      const gap = run((w) => w.act(w.host, { t: 'next' }, (s, id) => (id === w.ids[2] ? { ...s, log: s.log.filter((_, i) => i !== 5) } : s)));
      assert.ok(gap.some((x) => /log ids jump from #\d+ to #\d+ \(a window has no gaps\)/.test(x)), gap.join('\n'));
      const over = run((w) => w.act(w.host, { t: 'next' }, dropOld(w.ids[1], 3), sized(w.ids[1], FRAME_BUDGET + 100)));
      assert.ok(over.some((x) => /the frame is 122980 bytes, over 122880, with more than 20 lines left/.test(x)), over.join('\n'));
      const unknown = run((w) => w.act(w.host, { t: 'next' }, dropOld(w.ids[1], 3), sized(w.ids[1], undefined)));
      assert.ok(unknown.some((x) => /and the frame's size is unknown/.test(x)), unknown.join('\n'));
    });

    test('a line never seen in that language: the frame must be near the budget', () => {
      const near = run((w) => {
        const ru = w.lateWatcher('Поздний', 'ru');
        w.act(w.host, { t: 'next' }, dropOld(ru, 3), sized(ru, FRAME_BUDGET - 100));
      }, { neutral: true });
      assert.deepEqual(near, [], near.join('\n'));
      const far = run((w) => {
        const ru = w.lateWatcher('Поздний', 'ru');
        w.act(w.host, { t: 'next' }, dropOld(ru, 3), sized(ru, 30_000));
      }, { neutral: true });
      assert.ok(far.some((x) => /a 30000-byte frame is not at the budget \(122880\), yet it left lines off/.test(x)), far.join('\n'));
    });

    test('Play again after a final whose frame left lines off: the lobby\'s longer window keeps the log; a lobby that loses it is caught', () => {
      // (the reference stream is the one Play again is checked on)
      const final = (w) => {
        nextUntil(w, (g) => g.phase === 'final');
        const ref = w.g.spectators[0].id;
        w.broadcast(dropOld(ref, 4), sized(ref, FRAME_BUDGET - 10));
        return ref;
      };
      const kept = run((w) => { final(w); w.act(w.host, { t: 'playAgain' }); });
      assert.deepEqual(kept, [], kept.join('\n'));
      const lost = run((w) => {
        const ref = final(w);
        w.act(w.host, { t: 'playAgain' }, (s, id) => (id === ref ? { ...s, log: s.log.slice(-1) } : s), sized(ref, FRAME_BUDGET - 10));
      });
      assert.ok(lost.some((x) => /the log was not kept/.test(x)), lost.join('\n'));
    });
  });

  test('...and a Russian reference still catches an airlock that vanishes without its "jammed" line (by key)', () => {
    const w = world(6, { 0: [AIR, FILL] }, { langs: () => 'ru', neutral: false });
    // every member Russian but the reference (English): switch it too
    w.g.setLang(w.g.spectators[0].id, 'ru');
    w.act(w.host, { t: 'start' });
    nextUntil(w, (g) => g.round === 2 && g.phase === 'discussion');
    w.act(w.host, { t: 'special', uid: w.uid(w.host, 'airlock'), targetId: w.ids[4] });
    w.act(w.host, { t: 'next' }, (v) => ({ ...v, log: v.log.filter((e) => e.key !== 'log.airlockJam') }));
    const rep = w.checker.finish();
    assert.ok(rep.violations.some((x) => /closed unsealed without a "jammed" line/.test(x)), rep.violations.join('\n'));
  });
});
