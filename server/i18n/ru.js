// server/i18n/ru.js — every server message and error in Russian (SPEC §11 X5.3, X5.5, X5.6; reports/i18n-design.md
// §4, §5, §10).
//
// Owner: ru-rules. i18n-server created this stub at checkpoint A1 and never edits it again.
//
// - Keys: those of ./en.js, with the same params. ./index.js SCHEMA gives each key's params and their types, and
//   .scratch/i18n-server/checkpoint-changes.md lists every key added after A1. No key that en.js lacks.
// - Values: a template string or a function (p, f) => …, exactly as described at the top of ./en.js. A key may be a
//   template here where en.js has a function, or the other way round.
// - Style: report §10 is binding (ты to the viewer; player names never declined; no gendered form about a player or
//   the viewer; «» quotes; the glossary). Report §4 and §5 have notes for the hard keys, §10.5 has drafts.
// - The `field` and `type` params of err.missingField, err.invalidField, err.optionRange and err.notGameAction are
//   protocol identifiers in Latin: leave them out of the Russian text (report §5).
// - `fmt.quote` is how a special card's title is quoted in a log line («{title}»); `word.airlock` is the chip word of
//   the Airlock (шлюз; `{airlock@cap}` capitalises it); `word.nobody` is what an empty list of players prints.
// - The `log.dev.*` and `err.dev.*` keys only appear on a dev server (BUNKER_DEV=1, §11 X9, whose tools are
//   English-only); translating them is optional, and until they are here they stay English.
//
// Until COMPLETE is true, a key missing here falls back to English (with one warning per key).
//
// How the Russian stays correct without knowing anyone's gender (ru-rules, R2):
// - A player name is the subject of a present-tense verb («Анна выходит из игры»), stands after a colon («Новый
//   ведущий: Анна», «Изгнание: Анна остаётся в лесу»), or follows a declined noun in apposition («у игрока Анна»,
//   «игроку Анна», «на игрока Анна»). Names are never declined, and no past tense or short participle is ever about a
//   player or the viewer. Past forms here agree with a thing («сработало особое условие», «шлюз … запущен») or head a
//   list («Остались в лесу:», «воздержались:», rule 9).
// - A printed number is followed by its word in the three plural forms («{k} {k|игрок|игрока|игроков}»), a verb that
//   agrees with it takes them too («{k|останется|останутся|останутся}»), and a word whose number is not printed takes
//   two («{k|изгнание переносится|изгнания переносятся}»). Where Russian would decline the number itself, the number
//   comes after its noun («с раунда {n}», «ботов: {n}»).
// - A category takes the case its sentence needs: `@acc` («раскрывает профессию»), `@gen` («карты здоровья»,
//   «меняются картами багажа»: a swap names the cards, since «меняются багажом» wants a plural noun), `@nom` («здоровье
//   игрока Анна»). Card titles stay in the nominative inside «».
// - A ballot is «тур» (the vote step «голосование» has one or more «туров»); a bed is «койка», never «место».

export const COMPLETE = true;

/** A row of res.mass / res.shuffle: «Анна — «Астма»». */
const cardRows = (f, rows) => f.join(rows.map((r) => f.t('{p} — «{c}»', r)), '; ');

export default {
  // ---------------------------------------------------------------------------------------------- members and host
  'log.join': '{p} садится за стол',
  'log.watch': '{p} заходит зрителем',
  'log.seat': '{p} переходит из зрителей за стол',
  'log.leftLobby': '{p} выходит из комнаты',
  'log.leftGame': '{p} выходит из игры',
  'log.kicked': 'Ведущий удаляет из игры: {p}',
  'log.specLeft': '{p} (зритель) выходит из комнаты',
  'log.specKicked': 'Ведущий удаляет зрителя: {p}',
  'log.host': (p, f) => (p.why ? f.t('{why} — новый ведущий: {p}') : f.t('Новый ведущий: {p}')),
  'host.offline': '{p} давно не на связи',
  'host.handover': '{p} передаёт роль ведущего',

  // ---------------------------------------------------------------------------------------------- game flow
  'log.gameBegins': 'Игра начинается: {n} {n|игрок|игрока|игроков}, {beds} {beds|койка|койки|коек}. Катастрофа: {cata}. Бункер: {bname}.',
  'log.endGame': 'Ведущий завершает игру',
  'log.backToLobby': 'Назад в лобби — стол тот же, а карты в следующей игре новые',
  'log.roundReveal': 'Раунд {r} из {max} — раскрытие карт ({asc:по убыванию|по возрастанию} номеров мест){first:|. Все раскрывают профессию}',
  'log.discussion': (p, f) => f.t(
    p.mode === 'vote' ? '{rp}обсуждение, затем голосование: снаружи {k|останется|останутся|останутся} {k} {k|игрок|игрока|игроков}'
      : p.mode === 'cancelled' ? '{rp}обсуждение, а голосование после него отменено'
        : '{rp}обсуждение, голосования в этом раунде нет'),
  'log.overtime': 'Овертайм — бункер всё ещё переполнен ({alive} {alive|игрок|игрока|игроков} на {beds} {beds|койку|койки|коек}): обсуждайте и голосуйте снова',
  'log.doorCloses': 'Дверь бункера закрывается. В бункере: {in}. Остались в лесу: {out}.',
  'log.reveal': '{rp}{p} раскрывает {cat@acc}: {card}{auto:| (автоматически)}',

  // ---------------------------------------------------------------------------------------------- the vote step
  'log.voteSkipped': '{rp}голосование отменяется (сработало особое условие); {k|изгнание переносится|изгнания переносятся}{mods}',
  'log.ballotsFewer': (p, f) => f.t(`{rp}${p.why ? '{why}, поэтому ' : ''}${p.fewer === 1 ? 'изгнаний будет на одно меньше' : 'изгнаний будет меньше на {fewer}'}: в этом голосовании теперь {n} {n|тур|тура|туров} вместо {before}`),
  'why.gone': 'игрок {p} выбывает',
  'why.bed': 'в бункере стало на одну койку больше',
  'log.voteStep': '{rp}голосование: снаружи {k|останется|останутся|останутся} {k} {k|игрок|игрока|игроков}',
  'log.noMoreDue': '{rp}больше изгнаний в этом голосовании не будет',
  'log.allImmune': '{rp}у всех иммунитет: остаток голосования отменяется',
  'log.stepCancelled': '{rp}{earlier:голосование заканчивается без изгнания|больше изгнаний в этом голосовании не будет}{mods}',
  'mods.used': '. Вместе с голосованием {n|сгорает|сгорают}: {items@and}',
  'mod.immune': 'иммунитет игрока {p}',
  'mod.blocked': 'запрет голосовать для игрока {p}',
  'mod.double': 'двойной голос игрока {p}',
  'log.tally': (p, f) => [
    f.t('{rp}{revote:голосование|переголосование}, тур {ballot} из {ballots}: '),
    f.join(p.rows.map((row) => (row.voters.length
      ? f.t('{t} {votes} ({voters})', { t: row.t, votes: row.votes, voters: row.voters.map((v) => (v.x2 ? f.t('{p} ×2', v) : v.p)) })
      : f.t('{t} {votes}', row))), '; '),
    p.abstained.length ? f.t('; воздержались: {abstained}') : '',
  ],
  'log.tie': '{rp}ничья: {ids@and}. Сначала речи в защиту, затем переголосование',
  'log.nobodyLeft': '{rp}в этом туре изгонять больше некого',
  'log.revote': '{rp}переголосование: {ids@and}',
  'log.eject': '{how:|Голосов нет — решает судьба. |Снова ничья — решает судьба. }Изгнание: {p} остаётся в лесу',

  // ---------------------------------------------------------------------------------------------- the airlock (§11 X1)
  'log.airlockStart': '🚪 {a} запускает {airlock} на игрока {t}. Если до конца {ot:обсуждения этого раунда|обсуждения в овертайме} кто-то ещё сыграет на игрока {t} карту «Шлюз», {t} вылетает из бункера — без голосования.',
  'log.airlockSeal': '🚪 {a} и {by@and} задраивают {airlock} — {t} вылетает из бункера без голосования!',
  'log.airlockJam': '🚪 {airlock@cap} на игрока {t} заклинило — задраить его было некому.',

  // ---------------------------------------------------------------------------------------------- specials and their results
  'log.special': '{rp}{p} играет {card}{cardtext} → {result}',
  'res.swap': '{a} и {b} меняются картами {cat@gen}: теперь у игрока {a} — «{ca}», у игрока {b} — «{cb}»',
  'res.reroll': 'карта {cat@gen} игрока {t} заменяется новой: «{c}»',
  'res.force': '{t} поневоле раскрывает {cat@acc}: «{c}»',
  'res.peek': '{p} тайком заглядывает в одну из скрытых карт игрока {t}',
  'res.mass': (p, f) => f.t('карты {cat@gen} открываются у всех: {rows}', { cat: p.cat, rows: cardRows(f, p.rows) }),
  'res.shuffle': (p, f) => f.t('все карты {cat@gen} тасуются и раздаются заново в открытую: {rows}', { cat: p.cat, rows: cardRows(f, p.rows) }),
  'res.protect': 'на следующем голосовании против игрока {t} голосовать нельзя',
  'res.double': 'голос игрока {p} считается за два {now:на следующем|на этом} голосовании',
  'res.block': '{t} лишается голоса на следующем голосовании',
  'res.cancelNow': 'голосование отменяется прямо сейчас; изгнания переносятся',
  'res.cancelRest': 'остаток голосования отменяется прямо сейчас; несостоявшиеся изгнания переносятся',
  'res.cancelNext': 'следующего голосования не будет',
  'res.eject': 'изгнание: {t} остаётся в лесу',
  'res.revive': '{t} возвращается в игру{when:| (и ещё успевает на свой ход в этом раунде)| (со следующего раунда)}',
  'res.beds': 'теперь в бункере {n} {n|койка|койки|коек}',
  'res.bedsMin': 'в бункере и так всего {n} {n|койка|койки|коек}',
  'res.feature': 'в бункере появляется новая особенность: «{f}»',

  // ---------------------------------------------------------------------------------------------- notes, timer, prefixes, words
  'note.peek': '{rp@bare}: {cat@nom} игрока {t} — «{c}»',
  'timer.turn': 'Ход: {p}',
  'timer.defense': 'Защита: {p}',
  'timer.discussion': 'Обсуждение',
  'timer.otDiscussion': 'Обсуждение в овертайме',
  'rp': 'Раунд {r} — ',
  'rp.ot': 'Овертайм — ',
  'rp.bare': 'Раунд {r}',
  'rp.otBare': 'Овертайм',
  'kick.reason': 'Тебя удалили из комнаты',
  'fmt.quote': '«{title}»',
  'word.airlock': 'шлюз',
  'word.nobody': 'никого',
  'special.untitled': 'Особое условие',

  // ---------------------------------------------------------------------------------------------- dev mode (§11 X9)
  // Only on a BUNKER_DEV=1 server. The literal «[dev]» and the op names stay as they are (report §12, A1 notes).
  'log.dev.seed': '[dev] Раздачи в этой комнате идут по сиду «{seed}»',
  'log.dev.giveSpecial': '[dev] {a} выдаёт игроку {t} особое условие {card}',
  'log.dev.autoReveal': '[dev] {a} автоматически завершает раскрытие ({rp@bare})',
  'log.dev.skipToVote': '[dev] {a} перематывает игру к следующему голосованию',
  'log.dev.forceTie': '[dev] {a} устраивает ничью: {ids@and}',
  'log.dev.god': '[dev] {a} {on:выключает|включает} режим бога (только на своём экране)',
  'log.dev.fastTimers': '[dev] {a} ставит все таймеры на {secs} с',
  'log.dev.addBots': '[dev] {a} добавляет ботов: {n} ({seated:смотрят как зрители — сесть за стол можно только в лобби|садятся за стол})',

  // ---------------------------------------------------------------------------------------------- errors: the default per code
  'err.bad_request': 'Некорректный запрос',
  'err.not_in_room': 'Ты не в комнате',
  'err.no_room': 'Такой комнаты нет',
  'err.bad_token': 'Это место больше недоступно',
  'err.server_busy': 'Сервер перегружен, попробуй позже',
  'err.room_full': 'Комната заполнена',
  'err.not_host': 'Это может только ведущий',
  'err.wrong_phase': 'Сейчас этого сделать нельзя',
  'err.not_your_turn': 'Сейчас не твой ход',
  'err.not_allowed': 'Так нельзя',
  'err.replaced': 'Это место открыто где-то ещё',

  // ---------------------------------------------------------------------------------------------- errors: the engine
  // err.missingField, err.invalidField, err.optionRange and err.notGameAction leave out their Latin `field`/`type`.
  'err.expectedObject': 'Некорректный запрос: ожидается объект',
  'err.unknownType': 'Неизвестный тип сообщения',
  'err.missingField': 'Некорректный запрос: не хватает поля',
  'err.invalidField': 'Некорректный запрос: неверное значение поля',
  'err.optionRange': 'Время таймера — целое число секунд от 5 до 600',
  'err.stale': 'Поздно: этот ход или голосование уже позади',
  'err.nameRequired': 'Введи имя (1–20 символов)',
  'err.internal': 'Внутренняя ошибка',
  'err.notGameAction': 'Это не игровое действие',
  'err.optionsLobbyOnly': 'Настройки можно менять только в лобби',
  'err.seatsFull': 'Все 16 мест заняты',
  'err.seatsLobbyOnly': 'Сесть за стол можно только в лобби',
  'err.alreadySeated': 'У тебя уже есть место за столом',
  'err.alreadyStarted': 'Игра уже идёт',
  'err.tooFewPlayers': 'Чтобы начать, нужно не меньше {n} {n|игрока|игроков|игроков}',
  'err.playAgainFinal': 'Сыграть ещё можно только после окончания игры',
  'err.endGameLobby': 'Завершать нечего: стол уже в лобби',
  'err.noSuchPlayer': 'Такого игрока нет',
  'err.kickSelf': 'Себя удалить нельзя',
  'err.transferTarget': 'Выбери другого игрока за столом',
  'err.revealPhase': 'Карты раскрывают в фазе раскрытия',
  'err.alreadyRevealed': 'В этот ход карта уже раскрыта',
  'err.round1Profession': 'В раунде 1 нужно раскрыть профессию',
  'err.cardRevealed': 'Эта карта уже открыта',
  'err.noTurn': 'Заканчивать нечего: сейчас ничей ход не идёт',
  'err.revealFirst': 'Сначала раскрой карту',
  'err.useStart': 'Чтобы начать игру, нажми «Начать игру»',
  'err.usePlayAgain': 'Чтобы вернуться в лобби, нажми «Сыграть ещё»',
  'err.noOpenVote': 'Голосование сейчас не идёт',
  'err.notVoter': 'В этом туре ты не голосуешь',
  'err.voteSelf': 'Против себя голосовать нельзя',
  'err.notCandidate': 'Этого игрока нет среди кандидатов',
  'err.specialPhase': 'Особые условия можно играть только во время игры',
  'err.spectatorSpecial': 'У зрителей нет особых условий',
  'err.noCard': 'У тебя нет такой карты',
  'err.beforeVoteOnly': 'Эту карту можно сыграть только до голосования (во время раскрытия или обсуждения)',
  'err.specialAlive': 'Особые условия могут играть только те, кто ещё в игре',
  'err.cardUsed': 'Эта карта уже сыграна',
  'err.oneSpecial': 'Одно особое условие за раунд — в этом раунде оно уже сыграно',
  'err.fromRound': 'Эту карту можно сыграть с раунда {n}',
  'err.cancelledAlready': 'Следующее голосование уже отменено',
  'err.doubleBlocked': 'У тебя запрет голосовать {now:на следующем голосовании|до конца этого голосования}, так что двойной голос ничего не даст',
  'err.doubleNotVoter': 'В этом туре ты не голосуешь, так что двойной голос ничего не даст',
  'err.pickAlive': 'Выбери другого игрока из тех, кто ещё в игре',
  'err.noHidden': 'У этого игрока не осталось скрытых карт',
  'err.pickEjected': 'Выбери игрока из леса',
  'err.ownAirlock': 'Твой шлюз на игрока {t} уже запущен: задраить его может только другой игрок',
  'err.pickCategory': 'Выбери характеристику',
  'err.notHidden': 'Эта карта не скрыта',

  // ---------------------------------------------------------------------------------------------- errors: rooms.js
  'err.lookupThrottled': 'Из твоей сети слишком много неверных кодов комнат. Подожди минуту и попробуй снова',
  'err.noRoomJoin': 'Комнаты с таким кодом нет',
  'err.noRoomResume': 'Этой комнаты больше нет',
  'err.replacedTab': 'Это место открыто в другой вкладке или окне',
  'err.tooManyRooms': 'Из твоей сети открыто слишком много комнат. Выйди из одной из них или попробуй позже',
  'err.jsonFrame': 'Некорректный запрос: ожидается текстовое сообщение',
  'err.malformedJson': 'Некорректный запрос: сообщение не разобрать',
  'err.generic': 'Что-то пошло не так',
  'err.devOff': 'Режим разработчика выключен: тестовых команд на этом сервере нет',

  // ---------------------------------------------------------------------------------------------- errors: dev mode (§11 X9)
  'err.dev.badOp': 'Неизвестная команда разработчика: используй одну из giveSpecial, autoReveal, skipToVote, forceTie, god, fastTimers, addBots',
  'err.dev.badSeed': 'Сид — это 1–64 символа или целое число',
  'err.dev.ejectRetired': 'Карта изгнания одного игрока выведена из игры: выдай вместо неё «Шлюз»',
  'err.dev.noPlayer': 'Такого игрока за столом нет',
  'err.dev.playerLeft': '{p} уже вне игры',
  'err.dev.noGame': 'Игра не идёт',
  'err.dev.gameOver': 'Игра окончена',
  'err.dev.notReveal': 'Автораскрытие работает только во время раскрытия',
  'err.dev.ballotOpen': 'Тур голосования уже открыт',
  'err.dev.noBallot': 'Ничью можно устроить только во время открытого тура голосования',
  'err.dev.revote': 'Ничью можно устроить только в основном туре, а не в переголосовании',
  'err.dev.duplicate': 'Каждого игрока — только один раз',
  'err.dev.notAlive': '{p} больше не участвует в игре',
  'err.dev.immune': 'У игрока {p} иммунитет в этом голосовании, в ничью его не включить',
  'err.dev.impossible': 'Голосующие в этом туре не могут дать такую ничью (слишком мало голосов или двойные голоса не сходятся)',
  'err.dev.tableFull': 'Все места за столом заняты',
  'err.dev.spectatorsFull': 'Для зрителей в комнате больше нет мест',
};
