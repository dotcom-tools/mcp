// Device sign-in: `login`, `logout`, `status` and the bridge with stored tokens, against a mock OAuth + MCP server.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-mcp-'));
process.env.DOTCOM_TOOLS_CONFIG_DIR = configDir;
const credentials = path.join(configDir, 'credentials.json');
const { DeviceTokenSource, serverOf } = await import('../dist/device.js');

// ---- mock server -----------------------------------------------------------------------------
const state = {
  polls: 0, pollsAfterSuccess: 0, approvedAt: 2, slowDownAt: 1, deny: false,
  issued: 0, validAccess: new Set(), validRefresh: new Set(), refreshCalls: 0, revoked: [], seenAuth: [], seenKeys: [],
};
const issue = () => {
  state.issued++;
  const access = `at-${state.issued}`, refresh = `rt-${state.issued}`;
  state.validAccess.add(access);
  state.validRefresh.add(refresh);
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'mcp offline_access' };
};
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const form = async (req) => { let b = ''; for await (const c of req) b += c; return Object.fromEntries(new URLSearchParams(b)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/oauth/device') {
    const f = await form(req);
    assert.equal(f.client_id, 'dotcom-tools-device');
    assert.equal(f.scope, 'mcp offline_access');
    return json(res, 200, { device_code: 'dc-1', user_code: 'BCDF-GHJK', verification_uri: `${base}/activate`, expires_in: 600, interval: 1 });
  }

  if (url.pathname === '/oauth/token') {
    const f = await form(req);
    if (f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      if (state.done) { state.pollsAfterSuccess++; return json(res, 400, { error: 'invalid_grant' }); }
      state.polls++;
      if (state.deny) return json(res, 400, { error: 'access_denied' });
      if (state.polls === state.slowDownAt) return json(res, 400, { error: 'slow_down' });
      if (state.polls < state.approvedAt) return json(res, 400, { error: 'authorization_pending' });
      state.done = true;
      return json(res, 200, issue());
    }

    if (f.grant_type === 'refresh_token') {
      state.refreshCalls++;
      if (!state.validRefresh.delete(f.refresh_token)) return json(res, 400, { error: 'invalid_grant', error_description: 'The refresh token is no longer valid.' });
      return json(res, 200, issue());
    }
  }

  if (url.pathname === '/oauth/revoke') {
    const f = await form(req);
    state.revoked.push(f.token);
    state.validRefresh.delete(f.token);
    return json(res, 200, {});
  }

  if (url.pathname === '/mcp') {
    state.seenAuth.push(req.headers.authorization);
    state.seenKeys.push(req.headers['x-api-key']);
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (req.headers['x-api-key'] !== 'dt_key' && !state.validAccess.has(bearer)) return json(res, 401, { title: 'Sign-in required.' });
    const mcp = new McpServer({ name: 'mock', version: '0.0.0' });
    mcp.registerTool('get_credits', { description: 'Mock' }, async () => ({ content: [{ type: 'text', text: 'credits: 50' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    let body = '';
    for await (const chunk of req) body += chunk;
    return transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  }

  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const mcpUrl = `${base}/mcp`;
after(() => { server.close(); fs.rmSync(configDir, { recursive: true, force: true }); });

const env = (extra = {}) => ({ ...process.env, DOTCOM_TOOLS_CONFIG_DIR: configDir, DOTCOM_TOOLS_URL: mcpUrl, DOTCOM_TOOLS_API_KEY: '', ...extra });
const run = (args, extra) => spawnSync(process.execPath, [bin, ...args], { env: env(extra), encoding: 'utf8' });
const runAsync = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [bin, ...args], { env: env() });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.on('close', (status) => resolve({ status, stdout: out }));
});
const stored = () => JSON.parse(fs.readFileSync(credentials, 'utf8')).servers[base];

beforeEach(() => {
  Object.assign(state, { polls: 0, pollsAfterSuccess: 0, approvedAt: 2, slowDownAt: 0, deny: false, done: false, refreshCalls: 0, revoked: [], seenAuth: [], seenKeys: [] });
  fs.rmSync(credentials, { force: true });
});

async function connect(extra = {}) {
  const client = new Client({ name: 'device-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], env: env(extra), stderr: 'pipe' }));
  return client;
}

// ---- tests -----------------------------------------------------------------------------------
test('login shows the link and code, honours slow_down, stops at success and stores the tokens privately', async () => {
  Object.assign(state, { slowDownAt: 1, approvedAt: 3 });
  const started = Date.now();
  const result = await runAsync(['login']);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /\/activate and enter the code: {2}BCDF-GHJK/);
  assert.doesNotMatch(result.stdout, /at-\d|rt-\d/); // never prints tokens
  assert.equal(state.pollsAfterSuccess, 0);
  assert.ok(Date.now() - started >= 6000, 'slow_down adds 5 seconds to the 1-second interval');
  assert.equal(stored().refreshToken, `rt-${state.issued}`);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(credentials).mode & 0o777, 0o600);
    assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
  }
});

test('login stops when the request is denied', async () => {
  state.deny = true;
  const result = await runAsync(['login']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /denied/);
  assert.equal(fs.existsSync(credentials), false);
});

test('the bridge uses the stored sign-in as a Bearer token, and an API key wins over it', async () => {
  assert.equal((await runAsync(['login'])).status, 0);
  const client = await connect();
  try {
    const result = await client.callTool({ name: 'get_credits', arguments: {} });
    assert.equal(result.content[0].text, 'credits: 50');
    assert.ok(state.seenAuth.every((a) => a?.startsWith('Bearer at-')));
  } finally { await client.close(); }

  state.seenAuth = [];
  state.seenKeys = [];
  const keyed = await connect({ DOTCOM_TOOLS_API_KEY: 'dt_key' });
  try {
    await keyed.listTools();
    assert.ok(state.seenKeys.every((k) => k === 'dt_key'));
    assert.ok(state.seenAuth.every((a) => a === undefined));
  } finally { await keyed.close(); }
  assert.match(run(['status'], { DOTCOM_TOOLS_API_KEY: 'dt_key' }).stdout, /Credential in use: API key/);
  assert.match(run(['status']).stdout, /Credential in use: device sign-in/);
});

test('after a 401 the bridge refreshes once and retries', async () => {
  assert.equal((await runAsync(['login'])).status, 0);
  state.validAccess.delete(stored().accessToken); // the server no longer accepts it
  const client = await connect();
  try {
    await client.listTools();
    assert.equal(state.refreshCalls, 1);
  } finally { await client.close(); }
});

test('two processes refreshing at once refresh only once (the second uses the first one\'s tokens)', async () => {
  assert.equal((await runAsync(['login'])).status, 0);
  const s = stored();
  fs.writeFileSync(credentials, JSON.stringify({ version: 1, servers: { [base]: { ...s, accessExpiresAt: new Date(Date.now() - 1000).toISOString() } } }), { mode: 0o600 });
  const [a, b] = await Promise.all([DeviceTokenSource.load(base), DeviceTokenSource.load(base)]);
  const [ta, tb] = await Promise.all([a.accessToken(), b.accessToken()]);
  assert.equal(state.refreshCalls, 1);
  assert.equal(ta, tb);
});

test('an ended sign-in (invalid_grant) deletes the stored tokens and says to log in again', async () => {
  assert.equal((await runAsync(['login'])).status, 0);
  state.validRefresh.clear();
  const source = await DeviceTokenSource.load(base);
  await assert.rejects(source.accessToken(true), /login" again/);
  assert.equal(stored(), undefined);
});

test('logout revokes the refresh token on the server and forgets it', async () => {
  assert.equal((await runAsync(['login'])).status, 0);
  const refresh = stored().refreshToken;
  const result = await runAsync(['logout']); // spawnSync would block this process, which also serves the mock
  assert.equal(result.status, 0);
  assert.match(result.stdout, /disconnected/);
  assert.deepEqual(state.revoked, [refresh]);
  assert.equal(stored(), undefined);
});

test('tokens are only for the server that issued them, and only over https (or localhost)', async () => {
  assert.equal((await runAsync(['login'])).status, 0);
  const other = run([], { DOTCOM_TOOLS_URL: `http://localhost:${server.address().port}/mcp` }); // another origin
  assert.equal(other.status, 1);
  assert.match(other.stderr, /login" to sign in/);
  assert.throws(() => serverOf('http://attacker.example/mcp'), /must use https/);
  assert.equal(serverOf('https://www.dotcom-tools.com/mcp').origin, 'https://www.dotcom-tools.com');
});

if (process.platform !== 'win32') {
  test('a credentials file others can read is refused', async () => {
    assert.equal((await runAsync(['login'])).status, 0);
    fs.chmodSync(credentials, 0o644);
    assert.match(run(['status']).stderr, /can be read by other users/);
    fs.chmodSync(credentials, 0o600);
  });
}
