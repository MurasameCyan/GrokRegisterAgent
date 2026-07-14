/**
 * 账号记录存储。
 * registerBot 从 Python stdout 关联出 email/password/sso 后追加到这里。
 *
 * 落盘：DATA_DIR/accounts.json（Docker 默认 /data/accounts.json，挂载 ./data 持久化）。
 * 兼容：若新路径不存在，会尝试迁移 cwd/out/accounts.json，并从 SSO 目录导入历史 txt。
 * 验活结果写在每条 AccountRecord.ssoCheck 上，与号池同库持久化。
 */
import { promises as fsp, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccountRecord, AccountSsoCheck } from '@shared/runEvents';
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

function isAccountSsoCheck(v: unknown): v is AccountSsoCheck {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.alive === 'boolean' &&
    typeof o.status === 'number' &&
    typeof o.checkedAt === 'string'
  );
}

function isAccountRecord(v: unknown): v is AccountRecord {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.id !== 'string' ||
    typeof o.email !== 'string' ||
    typeof o.password !== 'string' ||
    typeof o.sso !== 'string' ||
    typeof o.createdAt !== 'string'
  ) {
    return false;
  }
  if (o.ssoCheck != null && !isAccountSsoCheck(o.ssoCheck)) {
    // 脏字段丢弃，仍保留账号
    delete o.ssoCheck;
  }
  return true;
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

/** 按 id 批量删除号池账号（仅写 accounts.json，不删 SSO 历史 txt） */
export async function deleteAccounts(
  ids: string[]
): Promise<{ deleted: number; requested: number; remaining: number }> {
  const idSet = new Set(
    (Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean)
  );
  if (idSet.size === 0) {
    return { deleted: 0, requested: 0, remaining: (await listAccounts()).length };
  }
  const all = await readAll();
  const next = all.filter((a) => !idSet.has(a.id));
  const deleted = all.length - next.length;
  if (deleted > 0) {
    await writeAll(next);
  }
  return { deleted, requested: idSet.size, remaining: next.length };
}

/**
 * 从粘贴/上传文本导入号池。
 * 支持行格式：
 *   email | password | sso
 *   email----password----sso
 *   sso=... 或纯 JWT
 * 按 sso（或 email+password+sso）去重。
 */
export async function importAccountsFromText(input: {
  text: string;
  source?: string;
}): Promise<{
  totalLines: number;
  parsed: number;
  imported: number;
  skipped: number;
  invalid: number;
  remaining: number;
}> {
  const text = String(input?.text || '');
  const source = String(input?.source || 'paste').replace(/[^\w.\-@]/g, '_').slice(0, 80);
  const lines = text.split(/\r?\n/);
  let parsed = 0;
  let invalid = 0;
  const candidates: AccountRecord[] = [];
  const now = new Date().toISOString();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    const rec = parseHistoryLine(raw, source || 'import.txt', i + 1);
    if (!rec || !String(rec.sso || '').trim()) {
      // 无 sso 的行算无效（号池导入以 sso 为核心）
      if (raw.length > 0) invalid++;
      continue;
    }
    parsed++;
    candidates.push({
      ...rec,
      id: randomUUID(),
      runId: `import:${source}:${i + 1}`,
      createdAt: now
    });
  }

  if (candidates.length === 0) {
    const remaining = (await listAccounts()).length;
    return {
      totalLines: lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length,
      parsed: 0,
      imported: 0,
      skipped: 0,
      invalid,
      remaining
    };
  }

  const all = await readAll();
  const seenSso = new Set(all.map((a) => a.sso.trim()).filter(Boolean));
  const seenKey = new Set(
    all.map((a) => `${a.email}----${a.password}----${a.sso}`)
  );
  let imported = 0;
  let skipped = 0;
  for (const rec of candidates) {
    const sso = rec.sso.trim();
    if (sso && seenSso.has(sso)) {
      skipped++;
      continue;
    }
    const key = `${rec.email}----${rec.password}----${rec.sso}`;
    if (seenKey.has(key)) {
      skipped++;
      continue;
    }
    all.push(rec);
    if (sso) seenSso.add(sso);
    seenKey.add(key);
    imported++;
  }
  if (imported > 0) {
    await writeAll(all);
  }
  return {
    totalLines: lines.filter((l) => l.trim() && !l.trim().startsWith('#')).length,
    parsed,
    imported,
    skipped,
    invalid,
    remaining: all.length
  };
}

/** 手动触发从 SSO 目录重新扫描导入历史（号池刷新时可用） */
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

/** 将批量验活结果写回 accounts.json（按 id 合并 ssoCheck） */
export async function applyAccountSsoChecks(
  results: Array<{
    id: string;
    alive: boolean;
    status: number;
    checkedAt: string;
    email?: string;
    givenName?: string;
    familyName?: string;
    emailConfirmed?: boolean;
    sessionTierId?: string;
    createTime?: string;
    error?: string;
    botFlagSource?: number | string | null;
    isBotFlag1?: boolean;
  }>
): Promise<{ updated: number; emailsFilled: number }> {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) return { updated: 0, emailsFilled: 0 };

  const byId = new Map<string, (typeof list)[number]>();
  for (const r of list) {
    const id = String(r?.id || '').trim();
    if (!id || typeof r.alive !== 'boolean') continue;
    byId.set(id, r);
  }
  if (byId.size === 0) return { updated: 0, emailsFilled: 0 };

  const all = await readAll();
  let updated = 0;
  let emailsFilled = 0;
  const next = all.map((a) => {
    const r = byId.get(a.id);
    if (!r) return a;
    const ssoCheck: AccountSsoCheck = {
      alive: r.alive,
      status: typeof r.status === 'number' ? r.status : 0,
      checkedAt:
        typeof r.checkedAt === 'string' && r.checkedAt
          ? r.checkedAt
          : new Date().toISOString(),
      email: r.email,
      givenName: r.givenName,
      familyName: r.familyName,
      emailConfirmed: r.emailConfirmed,
      sessionTierId: r.sessionTierId,
      createTime: r.createTime,
      error: r.error,
      botFlagSource: r.botFlagSource,
      isBotFlag1: r.isBotFlag1
    };
    updated++;
    // 验活若返回邮箱且号池无邮箱：按 SSO 补 email（便于后续 auth 回填）
    const prevEmail = String(a.email || '').trim();
    const fromCheck = typeof r.email === 'string' ? r.email.trim() : '';
    let email = a.email;
    if (!prevEmail && fromCheck) {
      email = fromCheck;
      emailsFilled++;
    }
    return { ...a, email, ssoCheck };
  });

  if (updated > 0) {
    await writeAll(next);
  }
  if (emailsFilled > 0) {
    console.log(
      `[accounts] sso 验活补全邮箱: ${emailsFilled} 条（号池无邮箱且 grok 返回 email）`
    );
  }
  return { updated, emailsFilled };
}
