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
    }).then(handle),
  // POST that reads an NDJSON stream, calling onMessage(obj) per line. Bulk
  // import uses this so each statement's result streams back as it finishes —
  // the UI shows live progress instead of waiting minutes for one buffered
  // response (and headers arrive immediately, so no request-timeout on a long
  // OCR batch).
  postStream: async (path, data, onMessage) => {
    const res = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `${res.status} ${res.statusText}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onMessage(JSON.parse(line));
      }
    }
    if (buf.trim()) onMessage(JSON.parse(buf.trim()));
  }
};

const NAMES = [
  'monthly', 'snapshots', 'categories', 'accounts',
  'recurring', 'sleeves', 'settings', 'import-rules', 'import-presets', 'review-queue'
];

export async function loadAll() {
  const values = await Promise.all(NAMES.map((n) => api.get(n)));
  return Object.fromEntries(NAMES.map((n, i) => [n, values[i]]));
}
