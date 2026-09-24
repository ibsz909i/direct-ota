import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {verifyCapacitorPlugins} from '../cli/native.mjs';
import {initProject} from '../cli/config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=path.join(root,'cli/index.mjs');
const required={'@capgo/capacitor-updater':'8.51.25','@capacitor/app':'^8.0.0'};
function host(t){
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'direct-ota-discovery-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  fs.symlinkSync(path.join(root,'node_modules'),path.join(fixture,'node_modules'),'dir');
  fs.mkdirSync(path.join(fixture,'www'));fs.writeFileSync(path.join(fixture,'www/index.html'),'<html></html>');
  fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'synthetic-capacitor-host',dependencies:required}));
  fs.writeFileSync(path.join(fixture,'capacitor.config.json'),JSON.stringify({appId:'app.example.demo',appName:'Demo',webDir:'www'}));
  return fixture;
}

test('actual Capacitor 8 discovery finds both direct native plugins on iOS and Android',t=>{
  const fixture=host(t);
  const discovered=verifyCapacitorPlugins(fixture);
  for(const platform of ['ios','android'])assert.deepEqual(discovered[platform].sort(),Object.keys(required).sort());
  fs.writeFileSync(path.join(fixture,'capacitor.config.json'),JSON.stringify({appId:'app.example.demo',appName:'Demo',webDir:'www',ios:{includePlugins:['@capacitor/app']}}));
  assert.throws(()=>verifyCapacitorPlugins(fixture),/ios Capacitor plugin discovery excludes @capgo\/capacitor-updater/);
});

test('native setup and doctor reject a transitively installed plugin',async t=>{
  const fixture=host(t);
  await initProject(fixture,{appId:'app.example.demo',baseUrl:'https://example.invalid'});
  fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'synthetic-capacitor-host',dependencies:{'@capacitor/app':'^8.0.0','direct-ota':'0.1.0'}}));
  assert.throws(()=>verifyCapacitorPlugins(fixture),/direct app dependency/);
  for(const action of ['native','doctor']){
    assert.throws(()=>execFileSync(process.execPath,[cli,action,'--project',fixture],{encoding:'utf8',stdio:'pipe'}),error=>
      error.status===1 && error.stderr.includes('Install @capgo/capacitor-updater as a direct app dependency'));
  }
});
