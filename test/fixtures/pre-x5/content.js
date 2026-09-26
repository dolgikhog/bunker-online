// Bunker Online: all game content and the dealer (SPEC.md §8, "Content module interface").
//
// Pure data plus a small generator. No dependencies. Every random choice goes through the injected
// `rng`, so a seeded rng gives a fully deterministic dealer.
//
// Template syntax used inside the data strings (expanded at draw time):
//   {n:a-b}    an integer from a to b (inclusive)
//   {yrs:a-b}  "N years" (or "1 year") with N from a to b
//   {sev}      a severity word: mild / moderate / severe
//   {x|y|z}    one of the options

export const CATEGORIES = [
  { id: 'profession', label: 'Profession' },
  { id: 'biology', label: 'Biology' },
  { id: 'health', label: 'Health' },
  { id: 'hobby', label: 'Hobby' },
  { id: 'phobia', label: 'Phobia' },
  { id: 'skill', label: 'Extra skill' },
  { id: 'trait', label: 'Personality' },
  { id: 'baggage', label: 'Baggage' },
];

// ---------------------------------------------------------------------------------------------
// Characteristic card pools. Each entry is one "base card": a dealer deals every base once before
// any base repeats. Modifiers (years, severity, numbers) are added at draw time.
// ---------------------------------------------------------------------------------------------

// Professions get an experience modifier ("Surgeon (12 years of experience)", "(intern, 3 months in)",
// "(retired after 30 years)"...) unless the entry already has its own parentheses.
const PROFESSIONS = [
  // medicine
  'Surgeon', 'General practitioner', 'Paramedic', 'Nurse', 'Midwife', 'Dentist', 'Pediatrician',
  'Psychiatrist', 'Anesthesiologist', 'Pharmacist', 'Veterinarian', 'Epidemiologist', 'Virologist',
  'Plastic surgeon', 'Forensic pathologist', 'Massage therapist', 'Psychologist',
  // food
  'Farmer', 'Agronomist', 'Beekeeper', 'Fisherman', 'Hunter', 'Butcher', 'Chef', 'Pastry chef', 'Baker',
  'Brewer', 'Sommelier', 'Fast-food cook', 'Food critic', 'Chocolate factory taste-tester',
  // trades
  'Electrician', 'Plumber', 'Welder', 'Carpenter', 'Car mechanic', 'Locksmith', 'Bricklayer', 'Blacksmith',
  'Tailor', 'Shoemaker', 'Ventilation engineer', 'Elevator repair technician', 'Sewer maintenance worker',
  'Pest control specialist',
  // science and engineering
  'Civil engineer', 'Mining engineer', 'Nuclear physicist', 'Chemist', 'Microbiologist', 'Botanist',
  'Geologist', 'Meteorologist', 'Astronomer', 'Hydrologist', 'Software developer', 'Robotics engineer',
  'Radio engineer', 'Network administrator', 'Mathematician', 'Architect', 'Nuclear power plant operator',
  'Water treatment operator', 'Geneticist',
  // security and rescue
  'Infantry soldier', 'Army sapper', 'Firefighter', 'Police officer', 'Security guard', 'Bodyguard',
  'Special forces operative', 'Lifeguard', 'Mountain rescuer', 'Prison guard', 'Private detective',
  // transport
  'Airline pilot', 'Truck driver', 'Train driver', "Ship's captain", 'Submarine sailor', 'Taxi driver',
  'Courier', 'Astronaut', 'Air traffic controller', 'Ice cream truck driver',
  // education and humanities
  'Primary school teacher', 'Kindergarten teacher', 'Philosophy lecturer', 'Historian', 'Librarian',
  'Archaeologist', 'Linguist', 'Translator', 'Journalist', 'Nanny', 'Social worker',
  // business and law
  'Lawyer', 'Judge', 'Accountant', 'Bank manager', 'Tax inspector', 'Real estate agent', 'Stockbroker',
  'Crypto trader', 'Car salesman', 'Marketing manager', 'HR manager', 'Insurance agent', 'City councillor',
  'Diplomat',
  // arts, sports and entertainment
  'Actor', 'Opera singer', 'Stand-up comedian', 'Clown', 'Stage magician', 'Circus acrobat', 'Tattoo artist',
  'Hairdresser', 'Fashion designer', 'Florist', 'Sculptor', 'Photographer', 'Film director', 'DJ',
  'Street musician', 'Influencer', 'Professional gamer', 'Wedding planner', 'Fitness trainer',
  'Football player', 'Professional chess player', 'Stuntman', 'Fashion model', 'Tour guide',
  // everything else
  'Priest', 'Undertaker', 'Fortune teller', 'Zookeeper', 'Dog trainer', 'Forest ranger', 'Janitor', 'Barista',
  'Life coach', 'Lighthouse keeper', 'Postman',
  'Unemployed ({n:2-12} years without a job)',
  'Homemaker (raised {n:2-6} children)',
];

// About 15% of the health pool is "Perfectly healthy" in some form.
const HEALTH = [
  'Perfectly healthy',
  'Perfectly healthy (athletic build)',
  'Perfectly healthy (just passed a full medical check-up)',
  'Perfectly healthy (iron immune system)',
  'Perfectly healthy (blood type O-negative, a universal donor)',
  'Perfectly healthy (has never been to a doctor)',
  'Perfectly healthy (fertility test: excellent)',
  'Perfectly healthy (runs a marathon every year)',
  'Perfectly healthy (perfect eyesight)',
  'Perfectly healthy (except for a sweet tooth)',
  'Perfectly healthy (and never stops mentioning it)',
  'Asthma ({sev})',
  'Type 1 diabetes (needs insulin every day)',
  'Type 2 diabetes ({sev})',
  'Infertility ({treatable with medication|untreatable})',
  'Hemophilia ({sev})',
  'Epilepsy (seizures {every week|about once a month|about once a year})',
  'Chronic migraine ({sev})',
  'Near-sightedness (-{n:2-9} diopters, no spare glasses)',
  'Color blindness',
  'Deaf in the {left|right} ear',
  'Blind in one eye',
  'Missing {left|right} hand (uses a prosthesis)',
  'Paraplegia (uses a wheelchair)',
  'Obesity (class {n:1-3})',
  'Anorexia ({sev})',
  'Allergy to {peanuts|dust|cats|penicillin|bee stings|mold|gluten} ({sev})',
  'Lactose intolerance',
  'Celiac disease',
  'High blood pressure ({sev})',
  'Heart arrhythmia ({sev})',
  'Survived a heart attack {yrs:1-9} ago',
  'Cancer (stage {n:1-4})',
  'Cancer in remission ({yrs:1-10})',
  "Early-stage Alzheimer's disease",
  "Parkinson's disease ({sev})",
  'Multiple sclerosis ({sev})',
  'Schizophrenia (stable on medication)',
  'Bipolar disorder ({sev})',
  'Clinical depression ({sev})',
  'PTSD ({sev})',
  'Obsessive-compulsive disorder ({sev})',
  'Panic disorder ({sev})',
  'Chronic insomnia',
  'Narcolepsy (falls asleep mid-sentence)',
  'Sleepwalking ({sev})',
  'Snores so loudly it carries through walls',
  'Chronic back pain ({sev})',
  'Rheumatoid arthritis ({sev})',
  'Kidney stones',
  'Only one kidney',
  'Stomach ulcer ({sev})',
  'Tuberculosis (active, contagious)',
  'Hepatitis C (treatable)',
  'HIV-positive (on therapy, undetectable)',
  'Albinism (skin burns after minutes in the sun)',
  'Anemia ({sev})',
  'Radiation sickness ({sev})',
  'Alcohol addiction ({sev})',
  'Nicotine addiction ({a pack|two packs|three packs} a day)',
  'Gambling addiction',
  'Hypochondria (convinced they are dying)',
  'Broken leg (in a cast for {n:2-6} more weeks)',
  'Stutter ({sev})',
  'Hiccups that have lasted {n:2-9} weeks',
  'Common cold (sneezes on everyone)',
  'Head lice',
  'Chronic fatigue syndrome',
  'Amnesia (remembers nothing before last year)',
  'Scoliosis ({sev})',
  'Tinnitus (a constant ringing in the ears)',
  'Sickle cell disease',
  'Immune to most common viruses (a rare mutation)',
  'Carrier of an unknown virus (no symptoms)',
  'Terminal illness (doctors gave {n:2-12} months)',
  'Pacemaker (battery good for {yrs:1-8} more)',
  'Hearing aid (the batteries are running out)',
  'Gout ({sev})',
  'Dental abscess (constant toothache)',
];

// Hobbies get a duration ("Fishing (5 years)") unless the entry has its own parentheses.
const HOBBIES = [
  'Fishing', 'Hunting', 'Gardening', 'Beekeeping', 'Mushroom picking', 'Chess', 'Poker', 'Knitting',
  'Sewing', 'Guitar', 'Piano', 'Singing in a choir', 'Karaoke', 'Yoga', 'Boxing', 'Rock climbing',
  'Hiking', 'Camping', 'Parkour', 'Archery', 'Fencing', 'Swimming', 'Scuba diving', 'Skydiving',
  'Woodcarving', 'Pottery', 'Oil painting', 'Photography', 'Writing poetry', 'Reading science fiction',
  'Cosplay', 'Video games', 'Tabletop role-playing games', 'Stargazing', 'Birdwatching',
  'Brewing beer at home', 'Making wine at home', 'Baking bread', 'Pickling and canning',
  'Foraging for wild plants', 'Ham radio', 'Soldering electronics', '3D printing', 'Drone racing',
  'Model railways', 'Stamp collecting', 'Coin collecting', 'Taxidermy', 'Card tricks', 'Juggling',
  'Ballroom dancing', 'Breakdancing', 'Researching conspiracy theories', 'Prepping for the apocalypse',
  'Geocaching', 'Orienteering', 'Motorcycle repair', 'Sailing', 'Horse riding', 'Keeping aquarium fish',
  'Calligraphy', 'Origami', 'Crossword puzzles', 'Meditation', 'Reading tarot cards', 'Astrology',
  'Sport lockpicking', 'Knife throwing', 'Blacksmithing', 'Soap making', 'Family tree research',
  'Learning a made-up language from a TV show',
  'Collecting bottle caps ({n:200-3000} of them)',
  'Watching cooking shows (never cooks)',
];

// Phobias get an optional intensity in parentheses.
const PHOBIAS = [
  'Claustrophobia: fear of enclosed spaces',
  'Nyctophobia: fear of the dark',
  'Arachnophobia: fear of spiders',
  'Hemophobia: fear of blood',
  'Acrophobia: fear of heights',
  'Agoraphobia: fear of open spaces and crowds',
  'Aquaphobia: fear of water',
  'Cynophobia: fear of dogs',
  'Ailurophobia: fear of cats',
  'Ophidiophobia: fear of snakes',
  'Musophobia: fear of mice and rats',
  'Entomophobia: fear of insects',
  'Mysophobia: fear of germs and dirt',
  'Trypanophobia: fear of needles and injections',
  'Iatrophobia: fear of doctors',
  'Thanatophobia: fear of death',
  'Autophobia: fear of being alone',
  'Social phobia: fear of being judged by others',
  'Glossophobia: fear of public speaking',
  'Aerophobia: fear of flying',
  'Astraphobia: fear of thunder and lightning',
  'Pyrophobia: fear of fire',
  'Emetophobia: fear of vomiting',
  'Coulrophobia: fear of clowns',
  'Trypophobia: fear of clusters of small holes',
  'Nomophobia: fear of being without a phone',
  'Gerascophobia: fear of growing old',
  'Pediophobia: fear of dolls',
  'Somniphobia: fear of falling asleep',
  'Phasmophobia: fear of ghosts',
  'Technophobia: fear of technology',
  'Radiophobia: fear of radiation',
  'Ornithophobia: fear of birds',
  'Lachanophobia: fear of vegetables',
  'Mycophobia: fear of mushrooms',
  'Anthropophobia: fear of people',
  'Philophobia: fear of falling in love',
  'Gamophobia: fear of commitment and marriage',
  'Tokophobia: fear of pregnancy and childbirth',
  'Pogonophobia: fear of beards',
  'Hippopotomonstrosesquippedaliophobia: fear of long words',
  'Ergophobia: fear of work',
  'Cibophobia: fear of food',
  'Chionophobia: fear of snow',
  'Heliophobia: fear of sunlight',
  'Nosocomephobia: fear of hospitals',
  'Paraskevidekatriaphobia: fear of Friday the 13th',
  'Omphalophobia: fear of belly buttons',
  'Bathophobia: fear of depths',
  'Kenophobia: fear of empty rooms',
  'Atychiphobia: fear of failure',
  'Decidophobia: fear of making decisions',
  'Gerontophobia: fear of old people',
  'Selenophobia: fear of the moon',
  'Xanthophobia: fear of the color yellow',
  'Chronophobia: fear of time passing',
  'Mechanophobia: fear of machines',
  'Taphophobia: fear of being buried alive',
];

const SKILLS = [
  'Speaks {n:3-7} languages',
  'Knows first aid',
  'Has delivered a baby (in a taxi)',
  'Knows sign language',
  'Former prisoner ({n:2-15} years for {fraud|robbery|tax evasion|smuggling|something they refuse to talk about})',
  'Can pick any lock in under a minute',
  'Black belt in {judo|karate|taekwondo}',
  'Can repair any engine',
  'Knows which wild plants are edible',
  'Can start a fire without matches',
  'Photographic memory',
  'Former Olympic {swimmer|rower|biathlete|weightlifter}',
  'Can hypnotize people (sometimes)',
  'Can build a wind turbine from scrap',
  'Can stitch wounds',
  'Plays any instrument by ear',
  'Knows Morse code',
  'Can drive anything with wheels or tracks',
  'Can distill alcohol from almost anything',
  'Can cook a decent meal from three ingredients',
  'Survived a plane crash',
  'Knows how to purify water',
  'Can make soap and candles',
  'Knows the engineer who built this bunker',
  'Knows where an abandoned army warehouse is',
  'Can tell when someone is lying (usually)',
  'Can sleep anywhere, anytime',
  'Can go without food for {n:5-10} days',
  'Perfect pitch',
  'Cheats at cards and never gets caught',
  'Was a millionaire until last week',
  'Has {n:1-3} million followers online',
  'Knows {n:300-900} jokes by heart',
  'Can cut hair',
  'Can navigate by the stars',
  'Former cult member',
  'Has a hidden stash of supplies {n:5-50} km away',
  'Can raise chickens and rabbits',
  'Can milk a cow and make cheese',
  'Built a house with their own hands',
  'Former spy (or so they claim)',
  'Learned karate from online videos',
  'Can calm any animal down',
  'Brilliant negotiator',
  'Can juggle {n:3-7} knives',
  'Can train dogs',
  'Taught {n:2-40} children to read',
  'Survived {n:2-6} weeks alone in the forest',
  'Volunteer rescuer ({yrs:1-12})',
  'Can reprogram any microcontroller',
  'Plays chess blindfolded',
  'Can find water with a dowsing rod (allegedly)',
  'Knows CPR',
  'Can set broken bones',
  'Can grow penicillin mold (and hopes it works)',
  'Needs only {n:3-5} hours of sleep',
  'Former hostage negotiator',
  'Can forge any signature or document',
  'Can build a radio out of junk',
  'Can butcher and preserve meat',
  'Can tan leather and sew clothes',
  'Has read everything about emergency surgery (never tried it)',
  'Can recite the periodic table',
  'Former professional poker player',
  "Has a pilot's license for small planes",
  'Can weld and forge metal',
  'Knows how to brew beer',
  'Knows how to make gunpowder',
  'Can make anyone laugh in any situation',
  'Knows how to chair a meeting and count votes',
  'Regional debate champion',
  'Reads tarot cards, and people believe them',
  'Can make clothes out of anything',
  'Knows traditional herbal medicine',
  'Plays the harmonica, loudly',
  'Can identify {n:100-500} birds by their song',
  'Parachute instructor ({n:100-900} jumps)',
  'Former child actor (still gets recognized)',
  'Knows how to keep bees',
  'Can hold their breath for {n:2-5} minutes',
];

const TRAITS = [
  'Honest to a fault', 'Hot-tempered', 'Born leader', 'Coward', 'Incurable optimist', 'Pathological liar',
  'Kind-hearted', 'Lazy', 'Paranoid', 'Workaholic', 'Gloomy pessimist', 'Charismatic', 'Stubborn as a mule',
  'Know-it-all', 'Calm under pressure', 'Greedy', 'Generous', 'Jealous', 'Hypocrite', 'Natural diplomat',
  'Introvert', 'Life of the party', 'Perfectionist', 'Clumsy', 'Forgetful', 'Gossip', 'Fiercely loyal',
  'Manipulative', 'Brave', 'Reckless', 'Overly cautious', 'Always cheerful', 'Grumpy', 'Sarcastic', 'Naive',
  'Cynical', 'Religious zealot', 'Neat freak', 'Slob', 'Hoarder', 'Glutton', 'Ascetic', 'Hopeless romantic',
  'Incorrigible flirt', 'Sore loser', 'Ultra-competitive', 'Team player', 'Lone wolf', 'Holds grudges forever',
  'Forgives everything', 'Deeply empathetic', 'Cold and calculating', 'Turns everything into a drama',
  'Impulsive', 'Endlessly patient', 'Endlessly curious', 'Superstitious', 'Believes every conspiracy theory',
  'Show-off', 'Modest', 'Bossy', 'Does whatever they are told', 'Rebel', 'Anxious', 'Chatterbox',
  'Speaks only when necessary', 'Night owl', 'Early bird', 'Kleptomaniac', 'Easily offended', 'Thick-skinned',
  'Peacemaker', 'Sneaky', 'Tells long, boring stories', 'Always late', 'Hero complex', 'Strict pacifist',
  'Tactless', 'Exceedingly polite', 'Complains constantly',
];

const BAGGAGE = [
  'TT pistol with {n:2-16} rounds',
  'Hunting rifle with {n:5-40} cartridges',
  'Crossbow with {n:3-20} bolts',
  'Bag of vegetable seeds ({n:1-5} kg)',
  'Sack of seed potatoes ({n:10-30} kg)',
  'First aid kit',
  'Surgical instrument set',
  'Antibiotics ({n:2-10} courses)',
  'Insulin ({n:10-90} doses)',
  'Iodine pills against radiation ({n:20-200})',
  "A year's supply of vitamins",
  'Box of condoms ({n:10-144})',
  'Pregnancy tests ({n:3-20})',
  'Canned food ({n:10-60} cans)',
  'Hand-crank radio',
  'Axe',
  'Portable water filter',
  'Chainsaw (no fuel)',
  'Folding solar panel ({n:50-400} W)',
  'Tent for {n:2-8} people',
  'Sleeping bag',
  'Fishing rod and a tackle box',
  'Laptop with an offline copy of Wikipedia',
  'Encyclopedia of medicinal plants',
  'Holy book',
  'Chess set',
  'Deck of playing cards',
  'Vodka ({n:2-10} liters)',
  'Cat in a carrier',
  'German shepherd',
  'A hen and a rooster in a crate',
  'Pregnant goat',
  'Hamster',
  'Parrot that swears in {n:2-4} languages',
  'Beehive (with bees)',
  'Gas mask with {n:2-6} spare filters',
  'Hazmat suit',
  'Geiger counter',
  'Night-vision goggles',
  'Binoculars',
  'Compass and paper maps',
  'Satellite phone (battery {n:5-60}%)',
  'Gold bars ({n:1-12} kg)',
  'Suitcase with a million dollars in cash',
  'USB stick holding {n:2-50} bitcoin',
  'Vinyl record collection',
  'Karaoke machine',
  'Wedding dress',
  'Tuxedo',
  'Toilet paper ({n:4-48} rolls)',
  'Lighter and {n:2-10} gas refills',
  'Matches ({n:5-50} boxes)',
  'Swiss army knife',
  'Crowbar',
  'Duct tape ({n:2-12} rolls)',
  'Toolbox',
  'Portable welding machine',
  'Diesel generator with {n:10-100} liters of fuel',
  'Bicycle',
  'Inflatable kayak',
  'Sewing kit',
  'Knitting needles and {n:2-15} balls of yarn',
  "Book: 'Home Childbirth for Beginners'",
  "Children's picture books",
  'Board game with half the pieces missing',
  'Harmonica',
  'Violin',
  'Accordion',
  'Drum kit',
  'Paints and canvases',
  'Instant camera ({n:5-40} shots left)',
  'Rubber duck',
  'Garden gnome',
  'Jar of sourdough starter',
  'Salt ({n:2-20} kg)',
  'Sugar ({n:2-20} kg)',
  'Coffee beans ({n:1-10} kg)',
  'Cigarettes ({n:5-50} packs)',
  'Chocolate bars ({n:10-100})',
  'Jar of honey ({n:1-5} kg)',
  'Cast-iron cooking pot',
  'Microscope',
  "Children's chemistry set",
  'Flare gun with {n:2-6} flares',
  'Handcuffs without a key',
  'Metal detector',
  'Snorkel and flippers',
  'Hammock',
  "Diary of the bunker's previous owner",
  "Urn with grandma's ashes",
  'Stuffed owl',
  'Tattoo machine',
  'Hair clippers',
  'Makeup kit',
  'Unchecked lottery ticket',
  'Treasure map',
  'Locked box that must never be opened',
  'Crate of beer ({n:12-48} bottles)',
  'Rice ({n:5-50} kg)',
  'Dynamite ({n:2-10} sticks)',
  'Camera drone',
  'Pair of walkie-talkies',
  'Rope ({n:10-100} m)',
  'Water barrel ({n:50-200} liters)',
  'Grow lamp',
  'Car battery',
  'Megaphone',
  'Teddy bear',
  'Samurai sword (decorative)',
];

const POOLS = {
  profession: PROFESSIONS,
  health: HEALTH,
  hobby: HOBBIES,
  phobia: PHOBIAS,
  skill: SKILLS,
  trait: TRAITS,
  baggage: BAGGAGE,
};

// ---------------------------------------------------------------------------------------------
// Biology (generated): sex, age 18–85 skewed to 20–60, orientation, sometimes one extra note.
// Infertility lives in the Health pool, not here.
// ---------------------------------------------------------------------------------------------

// 'gay' reads 'lesbian' on a Female card (biologyText).
const ORIENTATIONS = [
  ['heterosexual', 78],
  ['gay', 8],
  ['bisexual', 9],
  ['asexual', 5],
];

const BIO_NOTE_CHANCE = 0.25;
const BIO_NOTES = [
  { text: 'pregnant ({n:2-8} months)', w: 3, ok: (female, age) => female && age <= 44 },
  { text: 'twin', w: 1, ok: () => true },
  { text: 'left-handed', w: 1, ok: () => true },
  { text: 'very tall ({n:195-212} cm)', w: 1, ok: () => true },
  { text: 'short ({n:148-158} cm)', w: 1, ok: () => true },
  { text: 'has one child', w: 1, ok: (female, age) => age >= 20 },
  { text: 'has {n:2-5} children', w: 1.5, ok: (female, age) => age >= 25 },
  { text: 'adopted', w: 0.7, ok: () => true },
  { text: 'unusually strong build', w: 1, ok: () => true },
];

// ---------------------------------------------------------------------------------------------
// Catastrophes. `stay` = [min, max] months until the surface is safe; the bunker drawn after the
// catastrophe gets a duration inside that range, so the two never contradict each other.
// ---------------------------------------------------------------------------------------------

const CATASTROPHES = [
  {
    title: 'Nuclear Winter',
    text: 'A border dispute turned into a full nuclear exchange in under an hour. Smoke from burning cities now blocks the sun, and the planet is freezing. Crops have failed everywhere at once.',
    details: [
      "Survivors: about {n:3-8}% of the world's population",
      'Surface: -{n:30-50}°C, permanent twilight, radioactive fallout',
      'Threats: cold, radiation, starving raiders',
    ],
    stay: [24, 72],
  },
  {
    title: 'The Gray Fever',
    text: 'A fever that turns the skin ash-gray moved through airports faster than any quarantine. Most of the infected die within a week, and the few who recover stay contagious. The hospitals stopped answering the phone on day twelve.',
    details: [
      'Survivors: about {n:5-15}%, many of them carriers',
      'Surface: abandoned cities, no power, no running water',
      'Threats: infection, contaminated water, looted pharmacies',
    ],
    stay: [12, 36],
  },
  {
    title: 'Asteroid Impact',
    text: 'An asteroid ten kilometers wide, spotted only three weeks in advance, struck the Pacific. Tsunamis erased the coastlines and falling debris started fires on every continent. The dust will not settle for years.',
    details: [
      'Survivors: about {n:1-4}%',
      'Surface: dust storms, acid rain, temperature swings of 40°C in a day',
      'Threats: earthquakes, collapsing buildings, wildfires',
    ],
    stay: [36, 96],
  },
  {
    title: 'Supervolcano',
    text: 'The supervolcano under Yellowstone woke up after 640,000 years. Half a continent lies under ash, and sulfur in the upper atmosphere has brought a volcanic winter. Breathing outside without a mask burns the lungs.',
    details: [
      'Survivors: about {n:10-25}%',
      'Surface: ash drifts several meters deep, sulfuric haze',
      'Threats: toxic air, lung disease, failed harvests',
    ],
    stay: [18, 60],
  },
  {
    title: 'Machine Uprising',
    text: "An overnight software update gave the world's logistics AI a new goal, and people turned out to be in the way. Self-driving trucks, drones and factory robots now hunt anything with a heartbeat. Nothing connected to a network can be trusted.",
    details: [
      'Survivors: about {n:10-20}%',
      'Surface: drones patrol the cities; the power grid now runs only for machines',
      "Threats: drones, networked devices, cameras (the machines' solar plants are failing without maintenance)",
    ],
    stay: [24, 72],
  },
  {
    title: 'The Visitors',
    text: 'Silver ships appeared over every capital and asked, politely, for everyone to go indoors. People who stayed outside simply vanished. The ships are still up there, and they seem to be waiting for something.',
    details: [
      'Survivors: about {n:25-40}%, all of them in hiding',
      'Surface: intact but deserted; strange lights at night',
      'Threats: abduction beams, and whatever the visitors want',
    ],
    stay: [12, 48],
  },
  {
    title: 'The Great Flood',
    text: 'The Antarctic ice shelves collapsed in a single summer and the sea rose by tens of meters. Coastal cities are under water and the inland is overrun by storms and refugees. The bunker is on high ground, for now.',
    details: [
      'Survivors: about {n:15-30}%',
      'Surface: permanent storms, flooded lowlands, salt in the soil',
      'Threats: hurricanes, disease, fights over dry land',
    ],
    stay: [12, 48],
  },
  {
    title: 'Solar Superflare',
    text: 'The Sun released the largest flare ever recorded. Every transformer on Earth burned out within seconds, satellites fell from orbit, and the damaged ozone layer now lets through deadly ultraviolet light.',
    details: [
      'Survivors: about {n:20-40}%',
      'Surface: sunburn in minutes, no electricity anywhere, dead electronics',
      'Threats: UV radiation, skin cancer, famine, the collapse of order',
    ],
    stay: [12, 36],
  },
  {
    title: 'Spore Rain',
    text: 'A meteor shower seeded the upper atmosphere with fungal spores from somewhere else. Wherever they land, gray mold covers everything within days: crops, animals, and people who breathe it in. It dies only in sealed, filtered air.',
    details: [
      'Survivors: about {n:5-12}%',
      'Surface: gray mold on every surface, spore clouds at dawn',
      'Threats: inhaled spores, contaminated food, mold-covered wildlife',
    ],
    stay: [18, 60],
  },
  {
    title: 'The Yellow Cloud',
    text: 'An explosion at a chemical plant released a cloud that did not spread thin. It grew. The yellow fog has crossed three countries, everything it touches corrodes, and it is heavier than air, so it pools in the lowlands.',
    details: [
      'Survivors: about {n:30-50}% (the disaster is regional, for now)',
      'Surface: yellow fog in the valleys, corroded metal, dead forests',
      'Threats: chemical burns, poisoned water',
    ],
    stay: [6, 24],
  },
  {
    title: 'New Ice Age',
    text: 'The ocean currents that warmed the northern hemisphere stopped almost overnight. Within a year, glaciers were advancing across Europe and North America, and winter never ended. The equator is packed with desperate refugees.',
    details: [
      'Survivors: about {n:20-35}%',
      'Surface: -{n:40-60}°C, endless blizzards',
      'Threats: frostbite, hunger, wolf packs moving south',
    ],
    stay: [36, 120],
  },
  {
    title: 'Gray Goo',
    text: 'Self-replicating nanobots built to clean up oil spills escaped and never stopped. They take apart anything organic or metal to build more of themselves, and the landscape is turning into gray dust. They cannot get through thick concrete.',
    details: [
      'Survivors: about {n:2-6}%',
      'Surface: dunes of gray dust where cities used to be',
      'Threats: nanobot swarms moving at walking speed (they should die out once their energy runs out)',
    ],
    stay: [24, 72],
  },
  {
    title: 'The Biting Plague',
    text: 'A mutated strain of rabies turned the infected into aggressive, mindless hunters. One bite is enough, and the symptoms start within the hour. The infected never tire, but they are blind in the dark and slow in the cold.',
    details: [
      'Survivors: about {n:3-10}%',
      'Surface: overrun cities, packs of infected roaming at dusk',
      'Threats: bites, scratches, infected blood (the infected should starve out in time)',
    ],
    stay: [12, 48],
  },
  {
    title: 'Silent Spring',
    text: 'A modified pesticide spread through the soil and wiped out almost every insect on Earth. With no pollinators, the crops failed, the birds starved, and the food chain collapsed. People are now fighting over the last grain stores.',
    details: [
      'Survivors: about {n:25-45}%',
      'Surface: silent fields, dying forests, rotting fruit',
      'Threats: famine, riots, soil turning to dust',
    ],
    stay: [24, 60],
  },
  {
    title: 'Gamma-Ray Burst',
    text: 'A dying star thousands of light-years away sent a burst of gamma rays straight at Earth. The day side of the planet was sterilized in ten seconds, and the ozone layer is gone. The survivors were on the night side, underground or under water.',
    details: [
      'Survivors: about {n:30-45}%',
      'Surface: deadly UV light, radiation, burning forests',
      'Threats: UV burns, cancer, failed harvests',
    ],
    stay: [12, 48],
  },
  {
    title: 'The Barren Plague',
    text: "A virus with symptoms like a mild cold infected nearly everyone before doctors noticed its side effect: complete infertility. No child has been born anywhere for months. The bunker's sealed air protects the last fertile people, so humanity's future depends on who goes in.",
    details: [
      'Survivors: about {n:85-95}% alive, but almost everyone is now sterile',
      'Surface: society still stands, but in full panic',
      'Threats: the airborne virus; officials hunting for fertile people',
    ],
    stay: [12, 36],
  },
  {
    title: 'Pole Reversal',
    text: "Earth's magnetic field collapsed while the poles swapped places. Without it, the solar wind strips the atmosphere, radiation storms sweep the surface, and every compass is useless. Migrating animals have lost their way.",
    details: [
      'Survivors: about {n:15-30}%',
      'Surface: auroras at noon, radiation storms',
      'Threats: radiation, burned-out electronics, no way to navigate',
    ],
    stay: [18, 60],
  },
  {
    title: 'Scorched Earth',
    text: 'The methane locked in the Arctic permafrost escaped all at once, and the planet overheated within a decade. Summer temperatures reach 60°C, the rivers have dried up and forests burn for months. Only underground is it cool enough to sleep.',
    details: [
      'Survivors: about {n:10-25}%',
      'Surface: +{n:50-65}°C at noon, smoke, dust storms',
      'Threats: heatstroke, thirst, wildfires',
    ],
    stay: [36, 96],
  },
];

// ---------------------------------------------------------------------------------------------
// Bunker generator
// ---------------------------------------------------------------------------------------------

const BUNKER_NICKNAMES = [
  'Last Hope', 'Molehill', "Noah's Basement", 'The Ark', "Badger's Den", 'Deep Burrow', 'Iron Turnip',
  'Quiet Harbor', 'Cold Storage', 'The Pantry', "Grandpa's Cellar", 'Mushroom Palace', 'Plan B',
  'Doomsday Deluxe', 'Sunflower', 'Hibernation', 'Rabbit Hole', 'Groundhog', 'Fort Stubborn', 'New Eden',
  'Lucky Seven', 'Stone Pillow', 'The Tin Can', 'Hermitage', 'Echo', 'Cocoon', 'Sleeping Bear',
  'Underground Paradise', 'Safe Haven', 'The Nest',
];
const BUNKER_LETTERS = 'ABCDEKMNPRSTVXZ';

// Rooms, equipment and quirks. Some are double-edged on purpose.
const FEATURES = [
  'Medical bay with an operating table',
  'Hydroponic farm (the water pump is broken)',
  'Armory with {n:4-12} rifles, but no ammunition',
  'Well with a hand pump and clean water',
  'Workshop with power tools',
  'Library of {n:800-3000} books, mostly romance novels',
  'Radio room (it can receive, but not transmit)',
  'Greenhouse with grow lamps',
  'Diesel generator (fuel for {n:2-12} months)',
  'Solar panels on a hidden mast',
  'Chicken coop with {n:4-10} hens and a rooster',
  'Rabbit hutch (they are multiplying fast)',
  'Mushroom cellar',
  'Water purification station',
  'Gym with a single treadmill',
  'Sauna',
  'Home cinema with {n:20-300} DVDs',
  "Children's playroom full of toys",
  'Small chapel',
  'Bar with a well-stocked wine cellar',
  'Laboratory with a microscope and reagents',
  'Pharmacy cabinet (everything in it expired years ago)',
  "Dentist's chair and tools (no dentist included)",
  'Maternity room with an incubator',
  'Seed vault with {n:200-2000} plant varieties',
  'Fish farm tank with tilapia',
  'Air filtration system (spare filters for {n:6-24} months)',
  'Periscope camera for watching the surface',
  'Decontamination airlock with showers',
  'Emergency exit through the old sewer tunnels',
  'Blast door that jams now and then',
  'Only one toilet',
  'The dormitory ceiling leaks',
  'Rats in the storage room',
  "The previous owner's diary, with half the pages torn out",
  'A locked door nobody has the key to',
  'Walls so thin you can hear everything',
  'Server room with an offline copy of the internet',
  'Garage with an all-terrain vehicle (empty tank)',
  'Swimming pool (empty)',
  'Kitchen with a wood-fired oven',
  'Small brewery',
  'Isolation cell that locks from the outside',
  'Weather station on the surface',
  'Satellite dish (needs repair)',
  'Camera drone with {n:2-4} batteries',
  'Out-of-tune piano',
  '{n:200-900} kg of salt in the pantry',
  'Karaoke machine that cannot be switched off',
  'Tunnel to a neighboring bunker (someone lives there)',
  'Geothermal heating',
  'Laundry room with a hand-cranked washing machine',
  "Barber's chair and scissors",
  'Classroom with school textbooks',
  'Wind turbine on the surface',
  'Forge and anvil',
  'Sewing room with bolts of fabric',
  'Stable with two goats (one of them pregnant)',
  'Beehive in the greenhouse',
  '{n:2-4} radiation suits',
  'Morgue (cold, and empty for now)',
  'Terrarium of venomous snakes that nobody can get rid of',
  'Wall map of the region with supply caches marked on it',
  'Computer with a chess program and nothing else',
  'Bunker AI that runs the systems (and is a bit sarcastic)',
  'Hidden stash of {n:20-200} bottles of vodka',
  'Weevils in the flour stores',
  'Micro nuclear reactor (the manual is missing)',
  'Aquarium with ornamental fish',
  'Private suite with a king-size bed (who gets it?)',
  'Security cameras in every room',
  'Emergency radio beacon (it might attract the wrong people)',
  'Art studio',
  '3D printer with one spool of plastic left',
];

// ---------------------------------------------------------------------------------------------
// Special condition cards (SPEC §5). Only the allowed effect/target/category combinations are used.
// Each card is dealt once before any card repeats, so an effect's frequency = its number of cards.
// The random pool (drawSpecial) never holds an Airlock, a revive or the retired one-player `eject`: the engine deals
// AIRLOCK_CARD and REVIVE_CARD (below the pool) as fixed cards, a set number per table (SPEC §11 X1).
// Cards that reveal a category for *every* alive player (mass_reveal, shuffle_category) are kept to 3 of the 52: with
// more, round-7 turns often had nothing left to reveal and the final nothing left to unveil (SPEC §1 "one card stays
// hidden"; §11 C6). The other slots go to cards that reveal nothing: peeks, bunker features and vote cards.
// ---------------------------------------------------------------------------------------------

const BEFORE_VOTE = 'Play during a reveal or discussion phase.';
const SWAP_TAIL = 'Both cards are revealed to everyone.';
const REROLL_TAIL = 'is discarded and replaced by a newly drawn one, which is revealed to everyone.';
const PEEK_TAIL = 'It is added to your private notes and stays hidden from everyone else, who only learn that a peek happened.';
const SHUFFLE_TAIL = 'is collected, shuffled and dealt back at random, one each (you may get your own back). All of them are revealed to everyone.';
const NEXT_VOTE_TAIL = 'in the next vote (every ballot of it, revotes included). If that vote is cancelled, this is used up too.';

const SPECIALS = [
  // swap_card (target other; a Category or 'choose')
  { id: 'swap-baggage', title: 'Barter', effect: 'swap_card', target: 'other', category: 'baggage',
    text: `Choose another player: you swap Baggage cards with them. ${SWAP_TAIL}` },
  { id: 'swap-profession', title: 'Career Switch', effect: 'swap_card', target: 'other', category: 'profession',
    text: `Choose another player: you swap Profession cards with them. ${SWAP_TAIL}` },
  { id: 'swap-health', title: 'Organ Donor', effect: 'swap_card', target: 'other', category: 'health',
    text: `Choose another player: you swap Health cards with them. ${SWAP_TAIL} Let's hope yours was the worse one.` },
  { id: 'swap-hobby', title: 'Hobby Exchange', effect: 'swap_card', target: 'other', category: 'hobby',
    text: `Choose another player: you swap Hobby cards with them. ${SWAP_TAIL}` },
  { id: 'swap-phobia', title: 'Pass the Fear', effect: 'swap_card', target: 'other', category: 'phobia',
    text: `Choose another player: you swap Phobia cards with them. ${SWAP_TAIL}` },
  { id: 'swap-trait', title: 'Personality Transplant', effect: 'swap_card', target: 'other', category: 'trait',
    text: `Choose another player: you swap Personality cards with them. ${SWAP_TAIL}` },
  { id: 'swap-biology', title: 'Body Swap', effect: 'swap_card', target: 'other', category: 'biology',
    text: `Choose another player: you swap Biology cards with them (sex, age and all). ${SWAP_TAIL}` },
  { id: 'swap-choose', title: 'Fair Trade', effect: 'swap_card', target: 'other', category: 'choose',
    text: `Choose another player and any category: you swap your cards of that category. ${SWAP_TAIL}` },

  // reroll_card (target self or other; a Category or 'choose')
  { id: 'reroll-self-health', title: 'Miracle Cure', effect: 'reroll_card', target: 'self', category: 'health',
    text: `Your Health card ${REROLL_TAIL} It could be better. It could be worse.` },
  { id: 'reroll-self-profession', title: 'Night School', effect: 'reroll_card', target: 'self', category: 'profession',
    text: `Your Profession card ${REROLL_TAIL}` },
  { id: 'reroll-self-phobia', title: 'Exposure Therapy', effect: 'reroll_card', target: 'self', category: 'phobia',
    text: `Your Phobia card ${REROLL_TAIL} Out with the old fear, in with a new one.` },
  { id: 'reroll-self-baggage', title: 'Lost and Found', effect: 'reroll_card', target: 'self', category: 'baggage',
    text: `Your Baggage card ${REROLL_TAIL}` },
  { id: 'reroll-self-choose', title: 'Fresh Start', effect: 'reroll_card', target: 'self', category: 'choose',
    text: `Choose any of your categories: that card ${REROLL_TAIL}` },
  { id: 'reroll-other-baggage', title: 'Lost Luggage', effect: 'reroll_card', target: 'other', category: 'baggage',
    text: `Choose another player: their Baggage card ${REROLL_TAIL}` },
  { id: 'reroll-other-trait', title: 'Brainwashing', effect: 'reroll_card', target: 'other', category: 'trait',
    text: `Choose another player: their Personality card ${REROLL_TAIL}` },
  { id: 'reroll-other-health', title: 'Contagious Sneeze', effect: 'reroll_card', target: 'other', category: 'health',
    text: `Choose another player: their Health card ${REROLL_TAIL}` },
  { id: 'reroll-other-choose', title: 'Rewrite History', effect: 'reroll_card', target: 'other', category: 'choose',
    text: `Choose another player and any category: their card of that category ${REROLL_TAIL}` },

  // force_reveal (target other; 'choose' or 'random')
  { id: 'reveal-interrogation', title: 'Interrogation', effect: 'force_reveal', target: 'other', category: 'choose',
    text: 'Choose another player and one of their hidden categories: that card is revealed to everyone.' },
  { id: 'reveal-background-check', title: 'Background Check', effect: 'force_reveal', target: 'other', category: 'choose',
    text: 'Choose another player and one of their hidden categories: that card is revealed to everyone. No secrets in the bunker.' },
  { id: 'reveal-subpoena', title: 'Subpoena', effect: 'force_reveal', target: 'other', category: 'choose',
    text: 'Choose another player and one of their hidden categories: that card is revealed to everyone, whether they like it or not.' },
  { id: 'reveal-truth-serum', title: 'Truth Serum', effect: 'force_reveal', target: 'other', category: 'random',
    text: 'Choose another player: one of their hidden cards, picked at random, is revealed to everyone.' },
  { id: 'reveal-paparazzi', title: 'Paparazzi', effect: 'force_reveal', target: 'other', category: 'random',
    text: 'Choose another player: one of their hidden cards, picked at random, is revealed to everyone. Smile for the camera.' },
  { id: 'reveal-loose-lips', title: 'Loose Lips', effect: 'force_reveal', target: 'other', category: 'random',
    text: 'Choose another player: they let something slip. One of their hidden cards, picked at random, is revealed to everyone.' },

  // peek (target other; 'choose' or 'random')
  { id: 'peek-dossier', title: 'Dossier', effect: 'peek', target: 'other', category: 'choose',
    text: `Choose another player and one of their hidden categories: you alone see that card. ${PEEK_TAIL}` },
  { id: 'peek-xray', title: 'X-ray Glasses', effect: 'peek', target: 'other', category: 'choose',
    text: `Choose another player and one of their hidden categories: you alone see that card. ${PEEK_TAIL}` },
  { id: 'peek-stolen-diary', title: 'Stolen Diary', effect: 'peek', target: 'other', category: 'choose',
    text: `Choose another player and one of their hidden categories: you alone see that card. ${PEEK_TAIL}` },
  { id: 'peek-keyhole', title: 'Keyhole', effect: 'peek', target: 'other', category: 'random',
    text: `Choose another player: you alone see one of their hidden cards, picked at random. ${PEEK_TAIL}` },
  { id: 'peek-gossip', title: 'Gossip', effect: 'peek', target: 'other', category: 'random',
    text: `Choose another player: you alone see one of their hidden cards, picked at random. ${PEEK_TAIL}` },
  { id: 'peek-eavesdropping', title: 'Eavesdropping', effect: 'peek', target: 'other', category: 'random',
    text: `Choose another player: you alone see one of their hidden cards, picked at random. ${PEEK_TAIL}` },
  { id: 'peek-bribed-guard', title: 'Bribed Guard', effect: 'peek', target: 'other', category: 'choose',
    text: `Choose another player and one of their hidden categories: you alone see that card. ${PEEK_TAIL}` },
  { id: 'peek-wiretap', title: 'Wiretap', effect: 'peek', target: 'other', category: 'random',
    text: `Choose another player: you alone see one of their hidden cards, picked at random. ${PEEK_TAIL}` },

  // mass_reveal (target none; a Category or 'choose')
  { id: 'mass-health', title: 'Medical Commission', effect: 'mass_reveal', target: 'none', category: 'health',
    text: "Every alive player's Health card is revealed to everyone, yours included." },
  { id: 'mass-biology', title: 'Census', effect: 'mass_reveal', target: 'none', category: 'biology',
    text: "Every alive player's Biology card is revealed to everyone, yours included." },

  // shuffle_category (target none; a Category or 'choose')
  { id: 'shuffle-baggage', title: 'Luggage Carousel', effect: 'shuffle_category', target: 'none', category: 'baggage',
    text: `Every alive player's Baggage card ${SHUFFLE_TAIL}` },

  // immunity (target self), before_vote
  { id: 'immunity-untouchable', title: 'Untouchable', effect: 'immunity', target: 'self',
    text: `${BEFORE_VOTE} Nobody can vote against you ${NEXT_VOTE_TAIL}` },
  { id: 'immunity-diplomatic', title: 'Diplomatic Immunity', effect: 'immunity', target: 'self',
    text: `${BEFORE_VOTE} Nobody can vote against you ${NEXT_VOTE_TAIL}` },

  // protect (target other), before_vote
  { id: 'protect-bodyguard', title: 'Bodyguard', effect: 'protect', target: 'other',
    text: `${BEFORE_VOTE} Choose another player: nobody can vote against them ${NEXT_VOTE_TAIL}` },
  { id: 'protect-alibi', title: 'Alibi', effect: 'protect', target: 'other',
    text: `${BEFORE_VOTE} Choose another player: nobody can vote against them ${NEXT_VOTE_TAIL}` },
  { id: 'protect-human-shield', title: 'Human Shield', effect: 'protect', target: 'other',
    text: `${BEFORE_VOTE} Choose another player: nobody can vote against them ${NEXT_VOTE_TAIL}` },

  // double_vote (target self), anytime
  { id: 'double-megaphone', title: 'Megaphone', effect: 'double_vote', target: 'self',
    text: 'Your vote counts twice in the vote that is running now (revotes included), or in the next vote if none is running. If that vote is cancelled, this is used up too.' },
  { id: 'double-loud-voice', title: 'Loud Voice', effect: 'double_vote', target: 'self',
    text: 'Your vote counts twice in the vote that is running now (revotes included), or in the next vote if none is running. If that vote is cancelled, this is used up too.' },
  { id: 'double-kingmaker', title: 'Kingmaker', effect: 'double_vote', target: 'self',
    text: 'Your vote counts twice in the vote that is running now (revotes included), or in the next vote if none is running. If that vote is cancelled, this is used up too.' },

  // block_vote (target other), before_vote
  { id: 'block-gag-order', title: 'Gag Order', effect: 'block_vote', target: 'other',
    text: `${BEFORE_VOTE} Choose another player: they cannot vote ${NEXT_VOTE_TAIL}` },
  { id: 'block-laryngitis', title: 'Laryngitis', effect: 'block_vote', target: 'other',
    text: `${BEFORE_VOTE} Choose another player: they cannot vote ${NEXT_VOTE_TAIL}` },

  // cancel_vote (target none), anytime
  { id: 'cancel-blackout', title: 'Blackout', effect: 'cancel_vote', target: 'none',
    text: 'If a vote is running (defense and revotes included), the rest of it is cancelled at once. Otherwise the next vote is cancelled. Skipped ejections are made up in later votes.' },
  { id: 'cancel-fire-drill', title: 'Fire Drill', effect: 'cancel_vote', target: 'none',
    text: 'If a vote is running (defense and revotes included), the rest of it is cancelled at once. Otherwise the next vote is cancelled. Skipped ejections are made up in later votes.' },

  // capacity_plus (target none), anytime
  { id: 'capacity-extra-bunk', title: 'Extra Bunk', effect: 'capacity_plus', target: 'none',
    text: 'The bunker gains one bed (capacity +1). If everyone still alive now fits, the game ends at once.' },

  // capacity_minus (target none), before_vote
  { id: 'capacity-cave-in', title: 'Cave-in', effect: 'capacity_minus', target: 'none',
    text: `${BEFORE_VOTE} Part of the bunker collapses and it loses one bed (capacity -1, never below 1).` },

  // bunker_add_feature (target none), anytime
  { id: 'feature-secret-door', title: 'Secret Door', effect: 'bunker_add_feature', target: 'none',
    text: 'You find a sealed door nobody had noticed: a new feature is drawn and added to the bunker for everyone to see. Blessing or curse, it stays.' },
  { id: 'feature-old-blueprints', title: 'Old Blueprints', effect: 'bunker_add_feature', target: 'none',
    text: 'The original plans show a room nobody has explored: a new feature is drawn and added to the bunker for everyone to see.' },
  { id: 'feature-supply-drop', title: 'Supply Drop', effect: 'bunker_add_feature', target: 'none',
    text: 'A crate crashes down by the entrance: a new feature is drawn and added to the bunker for everyone to see.' },
  { id: 'feature-maintenance-log', title: 'Maintenance Log', effect: 'bunker_add_feature', target: 'none',
    text: 'An old logbook mentions a room behind the generator: a new feature is drawn and added to the bunker for everyone to see.' },
];

// The two fixed cards (SPEC §11 X1). They are never in the random pool: the engine deals AIRLOCKS(N) Airlocks to
// different players and REVIVES(N) of these revives to players who hold no Airlock, in every game of 4+ players.
// An Airlock needs a partner: the first one played on a player opens the airlock on them, a second one played on the
// same player by someone else in the same round (before the vote) throws them out; alone it jams when the discussion ends.
export const AIRLOCK_CARD = Object.freeze({
  id: 'airlock', title: 'Airlock', effect: 'airlock', target: 'other',
  text: 'Needs a partner. From round 2, during a reveal or discussion phase, choose a player to start cycling the airlock on them. If another player plays an Airlock on the same player this round before the vote, they are thrown out — no vote. Alone, the airlock jams when the discussion ends. Vote immunity does not stop it.',
});
export const REVIVE_CARD = Object.freeze({
  id: 'revive', title: 'Back from the Forest', effect: 'revive', target: 'ejected',
  text: `${BEFORE_VOTE} Choose an ejected player, whether they were voted out or thrown out through the airlock (not one who left the game): they come back and are alive again. They get no turn in a reveal phase that began without them, and round 7 has the last reveal phase. Later votes may eject more to make up for it.`,
});
/** Effects the random pool never deals (§11 X1): the fixed cards, and the retired one-player Airlock. */
export const FIXED_EFFECTS = Object.freeze(['airlock', 'revive', 'eject']);

// ---------------------------------------------------------------------------------------------
// Random helpers (all driven by the injected rng)
// ---------------------------------------------------------------------------------------------

function makeRandom(rng) {
  const unit = () => {
    const x = Number(rng());
    if (!(x >= 0)) return 0; // NaN or negative
    return x < 1 ? x : 1 - Number.EPSILON;
  };
  const int = (a, b) => a + Math.floor(unit() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(unit() * arr.length)];
  const chance = (p) => unit() < p;
  const weighted = (items, weightOf) => {
    let total = 0;
    for (const it of items) total += weightOf(it);
    let r = unit() * total;
    for (const it of items) {
      r -= weightOf(it);
      if (r < 0) return it;
    }
    return items[items.length - 1];
  };
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(unit() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  return { unit, int, pick, chance, weighted, shuffle };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const SEVERITY = [['mild', 40], ['moderate', 35], ['severe', 25]];

function fill(template, R) {
  return template.replace(/\{([^{}]+)\}/g, (whole, body) => {
    if (body === 'sev') return R.weighted(SEVERITY, (s) => s[1])[0];
    let m = /^n:(\d+)-(\d+)$/.exec(body);
    if (m) return String(R.int(Number(m[1]), Number(m[2])));
    m = /^yrs:(\d+)-(\d+)$/.exec(body);
    if (m) return plural(R.int(Number(m[1]), Number(m[2])), 'year');
    if (body.includes('|')) return R.pick(body.split('|'));
    return whole;
  });
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];

// `ages` (optional, filled in): the age range the profession's years fit, { min, max }. The dealer hands it to the
// Biology card drawn right after it (the engine deals each player's Profession, then their Biology), so a character
// is never "retired after 30 years" at 23 or a first-year student at 80.
function professionText(base, R, ages = {}) {
  ages.min = 18;
  ages.max = 85;
  if (base.includes('(')) {
    const text = fill(base, R);
    const jobless = /\((\d+) years without a job\)/.exec(text);
    if (jobless) ages.min = Number(jobless[1]) + 18;
    const kids = /raised (\d+) children/.exec(text);
    if (kids) ages.min = 20 + Number(kids[1]);
    return text;
  }
  const r = R.unit();
  let mod;
  if (r < 0.60) {
    // skewed towards fewer years
    const n = 1 + Math.floor(Math.pow(R.unit(), 1.4) * 30);
    mod = `${plural(n, 'year')} of experience`;
    ages.min = n + 18;
  } else if (r < 0.69) {
    mod = R.chance(0.3) ? 'intern, first day on the job' : `intern, ${plural(R.int(1, 11), 'month')} in`;
  } else if (r < 0.77) {
    const n = R.int(20, 42);
    mod = `retired after ${n} years`;
    ages.min = n + 22;
  } else if (r < 0.84) {
    const k = R.int(0, ORDINALS.length - 1);
    mod = `student, ${ORDINALS[k]} year`;
    ages.min = 18 + k;
    ages.max = 40;
  } else if (r < 0.90) {
    const n = R.int(1, 15);
    mod = `self-taught, ${plural(n, 'year')}`;
    ages.min = n + 14;
  } else if (r < 0.95) {
    const n = R.int(15, 35);
    mod = `award-winning, ${n} years of experience`;
    ages.min = n + 20;
  } else if (r < 0.98) {
    const n = R.int(2, 20);
    mod = `license revoked after ${plural(n, 'year')}`;
    ages.min = n + 22;
  } else {
    const n = R.int(1, 10);
    mod = `fake diploma, ${plural(n, 'year')} of practice`;
    ages.min = n + 20;
  }
  ages.min = Math.max(18, Math.min(85, ages.min));
  return `${base} (${mod})`;
}

function hobbyText(base, R) {
  if (base.includes('(')) return fill(base, R);
  const r = R.unit();
  if (r < 0.72) return `${base} (${plural(R.int(1, 20), 'year')})`;
  if (r < 0.82) return `${base} (since childhood)`;
  if (r < 0.92) return `${base} (just started)`;
  if (r < 0.97) return `${base} (semi-professional, ${plural(R.int(3, 20), 'year')})`;
  return `${base} (obsessed, ${plural(R.int(1, 15), 'year')})`;
}

const PHOBIA_INTENSITY = ['mild', 'moderate', 'severe', 'panic attacks'];

function phobiaText(base, R) {
  const text = fill(base, R);
  return R.chance(0.55) ? `${text} (${R.pick(PHOBIA_INTENSITY)})` : text;
}

const DECORATE = {
  profession: professionText,
  health: fill,
  hobby: hobbyText,
  phobia: phobiaText,
  skill: fill,
  trait: fill,
  baggage: fill,
};

function drawAge(R) {
  const r = R.unit();
  if (r < 0.05) return R.int(18, 19);
  if (r < 0.85) return R.int(20, 60);
  return 61 + Math.floor(Math.pow(R.unit(), 1.5) * 25); // 61..85, mostly the younger end
}

// `ages`: the age range of the Profession dealt just before (see professionText), or null.
function biologyText(R, ages = null) {
  const female = R.chance(0.5);
  let age = drawAge(R);
  if (ages) {
    for (let i = 0; i < 30 && (age < ages.min || age > ages.max); i++) age = drawAge(R);
    if (age < ages.min || age > ages.max) age = R.int(ages.min, Math.max(ages.min, ages.max));
  }
  const drawn = R.weighted(ORIENTATIONS, (o) => o[1])[0];
  const orientation = drawn === 'gay' && female ? 'lesbian' : drawn;
  const parts = [female ? 'Female' : 'Male', `${age} y.o.`, orientation];
  if (R.chance(BIO_NOTE_CHANCE)) {
    const notes = BIO_NOTES.filter((n) => n.ok(female, age));
    parts.push(fill(R.weighted(notes, (n) => n.w).text, R));
  }
  return parts.join(', ');
}

// Months → "8 months" / "1 year" / "1.5 years" / "2 years 3 months".
function fmtMonths(m) {
  if (m < 12) return plural(m, 'month');
  const y = Math.floor(m / 12);
  const rest = m % 12;
  if (rest === 0) return plural(y, 'year');
  if (rest === 6) return `${y}.5 years`;
  return `${plural(y, 'year')} ${plural(rest, 'month')}`;
}

function fmtRange([a, b]) {
  if (a % 12 === 0 && b % 12 === 0) return `${a / 12}–${plural(b / 12, 'year')}`;
  return `${fmtMonths(a)} to ${fmtMonths(b)}`;
}

function roundMonths(m) {
  if (m >= 18) return Math.round(m / 6) * 6;
  if (m >= 6) return Math.round(m / 3) * 3;
  return Math.max(1, Math.round(m));
}

const DEFAULT_STAY = [6, 72];
const FOOD_RATIOS = [0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 1.25, 1.5, 2];

function bunkerName(R) {
  const r = R.unit();
  if (r < 0.45) return `Bunker "${R.pick(BUNKER_NICKNAMES)}"`;
  if (r < 0.7) return `Shelter No. ${R.int(2, 99)}`;
  return `Object ${R.int(10, 999)}-${R.pick(BUNKER_LETTERS)} "${R.pick(BUNKER_NICKNAMES)}"`;
}

// A shuffled deck of indices 0..size-1. Every index is dealt once per cycle; a new cycle starts when
// the deck runs out. `blocked(i)` lets the caller skip indices (used to avoid duplicate bunker features);
// if every remaining index is blocked, a fresh cycle is started, and a repeat is allowed only if even
// that has no unblocked index.
function makeDeck(size, R) {
  let order = [];
  const refill = () => {
    order = R.shuffle(Array.from({ length: size }, (_, i) => i));
  };
  return {
    draw(blocked) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (order.length === 0) refill();
        for (let i = order.length - 1; i >= 0; i--) {
          if (!blocked || !blocked(order[i])) return order.splice(i, 1)[0];
        }
        refill();
      }
      return order.pop();
    },
  };
}

// Exact-repeat avoidance only looks at the most recent texts per category (about three games' worth),
// so it prevents duplicates at one table without skewing the long-run mix towards rare combinations.
const RECENT_WINDOW = 48;

// `onBase(category, index)` is an optional hook (not part of the public interface) that reports which
// base card a pooled drawCard used; the content verification script uses it.
function buildDealer(rng, onBase) {
  if (typeof rng !== 'function') rng = Math.random;
  const R = makeRandom(rng);
  const decks = {};
  const issued = {};
  for (const c of CATEGORIES) {
    issued[c.id] = [];
    if (POOLS[c.id]) decks[c.id] = makeDeck(POOLS[c.id].length, R);
  }
  const catastropheDeck = makeDeck(CATASTROPHES.length, R);
  const featureDeck = makeDeck(FEATURES.length, R);
  const specialDeck = makeDeck(SPECIALS.length, R);
  let lastStay = null; // `stay` of the most recently drawn catastrophe
  let bunkerFeatures = new Set(); // feature indices the current bunker already has

  // Generate a text, retrying a few times if this dealer issued exactly the same string recently.
  function unique(category, generate) {
    const recent = issued[category];
    let text = generate();
    for (let i = 0; i < 8 && recent.includes(text); i++) text = generate();
    recent.push(text);
    if (recent.length > RECENT_WINDOW) recent.shift();
    return text;
  }

  function drawFeature() {
    const idx = featureDeck.draw((i) => bunkerFeatures.has(i));
    bunkerFeatures.add(idx);
    return fill(FEATURES[idx], R);
  }

  // The age range of the Profession just drawn, for the Biology card drawn right after it (and only then).
  let professionAges = null;

  return {
    drawCard(category) {
      const ages = professionAges;
      professionAges = null;
      if (category === 'biology') return unique('biology', () => biologyText(R, ages));
      const pool = POOLS[category];
      if (!pool) throw new TypeError(`content: unknown category ${String(category)}`);
      const idx = decks[category].draw();
      if (onBase) onBase(category, idx);
      if (category === 'profession') {
        let range = null;
        const text = unique(category, () => { range = {}; return professionText(pool[idx], R, range); });
        professionAges = range;
        return text;
      }
      return unique(category, () => DECORATE[category](pool[idx], R));
    },

    drawSpecial() {
      const card = SPECIALS[specialDeck.draw()];
      const out = { id: card.id, title: card.title, text: card.text, effect: card.effect, target: card.target };
      if (card.category) out.category = card.category;
      return out;
    },

    drawCatastrophe() {
      const c = CATASTROPHES[catastropheDeck.draw()];
      lastStay = c.stay;
      return {
        title: c.title,
        text: c.text,
        details: [...c.details.map((d) => fill(d, R)), `Estimated time until the surface is safe: ${fmtRange(c.stay)}`],
      };
    },

    drawBunker() {
      const [lo, hi] = lastStay || DEFAULT_STAY;
      const stay = Math.min(hi, Math.max(lo, roundMonths(R.int(lo, hi))));
      const food = roundMonths(Math.max(1, stay * R.pick(FOOD_RATIOS)));
      bunkerFeatures = new Set();
      const count = R.int(3, 5);
      const features = [];
      for (let i = 0; i < count; i++) features.push(drawFeature());
      return {
        name: bunkerName(R),
        size: `${R.int(12, 60) * 5} m²`,
        duration: `You must stay ${fmtMonths(stay)}`,
        food: `Food for ${fmtMonths(food)}`,
        features,
      };
    },

    drawBunkerFeature() {
      return drawFeature();
    },
  };
}

export function createDealer(rng = Math.random) {
  return buildDealer(rng);
}
