import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AppSettings } from '@shared/settings';

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

/** 多行 / 逗号分隔 → 去重列表 */
function parseList(raw?: string): string[] {
  if (!raw || !String(raw).trim()) return [];
  const text = String(raw).replace(/\r\n/g, '\n').replace(/,/g, '\n');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const it = line.trim();
    if (!it || it.startsWith('#')) continue;
    if (seen.has(it)) continue;
    seen.add(it);
    out.push(it);
  }
  return out;
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

  config.mail_api_base = settings.mail?.apiBase || '';
  config.mail_admin_auth = settings.mail?.adminAuth || '';
  config.mail_domain = settings.mail?.domain || '';

  const domains = parseList(settings.mailDomains);
  if (domains.length > 0) {
    config.mail_domains = domains;
  } else {
    delete config.mail_domains;
  }
  config.mail_domain_mode = settings.mailDomainMode || 'round_robin';
  config.email_domain_mode = settings.mailDomainMode || 'round_robin';

  config.proxy = settings.proxy || '';
  const proxies = parseList(settings.proxyPool);
  if (proxies.length > 0) {
    config.proxy_pool = proxies;
  } else {
    delete config.proxy_pool;
  }
  config.proxy_mode = settings.proxyMode || 'round_robin';

  config.browser_proxy = settings.browserProxy || settings.proxy || '';
  config.browser_path = settings.browserPath || '';

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
