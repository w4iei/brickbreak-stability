"""Audio loading and small signal helpers."""
from __future__ import annotations

import numpy as np
import soundfile as sf
import soxr


def load(path: str) -> tuple[np.ndarray, int]:
    """Return (stereo float32 array of shape (n, ch), sample rate). Never modifies the file."""
    x, sr = sf.read(path, dtype="float32", always_2d=True)
    return x, sr


def to_mono(x: np.ndarray) -> np.ndarray:
    return x.mean(axis=1).astype(np.float32)


def resample(y: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return y.astype(np.float32)
    return soxr.resample(y, sr, target, quality="HQ").astype(np.float32)


def span_db(x: np.ndarray, sr: int, starts, ends) -> np.ndarray:
    """RMS level in dBFS (power averaged over channels) of each [start, end) span in seconds."""
    p = (x.astype(np.float64) ** 2).mean(axis=1) if x.ndim == 2 else x.astype(np.float64) ** 2
    cs = np.concatenate([[0.0], np.cumsum(p)])
    i0 = np.clip(np.round(np.asarray(starts) * sr).astype(int), 0, len(p))
    i1 = np.clip(np.round(np.asarray(ends) * sr).astype(int), 0, len(p))
    i1 = np.maximum(i1, i0 + 1)
    i1 = np.minimum(i1, len(p))
    i0 = np.minimum(i0, i1 - 1)
    mean = (cs[i1] - cs[i0]) / (i1 - i0)
    return 10.0 * np.log10(mean + 1e-12)
