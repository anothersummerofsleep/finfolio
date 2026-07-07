import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProfile, detectProfile, inferYear, listProfiles } from '../lib/pdf-profiles.js';

// A profile consumes the { pages: [{ lines: [{ y, text, words:[{x,str}] }] }] }
// shape that lib/pdf.js produces. These helpers build that shape from plain
// data so the profiles can be tested without a real PDF (and without any PII).
function line(...words) {
  // words: [x, str] pairs already in left-to-right order
  return {
    y: 0,
    text: words.map(([, s]) => s).join(' ').replace(/\s+/g, ' ').trim(),
    words: words.map(([x, str]) => ({ x, str }))
  };
}
// profile.parse receives the pages array (extracted.pages from lib/pdf.js).
const page = (...lines) => [{ lines }];

// Column x-bands for a synthetic HSBC account statement:
//   Date ~50 | Details ~120.. | Withdrawal ~360 | Deposit ~440 | Balance ~520
const HEADER = line([50, 'Date'], [120, 'Transaction'], [180, 'details'],
  [360, 'Withdrawal'], [440, 'Deposit'], [520, 'Balance']);

test('inferYear picks the latest 4-digit year on the statement', () => {
  assert.equal(inferYear('Statement period 01 Jun 2025 to 30 Jun 2025'), 2025);
  assert.equal(inferYear('no year here'), null);
});

test('HSBC: withdrawal is money-out (+), deposit is money-in (-)', () => {
  const doc = page(
    line([50, 'Statement'], [120, 'period'], [200, '01 Jun 2025 to 30 Jun 2025']),
    HEADER,
    line([50, '01 Jun'], [120, 'BALANCE'], [180, 'B/F'], [520, '1,000.00']),
    line([50, '05 Jun'], [120, 'POS'], [160, 'NTUC'], [210, 'FAIRPRICE'], [360, '85.20'], [520, '914.80']),
    line([50, '06 Jun'], [120, 'GIRO'], [170, 'SALARY'], [230, 'ACME'], [440, '6,000.00'], [520, '6,914.80'])
  );
  const { transactions, errors } = getProfile('hsbc').parse(doc);
  assert.equal(errors.length, 0);
  assert.equal(transactions.length, 2, 'BALANCE B/F row is skipped');
  assert.deepEqual(transactions[0], {
    date: '2025-06-05', month: '2025-06', description: 'POS NTUC FAIRPRICE', amount: 85.2
  });
  assert.equal(transactions[1].amount, -6000, 'deposit is negative (money in)');
  assert.equal(transactions[1].description, 'GIRO SALARY ACME');
});

test('HSBC: multi-line descriptions are stitched to the prior transaction', () => {
  const doc = page(
    line([200, '01 Jul 2025 to 31 Jul 2025']),
    HEADER,
    line([50, '07 Jul'], [120, 'FUNDS'], [170, 'TRANSFER'], [360, '100.00'], [520, '814.80']),
    line([120, 'TO'], [150, 'JOHN'], [200, 'TAN'])
  );
  const { transactions } = getProfile('hsbc').parse(doc);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].description, 'FUNDS TRANSFER TO JOHN TAN');
  assert.equal(transactions[0].amount, 100);
});

test('HSBC: infers the missing year from the statement period', () => {
  const doc = page(
    line([200, '01 Jun 2024 to 30 Jun 2024']),
    HEADER,
    line([50, '15 Jun'], [120, 'COFFEE'], [360, '6.50'], [520, '900.00'])
  );
  const { transactions } = getProfile('hsbc').parse(doc);
  assert.equal(transactions[0].date, '2024-06-15');
});

test('HSBC: a transaction-shaped row with no parseable amount fails loudly', () => {
  const doc = page(
    line([200, '01 Jun 2025 to 30 Jun 2025']),
    HEADER,
    line([50, '09 Jun'], [120, 'MYSTERY'], [180, 'ROW'])
  );
  const { transactions, errors } = getProfile('hsbc').parse(doc);
  assert.equal(transactions.length, 0);
  assert.equal(errors.length, 1, 'no guessing — the row is reported, not imported');
});

test('HSBC: "Paid out / Paid in" column wording is handled', () => {
  const header = line([50, 'Date'], [120, 'Details'], [360, 'Paid'], [385, 'out'],
    [440, 'Paid'], [465, 'in'], [520, 'Balance']);
  const doc = page(
    line([200, '01 Jun 2025 to 30 Jun 2025']),
    header,
    line([50, '03 Jun'], [120, 'GROCERIES'], [360, '42.00'], [520, '958.00']),
    line([50, '04 Jun'], [120, 'REFUND'], [440, '10.00'], [520, '968.00'])
  );
  const { transactions } = getProfile('hsbc').parse(doc);
  assert.equal(transactions[0].amount, 42, 'paid out = money out (+)');
  assert.equal(transactions[1].amount, -10, 'paid in = money in (-)');
});

test('HSBC: single "Amount" column uses CR marker for credits', () => {
  const header = line([50, 'Date'], [120, 'Details'], [400, 'Amount'], [520, 'Balance']);
  const doc = page(
    line([200, '01 Jun 2025 to 30 Jun 2025']),
    header,
    line([50, '02 Jun'], [120, 'DINING'], [400, '30.00'], [520, '970.00']),
    line([50, '03 Jun'], [120, 'INTEREST'], [400, '1.20 CR'], [520, '971.20'])
  );
  const { transactions } = getProfile('hsbc').parse(doc);
  assert.equal(transactions[0].amount, 30);
  assert.equal(transactions[1].amount, -1.2, 'CR marker flips to money in');
});

test('detect: HSBC statement text is recognized; generic is opt-in only', () => {
  assert.equal(detectProfile('HSBC Bank (Singapore) Limited statement').id, 'hsbc');
  assert.equal(detectProfile('Some Other Bank'), null);
  assert.ok(listProfiles().some((p) => p.id === 'generic'));
});

test('generic: leading date + trailing amount, description in between', () => {
  const doc = page(
    line([50, '2026-01-15'], [120, 'ELECTRICITY'], [180, 'BILL'], [400, '88.00'])
  );
  const { transactions } = getProfile('generic').parse(doc);
  assert.deepEqual(transactions[0], {
    date: '2026-01-15', month: '2026-01', description: 'ELECTRICITY BILL', amount: 88
  });
});

// ---- Trust (Trust Bank Singapore) -----------------------------------------
// Trust's rows span several lines (merchant name above/below the amount line,
// plus an FX-rate line), so these fixtures carry real y-positions. Columns:
//   [Transaction date ~72] Posting date ~141 | Description ~210 | FCY ~380 | SGD ~457
// A credit prints with a leading "+"; balance-summary rows are not transactions.
const at = (y, ...words) => ({
  y,
  text: words.map(([, s]) => s).join(' ').replace(/\s+/g, ' ').trim(),
  words: words.map(([x, str]) => ({ x, str }))
});
const TRUST_HEADER = at(680, [141, 'Posting date'], [210, 'Description'],
  [380, 'Amount in FCY'], [457, 'Amount in SGD']);

test('detect: a Trust statement is recognized', () => {
  assert.equal(detectProfile('Trust Bank Singapore Limited\nCredit card statement').id, 'trust');
  assert.ok(listProfiles().some((p) => p.id === 'trust'));
});

test('Trust: purchase — merchant name (above) + inline detail, FX line ignored, SGD amount', () => {
  const doc = page(
    at(700, [407, '24 Feb 2026 - 26 Mar 2026']),
    TRUST_HEADER,
    at(478, [210, 'SEKAINOYAMACHAN']),
    at(466, [72, '19 Feb'], [141, '22 Feb'], [210, 'AKIHABARAAichi JP'],
      [387, '10,296.00'], [420, 'JPY'], [501, '85.32']),
    at(454, [214, '1 JPY = 0.0083 SGD'])
  );
  const { transactions, errors } = getProfile('trust').parse(doc);
  assert.equal(errors.length, 0);
  assert.equal(transactions.length, 1);
  assert.deepEqual(transactions[0], {
    date: '2026-02-19', month: '2026-02',
    description: 'SEKAINOYAMACHAN AKIHABARAAichi JP', amount: 85.32
  });
});

test('Trust: a "+" credit is money in (negative), stitched across lines', () => {
  const doc = page(
    at(700, [407, '24 Feb 2026 - 26 Mar 2026']),
    TRUST_HEADER,
    at(576, [210, 'Credit Payment from Trust savings']),
    at(570, [72, '03 Mar'], [141, '03 Mar'], [479, '+14,047.40']),
    at(564, [210, 'account']),
    at(99, [72, '25 Mar'], [141, '25 Mar'], [210, 'Cashback'], [500, '+4.20'])
  );
  const { transactions } = getProfile('trust').parse(doc);
  const credit = transactions.find((t) => /Credit Payment/.test(t.description));
  assert.equal(credit.amount, -14047.40, 'repayment is money in');
  assert.equal(credit.description, 'Credit Payment from Trust savings account');
  assert.equal(transactions.find((t) => t.description === 'Cashback').amount, -4.20);
});

test('Trust: "Previous balance" and "Total outstanding balance" rows are not transactions', () => {
  const doc = page(
    at(700, [407, '24 Feb 2026 - 26 Mar 2026']),
    TRUST_HEADER,
    at(638, [72, '24 Feb'], [141, '24 Feb'], [210, 'Previous balance'], [485, '769.52']),
    at(500, [72, '25 Feb'], [141, '25 Feb'], [210, 'KFC'], [502, '12.30']),
    at(74, [72, '26 Mar'], [141, '26 Mar'], [210, 'Total outstanding balance'], [496, '5,178.43'])
  );
  const { transactions } = getProfile('trust').parse(doc);
  assert.equal(transactions.length, 1, 'only the real KFC purchase survives');
  assert.equal(transactions[0].description, 'KFC');
  assert.equal(transactions[0].amount, 12.30);
});

test('Trust: single-date (early) layout — Posting date only, description at its own x', () => {
  // Header/period place Description at x~141 (no Transaction-date column).
  const header = at(680, [72, 'Posting date'], [141, 'Description'],
    [380, 'Amount in FCY'], [457, 'Amount in SGD']);
  const doc = page(
    at(700, [407, '26 Jun 2025 - 26 Jul 2025']),
    header,
    at(654, [72, '26 Jun'], [141, 'Previous balance'], [499, '+5.00']),
    at(629, [141, 'Novotel Century HK 25076609 HK']),
    at(623, [72, '13 Jul'], [388, '6,678.02'], [410, 'HKD'], [490, '1,091.34']),
    at(617, [145, '1 HKD = 0.1634 SGD']),
    at(592, [72, '18 Jul'], [141, 'KFC'], [502, '12.30'])
  );
  const { transactions, errors } = getProfile('trust').parse(doc);
  assert.equal(errors.length, 0);
  assert.equal(transactions.length, 2, 'Previous balance skipped; two real rows');
  assert.deepEqual(transactions[0], {
    date: '2025-07-13', month: '2025-07',
    description: 'Novotel Century HK 25076609 HK', amount: 1091.34
  });
  assert.equal(transactions[1].description, 'KFC');
});
