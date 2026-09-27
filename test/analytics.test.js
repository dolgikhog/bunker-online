// server/analytics.js and its wiring (reports/analytics.md): first-party, aggregate-only usage counts, no cookies.
//   - counting: views, invites, bots (a number only), daily visitors (a salted hash per network + UA, IPv6 by /64),
//     sources, game events, peaks;
//   - isBotUA over crawlers, previewers, scripts and real browsers (the Cubot phone, in-app browsers);
//   - the salt: new at each UTC day (an injected clock), also with no traffic (the tick), never on disk;
//   - nothing personal on disk: the written file scanned for the address (every spelling), the UA, the salt, the
//     hashes and the Referer's path; the server's log lines too;
//   - the file: atomic (tmp + fsync + rename; a failed rename leaves the old file whole), missing -> fresh,
//     corrupt -> .bak and fresh, sanitized on load, KEEP_DAYS kept and older days archived, written on close and on
//     SIGTERM, counts carried across restarts;
//   - the dashboard's gate: constant time (every check hashes to 32 bytes and goes through timingSafeEqual), per-network
//     failed-attempt budget, and on the real server the same 404 as a missing file for no/wrong key, no token, a short
//     token, a spent budget; with the key an HTML page (no script, noindex, no-store, CSP) or JSON;
//   - dev mode (SPEC §11 X9) counts nothing and has no dashboard.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {
  Analytics, AdminGate, ADMIN_BURST, ADMIN_REFILL_MS, ADMIN_TOKEN_MIN, ANALYTICS_FILE, KEEP_DAYS, MAX_SOURCES_PER_DAY,
  OTHER_SOURCE, adminTokenUsable, dayKey, isBotUA, renderDashboard, sourceOf,
} from '../server/analytics.js';
import { startServer } from '../server/index.js';
import { startServer as spawnServer } from './helpers-sim.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bunker-analytics-test-'));
let dirSeq = 0;
const freshDir = () => { const d = path.join(TMP, `d${++dirSeq}`); fs.mkdirSync(d); return d; };
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

const DAY = 86_400_000;
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const TOKEN = 'k'.repeat(8) + 'TestAdminToken0123456789';

/** A clock the test moves. */
function clock(iso) {
  let t = Date.parse(iso);
  const now = () => t;
  now.set = (x) => { t = Date.parse(x); };
  now.add = (ms) => { t += ms; };
  return now;
}

// ---------------------------------------------------------------------------------------------------------------

describe('isBotUA', () => {
  test('crawlers, previewers, monitors and scripts are bots; so is no User-Agent', () => {
    const bots = [
      undefined, null, '', '   ', 'x'.repeat(1001),
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
      'Mozilla/5.0 (compatible; YandexWebmaster/2.0; +http://yandex.com/bots)',
      'Mozilla/5.0 (compatible; Google-Site-Verification/1.0)',
      'Mozilla/5.0 (compatible; Google-InspectionTool/1.0)',
      'Mediapartners-Google',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'TelegramBot (like TwitterBot)',
      'WhatsApp/2.23.20.0 A',
      'Mozilla/5.0 (compatible; vkShare; +http://vk.com/dev/Share)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slackbot-LinkExpanding 1.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 Chrome-Lighthouse',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
      'curl/8.9.1', 'Wget/1.24.5', 'python-requests/2.32.3', 'Go-http-client/2.0', 'okhttp/4.12.0', 'axios/1.7.7', 'node-fetch/1.0',
      'undici', 'Java/21.0.2', 'libwww-perl/6.72', 'Scrapy/2.11', 'UptimeRobot/2.0', 'Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)',
    ];
    for (const ua of bots) assert.equal(isBotUA(ua), true, String(ua).slice(0, 80));
  });

  test('people\'s browsers are not, in-app browsers and the Cubot phone included', () => {
    const people = [
      CHROME, SAFARI,
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 YaBrowser/25.8.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 390.0.0.0 (iPhone15,2; iOS 18_5; en_US)',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/500.0]',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36 Telegram-Android/11.0',
      'Opera/9.80 (Android; Opera Mini/7.5.33361/191.227; U; ru) Presto/2.12.423 Version/12.16',
    ];
    for (const ua of people) assert.equal(isBotUA(ua), false, ua.slice(0, 80));
  });
});

describe('sourceOf', () => {
  test('the external host, lower-cased and without www.; nothing for this site, IP literals and odd schemes', () => {
    assert.equal(sourceOf('https://www.Google.com/search?q=secret', 'sealthebunker.com'), 'google.com');
    assert.equal(sourceOf('https://t.me/', 'sealthebunker.com'), 't.me');
    assert.equal(sourceOf('android-app://org.telegram.messenger/', 'sealthebunker.com'), 'org.telegram.messenger');
    assert.equal(sourceOf('https://yandex.ru/', undefined), 'yandex.ru');
    for (const [ref, host] of [
      ['https://sealthebunker.com/?room=ABCD', 'sealthebunker.com'], ['https://www.sealthebunker.com/', 'sealthebunker.com'],
      ['http://127.0.0.1:8080/', '127.0.0.1:8080'], ['http://203.0.113.7/page', 'x.com'], ['http://[2001:db8::1]/', 'x.com'],
      ['ftp://example.com/', 'x.com'], ['javascript:alert(1)', 'x.com'], ['not a url', 'x.com'], ['', 'x.com'], [undefined, 'x.com'],
      ['https://' + 'a'.repeat(120) + '.com/', 'x.com'],
    ]) assert.equal(sourceOf(ref, host), null, String(ref));
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('Analytics counting', () => {
  test('views, invites and bots; a visitor is one network + browser per day (IPv6 by its /64)', () => {
    const a = new Analytics({ now: clock('2026-09-27T10:00:00Z') });
    assert.equal(a.pageView({ ip: '203.0.113.5', ua: CHROME }), 'view');
    assert.equal(a.pageView({ ip: '203.0.113.5', ua: CHROME, invite: true }), 'view');
    a.pageView({ ip: '::ffff:203.0.113.5', ua: CHROME }); // the same address, IPv4-mapped
    a.pageView({ ip: '203.0.113.5', ua: SAFARI }); // another browser on that network
    a.pageView({ ip: '203.0.113.6', ua: CHROME });
    a.pageView({ ip: '2001:db8:1:2::10', ua: CHROME });
    a.pageView({ ip: '2001:db8:1:2:aaaa::99', ua: CHROME }); // same /64: a privacy address of the same phone
    a.pageView({ ip: '2001:db8:1:3::10', ua: CHROME }); // another /64
    assert.equal(a.pageView({ ip: '198.51.100.1', ua: 'curl/8.9.1' }), 'bot');
    assert.equal(a.pageView({ ip: '198.51.100.1', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', invite: true }), 'bot');
    const d = a.report().periods.today;
    assert.equal(d.views, 8);
    assert.equal(d.invites, 1);
    assert.equal(d.bots, 2);
    assert.equal(d.visitors, 5);
  });

  test('sources: at most MAX_SOURCES_PER_DAY a day, the rest as "(other)"; bots add none', () => {
    const a = new Analytics({ now: clock('2026-09-27T10:00:00Z') });
    for (let i = 0; i < 40; i++) a.pageView({ ip: `10.0.0.${i}`, ua: CHROME, referer: `https://site${i}.example/`, host: 'sealthebunker.com' });
    a.pageView({ ip: '10.0.1.1', ua: CHROME, referer: 'https://site0.example/x', host: 'sealthebunker.com' });
    a.pageView({ ip: '10.0.1.2', ua: 'curl/8', referer: 'https://spam.example/' });
    const s = a.report().periods.today.sources;
    assert.equal(Object.keys(s).length, MAX_SOURCES_PER_DAY);
    assert.equal(s['site0.example'], 2);
    assert.equal(s[OTHER_SOURCE], 40 - (MAX_SOURCES_PER_DAY - 1));
    assert.equal(s['spam.example'], undefined);
  });

  test('game events: rooms, spectators, started with a seat histogram and languages, the three endings, peaks', () => {
    const a = new Analytics({ now: clock('2026-09-27T10:00:00Z') });
    a.roomCreated(); a.roomCreated();
    a.spectatorJoined();
    a.gameStarted({ players: 4, langs: { en: 3, ru: 1 } });
    a.gameStarted({ players: 16, langs: { ru: 16 } });
    a.gameStarted({ players: 6, langs: { en: 6, xx: 9 } });
    a.gameStarted({ players: 99, langs: {} }); // outside 2..16: counted, not in the histogram
    a.gameFinished(); a.gameEndedByHost(); a.gameAbandoned(); a.gameFinished();
    a.observe({ sockets: 7, activeGames: 2 });
    a.observe({ sockets: 3, activeGames: 5 });
    const d = a.report().periods.today;
    assert.deepEqual({ rooms: d.rooms, spectators: d.spectators, started: d.started, finished: d.finished, endedByHost: d.endedByHost, abandoned: d.abandoned, players: d.players },
      { rooms: 2, spectators: 1, started: 4, finished: 2, endedByHost: 1, abandoned: 1, players: 4 + 16 + 6 + 99 });
    assert.deepEqual(d.hist, { 4: 1, 6: 1, 16: 1 });
    assert.deepEqual(d.langs, { en: 9, ru: 17 });
    assert.equal(d.peakSockets, 7);
    assert.equal(d.peakGames, 5);
  });

  test('periods: today, 7 and 30 days, all time (peaks are maxima)', () => {
    const now = clock('2026-09-01T12:00:00Z');
    const a = new Analytics({ now });
    for (let i = 0; i < 40; i++) {
      a.pageView({ ip: '10.0.0.1', ua: CHROME });
      a.observe({ sockets: i });
      now.add(DAY);
    }
    now.add(-DAY); // the 40th day is today
    const p = a.report().periods;
    assert.equal(p.today.visitors, 1);
    assert.equal(p.last7.visitors, 7);
    assert.equal(p.last30.visitors, 30);
    assert.equal(p.all.visitors, 40);
    assert.equal(p.last7.peakSockets, 39);
    assert.equal(p.today.peakSockets, 39);
  });
});

describe('Analytics salt', () => {
  test('a new salt and an empty visitor set at UTC midnight: the same visitor counts again the next day', () => {
    const now = clock('2026-09-27T23:59:00Z');
    const salts = [];
    const a = new Analytics({ now, randomBytes: (n) => { const b = crypto.randomBytes(n); salts.push(b); return b; } });
    a.pageView({ ip: '203.0.113.5', ua: CHROME });
    const h1 = a._visitorHash('203.0.113.5', CHROME);
    now.add(30_000);
    a.pageView({ ip: '203.0.113.5', ua: CHROME });
    a.tick();
    assert.equal(salts.length, 1, 'one salt for the whole day, whatever the traffic and the ticks');
    assert.equal(a.report().periods.today.visitors, 1);
    now.set('2026-09-28T00:00:00Z');
    a.pageView({ ip: '203.0.113.5', ua: CHROME });
    assert.equal(salts.length, 2);
    assert.notDeepEqual(a._salt, salts[0]);
    assert.notEqual(a._visitorHash('203.0.113.5', CHROME), h1, 'the same visitor hashes differently on the new day');
    assert.equal(a._seen.size, 1, 'only the new day\'s hash is held');
    const r = a.report();
    assert.equal(r.days.find((d) => d.date === '2026-09-27').visitors, 1);
    assert.equal(r.days.find((d) => d.date === '2026-09-28').visitors, 1);
  });

  test('the tick rotates it at midnight with no traffic at all (the old salt does not linger)', () => {
    const now = clock('2026-09-27T23:59:30Z');
    let made = 0;
    const a = new Analytics({ now, randomBytes: (n) => { made++; return crypto.randomBytes(n); } });
    a.pageView({ ip: '203.0.113.5', ua: CHROME });
    const old = a._salt;
    now.add(60_000);
    a.tick();
    assert.equal(made, 2);
    assert.notDeepEqual(a._salt, old);
    assert.equal(a._seen.size, 0);
  });

  test('close() drops the salt and the day\'s hashes', async () => {
    const a = new Analytics({ now: clock('2026-09-27T10:00:00Z') });
    a.pageView({ ip: '203.0.113.5', ua: CHROME });
    await a.close();
    assert.equal(a._salt, null);
    assert.equal(a._seen.size, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** Everything personal a request carried, in every spelling a file could hold it. */
function assertNothingPersonal(text, { ips = [], uas = [], secrets = [] }) {
  for (const ip of ips) assert.ok(!text.includes(ip), `address ${ip} on disk`);
  for (const ua of uas) {
    assert.ok(!text.includes(ua), 'a user agent on disk');
    for (const piece of ua.split(/[\s;()/]+/).filter((x) => x.length >= 6 && /\d|[A-Z]/.test(x))) assert.ok(!text.includes(piece), `UA piece ${piece} on disk`);
  }
  for (const s of secrets) assert.ok(!text.includes(s), `secret ${s.slice(0, 12)}… on disk`);
}

describe('Analytics file', () => {
  test('no address, user agent, salt, hash or referrer path ever reaches the file', async () => {
    const dir = freshDir();
    const file = path.join(dir, ANALYTICS_FILE);
    const a = new Analytics({ file, now: clock('2026-09-27T10:00:00Z') });
    const ips = ['203.0.113.77', '2001:db8:77:1::5', '198.51.100.23'];
    const uas = [`${CHROME} UniqueMarker/9.8.7`, `${SAFARI} OtherMarker/1.2.3`];
    for (const ip of ips) for (const ua of uas) a.pageView({ ip, ua, referer: 'https://www.google.com/search?q=PrivateQuery123', host: 'sealthebunker.com', invite: true });
    a.pageView({ ip: '203.0.113.78', ua: 'curl/8.9.1 BotMarker/4.4' });
    a.gameStarted({ players: 5, langs: { en: 2, ru: 3 } });
    const hashes = [...a._seen];
    const salt = a._salt;
    assert.equal(hashes.length, 6);
    await a.flush();
    const text = fs.readFileSync(file, 'utf8');
    assertNothingPersonal(text, {
      ips: [...ips, '203.0.113.78', '2001:db8:77:1::/64', '2001:db8:77:1'],
      uas: [...uas, 'curl/8.9.1 BotMarker/4.4'],
      secrets: [...hashes, salt.toString('hex'), salt.toString('base64'), salt.toString('base64url'), 'PrivateQuery123', '/search'],
    });
    // and only the known shape: day records of counts
    const obj = JSON.parse(text);
    assert.deepEqual(Object.keys(obj).sort(), ['archived', 'days', 'since', 'v']);
    const day = obj.days['2026-09-27'];
    assert.deepEqual(Object.keys(day).sort(), ['abandoned', 'bots', 'endedByHost', 'finished', 'hist', 'invites', 'langs', 'peakGames', 'peakSockets', 'players', 'rooms', 'sources', 'spectators', 'started', 'views', 'visitors']);
    assert.deepEqual(day.sources, { 'google.com': 6 });
    assert.equal(day.visitors, 6);
    assert.equal(day.bots, 1);
    for (const [k, v] of Object.entries(day)) if (typeof v !== 'object') assert.ok(Number.isSafeInteger(v), k);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
    await a.close();
  });

  test('written atomically: tmp + rename, no temp file left; a failed rename leaves the old file whole and retries', async () => {
    const dir = freshDir();
    const file = path.join(dir, ANALYTICS_FILE);
    const logs = [];
    const a = new Analytics({ file, now: clock('2026-09-27T10:00:00Z'), logger: (m, e) => logs.push(`${m} ${e ?? ''}`) });
    a.roomCreated();
    assert.equal(await a.flush(), true);
    const good = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(good).days['2026-09-27'].rooms, 1);
    assert.deepEqual(fs.readdirSync(dir), [ANALYTICS_FILE]);
    assert.equal(await a.flush(), false, 'nothing changed: nothing written');

    const realRename = fs.promises.rename;
    const realRenameSync = fs.renameSync;
    fs.promises.rename = async () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); };
    fs.renameSync = () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); };
    try {
      a.roomCreated();
      assert.equal(await a.flush(), false);
      assert.equal(a.flushSync(), false);
      assert.equal(fs.readFileSync(file, 'utf8'), good, 'the old file is untouched');
      assert.deepEqual(fs.readdirSync(dir), [ANALYTICS_FILE], 'the temp file is removed');
      assert.equal(a.dirty, true, 'still to be written');
      assert.equal(logs.length, 1, 'a failing write is logged once, not every minute');
      assert.match(logs[0], /cannot write .* EIO/);
    } finally {
      fs.promises.rename = realRename;
      fs.renameSync = realRenameSync;
    }
    assert.equal(await a.flush(), true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).days['2026-09-27'].rooms, 2);
    await a.close();
  });

  test('close() waits for a write in flight, then writes the rest; the directory is made when missing', async () => {
    const dir = path.join(freshDir(), 'nested', 'state');
    const file = path.join(dir, ANALYTICS_FILE);
    const a = new Analytics({ file, now: clock('2026-09-27T10:00:00Z') });
    a.roomCreated();
    const inFlight = a.flush();
    a.roomCreated(); a.roomCreated();
    await a.close();
    await inFlight;
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).days['2026-09-27'].rooms, 3);
    a.roomCreated(); // after close: counted in memory, never written
    assert.equal(await a.flush(), false);
  });

  test('missing file: fresh, silently; counts carry over a restart', async () => {
    const dir = freshDir();
    const file = path.join(dir, ANALYTICS_FILE);
    const logs = [];
    const now = clock('2026-09-27T10:00:00Z');
    const a = new Analytics({ file, now, logger: (m) => logs.push(m) });
    assert.equal(a.days.size, 0);
    a.pageView({ ip: '10.0.0.1', ua: CHROME });
    a.gameStarted({ players: 4, langs: { en: 4 } });
    await a.close();
    const b = new Analytics({ file, now, logger: (m) => logs.push(m) });
    b.pageView({ ip: '10.0.0.1', ua: CHROME }); // a new salt after the restart: the same visitor counts again (documented)
    b.gameStarted({ players: 4, langs: { ru: 4 } });
    const d = b.report().periods.today;
    assert.deepEqual([d.views, d.visitors, d.started, d.hist[4]], [2, 2, 2, 2]);
    assert.deepEqual(d.langs, { en: 4, ru: 4 });
    assert.equal(b.since, '2026-09-27');
    assert.deepEqual(logs, []);
    await b.close();
  });

  test('a corrupt or foreign file is moved to .bak and counting starts fresh', async () => {
    for (const bad of ['{"v":1,"days":{"2026-09-2', 'null', '[]', '{"v":2,"days":{}}', '{"v":1}', '{"v":1,"days":[]}', '\u0000\u0001garbage']) {
      const dir = freshDir();
      const file = path.join(dir, ANALYTICS_FILE);
      fs.writeFileSync(file, bad);
      const logs = [];
      const a = new Analytics({ file, now: clock('2026-09-27T10:00:00Z'), logger: (m) => logs.push(m) });
      assert.equal(a.days.size, 0, bad);
      assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), bad, 'the unreadable file is kept as .bak');
      assert.equal(fs.existsSync(file), false);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /not a valid analytics file; moved to analytics\.json\.bak/);
      a.roomCreated();
      await a.close();
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).days['2026-09-27'].rooms, 1);
    }
  });

  test('sanitized on load: unknown fields, bad numbers, bad day keys and bad hosts are dropped', () => {
    const dir = freshDir();
    const file = path.join(dir, ANALYTICS_FILE);
    fs.writeFileSync(file, JSON.stringify({
      v: 1, since: '2026-09-20', ip: '203.0.113.1',
      archived: { views: 5, sources: { 'old.example': 3 }, extra: 'x' },
      days: {
        '2026-09-26': { views: 10, visitors: -3, bots: 1.5, rooms: '7', started: 2, ip: '203.0.113.1', hist: { 4: 2, 1: 9, 17: 1, x: 1 }, langs: { en: 3, de: 4 }, sources: { 'google.com': 2, '203.0.113.1': 1, '<script>': 1 } },
        'yesterday': { views: 99 }, '2026-02-30': { views: 99 }, '2026-9-1': { views: 99 },
      },
    }));
    const a = new Analytics({ file, now: clock('2026-09-27T10:00:00Z') });
    assert.deepEqual([...a.days.keys()], ['2026-09-26']);
    const d = a.days.get('2026-09-26');
    assert.deepEqual([d.views, d.visitors, d.bots, d.rooms, d.started], [10, 0, 0, 0, 2]);
    assert.deepEqual(d.hist, { 4: 2 });
    assert.deepEqual(d.langs, { en: 3 });
    assert.deepEqual(d.sources, { 'google.com': 2 });
    assert.equal(d.ip, undefined);
    assert.equal(a.archived.views, 5);
    assert.deepEqual(a.archived.sources, {});
    assert.equal(a.since, '2026-09-20');
    assert.ok(!a.serialize().includes('203.0.113.1'));
  });

  test(`${KEEP_DAYS} days are kept; older days fold into the all-time totals`, async () => {
    const dir = freshDir();
    const file = path.join(dir, ANALYTICS_FILE);
    const now = clock('2025-01-01T12:00:00Z');
    const a = new Analytics({ file, now });
    for (let i = 0; i < KEEP_DAYS + 30; i++) {
      a.pageView({ ip: '10.0.0.1', ua: CHROME, referer: 'https://t.me/' });
      a.gameStarted({ players: 5, langs: { en: 5 } });
      now.add(DAY);
    }
    now.add(-DAY);
    a.tick();
    assert.equal(a.days.size, KEEP_DAYS);
    assert.equal([...a.days.keys()].sort()[0], dayKey(now() - (KEEP_DAYS - 1) * DAY));
    const all = a.report().periods.all;
    assert.equal(all.views, KEEP_DAYS + 30);
    assert.equal(all.started, KEEP_DAYS + 30);
    assert.equal(all.hist[5], KEEP_DAYS + 30);
    assert.equal(a.since, '2025-01-01');
    await a.close();
    const size = fs.statSync(file).size;
    assert.ok(size < 200 * 1024, `the file stays small: ${size} bytes`);
    const b = new Analytics({ file, now });
    assert.equal(b.report().periods.all.views, KEEP_DAYS + 30, 'the archive survives a reload');
    assert.equal(b.since, '2025-01-01');
  });

  test('stale temp files of an interrupted write are removed on load (fresh ones may belong to a writer)', () => {
    const dir = freshDir();
    const file = path.join(dir, ANALYTICS_FILE);
    fs.writeFileSync(file, JSON.stringify({ v: 1, days: {} }));
    const stale = `${file}.123.abcd.tmp`;
    const fresh = `${file}.456.ef01.tmp`;
    fs.writeFileSync(stale, '{');
    fs.writeFileSync(fresh, '{');
    const old = (Date.now() - 2 * 3_600_000) / 1000;
    fs.utimesSync(stale, old, old);
    new Analytics({ file }); // eslint-disable-line no-new
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('AdminGate', () => {
  test('adminTokenUsable: at least ADMIN_TOKEN_MIN characters', () => {
    assert.equal(ADMIN_TOKEN_MIN, 24);
    assert.equal(adminTokenUsable('x'.repeat(24)), true);
    for (const t of ['', 'x'.repeat(23), undefined, null, 12345678901234567890123456]) assert.equal(adminTokenUsable(t), false, String(t));
    assert.throws(() => new AdminGate({ token: 'short' }), /at least 24/);
  });

  test('only the exact token matches, and every check takes the constant-time path over 32-byte digests', () => {
    const gate = new AdminGate({ token: TOKEN });
    const real = crypto.timingSafeEqual;
    const calls = [];
    crypto.timingSafeEqual = (a, b) => { calls.push([a.length, b.length]); return real(a, b); };
    try {
      const wrong = [undefined, null, '', 'x', TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase(), ` ${TOKEN}`, TOKEN.replace(/.$/, 'Z'), ['a'], 42];
      for (const k of wrong) assert.equal(gate.matches(k), false, String(k));
      assert.equal(gate.matches(TOKEN), true);
      assert.equal(calls.length, wrong.length + 1, 'no early return before the comparison, whatever the key');
      for (const [x, y] of calls) assert.deepEqual([x, y], [32, 32]);
    } finally {
      crypto.timingSafeEqual = real;
    }
  });

  test('failed attempts per network: a burst, then even the right key is refused until the budget refills', () => {
    const now = clock('2026-09-27T10:00:00Z');
    const gate = new AdminGate({ token: TOKEN, now });
    assert.equal(ADMIN_BURST, 10);
    for (let i = 0; i < ADMIN_BURST; i++) assert.equal(gate.check('203.0.113.9', `guess${i}`), false);
    assert.equal(gate.check('203.0.113.9', TOKEN), false, 'spent: the right key is refused too');
    assert.equal(gate.check('::ffff:203.0.113.9', TOKEN), false, 'the same network in another spelling');
    assert.equal(gate.check('203.0.113.10', TOKEN), true, 'another network is not affected');
    now.add(ADMIN_REFILL_MS);
    assert.equal(gate.check('203.0.113.9', TOKEN), true, 'one attempt back after the refill');
    assert.equal(gate.check('203.0.113.9', 'nope'), false);
    assert.equal(gate.check('203.0.113.9', TOKEN), false, 'and it was spent again');
    // IPv6: a /64 is one network
    for (let i = 0; i < ADMIN_BURST; i++) gate.check(`2001:db8:5:6::${i + 1}`, 'x');
    assert.equal(gate.check('2001:db8:5:6:ffff::1', TOKEN), false);
    now.add(ADMIN_BURST * ADMIN_REFILL_MS);
    gate.sweep();
    assert.equal(gate.buckets.size, 0, 'refilled budgets are dropped');
    assert.equal(gate.check('203.0.113.9', TOKEN), true);
  });

  test('the budget map is bounded: past maxBuckets, new networks share one budget', () => {
    const gate = new AdminGate({ token: TOKEN, now: clock('2026-09-27T10:00:00Z'), maxBuckets: 5 });
    for (let i = 0; i < 40; i++) gate.check(`10.0.0.${i}`, 'x');
    assert.equal(gate.buckets.size, 6, 'five networks and the shared one');
    assert.equal(gate.check('10.0.1.1', TOKEN), false, 'the shared overflow budget is spent: a fresh network is throttled with it');
    assert.equal(gate.check('10.0.0.1', TOKEN), true, 'a network with a budget of its own is judged by it');
  });
});

// ---------------------------------------------------------------------------------------------------------------

function get(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const without = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => k !== 'date'));

function openWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const c = { ws, msgs: [] };
    ws.on('message', (d) => c.msgs.push(JSON.parse(String(d))));
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
/** Sends `msg` and a ping, and returns what came before the pong. */
async function send(c, msg) {
  const n = c.msgs.length;
  c.ws.send(JSON.stringify(msg));
  c.ws.send('{"t":"ping"}');
  const t0 = Date.now();
  for (;;) {
    const i = c.msgs.slice(n).findIndex((m) => m.t === 'pong');
    if (i >= 0) return c.msgs.slice(n, n + i);
    if (Date.now() - t0 > 3000) throw new Error(`no pong after ${JSON.stringify(msg)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const phase = (c) => c.msgs.filter((m) => m.t === 'state').pop()?.phase;

async function withServer(opts, fn) {
  const logs = [];
  const srv = await startServer({
    port: 0, host: '127.0.0.1', dev: false, noLimits: false, minPlayers: 2, seed: 'analytics', adminToken: TOKEN,
    logger: (m, e) => logs.push(`${m}${e ? `: ${e?.stack || e}` : ''}`), ...opts,
  });
  try { await fn(srv, logs); } finally { await srv.close(); }
  return logs;
}

describe('on the real server', () => {
  test('GETs of the app page are counted (bots apart); other paths, HEAD and the dashboard are not', async () => {
    const dir = freshDir();
    await withServer({ stateDir: dir }, async (srv) => {
      const ua = { 'User-Agent': CHROME };
      assert.equal((await get(srv.port, '/', { headers: ua })).status, 200);
      await get(srv.port, '/index.html', { headers: ua });
      await get(srv.port, '/?room=ABCD', { headers: { ...ua, Referer: 'https://t.me/' } });
      await get(srv.port, '/', { headers: { 'User-Agent': 'curl/8.9.1' } });
      await get(srv.port, '/', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } });
      await get(srv.port, '/', { method: 'HEAD', headers: ua });
      for (const p of ['/app.js', '/style.css', '/healthz', '/stats', '/no-such', `/admin/stats?key=${TOKEN}`, '/admin/stats']) await get(srv.port, p, { headers: ua });
      const d = srv.analytics.report().periods.today;
      assert.deepEqual([d.views, d.invites, d.bots, d.visitors], [3, 1, 2, 1]);
      assert.deepEqual(d.sources, { 't.me': 1 });
    });
    const d = JSON.parse(fs.readFileSync(path.join(dir, ANALYTICS_FILE), 'utf8')).days[dayKey(Date.now())];
    assert.equal(d.views, 3, 'written on close');
  });

  test('behind the proxy (trustProxy): visitors are told apart by the forwarded address; nothing personal on disk or in the log', async () => {
    const dir = freshDir();
    const logs = await withServer({ stateDir: dir, trustProxy: true }, async (srv) => {
      for (const ip of ['203.0.113.41', '203.0.113.42', '203.0.113.42', '2001:db8:42::7']) {
        await get(srv.port, '/', { headers: { 'User-Agent': `${CHROME} Marker/42.1`, 'X-Forwarded-For': `10.9.9.9, ${ip}` } });
      }
      assert.equal(srv.analytics.report().periods.today.visitors, 3);
    });
    const text = fs.readFileSync(path.join(dir, ANALYTICS_FILE), 'utf8');
    assertNothingPersonal(text, { ips: ['203.0.113.41', '203.0.113.42', '2001:db8:42', '10.9.9.9'], uas: [`${CHROME} Marker/42.1`] });
    assertNothingPersonal(logs.join('\n'), { ips: ['203.0.113.41', '203.0.113.42', '2001:db8:42', '10.9.9.9'], uas: [`${CHROME} Marker/42.1`] });
  });

  test('game metrics from the rooms: created, spectators, started (seats, languages), ended by host, finished, abandoned, peaks', async () => {
    await withServer({ stateDir: null, roomTtlMs: 30 }, async (srv, logs) => {
      const a = await openWs(srv.port);
      const b = await openWs(srv.port);
      const s = await openWs(srv.port);
      const room = (await send(a, { t: 'create', name: 'Anna', lang: 'ru' })).find((m) => m.t === 'joined').room;
      await send(b, { t: 'join', room, name: 'Boris' });
      await send(s, { t: 'join', room, name: 'Sam', spectator: true });
      await send(a, { t: 'start' });
      assert.equal(phase(a), 'reveal');
      await send(a, { t: 'endGame' });
      assert.equal(phase(a), 'lobby');
      await send(a, { t: 'start' });
      await send(b, { t: 'leave' }); // 1 alive <= 1 bed: the final
      assert.equal(phase(a), 'final');
      await send(a, { t: 'playAgain' });
      assert.equal(phase(a), 'lobby');
      // a third game left behind by everyone: deleted idle mid-game, an abandoned game
      const c = await openWs(srv.port);
      const d = await openWs(srv.port);
      const room2 = (await send(c, { t: 'create', name: 'Cleo' })).find((m) => m.t === 'joined').room;
      await send(d, { t: 'join', room: room2, name: 'Dan' });
      await send(c, { t: 'start' });
      const r = srv.analytics.report().periods.today;
      assert.equal(r.peakSockets, 5);
      assert.equal(r.peakGames, 1);
      c.ws.terminate(); d.ws.terminate();
      await new Promise((res) => setTimeout(res, 150));
      srv.rooms.sweep();
      assert.equal(srv.rooms.rooms.has(room2), false);
      const t = srv.analytics.report().periods.today;
      assert.deepEqual({ rooms: t.rooms, spectators: t.spectators, started: t.started, endedByHost: t.endedByHost, finished: t.finished, abandoned: t.abandoned, players: t.players },
        { rooms: 2, spectators: 1, started: 3, endedByHost: 1, finished: 1, abandoned: 1, players: 6 });
      assert.deepEqual(t.hist, { 2: 3 });
      assert.deepEqual(t.langs, { ru: 2, en: 4 });
      for (const x of [a, b, s]) x.ws.terminate();
      const all = logs.join('\n');
      for (const name of ['Anna', 'Boris', 'Sam', 'Cleo', 'Dan', room, room2]) assert.ok(!all.includes(name) || all.includes(`room ${name} deleted`), `${name} in the log`);
    });
  });

  test('the dashboard: 404 byte for byte like a missing file without the key, with a wrong one, and without a usable token', async () => {
    const check = async (srv, p, headers = {}) => {
      const missing = await get(srv.port, '/no-such-file');
      const r = await get(srv.port, p, { headers });
      assert.equal(r.status, 404, p);
      assert.equal(r.body, missing.body, p);
      assert.deepEqual(without(r.headers), without(missing.headers), p);
      const h = await get(srv.port, p, { method: 'HEAD', headers });
      assert.equal(h.status, 404, `HEAD ${p}`);
    };
    await withServer({ stateDir: null, adminGate: { burst: 100 } }, async (srv) => {
      assert.equal(srv.adminEnabled, true);
      for (const p of ['/admin/stats', '/admin/stats?key=', '/admin/stats?key=wrong', `/admin/stats?key=${TOKEN.slice(0, -1)}`, `/admin/stats?key=${TOKEN}x`, `/admin/stats?token=${TOKEN}`]) await check(srv, p);
      assert.equal((await get(srv.port, `/admin/stats?key=${TOKEN}`, { method: 'POST' })).status, 405, 'other methods: the static 405, as for any path');
      assert.equal((await get(srv.port, `/admin/stats/?key=${TOKEN}`)).status, 404);
      assert.equal((await get(srv.port, `/admin/stats?key=${TOKEN}`)).status, 200, 'the right key works');
    });
    for (const adminToken of ['', 'x'.repeat(ADMIN_TOKEN_MIN - 1), undefined]) {
      await withServer({ stateDir: null, adminToken }, async (srv) => {
        assert.equal(srv.adminEnabled, false);
        await check(srv, `/admin/stats?key=${encodeURIComponent(adminToken ?? '')}`);
        await check(srv, `/admin/stats?key=${TOKEN}`);
      });
    }
    await withServer({ stateDir: null, analytics: false }, async (srv) => {
      assert.equal(srv.analytics, null);
      await check(srv, `/admin/stats?key=${TOKEN}`);
    });
  });

  test('the dashboard with the key: self-contained HTML (no script, no external asset, noindex, no-store), and JSON', async () => {
    await withServer({ stateDir: null }, async (srv) => {
      await get(srv.port, '/', { headers: { 'User-Agent': CHROME, Referer: 'https://evil.example/"><script>alert(1)</script>' } });
      await get(srv.port, '/', { headers: { 'User-Agent': CHROME, Referer: 'https://a"b.example/' } });
      const r = await get(srv.port, `/admin/stats?key=${TOKEN}`);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers['x-robots-tag'], 'noindex, nofollow');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.match(r.headers['content-security-policy'], /default-src 'none'/);
      assert.doesNotMatch(r.headers['content-security-policy'], /script-src/);
      assert.match(r.body, /<meta name="robots" content="noindex, nofollow">/);
      assert.doesNotMatch(r.body, /<script/i);
      assert.doesNotMatch(r.body, /\s(?:src|href)="(?:https?:)?\/\//i, 'no external asset or link');
      assert.doesNotMatch(r.body, /<link\b/i);
      assert.match(r.body, /<svg/);
      assert.match(r.body, /Visitors per day/);
      assert.match(r.body, /Players per started game/);
      assert.match(r.body, /Language of seated players/);
      assert.match(r.body, /evil\.example/, 'the source is listed …');
      const h = await get(srv.port, `/admin/stats?key=${TOKEN}`, { method: 'HEAD' });
      assert.equal(h.status, 200);
      assert.equal(h.body, '');
      const j = await get(srv.port, `/admin/stats?key=${TOKEN}&format=json`);
      assert.equal(j.status, 200);
      assert.equal(j.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(j.headers['cache-control'], 'no-store');
      assert.equal(j.headers['x-robots-tag'], 'noindex, nofollow');
      const data = JSON.parse(j.body);
      assert.deepEqual(Object.keys(data.periods), ['today', 'last7', 'last30', 'all']);
      assert.equal(data.periods.today.views, 2);
      assert.deepEqual(data.live, { sockets: 0, rooms: 0, activeGames: 0 });
      assert.equal(data.timezone, 'UTC');
    });
  });

  test('renderDashboard escapes whatever a day record holds', () => {
    const now = clock('2026-09-27T10:00:00Z');
    const a = new Analytics({ now });
    a.days.set('2026-09-27', { ...a.report().periods.today, sources: { '<b>x</b>': 1, 'a"b': 2 } });
    const html = renderDashboard(a.report(), { jsonHref: '?key=<k>&format=json' });
    assert.ok(!html.includes('<b>x</b>'));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
    assert.ok(html.includes('?key=&lt;k&gt;&amp;format=json'));
  });

  test('the dashboard\'s failed-attempt budget per client network (the forwarded address behind the proxy)', async () => {
    await withServer({ stateDir: null, trustProxy: true }, async (srv) => {
      const from = (ip) => ({ 'X-Forwarded-For': ip });
      for (let i = 0; i < ADMIN_BURST; i++) assert.equal((await get(srv.port, `/admin/stats?key=guess${i}`, { headers: from('198.51.100.7') })).status, 404);
      assert.equal((await get(srv.port, `/admin/stats?key=${TOKEN}`, { headers: from('198.51.100.7') })).status, 404, 'spent: the right key is refused too');
      assert.equal((await get(srv.port, `/admin/stats?key=${TOKEN}`, { headers: from('198.51.100.8') })).status, 200, 'another client');
    });
  });

  test('dev mode (§11 X9) counts nothing, writes nothing and has no dashboard', async () => {
    const dir = freshDir();
    await withServer({ dev: true, stateDir: dir }, async (srv) => {
      assert.equal(srv.analytics, null);
      assert.equal(srv.rooms.analytics, null);
      assert.equal(srv.adminEnabled, false);
      await get(srv.port, '/', { headers: { 'User-Agent': CHROME } });
      const c = await openWs(srv.port);
      await send(c, { t: 'create', name: 'Dev' });
      c.ws.terminate();
      assert.equal((await get(srv.port, `/admin/stats?key=${TOKEN}`)).status, 404);
    });
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('counts survive a restart of the server (the same state directory)', async () => {
    const dir = freshDir();
    for (let i = 0; i < 2; i++) {
      await withServer({ stateDir: dir }, async (srv) => {
        await get(srv.port, '/', { headers: { 'User-Agent': CHROME } });
        const c = await openWs(srv.port);
        await send(c, { t: 'create', name: 'X' });
        c.ws.terminate();
      });
    }
    const d = JSON.parse(fs.readFileSync(path.join(dir, ANALYTICS_FILE), 'utf8')).days[dayKey(Date.now())];
    assert.equal(d.views, 2);
    assert.equal(d.rooms, 2);
  });
});

async function waitFor(pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
}

describe('the server process', () => {
  let dir;
  before(() => { dir = freshDir(); });

  test('SIGTERM writes the day\'s counts before exiting (BUNKER_STATE_DIR)', { timeout: 20000 }, async () => {
    const srv = await spawnServer({ env: { BUNKER_STATE_DIR: dir, BUNKER_ADMIN_TOKEN: TOKEN }, noLimits: false });
    try {
      await waitFor(() => /public dir/.test(srv.stderr()));
      assert.match(srv.stderr(), /usage counts in .*analytics\.json, dashboard at \/admin\/stats/);
      assert.ok(!srv.stderr().includes(TOKEN), 'the token is never printed');
      await get(srv.port, '/', { headers: { 'User-Agent': CHROME } });
      await get(srv.port, '/?room=QWER', { headers: { 'User-Agent': SAFARI } });
      assert.equal((await get(srv.port, `/admin/stats?key=${TOKEN}`)).status, 200);
    } finally {
      await srv.stop();
    }
    assert.equal(srv.exited.code, 0);
    assert.deepEqual(srv.problems(), []);
    const d = JSON.parse(fs.readFileSync(path.join(dir, ANALYTICS_FILE), 'utf8')).days[dayKey(Date.now())];
    assert.deepEqual([d.views, d.invites, d.visitors], [2, 1, 2]);
  });

  test('a BUNKER_ADMIN_TOKEN shorter than 24 characters is refused with a warning (and never printed)', { timeout: 20000 }, async () => {
    const short = 'shortToken123';
    const srv = await spawnServer({ env: { BUNKER_STATE_DIR: dir, BUNKER_ADMIN_TOKEN: short } });
    try {
      await waitFor(() => /shorter than/.test(srv.stderr()));
      assert.match(srv.stderr(), /BUNKER_ADMIN_TOKEN is shorter than 24 characters/);
      assert.ok(!srv.stderr().includes(short));
      assert.equal((await get(srv.port, `/admin/stats?key=${short}`)).status, 404);
    } finally {
      await srv.stop();
    }
  });
});
