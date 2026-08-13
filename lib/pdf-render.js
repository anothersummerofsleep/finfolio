// Shared PDF-page rasterization for the OCR engines. Rendering the page to
// pixels is identical whether tesseract.js or the PaddleOCR-VL sidecar does the
// recognition — only the "PNG in, lines out" step differs — so both
// lib/ocr.js (tesseract) and lib/ocr-paddle.js (sidecar) render through here.
//
// Node is the single source of truth for the rendered pixels: it rasterizes
// each page once, caches that exact PNG under imageCacheDir, and hands the same
// bytes to whichever engine. Because the engine reports line positions in that
// PNG's pixel space, the "show me the source line" snippet feature (which crops
// a y-band out of the cached image) lines up regardless of engine.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// pdfjs needs a canvas factory in Node; @napi-rs/canvas supplies the surface.
export class NodeCanvasFactory {
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
// tesseract's automatic column detection can merge the two into one line,
// bleeding sidebar text (and numbers) into a transaction's description or
// amount. Cropping the sidebar out before OCR removes that at the source.
// (PaddleOCR-VL does not bleed the sidebar, so its path passes no cropRight
// and keeps the whole page.)
// Returns { buffer, width, height } — callers that cache the image (for the
// "show me the source line" snippet feature) need the dimensions without
// re-decoding the PNG.
export async function renderPageToPng(page, scale, cropRight) {
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

// Rasterize every page of a PDF to a PNG. opts:
//   { scale=3 (~216 DPI), cropRight, imageCacheDir, onProgress(page,total) }.
// Returns { pngs: [{ buffer, width, height, page }], imageCacheId, numPages }.
//
// imageCacheDir: when set, each rendered PNG is written to
// `${imageCacheDir}/${imageCacheId}/page-N.png`, keyed by a hash of the PDF
// bytes — so re-importing the same file reuses the same id instead of piling
// up duplicates. This backs the "show me the source line" snippet feature: a
// transaction only carries a page number + y position, and the crop happens on
// demand against this cached image.
export async function renderPdfToPngs(buffer, opts = {}) {
  const scale = opts.scale || 3;
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const data = Uint8Array.from(bytes);
  const loadingTask = getDocument({ data, canvasFactory: new NodeCanvasFactory(), useSystemFonts: true });
  const doc = await loadingTask.promise;

  const imageCacheId = opts.imageCacheDir
    ? createHash('sha256').update(bytes).digest('hex').slice(0, 24) : null;
  const imageDir = imageCacheId ? path.join(opts.imageCacheDir, imageCacheId) : null;
  if (imageDir) fs.mkdirSync(imageDir, { recursive: true });

  const pngs = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      if (opts.onProgress) opts.onProgress(p, doc.numPages);
      const page = await doc.getPage(p);
      const { buffer: png, width, height } = await renderPageToPng(page, scale, opts.cropRight);
      if (imageDir) fs.writeFileSync(path.join(imageDir, `page-${p}.png`), png);
      pngs.push({ buffer: png, width, height, page: p });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }

  return { pngs, imageCacheId, numPages: pngs.length };
}
