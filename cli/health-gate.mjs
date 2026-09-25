import {OTA_SUCCESS_SAMPLE_RATE} from '../dist/telemetry.js';
const FAILURE_EVENTS=['rollback','verification_failed','download_failed'];

/** An optional stop-only gate; untrusted device reports can never authorize a promotion. */
export function assertRolloutHealth(health,releaseId,{minReady=10,maxFailures=0}={}) {
  if (!Number.isSafeInteger(minReady)||minReady<1||minReady>100000 ||
      !Number.isSafeInteger(maxFailures)||maxFailures<0||maxFailures>100000)
    throw new Error('Invalid health gate thresholds');
  if (health?.releaseId!==releaseId || health.sampledSuccessRate!==OTA_SUCCESS_SAMPLE_RATE ||
      !health.counts || typeof health.counts!=='object' || Array.isArray(health.counts))
    throw new Error('Health gate response is invalid');
  const count=(name)=>{
    const value=health.counts[name]??0;
    if(!Number.isSafeInteger(value)||value<0)throw new Error('Health gate response is invalid');
    return value;
  };
  const ready=count('ready');
  const failures=FAILURE_EVENTS.reduce((total,name)=>total+count(name),0);
  if(!Number.isSafeInteger(failures))throw new Error('Health gate response is invalid');
  if(ready<minReady)throw new Error(`Rollout paused: ${ready} sampled ready reports; ${minReady} required`);
  if(failures>maxFailures)throw new Error(`Rollout paused: ${failures} failure reports; maximum ${maxFailures}`);
  return {ready,failures,releaseId};
}
