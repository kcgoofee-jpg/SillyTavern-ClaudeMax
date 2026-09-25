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

test('second-person presets do not trigger the person check', async () => {
    const { secondPersonFromPreset } = await import('../lib/chat-check.js');
    const preset = {
        prompts: [{ identifier: 'a', name: '👤第二人称user视角' }, { identifier: 'b', name: '👤第三人称' }],
        prompt_order: [{ order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: false }] }],
    };
    assert.equal(secondPersonFromPreset(preset), true);
    preset.prompt_order[0].order[0].enabled = false;
    assert.equal(secondPersonFromPreset(preset), false);
    const body = '<content>' + '你推开门，你看见她，你愣住，你后退，你笑了。'.repeat(2) + '</content>';
    assert.ok(checkReply({ mes: body }).issues.some((i) => i.code === 'person'));
    assert.ok(!checkReply({ mes: body, secondPerson: true }).issues.some((i) => i.code === 'person'));
});

test('word range from an enabled「字数」entry name, and Ny-style four options', async () => {
    const { wordRangeFromPreset } = await import('../lib/chat-check.js');
    const preset = {
        prompts: [{ identifier: 'w', name: '✂️ 字数｜1400–1600字', content: '' }, { identifier: 'x', name: '✂️ 字数｜800–1000字', content: '' }],
        prompt_order: [{ order: [{ identifier: 'w', enabled: true }, { identifier: 'x', enabled: false }] }],
    };
    assert.deepEqual(wordRangeFromPreset(preset), [1400, 1600]);
    assert.equal(wordRangeFromPreset({ prompts: [], prompt_order: [] }), null);
    const ny = (n) => `<content>正文</content><small>接下来\n${['1️⃣ 走', '2️⃣ 跑', '3️⃣ 停', '4️⃣ 看'].slice(0, n).join('\n')}\ntips: 小心</small>`;
    assert.ok(!checkReply({ mes: ny(4) }).issues.some((i) => i.code === 'options'));
    assert.match(checkReply({ mes: ny(3) }).issues.find((i) => i.code === 'options').text, /只有 3 个/);
});

test('childhood flashbacks must stay innocent', async () => {
    const { flashbackText } = await import('../lib/chat-check.js');
    const clean = '<content>现在的剧情。\n> 【回忆】\n> 那年夏天我们在河边钓鱼，他把唯一的面包掰成两半。\n回到现在。</content>';
    assert.match(flashbackText(clean), /钓鱼/);
    assert.ok(!checkReply({ mes: clean }).issues.some((i) => i.code === 'flashback'));
    const bad = '<content>> 【回忆】\n> 她的胸部……\n</content>';
    assert.match(checkReply({ mes: bad }).issues.find((i) => i.code === 'flashback').text, /胸部/);
    // explicit words OUTSIDE the flashback are not this check's business
    assert.ok(!checkReply({ mes: '<content>成年人的剧情：吻。\n> 【回忆】\n> 我们爬上了老槐树。</content>' }).issues.some((i) => i.code === 'flashback'));
});

import { bodyOf as bodyOfForImages } from '../lib/chat-check.js';

test('image tags and HTML cards are not counted as prose', () => {
    const mes = '<content>她推门。\n<bbi_image>1boy, 2girls, bedroom</bbi_image>\n<htm1fenge><div>卡片</div></htm1fenge>灯亮了。</content>';
    assert.equal(bodyOfForImages(mes).replace(/\s/g, ''), '她推门。灯亮了。');
});
