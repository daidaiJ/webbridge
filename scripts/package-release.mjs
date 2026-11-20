// Build the end-user release bundle: skill, MCP server source, docs, and a
// loadable unpacked extension. The bundle never contains the local profiler.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { VERSION } from '../src/version.mjs';
import { buildZip, collectFiles } from './zip.mjs';

const root = `webbridge-${VERSION}`;
const extensionDir = path.resolve('extension-slim');
const outputDir = path.resolve('dist');
const output = path.join(outputDir, `webbridge-${VERSION}.zip`);
const PROFILE_MARKER = '/* __WB_PROFILE__ */';

const background = await readFile(path.join(extensionDir, 'background.js'), 'utf8');
if (background.includes(PROFILE_MARKER)) {
  throw new Error(
    'extension-slim contains the local performance profiler. ' +
      'Run `node local/profile/apply.mjs --remove` (or rebuild with `npm run build:slim`) before packaging.',
  );
}

const files = [];
const addFile = async (source, name = path.basename(source)) => {
  files.push({ name: `${root}/${name}`, data: await readFile(source) });
};
const addDir = async (source, name = source) => {
  const collected = await collectFiles(path.resolve(source), name);
  files.push(...collected.map((file) => ({ name: `${root}/${file.name}`, data: file.data })));
};

for (const file of [
  'README.md',
  'README.EN.md',
  'LICENSE',
  'INSTALL.md',
  'NOTICE.md',
  'DESIGN.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'package.json',
  'package-lock.json',
  'go.mod',
  'go.sum',
]) {
  await addFile(file);
}

// The skill is useful both at the bundle root (copy one file) and in the
// repository's canonical skill/ location.
await addFile('skill/SKILL.md', 'SKILL.md');
await addDir('skill');
await addDir('src');
await addDir('shared');
await addDir('docs');
await addDir(extensionDir, 'extension');
await addDir('cmd');
await addDir('internal');
await addFile('scripts/export-catalog.mjs', 'scripts/export-catalog.mjs');
await addFile('scripts/go-build.mjs', 'scripts/go-build.mjs');
await addFile('test/go-parity.mjs', 'test/go-parity.mjs');
await addFile('test/bench-go.mjs', 'test/bench-go.mjs');

const names = new Set(files.map((file) => file.name));
for (const required of [
  `${root}/SKILL.md`,
  `${root}/src/server.mjs`,
  `${root}/shared/page/reader.js`,
  `${root}/docs/INTEGRATIONS.md`,
  `${root}/extension/manifest.json`,
  `${root}/extension/background.js`,
  `${root}/cmd/webbridge-mcp/main.go`,
  `${root}/internal/catalog/catalog.json`,
  `${root}/go.mod`,
  `${root}/scripts/go-build.mjs`,
]) {
  if (!names.has(required)) throw new Error(`release bundle is missing ${required}`);
}

await mkdir(outputDir, { recursive: true });
await writeFile(output, buildZip(files));

const bytes = files.reduce((total, file) => total + file.data.length, 0);
console.log(
  `release: ${path.relative(process.cwd(), output)} (${files.length} files, ` +
    `${(bytes / 1024 / 1024).toFixed(1)} MB unpacked, version ${VERSION})`,
);
console.log(`  install:   cd ${root} && npm ci --omit=dev`);
console.log(`  extension: load ${root}/extension/ as an unpacked extension`);
console.log(`  skill:     copy ${root}/SKILL.md to the client's skill directory`);
console.log(`  go:        cd ${root} && npm run go:build   # optional MCP entry point`);
