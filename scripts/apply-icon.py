#!/usr/bin/env python3
"""Install assets/icon.png as the Android launcher icon.

Run after `cap add android` (the android/ project is generated in CI, not
committed). Writes ic_launcher / ic_launcher_round / ic_launcher_foreground
PNGs at every density, and removes the template's adaptive-icon XML so the
full-bleed artwork is used as-is instead of the default Capacitor glyph.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

SIZES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

def main(res: Path, src: Path) -> None:
    icon = Image.open(src).convert("RGBA")
    for d in res.glob("mipmap-anydpi*"):
        for f in d.glob("ic_launcher*.xml"):
            f.unlink()
    for dens, px in SIZES.items():
        out = res / f"mipmap-{dens}"
        out.mkdir(parents=True, exist_ok=True)
        sq = icon.resize((px, px), Image.LANCZOS)
        sq.save(out / "ic_launcher.png")
        sq.save(out / "ic_launcher_foreground.png")
        big = icon.resize((px * 4, px * 4), Image.LANCZOS)
        mask = Image.new("L", big.size, 0)
        ImageDraw.Draw(mask).ellipse((0, 0, big.size[0] - 1, big.size[1] - 1), fill=255)
        big.putalpha(mask)
        big.resize((px, px), Image.LANCZOS).save(out / "ic_launcher_round.png")

if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    main(root / "android/app/src/main/res", root / "assets/icon.png")
