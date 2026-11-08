"""replay_bash.py: replay behavior and containment. Run with python3 -B, because a
__pycache__ folder in this repo stops Chrome loading the extension.

Containment tests make real escape attempts, so they run only where sandbox-exec exists.
"""
import importlib.util, json, os, secrets, shutil, subprocess, sys, tempfile, unittest

sys.dont_write_bytecode = True
from pathlib import Path

R = str(Path(__file__).resolve().parent.parent / "replay_bash.py")
HAS_SANDBOX = shutil.which("sandbox-exec") is not None
spec=importlib.util.spec_from_file_location('rb',R);rb=importlib.util.module_from_spec(spec);sys.modules['rb']=rb;spec.loader.exec_module(rb)
SP=Path(tempfile.mkdtemp(prefix='takeout-replay-test-'))
def conv(blocks):
    return {'current_leaf_message_uuid':'a','chat_messages':[{'uuid':'a','parent_message_uuid':None,'sender':'assistant','content':blocks}]}
def cf(p,t):return {'type':'tool_use','name':'create_file','input':{'path':p,'file_text':t}}
def sr(p,o,n):return {'type':'tool_use','name':'str_replace','input':{'path':p,'old_str':o,'new_str':n}}
def sh(c):return {'type':'tool_use','name':'bash_tool','input':{'command':c}}
def export(blocks,arts):
    d=Path(tempfile.mkdtemp(dir=SP,prefix='exp.')).resolve();(d/'artefacts').mkdir()
    (d/'original.json').write_text(json.dumps(conv(blocks)))
    for k,v in arts.items():(d/'artefacts'/k).write_bytes(v)
    return d
def run(d,*a):
    return subprocess.run([sys.executable,'-I',R,str(d),'--all',*a],capture_output=True,text=True,timeout=60,stdin=subprocess.DEVNULL)
P='/home/claude/a.html'
class Paths(unittest.TestCase):
    def rw(self,c):return rb.rewrite_paths(c,Path('/S'))
    def test_bare_root(self):self.assertEqual(self.rw('cd /home/claude && ls'),'cd /S/home/claude && ls')
    def test_tmp(self):self.assertEqual(self.rw('cat /tmp/x'),'cat /S/tmp/x')
    def test_session_root(self):self.assertEqual(self.rw('ls /root/.claude/uploads/a'),'ls /S/root/.claude/uploads/a')
    def test_quoted(self):self.assertEqual(self.rw("open('/mnt/user-data/outputs/a')"),"open('/S/mnt/user-data/outputs/a')")
    def test_no_lookalike(self):
        for c in('/tmpfoo','/var/tmp/x','/home/claudette/x','/x/home/claude','/root/.claudeX/a','/root/x'):self.assertEqual(self.rw(c),c)
    def test_sandbox_path_rejects(self):
        td=Path(tempfile.mkdtemp(dir=SP)).resolve()
        for p in('/home/claude/../../../etc/x','/etc/passwd','relative.txt','/tmp/../../x','/mnt/user-data/uploads/../../../../x'):self.assertIsNone(rb.sandbox_path(td,p),p)
        self.assertIsNotNone(rb.sandbox_path(td,'/home/claude/ok.txt'))
    def test_collisions(self):
        self.assertEqual(list(rb.artifact_filenames({'/a/f.html':'','/b/f.html':'','/c/n':''}).values()),['f.html','f_2.html','n'])
    def test_clean(self):self.assertEqual(rb.clean('a\x1b[2Jb\tc'),'a?[2Jb\tc')
@unittest.skipUnless(HAS_SANDBOX, 'needs sandbox-exec')
class Replay(unittest.TestCase):
    def test_literal_v1_name_kept_apart(self):
        # report.html edited over two turns, then Claude saves report_v1.html itself. The exporter
        # writes that one as report_v1_2.html, so a bash change to it must land there.
        turns=[[cf('/home/claude/report.html','A')],[sr('/home/claude/report.html','A','B')],[cf('/home/claude/report_v1.html','OTHER')],[sh('echo X > /home/claude/report_v1.html')]]
        msgs=[];parent=None
        for i,blocks in enumerate(turns):
            msgs+=[{'uuid':f'h{i}','parent_message_uuid':parent,'sender':'human','content':[]},{'uuid':f'a{i}','parent_message_uuid':f'h{i}','sender':'assistant','content':blocks}];parent=f'a{i}'
        d=export([],{'report.html':b'B','report_v1.html':b'A','report_v2.html':b'B','report_v1_2.html':b'OTHER'})
        (d/'original.json').write_text(json.dumps({'current_leaf_message_uuid':parent,'chat_messages':msgs}))
        r=run(d)
        self.assertEqual((d/'artefacts/report_v1_2.html').read_text(),'X\n',r.stdout+r.stderr)
        self.assertEqual((d/'artefacts/report_v1.html').read_text(),'A')
        self.assertEqual((d/'artefacts/report.html').read_text(),'B')
    def test_order_edit_after_script(self):
        d=export([cf(P,'one'),sh("sed -i '' s/one/two/ /home/claude/a.html"),sr(P,'two','three')],{'a.html':b'one'})
        r=run(d);self.assertEqual((d/'artefacts/a.html').read_text(),'three',r.stdout+r.stderr)
    def test_heredoc_then_edit_survives(self):
        d=export([sh("cat > /home/claude/a.html << 'EOF'\nold\nEOF"),sr(P,'old','new')],{'a.html':b'new'})
        r=run(d);self.assertEqual((d/'artefacts/a.html').read_text(),'new\n',r.stdout)
    def test_cwd_and_home(self):
        d=export([cf(P,'x'),sh('echo rel > a.html; echo h >> ~/a.html')],{'a.html':b'x'})
        r=run(d);self.assertEqual((d/'artefacts/a.html').read_text(),'rel\nh\n',r.stdout+r.stderr)
    def test_collision_writes_right_file(self):
        d=export([cf('/home/claude/a/f.html','1'),cf('/home/claude/b/f.html','2'),sh('echo 2b > /home/claude/b/f.html')],{'f.html':b'1','f_2.html':b'2'})
        r=run(d);self.assertEqual((d/'artefacts/f.html').read_text(),'1');self.assertEqual((d/'artefacts/f_2.html').read_text(),'2b\n',r.stdout)
    def test_bom_kept(self):
        d=export([cf('/home/claude/n.md','é'),sh('echo x >> /home/claude/n.md')],{'n.md':b'\xef\xbb\xbf'+'é'.encode()})
        run(d);self.assertEqual((d/'artefacts/n.md').read_bytes(),b'\xef\xbb\xbf'+'éx\n'.encode())
    def test_backup_and_warning(self):
        d=export([cf(P,'o'),sh('echo n > /home/claude/a.html'),sh('exit 3')],{'a.html':b'orig'})
        r=run(d);self.assertEqual((d/'artefacts_before_replay/a.html').read_bytes(),b'orig');self.assertIn('WARNING',r.stdout)
        run(d);self.assertEqual((d/'artefacts_before_replay/a.html').read_bytes(),b'orig')
    def test_no_backup_when_no_write(self):
        d=export([cf(P,'o'),sh('echo n > /home/claude/a.html')],{'a.html':b'orig'})
        run(d,'--no-write');self.assertFalse((d/'artefacts_before_replay').exists());self.assertEqual((d/'artefacts/a.html').read_bytes(),b'orig')
    def test_failed_tool_calls_skipped(self):
        c1=dict(cf(P,'real'),id='1');c2=dict(cf(P,'rejected'),id='2');e=dict(sr(P,'real','phantom'),id='3')
        res=lambda i:{'type':'tool_result','tool_use_id':i,'is_error':True,'content':[]}
        d=export([c1,c2,res('2'),e,res('3'),sh('echo x >> /home/claude/a.html')],{'a.html':b'real'})
        r=run(d);self.assertEqual((d/'artefacts/a.html').read_text(),'realx\n',r.stdout)
        self.assertEqual(rb.declarative_state(json.loads((d/'original.json').read_text()))[P],'real')
    def test_bash_write_edit_replay(self):
        N='/tmp/claude-0/-home-claude/s/scratchpad/build.py'
        w={'type':'tool_use','name':'Write','input':{'file_path':N,'content':'one one\n'}}
        e={'type':'tool_use','name':'Edit','input':{'file_path':N,'old_string':'one','new_string':'two','replace_all':True}}
        b={'type':'tool_use','name':'Bash','input':{'command':"cd /tmp/claude-0/-home-claude/s/scratchpad && python3 - <<'E'\np='build.py';s=open(p).read()\nopen(p,'w').write(s.replace('two','three'))\nE"}}
        d=export([w,e,b],{'build.py':b'stale'})
        r=run(d);self.assertEqual((d/'artefacts/build.py').read_text(),'three three\n',r.stdout+r.stderr)
    def test_failed_bash_tool_write_skipped(self):
        w=dict({'type':'tool_use','name':'Write','input':{'file_path':P,'content':'rejected'}},id='1')
        d=export([cf(P,'real'),w,{'type':'tool_result','tool_use_id':'1','is_error':True,'content':[]},sh('echo x >> /home/claude/a.html')],{'a.html':b'real'})
        run(d);self.assertEqual((d/'artefacts/a.html').read_text(),'realx\n')
    def test_session_uploads_found(self):
        U='/root/.claude/uploads/abc-123'
        b={'type':'tool_use','name':'Bash','input':{'command':f"cat {U}/deadbeef-my_file.txt > /home/claude/a.html"}}
        d=export([cf(P,'x'),b],{'a.html':b'x'});(d/'uploads').mkdir();(d/'uploads/p01_my file.txt').write_text('from upload')
        data=json.loads((d/'original.json').read_text());data['chat_messages'][0]['files']=[{'file_name':'my file.txt','file_uuid':'deadbeef-0000','success':True}]
        (d/'original.json').write_text(json.dumps(data))
        r=run(d);self.assertEqual((d/'artefacts/a.html').read_text(),'from upload',r.stdout+r.stderr)
    def test_versioned_too(self):
        # Two turns give a_v1 and a_v2; a later bash change lands in a.html and the last version.
        msgs=[{'uuid':'h0','parent_message_uuid':None,'sender':'human','content':[]},{'uuid':'a0','parent_message_uuid':'h0','sender':'assistant','content':[cf(P,'o')]},
              {'uuid':'h1','parent_message_uuid':'a0','sender':'human','content':[]},{'uuid':'a1','parent_message_uuid':'h1','sender':'assistant','content':[sr(P,'o','p'),sh('echo n > /home/claude/a.html')]}]
        d=export([],{'a.html':b'p','a_v1.html':b'o','a_v2.html':b'p'})
        (d/'original.json').write_text(json.dumps({'current_leaf_message_uuid':'a1','chat_messages':msgs}))
        run(d);self.assertEqual((d/'artefacts/a_v2.html').read_text(),'n\n');self.assertEqual((d/'artefacts/a.html').read_text(),'n\n');self.assertEqual((d/'artefacts/a_v1.html').read_text(),'o')
    def test_utf8_sig_json(self):
        d=export([sh('true')],{});(d/'original.json').write_bytes(b'\xef\xbb\xbf'+(d/'original.json').read_bytes())
        self.assertEqual(run(d).returncode,0)
@unittest.skipUnless(HAS_SANDBOX, 'needs sandbox-exec')
class Containment(unittest.TestCase):
    def setUp(self):
        self.tok='canary'+secrets.token_hex(6)
        self.out=Path(tempfile.mkdtemp(dir=SP,prefix='outside.')).resolve()
    def report(self,cmd,env=None):
        d=export([cf(P,'x'),sh(cmd+'; echo done > /home/claude/a.html')],{'a.html':b'x'})
        e=dict(os.environ);e.update(env or {})
        return d,subprocess.run([sys.executable,'-I',R,str(d),'--all'],capture_output=True,text=True,timeout=60,stdin=subprocess.DEVNULL,env=e)
    def test_cannot_write_outside(self):
        for t in(self.out/'w',Path('/private/tmp')/self.tok,Path.home()/self.tok):
            d,r=self.report(f'echo x > {t}');self.assertFalse(t.exists(),str(t))
    def test_tmp_rewrite_stays_inside(self):
        d,r=self.report(f'echo x > /tmp/{self.tok}');self.assertFalse(Path('/tmp',self.tok).exists())
    def test_no_home_read(self):
        (self.out/'s').write_text(self.tok)
        d=export([cf(P,'x'),sh(f'cat {Path.home()}/.gitconfig {self.out}/s > /home/claude/a.html')],{'a.html':b'x'})
        run(d);t=(d/'artefacts/a.html').read_text();self.assertNotIn(self.tok,t);self.assertNotIn('[user]',t)
    def test_symlink_exfil_blocked(self):
        s=self.out/'secret';s.write_text(self.tok)
        d=export([cf(P,'x'),sh(f'rm /home/claude/a.html; ln -s {s} /home/claude/a.html')],{'a.html':b'x'})
        r=run(d);self.assertEqual((d/'artefacts/a.html').read_text(),'x',r.stdout)
    def test_symlink_dir_traversal_write(self):
        d=export([cf(P,'x'),sh(f'ln -s {self.out} /home/claude/esc'),cf('/home/claude/esc/pwn','owned')],{'a.html':b'x'})
        run(d);self.assertFalse((self.out/'pwn').exists())
    def test_dotdot_write_rejected(self):
        rel=os.path.relpath(self.out/'pwn','/')
        d=export([cf('/home/claude/'+'../'*24+rel,'owned'),sh('true')],{})
        r=run(d);self.assertFalse((self.out/'pwn').exists());self.assertIn('Edits not applied: 1',r.stdout)
    def test_env_not_passed(self):
        d=export([cf(P,'x'),sh('env > /home/claude/a.html')],{'a.html':b'x'})
        e=dict(os.environ,ANTHROPIC_API_KEY=self.tok,GITHUB_TOKEN=self.tok)
        subprocess.run([sys.executable,'-I',R,str(d),'--all'],capture_output=True,text=True,env=e,stdin=subprocess.DEVNULL)
        t=(d/'artefacts/a.html').read_text();self.assertNotIn(self.tok,t);self.assertIn('HOME=',t)
    def test_no_network(self):
        d=export([cf(P,'x'),sh('curl -sS -m 4 -o /dev/null https://example.com && echo CONNECTED > /home/claude/a.html || echo blocked > /home/claude/a.html')],{'a.html':b'x'})
        run(d);self.assertEqual((d/'artefacts/a.html').read_text(),'blocked\n')
    def test_timeout_kills_group(self):
        d=export([sh(f'sleep 300 & sleep 301; echo {self.tok}')],{})
        r=subprocess.run([sys.executable,'-I',R,str(d),'--all','--timeout','1'],capture_output=True,text=True,timeout=20,stdin=subprocess.DEVNULL)
        self.assertIn('timeout',r.stdout);self.assertNotIn(b'sleep 301',subprocess.run(['pgrep','-fl','sleep 30[01]'],capture_output=True).stdout)
@unittest.skipUnless(HAS_SANDBOX, 'needs sandbox-exec')
class Flags(unittest.TestCase):
    def test_all_no_isolation_refused(self):
        d=export([sh('true')],{});self.assertEqual(run(d,'--no-isolation').returncode,2)
    def test_refuses_without_sandbox(self):
        d=export([sh('touch /home/claude/ran')],{})
        e=dict(os.environ,PATH='/nonexistent')
        r=subprocess.run(['/usr/bin/env','-i','PATH=/nonexistent',sys.executable,'-I',R,str(d)],capture_output=True,text=True,stdin=subprocess.DEVNULL)
        self.assertEqual(r.returncode,2,r.stdout+r.stderr);self.assertIn('--no-isolation',r.stderr)
    def test_dry_run_runs_nothing(self):
        o=Path(tempfile.mkdtemp(dir=SP))/'x';d=export([sh(f'touch {o}')],{})
        r=subprocess.run([sys.executable,'-I',R,str(d),'--dry-run'],capture_output=True,text=True);self.assertEqual(r.returncode,0);self.assertFalse(o.exists())
    def test_eof_at_prompt_runs_nothing(self):
        o=Path('/home/claude/x');d=export([cf(P,'x'),sh('echo y > /home/claude/a.html')],{'a.html':b'x'})
        r=subprocess.run([sys.executable,'-I',R,str(d)],capture_output=True,text=True,stdin=subprocess.DEVNULL);self.assertEqual((d/'artefacts/a.html').read_text(),'x')
    def test_terminal_escape_hidden(self):
        d=export([sh('echo \x1b[2J')],{});r=run(d,'--dry-run');self.assertNotIn('\x1b',r.stdout)
if __name__ == '__main__':
    try:
        unittest.main(verbosity=1, exit=False)
    finally:
        shutil.rmtree(SP, ignore_errors=True)
