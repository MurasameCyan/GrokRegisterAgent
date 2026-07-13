/**
 * 代理测活：HTTP(S) / SOCKS4 / SOCKS5，支持 user:pass。
 *
 * 注意：大批量测活不要一次 HTTP 跑完（Cloudflare 524 ~100s）。
 * 前端应分块调用；服务端单条有硬超时，避免僵尸 socket 拖死整批。
 */
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import type { Agent } from 'http';

export type ProxyProbeResult = {
  ok: boolean;
  message: string;
  proxy?: string;
  scheme?: string;
  /** 出口 IP（若可解析） */
  exitIp?: string;
  latencyMs?: number;
};

function stripHashComment(raw: string): string {
  let s = String(raw || '').trim();
  if (!s) return '';
  const schemeIdx = s.indexOf('://');
  const searchFrom = schemeIdx >= 0 ? schemeIdx + 3 : 0;
  const hashIdx = s.indexOf('#', searchFrom);
  if (hashIdx >= 0) s = s.slice(0, hashIdx).trim();
  return s;
}

export function normalizeProxyUrl(raw: string): string {
  let s = stripHashComment(raw);
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // 无 scheme：默认 http（住宅 HTTP 代理常见）
    s = `http://${s}`;
  }
  // 统一 socks 写法
  s = s.replace(/^socks5h:\/\//i, 'socks5://');
  s = s.replace(/^socks:\/\//i, 'socks5://');
  return s;
}

function proxyScheme(proxyUrl: string): string {
  try {
    return new URL(proxyUrl).protocol.replace(':', '').toLowerCase() || 'http';
  } catch {
    return 'http';
  }
}

function isSocks(scheme: string): boolean {
  return scheme === 'socks' || scheme === 'socks4' || scheme === 'socks4a' || scheme === 'socks5';
}

/** 轻量探测目标：优先快、少跳 */
const PROBE_URLS = [
  'https://api.ipify.org?format=json',
  'https://icanhazip.com'
];

function extractIp(data: unknown, rawText?: string): string {
  if (typeof data === 'string') {
    const t = data.trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t;
    try {
      return extractIp(JSON.parse(t));
    } catch {
      return t.slice(0, 64);
    }
  }
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    if (typeof o.ip === 'string') return o.ip;
    if (typeof o.origin === 'string') return String(o.origin).split(',')[0]?.trim() || '';
  }
  if (rawText) {
    const t = rawText.trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t;
  }
  return '';
}

function createAgent(proxyUrl: string): Agent {
  const scheme = proxyScheme(proxyUrl);
  if (isSocks(scheme)) {
    // socks-proxy-agent：socks4:// user:pass@host:port / socks5://...
    return new SocksProxyAgent(proxyUrl) as unknown as Agent;
  }
  // HTTP/HTTPS 代理（含 user:pass）
  return new HttpsProxyAgent(proxyUrl) as unknown as Agent;
}

function withHardTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(onTimeout());
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(onTimeout());
        void e;
      }
    );
  });
}

export async function probeProxy(
  proxyRaw: string,
  timeoutMs = 6000
): Promise<ProxyProbeResult> {
  const proxy = normalizeProxyUrl(proxyRaw);
  if (!proxy) {
    return { ok: false, message: '代理地址为空' };
  }

  const scheme = proxyScheme(proxy);
  const tMs = Math.max(2000, Math.min(20000, Math.floor(timeoutMs) || 6000));

  let agent: Agent;
  try {
    agent = createAgent(proxy);
  } catch (e) {
    return {
      ok: false,
      message: `代理 URL 无效(${scheme}): ${(e as Error).message}`,
      proxy,
      scheme
    };
  }

  const started = Date.now();
  let lastErr = '';

  const work = async (): Promise<ProxyProbeResult> => {
    for (const url of PROBE_URLS) {
      try {
        const res = await axios.get(url, {
          httpAgent: agent,
          httpsAgent: agent,
          proxy: false,
          timeout: tMs,
          maxRedirects: 2,
          validateStatus: () => true,
          responseType: 'text',
          transformResponse: [(d) => d],
          headers: {
            Accept: 'application/json,text/plain,*/*',
            'User-Agent': 'grok-register-agent/proxy-probe'
          }
        });
        const latencyMs = Date.now() - started;
        const body =
          typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
        if (res.status >= 200 && res.status < 300) {
          let parsed: unknown = body;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* plain ip */
          }
          const exitIp = extractIp(parsed, body);
          return {
            ok: true,
            message: exitIp
              ? `出口 IP ${exitIp}（${latencyMs}ms · ${scheme}）`
              : `连通（${latencyMs}ms · ${scheme}）`,
            proxy,
            scheme,
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
      message: `测活失败(${scheme}): ${lastErr || 'timeout'}`,
      proxy,
      scheme,
      latencyMs: Date.now() - started
    };
  };

  // 硬超时 = 单条超时 + 缓冲，防止 axios 挂死拖死整批
  return withHardTimeout(work(), tMs + 2500, () => ({
    ok: false,
    message: `测活超时(${scheme} · ${tMs}ms)`,
    proxy,
    scheme,
    latencyMs: Date.now() - started
  }));
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
 * 单次请求建议 ≤40 条，避免反向代理 524；大批量由前端分块。
 */
export async function probeProxyBatch(
  proxies: string[],
  concurrency = 8,
  timeoutMs = 6000
): Promise<{
  total: number;
  ok: number;
  fail: number;
  concurrency: number;
  timeoutMs: number;
  results: ProxyProbeResult[];
}> {
  const list = (proxies || []).map((p) => String(p || '').trim()).filter(Boolean);
  // 单次请求硬上限，防止一次塞 200+ 条
  const MAX_PER_REQUEST = 48;
  const sliced = list.slice(0, MAX_PER_REQUEST);
  const conc = Math.max(1, Math.min(16, Math.floor(concurrency) || 8));
  const tMs = Math.max(2000, Math.min(15000, Math.floor(timeoutMs) || 6000));

  const results = await mapPool(sliced, conc, (proxy) => probeProxy(proxy, tMs));
  // 被截断的部分直接标 fail 提示
  for (let i = sliced.length; i < list.length; i++) {
    results.push({
      ok: false,
      message: '本批已达服务端上限，请由前端分块重试',
      proxy: normalizeProxyUrl(list[i])
    });
  }

  let ok = 0;
  let fail = 0;
  for (const r of results) {
    if (r.ok) ok++;
    else fail++;
  }
  return {
    total: results.length,
    ok,
    fail,
    concurrency: conc,
    timeoutMs: tMs,
    results
  };
}
