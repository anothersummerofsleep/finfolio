// PDF text extraction for statement import. Uses pdfjs-dist (Mozilla, pure JS,
// no native build step) to pull the text layer out of an e-statement and
// reassemble it into positioned lines — grouping text items by their y
// coordinate and sorting each line left-to-right by x. Column x-positions are
// what let a bank profile locate the date / description / amount fields
// reliably, which a flat text dump loses.
//
// Scanned / image-only statements have no text layer; extraction returns empty
// text and the caller fails loudly (OCR is out of scope) — we never guess.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Two text items belong to the same visual line if their baselines are within
// this many PDF units. Statements use ~10-12pt rows; 3 units is a safe grouping
// tolerance that keeps adjacent rows apart.
const LINE_TOLERANCE = 3;

// Build one page's items into lines. Each item from pdfjs carries a transform
// matrix [a,b,c,d,e,f] where e = x and f = y (baseline), plus the string.
function itemsToLines(items) {
  const positioned = items
    .filter((it) => typeof it.str === 'string' && it.str.length)
    .map((it) => ({ x: it.transform[4], y: it.transform[5], str: it.str }));

  positioned.sort((a, b) => b.y - a.y || a.x - b.x); // top-to-bottom, then left-to-right

  const lines = [];
  for (const item of positioned) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - item.y) <= LINE_TOLERANCE) {
      last.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  return lines.map((line) => {
    const items = line.items.sort((a, b) => a.x - b.x);
    return {
      y: Math.round(line.y),
      text: items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim(),
      // words keep x-positions so profiles can slice by column band
      words: items.map((i) => ({ x: Math.round(i.x), str: i.str }))
    };
  });
}

// buffer: Node Buffer | Uint8Array | ArrayBuffer of the PDF bytes.
// Returns { pages: [{ lines: [{ y, text, words }] }], rawText }.
export async function extractPdfText(buffer) {
  // pdfjs explicitly rejects a Node Buffer (even though it subclasses
  // Uint8Array) and detaches the input, so hand it a fresh plain copy.
  const data = Uint8Array.from(
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  );
  const loadingTask = getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;
  const pages = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push({ lines: itemsToLines(content.items) });
    }
  } finally {
    await loadingTask.destroy();
  }

  const rawText = pages
    .map((pg) => pg.lines.map((l) => l.text).join('\n'))
    .join('\n');

  return { pages, rawText };
}

// True when a PDF yielded no usable text (scanned/image statement).
export function hasNoTextLayer(extracted) {
  return !extracted || !extracted.rawText || extracted.rawText.trim().length === 0;
}
