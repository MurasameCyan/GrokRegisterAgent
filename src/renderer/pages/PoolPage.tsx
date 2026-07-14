import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckSquare,
  ChevronLeft,
  ChevronRight,
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
import { AccountDetailDrawer } from '@renderer/components/domain/AccountDetailDrawer';
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
import { fmtBeijing, fmtBeijingTime } from '@renderer/lib/time';
import type { AccountRecord } from '@shared/runEvents';
import type { CpaAuthBatchResultItem, SsoCheckResult } from '@shared/ipc';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 500, 1000, 2000] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
const DEFAULT_PAGE_SIZE: PageSize = 20;
const PAGE_SIZE_KEY = 'gra-pool-page-size';
const MINT_CHUNK = 5;

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
  const phase = useRunStore((s) => s.status.phase);
  const push = useToastStore((s) => s.push);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ssoMap, setSsoMap] = useState<Map<string, SsoCheckResult>>(new Map());
  const [verifying, setVerifying] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState('');
  const [importSource, setImportSource] = useState('paste');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(() => loadPageSize());
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
        description: `新增 ${r.imported} · 跳过 ${r.skipped} · 无效 ${r.invalid} · 号池 ${r.remaining}`
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
    setSelected(allSelected ? new Set() : new Set(accounts.map((a) => a.id)));
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

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) {
      push({ tone: 'warn', title: '请先勾选要删除的账号' });
      return;
    }
    if (!window.confirm(`确认从号池删除 ${ids.length} 个账号？\n（仅删号池记录，不删 SSO 历史文件）`)) {
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
    const targets = (selected.size > 0 ? accounts.filter((a) => selected.has(a.id)) : accounts).filter(
      (a) => a.sso
    );
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
      const parts = [
        `成功 ${ok}`,
        `失败 ${failed}`,
        skipped ? `预检跳过 ${skipped}` : '',
        botFlagN ? `bot_flag=1 跳过 ${botFlagN}` : '',
        banned ? `封禁 ${banned}` : '',
        probeOk ? `CPA测活OK ${probeOk}` : '',
        probeDead ? `CPA测活挂 ${probeDead}` : '',
        noXai ? `无 xai ${noXai}` : ok > 0 ? '均含 xai' : ''
      ].filter(Boolean);
      push({
        tone: failed > 0 || banned > 0 || probeDead > 0 ? 'warn' : ok > 0 ? 'ok' : 'warn',
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
  const rangeFrom = accounts.length === 0 ? 0 : pageStart + 1;
  const rangeTo = Math.min(pageStart + pageSize, accounts.length);
  const minting = !!mintProg?.running;
  const busy = verifying || minting || deleting || importing;

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
              disabled={accounts.length === 0 || busy}
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
              disabled={pageAccounts.length === 0 || busy}
              title="仅选择当前页"
            >
              <ListChecks className="h-3.5 w-3.5" />
              {pageAllSelected ? '取消本页' : '本页'}
            </Button>
            <Button size="sm" onClick={() => void verifyBatch()} disabled={busy || accounts.length === 0}>
              <ShieldCheck className={cn('h-3.5 w-3.5', verifying && 'animate-pulse')} />
              {verifying ? '验活中…' : selected.size > 0 ? `验活(${selected.size})` : '验活全部'}
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
                  ? '补 Auth 将跳过 bot_flag_source=1（点击改为不跳过）'
                  : '补 Auth 不跳过 bot_flag=1（点击改为跳过）'
              }
            >
              {skipBotFlag1 ? '跳过flag1:开' : '跳过flag1:关'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void mintAuthFromSso()}
              disabled={busy || accounts.length === 0}
              title={
                skipBotFlag1
                  ? '预检存活 + 跳过 bot_flag_source=1 后 mint'
                  : '预检存活后 mint（含 bot_flag=1）'
              }
            >
              <Wand2 className={cn('h-3.5 w-3.5', minting && 'animate-pulse')} />
              {minting
                ? `Mint ${mintProg?.done ?? 0}/${mintProg?.total ?? 0}`
                : selected.size > 0
                  ? `补 Auth(${picked.filter((a) => a.sso).length})`
                  : '补 Auth'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void deleteSelected()}
              disabled={busy || selected.size === 0}
              title="从号池删除已选账号"
            >
              <Trash2 className={cn('h-3.5 w-3.5', deleting && 'animate-pulse')} />
              {deleting ? '删除中…' : `删除(${selected.size})`}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setImportOpen(true)}
              disabled={busy}
              title="粘贴或上传 SSO 文本导入号池"
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
              onClick={() => exportSso(picked.length > 0 ? picked : accounts)}
              disabled={accounts.length === 0 || busy}
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
              disabled={picked.length === 0 || busy}
            >
              <FileDown className="h-3.5 w-3.5" />
              选中账号
            </Button>
            <Button
              size="sm"
              onClick={() => exportAccounts(accounts)}
              disabled={accounts.length === 0 || busy}
            >
              <FileDown className="h-3.5 w-3.5" />
              全部账号
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void doReload(true)}
              disabled={loading || busy}
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
                emailMasked={emailMasked}
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
        {total === 0 ? '共 0 条' : `第 ${rangeFrom}–${rangeTo} 条 · 共 ${total} 条`}
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
  emailMasked,
  onToggle,
  onOpen
}: {
  account: AccountRecord;
  checked: boolean;
  ssoResult?: SsoCheckResult;
  emailMasked: boolean;
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
  // 优先验活结果；否则本地解码 SSO JWT（无需点验活）
  const localFlag = readBotFlagFromSso(account.sso);
  const flagSource =
    ssoResult?.botFlagSource !== undefined && ssoResult?.botFlagSource !== null
      ? ssoResult.botFlagSource
      : localFlag.botFlagSource;
  const flagIs1 =
    ssoResult?.isBotFlag1 !== undefined ? ssoResult.isBotFlag1 : localFlag.isBotFlag1;

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
          <div
            className="break-all text-sm font-semibold leading-5 tracking-tight"
            title={emailMasked && account.email ? '已遮蔽 · 点工具栏「显示邮箱」查看完整' : account.email || undefined}
          >
            {emailDisplay}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{fmtBeijing(account.createdAt)}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <SsoBadge result={ssoResult} />
          <BotFlagBadge flag={flagSource} is1={flagIs1} />
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

function SsoBadge({ result }: { result?: SsoCheckResult }) {
  if (!result) {
    return (
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
        未验
      </span>
    );
  }
  if (result.alive) {
    return (
      <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
        存活
      </span>
    );
  }
  return (
    <span
      className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive"
      title={result.error || ''}
    >
      失效
    </span>
  );
}

function BotFlagBadge({
  flag,
  is1
}: {
  flag?: number | string | null;
  is1?: boolean;
}) {
  if (flag === undefined || flag === null) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" title="未解码或无 claim">
        flag—
      </span>
    );
  }
  if (is1 || flag === 1 || flag === '1') {
    return (
      <span
        className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive"
        title="bot_flag_source=1（服务端签发，无法抹掉）"
      >
        flag1
      </span>
    );
  }
  return (
    <span
      className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
      title={`bot_flag_source=${String(flag)}`}
    >
      flag{String(flag)}
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
