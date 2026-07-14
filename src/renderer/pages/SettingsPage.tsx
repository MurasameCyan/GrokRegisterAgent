import { FormEvent, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, KeyRound, ShieldCheck } from 'lucide-react';
import { SettingsForm } from '@renderer/components/domain/SettingsForm';
import { Button } from '@renderer/components/ui/Button';
import { Input } from '@renderer/components/ui/Input';
import { PasswordInput } from '@renderer/components/ui/PasswordInput';
import { cn } from '@renderer/lib/cn';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useToastStore } from '@renderer/store/toastStore';
import type { AuthState, ChangeCredentialsInput } from '@shared/ipc';

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
    <div className="mx-auto max-w-5xl space-y-5 pb-20">
      <CredentialsPanel username={username} onAuthChanged={onAuthChanged} />
      <SettingsForm />
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
  const [open, setOpen] = useState(false);
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

  return (
    <form onSubmit={submit} className="ios-group">
      <div
        className={cn(
          'flex cursor-pointer select-none items-center justify-between gap-3 px-4 py-3.5 hover:bg-muted/30',
          open && 'border-b border-border/70'
        )}
        role="button"
        tabIndex={0}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <div className="flex min-w-0 items-start gap-2">
          {open ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <h3 className="text-[17px] font-semibold tracking-[-0.02em]">账号与密码</h3>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
              当前账号 {username} · 修改后更新会话
            </p>
          </div>
        </div>
        <ShieldCheck className="h-4 w-4 shrink-0 text-ok" />
      </div>
      {open && (
        <div className="space-y-4 p-4" onClick={(e) => e.stopPropagation()}>
          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="当前密码">
              <PasswordInput
                value={draft.currentPassword}
                onChange={(e) => setDraft({ ...draft, currentPassword: e.target.value })}
              />
            </Field>
            <Field label="新用户名">
              <Input
                value={draft.username}
                onChange={(e) => setDraft({ ...draft, username: e.target.value })}
              />
            </Field>
            <Field label="新密码">
              <PasswordInput
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
              />
            </Field>
            <Field label="确认密码">
              <PasswordInput
                value={draft.confirmPassword}
                onChange={(e) => setDraft({ ...draft, confirmPassword: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>
              <KeyRound className="h-4 w-4" />
              {busy ? '保存中…' : '修改账号密码'}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
