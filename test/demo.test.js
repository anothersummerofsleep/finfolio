// Demo-mode isolation: `npm run demo` must ignore an inherited STATEMENTS_DIR,
// while real mode keeps honouring it. These start the actual server as a child
// process. The statements folder is a temp decoy created here, never a real one.
// Note: the demo test rewrites the throwaway .demo-data/ folder, exactly as
// `npm run demo` does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function makeDecoyStatements() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-decoy-statements-'));
  fs.writeFileSync(path.join(dir, 'decoy-statement.csv'), 'date,description,amount\n');
  return dir;
}

// Start a script with the given env, wait until it is listening, return a
// handle with the base URL and a stop() that resolves once the process exits.
// A failed start kills the child before rejecting, so nothing is left running.
async function start(script, extraEnv) {
  const port = await freePort();
  const child = spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...extraEnv, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const timeout = new Promise((resolve) => setTimeout(resolve, 5000, 'timeout'));
    if ((await Promise.race([exited, timeout])) === 'timeout') child.kill('SIGKILL');
  };
  let out = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 15000);
      child.stdout.on('data', (d) => {
        out += d;
        if (out.includes('running at')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on('data', (d) => { out += d; });
      child.once('error', (err) => { clearTimeout(timer); reject(err); });
      exited.then((code) => { clearTimeout(timer); reject(new Error(`exited ${code}:\n${out}`)); });
    });
  } catch (err) {
    await stop();
    throw err;
  }
  return { base: `http://127.0.0.1:${port}`, stop };
}

test('demo mode ignores an inherited STATEMENTS_DIR', async () => {
  const decoy = makeDecoyStatements();
  const server = await start(path.join('scripts', 'demo.js'), { STATEMENTS_DIR: decoy });
  try {
    const browse = await (await fetch(`${server.base}/api/import/browse`)).json();
    assert.deepEqual(browse, { enabled: false, files: [] });
    const batch = await fetch(`${server.base}/api/import/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePaths: ['decoy-statement.csv'] })
    });
    assert.equal(batch.status, 400);
  } finally {
    await server.stop();
    fs.rmSync(decoy, { recursive: true, force: true });
  }
});

test('real mode still honours STATEMENTS_DIR', async () => {
  const decoy = makeDecoyStatements();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finfolio-data-'));
  const server = await start('server.js', { STATEMENTS_DIR: decoy, DATA_DIR: dataDir });
  try {
    const browse = await (await fetch(`${server.base}/api/import/browse`)).json();
    assert.equal(browse.enabled, true);
    assert.ok(JSON.stringify(browse.files).includes('decoy-statement.csv'));
  } finally {
    await server.stop();
    fs.rmSync(decoy, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
