import { cn } from '@renderer/lib/cn';

/**
 * 实时进度条：宽度过渡 + 运行中流光/呼吸动画。
 */
export function LiveProgressBar({
  value,
  active = false,
  className,
  trackClassName,
  barClassName,
  height = 'md',
  /** 显示右侧百分比文案时用外层自行排版；此处仅 bar */
  tone = 'primary'
}: {
  /** 0–100 */
  value: number;
  /** 运行中：流光 + 轻微呼吸 */
  active?: boolean;
  className?: string;
  trackClassName?: string;
  barClassName?: string;
  height?: 'sm' | 'md' | 'lg';
  tone?: 'primary' | 'ok' | 'warn' | 'danger';
}) {
  const pct = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const h =
    height === 'sm' ? 'h-1' : height === 'lg' ? 'h-2.5' : 'h-1.5';

  const fill =
    tone === 'ok'
      ? 'bg-emerald-500'
      : tone === 'warn'
        ? 'bg-amber-500'
        : tone === 'danger'
          ? 'bg-destructive'
          : 'bg-primary';

  return (
    <div
      className={cn(
        'relative w-full overflow-hidden rounded-full bg-muted/80',
        h,
        trackClassName,
        className
      )}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {/* 主进度：仅运行中做宽度过渡，避免已完成任务挂载时 0→终值「重播」动画 */}
      <div
        className={cn(
          'relative h-full rounded-full',
          active && 'transition-[width] duration-500 ease-out',
          fill,
          active && pct > 0 && pct < 100 && 'live-progress-breathe',
          barClassName
        )}
        style={{ width: `${pct}%` }}
      >
        {/* 运行中：条内流光 */}
        {active && pct > 0 && pct < 100 && (
          <span className="live-progress-sheen pointer-events-none absolute inset-0 rounded-full" />
        )}
      </div>

      {/* 运行中且未完成：轨道上微弱 indeterminate 脉冲（本轮进行中） */}
      {active && pct < 100 && (
        <span className="live-progress-pulse pointer-events-none absolute inset-y-0 left-0 w-full rounded-full" />
      )}
    </div>
  );
}

/** 由 success/failed/current/total 计算更“跟手”的百分比 */
export function liveProgressPercent(opts: {
  success: number;
  failed?: number;
  current?: number;
  total: number;
}): number {
  const total = Math.max(0, Number(opts.total) || 0);
  if (total <= 0) return 0;
  const success = Math.max(0, Number(opts.success) || 0);
  const failed = Math.max(0, Number(opts.failed) || 0);
  const current = Math.max(0, Number(opts.current) || 0);
  const finished = success + failed;
  // 已完成轮 + 当前进行轮的半步（避免整轮结束才跳一截）
  const mid = current > finished ? 0.45 : 0;
  const units = Math.min(total, finished + mid);
  return Math.min(100, Math.round((units / total) * 100));
}
