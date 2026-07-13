import { useEffect, useMemo, useState } from 'react';
import {
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileDown,
  KeyRound,
  ListChecks,
  RefreshCcw,
  ShieldCheck,
  Square
} from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { AccountDetailDrawer } from '@renderer/components/domain/AccountDetailDrawer';
import { useAccountsStore } from '@renderer/store/accountsStore';
import { useRunStore } from '@renderer/store/runStore';
import { useToastStore } from '@renderer/store/toastStore';
import { cn } from '@renderer/lib/cn';
import { fmtBeijing, fmtBeijingTime } from '@renderer/lib/time';
import type { AccountRecord } from '@shared/runEvents';
import type { SsoCheckResult } from '@shared/ipc';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 500, 1000, 2000] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
const DEFAULT_PAGE_SIZE: PageSize = 20;
const PAGE_SIZE_KEY = 'gra-pool-page-size';

function loadPageSize(): PageSize {
  try {
    const raw = Number(localStorage.getItem(PAGE_SIZE_KEY));
    if (PAGE_SIZE_OPTIONS.includes(raw as PageSize)) return raw as PageSize;
  } catch {
    /* ignore */
  }
  return DEFAULT_PAGE_SIZE;
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

export function PoolPage() {
  const accounts = useAccountsStore((s) => s.accounts);
  const loading = useAccountsStore((s) => s.loading);
  const reload = useAccountsStore((s) => s.reload);
  const resync = useAccountsStore((s) => s.resync);
  const phase = useRunStore((s) => s.status.phase);
  const push = useToastStore((s) => s.push);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ssoMap, setSsoMap] = useState<Map<string, SsoCheckResult>>(new Map());
  const [verifying, setVerifying] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(() => loadPageSize());

  const changePageSize = (size: PageSize) => {
    setPageSize(size);
    setPage(1);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      /* ignore */
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
    } catch (err) {
      push({
        tone: 'danger',
        title: '加载号池失败',
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

  // 列表变化时清理无效选中，并纠正页码
  useEffect(() => {
    const ids = new Set(accounts.map((a) => a.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize) || 1);
    setPage((p) => Math.min(p, totalPages));
  }, [accounts, pageSize]);

  const ssoCount = useMemo(() => accounts.filter((a) => a.sso).length, [accounts]);
  const aliveCount = useMemo(
    () => [...ssoMap.values()].filter((r) => r.alive).length,
    [ssoMap]
  );

  const totalPages = Math.max(1, Math.ceil(accounts.length / pageSize) || 1);
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pageAccounts = useMemo(
    () => accounts.slice(pageStart, pageStart + pageSize),
    [accounts, pageStart, pageSize]
  );

  const allSelected = accounts.length > 0 && selected.size === accounts.length;
  const pageAllSelected =
    pageAccounts.length > 0 && pageAccounts.every((a) => selected.has(a.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 全选：所有分页中的全部账号 */
  const selectAll = () => {
    if (accounts.length === 0) return;
    setSelected(
      allSelected ? new Set() : new Set(accounts.map((a) => a.id))
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
    const lines = records.map((r) => r.sso).filter(Boolean);
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
    const text = records.map((r) => `${r.email}----${r.password}----${r.sso}`).join('\n');
    download(`grok-accounts-${stamp()}.txt`, text);
    push({ tone: 'ok', title: '已导出账号', description: `${records.length} 条` });
  };

  const applyResults = (results: SsoCheckResult[]) => {
    setSsoMap((prev) => {
      const next = new Map(prev);
      for (const r of results) next.set(r.id, r);
      return next;
    });
  };

  const verifyBatch = async () => {
    const targets = (selected.size > 0 ? accounts.filter((a) => selected.has(a.id)) : accounts).filter(
      (a) => a.sso
    );
    if (targets.length === 0) {
      push({ tone: 'warn', title: '没有可验活的账号' });
      return;
    }
    setVerifying(true);
    try {
      const results = await window.api.checkSso(targets.map((a) => ({ id: a.id, sso: a.sso })));
      applyResults(results);
      const alive = results.filter((r) => r.alive).length;
      push({ tone: 'ok', title: '验活完成', description: `存活 ${alive} / ${results.length}` });
    } catch (err) {
      push({ tone: 'danger', title: '批量验活失败', description: String(err) });
    } finally {
      setVerifying(false);
    }
  };

  const picked = accounts.filter((a) => selected.has(a.id));
  const openAccount = accounts.find((a) => a.id === openId) ?? null;
  const rangeFrom = accounts.length === 0 ? 0 : pageStart + 1;
  const rangeTo = Math.min(pageStart + pageSize, accounts.length);

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

      <div className="ios-group">
        <div className="flex flex-col gap-3 border-b border-border/70 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="page-kicker">号池</p>
            <h3 className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">账号列表</h3>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {selected.size > 0 ? `已选 ${selected.size} 项` : '未选择'}
              {lastRefresh ? ` · 刷新于 ${fmtBeijingTime(lastRefresh)}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={selectAll}
              disabled={accounts.length === 0}
              title="选择所有分页中的全部账号"
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
              disabled={pageAccounts.length === 0}
              title="仅选择当前页"
            >
              <ListChecks className="h-3.5 w-3.5" />
              {pageAllSelected ? '取消本页' : '本页'}
            </Button>
            <Button size="sm" onClick={() => void verifyBatch()} disabled={verifying || accounts.length === 0}>
              <ShieldCheck className={cn('h-3.5 w-3.5', verifying && 'animate-pulse')} />
              {verifying ? '验活中…' : selected.size > 0 ? `验活(${selected.size})` : '验活全部'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => exportSso(picked.length > 0 ? picked : accounts)}
              disabled={accounts.length === 0}
              title={picked.length > 0 ? '导出已选账号的 SSO' : '导出全部 SSO'}
            >
              <FileDown className="h-3.5 w-3.5" />
              导出SSO
              {picked.length > 0 ? `(${picked.filter((a) => a.sso).length})` : ''}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => exportAccounts(picked)}
              disabled={picked.length === 0}
            >
              <FileDown className="h-3.5 w-3.5" />
              选中账号
            </Button>
            <Button size="sm" onClick={() => exportAccounts(accounts)} disabled={accounts.length === 0}>
              <FileDown className="h-3.5 w-3.5" />
              全部账号
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void doReload(true)}
              disabled={loading}
              title="重新扫描 /data/sso 历史文件并刷新列表"
            >
              <RefreshCcw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-12 text-center text-[13px] text-muted-foreground">
          还没有账号。到「注册机」跑一轮任务即可出现在这里。
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
            total={accounts.length}
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
    </div>
  );
}

function PaginationBar({
  page,
  totalPages,
  rangeFrom,
  rangeTo,
  total,
  pageSize,
  onChange,
  onPageSizeChange
}: {
  page: number;
  totalPages: number;
  rangeFrom: number;
  rangeTo: number;
  total: number;
  pageSize: PageSize;
  onChange(page: number): void;
  onPageSizeChange(size: PageSize): void;
}) {
  return (
    <div className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
      <p className="text-[12px] text-muted-foreground">
        {total === 0
          ? '共 0 条'
          : `第 ${rangeFrom}–${rangeTo} 条 · 共 ${total} 条`}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className="shrink-0">每页</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value) as PageSize)}
            className="h-8 rounded-full border border-border bg-card px-2.5 text-[12px] font-medium text-foreground outline-none focus:border-primary"
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page <= 1 || totalPages <= 1}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          上一页
        </Button>
        <span className="min-w-[4.5rem] text-center text-[13px] font-medium tabular-nums">
          {page} / {totalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages || totalPages <= 1}
        >
          下一页
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function AccountCard({
  account,
  checked,
  ssoResult,
  onToggle,
  onOpen
}: {
  account: AccountRecord;
  checked: boolean;
  ssoResult?: SsoCheckResult;
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

  return (
    <div
      onClick={onOpen}
      className={cn(
        'flex cursor-pointer flex-col gap-3 rounded-[16px] border bg-card p-4 shadow-[var(--ios-shadow)] transition-colors hover:border-primary/40',
        checked ? 'border-primary/60 bg-primary/5' : 'border-border'
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          onClick={stop}
          className="mt-1 h-4 w-4 shrink-0 accent-[hsl(var(--primary))]"
        />
        <div className="min-w-0 flex-1">
          <div className="break-all text-sm font-semibold leading-5 tracking-tight">
            {account.email || '(无邮箱)'}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {fmtBeijing(account.createdAt)}
          </div>
        </div>
        <SsoBadge result={ssoResult} />
      </div>

      <div className="rounded-[12px] bg-muted/60 px-3 py-2" onClick={stop}>
        <div className="flex items-center justify-between gap-2">
          <span className="field-label">密码</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              title={showPw ? '隐藏' : '显示'}
            >
              {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => void copy(account.password, '密码')}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              title="复制"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="mt-1 break-all text-xs tabular-nums">
          {showPw ? account.password || '(无)' : '••••••••••'}
        </div>
      </div>

      <div className="rounded-[12px] bg-muted/60 px-3 py-2" onClick={stop}>
        <div className="flex items-center justify-between gap-2">
          <span className="field-label">SSO</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowSso((v) => !v)}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              title={showSso ? '收起' : '查看'}
            >
              {showSso ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => void copy(account.sso, 'SSO')}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
              title="复制"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div
          className={cn(
            'mt-1 text-xs',
            showSso ? 'break-all' : 'truncate text-muted-foreground'
          )}
        >
          {account.sso || '(无)'}
        </div>
      </div>
    </div>
  );
}

function SsoBadge({ result }: { result?: SsoCheckResult }) {
  if (!result) {
    return <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30" title="未验活" />;
  }
  return (
    <span
      className={cn(
        'mt-1 h-2.5 w-2.5 shrink-0 rounded-full',
        result.alive ? 'bg-ok' : 'bg-danger'
      )}
      title={result.alive ? '存活' : '已失效'}
    />
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
    <div className="metric-panel">
      <div className="flex items-center justify-between gap-3">
        <div className="metric-kicker">{label}</div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="metric-value">{value}</div>
    </div>
  );
}
