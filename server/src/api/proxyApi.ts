/**
 * 代理测活：经 HTTP(S) 代理访问公网 IP 接口。
 * 依赖 https-proxy-agent（package.json 已有）。
 */
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

export type ProxyProbeResult = {
  ok: boolean;
  message: string;
  proxy?: string;
  /** 出口 IP（若可解析） */
  exitIp?: string;
  latencyMs?: number;
};

function normalizeProxyUrl(raw: string): string {
  let s = String(raw || '').trim();
  if (!s) return '';
  // 剥离 #备注
  const schemeIdx = s.indexOf('://');
  const searchFrom = schemeIdx >= 0 ? schemeIdx + 3 : 0;
  const hashIdx = s.indexOf('#', searchFrom);
  if (hashIdx >= 0) s = s.slice(0, hashIdx).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    s = `http://${s}`;
  }
  return s;
}

/** 探测目标：轻量 HTTPS，返回出口 IP */
const PROBE_URLS = [
  'https://api.ipify.org?format=json',
  'https://httpbin.org/ip'
];

function extractIp(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const o = data as Record<string, unknown>;
  if (typeof o.ip === 'string') return o.ip;
  if (typeof o.origin === 'string') return String(o.origin).split(',')[0]?.trim() || '';
  return '';
}

export async function probeProxy(
  proxyRaw: string,
  timeoutMs = 12000
): Promise<ProxyProbeResult> {
  const proxy = normalizeProxyUrl(proxyRaw);
  if (!proxy) {
    return { ok: false, message: '代理地址为空' };
  }

  let agent: HttpsProxyAgent<string>;
  try {
    agent = new HttpsProxyAgent(proxy);
  } catch (e) {
    return {
      ok: false,
      message: `代理 URL 无效: ${(e as Error).message}`,
      proxy
    };
  }

  const started = Date.now();
  let lastErr = '';
  for (const url of PROBE_URLS) {
    try {
      const res = await axios.get(url, {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: timeoutMs,
        validateStatus: () => true,
        headers: { Accept: 'application/json' }
      });
      const latencyMs = Date.now() - started;
      if (res.status >= 200 && res.status < 300) {
        const exitIp = extractIp(res.data) || String(res.data || '').slice(0, 64);
        return {
          ok: true,
          message: exitIp ? `出口 IP ${exitIp}（${latencyMs}ms）` : `连通（${latencyMs}ms）`,
          proxy,
          exitIp: exitIp || undefined,
          latencyMs
        };
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = (e as Error).message || String(e);
    }
  }

  return {
    ok: false,
    message: `测活失败: ${lastErr}`,
    proxy,
    latencyMs: Date.now() - started
  };
}
