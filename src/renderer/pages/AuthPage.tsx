import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Ban,
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
  RefreshCw,
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
import type { ReloginStage } from '@shared/runEvents';
import { cn } from '@renderer/lib/cn';
import { setWebApiAbortSignal } from '@renderer/lib/webApi';
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

/** 重登阶段 → 中文标签 */
function reloginStageLabel(stage?: ReloginStage | string): string {
  switch (stage) {
    case 'queued':
      return '排队';
    case 'checking':
      return '校验';
    case 'login':
      return '登录中';
    case 'mint':
      return 'mint';
    case 'activate':
      return '激活';
    case 'probe':
      return '测活';
    case 'done':
      return '完成';
    case 'error':
      return '失败';
    default:
      return stage ? String(stage) : '';
  }
}

type TaskProgress = {
  kind:
    | 'probe'
    | 'resign'
    | 'refresh401'
    | 'delete'
    | 'export'
    | 'push'
    | 'backfill'
    | 'relogin';
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
  /** 重登 WebSocket 阶段 */
  stage?: ReloginStage | string;
  stageMsg?: string;
  /** 批量 mode 统计摘要 */
  modeSummary?: string;
};

const RESIGN_PUSH_KEY = 'gra-resign-push-remote';
const PAGE_SIZE_KEY = 'gra-auth-page-size';
const META_FILTER_KEY = 'gra-auth-meta-filter';
const STATUS_FILTER_KEY = 'gra-auth-status-filter';

/** 行内标记筛选：全部 / 无sso / 无邮箱 / 待补全 */
type MetaFilter = 'all' | 'no_sso' | 'no_email' | 'need_fill';

/** 状态列（HTTP）筛选：全部 / 未测 / 200 / 401 / 403 / 其它错误 */
type StatusFilter = 'all' | 'unprobed' | '200' | '401' | '403' | 'other_err';

function loadMetaFilter(): MetaFilter {
  try {
    const v = localStorage.getItem(META_FILTER_KEY);
    if (v === 'no_sso' || v === 'no_email' || v === 'need_fill' || v === 'all') return v;
  } catch {
    /* ignore */
  }
  return 'all';
}

function loadStatusFilter(): StatusFilter {
  try {
    const v = localStorage.getItem(STATUS_FILTER_KEY);
    if (
      v === 'all' ||
      v === 'unprobed' ||
      v === '200' ||
      v === '401' ||
      v === '403' ||
      v === 'other_err'
    ) {
      return v;
    }
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
    | 'resign'
    | 'refresh401'
    | 'probe'
    | 'relogin'
    | 'delete'
    | 'export'
    | 'push'
    | 'backfill'
    | null
  >(null);
  /** 当前批量任务 AbortController：各按钮独立取消对应 kind */
  const batchAbortRef = useRef<AbortController | null>(null);
  const batchKindRef = useRef<
    | 'resign'
    | 'refresh401'
    | 'probe'
    | 'relogin'
    | 'delete'
    | 'export'
    | 'push'
    | 'backfill'
    | null
  >(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  type BatchKind =
    | 'resign'
    | 'refresh401'
    | 'probe'
    | 'relogin'
    | 'delete'
    | 'export'
    | 'push'
    | 'backfill';

  const isAbortError = (err: unknown) => {
    if (!err) return false;
    if (
      typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      err.name === 'AbortError'
    ) {
      return true;
    }
    const name = (err as { name?: string })?.name;
    const msg = String((err as { message?: string })?.message || err || '');
    return name === 'AbortError' || /aborted|AbortError|The user aborted/i.test(msg);
  };

  const beginBatch = (kind: BatchKind): AbortSignal => {
    try {
      batchAbortRef.current?.abort();
    } catch {
      /* ignore */
    }
    const ac = new AbortController();
    batchAbortRef.current = ac;
    batchKindRef.current = kind;
    setWebApiAbortSignal(ac.signal);
    setBatchBusy(kind);
    return ac.signal;
  };

  const endBatch = (kind?: BatchKind) => {
    if (kind && batchKindRef.current && batchKindRef.current !== kind) {
      return;
    }
    setWebApiAbortSignal(null);
    batchAbortRef.current = null;
    batchKindRef.current = null;
    setBatchBusy(null);
  };

  const cancelBatch = (kind: BatchKind) => {
    if (batchKindRef.current !== kind) return;
    try {
      batchAbortRef.current?.abort();
    } catch {
      /* ignore */
    }
    push({
      tone: 'warn',
      title: '已请求取消',
      description: `正在停止「${kind}」批量任务（当前请求结束后不再继续）`
    });
  };

  const throwIfAborted = (signal: AbortSignal) => {
    if (signal.aborted) {
      throw new DOMException('批量任务已取消', 'AbortError');
    }
  };

  /** 最近一次测活结果：filename → action + http 状态码 */
  const [probeMap, setProbeMap] = useState<
    Record<string, { action: string; http?: number }>
  >({});
  /**
   * 批量/单条重登：按 filename 记录 stage，列表行各自显示「登录中/mint/激活」。
   * 结束一段时间后清理，避免长期占位。
   */
  const [reloginStageMap, setReloginStageMap] = useState<
    Record<string, { stage: ReloginStage | string; message?: string; ts: number }>
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
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => loadStatusFilter());

  /** 写入单行重登 stage（列表 + 进度条共用） */
  const setRowReloginStage = useCallback(
    (
      filename: string,
      stage: ReloginStage | string,
      message?: string
    ) => {
      if (!filename) return;
      setReloginStageMap((m) => ({
        ...m,
        [filename]: { stage, message, ts: Date.now() }
      }));
    },
    []
  );

  /** 订阅 WebSocket relogin_progress → 进度条 + 行内 stage */
  useEffect(() => {
    return window.api.onRegisterEvent((ev) => {
      if (ev.type !== 'relogin_progress') return;
      const fn = String(ev.filename || '').trim();
      if (fn) {
        setReloginStageMap((m) => ({
          ...m,
          [fn]: {
            stage: ev.stage,
            message: ev.message,
            ts: ev.ts || Date.now()
          }
        }));
      }
      setProg((p) => {
        if (!p || p.kind !== 'relogin') {
          return {
            kind: 'relogin',
            total: 1,
            done: 0,
            ok: 0,
            failed: 0,
            running: ev.stage !== 'done' && ev.stage !== 'error',
            current: ev.email || ev.filename,
            stage: ev.stage,
            stageMsg: ev.message
          };
        }
        return {
          ...p,
          current: ev.email || ev.filename || p.current,
          stage: ev.stage,
          stageMsg: ev.message,
          running: ev.stage !== 'done' && ev.stage !== 'error' ? true : p.running
        };
      });
    });
  }, []);

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

  const reload = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const r = await window.api.listCpaAuth();
      setDir(r.dir);
      setItems(r.items);
      // 从落盘字段恢复测活/状态列（刷新后仍显示上次结果）
      setProbeMap((prev) => {
        const next = { ...prev };
        for (const it of r.items) {
          const act = String(it.probeAction || '').trim();
          if (!act) continue;
          const http = Number(it.probeHttp || 0) || undefined;
          next[it.filename] = { action: act, http };
        }
        return next;
      });
      setSelected((prev) => {
        const names = new Set(r.items.map((i) => i.filename));
        return new Set([...prev].filter((n) => names.has(n)));
      });
    } catch (err) {
      if (!opts?.silent) {
        push({
          tone: 'danger',
          title: '加载 Auth 失败',
          description: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, [push]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 页面可见时轻量轮询：注册/mint 写出新文件后自动刷新（隐藏标签页暂停；批量操作时跳过）
  useEffect(() => {
    let timer: number | null = null;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      if (batchBusy || rowBusy) return;
      void reload({ silent: true });
    };
    const start = () => {
      if (timer != null) window.clearInterval(timer);
      timer = window.setInterval(tick, 12000);
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        tick();
        start();
      } else if (timer != null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (timer != null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [reload, batchBusy, rowBusy]);

  const hasEmail = (i: CpaAuthItem) => Boolean(String(i.email || '').trim());
  const hasSso = (i: CpaAuthItem) => Boolean(i.hasSso);

  /** 行状态：优先内存 probeMap，其次落盘 probeHttp / probeAction */
  const resolveProbe = useCallback(
    (i: CpaAuthItem): { action?: string; http?: number } => {
      const mem = probeMap[i.filename];
      const action = mem?.action || i.probeAction || undefined;
      const http =
        mem?.http ??
        (i.probeHttp != null && Number(i.probeHttp) > 0 ? Number(i.probeHttp) : undefined);
      return { action, http };
    },
    [probeMap]
  );

  const matchStatusFilter = useCallback(
    (i: CpaAuthItem, f: StatusFilter): boolean => {
      if (f === 'all') return true;
      const { action, http } = resolveProbe(i);
      const hasProbe = Boolean(action) || (http != null && http > 0);
      if (f === 'unprobed') return !hasProbe;
      if (f === '200') return http === 200 || (action === 'ok' && (http == null || http === 200));
      if (f === '401') return http === 401;
      if (f === '403') return http === 403;
      // other_err：有测活结果且非 200/401/403（含 dead 无码、4xx/5xx）
      if (f === 'other_err') {
        if (!hasProbe) return false;
        if (http === 200 || http === 401 || http === 403) return false;
        if (action === 'ok' && (http == null || http === 200)) return false;
        return true;
      }
      return true;
    },
    [resolveProbe]
  );

  const filteredItems = useMemo(() => {
    let list = items;
    if (metaFilter === 'no_sso') list = list.filter((i) => !hasSso(i));
    else if (metaFilter === 'no_email') list = list.filter((i) => !hasEmail(i));
    else if (metaFilter === 'need_fill')
      list = list.filter((i) => !hasSso(i) || !hasEmail(i));
    if (statusFilter !== 'all') {
      list = list.filter((i) => matchStatusFilter(i, statusFilter));
    }
    return list;
  }, [items, metaFilter, statusFilter, matchStatusFilter]);

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

  const changeStatusFilter = (f: StatusFilter) => {
    setStatusFilter(f);
    resetPage();
    try {
      localStorage.setItem(STATUS_FILTER_KEY, f);
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
        else await reload({ silent: true });
      } else if (one?.ok || one?.probeAction === 'ok') {
        push({
          tone: 'ok',
          title: recoveredAuth
            ? `测活 OK（${recoverLabel} 已重登恢复）`
            : '测活 OK',
          description: item.email || item.filename
        });
        await reload({ silent: true });
      } else {
        push({
          tone: 'warn',
          title: '测活异常',
          description: String(one?.error || one?.probeAction || 'unknown')
        });
        await reload({ silent: true });
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

  /** 重登：密码登录 → mint → 随机英文消息激活 → 结果写回测活/状态 */
  const reloginOne = async (item: CpaAuthItem) => {
    if (!String(item.email || '').trim()) {
      push({
        tone: 'warn',
        title: '无法重登',
        description: '该 Auth 无邮箱，无法从号池取密码'
      });
      return;
    }
    // 前置：号池无密码则不调接口、不开浏览器
    if (item.poolHasPassword === false) {
      push({
        tone: 'warn',
        title: '号池无密码',
        description: `${item.email || item.filename} 在号池中无密码，请先补全后再重登`
      });
      return;
    }
    setRowBusy(`relogin:${item.filename}`);
    setRowReloginStage(item.filename, 'checking', '校验号池密码…');
    setProg({
      kind: 'relogin',
      total: 1,
      done: 0,
      ok: 0,
      failed: 0,
      running: true,
      current: item.email || item.filename,
      stage: 'checking',
      stageMsg: '校验号池密码…'
    });
    try {
      const r = await window.api.reloginCpaAuth({ filename: item.filename });
      const action = String(r.probeAction || (r.ok ? 'ok' : 'error'));
      const http = Number(r.probeHttp || 0) || undefined;
      setProbeMap((m) => ({
        ...m,
        [item.filename]: { action, http }
      }));
      const success = Boolean(r.ok) || action === 'ok';
      setRowReloginStage(
        item.filename,
        success ? 'done' : 'error',
        success ? `完成 · HTTP ${http ?? '—'}` : String(r.error || action)
      );
      setProg((p) => ({
        kind: 'relogin',
        total: 1,
        done: 1,
        ok: success ? 1 : 0,
        failed: success ? 0 : 1,
        running: false,
        current: item.email || item.filename,
        stage: success ? 'done' : 'error',
        stageMsg: success
          ? `完成 · HTTP ${http ?? '—'}`
          : String(r.error || action || p?.stageMsg || '失败')
      }));
      if (success) {
        push({
          tone: 'ok',
          title: '重登激活成功',
          description: `${item.email || item.filename}${http ? ` · HTTP ${http}` : ''}`
        });
      } else {
        push({
          tone: 'warn',
          title: '重登完成但测活未通过',
          description:
            String(r.error || action || 'unknown') + (http ? ` · HTTP ${http}` : '')
        });
      }
      await reload({ silent: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRowReloginStage(item.filename, 'error', msg);
      push({
        tone: 'danger',
        title: '重登失败',
        description: /HTTP 404/i.test(msg)
          ? '接口 /api/cpa-auth/relogin 不存在：请重新构建并重启 server（npm run server:build）'
          : msg
      });
      setProg((p) =>
        p
          ? { ...p, running: false, failed: 1, done: 1, stage: 'error', stageMsg: msg }
          : p
      );
    } finally {
      setRowBusy(null);
      window.setTimeout(() => {
        setProg(null);
        setReloginStageMap((m) => {
          const next = { ...m };
          delete next[item.filename];
          return next;
        });
      }, 4000);
    }
  };

  /**
   * 批量重登：串行 concurrency=1（浏览器密码登录较重，禁止并行）。
   * 范围同其它批量：已选 > 筛选 > 全部；跳过无邮箱。
   */
  const reloginBatch = async () => {
    const filenames = targetNames();
    if (filenames.length === 0) {
      push({ tone: 'warn', title: '没有可重登的文件' });
      return;
    }
    const byName = new Map(items.map((it) => [it.filename, it]));
    // 前置：有邮箱 + 号池有密码；无密码跳过，不开浏览器
    const withEmail = filenames.filter((fn) => {
      const it = byName.get(fn);
      return Boolean(it && String(it.email || '').trim());
    });
    const targets = withEmail.filter((fn) => {
      const it = byName.get(fn);
      // poolHasPassword === undefined 时仍尝试（旧缓存），false 才跳过
      return it?.poolHasPassword !== false;
    });
    const skippedNoEmail = filenames.length - withEmail.length;
    const skippedNoPw = withEmail.length - targets.length;
    if (targets.length === 0) {
      push({
        tone: 'warn',
        title: '没有可重登的文件',
        description:
          skippedNoPw > 0
            ? `号池均无密码 ${skippedNoPw} 条（已跳过，未开浏览器）` +
              (skippedNoEmail > 0 ? `；无邮箱 ${skippedNoEmail}` : '')
            : '选中项均无邮箱，无法从号池取密码'
      });
      return;
    }
    if (
      !window.confirm(
        `将串行重登 ${targets.length} 条（并发 1，浏览器登录较慢）` +
          (skippedNoEmail > 0 ? `\n跳过无邮箱 ${skippedNoEmail} 条` : '') +
          (skippedNoPw > 0 ? `\n跳过号池无密码 ${skippedNoPw} 条` : '') +
          `\n\n每条：密码登录 → mint → 随机英文消息 → 二次测活。\n确定继续？`
      )
    ) {
      return;
    }
    const signal = beginBatch('relogin');
    // 预填排队状态：列表每行可见各自 stage
    setReloginStageMap((m) => {
      const next = { ...m };
      for (const fn of targets) {
        next[fn] = { stage: 'queued', message: '排队中…', ts: Date.now() };
      }
      return next;
    });
    setProg({
      kind: 'relogin',
      total: targets.length,
      done: 0,
      ok: 0,
      failed: 0,
      running: true,
      current: byName.get(targets[0])?.email || targets[0],
      stage: 'queued',
      stageMsg: '排队中…'
    });
    let ok = 0;
    let failed = 0;
    let cancelled = false;
    try {
      for (let i = 0; i < targets.length; i++) {
        throwIfAborted(signal);
        const fn = targets[i];
        const it = byName.get(fn);
        setRowReloginStage(fn, 'checking', '校验…');
        setProg((p) =>
          p
            ? {
                ...p,
                current: it?.email || fn,
                running: true,
                done: i,
                ok,
                failed,
                stage: 'checking',
                stageMsg: '校验…'
              }
            : p
        );
        try {
          const r = await window.api.reloginCpaAuth({ filename: fn });
          const action = String(r.probeAction || (r.ok ? 'ok' : 'error'));
          const http = Number(r.probeHttp || 0) || undefined;
          const success = Boolean(r.ok) || action === 'ok';
          if (success) ok += 1;
          else failed += 1;
          setProbeMap((m) => ({
            ...m,
            [fn]: { action, http }
          }));
          setRowReloginStage(
            fn,
            success ? 'done' : 'error',
            success ? `完成 · HTTP ${http ?? '—'}` : String(r.error || action)
          );
        } catch (err) {
          if (isAbortError(err) || signal.aborted) {
            cancelled = true;
            setRowReloginStage(fn, 'error', '已取消');
            break;
          }
          failed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          setProbeMap((m) => ({
            ...m,
            [fn]: { action: 'error' }
          }));
          setRowReloginStage(fn, 'error', msg);
        }
        if (signal.aborted) {
          cancelled = true;
          // 剩余排队项标记取消
          for (let j = i + 1; j < targets.length; j++) {
            setRowReloginStage(targets[j], 'error', '已取消');
          }
          break;
        }
        setProg((p) => ({
          kind: 'relogin',
          total: targets.length,
          done: i + 1,
          ok,
          failed,
          running: i + 1 < targets.length,
          current: it?.email || fn,
          stage: p?.stage,
          stageMsg: p?.stageMsg
        }));
      }
      if (cancelled || signal.aborted) {
        push({
          tone: 'warn',
          title: '批量重登已取消',
          description: `已完成 ${ok + failed}/${targets.length} · 成功 ${ok} · 失败 ${failed}`
        });
      } else {
        push({
          tone: failed > 0 ? 'warn' : 'ok',
          title: '批量重登完成',
          description:
            `成功 ${ok} · 失败 ${failed}` +
            (skippedNoEmail > 0 ? ` · 跳过无邮箱 ${skippedNoEmail}` : '') +
            ' · 并发 1'
        });
      }
      await reload({ silent: true });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        push({
          tone: 'warn',
          title: '批量重登已取消',
          description: `已完成 ${ok + failed}/${targets.length}`
        });
      } else {
        push({
          tone: 'danger',
          title: '批量重登失败',
          description: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      endBatch('relogin');
      window.setTimeout(() => {
        setProg(null);
        setReloginStageMap({});
      }, 4500);
    }
  };

  /** 批量并发：设置 cpaResignConcurrency，硬顶 3 */
  const resignConcurrency = Math.min(
    3,
    Math.max(1, Number(settings?.cpaResignConcurrency) || 2)
  );

  const summarizeModes = (
    results: { mode?: string; ok?: boolean }[]
  ): string => {
    const counts: Record<string, number> = {};
    for (const x of results) {
      const m = x.mode || (x.ok ? 'ok' : 'error');
      counts[m] = (counts[m] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
  };

  const resignBatch = async () => {
    const filenames = targetNames();
    if (filenames.length === 0) {
      push({ tone: 'warn', title: '没有可重签的文件' });
      return;
    }
    const signal = beginBatch('resign');
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
      // 分块：块大小贴近并发，避免一次打爆限流
      const CHUNK = Math.max(resignConcurrency * 2, 4);
      let ok = 0;
      let failed = 0;
      let noXai = 0;
      let remoteOkN = 0;
      let remoteFailedN = 0;
      let cancelled = false;
      const modeParts: string[] = [];
      for (let i = 0; i < filenames.length; i += CHUNK) {
        throwIfAborted(signal);
        const chunk = filenames.slice(i, i + CHUNK);
        setProg((p) =>
          p
            ? { ...p, current: chunk[0], running: true }
            : p
        );
        try {
          const r = await window.api.resignCpaAuthBatch({
            filenames: chunk,
            concurrency: resignConcurrency,
            pushRemote: resignPushRemote
          });
          ok += r.ok || 0;
          failed += r.failed || 0;
          noXai += r.results.filter((x) => x.ok && x.xai === false).length;
          remoteOkN += r.remoteOk ?? r.results.filter((x) => x.remoteOk === true).length;
          remoteFailedN +=
            r.remoteFailed ?? r.results.filter((x) => x.remoteOk === false).length;
          const ms = summarizeModes(r.results || []);
          if (ms) modeParts.push(ms);
        } catch (err) {
          if (isAbortError(err) || signal.aborted) {
            cancelled = true;
            break;
          }
          throw err;
        }
        if (signal.aborted) {
          cancelled = true;
          break;
        }
        setProg({
          kind: 'resign',
          total: filenames.length,
          done: Math.min(i + chunk.length, filenames.length),
          ok,
          failed,
          remoteOk: remoteOkN,
          remoteFailed: remoteFailedN,
          running: i + chunk.length < filenames.length,
          current: chunk[chunk.length - 1],
          modeSummary: modeParts.join(' · ')
        });
      }
      if (cancelled || signal.aborted) {
        push({
          tone: 'warn',
          title: '批量重签已取消',
          description: `已处理约 ${ok + failed}/${filenames.length} · 成功 ${ok} · 失败 ${failed}`
        });
      } else {
        const remotePart = resignPushRemote
          ? ` · 远程OK ${remoteOkN}${remoteFailedN ? ` · 远程失败 ${remoteFailedN}` : ''}`
          : '';
        const modePart = modeParts.length ? ` · ${modeParts.join(' ')}` : '';
        push({
          tone: failed > 0 || remoteFailedN > 0 ? 'warn' : 'ok',
          title: '批量重签完成',
          description: `成功 ${ok} · 失败 ${failed}${noXai ? ` · 无 xai ${noXai}` : ''}${remotePart}${modePart}`
        });
      }
      await reload();
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        push({ tone: 'warn', title: '批量重签已取消' });
      } else {
        push({
          tone: 'danger',
          title: '批量重签失败',
          description: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      endBatch('resign');
      window.setTimeout(() => setProg(null), 3000);
    }
  };

  /**
   * A1 刷新401：仅 HTTP 401（有 refresh 或 sso）走 resign，不含密码重登。
   * 范围：已选 > 状态筛 401 > 当前筛选中的 401。
   */
  const refresh401Batch = async () => {
    const byName = new Map(items.map((it) => [it.filename, it]));
    const pool =
      selected.size > 0
        ? [...selected]
        : statusFilter === '401'
          ? filteredItems.map((i) => i.filename)
          : items
              .filter((i) => {
                const { http, action } = resolveProbe(i);
                return http === 401 || action === 'dead';
              })
              .map((i) => i.filename);

    const targets = pool.filter((fn) => {
      const it = byName.get(fn);
      if (!it) return false;
      const { http } = resolveProbe(it);
      // 明确 401；若选中但未测活且有 refresh/sso 也允许尝试
      if (http === 401) return true;
      if (selected.size > 0 && (it.hasRefresh || it.hasSso)) return true;
      return false;
    });

    if (targets.length === 0) {
      push({
        tone: 'warn',
        title: '没有可刷新的 401',
        description:
          '请先测活筛出 401，或勾选含 refresh/sso 的项。403 请用「重登」'
      });
      return;
    }
    if (
      !window.confirm(
        `将刷新 ${targets.length} 条 401（并发 ${resignConcurrency}，走代理若已开）\n\n` +
          `路径：mode=refresh → 失败则 mode=sso（不含密码重登）。\n确定继续？`
      )
    ) {
      return;
    }

    const signal = beginBatch('refresh401');
    setProg({
      kind: 'refresh401',
      total: targets.length,
      done: 0,
      ok: 0,
      failed: 0,
      running: true,
      current: targets[0]
    });
    try {
      const CHUNK = Math.max(resignConcurrency * 2, 4);
      let ok = 0;
      let failed = 0;
      let cancelled = false;
      const modeParts: string[] = [];
      for (let i = 0; i < targets.length; i += CHUNK) {
        throwIfAborted(signal);
        const chunk = targets.slice(i, i + CHUNK);
        setProg((p) => (p ? { ...p, current: chunk[0], running: true } : p));
        try {
          const r = await window.api.resignCpaAuthBatch({
            filenames: chunk,
            concurrency: resignConcurrency,
            pushRemote: false
          });
          ok += r.ok || 0;
          failed += r.failed || 0;
          for (const x of r.results || []) {
            if (x.filename) {
              setProbeMap((m) => ({
                ...m,
                [x.filename!]: {
                  action: x.probeAction || (x.ok ? 'ok' : 'error'),
                  http: x.probeHttp
                }
              }));
            }
          }
          const ms = summarizeModes(r.results || []);
          if (ms) modeParts.push(ms);
        } catch (err) {
          if (isAbortError(err) || signal.aborted) {
            cancelled = true;
            break;
          }
          throw err;
        }
        if (signal.aborted) {
          cancelled = true;
          break;
        }
        setProg({
          kind: 'refresh401',
          total: targets.length,
          done: Math.min(i + CHUNK, targets.length),
          ok,
          failed,
          running: i + CHUNK < targets.length,
          current: chunk[chunk.length - 1],
          modeSummary: modeParts.join(' · ')
        });
      }
      if (cancelled || signal.aborted) {
        push({
          tone: 'warn',
          title: '刷新401 已取消',
          description: `成功 ${ok} · 失败 ${failed}`
        });
      } else {
        push({
          tone: failed > 0 ? 'warn' : 'ok',
          title: '刷新401 完成',
          description: `成功 ${ok} · 失败 ${failed}${
            modeParts.length ? ` · ${modeParts.join(' ')}` : ''
          }`
        });
      }
      await reload();
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        push({ tone: 'warn', title: '刷新401 已取消' });
      } else {
        push({
          tone: 'danger',
          title: '刷新401 失败',
          description: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      endBatch('refresh401');
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
    const signal = beginBatch('push');
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
      let cancelled = false;
      for (let i = 0; i < filenames.length; i += CHUNK) {
        throwIfAborted(signal);
        const chunk = filenames.slice(i, i + CHUNK);
        setProg((p) => (p ? { ...p, current: chunk[0], running: true } : p));
        try {
          const r = await window.api.pushCpaAuthRemote({
            filenames: chunk,
            concurrency: Math.min(4, chunk.length)
          });
          ok += r.ok || 0;
          failed += r.failed || 0;
          if (r.remoteUrl) remoteUrl = r.remoteUrl;
        } catch (err) {
          if (isAbortError(err) || signal.aborted) {
            cancelled = true;
            break;
          }
          throw err;
        }
        if (signal.aborted) {
          cancelled = true;
          break;
        }
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
      if (cancelled || signal.aborted) {
        push({
          tone: 'warn',
          title: '远程推送已取消',
          description: `已处理 ${ok + failed}/${filenames.length} · 成功 ${ok} · 失败 ${failed}`
        });
      } else {
        push({
          tone: failed > 0 ? 'warn' : 'ok',
          title: '远程推送完成',
          description: `成功 ${ok} · 失败 ${failed}${remoteUrl ? ` · ${remoteUrl}` : ''}`
        });
      }
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        push({ tone: 'warn', title: '远程推送已取消' });
      } else {
        push({
          tone: 'danger',
          title: '远程推送失败',
          description: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      endBatch('push');
      window.setTimeout(() => setProg(null), 3000);
    }
  };

  const probeBatch = async () => {
    const filenames = targetNames();
    if (filenames.length === 0) {
      push({ tone: 'warn', title: '没有可测活的文件' });
      return;
    }
    const signal = beginBatch('probe');
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
      let cancelled = false;
      for (let i = 0; i < filenames.length; i += CHUNK) {
        throwIfAborted(signal);
        const chunk = filenames.slice(i, i + CHUNK);
        setProg((p) => (p ? { ...p, current: chunk[0], running: true } : p));
        try {
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
        } catch (err) {
          if (isAbortError(err) || signal.aborted) {
            cancelled = true;
            break;
          }
          throw err;
        }
        if (signal.aborted) {
          cancelled = true;
          break;
        }
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
      if (cancelled || signal.aborted) {
        push({
          tone: 'warn',
          title: '批量测活已取消',
          description: `OK ${ok} · 死号 ${dead} · 已删 ${deleted}（部分完成）`
        });
      } else {
        push({
          tone: dead > 0 || failed > 0 ? 'warn' : 'ok',
          title: '批量 CPA 测活完成',
          description:
            `OK ${ok} · 死号 ${dead} · 已删 Auth ${deleted}` +
            (ssoDeleted > 0 ? ` · 同步删 SSO ${ssoDeleted}` : '') +
            (deleteOnDead ? '' : ' · 死号不自动删')
        });
      }
      // A2：测活 401 自动重签（refresh→sso，不含密码重登）
      const auto401 = settings?.autoResignOn401 === true && !cancelled && !signal.aborted;
      if (auto401) {
        const byItem = new Map(items.map((it) => [it.filename, it]));
        const needResign = Object.entries(nextProbe)
          .filter(([, v]) => v.http === 401)
          .map(([fn]) => fn)
          .filter((fn) => {
            const it = byItem.get(fn);
            return Boolean(it && (it.hasRefresh || it.hasSso));
          });
        if (needResign.length > 0) {
          push({
            tone: 'info',
            title: '401 自动重签',
            description: `共 ${needResign.length} 条 · 并发 ${resignConcurrency}`
          });
          setProg({
            kind: 'refresh401',
            total: needResign.length,
            done: 0,
            ok: 0,
            failed: 0,
            running: true,
            current: needResign[0]
          });
          // 复用 resign 批量（仍在 probe 的 abort 下可取消）
          const CHUNK = Math.max(resignConcurrency * 2, 4);
          let aOk = 0;
          let aFail = 0;
          const modeParts: string[] = [];
          for (let i = 0; i < needResign.length; i += CHUNK) {
            if (signal.aborted) break;
            const chunk = needResign.slice(i, i + CHUNK);
            try {
              const rr = await window.api.resignCpaAuthBatch({
                filenames: chunk,
                concurrency: resignConcurrency,
                pushRemote: false
              });
              aOk += rr.ok || 0;
              aFail += rr.failed || 0;
              const ms = summarizeModes(rr.results || []);
              if (ms) modeParts.push(ms);
              for (const x of rr.results || []) {
                if (x.filename) {
                  nextProbe[x.filename] = {
                    action: x.probeAction || (x.ok ? 'ok' : 'error'),
                    http: x.probeHttp
                  };
                }
              }
              setProbeMap((m) => ({ ...m, ...nextProbe }));
            } catch (err) {
              if (isAbortError(err) || signal.aborted) break;
              aFail += chunk.length;
            }
            setProg({
              kind: 'refresh401',
              total: needResign.length,
              done: Math.min(i + CHUNK, needResign.length),
              ok: aOk,
              failed: aFail,
              running: i + CHUNK < needResign.length,
              current: chunk[chunk.length - 1],
              modeSummary: modeParts.join(' · ')
            });
          }
          push({
            tone: aFail > 0 ? 'warn' : 'ok',
            title: '401 自动重签完成',
            description: `成功 ${aOk} · 失败 ${aFail}${
              modeParts.length ? ` · ${modeParts.join(' ')}` : ''
            }`
          });
        }
      }
      // 测活结果已落盘，静默刷新以同步 probe 字段
      await reload({ silent: true });
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        push({ tone: 'warn', title: '批量测活已取消' });
      } else {
        push({
          tone: 'danger',
          title: '批量测活失败',
          description: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      endBatch('probe');
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
    const signal = beginBatch('delete');
    setProg({
      kind: 'delete',
      total: filenames.length,
      done: 0,
      ok: 0,
      failed: 0,
      running: true
    });
    try {
      throwIfAborted(signal);
      const r = await window.api.deleteCpaAuth({ filenames });
      if (signal.aborted) {
        push({ tone: 'warn', title: '删除请求已取消' });
        return;
      }
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
      if (isAbortError(err) || signal.aborted) {
        push({ tone: 'warn', title: '删除已取消' });
      } else {
        push({
          tone: 'danger',
          title: '删除失败',
          description: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      endBatch('delete');
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
    const signal = beginBatch('export');
    setProg({
      kind: 'export',
      total: filenames.length,
      done: 0,
      ok: 0,
      failed: 0,
      running: true
    });
    try {
      throwIfAborted(signal);
      const r = await window.api.exportCpaAuth({ filenames });
      if (signal.aborted) {
        push({ tone: 'warn', title: '导出已取消' });
        return;
      }
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
      if (isAbortError(err) || signal.aborted) {
        push({ tone: 'warn', title: '导出已取消' });
      } else {
        push({
          tone: 'danger',
          title: '导出失败',
          description: err instanceof Error ? err.message : String(err)
        });
      }
    } finally {
      endBatch('export');
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
  const statusCounts = useMemo(() => {
    let unprobed = 0;
    let c200 = 0;
    let c401 = 0;
    let c403 = 0;
    let other = 0;
    for (const i of items) {
      const { action, http } = resolveProbe(i);
      const hasProbe = Boolean(action) || (http != null && http > 0);
      if (!hasProbe) {
        unprobed += 1;
        continue;
      }
      if (http === 200 || (action === 'ok' && (http == null || http === 200))) {
        c200 += 1;
      } else if (http === 401) {
        c401 += 1;
      } else if (http === 403) {
        c403 += 1;
      } else {
        other += 1;
      }
    }
    return { unprobed, c200, c401, c403, other };
  }, [items, resolveProbe]);
  const hasActiveMetaFilter = metaFilter !== 'all';
  const hasActiveStatusFilter = statusFilter !== 'all';
  const hasActiveFilter = hasActiveMetaFilter || hasActiveStatusFilter;

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

    const signal = beginBatch('backfill');
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
      throwIfAborted(signal);
      const r = await window.api.backfillCpaAuthSso({
        filenames: targets.map((t) => t.filename),
        force
      });
      if (signal.aborted) {
        push({ tone: 'warn', title: '回填 SSO 已取消' });
        return;
      }
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
      if (isAbortError(err) || signal.aborted) {
        push({ tone: 'warn', title: '回填 SSO 已取消' });
      } else {
        push({
          tone: 'danger',
          title: '回填失败',
          description: err instanceof Error ? err.message : String(err)
        });
      }
      setProg((p) => (p ? { ...p, running: false } : p));
    } finally {
      endBatch('backfill');
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

  /** 批量按钮：运行中变红「取消」，仅取消自身 kind */
  const batchBtnProps = (kind: BatchKind, start: () => void) => {
    const active = batchBusy === kind;
    return {
      variant: (active ? 'danger' : 'secondary') as 'danger' | 'secondary',
      disabled: Boolean(busy && !active),
      onClick: () => {
        if (active) cancelBatch(kind);
        else start();
      },
      title: active ? `取消「${kind}」批量任务` : undefined as string | undefined
    };
  };

  const progTitle =
    prog?.kind === 'probe'
      ? prog.running
        ? 'CPA 测活进行中'
        : 'CPA 测活完成'
      : prog?.kind === 'relogin'
        ? prog.running
          ? '重登激活进行中'
          : '重登激活完成'
        : prog?.kind === 'resign'
        ? prog.running
          ? '批量重签进行中'
          : '批量重签完成'
        : prog?.kind === 'refresh401'
          ? prog.running
            ? '刷新401 进行中'
            : '刷新401 完成'
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
                {prog.kind === 'relogin' && prog.stage
                  ? ` · ${reloginStageLabel(prog.stage)}`
                  : ''}
                {prog.kind === 'relogin' && prog.stageMsg
                  ? ` · ${prog.stageMsg}`
                  : ''}
                {prog.modeSummary ? ` · ${prog.modeSummary}` : ''}
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
            <span className="chip tabular-nums">
              {prog.kind === 'relogin' && prog.stage && prog.running
                ? reloginStageLabel(prog.stage)
                : `${progPct}%`}
            </span>
          </div>
          {prog.kind === 'relogin' && prog.running && (
            <div className="mt-2 flex flex-wrap gap-1">
              {(['checking', 'login', 'mint', 'activate', 'probe'] as const).map((s) => {
                const order = ['checking', 'login', 'mint', 'activate', 'probe', 'done'];
                const cur = order.indexOf(String(prog.stage || ''));
                const idx = order.indexOf(s);
                const active = String(prog.stage) === s;
                const done = cur > idx && cur >= 0;
                return (
                  <span
                    key={s}
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : done
                          ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400'
                          : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {reloginStageLabel(s)}
                  </span>
                );
              })}
            </div>
          )}
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                prog.running
                  ? prog.kind === 'relogin'
                    ? 'bg-amber-500'
                    : 'bg-primary'
                  : prog.failed > 0 && prog.ok === 0
                    ? 'bg-red-500'
                    : 'bg-emerald-500'
              )}
              style={{
                width:
                  prog.kind === 'relogin' && prog.running && prog.total <= 1
                    ? `${Math.min(
                        95,
                        Math.max(
                          8,
                          (['checking', 'login', 'mint', 'activate', 'probe', 'done'].indexOf(
                            String(prog.stage || 'checking')
                          ) +
                            1) *
                            18
                        )
                      )}%`
                    : `${progPct}%`
              }}
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
                {hasActiveFilter
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

          {/* 筛选行：状态（测活 HTTP） */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-0.5 w-8 shrink-0 text-[10px] text-muted-foreground">状态</span>
            {(
              [
                { id: 'all' as const, label: '全部', count: items.length },
                { id: 'unprobed' as const, label: '未测', count: statusCounts.unprobed },
                { id: '200' as const, label: '200', count: statusCounts.c200 },
                { id: '401' as const, label: '401', count: statusCounts.c401 },
                { id: '403' as const, label: '403', count: statusCounts.c403 },
                { id: 'other_err' as const, label: '其它', count: statusCounts.other }
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => changeStatusFilter(tab.id)}
                className={cn(
                  'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                  statusFilter === tab.id
                    ? tab.id === '200'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : tab.id === '401' || tab.id === '403'
                        ? 'bg-red-600 text-white shadow-sm'
                        : tab.id === 'other_err'
                          ? 'bg-amber-600 text-white shadow-sm'
                          : tab.id === 'unprobed'
                            ? 'bg-slate-600 text-white shadow-sm'
                            : 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
                title={
                  tab.id === 'unprobed'
                    ? '尚未测活（无状态码）'
                    : tab.id === '200'
                      ? 'HTTP 200 / 测活通过'
                      : tab.id === '401'
                        ? 'HTTP 401 未授权'
                        : tab.id === '403'
                          ? 'HTTP 403 禁止（可重登）'
                          : tab.id === 'other_err'
                            ? '其它错误码或失败（非 200/401/403）'
                            : '不限制状态'
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
                {...batchBtnProps('probe', () => void probeBatch())}
                variant={batchBusy === 'probe' ? 'danger' : 'primary'}
                disabled={
                  (Boolean(busy) && batchBusy !== 'probe') ||
                  (batchBusy !== 'probe' && filteredItems.length === 0)
                }
                title={
                  batchBusy === 'probe'
                    ? '取消测活批量任务'
                    : (selected.size > 0
                        ? `测活已选 ${selected.size} 条`
                        : hasActiveFilter
                          ? `测活筛选 ${filteredItems.length} 条`
                          : '测活全部') +
                      (deleteOnDead ? ' · 401/402/403 将删除' : ' · 死号仅标记不删')
                }
              >
                {batchBusy === 'probe' ? (
                  <Ban className="h-3.5 w-3.5" />
                ) : (
                  <Activity className="h-3.5 w-3.5" />
                )}
                {batchBusy === 'probe' ? '取消' : '测活'}
              </Button>
              <Button
                size="sm"
                className="min-w-[5.75rem] justify-center tabular-nums"
                {...batchBtnProps('relogin', () => void reloginBatch())}
                disabled={
                  (Boolean(busy) && batchBusy !== 'relogin') ||
                  (batchBusy !== 'relogin' && filteredItems.length === 0)
                }
                title={
                  batchBusy === 'relogin'
                    ? '取消重登批量任务'
                    : (selected.size > 0
                        ? `重登已选 ${selected.size} 条`
                        : hasActiveFilter
                          ? `重登筛选 ${filteredItems.length} 条`
                          : '批量重登') + ' · 串行并发 1（浏览器登录）'
                }
              >
                {batchBusy === 'relogin' ? (
                  <Ban className="h-3.5 w-3.5" />
                ) : (
                  <KeyRound className="h-3.5 w-3.5" />
                )}
                {batchBusy === 'relogin' ? '取消' : '重登'}
              </Button>
              <Button
                size="sm"
                className="min-w-[5.75rem] justify-center tabular-nums"
                {...batchBtnProps('resign', () => void resignBatch())}
                disabled={
                  (Boolean(busy) && batchBusy !== 'resign') ||
                  (batchBusy !== 'resign' && filteredItems.length === 0)
                }
                title={
                  batchBusy === 'resign'
                    ? '取消重签批量任务'
                    : (selected.size > 0
                        ? `重签已选 ${selected.size} 条`
                        : hasActiveFilter
                          ? `重签筛选 ${filteredItems.length} 条`
                          : '批量重签') +
                      (resignPushRemote ? ' · 成功后推远程' : ' · 仅本地')
                }
              >
                {batchBusy === 'resign' ? (
                  <Ban className="h-3.5 w-3.5" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                {batchBusy === 'resign' ? '取消' : '重签'}
              </Button>
              <Button
                size="sm"
                className="min-w-[5.75rem] justify-center tabular-nums"
                {...batchBtnProps('refresh401', () => void refresh401Batch())}
                disabled={
                  (Boolean(busy) && batchBusy !== 'refresh401') ||
                  (batchBusy !== 'refresh401' && items.length === 0)
                }
                title={
                  batchBusy === 'refresh401'
                    ? '取消刷新401'
                    : selected.size > 0
                      ? `刷新已选中的 401（并发 ${resignConcurrency}）`
                      : statusFilter === '401'
                        ? `刷新筛选 401 · ${filteredItems.length} 条`
                        : `刷新全部 401（mode=refresh|sso · 并发 ${resignConcurrency}）`
                }
              >
                {batchBusy === 'refresh401' ? (
                  <Ban className="h-3.5 w-3.5" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {batchBusy === 'refresh401' ? '取消' : '刷新401'}
              </Button>
              <Button
                size="sm"
                className="min-w-[5.75rem] justify-center tabular-nums"
                {...batchBtnProps('push', () => void pushRemoteBatch())}
                disabled={
                  (Boolean(busy) && batchBusy !== 'push') ||
                  (batchBusy !== 'push' && filteredItems.length === 0)
                }
                title={
                  batchBusy === 'push'
                    ? '取消推送批量任务'
                    : remoteReady
                      ? selected.size > 0
                        ? `推送已选 ${selected.size} 条`
                        : hasActiveFilter
                          ? `推送筛选 ${filteredItems.length} 条`
                          : '推送远程'
                      : '请先在设置中配置远程 CPA 地址与密钥'
                }
              >
                {batchBusy === 'push' ? (
                  <Ban className="h-3.5 w-3.5" />
                ) : (
                  <CloudUpload className="h-3.5 w-3.5" />
                )}
                {batchBusy === 'push' ? '取消' : '推送'}
              </Button>
              <Button
                variant={batchBusy === 'backfill' ? 'danger' : 'secondary'}
                size="sm"
                className="min-w-[6.25rem] justify-center"
                disabled={
                  (Boolean(busy) && batchBusy !== 'backfill') ||
                  (batchBusy !== 'backfill' && items.length === 0)
                }
                onClick={() => {
                  if (batchBusy === 'backfill') cancelBatch('backfill');
                }}
                onPointerDown={(e) => {
                  if (batchBusy === 'backfill') return;
                  if (e.button !== 0) return;
                  onBackfillPointerDown();
                }}
                onPointerUp={(e) => {
                  if (batchBusy === 'backfill') return;
                  if (e.button !== 0) return;
                  onBackfillPointerUp();
                }}
                onPointerLeave={onBackfillPointerLeave}
                onPointerCancel={onBackfillPointerLeave}
                onContextMenu={(e) => e.preventDefault()}
                title={
                  batchBusy === 'backfill'
                    ? '取消回填 SSO'
                    : '单击：仅回填无 sso 的文件（已有跳过）\n' +
                      '长按约 0.6s：强制覆盖已有 sso（二次确认）\n' +
                      (selected.size > 0
                        ? `当前范围：已选 ${selected.size} 条\n`
                        : missingSsoCount > 0
                          ? `当前无 sso：${missingSsoCount} 条\n`
                          : '') +
                      '无邮箱 auth 无法靠 email 回填，需重新 mint 或手工补 sso'
                }
              >
                {batchBusy === 'backfill' ? (
                  <Ban className="h-3.5 w-3.5" />
                ) : (
                  <Link2 className="h-3.5 w-3.5" />
                )}
                {batchBusy === 'backfill' ? '取消' : '回填SSO'}
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
                variant={batchBusy === 'export' ? 'danger' : 'secondary'}
                size="sm"
                className="min-w-[5.75rem] justify-center"
                onClick={() => {
                  if (batchBusy === 'export') cancelBatch('export');
                  else void exportBatch();
                }}
                disabled={
                  (Boolean(busy) && batchBusy !== 'export') ||
                  (batchBusy !== 'export' && filteredItems.length === 0)
                }
                title={
                  batchBusy === 'export'
                    ? '取消导出'
                    : selected.size > 0
                      ? `导出已选 ${selected.size} 条`
                      : hasActiveFilter
                        ? `导出筛选 ${filteredItems.length} 条`
                        : '导出全部 JSON'
                }
              >
                {batchBusy === 'export' ? (
                  <Ban className="h-3.5 w-3.5" />
                ) : (
                  <FileDown className="h-3.5 w-3.5" />
                )}
                {batchBusy === 'export' ? '取消' : '导出'}
              </Button>
              <span className="mx-0.5 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
              <Button
                variant={batchBusy === 'delete' ? 'danger' : 'secondary'}
                size="sm"
                className="min-w-[5.5rem] justify-center"
                onClick={() => {
                  if (batchBusy === 'delete') cancelBatch('delete');
                  else void deleteBatch();
                }}
                disabled={
                  (Boolean(busy) && batchBusy !== 'delete') ||
                  (batchBusy !== 'delete' && selected.size === 0)
                }
                title={
                  batchBusy === 'delete'
                    ? '取消删除'
                    : selected.size > 0
                      ? `删除已选 ${selected.size} 个 Auth 文件`
                      : '请先勾选要删除的条目'
                }
              >
                {batchBusy === 'delete' ? (
                  <Ban className="h-3.5 w-3.5" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
                {batchBusy === 'delete' ? '取消' : '删除'}
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
                  : statusFilter === 'unprobed'
                    ? ' 没有未测活项。'
                    : statusFilter === '200'
                      ? ' 没有 HTTP 200。'
                      : statusFilter === '401'
                        ? ' 没有 HTTP 401。'
                        : statusFilter === '403'
                          ? ' 没有 HTTP 403。'
                          : statusFilter === 'other_err'
                            ? ' 没有其它错误状态。'
                            : ''}
          </p>
          {hasActiveFilter && (
            <div className="mt-3">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  clearMetaFilter();
                  changeStatusFilter('all');
                }}
              >
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
                <th className="w-[7rem] max-w-[7rem] px-2 py-2.5 font-medium">
                  授权
                </th>
                <th className="w-[4.5rem] px-3 py-2.5 font-medium">SSO</th>
                <th className="w-10 px-2 py-2.5 text-center font-medium">Type</th>
                <th className="w-[3.25rem] px-3 py-2.5 font-medium">xai</th>
                <th className="w-[4.5rem] px-3 py-2.5 font-medium">bot_flag</th>
                {/* 固定窄列仅放 O/X，避免测活后邻列横向跳动 */}
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
                const probeAction = probe?.action || item.probeAction || undefined;
                const probeHttp =
                  probe?.http ??
                  (item.probeHttp != null && item.probeHttp > 0
                    ? item.probeHttp
                    : undefined);
                const rowResign = rowBusy === `resign:${item.filename}`;
                const rowProbe = rowBusy === `probe:${item.filename}`;
                const rowRelogin = rowBusy === `relogin:${item.filename}`;
                const rowNoEmail = !hasEmail(item);
                const rowNoSso = !hasSso(item);
                const rowReloginSt = reloginStageMap[item.filename];
                const rowStage = rowReloginSt?.stage;
                const rowStageActive =
                  Boolean(rowStage) &&
                  rowStage !== 'done' &&
                  rowStage !== 'error';
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
                    <td
                      className="w-[7rem] max-w-[7rem] truncate px-2 py-2.5 font-mono text-[11px] text-muted-foreground"
                      title={item.filename}
                    >
                      {item.filename}
                    </td>
                    <td className="w-[4.5rem] min-w-[4.5rem] max-w-[4.5rem] px-3 py-2.5">
                      {/* SSO：有=绿 / 无=黄（固定槽位防布局跳动） */}
                      <div className="flex h-5 items-center">
                        {rowNoSso ? (
                          <span
                            className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
                            title={
                              rowNoEmail
                                ? '无 SSO · 且无邮箱，无法 email 回填'
                                : '无 SSO：可筛选后点「回填SSO」（需有邮箱）'
                            }
                          >
                            无
                          </span>
                        ) : (
                          <span
                            className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
                            title="已含 SSO（SSO→Auth 转换或已回填）"
                          >
                            有
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="w-10 min-w-10 px-2 py-2.5 text-center">
                      {/* Type：A=PKCE / B=Device，蓝色字 */}
                      {item.mintChannel === 'A' || item.mintChannel === 'B' ? (
                        <span
                          className="text-[12px] font-semibold text-blue-600 dark:text-blue-400"
                          title={
                            item.mintChannel === 'B'
                              ? 'B · Device Flow'
                              : 'A · Auth Code + PKCE'
                          }
                        >
                          {item.mintChannel}
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
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
                        flag={
                          // 0 合法；有 sso 且无 claim 时显示绿 None
                          item.botFlagSource != null && item.botFlagSource !== ''
                            ? item.botFlagSource
                            : item.hasSso
                              ? 0
                              : item.botFlagSource
                        }
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
                      <div className="inline-flex flex-row flex-wrap items-center gap-1">
                        {rowStage && (
                          <span
                            className={cn(
                              'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums',
                              rowStage === 'done'
                                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                : rowStage === 'error'
                                  ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                                  : rowStage === 'queued'
                                    ? 'bg-slate-500/15 text-slate-600 dark:text-slate-300'
                                    : 'bg-amber-500/15 text-amber-700 dark:text-amber-400 animate-pulse'
                            )}
                            title={
                              rowReloginSt?.message
                                ? `${reloginStageLabel(rowStage)} · ${rowReloginSt.message}`
                                : reloginStageLabel(rowStage)
                            }
                          >
                            {reloginStageLabel(rowStage)}
                          </span>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 shrink-0"
                          disabled={busy}
                          onClick={() => void probeOne(item)}
                          title="单条 CPA 测活（结果落盘）"
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
                          disabled={
                            (busy && !rowStageActive) ||
                            rowNoEmail ||
                            item.poolHasPassword === false ||
                            rowStageActive
                          }
                          onClick={() => void reloginOne(item)}
                          title={
                            rowNoEmail
                              ? '无邮箱无法重登'
                              : item.poolHasPassword === false
                                ? '号池无该邮箱密码，请先补全（避免开浏览器后失败）'
                                : rowStage
                                  ? `重登：${reloginStageLabel(rowStage)}${
                                      rowReloginSt?.message
                                        ? ` · ${rowReloginSt.message}`
                                        : ''
                                    }`
                                  : '密码重登 → mint → 随机英文消息激活 → 更新测活/状态'
                          }
                        >
                          <KeyRound
                            className={cn(
                              'h-3.5 w-3.5',
                              (rowRelogin || rowStageActive) && 'animate-pulse'
                            )}
                          />
                          {rowStageActive
                            ? reloginStageLabel(rowStage)
                            : rowRelogin
                              ? '…'
                              : '重登'}
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

