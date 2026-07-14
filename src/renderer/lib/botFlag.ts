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
  const raw = pl.bot_flag_source;
  if (raw === undefined || raw === null) {
    return { botFlagSource: null, isBotFlag1: false };
  }
  const isBotFlag1 = raw === 1 || raw === '1' || Number(raw) === 1;
  return {
    botFlagSource: typeof raw === 'number' || typeof raw === 'string' ? raw : String(raw),
    isBotFlag1
  };
}
