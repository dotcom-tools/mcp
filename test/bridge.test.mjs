// End-to-end test of the bridge: an MCP client on stdio -> dist/index.js -> a mock Streamable HTTP server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

const KEY = 'dt_test-key';
const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const seenKeys = [];

const server = http.createServer(async (req, res) => {
  seenKeys.push(req.headers['x-api-key']);
  if (req.headers['x-api-key'] !== KEY) {
    res.writeHead(401, { 'content-type': 'application/problem+json' });
    res.end(JSON.stringify({ title: 'API key required.' }));
    return;
  }

  // Stateless, like the hosted server: a fresh server and transport per request.
  const mcp = new McpServer({ name: 'mock-dotcom-tools', version: '0.0.0' });
  mcp.registerTool('run_test', { description: 'Mock run', inputSchema: { target: z.string() } }, async ({ target }, extra) => {
    if (extra._meta?.progressToken !== undefined) {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: extra._meta.progressToken, progress: 1, total: 2, message: '1 of 2 locations finished' },
      });
      // Like the real server, which reports progress while it polls: the result never overtakes the notification.
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { content: [{ type: 'text', text: `tested ${target}` }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  let body = '';
  for await (const chunk of req) body += chunk;
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/mcp`;
after(() => server.close());

async function connect(apiKey) {
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin],
    env: { ...process.env, DOTCOM_TOOLS_API_KEY: apiKey, DOTCOM_TOOLS_URL: url },
    stderr: 'pipe',
  });
  await client.connect(transport);
  return client;
}

test('relays tools, calls and progress with the API key', async () => {
  const client = await connect(KEY);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['run_test']);

    const progress = [];
    const result = await client.callTool({ name: 'run_test', arguments: { target: 'example.com' } }, undefined, {
      onprogress: (p) => progress.push(p),
    });
    assert.equal(result.content[0].text, 'tested example.com');
    assert.equal(progress.length, 1);
    assert.equal(progress[0].message, '1 of 2 locations finished');
    assert.ok(seenKeys.every((k) => k === KEY));
  } finally {
    await client.close();
  }
});

test('explains a rejected API key', async () => {
  await assert.rejects(connect('dt_wrong'), /rejected the API key/);
});

test('exits with advice when no key is set', async () => {
  const { spawnSync } = await import('node:child_process');
  const run = spawnSync(process.execPath, [bin], { env: { ...process.env, DOTCOM_TOOLS_API_KEY: '' }, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /DOTCOM_TOOLS_API_KEY is not set/);
});
