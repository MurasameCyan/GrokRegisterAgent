import { useEffect, useMemo, useState } from 'react';
import { ArrowUpCircle, Clock3, Database, HeartPulse, RefreshCcw } from 'lucide-react';
import { useAccountsStore } from '@renderer/store/accountsStore';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useRunStore } from '@renderer/store/runStore';
import { cn } from '@renderer/lib/cn';
import { fmtBeijing, nowBeijing } from '@renderer/lib/time';
import type { UpdateInfo } from '@shared/ipc';

export function DashboardPage({ username }: { username: string }) {
  const accounts = useAccountsStore((s) => s.accounts);
  const reloadAccounts = useAccountsStore((s) => s.reload);
  const settings = useSettingsStore((s) => s.data);
  const status = useRunStore((s) => s.status);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);

  const loadUpdate = async () => {
    setUpdateLoading(true);
    try {
      setUpdate(await window.api.checkUpdate());
    } finally {
      setUpdateLoading(false);
    }
  };

  useEffect(() => {
    void reloadAccounts();
    void loadUpdate();
  }, [reloadAccounts]);

  const ssoCount = useMemo(() => accounts.filter((a) => a.sso).length, [accounts]);
  const latest = accounts[0];
  const now = new Date();
  const timeLabel = now.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });

  return (
    <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
      {/* 左：精简概览 */}
      <section className="welcome-card space-y-4 !p-4 sm:!p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="page-kicker">概览</p>
            <h2 className="mt-0.5 text-[22px] font-bold tracking-[-0.03em] sm:text-[24px]">
              {username}，{greeting(now)}
            </h2>
            <p className="mt-1 text-[12px] text-muted-foreground">{nowBeijing()} · 北京时间</p>
          </div>
          <span className="chip shrink-0">
            <Clock3 className="h-3.5 w-3.5" />
            {timeLabel}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <MiniStat
            label="账号"
            value={String(accounts.length)}
            note={`SSO ${ssoCount}`}
            Icon={Database}
          />
          <MiniStat
            label="任务"
            value={status.phase}
            note={status.runId ? status.runId.slice(0, 8) : '空闲'}
            Icon={HeartPulse}
          />
        </div>

        <VersionBadge update={update} loading={updateLoading} onCheck={() => void loadUpdate()} />
      </section>

      {/* 右：号池最近 */}
      <section className="ios-group">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <div>
            <p className="page-kicker">号池</p>
            <h3 className="mt-0.5 text-[16px] font-semibold tracking-[-0.02em]">最近</h3>
          </div>
          <span className="chip">{accounts.length} 账号</span>
        </div>
        <div className="divide-y divide-border/70">
          <InfoRow label="邮箱后端" value={settings?.mail.apiBase || '未配置'} />
          <InfoRow label="代理" value={settings?.proxy || '直接连接'} />
          <InfoRow label="最近账号" value={latest?.email || '暂无记录'} />
          <InfoRow label="最近时间" value={latest ? fmtBeijing(latest.createdAt) : '等待首次运行'} />
        </div>
      </section>
    </div>
  );
}

function MiniStat({
  label,
  value,
  note,
  Icon
}: {
  label: string;
  value: string;
  note: string;
  Icon: typeof Database;
}) {
  return (
    <div className="rounded-xl bg-muted/70 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
        <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      </div>
      <div className="mt-1 truncate text-[18px] font-bold tabular-nums tracking-[-0.02em]">{value}</div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{note}</div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="shrink-0 text-[13px] text-foreground">{label}</span>
      <span className="ml-auto max-w-[65%] truncate text-right text-[13px] text-muted-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

function VersionBadge({
  update,
  loading,
  onCheck
}: {
  update: UpdateInfo | null;
  loading: boolean;
  onCheck(): void;
}) {
  const current = update?.current;
  const hasUpdate = !!update?.hasUpdate;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="chip">v{current ?? '…'}</span>
      {hasUpdate ? (
        <a
          href={update?.htmlUrl ?? '#'}
          target="_blank"
          rel="noreferrer"
          className="pill pill-danger"
        >
          <ArrowUpCircle className="h-3.5 w-3.5" />
          有新版本 {update?.latest}
        </a>
      ) : (
        <button type="button" onClick={onCheck} disabled={loading} className="chip hover:text-foreground">
          <RefreshCcw className={cn('h-3 w-3', loading && 'animate-spin')} />
          {loading ? '检查中…' : update?.error ? update.error : update ? '已是最新' : '检查更新'}
        </button>
      )}
    </div>
  );
}

function greeting(date: Date) {
  const hour = date.getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}
