// Russian Biology card words. Owner: ru-content-body (reports/i18n-design.md §12).
//
// The same keys as ../en/biology.js. Binding: the glossary and style guide in reports/i18n-design.md §10 (SPEC §11
// X5.6). This card states its own sex, so its words may agree with it (§10.3 rule 4): «Женщина, 34 года,
// гетеросексуальна, беременна (3 месяца)», «Мужчина, 71 год, бисексуален, левша». Plain, neutral wording: the card
// describes a person, it never judges or jokes about sex, age or orientation.
//
// A word is one string, or {f, m} picked by the card's sex. Notes are positional like the pool files: {0} is the
// note's {n:a-b}; «{0:||двое|трое|четверо|пятеро}» picks the option by the number itself (2..5).
export const COMPLETE = true;

export default {
  sex: { f: 'Женщина', m: 'Мужчина' },
  orientation: {
    hetero: { f: 'гетеросексуальна', m: 'гетеросексуален' },
    gay: { f: 'лесбиянка', m: 'гей' },
    bi: { f: 'бисексуальна', m: 'бисексуален' },
    ace: { f: 'асексуальна', m: 'асексуален' },
  },
  // pregnant: female only (../gen.js), so one string.
  notes: {
    'pregnant': 'беременна ({0}\u00a0{0|месяц|месяца|месяцев})',
    'twin': 'из двойни',
    'left-handed': 'левша',
    'very-tall': { f: 'очень высокая ({0}\u00a0см)', m: 'очень высокий ({0}\u00a0см)' },
    'short': { f: 'невысокая ({0}\u00a0см)', m: 'невысокий ({0}\u00a0см)' },
    'one-child': 'есть ребёнок',
    'children': '{0:||двое|трое|четверо|пятеро} детей',
    'adopted': 'из приёмной семьи',
    'strong-build': 'необычайно крепкого телосложения',
  },
  /**
   * The whole card: «Женщина, 34 года, гетеросексуальна» plus «, <note>» when it has one.
   * @param {{sex: 'f'|'m', age: number, o: 'hetero'|'gay'|'bi'|'ace', noteId: string|null, noteV: number[],
   *          sexText: string, oText: string, noteText: string|null}} v
   *   sex, age (18..85), o, noteId and noteV (the note's placeholder values) are the card's data; sexText, oText and
   *   noteText are this file's words for them, already picked by sex and filled in (noteText is null without a note).
   * @param {object} f  formatter helpers (public/i18n/core.js helpers()): f.num, f.pl, f.opt, f.list, f.text
   * @returns {string}
   */
  card: (v, f) => `${v.sexText}, ${f.num(v.age)}\u00a0${f.pl(v.age, 'год', 'года', 'лет')}, ${v.oText}${v.noteText ? `, ${v.noteText}` : ''}`,
};
