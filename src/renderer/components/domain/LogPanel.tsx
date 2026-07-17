import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Trash2 } from 'lucide-react';
import { useRunStore } from '@renderer/store/runStore';
import { Button } from '@renderer/components/ui/Button';
import { cn } from '@renderer/lib/cn';

const colorByLevel = {
  /** 注册机常规 stdout（[*] 状态行等）保持蓝色 */
  info: 'text-info',
  warn: 'text-warn',
  error: 'text-danger',
  tip: 'text-tip',
  plain: 'text-foreground',
  stderr: 'text-danger'
} as const;

/** 汇总行：成功绿 / 失败红 / 共计蓝 */
const SUMMARY_RE =
  /^(.*?)(成功\s*[:：]\s*\d+)(.*?)(失败\s*[:：]\s*\d+)(.*?)(共计\s*[:：]\s*\d+)(.*)$/u;

/** [plan] 本轮启用Plan: A:on B:off C:on → 显示「本轮启用Plan: A B C」启绿禁红 */
const PLAN_LINE_RE =
  /^\[plan\]\s*本轮启用Plan:\s*A:(on|off)\s+B:(on|off)\s+C:(on|off)\s*$/u;

function planLetterClass(state: string) {
  return state === 'on'
    ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
    : 'text-danger font-semibold';
}

function renderPlanLine(text: string, levelClass: string) {
  const m = String(text || '').match(PLAN_LINE_RE);
  if (!m) return null;
  const [, aS, bS, cS] = m;
  return (
    <span className={cn('break-all text-[12px] font-medium', levelClass)}>
      本轮启用Plan:{' '}
      <span className={planLetterClass(aS)}>A</span>{' '}
      <span className={planLetterClass(bS)}>B</span>{' '}
      <span className={planLetterClass(cS)}>C</span>
    </span>
  );
}

function renderLogText(text: string, levelClass: string) {
  const plan = renderPlanLine(text, levelClass);
  if (plan) return plan;

  const m = String(text || '').match(SUMMARY_RE);
  if (!m) {
    return <span className={cn('break-all text-[12px]', levelClass)}>{text}</span>;
  }
  const [, pre, okPart, mid1, failPart, mid2, totalPart, post] = m;
  return (
    <span className="break-all text-[12px] font-medium">
      {pre ? <span className={levelClass}>{pre}</span> : null}
      <span className="text-emerald-600 dark:text-emerald-400">{okPart}</span>
      {mid1 ? <span className="text-muted-foreground">{mid1}</span> : null}
      <span className="text-danger">{failPart}</span>
      {mid2 ? <span className="text-muted-foreground">{mid2}</span> : null}
      <span className="text-info">{totalPart}</span>
      {post ? <span className={levelClass}>{post}</span> : null}
    </span>
  );
}

export function LogPanel() {
  const logs = useRunStore((s) => s.logs);
  const focusRunId = useRunStore((s) => s.focusRunId);
  const clearLogs = useRunStore((s) => s.clearLogs);
  const clearLogsFor = useRunStore((s) => s.clearLogsFor);
  const ref = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  /** all = 全部任务混显；focus = 仅当前聚焦 */
  const [scope, setScope] = useState<'focus' | 'all'>('focus');
  /** 默认折叠：点标题栏展开 */
  const [open, setOpen] = useState(false);

  const visible = useMemo(() => {
    if (scope === 'all' || !focusRunId) return logs;
    return logs.filter((l) => l.runId === focusRunId);
  }, [logs, focusRunId, scope]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !autoScroll || !open) return;
    el.scrollTop = el.scrollHeight;
  }, [visible, autoScroll, open]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  };

  const copyAll = async () => {
    const text = visible.map((l) => l.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  const doClear = () => {
    if (scope === 'focus' && focusRunId) clearLogsFor(focusRunId);
    else clearLogs();
  };

  return (
    <div
      className={cn(
        'ios-group flex flex-col overflow-hidden',
        open ? 'h-[min(520px,60vh)]' : 'h-auto'
      )}
    >
      <div
        className={cn(
          'flex items-center justify-between px-4 py-3.5',
          open && 'border-b border-border/70'
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={() => setOpen((v) => !v)}
          title={open ? '折叠日志' : '展开日志'}
        >
          {open ? (
            <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <h2 className="text-[20px] font-bold tracking-[-0.02em]">实时日志</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {open
                ? scope === 'focus' && focusRunId
                  ? `仅 #${focusRunId.slice(0, 8)} · ${visible.length} 行`
                  : `全部任务 · ${visible.length} 行`
                : `${visible.length} 行 · 点击展开`}
            </p>
          </div>
        </button>
        {open ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-full border border-border bg-muted/50 p-0.5 text-[11px]">
            <button
              type="button"
              className={cn(
                'rounded-full px-2.5 py-1 font-medium transition-colors',
                scope === 'focus' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
              )}
              onClick={() => setScope('focus')}
            >
              聚焦
            </button>
            <button
              type="button"
              className={cn(
                'rounded-full px-2.5 py-1 font-medium transition-colors',
                scope === 'all' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
              )}
              onClick={() => setScope('all')}
            >
              全部
            </button>
          </div>
          <span className={cn('pill', autoScroll ? 'pill-ok' : 'pill-warn')}>
            {autoScroll ? '自动滚动' : '已暂停'}
          </span>
          <Button variant="ghost" size="sm" onClick={copyAll}>
            <Copy className="h-3.5 w-3.5" />
            复制
          </Button>
          <Button variant="ghost" size="sm" onClick={doClear}>
            <Trash2 className="h-3.5 w-3.5" />
            清空
          </Button>
        </div>
        ) : null}
      </div>
      {open ? (
      <div
        ref={ref}
        onScroll={onScroll}
        className="log-surface m-3 flex-1 overflow-y-auto px-3 py-2.5 leading-6"
      >
        {visible.length === 0 ? (
          <div className="mt-16 text-center font-sans text-[13px] text-muted-foreground">
            尚无日志。开始注册后将实时显示输出。
          </div>
        ) : (
          visible.map((l) => (
            <div
              key={l.id}
              className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 border-b border-border/40 py-1.5 last:border-b-0"
            >
              <span className="text-[11px] text-muted-foreground">
                {new Date(l.ts).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false
                })}
              </span>
              <div className="min-w-0">
                {scope === 'all' && (
                  <span className="mr-2 font-mono text-[10px] text-muted-foreground">
                    #{l.runId.slice(0, 6)}
                  </span>
                )}
                {renderLogText(l.text, colorByLevel[l.level] || 'text-foreground')}
              </div>
            </div>
          ))
        )}
      </div>
      ) : null}
    </div>
  );
}
