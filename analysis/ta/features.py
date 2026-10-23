"""Beat-synchronous low-level features, change curve and key estimation."""
from __future__ import annotations

import numpy as np
import scipy.signal as ss

NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
# Krumhansl-Kessler key profiles
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def frame_features(y22: np.ndarray, sr: int, hop: int = 256) -> dict:
    """Frame-level MFCC / harmonic chroma / log-mel / onset curves (computed once per track)."""
    import librosa

    S = np.abs(librosa.stft(y22, n_fft=2048, hop_length=hop))
    mel = librosa.feature.melspectrogram(S=S ** 2, sr=sr, n_mels=64)
    logmel = librosa.power_to_db(mel)
    mfcc = librosa.feature.mfcc(S=logmel, n_mfcc=20)
    harm = librosa.effects.harmonic(y22, margin=2.0)
    chroma = librosa.feature.chroma_cqt(y=harm, sr=sr, hop_length=hop)
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    e_low = np.log1p(100.0 * S[freqs < 150].mean(axis=0))
    flux_low = np.r_[0, 0, np.maximum(0.0, e_low[2:] - e_low[:-2])]
    onset = librosa.onset.onset_strength(S=logmel, sr=sr)
    return {"mfcc": mfcc, "chroma": chroma, "logmel": logmel, "flux_low": flux_low, "onset": onset,
            "sr": sr, "hop": hop}


def pool_features(fr: dict, starts: np.ndarray, ends: np.ndarray) -> dict:
    """Mean MFCC / chroma / log-mel per [start, end) span plus onset peaks at each span start."""
    sr, hop = fr["sr"], fr["hop"]
    n = min(fr["mfcc"].shape[1], fr["chroma"].shape[1])
    f0 = np.clip(np.floor(np.asarray(starts) * sr / hop).astype(int), 0, n - 1)
    f1 = np.clip(np.floor(np.asarray(ends) * sr / hop).astype(int), 1, n)
    f1 = np.maximum(f1, f0 + 1)
    rad = int(round(0.03 * sr / hop))

    def sync(F):
        return np.stack([F[:, a:b].mean(axis=1) for a, b in zip(f0, f1)])

    def peak_at(v):
        return np.array([v[max(0, a - rad):a + rad + 1].max() for a in f0])

    return {
        "mfcc": sync(fr["mfcc"]),          # (B, 20)
        "chroma": sync(fr["chroma"]),      # (B, 12)
        "logmel": sync(fr["logmel"]),      # (B, 64)
        "kick": peak_at(fr["flux_low"]),   # (B,) low-band (<150 Hz) onset strength at the span start
        "onset": peak_at(fr["onset"]),     # (B,) broadband onset strength at the span start
    }


def beat_features(y22: np.ndarray, sr: int, starts: np.ndarray, ends: np.ndarray, hop: int = 256) -> dict:
    """Mean MFCC / harmonic chroma / log-mel per beat span plus onset peaks at each beat."""
    return pool_features(frame_features(y22, sr, hop), starts, ends)


def unit(F: np.ndarray, center: np.ndarray | None = None) -> np.ndarray:
    F = F - (F.mean(axis=0) if center is None else center)
    return F / (np.linalg.norm(F, axis=1, keepdims=True) + 1e-9)


def checkerboard_novelty(S: np.ndarray, L: int) -> np.ndarray:
    """Foote novelty: Gaussian-tapered checkerboard kernel of half-size L slid along the diagonal.
    Value at i measures a boundary at the *start* of element i."""
    g = ss.windows.gaussian(2 * L, std=L / 2)
    K = np.outer(g, g)
    K[:L, L:] *= -1
    K[L:, :L] *= -1
    Sp = np.pad(S, L, mode="edge")
    nv = np.array([(Sp[i:i + 2 * L, i:i + 2 * L] * K).sum() for i in range(len(S))])
    return np.maximum(nv, 0.0)


def norm01(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, float)
    return (v - v.min()) / (v.max() - v.min() + 1e-9)


def beat_change_curve(feat: dict, beat_db: np.ndarray) -> np.ndarray:
    """Per-beat 'something changes here' score: SSM novelty (MFCC + chroma, 8- and 16-beat kernels)
    plus the loudness step between the 4 beats after and the 4 beats before."""
    F = np.hstack([unit(feat["mfcc"][:, 1:]) * np.sqrt(0.6), unit(feat["chroma"]) * np.sqrt(0.4)])
    S = F @ F.T
    nov = norm01(checkerboard_novelty(S, 8)) + norm01(checkerboard_novelty(S, 16))
    B = len(beat_db)
    step = np.zeros(B)
    for i in range(4, B - 4):
        step[i] = abs(beat_db[i:i + 4].mean() - beat_db[i - 4:i].mean())
    return norm01(nov) + norm01(step)


def estimate_key(chroma: np.ndarray, weights: np.ndarray) -> dict:
    prof = (chroma * weights[:, None]).sum(axis=0)
    prof = prof / (prof.sum() + 1e-9)
    scores = []
    for t in range(12):
        for mode, tpl in (("major", KK_MAJOR), ("minor", KK_MINOR)):
            scores.append((np.corrcoef(prof, np.roll(tpl, t))[0, 1], f"{NOTE_NAMES[t]} {mode}"))
    scores.sort(reverse=True)
    c, margin = scores[0][0], scores[0][0] - scores[1][0]
    conf = "high" if c >= 0.6 and margin >= 0.1 else "medium" if c >= 0.4 and margin >= 0.05 else "low"
    return {
        "key": scores[0][1], "confidence": conf, "corr": round(float(scores[0][0]), 3),
        "runnerUp": scores[1][1], "runnerUpCorr": round(float(scores[1][0]), 3),
        "chromaProfile": [round(float(c), 4) for c in prof],
    }
