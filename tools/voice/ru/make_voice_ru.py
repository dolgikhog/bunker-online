#!/usr/bin/env python3
"""Russian catastrophe narration for Bunker Online: Qwen3-TTS 12Hz 1.7B, "design then clone".

    tools/voice/.venv-ru/bin/python tools/voice/ru/make_voice_ru.py check          # scripts vs cards, no GPU
    NVIDIA_HANG_REAPER_SKIP=1 tools/voice/.venv-ru/bin/python tools/voice/ru/make_voice_ru.py all
    NVIDIA_HANG_REAPER_SKIP=1 tools/voice/.venv-ru/bin/python tools/voice/ru/make_voice_ru.py all --only gray-goo

Run it from anywhere; every default path is relative to this file (tools/voice/ru/) and the repository root above
it. See tools/voice/README.md, "Russian narration", for the setup.

Pipeline (every step caches its output in <work>; --force redoes it)
  0. check    The 18 hand-written ear scripts (scripts/<slug>.ru.txt) against the cards: every id in
              server/content/ru/catastrophes.js has a script, the spoken survivor range matches the {n:a-b} of
              server/content/en/catastrophes.js, the spoken "safe" range matches STAY in server/content/gen.js, and
              the RU card text still has the fingerprint the script was written from (a changed card = a warning).
              Also: whether narration.json has a Russian clip for every card and the file is there.
  1. design   (only to re-create a voice) Qwen3-TTS-12Hz-1.7B-VoiceDesign renders the voice's design text from a
              plain-language description (VOICES[v].instruct) with a fixed seed -> <work>/design/<v>-s<seed>.wav.
     freeze   Cuts the reference clip from a design render at a sentence end (CTC forced alignment finds the
              words; the cut sits in the quietest 20 ms of the pause) -> voices/<v>.flac + <v>.txt + <v>.json.
              The frozen clips in voices/ ARE the voices; re-running design is not bit-exact on another GPU.
              They are stored as FLAC (lossless); render restores the exact WAV (<work>/voices/<v>.wav, checked
              against the sha256 in voices/<v>.json) and clones that.
  2. render   Qwen3-TTS-12Hz-1.7B-Base, ICL voice clone of the frozen reference (audio + its transcript), whole
              script in ONE call (pauses come from the punctuation: "..." and "—"), one candidate per seed
              (default 7, 11, 23, 42, 101, 5, plus the clip's seed pinned in picks.json)
              -> <work>/wav/<slug>/<voice>-s<seed>.wav (24 kHz). Deterministic on one GPU: seed 7 of
              nuclear-winter in M1 reproduced the sampling run's winner bit for bit.
  3. master   ../fx.sh, the English chain unchanged (EQ, concrete room, rumble bed, limiter, two-pass loudnorm to
              -12 LUFS, <= -1.2 dBTP) with MP3_KBPS=128 (at 96 kbps deep male voices miss -1.2 dBTP).
              Pitch 1.0 for every RU voice (designed voices are already deep); wet as the EN casting.
  4. qa       Objective check of every candidate (nobody has to listen first): two phonetic CTC recognizers with
              no language model (jonatasgrosman/wav2vec2-large-xlsr-53-russian, bond005/wav2vec2-large-ru-golos),
              CER, words both recognizers mishear, the peer test across the other candidates of the same clip,
              forced-alignment GOP, sounds in the pauses, clicks, clipping, loudness, true peak, length. Whisper
              large-v3 too when faster-whisper is importable (it is blind to mispronunciation; information only).
  5. publish  Best-scoring candidate per clip that passes the gates (or the one picks.json pins)
              -> public/audio/catastrophes-ru/<slug>-<sha1[:8]>.mp3, and the card's entry in
              public/audio/narration.json gets clips.ru = {src, voice, durationSec} (SPEC §11 X5.16). Also
              manifest.json here ([{title_en, slug, lang, voice, seed, durationSec, script, loudnessLUFS, ...}]:
              which candidate each published clip is) and <work>/qa.json (the numbers behind every choice).

File names and caching: production serves /audio/* with a 7-day cache, so a clip is always published under a
content-hash name. A re-publish of the same bytes keeps its name; new audio gets a new name, narration.json points to
it and the superseded file is deleted. narration.json itself is fetched with revalidation.

Needs: CUDA GPU (~6 GB free VRAM, decoding peaks at 5.6 GB; CPU works but is very slow) for design, render and qa;
ffmpeg/ffprobe with libmp3lame and librubberband; node (reads the content files); the venv of
tools/voice/requirements-ru.txt. faster-whisper is optional. On a machine that runs nvidia-hang-reaper, every GPU
process must be STARTED with NVIDIA_HANG_REAPER_SKIP=1 (the reaper kills autoregressive CUDA loops otherwise); the
script refuses to start without it while the reaper is running.
Licences: Qwen3-TTS weights and code Apache-2.0; the QA recognizers Apache-2.0 (QA only, nothing of them ships).
The voices are invented from text descriptions by VoiceDesign; no real person's voice is cloned.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent          # tools/voice/ru
ROOT = HERE.parents[2]                          # the repository
RU_CARDS = ROOT / 'server' / 'content' / 'ru' / 'catastrophes.js'
EN_CARDS = ROOT / 'server' / 'content' / 'en' / 'catastrophes.js'
GEN = ROOT / 'server' / 'content' / 'gen.js'
AUDIO = ROOT / 'public' / 'audio'               # served as /audio/ (default --out)
CLIP_DIR = 'catastrophes-ru'                    # <out>/catastrophes-ru/<slug>-<hash8>.mp3, URL audio/catastrophes-ru/...
PICKS = HERE / 'picks.json'
MANIFEST = HERE / 'manifest.json'

MODEL_BASE = ('Qwen/Qwen3-TTS-12Hz-1.7B-Base', 'fd4b254389122332181a7c3db7f27e918eec64e3')
MODEL_DESIGN = ('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', '5ecdb67327fd37bb2e042aab12ff7391903235d3')
CTC_MODELS = {  # QA only
    'jg': ('jonatasgrosman/wav2vec2-large-xlsr-53-russian', '2329100508896c6d9b157019803ab5601e6f3406'),
    'b5': ('bond005/wav2vec2-large-ru-golos', 'c361ee1f5bd6589ac7abe8f5bb6d136561339cb0'),
}
# sha256 of the weight files at those revisions (their LFS oids on the Hub), checked after every download by snapshot().
# The published clips were made with exactly these; a different file gives different audio.
MODEL_SHA256 = {
    MODEL_BASE[0]: {'model.safetensors': '38fc7fc51c5e776e840414b6fd443962e9411b9654888fd7913e4da643cb857c',
                    'speech_tokenizer/model.safetensors': '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258'},
    MODEL_DESIGN[0]: {'model.safetensors': '391e8db219f292c515297cdceeb43e4eae67cdde35fa57e79a6a8a532fca0522',
                      'speech_tokenizer/model.safetensors': '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258'},
    CTC_MODELS['jg'][0]: {'pytorch_model.bin': 'd1cdb1a7921de7d363f967a9b0101a713602e109dba62b6f3f9ae2e0b2df0c1c'},
    CTC_MODELS['b5'][0]: {'pytorch_model.bin': 'db2a4ee1d1cb6d5b72c1128c0baaf5ab9c95b4931031604b2d5c9787ebc2781d'},
}
# The model's own generation defaults, stated so a future qwen-tts cannot change them silently (the sampling run's winners).
SAMPLING = dict(do_sample=True, temperature=0.9, top_k=50, top_p=1.0, repetition_penalty=1.05,
                subtalker_dosample=True, subtalker_temperature=0.9, subtalker_top_k=50, subtalker_top_p=1.0,
                max_new_tokens=2048)
SEEDS = (7, 11, 23, 42, 101, 5)  # 6 candidates per clip: 5 peers each for the peer test
LANGUAGE = 'Russian'
TARGET_LUFS = -12.0
MAX_TP = -1.2
MP3_KBPS = 128
DUR_MIN, DUR_MAX = 20.0, 40.0  # MP3 length, s (fx.sh adds 0.6 s pre-roll and a 1.9 s tail)

# ---------------------------------------------------------------------------------------------------------------------
# Voices. All four were invented by Qwen3 VoiceDesign from the English description below (the model's instruction data
# is zh/en; the text it reads is Russian), rendered once with the seed, and frozen as voices/<v>.flac + .txt.
# design_text = what VoiceDesign read; the reference is its opening, up to a sentence end.
# ---------------------------------------------------------------------------------------------------------------------
_NW_SAMPLE = ('Ядерная зима. Пограничный спор... меньше чем за час перерос в обмен ядерными ударами. Дым горящих '
              'городов заслонил солнце, и планета замерзает. Урожай погиб... везде и сразу. Выжившие: от трёх до восьми '
              'процентов населения Земли. На поверхности: от тридцати до пятидесяти градусов мороза. Вечные сумерки. '
              'Радиоактивные осадки. Угрозы: холод, радиация... и голодные мародёры. Поверхность станет безопасной '
              'через два года... или через шесть.')
_TV_SAMPLE = ('Гости. Над каждой столицей появились серебристые корабли... и вежливо попросили всех разойтись по домам. '
              'Те, кто остался на улице, просто исчезли. Корабли до сих пор висят в небе. И, похоже... чего-то ждут. '
              'Выжившие: от двадцати пяти до сорока процентов. И все прячутся. На поверхности: всё цело, но безлюдно. '
              'По ночам — странные огни. Угрозы: лучи, которые забирают людей... и то, что нужно гостям. Поверхность '
              'станет безопасной через год... или через четыре.')
VOICES = {
    'M1': dict(
        gender='male', label='grave announcer',
        instruct=('A deep, grave male baritone in his fifties, a native Russian news announcer. Measured, weighty, somber '
                  'and restrained delivery at a steady pace with short dramatic pauses, like the last emergency radio '
                  'broadcast before the sirens. Clear standard Russian pronunciation, no foreign accent.'),
        seed=7, design_text=_NW_SAMPLE,
        origin='sampling run 2026-09-26: qwen3-design_m-nuclear-winter (seed 7); reference cut by cut_refs.py at the '
               'pause after "замерзает" (Whisper word times); its clone qwen3-designclone_m-nuclear-winter scored 88.1 '
               '(128 kbps) in the sampling run\'s check, 0 misheard words'),
    'F1': dict(
        gender='female', label='soft, unnervingly polite',
        instruct=("A soft young woman's voice, a native Russian speaker, quiet and unnervingly polite. Calm and even, at "
                  'a natural speaking pace, not slow, with an eerie, unsettling undertone and short pauses, like someone '
                  'telling a ghost story at night. Standard Russian pronunciation, no accent.'),
        seed=23, design_text=_TV_SAMPLE,
        origin='sampling run 2026-09-26: qwen3-design_f-the-visitors (seed 23 of 7/11/23); reference cut by cut_refs.py '
               'at the pause after "домам" (Whisper word times); its clone qwen3-designclone_f-the-visitors scored 94.4 '
               'in the sampling run\'s check (best of 23), 0 misheard words'),
    'M2': dict(
        gender='male', label='older, weary, gravelly',
        instruct=('An older man in his sixties with a low, weary, slightly gravelly voice, a native Russian speaker. '
                  'Calm, quiet and unhurried, like an old radio operator who has seen everything, with a steady '
                  'undertone of dread and short pauses, at a natural speaking pace, not slow. Clear standard Russian '
                  'pronunciation, no foreign accent.'),
        seed=23, design_text=('Новый ледниковый период. Океанские течения, которые грели Северное полушарие, '
                                'остановились почти в одночасье. Через год ледники наступали на Европу и Северную '
                                'Америку... а зима так и не кончилась.'),
        origin='production run 2026-09-26: design seeds 7/11/23/42/101 scored by `design --qa`; seed 23 (clean read, 85 '
               'Hz, 0 words misheard by both recognizers) frozen at the pause after "одночасье" by `freeze`; voice test '
               '(nuclear-winter sample script, seeds 7/11/23, the sampling run\'s check): CER 1.7 % on seeds 11/23 vs 2.5 % for '
               'M1, 0 suspect words on 2 of 3 seeds, no artifacts'),
    'F2': dict(
        gender='female', label='cold, clinical, precise',
        instruct=('A woman in her forties with a cool, clear, precise mid-range voice, a native Russian speaker. Cold, '
                  'clinical and composed, like a public-health official reading an emergency briefing: crisp diction, '
                  'an even, natural speaking pace, not slow, no emotion in the voice, short pauses between statements. '
                  'Standard Russian pronunciation, no accent.'),
        seed=11, design_text=('Серая лихорадка. Лихорадка, от которой сереет кожа, пронеслась по аэропортам быстрее '
                                'любого карантина. Большинство заражённых умирают за неделю, а выздоровевшие остаются '
                                'заразными.'),
        origin='production run 2026-09-26: design seeds 7/11/23/42/101 scored by `design --qa`; seed 11 (196 Hz, '
               'CER 2.3/1.7 %) frozen at the pause after "карантина" by `freeze` (seed 7 came out at 130 Hz and was not '
               'used; seed 23 read "всё цело" as "все" in 3 of 3 clone tests); voice test (the-visitors sample '
               'script, seeds 7/11/23, the sampling run\'s check): CER 1.2 % on seed 11 vs 0.9 % for F1, 0 misheard content '
               'words on 2 of 3 seeds, no artifacts'),
}

# ---------------------------------------------------------------------------------------------------------------------
# Casting: mirrors CASTING in ../make_voice.py (EN voice -> RU voice by mood, gender kept; <= 7 clips per voice).
#   M1 grave announcer   <- bm_george (grave, weighty) + bm_daniel (procedural, newsreader neutrality)
#                           + gamma-ray-burst (bm_lewis): M2 failed the QA gates on all 10 seeds of that script
#                           (mean CER 3.1-5.1 %, a different misheard word each time); M1 passed on 2 of 6 (1.9 %)
#   M2 older, weary      <- bm_lewis (heavy, weary, flat and low) + bm_fable (storyteller, campfire horror)
#   F1 soft, eerie       <- bf_lily (the-visitors) + bf_isabella (hushed, elegiac)
#   F2 cold, clinical    <- bf_emma (clinical, ministry briefing) + bf_alice (crisp civil-defence warning)
# wet = fx.sh reverb send, dB (None = fx.sh default -11), as the EN casting.
# ---------------------------------------------------------------------------------------------------------------------
CASTING = {
    'nuclear-winter':    dict(voice='M1', en='bm_george',   why='Grave, authoritative announcer: the last bulletin before the sirens.'),
    'asteroid-impact':   dict(voice='M1', en='bm_george',   why='Weighty, unhurried gravitas lets the scale (ten kilometres, three weeks) land.'),
    'supervolcano':      dict(voice='M1', en='bm_george',   why='Geological doom needs the deepest, most settled voice in the set.'),
    'machine-uprising':  dict(voice='M1', en='bm_daniel',   why='Calm, procedural announcer: the dread is how matter-of-fact it sounds.'),
    'gray-goo':          dict(voice='M1', en='bm_daniel',   why="Engineer's post-mortem: measured, precise, quietly appalled."),
    'solar-superflare':  dict(voice='M1', en='bm_daniel',   why='Emergency-newsreader neutrality for a disaster that switched the world off.'),
    'new-ice-age':       dict(voice='M2', en='bm_lewis',    why='Heavy, weary, frost-bitten delivery for a winter that never ends.'),
    'scorched-earth':    dict(voice='M2', en='bm_lewis',    why='Dry, weary low voice: a man who has not slept for the heat.'),
    'gamma-ray-burst':   dict(voice='M1', en='bm_lewis',    why='Cosmic dread read flat and low by the grave announcer; ten seconds that killed half the planet.'),
    'the-great-flood':   dict(voice='M2', en='bm_fable',    why="Old storyteller's cadence for a near-biblical flood ending on 'for now'."),
    'the-biting-plague': dict(voice='M2', en='bm_fable',    why='Campfire-horror narrator: calm dread around one bite and the dark.'),
    'pole-reversal':     dict(voice='M2', en='bm_fable',    why='An old man remembering auroras at noon and lost migrations.'),
    'the-visitors':      dict(voice='F1', en='bf_lily',     wet=-8.5, why="Soft, unnervingly polite voice, as uncanny as the ships' request."),
    'spore-rain':        dict(voice='F1', en='bf_isabella', wet=-9, why='Hushed, eerie softness for a slow, beautiful alien mould.'),
    'silent-spring':     dict(voice='F1', en='bf_isabella', why='Soft and mournful: a requiem for insects, birds and the harvest.'),
    'the-gray-fever':    dict(voice='F2', en='bf_emma',     why="Cold, clinical public-health voice; the calm makes 'day twelve' land hard."),
    'the-barren-plague': dict(voice='F2', en='bf_emma',     why='Controlled ministry briefing on a quiet extinction; the stakes are the bunker itself.'),
    'the-yellow-cloud':  dict(voice='F2', en='bf_alice',    why='Crisp civil-defence warning voice for a creeping, regional chemical fog.'),
}
# sha1(title + text + details of the RU card)[:12] when the ear script was written lives in scripts/card_fp.json
# (`check --update-fp` records it); a mismatch = the card changed since, so re-read the script.

VOW = set('аеёиоуыэюя')
# The sampling run: words both recognizers miss in almost every render (recognizer limits, not the voice): ignored.
RECOGNIZER_LIMITS = {'безопасной', 'мародеры'}
FUNCTION_WORDS = set('и в во на по за до от с со к ко а но же ли из у о об под над при для без то что кто как их '
                     'он она оно они его её ещё уже не ни или так там где все всё это этого чего чем'.split())


def log(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------------------------------------ content (read only)
def node_json(expr: str, module: Path):
    code = f"import(process.argv[1]).then(m => {{ process.stdout.write(JSON.stringify({expr})); }})"
    r = subprocess.run(['node', '--input-type=module', '-e', code, module.as_uri()], capture_output=True, text=True,
                       check=True)
    return json.loads(r.stdout)


def cards():
    ru = node_json('m.default.list', RU_CARDS)
    en = node_json('m.default.list', EN_CARDS)
    stay = node_json('m.STAY', GEN)
    return ru, en, stay


def card_fp(c) -> str:
    return hashlib.sha1(json.dumps([c['title'], c['text'], c['details']], ensure_ascii=False).encode()).hexdigest()[:12]


def script_text(scripts: Path, slug: str) -> str:
    """The ear script as one string (one phrase per line in the file; Qwen3 reads it in one call)."""
    raw = (scripts / f'{slug}.ru.txt').read_text(encoding='utf-8')
    return ' '.join(re.sub(r'\[[0-9.]+\]', ' ', raw).split())  # [0.4] = a Chatterbox-era pause mark, ignored


_UNITS = {'одного': 1, 'двух': 2, 'трёх': 3, 'четырёх': 4, 'пяти': 5, 'шести': 6, 'семи': 7, 'восьми': 8,
          'девяти': 9, 'десяти': 10, 'одиннадцати': 11, 'двенадцати': 12, 'тринадцати': 13, 'четырнадцати': 14,
          'пятнадцати': 15, 'шестнадцати': 16, 'семнадцати': 17, 'восемнадцати': 18, 'девятнадцати': 19,
          'двадцати': 20, 'тридцати': 30, 'сорока': 40, 'пятидесяти': 50, 'шестидесяти': 60, 'семидесяти': 70,
          'восьмидесяти': 80, 'девяноста': 90}
_YEARS = {'полгода': 6, 'год': 12, 'полтора года': 18, 'два года': 24, 'три года': 36, 'четыре года': 48,
          'пять лет': 60, 'шесть лет': 72, 'восемь лет': 96, 'десять лет': 120}
_BARE = {'два': 24, 'три': 36, 'четыре': 48, 'пять': 60, 'шесть': 72, 'восемь': 96, 'десять': 120}


def _gen_num(words: str):
    try:
        return sum(_UNITS[w] for w in words.split())
    except KeyError:
        return None


def spoken_ranges(text: str):
    """(survivor range, safe range in months) as spoken in an ear script."""
    t = text.lower()
    m = re.search(r'выжившие: от ([а-яё ]+?) до ([а-яё ]+?) процентов', t)
    surv = (_gen_num(m.group(1)), _gen_num(m.group(2))) if m else None
    m = re.search(r'безопасной через ([а-яё ]+?)\.\.\. или через ([а-яё ]+?)\.', t)
    safe = None
    if m:
        a, b = m.group(1).strip(), m.group(2).strip()
        safe = (_YEARS.get(a), _YEARS.get(b) or _BARE.get(b))
    return surv, safe


def cmd_check(a):
    ru, en, stay = cards()
    fp_file = a.scripts / 'card_fp.json'
    fps = json.loads(fp_file.read_text()) if fp_file.exists() else {}
    published = {entry_id(e): e for e in load_narration(a.out / 'narration.json')}
    bad = 0
    for slug in ru:
        f = a.scripts / f'{slug}.ru.txt'
        if not f.exists():
            log(f'MISSING {slug}: no script'); bad += 1; continue
        if slug not in CASTING:
            log(f'MISSING {slug}: not cast'); bad += 1
        text = script_text(a.scripts, slug)
        surv, safe = spoken_ranges(text)
        n = re.search(r'\{n:(\d+)-(\d+)\}', en[slug]['details'][0])
        want_surv = (int(n.group(1)), int(n.group(2)))
        want_safe = tuple(stay[slug])
        notes = []
        if surv != want_surv:
            notes.append(f'survivors spoken {surv} != card {want_surv}')
        if safe != want_safe:
            notes.append(f'safe spoken {safe} != STAY {want_safe}')
        for k, d in enumerate(en[slug]['details'][1:], 1):
            for lo, hi in re.findall(r'\{n:(\d+)-(\d+)\}', d):
                nums = [_gen_num(x) for x in re.findall(r'от ([а-яё ]+?) до', text.lower())]
                if int(lo) not in nums:
                    notes.append(f'detail {k}: range {lo}-{hi} not spoken')
        # (мертва/мертво/мертвы are right without ё: only the full adjective and мёртв need it)
        no_yo = re.findall(r'\b(еще|все цело|трех|четырех|мертв(?:ый|ая|ое|ые|ого|ому|ым|ыми|ом|ой|ую|ых)?|желт\w*|'
                           r'зараженн\w*|поврежденн\w*|разошел|'
                           r'пришел|ушел|принес\b|черн\w*|тяжел\b|легк\w*|вошел|войдет)\b', text.lower())
        if no_yo:
            notes.append('ё missing: ' + ', '.join(no_yo))
        fp = card_fp(ru[slug])
        if a.update_fp:
            fps[slug] = fp
        elif fps.get(slug) != fp:
            notes.append(f'RU card changed since the script was written ({fps.get(slug)} -> {fp})')
        clip = ((published.get(slug) or {}).get('clips') or {}).get('ru')
        if not clip:
            notes.append('NO CLIP in narration.json')
        elif not (a.out / CLIP_DIR / Path(clip['src']).name).exists():
            notes.append(f"NO FILE {clip['src']}")
        vow = sum(ch in VOW for ch in text.lower())
        log(f"{'ok ' if not notes else 'BAD'} {slug:18s} {CASTING.get(slug, {}).get('voice', '?')} "
            f"{len(text.split()):3d} words {vow:3d} syllables  surv {surv} safe {safe}  "
            f"{'; '.join(notes) or Path(clip['src']).name}")
        bad += bool(notes)
    if a.update_fp:
        fp_file.write_text(json.dumps(fps, ensure_ascii=False, indent=1) + '\n')
    counts = {}
    for c in CASTING.values():
        counts[c['voice']] = counts.get(c['voice'], 0) + 1
    log('clips per voice:', counts)
    return bad


# ------------------------------------------------------------------------------------------------ GPU / models
def gpu_guard():
    try:
        running = subprocess.run(['pgrep', '-f', 'nvidia-hang-reaper'], capture_output=True).returncode == 0
    except FileNotFoundError:
        running = False
    if running and os.environ.get('NVIDIA_HANG_REAPER_SKIP') != '1':
        raise SystemExit('nvidia-hang-reaper is running: start this with NVIDIA_HANG_REAPER_SKIP=1 in the environment')


def load_qwen(repo_rev):
    import torch
    from qwen_tts import Qwen3TTSModel
    gpu_guard()
    dev = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    path = snapshot(repo_rev)
    t = time.perf_counter()
    m = Qwen3TTSModel.from_pretrained(path, device_map=dev, dtype=torch.bfloat16 if dev != 'cpu' else torch.float32,
                                      attn_implementation='sdpa')
    log(f'loaded {repo_rev[0]}@{repo_rev[1][:8]} on {dev} in {time.perf_counter() - t:.0f}s')
    return m, dev


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def snapshot(repo_rev) -> str:
    """The model at its pinned revision (downloaded into HF_HOME on first use), its weight files checked by sha256."""
    from huggingface_hub import snapshot_download
    path = Path(snapshot_download(repo_rev[0], revision=repo_rev[1]))
    for f, want in MODEL_SHA256.get(repo_rev[0], {}).items():
        got = sha256(path / f)
        if got != want:
            raise SystemExit(f'{repo_rev[0]}@{repo_rev[1][:8]} {f}: sha256 {got}, expected {want}')
    return str(path)


# ------------------------------------------------------------------------------------------------ design / freeze
def cmd_design(a):
    import torch
    m, dev = load_qwen(MODEL_DESIGN)
    out = a.work / 'design'
    out.mkdir(parents=True, exist_ok=True)
    for v in a.voices:
        spec = VOICES[v]
        seeds = a.seeds or ([spec['seed']] if spec['seed'] else list(SEEDS))
        for seed in seeds:
            wav = out / f'{v}-s{seed}.wav'
            if wav.exists() and not a.force:
                continue
            torch.manual_seed(seed)
            t = time.perf_counter()
            wavs, sr = m.generate_voice_design(text=spec['design_text'], instruct=spec['instruct'], language=LANGUAGE,
                                               **SAMPLING)
            w = np.asarray(wavs[0], dtype=np.float32)
            sf.write(wav, w, sr)
            meta = dict(voice=v, seed=seed, model=MODEL_DESIGN, instruct=spec['instruct'], text=spec['design_text'],
                        sampling=SAMPLING, sec=round(len(w) / sr, 2), wall=round(time.perf_counter() - t, 1), device=dev)
            wav.with_suffix('.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1))
            log(f'design {v} seed {seed}: {meta["sec"]} s in {meta["wall"]} s')
    if a.qa:
        qa = QA(whisper=False)
        for v in a.voices:
            for wav in sorted(out.glob(f'{v}-s*.wav')):
                r = qa.score_text(wav, VOICES[v]['design_text'])
                log(f"{wav.name:14s} dur {r['dur']:5.2f} f0 {r['f0']:5.1f} Hz  cer jg {r['cer']['jg']:.3f} b5 "
                    f"{r['cer']['b5']:.3f}  gop {r['gop']:.3f}  syl/s {r['sps']:.2f}  both-misheard {r['both']}  "
                    f"gap-sounds {r['gaps']}  clicks {r['clicks']}")
                wav.with_suffix('.qa.json').write_text(json.dumps(r, ensure_ascii=False, indent=1))


def ref_wav(a, v: str) -> Path:
    """The frozen reference of voice v as the WAV it was frozen as: voices/<v>.flac (lossless) decoded to
    <work>/voices/<v>.wav, 16-bit like the original, and checked against the sha256 in voices/<v>.json."""
    flac, meta = a.voices_dir / f'{v}.flac', json.loads((a.voices_dir / f'{v}.json').read_text(encoding='utf-8'))
    wav = a.work / 'voices' / f'{v}.wav'
    if not wav.exists() or sha256(wav) != meta['sha256']:
        x, sr = sf.read(flac, dtype='int16')
        wav.parent.mkdir(parents=True, exist_ok=True)
        sf.write(wav, x, sr, subtype='PCM_16', format='WAV')
    if sha256(wav) != meta['sha256']:
        raise SystemExit(f'{flac} does not decode to the reference WAV its {v}.json records (sha256 {meta["sha256"]})')
    return wav


def cmd_freeze(a):
    """Cut voices/<v>.flac + .txt + .json from <work>/design/<v>-s<seed>.wav at a sentence end, 7-13 s in."""
    v = a.voices[0]
    src = a.work / 'design' / f'{v}-s{a.seed}.wav'
    text = VOICES[v]['design_text']
    qa = QA(whisper=False)
    words = qa.word_times(src, text)  # [(script word with punctuation, start, end)] in s, raw-render time
    w, sr = sf.read(src, dtype='float32')
    full_stop = lambda tok: bool(re.search(r'(?<!\.)\.$|[!?]$', tok))  # "..." is a pause, not a sentence end
    ends = [i for i, (tok, s, e) in enumerate(words) if full_stop(tok) and 7.0 <= e <= a.max_sec]
    if not ends:
        raise SystemExit(f'no sentence end between 7 and {a.max_sec} s in {src.name}: ' +
                         ', '.join(f'{t}@{e:.1f}' for t, s, e in words if full_stop(t)))
    k = ends[-1]
    s0 = int(words[k][2] * sr)
    s1 = int(words[k + 1][1] * sr) if k + 1 < len(words) else len(w)
    f = int(0.02 * sr)
    frames = [(float(np.sqrt(np.mean(w[i:i + f] ** 2))), i) for i in range(s0, max(s0 + 1, s1 - f), f // 2)]
    cut = min(frames)[1] + f // 2 if frames else s0
    clip = w[:cut].copy()
    fl = int(0.01 * sr)
    clip[-fl:] *= np.linspace(1, 0, fl)
    # the reference is a 16-bit WAV (what render clones), kept in the repository as lossless FLAC
    wav = a.work / 'voices' / f'{v}.wav'
    wav.parent.mkdir(parents=True, exist_ok=True)
    sf.write(wav, clip, sr, subtype='PCM_16', format='WAV')
    a.voices_dir.mkdir(parents=True, exist_ok=True)
    sf.write(a.voices_dir / f'{v}.flac', sf.read(wav, dtype='int16')[0], sr, subtype='PCM_16', format='FLAC')
    ref_text = ' '.join(t for t, _, _ in words[:k + 1])
    (a.voices_dir / f'{v}.txt').write_text(ref_text + '\n', encoding='utf-8')
    meta = dict(voice=v, file=f'{v}.flac', gender=VOICES[v]['gender'], instruct=VOICES[v]['instruct'], seed=a.seed,
                design_model=MODEL_DESIGN, design_text=text, cut_sec=round(cut / sr, 3), ref_text=ref_text,
                sha256=sha256(wav), sha256_of='the 24 kHz 16-bit mono WAV that the FLAC decodes to')
    (a.voices_dir / f'{v}.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1) + '\n')
    log(f'froze {v}: {cut / sr:.2f} s from {src.name}: "{ref_text}"')


# ------------------------------------------------------------------------------------------------ render
def pinned(a, slug: str):
    """(voice, seed) of the candidate picks.json pins for slug, or None."""
    pin = load_picks(a).get(slug)
    m = re.fullmatch(r'([A-Z]\d)-s(\d+)', pin['pick']) if pin else None
    return (m.group(1), int(m.group(2))) if m else None


def jobs(a):
    """(slug, voice, seed) of every candidate: the given or default seeds in the cast (or --voice) voice, plus, with the
    default seeds, the seed picks.json pins (so a full run can publish the pinned clip again)."""
    only = set(a.only.split(',')) if a.only else None
    out = []
    for slug, c in CASTING.items():
        if only and slug not in only:
            continue
        voice = a.voice or c['voice']
        seeds = list(a.seeds or SEEDS)
        pin = pinned(a, slug)
        if not a.seeds and pin and pin[0] == voice and pin[1] not in seeds:
            seeds.append(pin[1])
        for seed in seeds:
            out.append((slug, voice, seed))
    return out


def cmd_render(a):
    import torch
    todo = [(s, v, sd) for s, v, sd in jobs(a)
            if a.force or not (a.work / 'wav' / s / f'{v}-s{sd}.wav').exists()]
    if not todo:
        log('render: nothing to do')
        return
    m, dev = load_qwen(MODEL_BASE)
    prompts = {}
    for slug, voice, seed in todo:
        if voice not in prompts:
            ref = ref_wav(a, voice)
            ref_text = (a.voices_dir / f'{voice}.txt').read_text(encoding='utf-8').strip()
            prompts[voice] = (m.create_voice_clone_prompt(ref_audio=str(ref), ref_text=ref_text), sha256(ref))
        text = script_text(a.scripts, slug)
        torch.manual_seed(seed)
        t = time.perf_counter()
        wavs, sr = m.generate_voice_clone(text=text, language=LANGUAGE, voice_clone_prompt=prompts[voice][0],
                                          **SAMPLING)
        dt = time.perf_counter() - t
        w = np.asarray(wavs[0], dtype=np.float32)
        out = a.work / 'wav' / slug / f'{voice}-s{seed}.wav'
        out.parent.mkdir(parents=True, exist_ok=True)
        sf.write(out, w, sr)
        meta = dict(slug=slug, voice=voice, seed=seed, model=MODEL_BASE, mode='ICL', ref_sha256=prompts[voice][1],
                    text=text, sampling=SAMPLING, sr=sr, sec=round(len(w) / sr, 2), wall=round(dt, 1), device=dev,
                    vram_peak_gb=round(torch.cuda.max_memory_allocated() / 2**30, 2) if dev != 'cpu' else None)
        out.with_suffix('.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1))
        log(f'render {slug} {voice} s{seed}: {meta["sec"]} s audio in {meta["wall"]} s (rtf {dt / meta["sec"]:.2f})')


# ------------------------------------------------------------------------------------------------ master (fx.sh)
def cmd_master(a):
    fx = a.fx
    if 'MP3_KBPS' not in fx.read_text():   # the English chain's own bitrate parameter (default 96 kbps)
        raise SystemExit(f'{fx} takes no MP3_KBPS: it is not tools/voice/fx.sh')
    (a.work / 'tmp').mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, TMPDIR=str(a.work / 'tmp'), MP3_KBPS=str(MP3_KBPS), VOICE_LUFS=str(TARGET_LUFS))
    ru = None
    for slug, voice, seed in jobs(a):
        wav = a.work / 'wav' / slug / f'{voice}-s{seed}.wav'
        mp3 = a.work / 'mp3' / slug / f'{voice}-s{seed}.mp3'
        if not wav.exists() or (mp3.exists() and mp3.stat().st_mtime > wav.stat().st_mtime and not a.force):
            continue
        if ru is None:
            ru = node_json('m.default.list', RU_CARDS)
        mp3.parent.mkdir(parents=True, exist_ok=True)
        c = CASTING[slug]
        args = ['--pitch', '1.0']
        if c.get('wet') is not None:
            args += ['--wet-db', str(c['wet'])]
        args += ['--title', ru[slug]['title'], '--artist', 'Bunker Online narrator']
        r = subprocess.run(['bash', str(fx), *args, str(wav), str(mp3)], env=env, capture_output=True, text=True)
        if r.returncode:
            raise SystemExit(f'fx.sh failed on {wav}:\n{r.stderr}')
        log(r.stdout.strip())


# ------------------------------------------------------------------------------------------------ QA
def ctc_norm(s: str, keep_yo=False) -> str:
    s = s.lower().replace('́', '')
    if not keep_yo:
        s = s.replace('ё', 'е')
    s = s.replace('-', ' ')
    return ' '.join(re.sub(r'[^а-яё\s]', ' ', s).split())


def editops(a: str, b: str):
    """Levenshtein edit operations (op, src_pos, dst_pos), like rapidfuzz.distance.Levenshtein.editops."""
    try:
        from rapidfuzz.distance import Levenshtein
        return [(o.tag, o.src_pos, o.dest_pos) for o in Levenshtein.editops(a, b)]
    except ImportError:
        pass
    n, m = len(a), len(b)
    d = np.zeros((n + 1, m + 1), np.int32)
    d[:, 0] = np.arange(n + 1)
    d[0, :] = np.arange(m + 1)
    bb = np.frombuffer(b.encode('utf-32-le'), np.uint32)
    for i in range(1, n + 1):
        ca = ord(a[i - 1])
        sub = d[i - 1, :-1] + (bb != ca)
        row = np.minimum(sub, d[i - 1, 1:] + 1)
        cur = np.empty(m + 1, np.int32)
        cur[0] = i
        for j in range(1, m + 1):  # insertion needs the running minimum
            cur[j] = min(row[j - 1], cur[j - 1] + 1)
        d[i] = cur
    ops, i, j = [], n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i, j] == d[i - 1, j - 1] + (a[i - 1] != b[j - 1]):
            if a[i - 1] != b[j - 1]:
                ops.append(('replace', i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i > 0 and d[i, j] == d[i - 1, j] + 1:
            ops.append(('delete', i - 1, j)); i -= 1
        else:
            ops.append(('insert', i, j - 1)); j -= 1
    return ops[::-1]


def editops_words(ref: list, hyp: list):
    """Word-level edit operations (maps every distinct word to one character and reuses editops)."""
    vocab = {w: chr(0x4E00 + i) for i, w in enumerate(sorted(set(ref) | set(hyp)))}
    return editops(''.join(vocab[w] for w in ref), ''.join(vocab[w] for w in hyp))


def cer(ref: str, hyp: str) -> float:
    return len(editops(ref, hyp)) / max(1, len(ref))


def word_errors(ref: str, hyp: str):
    """Character edits per reference word (spaces removed, so "за час"/"зачас" is not an error)."""
    rw = ref.split()
    owner = [i for i, w in enumerate(rw) for _ in w]
    rs, hs = ''.join(rw), hyp.replace(' ', '')
    err = [0] * len(rw)
    for _, sp, _ in editops(rs, hs):
        err[owner[min(sp, len(rs) - 1)]] += 1
    return err


def decode(path: Path, sr: int) -> np.ndarray:
    raw = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(path), '-ac', '1', '-ar', str(sr), '-f', 'f32le',
                          '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def ebur(path: Path):
    log_ = subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-i', str(path), '-af', 'ebur128=peak=true:framelog=quiet',
                           '-f', 'null', '-'], capture_output=True, text=True).stderr
    s = log_[log_.rfind('Summary:'):]
    g = lambda k, u: float(re.search(rf'{k}:\s+(-?[0-9.]+|-inf) {u}', s).group(1))
    return dict(lufs=g('I', 'LUFS'), lra=g('LRA', 'LU'), tp=g('Peak', 'dBFS'))


def frames_db(x, sr, hop=0.02):
    f = int(hop * sr)
    n = len(x) // f
    return 10 * np.log10(np.mean(x[:n * f].reshape(n, f) ** 2, 1) + 1e-12)


def raw_tech(wav: Path):
    x, sr = sf.read(wav, dtype='float32')
    x = x.mean(1) if x.ndim > 1 else x
    pk = float(np.abs(x).max())
    # isolated events (the sampling run's click check): a sample step > 3 % of peak with quiet audio (< -35 dB under peak) both 30 ms
    # before and 30 ms after it. In these renders they are plosive releases and word onsets (~10 per clip, also in the
    # sampling run's winners). A digital click is an impulse: its 2 ms carry >= 20 dB more energy than the 30 ms on either
    # side (plosives measured <= 13.6 dB on 23 renders; an injected 2-sample click 41 dB).
    d = np.abs(np.diff(x))
    k = int(0.03 * sr)
    c = np.cumsum(np.concatenate([[0], x.astype(np.float64) ** 2]))
    thr = (pk * 10 ** (-35 / 20)) ** 2
    clicks = []
    for i in np.where(d > 0.03 * pk)[0]:
        a0, a1, b0, b1 = max(0, i - k - 5), max(0, i - 5), min(len(x), i + 5), min(len(x), i + 5 + k)
        if a1 - a0 < k // 2 or b1 - b0 < k // 2:
            continue
        if ((c[a1] - c[a0]) / (a1 - a0) < thr and (c[b1] - c[b0]) / (b1 - b0) < thr
                and (not clicks or i / sr - clicks[-1] > 0.05)):
            clicks.append(round(float(i / sr), 3))
    e = lambda i, a_, b_: float(np.mean(x[max(0, i + int(a_ * sr)):i + int(b_ * sr)].astype(np.float64) ** 2)) + 1e-12
    ratio = {t: 10 * np.log10(e(int(t * sr), -0.0005, 0.0015) / max(e(int(t * sr), 0.002, 0.03),
                                                                    e(int(t * sr), -0.03, -0.001))) for t in clicks}
    onsets = [t for t in clicks if ratio[t] < 20]
    clicks = [t for t in clicks if ratio[t] >= 20]
    hot = np.abs(x) >= 0.995 * pk
    runs = np.diff(np.concatenate([[0], hot.astype(int), [0]]))
    lens = np.where(runs == -1)[0] - np.where(runs == 1)[0]
    clip_runs = int(np.sum(lens >= 3)) if pk > 0.98 else 0
    db = frames_db(x, sr)
    db -= db.max()
    on = np.where(db > -40)[0]
    span = (on[-1] - on[0] + 1) * 0.02
    pauses, r = [], 0
    for i in range(on[0], on[-1] + 1):
        if db[i] <= -40:
            r += 1
        else:
            if r * 0.02 >= 0.3:
                pauses.append(round(r * 0.02, 2))
            r = 0
    return dict(raw_sec=round(len(x) / sr, 2), raw_peak_dbfs=round(20 * np.log10(pk + 1e-9), 2), raw_clip_runs=clip_runs,
                clicks=clicks, onsets=len(onsets), span=round(span, 2), pauses=len(pauses), pause_sum=round(sum(pauses), 2),
                pause_max=max(pauses, default=0.0)), x, sr


def f0_median(x, sr):
    """Median F0 (Hz) over the loud frames (YIN, 60-400 Hz)."""
    import librosa
    y = librosa.resample(x, orig_sr=sr, target_sr=16000)
    f0 = librosa.yin(y, fmin=60, fmax=400, sr=16000, frame_length=1024, hop_length=320)
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=320)[0][:len(f0)]
    db = 20 * np.log10(rms + 1e-9)
    f0 = f0[:len(db)][db > db.max() - 25]
    return float(np.median(f0)) if len(f0) else float('nan')


# numerals the scripts speak in the genitive, folded to the nominative so Whisper's digits (spelled by num2words)
# compare equal
_NUM_FOLD = {'одного': 'один', 'двух': 'два', 'трех': 'три', 'четырех': 'четыре', 'пяти': 'пять', 'шести': 'шесть',
             'восьми': 'восемь', 'десяти': 'десять', 'двенадцати': 'двенадцать', 'пятнадцати': 'пятнадцать',
             'двадцати': 'двадцать', 'тридцати': 'тридцать', 'сорока': 'сорок', 'пятидесяти': 'пятьдесят',
             'шестидесяти': 'шестьдесят', 'восьмидесяти': 'восемьдесят', 'девяноста': 'девяносто'}


def whisper_norm(s: str) -> str:
    s = s.lower().replace('ё', 'е')
    s = re.sub(r'(\d+)\s*%', r'\1 процентов', s)
    try:
        from num2words import num2words
        s = re.sub(r'\d+', lambda m: ' ' + num2words(int(m.group(0)), lang='ru') + ' ', s)
    except ImportError:
        pass
    s = ctc_norm(s)
    return ' '.join(_NUM_FOLD.get(w, w) for w in s.split())


class QA:
    def __init__(self, whisper=True, ctc=True):
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        self.torch = torch
        self.dev = 'cuda' if torch.cuda.is_available() else 'cpu'
        if self.dev == 'cuda':
            gpu_guard()
        self.ctc = {}
        for k, (repo, rev) in (CTC_MODELS.items() if ctc else []):
            p = snapshot((repo, rev))
            proc = Wav2Vec2Processor.from_pretrained(p)
            model = Wav2Vec2ForCTC.from_pretrained(p).to(self.dev).eval()
            vocab = proc.tokenizer.get_vocab()
            self.ctc[k] = dict(proc=proc, model=model, vocab=vocab, inv={v: c for c, v in vocab.items()},
                               blank=vocab['<pad>'], bar=vocab['|'], yo='ё' in vocab)
        self.whisper = None
        if whisper:
            try:
                from faster_whisper import WhisperModel
                self.whisper = WhisperModel('large-v3', device=self.dev,
                                            compute_type='float16' if self.dev == 'cuda' else 'int8')
            except Exception as e:  # optional
                log(f'qa: Whisper skipped ({type(e).__name__}: {e})')

    def logp(self, k, y16):
        c = self.ctc[k]
        with self.torch.inference_mode():
            x = c['proc'](y16, sampling_rate=16000, return_tensors='pt').input_values.to(self.dev)
            return self.torch.log_softmax(c['model'](x).logits.float(), -1)[0].cpu()

    def greedy(self, k, lp):
        c = self.ctc[k]
        ids = lp.argmax(-1).tolist()
        out, prev = [], None
        for i in ids:
            if i != prev and i != c['blank']:
                out.append(c['inv'][i])
            prev = i
        return ' '.join(''.join(out).replace('|', ' ').replace('<unk>', '').split()), ids

    def forced(self, k, lp, text):
        import torchaudio
        c = self.ctc[k]
        chars = list(text.replace(' ', '|'))
        tg = self.torch.tensor([[c['vocab'][ch] for ch in chars]], dtype=self.torch.int32)
        ali, sc = torchaudio.functional.forced_align(lp[None], tg, blank=c['blank'])
        spans = torchaudio.functional.merge_tokens(ali[0], sc[0])
        words, cur = [], []
        for ch, s in zip(chars, spans):
            if ch == '|':
                words.append(cur); cur = []
            else:
                cur.append((ch, s.start, s.end, float(lp[s.start:s.end, c['vocab'][ch]].mean())))
        words.append(cur)
        return [w for w in words if w]

    def word_times(self, wav: Path, text: str):
        """[(script token with punctuation, start s, end s)] via forced alignment on jg (raw time base)."""
        y16 = decode(wav, 16000)
        lp = self.logp('jg', y16)
        toks = text.split()
        ref = ctc_norm(text, keep_yo=self.ctc['jg']['yo'])
        fa = self.forced('jg', lp, ref)
        # hyphenated tokens are several CTC words
        flat = [i for i, t in enumerate(toks) for part in ctc_norm(t, True).split() if part]
        assert len(flat) == len(fa), (len(flat), len(fa))
        res = {}
        for wi, chs in zip(flat, fa):
            s, e = chs[0][1] * 0.02, chs[-1][2] * 0.02
            a0, b0 = res.get(wi, (s, e))
            res[wi] = (min(a0, s), max(b0, e))
        return [(toks[i], *res[i]) for i in sorted(res)]

    def analyse(self, audio: Path, text: str, x_raw=None, sr_raw=None):
        """CTC round trip of one clip (MP3 or WAV) against its script."""
        y16 = decode(audio, 16000)
        r = dict(ctc={}, cer={}, err={})
        refn = ctc_norm(text)
        for k in self.ctc:
            lp = self.logp(k, y16)
            hyp, ids = self.greedy(k, lp)
            hypn = ctc_norm(hyp)
            r['ctc'][k] = hyp
            r['cer'][k] = round(cer(refn, hypn or '-'), 4)
            r['err'][k] = word_errors(refn, hypn)
            if k == 'jg':
                fa = self.forced(k, lp, ctc_norm(text, keep_yo=self.ctc[k]['yo']))
                r['gop'] = round(float(np.mean([np.mean([c[3] for c in w]) for w in fa])), 4)
                gaps = []
                c = self.ctc[k]
                for i in range(len(fa) - 1):
                    g0, g1 = fa[i][-1][2] + 3, fa[i + 1][0][1] - 2
                    if g1 - g0 >= 8:
                        em = [t for t in range(g0, g1) if ids[t] not in (c['blank'], c['bar'])]
                        if em:
                            gaps.append(dict(t=round(g0 * 0.02, 2), chars=''.join(c['inv'][ids[t]] for t in em)))
                r['gap_sounds'] = gaps
                r['word_start'] = [round(w[0][1] * 0.02, 2) for w in fa]
        words = refn.split()
        r['words'] = words
        r['both'] = [i for i in range(len(words)) if r['err']['jg'][i] and r['err']['b5'][i]]
        if self.whisper is not None:
            r.update(self.whisper_pass(y16, text))
        return r

    def whisper_pass(self, y16, text):
        """Whisper large-v3 transcript and WER (information only: its language model repairs mispronunciations)."""
        segs, _ = self.whisper.transcribe(y16, language='ru', beam_size=5, condition_on_previous_text=False,
                                          vad_filter=True)
        wt = ' '.join(s.text.strip() for s in segs)
        ref, hyp = whisper_norm(text).split(), whisper_norm(wt).split()
        return dict(whisper=wt, whisper_wer=round(len(editops_words(ref, hyp)) / max(1, len(ref)), 4))

    def score_text(self, wav: Path, text: str):
        """For design candidates: CTC round trip + F0 + rate on a raw render."""
        t, x, sr = raw_tech(wav)
        r = self.analyse(wav, text)
        syl = sum(ch in VOW for ch in text.lower())
        return dict(dur=t['raw_sec'], f0=round(f0_median(x, sr), 1), cer=r['cer'], gop=r['gop'],
                    sps=round(syl / max(0.1, t['span'] - t['pause_sum']), 2), both=[r['words'][i] for i in r['both']],
                    gaps=r['gap_sounds'], clicks=t['clicks'], ctc=r['ctc'])


def cmd_qa(a):
    if a.whisper_only:
        return cmd_whisper(a)
    qa = QA(whisper=not a.no_whisper)
    a.work.joinpath('qa').mkdir(parents=True, exist_ok=True)
    by_slug = {}
    for slug, voice, seed in jobs(a):
        by_slug.setdefault(slug, []).append((voice, seed))
    for slug, cands in by_slug.items():
        qf = a.work / 'qa' / f'{slug}.json'
        old = json.loads(qf.read_text()) if qf.exists() else {}
        text = script_text(a.scripts, slug)
        for voice, seed in cands:
            name = f'{voice}-s{seed}'
            mp3 = a.work / 'mp3' / slug / f'{name}.mp3'
            wav = a.work / 'wav' / slug / f'{name}.wav'
            if not mp3.exists():
                continue
            key = f'{sha256(mp3)[:16]}:{hashlib.sha1(text.encode()).hexdigest()[:8]}'
            if old.get(name, {}).get('key') == key and not a.force:
                continue
            t, x, sr = raw_tech(wav)
            e = ebur(mp3)
            y = decode(mp3, 44100)
            r = qa.analyse(mp3, text)
            syl = sum(ch in VOW for ch in text.lower())
            r.update(key=key, voice=voice, seed=seed, dur=round(len(y) / 44100, 2), lufs=e['lufs'], lra=e['lra'],
                     tp=e['tp'], mp3_clip=int(np.sum(np.abs(y) >= 0.999)), f0=round(f0_median(x, sr), 1),
                     sps=round(syl / max(0.1, t['span'] - t['pause_sum']), 2),
                     wpm=round(len(text.split()) / t['span'] * 60, 1), **t)
            old[name] = r
            log(f"qa {slug:18s} {name:8s} dur {r['dur']:5.2f} cer {r['cer']['jg']:.3f}/{r['cer']['b5']:.3f} "
                f"gop {r['gop']:.3f} both {len(r['both'])} lufs {r['lufs']} tp {r['tp']} clicks {len(r['clicks'])} "
                f"gaps {len(r['gap_sounds'])}" + (f" whisper {r['whisper_wer']:.3f}" if 'whisper_wer' in r else ''))
        qf.write_text(json.dumps(old, ensure_ascii=False, indent=1))


def cmd_whisper(a):
    """Add the Whisper line to existing QA records (needs faster-whisper; e.g. for the published candidates only)."""
    qa = QA(whisper=True, ctc=False)
    if qa.whisper is None:
        raise SystemExit('faster-whisper is not importable in this venv')
    by_slug = {}
    for slug, voice, seed in jobs(a):
        by_slug.setdefault(slug, []).append(f'{voice}-s{seed}')
    for slug, names in by_slug.items():
        qf = a.work / 'qa' / f'{slug}.json'
        if not qf.exists():
            continue
        old = json.loads(qf.read_text())
        text = script_text(a.scripts, slug)
        for name in names:
            if name not in old or ('whisper' in old[name] and not a.force):
                continue
            old[name].update(qa.whisper_pass(decode(a.work / 'mp3' / slug / f'{name}.mp3', 16000), text))
            log(f"whisper {slug:18s} {name:8s} wer {old[name]['whisper_wer']:.3f}  {old[name]['whisper']}")
        qf.write_text(json.dumps(old, ensure_ascii=False, indent=1))


def judge(slug_qa: dict):
    """Peer test + score + gates for every candidate of one clip. Returns {name: verdict}."""
    names = sorted(slug_qa)
    out = {}
    for n in names:
        r = slug_qa[n]
        peers = [p for p in names if p != n]
        suspects, consistent = [], []
        for i in r['both']:
            if r['words'][i] in RECOGNIZER_LIMITS:
                consistent.append(dict(w=r['words'][i], t=r['word_start'][i], peers_ok=None, note='recognizer limit'))
                continue
            ok = sum(1 for p in peers if not (slug_qa[p]['err']['jg'][i] and slug_qa[p]['err']['b5'][i]))
            rate = ok / len(peers) if peers else 1.0
            (suspects if rate >= 0.75 else consistent).append(dict(w=r['words'][i], t=r['word_start'][i],
                                                                   peers_ok=round(rate, 2)))
        mcer = (r['cer']['jg'] + r['cer']['b5']) / 2
        share = r['pause_sum'] / max(0.1, r['span'])
        score = (100 - 400 * mcer - 3 * len(suspects) - 10 * abs(r['gop']) - 2 * max(0, r['dur'] - DUR_MAX)
                 - 2 * max(0, DUR_MIN - r['dur']) - (5 if share < 0.05 else 3 if share > 0.28 else 0)
                 - (2 if r['tp'] > MAX_TP else 0))
        fails = []
        if not DUR_MIN <= r['dur'] <= DUR_MAX:
            fails.append(f"length {r['dur']} s")
        if r['tp'] > MAX_TP:
            fails.append(f"TP {r['tp']}")
        if abs(r['lufs'] - TARGET_LUFS) > 0.5:
            fails.append(f"LUFS {r['lufs']}")
        if r['clicks'] or r['mp3_clip'] or r['raw_clip_runs']:
            fails.append('clicks/clipping')
        if r['gap_sounds']:
            fails.append('sounds in pauses: ' + ' '.join(g['chars'] + '@' + str(g['t']) for g in r['gap_sounds']))
        content = [s for s in suspects if s['w'] not in FUNCTION_WORDS]
        if content:
            fails.append('misheard: ' + ', '.join(f"{s['w']}@{s['t']}" for s in content))
        out[n] = dict(score=round(score, 1), mean_cer=round(mcer, 4), suspects=suspects, consistent=consistent,
                      fails=fails, pause_share=round(share, 3))
    return out


# ------------------------------------------------------------------------------------------------ publish
def entry_id(e: dict) -> str:
    """A narration.json entry's content id: its `id`, else (an entry from before X5.16) its English clip's basename."""
    return e.get('id') or re.sub(r'\.[a-z0-9]+$', '', Path(e['src']).name)


def load_narration(path: Path) -> list:
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else []


def write_narration(path: Path, entries: list) -> None:
    # the layout public/narrator.js has always been served (indent 1, UTF-8, sorted by title, no final newline);
    # ../make_voice.py writes the same
    entries = sorted(entries, key=lambda e: e['title'])
    path.write_text(json.dumps(entries, indent=1, ensure_ascii=False), encoding='utf-8')


def ffprobe_duration(path: Path) -> float:
    """The clip's length as ../make_voice.py measures the English ones (narration.json durationSec)."""
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         capture_output=True, text=True, check=True).stdout
    return round(float(out), 2)


def cmd_publish(a):
    """The chosen candidate of every clip -> <out>/catastrophes-ru/<slug>-<sha1[:8]>.mp3 and narration.json clips.ru.

    picks.json: {slug: {"pick": "<voice>-s<seed>", "why": "..."}} pins a candidate the verifier chose with a check this
    script does not run (Whisper large-v3 over the published clips). A pin that fails the gates here is still honoured,
    and the failure is logged. Production caches /audio/* for 7 days, so a clip is published under its content hash: the
    same bytes keep their name, new audio gets a new one and the superseded file is deleted once narration.json no
    longer points at it. With --only, every other clip stays as it is."""
    ru, en, stay = cards()
    narration_path = a.out / 'narration.json'
    entries = load_narration(narration_path)
    by_id = {entry_id(e): e for e in entries}
    clip_dir = a.out / CLIP_DIR
    clip_dir.mkdir(parents=True, exist_ok=True)
    only = set(a.only.split(',')) if a.only else None
    old_manifest = {m['slug']: m for m in json.loads(a.manifest.read_text(encoding='utf-8'))} if a.manifest.exists() else {}
    qa_path = a.work / 'qa.json'
    report = json.loads(qa_path.read_text(encoding='utf-8')) if qa_path.exists() and only else {}
    picks = load_picks(a)
    manifest, superseded, problems = [], [], 0
    for slug, c in CASTING.items():
        if only and slug not in only:
            if slug in old_manifest:
                manifest.append(old_manifest[slug])
            continue
        entry = by_id.get(slug)
        if entry is None:
            log(f'publish: {slug}: narration.json has no entry for it: build the English clip first (../make_voice.py)')
            problems += 1; continue
        qf = a.work / 'qa' / f'{slug}.json'
        if not qf.exists():
            log(f'publish: {slug}: no qa yet'); problems += 1; continue
        q_all = json.loads(qf.read_text())
        v = judge(q_all)  # peers = every candidate of this script, in any voice (voice tests add peers)
        q = {n: r for n, r in q_all.items() if r['voice'] == c['voice']}
        if not q:
            log(f'publish: {slug}: no candidate in {c["voice"]}'); problems += 1; continue
        order = sorted(q, key=lambda n: (bool(v[n]['fails']), -v[n]['score']))
        best = order[0]
        pin = picks.get(slug)
        if pin:
            if pin['pick'] in q:
                best = pin['pick']
                log(f"publish {slug}: pinned {best} by picks.json ({pin.get('why', '')})")
            else:
                log(f"publish {slug}: pin {pin['pick']} is not a candidate in {c['voice']}; ignored")
        r = q[best]
        data = (a.work / 'mp3' / slug / f'{best}.mp3').read_bytes()
        name = f'{slug}-{hashlib.sha1(data).hexdigest()[:8]}.mp3'
        dst = clip_dir / name
        if not dst.exists() or dst.read_bytes() != data:
            dst.write_bytes(data)
        old = (entry.get('clips') or {}).get('ru')
        if old and Path(old['src']).name != name:
            superseded.append(clip_dir / Path(old['src']).name)
            log(f'  {slug}: new audio -> {name} (replaces {Path(old["src"]).name})')
        dur = ffprobe_duration(dst)
        entry['id'] = slug
        entry.setdefault('clips', {})['ru'] = dict(src=f'audio/{CLIP_DIR}/{name}', voice=c['voice'], durationSec=dur)
        manifest.append(dict(
            title_en=en[slug]['title'], slug=slug, lang='ru', voice=c['voice'], gender=VOICES[c['voice']]['gender'],
            durationSec=dur, script=script_text(a.scripts, slug), loudnessLUFS=r['lufs'], truePeakDBTP=r['tp'],
            title=ru[slug]['title'], file=name, seed=r['seed'], enVoice=c['en'], casting=c['why'], bytes=len(data)))
        report[slug] = dict(chosen=best, pinned=pin if pin and best == pin['pick'] else None, candidates={n: dict(v[n], dur=q[n]['dur'], cer=q[n]['cer'], gop=q[n]['gop'],
                                                             tp=q[n]['tp'], lufs=q[n]['lufs'], wpm=q[n]['wpm'],
                                                             whisper=q[n].get('whisper'),
                                                             whisper_wer=q[n].get('whisper_wer')) for n in order})
        log(f"publish {slug:18s} {best:8s} score {v[best]['score']:5.1f} dur {dur:5.2f} cer "
            f"{r['cer']['jg']:.3f}/{r['cer']['b5']:.3f} tp {r['tp']} {'FAILS: ' + '; '.join(v[best]['fails']) if v[best]['fails'] else 'ok'}"
            + (f"  consistent: {', '.join(s['w'] for s in v[best]['consistent'])}" if v[best]['consistent'] else ''))
    write_narration(narration_path, entries)
    a.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    qa_path.parent.mkdir(parents=True, exist_ok=True)
    qa_path.write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    # only after narration.json points at the new names: drop superseded clips, and on a full run every clip that no
    # card uses any more
    for f in superseded:
        f.unlink(missing_ok=True)
    if only is None:
        keep = {Path(((e.get('clips') or {}).get('ru') or {}).get('src', '')).name for e in entries}
        for f in clip_dir.glob('*.mp3'):
            if f.name not in keep:
                f.unlink()
                log(f'publish: removed {f.name}: no card uses it any more')
    log(f'publish: {len(manifest)} clips in {clip_dir}, narration.json and {a.manifest.name} written'
        + (f'; {problems} not published' if problems else ''))
    return problems


def load_picks(a) -> dict:
    return json.loads(a.picks.read_text(encoding='utf-8')) if a.picks.exists() else {}


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('cmd', choices=['check', 'design', 'freeze', 'render', 'master', 'qa', 'publish', 'all'])
    p.add_argument('voices', nargs='*', help='design/freeze: voice ids (M1 F1 M2 F2)')
    p.add_argument('--only', help='comma-separated slugs')
    p.add_argument('--voice', help='render/master/qa: override the cast voice (voice tests)')
    p.add_argument('--seeds', type=lambda s: [int(x) for x in s.split(',')],
                   help='default 7,11,23,42,101,5 plus the seed picks.json pins')
    p.add_argument('--seed', type=int, help='freeze: the design seed to cut from')
    p.add_argument('--max-sec', type=float, default=13.0, help='freeze: latest sentence end for the cut')
    p.add_argument('--force', action='store_true')
    p.add_argument('--qa', action='store_true', help='design: score the candidates')
    p.add_argument('--no-whisper', action='store_true')
    p.add_argument('--whisper-only', action='store_true', help='qa: only add the Whisper line to existing records')
    p.add_argument('--update-fp', action='store_true', help='check: record the current RU card fingerprints')
    p.add_argument('--out', type=Path, default=AUDIO,
                   help='the directory served as /audio/: narration.json and catastrophes-ru/ (default public/audio)')
    p.add_argument('--work', type=Path, default=HERE / 'work', help='caches and candidates (git-ignored)')
    p.add_argument('--scripts', type=Path, default=HERE / 'scripts')
    p.add_argument('--voices-dir', type=Path, default=HERE / 'voices')
    p.add_argument('--picks', type=Path, default=PICKS)
    p.add_argument('--manifest', type=Path, default=MANIFEST, help='publish: the record of what was published')
    p.add_argument('--fx', type=Path, default=HERE.parent / 'fx.sh')
    a = p.parse_args()
    for k in ('out', 'work', 'scripts', 'voices_dir', 'picks', 'manifest', 'fx'):
        setattr(a, k, getattr(a, k).resolve())
    os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')
    if a.cmd == 'check':
        sys.exit(1 if cmd_check(a) else 0)
    if a.cmd == 'design':
        return cmd_design(a)
    if a.cmd == 'freeze':
        return cmd_freeze(a)
    if a.cmd in ('render', 'all'):
        cmd_render(a)
    if a.cmd in ('master', 'all'):
        cmd_master(a)
    if a.cmd in ('qa', 'all'):
        cmd_qa(a)
    if a.cmd in ('publish', 'all'):
        sys.exit(1 if cmd_publish(a) else 0)


if __name__ == '__main__':
    main()
