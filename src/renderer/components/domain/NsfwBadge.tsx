import { cn } from '@renderer/lib/cn';

/** NSFW tag：仅成功开启时显示；失败 / 未尝试不显示 */
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

  if (s !== 'ok') return null;

  return (
    <span
      title={error ? `Nsfw 已开启 · ${error}` : 'Nsfw 已开启 (always_show_nsfw_content)'}
      className={cn(
        'inline-flex h-5 items-center rounded-full bg-emerald-500/15 px-2 text-[10px] font-medium leading-none text-emerald-600 dark:text-emerald-400',
        className
      )}
    >
      Nsfw
    </span>
  );
}
