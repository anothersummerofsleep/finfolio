import { loadAll, api } from './api.js';
import { setCurrency, chartDefaults, toast } from './ui.js';
import * as dashboard from './dashboard.js';
import * as monthly from './monthly.js';
import * as snapshots from './snapshots.js';
import * as registries from './registries.js';
import * as importerUi from './importer-ui.js';
import * as reviewQueue from './review-queue.js';

const TABS = {
  dashboard,
  monthly,
  snapshots,
  registries,
  import: importerUi,
  reviewQueue
};

const state = {
  data: null,
  activeTab: 'dashboard',
  async save(name) {
    try {
      await api.put(name, state.data[name]);
    } catch (err) {
      toast(`Save failed: ${err.message}`, true);
      throw err;
    }
  },
  async reload() {
    state.data = await loadAll();
    setCurrency(state.data.settings.currency);
  },
  rerender() {
    const view = document.getElementById('view');
    TABS[state.activeTab].render(view, state);
  },
  // Switch tabs programmatically (e.g. after a bulk import, jump to Review) —
  // same effect as clicking the tab button.
  setTab(name) {
    if (!TABS[name]) return;
    state.activeTab = name;
    for (const btn of document.querySelectorAll('#tabs button')) {
      btn.classList.toggle('active', btn.dataset.tab === name);
    }
    state.rerender();
  }
};

document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.dataset?.tab;
  if (!tab) return;
  state.setTab(tab);
});

chartDefaults();
state.reload()
  .then(() => state.rerender())
  .catch((err) => {
    document.getElementById('view').innerHTML =
      `<p class="empty">Could not load data: ${err.message}</p>`;
  });
