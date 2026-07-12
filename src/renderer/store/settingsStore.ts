import { create } from 'zustand';
import type { AppSettings } from '@shared/settings';

interface SettingsState {
  data: AppSettings | null;
  loading: boolean;
  set(data: AppSettings): void;
  reload(): Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  data: null,
  loading: false,
  set: (data) => set({ data }),
  reload: async () => {
    set({ loading: true });
    const data = await window.api.getSettings();
    set({ data, loading: false });
  }
}));
