import { loadAll, api } from './api.js';
import { setCurrency, chartDefaults, toast } from './ui.js';
import * as dashboard from './dashboard.js';
import * as monthly from './monthly.js';
import * as snapshots from './snapshots.js';
import * as registries from './registries.js';
import * as importerUi from './importer-ui.js';

const TABS = {
  dashboard,
  monthly,
  snapshots,
  registries,
  import: importerUi
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
  }
};

document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.dataset?.tab;
  if (!tab) return;
  state.activeTab = tab;
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  state.rerender();
});

chartDefaults();
state.reload()
  .then(() => state.rerender())
  .catch((err) => {
    document.getElementById('view').innerHTML =
      `<p class="empty">Could not load data: ${err.message}</p>`;
  });
