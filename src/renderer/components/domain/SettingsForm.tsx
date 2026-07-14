import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Github,
  KeyRound,
  Loader2,
  Save,
  Shield,
  Trash2
} from 'lucide-react';
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
  moveProxiesToAlivePool,
  parseProxyPoolEntries,
  removeProxiesFromPoolText,
  stripProxyComment,
  validateSettings
} from '@shared/settings';
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
  /** 可用池默认折叠 */
  const [alivePoolOpen, setAlivePoolOpen] = useState(false);

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

  const alivePoolEntries = useMemo(() => {
    if (!draft?.proxyPoolAlive) return [] as ProxyPoolEntry[];
    return parseProxyPoolEntries(draft.proxyPoolAlive);
  }, [draft?.proxyPoolAlive]);

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

  /** 测活成功 → 移入可用池，从待测池移除 */
  const promoteOkProxies = (okProxies: string[], base?: AppSettings) => {
    const src = base || draft;
    if (!src || okProxies.length === 0) return src;
    const { proxyPool, proxyPoolAlive, moved } = moveProxiesToAlivePool(
      src.proxyPool || '',
      src.proxyPoolAlive || '',
      okProxies
    );
    if (moved <= 0) return src;
    const nextDraft = { ...src, proxyPool, proxyPoolAlive };
    setDraft(nextDraft);
    setProxyProbes((prev) => {
      const next = { ...prev };
      for (const p of okProxies) {
        delete next[p];
        const stripped = stripProxyComment(p);
        if (stripped) delete next[stripped];
      }
      return next;
    });
    // 有新成功项时自动展开可用池，方便确认
    setAlivePoolOpen(true);
    return nextDraft;
  };

  const probeOne = async (proxy: string) => {
    setProbingKey(proxy);
    setProxyProbes((prev) => ({ ...prev, [proxy]: { status: 'loading' } }));
    try {
      const r = await window.api.testProxy(proxy);
      if (r.ok) {
        const next = promoteOkProxies([proxy]);
        push({
          tone: 'ok',
          title: '测活成功 → 已移入可用池',
          description: r.message || proxy.slice(0, 48)
        });
        // 自动保存在 probe 结束后由外层可选触发（见 proxyAutoSaveOnRemoveFailed）
        if (next && draft.proxyAutoSaveOnRemoveFailed) {
          try {
            await window.api.saveSettings(next);
            await reload();
          } catch {
            /* 保存失败不阻断测活结果 */
          }
        }
      } else {
        setProxyProbes((prev) => ({
          ...prev,
          [proxy]: {
            status: 'fail',
            message: r.message || '失败'
          }
        }));
      }
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

    // 分块测活：避免一次 200+ 条卡死反代（Cloudflare 524 ~100s）
    const CHUNK = 24;
    const conc = Math.max(1, Math.min(12, Number(draft.proxyProbeConcurrency) || 8));
    const timeoutMs = 6000;
    const proxies = proxyPoolEntries.map((e) => e.proxy);
    let totalOk = 0;
    let totalFail = 0;
    let hardError: string | null = null;
    const allOk: string[] = [];
    let workingDraft = draft;

    try {
      for (let offset = 0; offset < proxies.length; offset += CHUNK) {
        const chunk = proxies.slice(offset, offset + CHUNK);
        const chunkNo = Math.floor(offset / CHUNK) + 1;
        const chunkTotal = Math.ceil(proxies.length / CHUNK);
        try {
          const batch = await window.api.testProxyBatch({
            proxies: chunk,
            concurrency: conc,
            timeoutMs
          });
          const chunkOk: string[] = [];
          setProxyProbes((prev) => {
            const next = { ...prev };
            for (let i = 0; i < chunk.length; i++) {
              const proxy = chunk[i];
              const r = batch.results[i];
              if (r?.ok) {
                chunkOk.push(proxy);
                // 成功项将移入可用池，不必长期占待测区状态
                delete next[proxy];
              } else {
                next[proxy] = {
                  status: 'fail',
                  message: r?.message || '失败'
                };
              }
            }
            return next;
          });
          if (chunkOk.length > 0) {
            allOk.push(...chunkOk);
            const promoted = promoteOkProxies(chunkOk, workingDraft);
            if (promoted) workingDraft = promoted;
          }
          totalOk += batch.ok || chunkOk.length;
          totalFail += batch.fail || Math.max(0, chunk.length - chunkOk.length);
          // 进度 toast 每 3 块或最后一块
          if (chunkNo === chunkTotal || chunkNo % 3 === 0) {
            push({
              tone: 'ok',
              title: `测活进度 ${chunkNo}/${chunkTotal}`,
              description: `已完成 ${Math.min(offset + chunk.length, proxies.length)}/${proxies.length} · 成功 ${totalOk} · 失败 ${totalFail}`
            });
          }
        } catch (err) {
          // 单块失败：该块全部标 fail，继续下一块
          const msg = String(err);
          hardError = msg;
          setProxyProbes((prev) => {
            const next = { ...prev };
            for (const proxy of chunk) {
              next[proxy] = {
                status: 'fail',
                message: msg.includes('524')
                  ? '请求超时(524)，已跳过本块'
                  : msg.slice(0, 120)
              };
            }
            return next;
          });
          totalFail += chunk.length;
        }
      }
      if (allOk.length > 0 && draft.proxyAutoSaveOnRemoveFailed && workingDraft) {
        try {
          await window.api.saveSettings(workingDraft);
          await reload();
        } catch {
          /* ignore */
        }
      }
      push({
        tone: totalFail > 0 ? 'warn' : 'ok',
        title: '代理池测活完成',
        description: `共 ${proxies.length} · 成功 ${totalOk}（已入可用池）· 失败 ${totalFail}（分块 ${CHUNK} · 并发 ${conc}${hardError ? ' · 含块错误' : ''}）`
      });
    } catch (err) {
      setProxyProbes((prev) => {
        const next = { ...prev };
        for (const e of proxyPoolEntries) {
          if (next[e.proxy]?.status === 'loading') {
            next[e.proxy] = { status: 'fail', message: String(err) };
          }
        }
        return next;
      });
      push({ tone: 'danger', title: '代理池测活失败', description: String(err) });
    } finally {
      setProbingKey(null);
    }
  };

  const removeProxiesFromDraft = (
    proxies: string[],
    which: 'pending' | 'alive' = 'pending'
  ): AppSettings | null => {
    if (!proxies.length) return null;
    const key = which === 'alive' ? 'proxyPoolAlive' : 'proxyPool';
    const nextText = removeProxiesFromPoolText(draft[key] || '', proxies);
    const nextDraft = { ...draft, [key]: nextText };
    setDraft(nextDraft);
    setProxyProbes((prev) => {
      const next = { ...prev };
      for (const p of proxies) {
        delete next[p];
        const stripped = stripProxyComment(p);
        if (stripped) delete next[stripped];
      }
      return next;
    });
    return nextDraft;
  };

  const save = async (override?: AppSettings, opts?: { silentOk?: boolean; okTitle?: string; okDesc?: string }) => {
    const payload = override || draft;
    setSaving(true);
    try {
      await window.api.saveSettings(payload);
      await reload();
      if (!opts?.silentOk) {
        push({
          tone: 'ok',
          title: opts?.okTitle || '配置已保存',
          description: opts?.okDesc
        });
      }
      return true;
    } catch (err) {
      push({ tone: 'danger', title: '保存失败', description: String(err) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const removeFailed = async () => {
    if (failedProxies.length === 0) return;
    const n = failedProxies.length;
    const nextDraft = removeProxiesFromDraft(failedProxies);
    if (draft.proxyAutoSaveOnRemoveFailed && nextDraft) {
      await save(nextDraft, {
        okTitle: '已删除失败代理并保存',
        okDesc: `已从池文本移除 ${n} 条`
      });
    } else {
      push({
        tone: 'ok',
        title: '已删除失败代理',
        description: `已从池文本移除 ${n} 条（未保存，请点保存）`
      });
    }
  };

  const removeOne = async (proxy: string) => {
    const nextDraft = removeProxiesFromDraft([proxy]);
    if (draft.proxyAutoSaveOnRemoveFailed && nextDraft) {
      await save(nextDraft, {
        okTitle: '已删除并保存',
        okDesc: proxy.slice(0, 48)
      });
    } else {
      push({ tone: 'ok', title: '已删除', description: proxy.slice(0, 48) });
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
                      label="代理池（待测）"
                      hint="粘贴待测代理；测活成功后自动移入下方「可用池」，此处只留失败/未测。支持 #备注 或 ip:port（日本，elite，HTTPS）"
                      error={errors.proxyPool}
                    >
                      <textarea
                        className={TEXTAREA_CLASS}
                        value={draft.proxyPool}
                        onChange={(e) => update('proxyPool', e.target.value)}
                        placeholder={
                          '8.216.35.12:8888（日本，elite，HTTPS）\nhttp://user:pass@1.2.3.4:8080#香港-02\nsocks5://u:p@5.6.7.8:1080#台湾-01'
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
                        onRemoveOne={(p) => void removeOne(p, 'pending')}
                      />
                    )}
                  </div>

                  {/* 可用池：默认折叠；测活成功自动迁入 */}
                  <div className="lg:col-span-2">
                    <div className="rounded-xl border border-border/60 bg-muted/30">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left"
                        onClick={() => setAlivePoolOpen((v) => !v)}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {alivePoolOpen ? (
                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="text-[13px] font-medium">可用池</span>
                          <span className="chip tabular-nums bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                            {alivePoolEntries.length}
                          </span>
                          <span className="truncate text-[12px] text-muted-foreground">
                            测活成功 · 注册优先使用
                          </span>
                        </div>
                        {alivePoolEntries.length > 0 && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 shrink-0 px-2 text-danger"
                            onClick={(e) => {
                              e.stopPropagation();
                              void clearAlivePool();
                            }}
                            title="清空可用池"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            清空
                          </Button>
                        )}
                      </button>
                      {alivePoolOpen && (
                        <div className="space-y-2 border-t border-border/50 px-3.5 pb-3.5 pt-3">
                          <p className="text-[12px] text-muted-foreground">
                            可手改/粘贴；与待测池合并写入注册（可用在前）。删除请在列表或清空。
                          </p>
                          <textarea
                            className={TEXTAREA_CLASS}
                            value={draft.proxyPoolAlive || ''}
                            onChange={(e) => update('proxyPoolAlive', e.target.value)}
                            placeholder="测活成功后自动填入…"
                            rows={4}
                          />
                          {alivePoolEntries.length > 0 && (
                            <ul className="max-h-40 space-y-1 overflow-y-auto">
                              {alivePoolEntries.map((e) => (
                                <li
                                  key={e.proxy}
                                  className="flex flex-wrap items-center gap-2 rounded-lg bg-card/80 px-2.5 py-1.5 text-[12px]"
                                >
                                  {e.label ? (
                                    <span className="chip shrink-0 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                                      {e.label}
                                    </span>
                                  ) : (
                                    <span className="chip shrink-0 text-muted-foreground">
                                      无标签
                                    </span>
                                  )}
                                  <span
                                    className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                                    title={e.proxy}
                                  >
                                    {e.host}
                                  </span>
                                  <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                    O
                                  </span>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 shrink-0 px-2 text-danger"
                                    onClick={() => void removeOne(e.proxy, 'alive')}
                                    title="从可用池删除"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <Field label="代理池模式">
                    <PoolModeSelect
                      value={draft.proxyMode}
                      onChange={(v) => update('proxyMode', v)}
                    />
                  </Field>
                  <Field
                    label="IP 使用间隔（秒）"
                    hint="同一 IP 注册一次后，间隔未到则暂停队列等待；0=不限制。优先换其它已冷却 IP"
                    error={errors.proxyIpIntervalSec}
                  >
                    <Input
                      type="number"
                      min={0}
                      max={86400}
                      value={draft.proxyIpIntervalSec ?? 0}
                      onChange={(e) =>
                        update(
                          'proxyIpIntervalSec',
                          Math.max(0, Math.min(86400, Number(e.target.value) || 0))
                        )
                      }
                      placeholder="0"
                    />
                  </Field>
                  <Field
                    label="测活并发"
                    hint="全部测活时的并发数（1～20）"
                    error={errors.proxyProbeConcurrency}
                  >
                    <div className="rounded-xl bg-muted/70 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-[12px] text-muted-foreground">并发</span>
                        <span className="chip tabular-nums">
                          {draft.proxyProbeConcurrency ?? 8}
                        </span>
                      </div>
                      <Slider
                        min={1}
                        max={20}
                        value={draft.proxyProbeConcurrency ?? 8}
                        onValueChange={(v) => update('proxyProbeConcurrency', v)}
                      />
                    </div>
                  </Field>
                  <div className="lg:col-span-2">
                    <ToggleRow
                      label="删除失败后自动保存"
                      hint="开：点删除失败/单条删除后立即写入配置；关：仅改草稿，需点保存"
                      checked={!!draft.proxyAutoSaveOnRemoveFailed}
                      onChange={(v) => update('proxyAutoSaveOnRemoveFailed', v)}
                    />
                  </div>
                </>
              )}

              <div className="lg:col-span-2">
                <ToggleRow
                  label="优先本地代理转发"
                  hint="带账号密码代理时：开则 127.0.0.1 无认证转发到上游；关则先试浏览器扩展，出口 IP 失败再兜底"
                  checked={!!draft.proxyPreferLocalForward}
                  onChange={(v) => update('proxyPreferLocalForward', v)}
                />
              </div>
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
            hint="注册成功后走授权码流程换 token，写出 xai-*.json；最新 CPA 关闭 using_api 即可用"
            checked={draft.autoAuthExport}
            onChange={(v) => update('autoAuthExport', v)}
          />
          <ToggleRow
            label="测活死号自动删除"
            hint="Auth 页/补 Auth 测活遇 401/402/403 时删除文件；开启后测活前会弹窗确认；关闭则仅标记死号"
            checked={draft.cpaProbeDeleteOnDead !== false}
            onChange={(v) => update('cpaProbeDeleteOnDead', v)}
          />
          <Field label="Auth 目录" hint="空则 DATA_DIR/auth（容器内多为 /data/auth）">
            <Input
              value={draft.authDir}
              onChange={(e) => update('authDir', e.target.value)}
              placeholder="/data/auth"
            />
          </Field>
          <Field
            label="远程 CPA 地址"
            hint="可选。Management API 根地址，如 http://host:8317（不要带 /v1）"
          >
            <Input
              value={draft.cpaRemoteUrl || ''}
              onChange={(e) => update('cpaRemoteUrl', e.target.value)}
              placeholder="http://127.0.0.1:8317"
            />
          </Field>
          <Field
            label="远程 CPA 管理密钥"
            hint="remote-management.secret-key 明文；与远程地址同时配置才上传"
          >
            <Input
              type="password"
              value={draft.cpaManagementKey || ''}
              onChange={(e) => update('cpaManagementKey', e.target.value)}
              placeholder="管理密钥明文"
              autoComplete="off"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <ConnectionTestButton
              label="检测远程连通性"
              disabled={
                !String(draft.cpaRemoteUrl || '').trim() ||
                !String(draft.cpaManagementKey || '').trim()
              }
              onTest={() =>
                window.api.testCpaRemote({
                  url: draft.cpaRemoteUrl,
                  key: draft.cpaManagementKey
                })
              }
            />
            <span className="text-[12px] text-muted-foreground">
              调用 Management API（不上传文件）
            </span>
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
          <Button onClick={() => save()} disabled={!dirty || !valid || saving} size="sm">
            <Save className="h-4 w-4" />
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
