/* Mock mode for client B: ?mock=<scenario> renders fixture StateViews without a server.
 * Every fixture follows SPEC.md §7 (StateView) so the renderer sees exactly what the server sends.
 * handle() is a tiny local simulator so buttons do something plausible while clicking around. */

import { KICKS } from './kicks.js';

const CATEGORIES = [
  { id: 'profession', label: 'Profession' }, { id: 'biology', label: 'Biology' },
  { id: 'health', label: 'Health' }, { id: 'hobby', label: 'Hobby' }, { id: 'phobia', label: 'Phobia' },
  { id: 'skill', label: 'Extra skill' }, { id: 'trait', label: 'Personality' }, { id: 'baggage', label: 'Baggage' },
];
const CAT_IDS = CATEGORIES.map((c) => c.id);
const LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));
const NAMES = ['Alex', 'Anna', 'Ivan', 'Marta', 'Dmitri', 'Sasha', 'Katya', 'Boris', 'Lena', 'Pavel', 'Nika', 'Yuri', 'Vera', 'Gleb', 'Zoya', 'Maximilian the Third'];
const DECK = {
  profession: ['Surgeon (12 years of experience)', 'Nuclear physicist (3 years)', 'Farmer (20 years)', 'Kindergarten teacher (7 years)',
    'Electrician (15 years)', 'Chemist (1 year)', 'Army sniper (9 years)', 'Chef (4 years)', 'Civil engineer (11 years)', 'Nurse (6 years)',
    'Biologist (8 years)', 'Carpenter (25 years)', 'Airline pilot (14 years)', 'Orthodox priest (30 years)', 'Lawyer (2 years)', 'Beauty blogger (3 years)'],
  biology: ['Male, 41 y.o., heterosexual', 'Female, 34 y.o., heterosexual', 'Male, 71 y.o., heterosexual', 'Female, 22 y.o., bisexual',
    'Male, 45 y.o., homosexual', 'Female, 58 y.o., heterosexual, infertile', 'Female, 29 y.o., heterosexual, 3 months pregnant', 'Male, 19 y.o., heterosexual',
    'Female, 63 y.o., asexual', 'Male, 36 y.o., heterosexual', 'Female, 27 y.o., homosexual', 'Male, 52 y.o., heterosexual, infertile',
    'Female, 44 y.o., heterosexual', 'Male, 24 y.o., bisexual', 'Female, 81 y.o., heterosexual', 'Male, 33 y.o., heterosexual'],
  health: ['Perfectly healthy', 'Asthma (moderate)', 'Type 1 diabetes (severe)', 'Myopia −6', 'Nut allergy (mild)', 'Chronic insomnia',
    'Flat feet', 'Migraine (moderate)', 'Missing left hand', 'HIV (early stage)', 'Bipolar disorder (mild)', 'Perfectly healthy',
    'Hypertension (severe)', 'Color blind', 'Celiac disease', 'Stutters when nervous'],
  hobby: ['Fishing (5 years)', 'Chess (club level)', 'Gardening (12 years)', 'Hunting (8 years)', 'Knitting (2 years)', 'Guitar (10 years)',
    'Yoga (1 year)', 'Woodworking (6 years)', 'Parkour', 'Home brewing (4 years)', 'Rock climbing', 'Stand-up comedy', 'Beekeeping (3 years)',
    'Origami', 'Cross-stitch', 'Amateur astronomy'],
  phobia: ['Claustrophobia', 'Fear of the dark', 'Arachnophobia', 'Fear of blood', 'Fear of heights', 'Fear of crowds', 'Fear of dogs',
    'Fear of deep water', 'Fear of silence', 'Fear of fire', 'Fear of germs', 'Fear of loneliness', 'Fear of clowns', 'Fear of needles',
    'Fear of birds', 'No phobias'],
  skill: ['Speaks 5 languages', 'Knows first aid', 'Can drive a truck', 'Former prisoner (knows the rules)', 'Professional poker player',
    'Can build a radio from scrap', 'Military survival training', 'Brews beer', 'Hypnosis', 'Sign language', 'Picks any lock',
    'Photographic memory', 'Can butcher livestock', 'Sews and repairs clothes', 'Plays the accordion', 'Knows edible mushrooms'],
  trait: ['Honest to a fault', 'Hot-tempered', 'Natural leader', 'Coward', 'Incurable optimist', 'Pathological liar', 'Kind', 'Lazy',
    'Paranoid', 'Cheerful joker', 'Stubborn', 'Calm under pressure', 'Greedy', 'Hopeless romantic', 'Pessimist', 'Perfectionist'],
  baggage: ['TT pistol with 16 rounds', 'Bag of vegetable seeds', 'First aid kit', 'Acoustic guitar', 'Box of canned food (20 cans)',
    'Shortwave radio', 'Axe', 'Water filter', 'Laptop with offline Wikipedia', 'Pregnancy tests ×3', 'Fishing rod', 'Bottle of vodka',
    'Chemistry textbook', 'Solar panel (small)', 'Crate of antibiotics', 'A cat named Boris'],
};
const SPECIALS = {
  force: { title: 'Interrogation', text: 'Force another player to reveal one of their hidden cards — you choose which.', effect: 'force_reveal', target: 'other', category: 'choose' },
  peek: { title: 'Spy', text: 'Secretly look at one hidden card of another player.', effect: 'peek', target: 'other', category: 'choose' },
  trade: { title: 'Trade', text: 'Swap your Baggage with another player. Both become public.', effect: 'swap_card', target: 'other', category: 'baggage' },
  immunity: { title: 'Untouchable', text: 'Nobody can vote against you during the next vote.', effect: 'immunity', target: 'self', category: null },
  protect: { title: 'Bodyguard', text: 'Nobody can vote against the player you choose during the next vote.', effect: 'protect', target: 'other', category: null },
  double: { title: 'Loud voice', text: 'Your vote counts twice in the current or next vote.', effect: 'double_vote', target: 'self', category: null },
  block: { title: 'Gag order', text: 'The player you choose cannot vote in the next vote.', effect: 'block_vote', target: 'other', category: null },
  cancel: { title: 'Power outage', text: 'Cancel the current vote, or the next one if no vote is running.', effect: 'cancel_vote', target: 'none', category: null },
  airlock: { title: 'Airlock', text: 'Needs a partner. From round 2, during a reveal or discussion phase, choose a player to start cycling the airlock on them. If another player plays an Airlock on the same player this round before the vote, they are thrown out — no vote. Alone, the airlock jams when the discussion ends. Vote immunity does not stop it.', effect: 'airlock', target: 'other', category: null },
  revive: { title: 'Back from the Forest', text: 'Play during a reveal or discussion phase. Choose an ejected player, whether they were voted out or thrown out through the airlock (not one who left the game): they come back and are alive again. They get no turn in a reveal phase that began without them, and round 7 has the last reveal phase.', effect: 'revive', target: 'ejected', category: null },
  plus: { title: 'Extra bunk', text: 'You find a folding bed: the bunker gets one more place.', effect: 'capacity_plus', target: 'none', category: null },
  minus: { title: 'Collapsed wing', text: 'Part of the bunker collapses: one bed less.', effect: 'capacity_minus', target: 'none', category: null },
  feature: { title: 'Hidden room', text: 'You find a sealed door — the bunker gains a new feature.', effect: 'bunker_add_feature', target: 'none', category: null },
  reroll: { title: 'Fresh start', text: 'Replace one of your cards (you choose which) with a new random one. It is revealed.', effect: 'reroll_card', target: 'self', category: 'choose' },
  shuffle: { title: 'Mix-up', text: 'Collect one category from every alive player, shuffle and deal back. All revealed.', effect: 'shuffle_category', target: 'none', category: 'choose' },
  disclose: { title: 'Medical check', text: 'Every alive player reveals their Health.', effect: 'mass_reveal', target: 'none', category: 'health' },
};
const TIMING = { immunity: 'before_vote', protect: 'before_vote', block_vote: 'before_vote', eject: 'before_vote', airlock: 'before_vote', revive: 'before_vote', capacity_minus: 'before_vote' };
function special(key, uid, used = false) {
  const s = SPECIALS[key];
  return { uid, title: s.title, text: s.text, effect: s.effect, target: s.target, category: s.category, timing: TIMING[s.effect] || 'anytime', minRound: s.effect === 'eject' || s.effect === 'airlock' ? 2 : 1, used };
}
const CATASTROPHE = {
  title: 'Nuclear winter',
  text: 'A limited nuclear exchange threw enough ash into the stratosphere to block the sun. Crops have failed everywhere and the surface is freezing. Radio stations went silent one by one.',
  details: ['Remaining world population: about 4%', 'Surface temperature: −40 °C in winter', 'Radiation outside: deadly for the first 6 months'],
};
const BUNKER = {
  name: 'Shelter K-17 “Birch”', size: '180 m², 3 levels', duration: '3 years inside', food: 'Canned food for 2 years',
  features: ['Medical bay with a surgical table', 'Artesian water well', 'Workshop with hand tools', 'Hydroponic garden (broken)'],
};
const OPTIONS = { speechSeconds1: 60, speechSeconds: 30, discussionSeconds: 90, defenseSeconds: 30 };

// The order in which player i reveals cards: profession first, then a fixed per-player permutation.
function revealOrder(i) {
  const rest = CAT_IDS.slice(1);
  const out = ['profession'];
  let k = (i * 5 + 3) % rest.length;
  while (rest.length) { k = (k + i + 2) % rest.length; out.push(rest.splice(k, 1)[0]); }
  return out;
}
const card = (i, c) => DECK[c][i % DECK[c].length];
// a scenario may name its players itself: spec.names = { [seat]: name }
const nameAt = (spec, i) => (spec.names && spec.names[i]) || NAMES[i];
// a scenario may give a player a card text of its own: spec.cardText = { [seat]: { [category]: text } }
const cardFor = (spec, i, c) => (spec.cardText && spec.cardText[i] && spec.cardText[i][c]) || card(i, c);

/* Build a StateView. spec: {n, you, host, phase, round, shown(i)->number of revealed cards, status{i:'ejected'|'left'},
   offline[], played{i:[keys]}, mySpecials[[key, used]], spectators[], youSpectator{id,name}} */
function build(spec) {
  const now = Date.now();
  const n = spec.n;
  const status = spec.status || {};
  const offline = spec.offline || [];
  const played = spec.played || {};
  const final = spec.phase === 'final';
  const lobby = spec.phase === 'lobby';
  const shown = spec.shown || (() => 0);
  const players = [];
  for (let i = 0; i < n; i++) {
    const k = lobby ? 0 : shown(i);
    const order = revealOrder(i);
    const cards = {};
    for (const c of CAT_IDS) cards[c] = final || order.indexOf(c) < k ? cardFor(spec, i, c) : null;
    const pl = (played[i] || []).map((key) => ({ title: SPECIALS[key].title, text: SPECIALS[key].text }));
    const p = {
      id: 'p' + i, name: nameAt(spec, i), seat: i, connected: !offline.includes(i), isHost: i === spec.host,
      status: lobby ? 'alive' : status[i] || 'alive', cards, revealedCount: k, playedSpecials: lobby ? [] : pl,
      specialsLeft: lobby ? 0 : 2 - pl.length,
    };
    if (final) {
      const pool = ['plus', 'feature', 'peek', 'protect', 'reroll', 'disclose', 'minus', 'shuffle'];
      const fixed = (spec.unplayed || {})[i];
      p.unplayedSpecials = [];
      if (fixed) for (const key of fixed) p.unplayedSpecials.push({ title: SPECIALS[key].title, text: SPECIALS[key].text });
      else for (let j = pl.length; j < 2; j++) { const key = pool[(i * 3 + j) % pool.length]; p.unplayedSpecials.push({ title: SPECIALS[key].title, text: SPECIALS[key].text }); }
    }
    players.push(p);
  }
  const spectators = spec.spectators || [];
  const isSpectator = !!spec.youSpectator;
  const youP = isSpectator ? null : players[spec.you];
  const you = isSpectator
    ? { id: spec.youSpectator.id, name: spec.youSpectator.name, role: 'spectator', isHost: false }
    : { id: youP.id, name: youP.name, role: 'player', isHost: spec.you === spec.host };
  let me = null;
  if (!isSpectator && !lobby) {
    const k = shown(spec.you);
    const order = revealOrder(spec.you);
    const mc = {};
    for (const c of CAT_IDS) mc[c] = { text: cardFor(spec, spec.you, c), revealed: order.indexOf(c) < k };
    me = {
      cards: mc,
      specials: (spec.mySpecials || [['peek', false], ['immunity', false]]).map(([key, used], j) => special(key, `sp-${spec.you}-${j}`, used)),
      canPlaySpecial: spec.canPlay !== undefined ? spec.canPlay : youP.status === 'alive' && !final,
      notes: spec.notes || [],
      myVote: spec.myVote || null,
    };
  }
  const alive = players.filter((p) => p.status === 'alive').length;
  const outCount = n - alive;
  const kicks = KICKS[n] || [];
  const round = lobby ? 0 : spec.round;
  const cum = kicks.slice(0, round).reduce((a, b) => a + b, 0);
  const capacity = lobby ? 0 : spec.capacity || Math.floor(n / 2);
  let kicksThisStep = 0;
  if (!lobby && !final) kicksThisStep = round < 7 ? Math.max(0, Math.min(cum - outCount, alive - capacity)) : Math.max(0, alive - capacity);
  if (spec.kicksThisStep !== undefined) kicksThisStep = spec.kicksThisStep;
  let nextVoteRound = null;
  if (!lobby && !final) {
    if (kicksThisStep > 0) nextVoteRound = round;
    else for (let r = round + 1; r <= 7; r++) { if (kicks.slice(0, r).reduce((a, b) => a + b, 0) - outCount > 0) { nextVoteRound = r; break; } }
  }
  return {
    serverNow: now, room: 'KXQR', you, hostId: spec.host === null ? '' : 'p' + spec.host, phase: spec.phase, round, maxRounds: 7,
    overtime: !!spec.overtime, minPlayers: 4, maxPlayers: 16, options: { ...OPTIONS, ...(spec.options || {}) }, categories: CATEGORIES,
    catastrophe: lobby ? null : CATASTROPHE, bunker: lobby ? null : { ...BUNKER, features: [...BUNKER.features, ...(spec.extraFeatures || [])] },
    capacity, players, spectators, me, turn: spec.turn || null, vote: spec.vote || null,
    schedule: { kicksByRound: lobby ? (n >= 2 ? KICKS[n] : []) : kicks, outCount: lobby ? 0 : outCount, kicksThisStep, nextVoteRound },
    voteMods: { immune: [], blocked: [], doubleVote: [], cancelNext: false, ...(spec.voteMods || {}) },
    timer: spec.timer ? { label: spec.timer.label, endsAt: now + spec.timer.ms } : null,
    lastVoteResult: spec.lastVoteResult || null,
    log: makeLog(spec, players, now),
    final: final ? spec.final : null,
    // SPEC §11 X1.5: open airlocks ({targetId, byIds, round}); [] in the lobby and the final
    airlocks: lobby || final ? [] : (spec.airlocks || []).map(([t, by]) => ({ targetId: 'p' + t, byIds: by.map((i) => 'p' + i), round })),
  };
}
function makeLog(spec, players, now) {
  const lines = [];
  const add = (kind, text) => lines.push({ kind, text });
  const n = players.length;
  add('system', `Room KXQR created by ${nameAt(spec, spec.host ?? 0)}.`);
  for (let i = 1; i < Math.min(n, 6); i++) add('info', `${nameAt(spec, i)} joined`);
  if (spec.phase !== 'lobby') {
    add('system', `The game started with ${n} players. Catastrophe: ${CATASTROPHE.title}. Beds: ${Math.floor(n / 2)}.`);
    const rounds = Math.min(spec.round, 7);
    for (let r = 1; r <= rounds; r++) {
      add('system', `Round ${r}: reveals.`);
      const events = (spec.events || {})[r] || [];
      for (let i = 0; i < n; i++) {
        const k = spec.shown ? spec.shown(i) : 0;
        if (k >= r) { const c = revealOrder(i)[r - 1]; add('reveal', `${spec.rp ? `Round ${r} — ` : ''}${nameAt(spec, i)} revealed ${LABEL[c]}: ${cardFor(spec, i, c)}`); }
      }
      for (const [kind, text] of events) add(kind, text);
    }
  } else {
    add('info', 'Waiting for the host to start.');
  }
  for (const [kind, text] of spec.extraLog || []) add(kind, text);
  const start = now - lines.length * 23000;
  return lines.slice(-200).map((l, i) => ({ id: i + 1, ts: start + i * 23000, kind: l.kind, text: l.text }));
}
function tally(rows) { // rows: [targetIdx, [voterIdx...], votes?]
  return rows.map(([t, voters, votes]) => ({ targetId: 'p' + t, votes: votes ?? voters.length, voterIds: voters.map((v) => 'p' + v) }));
}
const ids = (arr) => arr.map((i) => 'p' + i);

/* ------------------------------------------------------------------ scenarios */
const SCENARIOS = {
  landing: {
    title: 'Landing page with a "Rejoin as…" offer next to the form',
    make: () => ({ landing: { form: { name: 'Alex', room: '' }, rejoin: { room: 'KXQR', id: 'p0', token: 'mock-token', name: 'Alex' } } }),
  },
  'landing-kicked': {
    title: 'Landing after being kicked, room prefilled',
    make: () => ({ landing: { form: { name: 'Anna', room: 'KXQR' }, notice: { kind: 'warn', text: 'The host removed you from room KXQR.' } } }),
  },
  'landing-invite': {
    title: 'Landing opened from an invite link (/?room=KXQR): Join that room is the main button',
    make: () => ({ landing: { form: { name: 'Mia', room: 'KXQR', invite: 'KXQR' } } }),
  },
  'landing-invite-held': {
    title: 'Invite link to a room this browser already holds a seat in: Rejoin leads, Join is "as a new player"',
    make: () => ({ landing: { form: { name: 'Mia', room: 'KXQR', invite: 'KXQR' }, rejoin: { room: 'KXQR', id: 'p3', token: 'mock-token', name: 'Mia' } } }),
  },
  'briefing-r1': {
    title: 'Round 1 starts: the catastrophe and the bunker as a briefing at the top of the table',
    make: () => {
      const order = ids([0, 1, 2, 3, 4, 5, 6, 7]);
      return { states: [build({
        n: 8, you: 2, host: 0, phase: 'reveal', round: 1, shown: (i) => (i < 1 ? 1 : 0),
        turn: { kind: 'reveal', speakerId: 'p1', order, index: 1, mustReveal: 'profession', hasRevealed: false },
        timer: { label: 'Anna’s speech', ms: 52000 }, mySpecials: [['peek', false], ['plus', false]],
      })] };
    },
  },
  'reveal-offline-speaker': {
    title: 'Round 3: the speaker is offline (host view: Next is the main button and says so)',
    make: () => {
      const order = ids([0, 1, 2, 3, 4, 5, 6, 7]);
      return { states: [build({
        n: 8, you: 0, host: 0, phase: 'reveal', round: 3, shown: (i) => (i < 3 ? 3 : 2), offline: [3],
        turn: { kind: 'reveal', speakerId: 'p3', order, index: 3, mustReveal: null, hasRevealed: false },
        timer: { label: 'Marta’s speech', ms: 21000 }, mySpecials: [['peek', false], ['plus', false]],
      })] };
    },
  },
  'track-after-leave': {
    title: '6 players, one left in round 1: the round track projects the votes (round 5 has none now)',
    make: () => {
      const order = ids([0, 1, 2, 3, 5]);
      return { states: [build({
        n: 6, you: 0, host: 0, phase: 'reveal', round: 3, status: { 4: 'left' }, shown: (i) => (i === 4 ? 1 : i < 1 ? 3 : 2),
        turn: { kind: 'reveal', speakerId: 'p1', order, index: 1, mustReveal: null, hasRevealed: false },
        timer: { label: 'Anna’s speech', ms: 25000 }, mySpecials: [['peek', false], ['plus', false]],
      })] };
    },
  },
  resuming: { title: 'Reconnecting screen on reload', make: () => ({ landing: { screen: 'resuming', identity: { room: 'KXQR', id: 'p0', token: 'x', name: 'Alex' } } }) },
  replaced: { title: 'This seat was opened in another tab', make: () => ({ landing: { screen: 'replaced', identity: { room: 'KXQR', id: 'p0', token: 'x', name: 'Alex' } } }) },
  'lobby-host': {
    title: 'Lobby, host view: 5 players (one offline), 1 spectator',
    make: () => ({ states: [build({ n: 5, you: 0, host: 0, phase: 'lobby', offline: [2], spectators: [{ id: 's1', name: 'Grandma Zoya', connected: true }] })] }),
  },
  'lobby-guest': {
    title: 'Lobby, guest view',
    make: () => ({ states: [build({ n: 5, you: 1, host: 0, phase: 'lobby', offline: [2], spectators: [{ id: 's1', name: 'Grandma Zoya', connected: true }] })] }),
  },
  'lobby-spectator': {
    title: 'Lobby, spectator view (can take a seat)',
    make: () => ({ states: [build({ n: 3, you: 0, host: 0, phase: 'lobby', youSpectator: { id: 's1', name: 'Grandma Zoya' }, spectators: [{ id: 's1', name: 'Grandma Zoya', connected: true }] })] }),
  },
  'vote-16': {
    title: '16 players, round 3 vote (everyone alive), host view: 15 names to pick; on a short laptop screen the table stays in view',
    make: () => {
      const all = [...Array(16).keys()];
      return { states: [build({
        n: 16, you: 0, host: 0, phase: 'vote', round: 3, shown: () => 3, mySpecials: [['cancel', false], ['trade', false]],
        vote: { stage: 'main', ballot: 1, ballots: 2, candidates: ids(all), voters: ids(all), voted: ids(all.slice(2)) }, kicksThisStep: 2,
      })] };
    },
  },
  'lobby-16': {
    title: 'Full lobby: 16 players + 3 spectators, host view',
    make: () => ({ states: [build({ n: 16, you: 0, host: 0, phase: 'lobby', offline: [6, 11], spectators: [{ id: 's1', name: 'Grandma Zoya', connected: true }, { id: 's2', name: 'Uncle Fyodor', connected: false }, { id: 's3', name: 'Neighbour', connected: true }] })] }),
  },
  'reveal-myturn': {
    title: 'Round 1, 12 players, my turn: must reveal Profession',
    make: () => {
      const order = ids([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      return { states: [build({
        n: 12, you: 4, host: 0, phase: 'reveal', round: 1, shown: (i) => (i < 4 ? 1 : 0), offline: [10],
        turn: { kind: 'reveal', speakerId: 'p4', order, index: 4, mustReveal: 'profession', hasRevealed: false },
        timer: { label: 'Dmitri’s speech', ms: 47000 }, mySpecials: [['peek', false], ['immunity', false]],
      })] };
    },
  },
  'reveal-other': {
    title: 'Round 3, someone else speaking, my specials playable',
    make: () => {
      const order = ids([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
      const base = {
        n: 12, you: 0, host: 1, phase: 'reveal', round: 3, status: { 9: 'ejected' }, offline: [10],
        played: { 0: ['double'], 1: ['immunity'], 9: ['cancel'] }, mySpecials: [['force', false], ['double', true]],
        voteMods: { immune: ['p1'] },
        lastVoteResult: { stage: 'main', tally: tally([[9, [1, 4, 6, 8, 11]], [7, [2, 3, 10]], [3, [0, 5]], [0, [7]], [1, []], [2, []], [4, []], [5, []], [6, []], [8, []], [10, []], [11, []]]), ejectedId: 'p9', tie: null, random: false, cancelled: false },
        events: { 2: [['vote', 'Vote 1 of 1: who stays outside?'], ['eject', 'Pavel was voted out with 5 votes.']], 3: [['special', 'Anna played «Untouchable»: nobody can vote against her in the next vote.']] },
        timer: { label: 'Katya’s speech', ms: 18000 },
      };
      const before = build({ ...base, shown: (i) => (i <= 5 ? 3 : 2), turn: { kind: 'reveal', speakerId: 'p6', order, index: 6, mustReveal: null, hasRevealed: false } });
      const after = build({ ...base, shown: (i) => (i <= 6 ? 3 : 2), turn: { kind: 'reveal', speakerId: 'p6', order, index: 6, mustReveal: null, hasRevealed: true } });
      return { states: [before, after] };
    },
  },
  'discussion-host': {
    title: 'Round 4 discussion, 16 players, host view (Next → start vote)',
    make: () => ({ states: [build({
      n: 16, you: 0, host: 0, phase: 'discussion', round: 4, status: { 13: 'ejected', 5: 'ejected' }, offline: [11],
      shown: (i) => ({ 13: 2, 5: 3 }[i] ?? 4), played: { 1: ['immunity'], 3: ['double'], 8: ['block'], 13: ['plus'] },
      voteMods: { immune: ['p1'], blocked: ['p7'], doubleVote: ['p3'] }, mySpecials: [['cancel', false], ['feature', false]],
      timer: { label: 'Discussion', ms: 64000 },
      lastVoteResult: { stage: 'main', tally: tally([[5, [0, 2, 4, 6, 9, 12]], [8, [1, 3, 7]], [11, [8, 10]], [2, [5, 14]], [15, [11]], [0, []], [1, []], [3, []], [4, []], [6, []], [7, []], [9, []], [10, []], [12, []], [14, []]]), ejectedId: 'p5', tie: null, random: false, cancelled: false },
      events: { 2: [['eject', 'Gleb was voted out with 7 votes.']], 3: [['eject', 'Sasha was voted out with 6 votes.']], 4: [['special', 'Anna played «Untouchable».'], ['special', 'Marta played «Loud voice»: her vote counts twice.'], ['special', 'Lena played «Gag order» on Boris: he cannot vote.'], ['system', 'Discussion.']] },
    })] }),
  },
  vote: {
    title: 'Round 6 vote, ballot 1 of 2, immune/blocked/×2 badges, host view',
    make: () => {
      const status = { 13: 'ejected', 5: 'ejected', 14: 'ejected', 9: 'ejected' };
      const alive = [0, 1, 2, 3, 4, 6, 7, 8, 10, 11, 12, 15];
      return { states: [build({
        n: 16, you: 0, host: 0, phase: 'vote', round: 6, status, offline: [11],
        shown: (i) => ({ 13: 2, 5: 3, 14: 4, 9: 5 }[i] ?? 6), played: { 1: ['immunity'], 3: ['double'], 8: ['block'], 13: ['plus'], 0: ['trade'] },
        voteMods: { immune: ['p1'], blocked: ['p2'], doubleVote: ['p3'] }, mySpecials: [['cancel', false], ['trade', true]],
        vote: { stage: 'main', ballot: 1, ballots: 2, candidates: ids(alive.filter((i) => i !== 1)), voters: ids(alive.filter((i) => i !== 2)), voted: ids([3, 4, 6, 7, 8, 10]) },
        kicksThisStep: 2,
        lastVoteResult: { stage: 'main', tally: tally([[9, [1, 4, 6, 8, 12]], [7, [9, 10, 11]], [15, [0, 2]], [3, [7, 15], 3], [0, []], [1, []], [2, []], [4, []], [6, []], [8, []], [10, []], [11, []], [12, []]]), ejectedId: 'p9', tie: null, random: false, cancelled: false },
        events: { 2: [['eject', 'Gleb was voted out.']], 3: [['eject', 'Sasha was voted out.']], 4: [['eject', 'Zoya was voted out.']], 5: [['eject', 'Pavel was voted out with 5 votes.']], 6: [['vote', 'Vote 1 of 2: who stays outside?']] },
      })] };
    },
  },
  defense: {
    title: 'Tie → defense: my defense speech (Boris vs Lena)',
    make: () => ({ states: [build({
      n: 16, you: 7, host: 0, phase: 'defense', round: 5, status: { 13: 'ejected', 5: 'ejected', 14: 'ejected' },
      shown: (i) => ({ 13: 2, 5: 3, 14: 4 }[i] ?? 5), played: { 1: ['immunity'], 3: ['double'] }, mySpecials: [['protect', false], ['peek', true]],
      turn: { kind: 'defense', speakerId: 'p7', order: ['p7', 'p8'], index: 0, mustReveal: null, hasRevealed: false },
      timer: { label: 'Boris’s defense', ms: 21000 }, kicksThisStep: 1,
      lastVoteResult: { stage: 'main', tally: tally([[7, [1, 3, 10, 12]], [8, [2, 4, 6, 11]], [0, [9]], [15, [7, 8]], [1, []], [2, []], [3, []], [4, []], [6, []], [9, []], [10, []], [11, []], [12, []]]), ejectedId: null, tie: ['p7', 'p8'], random: false, cancelled: false },
      events: { 5: [['vote', 'Vote 1 of 1: who stays outside?'], ['vote', 'Tie between Boris and Lena (4 votes each). Defense speeches, then a revote.']] },
    })] }),
  },
  revote: {
    title: 'Revote between the tied players, I already voted, host view',
    make: () => {
      const alive = [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 15];
      return { states: [build({
        n: 16, you: 0, host: 0, phase: 'vote', round: 5, status: { 13: 'ejected', 5: 'ejected', 14: 'ejected' },
        shown: (i) => ({ 13: 2, 5: 3, 14: 4 }[i] ?? 5), played: { 1: ['immunity'], 3: ['double'] }, mySpecials: [['protect', false], ['peek', false]],
        vote: { stage: 'revote', ballot: 1, ballots: 1, candidates: ['p7', 'p8'], voters: ids(alive), voted: ids([0, 1, 3, 9, 12]) },
        myVote: 'p8', kicksThisStep: 1,
        lastVoteResult: { stage: 'main', tally: tally([[7, [1, 3, 10, 12]], [8, [2, 4, 6, 11]], [0, [9]], [15, [7, 8]], [1, []], [2, []], [3, []], [4, []], [6, []], [9, []], [10, []], [11, []], [12, []]]), ejectedId: null, tie: ['p7', 'p8'], random: false, cancelled: false },
        events: { 5: [['vote', 'Tie between Boris and Lena. Defense speeches, then a revote.'], ['info', 'Revote: Boris or Lena.']] },
      })] };
    },
  },
  'special-picker': {
    title: 'Special card play flow opened: choose a target',
    make: () => ({ states: [pickerBase()], ui: { picker: { uid: 'sp-0-0', targetId: null, category: null } } }),
  },
  'special-category': {
    title: 'Special card play flow: category step (only the target’s hidden cards)',
    make: () => ({ states: [pickerBase()], ui: { picker: { uid: 'sp-0-0', targetId: 'p3', category: null } } }),
  },
  'special-confirm': {
    title: 'Special card play flow: confirm step',
    make: () => ({ states: [pickerBase()], ui: { picker: { uid: 'sp-0-0', targetId: 'p3', category: 'health' } } }),
  },
  'ejected-view': {
    title: 'I was ejected: watching, my cards stay private',
    make: () => ({ states: [build({
      n: 12, you: 2, host: 0, phase: 'reveal', round: 5, status: { 9: 'ejected', 6: 'ejected', 2: 'ejected' }, offline: [4],
      shown: (i) => ({ 9: 2, 6: 3, 2: 4 }[i] ?? (i >= 5 ? 5 : 4)), played: { 2: ['airlock'], 0: ['feature'] }, mySpecials: [['airlock', true], ['peek', false]],
      turn: { kind: 'reveal', speakerId: 'p5', order: ids([0, 1, 3, 4, 5, 7, 8, 10, 11]), index: 4, mustReveal: null, hasRevealed: false },
      timer: { label: 'Sasha’s speech', ms: 25000 }, canPlay: false, extraFeatures: ['Library with 300 books'],
      notes: [{ ts: Date.now() - 600000, text: 'Round 3 — you peeked at Katya’s Health: Missing left hand.' }],
      lastVoteResult: { stage: 'revote', tally: tally([[2, [0, 1, 5, 8, 11]], [7, [3, 4, 10]]]), ejectedId: 'p2', tie: null, random: false, cancelled: false },
      events: { 2: [['eject', 'Pavel was voted out.']], 3: [['eject', 'Katya was voted out.'], ['special', '🚪 Ivan started cycling the airlock on Alex. If one more Airlock card is played on Alex before this round\'s discussion ends, Alex is out — no vote.'], ['special', '🚪 The airlock on Alex jammed — nobody closed it.']], 4: [['eject', 'Ivan was voted out in the revote.']] },
    })] }),
  },
  spectator: {
    title: 'Spectator during a game: public information only',
    make: () => ({ states: [build({
      n: 8, you: 0, host: 0, phase: 'discussion', round: 3, offline: [5], shown: () => 3, played: { 4: ['feature'] },
      youSpectator: { id: 's2', name: 'Grandma Zoya' }, spectators: [{ id: 's1', name: 'Uncle Fyodor', connected: true }, { id: 's2', name: 'Grandma Zoya', connected: true }],
      timer: { label: 'Discussion', ms: 51000 }, extraFeatures: ['Library with 300 books'],
      events: { 3: [['special', 'Dmitri played «Hidden room»: the bunker gained “Library with 300 books”.']] },
    })] }),
  },
  final: {
    title: 'Final screen: in the bunker vs stayed in the forest, all cards revealed',
    make: () => {
      const status = { 9: 'ejected', 5: 'ejected', 8: 'left', 11: 'ejected', 2: 'ejected', 6: 'ejected' };
      const shownPre = (i) => ({ 9: 2, 5: 3, 8: 3, 11: 4, 2: 5, 6: 6 }[i] ?? 7);
      const spec = {
        n: 12, you: 0, host: 0, round: 7, status, played: { 0: ['immunity', 'trade'], 1: ['double'], 3: ['peek'], 6: ['cancel'], 10: ['block'] },
        mySpecials: [['immunity', true], ['trade', true]], shown: shownPre, offline: [7],
        lastVoteResult: { stage: 'main', tally: tally([[6, [0, 1, 3, 4, 7]], [10, [6]], [0, []], [1, []], [3, []], [4, []], [7, []]]), ejectedId: 'p6', tie: null, random: false, cancelled: false },
        events: { 2: [['eject', 'Pavel was voted out.']], 3: [['info', 'Lena left the game.'], ['eject', 'Sasha was voted out.']], 4: [['eject', 'Yuri was voted out.']], 5: [['eject', 'Ivan was voted out.']], 7: [['eject', 'Katya was voted out with 5 votes.'], ['system', 'The bunker doors close. 6 players are inside.']] },
      };
      const pre = build({ ...spec, phase: 'vote', status: { ...status, 6: 'alive' }, vote: { stage: 'main', ballot: 1, ballots: 1, candidates: ids([0, 1, 3, 4, 6, 7, 10]), voters: ids([0, 1, 3, 4, 6, 7, 10]), voted: [] } });
      const fin = build({ ...spec, phase: 'final', final: { survivors: ids([0, 1, 3, 4, 7, 10]), out: ids([2, 5, 6, 8, 9, 11]) } });
      for (const p of fin.players) p.revealedCount = shownPre(p.seat);
      const order = revealOrder(0);
      for (const c of CAT_IDS) fin.me.cards[c].revealed = order.indexOf(c) < 7;
      return { states: [pre, fin] };
    },
  },
  'final-airlock': {
    title: 'Final sealed by an airlock (two Airlocks on Ivan in round 7): the banner says so, the round-6 vote is an "Earlier vote"',
    make: () => {
      const spec = {
        n: 4, you: 1, host: 0, round: 7, status: { 3: 'ejected', 2: 'ejected' }, played: { 0: ['airlock'], 1: ['airlock'] }, shown: () => 6,
        mySpecials: [['airlock', true], ['plus', false]],
        lastVoteResult: { stage: 'main', tally: tally([[3, [0, 1, 2]], [2, [3]], [0, []], [1, []]]), ejectedId: 'p3', tie: null, random: false, cancelled: false },
        events: { 6: [['eject', 'Marta is ejected and stays in the forest']], 7: [['special', '🚪 Alex started cycling the airlock on Ivan. If one more Airlock card is played on Ivan before this round\'s discussion ends, Ivan is out — no vote.'], ['eject', '🚪 Anna sealed the airlock with Alex — Ivan is thrown out of the bunker, no vote!'], ['system', 'The bunker door closes. In the bunker: Alex, Anna. Stayed in the forest: Ivan, Marta.']] },
      };
      const pre = build({ ...spec, phase: 'reveal', status: { 3: 'ejected' }, played: { 0: ['airlock'] }, mySpecials: [['airlock', false], ['plus', false]], airlocks: [[2, [0]]], turn: { kind: 'reveal', speakerId: 'p0', order: ids([0, 1, 2]), index: 0, mustReveal: null, hasRevealed: true }, timer: { label: 'Alex’s speech', ms: 20000 } });
      const fin = build({ ...spec, phase: 'final', final: { survivors: ids([0, 1]), out: ids([2, 3]) } });
      return { states: [pre, fin] };
    },
  },
  'rules-sheet': {
    title: 'The "How to play" sheet (header Rules button), over a round-2 reveal',
    make: () => ({ ...SCENARIOS['reveal-4'].make(), ui: { rules: true } }),
  },
  'reveal-4': {
    title: '4 players, round 2 (descending order), another player speaking',
    make: () => ({ states: [build({
      n: 4, you: 1, host: 0, phase: 'reveal', round: 2, shown: (i) => (i === 3 ? 2 : 1), mySpecials: [['block', false], ['plus', false]],
      turn: { kind: 'reveal', speakerId: 'p2', order: ids([3, 2, 1, 0]), index: 1, mustReveal: null, hasRevealed: false },
      timer: { label: 'Ivan’s speech', ms: 4000 },
    })] }),
  },
  reconnecting: {
    title: 'Connection dropped: banner + disabled actions while it reconnects',
    make: () => ({ ...SCENARIOS['reveal-other'].make(), ui: { mockConn: 'waiting' } }),
  },
  'error-toast': {
    title: 'An error toast over the vote screen',
    make: () => ({ ...SCENARIOS.vote.make(), ui: { toasts: [{ kind: 'error', code: 'not_allowed', message: 'You cannot vote for yourself.' }] } }),
  },
  overtime: {
    title: 'Overtime discussion after a cancelled round-7 vote',
    make: () => ({ states: [build({
      n: 10, you: 3, host: 0, phase: 'discussion', round: 7, overtime: true, status: { 2: 'ejected', 5: 'ejected', 7: 'ejected', 9: 'left' },
      shown: (i) => ({ 2: 3, 5: 4, 7: 5, 9: 5 }[i] ?? 7), played: { 4: ['cancel'] }, mySpecials: [['plus', false], ['peek', true]],
      timer: { label: 'Overtime discussion', ms: 80000 },
      lastVoteResult: { stage: 'main', tally: [], ejectedId: null, tie: null, random: false, cancelled: true },
      events: { 7: [['special', 'Dmitri played «Power outage»: the vote is cancelled.'], ['system', 'Overtime: one more discussion and vote.']] },
    })] }),
  },
};
Object.assign(SCENARIOS, {
  'reveal-myturn-r3': {
    title: 'Round 3, 16 players, my turn (the host is speaking): pick any hidden card; Next is toned down',
    make: () => {
      const order = ids([0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 14, 15]);
      return { states: [build({
        n: 16, you: 0, host: 0, phase: 'reveal', round: 3, status: { 5: 'ejected', 13: 'ejected' }, shown: (i) => ({ 5: 2, 13: 2 }[i] ?? 2),
        played: { 1: ['immunity'], 13: ['plus'] }, mySpecials: [['feature', false], ['double', false]],
        turn: { kind: 'reveal', speakerId: 'p0', order, index: 0, mustReveal: null, hasRevealed: false },
        timer: { label: 'Alex’s speech', ms: 26000 },
        lastVoteResult: { stage: 'main', tally: tally([[13, [0, 2, 4, 6, 9, 12, 15]], [8, [1, 3, 7, 11]], [2, [5, 14]], [0, [8, 10, 13]]]), ejectedId: 'p13', tie: null, random: false, cancelled: false },
      })] };
    },
  },
  'vote-voted': {
    title: 'Round 6 vote after I voted (green “You voted” state), host view',
    make: () => {
      const sc = SCENARIOS.vote.make();
      const st = sc.states[0];
      st.me.myVote = 'p4';
      st.vote.voted = [...st.vote.voted.filter((x) => x !== 'p0'), 'p0'];
      return sc;
    },
  },
  'last-vote-fresh': {
    title: 'Round 5 reveals right after a vote: who voted for whom stays open',
    make: () => {
      const base = {
        n: 16, you: 3, host: 0, round: 4, status: { 13: 'ejected', 5: 'ejected' }, shown: (i) => ({ 13: 2, 5: 3 }[i] ?? 4),
        played: { 1: ['immunity'] }, mySpecials: [['peek', false], ['block', false]],
        lastVoteResult: { stage: 'main', tally: tally([[5, [0, 2, 4, 6, 9, 12]], [8, [1, 3, 7]], [11, [8, 10]], [2, [5, 14]], [15, [11]]]), ejectedId: 'p5', tie: null, random: false, cancelled: false },
      };
      const before = build({ ...base, phase: 'vote', status: { 13: 'ejected' }, kicksThisStep: 1,
        vote: { stage: 'main', ballot: 1, ballots: 1, candidates: ids([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15]), voters: ids([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15]), voted: [] },
        lastVoteResult: null });
      const order = ids([15, 14, 12, 11, 10, 9, 8, 7, 6, 4, 3, 2, 1, 0]);
      const after = build({ ...base, round: 5, phase: 'reveal', turn: { kind: 'reveal', speakerId: 'p15', order, index: 0, mustReveal: null, hasRevealed: false }, timer: { label: 'Maximilian’s speech', ms: 28000 } });
      return { states: [before, after] };
    },
  },
  'final-16': {
    title: 'Final with 16 players: hero banner, panels with full texts, NEW tags, never-played specials',
    make: () => {
      const status = { 13: 'ejected', 5: 'ejected', 14: 'ejected', 9: 'ejected', 2: 'ejected', 7: 'left', 11: 'ejected', 4: 'ejected' };
      const shownPre = (i) => ({ 13: 2, 5: 3, 14: 4, 9: 5, 2: 5, 7: 3, 11: 6, 4: 7 }[i] ?? 7);
      const spec = {
        n: 16, you: 3, host: 0, round: 7, status, shown: shownPre, mySpecials: [['peek', true], ['immunity', false]],
        played: { 0: ['trade'], 1: ['immunity'], 3: ['peek'], 8: ['block', 'double'], 13: ['plus'], 15: ['cancel'] },
        lastVoteResult: { stage: 'revote', tally: tally([[4, [0, 1, 3, 6, 8, 10]], [12, [4, 15, 12]]]), ejectedId: 'p4', tie: null, random: false, cancelled: false },
      };
      const pre = build({ ...spec, phase: 'vote', status: { ...status, 4: 'alive' }, vote: { stage: 'revote', ballot: 2, ballots: 2, candidates: ids([4, 12]), voters: ids([0, 1, 3, 4, 6, 8, 10, 12, 15]), voted: [] } });
      const fin = build({ ...spec, phase: 'final', final: { survivors: ids([0, 1, 3, 6, 8, 10, 12, 15]), out: ids([2, 4, 5, 7, 9, 11, 13, 14]) } });
      for (const p of fin.players) p.revealedCount = shownPre(p.seat);
      const order = revealOrder(3);
      for (const c of CAT_IDS) fin.me.cards[c].revealed = order.indexOf(c) < 7;
      return { states: [pre, fin] };
    },
  },
  flash: {
    title: 'Phone flash: one short notice under the header, leading with the outcome',
    make: () => ({ ...SCENARIOS['reveal-other'].make(), ui: { toasts: [{ kind: 'info', code: 'special', message: 'Anna played “Spy” → Anna secretly looked at one of Boris’s hidden cards' }] } }),
  },
  'cards-view': {
    title: 'Desktop “Cards” view of the table (one panel per player), round 4 discussion',
    make: () => ({ ...SCENARIOS['discussion-host'].make(), ui: { view: 'cards' } }),
  },
});
// SPEC §11 X1 / X3 / X4 (owner features): airlocks, card popovers, the lobby's estimated game length.
const AIR_OPEN = 'If one more Airlock card is played on';
const cardLine = (r, who, key, result) => `Round ${r} — ${who} played “${SPECIALS[key].title}”: ${SPECIALS[key].text} → ${result}`;
function airlockOpenBase(extra = {}) {
  return build({
    n: 8, you: 4, host: 0, phase: 'discussion', round: 3, shown: (i) => (i === 3 ? 2 : 3), offline: [6],
    played: { 1: ['airlock'], 2: ['peek'] }, mySpecials: [['airlock', false], ['peek', false]],
    airlocks: [[3, [1]]], timer: { label: 'Discussion', ms: 66000 },
    events: { 2: [['special', cardLine(2, 'Ivan', 'peek', 'Ivan secretly looked at one of Katya\u2019s hidden cards')]],
      3: [['system', 'Round 3 — discussion (no vote this round)'], ['special', `🚪 Anna started cycling the airlock on Marta. ${AIR_OPEN} Marta before this round's discussion ends, Marta is out — no vote.`]] },
    ...extra,
  });
}
Object.assign(SCENARIOS, {
  'airlock-open': {
    title: 'Airlock: Anna opened one on Marta (1/2); I hold an unused Airlock, so the card, the alert and the bar say "join"',
    make: () => ({ states: [airlockOpenBase()] }),
  },
  'airlock-picker': {
    title: 'Airlock: my Airlock\u2019s target step, Marta (open airlock) first and marked "join"',
    make: () => ({ states: [airlockOpenBase()], ui: { picker: { uid: 'sp-4-0', targetId: null, category: null } } }),
  },
  'airlock-confirm': {
    title: 'Airlock: confirm step on Marta: closing the airlock throws her out, with no vote',
    make: () => ({ states: [airlockOpenBase()], ui: { picker: { uid: 'sp-4-0', targetId: 'p3', category: null } } }),
  },
  'airlock-self': {
    title: 'Airlock: I opened one on Sasha this round (and Katya opened one on Ivan), host view, round 4 reveals',
    make: () => {
      const order = ids([7, 6, 5, 4, 3, 2, 1, 0]);
      return { states: [build({
        n: 8, you: 0, host: 0, phase: 'reveal', round: 4, shown: (i) => (i >= 5 ? 4 : 3), canPlay: false,
        played: { 0: ['airlock'], 6: ['airlock'], 3: ['immunity'] }, mySpecials: [['airlock', true], ['protect', false]],
        airlocks: [[5, [0]], [2, [6]]], voteMods: { immune: ['p3'] },
        turn: { kind: 'reveal', speakerId: 'p4', order, index: 3, mustReveal: null, hasRevealed: false }, timer: { label: 'Dmitri’s speech', ms: 19000 },
        events: { 4: [['special', `🚪 Alex started cycling the airlock on Sasha. ${AIR_OPEN} Sasha before this round's discussion ends, Sasha is out — no vote.`],
          ['special', `🚪 Katya started cycling the airlock on Ivan. ${AIR_OPEN} Ivan before this round's discussion ends, Ivan is out — no vote.`]] },
      })] };
    },
  },
  'airlock-on-me': {
    title: 'Airlock: the airlock is cycling on me (phone first: the alert and the bar say so)',
    make: () => ({ states: [build({
      n: 6, you: 2, host: 0, phase: 'discussion', round: 5, shown: () => 4, played: { 4: ['airlock'] }, mySpecials: [['revive', false], ['double', false]],
      airlocks: [[2, [4]]], timer: { label: 'Discussion', ms: 51000 },
      events: { 5: [['special', `🚪 Dmitri started cycling the airlock on Ivan. ${AIR_OPEN} Ivan before this round's discussion ends, Ivan is out — no vote.`]] },
    })] }),
  },
  'tooltip-log': {
    title: 'A special card named in the log: its chip opened (tap/hover) shows the card text',
    make: () => ({
      states: [build({
        n: 8, you: 0, host: 0, phase: 'discussion', round: 3, shown: () => 3, played: { 1: ['immunity'], 5: ['trade'], 2: ['airlock'] },
        mySpecials: [['block', false], ['plus', false]], voteMods: { immune: ['p1'] }, timer: { label: 'Discussion', ms: 40000 },
        events: { 2: [['special', cardLine(2, 'Sasha', 'trade', 'Sasha and Katya swapped Baggage: Sasha now has “Axe”, Katya now has “Water filter”')]],
          3: [['special', cardLine(3, 'Anna', 'immunity', 'nobody can vote against Anna in the next vote')],
            ['special', `🚪 Ivan started cycling the airlock on Boris. ${AIR_OPEN} Boris before this round's discussion ends, Boris is out — no vote.`],
            ['special', '🚪 The airlock on Boris jammed — nobody closed it.']] },
      })],
      ui: { pop: '[data-testid="log"] [data-testid="card-chip"][data-title="Untouchable"]' },
    }),
  },
  'tooltip-board': {
    title: 'A played special on the table: its chip opened shows who played it and the card text',
    make: () => ({ ...SCENARIOS['discussion-host'].make(), ui: { pop: '[data-testid="player-card"][data-player-id="p8"] [data-testid="card-chip"]' } }),
  },
  'tooltip-cell': {
    title: 'A revealed card cut off by the table: tapped or hovered, the whole text floats over it',
    make: () => ({ ...SCENARIOS['discussion-host'].make(), ui: { pop: '@clamped' } }),
  },
  'tooltip-reveal': {
    title: 'The bar names the card just revealed, shortened on a phone: tapped or hovered, the whole text opens',
    make: () => {
      const order = ids([0, 1, 2, 3, 4, 5, 6, 7]);
      return {
        states: [build({
          n: 8, you: 0, host: 1, phase: 'reveal', round: 3, rp: true, shown: (i) => (i <= 2 ? 3 : 2), mySpecials: [['peek', false], ['plus', false]],
          cardText: { 2: { [revealOrder(2)[2]]: 'Chronic back pain from twenty years of carrying pianos up staircases: manageable with daily stretching, a hard mattress and a steady supply of strong painkillers' } },
          turn: { kind: 'reveal', speakerId: 'p2', order, index: 2, mustReveal: null, hasRevealed: true }, timer: { label: 'Ivan’s speech', ms: 24000 },
        })],
        ui: { pop: '.bar [data-pop="clamp"]' },
      };
    },
  },
  'final-specials': {
    title: 'Final: played and never-played specials as chips; a never-played Back from the Forest opened',
    make: () => {
      const status = { 9: 'ejected', 5: 'ejected', 8: 'left', 11: 'ejected', 2: 'ejected', 6: 'ejected' };
      const shownPre = (i) => ({ 9: 2, 5: 3, 8: 3, 11: 4, 2: 5, 6: 6 }[i] ?? 7);
      const spec = {
        n: 12, you: 3, host: 0, round: 7, status, shown: shownPre, mySpecials: [['peek', true], ['revive', false]],
        played: { 0: ['immunity', 'trade'], 1: ['airlock'], 3: ['peek'], 6: ['cancel'], 7: ['airlock'], 10: ['block'] },
        unplayed: { 3: ['revive'], 4: ['revive', 'feature'], 10: ['airlock'] },
        lastVoteResult: { stage: 'main', tally: tally([[6, [0, 1, 3, 4, 7]], [10, [6]], [0, []], [1, []], [3, []], [4, []], [7, []]]), ejectedId: 'p6', tie: null, random: false, cancelled: false },
        events: { 5: [['eject', '🚪 Boris sealed the airlock with Anna — Ivan is thrown out of the bunker, no vote!']], 7: [['eject', 'Katya was voted out with 5 votes.'], ['system', 'The bunker door closes. 6 players are inside.']] },
      };
      const pre = build({ ...spec, phase: 'vote', status: { ...status, 6: 'alive' }, vote: { stage: 'main', ballot: 1, ballots: 1, candidates: ids([0, 1, 3, 4, 6, 7, 10]), voters: ids([0, 1, 3, 4, 6, 7, 10]), voted: [] } });
      const fin = build({ ...spec, phase: 'final', final: { survivors: ids([0, 1, 3, 4, 7, 10]), out: ids([2, 5, 6, 8, 9, 11]) } });
      for (const p of fin.players) p.revealedCount = shownPre(p.seat);
      return { states: [pre, fin], ui: { pop: '[data-player-id="p4"] [data-testid="card-chip"].unplayed' } };
    },
  },
  'airlock-on-me-picker': {
    title: 'Airlock: it is cycling on me and I open my own Airlock: the picker says mine cannot close it (not "nobody started one")',
    make: () => ({ states: [build({
      n: 6, you: 2, host: 0, phase: 'discussion', round: 5, shown: () => 4, played: { 4: ['airlock'] }, mySpecials: [['airlock', false], ['double', false]],
      airlocks: [[2, [4]]], timer: { label: 'Discussion', ms: 51000 },
      events: { 5: [['special', `🚪 Dmitri started cycling the airlock on Ivan. ${AIR_OPEN} Ivan before this round's discussion ends, Ivan is out — no vote.`]] },
    })], ui: { picker: { uid: 'sp-2-0', targetId: null, category: null } } }),
  },
  'airlock-join-alert': {
    title: 'Airlock: "Join: throw Marta out" in the alert opens the picker on Confirm for Marta (Back to change)',
    make: () => ({ states: [airlockOpenBase()], ui: { picker: { uid: 'sp-4-0', targetId: 'p3', category: null } } }),
  },
  'host-offline': {
    title: 'Round 4 discussion, the host is offline: the bar says the role passes on by itself (not "Alex moves on with Next")',
    make: () => ({ states: [build({
      n: 7, you: 3, host: 0, phase: 'discussion', round: 4, shown: () => 4, offline: [0], mySpecials: [['peek', false], ['plus', false]],
      timer: { label: 'Discussion', ms: 40000 },
    })] }),
  },
  'hostile-names': {
    title: 'Final, spectator: names with 🚪 and quoted titles stay names (no airlock styling, no chips, the banner names the vote)',
    make: () => {
      const names = { 1: '🚪 Rex', 2: '"Airlock"', 3: 'played “Alibi”: a →', 4: '«Spy» Anna' };
      const n3 = names[3];
      const spec = {
        n: 5, names, youSpectator: { id: 's1', name: 'Watcher' }, spectators: [{ id: 's1', name: 'Watcher', connected: true }], host: 0, round: 7,
        status: { 1: 'ejected', 2: 'ejected', 3: 'ejected' }, shown: () => 6, played: { 0: ['airlock'], 3: ['peek'], 4: ['airlock'] }, rp: true,
        lastVoteResult: { stage: 'main', tally: tally([[1, [0, 4]], [0, [1]], [4, []]]), ejectedId: 'p1', tie: null, random: false, cancelled: false },
        events: {
          2: [['special', `Round 2 — ${n3} played “${SPECIALS.peek.title}”: ${SPECIALS.peek.text} → ${n3} secretly looked at one of Alex's hidden cards`]],
          5: [['special', `🚪 Alex started cycling the airlock on "Airlock". ${AIR_OPEN} "Airlock" before this round's discussion ends, "Airlock" is out — no vote.`],
            ['eject', '🚪 «Spy» Anna sealed the airlock with Alex — "Airlock" is thrown out of the bunker, no vote!']],
          6: [['vote', `Round 6 — vote 1 of 1: ${n3} 3 (Alex, 🚪 Rex, «Spy» Anna); Alex 0; 🚪 Rex 0; «Spy» Anna 0`], ['eject', `${n3} is ejected and stays in the forest`]],
          7: [['vote', 'Round 7 — vote 1 of 1: 🚪 Rex 2 (Alex, «Spy» Anna); Alex 1 (🚪 Rex); «Spy» Anna 0'], ['eject', '🚪 Rex is ejected and stays in the forest'],
            ['system', `The bunker door closes. In the bunker: Alex, «Spy» Anna. Stayed in the forest: 🚪 Rex, "Airlock", ${n3}.`]],
        },
      };
      const fin = build({ ...spec, phase: 'final', final: { survivors: ids([0, 4]), out: ids([1, 2, 3]) } });
      return { states: [fin] };
    },
  },
  // SPEC §11 (client-fixer f2)
  'airlock-two-joins': {
    title: 'Airlock: two airlocks I can join (Sasha’s opened first, then Marta’s): the picker lists them in that order and says "one of them"',
    make: () => ({ states: [build({
      n: 8, you: 4, host: 0, phase: 'discussion', round: 3, shown: () => 3, played: { 1: ['airlock'], 6: ['airlock'] },
      mySpecials: [['airlock', false], ['peek', false]], airlocks: [[5, [1]], [3, [6]]], timer: { label: 'Discussion', ms: 66000 },
      events: { 3: [['special', `🚪 Anna started cycling the airlock on Sasha. ${AIR_OPEN} Sasha before this round's discussion ends, Sasha is out — no vote.`],
        ['special', `🚪 Katya started cycling the airlock on Marta. ${AIR_OPEN} Marta before this round's discussion ends, Marta is out — no vote.`]] },
    })], ui: { picker: { uid: 'sp-4-0', targetId: null, category: null } } }),
  },
  'airlock-long-name': {
    title: 'Airlock: joining the airlock on a player whose name is 20 emoji, on a phone: Confirm and Join wrap, nothing runs off the screen',
    make: () => ({ states: [airlockOpenBase({ names: { 3: '🦊'.repeat(20) },
      events: { 3: [['special', `🚪 Anna started cycling the airlock on ${'🦊'.repeat(20)}. ${AIR_OPEN} ${'🦊'.repeat(20)} before this round's discussion ends, ${'🦊'.repeat(20)} is out — no vote.`]] } })],
    ui: { picker: { uid: 'sp-4-0', targetId: 'p3', category: null } } }),
  },
  'airlock-spent': {
    title: 'Airlock: 6 players, both Airlocks played (Ivan and Dmitri on each other): nobody can close either, so no "one more and you are out"',
    make: () => ({ states: [build({
      n: 6, you: 2, host: 0, phase: 'discussion', round: 2, shown: () => 2, played: { 2: ['airlock'], 4: ['airlock'] },
      mySpecials: [['airlock', true], ['double', false]], canPlay: false, airlocks: [[4, [2]], [2, [4]]], timer: { label: 'Discussion', ms: 51000 },
      events: { 2: [['special', `🚪 Ivan started cycling the airlock on Dmitri. ${AIR_OPEN} Dmitri before this round's discussion ends, Dmitri is out — no vote.`],
        ['special', `🚪 Dmitri started cycling the airlock on Ivan. ${AIR_OPEN} Ivan before this round's discussion ends, Ivan is out — no vote.`]] },
    })] }),
  },
  'track-history': {
    title: 'Overtime: round 5’s vote was cancelled, round 6 ejected Sasha, round 7’s vote was cancelled: the track shows what happened, not the plan',
    make: () => {
      const rl = (r) => ['system', `Round ${r} of 7 — reveal phase (${r % 2 ? 'ascending' : 'descending'} seat order)`];
      return { states: [build({
        n: 6, you: 0, host: 0, phase: 'discussion', round: 7, overtime: true, shown: () => 6, status: { 5: 'ejected' },
        played: { 1: ['cancel'], 3: ['cancel'] }, mySpecials: [['peek', true], ['plus', false]], kicksThisStep: 2, timer: { label: 'Discussion', ms: 70000 },
        events: {
          1: [rl(1)], 2: [rl(2)], 3: [rl(3)], 4: [rl(4)],
          5: [rl(5), ['system', 'Round 5 — discussion — then a vote: 1 player will stay outside'], ['special', `Round 5 — Anna played “${SPECIALS.cancel.title}”: ${SPECIALS.cancel.text} → the next vote will be cancelled`],
            ['vote', 'Round 5 — the vote is cancelled (a special card); the kick carries over']],
          6: [rl(6), ['system', 'Round 6 — discussion — then a vote: 2 players will stay outside'], ['vote', 'Round 6 — vote: 2 players will stay outside'],
            ['vote', 'Round 6 — vote 1 of 2: Sasha 4 (Alex, Anna, Ivan, Marta); Alex 1 (Sasha)'], ['eject', 'Sasha is ejected and stays in the forest'],
            ['special', `Round 6 — Marta played “${SPECIALS.cancel.title}”: ${SPECIALS.cancel.text} → the rest of the vote is cancelled right now; the kicks still due carry over`]],
          7: [rl(7), ['system', 'Round 7 — discussion — then a vote: 2 players will stay outside'], ['vote', 'Round 7 — the vote is cancelled (a special card); the kicks carry over'],
            ['system', 'Overtime — the bunker is still over capacity (5 players, 3 beds): discuss, then vote again'], ['system', 'Overtime — discussion — then a vote: 2 players will stay outside']],
        },
      })] };
    },
  },
  'lobby-min': {
    title: 'Lobby with 2 of 4 players: the estimate is for 4 players (minimum)',
    make: () => ({ states: [build({ n: 2, you: 0, host: 0, phase: 'lobby' })] }),
  },
  'lobby-relaxed': {
    title: 'Lobby, guest view, 12 players on Relaxed timers: the estimate follows the preset',
    make: () => ({ states: [build({ n: 12, you: 3, host: 0, phase: 'lobby', options: { speechSeconds1: 90, speechSeconds: 45, discussionSeconds: 150, defenseSeconds: 45 } })] }),
  },
  // SPEC §11 X6: the host's End game, armed by a first tap (the note says what it does), and the lobby it leads to
  'end-game-armed': {
    title: 'Host tools: End game armed by a first tap (round 4 discussion): the bar says what a second tap does',
    make: () => ({ ...SCENARIOS['discussion-host'].make(), ui: { armed: 'end-game' } }),
  },
  'lobby-ended': {
    title: 'Lobby right after the host ended a game: a late arrival (spectator) can take a seat',
    make: () => ({ states: [build({ n: 5, you: 0, host: 0, phase: 'lobby', youSpectator: { id: 's1', name: 'Grandma Zoya' }, spectators: [{ id: 's1', name: 'Grandma Zoya', connected: true }],
      extraLog: [['system', 'The game started with 5 players.'], ['info', 'Grandma Zoya joined as a spectator'], ['system', 'The host ended the game'], ['system', 'Back to the lobby — same table, new cards next game']] })] }),
  },
  'lobby-draft': {
    title: 'Lobby, host typing a discussion timer of 300 s (not sent yet): the estimate already follows it',
    make: () => ({ states: [build({ n: 6, you: 0, host: 0, phase: 'lobby' })], ui: { optDraft: { discussionSeconds: 300 } } }),
  },
});
function pickerBase() {
  return build({
    n: 10, you: 0, host: 1, phase: 'discussion', round: 3, shown: (i) => (i === 3 ? 2 : 3), mySpecials: [['force', false], ['trade', false]],
    timer: { label: 'Discussion', ms: 70000 }, offline: [6],
  });
}

export function list() { return Object.entries(SCENARIOS).map(([id, x]) => ({ id, title: x.title })); }
export function scenario(name) { const s = SCENARIOS[name]; return s ? s.make() : null; }

/* ------------------------------------------------------------------ local simulator */
const err = (code, message) => ({ error: { code, message } });
function logPush(s, kind, text) {
  const id = s.log.length ? s.log[s.log.length - 1].id + 1 : 1;
  s.log.push({ id, ts: Date.now(), kind, text });
  if (s.log.length > 200) s.log.shift();
}
function me(s) { return s.players.find((p) => p.id === s.you.id); }
function byId(s, id) { return s.players.find((p) => p.id === id); }
function hiddenOf(p) { return CAT_IDS.filter((c) => p.cards[c] == null); }
function revealFor(s, p, c) {
  p.cards[c] = card(p.seat, c);
  p.revealedCount++;
  if (p.id === s.you.id && s.me) s.me.cards[c].revealed = true;
  logPush(s, 'reveal', `${p.name} revealed ${LABEL[c]}: ${p.cards[c]}`);
}
function startTimer(s, label, sec) { s.timer = { label, endsAt: Date.now() + sec * 1000 }; }
function alive(s) { return s.players.filter((p) => p.status === 'alive'); }
function recomputeSchedule(s) {
  const k = KICKS[s.players.length] || [];
  const out = s.players.length - alive(s).length;
  const cum = k.slice(0, s.round).reduce((a, b) => a + b, 0);
  s.schedule.outCount = out;
  s.schedule.kicksThisStep = s.round < 7 ? Math.max(0, Math.min(cum - out, alive(s).length - s.capacity)) : Math.max(0, alive(s).length - s.capacity);
  s.schedule.nextVoteRound = s.schedule.kicksThisStep > 0 ? s.round : null;
}
function beginRound(s, r) {
  s.round = r;
  s.phase = 'reveal';
  s.vote = null;
  const order = alive(s).map((p) => p.id);
  if (r % 2 === 0) order.reverse();
  s.turn = { kind: 'reveal', speakerId: order[0], order, index: 0, mustReveal: r === 1 ? 'profession' : null, hasRevealed: false };
  if (s.me) s.me.canPlaySpecial = me(s).status === 'alive';
  startTimer(s, `${byId(s, order[0]).name}’s speech`, r === 1 ? s.options.speechSeconds1 : s.options.speechSeconds);
  recomputeSchedule(s);
  logPush(s, 'system', `Round ${r}: reveals.`);
}
// SPEC §11 X1: open airlocks jam when the discussion of their round ends, when their target is out, and at the final
function jamAirlocks(s, onlyGone = false) {
  const keep = [];
  for (const a of s.airlocks || []) {
    const t = byId(s, a.targetId);
    if (onlyGone && t && t.status === 'alive') { keep.push(a); continue; }
    logPush(s, 'special', `🚪 The airlock on ${t ? t.name : '?'} jammed — nobody closed it.`);
  }
  s.airlocks = keep;
}
function toFinal(s) {
  jamAirlocks(s);
  s.phase = 'final';
  s.turn = null; s.vote = null; s.timer = null;
  s.final = { survivors: alive(s).map((p) => p.id), out: s.players.filter((p) => p.status !== 'alive').map((p) => p.id) };
  for (const p of s.players) { for (const c of CAT_IDS) p.cards[c] = card(p.seat, c); p.unplayedSpecials = []; }
  if (s.me) s.me.canPlaySpecial = false;
  s.schedule.kicksThisStep = 0; s.schedule.nextVoteRound = null;
  logPush(s, 'system', `The bunker doors close. ${s.final.survivors.length} players are inside.`);
}
function afterStep(s) {
  s.voteMods = { immune: [], blocked: [], doubleVote: [], cancelNext: false };
  if (alive(s).length <= s.capacity) return toFinal(s);
  if (s.round < 7) return beginRound(s, s.round + 1);
  s.overtime = true; s.phase = 'discussion'; s.vote = null; s.turn = null;
  startTimer(s, 'Overtime discussion', s.options.discussionSeconds);
  recomputeSchedule(s);
}
function openBallot(s, ballot, ballots, stage, candidates) {
  const al = alive(s).map((p) => p.id);
  const cands = candidates || al.filter((id) => !s.voteMods.immune.includes(id));
  const voters = al.filter((id) => !s.voteMods.blocked.includes(id));
  s.phase = 'vote'; s.turn = null; s.timer = null;
  s.vote = { stage, ballot, ballots, candidates: cands, voters, voted: [] };
  if (s.me) s.me.myVote = null;
  s._votes = {};
  logPush(s, 'vote', `${stage === 'revote' ? 'Revote' : 'Vote'} ${ballot} of ${ballots}: who stays outside?`);
}
function closeBallot(s) {
  const v = s.vote;
  const votes = { ...(s._votes || {}) };
  // simulate the missing bots: each votes for the first candidate that is not themself
  for (const id of v.voters) if (!(id in votes) && id !== s.you.id) votes[id] = v.candidates.find((c) => c !== id);
  const t = v.candidates.map((c) => ({ targetId: c, votes: 0, voterIds: [] }));
  for (const [voter, target] of Object.entries(votes)) {
    const row = t.find((x) => x.targetId === target);
    if (row) { row.voterIds.push(voter); row.votes += s.voteMods.doubleVote.includes(voter) ? 2 : 1; }
  }
  t.sort((a, b) => b.votes - a.votes || byId(s, a.targetId).seat - byId(s, b.targetId).seat);
  const top = t[0];
  const tied = t.filter((x) => x.votes === top.votes).map((x) => x.targetId);
  if (tied.length > 1 && v.stage === 'main' && top.votes > 0) {
    s.lastVoteResult = { stage: 'main', tally: t, ejectedId: null, tie: tied, random: false, cancelled: false };
    s.phase = 'defense'; s.vote = null;
    s.turn = { kind: 'defense', speakerId: tied[0], order: tied, index: 0, mustReveal: null, hasRevealed: false };
    s._ballot = { ballot: v.ballot, ballots: v.ballots };
    startTimer(s, `${byId(s, tied[0]).name}’s defense`, s.options.defenseSeconds);
    logPush(s, 'vote', `Tie between ${tied.map((id) => byId(s, id).name).join(' and ')}. Defense speeches, then a revote.`);
    return;
  }
  const random = tied.length > 1 || top.votes === 0;
  const ejected = random ? tied[Math.floor(Math.random() * tied.length)] : top.targetId;
  s.lastVoteResult = { stage: v.stage, tally: t, ejectedId: ejected, tie: tied.length > 1 ? tied : null, random, cancelled: false };
  byId(s, ejected).status = 'ejected';
  logPush(s, 'eject', `${byId(s, ejected).name} was voted out${random ? ' — fate decides' : ` with ${top.votes} votes`}.`);
  if (alive(s).length <= s.capacity) return toFinal(s);
  if (v.ballot < v.ballots) return openBallot(s, v.ballot + 1, v.ballots, 'main');
  afterStep(s);
}
function advanceTurn(s) {
  const t = s.turn;
  let i = t.index + 1;
  while (i < t.order.length && byId(s, t.order[i]).status !== 'alive') i++;
  if (i >= t.order.length) {
    if (t.kind === 'reveal') {
      s.phase = 'discussion'; s.turn = null;
      startTimer(s, 'Discussion', s.options.discussionSeconds);
      recomputeSchedule(s);
      logPush(s, 'system', 'Discussion.');
    } else {
      const b = s._ballot || { ballot: 1, ballots: 1 };
      openBallot(s, b.ballot, b.ballots, 'revote', t.order.filter((id) => byId(s, id).status === 'alive'));
    }
    return;
  }
  t.index = i; t.speakerId = t.order[i]; t.hasRevealed = false;
  const name = byId(s, t.speakerId).name;
  if (t.kind === 'reveal') startTimer(s, `${name}’s speech`, s.round === 1 ? s.options.speechSeconds1 : s.options.speechSeconds);
  else startTimer(s, `${name}’s defense`, s.options.defenseSeconds);
}
function dealFromLobby(s) {
  const n = s.players.length;
  s.capacity = Math.floor(n / 2);
  s.catastrophe = CATASTROPHE; s.bunker = { ...BUNKER, features: [...BUNKER.features] };
  s.schedule = { kicksByRound: KICKS[n] || [], outCount: 0, kicksThisStep: 0, nextVoteRound: null };
  for (const p of s.players) { p.revealedCount = 0; p.specialsLeft = 2; p.playedSpecials = []; for (const c of CAT_IDS) p.cards[c] = null; }
  const mi = me(s);
  if (mi) {
    const mc = {};
    for (const c of CAT_IDS) mc[c] = { text: card(mi.seat, c), revealed: false };
    s.me = { cards: mc, specials: [special('peek', 'sp-a'), special('plus', 'sp-b')], canPlaySpecial: true, notes: [], myVote: null };
  }
  logPush(s, 'system', `The game started with ${n} players. Catastrophe: ${CATASTROPHE.title}. Beds: ${s.capacity}.`);
  beginRound(s, 1);
}

export function handle(msg, current) {
  const s = current ? structuredClone(current) : null;
  const done = () => { s.serverNow = Date.now(); return { state: s }; };
  switch (msg.t) {
    case 'create': case 'resume': return { state: scenario('lobby-host').states[0] };
    case 'join': return { state: scenario(msg.spectator ? 'lobby-spectator' : 'lobby-guest').states[0] };
    case 'leave': return { screen: 'landing', notice: { kind: 'info', text: 'You left room KXQR (mock).' } };
    case 'ping': return { state: current };
    default: break;
  }
  if (!s) return null;
  const mi = me(s);
  switch (msg.t) {
    case 'start':
      if (s.players.length < s.minPlayers) return err('not_allowed', `At least ${s.minPlayers} players are needed to start.`);
      dealFromLobby(s); return done();
    case 'setOptions': Object.assign(s.options, msg.options); return done();
    case 'takeSeat': {
      const sp = s.spectators.find((x) => x.id === s.you.id);
      if (!sp) return err('not_allowed', 'You are already seated.');
      s.spectators = s.spectators.filter((x) => x.id !== sp.id);
      const cards = Object.fromEntries(CAT_IDS.map((c) => [c, null]));
      s.players.push({ id: sp.id, name: sp.name, seat: s.players.length, connected: true, isHost: false, status: 'alive', cards, revealedCount: 0, playedSpecials: [], specialsLeft: 0 });
      s.you.role = 'player';
      logPush(s, 'info', `${sp.name} took a seat.`);
      return done();
    }
    case 'kick': {
      const p = byId(s, msg.playerId);
      if (!p) { s.spectators = s.spectators.filter((x) => x.id !== msg.playerId); return done(); }
      if (s.phase === 'lobby') { s.players = s.players.filter((x) => x !== p); s.players.forEach((x, i) => { x.seat = i; }); }
      else p.status = 'left';
      logPush(s, 'info', `${p.name} was kicked by the host.`);
      if (s.phase !== 'lobby' && s.phase !== 'final' && alive(s).length <= s.capacity) toFinal(s);
      return done();
    }
    case 'transferHost': {
      const p = byId(s, msg.playerId);
      if (!p) return err('not_allowed', 'Unknown player.');
      for (const x of s.players) x.isHost = x === p;
      s.hostId = p.id; s.you.isHost = false;
      logPush(s, 'info', `${p.name} is the host now.`);
      return done();
    }
    case 'reveal': {
      const t = s.turn;
      if (!t || t.speakerId !== s.you.id) return err('not_your_turn', 'It’s not your turn.');
      if (t.hasRevealed || !s.me.cards[msg.category] || s.me.cards[msg.category].revealed) return err('not_allowed', 'You cannot reveal that card now.');
      revealFor(s, mi, msg.category); t.hasRevealed = true; return done();
    }
    case 'endTurn': {
      const t = s.turn;
      if (!t || t.speakerId !== s.you.id) return err('not_your_turn', 'It’s not your turn.');
      advanceTurn(s); return done();
    }
    case 'next': {
      if (!s.you.isHost) return err('not_host', 'Only the host can do that.');
      if (s.phase === 'reveal') {
        const t = s.turn; const sp = byId(s, t.speakerId);
        if (!t.hasRevealed) {
          const hid = t.mustReveal ? [t.mustReveal].filter((c) => sp.cards[c] == null) : hiddenOf(sp);
          if (hid.length) revealFor(s, sp, hid[Math.floor(Math.random() * hid.length)]);
        }
        advanceTurn(s); return done();
      }
      if (s.phase === 'defense') { advanceTurn(s); return done(); }
      if (s.phase === 'vote') { closeBallot(s); return done(); }
      if (s.phase === 'discussion') {
        jamAirlocks(s);
        recomputeSchedule(s);
        const k = s.schedule.kicksThisStep;
        if (k > 0 && s.voteMods.cancelNext) { s.lastVoteResult = { stage: 'main', tally: [], ejectedId: null, tie: null, random: false, cancelled: true }; logPush(s, 'vote', 'The vote was cancelled.'); afterStep(s); return done(); }
        if (k > 0) { openBallot(s, 1, k, 'main'); s.schedule.kicksThisStep = k; return done(); }
        if (s.round >= 7) { toFinal(s); return done(); }
        beginRound(s, s.round + 1); return done();
      }
      return err('wrong_phase', 'Use Start or Play again here.');
    }
    case 'closeVote': if (s.phase !== 'vote') return err('wrong_phase', 'No vote is open.'); closeBallot(s); return done();
    case 'vote': {
      const v = s.vote;
      if (!v || !v.voters.includes(s.you.id)) return err('not_allowed', 'You cannot vote now.');
      if (msg.targetId === s.you.id) return err('not_allowed', 'You cannot vote for yourself.');
      if (!v.candidates.includes(msg.targetId)) return err('not_allowed', 'That player cannot be voted for.');
      s._votes = s._votes || {};
      s._votes[s.you.id] = msg.targetId;
      s.me.myVote = msg.targetId;
      if (!v.voted.includes(s.you.id)) v.voted.push(s.you.id);
      return done();
    }
    case 'special': {
      const sp = s.me && s.me.specials.find((x) => x.uid === msg.uid);
      if (!sp || sp.used) return err('not_allowed', 'That special cannot be played.');
      if (!s.me.canPlaySpecial) return err('not_allowed', 'You already played a special this round.');
      sp.used = true; s.me.canPlaySpecial = false;
      mi.playedSpecials.push({ title: sp.title, text: sp.text }); mi.specialsLeft--;
      const target = msg.targetId ? byId(s, msg.targetId) : null;
      logPush(s, 'special', `Round ${s.round} — ${mi.name} played “${sp.title}”: ${sp.text} → ${target ? `on ${target.name}` : 'done'} (mock)`);
      const cat = sp.category === 'choose' ? msg.category : sp.category === 'random' && target ? hiddenOf(target)[0] : sp.category;
      switch (sp.effect) {
        case 'force_reveal': if (target && cat) revealFor(s, target, cat); break;
        case 'peek': if (target && cat) s.me.notes.push({ ts: Date.now(), text: `You peeked at ${target.name}’s ${LABEL[cat]}: ${card(target.seat, cat)}` }); break;
        case 'immunity': s.voteMods.immune.push(mi.id); break;
        case 'protect': if (target) s.voteMods.immune.push(target.id); break;
        case 'double_vote': s.voteMods.doubleVote.push(mi.id); break;
        case 'block_vote': if (target) s.voteMods.blocked.push(target.id); break;
        case 'cancel_vote': s.voteMods.cancelNext = true; break;
        case 'capacity_plus': s.capacity++; break;
        case 'capacity_minus': s.capacity = Math.max(1, s.capacity - 1); break;
        case 'bunker_add_feature': s.bunker.features.push('Library with 300 books'); break;
        case 'eject': if (target) target.status = 'ejected'; break;
        case 'airlock': {
          if (!target) break;
          s.log.pop();   // an airlock logs its own line instead of the generic one
          const open = (s.airlocks || []).find((a) => a.targetId === target.id);
          if (open && !open.byIds.includes(mi.id)) {
            s.airlocks = s.airlocks.filter((a) => a !== open);
            target.status = 'ejected';
            logPush(s, 'eject', `🚪 ${mi.name} sealed the airlock with ${byId(s, open.byIds[0]).name} — ${target.name} is thrown out of the bunker, no vote!`);
            jamAirlocks(s, true);
          } else {
            s.airlocks = [...(s.airlocks || []), { targetId: target.id, byIds: [mi.id], round: s.round }];
            logPush(s, 'special', `🚪 ${mi.name} started cycling the airlock on ${target.name}. If one more Airlock card is played on ${target.name} before this round's discussion ends, ${target.name} is out — no vote.`);
          }
          break;
        }
        case 'revive': if (target) target.status = 'alive'; break;
        case 'mass_reveal': for (const p of alive(s)) if (cat && p.cards[cat] == null) revealFor(s, p, cat); break;
        default: break;
      }
      if (alive(s).length <= s.capacity && s.phase !== 'final') toFinal(s);
      return done();
    }
    case 'playAgain': return { state: scenario('lobby-host').states[0] };
    case 'endGame': {
      if (!s.you.isHost) return err('not_host', 'Only the host can do that.');
      if (s.phase === 'lobby') return err('wrong_phase', 'There is no game to end: the table is already in the lobby');
      const lob = scenario('lobby-host').states[0];
      lob.log = s.log;
      if (s.phase !== 'final') logPush(lob, 'system', 'The host ended the game');
      logPush(lob, 'system', 'Back to the lobby — same table, new cards next game');
      return { state: lob };
    }
    default: return null;
  }
}
