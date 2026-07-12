import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Github, Save, Server, ShieldCheck } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@renderer/components/ui/Card';
import { Button } from '@renderer/components/ui/Button';
import { Input } from '@renderer/components/ui/Input';
import { PasswordInput } from '@renderer/components/ui/PasswordInput';
import { ThemeToggle } from '@renderer/components/ui/ThemeToggle';
import { ConnectionTestButton } from '@renderer/components/domain/ConnectionTestButton';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useToastStore } from '@renderer/store/toastStore';
import type { AppSettings } from '@shared/settings';

function RepoLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground"
      title={href}
    >
      <Github className="h-3 w-3" />
      {label}
    </a>
  );
}

function Field({
  label,
  hint,
  error,
  children
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-1">
        <label className="field-label">{label}</label>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      {children}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

export function SettingsForm() {
  const data = useSettingsStore((s) => s.data);
  const reload = useSettingsStore((s) => s.reload);
  const push = useToastStore((s) => s.push);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

  const errors = useMemo(() => {
    if (!draft) return {};
    const next: Record<string, string> = {};
    if (!draft.mail.apiBase.trim()) next['mail.apiBase'] = '请填写邮件后端地址';
    if (!draft.mail.adminAuth.trim()) next['mail.adminAuth'] = '请填写邮件后端管理密码';
    if (!draft.mail.domain.trim()) next['mail.domain'] = '请填写邮件域名';
    return next;
  }, [draft]);

  if (!draft) {
    return <div className="p-8 text-muted-foreground">加载设置…</div>;
  }

  const dirty = !!data && JSON.stringify(data) !== JSON.stringify(draft);
  const valid = Object.keys(errors).length === 0;
  const origin = typeof window === 'undefined' ? 'http://127.0.0.1:8098' : window.location.origin;
  const updateMail = <K extends keyof AppSettings['mail']>(key: K, value: AppSettings['mail'][K]) =>
    setDraft({ ...draft, mail: { ...draft.mail, [key]: value } });

  const save = async () => {
    setSaving(true);
    try {
      await window.api.saveSettings(draft);
      await reload();
      push({ tone: 'ok', title: '邮箱后台配置已保存' });
    } catch (err) {
      push({ tone: 'danger', title: '保存失败', description: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="WebUI 配置"
          description="账号密码 + HttpOnly Cookie 登录。"
          right={<ThemeToggle />}
        />
        <CardBody className="grid gap-4 md:grid-cols-3">
          <InfoTile Icon={Server} label="访问地址" value={origin} />
          <InfoTile Icon={ShieldCheck} label="登录方式" value="cookie session" />
          <InfoTile Icon={ShieldCheck} label="反向代理" value="未启用" />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="邮件后端"
          description="兼容 cloudflare_temp_email，填写域名和管理密码。"
          right={
            <div className="flex flex-wrap items-center gap-2">
              <RepoLink
                href="https://github.com/dreamhunter2333/cloudflare_temp_email"
                label="部署文档"
              />
              <ConnectionTestButton onTest={() => window.api.testMail(draft.mail)} disabled={!valid} />
            </div>
          }
        />
        <CardBody className="grid gap-5 lg:grid-cols-2">
          <Field label="mail api base" hint="例如 https://mail.example.com" error={errors['mail.apiBase']}>
            <Input
              value={draft.mail.apiBase}
              onChange={(e) => updateMail('apiBase', e.target.value)}
              invalid={!!errors['mail.apiBase']}
            />
          </Field>
          <Field label="mail domain" hint="例如 example.com" error={errors['mail.domain']}>
            <Input
              value={draft.mail.domain}
              onChange={(e) => updateMail('domain', e.target.value)}
              invalid={!!errors['mail.domain']}
            />
          </Field>
          <div className="lg:col-span-2">
            <Field label="admin auth" hint="Cloudflare Temp Email 后端管理员密码" error={errors['mail.adminAuth']}>
              <PasswordInput
                value={draft.mail.adminAuth}
                onChange={(e) => updateMail('adminAuth', e.target.value)}
                invalid={!!errors['mail.adminAuth']}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <div className="sticky bottom-4 z-10 flex justify-end">
        <div className="shell-window flex items-center gap-3 px-3 py-2">
          <span className="px-2 text-[11px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
            {dirty ? (valid ? 'modified' : 'validation error') : 'synced'}
          </span>
          <Button onClick={save} disabled={!dirty || !valid || saving} size="sm">
            <Save className="h-4 w-4" />
            保存配置
          </Button>
        </div>
      </div>
    </div>
  );
}

function InfoTile({
  Icon,
  label,
  value
}: {
  Icon: typeof Server;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-muted/45 p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="field-label">{label}</span>
      </div>
      <div className="mt-3 break-all font-mono text-sm">{value}</div>
    </div>
  );
}
