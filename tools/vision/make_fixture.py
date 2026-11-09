"""Genera la imagen de prueba para el e2e: dos cartas sobre una mesa oscura (Rey de picas y 10 de diamantes)."""
import random
import sys

from PIL import Image, ImageDraw

import synth


def main(out: str) -> None:
    rng = random.Random(7)
    table = Image.new("RGB", (640, 400), (22, 60, 38))
    for rank, suit, x, y, angle in (("K", "s", 120, 40, 8), ("10", "d", 380, 60, -12)):
        card = synth.render_card(rank, suit, rng).resize((150, 210))
        mask = Image.new("L", card.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, 149, 209), radius=10, fill=255)
        rgba = card.convert("RGBA")
        rgba.putalpha(mask)
        rot = rgba.rotate(angle, expand=True, resample=Image.BICUBIC)
        table.paste(rot, (x, y), rot)
    table.save(out)


if __name__ == "__main__":
    main(sys.argv[1])
