r"""
finfolio OCR sidecar — OPTIONAL. The finfolio app runs on pure Node without it.

When this local server is running, finfolio's importer uses Baidu's PaddleOCR-VL
(a vision-language document model) to read bank statements instead of the bundled
tesseract.js. PaddleOCR-VL reads image-only statements cent-accurate and returns
the transaction table as structured HTML, so the importer needs far less
digit-by-digit review. If the sidecar is NOT running, finfolio falls back to
tesseract automatically — nothing here is a dependency of the Node app, and this
folder is deliberately outside the app's package.json.

Everything is local: the model weights are cached on disk, no image or statement
ever leaves the machine.

Contract (consumed by app/lib/ocr-paddle.js):
  GET  /health -> { "ok": true, "model": "PaddleOCR-VL" }
  POST /ocr    (body = raw PNG bytes of ONE rendered page)
       -> { "width": int, "height": int,
            "blocks": [ { "label": str, "content": str, "bbox": [x0,y0,x1,y1] } ] }
     `content` for a table block is an HTML <table> string.

Run (using the eval session's prepared venv):
  C:\ppocr\venv\Scripts\python.exe app\sidecar\serve.py
  # optional: FINFOLIO_OCR_PORT (default 8776), FINFOLIO_OCR_HOST (default 127.0.0.1)
"""

import io
import os
import sys

import numpy as np
from PIL import Image
from fastapi import FastAPI, Request, Response
import uvicorn

MODEL_NAME = "PaddleOCR-VL"
_pipeline = None


def get_pipeline():
    # Lazy singleton: loading the model takes several seconds, so do it once on
    # the first request (or eagerly at startup — see __main__).
    global _pipeline
    if _pipeline is None:
        from paddleocr import PaddleOCRVL
        _pipeline = PaddleOCRVL(pipeline_version="v1")
    return _pipeline


app = FastAPI(title="finfolio OCR sidecar", version="1.0")


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "loaded": _pipeline is not None}


@app.post("/ocr")
async def ocr(request: Request):
    raw = await request.body()
    if not raw:
        return Response(content='{"error":"empty body"}', status_code=400,
                        media_type="application/json")
    # Decode the PNG that Node rendered. Node is the single source of truth for
    # the page pixels (it also caches this exact image for the "show me the
    # source line" snippet feature), so the block bboxes we return are in this
    # image's pixel space and line up with that cache.
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    arr = np.array(img)  # RGB HxWx3

    pipeline = get_pipeline()
    blocks = []
    width, height = img.width, img.height
    for res in pipeline.predict(arr):
        j = res.json["res"]
        width = j.get("width") or width
        height = j.get("height") or height
        for b in j.get("parsing_res_list", []):
            blocks.append({
                "label": b.get("block_label"),
                "content": b.get("block_content"),
                "bbox": b.get("block_bbox"),
            })
    return {"width": width, "height": height, "blocks": blocks}


if __name__ == "__main__":
    host = os.environ.get("FINFOLIO_OCR_HOST", "127.0.0.1")
    port = int(os.environ.get("FINFOLIO_OCR_PORT", "8776"))
    # Warm the model at startup so the first import isn't slow and /health only
    # flips to loaded:true once it's actually ready.
    print(f"[finfolio-ocr] loading {MODEL_NAME} …", file=sys.stderr)
    get_pipeline()
    print(f"[finfolio-ocr] ready on http://{host}:{port}", file=sys.stderr)
    uvicorn.run(app, host=host, port=port, log_level="warning")
