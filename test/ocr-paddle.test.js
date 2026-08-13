import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paddleAvailable } from '../lib/ocr-paddle.js';

// paddleAvailable decides engine selection: true -> PaddleOCR-VL, false -> the
// server falls back to tesseract. It must never throw or hang the import, so a
// down/erroring/slow sidecar has to resolve to false.
const withFetch = async (impl, fn) => {
  const real = global.fetch;
  global.fetch = impl;
  try { return await fn(); } finally { global.fetch = real; }
};

test('healthy sidecar -> available', async () => {
  const ok = await withFetch(
    async () => ({ ok: true, json: async () => ({ ok: true, model: 'PaddleOCR-VL' }) }),
    () => paddleAvailable('http://x')
  );
  assert.equal(ok, true);
});

test('sidecar down (fetch throws) -> unavailable, no throw', async () => {
  const ok = await withFetch(
    async () => { throw new Error('ECONNREFUSED'); },
    () => paddleAvailable('http://x')
  );
  assert.equal(ok, false);
});

test('non-200 health -> unavailable', async () => {
  const ok = await withFetch(
    async () => ({ ok: false, json: async () => ({}) }),
    () => paddleAvailable('http://x')
  );
  assert.equal(ok, false);
});

test('200 but ok:false payload -> unavailable', async () => {
  const ok = await withFetch(
    async () => ({ ok: true, json: async () => ({ ok: false }) }),
    () => paddleAvailable('http://x')
  );
  assert.equal(ok, false);
});
