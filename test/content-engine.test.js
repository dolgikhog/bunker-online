// Content <-> engine cross-check (SPEC.md §5, §8): every special card in server/content.js is dealt through the real
// engine (server/game.js) and played, and what its rules text promises is checked against what the engine does.
// The cards come from the real dealer (all 52 of the random pool: each dealer deals every special once before any
// repeats, amendment C2) plus the two fixed cards the engine deals itself (Airlock and Back from the Forest, §11 X1);
// characteristic cards, catastrophes and bunkers are the real content too. Only the special hands are fixed: seat 0
// gets the card under test, everyone else a filler that is never played (the fixed deal is off for that).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, EFFECTS, CATEGORY_IDS } from '../server/game.js';
import { CATEGORIES, createDealer, AIRLOCK_CARD, REVIVE_CARD } from '../server/content.js';
import { mulberry32 } from '../server/rng.js';

const LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
const FILLER = { id: 'filler', title: 'Filler', text: 'Never played in these tests.', effect: 'bunker_add_feature', target: 'none' };

/** All distinct specials of the real deck (the first cycle of a dealer has no repeats). */
function allSpecials() {
  const d = createDealer(mulberry32(12345));
  const seen = new Map();
  for (let i = 0; i < 1000; i++) {
    const c = d.drawSpecial();
    if (seen.has(c.id)) break;
    seen.set(c.id, c);
  }
  return [...seen.values()];
}
const POOL = allSpecials();
const FIXED = [AIRLOCK_CARD, REVIVE_CARD];
/** Every card a table can hold: the random pool and the fixed cards. */
const SPECIALS = [...POOL, ...FIXED];

function ok(res) { assert.deepEqual(res, { ok: true }, JSON.stringify(res)); }
function err(res, code) { assert.equal(res.ok, false, `expected ${code}, got ok`); assert.equal(res.code, code, res.message); }
const P = (g, id) => g.players.find((p) => p.id === id);

/** A started game of n players (+1 spectator) where seat 0 (the host, "A") holds `card` as its first special.
 * `deal` maps other deal positions (seat * 2 + slot) to cards. */
function table(card, { n = 6, seed = 1, deal = {} } = {}) {
  const real = createDealer(mulberry32(seed));
  let k = 0;
  const dealer = {
    drawCard: (c) => real.drawCard(c),
    drawCatastrophe: () => real.drawCatastrophe(),
    drawBunker: () => real.drawBunker(),
    drawBunkerFeature: () => real.drawBunkerFeature(),
    drawSpecial: () => { const i = k++; return i === 0 ? { ...card } : { ...(deal[i] || FILLER) }; },
  };
  const clock = { t: 1_800_000_000_000 };
  const g = createGame({ room: 'TEST', rng: mulberry32(seed + 7), now: () => clock.t++, minPlayers: 2, dealer, fixedSpecials: false });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(g.join(`P${i}`).id);
  const spec = g.join('Watcher', { spectator: true }).id;
  ok(g.handle(ids[0], { t: 'start' }));
  const A = ids[0];
  const uid = P(g, A).specials[0].uid;
  assert.equal(P(g, A).specials[0].effect, card.effect);
  return { g, ids, A, uid, spec, play: (extra = {}) => g.handle(A, { t: 'special', uid, ...extra }) };
}

/** Everyone who can vote votes for the last candidate not in `avoid`; then the host closes the ballot. */
function resolveBallot(g, avoid) {
  const v = g.view(g.hostId).vote;
  const target = [...v.candidates].reverse().find((c) => !avoid.includes(c)) ?? v.candidates[v.candidates.length - 1];
  const ballot = `${v.ballot}:${v.stage}`;
  const same = () => { const w = g.view(g.hostId).vote; return g.phase === 'vote' && w && `${w.ballot}:${w.stage}` === ballot; };
  for (const voter of v.voters) if (voter !== target && same()) ok(g.handle(voter, { t: 'vote', targetId: target }));
  if (same()) ok(g.handle(g.hostId, { t: 'closeVote' }));
}

/** Presses Next (and resolves ballots without ejecting anyone in `avoid`) until pred(g). */
function advance(g, pred, avoid = []) {
  for (let i = 0; i < 5000; i++) {
    if (pred(g)) return;
    assert.notEqual(g.phase, 'final', 'the game ended before the point the test needs');
    if (g.phase === 'vote') resolveBallot(g, avoid);
    else ok(g.handle(g.hostId, { t: 'next' }));
  }
  assert.fail('advance() did not converge');
}
const at = (round, phase) => (g) => g.round === round && g.phase === phase;
const views = (g) => [...g.players.filter((p) => p.status !== 'left').map((p) => p.id), ...g.spectators.map((s) => s.id)].map((id) => g.view(id));
const pub = (g, id) => g.view(g.spectators[0].id).players.find((p) => p.id === id);

describe('content ↔ engine: every special card', () => {
  test('the real deck: 52 distinct pool cards + the 2 fixed ones cover every effect but the retired eject, all §5 combinations', () => {
    assert.equal(POOL.length, 52);
    assert.equal(new Set(POOL.map((c) => c.title)).size, 52, 'pool titles are distinct');
    const poolEffects = new Set(POOL.map((c) => c.effect));
    for (const e of ['airlock', 'revive', 'eject']) assert.ok(!poolEffects.has(e), `the random pool holds ${e}`);
    const effects = new Set(SPECIALS.map((c) => c.effect));
    assert.deepEqual([...effects].sort(), Object.keys(EFFECTS).filter((e) => e !== 'eject').sort());
    assert.ok(!POOL.some((c) => FIXED.some((f) => f.title === c.title)), 'no pool card shares a title with a fixed card');
    assert.deepEqual({ ...AIRLOCK_CARD, text: undefined }, { id: 'airlock', title: 'Airlock', effect: 'airlock', target: 'other', text: undefined });
    assert.deepEqual({ ...REVIVE_CARD, text: undefined }, { id: 'revive', title: 'Back from the Forest', effect: 'revive', target: 'ejected', text: undefined });
    assert.ok(Object.isFrozen(AIRLOCK_CARD) && Object.isFrozen(REVIVE_CARD));
    // drawSpecial() never yields them, over many cycles and seeds
    for (let seed = 1; seed <= 20; seed++) {
      const d = createDealer(mulberry32(seed));
      for (let i = 0; i < 52 * 3; i++) assert.ok(!['airlock', 'revive', 'eject'].includes(d.drawSpecial().effect), `seed ${seed} draw ${i}`);
    }
    for (const c of SPECIALS) {
      const e = EFFECTS[c.effect];
      assert.ok(e.targets.includes(c.target), `${c.id}: target ${c.target}`);
      if (!e.category) assert.equal(c.category, undefined, `${c.id} has a category`);
      else if (e.category === 'any') assert.ok(c.category === 'choose' || CATEGORY_IDS.includes(c.category), `${c.id}: ${c.category}`);
      else assert.ok(c.category === 'choose' || c.category === 'random', `${c.id}: ${c.category}`);
    }
  });

  test('rules text matches the card data (timing, round limit, target, category)', () => {
    for (const c of SPECIALS) {
      const t = c.text;
      const e = EFFECTS[c.effect];
      const where = `${c.id}: "${t}"`;
      if (e.timing === 'before_vote') assert.match(t, /during a reveal or discussion phase/i, `${where} must say when it can be played`);
      else assert.doesNotMatch(t, /during a reveal or discussion phase/i, where);
      if (e.minRound) assert.match(t, new RegExp(`round ${e.minRound}`), where);
      if (c.target === 'other') assert.match(t, /another player/i, where);
      if (c.target === 'ejected') assert.match(t, /ejected player/i, where);
      if (c.target === 'self') assert.match(t, /\byou(r)?\b/i, where);
      if (c.category === 'choose') assert.match(t, /choose (any|another player and (any|one of their hidden))/i, where);
      if (c.category === 'random') assert.match(t, /at random/i, where);
      if (CATEGORY_IDS.includes(c.category)) assert.ok(t.includes(LABEL[c.category]), `${where} must name ${LABEL[c.category]}`);
      for (const other of CATEGORY_IDS) {
        if (other !== c.category && CATEGORY_IDS.includes(c.category)) assert.ok(!t.includes(`${LABEL[other]} card`), `${where} names ${LABEL[other]}`);
      }
      if (['swap_card', 'reroll_card', 'force_reveal', 'mass_reveal', 'shuffle_category'].includes(c.effect)) assert.match(t, /revealed to everyone/, where);
      if (c.effect === 'peek') assert.match(t, /you alone see/, where);
    }
  });

  for (const card of SPECIALS) {
    test(`${card.id} (${card.effect}, ${card.target}${card.category ? `, ${card.category}` : ''}): does what its text says`, () => {
      EFFECT_CHECKS[card.effect](card);
    });
  }

  test('timing: before_vote cards are refused during a vote, anytime cards work there (all 54 kinds of card)', () => {
    for (const card of SPECIALS) {
      const t = table(card, { n: 6, seed: 3 });
      advance(t.g, at(5, 'vote'), [t.A]);
      const msg = playable(t, card);
      const res = t.play(msg);
      if (EFFECTS[card.effect].timing === 'before_vote') err(res, 'wrong_phase');
      else ok(res);
    }
  });
});

/** A valid play message for `card` held by A in the current state. */
function playable(t, card) {
  const { g, ids, A } = t;
  const msg = {};
  const target = card.target === 'self' ? A : card.target === 'other' ? ids.find((id) => id !== A && P(g, id).status === 'alive'
    && (EFFECTS[card.effect].category !== 'hidden' || CATEGORY_IDS.some((c) => !P(g, id).cards[c].revealed))) : null;
  if (card.target === 'other') msg.targetId = target;
  if (card.category === 'choose') {
    msg.category = EFFECTS[card.effect].category === 'hidden' ? CATEGORY_IDS.find((c) => !P(g, target).cards[c].revealed) : 'hobby';
  }
  return msg;
}

const EFFECT_CHECKS = {
  swap_card(card) {
    const { g, ids, A, play } = table(card);
    const T = ids[2];
    const cat = card.category === 'choose' ? 'health' : card.category;
    const a0 = P(g, A).cards[cat].text;
    const b0 = P(g, T).cards[cat].text;
    err(play({ targetId: A, category: cat }), 'not_allowed'); // "another player"
    ok(play({ targetId: T, category: cat }));
    assert.deepEqual(P(g, A).cards[cat], { text: b0, revealed: true }, 'you get their card');
    assert.deepEqual(P(g, T).cards[cat], { text: a0, revealed: true }, 'they get yours');
    assert.equal(pub(g, A).cards[cat], b0, 'both cards are revealed to everyone');
    assert.equal(pub(g, T).cards[cat], a0);
  },

  reroll_card(card) {
    const { g, ids, A, play } = table(card, { seed: 11 });
    const T = card.target === 'self' ? A : ids[3];
    const cat = card.category === 'choose' ? 'hobby' : card.category;
    const old = P(g, T).cards[cat].text;
    ok(play(card.target === 'other' ? { targetId: T, category: cat } : { category: cat }));
    const now = P(g, T).cards[cat];
    assert.equal(now.revealed, true, 'the new card is revealed to everyone');
    assert.notEqual(now.text, old, 'the card was replaced by a newly drawn one');
    assert.equal(pub(g, T).cards[cat], now.text);
    // the discarded card is never shown, not even in the final
    advance(g, (x) => x.phase === 'final' || false, []);
    for (const v of views(g)) {
      const json = JSON.stringify(v);
      if (json.includes(old)) {
        const shownAsCard = v.players.some((p) => Object.values(p.cards).some((x) => x === old));
        assert.ok(!shownAsCard && !v.log.some((l) => l.text.includes(`“${old}”`)), `the discarded "${old}" is visible`);
      }
    }
  },

  force_reveal(card) {
    const { g, ids, A, play } = table(card);
    const T = ids[1];
    // let A and T take their round-1 turns, so T's profession is already public
    ok(g.handle(A, { t: 'reveal', category: 'profession' }));
    ok(g.handle(A, { t: 'endTurn' }));
    ok(g.handle(T, { t: 'reveal', category: 'profession' }));
    const before = CATEGORY_IDS.filter((c) => P(g, T).cards[c].revealed);
    if (card.category === 'choose') {
      err(play({ targetId: T, category: 'profession' }), 'not_allowed'); // "one of their hidden categories"
      ok(play({ targetId: T, category: 'phobia' }));
      assert.equal(P(g, T).cards.phobia.revealed, true);
    } else ok(play({ targetId: T, category: 'profession' })); // random: the message's category is ignored
    const after = CATEGORY_IDS.filter((c) => P(g, T).cards[c].revealed);
    assert.equal(after.length, before.length + 1, 'exactly one hidden card is revealed');
    const fresh = after.find((c) => !before.includes(c));
    assert.equal(pub(g, T).cards[fresh], P(g, T).cards[fresh].text, 'revealed to everyone');
    assert.equal(g.turn.hasRevealed, true, "T's own reveal is untouched");
  },

  peek(card) {
    const { g, ids, A, spec, play } = table(card);
    const T = ids[4];
    ok(play({ targetId: T, category: card.category === 'choose' ? 'skill' : undefined }));
    const me = g.view(A).me;
    assert.equal(me.notes.length, 1, 'added to your private notes');
    const cat = CATEGORY_IDS.find((c) => me.notes[0].text.includes(P(g, T).cards[c].text));
    assert.ok(cat, `the note names one of T's cards: ${me.notes[0].text}`);
    if (card.category === 'choose') assert.equal(cat, 'skill');
    const secret = P(g, T).cards[cat].text;
    assert.equal(P(g, T).cards[cat].revealed, false, 'the card stays hidden');
    for (const id of [...ids.filter((x) => x !== A), spec]) {
      assert.ok(!JSON.stringify(g.view(id)).includes(secret) || id === T, `${id} learns the peeked card`);
      if (id !== A) assert.equal(g.view(id).me?.notes.length ?? 0, 0);
    }
    assert.match(g.log[g.log.length - 1].text, /secretly looked at one of/, 'the others only learn that a peek happened');
  },

  mass_reveal(card) {
    const { g, ids, A, play } = table(card, { seed: 5 });
    advance(g, at(6, 'reveal'), [A]); // round 5 ejected one player
    const out = ids.filter((id) => P(g, id).status === 'ejected');
    assert.equal(out.length, 1);
    const cat = card.category === 'choose' ? 'phobia' : card.category;
    const outBefore = { ...P(g, out[0]).cards[cat] };
    ok(play(card.category === 'choose' ? { category: cat } : {}));
    for (const id of ids) {
      const p = P(g, id);
      if (p.status === 'alive') {
        assert.equal(p.cards[cat].revealed, true, `every alive player's card (${id}${id === A ? ', yours included' : ''})`);
        assert.equal(pub(g, id).cards[cat], p.cards[cat].text);
      } else assert.deepEqual(p.cards[cat], outBefore, 'an ejected player keeps theirs');
    }
  },

  shuffle_category(card) {
    const { g, ids, A, play } = table(card, { seed: 6 });
    advance(g, at(6, 'reveal'), [A]);
    const cat = card.category === 'choose' ? 'trait' : card.category;
    const alive = ids.filter((id) => P(g, id).status === 'alive');
    const out = ids.filter((id) => P(g, id).status !== 'alive');
    const before = alive.map((id) => P(g, id).cards[cat].text).sort();
    const outBefore = out.map((id) => ({ ...P(g, id).cards[cat] }));
    ok(play(card.category === 'choose' ? { category: cat } : {}));
    assert.deepEqual(alive.map((id) => P(g, id).cards[cat].text).sort(), before, 'the same cards, dealt back one each');
    for (const id of alive) assert.equal(pub(g, id).cards[cat], P(g, id).cards[cat].text, 'all of them are revealed to everyone');
    assert.deepEqual(out.map((id) => P(g, id).cards[cat]), outBefore, 'ejected players are not part of it');
  },

  immunity(card) { voteModCheck(card, 'immune'); },
  protect(card) { voteModCheck(card, 'immune'); },
  block_vote(card) { voteModCheck(card, 'blocked'); },

  double_vote(card) {
    for (const when of ['before', 'during']) {
      const { g, ids, A, play } = table(card, { n: 16, seed: 8 });
      advance(g, at(6, 'discussion'), [A]);
      if (when === 'before') ok(play());
      ok(g.handle(A, { t: 'next' }));
      assert.equal(g.phase, 'vote');
      const v1 = g.view(A).vote;
      assert.equal(v1.ballots, 2, 'round 6 at N=16 is a two-ballot step');
      if (when === 'during') ok(play());
      for (let b = 1; b <= 2; b++) {
        const v = g.view(A).vote;
        const X = v.candidates.filter((c) => c !== A).pop();
        ok(g.handle(A, { t: 'vote', targetId: X }));
        ok(g.handle(A, { t: 'closeVote' }));
        const r = g.view(A).lastVoteResult;
        const e = r.tally.find((x) => x.targetId === X);
        assert.deepEqual([e.votes, e.voterIds], [2, [A]], `ballot ${b} (${when}): your vote counts twice`);
        assert.equal(r.ejectedId, X);
      }
      assert.equal(g.phase, 'reveal');
      assert.deepEqual(g.view(A).voteMods.doubleVote, [], 'cleared when the vote step ends');
    }
  },

  cancel_vote(card) {
    { // no vote running: the next vote is cancelled, the kick carries over
      const { g, A, play } = table(card);
      advance(g, at(5, 'reveal'));
      ok(play());
      assert.equal(g.view(A).voteMods.cancelNext, true);
      advance(g, at(5, 'discussion'));
      ok(g.handle(A, { t: 'next' }));
      assert.equal(g.phase, 'reveal');
      assert.equal(g.round, 6);
      const v = g.view(A);
      assert.equal(v.lastVoteResult.cancelled, true);
      assert.equal(v.voteMods.cancelNext, false);
      assert.equal(v.schedule.kicksThisStep, 2, 'skipped ejections are made up in later votes');
    }
    for (const stage of ['vote', 'defense']) { // a vote is running: the rest of it is cancelled at once
      const { g, ids, A, play } = table(card, { seed: 2 });
      advance(g, at(5, 'vote'), [A]);
      if (stage === 'defense') {
        const [x, y] = g.view(A).vote.candidates.filter((c) => c !== A).slice(-2);
        const n = { [x]: 0, [y]: 0 };
        const cast = (voter, target) => { n[target]++; ok(g.handle(voter, { t: 'vote', targetId: target })); };
        const others = g.view(A).vote.voters.filter((v) => v !== x && v !== y);
        if (others.length % 2) others.pop(); // an even number of the rest, split evenly: a tie
        cast(x, y);
        cast(y, x);
        for (const voter of others) cast(voter, n[x] <= n[y] ? x : y);
        if (g.phase === 'vote') ok(g.handle(A, { t: 'closeVote' }));
        assert.equal(g.phase, 'defense', 'a tie leads to a defense');
      }
      const alive = g.players.filter((p) => p.status === 'alive').length;
      ok(play());
      assert.equal(g.phase, 'reveal');
      assert.equal(g.round, 6);
      assert.equal(g.view(A).lastVoteResult.cancelled, true);
      assert.equal(g.players.filter((p) => p.status === 'alive').length, alive, 'nobody was ejected');
      assert.equal(g.view(A).schedule.kicksThisStep, 2, 'the kick carries over');
    }
  },

  airlock(card) {
    // "Needs a partner": seat 1 (B) holds a second Airlock; seat 3 (T) holds an immunity card
    const IMMUNE = POOL.find((c) => c.effect === 'immunity');
    const { g, ids, A, spec, play } = table(card, { deal: { 2: card, 6: IMMUNE } });
    const [, B, , T] = ids;
    const bUid = P(g, B).specials[0].uid;
    err(play({ targetId: T }), 'not_allowed'); // "From round 2"
    advance(g, at(2, 'reveal'));
    err(play({ targetId: A }), 'not_allowed'); // "choose a player": another one
    ok(g.handle(T, { t: 'special', uid: P(g, T).specials[0].uid })); // "Vote immunity does not stop it"
    ok(play({ targetId: T })); // "start cycling the airlock on them"
    assert.equal(P(g, T).status, 'alive', 'alone, nothing happens yet');
    assert.deepEqual(g.view(spec).airlocks, [{ targetId: T, byIds: [A], round: 2 }]);
    ok(g.handle(B, { t: 'special', uid: bUid, targetId: T })); // "another player plays an Airlock on the same player this round"
    assert.equal(P(g, T).status, 'ejected', 'they are thrown out — no vote');
    assert.equal(pub(g, T).status, 'ejected');
    assert.deepEqual(g.view(spec).airlocks, []);
    assert.equal(g.phase, 'reveal', 'no vote happened');

    // "Alone, the airlock jams when the discussion ends"
    const t2 = table(card, { deal: { 2: card } });
    advance(t2.g, at(2, 'discussion'));
    ok(t2.play({ targetId: t2.ids[4] }));
    assert.equal(t2.g.view(t2.spec).airlocks.length, 1);
    ok(t2.g.handle(t2.g.hostId, { t: 'next' }));
    assert.deepEqual([t2.g.phase, t2.g.round], ['reveal', 3]);
    assert.deepEqual(t2.g.view(t2.spec).airlocks, [], 'jammed');
    assert.equal(P(t2.g, t2.ids[4]).status, 'alive');
    assert.equal(P(t2.g, t2.A).specials[0].used, true, 'the card stays spent');
    // a second Airlock next round starts a new airlock (the jammed one is gone)
    advance(t2.g, at(3, 'reveal'));
    ok(t2.g.handle(t2.ids[1], { t: 'special', uid: P(t2.g, t2.ids[1]).specials[0].uid, targetId: t2.ids[4] }));
    assert.equal(P(t2.g, t2.ids[4]).status, 'alive');
  },

  revive(card) {
    const { g, ids, A, play } = table(card, { seed: 4 });
    advance(g, at(6, 'reveal'), [A]);
    const E = ids.find((id) => P(g, id).status === 'ejected');
    assert.ok(E);
    const L = ids.find((id) => id !== A && P(g, id).status === 'alive');
    ok(g.handle(L, { t: 'leave' }));
    assert.equal(P(g, L).status, 'left');
    err(play({ targetId: L }), 'not_allowed'); // "not one who left the game"
    const kicksBefore = g.view(A).schedule.kicksThisStep;
    ok(play({ targetId: E }));
    assert.equal(P(g, E).status, 'alive', 'they come back and are alive again');
    assert.ok(!g.view(A).turn.order.includes(E), 'revived during a reveal phase: no turn this round');
    assert.ok(g.view(A).schedule.kicksThisStep > kicksBefore, 'later votes may eject more to make up for it');
    advance(g, at(7, 'reveal'), [A, E]);
    assert.ok(g.view(A).turn.order.includes(E), 'they speak again from the next round');

    // "whether they were voted out or thrown out through the airlock" — and SPEC §1: someone who was alive when the
    // reveal phase began, was thrown out before their turn and is revived before it, is alive when the turn comes, so
    // they do speak this round ("a phase that began without them")
    const t2 = table(card, { seed: 4, deal: { 2: AIRLOCK_CARD, 4: AIRLOCK_CARD } }); // seats 1 and 2 hold Airlocks
    const [a, b, c, d] = t2.ids;
    advance(t2.g, at(3, 'reveal'));
    assert.equal(t2.g.view(a).turn.speakerId, a);
    ok(t2.g.handle(b, { t: 'special', uid: P(t2.g, b).specials[0].uid, targetId: d }));
    ok(t2.g.handle(c, { t: 'special', uid: P(t2.g, c).specials[0].uid, targetId: d }));
    assert.equal(P(t2.g, d).status, 'ejected');
    ok(t2.play({ targetId: d }));
    assert.equal(P(t2.g, d).status, 'alive');
    advance(t2.g, (x) => x.turn && x.turn.order[x.turn.index] === d || x.phase !== 'reveal');
    assert.equal(t2.g.phase, 'reveal', 'revived before their turn in a phase that began with them: they speak this round');
    assert.equal(t2.g.view(a).turn.speakerId, d);
  },

  capacity_plus(card) {
    { const { g, A, play } = table(card);
      const cap = g.capacity;
      ok(play());
      assert.equal(g.capacity, cap + 1);
      assert.equal(g.view(A).capacity, cap + 1);
      assert.equal(g.phase, 'reveal'); }
    { const { g, A, play } = table(card, { n: 2 }); // 2 alive, 1 bed -> 2 beds: everyone fits, the game ends at once
      ok(play());
      assert.equal(g.phase, 'final');
      assert.deepEqual(g.view(A).final.survivors.length, 2); }
  },

  capacity_minus(card) {
    { const { g, play } = table(card);
      ok(play());
      assert.equal(g.capacity, 2); }
    { const { g, play } = table(card, { n: 3 });
      assert.equal(g.capacity, 1);
      ok(play());
      assert.equal(g.capacity, 1, 'never below 1'); }
  },

  bunker_add_feature(card) {
    const { g, A, play } = table(card);
    const before = [...g.bunker.features];
    ok(play());
    const after = g.view(A).bunker.features;
    assert.equal(after.length, before.length + 1, 'a new feature is added for everyone to see');
    assert.ok(!before.includes(after[after.length - 1]), 'a feature the bunker did not have');
    assert.deepEqual(g.view(g.spectators[0].id).bunker.features, after);
  },
};

/** immunity / protect / block_vote: effective in every ballot of the next vote step, then cleared. */
function voteModCheck(card, mod) {
  const { g, ids, A, play } = table(card, { n: 16, seed: 9 });
  const T = card.target === 'self' ? A : ids[5];
  advance(g, at(6, 'reveal'), [A, T]);
  if (card.target === 'other') err(play({ targetId: A }), 'not_allowed'); // "another player"
  ok(play(card.target === 'other' ? { targetId: T } : {}));
  assert.deepEqual(g.view(A).voteMods[mod], [T]);
  advance(g, at(6, 'vote'), [A, T]);
  assert.equal(g.view(A).vote.ballots, 2, 'round 6 at N=16 is a two-ballot step');
  for (let b = 1; b <= 2; b++) {
    const v = g.view(A).vote;
    assert.equal(v.ballot, b);
    if (mod === 'immune') assert.ok(!v.candidates.includes(T), `ballot ${b}: nobody can vote against ${T}`);
    else {
      assert.ok(!v.voters.includes(T), `ballot ${b}: ${T} cannot vote`);
      err(g.handle(T, { t: 'vote', targetId: v.candidates.find((c) => c !== T) }), 'not_allowed');
    }
    resolveBallot(g, [A, T]);
  }
  assert.deepEqual([g.phase, g.round], ['reveal', 7]);
  assert.deepEqual(g.view(A).voteMods[mod], [], 'cleared after that vote');
  advance(g, at(7, 'vote'), [A, T]);
  const v7 = g.view(A).vote;
  assert.ok(mod === 'immune' ? v7.candidates.includes(T) : v7.voters.includes(T), 'the vote after that is normal again');
}
