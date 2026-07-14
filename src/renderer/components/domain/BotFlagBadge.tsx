import { cn } from '@renderer/lib/cn';

export type BotFlagBadgeProps = {
  flag?: number | string | null;
  /** 服务端/解码给出的 isBotFlag1；可省略，组件会再根据 flag 判断 */
  is1?: boolean;
  /**
   * missing：无 claim 时
   * - dash：表格式「—」（Auth）
   * - muted：灰胶囊 flag—（SSO 卡）
   */
  missing?: 'dash' | 'muted';
  className?: string;
};

function isFlag1(flag: number | string | null | undefined, is1?: boolean): boolean {
  if (is1 === true) return true;
  if (flag === 1 || flag === '1') return true;
  if (typeof flag === 'string' && flag.trim() === '1') return true;
  if (typeof flag === 'number' && Number.isFinite(flag) && flag === 1) return true;
  // 避免把 "10" 当成 1
  if (flag !== '' && flag != null && Number(flag) === 1 && String(flag).trim() === '1') {
    return true;
  }
  return false;
}

function isFlag0(flag: number | string | null | undefined): boolean {
  if (flag === 0 || flag === '0') return true;
  if (typeof flag === 'string' && flag.trim() === '0') return true;
  return false;
}

const pillBase =
  'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium';

/**
 * bot_flag_source 展示：与 xai 绿胶囊同风格
 * - 1 → 黄 Bot
 * - 0 → 绿 None
 * - 其它已知值 → 绿胶囊 + 原值
 * - 缺失 → — 或 flag—
 */
export function BotFlagBadge({
  flag,
  is1,
  missing = 'dash',
  className
}: BotFlagBadgeProps) {
  if (flag === undefined || flag === null || flag === '') {
    if (missing === 'muted') {
      return (
        <span
          className={cn(pillBase, 'bg-muted text-muted-foreground', className)}
          title={
            'flag—：无法解析 bot_flag_source。' +
            '常见原因：无 SSO / 不是标准 JWT / JWT 无该 claim。' +
            '与「未验」（是否请求过 grok 验活）无关。'
          }
        >
          flag—
        </span>
      );
    }
    return (
      <span className={cn('text-[11px] text-muted-foreground', className)}>—</span>
    );
  }

  if (isFlag1(flag, is1)) {
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

  if (isFlag0(flag)) {
    return (
      <span
        className={cn(
          pillBase,
          'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
          className
        )}
        title="bot_flag_source=0（None）"
      >
        None
      </span>
    );
  }

  return (
    <span
      className={cn(
        pillBase,
        'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
        className
      )}
      title={`bot_flag_source=${String(flag)}`}
    >
      {String(flag)}
    </span>
  );
}
