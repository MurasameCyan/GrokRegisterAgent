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
import {
  ensureProxyScheme,
  normalizeProxyUrlShared,
  parseProxyLine
} from '@shared/settings';

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

/**
 * 去掉行尾备注并按备注/CSV 补 scheme（与 shared normalize 对齐）。
 * - SOCKS5 备注 → socks5://
 * - HTTP / **HTTPS（列表）→ http://**
 */
function stripProxyAnnotation(raw: string): string {
  const shared = normalizeProxyUrlShared(raw);
  if (shared) return shared;
  const parsed = parseProxyLine(raw);
  if (parsed?.proxy) return ensureProxyScheme(parsed.proxy, parsed.label || raw);
  return '';
}

/**
 * 规范化代理 URL（测活/使用主入口，与 Python pools + shared 对齐）：
 * - 剥离 # / （备注）/ CSV 元数据
 * - 无 scheme 时按备注推断；**HTTPS 列表标记 → http://**
 * - socks / socks5h → socks5
 * - 凭据 encode 重建（防 407）
 */
export function normalizeProxyUrl(raw: string): string {
  let s = stripProxyAnnotation(raw);
  if (!s) return '';
  s = s.replace(/^[`'"<\s]+/, '').replace(/[`'">\s]+$/, '').trim();
  if (!s) return '';
  // shared 已补 scheme；再保险一次（无 hint 默认 http）
  s = ensureProxyScheme(s, raw);

  // 规范化凭据：用户名含 base64 `==` 时，用手动解析再 encode 重建，
  // 避免部分环境下 auth 丢失 → HTTP 407
  const parsed = parseProxyCredentials(s);
  if (parsed) {
    return formatProxyUrl(parsed);
  }
  return s;
}

export type ParsedProxy = {
  scheme: string;
  host: string;
  port: number;
  username: string;
  password: string;
  hasAuth: boolean;
};

/**
 * 手动解析 user:pass@host:port。
 * 不依赖 URL.username（对 `==` 会变成 %3D%3D，部分路径未 decode 会 407）。
 * 凭据按「第一个 : 前为 user，其后整段为 pass」拆分，支持 user 含 base64。
 */
export function parseProxyCredentials(proxyUrl: string): ParsedProxy | null {
  let s = stripProxyAnnotation(proxyUrl);
  if (!s) return null;
  s = s.replace(/^[`'"<\s]+/, '').replace(/[`'">\s]+$/, '').trim();
  if (!s) return null;
  // 与 ensureProxyScheme 对齐（含 HTTPS→http、SOCKS 推断）
  s = ensureProxyScheme(s, proxyUrl);

  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
  if (!m) return null;
  let scheme = (m[1] || 'http').toLowerCase();
  if (scheme === 'socks' || scheme === 'socks5h') scheme = 'socks5';
  let rest = m[2] || '';
  // 去掉 path/query（代理 URL 一般无 path）
  rest = rest.split('/')[0].split('?')[0];

  let user = '';
  let pass = '';
  let hostPort = rest;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const cred = rest.slice(0, at);
    hostPort = rest.slice(at + 1);
    const colon = cred.indexOf(':');
    if (colon >= 0) {
      user = cred.slice(0, colon);
      pass = cred.slice(colon + 1);
    } else {
      user = cred;
      pass = '';
    }
    try {
      user = decodeURIComponent(user);
    } catch {
      /* keep raw */
    }
    try {
      pass = decodeURIComponent(pass);
    } catch {
      /* keep raw */
    }
  }

  // IPv6 [host]:port 或 host:port
  let host = '';
  let port = 0;
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    if (end < 0) return null;
    host = hostPort.slice(1, end);
    const p = hostPort.slice(end + 1);
    port = p.startsWith(':') ? parseInt(p.slice(1), 10) : 0;
  } else {
    const colon = hostPort.lastIndexOf(':');
    if (colon < 0) {
      host = hostPort;
      port = 0;
    } else {
      host = hostPort.slice(0, colon);
      port = parseInt(hostPort.slice(colon + 1), 10);
    }
  }
  host = host.trim();
  if (!host) return null;
  if (!port || !Number.isFinite(port) || port < 1 || port > 65535) {
    port = scheme.startsWith('socks') ? 1080 : scheme === 'https' ? 443 : 8080;
  }

  return {
    scheme,
    host,
    port,
    username: user,
    password: pass,
    hasAuth: Boolean(user || pass)
  };
}

function formatProxyUrl(p: ParsedProxy): string {
  const auth = p.hasAuth
    ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
    : '';
  const host = p.host.includes(':') && !p.host.startsWith('[') ? `[${p.host}]` : p.host;
  return `${p.scheme}://${auth}${host}:${p.port}`;
}

function proxyScheme(proxyUrl: string): string {
  const p = parseProxyCredentials(proxyUrl);
  if (p) return p.scheme;
  try {
    return new URL(proxyUrl).protocol.replace(':', '').toLowerCase() || 'http';
  } catch {
    return 'http';
  }
}

function isSocks(scheme: string): boolean {
  return scheme === 'socks' || scheme === 'socks4' || scheme === 'socks4a' || scheme === 'socks5';
}

function proxyBasicAuthHeader(user: string, pass: string): string {
  // RFC7617：user:pass 明文再 base64；user 可含 base64 字符 ==
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

/**
 * 测活三条件（缺一不可）：
 * 1. 代理可用：经代理 HTTPS 出站成功（轻量连通，不解析出口 IP）
 * 2. 可达 xAI：grok / accounts
 * 3. 可达 Cloudflare：cdn-cgi/trace（仅此步打 CF）
 *
 * 单条与批量共用 probeProxy，无单独出口检测分支。
 * 代理连通勿再用 ipify（像出口探测）或 CF trace（与条件 3 重复，批量易被 CF 限流全灭）。
 */
const PROXY_ALIVE_URLS = [
  'https://www.google.com/generate_204',
  'https://connectivitycheck.gstatic.com/generate_204',
  'https://detectportal.firefox.com/success.txt'
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
  const parsed = parseProxyCredentials(proxyUrl);
  const scheme = parsed?.scheme || proxyScheme(proxyUrl);
  const normalized = parsed ? formatProxyUrl(parsed) : proxyUrl;

  if (isSocks(scheme)) {
    // socks-proxy-agent：socks4:// user:pass@host:port / socks5://...
    // 显式带 auth URL，避免 == 用户名丢认证
    return new SocksProxyAgent(normalized) as unknown as Agent;
  }

  // HTTP/HTTPS 代理：显式 Proxy-Authorization，兼容 user 含 `==` 的 base64 token
  const headers: Record<string, string> = {};
  if (parsed?.hasAuth) {
    headers['Proxy-Authorization'] = proxyBasicAuthHeader(
      parsed.username,
      parsed.password
    );
  }
  return new HttpsProxyAgent(normalized, {
    headers
  }) as unknown as Agent;
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
    // 三条件并行：代理隧道 + xAI + CF（无出口 IP 解析）
    const perTargetTimeout = Math.max(2500, Math.min(tMs, 8000));
    const [alive, xai, cf] = await Promise.all([
      probeTargets(agent, PROXY_ALIVE_URLS, perTargetTimeout, 'proxy'),
      probeTargets(agent, XAI_PROBE_URLS, perTargetTimeout, 'xAI'),
      probeTargets(agent, CF_PROBE_URLS, perTargetTimeout, 'CF')
    ]);
    const latencyMs = Date.now() - started;
    const allOk = alive.ok && xai.ok && cf.ok;

    const mark = (ok: boolean, name: string, t: TargetProbe) =>
      ok ? `${name}✓ ${t.ms}ms` : `${name}✗ ${t.detail}`;

    // 文案仅 代理/xAI/CF 与耗时，绝不拼出口 IP
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
      {
        const cred = parseProxyCredentials(proxy);
        message = cred?.hasAuth
          ? `测活失败: HTTP 407 代理拒绝认证（已解析到用户名 ${cred.username.slice(0, 12)}…@${cred.host}:${cred.port}，请核对账号密码/是否过期）· ${parts.join(' · ')}`
          : `测活失败: HTTP 407 代理需要认证（写成 user:pass@ip:port，用户名可含 base64 的 ==）· ${parts.join(' · ')}`;
      }
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
  concurrency = 6,
  timeoutMs = 8000
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
  // 批量默认更保守（≤3）：高并发易被 xAI/CF 限流，表现为「单条正常、全池全灭」
  const conc = Math.max(1, Math.min(3, Math.floor(concurrency) || 3));
  const tMs = Math.max(3000, Math.min(15000, Math.floor(timeoutMs) || 10000));

  // 与单条相同逻辑：仅 probeProxy；结果保序且每条带 proxy 字段供前端对齐
  const results = await mapPool(sliced, conc, async (proxy) => {
    const r = await probeProxy(proxy, tMs);
    // 保证返回里有原始请求串，方便前端按 key 对齐（不只靠 index）
    if (!r.proxy) {
      return { ...r, proxy: normalizeProxyUrl(proxy) || proxy };
    }
    return r;
  });
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
