import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createStore } from './lib/store.js';
import { ensureSeed, SEEDS } from './lib/seed.js';
import {
  parseCsv, applyMapping, suggestCategory,
  aggregateTransactions, mergeImport, addRules
} from './lib/importer.js';
import { extractPdfText, hasNoTextLayer } from './lib/pdf.js';
import { extractPdfViaOcr } from './lib/ocr.js';
import { getProfile, detectProfile, listProfiles } from './lib/pdf-profiles.js';
import { listStatements, resolveStatementPath } from './lib/statements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PORT = Number(process.env.PORT || 5177);
// Optional local folder of downloaded statements (e.g. one subfolder per bank)
// the Import tab can browse and pick from directly — read-only, never written to.
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

// Attach a suggested category to each parsed transaction (shared by CSV + PDF).
function decorateWithSuggestions(transactions) {
  const rules = store.read('import-rules', []);
  return transactions.map((t) => ({
    ...t,
    suggestedCategoryId: suggestCategory(t.description, rules)
  }));
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
      let meanConfidence = null;

      // Image-only statement (no text layer, e.g. HSBC's OpenText output). Offer
      // OCR; only run it when the client opts in (it's slow — seconds per page).
      if (hasNoTextLayer(extracted)) {
        if (!ocr) {
          return res.json({
            needsOcr: true,
            message: 'This PDF has no text layer — it looks like an image-only statement ' +
              '(common for HSBC). OCR can read it, but it is slower (~10-20s) and amounts ' +
              'should be verified. Run OCR?'
          });
        }
        extracted = await extractPdfViaOcr(bytes, {
          cachePath: path.join(DATA_DIR, '.tesseract-cache'),
          onProgress: (p, n) => console.log(`OCR ${filename}: page ${p}/${n}`)
        });
        ocrUsed = true;
        meanConfidence = extracted.meanConfidence;
        if (hasNoTextLayer(extracted)) {
          return res.status(422).json({ error: 'OCR found no readable text in this PDF.' });
        }
      }

      // Profile: explicit request → saved preset → auto-detect → ask the client.
      const preset = presets[accountId];
      const chosenId = profileId || (preset && preset.type === 'pdf' ? preset.profileId : null);
      const profile = chosenId ? getProfile(chosenId) : detectProfile(extracted.rawText);
      if (!profile) {
        return res.json({
          needsProfile: true,
          profiles: listProfiles(),
          detectedId: null,
          ocrUsed,
          preview: extracted.pages[0]?.lines.slice(0, 12).map((l) => l.text) || []
        });
      }
      if (profileId && savePreset) {
        presets[accountId] = { type: 'pdf', profileId };
        store.write('import-presets', presets);
      }
      const { transactions, errors, meta } = profile.parse(extracted.pages);
      store.saveImportFile(filename, content, 'base64');
      return res.json({
        transactions: decorateWithSuggestions(transactions),
        errors, meta, profileUsed: profile.id, presetUsed: !profileId,
        ocrUsed, meanConfidence
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
    res.json({ transactions: decorateWithSuggestions(transactions), errors, presetUsed: !mapping });
  } catch (err) {
    next(err);
  }
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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`finfolio running at http://127.0.0.1:${PORT}`);
  console.log(`data directory: ${DATA_DIR}`);
});
