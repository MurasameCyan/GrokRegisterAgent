import { create } from 'zustand';
import type { AccountRecord } from '@shared/runEvents';
import type { SsoCheckResult } from '@shared/ipc';

const SSO_CHECK_STORAGE_KEY = 'gra-pool-sso-check-v1';

function loadSsoMapFromStorage(): Map<string, SsoCheckResult> {
  try {
    const raw = localStorage.getItem(SSO_CHECK_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, SsoCheckResult>;
    if (!parsed || typeof parsed !== 'object') return new Map();
    const map = new Map<string, SsoCheckResult>();
    for (const [id, r] of Object.entries(parsed)) {
      if (!id || !r || typeof r !== 'object') continue;
      if (typeof r.alive !== 'boolean') continue;
      map.set(id, {
        id: String(r.id || id),
        alive: r.alive,
        status: typeof r.status === 'number' ? r.status : 0,
        email: r.email,
        givenName: r.givenName,
        familyName: r.familyName,
        emailConfirmed: r.emailConfirmed,
        sessionTierId: r.sessionTierId,
        createTime: r.createTime,
        checkedAt: typeof r.checkedAt === 'string' ? r.checkedAt : new Date().toISOString(),
        error: r.error,
        botFlagSource: r.botFlagSource,
        isBotFlag1: r.isBotFlag1
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

function persistSsoMap(map: Map<string, SsoCheckResult>) {
  try {
    const obj: Record<string, SsoCheckResult> = {};
    for (const [id, r] of map) {
      obj[id] = r;
    }
    localStorage.setItem(SSO_CHECK_STORAGE_KEY, JSON.stringify(obj));
  } catch {
    /* quota / private mode */
  }
}

/** 从账号记录上的 ssoCheck 字段构建结果（服务端落盘） */
function resultFromAccount(a: AccountRecord): SsoCheckResult | null {
  const c = a.ssoCheck;
  if (!c || typeof c.alive !== 'boolean') return null;
  return {
    id: a.id,
    alive: c.alive,
    status: typeof c.status === 'number' ? c.status : 0,
    email: c.email,
    givenName: c.givenName,
    familyName: c.familyName,
    emailConfirmed: c.emailConfirmed,
    sessionTierId: c.sessionTierId,
    createTime: c.createTime,
    checkedAt: typeof c.checkedAt === 'string' ? c.checkedAt : new Date().toISOString(),
    error: c.error,
    botFlagSource: c.botFlagSource,
    isBotFlag1: c.isBotFlag1
  };
}

/**
 * 合并本地缓存与服务端号池 ssoCheck：
 * - 同 id 取 checkedAt 更新的一方
 * - 服务端有而本地无 → 采用服务端
 * - 删除已不在号池的 id
 */
function mergeSsoMaps(
  local: Map<string, SsoCheckResult>,
  accounts: AccountRecord[]
): Map<string, SsoCheckResult> {
  const keep = new Set(accounts.map((a) => a.id));
  const next = new Map<string, SsoCheckResult>();

  for (const [id, r] of local) {
    if (keep.has(id)) next.set(id, r);
  }

  for (const a of accounts) {
    const fromServer = resultFromAccount(a);
    if (!fromServer) continue;
    const prev = next.get(a.id);
    if (!prev) {
      next.set(a.id, fromServer);
      continue;
    }
    const tPrev = Date.parse(prev.checkedAt || '') || 0;
    const tSrv = Date.parse(fromServer.checkedAt || '') || 0;
    if (tSrv >= tPrev) next.set(a.id, fromServer);
  }

  return next;
}

interface AccountsState {
  accounts: AccountRecord[];
  loading: boolean;
  /** 号池 SSO 验活结果（服务端 accounts.json + localStorage 双写） */
  ssoMap: Map<string, SsoCheckResult>;
  reload(): Promise<void>;
  /** 主动扫描 SSO 历史文件后再列表 */
  resync(): Promise<{ total: number; imported: number }>;
  /** 按 id 批量删除号池账号 */
  remove(ids: string[]): Promise<{ deleted: number; remaining: number }>;
  /** 文本导入 SSO */
  importText(
    text: string,
    source?: string
  ): Promise<{
    totalLines: number;
    parsed: number;
    imported: number;
    skipped: number;
    invalid: number;
    remaining: number;
  }>;
  applyAccount(record: AccountRecord): void;
  /** 合并验活结果并落盘本地缓存（服务端由 /api/sso/check 自行写库） */
  applySsoResults(results: SsoCheckResult[]): void;
  /** 删除账号时同步清理验活缓存 */
  pruneSsoMap(keepIds: Set<string>): void;
  clearSsoResults(): void;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  loading: false,
  ssoMap: loadSsoMapFromStorage(),

  reload: async () => {
    set({ loading: true });
    try {
      const accounts = await window.api.listAccounts();
      const ssoMap = mergeSsoMaps(get().ssoMap, accounts);
      persistSsoMap(ssoMap);
      set({ accounts, loading: false, ssoMap });
    } catch {
      set({ loading: false });
    }
  },

  resync: async () => {
    set({ loading: true });
    try {
      const result = await window.api.resyncAccounts();
      const accounts = await window.api.listAccounts();
      const ssoMap = mergeSsoMaps(get().ssoMap, accounts);
      persistSsoMap(ssoMap);
      set({ accounts, loading: false, ssoMap });
      return result;
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  remove: async (ids) => {
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
    if (list.length === 0) {
      return { deleted: 0, remaining: get().accounts.length };
    }
    const r = await window.api.deleteAccounts(list);
    const drop = new Set(list);
    const ssoMap = new Map(get().ssoMap);
    for (const id of drop) ssoMap.delete(id);
    persistSsoMap(ssoMap);
    set((state) => ({
      accounts: state.accounts.filter((a) => !drop.has(a.id)),
      ssoMap
    }));
    try {
      const accounts = await window.api.listAccounts();
      const merged = mergeSsoMaps(get().ssoMap, accounts);
      persistSsoMap(merged);
      set({ accounts, ssoMap: merged });
    } catch {
      /* keep local filter */
    }
    return { deleted: r.deleted, remaining: r.remaining };
  },

  importText: async (text, source) => {
    const r = await window.api.importAccounts({ text, source });
    try {
      const accounts = await window.api.listAccounts();
      const ssoMap = mergeSsoMaps(get().ssoMap, accounts);
      persistSsoMap(ssoMap);
      set({ accounts, ssoMap });
    } catch {
      /* ignore */
    }
    return r;
  },

  applyAccount: (record) =>
    set((state) => {
      if (state.accounts.some((a) => a.id === record.id)) return state;
      if (record.sso && state.accounts.some((a) => a.sso && a.sso === record.sso)) return state;
      return { accounts: [record, ...state.accounts] };
    }),

  applySsoResults: (results) => {
    if (!results?.length) return;
    const ssoMap = new Map(get().ssoMap);
    for (const r of results) {
      if (!r?.id) continue;
      ssoMap.set(r.id, r);
    }
    persistSsoMap(ssoMap);
    // 同步到内存中的 accounts[].ssoCheck，避免刷新前 UI 与列表不一致
    set((state) => ({
      ssoMap,
      accounts: state.accounts.map((a) => {
        const r = ssoMap.get(a.id);
        if (!r) return a;
        return {
          ...a,
          email:
            !String(a.email || '').trim() && r.email ? String(r.email) : a.email,
          ssoCheck: {
            alive: r.alive,
            status: r.status,
            checkedAt: r.checkedAt,
            email: r.email,
            givenName: r.givenName,
            familyName: r.familyName,
            emailConfirmed: r.emailConfirmed,
            sessionTierId: r.sessionTierId,
            createTime: r.createTime,
            error: r.error,
            botFlagSource: r.botFlagSource,
            isBotFlag1: r.isBotFlag1
          }
        };
      })
    }));
  },

  pruneSsoMap: (keepIds) => {
    const prev = get().ssoMap;
    let changed = false;
    const ssoMap = new Map(prev);
    for (const id of prev.keys()) {
      if (!keepIds.has(id)) {
        ssoMap.delete(id);
        changed = true;
      }
    }
    if (!changed) return;
    persistSsoMap(ssoMap);
    set({ ssoMap });
  },

  clearSsoResults: () => {
    persistSsoMap(new Map());
    set({ ssoMap: new Map() });
  }
}));
