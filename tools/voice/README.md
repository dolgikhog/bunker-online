# Catastrophe narration build

Every catastrophe card has a short spoken clip (a British voice over a low "bunker" room sound) that the game plays
at the start of a game for players who turned the narrator on. This directory regenerates those clips from the card
texts in `server/content.js`.

| File | What it does |
|---|---|
| `make_voice.py` | The build: reads the cards, writes a narration script for each, synthesises it, runs the effects, publishes the MP3s and `narration.json` |
| `extract.mjs` | Reads every catastrophe card through `content.js`'s own dealer. Randomised numbers come back as ranges, e.g. `about {3-8}%` |
| `fx.sh` | The effects and mastering chain for one clip (ffmpeg only): pitch, EQ, room reverb, rumble bed, limiter, two-pass loudness normalisation, MP3 encode |
| `requirements.txt` | The exact Python packages the published clips were made with |

Output, by default into `public/audio/`:
- `catastrophes/<name>.mp3`: one clip per card. MP3, mono, 96 kbps, 44.1 kHz, about 33–40 s.
- `narration.json`: `[{ title, src, voice, durationSec }]`, sorted by title. `public/narrator.js` matches `title` to the
  catastrophe on screen (case-insensitively) and plays `src`. A card without an entry simply has no narration.

Everything else goes to `tools/voice/work/` and `tools/voice/models/`, which git ignores: the model files, cached WAVs,
`work/manifest.json` (the script, casting reason, loudness and true peak of every clip) and `work/samples/`.

## Setup

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

## Run

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

After a build: listen to the changed clips, run `npm test` and `npm run e2e` (the e2e run checks that the narrator
plays), and commit `public/audio/` with the card change.

## Loudness

Every clip is mastered to **-12 LUFS** integrated, measured on the final MP3, with the true peak at or below about
-1.2 dBTP. `fx.sh` corrects the target and the limiter ceiling over up to four rounds to make up for what MP3 encoding
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

Never overwrite a published MP3 in place by hand. Another machine, or another onnxruntime or ffmpeg version, can
change the bytes of an otherwise identical clip and so rename it; rebuild only what changed (`--only`).

## Scripts and casting

- `SCRIPTS` in `make_voice.py` holds a hand-written "ear script" per card: numbers spelled out, units expanded,
  randomised numbers read as their range ("about three to eight per cent"), and pauses written as `[0.8]` (0.8 s of
  silence). Each script stores the fingerprint of the card text it was written from.
- When a card changes, its fingerprint no longer matches. `--check` shows it as `STALE`, and a build falls back to an
  automatic script built by the same rules, with a warning. To fix it, update the script in `SCRIPTS` and put the new
  fingerprint (printed by `--check`) next to it.
- `CASTING` picks the voice, speed, pitch (a pitch-down for male voices, formants preserved) and room level per story.
  A new card with no casting gets the least-used voice from a matching pool, with a warning.
- `PHONEME_FIXES` corrects the few words espeak stresses wrongly (e.g. "nanobots").
