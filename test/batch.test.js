import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessAccountForProfile, buildReviewItems } from '../lib/batch.js';

test('guessAccountForProfile finds the account whose PDF preset used that bank', () => {
  const presets = {
    acc_hsbc: { type: 'pdf', profileId: 'hsbc' },
    acc_trust: { type: 'pdf', profileId: 'trust' },
    acc_csv: { hasHeader: true, dateCol: 0 } // a CSV mapping, not a pdf preset
  };
  assert.equal(guessAccountForProfile('hsbc', presets), 'acc_hsbc');
  assert.equal(guessAccountForProfile('trust', presets), 'acc_trust');
});

test('guessAccountForProfile returns null when no account has imported that bank', () => {
  assert.equal(guessAccountForProfile('dbs-card', { acc_hsbc: { type: 'pdf', profileId: 'hsbc' } }), null);
  assert.equal(guessAccountForProfile(null, {}), null);
  assert.equal(guessAccountForProfile('hsbc', null), null);
});

test('buildReviewItems shapes rows into review-queue items with carried suggestions', () => {
  const items = buildReviewItems({
    sourceFile: '2025SEP_HSBC.pdf',
    accountId: 'acc_hsbc',
    imageCacheId: 'abc123',
    transactions: [
      { date: '2025-09-05', description: 'COFFEE', amount: 12.8, suggestedCategoryId: 'food', _ocr: { page: 1, yStart: 10, yEnd: 20 } },
      { date: '', description: 'GRAB', amount: 9.5 } // unresolved date, no suggestion
    ]
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].sourceFile, '2025SEP_HSBC.pdf');
  assert.equal(items[0].accountId, 'acc_hsbc');
  assert.equal(items[0].categoryId, 'food', 'suggestion carried as the starting category');
  assert.equal(items[0].imageCacheId, 'abc123');
  assert.deepEqual(items[0]._ocr, { page: 1, yStart: 10, yEnd: 20 });
  assert.equal(items[1].date, '', 'unresolved date stays blank/editable');
  assert.equal(items[1].categoryId, '', 'no suggestion -> uncategorized');
  assert.match(items[0].id, /[0-9a-f-]{36}/, 'each item gets a unique id');
  assert.notEqual(items[0].id, items[1].id);
});
