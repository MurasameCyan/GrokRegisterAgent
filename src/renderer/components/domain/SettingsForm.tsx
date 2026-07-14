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
  Shield,
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
import type { AppSettings, PoolMode, ProxyPoolEntry } from '@shared/settings';
import {
  appendProxiesToPoolTextDetailed,
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

  useEffect(() => {
    if (data && !draft) setDraft(data);
  }, [data, draft]);

  // 外部 data 更新时同步 draft（仅引用变化时）。
  // 注意：网页导入会先 setDraft 再 store.set，此处需能吃到最新 data。
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

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
    return parseProxyPoolEntries(draft.proxyPoolAlive);
  }, [draft?.proxyPoolAlive]);

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
      const append = appendProxiesToPoolTextDetailed(
        draft.proxyPool || '',
        r.lines,
        r.lines.join('\n')
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
          // 以本块实际 ok/fail 计数，避免 batch.ok/fail 与 results 不一致时双计
          const chunkFail = Math.max(0, chunk.length - chunkOk.length);
          totalOk += chunkOk.length;
          totalFail += chunkFail;
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
        <CardBody className="space-y-4">
          {/* 连接：API + 密码 并排 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="API 地址"
              hint="Worker API 根地址，勿填前端 Pages 域名"
              error={errors['mail.apiBase']}
            >
              <Input
                value={draft.mail.apiBase}
                onChange={(e) => updateMail('apiBase', e.target.value)}
                invalid={!!errors['mail.apiBase']}
                placeholder="https://xxx.workers.dev"
              />
            </Field>
            <Field
              label="管理密码"
              hint="Temp Email 管理员密码（X-Admin-Auth）"
              error={errors['mail.adminAuth']}
            >
              <PasswordInput
                value={draft.mail.adminAuth}
                onChange={(e) => updateMail('adminAuth', e.target.value)}
                invalid={!!errors['mail.adminAuth']}
              />
            </Field>
          </div>

          {/* 域名：开关 + 对应表单 */}
          <div className="space-y-3 rounded-xl border border-border/70 bg-muted/25 p-3.5">
            <ToggleRow
              label="启用域名池"
              hint="开：多域名轮换；关：只用下方默认域名"
              checked={!!draft.mailDomainPoolEnabled}
              onChange={(v) => update('mailDomainPoolEnabled', v)}
              className="bg-card/60"
            />

            {!draft.mailDomainPoolEnabled ? (
              <Field
                label="默认邮件域名"
                hint="单域名，例如 example.com"
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
                  hint="每行一个，或逗号分隔"
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
              hint="关：直连；开：使用下方单代理或代理池（注册机池轮换；Node 出站用单条 HTTP 代理）"
              checked={!!draft.proxyEnabled}
              onChange={(v) => update('proxyEnabled', v)}
            />
          </div>

          {draft.proxyEnabled && (
            <>
              <div className="lg:col-span-2 grid gap-3 sm:grid-cols-2">
                <ToggleRow
                  label="SSO 验活走代理"
                  hint="开：SSO 验活经 HTTP 代理访问 grok；关：直连"
                  checked={draft.ssoCheckUseProxy !== false}
                  onChange={(v) => update('ssoCheckUseProxy', v)}
                />
                <ToggleRow
                  label="Auth 转换/重签/测活走代理"
                  hint="开：mint、重签、CPA 测活经 HTTP 代理；关：直连"
                  checked={draft.cpaAuthUseProxy !== false}
                  onChange={(v) => update('cpaAuthUseProxy', v)}
                />
              </div>

              <div className="lg:col-span-2">
                <ToggleRow
                  label="使用代理池"
                  hint="开：从池中轮换（仅注册机浏览器）；关：使用单条 HTTP/浏览器代理"
                  checked={!!draft.proxyPoolEnabled}
                  onChange={(v) => update('proxyPoolEnabled', v)}
                />
              </div>

              {/* 单条 HTTP 代理：SSO 验活 / Auth mint·重签·测活 出站用（与注册机代理池无关） */}
              <Field
                label={
                  draft.proxyPoolEnabled
                    ? 'HTTP 代理（验活 / Auth 出站）'
                    : 'HTTP 代理'
                }
                hint={
                  draft.proxyPoolEnabled
                    ? '代理池仅给注册机浏览器轮换；此处单条给 SSO 验活、Auth 转换/重签/测活'
                    : '例如 http://127.0.0.1:7890'
                }
                error={errors.proxy}
              >
                <Input
                  value={draft.proxy}
                  onChange={(e) => update('proxy', e.target.value)}
                  invalid={!!errors.proxy}
                  placeholder="http://127.0.0.1:7890"
                />
              </Field>
              {!draft.proxyPoolEnabled && (
                <Field label="浏览器代理" hint="空则跟随 HTTP 代理">
                  <Input
                    value={draft.browserProxy}
                    onChange={(e) => update('browserProxy', e.target.value)}
                    placeholder="留空跟随 HTTP 代理"
                  />
                </Field>
              )}

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
                          可用池 → 保存。
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
                        {fetchingProxies ? '拉取中…' : '一键拉取 hide.mn'}
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
                        </div>
                      </div>
                      {pendingPoolOpen && (
                        <div className="space-y-2 border-t border-border/50 px-3.5 pb-3.5 pt-3">
                          <p className="text-[12px] text-muted-foreground">
                            网页导入、测活失败、注册时出口失败会落在此池。
                            <strong className="font-medium text-foreground">
                              仅「可用池」参与注册
                            </strong>
                            ；三条件（代理连通 + xAI + CF）全过才迁入可用。
                          </p>
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
                              onProbeAll={probeAll}
                              onRemoveFailed={() => void removeFailed('pending')}
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
                          <p className="text-[12px] text-muted-foreground">
                            注册机<strong className="font-medium text-foreground">只用本池</strong>
                            。出口 IP / 注册页不可达时会自动降回「待定池」。可手改/粘贴/复测。
                          </p>
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
                                    {probe.status === 'idle' && (
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
                    hint="带账号密码代理时：开则 127.0.0.1 无认证转发到上游；关则先试浏览器扩展，出口 IP 失败再兜底"
                    checked={!!draft.proxyPreferLocalForward}
                    onChange={(v) => update('proxyPreferLocalForward', v)}
                  />
                </div>
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
            hint="注册成功后走授权码流程换 token，写出 xai-*.json；最新 CPA 关闭 using_api 即可用"
            checked={draft.autoAuthExport}
            onChange={(v) => update('autoAuthExport', v)}
          />
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

      <Card>
        <CardHeader>
          <CardTitle>grok2api 推送</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <ToggleRow
            label="自动推送 grok2api"
            hint="注册成功后：Web 导入 SSO → Convert to Build（需配置 URL/账号密码）；失败不阻断本轮"
            checked={draft.grok2apiAutoUpload === true}
            onChange={(v) => update('grok2apiAutoUpload', v)}
          />
          <Field label="grok2api URL" hint="管理面板根地址，如 http://127.0.0.1:8000">
            <Input
              value={draft.grok2apiUrl || ''}
              onChange={(e) => update('grok2apiUrl', e.target.value)}
              placeholder="http://127.0.0.1:8000"
            />
          </Field>
          <Field label="grok2api 用户名">
            <Input
              value={draft.grok2apiUsername || ''}
              onChange={(e) => update('grok2apiUsername', e.target.value)}
              placeholder="admin"
              autoComplete="off"
            />
          </Field>
          <Field label="grok2api 密码">
            <Input
              type="password"
              value={draft.grok2apiPassword || ''}
              onChange={(e) => update('grok2apiPassword', e.target.value)}
              placeholder="密码"
              autoComplete="off"
            />
          </Field>
          <Field
            label="上传模式"
            hint="web_convert=与 grok-register-web 一致；build_direct=本地 Device Flow 后 import"
          >
            <select
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
              value={
                draft.grok2apiUploadMode === 'build_direct'
                  ? 'build_direct'
                  : 'web_convert'
              }
              onChange={(e) =>
                update(
                  'grok2apiUploadMode',
                  e.target.value === 'build_direct' ? 'build_direct' : 'web_convert'
                )
              }
            >
              <option value="web_convert">web_convert（推荐）</option>
              <option value="build_direct">build_direct</option>
            </select>
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
          <Button onClick={() => save()} disabled={!dirty || !valid || saving} size="sm">
            <Save className="h-4 w-4" />
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
