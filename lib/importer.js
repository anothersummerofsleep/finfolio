// Statement import: CSV parsing, column mapping, categorization rules, and the
// merge into monthly aggregates. Amount convention throughout: positive = money
// out (expense), negative = money in (refund / income).

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

export function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  // No \b before cr/dr: OCR (and some banks) glue the marker straight onto the
  // number ("300.00CR"), and a digit-to-letter transition is not a word boundary.
  if (/cr\.?$/i.test(s)) { negative = true; s = s.replace(/cr\.?$/i, ''); }
  s = s.replace(/dr\.?$/i, '');
  s = s.replace(/[^0-9.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

function isoDate(y, mo, d) {
  mo = Number(mo);
  d = Number(d);
  if (!mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Returns 'YYYY-MM-DD' or null. format: 'auto' | 'DMY' | 'MDY' | 'YMD'
export function parseDate(raw, format = 'auto') {
  const s = String(raw ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/))) return isoDate(m[1], m[2], m[3]);
  if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/))) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (format === 'MDY') return isoDate(year, m[1], m[2]);
    return isoDate(year, m[2], m[1]); // DMY is the SG default
  }
  // No space required between day and month: OCR commonly glues them ("08Sep").
  if ((m = s.match(/^(\d{1,2})\s*([A-Za-z]{3,})\.?\s+(\d{2,4})$/))) {
    const mo = MONTH_NAMES[m[2].slice(0, 3).toLowerCase()];
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    if (mo) return isoDate(year, mo, m[1]);
  }
  return null;
}

// mapping: { hasHeader, dateCol, descCol, amountCol?, debitCol?, creditCol?,
//            dateFormat, expensePositive } — column values are indices.
export function applyMapping(rows, mapping) {
  const start = mapping.hasHeader ? 1 : 0;
  const transactions = [];
  const errors = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const date = parseDate(r[mapping.dateCol], mapping.dateFormat || 'auto');
    const description = String(r[mapping.descCol] ?? '').trim();
    let amount = null;
    if (mapping.amountCol != null && mapping.amountCol !== '') {
      amount = parseAmount(r[mapping.amountCol]);
      // Bank exports differ: card statements list charges as positive,
      // bank accounts list them as negative. expensePositive=false flips.
      if (amount != null && mapping.expensePositive === false) amount = -amount;
    } else {
      const debit = parseAmount(r[mapping.debitCol]);
      const credit = parseAmount(r[mapping.creditCol]);
      if (debit != null && debit !== 0) amount = Math.abs(debit);
      else if (credit != null && credit !== 0) amount = -Math.abs(credit);
    }
    if (!date || amount == null || !description) {
      errors.push({ row: i + 1, raw: r });
      continue;
    }
    transactions.push({ date, month: date.slice(0, 7), description, amount });
  }
  return { transactions, errors };
}

export function suggestCategory(description, rules) {
  const d = description.toLowerCase();
  for (const rule of rules) {
    if (rule.pattern && d.includes(rule.pattern.toLowerCase())) return rule.categoryId;
  }
  return null;
}

// Reviewed transactions ({month, categoryId, amount}) → monthly aggregates.
// Nets refunds against charges within the same month+category.
export function aggregateTransactions(transactions) {
  const map = new Map();
  for (const t of transactions) {
    if (!t.categoryId || t.categoryId === 'skip') continue;
    const key = `${t.month}|${t.categoryId}`;
    map.set(key, (map.get(key) || 0) + t.amount);
  }
  return [...map.entries()]
    .map(([key, net]) => {
      const [month, categoryId] = key.split('|');
      return { month, categoryId, amount: Math.round(Math.abs(net) * 100) / 100 };
    })
    .filter((a) => a.amount > 0.004);
}

// Re-importing a month replaces that account's previously *imported* rows for
// the affected months; manually entered rows are never touched.
export function mergeImport(monthly, accountId, aggregates) {
  const months = new Set(aggregates.map((a) => a.month));
  const kept = monthly.filter(
    (e) => !(e.source === 'import' && e.accountId === accountId && months.has(e.month))
  );
  const added = aggregates.map((a) => ({
    month: a.month,
    categoryId: a.categoryId,
    accountId,
    amount: a.amount,
    source: 'import'
  }));
  return kept.concat(added);
}

// Adds aggregates to whatever's already there for that account+month+category,
// instead of replacing the whole month like mergeImport does. For topping up a
// month that's already been imported with a further batch of categorized
// transactions (e.g. from the review queue) — using mergeImport for that would
// wipe out every other category already recorded for the touched months.
export function addImportAggregates(monthly, accountId, aggregates) {
  const out = monthly.map((e) => ({ ...e }));
  for (const a of aggregates) {
    const existing = out.find((e) =>
      e.source === 'import' && e.accountId === accountId &&
      e.month === a.month && e.categoryId === a.categoryId);
    if (existing) existing.amount = Math.round((existing.amount + a.amount) * 100) / 100;
    else out.push({ month: a.month, categoryId: a.categoryId, accountId, amount: a.amount, source: 'import' });
  }
  return out;
}

const MONTH_ABBR = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'
];

// Suggests a "YYYYMON_BANK" filename from parsed transactions — for statements
// that download with a useless generic name (e.g. Amex's export is always
// "activity.csv"). Uses the month with the most transactions (a statement's
// dominant cycle); ties go to the later month, since a card statement is
// conventionally dated by its closing month, not its opening one.
export function suggestStatementName(transactions, bankName, ext) {
  const counts = new Map();
  for (const t of transactions) {
    if (!t.month) continue;
    counts.set(t.month, (counts.get(t.month) || 0) + 1);
  }
  let best = null;
  for (const [month, count] of counts) {
    if (!best || count > best.count || (count === best.count && month > best.month)) {
      best = { month, count };
    }
  }
  if (!best) return null;
  const [y, m] = best.month.split('-');
  const bank = String(bankName || 'STATEMENT').toUpperCase().replace(/[^A-Z0-9]+/g, '') || 'STATEMENT';
  return `${y}${MONTH_ABBR[Number(m) - 1]}_${bank}.${ext}`;
}

export function addRules(existing, newRules) {
  const seen = new Set(existing.map((r) => `${r.pattern.toLowerCase()}|${r.categoryId}`));
  const out = existing.slice();
  for (const rule of newRules || []) {
    if (!rule.pattern || !rule.categoryId) continue;
    const key = `${rule.pattern.toLowerCase()}|${rule.categoryId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pattern: rule.pattern, categoryId: rule.categoryId });
  }
  return out;
}
