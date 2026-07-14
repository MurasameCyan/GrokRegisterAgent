/**
 * 从网页/文本源拉取代理列表。
 * 适配：
 * - hide.mn 列表页 HTML 表格（IP + Port 列）
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
};

const IP_PORT_RE =
  /\b((?:\d{1,3}\.){3}\d{1,3}|\[?[0-9a-fA-F:]+\]?)[:\s|]+\s*(\d{2,5})\b/g;
const PLAIN_LINE_RE =
  /^(?:(?:https?|socks5?h?):\/\/)?(?:[^@\s/]+@)?((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\b/i;

function decodeEntities(s: string): string {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * hide.mn 表格行：
 * <tr>...<td>IP</td><td>Port</td><td>Country</td><td>Speed</td><td>Type</td><td>Anonymity</td>...
 */
function parseHideMnHtml(html: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  // 宽松匹配 tr 块
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html))) {
    const tr = m[1];
    if (/<th[\s>]/i.test(tr)) continue; // 表头
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) =>
      stripTags(x[1])
    );
    if (tds.length < 2) continue;
    const ip = tds[0]?.trim() || '';
    const port = tds[1]?.trim() || '';
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) continue;
    if (!/^\d{2,5}$/.test(port)) continue;
    const key = `${ip}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const country = tds[2]?.trim() || '';
    const type = (tds[4] || tds[3] || '').trim(); // 有的页 Speed 在 3
    // 再尝试：Type 列常含 HTTP/HTTPS/Socks
    let proto = 'HTTP';
    const typeCell = tds.find((c) => /https?|socks/i.test(c)) || type;
    if (/socks\s*5/i.test(typeCell)) proto = 'SOCKS5';
    else if (/socks\s*4/i.test(typeCell)) proto = 'SOCKS4';
    else if (/https/i.test(typeCell)) proto = 'HTTPS';
    else if (/http/i.test(typeCell)) proto = 'HTTP';
    const anonymity =
      tds.find((c) => /high|average|low|elite|anonymous|transparent/i.test(c)) ||
      '';
    const labelParts = [country, proto, anonymity].filter(Boolean);
    const label = labelParts.join(' · ');
    lines.push(label ? `${key}（${label}）` : key);
  }
  return lines;
}

/** 纯文本 / markdown / 杂乱 HTML 中扫 ip:port */
function parseGenericText(text: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // CSV 风格
    if (line.includes(',') && !line.includes('://')) {
      const parts = line.split(',').map((p) => p.trim());
      let addr = '';
      if (/^\d+$/.test(parts[0] || '') && PLAIN_LINE_RE.test(parts[1] || '')) {
        addr = parts[1];
      } else if (PLAIN_LINE_RE.test(parts[0] || '')) {
        addr = parts[0];
      }
      if (addr) {
        const m = addr.match(PLAIN_LINE_RE);
        if (m) {
          const key = `${m[1]}:${m[2]}`;
          if (!seen.has(key)) {
            seen.add(key);
            const meta = parts.filter((p) => p !== addr && !/^\d+$/.test(p));
            lines.push(meta.length ? `${key}（${meta.join(' · ')}）` : key);
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

  // 全文正则兜底（HTML 打成一行时）
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

/**
 * 拉取并解析代理列表。
 * @param viaProxy 可选：用当前配置的 HTTP 代理去拉（被墙时）
 */
export async function fetchProxiesFromUrl(input: {
  url: string;
  viaProxy?: string;
  timeoutMs?: number;
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
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8'
  };

  try {
    const config: Parameters<typeof axios.request>[0] = {
      url,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      responseType: 'text',
      validateStatus: () => true,
      proxy: false,
      // 跟随跳转
      maxRedirects: 5,
      transformResponse: [(d) => d]
    };
    const via = String(input.viaProxy || '').trim();
    if (via) {
      const agent = new HttpsProxyAgent(via);
      config.httpsAgent = agent;
      config.httpAgent = agent;
    }

    const res = await axios.request(config);
    if (res.status >= 400) {
      return {
        ok: false,
        url,
        lines: [],
        count: 0,
        format: 'http-error',
        message: `HTTP ${res.status}`,
        sample: []
      };
    }

    const body = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    if (!body.trim()) {
      return {
        ok: false,
        url,
        lines: [],
        count: 0,
        format: 'empty',
        message: '响应体为空',
        sample: []
      };
    }

    // 登录墙 / 付费 API 提示
    if (/need to log in|login to access|paid subscription/i.test(body) && body.length < 500) {
      return {
        ok: false,
        url,
        lines: [],
        count: 0,
        format: 'auth-wall',
        message: '源需要登录或付费 API；请用列表页 HTML 或自备明文 ip:port',
        sample: []
      };
    }

    let lines: string[] = [];
    let format = 'unknown';

    if (url.includes('hide.mn') || /proxy-list/i.test(url) || body.includes('cf-turnstile') === false) {
      const hide = parseHideMnHtml(body);
      if (hide.length > 0) {
        lines = hide;
        format = 'hide.mn-html-table';
      }
    }
    if (lines.length === 0) {
      lines = parseGenericText(body);
      format = detectFormat(url, body, lines);
    }

    // 校验 normalize 能吃下
    const valid = lines.filter((ln) => {
      const n = normalizeProxyUrl(ln);
      return !!n;
    });

    return {
      ok: valid.length > 0,
      url,
      lines: valid,
      count: valid.length,
      format,
      message:
        valid.length > 0
          ? `解析 ${valid.length} 条（${format}）`
          : `未能从页面解析出代理（format=${format}）。可试：页面表格 / 纯文本 ip:port`,
      sample: valid.slice(0, 8)
    };
  } catch (err) {
    return {
      ok: false,
      url,
      lines: [],
      count: 0,
      format: 'fetch-error',
      message: err instanceof Error ? err.message : String(err),
      sample: []
    };
  }
}
