import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('AG3 inert checklist covers all nine required conditions without claiming host approval', async () => {
  const map = JSON.parse(await readFile(new URL('./fixtures/extraction-gate.json', import.meta.url)));
  assert.equal(map.gate, 'AG-3'); assert.equal(map.fixtureEvidenceIsActivationApproval, false);
  assert.deepEqual(map.conditions.map(row => row.id), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const row of map.conditions) {
    assert.ok(row.requirement && row.requiredHostEvidence && row.fixtures.length);
    for (const { file, witness } of row.fixtures) {
      assert.match(file, /^[a-z-]+\.test\.js$/);
      assert.ok((await readFile(new URL(file, import.meta.url), 'utf8')).includes(witness), `${row.id}: missing ${file} witness ${witness}`);
    }
  }
});
