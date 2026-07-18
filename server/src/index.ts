import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, promises as fsp, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';

import type { RegisterStartArgs, SystemHealth, SystemHealthCheck } from '@shared/ipc';
import type { AppSettings } from '@shared/settings';
import {
  bumpProxyRegisterSuccessInPoolText,
  moveProxiesFromAliveToPending
} from '@shared/settings';
import type { RunEvent } from '@shared/runEvents';
import { setAppEventBroadcast } from './appEvents.js';
import { loadSettings, saveSettings, dataDir } from './settingsStore.js';
import { registerBot } from './bot/registerBot.js';
import {
  applyAccountSsoChecks,
  deleteAccounts,
  importAccountsFromText,
  listAccounts,
  resyncAccountsFromDisk
} from './accountStore.js';
import { checkForUpdate, currentVersion, currentBuildId } from './updateCheck.js';
import { fetchEmails, extractVerificationCode, fetchLatestCodeByAddress } from './api/emailApi.js';
import { probeProxy, probeProxyBatch } from './api/proxyApi.js';
import { fetchProxiesFromUrl } from './api/proxyFetchApi.js';
import { resolveHttpProxy } from './resolveHttpProxy.js';
import {
  getCfwpStatus,
  readCfwpLog,
  stopCfwp
} from './cfwpManager.js';
import {
  getSingBoxStatus,
  listSingBoxNodeSummaries,
  parseSingBoxNodes,
  readSingBoxLog,
  rotateSingBoxNode,
  stopSingBox,
  syncSingBoxFromSettings
} from './singboxManager.js';
import { proxiedRequest, requestWithProxyFallback, errorMessage, isTransportError, looksLikeCloudflareChallenge } from './httpClient.js';
import { checkSso } from './ssoCheck.js';
import {
  authBootstrapInfo,
  changeCredentials,
  getAuthState,
  getAuthStateFromCookie,
  login,
  logout
} from './authStore.js';
import {
  backfillCpaAuthSsoFromPool,
  deleteCpaAuthBatch,
  listCpaAuth,
  mintCpaAuthFromSso,
  probeCpaAuthBatch,
  pushCpaAuthRemoteBatch,
  pushSub2apiAuthRemoteBatch,
  readCpaAuthFiles,
  reloginCpaAuth,
  resignCpaAuth,
  resignCpaAuthBatch,
  testCpaRemoteConnectivity,
  testSub2apiRemoteConnectivity
} from './cpaAuthStore.js';
import { pushSsoToGrok2apiBatch } from './ssoGrok2apiPush.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 6657);
const HOST = process.env.BIND_HOST || '0.0.0.0';

/**
 * Python 注册机 → Node 内部回调密钥（代理成功计数 / 降级）。
 * 优先 GRA_INTERNAL_KEY 环境变量；否则读写 DATA_DIR/internal-api-key。
 */
function ensureInternalApiKey(): string {
  const fromEnv = String(process.env.GRA_INTERNAL_KEY || '').trim();
  if (fromEnv) {
    process.env.GRA_INTERNAL_KEY = fromEnv;
    return fromEnv;
  }
  const keyPath = join(dataDir(), 'internal-api-key');
  try {
    if (existsSync(keyPath)) {
      const disk = readFileSync(keyPath, 'utf-8').trim();
      if (disk.length >= 16) {
        process.env.GRA_INTERNAL_KEY = disk;
        return disk;
      }
    }
  } catch {
    /* ignore */
  }
  const generated = randomBytes(24).toString('hex');
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(keyPath, generated, 'utf-8');
  } catch {
    /* 写盘失败仍用内存密钥，本进程 spawn 的 Python 可读 process.env */
  }
  process.env.GRA_INTERNAL_KEY = generated;
  return generated;
}

const INTERNAL_API_KEY = ensureInternalApiKey();

function safeEqualStr(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function isLoopbackReq(req: Request): boolean {
  const ip = String(req.socket?.remoteAddress || req.ip || '');
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.endsWith('/127.0.0.1')
  );
}

/** 仅供本机 Python 回调的代理内部写接口（无 session 时需 internal key 或 loopback） */
function isInternalProxyCallbackPath(req: Request): boolean {
  const p = String(req.path || req.url || '').split('?')[0];
  return (
    p === '/proxy/register-success' ||
    p === '/proxy/demote' ||
    p === '/api/proxy/register-success' ||
    p === '/api/proxy/demote' ||
    p === '/api/singbox/rotate' ||
    p === '/singbox/rotate' ||
    p.endsWith('/proxy/register-success') ||
    p.endsWith('/proxy/demote') ||
    p.endsWith('/singbox/rotate')
  );
}
const STATIC_ROOT = resolve(
  process.env.STATIC_ROOT || join(__dirname, '..', '..', '..', '..', 'out', 'renderer')
);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use((_req, res, next) => {
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

async function requireApiAuth(req: Request, res: Response, next: () => void) {
  const state = await getAuthState(req);
  if (state.authenticated) {
    next();
    return;
  }
  // Python 内部回调：X-GRA-Internal 共享密钥
  const hdr = String(
    req.headers['x-gra-internal'] ||
      req.headers['x-internal-key'] ||
      req.headers['x-gra-internal-key'] ||
      ''
  ).trim();
  if (INTERNAL_API_KEY && hdr && safeEqualStr(hdr, INTERNAL_API_KEY)) {
    next();
    return;
  }
  // 兼容：本机 loopback 访问代理成功/降级回调（无密钥的旧进程）
  if (isInternalProxyCallbackPath(req) && isLoopbackReq(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/auth/me', async (req, res) => {
  res.json(await getAuthState(req));
});

app.post('/api/auth/login', async (req, res) => {
  const state = await login(req, res);
  if (!state) {
    res.status(401).json({ error: '用户名或密码不正确' });
    return;
  }
  res.json(state);
});

app.post('/api/auth/logout', async (req, res) => {
  await logout(req, res);
  res.json({ ok: true });
});

app.post('/api/auth/change', async (req, res) => {
  try {
    res.json(await changeCredentials(req, req.body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(message === 'unauthorized' ? 401 : 400).json({ error: message });
  }
});

app.use('/api', requireApiAuth);

app.get('/api/settings', async (_req, res) => {
  res.json(await loadSettings());
});

app.put('/api/settings', async (req: Request, res: Response) => {
  const body = req.body as AppSettings;
  await saveSettings(body);
  // 保存后同步 sing-box（普通/CF 代理已移除）
  try {
    const s = await loadSettings();
    const singbox = await syncSingBoxFromSettings(s);
    // 确保旧 CF 进程被停掉
    try {
      await stopCfwp();
    } catch {
      /* ignore */
    }
    res.json({ ok: true, singbox });
  } catch (err) {
    console.error('[settings] proxy sync failed', err);
    res.json({ ok: true, syncError: String(err) });
  }
});

/** CF 独立代理（cfwp）状态 */
app.get('/api/cf-proxy/status', async (_req, res) => {
  const s = await loadSettings();
  res.json(getCfwpStatus(s));
});

/** 按当前配置启动/重载 cfwp */
app.post('/api/cf-proxy/start', async (_req, res) => {
  res.status(410).json({
    ok: false,
    error: 'CF 独立代理已移除，请使用 Sing-Box 或直连'
  });
});

/** 停止 cfwp（不改 settings；下次保存若仍开启会再启） */
app.post('/api/cf-proxy/stop', async (_req, res) => {
  const status = await stopCfwp();
  res.json({ ok: true, ...status });
});

/** 按当前 settings 同步（与保存时相同） */
app.post('/api/cf-proxy/sync', async (_req, res) => {
  const status = await stopCfwp();
  res.json({ ok: true, ...status, message: 'CF 独立代理已移除' });
});

/** 读取 cfwp 最近日志（只读） */
app.get('/api/cf-proxy/log', async (req, res) => {
  const s = await loadSettings();
  const tailRaw = Number(req.query.tail);
  const tail = Number.isFinite(tailRaw) ? tailRaw : 200;
  res.json(readCfwpLog(s, tail));
});

/** sing-box 独立代理状态 */
app.get('/api/singbox/status', async (_req, res) => {
  const s = await loadSettings();
  res.json(getSingBoxStatus(s));
});

/** 解析 settings 中的节点摘要 + 当前选中 */
app.get('/api/singbox/nodes', async (_req, res) => {
  const s = await loadSettings();
  const nodes = listSingBoxNodeSummaries(s.singBoxNodes || '');
  res.json({ nodes, selected: s.singBoxSelected || '' });
});

/** 解析任意节点文本（设置页 draft 预览，不写盘） */
app.post('/api/singbox/parse', async (req, res) => {
  const text = String((req.body as { nodes?: string })?.nodes ?? '');
  const nodes = listSingBoxNodeSummaries(text);
  res.json({ nodes, parseable: parseSingBoxNodes(text).length });
});

/** 按当前配置启动/重载 sing-box */
app.post('/api/singbox/start', async (_req, res) => {
  const s = await loadSettings();
  if (!s.singBoxEnabled) {
    res.status(400).json({
      ok: false,
      error: '请先在设置中开启「sing-box 独立代理」并保存'
    });
    return;
  }
  const status = await syncSingBoxFromSettings(s);
  res.json({ ok: !status.lastError || status.running, ...status });
});

/** 停止 sing-box（不改 settings；下次保存若仍开启会再启） */
app.post('/api/singbox/stop', async (_req, res) => {
  const status = await stopSingBox();
  res.json({ ok: true, ...status });
});

/** 按当前 settings 同步（与保存时相同） */
app.post('/api/singbox/sync', async (_req, res) => {
  const s = await loadSettings();
  const status = await syncSingBoxFromSettings(s);
  res.json({ ok: true, ...status });
});

/**
 * 注册失败降级：切换到其他节点并重启 sing-box（内部密钥 / 已登录）。
 * Python pools.demote 在 singbox 模式下调用。
 */
app.post('/api/singbox/rotate', async (req, res) => {
  const s = await loadSettings();
  if (!s.singBoxEnabled) {
    res.status(400).json({ ok: false, error: '未开启 sing-box', rotated: false });
    return;
  }
  const reason = String((req.body as { reason?: string })?.reason || '注册失败').slice(
    0,
    160
  );
  const status = await rotateSingBoxNode(s, reason);
  res.json({
    ok: !status.lastError || status.running,
    message: status.rotated
      ? `已切换节点 ${status.from || '?'} → ${status.to || '?'}`
      : status.lastError || '无其他可用节点或已用当前节点',
    ...status
  });
});

/** 读取 sing-box 最近日志（只读） */
app.get('/api/singbox/log', async (req, res) => {
  const s = await loadSettings();
  const tailRaw = Number(req.query.tail);
  const tail = Number.isFinite(tailRaw) ? tailRaw : 200;
  res.json(readSingBoxLog(s, tail));
});

app.get('/api/system/health', async (_req, res) => {
  res.json(await buildSystemHealth());
});

app.get('/api/system/version', (_req, res) => {
  const buildId = currentBuildId();
  res.json({ current: buildId, buildId, version: currentVersion() });
});

app.get('/api/system/update-check', async (_req, res) => {
  res.json(await checkForUpdate());
});

/** 授权队列 metrics（register/data/auth_queue_metrics.json） */
app.get('/api/auth-queue/metrics', async (_req, res) => {
  try {
    const { loadSettings } = await import('./settingsStore.js');
    const { resolveRegisterRuntime } = await import('./bot/registerRuntime.js');
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const settings = await loadSettings();
    const rt = resolveRegisterRuntime(settings);
    const candidates: string[] = [];
    if (rt?.registerDir) {
      candidates.push(join(rt.registerDir, 'data', 'auth_queue_metrics.json'));
      candidates.push(join(rt.registerDir, 'auth_queue_metrics.json'));
    }
    candidates.push(join(process.cwd(), 'register', 'data', 'auth_queue_metrics.json'));
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const data = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
        res.json({ ok: true, path: p, ...data });
        return;
      } catch {
        /* next */
      }
    }
    res.json({
      ok: true,
      pending: 0,
      queue_size: 0,
      done_ok: 0,
      done_fail: 0,
      workers: 0,
      queue_max: 0,
      stale: true
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

app.get('/api/run/status', async (_req, res) => {
  res.json(registerBot.getStatus());
});

/** 并行任务列表 */
app.get('/api/run/jobs', async (_req, res) => {
  res.json({
    jobs: registerBot.listJobs(),
    active: registerBot.activeCount(),
    focus: registerBot.getStatus().runId
  });
});

app.get('/api/run/jobs/:runId', async (req: Request, res: Response) => {
  const st = registerBot.getJobStatus(String(req.params.runId || ''));
  if (!st) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  res.json(st);
});

app.post('/api/run/focus', async (req: Request, res: Response) => {
  const runId = req.body?.runId != null ? String(req.body.runId) : null;
  res.json(registerBot.setFocus(runId || null));
});

app.post('/api/run/start', async (req: Request, res: Response) => {
  try {
    const args = (req.body ?? {}) as RegisterStartArgs & { maxParallel?: number };
    res.json(
      await registerBot.start({
        runCountOverride: args.runCount,
        maxParallelOverride: args.maxParallel
      })
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/run/stop', async (req: Request, res: Response) => {
  try {
    const runId = req.body?.runId != null ? String(req.body.runId) : undefined;
    const stopAll = req.body?.stopAll === true;
    res.json(await registerBot.stop(runId, { stopAll }));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** 清理已停止/完成/失败的任务队列（不杀仍在运行的进程） */
app.post('/api/run/jobs/clear-finished', async (_req: Request, res: Response) => {
  try {
    res.json(registerBot.clearFinishedJobs());
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/accounts', async (_req, res) => {
  res.json(await listAccounts());
});

/** 从 DATA_DIR/sso 与旧路径重新扫描导入历史账号 */
app.post('/api/accounts/resync', async (_req, res) => {
  try {
    res.json(await resyncAccountsFromDisk());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/** 批量删除号池账号（按 id） */
app.post('/api/accounts/delete', async (req: Request, res: Response) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : [];
    res.json(await deleteAccounts(ids));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** 文本/文件导入 SSO 到号池 */
app.post('/api/accounts/import', async (req: Request, res: Response) => {
  try {
    const text = String(req.body?.text || '');
    const source = String(req.body?.source || 'paste');
    if (!text.trim()) {
      res.status(400).json({ error: 'text 为空' });
      return;
    }
    if (text.length > 8_000_000) {
      res.status(400).json({ error: '文本过大（上限约 8MB）' });
      return;
    }
    res.json(await importAccountsFromText({ text, source }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** 号池 SSO → grok2api 手动推送（需推送设置开启 SSO→grok2api） */
app.post('/api/accounts/push-grok2api', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      items?: { sso: string; email?: string; id?: string }[];
      concurrency?: number;
    };
    res.json(
      await pushSsoToGrok2apiBatch({
        items: body.items || [],
        concurrency: body.concurrency
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** CPA auth 文件列表（data/auth 或 settings.authDir） */
app.get('/api/cpa-auth', async (_req, res) => {
  try {
    res.json(await listCpaAuth());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/** 重签单个 CPA auth（refresh 优先，失败可带 sso；可选 pushRemote） */
app.post('/api/cpa-auth/resign', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      filename?: string;
      path?: string;
      sso?: string;
      pushRemote?: boolean;
      baseUrlTarget?: string;
    };
    res.json(await resignCpaAuth(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** 批量重签 CPA auth */
app.post('/api/cpa-auth/resign-batch', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      filenames?: string[];
      paths?: string[];
      concurrency?: number;
      pushRemote?: boolean;
      baseUrlTarget?: string;
    };
    res.json(await resignCpaAuthBatch(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** 批量推送已有 auth 到远程 CPA（不重新 mint） */
app.post('/api/cpa-auth/push-remote', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      filenames?: string[];
      paths?: string[];
      concurrency?: number;
    };
    res.json(await pushCpaAuthRemoteBatch(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** 批量推送已有 auth 到 sub2api（先转 grok oauth 格式再 POST） */
app.post('/api/cpa-auth/push-sub2api', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      filenames?: string[];
      paths?: string[];
      concurrency?: number;
    };
    res.json(await pushSub2apiAuthRemoteBatch(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** 号池 SSO → CPA auth 补 mint */
app.post('/api/cpa-auth/mint', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      items?: { sso: string; email?: string }[];
      concurrency?: number;
      skipBotFlag1?: boolean;
      precheck?: boolean;
    };
    res.json(
      await mintCpaAuthFromSso({
        items: body.items || [],
        concurrency: body.concurrency,
        skipBotFlag1: body.skipBotFlag1,
        precheck: body.precheck
      })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** 批量 CPA 测活（cehuo /responses；401/402/403 默认删文件，可关） */
app.post('/api/cpa-auth/probe-batch', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      filenames?: string[];
      paths?: string[];
      concurrency?: number;
      deleteOnDead?: boolean;
    };
    res.json(await probeCpaAuthBatch(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/**
 * 手动重登激活：密码登录 → mint 覆盖 → 随机英文消息 → 二次测活。
 * 浏览器登录通常 30～120s，前端勿当「秒失败」。
 */
app.post('/api/cpa-auth/relogin', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      filename?: string;
      path?: string;
    };
    res.json(await reloginCpaAuth(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** 批量删除 CPA auth 文件 */
app.post('/api/cpa-auth/delete', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { filenames?: string[]; paths?: string[] };
    res.json(await deleteCpaAuthBatch(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** 读取 auth 文件内容（前端导出） */
app.post('/api/cpa-auth/export', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { filenames?: string[] };
    res.json(await readCpaAuthFiles(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

/** 从号池按 email 给 auth 回填顶层 sso（旧文件无 sso 时用于 hash 匹配） */
app.post('/api/cpa-auth/backfill-sso', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      filenames?: string[];
      force?: boolean;
      dryRun?: boolean;
    };
    res.json(await backfillCpaAuthSsoFromPool(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.get('/api/mail/code', async (req: Request, res: Response) => {
  const address = String(req.query.address || '').trim();
  if (!address) {
    res.status(400).json({ error: '缺少邮箱地址' });
    return;
  }
  const settings = await loadSettings();
  const result = await fetchLatestCodeByAddress(
    address,
    { apiBase: settings.mail.apiBase, adminAuth: settings.mail.adminAuth },
    resolveHttpProxy(settings)
  );
  res.json(result);
});

app.post('/api/sso/check', async (req: Request, res: Response) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) {
    res.status(400).json({ error: '缺少待验活的 sso 列表' });
    return;
  }
  const settings = await loadSettings();
  // 号池验活：受 ssoCheckUseProxy + 总开关控制（原先无条件用 settings.proxy）
  const proxy = resolveHttpProxy(settings, 'ssoCheck');

  // 限并发 5，避免对 grok 发起过多并发请求
  const CONCURRENCY = 5;
  const results: Array<{
    id: string;
    alive: boolean;
    status: number;
    checkedAt: string;
    email?: string;
    givenName?: string;
    familyName?: string;
    emailConfirmed?: boolean;
    sessionTierId?: string;
    createTime?: string;
    error?: string;
    botFlagSource?: number | string | null;
    isBotFlag1?: boolean;
  }> = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = items.slice(i, i + CONCURRENCY) as { id: string; sso: string }[];
    const settled = await Promise.all(
      batch.map(async (item) => {
        const outcome = await checkSso(item.sso, proxy);
        return { id: item.id, ...outcome, checkedAt: new Date().toISOString() };
      })
    );
    results.push(...settled);
  }
  // 落盘到号池 accounts.json，跨设备/清浏览器缓存仍可恢复；无邮箱时按验活结果补 email
  let emailsFilled = 0;
  try {
    const persisted = await applyAccountSsoChecks(results);
    emailsFilled = persisted.emailsFilled ?? 0;
  } catch (err) {
    console.warn('[sso/check] persist ssoCheck failed:', err);
  }
  res.json({ results, emailsFilled });
});

app.post('/api/verify-code', async (req, res) => {
  try {
    const jwt = req.body.jwt;
    if (!jwt) throw new Error("缺少 jwt");
    const settings = await loadSettings();
    if (!settings.mail?.apiBase) throw new Error("缺少邮箱后端地址配置");
    const emails = await fetchEmails(jwt, settings.mail.apiBase, 10);
    let code = null;
    for (const msg of emails) {
      if (msg && msg.raw) {
        code = extractVerificationCode(msg.raw);
        if (code) break;
      }
    }
    res.json({ code: code?.replace('-', '') || null });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});


app.post('/api/test/turnstile-solver', async (req, res) => {
  try {
    const settings = await loadSettings();
    const body = (req.body ?? {}) as {
      url?: string;
      enabled?: boolean;
    };
    const envOn = ['1', 'true', 'yes', 'on'].includes(
      String(process.env.TURNSTILE_SOLVER_ENABLED || '')
        .trim()
        .toLowerCase()
    );
    const enabled =
      body.enabled === true || settings.turnstileSolverEnabled === true || envOn;
    const url = String(
      body.url ||
        settings.turnstileSolverUrl ||
        process.env.TURNSTILE_SOLVER_URL ||
        'http://turnstile-solver:5072'
    )
      .trim()
      .replace(/\/+$/, '');
    if (!enabled) {
      return res.json({
        ok: false,
        message: '外置 Solver 未启用（设置页开关或 TURNSTILE_SOLVER_ENABLED）',
        url,
        enabled: false
      });
    }
    if (!url) {
      return res.json({ ok: false, message: '未配置 Solver URL', enabled: true });
    }
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url + '/', {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'text/html,application/json,*/*' }
      });
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const status = response.status;
      if (status >= 200 && status < 500) {
        return res.json({
          ok: true,
          message: `solver 可达 HTTP ${status}`,
          status,
          url,
          latencyMs: ms,
          enabled: true
        });
      }
      return res.json({
        ok: false,
        message: `HTTP ${status}`,
        status,
        url,
        latencyMs: ms,
        enabled: true
      });
    } catch (e: any) {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      return res.json({
        ok: false,
        message: `连接失败: ${e?.message || e}`,
        url,
        latencyMs: ms,
        enabled: true
      });
    }
  } catch (e: any) {
    return res.json({ ok: false, message: `检测异常: ${e?.message || e}` });
  }
});

app.post('/api/test/mail', async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      apiBase?: string;
      adminAuth?: string;
      domain?: string;
      provider?: string;
    };
    const provider = String(
      body.provider ||
        (req.body as { mailProvider?: string })?.mailProvider ||
        ''
    )
      .trim()
      .toLowerCase();
    let apiBase = String(body.apiBase || '')
      .trim()
      .replace(/\/+$/, '');
    const adminAuth = String(body.adminAuth || '').trim();
    if (!apiBase) {
      return res.json({ ok: false, message: '请先填写邮件后端地址' });
    }
    for (const suffix of ['/admin/new_address', '/admin', '/api/mails', '/api']) {
      if (apiBase.toLowerCase().endsWith(suffix)) {
        apiBase = apiBase.slice(0, -suffix.length).replace(/\/+$/, '');
      }
    }
    const started = Date.now();
    const settings = await loadSettings();
    const proxy = resolveHttpProxy(settings);

    // ---- YYDS Mail：X-API-Key + /v1/accounts ----
    if (provider === 'yyds' || provider === 'yydsmail') {
      // 去掉误粘贴的 Bearer 前缀（YYDS 只认 X-API-Key）
      let yydsKey = adminAuth;
      if (yydsKey.length >= 7 && yydsKey.slice(0, 7).toLowerCase() === 'bearer ') {
        yydsKey = yydsKey.slice(7).trim();
      }
      if (!yydsKey) {
        return res.json({ ok: false, message: '请先填写 YYDS API Key（X-API-Key）' });
      }
      let base = apiBase;
      try {
        const u = new URL(base.includes('://') ? base : `https://${base}`);
        const p = (u.pathname || '').replace(/\/+$/, '');
        if (!p || p === '/') base = `${u.origin}/v1`;
        else if (u.host.endsWith('215.im') && !p.includes('/v1')) base = `${u.origin}/v1`;
        else base = `${u.origin}${p}`;
      } catch {
        /* keep */
      }
      base = base.replace(/\/+$/, '');
      const url = `${base}/accounts`;
      try {
        const resp = await requestWithProxyFallback(url, {
          method: 'POST',
          headers: {
            'X-API-Key': yydsKey,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: { localPart: `probe${Date.now().toString(36).slice(-6)}` },
          proxy,
          timeoutMs: 15000
        });
        const ms = Date.now() - started;
        const raw =
          typeof resp.data === 'string'
            ? resp.data
            : resp.data != null
              ? JSON.stringify(resp.data)
              : '';
        // 业务信封 success:false（即使 HTTP 2xx）
        const biz =
          resp.data && typeof resp.data === 'object'
            ? (resp.data as { success?: unknown; error?: unknown; errorCode?: unknown })
            : null;
        if (biz && biz.success === false) {
          const code = String(biz.errorCode || '');
          const err = String(biz.error || '').slice(0, 120);
          const hint =
            code.includes('web_app_only') || raw.includes('web_app_only')
              ? '未识别 API Key（请填控制台 X-API-Key，不要带 Bearer 前缀）'
              : err || '业务拒绝';
          return res.json({
            ok: false,
            message: `已连上 ${base}，但 ${hint}（HTTP ${resp.status}${resp.via === 'proxy' ? ' · 经代理' : ''}）`,
            ms,
            status: resp.status
          });
        }
        if (resp.status >= 200 && resp.status < 300) {
          return res.json({
            ok: true,
            message: `YYDS Mail 连通（API Key 可用${resp.via === 'proxy' ? ' · 经代理' : ''}）`,
            ms,
            status: resp.status
          });
        }
        if (looksLikeCloudflareChallenge(resp.status, resp.data)) {
          return res.json({
            ok: false,
            message:
              `已到 ${base}，但被 Cloudflare 挑战拦截（HTTP ${resp.status}）。` +
              (proxy
                ? ' 直连与代理均未绕过，请检查 Sing-Box 节点是否可用。'
                : ' 请开启代理模式（Sing-Box）后重试，机房 IP 常被拦。'),
            ms,
            status: resp.status
          });
        }
        if (resp.status === 401 || resp.status === 403) {
          const hint = raw.includes('web_app_only')
            ? '未识别 API Key（请填控制台 X-API-Key，不要带 Bearer 前缀）'
            : 'API Key 被拒或无权创建临时邮箱';
          return res.json({
            ok: false,
            message: `已连上 ${base}，但 ${hint}（HTTP ${resp.status}${resp.via === 'proxy' ? ' · 经代理' : ''}）`,
            ms,
            status: resp.status
          });
        }
        return res.json({
          ok: false,
          message: `HTTP ${resp.status}${raw ? `: ${raw.slice(0, 120)}` : ''}`,
          ms,
          status: resp.status
        });
      } catch (e: any) {
        return res.json({
          ok: false,
          message: `连接失败: ${errorMessage(e)}`,
          ms: Date.now() - started
        });
      }
    }

    // ---- GPTMail：X-API-Key + /api/generate-email | /api/emails ----
    if (
      provider === 'gptmail' ||
      provider === 'gpt' ||
      provider === 'chatgpt_mail' ||
      provider === 'chatgpt-mail'
    ) {
      let gptKey = adminAuth;
      if (gptKey.length >= 7 && gptKey.slice(0, 7).toLowerCase() === 'bearer ') {
        gptKey = gptKey.slice(7).trim();
      }
      if (!gptKey) {
        return res.json({ ok: false, message: '请先填写 GPTMail API Key（X-API-Key）' });
      }
      let base = apiBase;
      try {
        const u = new URL(base.includes('://') ? base : `https://${base}`);
        const p = (u.pathname || '').replace(/\/+$/, '');
        if (!p || p === '/' || p === '/api' || p.startsWith('/api/')) {
          base = u.origin;
        } else {
          base = `${u.origin}${p}`;
        }
      } catch {
        /* keep */
      }
      base = base.replace(/\/+$/, '');
      const url = `${base}/api/stats`;
      try {
        const resp = await requestWithProxyFallback(url, {
          method: 'GET',
          headers: {
            'X-API-Key': gptKey,
            Accept: 'application/json'
          },
          proxy,
          timeoutMs: 15000
        });
        const ms = Date.now() - started;
        const raw =
          typeof resp.data === 'string'
            ? resp.data
            : resp.data != null
              ? JSON.stringify(resp.data)
              : '';
        const biz =
          resp.data && typeof resp.data === 'object'
            ? (resp.data as { success?: unknown; error?: unknown })
            : null;
        if (biz && biz.success === false) {
          return res.json({
            ok: false,
            message: `已连上 ${base}，但 ${String(biz.error || '业务拒绝').slice(0, 120)}（HTTP ${resp.status}${resp.via === 'proxy' ? ' · 经代理' : ''}）`,
            ms,
            status: resp.status
          });
        }
        if (resp.status >= 200 && resp.status < 300) {
          return res.json({
            ok: true,
            message: `GPTMail 连通（API Key 可用${resp.via === 'proxy' ? ' · 经代理' : ''}）`,
            ms,
            status: resp.status
          });
        }
        if (looksLikeCloudflareChallenge(resp.status, resp.data)) {
          return res.json({
            ok: false,
            message:
              `已到 ${base}，但被 Cloudflare 挑战拦截（HTTP ${resp.status}）。` +
              (proxy
                ? ' 直连与代理均未绕过，请检查 Sing-Box 节点。'
                : ' 请开启代理模式（Sing-Box）后重试。'),
            ms,
            status: resp.status
          });
        }
        if (resp.status === 401 || resp.status === 403) {
          return res.json({
            ok: false,
            message: `已连上 ${base}，但 API Key 被拒（HTTP ${resp.status}）。请确认 X-API-Key 正确。`,
            ms,
            status: resp.status
          });
        }
        return res.json({
          ok: false,
          message: `HTTP ${resp.status}${raw ? `: ${raw.slice(0, 120)}` : ''}`,
          ms,
          status: resp.status
        });
      } catch (e: any) {
        return res.json({
          ok: false,
          message: `连接失败: ${errorMessage(e)}`,
          ms: Date.now() - started
        });
      }
    }

    // ---- DuckMail（mail.tm）：GET /domains ----
    if (provider === 'duckmail' || provider === 'duck') {
      const url = `${apiBase}/domains`;
      try {
        const resp = await requestWithProxyFallback(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...(adminAuth ? { Authorization: `Bearer ${adminAuth}` } : {})
          },
          proxy,
          timeoutMs: 12000
        });
        const ms = Date.now() - started;
        if (resp.status >= 200 && resp.status < 300) {
          return res.json({
            ok: true,
            message: `DuckMail 连通（/domains 可用${resp.via === 'proxy' ? ' · 经代理' : ''}）`,
            ms,
            status: resp.status
          });
        }
        return res.json({
          ok: false,
          message: `HTTP ${resp.status}：请确认地址为 API 根（如 https://api.duckmail.sbs）`,
          ms,
          status: resp.status
        });
      } catch (e: any) {
        return res.json({
          ok: false,
          message: `连接失败: ${errorMessage(e)}`,
          ms: Date.now() - started
        });
      }
    }

    // ---- Cloudflare Temp Email ----
    // 旧版：直连 GET /api/mails，200/401 即通。
    // 管理模式优先探 /admin/new_address（x-admin-auth），避免误用 Bearer 导致假失败。
    const authMode = String(
      (settings as { cloudflareAuthMode?: string }).cloudflareAuthMode || 'x-admin-auth'
    )
      .trim()
      .toLowerCase();
    const isNone = authMode === 'none' || authMode === 'anonymous' || authMode === 'anon';

    try {
      // 1) 轻量探活：GET /api/mails（与历史版本一致；不强制代理）
      const mailsUrl = `${apiBase}/api/mails?limit=1`;
      const mailHeaders: Record<string, string> = { Accept: 'application/json' };
      if (adminAuth && (authMode === 'bearer' || authMode === 'authorization')) {
        mailHeaders.Authorization = `Bearer ${adminAuth}`;
      }
      if (adminAuth && (authMode === 'x-api-key' || authMode === 'apikey' || authMode === 'api-key')) {
        mailHeaders['X-API-Key'] = adminAuth;
      }
      const resp = await requestWithProxyFallback(mailsUrl, {
        method: 'GET',
        headers: mailHeaders,
        proxy,
        timeoutMs: 12000
      });
      const ms = Date.now() - started;
      if (resp.status === 401 || resp.status === 200 || resp.status === 403) {
        return res.json({
          ok: true,
          message: `邮箱服务器连接成功${resp.via === 'proxy' ? '（直连失败已走代理）' : ''}`,
          ms,
          status: resp.status
        });
      }
      if (resp.status === 404 || resp.status === 405) {
        return res.json({
          ok: false,
          message: `HTTP ${resp.status}：请填 Worker API 根地址（勿填前端 Pages）`,
          ms,
          status: resp.status
        });
      }

      // 2) 管理模式补探 admin 路径（部分部署 /api/mails 未开放）
      if (!isNone && adminAuth) {
        const adminUrl = `${apiBase}/admin/new_address`;
        const adminResp = await requestWithProxyFallback(adminUrl, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'x-admin-auth': adminAuth
          },
          body: {
            name: `probe${Date.now().toString(36).slice(-6)}`,
            enablePrefix: false
          },
          proxy,
          timeoutMs: 12000
        });
        const ms2 = Date.now() - started;
        // 401/403=鉴权到达服务；400/409=参数/冲突也说明路由可用
        if (
          adminResp.status === 200 ||
          adminResp.status === 201 ||
          adminResp.status === 400 ||
          adminResp.status === 401 ||
          adminResp.status === 403 ||
          adminResp.status === 409
        ) {
          return res.json({
            ok: true,
            message: `邮箱 Admin API 可达（HTTP ${adminResp.status}${
              adminResp.via === 'proxy' ? ' · 经代理' : ''
            }）`,
            ms: ms2,
            status: adminResp.status
          });
        }
      }

      return res.json({
        ok: false,
        message: `服务器返回了异常状态码: ${resp.status}`,
        ms,
        status: resp.status
      });
    } catch (e: any) {
      return res.json({
        ok: false,
        message: `连接失败: ${errorMessage(e)}${
          proxy ? '（若开了 Sing-Box，可先关代理再测 CF Worker）' : ''
        }`,
        ms: Date.now() - started
      });
    }
  } catch (e: any) {
    return res.json({ ok: false, message: `连接失败: ${errorMessage(e)}` });
  }
});

/** 远程 CPA Management API 连通性检测（不上传文件） */
app.post('/api/test/cpa-remote', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { url?: string; key?: string };
    const result = await testCpaRemoteConnectivity(body);
    return res.json(result);
  } catch (e: any) {
    return res.json({ ok: false, message: `检测异常: ${e?.message || e}` });
  }
});

/** 远程 sub2api Admin API 连通性检测（不上传账号） */
app.post('/api/test/sub2api-remote', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { url?: string; token?: string };
    const result = await testSub2apiRemoteConnectivity(body);
    return res.json(result);
  } catch (e: any) {
    return res.json({ ok: false, message: `检测异常: ${e?.message || e}` });
  }
});

/** 远程 grok2api 管理登录连通性（不上传账号） */
app.post('/api/test/grok2api-remote', async (req, res) => {
  try {
    const settings = await loadSettings();
    const body = (req.body ?? {}) as {
      url?: string;
      username?: string;
      password?: string;
    };
    let base = String(body.url ?? settings.grok2apiUrl ?? '')
      .trim()
      .replace(/\/+$/, '');
    const username = String(body.username ?? settings.grok2apiUsername ?? '').trim();
    const password = String(body.password ?? settings.grok2apiPassword ?? '').trim();
    if (!base) {
      return res.json({ ok: false, message: '请先填写 grok2api 地址' });
    }
    if (!username || !password) {
      return res.json({ ok: false, message: '请先填写 grok2api 用户名和密码' });
    }
    // 规范化：去掉误粘贴的管理路径
    for (const suffix of [
      '/api/admin/v1/auth/login',
      '/api/admin/v1',
      '/api/admin',
      '/admin'
    ]) {
      if (base.toLowerCase().endsWith(suffix)) {
        base = base.slice(0, -suffix.length).replace(/\/+$/, '');
      }
    }
    const loginUrl = `${base}/api/admin/v1/auth/login`;
    const started = Date.now();
    const proxy = resolveHttpProxy(settings);
    try {
      // 自建 grok2api 常在内网：代理失败（ECONNRESET）时自动直连
      const resp = await requestWithProxyFallback(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: { username, password },
        proxy,
        timeoutMs: 15000
      });
      const ms = Date.now() - started;
      const viaHint =
        resp.via === 'proxy' ? '（直连失败，已改走代理）' : '';
      if (resp.status >= 200 && resp.status < 300) {
        const data = resp.data as Record<string, unknown> | null;
        const nested =
          data && typeof data === 'object'
            ? ((data.data as Record<string, unknown> | undefined) ?? data)
            : null;
        const tokens =
          nested && typeof nested === 'object'
            ? (nested.tokens as Record<string, unknown> | undefined)
            : undefined;
        const token =
          (tokens && (tokens.accessToken || tokens.access_token)) ||
          (nested && (nested.accessToken || nested.access_token || nested.token));
        if (token) {
          return res.json({
            ok: true,
            message: `grok2api 管理登录成功${viaHint}`,
            ms,
            latencyMs: ms,
            status: resp.status,
            remoteUrl: base
          });
        }
        return res.json({
          ok: true,
          message: `已连通（HTTP ${resp.status}，响应无 accessToken 字段，请确认管理 API 版本）${viaHint}`,
          ms,
          latencyMs: ms,
          status: resp.status,
          remoteUrl: base
        });
      }
      if (resp.status === 401 || resp.status === 403) {
        return res.json({
          ok: false,
          message: `已连上 ${base}，但账号密码被拒（HTTP ${resp.status}）${viaHint}`,
          ms,
          latencyMs: ms,
          status: resp.status,
          remoteUrl: base
        });
      }
      if (resp.status === 404) {
        return res.json({
          ok: false,
          message: 'HTTP 404：请确认地址为 grok2api 根路径（不要带 /api/admin 等多余 path）',
          ms,
          latencyMs: ms,
          status: 404,
          remoteUrl: base
        });
      }
      const bodyText =
        typeof resp.data === 'string'
          ? resp.data
          : resp.data != null
            ? JSON.stringify(resp.data)
            : '';
      return res.json({
        ok: false,
        message: `HTTP ${resp.status}${bodyText ? `: ${bodyText.slice(0, 120)}` : ''}${viaHint}`,
        ms,
        latencyMs: ms,
        status: resp.status,
        remoteUrl: base
      });
    } catch (e: any) {
      const msg = errorMessage(e);
      const hint = /ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg)
        ? '。常见原因：地址不可达、TLS 中断、或 Sing-Box 代理干扰（可先关代理直连自建地址）'
        : '';
      return res.json({
        ok: false,
        message: `检测异常: ${msg}${hint}`,
        ms: Date.now() - started,
        remoteUrl: base
      });
    }
  } catch (e: any) {
    return res.json({ ok: false, message: `检测异常: ${errorMessage(e)}` });
  }
});

/** 代理池单条测活 */
app.post('/api/test/proxy', async (req, res) => {
  try {
    const proxy = String(req.body?.proxy || req.body?.url || '').trim();
    if (!proxy) {
      return res.json({ ok: false, message: '缺少 proxy 参数' });
    }
    const result = await probeProxy(proxy);
    return res.json(result);
  } catch (e: any) {
    return res.json({ ok: false, message: `测活异常: ${e?.message || e}` });
  }
});

/**
 * 已废弃：无代理池后不再写成功计数。保留路由避免旧客户端 404。
 */
app.post('/api/proxy/register-success', async (_req: Request, res: Response) => {
  res.json({ ok: true, bumped: 0, message: 'disabled (no proxy pool)' });
});

/**
 * 注册失败降级：从「可用池」移到「待定池」。
 * body: { proxies: string[] | string, reason?: string }
 * 供 Python 注册机在页面不可达等场景回调（已取消出口 IP 检测）。
 */
app.post('/api/proxy/demote', async (req: Request, res: Response) => {
  try {
    const settings = await loadSettings();
    const raw = req.body?.proxies ?? req.body?.proxy ?? [];
    const list: string[] = Array.isArray(raw)
      ? raw.map((x: unknown) => String(x || '').trim()).filter(Boolean)
      : String(raw || '')
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean);
    if (list.length === 0) {
      res.status(400).json({ ok: false, moved: 0, message: 'proxies 为空' });
      return;
    }
    const reason = String(req.body?.reason || '注册失败').trim() || '注册失败';
    const { proxyPool, proxyPoolAlive, moved } = moveProxiesFromAliveToPending(
      settings.proxyPool || '',
      settings.proxyPoolAlive || '',
      list,
      reason
    );
    if (moved > 0) {
      await saveSettings({ ...settings, proxyPool, proxyPoolAlive });
    }
    res.json({
      ok: true,
      moved,
      pendingCount: proxyPool
        .split(/\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')).length,
      aliveCount: proxyPoolAlive
        .split(/\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#')).length,
      message:
        moved > 0
          ? `已降级 ${moved} 条 → 待定池（${reason}）`
          : '未匹配到可用池中的代理（可能已降级或不在可用池）'
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, moved: 0, message });
  }
});

/**
 * 从网页拉取代理列表（hide.mn 表格 / 纯文本 ip:port 等）。
 * viaProxy=true 时用当前配置的 HTTP 代理出站（被墙时）。
 * pages：hide.mn 翻页数（1–20，默认 1）。
 */
app.post('/api/proxy/fetch', async (req: Request, res: Response) => {
  try {
    const settings = await loadSettings();
    const url = String(
      req.body?.url || settings.proxyFetchUrl || 'https://hide.mn/en/proxy-list/'
    ).trim();
    const useVia =
      req.body?.viaProxy === true ||
      req.body?.viaProxy === '1' ||
      req.body?.viaProxy === 1;
    // 拉列表：仅看总开关 + 单条 proxy（不绑 sso/cpa 用途）
    const viaProxy = useVia ? resolveHttpProxy(settings) : '';
    let pages = Number(req.body?.pages);
    if (!Number.isFinite(pages) || pages < 1) pages = 1;
    pages = Math.min(Math.floor(pages), 20);
    const result = await fetchProxiesFromUrl({ url, viaProxy, pages });
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({
      ok: false,
      url: '',
      lines: [],
      count: 0,
      format: 'error',
      message,
      sample: []
    });
  }
});

/** 代理池批量并发测活（单次建议 ≤48 条；大批量由前端分块，避免 CF 524） */
app.post('/api/test/proxy-batch', async (req, res) => {
  // 防止反代/客户端过早断开时 Node 仍傻等
  req.setTimeout(90_000);
  res.setTimeout(90_000);
  try {
    const raw = req.body?.proxies;
    const proxies = Array.isArray(raw)
      ? raw.map((x: unknown) => String(x || '').trim()).filter(Boolean)
      : [];
    if (proxies.length === 0) {
      return res.json({
        total: 0,
        ok: 0,
        fail: 0,
        concurrency: 0,
        timeoutMs: 0,
        results: [],
        message: 'proxies 为空'
      });
    }
    const concurrency = Number(req.body?.concurrency);
    const timeoutMs = Number(req.body?.timeoutMs);
    const result = await probeProxyBatch(
      proxies,
      Number.isFinite(concurrency) ? concurrency : 8,
      Number.isFinite(timeoutMs) ? timeoutMs : 6000
    );
    return res.json(result);
  } catch (e: any) {
    return res.status(500).json({
      total: 0,
      ok: 0,
      fail: 0,
      concurrency: 0,
      timeoutMs: 0,
      results: [],
      message: `批量测活异常: ${e?.message || e}`
    });
  }
});

if (existsSync(STATIC_ROOT)) {
  app.use(express.static(STATIC_ROOT, { index: 'index.html' }));
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(join(STATIC_ROOT, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .status(503)
      .type('text/plain')
      .send(
        `Web UI not built.\nRun \`npm run server:build\` to produce ${STATIC_ROOT}.\nAPI is still online at /api.`
      );
  });
}

const httpServer = createServer(app);
const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

function sendEvent(ws: WebSocket, event: RunEvent) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(event));
}

function broadcast(event: RunEvent) {
  for (const ws of clients) {
    sendEvent(ws, event);
  }
}

// 供 cpaAuthStore 等模块推送重登进度等非注册机事件
setAppEventBroadcast(broadcast);

registerBot.on('event', (event: RunEvent) => {
  broadcast(event);
});

wss.on('connection', (ws) => {
  clients.add(ws);
  for (const event of registerBot.getReplay()) {
    sendEvent(ws, event);
  }
  ws.on('close', () => {
    clients.delete(ws);
  });
});

httpServer.on('upgrade', async (request, socket, head) => {
  const pathname = (() => {
    try {
      return new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
      return '/';
    }
  })();

  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const state = await getAuthStateFromCookie(request.headers.cookie);
  if (!state.authenticated) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[Grok Register Agent] listening on http://${HOST}:${PORT}`);
  console.log(`[Grok Register Agent] data dir: ${dataDir()}`);
  console.log(
    `[Grok Register Agent] static UI: ${existsSync(STATIC_ROOT) ? STATIC_ROOT : '(not built)'}`
  );
  void authBootstrapInfo().then((info) => {
    console.log(`[Grok Register Agent] default account: ${info.defaultUsername}`);
    console.log(`[Grok Register Agent] default password: ${info.defaultPassword}`);
    if (info.mustChangePassword) {
      console.log('[Grok Register Agent] first login must change username/password');
    } else {
      console.log(`[Grok Register Agent] web account configured: ${info.username}`);
    }
  });
  // 启动时同步 sing-box，并停止遗留 cfwp
  void loadSettings()
    .then(async (s) => {
      try {
        await stopCfwp();
      } catch {
        /* ignore */
      }
      return syncSingBoxFromSettings(s);
    })
    .then((sb) => {
      if (sb.running || sb.lastError || sb.nodeCount > 0) {
        console.log(
          `[Grok Register Agent] sing-box: ${sb.running ? 'running' : 'stopped'} ` +
            `port=${sb.port} nodes=${sb.nodeCount} binary=${sb.binaryExists ? 'ok' : 'missing'}` +
            (sb.lastError ? ` err=${sb.lastError}` : '')
        );
      }
    })
    .catch((err) => console.error('[Grok Register Agent] proxy boot sync failed', err));
});

function sLikeEnabled(st: { domain?: string; running?: boolean; lastError?: string | null }) {
  return !!(st.domain || st.running || st.lastError);
}

async function buildSystemHealth(): Promise<SystemHealth> {
  const checks: SystemHealthCheck[] = [];
  const pushCheck = (check: SystemHealthCheck) => checks.push(check);

  pushCheck(await checkRegisterScript());
  pushCheck(await checkDataDirWritable());

  const summary = checks.reduce(
    (acc, check) => {
      acc[check.level] += 1;
      acc.total += 1;
      return acc;
    },
    { ok: 0, warn: 0, error: 0, total: 0 }
  );

  return {
    checkedAt: new Date().toISOString(),
    summary,
    checks
  };
}

async function checkRegisterScript(): Promise<SystemHealthCheck> {
  const settings = await loadSettings();
  const registerDir = registerBot.resolveRegisterDir(settings.registerDir);
  const scriptPath = registerDir ? join(registerDir, 'runner.py') : '';
  const legacyScriptPath = registerDir ? join(registerDir, 'DrissionPage_example.py') : '';
  if ((scriptPath && existsSync(scriptPath)) || (legacyScriptPath && existsSync(legacyScriptPath))) {
    return {
      id: 'register-script',
      label: 'Python 注册机',
      level: 'ok',
      message: '注册脚本已就绪',
      detail: existsSync(scriptPath) ? scriptPath : legacyScriptPath
    };
  }
  return {
    id: 'register-script',
    label: 'Python 注册机',
    level: 'warn',
    message: '未找到内置注册脚本，请检查镜像或项目 register/ 目录',
    detail: settings.registerDir || process.env.REGISTER_DIR || '(未配置 registerDir)'
  };
}

async function checkDataDirWritable(): Promise<SystemHealthCheck> {
  const targetDir = dataDir();
  const probeFile = join(targetDir, `.health-${Date.now()}.tmp`);
  try {
    await fsp.mkdir(targetDir, { recursive: true });
    await fsp.writeFile(probeFile, 'ok', 'utf-8');
    await fsp.unlink(probeFile);
    return {
      id: 'data-dir',
      label: '数据目录',
      level: 'ok',
      message: '数据目录可写',
      detail: targetDir
    };
  } catch (err) {
    return {
      id: 'data-dir',
      label: '数据目录',
      level: 'error',
      message: '数据目录不可写',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

async function shutdown(sig: string) {
  console.log(`[Grok Register Agent] received ${sig}, stopping...`);
  await registerBot.stop().catch(() => undefined);
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
