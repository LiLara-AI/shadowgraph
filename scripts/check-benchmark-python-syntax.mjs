import { spawnSync } from 'node:child_process';
import process from 'node:process';

const program = "import ast,pathlib; [ast.parse(p.read_text(encoding='utf-8'), filename=str(p)) for p in pathlib.Path('benchmark/adapters').glob('*.py')]";
const missingInterpreter = /(?:Python was not found|not recognized as an internal or external command|No Python at|command not found)/iu;

const candidates = process.platform === 'win32'
  ? [
      { command: 'python', args: ['-B', '-c', program] },
      { command: 'py', args: ['-3', '-B', '-c', program] }
    ]
  : [
      { command: 'python3', args: ['-B', '-c', program] },
      { command: 'python', args: ['-B', '-c', program] }
    ];

let lastMissing = null;
for (const candidate of candidates) {
  const result = spawnSync(candidate.command, candidate.args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error?.code === 'ENOENT' || missingInterpreter.test(output)) {
    lastMissing = candidate.command;
    continue;
  }
  if (result.status === 0) {
    process.stdout.write(`BENCHMARK_PYTHON_SYNTAX=PASS interpreter=${candidate.command}\n`);
    process.exit(0);
  }
  process.stderr.write(output || `benchmark Python syntax check failed with ${candidate.command}\n`);
  process.exit(result.status ?? 1);
}

process.stderr.write(`No supported Python interpreter for benchmark syntax check (last attempted: ${lastMissing ?? 'none'})\n`);
process.exit(1);
