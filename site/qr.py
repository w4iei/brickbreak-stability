#!/usr/bin/env python3
"""The site's share QR code (the menu's Share card): site/public/qr.svg, to https://klavecimbel.com/brickbreak/.

    uv run --with segno python3 site/qr.py
"""
from pathlib import Path

import segno

HERE = Path(__file__).resolve().parent
URL = "https://klavecimbel.com/brickbreak/"

segno.make(URL, error="m").save(HERE / "public" / "qr.svg", kind="svg", scale=1, border=2, dark="#0b0d10", light="#ffffff",
                                xmldecl=False, omitsize=True)
print("wrote", HERE / "public" / "qr.svg")
