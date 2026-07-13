/**
 * CPA auth 文件列表、重签、SSO→CPA mint。
 * 列表直接读目录；重签/mint 调用 register/auth_service。
 */
import { promises as fsp, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { loadSettings, dataDir } from './settingsStore.js';
import { resolveRegisterRuntime } from './bot/registerRuntime.js';

export interface CpaAuthItem {
  filename: string;
  path: string;
  email: string;
  sub: string;
  expired: string;
  disabled: boolean;
  hasRefresh: boolean;
  mtime: number;
  /** 文件名以 xai- 开头 */
  xaiFilename: boolean;
  /** JSON 内 type === "xai" */
  xaiType: boolean;
  /** 综合：文件名或 type 任一满足视为带 xai 标识 */
  xai: boolean;
  authType: string;
}

export interface CpaAuthBatchResultItem {
  filename?: string;
  email?: string;
  ok: boolean;
  error?: string;
  mode?: string;
  path?: string;
  xai?: boolean;
  xaiFilename?: boolean;
  xaiType?: boolean;
  /** mint 预检：alive | dead | banned | unknown */
  verdict?: string;
  skipped?: boolean;
  /** cehuo 风格 CPA /responses 测活 */
  probeAction?: string;
  probeHttp?: number;
  probeDeleted?: boolean;
}

function resolveAuthDir(configured?: string): string {
  const trimmed = String(configured || '').trim();
  if (trimmed) return resolve(trimmed);
  const env = (process.env.AUTH_DIR || process.env.CPA_AUTH_DIR || '').trim();
  if (env) return resolve(env);
  return join(dataDir(), 'auth');
}

function xaiFlags(filename: string, data: Record<string, unknown>) {
  const authType = String(data.type || '').trim();
  const xaiFilename = /^xai-/i.test(filename);
  const xaiType = authType.toLowerCase() === 'xai';
  return {
    authType,
    xaiFilename,
    xaiType,
    xai: xaiFilename || xaiType
  };
}

function assertInsideAuthDir(resolved: string, authRoot: string) {
  const root = resolve(authRoot);
  const target = resolve(resolved);
  const sep = process.platform === 'win32' ? '\\' : '/';
  const ok =
    target === root ||
    target.startsWith(root + sep) ||
    target.toLowerCase().startsWith(root.toLowerCase() + sep) ||
    target.toLowerCase() === root.toLowerCase();
  if (!ok) throw new Error('只能操作 auth 目录内的文件');
}

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

async function readXaiAfter(path: string): Promise<{
  xai: boolean;
  xaiFilename: boolean;
  xaiType: boolean;
  authType: string;
}> {
  const name = basename(path);
  try {
    const data = JSON.parse(await fsp.readFile(path, 'utf-8')) as Record<string, unknown>;
    return xaiFlags(name, data);
  } catch {
    return { ...xaiFlags(name, {}), authType: '' };
  }
}

export async function listCpaAuth(): Promise<{ dir: string; items: CpaAuthItem[] }> {
  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  if (!existsSync(dir)) {
    return { dir, items: [] };
  }
  const names = await fsp.readdir(dir);
  const items: CpaAuthItem[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const full = join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) continue;
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(await fsp.readFile(full, 'utf-8')) as Record<string, unknown>;
      } catch {
        data = {};
      }
      const flags = xaiFlags(name, data);
      items.push({
        filename: name,
        path: full,
        email: String(data.email || ''),
        sub: String(data.sub || ''),
        expired: String(data.expired || ''),
        disabled: Boolean(data.disabled),
        hasRefresh: Boolean(data.refresh_token),
        mtime: st.mtimeMs,
        ...flags
      });
    } catch {
      /* skip unreadable */
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return { dir, items };
}

export async function resignCpaAuth(input: {
  filename?: string;
  path?: string;
  sso?: string;
}): Promise<Record<string, unknown>> {
  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  let target = String(input.path || '').trim();
  if (!target && input.filename) {
    const name = basename(String(input.filename).trim());
    if (!name || name.includes('..') || !name.endsWith('.json')) {
      throw new Error('无效的 filename');
    }
    target = join(dir, name);
  }
  if (!target) throw new Error('缺少 path 或 filename');
  const resolved = resolve(target);
  assertInsideAuthDir(resolved, dir);
  if (!existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);

  const runtime = resolveRegisterRuntime(settings);
  if (!runtime) throw new Error('未找到注册脚本目录，无法调用 Python 重签');

  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtime.registerDir)})
from auth_service import resign_auth_file
path = sys.argv[1]
proxy = sys.argv[2] if len(sys.argv) > 2 else ""
sso = sys.argv[3] if len(sys.argv) > 3 else ""
r = resign_auth_file(path, sso=sso, proxy=proxy)
print(json.dumps(r, ensure_ascii=False))
`.trim();

  const r = await runPythonJson(runtime.pythonPath, runtime.registerDir, code, [
    resolved,
    settings.proxy || '',
    String(input.sso || '').trim()
  ]);

  const outPath = String(r.path || resolved);
  const flags = await readXaiAfter(outPath);
  return {
    ...r,
    filename: r.filename || basename(outPath),
    ...flags
  };
}

export async function resignCpaAuthBatch(input: {
  filenames?: string[];
  paths?: string[];
  concurrency?: number;
}): Promise<{ total: number; ok: number; failed: number; results: CpaAuthBatchResultItem[] }> {
  const names = Array.isArray(input.filenames) ? input.filenames : [];
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const jobs: { filename?: string; path?: string }[] = [];
  for (const f of names) {
    if (String(f || '').trim()) jobs.push({ filename: String(f).trim() });
  }
  for (const p of paths) {
    if (String(p || '').trim()) jobs.push({ path: String(p).trim() });
  }
  if (jobs.length === 0) throw new Error('缺少 filenames 或 paths');
  if (jobs.length > 100) throw new Error('单次批量重签最多 100 个');

  const concurrency = Math.min(5, Math.max(1, Number(input.concurrency) || 2));
  const results: CpaAuthBatchResultItem[] = [];
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const i = idx++;
      const job = jobs[i];
      try {
        const r = await resignCpaAuth(job);
        const probeObj =
          r.probe && typeof r.probe === 'object'
            ? (r.probe as Record<string, unknown>)
            : null;
        results.push({
          filename: String(r.filename || job.filename || ''),
          email: String(r.email || ''),
          ok: r.ok !== false && !r.error,
          error: r.error ? String(r.error) : undefined,
          mode: r.mode ? String(r.mode) : undefined,
          path: r.path ? String(r.path) : undefined,
          xai: Boolean(r.xai),
          xaiFilename: Boolean(r.xaiFilename),
          xaiType: Boolean(r.xaiType),
          probeAction: probeObj ? String(probeObj.action || '') : undefined,
          probeHttp: probeObj
            ? Number(probeObj.http_status || 0) || undefined
            : undefined,
          probeDeleted: Boolean(r.deleted) || Boolean(probeObj?.deleted)
        });
      } catch (err) {
        results.push({
          filename: job.filename || basename(job.path || ''),
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = results.filter((r) => r.ok).length;
  return { total: results.length, ok, failed: results.length - ok, results };
}

export async function mintCpaAuthFromSso(input: {
  items: { sso: string; email?: string }[];
  concurrency?: number;
  /** 默认 true：mint 前用 sso_probe 验活，仅存活 SSO 继续 */
  precheck?: boolean;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  alive: number;
  banned: number;
  results: CpaAuthBatchResultItem[];
}> {
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw new Error('缺少 SSO 列表');
  if (items.length > 50) throw new Error('单次 mint 最多 50 个');
  const doPrecheck = input.precheck !== false;

  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  await fsp.mkdir(dir, { recursive: true });
  const runtime = resolveRegisterRuntime(settings);
  if (!runtime) throw new Error('未找到注册脚本目录，无法调用 Python mint');

  // 预检 + mint 合并为一次 Python 调用（check_sso_ban / sso2gropcpa 思路）
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtime.registerDir)})
from sso_probe import probe_sso
from auth_service import sso_to_cpa_auth
sso = sys.argv[1]
email = sys.argv[2] if len(sys.argv) > 2 else ""
proxy = sys.argv[3] if len(sys.argv) > 3 else ""
auth_dir = sys.argv[4] if len(sys.argv) > 4 else ""
precheck = (sys.argv[5] if len(sys.argv) > 5 else "1") != "0"
if precheck:
    p = probe_sso(sso, proxy=proxy)
    if not p.get("alive"):
        print(json.dumps({
            "ok": False,
            "skipped": True,
            "mode": "skipped_" + str(p.get("verdict") or "dead"),
            "verdict": p.get("verdict") or "dead",
            "error": p.get("error") or "sso not alive",
            "email": email or p.get("email") or "",
        }, ensure_ascii=False))
        raise SystemExit(0)
    if not email and p.get("email"):
        email = p.get("email") or email
r = sso_to_cpa_auth(sso=sso, email=email, proxy=proxy, auth_dir=auth_dir or None, random_fingerprint=True)
if isinstance(r, dict):
    r.setdefault("mode", "sso_mint")
    r.setdefault("verdict", "alive")
    r["skipped"] = False
print(json.dumps(r, ensure_ascii=False))
`.trim();

  const concurrency = Math.min(3, Math.max(1, Number(input.concurrency) || 2));
  const results: CpaAuthBatchResultItem[] = [];
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      const item = items[i];
      const sso = String(item.sso || '').trim();
      const email = String(item.email || '').trim();
      if (!sso) {
        results.push({
          email,
          ok: false,
          skipped: true,
          mode: 'skipped_dead',
          verdict: 'dead',
          error: 'empty sso'
        });
        continue;
      }
      try {
        const r = await runPythonJson(runtime!.pythonPath, runtime!.registerDir, code, [
          sso,
          email,
          settings.proxy || '',
          dir,
          doPrecheck ? '1' : '0'
        ]);
        const skipped = Boolean(r.skipped) || String(r.mode || '').startsWith('skipped_');
        if (skipped) {
          results.push({
            email: String(r.email || email),
            ok: false,
            skipped: true,
            mode: String(r.mode || 'skipped_dead'),
            verdict: String(r.verdict || 'dead'),
            error: r.error ? String(r.error) : 'sso not alive'
          });
          continue;
        }
        const outPath = String(r.path || '');
        const probeObj =
          r.probe && typeof r.probe === 'object'
            ? (r.probe as Record<string, unknown>)
            : null;
        const flags = outPath
          ? await readXaiAfter(outPath)
          : { xai: false, xaiFilename: false, xaiType: false, authType: '' };
        results.push({
          filename: String(r.filename || (outPath ? basename(outPath) : '')),
          email: String(r.email || email),
          ok: r.ok !== false && !r.error,
          error: r.error ? String(r.error) : undefined,
          mode: String(r.mode || 'sso_mint'),
          verdict: String(r.verdict || 'alive'),
          skipped: false,
          path: outPath || undefined,
          xai: flags.xai,
          xaiFilename: flags.xaiFilename,
          xaiType: flags.xaiType,
          probeAction: probeObj ? String(probeObj.action || '') : undefined,
          probeHttp: probeObj
            ? Number(probeObj.http_status || 0) || undefined
            : undefined,
          probeDeleted: Boolean(r.deleted) || Boolean(probeObj?.deleted)
        });
      } catch (err) {
        results.push({
          email,
          ok: false,
          skipped: false,
          mode: 'sso_mint_error',
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const banned = results.filter((r) => r.verdict === 'banned' || r.mode === 'skipped_banned').length;
  const alive = results.filter((r) => !r.skipped).length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok - skipped,
    skipped,
    alive,
    banned,
    results
  };
}

/**
 * 批量 CPA 测活（cehuo /responses）。
 * 默认对 401/402/403 删除文件（deleteOnDead=true）。
 */
export async function probeCpaAuthBatch(input: {
  filenames?: string[];
  paths?: string[];
  concurrency?: number;
  deleteOnDead?: boolean;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  dead: number;
  deleted: number;
  keep: number;
  results: CpaAuthBatchResultItem[];
}> {
  const names = Array.isArray(input.filenames) ? input.filenames : [];
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const jobs: { filename?: string; path?: string }[] = [];
  for (const f of names) {
    if (String(f || '').trim()) jobs.push({ filename: String(f).trim() });
  }
  for (const p of paths) {
    if (String(p || '').trim()) jobs.push({ path: String(p).trim() });
  }
  if (jobs.length === 0) throw new Error('缺少 filenames 或 paths');
  if (jobs.length > 200) throw new Error('单次批量测活最多 200 个');

  const deleteOnDead = input.deleteOnDead !== false;
  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  const runtime = resolveRegisterRuntime(settings);
  if (!runtime) throw new Error('未找到注册脚本目录，无法调用 Python 测活');

  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtime.registerDir)})
from cpa_probe import probe_and_cleanup
path = sys.argv[1]
proxy = sys.argv[2] if len(sys.argv) > 2 else ""
delete_on_dead = (sys.argv[3] if len(sys.argv) > 3 else "1") != "0"
r = probe_and_cleanup(path, proxy=proxy, delete_on_dead=delete_on_dead)
print(json.dumps(r, ensure_ascii=False))
`.trim();

  const concurrency = Math.min(8, Math.max(1, Number(input.concurrency) || 4));
  const results: CpaAuthBatchResultItem[] = [];
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const i = idx++;
      const job = jobs[i];
      let resolved = '';
      try {
        if (job.path) {
          resolved = resolve(job.path);
        } else {
          const name = basename(String(job.filename || '').trim());
          if (!name || name.includes('..') || !name.endsWith('.json')) {
            throw new Error('无效的 filename');
          }
          resolved = join(dir, name);
        }
        assertInsideAuthDir(resolved, dir);
        if (!existsSync(resolved)) throw new Error(`文件不存在: ${resolved}`);

        const r = await runPythonJson(runtime!.pythonPath, runtime!.registerDir, code, [
          resolved,
          settings.proxy || '',
          deleteOnDead ? '1' : '0'
        ]);
        const action = String(r.action || '');
        const httpStatus = Number(r.http_status || 0) || undefined;
        const deleted = Boolean(r.deleted);
        const isOk = action === 'ok';
        results.push({
          filename: basename(resolved),
          email: String(r.email || ''),
          ok: isOk,
          error: r.error ? String(r.error) : action === 'dead' ? `HTTP ${httpStatus || '?'}` : undefined,
          mode: 'cpa_probe',
          path: deleted ? undefined : resolved,
          probeAction: action || undefined,
          probeHttp: httpStatus,
          probeDeleted: deleted
        });
      } catch (err) {
        results.push({
          filename: job.filename || basename(job.path || resolved || ''),
          ok: false,
          mode: 'cpa_probe_error',
          error: err instanceof Error ? err.message : String(err),
          probeAction: 'error'
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = results.filter((r) => r.ok).length;
  const dead = results.filter((r) => r.probeAction === 'dead').length;
  const deleted = results.filter((r) => r.probeDeleted).length;
  const keep = results.filter((r) => r.probeAction === 'keep').length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    dead,
    deleted,
    keep,
    results
  };
}
