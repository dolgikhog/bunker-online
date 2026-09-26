# Bunker Online: specification (POC)

An online party game in the style of the discussion game **“Bunker”** («Бункер»).
Players talk over an external voice call (Discord or Telegram). This app is the **table**. It deals
cards, tracks reveals, runs turns and votes, and carries out the special cards. There is no built-in chat.

This file is the contract between everyone who builds it. When code and this file disagree, this
file wins, unless an entry in §11 "Amendments" (at the bottom) changes it.

## 0. Decisions already made by the owner (do not change)

| Topic | Decision |
|---|---|
| Language | English UI and content |
| Flow | **The host is also a player** and drives the phases with a **Next** button plus admin tools. Timers are *visual only*, so nothing auto-advances when they run out |
| Special cards | **Effects are carried out automatically** by the server (§5) |
| Extras | **Spectators** are supported. There is **no chat** and **no AI epilogue** |
| Hosting | Plain HTTP + WebSocket on **one port (default 8080)**, bound to `0.0.0.0`. No TLS, no domain, no accounts (production runs behind Caddy with HTTPS, §11 X2) |
| Scope | Playable proof of concept. Games live in memory and are lost on restart. Hardening goes only as far as "exposed on a public IP to friends" requires (§9) |

## 1. Rules of the game (adapted for online play)

**Story.** A catastrophe has happened. The players stand at the door of a bunker that has room for only
about half of them. Each round they reveal facts about their characters and argue why they are needed
to rebuild humanity after they leave the bunker. By vote, they decide who stays outside. There are no
weapons and no violence, only discussion.

**Players:** 6–16 recommended. The app allows **4–16** by default (`BUNKER_MIN_PLAYERS`, which can go down to 2 for testing).

**Setup.**
- One **Catastrophe** is drawn and shown to everyone (title, text, and details such as remaining world population and climate).
- One **Bunker** is generated and shown to everyone: a name, size, how long the group must stay inside, the food supply, and 3–5 features.
- **Capacity** (beds) = `floor(N/2)`, where N is the number of players at the start. It is shown prominently.
- Each player gets **8 characteristic cards**, one per category, dealt face down (only the owner sees them):

  | id | label | example |
  |---|---|---|
  | `profession` | Profession | "Surgeon (12 years of experience)" |
  | `biology` | Biology | "Female, 34 y.o., heterosexual" |
  | `health` | Health | "Asthma (moderate)" / "Perfectly healthy" |
  | `hobby` | Hobby | "Fishing (5 years)" |
  | `phobia` | Phobia | "Claustrophobia" |
  | `skill` | Extra skill | "Speaks 5 languages" |
  | `trait` | Personality | "Hot-tempered" |
  | `baggage` | Baggage | "TT pistol with 16 rounds" |

- Each player also gets **2 Special condition cards** (hidden, §5).
- A player's character is anonymous until the cards are revealed. Nobody has a sex or an age until the Biology card is shown.

**Rounds.** There are 7 rounds (`MAX_ROUNDS = 7`). Each round:
1. **Reveal phase.** Players take turns in seat order among *alive* players. Odd rounds go
   ascending by seat and even rounds go descending.
   The order is fixed when the phase starts (the players alive at that moment). A player who is not alive when their
   turn comes is skipped; a player who was not alive when the phase started gets no turn this round, even if revived.
   On their turn the speaker **reveals exactly one hidden card** and then argues their case while a visual timer runs
   (`speechSeconds1`, default 60 s, in round 1; `speechSeconds`, default 30 s, afterwards; it starts when the turn starts).
   - **Round 1: the card revealed must be `profession`.**
   - Rounds 2–7: any one hidden card, chosen by the speaker.
   - If the speaker has no eligible hidden card (special effects already revealed it), they skip the reveal and just speak.
     A card revealed by someone else's special never counts as the speaker's own reveal.
   - The speaker presses **End turn** (after revealing), or the host presses **Next** (which auto-reveals if needed; §6).
2. **Discussion phase.** Free discussion on voice, with a visual timer of `discussionSeconds` (default 90). The host presses **Next**.
3. **Vote step**, only when kicks are due this round (§2). Otherwise the game goes to the next round.

After 7 rounds each surviving player has revealed 7 of their 8 cards. One card
stays hidden until the end.

**The game ends** as soon as `alive ≤ capacity` (this is checked after every ejection, leave, kick or capacity change), or after
round 7 once the vote steps have brought `alive` down to `capacity` (§2 *overtime*). **Final phase:** every card of every player,
including unused specials, is revealed to everyone. The players still alive **are the bunker**. The ejected players
"stay in the forest". The host can press **Play again**, which returns everyone to the lobby with the same players.

## 2. Vote schedule

`KICKS[N]` = ejections scheduled at the end of rounds 1..7 for N starting players. In every row
survivors = floor(N/2) and ejected = ceil(N/2).

```
N : r1 r2 r3 r4 r5 r6 r7   survivors
2 :  0  0  0  0  0  0  1   1
3 :  0  0  0  0  0  1  1   1
4 :  0  0  0  0  0  1  1   2
5 :  0  0  0  0  1  1  1   2
6 :  0  0  0  0  1  1  1   3
7 :  0  0  0  1  1  1  1   3
8 :  0  0  0  1  1  1  1   4
9 :  0  0  1  1  1  1  1   4
10:  0  0  1  1  1  1  1   5
11:  0  1  1  1  1  1  1   5
12:  0  1  1  1  1  1  1   6
13:  0  1  1  1  1  1  2   6
14:  0  1  1  1  1  1  2   7
15:  0  1  1  1  1  2  2   7
16:  0  1  1  1  1  2  2   8
```

Special cards can eject, revive or cancel votes, and players can leave, so the actual number of kicks is **computed, not
looked up**:

- `outCount` = the number of players whose status is not `alive` (`ejected` or `left`).
- `cum(r)` = the sum of `KICKS[N][1..r]`.
- At the vote step of round `r < 7`: `kicksThisStep = max(0, min(cum(r) − outCount, alive − capacity))`.
- At the vote step of round 7, and at every **overtime** step: `kicksThisStep = max(0, alive − capacity)`.
- The formula is **re-evaluated before every ballot** of a step, not only when the step starts, so
  `vote.ballots = (ballot − 1) + kicksThisStep`. It can only shrink (a leave, kick or `capacity_plus` mid-step); when it
  reaches 0 the step ends.
- A step whose `kicksThisStep` is 0 does not happen at all: it does not consume `cancelNext` and does not clear vote modifiers.
- **Overtime:** after round 7's vote step, if `alive > capacity` (for example because the vote was cancelled), the game enters
  overtime (`overtime = true`, `round` stays 7): a discussion phase, then another vote step, repeated until `alive ≤ capacity`.

## 3. Vote step procedure

A vote step with `k` kicks runs **k sequential ballots** ("Vote 1 of 2"). Each ballot works like this:

1. **Main vote** (`vote.stage = 'main'`). Candidates and voters are computed when the ballot opens (both in seat order).
   - **Candidates** are alive players who are not immune (§5). If there are none (everyone is immune), the rest of the
     step is cancelled exactly as by `cancel_vote` (log it).
   - **Voters** are alive players who are not blocked and have at least one valid target. If there are none, the ballot
     closes at once with zero votes.
   - A voter may not vote for themself. Votes are **secret while open**: everyone sees *who* has voted, but not for whom.
     A voter may change their vote until the ballot closes.
   - The ballot closes automatically when every voter has voted, or when the host presses **Close vote** (missing voters abstain).
2. **Tally.** Each vote counts as 1, or as 2 for a voter with `double_vote`. The result is published *openly*: who voted for whom.
   - A unique top candidate is **ejected**.
   - If the top is tied → **Defense phase.** The tied candidates speak in seat order (`defenseSeconds`, default 30 s each; the speaker
     presses End turn or the host presses Next). Then a **Revote** (`stage = 'revote'`) happens, in which the candidates are only the
     tied players still alive and the voters are the main ballot's voters who are still alive and have a valid target.
     A tied candidate can vote but not for themself.
     If the revote is still tied, one of the tied players is picked **at random** (log: "Fate decides").
   - If zero votes are cast (main or revote), a random candidate of that ballot is ejected (log: "Nobody voted — fate decides").
3. An ejected player's status becomes `ejected`. They stay at the table as an observer. Their hidden cards
   **stay hidden** until the final, and they can no longer vote, speak in turns or play specials.
4. After each ejection the game checks `alive ≤ capacity` and ends if true. Otherwise it re-evaluates §2 and opens the next
   ballot **immediately** (no results pause; clients show `lastVoteResult` next to it), or leaves the step.

**Leave or kick during a step** (the only way the alive set can shrink mid-step: `eject` and `revive` are `before_vote`). The player
is removed from `candidates`, `voters` and the defense order. Their vote is discarded, and so are votes cast *for* them (those voters
may vote again). The auto-close check runs again. If a ballot is left with no candidate, it ends with nobody ejected, and the step
continues with §2's re-evaluation. The current speaker leaving advances the turn (§6).

**Vote modifiers** (from specials) last **until the current or next vote step ends** (every ballot of it) and are then cleared.
A step also "ends" when it is cancelled mid-way or skipped by `cancelNext`. `cancelNext` itself is cleared only when it skips a step.

## 4. Phases and state machine

`phase ∈ lobby | reveal | discussion | vote | defense | final`

```
lobby --start--> reveal(r=1) --all spoke--> discussion --next--> [vote step if kicks>0 and not cancelled]
   vote --(unique)--> eject --> (more ballots? vote : after-step)
   vote --(tie)--> defense --all spoke--> vote(revote) --> eject --> ...
after-step: alive<=capacity ? final : (r<7 ? reveal(r+1) : (alive>capacity ? discussion(overtime) -> vote : final))
any time: alive<=capacity -> final
final --playAgain--> lobby
```

If `voteMods.cancelNext` is set when a vote step would start (with `kicksThisStep > 0`), the step is skipped (log it), the flag
and the other vote modifiers are cleared, `lastVoteResult` becomes a cancelled result, and the *after-step* rule runs.
`cancel_vote` played in phase `vote` or `defense` does the same to the running step at once (open votes are discarded unpublished).

What `turn`, `vote` and `timer` hold in each phase:

| phase | `turn` | `vote` | `timer` |
|---|---|---|---|
| lobby, final | null | null | null |
| reveal | `kind:'reveal'`, `order` = the round's speakers (fixed, §1) | null | `speechSeconds1`/`speechSeconds`, restarted for each speaker |
| discussion (incl. overtime) | null | null | `discussionSeconds`, from the start of the phase |
| vote | null | the open ballot | null |
| defense | `kind:'defense'`, `order` = the tied candidates in seat order | null | `defenseSeconds`, restarted for each speaker |

## 5. Special condition cards (carried out automatically)

Each player gets 2 specials, visible only to them. **One special per player per round, at most** (overtime counts as round 7).
Only `alive` players can play them. When a special is played, it becomes public: its title, its text, and the result are logged.

Each card is `{ id, title, text, effect, target, category? }`. The **effect determines the target type and the timing** (the engine
validates this). The content must use only these combinations:

| effect | target | category param | timing | what the server does |
|---|---|---|---|---|
| `swap_card` | `other` | a Category or `'choose'` | anytime | Swaps the player's card of that category with the target's card. **Both** swapped cards become revealed |
| `reroll_card` | `self` or `other` | a Category or `'choose'` | anytime | Replaces the target's card of that category with a freshly drawn one, which becomes revealed |
| `force_reveal` | `other` | `'choose'` or `'random'` | anytime | Reveals one of the target's **hidden** cards (chosen by the player, or random) |
| `peek` | `other` | `'choose'` or `'random'` | anytime | Shows the player one of the target's hidden cards **privately**, as an entry in `me.notes`. The public log only says a peek happened |
| `mass_reveal` | `none` | a Category or `'choose'` | anytime | Every alive player's card of that category becomes revealed |
| `shuffle_category` | `none` | a Category or `'choose'` | anytime | Collects that category's card from every alive player, shuffles them, and deals them back. All become revealed |
| `immunity` | `self` | – | before_vote | Nobody can vote against the player during the next vote step |
| `protect` | `other` | – | before_vote | Nobody can vote against the target during the next vote step |
| `double_vote` | `self` | – | anytime | The player's vote counts twice during the current or next vote step |
| `block_vote` | `other` | – | before_vote | The target cannot vote during the next vote step |
| `cancel_vote` | `none` | – | anytime | During a vote step, the rest of that step is cancelled right away. Otherwise `cancelNext` is set. The kicks carry over through the §2 formula |
| `eject` | `other` | – | before_vote, **round ≥ 2** | The target is ejected immediately |
| `revive` | `ejected` | – | before_vote | An `ejected` (not `left`) player becomes `alive` again |
| `capacity_plus` | `none` | – | anytime | capacity += 1. Then the end-of-game condition is checked |
| `capacity_minus` | `none` | – | before_vote | capacity = max(1, capacity − 1) |
| `bunker_add_feature` | `none` | – | anytime | Adds a newly drawn feature to the bunker ("A hidden room was found…") |

- **Timing.** `anytime` means the phases reveal, discussion, vote and defense. `before_vote` means reveal and discussion only. Specials can never be played in the lobby or the final phase.
- `'choose'` means the player picks the category when playing the card. For `force_reveal` and `peek` the choice is limited to the target's hidden categories.
  For `swap_card`, `reroll_card`, `mass_reveal` and `shuffle_category` any category is allowed. `'random'` means the server picks one of the target's hidden categories.
  For a fixed category or `'random'`, the message's `category` is ignored.
- `target: 'other'` means another alive player (immunity does not protect from specials); for `force_reveal` and `peek` the target
  must also have at least one hidden card. `target: 'ejected'` means a player whose status is `ejected`. For `self` and `none`
  the message's `targetId` is ignored. If no valid target exists, the card cannot be played (reject it with an error).
- **A special is playable** iff `me.canPlaySpecial && !used && round ≥ minRound`, the phase fits its `timing`, and a valid target
  exists; `cancel_vote` is also unplayable outside a step while `voteMods.cancelNext` is already set. Clients derive this from the
  StateView. A rejected play changes nothing: the card stays unused and the round's allowance is not spent.
- Once revealed, a card stays revealed. Swapping or rerolling a card moves or replaces its text, and the slot counts as revealed.
  A card replaced by `reroll_card` is discarded unseen, even in the final.
- `immunity`, `protect` and `block_vote` are `before_vote`, so they never change an open ballot. `double_vote` is applied at tally
  time, so when it is played during an open ballot or a defense it already counts for that ballot or revote.

## 6. Host powers, turns, connections

- **Host** = the creator. Controls: **Next**, **Close vote**, **Kick player**, **Transfer host**, lobby **options** and **Start**, and **Play again**.
  Being ejected does not affect hosting: an ejected host keeps every host power. Only a seated player can be host.
- **Next**, depending on the context (in `lobby` and `final` it is rejected with `wrong_phase`; use Start / Play again):
  - reveal: if the current speaker has not revealed yet, the server auto-reveals for them (profession in round 1, otherwise a random hidden card). Then it advances to the next speaker, or to discussion after the last one.
  - defense: advances to the next speaker, and after the last one the revote begins.
  - discussion: starts the vote step if one is due, otherwise goes to the next round or to the final.
  - vote: the same as Close vote.
- The **speaker** may press **End turn** only after revealing (or when nothing is eligible to reveal). In defense, at any time.
- If the current speaker stops being alive during their turn (ejected by a special, or left), the game advances automatically.
- **Host passing.** The new host is the first match of: connected alive, connected ejected, alive, ejected (seat order within
  each; in the lobby every seated player counts as alive). It happens **at once** when the host leaves, and after the
  host has been disconnected for ≥ 45 s (`BUNKER_HOST_GRACE_MS`), but then only to a *connected* player (no-op if none). If nobody
  qualifies, `hostId` is `''` and the next player seated in the lobby (by `join` or `takeSeat`) becomes host. A reconnecting
  ex-host does not get it back.
- **Connections.** When a player disconnects, their seat is kept and shown as offline. They resume with their token (§7).
  A socket holds at most one identity: `create`/`join`/`resume` on an attached socket first detaches the old identity (as a
  disconnect, not a leave). Resuming an identity that already has a socket moves it to the new socket; the old one is sent
  `{t:'error', code:'replaced'}`, gets no more state, and its client must not auto-reconnect.
- **Leave.** In the lobby the player is removed. In a game a player becomes `left`, which counts as out (§2). A spectator is removed.
  The token is revoked and the server sends nothing more to that socket (the client returns to Landing by itself). A `left` player
  never comes back; in `final` leaving also sets `left` (the `final` object itself does not change) and Play again drops them.
- **Kick** (host). Any seated player or spectator except the host themself. In the lobby the player is removed; in a game a player
  becomes `left` (an ejected one too); a spectator is removed. In every case the kicked socket is sent `{t:'kicked', reason}` and its token is revoked.
- **Transfer host** goes to a seated player whose status is not `left`, other than the host.
- **Joining.** Joining a game that is already running (any phase but `lobby`), or a lobby that already has 16 players, makes the person
  a **spectator**. A spectator in the lobby can take a seat (`takeSeat`) if there is room; they keep their id.
- **Seats** are numbered 0, 1, … in join order (no shuffling). In the lobby they are renumbered without gaps when someone is removed;
  from Start on they are fixed. `takeSeat` appends. Ids are opaque strings, public, unique in the room and never reused.
- **Play again** returns to the lobby: `left` players are removed, every other player stays seated in the same order (renumbered),
  spectators stay spectators, and the host, options and log are kept. Everything else is reset (round 0, no cards or specials).
- Spectators and ejected players see **public information only**. Ejected players also see their own cards (`me`).
- **Names** are trimmed to 1–20 characters with control characters removed (empty after that → `bad_request`). A name equal to that
  of anyone in the room (players and spectators) gets " (2)", " (3)", … appended.

## 7. Wire protocol (WebSocket at `/ws`, JSON text frames)

### Client → server
```
{t:'create', name}                               -> joined + state (creator is host, phase lobby)
{t:'join', room, name, spectator?:bool}          -> joined + state
{t:'resume', room, token}                        -> joined + state | error{code:'bad_token'|'no_room'}
{t:'leave'}
{t:'setOptions', options:{speechSeconds1?,speechSeconds?,discussionSeconds?,defenseSeconds?}}  host, lobby
{t:'start'}                                      host, lobby, >= MIN players
{t:'takeSeat'}                                   spectator, lobby
{t:'kick', playerId}                             host
{t:'transferHost', playerId}                     host
{t:'reveal', category}                           current speaker, reveal phase, once per turn
{t:'endTurn'}                                    current speaker (reveal/defense)
{t:'next'}                                       host
{t:'vote', targetId}                             voter, vote phase (may change until close)
{t:'closeVote'}                                  host
{t:'special', uid, targetId?, category?}         alive player holding that special
{t:'playAgain'}                                  host, final
{t:'ping'}                                       -> {t:'pong'}
```
Room codes are 4 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I or O). Room codes are case-insensitive on input.
Before a socket has an identity, only `create`, `join`, `resume` and `ping` are accepted. `join` to an unknown room → `no_room`.
`setOptions` values are integers from 5 to 600 (seconds); omitted keys keep their value. `start` needs ≥ `minPlayers` seated
players (offline ones count and are dealt in). A successful action has no reply of its own: its answer is the next `state`.

**Error codes.** Every `error` has a `code`, and tests may assert it. When several apply, the first in this list wins:
`bad_request` (not JSON, unknown `t`, a missing or wrongly typed field, a category that is not a Category — anything a schema
check would catch), `not_in_room`, `no_room`, `bad_token`, `server_busy` (200 rooms exist), `room_full` (16 seats or 50 spectators),
`not_host`, `wrong_phase`, `not_your_turn` (reveal/endTurn by someone other than the speaker), `not_allowed` (any other rule:
unknown or ineligible id, self-vote, not a voter, ineligible category, End turn before revealing, too few players, an unplayable
special, …), and `replaced` (§6). The rate limiter drops messages silently.

### Server → client
```
{t:'joined', room, id, token}        // the client stores this for resume
{t:'state', ...StateView}             // a full per-recipient view, sent after EVERY change
{t:'error', message, code}            // message is human-readable, e.g. "It's not your turn"; code: see the list above
{t:'kicked', reason}
{t:'pong'}
```

### StateView (sent to each recipient separately: never include information the recipient must not see)
```ts
type Category = 'profession'|'biology'|'health'|'hobby'|'phobia'|'skill'|'trait'|'baggage'
interface StateView {
  serverNow: number                    // ms epoch, used by the client to correct timer skew
  room: string
  you: { id: string, name: string, role: 'player'|'spectator', isHost: boolean }
  hostId: string                       // '' when nobody qualifies (§6)
  phase: 'lobby'|'reveal'|'discussion'|'vote'|'defense'|'final'
  round: number                        // 0 in the lobby, 1..7 in a game
  maxRounds: 7
  overtime: boolean
  minPlayers: number, maxPlayers: 16
  options: { speechSeconds1: number, speechSeconds: number, discussionSeconds: number, defenseSeconds: number }
  categories: { id: Category, label: string }[]      // display order, as in §1
  catastrophe: { title: string, text: string, details: string[] } | null
  bunker: { name: string, size: string, duration: string, food: string, features: string[] } | null
  capacity: number                     // 0 in the lobby
  players: PublicPlayer[]              // ordered by seat
  spectators: { id: string, name: string, connected: boolean }[]
  me: Private | null                   // null for spectators and in the lobby
  turn: { kind: 'reveal'|'defense', speakerId: string, order: string[], index: number,
          mustReveal: Category|null, hasRevealed: boolean } | null
  vote: { stage: 'main'|'revote', ballot: number, ballots: number, candidates: string[],
          voters: string[], voted: string[] } | null
  schedule: { kicksByRound: number[], outCount: number, kicksThisStep: number, nextVoteRound: number|null }
  voteMods: { immune: string[], blocked: string[], doubleVote: string[], cancelNext: boolean }
  timer: { label: string, endsAt: number } | null   // visual only
  lastVoteResult: { stage: 'main'|'revote', tally: { targetId: string, votes: number, voterIds: string[] }[],
                    ejectedId: string|null, tie: string[]|null, random: boolean, cancelled: boolean } | null
  log: { id: number, ts: number, kind: 'system'|'reveal'|'special'|'vote'|'eject'|'info', text: string }[]  // last 200
  final: { survivors: string[], out: string[] } | null
}
interface PublicPlayer {
  id: string, name: string, seat: number, connected: boolean, isHost: boolean,
  status: 'alive'|'ejected'|'left',
  cards: Record<Category, string|null>,      // the text if revealed, otherwise null (in final: all texts)
  revealedCount: number,
  playedSpecials: { title: string, text: string }[],
  specialsLeft: number,
  unplayedSpecials?: { title: string, text: string }[]  // present ONLY in phase final
}
interface Private {                           // only the recipient's own data
  cards: Record<Category, { text: string, revealed: boolean }>,
  specials: { uid: string, title: string, text: string, effect: string,
              target: 'none'|'self'|'other'|'ejected',
              category: Category|'choose'|'random'|null,
              timing: 'anytime'|'before_vote', minRound: number, used: boolean }[],
  canPlaySpecial: boolean,                    // alive, round limit not used, and a phase where specials are allowed
  notes: { ts: number, text: string }[],      // private peek results
  myVote: string|null
}
```
The log `text` is written by the server in English. Clients render every server- or user-supplied string with
`textContent`, never with `innerHTML`.

**Field semantics** (per phase for `turn`/`vote`/`timer`: see the table in §4):
- `me` is `null` for spectators **and for everyone in the lobby**. Tell players from spectators by `you.role`, never by `me`.
- `players[]` is identical for every recipient: a player's own hidden cards are `null` there too. In the lobby every player has
  `status:'alive'`, all cards `null`, `revealedCount:0`, `specialsLeft:0`. `revealedCount` and `me.cards[c].revealed` count reveals
  made during play; the final shows every text without changing them (so clients can mark cards first seen at the end).
- `turn.mustReveal` is `'profession'` throughout round 1's reveal phase and `null` otherwise, regardless of whether that card is
  still hidden. Eligible categories = `mustReveal ? [mustReveal] : all`, keeping only hidden ones. The speaker may reveal iff
  `!hasRevealed` and some category is eligible, and may End turn iff `hasRevealed` or none is. In defense `mustReveal` is `null`
  and `hasRevealed` is `false`. `speakerId = order[index]`; players skipped because they are not alive stay in `order`.
- `vote` is non-null only in phase `vote`. `ballot` is 1-based and a revote keeps the ballot number. `me.myVote` is the recipient's
  vote in the open ballot, otherwise `null`.
- `schedule.kicksByRound` = `KICKS[N]` (7 numbers, index 0 = round 1); in the lobby, the row for the current seated count
  (`[]` under 2). `kicksThisStep`: during a step (vote/defense), the step's current ballot total; otherwise what §2 gives for the
  current round right now (0 in the lobby and final). `nextVoteRound`: the current round during a step; otherwise the first round
  `≥ round` for which §2 gives more than 0 if nothing changes (ignoring `cancelNext`); `null` in the lobby and final.
- `lastVoteResult` = the most recently closed ballot or cancellation of this game. It persists across phases until replaced and
  is `null` before the first one (Start and Play again reset it). `tally` has one entry per candidate of that ballot, 0 votes
  included, sorted by votes (descending) then seat. `tie` = the tied ids when the top was tied (after a main ballot a defense
  follows; after a revote a random pick). `random` = fate decided (a tied revote or zero votes). A cancellation or skip gives
  `cancelled:true`, `tally:[]`, `ejectedId:null` and the stage that was running (`'main'` for a skip). `ejectedId`, `tie` both
  `null` and `cancelled:false` means nobody was left to eject (§3).
- `timer.endsAt` is on the server clock (correct it with `serverNow`); `label` is free English text for display only.
- `overtime` is true from the first overtime discussion until the game ends; `round` stays 7 meanwhile. `final` is filled on
  entering the final (`survivors` = alive ids, `out` = everyone else, both in seat order) and then never changes.
- `log` ids start at 1 and only increase; Play again keeps the log.
- `Private.specials`: `timing` comes from the effect (§5), `minRound` is 2 for `eject` and 1 otherwise, and `category` is `null`
  for effects without one. `canPlaySpecial` = alive, no special played yet this round (overtime is round 7), and phase is
  reveal, discussion, vote or defense.

## 8. Code layout and ownership

```
package.json              deps: ws. devDeps: puppeteer-core. Scripts: start/test/bots/e2e. (created, don't change deps without reason)
server/index.js           HTTP static server + WS upgrade + routing + rate limits. PORT (8080), HOST (0.0.0.0),
                          BUNKER_PUBLIC_DIR (default ./public), BUNKER_SEED (a seeded RNG, for tests), BUNKER_MIN_PLAYERS (4, clamped 2..16),
                          BUNKER_HOST_GRACE_MS (45000), BUNKER_NO_LIMITS (=1 turns off the per-socket rate limits and the
                          per-IP socket cap; tests and bots only). PORT=0 picks a free port. Once listening it prints
                          `listening on http://<host>:<port>` (the real port) to stdout
server/rooms.js           room registry, sockets, tokens, per-recipient broadcast, host transfer, cleanup
server/game.js            PURE game engine: no sockets and no timers besides timestamps. Takes an rng function. Unit-testable
server/content.js         all card content + the dealer (interface below). Owned by the content author
public/                   the browser client: index.html, app.js, style.css. No build step, no CDNs, no external assets
test/engine.test.js       engine unit tests (node --test)
test/sim.test.js          full-game protocol simulations over real WebSockets against a spawned server
tools/bots.js             bot players (a CLI) so a single human can test or play
tools/e2e.js              puppeteer-core + /usr/bin/google-chrome-stable browser end-to-end run with screenshots
reports/                  every agent writes its report here as markdown
```

### Content module interface (`server/content.js`, ESM)
```js
export const CATEGORIES   // [{id, label}] in §1 order
export function createDealer(rng = Math.random) -> {
  drawCard(category) -> string          // drawn without replacement within one dealer; reshuffles if exhausted
  drawSpecial() -> { id, title, text, effect, target, category? }   // a fresh object; only §5 combinations
  drawCatastrophe() -> { title, text, details: string[] }
  drawBunker() -> { name, size, duration, food, features: string[] }   // 3–5 features
  drawBunkerFeature() -> string                                        // never repeats features the bunker already has, when possible
}
```
A `biology` card is *generated*: a sex, an age from 18 to 85 (skewed to 20–60), an orientation, and sometimes an extra note.
Professions, hobbies and similar cards get experience or severity modifiers so they rarely repeat.

### Engine interface (`server/game.js`, ESM; used by `server/rooms.js` and `test/engine.test.js`)
```js
export function createGame({ room, rng = Math.random, now = Date.now, minPlayers = 4, dealer = createDealer(rng) }) -> game
game.join(name, { spectator = false } = {}) -> { ok: true, id, role: 'player'|'spectator' } | { ok: false, code, message }
game.handle(id, msg)  -> { ok: true } | { ok: false, code, message }
                         // msg: any §7 client→server message except create/join/resume/ping, exactly as on the wire
game.view(id)         -> StateView for that recipient (serverNow = now()), or null for an unknown, removed or left id
game.setConnected(id, connected)   // feeds the `connected` flags and the host-passing order
game.passHost()       // rooms.js calls it once the host has been offline for BUNKER_HOST_GRACE_MS (§6, connected only)
```
Synchronous, deterministic for a given `rng`/`now`/`dealer`, and it never throws on bad input. Sockets, tokens, rate limits and
real timers live in `rooms.js`/`index.js`. Tests may pass a hand-made `dealer` (the content interface above) to control deals and
specials. Tokens come from `crypto.randomBytes` (≥ 128 bits), never from the seeded rng.

## 9. Robustness and security (it runs on a public IP)

- The server must **never crash** on any input. Wrap each message handler, validate every field's type and range, and ignore unknown `t` values with an error reply.
- ws `maxPayload` is 8 KB. Rate limit: about 20 messages per second per socket, with extras dropped. More than 200 messages in 10 s closes the socket. At most 40 sockets per IP, 200 rooms, and 50 spectators per room.
  `BUNKER_NO_LIMITS=1` lifts the per-socket and per-IP limits only (a full simulated game from one host socket easily exceeds them).
- The static server serves only files inside the public dir (reject traversal), with correct MIME types, and `/healthz` returns `ok`.
  `index.html` is sent with `Cache-Control: no-store`. A CSP is sent: `default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'`.
- **Hidden information never leaves the server** except to its owner. This is the core integrity property, and tests check it.
- Rooms with no connected sockets for 30 minutes are deleted.

## 10. Client requirements

- One page. Screens: **Landing** (name, then Create game / Join by code / Watch), **Lobby**, **Game**, **Final**.
  `/?room=ABCD` pre-fills the code. The lobby shows a copyable join link (`location.origin + '/?room=' + code`).
- **Identity:** `{room, id, token}` is stored in `sessionStorage` (per tab) *and* mirrored to `localStorage`. On load: if sessionStorage
  has an identity for the room (the `?room=` code, or any room when there is none), resume. If only localStorage has one, offer
  "Rejoin as <name>" **next to** the normal landing form (never instead of it; "Join as someone new" = just use the form).
  If the socket drops, reconnect automatically with backoff and resume. On `kicked`, on `bad_token`/`no_room` from a resume, and
  after sending `leave`, clear the identity from both storages and show Landing. After `replaced`, stop and do not reconnect.
- **Plain HTTP on a public IP is not a secure context:** `navigator.clipboard`, `crypto.randomUUID` and similar APIs are missing
  there, so feature-test them (copy link falls back to selecting the text / `document.execCommand('copy')`). The §9 CSP forbids
  inline `<script>` and `on…=` attributes: use `app.js` and `addEventListener`. The socket URL is
  `(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'`.
- **Game screen:** a header (room code, round X/7 or Overtime, the phase, beds `capacity` vs `alive`, and the timer), the catastrophe and bunker panel
  (collapsible on mobile), and a **player board**: one panel per player showing the 8 category slots (the text, or a face-down placeholder),
  status (alive / ejected / left / offline), host badge, current speaker highlight, voted indicator, immune/blocked/×2 badges and played specials.
  **My hand:** my 8 cards with revealed or hidden state, reveal buttons when it's my turn (only `profession` in round 1), End turn,
  my specials with a Play flow (target picker, then category picker when needed, then confirm), and private notes.
  **The action bar** tells the user in plain words what is happening and what they can do ("Your turn: reveal a card", "Vote: who stays outside?").
  **Host controls:** Next (with a label describing what it will do), Close vote, and kick or transfer on the player panels.
  **Vote UI:** vote buttons on candidates, "voted" markers, then an open results table (who voted for whom). Defense and revote are clearly signposted.
  **The event log** is a scrolling list.
- **Final screen:** "In the bunker" vs "Stayed in the forest", every card revealed, and Play again (host).
- **Look:** dark post-apocalyptic, with a hazard yellow (#f5c518-ish) on near-black. Readable, responsive
  down to 360 px wide (no horizontal scroll), and pleasant with 16 players on a laptop screen.
- `window.__bunkerState` = the latest StateView (for e2e tests).
- **Required test hooks** (stable `data-testid` attributes, used by `tools/e2e.js`):
  `name-input`, `create-btn`, `room-input`, `join-btn`, `spectate-btn`, `room-code`, `copy-link-btn`, `start-btn`,
  `lobby-player` (+`data-player-id`), `phase` (+`data-phase`), `round`, `timer`, `player-card` (+`data-player-id`, `data-status`),
  `reveal-btn` (+`data-category`), `end-turn-btn`, `next-btn`, `close-vote-btn`, `vote-btn` (+`data-player-id`),
  `special-btn` (+`data-uid`, `data-effect`, `data-target`), `target-option` (+`data-player-id`), `category-option` (+`data-category`),
  `special-confirm-btn`, `log`, `final-screen`, `play-again-btn`, `error-toast` (+`data-code`), `rejoin-btn`, `leave-btn`,
  `kick-btn` and `transfer-btn` (+`data-player-id`, on the host's lobby/game player panels).
- **Hook rules.** Both clients must behave identically here, because one e2e script drives either of them.
  - An action hook is present and enabled (no `disabled` attribute) exactly when the user can do that action now; otherwise it is
    absent or `disabled`. E2e waits for `[data-testid=X]:not([disabled])`. One click sends the action: no hover-only menus, and no
    `alert`/`confirm`/`prompt` anywhere in the client.
  - `room-code`'s trimmed text is exactly the 4-letter code. `phase` (with `data-phase` = `state.phase`) is on the game and final
    screens. `player-card` exists for every seated player on the game and final screens (`data-status` = status); `lobby-player`
    for every seated player in the lobby.
  - `reveal-btn`: one per eligible category (§7 field semantics) while I may reveal. `vote-btn`: one per candidate except me, while
    I am a voter in phase `vote`.
  - The Play flow is always: `special-btn` → `target-option`s (only when `data-target` is `other` or `ejected`; exactly the valid
    targets) → `category-option`s (only when the special's `category` is `'choose'`; exactly the allowed categories, §5) →
    `special-confirm-btn` (always shown, even when nothing had to be picked). The special's full data is in
    `__bunkerState.me.specials` by `uid`.
  - `error-toast` shows each error's `message` for at least 3 s, with `data-code` = its `code`.
  - Tip for e2e: give every simulated person its own browser context (`browser.createBrowserContext()`), because
    `localStorage` is shared inside one context.

## 11. Amendments

Record every deviation from, or clarification of, the sections above here: date, author (agent role), and what changed and why.
Keep each one short. Never change §0.

**2026-09-24, spec-critic.** Clarifications so five parallel builders fit together. The wire protocol is unchanged except that
every `error` now carries a `code` and one new code (`replaced`) exists; no §0 decision was touched.
- A1 §1: the reveal order is fixed at phase start, players no longer alive are skipped, a revived player waits a round, the
  speech timer starts with the turn, and someone else's special never counts as the speaker's reveal.
- A2 §1: the end check also runs after a leave or kick (these lower `alive` as well).
- A3 §2: the formula is re-evaluated before every ballot (a mid-step leave would otherwise over-eject); a 0-kick step does not
  exist (it neither consumes `cancelNext` nor clears modifiers). Fixed a contradiction: overtime starts with a discussion, as
  §4's diagram says, not "right away".
- A4 §3: candidates and voters are computed at ballot open; no candidates → the step is cancelled; no voters → zero votes;
  revote voters defined; zero votes in a revote; the next ballot opens immediately; the leave/kick-during-a-step rule; modifiers
  are also cleared by a cancelled or skipped step.
- A5 §4: when `cancelNext` is consumed and what a mid-step `cancel_vote` does; a table of `turn`/`vote`/`timer` per phase
  (`vote` is `null` during defense).
- A6 §5: `swap_card`/`reroll_card` with `'choose'` accept any category; valid targets per effect; ignored fields; a playability
  rule clients can derive; a rejected play costs nothing; `cancel_vote` cannot stack on `cancelNext`; a rerolled-away card is never
  shown. Removed the rule about immunity landing mid-ballot: `immunity`/`protect` are `before_vote`, so it could never apply;
  replaced it with `double_vote` timing, which could.
- A7 §6: an ejected host keeps hosting; Next in lobby/final; End turn in defense; the host-passing order (immediate when the
  host leaves, `hostId ''` when nobody qualifies); one identity per socket and `replaced`; what leave does to the token and in the final;
  who can be kicked or made host; seats and ids; exactly what Play again keeps; name de-duplication.
- A8 §7: the messages allowed before joining, the `setOptions` range (5–600 s), no acknowledgement other than `state`, and the
  error codes with their precedence (so tests can assert them).
- A9 §7: a "Field semantics" block for every StateView field a client or test would otherwise guess (`me` is `null` in the lobby,
  `mustReveal`, `schedule.*`, `lastVoteResult` lifetime and shape, `final`, `log` ids, specials' `minRound`/`timing`).
- A10 §8: an engine interface (`createGame`/`join`/`handle`/`view`/`setConnected`/`passHost`) so `test/engine.test.js` can be
  written in parallel with `game.js`; the env vars `BUNKER_HOST_GRACE_MS` and `BUNKER_NO_LIMITS`; `PORT=0` plus a "listening"
  line; the `BUNKER_MIN_PLAYERS` clamp; tokens come from `crypto`, not the seeded rng.
- A11 §9: `BUNKER_NO_LIMITS=1`, because a simulated game from one host socket goes over 20 msg/s and 200 msg/10 s, and the
  dropped messages would stall the tests silently.
- A12 §10: identity edge cases; plain HTTP is not a secure context (no `navigator.clipboard`/`crypto.randomUUID`); the CSP
  forbids inline scripts; the socket URL; new hooks (`data-effect`/`data-target` on `special-btn`, `data-code` on
  `error-toast`, `rejoin-btn`, `leave-btn`, `kick-btn`, `transfer-btn`) and hook rules (enabled means actionable, a fixed Play
  flow, no native dialogs, a browser context per e2e user).
- A13 §2 KICKS was checked and left unchanged: every row sums to ceil(N/2), round 1 never votes, the rows grow with N, and the
  formula without events reproduces each row exactly, ending after round 7 with `alive = floor(N/2)` and no overtime; 20k random
  games with leaves, revives, ejects, capacity ± and cancels all ended.

**2026-09-24, content.** Clarifications of the §8 content interface; nothing in the interface changed.
- C1 `drawBunker()` sets its `duration` inside the "safe in" estimate of the most recently drawn catastrophe, so call
  `drawCatastrophe()` first (the order §1 lists them, and what `game.js` does). With no catastrophe drawn yet, any 6 months–6 years.
- C2 `drawSpecial()` omits `category` for effects that take none. Each dealer deals every special once before any repeats, so an
  effect's frequency is its number of cards (54 in all; `eject`, `revive`, `capacity_plus` and `capacity_minus` have 1 each).
- C3 `drawCard(category)` throws a `TypeError` for an id that is not a Category (a programming error; callers validate first).
- C4 `drawBunkerFeature()` avoids the features of the bunker from the latest `drawBunker()` plus the ones it has added since.

**2026-09-24, server.** Clarifications from building `server/`; the wire protocol and StateView are unchanged.
- S1 §8: once listening, the server prints two stdout lines, `BUNKER_LISTENING <port>` (for scripts), then
  `listening on http://<host>:<port>`; diagnostics go to stderr. A relative `BUNKER_PUBLIC_DIR` resolves against the repo
  root, not the cwd (default `<repo>/public`).
- S2 §7 codes for `special`: in lobby/final, or in a phase outside the card's timing (a `before_vote` card during vote or
  defense) → `wrong_phase`; every other reason (uid not held, not alive, used, round limit, `minRound`, bad target or
  category, `cancelNext` already set) → `not_allowed`. `takeSeat` follows the §7 order literally: 16 seats → `room_full` first.
- S3 §1: no special ever counts as the turn's reveal, not even the speaker's own.
- S4 §3: after a mid-ballot leave/kick, voters left without a valid target (only themselves remain) are dropped from `voters`
  too, or the auto-close would wait for someone who cannot vote. A zero-vote ballot reports `tie: null, random: true`.
  `cancel_vote` played during a defense reports `stage: 'main'`.
- S5 §5: dealt specials are normalized by the effect table: a target the effect does not allow becomes its first allowed
  target, an invalid category becomes `'choose'` (also a fixed category on `force_reveal`/`peek`), and an unknown effect is
  redrawn (fallback: a `bunker_add_feature` card). A player who stops being alive loses their vote modifiers.
- S6 §6/§9: a kicked, left or replaced socket stays open without an identity, so the client can create/join again. A room
  whose last member leaves is deleted at once. Ids are `p<n>` and special uids `s<n>` (opaque, never reused in a room).
- S7 §6 names: besides Cc control characters, bidi marks/overrides/isolates, U+2028/2029, U+200B and U+FEFF are removed.
- S8 §9 static: only GET/HEAD (else 405); `..` after decoding → 403, dotfiles → 404, symlinks leading outside → 403;
  `index.html` is `no-store`, other files `no-cache`; the exact §9 CSP plus `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`. WebSocket upgrades only on `/ws` (else 404); the per-IP cap answers 429; a 30 s ping/pong
  heartbeat drops dead sockets.
- S9 §9 static (2026-09-26, "the audio is not playing on the test build"): files answer byte ranges like the production
  proxy does, since Safari and every iOS browser play no media without them and Chrome cannot seek. `Accept-Ranges: bytes`
  on every file; a GET with one range (`a-b`, `a-`, `-n`) → 206 with `Content-Range`; a malformed `bytes` range, one past
  the end, or `-0` → 416 with `Content-Range: bytes */size`; several ranges or another unit → 200, the whole file
  (multipart is not implemented); HEAD ignores Range; an `If-Range` other than the file's `Last-Modified` → 200. Every
  S8 rule and header holds for 206 and 416 too (`test/static.test.js`).

**2026-09-24, tests.** What the simulations and tools rely on; no protocol change.
- T1 §7 ordering: each socket's messages are handled in order, and every `state` a message causes is sent before the reply to
  the socket's next message. Bots follow each action with `{t:'ping'}`: an `error` before that `pong` belongs to the action, and
  it counts as a race only if a `state` arrived in between. Keep this ordering (no deferred or batched sends that could overtake
  a later reply).
- T2 §7 broadcasts: every change goes to every connected recipient. The simulations compare each recipient's sequence of public
  views (StateView minus `serverNow`, `you` and `me`) with a spectator's sequence, so a broadcast that skips one socket fails
  them. Coalescing several changes into one broadcast is fine if every recipient gets the same one.
- T3 tools: `tools/e2e.js` takes `--url` (a running server) or spawns `server/index.js` itself (`PORT=0`,
  `BUNKER_PUBLIC_DIR` from `--public-dir`, `BUNKER_MIN_PLAYERS=2`, `BUNKER_NO_LIMITS=1`). `tools/bots.js --help` documents the
  bot CLI. Against a server with limits on, bots keep to 16 messages per second, because each action plus its ping counts as 2.

**2026-09-24, integration.** Clarifications from the integration pass; the wire protocol and StateView are unchanged.
- I1 §7: a `setOptions` value that is not an integer from 5 to 600 fails the schema check, so the code is `bad_request`
  (which also wins over `not_host`/`wrong_phase`). The tests now assert exactly this.
- I2 §9/S6: a room is deleted at once when nobody is left in it, meaning no spectator and no seated player whose status is
  not `left`. In a game, `left` players stay listed but can never return, so before this a game abandoned with `leave`
  held one of the 200 room slots for the 30-minute idle TTL.
- I3 §1: when the game ends in the middle of a reveal turn or a discussion (a special, a leave or a kick brings
  `alive ≤ capacity`), that turn or discussion just stops. There is no auto-reveal and no vote; the final shows the rest.

**2026-09-25, client-finalizer.** The shipped client (`public/`, from client B plus grafts from A); the protocol is unchanged.
- F1 §10 hook rule: to stop double sends, the client keeps `reveal-btn`, `end-turn-btn`, `next-btn`, `close-vote-btn`,
  `start-btn` and `play-again-btn` disabled from a click until the answering `state` arrives and at least 650 ms have
  passed, and keeps `next-btn`/`close-vote-btn` disabled for 350 ms after the turn or ballot changes (a click aimed at the
  previous speaker or ballot must not land on the next one). "Enabled exactly when the user can act now" therefore allows
  these short windows; `tools/e2e.js` re-reads `next-btn` for up to ~1.5 s (as `stableHooks` already does for the other
  hooks) before reporting it missing.
- F2 §10 host tools: `kick-btn`/`transfer-btn` stay present on every panel the host can act on (the rule above), but as
  small neutral icon buttons next to the player's name, never in the Vote column.
- F3 tools: `tools/e2e.js` also lets its paused bot (kept from voting to exercise Close vote) play again when that bot
  has to give a defense speech; before, a blocked paused bot in a tie never ended its speech and the run stalled.

**2026-09-25, client-fixer (round 1).** Protocol addition for the crossing-click race (the shipped client always sends it).
- R1 §7 step key: `reveal`, `endTurn`, `next`, `closeVote` and `vote` may carry an optional
  `at: {phase, round, overtime, turnIndex, ballot, stage}`, copied from the StateView the click was made on: `phase`, `round`
  and `overtime` as in the view, `turnIndex` = `turn ? turn.index : null`, `ballot` = `vote ? vote.ballot : null`,
  `stage` = `vote ? vote.stage : null`. When `at` is present and any of these fields differs (`===`) from the current step,
  the server answers `wrong_phase` and changes nothing. Without `at` (bots, tests) a message is handled as before. Why: a
  speaker's End turn or a last vote and the host's Next or Close vote sent at the same moment (the timer hitting 0:00) used to
  both land, so the second one hit the next speaker or ballot: a skipped speaker with an auto-reveal, a skipped discussion,
  or a revote or 2nd ballot closed with 0 votes and a random ejection.

**2026-09-25, server-fixer (round 1).** Server side of R1, plus fixes from the round-1 review. The StateView is unchanged.
- R2 §7 step key, server side: R1 is implemented as written. Details: `at: null` counts as absent. A key missing from `at` is
  not compared, and unknown keys are ignored. A wrongly typed `at` (not an object, `round` not an integer, and so on) is
  `bad_request`. The stale check runs after `not_host` and the phase check and before `not_your_turn`/`not_allowed`.
  `next` in the lobby or the final keeps its own `wrong_phase` message. Bots (`tools/botlib.js`) send `at` by default
  (opt out with `stepKeys: false`), so a bot host's Next can no longer skip a human speaker either. Known limit: the six
  fields cannot tell two overtime discussions in a row apart. They also cannot tell apart a defense turn whose speaker left
  from the next speaker's turn, because the next speaker takes the same index. A crossing click there can still land.
- V1 §6/§9 room slots. (a) When a socket that is the only member of a lobby (no other seat, no spectator) sends
  `create`/`join`/`resume` for another room, that lobby is deleted instead of detached. Nobody could ever return to it.
  A mere disconnect is unchanged, so a lone host can still reload and resume. (b) One network may have created at most
  5 live rooms (`MAX_ROOMS_PER_IP`; a network is an IPv4 address, IPv4-mapped IPv6 included, or an IPv6 /64). At the
  cap, that network's oldest abandoned lone lobby (no socket, at most one member) is deleted to make room; otherwise
  `create` gets `server_busy` with its own message. `BUNKER_NO_LIMITS=1` lifts (b). The 200-room cap and the 30-minute
  idle TTL are unchanged. Why: one socket that re-sent `create` held every one of the 200 slots for 30 minutes.
- N1 §6/S7 names: NFC, then remove Cc, every Cf character except a zero-width joiner inside an emoji sequence,
  U+2028/2029, U+034F and the blank-rendering characters U+115F, U+1160, U+3164, U+FFA0 and U+2800. Whitespace runs
  become one space. A name with no letter, digit, punctuation or symbol left is `bad_request`. The " (2)" rule
  compares names after NFKC with variation selectors and joiners removed, so "P0" + U+2060 is "P0 (2)".
- L1 logs and card texts, rules unchanged. A revive during a reveal phase is logged as "(they still get their turn this
  round)" when the player is still ahead in the phase's order, "(from the next round on)" otherwise, and with no suffix in
  round 7. A skipped or cancelled vote step logs the immunity, vote blocks and ×2 it uses up (§3 still clears them). The
  immunity, protect, block and double-vote card texts now say that a cancelled vote uses them up too.
- C5 content: Biology says "gay" (Male) or "lesbian" (Female) instead of "homosexual". The pacemaker card reads "battery
  good for N years more". The Biology card dealt right after a Profession (the engine's deal order) gets an age that fits
  that profession's years: nobody is "retired after 30 years" at 23, and no first-year student is 80. Ages stay 18–85.
- T4 tests: `test/sim-fuzz.test.js` "server_busy (200 rooms)" now fills the server with 200 rooms from sockets that went
  away (rooms stay for the idle TTL), because one socket re-creating no longer piles rooms up. `test/helpers-sim.js`
  `runTable` waits up to 5 s for a connected host before Play again, because a host that dropped just before the final
  may still be resuming (a harness race the soak hit). `test/regressions-r1.test.js` covers everything above.

**2026-09-25, client-fixer (round 1), client rules.** The shipped client after the round-1 review; R1 above is its protocol part.
- K1 §10/F1: `vote-btn` (and the matrix/panel vote buttons) join the F1 guard. They stay present for every voter but are
  disabled from a vote click until the answering `state` has arrived and 650 ms have passed, and for 350 ms after the ballot
  or revote changes, so the second click of a double click can never vote in the next ballot or for another name.
  `tools/e2e.js` checks that every `vote-btn` is disabled right after a vote.
- K2 §10 hook rule "one click sends": exception for `leave-btn` (a seated player whose status is not `left`) and `kick-btn`
  (a seated player) in every phase but the lobby. Both are for good there (§6), so the first click only arms the button
  for 4 s ("Tap again to leave" / "Remove?") and the second click sends. The lobby and spectators keep one click.
  `leave-btn` is disabled while the client is offline: a leave that cannot be sent keeps the identity (§10 clears it only
  after sending `leave`). On phones in play, `leave-btn` sits at the foot of the page, not above the jump chips.
  `tools/e2e.js` checks that one click on each sends nothing.
- K3 §10 connection: the client treats a socket as dead when a sent action gets no message back within 4 s, when an idle
  socket's ping gets no answer within 8 s (pings every 5 s), or when a new socket does not open within 8 s or its
  create/join/resume gets no answer within 8 s. It then drops that socket at once and reconnects, instead of waiting for a
  close event that a silent network switch never sends. Coming back online or back to the tab retries a waiting or stuck
  reconnect at once and pings an open socket (3 s).
- K4 §10 landing: opened from `/?room=CODE`, the form leads with the name and "Join room CODE" (`join-btn`, the primary
  button); `room-input` (pre-filled), `spectate-btn` ("Just watch") and `create-btn` ("Start a different game of my own",
  secondary) stay present with the same enabled rules. Without `?room=` the form is unchanged.
- K5 §10 screens: a "Rules" button in the header (every in-room phase) opens a "How to play" sheet. The special picker and
  that sheet get a history entry, so the phone's Back button closes them instead of leaving the page. The final banner
  names what ended the game (the deciding vote, the special, or the leave/kick logged just before "the bunker door
  closes"), and at the final a vote that did not end the game is labelled "Earlier vote". A client that just entered the
  final scrolls its hero into view.

**2026-09-25, server-fixer (round 2).** Fixes from the round-2 review. The StateView is unchanged; `special` gains the R1 key.
- R3 §7 step key on `special`: it may carry the same optional `at` as R1 (the client sends `stepAt(state)` of the view the
  card was confirmed on). The server compares `phase`, `round`, `overtime`, `ballot` and `stage`, but not `turnIndex`: whose
  turn it is does not change what a card does. The check runs right after the lobby/final check and before every other one,
  so a stale key is `wrong_phase` and nothing is spent (card, round allowance). Validation as in R2; without `at` as before;
  bots send it. Why: a Cancel vote made on an open ballot that arrived just after the last vote closed it cancelled the
  *next* round's vote and spent that round's allowance, while the ejection it was meant to stop went through. Also, a ×2
  made on the main ballot that arrives in the defense is now refused (play it again there; §5 still applies).
- R4 §2/§7 during a step, a leave, kick or `capacity_plus` re-evaluates the total at once:
  `vote.ballots = (ballot − 1) + max(1, kicksThisStep)`. The open ballot (with its defense and revote) still runs to the end
  (§3), so it always counts as one; `schedule.kicksThisStep` follows `vote.ballots`. When the total drops and that ballot
  goes on, a `vote` line says why: "Round 6 — with P1 gone, one ejection fewer is due: this vote now has 1 ballot instead
  of 2" (or "with the extra bed"). If a step ever ends with fewer ballots than it showed, "no more ejections are due in
  this vote" is logged. Before, the view kept "Vote 1 of 2" and ballot 2 silently never came.
- L2 logs, rules unchanged. A step cancelled after one of its ballots already ejected someone (Cancel vote in ballot 2,
  or everyone immune at ballot 2) logs "no further ejections in this vote" instead of "the vote ends without an ejection",
  and Cancel vote's result reads "the rest of the vote is cancelled right now; the kicks still due carry over".
  `lastVoteResult` still becomes the cancelled result (§7). An in-game kick is logged "X was removed by the host" (it read
  "… by the host the game"); the client's final banner matches that phrase.
- H1 §6 the host grace is counted from the later of the host's disconnect and the moment they got the role (transfer,
  passing, or a join into an empty seat list). "Make host" on an offline player still works; that player now gets the full
  45 s instead of losing the role at the next sweep (0.5 s) to whoever sat first.
- V2 §7/§9 failed room lookups per network (the V1 network key): a `join` or `resume` naming a room that does not exist,
  or a `resume` with an invalid token, uses one of 20, which refill at one per 3 s. With none left, `join` and `resume` get
  `server_busy` ("Too many wrong room codes from your network…") before the room is looked up, so the answer does not reveal
  whether a code exists. Successful lookups use nothing. `BUNKER_NO_LIMITS=1` lifts it. One address now needs about 11 days,
  not minutes, to scan all 331,776 codes. Not done: a lobby lock or a lasting lobby kick (S6 lets a kicked socket join the
  lobby again as a new player); that needs a host control in the client and is left to the owner.
- C6 content. "Back from the Forest" no longer promises a turn in a later round: "They get no turn in a reveal phase that
  began without them, and round 7 has the last reveal phase." Cards that reveal a category for every alive player go from
  9 to 3 (kept: Medical Commission, Census, Luggage Carousel). The six new cards reveal nothing: 2 peek (Bribed Guard,
  Wiretap), 1 protect (Human Shield), 1 double_vote (Kingmaker), 2 bunker_add_feature (Supply Drop, Maintenance Log). Still
  54 cards covering all 16 effects (C2 holds). In the playtest simulation (8 players who each play both specials), empty
  round-7 turns dropped from 63% to 35%, and games where no survivor has a hidden card left at the final from 65% to 38%.
- T5 tests. `test/helpers-sim.js` Checker: every vote view must satisfy R4. A reveal turn cut short because the speaker
  was ejected during it no longer counts as a turn that needed a reveal: a speaker revived later in the same phase was
  flagged (soak). `runTable` now takes the host from the reference stream's `hostId`. Before, a dropped ex-host that was
  still resuming could look like the host from its stale state and press Play again (`not_host`). New:
  `test/regressions-r2.test.js`, plus two `test/checker.test.js` cases.

**2026-09-25, client-fixer (round 2).** The shipped client after the round-2 review. Its only protocol use is the
special's step key, whose server side is R3 (server-fixer, round 2).
- K6 §10/F1 click-through guards. (a) When the special picker or the rules sheet closes (Play, Cancel, ×, the backdrop,
  Got it, Esc, Back, or by itself) or a panel is shown or hidden (Situation, Last vote, a player row, the board view,
  the round-1 briefing), every action outside an open overlay is held for 500 ms: its hooks are `disabled` and the click
  handler ignores clicks. On phones the sheet's Play / Got it sits over the action bar, so the second tap of a double
  tap cast a vote, revealed a card, pressed Next (a skipped speaker) or Start. (b) `target-option`, `category-option`
  and `special-confirm-btn` are disabled for 400 ms after the picker opens or changes step, and its backdrop ignores a
  click then, so a double click on a target never plays the card without its Confirm step. (c) `kick-btn` and
  `transfer-btn` join the F1 lock (disabled from the click until the answering `state` + 650 ms) and are disabled for
  350 ms after the list of players or spectators changes: a lobby row that slid up under the pointer took the second
  click (a second player kicked). (d) K2's confirming click counts only 450 ms or more after the arming click (until
  then the armed button is `disabled`), and arming also starts the hold of (a), because the wider armed button moves the
  row under the pointer: a double click neither leaves nor kicks, nor lands on anything else. `tools/e2e.js`
  double-clicks (150 ms apart) `leave-btn` and `kick-btn` in its K2 check and expects nothing sent and no row expanded,
  and checks that no action hook is enabled right after Play closes the picker.
- K7 §7/R3 the client sends `at` on `special`: the R1 key without `turnIndex` (`{phase, round, overtime, ballot,
  stage}`), and a confirmed play takes the F1 lock. A picker for `cancel_vote` or `double_vote` opened during a vote
  step closes, with a note and nothing played, when that step ends or ejects someone (the card would silently apply to
  the next vote). Ejection flashes show while the picker is open. `tools/e2e.js` checks the special's `at` like R1's.
- K8 §10 screens. The round track projects the votes with the §2 formula from the current state (who is out, alive,
  beds, `cancelNext`) instead of showing the start-of-game KICKS row: played rounds dimmed, the current round as the
  server counts it, later rounds "if nothing changes", a vote cancelled by a special struck through, and an overtime
  cell when round 7's vote is cancelled. "Vote X of Y" shows `min(vote.ballots, ballot − 1 + max(1, §2 now))`, R4's
  value. The desktop rail is hand → specials → situation → log. In round 1 a dismissible briefing (catastrophe, bunker,
  beds) opens the table wherever the full Situation panel is not already open. The bar names the card the speaker
  revealed. An offline speaker or voter is marked in the bar, the speaking order and "Waiting for". The host's Next is a
  quiet button while the speaker is online and within their time, and Close vote is primary only when every missing
  voter is offline and says "fate picks at random" at 0 votes (both still send on one click). Host changes are flashed
  with their reason, and the new host is told. The beds line stops saying "half of the players" once a special changed
  the beds.
- K9 §10 landing, an exception to K4: when the invite is for the room this browser already holds a seat in (the "Rejoin
  as" offer is for that room), `join-btn` is a secondary "Join as a new player" (same testid and enabled rules), the
  hint points to Rejoin, and Enter in the name field rejoins. A `no_room` answer to a join from an invite link drops the
  invite and `?room=`, and the landing says the room is gone.

### X1: Airlock needs a partner, and a revive is guaranteed (2026-09-25, owner request; this overrides §5 wherever they conflict)

The owner found the one-person `eject` card ("Airlock") cheesy: one player could remove another with no discussion. It is redesigned as a **cooperative** card, and a counter to it is always dealt.

**1. `eject` is gone.** No card uses the `eject` effect. The engine may keep it for backward compatibility, but content must never deal it.

**2. The new effect `airlock`:** target `other`, timing `before_vote`, `minRound` 2, and the §5 limit of one special per player per round still applies.
   - Suppose player A plays Airlock on target T.
     - **If an airlock on T is already open this round** and was started by a *different* player B, T is ejected immediately, with no vote. It counts as out for §2, the end check runs (A2/I3 apply), and the airlock closes.
       Log (kind `eject`): `🚪 {A} sealed the airlock with {B} — {T} is thrown out of the bunker, no vote!`
     - **Otherwise** A opens an airlock on T, `{targetId: T, byIds: [A], round}`.
       Log (kind `special`): `🚪 {A} started cycling the airlock on {T}. If one more Airlock card is played on {T} before the vote, {T} is out — no vote.`
   - Several airlocks can be open at once, each on a different target. Airlocks on different targets never combine.
   - **An open airlock expires** in any of these cases, with log `🚪 The airlock on {T} jammed — nobody closed it.` (kind `special`). The card that opened it stays spent.
     - when the discussion phase of its round ends, whether that leads into the vote step or into the next round
     - immediately, if T is no longer alive
     - when the game reaches final
     - in overtime, when the overtime discussion ends

**3. The deal (in `start` and in `playAgain`).** Let N be the number of seated players at start.
   - If **N ≥ 4**, the deal includes `AIRLOCKS(N)` Airlock cards and `REVIVES(N)` "Back from the Forest" (`revive`) cards:

     | N | Airlocks | Revives |
     |---|---|---|
     | 4–7 | 2 | 1 |
     | 8–11 | 3 | 1 |
     | 12–16 | 4 | 2 |

   - Each Airlock goes to a **different** random player, so nobody holds two. Each revive goes to a random player who holds **no** Airlock and no other revive. N ≥ 4 always has enough players for this.
   - These cards fill one of that player's 2 special slots. Every other slot comes from `drawSpecial()`, which **never** returns `airlock`, `revive` or `eject`.
   - If **N < 4** (test games only), there are no Airlocks and no revives.
   - The deal is random but must follow the seeded rng (`BUNKER_SEED`).

**4. Revive** stays as in §5 (target `ejected`, `before_vote`). Its text must say it brings back anyone who was ejected, **whether by vote or by airlock**.

**5. The StateView gains one public field:** `airlocks: { targetId: string, byIds: string[], round: number }[]`, listing the open airlocks. It is `[]` when none are open, including in the lobby and the final.
   - Private `me.specials` entries for Airlock have `effect:'airlock'`, `target:'other'`, `category:null`, `timing:'before_vote'` and `minRound:2`.

**6. Content** (`server/content.js`) exports the two fixed card definitions, so the engine can deal them:

   ```js
   export const AIRLOCK_CARD = {
     id: 'airlock', title: 'Airlock', effect: 'airlock', target: 'other',
     text: 'Needs a partner. Choose a player to start cycling the airlock on them. If another player plays an Airlock on the same player this round before the vote, they are thrown out — no vote. Alone, the airlock jams.',
   }
   export const REVIVE_CARD = {
     id: 'revive', title: 'Back from the Forest', effect: 'revive', target: 'ejected',
     text: '...' /* brings back anyone ejected, by vote or by airlock */,
   }
   ```

   The random pool keeps its other cards. Remove the old "Airlock" (`eject`) card and the random revive card from the pool.

**7. Client**
   - Show each open airlock prominently on the target's panel, e.g. `🚪 AIRLOCK 1/2 · started by Anna`, and in the action bar or situation area for everyone.
   - When the viewer holds an unused, playable Airlock and an airlock started by someone else is open, the Airlock card and the target picker must make "join the airlock on {T}" obvious (for example, highlight T in the picker).
   - The How to play sheet explains the pairing, the jam, and that a revive always exists.

### X2: running behind a reverse proxy (2026-09-25, deployment)

Production runs behind Caddy (`deploy/provision.sh`), so every socket's TCP peer is 127.0.0.1.

- New env `BUNKER_TRUST_PROXY=1`, off by default. When it is set **and** the TCP peer is loopback (127.0.0.0/8, `::1`, or `::ffff:127.*`), the client address for every per-IP or per-network limit and key (MAX_SOCKETS_PER_IP, the V1/V2 network keys, and any other IP-based accounting) is the **last** entry of `X-Forwarded-For`.
- Caddy writes the real client IP there. Earlier entries come from the client, so they are ignored.
- If the header is missing or unparsable, the peer address is used.
- When the variable is not set, `X-Forwarded-For` is ignored completely.
- The production unit sets `BUNKER_TRUST_PROXY=1`.

### X3: explain special cards wherever they appear (2026-09-25, owner request)

The owner saw only card *names* after specials were played or revealed, and could not tell what they do.
- **Wherever a special card's title is shown, its full rules text is available on hover (desktop) and on tap (touch).** Use an accessible popover/tooltip, not the native `title` attribute alone: it must work on phones and must not be clipped by scroll containers.
- This covers every place a title appears:
  - `players[].playedSpecials`
  - `players[].unplayedSpecials` in the final
  - the viewer's own `me.specials` (hand and picker)
  - the special picker
  - **event log entries that mention a special's title.** Match against every title/text pair the client has seen in the state (played specials, own hand, final unplayed). Where no text is known, render the title plainly.
- Style card titles as recognisable "card chips" (for example a small hazard-yellow outline), so players learn they can be hovered or tapped.
- Revealed characteristic cards whose text is clamped or truncated must likewise show the full text on hover or tap.

### X4: estimated game length in the lobby (2026-09-25, owner request)

The "If you start now" lobby panel shows an **estimated game length**. It recomputes live when players join or leave, when the host switches the Quick/Standard/Relaxed presets, and on every edit to a timer field, including edits not yet sent. Every viewer sees it, not only the host.

Deterministic client-side formula. N is the seated players, or `minPlayers` if fewer have joined, in which case label it "with {minPlayers} players (minimum)". The options are s1, s, d and def.

```
alive = N; t = 120                      // setup reading + final reveal
for r in 1..7:
  t += alive * ((r == 1 ? s1 : s) + 10) // each turn + ~10 s handover/clicking
  t += d                                // discussion
  for each of KICKS[N][r] ballots:
    t += 45 + 0.3 * (2 * def + 45)      // voting ~45 s; ~30% of ballots tie -> 2 defenses + revote
  alive -= KICKS[N][r]
```

- Display it as `≈ {round(t/60/5)*5} min`, with a floor of 5, plus a subtle range `({floor(0.8t/60)}–{ceil(1.25t/60)} min)`.
- Add a one-line note: "Timers are a guide, so the real pace depends on the host's Next."
- Put the KICKS table in one shared client module. It must be identical to SPEC §2.
- Sanity check: with Standard (60/30/90/30) and 6 players it comes to ≈ 45 min.

**2026-09-25, feature-server.** Server side of X1 and X2. The only StateView change is X1's `airlocks`.
- Y1 X1 logs. Airlock plays log exactly X1's lines (no "Round N —" prefix, no generic "played …" line). The card still goes
  into `playedSpecials`, for the opener and for the partner. A sealed airlock is kind `eject`, like a vote ejection; clients
  tell them apart by the leading 🚪. Jammed lines come in opening order, logged: at the end of a discussion, before any
  vote or round line; when the target leaves or is kicked, right after that line; at the final, right **after**
  "The bunker door closes", so the line before it is still the move that ended the game.
- Y2 X1 play. If the opener stops being alive (leaves, is kicked, or is thrown out), their airlock stays open, a
  different player can still seal it, and the line names the opener. Nobody can seal their own airlock (`not_allowed`;
  the one-per-round limit already prevents it). Immunity and protect do not stop an airlock (the card says so).
  `cancel_vote` does not touch airlocks. A victim can be revived; the old airlock does not reopen, and a new Airlock on
  them opens a new one. In overtime `round` is 7.
- Y3 X1 deal. The engine uses the game rng to pick the Airlock and revive holders before it deals the cards. The fixed
  card goes into a random one of the holder's 2 slots; `drawSpecial()` fills every other slot. If a dealer offers an
  `airlock`, `revive` or `eject`, the engine draws again. The engine exports `fixedDeal(n)`. `createGame({ fixedSpecials:
  false })` (also a `Rooms`/`startServer` option) turns the fixed deal off, so a hand-made test deal controls every
  slot. Only tests do this. The engine still runs `eject` for such deals; the strict schema, the Checker and `botlib`'s
  `EFFECT_RULES` treat an `eject` in a hand as a violation.
- Y4 X1 content. The random pool has 52 cards over 14 effects. `content.js` also exports `FIXED_EFFECTS`. The Airlock
  text adds "From round 2, during a reveal or discussion phase", "when the discussion ends" and "Vote immunity does not
  stop it." to X1.6's text. The revive text reads "…an ejected player, whether they were voted out or thrown out
  through the airlock…".
- Y5 X2. The flag is on only for exactly `BUNKER_TRUST_PROXY=1`. A header entry may be an IPv4 or IPv6 address, an IPv4
  address with a port, or an IPv6 address in brackets with or without a port. An IPv4-mapped entry counts as IPv4. A
  loopback peer also includes `::ffff:7f00:1` and the full `0:…:1` form. Anything else in the last entry falls back to
  the peer. The resolved address keys MAX_SOCKETS_PER_IP exactly, and V1/V2 through `ipKey()`.
- T6 tests. New: `test/airlock.test.js` and `test/proxy.test.js`. The Checker checks the X1 deal at every final (option
  `checkDeal`) and flags an ejection outside a vote that is not a two-player same-round airlock. It also flags an
  airlock that opens without the card and log line, closes unsealed without a jammed line or at the wrong time, or
  outlives its discussion. `runTable` quiesces again after its scenario tasks, because a resume that landed on the final
  reached the reference after `finish()` (soak). Bots take `airlockJoin` (0.75), `airlockOpen` (0.3) and
  `reviveVictims` (0.5) when `specials` > 0.

**2026-09-25, feature-client.** The shipped client for X1.7, X3 and X4. The protocol is unchanged.
- FC1 X1.7. An open airlock whose target is alive shows in three places. On the target's panel it is `airlock-badge`
  (+`data-player-id`, `data-count`), reading "AIRLOCK 1/2 · started by {names}". It is also a red alert at the top of the
  table (`#sec-airlock`) and a line in the action bar. The viewer "can join" when three things hold: their unused Airlock
  is playable now (§5), someone else opened the airlock this round (the server's `round` + `byIds` test), and the
  airlock is not on the viewer. Then:
  - the card shows `airlock-join-hint` (+`data-player-id`, the target ids, space-separated);
  - its `special-btn` reads "Join the airlock…";
  - the alert gets an `airlock-join` button, which opens the same Play flow (there is still only one `special-btn`);
  - the target step lists those players first, as `target-option[data-airlock="join"]`.
  If the chosen target's airlock opens or jams while the picker is open, a note says so and Play is held for 400 ms (as
  in K6b). When a seal (a 🚪 `eject` line) ends the game, the final banner reads "Sealed by the airlock", not "The last
  vote". "Jammed" lines never count as the cause.
- FC2 X3. A chip is `button[data-testid=card-chip][data-title]`. The popover is a single
  `#card-pop[role=tooltip][data-testid=card-popover][data-title]`:
  - it is in the DOM only while open, `position: fixed` at z-index 90 (above the picker), and kept 8 px inside the
    viewport; its anchor gets `aria-describedby`;
  - a mouse hover or keyboard focus shows it, and a click or a tap pins it;
  - Esc, a tap on it, a tap elsewhere, or the anchor leaving the page closes it.
  Exception to §10's "one click sends": while a *pinned* popover is open, a touch or pen tap elsewhere only closes it.
  That tap is swallowed, so it cannot land on Next or a vote underneath. A mouse click closes the popover and still acts.
  The log turns into chips only *quoted* titles (“T”, «T», "T") and the first "airlock" of a 🚪 line. The quotes are
  needed because some titles are ordinary words on characteristic cards (Bodyguard, Gossip, Megaphone). The chip replaces
  the quotes, and a special line's own card text is dimmed. Card texts come from every title/text pair seen in a state,
  plus the pair that a special's log line quotes. The native `title` tooltips on chips and on revealed table cells are
  gone. Clamped table cells (`data-pop="clamp"`, `tabindex=0` in the table view) and the bar's shortened reveal quote open
  their full text in the same popover. An unclamped cell opens nothing. Not chips: the 4 s flashes (they ignore the
  pointer) and titles inside buttons ("Play Airlock").
- FC3 X4. `public/kicks.js` holds `KICKS` (checked equal to §2), `estimateGame(n, options)` and `airlockDeal(n)`.
  `app.js`, `mock.js` and `tools/e2e.js` import it. `[data-testid=time-estimate]` carries `data-minutes`,
  `data-seconds` and `data-players`. It opens the "If you start now" panel, and that panel is now first in the lobby's
  side column. A timer being typed but not yet sent (5..600) counts only on the host's own screen, until the state after
  the field is left. The preset highlight follows it too.
- FC4 tools. `tools/e2e.js` now also checks the following.
  - The lobby estimate on all three pages: the formula, Standard with 6 players at 45 min, Quick, Relaxed and back, and
    an unsent 300 s edit that changes only the host's estimate and sends nothing.
  - A played special's chip: hovered on the desktop, tapped and then closed with Esc on the phone.
  - The airlock, when the server sends `airlocks`. A bot opens one on another bot, and the badge, alert and bar must show
    on every page. A human who holds a playable Airlock must see the hint and the marked first target, and then closes
    the airlock through the Play flow. If no human can, the airlock must jam, or be sealed by a bot, before its round's
    discussion ends. The airlock check is skipped under 4 players, where none are dealt.
  - In every periodic check, the `airlock-badge` ids against the alive targets of the open airlocks.
  The e2e also records `setOptions` frames now.

**2026-09-25, feature-integrator.** Integration of X1–X4 (server and client landed in parallel). No protocol or server change.
- I1 X1/Y1 final cause: already consistent. The client's `finalCause()` treats a 🚪 `eject` line (the seal) as the cause,
  so a game-ending seal reads "Sealed by the airlock", and it skips the jam lines after the door line. Checked in a real
  game (round 7 seal).
- I2 X3 hover popovers are tooltips. A popover opened by a mouse hover or keyboard focus has `pointer-events: none`, so a
  click goes through to what is under it. A pinned popover (click or tap) keeps the pointer, so it can be scrolled and
  tapped closed, as FC2 says. Before this change, a hover popover opened under a pointer that was only resting where the
  page moved (after a sheet opened, or on a new turn). It covered a Reveal button or a picker target, and the next click
  only closed it. The e2e hit this: 16 players, bob's revive target, and later his Reveal.
- I3 X3 picker title. The special picker's title keeps the chip look (`card-chip cc-static`) but opens no popover and has
  no `card-chip` testid, because the full text is printed right under it. The picker now also shows the card's meta line
  (target · category · timing · from round N), which the popover used to carry. FC2's list of places where a title
  appears as a chip is otherwise unchanged.
- I4 X4. The lobby action bar also states the estimate ("…, a game of about 55 min."). A phone keeps the bar on screen,
  but the "If you start now" panel sits far down the page.
- I5 tools. `tools/e2e.js`:
  - Its bots take `airlockOpen: 0`. The e2e opens its own airlock, so a random pair of bots can no longer throw a human
    out. Bots still join an airlock and still revive.
  - The airlock check falls back to a human opener, through the Play flow, when no bot can open one. With the seed-1
    4-player deal only the humans hold Airlocks, and the check used to be skipped.
  - Every other bot that holds an Airlock waits while the humans are checked, so a bot cannot close the airlock before
    a human's join is tested.
  - From 4 players on, a skipped airlock check is a failure, not a warning.
  - A human holding a playable "Back from the Forest" brings back an airlock victim through the Play flow (`reviveTest`).
  - The airlock and revive pickers must have no element covering a target.
  - The end-of-discussion airlock check accepts a victim that was sealed and then revived.

**2026-09-25, server-fixer (f1).** Server fixes from the f1 review. The protocol and the StateView are unchanged.
- X5 names and networks.
  - (a) Names. The door emoji U+1F6AA, with a VS15/VS16 after it, is removed from names, so 🚪 only ever starts one of
    X1's airlock lines. A name made only of doors is `bad_request`. The 20-code-point cut now falls between graphemes
    (`Intl.Segmenter`), so an emoji sequence (a family, a flag, a skin tone) is kept whole or dropped. Only a single
    grapheme longer than 20 is cut by code points.
  - (b) IPv6. `MAX_SOCKETS_PER_IP` (40) now counts per network (`ipKey`), not per exact address; this amends Y5. A
    network is an IPv4 address in any spelling (hex IPv4-mapped too) or an IPv6 /64. Every per-network limit also counts
    the IPv6 /48 at `SITE_FACTOR` (3) times the /64 allowance:
    - 120 sockets;
    - 15 live rooms (V1; at the cap, the /48's oldest abandoned lone lobby makes room);
    - a V2 bucket of 60 failed lookups with the same 3 s refill, so a /48 scans no faster than one /64.

    IPv4 has no coarser bucket. `BUNKER_NO_LIMITS=1` lifts all of these. Why: behind Caddy, one free tunnel-broker /48
    (65,536 /64s) could open unlimited sockets and scan all 331,776 codes in about 3 minutes.
- Y1 order. When the airlock's target leaves or is kicked, the jammed line now comes right after that line, before
  "… is now the host" when the target was the host. When that leave ends the game, the jammed line still comes after
  "The bunker door closes". The Checker flags any other order (`(y1)`).
- L3 logs. An add-feature card's result reads "the bunker gains a new feature: “F”". It used to read "a hidden room was
  found — …" for every card, Supply Drop included.
- T7 tests. New: `test/regressions-f1.test.js`, and a `test/checker.test.js` case for Y1.
- Not done: a host "End game → back to the lobby" tool, so a friend who arrives just after Start can join. That is an
  owner decision; the protocol has no such message.

**2026-09-25, client-fixer (f1).** Client fixes from the f1 review. The protocol and the StateView are unchanged.
- FX1 X1/X3/FC1/FC2 reading log lines. Names are free text, so the client reads a log line only by the server's exact
  shapes (`public/loglines.js`, shared with `test/client-loglines.test.js`), never by a 🚪 or a quoted word anywhere:
  - an airlock line is one of X1's three shapes (a seal is kind `eject`, a start or a jam kind `special`). Only these
    get the airlock style, the "Airlock" flash label, the Airlock chip (on the card's own word "airlock", not the first
    "airlock" in the line) and the final banner's "Sealed by the airlock";
  - a special's own line ("Round N — {player} played “T”: text → result") is read from the seated player's name it
    starts with (the longest that fits). A line whose player is no longer seated is read only when it quotes a title
    the state knows, followed by exactly its known text, and it never teaches a text;
  - the log's chips are only those two: a special's played title, and an airlock line's card word. FC2's "any quoted
    title" is dropped: the server quotes a title only in a special's own line, so that rule matched only names and
    card texts;
  - the banner's leave cause is exactly "{player} left the game" or "{player} was removed by the host".

  Why: a 🚪 or a quoted title in a name made a vote read "Sealed by the airlock", skipped the real leave, styled all of
  that player's lines as airlock alerts, and made the name a card chip. A name like 'played “Alibi”: a →' forged a chip
  with its own popover text. X5(a) now strips 🚪 on the server, but the client no longer depends on that.
- FX2 X1.7/FC1 the Airlock picker.
  - The picker records what the player sees when it opens, on a target pick and on Back: the target list, and what the
    Airlock does to the chosen target. So the first state that changes that (an airlock opening on the target right
    after the pick) already gets FC1's note and 400 ms hold. Before, only a state after another state did, and a Play
    already on its way became a no-vote ejection.
  - On the target step, a list that changes (an airlock opens and its target jumps to the front, a player leaves) is
    held 400 ms, with a note when the "join" targets changed.
  - The alert's `airlock-join` (+`data-player-id`) opens the picker on Confirm for that target (Back changes it). This
    is an exception to §10's Play-flow order, which still holds for `special-btn`.
  - With nothing to join, the target step says "Nobody has started an airlock yet" only when none is open. An airlock
    cycling on the viewer is named instead (their own card cannot close it).
- FX3 X3/FC2 popovers. A popover also closes when a scrolling ancestor (the log, the rail, the table) clips its anchor
  out of view, not only when the anchor leaves the viewport, and it points at the visible part of a partly clipped
  anchor. A pinned popover closes when the keyboard moves the focus elsewhere (Tab), and the newly focused anchor shows
  its own.
- FX4 screens and copy.
  - Host offline: no bar tells anyone to wait for an offline host's Next (lobby, reveal, discussion, vote, defense,
    final). It reads "The host, X, is offline: if they are not back soon, the host role passes to a player who is
    online." The grace time is not in the StateView, so no number is given.
  - In phase `vote`, `next-btn` is a small "Next = Close vote" beside Close vote. It is still present and enabled (§10).
  - At 1024–1179 px the Situation panel starts collapsed in vote and defense, and at any phase on screens under 700 px
    tall. Screens at least 640 px wide and under 700 px tall get tighter vote choices. Why: at 1093×530 or 1280×600, a
    16-player vote left 3–4 table rows, or none, in view.
  - Copy: "1 missing voter abstains"; "If you start now · 1 player"; at the final the Special cards panel says "N never
    played". The name field caps at 20 code points, cut between graphemes (X5(a)). Its maxlength of 20 UTF-16 units
    halved emoji names and could split an emoji.
- T8 tests. New: `test/client-loglines.test.js` (real engine logs, the view given hostile names as the server writes
  them). `tools/e2e.js` also checks:
  - an aimed Airlock's hold when a bot opens an airlock on its target (every bot waits meanwhile, so no other state
    comes in between);
  - the seal from the alert's Join, which opens on Confirm;
  - the final banner and the airlock-styled lines against `loglines.js`;
  - the mock final `hostile-names`, with the popover's scroll-out and Tab cases.

  Against the original client it fails on exactly these.
- Not done (owner decisions): moving a seat to another device (a link carrying the token is a seat that leaks if pasted
  in the group chat), and a host "End game → lobby" tool (server and protocol).

**2026-09-25, server-fixer (f2).** Server fixes from the f2 review. The protocol and the StateView are unchanged.
- Z1 V2/X5 amended. While a network's failed-lookup budget is empty, a `resume` whose room exists and whose token maps
  to an active seat is still admitted, and it spends nothing. Every other `join` or `resume` gets the same `server_busy`
  ("Too many wrong room codes…") whether or not the room exists, and spends nothing. Why: a neighbour on the same IPv4
  (one Wi-Fi, CGNAT) or the same /48 who sent 20 (or 60) wrong codes kept players out of their own seats. The client
  side (a `server_busy` answer to a resume is a transient failure: drop, banner, back off) belongs to the client fixer.
- Z2 R3 amended. On `special`, an `at` with `phase: 'reveal'` also matches the same round's `discussion`; the other
  keys are compared as before. Nothing a card does changes between a round's reveal and its discussion, so a play
  confirmed on the last reveal turn (an Airlock join) is no longer refused "Too late". A key that crossed into the vote
  or into the next round is still `wrong_phase`. R1 messages are unchanged.
- Z3 §5 playability. `double_vote` is unplayable (`not_allowed`, nothing spent) while the player is in
  `voteMods.blocked`, or in phase `vote` when they are not in `vote.voters`. Both last the whole step, so the ×2 could
  never count. Clients derive this from the StateView, as `tools/botlib.js` `playableSpecials()` does.
- Z4 X5(a) names. Lone surrogates (`\p{Cs}`) are removed too, and removal repeats until nothing changes, so the two
  halves of 🚪 around a stripped character (`"\uD83D\u0000\uDEAA"`) can no longer join into a door.
- Z5 X1.2/Y1 start line, reworded: `🚪 {A} started cycling the airlock on {T}. If one more Airlock card is played on
  {T} before this round's discussion ends, {T} is out — no vote.` (an ASCII apostrophe). In overtime it reads "before
  the overtime discussion ends". "Before the vote" was wrong in a round without a vote, where the airlock jams at the
  end of the discussion. The client's `AIR_START` accepts both endings.
- T9 tests. New: `test/regressions-f2.test.js`. The V2 cases in `regressions-r2` follow Z1: a valid resume now gets
  through, while a bad token or a missing room still gets `server_busy`. Its R3 case now crosses a round instead of
  reveal → discussion. The Checker and the airlock tests use the new start line.
- Not done: under X5(b), 3×40 idle sockets from three /64s still give every other /64 of that /48 a 429. That is
  inherent to a per-/48 cap, and theoretical while the host name has no AAAA record.

**2026-09-25, client-fixer (f2).** Client fixes from the f2 review. The protocol and the StateView are unchanged.
- W1 X1/Z5 airlock copy. The client never says "before the vote": the badge, the alert, the bar, the picker and the
  rules name the real deadline, "before this round's discussion ends" ("the overtime discussion" in overtime).
  `loglines.js` `AIR_START` reads the old and the Z5 endings, and nothing else.
- W2 X1.7 Airlocks left. The client counts the Airlocks not played yet: `airlockDeal(players.length).airlocks` minus the
  "Airlock" titles in `playedSpecials`, and never fewer than the viewer's own. At 0, open airlocks are shown calm: "every
  Airlock in this game has been played: it jams when …". There is no "one more … and you are out", and the flash of
  that last start line says so. An earlier start flash is withdrawn. Join targets are listed in opening order, and two
  of them read "pick one of them".
- W3 X3/FC2/FX1 popovers and chips.
  - An anchor that wants no popover (a cell whose text fits) closes the unpinned popover of the anchor just left.
  - Only cut-off table cells are Tab stops (`tabindex=0`, measured after layout).
  - A sheet closed without playing (Esc, Cancel, ×, backdrop, Back) gives the focus back to the button that opened it,
    once K6's hold ends. Meanwhile the focus waits on that button's card or alert row (`tabindex=-1`).
  - A log line never teaches a card text: texts come only from the state. A special's line is a chip only when the
    state knows its title and exactly that text follows. It is read from the longest seated name, else from the first
    "… played “T”: {text} → " (`loglines.js` `cardLine`). This amends FC2 and FX1.
- W4 X4/I4 every lobby bar (host, players, spectators) states the estimate, and below `minPlayers` says it is for the
  minimum.
- W5 §3/§6 an in-game "X left the game" or "X was removed by the host" is flashed. A voter whose vote went to X gets
  "X left the game, so your vote for them no longer counts: vote again", as a flash, in the bar and in the vote panel.
- W6 V2/Z1 an in-flight `resume` answered with anything but `bad_token`/`no_room`/`replaced` (`server_busy` included)
  is a failed attempt: the socket is dropped, the conn banner shows ("The server is busy…" for `server_busy`), and
  the client retries with backoff. An open socket that has not joined counts as reconnecting in the banner, and a
  seat's socket left open and unjoined for 8 s with no hello in flight is dropped.
- W7 §10/K1 hold. A ballot opened by this page's own Next, Close vote or End turn (the step it was aimed at ended
  into a vote) holds `vote-btn`, `close-vote-btn` and `next-btn` for 1.1 s instead of K1's 350 ms. On a phone the
  vote choices take the tapped button's place, and a re-tap at 0.8 s cast a vote. Two-tap arming for Close vote was not
  added (it would change §10's one-click rule for `close-vote-btn`).
- W8 K8 track. Played rounds show what their vote did, read from the log (`loglines.js` `voteHistory`): the players it
  ejected, or its due count struck through when a special cancelled it. A round whose lines were cut off the log falls
  back to the start plan. Z3 is mirrored in `specialStatus`, with the reason.
- T10 tests. New: `test/client-f2.test.js` (engine logs: the Z5 line, the FX1 bypass after Play again, `voteHistory`).
  `tools/e2e.js` also checks:
  - live: no "before the vote" in the airlock UI; focus back after Esc; a fake `server_busy` on a resume, recovered
    with the busy banner; the host's own Next holds the votes about 1 s; every lobby bar's estimate;
  - on mocks (new: `airlock-two-joins`, `airlock-long-name`, `airlock-spent`, `track-history`): no stale popover, by
    mouse or Tab; cut-off cells only as Tab stops; long names wrap at 360; opening order; spent copy; the track;
    estimates below the minimum.

### X5: Russian language (2026-09-26, owner request): direction. The architect details it in X5.1 and following

- **Languages:** `en` and `ru`, with **my own Russian translations of everything now written in English**. That covers the UI, every card, catastrophe, bunker, special, log line, error, the rules sheet and the lobby estimate. Player names are never translated.
- **Every viewer picks their own language** with a visible EN/RU switcher, available on the landing page, in the lobby and in the game header. The choice is remembered per browser; the first-visit default is `ru` if `navigator.language` starts with "ru", otherwise `en`. **Switching mid-game changes only that viewer's screen.** The game carries on, and nobody else is affected.
- **The server keeps using per-recipient views** (§7). It stores each member's language (`lang`), and `create`, `join` and `resume` accept an optional `lang`. A new message, `{t:'setLang', lang}`, is allowed at any time, including before joining. `viewFor(viewer)` renders every human-readable string in that viewer's language.
- The engine must therefore store **language-neutral data**: cards as structured tokens (a content id plus modifier params), and log entries as `{key, params}`. These are rendered at view time, so the whole log, including history, re-renders when someone switches. Error replies carry a code and params, rendered per recipient.
- **Log entries gain structured `parts`,** so the client never parses English text. The main purpose is that special-card chips (X3) and airlock lines (X1) come from segments, not regexes. The architect defines the exact shape.
- **Russian must be natural and correct:**
  - use proper plural forms (1 год, 2 года, 5 лет) and grammatical gender where needed
  - keep one consistent in-game vocabulary: бункер, катастрофа, особое условие, характеристики, голосование, изгнан / «остался в лесу», шлюз, «Вернулся из леса»
  - the tone is dark and ironic, in the spirit of the game
- **Narration clips stay English-only** for now. In `ru` the narrator still plays the English clip, and the UI says so.

### X6: host "End game → back to lobby" (2026-09-26, owner request)

- A new host action, `{t:'endGame'}`, is valid in any phase except `lobby`.
- The host is asked to confirm with two taps, because it ends the game for everyone.
- It aborts the running game and returns everyone to the lobby, like `playAgain` from final: seated players who have not `left` keep their seats, and spectators stay spectators. This lets a friend who arrived late take a seat before the next Start.
- It is logged ("The host ended the game").
- Clients show it in the host tools, away from Next, with the two-tap arming pattern already used for leave and kick.

### X7: the phone bottom gap (2026-09-26, owner bug report)

- On an iPhone (iOS 26 Safari, whose floating toolbar sits over the page), the fixed bottom action bar ends well above the bottom of the screen. That leaves a large empty black band between the bar's content and the toolbar; it is visible on the final screen.
- The bar must end flush at the bottom of the screen, padded by `env(safe-area-inset-bottom)` and nothing else. The page must use the dynamic viewport (`dvh`/`svh`, `viewport-fit=cover`), with no leftover `vh` sizing that assumes the toolbar is hidden.
- Verify under iPhone emulation, at every phase and screen height, including with the toolbar collapsed and expanded.

### X8: operator stats and deploy-when-idle (2026-09-26)

- **`GET /stats`** answers **only** when the TCP peer is loopback **and** the request has no `X-Forwarded-For` header, meaning it was made on the server itself, not through Caddy. It returns `{"rooms":n,"activeGames":n,"sockets":n}`, where `activeGames` counts rooms whose phase is not `lobby` or `final`. Every other caller gets 404.
- **`deploy/deploy.sh`** blocks only when `activeGames > 0`, which it reads with `ssh … curl -s 127.0.0.1:8080/stats`. If `/stats` is not there yet, it falls back to counting connections. `FORCE=1` still overrides.
- **`deploy/deploy-when-idle.sh`** polls every 2 minutes and deploys once `activeGames == 0` on two checks in a row.

**2026-09-26, quick-server.** Server side of X6 and X8. The StateView is unchanged; the protocol gains `endGame`.
- E1 X6 `{t:'endGame'}` has no fields (unknown keys are ignored; no `at`). Codes, in §7 order: `not_in_room`, then
  `not_host` (spectators and every non-host), then `wrong_phase` in the lobby. In reveal, discussion, vote or defense
  (overtime too) it logs `The host ended the game` (kind `system`) and then does exactly what Play again does, with
  Play again's own line `Back to the lobby — same table, new cards next game`: `left` players go, everyone else keeps
  their seat in order (renumbered, same id; an offline seat stays offline and can resume), spectators stay, and the host,
  options, log and tokens are kept. Nothing hidden is revealed and no `final` is made. The turn, the ballot and its votes,
  the defense, the timer, `voteMods` (with `cancelNext`), `lastVoteResult` and open airlocks are simply dropped (no
  "jammed" lines). In `final`, `endGame` is Play again itself (the same state, only the "Back to the lobby" line), so
  an armed End game that crosses the end of the game still works. `playAgain` outside the final is still `wrong_phase`.
- E2 X8 `GET /stats` (HEAD too) answers `{"rooms":n,"activeGames":n,"sockets":n}`, JSON, `no-store`. `activeGames` =
  rooms in reveal, discussion, vote or defense; `sockets` = every open WebSocket, in a room or not. It answers only a
  loopback peer (X2's definition) with none of `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `X-Forwarded-Host`,
  `X-Forwarded-Proto`, even empty (Caddy always sets the X-Forwarded ones). Everyone else gets the static server's own
  404, byte for byte, so `/stats` looks absent; other methods get the static 405. Through the proxy it is 404 whatever
  `BUNKER_TRUST_PROXY` says.
- T11 tests and tools. New: `test/endgame.test.js`, `test/stats.test.js`. The Checker accepts a running game going
  back to the lobby only with E1's two lines, and checks what was kept (also after Play again). `runTable` takes
  `endGame` (a bot host's chance per game to press End game at a random quiet moment; that game counts as played, with
  `endedByHost`) and `ctx.afterEndGame`. `tools/botlib.js` has the host option `endGame`, `tools/bots.js` has
  `--end-game P`, and the soak lets the bot hosts of about 40% of its tables end games.

### X5.1–X5.8: Russian language, the design (2026-09-26, i18n-architect; detail in reports/i18n-design.md; amended the same day by i18n-design-critic, changes listed in the report's §15)

"X5" in these entries is the Russian-language X5 above, not the f1 entry "X5 names and networks".

- **X5.1 Protocol.**
  - `lang` is `'en'` or `'ru'`; anything else is `bad_request`.
  - `create`, `join` and `resume` take an optional `lang`.
  - `{t:'setLang', lang}` is handled like `ping`, at any time. Before joining, it only sets `conn.lang` and gets no
    reply. After joining, it sets the member's language, and its answer is one `state` to that socket only; nobody
    else gets a message.
  - A message's own `lang` is applied before that message is handled.
  - `setLang` counts against the per-socket burst limit, and clients debounce it. A client sends it only to a server
    whose states carry `you.lang`: a pre-X5 server answers it with `bad_request`.
  - `error.message` is rendered in the socket's language, and `kicked.reason` in the kicked member's language. The
    `replaced` error goes out in the old socket's language. The wire shapes and error codes are unchanged.
  - The member's language survives Play again, End game, `takeSeat` and reconnects. A `resume` without `lang` keeps
    it.
- **X5.2 StateView.**
  - Every human-readable string is in the recipient's language: category labels, catastrophe, bunker, cards, special
    titles and texts, notes, `timer.label`, and the log.
  - New fields:
    - `you.lang`;
    - `catastrophe.id` (the content id, which is also the narration clip's basename; `null` for a hand-made one);
    - `id` on every entry of `playedSpecials`, `unplayedSpecials` and `me.specials` (the content id; the Airlock is
      `'airlock'`);
    - `key`, `params` and `parts` on every log entry (X5.3).
  - Ids, numbers, statuses and nullness are identical in every language. A view in `en` equals the pre-X5 view (the
    snapshot taken after X6/X8, not `.hotfix/live`), apart from these fields. `test/stateview-schema.js` validates
    them.
  - The log is public, so rooms.js serializes it once per language per log version and splices it into every frame
    (`log` moves last on the wire). Budget at 16 players + 50 spectators with a full log: no more CPU per broadcast than
    before X5, and at most 120 KB per recipient. The measured baseline is 13.1 ms and 41.7 KB; stringifying a
    per-recipient log would double both (report §3.8).
- **X5.3 Log entries** are `{id, ts, kind, text, key, params, parts}`.
  - `key` names the message; the catalogue is in the report, §4.
  - `params` is language-neutral: player ids, category ids, content ids, numbers, booleans, `rp:{r, ot}`, and nested
    `{key, params}`. It never holds a card text or anything hidden.
  - `parts` is the rendered line. Each segment is one of:
    - a plain string;
    - `{t:'player', id, v}`;
    - `{t:'card', id, v, label, title, text}`: `v` is the chip's footprint in `text`, quotes included, and the chip
      shows `label`;
    - `{t:'cardtext', v}`: with its leading `': '`;
    - `{t:'cat', id, v}`;
    - `{t:'value', v}`;
    - `{t:'prefix', v}`: only first.
  - `text` equals the concatenation of the segments.
  - Clients take X3 chips and X1 airlock lines from `card` parts and `key`s only; flashes drop `prefix` and `cardtext`.
  - The text regexes of FX1/W3 in `loglines.js` stay only as the fallback for entries without `key`.
  - No code edits a translated string (replace, slice, regex, re-case, trim). Such a string gets its own key (report
    §8.2a).
- **X5.4 Engine storage.**
  - Every English field stays and is rendered once: card `{text, revealed}`, special title and text, `catastrophe`,
    `bunker`, log `text`, notes, timer. Next to it sits a language-neutral twin that views render from:
    - a non-enumerable card `tok`;
    - a special's catalogue `ref`, set only when the title and text equal the catalogue's English; otherwise the card
      is a literal;
    - `catastropheTok` and `bunkerTok`;
    - log `{key, params}` with player refs `{p, n}`.
  - `fail(code, key, params)` returns `{ok:false, code, message (English), key, params}`.
  - API additions: `join(name, {spectator, lang})`, `setLang(id, lang)`, `view(id, lang?)`, `langOf(id)`.
  - The dealer keeps its English methods and adds `drawCardTok`, `drawCatastropheTok`, `drawBunkerTok` and
    `drawBunkerFeatureTok`. The engine uses a Tok method whenever the dealer has one, and otherwise wraps the English
    string as `{lit}`, so hand-made test dealers work unchanged.
  - The rng call order is unchanged: a seed deals the same game as before, and the dealer's repeat check still
    compares English texts.
  - Tokens are frozen and replaced, never mutated. Code that builds a new card object sets its `tok`, and a view of a
    card without one throws under `NODE_ENV=test`. The engine's English fallbacks (`'A hidden storeroom'`,
    `'The bunker'`, `'Catastrophe'`) get tokens too.
- **X5.5 Content and catalogues.**
  - `server/content/en/*.js` hold today's strings verbatim, keyed by stable ids. The key order is the deck order.
  - `server/content/ru/*.js` use the same ids. Russian templates refer to the English placeholders by position:
    `{0}`, the plural `{0|год|года|лет}`, and the option `{1:a|b}`.
  - `server/content/gen.js` holds the neutral rules: weights, ranges, `stay` and ages.
  - Server messages and errors live in `server/i18n/{en,ru}.js`.
  - The shared formatter is `public/i18n/core.js`: templates, plurals, lists and the decimal comma. The server imports
    it. Two plural forms mean "1 / not 1" and serve a word whose number is not printed. Three forms mean Russian
    one/few/many and go next to a printed number. A non-integer takes the few form.
  - Param names carry their type (report §7.1).
  - `tools/i18n-check.js` (`npm run i18n:check`, also run in `npm test`) checks:
    - keys, placeholders and param names;
    - an exhaustive render with realistic values (protocol identifiers get their real Latin values);
    - Latin letters in `ru`;
    - a plural lint: a printed number before a Cyrillic word needs a selector;
    - a gender lint: bracketed forms such as «(а)» fail, and past tenses and short participles next to a player or
      «ты» go to a review list that QA must clear.
  - The Latin allowlist is `°C`, `3D`, `USB`, `×`, names and room codes supplied by params, and the switcher's
    `EN`/`RU`.
- **X5.6 Russian.**
  - Address the viewer as ты, and the table as вы.
  - Player names are never declined or translated. A name stands as the subject, after a colon, or in apposition
    («у игрока Анна»).
  - No gendered form is used for a player or the viewer: present tense, nouns, or the plural. Characteristic cards are
    gender-neutral. Biology may agree with its own sex.
  - Quotes «», the em dash with spaces, the en dash in ranges, the decimal comma, ё.
  - The glossary in the report, §10, is binding. It covers: особое условие, характеристики, голосование, изгнание,
    «остаётся в лесу», койки (beds, as distinct from места, seats), ведущий, шлюз and «Вернулся из леса».
  - Put a number after its noun where possible («раунд 3», «с раунда 3»).
  - Role nouns (ведущий, игрок) may be subjects, preferably in the present tense.
  - List headers may use the plural past («Остались в лесу: Анна»).
  - A form in brackets or with a slash is a failure, not a fallback.
  - Short labels about a player (status stamps, "✓ spoke", "voted", "Played by") follow the report's §10.6 table.
  - Owner-visible deviation: the owner's «изгнан» and «остался в лесу» are masculine. Lines about one player
    therefore use «Изгнание: …», «остаётся в лесу» and the status «В лесу», and lists keep the owner's «Остались в
    лесу» (report §14).
- **X5.7 Client.**
  - Modules: `public/i18n/index.js` and `en.js`/`ru.js`, with `t(key, params)` and the client's own category labels
    and cases.
  - Every UI string goes through `t()`. English stays byte-identical.
  - The switcher is one `button[data-testid=lang-switch][data-lang=<current>]` that toggles the language. It sits at
    the top of the landing page, and in the lobby and game header just before Rules. It is never disabled.
  - Language order: `?lang=` first, then `localStorage['bunker.lang']`, then `navigator.language` starting with
    "ru".
  - A switch is atomic when online:
    - the page keeps its old language until the answering `state` arrives (with `you.lang` equal to the choice, at
      most 1.5 s);
    - it then re-renders once, drops every toast and closes the popover.
  - Offline, on the landing page and in mock mode a switch commits at once. An offline page then shows server text in
    the old language until it reconnects.
  - Every hello carries `lang`. When a state's `you.lang` is present and differs from the choice, the client re-sends
    `setLang`, at most once per 5 s.
  - Nothing keyed on text may take a switch for a game event:
    - after a language change, `trackChanges` marks a card fresh only when it goes from hidden to shown;
    - the narrator keys the game by `catastrophe.id`, because a title key would reset it and stop a playing clip. It
      shows the state's title;
    - `briefingKey` uses `catastrophe.id`.
  - The narrator finds its clip by `catastrophe.id` and, in `ru`, says that it is English.
  - The visible `data-pop-*` attributes are translated. Only machine `data-*` values are not.
  - The kicked notice uses the client's own text.
  - The room-code field maps Cyrillic look-alikes (А→A, К→K, …).
  - `<meta name="description">` and the noscript text are bilingual.
  - The e2e forces `en` with a `navigator.language` override and sets `bunker.lang` only when it is absent. It adds a
    RU pass:
    - bob switches mid-game for a bounded stretch and back. The switch is atomic, only his page changes, the game
      goes on, and the choice survives a reload;
    - Dana, the X6 late arrival, is Russian by the first-visit default and is the page checked for Latin and at
      360×640.
  - No RU layout check runs on mocks.
- **X5.8 Build and acceptance** (report §11–§13).
  - Before Phase 1 the orchestrator snapshots `server/game.js` and `server/content.js` to `test/fixtures/pre-x5/`.
    This is the golden baseline; `.hotfix/live` predates X6.
  - During the build only `i18n-qa` edits SPEC.md. The other agents list "Spec deltas" in their reports.
  - The checkpoints (A1, B1, C1, R1) freeze by growth only.
  - Agents with disjoint files:
    1. `i18n-server` (game, rooms, index, `server/i18n`, botlib, bots, the broadcast bench, the soak, schema, Checker,
       and every existing server-side test);
    2. `i18n-content` (`content.js`, `server/content/**`, `public/i18n/core.js`, `i18n-check`);
    3. `i18n-client` (`public/**` except `ru.js` and `core.js`, `e2e.js`);
    4. five translators, each starting at a checkpoint:
       - `ru-content-people`, `ru-content-body` and `ru-content-world` (content `ru/*` files);
       - `ru-rules` (`ru/specials`, `ru/labels`, `server/i18n/ru.js`). It delivers R1 first: the special titles and
         the category labels;
       - `ru-client` (`public/i18n/ru.js`), which starts after C1 and R1;
    5. `i18n-qa`.
  - The gate:
    - golden tests: English deals, views and error messages equal the pre-X5 snapshot, over games that include End game
      and Play again;
    - catalogue complete, the plural and gender lints clean, and the gender review list cleared by QA;
    - the broadcast budget met (`tools/bench-broadcast.js`);
    - the X6 strings in Russian;
    - no Latin in `ru` views;
    - `en` and `ru` views structurally identical;
    - a protocol test;
    - a mixed-language simulation with no violations or leaks;
    - the e2e RU pass: an atomic switch that changes only that page, the game goes on, the choice persists and the
      narrator clip is not cut off; a RU first visit with no Latin and the bar flush at 360×640.

### X5.9–X5.14: Russian language, as built (2026-09-26, i18n-qa)

This folds the "Spec deltas" of every report of the X5 build: `i18n-server-A1/A2`, `i18n-content-B1/B2`,
`i18n-client-C1/C2`, `i18n-integration`, `ru-content-*`, `ru-rules-R1/R2`, `ru-client`, the i1/i2 reviews,
`fix-*-i1/i2` and `gate-i18n-i1/i2`. Where it differs from X5.1–X5.8, it wins. It replaces these statements there:
- X5.2's baseline "13.1 ms and 41.7 KB", and "120 KB" read as JSON characters (X5.10);
- X5.3's "`parts` on every log entry" (X5.10);
- X5.6's "a form with a slash is a failure" (X5.12 allows five whole-noun pairs);
- X5.7's "at most 1.5 s" and the leading-edge throttle (X5.13).

- **X5.9 Protocol (X5.1).**
  - A hello's valid `lang` applies before the hello is handled, even when the hello then fails.
  - A bad `lang` (also `null` on `setLang`) is `bad_request` "Invalid field".
  - A `resume` without `lang` copies the member's language onto the socket.
  - Clients send every action and every `setLang` right behind a `{t:'ping'}` on the same socket, as a liveness probe.
    There is no new message type.
  - A state is one WebSocket text message, sent in two fragments: the recipient's own head, then `,"log":[…]}`. The
    log's bytes are encoded once per language and log version and shared by every recipient of that language
    (`rooms.stateFrame`).
- **X5.10 The state's log and the size budget (X5.2, X5.3).**
  - **Budget.** Every `state` message is at most 122,880 bytes of UTF-8 (`rooms.js` `FRAME_BUDGET`), for any names up to
    NAME_MAX, in either language. `tools/bench-broadcast.js` measures it at 16 players + 50 spectators with real
    15–20-letter names:
    - pre-X5: at most 70 KB;
    - EN: at most 106 KB;
    - RU: at the budget on special-heavy seeds.

    CPU per broadcast is below pre-X5: 12–18 ms against 16–20 ms, measured on the same machine in the same run. The
    thinnest margin is the all-RU final, at 3–6%.
  - **Log window.** The state's `log` is the newest lines of the game's log: at most 200, with contiguous ids, ending at
    the newest line.
  - **Cuts,** in this order and only when needed:
    1. `parts` come off the oldest entries while the log's JSON would pass 84 KB (`LOG_WIRE_BUDGET`), but never off
       the newest 20 (`PARTS_MIN`). Such an entry is `{id, ts, kind, text, key, params}`, and clients render it from
       `text`.
    2. If the head plus the log would still pass the budget, the parts cut is redone against what the head leaves.
    3. Then the oldest lines are left off, as few as needed and never the newest 20. Only long-name Russian finals with
       many spectators get here, and they lose about one round of lines.

    Every recipient whose frame fits gets the same log bytes. This replaces report §14's "parts only on the newest 60
    entries".
  - `key` and `params` are always sent. `text` is always sent today. A client rebuilds a missing `text` from `parts`,
    so a later server may drop it.
  - **Wire params:**
    - a special becomes its `ref`, or else its own id;
    - a catastrophe becomes its content id (`null` for a stand-in or a literal);
    - a bunker name becomes `null`;
    - card and feature tokens are left out.

    `cardtext` (in `log.special`) and `airlock` (the Airlock card part, in every message) are derived when rendering.
    They are never on the wire.
- **X5.11 Engine, messages, content and the checker (X5.4, X5.5).**
  - **Engine.**
    - `fail(code, text)` with a text that is not a key is a keyless failure, sent as is. `_log(kind, text)` with such a
      text is kept as `log.dev.text`. Both exist for `server/dev.js`.
    - A special without a title is `special.untitled` in every language.
    - `game.js` exports `LEGACY_LOG_KEY` and `LANGS`.
  - **Messages** added to report §4/§5:
    - `rp.bare`, `rp.otBare`, `fmt.quote`, `word.airlock`, `word.nobody`, `special.untitled` and `err.devOff`;
    - `log.dev.*` (8 lines plus `log.dev.text`) and `err.dev.*` (17).

    `mods.used` is a template over the nested `mod.*` messages plus `n`. In server messages an empty list prints
    `word.nobody` («никого»), and a `null` optional nested message prints nothing.
  - **Params.** §7.1 adds `x2`, `on` and `seated` (boolean), `seed` (raw text), and the derived `airlock` and `cardtext`.
    `server/i18n/index.js` exports `SCHEMA` (param types) and `renderValue`. A server function value gets `f`: core
    `helpers()` plus `t`, `k`, `join` and `list`.
  - **Content.**
    - There are 13 files per language: labels, mods, professions, health, hobbies, phobias, skills, traits, baggage,
      biology, catastrophes, bunker and specials.
    - Content templates use content-local param names (`n`, `i`, `base`, `mod`, `nick`, `letter`, `months`, `range`).
      §7.1 governs only messages and client keys.
    - `student` takes `{n}` (the year) and `{i}` (its index, 0–4).
    - An option on an `{n:a-b}` param is indexed by the number itself and has hi + 1 choices, in any content file.
    - `content.js` also exports:
      - `FALLBACK_SPECIAL`;
      - the fallback tokens `FALLBACK_FEATURE_TOK`, `FALLBACK_CATASTROPHE_TOK`, `FALLBACK_BUNKER_NAME_TOK` and
        `FALLBACK_BUNKER_TOK`;
      - `litTok` and `bunkerWithFeature`.
    - Tokens are frozen, so a new feature replaces the bunker token.
    - A Russian function value that throws falls back to the English render of the whole token.
  - **Formatter** (`public/i18n/core.js`).
    - It adds `helpers(lang, hook)`, `placeholders` and `parseTemplate`.
    - Selectors read `Number(value)`.
    - An option index out of range renders `''` and warns once.
    - `@cap` capitalises the first letter.
    - In `ru`, a negative number is written with U+2212.
  - **Checker** (`tools/i18n-check.js`).
    - Dev-only keys (`log.dev.*`, `err.dev.*`) are exempt from the missing, Latin and param-name rules.
    - `"` and `”` in Russian are errors.
    - Titles carry no quotes and no final period.
    - Every label entry needs all seven forms.
    - `word.airlock` must equal the Airlock's title in lower case, and `fmt.quote` must be `«{title}»`.
    - A printed `yrs` param carries its own plural word, so it is exempt from the plural lint.
  - **The gender review list** is `test/fixtures/i18n-gender-review.txt`, tracked (`--review <file>` points elsewhere;
    `--out <dir>`, default `.scratch/i18n-qa/`, now only takes the sample sheet `ru-sample.txt`).
    - Each line is `mark<TAB>area<TAB>file<TAB>key<TAB>words<TAB>text`. The mark is `?`, `ok` or `fix`, and it is kept
      across runs. A line is known by file, key and text, with every run of spaces (no-break ones too) read as one
      space, so a changed text comes back as `?`.
    - `npm run i18n:check` rewrites the file (only when it changes). `--gate` needs every line `ok`, and so does
      `npm test` (`test/i18n-catalog.test.js`), which never writes the file. A fresh clone passes `--gate`.
    - It covers messages and client strings that name a player or «ты», plus cards and specials. Catastrophe narratives
      and bunker features are left out.
- **X5.12 Russian as written (X5.6).** The glossary in report §10 still applies, with these changes.
  - **Vote words.**
    - A ballot is «тур»: a vote step («голосование») has one or more туров. The log reads «голосование, тур 1 из 2», and
      the bar «Тур 1 из 2 · проголосовали: 3/6». «Этап голосования» is not used.
    - A count of ejections is «изгнаний: N» everywhere: the header, the stakes and the track. «Вылет» and «вылетает»
      are kept for the Airlock and for the result tag «Вылет».
  - **Fixed words.**
    - The category labels are fixed in `server/content/ru/labels.js`, with seven forms each. The skill label is
      «Навык».
    - The special titles are fixed in `ru/specials.js` (checkpoint R1). The fixed cards are «Шлюз» and «Вернулся из
      леса», and Extra Bunk is «Раскладушка».
    - Card-state stamps and "hidden" sub-labels are neuter status words: «Открыто», «Скрыто», «Не раскрыто», «скрыто у
      3 из 8».
    - The kick notice is «Тебя удалили из комнаты {code}.». The log line stays «Ведущий удаляет из игры: {p}».
  - **Gender-free rewrites:**
    - `log.eject`: «Голосов нет — решает судьба.»;
    - `log.airlockJam`: «…заклинило — задраить его было некому.»;
    - `err.ownAirlock`: «…задраить его может только другой игрок»;
    - `mods.used`: «Вместе с голосованием сгорает/сгорают: …».

    `err.tooFewPlayers` takes the genitive after «не меньше».
  - **Lists and questions.**
    - `log.tie`, `log.revote` and `log.dev.forceTie` use `{ids@and}` in RU.
    - A question never holds an `@and` list: the names go outside it («Переголосование: {list@and}. Кто останется
      снаружи?»).
    - After a colon the text goes on in lower case. A full sentence is joined with a period instead («Основной тур.
      {text}»).
  - **Slash pairs.** Only whole nouns on a card, and exactly five professions: nurse, midwife, tailor, actor and opera
    singer («Акушерка / акушер»). Any other slash or bracket form fails.
  - **Biology.** Adopted is «из приёмной семьи». `student` is an ordinal word («первый курс» … «пятый курс»). `self`,
    `revoked` and `fake` read «самоучка, N лет опыта», «лицензию отозвали после N лет практики» and «липовый диплом, N
    лет практики». Height words agree with the card's own sex.
  - **Bunker.**
    - The forecast is a single-unit range after «через»: «через 2–6 лет», «через 1,5–5 лет», «через 6–24 месяца».
    - The lines are «Сидеть под землёй {months}» and «Еды на {months}». `months()` gives «1,5 года» or «1 год 3
      месяца».
    - The object letters are 'АБЛДЕКМНПРСТВХЖ', index-aligned with the English ones. Z is «Ж», not «З», which reads as
      the digit 3 («412-З»): a letter that passes for a digit is not used.
    - Units outside §7's invariable list (м, л, шт.) are spelled out with a plural selector.
  - **Brand and typography.**
    - The brand in running text and `app.title` is «Бункер онлайн» (sentence case).
    - Other brand names are Cyrillic (Дискорд, Телеграм, Гитхаб). "Press Ctrl+C" becomes «Скопируй вручную».
    - A number and its unit in a short UI hint are joined by a no-break space («60 с»).
    - The room-code hint says the code is 4 Latin letters and that Russian look-alikes work too.
  - **The gender review list** had 8 lines. QA marked all of them ok: each word agrees with a noun, not a player, and
    «Вернулся из леса» is the owner's title, only ever a quoted card name. The merge of the sound seat (PR #2) added a
    9th, `narr.tableOther`, marked ok: its «англ.» is the abbreviation in «Слушать (англ.)», not a verb.
  - **No-break characters** (after QA, written as `\u00a0`, `\u2060`, `\u2011` escapes in the sources): a printed
    number and the word it counts (`{n}\u00a0{n|игрок|…}`, months(), range(), the Biology age, «60 с», «12 кг»); a
    noun and the number after it («раунд 7», «тур 1 из 2», «ход 3 из 8», «с раунда 2»); a word joiner after the en
    dash of a range («4–16 игроков» on the landing footer, in both languages; range(), `est.range`); and a no-break
    hyphen in «Объект 412-Ж».
- **X5.13 Client (X5.7).**
  - **Where the switch sits.**
    - On the landing page it has its own row above the brand.
    - In a lobby it is in the first header row, before Rules.
    - On phones in play it is in the second header row, after the jump chips and before the narrator, and the timer label
      sits above the clock.
    - On tablets in play (640–1179 px) it is at the jump row's right end, left of the narrator.
    - At 1180 px and wider it is before Rules.
    - Below 640 px the pill shows the language a tap switches to. From 640 px it shows `EN | RU` with the current one
      lit.
  - **A switch.**
    - The choice is stored at once.
    - `setLang` goes out on the trailing edge, 250 ms after the last tap. Nothing is sent when the choice ends on the
      language that the page and the server already have.
    - With a live socket in a room, the page keeps its language until the answering state. That `setLang` rides behind
      a liveness probe (`PING_WAIT_MS` = 8 s). A dead socket reconnects with the banner up, and the switch then commits
      offline.
    - A cap commits anyway: 10 s plus the slow-link wait.
    - The answer for a language the user has left is skipped until the latest `setLang` is answered, within the cap.
    - The rule is now: atomic while the socket is open; mixed only offline, and then with the banner up.
  - **Reconnects.**
    - After `joined`, if the state on screen is in another language than the page, the banner stays up until the new
      socket's first state.
    - A switch made while a resume's hello is in flight waits like an online switch, and `joined` sends its `setLang` at
      once.
    - A hello resets the reconcile's 5 s guard.
  - **Slow links.**
    - The waits for an answer grow by 1.5 × the last state's size ÷ the measured download rate.
    - While a state is known to be on its way, the waits also allow for it at 4 KB/s.
    - After a probe runs out, the waits double (up to ×4) until a state arrives. The extra wait is capped at 30 s.
    - A live socket is never called dead while a state downloads at 4 KB/s or more.
  - **Accessibility.**
    - The render that commits a language keeps the log and the bar status at `aria-live="off"` for 1 s.
    - While a switch waits, the switch is named in the chosen language's own words (`lang.switch`), with `lang=` and
      `aria-busy="true"`.
  - **Where the language comes from.**
    - `?lang=` comes first. It is applied, stored and then removed from the URL; a mock page keeps it and stores
      nothing.
    - Then `bunker.lang`, which goes through `pkey()`, so a profile tab keeps `bunker.lang@<id>`.
    - Then `navigator.language`.

    A `storage` event from another tab of the same profile switches this tab too.
  - **Modules and keys.**
    - `public/i18n/index.js` has `initLang({memory, storageKey})`, `setLang(l, {store})`, `saveLang`, `langStorageKey`,
      `pickLang`, `has` and `latinCode` (the look-alike map).
    - There are 848 client keys (851 after the merge of PR #2's `narr.table*`). `public/strings.js` is gone: its strings
      are now `landing.profile*`, `fb.*` and `narr.table*`.
    - Keys beyond the report's inventory include `track.otShort`, `hdr.timeUp`, `lang.switch`, `toast.whyOffline`,
      `toast.whyHandover` and `final.causeLine`.
    - The kicked notice uses `landing.kicked` and `landing.kickedPlain`. The server's `reason` is never shown.
    - `style.css` holds no user-visible text, and the RU e2e scan covers CSS-generated text.
  - **Log lines and the narrator.**
    - A keyed log entry renders from `parts`, with player names as `span.lt-name[data-player-id]`. The readers are in
      `public/loglines.js`.
    - The narrator finds its clip by `catastrophe.id` (the manifest `src` basename). It knows the game by room plus
      catastrophe id, and every title it shows comes from the state.
    - `index.html` has a bilingual description and noscript, Russian first. `<title>` stays "Bunker Online".
  - **Layout.**
    - `:lang(ru)` sets `--display` to the system font, heavier and tighter. RU headers are tightened up to 799 px.
    - On a phone, a phase name that would push Rules or ⋯ onto a row of their own shrinks (down to 10 px), then
      ellipsizes.
    - From 1180 px the one-row header's cells do not shrink, and the "next vote" cell ellipsizes first.
    - In play from 1440 to 1599 px, the header brand shows only its trefoil.
    - The time's-up tag `hdr.timeUp` is a DOM span, so it is part of `innerText` and the accessible text. On tablets
      and desktops it sits beside the clock, whole, whatever the name's length. On phones only the red clock shows.
  - **Layout in RU.**
    - The matrix status column is wider, and chip titles take up to 2 lines.
    - Host buttons are 11 px on phones.
    - Special titles wrap in the picker's head (× stays on the sheet at 360 px) and on the hand's card, and the card's
      state label takes the next line when needed.
    - Status chips hyphenate.
  - **A known limit.** After a reconnect whose first state is in another language, a card swapped while the page was
    offline is not highlighted. Only hidden → shown counts. A fix needs language-neutral card ids in the StateView.
  - **The e2e as built.**
    - EN forcing covers `?profile=` tabs too.
    - Bob's RU stretch runs from the start of game 1 through his first vote. It is sampled every 25 ms and after every
      render.
    - It also covers a reload, a throttled switch there and back, the reconnect cases "waiting" and "hello", and a
      throttled slow Next.
    - Dana is checked at four points, and every hello's `lang` is checked.
- **X5.14 Build and acceptance (X5.8).**
  - **`server/dev.js`** belonged to `i18n-server` for this build. It logs `log.dev.*` and fails with `err.dev.*` keys and
    language-neutral params, so every member reads dev lines and errors in their own language. `log.dev.text` is only
    for a caller that passes ready text. The RU dev keys are translated and keep the literal `[dev]` and the op names.
  - **Gate 5a.** `tools/bench-broadcast.js` exits 0 when both hold:
    - CPU is at most pre-X5, at the full-log point and at the final;
    - every state is at most 120 KB, in the lockstep game and in the size sweep (seeds 4, 11, 13, 3 and 7; ru and en
      tables).

    It uses real names by default and reports both characters and UTF-8 bytes.
  - **Checker (tests).**
    - A `neutral` mode, and `attach(bot, {leakRef})`.
    - Log entries are validated once per client, and are immutable afterwards.
    - `runTable` takes `langs`, `watcherLang`, `toggleLang` and `neutral`.
  - **botlib and bots.** botlib has `setLang`, `toggleLang`, `BOT_NAMES_RU`, `realNames`, `AIR_KEYS` and
    `LANGS`/`normLang`. `bots.js` has `--lang ru`, which also gives Cyrillic names.
  - **Server.** A server whose stdout/stderr reader has gone drops its log lines instead of failing.
  - **Timing.** `npm test` takes about 2 min, because the simulations parse states 2.5× bigger.
  - **Sign-off** (2026-09-26, i18n-qa). Every item of report §13 is met on the tree the i2 gate hashed; the evidence
    is in `reports/i18n-qa.md`. Owner questions left open (report §14):
    - `translate="no"` on the app root;
    - a language hint in invite links;
    - the «изгнан» / «остался в лесу» deviation;
    - the display font on a real iPhone.

### X5.15: WebSocket compression (permessage-deflate), measured and left off (2026-09-26, ws-compression; detail in reports/ws-compression.md)

- **The question.** A Russian state at 16 players + 50 spectators is up to 120 KB (X5.10), and every recipient gets one
  after every change: up to 7.9 MB per broadcast, and about 29 MB per member over a game. The production VPS has one
  vCPU. Browsers offer permessage-deflate (RFC 7692) on every WebSocket, and Caddy passes the offer through (not checked
  on the box).
- **Measured** with `taskset -c 0 node tools/bench-broadcast.js` (one core; the all-RU and the mixed table; the
  full-log point and the final):
  - **bytes:** 5.1–5.5× fewer. A RU final goes from 119.7 KB to 23 KB per recipient, and a RU player's whole game from
    29 MB to 5.5 MB;
  - **CPU per broadcast:** 51–65 ms against pre-X5's 15–17 ms, so 3.2–3.9×. The X5.2 budget is at most 1×. zlib level
    1 is already the fastest, and no setting came near the budget (report, tuning table);
  - **memory:** the deflater takes about 180–200 KB of RSS per socket, from the first message it compresses; the
    socket and its inflater take about 20 KB more than a plain socket.
- **Decision: off by default** (`server/index.js` `WS_DEFLATE_DEFAULT = false`). `BUNKER_WS_DEFLATE=1` turns it on
  with `WS_DEFLATE`, and `=0` turns it off. With it on, the bench gates the deflate CPU too, so the owner can trade CPU
  for bytes only knowingly.
- **`WS_DEFLATE`:**
  - zlib level 1 and memLevel 8;
  - `server_no_context_takeover`: every message is compressed on its own. The `joined` token never shares a window
    with other people's names, and messages under 1 KB (`threshold`) are sent as they are;
  - no window-bits parameters, so every browser offer is accepted as made;
  - ws's `concurrencyLimit` of 10.

  `MAX_PAYLOAD` still bounds a client message after inflating: such a message closes the socket with 1009.
- **Tools and tests.**
  - The bench also times the X5 broadcast over deflate sockets, in a loop of its own. It reports the bytes on the wire
    for every kind, a member's whole game compressed, and the memory per socket. Options: `--deflate off` and
    `--z-*`.
  - `test/ws-deflate.test.js` covers the switch, the wire (RSV1, a fresh inflater for each message, the 1009), and a
    whole game over negotiated sockets.
  - The e2e records every page's `Sec-WebSocket-Extensions` and checks it against the spawned server's setting. Run
    it with `BUNKER_WS_DEFLATE=1` to play the whole run over deflate in Chrome.
- **Not built.** Compressing the shared log once per language and only the head per recipient. The prototype spent
  12–17 ms of zlib per broadcast instead of 34–38 ms, which is still about 2× pre-X5 with the sockets. It would also
  need ws internals to send a frame that is already compressed. A smaller state (deltas) is the real lever on bytes.

### X9: local test build, profiles and a dev test table with shortcuts (2026-09-26, owner request)

The owner tests alone in one browser. Every incognito window shares one storage, so every tab became the same player.

**1. `?profile=<id>`** (1–16 characters from `[a-z0-9_-]`) works in **every** build, production included.
- It namespaces **every** storage key the client uses: identity, narrator settings, language, UI preferences, everything. Tabs with different profiles are independent players in one browser.
- The profile carries across in-app URL changes.
- The **copyable join link never includes it**. The landing page shows a small "Profile: X" tag when one is set.

**2. Dev mode.** It is on only when the environment sets `BUNKER_DEV=1`. **Production never sets it.**
- `npm run dev` runs `BUNKER_DEV=1 BUNKER_MIN_PLAYERS=2 PORT=8081 HOST=0.0.0.0 node server/index.js`.
- On start the server prints an unmistakable `*** DEV MODE — test shortcuts enabled, never expose publicly ***` line.
- In dev mode, `GET /devinfo` returns `{"dev":true}`. Without dev mode it and every other dev route return 404.
- A test proves that every dev op is rejected (`not_allowed`) without the flag.

**3. The test table at `/dev`,** served only in dev mode. It is English-only (a tool, exempt from i18n). One page shows N human seats side by side, each an `<iframe>` of the normal client with `?profile=pK`. Controls:
- **Humans:** 2–16, default 4. **Layout:** a grid of phone-sized frames scaled to fit, or tabs.
- **New test game:** seat 1 creates the room as host (named P1), and seats 2..N auto-join as P2..PN. Seat K's frame URL is `/?room=CODE&name=PK&profile=pK&autojoin=1`; the client honours `autojoin` **only** when `/devinfo` says dev.
- **Add bots** (count): in-process server bots join using `tools/botlib.js`.
- **Start, Fast timers** (5/5/5/5 s), and **Seed**: in dev mode, `create` accepts `seed` so the deal is reproducible.
- **Open seat in a new tab,** and **Focus a seat** to enlarge one frame.
- **🔊 Sound** (2026-09-26): the narrator's sound goes to **one** seat, since all the seats would read the catastrophe at once, and each profile's own switch starts off. Auto (the default) is the focused seat or open tab, else P1, and it never moves in the middle of a clip (a Focus or a tab switch right after the Start would stop the narration: the seat that reads keeps the sound until its clip ends); or a fixed seat; or Off. That seat plays at Start as if its switch were on, without changing the switch its profile saved. The other seats stay silent, and a seat that loses the sound stops its clip. ▶ Listen or the switch in another seat moves the sound there. The seat frames carry `allow="autoplay"`, so a click on the table counts as the gesture browsers want.
- **The shortcuts below as buttons,** with a target-player dropdown fed by the host frame's `window.__bunkerState`.

**4. Dev ops:** `{t:'dev', op, ...}`. Any member of the room may send them, but only in dev mode, and each one is logged in the game log as `[dev] …`.

| op | params | effect |
|---|---|---|
| `giveSpecial` | `playerId, effect` | Replaces one unused special of that player with a card of that effect (any §5/X1 effect, including `airlock` and `revive`). The player gets 2 unused cards if they have fewer |
| `autoReveal` | – | Finishes the current reveal phase: every remaining speaker auto-reveals and ends their turn |
| `skipToVote` | – | Fast-forwards to the **next vote step**, auto-playing reveals and discussions of rounds with no kicks. If the current round has kicks, it goes straight to its vote. Open airlocks expire normally |
| `forceTie` | `ids: [a, b, ...]` (≥ 2 candidates) | In an open main ballot, rewrites the votes so that those players tie for most votes, then closes the ballot, which leads to the defense phase |
| `god` | `on: bool` | Turns a god view on or off for **the requesting socket only**. Its StateView then gains `god: { players: { [id]: { cards: Record<Category,string>, specials: {title,text,effect,used}[] } } }` |
| `fastTimers` | – | Sets options to 5/5/5/5 s, allowed in any phase |
| `addBots` | `count` (1–15) | Spawns in-process bots that join the room (lobby: seated; game: spectators) |

**5. Running it locally:** `npm run dev` (or a user-level service) serves the working tree on port 8081, reachable from the local network at `http://<this-machine>:8081/dev`. It is restarted after code changes.

**6. Tests**
- `?profile` isolation in the e2e: two tabs in one browser context are two players.
- `/dev` and `/devinfo` return 404 without dev mode, and dev ops are rejected.
- A puppeteer smoke of the test table: 4 seats, a new game, bots, start, `giveSpecial airlock` to P1 and P2, both play it on P3, P3 is ejected, then `skipToVote`, `forceTie`, and the god view. Then the sound, under Chrome's real autoplay policy: one seat reads the catastrophe at Start, and ▶ Listen and the switch move it.

### X9.7: the test build as built (2026-09-26; devtools-server D1–D15, devtools-client, gate-devtools, and the X5 build; folded by i18n-qa)

- **D1 codes.**
  - Without dev mode, every `{t:'dev'}` gets `not_allowed` before anything else is read, joined or not ("Dev mode is off:
    test shortcuts are not available on this server", `err.devOff`).
  - In dev mode the codes follow §7:
    - `bad_request` for an unknown op, a missing or mistyped field, `count` outside 1–15, `specials` outside 0..1, an
      `effect` that is not one of the 16 §5/X1 effects (or is `eject`), `ids` not 2–16 strings, `on` not boolean, or a
      bad seed;
    - then `not_in_room`, `room_full` (addBots), `wrong_phase` and `not_allowed`.
  - Extra keys are ignored.
  - Any member may send an op: a player of any status who has not left, or a spectator. A successful op gets no reply of
    its own, only the broadcast `state`.
- **D2 seed.**
  - `create.seed` is a string of 1–64 characters after trimming (a blank one means no seed) or a safe integer. `"42"`
    and `42` deal alike.
  - The room's rng is `mulberry32(seedFromString(seed))`. The same seed and the same seats give the same deal, down to
    the reveal order. The room code does not come from it.
  - The room logs `log.dev.seed` right after the creator's join lines. Without dev mode `seed` is never read.
- **D3 log lines.** Kind `info`, as `log.dev.*` keys, so each member reads them in their own language. The dev line
  comes before the lines the op causes.
- **D4 giveSpecial.**
  - Allowed in reveal, discussion, vote and defense.
  - The target is any seated player who has not left, an ejected one included. `eject` is `not_allowed`.
  - The card is the content's card of that effect (the fixed X1 cards for `airlock` and `revive`). It replaces, in order
    of preference: an unused card of the same effect, else an unused card dev mode did not give, else the oldest
    dev-given unused card.
  - The player is then topped up to 2 unused cards. Used cards stay in the hand, so in dev mode `me.specials` holds 2–9
    cards. `specialsLeft` stays at most 2.
  - `minRound` still applies: an Airlock plays from round 2.
- **D5 autoReveal.** Reveal phase only. Each remaining speaker gets what the host's Next does: an auto-reveal if needed,
  then the turn moves on. It ends in the discussion.
- **D6 skipToVote.**
  - From reveal, discussion or defense, the game runs on as the host's Next would with nobody acting, until a ballot is
    open.
  - Open airlocks jam as usual.
  - A vote step skipped by Cancel vote is logged and does not count.
  - `vote`, the lobby and the final are `wrong_phase`.
  - It stops in the final only when the ballot it reached closed at once and that ejection ended the game.
- **D7 forceTie.**
  - Only in an open main ballot. With no ballot it is `wrong_phase`; in a revote it is `not_allowed`.
  - Every id must be a candidate of that ballot. An unknown, not-alive, immune or repeated id is `not_allowed`.
  - The votes are rewritten: each tied player gets the same W votes, the largest W the voters can make. Everyone else
    gets 0, nobody votes for themself, ×2 counts twice, and unused voters abstain.
  - If no W ≥ 1 works, the answer is `not_allowed` and nothing changes.
  - The ballot then closes through the normal tally into the defense.
- **D8 god.**
  - It is per socket, and lasts until `on:false` or the socket closes. A resume on a new socket has no god view.
    Spectators may use it.
  - `god` is the last key of the state. It lists every seated player with cards, left players too, and is `{}` in the
    lobby.
  - The toggle is logged and broadcast.
  - Its texts are the engine's English fields, and the /dev god table is English, column names included. That fits
    X9.3's English-only table.
- **D9 fastTimers.** Allowed in any phase. It also cuts a running timer to at most 5 s from now.
- **D10 addBots.**
  - In the lobby it adds as many bots as there are free seats (`room_full` when none is free). In any other phase they
    join as spectators, up to 50.
  - `specials` (0..1, default 0) is each bot's chance per round to play a card. By default dev bots only reveal, end
    turns and vote at random.
  - Bots act after 0.5 s and end their turn after 1 s. A bot host presses Next in a discussion after 10 s.
  - The bots run in process, over a loopback: no network, no per-IP cap and no rate limit, and they do not count in
    `/stats`.
  - They leave when no human member is left, and the room is deleted. They also leave after 3 min with no human
    connected.
- **D11 routes.**
  - `/dev` and `/dev/` answer `public/dev.html`.
  - Without dev mode, `/dev`, `/devinfo`, `/dev/*`, `/devinfo/*` and every `public/dev.*` file get the static 404, byte
    for byte. The first path segment is compared lower-cased, after decoding.
  - `X-Frame-Options` is SAMEORIGIN in dev mode and DENY otherwise.
- **D12.** Dev mode lifts the V1 per-network room cap. The 200-room cap stays.
- **D13.** `BUNKER_DEV=1` with `BUNKER_TRUST_PROXY=1` or `NODE_ENV=production` refuses to start (`DEV_REFUSED`, exit 1).
  In-process test servers pass `dev: false`, so `npm test` passes with `BUNKER_DEV` exported.
- **D14.** The banner goes to stdout after the listening lines. The stderr diagnostics line ends with `; DEV MODE (test
  shortcuts at /dev)`.
- **D15.** The /dev page is English only. Dev lines and errors are keys (X5.14).
- **Client.**
  - **Seat 1.** Before the first game, seat 1's frame is `/?profile=p1&name=P1`. It creates the room through the bridge
    (`create {name:'P1', seed}`). After that, every seat uses the X9.3 autojoin URL.
  - **autojoin** resumes when this browser already holds that profile's seat. The `name` param is read only by autojoin,
    in dev mode.
  - **`/devinfo`** is asked for only inside a frame or with `autojoin=1`.
  - **The target dropdown** is fed by the host seat's StateView as the bridge posts it. The god view shows on that
    seat's socket.
  - **Storage keys** are `<key>@<profile>`, and every key goes through `pkey()`, `bunker.lang` included.
  - **The /dev page.**
    - The god view is a players × categories table docked under the seats, with a fold (`dev-god-fold`).
    - The controls column hides (`dev-ctl-toggle`), and its log is pinned under the controls.
    - Op buttons are enabled only in their phases, with the reason in their tooltip.
    - A dev-log error from a non-English seat is tagged with that seat's language.
    - **🔊 Sound** (X9.3, merged with X5): the /dev control, its top-bar status and the seat badges are English like
      the rest of the page. The note in a seat's own narrator popover («Тестовый стол: звук у места P2…») is the
      seat's client, so it is translated: `narr.tableOn`, `narr.tableOther` ({who} = the seat's name) and
      `narr.tableOff` in `public/i18n/{en,ru}.js` (they were `public/strings.js` narrTable*).
- **X10 as built.**
  - New test ids: `header-menu-btn`, `header-menu` and `profile-tag`.
  - The links and the version carry `data-where` (`landing`, `menu`, `rules` or `final`).
  - Without `version.json` the version reads `vdev`. The client reads the body of a 404, so the request finishes.
  - `lang` in the links comes from `<html lang>`.

### X10: "Report an issue" and a visible version (2026-09-26, owner request)

- **Visible links.** A **"Report an issue"** link and a **"Suggest an idea"** link appear in:
  - the header menu, in every in-room phase
  - the Rules / How to play sheet
  - the final screen
  - the landing page footer

  They open in a new tab.
- **Link targets:**
  - The bug link opens `https://github.com/dolgikhog/bunker-online/issues/new?template=bug.yml&version=<v>&browser=<b>&lang=<EN|RU>&room=<CODE>`, with every value URL-encoded.
    - `browser` is a short summary such as "Safari 26 · iOS", not the full UA.
    - `room` is present only when the viewer is in a room.
  - The idea link opens `…?template=idea.yml&version=<v>&lang=<EN|RU>`.
- **The version.** `public/version.json` = `{"version":"<git describe --always --dirty>","builtAt":"<ISO>"}`.
  - `deploy/deploy.sh` writes it at deploy time, and it is git-ignored.
  - The client fetches it once. It shows `v<version>` quietly in the Rules sheet and the landing footer, and uses it in the links.
  - If the file is missing, the version is `dev`.
- **Styling:** these links are small, secondary and never in the way of play. Keep all existing data-testids. The new ids are `report-issue-link`, `suggest-idea-link` and `app-version`.
