// Search and link previews (reports/seo.md).
//   - server/meta.js: an invite link (/?room=ABCD) gets its own <title>, og:title and og:url; the room code is the only
//     request data that reaches the page, and only as 4 letters of the SPEC §7 alphabet; anything else leaves the page
//     unchanged, byte for byte; injection attempts, look-alike letters, other query parameters and foreign hosts never
//     show up in it;
//   - public/index.html: the Open Graph / X card tags, the description, canonical and JSON-LD; no script the CSP would
//     block; the crawlable fallback text in #app (hidden wherever scripts run, in step with the landing's strings);
//   - the files beside it: og-image.png (1200×630, small enough for WhatsApp), the icons, the web manifest, robots.txt
//     and sitemap.xml.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_NAME, SITE_ORIGIN, escapeHtml, roomFromUrl, roomPreview, withRoomPreview } from '../server/meta.js';
import en from '../public/i18n/en.js';
import ru from '../public/i18n/ru.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f));
const INDEX = read('index.html').toString('utf8');
const HEAD = INDEX.slice(0, INDEX.indexOf('</head>'));

/** The content of every <meta property|name="key"> (attributes in any order; double-quoted values). */
function metas(html, key) {
  const out = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const k = /\s(?:property|name)="([^"]*)"/i.exec(tag);
    const c = /\scontent="([^"]*)"/i.exec(tag);
    if (k && k[1] === key && c) out.push(c[1]);
  }
  return out;
}
const meta = (html, key) => { const all = metas(html, key); assert.equal(all.length, 1, `one ${key}`); return all[0]; };
const titleOf = (html) => /<title>([^<]*)<\/title>/.exec(html)[1];
/** The page without its comments (they name tags that are not there). */
const uncommented = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
/** Indices of the lines that differ (the same number of lines on both sides). */
function changedLines(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  assert.equal(x.length, y.length, 'same number of lines');
  return x.flatMap((l, i) => (l === y[i] ? [] : [i]));
}
function png(buf) {
  assert.equal(buf.readUInt32BE(0), 0x89504e47, 'a PNG');
  assert.equal(buf.toString('latin1', 12, 16), 'IHDR');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), depth: buf[24], color: buf[25] };
}

const VALID = [
  ['/?room=ABCD', 'ABCD'],
  ['/?room=abcd', 'ABCD'],
  ['/?room=xYzW', 'XYZW'],
  ['/?room=HJKN', 'HJKN'],
  ['/index.html?room=PQRS', 'PQRS'],
  ['/?lang=ru&room=MNPQ&profile=p2', 'MNPQ'],
  ['/?room=%41BCD', 'ABCD'],
  ['https://evil.example/x/y?room=TUVW', 'TUVW'],
  ['//evil.example/?room=GHJK', 'GHJK'],
  ['/?room=ABCD&room=%22%3E%3Cscript%3E', 'ABCD'],   // the first room parameter counts, as in app.js
];
const INVALID = [
  '/', '/?', '/?room', '/?room=', '/?rooms=ABCD', '/?ROOM=ABCD', '/#room=ABCD', '/?x=1#room=ABCD',
  '/?room=ABC', '/?room=ABCDE', '/?room=ABCI', '/?room=ABCO', '/?room=abci', '/?room=abco', '/?room=AB1D', '/?room=1234',
  '/?room=AB%20D', '/?room=AB+D', '/?room=%20ABCD', '/?room=ABCD%20', '/?room=ABCD%00', '/?room=%00ABC', '/?room=AB-D',
  '/?room=ABCD%0A', '/?room=AB%0AD',
  // look-alikes: Cyrillic А В С Е, fullwidth, long s (ſ upper-cases to S), dotless ı (to I), the Kelvin sign (folds to k),
  // a ligature (ﬀ upper-cases to FF), a combining accent
  '/?room=' + encodeURIComponent('АВСЕ'), '/?room=' + encodeURIComponent('ＡＢＣＤ'), '/?room=' + encodeURIComponent('ABCſ'),
  '/?room=' + encodeURIComponent('ABCı'), '/?room=' + encodeURIComponent('ABCK'), '/?room=' + encodeURIComponent('ABﬀ'),
  '/?room=' + encodeURIComponent('ABCD́'), '/?room=' + encodeURIComponent('ABC​D'),
  '/?room=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E', '/?room=%3C%2Ftitle%3E', "/?room=AB'D", '/?room=AB%22D',
  '/?room=%E0%A4%A', '/?room=%', '/?room=%%%%', '/?room=%C0%80BC',
  '/?room=<script>&room=ABCD',                       // the first one is not a code
];
const PAYLOADS = [
  '"><script>alert(1)</script>', "'><img src=x onerror=alert(1)>", '</title><script>alert(1)</script>', '<!--', '-->',
  'ABCD"', 'ABCD<', 'javascript:alert(1)', '${7*7}', '{{7*7}}', '$&$\'$`', '  ', '&amp;&lt;', 'ABCD&room=WXYZ',
];

describe('roomFromUrl: the room code of an invite link', () => {
  for (const [url, code] of VALID) {
    test(`${url} -> ${code}`, () => {
      assert.equal(roomFromUrl(url), code);
      assert.deepEqual(roomPreview(url), { code, title: `Join room ${code} — Seal the Bunker`, url: `https://sealthebunker.com/?room=${code}` });
    });
  }
  test('a URL object works like its string', () => {
    assert.equal(roomFromUrl(new URL('http://localhost/?room=wxyz')), 'WXYZ');
    assert.equal(roomFromUrl(new URL('http://localhost/?room=WXYO')), null);
  });
  test('anything that is not exactly 4 letters of ABCDEFGHJKLMNPQRSTUVWXYZ is no code', () => {
    for (const url of INVALID) {
      assert.equal(roomFromUrl(url), null, url);
      assert.equal(roomPreview(url), null, url);
    }
  });
  test('a URL that is not a string or a URL, or does not parse, is no code', () => {
    for (const url of [undefined, null, 42, {}, ['/?room=ABCD'], { url: '/?room=ABCD' }, Symbol.for('x'), 'http://[::1/?room=ABCD']) {
      assert.equal(roomFromUrl(url), null, String(url?.toString?.() ?? url));
    }
  });
  test('the code is checked before it is upper-cased (no case mapping or folding makes a code)', () => {
    // each of these becomes a valid code by upper-casing, or by Unicode case folding (/[A-Z]/iu matches the Kelvin sign)
    const cases = [['ſſſſ', 'SSSS'], ['ﬀﬀ', 'FFFF'], ['ﬀſſ', 'FFSS']];
    for (const [s, upper] of cases) {
      assert.equal(s.toUpperCase(), upper);
      assert.equal(roomFromUrl('/?room=' + encodeURIComponent(s)), null, s);
    }
    assert.ok(/^[A-Z]{4}$/iu.test('KKKK'));
    assert.equal(roomFromUrl('/?room=' + encodeURIComponent('KKKK')), null);
    assert.equal(roomFromUrl('/?room=' + encodeURIComponent('ıııı')), null);
  });
});

describe('withRoomPreview on public/index.html', () => {
  const lineOf = (needle) => INDEX.split('\n').findIndex((l) => l.includes(needle) && !l.trimStart().startsWith('<!--') && !/^\s{5}/.test(l));

  test('an invite link gets its own title, og:title and og:url, and nothing else changes', () => {
    const out = withRoomPreview(INDEX, '/?room=abcd');
    assert.equal(meta(out, 'og:title'), 'Join room ABCD — Seal the Bunker');
    assert.equal(meta(out, 'og:url'), 'https://sealthebunker.com/?room=ABCD');
    assert.equal(titleOf(out), 'Join room ABCD — Seal the Bunker');
    // the three lines that hold those tags, and no other line
    const expected = [lineOf('<title>'), lineOf('property="og:title"'), lineOf('property="og:url"')].sort((a, b) => a - b);
    assert.ok(expected.every((i) => i >= 0), 'the tags are on their own lines');
    assert.deepEqual(changedLines(INDEX, out), expected);
    // an invite is the home page for search engines
    assert.equal(/<link rel="canonical" href="([^"]*)">/.exec(out)[1], 'https://sealthebunker.com/');
    for (const key of ['og:description', 'og:image', 'og:type', 'og:site_name', 'og:locale', 'twitter:card', 'description']) {
      assert.equal(meta(out, key), meta(INDEX, key), key);
    }
  });

  test('the page\'s comments stay as they are (they name the tags it rewrites)', () => {
    const out = withRoomPreview(INDEX, '/?room=WXYZ');
    const comments = (h) => h.match(/<!--[\s\S]*?-->/g);
    assert.deepEqual(comments(out), comments(INDEX));
    assert.ok(comments(INDEX).some((c) => c.includes('og:title')), 'a comment names og:title');
  });

  test('without a valid room code the page is the same string', () => {
    for (const url of [...INVALID, undefined, null, 42, '']) assert.equal(withRoomPreview(INDEX, url), INDEX, String(url));
    for (const p of PAYLOADS) assert.equal(withRoomPreview(INDEX, '/?room=' + encodeURIComponent(p)), INDEX, p);
  });

  test('injection attempts in other parameters never reach the page', () => {
    for (const p of PAYLOADS) {
      const url = `/?room=ABCD&x=${encodeURIComponent(p)}&${encodeURIComponent(p)}=1&lang=${encodeURIComponent(p)}`;
      const out = withRoomPreview(INDEX, url);
      assert.equal(out, withRoomPreview(INDEX, '/?room=ABCD'), p);
    }
  });

  test('no other query parameter, host or path is reflected', () => {
    const out = withRoomPreview(INDEX, 'http://evil.example:8080/some/where.html?utm_source=zz_marker_zz&room=HJKL&profile=p7&lang=ru');
    assert.equal(meta(out, 'og:url'), 'https://sealthebunker.com/?room=HJKL');
    for (const s of ['zz_marker_zz', 'utm_source', 'evil.example', 'some/where', 'profile=p7', 'lang=ru']) assert.ok(!out.includes(s), s);
    assert.equal(out, withRoomPreview(INDEX, '/?room=hjkl'));
  });

  test('applying it again, or for another room, gives that room\'s page', () => {
    const a = withRoomPreview(INDEX, '/?room=ABCD');
    assert.equal(withRoomPreview(a, '/?room=ABCD'), a);
    assert.equal(withRoomPreview(a, '/?room=WXYZ'), withRoomPreview(INDEX, '/?room=WXYZ'));
  });

  test('a page that is not a string comes back as it is', () => {
    const buf = Buffer.from(INDEX);
    assert.equal(withRoomPreview(buf, '/?room=ABCD'), buf);
    assert.equal(withRoomPreview(undefined, '/?room=ABCD'), undefined);
    assert.equal(withRoomPreview(null, '/?room=ABCD'), null);
  });
});

describe('withRoomPreview on other markup', () => {
  const url = '/?room=MNPQ';
  const T = 'Join room MNPQ — Seal the Bunker';
  test('attribute order and quotes do not matter; other attributes and tags stay', () => {
    const html = "<title lang=en>x</title><meta content='old' property='og:title' data-x='1'>\n<meta name=\"twitter:title\" content=\"old\">"
      + '<meta property="og:url" data-content="keep" content="a > b">';
    assert.equal(withRoomPreview(html, url),
      `<title>${T}</title><meta content="${T}" property='og:title' data-x='1'>\n<meta name="twitter:title" content="${T}">`
      + '<meta property="og:url" data-content="keep" content="https://sealthebunker.com/?room=MNPQ">');
  });
  test('a page without the tags gets only its title', () => {
    assert.equal(withRoomPreview('<!doctype html><title>client</title>', url), `<!doctype html><title>${T}</title>`);
    assert.equal(withRoomPreview('<p>no head</p>', url), '<p>no head</p>');
  });
  test('comments, an unclosed one too, are never rewritten; only the first title is', () => {
    const html = '<!-- <title>c</title> <meta property="og:title" content="c"> --><title>a</title><title>b</title>'
      + '<meta property="og:title" content="x"><!-- <meta property="og:url" content="c">';
    assert.equal(withRoomPreview(html, url),
      `<!-- <title>c</title> <meta property="og:title" content="c"> --><title>${T}</title><title>b</title>`
      + `<meta property="og:title" content="${T}"><!-- <meta property="og:url" content="c">`);
  });
  test('"$" patterns in the page are kept as they are', () => {
    const html = '<title>$& $1 $` $\'</title><meta property="og:title" content="$&"><p>$$</p>';
    assert.equal(withRoomPreview(html, url), `<title>${T}</title><meta property="og:title" content="${T}"><p>$$</p>`);
  });
  test('other meta tags are left alone', () => {
    const html = '<meta property="og:titles" content="a"><meta property="og:title:x" content="b"><meta itemprop="og:title" content="c">';
    assert.equal(withRoomPreview(html, url), html);
  });
});

describe('escapeHtml', () => {
  test('escapes the five characters and nothing else', () => {
    assert.equal(escapeHtml(`<a href="x" title='y'>&amp;</a> ÀБ€ —`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt; ÀБ€ —');
    assert.equal(escapeHtml(42), '42');
  });
  test('the constants', () => {
    assert.equal(SITE_ORIGIN, 'https://sealthebunker.com');
    assert.equal(SITE_NAME, 'Seal the Bunker');
  });
});

describe('public/index.html: search and link previews', () => {
  test('Open Graph and X card tags', () => {
    assert.equal(titleOf(INDEX), 'Seal the Bunker — online party game · Бункер онлайн');
    assert.equal(meta(INDEX, 'og:title'), 'Seal the Bunker — online party game');
    assert.equal(meta(INDEX, 'og:type'), 'website');
    assert.equal(meta(INDEX, 'og:site_name'), 'Seal the Bunker');
    assert.equal(meta(INDEX, 'og:url'), 'https://sealthebunker.com/');
    assert.equal(meta(INDEX, 'og:image'), 'https://sealthebunker.com/og-image.png');
    assert.equal(meta(INDEX, 'og:image:type'), 'image/png');
    assert.equal(meta(INDEX, 'og:image:width'), '1200');
    assert.equal(meta(INDEX, 'og:image:height'), '630');
    assert.ok(meta(INDEX, 'og:image:alt').length > 20);
    assert.equal(meta(INDEX, 'og:locale'), 'en_US');
    assert.equal(meta(INDEX, 'og:locale:alternate'), 'ru_RU');
    assert.equal(meta(INDEX, 'twitter:card'), 'summary_large_image');
    const og = meta(INDEX, 'og:description');
    assert.ok(og.startsWith('Who gets into the bunker?') && og.includes('Кто попадёт в бункер?'), og);
    assert.equal(/<link rel="canonical" href="([^"]*)">/.exec(INDEX)[1], 'https://sealthebunker.com/');
  });

  test('the description is bilingual, English first (SPEC §11 X5.7); no hreflang (one URL serves both languages)', () => {
    const d = meta(INDEX, 'description');
    assert.match(d, /^[A-Za-z]/);
    assert.match(d, /[а-яё]/i);
    assert.ok(d.indexOf('bunker') < d.search(/[а-яё]/i));
    assert.ok(!/hreflang/i.test(uncommented(HEAD)), 'hreflang would need a URL per language');
  });

  test('JSON-LD: a WebSite and a VideoGame + WebApplication', () => {
    const blocks = [...INDEX.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(blocks.length, 1);
    assert.ok(!/<\/script|<!--/i.test(blocks[0]));
    const data = JSON.parse(blocks[0]);
    assert.equal(data['@context'], 'https://schema.org');
    const site = data['@graph'].find((n) => n['@type'] === 'WebSite');
    assert.equal(site.url, 'https://sealthebunker.com/');
    assert.equal(site.name, 'Seal the Bunker');
    const game = data['@graph'].find((n) => Array.isArray(n['@type']) && n['@type'].includes('VideoGame'));
    assert.deepEqual(game['@type'], ['VideoGame', 'WebApplication']);
    assert.equal(game.name, 'Seal the Bunker');
    assert.equal(game.url, 'https://sealthebunker.com/');
    assert.ok(game.description.length > 50);
    assert.equal(game.applicationCategory, 'GameApplication');
    assert.equal(game.operatingSystem, 'Any');
    assert.equal(game.offers.price, '0');
    assert.deepEqual(game.inLanguage, ['en', 'ru']);
    assert.ok(game.genre.includes('Party game') && game.genre.includes('Social deduction'));
    assert.deepEqual([game.numberOfPlayers.minValue, game.numberOfPlayers.maxValue], [4, 16]);
    assert.equal(game.image, meta(INDEX, 'og:image'));
  });

  test('nothing the CSP would block: every script is app.js or a data block, no on…= handlers', () => {
    const scripts = INDEX.match(/<script\b[^>]*>/gi);
    for (const s of scripts) assert.ok(/^<script type="module" src="app\.js">$/.test(s) || s === '<script type="application/ld+json">', s);
    for (const tag of uncommented(INDEX).match(/<[a-z][^>]*>/gi)) assert.ok(!/\son[a-z]+\s*=/i.test(tag), tag);
    assert.ok(!/=\s*["']?\s*javascript:/i.test(INDEX), 'no javascript: URL');
  });

  test('every file the head links to exists', () => {
    const refs = [...HEAD.matchAll(/\s(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((r) => !/^https?:/.test(r));
    assert.ok(refs.length >= 7, refs.join());
    for (const r of refs) assert.ok(fs.existsSync(path.join(PUB, r.replace(/^\//, ''))), r);
    for (const r of ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'site.webmanifest']) assert.ok(refs.includes(r), r);
  });

  test('the fallback text: in #app, hidden wherever scripts run, shown by a <noscript> style', () => {
    const app = /<div id="app" class="app">([\s\S]*?)<\/div>\s*<\/body>/.exec(INDEX)[1];
    assert.match(app, /^<main class="seo-fallback">/);
    // tools/e2e.js waits for `#app > div` as "the app has rendered": the fallback must not be one
    assert.ok(!/<div\b/i.test(app));
    const head = uncommented(HEAD);
    assert.match(head, /<style>\.seo-fallback \{ display: none; \}<\/style>/);
    const noscript = /<noscript><style>([\s\S]*?)<\/style><\/noscript>/.exec(head);
    assert.ok(noscript && /\.seo-fallback \{ display: block;/.test(noscript[1]));
    assert.ok(head.indexOf('display: none') < head.indexOf('<script type="module"'), 'hidden before app.js can run');
    assert.match(app, /<h1>Seal the Bunker<\/h1>/);
    assert.match(app, /<section class="ru" lang="ru">/);
    assert.match(app, /href="\/privacy\.html"/);
  });

  test('the fallback says what the landing says, in both languages', () => {
    const app = /<div id="app" class="app">([\s\S]*?)<\/div>\s*<\/body>/.exec(INDEX)[1]
      .replace(/&nbsp;/g, ' ').replace(/&#8288;/g, '⁠');
    const [enPart, ruPart] = app.split('<section class="ru" lang="ru">');
    for (const k of ['landing.lede', 'landing.step1', 'landing.step2', 'landing.step3']) {
      assert.ok(enPart.includes(en[k]), `en ${k}`);
      assert.ok(ruPart.includes(ru[k]), `ru ${k}`);
    }
  });
});

describe('the files beside the page', () => {
  test('og-image.png: 1200×630, opaque, under 300 KB (WhatsApp shows no preview above that)', () => {
    const buf = read('og-image.png');
    assert.deepEqual(png(buf), { w: 1200, h: 630, depth: 8, color: 2 });
    assert.ok(buf.length < 300 * 1024, String(buf.length));
  });

  test('apple-touch-icon.png: 180×180 and opaque (iOS draws transparency black)', () => {
    assert.deepEqual(png(read('apple-touch-icon.png')), { w: 180, h: 180, depth: 8, color: 2 });
  });

  test('favicon.ico: 16, 32 and 48 px PNG entries', () => {
    const ico = read('favicon.ico');
    assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)], [0, 1, 3]);
    const sizes = [0, 1, 2].map((i) => {
      const o = 6 + 16 * i;
      const img = png(ico.subarray(ico.readUInt32LE(o + 12), ico.readUInt32LE(o + 12) + ico.readUInt32LE(o + 8)));
      assert.equal(img.w, ico[o]);
      return img.w;
    });
    assert.deepEqual(sizes, [16, 32, 48]);
  });

  test('site.webmanifest: names, colours and icons that exist at their stated sizes', () => {
    const m = JSON.parse(read('site.webmanifest').toString('utf8'));
    assert.equal(m.name, 'Seal the Bunker');
    assert.ok(m.short_name.length <= 12);
    assert.equal(m.start_url, '/');
    assert.equal(m.theme_color, meta(INDEX, 'theme-color'));
    assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
    for (const icon of m.icons) {
      const file = read(icon.src.replace(/^\//, ''));
      if (icon.type === 'image/svg+xml') { assert.equal(icon.sizes, 'any'); continue; }
      const { w, h } = png(file);
      assert.equal(`${w}x${h}`, icon.sizes, icon.src);
    }
    for (const size of ['192x192', '512x512']) assert.ok(m.icons.some((i) => i.sizes === size && !i.purpose), size);
  });

  test('robots.txt: all allowed but /dev and /admin, and the sitemap', () => {
    const lines = read('robots.txt').toString('utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.equal(lines[0], 'User-agent: *');
    for (const l of ['Disallow: /dev', 'Disallow: /admin', 'Sitemap: https://sealthebunker.com/sitemap.xml']) assert.ok(lines.includes(l), l);
    assert.ok(!lines.includes('Disallow: /') && !lines.includes('Disallow: /?') && !lines.some((l) => /room/i.test(l)));
  });

  test('sitemap.xml: the home page and the privacy notice, both files that exist', () => {
    const xml = read('sitemap.xml').toString('utf8');
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs, ['https://sealthebunker.com/', 'https://sealthebunker.com/privacy.html']);
    assert.ok(fs.existsSync(path.join(PUB, 'index.html')) && fs.existsSync(path.join(PUB, 'privacy.html')));
    assert.equal((xml.match(/<url>/g) || []).length, (xml.match(/<\/url>/g) || []).length);
  });
});
