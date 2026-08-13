// OCR fallback for image-only statements (no text layer — e.g. HSBC's OpenText
// output, where every glyph is a 1-bit image mask). We render each PDF page to
// a high-DPI raster (shared lib/pdf-render.js) and OCR it with tesseract.js,
// emitting the SAME { pages: [{ lines: [{ y, text, words:[{x,str}] }], width,
// height }], rawText } shape that lib/pdf.js produces — so the existing bank
// profiles parse OCR output unchanged.
//
// This is the DEFAULT, dependency-free engine. When the optional PaddleOCR-VL
// sidecar is running (lib/ocr-paddle.js), the server prefers it; tesseract stays
// the fallback so a fresh clone with no Python still reads image-only PDFs.
//
// Local-first: both deps run on-device (canvas is a prebuilt binary, tesseract
// is WASM). tesseract downloads its English model once and caches it under
// DATA_DIR; nothing is sent off the machine.

import { createWorker } from 'tesseract.js';
import { renderPdfToPngs } from './pdf-render.js';

// Group tesseract words into our line shape. tesseract already segments lines;
// we flatten to { y, text, words:[{x,str}] } keyed on pixel positions (relative
// order is all the profiles need, so the render scale is irrelevant downstream).
export function tesseractToLines(data) {
  const lines = [];
  const blocks = data.blocks || [];
  for (const block of blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const words = (line.words || [])
          .map((w) => ({ x: Math.round(w.bbox.x0), str: (w.text || '').trim() }))
          .filter((w) => w.str.length);
        if (!words.length) continue;
        lines.push({
          y: Math.round(line.bbox.y0),
          text: words.map((w) => w.str).join(' ').replace(/\s+/g, ' ').trim(),
          words
        });
      }
    }
  }
  return lines;
}

// buffer: PDF bytes. opts: { scale=3 (~216 DPI), cropRight, cachePath, imageCacheDir, onProgress(page,total) }.
// Returns { pages, rawText, meanConfidence, imageCacheId }.
//
// cropRight and imageCacheDir are documented on lib/pdf-render.js. The sidebar
// crop (cropRight: 0.7) is a tesseract-specific fix for HSBC's account-summary
// panel bleeding into amounts; the PaddleOCR path needs no crop.
export async function extractPdfViaOcr(buffer, opts = {}) {
  const { pngs, imageCacheId } = await renderPdfToPngs(buffer, {
    scale: opts.scale || 3,
    cropRight: opts.cropRight,
    imageCacheDir: opts.imageCacheDir,
    onProgress: opts.onProgress
  });

  const worker = await createWorker('eng', 1, opts.cachePath ? { cachePath: opts.cachePath } : undefined);
  const pages = [];
  const confidences = [];
  try {
    for (const { buffer: png, width, height, page } of pngs) {
      const { data: res } = await worker.recognize(png, {}, { blocks: true });
      if (typeof res.confidence === 'number') confidences.push(res.confidence);
      pages.push({ lines: tesseractToLines(res).map((l) => ({ ...l, page })), width, height });
    }
  } finally {
    await worker.terminate();
  }

  const rawText = pages.map((pg) => pg.lines.map((l) => l.text).join('\n')).join('\n');
  const meanConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;
  return { pages, rawText, meanConfidence, imageCacheId };
}
