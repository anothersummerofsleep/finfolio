import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHtmlTable, isTransactionTable, parsePaddleTransactions, extractStatementSummary
} from '../lib/paddle-tables.js';
import { paddleBlocksToLines } from '../lib/ocr-paddle.js';

// Structure mirrors a real HSBC card statement as PaddleOCR-VL returns it: the
// transaction table is one <table> block with two date columns (POST, TRAN),
// a description, and an AMOUNT(SGD) column (CR = credit). No PII — synthetic rows.
const txnTable =
  '<table>' +
  '<tr><td>DATE</td><td>DATE</td><td>DESCRIPTION</td><td>AMOUNT(SGD)</td></tr>' +
  '<tr><td>RETAIL TRANSACTIONS</td></tr>' +                                  // section header (1 cell)
  '<tr><td>05 Sep</td><td>05 Sep</td><td>COFFEE BEAN</td><td>12.80</td></tr>' +
  '<tr><td>07 Sep</td><td>07 Sep</td><td>SALARY CREDIT</td><td>3,200.00CR</td></tr>' + // credit
  '<tr><td>11 Sep</td><td>11 Sep</td><td>AMAZON WEB SERVICES</td><td>148.20</td></tr>' +
  '<tr><td>TOTAL</td><td></td><td></td><td>809.95</td></tr>' +               // summary -> skip
  '</table>';

// A non-transaction table that shares the page (installment plan): has AMOUNT +
// BALANCE but no DESCRIPTION, so it must be excluded.
const installmentTable =
  '<table>' +
  '<tr><td>DATE</td><td>EXPIRY</td><td>AMOUNT(SGD)</td><td>BALANCE(SGD)</td></tr>' +
  '<tr><td>05 Sep</td><td>05 Sep</td><td>50.00</td><td>450.00</td></tr>' +
  '</table>';

const page = (blocks) => ({ page: 1, blocks });
const tableBlock = (html, bbox = [107, 580, 760, 1171]) =>
  ({ label: 'table', content: html, bbox });
const textBlock = (text, bbox = [50, 40, 500, 70]) =>
  ({ label: 'text', content: text, bbox });

test('parseHtmlTable splits rows and cells, decoding entities and stray glyphs', () => {
  const rows = parseHtmlTable('<table><tr><td>A&amp;B</td><td>1.00</td></tr><tr><td>�</td><td>x</td></tr></table>');
  assert.deepEqual(rows, [['A&B', '1.00'], ['', 'x']]);
});

test('isTransactionTable keys on DESCRIPTION + AMOUNT header', () => {
  assert.equal(isTransactionTable(parseHtmlTable(txnTable)), true);
  assert.equal(isTransactionTable(parseHtmlTable(installmentTable)), false, 'AMOUNT+BALANCE, no DESCRIPTION');
});

test('parsePaddleTransactions reads the transaction table to the cent', () => {
  const rawText = '01 Sep 2025 to 30 Sep 2025';
  const { transactions } = parsePaddleTransactions(
    [page([textBlock(rawText), tableBlock(txnTable), tableBlock(installmentTable)])],
    { rawText }
  );
  assert.equal(transactions.length, 3, 'section header + TOTAL row are skipped');
  assert.deepEqual(
    transactions.map((t) => [t.date, t.description, t.amount]),
    [
      ['2025-09-05', 'COFFEE BEAN', 12.8],
      ['2025-09-07', 'SALARY CREDIT', -3200],   // CR -> money in
      ['2025-09-11', 'AMAZON WEB SERVICES', 148.2]
    ]
  );
});

test('a transaction row carries a snippet ref into the cached page image', () => {
  const rawText = '01 Sep 2025 to 30 Sep 2025';
  const { transactions } = parsePaddleTransactions([page([tableBlock(txnTable)])], { rawText });
  const t = transactions[0];
  assert.equal(t._ocr.page, 1);
  assert.ok(t._ocr.yStart >= 580 && t._ocr.yEnd <= 1171, 'y-band lies within the table bbox');
});

test('an unreadable-date row is kept with an empty (editable) date, not dropped', () => {
  const html =
    '<table>' +
    '<tr><td>DATE</td><td>DATE</td><td>DESCRIPTION</td><td>AMOUNT(SGD)</td></tr>' +
    '<tr><td>�</td><td>�</td><td>GRAB TRANSPORT</td><td>9.50</td></tr>' +
    '</table>';
  const { transactions, errors } = parsePaddleTransactions([page([tableBlock(html)])], { rawText: '' });
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].date, '', 'date left blank for the reviewer to fill');
  assert.equal(transactions[0].amount, 9.5);
  assert.equal(errors.length, 0, 'kept as an editable row, not an error-skip');
});

test('handles a continuation page where TRAN-date + description share one cell', () => {
  // PaddleOCR is non-deterministic and on continuation pages sometimes returns
  // the table as [POSTdate, "TRANdate description", amount] (3 cols) instead of
  // 4 clean columns. The date must split off and the rest become description.
  const html =
    '<table>' +
    '<tr><td>POST DATE DATE DATE</td><td>TRAN DESCRIPTION</td><td>AMOUNT(SGD)</td></tr>' +
    '<tr><td>09 Dec</td><td>09 Dec SUSHI EXPRESS SG</td><td>14.99</td></tr>' +
    '<tr><td>11 Dec</td><td>11 Dec HOOGA @CP1 SG</td><td>187.68</td></tr>' +
    '</table>';
  const { transactions } = parsePaddleTransactions([page([tableBlock(html)])],
    { rawText: '01 Dec 2025 to 31 Dec 2025' });
  assert.equal(transactions.length, 2);
  assert.deepEqual(transactions.map((t) => [t.date, t.description, t.amount]), [
    ['2025-12-09', 'SUSHI EXPRESS SG', 14.99],
    ['2025-12-11', 'HOOGA @CP1 SG', 187.68]
  ]);
});

test('a merchant that looks date-ish ("24 HRS ...") is not misread as a date', () => {
  const html =
    '<table>' +
    '<tr><td>DATE</td><td>DESCRIPTION</td><td>AMOUNT</td></tr>' +
    '<tr><td>05 Sep</td><td>24 HRS MART</td><td>8.00</td></tr>' +
    '</table>';
  const { transactions } = parsePaddleTransactions([page([tableBlock(html)])],
    { rawText: '01 Sep 2025 to 30 Sep 2025' });
  assert.deepEqual([transactions[0].date, transactions[0].description], ['2025-09-05', '24 HRS MART']);
});

test('leading + marks a credit (money in) even without CR', () => {
  const html =
    '<table>' +
    '<tr><td>Posting date</td><td>Description</td><td>Amount</td></tr>' +
    '<tr><td>05 Sep</td><td>REFUND</td><td>+15.00</td></tr>' +
    '</table>';
  const { transactions } = parsePaddleTransactions([page([tableBlock(html)])], { rawText: '2025-09-01 to 2025-09-30' });
  assert.equal(transactions[0].amount, -15);
});

// The ACCOUNT SUMMARY, as PaddleOCR flattens it (note the &amp; entity and CR).
const accountSummary =
  'ACCOUNT SUMMARY SGD Previous Statement Balance 843.68 Payments &amp; Credits 1,000.00CR ' +
  'Purchases &amp; Debits 1,431.06 Outstanding Instalments 1,663.64 Total Account Balance 2,938.38';

test('extractStatementSummary reads Purchases and Payments, nets them', () => {
  const s = extractStatementSummary(accountSummary);
  assert.equal(s.purchases, 1431.06);
  assert.equal(s.payments, 1000);
  assert.equal(s.expectedNet, 431.06); // purchases − payments
});

test('extractStatementSummary returns null when the labels are absent', () => {
  assert.equal(extractStatementSummary('Trust Bank statement, no such summary'), null);
});

test('reconciliation flags a dropped row (parsed net != statement net)', () => {
  // One 14.99 purchase, but the summary says purchases should be 29.98 → short.
  const html =
    '<table><tr><td>DATE</td><td>DESCRIPTION</td><td>AMOUNT</td></tr>' +
    '<tr><td>05 Sep</td><td>FACEBK</td><td>14.99</td></tr></table>';
  const rawText = 'Payments & Credits 0.00CR Purchases & Debits 29.98 . 2025-09-01 to 2025-09-30';
  const { meta } = parsePaddleTransactions([page([tableBlock(html)])], { rawText });
  assert.equal(meta.reconciliation.ok, false);
  assert.equal(meta.reconciliation.expectedNet, 29.98);
  assert.equal(meta.reconciliation.parsedNet, 14.99);
  assert.equal(meta.reconciliation.diff, -14.99);
});

test('reconciliation passes when parsed net matches the statement summary', () => {
  const html =
    '<table><tr><td>DATE</td><td>DESCRIPTION</td><td>AMOUNT</td></tr>' +
    '<tr><td>05 Sep</td><td>A</td><td>20.00</td></tr>' +
    '<tr><td>06 Sep</td><td>B</td><td>9.98</td></tr></table>';
  const rawText = 'Payments & Credits 0.00CR Purchases & Debits 29.98 . 2025-09-01 to 2025-09-30';
  const { meta } = parsePaddleTransactions([page([tableBlock(html)])], { rawText });
  assert.equal(meta.reconciliation.ok, true);
  assert.equal(meta.reconciliation.diff, 0);
});

test('paddleBlocksToLines synthesizes profile-consumable lines (fallback path)', () => {
  const lines = paddleBlocksToLines([textBlock('HSBC Bank'), tableBlock(txnTable)], 2);
  // Bank keyword survives for detectProfile; table rows become positioned lines.
  assert.ok(lines.some((l) => /HSBC/.test(l.text)));
  const txnLine = lines.find((l) => /COFFEE BEAN/.test(l.text));
  assert.ok(txnLine, 'a transaction row is present as a line');
  assert.equal(txnLine.page, 2);
  assert.ok(txnLine.words.every((w) => Number.isFinite(w.x)), 'words carry x positions');
});
