import {readFile, lstat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {readConfig} from './config.mjs';

const firebaseCli = ['npx', ['--yes', 'firebase-tools@15.31.0']];
const wranglerCli = ['npx', ['--yes', 'wrangler@4.139.0']];

function execute(binary, args, options = {}) {
  const result = spawnSync(binary, args, {cwd: options.cwd, env: options.env,
    input: options.input, encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024});
  if (result.status !== 0) throw Error(`Deployment command failed: ${args[0] ?? binary} (exit ${result.status ?? 'unknown'})`);
}

/** Deploy only to a pre-provisioned, explicitly selected update-only project. */
export async function guidedDeploy(root, options = {}, run = execute) {
  const config = await readConfig(root);
  const provider = options.provider;
  if (!['cloudflare', 'firebase'].includes(provider)) throw Error('Guided deploy supports Cloudflare or Firebase');
  const service = resolve(root, options.out || 'ota-service');
  if (service !== join(root, 'ota-service')) throw Error('Deploy only the reviewed ota-service directory');
  const trustFile = join(root, '.direct-ota', `${provider}-trust.json`);
  const secretFile = join(root, '.direct-ota', `${provider}-upload-secret`);
  for (const file of [trustFile, secretFile]) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077)))
      throw Error('Provider configuration and secret must be private regular files');
  }
  const trust = JSON.parse(await readFile(trustFile, 'utf8'));
  if (JSON.stringify(trust) !== JSON.stringify(config)) throw Error('Provider trust differs from the installed app configuration');
  const secret = (await readFile(secretFile, 'utf8')).trim();
  if (Buffer.from(secret, 'base64').length !== 32 || Buffer.from(secret, 'base64').toString('base64') !== secret)
    throw Error('Upload secret must be 32 random bytes in base64');
  if (provider === 'cloudflare') {
    const worker = JSON.parse((await readFile(join(service, 'wrangler.jsonc'), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
    const database = worker.d1_databases?.find(row => row.binding === 'DB');
    const bucket = worker.r2_buckets?.find(row => row.binding === 'ARTIFACTS');
    if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(worker.name ?? '') || worker.name === 'direct-ota-example' ||
        !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/.test(database?.database_id ?? '') ||
        !bucket?.bucket_name || bucket.bucket_name === 'direct-ota-example')
      throw Error('Configure a dedicated Worker, D1 database ID, and R2 bucket before deployment');
    if (config.checkUrl !== config.artifactBaseUrl.replace(/\/artifacts$/, '/check')) throw Error('Cloudflare endpoint mismatch');
    const hostname = new URL(config.checkUrl).hostname;
    if (hostname.endsWith('.workers.dev') && !hostname.startsWith(`${worker.name}.`))
      throw Error('Worker name does not match the configured workers.dev origin');
    const accountId = options['account-id'];
    if (!/^[0-9a-f]{32}$/.test(accountId ?? '')) throw Error('Specify --account-id for the exact Cloudflare account');
    const plan = `Cloudflare account ${accountId}: migrate ${database.database_name} (${database.database_id}), set two Worker secrets, deploy ${worker.name}. Existing R2 bucket: ${bucket.bucket_name}. No resource is created or deleted.`;
    if (!options.apply) return {applied: false, plan};
    if (!options.dedicated) throw Error('Pass --dedicated after confirming these are update-only resources');
    const env = {...process.env, CLOUDFLARE_ACCOUNT_ID: accountId, CI: 'true'};
    const call = args => run(wranglerCli[0], [...wranglerCli[1], ...args], {cwd: service, env});
    call(['deploy', '--dry-run']);
    call(['d1', 'migrations', 'apply', 'DB', '--remote']);
    run(wranglerCli[0], [...wranglerCli[1], 'secret', 'put', 'OTA_TRUST_JSON'], {cwd: service, env, input: JSON.stringify(config)});
    run(wranglerCli[0], [...wranglerCli[1], 'secret', 'put', 'OTA_UPLOAD_SECRET'], {cwd: service, env, input: secret});
    call(['deploy', '--strict']);
    return {applied: true, plan};
  }
  const projectId = options.target;
  if (!/^[a-z][a-z0-9-]{4,29}$/.test(projectId ?? '')) throw Error('Specify --target with the exact Firebase project ID');
  if (![`${projectId}.web.app`, `${projectId}.firebaseapp.com`].includes(new URL(config.checkUrl).hostname))
    throw Error('Firebase project ID does not match the installed app update origin');
  const bucketName = options.bucket;
  if (!/^[a-z0-9][a-z0-9._-]{2,222}$/.test(bucketName ?? '')) throw Error('Specify --bucket with an existing private OTA bucket');
  const firebase = JSON.parse(await readFile(join(service, 'firebase.json'), 'utf8'));
  if (firebase.functions?.codebase !== 'direct-ota' || !firebase.hosting?.rewrites?.some(row => row.source === '/artifacts/**'))
    throw Error('Firebase provider export is incomplete');
  const plan = `Firebase project ${projectId}: set two Function secrets and OTA_BUCKET_NAME=${bucketName}; deploy the Direct OTA function, Hosting rewrites, and deny-all Firestore/Storage rules. The project must be dedicated to OTA and already have Firestore, a private bucket, and Blaze billing. No project or bucket is created.`;
  if (!options.apply) return {applied: false, plan};
  if (!options.dedicated) throw Error('Pass --dedicated after confirming this is an update-only Firebase project');
  const envFile = join(service, 'functions', `.env.${projectId}`);
  const desired = `OTA_BUCKET_NAME=${bucketName}\nOTA_PUBLISHER_ENABLED=true\nOTA_EVENTS_ENABLED=false\n`;
  try {
    const existing = await readFile(envFile, 'utf8');
    if (existing !== desired) throw Error('Existing Firebase Function env differs; review it before deployment');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(envFile, desired, {flag: 'wx', mode: 0o600});
  }
  const call = args => run(firebaseCli[0], [...firebaseCli[1], ...args, '--project', projectId], {cwd: service});
  run('npm', ['ci', '--prefix', join(service, 'functions')], {cwd: service});
  run('npm', ['run', 'build', '--prefix', join(service, 'functions')], {cwd: service});
  call(['functions:secrets:set', 'OTA_TRUST_JSON', '--data-file', trustFile]);
  call(['functions:secrets:set', 'OTA_UPLOAD_SECRET', '--data-file', secretFile]);
  call(['deploy', '--only', 'functions:direct-ota:directOta,hosting,firestore:rules,storage']);
  return {applied: true, plan};
}
