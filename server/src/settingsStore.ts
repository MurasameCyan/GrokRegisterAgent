/**
 * 服务端版本的设置存储。
 * 没有 Electron safeStorage，落盘到 DATA_DIR/config.json。
 * Linux 用户应该把 DATA_DIR 挂成 docker volume 以保留配置。
 */
import { promises as fsp, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type AppSettings, DEFAULT_SETTINGS } from '@shared/settings';

const DATA_DIR = resolve(process.env.DATA_DIR || '/data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

let cache: AppSettings | null = null;

function applyEnvOverrides(s: AppSettings, source: Partial<AppSettings>): AppSettings {
  // Docker 友好：允许通过环境变量覆盖关键字段（首次启动空白容器时也能直接跑）
  const env = process.env;
  const envRunCount = env.RUN_COUNT ? Number(env.RUN_COUNT) : undefined;
  const useEnvRunCount =
    source.runCount === undefined &&
    Number.isInteger(envRunCount) &&
    (envRunCount as number) >= 1 &&
    (envRunCount as number) <= 50;

  return {
    ...s,
    pythonPath: env.PYTHON_PATH || s.pythonPath || (process.platform === 'win32' ? 'python' : '/usr/local/bin/python3'),
    registerDir: env.REGISTER_DIR || s.registerDir || '',
    runCount: useEnvRunCount ? (envRunCount as number) : s.runCount,
    proxy: env.HTTP_PROXY || s.proxy,
    browserProxy: env.BROWSER_PROXY || s.browserProxy,
    browserPath: env.BROWSER_PATH || s.browserPath,
    mail: {
      ...s.mail,
      apiBase: env.MAIL_API_BASE || s.mail.apiBase,
      adminAuth: env.MAIL_ADMIN_AUTH || s.mail.adminAuth,
      domain: env.MAIL_DOMAIN || s.mail.domain
    }
  };
}

function merge(partial: unknown): AppSettings {
  const p = (partial ?? {}) as Partial<AppSettings>;
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...p,
    mail: { ...DEFAULT_SETTINGS.mail, ...(p.mail ?? {}) }
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
