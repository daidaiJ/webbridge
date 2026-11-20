// Package extension-slim/ as a zip that can be unpacked and loaded in Edge.
// The archive uses stored or deflated entries only, so it needs no zip tool.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildZip, collectFiles } from './zip.mjs';

const source = path.resolve('extension-slim');
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const outputDir = path.resolve('dist');
const output = path.join(outputDir, `browser-bridge-${manifest.version}.zip`);

const REQUIRED = ['manifest.json', 'background.js', 'popup.html', 'popup.js'];

const files = await collectFiles(source);
const names = new Set(files.map((file) => file.name));
for (const required of REQUIRED) {
  if (!names.has(required)) throw new Error(`extension-slim is missing ${required}; run npm run build:slim first`);
}

await mkdir(outputDir, { recursive: true });
await writeFile(output, buildZip(files));

const bytes = files.reduce((total, file) => total + file.data.length, 0);
console.log(
  `package: ${path.relative(process.cwd(), output)} (${files.length} files, ` +
    `${(bytes / 1024 / 1024).toFixed(1)} MB unpacked, version ${manifest.version})`,
);
