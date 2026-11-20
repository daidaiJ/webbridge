#!/usr/bin/env node
// Small CLI for driving the same daemon without an MCP client.
//   webbridge status
//   webbridge start
//   webbridge stop
//   webbridge call navigate '{"url":"https://example.com","newTab":true}' --session demo
//   webbridge call read_page '{}'
//   webbridge mcp            # run the MCP server (same as src/server.mjs)

import { DaemonError, call, ensureDaemon, shutdownDaemon, status, stopDaemonIfIdle } from './daemon.mjs';

function usage() {
  console.error(
    [
      'Usage:',
      '  webbridge status',
      '  webbridge start',
      '  webbridge stop',
      '  webbridge call <action> [json-args] [--session NAME] [--timeout MS]',
      '  webbridge mcp',
      '',
      'Env: WEBBRIDGE_URL (default http://127.0.0.1:10086), WEBBRIDGE_SESSION (default grok)',
    ].join('\n'),
  );
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--session' || value === '--timeout') {
      flags[value.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      rest.push(value);
    }
  }
  return { flags, rest };
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);

  if (command === 'mcp') {
    await import('./server.mjs');
    return;
  }
  if (command === 'status') {
    console.log(JSON.stringify((await status()) ?? { running: false }, null, 2));
    return;
  }
  if (command === 'start') {
    console.log(JSON.stringify(await ensureDaemon({ managed: false }), null, 2));
    return;
  }
  if (command === 'stop') {
    console.log(JSON.stringify(await stopDaemonIfIdle({ force: true }), null, 2));
    return;
  }
  if (command === 'call') {
    const action = rest[0];
    if (!action) {
      usage();
      process.exit(2);
    }
    let args = {};
    if (rest[1]) {
      try {
        args = JSON.parse(rest[1]);
      } catch (error) {
        console.error(`invalid JSON args: ${error.message}`);
        process.exit(2);
      }
    }
    const session = flags.session || process.env.WEBBRIDGE_SESSION || 'grok';
    const timeoutMs = flags.timeout ? Number(flags.timeout) : 120_000;
    try {
      const result = await call(action, args, session, timeoutMs);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(JSON.stringify({ error: error.message, code: error.code }, null, 2));
      process.exitCode = 1;
    } finally {
      await shutdownDaemon();
    }
    return;
  }
  usage();
  process.exit(command ? 2 : 0);
}

main().catch((error) => {
  if (error instanceof DaemonError) {
    console.error(`${error.message} [${error.code}]`);
  } else {
    console.error(error?.stack || error);
  }
  process.exit(1);
});
