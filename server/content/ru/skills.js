// Russian Extra skill cards. Owner: ru-content-people (reports/i18n-design.md §12); checkpoint B1 stub.
//
// Fill `default` with the same ids and keys as ../en/skills.js, and set COMPLETE = true once every entry is translated
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
// Shape: { '<id>': 'template', … }, the 80 ids of ../en/skills.js (the order here does not matter).
// Skills avoid the past tense about their owner: "Survived a plane crash" -> «За плечами — авиакатастрофа»; "Former
// prisoner (…)" -> «Отсидка: …».
export const COMPLETE = true;

// About the card's owner only in the present (or the perfective future: «Соберёт», «Подделает»), in nouns («Сектантское
// прошлое», «Олимпийское прошлое: плавание») or impersonally («Однажды пришлось…»): no past tense, no «бывший», no
// «сам/сама», no short participles, no «его/её» pointing back at the owner.
export default {
  'speaks-languages': 'Говорит на {0} {0|языке|языках|языках}',
  'knows-first-aid': 'Умеет оказывать первую помощь',
  'has-delivered-a-baby-in-a-taxi': 'Однажды пришлось принимать роды (в такси)',
  'knows-sign-language': 'Знает язык жестов',
  'former-prisoner-years-for': 'Отсидка: {0} {0|год|года|лет} за {1:мошенничество|грабёж|уклонение от налогов|контрабанду|то, о чём не любит говорить}',
  'can-pick-any-lock-in-under-a': 'Вскрывает любой замок меньше чем за минуту',
  'black-belt-in': 'Чёрный пояс по {0:дзюдо|карате|тхэквондо}',
  'can-repair-any-engine': 'Починит любой двигатель',
  'knows-which-wild-plants-are': 'Знает, какие дикие растения съедобны',
  'can-start-a-fire-without-matches': 'Разводит костёр без спичек',
  'photographic-memory': 'Фотографическая память',
  'former-olympic': 'Олимпийское прошлое: {0:плавание|гребля|биатлон|тяжёлая атлетика}',
  'can-hypnotize-people-sometimes': 'Гипнотизирует людей (иногда получается)',
  'can-build-a-wind-turbine-from': 'Соберёт ветряк из металлолома',
  'can-stitch-wounds': 'Умеет зашивать раны',
  'plays-any-instrument-by-ear': 'Играет по слуху на любом инструменте',
  'knows-morse-code': 'Знает азбуку Морзе',
  'can-drive-anything-with-wheels': 'Водит всё, что на колёсах или гусеницах',
  'can-distill-alcohol-from-almost': 'Гонит самогон почти из чего угодно',
  'can-cook-a-decent-meal-from': 'Приготовит приличный обед из трёх продуктов',
  'survived-a-plane-crash': 'За плечами — авиакатастрофа',
  'knows-how-to-purify-water': 'Умеет очищать воду',
  'can-make-soap-and-candles': 'Варит мыло и делает свечи',
  'knows-the-engineer-who-built': 'Лично знает инженера, строившего этот бункер',
  'knows-where-an-abandoned-army': 'Знает, где найти заброшенный армейский склад',
  'can-tell-when-someone-is-lying': 'Видит, когда врут (обычно)',
  'can-sleep-anywhere-anytime': 'Спит где угодно и когда угодно',
  'can-go-without-food-for-days': 'Может не есть {0} {0|день|дня|дней} подряд',
  'perfect-pitch': 'Абсолютный слух',
  'cheats-at-cards-and-never-gets': 'Мухлюет в картах и никогда не попадается',
  'was-a-millionaire-until-last': 'Ещё неделю назад — миллионы на счету',
  'has-million-followers-online': 'В соцсетях {0} {0|миллион|миллиона|миллионов} подписчиков',
  'knows-jokes-by-heart': 'Знает наизусть {0} {0|анекдот|анекдота|анекдотов}',
  'can-cut-hair': 'Умеет стричь',
  'can-navigate-by-the-stars': 'Ориентируется по звёздам',
  'former-cult-member': 'Сектантское прошлое',
  'has-a-hidden-stash-of-supplies': 'Тайник с припасами в {0} км отсюда',
  'can-raise-chickens-and-rabbits': 'Разводит кур и кроликов',
  'can-milk-a-cow-and-make-cheese': 'Умеет доить корову и делать сыр',
  'built-a-house-with-their-own': 'За плечами — дом, построенный своими руками',
  'former-spy-or-so-they-claim': 'Шпионское прошлое (если верить на слово)',
  'learned-karate-from-online': 'Карате по роликам из интернета',
  'can-calm-any-animal-down': 'Успокоит любое животное',
  'brilliant-negotiator': 'Блестяще ведёт переговоры',
  'can-juggle-knives': 'Жонглирует {0} {0|ножом|ножами|ножами}',
  'can-train-dogs': 'Дрессирует собак',
  'taught-children-to-read': 'Учит детей читать: на счету уже {0} {0|ученик|ученика|учеников}',
  'survived-weeks-alone-in-the': 'Опыт выживания: {0} {0|неделя|недели|недель} в лесу в одиночку',
  'volunteer-rescuer': 'Волонтёр-спасатель (стаж {0})',
  'can-reprogram-any': 'Перепрограммирует любой микроконтроллер',
  'plays-chess-blindfolded': 'Играет в шахматы вслепую',
  'can-find-water-with-a-dowsing': 'Находит воду с помощью лозы (якобы)',
  'knows-cpr': 'Владеет сердечно-лёгочной реанимацией',
  'can-set-broken-bones': 'Умеет вправлять кости',
  'can-grow-penicillin-mold-and': 'Выращивает пенициллиновую плесень (и надеется, что сработает)',
  'needs-only-hours-of-sleep': 'Высыпается за {0} {0|час|часа|часов}',
  'former-hostage-negotiator': 'Опыт переговоров об освобождении заложников',
  'can-forge-any-signature-or': 'Подделает любую подпись и любой документ',
  'can-build-a-radio-out-of-junk': 'Соберёт радиоприёмник из хлама',
  'can-butcher-and-preserve-meat': 'Разделывает и заготавливает мясо',
  'can-tan-leather-and-sew-clothes': 'Выделывает кожу и шьёт одежду',
  'has-read-everything-about': 'Знает экстренную хирургию по книгам (практики — ноль)',
  'can-recite-the-periodic-table': 'Знает таблицу Менделеева наизусть',
  'former-professional-poker-player': 'Покер — бывшая профессия',
  'has-a-pilots-license-for-small': 'Лицензия пилота малой авиации',
  'can-weld-and-forge-metal': 'Умеет сваривать и ковать металл',
  'knows-how-to-brew-beer': 'Умеет варить пиво',
  'knows-how-to-make-gunpowder': 'Знает, как сделать порох',
  'can-make-anyone-laugh-in-any': 'Рассмешит кого угодно в любой ситуации',
  'knows-how-to-chair-a-meeting-and': 'Умеет вести собрание и подсчитывать голоса',
  'regional-debate-champion': 'Первое место на областных дебатах',
  'reads-tarot-cards-and-people': 'Гадает на картах таро — и люди верят',
  'can-make-clothes-out-of-anything': 'Сошьёт одежду из чего угодно',
  'knows-traditional-herbal': 'Разбирается в лечебных травах',
  'plays-the-harmonica-loudly': 'Играет на губной гармошке — громко',
  'can-identify-birds-by-their-song': 'Различает по пению {0} {0|вид|вида|видов} птиц',
  'parachute-instructor-jumps': 'Инструктор по парашютному спорту ({0} {0|прыжок|прыжка|прыжков})',
  'former-child-actor-still-gets': 'В детстве — звезда кино (до сих пор узнают на улице)',
  'knows-how-to-keep-bees': 'Разбирается в пчеловодстве',
  'can-hold-their-breath-for': 'Задерживает дыхание на {0} {0|минуту|минуты|минут}',
};
