import { el, money, toast, monthLabel, ocrClip } from './ui.js';
import { api } from './api.js';

// Transactions that parsed fine but were deliberately left uncategorized by
// an import (flight installments, hotels, fees, one-off foreign merchants) —
// or that failed to parse at all and need the date/description/amount typed
// in by hand. Grouped by source statement so a long backlog stays navigable.
// "Save" both commits anything categorized (added to monthly.json — on top of
// whatever's already there for that month, not replacing it) and persists
// edits to anything left for later, in one action.

function decorate(items) {
  return items.map((item) => ({ ...item, categoryId: item.categoryId || '', remember: item.remember || false }));
}

export function render(container, state) {
  container.innerHTML = '';
  const queue = state.data['review-queue'] || [];

  if (!queue.length) {
    container.append(
      el('div', { class: 'panel' },
        el('h2', {}, 'Review'),
        el('p', { class: 'empty' },
          'Nothing waiting for review. Items land here when an import leaves transactions ' +
          'uncategorized on purpose, or when a statement line couldn’t be parsed cleanly.'))
    );
    return;
  }

  const items = state.reviewQueueItems || (state.reviewQueueItems = decorate(queue));
  const categories = state.data.categories;
  const summaryBox = el('div', { class: 'mt' });

  const updateSummary = () => {
    const categorized = items.filter((t) => t.categoryId && t.categoryId !== 'skip');
    const skipped = items.filter((t) => t.categoryId === 'skip').length;
    const unpicked = items.length - categorized.length - skipped;
    const net = categorized.reduce((a, t) => a + (Number(t.amount) || 0), 0);
    summaryBox.innerHTML = '';
    summaryBox.append(
      el('p', { class: 'muted' },
        `${categorized.length} will be imported · ${skipped} will be discarded (not a real expense) · ` +
        `${unpicked} left for later.`),
      el('p', {}, 'Net of transactions to import: ', el('strong', {}, money(net, 2)))
    );
  };

  const rowNode = (item) => {
    const ruleBox = el('input', {
      type: 'checkbox', checked: item.remember,
      disabled: !item.categoryId || item.categoryId === 'skip',
      onchange: (e) => { item.remember = e.target.checked; }
    });
    const cat = el('select', {
      onchange: (e) => {
        item.categoryId = e.target.value;
        const active = !!e.target.value && e.target.value !== 'skip';
        item.remember = active;
        ruleBox.checked = active;
        ruleBox.disabled = !active;
        updateSummary();
      }
    },
      el('option', { value: '' }, '— pick —'),
      el('option', { value: 'skip', selected: item.categoryId === 'skip' }, 'not a real expense (discard)'),
      ...categories.map((c) => el('option', { value: c.id, selected: item.categoryId === c.id }, c.name)));

    const dateInput = el('input', {
      type: 'text', value: item.date || '', size: 10, class: 'edit-date',
      placeholder: 'YYYY-MM-DD',
      oninput: (e) => {
        const v = e.target.value.trim();
        e.target.classList.toggle('bad', !/^\d{4}-\d{2}-\d{2}$/.test(v));
        item.date = v;
      }
    });
    const descInput = el('input', {
      type: 'text', value: item.description || '', class: 'edit-desc',
      oninput: (e) => { item.description = e.target.value; }
    });
    const amtInput = el('input', {
      type: 'number', step: '0.01', value: item.amount ?? '', class: 'num edit-amt',
      oninput: (e) => { item.amount = e.target.value === '' ? null : Number(e.target.value); updateSummary(); }
    });
    return el('tr', {},
      el('td', {}, dateInput),
      el('td', {},
        descInput,
        ocrClip(item.imageCacheId, item._ocr),
        item.note ? el('div', { class: 'muted' }, item.note) : null),
      el('td', { class: 'num' }, amtInput),
      el('td', {}, cat),
      el('td', {}, ruleBox));
  };

  const byFile = new Map();
  for (const item of items) {
    const key = item.sourceFile || 'Unknown source';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(item);
  }

  const groups = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, groupItems]) =>
    el('div', { class: 'mb' },
      el('h3', {}, file, el('span', { class: 'muted' }, ` — ${groupItems.length} item(s)`)),
      el('div', { class: 'month-grid-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Date'), el('th', {}, 'Description'),
            el('th', { class: 'num' }, 'Amount (+out / −in)'),
            el('th', {}, 'Category'), el('th', {}, 'Rule'))),
          el('tbody', {}, groupItems.map(rowNode))))
    ));
  updateSummary();

  const save = async () => {
    const toCommit = items.filter((t) => t.categoryId && t.categoryId !== 'skip');
    const bad = toCommit.find((t) => !/^\d{4}-\d{2}-\d{2}$/.test(t.date || '') || !Number.isFinite(Number(t.amount)));
    if (bad) return toast('Fix the highlighted date/amount before saving', true);
    const newRules = items
      .filter((t) => t.remember && t.categoryId && t.categoryId !== 'skip')
      .map((t) => ({ pattern: (t.description || '').trim(), categoryId: t.categoryId }))
      .filter((r) => r.pattern);
    try {
      const result = await api.post('review-queue/commit', { items, newRules });
      await state.reload();
      state.reviewQueueItems = null; // re-decorate from the fresh (shorter) queue on next render
      state.rerender();
      toast(result.entriesAdded
        ? `Imported ${result.entriesAdded} categor${result.entriesAdded === 1 ? 'y' : 'ies'} into ` +
          `${result.monthsUpdated.map(monthLabel).join(', ')} — ${result.remaining} left for later`
        : `Saved — ${result.remaining} left for later`);
    } catch (err) {
      toast(err.message, true);
    }
  };

  container.append(
    el('div', { class: 'panel' },
      el('h2', {}, `Review (${items.length})`),
      el('p', { class: 'muted' },
        'Left out of an import on purpose — usually higher-value or ambiguous items worth a second look. ',
        'Pick a category to import a row, "not a real expense" to discard it (e.g. a mis-parsed line), ' +
        'or leave it blank to keep it here for later. Every field is editable.'),
      ...groups,
      summaryBox,
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: save }, 'Save'))
    )
  );
}
