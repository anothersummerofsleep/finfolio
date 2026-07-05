import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText, hasNoTextLayer } from '../lib/pdf.js';
import { getProfile } from '../lib/pdf-profiles.js';

// End-to-end over the committed FAKE sample PDF: real pdfjs extraction feeds the
// HSBC profile. This exercises lib/pdf.js (which the unit tests stub around) on
// an actual PDF, with no PII.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(__dirname, '..', 'sample-data', 'hsbc-fake.pdf');

test('extractPdfText reads the text layer and positions of the sample PDF', async () => {
  const { pages, rawText } = await extractPdfText(fs.readFileSync(SAMPLE));
  assert.equal(hasNoTextLayer({ pages, rawText }), false);
  assert.match(rawText, /HSBC/);
  assert.ok(pages[0].lines.length > 5);
  // words carry x-positions used for column mapping
  assert.ok(pages[0].lines.every((l) => Array.isArray(l.words)));
});

test('HSBC profile parses the sample PDF end-to-end', async () => {
  const { pages } = await extractPdfText(fs.readFileSync(SAMPLE));
  const { transactions, errors, meta } = getProfile('hsbc').parse(pages);

  assert.equal(errors.length, 0, 'clean statement parses with no error rows');
  assert.equal(meta.year, 2025);
  assert.equal(transactions.length, 6, 'BALANCE B/F and C/F are excluded');

  const byDesc = Object.fromEntries(transactions.map((t) => [t.description, t]));
  assert.equal(byDesc['POS PURCHASE NTUC FAIRPRICE'].amount, 85.2);
  assert.equal(byDesc['GIRO SALARY ACME PTE LTD'].amount, -6000, 'salary is money in (-)');
  assert.equal(byDesc['FAST TRANSFER TO JANE TAN'].amount, 300, 'continuation line stitched');
  assert.equal(byDesc['REFUND LAZADA'].amount, -40);
  assert.equal(transactions[0].month, '2025-07');
});
