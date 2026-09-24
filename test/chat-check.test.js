import test from 'node:test';
import assert from 'node:assert/strict';

import { checkReply, bannedFromPrompts, wordRangeFromPrompts, statusNumbers } from '../lib/chat-check.js';

const status = (hp, food, pts) => `<status>\n生命: ${hp}/100 | 饥饿: ${food}/100\n资源: 木材 3 | 积分 ${pts}\n好感: 苏念念 5 | 林初晴 6\n</status>`;
const reply = (body, extra = '') => `<content>${body}</content>\n${extra}`;
const opts = (labels) => `<branches>\n<details><summary>🧩Select</summary>\n${'ABCDEFGHIJ'.split('').map((l) => `${l}.${labels ? '[稳健路线] ' : ''}去溪边`).join('\n')}\n</details>\n</branches>`;

test('preset parsing: banned list and word range', () => {
    const prompts = [
        { name: '❎丨禁词表', content: '禁止使用‘似笑非笑、嘴角勾起’等套话\n用‘语气、声音’给台词贴标签' },
        { name: '💬丨字数设定', content: '{{setvar::word_count::[大于1200小于1600]}}{{trim}}' },
    ];
    assert.deepEqual(bannedFromPrompts(prompts).sort(), ['似笑非笑', '嘴角勾起'].sort());
    assert.deepEqual(wordRangeFromPrompts(prompts), [1200, 1600]);
});

test('status numbers parse the 7-line block', () => {
    assert.deepEqual(statusNumbers(status(96, 80, 50)), { 生命: 96, 饥饿: 80, 木材: 3, 积分: 50, 苏念念: 5, 林初晴: 6 });
});

test('checkReply flags the usual problems and only gauge jumps', () => {
    const body = '他笑了——似笑非笑。这不是害怕，是兴奋。你看你你你你。'.repeat(3) + '她学过医学院的课。';
    const r = checkReply({
        mes: reply(body, status(40, 79, 350) + opts(false)),
        prevMes: reply('上一轮。', status(96, 80, 50)),
        words: [1200, 1600], banned: ['似笑非笑'], leaks: ['医学院'],
    });
    const codes = r.issues.map((i) => i.code);
    for (const c of ['length', 'person', 'banned', 'dash', 'notbut', 'labels', 'leak', 'status']) assert.ok(codes.includes(c), c);
    assert.match(r.issues.find((i) => i.code === 'status').text, /生命 96→40/);
    assert.doesNotMatch(r.issues.find((i) => i.code === 'status').text, /积分/);   // 50→350 is a reward, not a gauge
});

test('a clean reply has no issues', () => {
    const body = '溪水很凉。'.repeat(280);
    const r = checkReply({ mes: reply(body, status(96, 79, 50) + opts(true)), prevMes: reply('昨天的事。', status(98, 80, 50)), words: [1200, 1600], banned: ['似笑非笑'] });
    assert.deepEqual(r.issues, []);
});
