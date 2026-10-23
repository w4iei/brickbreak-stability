#!/usr/bin/env python3
"""The site's link-preview image (WhatsApp, iMessage, socials): site/public/og.png, 1200 × 630, the site palette's
bricks as the game draws them (neon: dark tiles, outlines and labels in each colour, the lit one filled and glowing),
the ball with its halo and trail, the title and the credits.

    uv run --with pillow python site/og_image.py         # from the repo root
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
W, H = 1200, 630
BG = (11, 13, 16)
FONT = "/System/Library/Fonts/HelveticaNeue.ttc"


def font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size, index=1 if bold else 0)


def rgb(hex_: str) -> tuple[int, int, int]:
    return tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5))


def lum(c: tuple[int, int, int]) -> float:
    r, g, b = (v / 255 for v in c)
    return 0.2126 * r ** 2.2 + 0.7152 * g ** 2.2 + 0.0722 * b ** 2.2


def mix(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def neon(c):  # as render.ts: dark colours lifted towards white so they glow on the board
    return mix(c, (255, 255, 255), max(0.0, 0.2 - lum(c)) / 0.2 * 0.5)


def glow(img, draw, radius, times=1):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw(ImageDraw.Draw(layer))
    layer = layer.filter(ImageFilter.GaussianBlur(radius))
    for _ in range(times):
        img.alpha_composite(layer)


bricks = json.loads((HERE.parent / "src" / "palettes.json").read_text())["site"]["bricks"]
LIT = next(i for i, b in enumerate(bricks) if b["label"] == "RAGE")
img = Image.new("RGBA", (W, H), (*BG, 255))
d = ImageDraw.Draw(img)

d.text((70, 62), "BRICK BREAKER × STABLE AUDIO", font=font(58), fill=(238, 242, 246))
d.text((72, 140), "Music by Yana Kunakbaeva  ·  Demo by Noah Jaffe", font=font(30, bold=False), fill=(150, 162, 174))

# The row of bricks, labels running up them as in the game, all one size.
x0, y0, bw, bh, gap, rad, line = 70, 220, 140, 230, 16, 24, 6
size = 34
while max(font(size).getlength(b["label"]) for b in bricks) > bh * 0.8:
    size -= 1
for i, b in enumerate(bricks):
    x = x0 + i * (bw + gap)
    c, box = rgb(b["color"]), (x, y0, x + bw, y0 + bh)
    vivid = neon(c)
    if i == LIT:
        glow(img, lambda g: g.rounded_rectangle(box, rad, fill=(*vivid, 255)), 26, 2)
    ImageDraw.Draw(img).rounded_rectangle(box, rad, fill=(*(c if i == LIT else mix(BG, c, 0.16)), 255), outline=(*vivid, 255), width=line)
    text = ((18, 20, 23) if lum(c) > 0.3 else (255, 255, 255)) if i == LIT else vivid
    label = Image.new("RGBA", (bh, bw), (0, 0, 0, 0))
    ImageDraw.Draw(label).text((bh / 2, bw / 2), b["label"], font=font(size), fill=(*text, 255), anchor="mm")
    label = label.rotate(90, expand=True)
    img.alpha_composite(label, (x, y0))

# Ball (white, a halo and a trail in the lit brick's colour) and the paddle (rounded, a faint halo).
tint, (bx, by) = neon(rgb(bricks[LIT]["color"])), (640, 470)
for k in range(12, 0, -1):
    fade = 1 - k / 13
    r = 13 * (0.3 + 0.7 * fade)
    px, py = bx + k * 9, by + k * 12
    glow(img, lambda g: g.ellipse((px - r, py - r, px + r, py + r), fill=(*tint, round(230 * fade ** 1.2))), 4)
glow(img, lambda g: g.ellipse((bx - 30, by - 30, bx + 30, by + 30), fill=(*tint, 255)), 12, 2)
ImageDraw.Draw(img).ellipse((bx - 14, by - 14, bx + 14, by + 14), fill=(255, 255, 255))
paddle = (470, 560, 730, 578)
glow(img, lambda g: g.rounded_rectangle(paddle, 9, fill=(220, 232, 245, 150)), 12)
ImageDraw.Draw(img).rounded_rectangle(paddle, 9, fill=(240, 244, 248))
img = img.convert("RGB")

out = HERE / "public" / "og.png"
img.save(out, optimize=True)
print(out, out.stat().st_size // 1024, "KB")
