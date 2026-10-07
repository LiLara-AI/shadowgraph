"""Launch the real CLI on a PTY and answer only after each prompt appears."""
import errno
import json
import os
import pty
import select
import subprocess
import sys
import time

case = json.loads(sys.argv[1])
master, slave = pty.openpty()
input_tty = case.get('inputTty', True)
output_tty = case.get('outputTty', True)
child = subprocess.Popen(case['command'], cwd=case['cwd'], env={**os.environ, **case['env']}, stdin=slave if input_tty else subprocess.PIPE, stdout=slave if output_tty else subprocess.PIPE, stderr=slave)
os.close(slave)
if not input_tty:
    child.stdin.write(b'confirm\n')
    child.stdin.close()
output = b''
answered = []
pending = list(case['answers'])
deadline = time.monotonic() + 10
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            output += os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
    if pending and pending[0]['prompt'].encode() in output:
        answer = pending.pop(0)
        answered.append({'prompt': answer['prompt'], 'display': output.decode(errors='replace')})
        os.write(master, b'\x04' if answer['answer'] is None else (answer['answer'] + '\n').encode())
    if child.poll() is not None:
        break
else:
    child.kill()
    raise RuntimeError('CLI prompt fixture timed out')
os.close(master)
if not output_tty:
    output += child.stdout.read()
print(json.dumps({'status': child.returncode, 'output': output.decode(errors='replace'), 'answered': answered}))
