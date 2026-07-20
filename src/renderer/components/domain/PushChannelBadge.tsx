import { cn } from '@renderer/lib/cn';

/** 仅在已成功推送时显示的通道 tag（CPA / S2A / G2A） */
export function PushChannelBadge({
  channel,
  pushed,
  at,
  className
}: {
  channel: 'CPA' | 'S2A' | 'G2A';
  pushed?: boolean | null;
  at?: string | null;
  className?: string;
}) {
  if (!pushed) return null;
  const title =
    channel === 'G2A'
      ? `已推送 grok2api${at ? ` · ${at}` : ''}`
      : channel === 'CPA'
        ? `已推送远程 CPA${at ? ` · ${at}` : ''}`
        : `已推送 sub2api (S2A)${at ? ` · ${at}` : ''}`;
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 items-center rounded-full bg-sky-500/15 px-2 text-[10px] font-medium leading-none text-sky-700 dark:text-sky-400',
        className
      )}
    >
      {channel}
    </span>
  );
}
