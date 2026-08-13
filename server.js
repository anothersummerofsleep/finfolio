import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createStore } from './lib/store.js';
import { ensureSeed, SEEDS } from './lib/seed.js';
import {
  parseCsv, applyMapping, suggestCategory,
  aggregateTransactions, mergeImport, addImportAggregates, addRules,
  suggestStatementName
} from './lib/importer.js';
import { extractPdfText, hasNoTextLayer } from './lib/pdf.js';
import { extractPdfViaOcr } from './lib/ocr.js';
import { paddleAvailable, extractPdfViaPaddle } from './lib/ocr-paddle.js';
import { parsePaddleTransactions } from './lib/paddle-tables.js';
import { getProfile, detectProfile, listProfiles } from './lib/pdf-profiles.js';
import { listStatements, resolveStatementPath, renameStatement } from './lib/statements.js';
import { guessAccountForProfile, buildReviewItems } from './lib/batch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PORT = Number(process.env.PORT || 5177);
// Optional local folder of downloaded statements (e.g. one subfolder per bank)
// the Import tab can browse and pick from directly — read-only, except for the
// explicit rename-in-place offered after parsing (see /api/import/rename).
const STATEMENTS_DIR = process.env.STATEMENTS_DIR ? path.resolve(process.env.STATEMENTS_DIR) : null;

const store = createStore(DATA_DIR);
ensureSeed(store);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));

const COLLECTIONS = Object.keys(SEEDS);

function validate(name, value) {
  const seed = SEEDS[name];
  if (Array.isArray(seed) && !Array.isArray(value)) return 'expected an array';
  if (!Array.isArray(seed) && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    return 'expected an object';
  }
  return null;
}

app.get('/api/:name', (req, res, next) => {
  const { name } = req.params;
  if (!COLLECTIONS.includes(name)) return next();
  res.json(store.read(name, SEEDS[name]));
});

app.put('/api/:name', (req, res, next) => {
  const { name } = req.params;
  if (!COLLECTIONS.includes(name)) return next();
  const problem = validate(name, req.body);
  if (problem) return res.status(400).json({ error: `${name}: ${problem}` });
  store.write(name, req.body);
  res.json({ ok: true });
});

// List files in the configured statements folder (if any). The client uses
// this to offer "pick from your statements folder" instead of only a native
// file picker. Disabled (enabled:false) when STATEMENTS_DIR isn't set.
app.get('/api/import/browse', (req, res) => {
  if (!STATEMENTS_DIR) return res.json({ enabled: false, files: [] });
  res.json({ enabled: true, dir: STATEMENTS_DIR, files: listStatements(STATEMENTS_DIR) });
});

// Rename a file already sitting in the statements folder to the suggested
// "YYYYMON_BANK" name offered on the review screen — a bank-downloads-as
// "activity.csv" fix (Amex), never automatic, one file at a time.
app.post('/api/import/rename', (req, res) => {
  if (!STATEMENTS_DIR) return res.status(400).json({ error: 'Statements folder is not configured' });
  const { sourcePath, newName } = req.body || {};
  if (!sourcePath || !newName) {
    return res.status(400).json({ error: 'sourcePath and newName are required' });
  }
  try {
    res.json({ ok: true, path: renameStatement(STATEMENTS_DIR, sourcePath, newName) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Crops the band around one OCR'd transaction line out of its cached page
// image, so the UI can show "here's exactly what I read" next to a row —
// the fastest way to check a suspect amount/date against the source without
// digging up the original statement. Cropped on demand (not pre-generated
// per line) since most rows are never hovered over.
app.get('/api/ocr-snippet/:cacheId/:page', async (req, res) => {
  const { cacheId, page } = req.params;
  if (!/^[a-f0-9]{24}$/.test(cacheId)) return res.status(400).json({ error: 'Invalid cache id' });
  const pageNum = Number(page);
  if (!Number.isInteger(pageNum) || pageNum < 1) return res.status(400).json({ error: 'Invalid page' });
  const yStart = Number(req.query.yStart);
  const yEnd = Number(req.query.yEnd ?? yStart);
  if (!Number.isFinite(yStart)) return res.status(400).json({ error: 'yStart is required' });

  const imgPath = path.join(DATA_DIR, '.ocr-image-cache', cacheId, `page-${pageNum}.png`);
  if (!fs.existsSync(imgPath)) {
    return res.status(404).json({ error: 'No cached image for this statement — try re-importing it.' });
  }
  try {
    const img = await loadImage(imgPath);
    const PAD = 45; // vertical breathing room around the line so context (the row above/below) is visible
    const top = Math.max(0, Math.min(yStart, yEnd) - PAD);
    const bottom = Math.min(img.height, Math.max(yStart, yEnd) + PAD);
    const height = Math.max(1, bottom - top);
    const canvas = createCanvas(img.width, height);
    canvas.getContext('2d').drawImage(img, 0, top, img.width, height, 0, 0, img.width, height);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(canvas.toBuffer('image/png'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Attach a suggested category to each parsed transaction (shared by CSV + PDF).
function decorateWithSuggestions(transactions) {
  const rules = store.read('import-rules', []);
  return transactions.map((t) => ({
    ...t,
    suggestedCategoryId: suggestCategory(t.description, rules)
  }));
}

// A "YYYYMON_BANK.ext" name for the review screen to offer as a rename, when
// the statement came from the configured folder (nothing to rename otherwise).
// Only banks/cards downloading with a useless generic filename need it (e.g.
// Amex's CSV export is always "activity.csv") — harmless to offer regardless.
function suggestedNameFor(sourcePath, transactions, accountId, ext) {
  if (!sourcePath) return null;
  const account = store.read('accounts', []).find((a) => a.id === accountId);
  return suggestStatementName(transactions, account?.name, ext);
}

// Choose the OCR engine and read an image-only PDF: the optional PaddleOCR-VL
// sidecar when it's running (more accurate, structured tables, no sidebar-crop
// needed), else the bundled tesseract. OCR_ENGINE forces one: auto (default) |
// paddle | tesseract. The caller decides WHEN to OCR (e.g. after a needsOcr
// prompt); this just runs it. Shared by /api/import and the bulk endpoint.
async function ocrExtractPdf(bytes, filename) {
  const forced = process.env.OCR_ENGINE || 'auto';
  const usePaddle = forced === 'paddle' || (forced !== 'tesseract' && await paddleAvailable());
  const imageCacheDir = path.join(DATA_DIR, '.ocr-image-cache');
  if (usePaddle) {
    const extracted = await extractPdfViaPaddle(bytes, {
      imageCacheDir,
      onProgress: (p, n) => console.log(`OCR(paddle) ${filename}: page ${p}/${n}`)
    });
    return { extracted, ocrEngine: 'paddle', meanConfidence: extracted.meanConfidence, imageCacheId: extracted.imageCacheId };
  }
  const extracted = await extractPdfViaOcr(bytes, {
    cachePath: path.join(DATA_DIR, '.tesseract-cache'),
    onProgress: (p, n) => console.log(`OCR(tesseract) ${filename}: page ${p}/${n}`),
    // The account-summary sidebar sits beside the transaction table; cropping it
    // out before OCR stops Tesseract merging the two (see lib/pdf-render.js).
    // Bumping scale to 4 was tried and rejected — it hallucinated an extra digit
    // into clean amounts. PaddleOCR needs no crop.
    cropRight: 0.7,
    imageCacheDir
  });
  return { extracted, ocrEngine: 'tesseract', meanConfidence: extracted.meanConfidence, imageCacheId: extracted.imageCacheId };
}

// Parse extracted pages with the right strategy: PaddleOCR-VL's structured HTML
// table first (falling back to the detected bank profile over synthesized lines
// if it finds nothing), otherwise the bank profile. Returns { transactions,
// errors, meta, profileUsed } — or null when a bank profile was needed
// (text-layer / tesseract path) but none matched, so the caller can ask which
// bank it is. Shared by /api/import and the bulk endpoint.
function parseByEngine(extracted, ocrEngine, profile) {
  if (ocrEngine === 'paddle') {
    let parsed = parsePaddleTransactions(extracted.pages, { rawText: extracted.rawText });
    let profileUsed = 'paddle-table';
    if (!parsed.transactions.length && profile) {
      parsed = profile.parse(extracted.pages);
      profileUsed = profile.id;
    }
    return { ...parsed, profileUsed };
  }
  if (!profile) return null;
  return { ...profile.parse(extracted.pages), profileUsed: profile.id };
}

// Parse one folder statement for the bulk-import triage — non-interactive:
// always OCRs an image-only PDF, uses the generic table parser (no per-bank
// prompt), reports the detected bank + reconciliation, and never throws for a
// single bad file (a failure comes back as { ok:false, reason }).
async function parseStatementForBatch(abs, sourcePath) {
  const filename = path.basename(abs);
  try {
    if (!/\.pdf$/i.test(filename)) {
      return { sourcePath, filename, ok: false, reason: 'Only PDF statements are supported in bulk import (import CSVs individually).' };
    }
    const bytes = fs.readFileSync(abs);
    let extracted = await extractPdfText(bytes);
    let ocrEngine = null;
    let imageCacheId = null;
    if (hasNoTextLayer(extracted)) {
      ({ extracted, ocrEngine, imageCacheId } = await ocrExtractPdf(bytes, filename));
      if (hasNoTextLayer(extracted)) return { sourcePath, filename, ok: false, reason: 'OCR found no readable text.' };
    }
    const profile = detectProfile(extracted.rawText);
    const result = parseByEngine(extracted, ocrEngine, profile);
    if (!result) return { sourcePath, filename, ok: false, reason: 'Could not identify the bank (no profile matched).' };
    return {
      sourcePath, filename, ok: true,
      ocrEngine: ocrEngine || 'text',
      detectedBank: profile ? { id: profile.id, name: profile.name } : null,
      guessedAccountId: guessAccountForProfile(profile?.id, store.read('import-presets', {})),
      txnCount: result.transactions.length,
      errorsCount: result.errors.length,
      reconciliation: result.meta?.reconciliation || null,
      imageCacheId: imageCacheId || null,
      transactions: decorateWithSuggestions(result.transactions)
    };
  } catch (err) {
    return { sourcePath, filename, ok: false, reason: err.message };
  }
}

// Parse an uploaded statement. CSV needs a per-account column mapping; PDF needs
// a per-account bank profile. When neither is known, respond with a preview so
// the client can pick one — the two "needs..." branches mirror each other.
app.post('/api/import', async (req, res, next) => {
  try {
    let {
      accountId, filename = 'statement.csv', content,
      encoding = 'utf8', mapping, profileId, savePreset, ocr, sourcePath
    } = req.body || {};

    // Importing from the configured statements folder: the server reads the
    // file itself (it's a local path, not a browser upload) — no accountId
    // requirement change, everything downstream is identical either way.
    if (sourcePath) {
      let abs;
      try { abs = resolveStatementPath(STATEMENTS_DIR, sourcePath); }
      catch (err) { return res.status(400).json({ error: err.message }); }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return res.status(404).json({ error: 'File not found in statements folder' });
      }
      filename = path.basename(abs);
      if (/\.pdf$/i.test(filename)) {
        content = fs.readFileSync(abs).toString('base64');
        encoding = 'base64';
      } else {
        content = fs.readFileSync(abs, 'utf8');
        encoding = 'utf8';
      }
    }

    if (!accountId || typeof content !== 'string') {
      return res.status(400).json({ error: 'accountId and content (or sourcePath) are required' });
    }
    const presets = store.read('import-presets', {});
    const isPdf = /\.pdf$/i.test(filename) || encoding === 'base64';

    if (isPdf) {
      const bytes = Buffer.from(content, 'base64');
      let extracted = await extractPdfText(bytes);
      let ocrUsed = false;
      let ocrEngine = null;
      let meanConfidence = null;
      let imageCacheId = null;

      // Image-only statement (no text layer, e.g. HSBC's OpenText output). Offer
      // OCR; only run it when the client opts in (it's slow — seconds per page).
      if (hasNoTextLayer(extracted)) {
        if (!ocr) {
          return res.json({
            needsOcr: true,
            message: 'This PDF has no text layer — it looks like an image-only statement ' +
              '(common for HSBC). OCR can read it. Run OCR?'
          });
        }
        ({ extracted, ocrEngine, meanConfidence, imageCacheId } = await ocrExtractPdf(bytes, filename));
        ocrUsed = true;
        if (hasNoTextLayer(extracted)) {
          return res.status(422).json({ error: 'OCR found no readable text in this PDF.' });
        }
      }

      // Profile: explicit request → saved preset → auto-detect. Used for the
      // text-layer/tesseract parse, and (on the paddle path) for labeling +
      // the fallback parse.
      const preset = presets[accountId];
      const chosenId = profileId || (preset && preset.type === 'pdf' ? preset.profileId : null);
      const profile = chosenId ? getProfile(chosenId) : detectProfile(extracted.rawText);

      const parsed = parseByEngine(extracted, ocrEngine, profile);
      if (!parsed) {
        // Text-layer PDF or tesseract OCR with no matching bank — ask the client.
        return res.json({
          needsProfile: true,
          profiles: listProfiles(),
          detectedId: null,
          ocrUsed, ocrEngine,
          preview: extracted.pages[0]?.lines.slice(0, 12).map((l) => l.text) || []
        });
      }
      if (profileId && savePreset) {
        presets[accountId] = { type: 'pdf', profileId };
        store.write('import-presets', presets);
      }

      const { transactions, errors, meta, profileUsed } = parsed;
      store.saveImportFile(filename, content, 'base64');
      return res.json({
        transactions: decorateWithSuggestions(transactions),
        errors, meta, profileUsed, presetUsed: !profileId,
        ocrUsed, ocrEngine, meanConfidence, imageCacheId,
        suggestedFilename: suggestedNameFor(sourcePath, transactions, accountId, 'pdf')
      });
    }

    const rows = parseCsv(content);
    if (!rows.length) return res.status(400).json({ error: 'No rows found in file' });

    const effective = mapping || presets[accountId];
    if (!effective || effective.type === 'pdf') {
      return res.json({
        needsMapping: true,
        preview: rows.slice(0, 8),
        columnCount: Math.max(...rows.map((r) => r.length))
      });
    }
    if (mapping && savePreset) {
      presets[accountId] = mapping;
      store.write('import-presets', presets);
    }
    const { transactions, errors } = applyMapping(rows, effective);
    store.saveImportFile(filename, content);
    res.json({
      transactions: decorateWithSuggestions(transactions), errors, presetUsed: !mapping,
      suggestedFilename: suggestedNameFor(sourcePath, transactions, accountId, 'csv')
    });
  } catch (err) {
    next(err);
  }
});

// Bulk import step 1 — parse many folder statements for triage (no writes).
// Each file is OCR'd (image-only) and parsed generically, the bank is
// auto-detected, and an account is guessed; the client shows a triage screen to
// confirm/correct the account per file before anything lands.
//
// Streamed as NDJSON, one line per file as it finishes: OCR of a whole folder
// can take many minutes, so a single buffered response would hit request
// timeouts and show no progress. Headers flush immediately; the client fills the
// triage table live. A single bad file streams { ok:false } without aborting.
app.post('/api/import/batch', async (req, res) => {
  if (!STATEMENTS_DIR) return res.status(400).json({ error: 'Statements folder is not configured' });
  const { sourcePaths } = req.body || {};
  if (!Array.isArray(sourcePaths) || !sourcePaths.length) {
    return res.status(400).json({ error: 'sourcePaths array is required' });
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  send({ type: 'start', total: sourcePaths.length });
  for (const sp of sourcePaths) {
    let file;
    try {
      let abs;
      try { abs = resolveStatementPath(STATEMENTS_DIR, sp); }
      catch (err) { abs = null; file = { sourcePath: sp, filename: sp, ok: false, reason: err.message }; }
      if (!file) {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          file = { sourcePath: sp, filename: sp, ok: false, reason: 'File not found in statements folder' };
        } else {
          file = await parseStatementForBatch(abs, sp);
        }
      }
    } catch (err) {
      file = { sourcePath: sp, filename: sp, ok: false, reason: err.message };
    }
    send({ type: 'file', file });
  }
  send({ type: 'done' });
  res.end();
});

// Bulk import step 2 — append each included file's transactions to the review
// queue (grouped by source file, one account each). Categorization then happens
// in the Review tab, whose commit is additive (addImportAggregates), so
// overlapping statement cycles top up instead of clobbering a shared month.
app.post('/api/import/batch/commit', (req, res) => {
  const { files } = req.body || {};
  if (!Array.isArray(files)) return res.status(400).json({ error: 'files array is required' });
  const queue = store.read('review-queue', []);
  let added = 0;
  let filesAdded = 0;
  for (const f of files) {
    if (!f.accountId || !Array.isArray(f.transactions) || !f.transactions.length) continue;
    const items = buildReviewItems({
      sourceFile: f.sourceFile || f.filename,
      accountId: f.accountId,
      imageCacheId: f.imageCacheId,
      transactions: f.transactions
    });
    queue.push(...items);
    added += items.length;
    filesAdded++;
  }
  if (!added) {
    return res.status(400).json({ error: 'Nothing to add — assign an account to at least one file' });
  }
  store.write('review-queue', queue);
  res.json({ ok: true, added, files: filesAdded });
});

// Merge reviewed transactions into monthly aggregates.
app.post('/api/import/confirm', (req, res) => {
  const { accountId, transactions, newRules } = req.body || {};
  if (!accountId || !Array.isArray(transactions)) {
    return res.status(400).json({ error: 'accountId and transactions are required' });
  }
  const aggregates = aggregateTransactions(transactions);
  if (!aggregates.length) return res.status(400).json({ error: 'Nothing to import — no categorized transactions' });
  const monthly = mergeImport(store.read('monthly', []), accountId, aggregates);
  store.write('monthly', monthly);
  if (newRules?.length) {
    store.write('import-rules', addRules(store.read('import-rules', []), newRules));
  }
  res.json({
    ok: true,
    entriesAdded: aggregates.length,
    monthsUpdated: [...new Set(aggregates.map((a) => a.month))].sort()
  });
});

// Save progress on the review queue: items still missing a category are
// written back for next time (edits kept); "skip" items are discarded;
// categorized items are aggregated and added to monthly.json — additively
// (addImportAggregates), not via mergeImport's replace-the-whole-month
// semantics, since these are extra categories layered onto a month whose
// obvious transactions were very likely already imported separately.
app.post('/api/review-queue/commit', (req, res) => {
  const { items, newRules } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array is required' });

  const remaining = [];
  const byAccount = new Map(); // accountId -> transactions[]
  for (const item of items) {
    if (!item.categoryId) { remaining.push(item); continue; }
    if (item.categoryId === 'skip') continue; // decided it's not a real expense — discard
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isFinite(Number(item.amount))) {
      return res.status(400).json({ error: `Fix date/amount before saving: ${item.description || item.id}` });
    }
    const list = byAccount.get(item.accountId) || [];
    list.push({ month: item.date.slice(0, 7), categoryId: item.categoryId, amount: Number(item.amount) });
    byAccount.set(item.accountId, list);
  }

  let monthly = store.read('monthly', []);
  let entriesAdded = 0;
  const monthsUpdated = new Set();
  for (const [accountId, transactions] of byAccount) {
    const aggregates = aggregateTransactions(transactions);
    monthly = addImportAggregates(monthly, accountId, aggregates);
    entriesAdded += aggregates.length;
    for (const a of aggregates) monthsUpdated.add(a.month);
  }
  store.write('monthly', monthly);
  store.write('review-queue', remaining);
  if (newRules?.length) {
    store.write('import-rules', addRules(store.read('import-rules', []), newRules));
  }
  res.json({
    ok: true,
    entriesAdded,
    monthsUpdated: [...monthsUpdated].sort(),
    remaining: remaining.length
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`finfolio running at http://127.0.0.1:${PORT}`);
  console.log(`data directory: ${DATA_DIR}`);
});
