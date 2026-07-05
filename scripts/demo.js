// Demo mode: copy sample data into a scratch directory and serve it, so
// playing with the demo never touches (or creates) real data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const src = path.join(root, 'sample-data');
const dst = path.join(root, '.demo-data');

if (!fs.existsSync(src)) {
  console.error('sample-data/ missing — run `npm run sample` first.');
  process.exit(1);
}
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });

process.env.DATA_DIR = dst;
console.log('demo mode — using a throwaway copy of sample-data/');
await import('../server.js');
