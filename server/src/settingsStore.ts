/**
 * 服务端版本的设置存储。
 * 没有 Electron safeStorage，落盘到 DATA_DIR/config.json。
 * Linux 用户应该把 DATA_DIR 挂成 docker volume 以保留配置。
 */
import { promises as fsp, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type AppSettings,
  type CpaMintMode,
  type MailProvider,
  type PoolMode,
  type RegisterMode,
  DEFAULT_SETTINGS,
  enforceProxyModeMutex
} from '@shared/settings';

const DATA_DIR = resolve(process.env.DATA_DIR || '/data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

let cache: AppSettings | null = null;

function asPoolMode(v: unknown, fallback: PoolMode): PoolMode {
  return v === 'random' || v === 'round_robin' ? v : fallback;
}

function asMailProvider(v: unknown, fallback: MailProvider): MailProvider {
  const s = String(v || '')
    .trim()
    .toLowerCase();
  if (s === 'duckmail' || s === 'duck') return 'duckmail';
  if (s === 'yyds' || s === 'yydsmail') return 'yyds';
  if (
    s === 'cloudflare' ||
    s === 'cf' ||
    s === 'vmail' ||
    s === 'temp_email' ||
    s === 'cloudflare_temp_email'
  ) {
    return 'cloudflare';
  }
  return fallback;
}

function asRegisterMode(v: unknown, fallback: RegisterMode): RegisterMode {
  return v === 'hybrid' ? 'hybrid' : v === 'browser' ? 'browser' : fallback;
}

function asCpaMintMode(v: unknown, fallback: CpaMintMode): CpaMintMode {
  const s = String(v || '')
    .trim()
    .toLowerCase();
  if (s === 'device' || s === 'device_flow' || s === 'b') return 'device';
  // double：双通道；兼容旧 auto / c / merged
  if (
    s === 'double' ||
    s === 'auto' ||
    s === 'c' ||
    s === 'merged' ||
    s === 'pkce_then_device' ||
    s === 'both'
  ) {
    return 'double';
  }
  if (s === 'pkce' || s === 'a' || s === 'auth_code') return 'pkce';
  return fallback;
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
    (envRunCount as number) <= 721;

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
    cpaRemoteUrl: pick(s.cpaRemoteUrl, env.CPA_REMOTE_URL),
    cpaManagementKey: pick(s.cpaManagementKey, env.CPA_MANAGEMENT_KEY),
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
  const proxyPoolAlive =
    typeof (p as AppSettings).proxyPoolAlive === 'string'
      ? (p as AppSettings).proxyPoolAlive
      : DEFAULT_SETTINGS.proxyPoolAlive;
  const proxy = typeof p.proxy === 'string' ? p.proxy : DEFAULT_SETTINGS.proxy;
  const browserProxy =
    typeof p.browserProxy === 'string' ? p.browserProxy : DEFAULT_SETTINGS.browserProxy;

  // 旧配置无开关字段：按是否已有内容推断，避免升级后行为突变
  const inferProxyOn = !!(
    String(proxy || '').trim() ||
    String(proxyPool || '').trim() ||
    String(proxyPoolAlive || '').trim() ||
    String(browserProxy || '').trim()
  );
  const inferProxyPoolOn = !!(
    String(proxyPool || '').trim() || String(proxyPoolAlive || '').trim()
  );
  const inferMailPoolOn = !!String(mailDomains || '').trim();

  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...p,
    mail: { ...DEFAULT_SETTINGS.mail, ...(p.mail ?? {}) },
    mailProvider: asMailProvider(
      (p as AppSettings).mailProvider,
      DEFAULT_SETTINGS.mailProvider
    ),
    mailDomains,
    // 域名池仅 Cloudflare；其他提供方强制关
    mailDomainPoolEnabled: (() => {
      const provider = asMailProvider(
        (p as AppSettings).mailProvider,
        DEFAULT_SETTINGS.mailProvider
      );
      if (provider !== 'cloudflare') return false;
      return asBool(p.mailDomainPoolEnabled, inferMailPoolOn);
    })(),
    mailDomainMode: asPoolMode(p.mailDomainMode, DEFAULT_SETTINGS.mailDomainMode),
    proxyEnabled: asBool(p.proxyEnabled, inferProxyOn),
    proxy,
    proxyPool,
    proxyPoolAlive,
    proxyPoolEnabled: asBool(p.proxyPoolEnabled, inferProxyPoolOn),
    proxyMode: asPoolMode(p.proxyMode, DEFAULT_SETTINGS.proxyMode),
    // CF 独立代理（与普通代理/池互斥，见下方 enforce）
    cfProxyEnabled: asBool(
      (p as AppSettings).cfProxyEnabled,
      DEFAULT_SETTINGS.cfProxyEnabled
    ),
    cfProxyDomain:
      typeof (p as AppSettings).cfProxyDomain === 'string'
        ? (p as AppSettings).cfProxyDomain
        : DEFAULT_SETTINGS.cfProxyDomain,
    cfProxyToken:
      typeof (p as AppSettings).cfProxyToken === 'string'
        ? (p as AppSettings).cfProxyToken
        : DEFAULT_SETTINGS.cfProxyToken,
    cfProxyPort: (() => {
      const n = Number((p as AppSettings).cfProxyPort);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
      return DEFAULT_SETTINGS.cfProxyPort;
    })(),
    cfProxyCdnip:
      typeof (p as AppSettings).cfProxyCdnip === 'string' &&
      String((p as AppSettings).cfProxyCdnip).trim()
        ? (p as AppSettings).cfProxyCdnip
        : DEFAULT_SETTINGS.cfProxyCdnip,
    cfProxyPyip:
      typeof (p as AppSettings).cfProxyPyip === 'string'
        ? (p as AppSettings).cfProxyPyip
        : DEFAULT_SETTINGS.cfProxyPyip,
    cfProxyDns:
      typeof (p as AppSettings).cfProxyDns === 'string' &&
      String((p as AppSettings).cfProxyDns).trim()
        ? (p as AppSettings).cfProxyDns
        : DEFAULT_SETTINGS.cfProxyDns,
    cfProxyEnableEch: asBool(
      (p as AppSettings).cfProxyEnableEch,
      DEFAULT_SETTINGS.cfProxyEnableEch
    ),
    cfProxyCnrule: asBool(
      (p as AppSettings).cfProxyCnrule,
      DEFAULT_SETTINGS.cfProxyCnrule
    ),
    cfProxyLocalScheme: (() => {
      const v = String((p as AppSettings).cfProxyLocalScheme || '')
        .trim()
        .toLowerCase();
      return v === 'http' ? 'http' : 'socks5';
    })(),
    singBoxEnabled: asBool(
      (p as AppSettings).singBoxEnabled,
      DEFAULT_SETTINGS.singBoxEnabled
    ),
    singBoxNodes:
      typeof (p as AppSettings).singBoxNodes === 'string'
        ? (p as AppSettings).singBoxNodes
        : DEFAULT_SETTINGS.singBoxNodes,
    singBoxSelected: (() => {
      const v =
        typeof (p as AppSettings).singBoxSelected === 'string'
          ? String((p as AppSettings).singBoxSelected).trim()
          : '';
      return v || DEFAULT_SETTINGS.singBoxSelected || '__random__';
    })(),
    // 固定 2080，忽略历史自定义端口
    singBoxPort: 2080,
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
    autoAuthDelayMinSec: (() => {
      const n = Number((p as AppSettings).autoAuthDelayMinSec);
      if (!Number.isFinite(n)) return DEFAULT_SETTINGS.autoAuthDelayMinSec;
      return Math.max(0, Math.min(Math.floor(n), 3600));
    })(),
    autoAuthDelayMaxSec: (() => {
      const n = Number((p as AppSettings).autoAuthDelayMaxSec);
      if (!Number.isFinite(n)) return DEFAULT_SETTINGS.autoAuthDelayMaxSec;
      return Math.max(0, Math.min(Math.floor(n), 7200));
    })(),
    authDir: typeof p.authDir === 'string' ? p.authDir : DEFAULT_SETTINGS.authDir,
    // CPA 远程推送：新字段 pushAuthToCpa；兼容 cpaRemotePushEnabled / 旧 URL
    cpaRemotePushEnabled:
      (p as AppSettings).pushAuthToCpa === true ||
      (p as AppSettings).cpaRemotePushEnabled === true ||
      ((p as AppSettings).pushAuthToCpa !== false &&
        (p as AppSettings).cpaRemotePushEnabled !== false &&
        Boolean(String((p as AppSettings).cpaRemoteUrl || '').trim()) &&
        (p as AppSettings).pushAuthToCpa === undefined &&
        (p as AppSettings).cpaRemotePushEnabled === undefined),
    pushAuthToCpa:
      (p as AppSettings).pushAuthToCpa === true ||
      (p as AppSettings).cpaRemotePushEnabled === true ||
      ((p as AppSettings).pushAuthToCpa !== false &&
        (p as AppSettings).cpaRemotePushEnabled !== false &&
        Boolean(String((p as AppSettings).cpaRemoteUrl || '').trim()) &&
        (p as AppSettings).pushAuthToCpa === undefined &&
        (p as AppSettings).cpaRemotePushEnabled === undefined),
    // SSO→g2 唯一通道；旧 grok2apiAutoUpload 仅在 pushSso 未写入时迁移为 SSO
    pushSsoToGrok2api: (() => {
      const s = p as AppSettings;
      if (s.pushSsoToGrok2api === true) return true;
      if (s.pushSsoToGrok2api === false) return false;
      if (s.grok2apiAutoUpload === true) return true;
      return false;
    })(),
    autoPushSsoToGrok2api:
      (p as AppSettings).autoPushSsoToGrok2api === true ||
      // 旧配置：仅开了 pushSso 时视为同时允许+自动
      ((p as AppSettings).autoPushSsoToGrok2api === undefined &&
        (p as AppSettings).pushSsoToGrok2api === true),
    autoPushAuthToCpa:
      (p as AppSettings).autoPushAuthToCpa === true ||
      ((p as AppSettings).autoPushAuthToCpa === undefined &&
        ((p as AppSettings).pushAuthToCpa === true ||
          (p as AppSettings).cpaRemotePushEnabled === true)),
    pushAuthToSub2api: (p as AppSettings).pushAuthToSub2api === true,
    autoPushAuthToSub2api:
      (p as AppSettings).autoPushAuthToSub2api === true ||
      ((p as AppSettings).autoPushAuthToSub2api === undefined &&
        (p as AppSettings).pushAuthToSub2api === true),
    sub2apiRemoteUrl:
      typeof (p as AppSettings).sub2apiRemoteUrl === 'string'
        ? (p as AppSettings).sub2apiRemoteUrl
        : DEFAULT_SETTINGS.sub2apiRemoteUrl,
    sub2apiAdminToken:
      typeof (p as AppSettings).sub2apiAdminToken === 'string'
        ? (p as AppSettings).sub2apiAdminToken
        : DEFAULT_SETTINGS.sub2apiAdminToken,
    cpaRemoteUrl:
      typeof (p as AppSettings).cpaRemoteUrl === 'string'
        ? (p as AppSettings).cpaRemoteUrl
        : DEFAULT_SETTINGS.cpaRemoteUrl,
    cpaManagementKey:
      typeof (p as AppSettings).cpaManagementKey === 'string'
        ? (p as AppSettings).cpaManagementKey
        : DEFAULT_SETTINGS.cpaManagementKey,
    cpaProbeDeleteOnDead: asBool(
      (p as AppSettings).cpaProbeDeleteOnDead,
      DEFAULT_SETTINGS.cpaProbeDeleteOnDead
    ),
    cpaProbeDeleteSsoOnDead: asBool(
      (p as AppSettings).cpaProbeDeleteSsoOnDead,
      DEFAULT_SETTINGS.cpaProbeDeleteSsoOnDead
    ),
    autoResignOn401: asBool(
      (p as AppSettings).autoResignOn401,
      DEFAULT_SETTINGS.autoResignOn401
    ),
    cpaResignConcurrency: (() => {
      const n = Number((p as AppSettings).cpaResignConcurrency);
      if (!Number.isFinite(n) || n < 1) return DEFAULT_SETTINGS.cpaResignConcurrency;
      return Math.min(Math.floor(n), 3);
    })(),
    resignPushRemote: asBool(
      (p as AppSettings).resignPushRemote,
      DEFAULT_SETTINGS.resignPushRemote
    ),
    proxyIpIntervalSec: (() => {
      const n = Number((p as AppSettings).proxyIpIntervalSec);
      if (!Number.isFinite(n) || n < 0) return DEFAULT_SETTINGS.proxyIpIntervalSec;
      return Math.min(Math.floor(n), 86400);
    })(),
    maxParallelWorkers: 3, // 固定并行上限，不允许配置修改
    runCount: (() => {
      const n = Number((p as AppSettings).runCount);
      if (!Number.isFinite(n) || n < 1) return DEFAULT_SETTINGS.runCount;
      return Math.min(Math.floor(n), 721);
    })(),
    skipBotFlag1OnMint: asBool(
      (p as AppSettings).skipBotFlag1OnMint,
      DEFAULT_SETTINGS.skipBotFlag1OnMint
    ),
    ssoCheckUseProxy: asBool(
      (p as AppSettings).ssoCheckUseProxy,
      DEFAULT_SETTINGS.ssoCheckUseProxy
    ),
    autoSsoCheckOnRegister: asBool(
      (p as AppSettings).autoSsoCheckOnRegister,
      DEFAULT_SETTINGS.autoSsoCheckOnRegister
    ),
    turnstileSolverEnabled: asBool(
      (p as AppSettings).turnstileSolverEnabled,
      DEFAULT_SETTINGS.turnstileSolverEnabled
    ),
    turnstileSolverUrl:
      typeof (p as AppSettings).turnstileSolverUrl === 'string' &&
      String((p as AppSettings).turnstileSolverUrl || '').trim()
        ? String((p as AppSettings).turnstileSolverUrl).trim()
        : DEFAULT_SETTINGS.turnstileSolverUrl,
    yescaptchaKey:
      typeof (p as AppSettings).yescaptchaKey === 'string'
        ? (p as AppSettings).yescaptchaKey
        : DEFAULT_SETTINGS.yescaptchaKey,
    cpaAuthUseProxy: asBool(
      (p as AppSettings).cpaAuthUseProxy,
      DEFAULT_SETTINGS.cpaAuthUseProxy
    ),
    proxyFetchUrl:
      typeof (p as AppSettings).proxyFetchUrl === 'string'
        ? (p as AppSettings).proxyFetchUrl
        : DEFAULT_SETTINGS.proxyFetchUrl,
    registerPlanAEnabled: asBool(
      (p as AppSettings).registerPlanAEnabled,
      DEFAULT_SETTINGS.registerPlanAEnabled
    ),
    registerPlanBEnabled: asBool(
      (p as AppSettings).registerPlanBEnabled,
      DEFAULT_SETTINGS.registerPlanBEnabled
    ),
    // Plan C：新字段优先；旧 registerMode=hybrid 视为开启
    registerPlanCEnabled: (() => {
      const pAny = p as AppSettings;
      if (typeof pAny.registerPlanCEnabled === 'boolean') {
        return pAny.registerPlanCEnabled;
      }
      const mode = asRegisterMode(pAny.registerMode, DEFAULT_SETTINGS.registerMode);
      return mode === 'hybrid' ? true : DEFAULT_SETTINGS.registerPlanCEnabled;
    })(),
    registerMode: asRegisterMode(
      (p as AppSettings).registerMode,
      // 若仅写了 plan C 开关，同步兼容字段
      (p as AppSettings).registerPlanCEnabled === true
        ? 'hybrid'
        : DEFAULT_SETTINGS.registerMode
    ),
    // 兼容旧字段：仅反映 SSO→g2
    grok2apiAutoUpload:
      (p as AppSettings).pushSsoToGrok2api === true ||
      (p as AppSettings).autoPushSsoToGrok2api === true ||
      (p as AppSettings).grok2apiAutoUpload === true,
    grok2apiUrl:
      typeof (p as AppSettings).grok2apiUrl === 'string'
        ? (p as AppSettings).grok2apiUrl
        : DEFAULT_SETTINGS.grok2apiUrl,
    grok2apiUsername:
      typeof (p as AppSettings).grok2apiUsername === 'string'
        ? (p as AppSettings).grok2apiUsername
        : DEFAULT_SETTINGS.grok2apiUsername,
    grok2apiPassword:
      typeof (p as AppSettings).grok2apiPassword === 'string'
        ? (p as AppSettings).grok2apiPassword
        : DEFAULT_SETTINGS.grok2apiPassword
    // grok2api 上传固定 web_convert（字段已删除；Python config 仍写死，见 registerRuntime）
  };
  // 旧配置无此字段时回落到默认 60
  if (
    !Number.isInteger(merged.turnstileAutoWaitMax) ||
    merged.turnstileAutoWaitMax < 30 ||
    merged.turnstileAutoWaitMax > 180
  ) {
    merged.turnstileAutoWaitMax = DEFAULT_SETTINGS.turnstileAutoWaitMax;
  }
  // CF 与普通代理/池二选一
  const withMutex = enforceProxyModeMutex(merged);
  return applyEnvOverrides(withMutex, p);
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
