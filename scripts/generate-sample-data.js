// Deterministic fake data for the public demo — 18 months of monthly records,
// quarterly snapshots, accounts, and recurring items. All numbers invented.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEEDS } from '../lib/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'sample-data');

// Seeded PRNG so the sample data is reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const jitter = (base, pct = 0.25) => Math.round(base * (1 + (rand() - 0.5) * 2 * pct) * 100) / 100;

const months = [];
for (let y = 2025, m = 1; y < 2026 || m <= 6; m === 12 ? (y++, m = 1) : m++) {
  months.push(`${y}-${String(m).padStart(2, '0')}`);
}

const accounts = [
  { id: 'alpha-bank', name: 'Alpha Bank', kind: 'bank' },
  { id: 'beta-card', name: 'Beta Rewards Card', kind: 'credit-card' },
  { id: 'gamma-card', name: 'Gamma Cashback Card', kind: 'credit-card' }
];

// [categoryId, baseline, jitter%, accountId|null]
const expensePlan = [
  ['housing', 1400, 0, 'alpha-bank'],
  ['groceries', 520, 0.2, 'gamma-card'],
  ['transport', 180, 0.3, 'beta-card'],
  ['utilities', 210, 0.15, 'alpha-bank'],
  ['insurance', 490, 0.05, 'alpha-bank'],
  ['healthcare', 60, 0.8, null],
  ['dining', 450, 0.35, 'beta-card'],
  ['shopping', 260, 0.6, 'beta-card'],
  ['subscriptions', 62, 0.05, 'gamma-card'],
  ['entertainment', 120, 0.5, 'beta-card'],
  ['giving', 100, 0, null]
];

const monthly = [];
for (const month of months) {
  monthly.push({ month, categoryId: 'salary', accountId: 'alpha-bank', amount: 6500, source: 'manual' });
  if (month.endsWith('-12')) {
    monthly.push({ month, categoryId: 'other-income', accountId: 'alpha-bank', amount: 6500, source: 'manual' });
  }
  for (const [categoryId, base, spread, accountId] of expensePlan) {
    monthly.push({ month, categoryId, accountId, amount: jitter(base, spread), source: 'manual' });
  }
  // an annual travel splurge
  if (month.endsWith('-06')) {
    monthly.push({ month, categoryId: 'travel', accountId: 'beta-card', amount: jitter(2400, 0.2), source: 'manual' });
  }
}

const recurring = [
  {
    id: 'phone-installment', name: 'Phone installment', type: 'installment',
    amount: 74.5, frequency: 'monthly', accountId: 'beta-card',
    categoryId: 'shopping', startDate: '2025-09-01', installmentsTotal: 24
  },
  {
    id: 'gym-giro', name: 'Gym membership GIRO', type: 'giro',
    amount: 89, frequency: 'monthly', accountId: 'alpha-bank',
    categoryId: 'entertainment', startDate: '2025-01-01'
  },
  {
    id: 'life-insurance-giro', name: 'Term life GIRO', type: 'giro',
    amount: 1980, frequency: 'yearly', accountId: 'alpha-bank',
    categoryId: 'insurance', startDate: '2025-03-01'
  }
];

// Quarterly snapshots: cash drifts, investments grow, one locked product with
// a big market-vs-liquidation gap (the honest-picture toggle in action).
const snapshots = [];
let cash = 32000;
let brokerage = 38000;
let endowment = 28000;
let ilpMarket = 42000;
let ilpSurrender = 9000;
let crypto = 8000;
const quarterDates = ['2025-01-01', '2025-04-01', '2025-07-01', '2025-10-01', '2026-01-01', '2026-04-01', '2026-07-01'];
for (const date of quarterDates) {
  snapshots.push({
    date,
    values: [
      { sleeveId: 'cash', marketValue: Math.round(cash) },
      { sleeveId: 'brokerage', marketValue: Math.round(brokerage) },
      { sleeveId: 'retirement', marketValue: Math.round(endowment * 2.4) },
      { sleeveId: 'endowment', marketValue: Math.round(endowment * 4.1), liquidationValue: Math.round(endowment) },
      { sleeveId: 'crypto', marketValue: Math.round(crypto) }
    ]
  });
  cash += jitter(400, 3);
  brokerage = brokerage * (1 + jitter(0.022, 0.9)) + 3000;
  endowment *= 1.012;
  ilpMarket *= 1.03;
  ilpSurrender *= 1.06;
  crypto *= 1 + (rand() - 0.45) * 0.3;
}

fs.mkdirSync(OUT, { recursive: true });
const write = (name, value) =>
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(value, null, 2));

write('categories', SEEDS.categories);
write('accounts', accounts);
write('monthly', monthly);
write('sleeves', SEEDS.sleeves);
write('snapshots', snapshots);
write('recurring', recurring);
write('settings', SEEDS.settings);
write('import-rules', [
  { pattern: 'fairprice', categoryId: 'groceries' },
  { pattern: 'grab', categoryId: 'transport' },
  { pattern: 'netflix', categoryId: 'subscriptions' }
]);
write('import-presets', {});

console.log(`Sample data written to ${OUT} (${monthly.length} monthly records, ${snapshots.length} snapshots)`);
