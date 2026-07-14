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
    // atob 仅支持 latin1；JWT payload 多为 ascii JSON
    const json = atob(seg);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

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
    // 0 / "0" 合法；仅跳过缺失与空串（勿先 !== '' 再比 0 → TS2367）
    if (v === undefined || v === null || v === '') continue;
    return v;
  }
  return undefined;
}

export function readBotFlagFromSso(sso: string | undefined | null): {
  botFlagSource: number | string | null;
  isBotFlag1: boolean;
} {
  const pl = decodeJwtPayload(String(sso || ''));
  if (!pl) return { botFlagSource: null, isBotFlag1: false };
  const raw = pickBotFlagRaw(pl);
  if (raw === undefined || raw === null) {
    return { botFlagSource: null, isBotFlag1: false };
  }
  if (typeof raw === 'string' && /^none$/i.test(raw.trim())) {
    return { botFlagSource: 0, isBotFlag1: false };
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
