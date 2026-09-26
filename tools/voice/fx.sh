#!/usr/bin/env bash
# fx.sh - cinematic "bunker broadcast" treatment for one narration clip, ffmpeg only.
#
#   fx.sh [options] <in.wav> <out.mp3>
#
# Chain (fx mode):
#   voice : resample 44.1k mono -> optional pitch-down (rubberband, formants preserved)
#           -> high-pass 70 Hz -> low-mid warmth (+2.5 dB @ 200 Hz) -> de-box (-1.5 dB @ 480 Hz)
#           -> presence (+1.5 dB @ 3.2 kHz) -> soft top (-2 dB shelf @ 9 kHz)
#           -> gentle compressor (2.5:1) -> 0.6 s pre-roll + tail padding
#   room  : convolution with a synthesised 0.7 s concrete-room impulse (decaying noise, 12 ms
#           pre-delay, band-limited 300 Hz-5.5 kHz so it never muddies the lows), mixed well under
#           the dry voice (~12.5 LU under it by default; eerie stories get more)
#   bed   : brown noise, low-passed at 120 Hz (12 dB/oct), high-passed at 28 Hz, 0.12 Hz tremolo,
#           faded in/out, sidechain-ducked ~7 dB by the voice; ~20 LU under the voice in pauses
#   master: fade-out tail -> gain to target + 4x-oversampled limiter (ceiling -2.6 dBFS) ->
#           two-pass EBU R128 loudnorm (target $VOICE_LUFS, default -12 LUFS, linear mode) ->
#           MP3 mono 96 kbps 44.1 kHz, then the MP3 itself is measured and the master redone until
#           it reads target +/- 0.3 LUFS and <= -1.2 dBTP (encoder loss/overshoot compensated)
# --dry skips pitch/EQ/room/bed and only pads, normalises and encodes (for A/B comparison).
# Needs ffmpeg + ffprobe with libmp3lame, plus librubberband for any --pitch other than 1.0.
# Called by make_voice.py; see tools/voice/README.md.
set -euo pipefail

PITCH=1.0      # pitch ratio, e.g. 0.955 = about -0.8 semitone (4.5 % down)
WET_DB=-11     # reverb send gain, dB (lands the room ~12.5 LU under the dry voice)
DRONE_DB=-14   # rumble bed gain, dB (bed ~20 LU under the voice, ~27 LU while ducked)
PRE=0.6        # silence before the voice starts, s
TAIL=1.9       # time after the voice ends (reverb tail + bed fade), s
MODE=fx
TITLE=""
ARTIST="Bunker Online narrator"
TARGET_I=${VOICE_LUFS:--12}
TARGET_TP=-1.5

usage() { sed -n 2,22p "$0"; exit 1; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pitch) PITCH="$2"; shift 2 ;;
    --wet-db) WET_DB="$2"; shift 2 ;;
    --drone-db) DRONE_DB="$2"; shift 2 ;;
    --pre) PRE="$2"; shift 2 ;;
    --tail) TAIL="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --artist) ARTIST="$2"; shift 2 ;;
    --dry) MODE=dry; shift ;;
    -h|--help) usage ;;
    --) shift; break ;;
    -*) echo "fx.sh: unknown option $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[[ $# -eq 2 ]] || usage
IN="$1"; OUT="$2"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fx.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")
if [[ $MODE == dry ]]; then TAIL=0.8; fi
TOTAL=$(awk -v a="$PRE" -v b="$DUR" -v c="$TAIL" 'BEGIN{printf "%.3f", a+b+c}')
FADE_ST=$(awk -v t="$TOTAL" 'BEGIN{printf "%.3f", t-1.6}')
PRE_MS=$(awk -v p="$PRE" 'BEGIN{printf "%d", p*1000}')

if [[ $MODE == dry ]]; then
  GRAPH="[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,adelay=${PRE_MS}:all=1,apad=whole_dur=${TOTAL},atrim=0:${TOTAL}[out]"
else
  if awk -v p="$PITCH" 'BEGIN{exit !(p<0.999 || p>1.001)}'; then
    SHIFT="rubberband=pitch=${PITCH}:formant=preserved:pitchq=quality:transients=mixed:detector=compound,"
  else
    SHIFT=""
  fi
  WET_LIN=$(awk -v d="$WET_DB" 'BEGIN{printf "%.5f", 10^(d/20)}')
  GRAPH="
[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=mono,${SHIFT}
  highpass=f=70,
  equalizer=f=200:t=q:w=0.9:g=2.5,
  equalizer=f=480:t=q:w=1.4:g=-1.5,
  equalizer=f=3200:t=q:w=1.2:g=1.5,
  treble=g=-2:f=9000:t=s,
  acompressor=threshold=-22dB:ratio=2.5:attack=8:release=180:makeup=2:knee=4,
  adelay=${PRE_MS}:all=1,apad=whole_dur=${TOTAL},atrim=0:${TOTAL},
  asplit=3[dry][send][key];
aevalsrc=exprs='(2*random(0)-1)*exp(-t*6.9/0.7)*gte(t,0.012)':s=44100:d=0.75,
  highpass=f=300,lowpass=f=5500[ir];
[send][ir]afir=dry=1:wet=1:irnorm=2,highpass=f=250,lowpass=f=6000,volume=${WET_LIN}[wet];
[dry][wet]amix=inputs=2:normalize=0[voice];
anoisesrc=color=brown:amplitude=1:r=44100:d=${TOTAL}:seed=1983,
  lowpass=f=120,highpass=f=28,
  tremolo=f=0.12:d=0.5,
  volume=${DRONE_DB}dB,
  afade=t=in:st=0:d=1.4,afade=t=out:st=${FADE_ST}:d=1.6[bed];
[bed][key]sidechaincompress=threshold=0.03:ratio=3:attack=80:release=1200:knee=4[ducked];
[voice][ducked]amix=inputs=2:normalize=0,afade=t=out:st=${FADE_ST}:d=1.6,atrim=0:${TOTAL}[out]"
fi

# Stage 1: render the mix at 32-bit float.
ffmpeg -nostdin -hide_banner -loglevel error -y -i "$IN" -filter_complex "$GRAPH" -map '[out]' \
  -c:a pcm_f32le "$TMP/mix.wav"

# Stages 2-4, run as a loop on the actual deliverable. MP3 encoding at 96 kbps costs ~0.3 LU and adds
# up to ~1 dB of true peak on sibilant voices, so the result is decoded and measured; if it misses
# the target by more than 0.3 LU or exceeds -1.2 dBTP, the loudness target / limiter ceiling are
# corrected and the master is redone (at most 4 rounds).
#   2: bring the mix to the target loudness and catch consonant peaks with a 4x-oversampled limiter
#      (speech has a ~15 dB peak-to-loudness ratio, which would otherwise force loudnorm out of
#      linear mode);
#   3: loudnorm pass 1 (measure);  4: loudnorm pass 2 (linear), resample to 44.1 kHz, encode MP3.
measure() {  # $1 = file, $2 = loudnorm I target; sets M to loudnorm's JSON block
  ffmpeg -nostdin -hide_banner -y -i "$1" \
    -af "loudnorm=I=$2:TP=${TARGET_TP}:LRA=20:print_format=json" -f null - 2>"$TMP/measure.log"
  M=$(sed -n '/^{/,/^}/p' "$TMP/measure.log")
}
get() { printf '%s' "$M" | sed -n "s/.*\"$1\" : \"\\([^\"]*\\)\".*/\\1/p"; }
final_stats() {  # $1 = file; sets FI (integrated LUFS) and FTP (true peak dBTP)
  local log
  log=$(ffmpeg -nostdin -hide_banner -i "$1" -af ebur128=peak=true -f null - 2>&1 | sed -n '/Summary:/,$p')
  FI=$(printf '%s' "$log" | sed -n 's/^ *I: *\(-*[0-9.]*\) LUFS.*/\1/p' | tail -1)
  FTP=$(printf '%s' "$log" | sed -n 's/^ *Peak: *\(-*[0-9.]*\) dBFS.*/\1/p' | tail -1)
}
META=(-metadata "artist=$ARTIST")
[[ -n $TITLE ]] && META+=(-metadata "title=$TITLE")

I_GOAL=$TARGET_I   # loudnorm target, nudged to compensate the encoder
CEIL=-2.6          # limiter ceiling, dBFS (4x oversampled)
for ROUND in 1 2 3 4; do
  measure "$TMP/mix.wav" "$I_GOAL"
  GAIN=$(awk -v t="$I_GOAL" -v i="$(get input_i)" 'BEGIN{printf "%.3f", t-i}')
  LIM=$(awk -v c="$CEIL" 'BEGIN{printf "%.5f", 10^(c/20)}')
  for _ in 1 2 3; do  # limiting lowers loudness a little; re-aim the pre-gain until it lands on I_GOAL
    ffmpeg -nostdin -hide_banner -loglevel error -y -i "$TMP/mix.wav" \
      -af "volume=${GAIN}dB,aresample=176400,alimiter=limit=${LIM}:attack=1:release=80:level=0:latency=1,aresample=44100" \
      -c:a pcm_f32le "$TMP/lim.wav"
    measure "$TMP/lim.wav" "$I_GOAL"
    MI=$(get input_i)
    awk -v i="$MI" -v t="$I_GOAL" 'BEGIN{d=i-t; exit !((d<0?-d:d)<=0.1)}' && break
    GAIN=$(awk -v g="$GAIN" -v t="$I_GOAL" -v i="$MI" 'BEGIN{printf "%.3f", g+(t-i)}')
  done
  MTP=$(get input_tp); MLRA=$(get input_lra); MTH=$(get input_thresh); OFF=$(get target_offset)
  # TP ceiling for loudnorm = what the (tiny) linear gain will produce, so it always stays linear
  LN_TP=$(awk -v p="$MTP" -v t="$I_GOAL" -v i="$MI" 'BEGIN{x=p+(t-i)+0.2; if(x>-0.5)x=-0.5; printf "%.2f", x}')
  ffmpeg -nostdin -hide_banner -y -i "$TMP/lim.wav" \
    -af "loudnorm=I=${I_GOAL}:TP=${LN_TP}:LRA=20:measured_I=${MI}:measured_TP=${MTP}:measured_LRA=${MLRA}:measured_thresh=${MTH}:offset=${OFF}:linear=true:print_format=json,aresample=44100" \
    -ac 1 -ar 44100 -c:a libmp3lame -b:a 96k -id3v2_version 3 "${META[@]}" "$OUT" 2>"$TMP/pass2.log"
  NT=$(sed -n 's/.*"normalization_type" : "\([^"]*\)".*/\1/p' "$TMP/pass2.log")
  final_stats "$OUT"
  if awk -v i="$FI" -v p="$FTP" -v t="$TARGET_I" 'BEGIN{d=i-t; exit !((d<0?-d:d)<=0.3 && p<=-1.2)}'; then break; fi
  I_GOAL=$(awk -v g="$I_GOAL" -v i="$FI" -v t="$TARGET_I" 'BEGIN{printf "%.2f", g+(t-i)}')
  CEIL=$(awk -v c="$CEIL" -v p="$FTP" -v i="$FI" -v t="$TARGET_I" 'BEGIN{x=c; if(p>-1.2) x-=(p+1.2)+0.3; printf "%.2f", x}')
done
echo "fx.sh: $(basename "$OUT") mode=$MODE pitch=$PITCH rounds=$ROUND norm=$NT ceiling=${CEIL}dBFS final_I=${FI}LUFS final_TP=${FTP}dBTP"
