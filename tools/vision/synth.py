"""Genera esquinas de cartas sintéticas (índice: valor + palo) con aumentos para entrenar el clasificador.

Una muestra es la esquina superior izquierda de una carta rectificada, de 40x56 px, con su valor (0..12) y palo (0..3).
Se renderizan cartas completas con fuentes libres (DejaVu, Liberation), con y sin cuatro colores, y se degradan con
perspectiva, giro, luz, desenfoque, ruido y compresión JPEG.
"""
from __future__ import annotations

import io
import random

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
SUITS = ["s", "h", "d", "c"]  # picas, corazones, diamantes, tréboles
GLYPH = {"s": "♠", "h": "♥", "d": "♦", "c": "♣"}
W, H = 200, 280
OUT_W, OUT_H = 40, 56

FONT_DIR = "/usr/share/fonts/truetype"
FONTS = [
    f"{FONT_DIR}/dejavu/DejaVuSans-Bold.ttf",
    f"{FONT_DIR}/dejavu/DejaVuSans.ttf",
    f"{FONT_DIR}/dejavu/DejaVuSerif-Bold.ttf",
    f"{FONT_DIR}/liberation/LiberationSans-Bold.ttf",
    f"{FONT_DIR}/liberation/LiberationSans-Regular.ttf",
    f"{FONT_DIR}/liberation/LiberationSerif-Bold.ttf",
    f"{FONT_DIR}/liberation/LiberationSerif-Regular.ttf",
]
SUIT_FONTS = FONTS[:3] + [FONTS[3]]
_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    key = (path, size)
    if key not in _cache:
        _cache[key] = ImageFont.truetype(path, size)
    return _cache[key]


def suit_color(suit: str, four: bool, rng: random.Random) -> tuple[int, int, int]:
    jitter = rng.randint(-25, 25)
    if four:
        base = {"s": (20, 20, 20), "h": (200, 20, 30), "d": (20, 70, 190), "c": (20, 130, 50)}[suit]
    else:
        base = (200, 20, 30) if suit in "hd" else (20, 20, 20)
    return tuple(max(0, min(255, c + jitter)) for c in base)  # type: ignore[return-value]


def render_card(rank: str, suit: str, rng: random.Random) -> Image.Image:
    bg = rng.choice([(255, 255, 255), (250, 248, 240), (245, 245, 250), (252, 250, 235)])
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    four = rng.random() < 0.2
    color = suit_color(suit, four, rng)
    rf = rng.choice(FONTS)
    sf = rng.choice(SUIT_FONTS)
    rsize = rng.randint(34, 52) if rank != "10" else rng.randint(30, 44)
    ssize = rng.randint(30, 46)
    ox = rng.randint(8, 18)
    oy = rng.randint(6, 16)
    f = font(rf, rsize)
    tw = d.textlength(rank, font=f)
    cx = ox + max(tw, ssize * 0.8) / 2
    d.text((cx - tw / 2, oy), rank, font=f, fill=color)
    g = font(sf, ssize)
    gw = d.textlength(GLYPH[suit], font=g)
    d.text((cx - gw / 2, oy + rsize + rng.randint(0, 6)), GLYPH[suit], font=g, fill=color)
    # Índice opuesto (giro de 180°), igual que en un mazo real.
    flipped = img.crop((0, 0, int(W * 0.36), int(H * 0.42))).rotate(180)
    img.paste(flipped, (W - flipped.width, H - flipped.height))
    # Centro: pips grandes o recuadro de figura, solo para ensuciar el fondo de la esquina.
    mid = font(sf, rng.randint(50, 80))
    if rank in ("J", "Q", "K"):
        d.rectangle((W * 0.25, H * 0.2, W * 0.75, H * 0.8), outline=color, width=3,
                    fill=rng.choice([(235, 200, 120), (200, 160, 220), (160, 200, 220)]))
    else:
        for _ in range(rng.randint(1, 6)):
            d.text((rng.randint(int(W * 0.3), int(W * 0.6)), rng.randint(int(H * 0.2), int(H * 0.6))), GLYPH[suit], font=mid, fill=color)
    return img


def rounded_on_table(card: Image.Image, rng: random.Random) -> Image.Image:
    """Pone la carta (con esquinas redondeadas) sobre una mesa de color con un margen aleatorio."""
    m = rng.randint(0, 22)
    table = rng.choice([(30, 90, 50), (20, 20, 20), (120, 80, 50), (200, 200, 205), (60, 60, 120), (150, 40, 40)])
    canvas = Image.new("RGB", (W + 2 * m, H + 2 * m), table)
    mask = Image.new("L", card.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, W - 1, H - 1), radius=rng.randint(8, 16), fill=255)
    canvas.paste(card, (m, m), mask)
    return canvas


def degrade(img: Image.Image, rng: random.Random) -> Image.Image:
    w, h = img.size
    j = lambda s: rng.uniform(-s, s)  # noqa: E731
    pts = [(j(0.04) * w, j(0.04) * h), (w + j(0.04) * w, j(0.04) * h), (w + j(0.04) * w, h + j(0.04) * h), (j(0.04) * w, h + j(0.04) * h)]
    quad = (pts[0][0], pts[0][1], pts[3][0], pts[3][1], pts[2][0], pts[2][1], pts[1][0], pts[1][1])
    img = img.transform((w, h), Image.QUAD, quad, resample=Image.BICUBIC)
    img = img.rotate(j(6), resample=Image.BICUBIC, fillcolor=(40, 40, 40))
    # Quita el margen (la detección real recorta cerca del borde de la carta).
    crop = rng.randint(0, 10)
    img = img.crop((crop, crop, w - crop, h - crop))
    if rng.random() < 0.7:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0, 1.6)))
    img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.55, 1.35))
    img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.6, 1.3))
    img = ImageEnhance.Color(img).enhance(rng.uniform(0.6, 1.3))
    a = np.asarray(img).astype(np.float32)
    a *= np.array([rng.uniform(0.85, 1.12), rng.uniform(0.85, 1.12), rng.uniform(0.85, 1.12)], dtype=np.float32)
    # Degradado de luz/sombra.
    gx = np.linspace(rng.uniform(0.7, 1.1), rng.uniform(0.7, 1.1), a.shape[1], dtype=np.float32)
    a *= gx[None, :, None]
    a += np.random.default_rng(rng.randint(0, 2**31)).normal(0, rng.uniform(0, 8), a.shape).astype(np.float32)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    if rng.random() < 0.5:
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=rng.randint(35, 90))
        img = Image.open(io.BytesIO(buf.getvalue())).convert("RGB")
    return img


def corner(img: Image.Image, rng: random.Random) -> np.ndarray:
    """Recorta la esquina superior izquierda con un pequeño desplazamiento y la deja en 40x56."""
    w, h = img.size
    dx, dy = rng.uniform(-0.03, 0.05) * w, rng.uniform(-0.03, 0.05) * h
    x0, y0 = max(0.0, dx), max(0.0, dy)
    box = (x0, y0, x0 + 0.34 * w, y0 + 0.40 * h)
    c = img.crop(tuple(int(v) for v in box)).resize((OUT_W, OUT_H), Image.BILINEAR)
    return np.asarray(c, dtype=np.uint8)


def sample(seed: int) -> tuple[np.ndarray, int, int]:
    rng = random.Random(seed)
    r = rng.randrange(13)
    s = rng.randrange(4)
    card = render_card(RANKS[r], SUITS[s], rng)
    img = degrade(rounded_on_table(card, rng), rng)
    return corner(img, rng), r, s


def build(n: int, seed0: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    xs = np.empty((n, OUT_H, OUT_W, 3), np.uint8)
    rs = np.empty(n, np.int64)
    ss = np.empty(n, np.int64)
    for i in range(n):
        xs[i], rs[i], ss[i] = sample(seed0 + i)
    return xs, rs, ss
