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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// pdfjs needs a canvas factory in Node; @napi-rs/canvas supplies the surface.
class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cc, width, height) { cc.canvas.width = width; cc.canvas.height = height; }
  destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; }
}

// cropRight: keep only this fraction of the page's width (from the left),
// e.g. 0.7 to drop the right-hand 30%. Bank statements that put a wide
// "account summary" sidebar beside the transaction table (HSBC's VISA
// Revolution layout) sit at roughly the same y-range as transaction rows;
// Tesseract's automatic column detection can merge the two into one line,
// bleeding sidebar text (and numbers) into a transaction's description or
// amount. Cropping the sidebar out before OCR removes that at the source —
// more reliable than trying to detect and strip it back out afterwards —
// and, since there are far fewer pixels left to recognize, affords a higher
// render scale for the same cost, which also fixes plain digit/letter
// misreads (e.g. "25Sep" read as "258ep").
// Returns { buffer, width, height } — callers that cache the image (for the
// "show me the source line" snippet feature) need the dimensions without
// re-decoding the PNG.
async function renderPageToPng(page, scale, cropRight) {
  const viewport = page.getViewport({ scale });
  const factory = new NodeCanvasFactory();
  const fullWidth = Math.ceil(viewport.width);
  const fullHeight = Math.ceil(viewport.height);
  const { canvas, context } = factory.create(fullWidth, fullHeight);
  await page.render({ canvasContext: context, viewport, canvasFactory: factory }).promise;
  if (!cropRight || cropRight >= 1) {
    return { buffer: canvas.toBuffer('image/png'), width: fullWidth, height: fullHeight };
  }

  const width = Math.round(fullWidth * cropRight);
  const cropped = createCanvas(width, fullHeight);
  cropped.getContext('2d').drawImage(canvas, 0, 0, width, fullHeight, 0, 0, width, fullHeight);
  return { buffer: cropped.toBuffer('image/png'), width, height: fullHeight };
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

// buffer: PDF bytes. opts: { scale=3 (~216 DPI), cropRight, cachePath, imageCacheDir, onProgress(page,total) }.
// Returns { pages, rawText, meanConfidence, imageCacheId }.
//
// imageCacheDir: when set, the (already-cropped) rendered PNG for each page is
// saved to `${imageCacheDir}/${imageCacheId}/page-N.png`, keyed by a hash of
// the PDF bytes — so re-importing the same file reuses the same id instead of
// piling up duplicates. This backs the "show me the source line" snippet
// feature: a transaction only carries a page number + y position (see
// pdf-profiles.js), and the actual crop happens on demand against this cached
// image, so nothing but that reference needs to travel through the rest of
// the app (review queue, etc).
export async function extractPdfViaOcr(buffer, opts = {}) {
  const scale = opts.scale || 3;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const data = Uint8Array.from(bytes);
  const loadingTask = getDocument({ data, canvasFactory: new NodeCanvasFactory(), useSystemFonts: true });
  const doc = await loadingTask.promise;

  const imageCacheId = opts.imageCacheDir ? createHash('sha256').update(bytes).digest('hex').slice(0, 24) : null;
  const imageDir = imageCacheId ? path.join(opts.imageCacheDir, imageCacheId) : null;
  if (imageDir) fs.mkdirSync(imageDir, { recursive: true });

  const worker = await createWorker('eng', 1, opts.cachePath ? { cachePath: opts.cachePath } : undefined);
  const pages = [];
  const confidences = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (opts.onProgress) opts.onProgress(p, doc.numPages);
      const page = await doc.getPage(p);
      const { buffer: png, width, height } = await renderPageToPng(page, scale, opts.cropRight);
      if (imageDir) fs.writeFileSync(path.join(imageDir, `page-${p}.png`), png);
      const { data: res } = await worker.recognize(png, {}, { blocks: true });
      if (typeof res.confidence === 'number') confidences.push(res.confidence);
      pages.push({ lines: tesseractToLines(res).map((l) => ({ ...l, page: p })), width, height });
      page.cleanup();
    }
  } finally {
    await worker.terminate();
    await loadingTask.destroy();
  }

  const rawText = pages.map((pg) => pg.lines.map((l) => l.text).join('\n')).join('\n');
  const meanConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;
  return { pages, rawText, meanConfidence, imageCacheId };
}
