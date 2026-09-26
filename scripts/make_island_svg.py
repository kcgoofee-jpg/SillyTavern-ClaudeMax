#!/usr/bin/env python3
"""Render docs/assets/island.svg: the 灵动岛 cycling through its states, as a looping animated SVG.

Same spring as lib/island.js (stiffness 420, damping 32), sampled into SMIL keyframes, so
the README shows the real motion without a video. Run: python3 scripts/make_island_svg.py
"""
import math, os

W, H = 760, 240
CX, CY = W / 2, 128
FS = 20            # font size
SPRING = dict(stiffness=420, damping=32)
T_MORPH = 0.34     # seconds per morph (≈ the curve's settle time at this scale)

# (label, shape, width, height, content) — content: list of (kind, text/colour)
STATES = [
    ('idle',     'dot',  14, 14, []),
    ('thinking', 'pill', 176, 50, [('pulse', ''), ('b', '思考中'), ('dim', '3s')]),
    ('writing',  'pill', 232, 50, [('pulse', ''), ('b', '写作中'), ('dim', '1,234 字')]),
    ('done',     'pill', 356, 50, [('check', ''), ('b', '1,234 字 · 38s · 缓存 96%')]),
    ('notice',   'card', 420, 88, [('warn', ''), ('b2', '本轮体检 · 1 个问题'), ('sub', '出现了破折号（预设禁用）')]),
    ('idle',     'dot',  14, 14, []),
]
HOLD = [1.0, 1.4, 1.6, 2.0, 2.4, 0.8]   # seconds each state is held


def spring(t):
    k, c = SPRING['stiffness'], SPRING['damping']
    w0 = math.sqrt(k)
    z = c / (2 * math.sqrt(k))
    wd = w0 * math.sqrt(1 - z * z)
    return 1 - math.exp(-z * w0 * t) * (math.cos(wd * t) + (z * w0 / wd) * math.sin(wd * t))


def text_width(s, fs=FS):
    w = 0
    for ch in s:
        w += fs if ord(ch) > 0x2E80 else (0.3 * fs if ch == ' ' else 0.6 * fs)
    return w


# Timeline: hold, then morph to next.
segments = []
t = 0.0
for i, st in enumerate(STATES):
    segments.append(('hold', i, t, t + HOLD[i]))
    t += HOLD[i]
    if i < len(STATES) - 1:
        segments.append(('morph', i, t, t + T_MORPH))
        t += T_MORPH
TOTAL = t


def fmt(x):
    return f'{x:.2f}'.rstrip('0').rstrip('.')


def track(getter):
    """Key times + values for one attribute across the whole loop, springing on morphs."""
    times, vals = [], []
    for kind, i, a, b in segments:
        if kind == 'hold':
            v = getter(STATES[i])
            times += [a, b]
            vals += [v, v]
        else:
            v0, v1 = getter(STATES[i]), getter(STATES[i + 1])
            n = 14
            settle = 0.42
            for j in range(1, n + 1):
                p = j / n
                times.append(a + p * (b - a))
                vals.append(v0 + (v1 - v0) * spring(settle * p) if j < n else v1)
    # drop duplicate times (SMIL wants strictly non-decreasing; equal is allowed but keep it tidy)
    kt = ';'.join(fmt(x / TOTAL) for x in times)
    return kt, ';'.join(fmt(v) for v in vals)


def radius(st):
    return st[3] / 2 if st[1] in ('dot', 'pill') else 24


def fill_opacity(st):
    return 0.45 if st[1] == 'dot' else 1


parts = []
kt, ws = track(lambda s: s[2])
_, hs = track(lambda s: s[3])
_, xs = track(lambda s: CX - s[2] / 2)
_, ys = track(lambda s: CY - s[3] / 2)
_, rs = track(radius)
anim = lambda attr, vals: f'<animate attributeName="{attr}" dur="{fmt(TOTAL)}s" repeatCount="indefinite" calcMode="linear" keyTimes="{kt}" values="{vals}"/>'

# Pill colour: the dot is a dim green, everything else near-black.
def colour_track():
    times, vals = [], []
    for kind, i, a, b in segments:
        c = '#3ecf6e' if STATES[i][1] == 'dot' else '#0d0d0d'
        if kind == 'hold':
            times += [a, b]; vals += [c, c]
        else:
            c1 = '#3ecf6e' if STATES[i + 1][1] == 'dot' else '#0d0d0d'
            times += [a + 0.001, b]; vals += [c1, c1]
    return ';'.join(fmt(x / TOTAL) for x in times), ';'.join(vals)

ckt, cvals = colour_track()


def content_svg(st):
    kind = st[1]
    items = st[4]
    if not items:
        return ''
    out = []
    if kind == 'card':
        x0 = CX - st[2] / 2 + 26
        out.append(f'<text x="{fmt(x0)}" y="{fmt(CY - 6)}" font-size="{FS}" fill="#ffc24a" font-weight="700">⚠</text>')
        out.append(f'<text x="{fmt(x0 + 32)}" y="{fmt(CY - 6)}" font-size="{FS}" font-weight="600" fill="#f4f4f2">{items[1][1]}</text>')
        out.append(f'<text x="{fmt(x0 + 32)}" y="{fmt(CY + 22)}" font-size="{FS - 3}" fill="#f4f4f2" fill-opacity=".7">{items[2][1]}</text>')
        return ''.join(out)
    # pill: lay items out left to right, centred
    widths = []
    for k, s in items:
        widths.append(12 if k == 'pulse' else (FS if k == 'check' else text_width(s)))
    gap = 12
    total = sum(widths) + gap * (len(items) - 1)
    x = CX - total / 2
    base = CY + FS * 0.36
    for (k, s), w in zip(items, widths):
        if k == 'pulse':
            out.append(f'<circle cx="{fmt(x + 6)}" cy="{fmt(CY)}" r="6" fill="#f4f4f2"><animate attributeName="fill-opacity" values="1;.25;1" dur="1.1s" repeatCount="indefinite"/></circle>')
        elif k == 'check':
            out.append(f'<path d="M{fmt(x + 2)} {fmt(CY)} l6 6 l11 -12" stroke="#3ecf6e" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
        else:
            op = ' fill-opacity=".7"' if k == 'dim' else ''
            out.append(f'<text x="{fmt(x)}" y="{fmt(base)}" font-size="{FS}" font-weight="600" fill="#f4f4f2"{op}>{s}</text>')
        x += w + gap
    return ''.join(out)


def visibility(i):
    """Opacity + blur keyframes for state i's content: in after the morph, out before the next."""
    times, op, bl = [0], [0], [4]
    for kind, j, a, b in segments:
        if kind == 'hold' and j == i:
            fade_in = a if i == 0 else a  # morph just ended
            times += [max(fade_in - 0.12, 0.0001), fade_in + 0.1, b - 0.001]
            op += [0, 1, 1]
            bl += [4, 0, 0]
        if kind == 'morph' and j == i:
            times += [a + 0.12]
            op += [0]
            bl += [4]
    times.append(TOTAL)
    op.append(0 if i != 0 else 0)
    bl.append(4)
    pairs = sorted(zip(times, op, bl))
    return (';'.join(fmt(t / TOTAL) for t, _, _ in pairs), ';'.join(fmt(o) for _, o, _ in pairs), ';'.join(fmt(b) for _, _, b in pairs))


layers = []
for i, st in enumerate(STATES):
    body = content_svg(st)
    if not body:
        continue
    vkt, vop, vbl = visibility(i)
    layers.append(
        f'<filter id="b{i}" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="0">'
        f'<animate attributeName="stdDeviation" dur="{fmt(TOTAL)}s" repeatCount="indefinite" keyTimes="{vkt}" values="{vbl}"/></feGaussianBlur></filter>'
        f'<g filter="url(#b{i})" opacity="0"><animate attributeName="opacity" dur="{fmt(TOTAL)}s" repeatCount="indefinite" keyTimes="{vkt}" values="{vop}"/>{body}</g>')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Noto Sans SC', 'Microsoft YaHei', sans-serif">
<title>CCST 面板顶部的灵动岛：思考中 → 写作中 → 完成（字数 · 用时 · 缓存）→ 体检提示 → 缩回小点</title>
<rect width="{W}" height="{H}" rx="18" fill="#e9e6e1"/>
<rect x="24" y="{H - 50}" width="172" height="34" rx="9" fill="#fff" fill-opacity=".85"/><text x="40" y="{H - 28}" font-size="13" fill="#9a958d">模型 · Opus 5.5</text><rect x="204" y="{H - 50}" width="172" height="34" rx="9" fill="#fff" fill-opacity=".85"/><text x="220" y="{H - 28}" font-size="13" fill="#9a958d">5 小时额度 · 32%</text><rect x="384" y="{H - 50}" width="172" height="34" rx="9" fill="#fff" fill-opacity=".85"/><text x="400" y="{H - 28}" font-size="13" fill="#9a958d">上轮缓存 · 96%</text><rect x="564" y="{H - 50}" width="172" height="34" rx="9" fill="#fff" fill-opacity=".85"/><text x="580" y="{H - 28}" font-size="13" fill="#9a958d">体检 · 正常</text>
<text x="{CX}" y="40" font-size="15" fill="#6f6a62" text-anchor="middle">CCST 面板 · 灵动岛</text>
<rect x="{fmt(CX - 7)}" y="{fmt(CY - 7)}" width="14" height="14" rx="7" fill="#3ecf6e">
{anim('width', ws)}{anim('height', hs)}{anim('x', xs)}{anim('y', ys)}{anim('rx', rs)}
<animate attributeName="fill" dur="{fmt(TOTAL)}s" repeatCount="indefinite" calcMode="discrete" keyTimes="{ckt}" values="{cvals}"/>
</rect>
{''.join(layers)}
</svg>
'''
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs', 'assets', 'island.svg')
open(out, 'w', encoding='utf-8').write(svg)
print(out, f'{len(svg) // 1024} KB, loop {TOTAL:.1f}s')
