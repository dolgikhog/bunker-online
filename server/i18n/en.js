// server/i18n/en.js — every server message and error in English (SPEC §11 X5.3, X5.5; reports/i18n-design.md §4, §5).
//
// Checkpoint A1 "messages frozen" (i18n-server). From A1 on, keys, param names and the value types below only grow:
// nothing is renamed or removed; a change is a new key, logged in .scratch/i18n-server/checkpoint-changes.md.
// Every value reproduces today's English text byte for byte ("1 beds" included, report §14); the golden test
// test/i18n-golden-engine.test.js renders each key and compares it with the pre-X5 engine.
//
// ./index.js SCHEMA lists every key's params with their types, and the log kind of each log line. ./ru.js has the same
// keys (it may lack some until it exports COMPLETE = true; a missing key falls back to this file).
//
// A value is a template string or a function.
//
// Template grammar (report §7; the same in every language):
//   {x}           param x. A number goes through the language's number format; a string is printed as it is; a list
//                 is joined with ', ' (an EMPTY list prints `word.nobody`); a player, category, card, special or
//                 round prefix becomes its own segment of the log line's `parts` (report §8.1); a nested message
//                 {msg: {key, params}} is rendered in place, and a missing optional one (null) prints nothing
//   {x@form}      the same with a form: @and (a list joined "A, B and C"), @bare (a round prefix without its dash),
//                 @cap (first letter upper case), @acc/@gen/@dat/@ins/@loc/@nom (a category's case, in ru)
//   {x|one|other} the word for the number x: two forms mean "x is 1 / anything else" (every language); three forms
//   {x|one|few|many}   mean Russian one/few/many and belong right next to the printed number (report §7)
//   {x:o0|o1|…}   an option picked by x: a boolean (false → o0, true → o1) or an integer index. Options are plain text
//   {{ and }}     literal braces
//
// Two params exist in every message without being passed ("derived"):
//   {airlock}     the Airlock card's chip, the word `word.airlock` (report §8.1)
//   {cardtext}    when the message has a special card param `card`: that card's rules text as a `cardtext` segment
//                 (': ' + text), or nothing when the card has no text
//
// A function value is (p, f) => result, for what a template cannot say:
//   p             the message's params as the engine passed them (player refs {p, n}, lists, numbers, …; SCHEMA)
//   f             public/i18n/core.js helpers() for this language (f.lang, f.num, f.pl, f.opt, f.format, f.text),
//                 where f.format and f.text default their params to p, plus:
//   f.t(template, params = p)  → a piece: the template in this language, with these params
//   f.k(key, params = p)       → a piece: another key of this catalogue
//   f.join(items, sep)         → a piece: each item (a player ref, a piece, a string…) rendered, joined with `sep`
//   f.list(items, style)       → a piece: the items as the language's list ('and': "A, B and C"; default ', ')
//   result        a piece, a string, or an array of them in order (f.format's parts too). A piece may also be passed
//                 as a param value to f.t or f.format; String(piece) is its text.
// ru.js may use a template where en.js has a function, or the other way round: only the key and its params are shared.

export const COMPLETE = true;

export default {
  // ---------------------------------------------------------------------------------------------- members and host
  'log.join': '{p} joined',
  'log.watch': '{p} is watching',
  'log.seat': '{p} took a seat',
  'log.leftLobby': '{p} left',
  'log.leftGame': '{p} left the game',
  'log.kicked': '{p} was removed by the host',
  'log.specLeft': '{p} (spectator) left',
  'log.specKicked': '{p} (spectator) was removed by the host',
  'log.host': (p, f) => (p.why ? f.t('{why} — {p} is now the host') : f.t('{p} is now the host')),
  'host.offline': '{p} has been offline for a while',
  'host.handover': '{p} handed over the host role',

  // ---------------------------------------------------------------------------------------------- game flow
  'log.gameBegins': 'The game begins: {n} players, {beds} beds. Catastrophe: {cata}. Bunker: {bname}.',
  'log.endGame': 'The host ended the game',
  'log.backToLobby': 'Back to the lobby — same table, new cards next game',
  'log.roundReveal': 'Round {r} of {max} — reveal phase ({asc:descending|ascending} seat order){first:|. Everyone reveals their Profession}',
  'log.discussion': (p, f) => f.t(
    p.mode === 'vote' ? '{rp}discussion — then a vote: {k} {k|player|players} will stay outside'
      : p.mode === 'cancelled' ? '{rp}discussion — the vote after it is cancelled'
        : '{rp}discussion — no vote this round'),
  'log.overtime': 'Overtime — the bunker is still over capacity ({alive} players, {beds} beds): discuss, then vote again',
  'log.doorCloses': 'The bunker door closes. In the bunker: {in}. Stayed in the forest: {out}.',
  'log.reveal': '{rp}{p} revealed {cat}: {card}{auto:| (revealed automatically)}',

  // ---------------------------------------------------------------------------------------------- the vote step
  'log.voteSkipped': '{rp}the vote is cancelled (a special card); the {k|kick carries|kicks carry} over{mods}',
  'log.ballotsFewer': (p, f) => f.t(`{rp}${p.why ? '{why}, ' : ''}${p.fewer === 1 ? 'one ejection fewer is' : '{fewer} fewer ejections are'} due: this vote now has {n} {n|ballot|ballots} instead of {before}`),
  'why.gone': 'with {p} gone',
  'why.bed': 'with the extra bed',
  'log.voteStep': '{rp}vote: {k} {k|player|players} will stay outside',
  'log.noMoreDue': '{rp}no more ejections are due in this vote',
  'log.allImmune': '{rp}everyone is immune: the rest of the vote is cancelled',
  'log.stepCancelled': '{rp}{earlier:the vote ends without an ejection|no further ejections in this vote}{mods}',
  'mods.used': '. {items@and} {n|was|were} for this vote and {n|is|are} used up',
  'mod.immune': "{p}'s immunity",
  'mod.blocked': "{p}'s vote block",
  'mod.double': "{p}'s double vote",
  'log.tally': (p, f) => [
    f.t('{rp}{revote:vote|revote} {ballot} of {ballots}: '),
    f.join(p.rows.map((row) => (row.voters.length
      ? f.t('{t} {votes} ({voters})', { t: row.t, votes: row.votes, voters: row.voters.map((v) => (v.x2 ? f.t('{p} ×2', v) : v.p)) })
      : f.t('{t} {votes}', row))), '; '),
    p.abstained.length ? f.t('; abstained: {abstained}') : '',
  ],
  'log.tie': '{rp}tie between {ids}: defense speeches, then a revote',
  'log.nobodyLeft': '{rp}nobody is left to vote out in this ballot',
  'log.revote': '{rp}revote between {ids}',
  'log.eject': '{how:|Nobody voted — fate decides: |Still tied — fate decides: }{p} is ejected and stays in the forest',

  // ---------------------------------------------------------------------------------------------- the airlock (§11 X1)
  'log.airlockStart': "🚪 {a} started cycling the {airlock} on {t}. If one more Airlock card is played on {t} before {ot:this round's discussion ends|the overtime discussion ends}, {t} is out — no vote.",
  'log.airlockSeal': '🚪 {a} sealed the {airlock} with {by} — {t} is thrown out of the bunker, no vote!',
  'log.airlockJam': '🚪 The {airlock} on {t} jammed — nobody closed it.',

  // ---------------------------------------------------------------------------------------------- specials and their results
  'log.special': '{rp}{p} played {card}{cardtext} → {result}',
  'res.swap': '{a} and {b} swapped {cat}: {a} now has “{ca}”, {b} now has “{cb}”',
  'res.reroll': "{t}'s {cat} was replaced with a new card: “{c}”",
  'res.force': '{t} had to reveal {cat}: “{c}”',
  'res.peek': "{p} secretly looked at one of {t}'s hidden cards",
  'res.mass': (p, f) => f.t("everyone's {cat} is revealed: {rows}", { cat: p.cat, rows: f.join(p.rows.map((r) => f.t('{p} — “{c}”', r)), '; ') }),
  'res.shuffle': (p, f) => f.t('all {cat} cards were shuffled and dealt back face up: {rows}', { cat: p.cat, rows: f.join(p.rows.map((r) => f.t('{p} — “{c}”', r)), '; ') }),
  'res.protect': 'nobody can vote against {t} in the next vote',
  'res.double': "{p}'s vote counts twice in {now:the next|this} vote",
  'res.block': '{t} cannot vote in the next vote',
  'res.cancelNow': 'the vote is cancelled right now; the kicks carry over',
  'res.cancelRest': 'the rest of the vote is cancelled right now; the kicks still due carry over',
  'res.cancelNext': 'the next vote will be cancelled',
  'res.eject': '{t} is ejected and stays in the forest',
  'res.revive': '{t} is back in the game{when:| (they still get their turn this round)| (from the next round on)}',
  'res.beds': 'the bunker now has {n} beds',
  'res.bedsMin': 'the bunker already has only {n} bed',
  'res.feature': 'the bunker gains a new feature: “{f}”',

  // ---------------------------------------------------------------------------------------------- notes, timer, prefixes, words
  'note.peek': "{rp@bare}: {t}'s {cat} — “{c}”",
  'timer.turn': "{p}'s turn",
  'timer.defense': 'Defense: {p}',
  'timer.discussion': 'Discussion',
  'timer.otDiscussion': 'Overtime discussion',
  'rp': 'Round {r} — ',
  'rp.ot': 'Overtime — ',
  'rp.bare': 'Round {r}',
  'rp.otBare': 'Overtime',
  'kick.reason': 'The host removed you from the room',
  'fmt.quote': '“{title}”',
  'word.airlock': 'airlock',
  'word.nobody': 'nobody',
  'special.untitled': 'Special condition',

  // ---------------------------------------------------------------------------------------------- dev mode (§11 X9)
  // Logged only on a server started with BUNKER_DEV=1. The /dev page is English-only (X9); these lines show in the
  // game log of the normal client, so they have keys like every other line.
  'log.dev.seed': '[dev] Deals in this room follow the seed “{seed}”',
  'log.dev.giveSpecial': '[dev] {a} gave {t} the special {card}',
  'log.dev.autoReveal': '[dev] {a} auto-revealed the rest of the reveal phase ({rp@bare})',
  'log.dev.skipToVote': '[dev] {a} skipped ahead to the next vote',
  'log.dev.forceTie': '[dev] {a} forced a tie between {ids}',
  'log.dev.god': '[dev] {a} turned the god view {on:off|on} (on their own screen only)',
  'log.dev.fastTimers': '[dev] {a} set every timer to {secs} s',
  'log.dev.addBots': '[dev] {a} added {n} {n|bot|bots} ({seated:they watch: seats are taken only in the lobby|they take seats})',
  // Added after A1 (A2): a line server/dev.js still writes as ready English text (server/game.js LEGACY_LOG_KEY). It is
  // printed as it is, in every language (X9: dev mode is English-only).
  'log.dev.text': '{text}',

  // ---------------------------------------------------------------------------------------------- errors: the default per code
  'err.bad_request': 'Bad request',
  'err.not_in_room': 'You are not in a room',
  'err.no_room': 'No such room',
  'err.bad_token': 'This seat is no longer available',
  'err.server_busy': 'The server is busy, try again later',
  'err.room_full': 'The room is full',
  'err.not_host': 'Only the host can do that',
  'err.wrong_phase': 'You cannot do that right now',
  'err.not_your_turn': "It's not your turn",
  'err.not_allowed': 'That is not allowed',
  'err.replaced': 'This seat was opened somewhere else',

  // ---------------------------------------------------------------------------------------------- errors: the engine
  'err.expectedObject': 'Expected a JSON object',
  'err.unknownType': 'Unknown message type',
  'err.missingField': 'Missing field "{field}"',
  'err.invalidField': 'Invalid field "{field}"',
  'err.optionRange': '{field} must be a whole number of seconds from 5 to 600',
  'err.stale': 'Too late: that turn or vote has already moved on',
  'err.nameRequired': 'Please enter a name (1–20 characters)',
  'err.internal': 'Internal error',
  'err.notGameAction': '"{type}" is not a game action',
  'err.optionsLobbyOnly': 'Options can only be changed in the lobby',
  'err.seatsFull': 'All 16 seats are taken',
  'err.seatsLobbyOnly': 'Seats can only be taken in the lobby',
  'err.alreadySeated': 'You already have a seat',
  'err.alreadyStarted': 'The game has already started',
  'err.tooFewPlayers': 'At least {n} players are needed to start',
  'err.playAgainFinal': 'Play again is only available after the game',
  'err.endGameLobby': 'There is no game to end: the table is already in the lobby',
  'err.noSuchPlayer': 'No such player',
  'err.kickSelf': 'You cannot kick yourself',
  'err.transferTarget': 'Pick another seated player',
  'err.revealPhase': 'Cards are revealed during the reveal phase',
  'err.alreadyRevealed': 'You have already revealed a card this turn',
  'err.round1Profession': 'In round 1 you must reveal your Profession',
  'err.cardRevealed': 'That card is already revealed',
  'err.noTurn': 'There is no turn to end',
  'err.revealFirst': 'Reveal a card first',
  'err.useStart': 'Use Start to begin the game',
  'err.usePlayAgain': 'Use Play again to return to the lobby',
  'err.noOpenVote': 'There is no open vote',
  'err.notVoter': 'You are not a voter in this ballot',
  'err.voteSelf': 'You cannot vote for yourself',
  'err.notCandidate': 'That player is not a candidate',
  'err.specialPhase': 'Specials can only be played during the game',
  'err.spectatorSpecial': 'Spectators have no special cards',
  'err.noCard': 'You do not have that card',
  'err.beforeVoteOnly': 'This card can only be played before the vote (reveal or discussion)',
  'err.specialAlive': 'Only players still in the game can play specials',
  'err.cardUsed': 'That card has already been played',
  'err.oneSpecial': 'You have already played a special this round',
  'err.fromRound': 'This card can be played from round {n}',
  'err.cancelledAlready': 'The next vote is already cancelled',
  'err.doubleBlocked': 'Your vote is blocked in {now:the next|this} vote, so a double vote would do nothing',
  'err.doubleNotVoter': 'You are not a voter in this ballot, so a double vote would do nothing',
  'err.pickAlive': 'Pick another player who is still in the game',
  'err.noHidden': 'That player has no hidden cards left',
  'err.pickEjected': 'Pick a player who was voted out',
  'err.ownAirlock': 'You already started the airlock on {t}: someone else has to close it',
  'err.pickCategory': 'Pick a category',
  'err.notHidden': 'That card is not hidden',

  // ---------------------------------------------------------------------------------------------- errors: rooms.js
  'err.lookupThrottled': 'Too many wrong room codes from your network. Wait a minute, then try again',
  'err.noRoomJoin': 'There is no room with that code',
  'err.noRoomResume': 'That room no longer exists',
  'err.replacedTab': 'This seat was opened in another tab or window',
  'err.tooManyRooms': 'Too many rooms are open from your network. Leave one of them, or try again later',
  'err.jsonFrame': 'Expected a JSON text frame',
  'err.malformedJson': 'Malformed JSON',
  'err.generic': 'Something went wrong',
  'err.devOff': 'Dev mode is off: test shortcuts are not available on this server',

  // ---------------------------------------------------------------------------------------------- errors: dev mode (§11 X9)
  'err.dev.badOp': 'Unknown dev op: use one of giveSpecial, autoReveal, skipToVote, forceTie, god, fastTimers, addBots',
  'err.dev.badSeed': 'A seed is 1–64 characters or a whole number',
  'err.dev.ejectRetired': 'The one-player eject card is retired (§11 X1): give an Airlock instead',
  'err.dev.noPlayer': 'There is no such seated player',
  'err.dev.playerLeft': '{p} has left the game',
  'err.dev.noGame': 'There is no game running',
  'err.dev.gameOver': 'The game is over',
  'err.dev.notReveal': 'Auto-reveal works only during a reveal phase',
  'err.dev.ballotOpen': 'A ballot is already open',
  'err.dev.noBallot': 'A tie can only be forced while a ballot is open',
  'err.dev.revote': 'Only a main ballot can be forced into a tie',
  'err.dev.duplicate': 'List each player once',
  'err.dev.notAlive': '{p} is not in the game any more',
  'err.dev.immune': '{p} is immune in this vote, so they cannot be in the tie',
  'err.dev.impossible': 'The voters of this ballot cannot make that tie (too few votes, or the double votes do not add up)',
  'err.dev.tableFull': 'Every seat is taken',
  'err.dev.spectatorsFull': 'The room has no room left for spectators',
};
