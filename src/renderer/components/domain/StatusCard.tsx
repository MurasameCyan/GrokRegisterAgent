import { Activity, AlertCircle, CheckCircle2, Loader2, Pause } from 'lucide-react';
import type { RunStatus } from '@shared/runEvents';
import { cn } from '@renderer/lib/cn';

export function StatusCard({ status }: { status: RunStatus }) {
  const tone = phaseTone(status.phase);
  return (
    <div
      className={cn(
        'rounded-[1.2rem] border px-5 py-4 transition-colors',
        tone.border,
        tone.bg
      )}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <div
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-full',
              tone.iconBg
            )}
          >
            <tone.Icon
              className={cn('h-5 w-5', tone.iconColor, status.phase === 'running' && 'animate-spin')}
            />
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="field-label">{tone.kicker}</span>
              <span className={cn('status-pill', tone.pill)}>{tone.label}</span>
              {status.pid && <span className="shell-chip">pid {status.pid}</span>}
            </div>
            <p className="mt-3 text-base font-semibold tracking-tight">{summary(status)}</p>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">
              {status.startedAt
                ? `started ${new Date(status.startedAt).toLocaleString('zh-CN')}`
                : 'waiting for launch'}
            </p>
          </div>
        </div>

        <div className="grid min-w-[220px] grid-cols-2 gap-3">
          <DataCell label="current" value={String(status.current)} />
          <DataCell label="total" value={String(status.total)} />
          <DataCell label="success" value={String(status.success)} />
          <DataCell label="failed" value={String(status.failed)} />
        </div>
      </div>
    </div>
  );
}

function DataCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/80 bg-card/70 px-3 py-2">
      <div className="field-label">{label}</div>
      <div className="mt-2 font-mono text-sm">{value}</div>
    </div>
  );
}

function summary(s: RunStatus): string {
  switch (s.phase) {
    case 'idle':
      return '待命，可以开始注册。';
    case 'starting':
      return '正在启动 Python 子进程…';
    case 'running': {
      const cur = Math.max(s.current, 1);
      return `正在运行第 ${cur}/${s.total} 轮`;
    }
    case 'done':
      return '完成。SSO 结果已写入本地号池。';
    case 'killed':
      return '已停止。';
    case 'error':
      return s.errorMessage ?? '运行出错。';
  }
}

function phaseTone(phase: RunStatus['phase']) {
  switch (phase) {
    case 'idle':
      return {
        kicker: 'run state',
        label: '待命',
        pill: 'status-pill-idle',
        Icon: Pause,
        bg: 'bg-card',
        border: 'border-border',
        iconBg: 'bg-muted',
        iconColor: 'text-muted-foreground'
      };
    case 'starting':
    case 'running':
      return {
        kicker: 'run state',
        label: phase === 'starting' ? '启动中' : '运行中',
        pill: 'status-pill-warn',
        Icon: Loader2,
        bg: 'bg-warn/5',
        border: 'border-warn/30',
        iconBg: 'bg-warn/10',
        iconColor: 'text-warn'
      };
    case 'done':
      return {
        kicker: 'run state',
        label: '已完成',
        pill: 'status-pill-ok',
        Icon: CheckCircle2,
        bg: 'bg-ok/5',
        border: 'border-ok/30',
        iconBg: 'bg-ok/10',
        iconColor: 'text-ok'
      };
    case 'killed':
      return {
        kicker: 'run state',
        label: '已停止',
        pill: 'status-pill-idle',
        Icon: Activity,
        bg: 'bg-card',
        border: 'border-border',
        iconBg: 'bg-muted',
        iconColor: 'text-muted-foreground'
      };
    case 'error':
      return {
        kicker: 'run state',
        label: '已出错',
        pill: 'status-pill-danger',
        Icon: AlertCircle,
        bg: 'bg-danger/5',
        border: 'border-danger/30',
        iconBg: 'bg-danger/10',
        iconColor: 'text-danger'
      };
  }
}
