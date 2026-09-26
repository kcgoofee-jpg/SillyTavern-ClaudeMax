#!/usr/bin/env python3
"""把「提示词拆分」导出的柏宝绘配方写进柏宝绘（NovelAI 渠道 → 画师串）。

新建一个画师串配方（画师串 + 绑定的质量词 + 绑定的负面提示词）并选中它，再把配方里的
参数（步数、引导、cfg rescale、采样器、噪声调度、模型）写到 NovelAI 渠道。尺寸和种子不动。
只打印配方名字、各块的 tag 数和改了哪些参数，不打印任何提示词内容。

柏宝绘把设置放在网页内存里、保存时整份写回：运行前关掉所有酒馆网页和 TT 窗口。
用法：python3 baibai_import.py 配方.json settings.json [更多 settings.json…]
"""
import json, os, shutil, sys, time

SAMPLERS = {'k_euler', 'k_euler_ancestral', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_sde', 'ddim_v3'}
SCHEDULES = {'karras', 'native', 'exponential', 'polyexponential'}
MODELS = {'nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated',
          'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview', 'nai-diffusion-3'}
PARAM_LABELS = {'steps': '步数', 'scale': '引导', 'cfgRescale': 'cfg rescale', 'sampler': '采样器', 'noiseSchedule': '噪声调度', 'model': '模型'}


def tag_count(text):
    return len([t for t in (text or '').split(',') if t.strip()])


def valid_params(params):
    out = {}
    p = params or {}
    if isinstance(p.get('steps'), (int, float)) and 1 <= p['steps']:
        out['steps'] = int(min(28, p['steps']))
    if isinstance(p.get('scale'), (int, float)) and 0 <= p['scale'] <= 20:
        out['scale'] = float(p['scale'])
    if isinstance(p.get('cfgRescale'), (int, float)) and 0 <= p['cfgRescale'] <= 1:
        out['cfgRescale'] = p['cfgRescale']
    if p.get('sampler') in SAMPLERS:
        out['sampler'] = p['sampler']
    if p.get('noiseSchedule') in SCHEDULES:
        out['noiseSchedule'] = p['noiseSchedule']
    if p.get('model') in MODELS:
        out['model'] = p['model']
    return out


def apply(settings_path, preset, params):
    s = json.load(open(settings_path, encoding='utf-8'))
    nai = s.setdefault('extension_settings', {}).setdefault('baibai_image', {}).setdefault('nai', {})
    presets = nai.setdefault('artistPresets', [])
    entry = {'id': f'art_{int(time.time() * 1000)}_{len(presets)}', 'name': preset['name'],
             'prompt': preset.get('prompt', ''), 'quality': preset.get('quality', ''), 'negative': preset.get('negative', '')}
    presets.append(entry)
    nai['activeArtistId'] = entry['id']
    nai.update(params)
    backup = f"{settings_path}.{time.strftime('%Y%m%d-%H%M%S')}.bak"
    shutil.copy2(settings_path, backup)
    tmp = settings_path + '.tmp'
    json.dump(s, open(tmp, 'w', encoding='utf-8'), ensure_ascii=False, indent=4)
    os.replace(tmp, settings_path)
    return backup


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    preset = json.load(open(sys.argv[1], encoding='utf-8'))
    if preset.get('type') != 'baibai-nai-preset':
        print('这不是「提示词拆分」导出的柏宝绘配方文件。')
        return 1
    params = valid_params(preset.get('params'))
    print(f"配方「{preset.get('name')}」：画师串 {tag_count(preset.get('prompt'))} 个 tag，"
          f"质量词 {tag_count(preset.get('quality'))} 个，负面 {tag_count(preset.get('negative'))} 个")
    print('参数：' + ('、'.join(PARAM_LABELS[k] for k in params) if params else '无（沿用柏宝绘现有设置）'))
    written = 0
    for path in sys.argv[2:]:
        if not os.path.exists(path):
            print(f'跳过（没有 {path}）')
            continue
        backup = apply(path, preset, params)
        print(f'已写入 {path}（原文件备份为 {os.path.basename(backup)}）')
        written += 1
    if not written:
        print('一个设置文件都没写入（上面列出的都不存在）。')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
