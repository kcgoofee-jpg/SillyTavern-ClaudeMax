#!/usr/bin/env python3
"""电脑酒馆（SillyTavern）↔ 手机 TauriTavern 双向同步（adb，USB 或无线调试）；
也能同步这台 Mac 上的 TauriTavern（--local-tt，规则相同，不用 adb）。

同步：聊天、角色卡、世界书、预设、头像、背景、生图图片、主题、快速回复。
扩展：只从电脑推到手机，而且只在手机上的版本是电脑版本的旧版时才推（手机上更新过、或两边分叉时不推，
      说明原因）；推的是 git 管理的文件和 .git，整个换成新文件夹，旧文件夹换下来进存档（见下）。
      当前分支没设上游的扩展（TT 查更新会报错）列出来；你同意才设成跟 origin 的默认分支（只改 .git/config）。
标签：角色卡上的标签（settings.json 的 tags / tag_map）按标签名合并，只加不删（一边删掉的标签会被另一边加回来）；
      --push-only 时只把电脑的标签加到对方。
不同步：其他设置。另外把手机上的代理地址对准这台 Mac 现在的 IP；带访问密码时，手机 api_key_custom 里
      启用的那条设成 Mac 的访问密码（手机的自定义地址指着 CCST 代理，TT 把它当访问密码发给代理）。

规则（按上次同步时记下的状态判断哪边改过）：
  只有一边改过 → 用改过的那边（自动）；两边都改过（冲突），或者没有同步记录、两边又不一样 → 要你选
  （以哪边为准 / 两份都留）；没选时用较新的，另一份存进备份，并且列出来。只有一边有的文件 → 复制到另一边。从不删除文件。
  聊天记录冲突时再按楼层比一次：输的那份里有赢的那份没有的楼层（两边各自往下聊过）→ 另存成
  「原名 [冲突副本·哪边 时间].jsonl」，两边的聊天列表里都能看到，不只是进备份。
  只差大小写的两个文件名（Mac 和手机都不分大小写，会互相覆盖）→ 不动，列出来。
  被覆盖的文件先备份到 <酒馆目录>/backups/<日期>/<时间>-手机同步前/{电脑,手机}/；备份没做成的那批不覆盖。
  写入先写到临时文件 / 临时文件夹再换名，中途断开不会留下写了一半的文件。
手机上的 TauriTavern 数据在 Android/data 里：需要 root（su），或 Android 10 及以下。

API 设置（oai_settings，连哪个地址各边保留自己的）和 API 密钥（只互补、不改各自正在用的那条）也是
要你选：菜单先 --plan-json 看计划，你选好后 --choices 执行；不给 --choices（手机遥控同步等）时不动它们，只列出来。
手机上装了 TT 守护模块时：它正在恢复备份就不同步；上次恢复没做完要你确认；写手机之前先让它存一份快照。
推扩展后换下来的旧文件夹收进存档（手机 data/_cm_archive/，Mac TT 的进 backups/），每个扩展只留最新一份。

用法：phone_sync.py --st <SillyTavern/data/default-user> --adb <adb> --serial S [--dry-run]
      [--mac-ip IP --port 8901 --lan-key-file F] [--plan-json F | --choices F] [--result-json F]
      phone_sync.py --st <…> --local-tt <TT 的 data/default-user> [--dry-run] [--port 8901]
      phone_sync.py --upstream-check <扩展目录> [--upstream-fix]
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


# 手机上的 TT 守护模块（tt-root-module）：恢复备份时有 .restore.lock，恢复中途断了留 restore.pending
GUARD_MOD = '/data/adb/modules/claudemax_tt_keepalive'
GUARD_DIR = '/data/adb/tt-guard'


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


# ── TT 守护 ──

def guard_state(ph):
    """→ None（不是手机）/ {'module': 装了没有, 'restoring': 正在恢复, 'pending': 上次恢复没做完}。"""
    if isinstance(ph, LocalTT):
        return None
    m, g = shlex.quote(GUARD_MOD), shlex.quote(GUARD_DIR)
    out = ph.rsh(f'[ -f {m}/ui.sh ] && echo CM_MOD; [ -e {g}/.restore.lock ] && echo CM_LOCK; '
                 f'[ -e {g}/restore.pending ] && echo CM_PENDING; echo CM_END')
    return {'module': 'CM_MOD' in out, 'restoring': 'CM_LOCK' in out, 'pending': 'CM_PENDING' in out}


def guard_snapshot(ph):
    """写手机之前让 TT 守护先存一份 TT 的快照（ui.sh backup tt）。→ (成功没有, 说明)。"""
    out = ph.rsh(f'sh {shlex.quote(GUARD_MOD)}/ui.sh backup tt')
    try:
        d = json.loads(out.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return False, '没有回应'
    if d.get('ok'):
        return True, '、'.join(d.get('names') or []) or '已保存'
    return False, str(d.get('msg') or '失败')


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


def _read_bytes(path):
    with open(path, 'rb') as f:
        return f.read()


def backup_once(path, data, private=False):
    """备份一份原文件：同一次同步里同一个文件只留第一份（后面的步骤看到的已经是改过的）。"""
    if os.path.exists(path):
        return
    atomic_write(path, data)
    if private:
        os.chmod(path, 0o600)


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


def plan_extensions(ph, ext_dir, force=False, report=None):
    """→ [(name, src, rev)] 要推的扩展；同时打印每个扩展的决定。report（列表）另外收到
    {'name', 'decision', 'side_rev', 'rev'}，给 --plan-json 用。"""
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
            if report is not None:
                report.append({'name': name, 'decision': 'unreadable', 'side_rev': '', 'rev': rev[:7]})
            continue
        d = ext_decision(rev, st,
                         known=lambda p, s=src: git(s, 'cat-file', '-e', p + '^{commit}').returncode == 0,
                         is_ancestor=lambda a, b, s=src: git(s, 'merge-base', '--is-ancestor', a, b).returncode == 0,
                         force=force)
        if report is not None:
            report.append({'name': name, 'decision': d, 'side_rev': (st['rev'] or '')[:7], 'rev': rev[:7]})
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


def push_extensions(ph, todo, backups=None):
    """推扩展：解到新文件夹，旧文件夹移到 extensions/.cm-previous/<名字>，再把新的换上。
    换好、核对过（新文件夹里的推送标记对得上）之后，把旧文件夹收进存档（见 archive_previous）。返回失败的名字。"""
    rext = remote_ext_dir(ph)
    prev = os.path.join(os.path.dirname(rext), '.cm-previous')
    failed, done = [], []
    for name, src, rev in todo:
        fd, tarpath = tempfile.mkstemp(suffix='.tar')
        os.close(fd)
        try:
            pack_extension(src, name, rev, tarpath)
            if isinstance(ph, LocalTT):
                _swap_local_ext(tarpath, rext, prev, name)
            else:
                _swap_phone_ext(ph, tarpath, rext, prev, name)
            st = remote_ext_state(ph, f'{rext}/{name}')
            if st and st['marker'] == f'{rev} {PACKER}':
                done.append(name)
        except (SyncError, OSError, tarfile.TarError) as e:
            print(f'  ✗ 扩展 {name} 没推成：{e}')
            failed.append(name)
        finally:
            os.unlink(tarpath)
    archive_previous(ph, done, backups)
    return failed


def archive_dir(ph, backups):
    """旧扩展副本收到哪：手机上 data/_cm_archive/<日期>-扩展旧副本/，Mac TT 的收进 backups/<日期>/扩展旧副本/。"""
    day = time.strftime('%Y-%m-%d')
    if isinstance(ph, LocalTT):
        return os.path.join(backups, day, '扩展旧副本') if backups else None
    return f'{os.path.dirname(ph.base)}/_cm_archive/{day}-扩展旧副本'


def previous_names(ph):
    """extensions/.cm-previous 里留着的旧副本名字。"""
    prev = os.path.join(os.path.dirname(remote_ext_dir(ph)), '.cm-previous')
    if isinstance(ph, LocalTT):
        try:
            return sorted(n for n in os.listdir(prev) if not n.startswith('.'))
        except OSError:
            return []
    out = ph.rsh(f'ls -1 {shlex.quote(prev)} 2>/dev/null; echo CM_END')
    return [l.strip() for l in out.splitlines() if l.strip() and l.strip() != 'CM_END'] if 'CM_END' in out else []


def archive_previous(ph, names, backups=None):
    """已经换好的扩展：extensions/.cm-previous/<名字> 挪进存档（不删），同一个扩展只留最新的一份存档。
    TT 会把 extensions 下的文件夹当扩展看，旧副本放在那里像垃圾。→ 挪了的名字。"""
    dest = archive_dir(ph, backups)
    prev = os.path.join(os.path.dirname(remote_ext_dir(ph)), '.cm-previous')
    have = set(previous_names(ph)) if names else set()
    moved = []
    for name in names:
        if name not in have or not dest:
            continue
        if isinstance(ph, LocalTT):
            root = os.path.dirname(os.path.dirname(dest))   # backups/
            for day in os.listdir(root) if os.path.isdir(root) else []:
                old = os.path.join(root, day, '扩展旧副本', name)
                if os.path.lexists(old):
                    shutil.rmtree(old, ignore_errors=True)
            os.makedirs(dest, exist_ok=True)
            try:
                os.rename(os.path.join(prev, name), os.path.join(dest, name))
                moved.append(name)
            except OSError as e:
                print(f'  ! 扩展 {name} 的旧副本没收进存档：{e}')
            continue
        root = os.path.dirname(dest)
        n, r, d, p = (shlex.quote(x) for x in (name, root, dest, f'{prev}/{name}'))
        out = ph.rsh(f'mkdir -p {d} || exit 1; for o in {r}/*-扩展旧副本/{n}; do [ -e "$o" ] && rm -rf "$o"; done; '
                     f'mv {p} {d}/{n} && echo CM_OK; rmdir {r}/*-扩展旧副本 2>/dev/null; '
                     f'{ph.chown_cmd(ph.base, r)}')
        if 'CM_OK' in out:
            moved.append(name)
        else:
            print(f'  ! 扩展 {name} 的旧副本没收进存档（还在 extensions/.cm-previous）')
    if moved:
        print(f'  扩展旧副本收进了存档（{dest}）：{"、".join(moved)}')
    return moved


# ── 扩展的上游分支（TT 检查扩展更新要用）──

def parse_upstream(txt):
    """ext_upstream_script 一个扩展的输出 → None（有上游、或不是在分支上）/ {'branch', 'target'}（target 可能是 None）。"""
    kv, cfg = {}, []
    in_cfg = False
    for line in txt.splitlines():
        if line == 'CM_CFG':
            in_cfg = True
            continue
        if in_cfg:
            cfg.append(line)
        elif ':' in line:
            k, v = line.split(':', 1)
            kv[k] = v.strip()
    head = kv.get('H', '')
    if not head.startswith('ref: refs/heads/'):
        return None
    branch = head[len('ref: refs/heads/'):]
    sec, have, has_origin = None, set(), False
    for line in cfg:
        m = re.match(r'^\s*\[\s*([^\]"\s]+)(?:\s+"(.*)")?\s*\]', line)
        if m:
            sec = (m.group(1).lower(), m.group(2))
            has_origin = has_origin or sec == ('remote', 'origin')
            continue
        m = re.match(r'^\s*(\w+)\s*=', line)
        if m and sec == ('branch', branch):
            have.add(m.group(1).lower())
    if {'remote', 'merge'} <= have:
        return None
    refs = set(kv.get('R', '').split())
    o = kv.get('O', '')
    target = o[len('ref: refs/remotes/origin/'):] if o.startswith('ref: refs/remotes/origin/') else \
        'main' if 'main' in refs else 'master' if 'master' in refs else None
    return {'branch': branch, 'target': target if has_origin else None}


def _upstream_script(root):
    q = shlex.quote(root)
    return (f'for d in {q}/*/; do d=${{d%/}}; [ -d "$d/.git" ] || continue; echo "CM_EXT:${{d##*/}}"; '
            f'echo "H:$(head -1 "$d/.git/HEAD" 2>/dev/null)"; echo "O:$(head -1 "$d/.git/refs/remotes/origin/HEAD" 2>/dev/null)"; '
            f'echo "R:$(ls "$d/.git/refs/remotes/origin" 2>/dev/null | tr "\n" " ") '
            f'$(sed -n "s#.* refs/remotes/origin/##p" "$d/.git/packed-refs" 2>/dev/null | tr "\n" " ")"; '
            f'echo CM_CFG; cat "$d/.git/config" 2>/dev/null; echo; done; echo CM_ALL_END')


def ext_upstream(ph, root):
    """root 下每个扩展：当前分支没设上游的 → [{'name', 'branch', 'target'}]。ph 为 None = 这台电脑上的目录。"""
    if ph is None or isinstance(ph, LocalTT):
        out = subprocess.run(['sh', '-c', _upstream_script(root)], capture_output=True, text=True).stdout
    else:
        out = ph.rsh(_upstream_script(root))
    if 'CM_ALL_END' not in out:
        return []
    res = []
    for part in out.split('CM_EXT:')[1:]:
        name, _, rest = part.partition('\n')
        u = parse_upstream(rest.replace('CM_ALL_END', ''))
        if u:
            res.append({'name': name.strip(), **u})
    return res


def fix_upstream(ph, root, items):
    """把没设上游的分支设成跟 origin 的默认分支（只改 .git/config，加一段 [branch]，不动提交历史）。→ 改好的名字。"""
    done = []
    for it in items:
        if not it.get('target'):
            continue
        cfg = f'{root}/{it["name"]}/.git/config'
        section = f'[branch "{it["branch"]}"]\n\tremote = origin\n\tmerge = refs/heads/{it["target"]}\n'
        if ph is None or isinstance(ph, LocalTT):
            try:
                with open(cfg, encoding='utf-8') as f:
                    body = f.read()
                atomic_write(cfg, (body + ('' if body.endswith('\n') or not body else '\n') + section).encode('utf-8'))
                done.append(it['name'])
            except OSError as e:
                print(f'  ! 扩展 {it["name"]} 的上游没设成：{e}')
            continue
        out = ph.rsh(f'printf %s {shlex.quote(section)} >> {shlex.quote(cfg)} && echo CM_OK')
        if 'CM_OK' in out:
            done.append(it['name'])
    return done


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
        backup_once(os.path.join(bk, rel), raw.encode('utf-8'))
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
    uses_proxy = False
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
        if str((d2.get('oai_settings') or {}).get('custom_url') or '').startswith(new):
            uses_proxy = True
        cm = (d2.get('extension_settings') or {}).get('claude_max')
        if key and isinstance(cm, dict) and cm.get('accessKey') != key:
            cm['accessKey'] = key
        if d2 == d:   # 比较内容，不比较排版
            continue
        try:
            backup_once(os.path.join(bk, ph.label, rel), raw)
            write_remote_text(ph, path, json.dumps(d2, ensure_ascii=False, indent=4 if rel == 'settings.json' else None).encode('utf-8'))
            changed.append(rel)
        except (SyncError, OSError) as e:
            errors.append(f'{rel}：{e}')
    if key and uses_proxy and not isinstance(ph, LocalTT):
        try:
            if ensure_lan_secret(ph, key, bk):
                changed.append('secrets.json')
        except (SyncError, OSError, ValueError) as e:
            errors.append(f'secrets.json：{e}')
    return changed, errors


LAN_KEY_LABEL = 'CCST 代理（手机）'


def ensure_lan_secret(ph, key, bk):
    """手机的自定义地址指着 CCST 代理时，TT 把 api_key_custom 里启用的那条当访问密码发给代理：
    保证有一条值是 Mac 的访问密码、并且是启用的那条（没有就加，标签 LAN_KEY_LABEL）；
    同一项里别的条目只取消启用，不删。改之前备份（只给本人读）。不打印任何值。→ 改了没有。"""
    rpath = f'{ph.base}/secrets.json'
    raw, err = read_remote_text(ph, rpath)
    if err and err != 'missing':
        raise SyncError(err)
    d = json.loads(raw) if raw else {}
    if not isinstance(d, dict):
        raise ValueError('格式不认识，没改')
    lst = d.get('api_key_custom')
    if isinstance(lst, str):   # 旧格式：原来的值留着（不启用）
        lst = [{'id': str(uuid.uuid4()), 'value': lst, 'label': '', 'active': False}] if lst else []
    elif not isinstance(lst, list):
        lst = []
    lst = [dict(e) for e in lst if isinstance(e, dict)]
    mine = next((e for e in lst if e.get('value') == key), None)
    if mine is None:
        mine = {'id': str(uuid.uuid4()), 'value': key, 'label': LAN_KEY_LABEL, 'active': True}
        lst.append(mine)
    for e in lst:
        e['active'] = e is mine
    if d.get('api_key_custom') == lst:
        return False
    d['api_key_custom'] = lst
    if raw is not None:
        backup_once(os.path.join(bk, ph.label, 'secrets.json'), raw, private=True)
    write_remote_text(ph, rpath, json.dumps(d, ensure_ascii=False, indent=4).encode('utf-8'))
    return True


# 对话补全设置里每台设备各用各的：连哪个地址（手机连 Mac 的局域网地址，Mac 连本机）
PER_DEVICE_OAI = ('custom_url', 'reverse_proxy')


def _read_api(ph, st, port):
    """→ (信息 dict / None, 出错说明列表)。信息里有两边的原始数据，给 api_diff / sync_api 用。"""
    lrel = 'settings/presets.json' if os.path.exists(os.path.join(st, 'settings/presets.json')) else 'settings.json'
    lpath, rpath = os.path.join(st, lrel), f'{ph.base}/settings/presets.json'
    if not os.path.exists(lpath):
        return None, []
    try:
        lraw = _read_bytes(lpath)
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
    pat = re.compile(r'http://[0-9A-Za-z.\-]+:' + str(port) + r'(?![0-9])')

    def norm(o):
        o = {k: v for k, v in o.items() if k not in PER_DEVICE_OAI}
        return pat.sub('http://proxy:' + str(port), json.dumps(o, ensure_ascii=False, sort_keys=True))
    if norm(lo) == norm(ro):
        return None, []
    if isinstance(ph, LocalTT):
        rtime = os.path.getmtime(rpath)
    else:
        out = ph.rsh(f'stat -c %Y {shlex.quote(rpath)}').strip()
        rtime = float(out) if out.isdigit() else 0
    return {'lrel': lrel, 'lpath': lpath, 'rpath': rpath, 'lraw': lraw, 'rraw': rraw, 'ld': ld, 'rd': rd,
            'lo': lo, 'ro': ro, 'pat': pat, 'newer': 'local' if os.path.getmtime(lpath) >= rtime else 'remote'}, []


def api_diff(ph, st, port):
    """对话补全设置两边不一样时 → ({'newer', 'preset': {'local', 'remote'}}, 出错说明)；一样 → (None, [])。"""
    info, errs = _read_api(ph, st, port)
    if not info:
        return None, errs
    return {'newer': info['newer'], 'preset': {'local': info['lo'].get('preset_settings_openai'),
                                               'remote': info['ro'].get('preset_settings_openai')}}, []


def sync_api(ph, st, port, bk, direction):
    """对话补全设置（API 来源、模型、当前预设、各项开关 = oai_settings）按 direction（'local' = 以这一侧为准，
    'remote' = 以对方为准）对齐。连哪个地址（PER_DEVICE_OAI）各边保留自己的；:port 的代理地址也保留。
    密钥在 secrets.json，不在这里。→ (方向说明 / None, 出错说明列表)。"""
    info, errs = _read_api(ph, st, port)
    if not info:
        return None, errs
    to_phone = direction == 'local'
    src, dst = (info['lo'], info['ro']) if to_phone else (info['ro'], info['lo'])
    pat = info['pat']
    keep = next(iter(pat.findall(json.dumps(dst, ensure_ascii=False))), None)
    text = json.dumps(src, ensure_ascii=False)
    new = json.loads(pat.sub(keep, text) if keep else text)
    for k in PER_DEVICE_OAI:
        if k in dst:
            new[k] = dst[k]
        else:
            new.pop(k, None)
    try:
        if to_phone:
            backup_once(os.path.join(bk, ph.label, 'settings/presets.json'), info['rraw'])
            info['rd']['oai_settings'] = new
            write_remote_text(ph, info['rpath'], json.dumps(info['rd'], ensure_ascii=False).encode('utf-8'))
        else:
            backup_once(os.path.join(bk, LOCAL, info['lrel']), info['lraw'])
            info['ld']['oai_settings'] = new
            atomic_write(info['lpath'], json.dumps(info['ld'], ensure_ascii=False,
                                                   indent=4 if info['lrel'] == 'settings.json' else None).encode('utf-8'))
    except (SyncError, OSError) as e:
        return None, [str(e)]
    preset = new.get('preset_settings_openai') or '（未知）'
    return (f'→ {ph.label}' if to_phone else f'← {LOCAL}') + f'（当前预设「{preset}」）', []


def add_missing_secrets(mine, other):
    """把 other 里有、mine 里没有的密钥（按值去重）加进 mine 的副本，一律不启用（active=False）。
    「当前用哪个」是每台设备自己的：从不改 mine 里已有条目的 active，也不把对方的 active 带过来
    （手机的自定义地址指着 CCST 代理，Mac 上启用的网关密钥带过去会被代理当成错的访问密码）。
    旧格式（键 → 字符串）不动：那种写法本身就是「正在用的」。→ (新的 dict, 加了几条)。"""
    out = json.loads(json.dumps(mine))
    added = 0
    for k, b in other.items():
        if not isinstance(b, list):
            continue
        a = out.setdefault(k, [])
        if not isinstance(a, list):
            continue
        have = {e.get('value') for e in a if isinstance(e, dict)}
        for e in b:
            if isinstance(e, dict) and e.get('value') and e.get('value') not in have:
                a.append(dict(e, active=False))
                have.add(e.get('value'))
                added += 1
    return out, added


def read_secrets(ph, st):
    """→ (本地 dict, 本地原始字节, 对方 dict, 对方原始字节 / None, 出错说明 / None)。"""
    lpath, rpath = os.path.join(st, 'secrets.json'), f'{ph.base}/secrets.json'
    try:
        lraw = _read_bytes(lpath) if os.path.exists(lpath) else b'{}'
        ld = json.loads(lraw)
    except (OSError, ValueError):
        return None, None, None, None, f'{LOCAL}的 secrets.json 读不了'
    rraw, err = read_remote_text(ph, rpath)
    if err and err != 'missing':
        return None, None, None, None, f'{ph.label}的 secrets.json：{err}'
    try:
        rd = json.loads(rraw) if rraw else {}
    except ValueError:
        return None, None, None, None, f'{ph.label}的 secrets.json 不是合法 JSON'
    if not isinstance(ld, dict) or not isinstance(rd, dict):
        return None, None, None, None, 'secrets.json 格式不认识'
    return ld, lraw, rd, rraw, None


def secrets_diff(ph, st):
    """两边各缺几条密钥：→ ({'local': n, 'remote': n} / None, 出错说明列表)。不读出任何值。"""
    ld, _, rd, _, err = read_secrets(ph, st)
    if err:
        return None, [err]
    _, to_l = add_missing_secrets(ld, rd)
    _, to_r = add_missing_secrets(rd, ld)
    return ({'local': to_l, 'remote': to_r} if to_l or to_r else None), []


def sync_secrets(ph, st, bk, dry=False):
    """API 密钥（secrets.json）两边互补：只把对方有、这边没有的加进来（不启用），
    不删、不改已有的，也不改哪个在用。不打印任何密钥。→ (说明 / None, 出错说明列表)"""
    lpath, rpath = os.path.join(st, 'secrets.json'), f'{ph.base}/secrets.json'
    ld, lraw, rd, rraw, err = read_secrets(ph, st)
    if err:
        return None, [err]
    new_l, n_l = add_missing_secrets(ld, rd)
    new_r, n_r = add_missing_secrets(rd, ld)
    if not (n_l or n_r):
        return None, []
    if dry:
        return 'todo', []
    try:
        # 备份里有密钥：只给本人读
        if n_l and os.path.exists(lpath):
            backup_once(os.path.join(bk, LOCAL, 'secrets.json'), lraw, private=True)
        if n_r and rraw is not None:
            backup_once(os.path.join(bk, ph.label, 'secrets.json'), rraw, private=True)
        if n_l:
            atomic_write(lpath, json.dumps(new_l, ensure_ascii=False, indent=4).encode('utf-8'))
            os.chmod(lpath, 0o600)
        if n_r:
            write_remote_text(ph, rpath, json.dumps(new_r, ensure_ascii=False, indent=4).encode('utf-8'))
    except (SyncError, OSError) as e:
        return None, [str(e)]
    return f'→ {ph.label} 加了 {n_r} 条，← {LOCAL} 加了 {n_l} 条（都不启用，各自正在用的不变）', []


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
        lraw = _read_bytes(lpath)
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
            backup_once(os.path.join(bk, side, 'settings.json'), rraw)
            write_remote_text(ph, rpath, json.dumps(rem_d, ensure_ascii=False, indent=4).encode('utf-8'))
        except (SyncError, OSError) as e:
            errors.append(f'{side}的标签没写成：{e}')
    if n_loc:
        try:
            add_tags(loc_d, to_loc)
            backup_once(os.path.join(bk, LOCAL, 'settings.json'), lraw)
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


def is_chat(rel):
    return rel.startswith(CHAT_DIRS) and rel.endswith('.jsonl')


def _pull_chats(ph, chats):
    """对方的这些聊天 → {rel: 字节}。"""
    data, _ = pull_tar(ph, chats)
    out = {}
    if data:
        with tempfile.TemporaryDirectory() as tmp:
            for rel in extract(data, tmp):
                with open(os.path.join(tmp, rel), 'rb') as f:
                    out[rel] = f.read()
    return out


def chat_conflict_info(ph, st, chats):
    """两边都改过的聊天：各自有几楼是对方没有的 → {rel: {'local': n, 'remote': n}}（预览用，不写）。"""
    out = {}
    if not chats:
        return out
    theirs = _pull_chats(ph, chats)
    for rel in chats:
        if rel not in theirs:
            continue
        with open(os.path.join(st, rel), 'rb') as f:
            mine = f.read()
        out[rel] = {'local': missing_floors(theirs[rel], mine), 'remote': missing_floors(mine, theirs[rel])}
    return out


def chat_conflict_copies(ph, st, conflicts, push, loc, rem, write=True, force=()):
    """聊天冲突里，输的一份有赢的一份没有的楼层 → 另存到这一侧（随后推到对方）。
    force 里的（你选了「两份都留」）不管多不多楼都另存。
    → [(原文件, 副本相对路径, 多出的楼数)]。write=False 只算不写（预览）。"""
    chats = [r for r in conflicts if is_chat(r)]
    if not chats:
        return []
    theirs = _pull_chats(ph, chats)
    out = []
    for rel in chats:
        if rel not in theirs:
            continue
        with open(os.path.join(st, rel), 'rb') as f:
            l = f.read()
        r = theirs[rel]
        local_wins = rel in push
        win, lose = (l, r) if local_wins else (r, l)
        extra = missing_floors(win, lose)
        if not extra and rel not in force:
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
    ap.add_argument('--plan-json', metavar='FILE',
                    help='只预览：把计划按「自动 / 要你选 / 跳过」写成 JSON 到 FILE（菜单用），什么都不改')
    ap.add_argument('--choices', metavar='FILE',
                    help='菜单里选好的：JSON {"files": {相对路径: local|remote|both|newer}, "api": local|remote|skip, '
                         '"secrets": merge|skip}。不给时「要你选」的按安全默认：冲突用较新的并留冲突副本，'
                         'API 设置和密钥不动（列出来）')
    ap.add_argument('--result-json', metavar='FILE', help='同步结果写成 JSON 到 FILE（菜单用）')
    ap.add_argument('--upstream-check', metavar='DIR', action='append',
                    help='只看这台电脑上 DIR 里的扩展：当前分支没设上游的（TT 查扩展更新会报错）→ JSON 打到标准输出')
    ap.add_argument('--upstream-fix', action='store_true', help='和 --upstream-check 一起：把它们设成跟 origin 的默认分支')
    a = ap.parse_args(argv)
    if a.upstream_check:
        res = {}
        for d in a.upstream_check:
            items = ext_upstream(None, d) if os.path.isdir(d) else []
            if a.upstream_fix and items:
                fixed = set(fix_upstream(None, d, items))
                items = [dict(it, fixed=it['name'] in fixed) for it in items]
            res[d] = items
        print(json.dumps(res, ensure_ascii=False))
        return 0
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
    guard = guard_state(ph) if ph.root else None
    if guard and guard['restoring']:
        msg = '手机上的 TT 守护正在恢复备份，这次不同步（恢复完再来）'
        print(f'✗ {msg}。什么都没改。')
        if a.plan_json:
            atomic_write(a.plan_json, json.dumps({'ok': False, 'error': msg}, ensure_ascii=False).encode('utf-8'))
        return 2
    if a.ext_only:
        report = []
        todo = plan_extensions(ph, a.ext_dir, a.ext_force, report) if os.path.isdir(a.ext_dir) else []
        if not a.dry_run:   # 以前推完留在 .cm-previous 的旧副本：收进存档
            archive_previous(ph, [r['name'] for r in report if r['decision'] == 'same'], a.backups)
        if not todo:
            print('  扩展：没有要推的')
            return 0
        if a.dry_run:
            return 0
        failed = push_extensions(ph, todo, a.backups)
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
    choices = {}
    if a.choices:
        try:
            with open(a.choices, encoding='utf-8') as f:
                choices = json.load(f)
        except (OSError, ValueError) as e:
            print(f'✗ 读不了选择文件（{e}）。什么都没改。')
            return 2
    fc = choices.get('files') or {}
    newer = {r: ('local' if r in push else 'remote') for r in conflicts}
    for rel in conflicts:   # 你选了以哪边为准：换方向
        c = fc.get(rel)
        if c == 'local' and rel in pull:
            pull.remove(rel)
            push.append(rel)
        elif c == 'remote' and rel in push:
            push.remove(rel)
            pull.append(rel)
    print(f'  {LOCAL} {len(loc)} 个文件，{side} {len(rem)} 个文件')
    print(f'  → {side}：{len(push)} 个    ← {LOCAL}：{len(pull)} 个    两边都改过 / 没有记录：{len(conflicts)} 个')
    show(push, '→')
    show(pull, '←')
    for rel in conflicts[:20]:
        c = fc.get(rel)
        how = {'local': f'按你选的用{LOCAL}的', 'remote': f'按你选的用{side}的', 'both': '两份都留'}.get(c, '用较新的一份')
        print(f'  ! {"两边都改过" if rel in state else "没有同步记录、两边不一样"}，{how}（{LOCAL if rel in push else side}），另一份进备份：{rel}')
    if len(conflicts) > 20:
        print(f'  ! … 另 {len(conflicts) - 20} 个同样处理')
    for rel in clashes:
        print(f'  ! 文件名只差大小写，两边会互相覆盖，没动（请改名）：{rel}')
    ext_todo, ext_report = [], []
    if a.ext_dir and os.path.isdir(a.ext_dir):
        ext_todo = plan_extensions(ph, a.ext_dir, a.ext_force, ext_report)
        if not ext_todo:
            print(f'  扩展：没有要推的')
    upstream = []
    if a.ext_dir and os.path.isdir(a.ext_dir) and not a.push_only:
        upstream = [dict(u, side='local') for u in ext_upstream(None, a.ext_dir)] + \
                   [dict(u, side='remote') for u in ext_upstream(ph, remote_ext_dir(ph))]
        for u in upstream:
            print(f'  ! 扩展 {u["name"]}（{LOCAL if u["side"] == "local" else side}）：分支 {u["branch"]} 没设上游，TT 查更新会报错'
                  + (f'（可以设成跟 origin/{u["target"]}）' if u['target'] else '（没有 origin，没法自动设）'))

    if a.plan_json:
        return write_plan(a, ph, state, loc, rem, push, pull, conflicts, clashes, newer, ext_todo, ext_report, upstream, guard)

    decided = {r for r in conflicts if fc.get(r) in ('local', 'remote')}
    try:
        copies = chat_conflict_copies(ph, a.st, [r for r in conflicts if r not in decided], push, loc, rem,
                                      write=not a.dry_run, force={r for r in conflicts if fc.get(r) == 'both'})
    except (SyncError, OSError) as e:
        print(f'✗ 比较冲突的聊天记录时出错（{e}）。什么都没改。')
        return 2
    for rel, name, n in copies:
        more = f'输的那份多出 {n} 楼，' if n else '按你选的两份都留，'
        print(f'  ! 两边各自改过：{os.path.basename(rel)} {more}'
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
        api_todo = a.exit_if_nothing and not a.push_only and api_diff(ph, a.st, a.port)[0] \
            or a.exit_if_nothing and not a.push_only and secrets_diff(ph, a.st)[0]
        if a.exit_if_nothing and not (push or pull or conflicts or copies or ext_todo or tags_todo or api_todo):
            print('  两边已经一样，没有要同步的')
            return 3
        return 0

    if guard and guard['pending'] and not choices.get('pendingOk'):
        print('✗ 手机上次从备份恢复没做完（TT 守护留了 restore.pending）：数据可能不完整，这次不同步。')
        print('  先在手机 KernelSU → 模块 → TT 守护 里重新恢复；确定没问题的话在酒馆工具「同步手机」里选继续。')
        return 2
    snapshot = 'none'
    if guard is not None and (push or ext_todo or conflicts or choices.get('api') == 'local'
                              or choices.get('secrets') == 'merge' or choices.get('extUpstream')):
        if guard['module']:
            ok, msg = guard_snapshot(ph)
            snapshot = f'ok {msg}' if ok else f'failed {msg}'
            print(f'  ✓ TT 守护先存了一份快照：{msg}' if ok else
                  f'  ! TT 守护的快照没做成（{msg}），继续：被覆盖的文件照样先备份到电脑')
        else:
            print('  · 手机上没装 TT 守护，没做快照（被覆盖的文件照样先备份到电脑）')
    bk = os.path.join(a.backups, time.strftime('%Y-%m-%d'), f"{time.strftime('%H%M%S')}-{side}同步前")
    fixed_up = []
    if upstream and choices.get('extUpstream'):   # 先改电脑上的源：随后推过去的 .git 也是改好的
        for sd, root, p_ in (('local', a.ext_dir, None), ('remote', remote_ext_dir(ph), ph)):
            fixed_up += fix_upstream(p_, root, [u for u in upstream if u['side'] == sd])
        if fixed_up:
            print(f'  ✓ 扩展的上游设好了：{"、".join(sorted(set(fixed_up)))}')
    failed = run_sync(ph, a.st, push, pull, loc, rem, bk)
    ext_failed = push_extensions(ph, ext_todo, a.backups) if ext_todo else []
    archive_previous(ph, [r['name'] for r in ext_report if r['decision'] == 'same'], a.backups)

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

    notes, deferred = [], []
    res = {'push': {'total': len(push)}, 'pull': {'total': len(pull)}, 'copies': [n for _, n, _ in copies],
           'ext': {'total': len(ext_todo), 'failed': ext_failed}, 'tags': None, 'api': None, 'secrets': None,
           'endpoint': None, 'backups': bk, 'verified': rem2 is not None, 'upstreamFixed': sorted(set(fixed_up)),
           'snapshot': snapshot}
    if rem2 is not None:
        text, errs = sync_tags(ph, a.st, bk, loc2, rem2, a.push_only)
        for e in errs:
            print(f'  ✗ {e}')
        if errs:
            notes.append('标签没同步成')
        elif text:
            print(f'  ✓ {text}')
            res['tags'] = text
    if a.settings and isinstance(ph, LocalTT):
        ch = copy_settings(ph, a.st, bk)
        print(f'  ✓ 扩展设置和对话补全设置已复制到{side}（旧的备份在 {bk}）' if ch else f'  扩展设置：{side}上已是最新')
    if rem2 is not None and not a.push_only:
        why = '你选了跳过' if a.choices else '要你选，在酒馆工具「同步手机」里选'
        want = choices.get('api')
        if want in ('local', 'remote'):
            text, errs = sync_api(ph, a.st, a.port, bk, want)
            for e in errs:
                print(f'  ✗ API 和预设设置没同步：{e}')
            if errs:
                notes.append('API 设置没同步')
            elif text:
                print(f'  ✓ API 和预设设置 {text}')
                res['api'] = text
        elif api_diff(ph, a.st, a.port)[0]:
            deferred.append(f'API 和预设设置两边不一样，没动（{why}）')
        if choices.get('secrets') == 'merge':
            text, errs = sync_secrets(ph, a.st, bk)
            for e in errs:
                print(f'  ✗ API 密钥没同步：{e}')
            if errs:
                notes.append('API 密钥没同步')
            elif text:
                print(f'  ✓ API 密钥：{text}（不显示内容）')
                res['secrets'] = text
        elif secrets_diff(ph, a.st)[0]:
            deferred.append(f'API 密钥两边不一样，没动（{why}）')
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
            res['endpoint'] = f'http://{a.mac_ip}:{a.port}/v1'
    if upstream and not choices.get('extUpstream'):
        deferred.append(f'{len(upstream)} 个扩展的分支没设上游，没动（{"你选了跳过" if a.choices else "要你选"}）')
    for d in deferred:
        print(f'  · 待你选：{d}')

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
    if a.result_json:
        res['push']['done'], res['pull']['done'] = n_push, n_pull
        res.update(missing=sorted(missing), notes=notes, deferred=deferred)
        atomic_write(a.result_json, json.dumps(res, ensure_ascii=False).encode('utf-8'))
    return 1 if (missing or notes) else 0


def write_plan(a, ph, state, loc, rem, push, pull, conflicts, clashes, newer, ext_todo, ext_report, upstream=(), guard=None):
    """--plan-json：按「自动 / 要你选 / 跳过」分好组写成 JSON，什么都不改。"""
    side = ph.label
    try:
        info = chat_conflict_info(ph, a.st, [r for r in conflicts if is_chat(r)])
    except (SyncError, OSError) as e:
        print(f'✗ 比较冲突的聊天记录时出错（{e}）。什么都没改。')
        return 2
    text, errs = sync_tags(ph, a.st, None, set(loc) | set(pull), set(rem) | set(push), a.push_only, dry=True)
    tags_todo = bool(re.search(r'[1-9]\d* 个', text or ''))
    api, api_errs = (None, []) if a.push_only else api_diff(ph, a.st, a.port)
    sec, sec_errs = (None, []) if a.push_only else secrets_diff(ph, a.st)
    conf = set(conflicts)
    ask_chats, ask_files = [], []
    for rel in conflicts:
        item = {'rel': rel, 'newer': newer[rel], 'first': rel not in state,
                'mtime': {'local': loc[rel][0], 'remote': rem[rel][0]}}
        if is_chat(rel):
            item['extra'] = info.get(rel, {'local': 0, 'remote': 0})
            ask_chats.append(item)
        else:
            ask_files.append(item)
    skip = [{'what': rel, 'why': '文件名只差大小写，两边会互相覆盖（请改名）'} for rel in clashes]
    why_ext = {'newer': f'{side}上的版本比{LOCAL}新', 'unknown': f'{side}上的版本{LOCAL}没有（多半在{side}上更新过）',
               'diverged': '两边版本分叉', 'unreadable': f'读不到{side}上的版本'}
    skip += [{'what': f'扩展 {r["name"]}', 'why': why_ext[r['decision']]} for r in ext_report if r['decision'] in why_ext]
    skip += [{'what': '（文件）', 'why': w} for w in WARNINGS]
    skip += [{'what': f'扩展 {u["name"]}', 'why': f'分支 {u["branch"]} 没设上游，也没有 origin'} for u in upstream if not u['target']]
    skip += [{'what': '标签', 'why': e} for e in errs] + [{'what': 'API 设置', 'why': e} for e in api_errs] \
        + [{'what': 'API 密钥', 'why': e} for e in sec_errs]
    out = {
        'ok': True, 'local': LOCAL, 'remote': side, 'counts': {'local': len(loc), 'remote': len(rem)},
        'firstSync': not state, 'guard': guard,
        'auto': {'push': [r for r in push if r not in conf], 'pull': [r for r in pull if r not in conf],
                 'ext': [n for n, _, _ in ext_todo], 'tags': text if tags_todo else None},
        'ask': {'chats': ask_chats, 'files': ask_files, 'api': api, 'secrets': sec,
                'upstream': [u for u in upstream if u['target']]},
        'skip': skip,
    }
    out['nothing'] = not (out['auto']['push'] or out['auto']['pull'] or out['auto']['ext'] or tags_todo
                          or conflicts or api or sec or out['ask']['upstream'])
    atomic_write(a.plan_json, json.dumps(out, ensure_ascii=False).encode('utf-8'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
