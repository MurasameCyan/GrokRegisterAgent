import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckSquare,
  CloudUpload,
  Database,
  Eye,
  EyeOff,
  FileDown,
  KeyRound,
  Link2,
  ListChecks,
  RefreshCcw,
  RotateCcw,
  Square,
  Trash2
} from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { Switch } from '@renderer/components/ui/Switch';
import { PaginationBar } from '@renderer/components/ui/PaginationBar';
import { useClientPagination } from '@renderer/hooks/useClientPagination';
import { useToastStore } from '@renderer/store/toastStore';
import { useSettingsStore } from '@renderer/store/settingsStore';
import type { CpaAuthItem } from '@shared/ipc';
import { cn } from '@renderer/lib/cn';
import {
  loadEmailPrivacyMask,
  maskEmail,
  saveEmailPrivacyMask
} from '@renderer/lib/maskEmail';

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
  kind: 'probe' | 'resign' | 'delete' | 'export' | 'push' | 'backfill';
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
const PAGE_SIZE_KEY = 'gra-auth-page-size';
const META_FILTER_KEY = 'gra-auth-meta-filter';

/** 行内标记筛选：全部 / 无sso / 无邮箱 / 待补全 */
type MetaFilter = 'all' | 'no_sso' | 'no_email' | 'need_fill';

function loadMetaFilter(): MetaFilter {
  try {
    const v = localStorage.getItem(META_FILTER_KEY);
    if (v === 'no_sso' || v === 'no_email' || v === 'need_fill' || v === 'all') return v;
  } catch {
    /* ignore */
  }
  return 'all';
}

export function AuthPage({ onOpenPool }: { onOpenPool?: () => void } = {}) {
  const push = useToastStore((s) => s.push);
  const settings = useSettingsStore((s) => s.data);
  const [dir, setDir] = useState('');
  const [items, setItems] = useState<CpaAuthItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState<
    'resign' | 'probe' | 'delete' | 'export' | 'push' | 'backfill' | null
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
  const [metaFilter, setMetaFilter] = useState<MetaFilter>(() => loadMetaFilter());

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

  const hasEmail = (i: CpaAuthItem) => Boolean(String(i.email || '').trim());
  const hasSso = (i: CpaAuthItem) => Boolean(i.hasSso);

  const filteredItems = useMemo(() => {
    if (metaFilter === 'all') return items;
    if (metaFilter === 'no_sso') return items.filter((i) => !hasSso(i));
    if (metaFilter === 'no_email') return items.filter((i) => !hasEmail(i));
    // need_fill：无 sso 或 无邮箱（回填/mint 前关注集）
    return items.filter((i) => !hasSso(i) || !hasEmail(i));
  }, [items, metaFilter]);

  const {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    rangeFrom,
    rangeTo,
    setPage,
    changePageSize,
    resetPage
  } = useClientPagination(filteredItems, PAGE_SIZE_KEY);

  const changeMetaFilter = (f: MetaFilter) => {
    setMetaFilter(f);
    resetPage();
    try {
      localStorage.setItem(META_FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };

  const clearMetaFilter = () => changeMetaFilter('all');

  // 列表/筛选变化时清理无效选中
  useEffect(() => {
    const names = new Set(filteredItems.map((i) => i.filename));
    setSelected((prev) => {
      const next = new Set([...prev].filter((n) => names.has(n)));
      return next.size === prev.size ? prev : next;
    });
  }, [filteredItems]);

  const allSelected =
    filteredItems.length > 0 && filteredItems.every((i) => selected.has(i.filename));
  const pageAllSelected =
    pageItems.length > 0 && pageItems.every((i) => selected.has(i.filename));
  const xaiCount = useMemo(() => items.filter((i) => i.xai).length, [items]);
  const busy = batchBusy !== null || rowBusy !== null;

  const toggle = (filename: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });

  /** 全选：当前筛选结果全部 */
  const selectAll = () => {
    if (filteredItems.length === 0) return;
    setSelected(
      allSelected ? new Set() : new Set(filteredItems.map((i) => i.filename))
    );
  };

  /** 本页：仅当前分页 */
  const selectPage = () => {
    if (pageItems.length === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (pageAllSelected) {
        for (const i of pageItems) next.delete(i.filename);
      } else {
        for (const i of pageItems) next.add(i.filename);
      }
      return next;
    });
  };

  /** 有勾选用勾选；否则用当前筛选列表 */
  const targetNames = () =>
    selected.size > 0
      ? [...selected]
      : filteredItems.map((i) => i.filename);

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
  const missingSsoCount = useMemo(
    () => items.filter((i) => !i.hasSso).length,
    [items]
  );
  const noEmailAuthCount = useMemo(
    () => items.filter((i) => !String(i.email || '').trim()).length,
    [items]
  );
  const needFillCount = useMemo(
    () => items.filter((i) => !hasSso(i) || !hasEmail(i)).length,
    [items]
  );
  const hasActiveMetaFilter = metaFilter !== 'all';

  /** 长按「回填SSO」进入 force 覆盖（约 650ms） */
  const backfillHoldRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    fired: boolean;
  }>({ timer: null, fired: false });

  const clearBackfillHold = () => {
    if (backfillHoldRef.current.timer) {
      clearTimeout(backfillHoldRef.current.timer);
      backfillHoldRef.current.timer = null;
    }
  };

  const backfillSso = async (opts?: { force?: boolean }) => {
    const force = Boolean(opts?.force);
    // 有勾选用勾选，否则用当前筛选列表（方便先筛「无sso」再回填）
    const pool =
      selected.size > 0
        ? items.filter((i) => selected.has(i.filename))
        : filteredItems;
    // 非 force：只处理无 sso；force：处理池内全部（含已有 sso）
    const targets = force ? pool : pool.filter((i) => !hasSso(i));
    if (targets.length === 0) {
      push({
        tone: 'warn',
        title: force ? '没有可覆盖的目标' : '无需回填',
        description: force
          ? selected.size > 0
            ? '当前选择为空'
            : 'Auth 列表为空'
          : selected.size > 0
            ? '所选均已有 sso（长按按钮可强制覆盖）'
            : '全部 auth 已含 sso（长按按钮可强制覆盖）'
      });
      return;
    }

    const noEmail = targets.filter((t) => !String(t.email || '').trim()).length;
    const hasEmail = targets.length - noEmail;
    const already = targets.filter((t) => t.hasSso).length;

    if (force) {
      const step1 = window.confirm(
        `【强制覆盖】从号池按 email 重写 sso\n\n` +
          `将处理 ${targets.length} 个文件` +
          (already > 0 ? `（其中 ${already} 个已有 sso，将被覆盖）` : '') +
          `。\n` +
          `匹配：号池同邮箱最新 SSO。\n\n` +
          `注意：无邮箱的 auth（${noEmail} 个）无法靠 email 回填，` +
          `只能重新 mint 或手工补 sso。\n\n` +
          `继续？`
      );
      if (!step1) return;
      const step2 = window.confirm(
        `再次确认：强制覆盖已有 sso，不可撤销（除非再回填/重签）。\n` +
          `有邮箱可匹配约 ${hasEmail} 个 · 无邮箱跳过 ${noEmail} 个。\n\n` +
          `确定强制写入？`
      );
      if (!step2) return;
    } else {
      const ok = window.confirm(
        `从号池按 email 回填 sso\n\n` +
          `将处理 ${targets.length} 个无 sso 文件（已有 sso 跳过）。\n` +
          `匹配：号池同邮箱（忽略大小写）的最新 SSO。\n\n` +
          `无邮箱 auth（${noEmail} 个）无法回填，需重新 mint 或手工补 sso。\n` +
          `需要覆盖已有 sso 时：长按「回填SSO」约 0.6 秒进入强制模式。`
      );
      if (!ok) return;
    }

    setBatchBusy('backfill');
    setProg({
      kind: 'backfill',
      total: targets.length,
      done: 0,
      ok: 0,
      failed: 0,
      running: true,
      current: targets[0]?.email || targets[0]?.filename
    });
    try {
      const r = await window.api.backfillCpaAuthSso({
        filenames: targets.map((t) => t.filename),
        force
      });
      setProg({
        kind: 'backfill',
        total: r.scanned,
        done: r.scanned,
        ok: r.filled,
        failed: r.failed + r.skippedNoMatch + r.skippedNoEmail,
        running: false
      });
      const noEmailHint =
        r.skippedNoEmail > 0
          ? ` · 无邮箱跳过 ${r.skippedNoEmail}（请重 mint/手补）`
          : '';
      push({
        tone: r.filled > 0 ? 'ok' : 'warn',
        title: force ? '强制回填 SSO 完成' : '回填 SSO 完成',
        description:
          `写入 ${r.filled} · 已有跳过 ${r.alreadyHasSso} · 号池无匹配 ${r.skippedNoMatch} · ` +
          `失败 ${r.failed}${noEmailHint}`
      });
      await reload();
    } catch (err) {
      push({
        tone: 'danger',
        title: '回填失败',
        description: err instanceof Error ? err.message : String(err)
      });
      setProg((p) => (p ? { ...p, running: false } : p));
    } finally {
      setBatchBusy(null);
      window.setTimeout(() => setProg(null), 4000);
    }
  };

  const onBackfillPointerDown = () => {
    if (busy || items.length === 0) return;
    clearBackfillHold();
    backfillHoldRef.current.fired = false;
    backfillHoldRef.current.timer = setTimeout(() => {
      backfillHoldRef.current.fired = true;
      backfillHoldRef.current.timer = null;
      void backfillSso({ force: true });
    }, 650);
  };

  const onBackfillPointerUp = () => {
    const wasHold = backfillHoldRef.current.fired;
    clearBackfillHold();
    if (wasHold) return; // 长按已触发 force
    if (busy || items.length === 0) return;
    void backfillSso({ force: false });
  };

  const onBackfillPointerLeave = () => {
    clearBackfillHold();
  };

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
            : prog?.kind === 'backfill'
              ? prog.running
                ? '回填 SSO 进行中'
                : '回填 SSO 完成'
              : prog?.running
                ? '导出进行中'
                : '导出完成';

  return (
    <div className="space-y-5">
      <section className="terminal-grid">
        <AuthMetric label="Auth 文件" value={String(items.length)} Icon={KeyRound} />
        <AuthMetric label="xai 标识" value={String(xaiCount)} Icon={KeyRound} />
        <AuthMetric label="无 sso" value={String(missingSsoCount)} Icon={Link2} />
        <AuthMetric label="无邮箱" value={String(noEmailAuthCount)} Icon={KeyRound} />
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
        <div className="space-y-3 border-b border-border/70 px-4 py-3.5">
          {/* 标题行：隐私 + 刷新 */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="page-kicker">Auth</p>
              <h3 className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">CPA 凭证</h3>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground" title={dir}>
                {selected.size > 0 ? `已选 ${selected.size} 项` : '未选择'}
                {hasActiveMetaFilter
                  ? ` · 筛选 ${filteredItems.length}/${items.length}`
                  : ` · 共 ${items.length}`}
                {missingSsoCount > 0 ? ` · 无sso ${missingSsoCount}` : ''}
                {noEmailAuthCount > 0 ? ` · 无邮箱 ${noEmailAuthCount}` : ''}
                {!deleteOnDead ? ' · 测活死号不删' : ''}
                {dir ? ` · ${dir}` : ''}
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
                onClick={() => void reload()}
                disabled={loading || busy}
                title="重新扫描 Auth 目录"
              >
                <RefreshCcw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                刷新
              </Button>
            </div>
          </div>

          {/* 筛选行：标记 */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-0.5 w-8 shrink-0 text-[10px] text-muted-foreground">标记</span>
            {(
              [
                { id: 'all' as const, label: '全部', count: items.length },
                { id: 'no_sso' as const, label: '无sso', count: missingSsoCount },
                { id: 'no_email' as const, label: '无邮箱', count: noEmailAuthCount },
                { id: 'need_fill' as const, label: '待补全', count: needFillCount }
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => changeMetaFilter(tab.id)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                  metaFilter === tab.id
                    ? tab.id === 'no_email'
                      ? 'bg-orange-600 text-white shadow-sm'
                      : tab.id === 'no_sso'
                        ? 'bg-amber-600 text-white shadow-sm'
                        : 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
                title={
                  tab.id === 'no_sso'
                    ? '无 sso 字段，可回填'
                    : tab.id === 'no_email'
                      ? '无邮箱，无法 email 回填'
                      : tab.id === 'need_fill'
                        ? '无 sso 或无邮箱'
                        : '不限制标记'
                }
              >
                {tab.label}
                <span className="ml-1 tabular-nums opacity-80">{tab.count}</span>
              </button>
            ))}
          </div>

          {/* 操作：选择 | 业务 */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 hidden text-[10px] text-muted-foreground sm:inline">选择</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={selectAll}
                disabled={filteredItems.length === 0 || busy}
                title="全选当前筛选列表"
              >
                {allSelected ? (
                  <CheckSquare className="h-3.5 w-3.5" />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )}
                {allSelected ? '取消全选' : '全选'}
              </Button>
              <span className="mx-0.5 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
              <span className="mr-0.5 hidden text-[10px] text-muted-foreground sm:inline">业务</span>
              <Button
                size="sm"
                onClick={() => void probeBatch()}
                disabled={busy || filteredItems.length === 0}
                title={deleteOnDead ? '401/402/403 将删除文件' : '死号仅标记不删'}
              >
                <Activity
                  className={cn('h-3.5 w-3.5', batchBusy === 'probe' && 'animate-pulse')}
                />
                {batchBusy === 'probe'
                  ? `测活 ${prog?.done ?? 0}/${prog?.total ?? 0}`
                  : selected.size > 0
                    ? `测活(${selected.size})`
                    : hasActiveMetaFilter
                      ? `测活(${filteredItems.length})`
                      : '测活全部'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void resignBatch()}
                disabled={busy || filteredItems.length === 0}
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
                    ? `重签(${selected.size})`
                    : hasActiveMetaFilter
                      ? `重签(${filteredItems.length})`
                      : '批量重签'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void pushRemoteBatch()}
                disabled={busy || filteredItems.length === 0}
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
                    ? `推送(${selected.size})`
                    : hasActiveMetaFilter
                      ? `推送(${filteredItems.length})`
                      : '推送远程'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || items.length === 0}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  onBackfillPointerDown();
                }}
                onPointerUp={(e) => {
                  if (e.button !== 0) return;
                  onBackfillPointerUp();
                }}
                onPointerLeave={onBackfillPointerLeave}
                onPointerCancel={onBackfillPointerLeave}
                onContextMenu={(e) => e.preventDefault()}
                title={
                  '单击：仅回填无 sso 的文件（已有跳过）\n' +
                  '长按约 0.6s：强制覆盖已有 sso（二次确认）\n' +
                  '无邮箱 auth 无法靠 email 回填，需重新 mint 或手工补 sso'
                }
              >
                <Link2
                  className={cn('h-3.5 w-3.5', batchBusy === 'backfill' && 'animate-pulse')}
                />
                {batchBusy === 'backfill'
                  ? '回填中…'
                  : selected.size > 0
                    ? `回填SSO(${selected.size})`
                    : missingSsoCount > 0
                      ? `回填SSO(${missingSsoCount})`
                      : '回填SSO'}
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
            </div>

            {/* 导出 | 删除 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 hidden text-[10px] text-muted-foreground sm:inline">
                导入导出
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void exportBatch()}
                disabled={busy || filteredItems.length === 0}
                title="导出 JSON（多文件打 txt 汇总）"
              >
                <FileDown className="h-3.5 w-3.5" />
                {batchBusy === 'export'
                  ? '导出中…'
                  : selected.size > 0
                    ? `导出(${selected.size})`
                    : hasActiveMetaFilter
                      ? `导出筛选(${filteredItems.length})`
                      : '导出全部'}
              </Button>
              <span className="mx-0.5 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
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
            </div>
          </div>
        </div>
      </div>

      {/* 无邮箱筛选：引导号池验活补邮箱后再回填 */}
      {!loading &&
        items.length > 0 &&
        noEmailAuthCount > 0 &&
        (metaFilter === 'no_email' || metaFilter === 'need_fill') && (
          <div className="rounded-[14px] border border-orange-500/30 bg-orange-500/10 px-4 py-3 text-[13px]">
            <div className="font-medium text-orange-700 dark:text-orange-300">
              当前有 {noEmailAuthCount} 个 Auth 无邮箱
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground leading-relaxed">
              无邮箱无法按 email 从号池回填 sso。建议流程：
              <span className="text-foreground">
                {' '}
                ① 去号池对对应 SSO 验活（存活时 grok 常返回邮箱并写入号池）→ ②
                回到本页点「回填SSO」→ ③ 仍无邮箱的只能重新 mint 或手补 sso。
              </span>
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {onOpenPool && (
                <Button size="sm" onClick={onOpenPool} title="切换到号池页做 SSO 验活">
                  <Database className="h-3.5 w-3.5" />
                  去号池验活补邮箱
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => changeMetaFilter('no_sso')}
                title="筛出有邮箱但无 sso 的，可直接回填"
              >
                改筛「无sso」
              </Button>
            </div>
          </div>
        )}

      {loading && items.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-12 text-center text-[13px] text-muted-foreground">
          加载中…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-12 text-center text-[13px] text-muted-foreground">
          Auth 目录为空。注册成功自动导出，或在号池点「补 Auth」。
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-12 text-center text-[13px] text-muted-foreground">
          <p>
            当前筛选下没有 Auth 文件。
            {metaFilter === 'no_sso'
              ? ' 全部已含 sso。'
              : metaFilter === 'no_email'
                ? ' 全部已有邮箱。可切到「无sso」做回填。'
                : metaFilter === 'need_fill'
                  ? ' 无需补全（均有邮箱且有 sso）。'
                  : ''}
          </p>
          {hasActiveMetaFilter && (
            <div className="mt-3">
              <Button size="sm" variant="secondary" onClick={clearMetaFilter}>
                清空筛选
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
        <div className="overflow-x-auto rounded-[16px] border border-border bg-card shadow-[var(--ios-shadow)]">
          <table className="w-full min-w-[720px] text-left text-[13px]">
            <thead className="border-b border-border/70 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2.5" />
                <th className="px-3 py-2.5 font-medium">邮箱</th>
                <th className="px-3 py-2.5 font-medium">标记</th>
                <th className="px-3 py-2.5 font-medium">文件</th>
                <th className="px-3 py-2.5 font-medium">xai</th>
                <th className="px-3 py-2.5 font-medium">bot_flag</th>
                <th className="whitespace-nowrap px-3 py-2.5 font-medium">测活</th>
                <th className="px-3 py-2.5 font-medium">过期</th>
                <th className="px-3 py-2.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((item) => {
                const probe = probeMap[item.filename];
                const rowResign = rowBusy === `resign:${item.filename}`;
                const rowProbe = rowBusy === `probe:${item.filename}`;
                const rowNoEmail = !hasEmail(item);
                const rowNoSso = !hasSso(item);
                return (
                  <tr
                    key={item.filename}
                    className={cn(
                      'border-b border-border/40 last:border-0',
                      selected.has(item.filename) && 'bg-primary/5'
                    )}
                  >
                    <td className="px-3 py-2.5">
                      <Switch
                        size="sm"
                        checked={selected.has(item.filename)}
                        onChange={() => toggle(item.filename)}
                        disabled={busy}
                        aria-label={`选择 ${item.email || item.filename}`}
                      />
                    </td>
                    <td
                      className="max-w-[14rem] truncate px-3 py-2.5 font-medium"
                      title={
                        rowNoEmail
                          ? '无邮箱：email 回填无效，需重 mint 或手补 sso'
                          : emailMasked && item.email
                            ? '已遮蔽 · 点工具栏「显示邮箱」查看完整'
                            : item.email || undefined
                      }
                    >
                      {rowNoEmail ? (
                        <span className="text-muted-foreground">(无邮箱)</span>
                      ) : (
                        maskEmail(item.email, emailMasked)
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1">
                        {rowNoEmail && (
                          <span
                            className="rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-medium text-orange-600 dark:text-orange-400"
                            title="无邮箱：无法靠号池 email 回填 sso，请重新 mint 或手工写入"
                          >
                            无邮箱
                          </span>
                        )}
                        {rowNoSso && (
                          <span
                            className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                            title="无 sso 字段：可筛选后点「回填SSO」（需有邮箱）"
                          >
                            无sso
                          </span>
                        )}
                        {!rowNoEmail && !rowNoSso && (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        )}
                      </div>
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
                    <td className="whitespace-nowrap px-3 py-2.5">
                      <div className="inline-flex flex-row items-center gap-2">
                        <ProbeBadge action={probe} />
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 shrink-0"
                          disabled={busy}
                          onClick={() => void probeOne(item)}
                          title="单条 CPA 测活"
                        >
                          <Activity
                            className={cn('h-3.5 w-3.5', rowProbe && 'animate-pulse')}
                          />
                          {rowProbe ? '…' : '测活'}
                        </Button>
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[12px] text-muted-foreground">
                      {item.expired || '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="inline-flex flex-row items-center gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 shrink-0"
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

        <PaginationBar
          page={currentPage}
          totalPages={totalPages}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
          total={filteredItems.length}
          pageSize={pageSize}
          onChange={setPage}
          onPageSizeChange={changePageSize}
        />
        </>
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
  // 与左侧 xai 胶囊同风格：rounded-full + 浅底色
  // 1=Bot 黄色 · 0=None 绿色 · 其它/缺失 —
  if (flag === undefined || flag === null || flag === '') {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }
  if (is1 || flag === 1 || flag === '1') {
    return (
      <span
        className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
        title="bot_flag_source=1（Bot，JWT 内签发，无法抹掉）"
      >
        Bot
      </span>
    );
  }
  if (flag === 0 || flag === '0') {
    return (
      <span
        className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
        title="bot_flag_source=0（None）"
      >
        None
      </span>
    );
  }
  // 其它非 0/1 取值：仍用绿色胶囊，文案用原值
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
    return (
      <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center text-[11px] text-muted-foreground">
        —
      </span>
    );
  }
  // 横向：绿 O / 红 X 与文字同一行，不竖排
  if (action === 'ok') {
    return (
      <span
        className="inline-flex flex-row items-center gap-1"
        title="测活通过"
      >
        <span
          className="inline-flex h-5 w-5 shrink-0 animate-probe-flash items-center justify-center rounded-full bg-emerald-500/20 text-[12px] font-bold leading-none text-emerald-600 dark:text-emerald-400"
          aria-label="OK"
        >
          O
        </span>
        <span className="whitespace-nowrap text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
          活
        </span>
      </span>
    );
  }
  if (action === 'dead') {
    return (
      <span className="inline-flex flex-row items-center gap-1" title="死号">
        <span
          className="inline-flex h-5 w-5 shrink-0 animate-probe-flash items-center justify-center rounded-full bg-destructive/20 text-[12px] font-bold leading-none text-destructive"
          aria-label="死号"
        >
          X
        </span>
        <span className="whitespace-nowrap text-[10px] font-medium text-destructive">
          死
        </span>
      </span>
    );
  }
  if (action === 'keep') {
    return (
      <span className="inline-flex whitespace-nowrap rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
        保留
      </span>
    );
  }
  return (
    <span className="inline-flex whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
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
