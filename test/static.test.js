// The static file server of server/index.js: byte ranges (RFC 9110 §14) and the rules every file answer keeps.
//   - parseRange: one range ("a-b", "a-", "-n") is 206; no Range, another unit, or several ranges is the whole file (200:
//     multipart/byteranges is not implemented, and ignoring Range is always allowed); a malformed bytes range, one at
//     or past the end, "-0", or an empty file is 416;
//   - over HTTP: 206 with Content-Range and the part's Content-Length, 416 with "bytes */size", Accept-Ranges: bytes on
//     every file, HEAD ignores Range (RFC 9110 §14.2: GET only), If-Range other than the Last-Modified is the whole
//     file, and a range keeps every header (CSP on HTML, nosniff, X-Frame-Options) and every refusal (traversal,
//     dotfiles, symlinks out of the public dir);
//   - a real narration clip of public/audio answers "Range: bytes=0-1" with 206, as the production proxy does (Safari
//     and every iOS browser need it to play the narrator).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CSP, REPO_ROOT, parseRange, startServer } from '../server/index.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bunker-static-test-'));
const PUB = path.join(TMP, 'public');
const CLIP = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 7 + 3) % 256));
const PAGE = '<!doctype html><title>page</title><p>' + 'x'.repeat(200) + '</p>';
before(() => {
  fs.mkdirSync(path.join(PUB, 'audio'), { recursive: true });
  fs.mkdirSync(path.join(PUB, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(PUB, 'audio', 'clip.mp3'), CLIP);
  fs.writeFileSync(path.join(PUB, 'index.html'), '<!doctype html><title>client</title>');
  fs.writeFileSync(path.join(PUB, 'page.html'), PAGE);
  fs.writeFileSync(path.join(PUB, 'empty.bin'), Buffer.alloc(0));
  fs.writeFileSync(path.join(PUB, '.env'), 'SECRET=dot');
  fs.writeFileSync(path.join(PUB, '.hidden', 'x.txt'), 'SECRET=hidden');
  fs.writeFileSync(path.join(TMP, 'secret.txt'), 'SECRET=outside');
  fs.symlinkSync(path.join(TMP, 'secret.txt'), path.join(PUB, 'out-link.txt'));
  fs.symlinkSync(path.join(PUB, 'audio', 'clip.mp3'), path.join(PUB, 'in-link.mp3'));
});
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

function get(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function withServer(opts, fn) {
  const srv = await startServer({ port: 0, host: '127.0.0.1', noLimits: true, logger: () => {}, publicDir: PUB, dev: false, production: false, trustProxy: false, ...opts });
  try { await fn(srv.port); } finally { await srv.close(); }
}
const range = (port, p, r, extra = {}) => get(port, p, { ...extra, headers: { Range: r, ...(extra.headers || {}) } });

describe('parseRange (RFC 9110 §14)', () => {
  const cases = [
    // [header, size, expected]
    [undefined, 1000, { status: 200 }],
    ['bytes=0-99', 1000, { status: 206, start: 0, end: 99 }],
    ['bytes=0-0', 1000, { status: 206, start: 0, end: 0 }],
    ['bytes=900-', 1000, { status: 206, start: 900, end: 999 }],
    ['bytes=990-5000', 1000, { status: 206, start: 990, end: 999 }],
    ['bytes=999-999', 1000, { status: 206, start: 999, end: 999 }],
    ['bytes=-100', 1000, { status: 206, start: 900, end: 999 }],
    ['bytes=-5000', 1000, { status: 206, start: 0, end: 999 }],
    ['bytes=0-', 1, { status: 206, start: 0, end: 0 }],
    ['bytes=0-99999999999999999999999', 1000, { status: 206, start: 0, end: 999 }],
    ['Bytes=0-1', 1000, { status: 206, start: 0, end: 1 }],
    ['bytes= 0-1 , ', 1000, { status: 206, start: 0, end: 1 }],   // spaces and empty list elements are allowed
    // the whole file: another unit (ignored), several ranges (multipart is not implemented)
    ['items=0-1', 1000, { status: 200 }],
    ['0-1', 1000, { status: 200 }],
    ['bytes=0-1,5-6', 1000, { status: 200 }],
    ['bytes=0-1,2000-', 1000, { status: 200 }],
    // 416: malformed, past the end, "-0", an empty file, several ranges of which none fits
    ['bytes=5-2', 1000, { status: 416 }],
    ['bytes=abc', 1000, { status: 416 }],
    ['bytes=x-1', 1000, { status: 416 }],
    ['bytes=1-2-3', 1000, { status: 416 }],
    ['bytes=-', 1000, { status: 416 }],
    ['bytes=', 1000, { status: 416 }],
    ['bytes=,', 1000, { status: 416 }],
    ['bytes=0-1,x', 1000, { status: 416 }],
    ['bytes=1000-', 1000, { status: 416 }],
    ['bytes=1000-2000', 1000, { status: 416 }],
    ['bytes=99999999999999999999999-', 1000, { status: 416 }],
    ['bytes=-0', 1000, { status: 416 }],
    ['bytes=0-', 0, { status: 416 }],
    ['bytes=-5', 0, { status: 416 }],
    ['bytes=2000-,3000-', 1000, { status: 416 }],
  ];
  for (const [h, size, want] of cases) {
    test(`${JSON.stringify(h)} of ${size} bytes -> ${want.status}${want.status === 206 ? ` ${want.start}-${want.end}` : ''}`, () => {
      assert.deepEqual(parseRange(h, size), want);
    });
  }
});

describe('static files over HTTP: byte ranges', () => {
  test('no Range: 200, the whole file, Accept-Ranges: bytes; HEAD the same headers and no body', async () => {
    await withServer({}, async (port) => {
      const r = await get(port, '/audio/clip.mp3');
      assert.equal(r.status, 200);
      assert.equal(r.headers['accept-ranges'], 'bytes');
      assert.equal(r.headers['content-type'], 'audio/mpeg');
      assert.equal(r.headers['content-length'], '1000');
      assert.equal(r.headers['content-range'], undefined);
      assert.ok(r.body.equals(CLIP));
      const h = await get(port, '/audio/clip.mp3', { method: 'HEAD' });
      assert.equal(h.status, 200);
      assert.equal(h.headers['content-length'], '1000');
      assert.equal(h.headers['accept-ranges'], 'bytes');
      assert.equal(h.body.length, 0);
    });
  });

  test('bytes=0-99, open-ended, suffix and clamped ranges: 206 with Content-Range, the part\'s Content-Length and bytes', async () => {
    await withServer({}, async (port) => {
      for (const [hdr, start, end] of [['bytes=0-99', 0, 99], ['bytes=0-0', 0, 0], ['bytes=900-', 900, 999], ['bytes=0-', 0, 999], ['bytes=-100', 900, 999],
        ['bytes=-1', 999, 999], ['bytes=-5000', 0, 999], ['bytes=990-5000', 990, 999], ['bytes=123-456', 123, 456]]) {
        const r = await range(port, '/audio/clip.mp3', hdr);
        assert.equal(r.status, 206, hdr);
        assert.equal(r.headers['content-range'], `bytes ${start}-${end}/1000`, hdr);
        assert.equal(r.headers['content-length'], String(end - start + 1), hdr);
        assert.equal(r.headers['accept-ranges'], 'bytes', hdr);
        assert.equal(r.headers['content-type'], 'audio/mpeg', hdr);
        assert.ok(r.body.equals(CLIP.subarray(start, end + 1)), `${hdr}: the bytes differ`);
      }
    });
  });

  test('a range keeps every header of the file answer', async () => {
    await withServer({}, async (port) => {
      const full = await get(port, '/audio/clip.mp3');
      const part = await range(port, '/audio/clip.mp3', 'bytes=0-1');
      for (const k of ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'last-modified', 'accept-ranges']) {
        assert.equal(part.headers[k], full.headers[k], k);
      }
      assert.equal(part.headers['content-security-policy'], CSP);
      assert.equal(part.headers['x-frame-options'], 'DENY');
      // an HTML page too: its CSP stays on a partial answer
      const html = await range(port, '/page.html', 'bytes=0-14');
      assert.equal(html.status, 206);
      assert.equal(html.body.toString('utf8'), PAGE.slice(0, 15));
      assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(html.headers['content-security-policy'], CSP);
      assert.equal(html.headers['x-content-type-options'], 'nosniff');
      // dev mode frames same-origin, with or without a range
      await withServer({ dev: true }, async (devPort) => {
        assert.equal((await range(devPort, '/audio/clip.mp3', 'bytes=0-1')).headers['x-frame-options'], 'SAMEORIGIN');
      });
    });
  });

  test('invalid or unsatisfiable: 416 with Content-Range "bytes */size" and no file bytes', async () => {
    await withServer({}, async (port) => {
      for (const hdr of ['bytes=5-2', 'bytes=abc', 'bytes=-', 'bytes=', 'bytes=1-2-3', 'bytes=1000-', 'bytes=1000-2000', 'bytes=-0', 'bytes=2000-,3000-', 'bytes=0-1,x']) {
        const r = await range(port, '/audio/clip.mp3', hdr);
        assert.equal(r.status, 416, hdr);
        assert.equal(r.headers['content-range'], 'bytes */1000', hdr);
        assert.equal(r.headers['accept-ranges'], 'bytes', hdr);
        assert.ok(!r.body.includes(CLIP.subarray(0, 8)), `${hdr}: the 416 carries the file`);
      }
      const empty = await range(port, '/empty.bin', 'bytes=0-');
      assert.equal(empty.status, 416);
      assert.equal(empty.headers['content-range'], 'bytes */0');
      const whole = await get(port, '/empty.bin');
      assert.equal(whole.status, 200);
      assert.equal(whole.headers['content-length'], '0');
    });
  });

  test('several ranges or another unit: 200 and the whole file (documented: multipart/byteranges is not implemented)', async () => {
    await withServer({}, async (port) => {
      for (const hdr of ['bytes=0-1,5-6', 'bytes=0-99,900-', 'bytes=0-1,2000-', 'items=0-1', '0-1']) {
        const r = await range(port, '/audio/clip.mp3', hdr);
        assert.equal(r.status, 200, hdr);
        assert.equal(r.headers['content-length'], '1000', hdr);
        assert.equal(r.headers['content-range'], undefined, hdr);
        assert.ok(r.body.equals(CLIP), hdr);
      }
    });
  });

  test('HEAD ignores Range (GET only, RFC 9110 §14.2); If-Range other than the Last-Modified is the whole file', async () => {
    await withServer({}, async (port) => {
      const h = await range(port, '/audio/clip.mp3', 'bytes=0-99', { method: 'HEAD' });
      assert.equal(h.status, 200);
      assert.equal(h.headers['content-length'], '1000');
      assert.equal(h.headers['accept-ranges'], 'bytes');
      assert.equal(h.body.length, 0);
      assert.equal((await range(port, '/audio/clip.mp3', 'bytes=5000-', { method: 'HEAD' })).status, 200);
      const lm = (await get(port, '/audio/clip.mp3')).headers['last-modified'];
      const same = await range(port, '/audio/clip.mp3', 'bytes=0-9', { headers: { 'If-Range': lm } });
      assert.equal(same.status, 206);
      assert.ok(same.body.equals(CLIP.subarray(0, 10)));
      for (const ir of ['"some-etag"', 'Thu, 01 Jan 1970 00:00:00 GMT']) {
        const other = await range(port, '/audio/clip.mp3', 'bytes=0-9', { headers: { 'If-Range': ir } });
        assert.equal(other.status, 200, ir);
        assert.ok(other.body.equals(CLIP), ir);
      }
      // POST is still refused, Range or not
      assert.equal((await range(port, '/audio/clip.mp3', 'bytes=0-1', { method: 'POST' })).status, 405);
    });
  });

  test('a Range header never gets past the path rules: traversal, dotfiles, symlinks out of the public dir', async () => {
    await withServer({}, async (port) => {
      for (const [p, status] of [['/..%2fsecret.txt', 403], ['/%2e%2e%2fsecret.txt', 403], ['/audio/..%2f..%2fsecret.txt', 403], ['/.env', 404], ['/.hidden/x.txt', 404],
        ['/out-link.txt', 403], ['/nope.mp3', 404], ['/a%00b', 400], ['/%5c..%5csecret.txt', 400]]) {
        for (const hdr of [undefined, 'bytes=0-3', 'bytes=-4', 'bytes=0-']) {
          const r = hdr ? await range(port, p, hdr) : await get(port, p);
          assert.equal(r.status, status, `${p} ${hdr || ''}`);
          assert.ok(!r.body.toString('utf8').includes('SECRET'), `${p} ${hdr || ''}: leaked`);
          assert.equal(r.headers['content-range'], undefined, `${p} ${hdr || ''}`);
        }
      }
      // a symlink that stays inside the public dir is still a file, ranges included
      const inLink = await range(port, '/in-link.mp3', 'bytes=10-19');
      assert.equal(inLink.status, 206);
      assert.ok(inLink.body.equals(CLIP.subarray(10, 20)));
      // /healthz is not a file: no ranges
      const hz = await range(port, '/healthz', 'bytes=0-0');
      assert.equal(hz.status, 200);
      assert.equal(hz.body.toString('utf8'), 'ok');
    });
  });

  test('a real narration clip (public/audio): "Range: bytes=0-1" -> 206 "bytes 0-1/<size>", as behind the production proxy', async () => {
    const pub = path.join(REPO_ROOT, 'public');
    const list = JSON.parse(fs.readFileSync(path.join(pub, 'audio', 'narration.json'), 'utf8'));
    assert.ok(Array.isArray(list) && list.length > 0, 'public/audio/narration.json lists no clip');
    const src = list[0].src;
    const file = fs.readFileSync(path.join(pub, src));
    await withServer({ publicDir: pub }, async (port) => {
      const r = await range(port, '/' + src, 'bytes=0-1');
      assert.equal(r.status, 206);
      assert.equal(r.headers['content-range'], `bytes 0-1/${file.length}`);
      assert.equal(r.headers['content-type'], 'audio/mpeg');
      assert.ok(r.body.equals(file.subarray(0, 2)));
      const tail = await range(port, '/' + src, `bytes=${file.length - 100}-`);
      assert.equal(tail.status, 206);
      assert.ok(tail.body.equals(file.subarray(file.length - 100)));
    });
  });
});
