#!/usr/bin/env python3
"""电脑酒馆（SillyTavern）↔ 手机 TauriTavern 双向同步（adb，USB 或无线调试）；
也能同步这台 Mac 上的 TauriTavern（--local-tt，规则相同，不用 adb）。

同步：聊天、角色卡、世界书、预设、头像、背景、生图图片、主题、快速回复。
扩展：只从电脑推到手机，而且只在手机上的版本是电脑版本的旧版时才推（手机上更新过、或两边分叉时不推，
      说明原因）；推的是 git 管理的文件和 .git，整个换成新文件夹，旧文件夹留一份在 extensions/.cm-previous。
标签：角色卡上的标签（settings.json 的 tags / tag_map）按标签名合并，只加不删（一边删掉的标签会被另一边加回来）；
      --push-only 时只把电脑的标签加到对方。
不同步：其他设置（两边的代理地址不同）和密钥。另外把手机上的代理地址对准这台 Mac 现在的 IP。

规则（按上次同步时记下的状态判断哪边改过）：
  只有一边改过 → 用改过的那边；两边都改过（冲突），或者没有同步记录、两边又不一样 → 用较新的，
  另一份存进备份，并且列出来。只有一边有的文件 → 复制到另一边。从不删除文件。
  聊天记录冲突时再按楼层比一次：输的那份里有赢的那份没有的楼层（两边各自往下聊过）→ 另存成
  「原名 [冲突副本·哪边 时间].jsonl」，两边的聊天列表里都能看到，不只是进备份。
  只差大小写的两个文件名（Mac 和手机都不分大小写，会互相覆盖）→ 不动，列出来。
  被覆盖的文件先备份到 <酒馆目录>/backups/<日期>/<时间>-手机同步前/{电脑,手机}/；备份没做成的那批不覆盖。
  写入先写到临时文件 / 临时文件夹再换名，中途断开不会留下写了一半的文件。
手机上的 TauriTavern 数据在 Android/data 里：需要 root（su），或 Android 10 及以下。

用法：phone_sync.py --st <SillyTavern/data/default-user> --adb <adb> --serial S [--dry-run]
      [--mac-ip IP --port 8901 --lan-key-file F]
      phone_sync.py --st <…> --local-tt <TT 的 data/default-user> [--dry-run] [--port 8901]
"""
import argparse, hashlib, io, json, os, re, secrets, shlex, shutil, subprocess, sys, tarfile, tempfile, time, uuid

PKG = 'com.tauritavern.client'
REMOTE_ROOTS = [f'/data/media/0/Android/data/{PKG}/data/default-user', f'/sdcard/Android/data/{PKG}/data/default-user']
DIRS = ['chats', 'group chats', 'groups', 'characters', 'worlds', 'OpenAI Settings', 'User Avatars',
        'backgrounds', 'user/images', 'user/files', 'themes', 'QuickReplies']
SAME_WINDOW = 2   # 秒：两边修改时间相差不超过这个、大小相同，视为同一份
CHUNK = 400       # 每批文件数（备份、推、拉都按批，一批失败不影响已完成的）
PACKER = 'cm-pack-2'   # 扩展打包方式的版本：变了就会把已经「同步过」的扩展重新推一次
EXT_CARRY = ('node_modules', 'data')   # 扩展顶层里电脑不推、手机上原有就保留的文件夹
SHRINK_LIMIT = 0.2    # 手机上少了超过这个比例的已同步文件：怀疑列表不完整，拒绝同步
WARNINGS = []
LOCAL = '电脑'   # 这一侧在输出里的叫法（--local-name；Mac TT 当中心时叫「Mac TT」）


class SyncError(RuntimeError):
    pass


def warn_once(msg):
    if msg not in WARNINGS:
        WARNINGS.append(msg)
        print(f'  ! {msg}')


def skip(rel):
    base = os.path.basename(rel)
    return base.startswith('._') or base == '.DS_Store'


def _run(argv, data=None, timeout=900):
    try:
        return subprocess.run(argv, input=data, capture_output=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(argv, 124, b'', b'timeout')
    except OSError as e:
        return subprocess.CompletedProcess(argv, 127, b'', str(e).encode())


class Phone:
    label = '手机'

    def __init__(self, adb, serial):
        self.adb, self.serial = adb, serial
        self.root, self.base, self.problem = False, None, None
        r = self.run('get-state', timeout=20)
        state = r.stdout.decode('utf-8', 'replace').strip()
        if r.returncode != 0 or state != 'device':
            err = r.stderr.decode('utf-8', 'replace').strip().splitlines()
            self.problem = state or (err[-1] if err else '') or '连不上'
            return
        self.root = self.sh('id', su=True).startswith('uid=0')
        for b in REMOTE_ROOTS:
            if self.sh(f'test -d {shlex.quote(b)} && echo yes', su=self.root).strip() == 'yes':
                self.base = b
                break
        self.tag = f'cm{os.getpid()}{secrets.token_hex(3)}'
        self.n = 0

    def tmp(self, what):
        """这次运行独有的临时文件名（不会用到别的运行留下的旧文件）。"""
        self.n += 1
        return f'/data/local/tmp/{self.tag}_{self.n}_{what}'

    def run(self, *args, data=None, timeout=900):
        return _run([self.adb, '-s', self.serial, *args], data=data, timeout=timeout)

    def sh_bytes(self, cmd, su=False):
        if su:
            cmd = f'su -c {shlex.quote(cmd)}'
        return self.run('shell', cmd).stdout

    def sh(self, cmd, su=False):
        return self.sh_bytes(cmd, su).decode('utf-8', 'replace')

    def rsh(self, cmd):
        return self.sh(cmd, su=self.root)

    def rsh_bytes(self, cmd):
        return self.sh_bytes(cmd, su=self.root)

    def push_file(self, local, remote):
        r = self.run('push', local, remote)
        if r.returncode != 0:
            raise SyncError('传到手机失败（连接中断？）：' + r.stderr.decode('utf-8', 'replace').strip()[-200:])

    def chown_cmd(self, owner_of, *paths):
        """root 时把 paths 改成和 owner_of 同一个主人；失败不算错（非 root 的 /sdcard 路径本来就不用改）。"""
        if not self.root:
            return ':'
        q = ' '.join(shlex.quote(p) for p in paths)
        return f'chown -R $(stat -c %u:%g {shlex.quote(owner_of)}) {q} 2>/dev/null'


class LocalTT:
    """这台 Mac 上的 TauriTavern：直接读写文件。"""
    label = 'Mac TT'
    problem = None

    def __init__(self, base):
        self.base = base if os.path.isdir(base) else None
        self.root = False


# ── 列文件 ──────────────────────────────────────

def _rel_ok(rel_bytes):
    try:
        return rel_bytes.decode('utf-8')
    except UnicodeDecodeError:
        warn_once(f'文件名不是 UTF-8，跳过：{rel_bytes.decode("utf-8", "replace")}')
        return None


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
                try:
                    rel.encode('utf-8')
                except UnicodeEncodeError:
                    warn_once(f'文件名不是 UTF-8，跳过：{rel.encode("utf-8", "surrogateescape").decode("utf-8", "replace")}')
                    continue
                if '\n' in rel:
                    warn_once(f'文件名里有换行，跳过：{rel!r}')
                    continue
                try:
                    s = os.stat(p)
                except OSError:
                    continue
                out[rel] = (int(s.st_mtime), s.st_size)
    return out


def parse_listing(raw):
    """手机上 find/stat 的输出（最后一行必须是 CM_END 0）→ {rel: (mtime, size)}；不完整就报错。"""
    lines = raw.split(b'\n')
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines or not lines[-1].strip().startswith(b'CM_END'):
        raise SyncError('手机上的文件列表不完整（连接中断、或读不到 TT 的数据）')
    rc = lines[-1].split()[1:]
    if rc != [b'0']:
        raise SyncError(f'手机上列文件出错（返回 {b" ".join(rc).decode() or "?"}）')
    out = {}
    for line in lines[:-1]:
        m = re.match(rb'^(\d+) (\d+) (.+)$', line.rstrip(b'\r'))
        if not m:
            continue
        rel = _rel_ok(m.group(3))
        if rel is None or skip(rel):
            continue
        out[rel] = (int(m.group(1)), int(m.group(2)))
    return out


def remote_files(ph):
    if isinstance(ph, LocalTT):
        return local_files(ph.base)
    dirs = ' '.join(shlex.quote(d) for d in DIRS)
    raw = ph.rsh_bytes(f'cd {shlex.quote(ph.base)} || exit 3; rc=0; for d in {dirs}; do '
                       f'if [ -d "$d" ]; then find "$d" -type f -exec stat -c "%Y %s %n" {{}} + || rc=1; fi; done; echo CM_END $rc')
    return parse_listing(raw)


def listing_shrunk(state, rem):
    """已同步过的文件在手机上少了多少：太多就说明列表多半不完整（不是真的删了）。"""
    if len(state) < 20:
        return 0
    gone = sum(1 for r in state if r not in rem)
    return gone if gone > len(state) * SHRINK_LIMIT else 0


# ── 计划 ──────────────────────────────────────

def same(a, b):
    return bool(a and b and a[1] == b[1] and abs(a[0] - b[0]) <= SAME_WINDOW)


def case_clashes(keys):
    """只差大小写的路径：Mac（APFS）和手机（ext4 casefold）上是同一个文件，同步会互相覆盖。"""
    groups = {}
    for k in keys:
        groups.setdefault(k.casefold(), []).append(k)
    return {k for g in groups.values() if len(g) > 1 for k in g}


def plan(loc, rem, state):
    """→ push, pull, conflicts, clashes。conflicts 里的文件也在 push 或 pull 里（较新的一边赢）。"""
    push, pull, conflicts = [], [], []
    clashes = case_clashes(set(loc) | set(rem))
    for rel in sorted(set(loc) | set(rem)):
        if rel in clashes:
            continue
        L, R, S = loc.get(rel), rem.get(rel), state.get(rel)
        if L and not R:
            push.append(rel)
        elif R and not L:
            pull.append(rel)
        elif same(L, R):
            continue
        else:
            l_changed = not S or tuple(S['l']) != tuple(L)
            r_changed = not S or tuple(S['r']) != tuple(R)
            if S and l_changed and not r_changed:
                push.append(rel)
            elif S and r_changed and not l_changed:
                pull.append(rel)
            else:   # 两边都改过，或者没有记录（第一次同步 / 记录丢了）：较新的赢，列出来
                conflicts.append(rel)
                (push if L[0] >= R[0] else pull).append(rel)
    return push, pull, conflicts, sorted(clashes)


IDENTICAL_MAX = 2 * 1024 * 1024


def settle_identical(ph, st, loc, rem, rels):
    """大小一样、只有修改时间不同的文件，比一下内容：一模一样的不算改动（TT 每次启动都会重写
    快速回复等文件，内容没变）。→ 内容相同的文件集合。只比 2MB 以内的，读不了就当不同。"""
    cand = [r for r in rels if r in loc and r in rem and loc[r][1] == rem[r][1] and loc[r][1] <= IDENTICAL_MAX]
    if not cand:
        return set()
    try:
        data, _ = pull_tar(ph, cand, only_existing=True)
    except SyncError:
        return set()
    same_ = set()
    with tarfile.open(fileobj=io.BytesIO(data)) as t:
        for m in t.getmembers():
            if not m.isfile() or m.name not in cand:
                continue
            try:
                with open(os.path.join(st, m.name), 'rb') as f:
                    if f.read() == t.extractfile(m).read():
                        same_.add(m.name)
            except OSError:
                pass
    return same_


# ── 打包 / 解包 ──────────────────────────────────────

def tar_bytes(st, rels):
    """→ (tar 数据, 实际打进去的文件)。打包时已经不在的文件跳过。"""
    buf, got = io.BytesIO(), []
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.GNU_FORMAT) as t:
        for rel in rels:
            p = os.path.join(st, rel)
            try:
                with open(p, 'rb') as f:
                    info = t.gettarinfo(arcname=rel, fileobj=f)
                    info.uid = info.gid = 0
                    info.uname = info.gname = ''
                    t.addfile(info, f)
                got.append(rel)
            except OSError:
                continue
    return buf.getvalue(), got


def tar_names(data):
    try:
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            return {m.name for m in t.getmembers() if m.isfile() and not skip(m.name)}
    except (tarfile.TarError, EOFError) as e:
        raise SyncError(f'收到的压缩包是坏的（{e}）')


def _safe_name(name):
    return name and not name.startswith('/') and '..' not in name.split('/')


def atomic_write(path, data, mode=0o644, mtime=None):
    """先写临时文件再换名：中途中断不会留下写了一半的文件。"""
    d = os.path.dirname(path) or '.'
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.cm-')
    try:
        with os.fdopen(fd, 'wb') as f:
            if isinstance(data, (bytes, bytearray)):
                f.write(data)
            else:
                shutil.copyfileobj(data, f)
        os.chmod(tmp, mode)
        if mtime is not None:
            os.utime(tmp, (mtime, mtime))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def extract(data, dest):
    """tar → dest，逐个文件原子替换。返回解出的文件名集合。"""
    done = set()
    try:
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            for m in t.getmembers():
                if not m.isfile() or not _safe_name(m.name) or skip(m.name):   # macOS tar 会夹带 ._ 附属文件
                    continue
                atomic_write(os.path.join(dest, m.name), t.extractfile(m), (m.mode & 0o777) or 0o644, m.mtime)
                done.add(m.name)
    except (tarfile.TarError, EOFError) as e:
        raise SyncError(f'收到的压缩包是坏的（{e}）')
    return done


def pull_tar(ph, rels, only_existing=False):
    """对方的文件 → tar 数据。only_existing：对方没有的跳过（做备份用）。
    返回 (数据, 对方打包时实际有的文件数)。"""
    if isinstance(ph, LocalTT):
        want = [r for r in rels if os.path.isfile(os.path.join(ph.base, r))] if only_existing else rels
        data, got = tar_bytes(ph.base, want)
        return data, len(want)
    lst, tlst, tar = ph.tmp('list.txt'), ph.tmp('list2.txt'), ph.tmp('pull.tar')
    fd, loc = tempfile.mkstemp(suffix='.txt')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(('\n'.join(rels) + '\n').encode('utf-8'))
        ph.push_file(loc, lst)
        filt = (f'while IFS= read -r f; do if [ -f "$f" ]; then printf "%s\\n" "$f"; fi; done < {lst} > {tlst}' if only_existing
                else f'cp {lst} {tlst}')
        out = ph.rsh(f'cd {shlex.quote(ph.base)} || exit 3; {filt} || exit 4; n=$(grep -c "" {tlst}); '
                     f'if [ "$n" = 0 ]; then echo "CM_N 0"; echo CM_OK; exit 0; fi; '
                     f'tar -cf {tar} -T {tlst} && chmod 644 {tar} && echo "CM_N $n" && echo CM_OK')
        m = re.search(r'CM_N (\d+)', out)
        if 'CM_OK' not in out or not m:
            raise SyncError('手机上打包失败（存储空间满了、或连接中断）')
        n = int(m.group(1))
        if n == 0:
            return b'', 0
        with tempfile.TemporaryDirectory() as tmp:
            dst = os.path.join(tmp, 'p.tar')
            r = ph.run('pull', tar, dst)
            if r.returncode != 0 or not os.path.exists(dst):
                raise SyncError('从手机取文件失败（连接中断或手机锁屏断开了调试）')
            with open(dst, 'rb') as f:
                return f.read(), n
    finally:
        os.unlink(loc)
        ph.rsh(f'rm -f {lst} {tlst} {tar}')


def push_tar(ph, data):
    """tar 数据 → 对方。手机上先解到临时文件夹，再逐个换名到位。"""
    if isinstance(ph, LocalTT):
        extract(data, ph.base)
        return
    tar = ph.tmp('push.tar')
    b = shlex.quote(ph.base)
    tdir = f'{ph.base}/.cm-incoming-{ph.tag}-{ph.n}'
    t = shlex.quote(tdir)
    fd, loc = tempfile.mkstemp(suffix='.tar')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        ph.push_file(loc, tar)
        out = ph.rsh(
            f'rm -rf {t}; mkdir -p {t} && cd {t} && tar -xf {tar} || {{ cd /; rm -rf {t}; echo CM_TAR_FAIL; exit 1; }}; '
            f'find . -type f > {t}.list; fail=0; '
            f'while IFS= read -r f; do f=${{f#./}}; mkdir -p "$(dirname {b}/"$f")" && mv -f "$f" {b}/"$f" || fail=1; done < {t}.list; '
            f'cd /; rm -rf {t} {t}.list; {ph.chown_cmd(ph.base, ph.base)}; [ $fail = 0 ] && echo CM_OK')
        if 'CM_OK' not in out:
            raise SyncError('手机上解包失败（存储空间满了、或连接中断）')
    finally:
        os.unlink(loc)
        ph.rsh(f'rm -rf {tar} {t} {t}.list')


# ── 扩展 ──────────────────────────────────────

SHA = re.compile(r'^[0-9a-f]{40}$')


def git(d, *args):
    return subprocess.run(['git', '-C', d, *args], capture_output=True, text=True)


def local_rev(d):
    r = git(d, 'rev-parse', 'HEAD')
    return r.stdout.strip() if r.returncode == 0 else None


def parse_git_state(txt):
    """remote_ext_state 的输出 → {'exists', 'marker', 'rev'}；读不完整返回 None。
    rev 按 git 的规则：HEAD 是 sha 就用它；是 ref 就先看松散 ref，再看 packed-refs。"""
    if 'CM_END' not in txt:
        return None
    kv = {}
    for line in txt.splitlines():
        if ':' in line:
            k, v = line.split(':', 1)
            kv.setdefault(k.strip(), v.strip())
    head, rev = kv.get('H', ''), None
    if SHA.match(head):
        rev = head
    elif head.startswith('ref: '):
        loose = kv.get('L', '')
        packed = kv.get('P', '').split(' ')[0]
        rev = loose if SHA.match(loose) else packed if SHA.match(packed) else None
    return {'exists': kv.get('E') == '1', 'marker': kv.get('M') or None, 'rev': rev}


def _git_state_script(d):
    q = shlex.quote(d)
    return (f'd={q}; if [ -e "$d" ] || [ -L "$d" ]; then echo E:1; else echo E:0; fi; '
            f'echo "M:$(head -1 "$d/.git/cm-pushed" 2>/dev/null || head -1 "$d/.cm-pushed" 2>/dev/null)"; '
            f'echo "H:$(head -1 "$d/.git/HEAD" 2>/dev/null)"; '
            f'h=$(sed -n "s/^ref: //p" "$d/.git/HEAD" 2>/dev/null); '
            f'if [ -n "$h" ]; then echo "L:$(head -1 "$d/.git/$h" 2>/dev/null)"; '
            f'echo "P:$(grep " $h\\$" "$d/.git/packed-refs" 2>/dev/null | head -1)"; fi; echo CM_END')


def remote_ext_state(ph, d):
    if isinstance(ph, LocalTT):
        return parse_git_state(subprocess.run(['sh', '-c', _git_state_script(d)], capture_output=True, text=True).stdout)
    return parse_git_state(ph.rsh(_git_state_script(d)))


def ext_decision(rev, st, known, is_ancestor, force=False):
    """电脑版本 rev、对方状态 st → 'same' / 'push' / 'newer'（对方更新）/ 'unknown'（对方的版本电脑不认识）/ 'diverged'。"""
    if st['marker'] == f'{rev} {PACKER}' and st['rev'] in (rev, None):
        return 'same'
    if not st['exists'] or force:
        return 'push'
    p = st['rev']
    if p and p != rev:
        if not known(p):
            return 'unknown'
        if is_ancestor(rev, p):
            return 'newer'
        if not is_ancestor(p, rev):
            return 'diverged'
    return 'push'   # 对方是旧版本、同一版本但不是用现在的打包方式推的、或没有 git


def ext_files(src):
    """要推的文件：git 管理的 + 没被忽略的新文件 + 整个 .git（不看文件夹名，子目录里的 data/ 也带上）。"""
    r = subprocess.run(['git', '-C', src, 'ls-files', '-co', '--exclude-standard', '-z'], capture_output=True)
    if r.returncode != 0:
        return None
    names = []
    for raw in r.stdout.split(b'\0'):
        if not raw:
            continue
        try:
            rel = raw.decode('utf-8')
        except UnicodeDecodeError:
            warn_once(f'扩展里有文件名不是 UTF-8，跳过：{raw.decode("utf-8", "replace")}')
            continue
        if not skip(rel):
            names.append(rel)
    return names


def pack_extension(src, name, rev, out_path):
    names = ext_files(src)
    if names is None:
        raise SyncError(f'{name}：读不出 git 文件列表')
    gitdir = os.path.join(src, '.git')
    marker = f'{name}/.git/cm-pushed' if os.path.isdir(gitdir) else f'{name}/.cm-pushed'
    with tarfile.open(out_path, mode='w', format=tarfile.GNU_FORMAT) as t:
        def filt(ti):
            if os.path.basename(ti.name).startswith('._') or ti.name.endswith('/.DS_Store') or ti.name == marker:
                return None
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = ''
            return ti
        for rel in names:
            p = os.path.join(src, rel)
            if os.path.lexists(p):
                t.add(p, arcname=f'{name}/{rel}', filter=filt, recursive=os.path.isdir(p) and not os.path.islink(p))
        if os.path.isdir(gitdir):
            t.add(gitdir, arcname=f'{name}/.git', filter=filt)
        body = f'{rev} {PACKER}\n'.encode()
        info = tarfile.TarInfo(marker)
        info.size, info.mtime, info.mode = len(body), int(time.time()), 0o644
        t.addfile(info, io.BytesIO(body))


def remote_ext_dir(ph):
    return ph.base.rsplit('/default-user', 1)[0] + '/extensions/third-party'


def plan_extensions(ph, ext_dir, force=False):
    """→ [(name, src, rev)] 要推的扩展；同时打印每个扩展的决定。"""
    side = ph.label
    rext = remote_ext_dir(ph)
    todo = []
    for name in sorted(os.listdir(ext_dir)):
        src = os.path.realpath(os.path.join(ext_dir, name))
        if name.startswith('.') or not os.path.isdir(src):
            continue
        rev = local_rev(src)
        if not rev:
            continue
        st = remote_ext_state(ph, f'{rext}/{name}')
        if st is None:
            print(f'  ! 扩展 {name}：读不到{side}上的版本，这次不推')
            continue
        d = ext_decision(rev, st,
                         known=lambda p, s=src: git(s, 'cat-file', '-e', p + '^{commit}').returncode == 0,
                         is_ancestor=lambda a, b, s=src: git(s, 'merge-base', '--is-ancestor', a, b).returncode == 0,
                         force=force)
        if d == 'push':
            todo.append((name, src, rev))
            why = '' if st['rev'] != rev else '（同一版本，按新的打包方式补推一次）'
            print(f'  扩展 → {side}：{name}（{(st["rev"] or "无")[:7]} → {rev[:7]}）{why}')
        elif d == 'newer':
            print(f'  扩展 {name}：{side}上的版本（{st["rev"][:7]}）比电脑新，不推')
        elif d == 'unknown':
            print(f'  ! 扩展 {name}：{side}上的版本（{st["rev"][:7]}）电脑上没有（多半在{side}上更新过），不推；确定要覆盖加 --ext-force')
        elif d == 'diverged':
            print(f'  ! 扩展 {name}：两边版本分叉（{side} {st["rev"][:7]}，电脑 {rev[:7]}），不推；确定要覆盖加 --ext-force')
    return todo


def push_extensions(ph, todo):
    """推扩展：解到新文件夹，旧文件夹移到 extensions/.cm-previous/<名字>，再把新的换上。返回失败的名字。"""
    rext = remote_ext_dir(ph)
    prev = os.path.join(os.path.dirname(rext), '.cm-previous')
    failed = []
    for name, src, rev in todo:
        fd, tarpath = tempfile.mkstemp(suffix='.tar')
        os.close(fd)
        try:
            pack_extension(src, name, rev, tarpath)
            if isinstance(ph, LocalTT):
                _swap_local_ext(tarpath, rext, prev, name)
            else:
                _swap_phone_ext(ph, tarpath, rext, prev, name)
        except (SyncError, OSError, tarfile.TarError) as e:
            print(f'  ✗ 扩展 {name} 没推成：{e}')
            failed.append(name)
        finally:
            os.unlink(tarpath)
    return failed


def _swap_local_ext(tarpath, rext, prev, name):
    os.makedirs(rext, exist_ok=True)
    new = tempfile.mkdtemp(dir=os.path.dirname(rext), prefix='.cm-new-')
    try:
        with open(tarpath, 'rb') as f:
            extract(f.read(), new)
        dst, old = os.path.join(rext, name), os.path.join(prev, name)
        for x in EXT_CARRY:   # 对方原有、电脑不推的顶层文件夹：带过去
            if os.path.isdir(os.path.join(dst, x)) and not os.path.lexists(os.path.join(new, name, x)):
                shutil.copytree(os.path.join(dst, x), os.path.join(new, name, x), symlinks=True)
        if os.path.islink(dst):
            os.unlink(dst)    # 旧的符号链接：换成实体副本
        elif os.path.lexists(dst):
            os.makedirs(prev, exist_ok=True)
            shutil.rmtree(old, ignore_errors=True)
            os.rename(dst, old)
        try:
            os.rename(os.path.join(new, name), dst)
        except OSError:
            if os.path.lexists(old) and not os.path.lexists(dst):
                os.rename(old, dst)
            raise
    finally:
        shutil.rmtree(new, ignore_errors=True)


def _swap_phone_ext(ph, tarpath, rext, prev, name):
    tar = ph.tmp('ext.tar')
    e, p, n = shlex.quote(rext), shlex.quote(prev), shlex.quote(name)
    new = shlex.quote(f'{os.path.dirname(rext)}/.cm-new-{ph.tag}-{ph.n}')
    carry = '; '.join(f'if [ -d {e}/{n}/{x} ] && [ ! -e {new}/{n}/{x} ]; then cp -a {e}/{n}/{x} {new}/{n}/{x} || ok=0; fi'
                      for x in EXT_CARRY)
    try:
        ph.push_file(tarpath, tar)
        out = ph.rsh(
            f'ok=1; mkdir -p {e} {p} && rm -rf {new} && mkdir -p {new} && cd {new} && tar -xf {tar} || ok=0; '
            f'if [ $ok = 1 ]; then {carry}; fi; '
            f'if [ $ok = 1 ]; then rm -rf {p}/{n}; if [ -e {e}/{n} ] || [ -L {e}/{n} ]; then mv {e}/{n} {p}/{n} || ok=0; fi; fi; '
            f'if [ $ok = 1 ]; then mv {new}/{n} {e}/{n} || {{ ok=0; [ -e {e}/{n} ] || mv {p}/{n} {e}/{n}; }}; fi; '
            f'cd /; rm -rf {new}; {ph.chown_cmd(ph.base, rext, prev)}; [ $ok = 1 ] && echo CM_OK')
        if 'CM_OK' not in out:
            raise SyncError(f'{ph.label}上解包 / 换文件夹失败（存储空间满了、或连接中断），原来的扩展没动')
    finally:
        ph.rsh(f'rm -rf {tar} {new}')


# ── 设置 ──────────────────────────────────────

# 复制到本机 TT 的扩展设置（TT 自己的连接管理、界面、禁用列表等不动）
EXT_SETTING_KEYS = ['LittleWhiteBox', 'baibai_api_channels', 'baibai_exclude_settings', 'baibai_image',
                    'baibai_image_char_global', 'mvu_settings', 'tavern_helper', 'EjsTemplate', 'claude_max',
                    'regex', 'regex_presets', 'preset_allowed_regex', 'character_allowed_regex']


def copy_settings(ph, st, bk):
    """电脑酒馆 → 本机 TT：
      settings.json 里 extension_settings 中 EXT_SETTING_KEYS 列出的几项（整项替换；其余扩展设置不动）；
      settings/presets.json 里整份 oai_settings（对话补全设置：当前预设、模型、开关，也包括代理地址——
      随后 fix_endpoint 会把代理地址对准本机）。
    只改真的有变化的文件，改之前把那份原文件备份到 bk/<相对路径>。TT 上没有的文件跳过。"""
    src = json.load(open(os.path.join(st, 'settings.json'), encoding='utf-8'))
    changed = []
    for rel, apply in (('settings.json', lambda d: d.setdefault('extension_settings', {}).update(
                           {k: src['extension_settings'][k] for k in EXT_SETTING_KEYS if k in src.get('extension_settings', {})})),
                       ('settings/presets.json', lambda d: d.update({'oai_settings': src['oai_settings']}) if 'oai_settings' in src else None)):
        path = os.path.join(ph.base, rel)
        if not os.path.exists(path):
            continue
        raw = open(path, encoding='utf-8').read()
        try:
            d = json.loads(raw)
        except ValueError as e:
            print(f'  ✗ {ph.label}的 {rel} 不是合法 JSON，没改（{e}）')
            continue
        before = json.loads(raw)
        apply(d)
        if d == before:
            continue
        atomic_write(os.path.join(bk, rel), raw.encode('utf-8'))
        atomic_write(path, json.dumps(d, ensure_ascii=False, indent=4 if rel == 'settings.json' else None).encode('utf-8'))
        changed.append(rel)
    return changed


def read_remote_text(ph, path):
    """→ (原始字节, None) / (None, 'missing') / (None, 错误说明)。手机上用结束标记确认读全了。"""
    if isinstance(ph, LocalTT):
        if not os.path.exists(path):
            return None, 'missing'
        with open(path, 'rb') as f:
            return f.read(), None
    q = shlex.quote(path)
    out = ph.rsh_bytes(f'if [ -f {q} ]; then cat {q} && printf "\\nCM_END\\n"; else echo CM_MISSING; fi')
    if out.strip() == b'CM_MISSING':
        return None, 'missing'
    if not out.endswith(b'\nCM_END\n'):
        return None, '没读全（连接中断？）'
    return out[:-len(b'\nCM_END\n')], None


def write_remote_text(ph, path, body):
    if isinstance(ph, LocalTT):
        atomic_write(path, body)
        return
    tmp = ph.tmp('cfg.json')
    q, nq = shlex.quote(path), shlex.quote(path + '.cm-new')
    fd, loc = tempfile.mkstemp(suffix='.json')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(body)
        ph.push_file(loc, tmp)
        own = f'chown $(stat -c %u:%g {q}) {nq} 2>/dev/null; ' if ph.root else ''
        out = ph.rsh(f'cp {tmp} {nq} && {{ {own}mv -f {nq} {q}; }} && echo CM_OK; rm -f {tmp} {nq}')
        if 'CM_OK' not in out:
            raise SyncError('写入失败')
    finally:
        os.unlink(loc)
        ph.rsh(f'rm -f {tmp}')


def fix_endpoint(ph, ip, port, key, bk):
    """手机设置里指向 :port 的代理地址 → 这台 Mac 现在的 IP；访问密码对上 Mac 的。
    改之前把原文件备份到 bk/<设备>/<相对路径>。返回 (改了的, 出错的说明)。"""
    new = f'http://{ip}:{port}'
    pat = re.compile(r'http://[0-9A-Za-z.\-]+:' + str(port) + r'(?![0-9])')
    changed, errors = [], []
    for rel in ('settings.json', 'settings/presets.json'):
        path = f'{ph.base}/{rel}'
        raw, err = read_remote_text(ph, path)
        if err == 'missing':
            continue
        if err:
            errors.append(f'{rel}：{err}')
            continue
        try:
            text = raw.decode('utf-8')
            d = json.loads(text)
        except ValueError as e:
            errors.append(f'{rel} 不是合法 JSON（{e}），没改')
            continue
        d2 = json.loads(pat.sub(new, json.dumps(d, ensure_ascii=False)))
        cm = (d2.get('extension_settings') or {}).get('claude_max')
        if key and isinstance(cm, dict) and cm.get('accessKey') != key:
            cm['accessKey'] = key
        if d2 == d:   # 比较内容，不比较排版
            continue
        try:
            atomic_write(os.path.join(bk, ph.label, rel), raw)
            write_remote_text(ph, path, json.dumps(d2, ensure_ascii=False, indent=4 if rel == 'settings.json' else None).encode('utf-8'))
            changed.append(rel)
        except (SyncError, OSError) as e:
            errors.append(f'{rel}：{e}')
    return changed, errors


def sync_api(ph, st, port, bk, dry=False):
    """对话补全设置（API 来源、模型、当前预设、各项开关 = oai_settings）两边对齐，改得晚的一边为准。
    代理地址（:port 的那种）各边保留自己的；密钥在 secrets.json，不同步。
    → (方向说明 / None, 出错说明列表)。"""
    pat = re.compile(r'http://[0-9A-Za-z.\-]+:' + str(port) + r'(?![0-9])')
    lrel = 'settings/presets.json' if os.path.exists(os.path.join(st, 'settings/presets.json')) else 'settings.json'
    lpath, rpath = os.path.join(st, lrel), f'{ph.base}/settings/presets.json'
    if not os.path.exists(lpath):
        return None, []
    try:
        lraw = open(lpath, 'rb').read()
        ld = json.loads(lraw)
    except (OSError, ValueError) as e:
        return None, [f'{LOCAL}的 {lrel} 读不了（{e}）']
    rraw, err = read_remote_text(ph, rpath)
    if err:
        return None, [] if err == 'missing' else [f'{ph.label}的 settings/presets.json：{err}']
    try:
        rd = json.loads(rraw)
    except ValueError as e:
        return None, [f'{ph.label}的 settings/presets.json 不是合法 JSON（{e}）']
    lo, ro = ld.get('oai_settings'), rd.get('oai_settings')
    if not isinstance(lo, dict) or not isinstance(ro, dict):
        return None, []
    norm = lambda o: pat.sub('http://proxy:' + str(port), json.dumps(o, ensure_ascii=False, sort_keys=True))
    if norm(lo) == norm(ro):
        return None, []
    if isinstance(ph, LocalTT):
        rtime = os.path.getmtime(rpath)
    else:
        out = ph.rsh(f'stat -c %Y {shlex.quote(rpath)}').strip()
        rtime = float(out) if out.isdigit() else 0
    to_phone = os.path.getmtime(lpath) >= rtime
    src, dst = (lo, ro) if to_phone else (ro, lo)
    keep = next(iter(pat.findall(json.dumps(dst, ensure_ascii=False))), None)
    text = json.dumps(src, ensure_ascii=False)
    new = json.loads(pat.sub(keep, text) if keep else text)
    if dry:
        return 'todo', []
    try:
        if to_phone:
            atomic_write(os.path.join(bk, ph.label, 'settings/presets.json'), rraw)
            rd['oai_settings'] = new
            write_remote_text(ph, rpath, json.dumps(rd, ensure_ascii=False).encode('utf-8'))
        else:
            atomic_write(os.path.join(bk, LOCAL, lrel), lraw)
            ld['oai_settings'] = new
            atomic_write(lpath, json.dumps(ld, ensure_ascii=False, indent=4 if lrel == 'settings.json' else None).encode('utf-8'))
    except (SyncError, OSError) as e:
        return None, [str(e)]
    preset = new.get('preset_settings_openai') or '（未知）'
    return (f'→ {ph.label}' if to_phone else f'← {LOCAL}') + f'（当前预设「{preset}」）', []


# ── 标签 ──────────────────────────────────────
# 标签存在 settings.json：tags = [{id, name, …}]，tag_map = {角色卡文件名: [标签 id]}。
# 两边的 id 各是各的（都是随机生成），按标签名对应。

def card_tags(d):
    """settings → {角色卡文件名: {标签名}}（只看 .png 角色卡；群组的键不是文件名，不管）。"""
    names = {t.get('id'): t.get('name') for t in d.get('tags') or [] if isinstance(t, dict)}
    out = {}
    for key, ids in (d.get('tag_map') or {}).items():
        if isinstance(key, str) and key.endswith('.png') and isinstance(ids, list):
            got = {names[i] for i in ids if names.get(i)}
            if got:
                out[key] = got
    return out


def new_tag(name, taken):
    tid = str(uuid.uuid4())   # 和酒馆自己建标签时一样
    while tid in taken:
        tid = str(uuid.uuid4())
    return {'id': tid, 'name': name, 'folder_type': 'NONE', 'filter_state': 'UNDEFINED', 'sort_order': None,
            'is_hidden_on_character_card': False, 'color': '', 'color2': '', 'create_date': int(time.time() * 1000)}


def add_tags(d, want):
    """把 want = {角色卡文件名: {标签名}} 加进 settings d（原地改）。没有的标签按名字新建。
    → 加上的 (文件名, 标签名) 列表；已经有的不算。"""
    tags = d.setdefault('tags', [])
    by_name = {t.get('name'): t for t in tags if isinstance(t, dict) and t.get('name')}
    taken = {t.get('id') for t in tags if isinstance(t, dict)}
    tmap = d.setdefault('tag_map', {})
    added = []
    for av in sorted(want):
        have = set(tmap.get(av) or [])
        for name in sorted(want[av]):
            t = by_name.get(name)
            if not t:
                t = by_name[name] = new_tag(name, taken)
                taken.add(t['id'])
                tags.append(t)
            if t['id'] not in have:
                tmap.setdefault(av, [])
                if not isinstance(tmap[av], list):
                    tmap[av] = []
                tmap[av].append(t['id'])
                have.add(t['id'])
                added.append((av, name))
    return added


def plan_tags(loc_d, rem_d, loc_cards, rem_cards, push_only=False):
    """→ (加到对方的 {卡: {名}}, 加到电脑的 {卡: {名}})：只给那边确实有的角色卡加。"""
    lt, rt = card_tags(loc_d), card_tags(rem_d)
    to_rem = {av: names - rt.get(av, set()) for av, names in lt.items() if av in rem_cards}
    to_loc = {} if push_only else {av: names - lt.get(av, set()) for av, names in rt.items() if av in loc_cards}
    return {k: v for k, v in to_rem.items() if v}, {k: v for k, v in to_loc.items() if v}


def sync_tags(ph, st, bk, loc_files, rem_files, push_only=False, dry=False):
    """标签合并（见文件开头）。→ (说明文字, 出错的说明列表)。"""
    side = ph.label
    lpath, rpath = os.path.join(st, 'settings.json'), f'{ph.base}/settings.json'
    if not os.path.exists(lpath):
        return None, []   # 还没打开过一次的酒馆：没有标签可合并
    try:
        lraw = open(lpath, 'rb').read()
        loc_d = json.loads(lraw.decode('utf-8'))
    except (OSError, ValueError) as e:
        return None, [f'{LOCAL}的 settings.json 读不了（{e}）']
    rraw, err = read_remote_text(ph, rpath)
    if err:
        return None, [] if err == 'missing' else [f'{side}的 settings.json：{err}']
    try:
        rem_d = json.loads(rraw.decode('utf-8'))
    except ValueError as e:
        return None, [f'{side}的 settings.json 不是合法 JSON（{e}）']
    cards = lambda files: {r.split('/', 1)[1] for r in files if r.startswith('characters/') and r.count('/') == 1}
    to_rem, to_loc = plan_tags(loc_d, rem_d, cards(loc_files), cards(rem_files), push_only)
    n_rem, n_loc = sum(map(len, to_rem.values())), sum(map(len, to_loc.values()))
    text = f'标签：→ {side} {n_rem} 个，← {LOCAL} {n_loc} 个（{len(to_rem)} / {len(to_loc)} 张卡）'
    if dry or not (n_rem or n_loc):
        return text, []
    errors = []
    if n_rem:
        try:
            add_tags(rem_d, to_rem)
            atomic_write(os.path.join(bk, side, 'settings.json'), rraw)
            write_remote_text(ph, rpath, json.dumps(rem_d, ensure_ascii=False, indent=4).encode('utf-8'))
        except (SyncError, OSError) as e:
            errors.append(f'{side}的标签没写成：{e}')
    if n_loc:
        try:
            add_tags(loc_d, to_loc)
            atomic_write(os.path.join(bk, LOCAL, 'settings.json'), lraw)
            atomic_write(lpath, json.dumps(loc_d, ensure_ascii=False, indent=4).encode('utf-8'))
        except OSError as e:
            errors.append(f'{LOCAL}的标签没写成：{e}')
    return text, errors


# ── 聊天冲突 ──────────────────────────────────────

CHAT_DIRS = ('chats/', 'group chats/')


def _floors(raw):
    out = []
    for line in raw.split(b'\n')[1:]:   # 第一行是聊天设置
        if not line.strip():
            continue
        try:
            m = json.loads(line)
        except ValueError:
            m = {'raw': hashlib.md5(line).hexdigest()}
        out.append(m if isinstance(m, dict) else {'raw': hashlib.md5(line).hexdigest()})
    return out


def _texts(m):
    who = (str(m.get('name')), bool(m.get('is_user')))
    return {(who, t) for t in [m.get('mes'), *(m.get('swipes') or [])] if isinstance(t, str)}


def missing_floors(win_raw, lose_raw):
    """输的那份里，赢的那份没有的楼数。一楼算「有」：发送时间、名字、是否用户都对得上；
    或者它的每个回复（正文和所有 swipe）都在赢的那份同一个人的回复里出现过——
    重新生成会改发送时间、多一个 swipe，旧回复还在，不算丢。"""
    win = _floors(win_raw)
    keys = {(str(m.get('send_date')), str(m.get('name')), bool(m.get('is_user')), m.get('raw')) for m in win}
    texts = set().union(*(_texts(m) for m in win)) if win else set()
    n = 0
    for m in _floors(lose_raw):
        if (str(m.get('send_date')), str(m.get('name')), bool(m.get('is_user')), m.get('raw')) in keys:
            continue
        t = _texts(m)
        if t and t <= texts:
            continue
        n += 1
    return n


def conflict_copy_name(rel, side, mtime):
    stem, ext = os.path.splitext(rel)
    return f"{stem} [冲突副本·{side} {time.strftime('%m-%d %H%M', time.localtime(mtime))}]{ext}"


def chat_conflict_copies(ph, st, conflicts, push, loc, rem, write=True):
    """聊天冲突里，输的一份有赢的一份没有的楼层 → 另存到这一侧（随后推到对方）。
    → [(原文件, 副本相对路径, 多出的楼数)]。write=False 只算不写（预览）。"""
    chats = [r for r in conflicts if r.startswith(CHAT_DIRS) and r.endswith('.jsonl')]
    if not chats:
        return []
    data, _ = pull_tar(ph, chats)
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        got = extract(data, tmp) if data else set()
        for rel in chats:
            if rel not in got:
                continue
            with open(os.path.join(st, rel), 'rb') as f:
                l = f.read()
            with open(os.path.join(tmp, rel), 'rb') as f:
                r = f.read()
            local_wins = rel in push
            win, lose = (l, r) if local_wins else (r, l)
            extra = missing_floors(win, lose)
            if not extra:
                continue   # 赢的那份包含输的那份的每一楼（只是更新过 / 重新生成过 / 聊得更多）：备份就够了
            side, mt = (ph.label, rem[rel][0]) if local_wins else (LOCAL, loc[rel][0])
            name = conflict_copy_name(rel, side, mt)
            if write:
                atomic_write(os.path.join(st, name), lose, mtime=mt)
            out.append((rel, name, extra))
    return out


# ── 状态 ──────────────────────────────────────

def load_state(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding='utf-8') as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except ValueError:
        warn_once(f'同步记录坏了（{path}），按第一次同步处理：两边不一样的文件都会列出来')
        return {}


def save_state(path, state):
    atomic_write(path, json.dumps(state).encode('utf-8'))


def merge_state(old, loc, rem, touched, failed):
    """核对后的新记录：两边一致的记新值；没核对上的，没动过或者没做成的保留旧记录。"""
    new = {rel: {'l': list(loc[rel]), 'r': list(rem[rel])} for rel in loc if rel in rem and same(loc[rel], rem[rel])}
    for rel, s0 in old.items():
        if rel not in new and rel in loc and rel in rem and (rel not in touched or rel in failed):
            new[rel] = s0
    return new


def chunks(xs, n=CHUNK):
    for i in range(0, len(xs), n):
        yield xs[i:i + n]


# ── 执行 ──────────────────────────────────────

def backup_remote(ph, rels, known, dst):
    """对方上 rels 里存在的文件 → dst（备份）。核对备份里确实有：known（列表里有的）都要在，数量对得上。"""
    data, n = pull_tar(ph, rels, only_existing=True)
    if n == 0:
        return
    names = tar_names(data)
    lost = [r for r in rels if r in known and r not in names]
    if lost or len(names) < n:
        raise SyncError(f'备份不完整（少了 {max(len(lost), n - len(names))} 个，比如 {(lost or ["?"])[0]}），这批没覆盖')
    extract(data, dst)


def run_sync(ph, st, push, pull, loc, rem, bk):
    """执行同步；返回没做成的文件集合。"""
    side = ph.label
    failed = set()
    backed = False
    for rel in pull:   # 电脑上要被覆盖的：先备份
        if rel in loc:
            try:
                p = os.path.join(bk, LOCAL, rel)
                os.makedirs(os.path.dirname(p), exist_ok=True)
                shutil.copy2(os.path.join(st, rel), p)
                backed = True
            except OSError as e:
                print(f'  ✗ 备份失败，没拉：{rel}（{e}）')
                failed.add(rel)
    for part in chunks(push):
        try:
            backup_remote(ph, part, rem, os.path.join(bk, side))
            backed = backed or any(r in rem for r in part)
            data, got = tar_bytes(st, part)
            failed.update(set(part) - set(got))
            if got:
                push_tar(ph, data)
        except SyncError as e:
            print(f'  ✗ → {side}：{e}')
            failed.update(part)
    for part in chunks([r for r in pull if r not in failed]):
        try:
            data, _ = pull_tar(ph, part)
            got = extract(data, st) if data else set()
            failed.update(set(part) - got)
        except SyncError as e:
            print(f'  ✗ ← {LOCAL}：{e}')
            failed.update(part)
    if backed:
        print(f'  被覆盖的旧文件备份在 {bk}')
    return failed


def show(lst, arrow, n=8):
    for rel in lst[:n]:
        print(f'     {arrow} {rel}')
    if len(lst) > n:
        print(f'     {arrow} … 另 {len(lst) - n} 个')


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--st', help='这一侧的 data/default-user（电脑酒馆，或当中心的 Mac TT）；--ext-only 时可以不给')
    ap.add_argument('--local-name', default='电脑', help='这一侧在输出里的叫法')
    ap.add_argument('--ext-only', action='store_true', help='只推扩展（--ext-dir → 对方），不同步文件和标签')
    ap.add_argument('--adb')
    ap.add_argument('--serial')
    ap.add_argument('--push-only', action='store_true',
                    help='只从电脑推过去：对方独有的文件不拉回来，对方更新的文件不覆盖（导入 / 安装用）')
    ap.add_argument('--settings', action='store_true',
                    help='（仅 --local-tt）把电脑酒馆的部分扩展设置和对话补全设置复制过去')
    ap.add_argument('--local-tt', help='这台 Mac 上 TauriTavern 的 data/default-user（代替 --adb/--serial）')
    ap.add_argument('--state')
    ap.add_argument('--backups')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--exit-if-nothing', action='store_true', help='预览时两边已经一样就以退出码 3 结束')
    ap.add_argument('--mac-ip')
    ap.add_argument('--port', type=int, default=8901)
    ap.add_argument('--lan-key-file')
    ap.add_argument('--ext-dir', help='电脑上的第三方扩展目录（SillyTavern/public/scripts/extensions/third-party）')
    ap.add_argument('--ext-force', action='store_true', help='对方的扩展比电脑新或分叉时也覆盖（旧的留在 .cm-previous）')
    ap.add_argument('--trust-listing', action='store_true',
                    help='手机上确实删掉了很多文件：不因为「列表比上次少很多」而拒绝同步')
    a = ap.parse_args(argv)
    global LOCAL
    LOCAL = a.local_name
    if not a.ext_only and not (a.st and a.state and a.backups):
        ap.error('需要 --st、--state 和 --backups（只推扩展时用 --ext-only）')
    if a.ext_only and not a.ext_dir:
        ap.error('--ext-only 需要 --ext-dir')

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
        if ph.problem:
            hint = {'unauthorized': '手机上弹出的「允许 USB 调试」点允许', 'offline': '重新插线，或在手机上关掉再打开无线调试'}
            print(f'✗ 连不上手机（{a.serial}：{ph.problem}）。{hint.get(ph.problem, "检查数据线 / 无线调试")}')
            return 2
    side = ph.label
    if not ph.base:
        if ph.root:
            print('✗ 手机上找不到 TauriTavern 的数据（没装，或还没打开过一次）。')
        else:
            print('✗ 手机上读不到 TauriTavern 的数据：没有 root（su 没授权给 Shell），Android 11 起读不到 Android/data。')
            print('  没有 root 时：用 TauriTavern 自带的「数据迁移」扩展导出 / 导入。')
        return 2
    print(f'  {side}：{a.local_tt or a.serial}{"（root）" if ph.root else ""}')
    if a.ext_only:
        todo = plan_extensions(ph, a.ext_dir, a.ext_force) if os.path.isdir(a.ext_dir) else []
        if not todo:
            print('  扩展：没有要推的')
            return 0
        if a.dry_run:
            return 0
        failed = push_extensions(ph, todo)
        print(f'  ✓ 扩展已更新 {len(todo)} 个' if not failed else f'  ✗ {len(failed)} 个扩展没推成：{"、".join(failed)}')
        return 1 if failed else 0
    state = load_state(a.state)
    loc = local_files(a.st)
    try:
        rem = remote_files(ph)
    except SyncError as e:
        print(f'✗ {e}。什么都没改。')
        return 2
    gone = listing_shrunk(state, rem)
    if gone and not a.trust_listing:
        print(f'✗ {side}上少了 {gone} 个上次同步过的文件（共 {len(state)} 个），多半是列表没读全，这次不同步。')
        print('  如果确实在手机上删了这么多文件，加 --trust-listing 再运行（删掉的会从电脑复制回去）。')
        return 2
    push, pull, conflicts, clashes = plan(loc, rem, state)
    identical = settle_identical(ph, a.st, loc, rem, set(push) | set(pull)) if not a.push_only else set()
    if identical:
        push = [r for r in push if r not in identical]
        pull = [r for r in pull if r not in identical]
        conflicts = [r for r in conflicts if r not in identical]
    if a.push_only:
        kept = [r for r in pull if r in loc]   # 对方的更新：不覆盖
        only_there = [r for r in pull if r not in loc]
        pull, conflicts = [], [r for r in conflicts if r in push]
        if only_there:
            print(f'  {side}独有、{LOCAL}上没有的 {len(only_there)} 个文件：保留在{side}，不拉回{LOCAL}')
        for rel in kept:
            print(f'  ! {side}上的比{LOCAL}新，没有覆盖：{rel}')
    print(f'  {LOCAL} {len(loc)} 个文件，{side} {len(rem)} 个文件')
    print(f'  → {side}：{len(push)} 个    ← {LOCAL}：{len(pull)} 个    两边都改过 / 没有记录：{len(conflicts)} 个')
    show(push, '→')
    show(pull, '←')
    for rel in conflicts[:20]:
        print(f'  ! {"两边都改过" if rel in state else "没有同步记录、两边不一样"}，用较新的一份（{LOCAL if rel in push else side}），另一份进备份：{rel}')
    if len(conflicts) > 20:
        print(f'  ! … 另 {len(conflicts) - 20} 个同样处理')
    for rel in clashes:
        print(f'  ! 文件名只差大小写，两边会互相覆盖，没动（请改名）：{rel}')
    ext_todo = []
    if a.ext_dir and os.path.isdir(a.ext_dir):
        ext_todo = plan_extensions(ph, a.ext_dir, a.ext_force)
        if not ext_todo:
            print(f'  扩展：没有要推的')
    try:
        copies = chat_conflict_copies(ph, a.st, conflicts, push, loc, rem, write=not a.dry_run)
    except (SyncError, OSError) as e:
        print(f'✗ 比较冲突的聊天记录时出错（{e}）。什么都没改。')
        return 2
    for rel, name, n in copies:
        print(f'  ! 两边各自往下聊过：{os.path.basename(rel)} 里输的那份多出 {n} 楼，'
              f'{"会" if a.dry_run else "已"}另存为「{os.path.basename(name)}」（两边都有）')
        if not a.dry_run:
            loc[name] = (int(os.stat(os.path.join(a.st, name)).st_mtime), os.path.getsize(os.path.join(a.st, name)))
            push.append(name)
    if a.dry_run:
        # 预览按同步完成后的样子算：要传过去的角色卡也算对方有
        text, errs = sync_tags(ph, a.st, None, set(loc) | set(pull), set(rem) | set(push), a.push_only, dry=True)
        for e in errs:
            print(f'  ! {e}')
        if text:
            print(f'  {text}')
        tags_todo = bool(re.search(r'[1-9]\d* 个', text or ''))
        # --exit-if-nothing：没有任何要做的（文件、扩展、标签）时退出码 3，给启动器判断要不要关 TT
        api_todo = a.exit_if_nothing and not a.push_only and sync_api(ph, a.st, a.port, None, dry=True)[0]
        if a.exit_if_nothing and not (push or pull or conflicts or copies or ext_todo or tags_todo or api_todo):
            print('  两边已经一样，没有要同步的')
            return 3
        return 0

    bk = os.path.join(a.backups, time.strftime('%Y-%m-%d'), f"{time.strftime('%H%M%S')}-{side}同步前")
    failed = run_sync(ph, a.st, push, pull, loc, rem, bk)
    ext_failed = push_extensions(ph, ext_todo) if ext_todo else []

    # 核对：同步过的文件两边必须大小一致、时间对得上；对不上的不记进状态，下次重新同步
    touched = set(push) | set(pull)
    try:
        loc2, rem2 = local_files(a.st), remote_files(ph)
    except SyncError as e:
        loc2 = rem2 = None
        print(f'  ! 同步后没法核对（{e}），这次不更新同步记录；下次会重新比较')
    if rem2 is not None and len(rem2) < len(rem) * (1 - SHRINK_LIMIT):
        print(f'  ! 同步后{side}上的文件反而少了很多（{len(rem)} → {len(rem2)}），这次不更新同步记录')
        rem2 = None
    missing = set(failed)
    if rem2 is not None:
        new_state = merge_state(state, loc2, rem2, touched, failed)
        for rel in identical:   # 内容一样的：按现在两边的时间记下，下次不再比较
            if rel in loc2 and rel in rem2:
                new_state[rel] = {'l': list(loc2[rel]), 'r': list(rem2[rel])}
        missing |= {r for r in touched if r not in new_state or not same(loc2.get(r), rem2.get(r))}
        save_state(a.state, new_state)

    notes = []
    if rem2 is not None:
        text, errs = sync_tags(ph, a.st, bk, loc2, rem2, a.push_only)
        for e in errs:
            print(f'  ✗ {e}')
        if errs:
            notes.append('标签没同步成')
        elif text:
            print(f'  ✓ {text}')
    if a.settings and isinstance(ph, LocalTT):
        ch = copy_settings(ph, a.st, bk)
        print(f'  ✓ 扩展设置和对话补全设置已复制到{side}（旧的备份在 {bk}）' if ch else f'  扩展设置：{side}上已是最新')
    if rem2 is not None and not a.push_only:
        text, errs = sync_api(ph, a.st, a.port, bk)
        for e in errs:
            print(f'  ✗ API 和预设设置没同步：{e}')
        if errs:
            notes.append('API 设置没同步')
        elif text:
            print(f'  ✓ API 和预设设置 {text}；密钥不同步')
    if a.mac_ip:
        key = None
        if a.lan_key_file and os.path.exists(a.lan_key_file) and not a.local_tt:
            with open(a.lan_key_file, encoding='utf-8') as f:
                key = f.read().strip()
        ch, errs = fix_endpoint(ph, a.mac_ip, a.port, key, bk)
        for e in errs:
            print(f'  ✗ {side}的代理地址没改成：{e}')
        if errs:
            notes.append('代理地址没改成')
        else:
            print(f'  ✓ {side}的代理地址已对准 http://{a.mac_ip}:{a.port}/v1' + (f'（旧设置备份在 {bk}）' if ch else '（本来就是）'))

    n_push, n_pull = len([r for r in push if r not in missing]), len([r for r in pull if r not in missing])
    if ext_failed:
        notes.append(f'{len(ext_failed)} 个扩展没推成')
    if rem2 is None:
        notes.append('没核对上')
    if missing:
        notes.append(f'{len(missing)} 个文件没同步成功')
    counts = f'→ {side} {n_push}/{len(push)} 个，← {LOCAL} {n_pull}/{len(pull)} 个'
    if not missing and not notes:
        print(f'  ✓ 同步完成：→ {side} {len(push)} 个，← {LOCAL} {len(pull)} 个' + (f'，扩展 {len(ext_todo)} 个' if ext_todo else ''))
    elif touched and n_push + n_pull == 0 and missing:
        print(f'  ✗ 同步失败：{counts}；' + '；'.join(notes))
    else:
        print(f'  ✗ 同步没全部完成：{counts}；' + '；'.join(notes))
    for rel in sorted(missing)[:10]:
        print(f'  ! 没同步成功：{rel}')
    return 1 if (missing or notes) else 0


if __name__ == '__main__':
    sys.exit(main())
