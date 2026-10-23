"""Audio server for Brick Breaker: the track list, each track's analysis, and Stable Audio 3 transforms, rendered on
this computer (Apple silicon, MLX) and kept on disk.

    uv run --project server python server/server.py        # from the repo root, port 8765

`npm run dev` proxies /api here (vite.config.ts). Every MLX call runs on one dedicated thread (see SA3Engine). If the
engine can't load, /api/transform passes the track through unchanged and /api/status says why.

Folders (environment variables override them): TRACKS_DIR (tracks/), ANALYSIS_DIR (analysis/out/, written by
analysis/analyze.py), RENDER_CACHE (server/cache/renders/), SA3_DIR (stable-audio-3/, Stability AI's repo).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import math
import os
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from sa3_engine import SAMPLE_RATE, SAMPLES_PER_LATENT, SA3Engine, read_segment

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent  # the repo
TRACKS = Path(os.environ.get("TRACKS_DIR", ROOT / "tracks")).resolve()
ANALYSIS = Path(os.environ.get("ANALYSIS_DIR", ROOT / "analysis" / "out")).resolve()
AUDIO = {".wav", ".mp3", ".flac", ".ogg", ".aif", ".aiff"}
PORT = int(os.environ.get("PORT", 8765))
POLL = 0.05  # s, how often a waiting render checks that its client is still there
MAX_SECONDS = 30.0  # longest render a request may ask for
ENVELOPE_RATE = 10  # bins per s, as site/envelopes.py

mlx = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")  # the engine's one thread
engine = SA3Engine(chunk_latents=int(os.environ.get("CHUNK_LATENTS", 64)), steps=int(os.environ.get("STEPS", 8)))
state: dict = {"ready": False, "error": None}
app = FastAPI()


def _load() -> None:
    try:
        engine.load()
        state["ready"] = True
    except Exception as e:  # keep serving tracks; transforms pass through
        state["error"] = f"{type(e).__name__}: {e}"


@app.on_event("startup")
async def startup() -> None:
    mlx.submit(_load)
    asyncio.create_task(prerender_worker())
    asyncio.create_task(resume_batch())


def track_path(name: str) -> Path:
    """A track by its name relative to TRACKS. Not resolved (a track may be a link to a file elsewhere), but the name
    itself must stay inside TRACKS."""
    p = Path(os.path.normpath(TRACKS / name))
    if not p.is_relative_to(TRACKS) or p.suffix.lower() not in AUDIO or not p.is_file():
        raise HTTPException(404, f"no track {name!r}")
    return p


def audio_files(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in AUDIO and not p.name.startswith("."))


def latents_for(seconds: float | None) -> int:
    """Even latent count covering `seconds` (the engine's chunk when None); renders are this long exactly."""
    if seconds is None:
        return engine.chunk_latents
    seconds = min(max(seconds, 1.0), MAX_SECONDS)
    return 2 * math.ceil(seconds * SAMPLE_RATE / SAMPLES_PER_LATENT / 2)


def wav_bytes(audio: np.ndarray) -> bytes:
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16).T
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(audio.shape[0])
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


@app.get("/api/status")
def status() -> dict:
    return {
        "ready": state["ready"],
        "engine": engine.name,
        "error": state["error"],
        "chunkSeconds": engine.chunk_seconds,
        "sampleRate": SAMPLE_RATE,
    }


@app.get("/api/tracks")
def tracks() -> list[dict]:
    """The tracks in TRACKS (subfolders are listed as sets, which the game leaves out)."""
    sets = [("", audio_files(TRACKS))] + [(d.name, audio_files(d)) for d in sorted(TRACKS.iterdir()) if d.is_dir() and not d.name.startswith(".")]
    return [{"name": str(p.relative_to(TRACKS)), "set": s, "duration": sf.info(str(p)).duration} for s, files in sets for p in files]


@app.get("/api/tracks/{name:path}")
def track(name: str) -> FileResponse:
    return FileResponse(track_path(name))


@app.get("/api/excerpt")
def excerpt(track: str, start: float, seconds: float | None = None) -> Response:
    """The untouched audio over exactly the span a transform with the same start/seconds covers."""
    audio = read_segment(str(track_path(track)), max(0.0, start), latents_for(seconds) * SAMPLES_PER_LATENT)
    return Response(wav_bytes(audio), media_type="audio/wav")


@app.get("/api/analysis/{name:path}", response_model=None)
def analysis(name: str) -> FileResponse | Response:
    """Beats, bars, tempo and tags from analysis/analyze.py. 204 when the track hasn't been analysed: it plays without
    beats (switches land at once, chunks don't follow its bars)."""
    p = ANALYSIS / f"{Path(name).stem}.json"
    if not p.is_file():
        return Response(status_code=204)
    return FileResponse(p, media_type="application/json", headers={"Cache-Control": "no-cache"})


# ── emotions made with New emotion: kept here, so every browser on this computer sees the same ones
EMOTIONS = Path(os.environ.get("EMOTIONS_FILE", HERE / "emotions.json"))


@app.get("/api/emotions")
def get_emotions() -> list[dict]:
    try:
        return json.loads(EMOTIONS.read_text()) if EMOTIONS.is_file() else []
    except ValueError:
        return []


def save_emotions(bricks: list[dict]) -> list[dict]:
    tmp = EMOTIONS.with_suffix(".part")
    tmp.write_text(json.dumps(bricks, indent=1, ensure_ascii=False))
    os.replace(tmp, EMOTIONS)
    return bricks


# One at a time, so two open pages each add theirs instead of the last one's list replacing the other's.
@app.post("/api/emotions")
def put_emotion(b: dict) -> dict:
    """Add an emotion, or change one (same id and name). An id another emotion has gets the next free one."""
    if not isinstance(b.get("id"), int) or not str(b.get("label", "")).strip() or not str(b.get("feel", "")).strip():
        raise HTTPException(400, "an emotion needs an id, a name and words")
    mine = get_emotions()
    rename = b.pop("rename", False)  # an edit of the emotion with this id: its name may change too
    same = next((x for x in mine if x["id"] == b["id"]), None)
    if same and same["label"] != b["label"] and not rename:  # another page made a different one with this id
        b["id"], same = max([99, *(x["id"] for x in mine)]) + 1, None
    mine = [b if x["id"] == b["id"] else x for x in mine] if same else [*mine, b]
    return {"emotion": b, "emotions": save_emotions(mine)}


@app.delete("/api/emotions/{eid}")
def delete_emotion(eid: int) -> dict:
    return {"emotions": save_emotions([x for x in get_emotions() if x["id"] != eid])}


@app.get("/api/envelope/{name:path}")
def envelope(name: str) -> dict:
    """The original's loudness envelope for the Listen tab, in site/envelopes.py's format (bytes of (dBFS + 60) × 4 per
    bin, base64), so the page reads it the same way; the versions fill in from their renders as they arrive."""
    y, sr = sf.read(str(track_path(name)), dtype="float32", always_2d=True)
    step = max(1, sr // ENVELOPE_RATE)
    bins = -(-len(y) // step)
    pad = np.zeros((bins * step, y.shape[1]), dtype=np.float32)
    pad[: len(y)] = y
    frames = pad.reshape(bins, step, -1)

    def code(v: np.ndarray) -> str:
        db = 20 * np.log10(np.maximum(v, 1e-9))
        return base64.b64encode(np.clip(np.round((db + 60) * 4), 0, 255).astype(np.uint8).tobytes()).decode()

    peak = np.abs(frames).max(axis=(1, 2))
    rms = np.sqrt((frames.astype(np.float64) ** 2).mean(axis=(1, 2)))
    return {"rate": ENVELOPE_RATE, "bins": bins, "versions": {"orig": {"peak": code(peak), "rms": code(rms)}}}


class Transform(BaseModel):
    track: str
    start: float  # s into the track
    prompt: str
    negative: str | None = None  # pushed away from when cfg > 1
    cfg: float = 1.0
    strength: float = 0.5  # σ
    seed: int = 0
    seconds: float | None = None  # render length; the engine's chunk when omitted
    steps: int | None = None  # denoising steps of a full-strength run (the engine's, 8, when omitted); σ 0.85 runs ~half


# ── render cache: every render is kept on disk, so a track can be pre-rendered and then played with no GPU work ──
# A render is fixed by its request (the track file, start, length, texts, cfg, σ, seed) and the engine's settings, so
# those are its key. Stored as Ogg Vorbis (~0.2 MB a chunk instead of ~1.3 MB of WAV: a track pre-rendered
# for all 18 bricks is ~200 MB) and decoded back to WAV on the way out, so a caller can't tell it from a fresh render.
RENDERS = Path(os.environ.get("RENDER_CACHE", HERE / "cache" / "renders"))
CACHE_VERSION = 1
disk = ThreadPoolExecutor(max_workers=2, thread_name_prefix="disk")
live = {"pending": 0}  # requested renders queued or running; a pre-render waits for them


def render_file(r: Transform) -> Path:
    st = track_path(r.track).stat()
    use_cfg = bool(r.negative) and r.cfg != 1
    spec = [CACHE_VERSION, engine.name, r.steps or engine.steps, engine.schedule, engine.match_rms, r.track, st.st_size, int(st.st_mtime),
            round(max(0.0, r.start), 4), latents_for(r.seconds), r.prompt, r.negative if use_cfg else None,
            round(r.cfg, 4) if use_cfg else 1.0, round(min(max(r.strength, 0.05), 1.0), 4), r.seed, 0.0]  # 0.0: no blend
    return RENDERS / Path(r.track).stem / f"{hashlib.blake2b(json.dumps(spec).encode(), digest_size=16).hexdigest()}.ogg"


def read_render(p: Path) -> bytes | None:
    try:
        y, _ = sf.read(str(p), dtype="float32", always_2d=True)
    except (OSError, RuntimeError):
        return None  # unreadable: rendered again
    return wav_bytes(y.T)


def store_render(p: Path, audio: np.ndarray) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f".{p.stem}.part")  # whole or not at all
    sf.write(str(tmp), audio.T, SAMPLE_RATE, format="OGG", subtype="VORBIS", compression_level=0.2)
    os.replace(tmp, p)


def render(r: Transform) -> tuple[np.ndarray, dict]:
    """On the engine's thread."""
    t = time.perf_counter()
    n = latents_for(r.seconds)
    audio = read_segment(str(track_path(r.track)), max(0.0, r.start), n * SAMPLES_PER_LATENT)
    if not state["ready"]:
        return audio, {"total": (time.perf_counter() - t) * 1000, "passthrough": True}
    neg = r.negative if r.cfg != 1 else None
    return engine.transform(audio, r.prompt, r.strength, r.seed, negative=neg, cfg=r.cfg, latents=n, steps=r.steps)


# ── the versions' envelopes, from their renders on disk: the Listen tab asks while a new emotion pre-renders, so its
# lane fills in as the GPU gets through it, not only where the track has been played.
class Chunk(BaseModel):
    version: str  # the brick
    start: float  # s: the stretch of the track this chunk plays alone (its start to the next chunk's)
    span: float
    request: Transform  # the render, as the game asks for it


class Versions(BaseModel):
    duration: float  # s, the track's
    chunks: list[Chunk]


chunk_levels: dict[tuple[Path, int, int], tuple[np.ndarray, np.ndarray]] = {}  # (render file, bins) → peak, rms dB


def levels(f: Path, start: float, b0: int, b1: int) -> tuple[np.ndarray, np.ndarray] | None:
    """Peak and RMS (dBFS) of bins b0..b1 of the track in the render file `f`, which starts at `start` s."""
    key = (f, b0, b1)
    if key not in chunk_levels:
        try:
            y, sr = sf.read(str(f), dtype="float32", always_2d=True)
        except (OSError, RuntimeError):
            return None
        peak, rms = np.full(b1 - b0, -60.0), np.full(b1 - b0, -60.0)
        for j, b in enumerate(range(b0, b1)):
            seg = y[max(0, round((b / ENVELOPE_RATE - start) * sr)):max(0, round(((b + 1) / ENVELOPE_RATE - start) * sr))]
            if len(seg):
                peak[j] = 20 * np.log10(max(float(np.abs(seg).max()), 1e-9))
                rms[j] = 10 * np.log10(max(float(np.mean(seg.astype(np.float64) ** 2)), 1e-18))
        chunk_levels[key] = (peak, rms)
    return chunk_levels[key]


def envelopes_of(q: Versions) -> dict:
    n = math.ceil(q.duration * ENVELOPE_RATE)
    out: dict[str, dict] = {}
    for c in q.chunks:
        v = out.setdefault(c.version, {"peak": np.zeros(n, np.uint8), "rms": np.zeros(n, np.uint8), "have": 0, "total": 0})
        v["total"] += 1
        f = render_file(c.request)
        b0, b1 = max(0, math.ceil(c.start * ENVELOPE_RATE)), min(n, math.floor((c.start + c.span) * ENVELOPE_RATE))
        lv = levels(f, c.request.start, b0, b1) if b1 > b0 and f.is_file() else None
        if lv is None:
            continue
        v["have"] += 1
        for arr, db in zip((v["peak"], v["rms"]), lv):
            arr[b0:b1] = np.clip(np.round((db + 60) * 4), 1, 255)  # 0 is kept for "not rendered yet"
    b64 = lambda a: base64.b64encode(a.tobytes()).decode()  # noqa: E731
    return {"rate": ENVELOPE_RATE, "versions": {k: {"peak": b64(v["peak"]), "rms": b64(v["rms"]), "have": v["have"],
                                                  "total": v["total"]} for k, v in out.items()}}


@app.post("/api/envelopes")
async def version_envelopes(q: Versions) -> dict:
    """Each version's envelope as far as it is on disk (bytes as /api/envelope; 0 = not rendered yet), and how many
    of its chunks are in."""
    return await asyncio.get_running_loop().run_in_executor(disk, envelopes_of, q)


@app.post("/api/transform")
async def transform(r: Transform, request: Request) -> Response:
    track_path(r.track)
    last_request["at"] = time.monotonic()
    loop = asyncio.get_running_loop()
    stored = render_file(r) if state["ready"] else None
    if stored and stored.is_file() and (body := await loop.run_in_executor(disk, read_render, stored)):
        return Response(body, media_type="audio/wav", headers={"X-Render-Ms": "0", "X-Steps": "0", "X-Cached": "disk"})

    # The browser aborts renders when the scene stops; one still queued is dropped instead of computed for nobody
    # (one already running finishes, < 1 s).
    live["pending"] += 1
    try:
        job = mlx.submit(render, r)
        while not job.done():
            if await request.is_disconnected():
                job.cancel()
                return Response(status_code=499)
            await asyncio.sleep(POLL)
        audio, timings = job.result()
    finally:
        live["pending"] -= 1
    if stored and not timings.get("passthrough"):
        disk.submit(store_render, stored, audio)
    headers = {"X-Render-Ms": f"{timings.get('total', 0):.0f}", "X-Steps": str(timings.get("steps_run", 0)),
               "X-Cached": "1" if timings.get("cached") else "0"}
    if timings.get("passthrough"):
        headers["X-Passthrough"] = "1"
    return Response(wav_bytes(audio), media_type="audio/wav", headers=headers)


# ── pre-render: the game hands over every render it could ask for on its track (all bricks × all chunks, in the order
# it will need them, with its current settings), and the engine works through the ones not on disk yet. Two jobs:
#   game:  the playing track. Requested renders go first (one waits at most for the pre-render already on the GPU,
#          < 1 s). It stops when the game says so, when the game replaces it, or when the game stops asking how it is
#          going (closed tab).
#   batch: every track, asked for from the game's panel. It runs only when the game job has nothing left and no render
#          has been asked for in the last few seconds: a game playing (even from disk) is never slowed down by it.
class Prerender(BaseModel):
    track: str
    items: list[Transform]
    batch: bool = False


PRERENDER_HEARTBEAT = 15  # s without a status request: the game has gone, stop its job
BATCH_FILE = RENDERS / "batch.json"  # the batch's list while it runs: a restarted server carries on with it
BATCH_QUIET = 10  # s without a requested render before the batch goes on
prerenders: dict[str, dict | None] = {"game": None, "batch": None}
last_request = {"at": -math.inf}  # time.monotonic() of the last /api/transform


def prerender_view(job: dict | None) -> dict:
    if not job:
        return {"state": "idle"}
    eta = job["left"] * job["msPerRender"] / 1000 if job["msPerRender"] and job["state"] == "running" else None
    track = job["items"][min(job["i"], len(job["items"]) - 1)].track if job["items"] else job["track"]
    tracks = list(dict.fromkeys(r.track for r in job["items"]))
    return {k: job[k] for k in ("state", "total", "done", "rendered", "paused")} | {
        "track": job["track"], "now": track, "trackNo": tracks.index(track) + 1 if track in tracks else 0,
        "tracks": len(tracks), "etaSec": eta}


def next_prerender() -> dict | None:
    """The job whose next item goes on the GPU now, if any."""
    g, b = prerenders["game"], prerenders["batch"]
    if g and g["state"] == "running":
        if time.monotonic() - g["seen"] > PRERENDER_HEARTBEAT:
            g["state"] = "stopped"
        elif g["i"] < len(g["items"]):
            if b and b["state"] == "running":
                b["paused"] = True  # behind the playing track's own pre-render
            return g
        else:
            g["state"] = "done"
    if b and b["state"] == "running":
        if b["i"] >= len(b["items"]):
            b["state"] = "done"
            BATCH_FILE.unlink(missing_ok=True)
            return None
        b["paused"] = time.monotonic() - last_request["at"] < BATCH_QUIET
        return None if b["paused"] else b
    return None


async def prerender_worker() -> None:
    loop = asyncio.get_running_loop()
    while True:
        job = None if live["pending"] or not state["ready"] else next_prerender()
        if not job:
            await asyncio.sleep(0.05 if live["pending"] else 0.25)
            continue
        r, missing = job["items"][job["i"]], job["missing"][job["i"]]
        job["i"] += 1
        job["left"] -= missing
        try:
            stored = render_file(r)
            if not stored.is_file():
                t = time.perf_counter()
                audio, _ = await loop.run_in_executor(mlx, render, r)
                await loop.run_in_executor(disk, store_render, stored, audio)
                ms = (time.perf_counter() - t) * 1000
                job["msPerRender"] = ms if job["msPerRender"] is None else 0.9 * job["msPerRender"] + 0.1 * ms
                job["rendered"] += 1
        except Exception as e:  # a missing track or a failed render: skip it, keep going
            job["errors"] = job.get("errors", 0) + 1
            job["lastError"] = f"{type(e).__name__}: {e}"
        job["done"] += 1


@app.post("/api/prerender")
async def start_prerender(r: Prerender) -> dict:
    slot = "batch" if r.batch else "game"
    if old := prerenders[slot]:
        old["state"] = "replaced" if old["state"] == "running" else old["state"]
    loop = asyncio.get_running_loop()
    if r.batch:
        await loop.run_in_executor(disk, save_batch, r)
    return await begin_prerender(slot, r)


def save_batch(r: Prerender) -> None:
    BATCH_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = BATCH_FILE.with_suffix(".part")
    tmp.write_text(r.model_dump_json())
    os.replace(tmp, BATCH_FILE)


async def resume_batch() -> None:
    """A batch that was running when the server stopped goes on (what is on disk is skipped)."""
    if BATCH_FILE.is_file():
        try:
            r = Prerender.model_validate_json(BATCH_FILE.read_text())
        except ValueError:
            return
        await begin_prerender("batch", r)


async def begin_prerender(slot: str, r: Prerender) -> dict:
    # Which items aren't on disk yet, once (a pass over a whole-corpus batch takes a moment, so not per status request).
    missing = await asyncio.get_running_loop().run_in_executor(disk, lambda: [not render_file(it).is_file() for it in r.items])
    job = prerenders[slot] = {"track": r.track, "state": "running", "items": r.items, "missing": missing, "left": sum(missing),
                              "i": 0, "total": len(r.items), "done": 0, "rendered": 0, "msPerRender": None,
                              "seen": time.monotonic(), "paused": False}
    return prerender_view(job)


@app.get("/api/prerender")
def prerender_status() -> dict:
    if job := prerenders["game"]:
        job["seen"] = time.monotonic()
    return {"game": prerender_view(prerenders["game"]), "batch": prerender_view(prerenders["batch"])}


@app.delete("/api/prerender")
def stop_prerender(batch: bool = False) -> dict:
    if (job := prerenders["batch" if batch else "game"]) and job["state"] == "running":
        job["state"] = "stopped"
    if batch:
        BATCH_FILE.unlink(missing_ok=True)
    return prerender_view(job)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT)
