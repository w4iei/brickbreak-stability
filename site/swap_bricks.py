#!/usr/bin/env python3
"""Replace a pair of the site palette's emotions with a new pair (each pushed away from the other), or add a pair.

    python3 site/swap_bricks.py new_pair.json
new_pair.json: {"replace": [old dark id, old light id], "bricks": [dark brick, light brick]}, each brick as in
src/palettes.json (id, label, pole, note, color, prompt, feel, listen); their opposites are set to each other. In place,
so the row keeps its order (dark | ORIGINAL | light). Without "replace" the pair is added: the dark brick just left of
ORIGINAL, the light one just right of it.

Then, with the server running, site/export.py renders what is missing (the requests follow from the palette) and drops
the files of bricks no longer in it, and site/envelopes.py redraws the Listen tab's envelopes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

PALETTES = Path(__file__).resolve().parent.parent / "src" / "palettes.json"


def main() -> None:
    spec = json.loads(Path(sys.argv[1]).read_text())
    old, (dark, light) = spec.get("replace", []), spec["bricks"]
    dark["opposite"], light["opposite"] = light["id"], dark["id"]
    palettes = json.loads(PALETTES.read_text())
    bricks = palettes["site"]["bricks"]
    at = {b["id"]: i for i, b in enumerate(bricks)}
    if any(b["id"] in at and b["id"] not in old for b in (dark, light)):
        raise SystemExit("a new brick's id is already in the palette")
    if old:
        for o, b in zip(old, (dark, light)):
            bricks[at[o]] = b
    else:
        i = next(i for i, b in enumerate(bricks) if b.get("original"))
        bricks[i:i + 1] = [dark, bricks[i], light]
    PALETTES.write_text(json.dumps(palettes, indent=2, ensure_ascii=False) + "\n")
    print("site palette:", [b["label"] for b in bricks])


if __name__ == "__main__":
    main()
