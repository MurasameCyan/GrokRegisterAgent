import { cn } from '@renderer/lib/cn';

/**
 * BFS tag：access/id/sso JWT payload 里存在 `bfs` key。
 *
 * 重要：`bfs` **不是风险信号**，红色告警语义是错的，故此徽章为中性信息标记。
 * 全量实测显示该 claim 只在一段短上游窗口内签发，窗口内近乎全量覆盖且取值恒定，
 * 窗口前后均为 0；命中组测活存活率不低于未命中组。即它标识「注册于该窗口」，
 * 与账号质量无关，不得据此丢号或降级。
 *
 * 仅 flagged 显示中性徽章；clean / unknown 不显示。
 */
export function BfsBadge({
  status,
  value,
  source,
  className
}: {
  status?: 'flagged' | 'clean' | 'unknown' | null;
  /** claim 原值（常见 2），tooltip 展示 */
  value?: number | string | null;
  /** 判定依据 token：access_token / id_token / sso */
  source?: string | null;
  className?: string;
}) {
  if (status !== 'flagged') return null;

  const tip =
    `BFS 标记（payload 含 bfs key${source ? ` · ${source}` : ''}）` +
    (value != null && value !== '' ? ` · 值 ${value}` : '') +
    '；非风险信号：仅特定上游窗口内签发的 token 带此 claim，' +
    '该批号测活存活率不低于未命中组';

  return (
    <span
      title={tip}
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full bg-slate-500/15 px-2 text-[10px] font-medium leading-none text-slate-600 dark:text-slate-300',
        className
      )}
    >
      BFS
    </span>
  );
}
