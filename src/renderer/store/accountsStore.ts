import { create } from 'zustand';
import type { AccountRecord } from '@shared/runEvents';

interface AccountsState {
  accounts: AccountRecord[];
  loading: boolean;
  reload(): Promise<void>;
  /** 主动扫描 SSO 历史文件后再列表 */
  resync(): Promise<{ total: number; imported: number }>;
  /** 按 id 批量删除号池账号 */
  remove(ids: string[]): Promise<{ deleted: number; remaining: number }>;
  /** 文本导入 SSO */
  importText(text: string, source?: string): Promise<{
    totalLines: number;
    parsed: number;
    imported: number;
    skipped: number;
    invalid: number;
    remaining: number;
  }>;
  applyAccount(record: AccountRecord): void;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  loading: false,
  reload: async () => {
    set({ loading: true });
    try {
      // listAccounts 服务端会自动迁移旧库 + 从 sso 目录补缺
      const accounts = await window.api.listAccounts();
      set({ accounts, loading: false });
    } catch {
      set({ loading: false });
    }
  },
  resync: async () => {
    set({ loading: true });
    try {
      const result = await window.api.resyncAccounts();
      const accounts = await window.api.listAccounts();
      set({ accounts, loading: false });
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
    set((state) => ({
      accounts: state.accounts.filter((a) => !drop.has(a.id))
    }));
    // 与服务端对齐
    try {
      const accounts = await window.api.listAccounts();
      set({ accounts });
    } catch {
      /* keep local filter */
    }
    return { deleted: r.deleted, remaining: r.remaining };
  },
  importText: async (text, source) => {
    const r = await window.api.importAccounts({ text, source });
    try {
      const accounts = await window.api.listAccounts();
      set({ accounts });
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
    })
}));
