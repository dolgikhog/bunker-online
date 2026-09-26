// The shared formatter public/i18n/core.js (SPEC §11 X5.5; reports/i18n-design.md §7): plural tables for both
// languages and for two and three forms, num, list, every placeholder form, and that non-string params pass through
// untouched.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LANGS, normLang, pluralCategory, pluralForm, num, list, format, formatText, placeholders, helpers, parseTemplate,
} from '../public/i18n/core.js';

const NNBSP = ' ';
const MINUS = '−';

describe('core: languages', () => {
  test('LANGS is en and ru, frozen', () => {
    assert.deepEqual([...LANGS], ['en', 'ru']);
    assert.ok(Object.isFrozen(LANGS));
  });
  test('normLang accepts exactly en and ru', () => {
    assert.equal(normLang('en'), 'en');
    assert.equal(normLang('ru'), 'ru');
    for (const x of ['EN', 'Ru', 'ru-RU', 'de', '', ' ru', null, undefined, 1, {}, ['ru'], true]) assert.equal(normLang(x), null, String(x));
  });
});

describe('core: plurals', () => {
  // n -> [ru category, three-form word, two-form word]
  const TABLE = [
    [0, 'many', 'лет', 'years'],
    [1, 'one', 'год', 'year'],
    [2, 'few', 'года', 'years'],
    [4, 'few', 'года', 'years'],
    [5, 'many', 'лет', 'years'],
    [11, 'many', 'лет', 'years'],
    [12, 'many', 'лет', 'years'],
    [14, 'many', 'лет', 'years'],
    [21, 'one', 'год', 'years'],
    [22, 'few', 'года', 'years'],
    [25, 'many', 'лет', 'years'],
    [101, 'one', 'год', 'years'],
    [111, 'many', 'лет', 'years'],
    [112, 'many', 'лет', 'years'],
    [1.5, 'other', 'года', 'years'],
  ];
  for (const [n, cat, three, two] of TABLE) {
    test(`n = ${n}: ru ${cat} (${three}), two forms ${two}`, () => {
      assert.equal(pluralCategory('ru', n), cat);
      assert.equal(pluralForm('ru', n, ['год', 'года', 'лет']), three);
      assert.equal(pluralForm('ru', n, ['year', 'years']), two);
      assert.equal(pluralForm('en', n, ['year', 'years']), two);
      assert.equal(pluralCategory('en', n), n === 1 ? 'one' : 'other');
    });
  }
  test('two forms mean "1 / not 1" in Russian too: 21 hidden kicks carry over', () => {
    assert.equal(pluralForm('ru', 21, ['изгнание переносится', 'изгнания переносятся']), 'изгнания переносятся');
    assert.equal(pluralForm('ru', 1, ['изгнание переносится', 'изгнания переносятся']), 'изгнание переносится');
  });
  test('negative numbers use the absolute value; numeric strings and valueOf objects count as numbers', () => {
    assert.equal(pluralCategory('ru', -21), 'one');
    assert.equal(pluralCategory('ru', -3), 'few');
    assert.equal(pluralForm('ru', '3', ['год', 'года', 'лет']), 'года');
    assert.equal(pluralForm('ru', { valueOf: () => 5 }, ['год', 'года', 'лет']), 'лет');
  });
  test('degenerate form lists', () => {
    assert.equal(pluralForm('ru', 5, []), '');
    assert.equal(pluralForm('ru', 5, ['раз']), 'раз');
    assert.equal(pluralForm('en', 5, undefined), '');
  });
  test('unknown languages follow the English rule', () => {
    assert.equal(pluralCategory('de', 1), 'one');
    assert.equal(pluralCategory('de', 2), 'other');
  });
});

describe('core: num', () => {
  test('en prints String(x), byte for byte what the English strings always printed', () => {
    for (const x of [0, 1, 1.5, 12, 640000, -40, 1e21, NaN, Infinity]) assert.equal(num('en', x), String(x));
  });
  test('ru: decimal comma, real minus, groups from 10 000 up with U+202F', () => {
    assert.equal(num('ru', 1.5), '1,5');
    assert.equal(num('ru', 0), '0');
    assert.equal(num('ru', -0), '0');
    assert.equal(num('ru', -40), `${MINUS}40`);
    assert.equal(num('ru', 9999), '9999');
    assert.equal(num('ru', 10000), `10${NNBSP}000`);
    assert.equal(num('ru', 640000), `640${NNBSP}000`);
    assert.equal(num('ru', 1234567.25), `1${NNBSP}234${NNBSP}567,25`);
    assert.equal(num('ru', -12345.5), `${MINUS}12${NNBSP}345,5`);
  });
  test('non-numbers and non-finite numbers are returned as text', () => {
    assert.equal(num('ru', '12345'), '12345');
    assert.equal(num('ru', NaN), 'NaN');
    assert.equal(num('ru', Infinity), 'Infinity');
  });
});

describe('core: list', () => {
  test("style 'and': en A, B and C / ru А, Б и В", () => {
    assert.equal(list('en', [], 'and'), '');
    assert.equal(list('en', ['A'], 'and'), 'A');
    assert.equal(list('en', ['A', 'B'], 'and'), 'A and B');
    assert.equal(list('en', ['A', 'B', 'C'], 'and'), 'A, B and C');
    assert.equal(list('ru', ['А', 'Б'], 'and'), 'А и Б');
    assert.equal(list('ru', ['А', 'Б', 'В'], 'and'), 'А, Б и В');
  });
  test("default ', ', or any separator", () => {
    assert.equal(list('en', ['A', 'B', 'C']), 'A, B, C');
    assert.equal(list('ru', ['А', 'Б', 'В'], '; '), 'А; Б; В');
    assert.equal(list('ru', [1.5, 2]), '1,5, 2');
  });
  test('non-string items come back as an array with the separators, untouched', () => {
    const a = { t: 'player', id: 'p1', v: 'Anna' };
    const b = { t: 'player', id: 'p2', v: 'Bob' };
    const out = list('en', [a, 'x', b], 'and');
    assert.ok(Array.isArray(out));
    assert.equal(out[0], a);
    assert.deepEqual(out.slice(1, 2), [', x and ']);
    assert.equal(out[2], b);
  });
});

describe('core: templates', () => {
  test('plain text, {name}, numbers through num, strings as they are', () => {
    assert.equal(formatText('en', 'no params'), 'no params');
    assert.equal(formatText('en', '{p} joined', { p: 'Anna' }), 'Anna joined');
    assert.equal(formatText('ru', '{n} мест', { n: 1.5 }), '1,5 мест');
    assert.equal(formatText('en', '{n} m²', { n: 1.5 }), '1.5 m²');
  });
  test('{n|f0|f1} and {n|f0|f1|f2}', () => {
    const en = '{k} {k|player|players} will stay outside';
    assert.equal(formatText('en', en, { k: 1 }), '1 player will stay outside');
    assert.equal(formatText('en', en, { k: 2 }), '2 players will stay outside');
    const ru = 'снаружи {k|останется|останутся|останутся} {k} {k|игрок|игрока|игроков}';
    assert.equal(formatText('ru', ru, { k: 1 }), 'снаружи останется 1 игрок');
    assert.equal(formatText('ru', ru, { k: 3 }), 'снаружи останутся 3 игрока');
    assert.equal(formatText('ru', ru, { k: 5 }), 'снаружи останутся 5 игроков');
    assert.equal(formatText('ru', ru, { k: 21 }), 'снаружи останется 21 игрок');
    assert.equal(formatText('ru', '{n} {n|год|года|лет}', { n: 1.5 }), '1,5 года');
    assert.equal(formatText('en', 'the {k|kick carries|kicks carry} over', { k: 21 }), 'the kicks carry over');
  });
  test('{x:o0|o1|...}: by boolean, by index, empty options', () => {
    const t = 'Round {r} of {max} — reveal phase ({asc:descending|ascending} seat order){first:|. Everyone reveals their Profession}';
    assert.equal(formatText('en', t, { r: 1, max: 7, asc: false, first: true }),
      'Round 1 of 7 — reveal phase (descending seat order). Everyone reveals their Profession');
    assert.equal(formatText('en', t, { r: 2, max: 7, asc: true, first: false }), 'Round 2 of 7 — reveal phase (ascending seat order)');
    const how = '{how:|Nobody voted — fate decides: |Still tied — fate decides: }{p} is ejected';
    assert.equal(formatText('en', how, { how: 0, p: 'A' }), 'A is ejected');
    assert.equal(formatText('en', how, { how: 2, p: 'A' }), 'Still tied — fate decides: A is ejected');
    assert.equal(formatText('en', 'student, {i:1st|2nd|3rd|4th|5th} year', { i: 2 }), 'student, 3rd year');
  });
  test('an option index out of range renders nothing', () => {
    assert.equal(formatText('en', '[{i:a|b}]', { i: 5 }), '[]');
    assert.equal(formatText('en', '[{i:a|b}]', { i: 0.5 }), '[]');
  });
  test('arrays: joined with ", ", or "and" with @and; objects inside go through the hook', () => {
    assert.equal(formatText('en', 'In the bunker: {in}.', { in: ['A', 'B', 'C'] }), 'In the bunker: A, B, C.');
    assert.equal(formatText('en', '{items@and}', { items: ['A', 'B', 'C'] }), 'A, B and C');
    assert.equal(formatText('ru', '{items@and}', { items: ['А', 'Б', 'В'] }), 'А, Б и В');
    const hook = (v, form) => `<${v.n}${form ? '@' + form : ''}>`;
    assert.equal(formatText('en', '{by}', { by: [{ n: 'a' }, { n: 'b' }] }, hook), '<a>, <b>');
    assert.equal(formatText('en', '{by@and}', { by: [{ n: 'a' }, { n: 'b' }] }, hook), '<a> and <b>');
    assert.equal(formatText('en', '{by@acc}', { by: [{ n: 'a' }] }, hook), '<a@acc>');
  });
  test('{name@form}: the hook gets the form; @cap capitalises a string', () => {
    const seen = [];
    const hook = (v, form) => { seen.push(form); return v.id === 'health' ? (form === 'acc' ? 'здоровье' : 'Здоровье') : '?'; };
    assert.equal(formatText('ru', '{p} раскрывает {cat@acc}', { p: 'Анна', cat: { id: 'health' } }, hook), 'Анна раскрывает здоровье');
    assert.equal(formatText('ru', '{cat}', { cat: { id: 'health' } }, hook), 'Здоровье');
    assert.deepEqual(seen, ['acc', undefined]);
    assert.equal(formatText('ru', '🚪 {w@cap} заклинило', { w: 'шлюз' }), '🚪 Шлюз заклинило');
    assert.equal(formatText('en', '{w@acc}', { w: 'plain' }), 'plain');
  });
  test('{{ and }} are literal braces; malformed placeholders stay as written', () => {
    assert.equal(formatText('en', '{{p}} is {p}', { p: 'x' }), '{p} is x');
    assert.equal(formatText('en', 'a } b { c', {}), 'a } b { c');
    assert.equal(formatText('en', '{ p } {} {p@ac c} {p@1}', { p: 'x' }), '{ p } {} {p@ac c} {p@1}');
  });
  test('a missing param renders as {name} (and warns once)', () => {
    assert.equal(formatText('en', 'Hi {who}, {n|a|b}', {}), 'Hi {who}, {n}');
    assert.equal(formatText('en', 'Hi {who}', null), 'Hi {who}');
    assert.equal(formatText('en', 'Hi {who}', { who: null }), 'Hi {who}');
  });
  test('positional params: an array works as params', () => {
    const t = 'Отсидка: {0} {0|год|года|лет} за {1:мошенничество|грабёж|уклонение от налогов}';
    assert.equal(formatText('ru', t, [3, 1]), 'Отсидка: 3 года за грабёж');
    assert.equal(formatText('ru', t, [11, 2]), 'Отсидка: 11 лет за уклонение от налогов');
  });
  test('selectors read Number(value), so a valueOf object is a number there and a hook value elsewhere', () => {
    const yrs = { yrs: 3, valueOf: () => 3 };
    const hook = (v) => `${v.yrs} года`;
    assert.equal(formatText('ru', 'Инфаркт {0} назад ({0|год|года|лет})', [yrs], hook), 'Инфаркт 3 года назад (года)');
    const sev = { sev: 2, valueOf: () => 2 };
    assert.equal(formatText('ru', 'Астма ({0:лёгкая|средняя|тяжёлая} форма)', [sev]), 'Астма (тяжёлая форма)');
  });
  test('a template that is not a string renders nothing', () => {
    assert.deepEqual(format('en', undefined, {}), []);
    assert.equal(formatText('en', null, {}), '');
  });
});

describe('core: format() output (parts)', () => {
  const player = (id, v) => ({ t: 'player', id, v });
  test('non-string params pass through untouched (no hook)', () => {
    const node = { nodeType: 1, tag: 'b' };
    const out = format('en', 'Room {code} by {host}', { code: 'ABCD', host: node });
    assert.deepEqual(out.slice(0, 1), ['Room ABCD by ']);
    assert.equal(out[1], node);
    assert.equal(out.length, 2);
  });
  test('hook results: parts kept as objects, adjacent strings merged, no empty strings, arrays flattened', () => {
    const hook = (v, form) => {
      if (v.p) return player(v.p, v.n);
      if (v.msg) return format('en', v.msg.key, v.msg.params, hook); // a nested message: an array
      if (v.empty) return '';
      return form;
    };
    const out = format('en', '{rp}{a} and {b} swapped{e}: {res}!', {
      rp: 'Round 3 — ', a: { p: 'p1', n: 'Anna' }, b: { p: 'p2', n: 'Bob' }, e: { empty: true },
      res: { msg: { key: '{t} got it', params: { t: { p: 'p3', n: 'Cy' } } } },
    }, hook);
    assert.deepEqual(out, ['Round 3 — ', player('p1', 'Anna'), ' and ', player('p2', 'Bob'), ' swapped: ', player('p3', 'Cy'), ' got it!']);
    for (let i = 1; i < out.length; i++) assert.ok(!(typeof out[i] === 'string' && typeof out[i - 1] === 'string'));
    assert.ok(out.every((x) => x !== ''));
  });
  test('formatText joins parts by their `v`', () => {
    const hook = (v) => ({ t: 'player', id: v.p, v: v.n });
    assert.equal(formatText('en', '{a} and {b}', { a: { p: 'p1', n: 'Anna' }, b: { p: 'p2', n: 'Bob' } }, hook), 'Anna and Bob');
  });
  test('an array of parts with @and keeps the parts', () => {
    const hook = (v) => player(v.p, v.n);
    const out = format('ru', '{by@and}', { by: [{ p: 'a', n: 'А' }, { p: 'b', n: 'Б' }, { p: 'c', n: 'В' }] }, hook);
    assert.deepEqual(out, [player('a', 'А'), ', ', player('b', 'Б'), ' и ', player('c', 'В')]);
  });
});

describe('core: placeholders() and helpers()', () => {
  test('placeholders lists every placeholder with its kind', () => {
    assert.deepEqual(placeholders('{rp}{p} revealed {cat@acc}: {n} {n|year|years}{auto:| (auto)} {{x}}'), [
      { name: 'rp', kind: 'value' },
      { name: 'p', kind: 'value' },
      { name: 'cat', kind: 'value', form: 'acc' },
      { name: 'n', kind: 'value' },
      { name: 'n', kind: 'plural', choices: ['year', 'years'] },
      { name: 'auto', kind: 'option', choices: ['', ' (auto)'] },
    ]);
    assert.deepEqual(placeholders(42), []);
  });
  test('helpers(lang) is the `f` of function values', () => {
    const f = helpers('ru');
    assert.equal(f.lang, 'ru');
    assert.equal(f.num(1.5), '1,5');
    assert.equal(f.pl(21, 'год', 'года', 'лет'), 'год');
    assert.equal(f.pl(3, ['год', 'года', 'лет']), 'года');
    assert.equal(f.pl(1, 'был', 'были'), 'был');
    assert.equal(f.opt(true, 'нет', 'да'), 'да');
    assert.equal(f.opt(9, 'a', 'b'), '');
    assert.equal(f.list(['А', 'Б', 'В'], 'and'), 'А, Б и В');
    assert.equal(f.text('{n} {n|койка|койки|коек}', { n: 5 }), '5 коек');
    assert.deepEqual(helpers('en', (v) => v.n.toUpperCase()).format('{a}!', { a: { n: 'x' } }), ['X!']);
    assert.ok(Object.isFrozen(f));
  });
});

describe('core: parseTemplate() (B2, for the catalogue checker)', () => {
  test('the text around each placeholder, in order, braces unescaped; a fresh copy each call', () => {
    const seq = parseTemplate('{{x}} {n} {n|год|года|лет}{auto:| (авто)}, {cat@acc} {0 }');
    assert.deepEqual(seq, [
      '{x} ', { name: 'n', kind: 'value' }, ' ', { name: 'n', kind: 'plural', choices: ['год', 'года', 'лет'] },
      { name: 'auto', kind: 'option', choices: ['', ' (авто)'] }, ', ', { name: 'cat', kind: 'value', form: 'acc' }, ' {0 }',
    ]);
    seq[1].name = 'changed';
    seq[3].choices.push('x');
    assert.deepEqual(parseTemplate('{{x}} {n} {n|год|года|лет}')[1], { name: 'n', kind: 'value' });
    assert.deepEqual(parseTemplate('{{x}} {n} {n|год|года|лет}')[3].choices, ['год', 'года', 'лет']);
    assert.deepEqual(parseTemplate(null), []);
    assert.deepEqual(parseTemplate(''), []);
  });
});
