"""Beat tracking (CPJKU beat_this), constant-tempo grid fit, onset alignment and bar phase."""
from __future__ import annotations

import numpy as np
from scipy.signal import find_peaks

FPS = 50  # beat_this frame rate


def run_beat_this(x: np.ndarray, sr: int, device: str = "cpu") -> dict:
    """Frame activations + minimal-postprocessed beats/downbeats from beat_this 'final0'."""
    import torch
    from beat_this.inference import Audio2Frames
    from beat_this.model.postprocessor import Postprocessor

    a2f = Audio2Frames(checkpoint_path="final0", device=device)
    bl, dl = a2f(x, sr)
    beats, downs = Postprocessor(type="minimal", fps=FPS)(bl, dl)
    return {
        "beats": np.asarray(beats, dtype=float),
        "downbeats": np.asarray(downs, dtype=float),
        "beat_act": torch.sigmoid(bl).cpu().numpy(),
        "down_act": torch.sigmoid(dl).cpu().numpy(),
    }


def fit_constant_grid(beats: np.ndarray) -> dict:
    """Robust least-squares fit beats ~ t0 + k*P with integer k (tolerates missed/extra beats).

    If the fitted tempo is within 0.02 BPM of an integer (typical DAW export) it is snapped.
    `steady` says whether a single constant grid explains the whole track.
    """
    ibi = np.diff(beats)
    P = float(np.median(ibi))
    t0 = float(beats[0])
    for it in range(6):
        if it < 3:
            # sequential unwrapping: beat count between neighbours = round(ibi / P); robust to
            # jitter and gaps, unlike rounding (t - t0) / P with a slightly wrong P over 800 beats
            k = np.r_[0, np.cumsum(np.maximum(np.round(ibi / P), 0))]
        else:
            k = np.round((beats - t0) / P)
        res = beats - (t0 + k * P)
        res -= np.median(res)
        inl = np.abs(res) < 0.06
        A = np.c_[k[inl], np.ones(inl.sum())]
        (P, t0), *_ = np.linalg.lstsq(A, beats[inl], rcond=None)
    k = np.round((beats - t0) / P)
    res = beats - (t0 + k * P)
    inl = np.abs(res) < 0.06
    bpm_fit = 60.0 / P
    snapped = abs(bpm_fit - round(bpm_fit)) < 0.02
    if snapped:
        P = 60.0 / round(bpm_fit)
        t0 = float(np.median(beats[inl] - k[inl] * P))
        k = np.round((beats - t0) / P)
        res = beats - (t0 + k * P)
        inl = np.abs(res) < 0.06
    blocks = []
    for s in np.arange(beats[0], beats[-1], 30.0):
        m = inl & (beats >= s) & (beats < s + 30.0)
        if m.sum() >= 20:
            blocks.append(res[m].mean())
    blocks = np.abs(np.array(blocks)) if blocks else np.array([0.0])
    resid = float(res[inl].std())
    steady = bool(inl.mean() >= 0.9 and resid < 0.02 and np.median(blocks) < 0.012)
    return {
        "period": float(P), "t0": float(t0), "bpm": 60.0 / P, "bpmFit": float(bpm_fit),
        "snapped": bool(snapped), "steady": steady, "residMs": resid * 1000,
        "inlierFrac": float(inl.mean()), "blockDevMs": float(np.median(blocks) * 1000),
        "maxBlockDevMs": float(blocks.max() * 1000),
    }


def onset_offset(mono: np.ndarray, sr: int, grid: np.ndarray, half: float = 0.06) -> dict:
    """Beat-synchronous average of a fine spectral flux (n_fft 256, hop 32 = 0.7 ms) around grid
    points. Returns the offset (s) of the averaged onset's rising edge (50 % of peak) relative to
    the grid, i.e. just before the transient - the right place to cut for a splice."""
    import librosa

    n_fft, hop = 256, 32
    w = int(half * sr)
    acc, n = None, 0
    for g in grid:
        c = int(round(g * sr))
        a, b = c - w - n_fft // 2, c + w + n_fft // 2
        if a < 0 or b > len(mono):
            continue
        S = np.abs(librosa.stft(mono[a:b], n_fft=n_fft, hop_length=hop, center=False))
        fl = np.maximum(0.0, np.diff(np.log1p(100.0 * S), axis=1)).sum(axis=0)
        acc = fl if acc is None else acc + fl
        n += 1
    avg = acc / max(n, 1)
    rel = (-w + (np.arange(len(avg)) + 1) * hop) / sr
    near = np.abs(rel) < 0.04
    pk = np.flatnonzero(near)[np.argmax(avg[near])]
    pre = (rel >= -0.05) & (np.arange(len(avg)) <= pk)
    base = avg[pre].min()
    thr = base + 0.5 * (avg[pk] - base)
    i = pk
    while i > 0 and avg[i - 1] >= thr:
        i -= 1
    return {"offset": float(rel[i]), "peakOffset": float(rel[pk]),
            "contrast": float((avg[pk] - base) / (base + 1e-9)), "n": n}


def build_grid(t0: float, P: float, first: float, last: float, duration: float) -> np.ndarray:
    """Grid times t0 + k*P covering [first - P/2, last + P/2], clamped to the file."""
    k0 = int(np.ceil((max(first - P / 2, -0.02) - t0) / P))
    k1 = int(np.floor((min(last + P / 2, duration - 0.05) - t0) / P))
    g = t0 + P * np.arange(k0, k1 + 1)
    return np.clip(g, 0.0, None)


def bar_phase(change: np.ndarray, down_act_beats: np.ndarray, meters=(3, 4), top: int = 24) -> dict:
    """Pick meter and downbeat phase.

    On four-on-the-floor material the beat_this downbeat head is ambiguous (kick on every beat), so
    the main evidence is *structural*: strong change points (novelty + loudness steps) in produced
    electronic music fall on bar lines. Votes are the share of change-point strength landing on each
    phase; beat_this's mean downbeat activation per phase is added as a weak (0.25) prior.
    """
    pk, _ = find_peaks(change, distance=6)
    pk = pk[np.argsort(change[pk])[::-1][:top]]
    w = change[pk]
    out = {}
    for m in meters:
        votes = np.array([w[pk % m == ph].sum() for ph in range(m)]) / (w.sum() + 1e-9)
        da = np.array([down_act_beats[ph::m].mean() for ph in range(m)])
        out[m] = {"votes": votes, "downAct": da, "excess": float(votes.max() - 1.0 / m)}
    meter = max(meters, key=lambda m: out[m]["excess"])
    v, da = out[meter]["votes"], out[meter]["downAct"]
    score = v + 0.25 * da / (da.sum() + 1e-9)
    phase = int(np.argmax(score))
    return {
        "meter": int(meter), "phase": phase, "confidence": float(v[phase]),
        "votes": {int(m): [round(float(q), 3) for q in out[m]["votes"]] for m in meters},
        "beatThisDownAct": [round(float(q), 3) for q in out[meter]["downAct"]],
        "excess": {int(m): round(out[m]["excess"], 3) for m in meters},
    }
