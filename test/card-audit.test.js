import test from 'node:test';
import assert from 'node:assert/strict';

import { auditTexts, cardItems, worldItems } from '../lib/card-audit.js';

const codes = (items) => auditTexts(items).map((f) => f.code);

test('flags minor ages, relatives, words and unlimited age; adult backstory ages pass', () => {
    assert.deepEqual(codes([{ where: 'a', text: '年龄: 14岁' }]), ['minor-age']);
    assert.deepEqual(codes([{ where: 'a', text: "{ name: 'x', age: 14, rank: 'B' }" }]), ['minor-age']);
    assert.deepEqual(codes([{ where: 'a', text: '单亲母亲（女儿艾米7岁）' }]), ['minor-relative']);
    assert.deepEqual(codes([{ where: 'a', text: '腹黑阳光的小正太' }]), ['minor-word']);
    assert.deepEqual(codes([{ where: 'a', text: '- 年龄范围无限制' }]), ['age-unlimited']);
    assert.deepEqual(codes([{ where: 'a', text: '脸型: 幼态鹅蛋脸' }]), ['youth-coded']);
    assert.deepEqual(codes([{ where: 'a', text: 'const state = { stage:0, market: 1 }' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '年龄: 28岁\n15岁离家，16岁被招募，母亲在她12岁时病死。' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '御姐、熟女同为适用对象。未成年角色一律不适用本条，也不做任何性化描写。' }]), []);
});

test('high findings first, disabled ones after enabled ones', () => {
    const f = auditTexts([
        { where: 'x', text: '幼态脸' },
        { where: 'y', text: '年龄: 14岁', disabled: true },
        { where: 'z', text: '年龄: 15岁' },
    ]);
    assert.deepEqual(f.map((x) => x.where), ['z', 'y', 'x']);
});

test('card and world items cover greetings, scripts, regex and entries', () => {
    const card = { data: {
        alternate_greetings: ['你好'],
        character_book: { entries: [{ comment: '人物', content: '年龄: 30岁' }] },
        extensions: {
            regex_scripts: [{ scriptName: '开局', replaceString: "{ name: 'a', age: 14 }" }],
            tavern_helper: { scripts: [{ name: '图鉴', content: 'x', data: { characters: [{ name: 'a' }] } }] },
        },
    } };
    const where = cardItems(card).map((i) => i.where);
    assert.ok(where.includes('开场白 #1') && where.includes('正则·开局') && where.includes('脚本数据·图鉴'));
    assert.deepEqual(auditTexts(cardItems(card)).map((f) => f.where), ['正则·开局']);
    assert.equal(worldItems({ entries: { 1: { comment: 'e', content: '年龄: 12岁', disable: true } } }, 'W')[0].disabled, true);
});
