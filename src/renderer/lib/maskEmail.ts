/** 邮箱隐私遮蔽：默认只显示前 5 位 */

const STORAGE_KEY = 'gra-email-privacy-mask';

export function loadEmailPrivacyMask(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    // 默认开启遮蔽
    if (v === null || v === undefined) return true;
    return v === '1' || v === 'true';
  } catch {
    return true;
  }
}

export function saveEmailPrivacyMask(masked: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, masked ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/**
 * 遮蔽邮箱：只保留前 prefixLen 个字符，其余用 *。
 * 空串返回 fallback。
 */
export function maskEmail(
  email: string | undefined | null,
  masked: boolean,
  opts?: { prefixLen?: number; empty?: string }
): string {
  const empty = opts?.empty ?? '—';
  const raw = String(email || '').trim();
  if (!raw) return empty;
  if (!masked) return raw;
  const n = Math.max(1, opts?.prefixLen ?? 5);
  if (raw.length <= n) return raw;
  return `${raw.slice(0, n)}${'*'.repeat(Math.min(12, raw.length - n))}`;
}
