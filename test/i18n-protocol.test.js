// SPEC §11 X5.1–X5.2, reports/i18n-design.md §2, §3.8, §11.3 — the language protocol (i18n-server, A2):
//   - `lang` on create, join and resume; setLang at any time (before joining: no reply; joined: one state to that socket
//     only); a bad lang is bad_request; a hello's own lang applies before it is handled;
//   - errors in the socket's language, kicked.reason in the kicked member's, `replaced` in the old socket's;
//   - you.lang; the language survives Play again, End game, takeSeat and a resume (with and without lang);
//   - T1 ordering with setLang between actions; a pre-X5 client (never a lang) gets English everywhere;
//   - the state frame with the log spliced in (serialized once per language) parses to the same state;
//   - over a real socket: 30 setLang in one burst, the normal rate limit, the last handled one wins.
// Tests read the catalogue for the expected words (renderText), never literal Russian: the translation may change.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Rooms, stateFrame } from '../server/rooms.js';
import { mulberry32 } from '../server/rng.js';
import { renderText, categoryLabel } from '../server/i18n/index.js';
import { startServer } from '../server/index.js';
import { validateServerMessage } from './stateview-schema.js';

const CYRILLIC = /[А-Яа-яЁё]/;

function world({ minPlayers = 2, splice = false } = {}) {
  let t = 1_800_000_000_000;
  const rooms = new Rooms({ rng: mulberry32(7), minPlayers, now: () => (t += 10), maxRoomsPerIp: Infinity, joinFailBurst: Infinity });
  let ipN = 0;
  const conn = (name) => {
    const c = { ip: `198.51.100.${++ipN}`, name, sent: [], frames: [] };
    c.send = (obj) => { c.sent.push(JSON.parse(JSON.stringify(obj))); };
    if (splice) c.sendText = (text) => { c.frames.push(text); c.sent.push(JSON.parse(text)); };
    rooms.open(c);
    c.msg = (m) => rooms.message(c, typeof m === 'string' ? m : JSON.stringify(m));
    c.last = () => c.sent.at(-1);
    c.states = () => c.sent.filter((m) => m.t === 'state');
    c.state = () => c.states().at(-1);
    c.take = () => c.sent.splice(0);
    return c;
  };
  return { rooms, conn };
}

/** Every message must still match SPEC §7 (with the X5.2 additions). */
function valid(c) {
  for (const m of c.sent) assert.deepEqual(validateServerMessage(m), [], `${c.name}: ${JSON.stringify(m).slice(0, 200)}`);
}

/** Creates a room with a host (in `lang`, or none) and `n - 1` more players; returns the conns and the room code. */
function table(w, n, langs = []) {
  const host = w.conn('host');
  host.msg({ t: 'create', name: 'Anna', ...(langs[0] ? { lang: langs[0] } : {}) });
  const room = host.sent.find((m) => m.t === 'joined').room;
  const conns = [host];
  for (let i = 1; i < n; i++) {
    const c = w.conn(`p${i}`);
    c.msg({ t: 'join', room, name: `Bob${i}`, ...(langs[i] ? { lang: langs[i] } : {}) });
    conns.push(c);
  }
  return { room, conns, host };
}

const joinedOf = (c) => c.sent.find((m) => m.t === 'joined');

describe('§11 X5.1 lang on the hellos and setLang', () => {
  test('setLang before joining sets the socket\'s language without a reply; the next error and state follow it', () => {
    const w = world();
    const c = w.conn('c');
    c.msg({ t: 'setLang', lang: 'ru' });
    assert.deepEqual(c.sent, [], 'no reply to setLang before joining');
    c.msg({ t: 'join', room: 'ZZZZ', name: 'Вера' });
    assert.deepEqual(c.last(), { t: 'error', code: 'no_room', message: renderText('ru', 'err.noRoomJoin') });
    c.msg({ t: 'create', name: 'Вера' });
    const s = c.state();
    assert.equal(s.you.lang, 'ru');
    assert.equal(s.log.at(-1).text, renderText('ru', 'log.host', { p: { p: s.you.id, n: 'Вера' }, why: null }));
    assert.equal(s.categories[0].label, categoryLabel('ru', 'profession'));
    valid(c);
  });

  test('lang on create, join and resume; a resume without lang keeps the member\'s language and takes it over', () => {
    const w = world();
    const { room, conns: [host, guest] } = table(w, 2, ['ru', 'en']);
    assert.equal(host.state().you.lang, 'ru');
    assert.equal(guest.state().you.lang, 'en');
    // the same log line, in each recipient's language
    const line = (c) => c.state().log.at(-1);
    assert.equal(line(host).id, line(guest).id);
    assert.equal(line(guest).text, 'Bob1 joined');
    assert.equal(line(host).text, renderText('ru', 'log.join', { p: { p: 'p2', n: 'Bob1' } }));
    assert.deepEqual(line(host).params, line(guest).params);
    assert.equal(line(host).key, 'log.join');
    // resume with lang: the member switches
    const token = joinedOf(guest).token;
    const tab = w.conn('tab');
    tab.msg({ t: 'resume', room, token, lang: 'ru' });
    assert.equal(tab.state().you.lang, 'ru');
    assert.equal(w.rooms.rooms.get(room).game.langOf(joinedOf(guest).id), 'ru');
    // resume without lang (a socket set to English before): keeps ru and takes it over for its own errors
    const tab2 = w.conn('tab2');
    tab2.msg({ t: 'setLang', lang: 'en' });
    tab2.msg({ t: 'resume', room, token });
    assert.equal(tab2.state().you.lang, 'ru');
    tab2.msg({ t: 'next' });
    assert.deepEqual(tab2.last(), { t: 'error', code: 'not_host', message: renderText('ru', 'err.not_host') });
    valid(host); valid(guest); valid(tab); valid(tab2);
  });

  test('a bad lang is bad_request, in the socket\'s language, and changes nothing', () => {
    const w = world();
    const { room, conns: [host] } = table(w, 1, ['ru']);
    for (const bad of ['de', 'RU', '', 5, null, ['ru'], { l: 'ru' }]) {
      host.take();
      host.msg({ t: 'setLang', lang: bad });
      assert.deepEqual(host.sent, [{ t: 'error', code: 'bad_request', message: renderText('ru', 'err.invalidField', { field: 'lang' }) }], JSON.stringify(bad));
    }
    host.msg({ t: 'setLang' });
    assert.deepEqual(host.last(), { t: 'error', code: 'bad_request', message: renderText('ru', 'err.missingField', { field: 'lang' }) });
    const c = w.conn('c');
    c.msg({ t: 'join', room, name: 'X', lang: 'fr' });
    assert.deepEqual(c.last(), { t: 'error', code: 'bad_request', message: renderText('en', 'err.invalidField', { field: 'lang' }) });
    c.msg({ t: 'create', name: 'X', lang: 1 });
    assert.equal(c.last().code, 'bad_request');
    assert.equal(w.rooms.rooms.get(room).game.langOf('p1'), 'ru');
    // a hello's own valid lang applies before the hello is handled, even when the hello then fails
    const d = w.conn('d');
    d.msg({ t: 'join', room: 'ZZZZ', name: ' ', lang: 'ru' });
    assert.deepEqual(d.last(), { t: 'error', code: 'bad_request', message: renderText('ru', 'err.nameRequired') });
    d.msg({ t: 'join', room: 42, name: 'D', lang: 'en' });
    assert.deepEqual(d.last(), { t: 'error', code: 'bad_request', message: renderText('en', 'err.invalidField', { field: 'room' }) });
  });

  test('setLang after joining: one state to that socket only, nobody else gets anything; the state is the same apart from its words', () => {
    const w = world();
    const { conns } = table(w, 4, ['en', 'en', 'ru', 'en']);
    conns[0].msg({ t: 'start' });
    for (const c of conns) c.take();
    conns[1].msg({ t: 'setLang', lang: 'ru' });
    assert.equal(conns[1].sent.length, 1);
    assert.equal(conns[1].sent[0].t, 'state');
    for (const c of [conns[0], conns[2], conns[3]]) assert.deepEqual(c.sent, [], `${c.name} got a message for someone else's language`);
    const ru = conns[1].sent[0];
    assert.equal(ru.you.lang, 'ru');
    conns[1].msg({ t: 'setLang', lang: 'en' });
    const en = conns[1].last();
    assert.equal(en.you.lang, 'en');
    // ids, numbers, statuses, orders and nullness are identical; the words differ
    const shape = (s) => JSON.stringify(s, (k, v) => (typeof v === 'string' && !['id', 'key', 'kind', 'phase', 'room', 'hostId', 'role', 'status', 'lang', 'effect', 'target', 'category', 'timing', 'speakerId', 'stage', 't'].includes(k) ? '*' : v));
    const { serverNow: a, you: ya, ...restRu } = ru; // eslint-disable-line no-unused-vars
    const { serverNow: b, you: yb, ...restEn } = en; // eslint-disable-line no-unused-vars
    assert.equal(shape({ ...restRu, log: restRu.log.map(({ id, kind, key, params }) => ({ id, kind, key, params })) }),
      shape({ ...restEn, log: restEn.log.map(({ id, kind, key, params }) => ({ id, kind, key, params })) }));
    assert.notEqual(ru.catastrophe.title === en.catastrophe.title && ru.categories[0].label === en.categories[0].label, true, 'nothing was translated');
    assert.match(ru.categories.map((c) => c.label).join(' '), CYRILLIC);
    valid(conns[1]);
  });

  test('errors in the socket\'s language; kicked.reason in the kicked member\'s; `replaced` in the old socket\'s', () => {
    const w = world();
    const { room, conns: [host, en, ru] } = table(w, 3, ['en', 'en', 'ru']);
    en.msg({ t: 'start' });
    ru.msg({ t: 'start' });
    assert.deepEqual(en.last(), { t: 'error', code: 'not_host', message: 'Only the host can do that' });
    assert.deepEqual(ru.last(), { t: 'error', code: 'not_host', message: renderText('ru', 'err.not_host') });
    assert.match(ru.last().message, CYRILLIC);
    // a failure with params (the engine's own key), and one of rooms.js
    host.msg({ t: 'start' });
    ru.msg({ t: 'reveal', category: 'health' });
    assert.equal(ru.last().code, 'not_your_turn');
    assert.equal(ru.last().message, renderText('ru', 'err.not_your_turn'));
    ru.msg('{');
    assert.deepEqual(ru.last(), { t: 'error', code: 'bad_request', message: renderText('ru', 'err.malformedJson') });
    ru.msg({ t: 'dev', op: 'god', on: true });
    assert.deepEqual(ru.last(), { t: 'error', code: 'not_allowed', message: renderText('ru', 'err.devOff') });
    // the replaced error: the old socket's language, whatever the new one says
    const tab = w.conn('tab');
    tab.msg({ t: 'resume', room, token: joinedOf(ru).token, lang: 'en' });
    assert.deepEqual(ru.last(), { t: 'error', code: 'replaced', message: renderText('ru', 'err.replacedTab') });
    assert.equal(tab.state().you.lang, 'en');
    // kicked: in the kicked member's language (the new socket switched it to en; set it back to ru first)
    tab.msg({ t: 'setLang', lang: 'ru' });
    host.msg({ t: 'kick', playerId: joinedOf(ru).id });
    assert.deepEqual(tab.last(), { t: 'kicked', reason: renderText('ru', 'kick.reason') });
    host.msg({ t: 'kick', playerId: joinedOf(en).id });
    assert.deepEqual(en.last(), { t: 'kicked', reason: 'The host removed you from the room' });
    valid(host); valid(en); valid(tab);
  });

  test('the language survives Play again, End game, takeSeat and a reconnect', () => {
    const w = world();
    const { room, conns: [host, a, b] } = table(w, 3, ['ru', 'en', 'ru']);
    const spec = w.conn('spec');
    spec.msg({ t: 'join', room, name: 'Sam', spectator: true, lang: 'ru' });
    const g = w.rooms.rooms.get(room).game;
    host.msg({ t: 'start' });
    host.msg({ t: 'endGame' });
    assert.equal(host.state().phase, 'lobby');
    assert.deepEqual([host, a, b, spec].map((c) => c.state().you.lang), ['ru', 'en', 'ru', 'ru']);
    spec.msg({ t: 'takeSeat' });
    assert.equal(spec.state().you.role, 'player');
    assert.equal(spec.state().you.lang, 'ru');
    host.msg({ t: 'start' });
    g._enterFinal();
    host.msg({ t: 'playAgain' });
    assert.deepEqual([host, a, b, spec].map((c) => c.state().you.lang), ['ru', 'en', 'ru', 'ru']);
    // a reconnect without lang keeps it; the members' languages are the engine's
    const again = w.conn('again');
    again.msg({ t: 'resume', room, token: joinedOf(b).token });
    assert.equal(again.state().you.lang, 'ru');
    assert.deepEqual(['p1', 'p2', 'p3', 'p4'].map((id) => g.langOf(id)), ['ru', 'en', 'ru', 'ru']);
    assert.equal(g.langOf('p99'), null);
    assert.equal(g.setLang('p99', 'ru'), false);
    assert.equal(g.setLang('p1', 'de'), false);
  });

  test('T1: every state an action causes comes before the answer to the next message, setLang between actions too', () => {
    const w = world();
    const { conns: [host, a] } = table(w, 3, ['en', 'ru', 'en']);
    host.take();
    host.msg({ t: 'start' });
    host.msg({ t: 'setLang', lang: 'ru' });
    host.msg({ t: 'next' });
    host.msg({ t: 'setLang', lang: 'en' });
    host.msg({ t: 'ping' });
    const seq = host.sent.map((m) => (m.t === 'state' ? `state:${m.you.lang}:${m.log.at(-1).id}` : m.t));
    // start -> state (en); setLang -> state (ru, same log); next -> state (ru, new line); setLang -> state (en); pong
    assert.equal(seq.length, 5, seq.join(' '));
    assert.match(seq[0], /^state:en:/);
    assert.equal(seq[1], seq[0].replace(':en:', ':ru:'));
    assert.match(seq[2], /^state:ru:/);
    assert.notEqual(seq[2], seq[1]);
    assert.equal(seq[3], seq[2].replace(':ru:', ':en:'));
    assert.equal(seq[4], 'pong');
    // the other player got the start and the next, nothing else
    assert.deepEqual(a.sent.slice(-2).map((m) => m.t), ['state', 'state']);
  });

  test('a pre-X5 client (never a lang, never setLang) gets you.lang en and English everywhere', () => {
    const w = world();
    const { conns } = table(w, 5, ['ru']); // the host is Russian; the others never say anything
    conns[0].msg({ t: 'start' });
    for (let i = 0; i < 40; i++) conns[0].msg({ t: 'next' });
    for (const c of conns.slice(1)) {
      const s = c.state();
      assert.equal(s.you.lang, 'en');
      // no Cyrillic anywhere but in names (none here are Cyrillic)
      assert.doesNotMatch(JSON.stringify(s), CYRILLIC, `${c.name} got Russian`);
      valid(c);
    }
    assert.match(JSON.stringify(conns[0].state().log), CYRILLIC);
  });

  test('the state frame: the log serialized once per language and spliced last parses to the same state', () => {
    const w = world({ splice: true });
    const { conns } = table(w, 4, ['en', 'ru', 'en', 'ru']);
    conns[0].msg({ t: 'start' });
    for (let i = 0; i < 12; i++) conns[0].msg({ t: 'next' });
    const g = [...w.rooms.rooms.values()][0].game;
    for (const [i, c] of conns.entries()) {
      const frame = c.frames.at(-1);
      assert.ok(frame.endsWith(']}'), 'the log comes last');
      const view = g.view(`p${i + 1}`);
      const { serverNow, ...sent } = JSON.parse(frame); // eslint-disable-line no-unused-vars
      const { serverNow: now, ...direct } = JSON.parse(JSON.stringify({ t: 'state', ...view })); // eslint-disable-line no-unused-vars
      assert.deepEqual(sent, direct);
      // the same keys in the same order, only `log` moved last
      assert.deepEqual(Object.keys(JSON.parse(stateFrame(view))), ['t', ...Object.keys(view).filter((k) => k !== 'log'), 'log']);
    }
    // every recipient of one language gets the very same log array from the engine
    assert.equal(g.view('p1').log, g.view('p3').log);
    assert.equal(g.view('p2').log, g.view('p4').log);
    assert.notEqual(g.view('p1').log, g.view('p2').log);
    assert.ok(Object.isFrozen(g.view('p1').log) && Object.isFrozen(g.view('p1').log[0]));
    valid(conns[1]);
  });

  test('the per-language log arrays follow the log past its 200-line limit (a new line always shows)', () => {
    const w = world();
    const { conns } = table(w, 4, ['en', 'ru', 'en', 'ru']);
    const g = [...w.rooms.rooms.values()][0].game;
    conns[0].msg({ t: 'start' });
    for (let i = 0; g.logSeq < 260 && i < 3000; i++) {
      if (g.phase === 'final') conns[0].msg({ t: 'playAgain' });
      else if (g.phase === 'lobby') conns[0].msg({ t: 'start' });
      else if (g.phase === 'vote') conns[0].msg({ t: 'closeVote' });
      else conns[0].msg({ t: 'next' });
      for (const [j, c] of conns.entries()) {
        const log = c.state().log;
        assert.equal(log.length, Math.min(g.log.length, 200));
        assert.equal(log.at(-1).id, g.logSeq, `${c.name} (${j % 2 ? 'ru' : 'en'}) is missing the newest line`);
        assert.equal(log[0].id, g.log[0].id);
      }
    }
    assert.ok(g.logSeq >= 260);
  });
});

describe('§11 X5.1 over a real socket', () => {
  test('30 setLang in one burst: the normal rate limit applies, the server stays consistent and the last handled one wins', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', minPlayers: 2, logger: () => {} });
    const url = `ws://127.0.0.1:${srv.port}/ws`;
    const open = () => new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.msgs = [];
      ws.on('message', (d) => ws.msgs.push(JSON.parse(d.toString())));
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
    const until = async (pred, ms = 3000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };
    try {
      const ws = await open();
      ws.send(JSON.stringify({ t: 'create', name: 'Anna', lang: 'en' }));
      await until(() => ws.msgs.some((m) => m.t === 'state'));
      const room = ws.msgs.find((m) => m.t === 'joined').room;
      const other = await open();
      other.send(JSON.stringify({ t: 'join', room, name: 'Bob', lang: 'ru' }));
      await until(() => other.msgs.some((m) => m.t === 'state'));
      await new Promise((r) => setTimeout(r, 1100)); // a fresh rate window
      ws.msgs.length = 0;
      other.msgs.length = 0;
      const langs = Array.from({ length: 30 }, (_, i) => (i % 2 ? 'en' : 'ru'));
      for (const l of langs) ws.send(JSON.stringify({ t: 'setLang', lang: l }));
      await new Promise((r) => setTimeout(r, 300));
      // at most 20 a second are handled (SPEC §7/§9), the rest are dropped silently; each handled one got one state
      const states = ws.msgs.filter((m) => m.t === 'state');
      assert.ok(states.length >= 1 && states.length <= 20, `${states.length} states`);
      assert.deepEqual(states.map((s) => s.you.lang), langs.slice(0, states.length));
      const g = [...srv.rooms.rooms.values()][0].game;
      assert.equal(g.langOf('p1'), langs[states.length - 1]);
      assert.deepEqual(other.msgs, [], 'the other socket got nothing');
      // still open and consistent: the next ping is answered, and the log is intact
      await new Promise((r) => setTimeout(r, 1100));
      ws.send(JSON.stringify({ t: 'ping' }));
      await until(() => ws.msgs.at(-1).t === 'pong');
      ws.send(JSON.stringify({ t: 'setLang', lang: 'ru' }));
      await until(() => ws.msgs.at(-1).t === 'state' && ws.msgs.at(-1).you.lang === 'ru');
      assert.deepEqual(validateServerMessage(ws.msgs.at(-1)), []);
      assert.ok(ws.msgs.at(-1).log.every((e) => e.key && Array.isArray(e.parts)));
      ws.close();
      other.close();
    } finally {
      await srv.close();
    }
  });
});
