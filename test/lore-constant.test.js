import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeLore, makeAllConstant, backupName } from '../lib/lore-constant.js';

const book = { entries: {
    0: { constant: true, content: '常驻' },
    1: { constant: false, content: '铁甲熊' },
    2: { constant: false, disable: true, content: '关掉的' },
    3: { content: '没写 constant 字段' },
} };

test('counts only enabled keyword entries', () => {
    assert.deepEqual(summarizeLore(book), { keyword: 2, keywordChars: '铁甲熊'.length + '没写 constant 字段'.length });
});

test('makeAllConstant converts enabled keyword entries and leaves the input untouched', () => {
    const { book: next, changed } = makeAllConstant(book);
    assert.equal(changed, 2);
    assert.equal(next.entries[1].constant, true);
    assert.equal(next.entries[3].constant, true);
    assert.equal(next.entries[2].constant, false);      // disabled entries stay as they are
    assert.equal(book.entries[1].constant, false);      // original not mutated
    assert.equal(summarizeLore(next).keyword, 0);
    assert.equal(backupName('木屋求生世界书'), '木屋求生世界书（常驻前备份）');
});
