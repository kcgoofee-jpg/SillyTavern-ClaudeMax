#!/usr/bin/env python3
"""电脑酒馆（SillyTavern）↔ 手机 TauriTavern 双向同步（adb，USB 或无线调试）。

同步：聊天、角色卡、世界书、预设、头像、背景、生图图片、主题、快速回复；扩展只从电脑推到手机（git 版本较新时）。
不同步：设置（两边的代理地址不同）和密钥。另外把手机上的代理地址对准这台 Mac 现在的 IP。

规则（按上次同步时记下的状态判断哪边改过）：
  只有一边改过 → 用改过的那边；两边都改过（冲突）→ 用较新的，另一份存进备份。
  只有一边有的文件 → 复制到另一边。从不删除文件。
  被覆盖的文件先备份到 <酒馆目录>/backups/<时间>-手机同步前/{电脑,手机}/。
手机上的 TauriTavern 数据在 Android/data 里：需要 root（su），或 Android 10 及以下。

用法：phone_sync.py --st <SillyTavern/data/default-user> --adb <adb> [--serial S] [--dry-run]
      [--mac-ip IP --port 8901 --lan-key-file F]
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
    with tempfile.NamedTemporaryFile(delete=False, suffix='.tar') as f:
        f.write(data)
    ph.run('push', f.name, '/data/local/tmp/cm_push.tar')
    os.unlink(f.name)
    b = shlex.quote(ph.base)
    ph.rsh(f'cd {b} && tar -xf /data/local/tmp/cm_push.tar && chown -R $(stat -c %u:%g {b}) {b}; rm -f /data/local/tmp/cm_push.tar')


def extract(data, dest):
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        for m in t.getmembers():
            if not m.isfile() or m.name.startswith('/') or '..' in m.name.split('/'):
                continue
            t.extract(m, dest, set_attrs=False)
            os.utime(os.path.join(dest, m.name), (m.mtime, m.mtime))


EXT_SKIP = {'node_modules', 'data', '.DS_Store'}


def local_rev(d):
    r = subprocess.run(['git', '-C', d, 'rev-parse', 'HEAD'], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def remote_rev(ph, d):
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
        print(f'  扩展 → 手机：{name}（{rev[:7]}）')
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
        with tempfile.NamedTemporaryFile(delete=False, suffix='.tar') as f:
            f.write(buf.getvalue())
        ph.run('push', f.name, '/data/local/tmp/cm_ext.tar')
        os.unlink(f.name)
        e = shlex.quote(remote_ext)
        ph.rsh(f'cd {e} && tar -xf /data/local/tmp/cm_ext.tar && chown -R $(stat -c %u:%g {e}) {e}/{shlex.quote(name)}; rm -f /data/local/tmp/cm_ext.tar')
    return len(todo)


def fix_endpoint(ph, ip, port, key):
    """手机设置里指向 :port 的代理地址 → 这台 Mac 现在的 IP；访问密码对上 Mac 的。"""
    new = f'http://{ip}:{port}'
    pat = re.compile(r'http://[0-9A-Za-z.\-]+:' + str(port))
    changed = []
    for rel in ('settings.json', 'settings/presets.json'):
        path = f'{ph.base}/{rel}'
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
        out = json.dumps(d, ensure_ascii=False, indent=4 if rel == 'settings.json' else None)
        if out == json.dumps(json.loads(raw), ensure_ascii=False, indent=4 if rel == 'settings.json' else None):
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
    ap.add_argument('--adb', required=True)
    ap.add_argument('--serial', required=True)
    ap.add_argument('--state', required=True)
    ap.add_argument('--backups', required=True)
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--mac-ip')
    ap.add_argument('--port', type=int, default=8901)
    ap.add_argument('--lan-key-file')
    ap.add_argument('--ext-dir', help='电脑上的第三方扩展目录（SillyTavern/public/scripts/extensions/third-party）')
    a = ap.parse_args()

    ph = Phone(a.adb, a.serial)
    if not ph.base:
        print('✗ 手机上找不到 TauriTavern 的数据（没装，或没有 root 读不到 Android/data）。')
        print('  没有 root 时：用 TauriTavern 自带的「数据迁移」扩展导出 / 导入。')
        return 2
    print(f'  手机：{a.serial}{"（root）" if ph.root else ""}')
    state = json.load(open(a.state, encoding='utf-8')) if os.path.exists(a.state) else {}
    loc, rem = local_files(a.st), remote_files(ph)
    push, pull, conflicts = plan(loc, rem, state)
    print(f'  电脑 {len(loc)} 个文件，手机 {len(rem)} 个文件')
    print(f'  → 手机：{len(push)} 个    ← 电脑：{len(pull)} 个    两边都改过：{len(conflicts)} 个')
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
            print('  扩展：手机上已是最新')
    if a.dry_run:
        return 0

    stamp = time.strftime('%Y%m%d-%H%M%S')
    bk = os.path.join(a.backups, f'{stamp}-手机同步前')
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
        extract(pull_tar(ph, over_remote), os.path.join(bk, '手机'))
    if over_local or over_remote:
        print(f'  被覆盖的旧文件备份在 {bk}')

    for i in range(0, len(push), 400):
        push_tar(ph, tar_bytes(a.st, push[i:i + 400]))
    for i in range(0, len(pull), 400):
        extract(pull_tar(ph, pull[i:i + 400]), a.st)

    # 记下这次同步后的状态
    loc, rem = local_files(a.st), remote_files(ph)
    new_state = {rel: {'l': loc[rel], 'r': rem[rel]} for rel in loc if rel in rem}
    json.dump(new_state, open(a.state, 'w', encoding='utf-8'))
    missing = [r for r in set(push) | set(pull) if r not in new_state]
    print(f'  ✓ 同步完成：→ 手机 {len(push)} 个，← 电脑 {len(pull)} 个' + (f'；{len(missing)} 个没同步成功' if missing else ''))
    for rel in missing[:10]:
        print(f'  ! 没同步成功：{rel}')

    if a.mac_ip:
        key = open(a.lan_key_file).read().strip() if a.lan_key_file and os.path.exists(a.lan_key_file) else None
        ch = fix_endpoint(ph, a.mac_ip, a.port, key)
        print(f'  ✓ 手机的代理地址已对准 http://{a.mac_ip}:{a.port}/v1' + ('' if ch else '（本来就是）'))
    return 1 if missing else 0


if __name__ == '__main__':
    sys.exit(main())
