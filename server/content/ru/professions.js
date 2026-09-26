// Russian Profession cards. Owner: ru-content-people (reports/i18n-design.md §12); checkpoint B1 stub.
//
// Fill `default` with the same ids and keys as ../en/professions.js, and set COMPLETE = true once every entry is translated
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
// Shape: { '<id>': 'template', … }, the 147 ids of ../en/professions.js (the order here does not matter).
// Professions use the common-gender noun (врач, хирург, пилот, повар, инженер). Where Russian has only gendered forms,
// name the field, or both whole nouns: «Медсестра / медбрат» (the one slash form allowed). The experience modifier
// («стаж 12 лет», «на пенсии после 30 лет работы») is added from ./mods.js, not here: an entry that has its own "(…)"
// in English gets none. The two entries with a number: 'unemployed-years-without-a-job' ({0}: years) and
// 'homemaker-raised-children' ({0}: children, 2..6; e.g. «на руках {0} {0|ребёнок|ребёнка|детей}» — not «вырастил»).
export const COMPLETE = true;

// Common-gender job titles throughout (the official title, which Russian uses for anyone). Where the everyday word is
// only one gender, both whole nouns (Медсестра / медбрат, Акушерка / акушер, Портной / портниха, Актёр / актриса,
// Оперный певец / певица), or a phrase built on a common-gender noun (Игрок футбольного клуба, Экстрасенс). Each entry
// is a nominative phrase: ./mods.js appends « (стаж 12 лет)» and the like.
export default {
  // medicine
  'surgeon': 'Хирург',
  'general-practitioner': 'Терапевт',
  'paramedic': 'Фельдшер скорой помощи',
  'nurse': 'Медсестра / медбрат',
  'midwife': 'Акушерка / акушер',
  'dentist': 'Стоматолог',
  'pediatrician': 'Педиатр',
  'psychiatrist': 'Психиатр',
  'anesthesiologist': 'Анестезиолог',
  'pharmacist': 'Фармацевт',
  'veterinarian': 'Ветеринар',
  'epidemiologist': 'Эпидемиолог',
  'virologist': 'Вирусолог',
  'plastic-surgeon': 'Пластический хирург',
  'forensic-pathologist': 'Судмедэксперт',
  'massage-therapist': 'Массажист',
  'psychologist': 'Психолог',
  // food
  'farmer': 'Фермер',
  'agronomist': 'Агроном',
  'beekeeper': 'Пчеловод',
  'fisherman': 'Рыбак',
  'hunter': 'Охотник-промысловик',
  'butcher': 'Мясник',
  'chef': 'Шеф-повар',
  'pastry-chef': 'Кондитер',
  'baker': 'Пекарь',
  'brewer': 'Пивовар',
  'sommelier': 'Сомелье',
  'fast-food-cook': 'Повар в фастфуде',
  'food-critic': 'Ресторанный критик',
  'chocolate-factory-taste-tester': 'Дегустатор на шоколадной фабрике',
  // trades
  'electrician': 'Электрик',
  'plumber': 'Сантехник',
  'welder': 'Сварщик',
  'carpenter': 'Плотник',
  'car-mechanic': 'Автомеханик',
  'locksmith': 'Мастер по замкам',
  'bricklayer': 'Каменщик',
  'blacksmith': 'Кузнец',
  'tailor': 'Портной / портниха',
  'shoemaker': 'Сапожник',
  'ventilation-engineer': 'Инженер по вентиляции',
  'elevator-repair-technician': 'Мастер по ремонту лифтов',
  'sewer-maintenance-worker': 'Слесарь канализационных сетей',
  'pest-control-specialist': 'Специалист по борьбе с вредителями',
  // science and engineering
  'civil-engineer': 'Инженер-строитель',
  'mining-engineer': 'Горный инженер',
  'nuclear-physicist': 'Физик-ядерщик',
  'chemist': 'Химик',
  'microbiologist': 'Микробиолог',
  'botanist': 'Ботаник',
  'geologist': 'Геолог',
  'meteorologist': 'Метеоролог',
  'astronomer': 'Астроном',
  'hydrologist': 'Гидролог',
  'software-developer': 'Программист',
  'robotics-engineer': 'Инженер-робототехник',
  'radio-engineer': 'Радиоинженер',
  'network-administrator': 'Сетевой администратор',
  'mathematician': 'Математик',
  'architect': 'Архитектор',
  'nuclear-power-plant-operator': 'Оператор АЭС',
  'water-treatment-operator': 'Оператор очистных сооружений',
  'geneticist': 'Генетик',
  // security and rescue
  'infantry-soldier': 'Пехотинец',
  'army-sapper': 'Армейский сапёр',
  'firefighter': 'Пожарный',
  'police-officer': 'Полицейский',
  'security-guard': 'Охранник',
  'bodyguard': 'Телохранитель',
  'special-forces-operative': 'Боец спецназа',
  'lifeguard': 'Спасатель на пляже',
  'mountain-rescuer': 'Горный спасатель',
  'prison-guard': 'Тюремный надзиратель',
  'private-detective': 'Частный детектив',
  // transport
  'airline-pilot': 'Пилот авиалайнера',
  'truck-driver': 'Дальнобойщик',
  'train-driver': 'Машинист поезда',
  'ships-captain': 'Капитан корабля',
  'submarine-sailor': 'Подводник',
  'taxi-driver': 'Таксист',
  'courier': 'Курьер',
  'astronaut': 'Космонавт',
  'air-traffic-controller': 'Авиадиспетчер',
  'ice-cream-truck-driver': 'Водитель фургона с мороженым',
  // education and humanities
  'primary-school-teacher': 'Учитель начальных классов',
  'kindergarten-teacher': 'Воспитатель детского сада',
  'philosophy-lecturer': 'Преподаватель философии',
  'historian': 'Историк',
  'librarian': 'Библиотекарь',
  'archaeologist': 'Археолог',
  'linguist': 'Лингвист',
  'translator': 'Переводчик',
  'journalist': 'Журналист',
  'nanny': 'Няня',
  'social-worker': 'Социальный работник',
  // business and law
  'lawyer': 'Адвокат',
  'judge': 'Судья',
  'accountant': 'Бухгалтер',
  'bank-manager': 'Менеджер банка',
  'tax-inspector': 'Налоговый инспектор',
  'real-estate-agent': 'Риелтор',
  'stockbroker': 'Биржевой брокер',
  'crypto-trader': 'Криптотрейдер',
  'car-salesman': 'Продавец автомобилей',
  'marketing-manager': 'Маркетолог',
  'hr-manager': 'Менеджер по персоналу',
  'insurance-agent': 'Страховой агент',
  'city-councillor': 'Депутат горсовета',
  'diplomat': 'Дипломат',
  // arts, sports and entertainment
  'actor': 'Актёр / актриса',
  'opera-singer': 'Оперный певец / певица',
  'stand-up-comedian': 'Стендап-комик',
  'clown': 'Клоун',
  'stage-magician': 'Иллюзионист',
  'circus-acrobat': 'Цирковой акробат',
  'tattoo-artist': 'Тату-мастер',
  'hairdresser': 'Парикмахер',
  'fashion-designer': 'Дизайнер одежды',
  'florist': 'Флорист',
  'sculptor': 'Скульптор',
  'photographer': 'Фотограф',
  'film-director': 'Кинорежиссёр',
  'dj': 'Диджей',
  'street-musician': 'Уличный музыкант',
  'influencer': 'Блогер',
  'professional-gamer': 'Профессиональный геймер',
  'wedding-planner': 'Организатор свадеб',
  'fitness-trainer': 'Фитнес-тренер',
  'football-player': 'Игрок футбольного клуба',
  'professional-chess-player': 'Профессиональный игрок в шахматы',
  'stuntman': 'Каскадёр',
  'fashion-model': 'Модель',
  'tour-guide': 'Экскурсовод',
  // everything else
  'priest': 'Священнослужитель',
  'undertaker': 'Похоронный агент',
  'fortune-teller': 'Экстрасенс',
  'zookeeper': 'Смотритель зоопарка',
  'dog-trainer': 'Кинолог',
  'forest-ranger': 'Лесник',
  'janitor': 'Дворник',
  'barista': 'Бариста',
  'life-coach': 'Лайф-коуч',
  'lighthouse-keeper': 'Смотритель маяка',
  'postman': 'Почтальон',
  // {0}: years, 2..12. No modifier: the English entry has its own "(…)".
  'unemployed-years-without-a-job': 'Без работы (уже {0} {0|год|года|лет})',
  // {0}: children, 2..6. The option selector indexes by the number itself (index 0 and 1 are never drawn), as in
  // ./biology.js: «двое детей» reads better than «2 ребёнка». «За плечами» = raised, with no past tense.
  'homemaker-raised-children': 'Домашнее хозяйство (за плечами {0:||двое|трое|четверо|пятеро|шестеро} детей)',
};
