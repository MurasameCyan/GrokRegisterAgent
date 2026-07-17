/**
 * 统一的出站 HTTP 客户端：可选 HTTP 代理（Sing-Box 本地）。
 * 连通/推送策略：优先直连 → 失败再走代理 → 再失败抛错。
 * 另：直连若返回 Cloudflare 挑战页且配置了代理，则再经代理重试（机房 IP 常见）。
 */
import axios, { type AxiosRequestConfig } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface ProxiedResponse {
  status: number;
  data: unknown;
}

export interface ProxiedOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  proxy?: string;
  timeoutMs?: number;
}

function isTransportError(err: unknown): boolean {
  const e = err as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = String(e?.code || e?.cause?.code || '');
  const msg = String(e?.message || e?.cause?.message || err || '');
  return /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EPROTO|EPIPE|socket hang up|Client network socket disconnected|tunnel|proxy/i.test(
    `${code} ${msg}`
  );
}

function errorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string; cause?: { message?: string } };
  return String(e?.message || e?.cause?.message || err || 'request failed');
}

/** 响应体是否像 Cloudflare 浏览器挑战页（非业务 JSON）。 */
export function looksLikeCloudflareChallenge(
  status: number,
  data: unknown
): boolean {
  const raw =
    typeof data === 'string'
      ? data
      : data != null
        ? JSON.stringify(data)
        : '';
  if (!raw || raw.length < 40) return false;
  // 业务 JSON 的 web_app_only 不是 CF 挑战
  if (raw.includes('web_app_only') || raw.includes('"success"')) return false;
  const hit =
    /just a moment|cf-browser-verification|challenge-platform|cf-turnstile|cdn-cgi\/challenge|Attention Required|Enable JavaScript and cookies/i.test(
      raw
    );
  if (!hit) return false;
  // 挑战页常见 403/503/429；偶发 200 HTML
  if (status === 403 || status === 503 || status === 429 || status === 200) {
    return true;
  }
  return hit && /<!DOCTYPE html|<html[\s>]/i.test(raw);
}

export async function proxiedRequest(
  url: string,
  opts: ProxiedOptions = {}
): Promise<ProxiedResponse> {
  const { method = 'GET', headers, body, proxy, timeoutMs = 20000 } = opts;

  const config: AxiosRequestConfig = {
    url,
    method,
    headers,
    data: body,
    timeout: timeoutMs,
    // 自己判断状态码，不让 axios 在 4xx/5xx 抛错
    validateStatus: () => true,
    // 关闭 axios 内建 proxy 解析，统一用 agent
    proxy: false
  };

  if (proxy && proxy.trim()) {
    const agent = new HttpsProxyAgent(proxy.trim());
    config.httpsAgent = agent;
    config.httpAgent = agent;
  }

  const res = await axios.request(config);
  return { status: res.status, data: res.data };
}

/**
 * 出站请求：优先直连；传输层失败时若配置了代理再试代理；仍失败则抛出合并错误信息。
 * 直连若拿到 Cloudflare 挑战页且配置了代理，也会再经代理重试。
 * 适用于 CF Worker / 自建 grok2api / sub2api / YYDS 等连通与推送。
 */
export async function requestWithProxyFallback(
  url: string,
  opts: Omit<ProxiedOptions, 'proxy'> & { proxy?: string } = {}
): Promise<ProxiedResponse & { via: 'proxy' | 'direct' }> {
  const proxy = String(opts.proxy || '').trim();

  // 1) 优先直连
  try {
    const res = await proxiedRequest(url, { ...opts, proxy: undefined });
    if (proxy && looksLikeCloudflareChallenge(res.status, res.data)) {
      // 2a) 直连被 CF 挑战 → 经代理重试（机房/数据中心 IP 常见）
      try {
        const viaProxy = await proxiedRequest(url, { ...opts, proxy });
        return { ...viaProxy, via: 'proxy' };
      } catch {
        // 代理也失败：仍返回直连结果，由调用方解读 403 HTML
        return { ...res, via: 'direct' };
      }
    }
    return { ...res, via: 'direct' };
  } catch (directErr) {
    if (!proxy) throw directErr;
    if (!isTransportError(directErr)) throw directErr;

    // 2b) 直连传输失败 → 再试代理
    try {
      const res = await proxiedRequest(url, { ...opts, proxy });
      return { ...res, via: 'proxy' };
    } catch (proxyErr) {
      // 3) 都失败：合并错误信息
      const d = errorMessage(directErr);
      const p = errorMessage(proxyErr);
      throw new Error(`直连失败: ${d}；代理重试失败: ${p}`);
    }
  }
}

export { isTransportError, errorMessage };
