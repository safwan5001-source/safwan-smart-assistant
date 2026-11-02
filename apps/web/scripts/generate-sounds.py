#!/usr/bin/env python3
"""
Generate the four original notification sounds for مساعد صفوان الذكي.

Pure synthesis (additive / modal / FM-style tones with numpy). No samples and
no downloaded audio are used, so every output is original work.

Pipeline per sound:
  1. synthesize float64 mono signal at 44.1 kHz
  2. apply fades, trim silence, normalise to a shared loudness target
  3. write a temporary 16-bit PCM WAV
  4. encode MP3 with ffmpeg (libmp3lame, mono, CBR 64 kbps)
  5. write apps/web/public/sounds/manifest.json

Usage:  python3 apps/web/scripts/generate-sounds.py
Deterministic: fixed RNG seed, no time-dependent input.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

SR = 44100
SEED = 20260211
RNG = np.random.default_rng(SEED)

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE.parent / "public" / "sounds"

# Loudness targets (integrated LUFS). Measured later with ebur128 in the report.
TARGET_LUFS = {
    "notification-soft": -17.0,
    "reminder-bell": -16.5,
    "critical-alert": -15.5,   # about 1.5 dB louder than the base level
    "success-tone": -18.5,     # about 1.5 dB quieter
}
LUFS_RMS_OFFSET_DB = 0.0        # calibrated: K-weighted LUFS vs. plain RMS dB
TRUE_PEAK_CEILING_DB = -1.2     # headroom under -1 dBFS for MP3 overshoot
MP3_BITRATE = "64k"


# --------------------------------------------------------------------------- #
# Primitives
# --------------------------------------------------------------------------- #

def t_axis(duration: float) -> np.ndarray:
    return np.arange(int(round(duration * SR))) / SR


def place(buf: np.ndarray, sig: np.ndarray, start_s: float) -> None:
    """Add sig into buf starting at start_s (seconds), clipped to buffer."""
    start = int(round(start_s * SR))
    if start >= len(buf):
        return
    n = min(len(sig), len(buf) - start)
    buf[start:start + n] += sig[:n]


def attack_release(n: int, attack_s: float, decay_tau_s: float) -> np.ndarray:
    """Soft attack ramp then exponential decay (tau in seconds)."""
    t = np.arange(n) / SR
    a = max(1, int(attack_s * SR))
    env = np.exp(-t / max(decay_tau_s, 1e-4))
    ramp = np.minimum(1.0, np.arange(n) / a)
    # raised-cosine attack for a click-free onset
    ramp = 0.5 - 0.5 * np.cos(np.pi * ramp)
    return env * ramp


def sine_tone(freq: float, n: int, phase: float = 0.0) -> np.ndarray:
    t = np.arange(n) / SR
    return np.sin(2 * np.pi * freq * t + phase)


def bell_partial_tone(f0: float, duration: float, partials, decay_base: float,
                      attack_s: float = 0.002) -> np.ndarray:
    """Modal bell/glockenspiel strike: inharmonic partials, each with its own decay.

    partials: list of (ratio, amplitude, decay_multiplier)
    decay_base: seconds for the fundamental to fall to 1/e.
    """
    n = int(round(duration * SR))
    out = np.zeros(n)
    t = np.arange(n) / SR
    for ratio, amp, dmul in partials:
        tau = decay_base * dmul
        env = np.exp(-t / tau)
        out += amp * env * np.sin(2 * np.pi * f0 * ratio * t)
    # short hammer transient: quick, band-limited noise burst, very low level
    burst_n = int(0.004 * SR)
    noise = RNG.standard_normal(burst_n) * np.exp(-np.arange(burst_n) / (0.0008 * SR))
    out[:burst_n] += 0.08 * noise
    a = max(1, int(attack_s * SR))
    out[:a] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    return out


def fm_pluck(freq: float, n: int, index: float, ratio: float,
             decay_s: float, attack_s: float) -> np.ndarray:
    """Simple two-operator FM voice with decaying modulation index."""
    t = np.arange(n) / SR
    mod_env = np.exp(-t / (decay_s * 0.35))
    mod = np.sin(2 * np.pi * freq * ratio * t) * index * mod_env
    car = np.sin(2 * np.pi * freq * t + mod)
    env = attack_release(n, attack_s, decay_s)
    return car * env


def dc_block_and_fade(x: np.ndarray, fade_in_s: float, fade_out_s: float) -> np.ndarray:
    # remove DC drift from any asymmetric modal sums
    x = x - np.mean(x)
    fi = max(1, int(fade_in_s * SR))
    fo = max(1, int(fade_out_s * SR))
    fi = min(fi, len(x) // 2)
    fo = min(fo, len(x) // 2)
    x[:fi] *= np.linspace(0.0, 1.0, fi)
    x[-fo:] *= np.linspace(1.0, 0.0, fo)
    return x


def trim_edges(x: np.ndarray, threshold: float = 1e-3,
               lead_max_ms: float = 20.0, tail_max_ms: float = 80.0) -> np.ndarray:
    """Trim leading silence to <= lead_max_ms and trailing silence to <= tail_max_ms."""
    idx = np.where(np.abs(x) > threshold)[0]
    if len(idx) == 0:
        raise RuntimeError("silent signal")
    first, last = idx[0], idx[-1]
    lead_keep = int(lead_max_ms / 1000 * SR) // 4  # keep at most ~5 ms of pre-onset silence
    tail_keep = int(tail_max_ms / 1000 * SR)
    start = max(0, first - lead_keep)
    end = min(len(x), last + 1 + tail_keep)
    return x[start:end]


def measure_lufs_approx(x: np.ndarray) -> float:
    """Rough K-weighted-free RMS loudness estimate used only for the in-script
    gain staging. The authoritative numbers come from ffmpeg ebur128 afterwards."""
    rms = math.sqrt(np.mean(x ** 2) + 1e-12)
    return 20 * math.log10(rms + 1e-12) + LUFS_RMS_OFFSET_DB


def normalise_to(x: np.ndarray, target_lufs: float) -> np.ndarray:
    current = measure_lufs_approx(x)
    gain_db = target_lufs - current
    y = x * (10 ** (gain_db / 20))
    peak = np.max(np.abs(y))
    ceiling = 10 ** (TRUE_PEAK_CEILING_DB / 20)
    if peak > ceiling:
        y = y * (ceiling / peak)
    return y


# --------------------------------------------------------------------------- #
# Sound designs
# --------------------------------------------------------------------------- #

def make_notification_soft() -> np.ndarray:
    """Calm two-note rising chime: warm sine + soft bell partial mix."""
    total = 1.15
    buf = np.zeros(int(total * SR) + 1)
    f_a, f_b = 659.25, 830.61   # E5 -> G#5 (rising major third, gentle)

    def chime(f, dur, amp):
        n = int(dur * SR)
        t = np.arange(n) / SR
        tone = (0.70 * np.sin(2 * np.pi * f * t)
                + 0.22 * np.sin(2 * np.pi * 2.0 * f * t) * np.exp(-t / 0.12)
                + 0.08 * np.sin(2 * np.pi * 2.76 * f * t) * np.exp(-t / 0.05))
        env = attack_release(n, 0.008, dur / 4.2)
        return amp * tone * env

    place(buf, chime(f_a, 0.62, 0.9), 0.0)
    place(buf, chime(f_b, 0.82, 0.8), 0.20)
    return dc_block_and_fade(buf, 0.004, 0.06)


def make_reminder_bell() -> np.ndarray:
    """Three glockenspiel-like strikes with inharmonic partials, short gaps."""
    f0 = 1046.5  # C6
    # Inharmonic modal ratios typical of a struck bar/bell (approximate)
    partials = [
        (1.00, 1.00, 1.00),
        (2.76, 0.42, 0.45),
        (5.40, 0.16, 0.22),
        (8.93, 0.06, 0.12),
    ]
    strike = bell_partial_tone(f0, 1.2, partials, decay_base=0.42)
    second = bell_partial_tone(f0 * 1.1225, 1.1, partials, decay_base=0.42)  # up a whole tone (D6-ish)
    total = 2.25
    buf = np.zeros(int(total * SR) + 1)
    place(buf, strike * 0.85, 0.00)
    place(buf, second * 0.80, 0.42)
    place(buf, strike * 0.75, 0.84)
    return dc_block_and_fade(buf, 0.003, 0.08)


def make_critical_alert() -> np.ndarray:
    """Three alternating pulses between 680 Hz and 960 Hz (a fifth apart)."""
    f_lo, f_hi = 680.0, 1020.0   # 3:2 relationship (perfect fifth), mid band
    pulse_dur = 0.34
    gap = 0.12
    total = 1.45
    buf = np.zeros(int(total * SR) + 1)
    for i in range(3):
        f = f_lo if i % 2 == 0 else f_hi
        start = i * (pulse_dur + gap)
        n = int(pulse_dur * SR)
        t = np.arange(n) / SR
        # gentle 2nd partial to give body, low-level, no hard edges
        tone = np.sin(2 * np.pi * f * t) + 0.18 * np.sin(2 * np.pi * 2 * f * t)
        env = attack_release(n, 0.010, pulse_dur / 2.2)
        place(buf, 0.85 * tone * env, start)
    # soft third pulse tail echo for presence
    return dc_block_and_fade(buf, 0.004, 0.05)


def make_success_tone() -> np.ndarray:
    """Quick bright rising arpeggio C5-E5-G5-C6 with quick decay."""
    notes = [523.25, 659.25, 783.99, 1046.5]   # C5 E5 G5 C6
    step = 0.082
    total = 0.66
    buf = np.zeros(int(total * SR) + 1)
    for i, f in enumerate(notes):
        dur = 0.30 if i < 3 else 0.46
        n = int(dur * SR)
        t = np.arange(n) / SR
        tone = (np.sin(2 * np.pi * f * t)
                + 0.25 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / 0.05)
                + 0.10 * np.sin(2 * np.pi * 3 * f * t) * np.exp(-t / 0.03))
        env = attack_release(n, 0.004, dur / 3.6)
        place(buf, tone * env * (0.9 if i == 3 else 0.8), i * step)
    return dc_block_and_fade(buf, 0.003, 0.04)


SOUNDS = [
    ("notification-soft", make_notification_soft),
    ("reminder-bell", make_reminder_bell),
    ("critical-alert", make_critical_alert),
    ("success-tone", make_success_tone),
]


# --------------------------------------------------------------------------- #
# IO
# --------------------------------------------------------------------------- #

def write_wav(path: Path, x: np.ndarray) -> None:
    pcm = np.clip(np.round(x * 32767.0), -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def encode_mp3(wav: Path, mp3: Path) -> None:
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(wav),
        "-ac", "1", "-ar", str(SR),
        "-c:a", "libmp3lame", "-b:a", MP3_BITRATE,
        "-id3v2_version", "0",
        str(mp3),
    ]
    subprocess.run(cmd, check=True)


def probe_duration_ms(mp3: Path) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(mp3)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return int(round(float(out) * 1000))


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        print("ffmpeg/ffprobe are required", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []

    with tempfile.TemporaryDirectory(prefix="safwan-sounds-") as tmp:
        tmpdir = Path(tmp)
        for sound_id, maker in SOUNDS:
            x = maker()
            x = trim_edges(x)
            x = normalise_to(x, TARGET_LUFS[sound_id])
            # final guard: fades must survive trimming
            x = dc_block_and_fade(x, 0.003, 0.03)

            wav_path = tmpdir / f"{sound_id}.wav"
            mp3_path = OUT_DIR / f"{sound_id}.mp3"
            write_wav(wav_path, x)
            encode_mp3(wav_path, mp3_path)

            manifest.append({
                "id": sound_id,
                "file": f"/sounds/{sound_id}.mp3",
                "durationMs": probe_duration_ms(mp3_path),
                "bytes": mp3_path.stat().st_size,
                "sha256": sha256_of(mp3_path),
            })
            print(f"wrote {mp3_path.name}")

    manifest_path = OUT_DIR / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {manifest_path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
