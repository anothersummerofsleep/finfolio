// Statements folder: an optional local directory (STATEMENTS_DIR) the user
// points finfolio at — a standing "inbox" of downloaded bank/card statements
// (any subfolder structure, e.g. one folder per bank) — so import is "pick from
// a list" instead of hunting through the OS file picker every time. Otherwise
// read-only: the one exception is renameStatement, an explicit, user-triggered
// rename of a single file in place — never a delete, never automatic.

import fs from 'node:fs';
import path from 'node:path';

const SUPPORTED_EXT = new Set(['.pdf', '.csv', '.txt']);

// Recursively list supported files under dir. Returns [] if dir doesn't exist
// (the feature is simply off) rather than throwing — a missing/misconfigured
// folder shouldn't break the rest of the import flow.
export function listStatements(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // dotfiles/dirs (e.g. .DS_Store)
      const entryAbs = path.join(abs, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(entryAbs, entryRel); continue; }
      if (!SUPPORTED_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = fs.statSync(entryAbs);
      out.push({
        path: entryRel, // forward-slash relative path — the id used to import it
        name: entry.name,
        ext: path.extname(entry.name).toLowerCase().slice(1),
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    }
  };
  walk(dir, '');
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Resolve a relative path the client picked back to an absolute path, refusing
// anything that escapes dir (../.. traversal, absolute paths, symlink escape).
export function resolveStatementPath(dir, relPath) {
  if (!dir) throw new Error('Statements folder is not configured');
  if (typeof relPath !== 'string' || !relPath || path.isAbsolute(relPath)) {
    throw new Error('Invalid statement path');
  }
  const base = path.resolve(dir);
  const target = path.resolve(base, relPath);
  const withinBase = target === base || target.startsWith(base + path.sep);
  if (!withinBase) throw new Error('Invalid statement path');
  return target;
}

// Rename a file already in the statements folder, keeping it in the same
// subfolder (e.g. Amex/2025JAN_AMEX.csv, not moved out of Amex/). newName is
// sanitized the same way saveImportFile sanitizes uploads. Never overwrites a
// different existing file — appends " (2)", " (3)", … instead. Returns the
// new relative path (the id the client should use from then on).
export function renameStatement(dir, relPath, newName) {
  const from = resolveStatementPath(dir, relPath);
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) {
    throw new Error('File not found in statements folder');
  }
  const safe = String(newName).replace(/[^\w.\- ]+/g, '_');
  if (!safe) throw new Error('Invalid filename');
  const destDir = path.dirname(from);
  let to = path.join(destDir, safe);
  if (path.resolve(to) !== path.resolve(from) && fs.existsSync(to)) {
    const ext = path.extname(safe);
    const stem = ext ? safe.slice(0, -ext.length) : safe;
    let n = 2;
    while (fs.existsSync(to)) { to = path.join(destDir, `${stem} (${n})${ext}`); n++; }
  }
  fs.renameSync(from, to);
  return path.relative(dir, to).split(path.sep).join('/');
}
