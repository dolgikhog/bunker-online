// English bunker words (SPEC §5; reports/i18n-design.md §6.1, §6.4): nicknames, features, the name, size, stay and
// food lines, and the month and range formatters.
//
// Today's strings, verbatim. The rules (which name kind, how many features, the numbers) are language-neutral and
// live in ../gen.js. Map key order is the deck order.
//
// Templates use the shared formatter's syntax (public/i18n/core.js, design §7): {name} is a param, {n|one|other} a
// plural word. Features may hold {n:a-b} placeholders (a whole number from a to b, drawn when dealt), which
// ../ru/bunker.js refers to by position ({0}).
//
// Function values take (v, f): `v` holds the params, `f` the formatter helpers of core.js helpers(): f.num(x),
// f.pl(n, ...forms), f.opt(i, ...options), f.list(items, style), f.text(template, params). They return a string.

/**
 * A duration in months, as the bunker's stay and food lines and the catastrophe's range print it.
 * @param {{m: number}} v  whole months, >= 1 (in practice 1..5, then multiples of 3 to 17, then multiples of 6)
 * @param {object} f  formatter helpers (core.js helpers())
 * @returns {string}  "8 months", "1 year", "1.5 years", "2 years 3 months"
 */
function months(v, f) {
  const { m } = v;
  if (m < 12) return `${f.num(m)} ${f.pl(m, 'month', 'months')}`;
  const y = Math.floor(m / 12);
  const rest = m % 12;
  if (rest === 0) return `${f.num(y)} ${f.pl(y, 'year', 'years')}`;
  if (rest === 6) return `${f.num(y)}.5 years`;
  return `${f.num(y)} ${f.pl(y, 'year', 'years')} ${f.num(rest)} ${f.pl(rest, 'month', 'months')}`;
}

/**
 * A catastrophe's stay range in months, for the "{range}" of ./catastrophes.js `safe`.
 * @param {{lo: number, hi: number}} v  months, lo < hi (from ../gen.js: 6..120)
 * @param {object} f  formatter helpers (core.js helpers())
 * @returns {string}  "2–6 years" (both whole years), else "6 months to 2 years"
 */
function range(v, f) {
  const { lo, hi } = v;
  if (lo % 12 === 0 && hi % 12 === 0) return `${f.num(lo / 12)}–${f.num(hi / 12)} ${f.pl(hi / 12, 'year', 'years')}`;
  return `${months({ m: lo }, f)} to ${months({ m: hi }, f)}`;
}

export default {
  // 30 nicknames, for the "nick" and "object" names.
  nicknames: {
    'last-hope': 'Last Hope',
    'molehill': 'Molehill',
    'noahs-basement': "Noah's Basement",
    'the-ark': 'The Ark',
    'badgers-den': "Badger's Den",
    'deep-burrow': 'Deep Burrow',
    'iron-turnip': 'Iron Turnip',
    'quiet-harbor': 'Quiet Harbor',
    'cold-storage': 'Cold Storage',
    'the-pantry': 'The Pantry',
    'grandpas-cellar': "Grandpa's Cellar",
    'mushroom-palace': 'Mushroom Palace',
    'plan-b': 'Plan B',
    'doomsday-deluxe': 'Doomsday Deluxe',
    'sunflower': 'Sunflower',
    'hibernation': 'Hibernation',
    'rabbit-hole': 'Rabbit Hole',
    'groundhog': 'Groundhog',
    'fort-stubborn': 'Fort Stubborn',
    'new-eden': 'New Eden',
    'lucky-seven': 'Lucky Seven',
    'stone-pillow': 'Stone Pillow',
    'the-tin-can': 'The Tin Can',
    'hermitage': 'Hermitage',
    'echo': 'Echo',
    'cocoon': 'Cocoon',
    'sleeping-bear': 'Sleeping Bear',
    'underground-paradise': 'Underground Paradise',
    'safe-haven': 'Safe Haven',
    'the-nest': 'The Nest',
  },
  // 74 features, dealt 3 to 5 per bunker (rooms, equipment and quirks; some double-edged on purpose). The last entry,
  // `hidden-storeroom`, is never dealt: the engine uses it when a "new feature" card finds the dealer failing.
  features: {
    'medical-bay-with-an-operating': 'Medical bay with an operating table',
    'hydroponic-farm-the-water-pump': 'Hydroponic farm (the water pump is broken)',
    'armory-with-rifles-but-no': 'Armory with {n:4-12} rifles, but no ammunition',
    'well-with-a-hand-pump-and-clean': 'Well with a hand pump and clean water',
    'workshop-with-power-tools': 'Workshop with power tools',
    'library-of-books-mostly-romance': 'Library of {n:800-3000} books, mostly romance novels',
    'radio-room-it-can-receive-but': 'Radio room (it can receive, but not transmit)',
    'greenhouse-with-grow-lamps': 'Greenhouse with grow lamps',
    'diesel-generator-fuel-for-months': 'Diesel generator (fuel for {n:2-12} months)',
    'solar-panels-on-a-hidden-mast': 'Solar panels on a hidden mast',
    'chicken-coop-with-hens-and-a': 'Chicken coop with {n:4-10} hens and a rooster',
    'rabbit-hutch-they-are': 'Rabbit hutch (they are multiplying fast)',
    'mushroom-cellar': 'Mushroom cellar',
    'water-purification-station': 'Water purification station',
    'gym-with-a-single-treadmill': 'Gym with a single treadmill',
    'sauna': 'Sauna',
    'home-cinema-with-dvds': 'Home cinema with {n:20-300} DVDs',
    'childrens-playroom-full-of-toys': "Children's playroom full of toys",
    'small-chapel': 'Small chapel',
    'bar-with-a-well-stocked-wine': 'Bar with a well-stocked wine cellar',
    'laboratory-with-a-microscope-and': 'Laboratory with a microscope and reagents',
    'pharmacy-cabinet-everything-in': 'Pharmacy cabinet (everything in it expired years ago)',
    'dentists-chair-and-tools-no': "Dentist's chair and tools (no dentist included)",
    'maternity-room-with-an-incubator': 'Maternity room with an incubator',
    'seed-vault-with-plant-varieties': 'Seed vault with {n:200-2000} plant varieties',
    'fish-farm-tank-with-tilapia': 'Fish farm tank with tilapia',
    'air-filtration-system-spare': 'Air filtration system (spare filters for {n:6-24} months)',
    'periscope-camera-for-watching': 'Periscope camera for watching the surface',
    'decontamination-airlock-with': 'Decontamination airlock with showers',
    'emergency-exit-through-the-old': 'Emergency exit through the old sewer tunnels',
    'blast-door-that-jams-now-and': 'Blast door that jams now and then',
    'only-one-toilet': 'Only one toilet',
    'the-dormitory-ceiling-leaks': 'The dormitory ceiling leaks',
    'rats-in-the-storage-room': 'Rats in the storage room',
    'the-previous-owners-diary-with': "The previous owner's diary, with half the pages torn out",
    'a-locked-door-nobody-has-the-key': 'A locked door nobody has the key to',
    'walls-so-thin-you-can-hear': 'Walls so thin you can hear everything',
    'server-room-with-an-offline-copy': 'Server room with an offline copy of the internet',
    'garage-with-an-all-terrain': 'Garage with an all-terrain vehicle (empty tank)',
    'swimming-pool-empty': 'Swimming pool (empty)',
    'kitchen-with-a-wood-fired-oven': 'Kitchen with a wood-fired oven',
    'small-brewery': 'Small brewery',
    'isolation-cell-that-locks-from': 'Isolation cell that locks from the outside',
    'weather-station-on-the-surface': 'Weather station on the surface',
    'satellite-dish-needs-repair': 'Satellite dish (needs repair)',
    'camera-drone-with-batteries': 'Camera drone with {n:2-4} batteries',
    'out-of-tune-piano': 'Out-of-tune piano',
    'kg-of-salt-in-the-pantry': '{n:200-900} kg of salt in the pantry',
    'karaoke-machine-that-cannot-be': 'Karaoke machine that cannot be switched off',
    'tunnel-to-a-neighboring-bunker': 'Tunnel to a neighboring bunker (someone lives there)',
    'geothermal-heating': 'Geothermal heating',
    'laundry-room-with-a-hand-cranked': 'Laundry room with a hand-cranked washing machine',
    'barbers-chair-and-scissors': "Barber's chair and scissors",
    'classroom-with-school-textbooks': 'Classroom with school textbooks',
    'wind-turbine-on-the-surface': 'Wind turbine on the surface',
    'forge-and-anvil': 'Forge and anvil',
    'sewing-room-with-bolts-of-fabric': 'Sewing room with bolts of fabric',
    'stable-with-two-goats-one-of': 'Stable with two goats (one of them pregnant)',
    'beehive-in-the-greenhouse': 'Beehive in the greenhouse',
    'radiation-suits': '{n:2-4} radiation suits',
    'morgue-cold-and-empty-for-now': 'Morgue (cold, and empty for now)',
    'terrarium-of-venomous-snakes': 'Terrarium of venomous snakes that nobody can get rid of',
    'wall-map-of-the-region-with': 'Wall map of the region with supply caches marked on it',
    'computer-with-a-chess-program': 'Computer with a chess program and nothing else',
    'bunker-ai-that-runs-the-systems': 'Bunker AI that runs the systems (and is a bit sarcastic)',
    'hidden-stash-of-bottles-of-vodka': 'Hidden stash of {n:20-200} bottles of vodka',
    'weevils-in-the-flour-stores': 'Weevils in the flour stores',
    'micro-nuclear-reactor-the-manual': 'Micro nuclear reactor (the manual is missing)',
    'aquarium-with-ornamental-fish': 'Aquarium with ornamental fish',
    'private-suite-with-a-king-size': 'Private suite with a king-size bed (who gets it?)',
    'security-cameras-in-every-room': 'Security cameras in every room',
    'emergency-radio-beacon-it-might': 'Emergency radio beacon (it might attract the wrong people)',
    'art-studio': 'Art studio',
    '3d-printer-with-one-spool-of': '3D printer with one spool of plastic left',
    'hidden-storeroom': 'A hidden storeroom',
  },
  // Letters of "Object 123-K", 15 of them. ../gen.js draws an index, so a translation gives exactly 15 letters.
  letters: 'ABCDEKMNPRSTVXZ',
  // The bunker's name, by kind. {nick}: a nickname above; {n}: a number (shelter 2..99, object 10..999);
  // {letter}: a letter above. `fallback` is the engine's stand-in when the dealer fails.
  name: {
    nick: 'Bunker "{nick}"',
    shelter: 'Shelter No. {n}',
    object: 'Object {n}-{letter} "{nick}"',
    fallback: 'The bunker',
  },
  // {n}: square meters, 60..300 in steps of 5.
  size: '{n} m²',
  // {months}: months() below.
  duration: 'You must stay {months}',
  food: 'Food for {months}',
  months,
  range,
};
