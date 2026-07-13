import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, CheckSquare, KeyRound, RefreshCcw, RotateCcw, Square } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { useToastStore } from '@renderer/store/toastStore';
import type { CpaAuthItem } from '@shared/ipc';
import { cn } from '@renderer/lib/cn';

function fmtTime(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

export function AuthPage() {
  const push = useToastStore((s) => s.push);
  const [dir, setDir] = useState('');
  const [items, setItems] = useState<CpaAuthItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [resigning, setResigning] = useState<string | null>(null);
  /** resign | probe | null */
  const [batchBusy, setBatchBusy] = useState<'resign' | 'probe' | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 最近一次测活结果：filename → probeAction */
  const [probeMap, setProbeMap] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.api.listCpaAuth();
      setDir(r.dir);
      setItems(r.items);
      setSelected((prev) => {
        const names = new Set(r.items.map((i) => i.filename));
        return new Set([...prev].filter((n) => names.has(n)));
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '加载 Auth 失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const allSelected = items.length > 0 && selected.size === items.length;
  const xaiCount = useMemo(() => items.filter((i) => i.xai).length, [items]);

  const toggle = (filename: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });

  const selectAll = () => {
    if (items.length === 0) return;
    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.filename)));
  };

  const resign = async (item: CpaAuthItem) => {
    setResigning(item.filename);
    try {
      const r = await window.api.resignCpaAuth({ filename: item.filename });
      if (r.ok === false || r.error) {
        push({
          tone: 'danger',
          title: '重签失败',
          description: String(r.error || 'unknown')
        });
      } else {
        const xaiHint =
          r.xai === false
            ? ' · ⚠ 无 xai 标识'
            : r.xaiFilename && r.xaiType
              ? ' · xai✓'
              : r.xai
                ? ' · xai 部分'
                : '';
        push({
          tone: r.xai === false ? 'warn' : 'ok',
          title: '重签成功',
          description: `${item.email || item.filename}（${r.mode || 'ok'}）${xaiHint}`
        });
        await reload();
      }
    } catch (err) {
      push({
        tone: 'danger',
        title: '重签失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setResigning(null);
    }
  };

  const resignBatch = async () => {
    const filenames =
      selected.size > 0 ? [...selected] : items.map((i) => i.filename);
    if (filenames.length === 0) {
      push({ tone: 'warn', title: '没有可重签的文件' });
      return;
    }
    setBatchBusy('resign');
    try {
      const r = await window.api.resignCpaAuthBatch({ filenames });
      const noXai = r.results.filter((x) => x.ok && x.xai === false).length;
      push({
        tone: r.failed > 0 ? 'warn' : 'ok',
        title: '批量重签完成',
        description: `成功 ${r.ok} / 失败 ${r.failed}${noXai ? ` · 无 xai 标识 ${noXai}` : ''}`
      });
      setSelected(new Set());
      await reload();
    } catch (err) {
      push({
        tone: 'danger',
        title: '批量重签失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setBatchBusy(null);
    }
  };

  /** 批量 CPA 测活（cehuo /responses）；dead 默认删文件 */
  const probeBatch = async () => {
    const filenames =
      selected.size > 0 ? [...selected] : items.map((i) => i.filename);
    if (filenames.length === 0) {
      push({ tone: 'warn', title: '没有可测活的文件' });
      return;
    }
    setBatchBusy('probe');
    try {
      const r = await window.api.probeCpaAuthBatch({ filenames, deleteOnDead: true });
      const nextMap: Record<string, string> = {};
      for (const row of r.results) {
        if (row.filename && row.probeAction) nextMap[row.filename] = row.probeAction;
      }
      setProbeMap((prev) => ({ ...prev, ...nextMap }));
      const dead = r.dead ?? r.results.filter((x) => x.probeAction === 'dead').length;
      const deleted = r.deleted ?? r.results.filter((x) => x.probeDeleted).length;
      const keep = r.keep ?? r.results.filter((x) => x.probeAction === 'keep').length;
      push({
        tone: dead > 0 || r.failed > 0 ? 'warn' : 'ok',
        title: '批量 CPA 测活完成',
        description: [
          `OK ${r.ok}`,
          dead ? `死号 ${dead}` : '',
          deleted ? `已删 ${deleted}` : '',
          keep ? `保留 ${keep}` : '',
          r.failed - dead > 0 ? `其它失败 ${r.failed - dead}` : ''
        ]
          .filter(Boolean)
          .join(' · ')
      });
      setSelected(new Set());
      await reload();
    } catch (err) {
      push({
        tone: 'danger',
        title: '批量 CPA 测活失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setBatchBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <section className="ios-group">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-[17px] font-semibold tracking-[-0.02em]">CPA Auth</h2>
            </div>
            <p className="mt-1 truncate text-[12px] text-muted-foreground" title={dir}>
              目录：{dir || '—'} · 共 {items.length} 个 · xai {xaiCount}
              {selected.size > 0 ? ` · 已选 ${selected.size}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={selectAll}
              disabled={items.length === 0 || !!batchBusy}
            >
              {allSelected ? (
                <CheckSquare className="h-4 w-4" />
              ) : (
                <Square className="h-4 w-4" />
              )}
              {allSelected ? '取消全选' : '全选'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void probeBatch()}
              disabled={items.length === 0 || !!batchBusy || !!resigning}
              title="调用 cli-chat-proxy /responses 测活；401/402/403 删除文件"
            >
              <Activity className={cn('h-4 w-4', batchBusy === 'probe' && 'animate-pulse')} />
              {batchBusy === 'probe'
                ? '测活中…'
                : selected.size > 0
                  ? `测活所选 (${selected.size})`
                  : '批量 CPA 测活'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void resignBatch()}
              disabled={items.length === 0 || !!batchBusy || !!resigning}
            >
              <RotateCcw className={cn('h-4 w-4', batchBusy === 'resign' && 'animate-spin')} />
              {batchBusy === 'resign'
                ? '批量重签中…'
                : selected.size > 0
                  ? `重签所选 (${selected.size})`
                  : '全部重签'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void reload()}
              disabled={loading || !!batchBusy}
            >
              <RefreshCcw className={cn('h-4 w-4', loading && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </div>

        {loading && items.length === 0 ? (
          <div className="p-8 text-sm text-muted-foreground">加载中…</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-sm leading-6 text-muted-foreground">
            暂无 auth 文件。可在「号池」对带 SSO 的账号一键补 mint，或开启「配置 → 自动导出 CPA Auth」。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-border/70 text-[12px] text-muted-foreground">
                  <th className="w-10 px-3 py-2.5 font-medium" />
                  <th className="px-4 py-2.5 font-medium">邮箱 / 文件</th>
                  <th className="px-4 py-2.5 font-medium">xAI</th>
                  <th className="px-4 py-2.5 font-medium">测活</th>
                  <th className="px-4 py-2.5 font-medium">过期</th>
                  <th className="px-4 py-2.5 font-medium">Refresh</th>
                  <th className="px-4 py-2.5 font-medium">修改时间</th>
                  <th className="px-4 py-2.5 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.filename} className="border-b border-border/40 last:border-0">
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        className="inline-flex text-muted-foreground hover:text-foreground"
                        onClick={() => toggle(item.filename)}
                        aria-label="选择"
                      >
                        {selected.has(item.filename) ? (
                          <CheckSquare className="h-4 w-4 text-primary" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{item.email || '—'}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">{item.filename}</div>
                    </td>
                    <td className="px-4 py-3">
                      {item.xai ? (
                        <span className="chip text-ok" title={`type=${item.authType || '—'} · file=${item.xaiFilename}`}>
                          {item.xaiFilename && item.xaiType
                            ? 'xai✓'
                            : item.xaiFilename
                              ? 'xai-文件'
                              : 'type=xai'}
                        </span>
                      ) : (
                        <span className="chip text-warn" title="文件名非 xai-* 且 type 非 xai">
                          无
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {(() => {
                        const a = probeMap[item.filename];
                        if (!a) {
                          return <span className="chip text-muted-foreground">—</span>;
                        }
                        if (a === 'ok') {
                          return <span className="chip text-ok">OK</span>;
                        }
                        if (a === 'dead') {
                          return (
                            <span className="chip text-danger" title="401/402/403，已删或待删">
                              死号
                            </span>
                          );
                        }
                        if (a === 'keep') {
                          return (
                            <span className="chip text-warn" title="非 2xx 且非删除状态，保留文件">
                              保留
                            </span>
                          );
                        }
                        return (
                          <span className="chip text-muted-foreground" title={a}>
                            {a === 'error' ? '错误' : a}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{item.expired || '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'chip',
                          item.hasRefresh ? 'text-ok' : 'text-muted-foreground'
                        )}
                      >
                        {item.hasRefresh ? '有' : '无'}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {fmtTime(item.mtime)}
                    </td>
                    <td className="px-4 py-3">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={resigning === item.filename || !!batchBusy}
                        onClick={() => void resign(item)}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {resigning === item.filename ? '重签中…' : '重签'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
