/**
 * Cloudflare cfwp 本地 HTTP/SOCKS 代理进程管理。
 * 仅使用 Linux 二进制：register/bin/cfwp/linux-amd64 | linux-arm64
 * 参数对齐 s5http_wkpgs/cfsh.sh。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  readFileSync,
  type WriteStream,
  chmodSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings } from '@shared/settings';
import { buildCfLocalProxyUrl } from '@shared/settings';

export type CfwpStatus = {
  running: boolean;
  pid: number | null;
  port: number;
  localUrl: string;
  binary: string | null;
  binaryExists: boolean;
  domain: string;
  lastError: string | null;
  startedAt: number | null;
  logPath: string | null;
  platform: string;
  arch: string;
};

/** 最近 cfwp 日志读取结果（只读，不删文件） */
export type CfwpLogResult = {
  ok: boolean;
  logPath: string | null;
  content: string;
  truncated: boolean;
  error?: string;
};

type CfwpRuntimeConfig = {
  domain: string;
  token: string;
  port: number;
  cdnip: string;
  pyip: string;
  dns: string;
  enableEch: boolean;
  cnrule: boolean;
  localScheme: 'socks5' | 'http';
};

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let child: ChildProcess | null = null;
let logStream: WriteStream | null = null;
let startedAt: number | null = null;
let lastError: string | null = null;
let lastConfig: CfwpRuntimeConfig | null = null;
let lastBinary: string | null = null;
let lastLogPath: string | null = null;

function dataDir(): string {
  return resolve(process.env.DATA_DIR || '/data');
}

function registerDirCandidates(): string[] {
  const out: string[] = [];
  const env = String(process.env.REGISTER_DIR || '').trim();
  if (env) out.push(resolve(env));
  // server/dist → ../../../register 或 项目根/register
  out.push(resolve(__dirname, '../../register'));
  out.push(resolve(__dirname, '../../../register'));
  out.push('/app/register');
  return out;
}

/** 按 arch 选择 linux 二进制（不打包 windows） */
export function resolveCfwpBinary(): string | null {
  const arch = process.arch;
  // arm64 / aarch64 → linux-arm64；其余 x64 用 amd64
  const name =
    arch === 'arm64' ? 'linux-arm64' : arch === 'arm' ? 'linux-arm' : 'linux-amd64';
  for (const reg of registerDirCandidates()) {
    const p = join(reg, 'bin', 'cfwp', name);
    if (existsSync(p)) return p;
  }
  // 兼容仅有 amd64 的镜像在 arm 上（会失败，但路径可探测）
  for (const reg of registerDirCandidates()) {
    const fallback = join(reg, 'bin', 'cfwp', 'linux-amd64');
    if (existsSync(fallback)) return fallback;
  }
  return null;
}

function configFromSettings(s: AppSettings): CfwpRuntimeConfig {
  const port = Number(s.cfProxyPort);
  return {
    domain: String(s.cfProxyDomain || '').trim(),
    token: String(s.cfProxyToken || '').trim(),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 30000,
    cdnip: String(s.cfProxyCdnip || '').trim() || 'yg1.ygkkk.dpdns.org',
    pyip: String(s.cfProxyPyip || '').trim(),
    dns: String(s.cfProxyDns || '').trim() || 'dns.alidns.com/dns-query',
    enableEch: s.cfProxyEnableEch !== false,
    cnrule: s.cfProxyCnrule !== false,
    localScheme: s.cfProxyLocalScheme === 'http' ? 'http' : 'socks5'
  };
}

function buildArgs(c: CfwpRuntimeConfig): string[] {
  // 对齐 cfsh.sh：
  // cfwp client_ip=:$port dns=... cf_domain=... cf_cdnip=... token=... enable_ech=y/n cnrule=y/n pyip=...
  return [
    `client_ip=:${c.port}`,
    `dns=${c.dns}`,
    `cf_domain=${c.domain}`,
    `cf_cdnip=${c.cdnip}`,
    `token=${c.token}`,
    `enable_ech=${c.enableEch ? 'y' : 'n'}`,
    `cnrule=${c.cnrule ? 'y' : 'n'}`,
    `pyip=${c.pyip}`
  ];
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
  // 强杀兜底
  setTimeout(() => {
    try {
      if (!proc.killed) proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 2000);
}

export function getCfwpStatus(settings?: AppSettings): CfwpStatus {
  const cfg = settings
    ? configFromSettings(settings)
    : lastConfig || {
        domain: '',
        token: '',
        port: 30000,
        cdnip: 'yg1.ygkkk.dpdns.org',
        pyip: '',
        dns: 'dns.alidns.com/dns-query',
        enableEch: true,
        cnrule: true,
        localScheme: 'socks5' as const
      };
  const binary = resolveCfwpBinary();
  const running = !!(child && child.pid && !child.killed);
  return {
    running,
    pid: running && child?.pid ? child.pid : null,
    port: cfg.port,
    localUrl: buildCfLocalProxyUrl({
      cfProxyPort: cfg.port,
      cfProxyLocalScheme: cfg.localScheme
    }),
    binary: binary || lastBinary,
    binaryExists: !!binary && existsSync(binary),
    domain: cfg.domain,
    lastError,
    startedAt: running ? startedAt : null,
    logPath: lastLogPath,
    platform: process.platform,
    arch: process.arch
  };
}

export async function stopCfwp(): Promise<CfwpStatus> {
  killChild();
  closeLog();
  startedAt = null;
  lastError = null;
  return getCfwpStatus();
}

/**
 * 读取当前 cfwp 日志末尾。
 * - 默认最近 200 行，最多 1000 行
 * - 最多读末尾 256KB，避免大日志卡死
 * - 若 settings 带 token，则脱敏为 ******
 */
export function readCfwpLog(settings?: AppSettings, tail = 200): CfwpLogResult {
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
    const token = String(settings?.cfProxyToken || '').trim();
    if (token) content = content.split(token).join('******');
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

/**
 * 按 settings 启停 cfwp。
 * - cfProxyEnabled=false → 停止
 * - true → 若配置变更或未运行则重启
 */
export async function syncCfwpFromSettings(settings: AppSettings): Promise<CfwpStatus> {
  if (!settings.cfProxyEnabled) {
    return stopCfwp();
  }

  const cfg = configFromSettings(settings);
  if (!cfg.domain) {
    lastError = '缺少 CF 域名（cfProxyDomain，格式 域名:端口）';
    await stopCfwp();
    return getCfwpStatus(settings);
  }

  if (process.platform === 'win32') {
    // 开发机 Windows 无 linux 二进制可执行；仅 Linux 镜像内运行
    lastError =
      'cfwp 仅在 Linux 镜像内运行（已打包 linux-amd64/arm64）。Windows 开发环境请用 Docker。';
    lastConfig = cfg;
    return getCfwpStatus(settings);
  }

  const binary = resolveCfwpBinary();
  if (!binary || !existsSync(binary)) {
    lastBinary = binary;
    lastConfig = cfg;
    lastError = `未找到 cfwp 二进制（期望 register/bin/cfwp/linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}）`;
    await stopCfwp();
    return getCfwpStatus(settings);
  }

  try {
    chmodSync(binary, 0o755);
  } catch {
    /* ignore */
  }

  // 配置未变且在跑 → 跳过
  const running = !!(child && child.pid && !child.killed);
  const prev = lastConfig;
  if (
    running &&
    prev &&
    configsEqual(prev, cfg) &&
    lastBinary === binary
  ) {
    lastConfig = cfg;
    lastBinary = binary;
    return getCfwpStatus(settings);
  }

  killChild();
  closeLog();

  const logDir = join(dataDir(), 'cfwp');
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* ignore */
  }
  lastLogPath = join(logDir, `${cfg.port}.log`);
  try {
    logStream = createWriteStream(lastLogPath, { flags: 'a' });
  } catch (e) {
    lastError = `无法写日志: ${String(e)}`;
    logStream = null;
  }

  const args = buildArgs(cfg);
  let proc: ChildProcess;
  try {
    proc = spawn(binary, args, {
      cwd: join(binary, '..'),
      env: { ...process.env, LANG: 'en_US.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    lastError = `启动失败: ${String(e)}`;
    child = null;
    return getCfwpStatus(settings);
  }

  child = proc;
  startedAt = Date.now();
  lastError = null;
  lastBinary = binary;
  lastConfig = cfg;

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
        `cfwp 已退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      child = null;
      closeLog();
      startedAt = null;
    }
  });

  // 短暂等待，捕获立即失败
  await new Promise((r) => setTimeout(r, 400));
  if (!child || child.killed) {
    lastError = lastError || 'cfwp 启动后立即退出，请查看日志';
  }

  return getCfwpStatus(settings);
}

function configsEqual(a: CfwpRuntimeConfig, b: CfwpRuntimeConfig): boolean {
  return (
    a.domain === b.domain &&
    a.token === b.token &&
    a.port === b.port &&
    a.cdnip === b.cdnip &&
    a.pyip === b.pyip &&
    a.dns === b.dns &&
    a.enableEch === b.enableEch &&
    a.cnrule === b.cnrule &&
    a.localScheme === b.localScheme
  );
}
