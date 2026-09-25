import {mkdir, cp, readdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Export a provider into a new directory. Existing files are never replaced. */
export async function exportProvider(provider, dest) {
  if (!['node', 'supabase', 'cloudflare', 'firebase'].includes(provider)) throw new Error('Provider must be node, supabase, cloudflare, or firebase');
  await mkdir(dest, {recursive: false});
  const source = join(packageRoot, 'providers', provider);
  const developmentProtocol = join(source, provider === 'cloudflare' ? 'src/protocol.ts' :
    provider === 'firebase' ? 'functions/src/protocol.ts' : 'functions/_shared/protocol.ts');
  const developmentTelemetry = provider === 'cloudflare' ? join(source, 'src/telemetry.ts') :
    provider === 'firebase' ? join(source, 'functions/src/telemetry.ts') : null;
  for (const name of await readdir(source)) {
    if (provider === 'node' && (name === '.gitignore' || name === 'gitignore.template')) continue;
    if (provider === 'cloudflare' && ['.dev.vars', '.wrangler', 'node_modules', 'worker-configuration.d.ts', 'gitignore.template', '.npmignore'].includes(name)) continue;
    if (provider === 'firebase' && ['.firebase', 'gitignore.template', '.npmignore'].includes(name)) continue;
    await cp(join(source, name), join(dest, name), {recursive: true, errorOnExist: true, force: false,
      filter: item => item !== developmentProtocol && item !== developmentTelemetry &&
        !(provider === 'firebase' && (/^functions\/(node_modules|lib)(\/|$)/.test(relative(source, item).replaceAll('\\', '/')) ||
          item === join(source, 'functions/src/provider.ts')))});
  }
  if (provider === 'node' || provider === 'cloudflare' || provider === 'firebase') {
    await cp(join(source, 'gitignore.template'), join(dest, '.gitignore'), {errorOnExist: true, force: false});
    if (provider === 'cloudflare') {
      await cp(join(packageRoot, 'src/protocol.ts'), join(dest, 'src/protocol.ts'), {errorOnExist: true, force: false});
      await cp(join(packageRoot, 'src/telemetry.ts'), join(dest, 'src/telemetry.ts'), {errorOnExist: true, force: false});
    }
    if (provider === 'firebase') {
      await cp(join(packageRoot, 'src/protocol.ts'), join(dest, 'functions/src/protocol.ts'), {errorOnExist: true, force: false});
      await cp(join(packageRoot, 'src/provider.ts'), join(dest, 'functions/src/provider.ts'), {errorOnExist: true, force: false});
      await cp(join(packageRoot, 'src/telemetry.ts'), join(dest, 'functions/src/telemetry.ts'), {errorOnExist: true, force: false});
    }
  } else if (provider === 'supabase') {
    await mkdir(join(dest, 'functions/_shared'), {recursive: true});
    await cp(join(packageRoot, 'src/protocol.ts'), join(dest, 'functions/_shared/protocol.ts'), {errorOnExist: true, force: false});
  }
}

const sqlLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";

/** Fill only public, validated project values in the exported setup statement. */
export async function configureSupabaseExport(dest, config) {
  const file = join(dest, 'setup.sql');
  const template = await readFile(file, 'utf8');
  const values = [config.keyId, config.appId, config.environment, config.artifactBaseUrl];
  if (values.some(value => typeof value !== 'string' || !value)) throw new Error('Missing public Supabase setup value');
  if (!Number.isSafeInteger(config.backendContract) || config.backendContract < 1) throw new Error('Invalid backend contract');
  const match = /VALUES\('REPLACE_WITH_KEY_ID','app\.example\.demo','production','https:\/\/YOUR_PROJECT\.supabase\.co\/storage\/v1\/object\/public\/direct-ota',1,true\);/;
  if (!match.test(template)) throw new Error('Supabase setup template changed; review it before deployment');
  const statement = `VALUES(${values.map(sqlLiteral).join(',')},${config.backendContract},true);`;
  await writeFile(file, template.replace(match, statement), {flag: 'w'});
}
