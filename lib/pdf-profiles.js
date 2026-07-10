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
// The trailing year on the month-name form must be a full 4 digits. A 2-digit
// form here would swallow an adjacent column's day-of-month as a fake year —
// e.g. a statement with two date columns on one OCR'd line ("07 Jul 05 Jul ...",
// POST DATE then TRAN DATE) would otherwise parse as "07 Jul" + year "05".
// Transaction rows are normally year-less ("15 Jul"); a real year, when a row
// does carry one, is always written out in full on these statements.
const DATE_FORMS =
  `\\d{4}[\\/.-]\\d{1,2}[\\/.-]\\d{1,2}` +                      // ISO 2026-01-15
  `|\\d{1,2}\\s*(?:${MONTHS})[a-z]*(?:\\s+\\d{4})?` +            // 05 Jun / 05Jun (OCR) / 05 Jun 2025
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

// Where a line came from, for the "show me the source line" snippet feature —
// undefined for text-layer PDFs (lib/pdf.js's lines don't carry a page).
function lineRef(line) {
  return line.page != null ? { page: line.page, yStart: line.y, yEnd: line.y } : undefined;
}

// Infer the statement's period (start/end year+month) from its own period
// line ("07 Aug 2025 to 07 Sep 2025"), so date tokens that omit the year
// ("15 Jul") can still be resolved. Deliberately does NOT fall back to "the
// latest 4-digit year anywhere in the document" as the first resort: a
// statement can carry forward-looking dates (e.g. a payment due date, or an
// installment plan's future expiry) whose year is not the statement's own —
// scanning the whole document for the max year picks that up and mis-dates
// every year-less row on the statement.
function inferPeriod(rawText) {
  const range = rawText.match(new RegExp(`(${FULL_DATE})\\s*(?:to|thru|through|[-–—])\\s*(${FULL_DATE})`, 'i'));
  if (range) {
    const start = parseDate(range[1]);
    const end = parseDate(range[2]);
    if (start && end) {
      return {
        startYear: Number(start.slice(0, 4)), startMonth: Number(start.slice(5, 7)),
        endYear: Number(end.slice(0, 4)), endMonth: Number(end.slice(5, 7))
      };
    }
  }
  // A column-interleaved statement layout (a sidebar/address block sharing a
  // row with the header) can split the period line so the end date's year
  // lands on a different, unrelated line than the date itself ("26 Nov 2025
  // - 26 Dec" with the "2025" swept elsewhere). Retry allowing a year-less
  // end date, inheriting the start date's year — bumped by one if the end
  // month precedes the start month (a Dec/Jan-spanning cycle). Still anchored
  // by a start date that carries an explicit year, so this stays narrower
  // than the flat max-year scan below.
  const partial = rawText.match(new RegExp(
    `(${FULL_DATE})\\s*(?:to|thru|through|[-–—])\\s*(\\d{1,2}\\s+(?:${MONTHS})[a-z]*)`, 'i'));
  if (partial) {
    const start = parseDate(partial[1]);
    const endMonth = tokenMonth(partial[2]);
    if (start && endMonth) {
      const startYear = Number(start.slice(0, 4));
      const startMonth = Number(start.slice(5, 7));
      return {
        startYear, startMonth, endMonth,
        endYear: endMonth < startMonth ? startYear + 1 : startYear
      };
    }
  }
  // Last resort when no period line is found at all: a flat max-year scan
  // with no month attached (every year-less row gets this same year — the
  // one case this function can't disambiguate a Dec/Jan-spanning cycle for).
  const years = [...rawText.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (!years.length) return null;
  const year = Math.max(...years);
  return { startYear: year, startMonth: null, endYear: year, endMonth: null };
}

export function inferYear(rawText) {
  const period = inferPeriod(rawText);
  return period ? period.endYear : null;
}

const MONTH_LIST = MONTHS.split('|');

// The calendar month a date token refers to, so it can be matched against a
// statement period's start/end month (handles a Dec/Jan-spanning statement,
// where a "year-less" row must resolve to whichever year its month belongs to).
function tokenMonth(token) {
  const named = token.match(new RegExp(`(${MONTHS})`, 'i'));
  if (named) return MONTH_LIST.indexOf(named[1].toLowerCase()) + 1;
  let m;
  if ((m = token.match(/^(\d{4})[\/.-](\d{1,2})[\/.-]\d{1,2}/))) return Number(m[2]);
  if ((m = token.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-]\d{2,4})?$/))) return Number(m[2]);
  return null;
}

// Resolve a date token to YYYY-MM-DD, appending the statement period's year
// when the token omits one — picking whichever of the period's start/end
// years matches the token's own month, so Dec/Jan-spanning statements don't
// stamp every row with the same (wrong, for half of them) year.
function resolveDate(token, period) {
  const direct = parseDate(token);
  if (direct) return direct;
  if (!period) return null;
  const month = tokenMonth(token);
  const year = month === period.startMonth ? period.startYear : period.endYear;
  return parseDate(`${token} ${year}`) || parseDate(`${token}/${year}`) || null;
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

// Some statements print two date columns per row (e.g. HSBC credit-card
// statements: POST DATE, TRAN DATE) that land on the same OCR'd line. If a
// date-like token immediately follows the first one, treat it as the
// transaction date (closer to when the spend happened) and report where it
// ends, so it — and not just its day number — is excluded from the description.
function consumeSecondDate(parts) {
  const rest = parts.words.filter((w) => w.x > parts.dateEndX);
  if (!rest.length) return null;
  const m = rest.map((w) => w.str).join(' ').match(DATE_HEAD);
  if (!m) return null;
  const token = m[0].trim();
  let consumed = '';
  let endX = parts.dateEndX;
  for (const w of rest) {
    if (consumed.length >= token.length) break;
    consumed = (consumed ? `${consumed} ${w.str}` : w.str).replace(/\s+/g, ' ').trim();
    endX = w.x;
  }
  return { token, endX };
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
    // A real column-header row has "DATE" as its own word — but that alone
    // isn't a strong enough signal: ordinary legal boilerplate is full of
    // sentences that happen to contain an exact "date" AND an exact "credit"
    // word ("...the credit card statement...", "...payment due date...").
    // Different statements (and different OCR runs of the same one — the
    // page is rendered/cropped differently, which shifts how Tesseract
    // segments prose into lines) trip on different such sentences. Also
    // requiring "DESCRIPTION"/"DETAILS" — a word that only ever appears in
    // the table header, never in running prose — rules those out.
    if (!line.words.some((w) => /^date:?$/i.test(w.str))) continue;
    // Substring, not exact match: pdf.js sometimes merges "Transaction details"
    // into one token when there's little space between the words.
    if (!line.words.some((w) => /(description|details)/i.test(w.str))) continue;
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
  const period = inferPeriod(rawText);
  const cols = hsbcColumns(lines);
  // Constant per-statement description right-edge, reused to keep continuation
  // lines from absorbing text bled in from an unrelated column (e.g. a page-1
  // account-summary box OCR'd onto the same line band as the transaction list).
  const descLimit = cols ? leftmostValueX(cols, { numbers: [] }) : null;
  const transactions = [];
  const errors = [];
  let last = null;
  // "Total Due" ends the transaction table. Trailing sections (e.g. an
  // installment plan summary, with its own DATE/EXPIRY/AMOUNT/BALANCE table)
  // must never enter the transaction pipeline — they aren't transactions, and
  // their forward-looking dates/numbers could otherwise be misread as ones.
  let pastTotal = false;

  for (const line of lines) {
    if (pastTotal) continue;
    if (/^total\s+due\b/i.test(line.text)) { pastTotal = true; last = null; continue; }
    if (SKIP_ROW.test(line.text) || isDateRange(line.text)) { last = null; continue; }
    const parts = dissect(line);

    // Continuation line: no leading date → append to previous description.
    if (!parts) {
      if (last && line.text && !/\d/.test(line.text) && line.text.length < 60) {
        const words = descLimit == null ? line.words : line.words.filter((w) => w.x < descLimit);
        const extra = words.map((w) => w.str).join(' ').replace(/\s+/g, ' ').trim();
        if (extra) {
          last.description = `${last.description} ${extra}`.trim();
          if (last._ocr && line.page === last._ocr.page) last._ocr.yEnd = line.y;
        }
      }
      continue;
    }

    // A second date-like token right after the first (POST DATE, TRAN DATE on
    // one merged OCR line) is the actual transaction date; use it when it
    // resolves. Skip past it either way — even an OCR-mangled second date
    // ("08Jul" with no space, which fails to parse) must stay out of the
    // description rather than fall back to re-parsing the first date only.
    const second = consumeSecondDate(parts);
    const secondDate = second ? resolveDate(second.token, period) : null;
    const dateEndX = second ? second.endX : parts.dateEndX;

    const date = secondDate || resolveDate(parts.dateToken, period);
    if (!date) {
      // Fail loudly, not silently — but only when the token looks like a
      // genuine (mangled) transaction date, i.e. carries a month name ("5Feb").
      // A bare numeric slash/dot token ("27.80" lifted from "27.80% p.a....")
      // matches the date pattern by pure coincidence with a percentage or
      // amount in prose; escalating that to an error would just be noise.
      if (/[a-z]/i.test(parts.dateToken)) {
        const ref = lineRef(line);
        errors.push(ref ? { line: line.text, _ocr: ref } : { line: line.text });
      }
      last = null;
      continue;
    }

    const description = describe({ words: parts.words, numbers: parts.numbers, dateEndX }, leftmostValueX(cols, parts));

    // Map numbers to columns. Drop the balance column; the transaction amount is
    // withdrawal (money out, +) or deposit (money in, -). With a single Amount
    // column, a trailing CR marker (handled by parseAmount) flags a credit.
    //
    // Only trust candidates that still carry a decimal point. Every genuine
    // amount on these statements prints exactly 2 decimals; when OCR fully
    // destroys punctuation (drops both the decimal point AND the thousands
    // comma), "$1,280.00CR" becomes the digit string "128000cR" — a wildly
    // wrong but perfectly numeric-looking value ($1,280 misread as $128,000).
    // There's no reliable way to recover the true figure from digits alone,
    // so refuse to guess rather than silently accept a ~100x-wrong number.
    const trusted = parts.numbers.filter((n) => n.raw.includes('.'));
    let amount = null;
    if (cols && (cols.withdrawalX != null || cols.depositX != null)) {
      let wd = null;
      let dp = null;
      for (const n of trusted) {
        if (nearest(n.x, cols.balanceX) < nearest(n.x, cols.withdrawalX) &&
            nearest(n.x, cols.balanceX) < nearest(n.x, cols.depositX)) continue; // balance
        if (nearest(n.x, cols.withdrawalX) <= nearest(n.x, cols.depositX)) {
          if (!wd || nearest(n.x, cols.withdrawalX) < nearest(wd.x, cols.withdrawalX)) wd = n;
        } else if (!dp || nearest(n.x, cols.depositX) < nearest(dp.x, cols.depositX)) dp = n;
      }
      if (wd) amount = Math.abs(wd.value);
      else if (dp) amount = -Math.abs(dp.value);
    } else if (cols && cols.amountX != null) {
      // Bounded to a plausible column width: without this, a real amount that
      // OCR fully mangled into non-numeric text (e.g. "1,300.00CR" read as
      // "ERI") leaves no genuine candidate, and the nearest-wins comparison
      // below would otherwise happily grab an unrelated number bled in from
      // a right-hand panel on the same merged OCR line — silently wrong
      // rather than the "fail loudly" this file promises.
      const amt = trusted
        .filter((n) => nearest(n.x, cols.amountX) < nearest(n.x, cols.balanceX) && nearest(n.x, cols.amountX) < 300)
        .sort((a, b) => nearest(a.x, cols.amountX) - nearest(b.x, cols.amountX))[0];
      if (amt) amount = amt.value; // parseAmount already applied the CR sign
    } else {
      // No column map: drop the last number (running balance) if 2+ present.
      const chosen = trusted.length >= 2 ? trusted[trusted.length - 2] : trusted[0];
      if (chosen) amount = chosen.value;
    }

    const ref = lineRef(line);
    if (amount == null || !description) {
      errors.push(ref ? { line: line.text, _ocr: ref } : { line: line.text });
      last = null;
      continue;
    }
    last = ref
      ? { date, month: date.slice(0, 7), description, amount, _ocr: ref }
      : { date, month: date.slice(0, 7), description, amount };
    transactions.push(last);
  }

  return { transactions, errors, meta: { year: period ? period.endYear : null, columnsFound: !!cols } };
}

const hsbc = {
  id: 'hsbc',
  name: 'HSBC (Singapore)',
  detect: (rawText) => /\bHSBC\b/i.test(rawText),
  parse: parseHsbc
};

// ---- Trust (Trust Bank Singapore) -----------------------------------------
// Credit-card statement layout (TRANSACTION DETAILS table):
//   [Transaction date] Posting date | Description | Amount in FCY | Amount in SGD
// Two variants seen in the wild: later statements print both a Transaction-date
// and a Posting-date column; early ones omit the transaction date, leaving the
// posting date as the sole left-most date. Rather than hard-code column x's
// (they shift between the two layouts), the Description and Amount columns are
// read from the header row — the FCY/SGD amount columns sit at a stable x in
// both, so the same code parses either.
//
// Conventions that make this bank its own profile, not the generic fallback:
//   • A line is one *fragment* of a transaction. The merchant/description often
//     sits on the line(s) directly ABOVE and/or BELOW the amount line, with a
//     "1 XXX = 0.0000 SGD" foreign-exchange rate line to ignore. We anchor on
//     the amount line (leading date + an SGD amount) and gather the description
//     fragments nearest it.
//   • Money out is a plain amount; a credit (repayment, cashback, reversal) is
//     printed with a leading "+". parseAmount() drops a leading "+" (treating it
//     as positive), so the sign is taken from the raw token here instead.
//   • "Previous balance" and "Total outstanding balance" rows carry a date and a
//     figure but are statement summaries, not transactions — always skipped.
//     (Foreign-currency codes like "IDR" are NOT debit markers — Trust never
//     uses CR/DR, so the generic CR/DR handling is sidestepped.)
const TRUST_FX = /^1\s+[A-Za-z]{3}\s*=\s*[\d.]+\s+[A-Za-z]{3}$/;      // "1 JPY = 0.0083 SGD"
const TRUST_SKIP = /(previous balance|total outstanding balance|opening balance|closing balance)/i;
const TRUST_NOISE = /^(trust bank singapore|gst reg no|transaction details|page \d+ of \d+|posting date|transaction$|amount in)/i;

// Read the transaction-table header ("... Posting date | Description | Amount in
// FCY | Amount in SGD") to locate the description band and the left edge of the
// amount region. Falls back to the observed defaults if the header isn't found.
function trustHeader(lines) {
  for (const line of lines) {
    const hasPosting = /posting\s*date/i.test(line.text) || line.words.some((w) => /^posting$/i.test(w.str));
    const sgd = line.words.find((w) => /sgd/i.test(w.str));
    if (!hasPosting || !sgd) continue;
    const desc = line.words.find((w) => /description/i.test(w.str));
    const fcy = line.words.find((w) => /fcy/i.test(w.str));
    return { descX: desc ? desc.x : 141, amountMinX: (fcy ? fcy.x : 380) - 20, sgdX: sgd.x };
  }
  return null;
}

function parseTrust(pages) {
  const allLines = flattenLines(pages);
  const period = inferPeriod(allLines.map((l) => l.text).join('\n'));
  const hdr = trustHeader(allLines) || { descX: 141, amountMinX: 360, sgdX: 457 };
  const amountMinX = hdr.amountMinX;
  const descMinX = hdr.descX - 6;
  const descWords = (line) =>
    line.words.filter((w) => w.x >= descMinX && w.x < amountMinX && !moneyWord(w));

  const transactions = [];
  const errors = [];

  // Work a page at a time: a description fragment only ever attaches to an
  // anchor on its own page (rows never straddle a page break on these).
  for (const page of pages) {
    const anchors = [];   // amount lines: leading date + an SGD amount
    const descLines = []; // merchant/description-only lines (above/below an anchor)
    for (const line of page.lines) {
      if (TRUST_NOISE.test(line.text) || TRUST_FX.test(line.text)) continue;
      const dateMatch = line.text.match(DATE_HEAD);
      const sgds = line.words.map(moneyWord).filter(Boolean).filter((m) => m.x >= amountMinX);
      if (dateMatch && (line.words[0]?.x ?? 999) < descMinX && sgds.length) {
        anchors.push({ line, dateToken: dateMatch[0].trim(), sgd: sgds[sgds.length - 1] });
      } else if (descWords(line).length) {
        descLines.push(line);
      }
    }

    // Attach each description line to the vertically-nearest anchor (small gap
    // cap so a stray header/footer line can't be swallowed by a far-off row).
    const frags = new Map();
    for (const dl of descLines) {
      let best = null;
      let bestDist = Infinity;
      for (const a of anchors) {
        const d = Math.abs(a.line.y - dl.y);
        if (d < bestDist) { bestDist = d; best = a; }
      }
      if (!best || bestDist > 30) continue;
      const text = descWords(dl).map((w) => w.str).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (!frags.has(best)) frags.set(best, []);
      frags.get(best).push({ y: dl.y, text });
    }

    for (const a of anchors) {
      const parts = (frags.get(a) || []).slice();
      const inline = descWords(a.line).map((w) => w.str).join(' ').replace(/\s+/g, ' ').trim();
      if (inline) parts.push({ y: a.line.y, text: inline });
      parts.sort((p, q) => q.y - p.y); // top-to-bottom
      const description = parts.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim();

      // Statement-summary rows (opening / closing balance) are not transactions.
      if (TRUST_SKIP.test(description) || TRUST_SKIP.test(a.line.text)) continue;

      const date = resolveDate(a.dateToken, period);
      const ref = lineRef(a.line);
      if (!date || !description) {
        errors.push(ref ? { line: a.line.text, _ocr: ref } : { line: a.line.text });
        continue;
      }
      // Leading "+" marks a credit (money in) → negative in our convention.
      const amount = a.sgd.raw.trim().startsWith('+')
        ? -Math.abs(a.sgd.value) : Math.abs(a.sgd.value);
      transactions.push(ref
        ? { date, month: date.slice(0, 7), description, amount, _ocr: ref }
        : { date, month: date.slice(0, 7), description, amount });
    }
  }

  return { transactions, errors, meta: { year: period ? period.endYear : null, bank: 'trust' } };
}

const trust = {
  id: 'trust',
  name: 'Trust Bank (Singapore)',
  detect: (rawText) => /Trust Bank Singapore/i.test(rawText),
  parse: parseTrust
};

// ---- DBS credit cards -----------------------------------------------------
// "Credit Cards — Statement of Account". One statement bundles every card on the
// account (e.g. DBS Altitude Visa + Woman's World Mastercard); we collect all of
// their transactions — finfolio aggregates by month, not by card. Layout:
//   DATE | DESCRIPTION | AMOUNT (S$)
// Dates are year-less and upper-cased ("22 MAY"). A credit (payment, refund,
// cashback) prints a separate "CR" token to the right of the amount — dissect()
// already flips the sign for a trailing CR/DR token. There is no period line, so
// the year comes from the STATEMENT DATE header; a year-less row whose month is
// *after* the statement's own month belongs to the previous year (a Dec/Jan-
// spanning cycle — e.g. a "28 DEC" row on a January statement).
//
// Non-transaction rows are excluded structurally: the parse only runs between a
// card's "DATE … DESCRIPTION … AMOUNT" table header and the "GRAND TOTAL FOR ALL
// CARD ACCOUNTS" line, so the top-of-page account summary, the INSTALMENT PLANS
// SUMMARY table and the DBS POINTS SUMMARY table (whose rows begin with a plan
// code or a card number, not a date) never enter the pipeline. "PREVIOUS
// BALANCE"/"SUB-TOTAL"/"TOTAL" rows carry no leading date and are skipped too.
// Foreign-currency sub-lines ("YEN 4,568", "U. S. DOLLAR 10.00") and "REF NO:"
// lines carry no date either, so the SGD amount on the dated line is the only one
// taken. A card *payment* (the "BILL PAYMENT … CR" row) is parsed as a credit but
// is a transfer, not a refund — it must be categorised out (→ a transfer/skip
// rule), never left to net against real spend.
const DBS_CARD_TABLE_HEADER = (line) =>
  line.words.some((w) => /description/i.test(w.str)) &&
  line.words.some((w) => /amount/i.test(w.str)) &&
  line.words.some((w) => /^date/i.test(w.str));

// STATEMENT DATE header → { stmtYear, stmtMonth }. Label and value sit on
// separate rows ("STATEMENT DATE … PAYMENT DUE DATE" then "12 Jun 2026 … 07 Jul
// 2026"), so we take the first full month-name date after the label.
function dbsCardPeriod(rawText) {
  const m = rawText.match(new RegExp(
    `statement\\s*date[\\s\\S]{0,80}?(\\d{1,2}\\s+(?:${MONTHS})[a-z]*\\s+\\d{4})`, 'i'));
  const d = m ? parseDate(m[1]) : null;
  if (d) return { stmtYear: Number(d.slice(0, 4)), stmtMonth: Number(d.slice(5, 7)) };
  const period = inferPeriod(rawText);
  return period ? { stmtYear: period.endYear, stmtMonth: period.endMonth } : null;
}

// A year-less card date → YYYY-MM-DD. Its month decides the year: a month after
// the statement month rolls back to the previous year (Dec on a Jan statement).
function dbsCardResolve(token, period) {
  const direct = parseDate(token);
  if (direct) return direct;
  if (!period) return null;
  const month = tokenMonth(token);
  if (!month) return null;
  const year = period.stmtMonth != null && month > period.stmtMonth
    ? period.stmtYear - 1 : period.stmtYear;
  return parseDate(`${token} ${year}`) || null;
}

function parseDbsCard(pages) {
  const lines = flattenLines(pages);
  const rawText = lines.map((l) => l.text).join('\n');
  const period = dbsCardPeriod(rawText);
  const transactions = [];
  const errors = [];
  let inTable = false;

  for (const line of lines) {
    if (/grand\s+total\s+for\s+all\s+card\s+accounts/i.test(line.text)) break;
    if (DBS_CARD_TABLE_HEADER(line)) { inTable = true; continue; }
    if (!inTable) continue;
    if (SKIP_ROW.test(line.text)) continue;
    const parts = dissect(line);
    if (!parts) continue; // continuation / FX / REF line — no leading date

    const date = dbsCardResolve(parts.dateToken, period);
    // Only a token carrying a month name is a real (year-less) card date. A bare
    // numeric slash token would be a coincidence in prose, not a transaction.
    if (!date) {
      if (/[a-z]/i.test(parts.dateToken)) errors.push({ line: line.text });
      continue;
    }
    if (!parts.numbers.length) continue;
    // The SGD amount is the right-most money token (dissect already applied a
    // trailing CR as a sign flip → negative = credit / money in).
    const amount = parts.numbers[parts.numbers.length - 1].value;
    const description = describe(parts, parts.numbers[0].x);
    if (amount == null || !description) { errors.push({ line: line.text }); continue; }
    transactions.push({ date, month: date.slice(0, 7), description, amount });
  }

  return { transactions, errors, meta: { year: period ? period.stmtYear : null, bank: 'dbs-card' } };
}

const dbsCard = {
  id: 'dbs-card',
  name: 'DBS/POSB credit card',
  detect: (t) => /credit cards/i.test(t) && /statement of account/i.test(t) && /card no/i.test(t) && /\bDBS\b/i.test(t),
  parse: parseDbsCard
};

// ---- DBS / POSB consolidated bank statement -------------------------------
// A *consolidated* statement bundles several accounts under one cover. finfolio
// wants only the CASH accounts' cash flow (POSB Savings, DBS Multiplier); the
// CPF-Investment, SRS and Fund-Management tables are net-worth movements, not
// monthly income/expense, so they are skipped wholesale. Cash-table layout:
//   Date | Description | Withdrawal (-) | Deposit (+) | Balance
// Dates are full DD/MM/YYYY. A transaction spans several lines — reference /
// VALUE DATE continuations sit below the dated row; the descriptive ones (payee
// names) are appended so categorisation can see "FWD SINGAPORE PTE. LTD.",
// "CREDIT CARD PAYMENT", "AMEX-…". Withdrawal = money out (+); Deposit = money in
// (−); the running Balance column is dropped.
//
// Which account a row belongs to is tracked from the per-account header
// ("DBS Multiplier Account … Account No. 271-053117-5"): a header naming a cash
// account turns collection on, a header naming CPF/SRS/Fund turns it off, so an
// investment table's rows never reach the transaction pipeline. Card-repayment
// rows ("Advice Bill Payment … AMEX", "CREDIT CARD PAYMENT") are parsed like any
// other but are transfers, not spend — excluded at categorisation, same rule as
// the card statements' own "BILL PAYMENT … CR" rows.
const DBS_CASH_ACCT = /(multiplier|passbook|savings|autosave|current\s+account|everyday)/i;
const DBS_NONCASH_ACCT = /(cpf|investment|retirement|supplementary|\bsrs\b|fund\s+management|fixed\s+deposit|insurance)/i;
const DBS_BANK_HEADER = (line) =>
  /withdrawal/i.test(line.text) && /deposit/i.test(line.text) &&
  line.words.some((w) => /^date/i.test(w.str));

function dbsBankColumns(line) {
  const w = (re) => line.words.find((x) => re.test(x.str));
  return {
    withdrawalX: (w(/^withdrawal/i) || {}).x ?? null,
    depositX: (w(/^deposit/i) || {}).x ?? null,
    balanceX: (w(/^balance/i) || {}).x ?? null
  };
}

// A descriptive continuation line worth keeping on the description (a payee /
// beneficiary name) vs. a reference we drop. Payee lines are plain words
// ("FWD SINGAPORE PTE. LTD.", "CREDIT CARD PAYMENT"); every reference — the
// transaction ID, "VALUE DATE : …", account/REF numbers — carries digits. So
// "has letters, no digits" cleanly keeps the useful text and drops the noise.
function dbsKeepContinuation(text) {
  return /[A-Za-z]/.test(text) && !/\d/.test(text) && text.length <= 45;
}

function parseDbsBank(pages) {
  const lines = flattenLines(pages);
  const period = inferPeriod(lines.map((l) => l.text).join('\n'));
  const transactions = [];
  const errors = [];
  let inCash = false;
  let cols = null;
  let last = null;

  for (const line of lines) {
    // Per-account header: flips collection on/off by the account's nature.
    if (/account\s*no\.?/i.test(line.text)) {
      inCash = DBS_CASH_ACCT.test(line.text) && !DBS_NONCASH_ACCT.test(line.text);
      last = null;
      continue;
    }
    if (DBS_BANK_HEADER(line)) { cols = dbsBankColumns(line); continue; }
    if (!inCash) continue;
    if (SKIP_ROW.test(line.text)) { last = null; continue; }

    const parts = dissect(line);
    if (!parts) {
      // Continuation: append a payee name to the running transaction.
      if (last && dbsKeepContinuation(line.text)) {
        last.description = `${last.description} ${line.text}`.replace(/\s+/g, ' ').trim();
      }
      continue;
    }

    const date = resolveDate(parts.dateToken, period);
    if (!date) { last = null; continue; }

    // Map the row's numbers to columns; keep withdrawal (money out, +) or
    // deposit (money in, −), drop the running balance.
    let amount = null;
    if (cols && (cols.withdrawalX != null || cols.depositX != null)) {
      let wd = null;
      let dp = null;
      for (const n of parts.numbers) {
        if (cols.balanceX != null &&
            nearest(n.x, cols.balanceX) < nearest(n.x, cols.withdrawalX) &&
            nearest(n.x, cols.balanceX) < nearest(n.x, cols.depositX)) continue; // balance
        if (nearest(n.x, cols.withdrawalX) <= nearest(n.x, cols.depositX)) {
          if (!wd || nearest(n.x, cols.withdrawalX) < nearest(wd.x, cols.withdrawalX)) wd = n;
        } else if (!dp || nearest(n.x, cols.depositX) < nearest(dp.x, cols.depositX)) dp = n;
      }
      if (wd) amount = Math.abs(wd.value);
      else if (dp) amount = -Math.abs(dp.value);
    } else if (parts.numbers.length) {
      // No column map: drop the last number (running balance) when 2+ present.
      const chosen = parts.numbers.length >= 2 ? parts.numbers[parts.numbers.length - 2] : parts.numbers[0];
      amount = chosen.value;
    }

    const description = describe(parts, leftmostValueX(cols, parts));
    if (amount == null || !description) { errors.push({ line: line.text }); last = null; continue; }
    last = { date, month: date.slice(0, 7), description, amount };
    transactions.push(last);
  }

  return { transactions, errors, meta: { year: period ? period.endYear : null, bank: 'dbs-bank' } };
}

const dbsBank = {
  id: 'dbs-bank',
  name: 'DBS/POSB bank account',
  detect: (t) => /consolidated statement/i.test(t) && /transaction details/i.test(t) &&
    /(withdrawal|multiplier account|posb)/i.test(t),
  parse: parseDbsBank
};

// ---- Generic --------------------------------------------------------------
// Best-effort fallback for simple text-layer statements: a leading date and a
// trailing amount per line, description in between. Lower confidence — no column
// model, so it takes the last number on the line as the amount.
function parseGeneric(pages) {
  const lines = flattenLines(pages);
  const period = inferPeriod(lines.map((l) => l.text).join('\n'));
  const transactions = [];
  const errors = [];
  for (const line of lines) {
    if (SKIP_ROW.test(line.text) || isDateRange(line.text)) continue;
    const parts = dissect(line);
    if (!parts) continue;
    const date = resolveDate(parts.dateToken, period);
    if (!date) continue;
    const amount = parts.numbers.length ? parts.numbers[parts.numbers.length - 1].value : null;
    const description = describe(parts, parts.numbers.length ? parts.numbers[0].x : null);
    const ref = lineRef(line);
    if (amount == null || !description) {
      errors.push(ref ? { line: line.text, _ocr: ref } : { line: line.text });
      continue;
    }
    transactions.push(ref
      ? { date, month: date.slice(0, 7), description, amount, _ocr: ref }
      : { date, month: date.slice(0, 7), description, amount });
  }
  return { transactions, errors, meta: { year: period ? period.endYear : null } };
}

const generic = {
  id: 'generic',
  name: 'Generic (any text-layer PDF)',
  detect: () => false, // only used when explicitly chosen
  parse: parseGeneric
};

// DBS profiles come before HSBC: a DBS bank statement can carry an "HSBC:…"
// beneficiary inside a transfer description, which HSBC's loose /\bHSBC\b/
// detect would otherwise grab. DBS detects are specific, so order is safe.
export const PROFILES = [dbsBank, dbsCard, hsbc, trust, generic];

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
