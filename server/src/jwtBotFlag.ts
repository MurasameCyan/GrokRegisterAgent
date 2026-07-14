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
  // 兼容 claim 名变体；0 是合法 None
  const raw =
    pl.bot_flag_source !== undefined && pl.bot_flag_source !== null
      ? pl.bot_flag_source
      : pl.botFlagSource !== undefined && pl.botFlagSource !== null
        ? pl.botFlagSource
        : pl.bot_flag !== undefined && pl.bot_flag !== null
          ? pl.bot_flag
          : undefined;
  if (raw === undefined || raw === null) {
    return { botFlagSource: null, isBotFlag1: false };
  }
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  const isBotFlag1 =
    raw === 1 || raw === '1' || (!Number.isNaN(num) && num === 1);
  // 规范化 0 → number 0，避免前端把 "0"/假值判成缺失
  if (raw === 0 || raw === '0' || (!Number.isNaN(num) && num === 0)) {
    return { botFlagSource: 0, isBotFlag1: false };
  }
  return {
    botFlagSource: typeof raw === 'number' || typeof raw === 'string' ? raw : String(raw),
    isBotFlag1
  };
}

/**
 * 优先 access_token，其次 sso。
 * 注意：access 无 bot_flag_source claim 时必须继续读 sso，
 * 旧逻辑 `!r.error` 会在 null claim 时提前返回，导致 None(0) 永远显示为 —。
 */
export function readBotFlagFromAuthRecord(data: Record<string, unknown>): BotFlagInfo {
  const access = String(data.access_token || data.key || '').trim();
  const sso = String(data.sso || '').trim();

  if (access) {
    const r = readBotFlagFromToken(access);
    // 有明确 claim（含 0 / "0"）→ 用 access
    if (r.botFlagSource != null && r.botFlagSource !== '') return r;
    // token 非法时再试 sso；合法但无 claim 也试 sso
  }
  if (sso) {
    const r = readBotFlagFromToken(sso);
    if (r.botFlagSource != null && r.botFlagSource !== '') return r;
    // sso 也无 claim
    if (!access) return r;
    return { botFlagSource: null, isBotFlag1: false };
  }
  if (access) {
    // 仅有 access 且无 claim
    return { botFlagSource: null, isBotFlag1: false };
  }
  return { botFlagSource: null, isBotFlag1: false, error: 'no token' };
}
