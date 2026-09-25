import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {spawn} from 'node:child_process';

const {GITHUB_WORKSPACE,DIRECT_OTA_PROJECT='.',DIRECT_OTA_PLATFORM,DIRECT_OTA_VERSION,DIRECT_OTA_IDENTITY_B64} = process.env;
if (!GITHUB_WORKSPACE || !['ios','android'].includes(DIRECT_OTA_PLATFORM) ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(DIRECT_OTA_VERSION ?? '') ||
    !DIRECT_OTA_IDENTITY_B64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(DIRECT_OTA_IDENTITY_B64))
  throw Error('Invalid Direct OTA action inputs');
const workspace = await realpath(GITHUB_WORKSPACE);
const project = await realpath(resolve(workspace,DIRECT_OTA_PROJECT));
const inside = relative(workspace,project);
if (inside.startsWith('..') || isAbsolute(inside)) throw Error('Project must be inside the GitHub workspace');
const identity = Buffer.from(DIRECT_OTA_IDENTITY_B64,'base64');
if (identity.length < 32 || identity.length > 32768 || identity.toString('base64') !== DIRECT_OTA_IDENTITY_B64) throw Error('Invalid publishing identity encoding');
const directory = await mkdtemp(join(tmpdir(),'direct-ota-action-'));
const identityFile = join(directory,'identity.json');
try {
  await writeFile(identityFile,identity,{flag:'wx',mode:0o600});
  // The installed package is required. npx may not fetch an unreviewed version.
  for (const args of [
    ['--no-install','direct-ota','publish','--project',project,'--identity',identityFile,'--platform',DIRECT_OTA_PLATFORM,'--version',DIRECT_OTA_VERSION],
    ['--no-install','direct-ota','doctor','--project',project,'--remote','--platform',DIRECT_OTA_PLATFORM],
  ]) await new Promise((done,reject)=>{
    const child=spawn('npx',args,{cwd:project,stdio:'inherit',env:{...process.env,DIRECT_OTA_IDENTITY_B64:''}});
    child.on('error',reject);
    child.on('close',(code,signal)=>code===0?done():reject(Error(`Direct OTA action failed (${signal??code})`)));
  });
} finally {
  identity.fill(0);
  await rm(directory,{recursive:true,force:true});
}
