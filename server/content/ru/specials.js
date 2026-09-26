// Russian special condition cards. Owner: ru-rules (reports/i18n-design.md §12); checkpoint B1 stub.
//
// Fill `default` with the same ids and keys as ../en/specials.js, and set COMPLETE = true once every entry is translated
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
// Shape: { '<id>': { title, text } } for the 55 ids of ../en/specials.js: the 52 of the random pool, then airlock,
// revive and fallback-feature. Plain text, no placeholders. Card titles are quoted «…» wherever other text names them,
// and stay in the nominative («играет «Алиби»»). Fixed by the glossary (§10.1): airlock «Шлюз» (start = запустить шлюз,
// seal = задраить, jammed = заклинило), revive «Вернулся из леса» (owner-mandated). The titles come first (checkpoint
// R1): public/i18n/ru.js copies them into the rules sheet and hints, and the §11 glossary check holds both sides.
// The text is a rule: address the player as ты («Выбери другого игрока…»).
// Checkpoint R1 (2026-09-26): the 55 titles below are frozen, growth only (.scratch/ru-rules/R1.md). Each text says
// what the engine does (SPEC §5, §11 X1), as ../en/specials.js does, in the same order and with the same shared tails.

const BEFORE_VOTE = 'Сыграть можно только во время раскрытия или обсуждения.';
const SWAP_TAIL = 'Обе карты открываются всем.';
const REROLL_TAIL = 'сбрасывается, а вместо неё вытягивается новая и сразу открывается всем.';
const PEEK_TAIL = 'Она попадает в твои «Разведданные» и остаётся скрытой от остальных: они узнают лишь, что ты подсматриваешь.';
const SHUFFLE_TAIL = 'собираются, тасуются и раздаются обратно наугад, по одной на каждого (тебе может достаться и твоя же). Каждая из них открывается всем.';
const USED_UP = 'Если это голосование отменят, эффект всё равно сгорает.';
const NEXT_VOTE_TAIL = `до конца следующего голосования, включая переголосование. ${USED_UP}`;
const FEATURE_TAIL = 'в бункер добавляется новая случайная особенность, и её видят все.';

export const COMPLETE = true;

export default {
  // swap_card (target other; a Category or 'choose')
  'swap-baggage': {
    title: 'Бартер',
    text: `Выбери другого игрока: вы меняетесь картами багажа. ${SWAP_TAIL}`,
  },
  'swap-profession': {
    title: 'Смена профессии',
    text: `Выбери другого игрока: вы меняетесь картами профессии. ${SWAP_TAIL}`,
  },
  'swap-health': {
    title: 'Донор органов',
    text: `Выбери другого игрока: вы меняетесь картами здоровья. ${SWAP_TAIL} Будем надеяться, что худшую из двух отдаёшь ты.`,
  },
  'swap-hobby': {
    title: 'Обмен увлечениями',
    text: `Выбери другого игрока: вы меняетесь картами хобби. ${SWAP_TAIL}`,
  },
  'swap-phobia': {
    title: 'Передай страх',
    text: `Выбери другого игрока: вы меняетесь картами фобии. ${SWAP_TAIL}`,
  },
  'swap-trait': {
    title: 'Пересадка личности',
    text: `Выбери другого игрока: вы меняетесь картами характера. ${SWAP_TAIL}`,
  },
  'swap-biology': {
    title: 'Обмен телами',
    text: `Выбери другого игрока: вы меняетесь картами биологии — вместе с полом, возрастом и всем прочим. ${SWAP_TAIL}`,
  },
  'swap-choose': {
    title: 'Честный обмен',
    text: `Выбери другого игрока и любую характеристику: вы меняетесь этими картами. ${SWAP_TAIL}`,
  },

  // reroll_card (target self or other; a Category or 'choose')
  'reroll-self-health': {
    title: 'Чудесное исцеление',
    text: `Твоя карта здоровья ${REROLL_TAIL} Может, станет лучше. Может, хуже.`,
  },
  'reroll-self-profession': {
    title: 'Вечерние курсы',
    text: `Твоя карта профессии ${REROLL_TAIL}`,
  },
  'reroll-self-phobia': {
    title: 'Клин клином',
    text: `Твоя карта фобии ${REROLL_TAIL} Старый страх долой — да здравствует новый.`,
  },
  'reroll-self-baggage': {
    title: 'Бюро находок',
    text: `Твоя карта багажа ${REROLL_TAIL}`,
  },
  'reroll-self-choose': {
    title: 'С чистого листа',
    text: `Выбери любую свою характеристику: эта карта ${REROLL_TAIL}`,
  },
  'reroll-other-baggage': {
    title: 'Потерянный багаж',
    text: `Выбери другого игрока: его карта багажа ${REROLL_TAIL}`,
  },
  'reroll-other-trait': {
    title: 'Промывка мозгов',
    text: `Выбери другого игрока: его карта характера ${REROLL_TAIL}`,
  },
  'reroll-other-health': {
    title: 'Заразный чих',
    text: `Выбери другого игрока: его карта здоровья ${REROLL_TAIL}`,
  },
  'reroll-other-choose': {
    title: 'Переписать историю',
    text: `Выбери другого игрока и любую характеристику: его карта этой характеристики ${REROLL_TAIL}`,
  },

  // force_reveal (target other; 'choose' or 'random')
  'reveal-interrogation': {
    title: 'Допрос',
    text: 'Выбери другого игрока и одну из его скрытых карт: она открывается всем.',
  },
  'reveal-background-check': {
    title: 'Проверка биографии',
    text: 'Выбери другого игрока и одну из его скрытых карт: она открывается всем. В бункере секретов не бывает.',
  },
  'reveal-subpoena': {
    title: 'Повестка в суд',
    text: 'Выбери другого игрока и одну из его скрытых карт: она открывается всем — хочет он того или нет.',
  },
  'reveal-truth-serum': {
    title: 'Сыворотка правды',
    text: 'Выбери другого игрока: одна его скрытая карта, выбранная наугад, открывается всем.',
  },
  'reveal-paparazzi': {
    title: 'Папарацци',
    text: 'Выбери другого игрока: одна его скрытая карта, выбранная наугад, открывается всем. Улыбочку — сейчас вылетит птичка.',
  },
  'reveal-loose-lips': {
    title: 'Длинный язык',
    text: 'Выбери другого игрока: он кое-что выбалтывает. Одна его скрытая карта, выбранная наугад, открывается всем.',
  },

  // peek (target other; 'choose' or 'random')
  'peek-dossier': {
    title: 'Досье',
    text: `Выбери другого игрока и одну из его скрытых карт: её видишь только ты. ${PEEK_TAIL}`,
  },
  'peek-xray': {
    title: 'Рентгеновские очки',
    text: `Выбери другого игрока и одну из его скрытых карт: её видишь только ты. ${PEEK_TAIL}`,
  },
  'peek-stolen-diary': {
    title: 'Украденный дневник',
    text: `Выбери другого игрока и одну из его скрытых карт: её видишь только ты. ${PEEK_TAIL}`,
  },
  'peek-keyhole': {
    title: 'Замочная скважина',
    text: `Выбери другого игрока: только ты видишь одну его скрытую карту, выбранную наугад. ${PEEK_TAIL}`,
  },
  'peek-gossip': {
    title: 'Сплетни',
    text: `Выбери другого игрока: только ты видишь одну его скрытую карту, выбранную наугад. ${PEEK_TAIL}`,
  },
  'peek-eavesdropping': {
    title: 'Подслушивание',
    text: `Выбери другого игрока: только ты видишь одну его скрытую карту, выбранную наугад. ${PEEK_TAIL}`,
  },
  'peek-bribed-guard': {
    title: 'Продажный охранник',
    text: `Выбери другого игрока и одну из его скрытых карт: её видишь только ты. ${PEEK_TAIL}`,
  },
  'peek-wiretap': {
    title: 'Прослушка',
    text: `Выбери другого игрока: только ты видишь одну его скрытую карту, выбранную наугад. ${PEEK_TAIL}`,
  },

  // mass_reveal (target none; a Category or 'choose')
  'mass-health': {
    title: 'Медкомиссия',
    text: 'Карты здоровья всех, кто ещё в игре, открываются всем — и твоя тоже.',
  },
  'mass-biology': {
    title: 'Перепись населения',
    text: 'Карты биологии всех, кто ещё в игре, открываются всем — и твоя тоже.',
  },

  // shuffle_category (target none; a Category or 'choose')
  'shuffle-baggage': {
    title: 'Багажная карусель',
    text: `Карты багажа всех, кто ещё в игре, ${SHUFFLE_TAIL}`,
  },

  // immunity (target self), before_vote
  'immunity-untouchable': {
    title: 'Неприкосновенность',
    text: `${BEFORE_VOTE} Против тебя нельзя голосовать ${NEXT_VOTE_TAIL}`,
  },
  'immunity-diplomatic': {
    title: 'Дипломатический иммунитет',
    text: `${BEFORE_VOTE} Против тебя нельзя голосовать ${NEXT_VOTE_TAIL}`,
  },

  // protect (target other), before_vote
  'protect-bodyguard': {
    title: 'Телохранитель',
    text: `${BEFORE_VOTE} Выбери другого игрока: против него нельзя голосовать ${NEXT_VOTE_TAIL}`,
  },
  'protect-alibi': {
    title: 'Алиби',
    text: `${BEFORE_VOTE} Выбери другого игрока: против него нельзя голосовать ${NEXT_VOTE_TAIL}`,
  },
  'protect-human-shield': {
    title: 'Живой щит',
    text: `${BEFORE_VOTE} Выбери другого игрока: против него нельзя голосовать ${NEXT_VOTE_TAIL}`,
  },

  // double_vote (target self), anytime
  'double-megaphone': {
    title: 'Мегафон',
    text: `Твой голос считается за два в голосовании, которое идёт сейчас (включая переголосование), или в следующем, если сейчас голосования нет. ${USED_UP}`,
  },
  'double-loud-voice': {
    title: 'Лужёная глотка',
    text: `Твой голос считается за два в голосовании, которое идёт сейчас (включая переголосование), или в следующем, если сейчас голосования нет. ${USED_UP}`,
  },
  'double-kingmaker': {
    title: 'Серый кардинал',
    text: `Твой голос считается за два в голосовании, которое идёт сейчас (включая переголосование), или в следующем, если сейчас голосования нет. ${USED_UP}`,
  },

  // block_vote (target other), before_vote
  'block-gag-order': {
    title: 'Приказ молчать',
    text: `${BEFORE_VOTE} Выбери другого игрока: он не может голосовать ${NEXT_VOTE_TAIL}`,
  },
  'block-laryngitis': {
    title: 'Ларингит',
    text: `${BEFORE_VOTE} Выбери другого игрока: он не может голосовать ${NEXT_VOTE_TAIL}`,
  },

  // cancel_vote (target none), anytime
  'cancel-blackout': {
    title: 'Блэкаут',
    text: 'Если сейчас идёт голосование (включая защиту и переголосование), всё, что от него осталось, тут же отменяется. Иначе отменяется следующее голосование. Несостоявшиеся изгнания переносятся на следующие голосования.',
  },
  'cancel-fire-drill': {
    title: 'Учебная тревога',
    text: 'Если сейчас идёт голосование (включая защиту и переголосование), всё, что от него осталось, тут же отменяется. Иначе отменяется следующее голосование. Несостоявшиеся изгнания переносятся на следующие голосования.',
  },

  // capacity_plus (target none), anytime
  'capacity-extra-bunk': {
    title: 'Раскладушка',
    text: 'В бункере появляется ещё одна койка (вместимость +1). Если теперь все, кто ещё в игре, помещаются в бункер, игра тут же заканчивается.',
  },

  // capacity_minus (target none), before_vote
  'capacity-cave-in': {
    title: 'Обвал',
    text: `${BEFORE_VOTE} Часть бункера обрушивается, и коек в нём становится на одну меньше (вместимость −1, но не ниже 1).`,
  },

  // bunker_add_feature (target none), anytime
  'feature-secret-door': {
    title: 'Потайная дверь',
    text: `Ты находишь наглухо заваренную дверь, мимо которой все проходили: ${FEATURE_TAIL} Благо это или проклятие — особенность остаётся.`,
  },
  'feature-old-blueprints': {
    title: 'Старые чертежи',
    text: `На исходных чертежах обнаруживается неисследованная комната: ${FEATURE_TAIL}`,
  },
  'feature-supply-drop': {
    title: 'Сброс припасов',
    text: `У самого входа с грохотом падает ящик: ${FEATURE_TAIL}`,
  },
  'feature-maintenance-log': {
    title: 'Журнал техобслуживания',
    text: `В старом журнале упоминается комната за генератором: ${FEATURE_TAIL}`,
  },

  // The fixed cards (never in the random pool).
  'airlock': {
    title: 'Шлюз',
    text: 'Нужен напарник. С раунда\u00a02, во время раскрытия или обсуждения, выбери другого игрока и запусти на него шлюз. Если в этом же раунде до голосования кто-то ещё сыграет на него второй «Шлюз», твоя цель вылетает из бункера — без голосования. Без напарника шлюз заклинит, когда закончится обсуждение. Иммунитет на голосовании от шлюза не спасает.',
  },
  'revive': {
    title: 'Вернулся из леса',
    text: `${BEFORE_VOTE} Выбери игрока из леса — неважно, изгнали его голосованием или выбросили через шлюз (вышедших из игры вернуть нельзя): он возвращается в игру. В раскрытии, которое началось без него, хода у него нет, а последнее раскрытие — в раунде\u00a07. Следующие голосования могут изгнать больше игроков, чтобы это возместить.`,
  },
  // The engine's stand-in when the dealer offers no usable card (never dealt from the pool).
  'fallback-feature': {
    title: 'Тайная комната',
    text: 'Добавь в бункер новую особенность.',
  },
};
