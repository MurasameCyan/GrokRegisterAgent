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
      outbound.flow = params.flow || undefined;
      outbound.packet_encoding = params.packetEncoding || undefined;
    } else {
      outbound.password = user;
    }
    const security = (params.security || '').toLowerCase();
    if (security === 'tls' || security === 'reality') {
      const tls: Record<string, unknown> = {
        enabled: true,
        server_name: params.sni || params.peer || host,
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
    if (net === 'ws') {
      outbound.transport = {
        type: 'ws',
        path: params.path || '/',
        headers: params.host ? { Host: params.host } : undefined
      };
    } else if (net === 'grpc') {
      outbound.transport = {
        type: 'grpc',
        service_name: params.serviceName || params.path || ''
      };
    } else if (net === 'http') {
      outbound.transport = {
        type: 'http',
        host: params.host ? [params.host] : undefined,
        path: params.path || '/'
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

export function parseSingBoxNodeLine(line: string, idx = 0): ParsedNode | null {
  const { url } = stripNodeComment(line);
  const u = url.trim();
  if (!u) return null;
  const lower = u.toLowerCase();
  if (lower.startsWith('ss://')) return parseSs(u, idx);
  if (lower.startsWith('vmess://')) return parseVmess(u, idx);
  if (lower.startsWith('vless://')) return parseVlessOrTrojan(u, idx, 'vless');
  if (lower.startsWith('trojan://')) return parseVlessOrTrojan(u, idx, 'trojan');
  if (lower.startsWith('hysteria2://') || lower.startsWith('hy2://'))
    return parseHysteria2(u, idx);
  if (lower.startsWith('tuic://')) return parseTuic(u, idx);
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
    lastError = '没有可解析的节点（支持 ss/vmess/vless/trojan/hysteria2/tuic 分享链接）';
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
