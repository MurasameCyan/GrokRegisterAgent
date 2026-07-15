import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppSettings } from '@shared/settings';
import { parseProxyPool, parseStringList, stripProxyComment } from '@shared/settings';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REGISTER_SCRIPT_NAMES = ['runner.py', 'DrissionPage_example.py'] as const;

type RuntimeSettings = Partial<AppSettings>;

export interface RegisterRuntime {
  registerDir: string;
  scriptPath: string;
  entrypoint: string;
  pythonPath: string;
}

function addCandidate(candidates: string[], value?: string) {
  const normalized = normalizeRegisterPath(value);
  if (!normalized) return;

  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  const exists = candidates.some((item) => {
    const itemKey = process.platform === 'win32' ? item.toLowerCase() : item;
    return itemKey === key;
  });
  if (!exists) candidates.push(normalized);
}

function normalizeRegisterPath(value?: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const resolved = path.resolve(trimmed);
  const basename = path.basename(resolved);
  if (REGISTER_SCRIPT_NAMES.includes(basename as (typeof REGISTER_SCRIPT_NAMES)[number])) {
    return path.dirname(resolved);
  }

  return resolved;
}

/** 多行 / 逗号分隔 → 去重列表（通用，不含代理 # 备注剥离） */
function parseList(raw?: string): string[] {
  return parseStringList(raw);
}

export function findRegisterScript(registerDir: string): string | null {
  for (const name of REGISTER_SCRIPT_NAMES) {
    const scriptPath = path.join(registerDir, name);
    if (fs.existsSync(scriptPath)) return scriptPath;
  }
  return null;
}

export function buildRegisterDirCandidates(configured?: string): string[] {
  const candidates: string[] = [];

  addCandidate(candidates, configured);
  addCandidate(candidates, process.env.REGISTER_DIR);

  // 内置注册机优先，旧的 grok-register 外部目录只作为本地兼容回退。
  addCandidate(candidates, '/app/register');
  addCandidate(candidates, path.resolve(process.cwd(), 'register'));
  addCandidate(candidates, path.resolve(__dirname, '..', '..', '..', 'register'));
  addCandidate(candidates, path.resolve(__dirname, '..', '..', '..', '..', 'register'));
  addCandidate(candidates, path.resolve(__dirname, '..', '..', '..', '..', '..', 'register'));
  addCandidate(candidates, path.resolve(process.cwd(), 'grok-register'));
  addCandidate(candidates, path.resolve(process.cwd(), '..', 'grok-register'));
  addCandidate(candidates, path.resolve(process.cwd(), '..', 'grok-register-main'));

  return candidates;
}

export function resolveRegisterRuntime(settings: RuntimeSettings = {}): RegisterRuntime | null {
  for (const registerDir of buildRegisterDirCandidates(settings.registerDir)) {
    const scriptPath = findRegisterScript(registerDir);
    if (!scriptPath) continue;

    return {
      registerDir,
      scriptPath,
      entrypoint: path.basename(scriptPath),
      pythonPath:
        settings.pythonPath ||
        process.env.PYTHON_PATH ||
        (process.platform === 'win32' ? 'python' : '/usr/local/bin/python3')
    };
  }

  return null;
}

export function writeConfigForPython(registerDir: string, settings: RuntimeSettings, count?: number) {
  const configPath = path.join(registerDir, 'config.json');
  let config: Record<string, any> = {};

  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {
    config = {};
  }

  // 规范化：去掉尾斜杠与误填的 /admin|/api 后缀（否则 POST 会 405）
  let mailBase = String(settings.mail?.apiBase || '').trim().replace(/\/+$/, '');
  for (const suffix of ['/admin/new_address', '/admin', '/api/mails', '/api']) {
    if (mailBase.toLowerCase().endsWith(suffix)) {
      mailBase = mailBase.slice(0, -suffix.length).replace(/\/+$/, '');
    }
  }
  config.mail_api_base = mailBase;
  config.mail_admin_auth = settings.mail?.adminAuth || '';
  config.mail_domain = String(settings.mail?.domain || '')
    .trim()
    .replace(/^@+/, '');

  // 邮箱提供方：cloudflare | duckmail | yyds
  const mailProvider = String(
    (settings as { mailProvider?: string }).mailProvider || 'cloudflare'
  )
    .trim()
    .toLowerCase();
  if (mailProvider === 'duckmail' || mailProvider === 'duck') {
    config.mail_provider = 'duckmail';
  } else if (mailProvider === 'yyds' || mailProvider === 'yydsmail') {
    config.mail_provider = 'yyds';
  } else {
    config.mail_provider = 'cloudflare';
  }

  // 域名池：仅 Cloudflare Temp Email 支持客户端多域名轮换。
  // DuckMail / YYDS 由服务端分配域名，无对等「本机域名池」接口 → 强制不写 mail_domains。
  const domainsText = String(settings.mailDomains || '').trim();
  const isCfMail = config.mail_provider === 'cloudflare';
  const mailPoolOn =
    isCfMail &&
    (settings.mailDomainPoolEnabled === true ||
      (settings.mailDomainPoolEnabled !== false && domainsText.length > 0));
  const domains = mailPoolOn ? parseList(settings.mailDomains) : [];
  if (domains.length > 0) {
    config.mail_domains = domains;
  } else {
    delete config.mail_domains;
  }
  config.mail_domain_mode = isCfMail
    ? settings.mailDomainMode || 'round_robin'
    : 'round_robin';
  config.email_domain_mode = config.mail_domain_mode;

  // 代理：注册优先 **仅可用池**；可用空时回退待定池（尚未测活时）
  const alivePool = parseProxyPool(
    (settings as { proxyPoolAlive?: string }).proxyPoolAlive || ''
  );
  const pendingPool = parseProxyPool(settings.proxyPool);
  const poolProxies: string[] =
    alivePool.length > 0
      ? alivePool
      : (() => {
          const seen = new Set<string>();
          const out: string[] = [];
          for (const p of pendingPool) {
            if (seen.has(p)) continue;
            seen.add(p);
            out.push(p);
          }
          return out;
        })();
  const singleProxy = stripProxyComment(settings.proxy || '');
  const browserOnly = stripProxyComment(settings.browserProxy || '');
  // 显式关闭才直连；未设置/true 或有代理内容 → 启用
  const explicitOff = settings.proxyEnabled === false && poolProxies.length === 0 && !singleProxy && !browserOnly;
  const wantPool =
    poolProxies.length > 0 &&
    settings.proxyPoolEnabled !== false; // 有池内容且未显式关池

  if (explicitOff) {
    config.proxy = '';
    config.browser_proxy = '';
    delete config.proxy_pool;
    config.proxy_mode = settings.proxyMode || 'round_robin';
  } else if (wantPool) {
    config.proxy = '';
    config.proxy_pool = poolProxies;
    config.proxy_mode = settings.proxyMode || 'round_robin';
    // 浏览器每轮 next_proxy，不写死单条
    config.browser_proxy = '';
  } else if (singleProxy || browserOnly) {
    config.proxy = singleProxy;
    config.browser_proxy = browserOnly || singleProxy;
    delete config.proxy_pool;
    config.proxy_mode = settings.proxyMode || 'round_robin';
  } else if (poolProxies.length > 0) {
    // 池开关关了但仍有内容：仍写入池，避免 265 条白填
    config.proxy = '';
    config.proxy_pool = poolProxies;
    config.proxy_mode = settings.proxyMode || 'round_robin';
    config.browser_proxy = '';
  } else {
    config.proxy = '';
    config.browser_proxy = '';
    delete config.proxy_pool;
    config.proxy_mode = settings.proxyMode || 'round_robin';
  }

  config.browser_path = settings.browserPath || '';
  // 带认证代理：默认优先本地转发（settings 默认 true）
  config.proxy_prefer_local_forward =
    settings.proxyPreferLocalForward === undefined
      ? true
      : settings.proxyPreferLocalForward === true;

  // 同一 IP 注册间隔（秒）；0=不限制
  const ipInterval = Number(settings.proxyIpIntervalSec);
  config.proxy_ip_interval_sec =
    Number.isFinite(ipInterval) && ipInterval > 0 ? Math.min(Math.floor(ipInterval), 86400) : 0;

  config.random_fingerprint =
    settings.randomFingerprint === undefined ? true : !!settings.randomFingerprint;
  config.auto_auth_export =
    settings.autoAuthExport === undefined ? true : !!settings.autoAuthExport;
  // 拿到 SSO 后随机延迟再 mint（秒），后台队列，不阻塞注册
  {
    let dMin = Number(
      (settings as { autoAuthDelayMinSec?: number }).autoAuthDelayMinSec ?? 60
    );
    let dMax = Number(
      (settings as { autoAuthDelayMaxSec?: number }).autoAuthDelayMaxSec ?? 120
    );
    if (!Number.isFinite(dMin)) dMin = 60;
    if (!Number.isFinite(dMax)) dMax = 120;
    dMin = Math.max(0, Math.min(Math.floor(dMin), 3600));
    dMax = Math.max(dMin, Math.min(Math.floor(dMax), 7200));
    config.auto_auth_delay_min_sec = dMin;
    config.auto_auth_delay_max_sec = dMax;
  }
  // 授权队列并发 / 背压（P0）
  {
    const authWorkers = Number(
      (settings as { authExportWorkers?: number }).authExportWorkers ?? 2
    );
    if (Number.isFinite(authWorkers) && authWorkers >= 1) {
      config.auth_export_workers = Math.max(1, Math.min(8, Math.floor(authWorkers)));
    }
    const authQMax = Number(
      (settings as { authExportQueueMax?: number }).authExportQueueMax ?? 0
    );
    if (Number.isFinite(authQMax) && authQMax > 0) {
      config.auth_export_queue_max = Math.max(1, Math.min(64, Math.floor(authQMax)));
    }
  }
  // CF 邮箱鉴权模式
  {
    const cfMode = String(
      (settings as { cloudflareAuthMode?: string }).cloudflareAuthMode ||
        (settings as { mailAuthMode?: string }).mailAuthMode ||
        ''
    )
      .trim()
      .toLowerCase();
    if (cfMode) {
      config.cloudflare_auth_mode = cfMode;
    }
  }
  // P3 可选
  if ((settings as { enableNsfw?: boolean }).enableNsfw === true) {
    config.enable_nsfw = true;
  } else {
    config.enable_nsfw = false;
  }
  if ((settings as { sub2apiExportEnabled?: boolean }).sub2apiExportEnabled === true) {
    config.sub2api_export_enabled = true;
  } else {
    config.sub2api_export_enabled = false;
  }
  {
    const re = Number(
      (settings as { browserRecycleEvery?: number }).browserRecycleEvery ?? 5
    );
    if (Number.isFinite(re) && re >= 0) {
      config.browser_recycle_every = Math.max(0, Math.min(100, Math.floor(re)));
    }
    const mr = Number((settings as { maxMailRetry?: number }).maxMailRetry ?? 3);
    if (Number.isFinite(mr) && mr >= 1) {
      config.max_mail_retry = Math.max(1, Math.min(10, Math.floor(mr)));
    }
  }

  // 固定 DATA_DIR/auth，不再使用自定义 authDir
  delete config.auth_dir;
  delete config.cpa_auth_dir;

  // Auth → CPA 远程推送（pushAuthToCpa / 兼容 cpaRemotePushEnabled）
  const cpaPushOn =
    settings.pushAuthToCpa === true ||
    settings.cpaRemotePushEnabled === true ||
    settings.autoPushAuthToCpa === true;
  const cpaRemoteUrl = cpaPushOn ? String(settings.cpaRemoteUrl || '').trim() : '';
  const cpaManagementKey = cpaPushOn
    ? String(settings.cpaManagementKey || '').trim()
    : '';
  if (cpaRemoteUrl) {
    config.cpa_remote_url = cpaRemoteUrl;
  } else {
    delete config.cpa_remote_url;
  }
  if (cpaManagementKey) {
    config.cpa_management_key = cpaManagementKey;
  } else {
    delete config.cpa_management_key;
  }
  // push_auth_to_cpa 由下方 autoPushAuthToCpa 统一写入
  // 与 grokRegister-cpa-main 的 cpa_auto_add 对齐：开自动导出即视为可入库
  config.cpa_auto_add =
    settings.autoAuthExport === undefined ? true : !!settings.autoAuthExport;

  // 注册方案 Plan A/B/C：可单独开关；全开则 A→B→C 顺序兜底
  const planA =
    (settings as { registerPlanAEnabled?: boolean }).registerPlanAEnabled !== false;
  const planB = settings.registerPlanBEnabled !== false;
  const planC =
    (settings as { registerPlanCEnabled?: boolean }).registerPlanCEnabled === true ||
    String((settings as { registerMode?: string }).registerMode || '')
      .trim()
      .toLowerCase() === 'hybrid';
  config.register_plan_a_enabled = planA;
  config.register_plan_b_enabled = planB;
  config.register_plan_c_enabled = planC;
  // 兼容旧字段：register_mode=hybrid 当 C 开
  config.register_mode = planC ? 'hybrid' : 'browser';

  // SSO→CPA mint：pkce | device | double（双通道两份 auth）
  const mintMode = String(
    (settings as { cpaMintMode?: string }).cpaMintMode || 'pkce'
  )
    .trim()
    .toLowerCase();
  if (mintMode === 'device' || mintMode === 'device_flow' || mintMode === 'b') {
    config.cpa_mint_mode = 'device';
  } else if (
    mintMode === 'double' ||
    mintMode === 'auto' ||
    mintMode === 'c' ||
    mintMode === 'merged' ||
    mintMode === 'both' ||
    mintMode === 'pkce_then_device'
  ) {
    config.cpa_mint_mode = 'double';
  } else {
    config.cpa_mint_mode = 'pkce';
  }

  // 推送：允许(push*) 与 自动(autoPush*) 分离；注册成功只跟自动走
  const allowSsoG2 = settings.pushSsoToGrok2api === true;
  const autoSsoG2 =
    settings.autoPushSsoToGrok2api === true ||
    (settings.autoPushSsoToGrok2api === undefined && allowSsoG2);
  const allowAuthG2 = settings.pushAuthToGrok2api === true;
  const autoAuthG2 =
    settings.autoPushAuthToGrok2api === true ||
    (settings.autoPushAuthToGrok2api === undefined && allowAuthG2);
  const allowAuthCpa =
    settings.pushAuthToCpa === true || settings.cpaRemotePushEnabled === true;
  const autoAuthCpa =
    settings.autoPushAuthToCpa === true ||
    (settings.autoPushAuthToCpa === undefined && allowAuthCpa);
  // Python 侧 push_* = 自动推送（注册成功触发）；允许仅影响 UI 手动推
  config.push_sso_to_grok2api = autoSsoG2;
  config.push_auth_to_grok2api = autoAuthG2;
  config.push_auth_to_cpa = autoAuthCpa;
  config.allow_push_sso_to_grok2api = allowSsoG2;
  config.allow_push_auth_to_grok2api = allowAuthG2;
  config.allow_push_auth_to_cpa = allowAuthCpa;
  config.grok2api_auto_upload = autoSsoG2 || autoAuthG2;
  const g2url = String(settings.grok2apiUrl || '').trim();
  const g2user = String(settings.grok2apiUsername || '').trim();
  const g2pass = String(settings.grok2apiPassword || '');
  if (g2url) config.grok2api_url = g2url;
  else delete config.grok2api_url;
  if (g2user) config.grok2api_username = g2user;
  else delete config.grok2api_username;
  if (g2pass) config.grok2api_password = g2pass;
  else delete config.grok2api_password;
  // 固定 web_convert；清理历史可选模式 / 引擎字段
  config.grok2api_upload_mode = 'web_convert';
  delete config.register_engine;
  delete config.grok2apiUploadMode;

  if (typeof count === 'number') {
    config.run = { ...(config.run || {}), count };
  }

  // 启动前日志：代理/域名是否写入 Python config（便于对照注册日志）
  try {
    const nPool = Array.isArray(config.proxy_pool) ? config.proxy_pool.length : 0;
    const nDom = Array.isArray(config.mail_domains) ? config.mail_domains.length : 0;
    console.log(
      `[writeConfig] proxy_pool=${nPool} proxy=${config.proxy ? 'set' : 'empty'} ` +
        `browser_proxy=${config.browser_proxy ? 'set' : 'empty'} ` +
        `mail_domains=${nDom} mail_provider=${config.mail_provider || 'cloudflare'} ` +
        `planA=${config.register_plan_a_enabled !== false} ` +
        `planB=${config.register_plan_b_enabled !== false} ` +
        `planC=${!!config.register_plan_c_enabled} ` +
        `cpa_mint_mode=${config.cpa_mint_mode || 'pkce'} ` +
        `prefer_local_forward=${!!config.proxy_prefer_local_forward} ` +
        `ip_interval=${config.proxy_ip_interval_sec || 0}s ` +
        `cpa_remote=${config.cpa_remote_url ? 'set' : 'off'}`
    );
  } catch {
    /* ignore */
  }

  // 人机验证自动通过等待上限（秒）；Python 在 [30, max] 内随机
  const autoMax = Number(settings.turnstileAutoWaitMax);
  if (Number.isFinite(autoMax) && autoMax >= 30) {
    config.turnstile = {
      ...(config.turnstile || {}),
      auto_wait_max: Math.min(180, Math.floor(autoMax))
    };
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
