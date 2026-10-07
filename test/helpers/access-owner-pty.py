"""Real stream/confirmation test driver; no production test switches."""
import errno
import json
import os
import pty
import select
import subprocess
import sys
import time

node, module, raw = sys.argv[1:]
case = json.loads(raw)
master, slave = pty.openpty()
script = '''
const { confirmOwnerAction } = await import(process.argv[1]);
const allowed = await confirmOwnerAction('Issue synthetic grant', { scope: { projects: ['beta'], originIds: [], legacyAttributions: [] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z' });
process.stderr.write('RESULT:' + JSON.stringify(allowed) + '\\n');
'''
child = subprocess.Popen([node, '--input-type=module', '-e', script, module], stdin=slave if case['inputTty'] else subprocess.PIPE, stdout=slave if case['outputTty'] else subprocess.PIPE, stderr=subprocess.PIPE)
os.close(slave)
if not case['inputTty']:
    child.stdin.write(b'confirm\n')
    child.stdin.close()
output = b''
sent = False
displayed = False
deadline = time.monotonic() + 5
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                chunk = b''
            else:
                raise
        output += chunk
    if not sent and b'Type confirm' in output:
        displayed = b'beta' in output and b'2099-01-01' in output
        os.write(master, b'\x04' if case['answer'] is None else (case['answer'] + '\n').encode())
        sent = True
    if child.poll() is not None:
        break
else:
    child.kill()
    raise RuntimeError('confirmation fixture timed out')
if child.stdout:
    output += child.stdout.read()
error = child.stderr.read().decode()
os.close(master)
if child.returncode != 0 or 'RESULT:' not in error:
    raise RuntimeError(error)
allowed = json.loads(error.split('RESULT:', 1)[1].strip())
print(json.dumps({'allowed': allowed, 'displayedBeforeAnswer': displayed, 'output': output.decode(errors='replace')}))
