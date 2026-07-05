// Small DOM helpers — no framework, on purpose.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

let currencyCode = 'SGD';
export function setCurrency(code) { currencyCode = code || 'SGD'; }

export function money(n, decimals = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-SG', {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(n);
}

export function toast(message, isError = false) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => { node.hidden = true; }, 3500);
}

export function slugify(name, taken = new Set()) {
  let base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  let slug = base;
  let i = 2;
  while (taken.has(slug)) slug = `${base}-${i++}`;
  return slug;
}

export function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return new Date(Number(y), Number(m) - 1, 1)
    .toLocaleDateString('en-SG', { month: 'short', year: '2-digit' });
}

export const CHART_COLORS = ['#4cc38a', '#58a6ff', '#e5a50a', '#e5534b', '#b083f0', '#f78166', '#79c0ff', '#7ee787', '#ffa657', '#d2a8ff', '#a5d6ff', '#ffab70'];

export function chartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.color = '#8b98a5';
  Chart.defaults.borderColor = '#2d3843';
  Chart.defaults.font.family = 'system-ui, sans-serif';
}
