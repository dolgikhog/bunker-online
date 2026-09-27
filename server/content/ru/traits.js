// Russian Personality cards. Owner: ru-content-people (reports/i18n-design.md §12); checkpoint B1 stub.
//
// Fill `default` with the same ids and keys as ../en/traits.js, and set COMPLETE = true once every entry is translated
// and `npm run i18n:check` is clean. Until then every missing id or key falls back to English (and the Latin-letter
// check reports it). Only this file changes: a missing English key or a function that needs another param goes to
// i18n-content (content code and ../en/*.js) as a note, never into ../en/*.js or the code.
//
// Binding: the glossary and style guide in reports/i18n-design.md §10 (SPEC §11 X5.6). In short: ты to the player;
// player names never declined; no gendered form about a player or about a card's owner (a card can be revealed before
// Biology and swapped by Body Swap), so nouns, the present tense, no past tense or short participles, and never a
// bracketed «(а)» form; quotes «…», the em dash with spaces, ranges with an en dash, the decimal comma, ё everywhere;
// Russian words for acronyms (УФ, ИИ, ВИЧ, …: only °C, 3D, USB and × may stay Latin).
//
// Positional template syntax (design §6.3). The English entry's placeholders, counted left to right from 0, are the
// params ({n:a-b} a number, {yrs:a-b} a number of years, {sev} a severity index 0..2, {x|y|z} an option index):
//   {0}               prints param 0: the number for {n:a-b}; «3 года» for {yrs:a-b} (./mods.js yrs); the default
//                     severity phrase for {sev} (./mods.js sev). Not allowed for an {x|y|z} option.
//   {0|год|года|лет}  the plural word for numeric param 0, one|few|many, right after the printed number: «{0} {0|год|
//                     года|лет}». After «до», «от», «после», «около» the forms are genitive: «после {0} {0|года|лет|лет}».
//   {1:а|б|в}         the option for an {x|y|z} param (as many options as English has) or a {sev} param (exactly 3,
//                     so the adjective can agree with its noun: {0:лёгкая|средняя|тяжёлая}).
//   {{ and }}         literal braces.
// A template may reorder or leave out params, never invent one. Where a template cannot do it, a value may be a
// function (v, f) => string: v is the array of the English placeholders' values in order (numbers; the option or
// severity index), f the helpers of public/i18n/core.js helpers(): f.num(x), f.pl(n, 'год', 'года', 'лет'),
// f.opt(i, ...options), f.list(items, style), f.text(template, params).
// Example: EN 'Former prisoner ({n:2-15} years for {fraud|robbery|tax evasion|smuggling|something they refuse to talk
// about})' -> RU 'Отсидка: {0} {0|год|года|лет} за {1:мошенничество|грабёж|уклонение от налогов|контрабанду|то, о чём
// не любит говорить}'.
//
// Shape: { '<id>': 'template', … }, the 80 ids of ../en/traits.js (the order here does not matter).
// Traits are nouns of quality or present-tense phrases: Hot-tempered -> «Вспыльчивость», Coward -> «Трусость», Always
// late -> «Вечно опаздывает», Lone wolf -> «Одиночка», Life of the party -> «Душа компании».
export const COMPLETE = true;

// Nouns of quality («Вспыльчивость»), common-gender nouns («Обжора», «Неряха», «Всезнайка», «Одиночка») or the present
// tense («Вечно опаздывает»). Never an adjective: «честный/честная» would have to guess the owner's gender.
export default {
  'honest-to-a-fault': 'Честность — даже во вред себе',
  'hot-tempered': 'Вспыльчивость',
  'born-leader': 'Прирождённый лидер',
  'coward': 'Трусость',
  'incurable-optimist': 'Неисправимый оптимизм',
  'pathological-liar': 'Врёт как дышит',
  'kind-hearted': 'Доброе сердце',
  'lazy': 'Лень',
  'paranoid': 'Паранойя',
  'workaholic': 'Трудоголизм',
  'gloomy-pessimist': 'Мрачный пессимизм',
  'charismatic': 'Харизма',
  'stubborn-as-a-mule': 'Ослиное упрямство',
  'know-it-all': 'Всезнайка',
  'calm-under-pressure': 'Хладнокровие в любой передряге',
  'greedy': 'Жадность',
  'generous': 'Щедрость',
  'jealous': 'Ревность',
  'hypocrite': 'Лицемерие',
  'natural-diplomat': 'Дипломатичность от природы',
  'introvert': 'Интроверт',
  'life-of-the-party': 'Душа компании',
  'perfectionist': 'Перфекционизм',
  'clumsy': 'Неуклюжесть',
  'forgetful': 'Забывчивость',
  'gossip': 'Любит посплетничать',
  'fiercely-loyal': 'Беззаветная преданность',
  'manipulative': 'Манипулирует людьми',
  'brave': 'Храбрость',
  'reckless': 'Безрассудство',
  'overly-cautious': 'Излишняя осторожность',
  'always-cheerful': 'Всегда в хорошем настроении',
  'grumpy': 'Ворчливость',
  'sarcastic': 'Сарказм',
  'naive': 'Наивность',
  'cynical': 'Цинизм',
  'religious-zealot': 'Религиозный фанатизм',
  'neat-freak': 'Одержимость чистотой',
  'slob': 'Неряха',
  'hoarder': 'Никогда ничего не выбрасывает',
  'glutton': 'Обжора',
  'ascetic': 'Аскетизм',
  'hopeless-romantic': 'Верит в любовь с первого взгляда',
  'incorrigible-flirt': 'Флиртует со всеми подряд',
  'sore-loser': 'Не умеет проигрывать',
  'ultra-competitive': 'Соревнуется во всём',
  'team-player': 'Командный дух',
  'lone-wolf': 'Одиночка',
  'holds-grudges-forever': 'Помнит обиды вечно',
  'forgives-everything': 'Прощает всё',
  'deeply-empathetic': 'Глубокая эмпатия',
  'cold-and-calculating': 'Холодный расчёт',
  'turns-everything-into-a-drama': 'Из всего устраивает драму',
  'impulsive': 'Импульсивность',
  'endlessly-patient': 'Бесконечное терпение',
  'endlessly-curious': 'Неуёмное любопытство',
  'superstitious': 'Суеверность',
  'believes-every-conspiracy-theory': 'Верит во все теории заговора',
  'show-off': 'Любит покрасоваться',
  'modest': 'Скромность',
  'bossy': 'Любит командовать',
  'does-whatever-they-are-told': 'Делает всё, что скажут',
  'rebel': 'Бунтарский дух',
  'anxious': 'Тревожность',
  'chatterbox': 'Болтливость',
  'speaks-only-when-necessary': 'Говорит только по делу',
  'night-owl': 'Сова',
  'early-bird': 'Жаворонок',
  'kleptomaniac': 'Клептомания',
  'easily-offended': 'Обидчивость',
  'thick-skinned': 'Толстокожесть',
  'peacemaker': 'Всех мирит',
  'sneaky': 'Пронырливость',
  'tells-long-boring-stories': 'Рассказывает длинные скучные истории',
  'always-late': 'Вечно опаздывает',
  'hero-complex': 'Комплекс героя',
  'strict-pacifist': 'Пацифизм без исключений',
  'tactless': 'Бестактность',
  'exceedingly-polite': 'Чрезмерная вежливость',
  'complains-constantly': 'Постоянно жалуется',
};
