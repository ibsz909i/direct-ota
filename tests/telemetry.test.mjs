import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEvent} from '../dist/telemetry.js';

const releaseId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('aggregate event metrics are bounded and exclude personal identifiers',()=>{
  const input={releaseId,event:'download_complete',metrics:{durationMs:2500,bytes:1000,retries:1,connection:'wifi'}};
  assert.deepEqual(validateEvent(input),input);
  for(const metrics of [{durationMs:-1},{durationMs:3_600_001},{bytes:52_428_801},{retries:101},
    {connection:'5g'},{installationId:'private'},{durationMs:1.5},{}])
    assert.throws(()=>validateEvent({releaseId,event:'download_complete',metrics}));
  assert.throws(()=>validateEvent({...input,accountId:'private'}));
});
