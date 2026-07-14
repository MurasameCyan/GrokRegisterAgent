import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CheckSquare,
  CloudUpload,
  Eye,
  EyeOff,
  FileDown,
  KeyRound,
  RefreshCcw,
  RotateCcw,
  Square,
  Trash2
} from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { useToastStore } from '@renderer/store/toastStore';
import { useSettingsStore } from '@renderer/store/settingsStore';
import type { CpaAuthItem } from '@shared/ipc';
import { cn } from '@renderer/lib/cn';
import {
  loadEmailPrivacyMask,
  maskEmail,
  saveEmailPrivacyMask
} from '@renderer/lib/maskEmail';

function fmtTime(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type TaskProgress = {
  kind: 'probe' | 'resign' | 'delete' | 'export' | 'push';
  total: number;
  done: number;
  ok: number;
  failed: number;
  dead?: number;
  deleted?: number;
  remoteOk?: number;
  remoteFailed?: number;
  current?: string;
  running: boolean;
};

const RESIGN_PUSH_KEY = 'gra-resign-push-remote';

export function AuthPage() {
  const push = useToastStore((s) => s.push);
  const settings = useSettingsStore((s) => s.data);
  const [dir, setDir] = useState('');
  const [items, setItems] = useState<CpaAuthItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState<
    'resign' | 'probe' | 'delete' | 'export' | 'push' | null
  >(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 最近一次测活结果：filename → probeAction */
  const [probeMap, setProbeMap] = useState<Record<string, string>>({});
  const [prog, setProg] = useState<TaskProgress | null>(null);
  const [emailMasked, setEmailMasked] = useState(() => loadEmailPrivacyMask());
  /** 重签成功后是否再推远程（默认关，localStorage 记忆） */
  const [resignPushRemote, setResignPushRemote] = useState(() => {
    try {
      return localStorage.getItem(RESIGN_PUSH_KEY) === '1';
    } catch {
      return false;
    }
  });

  const deleteOnDead = settings?.cpaProbeDeleteOnDead !== false;
  const remoteReady = Boolean(
    String(settings?.cpaRemoteUrl || '').trim() && String(settings?.cpaManagementKey || '').trim()
  );

  const toggleEmailPrivacy = () => {
    setEmailMasked((prev) => {
      const next = !prev;
      saveEmailPrivacyMask(next);
      return next;
    });
  };

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
  const botFlag1Count = useMemo(
    () => items.filter((i) => i.isBotFlag1 || i.botFlagSource === 1 || i.botFlagSource === '1').length,
    [items]
  );
  const busy = batchBusy !== null || rowBusy !== null;

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

  const targetNames = () =>
    selected.size > 0 ? [...selected] : items.map((i) => i.filename);

  const resign = async (item: CpaAuthItem) => {
    setRowBusy(`resign:${item.filename}`);
    try {
      const r = await window.api.resignCpaAuth({
        filename: item.filename,
        pushRemote: resignPushRemote
      });
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
        const remoteHint =
          r.remoteOk === true
            ? ' · 远程推送OK'
            : r.remoteOk === false
              ? ` · 远程失败: ${r.remoteError || '?'}`
              : resignPushRemote
                ? ' · 远程未配置/跳过'
                : '';
        push({
          tone:
            r.xai === false || r.remoteOk === false
              ? 'warn'
              : 'ok',
          title: '重签成功',
          description: `${item.email || item.filename}（${r.mode || 'ok'}）${xaiHint}${remoteHint}`
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
      setRowBusy(null);
    }
  };

  const probeOne = async (item: CpaAuthItem) => {
    // 开启「死号自动删」时，单条测活前确认
    let willDelete = deleteOnDead;
    if (deleteOnDead) {
      const ok = window.confirm(
        `测活「${item.email || item.filename}」\n\n若判定为死号（401/402/403），将删除本地 Auth 文件。\n\n确定继续？\n（可在设置关闭「测活死号自动删除」）`
      );
      if (!ok) return;
      willDelete = true;
    }
    setRowBusy(`probe:${item.filename}`);
    setProg({
      kind: 'probe',
      total: 1,
      done: 0,
      ok: 0,
      failed: 0,
      running: true,
      current: item.email || item.filename
    });
    try {
      const r = await window.api.probeCpaAuthBatch({
        filenames: [item.filename],
        concurrency: 1,
        deleteOnDead: willDelete
      });
      const one = r.results[0];
      if (one?.filename) {
        setProbeMap((m) => ({
          ...m,
          [one.filename]: one.probeAction || (one.ok ? 'ok' : 'error')
        }));
      }
      setProg({
        kind: 'probe',
        total: 1,
        done: 1,
        ok: r.ok || 0,
        failed: r.failed || 0,
        dead: r.dead,
        deleted: r.deleted,
        running: false,
        current: item.email || item.filename
      });
      if (one?.probeDeleted || one?.probeAction === 'dead') {
        push({
          tone: 'warn',
          title: '测活：死号',
          description: `${item.email || item.filename}${one.probeDeleted ? ' · 已删' : ' · 已保留'}`
        });
        if (one.probeDeleted) await reload();
      } else if (one?.ok || one?.probeAction === 'ok') {
        push({
          tone: 'ok',
          title: '测活 OK',
          description: item.email || item.filename
        });
      } else {
        push({
          tone: 'warn',
          title: '测活异常',
          description: String(one?.error || one?.probeAction || 'unknown')
        });
      }
    } catch (err) {
      push({
        tone: 'danger',
        title: '测活失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setRowBusy(null);
      window.setTimeout(() => setProg(null), 2500);
    }
  };

  const resignBatch = async () => {
    const filenames = targetNames();
    if (filenames.length === 0) {
      push({ tone: 'warn', title: '没有可重签的文件' });
      return;
    }
    setBatchBusy('resign');
    setProg({
      kind: 'resign',
      total: filenames.length,
      done: 0,
      ok: 0,
      failed: 0,
      remoteOk: 0,
      remoteFailed: 0,
      running: true
    });
    try {
      // 分块更新进度
      const CHUNK = 8;
      let ok = 0;
      let failed = 0;
      let noXai = 0;
      let remoteOkN = 0;
      let remoteFailedN = 0;
      for (let i = 0; i < filenames.length; i += CHUNK) {
        const chunk = filenames.slice(i, i + CHUNK);
        setProg((p) =>
          p
            ? { ...p, current: chunk[0], running: true }
            : p
        );
        const r = await window.api.resignCpaAuthBatch({
          filenames: chunk,
          pushRemote: resignPushRemote
        });
        ok += r.ok || 0;
        failed += r.failed || 0;
        noXai += r.results.filter((x) => x.ok && x.xai === false).length;
        remoteOkN += r.remoteOk ?? r.results.filter((x) => x.remoteOk === true).length;
        remoteFailedN +=
          r.remoteFailed ?? r.results.filter((x) => x.remoteOk === false).length;
        setProg({
          kind: 'resign',
          total: filenames.length,
          done: Math.min(i + chunk.length, filenames.length),
          ok,
          failed,
          remoteOk: remoteOkN,
          remoteFailed: remoteFailedN,
          running: i + chunk.length < filenames.length,
          current: chunk[chunk.length - 1]
        });
      }
      const remotePart = resignPushRemote
        ? ` · 远程OK ${remoteOkN}${remoteFailedN ? ` · 远程失败 ${remoteFailedN}` : ''}`
        : '';
      push({
        tone: failed > 0 || remoteFailedN > 0 ? 'warn' : 'ok',
        title: '批量重签完成',
        description: `成功 ${ok} · 失败 ${failed}${noXai ? ` · 无 xai ${noXai}` : ''}${remotePart}`
      });
      await reload();
    } catch (err) {
      push({
        tone: 'danger',
        title: '批量重签失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setBatchBusy(null);
      window.setTimeout(() => setProg(null), 3000);
    }
  };

  const pushRemoteBatch = async () => {
    const filenames = targetNames();
    if (filenames.length === 0) {
      push({ tone: 'warn', title: '没有可推送的文件' });
      return;
    }
    if (!remoteReady) {
      push({
        tone: 'warn',
        title: '未配置远程 CPA',
        description: '请在设置中填写「远程 CPA 地址」与「管理密钥」'
      });
      return;
    }
    setBatchBusy('push');
    setProg({
      kind: 'push',
      total: filenames.length,
      done: 0,
      ok: 0,
      failed: 0,
      remoteOk: 0,
      remoteFailed: 0,
      running: true
    });
    try {
      const CHUNK = 12;
      let ok = 0;
      let failed = 0;
      let remoteUrl = '';
      for (let i = 0; i < filenames.length; i += CHUNK) {
        const chunk = filenames.slice(i, i + CHUNK);
        setProg((p) => (p ? { ...p, current: chunk[0], running: true } : p));
        const r = await window.api.pushCpaAuthRemote({
          filenames: chunk,
          concurrency: Math.min(4, chunk.length)
        });
        ok += r.ok || 0;
        failed += r.failed || 0;
        if (r.remoteUrl) remoteUrl = r.remoteUrl;
        setProg({
          kind: 'push',
          total: filenames.length,
          done: Math.min(i + chunk.length, filenames.length),
          ok,
          failed,
          remoteOk: ok,
          remoteFailed: failed,
          running: i + chunk.length < filenames.length,
          current: chunk[chunk.length - 1]
        });
      }
      push({
        tone: failed > 0 ? 'warn' : 'ok',
        title: '远程推送完成',
        description: `成功 ${ok} · 失败 ${failed}${remoteUrl ? ` · ${remoteUrl}` : ''}`
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '远程推送失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setBatchBusy(null);
      window.setTimeout(() => setProg(null), 3000);
    }
  };

  const probeBatch = async () => {
    const filenames = targetNames();
    if (filenames.length === 0) {
      push({ tone: 'warn', title: '没有可测活的文件' });
      return;
    }
    setBatchBusy('probe');
    setProg({
      kind: 'probe',
      total: filenames.length,
      done: 0,
      ok: 0,
      failed: 0,
      dead: 0,
      deleted: 0,
      running: true
    });
    try {
      const CHUNK = 12;
      let ok = 0;
      let failed = 0;
      let dead = 0;
      let deleted = 0;
      const nextProbe: Record<string, string> = {};
      for (let i = 0; i < filenames.length; i += CHUNK) {
        const chunk = filenames.slice(i, i + CHUNK);
        setProg((p) => (p ? { ...p, current: chunk[0], running: true } : p));
        const r = await window.api.probeCpaAuthBatch({
          filenames: chunk,
          concurrency: Math.min(6, chunk.length),
          deleteOnDead
        });
        ok += r.ok || 0;
        failed += r.failed || 0;
        dead += r.dead || 0;
        deleted += r.deleted || 0;
        for (const x of r.results) {
          if (x.filename) {
            nextProbe[x.filename] = x.probeAction || (x.ok ? 'ok' : 'error');
          }
        }
        setProbeMap((m) => ({ ...m, ...nextProbe }));
        setProg({
          kind: 'probe',
          total: filenames.length,
          done: Math.min(i + chunk.length, filenames.length),
          ok,
          failed,
          dead,
          deleted,
          running: i + chunk.length < filenames.length,
          current: chunk[chunk.length - 1]
        });
      }
      push({
        tone: dead > 0 || failed > 0 ? 'warn' : 'ok',
        title: '批量 CPA 测活完成',
        description: `OK ${ok} · 死号 ${dead} · 已删 ${deleted}${deleteOnDead ? '' : ' · 死号不自动删'}`
      });
      if (deleted > 0) await reload();
    } catch (err) {
      push({
        tone: 'danger',
        title: '批量测活失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setBatchBusy(null);
      window.setTimeout(() => setProg(null), 3500);
    }
  };

  const deleteBatch = async () => {
    const filenames = selected.size > 0 ? [...selected] : [];
    if (filenames.length === 0) {
      push({ tone: 'warn', title: '请先勾选要删除的 Auth 文件' });
      return;
    }
    if (
      !window.confirm(
        `确认删除 ${filenames.length} 个 Auth 文件？\n目录：${dir || 'auth'}\n此操作不可恢复。`
      )
    ) {
      return;
    }
    setBatchBusy('delete');
    setProg({
      kind: 'delete',
      total: filenames.length,
      done: 0,
      ok: 0,
      failed: 0,
      running: true
    });
    try {
      const r = await window.api.deleteCpaAuth({ filenames });
      setProg({
        kind: 'delete',
        total: r.total,
        done: r.total,
        ok: r.deleted,
        failed: r.failed,
        deleted: r.deleted,
        running: false
      });
      setSelected(new Set());
      push({
        tone: r.failed > 0 ? 'warn' : 'ok',
        title: '已删除 Auth',
        description: `删除 ${r.deleted} · 失败 ${r.failed}`
      });
      await reload();
    } catch (err) {
      push({
        tone: 'danger',
        title: '删除失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setBatchBusy(null);
      window.setTimeout(() => setProg(null), 2500);
    }
  };

  const exportBatch = async () => {
    const filenames = targetNames();
    if (filenames.length === 0) {
      push({ tone: 'warn', title: '没有可导出的文件' });
      return;
    }
    if (filenames.length > 200) {
      push({ tone: 'warn', title: '单次最多导出 200 个' });
      return;
    }
    setBatchBusy('export');
    setProg({
      kind: 'export',
      total: filenames.length,
      done: 0,
      ok: 0,
      failed: 0,
      running: true
    });
    try {
      const r = await window.api.exportCpaAuth({ filenames });
      if (!r.files.length) {
        push({ tone: 'warn', title: '没有读到文件' });
        return;
      }
      // 单文件直接下 json；多文件合并为 zip 文本包（多 json 顺序拼接 + 文件名注释）
      if (r.files.length === 1) {
        const f = r.files[0];
        downloadBlob(
          f.filename,
          new Blob([f.content], { type: 'application/json;charset=utf-8' })
        );
      } else {
        // 简易多文件：每个文件前加分隔标记，或打包成一个 .txt 清单 + 内嵌 json
        // 更友好：逐个下载会弹多次；这里打成一个 archive 文本包
        const parts = r.files.map(
          (f) =>
            `===== FILE: ${f.filename} =====\n${f.content.trimEnd()}\n`
        );
        downloadBlob(
          `cpa-auth-export-${stamp()}.txt`,
          new Blob([parts.join('\n')], { type: 'text/plain;charset=utf-8' })
        );
        // 同时提供逐文件下载（仅少量时）
        if (r.files.length <= 10) {
          for (const f of r.files) {
            downloadBlob(
              f.filename,
              new Blob([f.content], { type: 'application/json;charset=utf-8' })
            );
          }
        }
      }
      setProg({
        kind: 'export',
        total: filenames.length,
        done: r.files.length,
        ok: r.files.length,
        failed: filenames.length - r.files.length,
        running: false
      });
      push({
        tone: 'ok',
        title: '已导出 Auth',
        description: `${r.files.length} 个文件${r.files.length > 1 ? '（汇总 txt' + (r.files.length <= 10 ? ' + 分文件' : '') + '）' : ''}`
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '导出失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setBatchBusy(null);
      window.setTimeout(() => setProg(null), 2500);
    }
  };

  const progPct =
    prog && prog.total > 0 ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : 0;
  const progTitle =
    prog?.kind === 'probe'
      ? prog.running
        ? 'CPA 测活进行中'
        : 'CPA 测活完成'
      : prog?.kind === 'resign'
        ? prog.running
          ? '批量重签进行中'
          : '批量重签完成'
        : prog?.kind === 'delete'
          ? prog.running
            ? '删除进行中'
            : '删除完成'
          : prog?.kind === 'push'
            ? prog.running
              ? '远程推送进行中'
              : '远程推送完成'
            : prog?.running
              ? '导出进行中'
              : '导出完成';

  return (
    <div className="space-y-5">
      <section className="terminal-grid">
        <AuthMetric label="Auth 文件" value={String(items.length)} Icon={KeyRound} />
        <AuthMetric label="含 xai" value={String(xaiCount)} Icon={CheckSquare} />
        <AuthMetric label="bot_flag=1" value={String(botFlag1Count)} Icon={Activity} />
        <AuthMetric
          label="死号自动删"
          value={deleteOnDead ? '开' : '关'}
          Icon={Trash2}
        />
      </section>

      {prog && (
        <div className="rounded-[16px] border border-primary/30 bg-primary/5 px-4 py-3 shadow-[var(--ios-shadow)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold tracking-tight">{progTitle}</p>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {prog.done}/{prog.total}
                {prog.current ? ` · ${prog.current}` : ''}
                {` · 成功 ${prog.ok} · 失败 ${prog.failed}`}
                {prog.dead != null ? ` · 死号 ${prog.dead}` : ''}
                {prog.deleted != null ? ` · 已删 ${prog.deleted}` : ''}
                {prog.remoteOk != null && prog.remoteOk > 0
                  ? ` · 远程OK ${prog.remoteOk}`
                  : ''}
                {prog.remoteFailed != null && prog.remoteFailed > 0
                  ? ` · 远程失败 ${prog.remoteFailed}`
                  : ''}
              </p>
            </div>
            <span className="chip tabular-nums">{progPct}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                prog.running ? 'bg-primary' : 'bg-emerald-500'
              )}
              style={{ width: `${progPct}%` }}
            />
          </div>
        </div>
      )}

      <div className="ios-group">
        <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="page-kicker">Auth</p>
            <h3 className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">CPA 凭证</h3>
            <p className="mt-0.5 truncate text-[12px] text-muted-foreground" title={dir}>
              {dir || '加载中…'}
              {selected.size > 0 ? ` · 已选 ${selected.size}` : ''}
              {!deleteOnDead ? ' · 测活死号不删' : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={toggleEmailPrivacy}
              title={emailMasked ? '显示完整邮箱' : '遮蔽邮箱（仅前5位）'}
            >
              {emailMasked ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              {emailMasked ? '显示邮箱' : '遮蔽邮箱'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={selectAll}
              disabled={items.length === 0 || busy}
            >
              {allSelected ? (
                <CheckSquare className="h-3.5 w-3.5" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              {allSelected ? '取消全选' : '全选'}
            </Button>
            <Button
              size="sm"
              onClick={() => void probeBatch()}
              disabled={busy || items.length === 0}
              title={deleteOnDead ? '401/402/403 将删除文件' : '死号仅标记不删'}
            >
              <Activity
                className={cn('h-3.5 w-3.5', batchBusy === 'probe' && 'animate-pulse')}
              />
              {batchBusy === 'probe'
                ? `测活 ${prog?.done ?? 0}/${prog?.total ?? 0}`
                : selected.size > 0
                  ? `测活所选(${selected.size})`
                  : '批量 CPA 测活'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setResignPushRemote((v) => {
                  const next = !v;
                  try {
                    localStorage.setItem(RESIGN_PUSH_KEY, next ? '1' : '0');
                  } catch {
                    /* ignore */
                  }
                  return next;
                });
              }}
              title={
                resignPushRemote
                  ? '重签成功后会推送到远程 CPA（点击关闭）'
                  : '重签后不推远程（点击开启）'
              }
            >
              <CloudUpload className="h-3.5 w-3.5" />
              {resignPushRemote ? '重签后推:开' : '重签后推:关'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void resignBatch()}
              disabled={busy || items.length === 0}
              title={
                resignPushRemote
                  ? '重签后按设置推送到远程 CPA'
                  : '仅本地重签（不推远程）'
              }
            >
              <RotateCcw
                className={cn('h-3.5 w-3.5', batchBusy === 'resign' && 'animate-spin')}
              />
              {batchBusy === 'resign'
                ? `重签 ${prog?.done ?? 0}/${prog?.total ?? 0}`
                : selected.size > 0
                  ? `重签所选(${selected.size})`
                  : '批量重签'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void pushRemoteBatch()}
              disabled={busy || items.length === 0}
              title={
                remoteReady
                  ? '把已有 auth 文件上传到远程 CPA（不重新 mint）'
                  : '请先在设置中配置远程 CPA 地址与密钥'
              }
            >
              <CloudUpload
                className={cn('h-3.5 w-3.5', batchBusy === 'push' && 'animate-pulse')}
              />
              {batchBusy === 'push'
                ? `推送 ${prog?.done ?? 0}/${prog?.total ?? 0}`
                : selected.size > 0
                  ? `推送远程(${selected.size})`
                  : '推送远程'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void exportBatch()}
              disabled={busy || items.length === 0}
              title="导出 JSON（多文件打 txt 汇总）"
            >
              <FileDown className="h-3.5 w-3.5" />
              {batchBusy === 'export'
                ? '导出中…'
                : selected.size > 0
                  ? `导出(${selected.size})`
                  : '导出全部'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void deleteBatch()}
              disabled={busy || selected.size === 0}
              title="删除已选 Auth 文件"
            >
              <Trash2
                className={cn('h-3.5 w-3.5', batchBusy === 'delete' && 'animate-pulse')}
              />
              {batchBusy === 'delete' ? '删除中…' : `删除(${selected.size})`}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void reload()}
              disabled={loading || busy}
            >
              <RefreshCcw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-12 text-center text-[13px] text-muted-foreground">
          加载中…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-12 text-center text-[13px] text-muted-foreground">
          Auth 目录为空。注册成功自动导出，或在号池点「补 Auth」。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[16px] border border-border bg-card shadow-[var(--ios-shadow)]">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="border-b border-border/70 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2.5" />
                <th className="px-3 py-2.5 font-medium">邮箱</th>
                <th className="px-3 py-2.5 font-medium">文件</th>
                <th className="px-3 py-2.5 font-medium">xai</th>
                <th className="px-3 py-2.5 font-medium">bot_flag</th>
                <th className="px-3 py-2.5 font-medium">过期</th>
                <th className="px-3 py-2.5 font-medium">测活</th>
                <th className="px-3 py-2.5 font-medium">修改</th>
                <th className="px-3 py-2.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const probe = probeMap[item.filename];
                const rowResign = rowBusy === `resign:${item.filename}`;
                const rowProbe = rowBusy === `probe:${item.filename}`;
                return (
                  <tr
                    key={item.filename}
                    className={cn(
                      'border-b border-border/40 last:border-0',
                      selected.has(item.filename) && 'bg-primary/5'
                    )}
                  >
                    <td className="px-3 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(item.filename)}
                        onChange={() => toggle(item.filename)}
                        disabled={busy}
                        className="h-4 w-4 accent-[hsl(var(--primary))]"
                      />
                    </td>
                    <td
                      className="max-w-[14rem] truncate px-3 py-2.5 font-medium"
                      title={
                        emailMasked && item.email
                          ? '已遮蔽 · 点工具栏「显示邮箱」查看完整'
                          : item.email || undefined
                      }
                    >
                      {maskEmail(item.email, emailMasked)}
                    </td>
                    <td
                      className="max-w-[12rem] truncate px-3 py-2.5 font-mono text-[12px] text-muted-foreground"
                      title={item.filename}
                    >
                      {item.filename}
                    </td>
                    <td className="px-3 py-2.5">
                      {item.xai ? (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          xai
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <BotFlagCell
                        flag={item.botFlagSource}
                        is1={item.isBotFlag1}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-muted-foreground">
                      {item.expired || '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <ProbeBadge action={probe} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[12px] text-muted-foreground">
                      {fmtTime(item.mtime)}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => void probeOne(item)}
                          title="单条 CPA 测活"
                        >
                          <Activity
                            className={cn('h-3.5 w-3.5', rowProbe && 'animate-pulse')}
                          />
                          {rowProbe ? '…' : '测活'}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => void resign(item)}
                        >
                          <RotateCcw
                            className={cn('h-3.5 w-3.5', rowResign && 'animate-spin')}
                          />
                          {rowResign ? '…' : '重签'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BotFlagCell({
  flag,
  is1
}: {
  flag?: number | string | null;
  is1?: boolean;
}) {
  if (flag === undefined || flag === null) {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }
  if (is1 || flag === 1 || flag === '1') {
    return (
      <span
        className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive"
        title="bot_flag_source=1（JWT 内，无法抹掉）"
      >
        1
      </span>
    );
  }
  return (
    <span
      className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
      title={`bot_flag_source=${String(flag)}`}
    >
      {String(flag)}
    </span>
  );
}

function ProbeBadge({ action }: { action?: string }) {
  if (!action) {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }
  // 队列列表：绿 O / 红 X 闪烁提示（不拆单独卡片）
  if (action === 'ok') {
    return (
      <span
        className="inline-flex items-center gap-1.5"
        title="测活通过"
      >
        <span
          className="inline-flex h-5 w-5 animate-probe-flash items-center justify-center rounded-full bg-emerald-500/20 text-[12px] font-bold leading-none text-emerald-600 dark:text-emerald-400"
          aria-label="OK"
        >
          O
        </span>
        <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
          活
        </span>
      </span>
    );
  }
  if (action === 'dead') {
    return (
      <span className="inline-flex items-center gap-1.5" title="死号">
        <span
          className="inline-flex h-5 w-5 animate-probe-flash items-center justify-center rounded-full bg-destructive/20 text-[12px] font-bold leading-none text-destructive"
          aria-label="死号"
        >
          X
        </span>
        <span className="text-[10px] font-medium text-destructive">死</span>
      </span>
    );
  }
  if (action === 'keep') {
    return (
      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
        保留
      </span>
    );
  }
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
      {action}
    </span>
  );
}

function AuthMetric({
  label,
  value,
  Icon
}: {
  label: string;
  value: string;
  Icon: typeof KeyRound;
}) {
  return (
    <div className="rounded-[16px] border border-border bg-card p-4 shadow-[var(--ios-shadow)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground/80" />
      </div>
      <p className="mt-2 text-[22px] font-semibold tracking-tight tabular-nums">{value}</p>
    </div>
  );
}
