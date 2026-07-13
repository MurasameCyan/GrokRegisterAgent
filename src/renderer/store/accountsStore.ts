import { create } from 'zustand';
import type { AccountRecord } from '@shared/runEvents';

interface AccountsState {
  accounts: AccountRecord[];
  loading: boolean;
  reload(): Promise<void>;
  /** 主动扫描 SSO 历史文件后再列表 */
  resync(): Promise<{ total: number; imported: number }>;
  applyAccount(record: AccountRecord): void;
}

export const useAccountsStore = create<AccountsState>((set) => ({
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
  applyAccount: (record) =>
    set((state) => {
      if (state.accounts.some((a) => a.id === record.id)) return state;
      if (record.sso && state.accounts.some((a) => a.sso && a.sso === record.sso)) return state;
      return { accounts: [record, ...state.accounts] };
    })
}));
