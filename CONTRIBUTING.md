# Contributing to Bunker Online

Thanks for helping. Bug reports and ideas go through the issue forms:
**[Report an issue](https://github.com/dolgikhog/bunker-online/issues/new/choose)**. Security problems go through
private reporting instead, see [SECURITY.md](SECURITY.md).

## Run it locally

You need Node 22 or newer (CI and production use Node 24). There is no build step.

```sh
npm ci                                   # install exactly what package-lock.json says
npm start                                # the game on http://localhost:8080
PORT=0 BUNKER_MIN_PLAYERS=2 npm start    # a free port, and a game can start with 2 players
npm test                                 # unit tests + full-game simulations (about a minute)
npm run e2e                              # browser end-to-end run, needs Google Chrome (see below)
npm run bots -- --url http://localhost:8080 --create 8 --host-bot   # a table of bots that plays itself
```

`npm run e2e` drives Google Chrome through puppeteer-core. It expects Chrome at `/usr/bin/google-chrome-stable`, starts
its own server on a free port and writes screenshots to `reports/screens/e2e/` (`--screens DIR` to change that,
`--headful` to watch). The README has the other options and the environment variables.

## How changes get in

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Fork the repository (or create a branch, if you have write access) and work on a branch, for example
   `fix/vote-tie-timer` or `feat/new-cards`. Never push to `main`.
3. Keep the pull request focused on one thing. Run `npm test`, and `npm run e2e` if you touched the client or anything
   the UI shows.
4. Open a pull request against `main` and fill in the checklist. CI runs `npm test` and the e2e run.
5. Only the owner (@dolgikhog) reviews and merges.

## Ground rules

- **`SPEC.md` is the contract.** Rule, protocol and UI behaviour changes update it in the same pull request. Its §11
  amendments override the earlier sections.
- **Card texts must be original.** Write your own catastrophes, bunkers, characteristics and specials. Do not copy
  text from published games, books or websites, or paste anything you do not have the rights to.
- **English and Russian stay in sync.** Once the Russian translation lands, every change to a player-facing text
  (cards, UI, rules) comes with both languages in the same pull request.
- **Catastrophe narration** (`public/audio/`, English and Russian) is generated from the card texts with
  `tools/voice/`. If you change a catastrophe card, say so in the pull request; the owner regenerates its clips (the
  Russian one from its ear script in `tools/voice/ru/scripts/`). See [tools/voice/README.md](tools/voice/README.md).
- **No secrets or personal data** in commits: no server addresses, keys, tokens, `.env` files, personal names,
  e-mail addresses or local paths. Deploy settings live in `deploy/.env`, which is never committed.
- Plain JavaScript (ES modules), no build step, and no new runtime dependencies without discussing it first.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
