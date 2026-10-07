import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUEST_STATES, mintOriginId, resolveScope, sameOrigin, usableOriginId } from '../src/scope.js';

// Plan v1.4.4 §10.2/§10.3: exactly two request states, selected by an explicit
// project argument or a confirmed binding and nothing else, and an origin id
// that never matches an absent one.

test('request scope has exactly two states', () => {
  assert.deepEqual(REQUEST_STATES, ['project_selected', 'project_unresolved']);
  assert.ok(Object.isFrozen(REQUEST_STATES));
});

test('an explicit project argument selects that project', () => {
  assert.deepEqual(resolveScope({ project: 'alpha' }), { state: 'project_selected', project: 'alpha', source: 'argument', originId: null });
});

test('the literal "default" is an ordinary project name, never a fallback', () => {
  assert.deepEqual(resolveScope({ project: 'default' }), { state: 'project_selected', project: 'default', source: 'argument', originId: null });
  for (const context of [undefined, null, {}, { project: undefined }, { project: null }, { originId: 'origin_a' }]) {
    const scope = resolveScope(context);
    assert.equal(scope.state, 'project_unresolved');
    assert.equal(scope.project, null);
  }
});

test('a confirmed binding selects its project; an explicit argument outranks it', () => {
  const binding = { project: 'bound', confirmed: true };
  assert.deepEqual(resolveScope({ binding }), { state: 'project_selected', project: 'bound', source: 'binding', originId: null });
  assert.deepEqual(resolveScope({ binding, project: 'explicit' }), { state: 'project_selected', project: 'explicit', source: 'argument', originId: null });
});

test('an unconfirmed or malformed binding selects nothing', () => {
  for (const binding of [{ project: 'bound' }, { project: 'bound', confirmed: 'yes' }, { confirmed: true }, { project: '', confirmed: true }, { project: 7, confirmed: true }, 'bound']) {
    assert.equal(resolveScope({ binding }).state, 'project_unresolved', JSON.stringify(binding));
  }
});

test('an explicit project argument that is not a non-empty string is rejected, not ignored', () => {
  for (const project of ['', '   ', 7, {}, []]) {
    assert.throws(() => resolveScope({ project }), /project must be a non-empty string/);
  }
});

test('an unresolved scope carries the presented origin id, and only a usable one', () => {
  assert.deepEqual(resolveScope({ originId: 'origin_a' }), { state: 'project_unresolved', project: null, source: null, originId: 'origin_a' });
  for (const originId of [undefined, null, '', '   ', 0, false, {}, []]) {
    assert.equal(resolveScope({ originId }).originId, null, JSON.stringify(originId));
    assert.equal(usableOriginId(originId), null);
  }
  assert.equal(resolveScope({ project: 'alpha', originId: 'origin_a' }).originId, 'origin_a');
});

test('null never matches null: absent origin ids establish no common ownership', () => {
  const absent = [undefined, null, '', '   ', 0, {}];
  for (const left of absent) for (const right of absent) assert.equal(sameOrigin(left, right), false, `${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
  assert.equal(sameOrigin('origin_a', null), false);
  assert.equal(sameOrigin(null, 'origin_a'), false);
  assert.equal(sameOrigin('origin_a', 'origin_b'), false);
  assert.equal(sameOrigin('origin_a', 'origin_a'), true);
});

test('two unrelated callers with neither a project nor an origin share nothing', () => {
  const first = resolveScope({});
  const second = resolveScope({});
  assert.equal(first.state, 'project_unresolved');
  assert.equal(second.state, 'project_unresolved');
  assert.equal(first.project, null);
  assert.equal(sameOrigin(first.originId, second.originId), false);
});

test('minted origin ids are usable, opaque and distinct', () => {
  const ids = new Set(Array.from({ length: 50 }, () => mintOriginId()));
  assert.equal(ids.size, 50);
  for (const originId of ids) {
    assert.match(originId, /^origin_[0-9a-f-]{36}$/);
    assert.equal(usableOriginId(originId), originId);
    assert.equal(sameOrigin(originId, originId), true);
  }
});

test('a resolved scope is immutable', () => {
  const scope = resolveScope({ project: 'alpha' });
  assert.ok(Object.isFrozen(scope));
  assert.throws(() => { scope.project = 'beta'; }, TypeError);
});
