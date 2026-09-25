import {mkdir, cp, writeFile} from 'node:fs/promises';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Create an implementation skeleton. All adapter methods fail closed until implemented. */
export async function createProviderScaffold(dest, name) {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(name)) throw Error('Use a lowercase provider name with 2–63 letters, digits, or hyphens');
  await mkdir(dest, {recursive: false});
  await mkdir(join(dest, 'src'));
  for (const file of ['protocol.ts', 'provider.ts', 'telemetry.ts'])
    await cp(join(packageRoot, 'src', file), join(dest, 'src', file), {errorOnExist: true, force: false});
  await writeFile(join(dest, 'package.json'), JSON.stringify({name: `direct-ota-provider-${name}`, version: '0.1.0',
    private: true, type: 'module', scripts: {typecheck: 'tsc --noEmit', build: 'tsc'},
    devDependencies: {'@types/node': '^24.0.0', typescript: '~5.9.3'}}, null, 2) + '\n', {flag: 'wx'});
  await writeFile(join(dest, 'tsconfig.json'), JSON.stringify({compilerOptions: {target: 'ES2022', module: 'NodeNext',
    moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], strict: true, outDir: 'dist', skipLibCheck: true},
    include: ['src/**/*.ts']}, null, 2) + '\n', {flag: 'wx'});
  await writeFile(join(dest, '.gitignore'), 'node_modules/\ndist/\n.env\n.env.*\n*.key\n*.pem\n', {flag: 'wx'});
  await writeFile(join(dest, 'src/index.ts'), `import {createProvider, type ProviderAdapter} from './provider.js';
import type {OtaTrust} from './protocol.js';

/** Implement every method with atomic persistence before serving traffic. */
export function create${name.replace(/(^|-)([a-z])/g, (_, _dash, char) => char.toUpperCase())}Provider(trust: OtaTrust, adapter: ProviderAdapter) {
  return createProvider(trust, adapter, {publisherEnabled: true});
}
`, {flag: 'wx'});
  await writeFile(join(dest, 'README.md'), `# ${name} Direct OTA provider\n\nThis is a provider scaffold, not a deployable service. It includes the canonical signed HTTP admission layer and types. Implement the \`ProviderAdapter\` against your storage and database, expose \`provider.fetch(request)\` through your web framework, and configure HTTPS.\n\n## Required guarantees\n\n- Keep the publisher signing key on the publisher machine. Configure only public trust on this service.\n- Atomically reject replayed command nonces for longer than the signed-command lifetime.\n- Reserve immutable artifact paths; validate hash and size before upload and again before promotion.\n- Use a conditional channel update on the expected prior sequence.\n- Serve immutable artifacts with HEAD and byte ranges. Restrict upload destinations and deletion.\n- Limit metadata/body sizes, rate-limit writes, and never log signed upload capabilities.\n- Run \`direct-ota test-provider\` read-only, then \`direct-ota test-provider --write\` against an isolated test deployment.\n\nSee Direct OTA's protocol and security docs before enabling production.\n`, {flag: 'wx'});
  await writeFile(join(dest, 'AGENTS.md'), `# Provider agent notes\n\nImplement the ProviderAdapter contract in src/provider.ts using the target backend's atomic transactions and immutable object storage. Do not weaken signature checks or put publishing private keys in the service. Test read-only conformance first, then synthetic write conformance on an isolated deployment. Review account, billing, permissions, and exact target before deployment.\n`, {flag: 'wx'});
  return dest;
}
