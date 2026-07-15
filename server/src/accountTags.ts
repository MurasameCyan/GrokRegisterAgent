/**
 * 读取 register/data/account_tags.json（NSFW 等侧车标签）
 * 与 Python account_tags.py 格式一致。
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

function tagsPathCandidates(): string[] {
  // loadSettings() 是 async；此处仅需同步解析 register 目录。
  // resolveRegisterRuntime 会走 env REGISTER_DIR / 内置候选路径。
  const rt = resolveRegisterRuntime({});
  const out: string[] = [];
  if (rt?.registerDir) {
    out.push(join(rt.registerDir, 'data', 'account_tags.json'));
    out.push(join(rt.registerDir, 'account_tags.json'));
  }
  out.push(join(process.cwd(), 'register', 'data', 'account_tags.json'));
  out.push(join(process.cwd(), 'data', 'account_tags.json'));
  return out;
}

export function loadAccountTags(): AccountTagsFile {
  for (const p of tagsPathCandidates()) {
    try {
      if (!existsSync(p)) continue;
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<AccountTagsFile>;
      return {
        by_email: (
          raw.by_email && typeof raw.by_email === 'object' ? raw.by_email : {}
        ) as Record<string, AccountTagEntry>,
        by_sso_hash: (
          raw.by_sso_hash && typeof raw.by_sso_hash === 'object' ? raw.by_sso_hash : {}
        ) as Record<string, AccountTagEntry>
      };
    } catch {
      /* try next */
    }
  }
  return { by_email: {}, by_sso_hash: {} };
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
