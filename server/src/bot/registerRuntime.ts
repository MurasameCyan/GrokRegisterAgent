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

  // 域名池开关：开=写入 mail_domains；关=只用 mail_domain
  // 兼容：若未显式开池但 mailDomains 有内容，仍写入池（避免 UI 开了却未持久化开关）
  const domainsText = String(settings.mailDomains || '').trim();
  const mailPoolOn =
    settings.mailDomainPoolEnabled === true ||
    (settings.mailDomainPoolEnabled !== false && domainsText.length > 0);
  const domains = mailPoolOn ? parseList(settings.mailDomains) : [];
  if (domains.length > 0) {
    config.mail_domains = domains;
  } else {
    delete config.mail_domains;
  }
  config.mail_domain_mode = settings.mailDomainMode || 'round_robin';
  config.email_domain_mode = settings.mailDomainMode || 'round_robin';

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

  // Plan A 失败后 Plan B 兜底一次（默认开）
  config.register_plan_b_enabled = settings.registerPlanBEnabled !== false;

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
        `mail_domains=${nDom} prefer_local_forward=${!!config.proxy_prefer_local_forward} ` +
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
