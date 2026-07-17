import { cn } from '@renderer/lib/cn';

/** NSFW 开启结果 tag：绿=已开 / 黄=尝试失败 / 灰胶囊=未尝试（始终可见） */
export function NsfwBadge({
  status,
  error,
  className
}: {
  status?: 'ok' | 'fail' | 'none' | boolean | null;
  error?: string | null;
  className?: string;
}) {
  // 兼容后端偶发传 boolean / 空串
  let s: 'ok' | 'fail' | 'none' = 'none';
  if (status === 'ok' || status === true) s = 'ok';
  else if (status === 'fail' || status === false) s = 'fail';
  else if (status === 'none' || status == null || status === '') s = 'none';
  else s = 'none';

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
      title="未尝试开启 NSFW（设置开启 NSFW 并完成 Auth 后会写 tag）"
      className={cn(
        'inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground',
        className
      )}
    >
      NSFW—
    </span>
  );
}
