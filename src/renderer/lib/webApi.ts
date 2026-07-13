import type { RendererApi } from '@shared/ipc';
import type { ThemeMode } from '@shared/settings';
import type { RunEvent, TestResult } from '@shared/runEvents';

function buildHeaders(body?: unknown): HeadersInit {
  return {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
  };
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: buildHeaders(body),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
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
  stopRegister: async (runId) => {
    await http('POST', '/api/run/stop', { runId });
    return { ok: true };
  },
  getStatus: () => http('GET', '/api/run/status'),
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

  getMailCode: (address) =>
    http('GET', `/api/mail/code?address=${encodeURIComponent(address)}`),
  checkSso: (items) =>
    http<{ results: import('@shared/ipc').SsoCheckResult[] }>('POST', '/api/sso/check', {
      items
    }).then((r) => r.results),

  listCpaAuth: () => http('GET', '/api/cpa-auth'),
  resignCpaAuth: (input) => http('POST', '/api/cpa-auth/resign', input),
  resignCpaAuthBatch: (input) => http('POST', '/api/cpa-auth/resign-batch', input),
  mintCpaAuthFromSso: (input) => http('POST', '/api/cpa-auth/mint', input),
  probeCpaAuthBatch: (input) => http('POST', '/api/cpa-auth/probe-batch', input),

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

  getSystemHealth: () => http('GET', '/api/system/health'),
  checkUpdate: () => http('GET', '/api/system/update-check')
};

export function installWebApiIfNeeded() {
  if (typeof window === 'undefined') return;
  if ((window as Window & { api?: RendererApi }).api) return;
  (window as Window & { api: RendererApi }).api = webApi;
}
