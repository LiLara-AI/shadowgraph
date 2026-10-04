import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { runDeliver } from '../src/delivery.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';

const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
for (const backend of ['json', 'sqlite']) {
  test(`PR42 ${backend}: measure durable correction to first actual delivery output`, backend === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    const root = await scratchDirectory(t, 'shadowgraph-correction-latency-'), cwd = join(root, 'work');
    await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
    await writeFile(join(cwd, '.shadowgraph/project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: cwd, project: 'p', confirmed: true }));
    const env = { ...process.env, SHADOWGRAPH_HOME: root };
    const options = { type: backend, file: join(root, 'capture'), env, project: 'p' };
    const graph = createShadowGraph(), text = 'Synthetic latency observation.';
    const capture = privilegedRecordCapture(graph, { project: 'p', originId: 'fixture', text,
      source: { event: 'Stop', sessionId: 'fixture-session' }, admission: { limits: { maxStoreBytes: 2 ** 30, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 100 }, storeBytes: 0 } });
    let store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close();
    assert.equal((await commitCapture(options, await claimCapture(options), { status: 'success', receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' },
      value: { records: [{ kind: 'memory', fields: [{ name: 'text', text, sourceRef: capture.id }] }] } })).status, 'committed');
    const samples = [], previousCwd = process.cwd();
    process.chdir(cwd);
    try {
      for (let iteration = 0; iteration < 5; iteration++) {
        store = await createStorage(options);
        const current = createShadowGraph(); current.importData(await store.load());
        const memory = privilegedSnapshot(current).records.find(record => record.kind === 'memory' && record.status === 'active');
        const correction = `Synthetic latency correction number ${iteration}.`;
        const replacement = current.remember({ project: 'p', originId: memory.originId, memoryType: memory.memoryType, key: memory.key, text: correction }).memory;
        await store.save(privilegedSnapshot(current)); store.close();
        const committed = performance.now();
        let output = '', emitted;
        await runDeliver({ file: options.file, storage: backend, env,
          readInput: () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'synthetic latency' }),
          write: value => { output += value; emitted = performance.now(); } });
        assert.ok(Number.isFinite(emitted));
        const payload = JSON.parse(output).hookSpecificOutput.additionalContext;
        const items = payload.split('\n').filter(line => line.startsWith('item: ')).map(line => JSON.parse(line.slice(6)));
        assert.ok(items.some(item => item.expansion?.recordId === replacement.id && item.line.includes(correction)));
        assert.equal(items.some(item => item.expansion?.recordId === memory.id), false, 'the previous memory is absent from the current delivery');
        samples.push(emitted - committed);
      }
    } finally { process.chdir(previousCwd); }
    const sorted = [...samples].sort((a, b) => a - b);
    t.diagnostic(JSON.stringify({ measurement: 'correction-to-delivery', backend, version: process.version, platform: process.platform,
      n: samples.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], unit: 'ms',
      class: 'in-process synthetic capture/extraction/store/delivery pipeline; excludes host trigger wait and model latency', samples }));
  });
}
