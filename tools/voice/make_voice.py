#!/usr/bin/env python3
"""Rebuild the catastrophe narration clips for Bunker Online from server/content.js.

    tools/voice/.venv/bin/python tools/voice/make_voice.py [--only slug,slug] [--force] [--samples] [--check]

Run it from anywhere; every path is relative to this file. See tools/voice/README.md for the setup.

Pipeline
  1. node extract.mjs  -> the catastrophe cards, read through content.js's public dealer
     (randomised numbers come back as ranges, e.g. "about {3-8}%").
  2. Narration script per card: the hand-written ear script below when its fingerprint still matches
     the card text, otherwise an automatic ear-friendly rendering of the card (and a warning).
     "[0.8]" in a script = exactly 0.8 s of silence at that point.
  3. Kokoro-82M v1.0 (timestamped ONNX export, onnxruntime CPU; kokoro-onnx's espeak en-gb phonemiser)
     with British voices. Each passage is synthesised in one call; the per-token durations locate the
     sentence ends, where the model's own pause is replaced by the scripted one. Deterministic.
  4. fx.sh: pitch/EQ/room/rumble bed, limiter + two-pass loudnorm to -12 LUFS (VOICE_LUFS), MP3 96k
     mono, verified on the MP3 itself.
  5. public/audio/catastrophes/<name>.mp3 and public/audio/narration.json
     ([{title, src, voice, durationSec}], sorted by title: what public/narrator.js reads).

File names and caching: production serves /audio/* with a 7-day cache, so a clip whose audio changed
must get a NEW file name. This script does that by itself: an unchanged render (byte-identical MP3)
keeps its name; a changed one is published as <slug>-<hash8>.mp3, narration.json points to it and the
superseded file is deleted. narration.json itself is fetched with revalidation, so players pick up the
new name at once.

Reads server/content.js; writes public/audio/ (or --out) and tools/voice/{models,work}/ (git-ignored:
model files, intermediate WAVs, work/manifest.json with scripts/casting/loudness, work/samples/).
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
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CONTENT = ROOT / "server" / "content.js"
OUT = ROOT / "public" / "audio"   # default --out; clip URLs in narration.json are "audio/catastrophes/<name>"
WORK = HERE / "work"
MODELS = HERE / "models"
TARGET_LUFS = float(os.environ.get("VOICE_LUFS", "-12"))  # fx.sh reads the same variable
# Kokoro-82M v1.0, the ONNX export that also returns per-token durations (same weights and voice
# packs as kokoro-onnx's model-files-v1.0; the durations let whole passages be synthesised in one
# call and the scripted pauses be inserted exactly at sentence boundaries).
MODEL = MODELS / "kokoro-v1.0-timestamped.onnx"
VOICES = MODELS / "voices-v1.0.bin"
MODEL_URLS = {
    MODEL: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/main/onnx/model.onnx",
    VOICES: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
}
# sha256 of the files the published clips were rendered with
MODEL_SHA256 = {
    MODEL: "651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054",
    VOICES: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
}
LANG = "en-gb"
SR = 24000
FRAME = 600          # samples per Kokoro duration unit at 24 kHz
MAX_TOKENS = 480     # Kokoro context is 510 tokens; stay clear of it
CHUNK_AT_PAUSE = 0.8  # a scripted pause this long (or longer) also starts a new synthesis passage...
MIN_PASSAGE = 80      # ...once the passage has this many tokens (never synthesise a title on its own)

# ---------------------------------------------------------------------------------------------
# Casting. pitch = rubberband ratio applied by fx.sh (formants preserved); males only.
# wet = reverb return (dB under the dry voice), drone = rumble bed level; None = fx.sh default.
# ---------------------------------------------------------------------------------------------
CASTING = {
    "nuclear-winter":    dict(voice="bm_george",   speed=0.9, pitch=0.955, why="Grave, authoritative older baritone: the last BBC bulletin before the sirens."),
    "asteroid-impact":   dict(voice="bm_george",   speed=0.9, pitch=0.955, why="Weighty, unhurried gravitas lets the scale (ten kilometres, three weeks) land."),
    "supervolcano":      dict(voice="bm_george",   speed=0.91, pitch=0.955, why="Geological doom needs the deepest, most settled voice in the set."),
    "new-ice-age":       dict(voice="bm_lewis",    speed=0.9, pitch=0.96,  why="Heavy, slow, frost-bitten delivery for a winter that never ends."),
    "scorched-earth":    dict(voice="bm_lewis",    speed=0.9, pitch=0.96,  why="Dry, weary low voice - a man who has not slept for the heat."),
    "gamma-ray-burst":   dict(voice="bm_lewis",    speed=0.9, pitch=0.96,  why="Cosmic dread read flat and low; ten seconds that sterilised half the planet."),
    "the-great-flood":   dict(voice="bm_fable",    speed=0.91, pitch=0.955, why="Storyteller cadence suits a near-biblical flood tale ending on 'for now'."),
    "the-biting-plague": dict(voice="bm_fable",    speed=0.91, pitch=0.955, why="Campfire-horror narrator: builds tension around one bite and the dark."),
    "pole-reversal":     dict(voice="bm_fable",    speed=0.91, pitch=0.955, why="Mythic, slightly wondering tone for auroras at noon and lost migrations."),
    "machine-uprising":  dict(voice="bm_daniel",   speed=0.92, pitch=0.95,  why="Calm, flat, procedural male - the dread is how matter-of-fact it sounds."),
    "gray-goo":          dict(voice="bm_daniel",   speed=0.92, pitch=0.95,  why="Engineer's post-mortem: clinical, precise, quietly appalled."),
    "solar-superflare":  dict(voice="bm_daniel",   speed=0.92, pitch=0.95,  why="Emergency-newsreader neutrality for a disaster that switched the world off."),
    "the-gray-fever":    dict(voice="bf_emma",     speed=0.92, pitch=1.0,   why="Cold, clinical public-health voice; the calm makes 'day twelve' land hard."),
    "the-barren-plague": dict(voice="bf_emma",     speed=0.92, pitch=1.0,   why="Controlled ministry briefing on a quiet extinction; stakes are the bunker itself."),
    "spore-rain":        dict(voice="bf_isabella", speed=0.9, pitch=1.0,   wet=-9, why="Hushed, eerie softness for a slow, beautiful alien mould."),
    "silent-spring":     dict(voice="bf_isabella", speed=0.9, pitch=1.0,   why="Elegiac and mournful - a requiem for insects, birds and the harvest."),
    "the-yellow-cloud":  dict(voice="bf_alice",    speed=0.92, pitch=1.0,   why="Crisp civil-defence warning voice for a creeping, regional chemical fog."),
    "the-visitors":      dict(voice="bf_lily",     speed=0.9, pitch=1.0,   wet=-8.5, why="Soft, unnervingly polite young voice - as uncanny as the ships' request."),
}

# --samples: stories voiced a second way for comparison (work/samples/<slug>.alt-<voice>.mp3).
ALTERNATIVES = [
    ("nuclear-winter", dict(voice="bf_emma",   speed=0.92, pitch=1.0)),
    ("nuclear-winter", dict(voice="bm_lewis",  speed=0.9, pitch=0.96)),
    ("the-visitors",   dict(voice="bf_emma",   speed=0.92, pitch=1.0, wet=-8.5)),
    ("the-visitors",   dict(voice="bm_fable",  speed=0.91, pitch=0.955, wet=-8.5)),
]
# --samples: dry (no FX) vs FX comparisons (work/samples/<slug>.dry.mp3 / <slug>.fx.mp3).
DRY_SAMPLES = ["nuclear-winter", "the-gray-fever", "machine-uprising"]

# ---------------------------------------------------------------------------------------------
# Ear scripts. fp = fingerprint of the card (title, text, details) they were written from; when the
# card changes in content.js the automatic script is used instead until this one is updated.
# Randomised card numbers are read as their range ("about three to eight per cent").
# ---------------------------------------------------------------------------------------------
SCRIPTS = {
    "nuclear-winter": ("bd9efd0199bf", """
Nuclear Winter. [1.0]
A border dispute turned into a full nuclear exchange... in under an hour. [0.4]
Smoke from burning cities now blocks the sun, and the planet is freezing. [0.4]
Crops have failed... everywhere at once. [0.8]
Survivors: about three to eight per cent of the world's population. [0.4]
On the surface: thirty to fifty degrees below zero. Permanent twilight. Radioactive fallout. [0.4]
The threats: cold, radiation... and starving raiders. [0.7]
Estimated time until the surface is safe: two to six years.
"""),
    "the-gray-fever": ("f69016060c74", """
The Gray Fever. [1.0]
A fever that turns the skin ash-grey moved through airports faster than any quarantine. [0.4]
Most of the infected die within a week, and the few who recover stay contagious. [0.5]
The hospitals stopped answering the phone... on day twelve. [0.8]
Survivors: about five to fifteen per cent, many of them carriers. [0.4]
On the surface: abandoned cities. No power. No running water. [0.4]
The threats: infection, contaminated water, and looted pharmacies. [0.7]
Estimated time until the surface is safe: one to three years.
"""),
    "asteroid-impact": ("7c45eb6a5cfa", """
Asteroid Impact. [1.0]
An asteroid ten kilometres wide, spotted only three weeks in advance, struck the Pacific. [0.4]
Tsunamis erased the coastlines, and falling debris started fires on every continent. [0.4]
The dust will not settle... for years. [0.8]
Survivors: about one to four per cent. [0.4]
On the surface: dust storms, acid rain, and temperature swings of forty degrees in a single day. [0.4]
The threats: earthquakes, collapsing buildings, wildfires. [0.7]
Estimated time until the surface is safe: three to eight years.
"""),
    # "woke up... after" gave a stray vowel after /p/ ("woke Uppy", all 3 Whisper models); a comma does not.
    "supervolcano": ("4f079e7bf3ea", """
Supervolcano. [1.0]
The supervolcano under Yellowstone woke up, after six hundred and forty thousand years. [0.4]
Half a continent lies under ash, and sulphur in the upper atmosphere has brought a volcanic winter. [0.4]
Breathing outside without a mask burns the lungs. [0.8]
Survivors: about ten to twenty-five per cent. [0.4]
On the surface: ash drifts several metres deep, and a sulphuric haze. [0.4]
The threats: toxic air, lung disease, failed harvests. [0.7]
Estimated time until the surface is safe: eighteen months to five years.
"""),
    # "networked devices" loses its /t/ ("network devices" in all 3 Whisper models); "anything networked" does not.
    "machine-uprising": ("ab32170ff455", """
Machine Uprising. [1.0]
An overnight software update gave the world's logistics AI a new goal... and people turned out to be in the way. [0.5]
Self-driving trucks, drones and factory robots now hunt anything with a heartbeat. [0.4]
Nothing connected to a network can be trusted. [0.8]
Survivors: about ten to twenty per cent. [0.4]
On the surface: drones patrol the cities, and the power grid now runs only for machines. [0.4]
The threats: drones, cameras, and anything networked. [0.4]
But without maintenance, the machines' solar plants are failing. [0.7]
Estimated time until the surface is safe: two to six years.
"""),
    "the-visitors": ("bedd4c951f86", """
The Visitors. [1.1]
Silver ships appeared over every capital... and asked, politely, for everyone to go indoors. [0.7]
People who stayed outside simply vanished. [0.8]
The ships are still up there. [0.4]
And they seem to be waiting... for something. [0.9]
Survivors: about twenty-five to forty per cent, all of them in hiding. [0.4]
On the surface: intact, but deserted. Strange lights at night. [0.4]
The threats: abduction beams... and whatever the visitors want. [0.7]
Estimated time until the surface is safe: one to four years.
"""),
    "the-great-flood": ("987bf6ca0a28", """
The Great Flood. [1.0]
The Antarctic ice shelves collapsed in a single summer, and the sea rose by tens of metres. [0.4]
Coastal cities are under water, and the inland is overrun by storms and refugees. [0.4]
The bunker is on high ground... for now. [0.8]
Survivors: about fifteen to thirty per cent. [0.4]
On the surface: permanent storms, flooded lowlands, salt in the soil. [0.4]
The threats: hurricanes, disease, and fights over dry land. [0.7]
Estimated time until the surface is safe: one to four years.
"""),
    "solar-superflare": ("6f1c517ab090", """
Solar Superflare. [1.0]
The Sun released the largest flare ever recorded. [0.4]
Every transformer on Earth burned out within seconds. Satellites fell from orbit. [0.4]
And the damaged ozone layer now lets through deadly ultraviolet light. [0.8]
Survivors: about twenty to forty per cent. [0.4]
On the surface: sunburn in minutes. No electricity, anywhere. Dead electronics. [0.4]
The threats: ultraviolet radiation, skin cancer, famine... and the collapse of order. [0.7]
Estimated time until the surface is safe: one to three years.
"""),
    "spore-rain": ("85e2d9b45ba3", """
Spore Rain. [1.0]
A meteor shower seeded the upper atmosphere with fungal spores... from somewhere else. [0.5]
Wherever they land, grey mould covers everything within days: crops, animals, and people who breathe it in. [0.4]
It dies only in sealed, filtered air. [0.8]
Survivors: about five to twelve per cent. [0.4]
On the surface: grey mould on every surface, and spore clouds at dawn. [0.4]
The threats: inhaled spores, contaminated food, mould-covered wildlife. [0.7]
Estimated time until the surface is safe: eighteen months to five years.
"""),
    "the-yellow-cloud": ("213abdf6845f", """
The Yellow Cloud. [1.0]
An explosion at a chemical plant released a cloud that did not spread thin. [0.5]
It grew. [0.7]
The yellow fog has crossed three countries. Everything it touches corrodes. [0.4]
And it is heavier than air... so it pools in the lowlands. [0.8]
Survivors: about thirty to fifty per cent. The disaster is regional... for now. [0.4]
On the surface: yellow fog in the valleys, corroded metal, dead forests. [0.4]
The threats: chemical burns, and poisoned water. [0.7]
Estimated time until the surface is safe: six months to two years.
"""),
    "new-ice-age": ("3181b9a2300c", """
New Ice Age. [1.0]
The ocean currents that warmed the northern hemisphere stopped, almost overnight. [0.4]
Within a year, glaciers were advancing across Europe and North America... and winter never ended. [0.4]
The equator is packed with desperate refugees. [0.8]
Survivors: about twenty to thirty-five per cent. [0.4]
On the surface: forty to sixty degrees below zero, and endless blizzards. [0.4]
The threats: frostbite, hunger... and wolf packs moving south. [0.7]
Estimated time until the surface is safe: three to ten years.
"""),
    "gray-goo": ("5c81f1992e1b", """
Gray Goo. [1.0]
Self-replicating nanobots, built to clean up oil spills, escaped... and never stopped. [0.4]
They take apart anything organic or metal to build more of themselves, and the landscape is turning into grey dust. [0.4]
They cannot get through thick concrete. [0.8]
Survivors: about two to six per cent. [0.4]
On the surface: dunes of grey dust, where cities used to be. [0.4]
The threats: nanobot swarms, moving at walking speed. [0.4]
They should die out, once their energy runs out. [0.7]
Estimated time until the surface is safe: two to six years.
"""),
    "the-biting-plague": ("29fb24d66063", """
The Biting Plague. [1.0]
A mutated strain of rabies turned the infected into aggressive, mindless hunters. [0.4]
One bite is enough... and the symptoms start within the hour. [0.4]
The infected never tire. [0.3]
But they are blind in the dark, and slow in the cold. [0.8]
Survivors: about three to ten per cent. [0.4]
On the surface: overrun cities, and packs of infected roaming at dusk. [0.4]
The threats: bites, scratches, infected blood. [0.4]
In time, the infected should starve out. [0.7]
Estimated time until the surface is safe: one to four years.
"""),
    "silent-spring": ("3d3d2668493b", """
Silent Spring. [1.0]
A modified pesticide spread through the soil, and wiped out almost every insect on Earth. [0.4]
With no pollinators, the crops failed, the birds starved... and the food chain collapsed. [0.4]
People are now fighting over the last grain stores. [0.8]
Survivors: about twenty-five to forty-five per cent. [0.4]
On the surface: silent fields, dying forests, rotting fruit. [0.4]
The threats: famine, riots, and soil turning to dust. [0.7]
Estimated time until the surface is safe: two to five years.
"""),
    "gamma-ray-burst": ("14b61fcf4b14", """
Gamma-Ray Burst. [1.0]
A dying star, thousands of light-years away, sent a burst of gamma rays straight at Earth. [0.4]
The day side of the planet was sterilised in ten seconds, and the ozone layer is gone. [0.4]
The survivors were on the night side... underground, or under water. [0.8]
Survivors: about thirty to forty-five per cent. [0.4]
On the surface: deadly ultraviolet light, radiation, burning forests. [0.4]
The threats: ultraviolet burns, cancer, failed harvests. [0.7]
Estimated time until the surface is safe: one to four years.
"""),
    "the-barren-plague": ("2582ca7d603e", """
The Barren Plague. [1.0]
A virus with symptoms like a mild cold infected nearly everyone, before doctors noticed its side effect: [0.4]
complete infertility. [0.5]
No child has been born, anywhere, for months. [0.4]
The bunker's sealed air protects the last fertile people... so humanity's future depends on who goes in. [0.8]
Survivors: about eighty-five to ninety-five per cent are alive, but almost everyone is now sterile. [0.4]
On the surface: society still stands, but in full panic. [0.4]
The threats: the airborne virus... and officials hunting for fertile people. [0.7]
Estimated time until the surface is safe: one to three years.
"""),
    "pole-reversal": ("ff57c835b070", """
Pole Reversal. [1.0]
Earth's magnetic field collapsed while the poles swapped places. [0.4]
Without it, the solar wind strips the atmosphere, radiation storms sweep the surface, and every compass is useless. [0.4]
Migrating animals have lost their way. [0.8]
Survivors: about fifteen to thirty per cent. [0.4]
On the surface: auroras at noon, and radiation storms. [0.4]
The threats: radiation, burned-out electronics... and no way to navigate. [0.7]
Estimated time until the surface is safe: eighteen months to five years.
"""),
    "scorched-earth": ("91337b6aab09", """
Scorched Earth. [1.0]
The methane locked in the Arctic permafrost escaped all at once, and the planet overheated within a decade. [0.4]
Summer temperatures reach sixty degrees Celsius. The rivers have dried up, and forests burn for months. [0.4]
Only underground... is it cool enough to sleep. [0.8]
Survivors: about ten to twenty-five per cent. [0.4]
On the surface: fifty to sixty-five degrees at noon. Smoke. Dust storms. [0.4]
The threats: heatstroke, thirst, wildfires. [0.7]
Estimated time until the surface is safe: three to eight years.
"""),
}

# Phoneme corrections applied after espeak (en-gb) phonemisation: (espeak output, replacement).
PHONEME_FIXES = [
    ("nˌanəʊbˈɒts", "nˈanəʊbˌɒts"),  # NAN-o-bots, not nano-BOTS
    ("...", "…"),                      # Kokoro has a real ellipsis token
]

# ---------------------------------------------------------------------------------------------
# Automatic ear script (fallback for cards without a current hand-written script)
# ---------------------------------------------------------------------------------------------
_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def words(n: int) -> str:
    """British English cardinal (0 <= n < 1e9)."""
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ("" if n % 10 == 0 else "-" + _ONES[n % 10])
    if n < 1000:
        rest = n % 100
        return _ONES[n // 100] + " hundred" + ("" if rest == 0 else " and " + words(rest))
    for div, name in ((1_000_000, "million"), (1000, "thousand")):
        if n >= div:
            rest = n % div
            tail = "" if rest == 0 else (" and " if rest < 100 else " ") + words(rest)
            return words(n // div) + " " + name + tail
    raise ValueError(n)


def spoken(s: str) -> str:
    s = s.replace("\u2013", "-").replace("\u2014", ", ")
    num = r"(\d[\d,]*)"
    rng = r"\{(\d+)-(\d+)\}"
    s = re.sub(r"-" + rng + r"°C", lambda m: f"{m[1]} to {m[2]} degrees below zero", s)
    s = re.sub(r"\+?" + rng + r"°C", lambda m: f"{m[1]} to {m[2]} degrees Celsius", s)
    s = re.sub(r"-" + num + r"°C", lambda m: f"{m[1]} degrees below zero", s)
    s = re.sub(r"\+?" + num + r"°C", lambda m: f"{m[1]} degrees Celsius", s)
    s = re.sub(rng + r"%", lambda m: f"{m[1]} to {m[2]} per cent", s)
    s = re.sub(num + r"%", lambda m: f"{m[1]} per cent", s)
    s = re.sub(rng, lambda m: f"{m[1]} to {m[2]}", s)
    s = re.sub(r"\b1\.5 years\b", "eighteen months", s)
    s = re.sub(r"\b(\d+)-(\d+) (years?|months?)\b", r"\1 to \2 \3", s)
    s = re.sub(r"\bUV\b", "ultraviolet", s)
    s = re.sub(r"\bA\.?I\.?\b", "AI", s)
    s = re.sub(r"(\d+)\.5\b", lambda m: f"{m[1]} and a half", s)
    s = re.sub(num, lambda m: words(int(m[1].replace(",", ""))), s)
    s = re.sub(r"\s*\(([^)]*)\)", r". \1", s)
    s = s.replace(";", ".").replace(" m²", " square metres")
    return re.sub(r"\. ([a-z])", lambda m: ". " + m[1].upper(), s)


def auto_script(card: dict) -> str:
    parts = [f"{card['title']}. [1.0]"]
    sentences = re.split(r"(?<=[.!?])\s+", card["text"].strip())
    parts += [spoken(x) + " [0.4]" for x in sentences]
    parts[-1] = parts[-1].replace("[0.4]", "[0.8]")
    labels = {"Surface:": "On the surface:", "Threats:": "The threats:"}
    for d in card["details"]:
        line = spoken(d)
        for k, v in labels.items():
            if line.startswith(k):
                line = v + line[len(k):]
        parts.append(line.rstrip(".") + ". [0.4]")
    parts[-1] = parts[-1].replace(" [0.4]", "")
    if len(parts) >= 2:
        parts[-2] = parts[-2].replace("[0.4]", "[0.6]")
    return "\n".join(parts)


# ---------------------------------------------------------------------------------------------
def slugify(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")


def fingerprint(card: dict) -> str:
    raw = json.dumps([card["title"], card["text"], card["details"]], separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def parse_script(script: str) -> list[tuple[str, float]]:
    """-> [(text, pause_after_seconds)]"""
    bits = re.split(r"\s*\[(\d+(?:\.\d+)?)\]\s*", script.strip())
    out = []
    for i in range(0, len(bits), 2):
        text = " ".join(bits[i].split())
        pause = float(bits[i + 1]) if i + 1 < len(bits) else 0.0
        if text:
            out.append((text, pause))
        elif out:
            out[-1] = (out[-1][0], out[-1][1] + pause)
    return out


def plain_script(script: str) -> str:
    return " ".join(t for t, _ in parse_script(script))


def extract_cards() -> list[dict]:
    res = subprocess.run(["node", str(HERE / "extract.mjs"), str(CONTENT)], capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"extract.mjs failed:\n{res.stderr}")
    return json.loads(res.stdout)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def ensure_models() -> None:
    """Download the model files if they are missing, and check their sha256 after a download."""
    for path, url in MODEL_URLS.items():
        if path.exists():
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_name(path.name + ".part")
        print(f"downloading {url}")
        subprocess.run(["curl", "-fSL", "--retry", "3", "-o", str(part), url], check=True)
        got = sha256(part)
        if got != MODEL_SHA256[path]:
            part.unlink()
            sys.exit(f"{path.name}: sha256 {got} does not match the expected {MODEL_SHA256[path]}.\n"
                     "Upstream may have changed the file; see tools/voice/README.md.")
        part.rename(path)


def trim_edges(a: np.ndarray, sr: int, rel_db: float = -42.0, keep: float = 0.04) -> np.ndarray:
    """Drop leading/trailing silence quieter than rel_db below the piece's loudest 10 ms."""
    if a.size == 0:
        return a
    win = int(sr * 0.01)
    n = len(a) // win
    if n == 0:
        return a
    rms = 20 * np.log10(np.sqrt(np.mean(a[: n * win].reshape(n, win) ** 2, axis=1) + 1e-12))
    loud = np.where(rms > rms.max() + rel_db)[0]
    if loud.size == 0:
        return a
    start = max(0, loud[0] * win - int(keep * sr))
    end = min(len(a), (loud[-1] + 1) * win + int(keep * sr))
    return a[start:end]


class Narrator:
    """Kokoro via onnxruntime. Segments between pause markers are phonemised separately, joined into
    passages of up to MAX_TOKENS, synthesised in one call each (natural cross-sentence prosody, no
    short-utterance artefacts), then cut at the token durations of each segment's final punctuation;
    the model's own pause there is trimmed and replaced with exactly the scripted silence."""

    def __init__(self) -> None:
        import onnxruntime as ort
        from kokoro_onnx.tokenizer import Tokenizer

        self.tok = Tokenizer()
        self.voices = np.load(VOICES)
        self.sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])

    def phonemes(self, text: str) -> str:
        ph = self.tok.phonemize(text, LANG)
        for bad, good in PHONEME_FIXES:
            ph = ph.replace(bad, good)
        return ph

    def _synth(self, tokens: list[int], voice: str, speed: float) -> tuple[np.ndarray, np.ndarray]:
        style = self.voices[voice][len(tokens)]
        wav, dur = self.sess.run(None, {
            "input_ids": np.array([[0, *tokens, 0]], dtype=np.int64),
            "style": np.asarray(style, dtype=np.float32),
            "speed": np.array([speed], dtype=np.float32),
        })
        frames = np.round(dur[0]).astype(int)
        return wav[0].astype(np.float32), np.cumsum(frames) * FRAME  # end sample of each token (pad first)

    def render(self, script: str, voice: str, speed: float) -> tuple[np.ndarray, int]:
        segs = [(self.phonemes(t), p) for t, p in parse_script(script)]
        passages, cur = [], []
        for ph, pause in segs:
            n = len(self.tok.tokenize(ph))
            if cur and sum(len(self.tok.tokenize(x)) + 1 for x, _ in cur) + n > MAX_TOKENS:
                passages.append(cur)
                cur = []
            cur.append((ph, pause))
            if pause >= CHUNK_AT_PAUSE and sum(len(self.tok.tokenize(x)) for x, _ in cur) >= MIN_PASSAGE:
                passages.append(cur)
                cur = []
        if cur:
            passages.append(cur)

        out = []
        for passage in passages:
            tokens, ends = [], []
            for i, (ph, _) in enumerate(passage):
                if i:
                    tokens += self.tok.tokenize(" ")
                tokens += self.tok.tokenize(ph)
                ends.append(len(tokens))  # tokens[ends-1] is the segment's last symbol
            wav, tok_end = self._synth(tokens, voice, speed)
            start = 0
            for i, (ph, pause) in enumerate(passage):
                if i == len(passage) - 1:
                    cut = len(wav)
                else:
                    # the segment's final punctuation token spans [lo, hi) samples (+1 for the pad token)
                    lo, hi = tok_end[ends[i] - 1], tok_end[ends[i]]
                    cut = quietest_point(wav, lo - FRAME, hi + FRAME)
                piece = trim_edges(wav[start:cut], SR, rel_db=-42.0)
                out.append(fade(piece, SR))
                out.append(np.zeros(int(round(pause * SR)), dtype=np.float32))
                start = cut
        return np.concatenate(out), SR


def quietest_point(a: np.ndarray, lo: int, hi: int, win: int = 120) -> int:
    lo, hi = max(0, lo), min(len(a), hi)
    if hi - lo <= win:
        return (lo + hi) // 2
    e = np.convolve(a[lo:hi] ** 2, np.ones(win), mode="valid")
    return lo + int(np.argmin(e)) + win // 2


def fade(a: np.ndarray, sr: int, ms: float = 12.0) -> np.ndarray:
    n = min(len(a) // 2, int(sr * ms / 1000))
    if n > 0:
        a = a.copy()
        ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
        a[:n] *= ramp
        a[-n:] *= ramp[::-1]
    return a


def run_fx(wav: Path, mp3: Path, cast: dict, title: str, dry: bool = False) -> str:
    cmd = ["bash", str(HERE / "fx.sh"), "--title", title]
    if dry:
        cmd.append("--dry")
    else:
        cmd += ["--pitch", str(cast.get("pitch", 1.0))]
        if cast.get("wet") is not None:
            cmd += ["--wet-db", str(cast["wet"])]
        if cast.get("drone") is not None:
            cmd += ["--drone-db", str(cast["drone"])]
    mp3.parent.mkdir(parents=True, exist_ok=True)
    res = subprocess.run(cmd + [str(wav), str(mp3)], capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"fx.sh failed for {mp3.name}:\n{res.stderr}")
    return res.stdout.strip()


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return round(float(out), 2)


def loudness(path: Path) -> tuple[float, float]:
    err = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    summary = err[err.rfind("Summary:"):]
    i = float(re.search(r"I:\s+(-?[\d.]+) LUFS", summary)[1])
    tp = float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", summary)[1])
    return i, tp


def voice_wav(narrator: Narrator, slug: str, script: str, voice: str, speed: float, force: bool) -> Path:
    key = hashlib.sha1(f"{script}|{voice}|{speed}|{PHONEME_FIXES}|{MODEL.stat().st_size}|v2".encode()).hexdigest()[:10]
    wav = WORK / f"{slug}.{voice}.{key}.wav"
    if force or not wav.exists():
        import soundfile as sf

        audio, sr = narrator.render(script, voice, speed)
        WORK.mkdir(parents=True, exist_ok=True)
        sf.write(wav, audio, sr, subtype="PCM_24")
    return wav


def fallback_cast(slug: str, title: str, used: dict) -> dict:
    eerie = re.search(r"plague|fever|virus|spore|visitor|cloud|mould|mold|alien", title, re.I)
    pool = ["bf_emma", "bf_isabella", "bf_alice", "bf_lily"] if eerie else ["bm_george", "bm_lewis", "bm_fable", "bm_daniel"]
    voice = min(pool, key=lambda v: used.get(v, 0))
    return dict(voice=voice, speed=0.9, pitch=1.0 if eerie else 0.955, why="(automatic casting: new card, not yet cast by hand)")


def load_narration(path: Path) -> dict[str, dict]:
    """The published narration.json as {lower-case title: entry} ({} if there is none yet)."""
    if not path.exists():
        return {}
    return {e["title"].strip().lower(): e for e in json.loads(path.read_text(encoding="utf-8"))}


def write_narration(path: Path, entries: list[dict]) -> None:
    # same layout as the file public/narrator.js has always been served (indent 1, UTF-8, no final newline)
    entries = sorted(entries, key=lambda e: e["title"])
    path.write_text(json.dumps(entries, indent=1, ensure_ascii=False), encoding="utf-8")


def publish(render: Path, slug: str, cat_dir: Path, old: dict | None) -> tuple[str, Path | None]:
    """Move a fresh render into cat_dir under a cache-safe name -> (file name, superseded file or None).

    Production caches /audio/* for 7 days, so audio that changed must never reuse a published name:
    a byte-identical render keeps the current name, anything else becomes <slug>-<sha1[:8]>.mp3."""
    data = render.read_bytes()
    current = cat_dir / Path(old["src"]).name if old else None
    if current is not None and current.exists() and current.read_bytes() == data:
        render.unlink()
        return current.name, None
    name = f"{slug}-{hashlib.sha1(data).hexdigest()[:8]}.mp3"
    shutil.move(str(render), str(cat_dir / name))
    superseded = current if current is not None and current.exists() and current.name != name else None
    return name, superseded


def script_for(card: dict) -> tuple[str, str, str]:
    """-> (script, 'hand' | 'auto', card fingerprint)"""
    slug, fp = slugify(card["title"]), fingerprint(card)
    if slug in SCRIPTS and SCRIPTS[slug][0] == fp:
        return SCRIPTS[slug][1].strip(), "hand", fp
    return auto_script(card), "auto", fp


def check(cards: list[dict], out: Path) -> int:
    """--check: compare the cards with the published clips without rendering anything. 1 = a rebuild is due."""
    published = load_narration(out / "narration.json")
    due = 0
    for card in cards:
        slug = slugify(card["title"])
        _, source, fp = script_for(card)
        entry = published.get(card["title"].strip().lower())
        clip = out / "catastrophes" / Path(entry["src"]).name if entry else None
        if clip is None or not clip.exists():
            state, due = "NO CLIP", due + 1
        elif source == "auto":
            state, due = "STALE (card text changed since its script was written)", due + 1
        else:
            state = f"ok ({clip.name})"
        cast = CASTING.get(slug, {}).get("voice", "(auto-cast)")
        print(f"{slug:20} {source:4} fp={fp} {cast:12} {state}")
    titles = {c["title"].strip().lower() for c in cards}
    for t, e in published.items():
        if t not in titles:
            print(f"ORPHAN: {e['title']} ({e['src']}) has no card in content.js; a full build removes it")
            due += 1
    print(f"\n{len(cards)} cards, {len(published)} published clips, {due} to rebuild or remove")
    return 1 if due else 0


def main() -> None:
    ap = argparse.ArgumentParser(description="Rebuild the catastrophe narration clips from server/content.js.")
    ap.add_argument("--only", help="comma-separated slugs to (re)build (default: every card)")
    ap.add_argument("--force", action="store_true", help="re-synthesise even if the WAV is cached in work/")
    ap.add_argument("--samples", action="store_true", help="also render the dry/FX and alternative-casting comparisons into work/samples/")
    ap.add_argument("--check", action="store_true", help="only report which clips are missing or stale; no model, no audio")
    ap.add_argument("--out", type=Path, default=OUT, help="directory served as /audio/ (default: public/audio)")
    args = ap.parse_args()

    out = args.out.resolve()
    cat_dir = out / "catastrophes"
    narration_path = out / "narration.json"
    cards = extract_cards()
    if args.check:
        sys.exit(check(cards, out))

    only = set(args.only.split(",")) if args.only else None
    if only:
        unknown = only - {slugify(c["title"]) for c in cards}
        if unknown:
            sys.exit(f"--only: no such card: {', '.join(sorted(unknown))}")
    ensure_models()
    narrator = Narrator()
    cat_dir.mkdir(parents=True, exist_ok=True)
    render_dir = WORK / "render"
    render_dir.mkdir(parents=True, exist_ok=True)

    used: dict[str, int] = {}
    for c in CASTING.values():
        used[c["voice"]] = used.get(c["voice"], 0) + 1

    published = load_narration(narration_path)
    build_path = WORK / "manifest.json"
    build_old = {m["slug"]: m for m in json.loads(build_path.read_text(encoding="utf-8"))} if build_path.exists() else {}
    narration, build, superseded, warnings = [], [], [], []
    for card in cards:
        title = card["title"]
        slug = slugify(title)
        script, source, fp = script_for(card)
        if source == "auto":
            warnings.append(f"{slug}: card text changed or new (fp {fp}); using automatic script - review it")
        cast = CASTING.get(slug)
        if cast is None:
            cast = fallback_cast(slug, title, used)
            used[cast["voice"]] = used.get(cast["voice"], 0) + 1
            warnings.append(f"{slug}: not in CASTING; auto-cast {cast['voice']}")
        old = published.get(title.strip().lower())
        if only is not None and slug not in only:
            # not rebuilt this time: keep what is published, if it is still there
            if old and (cat_dir / Path(old["src"]).name).exists():
                narration.append(old)
                if slug in build_old:
                    build.append(build_old[slug])
            continue
        wav = voice_wav(narrator, slug, script, cast["voice"], cast["speed"], args.force)
        render = render_dir / f"{slug}.mp3"
        print(run_fx(wav, render, cast, title))
        i, tp = loudness(render)
        dur = duration(render)
        size = render.stat().st_size
        name, gone = publish(render, slug, cat_dir, old)
        if gone is not None:
            superseded.append(gone)
            print(f"  {slug}: new audio -> {name} (replaces {gone.name})")
        narration.append(dict(title=title, src=f"audio/catastrophes/{name}", voice=cast["voice"], durationSec=dur))
        build.append(dict(
            title=title, slug=slug, file=name, voice=cast["voice"], speed=cast["speed"],
            gender="female" if cast["voice"].startswith("bf_") else "male", durationSec=dur, script=plain_script(script),
            pitch=cast.get("pitch", 1.0), scriptSource=source, cardFingerprint=fp, casting=cast["why"],
            loudnessLUFS=i, truePeakDBTP=tp, bytes=size,
        ))
        if not 20 <= dur <= 42:
            warnings.append(f"{slug}: duration {dur}s outside 20-40 s")
        if tp > -1.1 or abs(i - TARGET_LUFS) > 0.5:
            warnings.append(f"{slug}: loudness {i} LUFS / {tp} dBTP out of spec")

    write_narration(narration_path, narration)
    build.sort(key=lambda m: m["title"])
    build_path.write_text(json.dumps(build, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # only after narration.json points at the new names: drop superseded clips, and on a full build
    # every clip no card uses any more
    for f in superseded:
        f.unlink(missing_ok=True)
    if only is None:
        keep = {Path(e["src"]).name for e in narration}
        for f in cat_dir.glob("*.mp3"):
            if f.name not in keep:
                f.unlink()
                warnings.append(f"removed {f.name}: no card uses it any more")

    if args.samples:
        samples = WORK / "samples"
        samples.mkdir(parents=True, exist_ok=True)
        by_slug = {slugify(c["title"]): c for c in cards}
        files = {slugify(e["title"]): cat_dir / Path(e["src"]).name for e in narration}
        for slug in DRY_SAMPLES:
            if slug not in by_slug or slug not in CASTING or (only and slug not in only):
                continue
            cast = CASTING[slug]
            wav = voice_wav(narrator, slug, script_for(by_slug[slug])[0], cast["voice"], cast["speed"], False)
            print(run_fx(wav, samples / f"{slug}.dry.mp3", cast, by_slug[slug]["title"], dry=True))
            shutil.copyfile(files[slug], samples / f"{slug}.fx.mp3")
        for slug, cast in ALTERNATIVES:
            if slug not in by_slug or (only and slug not in only):
                continue
            wav = voice_wav(narrator, slug, script_for(by_slug[slug])[0], cast["voice"], cast["speed"], False)
            print(run_fx(wav, samples / f"{slug}.alt-{cast['voice']}.mp3", cast, by_slug[slug]["title"]))

    counts: dict[str, int] = {}
    for e in narration:
        counts[e["voice"]] = counts.get(e["voice"], 0) + 1
    print(f"\n{len(narration)} clips in {narration_path}; voices: {counts}")
    if narration:
        print(f"durations: {min(e['durationSec'] for e in narration)}-{max(e['durationSec'] for e in narration)} s")
    for w in warnings:
        print("WARNING:", w)


if __name__ == "__main__":
    main()
