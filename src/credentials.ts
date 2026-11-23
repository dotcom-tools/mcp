/**
 * Stored device sign-in tokens, one entry per server origin (so Dev and Prod sign-ins live side by side and tokens are
 * only ever sent to the server that issued them).
 *
 * Where: $DOTCOM_TOOLS_CONFIG_DIR, else %APPDATA%\dotcom-tools on Windows, else $XDG_CONFIG_HOME/dotcom-tools or
 * ~/.config/dotcom-tools. The directory is 0700 and the file 0600 on Linux and macOS; a file or directory others can
 * read is refused. Writes are atomic (temp file, fsync, rename). One lock file guards login, refresh and logout.
 */
import { execFileSync } from 'node:child_process';
import { promises as fs, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO time the access token expires. */
  accessExpiresAt: string;
  signedInAt: string;
  lastRefreshedAt: string;
}

interface CredentialsFile {
  version: 1;
  servers: Record<string, StoredTokens>;
}

const FILE = 'credentials.json';
const LOCK = 'credentials.lock';
const isWindows = process.platform === 'win32';

export function configDir(): string {
  if (process.env.DOTCOM_TOOLS_CONFIG_DIR) return process.env.DOTCOM_TOOLS_CONFIG_DIR;
  if (isWindows) return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dotcom-tools');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'dotcom-tools');
}

export function credentialsPath(): string {
  return path.join(configDir(), FILE);
}

/** Refuses a directory or file that group or others can read (POSIX only; Windows %APPDATA% is per-user). */
async function checkPrivate(target: string): Promise<void> {
  if (isWindows) return;
  const stat = await fs.stat(target);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${target} can be read by other users. Run: chmod ${stat.isDirectory() ? '700' : '600'} "${target}"`);
  }
}

async function readFile(): Promise<CredentialsFile> {
  const file = credentialsPath();
  try {
    await checkPrivate(configDir());
    await checkPrivate(file);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as CredentialsFile;
    return parsed?.version === 1 && parsed.servers ? parsed : { version: 1, servers: {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, servers: {} };
    throw error;
  }
}

async function writeFile(content: CredentialsFile): Promise<void> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!isWindows) await fs.chmod(dir, 0o700);
  const temp = path.join(dir, `${FILE}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(JSON.stringify(content, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(temp, credentialsPath());
}

export async function readTokens(origin: string): Promise<StoredTokens | undefined> {
  return (await readFile()).servers[origin];
}

/** Call only inside withLock. */
export async function saveTokens(origin: string, tokens: StoredTokens | undefined): Promise<void> {
  const content = await readFile();
  if (tokens) content.servers[origin] = tokens;
  else delete content.servers[origin];
  await writeFile(content);
}

/** Runs fn while holding the lock file (created exclusively; a lock older than 30 s is treated as stale). */
export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, LOCK);
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const handle = await fs.open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.stat(lock).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.rm(lock, { force: true });
        continue;
      }

      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}. If no other dotcom-tools-mcp is running, delete it.`);
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/** Windows: warns when the credentials file's ACL grants access to broad groups. */
export function windowsAclWarning(): string | undefined {
  if (!isWindows) return undefined;
  try {
    const acl = execFileSync('icacls', [credentialsPath()], { encoding: 'utf8', windowsHide: true });
    return /(Everyone|BUILTIN\\Users|Authenticated Users):/i.test(acl)
      ? `Warning: ${credentialsPath()} can be read by other users of this computer (check its permissions with icacls).`
      : undefined;
  } catch {
    return undefined;
  }
}
