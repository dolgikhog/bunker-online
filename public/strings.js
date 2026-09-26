/* Bunker Online — user-facing strings added after the i18n design (SPEC §11 X9 profiles, X10 report links).
 *
 * They live here, together, so the i18n pass (SPEC §11 X5.7: public/i18n/en.js + ru.js, `t(key, params)`) can move
 * them in one go. Each entry is used as is: a plain string, or a function of named params that maps one to one to a
 * template ("Profile: {id}"). No code slices, re-cases or pastes pieces of these strings together (X5.3), so each can
 * become its own key. The /dev test table (public/dev.*) is an English-only tool and is exempt (X9.3). */

export const STR = {
  // X9.1: the landing page's tag when ?profile= is set (the id itself is never translated)
  profileTag: ({ id }) => `Profile: ${id}`,
  profileTagHint: 'This tab keeps its own seat and settings (?profile=), apart from tabs with another profile.',

  // X10: the two links, wherever they appear (header menu, rules sheet, final screen, landing footer)
  reportIssue: 'Report an issue',
  suggestIdea: 'Suggest an idea',
  newTabHint: 'Opens GitHub in a new tab',
  // the quiet version line (rules sheet, landing footer, header menu)
  versionLine: ({ v }) => `v${v}`,
  versionHint: 'The game version: it goes into your report',

  // X10: the header menu ("⋯") that carries the links in every in-room phase
  menuLabel: 'More',
  menuHint: 'More: report an issue, suggest an idea, the version',
  menuTitle: 'Feedback',
  menuLead: 'Something broke, or you have an idea? Tell us on GitHub (a free account is needed).',
  closeLabel: 'Close',

  // X10: the short lead-in on the final screen and in the rules sheet
  feedbackLead: 'Something off, or an idea for the game?',

  // X9.3: the narrator's popover in a seat of the /dev test table (dev mode only), where the table gives the sound to
  // one seat at a time ({who} is a seat's name, P1…P16)
  narrTableOn: 'Test table: this seat has the sound. It reads the catastrophe when a game starts.',
  narrTableOther: ({ who }) => `Test table: ${who} has the sound. ▶ Listen or the switch here moves it to this seat.`,
  narrTableOff: 'Test table: the sound is off. ▶ Listen or the switch here turns it on for this seat.',
};
