#!/usr/bin/env node
// Entry point of `npx @dotcom-tools/mcp`:
//   (no command)  run the MCP bridge on stdio (what MCP clients start)
//   login         sign in from a machine without a browser (device code); not for unattended CI
//   logout        disconnect this machine and forget its tokens
//   status        show which credential the bridge uses
import { startBridge, DEFAULT_URL } from './bridge.js';
import { DeviceTokenSource, login, logout, serverOf, status } from './device.js';

const fail = (message: string): never => {
  process.stderr.write(`[dotcom-tools-mcp] ${message}\n`);
  process.exit(1);
};

const command = process.argv[2];
const apiKey = process.env.DOTCOM_TOOLS_API_KEY?.trim() || undefined;
const url = process.env.DOTCOM_TOOLS_URL?.trim() || DEFAULT_URL;

async function main(): Promise<void> {
  switch (command) {
    case 'login':
      process.exit(await login(url));
    case 'logout':
      process.exit(await logout(url));
    case 'status':
      process.exit(await status(url, apiKey !== undefined));
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(
        'Usage: npx @dotcom-tools/mcp [login | logout | status]\n' +
          '  no command  run the MCP server bridge (MCP clients start it this way)\n' +
          '  login       sign in with a code you approve on any device (for machines without a browser; not for CI)\n' +
          '  logout      disconnect this machine and forget its tokens\n' +
          '  status      show which credential is used\n' +
          'Environment: DOTCOM_TOOLS_API_KEY (wins over a stored sign-in), DOTCOM_TOOLS_URL (default ' + DEFAULT_URL + ')\n',
      );
      process.exit(0);
    case undefined:
      break;
    default:
      fail(`Unknown command "${command}". Use login, logout, status, or no command to run the bridge.`);
  }

  if (apiKey) {
    await startBridge({ apiKey, url });
    return;
  }

  const tokens = await DeviceTokenSource.load(serverOf(url).origin);
  if (!tokens) {
    fail(
      'DOTCOM_TOOLS_API_KEY is not set. Create a free API key at https://www.dotcom-tools.com/account#api and add it to your MCP ' +
        'client configuration, or run "npx @dotcom-tools/mcp login" to sign in on this machine (not for CI).',
    );
  }

  await startBridge({ tokens, url });
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
