import { el, money, toast } from './ui.js';
import { netWorthSeries, latestSnapshot } from './calc.js';

// Point-in-time snapshots: one row per sleeve, market + liquidation value.

export function render(container, state) {
  container.innerHTML = '';
  const { data } = state;

  container.append(snapshotForm(state));

  const series = netWorthSeries(data.snapshots, data.sleeves);
  if (!data.snapshots.length) {
    container.append(el('p', { class: 'empty mt' }, 'No snapshots yet. Enter values from your latest statements above.'));
    return;
  }
  const sorted = [...data.snapshots].sort((a, b) => b.date.localeCompare(a.date));
  container.append(el('div', { class: 'panel mt' },
    el('h2', {}, 'History'),
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Date'), el('th', { class: 'num' }, 'Market'),
        el('th', { class: 'num' }, 'Liquidation'), el('th', {}, '')
      )),
      el('tbody', {}, sorted.map((snap) => {
        const s = series.find((x) => x.date === snap.date);
        return el('tr', {},
          el('td', {}, snap.date),
          el('td', { class: 'num' }, money(s?.market)),
          el('td', { class: 'num' }, money(s?.liquidation)),
          el('td', {},
            el('button', { class: 'ghost', onclick: () => { state.editingSnapshot = snap.date; state.rerender(); } }, 'Edit'),
            ' ',
            el('button', {
              class: 'danger',
              onclick: async () => {
                if (!confirm(`Delete snapshot ${snap.date}?`)) return;
                data.snapshots = data.snapshots.filter((x) => x.date !== snap.date);
                await state.save('snapshots');
                state.rerender();
                toast(`Deleted snapshot ${snap.date}`);
              }
            }, 'Delete')
          )
        );
      }))
    )
  ));
}

function snapshotForm(state) {
  const { data } = state;
  const editing = state.editingSnapshot
    ? data.snapshots.find((s) => s.date === state.editingSnapshot)
    : null;
  const values = {};
  for (const sleeve of data.sleeves) {
    const existing = editing?.values?.find((v) => v.sleeveId === sleeve.id);
    values[sleeve.id] = {
      marketValue: existing?.marketValue ?? '',
      liquidationValue: existing?.liquidationValue ?? ''
    };
  }

  const dateInput = el('input', {
    type: 'date',
    value: editing?.date || new Date().toISOString().slice(0, 10)
  });

  const inputs = {};
  const rows = data.sleeves.map((sleeve) => {
    const market = el('input', { class: 'cell', type: 'number', step: '0.01', value: values[sleeve.id].marketValue });
    const liq = el('input', {
      class: 'cell', type: 'number', step: '0.01',
      value: values[sleeve.id].liquidationValue,
      placeholder: '= market'
    });
    inputs[sleeve.id] = { market, liq };
    return el('tr', {},
      el('td', {}, sleeve.name, ' ',
        el('span', { class: 'badge' }, sleeve.class),
        sleeve.liquid ? el('span', { class: 'badge', title: 'counts toward cash runway' }, 'liquid') : null),
      el('td', { class: 'num' }, market),
      el('td', { class: 'num' }, liq)
    );
  });

  const copyLatest = () => {
    const latest = latestSnapshot(data.snapshots);
    if (!latest) return toast('No snapshot to copy from', true);
    for (const v of latest.values || []) {
      if (!inputs[v.sleeveId]) continue;
      inputs[v.sleeveId].market.value = v.marketValue ?? '';
      inputs[v.sleeveId].liq.value = v.liquidationValue ?? '';
    }
    toast(`Copied values from ${latest.date}`);
  };

  const save = async () => {
    const date = dateInput.value;
    if (!date) return toast('Pick a date', true);
    const entryValues = [];
    for (const sleeve of data.sleeves) {
      const mv = inputs[sleeve.id].market.value;
      const lv = inputs[sleeve.id].liq.value;
      if (mv === '' && lv === '') continue;
      const value = { sleeveId: sleeve.id, marketValue: Number(mv || lv) };
      if (lv !== '' && Number(lv) !== value.marketValue) value.liquidationValue = Number(lv);
      entryValues.push(value);
    }
    if (!entryValues.length) return toast('Enter at least one value', true);
    data.snapshots = data.snapshots.filter((s) => s.date !== date && s.date !== state.editingSnapshot);
    data.snapshots.push({ date, values: entryValues });
    await state.save('snapshots');
    state.editingSnapshot = null;
    state.rerender();
    toast(`Snapshot ${date} saved`);
  };

  return el('div', { class: 'panel' },
    el('h2', {}, editing ? `Edit snapshot ${editing.date}` : 'New snapshot'),
    el('div', { class: 'flex mb' },
      el('label', {}, 'Date ', dateInput),
      el('button', { class: 'ghost', onclick: copyLatest }, 'Copy latest'),
      el('span', { class: 'muted' }, 'Liquidation = what you could actually get out today (surrender value, after penalties). Leave blank if same as market.')
    ),
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Sleeve'), el('th', { class: 'num' }, 'Market value'), el('th', { class: 'num' }, 'Liquidation value')
      )),
      el('tbody', {}, rows)
    ),
    el('div', { class: 'actions' },
      el('button', { class: 'primary', onclick: save }, editing ? 'Save changes' : 'Add snapshot'),
      editing ? el('button', { class: 'ghost', onclick: () => { state.editingSnapshot = null; state.rerender(); } }, 'Cancel') : null
    )
  );
}
