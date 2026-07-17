/**
 * 统一的出站 HTTP 客户端：可选 HTTP 代理（Sing-Box 本地）。
 * 连通/推送策略：优先直连 → 失败再走代理 → 再失败抛错。
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
 * 适用于 CF Worker / 自建 grok2api / sub2api 等连通与推送。
 */
export async function requestWithProxyFallback(
  url: string,
  opts: Omit<ProxiedOptions, 'proxy'> & { proxy?: string } = {}
): Promise<ProxiedResponse & { via: 'proxy' | 'direct' }> {
  const proxy = String(opts.proxy || '').trim();

  // 1) 优先直连
  try {
    const res = await proxiedRequest(url, { ...opts, proxy: undefined });
    return { ...res, via: 'direct' };
  } catch (directErr) {
    if (!proxy) throw directErr;
    if (!isTransportError(directErr)) throw directErr;

    // 2) 直连传输失败 → 再试代理
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
