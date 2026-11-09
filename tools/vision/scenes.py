"""Escenas de prueba punta a punta: una o dos cartas giradas sobre una mesa; guarda RGBA crudo y las etiquetas."""
import json, random, sys, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import synth

def main(out_dir: str, n: int) -> None:
    os.makedirs(out_dir, exist_ok=True)
    rng = random.Random(4242)
    labels = []
    for i in range(n):
        table = rng.choice([(22, 60, 38), (20, 20, 24), (70, 45, 30), (40, 50, 90)])
        im = Image.new("RGB", (640, 400), table)
        k = rng.choice([1, 1, 2])
        spots = [(60, 40), (360, 60)] if k == 2 else [(220, 60)]
        lab = []
        for x, y in spots:
            r, s = rng.randrange(13), rng.randrange(4)
            card = synth.render_card(synth.RANKS[r], synth.SUITS[s], rng).resize((150, 210))
            mask = Image.new("L", card.size, 0)
            ImageDraw.Draw(mask).rounded_rectangle((0, 0, 149, 209), radius=10, fill=255)
            rgba = card.convert("RGBA"); rgba.putalpha(mask)
            rot = rgba.rotate(rng.uniform(-35, 35) + rng.choice([0, 0, 180]), expand=True, resample=Image.BICUBIC)
            im.paste(rot, (x, y), rot)
            lab.append(synth.RANKS[r].replace("10", "T") + synth.SUITS[s])
        im = im.filter(ImageFilter.GaussianBlur(rng.uniform(0, 1.0)))
        arr = np.asarray(im.convert("RGBA"))
        arr = np.clip(arr.astype(np.float32) * rng.uniform(0.7, 1.15), 0, 255).astype(np.uint8)
        open(f"{out_dir}/{i}.rgba", "wb").write(arr.tobytes())
        labels.append(sorted(lab))
    json.dump(labels, open(f"{out_dir}/labels.json", "w"))

main(sys.argv[1], int(sys.argv[2]))
