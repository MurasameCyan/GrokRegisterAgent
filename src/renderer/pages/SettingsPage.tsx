import {
  Component,
  FormEvent,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode
} from 'react';
import { KeyRound, UserRound } from 'lucide-react';
import { SettingsForm } from '@renderer/components/domain/SettingsForm';
import { CardHeaderIcon } from '@renderer/components/domain/CardHeaderIcon';
import { Button } from '@renderer/components/ui/Button';
import { Card, CardBody, CardHeader } from '@renderer/components/ui/Card';
import { Input } from '@renderer/components/ui/Input';
import { PasswordInput } from '@renderer/components/ui/PasswordInput';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useToastStore } from '@renderer/store/toastStore';
import type { AuthState, ChangeCredentialsInput } from '@shared/ipc';

/** 捕获配置表渲染异常，避免整页黑屏且无信息 */
class SettingsErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[SettingsPage] render error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-[13px]">
          <div className="font-semibold text-destructive">配置页渲染失败</div>
          <p className="mt-1 break-all text-muted-foreground">
            {this.state.error.message}
          </p>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2 text-[11px] text-muted-foreground">
            {this.state.error.stack || String(this.state.error)}
          </pre>
          <Button
            type="button"
            size="sm"
            className="mt-3"
            onClick={() => this.setState({ error: null })}
          >
            重试
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function SettingsPage({
  username,
  onAuthChanged
}: {
  username: string;
  onAuthChanged(next: AuthState): void;
}) {
  const data = useSettingsStore((s) => s.data);
  const reload = useSettingsStore((s) => s.reload);

  useEffect(() => {
    if (!data) void reload();
  }, [data, reload]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 pb-16">
      <CredentialsPanel username={username} onAuthChanged={onAuthChanged} />
      <SettingsErrorBoundary>
        <SettingsForm />
      </SettingsErrorBoundary>
    </div>
  );
}

function CredentialsPanel({
  username,
  onAuthChanged
}: {
  username: string;
  onAuthChanged(next: AuthState): void;
}) {
  const [draft, setDraft] = useState<ChangeCredentialsInput>({
    currentPassword: '',
    username,
    password: '',
    confirmPassword: ''
  });
  const [busy, setBusy] = useState(false);
  const push = useToastStore((s) => s.push);

  useEffect(() => {
    setDraft((prev) => ({ ...prev, username }));
  }, [username]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const next = await window.api.changeCredentials(draft);
      onAuthChanged(next);
      setDraft({
        currentPassword: '',
        username: next.username ?? draft.username,
        password: '',
        confirmPassword: ''
      });
      push({ tone: 'ok', title: '账号密码已更新' });
    } catch (err) {
      push({
        tone: 'danger',
        title: '更新失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setBusy(false);
    }
  };

  const displayName = username || 'admin';

  return (
    <form onSubmit={submit}>
      {/* 与下方邮件/代理等卡片同壳：ios-group + CardHeader 高度/说明/右侧圆标 */}
      <Card collapsible defaultCollapsed>
        <CardHeader
          title="账号设置"
          description={`当前登录 · ${displayName} · 修改后立即生效，请妥善保管`}
          right={<CardHeaderIcon icon={UserRound} title="Web 控制台账号" />}
        />
        <CardBody className="space-y-4">
          <p className="text-[12px] leading-5 text-muted-foreground">
            此为控制台登录账号（默认 admin/admin 首次登录会强制修改），与 Grok 注册号池、邮件
            API、CPA 密钥无关。
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="当前密码" hint="验证身份后才能改名/改密">
              <PasswordInput
                value={draft.currentPassword}
                onChange={(e) =>
                  setDraft({ ...draft, currentPassword: e.target.value })
                }
                autoComplete="current-password"
              />
            </Field>
            <Field label="新用户名" hint="控制台登录名，可与默认 admin 不同">
              <Input
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                autoComplete="username"
              />
            </Field>
            <Field label="新密码" hint="建议 8 位以上，勿与 API 密钥相同">
              <PasswordInput
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                autoComplete="new-password"
              />
            </Field>
            <Field label="确认密码" hint="须与新密码一致">
              <PasswordInput
                value={draft.confirmPassword}
                onChange={(e) =>
                  setDraft({ ...draft, confirmPassword: e.target.value })
                }
                autoComplete="new-password"
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>
              <KeyRound className="h-4 w-4" />
              {busy ? '保存中…' : '修改账号密码'}
            </Button>
          </div>
        </CardBody>
      </Card>
    </form>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <div className="flex flex-col gap-0.5">
        <span className="field-label">{label}</span>
        {hint ? (
          <span className="text-[11px] leading-4 text-muted-foreground">{hint}</span>
        ) : null}
      </div>
      {children}
    </label>
  );
}
