#!/usr/bin/env python3
"""phone_sync.py 的测试：用一个假的 adb（在临时文件夹里执行手机那边的 shell 命令），不碰真手机、不碰真数据。

  npm run test:py（或 python3 -m unittest discover -s test/launcher）
"""
import io, json, os, shutil, stat, subprocess, sys, tarfile, tempfile, textwrap, time, unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'launcher'))
import phone_sync as ps  # noqa: E402

FAKE_ADB = r'''#!/usr/bin/env python3
import os, shutil, subprocess, sys
a = sys.argv[1:]
if a[:1] == ['-s']:
    a = a[2:]
env = os.environ
if a[0] == 'get-state':
    st = env.get('FAKE_STATE', 'device')
    print(st) if st == 'device' else sys.stderr.write(f'error: device {st}\n')
    sys.exit(0 if st == 'device' else 1)
if a[0] == 'push':
    if env.get('FAKE_PUSH_FAIL'):
        sys.exit(1)
    shutil.copyfile(a[1], a[2]); sys.exit(0)
if a[0] == 'pull':
    if env.get('FAKE_PULL_FAIL'):
        sys.exit(1)
    shutil.copyfile(a[1], a[2]); sys.exit(0)
if a[0] == 'shell':
    cmd = a[1]
    flag = env.get('FAKE_TRUNCATE_FILE')
    r = subprocess.run(['sh', '-c', cmd], capture_output=True)
    out = r.stdout
    if flag and os.path.exists(flag) and b'CM_END' in out and b'stat -c' in cmd.encode():
        out = out.split(b'\n')[0] + b'\n'   # 连接中断：只收到第一行
    sys.stdout.buffer.write(out); sys.stderr.buffer.write(r.stderr)
    sys.exit(r.returncode)
sys.exit(2)
'''

FAKE_SU = r'''#!/bin/sh
# su -c CMD
[ "$1" = "-c" ] && shift
[ "$1" = "id" ] && { echo "uid=0(root) gid=0(root)"; exit 0; }
exec sh -c "$1"
'''

FAKE_STAT = r'''#!/usr/bin/env python3
# GNU stat -c 的最小替身（%Y %s %n %u %g）
import os, sys
a = sys.argv[1:]
fmt = a[a.index('-c') + 1]
files = [x for i, x in enumerate(a) if x != '-c' and (i == 0 or a[i - 1] != '-c')]
rc = 0
for f in files:
    try:
        s = os.stat(f)
    except OSError as e:
        sys.stderr.write(f'stat: {f}: {e}\n'); rc = 1; continue
    print(fmt.replace('%Y', str(int(s.st_mtime))).replace('%s', str(s.st_size)).replace('%n', f)
             .replace('%u', str(s.st_uid)).replace('%g', str(s.st_gid)))
sys.exit(rc)
'''


def write(p, text, mtime=None):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(text)
    if mtime:
        os.utime(p, (mtime, mtime))


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


class Env:
    """临时的「电脑酒馆」「手机 TT」「假 adb」。"""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix='cm-test-')
        self.st = os.path.join(self.root, 'st', 'default-user')
        self.phone_data = os.path.join(self.root, 'phone', 'data')
        self.phone = os.path.join(self.phone_data, 'default-user')
        self.tmp = os.path.join(self.root, 'phone-tmp')
        self.bin = os.path.join(self.root, 'bin')
        self.state = os.path.join(self.root, 'state.json')
        self.backups = os.path.join(self.root, 'backups')
        for d in (self.st, self.phone, self.tmp, self.bin):
            os.makedirs(d, exist_ok=True)
        for name, body in (('adb', FAKE_ADB), ('su', FAKE_SU), ('stat', FAKE_STAT)):
            p = os.path.join(self.bin, name)
            write(p, body)
            os.chmod(p, 0o755)
        self.adb = os.path.join(self.bin, 'adb')
        self._env = {k: os.environ.get(k) for k in ('PATH', 'FAKE_STATE', 'FAKE_PUSH_FAIL', 'FAKE_PULL_FAIL', 'FAKE_TRUNCATE_FILE')}
        os.environ['PATH'] = self.bin + os.pathsep + os.environ['PATH']
        self._roots, self._tmp = ps.REMOTE_ROOTS, ps.Phone.tmp
        ps.REMOTE_ROOTS = [self.phone]
        tmpdir = self.tmp

        def tmp(ph, what):
            ph.n += 1
            return f'{tmpdir}/{ph.tag}_{ph.n}_{what}'
        ps.Phone.tmp = tmp
        ps.WARNINGS.clear()

    def close(self):
        ps.REMOTE_ROOTS, ps.Phone.tmp = self._roots, self._tmp
        for k, v in self._env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.root, ignore_errors=True)

    def sync(self, *extra):
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = ps.main(['--st', self.st, '--adb', self.adb, '--serial', 'FAKE', '--state', self.state,
                          '--backups', self.backups, *extra])
        return rc, buf.getvalue()


class PlanTests(unittest.TestCase):
    def test_no_state_differences_are_conflicts(self):
        push, pull, conf, clash = ps.plan({'a': (100, 5), 'b': (100, 5)}, {'a': (200, 6), 'b': (100, 5)}, {})
        self.assertEqual((push, pull, conf), ([], ['a'], ['a']))

    def test_state_decides_direction(self):
        S = {'a': {'l': [100, 5], 'r': [100, 5]}}
        self.assertEqual(ps.plan({'a': (300, 7)}, {'a': (100, 5)}, S)[:3], (['a'], [], []))
        self.assertEqual(ps.plan({'a': (100, 5)}, {'a': (50, 9)}, S)[:3], ([], ['a'], []))
        push, pull, conf, _ = ps.plan({'a': (300, 7)}, {'a': (400, 9)}, S)
        self.assertEqual((push, pull, conf), ([], ['a'], ['a']))

    def test_case_clash_left_alone(self):
        push, pull, conf, clash = ps.plan({'chats/A/x.jsonl': (1, 1), 'chats/b': (1, 1)}, {'chats/a/x.jsonl': (1, 1)}, {})
        self.assertEqual(clash, ['chats/A/x.jsonl', 'chats/a/x.jsonl'])
        self.assertEqual(push, ['chats/b'])
        self.assertEqual(pull, [])

    def test_listing_needs_end_marker(self):
        ok = b'1 2 chats/a\n3 4 chats/b\nCM_END 0\n'
        self.assertEqual(ps.parse_listing(ok), {'chats/a': (1, 2), 'chats/b': (3, 4)})
        with self.assertRaises(ps.SyncError):
            ps.parse_listing(b'1 2 chats/a\n')
        with self.assertRaises(ps.SyncError):
            ps.parse_listing(b'1 2 chats/a\nCM_END 1\n')

    def test_listing_skips_non_utf8(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            got = ps.parse_listing(b'1 2 chats/\xff\xfe.jsonl\n1 2 chats/ok\nCM_END 0\n')
        self.assertEqual(list(got), ['chats/ok'])
        self.assertIn('不是 UTF-8', buf.getvalue())

    def test_shrink_guard(self):
        state = {f'chats/{i}': {} for i in range(100)}
        self.assertEqual(ps.listing_shrunk(state, {f'chats/{i}': 1 for i in range(90)}), 0)
        self.assertEqual(ps.listing_shrunk(state, {f'chats/{i}': 1 for i in range(10)}), 90)

    def test_ext_decision(self):
        anc = {('old', 'new'), ('new', 'newer')}
        known = lambda p: p in ('old', 'new', 'newer')  # noqa: E731
        is_anc = lambda a, b: (a, b) in anc  # noqa: E731
        st = lambda **k: {'exists': True, 'marker': None, 'rev': None, **k}  # noqa: E731
        self.assertEqual(ps.ext_decision('new', st(exists=False), known, is_anc), 'push')
        self.assertEqual(ps.ext_decision('new', st(rev='old'), known, is_anc), 'push')
        self.assertEqual(ps.ext_decision('new', st(rev='newer'), known, is_anc), 'newer')
        self.assertEqual(ps.ext_decision('new', st(rev='zzz'), known, is_anc), 'unknown')
        self.assertEqual(ps.ext_decision('new', st(rev='zzz'), known, is_anc, force=True), 'push')
        self.assertEqual(ps.ext_decision('new', st(rev='new'), known, is_anc), 'push')   # 旧打包方式：补推一次
        self.assertEqual(ps.ext_decision('new', st(rev='new', marker=f'new {ps.PACKER}'), known, is_anc), 'same')

    def test_git_state_parsing(self):
        sha, sha2 = 'a' * 40, 'b' * 40
        txt = f'E:1\nM:\nH:ref: refs/heads/main\nL:\nP:{sha2} refs/heads/main\nCM_END\n'
        self.assertEqual(ps.parse_git_state(txt)['rev'], sha2)
        txt = f'E:1\nM:\nH:ref: refs/heads/main\nL:{sha}\nP:{sha2} refs/heads/main\nCM_END\n'
        self.assertEqual(ps.parse_git_state(txt)['rev'], sha)
        self.assertIsNone(ps.parse_git_state('E:1\nH:'))

    def test_merge_state_keeps_failed(self):
        old = {'a': {'l': [1, 1], 'r': [1, 1]}, 'b': {'l': [1, 1], 'r': [1, 1]}}
        loc, rem = {'a': (5, 2), 'b': (5, 2)}, {'a': (1, 1), 'b': (9, 9)}
        new = ps.merge_state(old, loc, rem, touched={'a', 'b'}, failed={'a'})
        self.assertEqual(set(new), {'a'})


class LocalFileTests(unittest.TestCase):
    def test_extract_atomic_and_readonly(self):
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, 'x', 'f')
            write(p, 'old')
            os.chmod(p, 0o444)
            data, got = ps.tar_bytes(d, ['x/f'])
            write(os.path.join(d, 'src', 'x', 'f'), 'new', mtime=1000000)
            data, _ = ps.tar_bytes(os.path.join(d, 'src'), ['x/f'])
            self.assertEqual(ps.extract(data, d), {'x/f'})
            self.assertEqual(read(p), 'new')
            self.assertEqual(int(os.stat(p).st_mtime), 1000000)
            self.assertEqual([f for f in os.listdir(os.path.join(d, 'x')) if f.startswith('.cm-')], [])
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_bad_tar_is_nice_error(self):
        with self.assertRaises(ps.SyncError):
            ps.extract(b'not a tar' * 100, tempfile.gettempdir())


class PhoneSyncTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()

    def tearDown(self):
        self.e.close()

    def test_two_way_sync_backups_and_state(self):
        e = self.e
        write(f'{e.st}/chats/A/one.jsonl', 'mac one', 1_700_000_000)
        write(f'{e.st}/worlds/w.json', 'mac world', 1_700_000_000)
        write(f'{e.phone}/chats/A/two.jsonl', 'phone two', 1_700_000_000)
        write(f'{e.phone}/worlds/w.json', 'phone world newer', 1_700_000_500)
        write(f'{e.st}/chats/B/space name.jsonl', 'mac spaced', 1_700_000_000)
        rc, out = e.sync()
        self.assertEqual(rc, 0, out)
        self.assertIn('✓ 同步完成', out)
        self.assertIn('没有同步记录、两边不一样', out)   # 第一次同步：不一样的列出来
        self.assertEqual(read(f'{e.phone}/chats/A/one.jsonl'), 'mac one')
        self.assertEqual(read(f'{e.phone}/chats/B/space name.jsonl'), 'mac spaced')
        self.assertEqual(read(f'{e.st}/chats/A/two.jsonl'), 'phone two')
        self.assertEqual(read(f'{e.st}/worlds/w.json'), 'phone world newer')
        self.assertEqual(int(os.stat(f'{e.phone}/chats/A/one.jsonl').st_mtime), 1_700_000_000)
        bk = [os.path.join(dp, f) for dp, _, fs in os.walk(e.backups) for f in fs]
        self.assertTrue(any(p.endswith('电脑/worlds/w.json') for p in bk), bk)
        state = json.loads(read(e.state))
        self.assertEqual(set(state), {'chats/A/one.jsonl', 'chats/A/two.jsonl', 'worlds/w.json', 'chats/B/space name.jsonl'})
        self.assertEqual(os.listdir(e.tmp), [])   # 手机上的临时文件都清掉了
        self.assertEqual([f for f in os.listdir(e.phone) if f.startswith('.cm')], [])
        # 第二次：没事可做
        rc, out = e.sync()
        self.assertIn('→ 手机：0 个    ← 电脑：0 个', out)

    def test_push_overwrite_backs_up_phone_copy(self):
        e = self.e
        write(f'{e.st}/chats/A/one.jsonl', 'v1', 1_700_000_000)
        e.sync()
        write(f'{e.st}/chats/A/one.jsonl', 'v2 longer', 1_700_001_000)
        rc, out = e.sync()
        self.assertEqual(rc, 0, out)
        self.assertEqual(read(f'{e.phone}/chats/A/one.jsonl'), 'v2 longer')
        bk = [os.path.join(dp, f) for dp, _, fs in os.walk(e.backups) for f in fs]
        self.assertTrue(any(p.endswith('手机/chats/A/one.jsonl') and read(p) == 'v1' for p in bk), bk)

    def test_truncated_listing_changes_nothing(self):
        e = self.e
        write(f'{e.st}/chats/A/one.jsonl', 'mac', 1_700_000_000)
        write(f'{e.phone}/chats/A/one.jsonl', 'phone', 1_700_000_900)
        write(f'{e.phone}/chats/A/two.jsonl', 'phone2', 1_700_000_900)
        flag = os.path.join(e.root, 'trunc')
        write(flag, '1')
        os.environ['FAKE_TRUNCATE_FILE'] = flag
        rc, out = e.sync()
        self.assertEqual(rc, 2, out)
        self.assertIn('不完整', out)
        self.assertEqual(read(f'{e.st}/chats/A/one.jsonl'), 'mac')
        self.assertFalse(os.path.exists(e.state))

    def test_relist_failure_keeps_old_state(self):
        e = self.e
        write(f'{e.st}/chats/A/one.jsonl', 'mac', 1_700_000_000)
        e.sync()
        before = read(e.state)
        write(f'{e.st}/chats/A/new.jsonl', 'new', 1_700_000_000)
        flag = os.path.join(e.root, 'trunc')
        orig = ps.remote_files
        calls = []

        def flaky(ph):
            calls.append(1)
            if len(calls) == 2:   # 同步后的核对：连接断了
                write(flag, '1')
            try:
                return orig(ph)
            finally:
                if os.path.exists(flag):
                    os.unlink(flag)
        os.environ['FAKE_TRUNCATE_FILE'] = flag
        ps.remote_files = flaky
        try:
            rc, out = e.sync()
        finally:
            ps.remote_files = orig
        self.assertEqual(rc, 1, out)
        self.assertIn('不更新同步记录', out)
        self.assertIn('✗ 同步没全部完成', out)
        self.assertEqual(read(e.state), before)

    def test_shrunk_listing_refused(self):
        e = self.e
        for i in range(30):
            write(f'{e.st}/chats/A/{i}.jsonl', str(i), 1_700_000_000)
        e.sync()
        for i in range(20):
            os.unlink(f'{e.phone}/chats/A/{i}.jsonl')
        rc, out = e.sync()
        self.assertEqual(rc, 2)
        self.assertIn('--trust-listing', out)
        rc, out = e.sync('--trust-listing')
        self.assertEqual(rc, 0, out)
        self.assertTrue(os.path.exists(f'{e.phone}/chats/A/3.jsonl'))

    def test_pull_failure_headline(self):
        e = self.e
        write(f'{e.phone}/chats/A/p.jsonl', 'phone', 1_700_000_000)
        os.environ['FAKE_PULL_FAIL'] = '1'
        rc, out = e.sync()
        self.assertEqual(rc, 1)
        self.assertNotIn('✓ 同步完成', out)
        self.assertIn('✗ 同步失败', out)
        self.assertEqual(os.listdir(e.tmp), [])

    def test_offline_phone_is_reported(self):
        os.environ['FAKE_STATE'] = 'unauthorized'
        rc, out = self.e.sync()
        self.assertEqual(rc, 2)
        self.assertIn('连不上手机', out)
        self.assertNotIn('找不到 TauriTavern 的数据', out)

    def test_case_clash_not_synced(self):
        e = self.e
        write(f'{e.st}/chats/Alice/x.jsonl', 'mac', 1_700_000_000)
        os.makedirs(f'{e.phone}/chats', exist_ok=True)
        # 真机是 casefold 的 ext4：这里用 Mac 的临时目录（不分大小写）没法放两个，只看计划
        push, pull, conf, clash = ps.plan({'chats/Alice/x.jsonl': (1, 3)}, {'chats/alice/x.jsonl': (1, 5)}, {})
        self.assertEqual((push, pull), ([], []))
        self.assertEqual(len(clash), 2)

    def test_fix_endpoint_backup_and_truncation(self):
        e = self.e
        write(f'{e.phone}/settings.json', json.dumps({'oai_settings': {'reverse_proxy': 'http://10.0.0.1:8901/v1'},
                                                      'extension_settings': {'claude_max': {'accessKey': 'old'}}}))
        key = os.path.join(e.root, 'key')
        write(key, 'k2')
        rc, out = e.sync('--mac-ip', '192.168.1.5', '--lan-key-file', key)
        self.assertEqual(rc, 0, out)
        d = json.loads(read(f'{e.phone}/settings.json'))
        self.assertEqual(d['oai_settings']['reverse_proxy'], 'http://192.168.1.5:8901/v1')
        self.assertEqual(d['extension_settings']['claude_max']['accessKey'], 'k2')
        bk = [os.path.join(dp, f) for dp, _, fs in os.walk(e.backups) for f in fs]
        self.assertTrue(any(p.endswith('手机/settings.json') and '10.0.0.1' in read(p) for p in bk), bk)
        # 读不全（没有结束标记）→ 不写
        ph = ps.Phone(e.adb, 'FAKE')
        orig = ph.rsh_bytes
        ph.rsh_bytes = lambda cmd: orig(cmd).replace(b'\nCM_END\n', b'')
        write(f'{e.phone}/settings.json', json.dumps({'oai_settings': {'reverse_proxy': 'http://10.0.0.9:8901/v1'}}))
        ch, errs = ps.fix_endpoint(ph, '192.168.1.5', 8901, None, os.path.join(e.root, 'bk2'))
        self.assertEqual(ch, [])
        self.assertTrue(errs)
        self.assertIn('10.0.0.9', read(f'{e.phone}/settings.json'))

    def _git_ext(self, name):
        src = os.path.join(self.e.root, 'ext', name)
        write(f'{src}/index.js', 'v1')
        write(f'{src}/modules/story/data/store.js', 'nested data')
        write(f'{src}/data/private.json', 'top-level runtime data')
        write(f'{src}/.gitignore', '/data/\nnode_modules/\n')
        write(f'{src}/node_modules/x/i.js', 'dep')
        env = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'}
        for args in (['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'one']):
            subprocess.run(['git', '-C', src, *args], check=True, env=env, capture_output=True)
        return src, env

    def test_extensions_push_nested_data_and_swap(self):
        e = self.e
        src, env = self._git_ext('Ext')
        ext_dir = os.path.dirname(src)
        rext = os.path.join(e.phone_data, 'extensions', 'third-party')
        # 手机上已有一个同名旧版本：有过时的文件、有自己的 node_modules
        write(f'{rext}/Ext/stale.js', 'old file')
        write(f'{rext}/Ext/node_modules/y/i.js', 'phone dep')
        rc, out = e.sync('--ext-dir', ext_dir)
        self.assertEqual(rc, 0, out)
        self.assertIn('扩展 → 手机：Ext', out)
        self.assertEqual(read(f'{rext}/Ext/modules/story/data/store.js'), 'nested data')
        self.assertFalse(os.path.exists(f'{rext}/Ext/data/private.json'))
        self.assertFalse(os.path.exists(f'{rext}/Ext/stale.js'))
        self.assertTrue(os.path.exists(f'{rext}/Ext/node_modules/y/i.js'))   # 手机原有的依赖带过来
        # 换下来的旧文件夹不留在 extensions 里，收进 data/_cm_archive/<日期>-扩展旧副本/
        self.assertFalse(os.path.exists(os.path.join(e.phone_data, 'extensions', '.cm-previous', 'Ext')))
        arch = os.path.join(e.phone_data, '_cm_archive')
        self.assertEqual([os.path.exists(os.path.join(arch, d, 'Ext', 'stale.js')) for d in os.listdir(arch)], [True])
        rev = ps.local_rev(src)
        self.assertEqual(read(f'{rext}/Ext/.git/cm-pushed').split(), [rev, ps.PACKER])
        # 第二次：一样，不推
        rc, out = e.sync('--ext-dir', ext_dir)
        self.assertNotIn('扩展 → 手机', out)
        # 手机上更新过（电脑没有这个提交）→ 不推
        subprocess.run(['git', '-C', f'{rext}/Ext', 'commit', '-q', '--allow-empty', '-m', 'phone'], check=True, env=env, capture_output=True)
        rc, out = e.sync('--ext-dir', ext_dir)
        self.assertIn('电脑上没有', out)
        self.assertNotIn('扩展 → 手机', out)
        # 电脑有新提交、手机是旧的 → 推
        subprocess.run(['git', '-C', f'{rext}/Ext', 'reset', '-q', '--hard', rev], check=True, capture_output=True)
        write(f'{src}/index.js', 'v2')
        subprocess.run(['git', '-C', src, 'commit', '-qam', 'two'], check=True, env=env, capture_output=True)
        rc, out = e.sync('--ext-dir', ext_dir)
        self.assertIn('扩展 → 手机：Ext', out)
        self.assertEqual(read(f'{rext}/Ext/index.js'), 'v2')
        # 每个扩展只留最新的一份存档
        found = [dp for dp, ds, _ in os.walk(arch) if os.path.basename(dp) == 'Ext']
        self.assertEqual(len(found), 1, found)
        self.assertEqual(read(os.path.join(found[0], 'index.js')), 'v1')

    def test_leftover_previous_copy_is_archived(self):
        e = self.e
        src, env = self._git_ext('Ext')
        e.sync('--ext-dir', os.path.dirname(src))
        write(os.path.join(e.phone_data, 'extensions', '.cm-previous', 'Ext', 'old.js'), 'left by 3.3')
        rc, out = e.sync('--ext-dir', os.path.dirname(src))
        self.assertEqual(rc, 0, out)
        self.assertFalse(os.path.exists(os.path.join(e.phone_data, 'extensions', '.cm-previous', 'Ext')))
        self.assertIn('收进了存档', out)

    def test_branch_without_upstream_is_reported_and_fixed_on_request(self):
        e = self.e
        src, env = self._git_ext('Ext')
        g = lambda *a: subprocess.run(['git', '-C', src, *a], check=True, env=env, capture_output=True, text=True).stdout  # noqa: E731
        g('remote', 'add', 'origin', 'https://example.invalid/ext.git')
        g('update-ref', 'refs/remotes/origin/main', 'HEAD')
        g('checkout', '-q', '-b', 'local/cache-friendly-order')
        ext_dir = os.path.dirname(src)
        self.assertEqual(ps.ext_upstream(None, ext_dir), [{'name': 'Ext', 'branch': 'local/cache-friendly-order', 'target': 'main'}])
        f = os.path.join(e.root, 'plan.json')
        rc, out = e.sync('--ext-dir', ext_dir, '--plan-json', f)
        up = json.loads(read(f))['ask']['upstream']
        self.assertEqual({u['side'] for u in up}, {'local'})   # 手机上还没有这个扩展
        # 不问问题的同步：只推，不改上游；推过去的手机副本同样没上游
        rc, out = e.sync('--ext-dir', ext_dir)
        self.assertIn('没设上游', out)
        rext = os.path.join(e.phone_data, 'extensions', 'third-party')
        self.assertEqual([u['name'] for u in ps.ext_upstream(ps.Phone(e.adb, 'FAKE'), rext)], ['Ext'])
        cf = os.path.join(e.root, 'c.json')
        write(cf, json.dumps({'extUpstream': True}))
        rc, out = e.sync('--ext-dir', ext_dir, '--choices', cf)
        self.assertEqual(rc, 0, out)
        self.assertEqual(g('config', '--get', 'branch.local/cache-friendly-order.merge').strip(), 'refs/heads/main')
        self.assertEqual(ps.ext_upstream(ps.Phone(e.adb, 'FAKE'), rext), [])
        self.assertEqual(ps.ext_upstream(None, ext_dir), [])
        self.assertEqual(g('rev-parse', 'HEAD'), g('rev-parse', 'origin/main'))   # 历史没动
        buf = io.StringIO()
        with redirect_stdout(buf):
            ps.main(['--upstream-check', ext_dir])
        self.assertEqual(json.loads(buf.getvalue()), {ext_dir: []})

    def test_extension_old_marker_repushed_once(self):
        e = self.e
        src, env = self._git_ext('Ext')
        rext = os.path.join(e.phone_data, 'extensions', 'third-party')
        e.sync('--ext-dir', os.path.dirname(src))
        os.unlink(f'{rext}/Ext/.git/cm-pushed')        # 旧版本推的：没有标记、缺 data 子目录
        shutil.rmtree(f'{rext}/Ext/modules/story/data')
        rc, out = e.sync('--ext-dir', os.path.dirname(src))
        self.assertIn('按新的打包方式补推一次', out)
        self.assertTrue(os.path.exists(f'{rext}/Ext/modules/story/data/store.js'))


def settings_with(tags):
    """{卡: [标签名]} → 酒馆 settings.json 的 tags / tag_map（id 每边随机，像真的一样）。"""
    d = {'power_user': {}, 'tags': [], 'tag_map': {}}
    ps.add_tags(d, {av: set(names) for av, names in tags.items()})
    return json.dumps(d, ensure_ascii=False)


class TagTests(unittest.TestCase):
    def test_add_tags_reuses_by_name_and_is_idempotent(self):
        d = json.loads(settings_with({'a.png': ['都市']}))
        tid = d['tags'][0]['id']
        self.assertEqual(ps.add_tags(d, {'a.png': {'都市', '酒馆助手'}, 'b.png': {'都市'}}),
                         [('a.png', '酒馆助手'), ('b.png', '都市')])
        self.assertEqual([t['name'] for t in d['tags']], ['都市', '酒馆助手'])
        self.assertIn(tid, d['tag_map']['b.png'])
        self.assertEqual(ps.add_tags(d, {'a.png': {'都市'}}), [])
        self.assertEqual(ps.card_tags(d), {'a.png': {'都市', '酒馆助手'}, 'b.png': {'都市'}})

    def test_plan_only_for_cards_that_side_has(self):
        loc = json.loads(settings_with({'a.png': ['x'], 'only_mac.png': ['y']}))
        rem = json.loads(settings_with({'a.png': ['z']}))
        to_rem, to_loc = ps.plan_tags(loc, rem, {'a.png', 'only_mac.png'}, {'a.png'})
        self.assertEqual((to_rem, to_loc), ({'a.png': {'x'}}, {'a.png': {'z'}}))
        self.assertEqual(ps.plan_tags(loc, rem, {'a.png'}, {'a.png'}, push_only=True)[1], {})

    def test_sync_merges_tags_both_ways_with_backup(self):
        e = Env()
        try:
            write(f'{e.st}/characters/a.png', 'A', 1_700_000_000)
            write(f'{e.phone}/characters/b.png', 'B', 1_700_000_000)
            write(f'{e.st}/settings.json', settings_with({'a.png': ['都市', 'MVU']}))
            write(f'{e.phone}/settings.json', settings_with({'b.png': ['仙侠'], 'a.png': ['MVU']}))
            rc, out = e.sync('--dry-run')
            self.assertIn('标签：→ 手机 1 个，← 电脑 1 个', out)
            self.assertEqual(ps.card_tags(json.loads(read(f'{e.phone}/settings.json'))), {'b.png': {'仙侠'}, 'a.png': {'MVU'}})
            rc, out = e.sync()
            self.assertEqual(rc, 0, out)
            self.assertIn('✓ 标签：→ 手机 1 个，← 电脑 1 个', out)
            self.assertEqual(ps.card_tags(json.loads(read(f'{e.phone}/settings.json'))), {'a.png': {'都市', 'MVU'}, 'b.png': {'仙侠'}})
            self.assertEqual(ps.card_tags(json.loads(read(f'{e.st}/settings.json'))), {'a.png': {'都市', 'MVU'}, 'b.png': {'仙侠'}})
            bk = [os.path.join(dp, f) for dp, _, fs in os.walk(e.backups) for f in fs]
            self.assertTrue(any(p.endswith('手机/settings.json') for p in bk) and any(p.endswith('电脑/settings.json') for p in bk), bk)
            # 其他设置原样：只动 tags / tag_map
            self.assertEqual(json.loads(read(f'{e.phone}/settings.json'))['power_user'], {})
            rc, out = e.sync()
            self.assertIn('标签：→ 手机 0 个，← 电脑 0 个', out)
        finally:
            e.close()


def chat(*floors, head='{"chat_metadata":{}}'):
    """floors: (发送时间, 名字, 内容)。"""
    return '\n'.join([head] + [json.dumps({'send_date': d, 'name': n, 'is_user': n == 'U', 'mes': m}, ensure_ascii=False) for d, n, m in floors])


class ChatConflictTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()

    def tearDown(self):
        self.e.close()

    def test_diverged_chat_keeps_both_on_both_sides(self):
        e = self.e
        base = [('d1', 'U', '你好'), ('d2', 'C', '欢迎')]
        write(f'{e.st}/chats/C/c.jsonl', chat(*base, ('d3', 'U', '电脑上聊的')), 1_700_000_000)
        write(f'{e.phone}/chats/C/c.jsonl', chat(*base, ('d4', 'U', '手机上聊的'), ('d5', 'C', '回复')), 1_700_000_900)
        rc, out = e.sync('--dry-run')
        self.assertIn('会另存为', out)
        self.assertEqual(sorted(os.listdir(f'{e.st}/chats/C')), ['c.jsonl'])   # 预览不写
        rc, out = e.sync()
        self.assertEqual(rc, 0, out)
        copies = [f for f in os.listdir(f'{e.st}/chats/C') if '冲突副本·电脑' in f]
        self.assertEqual(len(copies), 1, os.listdir(f'{e.st}/chats/C'))
        self.assertIn('电脑上聊的', read(f'{e.st}/chats/C/{copies[0]}'))
        self.assertIn('手机上聊的', read(f'{e.st}/chats/C/c.jsonl'))         # 较新的（手机）赢
        self.assertIn('电脑上聊的', read(f'{e.phone}/chats/C/{copies[0]}'))  # 副本两边都有
        rc, out = e.sync()
        self.assertIn('→ 手机：0 个    ← 电脑：0 个', out)

    def test_winner_containing_every_floor_needs_no_copy(self):
        e = self.e
        write(f'{e.st}/chats/C/c.jsonl', chat(('d1', 'U', '你好'), ('d2', 'C', '旧回复')), 1_700_000_000)
        write(f'{e.phone}/chats/C/c.jsonl', chat(('d1', 'U', '你好'), ('d2', 'C', '重新生成的回复'), ('d3', 'U', '继续')), 1_700_000_900)
        rc, out = e.sync()
        self.assertEqual(rc, 0, out)
        self.assertNotIn('冲突副本', out)
        self.assertEqual(os.listdir(f'{e.st}/chats/C'), ['c.jsonl'])
        self.assertIn('重新生成的回复', read(f'{e.st}/chats/C/c.jsonl'))

    def test_regenerated_reply_is_not_a_lost_floor(self):
        old = chat(('d1', 'U', '你好'), ('d2', 'C', '第一版回复'))
        new = '\n'.join(['{}', json.dumps({'send_date': 'd1', 'name': 'U', 'is_user': True, 'mes': '你好'}),
                         json.dumps({'send_date': 'd9', 'name': 'C', 'is_user': False, 'mes': '第二版',
                                     'swipes': ['第一版回复', '第二版']}, ensure_ascii=False)])
        self.assertEqual(ps.missing_floors(new.encode(), old.encode()), 0)
        edited = chat(('d1', 'U', '你好'), ('d7', 'C', '别处改写的回复'))
        self.assertEqual(ps.missing_floors(new.encode(), edited.encode()), 1)

    def test_local_name_and_ext_only(self):
        e = self.e
        write(f'{e.st}/chats/A/x.jsonl', 'x', 1_700_000_000)
        rc, out = e.sync('--local-name', 'Mac TT', '--dry-run')
        self.assertIn('Mac TT 1 个文件', out)
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = ps.main(['--ext-only', '--adb', e.adb, '--serial', 'FAKE', '--ext-dir', os.path.join(e.root, 'none')])
        self.assertEqual(rc, 0, buf.getvalue())
        self.assertIn('扩展：没有要推的', buf.getvalue())


class SecretsMergeTests(unittest.TestCase):
    def test_only_adds_missing_entries_inactive_and_keeps_each_sides_active(self):
        mac = {'api_key_custom': [{'id': 'a', 'value': 'GATEWAY', 'active': True}], 'api_key_nai': [{'id': 'n', 'value': 'N', 'active': True}]}
        phone = {'api_key_custom': [{'id': 'b', 'value': 'LAN', 'active': True}, {'id': 'c', 'value': 'GATEWAY', 'active': False}],
                 'api_key_deepseek': [{'id': 'd', 'value': 'D', 'active': True}], 'old_style': 'S'}
        m, n = ps.add_missing_secrets(phone, mac)
        self.assertEqual(n, 1)   # 只有 api_key_nai 是手机没有的（GATEWAY 按值已经有了）
        self.assertEqual([(e['value'], e['active']) for e in m['api_key_custom']], [('LAN', True), ('GATEWAY', False)])
        self.assertEqual(m['api_key_nai'], [{'id': 'n', 'value': 'N', 'active': False}])
        self.assertEqual(m['old_style'], 'S')
        m2, n2 = ps.add_missing_secrets(mac, phone)
        self.assertEqual([(e['value'], e['active']) for e in m2['api_key_custom']], [('GATEWAY', True), ('LAN', False)])
        self.assertNotIn('old_style', m2)   # 旧格式（字符串）不带过去
        self.assertEqual(n2, 2)
        self.assertEqual(mac['api_key_custom'][0]['active'], True)   # 不改原来的


def presets(**oai):
    return json.dumps({'oai_settings': oai}, ensure_ascii=False)


def secrets_file(*entries, key='api_key_custom'):
    return json.dumps({key: [{'id': f'id{i}', 'value': v, 'label': '', 'active': act} for i, (v, act) in enumerate(entries)]})


class ChoiceTests(unittest.TestCase):
    """菜单的「要你选」：--plan-json 分组、--choices 执行、没选时的安全默认。"""

    def setUp(self):
        self.e = Env()
        self._guard = (ps.GUARD_MOD, ps.GUARD_DIR)
        ps.GUARD_MOD = os.path.join(self.e.root, 'module')
        ps.GUARD_DIR = os.path.join(self.e.root, 'guard')
        os.makedirs(ps.GUARD_DIR)

    def tearDown(self):
        ps.GUARD_MOD, ps.GUARD_DIR = self._guard
        self.e.close()

    def plan(self, *extra):
        f = os.path.join(self.e.root, 'plan.json')
        rc, out = self.e.sync('--plan-json', f, *extra)
        return rc, json.loads(read(f)), out

    def run_choices(self, choices, *extra):
        f = os.path.join(self.e.root, 'choices.json')
        write(f, json.dumps(choices))
        r = os.path.join(self.e.root, 'result.json')
        rc, out = self.e.sync('--choices', f, '--result-json', r, *extra)
        return rc, (json.loads(read(r)) if os.path.exists(r) else None), out

    def diverged_chat(self):
        e = self.e
        base = [('d1', 'U', '你好'), ('d2', 'C', '欢迎')]
        write(f'{e.st}/chats/C/c.jsonl', chat(*base), 1_700_000_000)
        e.sync()   # 记下同步状态
        write(f'{e.st}/chats/C/c.jsonl', chat(*base, ('d3', 'U', '电脑上聊的')), 1_700_000_100)
        write(f'{e.phone}/chats/C/c.jsonl', chat(*base, ('d4', 'U', '手机上聊的'), ('d5', 'C', '回复')), 1_700_000_900)

    def test_plan_groups_auto_ask_skip_and_changes_nothing(self):
        e = self.e
        self.diverged_chat()
        write(f'{e.st}/worlds/mac.json', 'mac only', 1_700_000_000)
        write(f'{e.phone}/worlds/phone.json', 'phone only', 1_700_000_000)
        write(f'{e.st}/settings/presets.json', presets(model='a', custom_url='http://127.0.0.1:8901/v1'), 1_700_000_000)
        write(f'{e.phone}/settings/presets.json', presets(model='b', custom_url='http://10.0.0.2:8901/v1'), 1_700_000_500)
        write(f'{e.st}/secrets.json', secrets_file(('K1', True)))
        write(f'{e.phone}/secrets.json', secrets_file(('K2', True)))
        before = sorted(os.listdir(f'{e.st}/chats/C'))
        rc, p, out = self.plan()
        self.assertEqual(rc, 0, out)
        self.assertTrue(p['ok'])
        self.assertEqual(p['auto']['push'], ['worlds/mac.json'])
        self.assertEqual(p['auto']['pull'], ['worlds/phone.json'])
        self.assertEqual([c['rel'] for c in p['ask']['chats']], ['chats/C/c.jsonl'])
        self.assertEqual(p['ask']['chats'][0]['extra'], {'local': 1, 'remote': 2})
        self.assertEqual(p['ask']['chats'][0]['newer'], 'remote')
        self.assertEqual(p['ask']['api']['newer'], 'remote')
        self.assertEqual(p['ask']['secrets'], {'local': 1, 'remote': 1})
        self.assertFalse(p['nothing'])
        self.assertEqual(p['guard'], {'module': False, 'restoring': False, 'pending': False})
        self.assertNotIn('K1', read(os.path.join(e.root, 'plan.json')))
        self.assertEqual(sorted(os.listdir(f'{e.st}/chats/C')), before)          # 什么都没写
        self.assertFalse(os.path.exists(f'{e.phone}/worlds/mac.json'))

    def test_no_choices_keeps_safe_defaults_and_defers_settings_and_keys(self):
        e = self.e
        self.diverged_chat()
        write(f'{e.st}/settings/presets.json', presets(model='a'), 1_700_000_000)
        write(f'{e.phone}/settings/presets.json', presets(model='b'), 1_700_000_500)
        write(f'{e.st}/secrets.json', secrets_file(('K1', True)))
        write(f'{e.phone}/secrets.json', secrets_file(('K2', True)))
        rc, out = e.sync()
        self.assertEqual(rc, 0, out)
        self.assertIn('待你选：API 和预设设置两边不一样', out)
        self.assertIn('待你选：API 密钥两边不一样', out)
        self.assertEqual(json.loads(read(f'{e.phone}/settings/presets.json'))['oai_settings']['model'], 'b')
        self.assertEqual(json.loads(read(f'{e.phone}/secrets.json')), json.loads(secrets_file(('K2', True))))
        # 聊天冲突：较新的（手机）赢，电脑那份多出的楼另存冲突副本，两边都有
        self.assertIn('手机上聊的', read(f'{e.st}/chats/C/c.jsonl'))
        self.assertEqual(len([f for f in os.listdir(f'{e.phone}/chats/C') if '冲突副本' in f]), 1)

    def test_chat_choice_local_remote_both(self):
        e = self.e
        self.diverged_chat()
        rc, res, out = self.run_choices({'files': {'chats/C/c.jsonl': 'local'}})
        self.assertEqual(rc, 0, out)
        self.assertIn('电脑上聊的', read(f'{e.phone}/chats/C/c.jsonl'))
        self.assertEqual([f for f in os.listdir(f'{e.phone}/chats/C') if '冲突副本' in f], [])
        bk = [os.path.join(dp, f) for dp, _, fs in os.walk(e.backups) for f in fs]
        self.assertTrue(any(p.endswith('手机/chats/C/c.jsonl') and '手机上聊的' in read(p) for p in bk), bk)
        self.assertEqual(res['push']['done'], 1)

        write(f'{e.phone}/chats/C/c.jsonl', chat(('d1', 'U', '你好'), ('d9', 'U', '手机又聊了')), 1_700_002_000)
        write(f'{e.st}/chats/C/c.jsonl', chat(('d1', 'U', '你好'), ('d8', 'U', 'Mac 又聊了')), 1_700_001_000)
        rc, res, out = self.run_choices({'files': {'chats/C/c.jsonl': 'remote'}})
        self.assertIn('手机又聊了', read(f'{e.st}/chats/C/c.jsonl'))
        self.assertEqual(res['copies'], [])

        # 两份都留：没有多出的楼也另存一份
        write(f'{e.phone}/chats/C/c.jsonl', chat(('d1', 'U', '你好'), ('d9', 'U', '手机又聊了'), ('d10', 'C', '续')), 1_700_004_000)
        write(f'{e.st}/chats/C/c.jsonl', chat(('d1', 'U', '你好'), ('d9', 'U', '手机又聊了'), ('d10', 'C', '续'), ('d11', 'U', 'x')), 1_700_003_000)
        os.utime(f'{e.st}/chats/C/c.jsonl', (1_700_003_000, 1_700_003_000))
        rc, res, out = self.run_choices({'files': {'chats/C/c.jsonl': 'both'}})
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(res['copies']), 1, out)
        self.assertIn('两份都留', out)

    def test_api_choice_keeps_per_device_address(self):
        e = self.e
        write(f'{e.st}/settings/presets.json', presets(model='new', preset_settings_openai='P2', custom_url='http://127.0.0.1:8901/v1',
                                                       reverse_proxy='https://mac.example'), 1_700_000_900)
        write(f'{e.phone}/settings/presets.json', presets(model='old', preset_settings_openai='P1', custom_url='http://192.168.1.5:8901/v1',
                                                          reverse_proxy=''), 1_700_000_000)
        rc, res, out = self.run_choices({'api': 'local'})
        self.assertEqual(rc, 0, out)
        o = json.loads(read(f'{e.phone}/settings/presets.json'))['oai_settings']
        self.assertEqual((o['model'], o['preset_settings_openai']), ('new', 'P2'))
        self.assertEqual((o['custom_url'], o['reverse_proxy']), ('http://192.168.1.5:8901/v1', ''))
        self.assertIn('P2', res['api'])
        # 只差连哪个地址：不算不一样
        rc, p, out = self.plan()
        self.assertIsNone(p['ask']['api'])

    def test_secrets_merge_choice_adds_inactive_only(self):
        e = self.e
        write(f'{e.st}/secrets.json', secrets_file(('GATEWAY', True)))
        write(f'{e.phone}/secrets.json', secrets_file(('LAN', True)))
        rc, res, out = self.run_choices({'secrets': 'merge'})
        self.assertEqual(rc, 0, out)
        ph = json.loads(read(f'{e.phone}/secrets.json'))['api_key_custom']
        mac = json.loads(read(f'{e.st}/secrets.json'))['api_key_custom']
        self.assertEqual([(x['value'], x['active']) for x in ph], [('LAN', True), ('GATEWAY', False)])
        self.assertEqual([(x['value'], x['active']) for x in mac], [('GATEWAY', True), ('LAN', False)])
        self.assertNotIn('GATEWAY', out)
        self.assertNotIn('LAN\'', out)

    def test_endpoint_makes_lan_key_the_active_custom_key(self):
        e = self.e
        write(f'{e.phone}/settings/presets.json', presets(custom_url='http://10.0.0.1:8901/v1'))
        write(f'{e.phone}/secrets.json', secrets_file(('GATEWAY-SECRET', True)))
        key = os.path.join(e.root, 'key')
        write(key, 'LANKEY-12345')
        rc, out = e.sync('--mac-ip', '192.168.1.5', '--lan-key-file', key)
        self.assertEqual(rc, 0, out)
        lst = json.loads(read(f'{e.phone}/secrets.json'))['api_key_custom']
        self.assertEqual([(x['value'], x['active']) for x in lst], [('GATEWAY-SECRET', False), ('LANKEY-12345', True)])
        self.assertEqual(lst[1]['label'], ps.LAN_KEY_LABEL)
        self.assertNotIn('LANKEY', out)
        self.assertNotIn('GATEWAY-SECRET', out)
        bk = [os.path.join(dp, f) for dp, _, fs in os.walk(e.backups) for f in fs if f == 'secrets.json']
        self.assertTrue(bk and stat.S_IMODE(os.stat(bk[0]).st_mode) == 0o600)
        # 再来一次：已经对了，不改
        rc, out = e.sync('--mac-ip', '192.168.1.5', '--lan-key-file', key)
        self.assertEqual(json.loads(read(f'{e.phone}/secrets.json'))['api_key_custom'], lst)
        # 手机不是连代理（自定义地址是别处）：不碰密钥
        write(f'{e.phone}/settings/presets.json', presets(custom_url='https://gateway.example/v1'))
        write(f'{e.phone}/secrets.json', secrets_file(('GATEWAY-SECRET', True)))
        e.sync('--mac-ip', '192.168.1.5', '--lan-key-file', key)
        self.assertEqual(len(json.loads(read(f'{e.phone}/secrets.json'))['api_key_custom']), 1)

    def test_restore_lock_refuses_everything(self):
        e = self.e
        write(f'{e.st}/chats/A/x.jsonl', 'mac', 1_700_000_000)
        os.makedirs(os.path.join(ps.GUARD_DIR, '.restore.lock'))
        rc, p, out = self.plan()
        self.assertEqual(rc, 2)
        self.assertFalse(p['ok'])
        self.assertIn('正在恢复', p['error'])
        rc, out = e.sync()
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(f'{e.phone}/chats/A/x.jsonl'))

    def test_restore_pending_needs_confirmation(self):
        e = self.e
        write(f'{e.st}/chats/A/x.jsonl', 'mac', 1_700_000_000)
        write(os.path.join(ps.GUARD_DIR, 'restore.pending'), 'tt-x.tar.gz|safety')
        rc, p, out = self.plan()
        self.assertTrue(p['guard']['pending'])
        rc, out = e.sync()   # 不问问题的同步：不做
        self.assertEqual(rc, 2)
        self.assertIn('没做完', out)
        self.assertFalse(os.path.exists(f'{e.phone}/chats/A/x.jsonl'))
        rc, res, out = self.run_choices({'pendingOk': True})
        self.assertEqual(rc, 0, out)
        self.assertTrue(os.path.exists(f'{e.phone}/chats/A/x.jsonl'))

    def test_snapshot_before_writing_to_phone(self):
        e = self.e
        write(f'{e.st}/chats/A/x.jsonl', 'mac', 1_700_000_000)
        rc, res, out = self.run_choices({})
        self.assertIn('没装 TT 守护', out)
        self.assertEqual(res['snapshot'], 'none')
        calls = os.path.join(e.root, 'snap-calls')
        write(os.path.join(ps.GUARD_MOD, 'ui.sh'),
              f'echo "$@" >> {calls}; [ -f {e.phone}/chats/A/y.jsonl ] && echo WRITTEN_BEFORE >> {calls}; '
              'echo \'{"ok":true,"names":["tt-default-user-1.tar.gz"]}\'\n')
        write(f'{e.st}/chats/A/y.jsonl', 'mac2', 1_700_000_000)
        rc, res, out = self.run_choices({})
        self.assertEqual(rc, 0, out)
        self.assertEqual(read(calls).split(), ['backup', 'tt'])   # 在写手机之前
        self.assertEqual(res['snapshot'], 'ok tt-default-user-1.tar.gz')
        self.assertIn('TT 守护先存了一份快照', out)
        # 没有要写手机的：不做快照
        os.unlink(calls)
        rc, res, out = self.run_choices({})
        self.assertFalse(os.path.exists(calls))


class LocalTTTests(unittest.TestCase):
    def test_local_tt_push_only(self):
        root = tempfile.mkdtemp()
        try:
            st, tt = os.path.join(root, 'st'), os.path.join(root, 'tt', 'data', 'default-user')
            write(f'{st}/chats/A/x.jsonl', 'mac', 1_700_000_000)
            write(f'{tt}/chats/A/y.jsonl', 'tt only', 1_700_000_000)
            write(f'{tt}/chats/A/x.jsonl', 'tt newer', 1_700_009_000)
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = ps.main(['--st', st, '--local-tt', tt, '--push-only', '--state', f'{root}/s.json', '--backups', f'{root}/bk'])
            self.assertEqual(rc, 0, buf.getvalue())
            self.assertEqual(read(f'{tt}/chats/A/x.jsonl'), 'tt newer')
            self.assertFalse(os.path.exists(f'{st}/chats/A/y.jsonl'))
        finally:
            shutil.rmtree(root, ignore_errors=True)


    def test_same_content_different_time_is_not_a_change(self):
        # TT 每次启动都重写快速回复：内容一样、时间不同 → 不算改动；预览退出码 3（没有要同步的）
        root = tempfile.mkdtemp()
        try:
            st, tt = os.path.join(root, 'st'), os.path.join(root, 'tt', 'data', 'default-user')
            write(f'{st}/QuickReplies/Default.json', '{"a":1}', 1_700_000_000)
            write(f'{tt}/QuickReplies/Default.json', '{"a":1}', 1_700_009_000)
            args = ['--st', st, '--local-tt', tt, '--state', f'{root}/s.json', '--backups', f'{root}/bk']
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = ps.main(args + ['--dry-run', '--exit-if-nothing'])
            self.assertEqual(rc, 3, buf.getvalue())
            # 内容不同就照常同步
            write(f'{tt}/QuickReplies/Default.json', '{"a":2}', 1_700_009_000)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(ps.main(args + ['--dry-run', '--exit-if-nothing']), 0)
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
