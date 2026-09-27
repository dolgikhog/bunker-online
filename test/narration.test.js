// The narration clips (SPEC §11 X5.16): public/audio/narration.json and the MP3s it names, in every language.
//   - one entry per catastrophe, by its content id, sorted by title, with the English clip at the top level (as before
//     X5.16) and the Russian one in clips.ru; the English title is the card's;
//   - every clip is there, and no MP3 in audio/catastrophes/ or audio/catastrophes-ru/ is left without an entry;
//   - every clip is what narration.json says: MPEG-1 Layer III, mono, 44.1 kHz, constant 96 kbps (English) or 128 kbps
//     (Russian), 20-42 s long, and durationSec is its length (read from the MP3 frames and the encoder's delay and
//     padding, as ffprobe does);
//   - production caches /audio/* for 7 days: a Russian clip's name is always <id>-<first 8 hex of its sha1>.mp3, and an
//     English one is <id>.mp3 or the same hashed form (a rebuild renames changed audio), so no two audios share a name;
//   - every clip answers "Range: bytes=0-1" with 206 from the game's static server (Safari and every iOS browser need
//     it to play the narrator; production's Caddy does the same).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { REPO_ROOT, startServer } from '../server/index.js';
import { CATASTROPHE_IDS } from '../server/content/gen.js';
import { TABLES } from '../server/content/render.js';

const PUB = path.join(REPO_ROOT, 'public');
const AUDIO = path.join(PUB, 'audio');
const RAW = fs.readFileSync(path.join(AUDIO, 'narration.json'), 'utf8');
const LIST = JSON.parse(RAW);
const BY_ID = new Map(LIST.map((e) => [e.id, e]));
// the languages, their directory and bitrate (the Russian voices need 128 kbps to stay under -1.2 dBTP)
const LANGS = {
  en: { dir: 'catastrophes', kbps: 96, clip: (e) => e },
  ru: { dir: 'catastrophes-ru', kbps: 128, clip: (e) => e.clips && e.clips.ru },
};
const MIN_SEC = 20;
const MAX_SEC = 42;

/**
 * An MP3's frames: MPEG-1 Layer III only (what fx.sh encodes). Skips the ID3v2 tag and the Xing/Info frame; `sec` is
 * the playing length: frames x 1152 samples less the encoder delay and padding of the LAME tag.
 */
function mp3Info(buf) {
  let i = 0;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') {
    i = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)) + (buf[5] & 0x10 ? 10 : 0);
  }
  const KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const RATES = [44100, 48000, 32000];
  const kbps = new Set();
  const rates = new Set();
  const modes = new Set();
  let frames = 0;
  let first = true;
  let trim = 0;
  while (i + 4 <= buf.length) {
    const h = buf.readUInt32BE(i);
    const ver = (h >>> 19) & 3;
    const layer = (h >>> 17) & 3;
    const bi = (h >>> 12) & 15;
    const si = (h >>> 10) & 3;
    if (h >>> 21 !== 0x7ff || ver !== 3 || layer !== 1 || bi === 0 || bi === 15 || si === 3) break;
    const mode = (h >>> 6) & 3;
    const len = Math.floor((144000 * KBPS[bi]) / RATES[si]) + ((h >>> 9) & 1);
    if (first) {
      first = false;
      const tag = i + 4 + (mode === 3 ? 17 : 32);
      if (/^(Xing|Info)$/.test(buf.subarray(tag, tag + 4).toString('latin1'))) {
        const lame = tag + 0x78;   // the LAME tag: encoder delay and padding, 12 bits each, at +21
        if (/^(LAME|Lavc|Lavf)/.test(buf.subarray(lame, lame + 4).toString('latin1'))) {
          const d = buf.readUIntBE(lame + 21, 3);
          trim = (d >> 12) + (d & 0xfff);
        }
        i += len;
        continue;
      }
    }
    frames++;
    kbps.add(KBPS[bi]);
    rates.add(RATES[si]);
    modes.add(mode);
    i += len;
  }
  const rate = [...rates][0] || 44100;
  return { frames, rest: buf.length - i, kbps: [...kbps], rates: [...rates], mono: modes.size === 1 && modes.has(3), sec: (frames * 1152 - trim) / rate };
}
const sha8 = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
const fileOf = (src) => path.join(PUB, ...src.split('/'));

describe('narration.json (SPEC §11 X5.16)', () => {
  test('one entry per catastrophe, by its content id, sorted by title, laid out as the builds write it', () => {
    assert.deepEqual(LIST.map((e) => e.id).sort(), [...CATASTROPHE_IDS].sort(), 'every catastrophe has exactly one entry (its content id)');
    assert.equal(BY_ID.size, LIST.length, 'no id twice');
    assert.deepEqual(LIST.map((e) => e.title), LIST.map((e) => e.title).sort(), 'sorted by title (make_voice.py and make_voice_ru.py)');
    assert.equal(RAW, JSON.stringify(LIST, null, 1), 'indent 1, no final newline (the layout both builds write)');
    for (const e of LIST) {
      assert.equal(e.title, TABLES.en.catastrophes.list[e.id].title, `${e.id}: the English title is the card's`);
      assert.deepEqual(Object.keys(e.clips || {}), ['ru'], `${e.id}: clips holds the Russian clip (and nothing else yet)`);
    }
  });

  for (const [lang, L] of Object.entries(LANGS)) {
    test(`${lang}: every catastrophe has its clip, the file exists under its cache-safe name, and no file is left over`, () => {
      const named = new Set();
      for (const id of CATASTROPHE_IDS) {
        const c = L.clip(BY_ID.get(id));
        assert.ok(c && typeof c.src === 'string', `${id}: no ${lang} clip in narration.json`);
        assert.ok(typeof c.voice === 'string' && c.voice, `${id} ${lang}: no voice`);
        const m = new RegExp(`^audio/${L.dir}/${id}(-([0-9a-f]{8}))?\\.mp3$`).exec(c.src);
        assert.ok(m, `${id} ${lang}: src ${c.src} is not audio/${L.dir}/${id}[-<hash8>].mp3`);
        assert.ok(fs.existsSync(fileOf(c.src)), `${c.src} is missing`);
        const hash = sha8(fs.readFileSync(fileOf(c.src)));
        if (lang === 'ru') assert.equal(m[2], hash, `${c.src}: a Russian clip is always named by its content hash (the file is ${hash})`);
        else if (m[2]) assert.equal(m[2], hash, `${c.src}: a hashed name must be the file's own hash (${hash}): an MP3 overwritten in place?`);
        named.add(path.basename(c.src));
      }
      const files = fs.readdirSync(path.join(AUDIO, L.dir)).filter((f) => f.endsWith('.mp3')).sort();
      assert.deepEqual(files, [...named].sort(), `audio/${L.dir}/ holds exactly the clips narration.json names`);
    });

    test(`${lang}: every clip is a mono 44.1 kHz ${L.kbps} kbps MP3, ${MIN_SEC}-${MAX_SEC} s long, as long as durationSec says`, () => {
      for (const id of CATASTROPHE_IDS) {
        const c = L.clip(BY_ID.get(id));
        const mp3 = mp3Info(fs.readFileSync(fileOf(c.src)));
        assert.ok(mp3.frames > 0 && mp3.rest === 0, `${c.src}: not an MPEG-1 Layer III stream to its last byte (${mp3.frames} frames, ${mp3.rest} bytes left)`);
        assert.deepEqual([mp3.kbps, mp3.rates, mp3.mono], [[L.kbps], [44100], true], `${c.src}: ${JSON.stringify(mp3)}`);
        assert.ok(typeof c.durationSec === 'number' && c.durationSec >= MIN_SEC && c.durationSec <= MAX_SEC, `${c.src}: durationSec ${c.durationSec}`);
        assert.ok(Math.abs(mp3.sec - c.durationSec) <= 0.02, `${c.src}: the MP3 plays ${mp3.sec.toFixed(3)} s, narration.json says ${c.durationSec}`);
      }
    });
  }

  test('every clip, in every language, answers "Range: bytes=0-1" with 206 (audio/mpeg, Accept-Ranges: bytes)', async () => {
    const srv = await startServer({ port: 0, host: '127.0.0.1', noLimits: true, logger: () => {}, publicDir: PUB, dev: false, production: false, trustProxy: false });
    try {
      for (const e of LIST) {
        for (const L of Object.values(LANGS)) {
          const src = L.clip(e).src;
          const size = fs.statSync(fileOf(src)).size;
          const r = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/' + src, headers: { Range: 'bytes=0-1' }, agent: false }, (res) => {
              const chunks = [];
              res.on('data', (x) => chunks.push(x));
              res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks).length }));
            });
            req.on('error', reject);
            req.end();
          });
          assert.equal(r.status, 206, src);
          assert.equal(r.headers['content-range'], `bytes 0-1/${size}`, src);
          assert.equal(r.headers['content-type'], 'audio/mpeg', src);
          assert.equal(r.headers['accept-ranges'], 'bytes', src);
          assert.equal(r.bytes, 2, src);
        }
      }
    } finally {
      await srv.close();
    }
  });
});
