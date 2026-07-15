import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckSquare,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileDown,
  FileUp,
  KeyRound,
  ListChecks,
  RefreshCcw,
  ShieldCheck,
  Square,
  Trash2,
  Wand2,
  X
} from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { Switch } from '@renderer/components/ui/Switch';
import { PaginationBar } from '@renderer/components/ui/PaginationBar';
import { AccountDetailDrawer } from '@renderer/components/domain/AccountDetailDrawer';
import { BotFlagBadge } from '@renderer/components/domain/BotFlagBadge';
import { NsfwBadge } from '@renderer/components/domain/NsfwBadge';
import { useClientPagination } from '@renderer/hooks/useClientPagination';
import { useAccountsStore } from '@renderer/store/accountsStore';
import { useRunStore } from '@renderer/store/runStore';
import { useToastStore } from '@renderer/store/toastStore';
import { cn } from '@renderer/lib/cn';
import {
  loadEmailPrivacyMask,
  maskEmail,
  saveEmailPrivacyMask
} from '@renderer/lib/maskEmail';
import { readBotFlagFromSso } from '@renderer/lib/botFlag';
import { buildSsoHashMap } from '@renderer/lib/ssoHash';
import { fmtBeijing, fmtBeijingTime } from '@renderer/lib/time';
import type { AccountRecord } from '@shared/runEvents';
import type { CpaAuthBatchResultItem, SsoCheckResult } from '@shared/ipc';

const PAGE_SIZE_KEY = 'gra-pool-page-size';
const AUTH_FILTER_KEY = 'gra-pool-auth-filter';
const ALIVE_FILTER_KEY = 'gra-pool-alive-filter';
const SSO_FILTER_KEY = 'gra-pool-sso-filter';
const MINT_CHUNK = 5;

/** Auth 转换筛选 */
type AuthFilter = 'all' | 'unconverted' | 'converted';
/** 验活状态筛选 */
type AliveFilter = 'all' | 'unchecked' | 'alive' | 'dead';
/** 是否含 SSO 筛选（分页/列表基于此） */
type SsoFilter = 'all' | 'has_sso' | 'no_sso';

function loadAuthFilter(): AuthFilter {
  try {
    const v = localStorage.getItem(AUTH_FILTER_KEY);
    if (v === 'unconverted' || v === 'converted' || v === 'all') return v;
  } catch {
    /* ignore */
  }
  return 'all';
}

function loadAliveFilter(): AliveFilter {
  try {
    const v = localStorage.getItem(ALIVE_FILTER_KEY);
    if (v === 'unchecked' || v === 'alive' || v === 'dead' || v === 'all') return v;
  } catch {
    /* ignore */
  }
  return 'all';
}

function loadSsoFilter(): SsoFilter {
  try {
    const v = localStorage.getItem(SSO_FILTER_KEY);
    if (v === 'has_sso' || v === 'no_sso' || v === 'all') return v;
  } catch {
    /* ignore */
  }
  return 'all';
}

function normEmail(email: string | undefined | null): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(filename: string, text: string) {
  const blob = new Blob([text + (text ? '\n' : '')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type MintProgress = {
  total: number;
  done: number;
  ok: number;
  failed: number;
  skipped: number;
  banned: number;
  current?: string;
  running: boolean;
};

export function PoolPage() {
  const accounts = useAccountsStore((s) => s.accounts);
  const loading = useAccountsStore((s) => s.loading);
  const reload = useAccountsStore((s) => s.reload);
  const resync = useAccountsStore((s) => s.resync);
  const remove = useAccountsStore((s) => s.remove);
  const importText = useAccountsStore((s) => s.importText);
  const ssoMap = useAccountsStore((s) => s.ssoMap);
  const applySsoResults = useAccountsStore((s) => s.applySsoResults);
  const phase = useRunStore((s) => s.status.phase);
  const push = useToastStore((s) => s.push);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [verifying, setVerifying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState('');
  const [importSource, setImportSource] = useState('paste');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [mintProg, setMintProg] = useState<MintProgress | null>(null);
  const [emailMasked, setEmailMasked] = useState(() => loadEmailPrivacyMask());
  /** 补 Auth 时跳过 bot_flag_source=1（默认开，localStorage 记忆） */
  const [skipBotFlag1, setSkipBotFlag1] = useState(() => {
    try {
      const v = localStorage.getItem('gra-skip-bot-flag1');
      if (v === null) return true;
      return v === '1' || v === 'true';
    } catch {
      return true;
    }
  });
  /** CPA auth 目录中已存在的邮箱（小写），用于「已转换」标签 */
  const [authEmails, setAuthEmails] = useState<Set<string>>(() => new Set());
  /**
   * 邮箱 / ssoHash → 已转通道集合（A=pkce / B=device）。
   * 用于卡片标签 Auth A / Auth B / Auth AB。
   */
  const [authEmailChannels, setAuthEmailChannels] = useState<Map<string, Set<'A' | 'B'>>>(
    () => new Map()
  );
  const [authHashChannels, setAuthHashChannels] = useState<Map<string, Set<'A' | 'B'>>>(
    () => new Map()
  );
  /**
   * 邮箱 / ssoHash → Auth 侧 bot_flag（listCpaAuth 已解析）。
   * SSO JWT 无 claim 时回退展示，与 Auth 页一致。
   */
  const [authEmailBotFlags, setAuthEmailBotFlags] = useState<
    Map<string, { botFlagSource: number | string | null; isBotFlag1: boolean }>
  >(() => new Map());
  const [authHashBotFlags, setAuthHashBotFlags] = useState<
    Map<string, { botFlagSource: number | string | null; isBotFlag1: boolean }>
  >(() => new Map());
  /** auth 文件内 sso 的 SHA-256 集合（无邮箱时交叉匹配） */
  const [authSsoHashes, setAuthSsoHashes] = useState<Set<string>>(() => new Set());
  /** 号池账号 id → ssoHash（异步预计算） */
  const [accountSsoHashes, setAccountSsoHashes] = useState<Map<string, string>>(
    () => new Map()
  );
  const [authFilter, setAuthFilter] = useState<AuthFilter>(() => loadAuthFilter());
  const [aliveFilter, setAliveFilter] = useState<AliveFilter>(() => loadAliveFilter());
  const [ssoFilter, setSsoFilter] = useState<SsoFilter>(() => loadSsoFilter());

  const reloadAuthEmails = async () => {
    try {
      const r = await window.api.listCpaAuth();
      const nextEmails = new Set<string>();
      const nextHashes = new Set<string>();
      const nextEmailCh = new Map<string, Set<'A' | 'B'>>();
      const nextHashCh = new Map<string, Set<'A' | 'B'>>();
      const nextEmailFlags = new Map<
        string,
        { botFlagSource: number | string | null; isBotFlag1: boolean }
      >();
      const nextHashFlags = new Map<
        string,
        { botFlagSource: number | string | null; isBotFlag1: boolean }
      >();

      const addCh = (
        map: Map<string, Set<'A' | 'B'>>,
        key: string,
        ch: 'A' | 'B' | null | undefined
      ) => {
        if (!key) return;
        let set = map.get(key);
        if (!set) {
          set = new Set();
          map.set(key, set);
        }
        set.add(ch === 'B' ? 'B' : 'A');
      };

      const preferFlag = (
        map: Map<string, { botFlagSource: number | string | null; isBotFlag1: boolean }>,
        key: string,
        flag: number | string | null | undefined,
        is1: boolean | undefined
      ) => {
        if (!key) return;
        // 缺失不写入；0 是合法 None
        if (flag === undefined || flag === null || flag === '') return;
        const next = {
          botFlagSource: flag,
          isBotFlag1: is1 === true || flag === 1 || flag === '1'
        };
        const prev = map.get(key);
        // 已有 Bot(1) 则保留；否则用新值（多 auth 时优先标 1）
        if (prev?.isBotFlag1) return;
        if (next.isBotFlag1 || !prev) map.set(key, next);
      };

      for (const it of r.items || []) {
        const e = normEmail(it.email);
        if (e) nextEmails.add(e);
        const h = String(it.ssoHash || '').trim().toLowerCase();
        if (h) nextHashes.add(h);
        const ch =
          it.mintChannel === 'B' ? 'B' : it.mintChannel === 'A' ? 'A' : null;
        if (e) addCh(nextEmailCh, e, ch);
        if (h) addCh(nextHashCh, h, ch);
        if (e) preferFlag(nextEmailFlags, e, it.botFlagSource, it.isBotFlag1);
        if (h) preferFlag(nextHashFlags, h, it.botFlagSource, it.isBotFlag1);
      }
      setAuthEmails(nextEmails);
      setAuthSsoHashes(nextHashes);
      setAuthEmailChannels(nextEmailCh);
      setAuthHashChannels(nextHashCh);
      setAuthEmailBotFlags(nextEmailFlags);
      setAuthHashBotFlags(nextHashFlags);
    } catch {
      /* auth 目录不可用时保持旧集合 */
    }
  };

  const toggleEmailPrivacy = () => {
    setEmailMasked((prev) => {
      const next = !prev;
      saveEmailPrivacyMask(next);
      return next;
    });
  };

  const doImport = async () => {
    const text = importDraft.trim();
    if (!text) {
      push({ tone: 'warn', title: '请粘贴或选择文件' });
      return;
    }
    setImporting(true);
    try {
      const r = await importText(text, importSource || 'paste');
      push({
        tone: r.imported > 0 ? 'ok' : 'warn',
        title: 'SSO 导入完成',
        description: `新增 ${r.imported} · 跳过 ${r.skipped} · 无效 ${r.invalid} · 剩余 ${r.remaining}`
      });
      if (r.imported > 0) {
        setImportOpen(false);
        setImportDraft('');
        setImportSource('paste');
      }
    } catch (err) {
      push({
        tone: 'danger',
        title: '导入失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setImporting(false);
    }
  };

  const onPickImportFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      setImportDraft(text);
      setImportSource(file.name || 'file');
      setImportOpen(true);
    } catch (err) {
      push({
        tone: 'danger',
        title: '读取文件失败',
        description: err instanceof Error ? err.message : String(err)
      });
    }
  };

  const doReload = async (scanHistory = false) => {
    try {
      if (scanHistory) {
        const r = await resync();
        if (r.imported > 0) {
          push({
            tone: 'ok',
            title: '已导入历史',
            description: `新增 ${r.imported} 条，合计 ${r.total}`
          });
        }
      } else {
        await reload();
      }
      await reloadAuthEmails();
    } catch (err) {
      push({
        tone: 'danger',
        title: '加载 SSO 失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setLastRefresh(new Date().toISOString());
    }
  };

  useEffect(() => {
    void doReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  useEffect(() => {
    if (phase === 'done') void doReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 号池 SSO → hash（增量缓存：仅 id/sso 签名变化时重算）
  const accountsHashKey = useMemo(
    () =>
      accounts
        .map((a) => `${a.id}\0${a.sso || ''}`)
        .sort()
        .join('\n'),
    [accounts]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const map = await buildSsoHashMap(accounts);
      if (!cancelled) setAccountSsoHashes(map);
    })();
    return () => {
      cancelled = true;
    };
    // accountsHashKey 避免 accounts 引用抖动导致全量重跑；buildSsoHashMap 内部仍有 per-id 缓存
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsHashKey]);

  const isAuthConverted = (a: AccountRecord) => {
    const e = normEmail(a.email);
    if (e && authEmails.has(e)) return true;
    const h = accountSsoHashes.get(a.id);
    if (h && authSsoHashes.has(h)) return true;
    return false;
  };

  /** 已转通道：A / B / AB / 未转(null) */
  const authChannelOf = (a: AccountRecord): 'A' | 'B' | 'AB' | null => {
    const merged = new Set<'A' | 'B'>();
    const e = normEmail(a.email);
    if (e) {
      const s = authEmailChannels.get(e);
      if (s) s.forEach((c) => merged.add(c));
    }
    const h = accountSsoHashes.get(a.id);
    if (h) {
      const s = authHashChannels.get(h);
      if (s) s.forEach((c) => merged.add(c));
    }
    if (merged.size === 0) {
      // 兼容：仅命中旧集合但无通道 map 时，视为 A
      if (isAuthConverted(a)) return 'A';
      return null;
    }
    if (merged.has('A') && merged.has('B')) return 'AB';
    if (merged.has('B')) return 'B';
    return 'A';
  };

  /** 匹配到的 Auth bot_flag（邮箱优先，其次 ssoHash） */
  const authBotFlagOf = (
    a: AccountRecord
  ): { botFlagSource: number | string | null; isBotFlag1: boolean } | null => {
    const e = normEmail(a.email);
    if (e) {
      const f = authEmailBotFlags.get(e);
      if (f && f.botFlagSource != null && f.botFlagSource !== '') return f;
    }
    const h = accountSsoHashes.get(a.id);
    if (h) {
      const f = authHashBotFlags.get(h);
      if (f && f.botFlagSource != null && f.botFlagSource !== '') return f;
    }
    return null;
  };

  const aliveStatusOf = (a: AccountRecord): 'unchecked' | 'alive' | 'dead' => {
    const r = ssoMap.get(a.id);
    if (!r) return 'unchecked';
    return r.alive ? 'alive' : 'dead';
  };

  const filteredAccounts = useMemo(() => {
    let list = accounts;
    if (ssoFilter === 'has_sso') list = list.filter((a) => Boolean(String(a.sso || '').trim()));
    else if (ssoFilter === 'no_sso') list = list.filter((a) => !String(a.sso || '').trim());
    if (authFilter === 'converted') list = list.filter((a) => isAuthConverted(a));
    else if (authFilter === 'unconverted') list = list.filter((a) => !isAuthConverted(a));
    if (aliveFilter === 'unchecked') list = list.filter((a) => aliveStatusOf(a) === 'unchecked');
    else if (aliveFilter === 'alive') list = list.filter((a) => aliveStatusOf(a) === 'alive');
    else if (aliveFilter === 'dead') list = list.filter((a) => aliveStatusOf(a) === 'dead');
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accounts,
    authEmails,
    authSsoHashes,
    accountSsoHashes,
    authFilter,
    aliveFilter,
    ssoFilter,
    ssoMap
  ]);

  const convertedCount = useMemo(
    () => accounts.filter((a) => isAuthConverted(a)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accounts, authEmails, authSsoHashes, accountSsoHashes]
  );
  const unconvertedCount = accounts.length - convertedCount;

  const uncheckedCount = useMemo(
    () => accounts.filter((a) => !ssoMap.has(a.id)).length,
    [accounts, ssoMap]
  );
  const aliveOnlyCount = useMemo(
    () => accounts.filter((a) => ssoMap.get(a.id)?.alive === true).length,
    [accounts, ssoMap]
  );
  const deadOnlyCount = useMemo(
    () => accounts.filter((a) => ssoMap.get(a.id)?.alive === false).length,
    [accounts, ssoMap]
  );

  const {
    pageSize,
    totalPages,
    currentPage,
    pageItems: pageAccounts,
    rangeFrom,
    rangeTo,
    setPage,
    changePageSize,
    resetPage
  } = useClientPagination(filteredAccounts, PAGE_SIZE_KEY);

  const changeAuthFilter = (f: AuthFilter) => {
    setAuthFilter(f);
    resetPage();
    try {
      localStorage.setItem(AUTH_FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };

  const changeAliveFilter = (f: AliveFilter) => {
    setAliveFilter(f);
    resetPage();
    try {
      localStorage.setItem(ALIVE_FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };

  const changeSsoFilter = (f: SsoFilter) => {
    setSsoFilter(f);
    resetPage();
    try {
      localStorage.setItem(SSO_FILTER_KEY, f);
    } catch {
      /* ignore */
    }
  };

  // 列表/筛选变化时清理无效选中
  useEffect(() => {
    const ids = new Set(filteredAccounts.map((a) => a.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filteredAccounts]);

  const ssoCount = useMemo(
    () => accounts.filter((a) => Boolean(String(a.sso || '').trim())).length,
    [accounts]
  );
  const noSsoCount = accounts.length - ssoCount;
  const aliveCount = aliveOnlyCount;

  const allSelected =
    filteredAccounts.length > 0 && selected.size === filteredAccounts.length;
  const pageAllSelected =
    pageAccounts.length > 0 && pageAccounts.every((a) => selected.has(a.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 全选：当前筛选结果中的全部账号 */
  const selectAll = () => {
    if (filteredAccounts.length === 0) return;
    setSelected(
      allSelected ? new Set() : new Set(filteredAccounts.map((a) => a.id))
    );
  };

  /** 本页：仅当前页 */
  const selectPage = () => {
    if (pageAccounts.length === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (pageAllSelected) {
        for (const a of pageAccounts) next.delete(a.id);
      } else {
        for (const a of pageAccounts) next.add(a.id);
      }
      return next;
    });
  };

  const exportSso = (records: AccountRecord[]) => {
    const lines = records
      .filter((r) => r.sso)
      .map((r) => `${r.email || ''} | ${r.password || ''} | ${r.sso}`);
    if (lines.length === 0) {
      push({ tone: 'warn', title: '没有可导出的 SSO' });
      return;
    }
    download(`grok-sso-${stamp()}.txt`, lines.join('\n'));
    push({ tone: 'ok', title: '已导出 SSO', description: `${lines.length} 条` });
  };

  const exportAccounts = (records: AccountRecord[]) => {
    if (records.length === 0) {
      push({ tone: 'warn', title: '没有可导出的账号' });
      return;
    }
    const text = records
      .map((r) => `${r.email || ''} | ${r.password || ''} | ${r.sso || ''}`)
      .join('\n');
    download(`grok-accounts-${stamp()}.txt`, text);
    push({ tone: 'ok', title: '已导出账号', description: `${records.length} 条` });
  };

  const applyResults = (results: SsoCheckResult[]) => {
    applySsoResults(results);
  };

  const verifyBatch = async () => {
    const pool = selected.size > 0 ? accounts.filter((a) => selected.has(a.id)) : filteredAccounts;
    const targets = pool.filter((a) => a.sso);
    if (targets.length === 0) {
      push({ tone: 'warn', title: '没有可验活的账号' });
      return;
    }
    const missingEmailBefore = targets.filter((a) => !String(a.email || '').trim()).length;
    setVerifying(true);
    try {
      const results = await window.api.checkSso(
        targets.map((a) => ({ id: a.id, sso: a.sso }))
      );
      applyResults(results);
      // 服务端已按 SSO 补 email；再拉一次列表保证 UI 与库一致
      try {
        await reload();
      } catch {
        /* applySsoResults 已写内存 */
      }
      const alive = results.filter((r) => r.alive).length;
      const emailsFilled =
        typeof (results as { emailsFilled?: number }).emailsFilled === 'number'
          ? (results as { emailsFilled?: number }).emailsFilled!
          : results.filter((r) => {
              const before = targets.find((t) => t.id === r.id);
              return (
                before &&
                !String(before.email || '').trim() &&
                Boolean(String(r.email || '').trim())
              );
            }).length;
      const emailHint =
        emailsFilled > 0
          ? ` · 补邮箱 ${emailsFilled}` +
            (missingEmailBefore > emailsFilled
              ? `（${missingEmailBefore - emailsFilled} 条验活未返回邮箱）`
              : '（便于 Auth 按 email 回填 sso）')
          : missingEmailBefore > 0
            ? ' · 无邮箱号未补全（验活未返回 email 或已失效）'
            : '';
      push({
        tone: 'ok',
        title: '验活完成',
        description: `存活 ${alive} / ${results.length}（已写入账号库 + 本机缓存）${emailHint}`
      });
    } catch (err) {
      push({ tone: 'danger', title: '批量验活失败', description: String(err) });
    } finally {
      setVerifying(false);
    }
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) {
      push({ tone: 'warn', title: '请先勾选要删除的账号' });
      return;
    }
    if (!window.confirm(`确认删除 ${ids.length} 个账号？\n（仅删 SSO 列表记录，不删历史文件）`)) {
      return;
    }
    setDeleting(true);
    try {
      const r = await remove(ids);
      setSelected(new Set());
      push({
        tone: 'ok',
        title: '已删除',
        description: `删除 ${r.deleted} · 剩余 ${r.remaining}`
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '删除失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setDeleting(false);
    }
  };

  /** 号池 SSO → 预检存活后 CPA auth 补 mint；分块并显示进度 */
  const mintAuthFromSso = async () => {
    const pool = selected.size > 0 ? accounts.filter((a) => selected.has(a.id)) : filteredAccounts;
    const targets = pool.filter((a) => a.sso);
    if (targets.length === 0) {
      push({ tone: 'warn', title: '没有可 mint 的 SSO' });
      return;
    }
    if (targets.length > 200) {
      push({ tone: 'warn', title: '单次最多 200 个', description: '请缩小选择范围后再试' });
      return;
    }

    setMintProg({
      total: targets.length,
      done: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      banned: 0,
      running: true,
      current: targets[0]?.email || ''
    });

    let ok = 0;
    let failed = 0;
    let skipped = 0;
    let banned = 0;
    let probeDead = 0;
    let probeOk = 0;
    let noXai = 0;
    const allResults: CpaAuthBatchResultItem[] = [];

    try {
      for (let i = 0; i < targets.length; i += MINT_CHUNK) {
        const chunk = targets.slice(i, i + MINT_CHUNK);
        setMintProg((p) =>
          p
            ? {
                ...p,
                current: chunk[0]?.email || chunk[0]?.sso?.slice(0, 12) || '',
                running: true
              }
            : p
        );
        const r = await window.api.mintCpaAuthFromSso({
          items: chunk.map((a) => ({ sso: a.sso, email: a.email })),
          concurrency: Math.min(3, chunk.length),
          skipBotFlag1
        });
        allResults.push(...(r.results || []));
        ok += r.ok || 0;
        failed += r.failed || 0;
        skipped += r.skipped ?? r.results.filter((x) => x.skipped).length;
        banned += r.banned ?? r.results.filter((x) => x.verdict === 'banned').length;
        const botSkip =
          r.botFlagSkipped ?? r.results.filter((x) => x.verdict === 'bot_flag').length;
        skipped += 0; // keep skipped as server total
        probeDead += r.results.filter((x) => x.probeAction === 'dead' || x.probeDeleted).length;
        probeOk += r.results.filter((x) => x.probeAction === 'ok').length;
        noXai += r.results.filter((x) => x.ok && x.xai === false).length;
        // bot flag 计入 skipped 已由 r.skipped 包含
        void botSkip;

        const done = Math.min(i + chunk.length, targets.length);
        setMintProg({
          total: targets.length,
          done,
          ok,
          failed,
          skipped,
          banned,
          current: chunk[chunk.length - 1]?.email || '',
          running: done < targets.length
        });
      }

      const botFlagN = allResults.filter((x) => x.verdict === 'bot_flag').length;
      const remoteOkN = allResults.filter((x) => x.remoteOk === true).length;
      const remoteFailN = allResults.filter((x) => x.remoteOk === false).length;
      const remoteErrSample = allResults.find((x) => x.remoteOk === false)?.remoteError;
      const parts = [
        `成功 ${ok}`,
        `失败 ${failed}`,
        skipped ? `预检跳过 ${skipped}` : '',
        botFlagN ? `bot_flag=1 跳过 ${botFlagN}` : '',
        banned ? `封禁 ${banned}` : '',
        probeOk ? `CPA测活OK ${probeOk}` : '',
        probeDead ? `CPA测活挂 ${probeDead}` : '',
        noXai ? `无 xai ${noXai}` : ok > 0 ? '均含 xai' : '',
        remoteOkN ? `远程推送OK ${remoteOkN}` : '',
        remoteFailN
          ? `远程失败 ${remoteFailN}${remoteErrSample ? `（${remoteErrSample.slice(0, 80)}）` : ''}`
          : ''
      ].filter(Boolean);
      push({
        tone:
          failed > 0 || banned > 0 || probeDead > 0 || remoteFailN > 0
            ? 'warn'
            : ok > 0
              ? 'ok'
              : 'warn',
        title: 'SSO 补 Auth 完成',
        description: parts.join(' · ')
      });
    } catch (err) {
      push({
        tone: 'danger',
        title: '补 Auth 失败',
        description: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setMintProg((p) =>
        p
          ? {
              ...p,
              running: false,
              done: p.total,
              ok,
              failed,
              skipped,
              banned
            }
          : null
      );
      // 进度条保留几秒再收起
      window.setTimeout(() => setMintProg(null), 4000);
    }
  };

  const picked = accounts.filter((a) => selected.has(a.id));
  const openAccount = accounts.find((a) => a.id === openId) ?? null;
  const minting = !!mintProg?.running;
  const busy = verifying || minting || deleting || importing;
  const hasActiveFilter =
    authFilter !== 'all' || aliveFilter !== 'all' || ssoFilter !== 'all';

  const mintPct =
    mintProg && mintProg.total > 0
      ? Math.min(100, Math.round((mintProg.done / mintProg.total) * 100))
      : 0;

  return (
    <div className="space-y-5">
      <section className="terminal-grid">
        <PoolMetric label="账号总量" value={String(accounts.length)} Icon={Database} />
        <PoolMetric label="含 SSO" value={String(ssoCount)} Icon={KeyRound} />
        <PoolMetric label="验活存活" value={ssoMap.size ? String(aliveCount) : '--'} Icon={ShieldCheck} />
        <PoolMetric
          label="最近时间"
          value={accounts[0] ? fmtBeijing(accounts[0].createdAt, false) : '--'}
          Icon={RefreshCcw}
        />
      </section>

      {mintProg && (
        <div className="rounded-[16px] border border-primary/30 bg-primary/5 px-4 py-3 shadow-[var(--ios-shadow)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold tracking-tight">
                {mintProg.running ? '补 Auth 进行中' : '补 Auth 已完成'}
              </p>
              <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                {mintProg.done}/{mintProg.total}
                {mintProg.current ? ` · 当前 ${mintProg.current}` : ''}
                {` · 成功 ${mintProg.ok} · 失败 ${mintProg.failed}`}
                {mintProg.skipped ? ` · 跳过 ${mintProg.skipped}` : ''}
                {mintProg.banned ? ` · 封禁 ${mintProg.banned}` : ''}
              </p>
            </div>
            <span className="chip tabular-nums">{mintPct}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                mintProg.running ? 'bg-primary' : 'bg-emerald-500'
              )}
              style={{ width: `${mintPct}%` }}
            />
          </div>
        </div>
      )}

      <div className="ios-group">
        <div className="space-y-3 border-b border-border/70 px-4 py-3.5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="page-kicker">SSO</p>
              <h3 className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">账号列表</h3>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                {selected.size > 0 ? `已选 ${selected.size} 项` : '未选择'}
                {hasActiveFilter
                  ? ` · 筛选 ${filteredAccounts.length}/${accounts.length}`
                  : ` · 共 ${accounts.length}`}
                {lastRefresh ? ` · 刷新于 ${fmtBeijingTime(lastRefresh)}` : ''}
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
                onClick={() => void doReload(true)}
                disabled={loading || busy}
                title="重新扫描 SSO 历史并刷新列表"
              >
                <RefreshCcw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                刷新
              </Button>
            </div>
          </div>

          {/* 筛选行：SSO → Auth → 验活 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-0.5 w-8 shrink-0 text-[10px] text-muted-foreground">SSO</span>
              {(
                [
                  { id: 'all' as const, label: '全部', count: accounts.length },
                  { id: 'has_sso' as const, label: '有SSO', count: ssoCount },
                  { id: 'no_sso' as const, label: '未SSO', count: noSsoCount }
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => changeSsoFilter(tab.id)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                    ssoFilter === tab.id
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                  title={
                    tab.id === 'no_sso'
                      ? '无 SSO 的账号（分页与列表按此筛选）'
                      : tab.id === 'has_sso'
                        ? '含 SSO，可验活/补 Auth'
                        : '不限制是否有 SSO'
                  }
                >
                  {tab.label}
                  <span className="ml-1 tabular-nums opacity-80">{tab.count}</span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-0.5 w-8 shrink-0 text-[10px] text-muted-foreground">Auth</span>
              {(
                [
                  { id: 'all' as const, label: '全部', count: accounts.length },
                  { id: 'unconverted' as const, label: '未转换', count: unconvertedCount },
                  { id: 'converted' as const, label: '已转换', count: convertedCount }
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => changeAuthFilter(tab.id)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                    authFilter === tab.id
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                  title={
                    tab.id === 'converted'
                      ? '已匹配 Auth（email 或 SSO 哈希）'
                      : tab.id === 'unconverted'
                        ? '尚未转 Auth'
                        : '不限制 Auth 转换状态'
                  }
                >
                  {tab.label}
                  <span className="ml-1 tabular-nums opacity-80">{tab.count}</span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <span className="mr-0.5 w-8 shrink-0 text-[10px] text-muted-foreground">验活</span>
              {(
                [
                  { id: 'all' as const, label: '全部', count: accounts.length },
                  { id: 'unchecked' as const, label: '未验', count: uncheckedCount },
                  { id: 'alive' as const, label: '存活', count: aliveOnlyCount },
                  { id: 'dead' as const, label: '失效', count: deadOnlyCount }
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => changeAliveFilter(tab.id)}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors',
                    aliveFilter === tab.id
                      ? tab.id === 'alive'
                        ? 'bg-emerald-600 text-white shadow-sm'
                        : tab.id === 'dead'
                          ? 'bg-destructive text-destructive-foreground shadow-sm'
                          : 'bg-primary text-primary-foreground shadow-sm'
                      : 'bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  {tab.label}
                  <span className="ml-1 tabular-nums opacity-80">{tab.count}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 操作：选择 | 业务 | 导入导出 | 删除 */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 hidden text-[10px] text-muted-foreground sm:inline">选择</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={selectAll}
                disabled={filteredAccounts.length === 0 || busy}
                title="选择当前筛选结果全部"
              >
                {allSelected ? (
                  <CheckSquare className="h-3.5 w-3.5" />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )}
                {allSelected ? '取消全选' : '全选'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={selectPage}
                disabled={pageAccounts.length === 0 || busy}
                title="仅选择当前分页"
              >
                <ListChecks className="h-3.5 w-3.5" />
                {pageAllSelected ? '取消本页' : '本页'}
              </Button>
              <span className="mx-0.5 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
              <span className="mr-0.5 hidden text-[10px] text-muted-foreground sm:inline">业务</span>
              <Button
                size="sm"
                onClick={() => void verifyBatch()}
                disabled={busy || filteredAccounts.length === 0}
              >
                <ShieldCheck className={cn('h-3.5 w-3.5', verifying && 'animate-pulse')} />
                {verifying
                  ? '验活中…'
                  : selected.size > 0
                    ? `验活(${selected.size})`
                    : hasActiveFilter
                      ? `验活(${filteredAccounts.length})`
                      : '验活全部'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void mintAuthFromSso()}
                disabled={busy || filteredAccounts.length === 0}
                title={
                  skipBotFlag1
                    ? '预检存活 + 跳过 bot_flag=1 后 mint'
                    : '预检存活后 mint（含 bot_flag=1）'
                }
              >
                <Wand2 className={cn('h-3.5 w-3.5', minting && 'animate-pulse')} />
                {minting
                  ? `Mint ${mintProg?.done ?? 0}/${mintProg?.total ?? 0}`
                  : selected.size > 0
                    ? `补 Auth(${picked.filter((a) => a.sso).length})`
                    : hasActiveFilter
                      ? `补 Auth(${filteredAccounts.filter((a) => a.sso).length})`
                      : '补 Auth'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSkipBotFlag1((v) => {
                    const next = !v;
                    try {
                      localStorage.setItem('gra-skip-bot-flag1', next ? '1' : '0');
                    } catch {
                      /* ignore */
                    }
                    return next;
                  });
                }}
                title={
                  skipBotFlag1
                    ? '补 Auth 跳过 bot_flag=1（点击关闭）'
                    : '补 Auth 不跳过 flag1（点击开启）'
                }
              >
                {skipBotFlag1 ? '跳过flag1:开' : '跳过flag1:关'}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 hidden text-[10px] text-muted-foreground sm:inline">
                导入导出
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setImportOpen(true)}
                disabled={busy}
                title="粘贴或上传 SSO 导入列表"
              >
                <FileUp className="h-3.5 w-3.5" />
                导入SSO
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv,.log,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null;
                  e.target.value = '';
                  void onPickImportFile(f);
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => exportSso(picked.length > 0 ? picked : filteredAccounts)}
                disabled={filteredAccounts.length === 0 || busy}
                title={picked.length > 0 ? '导出已选 SSO' : '导出当前筛选 SSO'}
              >
                <FileDown className="h-3.5 w-3.5" />
                导出SSO
                {picked.length > 0 ? `(${picked.filter((a) => a.sso).length})` : ''}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => exportAccounts(picked.length > 0 ? picked : filteredAccounts)}
                disabled={filteredAccounts.length === 0 || busy}
                title={picked.length > 0 ? '导出已选账号' : '导出当前筛选账号'}
              >
                <FileDown className="h-3.5 w-3.5" />
                {picked.length > 0
                  ? `导出账号(${picked.length})`
                  : hasActiveFilter
                    ? '导出筛选'
                    : '导出账号'}
              </Button>
              <span className="mx-0.5 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void deleteSelected()}
                disabled={busy || selected.size === 0}
                title="从列表删除已选"
              >
                <Trash2 className={cn('h-3.5 w-3.5', deleting && 'animate-pulse')} />
                {deleting ? '删除中…' : `删除(${selected.size})`}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-12 text-center text-[13px] text-muted-foreground">
          还没有账号。到「注册机」跑一轮任务即可出现在这里。
        </div>
      ) : filteredAccounts.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-12 text-center text-[13px] text-muted-foreground">
          <p>
            当前筛选下没有账号。
            {ssoFilter === 'no_sso'
              ? ' 全部账号均含 SSO。'
              : ssoFilter === 'has_sso'
                ? ' 没有含 SSO 的账号。'
                : authFilter === 'converted'
                  ? ' 没有已转换 Auth 的账号。'
                  : authFilter === 'unconverted'
                    ? ' 没有未转换的账号。'
                    : aliveFilter === 'unchecked'
                      ? ' 没有未验活账号。'
                      : aliveFilter === 'alive'
                        ? ' 没有标记为存活的账号。'
                        : aliveFilter === 'dead'
                          ? ' 没有标记为失效的账号。'
                          : ''}
          </p>
          {hasActiveFilter && (
            <div className="mt-3">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  changeSsoFilter('all');
                  changeAuthFilter('all');
                  changeAliveFilter('all');
                }}
              >
                清空筛选
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {pageAccounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                checked={selected.has(a.id)}
                ssoResult={ssoMap.get(a.id)}
                emailMasked={emailMasked}
                authConverted={isAuthConverted(a)}
                authChannel={authChannelOf(a)}
                authBotFlag={authBotFlagOf(a)}
                onToggle={() => toggle(a.id)}
                onOpen={() => setOpenId(a.id)}
              />
            ))}
          </div>

          <PaginationBar
            page={currentPage}
            totalPages={totalPages}
            rangeFrom={rangeFrom}
            rangeTo={rangeTo}
            total={filteredAccounts.length}
            pageSize={pageSize}
            onChange={setPage}
            onPageSizeChange={changePageSize}
          />
        </>
      )}

      <AccountDetailDrawer
        account={openAccount}
        open={openId !== null}
        onClose={() => setOpenId(null)}
        ssoResult={openId ? ssoMap.get(openId) : undefined}
        onSsoResult={(r) => applyResults([r])}
      />

      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div
            className="absolute inset-0"
            onClick={() => !importing && setImportOpen(false)}
            aria-hidden
          />
          <div className="relative z-10 w-full max-w-xl rounded-2xl border border-border bg-card p-4 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-[16px] font-semibold tracking-tight">导入 SSO</h3>
                <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                  每行一条，支持：
                  <br />
                  <code className="text-[11px]">email | password | sso</code>
                  <br />
                  <code className="text-[11px]">email----password----sso</code>
                  <br />
                  <code className="text-[11px]">纯 JWT</code> / <code className="text-[11px]">sso=...</code>
                  <br />
                  按 SSO 去重；# 开头行为注释。
                </p>
              </div>
              <button
                type="button"
                className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => !importing && setImportOpen(false)}
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <textarea
              value={importDraft}
              onChange={(e) => setImportDraft(e.target.value)}
              rows={12}
              placeholder="粘贴 SSO 列表…"
              className="w-full resize-y rounded-xl border border-border bg-muted/40 px-3 py-2 font-mono text-[12px] outline-none focus:border-primary"
              disabled={importing}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={importing}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className="h-3.5 w-3.5" />
                选择文件
              </Button>
              <div className="flex gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={importing}
                  onClick={() => {
                    setImportOpen(false);
                    setImportDraft('');
                  }}
                >
                  取消
                </Button>
                <Button size="sm" disabled={importing || !importDraft.trim()} onClick={() => void doImport()}>
                  {importing ? '导入中…' : '确认导入'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountCard({
  account,
  checked,
  ssoResult,
  emailMasked,
  authConverted,
  authChannel,
  authBotFlag,
  onToggle,
  onOpen
}: {
  account: AccountRecord;
  checked: boolean;
  ssoResult?: SsoCheckResult;
  emailMasked: boolean;
  authConverted: boolean;
  /** A=PKCE / B=Device / AB=双通道 */
  authChannel: 'A' | 'B' | 'AB' | null;
  /** 匹配 Auth 文件的 bot_flag（SSO JWT 无 claim 时回退） */
  authBotFlag: { botFlagSource: number | string | null; isBotFlag1: boolean } | null;
  onToggle(): void;
  onOpen(): void;
}) {
  const [showPw, setShowPw] = useState(false);
  const [showSso, setShowSso] = useState(false);
  const push = useToastStore((s) => s.push);

  const copy = async (value: string, label: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      push({ tone: 'ok', title: `已复制${label}` });
    } catch {
      push({ tone: 'danger', title: '复制失败' });
    }
  };

  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const emailDisplay = maskEmail(account.email, emailMasked, { empty: '(无邮箱)' });
  // 优先验活结果 → 本地 SSO JWT → 匹配 Auth 文件 bot_flag（与 Auth 页一致）
  // 注意：bot_flag_source=0（None）是合法值，不能用 !flag / || 吞掉
  const localFlag = readBotFlagFromSso(account.sso);
  const hasSsoFlag =
    ssoResult != null &&
    ssoResult.botFlagSource !== undefined &&
    ssoResult.botFlagSource !== null &&
    ssoResult.botFlagSource !== '';
  const hasLocalFlag =
    localFlag.botFlagSource !== undefined &&
    localFlag.botFlagSource !== null &&
    localFlag.botFlagSource !== '';
  const hasAuthFlag =
    authBotFlag != null &&
    authBotFlag.botFlagSource !== undefined &&
    authBotFlag.botFlagSource !== null &&
    authBotFlag.botFlagSource !== '';
  let flagSource: number | string | null = null;
  let flagIs1 = false;
  let flagFrom: 'probe' | 'sso' | 'auth' | 'none' = 'none';
  if (hasSsoFlag) {
    flagSource = ssoResult!.botFlagSource as number | string;
    flagIs1 =
      ssoResult!.isBotFlag1 === true ||
      ssoResult!.botFlagSource === 1 ||
      ssoResult!.botFlagSource === '1';
    flagFrom = 'probe';
  } else if (hasLocalFlag) {
    flagSource = localFlag.botFlagSource;
    flagIs1 = localFlag.isBotFlag1;
    flagFrom = 'sso';
  } else if (hasAuthFlag) {
    flagSource = authBotFlag!.botFlagSource;
    flagIs1 = authBotFlag!.isBotFlag1;
    flagFrom = 'auth';
  }

  return (
    <div
      onClick={onOpen}
      className={cn(
        'flex cursor-pointer flex-col gap-3 rounded-[16px] border bg-card p-4 shadow-[var(--ios-shadow)] transition-colors hover:border-primary/40',
        checked ? 'border-primary/60 bg-primary/5' : 'border-border'
      )}
    >
      <div className="flex items-start gap-3">
        <Switch
          className="mt-0.5"
          size="sm"
          checked={checked}
          onChange={() => onToggle()}
          onClick={stop}
          aria-label={`选择 ${account.email || account.id}`}
        />
        <div className="min-w-0 flex-1">
          <div
            className="break-all text-sm font-semibold leading-5 tracking-tight"
            title={emailMasked && account.email ? '已遮蔽 · 点工具栏「显示邮箱」查看完整' : account.email || undefined}
          >
            {emailDisplay}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{fmtBeijing(account.createdAt)}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <AuthConvertedBadge converted={authConverted} channel={authChannel} />
          <SsoBadge result={ssoResult} />
          <NsfwBadge
            status={
              account.nsfwStatus ??
              (account.nsfwAttempted
                ? account.nsfwEnabled
                  ? 'ok'
                  : 'fail'
                : 'none')
            }
            error={account.nsfwError}
          />
          <span
            title={
              flagFrom === 'auth'
                ? 'bot_flag 来自匹配的 Auth 文件（SSO JWT 无 claim）'
                : flagFrom === 'probe'
                  ? 'bot_flag 来自验活结果'
                  : flagFrom === 'sso'
                    ? 'bot_flag 来自 SSO JWT'
                    : undefined
            }
          >
            <BotFlagBadge flag={flagSource} is1={flagIs1} missing="muted" />
          </span>
        </div>
      </div>

      <SecretRow
        label="密码"
        value={account.password || ''}
        reveal={showPw}
        onToggleReveal={() => setShowPw((v) => !v)}
        onCopy={() => void copy(account.password || '', '密码')}
        onClick={stop}
      />
      <SecretRow
        label="SSO"
        value={account.sso || ''}
        reveal={showSso}
        onToggleReveal={() => setShowSso((v) => !v)}
        onCopy={() => void copy(account.sso || '', 'SSO')}
        onClick={stop}
        mono
      />
    </div>
  );
}

function SecretRow({
  label,
  value,
  reveal,
  onToggleReveal,
  onCopy,
  onClick,
  mono
}: {
  label: string;
  value: string;
  reveal: boolean;
  onToggleReveal(): void;
  onCopy(): void;
  onClick(e: React.MouseEvent): void;
  mono?: boolean;
}) {
  const display = !value
    ? '—'
    : reveal
      ? value
      : label === 'SSO'
        ? `${value.slice(0, 8)}…${value.slice(-6)}`
        : '••••••••';
  return (
    <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-2.5 py-1.5" onClick={onClick}>
      <span className="w-10 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[12px]',
          mono && 'font-mono',
          !value && 'text-muted-foreground'
        )}
        title={reveal && value ? value : undefined}
      >
        {display}
      </span>
      {value ? (
        <>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
            onClick={onToggleReveal}
            title={reveal ? '隐藏' : '显示'}
          >
            {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            className="rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
            onClick={onCopy}
            title="复制"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </>
      ) : null}
    </div>
  );
}

function AuthConvertedBadge({
  converted,
  channel
}: {
  converted: boolean;
  channel?: 'A' | 'B' | 'AB' | null;
}) {
  if (converted || channel) {
    const tag =
      channel === 'AB' ? 'Auth AB' : channel === 'B' ? 'Auth B' : 'Auth A';
    const title =
      channel === 'AB'
        ? '已转双通道：A=PKCE + B=Device（两份 auth 互不影响）'
        : channel === 'B'
          ? '已转 Auth B（Device Flow）'
          : '已转 Auth A（Auth Code+PKCE）';
    return (
      <span
        className="shrink-0 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400"
        title={title}
      >
        {tag}
      </span>
    );
  }
  return (
    <span
      className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
      title="未匹配：邮箱与 Auth 目录均无对应，且 SSO 哈希未命中（auth 需含 sso 字段）"
    >
      未转
    </span>
  );
}

function SsoBadge({ result }: { result?: SsoCheckResult }) {
  if (!result) {
    return (
      <span
        className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
        title="尚未对本账号执行 SSO 验活；验活后会本地保存，切换页面不丢失"
      >
        未验
      </span>
    );
  }
  const when = result.checkedAt ? ` · ${fmtBeijing(result.checkedAt)}` : '';
  if (result.alive) {
    return (
      <span
        className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
        title={`存活${when}`}
      >
        存活
      </span>
    );
  }
  return (
    <span
      className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive"
      title={(result.error || '失效') + when}
    >
      失效
    </span>
  );
}

function PoolMetric({
  label,
  value,
  Icon
}: {
  label: string;
  value: string;
  Icon: typeof Database;
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
