#!/usr/bin/env node
// 版本号只写在 package.json 一处（规则见 docs/版本规范.md）。
//   node scripts/version.mjs 3.1.0     改版本：写进 package.json，并同步到 manifest.json
//   node scripts/version.mjs --check   只检查两处是否一致（门控用），不一致时退出码 1
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const read = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
// 只替换 "version" 这一行，保留文件原来的缩进和字段顺序
const setVersion = (f, v) => {
    const text = readFileSync(join(ROOT, f), 'utf8');
    writeFileSync(join(ROOT, f), text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${v}"`));
};

const arg = process.argv[2];
if (arg === '--check') {
    const p = read('package.json').version;
    const m = read('manifest.json').version;
    if (!SEMVER.test(p)) { console.error(`package.json 的版本「${p}」不是 x.y.z`); process.exit(1); }
    if (m !== p) { console.error(`manifest.json 是 ${m}，package.json 是 ${p}：运行 node scripts/version.mjs ${p}`); process.exit(1); }
    process.exit(0);
}
if (!arg || !SEMVER.test(arg)) {
    console.error('用法：node scripts/version.mjs <x.y.z> | --check');
    process.exit(2);
}
setVersion('package.json', arg);
setVersion('manifest.json', arg);
console.log(`版本 → ${arg}（package.json、manifest.json）。记得在 CHANGELOG.md 写这一版的改动。`);
