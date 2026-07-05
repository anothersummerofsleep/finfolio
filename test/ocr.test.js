import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tesseractToLines } from '../lib/ocr.js';
import { getProfile } from '../lib/pdf-profiles.js';

// tesseractToLines converts tesseract's block→paragraph→line→word tree into the
// same { y, text, words:[{x,str}] } shape lib/pdf.js emits, so the bank profiles
// consume OCR output unchanged. (Full render+OCR is verified manually against a
// real statement — too slow/heavy for the unit suite.)
const word = (x, text) => ({ text, bbox: { x0: x, y0: 0, x1: x + 10, y1: 12 } });
const line = (y, words) => ({ bbox: { x0: words[0]?.bbox.x0 ?? 0, y0: y }, words });
const doc = (lines) => ({ blocks: [{ paragraphs: [{ lines }] }] });

test('tesseractToLines maps words with x-positions and drops empties', () => {
  const data = doc([
    line(100, [word(50, '05'), word(80, 'Jun'), word(360, '85.20'), word(0, '  ')]),
    line(200, [word(50, 'BALANCE')])
  ]);
  const lines = tesseractToLines(data);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].words, [
    { x: 50, str: '05' }, { x: 80, str: 'Jun' }, { x: 360, str: '85.20' }
  ]);
  assert.equal(lines[0].text, '05 Jun 85.20');
  assert.equal(lines[0].y, 100);
});

test('OCR-shaped pages feed the HSBC profile end-to-end', () => {
  // Simulate what render+OCR produces: positioned lines for a card statement.
  const data = doc([
    line(60, [word(200, '01'), word(240, 'Jun'), word(300, '2025'), word(360, 'to'),
      word(400, '30'), word(440, 'Jun'), word(500, '2025')]),
    line(120, [word(50, 'Date'), word(300, 'Description'), word(800, 'Amount')]),
    line(160, [word(50, '05'), word(80, 'Jun'), word(300, 'COFFEE'), word(360, 'SHOP'), word(800, '6.50')]),
    line(200, [word(50, '06'), word(80, 'Jun'), word(300, 'REFUND'), word(800, '2.00'), word(860, 'CR')])
  ]);
  const pages = [{ lines: tesseractToLines(data) }];
  const { transactions, errors } = getProfile('hsbc').parse(pages);
  assert.equal(errors.length, 0);
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0].amount, 6.5);
  assert.equal(transactions[0].description, 'COFFEE SHOP');
  assert.equal(transactions[1].amount, -2, 'CR credit becomes money-in');
});
