/**
 * Dotcom-Tools MCP bridge: connects an MCP client that speaks stdio (Claude Desktop, Cursor, VS Code, ...) to the hosted
 * Dotcom-Tools MCP server. It relays JSON-RPC messages unchanged, so the tools, their descriptions and their results all
 * come from the server: this package never needs an update when tools change.
 *
 * Credentials (one is required):
 *   DOTCOM_TOOLS_API_KEY  your API key (free; create one at https://www.dotcom-tools.com/account#api); it wins
 *   or a device sign-in   stored by `npx @dotcom-tools/mcp login`, sent as a Bearer token and refreshed when needed
 * DOTCOM_TOOLS_URL         optional: the server address (default https://www.dotcom-tools.com/mcp)
 */
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { DeviceTokenSource } from './device.js';
import {
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_URL = 'https://www.dotcom-tools.com/mcp';
const version: string = createRequire(import.meta.url)('../package.json').version;

/** Writes diagnostics to stderr: stdout carries the protocol. Never logs the key or message contents. */
function log(message: string): void {
  process.stderr.write(`[dotcom-tools-mcp] ${message}\n`);
}

export interface BridgeOptions {
  apiKey?: string;
  /** Device sign-in tokens, used when no API key is set. */
  tokens?: DeviceTokenSource;
  url?: string;
}

/** Adds the Bearer token; after a 401 it refreshes once (under the credentials lock) and retries. */
export function bearerFetch(tokens: DeviceTokenSource): FetchLike {
  return async (input, init) => {
    const send = async (force: boolean) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${await tokens.accessToken(force)}`);
      return fetch(input, { ...init, headers });
    };
    const first = await send(false);
    if (first.status !== 401) return first;
    await first.body?.cancel();
    return send(true);
  };
}

/** Starts relaying between this process's stdin/stdout and the hosted server. Resolves once both sides are connected. */
export async function startBridge(options: BridgeOptions): Promise<void> {
  const url = new URL(options.url || DEFAULT_URL);
  const headers: Record<string, string> = { 'User-Agent': `dotcom-tools-mcp/${version} (node ${process.version})` };
  if (options.apiKey) headers['X-Api-Key'] = options.apiKey;
  const remote = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    fetch: !options.apiKey && options.tokens ? bearerFetch(options.tokens) : undefined,
  });
  usingSignIn = !options.apiKey;
  const local = new StdioServerTransport();

  // The HTTP transport sends MCP-Protocol-Version once the initialize handshake settled it.
  const initializeIds = new Set<string | number>();

  local.onmessage = (message: JSONRPCMessage) => {
    if (isJSONRPCRequest(message) && message.method === 'initialize') {
      initializeIds.add(message.id);
    }

    remote.send(message).catch((error: unknown) => {
      const text = explain(error);
      log(`request failed: ${text}`);
      if (isJSONRPCRequest(message)) {
        // Answer the request so the client shows why instead of waiting forever.
        void local.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: text },
        });
      }
    });
  };

  remote.onmessage = (message: JSONRPCMessage) => {
    if (isJSONRPCResultResponse(message) && initializeIds.delete(message.id)) {
      const negotiated = (message.result as { protocolVersion?: unknown }).protocolVersion;
      if (typeof negotiated === 'string') {
        remote.setProtocolVersion(negotiated);
      }
    }

    void local.send(message);
  };

  remote.onerror = (error: Error) => log(`server connection: ${error.message}`);
  local.onerror = (error: Error) => log(`client connection: ${error.message}`);
  local.onclose = () => {
    void remote.close();
  };

  await remote.start();
  await local.start();
  log(`v${version} relaying to ${url.origin}${url.pathname}`);
}

let usingSignIn = false;

/** Turns transport errors into advice for the person setting the client up. */
export function explain(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const status = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined;
  if (/npx @dotcom-tools\/mcp login/.test(text)) {
    return text;
  }

  if ((status === 401 || error instanceof UnauthorizedError) && usingSignIn) {
    return 'Dotcom-Tools rejected the sign-in. Run "npx @dotcom-tools/mcp login" again, or set DOTCOM_TOOLS_API_KEY.';
  }

  if (status === 401 || error instanceof UnauthorizedError) {
    return 'Dotcom-Tools rejected the API key. Check DOTCOM_TOOLS_API_KEY, or create a free key at https://www.dotcom-tools.com/account#api.';
  }

  if (status === 429) {
    return 'Too many requests for this API key (120 a minute, 10 test starts a minute). Wait a minute and try again.';
  }

  return `Could not reach Dotcom-Tools${status ? ` (HTTP ${status})` : ''}: ${text}`;
}
