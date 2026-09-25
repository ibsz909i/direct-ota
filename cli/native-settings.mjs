import {readFile, lstat, writeFile, rename, unlink} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const configNames = ['capacitor.config.json', 'capacitor.config.ts', 'capacitor.config.js'];
const marker = 'DIRECT_OTA_PLUGIN=';

export async function hostPlugin(root) {
  const files = [];
  for (const name of configNames) {
    try {
      const stat = await lstat(join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Capacitor config must be a regular file');
      files.push(name);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (files.length !== 1) throw Error('Use exactly one regular Capacitor config file');
  const require = createRequire(join(root, 'package.json'));
  const cli = require.resolve('@capacitor/cli/dist/config.js');
  const script = `const {loadConfig}=require(process.argv[1]);loadConfig().then(c=>process.stdout.write('${marker}'+JSON.stringify(c.app.extConfig?.plugins?.CapacitorUpdater ?? null)+'\\n')).catch(()=>process.exit(2));`;
  const result = spawnSync(process.execPath, ['-e', script, cli], {
    cwd: root, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw Error('Capacitor config could not be loaded');
  const line = result.stdout?.split('\n').find(value => value.startsWith(marker));
  if (!line) throw Error('Capacitor config did not return plugin settings');
  return {file: files[0], plugin: JSON.parse(line.slice(marker.length))};
}

/** Change only a JSON host's updater entry; never replace another updater identity. */
async function replaceChecked(file, original, updated, mode) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || await readFile(file, 'utf8') !== original)
    throw Error('Capacitor config changed during repair; retry after reviewing it');
  const temporary = join(dirname(file), `.direct-ota-config-${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, updated, {flag: 'wx', mode});
    const latest = await lstat(file);
    if (latest.ino !== stat.ino || latest.isSymbolicLink() || await readFile(file, 'utf8') !== original)
      throw Error('Capacitor config changed during repair; retry after reviewing it');
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function mergeJsonPlugin(root, expected, config) {
  const file = join(root, 'capacitor.config.json');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Capacitor JSON config must be a regular file');
  const original = await readFile(file, 'utf8');
  const document = JSON.parse(original);
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw Error('Invalid Capacitor JSON config');
  if (document.plugins === undefined) document.plugins = {};
  if (!document.plugins || typeof document.plugins !== 'object' || Array.isArray(document.plugins))
    throw Error('Capacitor plugins must be an object');
  const current = document.plugins.CapacitorUpdater;
  if (isDeepStrictEqual(current, expected)) return false;
  if (current !== undefined && (!current || typeof current !== 'object' || Array.isArray(current) ||
      current.directOtaAppId !== config.appId || current.directOtaKeyId !== (config.trustedKeys?.[0]?.keyId ?? config.keyId) ||
      current.directOtaArtifactBaseUrl !== config.artifactBaseUrl))
    throw Error('Existing CapacitorUpdater settings belong to another integration; review manually');
  document.plugins.CapacitorUpdater = expected;
  const indent = /^\s+"[^"\n]+":/m.exec(original)?.[0].match(/^\s+/)?.[0] ?? '  ';
  const updated = JSON.stringify(document, null, indent) + '\n';
  await replaceChecked(file, original, updated, stat.mode & 0o777);
  return true;
}

export async function repairGeneratedPlugin(root, expected) {
  const file = join(root, 'direct-ota.capacitor.json');
  const updated = JSON.stringify(expected, null, 2) + '\n';
  let stat;
  try { stat = await lstat(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(file, updated, {flag:'wx', mode:0o644});
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Generated settings must be a regular file');
  await replaceChecked(file, await readFile(file, 'utf8'), updated, stat.mode & 0o777);
}

/** Insert one import/property into a simple TypeScript object literal, preserving surrounding code. */
export async function mergeTypeScriptPlugin(root, expected, {dryRun = false} = {}) {
  const file = join(root, 'capacitor.config.ts');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Capacitor TypeScript config must be a regular file');
  const original = await readFile(file, 'utf8');
  const require = createRequire(join(root, 'package.json'));
  const ts = require('typescript');
  const source = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length) throw Error('Capacitor TypeScript config has syntax errors; merge manually');
  const assignment = source.statements.find(node => ts.isExportAssignment(node) && !node.isExportEquals);
  let object = assignment?.expression;
  if (object && ts.isIdentifier(object)) {
    const declaration = source.statements.filter(ts.isVariableStatement)
      .flatMap(node => [...node.declarationList.declarations])
      .find(node => ts.isIdentifier(node.name) && node.name.text === object.text);
    object = declaration?.initializer;
  }
  if (!object || !ts.isObjectLiteralExpression(object)) throw Error('Capacitor TypeScript config is dynamic; merge manually');
  const named = (node, name) => ts.isPropertyAssignment(node) &&
    ((ts.isIdentifier(node.name) && node.name.text === name) || (ts.isStringLiteral(node.name) && node.name.text === name));
  if (object.properties.some(node => ts.isSpreadAssignment(node))) throw Error('Capacitor config uses spreads; merge manually');
  const plugins = object.properties.find(node => named(node, 'plugins'));
  if (plugins && (!ts.isObjectLiteralExpression(plugins.initializer) ||
      plugins.initializer.properties.some(node => ts.isSpreadAssignment(node))))
    throw Error('Capacitor plugins are dynamic; merge manually');
  if (plugins?.initializer.properties.some(node => named(node, 'CapacitorUpdater')))
    throw Error('Existing CapacitorUpdater settings require a reviewed manual merge');
  if (source.statements.some(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === './direct-ota.capacitor.json'))
    throw Error('Existing Direct OTA import requires a reviewed manual merge');
  if (source.statements.some(node => ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'directOtaUpdaterConfig')))
    throw Error('Config already defines directOtaUpdaterConfig; merge manually');
  const target = plugins ? plugins.initializer : object;
  const position = target.getEnd() - 1;
  const last = target.properties.at(-1);
  const needsComma = last && !original.slice(last.getEnd(), position).includes(',');
  const indent = /^([ \t]*)[^\n]*plugins\s*:/m.exec(original)?.[1] ?? '  ';
  const entryIndent = plugins ? indent + '  ' : indent;
  const entry = plugins ? `\n${entryIndent}CapacitorUpdater: directOtaUpdaterConfig,` :
    `\n${entryIndent}plugins: {CapacitorUpdater: directOtaUpdaterConfig},`;
  const commaAt = needsComma ? last.getEnd() : -1;
  const updatedBody = original.slice(0, position) + entry + original.slice(position);
  const withComma = commaAt < 0 ? updatedBody : updatedBody.slice(0, commaAt) + ',' + updatedBody.slice(commaAt);
  const updated = `import directOtaUpdaterConfig from './direct-ota.capacitor.json';\n` + withComma;
  if (dryRun) return true;
  await replaceChecked(file, original, updated, stat.mode & 0o777);
  if (!isDeepStrictEqual((await hostPlugin(root)).plugin, expected))
    throw Error('TypeScript config did not load generated settings; inspect the local change before syncing');
  return true;
}
