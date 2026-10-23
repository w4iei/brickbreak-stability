#!/usr/bin/env python
"""What the game needs to know about a track: its beat grid (beats, bar lines, tempo) and what it sounds like (zero-shot
genre / instrument / ensemble / vocal tags, which the prompts use to keep the track's sound while changing its mood).

    uv run --project analysis python analysis/analyze.py tracks/*.wav [--device cpu|mps] [--no-cache]

Per track: beat_this beats fitted to a constant-tempo grid and aligned to the onsets, bar lines from where the music
changes (and beat_this's downbeat activations), and MuQ-MuLan tag scores on bar-aligned windows. Writes
analysis/out/<file stem>.json, which the server hands to the game. Expensive steps are cached in analysis/cache/<stem>/.

First run downloads OpenMuQ/MuQ-MuLan-large (+ xlm-roberta-base, ~3.7 GB, Hugging Face cache) and the beat_this final0
checkpoint (77 MB). A cold run takes a few minutes per track on a laptop CPU; a cached one seconds.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from ta import audio, beats as tb, features as tf, labels as tl  # noqa: E402

T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:7.1f}s]", *a, flush=True)


def r3(x):
    return round(float(x), 3)


def cached(path: Path, fn, use_cache: bool) -> dict:
    if use_cache and path.exists():
        return dict(np.load(path, allow_pickle=False))
    res = fn()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.stem}.part.npz")  # whole or not at all
    np.savez_compressed(tmp, **res)
    os.replace(tmp, path)
    return res


def analyze_track(path: Path, tag_text: np.ndarray, scale: float, get_mulan, args) -> dict:
    cdir = Path(args.cache) / path.stem
    use_cache = not args.no_cache
    log(f"== {path.name}")
    x, sr = audio.load(str(path))
    dur = len(x) / sr
    mono = audio.to_mono(x)

    # Beats: beat_this, then (when the tempo is steady, as in most dance music) a constant grid through them, shifted
    # onto the onsets.
    bt = cached(cdir / "beat_this.npz", lambda: tb.run_beat_this(x, sr, args.device), use_cache)
    raw_beats = bt["beats"]
    fit = tb.fit_constant_grid(raw_beats)
    if fit["steady"]:
        P, t0 = fit["period"], fit["t0"]
        coarse = tb.build_grid(t0, P, raw_beats[0], raw_beats[-1], dur)
        t0 = t0 + tb.onset_offset(mono, sr, coarse)["offset"]
        beats = tb.build_grid(t0, P, raw_beats[0], raw_beats[-1], dur)
    else:
        P, beats = float(np.median(np.diff(raw_beats))), raw_beats
    B = len(beats)
    starts, ends = beats, np.r_[beats[1:], min(beats[-1] + P, dur)]
    log(f"beats: {len(raw_beats)} raw -> {B}, {60 / P:.3f} BPM, steady={fit['steady']}")

    # Bar lines: the meter and phase at which the music's changes (timbre, loudness) and beat_this's downbeats line up.
    beat_db = audio.span_db(x, sr, starts, ends)
    gh = hashlib.md5(np.round(beats, 4).tobytes()).hexdigest()[:10]
    y22 = audio.resample(mono, sr, 22050)
    feats = cached(cdir / f"features_{gh}.npz", lambda: tf.beat_features(y22, 22050, starts, ends), use_cache)
    change = tf.beat_change_curve(feats, beat_db)
    fr = np.clip(np.round(beats * tb.FPS).astype(int), 1, len(bt["down_act"]) - 2)
    da = np.max(np.stack([bt["down_act"][fr + d] for d in (-1, 0, 1)]), axis=0)
    bp = tb.bar_phase(change, da)
    m, ph = bp["meter"], bp["phase"]
    downbeats = beats[(np.arange(B) - ph) % m == 0]
    log(f"meter {m}, phase {ph}")

    # Tags: MuQ-MuLan on windows of whole bars (about 4–8 s), one every bar.
    bar_sec = m * P
    nb = max(n for n in (1, 2, 4, 8) if n * bar_sec <= 8.0 or n == 1)
    if nb * bar_sec < 4.0 and 2 * nb * bar_sec <= 10.0:
        nb *= 2
    wlen = nb * bar_sec
    wst = downbeats[downbeats + wlen <= ends[-1] + 1e-6]

    def run_mulan():
        lat, acc, wacc = get_mulan().windows(audio.resample(mono, sr, tl.SR), wst, int(round(wlen * tl.SR)), dur)
        return {"lat": lat, "acc": acc, "wacc": wacc}

    lat = cached(cdir / f"mulan_{nb}b_{gh}_{ph}.npz", run_mulan, use_cache)["lat"]
    p_t = tl.softmax(scale * tl.smooth_rows(lat @ tag_text.T), axis=1)
    tags = [t for t, _ in tl.TAGS]
    cats = dict(tl.TAGS)
    return {
        "track": path.name, "duration": r3(dur), "sampleRate": sr,
        "tempo": round(60 / P, 3), "meter": m,
        "beats": [r3(b) for b in beats],
        "downbeats": [r3(b) for b in downbeats],
        "tagMatrix": {"tags": tags, "cats": [cats[t] for t in tags], "times": [r3(s) for s in wst],
                      "p": [[round(float(v), 4) for v in row] for row in p_t]},
        "model": {"labels": tl.MODEL_ID, "beats": "beat_this final0 (CPJKU)" + (" + constant-tempo grid" if fit["steady"] else "")},
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tracks", nargs="+")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--cache", default=str(HERE / "cache"))
    ap.add_argument("--device", default="cpu", help="torch device for beat_this and MuQ-MuLan (cpu keeps the GPU free)")
    ap.add_argument("--no-cache", action="store_true")
    args = ap.parse_args()
    for t in args.tracks:
        if not Path(t).exists():
            raise FileNotFoundError(t)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    state = {}

    def get_mulan():
        if "m" not in state:
            log(f"loading {tl.MODEL_ID} on {args.device}")
            state["m"] = tl.MuLan(args.device)
        return state["m"]

    queries = [t for t, _ in tl.TAGS]
    th = hashlib.md5(json.dumps(queries).encode()).hexdigest()[:10]
    text = cached(Path(args.cache) / f"text_tags_{th}.npz",
                  lambda: {"tag": get_mulan().text(queries), "scale": np.array(get_mulan().logit_scale)}, not args.no_cache)
    for t in args.tracks:
        doc = analyze_track(Path(t), text["tag"], float(text["scale"]), get_mulan, args)
        (out / f"{Path(t).stem}.json").write_text(json.dumps(doc))
        log(f"wrote {out / (Path(t).stem + '.json')}")


if __name__ == "__main__":
    main()
