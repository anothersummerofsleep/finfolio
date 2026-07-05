import { el, money, monthLabel, CHART_COLORS } from './ui.js';
import {
  monthlySummary, netWorthSeries, latestSnapshot, liquidTotal, lockedTotal,
  runway, fiProgress, committedMonthlyOutflow, recurringMonthlyAmount,
  isActiveInMonth, installmentProgress, recurringEndMonth, currentMonth
} from './calc.js';

let charts = [];
function mountChart(canvas, config) {
  const chart = new Chart(canvas, config);
  charts.push(chart);
  return chart;
}

const CLASS_LABELS = {
  equity: 'Equity', bond: 'Fixed income', crypto: 'Crypto',
  guaranteed: 'Guaranteed', cash: 'Cash', other: 'Other'
};

export function render(container, state) {
  charts.forEach((c) => c.destroy());
  charts = [];
  container.innerHTML = '';

  const { data } = state;
  const todayYm = currentMonth();
  const summaries = monthlySummary(data.monthly, data.categories);
  const series = netWorthSeries(data.snapshots, data.sleeves);
  const snap = latestSnapshot(data.snapshots);
  const view = state.netWorthView || data.settings.netWorthView || 'market';

  container.append(
    el('div', { class: 'grid cols-3 mb' },
      netWorthCard(state, series, snap, view),
      runwayCard(data, summaries, snap, todayYm),
      fiCard(data, summaries, snap, todayYm)
    ),
    el('div', { class: 'grid cols-2 mb' },
      netWorthChartPanel(series, view),
      allocationPanel(series)
    ),
    el('div', { class: 'grid cols-2 mb' },
      cashflowPanel(summaries),
      accountSpendPanel(summaries, data.accounts)
    ),
    commitmentsPanel(data, todayYm)
  );
}

function netWorthCard(state, series, snap, view) {
  const latest = series.at(-1);
  const toggle = el('div', { class: 'toggle' },
    ...['market', 'liquidation'].map((v) =>
      el('button', {
        class: view === v ? 'active' : '',
        onclick: () => { state.netWorthView = v; state.rerender(); }
      }, v === 'market' ? 'Market' : 'Liquidation')
    )
  );
  const value = latest ? latest[view] : null;
  const liquid = liquidTotal(snap, state.data.sleeves);
  const locked = lockedTotal(snap, state.data.sleeves, view);
  return el('div', { class: 'panel' },
    el('div', { class: 'flex spread' }, el('h2', {}, 'Net worth'), toggle),
    latest
      ? el('div', {},
          el('p', { class: 'big' }, money(value)),
          el('div', { class: 'stat-row' },
            el('div', {}, el('span', {}, 'Liquid'), money(liquid)),
            el('div', {}, el('span', {}, 'Locked'), money(locked)),
            el('div', {}, el('span', {}, 'As of'), latest.date)
          )
        )
      : el('p', { class: 'empty' }, 'No snapshots yet — add one in the Snapshots tab.')
  );
}

function runwayCard(data, summaries, snap, todayYm) {
  const r = runway({
    snapshot: snap, sleeves: data.sleeves, summaries,
    recurring: data.recurring, settings: data.settings, todayYm
  });
  return el('div', { class: 'panel' },
    el('h2', {}, 'Cash runway'),
    r.months != null
      ? el('p', { class: 'big' }, `${r.months.toFixed(1)} `, el('small', {}, 'months'))
      : el('p', { class: 'big muted' }, '—'),
    el('div', { class: 'stat-row' },
      el('div', {}, el('span', {}, 'Liquid cash'), money(r.cash)),
      el('div', {}, el('span', {}, `Avg burn (${r.windowUsed.length}mo)`), r.burn != null ? money(r.burn) : '—'),
      el('div', {}, el('span', {}, 'Committed floor'), el('b', { class: 'warn' }, money(r.committedFloor), '/mo'))
    ),
    r.burn == null ? el('p', { class: 'muted' }, 'Needs monthly expense data to compute burn.') : null
  );
}

function fiCard(data, summaries, snap, todayYm) {
  const fi = fiProgress({ summaries, snapshot: snap, sleeves: data.sleeves, settings: data.settings, todayYm });
  return el('div', { class: 'panel' },
    el('h2', {}, 'FI progress'),
    fi.insufficient
      ? el('div', {},
          el('p', { class: 'big muted' }, `${fi.monthsOfData}/12`),
          el('p', { class: 'muted' }, 'months of expense data — FI number needs a full trailing year.')
        )
      : el('div', {},
          el('p', { class: 'big' }, `${fi.progress}%`),
          el('div', { class: 'progress' }, el('div', { style: `width:${Math.min(100, fi.progress)}%` })),
          el('div', { class: 'stat-row' },
            el('div', {}, el('span', {}, 'FI assets'), money(fi.assets)),
            el('div', {}, el('span', {}, `FI number (×${data.settings.fiMultiplier})`), money(fi.fiNumber))
          )
        ),
    el('div', { class: 'stat-row' },
      el('div', {}, el('span', {}, 'Savings rate'), fi.savingsRate != null ? `${fi.savingsRate}%` : '—')
    )
  );
}

function netWorthChartPanel(series, view) {
  const panel = el('div', { class: 'panel' }, el('h2', {}, 'Net worth over time'));
  if (series.length < 2) {
    panel.append(el('p', { class: 'empty' }, 'Add two or more snapshots to see the trend.'));
    return panel;
  }
  const box = el('div', { class: 'chart-box' });
  const canvas = el('canvas');
  box.append(canvas);
  panel.append(box);
  mountChart(canvas, {
    type: 'line',
    data: {
      labels: series.map((s) => s.date),
      datasets: [
        {
          label: 'Market', data: series.map((s) => s.market),
          borderColor: '#4cc38a', backgroundColor: '#4cc38a33',
          fill: true, tension: 0.25, borderWidth: view === 'market' ? 2.5 : 1
        },
        {
          label: 'Liquidation', data: series.map((s) => s.liquidation),
          borderColor: '#58a6ff', backgroundColor: 'transparent',
          borderDash: [5, 4], tension: 0.25, borderWidth: view === 'liquidation' ? 2.5 : 1
        }
      ]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });
  return panel;
}

function allocationPanel(series) {
  const panel = el('div', { class: 'panel' }, el('h2', {}, 'Allocation (market value)'));
  const latest = series.at(-1);
  if (!latest) {
    panel.append(el('p', { class: 'empty' }, 'No snapshot data.'));
    return panel;
  }
  const entries = Object.entries(latest.byClass).filter(([, v]) => v > 0);
  const box = el('div', { class: 'chart-box' });
  const canvas = el('canvas');
  box.append(canvas);
  panel.append(box);
  mountChart(canvas, {
    type: 'doughnut',
    data: {
      labels: entries.map(([cls]) => CLASS_LABELS[cls] || cls),
      datasets: [{ data: entries.map(([, v]) => v), backgroundColor: CHART_COLORS, borderWidth: 0 }]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'right' } } }
  });
  return panel;
}

function cashflowPanel(summaries) {
  const panel = el('div', { class: 'panel' }, el('h2', {}, 'Income vs expenses'));
  const recent = summaries.slice(-12);
  if (!recent.length) {
    panel.append(el('p', { class: 'empty' }, 'No monthly data yet — use the Monthly tab or Import.'));
    return panel;
  }
  const box = el('div', { class: 'chart-box' });
  const canvas = el('canvas');
  box.append(canvas);
  panel.append(box);
  mountChart(canvas, {
    type: 'bar',
    data: {
      labels: recent.map((s) => monthLabel(s.month)),
      datasets: [
        { label: 'Income', data: recent.map((s) => s.income), backgroundColor: '#4cc38a' },
        { label: 'Expenses', data: recent.map((s) => s.expense), backgroundColor: '#e5534b' }
      ]
    },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
  });
  return panel;
}

function accountSpendPanel(summaries, accounts) {
  const panel = el('div', { class: 'panel' }, el('h2', {}, 'Spend by account (last 12 months)'));
  const recent = summaries.slice(-12);
  const totals = {};
  for (const s of recent) {
    for (const [acct, v] of Object.entries(s.byAccount)) totals[acct] = (totals[acct] || 0) + v;
  }
  const names = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    panel.append(el('p', { class: 'empty' }, 'No account-tagged expenses yet. Tag entries with an account in the Monthly tab, or import a statement.'));
    return panel;
  }
  const box = el('div', { class: 'chart-box' });
  const canvas = el('canvas');
  box.append(canvas);
  panel.append(box);
  mountChart(canvas, {
    type: 'bar',
    data: {
      labels: entries.map(([id]) => names[id] || (id === 'unassigned' ? 'Unassigned' : id)),
      datasets: [{ data: entries.map(([, v]) => Math.round(v)), backgroundColor: CHART_COLORS, borderWidth: 0 }]
    },
    options: {
      indexAxis: 'y',
      maintainAspectRatio: false,
      plugins: { legend: { display: false } }
    }
  });
  return panel;
}

function commitmentsPanel(data, todayYm) {
  const panel = el('div', { class: 'panel' }, el('h2', {}, 'Commitments — installments & GIRO'));
  const active = data.recurring.filter((r) => isActiveInMonth(r, todayYm));
  const catNames = Object.fromEntries(data.categories.map((c) => [c.id, c.name]));
  const acctNames = Object.fromEntries(data.accounts.map((a) => [a.id, a.name]));
  if (!data.recurring.length) {
    panel.append(el('p', { class: 'empty' }, 'No recurring items — add installments and GIRO payments in the Registries tab.'));
    return panel;
  }
  const rows = data.recurring.map((item) => {
    const activeNow = isActiveInMonth(item, todayYm);
    const inst = installmentProgress(item, todayYm);
    const end = recurringEndMonth(item);
    return el('tr', { class: activeNow ? '' : 'muted' },
      el('td', {}, item.name, ' ', el('span', { class: 'badge' }, item.type)),
      el('td', { class: 'num' }, money(item.amount, 2)),
      el('td', {}, item.frequency),
      el('td', { class: 'num' }, money(recurringMonthlyAmount(item), 2)),
      el('td', {}, acctNames[item.accountId] || '—'),
      el('td', {}, catNames[item.categoryId] || '—'),
      el('td', {}, inst
        ? `${inst.paid}/${item.installmentsTotal} paid · ${money(inst.remainingAmount)} left · ends ${inst.payoffMonth}`
        : end ? `until ${end}` : 'ongoing')
    );
  });
  panel.append(
    el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'Name'), el('th', { class: 'num' }, 'Amount'), el('th', {}, 'Freq'),
        el('th', { class: 'num' }, 'Monthly equiv.'), el('th', {}, 'Account'),
        el('th', {}, 'Category'), el('th', {}, 'Status')
      )),
      el('tbody', {}, rows)
    ),
    el('p', { class: 'mt' }, 'Total committed monthly outflow: ',
      el('b', { class: 'warn' }, money(committedMonthlyOutflow(data.recurring, todayYm), 2)),
      el('span', { class: 'muted' }, ` across ${active.length} active item(s)`))
  );
  return panel;
}
