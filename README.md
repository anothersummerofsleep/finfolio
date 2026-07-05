# finfolio

**Local-first personal finance dashboard — Node.js, no database, your data never leaves your machine.**

One page answers four questions: *Where does my money sit? How many months of runway do I have? How far to financial independence? Where does it go each month?* — plus a register of every installment plan and GIRO payment you're committed to.

## Why it exists

Personal finance tools want your bank credentials, your data on their servers, or a subscription. finfolio wants none of that:

- **Local-only.** An Express server bound to `127.0.0.1`, a static frontend, and a folder of JSON files. No accounts, no telemetry, no cloud.
- **No database.** Your entire financial state is human-readable JSON you can open, diff, back up, or version yourself. Writes are atomic (temp file + rename) and every save keeps a `.bak` of the previous version.
- **Data is separate from code.** The app reads whatever directory `DATA_DIR` points at (default `./data`, gitignored). Point it at a synced folder, an encrypted volume, or your note vault — the repo never contains a real number.

## Requirements

**Node.js 18+.** That's it — no database, no compiler toolchain, no system libraries.
The PDF/OCR pipeline (`pdfjs-dist`, `@napi-rs/canvas`, `tesseract.js`) ships as prebuilt
binaries and WASM for Linux (glibc and musl/Alpine), macOS (Intel and Apple Silicon), and
Windows — `npm install` just works, with nothing to compile.

Don't have Node yet?

```bash
# macOS (Homebrew)
brew install node

# Linux (nvm — works on any distro, no root needed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts

# Windows
winget install OpenJS.NodeJS.LTS
```

## Quick start

```bash
git clone https://github.com/anothersummerofsleep/finfolio.git
cd finfolio
npm install
npm run demo     # explore with generated sample data (throwaway copy)
npm start        # real mode — starts empty, data lives in ./data
```

Then open http://127.0.0.1:5177. Set `DATA_DIR` and/or `PORT` to override defaults.

Optionally point `STATEMENTS_DIR` at a standing local folder of downloaded statements
(subfolders welcome, e.g. one per bank) so the Import tab can list and import them
directly instead of the OS file picker every time — read-only, finfolio never writes
or deletes anything there:

```bash
# PowerShell
$env:STATEMENTS_DIR = "C:\path\to\your\statements-folder"; npm start
# bash
STATEMENTS_DIR=/path/to/your/statements-folder npm start
```

## What it does

| Panel | Question it answers |
|---|---|
| **Net worth** | Total across sleeves (bank, brokerage, retirement, insurance products, crypto) with a **market ⇄ liquidation toggle** — because an insurance product can be "worth" $55k on paper and $13k if you actually need the money. |
| **Cash runway** | Liquid funds ÷ trailing average burn, with your **committed floor** (GIRO + installments) shown separately — the part of the burn you can't cut without cancelling something. |
| **FI progress** | Assets vs FI number (trailing-12-month expenses × 25). Refuses to guess until it has 12 real months of data. |
| **Income & expenses** | Monthly bars, category breakdown, and spend-by-card/bank for whatever you've tagged. |
| **Commitments** | Every installment (with remaining balance and payoff date) and standing GIRO, plus total committed monthly outflow. |

Data entry is designed around the reality that nobody logs transactions daily:

- **Monthly granularity.** One number per category per month, entered in an editable grid built for backfilling years quickly. A cell can be split across accounts when you care; left untagged when you don't.
- **Statement import.** Upload a bank/card **CSV** (map columns once per account), a **PDF e-statement** (a per-bank profile locates the transaction table), or an **image-only PDF** (some banks render statements as page images with no text layer — read on-device with OCR). Then review with auto-suggested categories and merge. The **review screen is fully editable** — date, description, and amount — which matters for OCR, where a digit can be misread. Categorization rules grow as you correct suggestions. Re-importing a month replaces that account's imported numbers and never touches manual entries. PDF profiles ship bank by bank; an unrecognized bank falls back to a generic profile you pick.
- **Statements folder (optional).** Point `STATEMENTS_DIR` at a standing local folder of downloaded statements and the Import tab lists them (newest first) with a one-click Import — no browser file picker needed. finfolio only ever reads from this folder.
- **Apply recurring.** One click drops the month's expected GIRO/installment amounts into the grid — explicit, never automatic.

## Architecture

```
server.js            Express: static frontend + thin JSON API (localhost only)
lib/store.js         atomic JSON file store (temp+rename, .bak on every write)
lib/importer.js      CSV parsing, column mapping, categorization rules, merge
lib/pdf.js           PDF text extraction (pdfjs-dist) → positioned lines
lib/ocr.js           image-only PDFs: render (@napi-rs/canvas) + OCR (tesseract.js)
lib/pdf-profiles.js  per-bank statement parsers (one bank profile + generic fallback) → transactions
lib/statements.js    lists/resolves files under STATEMENTS_DIR (read-only, path-safe)
lib/seed.js          first-run defaults (categories, sleeves, settings)
public/js/calc.js    pure calculation module — shared by the UI and the tests
public/js/*.js       vanilla ES modules, one per tab; Chart.js for charts
test/                node:test suites for calc, importer, store, pdf, ocr, statements
```

Dependencies: **Express** (server), **Chart.js** (charts), **pdfjs-dist** (PDF text
extraction), and — for image-only statements — **@napi-rs/canvas** (page render, a
prebuilt binary, no compile step) + **tesseract.js** (OCR, WASM). No build step, no
framework. Both OCR deps run on-device; tesseract downloads its ~15MB English model
once and caches it under `DATA_DIR` — nothing is sent off the machine.

Design choices worth noting:

- **No build step, no framework.** Vanilla ES modules; the whole app is readable in one sitting.
- **Pure calculation core.** Everything numeric (net worth series, runway, FI math, installment schedules, import merging) lives in dependency-free modules tested with `node:test` — the UI is just rendering.
- **OCR reuses the text path.** Rendered-then-OCR'd pages are turned into the *same* positioned-line shape as a text PDF, so the existing bank profiles parse them with no OCR-specific code. Image-only import is "render → OCR → existing pipeline."
- **Import safety.** Parsing errors are reported, not silently dropped; uncategorized rows are never imported; the review screen is editable so OCR misreads are corrected before merge; card-bill payments can be marked "skip" to avoid double counting.
- **Statements folder is read-only and path-safe.** `lib/statements.js` only lists supported extensions and resolves a picked path with a traversal guard (`../` and absolute paths are rejected) — the server can't be tricked into reading outside `STATEMENTS_DIR`, and finfolio never writes to or deletes from that folder.

```bash
npm test         # run the test suite
npm run sample   # regenerate sample-data/ (deterministic, seeded PRNG)
npm run sample:pdf   # regenerate the fake sample bank statement PDF
```

## Roadmap

- More PDF statement profiles, one bank at a time (first profile shipped)
- Transaction-level drill-down (raw imports are already retained under `DATA_DIR/imports/`)
- Read-only integration with an Obsidian knowledge vault

OCR for image-only statements is **done** — render with @napi-rs/canvas, OCR with
tesseract.js, verify amounts in the editable review.

## License

MIT
