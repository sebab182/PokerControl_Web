"""Entrena el clasificador de esquinas de cartas (JAX, CPU) y lo exporta a ONNX.

Uso:  python3 train.py [--n 48000] [--epochs 14] [--out ../../apps/web/public/models/card-corner.onnx]
Entrada: RGB 40x56 en 0..1 (NCHW). Salidas: logits de valor (13) y de palo (4).
Red: 4 bloques conv3x3+ReLU (con MaxPool 2x2 tras los tres primeros) y dos cabezas lineales. Sin BatchNorm,
así el grafo ONNX queda en Conv/Relu/MaxPool/Gemm.
"""
from __future__ import annotations

import argparse
import multiprocessing as mp
import time
from functools import partial

import jax
import jax.numpy as jnp
import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

import synth

CH = [3, 24, 48, 96, 128]
FEAT = 128 * 7 * 5


def _chunk(args: tuple[int, int]):
    return synth.build(args[1], args[0])


def make(n: int, seed0: int):
    parts = 8
    per = n // parts
    with mp.Pool(4) as p:
        out = p.map(_chunk, [(seed0 + i * per, per) for i in range(parts)])
    return tuple(np.concatenate(z) for z in zip(*out))


def init(key):
    params = {}
    ks = jax.random.split(key, 8)
    for i in range(4):
        fan = CH[i] * 9
        params[f"c{i}w"] = jax.random.normal(ks[i], (CH[i + 1], CH[i], 3, 3)) * np.sqrt(2.0 / fan)
        params[f"c{i}b"] = jnp.zeros(CH[i + 1])
    params["rw"] = jax.random.normal(ks[5], (13, FEAT)) * np.sqrt(1.0 / FEAT)
    params["rb"] = jnp.zeros(13)
    params["sw"] = jax.random.normal(ks[6], (4, FEAT)) * np.sqrt(1.0 / FEAT)
    params["sb"] = jnp.zeros(4)
    return params


def conv(x, w, b):
    y = jax.lax.conv_general_dilated(x, w, (1, 1), "SAME", dimension_numbers=("NCHW", "OIHW", "NCHW"))
    return y + b[None, :, None, None]


def pool(x):
    # Igual que ONNX MaxPool 2x2 stride 2 sin relleno: descarta la fila/columna sobrante.
    n, c, h, w = x.shape
    x = x[:, :, : h // 2 * 2, : w // 2 * 2]
    return x.reshape(n, c, h // 2, 2, w // 2, 2).max(axis=(3, 5))


def forward(params, x, key=None, drop=0.0):
    h = x
    for i in range(4):
        h = jax.nn.relu(conv(h, params[f"c{i}w"], params[f"c{i}b"]))
        if i < 3:
            h = pool(h)
    h = h.reshape(h.shape[0], -1)
    if key is not None and drop > 0:
        h = h * jax.random.bernoulli(key, 1 - drop, h.shape) / (1 - drop)
    return h @ params["rw"].T + params["rb"], h @ params["sw"].T + params["sb"]


def loss_fn(params, x, r, s, key):
    lr, ls = forward(params, x, key, 0.3)
    def ce(lg, y, k):
        oh = jax.nn.one_hot(y, k) * 0.95 + 0.05 / k
        return -(oh * jax.nn.log_softmax(lg)).sum(-1).mean()
    return ce(lr, r, 13) + ce(ls, s, 4)


def adam_update(params, grads, m, v, t, lr):
    b1, b2 = 0.9, 0.999
    m = jax.tree.map(lambda a, g: b1 * a + (1 - b1) * g, m, grads)
    v = jax.tree.map(lambda a, g: b2 * a + (1 - b2) * g * g, v, grads)
    new = jax.tree.map(lambda p, a, b: p - lr * (a / (1 - b1 ** t)) / (jnp.sqrt(b / (1 - b2 ** t)) + 1e-8), params, m, v)
    return new, m, v


@jax.jit
def step(params, m, v, t, lr, x, r, s, key):
    loss, grads = jax.value_and_grad(loss_fn)(params, x, r, s, key)
    params, m, v = adam_update(params, grads, m, v, t, lr)
    return params, m, v, loss


@jax.jit
def predict(params, x):
    return forward(params, x)


def prep(x):
    return jnp.asarray(x).transpose(0, 3, 1, 2).astype(jnp.float32) / 255.0


def evaluate(params, x, r, s):
    ok_r = ok_s = ok_c = 0
    for i in range(0, len(x), 500):
        lr, ls = predict(params, prep(x[i:i + 500]))
        pr, ps = np.asarray(lr.argmax(1)), np.asarray(ls.argmax(1))
        rr, ss = r[i:i + 500], s[i:i + 500]
        ok_r += int((pr == rr).sum()); ok_s += int((ps == ss).sum()); ok_c += int(((pr == rr) & (ps == ss)).sum())
    n = len(x)
    return ok_r / n, ok_s / n, ok_c / n


def to_onnx(params, out: str) -> None:
    nodes, inits = [], []
    prev = "x"
    for i in range(4):
        inits += [numpy_helper.from_array(np.asarray(params[f"c{i}w"], np.float32), f"c{i}w"), numpy_helper.from_array(np.asarray(params[f"c{i}b"], np.float32), f"c{i}b")]
        nodes.append(helper.make_node("Conv", [prev, f"c{i}w", f"c{i}b"], [f"c{i}"], kernel_shape=[3, 3], pads=[1, 1, 1, 1]))
        nodes.append(helper.make_node("Relu", [f"c{i}"], [f"r{i}"]))
        prev = f"r{i}"
        if i < 3:
            nodes.append(helper.make_node("MaxPool", [prev], [f"p{i}"], kernel_shape=[2, 2], strides=[2, 2]))
            prev = f"p{i}"
    nodes.append(helper.make_node("Flatten", [prev], ["flat"], axis=1))
    for name, out_name in (("r", "rank"), ("s", "suit")):
        inits += [numpy_helper.from_array(np.asarray(params[f"{name}w"], np.float32), f"{name}w"), numpy_helper.from_array(np.asarray(params[f"{name}b"], np.float32), f"{name}b")]
        nodes.append(helper.make_node("Gemm", ["flat", f"{name}w", f"{name}b"], [out_name], transB=1))
    graph = helper.make_graph(
        nodes, "card_corner",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, ["n", 3, 56, 40])],
        [helper.make_tensor_value_info("rank", TensorProto.FLOAT, ["n", 13]), helper.make_tensor_value_info("suit", TensorProto.FLOAT, ["n", 4])],
        inits)
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    onnx.save(model, out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=48000)
    ap.add_argument("--epochs", type=int, default=14)
    ap.add_argument("--out", default="../../apps/web/public/models/card-corner.onnx")
    a = ap.parse_args()
    t0 = time.time()
    x, r, s = make(a.n, 1_000_000)
    xt, rt, st = make(4000, 9_000_000)  # prueba con semillas distintas a las de entrenamiento
    print(f"datos listos en {time.time() - t0:.0f}s", flush=True)
    key = jax.random.PRNGKey(0)
    params = init(key)
    m = jax.tree.map(jnp.zeros_like, params)
    v = jax.tree.map(jnp.zeros_like, params)
    bs = 128
    per = len(x) // bs
    total = a.epochs * per
    t = 0
    for ep in range(a.epochs):
        perm = np.random.default_rng(ep).permutation(len(x))
        for i in range(per):
            idx = perm[i * bs:(i + 1) * bs]
            t += 1
            # Tasa de aprendizaje: calentamiento corto y bajada coseno.
            lr = 2e-3 * min(1.0, t / 200) * 0.5 * (1 + np.cos(np.pi * t / total))
            key, k = jax.random.split(key)
            params, m, v, loss = step(params, m, v, float(t), lr, prep(x[idx]), jnp.asarray(r[idx]), jnp.asarray(s[idx]), k)
        print("época %d (%.0fs): pérdida %.3f · valor/palo/carta = %.4f %.4f %.4f" % ((ep + 1, time.time() - t0, float(loss)) + evaluate(params, xt, rt, st)), flush=True)
    to_onnx(params, a.out)
    print("exportado", a.out)


if __name__ == "__main__":
    main()
