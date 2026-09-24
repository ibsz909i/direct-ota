import test from 'node:test';
import assert from 'node:assert/strict';
import {UpdateActivityGuard} from '../dist/client/activity.js';
import {UpdateCoordinator} from '../dist/client/coordinator.js';

const state={enabled:true,platform:'ios',runtime:'a'.repeat(64),channel:'production',connection:'cellular',phase:'required',received:0,current:'builtin',installationId:'synthetic-install',manifest:'verified-manifest',total:100};
const endpoints={checkUrl:'https://example.invalid/check'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

function setup(initial=state,respond=async()=>new Response('{"manifest":null}')){
  let current={...initial},downloads=[],activations=0,checks=0;
  const native={otaState:async()=>current,otaAccept:async()=>current,otaDownload:async input=>{downloads.push(input);return {...current,phase:'ready'};},otaPause:async()=>{},otaActivate:async()=>{activations++;},otaReady:async()=>{}};
  const request=async (...args)=>{checks++;return respond(...args);};
  const guard=new UpdateActivityGuard();
  const coordinator=new UpdateCoordinator(native,endpoints,guard,request);
  return {native,guard,coordinator,downloads,get activations(){return activations;},get checks(){return checks;}};
}

test('activity guard waits for open work and releases exactly once',async()=>{
  const guard=new UpdateActivityGuard();const first=guard.begin(),second=guard.begin();
  assert.equal(guard.lock(),false);first();assert.equal(guard.lock(),false);second();second();
  assert.equal(guard.lock(),true);assert.throws(()=>guard.begin(),/OTA_REQUIRED/);guard.unlock();
  await assert.rejects(guard.run(async()=>{throw Error('synthetic failure');}),/synthetic failure/);
  assert.equal(guard.size,0);
});

test('no-update metadata and network failures cannot revoke an accepted update',async()=>{
  const a=setup();await a.coordinator.start();await a.coordinator.check(true);
  assert.equal(a.coordinator.getSnapshot().blocking,true);a.coordinator.stop();
  const b=setup(state,async()=>{throw Error('offline');});await b.coordinator.start();await b.coordinator.check(true);
  assert.equal(b.coordinator.getSnapshot().blocking,true);b.coordinator.stop();
});

test('cellular transfer needs explicit consent and stays locked during open work',async()=>{
  const a=setup(),finish=a.guard.begin();await a.coordinator.start();
  assert.equal(a.coordinator.getSnapshot().blocking,false);finish();
  assert.equal(a.coordinator.getSnapshot().blocking,true);assert.equal(a.downloads.length,0);
  await a.coordinator.retry(true);assert.deepEqual(a.downloads,[{allowCellular:true}]);a.coordinator.stop();
});

test('withdrawal invalidates stale download completion and stops activation',async()=>{
  const a=setup({...state,connection:'wifi'});let resolve;
  a.native.otaDownload=()=>new Promise(done=>{resolve=done;});
  await a.coordinator.start();await tick();
  a.coordinator.receive({...state,manifest:undefined,phase:'idle'});
  resolve({...state,phase:'ready'});await tick();
  assert.equal(a.coordinator.getSnapshot().blocking,false);assert.equal(a.activations,0);a.coordinator.stop();
});

test('endpoint configuration requires HTTPS and optional telemetry stays absent',async()=>{
  const a=setup({...state,manifest:undefined,connection:'wifi'});
  assert.throws(()=>new UpdateCoordinator(a.native,{checkUrl:'http://example.invalid/check'},a.guard),/OTA_CONFIG/);
  await a.coordinator.start();await a.coordinator.check(true);
  assert.equal(a.checks,1);a.coordinator.stop();
});
