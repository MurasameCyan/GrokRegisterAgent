/**
 * 服务端版本的设置存储。
 * 没有 Electron safeStorage，落盘到 DATA_DIR/config.json。
 * Linux 用户应该把 DATA_DIR 挂成 docker volume 以保留配置。
 */
import { promises as fsp, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type AppSettings, type PoolMode, DEFAULT_SETTINGS } from '@shared/settings';

const DATA_DIR = resolve(process.env.DATA_DIR || '/data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

let cache: AppSettings | null = null;

function asPoolMode(v: unknown, fallback: PoolMode): PoolMode {
  return v === 'random' || v === 'round_robin' ? v : fallback;
}

function applyEnvOverrides(s: AppSettings, source: Partial<AppSettings>): AppSettings {
  // Docker 友好：环境变量仅作「空字段 bootstrap」，不得覆盖 UI/config 已保存的值。
  // 旧逻辑 env || saved 会导致：compose 里设了 MAIL_API_BASE 后，设置页保存再读回仍被 env 盖掉。
  const env = process.env;
  const envRunCount = env.RUN_COUNT ? Number(env.RUN_COUNT) : undefined;
  const useEnvRunCount =
    source.runCount === undefined &&
    Number.isInteger(envRunCount) &&
    (envRunCount as number) >= 1 &&
    (envRunCount as number) <= 50;

  const pick = (saved: string, envVal?: string, fallback = ''): string => {
    const v = (saved || '').trim();
    if (v) return saved;
    const e = (envVal || '').trim();
    if (e) return envVal as string;
    return fallback;
  };

  return {
    ...s,
    pythonPath: pick(
      s.pythonPath,
      env.PYTHON_PATH,
      process.platform === 'win32' ? 'python' : '/usr/local/bin/python3'
    ),
    registerDir: pick(s.registerDir, env.REGISTER_DIR, ''),
    runCount: useEnvRunCount ? (envRunCount as number) : s.runCount,
    proxy: pick(s.proxy, env.HTTP_PROXY),
    browserProxy: pick(s.browserProxy, env.BROWSER_PROXY),
    browserPath: pick(s.browserPath, env.BROWSER_PATH),
    authDir: pick(s.authDir, env.AUTH_DIR || env.CPA_AUTH_DIR),
    mail: {
      ...s.mail,
      apiBase: pick(s.mail.apiBase, env.MAIL_API_BASE),
      adminAuth: pick(s.mail.adminAuth, env.MAIL_ADMIN_AUTH),
      domain: pick(s.mail.domain, env.MAIL_DOMAIN)
    }
  };
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function merge(partial: unknown): AppSettings {
  const p = (partial ?? {}) as Partial<AppSettings> & Record<string, unknown>;
  const mailDomains =
    typeof p.mailDomains === 'string' ? p.mailDomains : DEFAULT_SETTINGS.mailDomains;
  const proxyPool = typeof p.proxyPool === 'string' ? p.proxyPool : DEFAULT_SETTINGS.proxyPool;
  const proxy = typeof p.proxy === 'string' ? p.proxy : DEFAULT_SETTINGS.proxy;
  const browserProxy =
    typeof p.browserProxy === 'string' ? p.browserProxy : DEFAULT_SETTINGS.browserProxy;

  // 旧配置无开关字段：按是否已有内容推断，避免升级后行为突变
  const inferProxyOn = !!(
    String(proxy || '').trim() ||
    String(proxyPool || '').trim() ||
    String(browserProxy || '').trim()
  );
  const inferProxyPoolOn = !!String(proxyPool || '').trim();
  const inferMailPoolOn = !!String(mailDomains || '').trim();

  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...p,
    mail: { ...DEFAULT_SETTINGS.mail, ...(p.mail ?? {}) },
    mailDomains,
    mailDomainPoolEnabled: asBool(p.mailDomainPoolEnabled, inferMailPoolOn),
    mailDomainMode: asPoolMode(p.mailDomainMode, DEFAULT_SETTINGS.mailDomainMode),
    proxyEnabled: asBool(p.proxyEnabled, inferProxyOn),
    proxy,
    proxyPool,
    proxyPoolEnabled: asBool(p.proxyPoolEnabled, inferProxyPoolOn),
    proxyMode: asPoolMode(p.proxyMode, DEFAULT_SETTINGS.proxyMode),
    proxyProbeConcurrency: (() => {
      const n = Number((p as AppSettings).proxyProbeConcurrency);
      if (Number.isInteger(n) && n >= 1 && n <= 20) return n;
      return DEFAULT_SETTINGS.proxyProbeConcurrency;
    })(),
    proxyAutoSaveOnRemoveFailed: asBool(
      (p as AppSettings).proxyAutoSaveOnRemoveFailed,
      DEFAULT_SETTINGS.proxyAutoSaveOnRemoveFailed
    ),
    proxyPreferLocalForward: asBool(
      (p as AppSettings).proxyPreferLocalForward,
      DEFAULT_SETTINGS.proxyPreferLocalForward
    ),
    browserProxy,
    randomFingerprint:
      typeof p.randomFingerprint === 'boolean'
        ? p.randomFingerprint
        : DEFAULT_SETTINGS.randomFingerprint,
    autoAuthExport:
      typeof p.autoAuthExport === 'boolean' ? p.autoAuthExport : DEFAULT_SETTINGS.autoAuthExport,
    authDir: typeof p.authDir === 'string' ? p.authDir : DEFAULT_SETTINGS.authDir
  };
  // 旧配置无此字段时回落到默认 60
  if (
    !Number.isInteger(merged.turnstileAutoWaitMax) ||
    merged.turnstileAutoWaitMax < 30 ||
    merged.turnstileAutoWaitMax > 180
  ) {
    merged.turnstileAutoWaitMax = DEFAULT_SETTINGS.turnstileAutoWaitMax;
  }
  return applyEnvOverrides(merged, p);
}

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await fsp.readFile(CONFIG_PATH, 'utf-8');
      cache = merge(JSON.parse(raw));
      return cache;
    } catch (err) {
      console.error('[settingsStore] read failed, using defaults', err);
    }
  }
  cache = merge({});
  return cache;
}

export async function saveSettings(next: AppSettings): Promise<void> {
  cache = merge(next);
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf-8');
  await fsp.rename(tmp, CONFIG_PATH);
}

export function dataDir(): string {
  return DATA_DIR;
}

export function isEncryptionAvailable(): boolean {
  // 服务端永远是明文（落到挂载卷里），UI 上据此提示 Linux 用户
  return false;
}
