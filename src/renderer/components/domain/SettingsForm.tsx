import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Activity, Github, KeyRound, Loader2, Save, Shield, Trash2 } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@renderer/components/ui/Card';
import { Button } from '@renderer/components/ui/Button';
import { Input } from '@renderer/components/ui/Input';
import { PasswordInput } from '@renderer/components/ui/PasswordInput';
import { Slider } from '@renderer/components/ui/Slider';
import { ConnectionTestButton } from '@renderer/components/domain/ConnectionTestButton';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useToastStore } from '@renderer/store/toastStore';
import type { AppSettings, PoolMode, ProxyPoolEntry } from '@shared/settings';
import {
  parseProxyPoolEntries,
  removeProxiesFromPoolText,
  stripProxyComment,
  validateSettings
} from '@shared/settings';
import { cn } from '@renderer/lib/cn';

/** 批量测活默认并发 */
const PROXY_PROBE_CONCURRENCY = 8;

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

type ProxyProbeUi = {
  status: 'idle' | 'loading' | 'ok' | 'fail';
  message?: string;
};

function ProxyPoolPreview({
  entries,
  probes,
  probingKey,
  failCount,
  onProbeOne,
  onProbeAll,
  onRemoveFailed,
  onRemoveOne
}: {
  entries: ProxyPoolEntry[];
  probes: Record<string, ProxyProbeUi>;
  probingKey: string | null;
  failCount: number;
  onProbeOne: (proxy: string) => void;
  onProbeAll: () => void;
  onRemoveFailed: () => void;
  onRemoveOne: (proxy: string) => void;
}) {
  if (entries.length === 0) return null;
  const busy = probingKey !== null;
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-border/60 bg-muted/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">
          已识别 {entries.length} 条
          {failCount > 0 ? ` · 失败 ${failCount}` : ''}
          （并发测活 · # 标签已解码）
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {failCount > 0 && (
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={onRemoveFailed}
              title="从代理池文本中删除全部测活失败项"
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除失败 ({failCount})
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy || entries.length === 0}
            onClick={onProbeAll}
          >
            {probingKey === '__all__' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Activity className="h-3.5 w-3.5" />
            )}
            全部测活
          </Button>
        </div>
      </div>
      <ul className="max-h-56 space-y-1.5 overflow-y-auto">
        {entries.map((e) => {
          const probe = probes[e.proxy] || { status: 'idle' as const };
          const loading =
            probe.status === 'loading' ||
            probingKey === e.proxy ||
            probingKey === '__all__';
          return (
            <li
              key={e.proxy}
              className="flex flex-wrap items-center gap-2 rounded-lg bg-card/80 px-2.5 py-2 text-[12px]"
            >
              {e.label ? (
                <span className="chip shrink-0 bg-primary/10 text-primary">{e.label}</span>
              ) : (
                <span className="chip shrink-0 text-muted-foreground">无标签</span>
              )}
              <span
                className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                title={e.proxy}
              >
                {e.host}
              </span>
              {probe.status === 'ok' && (
                <span
                  className="max-w-[12rem] truncate text-emerald-600 dark:text-emerald-400"
                  title={probe.message}
                >
                  {probe.message || 'OK'}
                </span>
              )}
              {probe.status === 'fail' && (
                <span className="max-w-[12rem] truncate text-danger" title={probe.message}>
                  {probe.message || '失败'}
                </span>
              )}
              {probe.status === 'fail' && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0 px-2 text-danger"
                  disabled={busy}
                  onClick={() => onRemoveOne(e.proxy)}
                  title="从池中删除此条"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 px-2"
                disabled={loading || busy}
                onClick={() => onProbeOne(e.proxy)}
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '测活'}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SettingsForm() {
  const data = useSettingsStore((s) => s.data);
  const reload = useSettingsStore((s) => s.reload);
  const push = useToastStore((s) => s.push);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [proxyProbes, setProxyProbes] = useState<Record<string, ProxyProbeUi>>({});
  const [probingKey, setProbingKey] = useState<string | null>(null);

  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

  // 外部 reload 后同步（保存成功后）
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const errors = useMemo(() => (draft ? validateSettings(draft) : {}), [draft]);

  const proxyPoolEntries = useMemo(() => {
    if (!draft?.proxyPool) return [] as ProxyPoolEntry[];
    return parseProxyPoolEntries(draft.proxyPool);
  }, [draft?.proxyPool]);

  const failedProxies = useMemo(() => {
    return proxyPoolEntries
      .filter((e) => proxyProbes[e.proxy]?.status === 'fail')
      .map((e) => e.proxy);
  }, [proxyPoolEntries, proxyProbes]);

  if (!draft) {
    return <div className="p-8 text-muted-foreground">加载设置…</div>;
  }

  const dirty = !!data && JSON.stringify(data) !== JSON.stringify(draft);
  const valid = Object.keys(errors).length === 0;
  const updateMail = <K extends keyof AppSettings['mail']>(key: K, value: AppSettings['mail'][K]) =>
    setDraft({ ...draft, mail: { ...draft.mail, [key]: value } });
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft({ ...draft, [key]: value });

  const probeOne = async (proxy: string) => {
    setProbingKey(proxy);
    setProxyProbes((prev) => ({ ...prev, [proxy]: { status: 'loading' } }));
    try {
      const r = await window.api.testProxy(proxy);
      setProxyProbes((prev) => ({
        ...prev,
        [proxy]: {
          status: r.ok ? 'ok' : 'fail',
          message: r.message || (r.ok ? 'OK' : '失败')
        }
      }));
    } catch (err) {
      setProxyProbes((prev) => ({
        ...prev,
        [proxy]: { status: 'fail', message: String(err) }
      }));
    } finally {
      setProbingKey(null);
    }
  };

  const probeAll = async () => {
    if (proxyPoolEntries.length === 0) return;
    setProbingKey('__all__');
    const loadingMap: Record<string, ProxyProbeUi> = {};
    for (const e of proxyPoolEntries) loadingMap[e.proxy] = { status: 'loading' };
    setProxyProbes((prev) => ({ ...prev, ...loadingMap }));
    try {
      const proxies = proxyPoolEntries.map((e) => e.proxy);
      const batch = await window.api.testProxyBatch({
        proxies,
        concurrency: PROXY_PROBE_CONCURRENCY
      });
      // 服务端 results 与请求 proxies 同序
      setProxyProbes((prev) => {
        const next = { ...prev };
        for (let i = 0; i < proxies.length; i++) {
          const proxy = proxies[i];
          const r = batch.results[i];
          next[proxy] = {
            status: r?.ok ? 'ok' : 'fail',
            message: r?.message || (r?.ok ? 'OK' : '失败')
          };
        }
        return next;
      });
      push({
        tone: batch.fail > 0 ? 'warn' : 'ok',
        title: '代理池测活完成',
        description: `共 ${batch.total} · 成功 ${batch.ok} · 失败 ${batch.fail}（并发 ${batch.concurrency}）`
      });
    } catch (err) {
      setProxyProbes((prev) => {
        const next = { ...prev };
        for (const e of proxyPoolEntries) {
          next[e.proxy] = { status: 'fail', message: String(err) };
        }
        return next;
      });
      push({ tone: 'danger', title: '代理池测活失败', description: String(err) });
    } finally {
      setProbingKey(null);
    }
  };

  const removeProxiesFromDraft = (proxies: string[]) => {
    if (!proxies.length) return;
    const nextText = removeProxiesFromPoolText(draft.proxyPool || '', proxies);
    setDraft({ ...draft, proxyPool: nextText });
    setProxyProbes((prev) => {
      const next = { ...prev };
      for (const p of proxies) {
        delete next[p];
        const stripped = stripProxyComment(p);
        if (stripped) delete next[stripped];
      }
      return next;
    });
  };

  const removeFailed = () => {
    if (failedProxies.length === 0) return;
    const n = failedProxies.length;
    removeProxiesFromDraft(failedProxies);
    push({ tone: 'ok', title: '已删除失败代理', description: `已从池文本移除 ${n} 条` });
  };

  const removeOne = (proxy: string) => {
    removeProxiesFromDraft([proxy]);
    push({ tone: 'ok', title: '已删除', description: proxy.slice(0, 48) });
  };

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
          description="兼容 cloudflare_temp_email；域名可填单项或开启域名池"
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
          <Field
            label="API 地址"
            hint="Worker API 根地址（如 https://xxx.workers.dev），不要填前端 Pages 域名"
            error={errors['mail.apiBase']}
          >
            <Input
              value={draft.mail.apiBase}
              onChange={(e) => updateMail('apiBase', e.target.value)}
              invalid={!!errors['mail.apiBase']}
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
            <ToggleRow
              label="启用域名池"
              hint="开：多域名轮换；关：只用默认邮件域名"
              checked={!!draft.mailDomainPoolEnabled}
              onChange={(v) => update('mailDomainPoolEnabled', v)}
            />
          </div>

          {!draft.mailDomainPoolEnabled && (
            <Field
              label="默认邮件域名"
              hint="单域名，例如 example.com"
              error={errors['mail.domain']}
            >
              <Input
                value={draft.mail.domain}
                onChange={(e) => updateMail('domain', e.target.value)}
                invalid={!!errors['mail.domain']}
              />
            </Field>
          )}

          {draft.mailDomainPoolEnabled && (
            <>
              <div className="lg:col-span-2">
                <Field
                  label="邮箱域名池"
                  hint="每行一个，或逗号分隔"
                  error={errors['mail.domain']}
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
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="代理"
          description="总开关关闭时直连；开启后可切换单代理或代理池"
        />
        <CardBody className="grid gap-4 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <ToggleRow
              label="启用代理"
              hint="关：直连；开：使用下方单代理或代理池"
              checked={!!draft.proxyEnabled}
              onChange={(v) => update('proxyEnabled', v)}
            />
          </div>

          {draft.proxyEnabled && (
            <>
              <div className="lg:col-span-2">
                <ToggleRow
                  label="使用代理池"
                  hint="开：从池中轮换；关：使用单条 HTTP/浏览器代理"
                  checked={!!draft.proxyPoolEnabled}
                  onChange={(v) => update('proxyPoolEnabled', v)}
                />
              </div>

              {!draft.proxyPoolEnabled && (
                <>
                  <Field label="HTTP 代理" hint="例如 http://127.0.0.1:7890" error={errors.proxy}>
                    <Input
                      value={draft.proxy}
                      onChange={(e) => update('proxy', e.target.value)}
                      invalid={!!errors.proxy}
                    />
                  </Field>
                  <Field label="浏览器代理" hint="空则跟随 HTTP 代理">
                    <Input
                      value={draft.browserProxy}
                      onChange={(e) => update('browserProxy', e.target.value)}
                      placeholder="留空跟随 HTTP 代理"
                    />
                  </Field>
                </>
              )}

              {draft.proxyPoolEnabled && (
                <>
                  <div className="lg:col-span-2">
                    <Field
                      label="代理池"
                      hint="每行一条；支持行尾 #备注，保存时自动剥离。例：http://user:pass@ip:port#香港-02"
                      error={errors.proxyPool}
                    >
                      <textarea
                        className={TEXTAREA_CLASS}
                        value={draft.proxyPool}
                        onChange={(e) => update('proxyPool', e.target.value)}
                        placeholder={
                          'http://user:pass@1.2.3.4:8080#香港-02\nhttp://user:pass@5.6.7.8:8080#台湾-01'
                        }
                      />
                    </Field>
                    {proxyPoolEntries.length > 0 && (
                      <ProxyPoolPreview
                        entries={proxyPoolEntries}
                        probes={proxyProbes}
                        probingKey={probingKey}
                        failCount={failedProxies.length}
                        onProbeOne={probeOne}
                        onProbeAll={probeAll}
                        onRemoveFailed={removeFailed}
                        onRemoveOne={removeOne}
                      />
                    )}
                  </div>
                  <Field label="代理池模式">
                    <PoolModeSelect
                      value={draft.proxyMode}
                      onChange={(v) => update('proxyMode', v)}
                    />
                  </Field>
                </>
              )}
            </>
          )}
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
          <Field label="Auth 目录" hint="空则 DATA_DIR/auth（容器内多为 /data/auth）">
            <Input
              value={draft.authDir}
              onChange={(e) => update('authDir', e.target.value)}
              placeholder="/data/auth"
            />
          </Field>
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
