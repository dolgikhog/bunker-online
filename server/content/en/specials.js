// English special condition cards (SPEC §5, §11 X1; reports/i18n-design.md §6.1): title and rules text by id.
//
// Today's strings, verbatim. The ids are the ones the engine and the log already use; they never change. What a card
// does (effect, target, category) is language-neutral and lives in ../gen.js. The key order of the random pool is the
// deal order. The last three entries are never in the random pool: `airlock` and `revive` are the fixed cards the
// engine deals itself (§11 X1), and `fallback-feature` stands in when a dealer fails (the engine's "Hidden room").
// Card texts are plain text: no placeholders.

const BEFORE_VOTE = 'Play during a reveal or discussion phase.';
const SWAP_TAIL = 'Both cards are revealed to everyone.';
const REROLL_TAIL = 'is discarded and replaced by a newly drawn one, which is revealed to everyone.';
const PEEK_TAIL = 'It is added to your private notes and stays hidden from everyone else, who only learn that a peek happened.';
const SHUFFLE_TAIL = 'is collected, shuffled and dealt back at random, one each (you may get your own back). All of them are revealed to everyone.';
const NEXT_VOTE_TAIL = 'in the next vote (every ballot of it, revotes included). If that vote is cancelled, this is used up too.';

export default {
  // swap_card (target other; a Category or 'choose')
  'swap-baggage': {
    title: 'Barter',
    text: `Choose another player: you swap Baggage cards with them. ${SWAP_TAIL}`,
  },
  'swap-profession': {
    title: 'Career Switch',
    text: `Choose another player: you swap Profession cards with them. ${SWAP_TAIL}`,
  },
  'swap-health': {
    title: 'Organ Donor',
    text: `Choose another player: you swap Health cards with them. ${SWAP_TAIL} Let's hope yours was the worse one.`,
  },
  'swap-hobby': {
    title: 'Hobby Exchange',
    text: `Choose another player: you swap Hobby cards with them. ${SWAP_TAIL}`,
  },
  'swap-phobia': {
    title: 'Pass the Fear',
    text: `Choose another player: you swap Phobia cards with them. ${SWAP_TAIL}`,
  },
  'swap-trait': {
    title: 'Personality Transplant',
    text: `Choose another player: you swap Personality cards with them. ${SWAP_TAIL}`,
  },
  'swap-biology': {
    title: 'Body Swap',
    text: `Choose another player: you swap Biology cards with them (sex, age and all). ${SWAP_TAIL}`,
  },
  'swap-choose': {
    title: 'Fair Trade',
    text: `Choose another player and any category: you swap your cards of that category. ${SWAP_TAIL}`,
  },

  // reroll_card (target self or other; a Category or 'choose')
  'reroll-self-health': {
    title: 'Miracle Cure',
    text: `Your Health card ${REROLL_TAIL} It could be better. It could be worse.`,
  },
  'reroll-self-profession': {
    title: 'Night School',
    text: `Your Profession card ${REROLL_TAIL}`,
  },
  'reroll-self-phobia': {
    title: 'Exposure Therapy',
    text: `Your Phobia card ${REROLL_TAIL} Out with the old fear, in with a new one.`,
  },
  'reroll-self-baggage': {
    title: 'Lost and Found',
    text: `Your Baggage card ${REROLL_TAIL}`,
  },
  'reroll-self-choose': {
    title: 'Fresh Start',
    text: `Choose any of your categories: that card ${REROLL_TAIL}`,
  },
  'reroll-other-baggage': {
    title: 'Lost Luggage',
    text: `Choose another player: their Baggage card ${REROLL_TAIL}`,
  },
  'reroll-other-trait': {
    title: 'Brainwashing',
    text: `Choose another player: their Personality card ${REROLL_TAIL}`,
  },
  'reroll-other-health': {
    title: 'Contagious Sneeze',
    text: `Choose another player: their Health card ${REROLL_TAIL}`,
  },
  'reroll-other-choose': {
    title: 'Rewrite History',
    text: `Choose another player and any category: their card of that category ${REROLL_TAIL}`,
  },

  // force_reveal (target other; 'choose' or 'random')
  'reveal-interrogation': {
    title: 'Interrogation',
    text: 'Choose another player and one of their hidden categories: that card is revealed to everyone.',
  },
  'reveal-background-check': {
    title: 'Background Check',
    text: 'Choose another player and one of their hidden categories: that card is revealed to everyone. No secrets in the bunker.',
  },
  'reveal-subpoena': {
    title: 'Subpoena',
    text: 'Choose another player and one of their hidden categories: that card is revealed to everyone, whether they like it or not.',
  },
  'reveal-truth-serum': {
    title: 'Truth Serum',
    text: 'Choose another player: one of their hidden cards, picked at random, is revealed to everyone.',
  },
  'reveal-paparazzi': {
    title: 'Paparazzi',
    text: 'Choose another player: one of their hidden cards, picked at random, is revealed to everyone. Smile for the camera.',
  },
  'reveal-loose-lips': {
    title: 'Loose Lips',
    text: 'Choose another player: they let something slip. One of their hidden cards, picked at random, is revealed to everyone.',
  },

  // peek (target other; 'choose' or 'random')
  'peek-dossier': {
    title: 'Dossier',
    text: `Choose another player and one of their hidden categories: you alone see that card. ${PEEK_TAIL}`,
  },
  'peek-xray': {
    title: 'X-ray Glasses',
    text: `Choose another player and one of their hidden categories: you alone see that card. ${PEEK_TAIL}`,
  },
  'peek-stolen-diary': {
    title: 'Stolen Diary',
    text: `Choose another player and one of their hidden categories: you alone see that card. ${PEEK_TAIL}`,
  },
  'peek-keyhole': {
    title: 'Keyhole',
    text: `Choose another player: you alone see one of their hidden cards, picked at random. ${PEEK_TAIL}`,
  },
  'peek-gossip': {
    title: 'Gossip',
    text: `Choose another player: you alone see one of their hidden cards, picked at random. ${PEEK_TAIL}`,
  },
  'peek-eavesdropping': {
    title: 'Eavesdropping',
    text: `Choose another player: you alone see one of their hidden cards, picked at random. ${PEEK_TAIL}`,
  },
  'peek-bribed-guard': {
    title: 'Bribed Guard',
    text: `Choose another player and one of their hidden categories: you alone see that card. ${PEEK_TAIL}`,
  },
  'peek-wiretap': {
    title: 'Wiretap',
    text: `Choose another player: you alone see one of their hidden cards, picked at random. ${PEEK_TAIL}`,
  },

  // mass_reveal (target none; a Category or 'choose')
  'mass-health': {
    title: 'Medical Commission',
    text: "Every alive player's Health card is revealed to everyone, yours included.",
  },
  'mass-biology': {
    title: 'Census',
    text: "Every alive player's Biology card is revealed to everyone, yours included.",
  },

  // shuffle_category (target none; a Category or 'choose')
  'shuffle-baggage': {
    title: 'Luggage Carousel',
    text: `Every alive player's Baggage card ${SHUFFLE_TAIL}`,
  },

  // immunity (target self), before_vote
  'immunity-untouchable': {
    title: 'Untouchable',
    text: `${BEFORE_VOTE} Nobody can vote against you ${NEXT_VOTE_TAIL}`,
  },
  'immunity-diplomatic': {
    title: 'Diplomatic Immunity',
    text: `${BEFORE_VOTE} Nobody can vote against you ${NEXT_VOTE_TAIL}`,
  },

  // protect (target other), before_vote
  'protect-bodyguard': {
    title: 'Bodyguard',
    text: `${BEFORE_VOTE} Choose another player: nobody can vote against them ${NEXT_VOTE_TAIL}`,
  },
  'protect-alibi': {
    title: 'Alibi',
    text: `${BEFORE_VOTE} Choose another player: nobody can vote against them ${NEXT_VOTE_TAIL}`,
  },
  'protect-human-shield': {
    title: 'Human Shield',
    text: `${BEFORE_VOTE} Choose another player: nobody can vote against them ${NEXT_VOTE_TAIL}`,
  },

  // double_vote (target self), anytime
  'double-megaphone': {
    title: 'Megaphone',
    text: 'Your vote counts twice in the vote that is running now (revotes included), or in the next vote if none is running. If that vote is cancelled, this is used up too.',
  },
  'double-loud-voice': {
    title: 'Loud Voice',
    text: 'Your vote counts twice in the vote that is running now (revotes included), or in the next vote if none is running. If that vote is cancelled, this is used up too.',
  },
  'double-kingmaker': {
    title: 'Kingmaker',
    text: 'Your vote counts twice in the vote that is running now (revotes included), or in the next vote if none is running. If that vote is cancelled, this is used up too.',
  },

  // block_vote (target other), before_vote
  'block-gag-order': {
    title: 'Gag Order',
    text: `${BEFORE_VOTE} Choose another player: they cannot vote ${NEXT_VOTE_TAIL}`,
  },
  'block-laryngitis': {
    title: 'Laryngitis',
    text: `${BEFORE_VOTE} Choose another player: they cannot vote ${NEXT_VOTE_TAIL}`,
  },

  // cancel_vote (target none), anytime
  'cancel-blackout': {
    title: 'Blackout',
    text: 'If a vote is running (defense and revotes included), the rest of it is cancelled at once. Otherwise the next vote is cancelled. Skipped ejections are made up in later votes.',
  },
  'cancel-fire-drill': {
    title: 'Fire Drill',
    text: 'If a vote is running (defense and revotes included), the rest of it is cancelled at once. Otherwise the next vote is cancelled. Skipped ejections are made up in later votes.',
  },

  // capacity_plus (target none), anytime
  'capacity-extra-bunk': {
    title: 'Extra Bunk',
    text: 'The bunker gains one bed (capacity +1). If everyone still alive now fits, the game ends at once.',
  },

  // capacity_minus (target none), before_vote
  'capacity-cave-in': {
    title: 'Cave-in',
    text: `${BEFORE_VOTE} Part of the bunker collapses and it loses one bed (capacity -1, never below 1).`,
  },

  // bunker_add_feature (target none), anytime
  'feature-secret-door': {
    title: 'Secret Door',
    text: 'You find a sealed door nobody had noticed: a new feature is drawn and added to the bunker for everyone to see. Blessing or curse, it stays.',
  },
  'feature-old-blueprints': {
    title: 'Old Blueprints',
    text: 'The original plans show a room nobody has explored: a new feature is drawn and added to the bunker for everyone to see.',
  },
  'feature-supply-drop': {
    title: 'Supply Drop',
    text: 'A crate crashes down by the entrance: a new feature is drawn and added to the bunker for everyone to see.',
  },
  'feature-maintenance-log': {
    title: 'Maintenance Log',
    text: 'An old logbook mentions a room behind the generator: a new feature is drawn and added to the bunker for everyone to see.',
  },

  // The fixed cards (never in the random pool).
  'airlock': {
    title: 'Airlock',
    text: 'Needs a partner. From round 2, during a reveal or discussion phase, choose a player to start cycling the airlock on them. If another player plays an Airlock on the same player this round before the vote, they are thrown out — no vote. Alone, the airlock jams when the discussion ends. Vote immunity does not stop it.',
  },
  'revive': {
    title: 'Back from the Forest',
    text: `${BEFORE_VOTE} Choose an ejected player, whether they were voted out or thrown out through the airlock (not one who left the game): they come back and are alive again. They get no turn in a reveal phase that began without them, and round 7 has the last reveal phase. Later votes may eject more to make up for it.`,
  },
  // The engine's stand-in when the dealer offers no usable card (never dealt from the pool).
  'fallback-feature': {
    title: 'Hidden room',
    text: 'Add a new feature to the bunker.',
  },
};
