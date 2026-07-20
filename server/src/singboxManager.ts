/**
 * sing-box 本地 mixed(HTTP/SOCKS) 代理进程管理。
 * 仅使用 Linux 二进制：register/bin/sing-box/linux-amd64 | linux-arm64
 * 用户只需粘贴节点分享链接；路由固定全局（全部走节点）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  writeFileSync,
  readFileSync,
  type WriteStream,
  chmodSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import type { AppSettings } from '@shared/settings';
import { buildSingBoxLocalProxyUrl } from '@shared/settings';

export type SingBoxStatus = {
  running: boolean;
  pid: number | null;
  port: number;
  localUrl: string;
  binary: string | null;
  binaryExists: boolean;
  selected: string;
  selectedName: string;
  nodeCount: number;
  lastError: string | null;
  startedAt: number | null;
  logPath: string | null;
  configPath: string | null;
  platform: string;
  arch: string;
};

export type SingBoxLogResult = {
  ok: boolean;
  logPath: string | null;
  content: string;
  truncated: boolean;
  error?: string;
};

export type SingBoxNodeSummary = {
  tag: string;
  name: string;
  type: string;
  server: string;
  port: number;
  raw: string;
};

type ParsedNode = SingBoxNodeSummary & {
  outbound: Record<string, unknown>;
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let child: ChildProcess | null = null;
let logStream: WriteStream | null = null;
let startedAt: number | null = null;
let lastError: string | null = null;
let lastConfigKey: string | null = null;
let lastBinary: string | null = null;
let lastLogPath: string | null = null;
let lastConfigPath: string | null = null;
let lastSelected = '';
let lastSelectedName = '';
let lastNodeCount = 0;

function dataDir(): string {
  return resolve(process.env.DATA_DIR || '/data');
}

function registerDirCandidates(): string[] {
  const out: string[] = [];
  const env = String(process.env.REGISTER_DIR || '').trim();
  if (env) out.push(resolve(env));
  out.push(resolve(__dirname, '../../register'));
  out.push(resolve(__dirname, '../../../register'));
  out.push('/app/register');
  return out;
}

export function resolveSingBoxBinary(): string | null {
  const arch = process.arch;
  const name =
    arch === 'arm64' ? 'linux-arm64' : arch === 'arm' ? 'linux-arm' : 'linux-amd64';
  for (const reg of registerDirCandidates()) {
    const p = join(reg, 'bin', 'sing-box', name);
    if (existsSync(p)) return p;
  }
  for (const reg of registerDirCandidates()) {
    const fallback = join(reg, 'bin', 'sing-box', 'linux-amd64');
    if (existsSync(fallback)) return fallback;
  }
  return null;
}

function stripNodeComment(line: string): { url: string; remark: string } {
  const raw = String(line || '').trim();
  if (!raw) return { url: '', remark: '' };
  // share links use # for name; keep last # as remark only if scheme present before
  const schemeIdx = raw.indexOf('://');
  if (schemeIdx < 0) return { url: raw, remark: '' };
  // for standard share links, fragment IS the name — keep intact for parsers
  return { url: raw, remark: '' };
}

function safeTag(prefix: string, seed: string, idx: number): string {
  const h = createHash('sha1').update(`${seed}|${idx}`).digest('hex').slice(0, 8);
  const base = `${prefix}_${h}`;
  return base.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
}

function b64Decode(s: string): string {
  const pad = s.length % 4 === 0 ? s : s + '='.repeat(4 - (s.length % 4));
  return Buffer.from(pad.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function parseQuery(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!qs) return out;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodeURIComponent(i >= 0 ? part.slice(0, i) : part);
    const v = decodeURIComponent(i >= 0 ? part.slice(i + 1) : '');
    if (k) out[k] = v;
  }
  return out;
}

function parseSs(url: string, idx: number): ParsedNode | null {
  // ss://method:password@host:port#name
  // ss://base64(method:password@host:port)#name
  try {
    let body = url.slice('ss://'.length);
    let name = '';
    const hash = body.indexOf('#');
    if (hash >= 0) {
      name = decodeURIComponent(body.slice(hash + 1) || '');
      body = body.slice(0, hash);
    }
    let method = '';
    let password = '';
    let host = '';
    let port = 0;
    if (body.includes('@')) {
      // maybe method:pass@host:port OR base64userinfo@host:port
      const at = body.lastIndexOf('@');
      let userinfo = body.slice(0, at);
      const hostport = body.slice(at + 1);
      if (!userinfo.includes(':')) {
        try {
          userinfo = b64Decode(userinfo);
        } catch {
          /* keep */
        }
      }
      const colon = userinfo.indexOf(':');
      method = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
      password = colon >= 0 ? userinfo.slice(colon + 1) : '';
      const hp = hostport.split(':');
      host = hp[0] || '';
      port = Number(hp[1] || 0);
    } else {
      const decoded = b64Decode(body);
      // method:password@host:port
      const at = decoded.lastIndexOf('@');
      if (at < 0) return null;
      const userinfo = decoded.slice(0, at);
      const hostport = decoded.slice(at + 1);
      const colon = userinfo.indexOf(':');
      method = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
      password = colon >= 0 ? userinfo.slice(colon + 1) : '';
      const hp = hostport.split(':');
      host = hp[0] || '';
      port = Number(hp[1] || 0);
    }
    if (!host || !port || !method) return null;
    const tag = safeTag('ss', url, idx);
    return {
      tag,
      name: name || `ss ${host}:${port}`,
      type: 'shadowsocks',
      server: host,
      port,
      raw: url,
      outbound: {
        type: 'shadowsocks',
        tag,
        server: host,
        server_port: port,
        method,
        password
      }
    };
  } catch {
    return null;
  }
}

function parseVmess(url: string, idx: number): ParsedNode | null {
  try {
    const raw = url.slice('vmess://'.length);
    const json = JSON.parse(b64Decode(raw)) as Record<string, unknown>;
    const host = String(json.add || json.host || '').trim();
    const port = Number(json.port || 0);
    const uuid = String(json.id || '').trim();
    if (!host || !port || !uuid) return null;
    const name = String(json.ps || json.remark || `${host}:${port}`);
    const net = String(json.net || json.network || 'tcp').toLowerCase();
    const tls = String(json.tls || '').toLowerCase() === 'tls';
    const path = String(json.path || '/');
    const hostHeader = String(json.host || json.sni || host);
    const tag = safeTag('vmess', url, idx);
    const outbound: Record<string, unknown> = {
      type: 'vmess',
      tag,
      server: host,
      server_port: port,
      uuid,
      security: String(json.scy || json.security || 'auto'),
      alter_id: Number(json.aid || 0)
    };
    if (tls) {
      outbound.tls = {
        enabled: true,
        server_name: String(json.sni || hostHeader || host),
        insecure: false
      };
    }
    if (net === 'ws') {
      outbound.transport = {
        type: 'ws',
        path,
        headers: hostHeader ? { Host: hostHeader } : undefined
      };
    } else if (net === 'grpc') {
      outbound.transport = {
        type: 'grpc',
        service_name: String(json.path || json.serviceName || '')
      };
    }
    return {
      tag,
      name,
      type: 'vmess',
      server: host,
      port,
      raw: url,
      outbound
    };
  } catch {
    return null;
  }
}

function parseVlessOrTrojan(url: string, idx: number, kind: 'vless' | 'trojan'): ParsedNode | null {
  try {
    // vless://uuid@host:port?params#name
    // trojan://password@host:port?params#name
    const scheme = kind + '://';
    let body = url.slice(scheme.length);
    let name = '';
    const hash = body.indexOf('#');
    if (hash >= 0) {
      name = decodeURIComponent(body.slice(hash + 1) || '');
      body = body.slice(0, hash);
    }
    let query = '';
    const q = body.indexOf('?');
    if (q >= 0) {
      query = body.slice(q + 1);
      body = body.slice(0, q);
    }
    const at = body.lastIndexOf('@');
    if (at < 0) return null;
    const user = decodeURIComponent(body.slice(0, at));
    const hostport = body.slice(at + 1);
    const colon = hostport.lastIndexOf(':');
    if (colon < 0) return null;
    const host = hostport.slice(0, colon);
    const port = Number(hostport.slice(colon + 1));
    if (!host || !port || !user) return null;
    const params = parseQuery(query);
    const tag = safeTag(kind, url, idx);
    const type = kind;
    const outbound: Record<string, unknown> = {
      type,
      tag,
      server: host,
      server_port: port
    };
    if (kind === 'vless') {
      outbound.uuid = user;
      if (params.flow) outbound.flow = params.flow;
      // packetEncoding / packet_encoding → sing-box packet_encoding
      const pe = params.packetEncoding || params.packet_encoding || params['packet-encoding'];
      if (pe) outbound.packet_encoding = pe;
    } else {
      outbound.password = user;
    }
    const security = (params.security || '').toLowerCase();
    const sni = params.sni || params.peer || params.servername || host;
    if (security === 'tls' || security === 'reality') {
      const tls: Record<string, unknown> = {
        enabled: true,
        server_name: sni,
        insecure: params.allowInsecure === '1' || params.insecure === '1'
      };
      if (params.fp) tls.utls = { enabled: true, fingerprint: params.fp };
      if (security === 'reality') {
        tls.reality = {
          enabled: true,
          public_key: params.pbk || '',
          short_id: params.sid || ''
        };
      }
      if (params.alpn) tls.alpn = String(params.alpn).split(',');
      outbound.tls = tls;
    }
    const net = (params.type || params.network || 'tcp').toLowerCase();
    // CF VLESS-WS：缺 host 时用 sni 作 Host（否则 Cloudflare 回 403）
    const wsHost = params.host || params.Host || (net === 'ws' || net === 'http' ? sni : '');
    const wsPath = params.path || '/';
    if (net === 'ws') {
      outbound.transport = {
        type: 'ws',
        path: wsPath,
        headers: wsHost ? { Host: wsHost } : undefined
      };
    } else if (net === 'grpc') {
      outbound.transport = {
        type: 'grpc',
        service_name: params.serviceName || params.path || ''
      };
    } else if (net === 'http') {
      outbound.transport = {
        type: 'http',
        host: wsHost ? [wsHost] : undefined,
        path: wsPath
      };
    }
    return {
      tag,
      name: name || `${kind} ${host}:${port}`,
      type,
      server: host,
      port,
      raw: url,
      outbound
    };
  } catch {
    return null;
  }
}

function parseHysteria2(url: string, idx: number): ParsedNode | null {
  try {
    // hysteria2://password@host:port?params#name  or hy2://
    const lower = url.toLowerCase();
    const scheme = lower.startsWith('hy2://') ? 'hy2://' : 'hysteria2://';
    let body = url.slice(scheme.length);
    let name = '';
    const hash = body.indexOf('#');
    if (hash >= 0) {
      name = decodeURIComponent(body.slice(hash + 1) || '');
      body = body.slice(0, hash);
    }
    let query = '';
    const q = body.indexOf('?');
    if (q >= 0) {
      query = body.slice(q + 1);
      body = body.slice(0, q);
    }
    const at = body.lastIndexOf('@');
    if (at < 0) return null;
    const password = decodeURIComponent(body.slice(0, at));
    const hostport = body.slice(at + 1);
    const colon = hostport.lastIndexOf(':');
    if (colon < 0) return null;
    const host = hostport.slice(0, colon);
    const port = Number(hostport.slice(colon + 1));
    if (!host || !port) return null;
    const params = parseQuery(query);
    const tag = safeTag('hy2', url, idx);
    return {
      tag,
      name: name || `hy2 ${host}:${port}`,
      type: 'hysteria2',
      server: host,
      port,
      raw: url,
      outbound: {
        type: 'hysteria2',
        tag,
        server: host,
        server_port: port,
        password,
        tls: {
          enabled: true,
          server_name: params.sni || host,
          insecure: params.insecure === '1' || params.allowInsecure === '1'
        },
        ...(params.obfs
          ? {
              obfs: {
                type: params.obfs,
                password: params['obfs-password'] || params.obfsPassword || ''
              }
            }
          : {})
      }
    };
  } catch {
    return null;
  }
}

function parseTuic(url: string, idx: number): ParsedNode | null {
  try {
    // tuic://uuid:password@host:port?params#name
    let body = url.slice('tuic://'.length);
    let name = '';
    const hash = body.indexOf('#');
    if (hash >= 0) {
      name = decodeURIComponent(body.slice(hash + 1) || '');
      body = body.slice(0, hash);
    }
    let query = '';
    const q = body.indexOf('?');
    if (q >= 0) {
      query = body.slice(q + 1);
      body = body.slice(0, q);
    }
    const at = body.lastIndexOf('@');
    if (at < 0) return null;
    const userinfo = body.slice(0, at);
    const hostport = body.slice(at + 1);
    const colonUi = userinfo.indexOf(':');
    const uuid = colonUi >= 0 ? userinfo.slice(0, colonUi) : userinfo;
    const password = colonUi >= 0 ? userinfo.slice(colonUi + 1) : '';
    const colon = hostport.lastIndexOf(':');
    if (colon < 0) return null;
    const host = hostport.slice(0, colon);
    const port = Number(hostport.slice(colon + 1));
    if (!host || !port || !uuid) return null;
    const params = parseQuery(query);
    const tag = safeTag('tuic', url, idx);
    return {
      tag,
      name: name || `tuic ${host}:${port}`,
      type: 'tuic',
      server: host,
      port,
      raw: url,
      outbound: {
        type: 'tuic',
        tag,
        server: host,
        server_port: port,
        uuid,
        password,
        congestion_control: params.congestion_control || params.congestion || 'bbr',
        udp_relay_mode: params.udp_relay_mode || params.udpRelayMode || 'native',
        tls: {
          enabled: true,
          server_name: params.sni || host,
          insecure: params.allowInsecure === '1' || params.insecure === '1',
          alpn: params.alpn ? String(params.alpn).split(',') : ['h3']
        }
      }
    };
  } catch {
    return null;
  }
}

/**
 * anytls://password@host:port?params#name
 * 对齐 sing-box 1.13 outbound type=anytls（TLS 必选）。
 * 常见 query: sni / peer / fp / insecure / allowInsecure / alpn
 * 可选: idleSessionCheckInterval / idleSessionTimeout / minIdleSession
 */
function parseAnytls(url: string, idx: number): ParsedNode | null {
  try {
    let body = url.slice('anytls://'.length);
    let name = '';
    const hash = body.indexOf('#');
    if (hash >= 0) {
      name = decodeURIComponent(body.slice(hash + 1) || '');
      body = body.slice(0, hash);
    }
    let query = '';
    const q = body.indexOf('?');
    if (q >= 0) {
      query = body.slice(q + 1);
      body = body.slice(0, q);
    }
    const at = body.lastIndexOf('@');
    if (at < 0) return null;
    const password = decodeURIComponent(body.slice(0, at));
    const hostport = body.slice(at + 1);
    const colon = hostport.lastIndexOf(':');
    if (colon < 0) return null;
    const host = hostport.slice(0, colon);
    const port = Number(hostport.slice(colon + 1));
    if (!host || !port || !password) return null;
    const params = parseQuery(query);
    const tag = safeTag('anytls', url, idx);
    const sni = params.sni || params.peer || params.servername || host;
    const tls: Record<string, unknown> = {
      enabled: true,
      server_name: sni,
      insecure: params.allowInsecure === '1' || params.insecure === '1'
    };
    if (params.fp) tls.utls = { enabled: true, fingerprint: params.fp };
    if (params.alpn) tls.alpn = String(params.alpn).split(',');
    const outbound: Record<string, unknown> = {
      type: 'anytls',
      tag,
      server: host,
      server_port: port,
      password,
      tls
    };
    // 可选会话调优（时长字符串，如 30s；数值则当秒）
    const idleCheck =
      params.idleSessionCheckInterval ||
      params.idle_session_check_interval ||
      params['idle-session-check-interval'];
    const idleTimeout =
      params.idleSessionTimeout ||
      params.idle_session_timeout ||
      params['idle-session-timeout'];
    const minIdle =
      params.minIdleSession || params.min_idle_session || params['min-idle-session'];
    if (idleCheck) outbound.idle_session_check_interval = idleCheck;
    if (idleTimeout) outbound.idle_session_timeout = idleTimeout;
    if (minIdle != null && minIdle !== '') {
      const n = Number(minIdle);
      outbound.min_idle_session = Number.isFinite(n) ? n : minIdle;
    }
    return {
      tag,
      name: name || `anytls ${host}:${port}`,
      type: 'anytls',
      server: host,
      port,
      raw: url,
      outbound
    };
  } catch {
    return null;
  }
}


/**
 * 上游 HTTP(S) / SOCKS 代理（sing-box outbound type=http|socks）。
 * 支持：
 *   http://host:port
 *   http://user:pass@host:port
 *   https://host:port          （TLS 到代理，outbound.tls.enabled）
 *   socks:// / socks5:// / socks5h://host:port
 *   socks4:// / socks4a://host:port
 *   host:port                 （默认按 socks5）
 *   user:pass@host:port
 * 行尾 #备注 可选
 */
function parseHttpOrSocks(url: string, idx: number): ParsedNode | null {
  try {
    let raw = String(url || '').trim();
    if (!raw) return null;
    let name = '';
    // fragment 备注（非标准但方便）
    const hash = raw.indexOf('#');
    if (hash >= 0) {
      name = decodeURIComponent(raw.slice(hash + 1) || '');
      raw = raw.slice(0, hash);
    }

    let scheme = '';
    let rest = raw;
    const lower = raw.toLowerCase();
    if (lower.startsWith('https://')) {
      scheme = 'https';
      rest = raw.slice('https://'.length);
    } else if (lower.startsWith('http://')) {
      scheme = 'http';
      rest = raw.slice('http://'.length);
    } else if (lower.startsWith('socks5h://')) {
      scheme = 'socks5';
      rest = raw.slice('socks5h://'.length);
    } else if (lower.startsWith('socks5://')) {
      scheme = 'socks5';
      rest = raw.slice('socks5://'.length);
    } else if (lower.startsWith('socks4a://')) {
      scheme = 'socks4';
      rest = raw.slice('socks4a://'.length);
    } else if (lower.startsWith('socks4://')) {
      scheme = 'socks4';
      rest = raw.slice('socks4://'.length);
    } else if (lower.startsWith('socks://')) {
      scheme = 'socks5';
      rest = raw.slice('socks://'.length);
    } else {
      // bare host:port or user:pass@host:port → socks5
      scheme = 'socks5';
      rest = raw;
    }

    // 去掉 path（代理 URL 一般无 path；有则忽略）
    const slash = rest.indexOf('/');
    if (slash >= 0) rest = rest.slice(0, slash);

    let username = '';
    let password = '';
    let hostport = rest;
    const at = rest.lastIndexOf('@');
    if (at >= 0) {
      const userinfo = rest.slice(0, at);
      hostport = rest.slice(at + 1);
      const colon = userinfo.indexOf(':');
      if (colon >= 0) {
        username = decodeURIComponent(userinfo.slice(0, colon));
        password = decodeURIComponent(userinfo.slice(colon + 1));
      } else {
        username = decodeURIComponent(userinfo);
      }
    }

    // IPv6 [addr]:port
    let host = '';
    let port = 0;
    if (hostport.startsWith('[')) {
      const end = hostport.indexOf(']');
      if (end < 0) return null;
      host = hostport.slice(1, end);
      const p = hostport.slice(end + 1);
      if (!p.startsWith(':')) return null;
      port = Number(p.slice(1));
    } else {
      const colon = hostport.lastIndexOf(':');
      if (colon < 0) return null;
      host = hostport.slice(0, colon).trim();
      port = Number(hostport.slice(colon + 1));
    }
    if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;

    // 排除误把订阅/网页 URL 当代理（有明确 path 的 http(s) 已在上方截断；再挡常见非代理口误填）
    // 不拦截：用户确实可能用 80/443 的 HTTP 代理

    const isHttp = scheme === 'http' || scheme === 'https';
    const type = isHttp ? 'http' : 'socks';
    const tag = safeTag(isHttp ? 'http' : scheme === 'socks4' ? 'socks4' : 'socks', raw, idx);
    const outbound: Record<string, unknown> = {
      type,
      tag,
      server: host,
      server_port: port
    };
    if (username) outbound.username = username;
    if (password) outbound.password = password;
    // sing-box socks version: "4" | "5"（默认 5）
    if (type === 'socks' && scheme === 'socks4') {
      outbound.version = '4';
    }
    if (scheme === 'https') {
      outbound.tls = { enabled: true, server_name: host };
    }

    const authHint = username ? ' · auth' : '';
    return {
      tag,
      name: name || `${scheme} ${host}:${port}${authHint}`,
      type,
      server: host,
      port,
      raw: url,
      outbound
    };
  } catch {
    return null;
  }
}

export function parseSingBoxNodeLine(line: string, idx = 0): ParsedNode | null {
  const { url } = stripNodeComment(line);
  const u = url.trim();
  if (!u) return null;
  const lower = u.toLowerCase();
  // 分享协议
  if (lower.startsWith('ss://')) return parseSs(u, idx);
  if (lower.startsWith('vmess://')) return parseVmess(u, idx);
  if (lower.startsWith('vless://')) return parseVlessOrTrojan(u, idx, 'vless');
  if (lower.startsWith('trojan://')) return parseVlessOrTrojan(u, idx, 'trojan');
  if (lower.startsWith('hysteria2://') || lower.startsWith('hy2://'))
    return parseHysteria2(u, idx);
  if (lower.startsWith('tuic://')) return parseTuic(u, idx);
  if (lower.startsWith('anytls://')) return parseAnytls(u, idx);
  // 上游 HTTP / SOCKS 代理
  if (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('socks://') ||
    lower.startsWith('socks4://') ||
    lower.startsWith('socks4a://') ||
    lower.startsWith('socks5://') ||
    lower.startsWith('socks5h://')
  ) {
    return parseHttpOrSocks(u, idx);
  }
  // bare host:port / user:pass@host:port（默认 socks5）
  if (/^(?:\S+@)?(?:\[[^\]]+\]|[^:\s/]+):\d{1,5}$/.test(u.split('#')[0].trim())) {
    return parseHttpOrSocks(u, idx);
  }
  return null;
}

export function parseSingBoxNodes(text: string): ParsedNode[] {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const out: ParsedNode[] = [];
  const used = new Set<string>();
  lines.forEach((line, i) => {
    const n = parseSingBoxNodeLine(line, i);
    if (!n) return;
    let tag = n.tag;
    let c = 1;
    while (used.has(tag)) {
      tag = `${n.tag}_${c++}`;
    }
    used.add(tag);
    n.tag = tag;
    n.outbound.tag = tag;
    out.push(n);
  });
  return out;
}

export function listSingBoxNodeSummaries(text: string): SingBoxNodeSummary[] {
  return parseSingBoxNodes(text).map(({ tag, name, type, server, port, raw }) => ({
    tag,
    name,
    type,
    server,
    port,
    raw
  }));
}


/** 分享链接协议前缀（与 parseSingBoxNodeLine 一致） */
const SHARE_LINK_RE =
  /(?:^|[\s"'<>])((?:ss|vmess|vless|trojan|hysteria2|hy2|tuic|anytls|https?|socks5h?|socks4a?|socks):\/\/[^\s"'<>]+)/gi;

function tryBase64Decode(raw: string): string | null {
  let s = String(raw || '')
    .trim()
    // 去 BOM / 空白 / 换行
    .replace(/^\uFEFF/, '')
    .replace(/\s+/g, '');
  if (!s || s.length < 8) return null;
  // 标准 + URL-safe Base64
  if (!/^[A-Za-z0-9+/_\-=]+$/.test(s)) return null;
  // URL-safe → 标准
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  try {
    const buf = Buffer.from(s, 'base64');
    if (!buf.length) return null;
    const text = buf.toString('utf8');
    // 解码后应多为可打印字符（分享链接或 YAML）
    if (!/[\x09\x0a\x0d\x20-\x7e\u4e00-\u9fff]{8,}/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

function extractShareLinksFromText(body: string): string[] {
  const text = String(body || '');
  const found: string[] = [];
  const seen = new Set<string>();

  // 1) 明文 / 解码后：逐行
  for (const line of text.split(/\r?\n/)) {
    const u = line.trim();
    if (!u || u.startsWith('#')) continue;
    // 行内可能带备注：scheme://...#name 或 scheme://... 空格备注
    const m = u.match(
      /^(ss|vmess|vless|trojan|hysteria2|hy2|tuic|anytls|https?|socks5h?|socks4a?|socks):\/\/\S+/i
    );
    if (m) {
      const link = m[0].replace(/[),;]+$/, '');
      const key = link.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push(link);
      }
    }
  }

  // 2) 正则扫全文（YAML/JSON 嵌套）
  SHARE_LINK_RE.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = SHARE_LINK_RE.exec(text)) !== null) {
    const link = String(mm[1] || '').replace(/[),;]+$/, '');
    const key = link.toLowerCase();
    if (!seen.has(key) && parseSingBoxNodeLine(link, 0)) {
      seen.add(key);
      found.push(link);
    }
  }
  return found;
}

/**
 * Clash YAML proxies 列表 → 分享链接（无 yaml 依赖的轻量解析）。
 * 支持 block 列表与 flow map：`- { name: a, type: ss, ... }`
 */
export function parseClashProxiesToShareLinks(yamlText: string): string[] {
  const text = String(yamlText || '').replace(/^\uFEFF/, '');
  if (!/^\s*proxies\s*:/m.test(text) && !/\nproxies\s*:/m.test(text)) {
    // 有的文件顶层就是 proxies，有的夹在 config 里
    if (!/type:\s*(ss|ssr|vmess|vless|trojan|hysteria2|hy2|tuic|anytls)\b/i.test(text)) {
      return [];
    }
  }

  const links: string[] = [];
  const seen = new Set<string>();
  const pushLink = (link: string | null) => {
    if (!link) return;
    const k = link.toLowerCase();
    if (seen.has(k)) return;
    if (!parseSingBoxNodeLine(link, 0)) return;
    seen.add(k);
    links.push(link);
  };

  // —— flow style: - { name: x, type: ss, ... }
  const flowRe = /-\s*\{([^{}]+)\}/g;
  let fm: RegExpExecArray | null;
  while ((fm = flowRe.exec(text)) !== null) {
    const obj = parseClashFlowMap(fm[1] || '');
    if (obj) pushLink(clashProxyToShareLink(obj));
  }

  // —— block style under proxies:
  // 支持嵌套 ws-opts.path / ws-opts.headers.Host（CF VLESS 必需）
  const lines = text.split(/\r?\n/);
  let inProxies = false;
  let proxiesIndent = 0;
  let cur: Record<string, string> | null = null;
  let itemIndent = -1;
  /** 0=item 字段, 1=ws-opts/opts, 2=headers under opts */
  let nest = 0;
  let nestIndent = -1;

  const flush = () => {
    if (cur && Object.keys(cur).length) pushLink(clashProxyToShareLink(cur));
    cur = null;
    itemIndent = -1;
    nest = 0;
    nestIndent = -1;
  };

  for (const rawLine of lines) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = rawLine.trim();

    if (/^proxies\s*:/.test(trimmed)) {
      flush();
      inProxies = true;
      proxiesIndent = indent;
      continue;
    }

    // 离开 proxies 段（同级或更外的新 key）
    if (inProxies && indent <= proxiesIndent && !trimmed.startsWith('-') && /:\s*/.test(trimmed)) {
      // 例如 proxy-groups: / rules:
      if (!trimmed.startsWith('#')) {
        flush();
        inProxies = false;
      }
    }

    if (!inProxies) {
      // 无 proxies 头时：见到 list item 且含 type: 也尝试
      if (/^-\s+/.test(trimmed) && /type\s*:/.test(text.slice(text.indexOf(rawLine), text.indexOf(rawLine) + 400))) {
        // fallthrough only when whole file looks like proxy dump
      } else {
        continue;
      }
    }

    // 新 list item
    if (/^-\s+/.test(trimmed) || /^-\s*$/.test(trimmed)) {
      flush();
      cur = {};
      itemIndent = indent;
      nest = 0;
      nestIndent = -1;
      // `- { ... }` 已在 flow 处理；block: `- name: xx` 或 `-`
      const rest = trimmed.replace(/^-\s*/, '');
      if (rest.startsWith('{')) {
        const inner = rest.replace(/^\{/, '').replace(/\}$/, '');
        const obj = parseClashFlowMap(inner);
        if (obj) {
          pushLink(clashProxyToShareLink(obj));
          cur = null;
        }
      } else if (rest.includes(':')) {
        const { k, v } = splitYamlKv(rest);
        if (k) applyClashProxyField(cur, k, v, 0);
      }
      continue;
    }

    // item / 嵌套字段
    if (cur && itemIndent >= 0 && indent > itemIndent) {
      // 回退嵌套层
      if (nest > 0 && indent <= nestIndent) {
        if (nest === 2) {
          nest = 1;
          nestIndent = itemIndent + 2;
        } else {
          nest = 0;
          nestIndent = -1;
        }
        if (nest > 0 && indent <= nestIndent) {
          nest = 0;
          nestIndent = -1;
        }
      }
      const { k, v } = splitYamlKv(trimmed);
      if (!k) continue;
      const kl = k.toLowerCase();
      if (nest === 0 && (kl === 'ws-opts' || kl === 'opts' || kl === 'ws_opts')) {
        nest = 1;
        nestIndent = indent;
        // 同行内联 map: ws-opts: { path: /, headers: { Host: x } }
        if (v && v.includes(':')) {
          const inline = parseClashFlowMap(v.replace(/^\{/, '').replace(/\}$/, ''));
          if (inline) {
            for (const [ik, iv] of Object.entries(inline)) {
              applyClashProxyField(cur, ik, iv, 1);
            }
          }
        }
        continue;
      }
      if (nest === 1 && (kl === 'headers' || kl === 'header')) {
        nest = 2;
        nestIndent = indent;
        if (v && v.includes(':')) {
          const inline = parseClashFlowMap(v.replace(/^\{/, '').replace(/\}$/, ''));
          if (inline) {
            for (const [ik, iv] of Object.entries(inline)) {
              applyClashProxyField(cur, ik, iv, 2);
            }
          }
        }
        continue;
      }
      applyClashProxyField(cur, k, v, nest);
    }
  }
  flush();
  return links;
}

/** 把 Clash 字段摊平到 proxy map（含嵌套 ws-opts 语义） */
function applyClashProxyField(
  cur: Record<string, string>,
  k: string,
  v: string,
  nest: number
): void {
  const kl = k.toLowerCase();
  if (nest === 2) {
    // headers.Host → host
    if (kl === 'host') {
      cur.host = v;
      return;
    }
    cur[`header-${kl}`] = v;
    return;
  }
  if (nest === 1) {
    if (kl === 'path') {
      cur.path = v;
      cur['ws-path'] = v;
      return;
    }
    if (kl === 'host') {
      cur.host = v;
      return;
    }
    cur[kl] = v;
    return;
  }
  // reality-opts 等扁平别名
  if (kl === 'public-key' || kl === 'public_key') cur.pbk = v;
  if (kl === 'short-id' || kl === 'short_id') cur.sid = v;
  cur[kl] = v;
}

function splitYamlKv(line: string): { k: string; v: string } {
  const m = line.match(/^([^:#]+):\s*(.*)$/);
  if (!m) return { k: '', v: '' };
  let v = (m[2] || '').trim();
  // 去引号
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return { k: m[1].trim().toLowerCase(), v };
}

function parseClashFlowMap(inner: string): Record<string, string> | null {
  const obj: Record<string, string> = {};
  // 简易逗号分割，忽略引号内逗号
  let buf = '';
  let q: '"' | "'" | null = null;
  const parts: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (q) {
      buf += ch;
      if (ch === q && inner[i - 1] !== '\\\\') q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      buf += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  for (const p of parts) {
    const { k, v } = splitYamlKv(p);
    if (k) obj[k] = v;
  }
  return Object.keys(obj).length ? obj : null;
}

function clashProxyToShareLink(p: Record<string, string>): string | null {
  const type = String(p.type || '').toLowerCase();
  const server = String(p.server || p.servername || '').trim();
  const port = String(p.port || '').trim();
  const name = String(p.name || p.ps || `${server}:${port}`).trim() || 'node';
  if (!server || !port) return null;

  const q: string[] = [];
  const add = (k: string, v: string | undefined) => {
    if (v == null || v === '') return;
    q.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  };

  if (type === 'ss' || type === 'shadowsocks') {
    const method = p.cipher || p.method || 'aes-256-gcm';
    const password = p.password || '';
    if (!password) return null;
    const userinfo = Buffer.from(`${method}:${password}`, 'utf8').toString('base64');
    return `ss://${userinfo}@${server}:${port}#${encodeURIComponent(name)}`;
  }

  if (type === 'vmess') {
    const uuid = p.uuid || p.id || '';
    if (!uuid) return null;
    const net = (p.network || p.net || 'tcp').toLowerCase();
    const tls = String(p.tls || '').toLowerCase();
    const obj: Record<string, unknown> = {
      v: '2',
      ps: name,
      add: server,
      port: Number(port) || port,
      id: uuid,
      aid: Number(p.alterid || p.alterId || p.aid || 0),
      scy: p.cipher || p.security || 'auto',
      net,
      type: p.type_header || 'none',
      host: p.host || p['ws-opts'] || '',
      path: p.path || '/',
      tls: tls === 'true' || tls === 'tls' ? 'tls' : '',
      sni: p.sni || p.servername || p.host || ''
    };
    // ws path / host 常见字段
    if (p['ws-path']) obj.path = p['ws-path'];
    if (p['ws-headers-host']) obj.host = p['ws-headers-host'];
    const b64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
    return `vmess://${b64}`;
  }

  if (type === 'vless') {
    const uuid = p.uuid || p.id || '';
    if (!uuid) return null;
    const network = (p.network || p.net || 'tcp').toLowerCase();
    const sni = p.sni || p.servername || p['server-name'] || '';
    // CF / 机场常见：tls 布尔 或 security: tls|reality
    let security = String(p.security || '').toLowerCase();
    if (!security || security === 'none') {
      if (p.tls === 'true' || p.tls === 'tls' || p.tls === '1') security = 'tls';
      else if (p.reality === 'true' || p['reality-opts'] || p.pbk) security = 'reality';
      else security = 'none';
    }
    const host =
      p.host ||
      p['ws-headers-host'] ||
      p['header-host'] ||
      (network === 'ws' || network === 'http' ? sni : '') ||
      '';
    const path =
      p.path ||
      p['ws-path'] ||
      (network === 'ws' || network === 'http' || network === 'grpc' ? '/' : '');
    add('encryption', p.encryption || 'none');
    add('type', network);
    add('security', security);
    add('sni', sni || host);
    if (path) add('path', path);
    if (host) add('host', host);
    add('fp', p['client-fingerprint'] || p.fp || p.fingerprint);
    add('flow', p.flow);
    add('serviceName', p['grpc-service-name'] || p.servicename || p['service-name']);
    add('pbk', p.pbk || p['public-key'] || p.public_key);
    add('sid', p.sid || p['short-id'] || p.short_id);
    // 多数现代 VLESS 订阅带 xudp；有则保留，无则 ws 默认 xudp
    const pe =
      p.packetencoding ||
      p['packet-encoding'] ||
      p.packet_encoding ||
      p.packetEncoding ||
      (network === 'ws' ? 'xudp' : '');
    add('packetEncoding', pe);
    const qs = q.length ? `?${q.join('&')}` : '';
    // uuid 保持原样（勿过度 encode，兼容客户端）
    return `vless://${uuid}@${server}:${port}${qs}#${encodeURIComponent(name)}`;
  }

  if (type === 'trojan') {
    const password = p.password || '';
    if (!password) return null;
    const network = (p.network || 'tcp').toLowerCase();
    const sni = p.sni || p.servername || p['server-name'] || '';
    const host =
      p.host ||
      p['ws-headers-host'] ||
      p['header-host'] ||
      (network === 'ws' || network === 'http' ? sni : '') ||
      '';
    const path = p.path || p['ws-path'] || (network === 'ws' || network === 'http' ? '/' : '');
    add('type', network);
    add('security', 'tls');
    add('sni', sni || host);
    if (path) add('path', path);
    if (host) add('host', host);
    add('fp', p['client-fingerprint'] || p.fp || p.fingerprint);
    const qs = q.length ? `?${q.join('&')}` : '';
    return `trojan://${encodeURIComponent(password)}@${server}:${port}${qs}#${encodeURIComponent(name)}`;
  }

  if (type === 'hysteria2' || type === 'hy2') {
    const password = p.password || p.auth || '';
    if (!password) return null;
    add('sni', p.sni || p.servername);
    add('insecure', p['skip-cert-verify'] === 'true' ? '1' : undefined);
    add('obfs', p.obfs);
    add('obfs-password', p['obfs-password'] || p.obfsPassword);
    const qs = q.length ? `?${q.join('&')}` : '';
    return `hysteria2://${encodeURIComponent(password)}@${server}:${port}${qs}#${encodeURIComponent(name)}`;
  }

  if (type === 'tuic') {
    const uuid = p.uuid || '';
    const password = p.password || '';
    if (!uuid) return null;
    add('sni', p.sni || p.servername);
    add('congestion_control', p['congestion-controller'] || p.congestion_control);
    add('udp_relay_mode', p['udp-relay-mode']);
    add('alpn', p.alpn);
    const qs = q.length ? `?${q.join('&')}` : '';
    const user = password ? `${uuid}:${password}` : uuid;
    return `tuic://${encodeURIComponent(user)}@${server}:${port}${qs}#${encodeURIComponent(name)}`;
  }

  if (type === 'anytls') {
    const password = p.password || p.pass || '';
    if (!password) return null;
    const sni = p.sni || p.servername || p['server-name'] || '';
    add('sni', sni);
    add('fp', p['client-fingerprint'] || p.fp || p.fingerprint);
    add('alpn', p.alpn);
    if (p['skip-cert-verify'] === 'true' || p.insecure === 'true' || p.insecure === '1') {
      add('insecure', '1');
    }
    add(
      'idleSessionCheckInterval',
      p['idle-session-check-interval'] || p.idle_session_check_interval
    );
    add(
      'idleSessionTimeout',
      p['idle-session-timeout'] || p.idle_session_timeout
    );
    add('minIdleSession', p['min-idle-session'] || p.min_idle_session);
    const qs = q.length ? `?${q.join('&')}` : '';
    return `anytls://${encodeURIComponent(password)}@${server}:${port}${qs}#${encodeURIComponent(name)}`;
  }

  if (type === 'http' || type === 'https') {
    const user = p.username || p.user || '';
    const pass = p.password || p.pass || '';
    const auth =
      user && pass
        ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
        : user
          ? `${encodeURIComponent(user)}@`
          : '';
    const sch = type === 'https' || p.tls === 'true' ? 'https' : 'http';
    return `${sch}://${auth}${server}:${port}#${encodeURIComponent(name)}`;
  }

  if (type === 'socks' || type === 'socks5' || type === 'socks4') {
    const user = p.username || p.user || '';
    const pass = p.password || p.pass || '';
    const auth =
      user && pass
        ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
        : user
          ? `${encodeURIComponent(user)}@`
          : '';
    const sch =
      type === 'socks4' || p.version === '4' || p.version === 'socks4'
        ? 'socks4'
        : 'socks5';
    return `${sch}://${auth}${server}:${port}#${encodeURIComponent(name)}`;
  }

  return null;
}

function expandSubscriptionBody(raw: string): string[] {
  const body0 = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!body0) return [];

  const merge = (into: string[], extra: string[]) => {
    for (const x of extra) {
      if (!into.includes(x)) into.push(x);
    }
    return into;
  };

  // 1) 明文分享链接
  let links = extractShareLinksFromText(body0);
  if (links.length > 0) return links;

  // 2) Clash YAML proxies（明文）
  links = merge(links, parseClashProxiesToShareLinks(body0));
  if (links.length > 0) return links;

  // 3) 整包 Base64（标准 / URL-safe）→ 再抽链接或 Clash
  const decoded = tryBase64Decode(body0);
  if (decoded) {
    links = merge(links, extractShareLinksFromText(decoded));
    if (links.length > 0) return links;
    links = merge(links, parseClashProxiesToShareLinks(decoded));
    if (links.length > 0) return links;
  }

  // 4) 多行各自可能是 Base64 段
  for (const line of body0.split(/\r?\n/)) {
    const d = tryBase64Decode(line.trim());
    if (!d) continue;
    links = merge(links, extractShareLinksFromText(d));
    links = merge(links, parseClashProxiesToShareLinks(d));
  }
  return links;
}

function httpGetText(url: string, timeoutMs = 25000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const done = (err: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolvePromise(text || '');
    };
    try {
      const u = new URL(url);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(
        u,
        {
          method: 'GET',
          timeout: timeoutMs,
          headers: {
            // 部分订阅站按 UA 分流；用常见 Clash 客户端标识提高兼容
            'User-Agent':
              'clash-meta/1.18.0 GrokRegisterAgent/1.0 (+subscription-import)',
            Accept: 'text/plain,application/octet-stream,*/*'
          }
        },
        (res) => {
          const code = res.statusCode || 0;
          // 简单跟随 1 次重定向
          if (
            code >= 300 &&
            code < 400 &&
            res.headers.location &&
            typeof res.headers.location === 'string'
          ) {
            const next = new URL(res.headers.location, u).toString();
            res.resume();
            httpGetText(next, timeoutMs).then(
              (t) => done(null, t),
              (e) => done(e instanceof Error ? e : new Error(String(e)))
            );
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (code < 200 || code >= 300) {
              done(
                new Error(
                  `HTTP ${code}: ${buf.toString('utf8').slice(0, 120) || 'empty'}`
                )
              );
              return;
            }
            done(null, buf.toString('utf8'));
          });
        }
      );
      req.on('error', (e) => done(e));
      req.on('timeout', () => {
        req.destroy();
        done(new Error(`timeout ${timeoutMs}ms`));
      });
      req.end();
    } catch (e) {
      done(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export type SubscriptionImportResult = {
  ok: boolean;
  url: string;
  /** 抽到的分享链接（可 parse） */
  links: string[];
  /** 可被 sing-box 解析的节点摘要 */
  nodes: SingBoxNodeSummary[];
  /** 合并后的节点文本（每行一条） */
  nodesText: string;
  message: string;
  error?: string;
};

/**
 * 拉取订阅 URL → 解码/抽取分享链接 → 用现有 parse 校验。
 * 说明：官方 sing-box 内核不提供「订阅 URL 命令」；订阅解析由客户端完成，
 * 本函数即客户端侧解析，再交给本仓库的节点列表 / 配置生成。
 */
export async function fetchSubscriptionLinks(
  urlRaw: string,
  opts?: { timeoutMs?: number; existingText?: string; mode?: 'replace' | 'append' }
): Promise<SubscriptionImportResult> {
  const url = String(urlRaw || '').trim();
  const mode = opts?.mode === 'append' ? 'append' : 'replace';
  if (!url) {
    return {
      ok: false,
      url: '',
      links: [],
      nodes: [],
      nodesText: '',
      message: '请填写订阅链接',
      error: 'empty url'
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      url,
      links: [],
      nodes: [],
      nodesText: '',
      message: '订阅地址不是合法 URL',
      error: 'invalid url'
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      url,
      links: [],
      nodes: [],
      nodesText: '',
      message: '仅支持 http(s) 订阅地址',
      error: 'bad protocol'
    };
  }

  let body: string;
  try {
    body = await httpGetText(url, opts?.timeoutMs ?? 25000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      url,
      links: [],
      nodes: [],
      nodesText: '',
      message: `拉取订阅失败: ${msg}`,
      error: msg
    };
  }

  const links = expandSubscriptionBody(body);
  if (links.length === 0) {
    return {
      ok: false,
      url,
      links: [],
      nodes: [],
      nodesText: '',
      message:
        '未解析到节点：支持 Base64 分享列表、明文链接、Clash YAML proxies（ss/vmess/vless/trojan/hysteria2/tuic/anytls）；加密订阅或不支持的类型会失败',
      error: 'no share links'
    };
  }

  // 校验：只保留 parse 成功的
  const good: string[] = [];
  for (let i = 0; i < links.length; i++) {
    if (parseSingBoxNodeLine(links[i], i)) good.push(links[i]);
  }
  if (good.length === 0) {
    return {
      ok: false,
      url,
      links,
      nodes: [],
      nodesText: '',
      message: `抽到 ${links.length} 条链接但均无法解析为节点`,
      error: 'parse fail'
    };
  }

  let nodesText = good.join('\n');
  if (mode === 'append') {
    const prev = String(opts?.existingText || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const set = new Set(prev.map((l) => l.toLowerCase()));
    const merged = [...prev];
    for (const g of good) {
      if (!set.has(g.toLowerCase())) {
        set.add(g.toLowerCase());
        merged.push(g);
      }
    }
    nodesText = merged.join('\n');
  }

  const nodes = listSingBoxNodeSummaries(nodesText);
  return {
    ok: true,
    url,
    links: good,
    nodes,
    nodesText,
    message: `已解析 ${good.length} 条节点` + (mode === 'append' ? '（追加去重）' : '（替换列表）')
  };
}


/** 固定本地端口（不对用户开放） */
export const SING_BOX_FIXED_PORT = 2080;
/** 设置项：随机节点（注册启动/降级轮换时抽取） */
export const SING_BOX_SELECTED_RANDOM = '__random__';

/** 本进程内已降级/跳过的 tag（注册失败轮换用；进程重启清空） */
const demotedTags = new Set<string>();

function isRandomSelected(selected: string): boolean {
  const s = String(selected || '').trim();
  return !s || s === SING_BOX_SELECTED_RANDOM;
}

function pickNode(
  nodes: ParsedNode[],
  selected: string,
  opts?: { forceRandom?: boolean; excludeTags?: Set<string> }
): ParsedNode | null {
  if (!nodes.length) return null;
  const exclude = opts?.excludeTags;
  const pool = exclude?.size
    ? nodes.filter((n) => !exclude.has(n.tag))
    : nodes;
  const use = pool.length ? pool : nodes;

  if (opts?.forceRandom || isRandomSelected(selected)) {
    return use[Math.floor(Math.random() * use.length)] || null;
  }
  const hit = use.find((n) => n.tag === selected || n.name === selected);
  if (hit) return hit;
  const any = nodes.find((n) => n.tag === selected || n.name === selected);
  return any || use[0] || null;
}

/**
 * sing-box 1.13+：inbound 不再支持 sniff / sniff_override_destination 等遗留字段。
 * @see https://sing-box.sagernet.org/migration/#migrate-legacy-inbound-fields-to-rule-actions
 */
function buildSingBoxConfig(port: number, node: ParsedNode): Record<string, unknown> {
  return {
    log: { level: 'info', timestamp: true },
    inbounds: [
      {
        type: 'mixed',
        tag: 'mixed-in',
        listen: '127.0.0.1',
        listen_port: port
      }
    ],
    outbounds: [
      node.outbound,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' }
    ],
    route: {
      auto_detect_interface: true,
      final: node.tag
    }
  };
}

function fixedListenPort(_settings?: AppSettings): number {
  return SING_BOX_FIXED_PORT;
}

function closeLog() {
  if (logStream) {
    try {
      logStream.end();
    } catch {
      /* ignore */
    }
    logStream = null;
  }
}

function killChild(): void {
  if (!child) return;
  const proc = child;
  child = null;
  try {
    proc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 2000);
}

export function getSingBoxStatus(settings?: AppSettings): SingBoxStatus {
  const port = fixedListenPort(settings);
  const binary = resolveSingBoxBinary();
  const running = !!(child && child.pid && !child.killed);
  const nodes = settings ? parseSingBoxNodes(settings.singBoxNodes || '') : [];
  const pref = settings?.singBoxSelected || '';
  // 状态展示：随机模式显示偏好；运行中显示实际节点
  const activeTag = lastSelected || '';
  const activeName = lastSelectedName || '';
  const prefNode = nodes.length ? pickNode(nodes, pref) : null;
  return {
    running,
    pid: running && child?.pid ? child.pid : null,
    port,
    localUrl: buildSingBoxLocalProxyUrl({ singBoxPort: port }),
    binary: binary || lastBinary,
    binaryExists: !!binary && existsSync(binary),
    selected: isRandomSelected(pref)
      ? SING_BOX_SELECTED_RANDOM
      : prefNode?.tag || pref || activeTag || '',
    selectedName: isRandomSelected(pref)
      ? running && activeName
        ? `随机 · 当前 ${activeName}`
        : '随机节点'
      : prefNode?.name || activeName || '',
    nodeCount: settings ? nodes.length : lastNodeCount,
    lastError,
    startedAt: running ? startedAt : null,
    logPath: lastLogPath,
    configPath: lastConfigPath,
    platform: process.platform,
    arch: process.arch
  };
}

export async function stopSingBox(): Promise<SingBoxStatus> {
  killChild();
  closeLog();
  startedAt = null;
  lastError = null;
  lastConfigKey = null;
  return getSingBoxStatus();
}

export function readSingBoxLog(_settings?: AppSettings, tail = 200): SingBoxLogResult {
  const logPath = lastLogPath;
  if (!logPath) {
    return { ok: true, logPath: null, content: '', truncated: false };
  }
  try {
    if (!existsSync(logPath)) {
      return { ok: true, logPath, content: '', truncated: false };
    }
    const maxBytes = 256 * 1024;
    const raw = readFileSync(logPath);
    const sliced = raw.length > maxBytes ? raw.subarray(raw.length - maxBytes) : raw;
    let content = sliced.toString('utf8');
    const lines = content.split(/\r?\n/);
    const limit =
      Number.isInteger(tail) && tail > 0 ? Math.min(Math.floor(tail), 1000) : 200;
    const truncatedByLines = lines.length > limit;
    if (truncatedByLines) content = lines.slice(-limit).join('\n');
    return {
      ok: true,
      logPath,
      content,
      truncated: raw.length > maxBytes || truncatedByLines
    };
  } catch (err) {
    return {
      ok: false,
      logPath,
      content: '',
      truncated: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

export type SyncSingBoxOptions = {
  /** 注册启动：随机模式下重新抽节点；固定模式保持 selected */
  forRegister?: boolean;
  /** 强制换节点（降级）：跳过当前 tag，从剩余中抽 */
  rotate?: boolean;
  /** 降级原因（写入日志） */
  reason?: string;
};

/**
 * 按 settings 启停 sing-box。
 * - singBoxEnabled=false → 停止
 * - true → 配置变更或未运行则重启
 * - forRegister：随机节点时每轮重抽
 * - rotate：注册失败降级，换下一节点
 */
export async function syncSingBoxFromSettings(
  settings: AppSettings,
  opts: SyncSingBoxOptions = {}
): Promise<SingBoxStatus> {
  if (!settings.singBoxEnabled) {
    demotedTags.clear();
    return stopSingBox();
  }

  const listenPort = fixedListenPort(settings);
  const nodes = parseSingBoxNodes(settings.singBoxNodes || '');
  lastNodeCount = nodes.length;
  const pref = settings.singBoxSelected || '';

  if (opts.rotate && lastSelected) {
    demotedTags.add(lastSelected);
  }

  // 全部降级过则清空再轮
  if (opts.rotate && demotedTags.size >= nodes.length && nodes.length > 0) {
    demotedTags.clear();
    if (lastSelected) demotedTags.add(lastSelected);
  }

  const registerRepick = !!opts.forRegister && isRandomSelected(pref);
  const node = pickNode(nodes, pref, {
    forceRandom: registerRepick,
    excludeTags: opts.rotate ? demotedTags : undefined
  });
  if (!node) {
    lastError = '没有可解析的节点（支持 ss/vmess/vless/trojan/hysteria2/tuic/anytls 分享链接，以及 http/https/socks4/socks5 代理）';
    await stopSingBox();
    return getSingBoxStatus(settings);
  }
  lastSelected = node.tag;
  lastSelectedName = node.name;

  if (process.platform === 'win32') {
    lastError =
      'sing-box 仅在 Linux 镜像内运行（已打包 linux-amd64/arm64）。Windows 开发环境请用 Docker。';
    return getSingBoxStatus(settings);
  }

  const binary = resolveSingBoxBinary();
  if (!binary || !existsSync(binary)) {
    lastBinary = binary;
    lastError = `未找到 sing-box 二进制（期望 register/bin/sing-box/linux-${
      process.arch === 'arm64' ? 'arm64' : 'amd64'
    }）`;
    await stopSingBox();
    return getSingBoxStatus(settings);
  }

  try {
    chmodSync(binary, 0o755);
  } catch {
    /* ignore */
  }

  const conf = buildSingBoxConfig(listenPort, node);
  const configKey = JSON.stringify({
    port: listenPort,
    tag: node.tag,
    outbound: node.outbound
  });
  const running = !!(child && child.pid && !child.killed);
  // 降级轮换强制重启；注册仅在随机重抽时若节点未变可跳过
  if (
    running &&
    lastConfigKey === configKey &&
    lastBinary === binary &&
    !opts.rotate
  ) {
    return getSingBoxStatus(settings);
  }

  killChild();
  closeLog();

  const dir = join(dataDir(), 'sing-box');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  lastConfigPath = join(dir, 'config.json');
  lastLogPath = join(dir, `${listenPort}.log`);
  try {
    writeFileSync(lastConfigPath, JSON.stringify(conf, null, 2), 'utf8');
  } catch (e) {
    lastError = `无法写配置: ${String(e)}`;
    return getSingBoxStatus(settings);
  }
  try {
    // 每次启动截断日志，避免旧 FATAL 与成功启动混在一起误导排查
    logStream = createWriteStream(lastLogPath, { flags: 'w' });
    const head =
      opts.rotate
        ? `[rotate] ${opts.reason || 'node degrade'} → ${node.name} (${node.tag})\n`
        : opts.forRegister
          ? `[register] pick ${node.name} (${node.tag})\n`
          : `[start] ${node.name} (${node.tag}) port=${listenPort}\n`;
    logStream.write(head);
  } catch (e) {
    lastError = `无法写日志: ${String(e)}`;
    logStream = null;
  }

  let proc: ChildProcess;
  try {
    proc = spawn(binary, ['run', '-c', lastConfigPath], {
      cwd: join(binary, '..'),
      env: { ...process.env, LANG: 'en_US.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    lastError = `启动失败: ${String(e)}`;
    child = null;
    return getSingBoxStatus(settings);
  }

  child = proc;
  startedAt = Date.now();
  lastError = null;
  lastBinary = binary;
  lastConfigKey = configKey;

  const onData = (buf: Buffer) => {
    try {
      logStream?.write(buf);
    } catch {
      /* ignore */
    }
  };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  proc.on('error', (err) => {
    lastError = err.message || String(err);
  });
  proc.on('exit', (code, signal) => {
    if (child === proc) {
      lastError =
        lastError ||
        `sing-box 已退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      child = null;
      closeLog();
      startedAt = null;
      lastConfigKey = null;
    }
  });

  await new Promise((r) => setTimeout(r, 400));
  if (!child || child.killed) {
    lastError = lastError || 'sing-box 启动后立即退出，请查看日志或节点是否可解析';
  }

  return getSingBoxStatus(settings);
}

/**
 * 注册失败：标记当前节点并切换到其他节点后重启 sing-box（本地 127.0.0.1 端口不变）。
 */
export async function rotateSingBoxNode(
  settings: AppSettings,
  reason = '注册失败'
): Promise<SingBoxStatus & { rotated: boolean; from?: string; to?: string }> {
  if (!settings.singBoxEnabled) {
    return { ...getSingBoxStatus(settings), rotated: false };
  }
  const from = lastSelected || '';
  const st = await syncSingBoxFromSettings(settings, { rotate: true, reason });
  const to = lastSelected || '';
  const rotated = !!to && to !== from;
  return { ...st, rotated, from, to };
}
