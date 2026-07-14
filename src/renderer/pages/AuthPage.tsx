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
import { BotFlagBadge } from '@renderer/components/domain/BotFlagBadge';
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
  /** 最近一次测活结果：filename → action + http 状态码 */
  const [probeMap, setProbeMap] = useState<
    Record<string, { action: string; http?: number }>
  >({});
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

  /** 默认关；仅设置显式开启时删死号 / 同步删 SSO */
  const deleteOnDead = settings?.cpaProbeDeleteOnDead === true;
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
      // 重签写出成功后后端 ok=true；仅 probe 死号时带 probe_warn，文件仍保留
      const wrote =
        r.ok === true ||
        (Boolean(r.path || r.filename) && r.deleted !== true && !String(r.error || '').includes('no refresh'));
      if (r.ok === false && !wrote) {
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
        const probeHint = r.probe_warn
          ? ` · ⚠ ${String(r.probe_warn)}`
          : r.alive === false
            ? ' · ⚠ CPA 测活死号（文件已保留）'
            : '';
        push({
          tone:
            r.xai === false || r.remoteOk === false || r.probe_warn || r.alive === false
              ? 'warn'
              : 'ok',
          title: r.probe_warn || r.alive === false ? '重签完成（测活警告）' : '重签成功',
          description: `${item.email || item.filename}（${r.mode || 'ok'}）${xaiHint}${remoteHint}${probeHint}`
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
    // 不再弹窗确认；删死号仅由设置开关控制（默认关）
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
        deleteOnDead
      });
      const one = r.results[0];
      if (one?.filename) {
        const fname = one.filename;
        const http = Number(one.probeHttp || 0) || undefined;
        setProbeMap((m) => ({
          ...m,
          [fname]: {
            action: one.probeAction || (one.ok ? 'ok' : 'error'),
            http
          }
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
      const ssoDel =
        typeof r.ssoDeleted === 'number' && r.ssoDeleted > 0
          ? ` · 同步删 SSO ${r.ssoDeleted}`
          : '';
      const recoveredAuth =
        one?.mode === 'cpa_probe_auth_recover' ||
        one?.mode === 'cpa_probe_403_recover';
      const recoverCode = Number(one?.recoverHttp || 0);
      const recoverLabel =
        recoverCode === 401 || recoverCode === 403
          ? String(recoverCode)
          : '401/403';
      if (one?.probeDeleted || one?.probeAction === 'dead') {
        push({
          tone: 'warn',
          title: recoveredAuth
            ? `测活：${recoverLabel} 恢复后仍死号`
            : '测活：死号',
          description: `${item.email || item.filename}${one.probeDeleted ? ' · 已删 Auth' : ' · 已保留'}${ssoDel}`
        });
        if (one.probeDeleted) await reload();
      } else if (one?.ok || one?.probeAction === 'ok') {
        push({
          tone: 'ok',
          title: recoveredAuth
            ? `测活 OK（${recoverLabel} 已重登恢复）`
            : '测活 OK',
          description: item.email || item.filename
        });
        if (recoveredAuth) await reload();
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
      let ssoDeleted = 0;
      const nextProbe: Record<string, { action: string; http?: number }> = {};
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
        ssoDeleted += r.ssoDeleted || 0;
        for (const x of r.results) {
          if (x.filename) {
            const http = Number(x.probeHttp || 0) || undefined;
            nextProbe[x.filename] = {
              action: x.probeAction || (x.ok ? 'ok' : 'error'),
              http
            };
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
        description:
          `OK ${ok} · 死号 ${dead} · 已删 Auth ${deleted}` +
          (ssoDeleted > 0 ? ` · 同步删 SSO ${ssoDeleted}` : '') +
          (deleteOnDead ? '' : ' · 死号不自动删')
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
        `【强制覆盖】从 SSO 列表按 email 重写 sso\n\n` +
          `将处理 ${targets.length} 个文件` +
          (already > 0 ? `（其中 ${already} 个已有 sso，将被覆盖）` : '') +
          `。\n` +
          `匹配：SSO 列表同邮箱最新记录。\n\n` +
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
        `从 SSO 列表按 email 回填 sso\n\n` +
          `将处理 ${targets.length} 个无 sso 文件（已有 sso 跳过）。\n` +
          `匹配：SSO 列表同邮箱（忽略大小写）的最新记录。\n\n` +
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
          `写入 ${r.filled} · 已有跳过 ${r.alreadyHasSso} · 列表无匹配 ${r.skippedNoMatch} · ` +
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
              <p
                className="mt-0.5 min-h-[1.125rem] truncate text-[12px] text-muted-foreground"
                title={dir}
              >
                <span className="inline-block min-w-[4.5rem] tabular-nums">
                  {selected.size > 0 ? `已选 ${selected.size}` : '未选择'}
                </span>
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
                className="min-w-[6.5rem] justify-center"
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
                className="min-w-[5.5rem] justify-center"
                onClick={selectAll}
                disabled={filteredItems.length === 0 || busy}
                title={
                  allSelected
                    ? '取消全选'
                    : selected.size > 0
                      ? `已选 ${selected.size}，点此全选筛选结果`
                      : '全选当前筛选列表'
                }
              >
                {allSelected ? (
                  <CheckSquare className="h-3.5 w-3.5" />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )}
                全选
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="min-w-[5.5rem] justify-center"
                onClick={selectPage}
                disabled={pageItems.length === 0 || busy}
                title={pageAllSelected ? '取消本页选择' : '仅选择当前分页'}
              >
                <ListChecks className="h-3.5 w-3.5" />
                本页
              </Button>
              <span className="mx-0.5 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
              <span className="mr-0.5 hidden text-[10px] text-muted-foreground sm:inline">业务</span>
              <Button
                size="sm"
                className="min-w-[5.75rem] justify-center tabular-nums"
                onClick={() => void probeBatch()}
                disabled={busy || filteredItems.length === 0}
                title={
                  (selected.size > 0
                    ? `测活已选 ${selected.size} 条`
                    : hasActiveMetaFilter
                      ? `测活筛选 ${filteredItems.length} 条`
                      : '测活全部') +
                  (deleteOnDead ? ' · 401/402/403 将删除' : ' · 死号仅标记不删')
                }
              >
                <Activity
                  className={cn('h-3.5 w-3.5', batchBusy === 'probe' && 'animate-pulse')}
                />
                {batchBusy === 'probe' ? `${prog?.done ?? 0}/${prog?.total ?? 0}` : '测活'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="min-w-[5.75rem] justify-center tabular-nums"
                onClick={() => void resignBatch()}
                disabled={busy || filteredItems.length === 0}
                title={
                  (selected.size > 0
                    ? `重签已选 ${selected.size} 条`
                    : hasActiveMetaFilter
                      ? `重签筛选 ${filteredItems.length} 条`
                      : '批量重签') +
                  (resignPushRemote ? ' · 成功后推远程' : ' · 仅本地')
                }
              >
                <RotateCcw
                  className={cn('h-3.5 w-3.5', batchBusy === 'resign' && 'animate-spin')}
                />
                {batchBusy === 'resign' ? `${prog?.done ?? 0}/${prog?.total ?? 0}` : '重签'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="min-w-[5.75rem] justify-center tabular-nums"
                onClick={() => void pushRemoteBatch()}
                disabled={busy || filteredItems.length === 0}
                title={
                  remoteReady
                    ? selected.size > 0
                      ? `推送已选 ${selected.size} 条`
                      : hasActiveMetaFilter
                        ? `推送筛选 ${filteredItems.length} 条`
                        : '推送远程'
                    : '请先在设置中配置远程 CPA 地址与密钥'
                }
              >
                <CloudUpload
                  className={cn('h-3.5 w-3.5', batchBusy === 'push' && 'animate-pulse')}
                />
                {batchBusy === 'push' ? `${prog?.done ?? 0}/${prog?.total ?? 0}` : '推送'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="min-w-[6.25rem] justify-center"
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
                  (selected.size > 0
                    ? `当前范围：已选 ${selected.size} 条\n`
                    : missingSsoCount > 0
                      ? `当前无 sso：${missingSsoCount} 条\n`
                      : '') +
                  '无邮箱 auth 无法靠 email 回填，需重新 mint 或手工补 sso'
                }
              >
                <Link2
                  className={cn('h-3.5 w-3.5', batchBusy === 'backfill' && 'animate-pulse')}
                />
                {batchBusy === 'backfill' ? '回填中…' : '回填SSO'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="min-w-[6.5rem] justify-center"
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
                className="min-w-[5.75rem] justify-center"
                onClick={() => void exportBatch()}
                disabled={busy || filteredItems.length === 0}
                title={
                  selected.size > 0
                    ? `导出已选 ${selected.size} 条`
                    : hasActiveMetaFilter
                      ? `导出筛选 ${filteredItems.length} 条`
                      : '导出全部 JSON'
                }
              >
                <FileDown className="h-3.5 w-3.5" />
                {batchBusy === 'export' ? '导出中…' : '导出'}
              </Button>
              <span className="mx-0.5 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
              <Button
                variant="secondary"
                size="sm"
                className="min-w-[5.5rem] justify-center"
                onClick={() => void deleteBatch()}
                disabled={busy || selected.size === 0}
                title={
                  selected.size > 0
                    ? `删除已选 ${selected.size} 个 Auth 文件`
                    : '请先勾选要删除的条目'
                }
              >
                <Trash2
                  className={cn('h-3.5 w-3.5', batchBusy === 'delete' && 'animate-pulse')}
                />
                {batchBusy === 'delete' ? '删除中…' : '删除'}
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
              无邮箱无法按 email 从 SSO 列表回填 sso。建议流程：
              <span className="text-foreground">
                {' '}
                ① 去 SSO 页对对应账号验活（存活时 grok 常返回邮箱并写入列表）→ ②
                回到本页点「回填SSO」→ ③ 仍无邮箱的只能重新 mint 或手补 sso。
              </span>
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {onOpenPool && (
                <Button size="sm" onClick={onOpenPool} title="切换到 SSO 页做验活">
                  <Database className="h-3.5 w-3.5" />
                  去 SSO 验活补邮箱
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
          Auth 目录为空。注册成功自动导出，或在 SSO 页点「补 Auth」。
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
                <th className="w-[5.5rem] px-3 py-2.5 font-medium">标记</th>
                <th className="w-[7rem] max-w-[7rem] px-2 py-2.5 font-medium">
                  授权
                </th>
                <th className="w-[3.25rem] px-3 py-2.5 font-medium">xai</th>
                <th className="w-[4.5rem] px-3 py-2.5 font-medium">bot_flag</th>
                {/* 固定窄列仅放 O/X，避免测活后邻列（标记/sso）横向跳动 */}
                <th className="w-10 whitespace-nowrap px-2 py-2.5 text-center font-medium">
                  测活
                </th>
                <th className="w-12 whitespace-nowrap px-2 py-2.5 text-center font-medium">
                  状态
                </th>
                <th className="px-3 py-2.5 font-medium">过期</th>
                <th className="px-3 py-2.5 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((item) => {
                const probe = probeMap[item.filename];
                const probeAction = probe?.action;
                const probeHttp = probe?.http;
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
                    <td className="w-[5.5rem] min-w-[5.5rem] max-w-[5.5rem] px-3 py-2.5">
                      {/* 固定槽位，避免测活结果出现后「无sso」胶囊左右跳 */}
                      <div className="flex h-5 w-[4.75rem] items-center gap-1 overflow-hidden">
                        {rowNoEmail && (
                          <span
                            className="shrink-0 rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-medium text-orange-600 dark:text-orange-400"
                            title="无邮箱：无法靠 SSO 列表 email 回填 sso，请重新 mint 或手工写入"
                          >
                            无邮箱
                          </span>
                        )}
                        {rowNoSso && (
                          <span
                            className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                            title="无 sso 字段：可筛选后点「回填SSO」（需有邮箱）"
                          >
                            无sso
                          </span>
                        )}
                        {/* SSO 转换 / 已含 sso：绿色 sso 标记 */}
                        {!rowNoSso && (
                          <span
                            className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                            title="已含 sso（SSO→Auth 转换或已回填）"
                          >
                            sso
                          </span>
                        )}
                      </div>
                    </td>
                    <td
                      className="w-[7rem] max-w-[7rem] truncate px-2 py-2.5 font-mono text-[11px] text-muted-foreground"
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
                    <td className="w-[4.5rem] min-w-[4.5rem] px-3 py-2.5">
                      <BotFlagBadge
                        flag={item.botFlagSource}
                        is1={item.isBotFlag1}
                        missing="dash"
                      />
                    </td>
                    <td className="w-10 min-w-10 max-w-10 whitespace-nowrap px-2 py-2.5 text-center">
                      {/* 仅固定 O/X 槽，按钮移至操作列，杜绝邻列位移 */}
                      <span className="inline-flex h-5 w-5 items-center justify-center">
                        <ProbeBadge action={probeAction} />
                      </span>
                    </td>
                    <td className="w-12 min-w-12 max-w-12 whitespace-nowrap px-2 py-2.5 text-center">
                      <ProbeHttpBadge http={probeHttp} action={probeAction} />
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

/** 测活结果：仅 O / X，固定 20×20，无「活/死」文字；X 红色 */
function ProbeBadge({ action }: { action?: string }) {
  const shell =
    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold leading-none tabular-nums';
  if (!action) {
    return (
      <span className={cn(shell, 'text-muted-foreground')} title="未测活">
        —
      </span>
    );
  }
  if (action === 'ok') {
    return (
      <span
        className={cn(
          shell,
          'animate-probe-flash bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
        )}
        title="测活通过"
        aria-label="OK"
      >
        O
      </span>
    );
  }
  if (action === 'dead') {
    return (
      <span
        className={cn(
          shell,
          'animate-probe-flash bg-red-600 text-white dark:bg-red-500 dark:text-white'
        )}
        title="死号"
        aria-label="死号"
      >
        X
      </span>
    );
  }
  // keep / error 等：仍只显示单字符，不出现「活/死」文案
  if (action === 'keep') {
    return (
      <span
        className={cn(shell, 'bg-amber-500/15 text-amber-700 dark:text-amber-400')}
        title="存疑（非死号）"
      >
        ?
      </span>
    );
  }
  return (
    <span className={cn(shell, 'bg-muted text-muted-foreground')} title={action}>
      ?
    </span>
  );
}

/** 测活 HTTP 状态码：200 / 401 / 403 / 429 等 */
function ProbeHttpBadge({
  http,
  action
}: {
  http?: number;
  action?: string;
}) {
  if (!http && !action) {
    return (
      <span className="text-[11px] tabular-nums text-muted-foreground" title="未测活">
        —
      </span>
    );
  }
  if (!http) {
    return (
      <span className="text-[11px] tabular-nums text-muted-foreground" title="无 HTTP 状态">
        —
      </span>
    );
  }
  const code = String(http);
  const tone =
    http >= 200 && http < 300
      ? 'text-emerald-600 dark:text-emerald-400'
      : http === 429
        ? 'text-amber-600 dark:text-amber-400'
        : http === 401 || http === 403 || http === 402
          ? 'text-red-600 dark:text-red-400'
          : http >= 400
            ? 'text-red-600/90 dark:text-red-400'
            : 'text-muted-foreground';
  return (
    <span
      className={cn('text-[11px] font-semibold tabular-nums', tone)}
      title={`HTTP ${code}${action ? ` · ${action}` : ''}`}
    >
      {code}
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
