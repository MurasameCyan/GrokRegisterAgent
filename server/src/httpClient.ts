/**
 * 统一的出站 HTTP 客户端：可选 HTTP 代理（Sing-Box 本地）。
 * 连通检测 / 自建服务建议优先直连；代理失败可 fallback。
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
 * 出站请求：有代理时先走代理；传输层失败（ECONNRESET 等）再直连一次。
 * 自建 grok2api / CF Worker 在代理异常时常见 ECONNRESET。
 */
export async function requestWithProxyFallback(
  url: string,
  opts: Omit<ProxiedOptions, 'proxy'> & { proxy?: string } = {}
): Promise<ProxiedResponse & { via: 'proxy' | 'direct' }> {
  const proxy = String(opts.proxy || '').trim();
  if (!proxy) {
    const res = await proxiedRequest(url, { ...opts, proxy: undefined });
    return { ...res, via: 'direct' };
  }
  try {
    const res = await proxiedRequest(url, { ...opts, proxy });
    return { ...res, via: 'proxy' };
  } catch (err) {
    if (!isTransportError(err)) throw err;
    const res = await proxiedRequest(url, { ...opts, proxy: undefined });
    return { ...res, via: 'direct' };
  }
}

export { isTransportError, errorMessage };
