async function handle(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

export const api = {
  get: (name) => fetch(`/api/${name}`).then(handle),
  put: (name, data) =>
    fetch(`/api/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(handle),
  post: (path, data) =>
    fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(handle)
};

const NAMES = [
  'monthly', 'snapshots', 'categories', 'accounts',
  'recurring', 'sleeves', 'settings', 'import-rules', 'import-presets', 'review-queue'
];

export async function loadAll() {
  const values = await Promise.all(NAMES.map((n) => api.get(n)));
  return Object.fromEntries(NAMES.map((n, i) => [n, values[i]]));
}
