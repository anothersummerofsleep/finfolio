// Pure helpers for bulk ("drag the whole folder in") import. The heavy lifting
// (OCR, parsing) lives in server.js; these are the small, testable pieces:
// guessing which account a detected bank maps to, and shaping parsed rows into
// review-queue items. Kept here so they can be unit-tested without a server.

import { randomUUID } from 'node:crypto';

// Which account should a detected bank profile route to? Reuse import-presets:
// a saved PDF preset already records accountId -> profileId from a prior manual
// import, so the account that last imported this bank is the best guess. Returns
// null when no account has imported that bank yet (the user picks in triage).
export function guessAccountForProfile(profileId, presets) {
  if (!profileId || !presets) return null;
  for (const [accountId, p] of Object.entries(presets)) {
    if (p && p.type === 'pdf' && p.profileId === profileId) return accountId;
  }
  return null;
}

// Shape one triaged file's parsed transactions into review-queue items. The
// review queue (see public/js/review-queue.js + /api/review-queue/commit) is the
// landing spot: grouped by sourceFile, one accountId per item, additive commit.
// Category suggestions carry over so the user only fixes the unmatched rows; a
// row PaddleOCR left without a resolvable date arrives with an empty (editable)
// date, exactly as the single-file review handles it.
// file: { sourceFile, accountId, imageCacheId?, transactions: [{ date, description,
//         amount, suggestedCategoryId?, _ocr? }] }
export function buildReviewItems(file) {
  const { sourceFile, accountId, imageCacheId } = file;
  return (file.transactions || []).map((t) => ({
    id: randomUUID(),
    sourceFile,
    accountId,
    date: t.date || '',
    description: t.description || '',
    amount: t.amount ?? null,
    categoryId: t.suggestedCategoryId || '',
    imageCacheId: imageCacheId || t.imageCacheId || null,
    _ocr: t._ocr || null
  }));
}
