#!/usr/bin/env node
// Entry point of `npx @dotcom-tools/mcp`: reads the configuration from the environment and starts the bridge.
import { startBridge } from './bridge.js';

const apiKey = process.env.DOTCOM_TOOLS_API_KEY?.trim();
if (!apiKey) {
  process.stderr.write(
    '[dotcom-tools-mcp] DOTCOM_TOOLS_API_KEY is not set. Create a free API key at ' +
      'https://www.dotcom-tools.com/account#api and add it to your MCP client configuration.\n',
  );
  process.exit(1);
}

startBridge({ apiKey, url: process.env.DOTCOM_TOOLS_URL?.trim() }).catch((error: unknown) => {
  process.stderr.write(`[dotcom-tools-mcp] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
