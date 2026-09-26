// English Biology card words (SPEC §5; reports/i18n-design.md §6.4): sex, orientation, the notes, and the function
// that puts one card together.
//
// Today's strings, verbatim. The rules (chances, weights, which note fits which sex and age, the profession's age
// range) are language-neutral and live in ../gen.js.
//
// A word may be one string, or {f, m} when it agrees with the card's sex ('f' female, 'm' male): the renderer picks by
// the card's own sex, which the card states. Notes may hold {n:a-b} placeholders (a whole number from a to b, drawn
// when dealt); ../ru/biology.js refers to them by position ({0}).
export default {
  sex: { f: 'Female', m: 'Male' },
  // Orientation ids (dealt 78 / 8 / 9 / 5 %). "gay" reads "lesbian" on a Female card.
  orientation: {
    hetero: 'heterosexual',
    gay: { f: 'lesbian', m: 'gay' },
    bi: 'bisexual',
    ace: 'asexual',
  },
  // One note, on 25% of cards. pregnant: female, age <= 44; one-child: age >= 20; children: age >= 25.
  notes: {
    'pregnant': 'pregnant ({n:2-8} months)',
    'twin': 'twin',
    'left-handed': 'left-handed',
    'very-tall': 'very tall ({n:195-212} cm)',
    'short': 'short ({n:148-158} cm)',
    'one-child': 'has one child',
    'children': 'has {n:2-5} children',
    'adopted': 'adopted',
    'strong-build': 'unusually strong build',
  },
  /**
   * The whole card: "Female, 34 y.o., heterosexual" plus ", <note>" when it has one.
   * @param {{sex: 'f'|'m', age: number, o: 'hetero'|'gay'|'bi'|'ace', noteId: string|null, noteV: number[],
   *          sexText: string, oText: string, noteText: string|null}} v
   *   sex, age (18..85), o, noteId and noteV (the note's placeholder values) are the card's data; sexText, oText and
   *   noteText are this file's words for them, already picked by sex and filled in (noteText is null without a note).
   * @param {object} f  formatter helpers (public/i18n/core.js helpers()): f.num, f.pl, f.opt, f.list, f.text
   * @returns {string}
   */
  card: (v, f) => `${v.sexText}, ${f.num(v.age)} y.o., ${v.oText}${v.noteText ? `, ${v.noteText}` : ''}`,
};
