import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCsv, parseAmount, parseDate, applyMapping,
  suggestCategory, aggregateTransactions, mergeImport, addRules
} from '../lib/importer.js';

test('parseCsv handles quotes, embedded commas, CRLF', () => {
  const rows = parseCsv('a,"b,1","say ""hi"""\r\nc,d,e\r\n');
  assert.deepEqual(rows, [['a', 'b,1', 'say "hi"'], ['c', 'd', 'e']]);
});

test('parseAmount handles currency symbols, commas, parens, CR marker', () => {
  assert.equal(parseAmount('$1,234.56'), 1234.56);
  assert.equal(parseAmount('(45.00)'), -45);
  assert.equal(parseAmount('12.30 CR'), -12.3);
  assert.equal(parseAmount('SGD 99.00'), 99);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('n/a'), null);
});

test('parseDate handles ISO, DMY, MDY, and named months', () => {
  assert.equal(parseDate('2026-07-04'), '2026-07-04');
  assert.equal(parseDate('04/07/2026'), '2026-07-04');
  assert.equal(parseDate('04/07/2026', 'MDY'), '2026-04-07');
  assert.equal(parseDate('4 Jul 2026'), '2026-07-04');
  assert.equal(parseDate('04 Jul 26'), '2026-07-04');
  assert.equal(parseDate('not a date'), null);
});

test('applyMapping with single signed amount column', () => {
  const rows = [
    ['Date', 'Description', 'Amount'],
    ['01/06/2026', 'NTUC FAIRPRICE', '85.20'],
    ['02/06/2026', 'REFUND LAZADA', '-20.00'],
    ['bad row', '', '']
  ];
  const { transactions, errors } = applyMapping(rows, {
    hasHeader: true, dateCol: 0, descCol: 1, amountCol: 2, expensePositive: true
  });
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0].month, '2026-06');
  assert.equal(transactions[0].amount, 85.2);
  assert.equal(transactions[1].amount, -20);
  assert.equal(errors.length, 1);
});

test('applyMapping flips sign for bank-style exports', () => {
  const rows = [['01/06/2026', 'GROCERIES', '-85.20']];
  const { transactions } = applyMapping(rows, {
    hasHeader: false, dateCol: 0, descCol: 1, amountCol: 2, expensePositive: false
  });
  assert.equal(transactions[0].amount, 85.2);
});

test('applyMapping with separate debit/credit columns', () => {
  const rows = [
    ['01/06/2026', 'SALARY', '', '6000.00'],
    ['02/06/2026', 'RENT', '1500.00', '']
  ];
  const { transactions } = applyMapping(rows, {
    hasHeader: false, dateCol: 0, descCol: 1, debitCol: 2, creditCol: 3
  });
  assert.equal(transactions[0].amount, -6000);
  assert.equal(transactions[1].amount, 1500);
});

test('suggestCategory matches case-insensitive substrings in order', () => {
  const rules = [
    { pattern: 'fairprice', categoryId: 'groceries' },
    { pattern: 'grab', categoryId: 'transport' }
  ];
  assert.equal(suggestCategory('NTUC FAIRPRICE JURONG', rules), 'groceries');
  assert.equal(suggestCategory('GrabPay Toa Payoh', rules), 'transport');
  assert.equal(suggestCategory('UNKNOWN SHOP', rules), null);
});

test('aggregateTransactions nets refunds and drops skipped/uncategorized', () => {
  const txns = [
    { month: '2026-06', categoryId: 'groceries', amount: 100 },
    { month: '2026-06', categoryId: 'groceries', amount: -20 },
    { month: '2026-06', categoryId: 'skip', amount: 500 },
    { month: '2026-06', categoryId: '', amount: 50 },
    { month: '2026-07', categoryId: 'groceries', amount: 60 }
  ];
  const aggregates = aggregateTransactions(txns);
  assert.deepEqual(aggregates, [
    { month: '2026-06', categoryId: 'groceries', amount: 80 },
    { month: '2026-07', categoryId: 'groceries', amount: 60 }
  ]);
});

test('mergeImport replaces prior imports for same account+month, keeps manual', () => {
  const monthly = [
    { month: '2026-06', categoryId: 'dining', accountId: 'amex', amount: 111, source: 'import' },
    { month: '2026-06', categoryId: 'rent', accountId: null, amount: 1500, source: 'manual' },
    { month: '2026-06', categoryId: 'dining', accountId: 'dbs', amount: 50, source: 'import' },
    { month: '2026-05', categoryId: 'dining', accountId: 'amex', amount: 99, source: 'import' }
  ];
  const merged = mergeImport(monthly, 'amex', [
    { month: '2026-06', categoryId: 'dining', amount: 222 }
  ]);
  // old amex/2026-06 import replaced; manual, other-account, other-month kept
  assert.equal(merged.length, 4);
  const amexJun = merged.filter((e) => e.accountId === 'amex' && e.month === '2026-06');
  assert.equal(amexJun.length, 1);
  assert.equal(amexJun[0].amount, 222);
  assert.ok(merged.some((e) => e.source === 'manual' && e.amount === 1500));
  assert.ok(merged.some((e) => e.accountId === 'dbs'));
  assert.ok(merged.some((e) => e.month === '2026-05'));
});

test('addRules dedupes by pattern+category', () => {
  const existing = [{ pattern: 'fairprice', categoryId: 'groceries' }];
  const out = addRules(existing, [
    { pattern: 'FairPrice', categoryId: 'groceries' },
    { pattern: 'grab', categoryId: 'transport' }
  ]);
  assert.equal(out.length, 2);
});
