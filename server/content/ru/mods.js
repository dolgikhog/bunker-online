// Russian words for the generated parts of cards (severity, years, modifiers). Owner: ru-content-body
// (reports/i18n-design.md §12).
//
// The same keys as ../en/mods.js. Binding: the glossary and style guide in reports/i18n-design.md §10 (SPEC §11 X5.6).
// These templates use named params (public/i18n/core.js syntax, design §7): {n} the number (ranges in ../en/mods.js);
// for `student` {n} is the year 1..5 and {i} its index 0..4; every wrap has {base} (the card's own text) and {mod}.
// A printed number takes a three-form plural right after it ({n} {n|год|года|лет}); after «после» the genitive
// ({n|года|лет|лет}: «после 21 года», «после 22 лет»).
//
// Nothing here may agree with the owner's gender (§6.4, §10.3): «студент», «стажёр», «лишён лицензии», «лауреат»,
// «увлечён» are gendered, so the modifiers describe the career or the hobby instead (a noun, an adverb, the present
// tense, or an impersonal plural such as «лицензию отозвали»). The severity and intensity phrases stand on their own in
// brackets, so they fit any noun: «Астма (лёгкая форма)», «Сколиоз (средней тяжести)», «Арахнофобия: боязнь пауков
// (до панических атак)».
export const COMPLETE = true;

export default {
  // A card's {sev} printed as {0}: index 0..2 (mild, moderate, severe).
  sev: ['лёгкая форма', 'средней тяжести', 'тяжёлая форма'],
  // A card's {yrs:a-b} printed as {0}: «1 год», «3 года», «5 лет».
  yrs: '{n} {n|год|года|лет}',

  // Phobia intensity, index 0..3: «{base} ({mod})».
  phobiaIntensity: ['в лёгкой форме', 'в умеренной форме', 'в тяжёлой форме', 'до панических атак'],
  phobiaWrap: '{base} ({mod})',

  // Profession modifiers by kind: «Хирург (стаж 12 лет)».
  profession: {
    exp: 'стаж {n} {n|год|года|лет}', // n 1..30
    intern1: 'стажировка, первый день', // no params
    intern: 'стажировка, {n} {n|месяц|месяца|месяцев}', // n 1..11
    retired: 'на пенсии после {n} {n|года|лет|лет} работы', // n 20..42
    student: 'учится на {i:первом|втором|третьем|четвёртом|пятом} курсе', // n 1..5, i = n - 1
    self: 'самоучка, {n} {n|год|года|лет} опыта', // n 1..15
    award: 'с наградами, стаж {n} {n|год|года|лет}', // n 15..35
    revoked: 'лицензию отозвали после {n} {n|года|лет|лет} практики', // n 2..20
    fake: 'липовый диплом, {n} {n|год|года|лет} практики', // n 1..10
  },
  professionWrap: '{base} ({mod})',

  // Hobby modifiers by kind: «Рыбалка (5 лет)». {n}: years.
  hobby: {
    years: '{n} {n|год|года|лет}', // n 1..20
    childhood: 'с детства', // no params
    started: 'только начинает', // no params
    semipro: 'почти профессионально, {n} {n|год|года|лет}', // n 3..20
    obsessed: 'одержимость, {n} {n|год|года|лет}', // n 1..15
  },
  hobbyWrap: '{base} ({mod})',
};
