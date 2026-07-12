import { create } from 'zustand';
import type { AccountRecord } from '@shared/runEvents';

interface AccountsState {
  accounts: AccountRecord[];
  loading: boolean;
  reload(): Promise<void>;
  applyAccount(record: AccountRecord): void;
}

export const useAccountsStore = create<AccountsState>((set) => ({
  accounts: [],
  loading: false,
  reload: async () => {
    set({ loading: true });
    try {
      const accounts = await window.api.listAccounts();
      set({ accounts, loading: false });
    } catch {
      set({ loading: false });
    }
  },
  applyAccount: (record) =>
    set((state) => {
      if (state.accounts.some((a) => a.id === record.id)) return state;
      return { accounts: [record, ...state.accounts] };
    })
}));
