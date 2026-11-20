// Export the canonical Node tool catalog for the Go MCP server. The Node file
// stays the single source of truth; run `npm run catalog:export` after changing
// a tool definition.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describeTool, overview, signature } from '../src/catalog.mjs';
import { CORE_TOOL_NAMES, CORE_TOOLS, TOOLS } from '../src/tools.mjs';
import { VERSION } from '../src/version.mjs';

const core = new Set(CORE_TOOL_NAMES);
const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));

function summaryOf(tool, described) {
  if (described?.summary) return described.summary;
  const first = String(tool.description || '').split('. ')[0];
  return first.endsWith('.') ? first : `${first}.`;
}

const tools = TOOLS.map((tool) => {
  const described = describeTool(tool.name);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.timeoutMs ? { timeoutMs: tool.timeoutMs } : {}),
    core: core.has(tool.name),
    group: described?.group || 'core',
    summary: summaryOf(tool, described),
    signature: signature(tool),
    ...(described?.example ? { example: described.example } : {}),
    ...(described?.related ? { related: described.related } : {}),
  };
});

for (const tool of CORE_TOOLS) {
  if (byName.has(tool.name)) continue;
  tools.push({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    core: true,
    group: 'meta',
    summary: summaryOf(tool, null),
    signature: signature(tool),
  });
}

const data = overview();
const catalog = {
  version: VERSION,
  core: CORE_TOOLS.map((tool) => tool.name),
  workflow: data.workflow,
  hint: data.hint,
  groups: data.groups,
  tools,
};

const out = path.join('internal', 'catalog', 'catalog.json');
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`catalog: ${tools.length} tools -> ${out}`);
