/**
 * 解码 JWT payload 中的 bot_flag_source（只读，无法改写服务端签发值）。
 * 用于 SSO cookie / access_token 展示与 mint 过滤。
 */

export interface BotFlagInfo {
  /** claim 原值；缺省为 null */
  botFlagSource: number | string | null;
  /** 是否为标记 1（或 "1"） */
  isBotFlag1: boolean;
  /** 解码失败原因 */
  error?: string;
}

function b64urlJson(seg: string): Record<string, unknown> | null {
  try {
    let s = (seg || '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = s.length % 4;
    if (pad) s += '='.repeat(4 - pad);
    const json = Buffer.from(s, 'base64').toString('utf-8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 从任意 JWT 字符串提取 payload（不验签） */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const t = String(token || '')
    .replace(/^sso=/i, '')
    .trim();
  if (!t || t.split('.').length < 2) return null;
  return b64urlJson(t.split('.')[1]);
}

export function readBotFlagFromToken(token: string): BotFlagInfo {
  const t = String(token || '')
    .replace(/^sso=/i, '')
    .trim();
  if (!t) {
    return { botFlagSource: null, isBotFlag1: false, error: 'empty token' };
  }
  const pl = decodeJwtPayload(t);
  if (!pl) {
    return { botFlagSource: null, isBotFlag1: false, error: 'not a jwt' };
  }
  const raw = pl.bot_flag_source;
  if (raw === undefined || raw === null) {
    return { botFlagSource: null, isBotFlag1: false };
  }
  const num = typeof raw === 'number' ? raw : Number(raw);
  const isBotFlag1 =
    raw === 1 || raw === '1' || (!Number.isNaN(num) && num === 1);
  return {
    botFlagSource: typeof raw === 'number' || typeof raw === 'string' ? raw : String(raw),
    isBotFlag1
  };
}

/** 优先 access_token，其次 sso 字段 */
export function readBotFlagFromAuthRecord(data: Record<string, unknown>): BotFlagInfo {
  const access = String(data.access_token || data.key || '').trim();
  if (access) {
    const r = readBotFlagFromToken(access);
    if (r.botFlagSource != null || !r.error) return { ...r, error: r.error };
  }
  const sso = String(data.sso || '').trim();
  if (sso) return readBotFlagFromToken(sso);
  return { botFlagSource: null, isBotFlag1: false, error: 'no token' };
}
