/**
 * 号池 SSO → grok2api 手动推送（web import + convert）。
 * 需设置 pushSsoToGrok2api / autoPushSsoToGrok2api，并填写 grok2api 地址与账号。
 */
import { loadSettings } from './settingsStore.js';
import { resolveRegisterRuntime } from './bot/registerRuntime.js';
import { spawn } from 'child_process';

export type SsoG2PushItem = {
  sso: string;
  email?: string;
  id?: string;
};

export type SsoG2PushResultItem = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  email?: string;
  id?: string;
  mode?: string;
};

function runPythonJson(
  pythonPath: string,
  registerDir: string,
  code: string,
  args: string[]
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonPath, ['-c', code, ...args], {
      cwd: registerDir,
      env: { ...process.env },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (codeExit) => {
      const line = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop();
      if (line) {
        try {
          resolvePromise(JSON.parse(line) as Record<string, unknown>);
          return;
        } catch {
          /* fallthrough */
        }
      }
      if (codeExit !== 0) {
        reject(new Error(stderr.trim() || `python exit ${codeExit}`));
        return;
      }
      reject(new Error(stderr.trim() || 'python returned no JSON'));
    });
  });
}

export async function pushSsoToGrok2apiBatch(input: {
  items: SsoG2PushItem[];
  concurrency?: number;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  remoteConfigured: boolean;
  remoteUrl?: string;
  results: SsoG2PushResultItem[];
}> {
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw new Error('缺少 SSO 列表');
  if (items.length > 100) throw new Error('单次推送最多 100 个');

  const settings = await loadSettings();
  const allow =
    settings.pushSsoToGrok2api === true ||
    settings.autoPushSsoToGrok2api === true ||
    (settings.pushSsoToGrok2api === undefined &&
      settings.autoPushSsoToGrok2api === undefined &&
      settings.grok2apiAutoUpload === true);
  if (!allow) {
    throw new Error(
      '未开启 SSO→grok2api 推送：请到设置「推送设置」打开 SSO→grok2api 允许或自动'
    );
  }

  const url = String(settings.grok2apiUrl || '').trim().replace(/\/+$/, '');
  const username = String(settings.grok2apiUsername || '').trim();
  const password = String(settings.grok2apiPassword || '');
  if (!url || !username || !password) {
    throw new Error('请先在设置填写 grok2api 地址、用户名与密码');
  }

  const runtime = resolveRegisterRuntime(settings);
  if (!runtime) throw new Error('未找到注册脚本目录，无法调用 Python 推送');

  const pySettings = {
    push_sso_to_grok2api: true,
    grok2api_url: url,
    grok2api_username: username,
    grok2api_password: password,
    grok2api_upload_mode: 'web_convert'
  };

  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtime.registerDir)})
from grok2api_client import upload_registered_sso
sso = sys.argv[1]
email = sys.argv[2] if len(sys.argv) > 2 else ""
settings = json.loads(sys.argv[3])
try:
    r = upload_registered_sso(
        settings,
        sso,
        email=email or "",
        log=lambda m: print(m, file=sys.stderr, flush=True),
    )
    if r is None:
        print(json.dumps({"ok": False, "skipped": True, "error": "upload skipped"}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": True, "mode": r.get("mode") or "web_convert", "result": r}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:400]}, ensure_ascii=False))
`.trim();

  const concurrency = Math.min(
    2,
    Math.max(1, Number(input.concurrency) || 1)
  );
  const results: SsoG2PushResultItem[] = [];
  let ok = 0;
  let failed = 0;
  let skipped = 0;

  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const it = items[i];
      const sso = String(it?.sso || '').trim();
      const email = String(it?.email || '').trim();
      const id = it?.id;
      if (!sso) {
        results[i] = {
          ok: false,
          error: 'empty sso',
          email,
          id
        };
        failed++;
        continue;
      }
      try {
        const r = await runPythonJson(
          runtime!.pythonPath,
          runtime!.registerDir,
          code,
          [sso, email, JSON.stringify(pySettings)]
        );
        if (r.ok === true) {
          ok++;
          results[i] = {
            ok: true,
            email,
            id,
            mode: r.mode ? String(r.mode) : 'web_convert'
          };
        } else if (r.skipped === true) {
          skipped++;
          results[i] = {
            ok: false,
            skipped: true,
            error: String(r.error || 'skipped'),
            email,
            id
          };
        } else {
          failed++;
          results[i] = {
            ok: false,
            error: String(r.error || 'push failed'),
            email,
            id
          };
        }
      } catch (err) {
        failed++;
        results[i] = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          email,
          id
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return {
    total: items.length,
    ok,
    failed,
    skipped,
    remoteConfigured: true,
    remoteUrl: url,
    results
  };
}
