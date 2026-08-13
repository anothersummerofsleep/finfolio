// PaddleOCR-VL engine: the Node side of the optional local OCR sidecar
// (app/sidecar/serve.py). finfolio renders each PDF page to a PNG (via the
// shared lib/pdf-render.js, so the cached page images that back the "show me the
// source line" snippet stay in one pixel space) and POSTs it to the sidecar,
// which returns PaddleOCR-VL's semantic blocks — including the transaction table
// as an HTML <table>. lib/paddle-tables.js turns those into transactions.
//
// The sidecar is never a dependency: paddleAvailable() is a fast health check,
// and lib/server falls back to tesseract (lib/ocr.js) whenever it returns false.

import { renderPdfToPngs } from './pdf-render.js';

const SIDECAR_URL = process.env.OCR_SIDECAR_URL || 'http://127.0.0.1:8776';

// PaddleOCR-VL renders PDF pages at ~144 DPI internally; matching that here
// (scale 2) keeps the block bboxes it returns in the same pixel space as the
// page image we cache for snippets, and reads as well as its own rendering.
const PADDLE_SCALE = Number(process.env.OCR_PADDLE_SCALE) || 2;

// Short timeout: a health check should never stall an import. Sidecar down or
// slow -> treat as unavailable and fall back.
export async function paddleAvailable(url = SIDECAR_URL, timeoutMs = 800) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: ctrl.signal });
    if (!res.ok) return false;
    const body = await res.json();
    return body && body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function ocrPage(png, url) {
  const res = await fetch(`${url}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: png
  });
  if (!res.ok) throw new Error(`OCR sidecar returned ${res.status}`);
  return res.json(); // { width, height, blocks: [{ label, content, bbox }] }
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/�/g, ' ').replace(/\s+/g, ' ').trim();
}

// Flatten a page's blocks into plain text for bank detection (detectProfile) and
// period inference. Tables contribute their cell text so header/period keywords
// carried inside a table still register.
function blocksToText(blocks) {
  return (blocks || []).map((b) => stripHtml(b.content)).filter(Boolean).join('\n');
}

// Synthesize word-positioned lines from the blocks, so the profile path can run
// as a FALLBACK when the table-first parser finds no transaction table. Cells
// are placed at synthetic x's spread across each block's bbox width; profiles
// key on relative column order, which this preserves. Lines carry the page
// number + y so the snippet feature still works on the fallback path.
export function paddleBlocksToLines(blocks, pageNum) {
  const lines = [];
  const sorted = (blocks || []).slice().sort((a, b) => (a.bbox?.[1] ?? 0) - (b.bbox?.[1] ?? 0));
  for (const block of sorted) {
    const [x0 = 0, y0 = 0, x1 = 1000, y1 = y0 + 20] = block.bbox || [];
    if (block.label === 'table' && /<tr/i.test(block.content || '')) {
      const rows = [...String(block.content).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
        .map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripHtml(c[1])));
      const rowH = (y1 - y0) / Math.max(rows.length, 1);
      rows.forEach((cells, r) => {
        const y = Math.round(y0 + (r + 0.5) * rowH);
        const colW = (x1 - x0) / Math.max(cells.length, 1);
        const words = [];
        cells.forEach((cell, c) => {
          cell.split(/\s+/).filter(Boolean).forEach((w, k) => {
            words.push({ x: Math.round(x0 + c * colW + k * 12), str: w });
          });
        });
        if (words.length) {
          lines.push({ y, page: pageNum, text: words.map((w) => w.str).join(' '), words });
        }
      });
    } else {
      const text = stripHtml(block.content);
      if (!text) continue;
      const toks = text.split(/\s+/);
      const colW = (x1 - x0) / Math.max(toks.length, 1);
      lines.push({
        y: Math.round(y0), page: pageNum, text,
        words: toks.map((w, i) => ({ x: Math.round(x0 + i * colW), str: w }))
      });
    }
  }
  return lines;
}

// buffer: PDF bytes. opts: { url, imageCacheDir, onProgress(page,total) }.
// Returns the SAME shape lib/ocr.js's extractPdfViaOcr does, plus per-page
// `blocks` for the table-first parser:
//   { pages: [{ page, width, height, blocks, lines }], rawText, meanConfidence, imageCacheId }
export async function extractPdfViaPaddle(buffer, opts = {}) {
  const url = opts.url || SIDECAR_URL;
  const { pngs, imageCacheId } = await renderPdfToPngs(buffer, {
    scale: PADDLE_SCALE,
    imageCacheDir: opts.imageCacheDir,
    onProgress: opts.onProgress
  });

  const pages = [];
  for (const { buffer: png, width, height, page } of pngs) {
    const { blocks } = await ocrPage(png, url);
    pages.push({ page, width, height, blocks: blocks || [], lines: paddleBlocksToLines(blocks, page) });
  }

  const rawText = pages.map((pg) => blocksToText(pg.blocks)).join('\n');
  // PaddleOCR-VL does not emit a per-page confidence score; the review banner
  // just names the engine instead of showing a percentage.
  return { pages, rawText, meanConfidence: null, imageCacheId };
}
