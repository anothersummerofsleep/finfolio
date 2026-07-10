import { el, money, toast, monthLabel } from './ui.js';
import { addMonths, currentMonth, isActiveInMonth, recurringMonthlyAmount } from './calc.js';

// Editable month × category grid with an entry editor per cell (supports
// splitting one cell across accounts) and backfill paging into the past.

const WINDOW = 13;

export function render(container, state) {
  container.innerHTML = '';
  const { data } = state;
  if (state.gridEnd == null) state.gridEnd = currentMonth();

  const months = [];
  for (let i = WINDOW - 1; i >= 0; i--) months.push(addMonths(state.gridEnd, -i));

  const header = el('div', { class: 'flex spread mb' },
    el('div', { class: 'flex' },
      el('button', { class: 'ghost', onclick: () => { state.gridEnd = addMonths(state.gridEnd, -6); state.rerender(); } }, '◀ older'),
      el('button', { class: 'ghost', onclick: () => { state.gridEnd = addMonths(state.gridEnd, 6); state.rerender(); } }, 'newer ▶'),
      el('button', { class: 'ghost', onclick: () => { state.gridEnd = currentMonth(); state.rerender(); } }, 'today')
    ),
    el('div', { class: 'flex' },
      el('label', {}, 'Jump to month ', el('input', {
        type: 'month',
        onchange: (e) => { if (e.target.value) { state.gridEnd = e.target.value; state.rerender(); } }
      })),
      applyRecurringControl(state, months)
    )
  );

  container.append(header, gridTable(state, months));
  if (state.editingCell) container.append(cellEditor(state));
}

function entriesFor(data, month, categoryId) {
  return data.monthly.filter((e) => e.month === month && e.categoryId === categoryId);
}

function gridTable(state, months) {
  const { data } = state;
  const groups = [
    ['Income', data.categories.filter((c) => c.type === 'income')],
    ['Needs', data.categories.filter((c) => c.type === 'expense' && c.group === 'needs')],
    ['Wants', data.categories.filter((c) => c.type === 'expense' && c.group === 'wants')],
    ['Goals', data.categories.filter((c) => c.type === 'expense' && c.group === 'goals')],
    ['Other', data.categories.filter((c) => c.type === 'expense' && !['needs', 'wants', 'goals'].includes(c.group))],
    // Transfers (card repayments, moving cash between own accounts) — tracked
    // and editable here, but excluded from the Net row and all spend metrics.
    ['Transfers', data.categories.filter((c) => c.type === 'transfer')]
  ].filter(([, cats]) => cats.length);

  const thead = el('thead', {}, el('tr', {},
    el('th', {}, 'Category'),
    ...months.map((m) => el('th', { class: 'num' }, monthLabel(m)))
  ));

  const tbody = el('tbody');
  for (const [label, cats] of groups) {
    tbody.append(el('tr', { class: 'group-row' }, el('td', { colspan: months.length + 1 }, label)));
    for (const cat of cats) {
      tbody.append(el('tr', {},
        el('td', {}, cat.name),
        ...months.map((m) => {
          const entries = entriesFor(data, m, cat.id);
          const total = entries.reduce((s, e) => s + e.amount, 0);
          const hasImport = entries.some((e) => e.source === 'import');
          return el('td', {
            class: 'num editable',
            onclick: () => { state.editingCell = { month: m, categoryId: cat.id }; state.rerender(); }
          },
            total ? money(total, 0) : el('span', { class: 'muted' }, '·'),
            hasImport ? el('span', { class: 'badge import', title: 'includes imported data' }, 'i') : null
          );
        })
      ));
    }
  }

  const totals = months.map((m) => {
    const typeOf = Object.fromEntries(data.categories.map((c) => [c.id, c.type]));
    let net = 0;
    for (const e of data.monthly) {
      if (e.month !== m) continue;
      const type = typeOf[e.categoryId];
      if (type === 'transfer') continue; // not income or spend — excluded from Net
      net += type === 'income' ? e.amount : -e.amount;
    }
    return net;
  });
  tbody.append(el('tr', { class: 'total-row' },
    el('td', {}, 'Net (income − expenses)'),
    ...totals.map((t) => el('td', { class: `num ${t >= 0 ? 'pos' : 'neg'}` }, t ? money(t, 0) : '·'))
  ));

  return el('div', { class: 'month-grid-wrap panel' },
    el('table', { class: 'month-grid' }, thead, tbody));
}

function cellEditor(state) {
  const { data } = state;
  const { month, categoryId } = state.editingCell;
  const cat = data.categories.find((c) => c.id === categoryId);
  const existing = entriesFor(data, month, categoryId);
  const rows = existing.length
    ? existing.map((e) => ({ accountId: e.accountId || '', amount: e.amount, source: e.source || 'manual' }))
    : [{ accountId: '', amount: '', source: 'manual' }];

  const rowsBox = el('div');
  const drawRows = () => {
    rowsBox.innerHTML = '';
    rows.forEach((row, i) => {
      rowsBox.append(el('div', { class: 'row' },
        el('select', {
          onchange: (e) => { row.accountId = e.target.value; }
        },
          el('option', { value: '' }, '(no account)'),
          ...data.accounts.map((a) => el('option', { value: a.id, selected: row.accountId === a.id }, a.name))
        ),
        el('input', {
          class: 'cell', type: 'number', step: '0.01', min: '0', value: row.amount,
          oninput: (e) => { row.amount = e.target.value; }
        }),
        row.source !== 'manual' ? el('span', { class: `badge ${row.source}` }, row.source) : null,
        el('button', { class: 'ghost', onclick: () => { rows.splice(i, 1); drawRows(); } }, '✕')
      ));
    });
  };
  drawRows();

  const save = async () => {
    const cleaned = rows
      .map((r) => ({ ...r, amount: Number(r.amount) }))
      .filter((r) => r.amount > 0);
    const kept = data.monthly.filter((e) => !(e.month === month && e.categoryId === categoryId));
    for (const r of cleaned) {
      kept.push({
        month, categoryId,
        accountId: r.accountId || null,
        amount: Math.round(r.amount * 100) / 100,
        source: r.source
      });
    }
    data.monthly = kept;
    await state.save('monthly');
    state.editingCell = null;
    state.rerender();
    toast(`Saved ${monthLabel(month)} · ${cat.name}`);
  };

  return el('div', { class: 'editor' },
    el('div', { class: 'flex spread' },
      el('b', {}, `${monthLabel(month)} — ${cat.name}`),
      el('span', { class: 'muted' }, 'split across accounts if useful')
    ),
    el('div', { class: 'mt' }, rowsBox),
    el('div', { class: 'actions' },
      el('button', { class: 'ghost', onclick: () => { rows.push({ accountId: '', amount: '', source: 'manual' }); drawRows(); } }, '+ split'),
      el('button', { class: 'primary', onclick: save }, 'Save'),
      el('button', { class: 'ghost', onclick: () => { state.editingCell = null; state.rerender(); } }, 'Cancel')
    )
  );
}

function applyRecurringControl(state, months) {
  const { data } = state;
  const select = el('select', {},
    ...months.map((m) => el('option', { value: m, selected: m === currentMonth() }, monthLabel(m))));
  const apply = async () => {
    const month = select.value;
    const active = data.recurring.filter((r) => isActiveInMonth(r, month));
    if (!active.length) return toast('No recurring items active in that month', true);
    let added = 0;
    for (const item of active) {
      const already = data.monthly.some((e) =>
        e.month === month && e.source === 'recurring' &&
        e.categoryId === item.categoryId && (e.accountId || null) === (item.accountId || null)
      );
      if (already) continue;
      data.monthly.push({
        month,
        categoryId: item.categoryId,
        accountId: item.accountId || null,
        amount: recurringMonthlyAmount(item),
        source: 'recurring'
      });
      added++;
    }
    if (!added) return toast('Recurring amounts already applied for that month', true);
    await state.save('monthly');
    state.rerender();
    toast(`Applied ${added} recurring item(s) to ${monthLabel(month)}`);
  };
  return el('span', { class: 'flex' }, select,
    el('button', { class: 'ghost', onclick: apply }, 'Apply recurring'));
}
