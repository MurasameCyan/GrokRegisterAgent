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
  const mailPoolOn = settings.mailDomainPoolEnabled === true;
  const domains = mailPoolOn ? parseList(settings.mailDomains) : [];
  if (domains.length > 0) {
    config.mail_domains = domains;
  } else {
    delete config.mail_domains;
  }
  config.mail_domain_mode = settings.mailDomainMode || 'round_robin';
  config.email_domain_mode = settings.mailDomainMode || 'round_robin';

  // 代理总开关 / 池开关
  const proxyOn = settings.proxyEnabled === true;
  const proxyPoolOn = proxyOn && settings.proxyPoolEnabled === true;
  if (!proxyOn) {
    config.proxy = '';
    config.browser_proxy = '';
    delete config.proxy_pool;
    config.proxy_mode = settings.proxyMode || 'round_robin';
  } else if (proxyPoolOn) {
    // 池模式：剥离 #备注 后写入；单代理字段清空避免干扰
    const proxies = parseProxyPool(settings.proxyPool);
    config.proxy = '';
    if (proxies.length > 0) {
      config.proxy_pool = proxies;
    } else {
      delete config.proxy_pool;
    }
    config.proxy_mode = settings.proxyMode || 'round_robin';
    // 浏览器跟随池轮换（Python 侧 next_proxy）；此处不写死单条
    config.browser_proxy = '';
  } else {
    // 单代理
    const single = stripProxyComment(settings.proxy || '');
    const browser = stripProxyComment(settings.browserProxy || '') || single;
    config.proxy = single;
    config.browser_proxy = browser;
    delete config.proxy_pool;
    config.proxy_mode = settings.proxyMode || 'round_robin';
  }

  config.browser_path = settings.browserPath || '';
  // 带认证代理：优先本地转发（可选）
  config.proxy_prefer_local_forward = settings.proxyPreferLocalForward === true;

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
