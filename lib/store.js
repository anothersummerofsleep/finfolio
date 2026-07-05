import fs from 'node:fs';
import path from 'node:path';

// One JSON file per collection. Writes are atomic (temp file + rename) and the
// previous version is kept as <name>.json.bak — data files are the only state
// this app has, so they get treated with care.
export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'imports'), { recursive: true });

  const fileFor = (name) => path.join(dataDir, `${name}.json`);

  function read(name, fallback) {
    const file = fileFor(name);
    if (!fs.existsSync(file)) return structuredClone(fallback);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function write(name, value) {
    const file = fileFor(name);
    const tmp = `${file}.tmp`;
    const json = JSON.stringify(value, null, 2);
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, file);
    return value;
  }

  function exists(name) {
    return fs.existsSync(fileFor(name));
  }

  // content is utf8 text (CSV) or, when encoding='base64', the base64 body of a
  // binary upload (PDF) — decoded to bytes so the saved file is a valid PDF.
  function saveImportFile(filename, content, encoding = 'utf8') {
    const safe = String(filename).replace(/[^\w.\- ]+/g, '_');
    const dest = path.join(dataDir, 'imports', `${Date.now()}_${safe}`);
    if (encoding === 'base64') fs.writeFileSync(dest, Buffer.from(content, 'base64'));
    else fs.writeFileSync(dest, content, 'utf8');
    return dest;
  }

  return { read, write, exists, saveImportFile, dataDir };
}
