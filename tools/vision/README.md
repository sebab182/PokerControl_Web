# Reconocimiento de cartas (herramientas de entrenamiento)

El clasificador lee la **esquina del índice** de una carta (valor + palo) y corre en el navegador con `onnxruntime-web`
(`apps/web/src/vision/`). El modelo entrenado vive en `apps/web/public/models/card-corner.onnx` (~1 MB).

- `synth.py`: genera esquinas sintéticas (fuentes libres DejaVu/Liberation, mazos de dos y cuatro colores, perspectiva, luz, desenfoque, ruido, JPEG).
- `train.py`: entrena una CNN chica con JAX (CPU) y exporta el ONNX armando el grafo con `onnx`. No usa pesos de terceros: sin obligaciones de licencia.
- `make_fixture.py`: imagen de prueba del e2e (`apps/web/e2e/fixtures/cards.png`).
- `scenes.py`: escenas giradas para medir la precisión punta a punta (detector + modelo).

```
pip install jax jaxlib onnx numpy pillow
cd tools/vision && PYTHONPATH=. python3 train.py --n 60000 --epochs 16
```

Los números sobre datos sintéticos no equivalen a la precisión con cartas reales: se ajusta con la prueba en celulares
(`/admin/vision`).
