/**
 * 读取 account_tags.json（NSFW 等侧车标签）
 * 与 Python account_tags.py 格式一致。
 * 主路径：DATA_DIR/account_tags.json（Docker ./data 卷，重建镜像不丢）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveRegisterRuntime } from './bot/registerRuntime.js';

export interface AccountTagEntry {
  nsfw_enabled?: boolean;
  nsfw_attempted?: boolean;
  nsfw_at?: string;
  nsfw_error?: string;
  zdr_closed?: boolean;
  zdr_attempted?: boolean;
  zdr_at?: string;
  zdr_error?: string;
}

export interface AccountTagsFile {
  by_email: Record<string, AccountTagEntry>;
  by_sso_hash: Record<string, AccountTagEntry>;
}

/** 主持久路径（与 Python _primary_path 一致） */
export function primaryAccountTagsPath(): string {
  const dataDir = String(process.env.DATA_DIR || '/data').trim() || '/data';
  return join(dataDir, 'account_tags.json');
}

function tagsPathCandidates(): string[] {
  // 同步解析；DATA_DIR 优先（与 Python 持久落盘一致）
  const out: string[] = [];
  out.push(primaryAccountTagsPath());
  const dataDir = String(process.env.DATA_DIR || '/data').trim();
  if (dataDir) {
    out.push(join(dataDir, 'account_tags.json'));
  }
  const rt = resolveRegisterRuntime({});
  if (rt?.registerDir) {
    out.push(join(rt.registerDir, 'data', 'account_tags.json'));
    out.push(join(rt.registerDir, 'account_tags.json'));
  }
  out.push(join(process.cwd(), 'register', 'data', 'account_tags.json'));
  out.push(join(process.cwd(), 'data', 'account_tags.json'));
  out.push('/data/account_tags.json');
  out.push('/app/register/data/account_tags.json');
  // 去重保序
  const seen = new Set<string>();
  return out.filter((p) => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

function mergeTagFiles(a: AccountTagsFile, b: AccountTagsFile): AccountTagsFile {
  const by_email: Record<string, AccountTagEntry> = { ...a.by_email };
  const by_sso_hash: Record<string, AccountTagEntry> = { ...a.by_sso_hash };
  for (const [k, v] of Object.entries(b.by_email || {})) {
    by_email[k] = { ...(by_email[k] || {}), ...v };
  }
  for (const [k, v] of Object.entries(b.by_sso_hash || {})) {
    by_sso_hash[k] = { ...(by_sso_hash[k] || {}), ...v };
  }
  return { by_email, by_sso_hash };
}

export function loadAccountTags(): AccountTagsFile {
  // 低优先级路径先读，高优先级后覆盖（与 tagsPathCandidates 顺序一致）
  let merged: AccountTagsFile = { by_email: {}, by_sso_hash: {} };
  // 倒序：候选列表前面是高优先级（DATA_DIR），最后写入覆盖
  const paths = tagsPathCandidates().slice().reverse();
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<AccountTagsFile>;
      const one: AccountTagsFile = {
        by_email: (
          raw.by_email && typeof raw.by_email === 'object' ? raw.by_email : {}
        ) as Record<string, AccountTagEntry>,
        by_sso_hash: (
          raw.by_sso_hash && typeof raw.by_sso_hash === 'object' ? raw.by_sso_hash : {}
        ) as Record<string, AccountTagEntry>
      };
      merged = mergeTagFiles(merged, one);
    } catch {
      /* try next */
    }
  }
  return merged;
}

export function ssoHashHex(sso: string): string {
  let t = String(sso || '').trim();
  if (t.toLowerCase().startsWith('sso=')) t = t.slice(4).trim();
  if (!t || t.length < 8) return '';
  return createHash('sha256').update(t, 'utf8').digest('hex');
}

export function lookupNsfwTag(
  tags: AccountTagsFile,
  opts: { email?: string; sso?: string; ssoHash?: string }
): AccountTagEntry | null {
  const email = String(opts.email || '')
    .trim()
    .toLowerCase();
  if (email && tags.by_email[email]) {
    return tags.by_email[email];
  }
  let h = String(opts.ssoHash || '')
    .trim()
    .toLowerCase();
  if (!h && opts.sso) {
    h = ssoHashHex(opts.sso);
  }
  if (h && tags.by_sso_hash[h]) {
    return tags.by_sso_hash[h];
  }
  return null;
}

export type NsfwUiStatus = 'ok' | 'fail' | 'none';

export function nsfwStatusFromTag(tag: AccountTagEntry | null | undefined): {
  nsfwEnabled: boolean | null;
  nsfwAttempted: boolean;
  nsfwAt?: string;
  nsfwError?: string;
  nsfwStatus: NsfwUiStatus;
} {
  if (!tag || !tag.nsfw_attempted) {
    return { nsfwEnabled: null, nsfwAttempted: false, nsfwStatus: 'none' };
  }
  if (tag.nsfw_enabled === true) {
    return {
      nsfwEnabled: true,
      nsfwAttempted: true,
      nsfwAt: tag.nsfw_at,
      nsfwStatus: 'ok'
    };
  }
  return {
    nsfwEnabled: false,
    nsfwAttempted: true,
    nsfwAt: tag.nsfw_at,
    nsfwError: tag.nsfw_error,
    nsfwStatus: 'fail'
  };
}

export type ZdrUiStatus = 'closed' | 'open' | 'none';

export function zdrStatusFromTag(tag: AccountTagEntry | null | undefined): {
  zdrClosed: boolean | null;
  zdrAttempted: boolean;
  zdrAt?: string;
  zdrError?: string;
  zdrStatus: ZdrUiStatus;
} {
  if (!tag || !tag.zdr_attempted) {
    return { zdrClosed: null, zdrAttempted: false, zdrStatus: 'none' };
  }
  if (tag.zdr_closed === true) {
    return {
      zdrClosed: true,
      zdrAttempted: true,
      zdrAt: tag.zdr_at,
      zdrStatus: 'closed'
    };
  }
  return {
    zdrClosed: false,
    zdrAttempted: true,
    zdrAt: tag.zdr_at,
    zdrError: tag.zdr_error,
    zdrStatus: 'open'
  };
}
