// English Phobia cards: 58 entries. The id is the name before the colon.
//
// Today's English strings, verbatim, keyed by stable ids (reports/i18n-design.md §6.1–§6.2). The ids never change
// once published (B1): a reworded card keeps its id. The key order is the deck order, so reordering or inserting
// entries changes what a seed deals (the golden test in test/i18n-golden-content.test.js says so on purpose).
//
// Placeholders are drawn left to right when the card is dealt:
//   {n:a-b}    a whole number from a to b
//   {yrs:a-b}  "N years" ("1 year"), N from a to b
//   {sev}      a severity word from ./mods.js (mild / moderate / severe)
//   {x|y|z}    one of the options
// ../ru/ refers to them by position: {0} is the first placeholder, {1} the second (design §6.3).
// A Phobia gets an optional intensity from ./mods.js when dealt.
export default {
  'claustrophobia': 'Claustrophobia: fear of enclosed spaces',
  'nyctophobia': 'Nyctophobia: fear of the dark',
  'arachnophobia': 'Arachnophobia: fear of spiders',
  'hemophobia': 'Hemophobia: fear of blood',
  'acrophobia': 'Acrophobia: fear of heights',
  'agoraphobia': 'Agoraphobia: fear of open spaces and crowds',
  'aquaphobia': 'Aquaphobia: fear of water',
  'cynophobia': 'Cynophobia: fear of dogs',
  'ailurophobia': 'Ailurophobia: fear of cats',
  'ophidiophobia': 'Ophidiophobia: fear of snakes',
  'musophobia': 'Musophobia: fear of mice and rats',
  'entomophobia': 'Entomophobia: fear of insects',
  'mysophobia': 'Mysophobia: fear of germs and dirt',
  'trypanophobia': 'Trypanophobia: fear of needles and injections',
  'iatrophobia': 'Iatrophobia: fear of doctors',
  'thanatophobia': 'Thanatophobia: fear of death',
  'autophobia': 'Autophobia: fear of being alone',
  'social-phobia': 'Social phobia: fear of being judged by others',
  'glossophobia': 'Glossophobia: fear of public speaking',
  'aerophobia': 'Aerophobia: fear of flying',
  'astraphobia': 'Astraphobia: fear of thunder and lightning',
  'pyrophobia': 'Pyrophobia: fear of fire',
  'emetophobia': 'Emetophobia: fear of vomiting',
  'coulrophobia': 'Coulrophobia: fear of clowns',
  'trypophobia': 'Trypophobia: fear of clusters of small holes',
  'nomophobia': 'Nomophobia: fear of being without a phone',
  'gerascophobia': 'Gerascophobia: fear of growing old',
  'pediophobia': 'Pediophobia: fear of dolls',
  'somniphobia': 'Somniphobia: fear of falling asleep',
  'phasmophobia': 'Phasmophobia: fear of ghosts',
  'technophobia': 'Technophobia: fear of technology',
  'radiophobia': 'Radiophobia: fear of radiation',
  'ornithophobia': 'Ornithophobia: fear of birds',
  'lachanophobia': 'Lachanophobia: fear of vegetables',
  'mycophobia': 'Mycophobia: fear of mushrooms',
  'anthropophobia': 'Anthropophobia: fear of people',
  'philophobia': 'Philophobia: fear of falling in love',
  'gamophobia': 'Gamophobia: fear of commitment and marriage',
  'tokophobia': 'Tokophobia: fear of pregnancy and childbirth',
  'pogonophobia': 'Pogonophobia: fear of beards',
  'hippopotomonstrosesquippedaliophobia': 'Hippopotomonstrosesquippedaliophobia: fear of long words',
  'ergophobia': 'Ergophobia: fear of work',
  'cibophobia': 'Cibophobia: fear of food',
  'chionophobia': 'Chionophobia: fear of snow',
  'heliophobia': 'Heliophobia: fear of sunlight',
  'nosocomephobia': 'Nosocomephobia: fear of hospitals',
  'paraskevidekatriaphobia': 'Paraskevidekatriaphobia: fear of Friday the 13th',
  'omphalophobia': 'Omphalophobia: fear of belly buttons',
  'bathophobia': 'Bathophobia: fear of depths',
  'kenophobia': 'Kenophobia: fear of empty rooms',
  'atychiphobia': 'Atychiphobia: fear of failure',
  'decidophobia': 'Decidophobia: fear of making decisions',
  'gerontophobia': 'Gerontophobia: fear of old people',
  'selenophobia': 'Selenophobia: fear of the moon',
  'xanthophobia': 'Xanthophobia: fear of the color yellow',
  'chronophobia': 'Chronophobia: fear of time passing',
  'mechanophobia': 'Mechanophobia: fear of machines',
  'taphophobia': 'Taphophobia: fear of being buried alive',
};
