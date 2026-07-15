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

test('inferYear resolves a period line whose end date is missing its year', () => {
  // A column-interleaved layout can split "26 Dec 2025" into "26 Dec" with
  // the "2025" swept onto an unrelated line elsewhere in the document —
  // reproduces a real Trust statement that got mis-dated a year into the
  // future because a later "Payment due date 10 Jan 2026" line was the only
  // other year in the document, and the old fallback picked the max year
  // anywhere in the text.
  const rawText = [
    'Some Bank Statement',
    'Block 206C 26 Nov 2025 - 26 Dec',
    'Statement cycle',
    'Payment due date 10 Jan 2026'
  ].join('\n');
  assert.equal(inferYear(rawText), 2025, 'end date inherits the start date\'s year, not the later due-date year');
});

test('inferYear bumps the end year across a Dec/Jan-spanning period with a year-less end date', () => {
  const rawText = 'Block 12 24 Dec 2025 - 24 Jan\nPayment due date 05 Feb 2026';
  assert.equal(inferYear(rawText), 2026);
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

// ---- DBS / POSB credit card -----------------------------------------------
// Layout: DATE ~54 | DESCRIPTION ~95 | AMOUNT (S$) ~515, with a "CR" token to
// the right for credits. Dates are year-less ("22 MAY"); the year comes from
// the STATEMENT DATE header. One statement bundles several cards. Non-txn
// tables (instalment/points summaries) sit outside the DATE/DESCRIPTION/AMOUNT
// table or after "GRAND TOTAL FOR ALL CARD ACCOUNTS".
const DBS_CARD_HEADER = line([57, 'DATE'], [124, 'DESCRIPTION'], [502, 'AMOUNT (S$)']);
const dbsCardStmt = (stmtDate, ...rows) => page(
  line([82, 'STATEMENT DATE'], [335, 'MINIMUM PAYMENT'], [461, 'PAYMENT DUE DATE']),
  line([95, stmtDate], [359, '$100.00'], [480, '07 Jul 2026']),
  DBS_CARD_HEADER,
  ...rows
);

test('detect: a DBS credit-card statement is recognized', () => {
  const t = 'Credit Cards\nStatement of Account\nDBS ALTITUDE VISA SIGNATURE CARD NO.: 4119';
  assert.equal(detectProfile(t).id, 'dbs-card');
  assert.ok(listProfiles().some((p) => p.id === 'dbs-card'));
});

test('DBS card: charge is money out (+), a CR row is a credit (money in, -)', () => {
  const doc = dbsCardStmt('12 Jun 2026',
    line([96, 'PREVIOUS BALANCE'], [513, '3,154.38']),
    line([54, '22 MAY'], [95, 'BILL PAYMENT - DBS INTERNET/WIRELESS'], [514, '2,083.86'], [550, 'CR']),
    line([54, '10 MAY'], [95, 'FWD SINGAPORE - IFA LI'], [521, '178.21']),
    line([54, '04 JUN'], [95, '7-ELEVEN - ESPLANADE M'], [529, '8.30'])
  );
  const { transactions, errors } = getProfile('dbs-card').parse(doc);
  assert.equal(errors.length, 0);
  assert.equal(transactions.length, 3, 'PREVIOUS BALANCE (no date) is skipped');
  const byDesc = Object.fromEntries(transactions.map((t) => [t.description, t]));
  assert.equal(byDesc['BILL PAYMENT - DBS INTERNET/WIRELESS'].amount, -2083.86, 'CR = money in');
  assert.deepEqual(byDesc['FWD SINGAPORE - IFA LI'], {
    date: '2026-05-10', month: '2026-05', description: 'FWD SINGAPORE - IFA LI', amount: 178.21
  });
  assert.equal(byDesc['7-ELEVEN - ESPLANADE M'].date, '2026-06-04', 'year from STATEMENT DATE');
});

test('DBS card: a Dec row on a January statement rolls back to the previous year', () => {
  const doc = dbsCardStmt('08 Jan 2026',
    line([54, '28 DEC'], [95, 'AMAZON'], [521, '40.00']),
    line([54, '03 JAN'], [95, 'GRAB'], [521, '12.00'])
  );
  const { transactions } = getProfile('dbs-card').parse(doc);
  const byDesc = Object.fromEntries(transactions.map((t) => [t.description, t]));
  assert.equal(byDesc['AMAZON'].date, '2025-12-28', 'Dec after Jan statement = previous year');
  assert.equal(byDesc['GRAB'].date, '2026-01-03');
});

test('DBS card: instalment postings kept; summary tables and sub-totals excluded', () => {
  const doc = dbsCardStmt('12 Jun 2026',
    line([54, '12 JUN'], [95, '008MY PREFERRED PAYMENT PLAN03 (01)'], [522, '356.84']),
    line([413, 'SUB-TOTAL:'], [522, '103.38']),
    line([430, 'TOTAL:'], [515, '1,173.90']),
    // Instalment-plan summary row: begins with a plan code, not a date.
    line([57, '008MY PREFERRED PAYMENT PLAN03'], [221, '$1,070.52'], [312, '3'], [488, '$713.68']),
    line([287, 'GRAND TOTAL FOR ALL CARD ACCOUNTS:'], [515, '1,962.71']),
    // DBS POINTS SUMMARY row after the grand total — must never be reached.
    line([57, '4119 1100 9419 6984'], [163, '32,509'], [261, '335'], [431, '32,152'])
  );
  const { transactions, errors } = getProfile('dbs-card').parse(doc);
  assert.equal(errors.length, 0);
  assert.equal(transactions.length, 1, 'only the dated instalment posting is a transaction');
  assert.equal(transactions[0].description, '008MY PREFERRED PAYMENT PLAN03 (01)');
  assert.equal(transactions[0].amount, 356.84);
});

// ---- DBS / POSB consolidated bank statement -------------------------------
// Cash-table columns: Date ~45 | Description ~113 | Withdrawal(-) ~338 (values
// land ~360) | Deposit(+) ~430 (values ~445) | Balance ~515. Only cash accounts
// (Multiplier / POSB) are collected; CPF / SRS / Fund tables are skipped.
const DBS_BANK_HEADER2 = line([45, 'Date'], [113, 'Description'],
  [338, 'Withdrawal (-)'], [430, 'Deposit (+)'], [515, 'Balance']);

test('detect: a DBS/POSB consolidated bank statement is recognized', () => {
  const t = 'DBS Consolidated Statement\nTransaction Details\nDBS Multiplier Account\nWithdrawal (-)';
  assert.equal(detectProfile(t).id, 'dbs-bank');
  assert.ok(listProfiles().some((p) => p.id === 'dbs-bank'));
});

test('DBS bank: withdrawal is money out (+), deposit money in (-); CPF table excluded', () => {
  const doc = page(
    line([34, 'Transaction Details'], [253, 'as at 30 Jun 2026']),
    line([45, 'DBS Multiplier Account'], [441, 'Account No. 271-053117-5']),
    DBS_BANK_HEADER2,
    line([113, 'Balance Brought Forward'], [491, 'SGD 1,210.68']),
    line([45, '03/06/2026'], [113, 'Advice Funds Transfer'], [367, '200.00'], [513, '1,010.68']),
    line([113, 'FT260603MB53244511']),               // reference — dropped
    line([113, 'VALUE DATE : 03/06/2026']),           // reference — dropped
    line([45, '30/06/2026'], [113, 'Interest Earned'], [456, '0.06'], [513, '2,138.00']),
    line([113, 'Total Balance Carried Forward in SGD:'], [360, '5,030.00'], [439, '5,957.32'], [513, '2,138.00']),
    // CPF Investment Account — an investment table, must be excluded wholesale.
    line([45, 'CPF Investment Account'], [423, 'Account No. 003-252413-6-220']),
    line([45, 'Date'], [113, 'Description'], [257, 'Contract No.'], [338, 'Withdrawal (-)'], [430, 'Deposit (+)'], [494, 'Balance']),
    line([45, '16/06/2026'], [97, 'PLACE FUND MGT'], [360, '2,050.00'])
  );
  const { transactions, errors, meta } = getProfile('dbs-bank').parse(doc);
  assert.equal(errors.length, 0);
  assert.equal(transactions.length, 2, 'only cash rows; brought/carried-forward and CPF excluded');
  const byDesc = Object.fromEntries(transactions.map((t) => [t.description, t]));
  assert.equal(byDesc['Advice Funds Transfer'].amount, 200, 'withdrawal = money out (+)');
  assert.equal(byDesc['Advice Funds Transfer'].date, '2026-06-03');
  assert.equal(byDesc['Interest Earned'].amount, -0.06, 'deposit = money in (-)');
  assert.ok(!transactions.some((t) => /FUND MGT/.test(t.description)), 'CPF row excluded');
  // Brought/Carried Forward rows aren't transactions, but their balances are
  // captured per cash account — name only, never the account number.
  assert.deepEqual(meta.balances, [
    { account: 'DBS Multiplier Account', opening: 1210.68, closing: 2138 }
  ], 'opening/closing balance read from the skipped summary rows; CPF gets none');
});

test('DBS bank: payee continuation stitched, reference lines dropped; card-payment row survives for review', () => {
  const doc = page(
    line([34, 'Transaction Details']),
    line([45, 'DBS Multiplier Account'], [441, 'Account No. 271-053117-5']),
    DBS_BANK_HEADER2,
    line([45, '07/06/2026'], [113, 'Advice Bill Payment'], [360, '1,795.00'], [513, '4,172.94']),
    line([113, 'AMEX-376201895601003 : I-BANK']),    // has digits → dropped
    line([113, 'CREDIT CARD PAYMENT']),               // words only → stitched
    line([45, '10/06/2026'], [113, 'GIRO Payments / Collections via GIRO'], [360, '1,000.00'], [513, '3,172.94']),
    line([113, 'FWD SINGAPORE PTE. LTD.'])            // payee → stitched
  );
  const { transactions } = getProfile('dbs-bank').parse(doc);
  assert.equal(transactions.length, 2);
  const pay = transactions.find((t) => /Bill Payment/.test(t.description));
  assert.equal(pay.amount, 1795, 'card repayment parsed as money out (categorised as transfer downstream)');
  assert.equal(pay.description, 'Advice Bill Payment CREDIT CARD PAYMENT', 'payee stitched, reference dropped');
  const giro = transactions.find((t) => /GIRO/.test(t.description));
  assert.equal(giro.description, 'GIRO Payments / Collections via GIRO FWD SINGAPORE PTE. LTD.');
});
