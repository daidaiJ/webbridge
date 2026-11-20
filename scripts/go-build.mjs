// Build the Go MCP front end into dist with a platform-appropriate name.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ext = process.platform === 'win32' ? '.exe' : '';
const output = path.join('dist', `webbridge-mcp${ext}`);
mkdirSync('dist', { recursive: true });
execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w', '-o', output, './cmd/webbridge-mcp'], {
  stdio: 'inherit',
});
console.log(`go: ${output}`);
