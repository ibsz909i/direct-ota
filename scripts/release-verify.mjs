#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rm, stat, copyFile, unlink, constants} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const args=process.argv.slice(2);
const outAt=args.indexOf('--out');
if (outAt<0 || !args[outAt+1] || args.length!==2)
  throw Error('Usage: npm run release:verify -- --out DIR');
const out=resolve(args[outAt+1]);
const run=(bin,argv,options={})=>{
  const result=spawnSync(bin,argv,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024,timeout:180000,...options});
  if (result.status!==0) throw Error(`${bin} ${argv[0]} failed: ${(result.stderr||result.stdout||'').slice(-1000)}`);
  return result.stdout;
};
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const version=pkg.version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error('Package version is not a release SemVer');
const [readme,quickstart,changelog]=await Promise.all(['README.md','docs/quickstart.md','CHANGELOG.md'].map(file=>readFile(join(root,file),'utf8')));
if (!readme.includes(`direct-ota-${version}.tgz`) || !quickstart.includes(`direct-ota-${version}.tgz`) || !changelog.includes(`## ${version}`))
  throw Error('README, quickstart and changelog must name the package version');
if (run('git',['status','--porcelain']).trim()) throw Error('Release requires a clean working tree');
const tag=`v${version}`;
const tags=run('git',['tag','--list',tag]).trim();
if (tags && run('git',['rev-list','-n','1',tag]).trim()!==run('git',['rev-parse','HEAD']).trim())
  throw Error('Release tag points to a different commit');
await mkdir(out,{recursive:true});
const tarball=join(out,`direct-ota-${version}.tgz`);
const checksum=join(out,`direct-ota-${version}.sha256`);
for (const file of [tarball,checksum]) {
  try { await stat(file); throw Error('Release output already exists'); }
  catch(error) { if (error.code!=='ENOENT') throw error; }
}
run('npm',['run','check'],{stdio:'inherit',timeout:300000});
run('npm',['audit','--audit-level=high'],{stdio:'inherit',timeout:120000});
const stage=await mkdtemp(join(tmpdir(),'direct-ota-release-stage-'));
try {
  const metadata=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',stage]));
  const packed=Array.isArray(metadata)?metadata[0]:metadata[pkg.name];
  if (packed?.filename!==`direct-ota-${version}.tgz`) throw Error('Unexpected package filename');
  const forbidden=/(^|\/)(\.direct-ota|\.env[^/]*|node_modules|\.git|identity\.json|[^/]+\.map|[^/]+\.(pem|key|p12|pfx))($|\/)/i;
  if (!Array.isArray(packed.files) || packed.files.some(file=>forbidden.test(file.path))) throw Error('Package contains a forbidden path');
  const stagedTarball=join(stage,packed.filename);
  run('python3',['-c',`import sys,tarfile
with tarfile.open(sys.argv[1],'r:gz') as archive:
    for item in archive:
        parts=item.name.split('/')
        if parts[0]!='package' or any(part in ('','.','..') for part in parts) or not (item.isfile() or item.isdir()):
            raise SystemExit('Unsafe package member')`,stagedTarball]);
  const consumer=join(stage,'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer,'package.json'),'{"name":"direct-ota-release-smoke","version":"1.0.0","private":true}');
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund',stagedTarball],{cwd:consumer,timeout:180000});
  const cli=join(consumer,'node_modules/.bin/direct-ota');
  if (!run(cli,['--help'],{cwd:consumer}).includes('signed updates')) throw Error('Installed CLI smoke test failed');
  run('node',['--input-type=module','-e','await import("direct-ota/protocol"); await import("direct-ota/provider"); await import("direct-ota")'],{cwd:consumer});
  const digest=createHash('sha256').update(await readFile(stagedTarball)).digest('hex');
  await copyFile(stagedTarball,tarball,constants.COPYFILE_EXCL);
  try { await writeFile(checksum,`${digest}  direct-ota-${version}.tgz\n`,{flag:'wx'}); }
  catch(error) { await unlink(tarball); throw error; }
  console.log(JSON.stringify({version,commit:run('git',['rev-parse','HEAD']).trim(),tarball,sha256:digest}));
} finally { await rm(stage,{recursive:true,force:true}); }
