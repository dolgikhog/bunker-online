#!/usr/bin/env node
// Bunker Online: bot players for humans who want to test or play with a partial table.
// Run `node tools/bots.js --help` for usage.

import { BOT_NAMES, Bot, Coordinator, describeState, roomLink, toHttpUrl } from './botlib.js';

const HELP = `Bunker Online bots: fill a table with bot players.

Join an existing room (you are the host in your browser):
  node tools/bots.js --room ABCD --count 5
  node tools/bots.js --room http://1.2.3.4:8080/?room=ABCD --count 3 --delay 800

Make a room of bots and watch it (open the printed link and press "Watch"):
  node tools/bots.js --create 8 --host-bot            the bot host starts at once and drives the game
  node tools/bots.js --create 5                       bots wait in the lobby; the first human who joins
                                                      gets the host and presses Start
Options:
  --url URL            server (default http://localhost:8080; ws:// and host:port also work)
  --room CODE|LINK     room to join (a 4-letter code or a /?room= link)
  --count N            how many bots join (default 5; at most 16 seats in total)
  --create N           create a new room with N bots instead of joining one
  --host-bot           with --create: the bot host starts the game once N bots are seated and drives it
  --games K            with --host-bot: play K games, pressing Play again in between (default 1, 0 = forever)
  --delay MS           base delay before each bot action (default 1500; jittered x0.6..1.4)
  --speech MS          delay before a bot ends its turn after revealing (default 2 x delay)
  --discussion MS      how long a bot host lets the discussion run before Next (default 4 x delay)
  --specials P         probability per round that a bot plays a special card (default 0.3). With P > 0 bots also
                       open Airlocks, often join an Airlock someone else opened, and revive players thrown out
                       through one (SPEC §11 X1)
  --patience MS        a bot host presses Next / Close vote when a (human) speaker or voter stalls this long
                       (default 0 = never; offline speakers and voters are always skipped)
  --end-game P         probability per game that a bot host presses End game at a random moment (default 0):
                       the table goes back to the lobby, and with --host-bot the next game starts (SPEC §11 X6)
  --spectator          join as spectators instead of players
  --seed S             seed for the bots' choices (default: random)
  --names A,B,C        bot names (default Bot Anna, Bot Boris, ...)
  --exit-on-final      exit after the last game's final (default: stay seated until Ctrl-C)
  --no-leave           on Ctrl-C just disconnect (seats stay, shown offline) instead of leaving
  --quiet              only print errors and the summary
  -h, --help           this text

Ctrl-C makes every bot leave the room and exits (press it twice to exit at once).`;

function parseArgs(argv) {
  const o = { url: 'http://localhost:8080', count: 5, delay: 1500, specials: 0.3, games: 1, patience: 0, 'end-game': 0 };
  const flags = new Set(['--host-bot', '--spectator', '--exit-on-final', '--no-leave', '--quiet', '-h', '--help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) { o[a.replace(/^-+/, '')] = true; continue; }
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`unknown argument ${a}`);
    const v = m[2] !== undefined ? m[2] : argv[++i];
    if (v === undefined) throw new Error(`${a} needs a value`);
    o[m[1]] = v;
  }
  const num = (k, min, max) => {
    if (o[k] === undefined) return;
    const n = Number(o[k]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${k} must be a number from ${min} to ${max}`);
    o[k] = n;
  };
  num('count', 1, 16);
  num('create', 1, 16);
  num('delay', 0, 600000);
  num('speech', 0, 600000);
  num('discussion', 0, 600000);
  num('specials', 0, 1);
  num('games', 0, 1e6);
  num('patience', 0, 3600000);
  num('end-game', 0, 1);
  return o;
}

function parseRoom(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = /[?&]room=([A-Za-z]{4})/.exec(s) || /^([A-Za-z]{4})$/.exec(s);
  if (!m) throw new Error(`cannot read a room code from ${JSON.stringify(v)}`);
  return m[1].toUpperCase();
}

function urlFromRoomLink(v) {
  try {
    if (v && /^https?:\/\//i.test(String(v))) return toHttpUrl(v);
  } catch { /* ignore */ }
  return null;
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (o.h || o.help) { console.log(HELP); return; }
  const createMode = o.create !== undefined;
  if (!createMode && !o.room) {
    console.error(`Give --room CODE to join a room, or --create N to make one.\n\n${HELP}`);
    process.exit(2);
  }
  const url = urlFromRoomLink(o.room) || toHttpUrl(o.url);
  const room = createMode ? null : parseRoom(o.room);
  const count = createMode ? o.create : o.count;
  const names = o.names ? String(o.names).split(',').map((s) => s.trim()).filter(Boolean) : BOT_NAMES;
  const seed = o.seed ?? String(Date.now());
  const quiet = !!o.quiet;
  const log = quiet ? null : (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
  const coord = new Coordinator();
  const bots = [];
  let finals = 0;
  let exiting = false;

  const mkBot = (i, hostOpts = {}) => new Bot({
    url, name: names[i % names.length] + (i >= names.length ? ` ${i + 1}` : ''), seed: `${seed}:${i}`,
    delay: o.delay, speechDelay: o.speech ?? 2 * o.delay, specials: o.specials, coordinator: coord, reconnect: true, log,
    maxRate: 16, // the server drops messages above 20/s per socket (SPEC §9)
    host: { discussionDelay: o.discussion ?? 4 * o.delay, patience: o.patience, endGame: o['end-game'], ...hostOpts },
  });

  async function shutdown(code = 0) {
    if (exiting) { process.exit(code); }
    exiting = true;
    console.log(o['no-leave'] ? '\nDisconnecting the bots...' : '\nThe bots are leaving the room...');
    for (const b of bots) {
      try { if (!o['no-leave'] && b.connected) b.leave(); } catch { /* ignore */ }
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const b of bots) b.close();
    const errors = bots.reduce((n, b) => n + b.errors.filter((e) => !e.expected).length, 0);
    console.log(`Done: ${bots.length} bot(s), ${finals} final(s) seen, ${errors} error repl${errors === 1 ? 'y' : 'ies'} from the server.`);
    setTimeout(() => process.exit(code), 100).unref();
  }
  process.on('SIGINT', () => { shutdown(0); });
  process.on('SIGTERM', () => { shutdown(0); });

  try {
    let code = room;
    if (createMode) {
      const host = mkBot(0, o['host-bot']
        ? { autoStart: count, playAgain: o.games !== 1, playAgainDelay: 6 * o.delay }
        : { handOverToHuman: true });
      bots.push(host);
      const res = await host.create();
      code = res.room;
      console.log(`Room ${code} created by ${host.name}.`);
    }
    for (let i = createMode ? 1 : 0; i < count; i++) {
      const b = mkBot(i);
      bots.push(b);
      const res = await b.join(code, { spectator: !!o.spectator });
      if (log) log(`[${b.name}] joined ${code} as ${res.state.you.role}${res.state.you.role === 'spectator' && !o.spectator ? ' (the game is running or the table is full)' : ''}`);
    }
    const link = roomLink(url, code);
    console.log(`\n${bots.length} bot(s) in room ${code}.\n  Room link: ${link}`);
    if (createMode && o['host-bot']) console.log('  Open the link, type a name and press "Watch" to follow the game as a spectator.');
    else if (createMode) console.log('  Open the link and join as a player: you get the host and can press Start.');
    console.log('  Ctrl-C to stop.\n');
    const watcher = bots[0];
    watcher.on('state', (s, prev) => {
      if (prev && prev.phase !== s.phase && !quiet) console.log(`-- ${describeState(s)}`);
      if (prev && s.phase === 'lobby' && prev.phase !== 'lobby' && prev.phase !== 'final') console.log('== The host ended the game: back to the lobby');
      if (s.phase === 'final' && (!prev || prev.phase !== 'final')) {
        finals++;
        const survivors = s.final.survivors.map((id) => s.players.find((p) => p.id === id)?.name).join(', ');
        console.log(`== Final #${finals}: in the bunker: ${survivors || 'nobody'}`);
        if (o['exit-on-final'] && (!createMode || !o['host-bot'] || (o.games && finals >= o.games))) setTimeout(() => shutdown(0), 500);
        if (createMode && o['host-bot'] && o.games && finals >= o.games) for (const b of bots) b.host.playAgain = false;
      }
    });
    for (const b of bots) {
      b.on('kicked', () => console.log(`[${b.name}] was kicked`));
      b.on('replaced', () => console.log(`[${b.name}] was replaced by another connection`));
      b.on('server-error', (e) => { if (quiet && !e.race) console.log(`[${b.name}] error ${e.code}: ${e.message}`); });
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
    await shutdown(1);
  }
}

main();
