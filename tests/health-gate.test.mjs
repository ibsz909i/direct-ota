import test from 'node:test';
import assert from 'node:assert/strict';
import {assertRolloutHealth} from '../cli/health-gate.mjs';

const releaseId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const report={releaseId,sampledSuccessRate:0.01,counts:{ready:12,rollback:0,verification_failed:0,download_failed:0}};
test('rollout health gate only permits an operator-requested stage when evidence meets thresholds',()=>{
  assert.deepEqual(assertRolloutHealth(report,releaseId),{releaseId,ready:12,failures:0});
  assert.throws(()=>assertRolloutHealth({...report,counts:{...report.counts,ready:9}},releaseId),/sampled ready/);
  assert.throws(()=>assertRolloutHealth({...report,counts:{...report.counts,rollback:1}},releaseId),/failure reports/);
  assert.throws(()=>assertRolloutHealth({...report,releaseId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},releaseId),/invalid/);
  assert.throws(()=>assertRolloutHealth({...report,counts:{ready:Infinity}},releaseId),/invalid/);
  assert.throws(()=>assertRolloutHealth({...report,sampledSuccessRate:1},releaseId),/invalid/);
  assert.throws(()=>assertRolloutHealth(report,releaseId,{minReady:0}),/thresholds/);
});
