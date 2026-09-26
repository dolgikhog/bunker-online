# Bunker Online

[![CI](https://github.com/dolgikhog/bunker-online/actions/workflows/ci.yml/badge.svg)](https://github.com/dolgikhog/bunker-online/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An online party game in the style of the discussion game "Bunker" («Бункер»).

**Play:** <https://178-104-144-119.sslip.io> ·
**[Report an issue](https://github.com/dolgikhog/bunker-online/issues/new/choose)** ·
[Contributing](#contributing) · [License](#license)

The app is the table. It deals the cards, runs the turns and counts the votes. Talking happens on your own voice
call (Discord, Telegram…), because there is no chat. You need no account and nothing to install, and it works on
phones.

- [Players](#players): joining, language, how a game goes, special cards, votes, game length
- [По-русски](#по-русски): the switcher and how to play, in Russian
- [Host guide](#host-guide): running a table, dropped players, testing alone with bots
- [Operator](#operator): running it locally, tests, deploying, logs
- [Contributing](#contributing) and [License](#license)

---

## Players

### The idea
A catastrophe has happened. The bunker has beds for only half of you (`floor(players / 2)`). Each round you reveal
one fact about your character and argue on voice that the bunker needs you. The group votes out the players it can
do without. When the players left fit in the beds, the door closes and every card is turned face up. Was it the
right crew?

### Joining
| You want to | Do this |
|---|---|
| Join a friend's game | Open the link they send (`https://178-104-144-119.sslip.io/?room=ABCD`), type a name and press **Join room ABCD**. You can also open the site, type the 4-letter code and press **Join** |
| Watch only | Press **Watch** (or **Just watch**) instead. Spectators see only public information |
| Get back in after a drop | Nothing to do: the page reconnects by itself, and your seat waits for you (shown as offline) |
| Get back in after closing the tab | Open the link again **in the same browser** and press **Rejoin as ‹name›**. Your seat belongs to that browser, so another device cannot take it over |
| Join a game that already started | You can only watch. The host's **Play again** (after the game) or **End game** (at any time) returns everyone to the lobby, where you can **Take a seat** |

Names are 1–20 characters. If your name is already taken in the room, the game adds " (2)". The **Rules** button in
the header opens a short "How to play" at any time.

### Language: English or Russian
Each player picks their own language with the **EN / RU** switch:
- It sits at the top of the start page, and next to **Rules** in the lobby and in the game header. On a phone, during a
  game, it is in the header's second row.
- A switch changes only your own screen. The game goes on, and nobody else is affected.
- Your browser remembers the choice.
- On a first visit the game starts in Russian if your browser's language is Russian, and in English otherwise.

Everything is translated: the cards, catastrophes, bunkers, special cards, the log, errors and the rules. Player names
are never translated. The only exception is the narration, which is English in both languages; the Russian screen says
so. [По-русски ниже](#по-русски).

### How a game goes
1. **Setup.** Everyone sees the **Catastrophe**, the **Bunker** (size, food, how long you must stay, its features)
   and the number of **beds**. You get **8 secret characteristic cards**: Profession, Biology, Health, Hobby, Phobia,
   Extra skill, Personality and Baggage. You also get **2 secret special cards**.
2. **Up to 7 rounds.** Each round has these parts:
   - **Reveals.** The players take turns in seat order: up the seats in odd rounds, down in even ones. On your turn
     you reveal **one** hidden card and make your case while a timer runs, then press **End turn**. In round 1 the
     card is always your **Profession**.
   - **Discussion.** Everyone argues on voice.
   - **Vote,** only in the rounds the schedule below marks.
3. **The vote.** Votes are secret while the vote is open. Everyone sees *who* has voted, but not for whom. You
   cannot vote for yourself, and you can change your vote until it closes. Then the result shows who voted for whom.
   - The player with the most votes is out and "stays in the forest". They keep watching and see their own cards.
   - **Tie:** each tied player gets a short defense speech, then there is a revote between them only. If it is
     still tied, or if nobody voted at all, fate picks at random.
4. **The end.** The game ends as soon as the players still in the game fit in the beds. If round 7's vote could not
   get there (a special cancelled it, for example), **overtime** follows: another discussion and vote, repeated
   until they fit. In the **final** every card, including unplayed specials, is shown, under "In the bunker" and
   "Stayed in the forest". Unless specials revealed more, each survivor still has one hidden card until then.

Timers are only a guide. Nothing happens when one runs out: the host moves the game on with **Next**.

### Votes per player count (SPEC §2)
The table shows how many players are voted out at the end of each round if nothing changes. A leave, a kick, an
Airlock, a revive, a cancelled vote or a change in beds shifts the plan. The round track in the game always shows the
live plan.

| Players | R1 | R2 | R3 | R4 | R5 | R6 | R7 | Out | Beds |
|---:|---|---|---|---|---|---|---|---:|---:|
| 4  | – | – | – | – | – | 1 | 1 | 2 | 2 |
| 5  | – | – | – | – | 1 | 1 | 1 | 3 | 2 |
| 6  | – | – | – | – | 1 | 1 | 1 | 3 | 3 |
| 7  | – | – | – | 1 | 1 | 1 | 1 | 4 | 3 |
| 8  | – | – | – | 1 | 1 | 1 | 1 | 4 | 4 |
| 9  | – | – | 1 | 1 | 1 | 1 | 1 | 5 | 4 |
| 10 | – | – | 1 | 1 | 1 | 1 | 1 | 5 | 5 |
| 11 | – | 1 | 1 | 1 | 1 | 1 | 1 | 6 | 5 |
| 12 | – | 1 | 1 | 1 | 1 | 1 | 1 | 6 | 6 |
| 13 | – | 1 | 1 | 1 | 1 | 1 | 2 | 7 | 6 |
| 14 | – | 1 | 1 | 1 | 1 | 1 | 2 | 7 | 7 |
| 15 | – | 1 | 1 | 1 | 1 | 2 | 2 | 8 | 7 |
| 16 | – | 1 | 1 | 1 | 1 | 2 | 2 | 8 | 8 |

### Special cards
You hold 2 and may play **one per round** while you are still in the game. The server carries out the effect, and
everyone sees the card and what it did. The only exception is a peek, whose result only you see. To read what any
card does, hover over its name or tap it, wherever it appears: on the table, in the log or at the end.

| Kind | Examples | What it does | When |
|---|---|---|---|
| Force a reveal | Truth Serum, Interrogation | Reveals one of a player's hidden cards | any time in play |
| Peek | Dossier, Wiretap | Shows **only you** one of a player's hidden cards | any time in play |
| Swap | Body Swap, Barter | Swaps one of your cards with a player's. Both are then face up | any time in play |
| Reroll | Miracle Cure, Night School | Replaces your card or a player's card with a new one, face up | any time in play |
| Everyone reveals | Medical Commission, Census, Luggage Carousel | Reveals one category for every player still in (the Carousel also shuffles them) | any time in play |
| Immunity / protect | Untouchable / Alibi, Bodyguard | Nobody can vote against you, or your target, in the next vote | before the vote |
| Block a vote | Gag Order, Laryngitis | Your target cannot vote in the next vote | before the vote |
| Double vote | Kingmaker, Megaphone | Your vote counts twice in the current or next vote | any time in play |
| Cancel a vote | Fire Drill, Blackout | Cancels the running or the next vote. Those ejections move to later votes | any time in play |
| Beds | Extra Bunk / Cave-in | +1 bed (this can end the game at once) / −1 bed | any time / before the vote |
| Bunker feature | Secret Door, Supply Drop | Adds a feature to the bunker | any time in play |
| **Airlock** | always dealt | See below | before the vote, from round 2 |
| **Back from the Forest** | always dealt | Brings an ejected player back into the game | before the vote |

"Before the vote" means during the reveals or the discussion. "Any time in play" also includes a vote or a defense.
Immunity, protection, a block and a ×2 last until the next vote ends. A cancelled vote uses them up too.

### Airlock and Back from the Forest
Every game with 4 or more players deals a fixed number of these cards:

| Players | Airlocks | Back from the Forest |
|---|---|---|
| 4–7 | 2 | 1 |
| 8–11 | 3 | 1 |
| 12–16 | 4 | 2 |

Each Airlock goes to a different player. Each Back from the Forest goes to a player who holds no Airlock, so a way
back always exists.

- **An Airlock needs a partner.** From round 2, during the reveals or the discussion, you can play it on another
  player. That starts cycling the airlock on them, and everyone sees **🚪 AIRLOCK 1/2** on their panel.
- If a **different** player plays an Airlock on the **same** player in the **same round**, before that round's
  discussion ends, that player is thrown out at once, with no vote. Immunity does not stop it. If your hand has an
  Airlock you can play, the game points out the open airlock ("Join the airlock…") and lists its target first.
- **Alone, it jams.** If nobody joins, the airlock jams when that round's discussion ends. It also jams at once if
  its target is out anyway. The card that opened it is spent. Airlocks on different players never add up.
- **Back from the Forest** brings back anyone who was ejected, whether by a vote or through the airlock. It does not
  bring back a player who left. The returning player gets no turn in a reveal phase that began without them, and
  later votes may eject more players to make up for the extra person.

### How long a game takes
The lobby shows an estimate for the current players and timers. It is only a guide, because the host's Next sets the
real pace. Here is the estimate (SPEC §11 X4) for each preset, with its range in brackets:

| Players | Quick (40/20/60/20 s) | Standard (60/30/90/30 s), default | Relaxed (90/45/150/45 s) |
|---:|---|---|---|
| 4  | ≈ 25 min (20–33) | ≈ 35 min (28–44) | ≈ 50 min (40–63) |
| 6  | ≈ 35 min (27–43) | ≈ 45 min (36–57) | ≈ 65 min (51–81) |
| 8  | ≈ 40 min (33–52) | ≈ 55 min (43–69) | ≈ 75 min (61–97) |
| 10 | ≈ 50 min (38–61) | ≈ 65 min (51–80) | ≈ 90 min (71–112) |
| 12 | ≈ 55 min (43–69) | ≈ 70 min (57–91) | ≈ 100 min (80–126) |
| 16 | ≈ 70 min (57–90) | ≈ 95 min (75–119) | ≈ 130 min (104–164) |

Each preset's timers are, in order: round-1 speech / later speeches / discussion / defense.

### Narrator
Each of the 18 catastrophes has a recorded narration by a British voice, male or female depending on the story. The clips are about 35 s each.
- Every player decides for themselves with the **🔊 Narrator** button in the header. It is off by default, and the setting and its volume slider are remembered in that browser.
- When it is on, the catastrophe is read aloud **once**, when the game starts. A reload never replays it.
- **▶ Listen**, next to the catastrophe title, plays it again at any time, even with the narrator off.
- If the browser blocks sound (common on iPhones), a "▶ Listen to the catastrophe" button appears, and one tap plays it.
- The sound comes from each player's own device, because Discord does not carry browser audio.
- The narration is English only. With the page in Russian, the same English clip plays, and the Russian buttons say
  so («Слушать (англ.)»).
- The clips live in `public/audio/` and are made from the card texts with Kokoro TTS plus an effects chain, mastered to -12 LUFS. [`tools/voice/`](tools/voice/README.md) rebuilds them.
- Production caches `/audio/*` for 7 days, so a re-rendered clip needs a new file name. The build in `tools/voice/` renames changed clips by itself.

### Limits
- **4–16 players** per game, plus up to **50 spectators**.
- Leaving a running game is for good. You cannot come back into it.
- Games live in the server's memory. A server restart or a deploy ends every game in progress. A room nobody has been
  connected to for 30 minutes is deleted.

---

## По-русски

**Бункер онлайн** — онлайн-стол по мотивам дискуссионной игры «Бункер»: <https://178-104-144-119.sslip.io>. Страница
раздаёт карты, ведёт очерёдность ходов и считает голоса, а спорите вы в своём голосовом чате (Дискорд, Телеграм…).
Текстового чата нет. Регистрация и установка не нужны, с телефона тоже можно.

**Язык.**
- Переключатель **EN / RU** стоит вверху главной страницы, а в лобби и в игре — рядом с кнопкой «Правила». На
  телефоне во время игры он во второй строке шапки.
- Язык у каждого свой: переключение меняет только твой экран. Игра идёт дальше, и у остальных ничего не меняется.
- Браузер запоминает выбор. При первом входе игра открывается по-русски, если браузер русскоязычный.
- Переведено всё, кроме имён игроков и озвучки. Рассказчик читает катастрофу только по-английски, и русский экран об
  этом предупреждает.

**Как играть.** Случилась катастрофа, а коек в бункере хватит только на половину из вас. Каждому раздают 8 скрытых
карт характеристик (профессия, биология, здоровье, хобби, фобия, навык, характер, багаж) и 2 карты особых условий. В
каждом из 7 раундов игроки по очереди раскрывают по одной карте и доказывают, что без них бункеру не обойтись. Потом
все спорят, а после отмеченных раундов голосуют, кто останется в лесу; при ничьей — речи в защиту и переголосование.
Особое условие можно сыграть одно за раунд: заставить другого раскрыть карту, подсмотреть чужую, отменить голосование,
добавить койку… «Шлюз» выбрасывает игрока без голосования, только если двое сыграют его на одного и того же игрока в
одном раунде, а «Вернулся из леса» возвращает изгнанного в игру. Как только оставшиеся помещаются на койки, дверь
бункера закрывается и все карты открываются: та ли команда? Ведущий — тот, кто создаёт игру: он задаёт темп кнопкой
«Дальше» и может завершить игру досрочно.

---

## Host guide

**Whoever creates the game is the host, and plays too.** The host keeps every host power even after being voted
out.

### Before the game
1. Open the site, type your name and press **Create game**.
2. Press **Copy link** (or read out the 4-letter code) and post it in your voice chat.
3. Pick the timers. There are three presets: **Quick**, **Standard** (the default) and **Relaxed**. You can also type
   your own values, from 5 to 600 seconds, for the round-1 speech, later speeches, the discussion and each defense.
   The **If you start now** panel shows the beds and the estimated game length for everyone.
4. Press **Start** once at least 4 players are seated. Offline seats count, and they are dealt in.

### During the game
| Control | What it does |
|---|---|
| **Next** | Reveals: moves on to the next speaker. If the speaker has not revealed yet, the game reveals a card for them (the Profession in round 1, otherwise a random hidden card). Discussion: starts the vote if one is due, otherwise the next round, or the end. Defense: next tied player, then the revote. Vote: the same as Close vote |
| **Close vote** | Counts the vote now. Players who have not voted abstain. With zero votes, fate picks at random |
| **Kick** (next to a name) | In the lobby it removes the player. In a game it takes two taps ("Remove?"), and the player is out **for good**: they count as out, and the vote plan adjusts. You can also kick a spectator |
| **Make host** | Hands the host role to another player |
| **Play again** | In the final, returns everyone to the lobby with the same seats, timers and log. Players who left are dropped. Spectators can then **Take a seat** |
| **End game** | At any time in a game, ends it for everyone and returns the table to the lobby, like Play again. It takes two taps (**End game**, then **Tap again to end**). Seats and spectators stay, hidden cards stay hidden, and the log says "The host ended the game". Use it to let a friend who arrived late take a seat |

Nothing moves on by itself. Watch the speaker, and press Next when they are done or their time is up.

### When someone drops
| Situation | What to do |
|---|---|
| A player goes offline | Their seat stays, marked **offline**. They reconnect by reopening the link in the same browser |
| The offline player is the speaker | Press **Next**. It reveals a card for them and moves on |
| An offline player is holding up a vote | Press **Close vote**. Their vote counts as an abstention |
| They are not coming back | **Kick** them (two taps). The vote plan adjusts, and the game may end early if the rest now fit in the beds |
| **You**, the host, drop | After 45 s offline, the role passes to a connected player (and at once if you press Leave). It does not come back when you return, so ask the new host to press **Make host** on you |
| A friend arrives after Start | There is no way to add a seat mid-game. They press **Watch**. They can take a seat after **Play again**, or right away if you press **End game** |

### Testing alone with bots
Bots are real players over the network: they reveal, vote, defend and play specials (Airlocks included). Run them from
a checkout of this repository after `npm install`.

```sh
# fill the room you created in your browser (you stay the host):
npm run bots -- --url https://178-104-144-119.sslip.io --room ABCD --count 5
# or give the invite link alone (quote it: zsh treats "?" as a pattern):
npm run bots -- --room 'https://178-104-144-119.sslip.io/?room=ABCD' --count 5
# a table of bots that plays itself. Open the printed link and press Watch:
npm run bots -- --url http://localhost:8080 --create 8 --host-bot
```

Useful options:
- `--delay MS` sets the pace (default 1500).
- `--specials P` is the chance per round that a bot plays a special (default 0.3).
- `--patience MS` makes a bot host skip a human who stalls.
- `--games K` plays K games in a row, `--exit-on-final` quits after the last final, and `--spectator` joins as
  spectators.
- `--lang ru` makes the bots Russian: they get Cyrillic names (Бот Анна, …) and Russian server messages.

**Ctrl-C** makes every bot leave. `npm run bots -- --help` lists everything. One network can open at most 40
connections and create 5 rooms on the server, and bots slow themselves down to stay under the rate limit.

---

### Several players in one browser: `?profile=`
Every tab of one browser, incognito included, shares storage, so every tab is the same player. Add
`?profile=<name>` to the address and each profile becomes a separate player, for example `…/?profile=2` and `…/?profile=3`.
This works on the live site too. The invite link you copy never carries your profile.

### The test table: `npm run dev`
`npm run dev` starts a **dev-mode** server on port 8081 (`BUNKER_DEV=1`). Open `http://<this-machine>:8081/dev`. **Never
expose a dev server publicly**: dev mode refuses to start next to `BUNKER_TRUST_PROXY=1` or `NODE_ENV=production`.
- **What it shows:** 2–16 seats side by side, each a real client with its own profile. **New test game** seats P1…PN
  automatically, with an optional **seed** for a reproducible deal.
- **Controls:** **Add bots**, **Start** and **Fast timers**.
- **🔊 Sound:** one seat reads the catastrophe at Start (Auto: the focused seat, else P1; a clip that is playing finishes first), whatever its own Narrator
  switch says; the others stay silent. **▶ Listen** in another seat moves the sound there. Choose **Off** for silence.
- **Shortcuts:** give any player any special card (e.g. two Airlocks), auto-reveal the round, skip to the next vote,
  force a tie, and **god view** (every hidden card in a table).
- **Smoke test:** `npm run dev:smoke` runs the table end to end.

## Operator

### Run locally
Requirements: Node ≥ 22 (production runs Node 24). There is no build step.

```sh
npm install
npm start                                      # BUNKER_LISTENING 8080, then: listening on http://0.0.0.0:8080
PORT=0 BUNKER_MIN_PLAYERS=2 npm start          # a free port, and a game can start with 2 players
```
Open `http://localhost:<port>`. `GET /healthz` answers `ok`.

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listening port. `0` picks a free one (read it from the `BUNKER_LISTENING <port>` line) |
| `HOST` | `0.0.0.0` | Bind address. Production uses `127.0.0.1` behind Caddy |
| `BUNKER_PUBLIC_DIR` | `<repo>/public` | Client directory. A relative path resolves against the repo root |
| `BUNKER_MIN_PLAYERS` | `4` | Players needed to start, clamped to 2–16 |
| `BUNKER_HOST_GRACE_MS` | `45000` | How long the host may be offline before the role passes |
| `BUNKER_SEED` | random | Seeds the deals, for reproducible tests |
| `BUNKER_NO_LIMITS` | off | `=1` lifts the rate limits and the per-IP limits. For tests and bots only, **never in production** |
| `BUNKER_TRUST_PROXY` | off | `=1`: when the TCP peer is loopback, per-IP limits use the last `X-Forwarded-For` entry. Production sets it |
| `BUNKER_WS_DEFLATE` | off | `=1` compresses the WebSocket messages (permessage-deflate): about 5× fewer bytes, but about 3.5× the CPU per broadcast, so production leaves it off (SPEC §11 X5.15). `=0` turns it off |

CI (`.github/workflows/ci.yml`) runs `npm test` and the e2e run on every pull request and every push to `main`.

Code: `server/` has `index.js` (HTTP, WebSocket and limits), `rooms.js` (rooms, sockets and the host grace),
`game.js` (the pure rules engine) and `content.js` (the cards). `public/` is the client (no build). `SPEC.md` is the
contract: its §11 amendments override the earlier sections.

Texts live in one place per language (SPEC §11 X5):
- `server/content/en/*.js` and `server/content/ru/*.js` hold the cards, catastrophes, bunkers and specials, keyed by
  the same ids.
- `server/i18n/{en,ru}.js` hold the log lines and errors.
- `public/i18n/{en,ru}.js` hold the client's strings.
- `public/i18n/core.js` is the shared formatter: plurals, lists and numbers.

A change to an English text needs the same change in Russian. `npm run i18n:check` finds what is missing or broken.
Russian wording that might be gendered goes to `test/fixtures/i18n-gender-review.txt`, where each line is marked `ok`
or `fix` by a reviewer; `npm test` and `node tools/i18n-check.js --gate` need every line `ok`.

### Tests
| Command | What it runs | Time |
|---|---|---|
| `npm test` | Unit tests plus full-game simulations over real WebSockets, in English, Russian and mixed tables. They spawn their own servers on free ports | ~2 min |
| `npm run e2e` | A browser end-to-end run: puppeteer-core with `/usr/bin/google-chrome-stable`, a desktop host, a phone player, a spectator and bots. It includes a Russian pass: a mid-game language switch and a Russian late arrival at 360 px. Useful options: `--players 16`, `--headful`, `--slow`, `--url URL` (use a running server), `--screens DIR` (default `reports/screens/e2e`) | ~2–3 min |
| `npm run i18n:check` | Checks every Russian text against English: keys, placeholders, plurals, no Latin letters, gender-neutral wording. `npm test` runs the same checks | ~1 s |
| `node tools/bench-broadcast.js` | The broadcast budget at 16 players + 50 spectators: CPU no higher than before X5, and every state ≤ 120 KB. It also times the same broadcast over permessage-deflate and reports the bytes on the wire and the memory per socket (SPEC §11 X5.15). `taskset -c 0` in front of it measures on one core, as on the production VPS | ~45 s (~50 s on one core) |

### Production
The live game runs on a small VPS with Ubuntu 24.04. The server's details are kept out of the repository, in
`deploy/.env` (git-ignored), which the deploy scripts read:

```sh
# deploy/.env
BUNKER_DEPLOY_TARGET=root@<server IP>
BUNKER_PUBLIC_HOSTNAME=<a-b-c-d>.sslip.io     # the server IP with dashes
BUNKER_SSH_KEY=<path to the SSH private key>  # used by the commands below (deploy.sh also has a default)
```

| | |
|---|---|
| URL | <https://178-104-144-119.sslip.io>. sslip.io resolves a name like `1-2-3-4.sslip.io` to the IP inside it, and Caddy gets the HTTPS certificate automatically. Plain `http://<server IP>` redirects there |
| Stack | **Caddy** (ports 80/443) → `127.0.0.1:8080` → the **systemd unit `bunker`** (user `bunker`, `/opt/bunker`, `node server/index.js`, `BUNKER_TRUST_PROXY=1`, restarts itself). Caddy serves `/audio/*` itself, with a 7-day cache. The firewall (ufw) allows 22, 80 and 443 |

The commands below assume the settings are loaded into the shell: `. deploy/.env`.

**One-time setup** of a fresh Ubuntu 24.04 server. It installs Node 24, Caddy and ufw, and writes the unit and the
Caddyfile. You can run it again safely.
```sh
ssh -i "$BUNKER_SSH_KEY" "$BUNKER_DEPLOY_TARGET" 'bash -s' -- "$BUNKER_PUBLIC_HOSTNAME" < deploy/provision.sh
```

**Deploy** the current code:
```sh
deploy/deploy.sh                      # to BUNKER_DEPLOY_TARGET from deploy/.env
deploy/deploy-when-idle.sh            # waits until no game is in progress (two checks, 2 minutes apart), then deploys
```
- The script copies `package*.json`, `server/` and `public/` to `/opt/bunker`, runs `npm ci --omit=dev`, restarts
  `bunker` and prints `active` and `ok`.
- **A restart ends every game in progress**, so the script refuses while a game is running (it asks the server's
  loopback-only `GET /stats`; on a build without it, while anyone is connected). `FORCE=1 deploy/deploy.sh` deploys
  anyway.
- `BUNKER_SRC=<dir>` deploys another checkout, `BUNKER_SSH_KEY=<file>` uses another key, and the first argument
  (`root@HOST`) picks another server.
- The live site runs whatever was deployed last.

**Logs and health:**
```sh
S="ssh -i $BUNKER_SSH_KEY $BUNKER_DEPLOY_TARGET"
$S journalctl -u bunker -f             # game server log, live
$S journalctl -u bunker --since today
$S systemctl status bunker
$S systemctl restart bunker            # ends every game in progress
$S journalctl -u caddy -n 50           # HTTPS or certificate problems
curl "https://$BUNKER_PUBLIC_HOSTNAME/healthz"    # -> ok
```

**Moving to another server:**
1. Create a small VPS running Ubuntu 24.04 that accepts your SSH key.
2. Point `deploy/.env` at it: `BUNKER_DEPLOY_TARGET=root@<new IP>` and `BUNKER_PUBLIC_HOSTNAME=<a-b-c-d>.sslip.io`.
3. Run the one-time setup, then `deploy/deploy.sh`.
4. Share the new link. Rooms and games live in memory, so nothing else needs to move.

---

## Contributing

Bug reports and ideas: **[Report an issue](https://github.com/dolgikhog/bunker-online/issues/new/choose)**.
Code and card texts: see [CONTRIBUTING.md](CONTRIBUTING.md) for running it locally, the branch and pull-request flow,
and the ground rules. Security problems: see [SECURITY.md](SECURITY.md) and report them privately.

## License

[MIT](LICENSE) © 2026 dolgikhog.
