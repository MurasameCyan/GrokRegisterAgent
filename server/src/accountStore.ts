/**
 * 账号记录存储。
 * registerBot 从 Python stdout 关联出 email/password/sso 后追加到这里。
 * 落盘到 <cwd>/out/accounts.json，与 out/sso 同目录；docker 持久化需挂载 out。
 */
import { promises as fsp, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AccountRecord } from '@shared/runEvents';

function accountsDir(): string {
  return resolve(process.cwd(), 'out');
}

function accountsPath(): string {
  return join(accountsDir(), 'accounts.json');
}

async function readAll(): Promise<AccountRecord[]> {
  const path = accountsPath();
  if (!existsSync(path)) return [];
  try {
    const raw = await fsp.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AccountRecord[]) : [];
  } catch {
    return [];
  }
}

export async function appendAccount(record: AccountRecord): Promise<void> {
  const dir = accountsDir();
  await fsp.mkdir(dir, { recursive: true });
  const all = await readAll();
  all.push(record);
  const path = accountsPath();
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(all, null, 2), 'utf-8');
  await fsp.rename(tmp, path);
}

export async function listAccounts(): Promise<AccountRecord[]> {
  const all = await readAll();
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
