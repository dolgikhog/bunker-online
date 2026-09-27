// English catastrophes (SPEC §5; reports/i18n-design.md §6.1, §6.4): 18 entries, keyed by the content id that
// public/audio/narration.json names each catastrophe's clips by (SPEC §11 X5.16), which the client uses to find them.
//
// Today's strings, verbatim. Title and text are plain text. Each detail line may hold {n:a-b} placeholders (a whole
// number from a to b, drawn when the catastrophe is dealt); ../ru/catastrophes.js refers to them by position ({0}).
// The key order is the deck order. How long the surface stays unsafe (`stay`) is language-neutral: ../gen.js.
export default {
  list: {
    'nuclear-winter': {
      title: 'Nuclear Winter',
      text: 'A border dispute turned into a full nuclear exchange in under an hour. Smoke from burning cities now blocks the sun, and the planet is freezing. Crops have failed everywhere at once.',
      details: [
        "Survivors: about {n:3-8}% of the world's population",
        'Surface: -{n:30-50}°C, permanent twilight, radioactive fallout',
        'Threats: cold, radiation, starving raiders',
      ],
    },
    'the-gray-fever': {
      title: 'The Gray Fever',
      text: 'A fever that turns the skin ash-gray moved through airports faster than any quarantine. Most of the infected die within a week, and the few who recover stay contagious. The hospitals stopped answering the phone on day twelve.',
      details: [
        'Survivors: about {n:5-15}%, many of them carriers',
        'Surface: abandoned cities, no power, no running water',
        'Threats: infection, contaminated water, looted pharmacies',
      ],
    },
    'asteroid-impact': {
      title: 'Asteroid Impact',
      text: 'An asteroid ten kilometers wide, spotted only three weeks in advance, struck the Pacific. Tsunamis erased the coastlines and falling debris started fires on every continent. The dust will not settle for years.',
      details: [
        'Survivors: about {n:1-4}%',
        'Surface: dust storms, acid rain, temperature swings of 40°C in a day',
        'Threats: earthquakes, collapsing buildings, wildfires',
      ],
    },
    'supervolcano': {
      title: 'Supervolcano',
      text: 'The supervolcano under Yellowstone woke up after 640,000 years. Half a continent lies under ash, and sulfur in the upper atmosphere has brought a volcanic winter. Breathing outside without a mask burns the lungs.',
      details: [
        'Survivors: about {n:10-25}%',
        'Surface: ash drifts several meters deep, sulfuric haze',
        'Threats: toxic air, lung disease, failed harvests',
      ],
    },
    'machine-uprising': {
      title: 'Machine Uprising',
      text: "An overnight software update gave the world's logistics AI a new goal, and people turned out to be in the way. Self-driving trucks, drones and factory robots now hunt anything with a heartbeat. Nothing connected to a network can be trusted.",
      details: [
        'Survivors: about {n:10-20}%',
        'Surface: drones patrol the cities; the power grid now runs only for machines',
        "Threats: drones, networked devices, cameras (the machines' solar plants are failing without maintenance)",
      ],
    },
    'the-visitors': {
      title: 'The Visitors',
      text: 'Silver ships appeared over every capital and asked, politely, for everyone to go indoors. People who stayed outside simply vanished. The ships are still up there, and they seem to be waiting for something.',
      details: [
        'Survivors: about {n:25-40}%, all of them in hiding',
        'Surface: intact but deserted; strange lights at night',
        'Threats: abduction beams, and whatever the visitors want',
      ],
    },
    'the-great-flood': {
      title: 'The Great Flood',
      text: 'The Antarctic ice shelves collapsed in a single summer and the sea rose by tens of meters. Coastal cities are under water and the inland is overrun by storms and refugees. The bunker is on high ground, for now.',
      details: [
        'Survivors: about {n:15-30}%',
        'Surface: permanent storms, flooded lowlands, salt in the soil',
        'Threats: hurricanes, disease, fights over dry land',
      ],
    },
    'solar-superflare': {
      title: 'Solar Superflare',
      text: 'The Sun released the largest flare ever recorded. Every transformer on Earth burned out within seconds, satellites fell from orbit, and the damaged ozone layer now lets through deadly ultraviolet light.',
      details: [
        'Survivors: about {n:20-40}%',
        'Surface: sunburn in minutes, no electricity anywhere, dead electronics',
        'Threats: UV radiation, skin cancer, famine, the collapse of order',
      ],
    },
    'spore-rain': {
      title: 'Spore Rain',
      text: 'A meteor shower seeded the upper atmosphere with fungal spores from somewhere else. Wherever they land, gray mold covers everything within days: crops, animals, and people who breathe it in. It dies only in sealed, filtered air.',
      details: [
        'Survivors: about {n:5-12}%',
        'Surface: gray mold on every surface, spore clouds at dawn',
        'Threats: inhaled spores, contaminated food, mold-covered wildlife',
      ],
    },
    'the-yellow-cloud': {
      title: 'The Yellow Cloud',
      text: 'An explosion at a chemical plant released a cloud that did not spread thin. It grew. The yellow fog has crossed three countries, everything it touches corrodes, and it is heavier than air, so it pools in the lowlands.',
      details: [
        'Survivors: about {n:30-50}% (the disaster is regional, for now)',
        'Surface: yellow fog in the valleys, corroded metal, dead forests',
        'Threats: chemical burns, poisoned water',
      ],
    },
    'new-ice-age': {
      title: 'New Ice Age',
      text: 'The ocean currents that warmed the northern hemisphere stopped almost overnight. Within a year, glaciers were advancing across Europe and North America, and winter never ended. The equator is packed with desperate refugees.',
      details: [
        'Survivors: about {n:20-35}%',
        'Surface: -{n:40-60}°C, endless blizzards',
        'Threats: frostbite, hunger, wolf packs moving south',
      ],
    },
    'gray-goo': {
      title: 'Gray Goo',
      text: 'Self-replicating nanobots built to clean up oil spills escaped and never stopped. They take apart anything organic or metal to build more of themselves, and the landscape is turning into gray dust. They cannot get through thick concrete.',
      details: [
        'Survivors: about {n:2-6}%',
        'Surface: dunes of gray dust where cities used to be',
        'Threats: nanobot swarms moving at walking speed (they should die out once their energy runs out)',
      ],
    },
    'the-biting-plague': {
      title: 'The Biting Plague',
      text: 'A mutated strain of rabies turned the infected into aggressive, mindless hunters. One bite is enough, and the symptoms start within the hour. The infected never tire, but they are blind in the dark and slow in the cold.',
      details: [
        'Survivors: about {n:3-10}%',
        'Surface: overrun cities, packs of infected roaming at dusk',
        'Threats: bites, scratches, infected blood (the infected should starve out in time)',
      ],
    },
    'silent-spring': {
      title: 'Silent Spring',
      text: 'A modified pesticide spread through the soil and wiped out almost every insect on Earth. With no pollinators, the crops failed, the birds starved, and the food chain collapsed. People are now fighting over the last grain stores.',
      details: [
        'Survivors: about {n:25-45}%',
        'Surface: silent fields, dying forests, rotting fruit',
        'Threats: famine, riots, soil turning to dust',
      ],
    },
    'gamma-ray-burst': {
      title: 'Gamma-Ray Burst',
      text: 'A dying star thousands of light-years away sent a burst of gamma rays straight at Earth. The day side of the planet was sterilized in ten seconds, and the ozone layer is gone. The survivors were on the night side, underground or under water.',
      details: [
        'Survivors: about {n:30-45}%',
        'Surface: deadly UV light, radiation, burning forests',
        'Threats: UV burns, cancer, failed harvests',
      ],
    },
    'the-barren-plague': {
      title: 'The Barren Plague',
      text: "A virus with symptoms like a mild cold infected nearly everyone before doctors noticed its side effect: complete infertility. No child has been born anywhere for months. The bunker's sealed air protects the last fertile people, so humanity's future depends on who goes in.",
      details: [
        'Survivors: about {n:85-95}% alive, but almost everyone is now sterile',
        'Surface: society still stands, but in full panic',
        'Threats: the airborne virus; officials hunting for fertile people',
      ],
    },
    'pole-reversal': {
      title: 'Pole Reversal',
      text: "Earth's magnetic field collapsed while the poles swapped places. Without it, the solar wind strips the atmosphere, radiation storms sweep the surface, and every compass is useless. Migrating animals have lost their way.",
      details: [
        'Survivors: about {n:15-30}%',
        'Surface: auroras at noon, radiation storms',
        'Threats: radiation, burned-out electronics, no way to navigate',
      ],
    },
    'scorched-earth': {
      title: 'Scorched Earth',
      text: 'The methane locked in the Arctic permafrost escaped all at once, and the planet overheated within a decade. Summer temperatures reach 60°C, the rivers have dried up and forests burn for months. Only underground is it cool enough to sleep.',
      details: [
        'Survivors: about {n:10-25}%',
        'Surface: +{n:50-65}°C at noon, smoke, dust storms',
        'Threats: heatstroke, thirst, wildfires',
      ],
    },
  },
  // The last detail line of every catastrophe. {range}: the catastrophe's stay (in months) as ./bunker.js range()
  // renders it ("2–6 years", "6 months to 2 years").
  safe: 'Estimated time until the surface is safe: {range}',
  // The engine's stand-in title when the dealer fails (such a catastrophe has no text and no details).
  fallbackTitle: 'Catastrophe',
};
