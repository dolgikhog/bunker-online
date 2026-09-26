// Russian bunker words. Owner: ru-content-world (reports/i18n-design.md §12).
//
// The same ids and keys as ../en/bunker.js. Only this file changes: a missing English key or a function that needs
// another param goes to i18n-content (content code and ../en/*.js) as a note, never into ../en/*.js or the code.
//
// Binding: the glossary and style guide in reports/i18n-design.md §10 (SPEC §11 X5.6). In short: ты to the player;
// player names never declined; no gendered form about a player; quotes «…», the em dash with spaces, ranges with an en
// dash, the decimal comma, ё everywhere; Russian words for acronyms (УФ, ИИ, …: only °C, 3D, USB and × may stay Latin).
//
// Shape: the keys of ../en/bunker.js:
//   nicknames   the 30 ids; a nominative phrase that sits inside «…» in the name
//   features    the 75 ids; positional templates ({0} is the English entry's {n:a-b}); a nominative phrase each, since
//               the client lists them and the log may name one
//   letters     exactly 15 letters (../gen.js draws an index). Index-aligned with the English 'ABCDEKMNPRSTVXZ' where
//               Russian has the same letter (A→А, B→Б, D→Д, E→Е, K→К, …, V→В, X→Х, Z→З; C→Л), so «Объект 245-К» stays
//               «Object 245-K» when a player switches language
//   name        named params; a bunker name is a nominative phrase, never inflected (§10.3 rule 6); «№ 42» with a
//               no-break space
//   size, duration, food, months(), range()

const MONTH = ['месяц', 'месяца', 'месяцев'];
const YEAR = ['год', 'года', 'лет'];

/**
 * A duration in months, for the stay and food lines. The result is nominative, which for these words is also the
 * accusative, so it follows «на» and «через» and stands alone as a duration.
 * @param {{m: number}} v  whole months, >= 1 (1..5, then multiples of 3 up to 17, then multiples of 6)
 * @param {object} f  public/i18n/core.js helpers(): f.num, f.pl, f.opt, f.list, f.text
 * @returns {string}  «8 месяцев», «1 год», «1,5 года», «1 год 3 месяца», «10 лет»
 */
function months(v, f) {
  const { m } = v;
  if (m < 12) return `${f.num(m)} ${f.pl(m, MONTH)}`;
  const y = Math.floor(m / 12);
  const rest = m % 12;
  if (rest === 0) return `${f.num(y)} ${f.pl(y, YEAR)}`;
  // A half year: «1,5 года», «2,5 года» (a fraction takes the few form, §7).
  if (rest === 6) return `${f.num(y + 0.5)} ${f.pl(y + 0.5, YEAR)}`;
  return `${f.num(y)} ${f.pl(y, YEAR)} ${f.num(rest)} ${f.pl(rest, MONTH)}`;
}

/**
 * A catastrophe's stay range, for the {range} of ./catastrophes.js safe («…через {range}»). One unit for both ends,
 * with the plural agreeing with the upper end, so it reads after «через» (accusative = nominative here) and never needs
 * «от … до» (§10.4, the safe alternative):
 *   both ends whole or half years, from 1 year up: «2–6 лет», «1–3 года», «3–10 лет», «1,5–5 лет»;
 *   otherwise months: «6–24 месяца».
 * @param {{lo: number, hi: number}} v  months, lo < hi (6..120)
 * @param {object} f  as above
 * @returns {string}
 */
function range(v, f) {
  const { lo, hi } = v;
  if (lo >= 12 && lo % 6 === 0 && hi % 6 === 0) {
    return `${f.num(lo / 12)}–${f.num(hi / 12)} ${f.pl(hi / 12, YEAR)}`;
  }
  return `${f.num(lo)}–${f.num(hi)} ${f.pl(hi, MONTH)}`;
}

export const COMPLETE = true;

export default {
  // 30 nicknames, for the "nick" and "object" names: Бункер «Кротовина», Объект 245-К «Кротовина».
  nicknames: {
    'last-hope': 'Последняя надежда',
    'molehill': 'Кротовина',
    'noahs-basement': 'Подвал Ноя',
    'the-ark': 'Ковчег',
    'badgers-den': 'Барсучья нора',
    'deep-burrow': 'Глубинка',
    'iron-turnip': 'Железная репа',
    'quiet-harbor': 'Тихая гавань',
    'cold-storage': 'Холодильник',
    'the-pantry': 'Кладовка',
    'grandpas-cellar': 'Дедушкин погреб',
    'mushroom-palace': 'Грибной дворец',
    'plan-b': 'План Б',
    'doomsday-deluxe': 'Апокалипсис-люкс',
    'sunflower': 'Подсолнух',
    'hibernation': 'Спячка',
    'rabbit-hole': 'Кроличья нора',
    'groundhog': 'Сурок',
    'fort-stubborn': 'Форт Упрямый',
    'new-eden': 'Новый Эдем',
    'lucky-seven': 'Счастливая семёрка',
    'stone-pillow': 'Каменная подушка',
    'the-tin-can': 'Консервная банка',
    'hermitage': 'Эрмитаж',
    'echo': 'Эхо',
    'cocoon': 'Кокон',
    'sleeping-bear': 'Берлога',
    'underground-paradise': 'Подземный рай',
    'safe-haven': 'Укромный уголок',
    'the-nest': 'Гнездо',
  },
  // 74 features, dealt 3 to 5 per bunker, plus `hidden-storeroom` (never dealt; the engine's stand-in).
  features: {
    'medical-bay-with-an-operating': 'Медблок с операционным столом',
    'hydroponic-farm-the-water-pump': 'Гидропонная ферма (водяной насос сломан)',
    'armory-with-rifles-but-no': 'Оружейная: {0} {0|винтовка|винтовки|винтовок} и ни одного патрона',
    'well-with-a-hand-pump-and-clean': 'Колодец с ручным насосом и чистой водой',
    'workshop-with-power-tools': 'Мастерская с электроинструментом',
    'library-of-books-mostly-romance': 'Библиотека: {0} {0|книга|книги|книг}, в основном любовные романы',
    'radio-room-it-can-receive-but': 'Радиорубка (принимает, но не передаёт)',
    'greenhouse-with-grow-lamps': 'Теплица с фитолампами',
    'diesel-generator-fuel-for-months': 'Дизельный генератор (топлива на {0} {0|месяц|месяца|месяцев})',
    'solar-panels-on-a-hidden-mast': 'Солнечные панели на замаскированной мачте',
    'chicken-coop-with-hens-and-a': 'Курятник: {0} {0|несушка|несушки|несушек} и петух',
    'rabbit-hutch-they-are': 'Крольчатник (кролики плодятся с пугающей скоростью)',
    'mushroom-cellar': 'Грибной погреб',
    'water-purification-station': 'Станция очистки воды',
    'gym-with-a-single-treadmill': 'Спортзал с единственной беговой дорожкой',
    'sauna': 'Сауна',
    'home-cinema-with-dvds': 'Домашний кинотеатр: {0} {0|диск|диска|дисков} с фильмами',
    'childrens-playroom-full-of-toys': 'Детская комната, заваленная игрушками',
    'small-chapel': 'Маленькая часовня',
    'bar-with-a-well-stocked-wine': 'Бар с богатым винным погребом',
    'laboratory-with-a-microscope-and': 'Лаборатория с микроскопом и реактивами',
    'pharmacy-cabinet-everything-in': 'Аптечный шкаф (всё в нём давно просрочено)',
    'dentists-chair-and-tools-no': 'Стоматологическое кресло и инструменты (стоматолог в комплект не входит)',
    'maternity-room-with-an-incubator': 'Родильная палата с инкубатором для новорождённых',
    'seed-vault-with-plant-varieties': 'Семенное хранилище: {0} {0|сорт|сорта|сортов} растений',
    'fish-farm-tank-with-tilapia': 'Рыбоводный бассейн с тилапией',
    'air-filtration-system-spare': 'Система фильтрации воздуха (запасных фильтров на {0} {0|месяц|месяца|месяцев})',
    'periscope-camera-for-watching': 'Камера-перископ для наблюдения за поверхностью',
    'decontamination-airlock-with': 'Камера дезактивации с душевыми',
    'emergency-exit-through-the-old': 'Запасной выход через старые канализационные тоннели',
    'blast-door-that-jams-now-and': 'Гермодверь, которую время от времени заклинивает',
    'only-one-toilet': 'Всего один туалет',
    'the-dormitory-ceiling-leaks': 'В спальне протекает потолок',
    'rats-in-the-storage-room': 'Крысы на складе',
    'the-previous-owners-diary-with': 'Дневник прежнего владельца, половина страниц вырвана',
    'a-locked-door-nobody-has-the-key': 'Запертая дверь, ключа от которой нет ни у кого',
    'walls-so-thin-you-can-hear': 'Стены такие тонкие, что слышно всё',
    'server-room-with-an-offline-copy': 'Серверная с офлайн-копией интернета',
    'garage-with-an-all-terrain': 'Гараж с вездеходом (бак пустой)',
    'swimming-pool-empty': 'Бассейн (без воды)',
    'kitchen-with-a-wood-fired-oven': 'Кухня с дровяной печью',
    'small-brewery': 'Мини-пивоварня',
    'isolation-cell-that-locks-from': 'Изолятор, который запирается снаружи',
    'weather-station-on-the-surface': 'Метеостанция на поверхности',
    'satellite-dish-needs-repair': 'Спутниковая тарелка (требует ремонта)',
    'camera-drone-with-batteries': 'Дрон с камерой и {0} {0|аккумулятор|аккумулятора|аккумуляторов} к нему',
    'out-of-tune-piano': 'Расстроенное пианино',
    'kg-of-salt-in-the-pantry': '{0} кг соли в кладовой',
    'karaoke-machine-that-cannot-be': 'Караоке, которое невозможно выключить',
    'tunnel-to-a-neighboring-bunker': 'Туннель в соседний бункер (там кто-то живёт)',
    'geothermal-heating': 'Геотермальное отопление',
    'laundry-room-with-a-hand-cranked': 'Прачечная со стиральной машиной на ручном приводе',
    'barbers-chair-and-scissors': 'Парикмахерское кресло и ножницы',
    'classroom-with-school-textbooks': 'Школьный класс с учебниками',
    'wind-turbine-on-the-surface': 'Ветрогенератор на поверхности',
    'forge-and-anvil': 'Кузница с наковальней',
    'sewing-room-with-bolts-of-fabric': 'Швейная мастерская с рулонами ткани',
    'stable-with-two-goats-one-of': 'Хлев с двумя козами (одна из них беременна)',
    'beehive-in-the-greenhouse': 'Улей в теплице',
    'radiation-suits': '{0} {0|костюм|костюма|костюмов} радиационной защиты',
    'morgue-cold-and-empty-for-now': 'Морг (холодный и пока пустой)',
    'terrarium-of-venomous-snakes': 'Террариум с ядовитыми змеями, от которых никак не избавиться',
    'wall-map-of-the-region-with': 'Настенная карта района, на которой отмечены тайники с припасами',
    'computer-with-a-chess-program': 'Компьютер с шахматной программой — и больше ничего',
    'bunker-ai-that-runs-the-systems': 'ИИ бункера, который управляет всеми системами (и слегка язвит)',
    'hidden-stash-of-bottles-of-vodka': 'Заначка: {0} {0|бутылка|бутылки|бутылок} водки',
    'weevils-in-the-flour-stores': 'Долгоносики в запасах муки',
    'micro-nuclear-reactor-the-manual': 'Ядерный микрореактор (инструкции нет)',
    'aquarium-with-ornamental-fish': 'Аквариум с декоративными рыбками',
    'private-suite-with-a-king-size': 'Личный люкс с огромной кроватью (кому он достанется?)',
    'security-cameras-in-every-room': 'Камеры наблюдения в каждой комнате',
    'emergency-radio-beacon-it-might': 'Аварийный радиомаяк (может привлечь не тех людей)',
    'art-studio': 'Художественная мастерская',
    '3d-printer-with-one-spool-of': '3D-принтер и последняя катушка пластика',
    'hidden-storeroom': 'Потайная кладовая',
  },
  // «Объект {n}-{letter}»: 15 letters, index-aligned with English (see the header).
  letters: 'АБЛДЕКМНПРСТВХЗ',
  // {nick}: a nickname above; {n}: a number (shelter 2..99, object 10..999); {letter}: a letter above.
  name: {
    nick: 'Бункер «{nick}»',
    shelter: 'Убежище № {n}',
    object: 'Объект {n}-{letter} «{nick}»',
    fallback: 'Бункер',
  },
  // {n}: square meters, 60..300.
  size: '{n} м²',
  // {months}: months() above. The client shows them as «… · 120 м² · Сидеть под землёй 2 года · Еды на 1 год».
  duration: 'Сидеть под землёй {months}',
  food: 'Еды на {months}',
  months,
  range,
};
