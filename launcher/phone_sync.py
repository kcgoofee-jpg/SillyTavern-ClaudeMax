#!/usr/bin/env python3
"""电脑酒馆（SillyTavern）↔ 手机 TauriTavern 双向同步（adb，USB 或无线调试）；
也能同步这台 Mac 上的 TauriTavern（--local-tt，规则相同，不用 adb）。

同步：聊天、角色卡、世界书、预设、头像、背景、生图图片、主题、快速回复；扩展只从电脑推到手机（git 版本较新时）。
不同步：设置（两边的代理地址不同）和密钥。另外把手机上的代理地址对准这台 Mac 现在的 IP。

规则（按上次同步时记下的状态判断哪边改过）：
  只有一边改过 → 用改过的那边；两边都改过（冲突）→ 用较新的，另一份存进备份。
  只有一边有的文件 → 复制到另一边。从不删除文件。
  被覆盖的文件先备份到 <酒馆目录>/backups/<日期>/<时间>-手机同步前/{电脑,手机}/。
手机上的 TauriTavern 数据在 Android/data 里：需要 root（su），或 Android 10 及以下。

用法：phone_sync.py --st <SillyTavern/data/default-user> --adb <adb> --serial S [--dry-run]
      [--mac-ip IP --port 8901 --lan-key-file F]
      phone_sync.py --st <…> --local-tt <TT 的 data/default-user> [--dry-run] [--port 8901]
"""
import argparse, io, json, os, re, shlex, subprocess, sys, tarfile, tempfile, time

PKG = 'com.tauritavern.client'
REMOTE_ROOTS = [f'/data/media/0/Android/data/{PKG}/data/default-user', f'/sdcard/Android/data/{PKG}/data/default-user']
DIRS = ['chats', 'group chats', 'groups', 'characters', 'worlds', 'OpenAI Settings', 'User Avatars',
        'backgrounds', 'user/images', 'user/files', 'themes', 'QuickReplies']
SAME_WINDOW = 2  # 秒：两边修改时间相差不超过这个、大小相同，视为同一份


def skip(rel):
    base = os.path.basename(rel)
    return base.startswith('._') or base == '.DS_Store'


class Phone:
    def __init__(self, adb, serial):
        self.adb, self.serial = adb, serial
        self.root = self.sh('id', su=True).startswith('uid=0')
        self.base = None
        for b in REMOTE_ROOTS:
            if self.sh(f'test -d {shlex.quote(b)} && echo yes', su=self.root).strip() == 'yes':
                self.base = b
                break

    def run(self, *args, data=None):
        return subprocess.run([self.adb, '-s', self.serial, *args], input=data, capture_output=True, check=False)

    def sh(self, cmd, su=False):
        if su:
            cmd = f'su -c {shlex.quote(cmd)}'
        return self.run('shell', cmd).stdout.decode('utf-8', 'replace')

    def rsh(self, cmd):
        return self.sh(cmd, su=self.root)


class LocalTT:
    """这台 Mac 上的 TauriTavern：直接读写文件。"""
    label = 'Mac TT'

    def __init__(self, base):
        self.base = base if os.path.isdir(base) else None
        self.root = False


def local_files(st):
    out = {}
    for d in DIRS:
        top = os.path.join(st, d)
        for dp, _, fs in os.walk(top):
            for f in fs:
                p = os.path.join(dp, f)
                rel = os.path.relpath(p, st)
                if skip(rel):
                    continue
                s = os.stat(p)
                out[rel] = (int(s.st_mtime), s.st_size)
    return out


def remote_files(ph):
    if isinstance(ph, LocalTT):
        return local_files(ph.base)
    dirs = ' '.join(shlex.quote(d) for d in DIRS)
    txt = ph.rsh(f'cd {shlex.quote(ph.base)} && for d in {dirs}; do [ -d "$d" ] && find "$d" -type f -exec stat -c "%Y %s %n" {{}} +; done')
    out = {}
    for line in txt.splitlines():
        m = re.match(r'^(\d+) (\d+) (.+)$', line)
        if m and not skip(m.group(3)):
            out[m.group(3)] = (int(m.group(1)), int(m.group(2)))
    return out


def same(a, b):
    return a and b and a[1] == b[1] and abs(a[0] - b[0]) <= SAME_WINDOW


def plan(loc, rem, state):
    push, pull, conflicts = [], [], []
    for rel in sorted(set(loc) | set(rem)):
        L, R, S = loc.get(rel), rem.get(rel), state.get(rel)
        if L and not R:
            push.append(rel)
        elif R and not L:
            pull.append(rel)
        elif same(L, R):
            continue
        else:
            l_changed = not S or tuple(S['l']) != L
            r_changed = not S or tuple(S['r']) != R
            if l_changed and not r_changed:
                push.append(rel)
            elif r_changed and not l_changed:
                pull.append(rel)
            else:
                if S:
                    conflicts.append(rel)
                (push if L[0] >= R[0] else pull).append(rel)
    return push, pull, conflicts


def tar_bytes(st, rels):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.GNU_FORMAT) as t:
        for rel in rels:
            info = t.gettarinfo(os.path.join(st, rel), arcname=rel)
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            with open(os.path.join(st, rel), 'rb') as f:
                t.addfile(info, f)
    return buf.getvalue()


def pull_tar(ph, rels):
    """Remote files → tar bytes."""
    if isinstance(ph, LocalTT):
        return tar_bytes(ph.base, rels)
    lst = '\n'.join(rels).encode('utf-8') + b'\n'
    with tempfile.NamedTemporaryFile(delete=False) as f:
        f.write(lst)
    ph.run('push', f.name, '/data/local/tmp/cm_list.txt')
    os.unlink(f.name)
    ph.rsh(f'cd {shlex.quote(ph.base)} && tar -cf /data/local/tmp/cm_pull.tar -T /data/local/tmp/cm_list.txt; chmod 644 /data/local/tmp/cm_pull.tar')
    with tempfile.TemporaryDirectory() as tmp:
        dst = os.path.join(tmp, 'p.tar')
        ph.run('pull', '/data/local/tmp/cm_pull.tar', dst)
        data = open(dst, 'rb').read() if os.path.exists(dst) else b''
    ph.rsh('rm -f /data/local/tmp/cm_pull.tar /data/local/tmp/cm_list.txt')
    return data


def push_tar(ph, data):
    if isinstance(ph, LocalTT):
        extract(data, ph.base)
        return
    with tempfile.NamedTemporaryFile(delete=False, suffix='.tar') as f:
        f.write(data)
    ph.run('push', f.name, '/data/local/tmp/cm_push.tar')
    os.unlink(f.name)
    b = shlex.quote(ph.base)
    out = ph.rsh(f'cd {b} && tar -xf /data/local/tmp/cm_push.tar && chown -R $(stat -c %u:%g {b}) {b} && echo CM_OK; rm -f /data/local/tmp/cm_push.tar')
    if 'CM_OK' not in out:
        raise RuntimeError('手机上解包失败（存储空间满了、或连接中断）')


def extract(data, dest):
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        for m in t.getmembers():
            if not m.isfile() or m.name.startswith('/') or '..' in m.name.split('/'):
                continue
            target = os.path.join(dest, m.name)
            if os.path.exists(target) and not os.access(target, os.W_OK):
                os.chmod(target, 0o644)   # git 的对象文件是只读的，覆盖前放开
            t.extract(m, dest, set_attrs=False)
            os.utime(os.path.join(dest, m.name), (m.mtime, m.mtime))


EXT_SKIP = {'node_modules', 'data', '.DS_Store'}


def local_rev(d):
    r = subprocess.run(['git', '-C', d, 'rev-parse', 'HEAD'], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def remote_rev(ph, d):
    if isinstance(ph, LocalTT):
        return local_rev(d) if os.path.isdir(os.path.join(d, '.git')) else None
    q = shlex.quote(d)
    head = ph.rsh(f'cat {q}/.git/HEAD 2>/dev/null').strip()
    if not head.startswith('ref: '):
        return head or None
    ref = head[5:]
    sha = ph.rsh(f'cat {q}/.git/{ref} 2>/dev/null').strip()
    if not sha:
        m = re.search(r'^([0-9a-f]{40}) ' + re.escape(ref) + '$', ph.rsh(f'cat {q}/.git/packed-refs 2>/dev/null'), re.M)
        sha = m.group(1) if m else ''
    return sha or None


def sync_extensions(ph, ext_dir, dry):
    """电脑上的第三方扩展（git 版本）比手机新 → 整个推过去（不带 node_modules / data）。只推不拉。"""
    remote_ext = ph.base.rsplit('/default-user', 1)[0] + '/extensions/third-party'
    todo = []
    for name in sorted(os.listdir(ext_dir)):
        src = os.path.realpath(os.path.join(ext_dir, name))
        if not os.path.isdir(src):
            continue
        rev = local_rev(src)
        if rev and rev != remote_rev(ph, f'{remote_ext}/{name}'):
            todo.append((name, src, rev))
    for name, _, rev in todo:
        print(f'  扩展 → {getattr(ph, "label", "手机")}：{name}（{rev[:7]}）')
    if dry or not todo:
        return len(todo)
    for name, src, _ in todo:
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode='w', format=tarfile.GNU_FORMAT) as t:
            def filt(ti):
                parts = ti.name.split('/')
                if any(p in EXT_SKIP or p.startswith('._') for p in parts):
                    return None
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = ''
                return ti
            t.add(src, arcname=name, filter=filt)
        if isinstance(ph, LocalTT):
            dst = os.path.join(remote_ext, name)
            if os.path.islink(dst):
                os.unlink(dst)   # 旧的符号链接：换成实体副本
            os.makedirs(remote_ext, exist_ok=True)
            extract(buf.getvalue(), remote_ext)
            continue
        with tempfile.NamedTemporaryFile(delete=False, suffix='.tar') as f:
            f.write(buf.getvalue())
        ph.run('push', f.name, '/data/local/tmp/cm_ext.tar')
        os.unlink(f.name)
        e = shlex.quote(remote_ext)
        ph.rsh(f'cd {e} && tar -xf /data/local/tmp/cm_ext.tar && chown -R $(stat -c %u:%g {e}) {e}/{shlex.quote(name)}; rm -f /data/local/tmp/cm_ext.tar')
    return len(todo)


# 复制到本机 TT 的扩展设置（TT 自己的连接管理、界面、禁用列表等不动）
EXT_SETTING_KEYS = ['LittleWhiteBox', 'baibai_api_channels', 'baibai_exclude_settings', 'baibai_image',
                    'baibai_image_char_global', 'mvu_settings', 'tavern_helper', 'EjsTemplate', 'claude_max',
                    'regex', 'regex_presets', 'preset_allowed_regex', 'character_allowed_regex']


def copy_settings(ph, st, bk):
    """电脑酒馆的扩展设置和对话补全设置（当前预设、模型、开关）→ 本机 TT。先备份 TT 的两份设置。"""
    src = json.load(open(os.path.join(st, 'settings.json'), encoding='utf-8'))
    changed = []
    for rel, apply in (('settings.json', lambda d: d.setdefault('extension_settings', {}).update(
                           {k: src['extension_settings'][k] for k in EXT_SETTING_KEYS if k in src.get('extension_settings', {})})),
                       ('settings/presets.json', lambda d: d.update({'oai_settings': src['oai_settings']}) if 'oai_settings' in src else None)):
        path = os.path.join(ph.base, rel)
        if not os.path.exists(path):
            continue
        raw = open(path, encoding='utf-8').read()
        d = json.loads(raw)
        before = json.loads(raw)
        apply(d)
        if d == before:
            continue
        os.makedirs(os.path.join(bk, os.path.dirname(rel)), exist_ok=True)
        open(os.path.join(bk, rel), 'w', encoding='utf-8').write(raw)
        open(path, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=4 if rel == 'settings.json' else None))
        changed.append(rel)
    return changed


def fix_endpoint(ph, ip, port, key):
    """手机设置里指向 :port 的代理地址 → 这台 Mac 现在的 IP；访问密码对上 Mac 的。"""
    new = f'http://{ip}:{port}'
    pat = re.compile(r'http://[0-9A-Za-z.\-]+:' + str(port))
    changed = []
    for rel in ('settings.json', 'settings/presets.json'):
        path = f'{ph.base}/{rel}'
        if isinstance(ph, LocalTT):
            raw = open(path, encoding='utf-8').read() if os.path.exists(path) else ''
        else:
            raw = ph.rsh(f'cat {shlex.quote(path)} 2>/dev/null')
        if not raw.strip().startswith('{'):
            continue
        d = json.loads(raw)
        t = json.dumps(d, ensure_ascii=False)
        t2 = pat.sub(new, t)
        d = json.loads(t2)
        cm = (d.get('extension_settings') or {}).get('claude_max')
        if key and cm is not None and cm.get('accessKey') != key:
            cm['accessKey'] = key
        if d == json.loads(raw):   # 比较内容，不比较排版
            continue
        out = json.dumps(d, ensure_ascii=False, indent=4 if rel == 'settings.json' else None)
        if isinstance(ph, LocalTT):
            open(path, 'w', encoding='utf-8').write(out)
            changed.append(rel)
            continue
        with tempfile.NamedTemporaryFile(delete=False, mode='w', encoding='utf-8') as f:
            f.write(out)
        ph.run('push', f.name, '/data/local/tmp/cm_cfg.json')
        os.unlink(f.name)
        q = shlex.quote(path)
        ph.rsh(f'owner=$(stat -c %u:%g {q}); cp /data/local/tmp/cm_cfg.json {q} && chown $owner {q}; rm -f /data/local/tmp/cm_cfg.json')
        changed.append(rel)
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--st', required=True)
    ap.add_argument('--adb')
    ap.add_argument('--serial')
    ap.add_argument('--push-only', action='store_true',
                    help='只从电脑推过去：对方独有的文件不拉回来，对方更新的文件不覆盖（导入 / 安装用）')
    ap.add_argument('--settings', action='store_true',
                    help='（仅 --local-tt）把电脑酒馆的扩展设置和对话补全设置复制过去')
    ap.add_argument('--local-tt', help='这台 Mac 上 TauriTavern 的 data/default-user（代替 --adb/--serial）')
    ap.add_argument('--state', required=True)
    ap.add_argument('--backups', required=True)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--mac-ip')
    ap.add_argument('--port', type=int, default=8901)
    ap.add_argument('--lan-key-file')
    ap.add_argument('--ext-dir', help='电脑上的第三方扩展目录（SillyTavern/public/scripts/extensions/third-party）')
    a = ap.parse_args()

    if a.local_tt:
        ph = LocalTT(a.local_tt)
        if not ph.base:
            print(f'✗ 找不到 {a.local_tt}：这台 Mac 没装 TauriTavern，或还没打开过一次。')
            return 2
        a.mac_ip = a.mac_ip or '127.0.0.1'   # 本机 TT 直接连本机代理，不用访问密码
    elif not (a.adb and a.serial):
        ap.error('需要 --adb 和 --serial，或者 --local-tt')
    else:
        ph = Phone(a.adb, a.serial)
    side = getattr(ph, 'label', '手机')
    if not ph.base:
        print('✗ 手机上找不到 TauriTavern 的数据（没装，或没有 root 读不到 Android/data）。')
        print('  没有 root 时：用 TauriTavern 自带的「数据迁移」扩展导出 / 导入。')
        return 2
    print(f'  {side}：{a.local_tt or a.serial}{"（root）" if ph.root else ""}')
    state = json.load(open(a.state, encoding='utf-8')) if os.path.exists(a.state) else {}
    loc, rem = local_files(a.st), remote_files(ph)
    push, pull, conflicts = plan(loc, rem, state)
    kept = []
    if a.push_only:
        kept = [r for r in pull if r in loc]   # 对方的更新：不覆盖
        only_there = [r for r in pull if r not in loc]
        pull, conflicts = [], []
        if only_there:
            print(f'  {side}独有、电脑上没有的 {len(only_there)} 个文件：保留在{side}，不拉回电脑')
        for rel in kept:
            print(f'  ! {side}上的比电脑新，没有覆盖：{rel}')
    print(f'  电脑 {len(loc)} 个文件，{side} {len(rem)} 个文件')
    print(f'  → {side}：{len(push)} 个    ← 电脑：{len(pull)} 个    两边都改过：{len(conflicts)} 个')
    for rel in (push[:8]):
        print(f'     → {rel}')
    if len(push) > 8:
        print(f'     → … 另 {len(push) - 8} 个')
    for rel in (pull[:8]):
        print(f'     ← {rel}')
    if len(pull) > 8:
        print(f'     ← … 另 {len(pull) - 8} 个')
    for rel in conflicts:
        print(f'  ! 两边都改过，用较新的一份，另一份进备份：{rel}')
    if a.ext_dir:
        n = sync_extensions(ph, a.ext_dir, a.dry_run)
        if not n:
            print(f'  扩展：{side}上已是最新')
    if a.dry_run:
        return 0

    bk = os.path.join(a.backups, time.strftime('%Y-%m-%d'), f"{time.strftime('%H%M%S')}-{side}同步前")
    # 备份即将被覆盖的文件
    over_local = [r for r in pull if r in loc]
    over_remote = [r for r in push if r in rem]
    if over_local:
        for rel in over_local:
            dst = os.path.join(bk, '电脑', rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(os.path.join(a.st, rel), 'rb') as s, open(dst, 'wb') as d:
                d.write(s.read())
    if over_remote:
        extract(pull_tar(ph, over_remote), os.path.join(bk, side))
    if over_local or over_remote:
        print(f'  被覆盖的旧文件备份在 {bk}')

    try:
        for i in range(0, len(push), 400):
            push_tar(ph, tar_bytes(a.st, push[i:i + 400]))
        for i in range(0, len(pull), 400):
            data = pull_tar(ph, pull[i:i + 400])
            if not data:
                raise RuntimeError('从手机取文件失败（连接中断或手机锁屏断开了调试）')
            extract(data, a.st)
    except RuntimeError as e:
        print(f'  ✗ {e}。已同步的部分保留，重新运行会接着同步剩下的。')

    # 核对：同步过的文件两边必须大小一致、时间对得上；对不上的不记进状态，下次重新同步
    loc, rem = local_files(a.st), remote_files(ph)
    new_state = {rel: {'l': loc[rel], 'r': rem[rel]} for rel in loc if rel in rem and same(loc[rel], rem[rel])}
    for rel, s0 in state.items():   # 两边本来就不同、这次也没动的，保留旧记录
        if rel not in new_state and rel in loc and rel in rem and rel not in push and rel not in pull:
            new_state[rel] = s0
    json.dump(new_state, open(a.state, 'w', encoding='utf-8'))
    missing = sorted(r for r in set(push) | set(pull) if r not in new_state)
    print(f'  ✓ 同步完成：→ {side} {len(push)} 个，← 电脑 {len(pull)} 个' + (f'；{len(missing)} 个没同步成功' if missing else ''))
    for rel in missing[:10]:
        print(f'  ! 没同步成功：{rel}')

    if a.settings and isinstance(ph, LocalTT):
        ch = copy_settings(ph, a.st, bk)
        print(f'  ✓ 扩展设置和对话补全设置已复制到{side}（旧的备份在 {bk}）' if ch else f'  扩展设置：{side}上已是最新')
    if a.mac_ip:
        key = open(a.lan_key_file).read().strip() if a.lan_key_file and os.path.exists(a.lan_key_file) and not a.local_tt else None
        ch = fix_endpoint(ph, a.mac_ip, a.port, key)
        print(f'  ✓ {side}的代理地址已对准 http://{a.mac_ip}:{a.port}/v1' + ('' if ch else '（本来就是）'))
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main())
