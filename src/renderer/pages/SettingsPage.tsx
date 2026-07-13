import { FormEvent, useEffect, useState, type ReactNode } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { SettingsForm } from '@renderer/components/domain/SettingsForm';
import { Button } from '@renderer/components/ui/Button';
import { Input } from '@renderer/components/ui/Input';
import { PasswordInput } from '@renderer/components/ui/PasswordInput';
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
      <SecurityPanel username={username} onAuthChanged={onAuthChanged} />
      <SettingsForm />
    </div>
  );
}

function SecurityPanel({
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

  return (
    <form onSubmit={submit} className="ios-group">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5">
        <div>
          <p className="page-kicker">安全</p>
          <h3 className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">账号与密码</h3>
        </div>
        <ShieldCheck className="h-4 w-4 text-ok" />
      </div>
      <div className="space-y-4 p-4">
        <div className="rounded-xl bg-muted/70 p-3.5 text-[13px] leading-5 text-muted-foreground">
          当前账号 <span className="font-medium text-foreground">{username}</span>
          。请勿长期使用默认密码；修改后会更新当前会话。
        </div>
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
