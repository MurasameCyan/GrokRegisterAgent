/**
 * 从网页/文本源拉取代理列表。
 * 适配：
 * - hide.mn 列表页 HTML 表格（IP + Port 列，支持 ?start= 翻页）
 * - hide.mn / 任意纯文本 ip:port 行
 * - Markdown 表格
 * - 供应商 CSV：序号,ip:port,地区,协议,质量
 */
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { normalizeProxyUrl } from './proxyApi.js';

export type FetchProxiesResult = {
  ok: boolean;
  url: string;
  /** 解析出的代理行（含地区/协议标签，便于直接写入待测池） */
  lines: string[];
  /** 去重后的 host:port 数 */
  count: number;
  /** 识别到的格式提示 */
  format: string;
  message: string;
  /** 采样预览 */
  sample: string[];
  /** 实际请求过的页数（hide.mn 翻页） */
  pagesFetched?: number;
};

const IP_PORT_RE =
  /\b((?:\d{1,3}\.){3}\d{1,3}|\[?[0-9a-fA-F:]+\]?)[:\s|]+\s*(\d{2,5})\b/g;
const PLAIN_LINE_RE =
  /^(?:(?:https?|socks5?h?):\/\/)?(?:[^@\s/]+@)?((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\b/i;

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function decodeEntities(s: string): string {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从国家单元格取 country 文案（hide.mn 用 span.country） */
function extractCountry(tdHtml: string): string {
  const m = String(tdHtml || '').match(
    /class\s*=\s*["']?country["']?[^>]*>([\s\S]*?)<\/span>/i
  );
  if (m) {
    const c = stripTags(m[1]);
    if (c) return c;
  }
  return stripTags(tdHtml);
}

/**
 * hide.mn 表格行：
 * <tr>...<td>IP</td><td>Port</td><td>Country</td><td>Speed</td><td>Type</td><td>Anonymity</td>...
 */
export function parseHideMnHtml(html: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html))) {
    const tr = m[1];
    if (/<th[\s>]/i.test(tr)) continue;
    const tdRaw = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (tdRaw.length < 2) continue;
    const tds = tdRaw.map((x) => stripTags(x[1]));
    const ip = tds[0]?.trim() || '';
    const port = tds[1]?.trim() || '';
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) continue;
    if (!/^\d{2,5}$/.test(port)) continue;
    const pnum = Number(port);
    if (pnum < 1 || pnum > 65535) continue;
    const key = `${ip}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const country = extractCountry(tdRaw[2]?.[1] || '') || tds[2] || '';
    // Type 列：通常在第 5 列（index 4）；Speed 在 3
    let proto = 'HTTP';
    const typeCell =
      tds.find((c) => /^(?:https?|socks\s*[45]?)$/i.test(c.trim())) ||
      tds.find((c) => /https?|socks/i.test(c)) ||
      tds[4] ||
      tds[3] ||
      '';
    if (/socks\s*5/i.test(typeCell)) proto = 'SOCKS5';
    else if (/socks\s*4/i.test(typeCell)) proto = 'SOCKS4';
    else if (/https/i.test(typeCell)) proto = 'HTTPS';
    else if (/http/i.test(typeCell)) proto = 'HTTP';

    const anonymity =
      tds.find((c) =>
        /high|average|low|elite|anonymous|transparent|no anonymity/i.test(c)
      ) || '';
    const labelParts = [country, proto, anonymity].filter(Boolean);
    const label = labelParts.join(' · ');
    // P0：按 Type 列写 scheme（SOCKS5→socks5://；HTTP/HTTPS→http://）
    let withScheme = key;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(key)) {
      if (proto === 'SOCKS5') withScheme = `socks5://${key}`;
      else if (proto === 'SOCKS4') withScheme = `socks4://${key}`;
      else withScheme = `http://${key}`; // HTTP / HTTPS / 空 → http://
    }
    lines.push(label ? `${withScheme}（${label}）` : withScheme);
  }
  return lines;
}

/** 纯文本 / markdown / 杂乱 HTML 中扫 ip:port */
export function parseGenericText(text: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.includes(',') && !line.includes('://')) {
      const parts = line.split(',').map((p) => p.trim());
      let addr = '';
      if (/^\d+$/.test(parts[0] || '') && PLAIN_LINE_RE.test(parts[1] || '')) {
        addr = parts[1];
      } else if (PLAIN_LINE_RE.test(parts[0] || '')) {
        addr = parts[0];
      }
      if (addr) {
        const mm = addr.match(PLAIN_LINE_RE);
        if (mm) {
          const key = `${mm[1]}:${mm[2]}`;
          if (!seen.has(key)) {
            seen.add(key);
            const meta = parts.filter((p) => p !== addr && !/^\d+$/.test(p));
            const label = meta.join(' · ');
            // P0：CSV 协议列 → scheme（HTTPS→http://）
            let withScheme = key;
            if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(key)) {
              const hint = label.toLowerCase();
              if (/\bsocks\s*5|socks5/.test(hint)) withScheme = `socks5://${key}`;
              else if (/\bsocks\s*4a|socks4a/.test(hint)) withScheme = `socks4a://${key}`;
              else if (/\bsocks\s*4|socks4/.test(hint)) withScheme = `socks4://${key}`;
              else if (/\bsocks\b/.test(hint)) withScheme = `socks5://${key}`;
              else withScheme = `http://${key}`;
            }
            lines.push(label ? `${withScheme}（${label}）` : withScheme);
          }
          continue;
        }
      }
    }

    const plain = line.match(PLAIN_LINE_RE);
    if (plain) {
      const key = `${plain[1]}:${plain[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        lines.push(key);
      }
      continue;
    }
  }

  if (lines.length === 0) {
    let m: RegExpExecArray | null;
    const re = new RegExp(IP_PORT_RE.source, 'g');
    while ((m = re.exec(text))) {
      const ip = m[1];
      const port = m[2];
      if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) continue;
      const p = Number(port);
      if (p < 1 || p > 65535) continue;
      const key = `${ip}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(key);
    }
  }

  return lines;
}

function detectFormat(url: string, body: string, lines: string[]): string {
  const u = url.toLowerCase();
  if (u.includes('hide.mn') && body.includes('<table')) return 'hide.mn-html-table';
  if (u.includes('hide.mn')) return 'hide.mn';
  if (/^\s*\d+\.\d+\.\d+\.\d+:\d+/m.test(body)) return 'plain-ip-port';
  if (body.includes('<table') || body.includes('<tr')) return 'html-table';
  if (lines.length > 0) return 'generic-scan';
  return 'unknown';
}

function isHideMnListUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      /(^|\.)hide\.mn$/i.test(u.hostname) &&
      /proxy-list/i.test(u.pathname + u.search)
    );
  } catch {
    return /hide\.mn/i.test(url) && /proxy-list/i.test(url);
  }
}

/** hide.mn 分页：每页约 64 条，?start=0|64|128… */
function buildHideMnPageUrls(baseUrl: string, pages: number): string[] {
  const n = Math.min(Math.max(pages, 1), 20);
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [baseUrl];
  }
  // 去掉 hash，统一 path
  base.hash = '';
  if (!/proxy-list/i.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/?$/, '/') + 'proxy-list/';
  }
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const u = new URL(base.toString());
    if (i === 0) {
      u.searchParams.delete('start');
    } else {
      u.searchParams.set('start', String(i * 64));
    }
    urls.push(u.toString());
  }
  return urls;
}

function parseBodyToLines(url: string, body: string): { lines: string[]; format: string } {
  // 登录墙 / 付费短响应
  if (/need to log in|login to access|paid subscription/i.test(body) && body.length < 800) {
    return { lines: [], format: 'auth-wall' };
  }
  // Cloudflare challenge
  if (
    /just a moment|cf-browser-verification|challenge-platform|cf-turnstile/i.test(body) &&
    !/<td[^>]*>\s*\d{1,3}(?:\.\d{1,3}){3}/i.test(body)
  ) {
    return { lines: [], format: 'challenge' };
  }

  let lines: string[] = [];
  let format = 'unknown';

  if (
    isHideMnListUrl(url) ||
    /proxy-list/i.test(url) ||
    (body.includes('<table') && /proxy/i.test(body.slice(0, 2000)))
  ) {
    const hide = parseHideMnHtml(body);
    if (hide.length > 0) {
      return { lines: hide, format: 'hide.mn-html-table' };
    }
  }

  // 任意 HTML 表也试一次
  if (body.includes('<tr') && body.includes('<td')) {
    const hide = parseHideMnHtml(body);
    if (hide.length > 0) {
      return { lines: hide, format: 'html-table' };
    }
  }

  lines = parseGenericText(body);
  format = detectFormat(url, body, lines);
  return { lines, format };
}

async function httpGetText(
  url: string,
  opts: { viaProxy?: string; timeoutMs: number }
): Promise<{ status: number; body: string; error?: string }> {
  const headers = {
    'User-Agent': DEFAULT_UA,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
    'Cache-Control': 'no-cache'
  };
  try {
    const config: Parameters<typeof axios.request>[0] = {
      url,
      method: 'GET',
      headers,
      timeout: opts.timeoutMs,
      responseType: 'text',
      validateStatus: () => true,
      proxy: false,
      maxRedirects: 5,
      transformResponse: [(d) => d]
    };
    const via = String(opts.viaProxy || '').trim();
    if (via) {
      const agent = new HttpsProxyAgent(via);
      config.httpsAgent = agent;
      config.httpAgent = agent;
    }
    const res = await axios.request(config);
    const body = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    return { status: res.status, body };
  } catch (err) {
    return {
      status: 0,
      body: '',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function filterValidLines(lines: string[]): string[] {
  return lines.filter((ln) => !!normalizeProxyUrl(ln));
}

/**
 * 拉取并解析代理列表。
 * @param viaProxy 可选：用当前配置的 HTTP 代理去拉（被墙时）
 * @param pages hide.mn 时抓取页数（1–20，默认 1；每页约 64 条）
 */
export async function fetchProxiesFromUrl(input: {
  url: string;
  viaProxy?: string;
  timeoutMs?: number;
  pages?: number;
}): Promise<FetchProxiesResult> {
  const url = String(input.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      url,
      lines: [],
      count: 0,
      format: 'invalid',
      message: 'URL 须以 http:// 或 https:// 开头',
      sample: []
    };
  }

  const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 25000, 5000), 60000);
  const pages = Math.min(Math.max(Number(input.pages) || 1, 1), 20);
  const pageUrls =
    isHideMnListUrl(url) && pages > 1 ? buildHideMnPageUrls(url, pages) : [url];

  const merged: string[] = [];
  const seenKey = new Set<string>();
  let lastFormat = 'unknown';
  let lastError = '';
  let pagesFetched = 0;
  let challengeHit = false;

  for (const pageUrl of pageUrls) {
    const res = await httpGetText(pageUrl, {
      viaProxy: input.viaProxy,
      timeoutMs
    });
    if (res.error) {
      lastError = res.error;
      // 首页失败则整体失败
      if (pagesFetched === 0) {
        return {
          ok: false,
          url,
          lines: [],
          count: 0,
          format: 'fetch-error',
          message: res.error,
          sample: [],
          pagesFetched: 0
        };
      }
      break;
    }
    if (res.status >= 400) {
      lastError = `HTTP ${res.status}`;
      if (pagesFetched === 0) {
        return {
          ok: false,
          url,
          lines: [],
          count: 0,
          format: 'http-error',
          message: `HTTP ${res.status}`,
          sample: [],
          pagesFetched: 0
        };
      }
      break;
    }
    if (!res.body.trim()) {
      lastError = '响应体为空';
      if (pagesFetched === 0) {
        return {
          ok: false,
          url,
          lines: [],
          count: 0,
          format: 'empty',
          message: '响应体为空',
          sample: [],
          pagesFetched: 0
        };
      }
      break;
    }

    const { lines, format } = parseBodyToLines(pageUrl, res.body);
    lastFormat = format;
    if (format === 'challenge') challengeHit = true;
    if (format === 'auth-wall' && pagesFetched === 0) {
      return {
        ok: false,
        url,
        lines: [],
        count: 0,
        format: 'auth-wall',
        message: '源需要登录或付费 API；请用列表页 HTML 或自备明文 ip:port',
        sample: [],
        pagesFetched: 0
      };
    }

    const valid = filterValidLines(lines);
    pagesFetched += 1;
    for (const ln of valid) {
      const key = normalizeProxyUrl(ln) || ln;
      // 用 host:port 去重
      const hostPort = key.replace(/^https?:\/\//i, '').replace(/^[^@]+@/, '');
      if (seenKey.has(hostPort)) continue;
      seenKey.add(hostPort);
      merged.push(ln);
    }

    // 本页无数据则停止翻页
    if (valid.length === 0) break;
  }

  if (merged.length === 0) {
    let message = `未能从页面解析出代理（format=${lastFormat}）`;
    if (challengeHit) {
      message =
        '页面疑似 Cloudflare 挑战页。请开启「经 HTTP 代理拉取」或换网络后再试';
    } else if (lastError) {
      message = lastError;
    } else {
      message += '。可试 hide.mn 列表页 / 纯文本 ip:port';
    }
    return {
      ok: false,
      url,
      lines: [],
      count: 0,
      format: lastFormat,
      message,
      sample: [],
      pagesFetched
    };
  }

  return {
    ok: true,
    url,
    lines: merged,
    count: merged.length,
    format: lastFormat,
    message:
      pagesFetched > 1
        ? `解析 ${merged.length} 条（${lastFormat} · ${pagesFetched} 页）`
        : `解析 ${merged.length} 条（${lastFormat}）`,
    sample: merged.slice(0, 8),
    pagesFetched
  };
}
