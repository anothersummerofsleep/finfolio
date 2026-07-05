// OCR fallback for image-only statements (no text layer — e.g. HSBC's OpenText
// output, where every glyph is a 1-bit image mask). We render each PDF page to
// a high-DPI raster with @napi-rs/canvas, OCR it with tesseract.js, and emit the
// SAME { pages: [{ lines: [{ y, text, words:[{x,str}] }] }], rawText } shape that
// lib/pdf.js produces — so the existing bank profiles parse OCR output unchanged.
//
// Local-first: both deps run on-device (canvas is a prebuilt binary, tesseract
// is WASM). tesseract downloads its English model once and caches it under
// DATA_DIR; nothing is sent off the machine.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { createWorker } from 'tesseract.js';

// pdfjs needs a canvas factory in Node; @napi-rs/canvas supplies the surface.
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cc, width, height) { cc.canvas.width = width; cc.canvas.height = height; }
  destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; }
}

async function renderPageToPng(page, scale) {
  const viewport = page.getViewport({ scale });
  const factory = new NodeCanvasFactory();
  const { canvas, context } = factory.create(
    Math.ceil(viewport.width), Math.ceil(viewport.height)
  );
  await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise;
  return canvas.toBuffer('image/png');
}

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

// buffer: PDF bytes. opts: { scale=3 (~216 DPI), cachePath, onProgress(page,total) }.
// Returns { pages, rawText, meanConfidence }.
export async function extractPdfViaOcr(buffer, opts = {}) {
  const scale = opts.scale || 3;
  const data = Uint8Array.from(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  const loadingTask = getDocument({ data, canvasFactory: new NodeCanvasFactory(), useSystemFonts: true });
  const doc = await loadingTask.promise;

  const worker = await createWorker('eng', 1, opts.cachePath ? { cachePath: opts.cachePath } : undefined);
  const pages = [];
  const confidences = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (opts.onProgress) opts.onProgress(p, doc.numPages);
      const page = await doc.getPage(p);
      const png = await renderPageToPng(page, scale);
      const { data: res } = await worker.recognize(png, {}, { blocks: true });
      if (typeof res.confidence === 'number') confidences.push(res.confidence);
      pages.push({ lines: tesseractToLines(res) });
      page.cleanup();
    }
  } finally {
    await worker.terminate();
    await loadingTask.destroy();
  }

  const rawText = pages.map((pg) => pg.lines.map((l) => l.text).join('\n')).join('\n');
  const meanConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;
  return { pages, rawText, meanConfidence };
}
