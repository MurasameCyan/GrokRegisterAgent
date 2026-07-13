import { FormEvent, useEffect, useState } from 'react';
import {
  Activity,
  Database,
  Github,
  LayoutDashboard,
  LogOut,
  PlayCircle,
  Settings2,
  ShieldCheck
} from 'lucide-react';
import { DashboardPage } from '@renderer/pages/DashboardPage';
import { RegisterPage } from '@renderer/pages/RegisterPage';
import { PoolPage } from '@renderer/pages/PoolPage';
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

type Tab = 'dashboard' | 'register' | 'pool' | 'settings';

const tabs: { id: Tab; label: string; Icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: '仪表盘', Icon: LayoutDashboard },
  { id: 'register', label: '注册机', Icon: PlayCircle },
  { id: 'pool', label: '号池', Icon: Database },
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

  return (
    <div className="app-frame">
      <aside className="side-rail">
        <div className="shell-window h-full">
          <div className="space-y-5 p-4">
            <div className="flex items-center gap-3">
              <div className="brand-mark" aria-hidden>
                G
              </div>
              <div className="min-w-0">
                <h1 className="brand-title">Grok Agent</h1>
                <p className="brand-subtitle">注册控制台</p>
              </div>
            </div>

            <nav className="space-y-1">
              {tabs.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn('side-nav-item', tab === id && 'side-nav-item-active')}
                >
                  <Icon className="h-4 w-4 shrink-0 opacity-90" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>

            <div className="ghost-divider" />

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 rounded-[14px] bg-muted/70 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-ok" />
                  <span className="truncate text-[13px] font-medium">{auth.username}</span>
                </div>
                <Button variant="ghost" size="sm" onClick={logout} title="退出登录">
                  <LogOut className="h-3.5 w-3.5" />
                  退出
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <ThemeToggle />
                <a
                  href="https://github.com/MurasameCyan/GrokRegisterAgent"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title="GitHub"
                >
                  <Github className="h-4 w-4" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-stage">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="brand-subtitle mb-1">Grok Agent</p>
            <h2 className="page-title">
              {tabs.find((item) => item.id === tab)?.label}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'status-pill',
                status.phase === 'running' || status.phase === 'starting'
                  ? 'status-pill-warn'
                  : status.phase === 'error'
                    ? 'status-pill-danger'
                    : 'status-pill-idle'
              )}
            >
              <Activity className="h-3.5 w-3.5" />
              {status.phase}
            </span>
            <span className="shell-chip">{new Date().toLocaleDateString('zh-CN')}</span>
          </div>
        </div>

        {tab === 'dashboard' && <DashboardPage username={auth.username ?? 'admin'} />}
        {tab === 'register' && <RegisterPage onOpenSettings={() => setTab('settings')} />}
        {tab === 'pool' && <PoolPage />}
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
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="shell-window max-w-sm p-6">
        <div className="flex items-center gap-3">
          <div className="brand-mark" aria-hidden>
            G
          </div>
          <div>
            <div className="brand-subtitle">Grok Agent</div>
            <div className="mt-0.5 text-[15px] font-semibold tracking-[-0.01em]">
              正在检查登录状态…
            </div>
          </div>
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
    <div className="login-stage">
      <form onSubmit={submit} className="login-card">
        <div className="mb-6 flex items-center gap-3">
          <div className="brand-mark" aria-hidden>
            G
          </div>
          <div>
            <div className="brand-title">Grok Agent</div>
            <p className="brand-subtitle">注册控制台</p>
          </div>
        </div>
        <div className="space-y-1.5">
          <h1 className="text-[28px] font-semibold tracking-[-0.03em]">登录</h1>
          <p className="text-[13px] leading-5 text-muted-foreground">
            默认账号 admin/admin（见启动日志），首次登录后需修改。
          </p>
        </div>
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
            <div className="rounded-[12px] bg-danger/10 px-3.5 py-3 text-[13px] text-danger">
              {error}
            </div>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4">
      <form onSubmit={submit} className="shell-window w-full max-w-md p-6">
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
            <div className="rounded-[12px] bg-danger/10 px-3.5 py-3 text-[13px] text-danger">
              {error}
            </div>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={busy}>
            {busy ? '保存中…' : '保存并继续'}
          </Button>
        </div>
      </form>
    </div>
  );
}
