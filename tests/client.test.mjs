import test from 'node:test';
import assert from 'node:assert/strict';
import {UpdateActivityGuard} from '../dist/client/activity.js';
import {UpdateCoordinator, sampledForRelease} from '../dist/client/coordinator.js';

test('success sampling is stable per installation and release without transmitting identity',async()=>{
  const release='12345678-1234-4234-8234-123456789abc';
  const selected=await sampledForRelease('synthetic-installation',release);
  assert.equal(await sampledForRelease('synthetic-installation',release),selected);
  const samples=await Promise.all(Array.from({length:1000},(_,i)=>sampledForRelease(`synthetic-${i}`,release)));
  const count=samples.filter(Boolean).length;
  assert.ok(count>=2&&count<=25,`unexpected 1% sample count: ${count}`);
  assert.equal(await sampledForRelease('',release),false);
});

const state={enabled:true,platform:'ios',runtime:'a'.repeat(64),channel:'production',connection:'cellular',phase:'required',received:0,current:'builtin',installationId:'synthetic-install',manifest:'verified-manifest',total:100};
const endpoints={checkUrl:'https://example.invalid/check'};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
async function advance(t,ms){t.mock.timers.tick(ms);await flush();}
function deterministicTime(t){t.mock.timers.enable({apis:['setTimeout','Date'],now:0});t.mock.method(Math,'random',()=>0);}

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

test('background release downloads on Wi-Fi without blocking and activates on next process start',async()=>{
  const background={...state,connection:'wifi',mode:'background',releaseId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
  const first=setup(background),finish=first.guard.begin();
  await first.coordinator.start();await tick();assert.equal(first.downloads.length,0);
  finish();await tick();
  assert.deepEqual(first.downloads,[{allowCellular:false}]);
  assert.equal(first.coordinator.getSnapshot().blocking,false);
  assert.equal(first.activations,0);
  first.coordinator.stop();
  const second=setup({...background,phase:'ready'});
  await second.coordinator.start();await tick();
  assert.equal(second.coordinator.getSnapshot().blocking,true);
  assert.equal(second.activations,1);
  second.coordinator.stop();
});

test('background release never starts a cellular download',async()=>{
  const a=setup({...state,mode:'background',releaseId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',cellularAllowed:true});
  await a.coordinator.start();await tick();
  assert.equal(a.coordinator.getSnapshot().blocking,false);
  assert.equal(a.downloads.length,0);
  await a.coordinator.retry(true);
  assert.equal(a.downloads.length,0);
  a.coordinator.stop();
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
  for(const minutes of [0,4,61,5.5,NaN])assert.throws(()=>new UpdateCoordinator(a.native,{...endpoints,checkIntervalMinutes:minutes},a.guard),/OTA_CONFIG/);
  await a.coordinator.start();await a.coordinator.check(true);
  assert.equal(a.checks,1);a.coordinator.stop();
});

test('push hints are throttled and only trigger the signed metadata path',async t=>{
  deterministicTime(t);
  const a=setup({...state,manifest:undefined,connection:'wifi'});
  try{
    await a.coordinator.start();a.coordinator.hint();await flush();
    assert.equal(a.checks,1);
    a.coordinator.hint();await advance(t,29999);assert.equal(a.checks,1);
    a.coordinator.hint();await flush();assert.equal(a.checks,1);
    await advance(t,1);a.coordinator.hint();await flush();assert.equal(a.checks,2);
  }finally{a.coordinator.stop();t.mock.timers.reset();t.mock.restoreAll();}
});

test('transient downloads use two quick retries, then slower bounded recovery',async t=>{
  deterministicTime(t);
  const a=setup({...state,connection:'wifi',phase:'paused'});
  let attempts=0;
  a.native.otaDownload=async()=>{attempts++;if(attempts<=3)throw Error('OTA_NETWORK');return {...state,connection:'wifi',phase:'ready'};};
  try{
    await a.coordinator.start();await flush();assert.equal(attempts,1);
    await advance(t,1999);assert.equal(attempts,1);
    await advance(t,1);assert.equal(attempts,2);
    await advance(t,5000);assert.equal(attempts,3);
    assert.equal(a.coordinator.getSnapshot().error,'OTA_NETWORK');
    await advance(t,30000);assert.equal(attempts,4);assert.equal(a.activations,1);
  }finally{a.coordinator.stop();t.mock.timers.reset();t.mock.restoreAll();}
});

test('permanent verification failure never retries automatically after network flapping',async t=>{
  deterministicTime(t);
  const a=setup({...state,connection:'wifi',phase:'paused'});
  let attempts=0;a.native.otaDownload=async()=>{attempts++;throw Error('OTA_INVALID');};
  try{
    await a.coordinator.start();await flush();assert.equal(attempts,1);
    a.coordinator.receive({...state,connection:'offline',phase:'paused'});
    a.coordinator.receive({...state,connection:'wifi',phase:'paused'});
    await advance(t,600000);assert.equal(attempts,1);assert.equal(a.activations,0);
  }finally{a.coordinator.stop();t.mock.timers.reset();t.mock.restoreAll();}
});

test('offline and background states pause work and suppress scheduled retries',async t=>{
  deterministicTime(t);
  const a=setup({...state,connection:'offline',phase:'paused'});
  let attempts=0,pauses=0;
  a.native.otaDownload=()=>{attempts++;return new Promise(()=>{});};
  a.native.otaPause=async()=>{pauses++;};
  try{
    await a.coordinator.start();await flush();assert.equal(attempts,0);
    a.coordinator.receive({...state,connection:'wifi',phase:'paused'});
    await advance(t,0);assert.equal(attempts,1);
    a.coordinator.setActive(false);await flush();assert.equal(pauses,1);
    await advance(t,600000);assert.equal(attempts,1);
  }finally{a.coordinator.stop();t.mock.timers.reset();t.mock.restoreAll();}
});

test('metadata Retry-After delays the next check',async t=>{
  deterministicTime(t);
  let checks=0;
  const a=setup({...state,manifest:undefined,connection:'wifi'},async()=>{
    checks++;
    return checks===1?new Response('busy',{status:503,headers:{'retry-after':'30'}}):new Response('{"manifest":null}');
  });
  try{
    await a.coordinator.start();await a.coordinator.check(true);assert.equal(checks,1);
    await advance(t,29999);assert.equal(checks,1);
    await advance(t,1);assert.equal(checks,2);
  }finally{a.coordinator.stop();t.mock.timers.reset();t.mock.restoreAll();}
});
