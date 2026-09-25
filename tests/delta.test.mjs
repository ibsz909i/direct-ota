import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createDelta, applyDelta} from '../cli/delta.mjs';

test('binary delta reconstructs the exact signed ZIP bytes and saves unchanged content', () => {
  const source = Buffer.concat([randomBytes(128 * 1024), Buffer.from('old'), randomBytes(128 * 1024)]);
  const target = Buffer.concat([source.subarray(0, 128 * 1024), Buffer.from('new content'), source.subarray(128 * 1024 + 3)]);
  const patch = createDelta(source, target);
  assert.ok(patch.length < target.length / 10);
  assert.deepEqual(applyDelta(source, patch), target);
  assert.throws(() => applyDelta(randomBytes(source.length), patch), /base/);
  const altered = Buffer.from(patch);
  altered[altered.length - 1] ^= 1;
  assert.throws(() => applyDelta(source, altered));
  assert.throws(() => applyDelta(source, patch.subarray(0, patch.length - 1)));
  assert.throws(() => applyDelta(source, Buffer.concat([patch, Buffer.from([0])])));
});

test('binary delta never returns output for malformed or randomly changed inputs', () => {
  const source = randomBytes(4096), target = randomBytes(4096);
  const patch = createDelta(source, target);
  assert.deepEqual(applyDelta(source, patch), target);
  for (let i = 0; i < 256; i++) {
    const changed = Buffer.from(patch);
    changed[(i * 7919) % changed.length] ^= 1;
    assert.throws(() => applyDelta(source, changed));
  }
  assert.throws(() => createDelta(Buffer.alloc(0), Buffer.alloc(0)));
  assert.throws(() => createDelta(Buffer.alloc(50 * 1024 * 1024 + 1), Buffer.from('x')));
});
