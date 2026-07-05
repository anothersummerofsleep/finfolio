import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-test-'));
  return { store: createStore(dir), dir };
}

test('write then read round-trips', () => {
  const { store, dir } = tempStore();
  store.write('monthly', [{ month: '2026-06', categoryId: 'food', amount: 12.5 }]);
  const back = store.read('monthly', []);
  assert.equal(back[0].amount, 12.5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('read returns fallback when file missing', () => {
  const { store, dir } = tempStore();
  assert.deepEqual(store.read('nothing', { a: 1 }), { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('overwrite keeps a .bak of the previous version and no .tmp remains', () => {
  const { store, dir } = tempStore();
  store.write('settings', { v: 1 });
  store.write('settings', { v: 2 });
  const bak = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json.bak'), 'utf8'));
  assert.equal(bak.v, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).v, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'settings.json.tmp')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveImportFile sanitizes filenames into imports/', () => {
  const { store, dir } = tempStore();
  const dest = store.saveImportFile('../..\\evil<>.csv', 'a,b,c');
  assert.ok(dest.startsWith(path.join(dir, 'imports')));
  assert.ok(fs.existsSync(dest));
  fs.rmSync(dir, { recursive: true, force: true });
});
