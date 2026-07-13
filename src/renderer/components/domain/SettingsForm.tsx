import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FolderCode, Github, KeyRound, Save, Shield, Terminal } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@renderer/components/ui/Card';
import { Button } from '@renderer/components/ui/Button';
import { Input } from '@renderer/components/ui/Input';
import { PasswordInput } from '@renderer/components/ui/PasswordInput';
import { Slider } from '@renderer/components/ui/Slider';
import { ConnectionTestButton } from '@renderer/components/domain/ConnectionTestButton';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useToastStore } from '@renderer/store/toastStore';
import type { AppSettings, PoolMode } from '@shared/settings';
import { validateSettings } from '@shared/settings';
import { cn } from '@renderer/lib/cn';

const TEXTAREA_CLASS =
  'flex min-h-[96px] w-full rounded-[12px] border border-input bg-muted/60 px-3.5 py-2.5 text-[14px] leading-5 tracking-[-0.01em] transition-colors placeholder:text-muted-foreground/70 focus-visible:border-primary/40 focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50';

const SELECT_CLASS =
  'flex h-11 w-full rounded-[12px] border border-input bg-muted/60 px-3.5 py-2 text-[15px] tracking-[-0.01em] transition-colors focus-visible:border-primary/40 focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50';

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

function ToggleRow({
  label,
  hint,
  checked,
  onChange
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl bg-muted/60 px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-[14px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{hint}</div>}
      </div>
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function PoolModeSelect({
  value,
  onChange
}: {
  value: PoolMode;
  onChange: (v: PoolMode) => void;
}) {
  return (
    <select
      className={SELECT_CLASS}
      value={value}
      onChange={(e) => onChange(e.target.value as PoolMode)}
    >
      <option value="round_robin">顺序轮换</option>
      <option value="random">随机</option>
    </select>
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

  // 外部 reload 后同步（保存成功后）
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const errors = useMemo(() => (draft ? validateSettings(draft) : {}), [draft]);

  if (!draft) {
    return <div className="p-8 text-muted-foreground">加载设置…</div>;
  }

  const dirty = !!data && JSON.stringify(data) !== JSON.stringify(draft);
  const valid = Object.keys(errors).length === 0;
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
          title="邮件后端"
          description="兼容 cloudflare_temp_email；域名可填单项或域名池"
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
          <Field
            label="默认邮件域名"
            hint="单域名；与下方域名池二选一或并存（池优先）"
            error={errors['mail.domain']}
          >
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
          <div className="lg:col-span-2">
            <Field
              label="邮箱域名池"
              hint="每行一个，或逗号分隔；非空时优先于默认域名轮换"
            >
              <textarea
                className={TEXTAREA_CLASS}
                value={draft.mailDomains}
                onChange={(e) => update('mailDomains', e.target.value)}
                placeholder={'example.com\nother.com'}
              />
            </Field>
          </div>
          <Field label="域名池模式">
            <PoolModeSelect
              value={draft.mailDomainMode}
              onChange={(v) => update('mailDomainMode', v)}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="代理" description="单代理与代理池；池非空时优先轮换" />
        <CardBody className="grid gap-4 lg:grid-cols-2">
          <Field label="HTTP 代理" hint="例如 http://127.0.0.1:7890">
            <Input value={draft.proxy} onChange={(e) => update('proxy', e.target.value)} />
          </Field>
          <Field label="浏览器代理" hint="空则跟随 HTTP 代理">
            <Input
              value={draft.browserProxy}
              onChange={(e) => update('browserProxy', e.target.value)}
              placeholder="留空跟随 HTTP 代理"
            />
          </Field>
          <div className="lg:col-span-2">
            <Field label="代理池" hint="每行一个，或逗号分隔；非空时优先于单代理">
              <textarea
                className={TEXTAREA_CLASS}
                value={draft.proxyPool}
                onChange={(e) => update('proxyPool', e.target.value)}
                placeholder={'http://user:pass@1.2.3.4:8080\nhttp://5.6.7.8:8080'}
              />
            </Field>
          </div>
          <Field label="代理池模式">
            <PoolModeSelect value={draft.proxyMode} onChange={(v) => update('proxyMode', v)} />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="人机验证"
          description="Turnstile 自动通过等待上限；每次在 30～上限 内随机"
          right={
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Shield className="h-4 w-4" aria-hidden />
            </span>
          }
        />
        <CardBody>
          <div className="rounded-xl bg-muted/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="field-label">自动等待上限</div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  每次随机等待 30～{draft.turnstileAutoWaitMax ?? 60}s，再尝试点击
                </div>
              </div>
              <span className="chip tabular-nums">{draft.turnstileAutoWaitMax ?? 60}s</span>
            </div>
            <div className="mt-3">
              <Slider
                min={30}
                max={180}
                value={draft.turnstileAutoWaitMax ?? 60}
                onValueChange={(v) => update('turnstileAutoWaitMax', v)}
              />
            </div>
            {errors.turnstileAutoWaitMax && (
              <p className="mt-2 text-xs text-danger">{errors.turnstileAutoWaitMax}</p>
            )}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="指纹与 Auth 导出"
          description="随机注册特征、SSO→CPA auth 自动写出"
          right={
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <KeyRound className="h-4 w-4" aria-hidden />
            </span>
          }
        />
        <CardBody className="space-y-3">
          <ToggleRow
            label="随机注册特征"
            hint="UA / 语言 / 时区 / 分辨率等指纹随机化"
            checked={draft.randomFingerprint}
            onChange={(v) => update('randomFingerprint', v)}
          />
          <ToggleRow
            label="自动导出 CPA Auth"
            hint="注册成功后 SSO 转换并写入 auth 目录"
            checked={draft.autoAuthExport}
            onChange={(v) => update('autoAuthExport', v)}
          />
          <Field
            label="Auth 目录"
            hint="空则 DATA_DIR/auth（容器内多为 /data/auth）"
          >
            <Input
              value={draft.authDir}
              onChange={(e) => update('authDir', e.target.value)}
              placeholder="/data/auth"
            />
          </Field>
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
          <Field label="浏览器路径" hint="Chromium/Chrome/Edge；空则自动探测">
            <Input
              value={draft.browserPath}
              onChange={(e) => update('browserPath', e.target.value)}
              placeholder="留空自动探测"
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
        <div
          className={cn(
            'flex items-center gap-3 rounded-[14px] border border-border bg-card px-3 py-2 shadow-[var(--ios-shadow)]'
          )}
        >
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
