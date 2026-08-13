// Table-first parsing for the PaddleOCR-VL engine. Unlike tesseract (which
// yields word-positioned lines that the per-bank profiles reassemble by
// geometry), PaddleOCR-VL returns each region as a semantic block, and the
// transaction table comes back as a clean HTML <table> with multi-line
// descriptions and FX lines already merged into cells. So the Paddle path reads
// that table directly here, instead of forcing clean data back through the
// profiles' OCR-damage-recovery heuristics.
//
// Output is the SAME { date, month, description, amount } shape (amount positive
// = money out) the CSV and profile paths produce, so review/aggregate/merge are
// reused unchanged. Fail-loud rule is kept: a row that reads as a transaction
// (has an amount) but whose date can't be resolved is still surfaced — with an
// empty, editable date — rather than silently dropped or dated by guesswork.

import { parseAmount, parseDate } from './importer.js';
import { inferPeriod, resolveDate } from './pdf-profiles.js';

// Strip tags, collapse whitespace, decode the handful of entities a table cell
// realistically carries.
function cellText(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/�/g, ' ')      // OCR "unreadable glyph" replacement char
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse one HTML <table> string into a matrix of cell strings.
export function parseHtmlTable(html) {
  const rows = [];
  for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cellText(m[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
// A leading date token, capturing any text glued after it. Anchored on a real
// month name (not just "\d\d [A-Za-z]{3}") so a merchant like "24 HRS MART" is
// NOT misread as a date. Group 1 = the date token, group 2 = the remainder,
// which is the description when PaddleOCR merges the TRAN-date and description
// columns into one cell on continuation pages ("09 Dec SUSHI EXPRESS SG").
const DATE_LEAD = new RegExp(`^(\\d{1,2}\\s*(?:${MONTHS})[a-z]*(?:\\s+\\d{2,4})?)\\b\\s*(.*)$`, 'i');
const MONEY_CELL = /^[+\-]?[\d,]+\.\d{2}\s*(?:cr|dr)?$/i; // "1,234.56", "45.00CR", "+5.00"
// Summary / non-transaction rows to skip even when they carry a number. Tested
// against the row's DESCRIPTION (the lettered cells, with empties already
// stripped) so a leading blank cell can't offset the anchor — and anchored at
// the start so a merchant like "TOTALSPORTS" (no word boundary after "total")
// survives while a bare "TOTAL" / "Total Due" / "Minimum Payment" summary is
// dropped. These leak in via page-continuation fragments where PaddleOCR pulls
// a summary line into the transaction table.
const SKIP_DESC =
  /^(total\b|sub-?total\b|grand\s+total\b|previous\b|opening\b|closing\b|current\b|statement\b|outstanding\b|minimum\s+payment|amount\s+due|balance\b|credit\s+limit|available\s+credit)/i;

function isMoneyCell(s) { return MONEY_CELL.test(s.replace(/\s+/g, '')); }
function hasLetter(s) { return /[A-Za-z]/.test(s); }

// A table is the transaction table when its header row names both a description
// and an amount column. This excludes the account-summary, rewards, credit-limit
// and installment-plan tables that share a statement page (the installment table
// carries AMOUNT + BALANCE but no DESCRIPTION, so it's correctly left out).
export function isTransactionTable(rows) {
  if (!rows.length) return false;
  const header = rows[0].join(' ').toUpperCase();
  return /DESCRIPTION/.test(header) && /AMOUNT/.test(header);
}

// Map one data row's cells to a transaction. Column count is read per row, not
// from the header, because PaddleOCR-VL can split a wrapped header ("POST DATE"
// -> "POST" | "DATE") into more cells than the data rows have. The rules that
// hold across the real statements seen:
//   • amount  = the right-most money cell (the transaction table has a single
//     amount column; a running-balance column only appears in tables we've
//     already excluded). A trailing CR (or a leading +) marks money in.
//   • date    = the last date-like leading cell (HSBC prints POST then TRAN date;
//     the transaction date is the TRAN, i.e. the later one). Year-less tokens
//     resolve against the statement period.
//   • description = the text cells between the dates and the amount.
function rowToTransaction(cells, period) {
  // Right-most money cell is the amount.
  let amountIdx = -1;
  for (let i = cells.length - 1; i >= 0; i--) {
    if (isMoneyCell(cells[i])) { amountIdx = i; break; }
  }
  if (amountIdx === -1) return null; // no amount -> section header / note, not a transaction

  const rawAmt = cells[amountIdx].replace(/\s+/g, '');
  const value = parseAmount(rawAmt);
  if (value == null) return null;
  // parseAmount treats a leading "+" as positive, but on these statements "+"
  // marks a credit (money in). CR is already handled by parseAmount.
  const amount = rawAmt.startsWith('+') ? -Math.abs(value) : value;

  // Split each leading cell (before the amount) into a date token + description
  // text. A cell may hold just a date ("09 Dec"), just description ("SUSHI SG"),
  // or — when PaddleOCR merges the TRAN-date and description columns on a
  // continuation page — a date with the description glued after it. Transaction
  // date = the last real date token (HSBC prints POST then TRAN).
  let dateToken = null;
  const descParts = [];
  for (let i = 0; i < amountIdx; i++) {
    const cell = cells[i];
    if (!cell) continue;
    const m = cell.match(DATE_LEAD);
    if (m) {
      dateToken = m[1];
      if (hasLetter(m[2])) descParts.push(m[2].trim());
    } else if (hasLetter(cell)) {
      descParts.push(cell);
    }
  }
  const date = dateToken ? resolveDate(dateToken, period) : null;
  const description = descParts.join(' ').replace(/\s+/g, ' ').trim();
  if (!description) return null;
  if (SKIP_DESC.test(description)) return null; // summary row (Total Due, balance, …)

  return {
    date: date || '',
    month: date ? date.slice(0, 7) : '',
    description,
    amount,
    dateResolved: !!date
  };
}

// Interpolate a rendered-pixel y-band for a table row from the block bbox, so
// the review row can still show the "here's what I read" image snippet. bbox is
// [x0,y0,x1,y1] in the same page-pixel space as the cached page image.
function rowRef(bbox, page, rowIndex, rowCount) {
  if (!bbox || page == null) return undefined;
  const [, y0, , y1] = bbox;
  const h = (y1 - y0) / Math.max(rowCount, 1);
  return { page, yStart: Math.round(y0 + rowIndex * h), yEnd: Math.round(y0 + (rowIndex + 1) * h) };
}

function matchAmount(text, re) {
  const m = text.match(re);
  return m ? parseAmount(m[1] + (m[2] || '')) : null;
}

// Reconcile against the statement's own printed totals. HSBC's ACCOUNT SUMMARY
// prints "Purchases & Debits" (money out this cycle) and "Payments & Credits"
// (money in, marked CR); the parsed transactions' net must equal their
// difference. PaddleOCR-VL is a generative model and can silently omit a row, so
// this turns a dropped transaction into a loud, checkable mismatch instead of a
// wrong total. Returns null when the labels aren't present (e.g. a non-HSBC
// statement) so no false alarm is raised. Amounts may carry a thousands comma
// and the credit "CR" marker; the label/value gap tolerates the "& Debits" text.
export function extractStatementSummary(rawText) {
  const purchases = matchAmount(rawText, /purchases\b[^\d]{0,24}?([\d,]+\.\d{2})/i);
  const payments = matchAmount(rawText, /payments\b[^\d]{0,24}?([\d,]+\.\d{2})(\s*cr)?/i);
  if (purchases == null && payments == null) return null;
  // parseAmount returns a CR value as negative; payments are money in, so their
  // magnitude is what we subtract.
  const expectedNet = Math.round(((purchases || 0) - Math.abs(payments || 0)) * 100) / 100;
  return { purchases, payments: payments == null ? null : Math.abs(payments), expectedNet };
}

// pages: [{ page, blocks: [{ label, content, bbox }] }] from the sidecar.
// Returns { transactions, errors, meta } — same shape a profile.parse yields.
export function parsePaddleTransactions(pages, opts = {}) {
  const rawText = opts.rawText || '';
  const period = inferPeriod(rawText);
  const transactions = [];
  const errors = [];
  let tablesFound = 0;

  for (const pg of pages) {
    for (const block of pg.blocks || []) {
      if (block.label !== 'table' || typeof block.content !== 'string') continue;
      const rows = parseHtmlTable(block.content);
      if (!isTransactionTable(rows)) continue;
      tablesFound++;
      for (let r = 1; r < rows.length; r++) { // row 0 is the header
        const txn = rowToTransaction(rows[r], period);
        if (!txn) continue; // no amount -> section header / note, silently skipped
        delete txn.dateResolved;
        const ref = rowRef(block.bbox, pg.page, r, rows.length);
        // A row with a real amount + description but no resolvable date is kept
        // with an empty (editable) date, NOT dropped — it shows in the review as
        // a flagged row the user completes (the review blocks commit on a bad
        // date). So it never lands in `errors`, which the UI reports as skipped.
        transactions.push(ref ? { ...txn, _ocr: ref } : txn);
      }
    }
  }

  // Reconcile the parsed net against the statement's printed summary, so a row
  // PaddleOCR dropped surfaces as a flagged mismatch in review.
  const summary = extractStatementSummary(rawText);
  let reconciliation = null;
  if (summary) {
    const parsedNet = Math.round(transactions.reduce((a, t) => a + (Number(t.amount) || 0), 0) * 100) / 100;
    const diff = Math.round((parsedNet - summary.expectedNet) * 100) / 100;
    reconciliation = { expectedNet: summary.expectedNet, parsedNet, diff, ok: Math.abs(diff) <= 0.005 };
  }

  return {
    transactions,
    errors,
    meta: { engine: 'paddle', tablesFound, year: period ? period.endYear : null, reconciliation }
  };
}
