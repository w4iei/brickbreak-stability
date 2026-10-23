#!/usr/bin/env python3
"""The loudness envelope of every version of each site track (the original and each emotion), for the site's Listen
tab. Made from the files export.py wrote, put together the way the player plays them (chunks on their grids, linear
crossfades), so each line is what that version sounds like from start to end. Run after export.py:

    uv run --project server python site/envelopes.py      # from the repo root (needs ffmpeg)
Writes site/public/audio/envelopes/<slug>.json:
    {"rate": bins per s, "bins": n, "versions": {"orig" | brick id: {"peak": b64, "rms": b64}}}
Each value is one byte: (dBFS + 60) × 4, so 0 = −60 dB or quieter, 240 = 0 dB.
"""
from __future__ import annotations

import base64
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
AUDIO = HERE / "public" / "audio"
OUT = AUDIO / "envelopes"
SR = 44100
RATE = 10  # bins per s
DRY_HOP, DRY_LENGTH = 8, 8.5  # s: the original's chunks (player.ts DRY)
CHUNK_BARS, CHUNK_OVERLAP = 4, 0.5  # renders: 4 bars from the first downbeat, 0.5 s past the next (player.ts)
FLOOR = -60.0


def decode(path: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-f", "f32le", "-ac", "2",
                          "-ar", str(SR), "pipe:1"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2)


def place(out: np.ndarray, x: np.ndarray, start: float, fade_in: float, hold_until: float) -> None:
    """Add chunk x at `start` s: in over fade_in, 1 until hold_until, then linearly out to its own end (player.ts)."""
    i0 = round(start * SR)
    n = min(len(x), len(out) - i0)
    if n <= 0:
        return
    t = start + np.arange(n) / SR
    end = start + len(x) / SR
    g = np.ones(n, dtype=np.float32)
    if fade_in > 0:
        g = np.minimum(g, (t - start) / fade_in)
    if hold_until < end:
        g = np.minimum(g, np.clip((end - t) / (end - hold_until), 0, 1))
    out[i0:i0 + n] += x[:n] * g[:, None]


def envelope(y: np.ndarray) -> dict[str, str]:
    step = SR // RATE
    bins = -(-len(y) // step)
    pad = np.zeros((bins * step, 2), dtype=np.float32)
    pad[: len(y)] = y
    frames = pad.reshape(bins, step, 2)
    peak = np.abs(frames).max(axis=(1, 2))
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=(1, 2)))

    def code(v: np.ndarray) -> str:
        db = 20 * np.log10(np.maximum(v, 1e-9))
        return base64.b64encode(np.clip(np.round((db - FLOOR) * 4), 0, 255).astype(np.uint8).tobytes()).decode()

    return {"peak": code(peak), "rms": code(rms)}


def main() -> None:
    manifest = json.loads((AUDIO / "manifest.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    for t in manifest["tracks"]:
        folder = AUDIO / "renders" / t["slug"]
        total = t["frames"]
        bars = t["downbeats"]
        bar = (bars[-1] - bars[0]) / (len(bars) - 1)
        origin, hop = bars[0], CHUNK_BARS * bar
        bricks = sorted({int(f.stem.split("-")[0]) for f in folder.glob("*.m4a") if not f.name.startswith("orig-")})
        versions: dict[str, dict[str, str]] = {}

        y = np.zeros((total, 2), dtype=np.float32)
        ks = sorted(int(f.stem.split("-")[1]) for f in folder.glob("orig-*.m4a"))
        with ThreadPoolExecutor(8) as pool:
            chunks = list(pool.map(lambda k: decode(folder / f"orig-{k}.m4a"), ks))
        for k, x in zip(ks, chunks):
            place(y, x, k * DRY_HOP, DRY_LENGTH - DRY_HOP if k else 0, (k + 1) * DRY_HOP)
        versions["orig"] = envelope(y)

        for b in bricks:
            y = np.zeros((total, 2), dtype=np.float32)
            ks = sorted(int(f.stem.split("-")[1]) for f in folder.glob(f"{b}-*.m4a"))
            with ThreadPoolExecutor(8) as pool:
                chunks = list(pool.map(lambda k: decode(folder / f"{b}-{k}.m4a"), ks))
            for k, x in zip(ks, chunks):
                start = origin + k * hop
                place(y, x, start, CHUNK_OVERLAP if k else 0, start + hop)
            versions[str(b)] = envelope(y)
            print(f"{t['title']}: brick {b}, {len(ks)} chunks", flush=True)

        bins = -(-total // (SR // RATE))
        (OUT / f"{t['slug']}.json").write_text(json.dumps({"rate": RATE, "bins": bins, "versions": versions}))
        print(f"{t['title']}: {len(versions)} versions, {bins} bins", flush=True)


if __name__ == "__main__":
    main()
