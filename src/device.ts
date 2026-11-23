/**
 * Device sign-in (OAuth 2.0 device authorization grant, RFC 8628) for machines without a browser:
 * `login` shows a link and a code, a person approves on any device, and the tokens are stored per server origin.
 * The bridge then sends them as a Bearer token and refreshes them under the credentials lock.
 */
import { readTokens, saveTokens, withLock, credentialsPath, windowsAclWarning, type StoredTokens } from './credentials.js';

export const CLIENT_ID = 'dotcom-tools-device';
const SCOPE = 'mcp offline_access';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const REFRESH_EARLY_MS = 2 * 60_000;
const IDLE_DAYS = 60;

/** The MCP endpoint and its origin. Tokens go only to https servers (or localhost for development). */
export function serverOf(mcpUrl: string): { mcpUrl: string; origin: string } {
  const url = new URL(mcpUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`Refusing to use sign-in tokens with ${url.origin}: the server must use https.`);
  }

  return { mcpUrl: `${url.origin}${url.pathname}`, origin: url.origin };
}

async function postForm(url: string, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; retryAfter?: number }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: 'unexpected_response', error_description: text.slice(0, 200) };
  }

  const retry = Number(response.headers.get('retry-after'));
  return { status: response.status, body, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined };
}

function tokensFrom(body: Record<string, unknown>, previous?: StoredTokens): StoredTokens {
  const now = new Date();
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    throw new Error('The server did not return the expected tokens.');
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    accessExpiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    signedInAt: previous?.signedInAt ?? now.toISOString(),
    lastRefreshedAt: now.toISOString(),
  };
}

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** `login`: prints the link and code, polls until approved, denied or expired, then stores the tokens. */
export async function login(mcpUrl: string, out: (line: string) => void = (l) => process.stdout.write(l + '\n')): Promise<number> {
  const { origin } = serverOf(mcpUrl);
  const start = await postForm(`${origin}/oauth/device`, { client_id: CLIENT_ID, scope: SCOPE, resource: serverOf(mcpUrl).mcpUrl });
  if (start.status !== 200 || typeof start.body.device_code !== 'string') {
    out(`Sign-in could not start: ${start.body.error_description ?? start.body.error ?? `HTTP ${start.status}`}`);
    return 1;
  }

  const deviceCode = start.body.device_code;
  let interval = typeof start.body.interval === 'number' ? start.body.interval : 5;
  const expiresAt = Date.now() + (typeof start.body.expires_in === 'number' ? start.body.expires_in : 600) * 1000;
  out('');
  out(`  Open ${String(start.body.verification_uri)} and enter the code:  ${String(start.body.user_code)}`);
  out('');
  out('  Sign in with your Dotcom-Tools account (or create a free one) and approve. The code expires in 10 minutes.');
  out('  Only approve a code you started yourself. Waiting for approval...');

  while (Date.now() < expiresAt) {
    await sleep(interval);
    const poll = await postForm(`${origin}/oauth/token`, { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: CLIENT_ID });
    if (poll.status === 200) {
      // Stop polling at once: a second exchange of the same device code makes the server end the connection.
      const tokens = tokensFrom(poll.body);
      await withLock(() => saveTokens(origin, tokens));
      out('');
      out(`Signed in to ${origin}. Tokens saved in ${credentialsPath()}.`);
      const warning = windowsAclWarning();
      if (warning) out(warning);
      return 0;
    }

    switch (poll.body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval = Math.max(interval + 5, poll.retryAfter ?? 0);
        continue;
      case 'access_denied':
        out('The request was denied. Nothing was saved.');
        return 1;
      case 'expired_token':
        out('The code expired. Run login again.');
        return 1;
      default:
        if (poll.status === 429) {
          interval = Math.max(interval, poll.retryAfter ?? interval + 5);
          continue;
        }

        out(`Sign-in failed: ${String(poll.body.error_description ?? poll.body.error ?? `HTTP ${poll.status}`)}`);
        return 1;
    }
  }

  out('The code expired. Run login again.');
  return 1;
}

/** `logout`: revokes the connection on the server (the whole connection, not just one token) and forgets the tokens. */
export async function logout(mcpUrl: string, out: (line: string) => void = (l) => process.stdout.write(l + '\n')): Promise<number> {
  const { origin } = serverOf(mcpUrl);
  return withLock(async () => {
    const tokens = await readTokens(origin);
    if (!tokens) {
      out(`Not signed in to ${origin}.`);
      return 0;
    }

    let revoked = false;
    try {
      const result = await postForm(`${origin}/oauth/revoke`, { token: tokens.refreshToken, token_type_hint: 'refresh_token', client_id: CLIENT_ID });
      revoked = result.status === 200;
    } catch {
      revoked = false;
    }

    await saveTokens(origin, undefined);
    out(revoked
      ? `Signed out of ${origin}. This device is disconnected.`
      : `Signed out on this machine only: ${origin} couldn't be reached. Disconnect the device under Account > Connected apps.`);
    return 0;
  });
}

/** `status`: which credential the bridge will use, and the stored sign-in's dates. Never prints tokens or keys. */
export async function status(mcpUrl: string, apiKeySet: boolean, out: (line: string) => void = (l) => process.stdout.write(l + '\n')): Promise<number> {
  const { origin } = serverOf(mcpUrl);
  const tokens = await readTokens(origin);
  out(`Server: ${origin}`);
  out(`Credential in use: ${apiKeySet ? 'API key (DOTCOM_TOOLS_API_KEY; it wins over a stored sign-in)' : tokens ? 'device sign-in' : 'none'}`);
  if (tokens) {
    const idleUntil = new Date(new Date(tokens.lastRefreshedAt).getTime() + IDLE_DAYS * 86_400_000);
    out(`Signed in: ${tokens.signedInAt}`);
    out(`Last refreshed: ${tokens.lastRefreshedAt}`);
    out(`Signs out if unused until: ${idleUntil.toISOString()} (and a year after signing in at the latest)`);
  } else if (!apiKeySet) {
    out('Run "npx @dotcom-tools/mcp login" to sign in, or set DOTCOM_TOOLS_API_KEY.');
  }

  return 0;
}

/** Gives the bridge a valid access token, refreshing under the lock when it is about to expire (or after a 401). */
export class DeviceTokenSource {
  private current: StoredTokens | undefined;

  constructor(private readonly origin: string) {}

  static async load(origin: string): Promise<DeviceTokenSource | undefined> {
    const source = new DeviceTokenSource(origin);
    source.current = await readTokens(origin);
    return source.current ? source : undefined;
  }

  async accessToken(forceRefresh = false): Promise<string> {
    const tokens = this.current;
    if (tokens && !forceRefresh && new Date(tokens.accessExpiresAt).getTime() - Date.now() > REFRESH_EARLY_MS) {
      return tokens.accessToken;
    }

    return withLock(async () => {
      const stored = await readTokens(this.origin);
      if (!stored) {
        this.current = undefined;
        throw new Error('Not signed in any more. Run "npx @dotcom-tools/mcp login" again.');
      }

      // Another process refreshed while we waited for the lock: use its tokens, don't refresh again (a refresh
      // token works once; using it twice ends the connection).
      if (stored.refreshToken !== this.current?.refreshToken
          && new Date(stored.accessExpiresAt).getTime() - Date.now() > REFRESH_EARLY_MS) {
        this.current = stored;
        return stored.accessToken;
      }

      const result = await postForm(`${this.origin}/oauth/token`, { grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: CLIENT_ID });
      if (result.status !== 200) {
        if (result.body.error === 'invalid_grant') {
          await saveTokens(this.origin, undefined);
          this.current = undefined;
          throw new Error(`Your Dotcom-Tools sign-in has ended (${String(result.body.error_description ?? 'expired or disconnected')}). Run "npx @dotcom-tools/mcp login" again.`);
        }

        throw new Error(`Could not refresh the Dotcom-Tools sign-in: ${String(result.body.error_description ?? result.body.error ?? `HTTP ${result.status}`)}`);
      }

      this.current = tokensFrom(result.body, stored);
      await saveTokens(this.origin, this.current);
      return this.current.accessToken;
    });
  }
}
