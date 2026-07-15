import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Download,
  Github,
  KeyRound,
  Loader2,
  Save,

  Trash2,
  X
} from 'lucide-react';
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
  ProxyPoolEntry,
  RegisterMode
} from '@shared/settings';
import {
  appendProxiesToPoolTextDetailed,
  buildCfLocalProxyUrl,
  moveProxiesToAlivePool,
  parseProxyPoolEntries,
  proxySchemeBadgeLabel,
  removeProxiesFromPoolText,
  sanitizeProxyPoolText,
  stripProxyComment,
  validateSettings
} from '@shared/settings';
import type { CfProxyStatus } from '@shared/ipc';
import { cn } from '@renderer/lib/cn';

/** 行内协议徽章着色：HTTP 蓝 / SOCKS5 紫 / SOCKS4 橙 / HTTPS 青 */
function proxySchemeChipClass(scheme?: string): string {
  const s = String(scheme || 'http').toLowerCase();
  if (s === 'socks5' || s === 'socks5h') {
    return 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-500/25';
  }
  if (s === 'socks4' || s === 'socks4a') {
    return 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/25';
  }
  if (s === 'https') {
    return 'bg-cyan-500/15 text-cyan-800 dark:text-cyan-300 border border-cyan-500/25';
  }
  // http 默认
  return 'bg-sky-500/15 text-sky-800 dark:text-sky-300 border border-sky-500/25';
}

function ProxySchemeBadge({ scheme }: { scheme?: string }) {
  const sch = scheme || 'http';
  return (
    <span
      className={cn(
        'chip shrink-0 px-1.5 py-0 text-[10px] font-semibold tracking-wide',
        proxySchemeChipClass(sch)
      )}
      title={`协议 ${proxySchemeBadgeLabel(sch)}（${sch}://）`}
    >
      {proxySchemeBadgeLabel(sch)}
    </span>
  );
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
  onRemoveOne
}: {
  entries: ProxyPoolEntry[];
  probes: Record<string, ProxyProbeUi>;
  probingKey: string | null;
  failCount: number;
  onProbeOne: (proxy: string) => void;
  /** 批量删除/全部测活仅用折叠条顶部按钮，此处不再重复 */
  onRemoveOne: (proxy: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-border/60 bg-muted/40 p-3">
      <p className="text-[12px] text-muted-foreground">
        已识别 {entries.length} 条
        {failCount > 0 ? ` · 失败 ${failCount}` : ''}
      </p>
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
              <ProxySchemeBadge scheme={e.scheme} />
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
                  disabled={loading}
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
                disabled={loading}
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
  /** 待定池折叠（与可用池同风格） */
  const [pendingPoolOpen, setPendingPoolOpen] = useState(true);
  const [fetchingProxies, setFetchingProxies] = useState(false);
  /** 拉列表时是否走当前 HTTP 代理（被墙时） */
  const [fetchViaProxy, setFetchViaProxy] = useState(false);
  /** hide.mn 翻页数（每页约 64 条） */
  const [fetchPages, setFetchPages] = useState(1);
  /** 网页拉取结果条（持久展示，避免 toast 一闪而过看不清） */
  const [fetchResult, setFetchResult] = useState<{
    tone: 'ok' | 'warn' | 'danger' | 'info';
    title: string;
    detail: string;
  } | null>(null);
  const pendingPoolRef = useRef<HTMLTextAreaElement | null>(null);
  /** CF cfwp 运行状态（必须在 early return 前声明 hooks） */
  const [cfStatus, setCfStatus] = useState<CfProxyStatus | null>(null);
  const [cfBusy, setCfBusy] = useState(false);

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

  /** 刷新 CF cfwp 状态（hooks 必须在 early return 之前） */
  const refreshCfStatus = async () => {
    try {
      if (typeof window.api?.getCfProxyStatus !== 'function') return;
      const st = await window.api.getCfProxyStatus();
      setCfStatus(st);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void refreshCfStatus();
    const t = window.setInterval(() => {
      if (draft?.cfProxyEnabled) void refreshCfStatus();
    }, 8000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.cfProxyEnabled]);

  const errors = useMemo(() => {
    if (!draft) return {} as Record<string, string>;
    const e = { ...validateSettings(draft) };
    // 代理池允许空：不因待测/可用均为空而拦截保存
    delete e.proxyPool;
    delete e.proxyPoolAlive;
    return e;
  }, [draft]);

  const proxyPoolEntries = useMemo(() => {
    if (!draft?.proxyPool) return [] as ProxyPoolEntry[];
    return parseProxyPoolEntries(draft.proxyPool);
  }, [draft?.proxyPool]);

  const alivePoolEntries = useMemo(() => {
    if (!draft?.proxyPoolAlive) return [] as ProxyPoolEntry[];
    const list = parseProxyPoolEntries(draft.proxyPoolAlive);
    // 成功次数多的排前，便于扫「#成功N」
    return list.slice().sort((a, b) => (b.successCount || 0) - (a.successCount || 0));
  }, [draft?.proxyPoolAlive]);

  const aliveSuccessTotal = useMemo(
    () =>
      alivePoolEntries.reduce(
        (sum, e) => sum + (typeof e.successCount === 'number' ? e.successCount : 0),
        0
      ),
    [alivePoolEntries]
  );

  const failedProxies = useMemo(() => {
    return proxyPoolEntries
      .filter((e) => proxyProbes[e.proxy]?.status === 'fail')
      .map((e) => e.proxy);
  }, [proxyPoolEntries, proxyProbes]);

  const failedAliveProxies = useMemo(() => {
    return alivePoolEntries
      .filter((e) => proxyProbes[e.proxy]?.status === 'fail')
      .map((e) => e.proxy);
  }, [alivePoolEntries, proxyProbes]);

  /** 一次改多个字段，避免连点 update 互相覆盖（推送目标开关必须用这个） */
  const patch = (partial: Partial<AppSettings>) =>
    setDraft((prev) => (prev ? { ...prev, ...partial } : prev));

  /** 开 CF → 关普通/池；开普通 → 关 CF */
  const setProxyMode = (mode: 'off' | 'normal' | 'cf') => {
    if (mode === 'cf') {
      patch({
        cfProxyEnabled: true,
        proxyEnabled: false,
        proxyPoolEnabled: false
      });
    } else if (mode === 'normal') {
      patch({
        cfProxyEnabled: false,
        proxyEnabled: true
      });
    } else {
      patch({
        cfProxyEnabled: false,
        proxyEnabled: false,
        proxyPoolEnabled: false
      });
    }
  };

  const runCfAction = async (action: 'start' | 'stop' | 'sync') => {
    setCfBusy(true);
    try {
      const api = window.api;
      const r =
        action === 'start'
          ? await api.startCfProxy()
          : action === 'stop'
            ? await api.stopCfProxy()
            : await api.syncCfProxy();
      setCfStatus(r);
      if (r.lastError && !r.running) {
        push({ tone: 'danger', title: 'CF 代理异常', description: r.lastError });
      } else if (action === 'stop') {
        push({ tone: 'ok', title: '已停止 CF 代理' });
      } else if (r.running) {
        push({
          tone: 'ok',
          title: 'CF 代理运行中',
          description: r.localUrl || `127.0.0.1:${r.port}`
        });
      }
    } catch (err) {
      push({ tone: 'danger', title: 'CF 代理操作失败', description: String(err) });
    } finally {
      setCfBusy(false);
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

  /** 从网页拉取代理并追加到待测池（默认 hide.mn） */
  const fetchProxiesFromWeb = async () => {
    if (!draft) return;
    const url = String(
      draft.proxyFetchUrl || 'https://hide.mn/en/proxy-list/'
    ).trim();
    if (!/^https?:\/\//i.test(url)) {
      const msg = 'URL 须以 http(s):// 开头';
      setFetchResult({ tone: 'danger', title: '拉取失败', detail: msg });
      push({ tone: 'warn', title: '拉取失败', description: msg });
      return;
    }
    if (fetchViaProxy && !String(draft.proxy || '').trim()) {
      const msg = '已勾选「经代理拉取」，请先填写上方 HTTP 代理，或关闭该开关直连';
      setFetchResult({ tone: 'warn', title: '未配置 HTTP 代理', detail: msg });
      push({ tone: 'warn', title: '未配置 HTTP 代理', description: msg });
      return;
    }
    setFetchingProxies(true);
    setFetchResult({
      tone: 'info',
      title: '正在拉取…',
      detail: `${url}${fetchPages > 1 ? ` · ${fetchPages} 页` : ''}${fetchViaProxy ? ' · 经代理' : ''}`
    });
    try {
      const r = await window.api.fetchProxiesFromUrl({
        url,
        viaProxy: fetchViaProxy,
        pages: fetchPages
      });
      if (!r.ok || !r.lines?.length) {
        const detail =
          (r.message || '未解析到代理') +
          (fetchViaProxy ? '' : ' · 若本机打不开 hide.mn，可开「经 HTTP 代理拉取」');
        setFetchResult({ tone: 'danger', title: '拉取失败 · 未写入池', detail });
        push({
          tone: 'danger',
          title: '拉取失败 · 未写入池',
          description: detail,
          duration: 10000
        });
        return;
      }

      const beforeEntries = parseProxyPoolEntries(draft.proxyPool).length;
      // 待定池可写导入戳；可用池绝对不走此路径
      const append = appendProxiesToPoolTextDetailed(
        draft.proxyPool || '',
        r.lines,
        r.lines.join('\n'),
        { stamp: true }
      );
      const afterEntries = parseProxyPoolEntries(append.text).length;
      // 以实际解析条数为准（比 added 更直观）
      const delta = Math.max(0, afterEntries - beforeEntries);
      const added = Math.max(append.added, delta);

      if (added <= 0) {
        const detail =
          `解析到 ${r.count} 条，但待测池无新增` +
          (append.skipped > 0 ? `（已存在跳过 ${append.skipped}` : '（') +
          (append.invalid > 0 ? ` · 无效 ${append.invalid}` : '') +
          (append.skipped > 0 || append.invalid > 0 ? '）' : '）') +
          ` · 当前待测 ${afterEntries} 条` +
          (r.sample?.length ? ` · 例 ${r.sample[0]}` : '');
        setFetchResult({
          tone: 'warn',
          title: '拉取完成 · 无新条目写入',
          detail
        });
        push({
          tone: 'warn',
          title: '拉取完成 · 无新条目',
          description: detail,
          duration: 9000
        });
        // 仍更新 URL 记忆
        setDraft({ ...draft, proxyFetchUrl: url });
        return;
      }

      const nextDraft = {
        ...draft,
        proxyPool: append.text,
        proxyFetchUrl: url
      };
      setDraft(nextDraft);

      // 立即落盘，避免「看起来入了 / 一刷新就没了」
      let saved = false;
      try {
        await window.api.saveSettings(nextDraft);
        // 用 store.set 同步 data，避免 reload 竞态把 draft 打回旧值
        useSettingsStore.getState().set(nextDraft);
        saved = true;
      } catch {
        saved = false;
      }

      const detail =
        `新增 ${added} 条 → 待定池现 ${afterEntries} 条` +
        (append.skipped > 0 ? ` · 跳过重复 ${append.skipped}` : '') +
        (r.pagesFetched && r.pagesFetched > 1 ? ` · 抓取 ${r.pagesFetched} 页` : '') +
        (r.sample?.length ? ` · 例 ${r.sample.slice(0, 2).join(' | ')}` : '') +
        (saved
          ? ' · 已自动保存 · 请在「待定池」点全部测活（三绿进可用池）'
          : ' · 自动保存失败，请手动点右下角「保存」');

      setFetchResult({
        tone: saved ? 'ok' : 'warn',
        title: saved
          ? `网页导入成功 · 已写入待定池并保存 +${added}`
          : `已写入待定池 +${added}（未保存）`,
        detail
      });
      push({
        tone: saved ? 'ok' : 'warn',
        title: saved ? `已入待定池并保存 +${added}` : `已入待定池 +${added}（请手动保存）`,
        description: detail,
        duration: 12000
      });
      setPendingPoolOpen(true);

      // 滚到待测池文本框，让用户立刻看到内容
      requestAnimationFrame(() => {
        const el = pendingPoolRef.current;
        if (!el) return;
        el.focus();
        el.scrollTop = el.scrollHeight;
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setFetchResult({ tone: 'danger', title: '拉取异常 · 未写入池', detail });
      push({
        tone: 'danger',
        title: '拉取异常 · 未写入池',
        description: detail,
        duration: 10000
      });
    } finally {
      setFetchingProxies(false);
    }
  };

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
        // 去掉 HTML 碎片（旧版把错误页正文拼进 message）
        const cleanMsg = String(r.message || '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160);
        push({
          tone: 'ok',
          title: '测活成功 → 已移入可用池',
          description: cleanMsg || proxy.slice(0, 48),
          duration: 6000
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

    // 分块测活：单条正常、批量全灭多为高并发打爆 xAI/CF。
    // 块更小、并发更低；结果按 proxy 字段对齐，避免 index 错位。
    const CHUNK = 8;
    const conc = Math.max(1, Math.min(3, Number(draft.proxyProbeConcurrency) || 3));
    const timeoutMs = 10000;
    const proxies = proxyPoolEntries.map((e) => e.proxy);
    let totalOk = 0;
    let totalFail = 0;
    let hardError: string | null = null;
    const allOk: string[] = [];
    let workingDraft = draft;

    /** 块内按 proxy 对齐结果；块 HTTP 失败则回退串行单条（与单测同一路径） */
    const probeChunk = async (
      chunk: string[]
    ): Promise<Array<{ proxy: string; ok: boolean; message: string }>> => {
      try {
        const batch = await window.api.testProxyBatch({
          proxies: chunk,
          concurrency: conc,
          timeoutMs
        });
        const byKey = new Map<string, { ok: boolean; message: string }>();
        const indexResult = (key: string, ok: boolean, message: string) => {
          const k = String(key || '').trim();
          if (!k) return;
          const row = { ok, message };
          byKey.set(k, row);
          byKey.set(k.replace(/^https?:\/\//i, ''), row);
          try {
            const u = new URL(k.includes('://') ? k : `http://${k}`);
            const hp = `${u.hostname}:${u.port || '80'}`;
            byKey.set(hp, row);
            byKey.set(`http://${hp}`, row);
          } catch {
            /* ignore */
          }
        };
        for (let i = 0; i < (batch.results || []).length; i++) {
          const r = batch.results[i];
          const ok = Boolean(r?.ok);
          const message = String(r?.message || (ok ? 'ok' : '失败'));
          indexResult(String(r?.proxy || ''), ok, message);
          // 保序：也用请求侧原始串索引
          if (chunk[i]) indexResult(chunk[i], ok, message);
        }
        return chunk.map((proxy, i) => {
          const r =
            byKey.get(proxy) ||
            byKey.get(proxy.replace(/^https?:\/\//i, '')) ||
            (batch.results?.[i]
              ? {
                  ok: Boolean(batch.results[i].ok),
                  message: String(batch.results[i].message || '失败')
                }
              : null);
          if (r) {
            return {
              proxy,
              ok: Boolean(r.ok),
              message: String(r.message || '失败')
            };
          }
          return { proxy, ok: false, message: '无测活结果' };
        });
      } catch (err) {
        const msg = String(err);
        hardError = msg;
        // 整块 HTTP 失败：回退逐条 testProxy（与「单条测活」一致）
        const out: Array<{ proxy: string; ok: boolean; message: string }> = [];
        for (const proxy of chunk) {
          try {
            const r = await window.api.testProxy(proxy);
            out.push({
              proxy,
              ok: Boolean(r.ok),
              message: String(r.message || (r.ok ? 'ok' : '失败'))
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 160)
            });
          } catch (e2) {
            out.push({
              proxy,
              ok: false,
              message: msg.includes('524')
                ? '请求超时(524)，单条回退仍失败'
                : String(e2).slice(0, 120)
            });
          }
        }
        return out;
      }
    };

    try {
      for (let offset = 0; offset < proxies.length; offset += CHUNK) {
        const chunk = proxies.slice(offset, offset + CHUNK);
        const chunkNo = Math.floor(offset / CHUNK) + 1;
        const chunkTotal = Math.ceil(proxies.length / CHUNK);
        const rows = await probeChunk(chunk);
        const chunkOk: string[] = [];
        setProxyProbes((prev) => {
          const next = { ...prev };
          for (const row of rows) {
            if (row.ok) {
              chunkOk.push(row.proxy);
              delete next[row.proxy];
            } else {
              next[row.proxy] = {
                status: 'fail',
                message: row.message || '失败'
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
        const chunkFail = Math.max(0, chunk.length - chunkOk.length);
        totalOk += chunkOk.length;
        totalFail += chunkFail;
        if (chunkNo === chunkTotal || chunkNo % 2 === 0) {
          push({
            tone: totalOk > 0 ? 'ok' : 'warn',
            title: `测活进度 ${chunkNo}/${chunkTotal}`,
            description: `已完成 ${Math.min(offset + chunk.length, proxies.length)}/${proxies.length} · 成功 ${totalOk} · 失败 ${totalFail}`
          });
        }
        // 块间稍歇，降低 xAI/CF 限流导致「全灭」
        if (offset + CHUNK < proxies.length) {
          await new Promise((r) => window.setTimeout(r, 400));
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
      const aliveNow = parseProxyPoolEntries(workingDraft?.proxyPoolAlive || '').length;
      const pendingNow = parseProxyPoolEntries(workingDraft?.proxyPool || '').length;
      push({
        tone: totalFail > 0 ? 'warn' : 'ok',
        title: '代理池测活完成',
        description:
          `共测 ${proxies.length} · 成功 ${totalOk}（已迁入「可用池」）· 失败 ${totalFail}` +
          ` · 可用池 ${aliveNow} · 待定剩 ${pendingNow}` +
          `（分块 ${CHUNK} · 并发 ${conc}${hardError ? ' · 含块错误' : ''}）` +
          (totalOk > 0 ? ' · 待定变少是迁入可用，正常' : ''),
        duration: 12000
      });
      if (totalOk > 0) {
        setFetchResult({
          tone: 'ok',
          title: `测活完成 · ${totalOk} 条已进可用池`,
          detail: `失败 ${totalFail} 仍在待测 · 可用池现 ${aliveNow} 条 · 请确认已保存`
        });
        setAlivePoolOpen(true);
      }
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
    let nextText = removeProxiesFromPoolText(draft[key] || '', proxies);
    // 可用池删除后顺带清掉 # 注释垃圾行
    if (which === 'alive') nextText = sanitizeProxyPoolText(nextText);
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
    const base = override || draft;
    // 持久化前强制清洗可用池：禁止 # 网页导入 等垃圾写入 settings
    // CF 与普通代理/池互斥
    let payload: AppSettings = {
      ...base!,
      proxyPoolAlive: sanitizeProxyPoolText(base!.proxyPoolAlive || '')
    };
    if (payload.cfProxyEnabled) {
      payload = { ...payload, proxyEnabled: false, proxyPoolEnabled: false };
    }
    setSaving(true);
    try {
      await window.api.saveSettings(payload);
      setDraft(payload);
      await reload();
      // 保存后服务端会 sync cfwp；刷新状态条
      void refreshCfStatus();
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

  const removeFailed = async (which: 'pending' | 'alive' = 'pending') => {
    const list = which === 'alive' ? failedAliveProxies : failedProxies;
    if (list.length === 0) return;
    const n = list.length;
    const nextDraft = removeProxiesFromDraft(list, which);
    if (!nextDraft) return;
    if (draft.proxyAutoSaveOnRemoveFailed) {
      await save(nextDraft, {
        okTitle: which === 'alive' ? '已从可用池删除失败项并保存' : '已删除失败代理并保存',
        okDesc: `已移除 ${n} 条`
      });
    } else {
      push({
        tone: 'ok',
        title: which === 'alive' ? '已从可用池删除失败项' : '已删除失败代理',
        description: `已移除 ${n} 条（未保存，请点保存）`
      });
    }
  };

  const removeOne = async (proxy: string, which: 'pending' | 'alive' = 'pending') => {
    const nextDraft = removeProxiesFromDraft([proxy], which);
    if (!nextDraft) return;
    if (draft.proxyAutoSaveOnRemoveFailed) {
      await save(nextDraft, {
        okTitle: '已删除并保存',
        okDesc: proxy.slice(0, 48)
      });
    } else {
      push({
        tone: 'ok',
        title: '已删除',
        description: `${proxy.slice(0, 48)}（未保存，请点保存）`
      });
    }
  };

  /** 可用池单条测活：失败则标红，成功保持；失败不自动移出 */
  const probeOneAlive = async (proxy: string) => {
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
      if (r.ok) {
        push({ tone: 'ok', title: '可用池测活 OK', description: r.message || proxy.slice(0, 48) });
      } else {
        push({
          tone: 'warn',
          title: '可用池测活失败',
          description: r.message || '可点删除移除此项'
        });
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

  const probeAllAlive = async () => {
    if (alivePoolEntries.length === 0) return;
    setProbingKey('__alive_all__');
    const loadingMap: Record<string, ProxyProbeUi> = {};
    for (const e of alivePoolEntries) loadingMap[e.proxy] = { status: 'loading' };
    setProxyProbes((prev) => ({ ...prev, ...loadingMap }));
    const CHUNK = 24;
    const conc = Math.max(1, Math.min(12, Number(draft.proxyProbeConcurrency) || 8));
    const proxies = alivePoolEntries.map((e) => e.proxy);
    let totalOk = 0;
    let totalFail = 0;
    try {
      for (let offset = 0; offset < proxies.length; offset += CHUNK) {
        const chunk = proxies.slice(offset, offset + CHUNK);
        try {
          const batch = await window.api.testProxyBatch({
            proxies: chunk,
            concurrency: conc,
            timeoutMs: 6000
          });
          setProxyProbes((prev) => {
            const next = { ...prev };
            for (let i = 0; i < chunk.length; i++) {
              const proxy = chunk[i];
              const r = batch.results[i];
              next[proxy] = {
                status: r?.ok ? 'ok' : 'fail',
                message: r?.message || (r?.ok ? 'OK' : '失败')
              };
            }
            return next;
          });
          totalOk += batch.ok || 0;
          totalFail += batch.fail || 0;
        } catch (err) {
          const msg = String(err);
          setProxyProbes((prev) => {
            const next = { ...prev };
            for (const proxy of chunk) {
              next[proxy] = { status: 'fail', message: msg.slice(0, 120) };
            }
            return next;
          });
          totalFail += chunk.length;
        }
      }
      push({
        tone: totalFail > 0 ? 'warn' : 'ok',
        title: '可用池测活完成',
        description: `成功 ${totalOk} · 失败 ${totalFail}（失败可点「删除失败」）`
      });
    } finally {
      setProbingKey(null);
    }
  };

  const clearAlivePool = async () => {
    if (alivePoolEntries.length === 0) return;
    if (!window.confirm(`清空可用池（${alivePoolEntries.length} 条）？`)) return;
    const nextDraft = { ...draft, proxyPoolAlive: '' };
    setDraft(nextDraft);
    setProxyProbes((prev) => {
      const next = { ...prev };
      for (const e of alivePoolEntries) {
        delete next[e.proxy];
      }
      return next;
    });
    if (draft.proxyAutoSaveOnRemoveFailed) {
      await save(nextDraft, { okTitle: '可用池已清空并保存' });
    } else {
      push({ tone: 'ok', title: '可用池已清空', description: '未保存，请点保存' });
    }
  };

  const clearPendingPool = async () => {
    if (proxyPoolEntries.length === 0) return;
    if (!window.confirm(`清空待定池（${proxyPoolEntries.length} 条）？`)) return;
    const nextDraft = { ...draft, proxyPool: '' };
    setDraft(nextDraft);
    setProxyProbes((prev) => {
      const next = { ...prev };
      for (const e of proxyPoolEntries) {
        delete next[e.proxy];
      }
      return next;
    });
    if (draft.proxyAutoSaveOnRemoveFailed) {
      await save(nextDraft, { okTitle: '待定池已清空并保存' });
    } else {
      push({ tone: 'ok', title: '待定池已清空', description: '未保存，请点保存' });
    }
  };

  return (
    <div className="space-y-5">
      <Card collapsible defaultCollapsed>
        <CardHeader
          title="邮件设置"
          description="Cloudflare Temp Email / DuckMail / YYDS"
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
        <CardBody className="space-y-4">
          {(() => {
            const provider = draft.mailProvider || 'cloudflare';
            const isCloudflare = provider === 'cloudflare' || !provider;
            return (
              <>
          <Field
            label="邮箱提供方"
            hint="cloudflare：支持域名池；duckmail/yyds：由服务端分配域名，无客户端域名池接口"
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
                    ? 'YYDS API 根地址'
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
                    : 'https://api.example.com'
                }
              />
            </Field>
            <Field
              label={
                provider === 'duckmail' || provider === 'yyds'
                  ? 'API Token'
                  : '管理密码'
              }
              hint={
                provider === 'duckmail' || provider === 'yyds'
                  ? 'Bearer Token（写入 mail_admin_auth）'
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
                  ? 'YYDS 可由服务端拉域名列表；此处可选填偏好域名，不支持本机域名池轮换'
                  : 'DuckMail 由 API 分配地址；可选填 domain 作创建偏好，不支持本机域名池'
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
          description="三种模式二选一：直连 / 普通代理（单条或池）/ CF 独立代理（cfwp 本地 HTTP·SOCKS）"
        />
        <CardBody className="grid gap-4 lg:grid-cols-2">
          {/* 模式互斥：CF 独立 ↔ 普通代理/池 */}
          <div className="lg:col-span-2 space-y-2">
            <div className="text-[13px] font-medium tracking-tight">代理模式</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  {
                    id: 'off' as const,
                    label: '直连',
                    hint: '不走任何代理'
                  },
                  {
                    id: 'normal' as const,
                    label: '普通代理 / 池',
                    hint: '单条 HTTP 或代理池轮换'
                  },
                  {
                    id: 'cf' as const,
                    label: 'CF 独立代理',
                    hint: 'Workers/Pages → 本地 SOCKS/HTTP'
                  }
                ] as const
              ).map((opt) => {
                const active =
                  opt.id === 'cf'
                    ? !!draft.cfProxyEnabled
                    : opt.id === 'normal'
                      ? !draft.cfProxyEnabled && !!draft.proxyEnabled
                      : !draft.cfProxyEnabled && !draft.proxyEnabled;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setProxyMode(opt.id)}
                    className={cn(
                      'rounded-xl border px-3 py-2.5 text-left transition-colors',
                      active
                        ? 'border-primary/50 bg-primary/10 ring-1 ring-primary/30'
                        : 'border-border/60 bg-muted/30 hover:bg-muted/50'
                    )}
                  >
                    <div className="text-[13px] font-semibold tracking-tight">{opt.label}</div>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                      {opt.hint}
                    </p>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">
              CF 独立代理与普通代理/代理池<strong>只能二选一</strong>；镜像内仅打包 Linux
              cfwp（amd64/arm64），不含 Windows 客户端。
            </p>
          </div>

          {/* —— CF 独立代理面板（对齐 cfsh.sh 参数）—— */}
          {draft.cfProxyEnabled && (
            <div className="lg:col-span-2 space-y-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold tracking-tight">
                    Cloudflare Socks5/HTTP 本地代理
                  </div>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    参数对齐{' '}
                    <code className="text-[10px]">cfsh.sh</code>
                    ：域名、token、本地端口、优选 IP、ProxyIP、DoH、ECH、分流。保存设置后自动启停
                    cfwp。
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <span
                    className={cn(
                      'chip text-[11px]',
                      cfStatus?.running
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {cfStatus?.running
                      ? `运行中 · pid ${cfStatus.pid ?? '?'}`
                      : '未运行'}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7"
                    disabled={cfBusy}
                    onClick={() => void runCfAction('sync')}
                  >
                    {cfBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Activity className="h-3.5 w-3.5" />
                    )}
                    同步
                  </Button>
                  {cfStatus?.running ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      className="h-7"
                      disabled={cfBusy}
                      onClick={() => void runCfAction('stop')}
                    >
                      停止
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      className="h-7"
                      disabled={cfBusy}
                      onClick={() => void runCfAction('start')}
                      title="需先保存设置且开启 CF"
                    >
                      启动
                    </Button>
                  )}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="1. CF 域名（Workers/Pages/自定义）"
                  hint="格式：域名:443 系或 80 系端口"
                  error={errors.cfProxyDomain}
                >
                  <Input
                    value={draft.cfProxyDomain || ''}
                    onChange={(e) => update('cfProxyDomain', e.target.value)}
                    invalid={!!errors.cfProxyDomain}
                    placeholder="xxx.workers.dev:443"
                    spellCheck={false}
                    className="font-mono text-[13px]"
                  />
                </Field>
                <Field label="2. 密钥 token" hint="可空；对应 cfsh 密钥">
                  <PasswordInput
                    value={draft.cfProxyToken || ''}
                    onChange={(e) => update('cfProxyToken', e.target.value)}
                    placeholder="回车默认不设"
                  />
                </Field>
                <Field
                  label="3. 本地端口"
                  hint="默认 30000 → client_ip=:port"
                  error={errors.cfProxyPort}
                >
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={draft.cfProxyPort ?? 30000}
                    onChange={(e) =>
                      update(
                        'cfProxyPort',
                        Math.max(1, Math.min(65535, Number(e.target.value) || 30000))
                      )
                    }
                    invalid={!!errors.cfProxyPort}
                  />
                </Field>
                <Field label="4. 优选 IP/域名" hint="默认 yg1.ygkkk.dpdns.org">
                  <Input
                    value={draft.cfProxyCdnip || ''}
                    onChange={(e) => update('cfProxyCdnip', e.target.value)}
                    placeholder="yg1.ygkkk.dpdns.org"
                    spellCheck={false}
                    className="font-mono text-[13px]"
                  />
                </Field>
                <Field label="5. ProxyIP" hint="可空：使用服务端 ProxyIP">
                  <Input
                    value={draft.cfProxyPyip || ''}
                    onChange={(e) => update('cfProxyPyip', e.target.value)}
                    placeholder="可空"
                    spellCheck={false}
                    className="font-mono text-[13px]"
                  />
                </Field>
                <Field label="6. DoH 服务器" hint="默认 dns.alidns.com/dns-query">
                  <Input
                    value={draft.cfProxyDns || ''}
                    onChange={(e) => update('cfProxyDns', e.target.value)}
                    placeholder="dns.alidns.com/dns-query"
                    spellCheck={false}
                    className="font-mono text-[13px]"
                  />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <ToggleRow
                  label="7. ECH 开关"
                  hint="开：ECH-TLS；关：普通 TLS/无 TLS 由服务端决定"
                  checked={draft.cfProxyEnableEch !== false}
                  onChange={(v) => update('cfProxyEnableEch', v)}
                />
                <ToggleRow
                  label="8. 国内外分流"
                  hint="开：分流代理；关：全局代理"
                  checked={draft.cfProxyCnrule !== false}
                  onChange={(v) => update('cfProxyCnrule', v)}
                />
              </div>

              <Field
                label="本地协议（写入注册机）"
                hint="cfwp 同时提供 HTTP 与 SOCKS；此处选择写入 config 的 scheme"
                error={errors.cfProxyLocalScheme}
              >
                <select
                  className={SELECT_CLASS}
                  value={draft.cfProxyLocalScheme || 'socks5'}
                  onChange={(e) =>
                    update(
                      'cfProxyLocalScheme',
                      e.target.value === 'http' ? 'http' : 'socks5'
                    )
                  }
                >
                  <option value="socks5">socks5://127.0.0.1:端口（推荐）</option>
                  <option value="http">http://127.0.0.1:端口</option>
                </select>
              </Field>

              <div className="rounded-lg border border-border/50 bg-card/60 px-3 py-2 text-[12px]">
                <div className="font-medium">将使用本地代理</div>
                <code className="mt-0.5 block break-all font-mono text-[11px] text-muted-foreground">
                  {buildCfLocalProxyUrl(draft)}
                </code>
                {cfStatus?.lastError && (
                  <p className="mt-1 text-[11px] text-danger">{cfStatus.lastError}</p>
                )}
                {cfStatus && !cfStatus.binaryExists && (
                  <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                    未找到 Linux cfwp 二进制（register/bin/cfwp/linux-amd64|arm64）。请在
                    Docker 镜像中构建。
                  </p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <ToggleRow
                  label="SSO 验活走代理"
                  hint="经 CF 本地代理"
                  checked={draft.ssoCheckUseProxy !== false}
                  onChange={(v) => update('ssoCheckUseProxy', v)}
                />
                <ToggleRow
                  label="Auth 转换/重签/测活走代理"
                  hint="经 CF 本地代理"
                  checked={draft.cpaAuthUseProxy !== false}
                  onChange={(v) => update('cpaAuthUseProxy', v)}
                />
              </div>
            </div>
          )}

          {/* —— 普通代理 / 池 —— */}
          {!draft.cfProxyEnabled && draft.proxyEnabled && (
            <>
              <div className="lg:col-span-2 grid gap-3 sm:grid-cols-2">
                <ToggleRow
                  label="SSO 验活走代理"
                  hint="开：号池 SSO 验活经 HTTP 代理；关：直连。mint 前预检始终直连（不耗代理 IP）"
                  checked={draft.ssoCheckUseProxy !== false}
                  onChange={(v) => update('ssoCheckUseProxy', v)}
                />
                <ToggleRow
                  label="Auth 转换/重签/测活走代理"
                  hint="开：mint/重签/CPA 测活经代理；关：直连。预检(probe_sso)固定直连省 IP"
                  checked={draft.cpaAuthUseProxy !== false}
                  onChange={(v) => update('cpaAuthUseProxy', v)}
                />
              </div>

              <div className="lg:col-span-2">
                <ToggleRow
                  label="使用代理池"
                  hint="开：从池中轮换（仅注册机浏览器）；关：注册机也用上方 HTTP 代理"
                  checked={!!draft.proxyPoolEnabled}
                  onChange={(v) => update('proxyPoolEnabled', v)}
                />
              </div>

              {/* 单条 HTTP 代理：SSO 验活 / Auth mint·重签·测活 出站（非代理池；与注册机池无关） */}
              <Field
                label="HTTP 代理（验活 / Auth 出站）"
                hint="代理池仅给注册机浏览器轮换；此处单条给 SSO 验活、Auth 转换/重签/测活"
                error={errors.proxy}
              >
                <Input
                  value={draft.proxy}
                  onChange={(e) => update('proxy', e.target.value)}
                  invalid={!!errors.proxy}
                  placeholder="http://127.0.0.1:7890"
                />
              </Field>
              {/* 浏览器代理字段已隐藏：注册机走代理池轮换，单条仅用 HTTP 代理出站 */}

              {draft.proxyPoolEnabled && (
                <>
                  <div className="lg:col-span-2 space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-3.5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold tracking-tight">
                          从网页拉取代理
                        </div>
                        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                          默认{' '}
                          <a
                            href="https://hide.mn/en/proxy-list/"
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary underline-offset-2 hover:underline"
                          >
                            hide.mn/proxy-list
                          </a>
                          （表格 IP/Port/国家/类型）。写入下方「待测池」→ 测活 →
                          可用池 → 保存。备注/CSV 含 SOCKS4/5 自动补{' '}
                          <code className="text-[10px]">socks5://</code>；HTTP/HTTPS
                          列表标记均补 <code className="text-[10px]">http://</code>
                          （HTTPS≠https 代理协议）。
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        className="shrink-0"
                        disabled={fetchingProxies}
                        onClick={() => void fetchProxiesFromWeb()}
                        title="拉取并追加到待测池"
                      >
                        {fetchingProxies ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        {fetchingProxies ? '拉取中…' : '一键拉取'}
                      </Button>
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        className="min-w-0 flex-1 font-mono text-[13px]"
                        value={
                          draft.proxyFetchUrl ||
                          'https://hide.mn/en/proxy-list/'
                        }
                        onChange={(e) => update('proxyFetchUrl', e.target.value)}
                        placeholder="https://hide.mn/en/proxy-list/"
                        spellCheck={false}
                      />
                      <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                        <span className="whitespace-nowrap">页数</span>
                        <select
                          className={cn(SELECT_CLASS, 'h-9 w-[4.5rem] px-2 text-[13px]')}
                          value={fetchPages}
                          onChange={(e) =>
                            setFetchPages(Math.min(20, Math.max(1, Number(e.target.value) || 1)))
                          }
                          title="hide.mn 每页约 64 条，可多页合并去重"
                        >
                          {[1, 2, 3, 5, 10, 15, 20].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <ToggleRow
                      label="经 HTTP 代理拉取页面"
                      hint="本机打不开 hide.mn 时开启（用上方「HTTP 代理」出站）"
                      checked={fetchViaProxy}
                      onChange={setFetchViaProxy}
                      className="bg-card/70"
                    />
                    {fetchResult && (
                      <div
                        className={cn(
                          'relative rounded-xl border px-3.5 py-2.5 text-[12px] leading-5',
                          fetchResult.tone === 'ok' &&
                            'border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
                          fetchResult.tone === 'warn' &&
                            'border-amber-500/35 bg-amber-500/10 text-amber-900 dark:text-amber-200',
                          fetchResult.tone === 'danger' &&
                            'border-destructive/40 bg-destructive/10 text-destructive',
                          fetchResult.tone === 'info' &&
                            'border-primary/30 bg-primary/10 text-foreground'
                        )}
                        role="status"
                      >
                        <button
                          type="button"
                          className="absolute right-2 top-2 rounded-md p-0.5 text-current/60 hover:bg-black/5 hover:text-current"
                          onClick={() => setFetchResult(null)}
                          title="关闭"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                        <div className="pr-6 font-semibold tracking-tight">
                          {fetchResult.title}
                        </div>
                        <p className="mt-0.5 break-all opacity-90">{fetchResult.detail}</p>
                        {fetchResult.tone === 'ok' && (
                          <p className="mt-1 text-[11px] opacity-80">
                            写入「待定池」。三条件测活全过才进「可用池」；注册失败会从可用降回待定。
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* 待定池：与可用池同风格折叠条 */}
                  <div className="lg:col-span-2">
                    <div className="rounded-xl border border-border/60 bg-muted/30">
                      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => setPendingPoolOpen((v) => !v)}
                        >
                          {pendingPoolOpen ? (
                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="text-[13px] font-medium">待定池</span>
                          <span className="chip tabular-nums bg-amber-500/15 text-amber-800 dark:text-amber-300">
                            {proxyPoolEntries.length}
                          </span>
                          <span className="truncate text-[12px] text-muted-foreground">
                            导入 / 测活未过 / 注册失败降级 · 不参与注册
                          </span>
                        </button>
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          {failedProxies.length > 0 && (
                            <Button
                              type="button"
                              size="sm"
                              variant="danger"
                              className="h-7"
                              disabled={probingKey !== null}
                              onClick={() => void removeFailed('pending')}
                              title="删除待定池中测活失败的项"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              删除失败 ({failedProxies.length})
                            </Button>
                          )}
                          {proxyPoolEntries.length > 0 && (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              className="h-7"
                              disabled={probingKey !== null}
                              onClick={() => void probeAll()}
                              title="对待定池全部测活（三绿进可用池）"
                            >
                              {probingKey === '__all__' ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Activity className="h-3.5 w-3.5" />
                              )}
                              全部测活
                            </Button>
                          )}
                          {proxyPoolEntries.length > 0 && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 text-muted-foreground hover:text-danger"
                              disabled={probingKey !== null}
                              onClick={() => void clearPendingPool()}
                              title="清空待定池全部条目"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              清空
                            </Button>
                          )}
                        </div>
                      </div>
                      {pendingPoolOpen && (
                        <div className="space-y-2 border-t border-border/50 px-3.5 pb-3.5 pt-3">

                          <textarea
                            ref={pendingPoolRef}
                            className={cn(TEXTAREA_CLASS, 'min-h-[120px] font-mono text-[13px]')}
                            value={draft.proxyPool}
                            onChange={(e) => update('proxyPool', e.target.value)}
                            placeholder={
                              '拉取 / 注册失败降级后出现在此…\n18,172.64.149.71:80,美国,HTTP,平均\n8.216.35.12:8888（日本，elite，HTTPS）'
                            }
                            spellCheck={false}
                            rows={5}
                          />
                          {proxyPoolEntries.length > 0 && (
                            <ProxyPoolPreview
                              entries={proxyPoolEntries}
                              probes={proxyProbes}
                              probingKey={probingKey}
                              failCount={failedProxies.length}
                              onProbeOne={probeOne}
                              onRemoveOne={(p) => void removeOne(p, 'pending')}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 可用池：注册专用；测活成功迁入，注册失败可降回待定 */}
                  <div className="lg:col-span-2">
                    <div className="rounded-xl border border-border/60 bg-muted/30">
                      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => setAlivePoolOpen((v) => !v)}
                        >
                          {alivePoolOpen ? (
                            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="text-[13px] font-medium">可用池</span>
                          <span className="chip tabular-nums bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                            {alivePoolEntries.length}
                          </span>
                          {aliveSuccessTotal > 0 && (
                            <span
                              className="chip tabular-nums bg-emerald-500/20 font-semibold text-emerald-700 dark:text-emerald-400"
                              title="可用池全部代理注册成功次数合计"
                            >
                              #成功{aliveSuccessTotal}
                            </span>
                          )}
                          <span className="truncate text-[12px] text-muted-foreground">
                            仅此池参与注册 · 可复测
                          </span>
                        </button>
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          {failedAliveProxies.length > 0 && (
                            <Button
                              type="button"
                              size="sm"
                              variant="danger"
                              className="h-7"
                              disabled={probingKey !== null}
                              onClick={() => void removeFailed('alive')}
                              title="删除可用池中测活失败的项"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              删除失败 ({failedAliveProxies.length})
                            </Button>
                          )}
                          {alivePoolEntries.length > 0 && (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="h-7"
                                disabled={probingKey !== null}
                                onClick={() => void probeAllAlive()}
                                title="对可用池全部复测"
                              >
                                {probingKey === '__alive_all__' ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Activity className="h-3.5 w-3.5" />
                                )}
                                全部测活
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-danger"
                                disabled={probingKey !== null}
                                onClick={() => void clearAlivePool()}
                                title="清空可用池"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                                清空
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      {alivePoolOpen && (
                        <div className="space-y-2 border-t border-border/50 px-3.5 pb-3.5 pt-3">

                          <textarea
                            className={TEXTAREA_CLASS}
                            value={draft.proxyPoolAlive || ''}
                            onChange={(e) => update('proxyPoolAlive', e.target.value)}
                            placeholder="测活成功后自动填入…"
                            rows={4}
                          />
                          {alivePoolEntries.length > 0 && (
                            <ul className="max-h-48 space-y-1.5 overflow-y-auto">
                              {alivePoolEntries.map((e) => {
                                const probe = proxyProbes[e.proxy] || {
                                  status: 'idle' as const
                                };
                                const loading =
                                  probe.status === 'loading' ||
                                  probingKey === e.proxy ||
                                  probingKey === '__alive_all__';
                                return (
                                  <li
                                    key={e.proxy}
                                    className="flex flex-wrap items-center gap-2 rounded-lg bg-card/80 px-2.5 py-2 text-[12px]"
                                  >
                                    <ProxySchemeBadge scheme={e.scheme} />
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
                                    {typeof e.successCount === 'number' &&
                                      e.successCount > 0 && (
                                        <span
                                          className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-400"
                                          title={`注册成功 ${e.successCount} 次（行尾 #成功N）`}
                                        >
                                          #成功{e.successCount}
                                        </span>
                                      )}
                                    {probe.status === 'ok' && (
                                      <span
                                        className="max-w-[10rem] truncate text-emerald-600 dark:text-emerald-400"
                                        title={probe.message}
                                      >
                                        {probe.message || 'OK'}
                                      </span>
                                    )}
                                    {probe.status === 'fail' && (
                                      <span
                                        className="max-w-[10rem] truncate text-danger"
                                        title={probe.message}
                                      >
                                        {probe.message || '失败'}
                                      </span>
                                    )}
                                    {probe.status === 'idle' &&
                                      !(
                                        typeof e.successCount === 'number' &&
                                        e.successCount > 0
                                      ) && (
                                      <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                        可用
                                      </span>
                                    )}
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 shrink-0 px-2 text-danger"
                                      disabled={loading || probingKey !== null}
                                      onClick={() => void removeOne(e.proxy, 'alive')}
                                      title="从可用池删除"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="secondary"
                                      className="h-7 shrink-0"
                                      disabled={loading || probingKey !== null}
                                      onClick={() => void probeOneAlive(e.proxy)}
                                      title="复测此代理"
                                    >
                                      {loading ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      ) : (
                                        <Activity className="h-3.5 w-3.5" />
                                      )}
                                      测活
                                    </Button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* 池运行参数：三列等宽卡片，避免原先 2 列网格错位 */}
                  <div className="lg:col-span-2 space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      <div className="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-muted/40 p-3.5">
                        <div>
                          <div className="text-[13px] font-medium tracking-tight">
                            代理池模式
                          </div>
                          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                            注册取代理时的轮换策略
                          </p>
                        </div>
                        <PoolModeSelect
                          value={draft.proxyMode}
                          onChange={(v) => update('proxyMode', v)}
                        />
                      </div>

                      <div className="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-muted/40 p-3.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium tracking-tight">
                              IP 使用间隔
                            </div>
                            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                              同一 IP 注册后冷却；0=不限制
                            </p>
                          </div>
                          <span className="chip shrink-0 tabular-nums">
                            {draft.proxyIpIntervalSec ?? 0}s
                          </span>
                        </div>
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
                          className={cn(errors.proxyIpIntervalSec && 'border-danger')}
                        />
                        {errors.proxyIpIntervalSec && (
                          <p className="text-xs text-danger">{errors.proxyIpIntervalSec}</p>
                        )}
                      </div>

                      <div className="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-muted/40 p-3.5 sm:col-span-2 xl:col-span-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium tracking-tight">
                              测活并发
                            </div>
                            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                              全部测活时并发数（1～20）
                            </p>
                          </div>
                          <span className="chip shrink-0 tabular-nums">
                            {draft.proxyProbeConcurrency ?? 8}
                          </span>
                        </div>
                        <Slider
                          min={1}
                          max={20}
                          value={draft.proxyProbeConcurrency ?? 8}
                          onValueChange={(v) => update('proxyProbeConcurrency', v)}
                        />
                        {errors.proxyProbeConcurrency && (
                          <p className="text-xs text-danger">{errors.proxyProbeConcurrency}</p>
                        )}
                      </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <ToggleRow
                        label="删除失败后自动保存"
                        hint="开：删除失败/单条删除后立即写入配置；关：仅改草稿"
                        checked={!!draft.proxyAutoSaveOnRemoveFailed}
                        onChange={(v) => update('proxyAutoSaveOnRemoveFailed', v)}
                      />
                      <ToggleRow
                        label="优先本地代理转发"
                        hint="带账密时代理：开则本地无认证转发；关则先试浏览器扩展"
                        checked={!!draft.proxyPreferLocalForward}
                        onChange={(v) => update('proxyPreferLocalForward', v)}
                      />
                    </div>
                  </div>
                </>
              )}

              {!draft.proxyPoolEnabled && draft.proxyEnabled && (
                <div className="lg:col-span-2">
                  <ToggleRow
                    label="优先本地代理转发"
                    hint="带账号密码代理时：开则 127.0.0.1 无认证转发到上游；关则优先浏览器扩展注入代理"
                    checked={!!draft.proxyPreferLocalForward}
                    onChange={(v) => update('proxyPreferLocalForward', v)}
                  />
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>

      <Card collapsible defaultCollapsed>
        <CardHeader
          title="授权管理"
          right={
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <KeyRound className="h-4 w-4" aria-hidden />
            </span>
          }
        />
        <CardBody className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <ToggleRow
              label="自动转换 Auth"
              hint="注册只交 SSO 到授权队列：延迟后后台 SSO 推送 / mint / Auth 推送，不阻塞注册"
              checked={draft.autoAuthExport}
              onChange={(v) => update('autoAuthExport', v)}
            />
            <ToggleRow
              label="自动转换 sub2api"
              hint="mint 成功后写 data/sub2api/；默认关"
              checked={!!draft.sub2apiExportEnabled}
              onChange={(v) => update('sub2apiExportEnabled', v)}
            />
          </div>
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
                  label="队列上限（背压）"
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
          <Field
            label="CPA Mint 模式"
            hint="A=PKCE；B=Device；C=double 同时产出两份不同通道 auth，分别测活。mint 后无 grok-4.5 不进 CPA"
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
            label="开启 NSFW"
            hint="授权队列 mint 后用 SSO 尝试 gRPC always_show_nsfw_content；成败均写 tag，不影响授权流水线"
            checked={!!draft.enableNsfw}
            onChange={(v) => update('enableNsfw', v)}
          />
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
          <ToggleRow
            label="401 自动重签"
            hint="默认关。测活 HTTP 401 后自动 refresh→SSO 重签（不含密码重登）；建议配合代理"
            checked={draft.autoResignOn401 === true}
            onChange={(v) => update('autoResignOn401', v)}
          />
          <Field
            label="重签/刷新401 并发"
            hint="1～3，默认 2。过高易触发 accounts.x.ai 限流；走代理见「Auth 转换用代理」"
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
        </CardBody>
      </Card>

      <Card collapsible defaultCollapsed>
        <CardHeader
          title="注册方案"
          description="人机验证、指纹与 Plan A/B/C；全部开启时按 A→B→C 顺序兜底"
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
            hint="临时邮 + Drission 填表 + Turnstile（默认开）"
            checked={draft.registerPlanAEnabled !== false}
            onChange={(v) => {
              update('registerPlanAEnabled', v);
            }}
          />
          <ToggleRow
            label="Plan B · 拟人兜底"
            hint="重启浏览器、更长延迟、等 Turnstile 自然成功、模拟点击；CF 拦截则放弃（默认开）"
            checked={draft.registerPlanBEnabled !== false}
            onChange={(v) => update('registerPlanBEnabled', v)}
          />
          <ToggleRow
            label="Plan C · Hybrid 协议"
            hint="短浏览器采 token + 协议注册（默认关；需适配层，失败不影响已开的 A/B）"
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
          <div className="space-y-1.5 rounded-xl border border-border/60 bg-muted/40 p-3 text-[12px] leading-5 text-muted-foreground">
            <p className="font-medium text-foreground">执行顺序（仅尝试已开启方案）</p>
            <ol className="list-decimal space-y-1 pl-4">
              <li>
                <span className="text-foreground">Plan A</span>
                ：现有临时邮 + Drission 填表 + Turnstile
              </li>
              <li>
                <span className="text-foreground">Plan B</span>
                ：重启浏览器 → 拟人延迟 → 等 Turnstile → 模拟点击 → CF 则放弃
              </li>
              <li>
                <span className="text-foreground">Plan C</span>
                ：hybrid 短浏览器 + 协议（可选）
              </li>
              <li>已开方案均失败：记失败、可选降级代理、进入下一账号</li>
            </ol>
          </div>
        </CardBody>
      </Card>

      <Card collapsible defaultCollapsed>
        <CardHeader
          title="推送设置"
          description="每个目标分「允许推送」与「自动推送」。允许=可手动推；自动=授权队列延迟后推送（与 Auth 转换同一队列，不挡注册）。SSO/Auth 的 g2 互不联动。"
          right={
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <KeyRound className="h-4 w-4" aria-hidden />
            </span>
          }
        />
        <CardBody className="space-y-4">
          {(() => {
            // 允许 / 自动 分离；SSO 与 Auth 的 g2 互不联动
            const allowSsoG2 = draft.pushSsoToGrok2api === true;
            const autoSsoG2 = draft.autoPushSsoToGrok2api === true;
            const allowAuthCpa =
              draft.pushAuthToCpa === true || draft.cpaRemotePushEnabled === true;
            const autoAuthCpa = draft.autoPushAuthToCpa === true;
            const allowAuthG2 = draft.pushAuthToGrok2api === true;
            const autoAuthG2 = draft.autoPushAuthToGrok2api === true;
            const needG2Config = allowSsoG2 || allowAuthG2 || autoSsoG2 || autoAuthG2;
            const needCpaConfig = allowAuthCpa || autoAuthCpa;
            const syncLegacyG2 = (ssoAllow: boolean, authAllow: boolean) =>
              ssoAllow || authAllow;

            const setAllowSsoG2 = (on: boolean) => {
              patch({
                pushSsoToGrok2api: on,
                autoPushSsoToGrok2api: on ? draft.autoPushSsoToGrok2api === true : false,
                grok2apiAutoUpload: syncLegacyG2(
                  on,
                  draft.pushAuthToGrok2api === true || draft.autoPushAuthToGrok2api === true
                )
              });
            };
            const setAutoSsoG2 = (on: boolean) => {
              patch({
                autoPushSsoToGrok2api: on,
                pushSsoToGrok2api: on ? true : draft.pushSsoToGrok2api === true,
                grok2apiAutoUpload: syncLegacyG2(
                  on || draft.pushSsoToGrok2api === true,
                  draft.pushAuthToGrok2api === true || draft.autoPushAuthToGrok2api === true
                )
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
            const setAllowAuthG2 = (on: boolean) => {
              patch({
                pushAuthToGrok2api: on,
                autoPushAuthToGrok2api: on ? draft.autoPushAuthToGrok2api === true : false,
                grok2apiAutoUpload: syncLegacyG2(
                  draft.pushSsoToGrok2api === true || draft.autoPushSsoToGrok2api === true,
                  on
                )
              });
            };
            const setAutoAuthG2 = (on: boolean) => {
              patch({
                autoPushAuthToGrok2api: on,
                pushAuthToGrok2api: on ? true : draft.pushAuthToGrok2api === true,
                grok2apiAutoUpload: syncLegacyG2(
                  draft.pushSsoToGrok2api === true || draft.autoPushSsoToGrok2api === true,
                  on || draft.pushAuthToGrok2api === true
                )
              });
            };
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
                    ? 'inline-flex h-8 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 text-[12px] font-semibold text-emerald-700 dark:text-emerald-400'
                    : 'inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-[12px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground'
                }
              >
                {label}
              </button>
            );
            const pair = (
              allow: boolean,
              auto: boolean,
              onAllow: (v: boolean) => void,
              onAuto: (v: boolean) => void,
              name: string
            ) => (
              <div className="flex flex-wrap items-center gap-1.5">
                {targetBtn(
                  allow,
                  '允许推送',
                  () => onAllow(!allow),
                  allow ? `关闭「允许」${name}` : `开启「允许」${name}（可手动推/填连接）`
                )}
                {targetBtn(
                  auto,
                  '自动推送',
                  () => onAuto(!auto),
                  auto
                    ? `关闭「自动」${name}`
                    : `开启「自动」${name}（注册成功后推送，会同时开允许）`
                )}
              </div>
            );
            return (
              <>
                {/* SSO 推送 */}
                <div className="rounded-xl border border-border/70 bg-muted/30 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-foreground">
                        SSO · grok2api
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Cookie / 号池 sso — 仅 grok2api
                      </div>
                    </div>
                    {pair(allowSsoG2, autoSsoG2, setAllowSsoG2, setAutoSsoG2, 'SSO→g2')}
                  </div>
                </div>

                {/* Auth 推送 */}
                <div className="space-y-2 rounded-xl border border-border/70 bg-muted/30 p-3">
                  <div className="text-[14px] font-medium text-foreground">Auth</div>
                  <div className="text-[11px] text-muted-foreground">
                    本地 xai-*.json — CPA 与 grok2api 可同时配置
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2">
                    <span className="text-[12px] font-medium text-foreground">CPA</span>
                    {pair(allowAuthCpa, autoAuthCpa, setAllowAuthCpa, setAutoAuthCpa, 'Auth→CPA')}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2">
                    <span className="text-[12px] font-medium text-foreground">grok2api</span>
                    {pair(allowAuthG2, autoAuthG2, setAllowAuthG2, setAutoAuthG2, 'Auth→g2')}
                  </div>
                </div>

                {/* CPA 连接（Auth→CPA 启用时展开）— 与上方 Auth 推送块同壳 */}
                {needCpaConfig && (
                  <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-3">
                    <div>
                      <div className="text-[14px] font-medium text-foreground">
                        CPA 连接设定
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        Management API · 远程 CPA 推送目标
                      </div>
                    </div>
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
                  </div>
                )}

                {/* grok2api 连接（任一 grok2api 目标启用时展开）— 与上方 Auth 推送块同壳 */}
                {needG2Config && (
                  <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-3">
                    <div>
                      <div className="text-[14px] font-medium text-foreground">
                        grok2api 连接设定
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        SSO / Auth 共用 · 管理面板根地址与账号
                      </div>
                    </div>
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
