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

  config.proxy = settings.proxy || '';
  config.browser_proxy = settings.browserProxy || settings.proxy || '';
  config.browser_path = settings.browserPath || '';

  if (typeof count === 'number') {
    config.run = { ...(config.run || {}), count };
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
