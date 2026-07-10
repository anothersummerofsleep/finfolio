import { el, toast, slugify } from './ui.js';

// Manage the three registries: categories, accounts, recurring items.

export function render(container, state) {
  container.innerHTML = '';
  container.append(
    categoriesPanel(state),
    el('div', { class: 'mt' }, accountsPanel(state)),
    el('div', { class: 'mt' }, recurringPanel(state))
  );
}

function usedCategoryIds(data) {
  return new Set([
    ...data.monthly.map((e) => e.categoryId),
    ...data.recurring.map((r) => r.categoryId)
  ]);
}

function categoriesPanel(state) {
  const { data } = state;
  const used = usedCategoryIds(data);
  const nameInput = el('input', { placeholder: 'New category name' });
  const typeSelect = el('select', {},
    el('option', { value: 'expense' }, 'expense'),
    el('option', { value: 'income' }, 'income'),
    el('option', { value: 'transfer' }, 'transfer'));
  const groupSelect = el('select', {},
    el('option', { value: 'needs' }, 'needs'),
    el('option', { value: 'wants' }, 'wants'),
    el('option', { value: 'goals' }, 'goals'),
    el('option', { value: '' }, '(none)'));

  const add = async () => {
    const name = nameInput.value.trim();
    if (!name) return toast('Name required', true);
    const id = slugify(name, new Set(data.categories.map((c) => c.id)));
    data.categories.push({
      id, name,
      type: typeSelect.value,
      // Only expense categories carry a needs/wants/goals group.
      group: typeSelect.value === 'expense' ? (groupSelect.value || null) : null
    });
    await state.save('categories');
    state.rerender();
    toast(`Added category "${name}"`);
  };

  return el('div', { class: 'panel' },
    el('h2', {}, 'Categories'),
    el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Type'), el('th', {}, 'Group'), el('th', {}, ''))),
      el('tbody', {}, data.categories.map((cat) => el('tr', {},
        el('td', {}, cat.name),
        el('td', {}, cat.type),
        el('td', {}, cat.group || '—'),
        el('td', {}, el('button', {
          class: 'danger',
          disabled: used.has(cat.id),
          title: used.has(cat.id) ? 'In use by monthly data or recurring items' : 'Delete',
          onclick: async () => {
            data.categories = data.categories.filter((c) => c.id !== cat.id);
            await state.save('categories');
            state.rerender();
          }
        }, 'Delete'))
      )))
    ),
    el('div', { class: 'actions' }, nameInput, typeSelect, groupSelect,
      el('button', { class: 'primary', onclick: add }, 'Add category'))
  );
}

function accountsPanel(state) {
  const { data } = state;
  const usedAccounts = new Set([
    ...data.monthly.map((e) => e.accountId),
    ...data.recurring.map((r) => r.accountId)
  ]);
  const nameInput = el('input', { placeholder: 'e.g. DBS Multiplier, HSBC Revolution' });
  const kindSelect = el('select', {},
    ...['bank', 'credit-card', 'debit-card', 'wallet'].map((k) => el('option', { value: k }, k)));

  const add = async () => {
    const name = nameInput.value.trim();
    if (!name) return toast('Name required', true);
    const id = slugify(name, new Set(data.accounts.map((a) => a.id)));
    data.accounts.push({ id, name, kind: kindSelect.value });
    await state.save('accounts');
    state.rerender();
    toast(`Added account "${name}"`);
  };

  return el('div', { class: 'panel' },
    el('h2', {}, 'Accounts (banks & cards)'),
    data.accounts.length
      ? el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Kind'), el('th', {}, ''))),
          el('tbody', {}, data.accounts.map((acct) => el('tr', {},
            el('td', {}, acct.name),
            el('td', {}, acct.kind),
            el('td', {}, el('button', {
              class: 'danger',
              disabled: usedAccounts.has(acct.id),
              title: usedAccounts.has(acct.id) ? 'In use by monthly data or recurring items' : 'Delete',
              onclick: async () => {
                data.accounts = data.accounts.filter((a) => a.id !== acct.id);
                await state.save('accounts');
                state.rerender();
              }
            }, 'Delete'))
          )))
        )
      : el('p', { class: 'muted' }, 'No accounts yet — add your banks and cards to tag spending and import statements.'),
    el('div', { class: 'actions' }, nameInput, kindSelect,
      el('button', { class: 'primary', onclick: add }, 'Add account'))
  );
}

function recurringPanel(state) {
  const { data } = state;
  const expenseCats = data.categories.filter((c) => c.type === 'expense');

  const nameInput = el('input', { placeholder: 'e.g. Phone installment, Insurance GIRO' });
  const typeSelect = el('select', {},
    el('option', { value: 'giro' }, 'GIRO / standing'),
    el('option', { value: 'installment' }, 'installment'));
  const amountInput = el('input', { class: 'cell', type: 'number', step: '0.01', placeholder: 'amount' });
  const freqSelect = el('select', {},
    ...['monthly', 'quarterly', 'yearly'].map((f) => el('option', { value: f }, f)));
  const acctSelect = el('select', {},
    el('option', { value: '' }, '(no account)'),
    ...data.accounts.map((a) => el('option', { value: a.id }, a.name)));
  const catSelect = el('select', {},
    ...expenseCats.map((c) => el('option', { value: c.id }, c.name)));
  const startInput = el('input', { type: 'month' });
  const endInput = el('input', { type: 'month', title: 'GIRO end month (optional)' });
  const installmentsInput = el('input', { class: 'cell', type: 'number', min: '1', placeholder: '# payments', hidden: true });

  typeSelect.addEventListener('change', () => {
    const isInstallment = typeSelect.value === 'installment';
    installmentsInput.hidden = !isInstallment;
    endInput.hidden = isInstallment;
  });

  const add = async () => {
    const name = nameInput.value.trim();
    const amount = Number(amountInput.value);
    if (!name || !(amount > 0)) return toast('Name and a positive amount are required', true);
    if (!startInput.value) return toast('Start month is required', true);
    const item = {
      id: slugify(name, new Set(data.recurring.map((r) => r.id))),
      name,
      type: typeSelect.value,
      amount,
      frequency: freqSelect.value,
      accountId: acctSelect.value || null,
      categoryId: catSelect.value,
      startDate: `${startInput.value}-01`
    };
    if (typeSelect.value === 'installment') {
      const n = Number(installmentsInput.value);
      if (!(n > 0)) return toast('Installments need a payment count', true);
      item.installmentsTotal = n;
    } else if (endInput.value) {
      item.endDate = `${endInput.value}-01`;
    }
    data.recurring.push(item);
    await state.save('recurring');
    state.rerender();
    toast(`Added "${name}"`);
  };

  return el('div', { class: 'panel' },
    el('h2', {}, 'Recurring — installments & GIRO'),
    data.recurring.length
      ? el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Name'), el('th', {}, 'Type'), el('th', { class: 'num' }, 'Amount'),
            el('th', {}, 'Freq'), el('th', {}, 'Start'), el('th', {}, 'End / count'), el('th', {}, ''))),
          el('tbody', {}, data.recurring.map((item) => el('tr', {},
            el('td', {}, item.name),
            el('td', {}, item.type),
            el('td', { class: 'num' }, item.amount.toFixed(2)),
            el('td', {}, item.frequency),
            el('td', {}, item.startDate?.slice(0, 7) || '—'),
            el('td', {}, item.installmentsTotal ? `${item.installmentsTotal} payments` : (item.endDate?.slice(0, 7) || 'ongoing')),
            el('td', {}, el('button', {
              class: 'danger',
              onclick: async () => {
                if (!confirm(`Delete "${item.name}"?`)) return;
                data.recurring = data.recurring.filter((r) => r.id !== item.id);
                await state.save('recurring');
                state.rerender();
              }
            }, 'Delete'))
          )))
        )
      : el('p', { class: 'muted' }, 'Nothing recurring yet. These feed the Commitments panel and the runway "committed floor".'),
    el('div', { class: 'actions' },
      nameInput, typeSelect, amountInput, freqSelect, acctSelect, catSelect,
      el('label', {}, 'start ', startInput),
      el('label', {}, 'end ', endInput),
      installmentsInput,
      el('button', { class: 'primary', onclick: add }, 'Add recurring'))
  );
}
