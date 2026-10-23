"""Zero-shot audio<->text labels with MuQ-MuLan (OpenMuQ/MuQ-MuLan-large)."""
from __future__ import annotations

import numpy as np

MODEL_ID = "OpenMuQ/MuQ-MuLan-large"
SR = 24000
FRAME_RATE = 25.0  # MuQ hidden-state rate

# (tag, category). The tag string itself is the text query. Categories are exactly
# {genre, instrument, ensemble, vocals, energy, texture, mood}; moods never sit in the "source" cats.
TAG_CATS = ("genre", "instrument", "ensemble", "vocals", "energy", "texture", "mood")
TAGS: list[tuple[str, str]] = [
    # genre / style
    ("techno", "genre"), ("hard techno", "genre"), ("industrial techno", "genre"),
    ("acid techno", "genre"), ("minimal techno", "genre"), ("dub techno", "genre"),
    ("house", "genre"), ("deep house", "genre"), ("trance", "genre"), ("electro", "genre"),
    ("breakbeat", "genre"), ("drum and bass", "genre"), ("dubstep", "genre"),
    ("ambient", "genre"), ("IDM", "genre"), ("synthwave", "genre"), ("EBM", "genre"),
    # instruments / sound sources
    ("four-on-the-floor kick drum", "instrument"), ("rolling bassline", "instrument"),
    ("deep sub bass", "instrument"), ("acid 303 synth line", "instrument"),
    ("arpeggiated synth", "instrument"), ("synth lead melody", "instrument"),
    ("lush synth pads", "instrument"), ("piano", "instrument"), ("strings", "instrument"),
    ("crisp hi-hats and percussion", "instrument"), ("claps and snares", "instrument"),
    ("vocal chops", "instrument"),
    # vocals
    ("female vocals", "vocals"), ("male vocals", "vocals"), ("spoken word", "vocals"),
    ("instrumental, no vocals", "vocals"),
    # energy / function
    ("high energy", "energy"), ("low energy", "energy"), ("build-up with rising tension", "energy"),
    ("big drop", "energy"), ("breakdown", "energy"), ("intro", "energy"), ("outro", "energy"),
    # texture / character
    ("distorted", "texture"), ("glitchy", "texture"), ("atmospheric", "texture"),
    ("minimal and sparse", "texture"), ("dense and layered", "texture"), ("dark", "mood"),
    ("bright", "mood"), ("hypnotic and repetitive", "texture"), ("melodic", "texture"),
    ("noisy", "texture"), ("metallic", "texture"), ("groovy", "texture"), ("cinematic", "mood"),
    ("reverb-drenched", "texture"),
]


# Zero-shot valence / arousal probes: mean cos(positive set) - mean cos(negative set)
VALENCE_POS = ["happy, joyful, uplifting music", "bright, cheerful, feel-good music",
               "warm, hopeful, positive music", "euphoric, blissful, celebratory music"]
VALENCE_NEG = ["sad, dark, sorrowful music", "gloomy, melancholic, depressing music",
               "bleak, hopeless, despairing music", "menacing, sinister, ominous music"]
AROUSAL_POS = ["energetic, intense, powerful music", "loud, fast, aggressive music",
               "driving, high-energy dance music", "exciting, frantic, pounding music"]
AROUSAL_NEG = ["calm, quiet, relaxing music", "slow, soft, gentle music",
               "peaceful, still, ambient music", "sparse, hushed, sleepy music"]
PROBE_TEXTS = VALENCE_POS + VALENCE_NEG + AROUSAL_POS + AROUSAL_NEG


def ensemble_texts(ml, groups: list[list[str]]) -> np.ndarray:
    """CLIP-style prompt ensembling: embed every phrasing, L2-normalise, average per group, renormalise."""
    flat = [t for g in groups for t in g]
    E = ml.text(flat)
    out, i = [], 0
    for g in groups:
        v = E[i:i + len(g)].mean(axis=0)
        out.append(v / (np.linalg.norm(v) + 1e-9))
        i += len(g)
    return np.stack(out)


def probe_contrast(lat: np.ndarray, probe_lat: np.ndarray) -> dict:
    """Raw (unsmoothed) per-window probe contrasts in cosine units."""
    C = lat @ probe_lat.T
    n = len(VALENCE_POS)
    v = C[:, :n].mean(1) - C[:, n:2 * n].mean(1)
    a = C[:, 2 * n:3 * n].mean(1) - C[:, 3 * n:4 * n].mean(1)
    return {"valence": v, "arousal": a}


def squash_z(v: np.ndarray) -> np.ndarray:
    """z-score per track, then tanh(z / 2) -> (-1, 1); |z| = 2 maps to 0.76."""
    return np.tanh(((v - v.mean()) / (v.std() + 1e-9)) / 2.0)


def smooth_rows(M: np.ndarray, kernel=(0.25, 0.5, 0.25)) -> np.ndarray:
    """Light temporal smoothing along axis 0 with edge replication."""
    k = np.asarray(kernel)
    h = len(k) // 2
    P = np.pad(M, ((h, h), (0, 0)), mode="edge")
    return sum(k[i] * P[i:i + len(M)] for i in range(len(k)))


def softmax(Z: np.ndarray, axis=-1) -> np.ndarray:
    Z = Z - Z.max(axis=axis, keepdims=True)
    E = np.exp(Z)
    return E / E.sum(axis=axis, keepdims=True)


class MuLan:
    def __init__(self, device: str = "cpu"):
        import torch
        from muq import MuQMuLan

        self.torch = torch
        self.device = device
        self.model = MuQMuLan.from_pretrained(MODEL_ID).eval().to(device)
        # learned contrastive temperature (logit scale) -> used for the per-window softmax
        self.logit_scale = float(self.model.mulan.contrast.temperatures.detach().exp().flatten()[0])

    def text(self, texts: list[str]) -> np.ndarray:
        torch = self.torch
        out = []
        with torch.no_grad():
            for i in range(0, len(texts), 16):
                out.append(self.model(texts=texts[i:i + 16]).float().cpu())
        T = torch.cat(out)
        return torch.nn.functional.normalize(T, dim=-1).numpy()

    def windows(self, y24: np.ndarray, starts: np.ndarray, n_samples: int, total_dur: float,
                batch: int = 4, progress=None):
        """Audio latents (L2-normalised, 512-d) for fixed-length windows, plus the per-frame
        768-d audio-tower outputs accumulated on a global 25 Hz timeline (Hann-weighted across
        overlapping windows) for use as learned beat embeddings."""
        torch = self.torch
        F = torch.nn.functional
        tower = self.model.mulan.audio
        Tg = int(total_dur * FRAME_RATE) + 2
        acc = np.zeros((Tg, 768), np.float32)
        wacc = np.zeros(Tg, np.float32)
        lats = []
        with torch.no_grad():
            for b in range(0, len(starts), batch):
                chunk = starts[b:b + batch]
                xs = []
                for s in chunk:
                    i0 = int(round(s * SR))
                    seg = y24[i0:i0 + n_samples]
                    if len(seg) < n_samples:
                        seg = np.pad(seg, (0, n_samples - len(seg)))
                    xs.append(seg)
                x = torch.from_numpy(np.stack(xs)).to(self.device)
                fr = tower(x, return_mean=False)                       # (B, T, 768)
                lat = F.normalize(self.model.mulan.audio_to_latents(fr.mean(dim=-2)), dim=-1)
                lats.append(lat.float().cpu().numpy())
                fr = fr.float().cpu().numpy()
                T = fr.shape[1]
                w = np.hanning(T + 2)[1:-1].astype(np.float32)
                dur = n_samples / SR
                for j, s in enumerate(chunk):
                    centers = s + (np.arange(T) + 0.5) * dur / T
                    gi = np.clip(np.floor(centers * FRAME_RATE).astype(int), 0, Tg - 1)
                    np.add.at(acc, gi, fr[j] * w[:, None])
                    np.add.at(wacc, gi, w)
                if progress:
                    progress(min(b + batch, len(starts)), len(starts))
        return np.concatenate(lats), acc, wacc


def beat_embeddings(acc: np.ndarray, wacc: np.ndarray, starts: np.ndarray, ends: np.ndarray) -> np.ndarray:
    """Mean 25 Hz MuQ-MuLan frame feature inside each beat span; uncovered beats copy the nearest."""
    E = np.zeros((len(starts), acc.shape[1]), np.float32)
    ok = np.zeros(len(starts), bool)
    for i, (s, e) in enumerate(zip(starts, ends)):
        a, b = int(np.floor(s * FRAME_RATE)), max(int(np.floor(e * FRAME_RATE)), int(np.floor(s * FRAME_RATE)) + 1)
        w = wacc[a:b]
        if w.sum() > 1e-3:
            E[i] = (acc[a:b]).sum(axis=0) / w.sum()
            ok[i] = True
    idx = np.flatnonzero(ok)
    for i in np.flatnonzero(~ok):
        E[i] = E[idx[np.argmin(np.abs(idx - i))]]
    return E
