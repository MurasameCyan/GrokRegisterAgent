import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Database,
  Eye,
  EyeOff,
  FileDown,
  KeyRound,
  RefreshCcw,
  ShieldCheck
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
  const phase = useRunStore((s) => s.status.phase);
  const push = useToastStore((s) => s.push);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ssoMap, setSsoMap] = useState<Map<string, SsoCheckResult>>(new Map());
  const [verifying, setVerifying] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const doReload = async () => {
    await reload();
    setLastRefresh(new Date().toISOString());
  };

  useEffect(() => {
    void doReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  useEffect(() => {
    if (phase === 'done') void doReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const ssoCount = useMemo(() => accounts.filter((a) => a.sso).length, [accounts]);
  const aliveCount = useMemo(
    () => [...ssoMap.values()].filter((r) => r.alive).length,
    [ssoMap]
  );
  const allSelected = accounts.length > 0 && selected.size === accounts.length;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setSelected((prev) => (prev.size === accounts.length ? new Set() : new Set(accounts.map((a) => a.id))));

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
            {lastRefresh && (
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                刷新于 {fmtBeijingTime(lastRefresh)}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={toggleAll} disabled={accounts.length === 0}>
              {allSelected ? '取消全选' : '全选'}
            </Button>
            <Button size="sm" onClick={() => void verifyBatch()} disabled={verifying || accounts.length === 0}>
              <ShieldCheck className={cn('h-3.5 w-3.5', verifying && 'animate-pulse')} />
              {verifying ? '验活中…' : selected.size > 0 ? `验活(${selected.size})` : '验活全部'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => exportSso(picked)}
              disabled={picked.length === 0}
            >
              <FileDown className="h-3.5 w-3.5" />
              选中 SSO
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
            <Button size="sm" onClick={() => exportSso(accounts)} disabled={accounts.length === 0}>
              <FileDown className="h-3.5 w-3.5" />
              全部 SSO
            </Button>
            <Button size="sm" onClick={() => exportAccounts(accounts)} disabled={accounts.length === 0}>
              <FileDown className="h-3.5 w-3.5" />
              全部账号
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void doReload()} disabled={loading}>
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
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a) => (
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

  // 阻止卡片内交互控件冒泡到卡片点击
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
