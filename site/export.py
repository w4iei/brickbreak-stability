#!/usr/bin/env python3
"""Export the public site's audio: each track in site/tracks.json and its render for every emotion in the site palette
(src/palettes.json 'site'), as AAC (.m4a, what iPhones decode natively), plus manifest.json with each track's beat
grid. The site has no model and no server: the game fetches renders/<slug>/<brick>-<k>.m4a directly, and the original
in 8.5 s chunks (renders/<slug>/orig-<k>.m4a, one every 8 s) so it can start before the whole song has loaded.

The renders come from the local audio server (server/server.py, running), asked for exactly as the game asks for them
at the site's settings (SETTINGS: intensity 0.5 → σ 0.75, push 2.5, 'source' prompts, seed = brick × 1000 + k), so a
track already played or pre-rendered offline is mostly on the server's disk already. Each track needs its analysis
(analysis/analyze.py) for its bars, tempo and sound tags.

    python3 site/export.py          # from the repo root, with the server running
Writes site/public/audio/. Then site/envelopes.py, for the Listen tab's envelopes.
"""
from __future__ import annotations

import io
import json
import math
import urllib.parse
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "public" / "audio"
SERVER = "http://127.0.0.1:8765"
SETTINGS = {"intensity": 0.5, "push": 2.5, "style": "source"}  # as the game's defaults (src/main.ts)
SITE = json.loads((ROOT / "src" / "palettes.json").read_text())["site"]["bricks"]
EMOTIONS = [b for b in SITE if not b.get("original")]  # the palette's ORIGINAL brick is the original chunks
RENDER_KBPS, ORIG_KBPS = 160, 192
DRY_HOP, DRY_LENGTH = 8, 8.5  # s: the original's chunks (player.ts DRY), streamed instead of the whole song
CHUNK_BARS, CHUNK_OVERLAP = 4, 0.5  # renders: 4 bars from the first downbeat, 0.5 s past the next (player.ts)
MIN_P = {"genre": 0.1, "ensemble": 0.1, "vocals": 0.1, "instrument": 0.25}  # as prompts.ts
SOURCE_TAGS = 3


def strength(intensity: float) -> float:
    return 0.62 + 0.26 * intensity  # src/audio/dial.ts


def describe_source(a: dict) -> str:
    """What the track already is, from its analysis: its surest sound tags and its tempo (src/prompts.ts)."""
    m, parts = a.get("tagMatrix"), []
    if m and m["p"]:
        mean = [sum(row[j] for row in m["p"]) / len(m["p"]) for j in range(len(m["tags"]))]
        tags = sorted((t for t in zip(m["tags"], mean, m["cats"]) if t[2] in MIN_P and t[1] >= MIN_P[t[2]]), key=lambda t: -t[1])
        parts += [t[0] for t in tags[:SOURCE_TAGS]]
    if a.get("tempo"):
        parts.append(f"{math.floor(a['tempo'] + 0.5)} BPM")
    return ", ".join(parts)


def requests_for(name: str, seconds: float, a: dict) -> list[dict]:
    """Every render the game could ask for on this track (player.ts requestOf / itemsOf), brick by brick."""
    bars = a["downbeats"]
    bar = (bars[-1] - bars[0]) / (len(bars) - 1)
    origin, hop, length = bars[0], CHUNK_BARS * bar, CHUNK_BARS * bar + CHUNK_OVERLAP
    source = describe_source(a)
    on = lambda feel: f"{source}, {feel}" if source else feel
    chunks = math.ceil((seconds - origin) / hop)
    out = []
    for b in EMOTIONS:
        opp = next((o for o in SITE if o["id"] == b["opposite"]), None)
        for k in range(chunks):
            out.append({"track": name, "start": origin + k * hop, "seconds": length, "prompt": on(b["feel"]),
                        "negative": (on(opp["feel"]) if opp else "") if SETTINGS["push"] > 1 else None,
                        "cfg": SETTINGS["push"], "strength": strength(SETTINGS["intensity"]), "seed": b["id"] * 1000 + k})
    return out


def get(path: str) -> bytes:
    with urllib.request.urlopen(SERVER + path, timeout=600) as r:
        return r.read()


def post(path: str, body: dict) -> bytes:
    req = urllib.request.Request(SERVER + path, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read()


def aac(wav: bytes, out: Path, kbps: int) -> None:
    import subprocess

    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "wav", "-i", "pipe:0", "-c:a", "aac",
                    "-b:a", f"{kbps}k", "-movflags", "+faststart", str(out)], input=wav, check=True)


def main() -> None:
    manifest = {"settings": {**SETTINGS, "sigma": strength(SETTINGS["intensity"])}, "tracks": []}
    ids = {b["id"] for b in EMOTIONS}
    for t in json.loads((HERE / "tracks.json").read_text())["tracks"]:
        name = t["file"]
        body = get("/api/analysis/" + urllib.parse.quote(name))
        if not body:
            raise SystemExit(f"{name}: no analysis yet (uv run --project analysis python analysis/analyze.py tracks/...)")
        a = json.loads(body)
        with wave.open(io.BytesIO(get("/api/tracks/" + urllib.parse.quote(name)))) as w:
            total, rate = w.getnframes(), w.getframerate()
        items = requests_for(name, total / rate, a)
        meta = {k: t[k] for k in ("slug", "title", "artist", "artistUrl") if k in t}
        manifest["tracks"].append({
            **meta, "name": name, "frames": total,
            "tempo": a.get("tempo"), "beats": [round(b, 4) for b in a["beats"]],
            "downbeats": [round(b, 4) for b in a["downbeats"]],
            "source": describe_source(a),
            "chunks": 1 + max(it["seed"] % 1000 for it in items),
        })
        print(f"{t['title']}: {len(items)} renders", flush=True)
        folder = OUT / "renders" / t["slug"]

        def one(it: dict) -> None:
            brick, k = divmod(it["seed"], 1000)
            out = folder / f"{brick}-{k}.m4a"
            if not out.exists():
                aac(post("/api/transform", it), out, RENDER_KBPS)

        def orig(k: int) -> None:
            out = folder / f"orig-{k}.m4a"
            if not out.exists():
                q = urllib.parse.urlencode({"track": name, "start": k * DRY_HOP, "seconds": DRY_LENGTH})
                aac(get("/api/excerpt?" + q), out, ORIG_KBPS)

        if folder.is_dir():
            for f in folder.glob("*.m4a"):  # renders of bricks the site no longer has
                if not f.name.startswith("orig-") and int(f.stem.split("-")[0]) not in ids:
                    f.unlink()
        with ThreadPoolExecutor(6) as pool:
            list(pool.map(one, items))
            list(pool.map(orig, range(-(-total // (DRY_HOP * rate)))))
        print(f"  {len(list(folder.glob('orig-*.m4a')))} original chunks", flush=True)
    (OUT / "manifest.json").write_text(json.dumps(manifest))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
