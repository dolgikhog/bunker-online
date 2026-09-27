# Catastrophe narration build

Every catastrophe card has a short spoken clip over a low "bunker" room sound, in English (a British voice) and in
Russian, that the game plays at the start of a game for players who turned the narrator on, in the language of their
screen. This directory regenerates those clips from the card texts: the English ones with Kokoro (`make_voice.py`,
below), the Russian ones with Qwen3-TTS (`ru/make_voice_ru.py`, [Russian narration](#russian-narration)). Both go
through the same effects chain, `fx.sh`.

| File | What it does |
|---|---|
| `make_voice.py` | The English build: reads the cards, writes a narration script for each, synthesises it, runs the effects, publishes the MP3s and `narration.json` |
| `extract.mjs` | Reads every catastrophe card through `content.js`'s own dealer. Randomised numbers come back as ranges, e.g. `about {3-8}%` |
| `fx.sh` | The effects and mastering chain for one clip (ffmpeg only): pitch, EQ, room reverb, rumble bed, limiter, two-pass loudness normalisation, MP3 encode (`MP3_KBPS` or `--kbps`, default 96) |
| `requirements.txt` | The exact Python packages the published English clips were made with |
| `ru/` | The Russian build: `make_voice_ru.py`, its ear scripts, the four frozen voices and the record of what was published. See [Russian narration](#russian-narration) |
| `requirements-ru.txt` | The exact Python packages the published Russian clips were made with |

Output, by default into `public/audio/`:
- `catastrophes/<name>.mp3`: one English clip per card. MP3, mono, 96 kbps, 44.1 kHz, about 33–40 s.
- `catastrophes-ru/<id>-<hash8>.mp3`: one Russian clip per card. MP3, mono, 128 kbps, 44.1 kHz, about 35–40 s.
- `narration.json` (SPEC §11 X5.16): one entry per card, sorted by title:
  `{ title, src, voice, durationSec, id, clips: { ru: { src, voice, durationSec } } }`.
  - The top-level `src`, `voice` and `durationSec` are the English clip (the file's layout from before the Russian
    clips), and the fallback for a language without a clip of its own.
  - `id` is the card's content id. `public/narrator.js` finds the entry by the catastrophe's id (an entry without `id`:
    by its English file name; a state without an id: by `title`, case-insensitively).
  - `clips.ru` is the Russian clip. The narrator plays the clip in the language on screen. A card without an entry
    simply has no narration.
  - Each build writes only its own part and keeps the other's: `make_voice.py` keeps `id` and `clips`, and
    `make_voice_ru.py publish` changes only `id` and `clips.ru`. The layout is fixed: indent 1, UTF-8, no final
    newline (`test/narration.test.js` checks it, with every clip).

Everything else goes to `tools/voice/work/` and `tools/voice/models/`, which git ignores: the model files, cached WAVs,
`work/manifest.json` (the script, casting reason, loudness and true peak of every clip) and `work/samples/`. The
Russian build's own are in `ru/work/`, `.venv-ru/` and the Hugging Face cache, also git-ignored.

## Setup (English)

Needs, on the machine that builds:
- **Python 3** with `venv`. The published clips were made with Python 3.14; the pins in `requirements.txt` are for that.
- **Node.js 22+**, to read the cards.
- **ffmpeg and ffprobe** with `libmp3lame` and `librubberband`. Check with
  `ffmpeg -hide_banner -filters | grep rubberband`. The clips were made with ffmpeg 9.0.1.
- **curl**, to download the model files.
- No GPU: synthesis runs on the CPU, about 10 s per clip.

From the repository root:

```sh
python3 -m venv tools/voice/.venv
tools/voice/.venv/bin/pip install -r tools/voice/requirements.txt
```

### Model files

The build downloads them into `tools/voice/models/` on its first run and checks their sha256. To fetch them by hand
instead (about 350 MB in total):

```sh
mkdir -p tools/voice/models
curl -fL -o tools/voice/models/kokoro-v1.0-timestamped.onnx \
  https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/main/onnx/model.onnx
curl -fL -o tools/voice/models/voices-v1.0.bin \
  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
( cd tools/voice/models && sha256sum -c - ) <<'EOF'
651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054  kokoro-v1.0-timestamped.onnx
bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d  voices-v1.0.bin
EOF
```

- `kokoro-v1.0-timestamped.onnx` (325 MB) is Kokoro-82M v1.0 (Apache-2.0) exported to ONNX with per-token durations.
  The build uses the durations to cut each passage at its sentence ends and put in exactly the scripted pauses.
- `voices-v1.0.bin` (28 MB) is the Kokoro v1.0 voice pack. The build uses its eight British voices
  (`bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis`).

If a checksum no longer matches, the file upstream has changed. A different model gives different audio, so every
clip would change; update `MODEL_SHA256` in `make_voice.py` only on purpose.

## Run (English)

```sh
tools/voice/.venv/bin/python tools/voice/make_voice.py --check              # what is missing or stale; renders nothing
tools/voice/.venv/bin/python tools/voice/make_voice.py --only gray-goo      # rebuild one clip (comma-separate several)
tools/voice/.venv/bin/python tools/voice/make_voice.py                      # rebuild every clip (under 6 min on CPU)
```

| Option | Meaning |
|---|---|
| `--check` | Lists every card: hand-written or automatic script, voice, and whether its clip is `ok`, `NO CLIP` or `STALE`. Also lists clips with no card. Exit code 1 when something needs a rebuild. Loads no model |
| `--only a,b` | Rebuild only these slugs (the title in lower case, with dashes: `The Gray Fever` → `the-gray-fever`). The other clips stay as they are |
| `--force` | Synthesise again even when the WAV for the same script, voice and speed is cached in `work/` |
| `--samples` | Also render comparisons into `work/samples/`: dry vs FX for three stories, and alternative voices for two |
| `--out DIR` | Write somewhere else than `public/audio/`, e.g. to listen before publishing. The `src` paths in `narration.json` still read `audio/catastrophes/…` |

A full build also deletes clips whose card no longer exists. On one machine the build is deterministic: the same
inputs give the same bytes.

After a build: listen to the changed clips, run `npm test` (`test/narration.test.js` checks every clip against
`narration.json`) and `npm run e2e` (the e2e run checks that the narrator plays), and commit `public/audio/` with the
card change.

## Loudness

Every clip, in both languages, is mastered to **-12 LUFS** integrated, measured on the final MP3, with the true peak at
or below about -1.2 dBTP. The English clips are 96 kbps (`fx.sh`'s default), the Russian ones 128 kbps
(`MP3_KBPS=128`): at 96 kbps the deep Russian male voices overshoot the true-peak ceiling. `fx.sh` corrects the target and the limiter ceiling over up to four rounds to make up for what MP3 encoding
changes. The build prints a warning for a clip more than 0.5 LU off the target or above -1.1 dBTP. To try another
target, set `VOICE_LUFS` (e.g. `VOICE_LUFS=-14`) for the whole run; `make_voice.py` and `fx.sh` both read it.

## File names and the 7-day cache

Production serves `/audio/*` with `Cache-Control: public, max-age=604800`: a browser that played a clip keeps it for
**7 days** without asking again. So **a clip whose audio changed must get a new file name**, or returning players hear
the old one for up to a week.

`make_voice.py` does this by itself:
- a render that is byte-identical to the published file keeps its name;
- any other render is published as `<slug>-<hash8>.mp3` (the first 8 hex digits of its sha1), `narration.json` points
  to it, and the superseded file is deleted;
- `narration.json` itself is always fetched with revalidation (`cache: 'no-cache'` in `public/narrator.js`), so
  players pick up a new name on their next page load.

`ru/make_voice_ru.py publish` always publishes `catastrophes-ru/<slug>-<hash8>.mp3`: the same bytes keep their name,
new audio gets a new one, and the superseded file is deleted once `narration.json` points at the new one.

Never overwrite a published MP3 in place by hand (`test/narration.test.js` fails on a hashed name that is not its
file's hash). Another machine, or another onnxruntime, torch or ffmpeg version, can change the bytes of an otherwise
identical clip and so rename it; rebuild only what changed (`--only`).

## Scripts and casting (English)

- `SCRIPTS` in `make_voice.py` holds a hand-written "ear script" per card: numbers spelled out, units expanded,
  randomised numbers read as their range ("about three to eight per cent"), and pauses written as `[0.8]` (0.8 s of
  silence). Each script stores the fingerprint of the card text it was written from.
- When a card changes, its fingerprint no longer matches. `--check` shows it as `STALE`, and a build falls back to an
  automatic script built by the same rules, with a warning. To fix it, update the script in `SCRIPTS` and put the new
  fingerprint (printed by `--check`) next to it.
- `CASTING` picks the voice, speed, pitch (a pitch-down for male voices, formants preserved) and room level per story.
  A new card with no casting gets the least-used voice from a matching pool, with a warning.
- `PHONEME_FIXES` corrects the few words espeak stresses wrongly (e.g. "nanobots").

## Russian narration

The 18 Russian clips are made by `ru/make_voice_ru.py` with **Qwen3-TTS 12Hz 1.7B** (Alibaba Qwen, Apache-2.0), in a
"design then clone" setup:

1. **Design.** VoiceDesign invents each narrator from a plain-English description. A fixed seed makes the render
   repeatable.
2. **Freeze.** The opening sentence or two of that render is cut out and kept as the voice's reference clip
   (`ru/voices/<V>.flac` + `.txt`).
3. **Clone.** The Base model clones that reference for every clip, so a narrator sounds the same across all its clips.

No real person's voice is involved. Kokoro has no Russian, so it is not in this chain.

The mastering is the English chain unchanged, `fx.sh`, with `MP3_KBPS=128` (see [Loudness](#loudness)). Pitch is 1.0
for every Russian voice (they are designed deep), and the room level follows the English casting.

### Files

| Path (in `tools/voice/`) | What |
|---|---|
| `ru/make_voice_ru.py` | The whole pipeline: `check`, `design`, `freeze`, `render`, `master`, `qa`, `publish`, `all`. Every default path is relative to it |
| `ru/scripts/<slug>.ru.txt` | The 18 hand-written ear scripts, one phrase per line |
| `ru/scripts/card_fp.json` | The fingerprint of each Russian card when its script was written; `check` warns when a card changes |
| `ru/voices/{M1,M2,F1,F2}.flac`, `.txt`, `.json` | The four frozen narrators: the reference audio (24 kHz, 16-bit, stored losslessly as FLAC), its exact transcript, and how it was made (the design prompt, seed, design text, cut point, and the sha256 of the WAV the FLAC decodes to) |
| `ru/picks.json` | The verifier's pinned candidates, each with its reason; `publish` honours them and `render` renders their seeds |
| `ru/manifest.json` | What `publish` published: per clip the file, voice, seed, script, length, loudness, true peak and casting |
| `requirements-ru.txt` | The Python packages, pinned |
| `ru/work/` (git-ignored) | Design renders, the candidates (`wav/<slug>/<V>-s<seed>.wav`, `mp3/…`), the restored reference WAVs, the QA cache (`qa/<slug>.json`) and `qa.json`, the numbers behind every choice |

### Setup

Needs, on the machine that builds:
- **a CUDA GPU** with about 6 GB free for `design`, `render` and `qa`. A render holds about 5.6 GB, so do not run two
  on a 12 GB card at once. CPU works, but it is very slow. `check`, `master` and `publish` need no GPU.
- **ffmpeg and ffprobe** with libmp3lame and librubberband, as for English;
- **node**, which reads the content files;
- **[uv](https://docs.astral.sh/uv/)**, or Python 3.12 with `venv` and pip.

From the repository root:

```sh
uv venv --python 3.12 tools/voice/.venv-ru
uv pip install --python tools/voice/.venv-ru -r tools/voice/requirements-ru.txt
# optional, only for the information-only Whisper line of `qa`:
uv pip install --python tools/voice/.venv-ru faster-whisper==1.2.1 num2words==0.5.14
```

The pins are the exact set the clips were made with: Python 3.12.14, torch 2.14.0 (the PyPI wheel, CUDA 13.0),
torchaudio 2.11.0, qwen-tts 0.1.1 and transformers 4.57.3. qwen-tts prints warnings about SoX and flash-attn. Neither
is needed: the script uses `sdpa` attention and resamples nothing through SoX.

**GPU hang reapers.** A machine that runs `nvidia-hang-reaper` (desk does) kills a long autoregressive CUDA loop as a
hang. Start every GPU step with `NVIDIA_HANG_REAPER_SKIP=1` in its environment. The script refuses to start a GPU step
without it while a reaper is running. Elsewhere the variable does nothing.

### Model download

The models download on first use, through `huggingface_hub`, into `HF_HOME` (default `~/.cache/huggingface`). Each
one is pinned to a revision in `make_voice_ru.py`, and after every download the script checks the sha256 of its weight
files (`MODEL_SHA256`). If a checksum does not match, it stops: a different file gives different audio.

| Model | Revision | Download | Licence | Needed for |
|---|---|---|---|---|
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `fd4b254389122332181a7c3db7f27e918eec64e3` | 4.3 GB | Apache-2.0 | `render` |
| `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | `5ecdb67327fd37bb2e042aab12ff7391903235d3` | 4.3 GB | Apache-2.0 | `design` (only to re-create a voice) |
| `jonatasgrosman/wav2vec2-large-xlsr-53-russian` | `2329100508896c6d9b157019803ab5601e6f3406` | 3.8 GB | Apache-2.0 | `qa` |
| `bond005/wav2vec2-large-ru-golos` | `c361ee1f5bd6589ac7abe8f5bb6d136561339cb0` | 1.2 GB | Apache-2.0 | `qa` |
| `Systran/faster-whisper-large-v3` | `edaa852ec7e145841d8ffdb056a99866b5f0a478` (tested; not pinned in the code) | 3 GB | MIT | `qa` Whisper line, optional |

To fetch them ahead of time and check them by hand:

```sh
for m in Qwen/Qwen3-TTS-12Hz-1.7B-Base@fd4b254389122332181a7c3db7f27e918eec64e3 \
         Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign@5ecdb67327fd37bb2e042aab12ff7391903235d3 \
         jonatasgrosman/wav2vec2-large-xlsr-53-russian@2329100508896c6d9b157019803ab5601e6f3406 \
         bond005/wav2vec2-large-ru-golos@c361ee1f5bd6589ac7abe8f5bb6d136561339cb0; do
  tools/voice/.venv-ru/bin/hf download "${m%@*}" --revision "${m#*@}"
done
```

| File | sha256 |
|---|---|
| Base `model.safetensors` | `38fc7fc51c5e776e840414b6fd443962e9411b9654888fd7913e4da643cb857c` |
| VoiceDesign `model.safetensors` | `391e8db219f292c515297cdceeb43e4eae67cdde35fa57e79a6a8a532fca0522` |
| Base and VoiceDesign `speech_tokenizer/model.safetensors` | `836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258` |
| jonatasgrosman `pytorch_model.bin` | `d1cdb1a7921de7d363f967a9b0101a713602e109dba62b6f3f9ae2e0b2df0c1c` |
| bond005 `pytorch_model.bin` | `db2a4ee1d1cb6d5b72c1128c0baaf5ab9c95b4931031604b2d5c9787ebc2781d` |

### Run

```sh
R=tools/voice/.venv-ru/bin/python
$R tools/voice/ru/make_voice_ru.py check                  # the scripts against the cards, and the published clips; no GPU
NVIDIA_HANG_REAPER_SKIP=1 $R tools/voice/ru/make_voice_ru.py all                     # render, master, qa, publish
NVIDIA_HANG_REAPER_SKIP=1 $R tools/voice/ru/make_voice_ru.py all --only spore-rain --seeds 13,17,31,64,77,99
NVIDIA_HANG_REAPER_SKIP=1 $R tools/voice/ru/make_voice_ru.py design M2 --seeds 7,11,23,42,101 --qa
NVIDIA_HANG_REAPER_SKIP=1 $R tools/voice/ru/make_voice_ru.py freeze M2 --seed 23
```

- `check` compares every script with its cards: the spoken survivor range against the English card's `{n:a-b}`, the
  spoken "safe" range against `STAY` in `server/content/gen.js`, a missing ё, and the Russian card's fingerprint. It
  also reports each card's Russian clip in `narration.json`. Exit code 1 when something needs doing.
- `all` renders 6 candidates per clip (seeds 7, 11, 23, 42, 101 and 5, plus the seed `picks.json` pins), masters them,
  runs QA, and publishes the best candidate per clip.
- `--only` limits any step to some clips, and `--seeds` replaces the default seeds. More candidates also make the peer
  test stronger.
- `--voice V` renders a clip in a voice other than its cast one. This is how voice tests and recasting are tried, and
  the extra renders also serve as peers.
- `design` and `freeze` re-create a voice from its description. They are not bit-exact on another GPU: the frozen
  clip in `ru/voices/` is the voice.
- Every step caches its output in `ru/work/`, and `--force` redoes it. `--out`, `--work`, `--scripts`,
  `--voices-dir`, `--picks`, `--manifest` and `--fx` move the files.

`publish` writes `public/audio/catastrophes-ru/<slug>-<hash8>.mp3`, the card's `clips.ru` in `narration.json` and
`ru/manifest.json`. With `--only`, the other clips stay as they are; a full run also deletes the clips no card uses.
After a build: listen to the changed clips, run `npm test` and `npm run e2e`, and commit `public/audio/` and `ru/`.

**Reproducibility.** On one GPU a render is deterministic. On desk (RTX 3080 Ti, bf16, sdpa), nuclear-winter in M1 with
seed 7 came out bit-identical to the sampling run's render. `master` and `publish` are deterministic on any machine
with the same ffmpeg. From the published candidates' raw renders, they give the published MP3s byte for byte.

**Timing on desk:**
- rendering runs at 1.3× real time, about 46 s per 35 s candidate;
- the 108 candidates of a full run take about 85 minutes;
- mastering takes about 8 s per candidate on the CPU;
- QA takes 1–2 s per candidate on the GPU, or 13 s on the CPU.

### Voices

Each voice's design prompt is an English VoiceDesign instruction (the full text is in `VOICES` in the script and in
`ru/voices/<V>.json`). The text the model reads is Russian. F0 is the median over all production candidates (YIN).

| Id | Gender | Character | Design seed | F0 | Reference | Clips |
|---|---|---|---|---|---|---|
| M1 | male | deep, grave announcer, 50s, "last emergency broadcast" | 7 | 107 Hz | 11.7 s, nuclear-winter opening | 7 |
| M2 | male | older (60s), low, weary, slightly gravelly, calm dread | 23 | 82 Hz | 9.0 s, new-ice-age opening | 5 |
| F1 | female | soft, quiet, unnervingly polite, eerie | 23 | 214 Hz | 9.5 s, the-visitors opening | 3 |
| F2 | female | 40s, cool, clear, clinical public-health official | 11 | 206 Hz | 7.9 s, the-gray-fever opening | 3 |

- M1 and F1 won the sampling run (23 renders of several engines and voices, scored by two recognizers and a peer test).
- M2 and F2 were made for production. Five design seeds were scored for each with `design --qa`, the best two frozen,
  and each had to pass M1's and F1's voice test: CER within 1 point of the winner, no misheard content words, and no
  artifacts, on at least 2 of 3 clone seeds.

### Casting

Mirrors the English casting (`CASTING` in `make_voice.py`). Each English voice maps to the Russian voice closest in
mood, and gender is kept. No Russian voice takes more than 7 clips.

| RU | EN | Clips |
|---|---|---|
| M1 grave announcer (7) | bm_george (grave) + bm_daniel (procedural newsreader) + gamma-ray-burst (bm_lewis) | nuclear-winter, asteroid-impact, supervolcano, machine-uprising, gray-goo, solar-superflare, gamma-ray-burst |
| M2 older, weary (5) | bm_lewis (heavy, weary) + bm_fable (campfire storyteller) | new-ice-age, scorched-earth, the-great-flood, the-biting-plague, pole-reversal |
| F1 soft, eerie (3) | bf_lily + bf_isabella (hushed, elegiac) | the-visitors, spore-rain, silent-spring |
| F2 cold, clinical (3) | bf_emma (ministry briefing) + bf_alice (civil-defence warning) | the-gray-fever, the-barren-plague, the-yellow-cloud |

gamma-ray-burst was cast to M2 at first, like the rest of Lewis's clips. M2 failed the gates on all 10 of its seeds, so
the clip moved to M1, which passed on 2 of 6. The room is -8.5 dB for the-visitors and -9 dB for spore-rain, and
`fx.sh`'s default for every other clip.

### Scripts

The scripts are written for the ear from `server/content/ru/catastrophes.js`. That file's numbers are placeholders:
`{0}` stands for the English file's `{n:a-b}`, and `{range}` for `STAY`. Each script reads the title, a shortened
version of the text, and then the details: «Выжившие: от X до Y процентов», «На поверхности: …», «Угрозы: …» and
«Поверхность станет безопасной через X... или через Y».

- **Numbers are words, in the right case:** «от трёх до восьми процентов», «через полтора года... или через пять».
- **ё is written everywhere**, since Qwen3 has a ё token.
- **No stress marks**, since Qwen3 has no notation for them. Homographs are rephrased instead: «лесные пожары» (not
  леса́), «Бункер — на возвышенности» (not стои́т), «за сухую землю» (not су́ши), «северный и южный полюс» (not
  полюса́).
- **Pauses come from punctuation only:** "..." and "—". Qwen3 reads each script in one call.
- **Length:** each script fits its voice's measured rate (about 155–165 syllables for M1/M2, 138–150 for F1/F2), so
  the clips come out at 34.7–39.9 s. The Russian text is therefore shorter than the card. Every detail line is kept.

When a card changes, `check` shows it. Re-read that card's ear script, then run `check --update-fp`.

### QA and publishing

QA runs on every candidate. It uses two phonetic CTC recognizers with no language model (CER, and the words both
mishear), a peer test against every other candidate of the same script (a word is a *suspect* when both recognizers
miss it here but read it right in ≥ 75 % of the peers), forced-alignment GOP, CTC emissions in the pauses, digital
clicks, clipping, and the MP3's length, loudness and true peak. Candidates are scored as
`100 − 400·CER − 3·suspects − 10·|GOP|`, less length and pause penalties.

A candidate is published only if it passes every gate: 20–40 s, TP ≤ -1.2 dBTP, -12 ± 0.5 LUFS, no click or
clipping, no sound in the pauses, and no suspect content word. Among those that pass, the highest score wins. If none
passes, the best is still published and its failures are logged; the fix is more seeds or a rephrase.

Whisper large-v3 (its language model repairs mispronunciations, so it is information only in `qa`) was the verifier's
extra gate on content words. It heard the full script in all 18 published clips (WER 0–3.1 %, only spacing variants
and «ни»/«не»). The verifier pinned six clips in `ru/picks.json`, each with its reason: a truncated ending, an ending
tick, a content word Whisper misheard, or a candidate that failed the gates once there were more peers.

### Result (2026-09-27)

All 18 clips pass every gate. "Listen at" gives the words both recognizers consistently spell differently, with MP3
seconds. Most are correct Russian phonetics (devoicing, vowel reduction), but they are where to listen first.
**Nobody has listened to the clips yet**, and stress and intonation still need an ear.

| Clip | Voice | Seed | s | Listen at |
|---|---|---|---|---|
| nuclear-winter | M1 | 23 | 38.66 | |
| asteroid-impact | M1 | 11 | 38.42 | астероида 1.4, Астероид 2.7, сутки 26.3 |
| supervolcano | M1 | 5 | 39.14 | Йеллоустоун 2.7 |
| machine-uprising | M1 | 7 | 39.94 | |
| gray-goo | M1 | 101 | 38.66 | слизь 1.2, наноботы 3.5 |
| solar-superflare | M1 | 11 | 39.06 | супервспышка 1.5, повреждённый 13.2, ожог 22.7 |
| new-ice-age | M2 | 101 | 37.14 | кончилась 12.3, экваторе 13.7 |
| scorched-earth | M2 | 7 | 39.38 | вечной 3.4 |
| gamma-ray-burst | M1 | 5 | 38.90 | озонового 12.9 |
| the-great-flood | M2 | 42 | 36.02 | ледники 2.5, Антарктиды 3.1, глубь 10.5, захлестнули 11.3 |
| the-biting-plague | M2 | 101 | 39.22 | штамм 3.1 |
| pole-reversal | M2 | 7 | 37.06 | северный 2.5, магнитное 5.3 |
| the-visitors | F1 | 101 | 34.74 | |
| spore-rain | F1 | 53 | 35.94 | «из спор» 1.5–2.0 (Whisper hears «и спор») |
| silent-spring | F1 | 101 | 36.82 | погиб 7.6, пищевая 10.8, цепочка 11.4, последнее 13.9 |
| the-gray-fever | F2 | 7 | 37.86 | сереет 4.6 |
| the-barren-plague | F2 | 7 | 38.10 | девяноста 20.7 |
| the-yellow-cloud | F2 | 77 | 37.30 | облако 1.5, местное 21.0, изъеденный 24.5 |

### Licences

- **Qwen3-TTS:** the weights (Base, VoiceDesign and the bundled 12 Hz speech tokenizer) and the code
  (`QwenLM/Qwen3-TTS`, pip `qwen-tts` 0.1.1) are Apache-2.0. The repository ships neither weights nor code, only the
  audio they generate and the four reference clips, and Apache-2.0 places no restriction on generated output.
- **QA only:** the two wav2vec2 recognizers are Apache-2.0, and faster-whisper-large-v3 is MIT. Nothing from them
  ships.
- **Voices:** they come from text descriptions, not recordings. No real person's voice is cloned, and no third-party
  voice is used.
- Checked at the primary sources (Hugging Face card metadata at the pinned revisions, and the GitHub LICENSE files) on
  2026-09-26.
