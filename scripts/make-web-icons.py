#!/usr/bin/env python3
"""Small web renditions of the Runout logo (assets/logo.png): favicon, apple-touch icon and the in-app mark.

The logo is only resized (Lanczos), never recoloured or re-framed. Outputs are committed under assets/ and shipped
to www/ by scripts/build-web.mjs (WEB_ASSETS), so index.html can link them by relative URL.

  python3 scripts/make-web-icons.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = {"favicon-32.png": 32, "apple-touch-icon.png": 180, "icon-192.png": 192}

def main():
    src = Image.open(ROOT / "assets" / "logo.png").convert("RGBA")
    for name, px in OUT.items():
        src.resize((px, px), Image.LANCZOS).convert("RGB").save(ROOT / "assets" / name, optimize=True)
        print("wrote assets/" + name)

if __name__ == "__main__":
    main()
