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

  // 代理：以「池/单条是否有内容」为准，避免 UI 总开关未勾选却把已填池清掉
  const poolProxies = parseProxyPool(settings.proxyPool);
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

  config.random_fingerprint =
    settings.randomFingerprint === undefined ? true : !!settings.randomFingerprint;
  config.auto_auth_export =
    settings.autoAuthExport === undefined ? true : !!settings.autoAuthExport;

  const authDir = String(settings.authDir || '').trim();
  if (authDir) {
    config.auth_dir = authDir;
    config.cpa_auth_dir = authDir;
  } else {
    // 让 Python 走 DATA_DIR/auth 或默认 /data/auth
    delete config.auth_dir;
    delete config.cpa_auth_dir;
  }

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
        `mail_domains=${nDom} prefer_local_forward=${!!config.proxy_prefer_local_forward}`
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
