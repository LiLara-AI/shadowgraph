import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

async function cli(file, command, payload) {
  const { stdout } = await exec(process.execPath, ['src/cli.js', command, JSON.stringify(payload)], {
    cwd: process.cwd(), env: { ...process.env, SHADOWGRAPH_FILE: file }
  });
  return JSON.parse(stdout);
}

test('CLI remembers, recalls, and synchronizes Markdown memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-cli-memory-'));
  const file = join(directory, 'data.json');
  const workspace = join(directory, 'notes');
  const remembered = await cli(file, 'remember', {
    project: 'app', scope: { userId: 'alice' }, memoryType: 'preference', key: 'theme',
    text: 'Prefers dark mode', embedding: [1, 0]
  });
  assert.equal(remembered.operation, 'ADD');

  const recalled = await cli(file, 'recall', {
    project: 'app', scope: { userId: 'alice' }, query: 'appearance', queryEmbedding: [1, 0]
  });
  assert.equal(recalled.items[0].record.text, 'Prefers dark mode');
  assert.equal(recalled.signals.semantic.available, true);

  const synced = await cli(file, 'markdown-sync', { directory: workspace, mode: 'push' });
  assert.equal(synced.written, 1);
  const markdown = await readFile(synced.files[0].path, 'utf8');
  assert.match(markdown, /Prefers dark mode/);
});

test('CLI context persists review signals that it creates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-cli-context-'));
  const file = join(directory, 'data.json');
  await cli(file, 'decision', {
    id: 'cli-due', project: 'app', title: 'CLI due review', chosen: 'A',
    reviewAfter: '2020-01-01T00:00:00.000Z'
  });
  const context = await cli(file, 'context', { project: 'app' });
  assert.equal(context.openReviews.length, 1);
  const durable = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(durable.reviewSignals.length, 1);
  assert.equal(durable.reviewSignals[0].decisionId, 'cli-due');
});
