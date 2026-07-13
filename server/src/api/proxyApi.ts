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

/** 有限并发 map */
async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => runOne()));
  return results;
}

/**
 * 批量并发测活。
 * @param proxies 代理 URL 列表（可含 #备注）
 * @param concurrency 并发数，默认 8，上限 20
 */
export async function probeProxyBatch(
  proxies: string[],
  concurrency = 8,
  timeoutMs = 12000
): Promise<{
  total: number;
  ok: number;
  fail: number;
  concurrency: number;
  results: ProxyProbeResult[];
}> {
  const list = (proxies || []).map((p) => String(p || '').trim()).filter(Boolean);
  const conc = Math.max(1, Math.min(20, Math.floor(concurrency) || 8));
  const results = await mapPool(list, conc, (proxy) => probeProxy(proxy, timeoutMs));
  let ok = 0;
  let fail = 0;
  for (const r of results) {
    if (r.ok) ok++;
    else fail++;
  }
  return { total: list.length, ok, fail, concurrency: conc, results };
}
