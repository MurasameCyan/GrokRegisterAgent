/** 前端只读解码 JWT 中的 bot_flag_source（不验签） */

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const t = String(token || '')
      .replace(/^sso=/i, '')
      .trim();
    const parts = t.split('.');
    if (parts.length < 2) return null;
    let seg = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = seg.length % 4;
    if (pad) seg += '='.repeat(4 - pad);
    const json = atob(seg);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readBotFlagFromSso(sso: string | undefined | null): {
  botFlagSource: number | string | null;
  isBotFlag1: boolean;
} {
  const pl = decodeJwtPayload(String(sso || ''));
  if (!pl) return { botFlagSource: null, isBotFlag1: false };
  // 兼容 claim 名变体
  const raw =
    pl.bot_flag_source !== undefined
      ? pl.bot_flag_source
      : pl.botFlagSource !== undefined
        ? pl.botFlagSource
        : pl.bot_flag;
  if (raw === undefined || raw === null) {
    return { botFlagSource: null, isBotFlag1: false };
  }
  // 0 是合法 None，不可用 !raw / || 吞掉
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  const isBotFlag1 = raw === 1 || raw === '1' || (!Number.isNaN(n) && n === 1);
  if (raw === 0 || raw === '0' || (!Number.isNaN(n) && n === 0)) {
    return { botFlagSource: 0, isBotFlag1: false };
  }
  return {
    botFlagSource: typeof raw === 'number' || typeof raw === 'string' ? raw : String(raw),
    isBotFlag1
  };
}
