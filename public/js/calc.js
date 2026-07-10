// Pure calculation module — shared by the browser UI and node:test. No DOM, no IO.

const r2 = (n) => Math.round(n * 100) / 100;

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function monthDiff(fromYm, toYm) {
  const [fy, fm] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export function currentMonth(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// monthly entries → per-month totals, sorted ascending by month.
export function monthlySummary(monthly, categories) {
  const typeOf = Object.fromEntries(categories.map((c) => [c.id, c.type]));
  const map = new Map();
  for (const e of monthly) {
    if (!map.has(e.month)) {
      map.set(e.month, { month: e.month, income: 0, expense: 0, byCategory: {}, byAccount: {} });
    }
    const s = map.get(e.month);
    // Always tracked per-category so the entry is visible in breakdowns.
    s.byCategory[e.categoryId] = r2((s.byCategory[e.categoryId] || 0) + e.amount);
    // A 'transfer' category (card repayments, moving cash between your own
    // accounts) is neither income nor spend — it must not inflate expense,
    // runway or the FI number, which would otherwise double-count card spend
    // (already counted on the card side) against its bank/statement repayment.
    const type = typeOf[e.categoryId];
    if (type === 'transfer') continue;
    const kind = type === 'income' ? 'income' : 'expense';
    s[kind] = r2(s[kind] + e.amount);
    if (kind === 'expense') {
      const acct = e.accountId || 'unassigned';
      s.byAccount[acct] = r2((s.byAccount[acct] || 0) + e.amount);
    }
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

export function netWorthSeries(snapshots, sleeves) {
  const classOf = Object.fromEntries(sleeves.map((s) => [s.id, s.class]));
  return [...snapshots]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((snap) => {
      let market = 0;
      let liquidation = 0;
      const byClass = {};
      for (const v of snap.values || []) {
        const mv = v.marketValue ?? 0;
        const lv = v.liquidationValue ?? mv;
        market += mv;
        liquidation += lv;
        const cls = classOf[v.sleeveId] || 'other';
        byClass[cls] = r2((byClass[cls] || 0) + mv);
      }
      return { date: snap.date, market: r2(market), liquidation: r2(liquidation), byClass };
    });
}

export function latestSnapshot(snapshots) {
  if (!snapshots.length) return null;
  return [...snapshots].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
}

// Liquid funds = liquidation value of sleeves flagged liquid, from the latest snapshot.
export function liquidTotal(snapshot, sleeves) {
  if (!snapshot) return 0;
  const liquidIds = new Set(sleeves.filter((s) => s.liquid).map((s) => s.id));
  let total = 0;
  for (const v of snapshot.values || []) {
    if (liquidIds.has(v.sleeveId)) total += v.liquidationValue ?? v.marketValue ?? 0;
  }
  return r2(total);
}

export function lockedTotal(snapshot, sleeves, view = 'market') {
  if (!snapshot) return 0;
  const liquidIds = new Set(sleeves.filter((s) => s.liquid).map((s) => s.id));
  let total = 0;
  for (const v of snapshot.values || []) {
    if (!liquidIds.has(v.sleeveId)) {
      total += view === 'liquidation' ? (v.liquidationValue ?? v.marketValue ?? 0) : (v.marketValue ?? 0);
    }
  }
  return r2(total);
}

export function recurringMonthlyAmount(item) {
  if (item.frequency === 'quarterly') return r2(item.amount / 3);
  if (item.frequency === 'yearly') return r2(item.amount / 12);
  return r2(item.amount);
}

export function recurringEndMonth(item) {
  if (item.installmentsTotal && item.startDate) {
    return addMonths(item.startDate.slice(0, 7), item.installmentsTotal - 1);
  }
  return item.endDate ? item.endDate.slice(0, 7) : null;
}

export function isActiveInMonth(item, ym) {
  const start = item.startDate ? item.startDate.slice(0, 7) : null;
  if (start && ym < start) return false;
  const end = recurringEndMonth(item);
  if (end && ym > end) return false;
  return true;
}

export function committedMonthlyOutflow(recurring, ym) {
  return r2(
    recurring
      .filter((item) => isActiveInMonth(item, ym))
      .reduce((sum, item) => sum + recurringMonthlyAmount(item), 0)
  );
}

// For installment plans: how far along, what's left, when it ends.
export function installmentProgress(item, todayYm) {
  if (!item.installmentsTotal || !item.startDate) return null;
  const startYm = item.startDate.slice(0, 7);
  const elapsed = monthDiff(startYm, todayYm) + 1;
  const paid = Math.max(0, Math.min(item.installmentsTotal, elapsed));
  const remaining = item.installmentsTotal - paid;
  return {
    paid,
    remaining,
    remainingAmount: r2(remaining * item.amount),
    payoffMonth: addMonths(startYm, item.installmentsTotal - 1)
  };
}

// Burn = average expense over the last `windowMonths` months (before the current
// month) that actually have data. Runway = liquid funds / burn.
export function runway({ snapshot, sleeves, summaries, recurring, settings, todayYm }) {
  const cash = liquidTotal(snapshot, sleeves);
  const past = summaries.filter((s) => s.month < todayYm && s.expense > 0);
  const window = past.slice(-(settings.runwayWindowMonths || 3));
  const burn = window.length
    ? r2(window.reduce((sum, s) => sum + s.expense, 0) / window.length)
    : null;
  return {
    cash,
    burn,
    months: burn ? r2(cash / burn) : null,
    committedFloor: committedMonthlyOutflow(recurring, todayYm),
    windowUsed: window.map((s) => s.month)
  };
}

// FI number = trailing-12-month expenses × multiplier. Requires 12 full months
// of expense data — otherwise reports how many months exist so the UI can say
// "insufficient data (n/12)".
export function fiProgress({ summaries, snapshot, sleeves, settings, todayYm }) {
  const eligible = new Set(sleeves.filter((s) => s.fiEligible !== false).map((s) => s.id));
  let assets = 0;
  for (const v of snapshot?.values || []) {
    if (eligible.has(v.sleeveId)) assets += v.marketValue ?? 0;
  }
  assets = r2(assets);

  const windowStart = addMonths(todayYm, -12);
  const trailing = summaries.filter((s) => s.month >= windowStart && s.month < todayYm);
  const monthsOfData = trailing.filter((s) => s.expense > 0).length;

  const withIncome = trailing.filter((s) => s.income > 0);
  const totalIncome = withIncome.reduce((sum, s) => sum + s.income, 0);
  const totalExpenseOfIncomeMonths = withIncome.reduce((sum, s) => sum + s.expense, 0);
  const savingsRate = totalIncome > 0
    ? Math.round(((totalIncome - totalExpenseOfIncomeMonths) / totalIncome) * 1000) / 10
    : null;

  if (monthsOfData < 12) {
    return { assets, monthsOfData, insufficient: true, annualExpenses: null, fiNumber: null, progress: null, savingsRate };
  }
  const annualExpenses = r2(trailing.reduce((sum, s) => sum + s.expense, 0));
  const fiNumber = r2(annualExpenses * (settings.fiMultiplier || 25));
  return {
    assets,
    monthsOfData,
    insufficient: false,
    annualExpenses,
    fiNumber,
    progress: fiNumber ? Math.round((assets / fiNumber) * 1000) / 10 : null,
    savingsRate
  };
}
