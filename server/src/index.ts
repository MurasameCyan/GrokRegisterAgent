import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, promises as fsp } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';

import type { RegisterStartArgs, SystemHealth, SystemHealthCheck } from '@shared/ipc';
import type { AppSettings } from '@shared/settings';
import type { RunEvent } from '@shared/runEvents';
import { loadSettings, saveSettings, dataDir } from './settingsStore.js';
import { registerBot } from './bot/registerBot.js';
import {
  deleteAccounts,
  importAccountsFromText,
  listAccounts,
  resyncAccountsFromDisk
} from './accountStore.js';
import { checkForUpdate, currentVersion } from './updateCheck.js';
import { fetchEmails, extractVerificationCode, fetchLatestCodeByAddress } from './api/emailApi.js';
import { probeProxy, probeProxyBatch } from './api/proxyApi.js';
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
  deleteCpaAuthBatch,
  listCpaAuth,
  mintCpaAuthFromSso,
  probeCpaAuthBatch,
  readCpaAuthFiles,
  resignCpaAuth,
  resignCpaAuthBatch
} from './cpaAuthStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 6657);
const HOST = process.env.BIND_HOST || '0.0.0.0';
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
  res.json({ ok: true });
});

app.get('/api/system/health', async (_req, res) => {
  res.json(await buildSystemHealth());
});

app.get('/api/system/version', (_req, res) => {
  res.json({ current: currentVersion() });
});

app.get('/api/system/update-check', async (_req, res) => {
  res.json(await checkForUpdate());
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

/** CPA auth 文件列表（data/auth 或 settings.authDir） */
app.get('/api/cpa-auth', async (_req, res) => {
  try {
    res.json(await listCpaAuth());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

/** 重签单个 CPA auth（refresh 优先，失败可带 sso） */
app.post('/api/cpa-auth/resign', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { filename?: string; path?: string; sso?: string };
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
    };
    res.json(await resignCpaAuthBatch(body));
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
    settings.proxy
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
  const proxy = settings.proxy;

  // 限并发 5，避免对 grok 发起过多并发请求
  const CONCURRENCY = 5;
  const results: unknown[] = [];
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
  res.json({ results });
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

app.post('/api/test/mail', async (req, res) => {
  try {
    const { apiBase, adminAuth, domain } = req.body;
    if (!apiBase || !adminAuth || !domain) {
      return res.json({ ok: false, message: '缺少邮箱后端配置参数' });
    }
    
    const response = await fetch(`${apiBase}/api/mails?limit=1`, {
      method: 'GET'
    });
    
    if (response.status === 401 || response.status === 200) {
      return res.json({ ok: true, message: '邮箱服务器连接成功' });
    } else {
      return res.json({ ok: false, message: `服务器返回了异常状态码: ${response.status}` });
    }
  } catch (e: any) {
    return res.json({ ok: false, message: `连接失败: ${e.message}` });
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
});

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
