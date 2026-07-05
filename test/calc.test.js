import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, monthDiff, monthlySummary, netWorthSeries, liquidTotal,
  recurringMonthlyAmount, committedMonthlyOutflow, installmentProgress,
  runway, fiProgress
} from '../public/js/calc.js';

const categories = [
  { id: 'salary', type: 'income' },
  { id: 'food', type: 'expense' },
  { id: 'rent', type: 'expense' }
];

test('addMonths handles year boundaries', () => {
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2025-11', 3), '2026-02');
  assert.equal(addMonths('2026-06', 0), '2026-06');
});

test('monthDiff', () => {
  assert.equal(monthDiff('2025-03', '2026-03'), 12);
  assert.equal(monthDiff('2026-06', '2026-06'), 0);
});

test('monthlySummary aggregates income, expenses, and accounts', () => {
  const monthly = [
    { month: '2026-01', categoryId: 'salary', amount: 5000 },
    { month: '2026-01', categoryId: 'food', amount: 400, accountId: 'dbs' },
    { month: '2026-01', categoryId: 'food', amount: 200, accountId: 'amex' },
    { month: '2026-01', categoryId: 'rent', amount: 1500 },
    { month: '2026-02', categoryId: 'food', amount: 300 }
  ];
  const [jan, feb] = monthlySummary(monthly, categories);
  assert.equal(jan.income, 5000);
  assert.equal(jan.expense, 2100);
  assert.equal(jan.byCategory.food, 600);
  assert.equal(jan.byAccount.dbs, 400);
  assert.equal(jan.byAccount.unassigned, 1500);
  assert.equal(feb.expense, 300);
});

const sleeves = [
  { id: 'cash', class: 'cash', liquid: true, fiEligible: false },
  { id: 'etf', class: 'equity', liquid: false, fiEligible: true },
  { id: 'ilp', class: 'equity', liquid: false, fiEligible: true }
];

const snapshots = [
  {
    date: '2026-01-01',
    values: [
      { sleeveId: 'cash', marketValue: 20000 },
      { sleeveId: 'etf', marketValue: 50000 },
      { sleeveId: 'ilp', marketValue: 55000, liquidationValue: 13000 }
    ]
  },
  {
    date: '2026-06-01',
    values: [
      { sleeveId: 'cash', marketValue: 18000 },
      { sleeveId: 'etf', marketValue: 54000 },
      { sleeveId: 'ilp', marketValue: 57000, liquidationValue: 14000 }
    ]
  }
];

test('netWorthSeries computes market and liquidation views', () => {
  const series = netWorthSeries(snapshots, sleeves);
  assert.equal(series.length, 2);
  assert.equal(series[0].market, 125000);
  assert.equal(series[0].liquidation, 83000); // ILP counted at surrender value
  assert.equal(series[1].byClass.equity, 111000);
});

test('liquidTotal only counts liquid sleeves', () => {
  assert.equal(liquidTotal(snapshots[1], sleeves), 18000);
});

test('recurring monthly equivalents convert frequency', () => {
  assert.equal(recurringMonthlyAmount({ amount: 300, frequency: 'monthly' }), 300);
  assert.equal(recurringMonthlyAmount({ amount: 300, frequency: 'quarterly' }), 100);
  assert.equal(recurringMonthlyAmount({ amount: 1200, frequency: 'yearly' }), 100);
});

test('committedMonthlyOutflow respects active windows', () => {
  const recurring = [
    { amount: 100, frequency: 'monthly', startDate: '2026-01-01' },
    { amount: 50, frequency: 'monthly', startDate: '2026-01-01', endDate: '2026-03-01' },
    { amount: 120, frequency: 'monthly', startDate: '2026-01-01', installmentsTotal: 3 }
  ];
  assert.equal(committedMonthlyOutflow(recurring, '2026-02'), 270);
  assert.equal(committedMonthlyOutflow(recurring, '2026-06'), 100); // others ended
});

test('installmentProgress derives payoff from start + count', () => {
  const item = { amount: 120, frequency: 'monthly', startDate: '2026-01-01', installmentsTotal: 24 };
  const progress = installmentProgress(item, '2026-06');
  assert.equal(progress.paid, 6);
  assert.equal(progress.remaining, 18);
  assert.equal(progress.remainingAmount, 2160);
  assert.equal(progress.payoffMonth, '2027-12');
});

test('runway averages trailing months and reports committed floor', () => {
  const monthly = [];
  for (const m of ['2026-03', '2026-04', '2026-05']) {
    monthly.push({ month: m, categoryId: 'food', amount: 3000 });
  }
  const summaries = monthlySummary(monthly, categories);
  const result = runway({
    snapshot: snapshots[1],
    sleeves,
    summaries,
    recurring: [{ amount: 500, frequency: 'monthly', startDate: '2026-01-01' }],
    settings: { runwayWindowMonths: 3 },
    todayYm: '2026-06'
  });
  assert.equal(result.cash, 18000);
  assert.equal(result.burn, 3000);
  assert.equal(result.months, 6);
  assert.equal(result.committedFloor, 500);
});

test('fiProgress reports insufficient data below 12 months', () => {
  const monthly = [
    { month: '2026-04', categoryId: 'food', amount: 2000 },
    { month: '2026-05', categoryId: 'food', amount: 2000 }
  ];
  const summaries = monthlySummary(monthly, categories);
  const fi = fiProgress({
    summaries, snapshot: snapshots[1], sleeves,
    settings: { fiMultiplier: 25 }, todayYm: '2026-06'
  });
  assert.equal(fi.insufficient, true);
  assert.equal(fi.monthsOfData, 2);
  assert.equal(fi.assets, 111000); // cash is fiEligible: false
});

test('fiProgress computes FI number with 12 months of data', () => {
  const monthly = [];
  for (let i = 1; i <= 12; i++) {
    const m = addMonths('2026-06', -i);
    monthly.push({ month: m, categoryId: 'food', amount: 2500 });
    monthly.push({ month: m, categoryId: 'salary', amount: 5000 });
  }
  const summaries = monthlySummary(monthly, categories);
  const fi = fiProgress({
    summaries, snapshot: snapshots[1], sleeves,
    settings: { fiMultiplier: 25 }, todayYm: '2026-06'
  });
  assert.equal(fi.insufficient, false);
  assert.equal(fi.annualExpenses, 30000);
  assert.equal(fi.fiNumber, 750000);
  assert.equal(fi.progress, 14.8);
  assert.equal(fi.savingsRate, 50);
});
