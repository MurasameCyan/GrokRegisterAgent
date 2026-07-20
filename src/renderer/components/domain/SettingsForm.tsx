import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Github,
  KeyRound,
  Layers,
  Loader2,
  RefreshCw,
  Save,
  Terminal
} from 'lucide-react';
import { CardHeaderIcon } from '@renderer/components/domain/CardHeaderIcon';
import { MailConnectivityIcon } from '@renderer/components/domain/MailConnectivityIcon';
import { PushConnectivityIcon } from '@renderer/components/domain/PushConnectivityIcon';
import { TurnstileSolverIcon } from '@renderer/components/domain/TurnstileSolverIcon';
import { ProxyModeIcon } from '@renderer/components/domain/ProxyModeIcon';
import { Card, CardBody, CardHeader } from '@renderer/components/ui/Card';
import { Button } from '@renderer/components/ui/Button';
import { Input } from '@renderer/components/ui/Input';
import { PasswordInput } from '@renderer/components/ui/PasswordInput';
import { Slider } from '@renderer/components/ui/Slider';
import { Switch } from '@renderer/components/ui/Switch';
import { ConnectionTestButton } from '@renderer/components/domain/ConnectionTestButton';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useToastStore } from '@renderer/store/toastStore';
import type {
  AppSettings,
  CpaMintMode,
  MailProvider,
  PoolMode,
  RegisterMode
} from '@shared/settings';
import {
  DEFAULT_SETTINGS,
  enforceProxyModeMutex,
  validateSettings
} from '@shared/settings';
import type { SingBoxLogResult, SingBoxStatus } from '@shared/ipc';
import { cn } from '@renderer/lib/cn';

/** 合并默认值，避免旧 settings 缺字段 / null 导致渲染崩溃 */
function normalizeSettingsDraft(raw: AppSettings | null | undefined): AppSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>;
  const mailIn =
    r.mail && typeof r.mail === 'object'
      ? r.mail
      : ({} as Partial<AppSettings['mail']>);
  return {
    ...DEFAULT_SETTINGS,
    ...r,
    mail: {
      apiBase: String(mailIn.apiBase ?? DEFAULT_SETTINGS.mail.apiBase ?? ''),
      adminAuth: String(mailIn.adminAuth ?? DEFAULT_SETTINGS.mail.adminAuth ?? ''),
      domain: String(mailIn.domain ?? DEFAULT_SETTINGS.mail.domain ?? '')
    },
    proxy: '',
    proxyPool: '',
    proxyPoolAlive: '',
    proxyEnabled: false,
    proxyPoolEnabled: false,
    cfProxyEnabled: false,
    singBoxEnabled: !!r.singBoxEnabled,
    singBoxNodes: String(r.singBoxNodes ?? DEFAULT_SETTINGS.singBoxNodes),
    singBoxSubscriptionUrl: String(
      r.singBoxSubscriptionUrl ?? DEFAULT_SETTINGS.singBoxSubscriptionUrl ?? ''
    ),
    singBoxSelected: String(
      r.singBoxSelected || DEFAULT_SETTINGS.singBoxSelected || '__random__'
    ),
    // 固定端口，UI 不可改
    singBoxPort: 2080
  };
}

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
  onChange,
  className
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 rounded-xl bg-muted/60 px-3.5 py-3',
        className
      )}
    >
      <div className="min-w-0">
        <div className="text-[14px] font-medium leading-snug">{label}</div>
        {hint && (
          <div className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{hint}</div>
        )}
      </div>
      <Switch
        className="shrink-0"
        size="md"
        checked={checked}
        onChange={onChange}
        aria-label={label}
      />
    </div>
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
  /** 推送设置：连接设定默认折叠 */
  const [cpaConnOpen, setCpaConnOpen] = useState(false);
  const [g2ConnOpen, setG2ConnOpen] = useState(false);
  const [s2ConnOpen, setS2ConnOpen] = useState(false);
  /** 外置 Turnstile Solver：默认折叠 */
  const [solverOpen, setSolverOpen] = useState(false);
  /** sing-box 运行状态 / 日志 / 解析节点 */
  const [sbStatus, setSbStatus] = useState<SingBoxStatus | null>(null);
  const [sbBusy, setSbBusy] = useState(false);
  const [sbLog, setSbLog] = useState<SingBoxLogResult | null>(null);
  const [sbLogLoading, setSbLogLoading] = useState(false);
  const [sbLogCleared, setSbLogCleared] = useState(false);
  const [sbLogOpen, setSbLogOpen] = useState(false);
  const [sbParsedNodes, setSbParsedNodes] = useState<
    { tag: string; name: string; type: string; server: string; port: number }[]
  >([]);
  /** 订阅 URL 解析导入（URL 落在 draft.singBoxSubscriptionUrl，随配置保存） */
  const [sbSubBusy, setSbSubBusy] = useState(false);
  const [sbSubMsg, setSbSubMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data && !draft) {
      // 进页即清洗可用池历史垃圾，并补齐 CF 等新字段默认值
      setDraft(normalizeSettingsDraft(data));
    }
  }, [data, draft]);

  // 外部 data 更新时同步 draft（仅引用变化时）。
  // 注意：网页导入会先 setDraft 再 store.set，此处需能吃到最新 data。
  useEffect(() => {
    if (data) {
      setDraft(normalizeSettingsDraft(data));
    }
  }, [data]);





  /** 刷新 sing-box 状态 */
  const refreshSbStatus = async () => {
    try {
      if (typeof window.api?.getSingBoxStatus !== 'function') return;
      const st = await window.api.getSingBoxStatus();
      setSbStatus(st);
    } catch {
      /* ignore */
    }
  };

  /** 读取 sing-box 最近日志 */
  const refreshSbLog = async () => {
    try {
      if (typeof window.api?.getSingBoxLog !== 'function') return;
      setSbLogLoading(true);
      const log = await window.api.getSingBoxLog(200);
      setSbLog(log);
      setSbLogCleared(false);
    } catch (err) {
      setSbLog({
        ok: false,
        logPath: sbStatus?.logPath ?? null,
        content: '',
        truncated: false,
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setSbLogLoading(false);
    }
  };

  const copySbLog = async () => {
    const text = sbLog?.content || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      push({ tone: 'ok', title: '已复制 sing-box 日志' });
    } catch (err) {
      push({ tone: 'danger', title: '复制失败', description: String(err) });
    }
  };

  useEffect(() => {
    void refreshSbStatus();
    if (draft?.singBoxEnabled) void refreshSbLog();
    const t = window.setInterval(() => {
      if (draft?.singBoxEnabled) void refreshSbStatus();
    }, 8000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.singBoxEnabled]);

  /** draft 节点列表变化时解析 → 下拉选项 */
  useEffect(() => {
    if (!draft?.singBoxEnabled) {
      setSbParsedNodes([]);
      return;
    }
    const text = draft.singBoxNodes || '';
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (typeof window.api?.parseSingBoxNodes !== 'function') return;
          const r = await window.api.parseSingBoxNodes(text);
          if (!cancelled) setSbParsedNodes(r.nodes || []);
        } catch {
          if (!cancelled) setSbParsedNodes([]);
        }
      })();
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft?.singBoxEnabled, draft?.singBoxNodes]);

  const errors = useMemo(() => {
    if (!draft) return {} as Record<string, string>;
    try {
      return { ...validateSettings(draft) };
    } catch (err) {
      console.error('[SettingsForm] validateSettings failed', err);
      return {
        _form: err instanceof Error ? err.message : String(err)
      } as Record<string, string>;
    }
  }, [draft]);

  /** 一次改多个字段，避免连点 update 互相覆盖（推送目标开关必须用这个） */
  const patch = (partial: Partial<AppSettings>) =>
    setDraft((prev) => (prev ? { ...prev, ...partial } : prev));

  /** 仅 Sing-Box / 直连；强制关闭已移除的 CF / 普通代理 */
  const importSbSubscription = async () => {
    const url = String(draft?.singBoxSubscriptionUrl || '').trim();
    if (!url) {
      setSbSubMsg('请先填写订阅链接');
      return;
    }
    if (typeof window.api?.importSingBoxSubscription !== 'function') {
      setSbSubMsg('当前环境不支持订阅解析');
      return;
    }
    setSbSubBusy(true);
    setSbSubMsg(null);
    try {
      const r = await window.api.importSingBoxSubscription({
        url,
        mode: 'replace',
        existing: draft?.singBoxNodes || ''
      });
      if (!r?.ok) {
        setSbSubMsg(r?.message || r?.error || '解析失败');
        return;
      }
      // 写入节点列表；URL 已在 draft，点「保存」一并持久化
      update('singBoxNodes', r.nodesText || '');
      setSbSubMsg(
        (r.message || `已导入 ${(r.nodes || []).length} 个节点`) +
          '（请保存配置以持久化）'
      );
      void refreshSbStatus();
    } catch (err) {
      setSbSubMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSbSubBusy(false);
    }
  };

  const setProxyMode = (mode: 'off' | 'singbox') => {
    if (mode === 'singbox') {
      patch({
        singBoxEnabled: true,
        cfProxyEnabled: false,
        proxyEnabled: false,
        proxyPoolEnabled: false
      });
    } else {
      patch({
        singBoxEnabled: false,
        cfProxyEnabled: false,
        proxyEnabled: false,
        proxyPoolEnabled: false
      });
    }
  };


  const runSbAction = async (action: 'start' | 'stop' | 'sync') => {
    setSbBusy(true);
    try {
      const api = window.api;
      // 启动：带上当前表单节点；若未保存开关也 force 临时启用
      const r =
        action === 'start'
          ? await api.startSingBox({
              force: true,
              nodes: draft?.singBoxNodes || '',
              selected: draft?.singBoxSelected || ''
            })
          : action === 'stop'
            ? await api.stopSingBox()
            : await api.syncSingBox();
      setSbStatus(r);
      void refreshSbLog();
      if (r.lastError && !r.running) {
        push({ tone: 'danger', title: 'sing-box 异常', description: r.lastError });
      } else if (action === 'stop') {
        push({ tone: 'ok', title: '已停止 sing-box' });
      } else if (r.running) {
        push({
          tone: 'ok',
          title: 'sing-box 运行中',
          description:
            (r.localUrl || `http://127.0.0.1:${r.port}`) +
            (r.selectedName ? ` · ${r.selectedName}` : '') +
            ((r as { hint?: string }).hint ? ` · ${(r as { hint?: string }).hint}` : '')
        });
      }
    } catch (err) {
      push({ tone: 'danger', title: 'sing-box 操作失败', description: String(err) });
      void refreshSbLog();
    } finally {
      setSbBusy(false);
    }
  };

  if (!draft) {
    return <div className="p-8 text-muted-foreground">加载设置…</div>;
  }

  const dirty = !!data && JSON.stringify(data) !== JSON.stringify(draft);
  const valid = Object.keys(errors).length === 0;
  const updateMail = <K extends keyof AppSettings['mail']>(key: K, value: AppSettings['mail'][K]) =>
    setDraft({ ...draft, mail: { ...draft.mail, [key]: value } });
  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setDraft({ ...draft, [key]: value });

  const save = async (override?: AppSettings, opts?: { silentOk?: boolean; okTitle?: string; okDesc?: string }) => {
    const base = override || draft;
    let payload: AppSettings = enforceProxyModeMutex({
      ...base!,
      cfProxyEnabled: false,
      proxyEnabled: false,
      proxyPoolEnabled: false,
      proxyPool: '',
      proxyPoolAlive: '',
      proxy: ''
    });
    setSaving(true);
    try {
      await window.api.saveSettings(payload);
      setDraft(payload);
      await reload();
      void refreshSbStatus();
      if (payload.singBoxEnabled) void refreshSbLog();
      if (!opts?.silentOk) {
        push({
          tone: 'ok',
          title: opts?.okTitle || '配置已保存',
          description: opts?.okDesc
        });
      }
    } catch (err) {
      push({
        tone: 'danger',
        title: '保存失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setSaving(false);
    }
  };


  return (
    <div className="space-y-5">
      <Card collapsible defaultCollapsed>
        <CardHeader
          title="邮件设置"
          description={
            (draft.mailProvider || 'cloudflare') === 'duckmail'
              ? 'DuckMail'
              : (draft.mailProvider || 'cloudflare') === 'yyds'
                ? 'YYDS Mail'
                : (draft.mailProvider || 'cloudflare') === 'gptmail'
                  ? 'GPTMail'
                  : 'Cloudflare Temp Email'
          }
          right={
            <MailConnectivityIcon
              mail={draft.mail}
              provider={draft.mailProvider || 'cloudflare'}
              enabled={
                Boolean(String(draft.mail?.apiBase || '').trim()) &&
                (
                  (draft.mailProvider || 'cloudflare') === 'cloudflare'
                    ? Boolean(
                        String(draft.mail?.adminAuth || '').trim() ||
                          draft.cloudflareAuthMode === 'none'
                      )
                    : (draft.mailProvider || '') === 'duckmail'
                      ? true
                      : Boolean(String(draft.mail?.adminAuth || '').trim())
                )
              }
            />
          }
        />
        <CardBody className="space-y-4">
          {(() => {
            const provider = draft.mailProvider || 'cloudflare';
            const isCloudflare = provider === 'cloudflare' || !provider;
            return (
              <>
          <Field
            label="邮箱提供方"
            hint="cloudflare：支持域名池；duckmail/yyds/gptmail：由服务端分配域名，无客户端域名池接口"
          >
            <select
              className={SELECT_CLASS}
              value={provider}
              onChange={(e) => {
                const next = e.target.value as MailProvider;
                // 域名池仅 Cloudflare 可用；切到其他方案时关闭
                if (next !== 'cloudflare') {
                  patch({
                    mailProvider: next,
                    mailDomainPoolEnabled: false
                  });
                } else {
                  update('mailProvider', next);
                }
              }}
            >
              <option value="cloudflare">Cloudflare Temp Email（默认）</option>
              <option value="duckmail">DuckMail</option>
              <option value="yyds">YYDS Mail</option>
              <option value="gptmail">GPTMail</option>
            </select>
          </Field>
          {/* 连接：API + 密码 并排 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="API 地址"
              hint={
                provider === 'duckmail'
                  ? 'DuckMail API 根，如 https://api.duckmail.sbs'
                  : provider === 'yyds'
                    ? '默认 https://maliapi.215.im/v1（可改自建）'
                    : provider === 'gptmail'
                      ? '默认 https://mail.chatgpt.org.uk（站点根，勿带 /api）'
                      : 'Worker API 根地址，勿填前端 Pages 域名'
              }
              error={errors['mail.apiBase']}
            >
              <Input
                value={draft.mail.apiBase}
                onChange={(e) => updateMail('apiBase', e.target.value)}
                invalid={!!errors['mail.apiBase']}
                placeholder={
                  isCloudflare
                    ? 'https://xxx.workers.dev'
                    : provider === 'yyds'
                      ? 'https://maliapi.215.im/v1'
                      : provider === 'duckmail'
                        ? 'https://api.duckmail.sbs'
                        : provider === 'gptmail'
                          ? 'https://mail.chatgpt.org.uk'
                          : 'https://api.example.com'
                }
              />
            </Field>
            <Field
              label={
                provider === 'yyds' || provider === 'gptmail'
                  ? 'API Key（X-API-Key）'
                  : provider === 'duckmail'
                    ? 'API Token（可选）'
                    : '管理密码'
              }
              hint={
                provider === 'yyds'
                  ? 'YYDS 控制台 API Key，请求头 X-API-Key（不是 Bearer）'
                  : provider === 'gptmail'
                    ? 'GPTMail 控制台 API Key，请求头 X-API-Key（不是 Bearer）'
                    : provider === 'duckmail'
                      ? '公共 DuckMail 可不填；自建实例如需鉴权再填'
                      : draft.cloudflareAuthMode === 'none'
                        ? '匿名模式可不填'
                        : 'Temp Email 管理员密码 / API Key（随鉴权模式）'
              }
              error={errors['mail.adminAuth']}
            >
              <PasswordInput
                value={draft.mail.adminAuth}
                onChange={(e) => updateMail('adminAuth', e.target.value)}
                invalid={!!errors['mail.adminAuth']}
              />
            </Field>
          </div>
          {isCloudflare ? (
            <Field
              label="Cloudflare 鉴权模式"
              hint="admin=x-admin-auth+/admin/new_address；none=匿名+/api/new_address。调试: register/cf_mail_debug.py"
            >
              <select
                className={SELECT_CLASS}
                value={draft.cloudflareAuthMode || 'x-admin-auth'}
                onChange={(e) => update('cloudflareAuthMode', e.target.value)}
              >
                <option value="x-admin-auth">x-admin-auth（默认管理密码）</option>
                <option value="none">none（匿名 API）</option>
                <option value="bearer">bearer（Authorization）</option>
                <option value="x-api-key">x-api-key</option>
                <option value="query-key">query-key（?key=）</option>
              </select>
            </Field>
          ) : null}

          {/* 域名：仅 Cloudflare 显示域名池；其他方案可选单域名提示 */}
          {isCloudflare ? (
          <div className="space-y-3 rounded-xl border border-border/70 bg-muted/25 p-3.5">
            <ToggleRow
              label="启用域名池"
              hint="仅 Cloudflare Temp Email：多域名轮换；关=只用下方默认域名"
              checked={!!draft.mailDomainPoolEnabled}
              onChange={(v) => update('mailDomainPoolEnabled', v)}
              className="bg-card/60"
            />

            {!draft.mailDomainPoolEnabled ? (
              <Field
                label="默认邮件域名"
                hint="单域名，例如 example.com（须已在 CF Worker 绑定）"
                error={errors['mail.domain']}
              >
                <Input
                  value={draft.mail.domain}
                  onChange={(e) => updateMail('domain', e.target.value)}
                  invalid={!!errors['mail.domain']}
                  placeholder="example.com"
                />
              </Field>
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(11rem,14rem)] lg:items-start">
                <Field
                  label="邮箱域名池"
                  hint="每行一个，或逗号分隔（须均为 CF 已绑定域名）"
                  error={errors['mail.domain']}
                >
                  <textarea
                    className={cn(TEXTAREA_CLASS, 'min-h-[120px] font-mono text-[13px]')}
                    value={draft.mailDomains}
                    onChange={(e) => update('mailDomains', e.target.value)}
                    placeholder={'mail.example.com\noai.example.com'}
                    spellCheck={false}
                  />
                </Field>
                <Field label="轮换模式" hint="注册时从池中取域名">
                  <PoolModeSelect
                    value={draft.mailDomainMode}
                    onChange={(v) => update('mailDomainMode', v)}
                  />
                </Field>
              </div>
            )}
          </div>
          ) : (
          <div className="space-y-2 rounded-xl border border-border/70 bg-muted/25 p-3.5">
            <Field
              label="首选域名（可选）"
              hint={
                provider === 'yyds'
                  ? 'YYDS 由服务端分配域名（创建体 localPart）；此处一般留空'
                  : provider === 'gptmail'
                    ? 'GPTMail 可由 API 分配域名；可选填偏好域名（generate-email domain）'
                    : 'DuckMail 可从 /domains 自动取域；可选填偏好域名'
              }
              error={errors['mail.domain']}
            >
              <Input
                value={draft.mail.domain}
                onChange={(e) => updateMail('domain', e.target.value)}
                invalid={!!errors['mail.domain']}
                placeholder="可选 example.com"
              />
            </Field>
            <p className="text-[11px] leading-4 text-muted-foreground">
              域名池仅适用于 Cloudflare Temp Email。当前提供方已关闭域名池。
            </p>
          </div>
          )}
              </>
            );
          })()}
        </CardBody>
      </Card>

      <Card collapsible defaultCollapsed>
        <CardHeader
          title="代理设置"
          description={draft.singBoxEnabled ? 'Sing-Box' : '直连'}
          right={
            <ProxyModeIcon
              singBoxEnabled={!!draft.singBoxEnabled}
              status={sbStatus}
              onRefresh={refreshSbStatus}
            />
          }
        />
        <CardBody className="grid gap-4 lg:grid-cols-2">
          {/* 单行：Sing-Box | 直连 */}
          <div className="lg:col-span-2">
            <div className="flex items-center justify-end gap-3">
              <div
                role="group"
                aria-label="代理模式"
                className="inline-flex h-9 w-full max-w-[280px] rounded-full bg-muted p-0.5"
              >
                {(
                  [
                    { id: 'singbox' as const, label: 'Sing-Box' },
                    { id: 'off' as const, label: '直连' }
                  ] as const
                ).map((opt) => {
                  const active =
                    opt.id === 'singbox'
                      ? !!draft.singBoxEnabled
                      : !draft.singBoxEnabled;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setProxyMode(opt.id)}
                      className={cn(
                        'inline-flex h-full min-w-0 flex-1 items-center justify-center rounded-full px-3 text-[13px] font-semibold tracking-tight transition-all duration-150',
                        active
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* —— sing-box 独立代理面板 —— */}
          {draft.singBoxEnabled && (
            <div className="lg:col-span-2 space-y-3 rounded-xl border border-border/70 bg-muted/25 p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold tracking-tight">
                    Sing-Box 内核
                  </div>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    分享链接或 http/https/socks4/socks5 代理；也可订阅解析导入
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      'chip text-[11px]',
                      sbStatus?.running
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {sbStatus?.running
                      ? `运行中 · pid ${sbStatus.pid ?? '?'}`
                      : '未运行'}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7"
                    disabled={sbBusy}
                    onClick={() => void runSbAction('sync')}
                  >
                    {sbBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Activity className="h-3.5 w-3.5" />
                    )}
                    同步
                  </Button>
                  {sbStatus?.running ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      className="h-7"
                      disabled={sbBusy}
                      onClick={() => void runSbAction('stop')}
                    >
                      停止
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      className="h-7"
                      disabled={sbBusy}
                      onClick={() => void runSbAction('start')}
                      title="需先保存设置且开启 sing-box"
                    >
                      启动
                    </Button>
                  )}
                </div>
              </div>

              <Field
                label="订阅链接"
                hint="http(s) 订阅：支持 Base64 / 明文分享链接 / Clash YAML。URL 与解析结果均随「保存」持久化"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={draft.singBoxSubscriptionUrl || ''}
                    onChange={(e) => update('singBoxSubscriptionUrl', e.target.value)}
                    placeholder="https://example.com/api/v1/client/subscribe?token=..."
                    className="font-mono text-[13px]"
                    spellCheck={false}
                  />
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      className="h-9"
                      disabled={
                        sbSubBusy || !String(draft.singBoxSubscriptionUrl || '').trim()
                      }
                      onClick={() => void importSbSubscription()}
                      title="拉取订阅并替换当前节点列表"
                    >
                      {sbSubBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      解析
                    </Button>
                  </div>
                </div>
                {sbSubMsg && (
                  <p
                    className={cn(
                      'mt-1.5 text-[11px] leading-4',
                      sbSubMsg.includes('失败') || sbSubMsg.includes('未')
                        ? 'text-danger'
                        : 'text-muted-foreground'
                    )}
                  >
                    {sbSubMsg}
                  </p>
                )}
              </Field>

              <Field
                label="节点列表"
                hint="每行一条：ss/vmess/vless/trojan/hy2/tuic，或 http(s):// / socks5:// / socks4:// / host:port"
                error={errors.singBoxNodes}
              >
                <textarea
                  className={cn(TEXTAREA_CLASS, 'min-h-[120px] font-mono text-[13px]')}
                  value={draft.singBoxNodes || ''}
                  onChange={(e) => update('singBoxNodes', e.target.value)}
                  placeholder="vless://...  socks5://127.0.0.1:1080  http://user:pass@host:8080"
                  spellCheck={false}
                />
              </Field>

              <Field
                label="选用节点"
                hint={
                  sbParsedNodes.length
                    ? `已解析 ${sbParsedNodes.length} 个 · 随机=每轮注册重抽，失败降级轮换`
                    : '粘贴节点后自动解析'
                }
              >
                <select
                  className={SELECT_CLASS}
                  value={
                    draft.singBoxSelected === '' || !draft.singBoxSelected
                      ? '__random__'
                      : draft.singBoxSelected
                  }
                  onChange={(e) => update('singBoxSelected', e.target.value)}
                >
                  <option value="__random__">随机节点（推荐 · 注册轮换/降级）</option>
                  {sbParsedNodes.map((n) => (
                    <option key={n.tag} value={n.tag}>
                      {n.name}
                      {n.type ? ` · ${n.type}` : ''}
                      {n.server ? ` · ${n.server}:${n.port}` : ''}
                    </option>
                  ))}
                </select>
              </Field>

              {(sbStatus?.selectedName ||
                sbStatus?.selected ||
                sbStatus?.lastError ||
                (sbStatus && !sbStatus.binaryExists)) && (
                <div className="space-y-1 text-[11px] text-muted-foreground">
                  {(sbStatus?.selectedName || sbStatus?.selected) && (
                    <p>
                      当前节点：{sbStatus.selectedName || sbStatus.selected}
                      {typeof sbStatus.nodeCount === 'number'
                        ? ` · 共 ${sbStatus.nodeCount} 个`
                        : ''}
                    </p>
                  )}
                  {sbStatus?.lastError && (
                    <p className="text-danger">{sbStatus.lastError}</p>
                  )}
                  {sbStatus && !sbStatus.binaryExists && (
                    <p className="text-amber-700 dark:text-amber-300">
                      未找到 Linux sing-box 二进制。请使用 GHCR 镜像（Actions
                      构建时下载），Windows 本机无法直接启动。
                    </p>
                  )}
                </div>
              )}

              <div className="rounded-xl border border-border/60 bg-muted/40">
                <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-[12px] font-medium"
                    onClick={() => {
                      setSbLogOpen((v) => {
                        const next = !v;
                        if (next) void refreshSbLog();
                        return next;
                      });
                    }}
                    title={sbLogOpen ? '折叠日志' : '展开日志'}
                  >
                    {sbLogOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>sing-box 日志</span>
                    {sbLog?.truncated && sbLogOpen && (
                      <span className="text-[11px] text-amber-600">仅显示最近内容</span>
                    )}
                  </button>
                  {sbLogOpen ? (
                    <div className="flex items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-7"
                        disabled={sbLogLoading}
                        onClick={() => void refreshSbLog()}
                      >
                        {sbLogLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5" />
                        )}
                        刷新
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-7"
                        disabled={!sbLog?.content}
                        onClick={() => void copySbLog()}
                      >
                        <Clipboard className="h-3.5 w-3.5" />
                        复制
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-7"
                        disabled={!sbLog?.content && !sbLog?.error}
                        onClick={() => setSbLogCleared(true)}
                      >
                        清空显示
                      </Button>
                    </div>
                  ) : null}
                </div>
                {sbLogOpen ? (
                  <div className="border-t border-border/60 px-3.5 py-2.5">
                    <div className="mb-1 truncate font-mono text-[10px] text-muted-foreground">
                      {sbLog?.logPath || sbStatus?.logPath || '暂无日志路径'}
                    </div>
                    <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-[12px] border border-border/50 bg-muted/60 p-3 font-mono text-[11px] leading-5 text-foreground">
                      {sbLogCleared
                        ? '已清空当前显示，点击「刷新」重新读取日志。'
                        : sbLog?.error
                          ? `读取日志失败：${sbLog.error}`
                          : sbLog?.content ||
                            '暂无日志，保存或启动 sing-box 后刷新。'}
                    </pre>
                  </div>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <ToggleRow
                  label="SSO 验活走代理"
                  hint="经 sing-box 本地代理"
                  checked={draft.ssoCheckUseProxy !== false}
                  onChange={(v) => update('ssoCheckUseProxy', v)}
                />
                <ToggleRow
                  label="Auth 转换/重签/测活走代理"
                  hint="经 sing-box 本地代理"
                  checked={draft.cpaAuthUseProxy !== false}
                  onChange={(v) => update('cpaAuthUseProxy', v)}
                />
              </div>
            </div>
          )}

        </CardBody>
      </Card>

            <Card collapsible defaultCollapsed>
        <CardHeader
          title="注册方案"
          right={<CardHeaderIcon icon={Layers} title="注册方案" />}
          description={(() => {
            const plans: string[] = [];
            if (draft.registerPlanAEnabled !== false) plans.push('A');
            if (draft.registerPlanBEnabled !== false) plans.push('B');
            if (
              draft.registerPlanCEnabled === true ||
              draft.registerMode === 'hybrid'
            ) {
              plans.push('C');
            }
            const planText = plans.length
              ? `Plan ${plans.join(' · ')}`
              : '未启用方案';
            const fp = draft.randomFingerprint ? '随机指纹' : '固定指纹';
            const wait = draft.turnstileAutoWaitMax ?? 60;
            return `${planText} · ${fp} · Turnstile ≤${wait}s`;
          })()}
        />
        <CardBody className="space-y-3">
          <div className="rounded-xl bg-muted/70 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="field-label">人机验证 · 自动等待上限</div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  Turnstile：每次随机等待 30～{draft.turnstileAutoWaitMax ?? 60}s，再尝试点击
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
          <ToggleRow
            label="随机注册特征"
            hint="UA / 语言 / 时区 / 分辨率等指纹随机化"
            checked={draft.randomFingerprint}
            onChange={(v) => update('randomFingerprint', v)}
          />
          <ToggleRow
            label="Plan A · 浏览器主流程"
            hint="临时邮 + Drission 填表 + Turnstile（约 1～3 分钟）"
            checked={draft.registerPlanAEnabled !== false}
            onChange={(v) => {
              update('registerPlanAEnabled', v);
            }}
          />
          <ToggleRow
            label="Plan B · 拟人兜底"
            hint="重启浏览器、更长延迟、等 Turnstile 自然成功、模拟点击；CF 拦截则放弃（约 2～5 分钟）"
            checked={draft.registerPlanBEnabled !== false}
            onChange={(v) => update('registerPlanBEnabled', v)}
          />
          <ToggleRow
            label="Plan C · Hybrid 协议"
            hint="短浏览器采 token + 协议注册（约 1～2 分钟）"
            checked={
              draft.registerPlanCEnabled === true ||
              draft.registerMode === 'hybrid'
            }
            onChange={(v) => {
              patch({
                registerPlanCEnabled: v,
                registerMode: v ? 'hybrid' : 'browser'
              });
            }}
          />
          <div className="space-y-0 rounded-xl border border-border/60 bg-muted/40">
            <div className="flex items-center gap-2 px-3 py-2.5">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
                onClick={() => setSolverOpen((v) => !v)}
                aria-expanded={solverOpen}
              >
                {solverOpen ? (
                  <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-medium text-foreground">
                      外置 Turnstile Solver
                    </span>
                    <span
                      className={
                        draft.turnstileSolverEnabled === true
                          ? 'rounded-full bg-ok/15 px-2 py-0.5 text-[10px] font-medium text-ok'
                          : 'rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground'
                      }
                    >
                      {draft.turnstileSolverEnabled === true ? '已启用' : '默认关'}
                    </span>
                  </div>
                  {!solverOpen && (
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      页内失败时 HTTP 外解 · compose --profile solver
                    </div>
                  )}
                </div>
              </button>
              <TurnstileSolverIcon
                enabled={draft.turnstileSolverEnabled === true}
                url={
                  draft.turnstileSolverUrl ||
                  'http://turnstile-solver:5072'
                }
              />
            </div>
            {solverOpen && (
              <div className="space-y-3 border-t border-border/50 px-3 py-3">
                <div className="text-[12px] leading-5 text-muted-foreground">
                  可选子容器：页内 1×1 失败时 HTTP 外解。默认不拉取。启动：
                  <code className="mx-1 rounded bg-background/80 px-1">
                    docker compose --profile solver up -d
                  </code>
                  或 .env 写 COMPOSE_PROFILES=solver
                </div>
                <ToggleRow
                  label="启用外置 Solver"
                  hint="写入 config 后注册页内失败可回落；需 solver 容器在跑或可达 URL"
                  checked={draft.turnstileSolverEnabled === true}
                  onChange={(v) => update('turnstileSolverEnabled', v)}
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Solver URL"
                    hint="compose 内网默认 turnstile-solver:5072"
                  >
                    <Input
                      value={draft.turnstileSolverUrl || ''}
                      placeholder="http://turnstile-solver:5072"
                      onChange={(e) => update('turnstileSolverUrl', e.target.value)}
                    />
                  </Field>
                  <Field
                    label="YesCaptcha Key（可选）"
                    hint="有 key 时外解可走第三方"
                  >
                    <Input
                      type="password"
                      autoComplete="off"
                      value={draft.yescaptchaKey || ''}
                      placeholder="可选"
                      onChange={(e) => update('yescaptchaKey', e.target.value)}
                    />
                  </Field>
                </div>
              </div>
            )}
          </div>
        </CardBody>
      </Card>

<Card collapsible defaultCollapsed>
        <CardHeader
          title="授权管理"
          description={(() => {
            const bits: string[] = [];
            const mode = String(draft.cpaMintMode || 'pkce');
            if (mode === 'device') bits.push('Mint B');
            else if (mode === 'double' || mode === 'auto' || mode === 'merged')
              bits.push('Mint C');
            else bits.push('Mint A');
            if (draft.autoAuthExport !== false) {
              const min = draft.autoAuthDelayMinSec ?? 60;
              const max = draft.autoAuthDelayMaxSec ?? 120;
              bits.push(`自动 Auth ${min}–${max}s`);
            } else {
              bits.push('Auth 关');
            }
            if (draft.autoResignOn401 === true) bits.push('401重签');
            if (draft.resignPushRemote === true) bits.push('重签后推');
            if (draft.enableNsfw) bits.push('Nsfw');
            return bits.join(' · ');
          })()}
          right={<CardHeaderIcon icon={KeyRound} title="授权管理" />}
        />
        <CardBody className="space-y-4">
          {/* ① Mint：SSO → Auth 出号 */}
          <div className="space-y-3">
            <div className="text-[12px] font-semibold tracking-tight text-muted-foreground">
              ① Mint · SSO → Auth
            </div>
            <Field
              label="CPA Mint 模式"
              hint="A=PKCE；B=Device；C=double 各出一份并分别测活。mint 后无 grok-4.5 不进 CPA。PKCE 失败会自动 device 兜底"
            >
              <select
                className={SELECT_CLASS}
                value={
                  (draft.cpaMintMode as string) === 'auto' ||
                  (draft.cpaMintMode as string) === 'merged'
                    ? 'double'
                    : draft.cpaMintMode || 'pkce'
                }
                onChange={(e) =>
                  update('cpaMintMode', e.target.value as CpaMintMode)
                }
              >
                <option value="pkce">A · Auth Code + PKCE（推荐）</option>
                <option value="device">B · Device Flow</option>
                <option value="double">
                  C · Double（PKCE + Device 各一份，分别测活）
                </option>
              </select>
            </Field>
            <ToggleRow
              label="自动转换 Auth"
              hint="注册只交 SSO 到授权队列：延迟后后台 SSO 推送 / mint / Auth 推送，不阻塞注册"
              checked={draft.autoAuthExport}
              onChange={(v) => update('autoAuthExport', v)}
            />
            {draft.autoAuthExport !== false && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="转换延迟下限（秒）"
                    hint="拿到 SSO 后至少等待再 mint，默认 60"
                  >
                    <Input
                      type="number"
                      min={0}
                      max={3600}
                      value={draft.autoAuthDelayMinSec ?? 60}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        update(
                          'autoAuthDelayMinSec',
                          Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 60
                        );
                      }}
                    />
                  </Field>
                  <Field
                    label="转换延迟上限（秒）"
                    hint="与下限组成随机等待，默认 120（1～2 分钟）"
                  >
                    <Input
                      type="number"
                      min={0}
                      max={7200}
                      value={draft.autoAuthDelayMaxSec ?? 120}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        update(
                          'autoAuthDelayMaxSec',
                          Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 120
                        );
                      }}
                    />
                  </Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="授权队列 Worker"
                    hint="并发 mint/推送数，1～8，默认 2；高并发注册时提高吞吐"
                  >
                    <Input
                      type="number"
                      min={1}
                      max={8}
                      value={draft.authExportWorkers ?? 2}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        update(
                          'authExportWorkers',
                          Number.isFinite(n)
                            ? Math.max(1, Math.min(8, Math.floor(n)))
                            : 2
                        );
                      }}
                    />
                  </Field>
                  <Field
                    label="队列上限"
                    hint="0=2×Worker；满则入队等待，防堆积崩"
                  >
                    <Input
                      type="number"
                      min={0}
                      max={64}
                      value={draft.authExportQueueMax ?? 0}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        update(
                          'authExportQueueMax',
                          Number.isFinite(n)
                            ? Math.max(0, Math.min(64, Math.floor(n)))
                            : 0
                        );
                      }}
                    />
                  </Field>
                </div>
              </>
            )}
          </div>

          {/* ② 重签 / 保活 */}
          <div className="space-y-3 border-t border-border/50 pt-3">
            <div className="text-[12px] font-semibold tracking-tight text-muted-foreground">
              ② 重签 · 保活
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ToggleRow
                label="401 自动重签"
                hint="默认关。测活 HTTP 401 后自动 refresh→SSO 重签（不含密码重登）；建议配合代理"
                checked={draft.autoResignOn401 === true}
                onChange={(v) => update('autoResignOn401', v)}
              />
              <ToggleRow
                label="重签后推远程"
                hint="默认关。Auth 页「重签 cli/api」成功后自动推到已配置的远程 CPA；401 自动重签不推"
                checked={draft.resignPushRemote === true}
                onChange={(v) => update('resignPushRemote', v)}
              />
            </div>
            <Field
              label="重签 / 死者苏生 并发"
              hint="1～3，默认 2。Auth 页批量重签与「死者苏生」共用；过高易触发 accounts.x.ai 限流"
            >
              <Input
                type="number"
                min={1}
                max={3}
                value={
                  draft.cpaResignConcurrency == null
                    ? 2
                    : draft.cpaResignConcurrency
                }
                onChange={(e) => {
                  const n = Number(e.target.value);
                  update(
                    'cpaResignConcurrency',
                    Number.isFinite(n)
                      ? Math.min(3, Math.max(1, Math.floor(n)))
                      : 2
                  );
                }}
              />
            </Field>
          </div>

          {/* ③ 测活清理 */}
          <div className="space-y-3 border-t border-border/50 pt-3">
            <div className="text-[12px] font-semibold tracking-tight text-muted-foreground">
              ③ 测活 · 清理
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ToggleRow
                label="测活死号自动删除"
                hint="默认关。开启后 Auth 测活遇 401/402/403 才删除本地 Auth 文件；关闭则仅标记死号"
                checked={draft.cpaProbeDeleteOnDead === true}
                onChange={(v) => update('cpaProbeDeleteOnDead', v)}
              />
              <ToggleRow
                label="测活死号同步删除 SSO"
                hint="默认关。Auth 测活死号且已删 Auth 时，同步删除号池同邮箱账号（仅 accounts.json）"
                checked={draft.cpaProbeDeleteSsoOnDead === true}
                onChange={(v) => update('cpaProbeDeleteSsoOnDead', v)}
              />
            </div>
          </div>

          {/* ④ 附属特性 */}
          <div className="space-y-3 border-t border-border/50 pt-3">
            <div className="text-[12px] font-semibold tracking-tight text-muted-foreground">
              ④ 附属特性
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <ToggleRow
                label="注册后自动验活 SSO"
                hint="号池写入后请求 grok get-user，写存活/失效；默认开"
                checked={draft.autoSsoCheckOnRegister !== false}
                onChange={(v) => update('autoSsoCheckOnRegister', v)}
              />
              <ToggleRow
                label="开启 Nsfw"
                hint="授权队列 mint 后用 SSO 尝试 gRPC always_show_nsfw_content；成败均写 tag，不影响授权流水线"
                checked={!!draft.enableNsfw}
                onChange={(v) => update('enableNsfw', v)}
              />
              <ToggleRow
                label="自动转换 sub2api"
                hint="mint 成功后写 data/sub2api/（sub2api-data 官方形态，可直接导入）；默认关"
                checked={!!draft.sub2apiExportEnabled}
                onChange={(v) => update('sub2apiExportEnabled', v)}
              />
            </div>
            {/* ZDR 开关已隐藏（流程已断开，后续研究再开放）
            <ToggleRow
              label="关闭 ZDR"
              hint="注册成功后、SSO 导出前用 SSO 尝试关 Zero Retention；probe 失败标「开」，不影响导出与授权"
              checked={draft.enableDisableZdr !== false}
              onChange={(v) => update('enableDisableZdr', v)}
            />
            */}
          </div>

          {/* ⑤ 注册运行参数（与 Auth 流水线相关的长跑/收码） */}
          <div className="space-y-3 border-t border-border/50 pt-3">
            <div className="text-[12px] font-semibold tracking-tight text-muted-foreground">
              ⑤ 注册运行
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="每 N 成功重启浏览器"
                hint="长跑防泄漏；0=仅失败/首轮强制重启，默认 5"
              >
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={draft.browserRecycleEvery ?? 5}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    update(
                      'browserRecycleEvery',
                      Number.isFinite(n)
                        ? Math.max(0, Math.min(100, Math.floor(n)))
                        : 5
                    );
                  }}
                />
              </Field>
              <Field
                label="收码失败换邮箱次数"
                hint="验证码超时/邮箱失败时换邮箱重试上限，默认 3"
              >
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={draft.maxMailRetry ?? 3}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    update(
                      'maxMailRetry',
                      Number.isFinite(n)
                        ? Math.max(1, Math.min(10, Math.floor(n)))
                        : 3
                    );
                  }}
                />
              </Field>
            </div>
          </div>
        </CardBody>
      </Card>

<Card collapsible defaultCollapsed>
        <CardHeader
          title="推送设置"
          description={(() => {
            const bits: string[] = [];
            const allowSsoG2 = draft.pushSsoToGrok2api === true;
            const autoSsoG2 = draft.autoPushSsoToGrok2api === true;
            const allowAuthCpa =
              draft.pushAuthToCpa === true || draft.cpaRemotePushEnabled === true;
            const autoAuthCpa = draft.autoPushAuthToCpa === true;
            const allowSub2 = draft.pushAuthToSub2api === true;
            const autoSub2 = draft.autoPushAuthToSub2api === true;
            if (autoSsoG2) bits.push('SSO→grok2api 自动');
            else if (allowSsoG2) bits.push('SSO→grok2api 允许');
            if (autoAuthCpa) bits.push('Auth→CPA 自动');
            else if (allowAuthCpa) bits.push('Auth→CPA 允许');
            if (autoSub2) bits.push('Auth→sub2api 自动');
            else if (allowSub2) bits.push('Auth→sub2api 允许');
            return bits.length ? bits.join(' · ') : '未开启推送';
          })()}
          right={<PushConnectivityIcon draft={draft} />}
        />
        <CardBody className="space-y-4">
          {(() => {
            // 允许 / 自动 分离；grok2api 仅 SSO 通道
            const allowSsoG2 = draft.pushSsoToGrok2api === true;
            const autoSsoG2 = draft.autoPushSsoToGrok2api === true;
            const allowAuthCpa =
              draft.pushAuthToCpa === true || draft.cpaRemotePushEnabled === true;
            const autoAuthCpa = draft.autoPushAuthToCpa === true;
            const allowSub2 = draft.pushAuthToSub2api === true;
            const autoSub2 = draft.autoPushAuthToSub2api === true;
            const needG2Config = allowSsoG2 || autoSsoG2;
            const needCpaConfig = allowAuthCpa || autoAuthCpa;
            const needS2Config = allowSub2 || autoSub2;

            const setAllowSsoG2 = (on: boolean) => {
              patch({
                pushSsoToGrok2api: on,
                autoPushSsoToGrok2api: on ? draft.autoPushSsoToGrok2api === true : false,
                grok2apiAutoUpload: on
              });
            };
            const setAutoSsoG2 = (on: boolean) => {
              patch({
                autoPushSsoToGrok2api: on,
                pushSsoToGrok2api: on ? true : draft.pushSsoToGrok2api === true,
                grok2apiAutoUpload: on || draft.pushSsoToGrok2api === true
              });
            };
            const setAllowAuthCpa = (on: boolean) => {
              patch({
                pushAuthToCpa: on,
                cpaRemotePushEnabled: on,
                autoPushAuthToCpa: on ? draft.autoPushAuthToCpa === true : false
              });
            };
            const setAutoAuthCpa = (on: boolean) => {
              patch({
                autoPushAuthToCpa: on,
                pushAuthToCpa: on ? true : draft.pushAuthToCpa === true,
                cpaRemotePushEnabled: on
                  ? true
                  : draft.pushAuthToCpa === true || draft.cpaRemotePushEnabled === true
              });
            };
            const setAllowSub2 = (on: boolean) => {
              patch({
                pushAuthToSub2api: on,
                autoPushAuthToSub2api: on ? draft.autoPushAuthToSub2api === true : false
              });
            };
            const setAutoSub2 = (on: boolean) => {
              patch({
                autoPushAuthToSub2api: on,
                pushAuthToSub2api: on ? true : draft.pushAuthToSub2api === true
              });
            };
            /**
             * 推送「允许/自动」：
             * - 固定宽高（非 min-w），三条通道同一尺寸
             * - pair 右对齐固定总宽，行布局统一 justify-between
             */
            const PUSH_BTN =
              'inline-flex h-8 w-[10.75rem] shrink-0 items-center justify-center rounded-xl border px-2 text-[12px] leading-none tabular-nums transition-colors';
            const targetBtn = (
              active: boolean,
              label: string,
              onClick: () => void,
              title: string
            ) => (
              <button
                type="button"
                title={title}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onClick();
                }}
                className={
                  active
                    ? `${PUSH_BTN} border-emerald-500/40 bg-emerald-500/15 font-semibold text-emerald-700 dark:text-emerald-400`
                    : `${PUSH_BTN} border-border bg-background font-medium text-muted-foreground hover:bg-muted hover:text-foreground`
                }
              >
                <span className="truncate">{label}</span>
              </button>
            );
            const pair = (
              allow: boolean,
              auto: boolean,
              onAllow: (v: boolean) => void,
              onAuto: (v: boolean) => void,
              name: string
            ) => (
              <div className="grid w-[22rem] shrink-0 grid-cols-2 gap-1.5">
                {targetBtn(
                  allow,
                  `${name} 允许`,
                  () => onAllow(!allow),
                  allow
                    ? `关闭「${name} 允许」`
                    : `开启「${name} 允许」（可手动推/填连接）`
                )}
                {targetBtn(
                  auto,
                  `${name} 自动`,
                  () => onAuto(!auto),
                  auto
                    ? `关闭「${name} 自动」`
                    : `开启「${name} 自动」（注册成功后推送，会同时开允许）`
                )}
              </div>
            );
            /** 左文案 + 右按钮对：三行同一骨架，按钮列竖线对齐 */
            const channelRow = (
              title: string,
              hint: string | null,
              pairNode: ReactNode,
              opts?: { borderTop?: boolean }
            ) => (
              <div
                className={
                  opts?.borderTop
                    ? 'flex items-center justify-between gap-3 border-t border-border/50 pt-2.5'
                    : 'flex items-center justify-between gap-3'
                }
              >
                <div className="min-w-0 flex-1 pr-2">
                  <div className="truncate text-[13px] font-medium leading-tight text-foreground">
                    {title}
                  </div>
                  {hint ? (
                    <div className="mt-0.5 truncate text-[11px] leading-tight text-muted-foreground">
                      {hint}
                    </div>
                  ) : null}
                </div>
                {pairNode}
              </div>
            );
            return (
              <>
                {/* SSO 推送 */}
                <div className="rounded-xl border border-border/70 bg-muted/30 p-3">
                  {channelRow(
                    'SSO · grok2api',
                    'Cookie / 号池 sso — 仅 grok2api',
                    pair(allowSsoG2, autoSsoG2, setAllowSsoG2, setAutoSsoG2, 'SSO→grok2api')
                  )}
                </div>

                {/* Auth 推送：行骨架与 SSO 一致，按钮右缘对齐 */}
                <div className="space-y-2.5 rounded-xl border border-border/70 bg-muted/30 p-3">
                  <div>
                    <div className="text-[13px] font-medium text-foreground">Auth</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      本地 xai-*.json — CPA / sub2api（grok2api 仅走上方 SSO）
                    </div>
                  </div>
                  {channelRow(
                    'CPA',
                    null,
                    pair(allowAuthCpa, autoAuthCpa, setAllowAuthCpa, setAutoAuthCpa, 'Auth→CPA'),
                    { borderTop: true }
                  )}
                  {channelRow(
                    'sub2api',
                    null,
                    pair(allowSub2, autoSub2, setAllowSub2, setAutoSub2, 'Auth→sub2api'),
                    { borderTop: true }
                  )}
                </div>

                {/* CPA 连接（Auth→CPA 启用时展开）— 与上方 Auth 推送块同壳 */}
                {needCpaConfig && (
                  <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-3">
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 text-left"
                      onClick={() => setCpaConnOpen((v) => !v)}
                      aria-expanded={cpaConnOpen}
                    >
                      {cpaConnOpen ? (
                        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-foreground">
                          CPA 连接设定
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          Management API · 远程 CPA 推送目标
                        </div>
                      </div>
                    </button>
                    {cpaConnOpen && (
                    <div className="space-y-3 border-t border-border/50 pt-3">
                      <Field
                        label="远程 CPA 地址"
                        hint="Management API 根地址"
                      >
                        <Input
                          value={draft.cpaRemoteUrl || ''}
                          onChange={(e) => update('cpaRemoteUrl', e.target.value)}
                          placeholder="http://127.0.0.1:8317"
                        />
                      </Field>
                      <Field
                        label="远程 CPA 管理密钥"
                        hint="remote-management.secret-key 明文"
                      >
                        <Input
                          type="password"
                          value={draft.cpaManagementKey || ''}
                          onChange={(e) =>
                            update('cpaManagementKey', e.target.value)
                          }
                          placeholder="管理密钥明文"
                          autoComplete="off"
                        />
                      </Field>
                      <div className="flex flex-wrap items-center gap-3">
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
                      </div>
                    </div>
                    )}
                  </div>
                )}

                {/* grok2api 连接（任一 grok2api 目标启用时展开）— 与上方 Auth 推送块同壳 */}
                {needG2Config && (
                  <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-3">
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 text-left"
                      onClick={() => setG2ConnOpen((v) => !v)}
                      aria-expanded={g2ConnOpen}
                    >
                      {g2ConnOpen ? (
                        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-foreground">
                          grok2api 连接设定
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          SSO / Auth 共用 · 管理面板根地址与账号
                        </div>
                      </div>
                    </button>
                    {g2ConnOpen && (
                    <div className="space-y-3 border-t border-border/50 pt-3">
                      <Field label="grok2api URL" hint="管理面板根地址">
                        <Input
                          value={draft.grok2apiUrl || ''}
                          onChange={(e) => update('grok2apiUrl', e.target.value)}
                          placeholder="http://127.0.0.1:8000"
                        />
                      </Field>
                      <Field label="grok2api 用户名">
                        <Input
                          value={draft.grok2apiUsername || ''}
                          onChange={(e) =>
                            update('grok2apiUsername', e.target.value)
                          }
                          placeholder="admin"
                          autoComplete="off"
                        />
                      </Field>
                      <Field label="grok2api 密码">
                        <Input
                          type="password"
                          value={draft.grok2apiPassword || ''}
                          onChange={(e) =>
                            update('grok2apiPassword', e.target.value)
                          }
                          placeholder="密码"
                          autoComplete="off"
                        />
                      </Field>
                      <div className="flex flex-wrap items-center gap-3">
                        <ConnectionTestButton
                          label="检测远程连通性"
                          disabled={
                            !String(draft.grok2apiUrl || '').trim() ||
                            !String(draft.grok2apiUsername || '').trim() ||
                            !String(draft.grok2apiPassword || '').trim()
                          }
                          onTest={() =>
                            window.api.testGrok2apiRemote({
                              url: draft.grok2apiUrl,
                              username: draft.grok2apiUsername,
                              password: draft.grok2apiPassword
                            })
                          }
                        />
                      </div>
                    </div>
                    )}
                  </div>
                )}

                {/* sub2api 连接 */}
                {needS2Config && (
                  <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-3">
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 text-left"
                      onClick={() => setS2ConnOpen((v) => !v)}
                      aria-expanded={s2ConnOpen}
                    >
                      {s2ConnOpen ? (
                        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-medium text-foreground">
                          sub2api 连接设定
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          Admin Bearer · mint/手动推送前会转 platform=grok
                        </div>
                      </div>
                    </button>
                    {s2ConnOpen && (
                    <div className="space-y-3 border-t border-border/50 pt-3">
                      <Field
                        label="sub2api 地址"
                        hint="服务根地址，如 https://sub2api.example.com（不要带 /api/v1）"
                      >
                        <Input
                          value={draft.sub2apiRemoteUrl || ''}
                          onChange={(e) => update('sub2apiRemoteUrl', e.target.value)}
                          placeholder="https://sub2api.example.com"
                        />
                      </Field>
                      <Field
                        label="Admin Token"
                        hint="推荐填 Admin API Key（admin-...，走 x-api-key）；也可填管理端登录 JWT（自动 Bearer）。不要带「Bearer 」前缀"
                      >
                        <Input
                          type="password"
                          value={draft.sub2apiAdminToken || ''}
                          onChange={(e) => update('sub2apiAdminToken', e.target.value)}
                          placeholder="admin-... 或 JWT"
                          autoComplete="off"
                        />
                      </Field>
                      <div className="flex flex-wrap items-center gap-3">
                        <ConnectionTestButton
                          label="检测远程连通性"
                          disabled={
                            !String(draft.sub2apiRemoteUrl || '').trim() ||
                            !String(draft.sub2apiAdminToken || '').trim()
                          }
                          onTest={() =>
                            window.api.testSub2apiRemote({
                              url: draft.sub2apiRemoteUrl,
                              token: draft.sub2apiAdminToken
                            })
                          }
                        />
                      </div>
                    </div>
                    )}
                  </div>
                )}

              </>
            );
          })()}
        </CardBody>
      </Card>

      <div className="sticky bottom-4 z-10 flex justify-end">
        <div
          className={cn(
            'flex items-center gap-3 rounded-[14px] border border-border bg-card px-3 py-2 shadow-[var(--ios-shadow)]'
          )}
        >
          <span
            className="max-w-[14rem] truncate px-1 text-[12px] font-medium text-muted-foreground"
            title={
              !valid
                ? Object.entries(errors)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\n')
                : dirty
                  ? '有未保存更改'
                  : '已与服务器同步'
            }
          >
            {dirty
              ? valid
                ? '未保存'
                : `校验失败: ${Object.values(errors)[0] || ''}`
              : '已同步'}
          </span>
          <Button
            onClick={() => {
              if (!valid) {
                const first = Object.entries(errors)[0];
                push({
                  tone: 'warn',
                  title: '无法保存',
                  description: first ? `${first[0]}: ${first[1]}` : '校验未通过'
                });
                return;
              }
              void save();
            }}
            disabled={!dirty || saving}
            size="sm"
          >
            <Save className="h-4 w-4" />
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
