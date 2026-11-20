#!/usr/bin/env node
// MCP server that exposes a local browser bridge daemon as browser tools.
// Architecture: MCP client <-stdio-> this process <-HTTP-> daemon
// <-WebSocket-> browser extension <-CDP-> the user's real browser.

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { recordActivity } from './activity.mjs';
import { adaptToolCall } from './actions.mjs';
import { consoleMessages } from './console.mjs';
import { DaemonError, call, ensureDaemon, shutdownDaemon, status } from './daemon.mjs';
import { captureCurrentTab, startCaptureReceiver } from './capture.mjs';
import { extractItems } from './extract.mjs';
import { readArticle } from './reader.mjs';
import { requestHuman } from './human.mjs';
import { describeTool, overview, searchTools, unknownToolMessage, validateArgs } from './catalog.mjs';
import { TOOL_BY_NAME, TOOLS, CORE_TOOLS, CORE_TOOL_NAMES } from './tools.mjs';
import { VERSION } from './version.mjs';

const MAX_INLINE_IMAGE_BYTES = 6 * 1024 * 1024;
const DEFAULT_SESSION = process.env.WEBBRIDGE_SESSION || 'grok';
const DEFAULT_GROUP_TITLE = process.env.WEBBRIDGE_GROUP_TITLE || '';

let session = DEFAULT_SESSION;
let toolset = 'core';
let listedTools = CORE_TOOLS;
let listedToolByName = new Map(CORE_TOOLS.map((tool) => [tool.name, tool]));

const CORE_TOOL_SET = new Set(CORE_TOOL_NAMES);

function configureToolset() {
  const requested = String(process.env.WEBBRIDGE_TOOLSET || 'core').trim().toLowerCase();
  if (requested !== 'core' && requested !== 'full') {
    throw new Error(`WEBBRIDGE_TOOLSET must be "core" or "full" (got "${requested}")`);
  }
  toolset = requested;
  listedTools = requested === 'full' ? TOOLS : CORE_TOOLS;
  listedToolByName = new Map(listedTools.map((tool) => [tool.name, tool]));
}

const JSON_OUT = (value) => JSON.stringify(value, null, 2);

async function imageContent(result) {
  if (!result || typeof result.path !== 'string' || !isAbsolute(result.path)) return null;
  try {
    const info = await stat(result.path);
    if (!info.isFile() || info.size > MAX_INLINE_IMAGE_BYTES) return null;
    const data = await readFile(result.path);
    return {
      type: 'image',
      data: data.toString('base64'),
      mimeType: result.mimeType || 'image/png',
    };
  } catch {
    return null;
  }
}

async function runTool(name, args) {
  if (name === 'status') {
    const state = await status();
    const profile = { toolset, tools: listedTools.length };
    return {
      result: state
        ? { ...state, ...profile }
        : { running: false, hint: 'browser tools start the daemon on demand', ...profile },
    };
  }
  if (name === 'start') {
    return { result: await ensureDaemon() };
  }
  if (name === 'session') {
    session = String(args.name).trim();
    return { result: { session } };
  }
  if (name === 'browser_tools') {
    const target = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (target) {
      const described = describeTool(target);
      if (!described) throw new Error(unknownToolMessage(target));
      return { result: described };
    }
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    return { result: query ? searchTools(query) : overview() };
  }
  if (name === 'browser_call') {
    const target = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (!target) throw new Error('browser_call: tool is required. Call browser_tools with no arguments for the catalog.');
    if (target === 'browser_call' || target === 'browser_tools') {
      throw new Error(`browser_call: ${target} manages the catalog; call it directly.`);
    }
    if (CORE_TOOL_SET.has(target)) {
      throw new Error(`browser_call: ${target} is a core tool; call it directly.`);
    }
    const definition = TOOL_BY_NAME.get(target);
    if (!definition) throw new Error(unknownToolMessage(target));
    if (args.args !== undefined && (typeof args.args !== 'object' || args.args === null || Array.isArray(args.args))) {
      throw new Error(
        `browser_call: args for ${target} must be an object. Call browser_tools {tool:"${target}"} for the schema.`,
      );
    }
    const targetArgs = args.args || {};
    const errors = validateArgs(definition, targetArgs);
    if (errors.length > 0) {
      throw new Error(
        `Invalid arguments for ${target}: ${errors.join('; ')}. Call browser_tools {tool:"${target}"} for the schema.`,
      );
    }
    return runTool(target, targetArgs);
  }
  if (name === 'read_article') {
    return { result: await readArticle(args, session) };
  }
  if (name === 'capture_page') {
    return { result: await captureCurrentTab({ ...args, session }) };
  }
  if (name === 'extract') {
    return { result: await extractItems(args, session) };
  }
  if (name === 'console') {
    return { result: await consoleMessages(args, session) };
  }
  if (name === 'request_human') {
    return { result: await requestHuman(args, session) };
  }
  if (name === 'batch') {
    const steps = Array.isArray(args.steps) ? args.steps.slice(0, 40) : [];
    const stopOnError = args.stop_on_error !== false;
    const results = [];
    for (const [index, step] of steps.entries()) {
      const tool = String(step?.tool || '');
      if (!TOOL_BY_NAME.has(tool) || tool === 'batch' || tool === 'request_human') {
        results.push({ index, tool, ok: false, error: 'step tool is not supported' });
        if (stopOnError) break;
        continue;
      }
      const stepArgs = step?.args && typeof step.args === 'object' && !Array.isArray(step.args) ? step.args : {};
      const errors = validateArgs(TOOL_BY_NAME.get(tool), stepArgs);
      if (errors.length > 0) {
        results.push({ index, tool, ok: false, error: `invalid arguments: ${errors.join('; ')}` });
        if (stopOnError) break;
        continue;
      }
      try {
        const { result } = await runTool(tool, stepArgs);
        results.push({ index, tool, ok: true, result });
      } catch (error) {
        results.push({ index, tool, ok: false, error: error?.message || String(error) });
        if (stopOnError) break;
      }
    }
    return { result: { steps: results } };
  }

  const forwarded = { ...args };
  if (name === 'navigate') {
    if (forwarded.group_title === undefined && DEFAULT_GROUP_TITLE) {
      forwarded.group_title = DEFAULT_GROUP_TITLE;
    }
  }

  const adapted = adaptToolCall(name, forwarded);
  const timeoutMs = TOOL_BY_NAME.get(name)?.timeoutMs;
  const result = adapted
    ? await call(adapted.action, adapted.args, session, timeoutMs)
    : await call(name, forwarded, session, timeoutMs);
  if (name === 'screenshot') {
    const image = await imageContent(result);
    return { result, image };
  }
  return { result };
}

async function main() {
  configureToolset();
  const server = new Server(
    { name: 'webbridge', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listedTools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};
    const definition = listedToolByName.get(name);
    if (!definition) {
      const hint =
        toolset === 'core'
          ? ` "${name}" is not in the core toolset; call browser_tools to find it, then browser_call.`
          : '';
      return { content: [{ type: 'text', text: `unknown tool: ${name}.${hint}` }], isError: true };
    }
    const invalid = validateArgs(definition, args);
    if (invalid.length > 0) {
      const hint = toolset === 'core' ? ` Call browser_tools {tool:"${name}"} for the schema.` : '';
      const text = `Invalid arguments for ${name}: ${invalid.join('; ')}.${hint}`;
      recordActivity({ tool: name, session, ok: false, ms: 0, detail: text });
      return { content: [{ type: 'text', text }], isError: true };
    }
    const started = Date.now();
    try {
      const { result, image } = await runTool(name, args);
      recordActivity({ tool: name, session, ok: true, ms: Date.now() - started });
      const content = [];
      if (image) content.push(image);
      content.push({
        type: 'text',
        text: typeof result === 'string' ? result : JSON_OUT(result),
      });
      return { content };
    } catch (error) {
      const code = error instanceof DaemonError && error.code ? ` [${error.code}]` : '';
      let text = `${error?.message || String(error)}${code}`;
      if (error instanceof DaemonError && error.code === 'timeout') {
        if (name === 'snapshot') {
          text +=
            ' The page may still be loading or the JSON tree is very large. Retry with format:"aria" and max_chars, ' +
            'call snapshot with a ref, or wait for a selector first.';
        } else if (name === 'read_page') {
          text += ' Reduce max_chars, continue with start, or wait for the page to settle first.';
        }
      }
      recordActivity({ tool: name, session, ok: false, ms: Date.now() - started, detail: text });
      return { content: [{ type: 'text', text }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const receiver = startCaptureReceiver({
    onError: (error) => console.error(`webbridge: capture receiver: ${error?.message || error}`),
  });
  console.error(`webbridge: toolset ${toolset} (${listedTools.length} tools)`);
  console.error(`webbridge: captures -> ${receiver.dir} (http://${receiver.host}:${receiver.port}/capture)`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch {
      // The transport may already be closed.
    }
    receiver.server.close();
    try {
      await shutdownDaemon();
    } catch {
      // A failed cleanup must not prevent the client from exiting.
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.once('end', () => void shutdown());
}

main().catch((error) => {
  console.error(`webbridge: ${error?.message || error}`);
  process.exit(1);
});
