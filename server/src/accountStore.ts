/**
 * 账号记录存储。
 * registerBot 从 Python stdout 关联出 email/password/sso 后追加到这里。
 *
 * 落盘：DATA_DIR/accounts.json（Docker 默认 /data/accounts.json，挂载 ./data 持久化）。
 * 兼容：若新路径不存在，会尝试迁移 cwd/out/accounts.json，并从 SSO 目录导入历史 txt。
 */
import { promises as fsp, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountRecord } from '@shared/runEvents';
import { dataDir } from './settingsStore.js';

function accountsDir(): string {
  return dataDir();
}

function accountsPath(): string {
  return join(accountsDir(), 'accounts.json');
}

/** 旧路径：曾误写到进程 cwd/out/accounts.json（容器内不持久） */
function legacyAccountsPath(): string {
  return resolve(process.cwd(), 'out', 'accounts.json');
}

function ssoDir(): string {
  if (process.env.SSO_DIR) return resolve(process.env.SSO_DIR);
  return join(dataDir(), 'sso');
}

function isAccountRecord(v: unknown): v is AccountRecord {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.email === 'string' &&
    typeof o.password === 'string' &&
    typeof o.sso === 'string' &&
    typeof o.createdAt === 'string'
  );
}

async function ensureDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

async function writeAll(all: AccountRecord[]): Promise<void> {
  const dir = accountsDir();
  await ensureDir(dir);
  const path = accountsPath();
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(all, null, 2), 'utf-8');
  await fsp.rename(tmp, path);
}

async function readJsonAccounts(path: string): Promise<AccountRecord[]> {
  if (!existsSync(path)) return [];
  try {
    const raw = await fsp.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAccountRecord);
  } catch {
    return [];
  }
}

/** 从文件名解析近似创建时间（sso_YYYYMMDD_HHMMSS_*.txt） */
function createdAtFromSsoFilename(name: string): string {
  const m = name.match(/sso_(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/i);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  try {
    return new Date(statSync(join(ssoDir(), name)).mtimeMs).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function parseHistoryLine(line: string, fileName: string, lineIndex: number): AccountRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // 标准输出：email | password | sso
  if (trimmed.includes(' | ')) {
    const parts = trimmed.split(' | ').map((p) => p.trim());
    if (parts.length >= 3) {
      const email = parts[0];
      const password = parts[1];
      const sso = parts.slice(2).join(' | ').replace(/^sso=/i, '');
      if (!email && !password && !sso) return null;
      return {
        id: randomUUID(),
        runId: `import:${basename(fileName)}:${lineIndex}`,
        email,
        password,
        sso,
        createdAt: createdAtFromSsoFilename(fileName)
      };
    }
  }

  // 兼容旧导出：email----password----sso
  if (trimmed.includes('----')) {
    const parts = trimmed.split('----');
    if (parts.length >= 3) {
      const email = parts[0].trim();
      const password = parts[1].trim();
      const sso = parts.slice(2).join('----').trim();
      if (!email && !password && !sso) return null;
      return {
        id: randomUUID(),
        runId: `import:${basename(fileName)}:${lineIndex}`,
        email,
        password,
        sso: sso.replace(/^sso=/i, ''),
        createdAt: createdAtFromSsoFilename(fileName)
      };
    }
  }

  // 纯 SSO token（历史文件）
  const sso = trimmed.replace(/^sso=/i, '');
  if (!sso || sso.length < 8) return null;
  return {
    id: randomUUID(),
    runId: `import:${basename(fileName)}:${lineIndex}`,
    email: '',
    password: '',
    sso,
    createdAt: createdAtFromSsoFilename(fileName)
  };
}

function importFromSsoFiles(existing: AccountRecord[]): AccountRecord[] {
  const dir = ssoDir();
  if (!existsSync(dir)) return existing;

  const seenSso = new Set(
    existing.map((a) => a.sso.trim()).filter(Boolean)
  );
  const seenKey = new Set(
    existing
      .filter((a) => a.email && a.password)
      .map((a) => `${a.email}----${a.password}----${a.sso}`)
  );

  const added: AccountRecord[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.txt') || f.endsWith('.csv'));
  } catch {
    return existing;
  }

  for (const file of files) {
    let content = '';
    try {
      content = readFileSync(join(dir, file), 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const rec = parseHistoryLine(line, file, idx);
      if (!rec) return;
      if (rec.sso && seenSso.has(rec.sso)) return;
      const key = `${rec.email}----${rec.password}----${rec.sso}`;
      if (rec.email && seenKey.has(key)) return;
      if (rec.sso) seenSso.add(rec.sso);
      if (rec.email) seenKey.add(key);
      added.push(rec);
    });
  }

  if (added.length === 0) return existing;
  return [...existing, ...added];
}

async function migrateLegacyIfNeeded(current: AccountRecord[]): Promise<AccountRecord[]> {
  if (current.length > 0) return current;
  const legacy = await readJsonAccounts(legacyAccountsPath());
  if (legacy.length === 0) return current;
  await writeAll(legacy);
  console.log(`[accountStore] migrated ${legacy.length} accounts from ${legacyAccountsPath()}`);
  return legacy;
}

async function readAll(): Promise<AccountRecord[]> {
  await ensureDir(accountsDir());
  let all = await readJsonAccounts(accountsPath());
  all = await migrateLegacyIfNeeded(all);

  // 若库空或明显少于历史 sso 文件可恢复项，尝试从 /data/sso 导入
  const merged = importFromSsoFiles(all);
  if (merged.length > all.length) {
    const gained = merged.length - all.length;
    await writeAll(merged);
    console.log(`[accountStore] imported ${gained} accounts from ${ssoDir()}`);
    return merged;
  }
  return all;
}

export async function appendAccount(record: AccountRecord): Promise<void> {
  const all = await readAll();
  // 按 sso 去重，避免重复跑写双份
  if (record.sso && all.some((a) => a.sso && a.sso === record.sso)) {
    return;
  }
  all.push(record);
  await writeAll(all);
}

export async function listAccounts(): Promise<AccountRecord[]> {
  const all = await readAll();
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 手动触发从 SSO 目录重新扫描导入（号池刷新时可用） */
export async function resyncAccountsFromDisk(): Promise<{ total: number; imported: number }> {
  const before = await readJsonAccounts(accountsPath());
  let all = await migrateLegacyIfNeeded(before);
  const beforeCount = all.length;
  all = importFromSsoFiles(all);
  if (all.length !== beforeCount) {
    await writeAll(all);
  }
  return { total: all.length, imported: Math.max(0, all.length - beforeCount) };
}
