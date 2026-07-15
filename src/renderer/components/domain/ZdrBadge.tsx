import { cn } from '@renderer/lib/cn';

/** ZDR：关=已关闭 / 开=仍开或失败 / 灰=未尝试 */
export function ZdrBadge({
  status,
  error,
  className
}: {
  status?: 'closed' | 'open' | 'none' | null;
  error?: string | null;
  className?: string;
}) {
  const s = status || 'none';
  if (s === 'closed') {
    return (
      <span
        title="ZDR 已关闭（probe 非 Zero Retention）"
        className={cn(
          'inline-flex items-center rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400',
          className
        )}
      >
        ZDR关
      </span>
    );
  }
  if (s === 'open') {
    return (
      <span
        title={error ? `ZDR 仍开: ${error}` : 'ZDR 未关闭或探测仍为开（不影响授权）'}
        className={cn(
          'inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400',
          className
        )}
      >
        ZDR开
      </span>
    );
  }
  return (
    <span
      title="未尝试关闭 ZDR"
      className={cn('inline-flex items-center text-[10px] text-muted-foreground', className)}
    >
      —
    </span>
  );
}
