/**
 * 与 server hashSsoToken 一致：规范化 SSO 后 SHA-256 hex。
 * 用于号池无邮箱时与 Auth 文件 ssoHash 交叉匹配。
 *
 * 增量缓存：同一 id+sso 不重复 digest；仅新增/变更账号会计算。
 */

function normalizeSsoToken(sso: string): string {
  return String(sso || '')
    .trim()
    .replace(/^sso=/i, '')
    .trim();
}

/** 浏览器 Web Crypto；不可用时返回 null（匹配降级为仅 email） */
export async function hashSsoToken(sso: string): Promise<string | null> {
  const token = normalizeSsoToken(sso);
  if (!token || token.length < 8) return null;
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const data = new TextEncoder().encode(token);
      const buf = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/** 模块级缓存：accountId → { sso, hash }（sso 变更则失效） */
const hashCache = new Map<string, { sso: string; hash: string }>();

/**
 * 增量构建 id → ssoHash。
 * - 命中缓存且 sso 未变：复用
 * - 仅对新增/sso 变更的 id 调用 crypto.subtle
 * - 清理已不在号池的 id
 */
export async function buildSsoHashMap(
  accounts: { id: string; sso: string }[]
): Promise<Map<string, string>> {
  const liveIds = new Set<string>();
  const need: { id: string; sso: string }[] = [];

  for (const a of accounts) {
    const id = String(a.id || '');
    if (!id) continue;
    liveIds.add(id);
    const sso = String(a.sso || '');
    const hit = hashCache.get(id);
    if (hit && hit.sso === sso && hit.hash) {
      continue;
    }
    need.push({ id, sso });
  }

  // 清理已删除账号
  for (const id of hashCache.keys()) {
    if (!liveIds.has(id)) hashCache.delete(id);
  }

  if (need.length > 0) {
    await Promise.all(
      need.map(async ({ id, sso }) => {
        const h = await hashSsoToken(sso);
        if (h) {
          hashCache.set(id, { sso, hash: h });
        } else {
          hashCache.delete(id);
        }
      })
    );
  }

  const map = new Map<string, string>();
  for (const id of liveIds) {
    const hit = hashCache.get(id);
    if (hit?.hash) map.set(id, hit.hash);
  }
  return map;
}

/** 测试/调试用：清空缓存 */
export function clearSsoHashCache(): void {
  hashCache.clear();
}
