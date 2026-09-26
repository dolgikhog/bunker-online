// Russian category labels and their case forms. Owner: ru-rules (reports/i18n-design.md §12); checkpoint B1 stub.
//
// Fill `default` with the same ids and keys as ../en/labels.js, and set COMPLETE = true once every entry is translated
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
// Shape: { <category id>: { label, nom, acc, gen, dat, ins, loc } } for the 8 ids of ../en/labels.js:
//   label       the capitalised label for chips and headings: «Профессия»
//   nom … loc   lower-case forms for running text: nominative «профессия», accusative «профессию» («раскрывает
//               профессию»), genitive «профессии», dative, instrumental, prepositional
// Glossary (§10.1): Профессия / Биология / Здоровье / Хобби / Фобия / Навык / Характер / Багаж; acc профессию, биологию,
// здоровье, хобби, фобию, навык, характер, багаж; gen профессии, биологии, здоровья, хобби, фобии, навыка, характера,
// багажа. A missing form falls back to nom, and a missing nom to label. The client's cat.<id>, .acc, .gen and .dat
// (public/i18n/ru.js) must use exactly these words (the §11 glossary check). Part of checkpoint R1.
//
// Example entry:
//   profession: { label: 'Профессия', nom: 'профессия', acc: 'профессию', gen: 'профессии', dat: 'профессии',
//     ins: 'профессией', loc: 'профессии' },
export const COMPLETE = true;

export default {
  profession: { label: 'Профессия', nom: 'профессия', acc: 'профессию', gen: 'профессии', dat: 'профессии',
    ins: 'профессией', loc: 'профессии' },
  biology: { label: 'Биология', nom: 'биология', acc: 'биологию', gen: 'биологии', dat: 'биологии',
    ins: 'биологией', loc: 'биологии' },
  health: { label: 'Здоровье', nom: 'здоровье', acc: 'здоровье', gen: 'здоровья', dat: 'здоровью',
    ins: 'здоровьем', loc: 'здоровье' },
  hobby: { label: 'Хобби', nom: 'хобби', acc: 'хобби', gen: 'хобби', dat: 'хобби', ins: 'хобби', loc: 'хобби' },
  phobia: { label: 'Фобия', nom: 'фобия', acc: 'фобию', gen: 'фобии', dat: 'фобии', ins: 'фобией', loc: 'фобии' },
  skill: { label: 'Навык', nom: 'навык', acc: 'навык', gen: 'навыка', dat: 'навыку', ins: 'навыком', loc: 'навыке' },
  trait: { label: 'Характер', nom: 'характер', acc: 'характер', gen: 'характера', dat: 'характеру',
    ins: 'характером', loc: 'характере' },
  baggage: { label: 'Багаж', nom: 'багаж', acc: 'багаж', gen: 'багажа', dat: 'багажу', ins: 'багажом', loc: 'багаже' },
};
