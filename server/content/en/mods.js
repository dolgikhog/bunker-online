// English words for the generated parts of characteristic cards (reports/i18n-design.md §6.4): severity, the {yrs}
// years, phobia intensity, and the Profession and Hobby modifiers.
//
// Today's strings, verbatim. Which card gets which modifier, the weights and the numbers are language-neutral and
// live in ../gen.js; this file only holds words. Templates use the shared formatter's syntax (public/i18n/core.js,
// design §7) with named params:
//   {n}              a number
//   {n|one|other}    the plural word for n (two forms: n === 1 or not)
//   {i:o0|o1|...}    an option by index
// Every wrap template has {base} (the card's own text) and {mod} (the rendered modifier).
export default {
  // The {sev} placeholder of a card: index 0..2 (dealt 40% / 35% / 25%).
  sev: ['mild', 'moderate', 'severe'],
  // The {yrs:a-b} placeholder of a card. {n}: the number of years.
  yrs: '{n} {n|year|years}',

  // Phobia intensity, index 0..3 (a Phobia gets one 55% of the time): "{base} ({mod})".
  phobiaIntensity: ['mild', 'moderate', 'severe', 'panic attacks'],
  phobiaWrap: '{base} ({mod})',

  // Profession experience modifiers by kind (a Profession without its own "(...)" always gets one). Params: {n} the
  // number drawn; for `student` {n} is the year (1..5) and {i} its index (0..4).
  profession: {
    exp: '{n} {n|year|years} of experience', // n 1..30
    intern1: 'intern, first day on the job', // no params
    intern: 'intern, {n} {n|month|months} in', // n 1..11
    retired: 'retired after {n} years', // n 20..42
    student: 'student, {i:1st|2nd|3rd|4th|5th} year', // n 1..5, i = n - 1
    self: 'self-taught, {n} {n|year|years}', // n 1..15
    award: 'award-winning, {n} years of experience', // n 15..35
    revoked: 'license revoked after {n} {n|year|years}', // n 2..20
    fake: 'fake diploma, {n} {n|year|years} of practice', // n 1..10
  },
  professionWrap: '{base} ({mod})',

  // Hobby modifiers by kind (a Hobby without its own "(...)" always gets one). {n}: years.
  hobby: {
    years: '{n} {n|year|years}', // n 1..20
    childhood: 'since childhood', // no params
    started: 'just started', // no params
    semipro: 'semi-professional, {n} {n|year|years}', // n 3..20
    obsessed: 'obsessed, {n} {n|year|years}', // n 1..15
  },
  hobbyWrap: '{base} ({mod})',
};
