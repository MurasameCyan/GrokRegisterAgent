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

/** 从 payload 取 bot_flag 类 claim（含 0 / "None" / "0"） */
function pickBotFlagRaw(pl: Record<string, unknown>): unknown {
  const keys = [
    'bot_flag_source',
    'botFlagSource',
    'bot_flag',
    'botFlag',
    'bot_flag_src'
  ];
  for (const k of keys) {
    const v = pl[k];
    // 0 / "0" 是合法 None，不能用 !v；仅跳过缺失与空串
    if (v === undefined || v === null || v === '') continue;
    return v;
  }
  return undefined;
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
  const raw = pickBotFlagRaw(pl);
  if (raw === undefined || raw === null) {
    return { botFlagSource: null, isBotFlag1: false };
  }
  // 文案 None / none
  if (typeof raw === 'string' && /^none$/i.test(raw.trim())) {
    return { botFlagSource: 0, isBotFlag1: false };
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

/** 优先读 auth JSON 侧车字段 bot_flag_source / botFlagSource（mint 时写入） */
function readBotFlagSidecar(data: Record<string, unknown>): BotFlagInfo | null {
  const keys = ['bot_flag_source', 'botFlagSource', 'bot_flag', 'botFlag'] as const;
  for (const k of keys) {
    if (!(k in data)) continue;
    const raw = data[k];
    // 0 合法；仅跳过缺失与空串
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw === 'string' && /^none$/i.test(raw.trim())) {
      return { botFlagSource: 0, isBotFlag1: false };
    }
    const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
    const isBotFlag1 =
      raw === 1 || raw === '1' || (!Number.isNaN(num) && num === 1);
    if (raw === 0 || raw === '0' || (!Number.isNaN(num) && num === 0)) {
      return { botFlagSource: 0, isBotFlag1: false };
    }
    return {
      botFlagSource:
        typeof raw === 'number' || typeof raw === 'string' ? raw : String(raw),
      isBotFlag1
    };
  }
  return null;
}

/**
 * 优先侧车字段，其次 access_token / sso / id_token JWT。
 * 注意：access 无 bot_flag_source claim 时必须继续读 sso。
 * 有 sso 但 claim 全缺时默认 0（None）——与号池 SSO 绿 None 一致，避免列表永远 —。
 */
export function readBotFlagFromAuthRecord(data: Record<string, unknown>): BotFlagInfo {
  const fromFile = readBotFlagSidecar(data);
  if (fromFile) return fromFile;

  const access = String(data.access_token || data.key || '').trim();
  let sso = String(data.sso || '').trim();
  if (!sso) {
    const extra = data.extra;
    if (extra && typeof extra === 'object') {
      sso = String((extra as Record<string, unknown>).sso || '').trim();
    }
  }
  const idToken = String(data.id_token || '').trim();

  const tryToken = (tok: string): BotFlagInfo | null => {
    if (!tok) return null;
    const r = readBotFlagFromToken(tok);
    // 有明确 claim（含 number 0）→ 采用。
    // 用 == null 判断：0 必须保留
    if (r.botFlagSource != null && String(r.botFlagSource) !== '') return r;
    return null;
  };

  const fromAccess = tryToken(access);
  if (fromAccess) return fromAccess;
  const fromSso = tryToken(sso);
  if (fromSso) return fromSso;
  const fromId = tryToken(idToken);
  if (fromId) return fromId;

  // 有 sso（或 access）但 JWT 无 claim：展示 None(0)，与「正常号」一致
  if (sso || access || idToken) {
    return { botFlagSource: 0, isBotFlag1: false };
  }
  return { botFlagSource: null, isBotFlag1: false, error: 'no token' };
}
