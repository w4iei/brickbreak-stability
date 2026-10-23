"""Resident Stable Audio 3 (MLX) audio-to-audio engine for the Brick Breaker server.

Mirrors `run_generation()` in stable-audio-3/optimized/mlx/scripts/sa3_gradio.py
(a2a mode only; no LoRA / CFG / inpaint) with every model kept loaded:

    chunk ─▶ SAME-S encoder ─▶ lat·(1-σ) + noise·σ ─▶ DiT pingpong from σ ─▶ SAME-S decoder ─▶ chunk
                                 prompt ─▶ T5Gemma (cached per prompt) ─┘

CLI (benchmark / one-off):
    uv run --project server python server/sa3_engine.py \
        --track tracks/X.wav --start 60 --prompt "..." --strength 0.5 --out /tmp/x.wav
"""

from __future__ import annotations

import os
import sys
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
import mlx.core as mx

SAMPLE_RATE = 44100
SAMPLES_PER_LATENT = 4096
# Stability AI's repo (https://github.com/Stability-AI/stable-audio-3), cloned into the repo root unless SA3_DIR says
# where; its MLX runtime is under optimized/mlx.
_DEFAULT_SA3_DIR = Path(os.environ.get("SA3_DIR", Path(__file__).resolve().parents[1] / "stable-audio-3")) / "optimized" / "mlx"
_PROMPT_CACHE_MAX = 128
_KNEE = 0.9
_MAX_MATCH_GAIN = 10 ** (12 / 20)
_MATCH_PEAK_CEIL = 1.12   # an RMS-match boost may not push peaks past +1 dBFS
_SCHEDULES = ("truncated", "repo")


def _soft_limit(x: np.ndarray, knee: float = _KNEE) -> np.ndarray:
    """Identity below `knee`, tanh-rounded above it; output stays inside (-1, 1)."""
    a = np.abs(x)
    over = a > knee
    if not over.any():
        return x
    y = x.copy()
    y[over] = np.sign(x[over]) * (knee + (1 - knee) * np.tanh((a[over] - knee) / (1 - knee)))
    return y


def _stats(x: np.ndarray) -> tuple[float, float]:
    return float(np.abs(x).max()), float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


class SA3Engine:
    """Stable Audio 3 small (MLX) audio-to-audio, all models resident.

    THREADING: MLX (>=0.31) keeps its GPU streams per thread, and an unevaluated
    (lazy) array built on one thread raises "There is no Stream(gpu, N) in current
    thread" when evaluated on another. So `load()` and every `transform()` must run
    on the SAME single thread, e.g. one `ThreadPoolExecutor(max_workers=1)` owned by
    the server — never the asyncio loop thread and never `asyncio.to_thread`.
    `transform()` raises RuntimeError if called from a different thread than `load()`.
    Inputs/outputs are plain numpy, so callers on other threads are fine.

    STRENGTH σ (clamped to [0.05, 1]) is the init noise level: lat·(1-σ) + noise·σ.
      schedule="truncated" (default, SDEdit-style): take the full-strength schedule for
        `steps` (σ 1→0, logsnr-shifted like the repo) and enter it at σ — keep only the points
        strictly below σ and prepend σ. Never re-noises above σ, so the dial is monotonic, and
        low σ runs fewer DiT steps (steps=8: σ ≤ 0.27 → 1, ≤ 0.51 → 2, ≤ 0.75 → 3, ≤ 0.89 → 4, 1.0 → 8).
      schedule="repo": the repo's σmax schedule (`steps` points from σ; step 2 re-noises to
        logsnr_shift(σ·(1-1/steps)), e.g. 0.5 → 0.83), which makes the response a cliff at σ≈0.55.
    LENGTH: `chunk_latents` is the default length; transform(latents=N) renders any other even N
      with the same loaded models (the DiT runs any sequence length; the first call at a new length
      compiles its kernels, ~2-3× slower). T5 prompt encodings are cached per prompt, the
      seconds conditioning per length.
    LEVEL: match_rms scales the output toward the input chunk's RMS (a silent input gives a
    silent output). Boosts are capped at +12 dB and at a peak of 1.12, so quiet, peaky high-σ
    generations are not driven into the limiter. A soft limiter (identity below 0.9) then
    keeps samples inside [-1, 1].
    """

    def __init__(self, sa3_dir: Path | None = None, dit: str = "sm-music", decoder: str = "same-s",
                 chunk_latents: int = 64, steps: int = 8, schedule: str = "truncated",
                 match_rms: bool = True):
        if chunk_latents < 2 or chunk_latents % 2:
            # SAME-S encoder pads audio patches to a multiple of 32 → T_lat*16 % 32 == 0.
            raise ValueError(f"chunk_latents must be an even number >= 2, got {chunk_latents}")
        if steps < 1:
            raise ValueError(f"steps must be >= 1, got {steps}")
        if schedule not in _SCHEDULES:
            raise ValueError(f"schedule must be one of {_SCHEDULES}, got {schedule!r}")
        self.schedule, self.match_rms = schedule, match_rms
        self.sa3_dir = Path(sa3_dir or _DEFAULT_SA3_DIR).resolve()
        if not (self.sa3_dir / "scripts" / "sa3_mlx.py").is_file():
            raise FileNotFoundError(f"no SA3 MLX runtime at {self.sa3_dir} (clone stable-audio-3 there, or set SA3_DIR)")
        self.dit, self.decoder, self.steps = dit, decoder, steps
        self.chunk_latents = chunk_latents
        self.chunk_samples = chunk_latents * SAMPLES_PER_LATENT
        self.chunk_seconds = self.chunk_samples / SAMPLE_RATE
        self.name = f"Stable Audio 3 {dit.replace('sm-', 'small-')} (MLX)"
        self.load_ms: float | None = None
        self._owner: int | None = None
        self._cond: OrderedDict[str, mx.array] = OrderedDict()   # prompt → padded T5 embedding
        self._secs: dict[int, mx.array] = {}                       # latents → seconds embedding

    # ── loading ───────────────────────────────────────────────────────────
    def load(self) -> None:
        t0 = time.perf_counter()
        self._owner = threading.get_ident()
        mx.set_default_device(mx.gpu)
        for p in (self.sa3_dir / "scripts", self.sa3_dir):
            if str(p) not in sys.path:
                sys.path.insert(0, str(p))
        # Imported here (on the MLX thread) so nothing lazy is created on the importer's thread.
        from sa3_mlx import (DIT_CHOICES, T5GEMMA_NPZ_REL, load_decoder, load_dit,
                             load_encoder, patch_audio)
        from models.defs.sa3_pipeline import (apply_prompt_padding, build_pingpong_schedule,
                                              load_conditioner_from_npz, patched_decode,
                                              sample_flow_pingpong)
        from models.defs.t5gemma_mlx import T5Gemma
        from weights import ensure_local

        if self.dit not in DIT_CHOICES:
            raise ValueError(f"unknown dit {self.dit!r}; choose from {list(DIT_CHOICES)}")
        if DIT_CHOICES[self.dit]["default_decoder"] != self.decoder:
            raise ValueError(f"{self.dit} latents need decoder "
                             f"{DIT_CHOICES[self.dit]['default_decoder']!r}, not {self.decoder!r}")
        self._f = dict(apply_prompt_padding=apply_prompt_padding, patch_audio=patch_audio,
                       build_pingpong_schedule=build_pingpong_schedule,
                       sample_flow_pingpong=sample_flow_pingpong, patched_decode=patched_decode)

        self._t5 = T5Gemma.from_npz(str(ensure_local(T5GEMMA_NPZ_REL)))
        dit_npz = str(ensure_local(DIT_CHOICES[self.dit]["ckpt"]))
        pad_emb, self._secs_embedder = load_conditioner_from_npz(dit_npz, prefix="cond.")
        self._pad_emb = pad_emb.astype(mx.float16)
        mx.eval(self._pad_emb)
        self._enc, pad_mod = load_encoder(self.decoder, mx.float32)
        assert (self.chunk_latents * 16) % pad_mod == 0
        self._dec, _, _ = load_decoder(self.decoder, mx.float32)
        self._dit, _ = load_dit(self.dit, T_lat=self.chunk_latents, dtype=mx.float16)

        # Warm-up compiles the Metal kernels for this T_lat (first call is ~2-3× slower).
        rng = np.random.default_rng(0)
        self.transform((0.1 * rng.standard_normal((2, self.chunk_samples))).astype(np.float32),
                       "", 0.5, 0)
        self.load_ms = (time.perf_counter() - t0) * 1000

    def _conditioning(self, prompt: str, latents: int) -> tuple[mx.array, mx.array]:
        if latents not in self._secs:
            self._secs[latents] = self._secs_embedder(latents * SAMPLES_PER_LATENT / SAMPLE_RATE).astype(mx.float16)
        secs = self._secs[latents]                                            # (1, 1, 768)
        if prompt in self._cond:
            self._cond.move_to_end(prompt)
        else:
            embeds, mask = self._t5.encode([prompt], max_len=256)
            self._cond[prompt] = self._f["apply_prompt_padding"](embeds.astype(mx.float16), mask, self._pad_emb)
            if len(self._cond) > _PROMPT_CACHE_MAX:
                self._cond.popitem(last=False)
        cross = mx.concatenate([self._cond[prompt], secs], axis=1)            # (1, 257, 768)
        glob = secs[:, 0, :]                                                  # (1, 768)
        mx.eval(cross, glob)
        return cross, glob

    def _sigmas(self, sigma: float, schedule: str) -> mx.array:
        build = self._f["build_pingpong_schedule"]
        if schedule == "repo":
            return build(self.steps, sigma_max=sigma, use_logsnr_shift=True)
        full = np.array(build(self.steps, sigma_max=1.0, use_logsnr_shift=True))
        return mx.array(np.concatenate([[sigma], full[full < sigma]]).astype(np.float32))

    # Batched CFG, as model_fn in sa3_gradio.run_generation (apg=1.0): guidance in denoised
    # space; cfg > 1 extrapolates along the part of (cond-uncond) orthogonal to cond (APG),
    # cfg < 1 is a plain lerp toward the negative prompt.
    @staticmethod
    def _guide(x: mx.array, v_c: mx.array, v_u: mx.array, t: mx.array, cfg: float) -> mx.array:
        s, x32 = t.reshape(-1, 1, 1).astype(mx.float32), x.astype(mx.float32)
        d_c, d_u = x32 - v_c.astype(mx.float32) * s, x32 - v_u.astype(mx.float32) * s
        diff = d_c - d_u
        if cfg > 1.0:
            unit = d_c / mx.maximum(mx.sqrt((d_c * d_c).sum(axis=(-2, -1), keepdims=True)), 1e-8)
            diff = diff - (diff * unit).sum(axis=(-2, -1), keepdims=True) * unit
        return ((x32 - (d_c + (cfg - 1.0) * diff)) / s).astype(x.dtype)

    def _model_fn(self, cross: mx.array, glob: mx.array, neg: mx.array | None, cfg: float):
        if neg is None:
            return lambda x, t: self._dit(x, t, cross, glob)
        cross2, glob2 = mx.concatenate([cross, neg]), mx.concatenate([glob, glob])

        def fn(x, t):
            v_c, v_u = mx.split(self._dit(mx.concatenate([x, x]), mx.concatenate([t, t]), cross2, glob2), 2)
            return self._guide(x, v_c, v_u, t, cfg)
        return fn

    # ── inference ─────────────────────────────────────────────────────────
    def transform(self, audio: np.ndarray, prompt: str, strength: float, seed: int, *,
                  negative: str | None = None, cfg: float = 1.0, match_rms: bool | None = None,
                  schedule: str | None = None, latents: int | None = None) -> tuple[np.ndarray, dict]:
        """Noise the input to σ and sample down from there (SDEdit: the input survives only in the starting point).
        CFG runs only when `negative` is non-empty and cfg != 1 (one batch-2 DiT pass per step, ~1.6× sampling
        time); otherwise it costs nothing. Other keyword args override the constructor defaults for this call only."""
        schedule = schedule or self.schedule
        if schedule not in _SCHEDULES:
            raise ValueError(f"schedule must be one of {_SCHEDULES}, got {schedule!r}")
        match_rms = self.match_rms if match_rms is None else match_rms
        if self._owner is None:
            raise RuntimeError("SA3Engine.load() has not been called")
        if threading.get_ident() != self._owner:
            raise RuntimeError("SA3Engine.transform() must run on the thread that called load() "
                               "(MLX streams are per-thread)")
        f, T = self._f, latents or self.chunk_latents
        if T < 2 or T % 2:
            raise ValueError(f"latents must be an even number >= 2, got {T}")
        n = T * SAMPLES_PER_LATENT
        t: dict = {}
        t0 = t_start = time.perf_counter()

        x = np.asarray(audio, dtype=np.float32)
        if x.ndim == 1:
            x = x[None]
        x = np.repeat(x, 2, axis=0) if x.shape[0] == 1 else x[:2]
        if x.shape[1] != n:
            x = np.pad(x[:, :n], ((0, 0), (0, n - min(n, x.shape[1]))))
        sigma = float(min(max(strength, 0.05), 1.0))

        use_cfg = bool(negative) and cfg != 1.0
        t["t5_cached"] = prompt in self._cond and (not use_cfg or negative in self._cond)
        cross, glob = self._conditioning(prompt, T)
        neg = self._conditioning(negative, T)[0] if use_cfg else None
        t["t5"], t0 = (time.perf_counter() - t0) * 1000, time.perf_counter()

        orig = self._enc(mx.array(f["patch_audio"](x[None], patch_size=256)))  # (1, 256, T)
        mx.eval(orig)
        t["enc"], t0 = (time.perf_counter() - t0) * 1000, time.perf_counter()

        pure = mx.random.normal((1, 256, T), dtype=mx.float16, key=mx.random.key(seed))
        noise = orig.astype(mx.float16) * (1.0 - sigma) + pure * sigma
        sigmas = self._sigmas(sigma, schedule)
        gen = f["sample_flow_pingpong"](self._model_fn(cross, glob, neg, cfg), noise, sigmas, seed=seed + 1)
        mx.eval(gen)
        steps_run = int(sigmas.shape[0]) - 1
        t["sample"], t0 = (time.perf_counter() - t0) * 1000, time.perf_counter()
        lat = gen.astype(mx.float32)

        # T is even, so one un-chunked SAME-S call is valid (== decode_chunked, see README).
        audio_out = f["patched_decode"](self._dec(lat), patch_size=256, channels=2)
        y = np.array(audio_out.astype(mx.float32))[0]
        t["decode"] = (time.perf_counter() - t0) * 1000

        if not np.isfinite(y).all():
            raise FloatingPointError("SA3 output contains NaN/Inf")
        t["in_peak"], t["in_rms"] = _stats(x)
        raw_peak, raw_rms = _stats(y)
        gain = 1.0
        if match_rms and raw_rms > 1e-6:
            gain = min(max(t["in_rms"], 1e-6) / raw_rms, _MAX_MATCH_GAIN)
            if gain > 1.0 and _MATCH_PEAK_CEIL:
                gain = max(1.0, min(gain, _MATCH_PEAK_CEIL / raw_peak))
        y = y * gain
        t["gain_db"] = float(20 * np.log10(gain))
        t["out_peak_raw"], _ = _stats(y)                    # after gain, before the limiter
        t["limited_frac"] = float(np.mean(np.abs(y) > _KNEE))
        y = _soft_limit(y)
        t["out_peak"], t["out_rms"] = _stats(y)
        t["sigma"], t["seed"], t["steps"], t["latents"] = sigma, seed, self.steps, T
        t["steps_run"], t["schedule"], t["cfg"] = steps_run, schedule, cfg if use_cfg else 1.0
        t["total"] = (time.perf_counter() - t_start) * 1000
        return y.astype(np.float32, copy=False), t


# ── CLI ───────────────────────────────────────────────────────────────────
def read_segment(path: str, start: float, n: int) -> np.ndarray:
    """(2, n) float32 at 44.1 kHz starting at `start` seconds (zero-padded at EOF)."""
    import soundfile as sf
    x = None
    try:
        if sf.info(path).samplerate == SAMPLE_RATE:
            x = sf.read(path, start=int(round(start * SAMPLE_RATE)), frames=n,
                        dtype="float32", always_2d=True)[0].T
    except RuntimeError:
        pass  # format libsndfile can't open → ffmpeg
    if x is None:
        import shutil, subprocess
        ff = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
        r = subprocess.run([ff, "-v", "error", "-ss", f"{start}", "-i", path, "-t", f"{n / SAMPLE_RATE}",
                            "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", "-"], capture_output=True)
        if r.returncode:
            raise RuntimeError(f"ffmpeg could not decode {path}: {r.stderr.decode().strip()}")
        x = np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2).T
    x = np.repeat(x, 2, axis=0) if x.shape[0] == 1 else x[:2]
    return np.ascontiguousarray(np.pad(x, ((0, 0), (0, max(0, n - x.shape[1]))))[:, :n])


def _main() -> None:
    import argparse
    from concurrent.futures import ThreadPoolExecutor
    import soundfile as sf

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--track", required=True)
    ap.add_argument("--start", type=float, default=0.0, help="segment start (s)")
    ap.add_argument("--prompt", default="")
    ap.add_argument("--negative", default=None, help="negative prompt (CFG only when --cfg != 1)")
    ap.add_argument("--cfg", type=float, default=1.0)
    ap.add_argument("--strength", type=float, default=0.5, help="init noise level σ, 0.05-1")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--chunk-latents", type=int, default=64)
    ap.add_argument("--steps", type=int, default=8, help="DiT steps of a full-strength (σ=1) run")
    ap.add_argument("--schedule", default="truncated", choices=_SCHEDULES)
    ap.add_argument("--no-match-rms", dest="match_rms", action="store_false")
    ap.add_argument("--dit", default="sm-music", choices=["sm-music", "sm-sfx"])
    ap.add_argument("--out", required=True, help="output WAV (16-bit)")
    ap.add_argument("--repeat", type=int, default=1)
    a = ap.parse_args()

    eng = SA3Engine(dit=a.dit, chunk_latents=a.chunk_latents, steps=a.steps, schedule=a.schedule,
                    match_rms=a.match_rms)
    x = read_segment(a.track, a.start, eng.chunk_samples)
    print(f"{eng.name}: chunk {a.chunk_latents} latents = {eng.chunk_seconds:.3f}s, {a.steps} steps")
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx") as ex:
        ex.submit(eng.load).result()
        print(f"load (incl. warm-up): {eng.load_ms:.0f} ms")
        for i in range(a.repeat):
            y, t = ex.submit(eng.transform, x, a.prompt, a.strength, a.seed,
                             negative=a.negative, cfg=a.cfg).result()
            print(f"[{i}] total {t['total']:6.1f} ms  ({eng.chunk_seconds * 1000 / t['total']:5.1f}× rt)  "
                  f"t5 {t['t5']:5.1f}{'*' if t['t5_cached'] else ' '} enc {t['enc']:5.1f}  "
                  f"sample {t['sample']:6.1f} ({t['steps_run']} st)  decode {t['decode']:5.1f}  |  "
                  f"in peak {t['in_peak']:.3f} rms {t['in_rms']:.3f}  out peak {t['out_peak']:.3f} "
                  f"(raw {t['out_peak_raw']:.3f}, {100 * t['limited_frac']:.2f}% > knee) "
                  f"rms {t['out_rms']:.3f} gain {t['gain_db']:+.1f} dB")
    sf.write(a.out, y.T, SAMPLE_RATE, subtype="PCM_16")
    print(f"wrote {a.out}  (* = cached prompt conditioning)")


if __name__ == "__main__":
    _main()
