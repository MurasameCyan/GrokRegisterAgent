import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Clock3,
  Database,
  HeartPulse,
  RefreshCcw,
  ServerCog
} from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { useAccountsStore } from '@renderer/store/accountsStore';
import { useSettingsStore } from '@renderer/store/settingsStore';
import { useRunStore } from '@renderer/store/runStore';
import { cn } from '@renderer/lib/cn';
import { fmtBeijing, nowBeijing } from '@renderer/lib/time';
import type { SystemHealth, SystemHealthCheck, UpdateInfo } from '@shared/ipc';

export function DashboardPage({ username }: { username: string }) {
  const accounts = useAccountsStore((s) => s.accounts);
  const reloadAccounts = useAccountsStore((s) => s.reload);
  const settings = useSettingsStore((s) => s.data);
  const status = useRunStore((s) => s.status);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateLoading, setUpdateLoading] = useState(false);

  const loadHealth = async () => {
    setHealthLoading(true);
    try {
      setHealth(await window.api.getSystemHealth());
    } finally {
      setHealthLoading(false);
    }
  };

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
    void loadHealth();
    void loadUpdate();
  }, [reloadAccounts]);

  const ssoCount = useMemo(() => accounts.filter((a) => a.sso).length, [accounts]);
  const latest = accounts[0];
  const now = new Date();

  const metrics = [
    {
      label: '账号总量',
      value: String(accounts.length),
      note: `含 SSO ${ssoCount} 个`,
      Icon: Database
    },
    {
      label: '当前任务',
      value: status.phase,
      note: status.runId ? `run ${status.runId.slice(0, 8)}` : '暂无运行任务',
      Icon: HeartPulse
    },
    {
      label: '系统体检',
      value: health ? `${health.summary.ok}/${health.summary.total}` : '--',
      note: health?.summary.error ? `${health.summary.error} 项需要处理` : '依赖与配置检查',
      Icon: ServerCog
    }
  ];

  return (
    <div className="space-y-5">
      <section className="welcome-card">
        <div className="pr-20">
          <p className="page-kicker">概览</p>
          <h2 className="mt-1 text-[26px] font-bold tracking-[-0.03em] sm:text-[30px]">
            {username}，{greeting(now)}
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">{nowBeijing()} · 北京时间</p>
          <div className="mt-3">
            <VersionBadge update={update} loading={updateLoading} onCheck={() => void loadUpdate()} />
          </div>
        </div>
        <div className="hero-stamp">
          <Clock3 className="h-3.5 w-3.5" />
          <span>
            {now.toLocaleTimeString('zh-CN', {
              timeZone: 'Asia/Shanghai',
              hour12: false,
              hour: '2-digit',
              minute: '2-digit'
            })}
          </span>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {metrics.map(({ label, value, note, Icon }) => (
          <div key={label} className="stat-card">
            <div className="flex items-center justify-between gap-2">
              <span className="stat-label">{label}</span>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="stat-value">{value}</div>
            <div className="stat-note">{note}</div>
          </div>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="ios-group">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5">
            <div>
              <p className="page-kicker">系统</p>
              <h3 className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">体检</h3>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void loadHealth()} disabled={healthLoading}>
              <RefreshCcw className={cn('h-3.5 w-3.5', healthLoading && 'animate-spin')} />
              检查
            </Button>
          </div>
          <div className="space-y-0 p-2">
            {!health ? (
              <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">正在读取…</div>
            ) : (
              health.checks.map((check) => <HealthRow key={check.id} check={check} />)
            )}
          </div>
        </section>

        <section className="ios-group">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3.5">
            <div>
              <p className="page-kicker">号池</p>
              <h3 className="mt-0.5 text-[17px] font-semibold tracking-[-0.02em]">最近</h3>
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
    </div>
  );
}

function HealthRow({ check }: { check: SystemHealthCheck }) {
  const tone = {
    ok: 'pill-ok',
    warn: 'pill-warn',
    error: 'pill-danger'
  }[check.level];
  const Icon = check.level === 'ok' ? CheckCircle2 : AlertTriangle;

  return (
    <div className="rounded-xl px-3 py-3 hover:bg-muted/50">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('pill', tone)}>
          <Icon className="h-3.5 w-3.5" />
          {check.level}
        </span>
        <span className="text-[15px] font-semibold tracking-[-0.01em]">{check.label}</span>
      </div>
      <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground">{check.message}</p>
      {check.detail && (
        <p className="mt-1.5 break-all rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
          {check.detail}
        </p>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="ios-row">
      <span className="ios-row-label">{label}</span>
      <span className="ios-row-value max-w-[60%] truncate text-right" title={value}>
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
  if (hour < 6) return '夜深了，注意休息';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}
