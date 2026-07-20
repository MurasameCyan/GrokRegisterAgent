import { cn } from '@renderer/lib/cn';

export type BotFlagBadgeProps = {
  flag?: number | string | null;
  /** 服务端/解码给出的 isBotFlag1；可省略，组件会再根据 flag 判断 */
  is1?: boolean;
  /**
   * 保留兼容旧调用；非 Bot 时一律不显示 tag。
   * @deprecated ignored
   */
  missing?: 'dash' | 'muted';
  className?: string;
};

function isFlag1(flag: number | string | null | undefined, is1?: boolean): boolean {
  if (is1 === true) return true;
  if (flag === 1 || flag === '1') return true;
  if (typeof flag === 'string' && flag.trim() === '1') return true;
  if (typeof flag === 'number' && Number.isFinite(flag) && flag === 1) return true;
  return false;
}

const pillBase =
  'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[10px] font-medium leading-none';

/**
 * bot_flag_source 展示：
 * - 1 / isBot → 黄 Bot
 * - 0（None）/ 其它 / 未检测 → 不显示
 */
export function BotFlagBadge({ flag, is1, className }: BotFlagBadgeProps) {
  if (!isFlag1(flag, is1)) return null;

  return (
    <span
      className={cn(
        pillBase,
        'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        className
      )}
      title="bot_flag_source=1（Bot，JWT 内签发，无法抹掉）"
    >
      Bot
    </span>
  );
}
