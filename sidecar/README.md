# finfolio OCR sidecar (optional)

**This is optional. finfolio runs on pure Node without it.**

By default, finfolio reads image-only PDF statements with the bundled
`tesseract.js` (no extra install, works everywhere). If you run this small local
sidecar, the importer instead uses Baidu's **PaddleOCR-VL** — a vision-language
document model that reads bank statements cent-accurate and returns the
transaction table as structured HTML, so you spend far less time fixing
misread digits.

Everything runs on your machine. No image or statement leaves it. The sidecar is
kept outside the Node app's `package.json` on purpose: it is never a build or
runtime dependency of finfolio.

## How the app finds it

On import, finfolio does a fast health check against `OCR_SIDECAR_URL`
(default `http://127.0.0.1:8776`). Sidecar up → PaddleOCR-VL. Sidecar down →
tesseract, automatically. You can force either engine with `OCR_ENGINE`
(`auto` | `paddle` | `tesseract`, default `auto`).

## Install

Needs Python 3.10+. A CUDA GPU is strongly recommended (~20s/page vs minutes on CPU).

```bash
python -m venv .venv && .venv/Scripts/activate   # or source .venv/bin/activate
pip install -r requirements.txt
# GPU build of paddle (example, CUDA 12.6):
pip install paddlepaddle-gpu==3.2.1 -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
```

The PaddleOCR-VL weights (~1 GB) download once on first run and cache under
`~/.paddlex/official_models/PaddleOCR-VL`.

> On Windows, install into a **short** venv path (e.g. `C:\ppocr\venv`) —
> PaddlePaddle ships very deep file paths and hits the MAX_PATH limit otherwise.

## Run

```bash
python serve.py
```

Optional env: `FINFOLIO_OCR_PORT` (default 8776), `FINFOLIO_OCR_HOST` (default 127.0.0.1).

Verify:

```bash
curl http://127.0.0.1:8776/health
# {"ok": true, "model": "PaddleOCR-VL", "loaded": true}
```

Then use finfolio's Import tab as usual — image-only statements will note they
were "Read via PaddleOCR-VL".

## Contract

- `GET /health` → `{ ok, model, loaded }`
- `POST /ocr` — body is the raw PNG bytes of one rendered page (finfolio renders
  the page and sends the pixels); returns
  `{ width, height, blocks: [{ label, content, bbox:[x0,y0,x1,y1] }] }`,
  where a `table` block's `content` is an HTML `<table>` string.

Consumed by [`app/lib/ocr-paddle.js`](../lib/ocr-paddle.js).
