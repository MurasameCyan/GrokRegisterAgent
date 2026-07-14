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
  /** @deprecated 已移除出口 IP 检测，保留字段兼容旧前端 */
  exitIp?: string;
  latencyMs?: number;
  /**
   * 三条件缺一不可：
   * - proxyOk：代理本身可用（HTTPS 出站隧道通）
   * - xaiOk：可达 xAI
   * - cfOk：可达 Cloudflare
   * ok === proxyOk && xaiOk && cfOk
   */
  proxyOk?: boolean;
  xaiOk?: boolean;
  cfOk?: boolean;
  proxyMs?: number;
  xaiMs?: number;
  cfMs?: number;
  proxyDetail?: string;
  xaiDetail?: string;
  cfDetail?: string;
};

const HOST_PORT_RE =
  /^(?:([^@\s/]+)@)?((?:\d{1,3}(?:\.\d{1,3}){3}|\[?[0-9a-fA-F:]+\]?|[\w.-]+):(\d{1,5}))$/i;

/**
 * 去掉行尾备注，只保留可连的代理地址。
 * 支持：`#标签`、`（日本，elite，HTTPS）`、`(Japan, elite, HTTPS)`、
 * `18,172.64.149.71:80,美国,HTTP,平均`。
 */
function stripProxyAnnotation(raw: string): string {
  let s = String(raw || '').trim();
  if (!s) return '';

  // 供应商 CSV：序号,ip:port,地区,协议,质量
  if (!s.includes('://') && s.includes(',')) {
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      let addr = '';
      if (/^\d+$/.test(parts[0]) && HOST_PORT_RE.test(parts[1])) addr = parts[1];
      else if (HOST_PORT_RE.test(parts[0])) addr = parts[0];
      else {
        for (const p of parts) {
          if (HOST_PORT_RE.test(p)) {
            addr = p;
            break;
          }
        }
      }
      if (addr) return addr;
    }
  }

  // 尾部括号备注（可叠多层，最多 3 次）
  const parenRe = /[（(][^）)]*[）)]\s*$/;
  for (let i = 0; i < 3; i++) {
    const next = s.replace(parenRe, '').trim();
    if (next === s) break;
    s = next;
  }
  const schemeIdx = s.indexOf('://');
  const searchFrom = schemeIdx >= 0 ? schemeIdx + 3 : 0;
  const hashIdx = s.indexOf('#', searchFrom);
  if (hashIdx >= 0) s = s.slice(0, hashIdx).trim();
  return s;
}

export function normalizeProxyUrl(raw: string): string {
  let s = stripProxyAnnotation(raw);
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // 无 scheme：默认 http（住宅 HTTP 代理常见）
    // 列表里的 “HTTPS” 一般指支持 CONNECT，不是 https:// 代理协议
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

/**
 * 测活三条件（缺一不可）：
 * 1. 代理可用：经代理 HTTPS 出站成功
 * 2. 可达 xAI：grok / accounts
 * 3. 可达 Cloudflare：cdn-cgi/trace
 *
 * 判定：隧道建立并拿到任意 HTTP 响应（含 3xx/4xx）即该目标通。
 * 代理 407 / 连接失败 / 超时 = 该条件失败。
 * 已取消出口 IP 解析/展示（不再依赖 ipify 回包正文）。
 */
// 代理连通：用通用 HTTPS 目标即可，不必解析出口 IP
const PROXY_ALIVE_URLS = [
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://1.1.1.1/cdn-cgi/trace'
];
const XAI_PROBE_URLS = [
  'https://grok.x.ai/',
  'https://accounts.x.ai/'
];
const CF_PROBE_URLS = [
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://1.1.1.1/cdn-cgi/trace'
];

type TargetProbe = {
  ok: boolean;
  ms: number;
  detail: string;
  exitIp?: string;
  status?: number;
};

/**
 * 经代理探测一组 URL：任一 URL 拿到「隧道后响应」即成功。
 * 代理认证失败、连不上代理、超时 → 失败。
 */
async function probeTargets(
  agent: Agent,
  urls: string[],
  timeoutMs: number,
  label: string
): Promise<TargetProbe> {
  const started = Date.now();
  let lastErr = '';
  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: timeoutMs,
        maxRedirects: 3,
        validateStatus: () => true,
        responseType: 'text',
        transformResponse: [(d) => d],
        headers: {
          Accept: 'text/html,application/json,text/plain,*/*',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      const ms = Date.now() - started;
      const body =
        typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');

      // 407 多半是代理层拒绝
      if (res.status === 407) {
        lastErr = 'HTTP 407 代理需要认证';
        continue;
      }

      // 任意其它状态：说明 HTTPS CONNECT 已通到目标（注册关心的是能不能到 xAI/CF）
      const host = (() => {
        try {
          return new URL(url).host;
        } catch {
          return label;
        }
      })();
      // 明细只保留状态码/耗时；不再解析/返回出口 IP
      void body;
      return {
        ok: true,
        ms,
        status: res.status,
        detail: `${host} · HTTP ${res.status} · ${ms}ms`
      };
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (/\b407\b/.test(msg) || /Proxy Authentication Required/i.test(msg)) {
        lastErr = 'HTTP 407 代理需要认证';
      } else if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(msg)) {
        lastErr = '超时';
      } else if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|tunnel|socket/i.test(msg)) {
        lastErr = msg.slice(0, 100);
      } else {
        lastErr = msg.slice(0, 100);
      }
    }
  }
  return {
    ok: false,
    ms: Date.now() - started,
    detail: lastErr || '不可达'
  };
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

  const work = async (): Promise<ProxyProbeResult> => {
    // 三条件并行：代理可用 + xAI + CF（缺一不可）
    const perTargetTimeout = Math.max(2500, Math.min(tMs, 8000));
    const [alive, xai, cf] = await Promise.all([
      probeTargets(agent, PROXY_ALIVE_URLS, perTargetTimeout, 'proxy'),
      probeTargets(agent, XAI_PROBE_URLS, perTargetTimeout, 'xAI'),
      probeTargets(agent, CF_PROBE_URLS, perTargetTimeout, 'CF')
    ]);
    const latencyMs = Date.now() - started;
    // 不再做「出口 IP」解析/展示（易把错误页 HTML 当 IP，且注册不依赖此字段）
    const allOk = alive.ok && xai.ok && cf.ok;

    const mark = (ok: boolean, name: string, t: TargetProbe) =>
      ok ? `${name}✓ ${t.ms}ms` : `${name}✗ ${t.detail}`;

    const parts = [
      mark(alive.ok, '代理', alive),
      mark(xai.ok, 'xAI', xai),
      mark(cf.ok, 'CF', cf),
      scheme
    ].filter(Boolean);

    const needAuth =
      /407|需要认证/.test(alive.detail) ||
      /407|需要认证/.test(xai.detail) ||
      /407|需要认证/.test(cf.detail);

    const base = {
      proxy,
      scheme,
      latencyMs,
      proxyOk: alive.ok,
      xaiOk: xai.ok,
      cfOk: cf.ok,
      proxyMs: alive.ms,
      xaiMs: xai.ms,
      cfMs: cf.ms,
      proxyDetail: alive.detail,
      xaiDetail: xai.detail,
      cfDetail: cf.detail
    };

    if (allOk) {
      return {
        ok: true,
        message: parts.join(' · '),
        ...base
      };
    }

    // 失败文案：点明缺哪一项
    const missing: string[] = [];
    if (!alive.ok) missing.push('代理不可用');
    if (!xai.ok) missing.push('xAI 不可达');
    if (!cf.ok) missing.push('CF 不可达');

    let message: string;
    if (needAuth) {
      message = `测活失败: HTTP 407 代理需要认证（写成 user:pass@ip:port）· ${parts.join(' · ')}`;
    } else {
      message = `测活失败: ${missing.join(' + ')} · ${parts.join(' · ')}`;
    }

    return {
      ok: false,
      message,
      ...base
    };
  };

  // 硬超时：三端并行
  return withHardTimeout(work(), tMs + 5000, () => ({
    ok: false,
    message: `测活超时(${scheme} · ${tMs}ms · 代理/xAI/CF)`,
    proxy,
    scheme,
    latencyMs: Date.now() - started,
    proxyOk: false,
    xaiOk: false,
    cfOk: false
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
