import { cn } from '@renderer/lib/cn';

/** NSFW 开启结果 tag：绿=已开 / 黄=尝试失败 / 灰=未尝试 */
export function NsfwBadge({
  status,
  error,
  className
}: {
  status?: 'ok' | 'fail' | 'none' | null;
  error?: string | null;
  className?: string;
}) {
  const s = status || 'none';
  if (s === 'ok') {
    return (
      <span
        title="NSFW 已开启 (always_show_nsfw_content)"
        className={cn(
          'inline-flex items-center rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400',
          className
        )}
      >
        NSFW
      </span>
    );
  }
  if (s === 'fail') {
    return (
      <span
        title={error ? `NSFW 未开启: ${error}` : 'NSFW 尝试开启失败（不影响授权）'}
        className={cn(
          'inline-flex items-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400',
          className
        )}
      >
        NSFW×
      </span>
    );
  }
  return (
    <span
      title="未尝试开启 NSFW"
      className={cn(
        'inline-flex items-center text-[10px] text-muted-foreground',
        className
      )}
    >
      —
    </span>
  );
}
