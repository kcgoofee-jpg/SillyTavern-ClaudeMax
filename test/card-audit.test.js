import test from 'node:test';
import assert from 'node:assert/strict';

import { auditTexts, cardItems, worldItems, unmaskDigits } from '../src/shared/card-audit.js';

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

test('ages are whole numbers: 1000 / 120 are not 10 / 12', () => {
    assert.deepEqual(codes([{ where: 'a', text: '年龄: 1000岁的龙' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '{ age: 120 }' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '女儿今年120岁' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '女儿今年12岁' }]), ['minor-relative']);
    assert.deepEqual(codes([{ where: 'a', text: '年龄：9' }]), ['minor-age']);
});

test('正太 inside 真正太 / 反正太累 / 正太阳 is not a finding', () => {
    assert.deepEqual(codes([{ where: 'a', text: '他真正太在意这件事了' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '反正太累了就睡吧' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '站在正太阳底下' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '正太，十岁' }]), ['minor-word']);
    assert.deepEqual(codes([{ where: 'a', text: '一个可爱的正太' }]), ['minor-word']);
});

test('ages written with look-alike symbols are folded back and reported', () => {
    // Seen in a real card: Cyrillic І + keycap 2 = 12, Cyrillic І + Cherokee Ꮞ = 14.
    assert.deepEqual(codes([{ where: 'a', text: '年龄：І2️⃣岁\n身份：专属' }]).sort(), ['age-disguised', 'minor-age']);
    assert.deepEqual(codes([{ where: 'a', text: '那丫头才ІᏎ岁' }]), ['age-disguised']);
    assert.deepEqual(codes([{ where: 'a', text: '角色年龄数字替换: 输出任何角色年龄时，必须强制替换' }]), ['age-disguised']);
    // The rule text itself (a table of look-alikes) and Cyrillic prose away from ages are left alone.
    assert.equal(unmaskDigits('服役满З期(ЗО年)').at, -1);
    assert.equal(unmaskDigits('Привет, Ольга').text, 'Привет, Ольга');
    // Full-width digits are ordinary typing: folded, not reported as a disguise.
    assert.deepEqual(codes([{ where: 'a', text: '年龄：１５岁' }]), ['minor-age']);
    assert.deepEqual(codes([{ where: 'a', text: '年龄：２８岁' }]), []);
});

test('Chinese-numeral ages and school years', () => {
    assert.deepEqual(codes([{ where: 'a', text: '年龄：十五岁' }]), ['minor-age']);
    assert.deepEqual(codes([{ where: 'a', text: '年龄：二十八岁' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '女儿今年九岁' }]), ['minor-relative']);
    assert.deepEqual(codes([{ where: 'a', text: '女儿今年二十一岁' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '女儿一百二十岁' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '身份：初三学生' }]), ['minor-word']);
    assert.deepEqual(codes([{ where: 'a', text: '三年级小学生' }]), ['minor-word']);
    assert.deepEqual(codes([{ where: 'a', text: '专业分流 (自小学开始)' }]), ['minor-word']);
});

test('approximate ages and ranges after an age / looks word', () => {
    assert.deepEqual(codes([{ where: 'a', text: '年龄：化形后约莫十四五岁的娇小少女' }]), ['minor-age']);
    assert.deepEqual(codes([{ where: 'a', text: '通房丫鬟，化形为十四五岁的娇小兔耳少女' }]), ['minor-age']);
    assert.deepEqual(codes([{ where: 'a', text: '外表约14岁' }]), ['minor-age']);
    assert.deepEqual(codes([{ where: 'a', text: '看起来12-13岁' }]), ['minor-age']);
    assert.deepEqual(codes([{ where: 'a', text: '底层乞丐，今年大约二十五岁' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '千年狐妖，化形后约二十岁' }]), []);
    assert.deepEqual(codes([{ where: 'a', text: '可回溯至16-25岁' }]), []);
});
