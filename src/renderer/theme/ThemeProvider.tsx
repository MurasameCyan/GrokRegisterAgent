import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ThemeMode } from '@shared/settings';

interface ThemeCtx {
  mode: ThemeMode;
  effective: 'light' | 'dark';
  setMode(m: ThemeMode): Promise<void>;
}

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [effective, setEffective] = useState<'light' | 'dark'>('light');

  // 初始化
  useEffect(() => {
    void window.api.getTheme().then(({ mode, effective }) => {
      setModeState(mode);
      setEffective(effective);
    });
    const off = window.api.onThemeChanged(({ mode, effective }) => {
      setModeState(mode);
      setEffective(effective);
    });
    return off;
  }, []);

  // DOM class 跟随 effective
  useEffect(() => {
    const root = document.documentElement;
    if (effective === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
  }, [effective]);

  const setMode = async (m: ThemeMode) => {
    const r = await window.api.setTheme(m);
    setModeState(r.mode);
    setEffective(r.effective);
  };

  return (
    <Ctx.Provider value={{ mode, effective, setMode }}>{children}</Ctx.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTheme must be inside <ThemeProvider>');
  return ctx;
}
