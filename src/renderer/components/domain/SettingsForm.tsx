import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FolderCode, Github, Save, Server, ShieldCheck, Terminal } from 'lucide-react';
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
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft({ ...draft, [key]: value });

  const save = async () => {
    setSaving(true);
    try {
      await window.api.saveSettings(draft);
      await reload();
      push({ tone: 'ok', title: '配置已保存' });
    } catch (err) {
      push({ tone: 'danger', title: '保存失败', description: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="WebUI"
          description="账号密码 + HttpOnly Cookie 登录"
          right={<ThemeToggle />}
        />
        <CardBody className="grid gap-3 md:grid-cols-3">
          <InfoTile Icon={Server} label="访问地址" value={origin} />
          <InfoTile Icon={ShieldCheck} label="登录方式" value="Cookie Session" />
          <InfoTile Icon={ShieldCheck} label="反向代理" value="未启用" />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="邮件后端"
          description="兼容 cloudflare_temp_email"
          right={
            <div className="flex flex-wrap items-center gap-2">
              <RepoLink
                href="https://github.com/dreamhunter2333/cloudflare_temp_email"
                label="文档"
              />
              <ConnectionTestButton onTest={() => window.api.testMail(draft.mail)} disabled={!valid} />
            </div>
          }
        />
        <CardBody className="grid gap-4 lg:grid-cols-2">
          <Field label="API 地址" hint="例如 https://mail.example.com" error={errors['mail.apiBase']}>
            <Input
              value={draft.mail.apiBase}
              onChange={(e) => updateMail('apiBase', e.target.value)}
              invalid={!!errors['mail.apiBase']}
            />
          </Field>
          <Field label="邮件域名" hint="例如 example.com" error={errors['mail.domain']}>
            <Input
              value={draft.mail.domain}
              onChange={(e) => updateMail('domain', e.target.value)}
              invalid={!!errors['mail.domain']}
            />
          </Field>
          <div className="lg:col-span-2">
            <Field label="管理密码" hint="Temp Email 管理员密码" error={errors['mail.adminAuth']}>
              <PasswordInput
                value={draft.mail.adminAuth}
                onChange={(e) => updateMail('adminAuth', e.target.value)}
                invalid={!!errors['mail.adminAuth']}
              />
            </Field>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="运行环境"
          description="注册机 Python 解释器与脚本目录"
          right={
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <FolderCode className="h-4 w-4" aria-hidden />
            </span>
          }
        />
        <CardBody className="grid gap-4 lg:grid-cols-2">
          <Field label="Python 路径" hint="留空则用系统 PATH 中的 python">
            <Input
              value={draft.pythonPath}
              onChange={(e) => update('pythonPath', e.target.value)}
              placeholder="python"
            />
          </Field>
          <Field label="注册脚本目录" hint="留空用内置 register/">
            <Input
              value={draft.registerDir}
              onChange={(e) => update('registerDir', e.target.value)}
              placeholder="/app/register"
            />
          </Field>
          <div className="lg:col-span-2 rounded-xl bg-muted/60 px-3.5 py-3 text-[12px] leading-5 text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
              <Terminal className="h-3.5 w-3.5" aria-hidden />
              Docker 默认
            </div>
            容器内一般为 <code className="text-[11px]">/usr/local/bin/python3</code> 与{' '}
            <code className="text-[11px]">/app/register</code>；热更新脚本目录请挂载到{' '}
            <code className="text-[11px]">/opt/register-host</code>。
          </div>
        </CardBody>
      </Card>

      <div className="sticky bottom-4 z-10 flex justify-end">
        <div className="flex items-center gap-3 rounded-[14px] border border-border bg-card px-3 py-2 shadow-[var(--ios-shadow)]">
          <span className="px-1 text-[12px] font-medium text-muted-foreground">
            {dirty ? (valid ? '未保存' : '校验失败') : '已同步'}
          </span>
          <Button onClick={save} disabled={!dirty || !valid || saving} size="sm">
            <Save className="h-4 w-4" />
            保存
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
    <div className="rounded-[14px] bg-muted/60 p-3.5">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="field-label">{label}</span>
      </div>
      <div className="mt-2 break-all text-[13px] font-medium tracking-tight">{value}</div>
    </div>
  );
}
