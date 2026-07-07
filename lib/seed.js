// First-run defaults. Everything here is editable in the app afterwards —
// these just make an empty DATA_DIR usable immediately.

export const SEEDS = {
  categories: [
    { id: 'salary', name: 'Salary', type: 'income', group: null },
    { id: 'other-income', name: 'Other income', type: 'income', group: null },
    { id: 'housing', name: 'Housing', type: 'expense', group: 'needs' },
    { id: 'groceries', name: 'Groceries', type: 'expense', group: 'needs' },
    { id: 'transport', name: 'Transport', type: 'expense', group: 'needs' },
    { id: 'utilities', name: 'Utilities & telco', type: 'expense', group: 'needs' },
    { id: 'insurance', name: 'Insurance', type: 'expense', group: 'needs' },
    { id: 'healthcare', name: 'Healthcare', type: 'expense', group: 'needs' },
    { id: 'family', name: 'Family support', type: 'expense', group: 'needs' },
    { id: 'dining', name: 'Dining out', type: 'expense', group: 'wants' },
    { id: 'shopping', name: 'Shopping', type: 'expense', group: 'wants' },
    { id: 'subscriptions', name: 'Subscriptions', type: 'expense', group: 'wants' },
    { id: 'travel', name: 'Travel', type: 'expense', group: 'wants' },
    { id: 'entertainment', name: 'Entertainment', type: 'expense', group: 'wants' },
    { id: 'giving', name: 'Giving / donations', type: 'expense', group: 'goals' },
    { id: 'education', name: 'Courses & education', type: 'expense', group: 'goals' }
  ],
  accounts: [],
  monthly: [],
  sleeves: [
    { id: 'cash', name: 'Bank cash', class: 'cash', liquid: true, fiEligible: false },
    { id: 'brokerage', name: 'Brokerage / robo', class: 'equity', liquid: false, fiEligible: true },
    { id: 'retirement', name: 'Retirement accounts', class: 'guaranteed', liquid: false, fiEligible: true },
    { id: 'endowment', name: 'Endowment / whole-life', class: 'guaranteed', liquid: false, fiEligible: true },
    { id: 'crypto', name: 'Crypto', class: 'crypto', liquid: false, fiEligible: true }
  ],
  snapshots: [],
  recurring: [],
  settings: {
    currency: 'SGD',
    fiMultiplier: 25,
    runwayWindowMonths: 3,
    netWorthView: 'market'
  },
  'import-rules': [],
  'import-presets': {},
  // Transactions parsed successfully but left uncategorized on purpose — e.g.
  // flight installments, hotels, fees, one-off foreign merchants — surfaced on
  // their own tab so they can be reviewed and corrected without re-running an
  // import. See lib/importer.js's addImportAggregates for how committing them
  // differs from a normal statement import.
  'review-queue': []
};

export function ensureSeed(store) {
  for (const [name, value] of Object.entries(SEEDS)) {
    if (!store.exists(name)) store.write(name, value);
  }
}
