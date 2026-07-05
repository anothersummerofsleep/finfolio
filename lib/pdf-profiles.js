// Per-bank PDF statement profiles. A profile turns the positioned lines from
// lib/pdf.js into the SAME transaction shape the CSV path produces —
// { date, month, description, amount } with amount positive = money out — so
// everything downstream (category suggestion, review, aggregate, merge) is
// reused unchanged.
//
// A profile is code, not a user-supplied column map. Each one:
//   detect(rawText) -> boolean   (is this that bank's statement?)
//   parse(pages)    -> { transactions, errors, meta }
//
// Design rule from the app: fail loudly. A row that looks like a transaction
// (starts with a date) but whose amount can't be parsed goes to `errors`, never
// silently into your numbers. Scanned/image statements (no text layer) never
// reach a profile — the server rejects them first.

import { parseAmount, parseDate } from './importer.js';

// ---- shared helpers -------------------------------------------------------

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const DATE_FORMS =
  `\\d{4}[\\/.-]\\d{1,2}[\\/.-]\\d{1,2}` +                      // ISO 2026-01-15
  `|\\d{1,2}\\s+(?:${MONTHS})[a-z]*(?:\\s+\\d{2,4})?` +          // 05 Jun / 05 Jun 2025
  `|\\d{1,2}[\\/.-]\\d{1,2}(?:[\\/.-]\\d{2,4})?`;                // 05/06 / 05/06/2025
// A leading date token, anchored at the start of a line.
const DATE_HEAD = new RegExp(`^(${DATE_FORMS})`, 'i');
// A full date carrying a year — used to spot period/range lines. Transaction
// rows use year-less dates ("15 Jul"), so requiring a year here avoids matching
// a decimal amount (e.g. "82.32") or a "TO" inside a description as a range.
const FULL_DATE =
  `\\d{4}[\\/.-]\\d{1,2}[\\/.-]\\d{1,2}` +
  `|\\d{1,2}\\s+(?:${MONTHS})[a-z]*\\s+\\d{4}` +
  `|\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{4}`;
const DATE_RANGE = new RegExp(`(?:${FULL_DATE})\\s*(?:to|thru|through|[-–—])\\s*(?:${FULL_DATE})`, 'i');
// Summary / non-transaction rows to skip even when they carry a number.
const SKIP_ROW = /\b(balance\s+(b\/?f|c\/?f|brought\s+forward|carried\s+forward)|opening\s+balance|closing\s+balance|^total\b|sub-?total|statement\s+balance|minimum\s+payment|amount\s+due)\b/i;

// A statement-period / date-range line ("01 Jun 2025 to 30 Jun 2025"): two
// full dates joined by a range connector. Not a transaction.
function isDateRange(text) {
  return DATE_RANGE.test(text);
}

function flattenLines(pages) {
  const out = [];
  for (const page of pages) for (const line of page.lines) out.push(line);
  return out;
}

// Infer the statement's year from period / statement-date lines, so date
// tokens that omit the year ("05 Jun") can still be resolved.
export function inferYear(rawText) {
  // "... 2025 to ... 2025", "Statement Date 05 Jul 2025", "as at 30 Jun 2025"
  const years = [...rawText.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (!years.length) return null;
  // The latest 4-digit year on the statement is the statement year in practice.
  return Math.max(...years);
}

// Resolve a date token to YYYY-MM-DD, appending an inferred year when absent.
function resolveDate(token, year) {
  const direct = parseDate(token);
  if (direct) return direct;
  if (year) {
    const withYear = parseDate(`${token} ${year}`) || parseDate(`${token}/${year}`);
    if (withYear) return withYear;
  }
  return null;
}

// A word is a "money" token if it is purely numeric punctuation with an optional
// CR/DR marker — e.g. "85.20", "1,234.56", "(45.00)", "12.30 CR". Reference
// numbers like "#12-34" or "REF12345" contain other characters and are excluded.
function moneyWord(w) {
  const s = w.str.trim();
  if (!/\d/.test(s)) return null;
  if (!/^[\d.,()+\-]+(?:\s*(?:cr|dr)\.?)?$/i.test(s)) return null;
  const value = parseAmount(s);
  return value == null ? null : { x: w.x, value, raw: s };
}

// Split a transaction line into a leading date, its money tokens (with x
// positions so a profile can map them to columns), and the x where the date
// token ends. Description is left to each profile (column-position aware).
// Returns { dateToken, dateEndX, numbers:[{x,value,raw}], words } or null.
function dissect(line) {
  const dateMatch = line.text.match(DATE_HEAD);
  if (!dateMatch) return null;
  const dateToken = dateMatch[0].trim();

  const numbers = [];
  for (const w of line.words) {
    const m = moneyWord(w);
    if (m) { numbers.push(m); continue; }
    // A standalone "CR"/"DR" token (common in OCR, where the marker is split
    // from its amount) sets the sign of the preceding number: CR = money in.
    const s = w.str.trim();
    if (/^(cr|dr)\.?$/i.test(s) && numbers.length) {
      const last = numbers[numbers.length - 1];
      last.value = /^cr/i.test(s) ? -Math.abs(last.value) : Math.abs(last.value);
    }
  }

  // x where the date token ends: consume words left-to-right until their joined
  // text covers the date token (robust whether pdfjs emitted "05 Jun" as one
  // word or as "05" + "Jun"). Description words are those to the right of it.
  let consumed = '';
  let dateEndX = line.words[0]?.x ?? 0;
  for (const w of line.words) {
    if (consumed.length >= dateToken.length) break;
    consumed = (consumed ? `${consumed} ${w.str}` : w.str).replace(/\s+/g, ' ').trim();
    dateEndX = w.x;
  }
  return { dateToken, dateEndX, numbers, words: line.words };
}

// Description = non-money words positioned after the date and left of the first
// value column (dateEndX < x < toX). When no boundary is known, toX is Infinity
// and all non-money words after the date are taken.
function describe(parts, toX) {
  const limit = toX ?? Infinity;
  const money = new Set(parts.numbers.map((n) => n.x));
  return parts.words
    .filter((w) => w.x > parts.dateEndX && w.x < limit && !money.has(w.x))
    .map((w) => w.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nearest(x, targetX) {
  return targetX == null ? Infinity : Math.abs(x - targetX);
}

// ---- HSBC -----------------------------------------------------------------
// Calibrated to HSBC Singapore account-statement layout:
//   Date | Transaction details | Withdrawal | Deposit | Balance
// (also handles the "Paid out / Paid in" wording). Column x-positions are read
// from the header row, so it survives minor layout shifts. NOTE: validated
// against a synthetic fixture — a real text-layer HSBC statement should be run
// through it to confirm the x-bands before trusting production numbers.
function hsbcColumns(lines) {
  for (const line of lines) {
    if (!/date/i.test(line.text)) continue;
    const word = (re) => line.words.find((w) => re.test(w.str));
    // "Withdrawal"/"Debit" or the two-word "Paid out"; "Deposit"/"Credit" or "Paid in".
    const paidWords = line.words.filter((w) => /^paid$/i.test(w.str));
    const wd = word(/^(withdrawal|debit)$/i) || (/paid\s*out/i.test(line.text) ? paidWords[0] : null);
    const dp = word(/^(deposit|credit)$/i) || (/paid\s*in/i.test(line.text) ? paidWords[paidWords.length - 1] : null);
    const balance = word(/^balance$/i);
    const amount = word(/^amount/i);
    if (wd || dp || amount) {
      return {
        withdrawalX: wd?.x ?? null,
        depositX: dp?.x ?? null,
        balanceX: balance?.x ?? null,
        amountX: amount?.x ?? null
      };
    }
  }
  return null;
}

function leftmostValueX(cols, parts) {
  if (cols) {
    const xs = [cols.withdrawalX, cols.depositX, cols.amountX].filter((x) => x != null);
    if (xs.length) return Math.min(...xs);
  }
  return parts.numbers.length ? parts.numbers[0].x : null;
}

function parseHsbc(pages) {
  const lines = flattenLines(pages);
  const rawText = lines.map((l) => l.text).join('\n');
  const year = inferYear(rawText);
  const cols = hsbcColumns(lines);
  const transactions = [];
  const errors = [];
  let last = null;

  for (const line of lines) {
    if (SKIP_ROW.test(line.text) || isDateRange(line.text)) { last = null; continue; }
    const parts = dissect(line);

    // Continuation line: no leading date → append to previous description.
    if (!parts) {
      if (last && line.text && !/\d/.test(line.text) && line.text.length < 60) {
        last.description = `${last.description} ${line.text}`.trim();
      }
      continue;
    }

    const date = resolveDate(parts.dateToken, year);
    if (!date) { last = null; continue; } // date-like header noise, not a txn

    const description = describe(parts, leftmostValueX(cols, parts));

    // Map numbers to columns. Drop the balance column; the transaction amount is
    // withdrawal (money out, +) or deposit (money in, -). With a single Amount
    // column, a trailing CR marker (handled by parseAmount) flags a credit.
    let amount = null;
    if (cols && (cols.withdrawalX != null || cols.depositX != null)) {
      let wd = null;
      let dp = null;
      for (const n of parts.numbers) {
        if (nearest(n.x, cols.balanceX) < nearest(n.x, cols.withdrawalX) &&
            nearest(n.x, cols.balanceX) < nearest(n.x, cols.depositX)) continue; // balance
        if (nearest(n.x, cols.withdrawalX) <= nearest(n.x, cols.depositX)) {
          if (!wd || nearest(n.x, cols.withdrawalX) < nearest(wd.x, cols.withdrawalX)) wd = n;
        } else if (!dp || nearest(n.x, cols.depositX) < nearest(dp.x, cols.depositX)) dp = n;
      }
      if (wd) amount = Math.abs(wd.value);
      else if (dp) amount = -Math.abs(dp.value);
    } else if (cols && cols.amountX != null) {
      const amt = parts.numbers
        .filter((n) => nearest(n.x, cols.amountX) < nearest(n.x, cols.balanceX))
        .sort((a, b) => nearest(a.x, cols.amountX) - nearest(b.x, cols.amountX))[0];
      if (amt) amount = amt.value; // parseAmount already applied the CR sign
    } else {
      // No column map: drop the last number (running balance) if 2+ present.
      const nums = parts.numbers;
      const chosen = nums.length >= 2 ? nums[nums.length - 2] : nums[0];
      if (chosen) amount = chosen.value;
    }

    if (amount == null || !description) {
      errors.push({ line: line.text });
      last = null;
      continue;
    }
    last = { date, month: date.slice(0, 7), description, amount };
    transactions.push(last);
  }

  return { transactions, errors, meta: { year, columnsFound: !!cols } };
}

const hsbc = {
  id: 'hsbc',
  name: 'HSBC (Singapore)',
  detect: (rawText) => /\bHSBC\b/i.test(rawText),
  parse: parseHsbc
};

// ---- Generic --------------------------------------------------------------
// Best-effort fallback for simple text-layer statements: a leading date and a
// trailing amount per line, description in between. Lower confidence — no column
// model, so it takes the last number on the line as the amount.
function parseGeneric(pages) {
  const lines = flattenLines(pages);
  const year = inferYear(lines.map((l) => l.text).join('\n'));
  const transactions = [];
  const errors = [];
  for (const line of lines) {
    if (SKIP_ROW.test(line.text) || isDateRange(line.text)) continue;
    const parts = dissect(line);
    if (!parts) continue;
    const date = resolveDate(parts.dateToken, year);
    if (!date) continue;
    const amount = parts.numbers.length ? parts.numbers[parts.numbers.length - 1].value : null;
    const description = describe(parts, parts.numbers.length ? parts.numbers[0].x : null);
    if (amount == null || !description) { errors.push({ line: line.text }); continue; }
    transactions.push({ date, month: date.slice(0, 7), description, amount });
  }
  return { transactions, errors, meta: { year } };
}

const generic = {
  id: 'generic',
  name: 'Generic (any text-layer PDF)',
  detect: () => false, // only used when explicitly chosen
  parse: parseGeneric
};

export const PROFILES = [hsbc, generic];

export function getProfile(id) {
  return PROFILES.find((p) => p.id === id) || null;
}

// First profile whose detect() matches, or null (client then picks one).
export function detectProfile(rawText) {
  return PROFILES.find((p) => p.detect(rawText)) || null;
}

export function listProfiles() {
  return PROFILES.map((p) => ({ id: p.id, name: p.name }));
}
