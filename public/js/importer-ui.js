import { el, money, toast, monthLabel, ocrClip } from './ui.js';
import { api } from './api.js';

// Import flow: pick account + file → (build column mapping if first time) →
// review transactions with suggested categories → confirm merge.

export function render(container, state) {
  container.innerHTML = '';
  const flow = state.importFlow || (state.importFlow = { step: 'pick' });

  if (!state.data.accounts.length) {
    container.append(el('p', { class: 'empty' },
      'Add your banks and cards in the Registries tab first — every import is tied to an account.'));
    return;
  }

  if (flow.step === 'pick') container.append(pickPanel(state));
  else if (flow.step === 'mapping') container.append(mappingPanel(state));
  else if (flow.step === 'ocr') container.append(ocrPanel(state));
  else if (flow.step === 'profile') container.append(profilePanel(state));
  else if (flow.step === 'review') container.append(reviewPanel(state));
}

// Read a File as a base64 string (for binary PDF upload). CSV stays plain text.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => resolve(String(reader.result).split(',').pop());
    reader.readAsDataURL(file);
  });
}

// Build the /api/import request body for the current flow. A file picked from
// the configured statements folder is identified by sourcePath — the server
// reads it directly, nothing is uploaded from the browser. A manually chosen
// file carries its content (and, for PDFs, base64 encoding) instead.
function importBody(flow, extra = {}) {
  return flow.sourcePath
    ? { accountId: flow.accountId, sourcePath: flow.sourcePath, ...extra }
    : { accountId: flow.accountId, filename: flow.filename, content: flow.content,
        encoding: flow.isPdf ? 'base64' : 'utf8', ...extra };
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function pickPanel(state) {
  const { data } = state;
  const acctSelect = el('select', {},
    ...data.accounts.map((a) => el('option', { value: a.id }, a.name)));
  const fileInput = el('input', { type: 'file', accept: '.csv,.pdf,.txt' });

  const startImport = async (flowPatch) => {
    const flow = Object.assign(state.importFlow, flowPatch);
    try {
      const result = await api.post('import', importBody(flow));
      routeResult(state, result);
      state.rerender();
    } catch (err) {
      toast(err.message, true);
    }
  };

  const upload = async () => {
    const file = fileInput.files[0];
    if (!file) return toast('Choose a statement file', true);
    const isPdf = /\.pdf$/i.test(file.name);
    await startImport({
      accountId: acctSelect.value, filename: file.name, isPdf, sourcePath: null,
      content: isPdf ? await fileToBase64(file) : await file.text()
    });
  };

  const folderSection = folderPickerSection(state, acctSelect, startImport);

  return el('div', { class: 'panel' },
    el('h2', {}, 'Import a statement'),
    el('p', { class: 'muted' },
      'CSV exports work for any bank via a one-time column mapping (saved per account). ',
      'PDF e-statements use a per-account bank profile (HSBC today; more bank by bank). ',
      'Image-only PDFs (e.g. HSBC card statements) can be read with OCR — you’ll be prompted.'),
    el('div', { class: 'actions' },
      el('label', {}, 'Account ', acctSelect),
      fileInput,
      el('button', { class: 'primary', onclick: upload }, 'Parse')),
    folderSection
  );
}

// If STATEMENTS_DIR is configured, list its files (newest first) so the user
// can import straight from a standing local folder instead of the OS file
// picker every time. Absent/misconfigured folder → this section renders
// nothing (feature is simply off, no error shown).
function folderPickerSection(state, acctSelect, startImport) {
  const box = el('div', { class: 'mt' }, el('p', { class: 'muted' }, 'Checking for a statements folder…'));

  api.get('import/browse').then((res) => {
    box.innerHTML = '';
    if (!res.enabled) return; // not configured — nothing to show
    if (!res.files.length) {
      box.append(el('p', { class: 'muted' }, `No statements found in ${res.dir}.`));
      return;
    }
    const rows = res.files.map((f) => el('tr', {},
      el('td', {}, f.path),
      el('td', { class: 'num' }, fmtSize(f.size)),
      el('td', {}, new Date(f.mtimeMs).toLocaleDateString('en-SG')),
      el('td', {}, el('button', {
        class: 'ghost',
        onclick: () => startImport({
          accountId: acctSelect.value, filename: f.path.split('/').pop(),
          sourcePath: f.path, content: null, isPdf: false
        })
      }, 'Import'))
    ));
    box.append(
      el('p', { class: 'muted' }, `Statements folder: ${res.dir}`),
      el('div', { class: 'month-grid-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'File'), el('th', { class: 'num' }, 'Size'),
            el('th', {}, 'Modified'), el('th', {}, ''))),
          el('tbody', {}, rows)))
    );
  }).catch(() => { box.innerHTML = ''; }); // silent — folder browsing is optional

  return box;
}

// Dispatch an /api/import response to the next step (shared by every panel).
function routeResult(state, result) {
  const flow = state.importFlow;
  if (result.needsMapping) {
    flow.step = 'mapping';
    flow.preview = result.preview;
    flow.columnCount = result.columnCount;
  } else if (result.needsOcr) {
    flow.step = 'ocr';
    flow.ocrMessage = result.message;
  } else if (result.needsProfile) {
    flow.step = 'profile';
    flow.profiles = result.profiles;
    flow.detectedId = result.detectedId;
    flow.preview = result.preview;
    flow.ocrUsed = result.ocrUsed || flow.ocrUsed;
  } else {
    toReview(flow, result);
  }
}

function toReview(flow, result) {
  flow.step = 'review';
  flow.transactions = decorate(result.transactions);
  flow.errors = result.errors;
  flow.profileUsed = result.profileUsed;
  flow.ocrUsed = result.ocrUsed || flow.ocrUsed;
  flow.meanConfidence = result.meanConfidence;
  flow.imageCacheId = result.imageCacheId || flow.imageCacheId;
  flow.suggestedFilename = result.suggestedFilename || null;
  flow.renamed = false;
}

// Image-only PDF: offer OCR (opt-in, since it's slow). Re-post with ocr:true.
function ocrPanel(state) {
  const flow = state.importFlow;
  const runOcr = async (ev) => {
    const btn = ev.target;
    btn.disabled = true;
    btn.textContent = 'Running OCR… (~10–20s)';
    try {
      const result = await api.post('import', importBody(flow, { ocr: true }));
      flow.ocrUsed = true;
      routeResult(state, result);
      state.rerender();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = 'Run OCR';
    }
  };

  return el('div', { class: 'panel' },
    el('h2', {}, `Read image-only PDF — ${flow.filename}`),
    el('p', { class: 'muted' }, flow.ocrMessage ||
      'This PDF has no text layer. OCR can read it, but it is slower and amounts should be verified.'),
    el('p', { class: 'warn' },
      'OCR runs entirely on your machine (no upload). It downloads a ~15MB English model once. ',
      'Every amount and date must be checked on the next screen — OCR can misread digits.'),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: runOcr }, 'Run OCR'),
      el('button', { class: 'ghost', onclick: () => { state.importFlow = { step: 'pick' }; state.rerender(); } }, 'Cancel'))
  );
}

function profilePanel(state) {
  const flow = state.importFlow;
  const profileSelect = el('select', {},
    ...flow.profiles.map((p) => el('option',
      { value: p.id, selected: p.id === flow.detectedId }, p.name)));

  const previewBox = el('div', { class: 'month-grid-wrap mb' },
    el('table', {}, el('tbody', {},
      (flow.preview || []).map((text) => el('tr', {}, el('td', {}, String(text).slice(0, 90)))))));

  const parse = async () => {
    try {
      const result = await api.post('import', importBody(flow, {
        profileId: profileSelect.value, savePreset: true, ocr: flow.ocrUsed
      }));
      if (result.needsProfile) return toast('Pick a profile', true);
      toReview(flow, result);
      state.rerender();
      toast('Profile saved for this account — next import skips this step');
    } catch (err) {
      toast(err.message, true);
    }
  };

  return el('div', { class: 'panel' },
    el('h2', {}, `Pick a bank profile — ${flow.filename}`),
    el('p', { class: 'muted' },
      'This PDF has a readable text layer. Choose the profile that matches the bank; ',
      'it locates the transaction table. Saved as a preset per account.'),
    el('p', { class: 'muted' }, 'First extracted lines:'),
    previewBox,
    el('div', { class: 'actions' },
      el('label', {}, 'Profile ', profileSelect),
      el('button', { class: 'primary', onclick: parse }, 'Parse with this profile'),
      el('button', { class: 'ghost', onclick: () => { state.importFlow = { step: 'pick' }; state.rerender(); } }, 'Start over'))
  );
}

function mappingPanel(state) {
  const flow = state.importFlow;
  const columns = Array.from({ length: flow.columnCount }, (_, i) => i);
  const headerRow = flow.preview[0] || [];
  const label = (i) => `col ${i + 1}${headerRow[i] ? ` — "${String(headerRow[i]).slice(0, 24)}"` : ''}`;

  const colSelect = (allowNone = false) => el('select', {},
    allowNone ? el('option', { value: '' }, '(none)') : null,
    ...columns.map((i) => el('option', { value: i }, label(i))));

  const dateCol = colSelect();
  const descCol = colSelect();
  const amountCol = colSelect(true);
  const debitCol = colSelect(true);
  const creditCol = colSelect(true);
  const dateFormat = el('select', {},
    el('option', { value: 'auto' }, 'auto (DD/MM default)'),
    el('option', { value: 'DMY' }, 'DD/MM/YYYY'),
    el('option', { value: 'MDY' }, 'MM/DD/YYYY'));
  const hasHeader = el('input', { type: 'checkbox', checked: true });
  const expensePositive = el('select', {},
    el('option', { value: 'true' }, 'positive numbers are charges (card statements)'),
    el('option', { value: 'false' }, 'negative numbers are charges (bank accounts)'));

  const previewTable = el('table', {},
    el('tbody', {}, flow.preview.map((row) =>
      el('tr', {}, columns.map((i) => el('td', {}, String(row[i] ?? '').slice(0, 28))))
    )));

  const parse = async () => {
    const mapping = {
      hasHeader: hasHeader.checked,
      dateCol: Number(dateCol.value),
      descCol: Number(descCol.value),
      dateFormat: dateFormat.value,
      expensePositive: expensePositive.value === 'true'
    };
    if (amountCol.value !== '') mapping.amountCol = Number(amountCol.value);
    else if (debitCol.value !== '' || creditCol.value !== '') {
      if (debitCol.value !== '') mapping.debitCol = Number(debitCol.value);
      if (creditCol.value !== '') mapping.creditCol = Number(creditCol.value);
    } else return toast('Map an amount column (or debit/credit columns)', true);

    try {
      const result = await api.post('import', importBody(flow, { mapping, savePreset: true }));
      toReview(flow, result);
      state.rerender();
      toast('Mapping saved for this account — next import skips this step');
    } catch (err) {
      toast(err.message, true);
    }
  };

  return el('div', { class: 'panel' },
    el('h2', {}, `Map columns — ${flow.filename}`),
    el('p', { class: 'muted' }, 'First import from this account: tell finfolio which column is which. Saved as a preset.'),
    el('div', { class: 'month-grid-wrap mb' }, previewTable),
    el('div', { class: 'grid cols-2' },
      el('div', {},
        el('div', { class: 'row mb' }, el('label', {}, 'Date column ', dateCol)),
        el('div', { class: 'row mb' }, el('label', {}, 'Description column ', descCol)),
        el('div', { class: 'row mb' }, el('label', {}, 'Date format ', dateFormat)),
        el('div', { class: 'row mb' }, el('label', {}, hasHeader, ' first row is a header'))
      ),
      el('div', {},
        el('div', { class: 'row mb' }, el('label', {}, 'Single amount column ', amountCol)),
        el('div', { class: 'row mb' }, el('label', {}, 'Sign convention ', expensePositive)),
        el('p', { class: 'muted' }, '…or, if debits and credits are separate columns:'),
        el('div', { class: 'row mb' }, el('label', {}, 'Debit (money out) ', debitCol)),
        el('div', { class: 'row mb' }, el('label', {}, 'Credit (money in) ', creditCol))
      )
    ),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: parse }, 'Parse with this mapping'),
      el('button', { class: 'ghost', onclick: () => { state.importFlow = { step: 'pick' }; state.rerender(); } }, 'Start over'))
  );
}

function decorate(transactions) {
  return transactions.map((t) => ({
    ...t,
    categoryId: t.suggestedCategoryId || '',
    remember: false
  }));
}

// Offers to rename the source file (only when it came from the statements
// folder and isn't already named that way) to a "YYYYMON_BANK" name — the fix
// for banks that download statements with a useless generic filename (e.g.
// Amex's CSV export is always "activity.csv"). Explicit click, not automatic.
function renameBanner(state, flow) {
  if (!flow.sourcePath || !flow.suggestedFilename) return null;
  if (flow.renamed) return el('p', { class: 'muted' }, `Renamed to ${flow.filename}.`);
  if (flow.suggestedFilename === flow.filename) return null;

  const doRename = async (ev) => {
    const btn = ev.target;
    btn.disabled = true;
    try {
      const result = await api.post('import/rename', {
        sourcePath: flow.sourcePath, newName: flow.suggestedFilename
      });
      flow.sourcePath = result.path;
      flow.filename = flow.suggestedFilename;
      flow.renamed = true;
      state.rerender();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  };

  return el('p', { class: 'muted' },
    `Suggested name: ${flow.suggestedFilename} — `,
    el('button', { class: 'ghost', onclick: doRename }, 'Rename file in statements folder'));
}

function reviewPanel(state) {
  const { data } = state;
  const flow = state.importFlow;
  const categories = data.categories;
  const summaryBox = el('div', { class: 'mt' });

  // Every field is editable — essential when the source is OCR (digits misread)
  // but harmless for CSV/text too. Date/description/amount update the txn in
  // place; the running total re-reconciles live.
  const updateSummary = () => {
    const categorized = flow.transactions.filter((t) => t.categoryId && t.categoryId !== 'skip');
    const skipped = flow.transactions.filter((t) => t.categoryId === 'skip').length;
    const unpicked = flow.transactions.length - categorized.length - skipped;
    const net = categorized.reduce((a, t) => a + (Number(t.amount) || 0), 0);
    summaryBox.innerHTML = '';
    summaryBox.append(
      el('p', { class: 'muted' },
        `${categorized.length} categorized · ${skipped} skipped · ${unpicked} unpicked ` +
        '(unpicked rows are not imported). Mark card-bill payments as "(skip)".'),
      el('p', {}, 'Net of categorized rows: ', el('strong', {}, money(net, 2)),
        el('span', { class: 'muted' }, '  — positive = money out; reconcile against your statement total.'))
    );
  };

  const rowNode = (txn) => {
    const ruleBox = el('input', {
      type: 'checkbox', checked: txn.remember,
      disabled: !txn.categoryId || txn.categoryId === 'skip',
      onchange: (e) => { txn.remember = e.target.checked; }
    });
    const cat = el('select', {
      onchange: (e) => {
        txn.categoryId = e.target.value;
        const active = !!e.target.value && e.target.value !== 'skip';
        txn.remember = active;
        ruleBox.checked = active;
        ruleBox.disabled = !active;
        updateSummary();
      }
    },
      el('option', { value: '' }, '— pick —'),
      el('option', { value: 'skip', selected: txn.categoryId === 'skip' }, "(skip)"),
      ...categories.map((c) => el('option', { value: c.id, selected: txn.categoryId === c.id }, c.name)));

    const dateInput = el('input', {
      type: 'text', value: txn.date, size: 10, class: 'edit-date',
      oninput: (e) => {
        const v = e.target.value.trim();
        e.target.classList.toggle('bad', !/^\d{4}-\d{2}-\d{2}$/.test(v));
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { txn.date = v; txn.month = v.slice(0, 7); }
      }
    });
    const descInput = el('input', {
      type: 'text', value: txn.description, class: 'edit-desc',
      oninput: (e) => { txn.description = e.target.value; }
    });
    const amtInput = el('input', {
      type: 'number', step: '0.01', value: txn.amount, class: 'num edit-amt',
      oninput: (e) => { txn.amount = Number(e.target.value); updateSummary(); }
    });
    return el('tr', {},
      el('td', {}, dateInput),
      el('td', {}, descInput, ocrClip(flow.imageCacheId, txn._ocr)),
      el('td', { class: 'num' }, amtInput),
      el('td', {}, cat),
      el('td', {}, ruleBox));
  };

  const table = el('table', {},
    el('thead', {}, el('tr', {},
      el('th', {}, 'Date'), el('th', {}, 'Description'),
      el('th', { class: 'num' }, 'Amount (+out / −in)'),
      el('th', {}, 'Category'), el('th', {}, 'Rule'))),
    el('tbody', {}, flow.transactions.map(rowNode)));
  updateSummary();

  const confirm = async () => {
    const categorized = flow.transactions.filter((t) => t.categoryId && t.categoryId !== 'skip');
    if (!categorized.length) return toast('Categorize at least one transaction', true);
    const bad = categorized.find((t) => !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !Number.isFinite(Number(t.amount)));
    if (bad) return toast('Fix the highlighted date/amount before importing', true);
    const newRules = flow.transactions
      .filter((t) => t.remember && t.categoryId && t.categoryId !== 'skip')
      .map((t) => ({ pattern: t.description.trim(), categoryId: t.categoryId }));
    try {
      const result = await api.post('import/confirm', {
        accountId: flow.accountId,
        transactions: categorized.map((t) => ({
          month: (t.date || '').slice(0, 7) || t.month, categoryId: t.categoryId, amount: Number(t.amount)
        })),
        newRules
      });
      await state.reload();
      state.importFlow = { step: 'pick' };
      state.rerender();
      toast(`Imported ${result.entriesAdded} aggregate(s) into ${result.monthsUpdated.map(monthLabel).join(', ')}`);
    } catch (err) {
      toast(err.message, true);
    }
  };

  return el('div', { class: 'panel' },
    el('h2', {}, `Review — ${flow.filename} (${flow.transactions.length} transactions)`),
    renameBanner(state, flow),
    flow.ocrUsed
      ? el('p', { class: 'warn' },
          `Read via OCR${flow.meanConfidence ? ` (~${Math.round(flow.meanConfidence)}% confidence)` : ''} — `,
          'OCR can misread digits. Verify every amount and date against your statement before importing.')
      : null,
    flow.errors?.length
      ? el('p', { class: 'warn' }, `${flow.errors.length} row(s) could not be parsed and were skipped.`)
      : null,
    el('div', { class: 'month-grid-wrap' }, table),
    summaryBox,
    el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: confirm }, 'Import categorized transactions'),
      el('button', { class: 'ghost', onclick: () => { state.importFlow = { step: 'pick' }; state.rerender(); } }, 'Cancel'))
  );
}
