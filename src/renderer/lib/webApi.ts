import type { RendererApi } from '@shared/ipc';
import type { ThemeMode } from '@shared/settings';
import type { RunEvent, TestResult } from '@shared/runEvents';

function buildHeaders(body?: unknown): HeadersInit {
  return {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
  };
}

/** 批量任务取消：Auth 等页在批次期间挂上 AbortSignal，结束后务必 clear */
let activeAbortSignal: AbortSignal | null = null;

export function setWebApiAbortSignal(signal: AbortSignal | null): void {
  activeAbortSignal = signal;
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  // 已 abort 的 signal 勿再挂上，否则设置页测活等会整批“秒失败”
  const signal =
    activeAbortSignal && !activeAbortSignal.aborted ? activeAbortSignal : undefined;
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: buildHeaders(body),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    // Cloudflare 524 等会返回整页 HTML，避免把巨型 body 塞进 Error
    if (res.status === 524) {
      throw new Error(
        `${method} ${path} → HTTP 524 源站超时（测活块过大或过慢；已请用分块测活）`
      );
    }
    if (detail.length > 240 || /<!DOCTYPE html/i.test(detail)) {
      detail = detail.replace(/\s+/g, ' ').slice(0, 180) + '…';
    }
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
const listeners = new Set<(event: RunEvent) => void>();

function emit(event: RunEvent) {
  for (const listener of listeners) {
    listener(event);
  }
}

function clearReconnectTimer() {
  if (reconnectTimer != null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function connectWs() {
  if (typeof window === 'undefined' || ws || listeners.size === 0) return;
  const url = new URL('/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  ws = new WebSocket(url.toString());
  ws.onmessage = (message) => {
    try {
      emit(JSON.parse(String(message.data)) as RunEvent);
    } catch {
      /* ignore malformed frames */
    }
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    ws = null;
    if (listeners.size > 0) {
      clearReconnectTimer();
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectWs();
      }, 1500);
    }
  };
}

function maybeCloseWs() {
  if (listeners.size > 0) return;
  clearReconnectTimer();
  if (ws) {
    ws.close();
    ws = null;
  }
}

const webApi: RendererApi = {
  getAuthState: () => http('GET', '/api/auth/me'),
  login: (username, password) => http('POST', '/api/auth/login', { username, password }),
  logout: async () => {
    await http('POST', '/api/auth/logout');
    return { ok: true };
  },
  changeCredentials: (input) => http('POST', '/api/auth/change', input),

  getSettings: () => http('GET', '/api/settings'),
  saveSettings: async (s) => {
    await http('PUT', '/api/settings', s);
    return { ok: true };
  },

  startRegister: (args) => http('POST', '/api/run/start', args ?? {}),
  stopRegister: async (runId, opts) => {
    return http<{ ok: boolean; stopped?: string[] }>('POST', '/api/run/stop', {
      runId: runId || undefined,
      stopAll: opts?.stopAll === true
    });
  },
  getStatus: () => http('GET', '/api/run/status'),
  getAuthQueueMetrics: () =>
    http<{
      ok?: boolean;
      pending?: number;
      queue_size?: number;
      done_ok?: number;
      done_fail?: number;
      workers?: number;
      queue_max?: number;
      updated_at?: number;
      updated_iso?: string;
      stale?: boolean;
    }>('GET', '/api/auth-queue/metrics'),
  listRegisterJobs: () => http('GET', '/api/run/jobs'),
  getRegisterJobStatus: (runId) =>
    http('GET', `/api/run/jobs/${encodeURIComponent(runId)}`),
  focusRegisterJob: (runId) =>
    http('POST', '/api/run/focus', { runId }),
  clearFinishedRegisterJobs: () =>
    http<{ ok: true; removed: number; removedIds?: string[] }>(
      'POST',
      '/api/run/jobs/clear-finished'
    ),
  onRegisterEvent: (cb) => {
    listeners.add(cb);
    connectWs();
    return () => {
      listeners.delete(cb);
      maybeCloseWs();
    };
  },

  listAccounts: () => http('GET', '/api/accounts'),
  resyncAccounts: () =>
    http<{ total: number; imported: number }>('POST', '/api/accounts/resync'),
  deleteAccounts: (ids) =>
    http<{ deleted: number; requested: number; remaining: number }>(
      'POST',
      '/api/accounts/delete',
      { ids }
    ),
  importAccounts: (input) =>
    http<{
      totalLines: number;
      parsed: number;
      imported: number;
      skipped: number;
      invalid: number;
      remaining: number;
    }>('POST', '/api/accounts/import', input),

  getMailCode: (address) =>
    http('GET', `/api/mail/code?address=${encodeURIComponent(address)}`),
  checkSso: async (items) => {
    const r = await http<{
      results: import('@shared/ipc').SsoCheckResult[];
      emailsFilled?: number;
    }>('POST', '/api/sso/check', { items });
    const list = r.results || [];
    // 把 emailsFilled 挂到数组上，便于 toast（不破坏 map/filter）
    Object.defineProperty(list, 'emailsFilled', {
      value: r.emailsFilled ?? 0,
      enumerable: false,
      writable: false
    });
    return list as typeof list & { emailsFilled?: number };
  },
  pushSsoToGrok2api: (input) =>
    http('POST', '/api/accounts/push-grok2api', input),

  listCpaAuth: () => http('GET', '/api/cpa-auth'),
  resignCpaAuth: (input) => http('POST', '/api/cpa-auth/resign', input),
  resignCpaAuthBatch: (input) => http('POST', '/api/cpa-auth/resign-batch', input),
  mintCpaAuthFromSso: (input) => http('POST', '/api/cpa-auth/mint', input),
  probeCpaAuthBatch: (input) => http('POST', '/api/cpa-auth/probe-batch', input),
  reloginCpaAuth: (input) => http('POST', '/api/cpa-auth/relogin', input),
  pushCpaAuthRemote: (input) => http('POST', '/api/cpa-auth/push-remote', input),
  pushSub2apiAuthRemote: (input) => http('POST', '/api/cpa-auth/push-sub2api', input),
  deleteCpaAuth: (input) => http('POST', '/api/cpa-auth/delete', input),
  exportCpaAuth: (input) => http('POST', '/api/cpa-auth/export', input),
  backfillCpaAuthSso: (input) =>
    http('POST', '/api/cpa-auth/backfill-sso', input ?? {}),

  getTheme: async () => {
    const stored = (localStorage.getItem('theme') as ThemeMode | null) ?? 'system';
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = stored === 'system' ? (dark ? 'dark' : 'light') : stored;
    return { mode: stored, effective };
  },
  setTheme: async (mode) => {
    localStorage.setItem('theme', mode);
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const effective = mode === 'system' ? (dark ? 'dark' : 'light') : mode;
    return { mode, effective };
  },
  onThemeChanged: (cb) => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => {
      const stored = (localStorage.getItem('theme') as ThemeMode | null) ?? 'system';
      if (stored !== 'system') return;
      cb({ mode: 'system', effective: mq.matches ? 'dark' : 'light' });
    };
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  },

  testMail: (b) => http<TestResult>('POST', '/api/test/mail', b),
  testTurnstileSolver: (input) =>
    http<
      TestResult & {
        status?: number;
        url?: string;
        latencyMs?: number;
        enabled?: boolean;
      }
    >('POST', '/api/test/turnstile-solver', {
      url: input?.url,
      enabled: input?.enabled
    }),
  testCpaRemote: (input) =>
    http<TestResult & { status?: number; remoteUrl?: string }>('POST', '/api/test/cpa-remote', {
      url: input?.url,
      key: input?.key
    }),
  testSub2apiRemote: (input) =>
    http<TestResult & { status?: number; remoteUrl?: string }>('POST', '/api/test/sub2api-remote', {
      url: input?.url,
      token: input?.token
    }),
  testGrok2apiRemote: (input) =>
    http<TestResult & { status?: number; remoteUrl?: string; latencyMs?: number }>(
      'POST',
      '/api/test/grok2api-remote',
      {
        url: input?.url,
        username: input?.username,
        password: input?.password
      }
    ),
  testProxy: (proxy) =>
    http<TestResult & { exitIp?: string; latencyMs?: number }>('POST', '/api/test/proxy', {
      proxy
    }),
  fetchProxiesFromUrl: (input) =>
    http('POST', '/api/proxy/fetch', {
      url: input?.url,
      viaProxy: input?.viaProxy === true,
      pages: input?.pages
    }),
  testProxyBatch: (input) =>
    http('POST', '/api/test/proxy-batch', {
      proxies: input.proxies,
      concurrency: input.concurrency,
      timeoutMs: input.timeoutMs
    }),

  getCfProxyStatus: () => http('GET', '/api/cf-proxy/status'),
  startCfProxy: () => http('POST', '/api/cf-proxy/start'),
  stopCfProxy: () => http('POST', '/api/cf-proxy/stop'),
  syncCfProxy: () => http('POST', '/api/cf-proxy/sync'),
  getCfProxyLog: (tail = 200) =>
    http('GET', `/api/cf-proxy/log?tail=${encodeURIComponent(String(tail))}`),

  getSingBoxStatus: () => http('GET', '/api/singbox/status'),
  getSingBoxNodes: () => http('GET', '/api/singbox/nodes'),
  parseSingBoxNodes: (nodes: string) =>
    http('POST', '/api/singbox/parse', { nodes }),
  importSingBoxSubscription: (input) =>
    http('POST', '/api/singbox/subscription', {
      url: input?.url,
      mode: input?.mode,
      existing: input?.existing
    }),
  startSingBox: () => http('POST', '/api/singbox/start'),
  stopSingBox: () => http('POST', '/api/singbox/stop'),
  syncSingBox: () => http('POST', '/api/singbox/sync'),
  rotateSingBox: (reason?: string) =>
    http('POST', '/api/singbox/rotate', { reason: reason || 'manual' }),
  getSingBoxLog: (tail = 200) =>
    http('GET', `/api/singbox/log?tail=${encodeURIComponent(String(tail))}`),

  getSystemHealth: () => http('GET', '/api/system/health'),
  getSystemVersion: () =>
    http<{ current: string; buildId?: string; version?: string }>('GET', '/api/system/version'),
  checkUpdate: () => http('GET', '/api/system/update-check')
};

export function installWebApiIfNeeded() {
  if (typeof window === 'undefined') return;
  if ((window as Window & { api?: RendererApi }).api) return;
  (window as Window & { api: RendererApi }).api = webApi;
}
