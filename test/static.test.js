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
import { CSP, REPO_ROOT, configFromEnv, fileEtag, notModified, parseRange, startServer } from '../server/index.js';

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

// Conditional requests (RFC 9110 §13): every file but the app page has a weak ETag (size + mtime) and Last-Modified, and
// a browser revalidating its copy (Cache-Control: no-cache) gets a 304 without the bytes. The app page is no-store.
describe('static files over HTTP: ETag, Last-Modified and 304', () => {
  test('fileEtag and notModified: If-None-Match decides alone (weak comparison, lists, "*"); else If-Modified-Since', () => {
    const st = { size: 1000, mtimeMs: 1_700_000_000_123.4 };
    const tag = fileEtag(st);
    assert.match(tag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    assert.notEqual(fileEtag({ ...st, size: 1001 }), tag);
    assert.notEqual(fileEtag({ ...st, mtimeMs: st.mtimeMs + 1000 }), tag);
    const lm = new Date(st.mtimeMs).toUTCString();
    const bare = tag.slice(2);
    for (const inm of [tag, bare, `"x", ${tag}`, `${bare} , "y"`, '*']) assert.equal(notModified({ 'if-none-match': inm }, tag, st.mtimeMs), true, inm);
    for (const inm of ['"x"', '', 'W/"1-2"']) assert.equal(notModified({ 'if-none-match': inm }, tag, st.mtimeMs), false, inm);
    // If-None-Match present: If-Modified-Since is not looked at
    assert.equal(notModified({ 'if-none-match': '"x"', 'if-modified-since': lm }, tag, st.mtimeMs), false);
    assert.equal(notModified({ 'if-modified-since': lm }, tag, st.mtimeMs), true);
    assert.equal(notModified({ 'if-modified-since': new Date(st.mtimeMs + 5000).toUTCString() }, tag, st.mtimeMs), true);
    assert.equal(notModified({ 'if-modified-since': new Date(st.mtimeMs - 2000).toUTCString() }, tag, st.mtimeMs), false);
    for (const ims of ['yesterday', '', 'Thu, 99 Foo 2026']) assert.equal(notModified({ 'if-modified-since': ims }, tag, st.mtimeMs), false, ims);
    assert.equal(notModified({}, tag, st.mtimeMs), false);
  });

  test('a file: ETag on 200, 206 and HEAD; a matching If-None-Match or If-Modified-Since -> 304, no body, same headers', async () => {
    await withServer({}, async (port) => {
      const r = await get(port, '/page.html');
      assert.equal(r.status, 200);
      const tag = r.headers.etag;
      assert.match(tag, /^W\/"/);
      assert.equal(r.headers['cache-control'], 'no-cache');
      assert.equal((await get(port, '/page.html', { method: 'HEAD' })).headers.etag, tag);
      assert.equal((await range(port, '/audio/clip.mp3', 'bytes=0-1')).headers.etag, (await get(port, '/audio/clip.mp3')).headers.etag);
      for (const [headers, method] of [[{ 'If-None-Match': tag }, 'GET'], [{ 'If-None-Match': `"zz", ${tag}` }, 'GET'], [{ 'If-None-Match': '*' }, 'GET'],
        [{ 'If-Modified-Since': r.headers['last-modified'] }, 'GET'], [{ 'If-None-Match': tag }, 'HEAD'], [{ 'If-None-Match': tag, Range: 'bytes=0-9' }, 'GET']]) {
        const c = await get(port, '/page.html', { method, headers });
        const what = `${method} ${JSON.stringify(headers)}`;
        assert.equal(c.status, 304, what);
        assert.equal(c.body.length, 0, what);
        assert.equal(c.headers.etag, tag, what);
        assert.equal(c.headers['last-modified'], r.headers['last-modified'], what);
        assert.equal(c.headers['cache-control'], 'no-cache', what);
        assert.equal(c.headers['content-security-policy'], CSP, what);
        assert.equal(c.headers['x-content-type-options'], 'nosniff', what);
        assert.equal(c.headers['content-range'], undefined, what);
      }
      // a tag that does not match: the file, even with a matching If-Modified-Since (If-None-Match decides alone)
      for (const headers of [{ 'If-None-Match': '"other"' }, { 'If-None-Match': '"other"', 'If-Modified-Since': r.headers['last-modified'] },
        { 'If-Modified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' }, { 'If-Modified-Since': 'not a date' }]) {
        const c = await get(port, '/page.html', { headers });
        assert.equal(c.status, 200, JSON.stringify(headers));
        assert.equal(c.body.toString('utf8'), PAGE, JSON.stringify(headers));
      }
      // If-Range with the (weak) ETag never satisfies a range: the whole file (RFC 9110 §13.1.5 needs a strong tag)
      const ir = await range(port, '/audio/clip.mp3', 'bytes=0-9', { headers: { 'If-Range': (await get(port, '/audio/clip.mp3')).headers.etag } });
      assert.equal(ir.status, 200);
      assert.ok(ir.body.equals(CLIP));
    });
  });

  test('a changed file gets a new ETag, so the old one no longer answers 304', async () => {
    const f = path.join(PUB, 'changing.txt');
    fs.writeFileSync(f, 'one');
    fs.utimesSync(f, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    await withServer({}, async (port) => {
      const a = await get(port, '/changing.txt');
      fs.writeFileSync(f, 'two');   // same size, new mtime
      const b = await get(port, '/changing.txt', { headers: { 'If-None-Match': a.headers.etag, 'If-Modified-Since': a.headers['last-modified'] } });
      assert.equal(b.status, 200);
      assert.equal(b.body.toString('utf8'), 'two');
      assert.notEqual(b.headers.etag, a.headers.etag);
    });
  });

  test('the app page stays no-store, with no ETag, and never answers 304', async () => {
    await withServer({}, async (port) => {
      const r = await get(port, '/');
      assert.equal(r.status, 200);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.equal(r.headers.etag, undefined);
      for (const headers of [{ 'If-None-Match': '*' }, { 'If-Modified-Since': new Date(Date.now() + 86_400_000).toUTCString() }]) {
        const c = await get(port, '/index.html', { headers });
        assert.equal(c.status, 200, JSON.stringify(headers));
        assert.equal(c.body.toString('utf8'), '<!doctype html><title>client</title>');
      }
    });
  });
});

// The site's own files (public/): the MIME type every crawler and browser needs, and the caching rule of each.
describe('the site files of public/ (reports/seo.md): types and caching', () => {
  const pub = path.join(REPO_ROOT, 'public');
  const FILES = [
    ['/privacy.html', 'text/html; charset=utf-8'],
    ['/privacy.css', 'text/css; charset=utf-8'],
    ['/robots.txt', 'text/plain; charset=utf-8'],
    ['/sitemap.xml', 'application/xml; charset=utf-8'],
    ['/site.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['/og-image.png', 'image/png'],
    ['/favicon.ico', 'image/x-icon'],
    ['/favicon.svg', 'image/svg+xml'],
    ['/apple-touch-icon.png', 'image/png'],
    ['/icon-192.png', 'image/png'],
    ['/icon-512.png', 'image/png'],
    ['/icon-maskable-512.png', 'image/png'],
  ];
  test('each is served with its type, nosniff, no-cache and a validator; a revalidation is a 304', async () => {
    await withServer({ publicDir: pub }, async (port) => {
      for (const [p, type] of FILES) {
        const r = await get(port, p);
        assert.equal(r.status, 200, p);
        assert.equal(r.headers['content-type'], type, p);
        assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
        assert.equal(r.headers['cache-control'], 'no-cache', p);
        assert.ok(r.headers.etag && r.headers['last-modified'], p);
        assert.ok(r.body.equals(fs.readFileSync(path.join(pub, p))), p);
        assert.equal((await get(port, p, { headers: { 'If-None-Match': r.headers.etag } })).status, 304, p);
      }
    });
  });

  test('robots.txt and sitemap.xml name https://sealthebunker.com, and every sitemap URL is a page that is served', async () => {
    const robots = fs.readFileSync(path.join(pub, 'robots.txt'), 'utf8');
    assert.match(robots, /^Sitemap: https:\/\/sealthebunker\.com\/sitemap\.xml$/m);
    assert.match(robots, /^Disallow: \/admin$/m);
    assert.match(robots, /^Disallow: \/dev$/m);
    const sitemap = fs.readFileSync(path.join(pub, 'sitemap.xml'), 'utf8');
    assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs, ['https://sealthebunker.com/', 'https://sealthebunker.com/privacy.html']);
    await withServer({ publicDir: pub }, async (port) => {
      for (const loc of locs) {
        const r = await get(port, new URL(loc).pathname);
        assert.equal(r.status, 200, loc);
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', loc);
        // every page in the sitemap names itself as its canonical
        assert.ok(r.body.toString('utf8').includes(`<link rel="canonical" href="${loc}">`), loc);
      }
    });
  });
});

// Invite links (server/meta.js wired into the static server): /?room=CODE is the app page with the room in <title>,
// og:title and og:url, so a chat app's preview names it; anything else is the file byte for byte.
describe('invite link previews (server/meta.js) over HTTP', () => {
  const pub = path.join(REPO_ROOT, 'public');
  const INDEX = fs.readFileSync(path.join(pub, 'index.html'));
  const tagOf = (html, prop) => new RegExp(`<meta property="${prop}" content="([^"]*)">`).exec(html)?.[1];

  test('GET /?room=abcd: the invite title, og:title and og:url; canonical, description and image unchanged; page headers', async () => {
    await withServer({ publicDir: pub }, async (port) => {
      for (const p of ['/?room=abcd', '/index.html?room=ABCD', '/?room=ABCD&lang=ru', '/?room=abcd&room=WXYZ']) {
        const r = await get(port, p);
        const html = r.body.toString('utf8');
        assert.equal(r.status, 200, p);
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', p);
        assert.equal(r.headers['content-length'], String(r.body.length), p);
        assert.equal(r.headers['cache-control'], 'no-store', p);
        assert.equal(r.headers['content-security-policy'], CSP, p);
        assert.equal(r.headers['x-frame-options'], 'DENY', p);
        assert.equal(r.headers['referrer-policy'], 'no-referrer', p);
        assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
        assert.equal(r.headers.etag, undefined, p);
        assert.match(html, /<title>Join room ABCD — Seal the Bunker<\/title>/, p);
        assert.equal(tagOf(html, 'og:title'), 'Join room ABCD — Seal the Bunker', p);
        assert.equal(tagOf(html, 'og:url'), 'https://sealthebunker.com/?room=ABCD', p);
        assert.ok(html.includes('<link rel="canonical" href="https://sealthebunker.com/">'), p);
        assert.equal(tagOf(html, 'og:image'), 'https://sealthebunker.com/og-image.png', p);
        assert.equal(tagOf(html, 'og:description'), tagOf(INDEX.toString('utf8'), 'og:description'), p);
        assert.ok(html.includes('<script type="module" src="app.js"></script>'), p);
      }
    });
  });

  test('HEAD has the same length and no body; Range is ignored (the whole page)', async () => {
    await withServer({ publicDir: pub }, async (port) => {
      const g = await get(port, '/?room=HJKL');
      const h = await get(port, '/?room=HJKL', { method: 'HEAD' });
      assert.equal(h.status, 200);
      assert.equal(h.headers['content-length'], String(g.body.length));
      assert.equal(h.body.length, 0);
      const r = await range(port, '/?room=HJKL', 'bytes=0-9');
      assert.equal(r.status, 200);
      assert.ok(r.body.equals(g.body));
    });
  });

  test('no room, or not a room code: index.html byte for byte', async () => {
    await withServer({ publicDir: pub }, async (port) => {
      for (const p of ['/', '/index.html', '/?room=', '/?room=ABC', '/?room=ABCDE', '/?room=IOOO', '/?room=%22%3E%3Cscript%3E', '/?room=%D0%90BCD',
        '/?lang=ru', '/?Room=ABCD', '/?profile=p2']) {
        const r = await get(port, p);
        assert.equal(r.status, 200, p);
        assert.ok(r.body.equals(INDEX), p);
        assert.equal(r.headers['cache-control'], 'no-store', p);
      }
    });
  });
});

describe('BUNKER_STATE_DIR (server/analytics.js)', () => {
  test('unset or blank: the counts stay in memory (no file, so no local run or test writes into the repo)', () => {
    assert.equal(configFromEnv({}).stateDir, null);
    assert.equal(configFromEnv({ BUNKER_STATE_DIR: '  ' }).stateDir, null);
    assert.equal(configFromEnv({ BUNKER_STATE_DIR: '/var/lib/bunker' }).stateDir, '/var/lib/bunker');
    assert.equal(configFromEnv({ BUNKER_STATE_DIR: 'data' }).stateDir, path.join(REPO_ROOT, 'data'));
  });
});

// public/index.html preloads app.js's whole static import graph (the landing is drawn by app.js, so its first paint
// waits for every module; without the hints the browser finds them a level at a time). The list must follow the imports.
describe('public/index.html: modulepreload follows app.js\'s imports', () => {
  test('every module app.js imports statically (transitively) is preloaded, and every preload is such a module or narrator.js', () => {
    const pub = path.join(REPO_ROOT, 'public');
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
    const seen = new Set();
    const walk = (rel) => {
      const src = fs.readFileSync(path.join(pub, rel), 'utf8');
      for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
        if (!seen.has(dep)) { seen.add(dep); walk(dep); }
      }
    };
    walk('app.js');
    assert.ok(seen.has('i18n/en.js') && seen.has('i18n/ru.js') && seen.has('profile.js'), [...seen].join(' '));
    assert.deepEqual([...preloads].sort(), [...seen, 'narrator.js'].sort());
    for (const p of preloads) assert.ok(fs.existsSync(path.join(pub, p)), p);
  });
});
