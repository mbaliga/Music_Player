#!/usr/bin/env python3
"""Install the Runout logo (assets/logo.png) as the Android launcher icon.

Run after `cap add android` (the android/ project is generated in CI, not
committed). The logo is an orange frame around a dark box carrying the striped
R. Launchers mask icons (circle, squircle, rounded square), and a mask cuts
into any artwork that reaches the corners, so the dark box is scaled down and
the orange frame is rebuilt as the background:

  * adaptive icon (API 26+): background colour = the logo orange, foreground =
    the dark box sized to stay inside the 66 dp safe circle of the 108 dp canvas;
  * legacy square icon: orange field, box at 80% of the canvas;
  * legacy round icon: orange disc, box at 64% so its corners clear the circle.

Also writes assets/icon.png (1024, box at 80%) for the Play listing and web use.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
BOX_ADAPTIVE = 48 / 108   # box width as a share of the adaptive canvas (safe zone is 66 dp)
BOX_SQUARE = 0.80
BOX_ROUND = 0.64


def load(src: Path):
    logo = Image.open(src).convert("RGB")
    orange = logo.getpixel((4, 4))
    px = logo.load()
    xs, ys = [], []
    for y in range(logo.height):
        for x in range(logo.width):
            if sum(px[x, y]) < 150:
                xs.append(x); ys.append(y)
    box = logo.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))
    return box, orange


def compose(size, box, share, bg, round_=False, transparent=False):
    ss = 4  # supersample for clean edges
    n = size * ss
    mode = "RGBA"
    canvas = Image.new(mode, (n, n), (0, 0, 0, 0) if transparent else bg + (255,))
    w = int(n * share)
    h = int(w * box.height / box.width)
    canvas.paste(box.resize((w, h), Image.LANCZOS).convert("RGBA"), ((n - w) // 2, (n - h) // 2))
    if round_:
        mask = Image.new("L", (n, n), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, n - 1, n - 1), fill=255)
        canvas.putalpha(mask)
    return canvas.resize((size, size), Image.LANCZOS)


def main(res: Path, src: Path, assets: Path) -> None:
    box, orange = load(src)
    hexcolor = "#%02X%02X%02X" % orange
    (res / "values").mkdir(parents=True, exist_ok=True)
    (res / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">{hexcolor}</color>\n</resources>\n')
    for dens, px in ADAPTIVE.items():
        out = res / f"mipmap-{dens}"; out.mkdir(parents=True, exist_ok=True)
        compose(px, box, BOX_ADAPTIVE, orange, transparent=True).save(out / "ic_launcher_foreground.png")
    for dens, px in LEGACY.items():
        out = res / f"mipmap-{dens}"; out.mkdir(parents=True, exist_ok=True)
        compose(px, box, BOX_SQUARE, orange).save(out / "ic_launcher.png")
        compose(px, box, BOX_ROUND, orange, round_=True).save(out / "ic_launcher_round.png")
    assets.mkdir(parents=True, exist_ok=True)
    compose(1024, box, BOX_SQUARE, orange).convert("RGB").save(assets / "icon.png")


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    main(root / "android/app/src/main/res", root / "assets/logo.png", root / "assets")
