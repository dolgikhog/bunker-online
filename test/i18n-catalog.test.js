// The catalogue test (SPEC §11 X5.8; reports/i18n-design.md §11 "test/i18n-catalog.test.js", §13 item 2). Owner:
// i18n-content (the tool); everyone fixes their own files.
//
// 1. The real catalogues (content, server messages, client strings; English and Russian) pass tools/i18n-check.js
//    with no error. Russian entries still missing in a file that is not COMPLETE are reported here, not failed.
// 2. The checker's own rules, on made-up catalogues: each rule catches what it is for, so a clean run means something.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  check, load, Report, checkContent, checkMessages, checkClient, checkGlossary, latinLeft, reviewWords, timeAgreement,
  textProblems, pluralLint, placeholderLint, numbersIn, combos, readMarks, write,
} from '../tools/i18n-check.js';
import * as core from '../public/i18n/core.js';

const ROOT = new URL('..', import.meta.url).pathname;

describe('the real catalogues', () => {
  let result;
  before(async () => { result = await check(); });

  test('tools/i18n-check.js: no error', (t) => {
    for (const n of result.notes) t.diagnostic(`note: ${n}`);
    const missing = result.problems.filter((p) => p.level === 'missing');
    const byFile = new Map();
    for (const p of missing) byFile.set(p.file, (byFile.get(p.file) || 0) + 1);
    for (const [f, n] of byFile) t.diagnostic(`not translated yet (not failing until COMPLETE): ${f} ${n}`);
    const shown = result.errors.slice(0, 40).map((p) => `${p.area} ${p.file} ${p.key} [${p.rule}] ${p.msg}`);
    assert.equal(result.errors.length, 0, `${result.errors.length} error(s), run npm run i18n:check:\n${shown.join('\n')}`);
  });

  test('every content file was checked', () => {
    assert.equal(Object.keys(result.stats.content).length, 13);
    for (const [f, c] of Object.entries(result.stats.content)) assert.ok(c.total > 0, f);
  });

  test('npm run i18n:check exits 0 and writes nothing with --no-write', async () => {
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [path.join(ROOT, 'tools/i18n-check.js'), '--no-write', '--json'], { cwd: ROOT });
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['i18n:check'], 'node tools/i18n-check.js');
  });
});

describe('the rules on text', () => {
  test('Latin: only °C, 3D, USB and what the params supplied', () => {
    assert.equal(latinLeft('−40°C, 3D-принтер, USB-флешка, ×2'), '');
    assert.equal(latinLeft('Лампа UV'), 'UV');
    assert.equal(latinLeft('ПТСР (PTSD)'), 'PTSD');
    assert.equal(latinLeft('Ход: Bot Anna', ['Bot Anna']), '');
    assert.equal(latinLeft('Код ABCD, игрок Bob', ['ABCD']), 'Bob');
    assert.equal(latinLeft('Café'), 'Café');
    assert.equal(latinLeft('3DS'), 'DS');
  });

  test('the review words: a past tense or a short participle, not a noun', () => {
    assert.deepEqual(reviewWords('Анна вышла из игры'), ['вышла']);
    assert.deepEqual(reviewWords('Ты проголосовал, он сказал'), ['проголосовал', 'сказал']);
    assert.deepEqual(reviewWords('Игрок изгнан, она заражена'), ['изгнан', 'заражена']);
    assert.deepEqual(reviewWords('Стол, зал, сигнал и финал; план на экране'), []);
    assert.deepEqual(reviewWords('Анна выходит из игры'), []);
  });

  test('number words agree with the number before them (plural coverage of the output)', () => {
    for (const ok of ['1 год', '2 года', '5 лет', '11 лет', '21 год', '22 года', '1,5 года', '2,5 месяца', '1 месяц', '3 месяца',
      '12 месяцев', 'до 2 лет', 'до 1 года', 'от 6 месяцев до 1,5 года', '2–6 лет', '2 года 3 месяца', '640 000 лет', '640\u202F000 лет', 'через 2 года',
      '1 игрок', '4 игрока', '5 игроков', '1 койка', '3 койки', '5 коек', 'с 1 года', 'после 21 года', '14 лет']) {
      assert.deepEqual(timeAgreement(ok), [], ok);
    }
    for (const [bad, want] of [['2 год', 'года'], ['5 года', 'лет'], ['11 год', 'лет'], ['21 лет', 'год'], ['до 2 года', 'лет'],
      ['от 1 год', 'года'], ['3 месяцев', 'месяца'], ['1,5 лет', 'года'], ['2–6 года', 'лет'], ['2 игроков', 'игрока'], ['5 койки', 'коек']]) {
      const r = timeAgreement(bad);
      assert.equal(r.length, 1, bad);
      assert.equal(r[0].want, want, bad);
    }
  });

  test('braces, double and edge spaces (fragments may start or end with one), bracketed gender forms', () => {
    const rules = (s, o) => textProblems(s, o).map(([r]) => r);
    assert.deepEqual(rules('Всё хорошо'), []);
    assert.deepEqual(rules('Осталось {0}'), ['braces']);
    assert.deepEqual(rules('Два  пробела'), ['double space']);
    assert.deepEqual(rules('Раунд 3 — '), ['edge space']);
    assert.deepEqual(rules('Раунд 3 — ', { fragment: true }), []);
    assert.deepEqual(rules('Ты проголосовал(а)'), ['gender']);
    assert.deepEqual(rules('готов(ен)'), ['gender']);
  });
});

describe('the rules on templates', () => {
  before(async () => { await load(); });
  const num = (n) => ['n', 'k', 'beds', '0'].includes(n);
  const lint = (t) => pluralLint(t, num).map(([, m]) => m);

  test('plural lint: a printed number before a Cyrillic word needs three forms on that word', () => {
    assert.equal(lint('Нужно хотя бы {n} игроков').length, 1);
    assert.deepEqual(lint('Нужно хотя бы {n} {n|игрок|игрока|игроков}'), []);
    assert.equal(lint('{n} {n|игрок|игроков}').length, 1, 'two forms right after the printed number');
    assert.deepEqual(lint('{k|изгнание переносится|изгнания переносятся}'), [], 'two forms: the number is not printed');
    assert.equal(lint('{k|игрок|игрока|игроков} снаружи').length, 1, 'three forms without the printed number');
    assert.deepEqual(lint('снаружи {k|останется|останутся|останутся} {k} {k|игрок|игрока|игроков}'), []);
    assert.deepEqual(lint('{n} мин, {n} км, {0} из {k}, {n}%, с раунда {n}, {0}-й курс'), []);
    assert.deepEqual(lint('{n} ×2, {n}: да'), []);
    assert.equal(lint('Палатка на {0} человек').length, 1);
  });

  test('positional placeholders (§6.3): params, printing, option counts, plurals, forms', () => {
    const P = (en) => {
      const t = [];
      for (const m of en.matchAll(/\{([^{}]+)\}/g)) {
        const b = m[1];
        let r;
        if (b === 'sev') t.push({ type: 'sev' });
        else if ((r = /^n:(\d+)-(\d+)$/.exec(b))) t.push({ type: 'number', options: Number(r[2]) + 1 });
        else if ((r = /^yrs:(\d+)-(\d+)$/.exec(b))) t.push({ type: 'yrs', options: Number(r[2]) + 1 });
        else t.push({ type: 'pick', options: b.split('|').length });
      }
      return (name) => (/^\d+$/.test(name) ? t[Number(name)] : undefined);
    };
    const rules = (en, ru) => placeholderLint(ru, P(en), { ru: true }).map(([r]) => r);
    const EN = 'Former prisoner ({n:2-15} years for {fraud|robbery|smuggling})';
    assert.deepEqual(rules(EN, 'Отсидка: {0} {0|год|года|лет} за {1:мошенничество|грабёж|контрабанду}'), []);
    assert.deepEqual(rules(EN, 'Отсидка: {0} {0|год|года|лет} за {1}'), ['option'], 'a pick is never printed');
    assert.deepEqual(rules(EN, 'Отсидка за {1:мошенничество|грабёж}'), ['option'], 'two options for three');
    assert.deepEqual(rules(EN, 'Отсидка: {2}'), ['param'], 'no param 2');
    assert.deepEqual(rules(EN, 'Отсидка: {0} {1|год|лет}'), ['plural'], 'a plural on a pick');
    assert.deepEqual(rules(EN, 'Отсидка: {0@acc}'), ['form']);
    assert.deepEqual(rules(EN, 'Отсидка: {n}'), ['param'], 'English syntax in a Russian template');
    assert.deepEqual(rules('Asthma ({sev})', 'Астма ({0:лёгкая|средняя|тяжёлая})'), []);
    assert.deepEqual(rules('Asthma ({sev})', 'Астма ({0:лёгкая|тяжёлая})'), ['option']);
    assert.deepEqual(rules('Asthma ({sev})', 'Астма ({0})'), [], 'the default severity phrase');
    assert.deepEqual(rules('has {n:2-5} children', '{0:||двое|трое|четверо|пятеро} детей'), [], 'an option by the number: hi + 1');
    assert.deepEqual(rules('has {n:2-5} children', '{0:двое|трое|четверо|пятеро} детей'), ['option']);
    assert.deepEqual(rules('Heart attack {yrs:1-9} ago', 'Инфаркт {0} назад'), []);
  });

  test('message placeholders: types from SCHEMA, forms, protocol identifiers kept out of Russian', () => {
    const S = { p: { type: 'player' }, cat: { type: 'cat' }, ids: { type: 'list' }, rp: { type: 'rp' }, ot: { type: 'bool' },
      how: { type: 'index', options: 3 }, mode: { type: 'enum' }, n: { type: 'number' }, field: { type: 'protocol' } };
    const rules = (t, ru = true) => placeholderLint(t, (x) => S[x], { ru }).map(([r]) => r);
    assert.deepEqual(rules('{rp}{p} раскрывает {cat@acc}; {ids@and}; {rp@bare}; {ot:а|б}; {how:|x|y}; {n} {n|раз|раза|раз}'), []);
    assert.deepEqual(rules('{p@cap}'), ['form'], 'a name is never changed');
    assert.deepEqual(rules('{cat@and}'), ['form']);
    assert.deepEqual(rules('{ot:а|б|в}'), ['option']);
    assert.deepEqual(rules('{ot}'), ['option'], 'a boolean is not printed');
    assert.deepEqual(rules('{how:а|б}'), ['option']);
    assert.deepEqual(rules('{mode:а|б}'), ['option'], 'an enum needs a function');
    assert.deepEqual(rules('{n|раз|раза|раз}', false), ['plural'], 'English has two forms');
    assert.deepEqual(rules('Нет поля «{field}»'), ['protocol']);
    assert.deepEqual(rules('Missing field "{field}"', false), []);
    assert.deepEqual(rules('{who}'), ['param']);
  });

  test('numbersIn and combos', () => {
    assert.deepEqual(numbersIn(2, 8), [2, 3, 4, 5, 6, 7, 8], 'a short range: every value');
    assert.deepEqual(numbersIn(195, 212), [195, 201, 202, 211, 212]);
    assert.deepEqual(numbersIn(1, 30), [1, 2, 5, 11, 12, 21, 22, 30]);
    assert.deepEqual(numbersIn(10, 999), [10, 11, 12, 21, 22, 999]);
    assert.equal(combos([[1, 2], ['a', 'b', 'c']]).length, 6);
    const big = combos([Array.from({ length: 40 }, (_, i) => i), Array.from({ length: 40 }, (_, i) => i)], 100);
    assert.equal(big.length, 100);
    for (let i = 0; i < 40; i++) assert.ok(big.some((c) => c[0] === i) && big.some((c) => c[1] === i), 'every candidate appears');
    assert.deepEqual(combos([]), [[]]);
  });
});

/** Error rules by key, from a Report. */
const found = (rep, level = 'error') => rep.problems.filter((p) => p.level === level).map((p) => `${p.file}|${p.key}|${p.rule}`);

describe('the content checks on made-up Russian tables', () => {
  let L;
  before(async () => { L = await load(); });

  function run(ru, complete = {}) {
    const rep = new Report();
    const C = { ...L.C, RU: { ...Object.fromEntries(Object.keys(L.C.RU).map((f) => [f, {}])), ...ru } };
    C.COMPLETE = Object.fromEntries(Object.keys(L.C.RU).map((f) => [f, complete[f] === true]));
    checkContent(rep, C);
    return rep;
  }

  test('empty tables: everything missing, nothing failing; COMPLETE turns missing into errors', () => {
    const rep = run({});
    assert.deepEqual(found(rep), []);
    assert.ok(found(rep, 'missing').length > 800);
    const strict = run({}, { health: true });
    assert.ok(found(strict).some((x) => x.startsWith('health|asthma|missing')));
    assert.ok(!found(strict).some((x) => x.startsWith('skills|')));
  });

  test('pool entries: Latin, a printed pick, option counts, stray ids, throws, agreement', () => {
    const rep = run({
      health: {
        'asthma': 'Астма (mild)',
        'allergy-to': 'Аллергия на {0} ({1})',
        'type-2-diabetes': 'Диабет ({0:лёгкий|тяжёлый})',
        'no-such-card': 'Лишняя',
        'hemophilia': () => { throw new Error('boom'); },
        'epilepsy-seizures': () => 42,
        'survived-a-heart-attack-ago': 'Инфаркт {0} назад',
        'cancer-stage': 'Рак ({0} стадия)',
        'obesity-class': (v) => `Ожирение (${v[0]} год)`,
      },
      skills: {
        'speaks-languages': 'Говорит на {0} языках',
        'can-juggle-knives': 'Жонглирует {0} {0|нож|ножа|ножей}',
        'black-belt-in': 'Чёрный пояс ({0:дзюдо|карате|тхэквондо}), "мастер"',
        'volunteer-rescuer': () => "Спасатель-доброволец",
      },
    });
    const f = found(rep);
    for (const x of ['health|asthma|latin', 'health|allergy-to|option', 'health|type-2-diabetes|option', 'health|no-such-card|stray',
      'health|hemophilia|throw', 'health|epilepsy-seizures|type', 'health|cancer-stage|plural', 'health|obesity-class|agreement',
      'skills|speaks-languages|plural', 'skills|black-belt-in|quotes']) assert.ok(f.includes(x), `${x} in\n${f.join('\n')}`);
    assert.ok(!f.some((x) => x.startsWith('skills|volunteer-rescuer')), 'a function\'s own JS quotes are code, not text');
    assert.ok(!f.some((x) => x.startsWith('health|survived-a-heart-attack-ago')), 'yrs prints its own word');
    assert.ok(!f.some((x) => x.startsWith('skills|can-juggle-knives')));
  });

  test('labels, mods, specials: forms, glossary, required params, array lengths', () => {
    const rep = run({
      labels: {
        profession: 'Профессия',
        health: { label: 'здоровье', nom: 'здоровье', acc: 'здоровье', gen: 'здоровья', dat: 'здоровью', ins: 'здоровьем', loc: 'здоровье' },
        skill: { label: 'Умение', nom: 'умение', acc: 'умение', gen: 'умения', dat: 'умению', ins: 'умением', loc: 'умении', voc: 'x' },
      },
      mods: { sev: ['лёгкая', 'тяжёлая'], profession: { exp: 'стаж большой', retired: 'на пенсии после {n} лет' }, professionWrap: '{base}' },
      specials: { airlock: { title: 'Воздушный шлюз', text: 'Нужен напарник.' }, 'swap-baggage': { title: '«Обмен».', text: 'Выбери игрока.' } },
    });
    const f = found(rep);
    for (const x of ['labels|profession|type', 'labels|health.label|case', 'labels|skill.label|glossary', 'labels|skill.voc|stray',
      'mods|sev|type', 'mods|profession.exp|param', 'mods|profession.retired|plural', 'mods|professionWrap|param',
      'specials|airlock.title|glossary', 'specials|swap-baggage.title|quotes', 'specials|swap-baggage.title|period']) {
      assert.ok(f.includes(x), `${x} in\n${f.join('\n')}`);
    }
  });

  test('biology, catastrophes and the bunker: functions over their whole domain', () => {
    const rep = run({
      biology: {
        sex: { f: 'Женщина', m: 'Мужчина' },
        orientation: { hetero: { f: 'гетеросексуальна', m: 'гетеросексуален' } },
        notes: { children: '{0} детей' },
        card: (v) => `${v.sexText}, ${v.age} год, ${v.oText}`,
      },
      catastrophes: { list: { 'nuclear-winter': { title: 'Ядерная зима', text: 'Текст.', details: ['Выжившие: {0}%'] } }, safe: 'Безопасно через {range}' },
      bunker: {
        letters: 'АБВГДЕКМНПРСТХ',
        months: (v, f) => `${f.num(v.m)} месяцев`,
        range: (v, f) => `через ${f.num(v.lo / 12)}–${f.num(v.hi / 12)} ${f.pl(v.hi / 12, 'год', 'года', 'лет')}`,
        name: { object: 'Объект {n} «{nick}»', shelter: 'Убежище № {n}' },
        size: '{n} м²',
      },
    });
    const f = found(rep);
    for (const x of ['biology|card|agreement', 'biology|notes.children|plural', 'catastrophes|list.nuclear-winter.details|type',
      'bunker|letters|count', 'bunker|months()|agreement', 'bunker|name.object|param']) assert.ok(f.includes(x), `${x} in\n${f.join('\n')}`);
    for (const ok of ['bunker|range()', 'bunker|name.shelter', 'bunker|size', 'catastrophes|safe']) assert.ok(!f.some((x) => x.startsWith(ok)), ok);
  });
});

describe('the message and client checks on made-up Russian catalogues', () => {
  let L;
  before(async () => { L = await load(); });

  test('messages: stray keys, plural lint, protocol identifiers, forms, throws, the review list, COMPLETE', (t) => {
    if (!L.M) { t.skip('server/i18n is not there yet'); return; }
    const rep = new Report();
    checkMessages(rep, {
      ...L.M,
      COMPLETE: true,
      RU: {
        'log.join': '{p} присоединился к игре',
        'log.gameBegins': 'Игра: {n} игроков, {beds} {beds|койка|койки|коек}. Катастрофа: {cata}. Бункер: {bname}.',
        'err.missingField': 'Нет поля «{field}»',
        'log.reveal': '{rp}{p} раскрывает {cat@xyz}: {card}',
        'log.leftGame': () => { throw new Error('boom'); },
        'no.such.key': 'Лишний',
        'rp': 'Раунд {r} - ',
      },
    }, L.C);
    const f = found(rep);
    for (const x of ['server/i18n/ru.js|log.gameBegins|plural', 'server/i18n/ru.js|err.missingField|protocol',
      'server/i18n/ru.js|err.missingField|latin', 'server/i18n/ru.js|log.reveal|form', 'server/i18n/ru.js|log.leftGame|throw',
      'server/i18n/ru.js|no.such.key|stray', 'server/i18n/ru.js|log.watch|missing']) assert.ok(f.includes(x), `${x} in\n${f.join('\n')}`);
    assert.ok(!f.some((x) => x.includes('|log.dev.')), 'dev keys may stay English');
    assert.ok(rep.reviews.some((r) => r.key === 'log.join' && r.words.includes('присоединился')));
  });

  test('client: params English lacks, option counts, Latin, a client key\'s own allowlist', (t) => {
    if (!L.K) { t.skip('public/i18n is not there yet'); return; }
    const EN = { 'a.x': 'Room {code}: {n} {n|player|players}', 'a.y': '{name} is {ot:offline|online}', 'a.z': 'Hello', 'landing.codePh': 'ABCD', 'cat.health': 'Health' };
    const RU = { 'a.x': 'Комната {code}: {n} игроков, {who}', 'a.y': '{name} {ot:не в сети|в сети|?}', 'a.z': 'Hello', 'landing.codePh': 'ABCD' };
    let cur = 'en';
    const tt = (key, p) => core.formatText(cur, (cur === 'ru' && Object.hasOwn(RU, key) ? RU : EN)[key], p);
    const rep = new Report();
    checkClient(rep, { EN, RU, COMPLETE: false, t: tt, setLang: (l) => { cur = l; } }, L.C);
    const f = found(rep);
    for (const x of ['public/i18n/ru.js|a.x|plural', 'public/i18n/ru.js|a.x|param', 'public/i18n/ru.js|a.y|option', 'public/i18n/ru.js|a.z|latin']) {
      assert.ok(f.includes(x), `${x} in\n${f.join('\n')}`);
    }
    assert.ok(!f.some((x) => x.includes('|landing.codePh|')), 'ABCD is allowed there');
    assert.ok(found(rep, 'missing').some((x) => x.includes('|cat.health|')));
    assert.equal(cur, 'en', 'the language is restored');
  });

  test('glossary across catalogues: special titles in client strings, labels, the airlock word, card quotes', () => {
    const C = { EN: L.C.EN, RU: { ...L.C.RU, specials: { airlock: { title: 'Шлюз', text: '' }, revive: { title: 'Вернулся из леса', text: '' } },
      labels: { health: { label: 'Здоровье', nom: 'здоровье', acc: 'здоровье', gen: 'здоровья', dat: 'здоровью', ins: 'здоровьем', loc: 'здоровье' } } } };
    const K = {
      EN: { 'k.a': 'Play an Airlock', 'k.b': 'Back from the Forest is a card', 'k.c': 'the airlock jams', 'cat.health': 'Health', 'cat.health.gen': 'Health' },
      RU: { 'k.a': 'Сыграй шлюз', 'k.b': 'Карта «Возвращение»', 'k.c': 'заклинило', 'cat.health': 'Здоровье', 'cat.health.gen': 'здоровье' },
    };
    const M = { RU: { 'word.airlock': 'люк', 'fmt.quote': '"{title}"' } };
    const rep = new Report();
    checkGlossary(rep, C, M, K);
    const f = found(rep);
    for (const x of ['public/i18n/ru.js|k.b|glossary', 'public/i18n/ru.js|cat.health.gen|glossary', 'server/i18n/ru.js|word.airlock|glossary',
      'server/i18n/ru.js|fmt.quote|glossary']) assert.ok(f.includes(x), `${x} in\n${f.join('\n')}`);
    assert.ok(!f.some((x) => x.includes('|k.a|') || x.includes('|k.c|') || x.includes('|cat.health|')));
  });
});

describe('the review list keeps QA\'s marks', () => {
  test('write, mark, write again: the marks stay; the gate reads them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-check-'));
    try {
      const result = { reviews: [{ area: 'content', file: 'skills', key: 'a', words: ['сказал'], text: 'Он сказал' }, { area: 'client', file: 'x', key: 'b', words: ['был'], text: 'Ты был' }], samples: ['s\tline'] };
      const [file] = write(result, dir);
      assert.equal(readMarks(file).size, 0);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^\?(\tcontent)/m, 'ok$1').replace(/^\?(\tclient)/m, 'fix$1'));
      write(result, dir);
      const marks = readMarks(file);
      assert.deepEqual([...marks.values()].sort(), ['fix', 'ok']);
      assert.ok(fs.readFileSync(path.join(dir, 'ru-sample.txt'), 'utf8').includes('s\tline'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
