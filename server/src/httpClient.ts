/**
 * 统一的出站 HTTP 客户端：根据 settings.proxy 走 HTTP 代理。
 * grok 验活、邮箱 admin 取件都经此发出，行为与 Python 注册机一致。
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

export async function proxiedRequest(url: string, opts: ProxiedOptions = {}): Promise<ProxiedResponse> {
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
