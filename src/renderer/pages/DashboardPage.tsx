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
    <div className="space-y-6">
      <section className="hero-panel">
        <div className="space-y-3">
          <div className="shell-label">dashboard</div>
          <h3 className="font-display text-[clamp(1.8rem,4vw,3.5rem)] font-semibold tracking-[-0.04em]">
            {username}，{greeting(now)}
          </h3>
          <p className="max-w-3xl text-sm leading-7 text-muted-foreground">
            {nowBeijing()}（北京时间）
          </p>
          <VersionBadge update={update} loading={updateLoading} onCheck={() => void loadUpdate()} />
        </div>
        <div className="hero-stamp">
          <Clock3 className="h-5 w-5" />
          <span>{now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </section>

      <section className="terminal-grid">
        {metrics.map(({ label, value, note, Icon }) => (
          <div key={label} className="metric-panel">
            <div className="flex items-center justify-between gap-3">
              <div className="metric-kicker">{label}</div>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="metric-value">{value}</div>
            <div className="metric-note">{note}</div>
          </div>
        ))}
      </section>

      <div className="pane-grid">
        <section className="terminal-card">
          <div className="terminal-card-header">
            <h3 className="text-base font-semibold">系统体检</h3>
            <Button variant="secondary" size="sm" onClick={() => void loadHealth()} disabled={healthLoading}>
              <RefreshCcw className="h-3.5 w-3.5" />
              重新检查
            </Button>
          </div>
          <div className="terminal-card-body space-y-3">
            {!health ? (
              <div className="rounded-2xl border border-border bg-muted/45 p-5 text-sm text-muted-foreground">
                正在读取体检结果…
              </div>
            ) : (
              health.checks.map((check) => <HealthRow key={check.id} check={check} />)
            )}
          </div>
        </section>

        <section className="terminal-card">
          <div className="terminal-card-header">
            <h3 className="text-base font-semibold">最近号池</h3>
            <div className="shell-chip">{accounts.length} 账号</div>
          </div>
          <div className="terminal-card-body space-y-4">
            <InfoLine label="邮箱后端" value={settings?.mail.apiBase || '未配置'} />
            <InfoLine label="代理配置" value={settings?.proxy || '直接连接'} />
            <InfoLine label="最近账号" value={latest?.email || '暂无记录'} />
            <InfoLine
              label="最近时间"
              value={latest ? fmtBeijing(latest.createdAt) : '等待首次运行'}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function HealthRow({ check }: { check: SystemHealthCheck }) {
  const tone = {
    ok: 'status-pill-ok',
    warn: 'status-pill-warn',
    error: 'status-pill-danger'
  }[check.level];
  const Icon = check.level === 'ok' ? CheckCircle2 : AlertTriangle;

  return (
    <div className="rounded-2xl border border-border bg-card/80 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('status-pill', tone)}>
              <Icon className="h-3.5 w-3.5" />
              {check.level}
            </span>
            <span className="font-semibold">{check.label}</span>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{check.message}</p>
        </div>
        {check.detail && (
          <div className="max-w-full break-all rounded-xl border border-border bg-muted/45 px-3 py-2 font-mono text-[11px] text-muted-foreground md:max-w-[48%]">
            {check.detail}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-muted/45 p-4">
      <div className="field-label">{label}</div>
      <div className="mt-2 break-all font-mono text-sm">{value}</div>
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
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <span className="shell-chip">
        v{current ?? '...'}
      </span>
      {hasUpdate ? (
        <a
          href={update?.htmlUrl ?? '#'}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-3 py-1 text-xs font-semibold text-danger transition-colors hover:bg-danger/15"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-danger" />
          </span>
          <ArrowUpCircle className="h-3.5 w-3.5" />
          有新版本 {update?.latest}
        </a>
      ) : (
        <button
          type="button"
          onClick={onCheck}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card/80 px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <RefreshCcw className={cn('h-3 w-3', loading && 'animate-spin')} />
          {loading
            ? '检查中…'
            : update?.error
              ? update.error
              : update
                ? '已是最新'
                : '检查更新'}
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
