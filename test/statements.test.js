import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listStatements, resolveStatementPath } from '../lib/statements.js';

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-statements-'));
  return dir;
}

test('listStatements returns [] for a missing directory', () => {
  assert.deepEqual(listStatements(path.join(os.tmpdir(), 'does-not-exist-xyz')), []);
  assert.deepEqual(listStatements(''), []);
  assert.deepEqual(listStatements(null), []);
});

test('listStatements finds supported files recursively, skips others', () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'HSBC'));
  fs.writeFileSync(path.join(dir, 'HSBC', 'jan.pdf'), 'x');
  fs.writeFileSync(path.join(dir, 'export.csv'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'ignore.docx'), 'x'); // unsupported
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x'); // dotfile
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.writeFileSync(path.join(dir, '.hidden', 'jan.pdf'), 'x'); // inside dotdir

  const files = listStatements(dir);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['HSBC/jan.pdf', 'export.csv', 'notes.txt'].sort());
  const hsbc = files.find((f) => f.path === 'HSBC/jan.pdf');
  assert.equal(hsbc.name, 'jan.pdf');
  assert.equal(hsbc.ext, 'pdf');
  assert.equal(hsbc.size, 1);
  assert.ok(hsbc.mtimeMs > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('listStatements sorts newest first', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'old.csv'), 'x');
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(dir, 'new.csv'), 'x');
  const files = listStatements(dir);
  assert.deepEqual(files.map((f) => f.name), ['new.csv', 'old.csv']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveStatementPath resolves a valid relative path within dir', () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, 'HSBC'));
  fs.writeFileSync(path.join(dir, 'HSBC', 'jan.pdf'), 'x');
  const resolved = resolveStatementPath(dir, 'HSBC/jan.pdf');
  assert.equal(resolved, path.join(path.resolve(dir), 'HSBC', 'jan.pdf'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveStatementPath rejects traversal and absolute paths', () => {
  const dir = makeTempDir();
  assert.throws(() => resolveStatementPath(dir, '../outside.pdf'));
  assert.throws(() => resolveStatementPath(dir, '../../etc/passwd'));
  assert.throws(() => resolveStatementPath(dir, 'sub/../../outside.pdf'));
  assert.throws(() => resolveStatementPath(dir, path.resolve(dir, '..', 'outside.pdf')));
  assert.throws(() => resolveStatementPath(dir, ''));
  assert.throws(() => resolveStatementPath(null, 'a.pdf'));
  fs.rmSync(dir, { recursive: true, force: true });
});
