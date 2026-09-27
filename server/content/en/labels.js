// English category labels (SPEC §1; reports/i18n-design.md §6.1, §6.5), by category id.
//
// A label is one string: English uses the same word in every grammatical case, so categoryForms('en', id) gives this
// string for label, nom, acc, gen, dat, ins and loc. The category ids and their order are language-neutral
// (../gen.js).
export default {
  profession: 'Profession',
  biology: 'Biology',
  health: 'Health',
  hobby: 'Hobby',
  phobia: 'Phobia',
  skill: 'Extra skill',
  trait: 'Personality',
  baggage: 'Baggage',
};
