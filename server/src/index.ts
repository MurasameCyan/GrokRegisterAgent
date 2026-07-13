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
import { listAccounts, resyncAccountsFromDisk } from './accountStore.js';
import { checkForUpdate, currentVersion } from './updateCheck.js';
import { fetchEmails, extractVerificationCode, fetchLatestCodeByAddress } from './api/emailApi.js';
import { checkSso } from './ssoCheck.js';
import {
  authBootstrapInfo,
  changeCredentials,
  getAuthState,
  getAuthStateFromCookie,
  login,
  logout
} from './authStore.js';

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

app.post('/api/run/start', async (req: Request, res: Response) => {
  try {
    const args = (req.body ?? {}) as RegisterStartArgs;
    res.json(await registerBot.start({ runCountOverride: args.runCount }));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/run/stop', async (_req, res) => {
  await registerBot.stop();
  res.json({ ok: true });
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
  console.log(`[Grok Agent] listening on http://${HOST}:${PORT}`);
  console.log(`[Grok Agent] data dir: ${dataDir()}`);
  console.log(
    `[Grok Agent] static UI: ${existsSync(STATIC_ROOT) ? STATIC_ROOT : '(not built)'}`
  );
  void authBootstrapInfo().then((info) => {
    console.log(`[Grok Agent] default account: ${info.defaultUsername}`);
    console.log(`[Grok Agent] default password: ${info.defaultPassword}`);
    if (info.mustChangePassword) {
      console.log('[Grok Agent] first login must change username/password');
    } else {
      console.log(`[Grok Agent] web account configured: ${info.username}`);
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
  console.log(`[Grok Agent] received ${sig}, stopping...`);
  await registerBot.stop().catch(() => undefined);
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
