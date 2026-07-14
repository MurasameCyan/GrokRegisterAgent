import { FormEvent, useEffect, useState } from 'react';
import {
  Activity,
  Database,
  Github,
  KeyRound,
  LayoutDashboard,
  LogOut,
  PlayCircle,
  Settings2,
  ShieldCheck
} from 'lucide-react';
import { DashboardPage } from '@renderer/pages/DashboardPage';
import { RegisterPage } from '@renderer/pages/RegisterPage';
import { PoolPage } from '@renderer/pages/PoolPage';
import { AuthPage } from '@renderer/pages/AuthPage';
import { SettingsPage } from '@renderer/pages/SettingsPage';
import { ThemeToggle } from '@renderer/components/ui/ThemeToggle';
import { ToastViewport } from '@renderer/components/ui/Toast';
import { Button } from '@renderer/components/ui/Button';
import { Input } from '@renderer/components/ui/Input';
import { PasswordInput } from '@renderer/components/ui/PasswordInput';
import { cn } from '@renderer/lib/cn';
import { useRunStore } from '@renderer/store/runStore';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useAccountsStore } from '@renderer/store/accountsStore';
import { useToastStore } from '@renderer/store/toastStore';
import type { AuthState, ChangeCredentialsInput } from '@shared/ipc';

type Tab = 'dashboard' | 'register' | 'pool' | 'auth' | 'settings';

const tabs: { id: Tab; label: string; Icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: '仪表盘', Icon: LayoutDashboard },
  { id: 'register', label: '注册机', Icon: PlayCircle },
  { id: 'pool', label: 'SSO', Icon: Database },
  { id: 'auth', label: 'Auth', Icon: KeyRound },
  { id: 'settings', label: '配置', Icon: Settings2 }
];

const emptyAuth: AuthState = {
  authenticated: false,
  username: null,
  mustChangePassword: false
};

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [auth, setAuth] = useState<AuthState>(emptyAuth);
  const [authLoading, setAuthLoading] = useState(true);
  const pushToast = useToastStore((s) => s.push);
  const applyEvent = useRunStore((s) => s.applyEvent);
  const setStatus = useRunStore((s) => s.setStatus);
  const applyAccount = useAccountsStore((s) => s.applyAccount);
  const reloadSettings = useSettingsStore((s) => s.reload);
  const status = useRunStore((s) => s.status);

  useEffect(() => {
    let active = true;
    void window.api
      .getAuthState()
      .then((state) => {
        if (active) setAuth(state);
      })
      .catch(() => {
        if (active) setAuth(emptyAuth);
      })
      .finally(() => {
        if (active) setAuthLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!auth.authenticated) return;
    void reloadSettings().catch((err) => {
      pushToast({
        tone: 'danger',
        title: '读取设置失败',
        description: err instanceof Error ? err.message : String(err)
      });
    });
  }, [auth.authenticated, pushToast, reloadSettings]);

  useEffect(() => {
    if (!auth.authenticated) return;
    let active = true;

    void window.api
      .getStatus()
      .then((nextStatus) => {
        if (active) setStatus(nextStatus);
      })
      .catch((err) => {
        pushToast({
          tone: 'danger',
          title: '读取状态失败',
          description: err instanceof Error ? err.message : String(err)
        });
      });

    const off = window.api.onRegisterEvent((event) => {
      applyEvent(event);
      if (event.type === 'account') {
        applyAccount(event.record);
      }
    });

    return () => {
      active = false;
      off();
    };
  }, [applyEvent, applyAccount, auth.authenticated, pushToast, setStatus]);

  const logout = async () => {
    await window.api.logout().catch(() => undefined);
    setAuth(emptyAuth);
    setTab('dashboard');
  };

  if (authLoading) {
    return <BootScreen />;
  }

  if (!auth.authenticated) {
    return (
      <>
        <LoginScreen onAuthed={setAuth} />
        <ToastViewport />
      </>
    );
  }

  const phasePill =
    status.phase === 'running' || status.phase === 'starting'
      ? 'pill-ok'
      : status.phase === 'error'
        ? 'pill-danger'
        : status.phase === 'done'
          ? 'pill-ok'
          : 'pill-idle';

  return (
    <div className="app-shell">
      <aside className="app-nav">
        <div className="flex h-full flex-col">
          <div className="nav-brand">
            <div className="nav-logo" aria-hidden title="Grok Register Agent">
              GRA
            </div>
            <div className="site-name" aria-label="Grok Register Agent">
              <span>Grok</span>
              <span>Register</span>
              <span>Agent</span>
            </div>
          </div>

          <nav className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible">
            {tabs.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn('nav-link shrink-0', tab === id && 'nav-link-active')}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
                <span className="leading-none">{label}</span>
              </button>
            ))}
          </nav>

          <div className="mt-auto space-y-2.5 border-t border-border p-3">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <ThemeToggle />
              </div>
              <a
                href="https://github.com/MurasameCyan/GrokRegisterAgent"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title="GitHub"
              >
                <Github className="h-4 w-4" strokeWidth={2} aria-hidden />
              </a>
            </div>
            <div className="flex h-10 items-center justify-between gap-2 rounded-xl bg-muted px-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ok/15 text-ok">
                  <ShieldCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                </span>
                <span className="truncate text-[13px] font-medium leading-none">
                  {auth.username}
                </span>
              </div>
              <button
                type="button"
                onClick={logout}
                className="inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg px-2 text-[12px] font-medium leading-none text-primary active:opacity-70"
                title="退出登录"
              >
                <LogOut className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
                <span className="leading-none">退出</span>
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className="app-main">
        <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="page-kicker mb-0">Grok Register Agent</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('pill', phasePill)}>
              <Activity className="h-3.5 w-3.5" />
              {status.phase}
            </span>
            <span className="chip">{new Date().toLocaleDateString('zh-CN')}</span>
          </div>
        </header>

        {tab === 'dashboard' && <DashboardPage username={auth.username ?? 'admin'} />}
        {tab === 'register' && <RegisterPage onOpenSettings={() => setTab('settings')} />}
        {tab === 'pool' && <PoolPage />}
        {tab === 'auth' && <AuthPage onOpenPool={() => setTab('pool')} />}
        {tab === 'settings' && (
          <SettingsPage
            username={auth.username ?? 'admin'}
            onAuthChanged={(next) => setAuth(next)}
          />
        )}
      </main>

      {auth.mustChangePassword && (
        <ChangeCredentialsModal
          username={auth.username ?? 'admin'}
          title="首次登录需要修改账号密码"
          description="为了避免默认 admin/admin 留在 Web 部署中，请先设置新的用户名和密码。"
          onChanged={setAuth}
        />
      )}

      <ToastViewport />
    </div>
  );
}

function BootScreen() {
  return (
    <div className="login-wrap">
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-6 py-5 shadow-[var(--ios-shadow)]">
        <div className="nav-logo" aria-hidden title="Grok Register Agent">
          GRA
        </div>
        <div>
          <div className="site-name" aria-label="Grok Register Agent">
            <span>Grok</span>
            <span>Register</span>
            <span>Agent</span>
          </div>
          <div className="mt-1 text-[13px] font-medium text-muted-foreground">正在检查登录状态…</div>
        </div>
      </div>
    </div>
  );
}

function LoginScreen({ onAuthed }: { onAuthed(next: AuthState): void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onAuthed(await window.api.login(username, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form onSubmit={submit} className="login-panel">
        <div className="mb-7 flex items-center gap-3">
          <div className="nav-logo" aria-hidden title="Grok Register Agent">
            GRA
          </div>
          <div className="site-name site-name-lg" aria-label="Grok Register Agent">
            <span>Grok</span>
            <span>Register</span>
            <span>Agent</span>
          </div>
        </div>
        <h1 className="text-[28px] font-bold tracking-[-0.03em]">登录</h1>
        <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">
          默认账号 admin / admin，首次登录后需修改。
        </p>
        <div className="mt-6 space-y-4">
          <label className="block space-y-1.5">
            <span className="field-label">用户名</span>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          </label>
          <label className="block space-y-1.5">
            <span className="field-label">密码</span>
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && (
            <div className="rounded-xl bg-danger/10 px-3.5 py-3 text-[13px] text-danger">{error}</div>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? '登录中…' : '继续'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function ChangeCredentialsModal({
  username,
  title,
  description,
  onChanged
}: {
  username: string;
  title: string;
  description: string;
  onChanged(next: AuthState): void;
}) {
  const [draft, setDraft] = useState<ChangeCredentialsInput>({
    currentPassword: '',
    username,
    password: '',
    confirmPassword: ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      onChanged(await window.api.changeCredentials(draft));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-[var(--ios-shadow)]">
        <div className="mb-5 flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-ok/12 text-ok">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-[20px] font-semibold tracking-[-0.02em]">{title}</h2>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
          </div>
        </div>

        <div className="space-y-3.5">
          <label className="block space-y-1.5">
            <span className="field-label">当前密码</span>
            <PasswordInput
              value={draft.currentPassword}
              onChange={(e) => setDraft({ ...draft, currentPassword: e.target.value })}
              autoFocus
            />
          </label>
          <label className="block space-y-1.5">
            <span className="field-label">新用户名</span>
            <Input
              value={draft.username}
              onChange={(e) => setDraft({ ...draft, username: e.target.value })}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="field-label">新密码</span>
            <PasswordInput
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="field-label">确认密码</span>
            <PasswordInput
              value={draft.confirmPassword}
              onChange={(e) => setDraft({ ...draft, confirmPassword: e.target.value })}
            />
          </label>
          {error && (
            <div className="rounded-xl bg-danger/10 px-3.5 py-3 text-[13px] text-danger">{error}</div>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? '保存中…' : '保存并继续'}
          </Button>
        </div>
      </form>
    </div>
  );
}
