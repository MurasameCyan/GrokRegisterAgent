/**
 * CPA auth 文件列表、重签、SSO→CPA mint。
 * 列表直接读目录；重签/mint 调用 register/auth_service。
 */
import { promises as fsp, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadSettings, dataDir } from './settingsStore.js';
import { resolveHttpProxy } from './resolveHttpProxy.js';
import { resolveRegisterRuntime } from './bot/registerRuntime.js';
import { readBotFlagFromAuthRecord, readBotFlagFromToken } from './jwtBotFlag.js';
import { proxiedRequest } from './httpClient.js';

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
  /** access_token/sso JWT 中的 bot_flag_source */
  botFlagSource?: number | string | null;
  isBotFlag1?: boolean;
  /** auth 内 sso 的 SHA-256（规范化后），不返回 sso 原文 */
  ssoHash?: string | null;
  hasSso?: boolean;
}

/** 规范化 SSO cookie / JWT 文本后做 SHA-256 hex */
export function normalizeSsoToken(sso: string): string {
  return String(sso || '')
    .trim()
    .replace(/^sso=/i, '')
    .trim();
}

export function hashSsoToken(sso: string): string | null {
  const token = normalizeSsoToken(sso);
  if (!token || token.length < 8) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function extractSsoFromAuthData(data: Record<string, unknown>): string {
  const direct = data.sso;
  if (typeof direct === 'string' && direct.trim()) return direct;
  // 兼容嵌套 / extra
  const extra = data.extra;
  if (extra && typeof extra === 'object') {
    const s = (extra as Record<string, unknown>).sso;
    if (typeof s === 'string' && s.trim()) return s;
  }
  return '';
}

export interface CpaRemoteResult {
  ok: boolean;
  url?: string;
  name?: string;
  error?: string;
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
  /** mint 预检：alive | dead | banned | unknown | bot_flag */
  verdict?: string;
  skipped?: boolean;
  botFlagSource?: number | string | null;
  isBotFlag1?: boolean;
  /** cehuo 风格 CPA /responses 测活 */
  probeAction?: string;
  probeHttp?: number;
  probeDeleted?: boolean;
  /** Management API 远程推送结果（未配置时 undefined） */
  remoteOk?: boolean | null;
  remoteError?: string;
  remoteName?: string;
}

function parseRemoteField(raw: unknown): {
  remoteOk?: boolean | null;
  remoteError?: string;
  remoteName?: string;
  remote?: CpaRemoteResult | null;
} {
  if (raw == null) {
    return { remoteOk: null, remote: null };
  }
  if (typeof raw !== 'object') {
    return { remoteOk: null, remote: null };
  }
  const o = raw as Record<string, unknown>;
  const ok = o.ok !== false && !o.error;
  const err = o.error != null ? String(o.error) : undefined;
  const name = o.name != null ? String(o.name) : undefined;
  const url = o.url != null ? String(o.url) : undefined;
  return {
    remoteOk: ok,
    remoteError: err,
    remoteName: name,
    remote: { ok, url, name, error: err }
  };
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
      const bot = readBotFlagFromAuthRecord(data);
      const rawSso = extractSsoFromAuthData(data);
      const ssoHash = hashSsoToken(rawSso);
      items.push({
        filename: name,
        path: full,
        email: String(data.email || ''),
        sub: String(data.sub || ''),
        expired: String(data.expired || ''),
        disabled: Boolean(data.disabled),
        hasRefresh: Boolean(data.refresh_token),
        mtime: st.mtimeMs,
        botFlagSource: bot.botFlagSource,
        isBotFlag1: bot.isBotFlag1,
        ssoHash,
        hasSso: Boolean(rawSso && rawSso.trim()),
        ...flags
      });
    } catch {
      /* skip unreadable */
    }
  }
  items.sort((a, b) => b.mtime - a.mtime);

  // 无 sso 时无法做号池 SSO 哈希匹配（仅靠 email）
  const missingSso = items.filter((i) => !i.hasSso);
  if (missingSso.length > 0) {
    const sample = missingSso
      .slice(0, 8)
      .map((i) => i.filename)
      .join(', ');
    const more = missingSso.length > 8 ? ` …等共 ${missingSso.length} 个` : '';
    console.warn(
      `[cpa-auth] ${missingSso.length} 个 auth 文件无 sso 字段，无法 hash 匹配号池` +
        `（仅靠 email）。可用「回填 SSO」从号池反写。示例: ${sample}${more}`
    );
  }

  return { dir, items };
}

export interface BackfillCpaAuthSsoResult {
  dir: string;
  scanned: number;
  /** 已有 sso 且未 force 覆盖 */
  alreadyHasSso: number;
  /** 成功写入 sso */
  filled: number;
  /** 无邮箱 */
  skippedNoEmail: number;
  /** 号池无同邮箱 SSO */
  skippedNoMatch: number;
  failed: number;
  dryRun: boolean;
  results: Array<{
    filename: string;
    email: string;
    ok: boolean;
    action: 'filled' | 'already' | 'no_email' | 'no_match' | 'failed' | 'would_fill';
    error?: string;
  }>;
}

/**
 * 从号池按 email（忽略大小写）给 auth 目录回填顶层 sso。
 * 用于旧 mint 产物无 sso 字段、号池无邮箱时无法 hash 匹配的场景。
 */
export async function backfillCpaAuthSsoFromPool(input?: {
  /** 仅处理这些文件名；空=全部 .json */
  filenames?: string[];
  /** true 时已有 sso 也覆盖为号池最新匹配 */
  force?: boolean;
  /** 只统计不写盘 */
  dryRun?: boolean;
}): Promise<BackfillCpaAuthSsoResult> {
  const { listAccounts } = await import('./accountStore.js');
  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  const force = Boolean(input?.force);
  const dryRun = Boolean(input?.dryRun);
  const filterNames = new Set(
    (Array.isArray(input?.filenames) ? input!.filenames : [])
      .map((f) => basename(String(f || '').trim()))
      .filter((f) => f.endsWith('.json'))
  );

  const accounts = await listAccounts();
  // email(lower) → 最佳 sso（有 sso 的优先，createdAt 新的优先）
  const emailToSso = new Map<string, { sso: string; createdAt: string }>();
  for (const a of accounts) {
    const email = String(a.email || '')
      .trim()
      .toLowerCase();
    const sso = normalizeSsoToken(a.sso);
    if (!email || !sso || sso.length < 8) continue;
    const prev = emailToSso.get(email);
    if (!prev || String(a.createdAt || '') > prev.createdAt) {
      emailToSso.set(email, { sso, createdAt: String(a.createdAt || '') });
    }
  }

  const empty: BackfillCpaAuthSsoResult = {
    dir,
    scanned: 0,
    alreadyHasSso: 0,
    filled: 0,
    skippedNoEmail: 0,
    skippedNoMatch: 0,
    failed: 0,
    dryRun,
    results: []
  };
  if (!existsSync(dir)) return empty;

  const names = await fsp.readdir(dir);
  const results: BackfillCpaAuthSsoResult['results'] = [];
  let scanned = 0;
  let alreadyHasSso = 0;
  let filled = 0;
  let skippedNoEmail = 0;
  let skippedNoMatch = 0;
  let failed = 0;

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (filterNames.size > 0 && !filterNames.has(name)) continue;
    const full = join(dir, name);
    scanned++;
    try {
      const st = await fsp.stat(full);
      if (!st.isFile()) continue;
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(await fsp.readFile(full, 'utf-8')) as Record<string, unknown>;
      } catch (e) {
        failed++;
        results.push({
          filename: name,
          email: '',
          ok: false,
          action: 'failed',
          error: e instanceof Error ? e.message : String(e)
        });
        continue;
      }

      const email = String(data.email || '')
        .trim()
        .toLowerCase();
      const existing = extractSsoFromAuthData(data);
      if (existing && !force) {
        alreadyHasSso++;
        results.push({
          filename: name,
          email: String(data.email || ''),
          ok: true,
          action: 'already'
        });
        continue;
      }
      if (!email) {
        skippedNoEmail++;
        results.push({
          filename: name,
          email: '',
          ok: false,
          action: 'no_email'
        });
        continue;
      }
      const hit = emailToSso.get(email);
      if (!hit) {
        skippedNoMatch++;
        results.push({
          filename: name,
          email: String(data.email || ''),
          ok: false,
          action: 'no_match'
        });
        continue;
      }

      if (dryRun) {
        filled++;
        results.push({
          filename: name,
          email: String(data.email || ''),
          ok: true,
          action: 'would_fill'
        });
        continue;
      }

      data.sso = hit.sso;
      const tmp = `${full}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
      await fsp.rename(tmp, full);
      filled++;
      results.push({
        filename: name,
        email: String(data.email || ''),
        ok: true,
        action: 'filled'
      });
    } catch (e) {
      failed++;
      results.push({
        filename: name,
        email: '',
        ok: false,
        action: 'failed',
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  console.log(
    `[cpa-auth] backfill sso: scanned=${scanned} filled=${filled} already=${alreadyHasSso} ` +
      `noEmail=${skippedNoEmail} noMatch=${skippedNoMatch} failed=${failed} dryRun=${dryRun}`
  );

  return {
    dir,
    scanned,
    alreadyHasSso,
    filled,
    skippedNoEmail,
    skippedNoMatch,
    failed,
    dryRun,
    results
  };
}

export async function resignCpaAuth(input: {
  filename?: string;
  path?: string;
  sso?: string;
  /** 重签成功后是否推送到远程 CPA（默认 false） */
  pushRemote?: boolean;
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

  const pushRemote = input.pushRemote === true;
  const code = `
import json, sys
sys.path.insert(0, ${JSON.stringify(runtime.registerDir)})
from auth_service import resign_auth_file
path = sys.argv[1]
proxy = sys.argv[2] if len(sys.argv) > 2 else ""
sso = sys.argv[3] if len(sys.argv) > 3 else ""
push = (sys.argv[4] if len(sys.argv) > 4 else "0") == "1"
r = resign_auth_file(path, sso=sso, proxy=proxy, push_remote=push)
print(json.dumps(r, ensure_ascii=False))
`.trim();

  const r = await runPythonJson(runtime.pythonPath, runtime.registerDir, code, [
    resolved,
    resolveHttpProxy(settings, 'cpaAuth'),
    String(input.sso || '').trim(),
    pushRemote ? '1' : '0'
  ]);

  const outPath = String(r.path || resolved);
  const flags = await readXaiAfter(outPath);
  const remote = parseRemoteField(r.remote);
  return {
    ...r,
    filename: r.filename || basename(outPath),
    ...flags,
    remoteOk: remote.remoteOk,
    remoteError: remote.remoteError,
    remoteName: remote.remoteName,
    remote: remote.remote
  };
}

export async function resignCpaAuthBatch(input: {
  filenames?: string[];
  paths?: string[];
  concurrency?: number;
  /** 重签成功后推送远程（默认 false） */
  pushRemote?: boolean;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  remoteOk?: number;
  remoteFailed?: number;
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
  if (jobs.length > 100) throw new Error('单次批量重签最多 100 个');

  const concurrency = Math.min(5, Math.max(1, Number(input.concurrency) || 2));
  const pushRemote = input.pushRemote === true;
  const results: CpaAuthBatchResultItem[] = [];
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const i = idx++;
      const job = jobs[i];
      try {
        const r = await resignCpaAuth({ ...job, pushRemote });
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
          probeDeleted: Boolean(r.deleted) || Boolean(probeObj?.deleted),
          remoteOk:
            typeof r.remoteOk === 'boolean'
              ? r.remoteOk
              : r.remoteOk === null
                ? null
                : undefined,
          remoteError: r.remoteError ? String(r.remoteError) : undefined,
          remoteName: r.remoteName ? String(r.remoteName) : undefined
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
  const remoteOk = results.filter((r) => r.remoteOk === true).length;
  const remoteFailed = results.filter((r) => r.remoteOk === false).length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    remoteOk,
    remoteFailed,
    results
  };
}

/**
 * 批量把已有 auth JSON 推到远程 CPA Management API（不重新 mint）。
 * POST {cpaRemoteUrl}/v0/management/auth-files?name=...
 */
export async function pushCpaAuthRemoteBatch(input: {
  filenames?: string[];
  paths?: string[];
  concurrency?: number;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  remoteConfigured: boolean;
  remoteUrl?: string;
  results: CpaAuthBatchResultItem[];
}> {
  const settings = await loadSettings();
  let base = String(settings.cpaRemoteUrl || '').trim().replace(/\/+$/, '');
  const key = String(settings.cpaManagementKey || '').trim();
  if (base.endsWith('/v1')) base = base.slice(0, -3).replace(/\/+$/, '');

  if (!base || !key) {
    throw new Error(
      '未配置远程 CPA：请在设置中填写「远程 CPA 地址」与「远程 CPA 管理密钥」'
    );
  }

  const dir = resolveAuthDir(settings.authDir);
  const names = Array.isArray(input.filenames) ? input.filenames : [];
  const paths = Array.isArray(input.paths) ? input.paths : [];
  const jobs: { filename: string; path: string }[] = [];

  for (const f of names) {
    const name = String(f || '').trim();
    if (!name) continue;
    const full = join(dir, name);
    assertInsideAuthDir(full, dir);
    jobs.push({ filename: name, path: full });
  }
  for (const p of paths) {
    const full = resolve(String(p || '').trim());
    if (!full) continue;
    assertInsideAuthDir(full, dir);
    jobs.push({ filename: basename(full), path: full });
  }
  // 去重
  const seen = new Set<string>();
  const unique = jobs.filter((j) => {
    const k = j.path.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 0) throw new Error('缺少 filenames 或 paths');
  if (unique.length > 200) throw new Error('单次远程推送最多 200 个');

  const concurrency = Math.min(6, Math.max(1, Number(input.concurrency) || 3));
  const results: CpaAuthBatchResultItem[] = [];
  let idx = 0;

  async function worker() {
    while (idx < unique.length) {
      const i = idx++;
      const job = unique[i];
      try {
        if (!existsSync(job.path)) {
          results.push({
            filename: job.filename,
            ok: false,
            remoteOk: false,
            error: '文件不存在',
            remoteError: '文件不存在'
          });
          continue;
        }
        const raw = await fsp.readFile(job.path, 'utf-8');
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          results.push({
            filename: job.filename,
            ok: false,
            remoteOk: false,
            error: 'JSON 解析失败',
            remoteError: 'JSON 解析失败'
          });
          continue;
        }
        const email = String(data.email || '');
        const uploadName = job.filename.endsWith('.json')
          ? job.filename
          : `${job.filename}.json`;
        const url = `${base}/v0/management/auth-files?name=${encodeURIComponent(uploadName)}`;
        const res = await proxiedRequest(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: data,
          timeoutMs: 30000
        });
        if (res.status >= 400) {
          const body =
            typeof res.data === 'string'
              ? res.data
              : res.data != null
                ? JSON.stringify(res.data)
                : '';
          const msg = `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
          results.push({
            filename: job.filename,
            email,
            ok: false,
            remoteOk: false,
            remoteError: msg,
            error: msg,
            remoteName: uploadName
          });
        } else {
          results.push({
            filename: job.filename,
            email,
            ok: true,
            remoteOk: true,
            remoteName: uploadName
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          filename: job.filename,
          ok: false,
          remoteOk: false,
          error: msg,
          remoteError: msg
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    remoteConfigured: true,
    remoteUrl: base,
    results
  };
}

/**
 * 检测远程 CPA Management API 连通性（不上传文件）。
 * GET {base}/v0/management/auth-files 或 HEAD；401/403 也算「密钥到达了服务」。
 */
export async function testCpaRemoteConnectivity(input?: {
  url?: string;
  key?: string;
}): Promise<{
  ok: boolean;
  message: string;
  ms?: number;
  status?: number;
  remoteUrl?: string;
}> {
  const settings = await loadSettings();
  let base = String(input?.url ?? settings.cpaRemoteUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
  const key = String(input?.key ?? settings.cpaManagementKey ?? '').trim();
  if (base.endsWith('/v1')) base = base.slice(0, -3).replace(/\/+$/, '');
  if (!base) {
    return { ok: false, message: '请先填写远程 CPA 地址' };
  }
  if (!key) {
    return { ok: false, message: '请先填写远程 CPA 管理密钥' };
  }

  const started = Date.now();
  const url = `${base}/v0/management/auth-files`;
  try {
    const res = await proxiedRequest(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      },
      timeoutMs: 12000
    });
    const ms = Date.now() - started;
    // 2xx = 连通且鉴权通过
    if (res.status >= 200 && res.status < 300) {
      return {
        ok: true,
        message: `远程 CPA 连通（Management API 可用）`,
        ms,
        status: res.status,
        remoteUrl: base
      };
    }
    // 401/403 = 服务在线但密钥错误
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `已连上 ${base}，但密钥被拒（HTTP ${res.status}）`,
        ms,
        status: res.status,
        remoteUrl: base
      };
    }
    // 404 = 路径不对或未开 Management
    if (res.status === 404) {
      return {
        ok: false,
        message: `HTTP 404：请确认地址为 Management 根（不要带 /v1），且已开启 remote-management`,
        ms,
        status: 404,
        remoteUrl: base
      };
    }
    const body =
      typeof res.data === 'string'
        ? res.data
        : res.data != null
          ? JSON.stringify(res.data)
          : '';
    return {
      ok: false,
      message: `HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`,
      ms,
      status: res.status,
      remoteUrl: base
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
      remoteUrl: base
    };
  }
}

export async function mintCpaAuthFromSso(input: {
  items: { sso: string; email?: string }[];
  concurrency?: number;
  /** 默认 true：mint 前用 sso_probe 验活，仅存活 SSO 继续 */
  precheck?: boolean;
  /**
   * 默认 true：SSO JWT 中 bot_flag_source===1 时跳过 mint。
   * 只读过滤，无法改掉服务端已签发的 claim。
   */
  skipBotFlag1?: boolean;
}): Promise<{
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  alive: number;
  banned: number;
  botFlagSkipped?: number;
  remoteOk?: number;
  remoteFailed?: number;
  results: CpaAuthBatchResultItem[];
}> {
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) throw new Error('缺少 SSO 列表');
  if (items.length > 50) throw new Error('单次 mint 最多 50 个');
  const doPrecheck = input.precheck !== false;
  const skipBotFlag1 = input.skipBotFlag1 !== false;

  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  await fsp.mkdir(dir, { recursive: true });
  const runtime = resolveRegisterRuntime(settings);
  if (!runtime) throw new Error('未找到注册脚本目录，无法调用 Python mint');
  // mint 后 probe 死号是否删文件：跟随设置（默认 true）
  const deleteOnDead = settings.cpaProbeDeleteOnDead !== false;

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
delete_on_dead = (sys.argv[6] if len(sys.argv) > 6 else "1") != "0"
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
r = sso_to_cpa_auth(
    sso=sso, email=email, proxy=proxy, auth_dir=auth_dir or None,
    random_fingerprint=True, delete_on_dead=delete_on_dead,
)
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
      const ssoFlag = readBotFlagFromToken(sso);
      if (skipBotFlag1 && ssoFlag.isBotFlag1) {
        results.push({
          email,
          ok: false,
          skipped: true,
          mode: 'skipped_bot_flag',
          verdict: 'bot_flag',
          botFlagSource: ssoFlag.botFlagSource,
          isBotFlag1: true,
          error: 'bot_flag_source=1（已跳过 mint）'
        });
        continue;
      }
      try {
        const r = await runPythonJson(runtime!.pythonPath, runtime!.registerDir, code, [
          sso,
          email,
          resolveHttpProxy(settings, 'cpaAuth'),
          dir,
          doPrecheck ? '1' : '0',
          deleteOnDead ? '1' : '0'
        ]);
        const skipped = Boolean(r.skipped) || String(r.mode || '').startsWith('skipped_');
        if (skipped) {
          results.push({
            email: String(r.email || email),
            ok: false,
            skipped: true,
            mode: String(r.mode || 'skipped_dead'),
            verdict: String(r.verdict || 'dead'),
            botFlagSource: ssoFlag.botFlagSource,
            isBotFlag1: ssoFlag.isBotFlag1,
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
        let outFlag = ssoFlag;
        if (outPath && existsSync(outPath)) {
          try {
            const data = JSON.parse(await fsp.readFile(outPath, 'utf-8')) as Record<
              string,
              unknown
            >;
            outFlag = readBotFlagFromAuthRecord(data);
          } catch {
            /* keep sso flag */
          }
        }
        const remote = parseRemoteField(r.remote);
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
          botFlagSource: outFlag.botFlagSource,
          isBotFlag1: outFlag.isBotFlag1,
          probeAction: probeObj ? String(probeObj.action || '') : undefined,
          probeHttp: probeObj
            ? Number(probeObj.http_status || 0) || undefined
            : undefined,
          probeDeleted: Boolean(r.deleted) || Boolean(probeObj?.deleted),
          remoteOk: remote.remoteOk,
          remoteError: remote.remoteError,
          remoteName: remote.remoteName
        });
      } catch (err) {
        results.push({
          email,
          ok: false,
          skipped: false,
          mode: 'sso_mint_error',
          botFlagSource: ssoFlag.botFlagSource,
          isBotFlag1: ssoFlag.isBotFlag1,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const banned = results.filter((r) => r.verdict === 'banned' || r.mode === 'skipped_banned').length;
  const botFlagSkipped = results.filter(
    (r) => r.verdict === 'bot_flag' || r.mode === 'skipped_bot_flag'
  ).length;
  const alive = results.filter((r) => !r.skipped).length;
  const remoteOkN = results.filter((r) => r.remoteOk === true).length;
  const remoteFailedN = results.filter((r) => r.remoteOk === false).length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok - skipped,
    skipped,
    alive,
    banned,
    botFlagSkipped,
    remoteOk: remoteOkN,
    remoteFailed: remoteFailedN,
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
  /** 未传时读 settings.cpaProbeDeleteOnDead，默认 true */
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

  const settings = await loadSettings();
  const deleteOnDead =
    input.deleteOnDead !== undefined
      ? input.deleteOnDead !== false
      : settings.cpaProbeDeleteOnDead !== false;
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
          resolveHttpProxy(settings, 'cpaAuth'),
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

/** 批量删除 CPA auth 文件（仅 auth 目录内 .json） */
export async function deleteCpaAuthBatch(input: {
  filenames?: string[];
  paths?: string[];
}): Promise<{
  total: number;
  deleted: number;
  failed: number;
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
  if (jobs.length > 500) throw new Error('单次批量删除最多 500 个');

  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  const results: CpaAuthBatchResultItem[] = [];

  for (const job of jobs) {
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
      await fsp.unlink(resolved);
      results.push({
        filename: basename(resolved),
        ok: true,
        mode: 'deleted',
        path: resolved
      });
    } catch (err) {
      results.push({
        filename: job.filename || basename(job.path || resolved || ''),
        ok: false,
        mode: 'delete_error',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const deleted = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    deleted,
    failed: results.length - deleted,
    results
  };
}

/** 读取 auth 文件内容（导出用）；单次最多 200 个 */
export async function readCpaAuthFiles(input: {
  filenames?: string[];
}): Promise<{
  dir: string;
  files: Array<{ filename: string; email: string; content: string }>;
}> {
  const names = Array.isArray(input.filenames) ? input.filenames : [];
  const list = names.map((n) => String(n || '').trim()).filter(Boolean);
  if (list.length === 0) throw new Error('缺少 filenames');
  if (list.length > 200) throw new Error('单次导出最多 200 个');

  const settings = await loadSettings();
  const dir = resolveAuthDir(settings.authDir);
  const files: Array<{ filename: string; email: string; content: string }> = [];

  for (const raw of list) {
    const name = basename(raw);
    if (!name || name.includes('..') || !name.endsWith('.json')) {
      throw new Error(`无效的 filename: ${raw}`);
    }
    const full = join(dir, name);
    assertInsideAuthDir(full, dir);
    if (!existsSync(full)) continue;
    const content = await fsp.readFile(full, 'utf-8');
    let email = '';
    try {
      const data = JSON.parse(content) as Record<string, unknown>;
      email = String(data.email || '');
    } catch {
      /* ignore */
    }
    files.push({ filename: name, email, content });
  }
  return { dir, files };
}
